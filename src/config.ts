// Environment-driven configuration. No secrets are defaulted; a missing REQUIRED value fails
// closed at startup (never silently insecure). Kept dependency-free — plain process.env.

import {
  DEFAULT_CUI_CATEGORIES,
  DEFAULT_MARKING_PROFILE,
  makeMarkingPolicy,
  type MarkingPolicy,
  markingProfile,
  parseCaveatDefs,
  parseMarkingLevels,
} from "./marking/policy.ts";
import { DlpPolicy, type DlpMode, parseDlpRules } from "./dlp/policy.ts";
import { type CapabilityPolicy, type CapabilityRule, defaultCapabilityPolicy } from "./auth/capabilities.ts";
import { makeStepUp, type StepUp } from "./auth/stepup.ts";
import { makeRunnerToken, type RunnerToken } from "./auth/runner-token.ts";
import { deriveSecretKey } from "./ssh/keys.ts";
import type { ServiceTokenConfig } from "./secrouter/token.ts";

/** Build the SecRouter client-credentials service identity from the environment, or undefined when
 * it isn't fully configured (all three of token-url / client-id / client-secret required). */
function secrouterServiceTokenFromEnv(env: NodeJS.ProcessEnv): ServiceTokenConfig | undefined {
  const tokenUrl = env.SECCHAT_SECROUTER_TOKEN_URL?.trim();
  const clientId = env.SECCHAT_SECROUTER_CLIENT_ID?.trim();
  const clientSecret = env.SECCHAT_SECROUTER_CLIENT_SECRET?.trim();
  if (!tokenUrl || !clientId || !clientSecret) return undefined;
  return { tokenUrl, clientId, clientSecret, scope: env.SECCHAT_SECROUTER_SCOPE?.trim() || "secrouter" };
}

export interface Config {
  host: string;
  port: number;
  /** SecSSO (Authentik) OIDC issuer — its JWKS is the ONLY trust root for user tokens. */
  oidcIssuer: string;
  /** Expected audience (SecChat's OIDC client id). Tokens for other audiences are rejected. */
  oidcAudience: string;
  /** JWKS endpoint; derived from the issuer when not set explicitly. */
  jwksUrl: string;
  /** SecRouter gateway base URL — the assistant path routes model calls here (delegated). */
  secrouterUrl: string;
  /** Service token SecChat presents to SecRouter (the assistant path needs it; a bare chat
   * without agents does not). The real client-credentials flow (below) replaces the static token
   * when a service client is configured. */
  secrouterToken?: string;
  /** OIDC client-credentials service identity for SecRouter's secure mode. When set (all three of
   * `SECCHAT_SECROUTER_TOKEN_URL` / `_CLIENT_ID` / `_CLIENT_SECRET`), SecChat fetches a fresh OIDC
   * access token per call (see secrouter/token.ts) instead of the static `secrouterToken` — required
   * once SecRouter runs with security.enabled. Unset ⇒ the static token (or none) is used, unchanged. */
  secrouterServiceToken?: ServiceTokenConfig;
  /** Default model for an assistant agent created without an explicit one (the picker sets a
   * per-agent model; this is the fallback). `"auto"` lets SecRouter classify + route; set it to a
   * concrete id (e.g. `secllm/fast`) for a deployment whose SecRouter `auto` tiers reference
   * models the local SecLLM hasn't loaded. */
  assistantModel: string;
  /** Postgres DSN for the PgStore (unset ⇒ in-memory store; dev/test only). */
  databaseUrl?: string;
  /** SecSSO group whose members may read the admin / audit-review console (/admin*). */
  adminGroup: string;
  /** DEV ONLY: serve /admin with a synthetic admin principal (no real login). Off by default;
   * never enable outside local development — the real console auths via SecSSO. */
  devMode: boolean;

  // ── SSO login (OIDC BFF — see auth/bff.ts). The backend runs the Authorization Code + PKCE
  // dance itself and issues an httpOnly session cookie; no OIDC token ever reaches the browser.
  // Fully optional — the bearer-JWT path above (and dev tokens) work with none of this set. ────

  /** OIDC client id for the BFF login flow. Defaults to `oidcAudience` — the same SecChat OIDC
   * client is normally used for both the bearer-JWT audience check and the login flow. */
  oidcClientId: string;
  /** Confidential-client secret for the BFF's server-side token exchange. Unset ⇒ SSO login is
   * disabled (see `ssoEnabled`) — only the bearer-JWT path (and dev tokens) work. */
  oidcClientSecret?: string;
  /** External base URL this app is reachable at (e.g. https://secchat.sec.internal) — builds
   * the OIDC redirect_uri (`${publicUrl}/auth/callback`) and decides the cookie `Secure` flag.
   * Unset ⇒ SSO login is disabled. */
  publicUrl?: string;
  /** HS256 signing key for the SecChat-minted session cookie (see auth/session.ts). Unset ⇒ SSO
   * login is disabled — never falls back to an unsigned or guessable key. */
  sessionSecret?: string;
  /** Session cookie TTL, seconds. */
  sessionTtl: number;
  /** True only once `oidcClientSecret`, `publicUrl`, and `sessionSecret` are ALL set. When
   * false, `/auth/login|callback|logout` 503 and the client falls back to the dev/bearer path;
   * `/auth/status` always reports this value so the client knows which login UI to show. */
  ssoEnabled: boolean;

  /** The classification-marking ladder + default level (a DEPLOYMENT SETTING). Drives channel/
   * message marking, the rendered banners, and the blocking spillage checks. Defaults to
   * UNCLASSIFIED → PROPRIETARY → CUI → CLASSIFIED with UNCLASSIFIED as the fail-safe default.
   * Set `SECCHAT_MARKING_LEVELS` (comma-separated, low→high) and `SECCHAT_MARKING_DEFAULT`. */
  marking: MarkingPolicy;

  /** Local DLP: an on-premise content scanner run on every message post. `SECCHAT_DLP_MODE`
   * (off|flag|block, default flag) and an optional `SECCHAT_DLP_RULES` JSON override. Fails closed
   * at startup on a bad mode or malformed rule. */
  dlp: DlpPolicy;

  /** Privileged-action authorization: each capability's required IdP group + step-up freshness.
   * `SECCHAT_CAP_<REDACT|AGENT|DOWNGRADE|WEBHOOK>_GROUP` / `_STEPUP`. Defaults: redact/downgrade/
   * webhook → the admin group; agent ungated; step-up off. */
  capabilities: CapabilityPolicy;

  /** Step-up token minter/verifier — present when a signing secret is available
   * (`SECCHAT_STEPUP_SECRET`, else the session secret). Unset ⇒ step-up can't be satisfied, so any
   * capability configured to require it fails closed. */
  stepUp?: StepUp;

  /** Runner token minter/verifier — the daemon credential a client mints (POST /auth/runner-token).
   * Present when `SECCHAT_RUNNER_TOKEN_SECRET` (else the session secret) is set. */
  runnerToken?: RunnerToken;

  /** Directory for content-addressed attachment bytes (`SECCHAT_UPLOADS_DIR`, default `./uploads`). */
  uploadsDir: string;
  /** Max attachment upload size in bytes (`SECCHAT_MAX_UPLOAD_BYTES`, default 25 MiB). */
  maxUploadBytes: number;

  /** Destination-host allowlist for OUTBOUND webhooks (`SECCHAT_OUTBOUND_ALLOWED_HOSTS`, a
   * comma-separated hostname list). Empty (the default) ⇒ any http(s) host is permitted; set it to
   * pin outbound egress to known receivers in a locked-down deployment. Enforced when a webhook is
   * created (see webhooks/outbound.ts's isAllowedOutboundUrl). */
  outboundAllowedHosts: string[];

  /** Deployment master key (32 bytes, derived from `SECCHAT_SECRET_KEY`) used to AES-256-GCM-encrypt
   * per-user SSH private keys at rest (src/ssh/keys.ts). Unset ⇒ the git-SSH-identity feature is
   * OFF: `/me/ssh-key` 503s and no key is injected into runners. Never falls back to a guessable key.
   * Use a long, high-entropy secret (it is folded to 256 bits via SHA-256). */
  secretKey?: Buffer;
  /** True only when `secretKey` is set — gates the per-user SSH-key routes + injection. */
  sshEnabled: boolean;
  /** Optional pinned SSH `known_hosts` content (`SECCHAT_GIT_KNOWN_HOSTS`) for the enclave git
   * host(s), injected into runners so git verifies the host key strictly. Unset ⇒ runners use
   * StrictHostKeyChecking=accept-new (trust-on-first-use), which still pins after the first connect. */
  gitKnownHosts?: string;

  /** Optional Kubernetes agent pool: coding agents whose launch env is `"pool"` run in a
   * server-launched pod (running the runnerd image) that dials back into `/runner`. Present only when
   * `SECCHAT_POOL_IMAGE` is set — otherwise the pool is OFF and the client's "Online pool" option
   * stays unavailable. Requires a runner-token minter (`runnerToken`) so the pod can attach as the
   * owner. See src/agent/pool-runner.ts + src/agent/k8s.ts. */
  pool?: PoolConfig;

  // ── Voice calls (docs/plans/voice-calls-plan.md) — all optional; unset ⇒ the feature stays off
  // exactly like `pool` above (a scaffold-phase concern too: these are read by calls/registry.ts,
  // calls/mediad-client.ts, transcribe/client.ts, none of which are implemented yet). ────────────

  /** SecRecorder base URL (`SECCHAT_TRANSCRIBE_URL`) for per-leg call transcription (§2.4).
   * Unset ⇒ a recorded call's audio still gets posted, just without a transcript (see
   * transcribe/client.ts's failure-isolation note). */
  transcribeUrl?: string;
  /** secchat-mediad's control API (`SECCHAT_MEDIAD_URL` + shared bearer `SECCHAT_MEDIAD_TOKEN`).
   * Unset ⇒ recording is unavailable — calls still work, just p2p-only (§2.3's fail-closed-
   * recording, fail-open-calling policy). */
  mediad?: MediadConfig;
  /** STUN server(s) offered to clients for p2p ICE gathering (`SECCHAT_CALL_STUN`, comma-separated
   * `stun:host:port` URLs). Empty (the default) ⇒ none configured — LAN/VPN p2p calls still usually
   * connect via host/peer-reflexive candidates; a public STUN default is deliberately NOT used here
   * (§2.5 v3 review: it would leak an unrecorded call's existence + client IPs to a third party and
   * break the suite's air-gap posture — coturn in STUN-only mode is the documented suite-local
   * option). Relayed (recorded) calls never need STUN — mediad is a fixed host:port. */
  callStun: string[];
}

/** secchat-mediad's control-API location + shared credential (see Config.mediad). */
export interface MediadConfig {
  url: string;
  token: string;
  /** The shared recordings-volume directory THIS backend process can read/write
   * (`SECCHAT_MEDIAD_RECORDINGS_DIR`, docs/plans/voice-contracts.md §4 — secdeploy mounts it at
   * `/var/lib/secchat/recordings`, distinct from `uploadsDir`). Required alongside `url`/`token` for
   * the post-call pipeline to actually ingest a recording or transcribe a leg (calls/registry.ts's
   * `runPostCallPipeline`, calls/mediad-client.ts's `reconcileUnclaimedSessions`) — without it a
   * relayed call still gets recorded by mediad, but the mixed file is never claimed as an attachment
   * and no leg can be read for transcription. Unset ⇒ those two steps stay no-ops (logged), same
   * "feature partially off" posture as every other optional Config field. */
  recordingsDir?: string;
}

/** Deployment settings for the Kubernetes agent pool (see Config.pool). */
export interface PoolConfig {
  /** Kubernetes API server base (`SECCHAT_POOL_APISERVER`, default the in-cluster endpoint). */
  apiServer: string;
  /** Namespace the pool pods are created in (`SECCHAT_POOL_NAMESPACE`, default `secchat-pool`). */
  namespace: string;
  /** The runnerd container image the pool pods run (`SECCHAT_POOL_IMAGE`) — REQUIRED to enable. */
  image: string;
  /** The cluster-internal URL a pool pod dials back to reach THIS SecChat's `/runner`
   * (`SECCHAT_POOL_SECCHAT_URL`, e.g. `http://secchat.secchat.svc:47010`). The pod appends
   * `?pool=<sessionId>` to reach the pool hub. */
  secchatUrl: string;
  /** Per-pod CPU/memory limits (`SECCHAT_POOL_CPU`/`_MEMORY`, K8s quantity strings). */
  cpuLimit: string;
  memoryLimit: string;
  /** Hard pod TTL in seconds (`SECCHAT_POOL_TTL`) set as the pod's `activeDeadlineSeconds` — a
   * backstop so K8s always reaps an orphaned pod even if SecChat misses the delete. */
  activeDeadlineSeconds: number;
  /** Max concurrent pool pods SecChat will keep in flight across ALL owners (`SECCHAT_POOL_MAX_PODS`,
   * default 20; `0` = unlimited). In-process admission control (fail-fast) so a burst can't create an
   * unbounded number of pods — independent of, and tighter than, the cluster ResourceQuota. */
  maxPods: number;
  /** Max concurrent pool pods a SINGLE owner may hold (`SECCHAT_POOL_MAX_PER_OWNER`, default 3; `0` =
   * unlimited) — stops one user starving the global cap. */
  maxPerOwner: number;
  /** How long to wait for a pod's runnerd to attach before reaping it (`SECCHAT_POOL_ATTACH_TIMEOUT`,
   * ms, default 120000) — covers image pull + boot. */
  attachTimeoutMs: number;
  /** Analysis sidecar images offerable per agent pod, name → image
   * (`SECCHAT_POOL_ANALYSIS_IMAGES`, e.g. `rust=secagent-analyzer-rust:1,ikos=secagent-analysis:1`).
   * An agent created with `analysis: ["rust"]` gets that container attached to its pod, sharing the
   * pod's /workspace volume so the tooling operates on the agent's working tree. Empty ⇒ the
   * feature is off (POST /agents rejects any analysis request). */
  analysisImages: Record<string, string>;
  /** Image for one-shot POOL TASKS (`SECCHAT_POOL_TASK_IMAGE`) — the secagent agent image, whose
   * `secagent` CLI runs batch jobs (`review mr`, `docs build`, `analyze run`, …) in an ephemeral
   * pod via the task API (POST /pool/tasks). Unset ⇒ the task API is off (503). */
  taskImage?: string;
  /** Max concurrent one-shot task pods (`SECCHAT_POOL_MAX_TASKS`, default 5; `0` = unlimited) —
   * admission for the task API, separate from the interactive-session caps. */
  maxTasks: number;
  /** Path INSIDE the runnerd image to secagent's pi extension (`SECCHAT_POOL_PI_EXTENSION`).
   * When set, pool pods get `SECAGENT_PI_EXTENSION=<path>` so the pod's pi loads secagent's tools
   * — including `analysis_run`, which drives the analysis sidecars via the shared-volume work
   * queue (the pod also gets `SECCHAT_ANALYSIS` naming its attached analyzers). Unset ⇒ pods run
   * pi without the secagent extension (the analyzers are then only reachable by hand). */
  piExtension?: string;
}

/** Parse `SECCHAT_POOL_ANALYSIS_IMAGES` ("name=image,name=image") into the analyzer catalog.
 * Names are DNS-label-ish (lowercased; they become container names `analysis-<name>`); malformed
 * entries are skipped rather than fatal — a typo shouldn't take the whole deployment down. */
export function parseAnalysisImages(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (raw ?? "").split(",")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq).trim().toLowerCase();
    const image = entry.slice(eq + 1).trim();
    if (/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(name) && image) out[name] = image;
  }
  return out;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v || !v.trim()) throw new Error(`missing required env ${key}`);
  return v.trim();
}

function opt(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key];
  return v && v.trim() ? v.trim() : fallback;
}

/** Build a Config from an env bag (defaults to process.env). Throws on missing required keys. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Keep the issuer EXACTLY as configured (trailing slash included). OIDC's `iss` is an exact-
  // match identifier: Authentik's canonical issuer ends with "/" and its id_tokens carry that
  // slash, so stripping it here made jose's issuer check fail every login. The discovery URL is
  // built by stripping a trailing slash locally (see auth/oidc.ts) so this stays canonical.
  const issuer = req(env, "SECCHAT_OIDC_ISSUER").trim();
  const oidcAudience = req(env, "SECCHAT_OIDC_AUDIENCE");
  const oidcClientSecret = env.SECCHAT_OIDC_CLIENT_SECRET?.trim() || undefined;
  const publicUrl = env.SECCHAT_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  const sessionSecret = env.SECCHAT_SESSION_SECRET?.trim() || undefined;
  // Marking: a deployment posture. `SECCHAT_MARKING_PROFILE` (dod-cui default | dod-classified |
  // commercial) presets the taxonomy + baseline; `SECCHAT_MARKING_LEVELS` fully overrides it (a
  // custom ladder). Either way `SECCHAT_MARKING_DEFAULT` can override the baseline. A malformed
  // profile/ladder (unknown profile, empty list, or a default outside the ladder) fails closed here.
  const markingLevelsRaw = env.SECCHAT_MARKING_LEVELS?.trim();
  const profile = markingLevelsRaw ? null : markingProfile(opt(env, "SECCHAT_MARKING_PROFILE", DEFAULT_MARKING_PROFILE));
  const markingLevels = markingLevelsRaw ? parseMarkingLevels(markingLevelsRaw) : [...profile!.levels];
  const markingDefault = opt(env, "SECCHAT_MARKING_DEFAULT", profile?.default ?? markingLevels[0] ?? "");
  // Optional CUI categories (unranked caveats): an explicit `SECCHAT_MARKING_CATEGORIES` JSON override
  // wins (throws on malformed); otherwise the profile's set, or the starter set for a custom ladder.
  // makeMarkingPolicy filters these to the ladder's levels (a category for an absent level is dropped).
  // NOTE: the built-in set is a reasonable STARTER — verify the exact codes / Basic-vs-Specified (SP-)
  // prefixes against your agency's ISOO CUI Registry entry and override here as needed. The banner
  // grammar is forward-compatible (LEVEL//CATEGORIES//DISSEM), so dissemination controls / classified
  // compartments are a later caveat `kind`, not a schema change.
  const markingCategories = env.SECCHAT_MARKING_CATEGORIES?.trim()
    ? parseCaveatDefs(env.SECCHAT_MARKING_CATEGORIES)
    : [...(profile?.categories ?? DEFAULT_CUI_CATEGORIES)];
  const marking = makeMarkingPolicy(markingLevels, markingDefault, markingCategories);
  // Local DLP: default to `flag` (detect + record, never block legitimate work); a bad mode or
  // malformed rule override throws here, at startup.
  const dlp = new DlpPolicy(
    opt(env, "SECCHAT_DLP_MODE", "flag") as DlpMode,
    parseDlpRules(env.SECCHAT_DLP_RULES),
  );
  // Privileged-capability policy: start from the behavior-preserving defaults, then apply optional
  // per-capability group / step-up overrides (the group names a deployment maps to its IdP).
  const adminGroup = opt(env, "SECCHAT_ADMIN_GROUP", "secchat-admins");
  const capDefaults = defaultCapabilityPolicy(adminGroup);
  const capRule = (key: string, fallback: CapabilityRule): CapabilityRule => ({
    group: env[`SECCHAT_CAP_${key}_GROUP`]?.trim() ?? fallback.group,
    stepUpSeconds: env[`SECCHAT_CAP_${key}_STEPUP`]?.trim()
      ? Number(env[`SECCHAT_CAP_${key}_STEPUP`])
      : fallback.stepUpSeconds,
  });
  const capabilities: CapabilityPolicy = {
    "message.redact": capRule("REDACT", capDefaults["message.redact"]),
    "agent.manage": capRule("AGENT", capDefaults["agent.manage"]),
    "marking.downgrade": capRule("DOWNGRADE", capDefaults["marking.downgrade"]),
    "webhook.create": capRule("WEBHOOK", capDefaults["webhook.create"]),
  };
  // Step-up signing: a dedicated secret, else the session secret. Absent ⇒ step-up unavailable.
  const stepUpSecret = env.SECCHAT_STEPUP_SECRET?.trim() || sessionSecret;
  const stepUp = stepUpSecret ? makeStepUp(stepUpSecret, Number(opt(env, "SECCHAT_STEPUP_TTL", "900"))) : undefined;
  // Runner-token signing (the daemon credential a cookie-session user mints): a dedicated secret,
  // else the session secret. Absent ⇒ POST /auth/runner-token is 503 (a bearer/dev daemon can still
  // attach with its own token). Longer TTL than step-up — it authorizes a work-session's runner.
  const runnerTokenSecret = env.SECCHAT_RUNNER_TOKEN_SECRET?.trim() || sessionSecret;
  const runnerToken = runnerTokenSecret ? makeRunnerToken(runnerTokenSecret, Number(opt(env, "SECCHAT_RUNNER_TOKEN_TTL", "43200"))) : undefined;
  // Master key for encrypting per-user SSH private keys at rest. A DEDICATED secret is required (it is
  // not defaulted to the session secret): SSH private keys are long-lived credentials injected into
  // runtimes, so their at-rest key is deliberately separate from the short-lived cookie signer.
  const sshSecret = env.SECCHAT_SECRET_KEY?.trim() || undefined;
  const secretKey = sshSecret ? deriveSecretKey(sshSecret) : undefined;
  const gitKnownHosts = env.SECCHAT_GIT_KNOWN_HOSTS?.trim() || undefined;
  // Kubernetes agent pool: present only when a pool image is configured (the pod's runnerd image).
  // Everything else has a sensible in-cluster default. The pool ALSO needs a runner-token minter to
  // be usable (checked at wire-up in index.ts) — a pod attaches as the owner with a minted token.
  const poolImage = env.SECCHAT_POOL_IMAGE?.trim() || undefined;
  const pool: PoolConfig | undefined = poolImage
    ? {
        apiServer: opt(env, "SECCHAT_POOL_APISERVER", "https://kubernetes.default.svc"),
        namespace: opt(env, "SECCHAT_POOL_NAMESPACE", "secchat-pool"),
        image: poolImage,
        secchatUrl: opt(env, "SECCHAT_POOL_SECCHAT_URL", `http://secchat:${Number(opt(env, "SECCHAT_PORT", "47010"))}`),
        cpuLimit: opt(env, "SECCHAT_POOL_CPU", "1"),
        memoryLimit: opt(env, "SECCHAT_POOL_MEMORY", "1Gi"),
        activeDeadlineSeconds: Number(opt(env, "SECCHAT_POOL_TTL", "3600")),
        maxPods: Number(opt(env, "SECCHAT_POOL_MAX_PODS", "20")),
        maxPerOwner: Number(opt(env, "SECCHAT_POOL_MAX_PER_OWNER", "3")),
        attachTimeoutMs: Number(opt(env, "SECCHAT_POOL_ATTACH_TIMEOUT", "120000")),
        analysisImages: parseAnalysisImages(env.SECCHAT_POOL_ANALYSIS_IMAGES),
        piExtension: env.SECCHAT_POOL_PI_EXTENSION?.trim() || undefined,
        taskImage: env.SECCHAT_POOL_TASK_IMAGE?.trim() || undefined,
        maxTasks: Number(opt(env, "SECCHAT_POOL_MAX_TASKS", "5")),
      }
    : undefined;
  // Voice calls (docs/plans/voice-calls-plan.md): mediad needs BOTH its URL and shared token to be
  // usable (a URL with no token would mean an unauthenticated control-API client — fail closed to
  // "not configured" rather than try it without auth), same "all-required-fields-present" instinct
  // as secrouterServiceTokenFromEnv above.
  const mediadUrl = env.SECCHAT_MEDIAD_URL?.trim() || undefined;
  const mediadToken = env.SECCHAT_MEDIAD_TOKEN?.trim() || undefined;
  const mediadRecordingsDir = env.SECCHAT_MEDIAD_RECORDINGS_DIR?.trim() || undefined;
  const mediad: MediadConfig | undefined =
    mediadUrl && mediadToken ? { url: mediadUrl, token: mediadToken, recordingsDir: mediadRecordingsDir } : undefined;
  return {
    host: opt(env, "SECCHAT_HOST", "127.0.0.1"),
    port: Number(opt(env, "SECCHAT_PORT", "47010")),
    oidcIssuer: issuer,
    oidcAudience,
    // Strip a trailing slash off the issuer only when composing this URL — the issuer itself is
    // kept canonical (may end with "/", e.g. Authentik) for the exact-match `iss` check, but a
    // literal `${issuer}/.well-known/…` would double the slash.
    jwksUrl: opt(env, "SECCHAT_JWKS_URL", `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`),
    secrouterUrl: opt(env, "SECROUTER_URL", "http://127.0.0.1:47002"),
    secrouterToken: env.SECROUTER_TOKEN?.trim() || undefined,
    secrouterServiceToken: secrouterServiceTokenFromEnv(env),
    assistantModel: opt(env, "SECCHAT_ASSISTANT_MODEL", "auto"),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    adminGroup,
    devMode: (env.SECCHAT_DEV_MODE?.trim() || "") === "1",
    oidcClientId: opt(env, "SECCHAT_OIDC_CLIENT_ID", oidcAudience),
    oidcClientSecret,
    publicUrl,
    sessionSecret,
    sessionTtl: Number(opt(env, "SECCHAT_SESSION_TTL", "28800")),
    ssoEnabled: Boolean(oidcClientSecret && publicUrl && sessionSecret),
    marking,
    dlp,
    capabilities,
    stepUp,
    runnerToken,
    uploadsDir: opt(env, "SECCHAT_UPLOADS_DIR", "./uploads"),
    maxUploadBytes: Number(opt(env, "SECCHAT_MAX_UPLOAD_BYTES", "26214400")), // 25 MiB
    outboundAllowedHosts: (env.SECCHAT_OUTBOUND_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
    secretKey,
    sshEnabled: Boolean(secretKey),
    gitKnownHosts,
    pool,
    transcribeUrl: env.SECCHAT_TRANSCRIBE_URL?.trim() || undefined,
    mediad,
    callStun: (env.SECCHAT_CALL_STUN ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}
