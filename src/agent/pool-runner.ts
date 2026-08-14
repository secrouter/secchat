// The POOL runner (Part B of the Kubernetes agent pool). A Runner (src/types.ts) whose sessions run
// in a SERVER-LAUNCHED, per-session, EPHEMERAL Kubernetes pod. The pod runs the SAME runnerd image
// used by the desktop daemon; on boot it dials back into `/runner?pool=<sessionId>` with a runner
// token SecChat minted for the owner, and from then on the pod is just another remote runner — so the
// whole RemoteRunner-style relay + the execute-gate run IDENTICALLY (authorization never leaves the
// server). What makes it "pool" rather than "desktop" is only that SecChat OWNS the pod lifecycle:
// it creates the pod on start() and deletes it on stop()/exit.
//
// Kept OFF the per-owner RunnerRegistry on purpose: a pool pod authenticates as the owner (same as a
// desktop daemon would), so registering it there would supersede the owner's real desktop daemon. The
// `?pool=<sessionId>` marker on the attach lets ws/runner-hub.ts route the pod's connection HERE (by
// session) instead — so a user can run a desktop agent AND a pool agent at the same time (per-agent
// routing, see agent/router-runner.ts).
//
// Lifecycle per session:
//   start(input)  → mint token, create the pod (buffer the `start` command; the pod isn't up yet)
//   pod boots     → runnerd attaches at /runner?pool=<sessionId> → handlePoolAttach → send `start`
//   run           → pod relays events up (handlePoolMessage → onEvent); input/tool_answer relay down
//   stop() / exit → send `stop` (best-effort) + DELETE the pod; a hard activeDeadlineSeconds on the
//                   pod (and a start-timeout here) are backstops so a pod can never leak.

import type { GitSshMaterial, Id, Runner, RunnerEvent } from "../types.ts";
import type { PoolConfig } from "../config.ts";
import type { RunnerConnection } from "./runner-registry.ts";
import type { RunnerCommand, RunnerMessage } from "./runner-protocol.ts";
import type { K8sClient } from "./k8s.ts";

/** How long to wait for a pod's runnerd to attach before giving up and reaping it (ms). Covers image
 * pull + boot; a pod that never attaches (crash/pull error) is surfaced as a clean session exit. */
const ATTACH_TIMEOUT_MS = 120_000;

/** A live pool session's public shape — for the `GET /pool/status` observability surface. Carries no
 * content, only lifecycle metadata (who, which pod, attached?, how old). */
export interface PoolSessionInfo {
  sessionId: Id;
  ownerSub: string;
  podName: string;
  attached: boolean;
  ageMs: number;
}

/** The `GET /pool/status` payload — deployment config + live sessions, no content. */
export interface PoolStatus {
  configured: true;
  namespace: string;
  image: string;
  limits: { maxPods: number; maxPerOwner: number; ttlSeconds: number; attachTimeoutMs: number };
  live: number;
  sessions: PoolSessionInfo[];
}

/** The result of a reconcile sweep against the cluster (see PoolRunner.reconcile). */
export interface PoolReconcileResult {
  /** Orphan pod names deleted (in the cluster with our label but no live session here). */
  reaped: string[];
  /** How many sessions SecChat currently tracks. */
  tracked: number;
  /** How many `app=secchat-pool` pods the cluster reported (0 when the list call failed). */
  clusterPods: number;
}

export interface PoolRunner {
  /** The Runner port the control plane drives. */
  runner: Runner;
  /** The pod's runnerd attached at /runner?pool=<sessionId> — send it the buffered `start` and flush
   * any queued input. Called by ws/runner-hub.ts. */
  handlePoolAttach(sessionId: Id, conn: RunnerConnection): void;
  /** A frame the pod sent up. */
  handlePoolMessage(sessionId: Id, conn: RunnerConnection, msg: RunnerMessage): void;
  /** The pod's socket dropped. For an ephemeral pod this means the pod is gone — end the session and
   * reap the pod (unlike a desktop daemon, whose drops are transient reconnects). */
  handlePoolGone(sessionId: Id, conn: RunnerConnection): void;
  /** Snapshot of the live pool sessions — the `GET /pool/status` observability surface. */
  listSessions(): PoolSessionInfo[];
  /** Full status for `GET /pool/status`: deployment limits + the live sessions. */
  status(): PoolStatus;
  /** Reconcile SecChat's tracked sessions against the cluster's actual pods: delete any `app=secchat-
   * pool` pod with no matching live session here (an orphan SecChat lost track of, e.g. across a
   * restart). Belt-and-suspenders beyond per-session delete + the pods' own activeDeadlineSeconds.
   * Best-effort: a failed list/delete is swallowed. Intended to be called periodically. */
  reconcile(): Promise<PoolReconcileResult>;
}

/** The label every pool pod carries (buildPoolPodSpec) — the selector reconcile/list use. */
export const POOL_LABEL_SELECTOR = "app=secchat-pool";

interface PoolSession {
  ownerSub: string;
  podName: string;
  conn?: RunnerConnection;
  /** The `start` command to send once the pod attaches (carries workspace + the owner's gitSsh). */
  pendingStart: RunnerCommand;
  /** input/tool_answer commands issued before the pod attached — flushed on attach, in order. */
  queued: RunnerCommand[];
  attached: boolean;
  ended: boolean;
  attachTimer?: ReturnType<typeof setTimeout>;
  /** When start() admitted this session (epoch ms) — for the status surface's `ageMs`. */
  createdAt: number;
}

/** Build the Pod manifest for one pool session. Hardened + least-privilege: no K8s API access
 * (`automountServiceAccountToken: false`), non-root, all capabilities dropped, one-shot
 * (`restartPolicy: Never`), and a hard `activeDeadlineSeconds` TTL so K8s always reaps it. The pod
 * dials back to `secchatUrl` and identifies its session via SECCHAT_POOL_SESSION (runnerd appends
 * `?pool=<id>` to the attach URL). The SSH key is NOT put here — it rides the `start` command over the
 * authed /runner channel, exactly as for the desktop daemon. */
export function buildPoolPodSpec(input: {
  podName: string;
  sessionId: Id;
  ownerSub: string;
  runnerToken: string;
  config: PoolConfig;
}): Record<string, unknown> {
  const { podName, sessionId, runnerToken, config } = input;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      labels: { app: "secchat-pool" },
      // Owner/session as ANNOTATIONS (label values are DNS-restricted; a sub or uuid may not fit).
      annotations: { "secchat.io/session": sessionId, "secchat.io/owner": input.ownerSub },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false, // the agent pod has no business talking to the K8s API
      activeDeadlineSeconds: config.activeDeadlineSeconds, // hard TTL backstop against a leaked pod
      // runAsNonRoot needs a NUMERIC uid: with only a non-numeric image USER (the node image's
      // `node`), the kubelet can't verify non-root at admission and REFUSES to start the pod. 1000 is
      // the `node` user in the runnerd image's node base — pinning it satisfies the check.
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
      containers: [
        {
          name: "runnerd",
          image: config.image,
          env: [
            { name: "SECCHAT_URL", value: config.secchatUrl },
            { name: "SECCHAT_RUNNER_TOKEN", value: runnerToken },
            { name: "SECCHAT_POOL_SESSION", value: sessionId },
            // Route the pod's pi model calls through SecChat's own /agent-llm/v1 proxy (NOT SecRouter
            // directly) — same as the desktop daemon. The proxy authenticates the pod by its
            // owner-scoped runner token (PI_API_KEY, the same credential it attaches with) and forwards
            // to the secured SecRouter with the service token + X-Sec-Acting-User, so the pool agent's
            // model calls attribute to the owner and never carry a SecRouter credential into the pod.
            { name: "PI_BASE_URL", value: `${config.secchatUrl.replace(/\/$/, "")}/agent-llm/v1` },
            { name: "PI_API_KEY", value: runnerToken },
          ],
          resources: {
            limits: { cpu: config.cpuLimit, memory: config.memoryLimit },
            requests: { cpu: config.cpuLimit, memory: config.memoryLimit },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: false, // git + pi need a writable workspace/tmp
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}

/** A DNS-1123-safe pod name for a session (lowercase alnum + '-', ≤63 chars). A session id is a uuid,
 * already conforming, but the prefix keeps pool pods identifiable + collision-free. */
export function poolPodName(sessionId: Id): string {
  return `secchat-pool-${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63).replace(/-+$/, "");
}

export function makePoolRunner(deps: {
  k8s: K8sClient;
  config: PoolConfig;
  /** Mint an owner-scoped runner token for the pod (config.runnerToken.mint). */
  mintRunnerToken: (ownerSub: string) => Promise<string>;
  /** Renew a live session's lease on the pod's heartbeat (keeps the orphan reaper at bay). */
  renewLease?: (sessionId: Id) => void;
  /** Test seam for the attach timeout (ms). */
  attachTimeoutMs?: number;
}): PoolRunner {
  const sessions = new Map<Id, PoolSession>();
  let handler: ((sessionId: Id, event: RunnerEvent) => void) | null = null;
  // Attach timeout: explicit test seam first, else the operator-configured value, else the default.
  const attachTimeoutMs = deps.attachTimeoutMs ?? deps.config.attachTimeoutMs ?? ATTACH_TIMEOUT_MS;

  const emit = (sessionId: Id, event: RunnerEvent): void => handler?.(sessionId, event);

  /** How many pods this owner currently holds — for per-owner admission control. */
  const countForOwner = (ownerSub: string): number => {
    let n = 0;
    for (const s of sessions.values()) if (s.ownerSub === ownerSub) n += 1;
    return n;
  };

  /** Terminal transition: emit exit (+ optional narration), reap the pod, forget the session.
   * Idempotent — the pod's exit event and its socket-close can both land. */
  async function finish(sessionId: Id, session: PoolSession, opts: { code?: number; message?: string; emitExit: boolean }): Promise<void> {
    if (session.ended) return;
    session.ended = true;
    if (session.attachTimer) clearTimeout(session.attachTimer);
    sessions.delete(sessionId);
    if (opts.message !== undefined) emit(sessionId, { type: "output", text: opts.message });
    if (opts.emitExit) emit(sessionId, { type: "exit", code: opts.code });
    // Best-effort reap — a failure here must not throw out of an event handler.
    await deps.k8s.deletePod(session.podName).catch(() => {});
  }

  const runner: Runner = {
    async start(input) {
      // Admission control (fail-fast): never create an unbounded number of pods. Reject the session
      // cleanly when at the global cap or this owner's cap, rather than piling pods onto the cluster
      // and relying solely on the K8s ResourceQuota to (opaquely) reject the create. 0 = unlimited.
      const { maxPods, maxPerOwner } = deps.config;
      if (maxPods > 0 && sessions.size >= maxPods) {
        emit(input.sessionId, { type: "output", text: `▸ pool at capacity (${sessions.size}/${maxPods} agents running) — try again shortly` });
        emit(input.sessionId, { type: "exit", code: 1 });
        return;
      }
      if (maxPerOwner > 0 && countForOwner(input.ownerSub) >= maxPerOwner) {
        emit(input.sessionId, { type: "output", text: `▸ pool: you already have ${countForOwner(input.ownerSub)}/${maxPerOwner} agents running — stop one before starting another` });
        emit(input.sessionId, { type: "exit", code: 1 });
        return;
      }

      const podName = poolPodName(input.sessionId);
      let token: string;
      try {
        token = await deps.mintRunnerToken(input.ownerSub);
      } catch {
        emit(input.sessionId, { type: "output", text: "▸ pool: could not mint a runner token for the pod" });
        emit(input.sessionId, { type: "exit", code: 1 });
        return;
      }

      const pendingStart: RunnerCommand = {
        type: "start",
        sessionId: input.sessionId,
        agentId: input.agentId,
        ownerSub: input.ownerSub,
        workspace: input.workspace,
        gitSsh: input.gitSsh,
      };
      const session: PoolSession = {
        ownerSub: input.ownerSub,
        podName,
        pendingStart,
        queued: [],
        attached: false,
        ended: false,
        createdAt: Date.now(),
      };
      sessions.set(input.sessionId, session);

      const manifest = buildPoolPodSpec({ podName, sessionId: input.sessionId, ownerSub: input.ownerSub, runnerToken: token, config: deps.config });
      const res = await deps.k8s.createPod(manifest);
      if (!res.ok) {
        await finish(input.sessionId, session, { code: 1, message: `▸ pool: failed to create the agent pod (${res.status}${res.error ? `: ${res.error}` : ""})`, emitExit: true });
        return;
      }
      emit(input.sessionId, { type: "output", text: "▸ pool: launching an online agent runner…" });

      // Backstop: if the pod never attaches (image pull failure, crash), end the session + reap it.
      const timer = setTimeout(() => {
        const s = sessions.get(input.sessionId);
        if (s && !s.attached && !s.ended) {
          void finish(input.sessionId, s, { code: 1, message: "▸ pool: the agent pod did not come online in time", emitExit: true });
        }
      }, attachTimeoutMs);
      timer.unref?.();
      session.attachTimer = timer;
    },

    async sendInput(sessionId, text) {
      relay(sessionId, { type: "input", sessionId, text });
    },
    async answerTool(sessionId, requestId, decision) {
      relay(sessionId, { type: "tool_answer", sessionId, requestId, decision });
    },
    async stop(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.conn?.send({ type: "stop", sessionId });
      // stop() is an explicit teardown — reap without emitting another exit (the caller ended it).
      await finish(sessionId, session, { emitExit: false });
    },
    onEvent(cb) {
      handler = cb;
    },
  };

  /** Send a command to the pod if attached, else buffer it until attach. */
  function relay(sessionId: Id, cmd: RunnerCommand): void {
    const session = sessions.get(sessionId);
    if (!session || session.ended) return;
    if (session.attached && session.conn) session.conn.send(cmd);
    else session.queued.push(cmd);
  }

  function handlePoolAttach(sessionId: Id, conn: RunnerConnection): void {
    const session = sessions.get(sessionId);
    // Unknown/late/foreign attach — no matching session, or the pod authenticated as a different sub
    // than the session's owner. Drop it (the pod will hit its activeDeadlineSeconds and be reaped).
    if (!session || session.ended || conn.ownerSub !== session.ownerSub) return;
    session.conn = conn;
    session.attached = true;
    if (session.attachTimer) clearTimeout(session.attachTimer);
    conn.send(session.pendingStart);
    for (const cmd of session.queued) conn.send(cmd);
    session.queued = [];
  }

  function handlePoolMessage(sessionId: Id, conn: RunnerConnection, msg: RunnerMessage): void {
    const session = sessions.get(sessionId);
    if (!session || session.conn !== conn) return; // not this session's pod
    switch (msg.type) {
      case "event":
        if (msg.event.type === "exit") {
          void finish(sessionId, session, { code: msg.event.code, emitExit: true });
          return;
        }
        emit(sessionId, msg.event);
        return;
      case "heartbeat":
        deps.renewLease?.(sessionId);
        return;
      case "register":
        return; // the attach already bound this pod; a stray register is a no-op
    }
  }

  function handlePoolGone(sessionId: Id, conn: RunnerConnection): void {
    const session = sessions.get(sessionId);
    if (!session || session.conn !== conn || session.ended) return;
    // An ephemeral pod's socket dropping means the pod is gone — end the session + reap it.
    void finish(sessionId, session, { code: 1, message: "▸ pool: the agent runner disconnected", emitExit: true });
  }

  function listSessions(): PoolSessionInfo[] {
    const now = Date.now();
    return [...sessions.entries()].map(([sessionId, s]) => ({
      sessionId,
      ownerSub: s.ownerSub,
      podName: s.podName,
      attached: s.attached,
      ageMs: now - s.createdAt,
    }));
  }

  function status(): PoolStatus {
    const c = deps.config;
    const live = listSessions();
    return {
      configured: true,
      namespace: c.namespace,
      image: c.image,
      limits: { maxPods: c.maxPods, maxPerOwner: c.maxPerOwner, ttlSeconds: c.activeDeadlineSeconds, attachTimeoutMs: c.attachTimeoutMs },
      live: live.length,
      sessions: live,
    };
  }

  async function reconcile(): Promise<PoolReconcileResult> {
    const tracked = sessions.size;
    const res = await deps.k8s.listPods(POOL_LABEL_SELECTOR).catch(() => null);
    if (!res || !res.ok) return { reaped: [], tracked, clusterPods: 0 };
    const trackedPods = new Set([...sessions.values()].map((s) => s.podName));
    const reaped: string[] = [];
    for (const pod of res.pods) {
      if (trackedPods.has(pod.name)) continue; // a live session owns this pod — leave it
      // Orphan: our label, but no live session here. Reap it (best-effort).
      const del = await deps.k8s.deletePod(pod.name).catch(() => null);
      if (del && del.ok) reaped.push(pod.name);
    }
    return { reaped, tracked, clusterPods: res.pods.length };
  }

  return { runner, handlePoolAttach, handlePoolMessage, handlePoolGone, listSessions, status, reconcile };
}
