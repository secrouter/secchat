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
import type { Id, Runner } from "../types.ts";
import type { RunnerMessage } from "../agent/runner-protocol.ts";

const SECCHAT_URL = process.env.SECCHAT_URL?.trim() || "http://127.0.0.1:47010";
const TOKEN = (process.env.SECCHAT_RUNNER_TOKEN ?? process.env.SECCHAT_TOKEN ?? "").trim();
const HEARTBEAT_MS = Number(process.env.SECCHAT_RUNNER_HEARTBEAT_MS ?? 20_000);
const RECONNECT_MS = Number(process.env.SECCHAT_RUNNER_RECONNECT_MS ?? 2_000);

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

  let beat: ReturnType<typeof setInterval> | undefined;
  socket.addEventListener("open", () => {
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
  const onGone = () => {
    if (reconnected) return;
    reconnected = true;
    if (beat) clearInterval(beat);
    setTimeout(() => connect(runner), RECONNECT_MS);
  };
  socket.addEventListener("close", onGone);
  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      onGone();
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
