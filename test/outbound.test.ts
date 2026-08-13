// Unit tests for the outbound-webhook dispatcher (src/webhooks/outbound.ts) — signing, the
// allowlist, event matching, content filtering, and the retry policy — against a MemoryStore and a
// fake transport (no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { MemoryStore } from "../src/store/memory.ts";
import {
  makeOutboundDispatcher,
  signBody,
  isAllowedOutboundUrl,
  type FetchLike,
} from "../src/webhooks/outbound.ts";
import type { OutboundEvent } from "../src/types.ts";

const WORKSPACE = "ws-1";

/** A fake transport that records every request and returns scripted statuses (or throws on the
 * sentinel "throw"). */
function fakeFetch(script: number | Array<number | "throw">) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let i = 0;
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const s = Array.isArray(script) ? script[Math.min(i, script.length - 1)]! : script;
    i++;
    if (s === "throw") throw new Error("network down");
    return { status: s };
  };
  return { impl, calls };
}

async function channelWithHook(
  store: MemoryStore,
  opts: { events?: OutboundEvent[]; includeContent?: boolean; url?: string } = {},
) {
  const ch = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", createdBy: "alice" });
  const hook = await store.createOutboundWebhook({
    channelId: ch.id,
    url: opts.url ?? "https://example.test/hook",
    events: opts.events ?? ["message.created"],
    includeContent: opts.includeContent ?? false,
    createdBy: "alice",
  });
  return { ch, hook };
}

test("signBody is a stable sha256= HMAC a receiver can recompute", () => {
  const sig = signBody("s3cr3t", '{"a":1}');
  const expected = "sha256=" + createHmac("sha256", "s3cr3t").update('{"a":1}').digest("hex");
  assert.equal(sig, expected);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
});

test("isAllowedOutboundUrl: http(s) only, and honours a host allowlist", () => {
  assert.equal(isAllowedOutboundUrl("https://ok.test/x", []), true);
  assert.equal(isAllowedOutboundUrl("http://ok.test/x", []), true);
  assert.equal(isAllowedOutboundUrl("ftp://ok.test/x", []), false);
  assert.equal(isAllowedOutboundUrl("not a url", []), false);
  assert.equal(isAllowedOutboundUrl("https://ok.test/x", ["ok.test"]), true);
  assert.equal(isAllowedOutboundUrl("https://evil.test/x", ["ok.test"]), false);
});

test("dispatch delivers to a matching active hook: signed body, correct headers, status recorded", async () => {
  const store = new MemoryStore();
  const { ch, hook } = await channelWithHook(store, { events: ["message.created"] });
  const ft = fakeFetch(200);
  const d = makeOutboundDispatcher(store, { fetchImpl: ft.impl, backoffMs: 0, sleep: async () => {} });

  await d.dispatch(ch.id, "message.created", { messageId: "m1", content: "secret text" });

  assert.equal(ft.calls.length, 1);
  const call = ft.calls[0]!;
  assert.equal(call.url, hook.url);
  assert.equal(call.headers["x-sec-webhook-event"], "message.created");
  assert.equal(call.headers["x-sec-webhook-signature"], signBody(hook.secret, call.body));
  // includeContent=false ⇒ content stripped, metadata kept.
  const payload = JSON.parse(call.body);
  assert.equal(payload.data.messageId, "m1");
  assert.equal(payload.data.content, undefined);
  // Delivery status recorded on the row.
  const after = await store.getOutboundWebhook(ch.id, hook.id);
  assert.equal(after?.lastStatus, 200);
});

test("dispatch includes content only when the subscription opted in", async () => {
  const store = new MemoryStore();
  const { ch } = await channelWithHook(store, { includeContent: true });
  const ft = fakeFetch(200);
  const d = makeOutboundDispatcher(store, { fetchImpl: ft.impl, backoffMs: 0, sleep: async () => {} });

  await d.dispatch(ch.id, "message.created", { messageId: "m1", content: "hello" });
  assert.equal(JSON.parse(ft.calls[0]!.body).data.content, "hello");
});

test("dispatch skips inactive hooks and events a hook didn't subscribe to", async () => {
  const store = new MemoryStore();
  const { ch } = await channelWithHook(store, { events: ["channel.marked"] }); // NOT message.created
  const ft = fakeFetch(200);
  const d = makeOutboundDispatcher(store, { fetchImpl: ft.impl, backoffMs: 0, sleep: async () => {} });

  await d.dispatch(ch.id, "message.created", { messageId: "m1" });
  assert.equal(ft.calls.length, 0); // no matching subscription
});

test("deliver retries a 500 up to maxAttempts, then records the failure", async () => {
  const store = new MemoryStore();
  const { ch, hook } = await channelWithHook(store);
  const ft = fakeFetch([500, 500, 500]);
  const d = makeOutboundDispatcher(store, { fetchImpl: ft.impl, maxAttempts: 3, backoffMs: 0, sleep: async () => {} });

  await d.dispatch(ch.id, "message.created", { messageId: "m1" });
  assert.equal(ft.calls.length, 3); // retried to the cap
  assert.equal((await store.getOutboundWebhook(ch.id, hook.id))?.lastStatus, 500);
});

test("deliver does NOT retry a 4xx (the receiver rejected it)", async () => {
  const store = new MemoryStore();
  const { ch } = await channelWithHook(store);
  const ft = fakeFetch([400, 200]); // if it retried, the 2nd call would 200
  const d = makeOutboundDispatcher(store, { fetchImpl: ft.impl, maxAttempts: 3, backoffMs: 0, sleep: async () => {} });

  await d.dispatch(ch.id, "message.created", { messageId: "m1" });
  assert.equal(ft.calls.length, 1); // stopped on the 400
});

test("deliver retries a network error then succeeds; final status recorded", async () => {
  const store = new MemoryStore();
  const { ch, hook } = await channelWithHook(store);
  const ft = fakeFetch(["throw", 200]);
  const d = makeOutboundDispatcher(store, { fetchImpl: ft.impl, maxAttempts: 3, backoffMs: 0, sleep: async () => {} });

  await d.dispatch(ch.id, "message.created", { messageId: "m1" });
  assert.equal(ft.calls.length, 2);
  assert.equal((await store.getOutboundWebhook(ch.id, hook.id))?.lastStatus, 200);
});

test("deliverTest posts a {test:true} payload and returns the outcome", async () => {
  const store = new MemoryStore();
  const { hook } = await channelWithHook(store);
  const ft = fakeFetch(204);
  const d = makeOutboundDispatcher(store, { fetchImpl: ft.impl, backoffMs: 0, sleep: async () => {} });

  const result = await d.deliverTest(hook);
  assert.equal(result.status, 204);
  assert.equal(JSON.parse(ft.calls[0]!.body).data.test, true);
});
