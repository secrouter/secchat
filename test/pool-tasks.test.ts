// Pool TASKS — the one-shot batch API (pool-tasks.ts) against a fake k8s: pod spec shape, the
// allowlist + admission, the phase-watch → log-collection lifecycle, cancel, and the orphan reaper.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolConfig } from "../src/config.ts";
import type { K8sClient } from "../src/agent/k8s.ts";
import { buildTaskPodSpec, makePoolTasks, taskPodName } from "../src/agent/pool-tasks.ts";

const POOL: PoolConfig = {
  apiServer: "https://kubernetes.default.svc",
  namespace: "secchat-pool",
  image: "secchat-runnerd:local",
  secchatUrl: "http://secchat:47010",
  cpuLimit: "1",
  memoryLimit: "1Gi",
  activeDeadlineSeconds: 3600,
  maxPods: 20,
  maxPerOwner: 3,
  attachTimeoutMs: 120_000,
  analysisImages: {},
  maxTasks: 2,
  taskImage: "secagent-agent:local",
};

function fakeK8s() {
  const created: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  let phase = "Running";
  let logs = "REPORT: 2 findings";
  const k8s: K8sClient = {
    async createPod(m) {
      created.push(m);
      return { ok: true, status: 201, name: (m.metadata as { name?: string }).name };
    },
    async deletePod(n) {
      deleted.push(n);
      return { ok: true, status: 200 };
    },
    async listPods() {
      return { ok: true, status: 200, pods: [] };
    },
    async getPod() {
      return { ok: true, status: 200, phase };
    },
    async podLogs() {
      return { ok: true, status: 200, logs };
    },
  };
  return { k8s, created, deleted, setPhase: (p: string) => (phase = p), setLogs: (l: string) => (logs = l) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("buildTaskPodSpec: secagent argv command, caller-attributed LLM proxy env, hardened, task label", () => {
  const spec = buildTaskPodSpec({
    podName: "secchat-task-t1", taskId: "t1", ownerSub: "alice",
    argv: ["review", "mr", "42"], runnerToken: "TOK", config: POOL, repo: "https://git.sec.internal/x.git",
  });
  const meta = spec.metadata as { labels: Record<string, string>; annotations: Record<string, string> };
  assert.equal(meta.labels.app, "secchat-pool-task"); // NOT app=secchat-pool — the session reaper must ignore tasks
  assert.equal(meta.labels["secchat.io/egress"], "restricted"); // tasks never get the internet label
  assert.equal(meta.annotations["secchat.io/owner"], "alice");
  const podSpec = spec.spec as Record<string, unknown>;
  assert.equal((podSpec.securityContext as { fsGroup?: number }).fsGroup, 1000);
  const c = (podSpec.containers as Array<Record<string, unknown>>)[0]!;
  assert.equal(c.image, "secagent-agent:local");
  assert.deepEqual(c.command, ["secagent", "review", "mr", "42"]); // argv array — no shell, overrides the pi entrypoint
  const env = c.env as Array<{ name: string; value: string }>;
  assert.equal(env.find((e) => e.name === "SECAGENT_LLM__BASE_URL")?.value, "http://secchat:47010/agent-llm/v1");
  assert.equal(env.find((e) => e.name === "SECAGENT_LLM__API_KEY")?.value, "TOK");
  assert.equal(env.find((e) => e.name === "SECAGENT_REPO_URL")?.value, "https://git.sec.internal/x.git");
});

test("create: allowlist enforced; disallowed/missing subcommands are clean 400s", async () => {
  const { k8s, created } = fakeK8s();
  const tasks = makePoolTasks({ k8s, config: POOL, mintRunnerToken: async () => "tok", pollMs: 10 });
  for (const argv of [["serve"], ["rm", "-rf"], []]) {
    const res = await tasks.create({ ownerSub: "alice", argv });
    assert.equal(res.status, 400);
    assert.match(res.error!, /task must start with one of/);
  }
  assert.equal(created.length, 0); // nothing reached the cluster
});

test("create → running → succeeded: logs collected as the result, pod deleted, record kept", async () => {
  const fake = fakeK8s();
  const tasks = makePoolTasks({ k8s: fake.k8s, config: POOL, mintRunnerToken: async () => "tok", pollMs: 10 });
  const res = await tasks.create({ ownerSub: "alice", argv: ["review", "mr", "42"] });
  assert.ok(res.task);
  assert.equal(res.task!.status, "pending");

  await sleep(30); // a poll tick sees phase Running
  assert.equal(tasks.get(res.task!.id)?.status, "running");

  fake.setPhase("Succeeded");
  await sleep(40);
  const done = tasks.get(res.task!.id)!;
  assert.equal(done.status, "succeeded");
  assert.equal(done.output, "REPORT: 2 findings"); // the pod's logs ARE the report
  assert.ok(done.finishedAt);
  assert.ok(fake.deleted.includes(taskPodName(res.task!.id))); // pod reaped after collection
});

test("create → Failed phase yields a failed task with its logs", async () => {
  const fake = fakeK8s();
  fake.setLogs("boom: could not clone");
  const tasks = makePoolTasks({ k8s: fake.k8s, config: POOL, mintRunnerToken: async () => "tok", pollMs: 10 });
  const res = await tasks.create({ ownerSub: "alice", argv: ["docs", "build", "."] });
  fake.setPhase("Failed");
  await sleep(40);
  const done = tasks.get(res.task!.id)!;
  assert.equal(done.status, "failed");
  assert.match(done.output!, /could not clone/);
});

test("admission: at maxTasks new tasks are 429 until one finishes", async () => {
  const fake = fakeK8s();
  const tasks = makePoolTasks({ k8s: fake.k8s, config: POOL, mintRunnerToken: async () => "tok", pollMs: 10 });
  await tasks.create({ ownerSub: "a", argv: ["review", "mr", "1"] });
  await tasks.create({ ownerSub: "b", argv: ["review", "mr", "2"] });
  const third = await tasks.create({ ownerSub: "c", argv: ["review", "mr", "3"] });
  assert.equal(third.status, 429);
  assert.match(third.error!, /capacity/);
});

test("cancel: pending/running only; deletes the pod; a finished task can't be cancelled", async () => {
  const fake = fakeK8s();
  const tasks = makePoolTasks({ k8s: fake.k8s, config: POOL, mintRunnerToken: async () => "tok", pollMs: 10 });
  const res = await tasks.create({ ownerSub: "alice", argv: ["analyze", "scan", "."] });
  assert.equal(await tasks.cancel(res.task!.id), true);
  assert.equal(tasks.get(res.task!.id)?.status, "cancelled");
  assert.ok(fake.deleted.includes(taskPodName(res.task!.id)));
  assert.equal(await tasks.cancel(res.task!.id), false); // already terminal
  assert.equal(await tasks.cancel("nope"), false);
});

test("list: newest first, summaries only (no output field)", async () => {
  const fake = fakeK8s();
  const tasks = makePoolTasks({ k8s: fake.k8s, config: POOL, mintRunnerToken: async () => "tok", pollMs: 10_000 });
  await tasks.create({ ownerSub: "alice", argv: ["review", "mr", "1"] });
  const listed = tasks.list();
  assert.equal(listed.length, 1);
  assert.ok(!("output" in listed[0]!));
});

test("reconcile: reaps task-labelled pods with no registry entry", async () => {
  const fake = fakeK8s();
  fake.k8s.listPods = async () => ({ ok: true, status: 200, pods: [{ name: "secchat-task-orphan" }] });
  const tasks = makePoolTasks({ k8s: fake.k8s, config: POOL, mintRunnerToken: async () => "tok", pollMs: 10_000 });
  assert.deepEqual(await tasks.reconcile(), ["secchat-task-orphan"]);
  assert.ok(fake.deleted.includes("secchat-task-orphan"));
});

test("no task image ⇒ create is a clean 503", async () => {
  const fake = fakeK8s();
  const tasks = makePoolTasks({ k8s: fake.k8s, config: { ...POOL, taskImage: undefined }, mintRunnerToken: async () => "tok" });
  const res = await tasks.create({ ownerSub: "alice", argv: ["review", "mr", "1"] });
  assert.equal(res.status, 503);
});
