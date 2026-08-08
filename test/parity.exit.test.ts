// Sprint 5 EXIT TESTS — written FIRST (red until the sprint lands). Chat-parity: threads,
// reactions, unread markers, permission-aware search, inbound webhooks. When these pass, done.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../src/http/server.ts";
import { searchMessages } from "../src/search/search.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { VerifyToken } from "../src/types.ts";

const verify: VerifyToken = async (t) => {
  if (t === "alice") return { sub: "alice", groups: [] };
  if (t === "bob") return { sub: "bob", groups: [] };
  throw new Error("bad token");
};

async function channelWith(store: MemoryStore, members: string[], name = "c") {
  const ch = await store.createChannel({ workspaceId: "ws", kind: "human", name, createdBy: members[0]! });
  for (const m of members) await store.addMember({ channelId: ch.id, memberRef: m, memberType: "user", role: "member" });
  return ch;
}

function serverFor(store: MemoryStore) {
  return createHttpServer({ verifyToken: verify, store, search: (u, q) => searchMessages(store, u, q) });
}

test("exit 1 — a reply is threaded under its parent", async () => {
  const store = new MemoryStore();
  const ch = await channelWith(store, ["alice"]);
  const parent = await store.appendMessage({ channelId: ch.id, authorRef: "alice", authorType: "user", content: "topic" });
  await store.appendMessage({ channelId: ch.id, authorRef: "alice", authorType: "user", content: "reply!", parentId: parent.id });
  const thread = await store.listThread(ch.id, parent.id);
  assert.equal(thread.length, 1);
  assert.equal(thread[0]!.content, "reply!");
  assert.equal(thread[0]!.parentId, parent.id);
});

test("exit 2 — reactions are idempotent per (user,emoji) and removable", async () => {
  const store = new MemoryStore();
  const ch = await channelWith(store, ["alice", "bob"]);
  const m = await store.appendMessage({ channelId: ch.id, authorRef: "alice", authorType: "user", content: "nice" });
  await store.addReaction(m.id, "alice", "👍");
  await store.addReaction(m.id, "alice", "👍"); // no-op
  await store.addReaction(m.id, "bob", "👍");
  assert.equal((await store.listReactions(m.id)).length, 2);
  await store.removeReaction(m.id, "alice", "👍");
  assert.equal((await store.listReactions(m.id)).length, 1);
});

test("exit 3 — unread counts messages after the read marker", async () => {
  const store = new MemoryStore();
  const ch = await channelWith(store, ["alice", "bob"]);
  let last = 0;
  for (const t of ["a", "b", "c"]) {
    const m = await store.appendMessage({ channelId: ch.id, authorRef: "alice", authorType: "user", content: t });
    last = m.seq;
  }
  assert.equal(await store.unreadCount(ch.id, "bob"), 3);
  await store.setLastRead(ch.id, "bob", last);
  assert.equal(await store.unreadCount(ch.id, "bob"), 0);
});

test("exit 4 — search returns ONLY messages in channels the user can see (ACL boundary)", async () => {
  const store = new MemoryStore();
  const ch1 = await channelWith(store, ["alice"], "ch1");
  const ch2 = await channelWith(store, ["bob"], "ch2");
  await store.appendMessage({ channelId: ch1.id, authorRef: "alice", authorType: "user", content: "the secret plan is A" });
  await store.appendMessage({ channelId: ch2.id, authorRef: "bob", authorType: "user", content: "the secret plan is B" });
  const asAlice = await searchMessages(store, "alice", "secret");
  assert.equal(asAlice.length, 1);
  assert.equal(asAlice[0]!.channelId, ch1.id); // NEVER ch2 — the security boundary
  const asBob = await searchMessages(store, "bob", "secret");
  assert.equal(asBob.length, 1);
  assert.equal(asBob[0]!.channelId, ch2.id);
});

test("exit 5 — a webhook token posts a chained, audited message; a bad token is 401", async () => {
  const store = new MemoryStore();
  const ch = await channelWith(store, ["alice"]);
  const server = serverFor(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${base}/channels/${ch.id}/webhooks`, {
      method: "POST", headers: { authorization: "Bearer alice", "content-type": "application/json" }, body: "{}",
    });
    assert.equal(created.status, 201);
    const { token } = (await created.json()) as { token: string };
    assert.ok(token && token.length > 10);

    assert.equal((await fetch(`${base}/hooks/nope`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })).status, 401);

    const hook = await fetch(`${base}/hooks/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "deploy finished" }) });
    assert.equal(hook.status, 201);

    const msgs = await store.listMessages(ch.id);
    assert.ok(msgs.some((m) => m.content === "deploy finished"));
    assert.equal((await store.verifyChains()).messagesOk, true);
    assert.ok((await store.listAudit()).some((e) => e.action === "webhook.post"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("exit 6 — reply + react + unread over HTTP", async () => {
  const store = new MemoryStore();
  const ch = await channelWith(store, ["alice"]);
  const server = serverFor(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  const h = { authorization: "Bearer alice", "content-type": "application/json" };
  try {
    const parent = (await (await fetch(`${base}/channels/${ch.id}/messages`, { method: "POST", headers: h, body: JSON.stringify({ content: "topic" }) })).json()) as { id: string };
    assert.equal((await fetch(`${base}/channels/${ch.id}/messages`, { method: "POST", headers: h, body: JSON.stringify({ content: "re", parentId: parent.id }) })).status, 201);
    const thread = (await (await fetch(`${base}/channels/${ch.id}/threads/${parent.id}`, { headers: h })).json()) as unknown[];
    assert.equal(thread.length, 1);
    assert.equal((await fetch(`${base}/messages/${parent.id}/reactions`, { method: "POST", headers: h, body: JSON.stringify({ emoji: "🚀" }) })).status, 201);
    const reactions = (await (await fetch(`${base}/messages/${parent.id}/reactions`, { headers: h })).json()) as unknown[];
    assert.equal(reactions.length, 1);
    const unread = (await (await fetch(`${base}/channels/${ch.id}/unread`, { headers: h })).json()) as { unread: number };
    assert.equal(typeof unread.unread, "number");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
