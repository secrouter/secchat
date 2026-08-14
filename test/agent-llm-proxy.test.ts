// /agent-llm/v1 proxy tests — the ONLY path a coding-agent's pi CLI is allowed to reach SecRouter
// through (see src/http/server.ts's handleAgentLlmProxy + AgentLlmDeps). Runs the real HTTP server
// over a real socket, with a fake upstream http.Server standing in for SecRouter (same pattern as
// test/secrouter.test.ts) so the forwarded headers/body/streaming can be asserted directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { makeRunnerToken } from "../src/auth/runner-token.ts";
import type { VerifyToken } from "../src/types.ts";

// A principal verifier that never accepts a runner token — proves the proxy's auth is genuinely
// separate from this path (a runner token must never fall back to being treated as a bearer).
const verifyToken: VerifyToken = async (token) => {
  if (token === "good") return { sub: "user-1", groups: [] };
  throw new Error("invalid token");
};

/** Starts a fake SecRouter: records the request it received and replies with `reply`. */
function startFakeSecRouter(
  handler: (req: { headers: IncomingHttpHeaders; body: string; url: string | undefined }, res: import("node:http").ServerResponse) => void,
) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      handler({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), url: req.url }, res);
    });
  });
  return server;
}

async function listen(server: import("node:http").Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test("POST /agent-llm/v1/chat/completions — no bearer at all is 401, upstream never called", async () => {
  let upstreamHit = false;
  const upstream = startFakeSecRouter((_req, res) => {
    upstreamHit = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const secrouterUrl = await listen(upstream);
  const runnerToken = makeRunnerToken("secret", 3600);
  const server = createHttpServer({
    verifyToken,
    store: new MemoryStore(),
    runnerToken,
    agentLlm: { secrouterUrl },
  });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/agent-llm/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    assert.equal(res.status, 401);
    assert.equal(upstreamHit, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("POST /agent-llm/v1/chat/completions — a valid PRINCIPAL bearer (not a runner token) is still 401", async () => {
  const upstream = startFakeSecRouter((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const secrouterUrl = await listen(upstream);
  const runnerToken = makeRunnerToken("secret", 3600);
  const server = createHttpServer({
    verifyToken,
    store: new MemoryStore(),
    runnerToken,
    agentLlm: { secrouterUrl },
  });
  const base = await listen(server);
  try {
    // "good" verifies fine as a PRINCIPAL bearer elsewhere in this server, but it is not a runner
    // token — the proxy's own verifier must reject it exactly like any other garbage string.
    const res = await fetch(`${base}/agent-llm/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("POST /agent-llm/v1/chat/completions — authenticated, non-streaming: forwards Authorization + X-Sec-Acting-User, propagates status+body", async () => {
  let captured: { headers: IncomingHttpHeaders; body: string; url: string | undefined } | undefined;
  const upstream = startFakeSecRouter((req, res) => {
    captured = req;
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "hi" } }] }));
  });
  const secrouterUrl = await listen(upstream);
  const runnerToken = makeRunnerToken("secret", 3600);
  const server = createHttpServer({
    verifyToken,
    store: new MemoryStore(),
    runnerToken,
    agentLlm: { secrouterUrl, getServiceToken: async () => "fresh-svc-token" },
  });
  const base = await listen(server);
  try {
    const rt = await runnerToken.mint("alice");
    const res = await fetch(`${base}/agent-llm/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${rt}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
    });
    // SecRouter's status code (201, deliberately non-200 here) is propagated unchanged.
    assert.equal(res.status, 201);
    const json = (await res.json()) as { id: string };
    assert.equal(json.id, "chatcmpl-1");

    assert.ok(captured);
    assert.equal(captured!.url, "/v1/chat/completions");
    assert.equal(captured!.headers["authorization"], "Bearer fresh-svc-token");
    // The delegation trigger: SecRouter attributes policy/budget/audit to the runner token's OWNER
    // (alice), never to SecChat's own svc-secchat identity.
    assert.equal(captured!.headers["x-sec-acting-user"], "alice");
    const forwardedBody = JSON.parse(captured!.body);
    assert.equal(forwardedBody.model, "claude-x");
    assert.deepEqual(forwardedBody.messages, [{ role: "user", content: "hi" }]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("POST /agent-llm/v1/chat/completions — stream:true pipes SecRouter's SSE straight through, unbuffered", async () => {
  const upstream = startFakeSecRouter((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":", world"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 15);
  });
  const secrouterUrl = await listen(upstream);
  const runnerToken = makeRunnerToken("secret", 3600);
  const server = createHttpServer({
    verifyToken,
    store: new MemoryStore(),
    runnerToken,
    agentLlm: { secrouterUrl, getServiceToken: async () => "fresh-svc-token" },
  });
  const base = await listen(server);
  try {
    const rt = await runnerToken.mint("bob");
    const res = await fetch(`${base}/agent-llm/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${rt}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-x", messages: [], stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /Hello/);
    assert.match(text, /, world/);
    assert.match(text, /\[DONE\]/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("POST /agent-llm/v1/chat/completions — dev fallback: no getServiceToken configured ⇒ no Authorization header forwarded", async () => {
  let captured: { headers: IncomingHttpHeaders } | undefined;
  const upstream = startFakeSecRouter((req, res) => {
    captured = req;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const secrouterUrl = await listen(upstream);
  const runnerToken = makeRunnerToken("secret", 3600);
  const server = createHttpServer({
    verifyToken,
    store: new MemoryStore(),
    runnerToken,
    agentLlm: { secrouterUrl }, // no getServiceToken — open dev gateway
  });
  const base = await listen(server);
  try {
    const rt = await runnerToken.mint("carol");
    const res = await fetch(`${base}/agent-llm/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${rt}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-x", messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.ok(captured);
    assert.equal(captured!.headers["authorization"], undefined);
    // The acting-user delegation header is still sent unconditionally, security or not.
    assert.equal(captured!.headers["x-sec-acting-user"], "carol");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("GET /agent-llm/v1/models — authenticated, forwards to SecRouter's /v1/models and propagates the body", async () => {
  let captured: { headers: IncomingHttpHeaders; url: string | undefined } | undefined;
  const upstream = startFakeSecRouter((req, res) => {
    captured = req;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "claude-x" }] }));
  });
  const secrouterUrl = await listen(upstream);
  const runnerToken = makeRunnerToken("secret", 3600);
  const server = createHttpServer({
    verifyToken,
    store: new MemoryStore(),
    runnerToken,
    agentLlm: { secrouterUrl, getServiceToken: async () => "fresh-svc-token" },
  });
  const base = await listen(server);
  try {
    const rt = await runnerToken.mint("dave");
    const res = await fetch(`${base}/agent-llm/v1/models`, {
      headers: { authorization: `Bearer ${rt}` },
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(json.data, [{ id: "claude-x" }]);
    assert.ok(captured);
    assert.equal(captured!.url, "/v1/models");
    assert.equal(captured!.headers["authorization"], "Bearer fresh-svc-token");
    assert.equal(captured!.headers["x-sec-acting-user"], "dave");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("GET /agent-llm/v1/models — unauthenticated is 401", async () => {
  const runnerToken = makeRunnerToken("secret", 3600);
  const server = createHttpServer({
    verifyToken,
    store: new MemoryStore(),
    runnerToken,
    agentLlm: { secrouterUrl: "http://127.0.0.1:1" }, // never reached
  });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/agent-llm/v1/models`);
    assert.equal(res.status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("/agent-llm/v1/* unwired (no deps.agentLlm) falls through — a runner token is just an unrecognized bearer (401)", async () => {
  const server = createHttpServer({ verifyToken, store: new MemoryStore() }); // no agentLlm, no runnerToken
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/agent-llm/v1/models`, { headers: { authorization: "Bearer whatever" } });
    assert.equal(res.status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
