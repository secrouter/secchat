// MemoryStore: same chain semantics as audit/chain.ts (per-channel message chain, one global
// audit chain) plus the CRUD/query surface the HTTP+WS layers run against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GENESIS, computeMessageHash } from "../src/audit/chain.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { ExecuteGrant } from "../src/types.ts";

const WORKSPACE = "ws-1";

/** ISO timestamp `ms` in the future — a plausible lease expiry for session tests. */
function futureLease(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

test("channel -> members -> messages: listMessages is seq-ordered with content, chain verifies", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({
    workspaceId: WORKSPACE,
    kind: "human",
    name: "general",
    createdBy: "user-alice",
  });
  assert.ok(channel.id);
  assert.ok(channel.createdAt);

  await store.addMember({ channelId: channel.id, memberRef: "user-alice", memberType: "user", role: "owner" });
  await store.addMember({ channelId: channel.id, memberRef: "user-bob", memberType: "user", role: "member" });

  const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "hello" });
  const m2 = await store.appendMessage({ channelId: channel.id, authorRef: "user-bob", authorType: "user", content: "hi alice" });
  const m3 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "how's it going" });

  assert.deepEqual([m1.seq, m2.seq, m3.seq], [1, 2, 3]);
  assert.equal(m1.prevHash, GENESIS);
  assert.equal(m2.prevHash, m1.hash);
  assert.equal(m3.prevHash, m2.hash);

  const listed = await store.listMessages(channel.id);
  assert.deepEqual(listed.map((m) => m.seq), [1, 2, 3]);
  assert.deepEqual(listed.map((m) => m.content), ["hello", "hi alice", "how's it going"]);

  assert.equal((await store.verifyChains()).messagesOk, true);
});

test("isMember/listMembers reflect membership", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  await store.addMember({ channelId: channel.id, memberRef: "user-alice", memberType: "user", role: "owner" });

  assert.equal(await store.isMember(channel.id, "user-alice"), true);
  assert.equal(await store.isMember(channel.id, "user-carol"), false);

  const members = await store.listMembers(channel.id);
  assert.equal(members.length, 1);
  assert.equal(members[0]?.memberRef, "user-alice");
});

test("redaction: content is omitted (key absent) from listMessages, but the chain stays intact", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "public" });
  const m2 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "ssn: 123-45-6789" });
  const m3 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "after" });

  await store.redactMessage(m2.id, "admin-1", "CUI spillage");

  const listed = await store.listMessages(channel.id);
  const redacted = listed.find((m) => m.id === m2.id)!;
  assert.equal("content" in redacted, false); // truly omitted, not `content: undefined`
  assert.ok(redacted.redactedAt);
  assert.equal(redacted.contentSha256, m2.contentSha256); // chain-bound fields untouched
  assert.equal(redacted.prevHash, m2.prevHash);
  assert.equal(redacted.hash, m2.hash);

  // neighbors unaffected
  assert.equal(listed.find((m) => m.id === m1.id)?.content, "public");
  assert.equal(listed.find((m) => m.id === m3.id)?.content, "after");

  assert.equal((await store.verifyChains()).messagesOk, true);
});

test("appendAudit forms a verifying chain, and redactMessage appends exactly one audit event", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "x" });

  const e1 = await store.appendAudit({ actor: "user-alice", action: "channel.create", target: channel.id });
  assert.equal(e1.seq, 1);
  assert.equal(e1.prevHash, GENESIS);
  assert.equal((await store.verifyChains()).auditOk, true);

  await store.redactMessage(m1.id, "admin-1", "test");

  // redactMessage's internal appendAudit({actor: by, action: "message.redact", target: id})
  // must land as seq 2 — proves it appended exactly once, not zero or twice.
  const e3 = await store.appendAudit({ actor: "user-alice", action: "noop" });
  assert.equal(e3.seq, 3);
  assert.equal((await store.verifyChains()).auditOk, true);
});

test("seq/prevHash linkage is independent per channel (each starts at GENESIS)", async () => {
  const store = new MemoryStore();
  const c1 = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  const c2 = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });

  const a1 = await store.appendMessage({ channelId: c1.id, authorRef: "user-alice", authorType: "user", content: "c1 first" });
  const b1 = await store.appendMessage({ channelId: c2.id, authorRef: "agent-1", authorType: "agent", content: "c2 first" });

  assert.equal(a1.seq, 1);
  assert.equal(b1.seq, 1);
  assert.equal(a1.prevHash, GENESIS);
  assert.equal(b1.prevHash, GENESIS);
  assert.notEqual(a1.hash, b1.hash); // same prevHash/seq, but channelId differs -> different link hash

  assert.equal((await store.verifyChains()).messagesOk, true);
});

test("getChannel returns null for an unknown id", async () => {
  const store = new MemoryStore();
  assert.equal(await store.getChannel("00000000-0000-4000-8000-000000000000"), null);
});

test("createAgent -> getAgent round-trip; unknown id returns null", async () => {
  const store = new MemoryStore();
  const agent = await store.createAgent({ ownerSub: "user-alice", kind: "assistant", name: "helper", model: "claude-x" });
  assert.ok(agent.id);
  assert.ok(agent.createdAt);
  assert.equal(agent.ownerSub, "user-alice");
  assert.equal(agent.kind, "assistant");
  assert.equal(agent.name, "helper");
  assert.equal(agent.model, "claude-x");

  const fetched = await store.getAgent(agent.id);
  assert.deepEqual(fetched, agent);

  assert.equal(await store.getAgent("00000000-0000-4000-8000-000000000000"), null);
});

test("listAgentsByOwner filters by owner and preserves creation order", async () => {
  const store = new MemoryStore();
  const a1 = await store.createAgent({ ownerSub: "user-alice", kind: "assistant" });
  const b1 = await store.createAgent({ ownerSub: "user-bob", kind: "coding" });
  const a2 = await store.createAgent({ ownerSub: "user-alice", kind: "coding" });

  const aliceAgents = await store.listAgentsByOwner("user-alice");
  assert.deepEqual(aliceAgents.map((a) => a.id), [a1.id, a2.id]);

  const bobAgents = await store.listAgentsByOwner("user-bob");
  assert.deepEqual(bobAgents.map((a) => a.id), [b1.id]);

  assert.deepEqual(await store.listAgentsByOwner("user-carol"), []);
});

test("an agent message's promptedBy round-trips via listMessages but is NOT bound into the hash", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
  const agent = await store.createAgent({ ownerSub: "user-alice", kind: "assistant" });

  const m1 = await store.appendMessage({
    channelId: channel.id,
    authorRef: agent.id,
    authorType: "agent",
    promptedBy: "user-alice",
    content: "agent reply",
  });
  assert.equal(m1.promptedBy, "user-alice");

  const listed = await store.listMessages(channel.id);
  const found = listed.find((m) => m.id === m1.id)!;
  assert.equal(found.promptedBy, "user-alice");
  assert.equal(found.content, "agent reply");

  // Recomputing the hash WITHOUT promptedBy still matches -> it isn't a hash input.
  const expectedHash = computeMessageHash(GENESIS, {
    channelId: channel.id,
    seq: m1.seq,
    authorRef: agent.id,
    authorType: "agent",
    contentSha256: m1.contentSha256,
    createdAt: m1.createdAt,
  });
  assert.equal(m1.hash, expectedHash);

  assert.equal((await store.verifyChains()).messagesOk, true);
});

test("redactMessage persists the reason as the last audit event's detail; chain still verifies", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "ssn: 123-45-6789" });

  await store.redactMessage(m1.id, "user-x", "spillage: CUI");

  const events = await store.listAudit();
  const last = events[events.length - 1]!;
  assert.equal(last.action, "message.redact");
  assert.equal(last.detail, "spillage: CUI");
  assert.equal(last.actor, "user-x");
  assert.equal(last.target, m1.id);

  assert.equal((await store.verifyChains()).messagesOk, true);
});

// ── SessionStore ─────────────────────────────────────────────────────────────────────────────

test("createSession -> getSession round-trip; unknown id returns null", async () => {
  const store = new MemoryStore();
  const lease = futureLease();
  const session = await store.createSession({
    agentId: "agent-1",
    channelId: "chan-1",
    hostType: "server",
    status: "starting",
    leaseExpiresAt: lease,
  });
  assert.ok(session.id);
  assert.ok(session.createdAt);
  assert.equal(session.agentId, "agent-1");
  assert.equal(session.channelId, "chan-1");
  assert.equal(session.hostType, "server");
  assert.equal(session.status, "starting");
  assert.equal(session.leaseExpiresAt, lease);

  const fetched = await store.getSession(session.id);
  assert.deepEqual(fetched, session);

  assert.equal(await store.getSession("00000000-0000-4000-8000-000000000000"), null);
});

test("listSessionsByChannel filters by channel and preserves creation order", async () => {
  const store = new MemoryStore();
  const c1 = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
  const c2 = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
  const lease = futureLease();

  const a1 = await store.createSession({ agentId: "agent-1", channelId: c1.id, hostType: "server", status: "starting", leaseExpiresAt: lease });
  const b1 = await store.createSession({ agentId: "agent-2", channelId: c2.id, hostType: "local", status: "starting", leaseExpiresAt: lease });
  const a2 = await store.createSession({ agentId: "agent-1", channelId: c1.id, hostType: "server", status: "active", leaseExpiresAt: lease });

  const c1Sessions = await store.listSessionsByChannel(c1.id);
  assert.deepEqual(c1Sessions.map((s) => s.id), [a1.id, a2.id]);

  const c2Sessions = await store.listSessionsByChannel(c2.id);
  assert.deepEqual(c2Sessions.map((s) => s.id), [b1.id]);

  assert.deepEqual(await store.listSessionsByChannel("00000000-0000-4000-8000-000000000000"), []);
});

test("listActiveSessions includes starting/active and excludes ended/orphaned", async () => {
  const store = new MemoryStore();
  const lease = futureLease();

  const starting = await store.createSession({ agentId: "agent-1", channelId: "chan-1", hostType: "server", status: "starting", leaseExpiresAt: lease });
  const active = await store.createSession({ agentId: "agent-1", channelId: "chan-1", hostType: "server", status: "active", leaseExpiresAt: lease });
  const ended = await store.createSession({ agentId: "agent-1", channelId: "chan-1", hostType: "server", status: "ended", leaseExpiresAt: lease });
  const orphaned = await store.createSession({ agentId: "agent-1", channelId: "chan-1", hostType: "server", status: "orphaned", leaseExpiresAt: lease });

  const activeIds = (await store.listActiveSessions()).map((s) => s.id);
  assert.deepEqual(activeIds, [starting.id, active.id]);
  assert.equal(activeIds.includes(ended.id), false);
  assert.equal(activeIds.includes(orphaned.id), false);
});

test('setSessionStatus updates status and stamps endedAt only on "ended"; unknown id throws', async () => {
  const store = new MemoryStore();
  const session = await store.createSession({
    agentId: "agent-1",
    channelId: "chan-1",
    hostType: "server",
    status: "starting",
    leaseExpiresAt: futureLease(),
  });
  assert.equal(session.endedAt, undefined);

  await store.setSessionStatus(session.id, "active");
  assert.equal((await store.getSession(session.id))?.status, "active");
  assert.equal((await store.getSession(session.id))?.endedAt, undefined);

  await store.setSessionStatus(session.id, "ended");
  const ended = await store.getSession(session.id);
  assert.equal(ended?.status, "ended");
  assert.ok(ended?.endedAt);

  await assert.rejects(() => store.setSessionStatus("00000000-0000-4000-8000-000000000000", "ended"));
});

test("renewLease updates leaseExpiresAt; unknown id throws", async () => {
  const store = new MemoryStore();
  const original = futureLease();
  const session = await store.createSession({
    agentId: "agent-1",
    channelId: "chan-1",
    hostType: "server",
    status: "active",
    leaseExpiresAt: original,
  });

  const renewed = futureLease(120_000);
  await store.renewLease(session.id, renewed);
  assert.equal((await store.getSession(session.id))?.leaseExpiresAt, renewed);

  await assert.rejects(() => store.renewLease("00000000-0000-4000-8000-000000000000", renewed));
});

test("addGrant -> activeGrant -> consumeGrant -> activeGrant undefined; a later addGrant becomes the new active grant", async () => {
  const store = new MemoryStore();
  const session = await store.createSession({
    agentId: "agent-1",
    channelId: "chan-1",
    hostType: "server",
    status: "active",
    leaseExpiresAt: futureLease(),
  });

  assert.equal(await store.activeGrant(session.id), undefined);

  const grant1: ExecuteGrant = { sessionId: session.id, grantedBy: "user-alice", scope: "once", grantedAt: new Date().toISOString() };
  await store.addGrant(grant1);
  assert.deepEqual(await store.activeGrant(session.id), grant1);

  await store.consumeGrant(session.id);
  assert.equal(await store.activeGrant(session.id), undefined);
  assert.equal(grant1.consumed, true); // the stored row was flipped in place, not replaced by a copy

  // No active grant right now -> consumeGrant is a no-op, not a throw.
  await store.consumeGrant(session.id);

  const grant2: ExecuteGrant = {
    sessionId: session.id,
    grantedBy: "user-alice",
    scope: "turn",
    turnId: "turn-1",
    grantedAt: new Date().toISOString(),
  };
  await store.addGrant(grant2);
  assert.deepEqual(await store.activeGrant(session.id), grant2);
});

// ── Admin / audit-review console reads ──────────────────────────────────────────────────────

test("listAudit/listChannels/listAllAgents/listAllSessions return the full set in creation/seq order", async () => {
  const store = new MemoryStore();

  const c1 = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  const c2 = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-bob" });

  // Different owners -> listAllAgents (unfiltered) must differ from listAgentsByOwner.
  const a1 = await store.createAgent({ ownerSub: "user-alice", kind: "assistant" });
  const a2 = await store.createAgent({ ownerSub: "user-bob", kind: "coding" });

  const session = await store.createSession({
    agentId: a2.id,
    channelId: c2.id,
    hostType: "server",
    status: "starting",
    leaseExpiresAt: futureLease(),
  });

  const m1 = await store.appendMessage({ channelId: c1.id, authorRef: "user-alice", authorType: "user", content: "hello" });
  await store.appendAudit({ actor: "user-alice", action: "channel.create", target: c1.id });
  await store.redactMessage(m1.id, "user-alice", "test redaction"); // appends a 2nd audit event internally

  const channels = await store.listChannels();
  assert.deepEqual(channels.map((c) => c.id), [c1.id, c2.id]);

  const agents = await store.listAllAgents();
  assert.deepEqual(agents.map((a) => a.id), [a1.id, a2.id]);
  assert.deepEqual(agents.map((a) => a.ownerSub), ["user-alice", "user-bob"]);

  const sessions = await store.listAllSessions();
  assert.deepEqual(sessions.map((s) => s.id), [session.id]);

  const audit = await store.listAudit();
  assert.deepEqual(audit.map((e) => e.seq), [1, 2]);
  assert.deepEqual(audit.map((e) => e.action), ["channel.create", "message.redact"]);

  assert.equal((await store.verifyChains()).auditOk, true);

  // Snapshots, not live references into the store's internal maps.
  channels.pop();
  agents.pop();
  sessions.pop();
  audit.pop();
  assert.equal((await store.listChannels()).length, 2);
  assert.equal((await store.listAllAgents()).length, 2);
  assert.equal((await store.listAllSessions()).length, 1);
  assert.equal((await store.listAudit()).length, 2);
});
