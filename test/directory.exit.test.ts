// Sprint 13 EXIT TESTS — the seen-users directory (captured from SSO tokens) and 1:1 DMs built on
// it. Runs the real MemoryStore behind the real HTTP layer over a socket (no fakes for the store —
// upsertUser/findDmChannel are exactly what's under test), with a token→Principal verifier standing
// in for the JWKS verifier.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Channel, Store, User, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  switch (token) {
    case "alice":
      return { sub: "alice", email: "alice@example.mil", displayName: "Alice Ng", groups: ["eng", "secchat-admins"] };
    case "bob":
      return { sub: "bob", email: "bob@example.mil", groups: ["eng"] };
    case "carol":
      return { sub: "carol", groups: ["security"] }; // no email/displayName (a thin token)
    default:
      throw new Error("invalid token");
  }
};

async function withServer(fn: (base: string, store: Store) => Promise<void>): Promise<void> {
  const store = new MemoryStore();
  const server = createHttpServer({ verifyToken, store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

// Loading the app (GET /me) is what puts a principal in the directory.
async function signIn(base: string, token: string): Promise<void> {
  const res = await fetch(`${base}/me`, { headers: h(token) });
  assert.equal(res.status, 200);
}

test("GET /me records the caller in the directory with their real groups", async () => {
  await withServer(async (base) => {
    await signIn(base, "alice");
    const res = await fetch(`${base}/users`, { headers: h("alice") });
    assert.equal(res.status, 200);
    const users = (await res.json()) as User[];
    const alice = users.find((u) => u.sub === "alice");
    assert.ok(alice, "alice is in the directory after loading /me");
    assert.deepEqual(alice!.groups, ["eng", "secchat-admins"]);
    assert.equal(alice!.email, "alice@example.mil");
    assert.equal(alice!.displayName, "Alice Ng");
  });
});

test("GET /users lists everyone who has signed in", async () => {
  await withServer(async (base) => {
    await signIn(base, "alice");
    await signIn(base, "bob");
    const users = (await (await fetch(`${base}/users`, { headers: h("bob") })).json()) as User[];
    assert.deepEqual(users.map((u) => u.sub).sort(), ["alice", "bob"]);
    // carol has NOT signed in, so she isn't discoverable yet (seen-users semantics).
    assert.ok(!users.some((u) => u.sub === "carol"));
  });
});

test("GET /groups derives groups from the directory's real claims", async () => {
  await withServer(async (base) => {
    await signIn(base, "alice"); // eng, secchat-admins
    await signIn(base, "bob"); // eng
    await signIn(base, "carol"); // security
    const groups = (await (await fetch(`${base}/groups`, { headers: h("alice") })).json()) as Array<{
      name: string;
      members: string[];
    }>;
    const byName = new Map(groups.map((g) => [g.name, g.members.sort()]));
    assert.deepEqual(byName.get("eng"), ["alice", "bob"]);
    assert.deepEqual(byName.get("secchat-admins"), ["alice"]);
    assert.deepEqual(byName.get("security"), ["carol"]);
  });
});

test("POST /dm opens a 1:1 channel with both members, idempotently", async () => {
  await withServer(async (base) => {
    await signIn(base, "alice");
    await signIn(base, "bob");

    const first = await fetch(`${base}/dm`, { method: "POST", headers: h("alice"), body: JSON.stringify({ user: "bob" }) });
    assert.equal(first.status, 201);
    const dm = (await first.json()) as Channel & { members?: string[] };
    assert.equal(dm.kind, "dm");
    // The response carries both members so the client can label the DM with the
    // peer immediately, without waiting for a GET /channels refetch.
    assert.deepEqual(dm.members!.sort(), ["alice", "bob"]);

    // Idempotent: a second request (from either side) returns the SAME channel, 200 not 201.
    const again = await fetch(`${base}/dm`, { method: "POST", headers: h("bob"), body: JSON.stringify({ user: "alice" }) });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as Channel).id, dm.id);

    // It shows up for BOTH participants in GET /channels, carrying the member subs.
    for (const token of ["alice", "bob"]) {
      const chans = (await (await fetch(`${base}/channels`, { headers: h(token) })).json()) as Array<
        Channel & { members?: string[] }
      >;
      const seen = chans.find((c) => c.id === dm.id);
      assert.ok(seen, `${token} sees the DM`);
      assert.deepEqual(seen!.members!.sort(), ["alice", "bob"]);
    }
  });
});

test("POST /dm rejects self-DM (400) and an unknown/never-seen user (404)", async () => {
  await withServer(async (base) => {
    await signIn(base, "alice");
    const self = await fetch(`${base}/dm`, { method: "POST", headers: h("alice"), body: JSON.stringify({ user: "alice" }) });
    assert.equal(self.status, 400);
    // carol exists as an identity but has never signed in → not in the directory → 404.
    const unknown = await fetch(`${base}/dm`, { method: "POST", headers: h("alice"), body: JSON.stringify({ user: "carol" }) });
    assert.equal(unknown.status, 404);
  });
});

test("a thin token (no email/displayName) doesn't clobber a richer prior profile", async () => {
  await withServer(async (base, store) => {
    // Seed a rich profile (as the dev seed / an earlier full sign-in would).
    await store.upsertUser({ sub: "carol", email: "carol@example.mil", displayName: "Carol Diaz", groups: ["security"] });
    await signIn(base, "carol"); // carol's token carries neither email nor displayName
    const carol = await store.getUser("carol");
    assert.equal(carol!.email, "carol@example.mil"); // preserved
    assert.equal(carol!.displayName, "Carol Diaz"); // preserved
    assert.deepEqual(carol!.groups, ["security"]); // refreshed from the token
  });
});
