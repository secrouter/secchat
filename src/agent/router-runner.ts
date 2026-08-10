// A Runner (src/types.ts) that routes each session to one of two underlying runners: the REMOTE
// daemon runner when the agent's owner has a daemon attached, else the in-process SERVER runner
// (the pi subprocess, or the demo stub). The control plane holds exactly one Runner port and is
// unchanged — this composite hides the routing. A session is bound to its chosen runner at `start`
// and every later call (input / answerTool / stop) follows that binding.

import type { Id, Runner, RunnerEvent } from "../types.ts";

export function makeRouterRunner(deps: {
  server: Runner;
  remote: Runner;
  /** True when the owner has a live daemon — decides remote vs server at spawn time. */
  hasRemote: (ownerSub: string) => boolean;
}): Runner {
  const route = new Map<Id, Runner>(); // sessionId -> the runner that owns it

  return {
    async start(input) {
      const chosen = deps.hasRemote(input.ownerSub) ? deps.remote : deps.server;
      route.set(input.sessionId, chosen);
      await chosen.start(input);
    },
    async sendInput(sessionId, text) {
      await (route.get(sessionId) ?? deps.server).sendInput(sessionId, text);
    },
    async answerTool(sessionId, requestId, decision) {
      await (route.get(sessionId) ?? deps.server).answerTool(sessionId, requestId, decision);
    },
    async stop(sessionId) {
      const r = route.get(sessionId) ?? deps.server;
      route.delete(sessionId);
      await r.stop(sessionId);
    },
    onEvent(cb) {
      // Forward the control plane's single handler to BOTH runners; wrap it so the routing entry is
      // freed when a session exits (else the map would grow one entry per session forever).
      const wrapped = (sessionId: Id, event: RunnerEvent) => {
        if (event.type === "exit") route.delete(sessionId);
        cb(sessionId, event);
      };
      deps.server.onEvent(wrapped);
      deps.remote.onEvent(wrapped);
    },
  };
}
