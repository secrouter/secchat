// RT EXIT TESTS — the cookie-mode runner token. A client mints a short-lived owner-scoped token
// (POST /auth/runner-token) and a daemon attaches at /runner with it. Also checks the token is a
// DISJOINT trust domain from the step-up token (can't be cross-used). Runs the real HTTP server +
// runner hub over a real socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { makeRunnerToken } from "../src/auth/runner-token.ts";
import { makeStepUp } from "../src/auth/stepup.ts";
import { makeRemoteRunner } from "../src/agent/remote-runner.ts";
import { RunnerRegistry } from "../src/agent/runner-registry.ts";
import { attachRunnerHub } from "../src/ws/runner-hub.ts";
import type { VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  if (token === "alice") return { sub: "alice", groups: [] };
  throw new Error("invalid token"); // NOTE: rejects everything else — incl. a runner token
};

const h = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
const waitFor = async (p: () => boolean, ms = 1500) => {
  const s = Date.now();
  while (!p()) {
    if (Date.now() - s > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("mint via POST /auth/runner-token, then a daemon attaches at /runner with it", async () => {
  const store = new MemoryStore();
  const registry = new RunnerRegistry();
  const remote = makeRemoteRunner({ registry });
  const runnerToken = makeRunnerToken("test-secret", 3600);
  const server = createHttpServer({ verifyToken, store, runnerToken });
  attachRunnerHub(server, { verifyToken, registry, remote, verifyRunnerToken: (t) => runnerToken.verify(t) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    // alice (a session/bearer user) mints a runner token for her daemon.
    const res = await fetch(`${base}/auth/runner-token`, { method: "POST", headers: h("alice") });
    assert.equal(res.status, 200);
    const { token } = (await res.json()) as { token: string };
    assert.ok(token && token.split(".").length === 3, "a JWT was minted");

    // The daemon attaches with the RUNNER token (not a bearer verifyToken would accept) → registered as alice.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/runner?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("attach failed")), { once: true });
    });
    await waitFor(() => registry.has("alice"));
    assert.ok(registry.has("alice"), "the runner-token daemon registered as its owner");
    socket.close();

    // Unauthenticated mint is refused.
    assert.equal((await fetch(`${base}/auth/runner-token`, { method: "POST" })).status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a runner token is a disjoint trust domain — a step-up token can't attach, nor vice-versa", async () => {
  const secret = "shared-secret"; // even with a SHARED secret, the iss/aud pin keeps them separate
  const runnerToken = makeRunnerToken(secret, 3600);
  const stepUp = makeStepUp(secret, 3600);

  const rt = await runnerToken.mint("alice");
  const st = await stepUp.mint("alice");

  assert.equal((await runnerToken.verify(rt))?.sub, "alice"); // a runner token verifies as a runner token
  assert.equal(await runnerToken.verify(st), null); // a step-up token is NOT a runner token
  assert.equal(await stepUp.verify(rt), null); // and a runner token is NOT a step-up proof
});

test("POST /auth/runner-token is 503 when no signing secret is configured", async () => {
  const server = createHttpServer({ verifyToken, store: new MemoryStore() }); // no runnerToken
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/auth/runner-token`, { method: "POST", headers: h("alice") })).status, 503);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
