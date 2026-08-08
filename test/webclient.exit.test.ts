// Sprint 6 EXIT TESTS — the minimal web client + its dev-auth + static serving (red until built).
// The SPA itself (browser JS) is verified by screenshot; these lock the backend contract it needs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { devVerifyToken } from "../src/dev/auth.ts";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";

// Dev tokens are "dev.<sub>.<comma-separated-groups>" — DEV ONLY (real auth is SecSSO JWTs via JWKS).
test("exit 1 — devVerifyToken parses a dev token into a principal, rejects junk", async () => {
  const p = await devVerifyToken("dev.alice.eng,secchat-admins");
  assert.equal(p.sub, "alice");
  assert.deepEqual(p.groups, ["eng", "secchat-admins"]);
  assert.deepEqual((await devVerifyToken("dev.bob.")).groups, []); // no groups
  await assert.rejects(() => devVerifyToken("not-a-dev-token"));
});

function devServer() {
  return createHttpServer({ verifyToken: devVerifyToken, store: new MemoryStore(), web: { root: "src/web" } });
}

test("exit 2 — the SPA + assets are served publicly with the right content-types", async () => {
  const server = devServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await index.text(), /SecChat/);

    const js = await fetch(`${base}/assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);

    const css = await fetch(`${base}/assets/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    // no file outside assets/ is ever served (fetch normalizes a literal `..` to /config.ts,
    // which hits the auth gate; a percent-encoded traversal is caught by the server's guard —
    // either way the property that matters holds: never a 200 for something outside assets/)
    assert.notEqual((await fetch(`${base}/assets/../config.ts`)).status, 200);
    assert.notEqual((await fetch(`${base}/assets/%2e%2e%2fconfig.ts`)).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("exit 3 — a dev token authenticates the real API end-to-end", async () => {
  const server = devServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  const h = { authorization: "Bearer dev.alice.", "content-type": "application/json" };
  try {
    const me = await fetch(`${base}/me`, { headers: h });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { sub: string }).sub, "alice");

    const ch = await fetch(`${base}/channels`, { method: "POST", headers: h, body: JSON.stringify({ name: "general" }) });
    assert.equal(ch.status, 201);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
