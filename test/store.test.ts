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
    marking: m1.marking,
    attachmentsSha256: m1.attachmentsSha256,
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

// ── Threads ──────────────────────────────────────────────────────────────────────────────────

test("listThread returns only the replies to that parent, seq order, and doesn't leak into listMessages weirdly", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

  const parent = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "topic" });
  const other = await store.appendMessage({ channelId: channel.id, authorRef: "user-bob", authorType: "user", content: "unrelated top-level" });
  const reply1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-bob", authorType: "user", content: "first reply", parentId: parent.id });
  const reply2 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "second reply", parentId: parent.id });

  assert.equal(reply1.parentId, parent.id);
  assert.equal(other.parentId, undefined);

  const thread = await store.listThread(channel.id, parent.id);
  assert.deepEqual(thread.map((m) => m.id), [reply1.id, reply2.id]); // seq order, exactly the two replies
  assert.deepEqual(thread.map((m) => m.content), ["first reply", "second reply"]);

  // The parent itself and the unrelated top-level message are NOT replies to themselves/parent.
  assert.equal(thread.some((m) => m.id === parent.id), false);
  assert.equal(thread.some((m) => m.id === other.id), false);

  // A thread with no replies is just empty, not an error.
  assert.deepEqual(await store.listThread(channel.id, other.id), []);

  // listMessages is unaffected — still every message, in seq order, unfiltered by parentId.
  const all = await store.listMessages(channel.id);
  assert.deepEqual(all.map((m) => m.id), [parent.id, other.id, reply1.id, reply2.id]);

  assert.equal((await store.verifyChains()).messagesOk, true); // parentId isn't a hash input
});

test("a redacted reply's content is omitted from listThread too, same rule as listMessages", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  const parent = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "topic" });
  const reply = await store.appendMessage({ channelId: channel.id, authorRef: "user-bob", authorType: "user", content: "ssn: 123-45-6789", parentId: parent.id });

  await store.redactMessage(reply.id, "admin-1", "CUI spillage");

  const thread = await store.listThread(channel.id, parent.id);
  assert.equal(thread.length, 1);
  assert.equal("content" in thread[0]!, false);
  assert.ok(thread[0]!.redactedAt);
});

// ── Reactions ────────────────────────────────────────────────────────────────────────────────

test("addReaction is idempotent per (messageId, userSub, emoji); distinct users/emoji each count; removeReaction removes exactly one triple", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  const m = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "shipped it" });

  assert.deepEqual(await store.listReactions(m.id), []);

  await store.addReaction(m.id, "user-alice", "🚀");
  await store.addReaction(m.id, "user-alice", "🚀"); // duplicate -> no-op
  await store.addReaction(m.id, "user-bob", "🚀"); // different user, same emoji -> distinct
  await store.addReaction(m.id, "user-alice", "🎉"); // same user, different emoji -> distinct

  const reactions = await store.listReactions(m.id);
  assert.equal(reactions.length, 3);
  for (const r of reactions) {
    assert.equal(r.messageId, m.id);
    assert.ok(r.at); // ISO timestamp stamped
  }
  assert.ok(reactions.some((r) => r.userSub === "user-alice" && r.emoji === "🚀"));
  assert.ok(reactions.some((r) => r.userSub === "user-bob" && r.emoji === "🚀"));
  assert.ok(reactions.some((r) => r.userSub === "user-alice" && r.emoji === "🎉"));

  await store.removeReaction(m.id, "user-alice", "🚀");
  const afterRemove = await store.listReactions(m.id);
  assert.equal(afterRemove.length, 2);
  assert.equal(afterRemove.some((r) => r.userSub === "user-alice" && r.emoji === "🚀"), false);
  // the other two are untouched
  assert.ok(afterRemove.some((r) => r.userSub === "user-bob" && r.emoji === "🚀"));
  assert.ok(afterRemove.some((r) => r.userSub === "user-alice" && r.emoji === "🎉"));

  // removing something absent is a no-op, not a throw
  await store.removeReaction(m.id, "user-carol", "👀");
  assert.equal((await store.listReactions(m.id)).length, 2);

  assert.equal((await store.verifyChains()).messagesOk, true); // reactions aren't chained at all
});

// ── Read markers / unread counts ────────────────────────────────────────────────────────────

test("unreadCount defaults to everything unread, drops after setLastRead, and is per (channel,user)", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

  const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "a" });
  await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "b" });

  // No read marker set yet -> lastRead defaults to 0 -> everything is unread.
  assert.equal(await store.unreadCount(channel.id, "user-bob"), 2);

  await store.setLastRead(channel.id, "user-bob", m1.seq);
  assert.equal(await store.unreadCount(channel.id, "user-bob"), 1); // only seq 2 is > 1

  const m3 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "c" });
  assert.equal(await store.unreadCount(channel.id, "user-bob"), 2); // seq 2 and seq 3 now

  await store.setLastRead(channel.id, "user-bob", m3.seq);
  assert.equal(await store.unreadCount(channel.id, "user-bob"), 0);

  // A different user's marker is independent -> still fully unread.
  assert.equal(await store.unreadCount(channel.id, "user-carol"), 3);
});

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────

test("createWebhook -> getWebhookByToken round-trips; unknown/empty token returns null", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

  const hook = await store.createWebhook(channel.id, "user-alice");
  assert.ok(hook.id);
  assert.equal(hook.channelId, channel.id);
  assert.equal(hook.createdBy, "user-alice");
  assert.ok(hook.createdAt);
  assert.ok(hook.token && hook.token.length > 10); // strong random secret, not a short/guessable id

  const fetched = await store.getWebhookByToken(hook.token);
  assert.deepEqual(fetched, hook);

  assert.equal(await store.getWebhookByToken("not-a-real-token"), null);
  assert.equal(await store.getWebhookByToken(""), null); // empty token must never match

  // Two webhooks (even on the same channel) mint distinct tokens.
  const hook2 = await store.createWebhook(channel.id, "user-alice");
  assert.notEqual(hook2.token, hook.token);
  assert.equal((await store.getWebhookByToken(hook2.token))?.id, hook2.id);
});

test("listWebhooks is per-channel; deleteWebhook is channel-scoped and idempotent", async () => {
  const store = new MemoryStore();
  const chanA = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  const chanB = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

  const a1 = await store.createWebhook(chanA.id, "user-alice");
  const a2 = await store.createWebhook(chanA.id, "user-bob");
  await store.createWebhook(chanB.id, "user-alice");

  // Only chanA's webhooks (both of them); chanB has its own one.
  assert.deepEqual(new Set((await store.listWebhooks(chanA.id)).map((w) => w.id)), new Set([a1.id, a2.id]));
  assert.equal((await store.listWebhooks(chanB.id)).length, 1);

  // Can't delete a webhook via the wrong channel; the real channel works and kills the token.
  assert.equal(await store.deleteWebhook(chanB.id, a1.id), false);
  assert.equal(await store.deleteWebhook(chanA.id, a1.id), true);
  assert.equal(await store.getWebhookByToken(a1.token), null);
  assert.deepEqual((await store.listWebhooks(chanA.id)).map((w) => w.id), [a2.id]);

  // Deleting the same id again is a clean false (idempotent revoke → 404 at the route).
  assert.equal(await store.deleteWebhook(chanA.id, a1.id), false);
});

test("outbound webhooks: create/list/get/delete are channel-scoped; recordOutboundDelivery stamps last*", async () => {
  const store = new MemoryStore();
  const chanA = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
  const chanB = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

  const hook = await store.createOutboundWebhook({
    channelId: chanA.id,
    url: "https://receiver.test/hook",
    events: ["message.created", "channel.marked"],
    includeContent: true,
    createdBy: "user-alice",
  });
  assert.ok(hook.id && hook.secret.length > 10); // a real signing secret, minted server-side
  assert.equal(hook.active, true);
  assert.deepEqual(hook.events, ["message.created", "channel.marked"]);

  // Per-channel listing + channel-scoped get.
  assert.deepEqual((await store.listOutboundWebhooks(chanA.id)).map((w) => w.id), [hook.id]);
  assert.equal((await store.listOutboundWebhooks(chanB.id)).length, 0);
  assert.equal((await store.getOutboundWebhook(chanB.id, hook.id)), null); // wrong channel
  assert.equal((await store.getOutboundWebhook(chanA.id, hook.id))?.id, hook.id);

  // Delivery status is recorded on the row.
  await store.recordOutboundDelivery(hook.id, 502, "bad gateway");
  const after = await store.getOutboundWebhook(chanA.id, hook.id);
  assert.equal(after?.lastStatus, 502);
  assert.equal(after?.lastError, "bad gateway");
  assert.ok(after?.lastDeliveryAt);

  // Channel-scoped, idempotent delete.
  assert.equal(await store.deleteOutboundWebhook(chanB.id, hook.id), false);
  assert.equal(await store.deleteOutboundWebhook(chanA.id, hook.id), true);
  assert.equal(await store.deleteOutboundWebhook(chanA.id, hook.id), false);
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

  assert.equal(await store.activeGrant(session.agentId), undefined);

  const grant1: ExecuteGrant = { agentId: session.agentId, grantedBy: "user-alice", scope: "once", grantedAt: new Date().toISOString() };
  await store.addGrant(grant1);
  assert.deepEqual(await store.activeGrant(session.agentId), grant1);

  await store.consumeGrant(session.agentId);
  assert.equal(await store.activeGrant(session.agentId), undefined);
  assert.equal(grant1.consumed, true); // the stored row was flipped in place, not replaced by a copy

  // No active grant right now -> consumeGrant is a no-op, not a throw.
  await store.consumeGrant(session.agentId);

  const grant2: ExecuteGrant = {
    agentId: session.agentId,
    grantedBy: "user-alice",
    scope: "turn",
    turnId: "turn-1",
    grantedAt: new Date().toISOString(),
  };
  await store.addGrant(grant2);
  assert.deepEqual(await store.activeGrant(session.agentId), grant2);
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

// ── Calls (1:1 DM voice calls — db/migrations/0019_calls.sql) ──────────────────────────────────

async function makeDm(store: MemoryStore) {
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "dm", createdBy: "user-alice" });
  await store.addMember({ channelId: channel.id, memberRef: "user-alice", memberType: "user", role: "member" });
  await store.addMember({ channelId: channel.id, memberRef: "user-bob", memberType: "user", role: "member" });
  return channel;
}

test("createCall: stamps startedAt, defaults recording to 'none', consent/mode fixed as given", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);

  const call = await store.createCall({ channelId: channel.id, caller: "user-alice", callee: "user-bob", consent: true, mode: "relayed" });

  assert.ok(call.id);
  assert.equal(call.channelId, channel.id);
  assert.equal(call.caller, "user-alice");
  assert.equal(call.callee, "user-bob");
  assert.ok(call.startedAt);
  assert.equal(call.endedAt, undefined);
  assert.equal(call.consent, true);
  assert.equal(call.mode, "relayed");
  assert.equal(call.recording, "none");
  assert.equal(call.recordingAttachmentId, undefined);
  assert.equal(call.transcriptMessageId, undefined);

  assert.deepEqual(await store.getCall(call.id), call);
});

test("endCall: stamps endedAt; unknown id fails closed", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);
  const call = await store.createCall({ channelId: channel.id, caller: "user-alice", callee: "user-bob", consent: false, mode: "p2p" });

  const endedAt = new Date().toISOString();
  const ended = await store.endCall(call.id, endedAt);
  assert.equal(ended.endedAt, endedAt);
  assert.equal((await store.getCall(call.id))?.endedAt, endedAt);

  await assert.rejects(() => store.endCall("no-such-call", endedAt));
});

test("setCallRecording / setCallMediadSessionId / setCallRecordingAttachment / setCallTranscriptMessage mutate the row in place", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);
  const call = await store.createCall({ channelId: channel.id, caller: "user-alice", callee: "user-bob", consent: true, mode: "relayed" });
  assert.equal(call.mediadSessionId, undefined, "unset until accept()'s createSession succeeds");

  const recording = await store.setCallRecording(call.id, "on");
  assert.equal(recording.recording, "on");
  assert.equal((await store.getCall(call.id))?.recording, "on");

  const withSession = await store.setCallMediadSessionId(call.id, "sess-abc");
  assert.equal(withSession.mediadSessionId, "sess-abc");
  assert.equal((await store.getCall(call.id))?.mediadSessionId, "sess-abc");

  const withAttachment = await store.setCallRecordingAttachment(call.id, "att-1");
  assert.equal(withAttachment.recordingAttachmentId, "att-1");

  const withTranscript = await store.setCallTranscriptMessage(call.id, "msg-1");
  assert.equal(withTranscript.transcriptMessageId, "msg-1");

  const final = await store.getCall(call.id);
  assert.equal(final?.recording, "on");
  assert.equal(final?.mediadSessionId, "sess-abc");
  assert.equal(final?.recordingAttachmentId, "att-1");
  assert.equal(final?.transcriptMessageId, "msg-1");

  await assert.rejects(() => store.setCallRecording("no-such-call", "on"));
  await assert.rejects(() => store.setCallMediadSessionId("no-such-call", "sess-x"));
  await assert.rejects(() => store.setCallRecordingAttachment("no-such-call", "att-1"));
  await assert.rejects(() => store.setCallTranscriptMessage("no-such-call", "msg-1"));
});

test("listUnclaimedEndedCalls: only ENDED calls with no recordingAttachmentId yet — the reconciliation candidate set", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);

  // Still ringing/active in the durable sense (no endedAt) — never a candidate.
  const stillActive = await store.createCall({ channelId: channel.id, caller: "user-alice", callee: "user-bob", consent: true, mode: "relayed" });

  // Ended, unrecorded (p2p) — never had a recording to reconcile.
  const p2p = await store.createCall({ channelId: channel.id, caller: "user-alice", callee: "user-bob", consent: false, mode: "p2p" });
  await store.endCall(p2p.id, new Date().toISOString());

  // Ended, relayed, recording never claimed — the reconciliation target.
  const unclaimed = await store.createCall({ channelId: channel.id, caller: "user-alice", callee: "user-bob", consent: true, mode: "relayed" });
  await store.endCall(unclaimed.id, new Date().toISOString());

  // Ended, relayed, recording ALREADY claimed — done, not a candidate.
  const claimed = await store.createCall({ channelId: channel.id, caller: "user-alice", callee: "user-bob", consent: true, mode: "relayed" });
  await store.endCall(claimed.id, new Date().toISOString());
  await store.setCallRecordingAttachment(claimed.id, "att-done");

  const candidates = await store.listUnclaimedEndedCalls();
  assert.deepEqual(candidates.map((c) => c.id).sort(), [p2p.id, unclaimed.id].sort());
  assert.ok(!candidates.some((c) => c.id === stillActive.id));
  assert.ok(!candidates.some((c) => c.id === claimed.id));
});
