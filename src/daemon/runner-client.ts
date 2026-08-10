// The daemon-side bridge: the pure half of the runner daemon, testable with a fake Runner + a fake
// transport (no socket, no pi). It is the mirror image of the server's RemoteRunner —
//
//   SecChat  ──RunnerCommand──►  runner-client.handleCommand  ──►  local Runner (pi)
//   SecChat  ◄──RunnerMessage──  runner-client (runner.onEvent) ◄──  local Runner (pi)
//
// so a RunnerCommand becomes a local Runner call, and a local RunnerEvent becomes an `event` message
// sent up. The daemon NEVER decides tool authorization: a `tool_request` from pi is forwarded up as
// an event, and the gate's verdict comes back down as a `tool_answer` command handed to
// runner.answerTool. `beat()` reports the daemon's live sessions so their leases don't lapse.

import type { Id, Runner } from "../types.ts";
import { parseRunnerCommand, type RunnerMessage } from "../agent/runner-protocol.ts";

export interface RunnerClient {
  /** Announce this daemon to SecChat (optional capabilities). Call once the transport is open. */
  hello(capabilities?: Record<string, unknown>): void;
  /** Handle one command frame from SecChat (raw JSON string or an already-parsed command). */
  handleCommand(raw: string): Promise<void>;
  /** Send a heartbeat for the daemon's live sessions (call on a timer). No-op when idle. */
  beat(): void;
  /** The sessions this daemon is currently running. */
  sessions(): Id[];
}

export function makeRunnerClient(deps: { runner: Runner; send: (msg: RunnerMessage) => void }): RunnerClient {
  const live = new Set<Id>();

  // Forward every local runner event up to SecChat; forget a session once it exits.
  deps.runner.onEvent((sessionId, event) => {
    if (event.type === "exit") live.delete(sessionId);
    deps.send({ type: "event", sessionId, event });
  });

  return {
    hello(capabilities) {
      deps.send({ type: "register", capabilities });
    },
    async handleCommand(raw) {
      const cmd = parseRunnerCommand(raw);
      if (!cmd) return;
      switch (cmd.type) {
        case "start":
          live.add(cmd.sessionId);
          await deps.runner.start({ sessionId: cmd.sessionId, agentId: cmd.agentId, ownerSub: cmd.ownerSub, workspace: cmd.workspace });
          return;
        case "input":
          await deps.runner.sendInput(cmd.sessionId, cmd.text);
          return;
        case "tool_answer":
          // The gate's verdict from SecChat — hand it to pi's own approval mechanism.
          await deps.runner.answerTool(cmd.sessionId, cmd.requestId, cmd.decision);
          return;
        case "stop":
          live.delete(cmd.sessionId);
          await deps.runner.stop(cmd.sessionId);
          return;
      }
    },
    beat() {
      if (live.size > 0) deps.send({ type: "heartbeat", sessionIds: [...live] });
    },
    sessions() {
      return [...live];
    },
  };
}
