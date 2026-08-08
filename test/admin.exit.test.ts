// Sprint 4 EXIT TESTS — written FIRST as the definition of done (red until the sprint lands).
// The audit-review console: an admin-gated read API + a server-rendered HTML page that shows the
// suite's state and the verified tamper-evident chains (AU 3.3.5/6). When all of these pass, the
// sprint is done.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAdmin } from "../src/admin/gate.ts";
import { buildOverview } from "../src/admin/overview.ts";
import { renderConsole } from "../src/admin/console.ts";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { AdminOverview, VerifyToken } from "../src/types.ts";

const ADMIN_GROUP = "secchat-admins";

const verify: VerifyToken = async (t) => {
  if (t === "admin") return { sub: "admin-1", groups: [ADMIN_GROUP] };
  if (t === "user") return { sub: "user-1", groups: ["eng"] };
  throw new Error("bad token");
};

/** Seed a realistic slice of activity: a channel, a message, a redacted (spilled) message, an
 * agent, and audit events — enough that the console has something to show and to verify. */
async function seed(store: MemoryStore) {
  const ch = await store.createChannel({ workspaceId: "ws", kind: "human", name: "general", createdBy: "user-1" });
  await store.addMember({ channelId: ch.id, memberRef: "user-1", memberType: "user", role: "owner" });
  await store.appendAudit({ actor: "user-1", action: "channel.create", target: ch.id });
  await store.appendMessage({ channelId: ch.id, authorRef: "user-1", authorType: "user", content: "hello team" });
  const spill = await store.appendMessage({ channelId: ch.id, authorRef: "user-1", authorType: "user", content: "leaked CUI oops" });
  await store.redactMessage(spill.id, "admin-1", "CUI spillage");
  await store.createAgent({ ownerSub: "user-1", kind: "assistant", name: "helper" });
  return ch;
}

function serverWith(store: MemoryStore, devMode = false) {
  return createHttpServer({
    verifyToken: verify,
    store,
    admin: { adminGroup: ADMIN_GROUP, devMode, overview: () => buildOverview(store), renderConsole },
  });
}

test("exit 1 — isAdmin gates on the admin group", () => {
  assert.equal(isAdmin({ sub: "a", groups: [ADMIN_GROUP] }, ADMIN_GROUP), true);
  assert.equal(isAdmin({ sub: "u", groups: ["eng"] }, ADMIN_GROUP), false);
});

test("exit 2 — store read paths return seeded state", async () => {
  const store = new MemoryStore();
  await seed(store);
  assert.equal((await store.listChannels()).length, 1);
  assert.equal((await store.listAllAgents()).length, 1);
  assert.ok((await store.listAudit()).some((e) => e.action === "message.redact"));
});

test("exit 3 — buildOverview snapshots everything with both chains verified", async () => {
  const store = new MemoryStore();
  await seed(store);
  const o = await buildOverview(store);
  assert.equal(o.channels.length, 1);
  assert.equal(o.agents.length, 1);
  assert.equal(o.chains.messagesOk, true);
  assert.equal(o.chains.auditOk, true);
  assert.ok(o.audit.length >= 1);
});

test("exit 4 — renderConsole produces HTML with the state + a chain-intact badge", async () => {
  const store = new MemoryStore();
  await seed(store);
  const html = renderConsole(await buildOverview(store));
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /general/); // the channel
  assert.match(html, /helper/); // the agent
  assert.match(html, /message\.redact/); // an audit row
  assert.match(html, /intact|verified/i); // the chain badge
});

test("exit 5 — GET /admin/api/overview: 200 admin, 403 non-admin, 401 no token", async () => {
  const store = new MemoryStore();
  await seed(store);
  const server = serverWith(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/admin/api/overview`)).status, 401);
    assert.equal((await fetch(`${base}/admin/api/overview`, { headers: { authorization: "Bearer user" } })).status, 403);
    const ok = await fetch(`${base}/admin/api/overview`, { headers: { authorization: "Bearer admin" } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as AdminOverview;
    assert.equal(body.channels.length, 1);
    assert.equal(body.chains.auditOk, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("exit 6 — GET /admin (dev-mode) serves the HTML console", async () => {
  const store = new MemoryStore();
  await seed(store);
  const server = serverWith(store, true);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /general/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
