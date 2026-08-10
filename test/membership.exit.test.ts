// T2 EXIT TESTS — channel membership management: list the roster (member-gated), add / remove /
// change-role (owner-or-admin), with the "a channel always keeps an owner" guard. Real MemoryStore
// behind the real HTTP layer, capturing broadcast + per-user notify.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Channel, Principal, VerifyToken } from "../src/types.ts";

const PRINCIPALS: Record<string, Principal> = {
  alice: { sub: "alice", displayName: "Alice Ng", groups: [] },
  bob: { sub: "bob", displayName: "Bob Reyes", groups: [] },
  carol: { sub: "carol", displayName: "Carol Diaz", groups: [] },
  adm: { sub: "adm", displayName: "Admin", groups: ["secchat-admins"] },
};

const verifyToken: VerifyToken = async (token) => {
  const p = PRINCIPALS[token];
  if (!p) throw new Error("invalid token");
  return p;
};

const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

interface Ev { kind: "broadcast" | "notify"; key: string; payload: { type?: string; op?: string; memberRef?: string; role?: string } }

async function withServer(fn: (base: string, events: Ev[]) => Promise<void>): Promise<void> {
  const store = new MemoryStore();
  const events: Ev[] = [];
  const server = createHttpServer({
    verifyToken,
    store,
    admin: { adminGroup: "secchat-admins", overview: () => Promise.resolve({} as never), renderConsole: () => "" },
    broadcast: (key, payload) => events.push({ kind: "broadcast", key, payload: payload as Ev["payload"] }),
    notify: (key, payload) => events.push({ kind: "notify", key, payload: payload as Ev["payload"] }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, events);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** alice creates a channel (she becomes its owner). */
async function seedChannel(base: string): Promise<Channel> {
  return (await (
    await fetch(`${base}/channels`, { method: "POST", headers: h("alice"), body: JSON.stringify({ name: "eng" }) })
  ).json()) as Channel;
}

type MemberRow = { memberRef: string; role: string; memberType: string; displayName?: string };
const members = async (base: string, channelId: string, who: string) =>
  (await (await fetch(`${base}/channels/${channelId}/members`, { headers: h(who) })).json()) as MemberRow[];

test("an owner adds a member; it appears in the roster (enriched) and fires membership events", async () => {
  await withServer(async (base, events) => {
    await fetch(`${base}/me`, { headers: h("bob") }); // seed bob's directory row so the roster enriches
    const ch = await seedChannel(base);
    events.length = 0;

    const add = await fetch(`${base}/channels/${ch.id}/members`, {
      method: "POST",
      headers: h("alice"),
      body: JSON.stringify({ user: "bob" }),
    });
    assert.equal(add.status, 201);

    const roster = await members(base, ch.id, "alice");
    const bob = roster.find((m) => m.memberRef === "bob")!;
    assert.equal(bob.role, "member");
    assert.equal(bob.displayName, "Bob Reyes"); // enriched from the directory

    // A channel `membership` broadcast AND a per-user notify to bob (so his channel list refreshes).
    assert.ok(events.some((e) => e.kind === "broadcast" && e.payload.type === "membership" && e.payload.op === "add"));
    assert.ok(events.some((e) => e.kind === "notify" && e.key === "bob" && e.payload.op === "add"));
  });
});

test("a non-owner member cannot add or remove members (403)", async () => {
  await withServer(async (base) => {
    const ch = await seedChannel(base);
    await fetch(`${base}/channels/${ch.id}/members`, { method: "POST", headers: h("alice"), body: JSON.stringify({ user: "bob" }) });

    // bob is a plain member — he can SEE the roster but not change it.
    assert.equal((await fetch(`${base}/channels/${ch.id}/members`, { headers: h("bob") })).status, 200);
    const addByBob = await fetch(`${base}/channels/${ch.id}/members`, { method: "POST", headers: h("bob"), body: JSON.stringify({ user: "carol" }) });
    assert.equal(addByBob.status, 403);
    const rmByBob = await fetch(`${base}/channels/${ch.id}/members/alice`, { method: "DELETE", headers: h("bob") });
    assert.equal(rmByBob.status, 403);
  });
});

test("role upsert promotes/demotes; the last owner can neither be demoted nor removed", async () => {
  await withServer(async (base) => {
    const ch = await seedChannel(base);
    await fetch(`${base}/channels/${ch.id}/members`, { method: "POST", headers: h("alice"), body: JSON.stringify({ user: "bob" }) });

    // Promote bob to owner (POST upsert on an existing member → 200).
    const promote = await fetch(`${base}/channels/${ch.id}/members`, { method: "POST", headers: h("alice"), body: JSON.stringify({ user: "bob", role: "owner" }) });
    assert.equal(promote.status, 200);
    assert.equal((await members(base, ch.id, "alice")).find((m) => m.memberRef === "bob")!.role, "owner");

    // Now there are two owners; alice can be demoted.
    assert.equal((await fetch(`${base}/channels/${ch.id}/members`, { method: "POST", headers: h("alice"), body: JSON.stringify({ user: "alice", role: "member" }) })).status, 200);

    // bob is now the SOLE owner — demoting or removing him is blocked (409).
    const demote = await fetch(`${base}/channels/${ch.id}/members`, { method: "POST", headers: h("bob"), body: JSON.stringify({ user: "bob", role: "member" }) });
    assert.equal(demote.status, 409);
    const remove = await fetch(`${base}/channels/${ch.id}/members/bob`, { method: "DELETE", headers: h("bob") });
    assert.equal(remove.status, 409);
  });
});

test("an admin who isn't a member can still manage membership; removal fires events", async () => {
  await withServer(async (base, events) => {
    const ch = await seedChannel(base);
    await fetch(`${base}/channels/${ch.id}/members`, { method: "POST", headers: h("alice"), body: JSON.stringify({ user: "bob" }) });
    events.length = 0;

    // adm is not a member of the channel but is a platform admin.
    const rm = await fetch(`${base}/channels/${ch.id}/members/bob`, { method: "DELETE", headers: h("adm") });
    assert.equal(rm.status, 200);
    assert.equal((await members(base, ch.id, "alice")).some((m) => m.memberRef === "bob"), false);
    assert.ok(events.some((e) => e.kind === "notify" && e.key === "bob" && e.payload.op === "remove"));
  });
});
