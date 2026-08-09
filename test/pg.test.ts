// PgStore, exercised against a REAL Postgres (DATABASE_URL) — the same contract test/store.test.ts
// proves against MemoryStore. Skipped entirely when DATABASE_URL isn't set, so `node --test` stays
// green in any environment without a database (CI, a laptop with nothing listening on 5433, etc).
//
// Unlike store.test.ts (a fresh MemoryStore per test — full isolation), this suite resets the
// schema ONCE up front (DROP SCHEMA public CASCADE, then migrate.ts's real migration path) and
// shares one PgStore across every test below. node:test runs tests within a file sequentially by
// default, so there's no cross-test RACE — but there IS cross-test state accumulation (earlier
// tests' rows are still there), so assertions below are scoped to what each test itself created
// (fresh channels/agents/sessions per test, `.some(...)`/subset checks against list results)
// rather than asserting a store-wide list equals exactly one test's rows.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
// `pg` is CommonJS with no "exports" map, so Node's ESM loader can't statically detect `Pool` as
// a named export (see src/store/pg.ts, which only needs `Pool`/`PoolClient` as TYPES and so never
// hits this at runtime) — import the default and destructure, the standard workaround.
import pg from "pg";
import { GENESIS } from "../src/audit/chain.ts";
import { migrate } from "../src/db/migrate.ts";
import { PgStore } from "../src/store/pg.ts";
import type { ExecuteGrant } from "../src/types.ts";

const DATABASE_URL = process.env.DATABASE_URL;

/** ISO timestamp `ms` in the future — a plausible lease expiry for session tests. */
function futureLease(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

const { Pool } = pg;

if (!DATABASE_URL) {
  test("PgStore contract (skipped: DATABASE_URL not set)", { skip: true }, () => {});
} else {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 25 });
  const store = new PgStore(pool);
  const WORKSPACE = "ws-1";

  before(async () => {
    // Start from a blank schema, then build it via the SAME migration path the app uses at boot —
    // this exercises migrate.ts + 0001_init.sql + 0002_parity.sql together, not just PgStore's
    // queries against a hand-built schema.
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
  });

  after(async () => {
    await store.close(); // awaits pool.end()
  });

  test("channel -> members -> messages: listMessages is seq-ordered with content, chain verifies", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", name: "general", createdBy: "user-alice" });
    assert.ok(channel.id);
    assert.ok(channel.createdAt);

    await store.addMember({ channelId: channel.id, memberRef: "user-alice", memberType: "user", role: "owner" });
    await store.addMember({ channelId: channel.id, memberRef: "user-bob", memberType: "user", role: "member" });
    assert.equal(await store.isMember(channel.id, "user-alice"), true);
    assert.equal(await store.isMember(channel.id, "user-carol"), false);
    const members = await store.listMembers(channel.id);
    assert.equal(members.length, 2);
    assert.ok(members.some((m) => m.memberRef === "user-alice" && m.role === "owner"));
    assert.ok(members.some((m) => m.memberRef === "user-bob" && m.role === "member"));

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

  test("getChannel returns null for an unknown id", async () => {
    assert.equal(await store.getChannel(randomUUID()), null);
  });

  test("users directory: upsert (COALESCE keeps profile, groups refresh via text[]), getUser, findDmChannel", async () => {
    const a = `u-${randomUUID()}`;
    const b = `u-${randomUUID()}`;

    const created = await store.upsertUser({ sub: a, email: "a@x.mil", displayName: "A Person", groups: ["eng", "sec"] });
    assert.equal(created.email, "a@x.mil");
    assert.deepEqual(created.groups, ["eng", "sec"]); // Postgres text[] round-trips as a JS array

    // A thin re-observation (a dev token: no email/displayName) preserves the profile, refreshes groups.
    const refreshed = await store.upsertUser({ sub: a, groups: ["eng"] });
    assert.equal(refreshed.email, "a@x.mil"); // COALESCE(EXCLUDED.email, users.email)
    assert.equal(refreshed.displayName, "A Person");
    assert.deepEqual(refreshed.groups, ["eng"]);

    assert.equal((await store.getUser(a))!.email, "a@x.mil");
    assert.equal(await store.getUser(`u-${randomUUID()}`), null);

    await store.upsertUser({ sub: b, groups: [] });

    // findDmChannel: none until a 2-user dm channel with both exists; then order-independent.
    assert.equal(await store.findDmChannel(a, b), null);
    const dm = await store.createChannel({ workspaceId: WORKSPACE, kind: "dm", createdBy: a });
    await store.addMember({ channelId: dm.id, memberRef: a, memberType: "user", role: "owner" });
    await store.addMember({ channelId: dm.id, memberRef: b, memberType: "user", role: "member" });
    assert.equal((await store.findDmChannel(a, b))?.id, dm.id);
    assert.equal((await store.findDmChannel(b, a))?.id, dm.id);

    // A non-dm channel with the same two members must NOT match (the kind guard).
    const grp = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: a });
    await store.addMember({ channelId: grp.id, memberRef: a, memberType: "user", role: "owner" });
    await store.addMember({ channelId: grp.id, memberRef: b, memberType: "user", role: "member" });
    assert.equal((await store.findDmChannel(a, b))?.id, dm.id);
  });

  test("redaction: content is omitted (key absent) from listMessages, but the chain stays intact, and exactly one audit event is appended", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "public" });
    const m2 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "ssn: 123-45-6789" });
    const m3 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "after" });

    const auditBefore = await store.listAudit();
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

    const auditAfter = await store.listAudit();
    assert.equal(auditAfter.length, auditBefore.length + 1); // exactly one event appended
    const last = auditAfter[auditAfter.length - 1]!;
    assert.equal(last.action, "message.redact");
    assert.equal(last.target, m2.id);
    assert.equal(last.detail, "CUI spillage");
    assert.equal(last.actor, "admin-1");

    // Redacting an already-redacted message throws (one-way tombstone).
    await assert.rejects(() => store.redactMessage(m2.id, "admin-1", "again"));
  });

  test("listThread returns only the replies to that parent, seq order; redacted replies omit content too", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

    const parent = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "topic" });
    const other = await store.appendMessage({ channelId: channel.id, authorRef: "user-bob", authorType: "user", content: "unrelated top-level" });
    const reply1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-bob", authorType: "user", content: "first reply", parentId: parent.id });
    const reply2 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "second reply", parentId: parent.id });

    assert.equal(reply1.parentId, parent.id);
    assert.equal(other.parentId, undefined);

    const thread = await store.listThread(channel.id, parent.id);
    assert.deepEqual(thread.map((m) => m.id), [reply1.id, reply2.id]);
    assert.deepEqual(thread.map((m) => m.content), ["first reply", "second reply"]);
    assert.equal(thread.some((m) => m.id === parent.id), false);
    assert.equal(thread.some((m) => m.id === other.id), false);
    assert.deepEqual(await store.listThread(channel.id, other.id), []); // no replies -> empty, not an error

    await store.redactMessage(reply1.id, "admin-1", "CUI spillage");
    const threadAfter = await store.listThread(channel.id, parent.id);
    const redactedReply = threadAfter.find((m) => m.id === reply1.id)!;
    assert.equal("content" in redactedReply, false);
    assert.ok(redactedReply.redactedAt);

    assert.equal((await store.verifyChains()).messagesOk, true); // parentId isn't a hash input
  });

  test("an agent message's promptedBy round-trips via listMessages but is NOT bound into the hash", async () => {
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

    assert.equal((await store.verifyChains()).messagesOk, true);
  });

  test("seq/prevHash linkage is independent per channel (each starts at GENESIS)", async () => {
    const c1 = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    const c2 = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });

    const a1 = await store.appendMessage({ channelId: c1.id, authorRef: "user-alice", authorType: "user", content: "c1 first" });
    const b1 = await store.appendMessage({ channelId: c2.id, authorRef: "agent-1", authorType: "agent", content: "c2 first" });

    assert.equal(a1.seq, 1);
    assert.equal(b1.seq, 1);
    assert.equal(a1.prevHash, GENESIS);
    assert.equal(b1.prevHash, GENESIS);
    assert.notEqual(a1.hash, b1.hash);

    assert.equal((await store.verifyChains()).messagesOk, true);
  });

  // ── Reactions ──────────────────────────────────────────────────────────────────────────────

  test("addReaction is idempotent per (messageId, userSub, emoji); distinct users/emoji each count; removeReaction removes exactly one triple", async () => {
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
      assert.ok(r.at);
    }
    assert.ok(reactions.some((r) => r.userSub === "user-alice" && r.emoji === "🚀"));
    assert.ok(reactions.some((r) => r.userSub === "user-bob" && r.emoji === "🚀"));
    assert.ok(reactions.some((r) => r.userSub === "user-alice" && r.emoji === "🎉"));

    await store.removeReaction(m.id, "user-alice", "🚀");
    const afterRemove = await store.listReactions(m.id);
    assert.equal(afterRemove.length, 2);
    assert.equal(afterRemove.some((r) => r.userSub === "user-alice" && r.emoji === "🚀"), false);
    assert.ok(afterRemove.some((r) => r.userSub === "user-bob" && r.emoji === "🚀"));
    assert.ok(afterRemove.some((r) => r.userSub === "user-alice" && r.emoji === "🎉"));

    await store.removeReaction(m.id, "user-carol", "👀"); // absent -> no-op, not a throw
    assert.equal((await store.listReactions(m.id)).length, 2);

    assert.equal((await store.verifyChains()).messagesOk, true); // reactions aren't chained at all
  });

  // ── Read markers / unread counts ──────────────────────────────────────────────────────────

  test("unreadCount defaults to everything unread, drops after setLastRead, and is per (channel,user)", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

    const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "a" });
    await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "b" });

    assert.equal(await store.unreadCount(channel.id, "user-bob"), 2);

    await store.setLastRead(channel.id, "user-bob", m1.seq);
    assert.equal(await store.unreadCount(channel.id, "user-bob"), 1);

    const m3 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "c" });
    assert.equal(await store.unreadCount(channel.id, "user-bob"), 2);

    await store.setLastRead(channel.id, "user-bob", m3.seq);
    assert.equal(await store.unreadCount(channel.id, "user-bob"), 0);

    // setLastRead again (same user/channel) must UPDATE, not duplicate/throw.
    await store.setLastRead(channel.id, "user-bob", m1.seq);
    assert.equal(await store.unreadCount(channel.id, "user-bob"), 2);

    assert.equal(await store.unreadCount(channel.id, "user-carol"), 3); // independent marker
  });

  // ── Webhooks ───────────────────────────────────────────────────────────────────────────────

  test("createWebhook -> getWebhookByToken round-trips; unknown/empty token returns null", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

    const hook = await store.createWebhook(channel.id, "user-alice");
    assert.ok(hook.id);
    assert.equal(hook.channelId, channel.id);
    assert.equal(hook.createdBy, "user-alice");
    assert.ok(hook.createdAt);
    assert.ok(hook.token && hook.token.length > 10);

    const fetched = await store.getWebhookByToken(hook.token);
    assert.deepEqual(fetched, hook);

    assert.equal(await store.getWebhookByToken("not-a-real-token"), null);
    assert.equal(await store.getWebhookByToken(""), null);

    const hook2 = await store.createWebhook(channel.id, "user-alice");
    assert.notEqual(hook2.token, hook.token);
    assert.equal((await store.getWebhookByToken(hook2.token))?.id, hook2.id);
  });

  // ── Agents ─────────────────────────────────────────────────────────────────────────────────

  test("createAgent -> getAgent round-trip; unknown id returns null; listAgentsByOwner/listAllAgents reflect it", async () => {
    const owner = `user-${randomUUID()}`;
    const agent = await store.createAgent({ ownerSub: owner, kind: "assistant", name: "helper", model: "claude-x" });
    assert.ok(agent.id);
    assert.ok(agent.createdAt);
    assert.equal(agent.ownerSub, owner);
    assert.equal(agent.kind, "assistant");
    assert.equal(agent.name, "helper");
    assert.equal(agent.model, "claude-x");

    const fetched = await store.getAgent(agent.id);
    assert.deepEqual(fetched, agent);
    assert.equal(await store.getAgent(randomUUID()), null);

    const owned = await store.listAgentsByOwner(owner);
    assert.deepEqual(owned.map((a) => a.id), [agent.id]);

    const all = await store.listAllAgents();
    assert.ok(all.some((a) => a.id === agent.id));
  });

  // ── SessionStore ───────────────────────────────────────────────────────────────────────────

  test("createSession -> getSession round-trip; unknown id returns null", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
    const agent = await store.createAgent({ ownerSub: "user-alice", kind: "coding" });
    const lease = futureLease();

    const session = await store.createSession({
      agentId: agent.id,
      channelId: channel.id,
      hostType: "server",
      status: "starting",
      leaseExpiresAt: lease,
    });
    assert.ok(session.id);
    assert.ok(session.createdAt);
    assert.equal(session.agentId, agent.id);
    assert.equal(session.channelId, channel.id);
    assert.equal(session.hostType, "server");
    assert.equal(session.status, "starting");
    assert.equal(session.leaseExpiresAt, lease);
    assert.equal(session.runnerId, undefined);
    assert.equal(session.endedAt, undefined);

    const fetched = await store.getSession(session.id);
    assert.deepEqual(fetched, session);
    assert.equal(await store.getSession(randomUUID()), null);
  });

  test("listSessionsByChannel filters by channel and preserves creation order", async () => {
    const c1 = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
    const c2 = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
    const agent = await store.createAgent({ ownerSub: "user-alice", kind: "coding" });
    const lease = futureLease();

    const a1 = await store.createSession({ agentId: agent.id, channelId: c1.id, hostType: "server", status: "starting", leaseExpiresAt: lease });
    const b1 = await store.createSession({ agentId: agent.id, channelId: c2.id, hostType: "local", status: "starting", leaseExpiresAt: lease });
    const a2 = await store.createSession({ agentId: agent.id, channelId: c1.id, hostType: "server", status: "active", leaseExpiresAt: lease });

    const c1Sessions = await store.listSessionsByChannel(c1.id);
    assert.deepEqual(c1Sessions.map((s) => s.id), [a1.id, a2.id]);

    const c2Sessions = await store.listSessionsByChannel(c2.id);
    assert.deepEqual(c2Sessions.map((s) => s.id), [b1.id]);

    assert.deepEqual(await store.listSessionsByChannel(randomUUID()), []);
  });

  test("listActiveSessions includes starting/active and excludes ended/orphaned", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
    const agent = await store.createAgent({ ownerSub: "user-alice", kind: "coding" });
    const lease = futureLease();

    const starting = await store.createSession({ agentId: agent.id, channelId: channel.id, hostType: "server", status: "starting", leaseExpiresAt: lease });
    const active = await store.createSession({ agentId: agent.id, channelId: channel.id, hostType: "server", status: "active", leaseExpiresAt: lease });
    const ended = await store.createSession({ agentId: agent.id, channelId: channel.id, hostType: "server", status: "ended", leaseExpiresAt: lease });
    const orphaned = await store.createSession({ agentId: agent.id, channelId: channel.id, hostType: "server", status: "orphaned", leaseExpiresAt: lease });

    const activeSessions = await store.listActiveSessions();
    const activeIds = activeSessions.map((s) => s.id);
    assert.ok(activeIds.includes(starting.id));
    assert.ok(activeIds.includes(active.id));
    assert.equal(activeIds.includes(ended.id), false);
    assert.equal(activeIds.includes(orphaned.id), false);
    // Relative order among the two we just created is preserved (ins_seq).
    assert.ok(activeIds.indexOf(starting.id) < activeIds.indexOf(active.id));
  });

  test('setSessionStatus updates status and stamps endedAt only on "ended"; unknown id throws', async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
    const agent = await store.createAgent({ ownerSub: "user-alice", kind: "coding" });
    const session = await store.createSession({
      agentId: agent.id,
      channelId: channel.id,
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

    await assert.rejects(() => store.setSessionStatus(randomUUID(), "ended"));
  });

  test("renewLease updates leaseExpiresAt; unknown id throws", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
    const agent = await store.createAgent({ ownerSub: "user-alice", kind: "coding" });
    const session = await store.createSession({
      agentId: agent.id,
      channelId: channel.id,
      hostType: "server",
      status: "active",
      leaseExpiresAt: futureLease(),
    });

    const renewed = futureLease(120_000);
    await store.renewLease(session.id, renewed);
    assert.equal((await store.getSession(session.id))?.leaseExpiresAt, renewed);

    await assert.rejects(() => store.renewLease(randomUUID(), renewed));
  });

  test("addGrant -> activeGrant -> consumeGrant -> activeGrant undefined; a later addGrant becomes the new active grant", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "agent", createdBy: "user-alice" });
    const agent = await store.createAgent({ ownerSub: "user-alice", kind: "coding" });
    const session = await store.createSession({
      agentId: agent.id,
      channelId: channel.id,
      hostType: "server",
      status: "active",
      leaseExpiresAt: futureLease(),
    });

    assert.equal(await store.activeGrant(session.id), undefined);

    const grant1: ExecuteGrant = { sessionId: session.id, grantedBy: "user-alice", scope: "once", grantedAt: new Date().toISOString() };
    await store.addGrant(grant1);
    const active1 = await store.activeGrant(session.id);
    assert.equal(active1?.sessionId, session.id);
    assert.equal(active1?.grantedBy, "user-alice");
    assert.equal(active1?.scope, "once");
    assert.equal(active1?.consumed, false);
    assert.equal(active1?.turnId, undefined);

    await store.consumeGrant(session.id);
    assert.equal(await store.activeGrant(session.id), undefined);

    await store.consumeGrant(session.id); // no active grant -> no-op, not a throw

    const grant2: ExecuteGrant = {
      sessionId: session.id,
      grantedBy: "user-alice",
      scope: "turn",
      turnId: "turn-1",
      grantedAt: new Date().toISOString(),
    };
    await store.addGrant(grant2);
    const active2 = await store.activeGrant(session.id);
    assert.equal(active2?.scope, "turn");
    assert.equal(active2?.turnId, "turn-1");
    assert.equal(active2?.consumed, false);
  });

  // ── Audit chain / admin reads ──────────────────────────────────────────────────────────────

  test("appendAudit forms a verifying chain, seq is contiguous and 1-based; listAudit/listChannels/listAllAgents reflect stored rows", async () => {
    const auditBefore = await store.listAudit();
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

    const e1 = await store.appendAudit({ actor: "user-alice", action: "channel.create", target: channel.id });
    assert.equal(e1.seq, auditBefore.length + 1);
    assert.equal((await store.verifyChains()).auditOk, true);

    const e2 = await store.appendAudit({ actor: "user-alice", action: "noop" });
    assert.equal(e2.seq, e1.seq + 1);
    assert.equal(e2.prevHash, e1.hash);

    const allAudit = await store.listAudit();
    assert.deepEqual(allAudit.map((e) => e.seq), Array.from({ length: allAudit.length }, (_, i) => i + 1)); // gapless, 1-based
    assert.ok(allAudit.some((e) => e.id === e1.id));
    assert.ok(allAudit.some((e) => e.id === e2.id));
    assert.equal((await store.verifyChains()).auditOk, true);

    const channels = await store.listChannels();
    assert.ok(channels.some((c) => c.id === channel.id));

    const agents = await store.listAllAgents();
    const agent = await store.createAgent({ ownerSub: "user-zzz", kind: "assistant" });
    assert.ok((await store.listAllAgents()).length > agents.length);
    assert.ok((await store.listAllAgents()).some((a) => a.id === agent.id));
  });

  // ── Concurrency: the whole point of the advisory-lock design in src/store/pg.ts ─────────────

  test("20 concurrent appendMessage calls on one channel produce a gapless, correctly-linked chain (proves the per-channel advisory lock)", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: `msg ${i}` }),
      ),
    );

    const seqs = results.map((m) => m.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1)); // 1..20, no gaps, no dupes

    const listed = await store.listMessages(channel.id);
    assert.equal(listed.length, N);
    assert.deepEqual(listed.map((m) => m.seq), Array.from({ length: N }, (_, i) => i + 1));

    assert.equal((await store.verifyChains()).messagesOk, true);
  });
}
