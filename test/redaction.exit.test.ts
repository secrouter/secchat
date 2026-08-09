// Sprint 17 EXIT TESTS — governed message redaction (CUI-spillage / incident purge). The plaintext
// is dropped while the row + content hash + chain links stay (so the chain still verifies) and an
// audited `message.redact` event records who/when/why. Authorized for the AUTHOR or an admin;
// membership-gated; reason required; once. Real MemoryStore + a capturing broadcast + a minimal
// admin dep (only `adminGroup` is consulted by the route).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { AdminOverview, Channel, Message, Store, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  switch (token) {
    case "alice":
      return { sub: "alice", groups: [] }; // author
    case "bob":
      return { sub: "bob", groups: [] }; // member, not author, not admin
    case "carol":
      return { sub: "carol", groups: ["secchat-admins"] }; // admin
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
  payload: { type?: string; messageId?: string; by?: string };
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
      body: JSON.stringify({ content: "pasted the CUI doc here by mistake" }),
    })
  ).json()) as Message;
  return { channel, message };
}

const redact = (base: string, token: string, id: string, reason: unknown) =>
  fetch(`${base}/messages/${id}/redact`, { method: "POST", headers: h(token), body: JSON.stringify({ reason }) });

test("the author redacts their own: content is purged, a redaction event fires, and the audit records who/why", async () => {
  await withServer(async (base, store, events) => {
    const { channel, message } = await seed(base, store);

    const res = await redact(base, "alice", message.id, "CUI spillage — wrong channel");
    assert.equal(res.status, 200);

    // The plaintext is gone from the message list (key absent), but the row remains.
    const msgs = (await (await fetch(`${base}/channels/${channel.id}/messages`, { headers: h("alice") })).json()) as Array<
      Message & { content?: string }
    >;
    const row = msgs.find((m) => m.id === message.id)!;
    assert.ok(row, "the redacted row still exists (a tombstone)");
    assert.equal(row.content, undefined, "plaintext is purged");

    // A live redaction event was broadcast.
    assert.ok(events.some((e) => e.payload.type === "redaction" && e.payload.messageId === message.id));

    // The purge is provable: an audited message.redact event with the reason.
    const audit = await store.listAudit();
    const evt = audit.find((a) => a.action === "message.redact" && a.target === message.id);
    assert.ok(evt, "a message.redact audit event was chained");
    assert.equal(evt!.actor, "alice");
    assert.equal(evt!.detail, "CUI spillage — wrong channel");

    // The message chain still verifies after redaction.
    assert.equal((await store.verifyChains()).messagesOk, true);
  });
});

test("an admin can redact another user's message", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    const res = await redact(base, "carol", message.id, "security review");
    assert.equal(res.status, 200);
  });
});

test("a member who is neither the author nor an admin cannot redact (403)", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    const res = await redact(base, "bob", message.id, "not my call");
    assert.equal(res.status, 403);
  });
});

test("a non-member cannot redact (403)", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    const res = await redact(base, "dave", message.id, "nope");
    assert.equal(res.status, 403);
  });
});

test("a reason is required (400)", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    const res = await redact(base, "alice", message.id, "   ");
    assert.equal(res.status, 400);
  });
});

test("a message can't be redacted twice (409)", async () => {
  await withServer(async (base, store) => {
    const { message } = await seed(base, store);
    assert.equal((await redact(base, "alice", message.id, "first")).status, 200);
    assert.equal((await redact(base, "alice", message.id, "again")).status, 409);
  });
});
