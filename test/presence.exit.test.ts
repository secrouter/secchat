// T3 EXIT TEST — GET /presence returns the injected online roster (the hub's onlineSubs, wired in
// index.ts). The live online/offline transitions are covered by the hub tests in ws.test.ts; this
// pins the HTTP-layer contract that seeds the client's presence set on load.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  if (token === "alice") return { sub: "alice", groups: [] };
  throw new Error("invalid token");
};

test("GET /presence returns the currently-online subs; unauthenticated is 401", async () => {
  const server = createHttpServer({
    verifyToken,
    store: new MemoryStore(),
    presence: () => ["alice", "bob"],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/presence`, { headers: { authorization: "Bearer alice" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { online: string[] };
    assert.deepEqual(body.online.sort(), ["alice", "bob"]);

    // Presence still requires authentication like every other route.
    assert.equal((await fetch(`${base}/presence`)).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
