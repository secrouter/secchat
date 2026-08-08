// The Sprint 1 walking-skeleton proof: the real modules wired together (MemoryStore + HTTP +
// WS hub, exactly as index.ts wires them) carry a message end-to-end —
//   authed HTTP POST → persisted into the tamper-evident chain → broadcast to a WS subscriber.
// Auth itself is covered in test/auth.test.ts against a real JWKS; here a fake verifier stands
// in for the IdP so the test needs no network, and the focus is the wiring + realtime + chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHttpServer } from "../src/http/server.ts";
import { makeControlPlane } from "../src/agent/control.ts";
import { makeLlmClient } from "../src/secrouter/client.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { attachWsHub, type Hub } from "../src/ws/hub.ts";
import type { Id, Principal, RunnerEvent, Runner, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  if (token !== "good") throw new Error("bad token");
  return { sub: "user-1", groups: ["eng"] } satisfies Principal;
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("end-to-end: authed POST → chained persist → realtime broadcast to a subscriber", async () => {
  const store = new MemoryStore();
  let hub: Hub | undefined;
  const server = createHttpServer({ verifyToken, store, broadcast: (c, p) => hub?.broadcast(c, p) });
  hub = attachWsHub(server, { verifyToken });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=good`);
  const received: unknown[] = [];
  ws.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws failed to open")));
  });

  try {
    // owner (user-1) creates a channel — they're auto-added as an owner member
    const created = await fetch(`${base}/channels`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ name: "general" }),
    });
    assert.equal(created.status, 201);
    const channel = (await created.json()) as { id: string };

    // subscribe this connection to the channel, then let the frame be processed
    ws.send(JSON.stringify({ type: "subscribe", channelId: channel.id }));
    await delay(50);

    // post a message over HTTP
    const posted = await fetch(`${base}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ content: "hello world" }),
    });
    assert.equal(posted.status, 201);
    const msg = (await posted.json()) as { content: string; hash: string; contentSha256: string };
    assert.equal(msg.content, "hello world"); // echoed plaintext (fix wired at integration)
    assert.equal(msg.hash.length, 64); // linked into the chain

    // the WS subscriber received the broadcast for that same message
    await delay(50);
    assert.equal(received.length, 1);
    const evt = received[0] as { type: string; message: { content: string; hash: string } };
    assert.equal(evt.type, "message");
    assert.equal(evt.message.content, "hello world");
    assert.equal(evt.message.hash, msg.hash);

    // and the persisted chain verifies
    const v = await store.verifyChains();
    assert.equal(v.messagesOk, true);
    assert.equal(v.auditOk, true); // channel.create emitted an audit event
  } finally {
    ws.close();
    hub.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ── Sprint 2: the SecAssist-killer, end to end ───────────────────────────────────────────────
// Spawn an assistant, post to its channel, and prove the model reply is (a) governed as the
// OWNER at SecRouter (X-Sec-Acting-User), (b) streamed to the WS subscriber, and (c) persisted
// into the tamper-evident chain — all against a STUB SecRouter (no network, no real gateway).

/** A stub SecRouter that streams two OpenAI-style SSE deltas and records the acting-user header. */
function startStubSecrouter(): Promise<{ url: string; server: Server; actingUser(): string | undefined }> {
  let seenActingUser: string | undefined;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    seenActingUser = req.headers["x-sec-acting-user"] as string | undefined;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of ["Hi ", "there"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, server, actingUser: () => seenActingUser });
    });
  });
}

async function waitFor<T>(get: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await delay(10);
  }
}

test("end-to-end assistant: spawn → post → SecRouter reply, governed as owner + streamed + chained", async () => {
  const stub = await startStubSecrouter();
  const llm = makeLlmClient({ secrouterUrl: stub.url, secrouterToken: "svc-token" });
  const store = new MemoryStore();
  let hub: Hub | undefined;
  const server = createHttpServer({ verifyToken, store, llm, broadcast: (c, p) => hub?.broadcast(c, p) });
  hub = attachWsHub(server, { verifyToken });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=good`);
  const received: Array<{ type: string; message?: { authorType: string; content: string }; delta?: string }> = [];
  ws.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws failed to open")));
  });

  try {
    // spawn an assistant (creates its agent channel with the owner + agent as members)
    const spawned = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ name: "helper", model: "fast" }),
    });
    assert.equal(spawned.status, 201);
    const { channel } = (await spawned.json()) as { channel: { id: string } };

    ws.send(JSON.stringify({ type: "subscribe", channelId: channel.id }));
    await delay(50);

    // the human posts a prompt to the assistant channel
    const posted = await fetch(`${base}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ content: "hello assistant" }),
    });
    assert.equal(posted.status, 201); // the human's message returns immediately

    // the assistant reply streams in over WS: deltas, then the final agent message
    const agentMsg = await waitFor(() => received.find((e) => e.type === "message" && e.message?.authorType === "agent"));
    assert.equal(agentMsg.message!.content, "Hi there"); // concatenated SSE deltas
    assert.ok(received.some((e) => e.type === "assistant_delta")); // it actually streamed

    // (a) governed as the OWNER at SecRouter, not the prompter-in-general — here they're the same
    // user, but the header proves delegation fired
    assert.equal(stub.actingUser(), "user-1");

    // (c) the assistant turn is persisted and the chain still verifies
    const msgs = await store.listMessages(channel.id);
    const persistedAgent = msgs.find((m) => m.authorType === "agent");
    assert.ok(persistedAgent, "assistant message persisted");
    assert.equal(persistedAgent!.promptedBy, "user-1"); // provenance recorded
    assert.equal((await store.verifyChains()).messagesOk, true);
  } finally {
    ws.close();
    hub.close();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => stub.server.close(() => r()));
  }
});

// ── Sprint 3: the execute-gate, end to end ───────────────────────────────────────────────────
// Spawn a coding agent, then drive tool requests through the WHOLE stack (HTTP → control plane →
// gate → store) via a scripted runner. Proves decision #2 / review C1: a mutating tool is denied
// in plan mode, a non-owner can't authorize it, the owner's grant permits exactly ONE mutation,
// and read tools are always fine.

/** A runner the test drives by hand: it records the control plane's gate verdicts and lets the
 * test synthesize runner events (the real pi runner emits these; here the test does). */
function makeScriptedRunner() {
  let emit: ((sessionId: Id, event: RunnerEvent) => void) | undefined;
  const answers: Array<{ requestId: string; allow: boolean }> = [];
  const runner: Runner = {
    async start() {},
    async sendInput() {},
    async answerTool(_sessionId, requestId, decision) {
      answers.push({ requestId, allow: decision.allow });
    },
    async stop() {},
    onEvent(cb) {
      emit = cb;
    },
  };
  return { runner, answers, emit: (s: Id, e: RunnerEvent) => emit?.(s, e) };
}

const twoUsers: VerifyToken = async (token) => {
  if (token === "owner") return { sub: "user-1", groups: [] };
  if (token === "other") return { sub: "user-2", groups: [] };
  throw new Error("bad token");
};

test("end-to-end coding agent: bash denied in plan mode, allowed ONCE after the owner grants", async () => {
  const store = new MemoryStore();
  const scripted = makeScriptedRunner();
  const control = makeControlPlane({
    sessions: store,
    runner: scripted.runner,
    getAgent: (id) => store.getAgent(id),
  });
  const server = createHttpServer({ verifyToken: twoUsers, store, control });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  const owner = { authorization: "Bearer owner", "content-type": "application/json" };

  // emit a bash (mutating) tool_request for `sid` and return the gate's verdict
  const bash = async (sid: string, id: string) => {
    scripted.emit(sid, { type: "tool_request", tool: "bash", requestId: id });
    return (await waitFor(() => scripted.answers.find((a) => a.requestId === id))).allow;
  };

  try {
    // the owner spawns a coding agent (its channel + a runner session)
    const spawned = await fetch(`${base}/agents`, { method: "POST", headers: owner, body: JSON.stringify({ kind: "coding", name: "builder" }) });
    assert.equal(spawned.status, 201);
    const session = ((await spawned.json()) as { session: { id: string } }).session;
    assert.ok(session.id);

    // 1. a mutating tool in plan mode is DENIED
    assert.equal(await bash(session.id, "r1"), false);

    // 2. a NON-owner cannot authorize execution (C1)
    const denied = await fetch(`${base}/sessions/${session.id}/grant-execute`, {
      method: "POST", headers: { authorization: "Bearer other", "content-type": "application/json" }, body: JSON.stringify({ scope: "once" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(await bash(session.id, "r2"), false); // still denied

    // 3. the OWNER grants execute (once)
    const granted = await fetch(`${base}/sessions/${session.id}/grant-execute`, { method: "POST", headers: owner, body: JSON.stringify({ scope: "once" }) });
    assert.equal(granted.status, 200);

    // 4. exactly ONE mutation is now allowed; the grant is then consumed
    assert.equal(await bash(session.id, "r3"), true);
    assert.equal(await bash(session.id, "r4"), false);

    // 5. a read tool is always fine in plan mode (and never consumed the grant above)
    scripted.emit(session.id, { type: "tool_request", tool: "grep", requestId: "r5" });
    assert.equal((await waitFor(() => scripted.answers.find((a) => a.requestId === "r5"))).allow, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
