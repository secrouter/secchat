// The coding-agent control plane (decision #2; review finding C1) — the thing that actually
// drives a Runner through a session's lifecycle and stands between every runner `tool_request`
// and the runner's `answerTool` callback, so a mutating tool NEVER reaches "answered" without
// first passing through the execute-gate (src/agent/gate.ts, frozen — imported/used here, never
// reimplemented).
//
// One `runner.onEvent` handler is registered ONCE, in the factory, and multiplexes every
// (sessionId, event) pair across every session this control plane owns (Runner is a single port
// hosting many sessions — there is no per-session subscription). Every gate decision — allow or
// deny — is also broadcast to the channel as a `tool_decision`: the gate's verdicts are meant to
// be auditable UX for everyone in the channel, not a hidden backend detail.
//
// Depends only on the `SessionStore` / `Runner` PORTS (src/types.ts) and an injected `getAgent`
// lookup — never a concrete store (src/store/memory.ts is built in parallel; this module doesn't
// import it), so it's fully testable offline with fakes — see test/control.test.ts.

import { canGrantExecute, classifyTool, evaluateTool } from "./gate.ts";
import type { Agent, AgentControl, AgentSession, Id, Runner, RunnerEvent, SessionStore } from "../types.ts";

const DEFAULT_LEASE_TTL_MS = 60_000;

export function makeControlPlane(deps: {
  sessions: SessionStore;
  runner: Runner;
  getAgent: (id: string) => Promise<Agent | null>;
  broadcast?: (channelId: string, payload: unknown) => void;
  leaseTtlMs?: number;
  now?: () => number;
}): AgentControl {
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = deps.now ?? (() => Date.now());

  /** Routes one runner event for one session. Unknown/ended sessions are ignored outright — no
   * gate evaluation, no broadcast, nothing. A session can't un-end, so a stray late event after
   * `exit` (or an id this control plane never spawned) is dropped rather than acted on. */
  async function handleEvent(sessionId: Id, event: RunnerEvent): Promise<void> {
    const session = await deps.sessions.getSession(sessionId);
    if (!session || session.status === "ended") return;

    switch (event.type) {
      case "output":
        deps.broadcast?.(session.channelId, { type: "agent_output", sessionId, text: event.text });
        return;

      case "tool_request": {
        // Loaded per the control-plane contract; evaluateTool() itself is agent-agnostic (its
        // decision turns only on the tool + grant + turn — see gate.ts), so the lookup result
        // isn't consumed below. Kept for parity with that contract; flagged in the task report
        // as apparently-vestigial today, in case per-agent policy is meant to land here later.
        await deps.getAgent(session.agentId);

        const grant = await deps.sessions.activeGrant(sessionId);
        const decision = evaluateTool({ tool: event.tool, grant, turnId: event.turnId });
        await deps.runner.answerTool(sessionId, event.requestId, decision);

        // Consume a "once" grant only when it actually authorized THIS call. A read tool is
        // always allow:true regardless of any grant (gate.ts never even inspects the grant for
        // reads), so gating solely on "allowed + a once-scoped grant happens to be active" would
        // let an unrelated read call silently burn a pending once-grant before the mutation it
        // was meant for ever runs. classifyTool is gate.ts's own export, used here rather than
        // re-derived, to identify a genuinely mutate-authorizing use.
        if (decision.allow && grant?.scope === "once" && classifyTool(event.tool) === "mutate") {
          await deps.sessions.consumeGrant(sessionId);
        }

        deps.broadcast?.(session.channelId, {
          type: "tool_decision",
          sessionId,
          tool: event.tool,
          allow: decision.allow,
          reason: decision.reason,
        });
        return;
      }

      case "status":
        await deps.sessions.setSessionStatus(sessionId, event.status);
        return;

      case "exit":
        await deps.sessions.setSessionStatus(sessionId, "ended");
        deps.broadcast?.(session.channelId, { type: "session_ended", sessionId });
        return;
    }
  }

  deps.runner.onEvent((sessionId, event) => {
    // Fire-and-forget dispatch boundary (same pattern as agent/reaper.ts's tick and
    // ws/hub.ts's onUpgrade): onEvent's callback is synchronous (`=> void`), so a rejection
    // must not escape it. There's no logger port in the current contract to report a failure
    // through, so — like those two — it's swallowed here rather than thrown into the runner.
    void handleEvent(sessionId, event).catch(() => {});
  });

  async function spawn(input: { agent: Agent; channelId: Id; hostType: "server" | "local" }): Promise<AgentSession> {
    const session = await deps.sessions.createSession({
      agentId: input.agent.id,
      channelId: input.channelId,
      hostType: input.hostType,
      status: "starting",
      leaseExpiresAt: new Date(now() + leaseTtlMs).toISOString(),
    });

    await deps.runner.start({ sessionId: session.id, agentId: input.agent.id, ownerSub: input.agent.ownerSub });
    await deps.sessions.setSessionStatus(session.id, "active");

    return { ...session, status: "active" };
  }

  async function grantExecute(input: {
    sessionId: Id;
    byUser: string;
    scope: "once" | "turn";
    turnId?: string;
  }): Promise<{ allow: boolean; reason: string }> {
    const session = await deps.sessions.getSession(input.sessionId);
    if (!session) return { allow: false, reason: "unknown session" };

    const agent = await deps.getAgent(session.agentId);
    if (!agent) return { allow: false, reason: "unknown agent" };

    // Owner-only-ness is enforced entirely by the gate, not re-implemented here (C1: exactly one
    // place decides who may authorize execution).
    const decision = canGrantExecute(agent, input.byUser);
    if (!decision.allow) return decision;

    await deps.sessions.addGrant({
      sessionId: input.sessionId,
      grantedBy: input.byUser,
      scope: input.scope,
      turnId: input.turnId,
      grantedAt: new Date(now()).toISOString(),
    });
    return { allow: true, reason: "granted" };
  }

  async function sendInput(sessionId: Id, text: string): Promise<void> {
    await deps.runner.sendInput(sessionId, text);
  }

  async function getSession(id: Id): Promise<AgentSession | null> {
    return deps.sessions.getSession(id);
  }

  return { spawn, grantExecute, sendInput, getSession };
}
