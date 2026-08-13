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

  test("listMessages cursor paging: DESC+LIMIT query, reversed to ascending, walked via `before`", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    await store.addMember({ channelId: channel.id, memberRef: "user-alice", memberType: "user", role: "owner" });
    for (let i = 1; i <= 12; i++) {
      await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: `m${i}` });
    }
    // Most recent 5 (seq 8..12), ascending, with content joined in.
    const p1 = await store.listMessages(channel.id, { limit: 5 });
    assert.deepEqual(p1.map((m) => m.seq), [8, 9, 10, 11, 12]);
    assert.deepEqual(p1.map((m) => m.content), ["m8", "m9", "m10", "m11", "m12"]);
    // The previous page (seq < 8).
    const p2 = await store.listMessages(channel.id, { limit: 5, before: p1[0]!.seq });
    assert.deepEqual(p2.map((m) => m.seq), [3, 4, 5, 6, 7]);
    // Unbounded still returns everything, ascending.
    assert.equal((await store.listMessages(channel.id)).length, 12);
  });

  test("attachments: unclaimed upload → claim → listed in ins_seq order; byte_size round-trips as a number", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    await store.addMember({ channelId: channel.id, memberRef: "user-alice", memberType: "user", role: "owner" });
    const mk = (sha: string, filename: string, size: number) => ({
      channelId: channel.id, uploadedBy: "user-alice", filename, contentType: "application/pdf",
      byteSize: size, sha256: sha, marking: "CUI",
    });
    const a1 = await store.addAttachment(mk("1".repeat(64), "one.pdf", 1024));
    const a2 = await store.addAttachment(mk("2".repeat(64), "two.pdf", 2048));
    assert.equal(a1.messageId, undefined);
    assert.equal(a1.byteSize, 1024);
    assert.equal(typeof a1.byteSize, "number", "bigint column read back as a JS number");
    assert.deepEqual(await store.listAttachmentsForChannel(channel.id), [], "unclaimed → not in the channel list");

    const msg = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "docs", attachmentsSha256: "f".repeat(64) });
    const claimed = await store.claimAttachments(msg.id, [a1.id, a2.id]);
    assert.deepEqual(claimed.map((a) => a.filename), ["one.pdf", "two.pdf"], "returned in upload (ins_seq) order");
    assert.equal(msg.attachmentsSha256, "f".repeat(64));
    assert.deepEqual((await store.listAttachmentsForMessage(msg.id)).map((a) => a.filename), ["one.pdf", "two.pdf"]);
    assert.deepEqual((await store.listAttachmentsForChannel(channel.id)).map((a) => a.sha256), ["1".repeat(64), "2".repeat(64)]);
    assert.equal((await store.verifyChains()).messagesOk, true);
  });

  test("hasLiveAttachmentReference: refcounts a deduped sha across unclaimed uploads + unredacted messages", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    await store.addMember({ channelId: channel.id, memberRef: "user-alice", memberType: "user", role: "owner" });
    const SHA = "a".repeat(64);
    const mk = (filename: string) => ({
      channelId: channel.id, uploadedBy: "user-alice", filename, contentType: "text/plain",
      byteSize: 5, sha256: SHA, marking: "CUI",
    });

    // Two messages carrying the same sha + one unclaimed upload of it.
    const a1 = await store.addAttachment(mk("one.txt"));
    const a2 = await store.addAttachment(mk("two.txt"));
    const a3 = await store.addAttachment(mk("unclaimed.txt"));
    const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "m1" });
    const m2 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "m2" });
    await store.claimAttachments(m1.id, [a1.id]);
    await store.claimAttachments(m2.id, [a2.id]);

    // From m1's perspective: m2 (unredacted) and the unclaimed upload both keep the sha live.
    assert.equal(await store.hasLiveAttachmentReference(SHA, m1.id), true);

    // Redact m2 → the unclaimed upload alone still keeps it live.
    await store.redactMessage(m2.id, "user-alice", "spill");
    assert.equal(await store.hasLiveAttachmentReference(SHA, m1.id), true);

    // Claim the last upload onto m1 itself → nothing OUTSIDE m1 references the sha anymore.
    await store.claimAttachments(m1.id, [a3.id]);
    assert.equal(await store.hasLiveAttachmentReference(SHA, m1.id), false);
    // …and an unrelated sha was never live.
    assert.equal(await store.hasLiveAttachmentReference("b".repeat(64), m1.id), false);
  });

  test("mentions: recorded once per (message,user), newest-first + enriched, seen-marking, redacted ⇒ null content", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", name: "standup", createdBy: "user-alice" });
    await store.addMember({ channelId: channel.id, memberRef: "user-alice", memberType: "user", role: "owner" });
    const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "@bob first" });
    const m2 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "@bob second" });

    await store.addMention({ messageId: m1.id, channelId: channel.id, mentionedSub: "user-bob", authorSub: "user-alice" });
    await store.addMention({ messageId: m2.id, channelId: channel.id, mentionedSub: "user-bob", authorSub: "user-alice" });
    // Idempotent per (message, recipient) — the unique index makes a re-resolve a no-op.
    await store.addMention({ messageId: m1.id, channelId: channel.id, mentionedSub: "user-bob", authorSub: "user-alice" });

    assert.equal(await store.countUnseenMentions("user-bob"), 2);
    const list = await store.listMentionsForUser("user-bob");
    assert.deepEqual(list.map((x) => x.content), ["@bob second", "@bob first"], "newest first, enriched with content");
    assert.equal(list[0]!.seq, m2.seq);
    assert.equal(list[0]!.channelName, "standup");
    assert.equal(list[0]!.authorSub, "user-alice");

    // Mark just the newest seen (by id): unseen drops to 1, and the unseen-only list holds only m1.
    const changed = await store.markMentionsSeen("user-bob", [list[0]!.id]);
    assert.equal(changed, 1);
    assert.equal(await store.countUnseenMentions("user-bob"), 1);
    assert.deepEqual((await store.listMentionsForUser("user-bob", { unseenOnly: true })).map((x) => x.content), ["@bob first"]);

    // Redacting the message tombstones its mention's content (who/where/when survive).
    await store.redactMessage(m1.id, "admin", "spillage");
    const afterRedact = await store.listMentionsForUser("user-bob");
    const forM1 = afterRedact.find((x) => x.messageId === m1.id)!;
    assert.equal(forM1.content, null);
    assert.equal(forM1.mentionedSub, "user-bob");
  });

  test("membership: addMember upserts role, setMemberRole updates, removeMember deletes (idempotently)", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    await store.addMember({ channelId: channel.id, memberRef: "user-alice", memberType: "user", role: "owner" });
    await store.addMember({ channelId: channel.id, memberRef: "user-bob", memberType: "user", role: "member" });

    // addMember on an existing ref updates the role rather than duplicating (ON CONFLICT).
    await store.addMember({ channelId: channel.id, memberRef: "user-bob", memberType: "user", role: "owner" });
    let roster = await store.listMembers(channel.id);
    assert.equal(roster.filter((m) => m.memberRef === "user-bob").length, 1);
    assert.equal(roster.find((m) => m.memberRef === "user-bob")!.role, "owner");

    // setMemberRole returns the updated row; unknown member ⇒ null.
    const updated = await store.setMemberRole(channel.id, "user-bob", "member");
    assert.equal(updated!.role, "member");
    assert.equal(await store.setMemberRole(channel.id, "nobody", "member"), null);

    // removeMember reports whether it removed a row; a second remove is a no-op.
    assert.equal(await store.removeMember(channel.id, "user-bob"), true);
    assert.equal(await store.removeMember(channel.id, "user-bob"), false);
    roster = await store.listMembers(channel.id);
    assert.deepEqual(roster.map((m) => m.memberRef), ["user-alice"]);
    assert.equal(await store.isMember(channel.id, "user-bob"), false);
  });

  test("pins: idempotent pin (keeps original pinner), newest-first list enriched, unpin, redacted ⇒ null", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    const m1 = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "first" });
    const m2 = await store.appendMessage({ channelId: channel.id, authorRef: "user-bob", authorType: "user", content: "second" });

    await store.pinMessage(channel.id, m1.id, "user-alice");
    await store.pinMessage(channel.id, m2.id, "user-bob");
    // A re-pin keeps the ORIGINAL pinner (ON CONFLICT DO nothing-meaningful).
    const rePin = await store.pinMessage(channel.id, m1.id, "user-carol");
    assert.equal(rePin.pinnedBy, "user-alice");

    const list = await store.listPinnedMessages(channel.id);
    assert.deepEqual(list.map((p) => p.messageId), [m2.id, m1.id], "newest pin first");
    assert.equal(list[0]!.content, "second");
    assert.equal(list[0]!.authorRef, "user-bob");
    assert.equal(list[0]!.seq, m2.seq);

    assert.equal(await store.unpinMessage(m2.id), true);
    assert.equal(await store.unpinMessage(m2.id), false); // second unpin is a no-op
    assert.deepEqual((await store.listPinnedMessages(channel.id)).map((p) => p.messageId), [m1.id]);

    // Redacting a pinned message keeps the pin but nulls its content.
    await store.redactMessage(m1.id, "admin", "spillage");
    const afterRedact = await store.listPinnedMessages(channel.id);
    assert.equal(afterRedact[0]!.content, null);
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

  test("user ssh keys: set (upsert-replaces on sub), get (incl. encrypted private), delete (0011)", async () => {
    const sub = `u-${randomUUID()}`;
    assert.equal(await store.getUserSshKey(sub), null);
    assert.equal(await store.deleteUserSshKey(sub), false); // nothing to delete yet

    await store.setUserSshKey({
      sub,
      keyType: "ssh-ed25519",
      publicKey: "ssh-ed25519 AAAAC3Nza... a@x.mil",
      fingerprint: "SHA256:aaaa",
      privateKeyEnc: "v1.iv.tag.ct",
      createdAt: new Date().toISOString(),
    });
    const got = await store.getUserSshKey(sub);
    assert.ok(got);
    assert.equal(got!.fingerprint, "SHA256:aaaa");
    assert.equal(got!.privateKeyEnc, "v1.iv.tag.ct"); // the encrypted envelope round-trips through pg

    // Regenerate: same sub, new material REPLACES the row (ON CONFLICT upsert — one key per user).
    await store.setUserSshKey({
      sub,
      keyType: "ssh-ed25519",
      publicKey: "ssh-ed25519 BBBB... a@x.mil",
      fingerprint: "SHA256:bbbb",
      privateKeyEnc: "v1.iv2.tag2.ct2",
      createdAt: new Date().toISOString(),
    });
    const replaced = await store.getUserSshKey(sub);
    assert.equal(replaced!.fingerprint, "SHA256:bbbb");
    assert.equal(replaced!.privateKeyEnc, "v1.iv2.tag2.ct2");

    assert.equal(await store.deleteUserSshKey(sub), true);
    assert.equal(await store.getUserSshKey(sub), null);
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

  test("editMessage keeps history + leaves the chain untouched; listRevisions is ordered; redaction purges every version", async () => {
    const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    const m = await store.appendMessage({ channelId: channel.id, authorRef: "user-alice", authorType: "user", content: "the orignal" });
    const originalHash = m.hash;
    const originalSha = m.contentSha256;

    // Un-edited: exactly one synthesized revision (the original) and no editedAt.
    const rev0 = await store.listRevisions(m.id);
    assert.deepEqual(rev0.map((r) => [r.revision, r.content]), [[1, "the orignal"]]);
    assert.equal((await store.listMessages(channel.id)).find((x) => x.id === m.id)!.editedAt, undefined);

    const updated = await store.editMessage(m.id, "user-alice", "the original, fixed");
    assert.ok(updated.editedAt, "editMessage stamps editedAt");
    await store.editMessage(m.id, "user-alice", "the original, fixed again");

    // The row (and thus the message chain) is byte-identical; only the out-of-band history grew.
    const listed = await store.listMessages(channel.id);
    const row = listed.find((x) => x.id === m.id)!;
    assert.equal(row.content, "the original, fixed again", "listMessages shows the CURRENT text");
    assert.ok(row.editedAt, "listMessages carries editedAt once edited");
    assert.equal(row.hash, originalHash, "the message hash is unchanged");
    assert.equal(row.contentSha256, originalSha, "contentSha256 still binds the ORIGINAL");
    assert.equal((await store.verifyChains()).messagesOk, true);

    const revs = await store.listRevisions(m.id);
    assert.deepEqual(
      revs.map((r) => [r.revision, r.content]),
      [[1, "the orignal"], [2, "the original, fixed"], [3, "the original, fixed again"]],
    );
    // Each edit chained a message.edit audit event.
    const audit = await store.listAudit();
    assert.equal(audit.filter((a) => a.action === "message.edit" && a.target === m.id).length, 2);

    // Editing a redacted message is refused, and redaction purges plaintext from EVERY revision.
    await store.redactMessage(m.id, "admin-1", "CUI in an old version");
    await assert.rejects(() => store.editMessage(m.id, "user-alice", "too late"));
    const afterRedact = await store.listRevisions(m.id);
    assert.equal(afterRedact.length, 3, "revision metadata is retained as a tombstone trail");
    for (const r of afterRedact) assert.equal(r.content, undefined, "no plaintext survives redaction");
    assert.equal((await store.verifyChains()).messagesOk, true);
  });

  test("marking: stamped at write + chain-bound; a marked channel forces its level; setChannelMarking audits + is immutable per-row", async () => {
    // Unmarked channel → per-message marking (input.marking, defaulting to the floor).
    const open = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    const u = await store.appendMessage({ channelId: open.id, authorRef: "user-alice", authorType: "user", content: "hi" });
    assert.equal(u.marking, "UNCLASSIFIED", "defaults to the floor when unspecified");
    const c = await store.appendMessage({ channelId: open.id, authorRef: "user-alice", authorType: "user", content: "cui", marking: "CUI" });
    assert.equal(c.marking, "CUI");

    // A marked channel IS the portion — every message inherits it (input.marking ignored).
    const room = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice", cuiMarking: "CUI" });
    const inherited = await store.appendMessage({ channelId: room.id, authorRef: "user-alice", authorType: "user", content: "x", marking: "UNCLASSIFIED" });
    assert.equal(inherited.marking, "CUI", "the channel level wins over the request");

    // The marking is bound into the hash chain (both channels verify).
    assert.equal((await store.verifyChains()).messagesOk, true);

    // setChannelMarking updates the level + chains a channel.mark audit event.
    const auditBefore = (await store.listAudit()).length;
    const updated = await store.setChannelMarking(open.id, "PROPRIETARY", "admin-1");
    assert.equal(updated.cuiMarking, "PROPRIETARY");
    const audit = await store.listAudit();
    assert.equal(audit.length, auditBefore + 1);
    assert.equal(audit[audit.length - 1]!.action, "channel.mark");
    assert.equal(audit[audit.length - 1]!.detail, "PROPRIETARY");

    // The message row's marking is immutable — the 0005 guard rejects a direct UPDATE (chain input).
    const pool2 = new Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      await assert.rejects(
        () => pool2.query(`UPDATE messages SET marking = 'UNCLASSIFIED' WHERE id = $1`, [c.id]),
        /append-only/,
      );
    } finally {
      await pool2.end();
    }
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

  test("listWebhooks is per-channel; deleteWebhook is channel-scoped and idempotent", async () => {
    const chanA = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    const chanB = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

    const a1 = await store.createWebhook(chanA.id, "user-alice");
    const a2 = await store.createWebhook(chanA.id, "user-bob");
    await store.createWebhook(chanB.id, "user-alice");

    assert.deepEqual(new Set((await store.listWebhooks(chanA.id)).map((w) => w.id)), new Set([a1.id, a2.id]));
    assert.equal((await store.listWebhooks(chanB.id)).length, 1);

    assert.equal(await store.deleteWebhook(chanB.id, a1.id), false); // wrong channel
    assert.equal(await store.deleteWebhook(chanA.id, a1.id), true);
    assert.equal(await store.getWebhookByToken(a1.token), null);
    assert.deepEqual((await store.listWebhooks(chanA.id)).map((w) => w.id), [a2.id]);
    assert.equal(await store.deleteWebhook(chanA.id, a1.id), false); // idempotent
  });

  test("outbound webhooks: create/list/get/delete channel-scoped; recordOutboundDelivery stamps last*", async () => {
    const chanA = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });
    const chanB = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "user-alice" });

    const hook = await store.createOutboundWebhook({
      channelId: chanA.id,
      url: "https://receiver.test/hook",
      events: ["message.created", "channel.marked"],
      includeContent: true,
      createdBy: "user-alice",
    });
    assert.ok(hook.id && hook.secret.length > 10);
    assert.deepEqual(hook.events, ["message.created", "channel.marked"]);

    assert.deepEqual((await store.listOutboundWebhooks(chanA.id)).map((w) => w.id), [hook.id]);
    assert.equal((await store.getOutboundWebhook(chanB.id, hook.id)), null);
    assert.equal((await store.getOutboundWebhook(chanA.id, hook.id))?.includeContent, true);

    await store.recordOutboundDelivery(hook.id, 502, "bad gateway");
    const after = await store.getOutboundWebhook(chanA.id, hook.id);
    assert.equal(after?.lastStatus, 502);
    assert.equal(after?.lastError, "bad gateway");
    assert.ok(after?.lastDeliveryAt);

    assert.equal(await store.deleteOutboundWebhook(chanB.id, hook.id), false);
    assert.equal(await store.deleteOutboundWebhook(chanA.id, hook.id), true);
    assert.equal(await store.deleteOutboundWebhook(chanA.id, hook.id), false);
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

    // launch_env (0012) round-trips for a coding agent pinned to the pool; absent for one without.
    const pooled = await store.createAgent({ ownerSub: owner, kind: "coding", name: "pool bot", launchEnv: "pool" });
    assert.equal(pooled.launchEnv, "pool");
    assert.equal((await store.getAgent(pooled.id))!.launchEnv, "pool");
    assert.equal(agent.launchEnv, undefined); // the assistant above set none
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
