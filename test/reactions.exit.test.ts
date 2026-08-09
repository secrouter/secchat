// Sprint 14 EXIT TESTS — message reactions surfaced to the client: access-controlled by the
// reacted-to message's channel, enriched into the message-history response, and broadcast live.
// Runs the real MemoryStore behind the real HTTP layer with a capturing broadcast.

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

interface Ev {
  channelId: string;
  payload: { type?: string; op?: string; messageId?: string; emoji?: string; userSub?: string };
}

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

// alice creates a channel and posts one message.
async function seed(base: string): Promise<{ channel: Channel; message: Message }> {
  const channel = (await (
    await fetch(`${base}/channels`, { method: "POST", headers: h("alice"), body: JSON.stringify({ name: "general" }) })
  ).json()) as Channel;
  const message = (await (
    await fetch(`${base}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: h("alice"),
      body: JSON.stringify({ content: "react to me" }),
    })
  ).json()) as Message;
  return { channel, message };
}

type MsgWithReactions = Message & { reactions: Array<{ emoji: string; userSub: string }> };

test("a channel member can react; it appears in the message list and fires a live event", async () => {
  await withServer(async (base, events) => {
    const { channel, message } = await seed(base);
    events.length = 0; // drop the post's own `message` event

    const add = await fetch(`${base}/messages/${message.id}/reactions`, {
      method: "POST",
      headers: h("alice"),
      body: JSON.stringify({ emoji: "👍" }),
    });
    assert.equal(add.status, 201);

    const ev = events.find((e) => e.payload.type === "reaction");
    assert.ok(ev, "a reaction event was broadcast");
    assert.equal(ev!.payload.op, "add");
    assert.equal(ev!.channelId, channel.id);
    assert.equal(ev!.payload.emoji, "👍");

    const msgs = (await (await fetch(`${base}/channels/${channel.id}/messages`, { headers: h("alice") })).json()) as MsgWithReactions[];
    const row = msgs.find((m) => m.id === message.id)!;
    assert.equal(row.reactions.length, 1);
    assert.equal(row.reactions[0]!.emoji, "👍");
    assert.equal(row.reactions[0]!.userSub, "alice");
  });
});

test("a non-member cannot react (403) — the ACL is the message's channel, not just being authenticated", async () => {
  await withServer(async (base) => {
    const { message } = await seed(base);
    const res = await fetch(`${base}/messages/${message.id}/reactions`, {
      method: "POST",
      headers: h("bob"), // bob is authenticated but not a member of alice's channel
      body: JSON.stringify({ emoji: "👍" }),
    });
    assert.equal(res.status, 403);
  });
});

test("removing a reaction fires a remove event and clears it from the message list", async () => {
  await withServer(async (base, events) => {
    const { channel, message } = await seed(base);
    await fetch(`${base}/messages/${message.id}/reactions`, { method: "POST", headers: h("alice"), body: JSON.stringify({ emoji: "👍" }) });
    events.length = 0;

    const del = await fetch(`${base}/messages/${message.id}/reactions/${encodeURIComponent("👍")}`, { method: "DELETE", headers: h("alice") });
    assert.equal(del.status, 200);
    assert.ok(events.some((e) => e.payload.type === "reaction" && e.payload.op === "remove"));

    const msgs = (await (await fetch(`${base}/channels/${channel.id}/messages`, { headers: h("alice") })).json()) as MsgWithReactions[];
    assert.equal(msgs.find((m) => m.id === message.id)!.reactions.length, 0);
  });
});
