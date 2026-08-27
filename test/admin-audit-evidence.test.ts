// spec B.7 (secchat entry): GET /admin/api/audit/verify + GET /admin/api/evidence.
//
// Two layers, mirroring test/admin-overview.test.ts + test/admin.exit.test.ts:
//   1. buildAuditVerify / buildEvidence exercised OFFLINE with a minimal fake Store (cast through
//      `unknown`, same pattern as admin-overview.test.ts) — covers a healthy chain, a TAMPERED
//      message chain isolated to its channel, a tampered audit chain, channel-limit truncation,
//      DLP-pattern sanitization, the B.5 control-id citation form, and the audit-recent cap.
//   2. The two routes end-to-end over a real MemoryStore + createHttpServer — admin gating
//      (401/403/200/404-when-unwired) and the download Content-Disposition header.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GENESIS, computeAuditHash, computeMessageHash, hashContent } from "../src/audit/chain.ts";
import { buildAuditVerify } from "../src/admin/verify.ts";
import { buildEvidence, type EvidenceDeps } from "../src/admin/evidence.ts";
import { buildOverview } from "../src/admin/overview.ts";
import { renderConsole } from "../src/admin/console.ts";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";
import { DlpPolicy } from "../src/dlp/policy.ts";
import { defaultCapabilityPolicy } from "../src/auth/capabilities.ts";
import type { AuditEvent, Channel, Message, Store, VerifyToken } from "../src/types.ts";

// ── shared fixtures ──────────────────────────────────────────────────────────────────────────

/** A valid `n`-link message chain for one channel — same construction as test/audit.test.ts's
 * buildMessages, parameterized by channelId so several channels can be built independently. */
function buildMessages(channelId: string, n: number): Message[] {
  const out: Message[] = [];
  let prev = GENESIS;
  for (let i = 1; i <= n; i++) {
    const base = {
      channelId,
      seq: i,
      authorRef: `user-${i}`,
      authorType: "user" as const,
      contentSha256: hashContent(`${channelId} message ${i}`),
      marking: "UNCLASSIFIED",
      attachmentsSha256: "",
      createdAt: `2026-08-08T00:00:${String(i).padStart(2, "0")}.000Z`,
    };
    const hash = computeMessageHash(prev, base);
    out.push({ id: `${channelId}-m${i}`, prevHash: prev, hash, ...base });
    prev = hash;
  }
  return out;
}

/** A valid `n`-link global audit chain, same construction as test/audit.test.ts. */
function buildAuditEvents(n: number): AuditEvent[] {
  const out: AuditEvent[] = [];
  let prev = GENESIS;
  for (let i = 1; i <= n; i++) {
    const base = { seq: i, actor: `user-${i}`, action: "channel.create", target: `chan-${i}`, at: `2026-08-08T00:00:${String(i).padStart(2, "0")}.000Z` };
    const hash = computeAuditHash(prev, base);
    out.push({ id: `evt-${i}`, prevHash: prev, hash, ...base });
    prev = hash;
  }
  return out;
}

function channel(id: string): Channel {
  return { id, workspaceId: "ws-1", kind: "human", name: id, createdBy: "user-1", createdAt: "2026-08-08T00:00:00.000Z" };
}

/** MINIMAL fake Store — implements only the three read methods buildAuditVerify/buildEvidence
 * call (listChannels/listMessages/listAudit). Cast through `unknown`, matching the pattern in
 * test/admin-overview.test.ts. */
function makeFakeStore(channels: Channel[], messagesByChannel: Map<string, Message[]>, audit: AuditEvent[]): Store {
  return {
    async listChannels() {
      return channels;
    },
    async listMessages(channelId: string) {
      return messagesByChannel.get(channelId) ?? [];
    },
    async listAudit() {
      return audit;
    },
  } as unknown as Store;
}

// ── buildAuditVerify (offline) ───────────────────────────────────────────────────────────────

test("buildAuditVerify: a healthy deployment verifies both chains, per-channel", async () => {
  const messages = new Map([
    ["chan-a", buildMessages("chan-a", 3)],
    ["chan-b", buildMessages("chan-b", 2)],
  ]);
  const store = makeFakeStore([channel("chan-a"), channel("chan-b")], messages, buildAuditEvents(4));

  const result = await buildAuditVerify(store);

  assert.equal(result.ok, true);
  assert.equal(result.audit.ok, true);
  assert.equal(result.audit.checked, 4);
  assert.equal(result.audit.brokenAtSeq, undefined);
  assert.equal(result.truncated, false);
  assert.equal(result.messages.length, 2);
  const byChannel = new Map(result.messages.map((m) => [m.channelId, m]));
  assert.deepEqual(byChannel.get("chan-a"), { channelId: "chan-a", ok: true, checked: 3 });
  assert.deepEqual(byChannel.get("chan-b"), { channelId: "chan-b", ok: true, checked: 2 });
  assert.match(result.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("buildAuditVerify: a tampered message chain is caught and isolated to its own channel", async () => {
  const good = buildMessages("chan-good", 3);
  const bad = buildMessages("chan-bad", 3);
  // Tamper the bound `contentSha256` of link 2 WITHOUT recomputing its hash — exactly the
  // "altered field, stale hash" tamper test/audit.test.ts exercises on the bare chain functions.
  bad[1] = { ...bad[1]!, contentSha256: hashContent("forged") };
  const store = makeFakeStore(
    [channel("chan-good"), channel("chan-bad")],
    new Map([["chan-good", good], ["chan-bad", bad]]),
    buildAuditEvents(2),
  );

  const result = await buildAuditVerify(store);

  assert.equal(result.ok, false); // aggregate reflects the broken channel
  assert.equal(result.audit.ok, true); // the OTHER chain is unaffected
  const byChannel = new Map(result.messages.map((m) => [m.channelId, m]));
  assert.deepEqual(byChannel.get("chan-good"), { channelId: "chan-good", ok: true, checked: 3 });
  assert.equal(byChannel.get("chan-bad")?.ok, false);
  assert.equal(byChannel.get("chan-bad")?.brokenAtSeq, 2);
});

test("buildAuditVerify: a tampered audit event is caught, reporting brokenAtSeq", async () => {
  const events = buildAuditEvents(3);
  events[1] = { ...events[1]!, action: "message.delete" }; // tamper the action, keep the stale hash
  const store = makeFakeStore([channel("chan-a")], new Map([["chan-a", buildMessages("chan-a", 1)]]), events);

  const result = await buildAuditVerify(store);

  assert.equal(result.ok, false);
  assert.equal(result.audit.ok, false);
  assert.equal(result.audit.brokenAtSeq, 2);
  assert.equal(result.audit.checked, 3);
});

test("buildAuditVerify: channelLimit caps how many channels are recomputed and reports truncated", async () => {
  const channels = [channel("chan-1"), channel("chan-2"), channel("chan-3")];
  const messages = new Map(channels.map((c) => [c.id, buildMessages(c.id, 1)]));
  const store = makeFakeStore(channels, messages, buildAuditEvents(1));

  const result = await buildAuditVerify(store, 2);

  assert.equal(result.messages.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.ok, true); // the two channels actually checked are both healthy
});

// ── buildEvidence (offline) ──────────────────────────────────────────────────────────────────

const HEALTHY_STORE = makeFakeStore(
  [channel("chan-a")],
  new Map([["chan-a", buildMessages("chan-a", 2)]]),
  buildAuditEvents(3),
);

const SECRET_PATTERN = "SECRET_PATTERN_DO_NOT_LEAK_[0-9]{4}";

function evidenceDeps(overrides: Partial<EvidenceDeps> = {}): EvidenceDeps {
  return {
    store: HEALTHY_STORE,
    marking: makeMarkingPolicy(["UNCLASSIFIED", "PROPRIETARY", "CUI"], "UNCLASSIFIED"),
    dlp: new DlpPolicy("flag", [{ name: "custom-secret-rule", pattern: SECRET_PATTERN }]),
    capabilities: defaultCapabilityPolicy("secchat-admins"),
    adminGroup: "secchat-admins",
    stepUpConfigured: true,
    poolConfigured: false,
    voiceConfigured: true,
    ...overrides,
  };
}

test("buildEvidence: product/version/generatedBy/auditChain wiring", async () => {
  const bundle = await buildEvidence(evidenceDeps(), "admin-1");

  assert.equal(bundle.product, "SecChat");
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
  assert.equal(bundle.version, pkg.version);
  assert.equal(bundle.generatedBy, "admin-1");
  assert.equal(bundle.auditChain.ok, true);
  assert.match(bundle.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("buildEvidence: sanitizes DLP config to rule NAMES only — the pattern never appears anywhere in the bundle", async () => {
  const bundle = await buildEvidence(evidenceDeps(), "admin-1");

  assert.deepEqual(bundle.config.dlp.ruleNames, ["custom-secret-rule"]);
  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes(SECRET_PATTERN), "the DLP regex pattern must never be serialized into the evidence bundle");
  assert.ok(serialized.includes("custom-secret-rule"), "the rule NAME should still be present");
});

test("buildEvidence: config posture carries only names/booleans, no Config object leaks through", async () => {
  const bundle = await buildEvidence(evidenceDeps(), "admin-1");

  assert.deepEqual(bundle.config.marking.levels, ["UNCLASSIFIED", "PROPRIETARY", "CUI"]);
  assert.equal(bundle.config.dlp.mode, "flag");
  assert.equal(bundle.config.stepUp.configured, true);
  assert.equal(bundle.config.pool.configured, false);
  assert.equal(bundle.config.voice.configured, true);
  assert.equal(bundle.config.adminGroup, "secchat-admins");
  // Every gated capability reports a boolean pair, never the raw group name or a secret.
  for (const entry of Object.values(bundle.config.capabilities)) {
    assert.equal(typeof entry.grouped, "boolean");
    assert.equal(typeof entry.stepUpRequired, "boolean");
  }
});

test("buildEvidence: controls is non-empty and every id follows the B.5 FAMILY-ID citation form", async () => {
  const bundle = await buildEvidence(evidenceDeps(), "admin-1");

  assert.ok(bundle.controls.length > 0);
  // FAMILY-ID, e.g. "AC-3.1.1", or several ids one entry jointly addresses ("AU-3.3.1/3.3.2").
  const idPattern = /^[A-Z]{2,3}-\d+\.\d+\.\d+(\/\d+\.\d+\.\d+)*$/;
  for (const control of bundle.controls) {
    assert.match(control.id, idPattern, `control id "${control.id}" is not FAMILY-ID form`);
    assert.ok(control.evidence.length > 0);
    assert.ok(control.requirement.length > 0);
    assert.ok(control.status.length > 0);
  }
  // The specific families the spec calls out for secchat are represented.
  const ids = bundle.controls.map((c) => c.id);
  assert.ok(ids.some((id) => id.startsWith("AC-")));
  assert.ok(ids.some((id) => id.startsWith("IA-")));
  assert.ok(ids.some((id) => id.startsWith("AU-")));
  assert.ok(ids.some((id) => id.startsWith("MP-")));
  assert.ok(ids.some((id) => id.startsWith("SC-")));
});

test("buildEvidence: auditRecent caps at the last 200 events, most recent last", async () => {
  const store = makeFakeStore([channel("chan-a")], new Map([["chan-a", []]]), buildAuditEvents(250));
  const bundle = await buildEvidence(evidenceDeps({ store }), "admin-1");

  assert.equal(bundle.auditRecent.length, 200);
  assert.equal(bundle.auditRecent[0]!.seq, 51);
  assert.equal(bundle.auditRecent[199]!.seq, 250);
});

// ── HTTP routes (end-to-end over a real MemoryStore) ────────────────────────────────────────

const ADMIN_GROUP = "secchat-admins";

const verify: VerifyToken = async (t) => {
  if (t === "admin") return { sub: "admin-1", groups: [ADMIN_GROUP] };
  if (t === "user") return { sub: "user-1", groups: ["eng"] };
  throw new Error("bad token");
};

async function seed(store: MemoryStore) {
  const ch = await store.createChannel({ workspaceId: "ws", kind: "human", name: "general", createdBy: "user-1" });
  await store.addMember({ channelId: ch.id, memberRef: "user-1", memberType: "user", role: "owner" });
  await store.appendAudit({ actor: "user-1", action: "channel.create", target: ch.id });
  await store.appendMessage({ channelId: ch.id, authorRef: "user-1", authorType: "user", content: "hello team" });
  return ch;
}

function serverWith(store: MemoryStore, dlp?: DlpPolicy, withAdmin = true) {
  return createHttpServer({
    verifyToken: verify,
    store,
    admin: withAdmin ? { adminGroup: ADMIN_GROUP, overview: () => buildOverview(store), renderConsole } : undefined,
    marking: makeMarkingPolicy(["UNCLASSIFIED", "CUI"], "UNCLASSIFIED"),
    dlp,
    capabilities: defaultCapabilityPolicy(ADMIN_GROUP),
  });
}

async function withServer(server: ReturnType<typeof serverWith>, fn: (base: string) => Promise<void>) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /admin/api/audit/verify: 401 no token, 403 non-admin, 200 admin with the documented shape", async () => {
  const store = new MemoryStore();
  await seed(store);
  await withServer(serverWith(store), async (base) => {
    assert.equal((await fetch(`${base}/admin/api/audit/verify`)).status, 401);
    assert.equal((await fetch(`${base}/admin/api/audit/verify`, { headers: { authorization: "Bearer user" } })).status, 403);
    const res = await fetch(`${base}/admin/api/audit/verify`, { headers: { authorization: "Bearer admin" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; audit: { ok: boolean; checked: number }; messages: unknown[]; ts: string };
    assert.equal(body.ok, true);
    assert.equal(body.audit.ok, true);
    assert.ok(body.audit.checked >= 1);
    assert.ok(Array.isArray(body.messages));
    assert.match(body.ts, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("GET /admin/api/audit/verify: 404 when admin is not wired (same pattern as every other /admin* route)", async () => {
  const store = new MemoryStore();
  await withServer(serverWith(store, undefined, false), async (base) => {
    const res = await fetch(`${base}/admin/api/audit/verify`, { headers: { authorization: "Bearer admin" } });
    assert.equal(res.status, 404);
  });
});

test("GET /admin/api/evidence: 401/403 gating, 200 admin with a downloadable bundle", async () => {
  const store = new MemoryStore();
  await seed(store);
  await withServer(serverWith(store), async (base) => {
    assert.equal((await fetch(`${base}/admin/api/evidence`)).status, 401);
    assert.equal((await fetch(`${base}/admin/api/evidence`, { headers: { authorization: "Bearer user" } })).status, 403);
    const res = await fetch(`${base}/admin/api/evidence`, { headers: { authorization: "Bearer admin" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="secchat-evidence-\d{4}-\d{2}-\d{2}\.json"/);
    const body = (await res.json()) as {
      product: string;
      controls: unknown[];
      auditChain: { ok: boolean };
      auditRecent: unknown[];
    };
    assert.equal(body.product, "SecChat");
    assert.ok(Array.isArray(body.controls) && body.controls.length > 0);
    assert.equal(body.auditChain.ok, true);
    assert.ok(Array.isArray(body.auditRecent));
  });
});

test("GET /admin/api/evidence: a configured DLP rule's PATTERN never appears in the response body, only its name", async () => {
  const store = new MemoryStore();
  await seed(store);
  const dlp = new DlpPolicy("flag", [{ name: "live-secret-rule", pattern: SECRET_PATTERN }]);
  await withServer(serverWith(store, dlp), async (base) => {
    const res = await fetch(`${base}/admin/api/evidence`, { headers: { authorization: "Bearer admin" } });
    const text = await res.text();
    assert.ok(!text.includes(SECRET_PATTERN));
    assert.ok(text.includes("live-secret-rule"));
  });
});
