// T4 EXIT TESTS — message pinning: a channel member pins/unpins a message (idempotent), it appears
// in the channel's pinned list enriched with content, non-members are refused, and pin/unpin fire a
// live `pin` event. Real MemoryStore behind the real HTTP layer, capturing broadcast.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Channel, Message, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  if (token === "alice") return { sub: "alice", groups: [] };
  if (token === "bob") return { sub: "bob", groups: [] };
  throw new Error("invalid token");
};

const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

interface Ev { channelId: string; payload: { type?: string; op?: string; messageId?: string } }

async function withServer(fn: (base: string, events: Ev[]) => Promise<void>): Promise<void> {
  const store = new MemoryStore();
  const events: Ev[] = [];
  const server = createHttpServer({
    verifyToken,
    store,
    broadcast: (channelId, payload) => events.push({ channelId, payload: payload as Ev["payload"] }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, events);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function seed(base: string): Promise<{ channel: Channel; message: Message }> {
  const channel = (await (
    await fetch(`${base}/channels`, { method: "POST", headers: h("alice"), body: JSON.stringify({ name: "general" }) })
  ).json()) as Channel;
  const message = (await (
    await fetch(`${base}/channels/${channel.id}/messages`, { method: "POST", headers: h("alice"), body: JSON.stringify({ content: "pin me" }) })
  ).json()) as Message;
  return { channel, message };
}

type Pinned = { messageId: string; content: string | null; authorRef: string; seq: number };
const pins = async (base: string, channelId: string, who: string) =>
  (await (await fetch(`${base}/channels/${channelId}/pins`, { headers: h(who) })).json()) as Pinned[];

test("a member pins a message (idempotently); it appears in the pinned list with content + fires an event", async () => {
  await withServer(async (base, events) => {
    const { channel, message } = await seed(base);
    events.length = 0;

    assert.equal((await fetch(`${base}/messages/${message.id}/pin`, { method: "POST", headers: h("alice") })).status, 201);
    // A re-pin is a no-op (still one pin).
    await fetch(`${base}/messages/${message.id}/pin`, { method: "POST", headers: h("alice") });

    const list = await pins(base, channel.id, "alice");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.messageId, message.id);
    assert.equal(list[0]!.content, "pin me");
    assert.equal(list[0]!.authorRef, "alice");

    assert.ok(events.some((e) => e.payload.type === "pin" && e.payload.op === "pin" && e.channelId === channel.id));
  });
});

test("unpinning removes it from the list and fires an unpin event", async () => {
  await withServer(async (base, events) => {
    const { channel, message } = await seed(base);
    await fetch(`${base}/messages/${message.id}/pin`, { method: "POST", headers: h("alice") });
    events.length = 0;

    assert.equal((await fetch(`${base}/messages/${message.id}/pin`, { method: "DELETE", headers: h("alice") })).status, 200);
    assert.deepEqual(await pins(base, channel.id, "alice"), []);
    assert.ok(events.some((e) => e.payload.type === "pin" && e.payload.op === "unpin"));
  });
});

test("a non-member cannot pin, nor read the pinned list (403)", async () => {
  await withServer(async (base) => {
    const { channel, message } = await seed(base);
    assert.equal((await fetch(`${base}/messages/${message.id}/pin`, { method: "POST", headers: h("bob") })).status, 403);
    assert.equal((await fetch(`${base}/channels/${channel.id}/pins`, { headers: h("bob") })).status, 403);
  });
});

test("a redacted message stays pinned but its content is a null tombstone", async () => {
  await withServer(async (base) => {
    const { channel, message } = await seed(base);
    await fetch(`${base}/messages/${message.id}/pin`, { method: "POST", headers: h("alice") });
    await fetch(`${base}/messages/${message.id}/redact`, { method: "POST", headers: h("alice"), body: JSON.stringify({ reason: "spillage" }) });

    const list = await pins(base, channel.id, "alice");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.content, null);
  });
});
