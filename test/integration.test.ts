// The Sprint 1 walking-skeleton proof: the real modules wired together (MemoryStore + HTTP +
// WS hub, exactly as index.ts wires them) carry a message end-to-end —
//   authed HTTP POST → persisted into the tamper-evident chain → broadcast to a WS subscriber.
// Auth itself is covered in test/auth.test.ts against a real JWKS; here a fake verifier stands
// in for the IdP so the test needs no network, and the focus is the wiring + realtime + chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer } from "../src/http/server.ts";
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
