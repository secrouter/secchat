// Unit tests for the SecRouter client-credentials service-token provider — the grant, caching,
// refresh-before-expiry, and concurrent-call coalescing — against a fake token endpoint.

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeServiceTokenProvider, type ServiceTokenConfig } from "../src/secrouter/token.ts";

const CFG: ServiceTokenConfig = {
  tokenUrl: "https://secsso.test/application/o/token/",
  clientId: "svc-secchat",
  clientSecret: "shh",
  scope: "secrouter",
};

/** A fake token endpoint that records calls and returns scripted access tokens + TTLs. */
function fakeTokenEndpoint(tokens: Array<{ access_token: string; expires_in?: number } | { status: number }>) {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, body: init.body });
    const t = tokens[Math.min(i, tokens.length - 1)]!;
    i++;
    if ("status" in t) return { ok: false, status: t.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => t };
  };
  return { fetchImpl, calls };
}

test("get() performs a client_credentials grant with the configured client + scope", async () => {
  const ep = fakeTokenEndpoint([{ access_token: "tok-1", expires_in: 300 }]);
  const p = makeServiceTokenProvider(CFG, { fetchImpl: ep.fetchImpl, now: () => 0 });
  assert.equal(await p.get(), "tok-1");
  assert.equal(ep.calls.length, 1);
  const params = new URLSearchParams(ep.calls[0]!.body);
  assert.equal(params.get("grant_type"), "client_credentials");
  assert.equal(params.get("client_id"), "svc-secchat");
  assert.equal(params.get("client_secret"), "shh");
  assert.equal(params.get("scope"), "secrouter");
});

test("a cached token is reused until it nears expiry, then refreshed", async () => {
  const ep = fakeTokenEndpoint([
    { access_token: "tok-1", expires_in: 300 },
    { access_token: "tok-2", expires_in: 300 },
  ]);
  let clock = 0;
  const p = makeServiceTokenProvider(CFG, { fetchImpl: ep.fetchImpl, now: () => clock, skewMs: 60_000 });

  assert.equal(await p.get(), "tok-1");
  clock = 100_000; // well inside the 300s TTL (minus 60s skew) → still cached
  assert.equal(await p.get(), "tok-1");
  assert.equal(ep.calls.length, 1);

  clock = 250_000; // past (300s - 60s skew) → refresh
  assert.equal(await p.get(), "tok-2");
  assert.equal(ep.calls.length, 2);
});

test("concurrent get() calls coalesce onto a single grant", async () => {
  const ep = fakeTokenEndpoint([{ access_token: "tok-1", expires_in: 300 }]);
  const p = makeServiceTokenProvider(CFG, { fetchImpl: ep.fetchImpl, now: () => 0 });
  const [a, b, c] = await Promise.all([p.get(), p.get(), p.get()]);
  assert.deepEqual([a, b, c], ["tok-1", "tok-1", "tok-1"]);
  assert.equal(ep.calls.length, 1); // one grant, not three
});

test("a failed grant rejects and does not cache", async () => {
  const ep = fakeTokenEndpoint([{ status: 401 }, { access_token: "tok-ok", expires_in: 300 }]);
  const p = makeServiceTokenProvider(CFG, { fetchImpl: ep.fetchImpl, now: () => 0 });
  await assert.rejects(() => p.get(), /status 401/);
  // A subsequent call retries (nothing cached) and succeeds.
  assert.equal(await p.get(), "tok-ok");
});
