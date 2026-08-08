// Exercises the dependency-injected HTTP layer end-to-end over a real socket (`.listen(0)` +
// global `fetch`), using fakes for both injected dependencies. Deliberately does NOT import
// auth/* or store/* — those are separate modules; src/http/server.ts takes its deps by
// injection specifically so this suite can stay isolated from them.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AdminOverview, AgentControl, AgentSession, Message, Store, VerifyToken } from "../src/types.ts";
import { createHttpServer } from "../src/http/server.ts";

const verifyToken: VerifyToken = async (token) => {
  if (token === "good") return { sub: "user-1", groups: ["eng"] };
  // A second identity, used only by the coding-agent session tests below to exercise the
  // "not this session's owner" denial path through POST /sessions/:id/grant-execute.
  if (token === "good2") return { sub: "user-2", groups: ["eng"] };
  // An admin identity — member of "secchat-admins" — used only by the admin-console tests below
  // to exercise the isAdmin-gated /admin* routes.
  if (token === "admingood") return { sub: "admin-1", groups: ["secchat-admins"] };
  throw new Error("invalid token");
};

// MINIMAL fake Store — implements ONLY the methods src/http/server.ts's routes call
// (createChannel, addMember, appendAudit, isMember, appendMessage, listMessages, listThread,
// addReaction, removeReaction, listReactions, setLastRead, unreadCount, createWebhook,
// getWebhookByToken, createAgent, listAgentsByOwner). It intentionally does NOT implement
// getChannel/listMembers/redactMessage/verifyChains/getAgent/listChannels/listAllAgents, so it's
// cast through `unknown` rather than structurally satisfying the full Store contract.
let nextChannelId = 1;
let nextMessageId = 1;
let nextAgentId = 1;
let nextWebhookId = 1;
const knownChannelIds = new Set<string>();
// channelId -> set of memberRefs (users by sub, agents by id) — populated by addMember, read by
// isMember. This is the membership-tracking approach the /agents tests below reuse.
const channelMembers = new Map<string, Set<string>>();
const agentsByOwner = new Map<string, Array<{ id: string; ownerSub: string; kind: string; name?: string; model?: string; createdAt: string }>>();

// channelId -> messages, seq order (1-based per channel, mirrors MemoryStore) — real enough to
// back GET .../messages, GET .../threads/:parentId (filtered by parentId), and unreadCount
// (counted by seq) below, not just a stub.
interface FakeMessage {
  id: string;
  channelId: string;
  seq: number;
  authorRef: string;
  authorType: string;
  parentId?: string;
  contentSha256: string;
  prevHash: string;
  hash: string;
  createdAt: string;
}
const messagesByChannel = new Map<string, FakeMessage[]>();

// messageId -> emoji -> set of userSubs who reacted — mirrors the (messageId,userSub,emoji)
// uniqueness Reaction documents (reacting twice with the same emoji is a no-op).
const reactionsByMessage = new Map<string, Map<string, Set<string>>>();

// `${channelId}:${userSub}` -> last-read seq, read back by unreadCount.
const lastReadByChannelUser = new Map<string, number>();

// token -> webhook — a Map keyed by token, as createWebhook mints the credential and
// getWebhookByToken (used by the unauthenticated POST /hooks/:token path) looks it up by it.
interface FakeWebhook {
  id: string;
  channelId: string;
  token: string;
  createdBy: string;
  createdAt: string;
}
const webhooksByToken = new Map<string, FakeWebhook>();

const store = {
  async createChannel(input: { workspaceId: string; kind: string; name?: string; createdBy: string }) {
    const id = `chan-${nextChannelId++}`;
    knownChannelIds.add(id);
    return { id, ...input, createdAt: new Date().toISOString() };
  },
  async addMember(m: { channelId: string; memberRef: string }) {
    const members = channelMembers.get(m.channelId) ?? new Set<string>();
    members.add(m.memberRef);
    channelMembers.set(m.channelId, members);
  },
  async appendAudit() {
    // noop
  },
  async isMember(channelId: string, ref: string) {
    return knownChannelIds.has(channelId) && (channelMembers.get(channelId)?.has(ref) ?? false);
  },
  async appendMessage(input: { channelId: string; authorRef: string; authorType: string; content: string; parentId?: string }) {
    const rows = messagesByChannel.get(input.channelId) ?? [];
    const message: FakeMessage = {
      id: `msg-${nextMessageId++}`,
      channelId: input.channelId,
      seq: rows.length + 1,
      authorRef: input.authorRef,
      authorType: input.authorType,
      parentId: input.parentId,
      contentSha256: "0".repeat(64),
      prevHash: "0".repeat(64),
      hash: "0".repeat(64),
      createdAt: new Date().toISOString(),
    };
    rows.push(message);
    messagesByChannel.set(input.channelId, rows);
    return message;
  },
  async listMessages(channelId: string) {
    return messagesByChannel.get(channelId) ?? [];
  },
  async listThread(channelId: string, parentId: string) {
    return (messagesByChannel.get(channelId) ?? []).filter((m) => m.parentId === parentId);
  },
  async addReaction(messageId: string, userSub: string, emoji: string) {
    const byEmoji = reactionsByMessage.get(messageId) ?? new Map<string, Set<string>>();
    const users = byEmoji.get(emoji) ?? new Set<string>();
    users.add(userSub);
    byEmoji.set(emoji, users);
    reactionsByMessage.set(messageId, byEmoji);
  },
  async removeReaction(messageId: string, userSub: string, emoji: string) {
    reactionsByMessage.get(messageId)?.get(emoji)?.delete(userSub);
  },
  async listReactions(messageId: string) {
    const byEmoji = reactionsByMessage.get(messageId) ?? new Map<string, Set<string>>();
    const out: Array<{ messageId: string; userSub: string; emoji: string; at: string }> = [];
    for (const [emoji, users] of byEmoji) {
      for (const userSub of users) {
        out.push({ messageId, userSub, emoji, at: new Date().toISOString() });
      }
    }
    return out;
  },
  async setLastRead(channelId: string, userSub: string, seq: number) {
    lastReadByChannelUser.set(`${channelId}:${userSub}`, seq);
  },
  async unreadCount(channelId: string, userSub: string) {
    const read = lastReadByChannelUser.get(`${channelId}:${userSub}`) ?? 0;
    return (messagesByChannel.get(channelId) ?? []).filter((m) => m.seq > read).length;
  },
  async createWebhook(channelId: string, createdBy: string) {
    const wh: FakeWebhook = {
      id: `wh-${nextWebhookId++}`,
      channelId,
      token: randomUUID(),
      createdBy,
      createdAt: new Date().toISOString(),
    };
    webhooksByToken.set(wh.token, wh);
    return wh;
  },
  async getWebhookByToken(token: string) {
    return webhooksByToken.get(token) ?? null;
  },
  async createAgent(input: { ownerSub: string; kind: string; name?: string; model?: string }) {
    const agent = { id: `agent-${nextAgentId++}`, ...input, createdAt: new Date().toISOString() };
    const list = agentsByOwner.get(input.ownerSub) ?? [];
    list.push(agent);
    agentsByOwner.set(input.ownerSub, list);
    return agent;
  },
  async listAgentsByOwner(ownerSub: string) {
    return agentsByOwner.get(ownerSub) ?? [];
  },
} as unknown as Store;

let server: Server;
let baseUrl: string;

before(async () => {
  server = createHttpServer({ verifyToken, store });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── Fake AgentControl (Sprint 4 control plane) — used ONLY by the coding-agent session tests
// below, injected into a SEPARATE server instance so the tests above keep proving the no-control
// path works untouched. Records every call it receives and returns canned values:
//   - spawn        → always the fake session below, regardless of input.
//   - grantExecute → allow:true for byUser "user-1" (the session's simulated owner), allow:false
//                    (mirroring src/agent/gate.ts's real denial reason) for anyone else.
//   - sendInput    → records the call, resolves with no return value.
//   - getSession   → the fake session for id "sess-1", null for anything else.
const fakeSession: AgentSession = {
  id: "sess-1",
  agentId: "agent-fake",
  channelId: "chan-fake",
  hostType: "server",
  status: "starting",
  createdAt: new Date().toISOString(),
  leaseExpiresAt: new Date().toISOString(),
};

const controlCalls = {
  spawn: [] as unknown[],
  grantExecute: [] as unknown[],
  sendInput: [] as unknown[],
  getSession: [] as unknown[],
};

const control: AgentControl = {
  async spawn(input) {
    controlCalls.spawn.push(input);
    return fakeSession;
  },
  async grantExecute(input) {
    controlCalls.grantExecute.push(input);
    if (input.byUser === "user-1") {
      return { allow: true, reason: "granted" };
    }
    return { allow: false, reason: "only the agent's owner can authorize code execution" };
  },
  async sendInput(sessionId, text) {
    controlCalls.sendInput.push({ sessionId, text });
  },
  async getSession(id) {
    controlCalls.getSession.push(id);
    return id === fakeSession.id ? fakeSession : null;
  },
};

let controlServer: Server;
let controlBaseUrl: string;

before(async () => {
  controlServer = createHttpServer({ verifyToken, store, control });
  await new Promise<void>((resolve) => controlServer.listen(0, resolve));
  const address = controlServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  controlBaseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => controlServer.close(() => resolve()));
});

// ── Fake admin console deps (src/admin/overview.ts + console.ts, built in parallel — never
// imported here) — used ONLY by the admin-console tests below, injected into TWO server
// instances so the tests above keep proving the no-admin path (`server`/`baseUrl`, already built
// without `admin`) works untouched:
//   - adminDevServer  (devMode: true)  — the unauthenticated GET /admin dev-mode bypass.
//   - adminServer     (devMode: false) — the production/authed GET /admin router path, which the
//     dev-mode bypass would otherwise intercept before routing ever runs.
// GET /admin/api/overview is unaffected by devMode either way (it always goes through the normal
// auth flow), so either server exercises it.
const fakeOverview: AdminOverview = {
  generatedAt: "t",
  channels: [],
  agents: [],
  sessions: [],
  audit: [],
  chains: { messagesOk: true, auditOk: true },
};

const renderConsole = (_overview: AdminOverview): string => "<!doctype html><title>console</title>";

let adminDevServer: Server;
let adminDevBaseUrl: string;

before(async () => {
  adminDevServer = createHttpServer({
    verifyToken,
    store,
    admin: { adminGroup: "secchat-admins", devMode: true, overview: async () => fakeOverview, renderConsole },
  });
  await new Promise<void>((resolve) => adminDevServer.listen(0, resolve));
  const address = adminDevServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  adminDevBaseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => adminDevServer.close(() => resolve()));
});

let adminServer: Server;
let adminBaseUrl: string;

before(async () => {
  adminServer = createHttpServer({
    verifyToken,
    store,
    admin: { adminGroup: "secchat-admins", devMode: false, overview: async () => fakeOverview, renderConsole },
  });
  await new Promise<void>((resolve) => adminServer.listen(0, resolve));
  const address = adminServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  adminBaseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => adminServer.close(() => resolve()));
});

// ── Fake search port (src/http/server.ts's `SearchFn`) — used ONLY by the GET /search tests
// below, injected into a SEPARATE server instance (`searchServer`/`searchBaseUrl`) so the tests
// above keep proving the no-search path (`server`/`baseUrl`, already built without `search`)
// still 404s cleanly. Records every call and returns a canned result list regardless of query.
const fakeSearchResults: Array<Message & { content?: string }> = [
  {
    id: "msg-search-1",
    channelId: "chan-search",
    seq: 1,
    authorRef: "user-1",
    authorType: "user",
    contentSha256: "0".repeat(64),
    prevHash: "0".repeat(64),
    hash: "0".repeat(64),
    createdAt: new Date().toISOString(),
    content: "matched text",
  },
];

const searchCalls: Array<{ userSub: string; q: string }> = [];

const search = async (userSub: string, q: string): Promise<Array<Message & { content?: string }>> => {
  searchCalls.push({ userSub, q });
  return fakeSearchResults;
};

let searchServer: Server;
let searchBaseUrl: string;

before(async () => {
  searchServer = createHttpServer({ verifyToken, store, search });
  await new Promise<void>((resolve) => searchServer.listen(0, resolve));
  const address = searchServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  searchBaseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => searchServer.close(() => resolve()));
});

test("GET /healthz is 200 with no auth required", async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("GET /me without a token is 401", async () => {
  const res = await fetch(`${baseUrl}/me`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("GET /me with a valid bearer token returns the principal", async () => {
  const res = await fetch(`${baseUrl}/me`, { headers: { authorization: "Bearer good" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sub: "user-1", groups: ["eng"] });
});

test("GET /me with a bad token is 401", async () => {
  const res = await fetch(`${baseUrl}/me`, { headers: { authorization: "Bearer nope" } });
  assert.equal(res.status, 401);
});

test("POST /channels creates a channel and returns it with an id", async () => {
  const res = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "general" }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { id: string };
  assert.equal(typeof body.id, "string");
  assert.ok(body.id.length > 0);
});

test("a member can list their channel's messages", async () => {
  const created = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "general" }),
  });
  const channel = await created.json() as { id: string };

  const res = await fetch(`${baseUrl}/channels/${channel.id}/messages`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
});

test("a non-member is forbidden from a channel's messages", async () => {
  const res = await fetch(`${baseUrl}/channels/no-such-channel/messages`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 403);
});

test("POST /channels/:id/messages appends a message", async () => {
  const created = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "general" }),
  });
  const channel = await created.json() as { id: string };

  const res = await fetch(`${baseUrl}/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ content: "hello" }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { channelId: string };
  assert.equal(body.channelId, channel.id);
});

test("POST /agents spawns an agent plus a channel with the owner as a member", async () => {
  const res = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "my-assistant" }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { agent: { id: string }; channel: { id: string } };
  assert.equal(typeof body.agent.id, "string");
  assert.ok(body.agent.id.length > 0);
  assert.equal(typeof body.channel.id, "string");
  assert.ok(body.channel.id.length > 0);

  // The owner should already be a member of the spawned channel — a follow-up read succeeds
  // rather than 403ing, which is how we assert membership without a dedicated members endpoint.
  const messagesRes = await fetch(`${baseUrl}/channels/${body.channel.id}/messages`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(messagesRes.status, 200);
});

test("GET /agents lists agents spawned by the caller", async () => {
  const spawned = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "list-me" }),
  });
  const { agent } = await spawned.json() as { agent: { id: string } };

  const res = await fetch(`${baseUrl}/agents`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ id: string }>;
  assert.ok(Array.isArray(body));
  assert.ok(body.some((a) => a.id === agent.id));
});

test("an unmatched route is 404", async () => {
  const res = await fetch(`${baseUrl}/nope`, { headers: { authorization: "Bearer good" } });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("a malformed JSON body is 400", async () => {
  const res = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: "{not valid json",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bad_json" });
});

// ── Coding-agent session routes — exercised against `controlBaseUrl` (the server built WITH the
// fake `control` injected). ─────────────────────────────────────────────────────────────────────

test("POST /agents with kind coding spawns a session when control is present", async () => {
  const res = await fetch(`${controlBaseUrl}/agents`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ kind: "coding", name: "my-coder" }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as { agent: { id: string }; channel: { id: string }; session?: { id: string } };
  assert.equal(typeof body.agent.id, "string");
  assert.equal(typeof body.channel.id, "string");
  assert.equal(body.session?.id, "sess-1");
});

test("POST /agents with kind assistant has no session, even with control present", async () => {
  const res = await fetch(`${controlBaseUrl}/agents`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ kind: "assistant", name: "my-assistant" }),
  });
  assert.equal(res.status, 201);
  const body = await res.json() as Record<string, unknown>;
  assert.equal("session" in body, false);
});

test("POST /sessions/:id/grant-execute allows the session owner", async () => {
  const res = await fetch(`${controlBaseUrl}/sessions/sess-1/grant-execute`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { allow: true, reason: "granted" });
});

test("POST /sessions/:id/grant-execute denies a non-owner", async () => {
  const res = await fetch(`${controlBaseUrl}/sessions/sess-1/grant-execute`, {
    method: "POST",
    headers: { authorization: "Bearer good2", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
  const body = await res.json() as { allow: boolean; reason: string };
  assert.equal(body.allow, false);
  assert.ok(body.reason.length > 0);
});

test("POST /sessions/:id/input accepts input for a session", async () => {
  const res = await fetch(`${controlBaseUrl}/sessions/sess-1/input`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ text: "hello agent" }),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: "accepted" });
  assert.ok(controlCalls.sendInput.some((c) => (c as { sessionId: string; text: string }).text === "hello agent"));
});

test("GET /sessions/:id returns the session", async () => {
  const res = await fetch(`${controlBaseUrl}/sessions/sess-1`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { id: string };
  assert.equal(body.id, "sess-1");
});

test("GET /sessions/:id is 404 for an unknown session id", async () => {
  const res = await fetch(`${controlBaseUrl}/sessions/unknown`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

// ── Same session routes, but against `baseUrl` (the server built WITHOUT `control`) — proves the
// no-control-plane deployment path still works, and every session route degrades to a clean 404
// rather than throwing on an undefined `control`. ───────────────────────────────────────────────

test("with no control injected, POST /sessions/:id/grant-execute is 404 sessions_unavailable", async () => {
  const res = await fetch(`${baseUrl}/sessions/x/grant-execute`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "sessions_unavailable" });
});

test("with no control injected, POST /sessions/:id/input is 404 sessions_unavailable", async () => {
  const res = await fetch(`${baseUrl}/sessions/x/input`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "sessions_unavailable" });
});

test("with no control injected, GET /sessions/:id is 404 sessions_unavailable", async () => {
  const res = await fetch(`${baseUrl}/sessions/x`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "sessions_unavailable" });
});

// ── Admin / audit-review console routes — exercised against `adminDevBaseUrl` (devMode on),
// `adminBaseUrl` (devMode off, admin still wired), and `baseUrl` (no admin wired at all). ────────

test("GET /admin/api/overview without a token is 401", async () => {
  const res = await fetch(`${adminDevBaseUrl}/admin/api/overview`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("GET /admin/api/overview as a non-admin is 403", async () => {
  const res = await fetch(`${adminDevBaseUrl}/admin/api/overview`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
});

test("GET /admin/api/overview as an admin returns the overview JSON", async () => {
  const res = await fetch(`${adminDevBaseUrl}/admin/api/overview`, {
    headers: { authorization: "Bearer admingood" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), fakeOverview);
});

test("GET /admin/api/overview with no admin dep wired is 404", async () => {
  const res = await fetch(`${baseUrl}/admin/api/overview`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "admin_unavailable" });
});

test("GET /admin in dev mode serves the HTML console without a token", async () => {
  const res = await fetch(`${adminDevBaseUrl}/admin`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.startsWith("text/html"));
  assert.equal(await res.text(), "<!doctype html><title>console</title>");
});

// Non-dev (authed) GET /admin — a separate code path from the dev-mode bypass above: devMode:true
// intercepts every GET /admin before routing runs at all, so only a devMode:false server (or one
// with no admin wired) ever reaches the router's GET /admin handler.
test("GET /admin without devMode requires auth (no token is 401)", async () => {
  const res = await fetch(`${adminBaseUrl}/admin`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("GET /admin without devMode is forbidden for a non-admin", async () => {
  const res = await fetch(`${adminBaseUrl}/admin`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
});

test("GET /admin without devMode serves the HTML console for an admin", async () => {
  const res = await fetch(`${adminBaseUrl}/admin`, {
    headers: { authorization: "Bearer admingood" },
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.startsWith("text/html"));
  assert.equal(await res.text(), "<!doctype html><title>console</title>");
});

test("GET /admin with no admin dep wired is 404", async () => {
  const res = await fetch(`${baseUrl}/admin`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "admin_unavailable" });
});

// ── Chat-parity routes: threads, reactions, unread/read, inbound webhooks, search. All run
// through the normal auth flow against `baseUrl` EXCEPT POST /hooks/:token, which is the one
// unauthenticated route (the path token is itself the credential). ─────────────────────────────

test("a threaded reply carries parentId and shows up in the thread list", async () => {
  const created = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "general" }),
  });
  const channel = await created.json() as { id: string };

  const parentRes = await fetch(`${baseUrl}/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ content: "parent message" }),
  });
  const parent = await parentRes.json() as { id: string };

  const replyRes = await fetch(`${baseUrl}/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ content: "a reply", parentId: parent.id }),
  });
  assert.equal(replyRes.status, 201);
  const reply = await replyRes.json() as { id: string; parentId?: string };
  assert.equal(reply.parentId, parent.id);

  const threadRes = await fetch(`${baseUrl}/channels/${channel.id}/threads/${parent.id}`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(threadRes.status, 200);
  const thread = await threadRes.json() as Array<{ id: string; parentId?: string }>;
  assert.equal(thread.length, 1);
  assert.equal(thread[0]?.id, reply.id);
});

test("GET /channels/:id/threads/:parentId is forbidden for a non-member", async () => {
  const res = await fetch(`${baseUrl}/channels/no-such-channel/threads/no-such-parent`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 403);
});

test("reactions: add, list, and remove", async () => {
  const created = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "general" }),
  });
  const channel = await created.json() as { id: string };
  const msgRes = await fetch(`${baseUrl}/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ content: "react to me" }),
  });
  const message = await msgRes.json() as { id: string };

  const addRes = await fetch(`${baseUrl}/messages/${message.id}/reactions`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ emoji: "\u{1F44D}" }),
  });
  assert.equal(addRes.status, 201);
  assert.deepEqual(await addRes.json(), { ok: true });

  const listRes = await fetch(`${baseUrl}/messages/${message.id}/reactions`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(listRes.status, 200);
  const reactions = await listRes.json() as Array<{ emoji: string; userSub: string }>;
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0]?.emoji, "\u{1F44D}");
  assert.equal(reactions[0]?.userSub, "user-1");

  const delRes = await fetch(`${baseUrl}/messages/${message.id}/reactions/${encodeURIComponent("\u{1F44D}")}`, {
    method: "DELETE",
    headers: { authorization: "Bearer good" },
  });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { ok: true });

  const listAfterRes = await fetch(`${baseUrl}/messages/${message.id}/reactions`, {
    headers: { authorization: "Bearer good" },
  });
  const reactionsAfter = await listAfterRes.json() as unknown[];
  assert.equal(reactionsAfter.length, 0);
});

test("unread count reflects messages after the last-read marker, and read resets it", async () => {
  const created = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "general" }),
  });
  const channel = await created.json() as { id: string };

  await fetch(`${baseUrl}/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ content: "one" }),
  });
  const secondRes = await fetch(`${baseUrl}/channels/${channel.id}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ content: "two" }),
  });
  const second = await secondRes.json() as { seq: number };

  const unreadRes = await fetch(`${baseUrl}/channels/${channel.id}/unread`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(unreadRes.status, 200);
  assert.deepEqual(await unreadRes.json(), { unread: 2 });

  const readRes = await fetch(`${baseUrl}/channels/${channel.id}/read`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ seq: second.seq }),
  });
  assert.equal(readRes.status, 200);
  assert.deepEqual(await readRes.json(), { ok: true });

  const unreadAfterRes = await fetch(`${baseUrl}/channels/${channel.id}/unread`, {
    headers: { authorization: "Bearer good" },
  });
  assert.deepEqual(await unreadAfterRes.json(), { unread: 0 });
});

test("GET /channels/:id/unread is forbidden for a non-member", async () => {
  const res = await fetch(`${baseUrl}/channels/no-such-channel/unread`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 403);
});

test("POST /channels/:id/webhooks creates a webhook, and POST /hooks/:token posts a message with it", async () => {
  const created = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "general" }),
  });
  const channel = await created.json() as { id: string };

  const whRes = await fetch(`${baseUrl}/channels/${channel.id}/webhooks`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
  });
  assert.equal(whRes.status, 201);
  const wh = await whRes.json() as { id: string; channelId: string; token: string };
  assert.equal(wh.channelId, channel.id);
  assert.equal(typeof wh.token, "string");
  assert.ok(wh.token.length > 0);

  // No Authorization header at all — the path token IS the credential for this one route.
  const hookRes = await fetch(`${baseUrl}/hooks/${encodeURIComponent(wh.token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "posted by webhook" }),
  });
  assert.equal(hookRes.status, 201);
  const hookBody = await hookRes.json() as { id: string };
  assert.equal(typeof hookBody.id, "string");

  // Confirm it was actually recorded, via the normal (authenticated) channel-messages route.
  const messagesRes = await fetch(`${baseUrl}/channels/${channel.id}/messages`, {
    headers: { authorization: "Bearer good" },
  });
  const messages = await messagesRes.json() as Array<{ id: string; authorRef: string }>;
  assert.ok(messages.some((m) => m.id === hookBody.id && m.authorRef === `webhook:${wh.id}`));
});

test("POST /hooks/:token with an unknown token is 401 and requires no auth header to reach that verdict", async () => {
  const res = await fetch(`${baseUrl}/hooks/not-a-real-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "should not be recorded" }),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "invalid_webhook" });
});

test("GET /search returns results when a search dep is wired", async () => {
  const res = await fetch(`${searchBaseUrl}/search?q=hello`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), fakeSearchResults);
  assert.ok(searchCalls.some((c) => c.userSub === "user-1" && c.q === "hello"));
});

test("GET /search with no search dep wired is 404", async () => {
  const res = await fetch(`${baseUrl}/search?q=hello`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "search_unavailable" });
});
