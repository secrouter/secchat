// GET /calls/:id (http/server.ts, docs/plans/voice-calls-plan.md §3.1) — state for a reconnecting
// client. Minimal fakes (only `isMember` is called by this route) over a real socket, matching
// test/http.test.ts's own "MINIMAL fake Store, cast through unknown" convention.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http/server.ts";
import type { CallRegistry, LiveCall } from "../src/calls/registry.ts";
import type { Store, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  if (token === "alice") return { sub: "alice", groups: [] };
  if (token === "mallory") return { sub: "mallory", groups: [] };
  throw new Error("invalid token");
};

// alice is a member of "dm-1"; mallory is a member of nothing.
const fakeStore = {
  async isMember(channelId: string, sub: string) {
    return channelId === "dm-1" && sub === "alice";
  },
} as unknown as Store;

function fakeCallsWith(live: LiveCall | undefined): CallRegistry {
  return {
    async invite() {
      throw new Error("not used by this test");
    },
    async startSolo() {
      throw new Error("not used by this test");
    },
    async accept() {
      throw new Error("not used by this test");
    },
    async relay() {},
    async end() {},
    untrackConnection() {},
    getActiveCall: () => live,
    async checkRingingTimeouts() {
      return [];
    },
  };
}

let server: Server;
let base: string;

before(async () => {
  const live: LiveCall = {
    channelId: "dm-1",
    caller: "alice",
    callee: "bob",
    state: "active",
    wantRecording: true,
    callerConnId: "conn-a", // internal — must NOT leak into the response
    calleeConnId: "conn-b", // internal — must NOT leak into the response
    mode: "p2p",
    consent: false,
    callId: "call-99",
    mediadSessionId: "sess-should-not-leak", // internal mediad correlation — must NOT leak either
  };
  server = createHttpServer({ verifyToken, store: fakeStore, calls: fakeCallsWith(live) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("GET /calls/:id: a DM member reading an active call gets its signaling state, with internal fields projected away", async () => {
  const res = await fetch(`${base}/calls/dm-1`, { headers: { Authorization: "Bearer alice" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  // deepEqual checks own enumerable properties in BOTH directions — this also proves the internal
  // bookkeeping (callerConnId/calleeConnId/mediadSessionId) is NOT present on the response, not
  // just that these 8 fields are.
  assert.deepEqual(body, {
    channelId: "dm-1",
    caller: "alice",
    callee: "bob",
    state: "active",
    wantRecording: true,
    mode: "p2p",
    consent: false,
    callId: "call-99",
  });
});

test("GET /calls/:id: a non-member is forbidden (403) — never leaks whether a call is live", async () => {
  const res = await fetch(`${base}/calls/dm-1`, { headers: { Authorization: "Bearer mallory" } });
  assert.equal(res.status, 403);
});

test("GET /calls/:id: a member with no active call gets 404 no_active_call", async () => {
  const noCallServer = createHttpServer({ verifyToken, store: fakeStore, calls: fakeCallsWith(undefined) });
  await new Promise<void>((resolve) => noCallServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = noCallServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/calls/dm-1`, { headers: { Authorization: "Bearer alice" } });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "no_active_call" });
  } finally {
    await new Promise<void>((resolve) => noCallServer.close(() => resolve()));
  }
});

test("GET /calls/:id: calls not configured at all -> 501", async () => {
  const unconfigured = createHttpServer({ verifyToken, store: fakeStore });
  await new Promise<void>((resolve) => unconfigured.listen(0, "127.0.0.1", resolve));
  try {
    const address = unconfigured.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/calls/dm-1`, { headers: { Authorization: "Bearer alice" } });
    assert.equal(res.status, 501);
  } finally {
    await new Promise<void>((resolve) => unconfigured.close(() => resolve()));
  }
});
