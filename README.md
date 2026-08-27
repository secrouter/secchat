# SecChat

Auditable **team chat + agentic chat** for CUI / air-gapped enclaves — one app where people talk
to each other, spawn governed coding/assistant agents, hold voice and video calls, and every
message is tamper-evidently logged. Part of the [SecRouter suite](https://github.com/secrouter/secdeploy#the-suite).

> **Status: this rebuild is the canonical SecChat** — it is the default branch (`main`).
> [SecDeploy](https://github.com/secrouter/secdeploy) ships it as the `secchat` component,
> replacing the former Mattermost-based chat stack. See [`docs/`](docs/index.md) for the design.

## Why it exists

- **Auditable by construction** — every message links into a per-channel SHA‑256 hash chain
  bound to the content *hash* (not the plaintext), plus a metadata-only audit chain. Tampering
  is detectable; CUI spillage is still purgeable (redaction removes plaintext, the chain
  stays verifiable).
- **Agents are first-class + governed** — spawn a [SecAgent](https://github.com/secrouter/secagent)
  tied to you; it runs in *plan mode* by default, and only *you* can authorize code-executing
  work. Its model calls go through [SecRouter](https://github.com/secrouter/secrouter),
  attributed and budgeted to you.
- **SSO from the ground up** — every session is a [SecSSO](https://github.com/secrouter/secsso)
  (Authentik) session, validated via JWKS. No local passwords.
- **Light/dark theme** — a top-bar toggle switches the whole app between palettes; the choice is
  remembered across launches.

## Voice & video calling

Calls are native to the app, not a bolted-on plugin: 1:1 calls, N-party group calls, and solo
voice memos (record yourself into a self-DM) all ride the same WebRTC signaling over the
existing chat WebSocket hub (`src/calls/registry.ts`).

- **Server-side recording via `secchat-mediad`** — a small Go/Pion SFU (`mediad/`) that
  forwards and, for *consented* calls only, records media server-side. An unrecorded call stays
  pure peer-to-peer; mediad never sees it. Group calls fan out through the same SFU.
- **Camera + screen share** work live during a video call, but recordings stay **audio-only**:
  mediad has no video writer, so a recorded call's file never contains a video frame regardless
  of what was on screen during the live call.
- **Recording → transcription → transcript.** A recorded call's per-leg audio is transcribed via
  SecRecorder and merged into one speaker-exact transcript — attribution comes from the leg
  itself for 1:1/group calls, or diarization plus opt-in voiceprint enrollment for a solo memo —
  then posted to the channel/DM with the mixed audio attached.
- **Summaries + corrections.** A best-effort LLM summary is posted after a recorded call; any
  member of the channel can submit a correction on that system-authored summary or transcript,
  recorded as a normal, chain-bound message revision.
- **Deploying** the `secchat-mediad` service and re-enabling SecRecorder is a
  [SecDeploy](https://github.com/secrouter/secdeploy) concern, not this repo's — see its
  [`docs/voice.md`](https://github.com/secrouter/secdeploy/blob/main/docs/voice.md) for the
  compose wiring, ports, and STUN/ICE guidance. Design rationale lives in
  [`docs/plans/voice-calls-plan.md`](docs/plans/voice-calls-plan.md).

## Dependency policy (read before adding anything)

This is a supply-chain-conscious, CMMC/air-gap component. Dependencies are a **liability**, not
a convenience:

- **Runtime dependencies: `jose` only** (JWKS/JWT — security-focused, zero transitive deps),
  pinned to an exact version. WebSockets are implemented on the Node **standard library**.
  Postgres (`pg`) will be added — pinned, with its transitive tree vetted — when the data layer
  moves off the in-memory store; until then there is no `pg` import.
- **No web frameworks, no bundlers, no "utility" micro-packages.** Node 24 LTS + TypeScript
  (native type-stripping — no build step for dev) covers it.
- **Exact version pins, no floating ranges.** A committed lockfile is the source of truth.
- Adding *any* new package requires an explicit review of the package, its maintainer, and its
  entire transitive tree. When in doubt, use the standard library or write the ~100 lines.

## Toolchain

- **Node 24 LTS** (`engines: >=24`). TypeScript runs natively via Node's type-stripping — no
  compile step to run or test.
- `npm test` → `node --test` (the built-in runner; test files are `test/*.test.ts`).
- `npm run typecheck` → `tsc --noEmit`.

## Layout

```
src/
  types.ts        shared contracts (Principal, Store, Channel, Message, AuditEvent, …)
  config.ts       env-driven config (fails closed on missing secrets)
  audit/chain.ts  the tamper-evident hash chains (message + audit)
  store/          persistence behind the Store interface (memory now, Postgres later)
  auth/           SecSSO (Authentik) JWKS token verification
  http/           bare-Node HTTP server + routes
  ws/             stdlib WebSocket hub (realtime) + runner-daemon attach hub
  agent/          coding-agent control plane + execute-gate + runner ports (server / remote / K8s pool)
  ssh/            per-user git SSH identities (ed25519 + AES-256-GCM at rest; see docs/git-ssh-keys.md)
  daemon/         the runner daemon: attaches to SecChat, runs pi (see docs/runner-daemon.md)
test/             node:test suites, one per module
db/migrations/    SQL schema (applied by the Postgres store when it lands)
```

The **runner daemon** runs coding agents on a machine of your choosing (bundled in the desktop app,
or standalone on a server/container) and attaches out to SecChat, while the execute-gate stays on the
server — see [docs/runner-daemon.md](docs/runner-daemon.md). Package it with `npm run bundle:runnerd`
(desktop bundle) or `Dockerfile.runnerd` (container).

**Per-user git SSH keys** (optional) give each user a server-managed ed25519 identity that SecChat
injects into their coding-agent runtimes so `git` authenticates as them — the private key is held
AES-256-GCM-encrypted at rest and never leaves the server. Set `SECCHAT_SECRET_KEY` to enable it;
see [docs/git-ssh-keys.md](docs/git-ssh-keys.md).

**Kubernetes agent pool** (optional) runs a coding agent in a server-launched, ephemeral pod (the
runnerd image) instead of the user's desktop — the pod attaches back over `/runner` and the
execute-gate is unchanged. Set `SECCHAT_POOL_IMAGE` to enable it; see
[docs/agent-pool.md](docs/agent-pool.md).

## Deploy (Docker Compose stack)

SecChat packages as a two-container Compose stack — the app plus its own Postgres — for the
SecRouter suite's orchestrator (SecDeploy). `bootstrap/secchat.sh` is the control helper;
SecDeploy drives the same verbs it exposes standalone. (SecChat is the canonical `secchat`
component in SecDeploy, replacing the former Mattermost-based chat stack. Its SecSSO OIDC
client id stays `secchatng` — the retained Authentik client from this rebuild's transitional
phase — so users only ever see "SecChat".)

```bash
cp .env.example .env
# set SECCHAT_OIDC_ISSUER / SECCHAT_OIDC_AUDIENCE (SecSSO) and PG_PASSWORD; $EDITOR .env
./bootstrap/secchat.sh up          # build + start, wait for /healthz, print the wiring readout
```

```
./bootstrap/secchat.sh up             build + start, wait, print the SSO/gateway wiring
./bootstrap/secchat.sh status         compose ps
./bootstrap/secchat.sh wiring         reprint the SecSSO + SecRouter wiring readout
./bootstrap/secchat.sh backup <dir>   pg_dump + .env → <dir>
./bootstrap/secchat.sh restore <dir>  reinitialize the stack from <dir> (REPLACES state)
./bootstrap/secchat.sh logs [svc]     follow logs (secchat | postgres)
./bootstrap/secchat.sh down [-v]      stop (-v also wipes volumes/state)
```

**State lives in two places** — rows, chains, and the audit log in **Postgres** (see
`db/migrations/`; migrations are applied automatically on boot), and attachment **bytes** on the
`uploads` volume (content-addressed blobs under `SECCHAT_UPLOADS_DIR`). `backup` captures both —
the `pg_dump`, the `.env` needed to reconstruct `DATABASE_URL`, and the blobs — and `restore`
reinstates both from clean volumes. A backup without the blobs would restore chain-bound
attachment manifests attesting to files that no longer exist.

**Web client**: the image serves `clients/web-minimal` (dependency-free, always present in the
repo). It does **not** build the Flutter client (`app/`) — that toolchain doesn't belong in
this lean runtime image. `Dockerfile` has a commented block showing how to add a Flutter-web
build stage later; `src/index.ts` already prefers `app/build/web` over the minimal client
whenever that build is present, so no server code change is needed when that lands.

## Documentation

Start at [`docs/index.md`](docs/index.md) — the full env-var reference
([`docs/configuration.md`](docs/configuration.md)), a user-facing tour
([`docs/usage.md`](docs/usage.md)), the auth/marking/audit security model
([`docs/security.md`](docs/security.md)), and the CMMC control mapping
([`docs/compliance/cmmc-control-matrix.md`](docs/compliance/cmmc-control-matrix.md)) all link from
there. See [`CHANGELOG.md`](CHANGELOG.md) for what shipped when.

## License

[Apache 2.0](LICENSE) — Copyright 2026 Austin Probe.
