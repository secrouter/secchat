// A trivial dev/demo Runner: it echoes input back as output and never requests a mutating tool.
// It stands in for a real pi runner (a server process, or the local `secagent daemon` in Sprint
// 5) until that lands — the same way MemoryStore stands in for Postgres — so coding-agent
// sessions are reachable and the control plane is exercised end to end in a dev process. A real
// runner is what makes agents actually *do* anything; this one just proves the plumbing.

import type { Id, Runner, RunnerEvent } from "../types.ts";

export function makeEchoRunner(): Runner {
  let emit: ((sessionId: Id, event: RunnerEvent) => void) | undefined;
  return {
    async start(input) {
      emit?.(input.sessionId, {
        type: "output",
        text: `session ready for agent ${input.agentId} (echo runner — no real tools/execution)`,
      });
    },
    async sendInput(sessionId, text) {
      emit?.(sessionId, { type: "output", text: `echo: ${text}` });
    },
    // The echo runner never emits tool_request, so this is never called; present for the contract.
    async answerTool() {},
    async stop(sessionId) {
      emit?.(sessionId, { type: "exit", code: 0 });
    },
    onEvent(cb) {
      emit = cb;
    },
  };
}
