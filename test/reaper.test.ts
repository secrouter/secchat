// The orphan reaper: a session whose runner heartbeat lapses must be marked `orphaned` rather
// than sitting forever as `starting`/`active` while nothing is actually running (see the header
// comment in src/agent/reaper.ts). reapOrphaned is the pure lapsed-lease rule; runReaperOnce and
// startReaper are exercised against a fake SessionStore with an entirely injected clock — no real
// Date.now() in any assertion, and the one startReaper smoke test below waits on an event rather
// than a fixed sleep, so it isn't a source of timing flakiness.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reapOrphaned, runReaperOnce, startReaper } from "../src/agent/reaper.ts";
import type { AgentSession, SessionStatus, SessionStore } from "../src/types.ts";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const PAST = "2026-08-08T11:00:00.000Z"; // before NOW — a lapsed lease
const FUTURE = "2026-08-08T13:00:00.000Z"; // after NOW — still live

function session(id: string, status: SessionStatus, leaseExpiresAt: string): AgentSession {
  return {
    id,
    agentId: "agent-1",
    channelId: "chan-1",
    hostType: "server",
    status,
    createdAt: "2026-08-08T10:00:00.000Z",
    leaseExpiresAt,
  };
}

/** MINIMAL fake SessionStore — implements only listActiveSessions/setSessionStatus, the two
 * methods the reaper calls. Cast through `unknown` rather than structurally satisfying the full
 * SessionStore contract (matches the pattern in test/assistant.test.ts's makeFakeStore).
 * setSessionStatus both records the call (for assertions) AND mutates the underlying session in
 * place, so a fake behaves like a real store across repeated sweeps (relevant for the startReaper
 * smoke test below, where more than one tick may fire before stop()). */
function makeFakeStore(sessions: AgentSession[]) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const statusCalls: Array<{ id: string; status: SessionStatus }> = [];

  const store = {
    async listActiveSessions() {
      return [...byId.values()];
    },
    async setSessionStatus(id: string, status: SessionStatus) {
      statusCalls.push({ id, status });
      const s = byId.get(id);
      if (s) s.status = status;
    },
  } as unknown as SessionStore;

  return { store, statusCalls };
}

test("reapOrphaned: of a mix of statuses/leases, only the active session with a past lease is returned", () => {
  const sessions: AgentSession[] = [
    session("active-past", "active", PAST),
    session("active-future", "active", FUTURE),
    session("ended-past", "ended", PAST),
    session("orphaned-already", "orphaned", PAST),
  ];

  assert.deepEqual(reapOrphaned(sessions, NOW), ["active-past"]);
});

test("reapOrphaned: a \"starting\" session lapses the same way an \"active\" one does", () => {
  const sessions: AgentSession[] = [
    session("starting-past", "starting", PAST),
    session("starting-future", "starting", FUTURE),
  ];

  assert.deepEqual(reapOrphaned(sessions, NOW), ["starting-past"]);
});

test("reapOrphaned: a lease exactly at `now` counts as lapsed (<=, not <)", () => {
  const boundary = new Date(NOW).toISOString();
  const sessions: AgentSession[] = [session("boundary", "active", boundary)];

  assert.deepEqual(reapOrphaned(sessions, NOW), ["boundary"]);
});

test("runReaperOnce: transitions exactly the lapsed active session to \"orphaned\" and returns its id", async () => {
  const sessions: AgentSession[] = [
    session("active-past", "active", PAST),
    session("active-future", "active", FUTURE),
    session("ended-past", "ended", PAST),
    session("orphaned-already", "orphaned", PAST),
  ];
  const { store, statusCalls } = makeFakeStore(sessions);

  const ids = await runReaperOnce(store, NOW);

  assert.deepEqual(ids, ["active-past"]);
  assert.deepEqual(statusCalls, [{ id: "active-past", status: "orphaned" }]);
});

test("startReaper: ticks on its interval, reaps the lapsed session exactly once, and stop() clears the timer", async () => {
  const sessions: AgentSession[] = [session("active-past", "active", PAST)];
  const { store, statusCalls } = makeFakeStore(sessions);

  // Wait on the first tick's callback rather than a fixed sleep, so this isn't timing-sensitive.
  let resolveFirstTick!: (ids: string[]) => void;
  const firstTick = new Promise<string[]>((resolve) => {
    resolveFirstTick = resolve;
  });
  let tickCount = 0;

  const handle = startReaper(store, {
    now: () => NOW,
    intervalMs: 5,
    onReap: (ids) => {
      tickCount++;
      if (tickCount === 1) resolveFirstTick(ids);
    },
  });

  const firstIds = await firstTick;
  handle.stop();

  assert.deepEqual(firstIds, ["active-past"]);
  // setSessionStatus mutates the fake's session in place, so even if a second tick had already
  // fired before stop() took effect, that session no longer qualifies (status is "orphaned") —
  // exactly one setSessionStatus call for it, regardless of how many ticks actually ran.
  assert.deepEqual(statusCalls, [{ id: "active-past", status: "orphaned" }]);
});
