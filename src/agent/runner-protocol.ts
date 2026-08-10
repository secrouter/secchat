// The wire protocol between SecChat and a REMOTE runner daemon (see src/agent/remote-runner.ts and
// the /runner attach endpoint). It is a 1:1 serialization of the `Runner` PORT (src/types.ts): the
// commands SecChat sends DOWN are exactly the port's methods, and the messages the daemon sends UP
// carry the port's `RunnerEvent`s. So a daemon on a different machine is just another Runner
// implementation reached over a socket — and, critically, the execute-gate stays in SecChat's
// control plane: the daemon RELAYS `tool_request`s and receives `tool_answer` verdicts; it never
// decides authorization itself (the "only the owner authorizes execution" invariant, decision #2,
// holds across the network seam).

import type { Id, RunnerEvent } from "../types.ts";

/** A tool-execution verdict — the same shape the gate produces and `Runner.answerTool` consumes. */
export interface ToolDecision {
  allow: boolean;
  reason: string;
}

/** Frames SecChat sends DOWN to a connected daemon (the Runner-port methods, serialized). */
export type RunnerCommand =
  | { type: "start"; sessionId: Id; agentId: Id; ownerSub: string; workspace?: string }
  | { type: "input"; sessionId: Id; text: string }
  | { type: "tool_answer"; sessionId: Id; requestId: string; decision: ToolDecision }
  | { type: "stop"; sessionId: Id };

/** Frames a daemon sends UP to SecChat. `register` is consumed by the attach endpoint; `event`
 * carries a `RunnerEvent` into the control plane (via the RemoteRunner's onEvent); `heartbeat`
 * renews the leases of the daemon's live sessions so the orphan reaper doesn't cull them. */
export type RunnerMessage =
  | { type: "register"; runnerId?: string; capabilities?: Record<string, unknown> }
  | { type: "event"; sessionId: Id; event: RunnerEvent }
  | { type: "heartbeat"; sessionIds?: Id[] };

/** Parse a JSON frame from a daemon into a RunnerMessage, or null if it isn't a shape we accept.
 * Defensive: a daemon is a separate, possibly-older process, so unknown/garbled frames are ignored
 * rather than trusted. */
export function parseRunnerMessage(raw: string): RunnerMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "register":
      return { type: "register", runnerId: typeof m.runnerId === "string" ? m.runnerId : undefined,
        capabilities: (m.capabilities && typeof m.capabilities === "object") ? (m.capabilities as Record<string, unknown>) : undefined };
    case "event": {
      if (typeof m.sessionId !== "string" || !m.event || typeof m.event !== "object") return null;
      const ev = m.event as Record<string, unknown>;
      if (typeof ev.type !== "string") return null;
      return { type: "event", sessionId: m.sessionId, event: ev as unknown as RunnerEvent };
    }
    case "heartbeat":
      return { type: "heartbeat", sessionIds: Array.isArray(m.sessionIds) ? m.sessionIds.filter((s): s is string => typeof s === "string") : undefined };
    default:
      return null;
  }
}
