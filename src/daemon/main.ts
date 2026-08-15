// The SecChat runner DAEMON — a standalone process that attaches to a SecChat instance over the
// `/runner` WebSocket and runs coding agents on THIS machine (the user's laptop via the bundled
// desktop app, or a server / container), while the execute-gate stays on SecChat. It is the client
// end of the runner protocol; the testable bridge is runner-client.ts (this file is just transport,
// config, and reconnect).
//
// Run standalone:   SECCHAT_URL=https://chat.example  SECCHAT_RUNNER_TOKEN=<oidc-or-dev-token>  node src/daemon/main.ts
// Dev without pi:   SECCHAT_RUNNER_STUB=1  ...            (uses the interactive echo runner)

import { makePiRunner } from "../agent/pi-runner.ts";
import { makeInteractiveRunner } from "../agent/interactive-runner.ts";
import { makeRunnerClient } from "./runner-client.ts";
import { backoffDelay, diagnoseConnect, probeHandshake } from "./connect-diagnostics.ts";
import type { Id, Runner } from "../types.ts";
import type { RunnerMessage } from "../agent/runner-protocol.ts";

const SECCHAT_URL = process.env.SECCHAT_URL?.trim() || "http://127.0.0.1:47010";
const TOKEN = (process.env.SECCHAT_RUNNER_TOKEN ?? process.env.SECCHAT_TOKEN ?? "").trim();
const HEARTBEAT_MS = Number(process.env.SECCHAT_RUNNER_HEARTBEAT_MS ?? 20_000);
const RECONNECT_MS = Number(process.env.SECCHAT_RUNNER_RECONNECT_MS ?? 2_000);
/** Cap for the exponential reconnect backoff, so a sustained outage settles into a slow, quiet retry
 * (with a periodic "still trying" line) rather than a silent tight loop hammering the server. */
const RECONNECT_MAX_MS = Number(process.env.SECCHAT_RUNNER_RECONNECT_MAX_MS ?? 30_000);

/** When set (only inside a Kubernetes agent-pool pod), the session id this pod hosts — appended as
 * `?pool=<id>` so SecChat routes this attach to the PoolRunner by session (not the per-owner
 * registry). Empty for a normal desktop/standalone daemon. */
const POOL_SESSION = process.env.SECCHAT_POOL_SESSION?.trim() || "";

/** The SecChat `/runner` WebSocket URL, carrying the daemon's token (and, in a pool pod, its session). */
function runnerWsUrl(): string {
  const u = new URL(SECCHAT_URL);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/runner";
  u.search = "";
  if (TOKEN) u.searchParams.set("token", TOKEN);
  if (POOL_SESSION) u.searchParams.set("pool", POOL_SESSION);
  return u.toString();
}

/** The pi runner (the daemon's whole purpose) — constructed here, spawns pi lazily at session start.
 * `SECCHAT_RUNNER_STUB=1` swaps in the interactive echo runner for local dev without pi installed. */
function selectRunner(): Runner {
  return process.env.SECCHAT_RUNNER_STUB === "1" ? makeInteractiveRunner() : makePiRunner();
}

/** The daemon's live-session set, shared across every reconnect so a rebuilt client still heartbeats
 * the sessions whose pi processes are still running in the (lifetime-long) runner. Without this, a
 * reconnect would reset it to empty and those sessions' leases would lapse. */
const liveSessions = new Set<Id>();

/** Reconnect/diagnostic state, module-scoped so it survives across the fresh `connect()` built for each
 * attempt. `failures` (reset to 0 on a successful open) drives the backoff; `lastSummary` lets us print
 * the full remediation hint once per distinct failure mode and a compact "still trying" line after that,
 * so a persistent outage doesn't re-spam the hint; `probing` keeps at most one diagnostic probe in flight. */
let failures = 0;
let lastSummary = "";
let probing = false;

/** On a failed attach, replay the handshake over http to learn WHY, and log it. Full summary + hint the
 * first time a given failure mode appears; a compact "still trying" line on repeats — so a sustained
 * outage stays quiet but the daemon still visibly reports it's alive and retrying (no silent loop). The
 * probe is best-effort and never throws; it only runs while disconnected, so it can't disturb a live
 * daemon. */
async function reportAttachFailure(attempt: number, nextDelayMs: number): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    const { summary, hint } = diagnoseConnect(await probeHandshake(runnerWsUrl()));
    const nextIn = `${Math.round(nextDelayMs / 1000)}s`;
    if (summary !== lastSummary) {
      console.error(`⚠ can't attach to ${SECCHAT_URL} — ${summary} (retry in ${nextIn})`);
      if (hint) for (const line of hint.split("\n")) console.error(`  ${line}`);
    } else {
      console.error(`▸ still trying to attach to ${SECCHAT_URL} (attempt ${attempt}, next retry in ${nextIn}) — ${summary}`);
    }
    lastSummary = summary;
  } finally {
    probing = false;
  }
}

/** Open one attach connection and keep it wired until it drops; then reconnect. One runner for the
 * daemon's lifetime — each connection re-wires a fresh client (its onEvent replaces the prior one). */
function connect(runner: Runner): void {
  const socket = new WebSocket(runnerWsUrl());
  const client = makeRunnerClient({
    runner,
    live: liveSessions,
    send: (msg: RunnerMessage) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        // socket not open / closing — drop the frame; a heartbeat/event will resend after reconnect
      }
    },
  });

  let opened = false;
  let beat: ReturnType<typeof setInterval> | undefined;
  socket.addEventListener("open", () => {
    opened = true;
    failures = 0; // a healthy attach resets the backoff…
    lastSummary = ""; // …and the failure-mode memory, so the next outage logs its hint afresh.
    console.error(`▸ attached to ${SECCHAT_URL}`);
    client.hello({ pid: process.pid, kind: "pi" });
    // Beat immediately (don't wait a full interval) so the very first keepalive lands before a
    // short proxy idle-timeout can close the fresh socket, and any surviving sessions' leases are
    // renewed right away after a reconnect.
    client.beat();
    beat = setInterval(() => client.beat(), HEARTBEAT_MS);
  });
  socket.addEventListener("message", (ev) => void client.handleCommand(String((ev as MessageEvent).data)));

  let reconnected = false;
  const scheduleReconnect = () => {
    if (reconnected) return;
    reconnected = true;
    if (beat) clearInterval(beat);
    let delay = RECONNECT_MS;
    if (!opened) {
      // Never got a socket up: this is a failed ATTACH — back off and explain why (the close/error
      // events themselves carry nothing useful; reportAttachFailure recovers the real reason).
      failures += 1;
      delay = backoffDelay(failures, RECONNECT_MS, RECONNECT_MAX_MS);
      void reportAttachFailure(failures, delay);
    }
    setTimeout(() => connect(runner), delay);
  };

  socket.addEventListener("close", (ev) => {
    const e = ev as CloseEvent;
    // A close AFTER a healthy attach is an operational drop (proxy idle timeout, server restart): log it
    // and reconnect fast. A close with no prior open is a failed attach — scheduleReconnect's
    // reportAttachFailure explains that out-of-band, so we don't also print the useless bare 1006 here.
    if (opened) {
      const reason = e.reason ? `: ${e.reason}` : "";
      console.error(`▸ /runner closed (code ${e.code}${reason}) — reconnecting in ${Math.round(RECONNECT_MS / 1000)}s`);
    }
    scheduleReconnect();
  });
  socket.addEventListener("error", (ev) => {
    // Node's built-in WebSocket almost always hands us an EMPTY error here (no message/code/cause — it
    // hides the real reason, which reportAttachFailure recovers out-of-band). Log only the rare runtime
    // that actually populates it, so we don't print blank lines. Then close, which drives reconnect.
    const e = ev as unknown as { message?: string; error?: { message?: string; code?: string; cause?: { code?: string } } };
    const code = e.error?.code ?? e.error?.cause?.code;
    const message = e.message || e.error?.message;
    if (code || message) console.error(`▸ /runner socket error: ${message ?? ""}${code ? ` [${code}]` : ""}`.trim());
    try {
      socket.close();
    } catch {
      scheduleReconnect();
    }
  });
}

function main(): void {
  if (!TOKEN) {
    console.error("secchat runner daemon: SECCHAT_RUNNER_TOKEN (or SECCHAT_TOKEN) is required");
    process.exit(1);
  }
  console.error(`▸ secchat runner daemon → ${SECCHAT_URL} (${process.env.SECCHAT_RUNNER_STUB === "1" ? "stub runner" : "pi runner"})`);
  connect(selectRunner());
}

main();
