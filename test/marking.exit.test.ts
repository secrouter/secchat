// EXIT TESTS — classification MARKING (Track 2a). A channel MAY carry a marking; when it does, the
// channel IS the portion (every message inherits it, none may exceed it). Unmarked channels/DMs mark
// per-message, defaulting to the fail-safe floor. Enforcement is BLOCKING: content above the channel
// ceiling is rejected, and downgrading a channel's level is admin-only. The message marking is bound
// into the hash chain (tamper-evident). Real MemoryStore + a capturing broadcast + a real (custom)
// marking policy + a minimal admin dep.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";
import type { AdminOverview, Channel, Message, Store, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  switch (token) {
    case "alice":
      return { sub: "alice", groups: [] }; // ordinary member
    case "carol":
      return { sub: "carol", groups: ["secchat-admins"] }; // admin (may downgrade)
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

// A deployment ladder with UNCLASSIFIED as the fail-safe default.
const marking = makeMarkingPolicy(["UNCLASSIFIED", "PROPRIETARY", "CUI", "CLASSIFIED"], "UNCLASSIFIED");

const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

interface Ev {
  channelId: string;
  payload: { type?: string; marking?: string; message?: { marking?: string } };
}

async function withServer(fn: (base: string, store: Store, events: Ev[]) => Promise<void>): Promise<void> {
  const store = new MemoryStore();
  const events: Ev[] = [];
  const server = createHttpServer({
    verifyToken,
    store,
    admin,
    marking,
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

const createChannel = (base: string, token: string, body: unknown) =>
  fetch(`${base}/channels`, { method: "POST", headers: h(token), body: JSON.stringify(body) });

const post = (base: string, token: string, channelId: string, body: unknown) =>
  fetch(`${base}/channels/${channelId}/messages`, { method: "POST", headers: h(token), body: JSON.stringify(body) });

const setMarking = (base: string, token: string, channelId: string, mk: unknown) =>
  fetch(`${base}/channels/${channelId}/marking`, { method: "POST", headers: h(token), body: JSON.stringify({ marking: mk }) });

test("GET /me carries the deployment marking ladder + default", async () => {
  await withServer(async (base) => {
    const me = (await (await fetch(`${base}/me`, { headers: h("alice") })).json()) as {
      marking: { levels: string[]; default: string };
    };
    assert.deepEqual(me.marking.levels, ["UNCLASSIFIED", "PROPRIETARY", "CUI", "CLASSIFIED"]);
    assert.equal(me.marking.default, "UNCLASSIFIED");
  });
});

test("an unmarked channel marks PER MESSAGE: default floor, or an explicit level, both chain-bound", async () => {
  await withServer(async (base, store) => {
    const channel = (await (await createChannel(base, "alice", { name: "general" })).json()) as Channel;

    // No marking supplied → the fail-safe default.
    const m1 = (await (await post(base, "alice", channel.id, { content: "hi" })).json()) as Message;
    assert.equal(m1.marking, "UNCLASSIFIED");

    // An explicit per-message level is honored (unmarked channel has no ceiling).
    const m2 = (await (await post(base, "alice", channel.id, { content: "secret-ish", marking: "cui" })).json()) as Message;
    assert.equal(m2.marking, "CUI", "case-insensitive, canonical upper");

    // Both markings are bound into the verifying chain.
    assert.equal((await store.verifyChains()).messagesOk, true);
  });
});

test("a MARKED channel is the portion: every message inherits the channel level", async () => {
  await withServer(async (base, store) => {
    const channel = (await (await createChannel(base, "alice", { name: "cui-room", marking: "CUI" })).json()) as Channel;
    assert.equal(channel.cuiMarking, "CUI");

    // A message with no marking takes the channel level; a LOWER request is still forced up.
    const m1 = (await (await post(base, "alice", channel.id, { content: "in a CUI room" })).json()) as Message;
    assert.equal(m1.marking, "CUI");
    const m2 = (await (await post(base, "alice", channel.id, { content: "tried to under-mark", marking: "UNCLASSIFIED" })).json()) as Message;
    assert.equal(m2.marking, "CUI", "the channel is the portion — under-marking is forced up, not honored");
    assert.equal((await store.verifyChains()).messagesOk, true);
  });
});

test("BLOCKING: a message marked ABOVE the channel ceiling is refused (422 spillage block)", async () => {
  await withServer(async (base, store) => {
    const channel = (await (await createChannel(base, "alice", { name: "cui-room", marking: "CUI" })).json()) as Channel;
    const res = await post(base, "alice", channel.id, { content: "this is classified!", marking: "CLASSIFIED" });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: string }).error, "marking_exceeds_channel");
    // Nothing was written.
    const msgs = (await (await fetch(`${base}/channels/${channel.id}/messages`, { headers: h("alice") })).json()) as Message[];
    assert.equal(msgs.length, 0);
  });
});

test("an unknown marking is rejected (400) on both message post and channel create", async () => {
  await withServer(async (base) => {
    const channel = (await (await createChannel(base, "alice", { name: "general" })).json()) as Channel;
    assert.equal((await post(base, "alice", channel.id, { content: "x", marking: "TICKLISH" })).status, 400);
    assert.equal((await createChannel(base, "alice", { name: "bad", marking: "TICKLISH" })).status, 400);
  });
});

test("setting/raising a channel marking: any member may, it's audited + broadcast live", async () => {
  await withServer(async (base, store, events) => {
    const channel = (await (await createChannel(base, "alice", { name: "general" })).json()) as Channel;

    // Set from unspecified → PROPRIETARY (a member may).
    let res = await setMarking(base, "alice", channel.id, "PROPRIETARY");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Channel).cuiMarking, "PROPRIETARY");

    // Raise PROPRIETARY → CUI (still a member).
    res = await setMarking(base, "alice", channel.id, "CUI");
    assert.equal(res.status, 200);

    // Audited + broadcast.
    const audit = await store.listAudit();
    assert.equal(audit.filter((a) => a.action === "channel.mark" && a.target === channel.id).length, 2);
    assert.ok(events.some((e) => e.payload.type === "channel_marking" && e.payload.marking === "CUI"));

    // A subsequent message inherits the now-CUI channel.
    const m = (await (await post(base, "alice", channel.id, { content: "now cui" })).json()) as Message;
    assert.equal(m.marking, "CUI");
  });
});

test("DOWNGRADE is admin-only: a member is refused (403), an admin (also a member) succeeds", async () => {
  await withServer(async (base, store) => {
    const channel = (await (await createChannel(base, "alice", { name: "cui-room", marking: "CUI" })).json()) as Channel;
    // The security officer is a member too (the marking route is membership-gated for everyone).
    await store.addMember({ channelId: channel.id, memberRef: "carol", memberType: "user", role: "member" });
    // alice (member, not admin) may not lower CUI → PROPRIETARY.
    assert.equal((await setMarking(base, "alice", channel.id, "PROPRIETARY")).status, 403);
    // carol (admin) may.
    const res = await setMarking(base, "carol", channel.id, "PROPRIETARY");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as Channel).cuiMarking, "PROPRIETARY");
  });
});

test("setting a marking on an unknown channel is 404; a non-member is 403", async () => {
  await withServer(async (base, store) => {
    assert.equal((await setMarking(base, "alice", "00000000-0000-0000-0000-000000000000", "CUI")).status, 404);
    // carol is not a member of alice's channel.
    const channel = (await (await createChannel(base, "alice", { name: "general" })).json()) as Channel;
    assert.equal((await setMarking(base, "carol", channel.id, "CUI")).status, 403);
  });
});
