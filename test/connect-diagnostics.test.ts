// RD6 — the runner daemon's connect DIAGNOSTICS (src/daemon/connect-diagnostics.ts). The daemon's
// built-in WebSocket hides WHY an attach fails (empty error, bare 1006 close), so on a failed attach it
// replays the handshake over http(s) and classifies the result. This covers both halves: the pure
// mapping (probe outcome → operator summary + hint, backoff) and the real probe against local servers
// (401/403 token rejection, 101 reachable, connection refused, timeout).

import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, diagnoseConnect, firstErrorCode, probeHandshake } from "../src/daemon/connect-diagnostics.ts";

// ---------------------------------------------------------------------------------------
// diagnoseConnect — pure outcome → diagnosis mapping
// ---------------------------------------------------------------------------------------

test("diagnoseConnect: a rejected token (401/403) points at SECCHAT_RUNNER_TOKEN", () => {
  for (const status of [401, 403]) {
    const d = diagnoseConnect({ kind: "status", status });
    assert.match(d.summary, new RegExp(`HTTP ${status}`));
    assert.ok(d.hint, "a token rejection carries a remediation hint");
    assert.match(d.hint!, /SECCHAT_RUNNER_TOKEN/);
  }
});

test("diagnoseConnect: an untrusted TLS chain gives the CA-root / NODE_EXTRA_CA_CERTS hint", () => {
  // The exact bug that was undiagnosable: server serves leaf+intermediate, the root isn't trusted.
  const d = diagnoseConnect({ kind: "error", code: "UNABLE_TO_GET_ISSUER_CERT" });
  assert.match(d.summary, /not trusted \[UNABLE_TO_GET_ISSUER_CERT\]/);
  assert.ok(d.hint, "a TLS-trust failure carries a remediation hint");
  assert.match(d.hint!, /NODE_EXTRA_CA_CERTS/);
  assert.match(d.hint!, /root/i, "the hint calls out that the ROOT (not just leaf+intermediate) is needed");
  // A self-signed cert in the chain is the same class of problem and gets the same hint.
  assert.ok(diagnoseConnect({ kind: "error", code: "SELF_SIGNED_CERT_IN_CHAIN" }).hint);
});

test("diagnoseConnect: network errors name the likely cause without a hint", () => {
  assert.match(diagnoseConnect({ kind: "error", code: "ECONNREFUSED" }).summary, /refused .*server running/);
  assert.match(diagnoseConnect({ kind: "error", code: "ENOTFOUND" }).summary, /host not found .*hostname/);
  assert.match(diagnoseConnect({ kind: "timeout" }).summary, /timed out .*SECCHAT_URL/);
  // No actionable single fix ⇒ no hint (avoids crying wolf).
  assert.equal(diagnoseConnect({ kind: "error", code: "ECONNREFUSED" }).hint, undefined);
});

test("diagnoseConnect: a 101 means the attach actually works now (transient drop, no hint)", () => {
  const d = diagnoseConnect({ kind: "status", status: 101 });
  assert.match(d.summary, /reachable and token accepted/);
  assert.equal(d.hint, undefined);
});

test("diagnoseConnect: an unknown transport error still yields a loggable summary", () => {
  assert.match(diagnoseConnect({ kind: "error", code: "EWEIRD" }).summary, /\[EWEIRD\]/);
  assert.match(diagnoseConnect({ kind: "error", message: "boom" }).summary, /\(boom\)/);
  assert.match(diagnoseConnect({ kind: "error" }).summary, /unknown transport error/);
  assert.match(diagnoseConnect({ kind: "status", status: 500 }).summary, /unexpected HTTP 500/);
});

// ---------------------------------------------------------------------------------------
// firstErrorCode — dig the real errno out of a nested / aggregate error
// ---------------------------------------------------------------------------------------

test("firstErrorCode: walks the cause chain and AggregateError.errors", () => {
  assert.equal(firstErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), "ECONNREFUSED");
  assert.equal(firstErrorCode(new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ENOTFOUND" }) })), "ENOTFOUND");
  const agg = new AggregateError([new Error("a"), Object.assign(new Error("b"), { code: "UNABLE_TO_GET_ISSUER_CERT" })]);
  assert.equal(firstErrorCode(agg), "UNABLE_TO_GET_ISSUER_CERT");
  assert.equal(firstErrorCode(null), undefined);
  assert.equal(firstErrorCode({}), undefined);
});

// ---------------------------------------------------------------------------------------
// backoffDelay — exponential with a cap; base on the first failure
// ---------------------------------------------------------------------------------------

test("backoffDelay: base, then doubles, capped at max", () => {
  assert.equal(backoffDelay(1, 2_000, 30_000), 2_000); // first failure ⇒ base
  assert.equal(backoffDelay(2, 2_000, 30_000), 4_000);
  assert.equal(backoffDelay(3, 2_000, 30_000), 8_000);
  assert.equal(backoffDelay(4, 2_000, 30_000), 16_000);
  assert.equal(backoffDelay(5, 2_000, 30_000), 30_000); // 32_000 clamped
  assert.equal(backoffDelay(50, 2_000, 30_000), 30_000); // never overflows the cap
  assert.equal(backoffDelay(0, 2_000, 30_000), 2_000); // defensive: never below base
});

// ---------------------------------------------------------------------------------------
// probeHandshake — the real handshake replay against local servers
// ---------------------------------------------------------------------------------------

/** Start an http server that answers a WS upgrade with a fixed raw status line, and return its ws URL. */
async function upgradeServer(raw: string): Promise<{ url: string; server: Server }> {
  const server = createServer();
  server.on("upgrade", (_req, socket) => {
    socket.write(raw);
    if (!raw.startsWith("HTTP/1.1 101")) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}/runner?token=t`, server };
}

test("probeHandshake: a 401 upgrade rejection surfaces the HTTP status (the token signal)", async () => {
  const { url, server } = await upgradeServer("HTTP/1.1 401 Unauthorized\r\n\r\n");
  try {
    assert.deepEqual(await probeHandshake(url, 2_000), { kind: "status", status: 401 });
  } finally {
    server.close();
  }
});

test("probeHandshake: a 101 upgrade is reported as reachable+authed", async () => {
  const { url, server } = await upgradeServer("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  try {
    assert.deepEqual(await probeHandshake(url, 2_000), { kind: "status", status: 101 });
  } finally {
    server.close();
  }
});

test("probeHandshake: a refused connection surfaces ECONNREFUSED (not a bare failure)", async () => {
  // Bind a port, then free it, so the address is guaranteed refused.
  const tmp = createNetServer();
  await new Promise<void>((r) => tmp.listen(0, "127.0.0.1", () => r()));
  const port = (tmp.address() as AddressInfo).port;
  await new Promise<void>((r) => tmp.close(() => r()));
  const res = await probeHandshake(`ws://127.0.0.1:${port}/runner`, 2_000);
  assert.deepEqual(res, { kind: "error", code: "ECONNREFUSED", message: res.kind === "error" ? res.message : "" });
  assert.equal(res.kind, "error");
});

test("probeHandshake: a silent server yields a timeout result (never hangs)", async () => {
  // Accept the TCP connection but never answer, so only the client-side deadline fires.
  const dead = createNetServer(() => {});
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
  const port = (dead.address() as AddressInfo).port;
  try {
    assert.deepEqual(await probeHandshake(`ws://127.0.0.1:${port}/runner`, 150), { kind: "timeout" });
  } finally {
    dead.close();
  }
});

test("probeHandshake: a malformed URL is reported, not thrown", async () => {
  const res = await probeHandshake("not-a-url");
  assert.equal(res.kind, "error");
});
