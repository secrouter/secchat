// One-shot POOL TASKS — the batch counterpart to the interactive agent pool (pool-runner.ts).
//
// A task runs `secagent <argv>` (MR review, docs build, static analysis, …) in an ephemeral,
// hardened pod of the deployment's TASK image (the secagent agent image) and its stdout+stderr IS
// the result, collected via the pods/log subresource when the pod reaches a terminal phase. No
// runnerd, no dial-back, no chat channel — fire, poll, read. Driven by the HTTP task API
// (POST/GET/DELETE /pool/tasks, http/server.ts), attributed to the CALLER:
//
//  - The pod's secagent LLM calls route through SecChat's own /agent-llm/v1 proxy with a runner
//    token minted for the caller — same credential story as the interactive pods, so SecRouter
//    policy/budget/audit land on the human who triggered the task, never on SecChat itself.
//  - The task argv is an ARRAY handed to the `secagent` binary (k8s `command`, overriding the
//    image's pi entrypoint) — there is no shell, so no injection surface; the API validates the
//    subcommand against an allowlist of secagent's batch surfaces.
//
// Lifecycle: create (admission-capped) → poll getPod until Succeeded/Failed (or the pod's own
// activeDeadlineSeconds reaps a runaway) → collect logs once, delete the pod, keep the result
// in memory for the API to serve. The registry is in-memory: tasks are short-lived batch jobs,
// and a SecChat restart forfeits bookkeeping for pods it no longer tracks — the label-scoped
// task reaper (reconcile) deletes any task pod with no live registry entry, so nothing leaks.

import { randomUUID } from "node:crypto";
import type { PoolConfig } from "../config.ts";
import type { Id } from "../types.ts";
import type { K8sClient } from "./k8s.ts";

/** The secagent subcommands the task API accepts — its BATCH surfaces only. An interactive `pi`
 * run or a serve mode has no business in a fire-and-forget task pod. */
export const ALLOWED_TASKS = new Set(["review", "docs", "analyze", "affordance"]);

export const TASK_LABEL_SELECTOR = "app=secchat-pool-task";

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface PoolTask {
  id: Id;
  ownerSub: string;
  argv: string[]; // the full argv AFTER `secagent`
  podName: string;
  status: TaskStatus;
  createdAt: string;
  finishedAt?: string;
  /** stdout+stderr of the task pod, populated once terminal (the report). */
  output?: string;
}

/** Public projection — everything but nothing extra (output can be large; list omits it). */
export function taskSummary(t: PoolTask): Omit<PoolTask, "output"> {
  const { output: _output, ...rest } = t;
  return rest;
}

export function taskPodName(id: Id): string {
  return `secchat-task-${id}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63).replace(/-+$/, "");
}

/** The task pod: same hardening as the interactive pool pods, secagent as the command, the
 * caller's minted token wired to SecChat's /agent-llm proxy for governed LLM access, and an
 * optional repo URL the task clones itself (git egress is in the pool's NetworkPolicy). */
export function buildTaskPodSpec(input: {
  podName: string;
  taskId: Id;
  ownerSub: string;
  argv: string[];
  runnerToken: string;
  config: PoolConfig;
  repo?: string;
}): Record<string, unknown> {
  const { podName, taskId, argv, runnerToken, config } = input;
  const proxy = `${config.secchatUrl.replace(/\/$/, "")}/agent-llm/v1`;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      labels: { app: "secchat-pool-task", "secchat.io/egress": "restricted" },
      annotations: { "secchat.io/task": taskId, "secchat.io/owner": input.ownerSub },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      activeDeadlineSeconds: config.activeDeadlineSeconds,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
      volumes: [{ name: "workspace", emptyDir: {} }],
      containers: [
        {
          name: "task",
          image: config.taskImage,
          command: ["secagent", ...argv], // overrides the image's pi entrypoint; argv array — no shell
          workingDir: "/workspace",
          env: [
            // Governed LLM access, attributed to the CALLER (see the /agent-llm proxy).
            { name: "SECAGENT_LLM__BASE_URL", value: proxy },
            { name: "SECAGENT_LLM__API_KEY", value: runnerToken },
            ...(input.repo ? [{ name: "SECAGENT_REPO_URL", value: input.repo }] : []),
          ],
          volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
          resources: {
            limits: { cpu: config.cpuLimit, memory: config.memoryLimit },
            requests: { cpu: config.cpuLimit, memory: config.memoryLimit },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}

export interface PoolTasks {
  /** Create + launch a task. Rejects (throws TypeError-free — returns an error string) on a
   * disallowed subcommand or when at the task cap. */
  create(input: { ownerSub: string; argv: string[]; repo?: string }): Promise<{ task?: Omit<PoolTask, "output">; error?: string; status?: number }>;
  /** One task with its output (owner or admin only — enforced by the route). */
  get(id: Id): PoolTask | undefined;
  /** All tasks (newest first), summaries only. */
  list(): Array<Omit<PoolTask, "output">>;
  /** Cancel a pending/running task: delete its pod, mark cancelled. */
  cancel(id: Id): Promise<boolean>;
  /** Reap any `app=secchat-pool-task` pod with no live registry entry (e.g. after a restart). */
  reconcile(): Promise<string[]>;
}

export function makePoolTasks(deps: {
  k8s: K8sClient;
  config: PoolConfig;
  mintRunnerToken: (ownerSub: string) => Promise<string>;
  /** Poll interval for the phase watcher (test seam; default 5s). */
  pollMs?: number;
  now?: () => number;
}): PoolTasks {
  const tasks = new Map<Id, PoolTask>();
  const pollMs = deps.pollMs ?? 5_000;
  const now = deps.now ?? Date.now;

  const liveCount = () =>
    [...tasks.values()].filter((t) => t.status === "pending" || t.status === "running").length;

  /** Terminal transition: collect the pod's logs (its report), delete the pod, keep the record. */
  async function finish(task: PoolTask, status: TaskStatus): Promise<void> {
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") return;
    const logs = await deps.k8s.podLogs(task.podName).catch(() => ({ ok: false, status: 0, logs: "" }));
    task.output = logs.ok ? logs.logs : task.output;
    task.status = status;
    task.finishedAt = new Date(now()).toISOString();
    await deps.k8s.deletePod(task.podName).catch(() => {});
  }

  /** Watch one task's pod until terminal. Timer-based polling (unref'd) — a task pod has no
   * dial-back channel, so phase polling is the only signal. */
  function watch(task: PoolTask): void {
    const timer = setInterval(() => {
      void (async () => {
        const current = tasks.get(task.id);
        if (!current || current.status === "succeeded" || current.status === "failed" || current.status === "cancelled") {
          clearInterval(timer);
          return;
        }
        const pod = await deps.k8s.getPod(task.podName).catch(() => null);
        if (!pod) return; // transient API failure — keep polling
        if (!pod.ok) {
          // Pod is GONE without SecChat deleting it (evicted / deadline-reaped) — fail with
          // whatever output we can no longer fetch.
          clearInterval(timer);
          task.status = "failed";
          task.finishedAt = new Date(now()).toISOString();
          task.output = task.output ?? "(task pod disappeared before its result could be collected)";
          return;
        }
        if (pod.phase === "Running" && task.status === "pending") task.status = "running";
        if (pod.phase === "Succeeded" || pod.phase === "Failed") {
          clearInterval(timer);
          await finish(task, pod.phase === "Succeeded" ? "succeeded" : "failed");
        }
      })();
    }, pollMs);
    timer.unref?.();
  }

  return {
    async create(input) {
      const sub = input.argv[0];
      if (!sub || !ALLOWED_TASKS.has(sub)) {
        return {
          error: `task must start with one of: ${[...ALLOWED_TASKS].sort().join(", ")} (got ${JSON.stringify(sub ?? null)})`,
          status: 400,
        };
      }
      if (!deps.config.taskImage) return { error: "no task image configured (SECCHAT_POOL_TASK_IMAGE)", status: 503 };
      if (deps.config.maxTasks > 0 && liveCount() >= deps.config.maxTasks) {
        return { error: `task pool at capacity (${liveCount()}/${deps.config.maxTasks}) — try again shortly`, status: 429 };
      }
      let token: string;
      try {
        token = await deps.mintRunnerToken(input.ownerSub);
      } catch {
        return { error: "could not mint a runner token for the task", status: 503 };
      }
      const id = randomUUID();
      const task: PoolTask = {
        id,
        ownerSub: input.ownerSub,
        argv: input.argv,
        podName: taskPodName(id),
        status: "pending",
        createdAt: new Date(now()).toISOString(),
      };
      const manifest = buildTaskPodSpec({
        podName: task.podName, taskId: id, ownerSub: input.ownerSub,
        argv: input.argv, runnerToken: token, config: deps.config, repo: input.repo,
      });
      const res = await deps.k8s.createPod(manifest);
      if (!res.ok) {
        return { error: `failed to create the task pod (${res.status}${res.error ? `: ${res.error}` : ""})`, status: 502 };
      }
      tasks.set(id, task);
      watch(task);
      return { task: taskSummary(task) };
    },

    get(id) {
      return tasks.get(id);
    },

    list() {
      return [...tasks.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(taskSummary);
    },

    async cancel(id) {
      const task = tasks.get(id);
      if (!task || (task.status !== "pending" && task.status !== "running")) return false;
      task.status = "cancelled";
      task.finishedAt = new Date(now()).toISOString();
      await deps.k8s.deletePod(task.podName).catch(() => {});
      return true;
    },

    async reconcile() {
      const res = await deps.k8s.listPods(TASK_LABEL_SELECTOR).catch(() => null);
      if (!res || !res.ok) return [];
      const tracked = new Set([...tasks.values()].map((t) => t.podName));
      const reaped: string[] = [];
      for (const pod of res.pods) {
        if (tracked.has(pod.name)) continue;
        const del = await deps.k8s.deletePod(pod.name).catch(() => null);
        if (del && del.ok) reaped.push(pod.name);
      }
      return reaped;
    },
  };
}
