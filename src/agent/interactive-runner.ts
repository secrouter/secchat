// A dev/demo Runner that actually exercises the execute-gate — unlike echo-runner (which only
// ever emits output and never requests a tool), this one reads mutating intent out of the user's
// own words and requests the "bash" tool for it, so the control plane's gate wiring (src/agent/
// control.ts → src/agent/gate.ts, both frozen/imported-only here) has something real to allow or
// deny end to end in a dev process. Still a stand-in, not a real pi runner: it never actually runs
// anything — answerTool's "ran"/"blocked" output is just what makes the gate's verdict, which
// otherwise lives only in the control plane's tool_decision broadcast, visible as chat text too.

import type { Id, Runner, RunnerEvent } from "../types.ts";
import type { AgentChatEnvelope } from "./chat-protocol.ts";

// Broad on purpose — this is a demo heuristic for deciding when to ask for the tool at all. It is
// NOT a safety boundary: the gate (evaluateTool in gate.ts) is the only thing that actually decides
// whether a mutating call is allowed, regardless of what triggers the request.
const MUTATING_INTENT = /\b(build|run|deploy|install|write|edit|make|test|commit|push|delete|rm)\b/i;

export function makeInteractiveRunner(): Runner {
  let emit: ((sessionId: Id, event: RunnerEvent) => void) | undefined;
  let n = 0; // monotonic id counter — no Date.now()/Math.random(), so ids are deterministic in tests
  const pendingInput = new Map<string, string>(); // requestId -> the input text that triggered it

  return {
    async start(input) {
      emit?.(input.sessionId, { type: "output", text: "▸ coding session ready (interactive demo runner)" });
    },

    async sendInput(sessionId, text) {
      // Chat messages arrive as the shared envelope ({from, message, authorized}); unwrap it so the
      // demo echo shows the human's words, not raw JSON. A direct /sessions/:id/input driver may send
      // plain text, which falls through unchanged.
      let ask = text;
      try {
        const env = JSON.parse(text) as Partial<AgentChatEnvelope>;
        if (env && typeof env.message === "string") ask = env.message;
      } catch {
        // not an envelope — treat as raw text
      }
      emit?.(sessionId, { type: "output", text: `· ${ask}` }); // echo the ask back into the channel first

      if (MUTATING_INTENT.test(ask)) {
        const requestId = `req-${++n}`;
        const turnId = `turn-${n}`;
        pendingInput.set(requestId, ask);
        emit?.(sessionId, { type: "tool_request", tool: "bash", input: ask, requestId, turnId });
      } else {
        emit?.(sessionId, { type: "output", text: "(demo runner — connect your desktop app to run a real coding agent)" });
      }
    },

    async answerTool(sessionId, requestId, decision) {
      // Consumed on lookup: a requestId is answered exactly once by the control plane, so there is
      // nothing to gain by keeping it around, and dropping it keeps this map from growing unbounded
      // across a long-lived session.
      const input = pendingInput.get(requestId) ?? "(unknown request)";
      pendingInput.delete(requestId);

      if (decision.allow) {
        emit?.(sessionId, { type: "output", text: `✓ ran: ${input}` });
      } else {
        emit?.(sessionId, { type: "output", text: `✗ blocked: ${decision.reason}` });
      }
    },

    async stop(sessionId) {
      emit?.(sessionId, { type: "exit", code: 0 });
    },

    onEvent(cb) {
      emit = cb;
    },
  };
}
