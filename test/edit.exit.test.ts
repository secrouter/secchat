// EXIT TESTS — trackable message edit (chain-safe revision history). An edit is a NEW revision,
// never an in-place rewrite: the original row (and the per-channel hash chain, which binds the
// ORIGINAL content) is left untouched, the full version history is retained, and an audited
// `message.edit` event records who/when. AUTHOR-ONLY, deliberately narrower than redaction (no
// admin override). Membership-gated; non-empty content required; 409 on a redacted message; and a
// later redaction purges every version's plaintext while the chain still verifies. Real MemoryStore
// + a capturing broadcast + a minimal admin dep (only `adminGroup` is consulted by the routes).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { AdminOverview, Channel, Message, MessageRevision, Store, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  switch (token) {
    case "alice":
      return { sub: "alice", groups: [] }; // author
    case "bob":
      return { sub: "bob", groups: [] }; // member, not the author
    case "carol":
      return { sub: "carol", groups: ["secchat-admins"] }; // admin — still cannot edit another's message
    case "dave":
      return { sub: "dave", groups: [] }; // not a member
    default:
      throw new Error("invalid token");
  }
};

const admin = {
  adminGroup: "secchat-admins",
  overview: async (): Promise<AdminOverview> => ({
    generatedAt: "2026-01-01T00:00:00.000Z",
    channels: [],
    agents: [],
    sessions: [],
    audit: [],
    chains: { messagesOk: true, auditOk: true },
  }),
  renderConsole: () => "",
};

const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

interface Ev {
  channelId: string;
  payload: { type?: string; messageId?: string; by?: string; content?: string; editedAt?: string };
}

async function withServer(fn: (base: string, store: Store, events: Ev[]) => Promise<void>): Promise<void> {
  const store = new MemoryStore();
  const events: Ev[] = [];
  const server = createHttpServer({
    verifyToken,
    store,
    admin,
    broadcast: (channelId, payload) => events.push({ channelId, payload: payload as Ev["payload"] }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store, events);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// alice creates a channel and posts a message; bob and carol are added as members.
async function seed(base: string, store: Store): Promise<{ channel: Channel; message: Message }> {
  const channel = (await (
    await fetch(`${base}/channels`, { method: "POST", headers: h("alice"), body: JSON.stringify({ name: "general" }) })
  ).json()) as Channel;
  await store.addMember({ channelId: channel.id, memberRef: "bob", memberType: "user", role: "member" });
  await store.addMember({ channelId: channel.id, memberRef: "carol", memberType: "user", role: "member" });
  const message = (await (
    await fetch(`${base}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: h("alice"),
      body: JSON.stringify({ content: "the orignal, with a typo" }),
    })
  ).json()) as Message;
  return { channel, message };
}

const edit = (base: string, token: string, id: string, content: unknown) =>
  fetch(`${base}/messages/${id}/edit`, { method: "POST", headers: h(token), body: JSON.stringify({ content }) });

const revisions = (base: string, token: string, id: string) =>
  fetch(`${base}/messages/${id}/revisions`, { headers: h(token) });

test("the author edits: current text updates, history is kept, editedAt is set, and a message.edit is chained — chain still verifies", async () => {
  await withServer(async (base, store, events) => {
    const { channel, message } = await seed(base, store);
    const originalHash = message.hash;
    const originalSha = message.contentSha256;

    const res = await edit(base, "alice", message.id, "the original, typo fixed");
    assert.equal(res.status, 200);

    // The channel history now shows the current text + an editedAt marker.
    const msgs = (await (await fetch(`${base}/channels/${channel.id}/messages`, { headers: h("alice") })).json()) as Array<
      Message & { content?: string }
    >;
    const row = msgs.find((m) => m.id === message.id)!;
    assert.equal(row.content, "the original, typo fixed", "current text is the edit");
    assert.ok(row.editedAt, "editedAt is stamped");

    // The immutable row is untouched: same hash + same ORIGINAL content hash → chain still verifies.
    assert.equal(row.hash, originalHash, "the message hash (over the original) is unchanged");
    assert.equal(row.contentSha256, originalSha, "contentSha256 still binds the ORIGINAL content");
    assert.equal((await store.verifyChains()).messagesOk, true, "the message chain still verifies");

    // Full history: revision 1 (original) + revision 2 (edit).
    const revs = (await (await revisions(base, "alice", message.id)).json()) as { revisions: MessageRevision[] };
    assert.equal(revs.revisions.length, 2);
    assert.equal(revs.revisions[0]!.revision, 1);
    assert.equal(revs.revisions[0]!.content, "the orignal, with a typo", "revision 1 preserves the original");
    assert.equal(revs.revisions[1]!.revision, 2);
    assert.equal(revs.revisions[1]!.content, "the original, typo fixed");

    // The edit is provable + broadcast live.
    const audit = await store.listAudit();
    const evt = audit.find((a) => a.action === "message.edit" && a.target === message.id);
    assert.ok(evt, "a message.edit audit event was chained");
    assert.equal(evt!.actor, "alice");
    assert.ok(
      events.some((e) => e.payload.type === "message_edit" && e.payload.messageId === message.id && e.payload.content === "the original, typo fixed"),
      "a message_edit event carrying the new text was broadcast",
    );
  });
});

test("multiple edits accumulate as ascending revisions", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    assert.equal((await edit(base, "alice", message.id, "second")).status, 200);
    assert.equal((await edit(base, "alice", message.id, "third")).status, 200);
    const revs = (await (await revisions(base, "alice", message.id)).json()) as { revisions: MessageRevision[] };
    assert.deepEqual(
      revs.revisions.map((r) => [r.revision, r.content]),
      [[1, "the orignal, with a typo"], [2, "second"], [3, "third"]],
    );
    assert.equal((await store.verifyChains()).messagesOk, true);
  });
});

test("a member who is not the author cannot edit (403) — and neither can an admin", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    assert.equal((await edit(base, "bob", message.id, "not mine to change")).status, 403);
    // Redaction allows an admin; editing never does — an admin can't put words in a user's mouth.
    assert.equal((await edit(base, "carol", message.id, "as an admin")).status, 403);
  });
});

test("a non-member cannot edit (403)", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    assert.equal((await edit(base, "dave", message.id, "outsider")).status, 403);
  });
});

test("empty content is rejected (400)", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    assert.equal((await edit(base, "alice", message.id, "   ")).status, 400);
  });
});

test("an unknown message is 404", async () => {
  await withServer(async (base) => {
    assert.equal((await edit(base, "alice", "00000000-0000-0000-0000-000000000000", "x")).status, 404);
  });
});

test("editing a redacted message is refused (409)", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    await store.redactMessage(message.id, "alice", "spillage");
    assert.equal((await edit(base, "alice", message.id, "too late")).status, 409);
  });
});

test("redacting an EDITED message purges every version's plaintext, keeping tombstone metadata + a verifying chain", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    await edit(base, "alice", message.id, "revised once");
    await edit(base, "alice", message.id, "revised twice");

    await store.redactMessage(message.id, "carol", "CUI in an old version");

    const revs = (await (await revisions(base, "alice", message.id)).json()) as { revisions: MessageRevision[] };
    assert.equal(revs.revisions.length, 3, "every version's metadata is retained as a tombstone");
    for (const r of revs.revisions) assert.equal(r.content, undefined, "no plaintext survives in any revision");
    assert.equal((await store.verifyChains()).messagesOk, true, "the chain still verifies post-redaction");
  });
});

test("history requires channel membership (a non-member gets 403)", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    assert.equal((await revisions(base, "dave", message.id)).status, 403);
  });
});
