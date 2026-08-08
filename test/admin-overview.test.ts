// buildOverview, exercised fully offline with a fake Store & SessionStore — no real store
// involved, and no import of src/store/memory.ts (built in parallel; this suite only depends on
// the Store/SessionStore INTERFACES). Covers: every read path wired into the right AdminOverview
// field, `generatedAt` being a real ISO-8601 timestamp stamped during the call, and `chains`
// faithfully reflecting whatever verifyChains reports — including a broken-chain case — since
// buildOverview does no filtering of its own (the renderer decides presentation).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent, AgentSession, AuditEvent, Channel, SessionStore, Store } from "../src/types.ts";
import { buildOverview } from "../src/admin/overview.ts";

const GENESIS = "0".repeat(64);

const CHANNELS: Channel[] = [
  { id: "chan-1", workspaceId: "ws-1", kind: "human", name: "general", createdBy: "user-1", createdAt: "2026-08-08T00:00:00.000Z" },
];

const AGENTS: Agent[] = [
  { id: "agent-1", ownerSub: "user-1", kind: "assistant", name: "helper", createdAt: "2026-08-08T00:00:00.000Z" },
];

const SESSIONS: AgentSession[] = [
  {
    id: "sess-1",
    agentId: "agent-1",
    channelId: "chan-1",
    hostType: "server",
    status: "active",
    createdAt: "2026-08-08T00:00:00.000Z",
    leaseExpiresAt: "2026-08-08T00:05:00.000Z",
  },
];

const AUDIT: AuditEvent[] = [
  { id: "evt-1", seq: 1, actor: "user-1", action: "channel.create", target: "chan-1", prevHash: GENESIS, hash: "1".repeat(64), at: "2026-08-08T00:00:00.000Z" },
];

/** MINIMAL fake Store & SessionStore — implements only the five read methods buildOverview
 * calls (listChannels/listAllAgents/listAllSessions/listAudit/verifyChains). Cast through
 * `unknown` rather than structurally satisfying the full interfaces (matches the pattern in
 * test/assistant.test.ts). `chains` is parameterized so tests can drive different verdicts
 * through the same fake. */
function makeFakeStore(chains: { messagesOk: boolean; auditOk: boolean }) {
  const store = {
    async listChannels() {
      return CHANNELS;
    },
    async listAllAgents() {
      return AGENTS;
    },
    async listAllSessions() {
      return SESSIONS;
    },
    async listAudit() {
      return AUDIT;
    },
    async verifyChains() {
      return chains;
    },
  } as unknown as Store & SessionStore;

  return store;
}

test("buildOverview wires listChannels/listAllAgents/listAllSessions/listAudit/verifyChains into the right AdminOverview fields, with a fresh ISO generatedAt", async () => {
  const store = makeFakeStore({ messagesOk: true, auditOk: true });

  const before = new Date().toISOString();
  const overview = await buildOverview(store);
  const after = new Date().toISOString();

  assert.deepEqual(overview.channels, CHANNELS);
  assert.deepEqual(overview.agents, AGENTS);
  assert.deepEqual(overview.sessions, SESSIONS);
  assert.deepEqual(overview.audit, AUDIT);
  assert.deepEqual(overview.chains, { messagesOk: true, auditOk: true });

  // generatedAt is a real ISO-8601 UTC timestamp, generated during the call (not e.g. echoed
  // from an input or left undefined).
  assert.match(overview.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(overview.generatedAt >= before && overview.generatedAt <= after);
});

test("chains reflects a broken-chain verifyChains verdict ({ messagesOk: false }) faithfully, with everything else still flowing through unfiltered", async () => {
  const store = makeFakeStore({ messagesOk: false, auditOk: true });

  const overview = await buildOverview(store);

  assert.deepEqual(overview.chains, { messagesOk: false, auditOk: true });
  // buildOverview does not react to (or filter on) a broken chain — it's a faithful snapshot;
  // the renderer decides how to present a tamper verdict.
  assert.deepEqual(overview.channels, CHANNELS);
  assert.deepEqual(overview.agents, AGENTS);
  assert.deepEqual(overview.sessions, SESSIONS);
  assert.deepEqual(overview.audit, AUDIT);
});
