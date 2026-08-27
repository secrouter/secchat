# Configuration (environment variables)

SecChat's server config is env-driven and built once at startup by `loadConfig()`
(`src/config.ts`) — a missing **required** value throws immediately (fails closed rather than
booting silently insecure); every optional feature below is present only when its *entire* env
group is set, never partially.

This page covers the **server process's own** environment. Two other processes have their own,
separate env surfaces, documented where they live rather than duplicated here:

- The **runner daemon** (a separate process users run on their own machine/server/container to
  host coding agents) — see [runner-daemon.md](runner-daemon.md) for its `SECCHAT_URL` /
  `SECCHAT_RUNNER_TOKEN` / `SECCHAT_RUNNER_STUB` / `SECCHAT_RUNNER_HEARTBEAT_MS` /
  `SECCHAT_RUNNER_RECONNECT_MS` / `SECCHAT_RUNNER_RECONNECT_MAX_MS` / `PI_BIN` variables.
- A **Kubernetes agent-pool pod**'s environment (`SECCHAT_URL`, a minted `SECCHAT_RUNNER_TOKEN`,
  `SECCHAT_POOL_SESSION`, `PI_BASE_URL`, `PI_API_KEY`, `SECAGENT_PI_EXTENSION`, …) is *computed and
  injected by the server itself* (`src/agent/pool-runner.ts`, `src/agent/pool-tasks.ts`) — these
  are outputs of the pool config below, not variables a deployer sets directly.

## Core / required

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_OIDC_ISSUER` | *(required)* | SecSSO (Authentik) OIDC issuer. Its JWKS is the only trust root for bearer tokens; kept exactly as configured, trailing slash included (Authentik's `iss` is exact-match). |
| `SECCHAT_OIDC_AUDIENCE` | *(required)* | Expected token audience (SecChat's OIDC client id). Tokens for any other audience are rejected. |
| `SECCHAT_JWKS_URL` | `${issuer}/.well-known/jwks.json` | JWKS endpoint, derived from the issuer when unset. |
| `SECCHAT_HOST` | `127.0.0.1` | HTTP listen host. |
| `SECCHAT_PORT` | `47010` | HTTP listen port. |
| `DATABASE_URL` | *(unset ⇒ in-memory store)* | Postgres DSN for the durable `PgStore`. Unset is dev/test only — state doesn't survive a restart. |
| `SECCHAT_ADMIN_GROUP` | `secchat-admins` | SecSSO group whose members may read the admin / audit-review console (`/admin*`). |
| `SECCHAT_DEV_MODE` | `0` | `1` accepts synthetic `dev.<sub>.<groups>` tokens (no real login) and serves `/admin` without SecSSO. **Dev only — never enable in production.** |

## SecRouter (assistant + coding-agent model calls)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECROUTER_URL` | `http://127.0.0.1:47002` | SecRouter gateway base URL. Every assistant/coding-agent model call is delegated here — SecChat never calls a model endpoint directly. |
| `SECROUTER_TOKEN` | *(unset)* | Static bearer SecChat presents to SecRouter. Superseded by the client-credentials vars below when they're set. |
| `SECCHAT_SECROUTER_TOKEN_URL` / `_CLIENT_ID` / `_CLIENT_SECRET` | *(unset)* | OIDC client-credentials service identity for SecRouter's secure mode — all three required together. When set, SecChat fetches a fresh OIDC access token per call instead of the static `SECROUTER_TOKEN`. |
| `SECCHAT_SECROUTER_SCOPE` | `secrouter` | OAuth scope requested with the client-credentials grant above. |
| `SECCHAT_ASSISTANT_MODEL` | `auto` | Default model for an assistant agent created without an explicit one. `auto` lets SecRouter classify + route; set a concrete model id if your SecRouter `auto` tiers reference models the local deployment hasn't loaded. |

## SSO login (OIDC BFF)

Fully optional — the bearer-JWT path above (and dev tokens) work with none of this set. When set,
the backend runs the Authorization Code + PKCE dance itself and issues an httpOnly session cookie;
no OIDC token ever reaches the browser (see [security.md](security.md)).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_OIDC_CLIENT_ID` | `SECCHAT_OIDC_AUDIENCE` | OIDC client id for the login flow (usually the same client as the bearer-JWT audience check). |
| `SECCHAT_OIDC_CLIENT_SECRET` | *(unset ⇒ SSO login off)* | Confidential-client secret for the BFF's server-side token exchange. |
| `SECCHAT_PUBLIC_URL` | *(unset ⇒ SSO login off)* | External base URL this app is reachable at (e.g. `https://secchat.sec.internal`). Builds the OIDC `redirect_uri` and decides the session cookie's `Secure` flag. |
| `SECCHAT_SESSION_SECRET` | *(unset ⇒ SSO login off)* | HS256 signing key for the SecChat-minted session cookie. Never falls back to an unsigned or guessable key. |
| `SECCHAT_SESSION_TTL` | `28800` (8h) | Session cookie TTL, seconds. |

`ssoEnabled` is true only once all three of `SECCHAT_OIDC_CLIENT_SECRET` / `SECCHAT_PUBLIC_URL` /
`SECCHAT_SESSION_SECRET` are set; `GET /auth/status` reports this so the client knows which login
UI to show.

## Classification marking

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_MARKING_PROFILE` | `dod-cui` | Deployment posture preset (`dod-cui` \| `dod-classified` \| `commercial`) — presets the level ladder + baseline. Ignored when `SECCHAT_MARKING_LEVELS` is set. |
| `SECCHAT_MARKING_LEVELS` | *(unset ⇒ profile's ladder)* | Comma-separated, low→high custom ladder that fully overrides the profile (e.g. `UNCLASSIFIED,PROPRIETARY,CUI,CLASSIFIED`, the `dod-cui` default). |
| `SECCHAT_MARKING_DEFAULT` | profile's baseline (lowest rung) | Default marking level. Always fail-safe — never defaults upward. |
| `SECCHAT_MARKING_CATEGORIES` | profile's starter set (JSON) | JSON override of the CUI category (caveat) vocabulary. A category for a level absent from the ladder is dropped. Verify the exact codes against your agency's ISOO CUI Registry entry — the built-in set is a reasonable starting point, not authoritative. |

## Local DLP

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_DLP_MODE` | `flag` | `off` \| `flag` (post + audit + live alert) \| `block` (refuse the post, HTTP 422). Applies to every human post AND every machine-authored (assistant/agent) append. |
| `SECCHAT_DLP_RULES` | built-in defaults (`us-ssn`, `credit-card`, `control-marking`) | JSON override of the rule set (`[{name, pattern}]`). A malformed rule throws at startup. |

## Privileged capabilities + step-up

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_CAP_REDACT_GROUP` | `SECCHAT_ADMIN_GROUP` | IdP group required for `message.redact`. |
| `SECCHAT_CAP_REDACT_STEPUP` | `0` (off) | Step-up freshness window (seconds) required for `message.redact`. |
| `SECCHAT_CAP_AGENT_GROUP` | `""` (ungated) | IdP group required for `agent.manage`. |
| `SECCHAT_CAP_AGENT_STEPUP` | `0` (off) | Step-up window for `agent.manage`. |
| `SECCHAT_CAP_DOWNGRADE_GROUP` | `SECCHAT_ADMIN_GROUP` | IdP group required for `marking.downgrade`. |
| `SECCHAT_CAP_DOWNGRADE_STEPUP` | `0` (off) | Step-up window for `marking.downgrade`. |
| `SECCHAT_CAP_WEBHOOK_GROUP` | `SECCHAT_ADMIN_GROUP` | IdP group required for `webhook.create`. |
| `SECCHAT_CAP_WEBHOOK_STEPUP` | `0` (off) | Step-up window for `webhook.create`. |
| `SECCHAT_STEPUP_SECRET` | `SECCHAT_SESSION_SECRET` | Dedicated signing secret for step-up proofs (`POST /auth/stepup`). Absent (and no session secret either) ⇒ step-up unavailable, so any capability requiring it fails closed. |
| `SECCHAT_STEPUP_TTL` | `900` (15m) | Step-up token max lifetime, seconds (bounds usability; the capability's own `_STEPUP` window governs freshness within that). |
| `SECCHAT_RUNNER_TOKEN_SECRET` | `SECCHAT_SESSION_SECRET` | Signing secret for runner tokens minted at `POST /auth/runner-token`. Absent (and no session secret) ⇒ that route 503s. |
| `SECCHAT_RUNNER_TOKEN_TTL` | `43200` (12h) | Runner token TTL, seconds. |

## Attachments + outbound webhooks

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_UPLOADS_DIR` | `./uploads` | Directory for content-addressed attachment bytes. |
| `SECCHAT_MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | Max attachment upload size. |
| `SECCHAT_OUTBOUND_ALLOWED_HOSTS` | *(empty ⇒ any http(s) host allowed)* | Comma-separated hostname allowlist for outbound webhook destinations, enforced when a webhook is created. |

## Per-user git SSH keys (optional)

See [git-ssh-keys.md](git-ssh-keys.md) for the full model.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_SECRET_KEY` | *(unset ⇒ feature off)* | Master secret (folded to 256 bits via SHA-256) that AES-256-GCM-encrypts per-user SSH private keys at rest. Required, dedicated — never falls back to the session secret. |
| `SECCHAT_GIT_KNOWN_HOSTS` | *(unset)* | Pinned `known_hosts` content injected into runners. Unset ⇒ `StrictHostKeyChecking=accept-new` (trust-on-first-use). |

## Kubernetes agent pool (optional)

See [agent-pool.md](agent-pool.md) for the full table (`SECCHAT_POOL_IMAGE`, `_NAMESPACE`,
`_APISERVER`, `_SECCHAT_URL`, `_CPU`, `_MEMORY`, `_TTL`, `_MAX_PODS`, `_MAX_PER_OWNER`,
`_ATTACH_TIMEOUT`, `_ANALYSIS_IMAGES`, `_PI_EXTENSION`, `_TASK_IMAGE`, `_MAX_TASKS`) — the pool is
off unless `SECCHAT_POOL_IMAGE` is set.

## Voice & video calls (optional)

Every var below is unset by default — voice calling stays off exactly like the pool above. See the
[README](../README.md#voice--video-calling) for the feature and
[SecDeploy's `docs/voice.md`](https://github.com/secrouter/secdeploy/blob/main/docs/voice.md) for
how a deploy wires the `secchat-mediad` service and SecRecorder together.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_MEDIAD_URL` | *(unset)* | `secchat-mediad`'s control-API base URL. Requires `SECCHAT_MEDIAD_TOKEN` too — either alone leaves recording/relay unconfigured. |
| `SECCHAT_MEDIAD_TOKEN` | *(unset)* | Shared bearer for mediad's control API. |
| `SECCHAT_MEDIAD_RECORDINGS_DIR` | *(unset)* | The shared recordings volume directory this backend process can read/write (distinct from `SECCHAT_UPLOADS_DIR`). Without it, a relayed call is still recorded by mediad, but the file is never claimed as an attachment and no leg is transcribed. |
| `SECCHAT_TRANSCRIBE_URL` | *(unset ⇒ no transcript)* | SecRecorder's base URL for per-leg call transcription. A recorded call's audio still gets posted without one. |
| `SECCHAT_CALL_STUN` | *(empty)* | Comma-separated `stun:host:port` URLs offered to clients for **unrecorded (p2p)** call ICE gathering. Relayed/recorded calls never need STUN (mediad is a fixed host:port). Deliberately has no public-STUN default — see `docs/voice.md` for why. |

## In-process coding-agent runner

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_PI_RUNNER` | `0` | `1` forces the server to use `pi` as its in-process coding-agent runner even if it isn't found on `PATH` yet. Unset ⇒ the server auto-detects `pi` on `PATH` (via `PI_BIN`) and falls back to an interactive demo stub if it isn't found. |
| `PI_BIN` | `pi` | Path to the `pi` CLI when it isn't on `PATH`. Shared with the runner daemon's own env (see [runner-daemon.md](runner-daemon.md)) — this entry is the **server** process's own copy, used only when it runs `pi` in-process. |
