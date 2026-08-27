# Changelog

Grouped by feature area (see `git log --oneline` for the full commit-level history). This rebuild
has not yet cut a version tag (`package.json` stays at `0.0.0`); everything below is the
[Unreleased] rebuild that replaced the former Mattermost-based `secchat` stack.

## [Unreleased]

### Foundation
- **Walking skeleton → durable stack.** Store/auth/http/ws wired end-to-end on Node's standard
  library (no framework), then a real `PgStore` for durable Postgres persistence, packaged as a
  two-container Docker Compose stack (`bootstrap/secchat.sh`) alongside a dependency-free Flutter
  client (web, then desktop).
- **Real SecSSO login** — OIDC BFF (Authorization Code + PKCE) issuing an httpOnly session cookie,
  RP-initiated logout, and native desktop SSO via a loopback redirect.
- **Governed assistant path** — model chat delegated to SecRouter, attributed and budgeted to the
  acting user (`X-Sec-Acting-User`), retiring the LibreChat-based predecessor's separate model-chat
  surface.

### Chat
- Channels, DMs, and a self-DM; membership management (roster, add/remove/role); message pinning,
  per-channel drafts, presence + typing indicators, cursor-paginated history, unread badges, and
  full-text search (permission-checked per channel before any message is read).
- Threads (reply-to-message), emoji reactions, `@mentions` (resolved against channel members,
  delivered to a durable per-user inbox), a trackable message-edit revision history, and governed
  message **redaction** (an audited content purge that the hash chain still verifies across).
- Attachment compose/upload/download, marking-aware and size-capped, with content-addressed
  storage and a durability/purge pass (Wave 0 governance hardening).
- Outbound webhooks (SecChat → external URL on a subscribed event, content-inclusion opt-in,
  destination host-allowlisted) alongside the existing inbound webhook tokens.

### Classification marking & DLP
- A configurable marking ladder (deployment profiles: `dod-cui` / `dod-classified` / `commercial`),
  channel-as-portion enforcement, inline `(CUI)`/`(U)` portion-token folding, optional CUI
  categories (unranked caveats), and a clipboard marking-propagation guard against paste-driven
  spillage.
- Local, on-premise DLP scanning on every post (`off`/`flag`/`block`), extended to machine-authored
  (assistant/agent) output via a dedicated governed-append path so model output can no longer
  bypass marking or DLP.
- Privileged-capability policy (`message.redact`, `marking.downgrade`, `webhook.create`,
  `agent.manage`), each independently group-gated and step-up-gated; step-up itself upgraded to a
  genuine fresh OIDC re-authentication (`prompt=login`).

### Audit & admin console
- Two independent SHA-256 hash chains (message + metadata-only audit), both recomputable on demand.
- An assessor-legible admin console (`/admin`, group-gated): overview + both chain verdicts,
  Governance & CUI controls panel, channels/agents/sessions tables, and — as later features
  landed — an agent-pool panel, a git-SSH-key roster (with revoke), and a browsable audit trail.
- Detailed, per-channel chain verification (`GET /admin/api/audit/verify`) and a downloadable CMMC
  evidence bundle (`GET /admin/api/evidence`: sanitized config posture, chain-verify result, recent
  audit events, live control self-assessment) — see
  [docs/compliance/cmmc-control-matrix.md](docs/compliance/cmmc-control-matrix.md).

### Coding agents & the runner daemon
- A 4-mode execute-gate (`none`/`plan`/`once`/`continual`) with owner-only grant/revoke, live
  model/reasoning-change mid-session, and a thinking-indicator UI.
- The remote-runner bridge and standalone **runner daemon** (`secchat-runnerd`): attaches out to
  SecChat from any machine (desktop-bundled or standalone server/container), relays tool requests
  while the execute-gate stays entirely server-side, and diagnoses attach failures instead of
  looping silently. See [docs/runner-daemon.md](docs/runner-daemon.md).
- Per-user git SSH identities (ed25519, AES-256-GCM at rest under a dedicated master key) injected
  into a coding agent's runtime so `git` authenticates as its owner. See
  [docs/git-ssh-keys.md](docs/git-ssh-keys.md).

### Kubernetes agent pool
- An optional per-session, ephemeral Kubernetes pod launch environment for coding agents
  (`SECCHAT_POOL_IMAGE`), reusing the same runnerd image and execute-gate as the desktop path, with
  admission caps, orphan reconciliation, and live status.
- On-demand analysis sidecars sharing the pod's `/workspace` via a file work-queue, a one-shot
  task API for batch `secagent` jobs (MR review, docs, analysis), and a default-off, opt-in
  per-agent internet-egress toggle. See [docs/agent-pool.md](docs/agent-pool.md).

### Voice & video calling
- **1:1 calls** with caller-opt-in, callee-consent server-side recording via a new relay service,
  **`secchat-mediad`** (Go/Pion) — an unrecorded call stays pure peer-to-peer.
- **Solo voice memos** (self-DM record-yourself, always server-recorded) with opt-in voiceprint
  enrollment, then **N-party group calls** on the same mediad SFU with server-initiated
  renegotiation as participants join/leave.
- Post-call pipeline: per-leg transcription via SecRecorder merged into a speaker-exact transcript,
  a best-effort LLM call summary, and a "Correct transcript" affordance letting any channel member
  amend a system-authored summary/transcript as a normal chain-bound revision.
- **Video**: camera + screen share, with mediad forwarding VP8 as a genuine SFU (fan-out, PLI
  reverse-routing) — live-only, since mediad has no video writer, so recordings stay audio-only
  regardless of what was on screen.
- A full-screen call view (participant grid, live mic meter, bottom tabs, "Call Ended" screen).

### Mobile & desktop UI
- A single-pane responsive layout below 720pt, followed by a full mobile-UI review pass
  (keyboard-safe dialogs, touch targets, table scroll).
- A light/dark theme toggle (top-bar menu), remembered across launches.

### Governance hardening
- Wave 0: classification propagation across every write path, attachment blob durability + purge,
  WebSocket message reassembly hardening, and DLP scanning extended to agent output — the pass that
  closed the "machine output skips governance" gap referenced above.
