// EXIT TESTS — the Kubernetes agent pool (Part B). Four seams, all offline (the K8s API is a fake
// transport, no cluster):
//   1. The K8s REST client (src/agent/k8s.ts) — createPod/deletePod path + status handling.
//   2. The pool runner (src/agent/pool-runner.ts) — the full pod lifecycle: create on start, send the
//      buffered `start` (with gitSsh) when the pod attaches, relay events, reap the pod on stop/exit.
//   3. Per-agent routing (src/agent/router-runner.ts) — pool vs desktop vs server, chosen from the
//      agent's launchEnv.
//   4. The /runner?pool=<sessionId> discriminator (src/ws/runner-hub.ts) — a pool pod's attach is
//      routed to the PoolRunner by session, NEVER into the per-owner registry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { makeK8sClient, type K8sRequestFn } from "../src/agent/k8s.ts";
import { buildPoolPodSpec, makePoolRunner, poolPodName } from "../src/agent/pool-runner.ts";
import { makeRouterRunner } from "../src/agent/router-runner.ts";
import { RunnerRegistry, type RunnerConnection } from "../src/agent/runner-registry.ts";
import { attachRunnerHub } from "../src/ws/runner-hub.ts";
import type { PoolConfig } from "../src/config.ts";
import type { RunnerCommand, RunnerMessage } from "../src/agent/runner-protocol.ts";
import type { Runner, RunnerEvent, VerifyToken } from "../src/types.ts";

const POOL: PoolConfig = {
  apiServer: "https://kubernetes.default.svc",
  namespace: "secchat-pool",
  image: "registry.internal/secchat-runnerd:1.0.0",
  secchatUrl: "http://secchat:47010",
  cpuLimit: "1",
  memoryLimit: "1Gi",
  activeDeadlineSeconds: 3600,
  maxPods: 20,
  maxPerOwner: 3,
  attachTimeoutMs: 120_000,
};

async function waitFor(pred: () => boolean, ms = 1500): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── 1. K8s client ─────────────────────────────────────────────────────────────────────────────

test("k8s client: createPod POSTs to the namespaced pods path; deletePod DELETEs; 404 delete is ok", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const request: K8sRequestFn = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "POST") return { status: 201, body: "{}" };
    if (method === "DELETE" && path.endsWith("/gone")) return { status: 404, body: "{}" };
    return { status: 200, body: "{}" };
  };
  const k8s = makeK8sClient({ namespace: "secchat-pool", request });

  const created = await k8s.createPod({ metadata: { name: "p1" } });
  assert.deepEqual(created, { ok: true, status: 201, name: "p1" });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/api/v1/namespaces/secchat-pool/pods");

  assert.deepEqual(await k8s.deletePod("p1"), { ok: true, status: 200 });
  assert.equal(calls[1]!.path, "/api/v1/namespaces/secchat-pool/pods/p1");
  // A 404 on delete is idempotent-ok (already gone).
  assert.deepEqual(await k8s.deletePod("gone"), { ok: true, status: 404 });
});

test("k8s client: a non-2xx createPod surfaces the API server's Status message", async () => {
  const request: K8sRequestFn = async () => ({ status: 403, body: JSON.stringify({ kind: "Status", message: "forbidden: quota exceeded" }) });
  const k8s = makeK8sClient({ namespace: "ns", request });
  const res = await k8s.createPod({ metadata: { name: "p" } });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(res.error, "forbidden: quota exceeded");
});

test("k8s client: listPods GETs with the label selector and parses names + phase", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const request: K8sRequestFn = async (method, path) => {
    calls.push({ method, path });
    return { status: 200, body: JSON.stringify({ items: [
      { metadata: { name: "secchat-pool-a" }, status: { phase: "Running" } },
      { metadata: { name: "secchat-pool-b" } }, // no phase → undefined
      { metadata: {} }, // no name → dropped
    ] }) };
  };
  const k8s = makeK8sClient({ namespace: "secchat-pool", request });
  const res = await k8s.listPods("app=secchat-pool");
  assert.equal(res.ok, true);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.path, "/api/v1/namespaces/secchat-pool/pods?labelSelector=app%3Dsecchat-pool");
  assert.deepEqual(res.pods, [{ name: "secchat-pool-a", phase: "Running" }, { name: "secchat-pool-b", phase: undefined }]);
});

test("k8s client: a non-2xx listPods yields an empty list (reconciliation skips)", async () => {
  const request: K8sRequestFn = async () => ({ status: 403, body: "{}" });
  const k8s = makeK8sClient({ namespace: "ns", request });
  assert.deepEqual(await k8s.listPods(), { ok: false, status: 403, pods: [] });
});

// ── 2. Pod manifest ─────────────────────────────────────────────────────────────────────────────

test("buildPoolPodSpec: hardened, one-shot, TTL'd, carries the session env — and NOT the ssh key", () => {
  const spec = buildPoolPodSpec({ podName: "secchat-pool-s1", sessionId: "s1", ownerSub: "alice", runnerToken: "TOK", config: POOL });
  const podSpec = spec.spec as Record<string, unknown>;
  assert.equal(podSpec.restartPolicy, "Never");
  assert.equal(podSpec.automountServiceAccountToken, false); // no K8s API access from the agent pod
  assert.equal(podSpec.activeDeadlineSeconds, 3600); // hard TTL backstop
  // runAsNonRoot must pin a NUMERIC uid, else the kubelet can't verify non-root and refuses the pod
  // (caught live on k3s — the runnerd image's `USER node` is non-numeric).
  const podSc = podSpec.securityContext as { runAsNonRoot?: boolean; runAsUser?: number };
  assert.equal(podSc.runAsNonRoot, true);
  assert.equal(podSc.runAsUser, 1000);
  const container = (podSpec.containers as Array<Record<string, unknown>>)[0]!;
  assert.equal(container.image, POOL.image);
  const env = container.env as Array<{ name: string; value: string }>;
  assert.equal(env.find((e) => e.name === "SECCHAT_URL")?.value, POOL.secchatUrl);
  assert.equal(env.find((e) => e.name === "SECCHAT_RUNNER_TOKEN")?.value, "TOK");
  assert.equal(env.find((e) => e.name === "SECCHAT_POOL_SESSION")?.value, "s1");
  // pi in the pod routes through SecChat's /agent-llm/v1 proxy using the owner's runner token,
  // so its model calls attribute to the owner and never carry a SecRouter credential into the pod.
  assert.equal(env.find((e) => e.name === "PI_BASE_URL")?.value, `${POOL.secchatUrl}/agent-llm/v1`);
  assert.equal(env.find((e) => e.name === "PI_API_KEY")?.value, "TOK");
  const sc = container.securityContext as { allowPrivilegeEscalation?: boolean; capabilities?: { drop?: string[] } };
  assert.equal(sc.allowPrivilegeEscalation, false);
  assert.deepEqual(sc.capabilities?.drop, ["ALL"]);
  // The private key is injected over the /runner channel (the start command), never baked into the pod.
  assert.ok(!JSON.stringify(spec).includes("PRIVATE"));
  assert.match(poolPodName("S1-ABC"), /^secchat-pool-s1-abc$/);
});

// ── 3. Pool-runner lifecycle ──────────────────────────────────────────────────────────────────

function makeFakeK8s() {
  const created: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const extraPods: string[] = []; // pods "in the cluster" this client didn't create (orphans)
  let failCreate = false;
  const k8s = {
    async createPod(m: Record<string, unknown>) {
      created.push(m);
      return failCreate ? { ok: false, status: 500, error: "boom" } : { ok: true, status: 201, name: (m.metadata as { name?: string }).name };
    },
    async deletePod(n: string) {
      deleted.push(n);
      return { ok: true, status: 200 };
    },
    async listPods(_labelSelector?: string) {
      const fromCreated = created
        .map((m) => (m.metadata as { name?: string }).name)
        .filter((n): n is string => typeof n === "string");
      const live = [...fromCreated, ...extraPods].filter((n) => !deleted.includes(n));
      return { ok: true, status: 200, pods: live.map((name) => ({ name })) };
    },
  };
  return { k8s, created, deleted, setFailCreate: (v: boolean) => (failCreate = v), addClusterPod: (n: string) => extraPods.push(n) };
}

function fakeConn(ownerSub: string): { conn: RunnerConnection; sent: RunnerCommand[] } {
  const sent: RunnerCommand[] = [];
  return { conn: { ownerSub, runnerId: "pod-1", send: (c) => sent.push(c) }, sent };
}

function poolHarness() {
  const fake = makeFakeK8s();
  const events: Array<{ sessionId: string; event: RunnerEvent }> = [];
  const renewed: string[] = [];
  const pool = makePoolRunner({
    k8s: fake.k8s,
    config: POOL,
    mintRunnerToken: async () => "minted-token",
    renewLease: (id) => renewed.push(id),
    attachTimeoutMs: 10_000,
  });
  pool.runner.onEvent((sessionId, event) => events.push({ sessionId, event }));
  return { ...fake, pool, events, renewed };
}

test("pool runner: start creates a pod but sends `start` only once the pod attaches (with gitSsh)", async () => {
  const h = poolHarness();
  await h.pool.runner.start({ sessionId: "s1", agentId: "a1", ownerSub: "alice", workspace: "/repo", gitSsh: { privateKey: "PK", publicKey: "ssh-ed25519 AAAA alice" } });
  assert.equal(h.created.length, 1);
  assert.equal((h.created[0]!.metadata as { name?: string }).name, poolPodName("s1"));

  // Input issued before the pod is up is BUFFERED, not lost.
  await h.pool.runner.sendInput("s1", "hello");

  const { conn, sent } = fakeConn("alice");
  h.pool.handlePoolAttach("s1", conn);
  // First frame is the buffered `start` (carrying workspace + the owner's gitSsh), then the queued input.
  assert.equal(sent[0]!.type, "start");
  const startCmd = sent[0] as Extract<RunnerCommand, { type: "start" }>;
  assert.equal(startCmd.workspace, "/repo");
  assert.deepEqual(startCmd.gitSsh, { privateKey: "PK", publicKey: "ssh-ed25519 AAAA alice" });
  assert.deepEqual(sent[1], { type: "input", sessionId: "s1", text: "hello" });
});

test("pool runner: relays events up, reaps the pod on exit and on stop", async () => {
  const h = poolHarness();
  await h.pool.runner.start({ sessionId: "s1", agentId: "a1", ownerSub: "alice" });
  const { conn } = fakeConn("alice");
  h.pool.handlePoolAttach("s1", conn);

  // An output event reaches onEvent; a heartbeat renews the lease.
  h.pool.handlePoolMessage("s1", conn, { type: "event", sessionId: "s1", event: { type: "output", text: "hi" } } as RunnerMessage);
  h.pool.handlePoolMessage("s1", conn, { type: "heartbeat", sessionIds: ["s1"] } as RunnerMessage);
  assert.ok(h.events.some((e) => e.event.type === "output" && (e.event as { text: string }).text === "hi"));
  assert.deepEqual(h.renewed, ["s1"]);

  // The pod exits → its exit is surfaced AND the pod is reaped.
  h.pool.handlePoolMessage("s1", conn, { type: "event", sessionId: "s1", event: { type: "exit", code: 0 } } as RunnerMessage);
  await waitFor(() => h.deleted.includes(poolPodName("s1")));
  assert.ok(h.events.some((e) => e.event.type === "exit"));
});

test("pool runner: stop sends stop then deletes the pod", async () => {
  const h = poolHarness();
  await h.pool.runner.start({ sessionId: "s2", agentId: "a1", ownerSub: "alice" });
  const { conn, sent } = fakeConn("alice");
  h.pool.handlePoolAttach("s2", conn);
  await h.pool.runner.stop("s2");
  assert.ok(sent.some((c) => c.type === "stop"));
  await waitFor(() => h.deleted.includes(poolPodName("s2")));
});

test("pool runner: a failed pod creation surfaces a clean session exit and leaves no session", async () => {
  const h = poolHarness();
  h.setFailCreate(true);
  await h.pool.runner.start({ sessionId: "s3", agentId: "a1", ownerSub: "alice" });
  assert.ok(h.events.some((e) => e.event.type === "exit"));
  // A late attach for the dead session is ignored (no crash, nothing sent).
  const { conn, sent } = fakeConn("alice");
  h.pool.handlePoolAttach("s3", conn);
  assert.equal(sent.length, 0);
});

test("pool runner: an attach whose token authenticated as a DIFFERENT sub is rejected", async () => {
  const h = poolHarness();
  await h.pool.runner.start({ sessionId: "s4", agentId: "a1", ownerSub: "alice" });
  const { conn, sent } = fakeConn("mallory"); // not the session's owner
  h.pool.handlePoolAttach("s4", conn);
  assert.equal(sent.length, 0);
});

test("pool runner: a dropped pod socket ends the session and reaps the pod", async () => {
  const h = poolHarness();
  await h.pool.runner.start({ sessionId: "s5", agentId: "a1", ownerSub: "alice" });
  const { conn } = fakeConn("alice");
  h.pool.handlePoolAttach("s5", conn);
  h.pool.handlePoolGone("s5", conn);
  assert.ok(h.events.some((e) => e.sessionId === "s5" && e.event.type === "exit"));
  await waitFor(() => h.deleted.includes(poolPodName("s5")));
});

// ── 3b. Admission control (fail-fast at the caps) ──────────────────────────────────────────────

/** Text of any `output` event for a session (for asserting the admission-rejection message). */
function outputTextFor(events: Array<{ sessionId: string; event: RunnerEvent }>, sessionId: string): string {
  return events
    .filter((e) => e.sessionId === sessionId && e.event.type === "output")
    .map((e) => (e.event as { text: string }).text)
    .join(" ");
}

test("pool runner: admission rejects a new session at the GLOBAL cap (no pod created)", async () => {
  const fake = makeFakeK8s();
  const events: Array<{ sessionId: string; event: RunnerEvent }> = [];
  const pool = makePoolRunner({ k8s: fake.k8s, config: { ...POOL, maxPods: 1, maxPerOwner: 0 }, mintRunnerToken: async () => "tok", attachTimeoutMs: 10_000 });
  pool.runner.onEvent((sessionId, event) => events.push({ sessionId, event }));

  await pool.runner.start({ sessionId: "s1", agentId: "a", ownerSub: "alice" });
  assert.equal(fake.created.length, 1); // first admitted
  await pool.runner.start({ sessionId: "s2", agentId: "a", ownerSub: "bob" });
  assert.equal(fake.created.length, 1); // second REJECTED — no pod created
  assert.match(outputTextFor(events, "s2"), /capacity/);
  assert.ok(events.some((e) => e.sessionId === "s2" && e.event.type === "exit"));
});

test("pool runner: admission rejects at the PER-OWNER cap but admits a different owner", async () => {
  const fake = makeFakeK8s();
  const events: Array<{ sessionId: string; event: RunnerEvent }> = [];
  const pool = makePoolRunner({ k8s: fake.k8s, config: { ...POOL, maxPods: 0, maxPerOwner: 1 }, mintRunnerToken: async () => "tok", attachTimeoutMs: 10_000 });
  pool.runner.onEvent((sessionId, event) => events.push({ sessionId, event }));

  await pool.runner.start({ sessionId: "a1", agentId: "a", ownerSub: "alice" });
  await pool.runner.start({ sessionId: "a2", agentId: "a", ownerSub: "alice" }); // alice's 2nd — rejected
  await pool.runner.start({ sessionId: "b1", agentId: "a", ownerSub: "bob" }); // bob's 1st — admitted
  assert.deepEqual(fake.created.map((m) => (m.metadata as { name?: string }).name), [poolPodName("a1"), poolPodName("b1")]);
  assert.match(outputTextFor(events, "a2"), /already have/);
});

test("pool runner: freeing a slot (stop) re-admits a new session", async () => {
  const fake = makeFakeK8s();
  const pool = makePoolRunner({ k8s: fake.k8s, config: { ...POOL, maxPods: 1, maxPerOwner: 0 }, mintRunnerToken: async () => "tok", attachTimeoutMs: 10_000 });
  pool.runner.onEvent(() => {});
  await pool.runner.start({ sessionId: "s1", agentId: "a", ownerSub: "alice" });
  await pool.runner.stop("s1"); // frees the slot (sessions.delete is synchronous in finish)
  await waitFor(() => fake.deleted.includes(poolPodName("s1")));
  await pool.runner.start({ sessionId: "s2", agentId: "a", ownerSub: "alice" });
  assert.equal(fake.created.length, 2); // re-admitted once the slot freed
});

// ── 3c. Reconciliation + status surface ────────────────────────────────────────────────────────

test("pool runner: reconcile reaps ORPHAN pods but leaves tracked ones", async () => {
  const fake = makeFakeK8s();
  fake.addClusterPod("secchat-pool-orphan"); // a labelled pod SecChat doesn't track
  const pool = makePoolRunner({ k8s: fake.k8s, config: POOL, mintRunnerToken: async () => "tok", attachTimeoutMs: 10_000 });
  pool.runner.onEvent(() => {});
  await pool.runner.start({ sessionId: "s1", agentId: "a", ownerSub: "alice" }); // tracked pod secchat-pool-s1

  const res = await pool.reconcile();
  assert.deepEqual(res.reaped, ["secchat-pool-orphan"]);
  assert.ok(fake.deleted.includes("secchat-pool-orphan"));
  assert.ok(!fake.deleted.includes(poolPodName("s1"))); // the live session's pod is NOT reaped
  assert.equal(res.tracked, 1);
});

test("pool runner: listSessions reports live sessions (metadata only, no content)", async () => {
  const fake = makeFakeK8s();
  const pool = makePoolRunner({ k8s: fake.k8s, config: POOL, mintRunnerToken: async () => "tok", attachTimeoutMs: 10_000 });
  pool.runner.onEvent(() => {});
  await pool.runner.start({ sessionId: "s1", agentId: "a", ownerSub: "alice" });

  const list = pool.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.sessionId, "s1");
  assert.equal(list[0]!.ownerSub, "alice");
  assert.equal(list[0]!.podName, poolPodName("s1"));
  assert.equal(list[0]!.attached, false);
  assert.ok(list[0]!.ageMs >= 0);
});

// ── 4. Per-agent routing ──────────────────────────────────────────────────────────────────────

function recordingRunner(): { runner: Runner; starts: string[] } {
  const starts: string[] = [];
  return { runner: { async start(i) { starts.push(i.sessionId); }, async sendInput() {}, async answerTool() {}, async stop() {}, onEvent() {} }, starts };
}

test("router runner routes per-agent on launchEnv: pool→pool, desktop→remote, legacy→daemon-or-server", async () => {
  const server = recordingRunner();
  const remote = recordingRunner();
  const pool = recordingRunner();
  let hasRemote = false;
  const router = makeRouterRunner({ server: server.runner, remote: remote.runner, pool: pool.runner, hasRemote: () => hasRemote });

  await router.start({ sessionId: "pool-1", agentId: "a", ownerSub: "u", launchEnv: "pool" });
  await router.start({ sessionId: "desk-1", agentId: "a", ownerSub: "u", launchEnv: "desktop" });
  await router.start({ sessionId: "legacy-server", agentId: "a", ownerSub: "u" }); // no launchEnv, no daemon
  hasRemote = true;
  await router.start({ sessionId: "legacy-daemon", agentId: "a", ownerSub: "u" }); // no launchEnv, daemon attached

  assert.deepEqual(pool.starts, ["pool-1"]);
  assert.deepEqual(remote.starts, ["desk-1", "legacy-daemon"]);
  assert.deepEqual(server.starts, ["legacy-server"]);
});

test("router runner: a pool agent falls back to the server runner when the pool isn't configured", async () => {
  const server = recordingRunner();
  const remote = recordingRunner();
  const router = makeRouterRunner({ server: server.runner, remote: remote.runner, hasRemote: () => false }); // no pool
  await router.start({ sessionId: "p", agentId: "a", ownerSub: "u", launchEnv: "pool" });
  assert.deepEqual(server.starts, ["p"]);
});

// ── 5. The /runner?pool= discriminator (real WebSocket) ────────────────────────────────────────

const verifyToken: VerifyToken = async (token) => {
  if (token === "alice") return { sub: "alice", groups: [] };
  throw new Error("invalid token");
};

test("runner-hub: a ?pool= attach routes to the PoolRunner by session and stays OFF the registry", async () => {
  const registry = new RunnerRegistry();
  const attaches: Array<{ sessionId: string; ownerSub: string }> = [];
  const messages: Array<{ sessionId: string; type: string }> = [];
  let gone = 0;
  // A fake PoolRunner capturing the hub's routing.
  const pool = {
    runner: { async start() {}, async sendInput() {}, async answerTool() {}, async stop() {}, onEvent() {} } as Runner,
    handlePoolAttach: (sessionId: string, conn: RunnerConnection) => attaches.push({ sessionId, ownerSub: conn.ownerSub }),
    handlePoolMessage: (sessionId: string, _conn: RunnerConnection, msg: RunnerMessage) => messages.push({ sessionId, type: msg.type }),
    handlePoolGone: () => (gone += 1),
    listSessions: () => [],
    status: () => ({ configured: true as const, namespace: "secchat-pool", image: "img", limits: { maxPods: 20, maxPerOwner: 3, ttlSeconds: 3600, attachTimeoutMs: 120_000 }, live: 0, sessions: [] }),
    reconcile: async () => ({ reaped: [], tracked: 0, clusterPods: 0 }),
  };
  const remote = { runner: {} as Runner, handleDaemonMessage: () => {}, handleDaemonGone: () => {} };
  const server = createServer((_req, res) => res.writeHead(404).end());
  attachRunnerHub(server, { verifyToken, registry, remote, pool });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const socket = new WebSocket(`ws://127.0.0.1:${port}/runner?token=alice&pool=sess-1`);
  try {
    await new Promise<void>((res, rej) => {
      socket.addEventListener("open", () => res(), { once: true });
      socket.addEventListener("error", () => rej(new Error("open failed")), { once: true });
    });
    // Routed to the pool by session id — and NOT registered as alice's desktop daemon.
    await waitFor(() => attaches.length === 1);
    assert.deepEqual(attaches[0], { sessionId: "sess-1", ownerSub: "alice" });
    assert.equal(registry.has("alice"), false);

    // A frame the pod sends up routes to handlePoolMessage for that session.
    socket.send(JSON.stringify({ type: "event", sessionId: "sess-1", event: { type: "output", text: "hi" } }));
    await waitFor(() => messages.some((m) => m.sessionId === "sess-1" && m.type === "event"));

    socket.close();
    await waitFor(() => gone === 1);
  } finally {
    if (socket.readyState === socket.OPEN) socket.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
