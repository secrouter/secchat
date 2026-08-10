// A Runner (src/types.ts) whose sessions live in a REMOTE daemon, not this process. It implements
// the port by SERIALIZING each method into a RunnerCommand and sending it to the owner's attached
// daemon (via the RunnerRegistry), and by translating the daemon's inbound RunnerMessages back into
// the control plane's `onEvent` callbacks. The control plane can't tell it apart from the in-process
// pi runner — same port — so the execute-gate runs identically: a daemon's `tool_request` becomes an
// `onEvent` the control plane gates, and the verdict returns as an `answerTool` → `tool_answer`
// command. Authorization never leaves the server.

import type { Id, Runner, RunnerEvent } from "../types.ts";
import type { RunnerRegistry, RunnerConnection } from "./runner-registry.ts";
import type { RunnerMessage } from "./runner-protocol.ts";

export interface RemoteRunner {
  /** The Runner port the control plane drives (start/sendInput/answerTool/stop/onEvent). */
  runner: Runner;
  /** Feed a message a daemon sent up (the attach endpoint calls this per inbound frame). `conn` is
   * the sending daemon, so events can be scoped/validated to it. */
  handleDaemonMessage(conn: RunnerConnection, msg: RunnerMessage): void;
  /** Drop a dead daemon's sessions (the attach endpoint calls this on disconnect) — each is
   * surfaced to the control plane as an `exit` so it ends cleanly (the reaper is the backstop). */
  handleDaemonGone(conn: RunnerConnection): void;
}

export function makeRemoteRunner(deps: {
  registry: RunnerRegistry;
  /** Renew a live session's lease on the daemon's heartbeat (keeps the orphan reaper at bay). */
  renewLease?: (sessionId: Id) => void;
}): RemoteRunner {
  const owners = new Map<Id, string>(); // sessionId -> ownerSub (which daemon hosts it)
  let handler: ((sessionId: Id, event: RunnerEvent) => void) | null = null;

  function emit(sessionId: Id, event: RunnerEvent): void {
    handler?.(sessionId, event);
  }

  const runner: Runner = {
    async start(input) {
      const conn = deps.registry.get(input.ownerSub);
      if (!conn) throw new Error(`no runner daemon attached for owner ${input.ownerSub}`);
      owners.set(input.sessionId, input.ownerSub);
      conn.send({ type: "start", sessionId: input.sessionId, agentId: input.agentId, ownerSub: input.ownerSub, workspace: input.workspace });
    },
    async sendInput(sessionId, text) {
      deps.registry.get(owners.get(sessionId) ?? "")?.send({ type: "input", sessionId, text });
    },
    async answerTool(sessionId, requestId, decision) {
      deps.registry.get(owners.get(sessionId) ?? "")?.send({ type: "tool_answer", sessionId, requestId, decision });
    },
    async stop(sessionId) {
      deps.registry.get(owners.get(sessionId) ?? "")?.send({ type: "stop", sessionId });
      owners.delete(sessionId);
    },
    onEvent(cb) {
      handler = cb;
    },
  };

  function handleDaemonMessage(conn: RunnerConnection, msg: RunnerMessage): void {
    switch (msg.type) {
      case "event":
        // Only accept events for a session this daemon actually hosts (a daemon can't drive another
        // owner's session). Unknown/foreign session ids are dropped.
        if (owners.get(msg.sessionId) === conn.ownerSub) {
          if (msg.event.type === "exit") owners.delete(msg.sessionId);
          emit(msg.sessionId, msg.event);
        }
        return;
      case "heartbeat": {
        const ids = msg.sessionIds ?? [...owners.entries()].filter(([, sub]) => sub === conn.ownerSub).map(([id]) => id);
        for (const id of ids) if (owners.get(id) === conn.ownerSub) deps.renewLease?.(id);
        return;
      }
      case "register":
        return; // handled by the attach endpoint, not here
    }
  }

  function handleDaemonGone(conn: RunnerConnection): void {
    for (const [sessionId, sub] of [...owners.entries()]) {
      if (sub !== conn.ownerSub) continue;
      owners.delete(sessionId);
      emit(sessionId, { type: "exit" }); // ends the session cleanly; the reaper is the backstop
    }
  }

  return { runner, handleDaemonMessage, handleDaemonGone };
}
