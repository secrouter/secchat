// EXIT TEST — message pagination (F1). GET /channels/:id/messages supports cursor paging:
// `?limit=N` returns the most recent N (ascending), `?before=<seq>` walks older pages, and the
// response carries `nextCursor` (the seq to pass as the next `before`, or null at the start). With no
// `limit` the route keeps its legacy bare-array shape, so existing clients are unaffected. Real
// MemoryStore + real HTTP.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Channel, Message, Store, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  if (token === "alice") return { sub: "alice", groups: [] };
  throw new Error("invalid token");
};

const h = { authorization: "Bearer alice", "content-type": "application/json" };

async function withServer(fn: (base: string, store: Store) => Promise<void>): Promise<void> {
  const store = new MemoryStore();
  const server = createHttpServer({ verifyToken, store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

interface Page {
  messages: Array<Message & { reactions: unknown[] }>;
  nextCursor: number | null;
}
const getPage = async (base: string, channelId: string, query: string): Promise<Page> =>
  (await (await fetch(`${base}/channels/${channelId}/messages?${query}`, { headers: h })).json()) as Page;

test("cursor paging: last-N, walk older via nextCursor, and a legacy full array with no limit", async () => {
  await withServer(async (base) => {
    const channel = (await (await fetch(`${base}/channels`, { method: "POST", headers: h, body: JSON.stringify({ name: "general" }) })).json()) as Channel;
    // Seed 25 messages (seq 1..25).
    for (let i = 1; i <= 25; i++) {
      await fetch(`${base}/channels/${channel.id}/messages`, { method: "POST", headers: h, body: JSON.stringify({ content: `m${i}` }) });
    }

    // Page 1 — the most recent 10 (seq 16..25), ascending, cursor back to 16.
    const p1 = await getPage(base, channel.id, "limit=10");
    assert.deepEqual(p1.messages.map((m) => m.seq), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    assert.equal(p1.messages[0]!.content, "m16", "content rides along, ascending");
    assert.equal(p1.nextCursor, 16);

    // Page 2 — the previous 10 (seq 6..15), cursor back to 6.
    const p2 = await getPage(base, channel.id, "limit=10&before=16");
    assert.deepEqual(p2.messages.map((m) => m.seq), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    assert.equal(p2.nextCursor, 6);

    // Page 3 — only 5 left (seq 1..5), a short page ⇒ end of history (nextCursor null).
    const p3 = await getPage(base, channel.id, "limit=10&before=6");
    assert.deepEqual(p3.messages.map((m) => m.seq), [1, 2, 3, 4, 5]);
    assert.equal(p3.nextCursor, null);

    // No `limit` ⇒ the legacy shape: a bare array of all 25, ascending.
    const all = (await (await fetch(`${base}/channels/${channel.id}/messages`, { headers: h })).json()) as Message[];
    assert.ok(Array.isArray(all));
    assert.equal(all.length, 25);
    assert.deepEqual([all[0]!.seq, all[24]!.seq], [1, 25]);
  });
});

test("a limit larger than the channel returns everything with a null cursor", async () => {
  await withServer(async (base) => {
    const channel = (await (await fetch(`${base}/channels`, { method: "POST", headers: h, body: JSON.stringify({ name: "small" }) })).json()) as Channel;
    for (let i = 1; i <= 3; i++) {
      await fetch(`${base}/channels/${channel.id}/messages`, { method: "POST", headers: h, body: JSON.stringify({ content: `m${i}` }) });
    }
    const page = await getPage(base, channel.id, "limit=50");
    assert.deepEqual(page.messages.map((m) => m.seq), [1, 2, 3]);
    assert.equal(page.nextCursor, null, "fewer than a full page ⇒ no older cursor");
  });
});
