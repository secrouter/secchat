// T1 EXIT TESTS — @mentions end to end: a message that @-mentions a channel member records a
// DURABLE inbox row (survives reconnect) and fires a LIVE per-user `mention` event, the inbox route
// lists them with the triggering message's content, and marking them seen drops the unseen badge.
// Runs the real MemoryStore behind the real HTTP layer with capturing broadcast + notify.
//
// The mention HANDLE is derived from the DISPLAY NAME ("Bob Reyes" → @bobreyes) — what teammates
// actually see — so these tests seed the directory via /me (from token claims) first, exactly as a
// real client does on load.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Channel, Message, Principal, VerifyToken } from "../src/types.ts";

const PRINCIPALS: Record<string, Principal> = {
  alice: { sub: "alice", displayName: "Alice Ng", groups: [] },
  bob: { sub: "bob", displayName: "Bob Reyes", groups: [] },
  carol: { sub: "carol", displayName: "Carol Diaz", groups: [] },
};

const verifyToken: VerifyToken = async (token) => {
  const p = PRINCIPALS[token];
  if (!p) throw new Error("invalid token");
  return p;
};

const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

interface Notif {
  sub: string;
  payload: { type?: string; channelId?: string; mention?: { content?: string; authorSub?: string; seq?: number; mentionedSub?: string } };
}

async function withServer(fn: (base: string, notifs: Notif[]) => Promise<void>): Promise<void> {
  const store = new MemoryStore();
  const notifs: Notif[] = [];
  const server = createHttpServer({
    verifyToken,
    store,
    notify: (sub, payload) => notifs.push({ sub, payload: payload as Notif["payload"] }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, notifs);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Seed the directory (so display-name handles resolve) and open the alice↔bob DM they share. */
async function seedDm(base: string): Promise<Channel> {
  for (const who of ["alice", "bob", "carol"]) await fetch(`${base}/me`, { headers: h(who) });
  return (await (
    await fetch(`${base}/dm`, { method: "POST", headers: h("alice"), body: JSON.stringify({ user: "bob" }) })
  ).json()) as Channel;
}

const post = (base: string, channelId: string, who: string, content: string) =>
  fetch(`${base}/channels/${channelId}/messages`, { method: "POST", headers: h(who), body: JSON.stringify({ content }) });

test("an @mention of a member records a durable row and fires a live per-user event", async () => {
  await withServer(async (base, notifs) => {
    const dm = await seedDm(base);
    notifs.length = 0;

    const res = await post(base, dm.id, "alice", "@bobreyes standup in 5");
    assert.equal(res.status, 201);
    const message = (await res.json()) as Message;

    // Live: exactly one `mention`, delivered to bob (the mentioned member), never to alice (author).
    const mentionEvents = notifs.filter((n) => n.payload.type === "mention");
    assert.equal(mentionEvents.length, 1);
    const ev = mentionEvents[0]!;
    assert.equal(ev.sub, "bob");
    assert.equal(ev.payload.channelId, dm.id);
    assert.equal(ev.payload.mention?.content, "@bobreyes standup in 5");
    assert.equal(ev.payload.mention?.authorSub, "alice");
    assert.equal(ev.payload.mention?.seq, message.seq);

    // Durable: bob's inbox lists it with the message content; the unseen badge is 1.
    const inbox = (await (await fetch(`${base}/mentions`, { headers: h("bob") })).json()) as {
      mentions: Array<{ content: string; authorSub: string; mentionedSub: string; channelId: string }>;
      unseen: number;
    };
    assert.equal(inbox.unseen, 1);
    assert.equal(inbox.mentions.length, 1);
    assert.equal(inbox.mentions[0]!.content, "@bobreyes standup in 5");
    assert.equal(inbox.mentions[0]!.authorSub, "alice");
    assert.equal(inbox.mentions[0]!.mentionedSub, "bob");
    assert.equal(inbox.mentions[0]!.channelId, dm.id);

    // alice (the author) has no mentions — you never mention yourself.
    const aliceInbox = (await (await fetch(`${base}/mentions`, { headers: h("alice") })).json()) as { unseen: number };
    assert.equal(aliceInbox.unseen, 0);
  });
});

test("marking mentions seen clears the unseen badge (idempotently)", async () => {
  await withServer(async (base) => {
    const dm = await seedDm(base);
    await post(base, dm.id, "alice", "@bobreyes ping one");
    await post(base, dm.id, "alice", "@bobreyes ping two");

    let unseen = (await (await fetch(`${base}/mentions?unseen=1`, { headers: h("bob") })).json()) as { unseen: number; mentions: unknown[] };
    assert.equal(unseen.unseen, 2);
    assert.equal(unseen.mentions.length, 2);

    const seen = (await (await fetch(`${base}/mentions/seen`, { method: "POST", headers: h("bob"), body: "{}" })).json()) as { unseen: number };
    assert.equal(seen.unseen, 0);

    // The unseen-only list is now empty, but the full history still shows both.
    const afterUnseen = (await (await fetch(`${base}/mentions?unseen=1`, { headers: h("bob") })).json()) as { mentions: unknown[] };
    assert.equal(afterUnseen.mentions.length, 0);
    const afterAll = (await (await fetch(`${base}/mentions`, { headers: h("bob") })).json()) as { mentions: unknown[] };
    assert.equal(afterAll.mentions.length, 2);
  });
});

test("@mentioning a non-member is a no-op (you can't notify someone who can't read the channel)", async () => {
  await withServer(async (base, notifs) => {
    const dm = await seedDm(base); // carol is NOT a member of the alice↔bob DM
    notifs.length = 0;

    const res = await post(base, dm.id, "alice", "@caroldiaz look at this");
    assert.equal(res.status, 201);

    assert.equal(notifs.filter((n) => n.payload.type === "mention").length, 0);
    const carolInbox = (await (await fetch(`${base}/mentions`, { headers: h("carol") })).json()) as { unseen: number };
    assert.equal(carolInbox.unseen, 0);
  });
});
