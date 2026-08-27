# Using SecChat

A tour of the app from a user's (and an admin's) seat. See [security.md](security.md) for how
each of these is actually enforced, and [configuration.md](configuration.md) for the env vars that
turn optional pieces on.

## Channels & DMs

- **Channels** (`POST /channels`) are named, joinable spaces; **DMs** (`POST /dm`) are 1:1, and a
  **self-DM** (`POST /self-dm`) is your own private space (also where solo voice memos live — see
  below). Membership is roster-managed (add/remove/role) by a channel owner.
- Messages support **threads** (reply-to-message), **emoji reactions**, **pinning**, **edit** (a
  chain-safe revision history — the original is never lost, only superseded), and **redaction** (a
  governed, audited purge: content is removed, the hash chain still verifies).
- **@mentions** resolve against the channel's own members (you can't be mentioned into a channel
  you can't read) and land in your durable mention inbox (`GET /mentions`).
- **Search** (`GET /search`) is permission-aware: every channel a query might touch is
  membership-checked before its messages are ever read.
- **Attachments** upload once and attach on post; a marked message's attachment inherits the same
  classification banner.

## Classification marking & DLP

Every message carries an effective classification level (a channel can pin one for all its
messages, or leave it per-message in an unmarked channel/DM), rendered as a banner and enforced
server-side — you cannot post content marked higher than its channel's ceiling. Inline `(CUI)` /
`(U)` portion tokens in a message body fold up into that message's overall marking automatically.
Every post is also scanned by the local DLP scanner (regex rules, `flag` by default — post +
audit + live alert; `block` refuses it outright) — this applies identically to a human's message
and to an assistant/agent's own output, closing the historical "LLM output bypasses governance"
gap. See [security.md](security.md#marking--dlp) for the model.

## Agents

- **Assistant agent** — a governed model chat; every call is delegated to SecRouter, attributed
  and budgeted to you (never to a bare service identity).
- **Coding agent** — spawn one with an execute-gate mode (`none` / `plan` / `once` / `continual`):
  it can always read, but a mutating tool call needs your explicit grant. Pick where it *runs*
  (`GET /runner/environments`):
  - **My desktop app** — the bundled runner daemon on your machine attaches out to SecChat
    (see [runner-daemon.md](runner-daemon.md)); available only while it's connected.
  - **Online pool** *(optional)* — a server-launched, ephemeral Kubernetes pod runs it instead
    (see [agent-pool.md](agent-pool.md)); available only when the deployment configures a pool.
- Per-user **git SSH keys** *(optional)* let a coding agent's `git` operations authenticate as you
  against the enclave git host without a shared secret — see [git-ssh-keys.md](git-ssh-keys.md).

## Voice & video calls

Calls ride the same authenticated WebSocket hub as the rest of chat (`src/calls/registry.ts`):

- **1:1 calls** — ring/accept/decline/hang-up from a DM, with an optional recording-consent
  prompt (the callee must agree; declining still lets the call proceed, unrecorded).
- **Group calls** — N-party, no ringing (like joining a room): everyone who joins goes straight to
  the active call.
- **Solo voice memos** — record yourself into a self-DM (no other party); this always requires a
  recorded (mediad) session — there is no p2p fallback for a memo, since a memo with nothing
  server-side records nothing. Optionally enroll a voiceprint from the memo's own audio.
- **Recording** is server-side, via `secchat-mediad` (a small Go/Pion SFU), and only for calls
  where recording was actually consented to — an unrecorded call is pure peer-to-peer and mediad
  never sees it.
- **Camera + screen share** work live during a video call; recordings stay **audio-only**
  regardless — mediad has no video writer, so a recorded file never contains a video frame even if
  the call itself was on camera or sharing a screen.
- **Transcription + summary.** A recorded call's per-leg audio is transcribed (via SecRecorder)
  and merged into one speaker-exact transcript, posted to the channel/DM with the mixed audio
  attached; a best-effort LLM summary follows. Any member of that channel can submit a
  **correction** on a system-authored summary/transcript message — it's recorded as a normal,
  chain-bound revision (not yet fed back into speaker re-enrollment).

Enabling this in a deployment is covered by
[SecDeploy's `docs/voice.md`](https://github.com/secrouter/secdeploy/blob/main/docs/voice.md), not
here — it's off by default.

## Admin console

`/admin`, gated to `SECCHAT_ADMIN_GROUP` (default `secchat-admins`):

- **Overview** — both hash-chain verdicts at a glance, summary counts, and a **Governance & CUI
  controls** panel (marking ladder, DLP mode/rule count, capability gating) an assessor can read
  directly.
- **Channels / Agents / Sessions** tables — what exists and who owns it.
- **Agent pool** panel — live pool sessions + the configured admission limits, when the pool is on.
- **Git SSH keys** panel — the roster of issued keys (fingerprints only) and a revoke action.
- **Audit trail** — the audit log, browsable in the console.

Two admin-gated API endpoints back deeper verification and evidence export (no dedicated UI button
yet — call them directly, e.g. with `curl -H "Authorization: Bearer <admin token>"`):

- `GET /admin/api/audit/verify` — recomputes both hash chains end-to-end and reports the exact
  channel/seq where a chain would break, if any.
- `GET /admin/api/evidence` — a downloadable CMMC evidence bundle: sanitized config posture (rule
  *names*/levels only, never secrets or DLP patterns), the chain-verify result, the last 200 audit
  events, and a live control self-assessment. See
  [compliance/cmmc-control-matrix.md](compliance/cmmc-control-matrix.md).

## Webhooks

- **Inbound** (`POST/GET/DELETE /channels/:id/webhooks`) — a per-channel token posts into that
  channel at `POST /hooks/:token`.
- **Outbound** (`POST/GET/DELETE /channels/:id/outbound-webhooks`, plus a `/test` trigger) —
  SecChat POSTs a signed JSON payload to an external URL on a subscribed event; a subscription
  opts in to including message content, and creation is optionally host-allowlisted
  (`SECCHAT_OUTBOUND_ALLOWED_HOSTS`).

## Per-user git SSH keys

Covered in full in [git-ssh-keys.md](git-ssh-keys.md): generate/regenerate/revoke your own key from
the app's top-bar key icon (`/me/ssh-key`), add the public key to the enclave git host, then any
coding agent you run authenticates as you.
