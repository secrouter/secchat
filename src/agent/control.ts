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
// canGrantExecute is used both for the owner-only grant check AND, now, to decide whether the author
// of the current turn may cause a mutation at all (the enforced side of "behavior control").
import type { Agent, AgentControl, AgentSession, GitSshMaterial, Id, Message, Runner, RunnerEvent, SessionStore } from "../types.ts";

const DEFAULT_LEASE_TTL_MS = 60_000;

export function makeControlPlane(deps: {
  sessions: SessionStore;
  runner: Runner;
  getAgent: (id: string) => Promise<Agent | null>;
  broadcast?: (channelId: string, payload: unknown) => void;
  /** Persist a coding agent's output turn as a channel message (authorType "agent"). Unset ⇒ the
   * legacy ephemeral agent_output broadcast (not stored). Wired to the GOVERNED append
   * (governance/append.ts) in production — marking stamp + DLP — which returns the ENRICHED
   * message whose `content` is what was actually persisted (possibly a withheld notice). */
  appendAgentMessage?: (channelId: string, agentId: string, text: string) => Promise<Message & { content: string }>;
  /** Resolve the OWNER's decrypted git SSH identity to inject into this session's runner (git auth
   * inside the coding agent), or undefined when the feature is off or the owner has no key. Wired in
   * src/index.ts from the store + config.secretKey; unset ⇒ no key is ever injected. Only the owner's
   * own key is ever fetched here — attribution and injection both key on the agent's `ownerSub`. */
  getGitSsh?: (ownerSub: string) => Promise<GitSshMaterial | undefined>;
  leaseTtlMs?: number;
  now?: () => number;
}): AgentControl {
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const now = deps.now ?? (() => Date.now());

  /** Who prompted the CURRENT turn per session (set on every sendInput). The tool-request gate uses
   * it to enforce that only the owner's prompt can drive a mutation — a secondary participant's turn
   * is plan-mode-only regardless of any active grant. Best-effort per-session (last writer wins);
   * cleared on exit. */
  const turnAuthorBySession = new Map<Id, string>();

  /** Routes one runner event for one session. Unknown/ended sessions are ignored outright — no
   * gate evaluation, no broadcast, nothing. A session can't un-end, so a stray late event after
   * `exit` (or an id this control plane never spawned) is dropped rather than acted on. */
  async function handleEvent(sessionId: Id, event: RunnerEvent): Promise<void> {
    const session = await deps.sessions.getSession(sessionId);
    if (!session || session.status === "ended") return;

    switch (event.type) {
      case "output":
        // Persist the agent's turn as a real channel message (so it survives a session restart /
        // reload and renders as markdown like any message), then broadcast THAT message. Falls back
        // to the ephemeral agent_output stream when no persister is wired (tests / bare deployments).
        if (deps.appendAgentMessage) {
          const message = await deps.appendAgentMessage(session.channelId, session.agentId, event.text);
          // Broadcast EXACTLY what was persisted: the governed append returns the enriched message
          // whose `content` carries the plaintext (the stored row holds only the hash) — or a
          // withheld notice when DLP/marking blocked the output. Never re-attach event.text here:
          // that would leak blocked content into the live event. Add the agent's display name + kind
          // so the byline shows the name, not the opaque agent id (matches GET /channels enrichment).
          const agent = await deps.getAgent(session.agentId);
          deps.broadcast?.(session.channelId, {
            type: "message",
            message: { ...message, displayName: agent?.name, agentKind: agent?.kind },
          });
        } else {
          deps.broadcast?.(session.channelId, { type: "agent_output", sessionId, text: event.text });
        }
        return;

      case "tool_request": {
        const agent = await deps.getAgent(session.agentId);
        const grant = await deps.sessions.activeGrant(sessionId);
        let decision = evaluateTool({ tool: event.tool, grant, turnId: event.turnId });

        // Hard behavior boundary: a MUTATING tool is only allowed when the CURRENT turn was
        // initiated by a user who may authorize edits — i.e. the agent's owner. A secondary
        // participant can prompt the agent in plan mode all day but can NEVER cause a mutation, even
        // while an owner's grant is still active. evaluateTool + the owner-only grant already gate
        // WHETHER edits are on; this gates WHOSE prompt may use them (the envelope's `authorized`
        // flag is only pi's soft cue — this is the enforced boundary).
        if (decision.allow && agent && classifyTool(event.tool) === "mutate") {
          const author = turnAuthorBySession.get(sessionId);
          // Deny when the turn's author is KNOWN and isn't allowed to authorize edits (a secondary
          // participant). Production always records the author (triggerCodingAgents / the input
          // route), so this always applies there; an author-less programmatic driver falls back to
          // the grant-only rule above.
          if (author && !canGrantExecute(agent, author).allow) {
            decision = { allow: false, reason: "only the agent's owner can trigger edits — others are in plan mode" };
          }
        }

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
        turnAuthorBySession.delete(sessionId);
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

    // Resolve the owner's git identity to inject (if the feature is on and they have a key) — so git
    // inside the coding session authenticates as them. Best-effort: a lookup failure must not block
    // spawning the session (the agent simply runs without git auth).
    let gitSsh: GitSshMaterial | undefined;
    if (deps.getGitSsh) {
      try {
        gitSsh = await deps.getGitSsh(input.agent.ownerSub);
      } catch {
        gitSsh = undefined;
      }
    }

    await deps.runner.start({
      sessionId: session.id,
      agentId: input.agent.id,
      ownerSub: input.agent.ownerSub,
      // A coding agent's mounted local directory (if any) becomes pi's cwd; omit the key entirely
      // when unset so the runner falls back to its per-agent scratch workspace.
      ...(input.agent.workspace ? { workspace: input.agent.workspace } : {}),
      ...(gitSsh ? { gitSsh } : {}),
      // The agent's chosen environment routes this session (agent/router-runner.ts) — desktop daemon,
      // Kubernetes pool, or the in-process server runner.
      ...(input.agent.launchEnv ? { launchEnv: input.agent.launchEnv } : {}),
    });
    await deps.sessions.setSessionStatus(session.id, "active");

    return { ...session, status: "active" };
  }

  async function grantExecute(input: {
    sessionId: Id;
    byUser: string;
    scope: "plan" | "once" | "turn" | "always";
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

  /** Revoke the session's active execute grant — used to leave continual ("always") execution and
   * return to plan mode. Owner-only, same gate as granting. Consuming the current grant makes the
   * next mutating tool require a fresh authorization. A no-op-shaped success when nothing's active. */
  async function revokeExecute(input: {
    sessionId: Id;
    byUser: string;
  }): Promise<{ allow: boolean; reason: string }> {
    const session = await deps.sessions.getSession(input.sessionId);
    if (!session) return { allow: false, reason: "unknown session" };
    const agent = await deps.getAgent(session.agentId);
    if (!agent) return { allow: false, reason: "unknown agent" };
    const decision = canGrantExecute(agent, input.byUser);
    if (!decision.allow) return decision;
    await deps.sessions.consumeGrant(input.sessionId);
    return { allow: true, reason: "revoked" };
  }

  async function sendInput(sessionId: Id, text: string, authorSub?: string): Promise<void> {
    // Record who is driving this turn so the tool-request gate can enforce that only the owner's
    // prompt may cause a mutation (see the "hard behavior boundary" note above).
    if (authorSub) turnAuthorBySession.set(sessionId, authorSub);
    await deps.runner.sendInput(sessionId, text);
  }

  async function getSession(id: Id): Promise<AgentSession | null> {
    return deps.sessions.getSession(id);
  }

  /** Newest starting|active session for a channel, or null. A reloaded client uses this to route
   * input back to the running agent instead of losing the handle (the session id only ever lived in
   * the POST /agents response before). "starting"/"active" are the two not-yet-dead statuses; an
   * "orphaned"/"ended" one is skipped so the caller (re)spawns a fresh one. */
  async function liveSession(channelId: Id): Promise<AgentSession | null> {
    const sessions = await deps.sessions.listSessionsByChannel(channelId);
    const live = sessions.filter((s) => s.status === "starting" || s.status === "active");
    if (live.length === 0) return null;
    // createSession appends, so the last live entry is the newest.
    return live[live.length - 1]!;
  }

  return { spawn, grantExecute, revokeExecute, sendInput, getSession, liveSession };
}
