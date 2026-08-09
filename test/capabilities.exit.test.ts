// EXIT TESTS — privileged capabilities over HTTP (Track 2d). A deployment ties an action to an IdP
// group and/or a step-up window; the routes enforce it. Covers: group-forbidden → 403; group member
// but stale step-up → 403 stepup_required; POST /auth/stepup mints a proof that, presented via
// X-Sec-StepUp, satisfies the freshness check; and agent.manage gating BOTH spawn and grant-execute.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { makeStepUp } from "../src/auth/stepup.ts";
import { defaultCapabilityPolicy, type CapabilityPolicy } from "../src/auth/capabilities.ts";
import type { AgentControl, Channel, Message, Store, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  switch (token) {
    case "officer":
      return { sub: "officer", groups: ["sec-officers"] }; // holds message.redact
    case "alice":
      return { sub: "alice", groups: [] }; // author, no privileged groups
    case "operator":
      return { sub: "operator", groups: ["pi-operators"] }; // holds agent.manage
    case "bob":
      return { sub: "bob", groups: [] };
    default:
      throw new Error("invalid token");
  }
};

const h = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  ...extra,
});

const stepUp = makeStepUp("test-stepup-secret", 900);

// Redaction gated on the sec-officers group + a 300s step-up; agent.manage on the pi-operators group.
const capabilities = {
  ...defaultCapabilityPolicy("admins"),
  "message.redact": { group: "sec-officers", stepUpSeconds: 300 },
  "agent.manage": { group: "pi-operators", stepUpSeconds: 0 },
} as CapabilityPolicy;

// A minimal control plane so the coding-agent routes exist.
const control = {
  spawn: async () => ({ id: "sess-1", agentId: "a", channelId: "c", hostType: "server", status: "starting", createdAt: "", leaseExpiresAt: "" }),
  grantExecute: async () => ({ allow: true, reason: "granted" }),
  getSession: async () => null,
  sendInput: async () => {},
  evaluateTool: async () => ({ allow: true }),
} as unknown as AgentControl;

async function withServer(fn: (base: string, store: Store) => Promise<void>): Promise<void> {
  const store = new MemoryStore();
  const server = createHttpServer({ verifyToken, store, capabilities, stepUp, control });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function seed(base: string): Promise<{ channel: Channel; message: Message }> {
  const channel = (await (await fetch(`${base}/channels`, { method: "POST", headers: h("alice"), body: JSON.stringify({ name: "g" }) })).json()) as Channel;
  const message = (await (await fetch(`${base}/channels/${channel.id}/messages`, { method: "POST", headers: h("alice"), body: JSON.stringify({ content: "oops" }) })).json()) as Message;
  return { channel, message };
}

const mintStepUp = async (base: string, token: string): Promise<string> =>
  ((await (await fetch(`${base}/auth/stepup`, { method: "POST", headers: h(token) })).json()) as { token: string }).token;

const redact = (base: string, token: string, id: string, extra: Record<string, string> = {}) =>
  fetch(`${base}/messages/${id}/redact`, { method: "POST", headers: h(token, extra), body: JSON.stringify({ reason: "spillage" }) });

test("redacting another's message: a channel member NOT in the redact group is forbidden (403)", async () => {
  await withServer(async (base, store) => {
    const { channel, message } = await seed(base);
    // bob is a member (so membership isn't the blocker) but lacks sec-officers → the redact
    // capability forbids him from redacting alice's message.
    await store.addMember({ channelId: channel.id, memberRef: "bob", memberType: "user", role: "member" });
    const res = await redact(base, "bob", message.id);
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "forbidden");
  });
});

test("a group member without a fresh step-up gets 403 stepup_required; minting one satisfies it", async () => {
  await withServer(async (base, store) => {
    const { channel, message } = await seed(base);
    await store.addMember({ channelId: channel.id, memberRef: "officer", memberType: "user", role: "member" });

    // In the group, but no step-up proof presented → stepup_required.
    const denied = await redact(base, "officer", message.id);
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { error: string }).error, "stepup_required");

    // Mint a step-up proof and present it → the redaction goes through.
    const proof = await mintStepUp(base, "officer");
    const ok = await redact(base, "officer", message.id, { "x-sec-stepup": proof });
    assert.equal(ok.status, 200);

    // The step-up itself was recorded in the audit chain.
    assert.ok((await store.listAudit()).some((a) => a.action === "auth.stepup" && a.actor === "officer"));
  });
});

test("agent.manage gates BOTH spawn and grant-execute", async () => {
  await withServer(async (base) => {
    // bob lacks pi-operators → cannot spawn.
    const spawnDenied = await fetch(`${base}/agents`, { method: "POST", headers: h("bob"), body: JSON.stringify({ kind: "coding" }) });
    assert.equal(spawnDenied.status, 403);
    // operator holds it → can spawn.
    const spawnOk = await fetch(`${base}/agents`, { method: "POST", headers: h("operator"), body: JSON.stringify({ kind: "coding" }) });
    assert.equal(spawnOk.status, 201);

    // grant-execute is the same capability: bob denied, operator allowed.
    assert.equal((await fetch(`${base}/sessions/sess-x/grant-execute`, { method: "POST", headers: h("bob"), body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/sessions/sess-x/grant-execute`, { method: "POST", headers: h("operator"), body: "{}" })).status, 200);
  });
});

test("POST /auth/stepup is 503 when no step-up secret is configured", async () => {
  const store = new MemoryStore();
  const server = createHttpServer({ verifyToken, store }); // no stepUp dep
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/auth/stepup`, { method: "POST", headers: h("alice") });
    assert.equal(res.status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
