# The Kubernetes agent pool

The agent pool is an **optional** place for coding agents to run: instead of the user's desktop app
(the runner daemon), a `"pool"` agent runs in a **server-launched, per-session, ephemeral Kubernetes
pod**. The pod runs the **same runnerd image** the desktop daemon uses; on boot it dials back into
SecChat's `/runner` and from then on is just another remote runner — so the execute-gate runs
identically and **only the agent's owner can authorize execution**, exactly as with a desktop runner.

```
POST /agents {launchEnv:"pool"}  → agent pinned to the pool (persisted)
spawn ──► PoolRunner.start ──► create a Pod (runnerd image) with a minted runner token
          Pod boots ──► runnerd attaches at /runner?pool=<sessionId>  (as the owner)
          ──► SecChat sends `start` (workspace + the owner's git SSH key) down the channel
          ──► pi runs; tool calls gate through SecChat's control plane (owner-only)
session ends / stop ──► SecChat DELETEs the Pod   (activeDeadlineSeconds is a hard backstop)
```

## Why it's built this way

- **Reuses the whole remote-runner path.** A pool pod is a runnerd that attaches out, so the registry
  / relay / execute-gate are unchanged — the pool is "just" a server-owned daemon lifecycle.
- **Per-agent routing.** The chosen environment is persisted on the agent (`launch_env`), so a user
  can run a **desktop agent and a pool agent at the same time**. The pod attaches with a
  `?pool=<sessionId>` marker so SecChat routes it to the pool runner **by session** — never into the
  per-owner desktop registry, where it would otherwise supersede the user's real desktop daemon.
- **No new dependency.** The Kubernetes API is reached with `node:https` + the in-cluster
  ServiceAccount token + CA (the same shape SecRouter uses for Bedrock) — no client library.
- **Hardened, ephemeral pods.** `restartPolicy: Never`, `automountServiceAccountToken: false` (the
  agent pod has no K8s API access), non-root, all capabilities dropped, and a hard
  `activeDeadlineSeconds` TTL so a pod can never leak even if SecChat misses the delete.
- **Git auth without a shared secret.** The owner's per-user SSH key (see
  [git-ssh-keys.md](git-ssh-keys.md)) is injected over the authed `/runner` channel — never baked
  into the pod manifest.

## Configuration (environment)

The pool is OFF unless `SECCHAT_POOL_IMAGE` is set, and it additionally needs a runner-token secret
(`SECCHAT_RUNNER_TOKEN_SECRET`, or the session secret) so SecChat can mint the token the pod attaches
with.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_POOL_IMAGE` | *(unset ⇒ pool off)* | The runnerd container image the pool pods run. Required to enable the pool. |
| `SECCHAT_POOL_NAMESPACE` | `secchat-pool` (or the pod's own namespace) | Namespace the pool pods are created in. |
| `SECCHAT_POOL_APISERVER` | `https://kubernetes.default.svc` | Kubernetes API server base. |
| `SECCHAT_POOL_SECCHAT_URL` | `http://secchat:<port>` | Cluster-internal URL a pool pod dials back to reach `/runner`. |
| `SECCHAT_POOL_CPU` / `SECCHAT_POOL_MEMORY` | `1` / `1Gi` | Per-pod resource limits (K8s quantities). |
| `SECCHAT_POOL_TTL` | `3600` | Hard pod TTL (`activeDeadlineSeconds`), a backstop against a leaked pod. |
| `SECCHAT_POOL_MAX_PODS` | `20` | Global in-process admission cap (`0` = unlimited): at the cap, a new pool session is rejected fast with a clear message instead of relying on the cluster quota. |
| `SECCHAT_POOL_MAX_PER_OWNER` | `3` | Per-owner admission cap (`0` = unlimited). |
| `SECCHAT_POOL_ATTACH_TIMEOUT` | `120000` | How long (ms) to wait for a pod's runnerd to attach before reaping it — covers image pull + boot. |
| `SECCHAT_POOL_ANALYSIS_IMAGES` | *(unset ⇒ no sidecars)* | Analysis sidecar catalog, `name=image,name=image` — the analyzers a pool agent may attach (see below). |

## Analysis sidecars (shared /workspace + file work-queue)

An agent created with `analysis: ["<name>", …]` (names from the catalog; checkboxes in the
New-Coding-Agent dialog) gets each named image as an extra **hardened sidecar container in its
pod**. Every pool pod declares a shared `workspace` emptyDir mounted at `/workspace` in all
containers; pi's state + working tree are rooted there (`SECCHAT_PI_STATE_DIR=/workspace/state`),
so the analyzers' tooling operates on the agent's actual code. The pod-level `fsGroup: 1000`
matters: without it the emptyDir mounts root-owned and every non-root container gets EACCES.

Containers can't exec into each other, so each sidecar idles on a **file work-queue**:

1. The agent writes a shell command to `/workspace/.analysis/<name>/request` — that write passes
   through the execute-gate like any other mutating tool call.
2. The sidecar (a POSIX-`sh` watcher; no image changes needed) moves it to `running`, executes it
   with its own tooling, writes stdout+stderr to `output` and the status to `exit`, and removes
   `running`.
3. The agent polls for `exit` / reads `output`.

## Internet access (per-agent, default OFF)

`analysisEgress: true` at agent creation labels the pod `secchat.io/egress: open`, which the
cluster's opt-in allow-all-egress NetworkPolicy selects; without it (the default) the pod keeps
the restricted egress allowlist (DNS + git ports + the SecChat dial-back). Fail-closed: no label →
no match → restricted. The UI switch is warn-tinted and off by default.

## Deploying (RBAC + network policy)

SecChat needs a ServiceAccount with permission to create/delete Pods in the pool namespace, and the
pool namespace should be locked down with a NetworkPolicy so agent pods can reach **only** SecChat and
the enclave git host. SecDeploy generates these manifests for the enclave's cluster (the operator
owns the cluster); the minimal shape is:

- a `secchat-pool` namespace;
- a Role granting `create`/`delete`/`get` on `pods` there, bound to SecChat's ServiceAccount;
- a default-deny NetworkPolicy + an egress allow to SecChat + the git host;
- a ResourceQuota bounding the number/size of pool pods.

The pool is genuinely optional: a deployment with no cluster simply leaves `SECCHAT_POOL_IMAGE` unset
and the "Online pool" option stays unavailable in the client.
