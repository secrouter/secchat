// Exercises the dependency-injected HTTP layer end-to-end over a real socket (`.listen(0)` +
// global `fetch`), using fakes for both injected dependencies. Deliberately does NOT import
// src/auth/* or src/store/* — those are separate modules; src/http/server.ts takes its deps by
// injection specifically so this suite can stay isolated from them. src/dev/auth.ts IS imported
// directly below, though: unlike the real JWKS verifier, it's a trivial dependency-free pure
// function (regex parse in, Principal out), so it's exercised here as a plain unit under test
// rather than injected into a server.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AdminOverview, AgentControl, AgentSession, Message, Store, VerifyToken } from "../src/types.ts";
import { createHttpServer } from "../src/http/server.ts";
import { devVerifyToken } from "../src/dev/auth.ts";

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
// (createChannel, addMember, appendAudit, isMember, listChannels, appendMessage, listMessages,
// listThread, addReaction, removeReaction, listReactions, setLastRead, unreadCount,
// createWebhook, getWebhookByToken, createAgent, listAgentsByOwner). It intentionally does NOT
// implement getChannel/listMembers/redactMessage/verifyChains/getAgent/listAllAgents, so it's
// cast through `unknown` rather than structurally satisfying the full Store contract.
let nextChannelId = 1;
let nextMessageId = 1;
let nextAgentId = 1;
let nextWebhookId = 1;
const knownChannelIds = new Set<string>();
// channelId -> full channel row, populated by createChannel — backs listChannels (used by GET
// /channels, which filters this down to the caller's channels via isMember below).
interface FakeChannel {
  id: string;
  workspaceId: string;
  kind: string;
  name?: string;
  createdBy: string;
  createdAt: string;
}
const channelsById = new Map<string, FakeChannel>();
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
  marking: string;
  attachmentsSha256: string;
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
    const channel: FakeChannel = { id, ...input, createdAt: new Date().toISOString() };
    channelsById.set(id, channel);
    return channel;
  },
  // The message-post route resolves the channel to read its marking ceiling; these fakes are
  // unmarked (no cuiMarking), so posting defaults to the policy floor.
  async getChannel(id: string) {
    return channelsById.get(id) ?? null;
  },
  async setChannelArchived(id: string, archived: boolean) {
    const channel = channelsById.get(id) as (FakeChannel & { archived?: boolean }) | undefined;
    if (!channel) throw new Error(`unknown channel ${id}`);
    channel.archived = archived;
    return channel;
  },
  async addMember(m: { channelId: string; memberRef: string }) {
    const members = channelMembers.get(m.channelId) ?? new Set<string>();
    members.add(m.memberRef);
    channelMembers.set(m.channelId, members);
  },
  async appendAudit() {
    // noop
  },
  // GET /me upserts the caller into the seen-users directory; this fake just echoes a row back so
  // that route keeps working. (The directory routes themselves are covered by directory.exit.test.ts
  // against the real MemoryStore.)
  async upsertUser(input: { sub: string; email?: string; displayName?: string; groups: string[] }) {
    return { ...input, lastSeenAt: new Date().toISOString() };
  },
  // Used by triggerCodingAgents to resolve a poster's display name for the "who posted it" header.
  async getUser(sub: string) {
    return sub === "user-1" ? { sub, displayName: "Alice One", groups: [] } : null;
  },
  async isMember(channelId: string, ref: string) {
    return knownChannelIds.has(channelId) && (channelMembers.get(channelId)?.has(ref) ?? false);
  },
  async listChannels() {
    return [...channelsById.values()];
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
      marking: "UNCLASSIFIED",
      attachmentsSha256: "",
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
  async getMessage(id: string) {
    for (const rows of messagesByChannel.values()) {
      const found = rows.find((m) => m.id === id);
      if (found) return found;
    }
    return null;
  },
  async listReactionsForChannel(channelId: string) {
    const out: Array<{ messageId: string; userSub: string; emoji: string; at: string }> = [];
    for (const m of messagesByChannel.get(channelId) ?? []) {
      const byEmoji = reactionsByMessage.get(m.id);
      if (!byEmoji) continue;
      for (const [emoji, users] of byEmoji) {
        for (const userSub of users) out.push({ messageId: m.id, userSub, emoji, at: new Date().toISOString() });
      }
    }
    return out;
  },
  // Attachments: this minimal fake carries none — the message routes it exercises never attach files.
  async listAttachmentsForChannel(_channelId: string) {
    return [];
  },
  async listAttachmentsForMessage(_messageId: string) {
    return [];
  },
  async getAttachment(_id: string) {
    return null;
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
  // Added for GET /channels' agent-channel enrichment (agentKind/agentId/agentModel) and the
  // PATCH /agents/:id model picker. A member ref is an "agent" iff it's a known agent id.
  async getAgent(id: string) {
    for (const list of agentsByOwner.values()) {
      const a = list.find((x) => x.id === id);
      if (a) return a;
    }
    return null;
  },
  async updateAgentModel(id: string, model: string) {
    for (const list of agentsByOwner.values()) {
      const a = list.find((x) => x.id === id);
      if (a) {
        a.model = model;
        return a;
      }
    }
    return null;
  },
  async listMembers(channelId: string) {
    const refs = channelMembers.get(channelId) ?? new Set<string>();
    const isAgent = (ref: string) =>
      [...agentsByOwner.values()].some((l) => l.some((a) => a.id === ref));
    return [...refs].map((ref) => ({
      memberRef: ref,
      memberType: isAgent(ref) ? "agent" : "user",
      role: "member",
    }));
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
  async liveSession(channelId) {
    return channelId === fakeSession.channelId ? fakeSession : null;
  },
};

let controlServer: Server;
let controlBaseUrl: string;

before(async () => {
  // hasRemoteRunner: () => true ⇒ the "desktop" launch environment is available, so POST /agents
  // coding is allowed (a coding agent now requires a real launch environment, never the demo stub).
  controlServer = createHttpServer({ verifyToken, store, control, hasRemoteRunner: () => true });
  await new Promise<void>((resolve) => controlServer.listen(0, resolve));
  const address = controlServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  controlBaseUrl = `http://127.0.0.1:${port}`;
  // POST /sessions/:id/input now gates on membership of the session's channel:
  // register the fake session's channel with user-1 (the "good" token) as a member.
  knownChannelIds.add(fakeSession.channelId);
  await store.addMember({ channelId: fakeSession.channelId, memberRef: "user-1", memberType: "user", role: "member" });
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
    marking: "UNCLASSIFIED",
    attachmentsSha256: "",
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

// ── Fake static web root (src/http/server.ts's `deps.web`) — used ONLY by the static-serving
// tests below, injected into a SEPARATE server instance (`webServer`/`webBaseUrl`) so the tests
// above keep proving the no-web path (`server`/`baseUrl`, already built without `web`) still
// falls through `/` to the normal auth flow. A real temp directory on disk (not a fake/mock) —
// this route reads actual files via node:fs, so the test has to give it real ones. Deliberately
// does NOT depend on anything under src/web/ (a parallel effort builds the real SPA build output
// that a real deployment would point `web.root` at).
const webRoot = mkdtempSync(join(tmpdir(), "secchat-web-"));
writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>shell</title>");
mkdirSync(join(webRoot, "assets"));
writeFileSync(join(webRoot, "assets", "app.js"), "console.log('app');");
writeFileSync(join(webRoot, "assets", "app.css"), "body { color: red; }");
// A root-level file (not under assets/) — the general static server serves the WHOLE client build
// dir (Flutter emits main.dart.js/flutter.js/canvaskit/ at the root), so this IS a served file.
writeFileSync(join(webRoot, "app.js"), "console.log('root');");
// Lives OUTSIDE webRoot (a sibling in tmpdir) — the traversal test asserts the guard blocks any
// path that would ESCAPE the web root, which is the security property that actually matters.
const outsideSecret = join(webRoot, "..", "secchat-outside-secret.txt");
writeFileSync(outsideSecret, "top secret outside the web root");

let webServer: Server;
let webBaseUrl: string;

before(async () => {
  webServer = createHttpServer({ verifyToken, store, web: { root: webRoot } });
  await new Promise<void>((resolve) => webServer.listen(0, resolve));
  const address = webServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  webBaseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => webServer.close(() => resolve()));
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(outsideSecret, { force: true });
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

test("GET /me with a valid bearer token returns the principal + the marking policy", async () => {
  const res = await fetch(`${baseUrl}/me`, { headers: { authorization: "Bearer good" } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sub: string; groups: string[]; marking: { levels: string[]; default: string } };
  assert.equal(body.sub, "user-1");
  assert.deepEqual(body.groups, ["eng"]);
  // The default built-in ladder is attached (no `marking` dep wired in this server).
  assert.equal(body.marking.default, "UNCLASSIFIED");
  assert.ok(body.marking.levels.includes("CUI"));
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

test("GET /models returns an empty list when no LLM gateway is wired", async () => {
  const res = await fetch(`${baseUrl}/models`, { headers: { authorization: "Bearer good" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: [] });
});

test("GET /channels enriches an agent channel with agentKind/agentId/agentModel", async () => {
  const created = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ kind: "assistant", name: "picker" }),
  });
  const { agent, channel } = await created.json() as { agent: { id: string }; channel: { id: string } };

  const list = await (await fetch(`${baseUrl}/channels`, { headers: { authorization: "Bearer good" } })).json() as
    Array<{ id: string; agentKind?: string; agentId?: string; agentModel?: string }>;
  const row = list.find((c) => c.id === channel.id);
  assert.ok(row, "the agent channel should be listed");
  assert.equal(row!.agentKind, "assistant");
  assert.equal(row!.agentId, agent.id);
});

test("PATCH /agents/:id switches the model (owner only)", async () => {
  const created = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ kind: "assistant", name: "switchable" }),
  });
  const { agent, channel } = await created.json() as { agent: { id: string }; channel: { id: string } };

  // Owner can switch it.
  const patched = await fetch(`${baseUrl}/agents/${agent.id}`, {
    method: "PATCH",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ model: "secllm/fast" }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json() as { model?: string }).model, "secllm/fast");

  // The channel now reports the new model.
  const list = await (await fetch(`${baseUrl}/channels`, { headers: { authorization: "Bearer good" } })).json() as
    Array<{ id: string; agentModel?: string }>;
  assert.equal(list.find((c) => c.id === channel.id)?.agentModel, "secllm/fast");

  // A different user (not the owner) may not.
  const forbidden = await fetch(`${baseUrl}/agents/${agent.id}`, {
    method: "PATCH",
    headers: { authorization: "Bearer good2", "content-type": "application/json" },
    body: JSON.stringify({ model: "auto" }),
  });
  assert.equal(forbidden.status, 403);
});

test("PATCH /agents/:id is 404 for an unknown agent and 400 without a model", async () => {
  const unknown = await fetch(`${baseUrl}/agents/nope`, {
    method: "PATCH",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ model: "auto" }),
  });
  assert.equal(unknown.status, 404);

  const created = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ kind: "assistant", name: "no-model" }),
  });
  const { agent } = await created.json() as { agent: { id: string } };
  const bad = await fetch(`${baseUrl}/agents/${agent.id}`, {
    method: "PATCH",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
});

test("POST /channels/:id/archive toggles the archived flag (member only)", async () => {
  const created = await (await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "to-archive" }),
  })).json() as { id: string };

  // Archive (default true).
  const arch = await fetch(`${baseUrl}/channels/${created.id}/archive`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(arch.status, 200);
  assert.equal((await arch.json() as { archived?: boolean }).archived, true);

  // …and it shows on GET /channels.
  const listed = await (await fetch(`${baseUrl}/channels`, { headers: { authorization: "Bearer good" } })).json() as
    Array<{ id: string; archived?: boolean }>;
  assert.equal(listed.find((c) => c.id === created.id)?.archived, true);

  // Restore.
  const restore = await fetch(`${baseUrl}/channels/${created.id}/archive`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ archived: false }),
  });
  assert.equal((await restore.json() as { archived?: boolean }).archived, false);

  // A non-member may not.
  const forbidden = await fetch(`${baseUrl}/channels/${created.id}/archive`, {
    method: "POST",
    headers: { authorization: "Bearer good2", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(forbidden.status, 403);
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

test("GET /runner/environments reports desktop connected (this server) and the pool as not-yet-deployed", async () => {
  const res = await fetch(`${controlBaseUrl}/runner/environments`, { headers: { authorization: "Bearer good" } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { environments: Array<{ id: string; available: boolean; reason: string }> };
  const byId = Object.fromEntries(body.environments.map((e) => [e.id, e]));
  assert.equal(byId.desktop!.available, true); // controlServer wires hasRemoteRunner: () => true
  assert.equal(byId.pool!.available, false);
  assert.equal(byId.pool!.reason, "not_deployed");
});

test("POST /agents coding is 409 when the chosen launch environment isn't available", async () => {
  // baseUrl's server has no control plane AND no hasRemoteRunner, so no environment is available.
  const noEnv = await fetch(`${baseUrl}/agents`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ kind: "coding", name: "x" }),
  });
  // No control plane ⇒ 503; with a control plane but no runner it would be 409. Either way, never 201.
  assert.ok(noEnv.status === 503 || noEnv.status === 409, `expected 503/409, got ${noEnv.status}`);
  assert.notEqual(noEnv.status, 201);
});

test("POST /agents coding to the online pool is 409 (not deployed) even with a desktop connected", async () => {
  const res = await fetch(`${controlBaseUrl}/agents`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ kind: "coding", name: "pooled", launchEnv: "pool" }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; env: string };
  assert.equal(body.error, "launch_env_unavailable");
  assert.equal(body.env, "pool");
});

test("posting a message in a coding channel forwards it to pi as a JSON envelope naming who posted it", async () => {
  // The canonical path: a normal message post to a coding-agent channel is persisted like any
  // message AND forwarded to the agent's pi session, prefixed with a header naming the poster.
  // Make fakeSession's channel a coding-agent channel so triggerCodingAgents fires; the fake
  // liveSession returns fakeSession for it, so the reuse (not spawn) path runs.
  const coder = await store.createAgent({ ownerSub: "user-1", kind: "coding", name: "Builder" });
  await store.addMember({ channelId: fakeSession.channelId, memberRef: coder.id, memberType: "agent", role: "member" });
  const before = controlCalls.sendInput.length;
  const res = await fetch(`${controlBaseUrl}/channels/${fakeSession.channelId}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ content: "run the build" }),
  });
  assert.equal(res.status, 201);
  // triggerCodingAgents is fire-and-forget after the 201 — let the microtasks/timer drain.
  await new Promise((r) => setTimeout(r, 30));
  const forwarded = controlCalls.sendInput
    .slice(before)
    .map((c) => c as { sessionId: string; text: string });
  assert.equal(forwarded.length, 1, "exactly one forward to pi");
  assert.equal(forwarded[0]!.sessionId, fakeSession.id);
  // Delivered as a JSON envelope naming the sender + their edit authority (pi is primed for this
  // shape at spawn). user-1 owns the agent, so authorized is true.
  assert.deepEqual(JSON.parse(forwarded[0]!.text), { from: "Alice One", message: "run the build", authorized: true });
});

test("the envelope's authorized flag is false for a non-owner sender (only the owner may trigger edits)", async () => {
  // A coding agent owned by user-1, in a channel where user-2 is a plain member. user-2 can talk to
  // the agent (plan mode) but can't authorize edits — the envelope must say so, matching the gate.
  const coder = await store.createAgent({ ownerSub: "user-1", kind: "coding", name: "Builder2" });
  const chId = "coding-ch-nonowner";
  knownChannelIds.add(chId);
  await store.addMember({ channelId: chId, memberRef: coder.id, memberType: "agent", role: "member" });
  await store.addMember({ channelId: chId, memberRef: "user-2", memberType: "user", role: "member" });
  const before = controlCalls.sendInput.length;
  const res = await fetch(`${controlBaseUrl}/channels/${chId}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer good2", "content-type": "application/json" },
    body: JSON.stringify({ content: "please edit the config" }),
  });
  assert.equal(res.status, 201);
  await new Promise((r) => setTimeout(r, 30));
  const forwarded = controlCalls.sendInput.slice(before).map((c) => c as { sessionId: string; text: string });
  assert.equal(forwarded.length, 1);
  assert.deepEqual(JSON.parse(forwarded[0]!.text), { from: "user-2", message: "please edit the config", authorized: false });
});

test("POST /sessions/:id/input is 403 for a caller who isn't a participant in the session's channel", async () => {
  // "good2" (user-2) is authenticated but not a member of the session's channel.
  const res = await fetch(`${controlBaseUrl}/sessions/sess-1/input`, {
    method: "POST",
    headers: { authorization: "Bearer good2", "content-type": "application/json" },
    body: JSON.stringify({ text: "sneaking input into a session I can't see" }),
  });
  assert.equal(res.status, 403);
});

test("POST /sessions/:id/input is 404 for an unknown session", async () => {
  const res = await fetch(`${controlBaseUrl}/sessions/unknown/input`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ text: "x" }),
  });
  assert.equal(res.status, 404);
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

// ── GET /channels — the SPA sidebar's channel list, filtered to the caller's membership. A core
// router route (no optional dep to wire), so this runs against the plain `server`/`baseUrl`. ────

test("GET /channels lists only channels the caller is a member of", async () => {
  const mineRes = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({ name: "user-1's channel" }),
  });
  const mine = await mineRes.json() as { id: string };

  const theirsRes = await fetch(`${baseUrl}/channels`, {
    method: "POST",
    headers: { authorization: "Bearer good2", "content-type": "application/json" },
    body: JSON.stringify({ name: "user-2's channel" }),
  });
  const theirs = await theirsRes.json() as { id: string };

  const res = await fetch(`${baseUrl}/channels`, {
    headers: { authorization: "Bearer good" },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ id: string }>;
  assert.ok(Array.isArray(body));
  assert.ok(body.some((c) => c.id === mine.id), "caller's own channel should be listed");
  assert.ok(!body.some((c) => c.id === theirs.id), "another user's channel should NOT be listed");
});

test("GET /channels without a token is 401", async () => {
  const res = await fetch(`${baseUrl}/channels`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

// ── Static web asset serving (the SPA shell) — exercised against `webBaseUrl` (the server built
// WITH `web: { root: webRoot }`, a temp directory built above with a real index.html + assets/*).
// These routes are PUBLIC: no Authorization header anywhere below, since the shell has to load
// before a user can log in. The last test in this section proves the feature is opt-in — `baseUrl`
// (no `web` wired) still falls through `/` to the normal auth flow, unchanged. ───────────────────

test("GET / serves index.html when a web root is wired", async () => {
  const res = await fetch(`${webBaseUrl}/`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.startsWith("text/html"));
  assert.equal(await res.text(), "<!doctype html><title>shell</title>");
});

test("GET /index.html also serves the shell", async () => {
  const res = await fetch(`${webBaseUrl}/index.html`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.startsWith("text/html"));
  assert.equal(await res.text(), "<!doctype html><title>shell</title>");
});

test("GET /assets/app.js serves the asset as text/javascript", async () => {
  const res = await fetch(`${webBaseUrl}/assets/app.js`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.startsWith("text/javascript"));
  assert.equal(await res.text(), "console.log('app');");
});

test("GET /assets/app.css serves the asset as text/css", async () => {
  const res = await fetch(`${webBaseUrl}/assets/app.css`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.startsWith("text/css"));
  assert.equal(await res.text(), "body { color: red; }");
});

test("GET a root-level static file (not under assets/) is served", async () => {
  // The general static server serves the WHOLE client build dir, not just /assets/ — this is what
  // lets a Flutter build's root-level main.dart.js/flutter.js load.
  const res = await fetch(`${webBaseUrl}/app.js`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.startsWith("text/javascript"));
  assert.equal(await res.text(), "console.log('root');");
});

test("GET a missing static file falls through to the API (401 without a token)", async () => {
  // A path with no real file under the web root is NOT a static 404 — it falls through to the
  // normal auth+router (so it can never shadow an API route like /me). Unauthenticated ⇒ 401.
  const res = await fetch(`${webBaseUrl}/does-not-exist.js`);
  assert.equal(res.status, 401);
});

test("static serving cannot escape the web root (percent-encoded traversal is blocked)", async () => {
  // "%2e%2e%2f" decodes to "../". A literal ".." is collapsed by the URL parser before the handler
  // sees it; the percent-encoded form survives, decoded only inside the handler — exactly what the
  // resolve()+startsWith() guard is for. This targets a file that genuinely exists OUTSIDE the web
  // root (secchat-outside-secret.txt, a sibling in tmpdir): the guard must refuse to serve it, so
  // it falls through to auth → 401 (never 200, never the file's contents).
  const res = await fetch(`${webBaseUrl}/%2e%2e%2fsecchat-outside-secret.txt`);
  assert.notEqual(res.status, 200);
  assert.equal(res.status, 401);
});

test("GET / without a web root wired falls through to the normal auth flow, unchanged", async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

// ── src/dev/auth.ts's devVerifyToken — a pure parse, no server involved. DEV ONLY (see that
// file's header comment); exercised directly here rather than injected, since it's a trivial,
// dependency-free function. ─────────────────────────────────────────────────────────────────────

test("devVerifyToken parses sub and groups from a well-formed dev token", async () => {
  const principal = await devVerifyToken("dev.alice.eng,secchat-admins");
  assert.deepEqual(principal, { sub: "alice", groups: ["eng", "secchat-admins"] });
});

test("devVerifyToken yields an empty groups array for a token with no groups", async () => {
  const principal = await devVerifyToken("dev.bob.");
  assert.deepEqual(principal, { sub: "bob", groups: [] });
});

test("devVerifyToken parses a single group with no trailing comma", async () => {
  const principal = await devVerifyToken("dev.carol.eng");
  assert.deepEqual(principal, { sub: "carol", groups: ["eng"] });
});

test("devVerifyToken rejects tokens that don't match the dev.<sub>.<groups> shape", async () => {
  await assert.rejects(() => devVerifyToken("not-a-dev-token"));
  await assert.rejects(() => devVerifyToken(""));
  await assert.rejects(() => devVerifyToken("dev.no-trailing-dot"));
  await assert.rejects(() => devVerifyToken("Bearer good"));
});
