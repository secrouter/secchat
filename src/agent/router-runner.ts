// A Runner (src/types.ts) that routes each session to one of three underlying runners, chosen PER
// AGENT from the session's `launchEnv`: the POOL runner (a server-launched Kubernetes pod), the
// REMOTE daemon runner (the owner's desktop app), or the in-process SERVER runner (the pi subprocess,
// or the demo stub). The control plane holds exactly one Runner port and is unchanged — this
// composite hides the routing. A session is bound to its chosen runner at `start` and every later
// call (input / answerTool / stop) follows that binding.
//
// Per-agent (not per-owner) routing is the point: an agent created for the "pool" always runs in the
// pool and an agent created for the "desktop" always runs on the desktop daemon, so a user can have
// both at once. A legacy agent with no launchEnv keeps the original behavior (owner's daemon if one
// is attached, else the server runner).

import type { Id, Runner, RunnerEvent } from "../types.ts";

export function makeRouterRunner(deps: {
  server: Runner;
  remote: Runner;
  /** The Kubernetes pool runner. Unset ⇒ the pool isn't configured; a "pool" agent falls back to the
   * server runner (shouldn't happen — POST /agents rejects "pool" when it isn't available). */
  pool?: Runner;
  /** True when the owner has a live desktop daemon — used for legacy agents (no launchEnv) + as the
   * fallback for a "desktop" agent. */
  hasRemote: (ownerSub: string) => boolean;
}): Runner {
  const route = new Map<Id, Runner>(); // sessionId -> the runner that owns it

  /** Choose the runner for a session from its agent's launchEnv. */
  function pick(launchEnv: "desktop" | "pool" | undefined, ownerSub: string): Runner {
    if (launchEnv === "pool") return deps.pool ?? deps.server;
    if (launchEnv === "desktop") return deps.remote;
    // Legacy agent (no launchEnv): the owner's daemon if attached, else the in-process server runner.
    return deps.hasRemote(ownerSub) ? deps.remote : deps.server;
  }

  return {
    async start(input) {
      const chosen = pick(input.launchEnv, input.ownerSub);
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
      // Forward the control plane's single handler to ALL underlying runners (server, remote, and
      // the pool when configured); wrap it so the routing entry is freed when a session exits (else
      // the map would grow one entry per session forever).
      const wrapped = (sessionId: Id, event: RunnerEvent) => {
        if (event.type === "exit") route.delete(sessionId);
        cb(sessionId, event);
      };
      deps.server.onEvent(wrapped);
      deps.remote.onEvent(wrapped);
      deps.pool?.onEvent(wrapped);
    },
  };
}
