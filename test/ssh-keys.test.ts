// EXIT TESTS — per-user git SSH identities (the Kubernetes-pool / desktop-daemon git-auth feature,
// Part A). Three seams:
//   1. The crypto core (src/ssh/keys.ts): ed25519 generation into real OpenSSH wire formats, the
//      SHA256 fingerprint, and the AES-256-GCM at-rest envelope. Where `ssh-keygen` is on PATH the
//      generated private key is round-tripped through it (the exact tool `git` will use).
//   2. The routes (POST/GET/DELETE /me/ssh-key) over a real socket with the real MemoryStore: the
//      private key is stored ONLY encrypted and NEVER leaves the server; regeneration replaces;
//      the feature 503s with no master key.
//   3. Injection: the control plane hands the OWNER's decrypted identity to the runner at spawn, and
//      the runner-protocol carries it to a remote daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  decryptSecret,
  deriveSecretKey,
  encryptSecret,
  fingerprintPublicKey,
  generateEd25519,
} from "../src/ssh/keys.ts";
import { createHttpServer } from "../src/http/server.ts";
import { makeControlPlane } from "../src/agent/control.ts";
import { parseRunnerCommand } from "../src/agent/runner-protocol.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Agent, GitSshMaterial, Runner, RunnerEvent, VerifyToken } from "../src/types.ts";

// ── 1. Crypto core ──────────────────────────────────────────────────────────────────────────────

const OPENSSH_HEADER = "-----BEGIN OPENSSH PRIVATE KEY-----";

/** Whether `ssh-keygen` is available — the round-trip subtests skip cleanly on a host without it so
 * CI stays portable (the encoding is also checked structurally below, which needs no external tool). */
function sshKeygenAvailable(): boolean {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (err) {
    // ssh-keygen exits non-zero for `-?` (prints usage) — that still proves it's installed.
    return (err as { code?: string }).code !== "ENOENT";
  }
}

test("generateEd25519 emits a well-formed public line, OpenSSH private key, and matching fingerprint", () => {
  const key = generateEd25519("austin@sec.internal");
  assert.equal(key.keyType, "ssh-ed25519");
  assert.match(key.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=* austin@sec\.internal$/);
  assert.ok(key.privateKeyOpenSSH.startsWith(OPENSSH_HEADER));
  assert.ok(key.privateKeyOpenSSH.trimEnd().endsWith("-----END OPENSSH PRIVATE KEY-----"));
  assert.match(key.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/); // 256-bit digest, base64 no padding
  // The fingerprint is derived from the public blob — our own helper agrees with generation.
  assert.equal(fingerprintPublicKey(key.publicKey), key.fingerprint);
  // Two generations differ (fresh randomness each time).
  assert.notEqual(generateEd25519().fingerprint, generateEd25519().fingerprint);
});

test("the generated private key round-trips through the real ssh-keygen", (t) => {
  if (!sshKeygenAvailable()) return t.skip("ssh-keygen not on PATH");
  const key = generateEd25519("pool@sec.internal");
  const dir = mkdtempSync(join(tmpdir(), "sshkeytest-"));
  const priv = join(dir, "id_ed25519");
  writeFileSync(priv, key.privateKeyOpenSSH, "utf8");
  chmodSync(priv, 0o600);
  // ssh-keygen must accept our file and derive the SAME public key (type+base64) from it.
  const derived = execFileSync("ssh-keygen", ["-y", "-f", priv], { encoding: "utf8" }).trim();
  assert.equal(derived.split(/\s+/).slice(0, 2).join(" "), key.publicKey.split(/\s+/).slice(0, 2).join(" "));
  // ...and print the SAME fingerprint.
  const fp = execFileSync("ssh-keygen", ["-lf", priv], { encoding: "utf8" }).trim().split(/\s+/)[1];
  assert.equal(fp, key.fingerprint);
});

test("AES-256-GCM envelope round-trips; wrong key and tampering are rejected", () => {
  const key = deriveSecretKey("a-long-random-deployment-secret");
  const plaintext = generateEd25519().privateKeyOpenSSH;
  const env = encryptSecret(plaintext, key);
  assert.notEqual(env, plaintext);
  assert.equal(decryptSecret(env, key), plaintext);
  // Wrong master key → GCM auth failure (throws, never returns garbage).
  assert.throws(() => decryptSecret(env, deriveSecretKey("different-secret")));
  // Tampered ciphertext → auth failure.
  assert.throws(() => decryptSecret(`${env.slice(0, -4)}AAAA`, key));
  // Malformed envelope → rejected.
  assert.throws(() => decryptSecret("not-an-envelope", key));
});

test("deriveSecretKey is a deterministic 32-byte fold of the secret", () => {
  const a = deriveSecretKey("secret");
  const b = deriveSecretKey("secret");
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, deriveSecretKey("secret2"));
});

// ── 2. Routes ─────────────────────────────────────────────────────────────────────────────────

const verifyToken: VerifyToken = async (token) => {
  if (token === "alice") return { sub: "alice", email: "alice@example.mil", displayName: "Alice Ng", groups: ["eng"] };
  if (token === "bob") return { sub: "bob", groups: ["eng"] };
  throw new Error("invalid token");
};
const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function withServer(
  opts: { ssh?: { secretKey: Buffer; knownHosts?: string } },
  fn: (base: string, store: MemoryStore) => Promise<void>,
): Promise<void> {
  const store = new MemoryStore();
  const server = createHttpServer({ verifyToken, store, ssh: opts.ssh });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("POST/GET/DELETE /me/ssh-key: generate → fetch → revoke, private key never leaves the server", async () => {
  const secretKey = deriveSecretKey("route-test-master-key");
  await withServer({ ssh: { secretKey } }, async (base, store) => {
    // Generate.
    const post = await fetch(`${base}/me/ssh-key`, { method: "POST", headers: h("alice") });
    assert.equal(post.status, 201);
    const created = (await post.json()) as Record<string, unknown>;
    // The response carries ONLY the public shape — no private material under any key name.
    assert.deepEqual(Object.keys(created).sort(), ["createdAt", "fingerprint", "keyType", "publicKey"]);
    assert.equal(created.keyType, "ssh-ed25519");
    assert.match(created.publicKey as string, /^ssh-ed25519 /);
    assert.equal((created.publicKey as string).split(/\s+/)[2], "alice@example.mil"); // comment = email
    assert.ok(!JSON.stringify(created).includes("PRIVATE"));

    // The stored row holds the ENCRYPTED private key, which decrypts to a real OpenSSH key.
    const row = await store.getUserSshKey("alice");
    assert.ok(row);
    assert.ok(row!.privateKeyEnc && row!.privateKeyEnc !== "");
    assert.ok(decryptSecret(row!.privateKeyEnc, secretKey).startsWith(OPENSSH_HEADER));
    assert.equal(row!.fingerprint, created.fingerprint);

    // Generation is audited (fingerprint recorded as metadata, not the key).
    const audit = (await store.listAudit()).find((e) => e.action === "ssh_key.generate");
    assert.ok(audit, "ssh_key.generate audited");
    assert.equal(audit!.detail, created.fingerprint);

    // Fetch returns the same public shape.
    const get = await fetch(`${base}/me/ssh-key`, { headers: h("alice") });
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), created);

    // A different user has no key.
    assert.equal((await fetch(`${base}/me/ssh-key`, { headers: h("bob") })).status, 404);

    // Revoke.
    const del = await fetch(`${base}/me/ssh-key`, { method: "DELETE", headers: h("alice") });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { removed: true });
    assert.equal(await store.getUserSshKey("alice"), null);
    assert.equal((await fetch(`${base}/me/ssh-key`, { headers: h("alice") })).status, 404);
  });
});

test("regenerating replaces the key (fingerprint changes, one row per user)", async () => {
  await withServer({ ssh: { secretKey: deriveSecretKey("k") } }, async (base, store) => {
    const first = (await (await fetch(`${base}/me/ssh-key`, { method: "POST", headers: h("alice") })).json()) as { fingerprint: string };
    const second = (await (await fetch(`${base}/me/ssh-key`, { method: "POST", headers: h("alice") })).json()) as { fingerprint: string };
    assert.notEqual(first.fingerprint, second.fingerprint);
    const row = await store.getUserSshKey("alice");
    assert.equal(row!.fingerprint, second.fingerprint); // the latest wins
  });
});

test("with no master key configured, the SSH-key routes are 503 (feature off)", async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/me/ssh-key`, { method: "POST", headers: h("alice") })).status, 503);
    assert.equal((await fetch(`${base}/me/ssh-key`, { headers: h("alice") })).status, 503);
    assert.equal((await fetch(`${base}/me/ssh-key`, { method: "DELETE", headers: h("alice") })).status, 503);
  });
});

// ── 3. Injection ────────────────────────────────────────────────────────────────────────────────

/** Fake Runner that records the input of each start() call — including the injected gitSsh. */
function makeFakeRunner() {
  const starts: Array<{ ownerSub: string; gitSsh?: GitSshMaterial }> = [];
  const runner: Runner = {
    async start(input) {
      starts.push({ ownerSub: input.ownerSub, gitSsh: input.gitSsh });
    },
    async sendInput() {},
    async answerTool() {},
    async stop() {},
    onEvent(_cb: (sessionId: string, event: RunnerEvent) => void) {},
  };
  return { runner, starts };
}

test("control plane injects the OWNER's decrypted git identity into the runner at spawn", async () => {
  const secretKey = deriveSecretKey("inject-master-key");
  const store = new MemoryStore();
  const agent: Agent = await store.createAgent({ ownerSub: "alice", kind: "coding", name: "Build Bot" });

  // Alice has a key; the control plane's getGitSsh mirrors the real wiring in index.ts.
  const generated = generateEd25519("alice@example.mil");
  await store.setUserSshKey({
    sub: "alice",
    keyType: generated.keyType,
    publicKey: generated.publicKey,
    fingerprint: generated.fingerprint,
    privateKeyEnc: encryptSecret(generated.privateKeyOpenSSH, secretKey),
    createdAt: new Date().toISOString(),
  });

  const { runner, starts } = makeFakeRunner();
  const control = makeControlPlane({
    sessions: store,
    runner,
    getAgent: (id) => store.getAgent(id),
    getGitSsh: async (ownerSub) => {
      const row = await store.getUserSshKey(ownerSub);
      if (!row) return undefined;
      return { privateKey: decryptSecret(row.privateKeyEnc, secretKey), publicKey: row.publicKey, knownHosts: "git.sec.internal ssh-ed25519 AAAA" };
    },
  });

  await control.spawn({ agent, channelId: "chan-1", hostType: "server" });
  assert.equal(starts.length, 1);
  const injected = starts[0]!.gitSsh;
  assert.ok(injected, "gitSsh injected");
  assert.equal(injected!.publicKey, generated.publicKey);
  assert.equal(injected!.privateKey, generated.privateKeyOpenSSH); // decrypted back to the real key
  assert.equal(injected!.knownHosts, "git.sec.internal ssh-ed25519 AAAA");
});

test("a spawn for an owner with no key injects nothing (feature stays optional)", async () => {
  const store = new MemoryStore();
  const agent: Agent = await store.createAgent({ ownerSub: "nokey", kind: "coding" });
  const { runner, starts } = makeFakeRunner();
  const control = makeControlPlane({
    sessions: store,
    runner,
    getAgent: (id) => store.getAgent(id),
    getGitSsh: async () => undefined, // feature on, but this user has no key
  });
  await control.spawn({ agent, channelId: "chan-1", hostType: "server" });
  assert.equal(starts[0]!.gitSsh, undefined);
});

test("runner-protocol carries gitSsh on the start frame to a remote daemon (and tolerates its absence)", () => {
  const withKey = parseRunnerCommand(
    JSON.stringify({
      type: "start",
      sessionId: "s1",
      agentId: "a1",
      ownerSub: "alice",
      gitSsh: { privateKey: "PK", publicKey: "ssh-ed25519 AAAA alice", knownHosts: "h" },
    }),
  );
  assert.ok(withKey && withKey.type === "start");
  assert.deepEqual(withKey.gitSsh, { privateKey: "PK", publicKey: "ssh-ed25519 AAAA alice", knownHosts: "h" });

  // A start with no gitSsh parses fine (undefined) — backward compatible with older SecChat.
  const noKey = parseRunnerCommand(JSON.stringify({ type: "start", sessionId: "s1", agentId: "a1", ownerSub: "alice" }));
  assert.ok(noKey && noKey.type === "start");
  assert.equal(noKey.gitSsh, undefined);

  // A half-formed gitSsh (missing privateKey) is dropped rather than passed through half-formed.
  const bad = parseRunnerCommand(JSON.stringify({ type: "start", sessionId: "s1", agentId: "a1", ownerSub: "alice", gitSsh: { publicKey: "x" } }));
  assert.ok(bad && bad.type === "start");
  assert.equal(bad.gitSsh, undefined);
});
