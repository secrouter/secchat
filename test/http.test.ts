// Exercises the dependency-injected HTTP layer end-to-end over a real socket (`.listen(0)` +
// global `fetch`), using fakes for both injected dependencies. Deliberately does NOT import
// auth/* or store/* — those are separate modules; src/http/server.ts takes its deps by
// injection specifically so this suite can stay isolated from them.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { Store, VerifyToken } from "../src/types.ts";
import { createHttpServer } from "../src/http/server.ts";

const verifyToken: VerifyToken = async (token) => {
  if (token === "good") return { sub: "user-1", groups: ["eng"] };
  throw new Error("invalid token");
};

// MINIMAL fake Store — implements ONLY the methods src/http/server.ts's routes call
// (createChannel, addMember, appendAudit, isMember, appendMessage, listMessages, createAgent,
// listAgentsByOwner). It intentionally does NOT implement getChannel/listMembers/redactMessage/
// verifyChains/getAgent, so it's cast through `unknown` rather than structurally satisfying the
// full Store contract.
let nextChannelId = 1;
let nextMessageId = 1;
let nextAgentId = 1;
const knownChannelIds = new Set<string>();
// channelId -> set of memberRefs (users by sub, agents by id) — populated by addMember, read by
// isMember. This is the membership-tracking approach the /agents tests below reuse.
const channelMembers = new Map<string, Set<string>>();
const agentsByOwner = new Map<string, Array<{ id: string; ownerSub: string; kind: string; name?: string; model?: string; createdAt: string }>>();

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
  async appendMessage(input: { channelId: string; authorRef: string; authorType: string; content: string }) {
    return {
      id: `msg-${nextMessageId++}`,
      channelId: input.channelId,
      seq: 1,
      authorRef: input.authorRef,
      authorType: input.authorType,
      contentSha256: "0".repeat(64),
      prevHash: "0".repeat(64),
      hash: "0".repeat(64),
      createdAt: new Date().toISOString(),
    };
  },
  async listMessages() {
    return [];
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
