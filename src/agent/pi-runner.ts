// The REAL coding-agent Runner (Sprint 5) — spawns the external `pi` agent CLI
// (@earendil-works/pi-coding-agent) as a subprocess per session, drives it over its `--mode rpc`
// JSONL protocol, streams its assistant text into chat as `output` RunnerEvents, and — the part
// that actually matters (decision #2; review C1) — routes every MUTATING tool call pi's model
// wants to make through SecChat's execute-gate before pi is allowed to run it. Same Runner port
// as interactive-runner.ts (src/types.ts); a drop-in alternative wired in src/index.ts.
//
// pi is an external binary, NOT an npm dependency (spawned via node:child_process; nothing here
// imports from "@earendil-works/pi-coding-agent" — see the gate-extension note below for why that
// matters for typecheck, not just the dependency policy in README.md).
//
// ── Gate mechanism: pi `--mode rpc`'s native tool-approval handshake (not --exclude-tools) ────
//
// Investigated empirically (see the task report) against a real installed pi 0.84.1: RPC mode has
// no separate "approve this tool_call" command of its own, but pi EXTENSIONS can intercept every
// tool call before it runs via the `tool_call` event ("Fired after tool_execution_start, before
// the tool executes. Can block." — pi's extensions.md) and can block synchronously by awaiting
// `ctx.ui.confirm()`. In RPC mode `ctx.ui.confirm()` is not a no-op — pi turns it into a request/
// response pair on the SAME JSONL streams we already read/write: it emits
// `{"type":"extension_ui_request","id":...,"method":"confirm","title":...,"message":...}` on
// stdout and suspends that specific tool call until a matching `{"type":"extension_ui_response",
// "id":...,"confirmed":true|false}` arrives on stdin. That is a real, native, per-call approval
// gate — so this runner loads one small generated extension (buildExtensionSource below) whose
// ONLY job is: skip the round trip for known-read-only tools, and for everything else, ask THIS
// runner via that confirm handshake and block iff the answer is false. The real allow/deny
// decision is made here, by evaluateTool() via the control plane, exactly as with every other
// Runner — the extension is a relay, not a second policy.
//
// Confirmed end-to-end against a real pi subprocess and a scripted mock model:
//  - DENY: pi's bash tool never runs; pi synthesizes a blocked tool result and continues the turn.
//  - ALLOW: pi's bash tool actually executes and its real output flows back through tool_execution_end.
// `--exclude-tools` + re-running the turn (the task's documented fallback) was not needed.
//
// ── Why the extension is a generated string, not a checked-in .ts file ────────────────────────
//
// A checked-in extension source file living under src/ would be picked up by this package's own
// `tsc --noEmit` (tsconfig.json: `include: ["src","test"]`), and it would need `import type {...}
// from "@earendil-works/pi-coding-agent"` to be well-typed — a package this repo deliberately does
// NOT depend on (README.md's dependency policy; pi is a spawned binary only). Generating the
// extension's source as a plain-JS string at spawn time (no imports at all — pi's own loader
// resolves nothing external, so nothing needs to be installed here) sidesteps that entirely: the
// only thing secchat's typecheck ever sees is the `string` this file builds.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Id, Runner, RunnerEvent } from "../types.ts";

/** Prefix on the extension's `ctx.ui.confirm()` title that marks a request as OUR gate's (vs. some
 * hypothetical other dialog) — shared between the generated extension and the parser below so the
 * two can never drift apart. Followed immediately by the pi tool name. */
const GATE_TITLE_PREFIX = "secchat-gate:";

/** pi's own built-in read-only tool names (confirmed against the installed package's type
 * definitions: BashToolCallEvent | ReadToolCallEvent | EditToolCallEvent | WriteToolCallEvent |
 * GrepToolCallEvent | FindToolCallEvent | LsToolCallEvent). Mirrors gate.ts's READONLY_TOOLS
 * classification but is necessarily a SEPARATE copy — this list runs inside the pi subprocess
 * (loaded by pi's own extension loader), a different process from gate.ts, so it can't import it.
 * Exactly like interactive-runner.ts's MUTATING_INTENT regex, this is NOT the safety boundary —
 * it only decides whether to skip the approval round trip for a call that is obviously safe.
 * Anything not on this list (including a tool this list doesn't know about) is always routed
 * through the real gate below; the real allow/deny decision is evaluateTool()'s alone. */
const READONLY_TOOL_NAMES = ["read", "ls", "grep", "find"];

/** Env vars passed through from this process into the pi subprocess. Deliberately an ALLOWLIST,
 * not `...process.env` — pi's bash tool runs arbitrary commands with whatever environment pi
 * itself has, so blindly inheriting this server's full environment would hand a coding agent's
 * shell tool secrets it has no business seeing (DATABASE_URL, SECROUTER_TOKEN, session-signing
 * keys, …). Fails closed like the rest of this codebase (gate.ts's unknown-tool default; C1). */
const INHERITED_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR", "TZ",
  // TLS trust for pi's own model-call egress to the gateway (SecRouter behind an internal CA):
  // pi is a Node app, so it honours NODE_EXTRA_CA_CERTS; the *_CERT_FILE/*_CA_BUNDLE variants
  // cover its non-Node HTTP paths. Without these pi can't verify the gateway cert → "Connection
  // error." on every model call.
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
];

const STDERR_TAIL_MAX_CHUNKS = 50;

export interface PiRunnerOptions {
  /** Path to (or bare name of) the pi binary. Default: `PI_BIN` env, else `"pi"` (resolved via
   * the subprocess's PATH). */
  piBin?: string;
  /** pi `--provider`. Default: `PI_PROVIDER` env, else `"secrouter"` — SecChat's own default
   * provider id, only actually usable once `baseUrl` is also set (see below); pick one of pi's own
   * built-in provider ids here instead to bypass SecRouter and use that provider's normal auth. */
  provider?: string;
  /** pi `--model`. Default: `PI_MODEL` env; if that's unset too, `"default"` when `baseUrl` is
   * configured (so the generated provider has some model id to register), else omitted entirely
   * so pi falls back to the chosen provider's own default model. */
  model?: string;
  /** An OpenAI-completions-compatible base URL (SecRouter in production; a scripted mock in
   * tests) that pi's model calls should go to instead of a real upstream. Default: `PI_BASE_URL`
   * env. Unset ⇒ no custom provider is registered; `provider`/`model`/`apiKey` must then resolve
   * against one of pi's own built-in providers. */
  baseUrl?: string;
  /** Credential for `baseUrl` (or an override for a built-in provider's own credential). Default:
   * `PI_API_KEY` env; if that's unset too, `"unused"` when `baseUrl` is configured (mock/local
   * servers that don't check it still need SOME value — see pi's own models.md), else omitted so
   * pi resolves a built-in provider's real credential normally (auth.json / its own env var). */
  apiKey?: string;
  /** Working directory for every session that doesn't specify its own via `start()`'s `workspace`
   * input. Default: a fresh temp directory PER SESSION (created in `start`, removed in `stop`) —
   * a real coding session never runs against this server's own cwd unless explicitly told to. */
  workspace?: string;
  /** Extra env vars merged into the subprocess's (allowlisted) environment, last-wins. Mainly a
   * test hook. */
  env?: NodeJS.ProcessEnv;
}

interface PiSessionState {
  child: ChildProcessWithoutNullStreams;
  configDir: string;
  workspaceDir: string;
  ownWorkspace: boolean; // whether THIS session invented workspaceDir (and so must remove it)
  isStreaming: boolean;
  turnCounter: number;
  currentTurnId: string | undefined;
  pendingApprovals: Set<string>; // requestId (== the extension_ui_request's own `id`) awaiting answerTool
  stderrTail: string[];
  stopRequested: boolean;
  ended: boolean;
}

/** Builds the plain-JS source of the one extension this runner ever loads (via `-e`, with
 * `--no-extensions` disabling every other extension source — see the header comment on why that
 * matters for the gate, not just determinism). No imports: pi's extension loader hands the
 * factory function a live `pi` object at runtime, so nothing here needs `@earendil-works/pi-*` to
 * be installed anywhere in this repo. */
function buildExtensionSource(opts: { provider: string; model: string | undefined; baseUrl: string | undefined }): string {
  const providerRegistration =
    opts.baseUrl === undefined
      ? ""
      : `
  pi.registerProvider(${JSON.stringify(opts.provider)}, {
    baseUrl: ${JSON.stringify(opts.baseUrl)},
    api: "openai-completions",
    models: [{
      id: ${JSON.stringify(opts.model)},
      name: ${JSON.stringify(opts.model)},
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }],
  });
`;

  return `// Generated by SecChat's pi runner (src/agent/pi-runner.ts) for one coding-agent session.
// Not hand-maintained — regenerated fresh on every session spawn. Two jobs:
//  1. Optionally point the model backend at an OpenAI-completions-compatible endpoint (SecRouter
//     in production; a scripted mock in tests) instead of a real upstream provider.
//  2. Gate every tool call that isn't obviously read-only through SecChat's execute-gate, via
//     pi's own tool_call event + ctx.ui.confirm() RPC handshake. This is the only extension pi
//     is allowed to load for this session (see --no-extensions), so it can't be bypassed or
//     raced by a project-local extension.
export default function (pi) {
${providerRegistration}
  var READ_ONLY = new Set(${JSON.stringify(READONLY_TOOL_NAMES)});

  pi.on("tool_call", async function (event, ctx) {
    if (READ_ONLY.has(event.toolName)) return; // plan mode: reads proceed without a round trip

    var allowed = await ctx.ui.confirm(${JSON.stringify(GATE_TITLE_PREFIX)} + event.toolName, JSON.stringify(event.input || {}));
    if (!allowed) {
      return { block: true, reason: "blocked by SecChat's execute-gate — ask the agent's owner to grant execution" };
    }
  });
}
`;
}

/** Node's own `readline` is explicitly NOT protocol-compliant for pi's RPC mode (it also splits on
 * U+2028/U+2029, which are valid inside JSON strings — pi's rpc.md is explicit about this), so
 * lines are split by hand on `\n` only, tolerating a trailing `\r`. */
function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  });
}

/** Joins every `text` content block of an assistant `message_end` message. `message_end.message`
 * is pi's authoritative final message (streaming deltas are intentionally not accumulated here —
 * "per-message" streaming, which pi's own json.md docs call out as an acceptable granularity). */
function extractAssistantText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") text += t;
    }
  }
  return text;
}

/** Joins every `text` content block of a tool_execution_end `result`. Same shape family as
 * extractAssistantText but kept separate since the two events carry unrelated payloads. */
function extractResultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
      const t = (block as { text?: unknown }).text;
      if (typeof t === "string") text += t;
    }
  }
  return text;
}

function buildChildEnv(configDir: string, extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Suppress pi's own startup network calls (version checks, catalog refresh, telemetry) for test
  // determinism and CMMC hardening. But PI_OFFLINE also stops pi reaching the CONFIGURED model
  // provider, so a runner that actually needs to call the gateway (baseUrl set) opts out via
  // SECCHAT_PI_ALLOW_EGRESS=1 — otherwise every model call fails with "Connection error."
  if (process.env.SECCHAT_PI_ALLOW_EGRESS !== "1") env.PI_OFFLINE = "1";
  env.PI_TELEMETRY = "0";
  env.PI_CODING_AGENT_DIR = configDir;
  if (extra) Object.assign(env, extra);
  return env;
}

export function makePiRunner(opts: PiRunnerOptions = {}): Runner {
  const piBin = opts.piBin ?? process.env.PI_BIN ?? "pi";
  const provider = opts.provider ?? process.env.PI_PROVIDER ?? "secrouter";
  const baseUrl = opts.baseUrl ?? process.env.PI_BASE_URL ?? undefined;
  const explicitModel = opts.model ?? process.env.PI_MODEL;
  const model = explicitModel ?? (baseUrl === undefined ? undefined : "default");
  const explicitApiKey = opts.apiKey ?? process.env.PI_API_KEY;
  const apiKey = explicitApiKey ?? (baseUrl === undefined ? undefined : "unused");
  const defaultWorkspace = opts.workspace;
  const extraEnv = opts.env;

  const sessions = new Map<Id, PiSessionState>();
  let emit: ((sessionId: Id, event: RunnerEvent) => void) | undefined;

  function cleanupFs(session: PiSessionState): void {
    // Best-effort: a session that is being torn down must never throw out of an event handler
    // over a stale/already-gone temp directory.
    try {
      rmSync(session.configDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (session.ownWorkspace) {
      try {
        rmSync(session.workspaceDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /** Terminal transition for a session: emits an optional narration output, the `exit` event,
   * cleans up its temp directories, and forgets it. Idempotent — the child's 'error' and 'exit'
   * handlers can both fire for the same failure, but only the first call here does anything. */
  function finishSession(sessionId: Id, session: PiSessionState, result: { code: number | undefined; message?: string }): void {
    if (session.ended) return;
    session.ended = true;
    if (result.message !== undefined) emit?.(sessionId, { type: "output", text: result.message });
    emit?.(sessionId, { type: "exit", code: result.code });
    cleanupFs(session);
    sessions.delete(sessionId);
  }

  function tailText(session: PiSessionState): string {
    const tail = session.stderrTail.join("").trim().slice(-2000);
    return tail.length > 0 ? `: ${tail}` : "";
  }

  function handleRpcEvent(sessionId: Id, session: PiSessionState, evt: Record<string, unknown>): void {
    const type = typeof evt.type === "string" ? evt.type : undefined;
    switch (type) {
      case "agent_start":
        session.isStreaming = true;
        return;

      case "agent_settled":
        session.isStreaming = false;
        return;

      case "turn_start":
        session.turnCounter += 1;
        session.currentTurnId = `turn-${session.turnCounter}`;
        return;

      case "message_end": {
        const message = evt.message as { role?: unknown } | undefined;
        if (!message || message.role !== "assistant") return;
        const text = extractAssistantText(message);
        if (text.length > 0) emit?.(sessionId, { type: "output", text });
        return;
      }

      case "tool_execution_end": {
        // A BLOCKED call also reaches tool_execution_end (with isError:true and pi's synthesized
        // "blocked by..." text) — skip it here since answerTool() already narrated the denial with
        // the real gate reason the moment the verdict was known, before pi got this far.
        if (evt.isError === true) return;
        const toolName = typeof evt.toolName === "string" ? evt.toolName : "tool";
        const text = extractResultText(evt.result);
        if (text.length > 0) emit?.(sessionId, { type: "output", text: `▸ ${toolName}: ${text}` });
        return;
      }

      case "extension_ui_request": {
        if (evt.method !== "confirm") return; // not our gate's dialog (we never issue any other kind)
        const title = typeof evt.title === "string" ? evt.title : "";
        if (!title.startsWith(GATE_TITLE_PREFIX)) return;
        const requestId = typeof evt.id === "string" ? evt.id : undefined;
        if (!requestId) return;
        const tool = title.slice(GATE_TITLE_PREFIX.length);
        const input = typeof evt.message === "string" ? evt.message : undefined;

        session.pendingApprovals.add(requestId);
        emit?.(sessionId, { type: "tool_request", tool, input, requestId, turnId: session.currentTurnId });
        return;
      }

      case "auto_retry_start": {
        const attempt = typeof evt.attempt === "number" ? evt.attempt : "?";
        const maxAttempts = typeof evt.maxAttempts === "number" ? evt.maxAttempts : "?";
        emit?.(sessionId, { type: "output", text: `▸ retrying after a transient error (attempt ${attempt}/${maxAttempts})…` });
        return;
      }

      default:
        return; // every other event (message_update deltas, tool_execution_start/update, …) is not surfaced
    }
  }

  async function start(input: { sessionId: Id; agentId: Id; ownerSub: string; workspace?: string }): Promise<void> {
    const { sessionId, agentId } = input;

    const configDir = mkdtempSync(join(tmpdir(), "secchat-pi-config-"));
    const ownWorkspace = input.workspace === undefined && defaultWorkspace === undefined;
    const workspaceDir = input.workspace ?? defaultWorkspace ?? mkdtempSync(join(tmpdir(), "secchat-pi-workspace-"));

    const extensionPath = join(configDir, "secchat-gate.ts");
    writeFileSync(extensionPath, buildExtensionSource({ provider, model, baseUrl }), "utf8");

    const args = [
      "--mode", "rpc",
      "--no-session",
      // SECURITY: this is the ONLY extension pi may ever load for this session. Without this
      // flag, a project-local (.pi/extensions) or user-global (~/.pi/agent/extensions) extension
      // could register its own competing tool_call handler and interfere with — or race — the
      // gate below. CLI `-e` extensions load regardless of this flag (they're explicitly named by
      // the invoker, not discovered), so our own gate is unaffected.
      "--no-extensions",
      // Never trust project-local .pi/settings.json in the workspace being operated on.
      "--no-approve",
      "--name", `secchat-${agentId}`,
      "-e", extensionPath,
      "--provider", provider,
      ...(model !== undefined ? ["--model", model] : []),
      ...(apiKey !== undefined ? ["--api-key", apiKey] : []),
    ];

    if (process.env.SECCHAT_PI_DEBUG === "1") console.error(`[pi spawn] ${piBin} ${args.join(" ")}`);
    const child = spawn(piBin, args, {
      cwd: workspaceDir,
      env: buildChildEnv(configDir, extraEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: PiSessionState = {
      child,
      configDir,
      workspaceDir,
      ownWorkspace,
      isStreaming: false,
      turnCounter: 0,
      currentTurnId: undefined,
      pendingApprovals: new Set(),
      stderrTail: [],
      stopRequested: false,
      ended: false,
    };

    attachJsonlReader(child.stdout, (line) => {
      if (process.env.SECCHAT_PI_DEBUG === "1") console.error(`[pi stdout] ${line.slice(0, 400)}`);
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // not a protocol line (pi never emits non-JSON on stdout in RPC mode) — ignore
      }
      handleRpcEvent(sessionId, session, evt);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (process.env.SECCHAT_PI_DEBUG === "1") console.error(`[pi stderr] ${chunk.toString("utf8").slice(0, 400)}`);
      session.stderrTail.push(chunk.toString("utf8"));
      if (session.stderrTail.length > STDERR_TAIL_MAX_CHUNKS) session.stderrTail.shift();
    });

    child.on("error", (err) => {
      finishSession(sessionId, session, { code: 1, message: `pi process error: ${err.message}` });
    });

    child.on("exit", (code, signal) => {
      const unexpected = !session.stopRequested && code !== 0;
      finishSession(sessionId, session, {
        code: code ?? undefined,
        message: unexpected
          ? `pi exited unexpectedly (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})${tailText(session)}`
          : undefined,
      });
    });

    // Confirms the OS actually started the process before this resolves; a spawn failure (e.g.
    // PI_BIN not found) rejects start() itself rather than silently leaving a half-open session —
    // the control plane's spawn() propagates that to its own caller instead of marking the
    // session "active". Once past this point, failures are reported as RunnerEvents (above), not
    // by throwing, since nothing is left awaiting this call.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    sessions.set(sessionId, session);
    emit?.(sessionId, { type: "output", text: "▸ coding session ready (pi)" });
  }

  async function sendInput(sessionId: Id, text: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session || session.ended) return;

    const command: { type: string; message: string; streamingBehavior?: string } = { type: "prompt", message: text };
    // pi rejects a bare `prompt` while it is already streaming a previous turn; queue it instead
    // of racing the in-flight one (mirrors the effect of a user sending a message before the
    // agent's previous reply finished).
    if (session.isStreaming) command.streamingBehavior = "followUp";
    session.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async function answerTool(sessionId: Id, requestId: string, decision: { allow: boolean; reason: string }): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session || session.ended) return;
    // A requestId the control plane already answered, or one from a session that has since ended,
    // is tolerated silently — matches interactive-runner's "unrecognized requestId" contract.
    if (!session.pendingApprovals.delete(requestId)) return;

    const response = { type: "extension_ui_response", id: requestId, confirmed: decision.allow };
    session.child.stdin.write(`${JSON.stringify(response)}\n`);

    emit?.(sessionId, {
      type: "output",
      text: decision.allow ? `✓ granted: ${decision.reason}` : `✗ blocked: ${decision.reason}`,
    });
  }

  async function stop(sessionId: Id): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session || session.ended) return;
    session.stopRequested = true;
    session.child.kill("SIGTERM");
    // The real `exit` RunnerEvent (and fs cleanup) happens in the child's own "exit" handler once
    // it actually dies; this fallback only guards against a process that ignores SIGTERM, and
    // never keeps the host Node process alive by itself (matches agent/reaper.ts's timer.unref()).
    const forceKill = setTimeout(() => {
      if (!session.ended) session.child.kill("SIGKILL");
    }, 3000);
    forceKill.unref?.();
  }

  function onEvent(cb: (sessionId: Id, event: RunnerEvent) => void): void {
    emit = cb;
  }

  return { start, sendInput, answerTool, stop, onEvent };
}
