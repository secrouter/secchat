// The control plane, exercised fully offline with fakes for every injected port (SessionStore,
// Runner, getAgent) — no real store or runner involved, and no import of src/store/memory.ts
// (built in parallel; this suite only depends on the SessionStore/Runner INTERFACES). Covers:
// spawn's runner.start + active-status handoff, the execute-gate wired into every tool_request
// (read always allowed, mutate denied with no grant), grantExecute's owner-only enforcement and
// "once"/"turn" grant semantics, the output/tool_decision/session_ended broadcasts, and the
// unknown/ended-session ignore rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent, AgentSession, ExecuteGrant, Runner, RunnerEvent, SessionStore } from "../src/types.ts";
import { makeControlPlane } from "../src/agent/control.ts";

const AGENT: Agent = { id: "agent-1", ownerSub: "owner-1", kind: "coding", name: "Coder", createdAt: "2026-08-08T00:00:00.000Z" };

/** Map-backed fake SessionStore — implements the full SessionStore contract (small enough not to
 * need the partial/`as unknown as` pattern used for the larger Store interface elsewhere). Grants
 * are exposed on the returned handle so tests can assert directly on what got persisted. */
function makeFakeSessionStore() {
  const sessions = new Map<string, AgentSession>();
  const grants = new Map<string, ExecuteGrant>(); // sessionId -> its current grant
  let nextId = 1;

  const store: SessionStore = {
    async createSession(input) {
      const session: AgentSession = { ...input, id: `sess-${nextId++}`, createdAt: "2026-08-08T00:00:00.000Z" };
      sessions.set(session.id, session);
      return session;
    },
    async getSession(id) {
      return sessions.get(id) ?? null;
    },
    async listSessionsByChannel(channelId) {
      return [...sessions.values()].filter((s) => s.channelId === channelId);
    },
    async listActiveSessions() {
      return [...sessions.values()].filter((s) => s.status === "active");
    },
    async listAllSessions() {
      return [...sessions.values()];
    },
    async setSessionStatus(id, status) {
      const session = sessions.get(id);
      if (!session) throw new Error(`fake SessionStore.setSessionStatus: unknown session ${id}`);
      session.status = status;
    },
    async renewLease(id, leaseExpiresAt) {
      const session = sessions.get(id);
      if (!session) throw new Error(`fake SessionStore.renewLease: unknown session ${id}`);
      session.leaseExpiresAt = leaseExpiresAt;
    },
    async addGrant(grant) {
      grants.set(grant.sessionId, grant);
    },
    async activeGrant(sessionId) {
      const grant = grants.get(sessionId);
      if (!grant || grant.consumed) return undefined;
      return grant;
    },
    async consumeGrant(sessionId) {
      const grant = grants.get(sessionId);
      if (grant) grant.consumed = true;
    },
  };

  return { store, sessions, grants };
}

/** Fake Runner — captures every start/sendInput/answerTool call and stashes the single onEvent
 * handler the control plane registers, so tests can synthesize runner events with `emit()`.
 * `emit` awaits a macrotask tick after invoking the (synchronous, fire-and-forget) handler so the
 * control plane's internal `handleEvent` chain — several sequential awaits over the fake store —
 * has fully settled before the test asserts on it. */
function makeFakeRunner() {
  const calls = {
    start: [] as Array<{ sessionId: string; agentId: string; ownerSub: string; workspace?: string }>,
    sendInput: [] as Array<{ sessionId: string; text: string }>,
    answerTool: [] as Array<{ sessionId: string; requestId: string; decision: { allow: boolean; reason: string } }>,
    stop: [] as string[],
  };
  let handler: ((sessionId: string, event: RunnerEvent) => void) | undefined;

  const runner: Runner = {
    async start(input) {
      calls.start.push(input);
    },
    async sendInput(sessionId, text) {
      calls.sendInput.push({ sessionId, text });
    },
    async answerTool(sessionId, requestId, decision) {
      calls.answerTool.push({ sessionId, requestId, decision });
    },
    async stop(sessionId) {
      calls.stop.push(sessionId);
    },
    onEvent(cb) {
      handler = cb;
    },
  };

  async function emit(sessionId: string, event: RunnerEvent): Promise<void> {
    handler?.(sessionId, event);
    await new Promise((resolve) => setImmediate(resolve)); // let handleEvent's await-chain settle
  }

  return { runner, calls, emit };
}

function makeFakeGetAgent(agents: Agent[]) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return async (id: string): Promise<Agent | null> => byId.get(id) ?? null;
}

function makeFakeBroadcast() {
  const events: Array<{ channelId: string; payload: unknown }> = [];
  const broadcast = (channelId: string, payload: unknown) => {
    events.push({ channelId, payload });
  };
  return { broadcast, events };
}

test("spawn starts the runner, hands the session to \"active\", and sets leaseExpiresAt from now()+leaseTtlMs", async () => {
  const { store } = makeFakeSessionStore();
  const { runner, calls } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const control = makeControlPlane({ sessions: store, runner, getAgent, leaseTtlMs: 30_000, now: () => 1_000_000 });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });

  assert.equal(calls.start.length, 1);
  assert.deepEqual(calls.start[0], { sessionId: session.id, agentId: AGENT.id, ownerSub: AGENT.ownerSub });

  assert.equal(session.status, "active");
  assert.equal(session.channelId, "chan-1");
  assert.equal(session.hostType, "local");
  assert.equal(session.leaseExpiresAt, new Date(1_000_000 + 30_000).toISOString());

  // The store itself was actually updated, not just the returned object patched locally.
  const persisted = await control.getSession(session.id);
  assert.equal(persisted?.status, "active");
});

test("spawn defaults leaseTtlMs to 60_000 when not supplied", async () => {
  const { store } = makeFakeSessionStore();
  const { runner } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const control = makeControlPlane({ sessions: store, runner, getAgent, now: () => 0 });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "server" });
  assert.equal(session.leaseExpiresAt, new Date(60_000).toISOString());
});

test("tool_request for a READ tool is allowed without any grant", async () => {
  const { store } = makeFakeSessionStore();
  const { runner, calls, emit } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const control = makeControlPlane({ sessions: store, runner, getAgent });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });
  await emit(session.id, { type: "tool_request", tool: "grep", requestId: "req-1" });

  assert.equal(calls.answerTool.length, 1);
  assert.deepEqual(calls.answerTool[0], {
    sessionId: session.id,
    requestId: "req-1",
    decision: { allow: true, reason: "read-only tool (plan mode)" },
  });
});

test("tool_request for a MUTATE tool with no grant is denied", async () => {
  const { store } = makeFakeSessionStore();
  const { runner, calls, emit } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const control = makeControlPlane({ sessions: store, runner, getAgent });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });
  await emit(session.id, { type: "tool_request", tool: "bash", requestId: "req-1" });

  assert.equal(calls.answerTool.length, 1);
  assert.equal(calls.answerTool[0]?.decision.allow, false);
});

test("grantExecute is owner-only, and a \"once\" grant authorizes exactly one mutation", async () => {
  const { store, grants } = makeFakeSessionStore();
  const { runner, calls, emit } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const control = makeControlPlane({ sessions: store, runner, getAgent });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });

  // Non-owner: denied, no grant stored.
  const denied = await control.grantExecute({ sessionId: session.id, byUser: "colleague-2", scope: "once" });
  assert.equal(denied.allow, false);
  assert.equal(grants.has(session.id), false);

  // Owner: granted and persisted.
  const granted = await control.grantExecute({ sessionId: session.id, byUser: AGENT.ownerSub, scope: "once" });
  assert.equal(granted.allow, true);
  assert.equal(grants.get(session.id)?.scope, "once");
  assert.equal(grants.get(session.id)?.grantedBy, AGENT.ownerSub);

  // First "bash": authorized by the grant, which is then consumed.
  await emit(session.id, { type: "tool_request", tool: "bash", requestId: "req-1" });
  assert.equal(calls.answerTool[0]?.decision.allow, true);
  assert.equal(grants.get(session.id)?.consumed, true);

  // Second "bash": the once-grant is spent.
  await emit(session.id, { type: "tool_request", tool: "bash", requestId: "req-2" });
  assert.equal(calls.answerTool[1]?.decision.allow, false);
});

test("a \"once\" grant survives an intervening READ tool call — only the MUTATE call it authorizes consumes it", async () => {
  // Regression guard for a literal-but-buggy reading of "consume when allowed and the grant is
  // once-scoped": a read tool is always allow:true regardless of any grant, so that check alone
  // would let an unrelated "grep" burn a pending once-grant before the mutation it was meant for
  // ever ran. This asserts the fix: only a MUTATE call that the grant actually authorized
  // consumes it.
  const { store, grants } = makeFakeSessionStore();
  const { runner, calls, emit } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const control = makeControlPlane({ sessions: store, runner, getAgent });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });
  await control.grantExecute({ sessionId: session.id, byUser: AGENT.ownerSub, scope: "once" });

  await emit(session.id, { type: "tool_request", tool: "grep", requestId: "req-1" }); // read: grant untouched
  assert.equal(calls.answerTool[0]?.decision.allow, true);
  assert.equal(grants.get(session.id)?.consumed, undefined);

  await emit(session.id, { type: "tool_request", tool: "bash", requestId: "req-2" }); // mutate: consumes it
  assert.equal(calls.answerTool[1]?.decision.allow, true);
  assert.equal(grants.get(session.id)?.consumed, true);

  await emit(session.id, { type: "tool_request", tool: "bash", requestId: "req-3" }); // now spent
  assert.equal(calls.answerTool[2]?.decision.allow, false);
});

test("a \"turn\"-scoped grant authorizes mutation only within its matching turn, and is never auto-consumed", async () => {
  const { store } = makeFakeSessionStore();
  const { runner, calls, emit } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const control = makeControlPlane({ sessions: store, runner, getAgent });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });
  const granted = await control.grantExecute({ sessionId: session.id, byUser: AGENT.ownerSub, scope: "turn", turnId: "turn-9" });
  assert.equal(granted.allow, true);

  await emit(session.id, { type: "tool_request", tool: "bash", requestId: "req-1", turnId: "turn-9" });
  assert.equal(calls.answerTool[0]?.decision.allow, true);

  await emit(session.id, { type: "tool_request", tool: "bash", requestId: "req-2", turnId: "turn-10" });
  assert.equal(calls.answerTool[1]?.decision.allow, false); // different turn

  await emit(session.id, { type: "tool_request", tool: "bash", requestId: "req-3", turnId: "turn-9" });
  assert.equal(calls.answerTool[2]?.decision.allow, true); // same turn again — a turn grant is reusable
});

test("an output event broadcasts agent_output, and every tool_request also broadcasts a tool_decision", async () => {
  const { store } = makeFakeSessionStore();
  const { runner, emit } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const { broadcast, events } = makeFakeBroadcast();
  const control = makeControlPlane({ sessions: store, runner, getAgent, broadcast });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });

  await emit(session.id, { type: "output", text: "hello from the agent" });
  assert.deepEqual(events[0], {
    channelId: "chan-1",
    payload: { type: "agent_output", sessionId: session.id, text: "hello from the agent" },
  });

  await emit(session.id, { type: "tool_request", tool: "grep", requestId: "req-1" });
  assert.deepEqual(events[1], {
    channelId: "chan-1",
    payload: { type: "tool_decision", sessionId: session.id, tool: "grep", allow: true, reason: "read-only tool (plan mode)" },
  });

  await emit(session.id, { type: "tool_request", tool: "bash", requestId: "req-2" });
  const denyPayload = events[2]?.payload as { type: string; allow: boolean; tool: string };
  assert.equal(denyPayload.type, "tool_decision");
  assert.equal(denyPayload.tool, "bash");
  assert.equal(denyPayload.allow, false); // deny decisions are broadcast too — auditable, not hidden
});

test("status/exit events update session state; exit broadcasts session_ended and further events are ignored", async () => {
  const { store } = makeFakeSessionStore();
  const { runner, emit } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const { broadcast, events } = makeFakeBroadcast();
  const control = makeControlPlane({ sessions: store, runner, getAgent, broadcast });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });

  await emit(session.id, { type: "status", status: "orphaned" });
  assert.equal((await control.getSession(session.id))?.status, "orphaned");
  assert.equal(events.length, 0); // no broadcast is specified for plain status transitions

  await emit(session.id, { type: "exit", code: 0 });
  assert.equal((await control.getSession(session.id))?.status, "ended");
  assert.deepEqual(events.at(-1), { channelId: "chan-1", payload: { type: "session_ended", sessionId: session.id } });

  const countAfterExit = events.length;
  await emit(session.id, { type: "output", text: "too late" }); // session already ended: ignored
  await emit(session.id, { type: "tool_request", tool: "grep", requestId: "req-late" });
  assert.equal(events.length, countAfterExit);
});

test("events for an unknown session id are ignored (no throw, no broadcast)", async () => {
  const { store } = makeFakeSessionStore();
  const { runner, calls, emit } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const { broadcast, events } = makeFakeBroadcast();
  makeControlPlane({ sessions: store, runner, getAgent, broadcast });

  await emit("no-such-session", { type: "output", text: "hi" });
  await emit("no-such-session", { type: "tool_request", tool: "bash", requestId: "req-1" });

  assert.equal(events.length, 0);
  assert.equal(calls.answerTool.length, 0);
});

test("sendInput forwards to the runner", async () => {
  const { store } = makeFakeSessionStore();
  const { runner, calls } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const control = makeControlPlane({ sessions: store, runner, getAgent });

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });
  await control.sendInput(session.id, "hello agent");

  assert.deepEqual(calls.sendInput, [{ sessionId: session.id, text: "hello agent" }]);
});

test("works with no broadcast fn supplied (optional dep)", async () => {
  const { store } = makeFakeSessionStore();
  const { runner, emit } = makeFakeRunner();
  const getAgent = makeFakeGetAgent([AGENT]);
  const control = makeControlPlane({ sessions: store, runner, getAgent }); // no broadcast

  const session = await control.spawn({ agent: AGENT, channelId: "chan-1", hostType: "local" });
  await emit(session.id, { type: "output", text: "hi" });
  await emit(session.id, { type: "tool_request", tool: "grep", requestId: "req-1" });
  await emit(session.id, { type: "exit", code: 0 });

  assert.equal((await control.getSession(session.id))?.status, "ended");
});
