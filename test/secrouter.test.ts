// Offline SecRouter LLM client tests: a loopback-only http.Server stands in for SecRouter's
// OpenAI-compatible /v1/chat/completions endpoint, so makeLlmClient exercises its real
// fetch-and-parse-SSE path (see src/secrouter/client.ts) without ever touching a real SecRouter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import type { LlmMessage } from "../src/types.ts";
import { makeLlmClient } from "../src/secrouter/client.ts";

const MESSAGES: LlmMessage[] = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "Say hi." },
];

test("makeLlmClient — streams assistant deltas parsed from SecRouter's SSE response", async () => {
  let capturedHeaders: IncomingHttpHeaders = {};
  let capturedBody = "";

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      capturedHeaders = req.headers;
      capturedBody = Buffer.concat(chunks).toString("utf8");

      res.writeHead(200, { "content-type": "text/event-stream" });

      // Frame 1, written whole.
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');

      // Frame 2 is deliberately cut mid-line, and the remainder only follows after a real delay
      // so the two halves land as SEPARATE reads on the client (not coalesced into one) — this
      // is what exercises the client's buffering of a partial trailing SSE line across reads.
      res.write('data: {"choices":[{"delta":{"content":", ');
      setTimeout(() => {
        res.write('"}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\n');

        setTimeout(() => {
          // A chunk with no content delta at all must be skipped, not yielded as "undefined".
          res.write('data: {"choices":[{"delta":{}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":"!"}}]}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
        }, 15);
      }, 15);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  try {
    const { port } = server.address() as AddressInfo;
    const client = makeLlmClient({ secrouterUrl: `http://127.0.0.1:${port}`, secrouterToken: "test-token-123" });

    const deltas: string[] = [];
    for await (const delta of client.complete({ model: "claude-x", messages: MESSAGES, actingUser: "user-42", classification: "CUI" })) {
      deltas.push(delta);
    }

    assert.equal(deltas.join(""), "Hello, world!");

    assert.equal(capturedHeaders["x-sec-acting-user"], "user-42");
    // The content's classification level rides the trusted header SecRouter's clearance +
    // data-residency egress gate keys on (F1 — closes the marking→gateway loop).
    assert.equal(capturedHeaders["x-data-classification"], "CUI");
    assert.equal(capturedHeaders["authorization"], "Bearer test-token-123");

    const body = JSON.parse(capturedBody);
    assert.equal(body.stream, true);
    assert.equal(body.model, "claude-x");
    assert.deepEqual(body.messages, MESSAGES);
  } finally {
    server.close();
  }
});

test("makeLlmClient — a non-2xx response throws on iteration, and omits Authorization without a token", async () => {
  let capturedHeaders: IncomingHttpHeaders = {};

  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      capturedHeaders = req.headers;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  try {
    const { port } = server.address() as AddressInfo;
    // No secrouterToken configured this time.
    const client = makeLlmClient({ secrouterUrl: `http://127.0.0.1:${port}` });

    await assert.rejects(async () => {
      for await (const _delta of client.complete({ model: "claude-x", messages: MESSAGES, actingUser: "user-42" })) {
        // Draining is enough to trigger the throw — the request fails before any delta streams.
      }
    }, /500/);

    assert.equal(capturedHeaders["x-sec-acting-user"], "user-42"); // still sent even without a token
    assert.equal(capturedHeaders["authorization"], undefined);
    // No classification supplied ⇒ header omitted — SecRouter falls back to its configured
    // default, exactly the pre-F1 behavior.
    assert.equal(capturedHeaders["x-data-classification"], undefined);
  } finally {
    server.close();
  }
});
