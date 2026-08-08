// The Sprint 1 walking-skeleton proof: the real modules wired together (MemoryStore + HTTP +
// WS hub, exactly as index.ts wires them) carry a message end-to-end —
//   authed HTTP POST → persisted into the tamper-evident chain → broadcast to a WS subscriber.
// Auth itself is covered in test/auth.test.ts against a real JWKS; here a fake verifier stands
// in for the IdP so the test needs no network, and the focus is the wiring + realtime + chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHttpServer } from "../src/http/server.ts";
import { makeLlmClient } from "../src/secrouter/client.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { attachWsHub, type Hub } from "../src/ws/hub.ts";
import type { Principal, VerifyToken } from "../src/types.ts";

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
