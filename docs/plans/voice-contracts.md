# Voice calls — wire contracts (v1)

Single source of truth for the pieces of `docs/plans/voice-calls-plan.md` (v3.1 — §§2.1/2.3/2.4/3.2)
that cross a language boundary the TypeScript compiler can't check for you: the WS `call_*` frames
the Flutter client speaks, secchat-mediad's (Go) control API, and SecRecorder's (Python) transcription
API. The TS-side shared shapes for the frames live in `src/types.ts` (search `CallInviteFrame` etc.)
and `src/calls/mediad-client.ts` / `src/transcribe/client.ts` — this document and those types MUST
stay in sync; if you change one, change the other in the same commit.

Conventions used throughout:
- All timestamps are ISO-8601 UTC strings (`"2026-08-11T14:03:22.104Z"`), matching every other
  timestamp in SecChat (`Message.createdAt`, `AuditEvent.at`, …).
- All ids are opaque strings (server-minted UUIDv4s unless stated otherwise).
- JSON examples show every field that would actually be present; optional fields are marked `?`.

---

## 1. WS `call_*` frames

Ride the EXISTING authenticated WS hub (one socket per browser tab, `wss://<host>/`) — no new
connection, no new auth. Every frame is a JSON text frame `{"type": "call_...", ...}`, matching the
hub's existing `{"type":"subscribe",...}` / `{"type":"typing",...}` shape (`src/ws/frame.ts` +
`src/ws/hub.ts`). **One active call per DM channel**, server-tracked (`CallState`:
`ringing → active → ended`).

### 1.1 Connection-scoped routing (read this before implementing either side)

A `sub` (principal) can have multiple live tabs/sockets. A call is bound to exactly ONE connection
per side — the connection that sent `call_invite` (caller), and the FIRST connection whose
`call_accept` the server processes (callee). This pins the audited consent decision to the tab the
human actually used, and lets `call_sdp`/`call_candidate` route unambiguously. Concretely:

- `call_invite` (outbound) is broadcast to **every** live connection for the callee's `sub` (all
  tabs ring).
- The first `call_accept` (inbound) the server receives WINS; every other connection currently
  ringing that call receives `call_taken` and should dismiss its ring screen.
- After that, `call_sdp` / `call_candidate` / `call_end` from either bound connection are relayed
  (p2p mode) or brokered against mediad (relayed mode) ONLY between/for those two bound
  connections — a frame from an unbound connection for that channel is rejected/ignored.
- If a bound connection's socket drops (tab closed, network loss), the server ends the call exactly
  as if that side sent `call_end` (`byDisconnect: true` on the frame the OTHER side receives).
- **Decline, and dismissing every rung tab, are exceptions to "bound connections only" above.** A
  ringing call's callee is NEVER bound (only the caller's inviting connection is, until/unless a
  `call_accept` wins) — so the Flutter client models "decline" as `call_end` sent from whichever
  ringing tab the human tapped "decline" on, an UNBOUND connection by construction. The server
  recognizes this by `sub` (every `call_*` frame's sending connection carries its authenticated
  `sub`) rather than requiring a bound connId that can't exist yet at this state: a `call_end` from a
  connection whose `sub` is the ringing call's callee is accepted as a decline. Symmetrically, ANY
  ringing-call end (decline, the caller cancelling, or the caller's bound connection dropping) is
  fanned out to **every live connection of BOTH parties** (not just one bound connection) — a
  `call_end`-shaped dismissal frame, `deliverToUser`'d rather than `sendToConnection`'d — so every
  tab that was ever shown a ring screen actually clears it, including the callee's non-winning tabs
  that were never bound to begin with. Without this, a decline is silently dropped (the caller rings
  until the 45s timeout) and a cancel/disconnect leaves the callee's other tabs ringing forever.

### 1.2 Frame reference

| Frame | Direction | When |
|---|---|---|
| `call_invite` | client → server | Caller starts a call |
| `call_invite` | server → callee (all tabs) | Re-broadcast of the above |
| `call_accept` | client → server | Callee answers (first tab wins) |
| `call_accept` | server → caller's bound connection | The callee accepted; mode is now fixed |
| `call_accept` | server → callee's OWN winning connection | The SAME confirmation, echoed back to the connection that just won (see the `call_accept` prose below) — the Flutter client `await`s this before proceeding |
| `call_taken` | server → EVERY live connection of the callee | A different tab already answered (§1.1) — this ALSO reaches the winning connection itself (harmless, see below) |
| `call_sdp` | client ↔ server ↔ (peer \| mediad) | SDP offer/answer exchange |
| `call_candidate` | client ↔ server ↔ peer | ICE candidate (**p2p mode only**) |
| `call_end` | client ↔ server ↔ (peer \| mediad) | Either side hangs up, a bound connection drops, or (§1.1) a ringing callee declines from an unbound tab |
| `call_end` (dismissal) | server → EVERY live connection of BOTH parties | A ringing call ended for ANY reason (§1.1) — clears every rung tab, not just the sender's peer |
| `call_missed` | server → both DM members | The ringing call's 45s timeout expired unanswered |
| `call_recording` | server → both bound connections | mediad's ACTUAL recording-writer state changed (truthful ● REC, §2.3) |
| `call_error` | server → the ONE connection whose frame was rejected | A WS-level error frame (below) — invite/accept validation, a `call_sdp` relayed against mediad failing, or a hostile-payload rejection |

#### `call_invite` (caller → server)

```json
{ "type": "call_invite", "channelId": "chan_9f2a", "wantRecording": true }
```
Server validates: `channelId` is a DM the caller is a member of; no call already active for this
channel or either participant (single-flight — reject with a WS-level error frame otherwise, see
§1.3). On success: audits `call.start`, then re-broadcasts to the callee:

```json
{ "type": "call_invite", "channelId": "chan_9f2a", "from": "alice", "wantRecording": true }
```
`from` is the caller's `sub`. Ringing auto-expires after **45s** (configurable) if no `call_accept`
arrives → server sends `call_missed` (§1.2) to both members and posts a `call_missed` line into the
DM (a normal governed chat message, not a WS frame).

#### `call_accept` (callee → server)

```json
{ "type": "call_accept", "channelId": "chan_9f2a", "consent": true }
```
`consent` is the callee's recording-consent decision (D3/D4) — **independent of** `wantRecording`;
`consent: false` always yields a p2p (unrecorded) call even if the caller asked to record. The
FIRST `call_accept` the server processes for a ringing call wins:
- Server creates the durable `calls` row (mode fixed: `consent ? "relayed" : "p2p"`), audits
  `call.consent.granted` or `call.consent.declined`, binds this connection as the callee side.
- The caller's bound connection AND the callee's own winning connection **both** get the identical
  confirmation (`src/calls/registry.ts`'s `accept()` calls `deps.send` twice — once per side — with
  the same payload):
  ```json
  { "type": "call_accept", "channelId": "chan_9f2a", "consent": true, "mode": "relayed" }
  ```
  The callee echo is **NORMATIVE, not just a convenience** — it's the only way the callee's OWN
  connection learns the server-resolved `mode`, which the callee itself cannot derive locally (see
  the recording-downgrade case below: only the server knows whether mediad was reachable). The
  Flutter client hard-depends on this: `call_controller.dart`'s `accept()` sends `call_accept` and
  then **awaits this echo** (a `Completer` with a 5s safety timeout) before advancing past
  `CallPhase.ringingInbound` — it does NOT guess `mode` from what it locally requested, precisely to
  avoid racing a mediad-down downgrade against its own WebRTC setup. A server that only echoes to the
  caller (as this section previously documented) leaves the callee's UI stuck until the 5s timeout,
  every time, on every accepted call.
- Every OTHER connection currently ringing for the callee's `sub` gets (via `deliverToUser`, not the
  bound-connection `sendToConnection` — those tabs were never bound, §1.1):
  ```json
  { "type": "call_taken", "channelId": "chan_9f2a" }
  ```
  The WINNING connection also receives this (`deliverToUser` fans to every live connection of the
  sub with no per-connection exclusion) — harmless: the client only tears a call down on `call_taken`
  while it's still contestable (not yet accept-confirmed by the `call_accept` echo above), so the
  winner ignores its own echo.

**Recording-downgrade case**: if `consent: true` but secchat-mediad is unreachable/unhealthy at
this point, the server does NOT create a relayed session — it proceeds as `mode: "p2p"` and BOTH
`call_accept` broadcasts above still carry `"mode": "p2p"`. The callee's client — which showed a
recording-consent prompt — MUST re-render its already-accepted call as "recording unavailable —
this call will NOT be recorded" (§2.3 of the plan: the downgrade is consent-relevant and must reach
the callee, not just the ● REC indicator).

#### `call_sdp` (either bound connection ↔ server ↔ peer-or-mediad)

```json
{ "type": "call_sdp", "channelId": "chan_9f2a", "sdpType": "offer", "sdp": "v=0\r\no=- ..." }
```
- **`mode: "p2p"`**: the server is a dumb relay between the two bound connections — no
  interpretation, just forwarded verbatim, size/rate-capped (§1.3).
- **`mode: "relayed"`**: the server TERMINATES this client's SDP. An `offer` from a client is
  brokered against mediad's control API (`POST /sessions/:id/legs/:legId/offer`, §2.2) — mediad's
  single-response ANSWER comes back to that SAME client as a `call_sdp` frame with
  `"sdpType": "answer"`. The client never sees mediad's URL, token, or session id. Non-trickle: the
  client is expected to gather ICE candidates to completion BEFORE sending its offer (§2.2 of the
  plan) — there is no `call_candidate` exchange in relayed mode.

#### `call_candidate` (p2p mode only)

```json
{
  "type": "call_candidate",
  "channelId": "chan_9f2a",
  "candidate": "candidate:1 1 UDP 2122252543 10.0.0.4 54321 typ host",
  "sdpMid": "0",
  "sdpMLineIndex": 0
}
```
Relayed the same way as `call_sdp` in p2p mode; NEVER sent/expected in relayed mode (mediad's
exchange is non-trickle — see §2.2). `sdpMid`/`sdpMLineIndex` may be `null` per the WebRTC spec's
own candidate-completion sentinel; forward as-is, don't coerce.

#### `call_end` (either side ↔ server ↔ the other)

```json
{ "type": "call_end", "channelId": "chan_9f2a" }
```
Server-generated on a bound-connection drop:
```json
{ "type": "call_end", "channelId": "chan_9f2a", "byDisconnect": true }
```
**Active call**: ends the live call, notifies the OTHER bound connection, stamps `endedAt` on the
durable row, audits `call.end`. For a `mode: "relayed"` call this also triggers `DELETE
/sessions/:id` against mediad (§2.3) and the §2.4 post-call pipeline (ingest → transcribe → merge →
governed transcript post) — asynchronous; the client sees the transcript arrive later as a normal
`message` broadcast in the DM, not on this frame.

**Ringing call (§1.1)**: a `call_end` from the caller's bound connection is a cancel; a `call_end`
from an UNBOUND connection whose `sub` matches the ringing call's callee is a decline (audited
`call.end` with `detail: "declined"`, and a `☎️ Call declined` line posted into the DM — a
content-free system message, same posture as the `call_missed` line below). Either way there is no
durable `calls` row yet (only created at `active`), and the dismissal fans out via `deliverToUser` to
every live connection of BOTH parties (not just one bound connection — see §1.1):
```json
{ "type": "call_end", "channelId": "chan_9f2a" }
```
(`byDisconnect: true` added the same way as the active-call case, if the caller's connection dropped
mid-ring rather than an explicit cancel/decline.)

#### `call_missed` (server → both DM members)

```json
{ "type": "call_missed", "channelId": "chan_9f2a" }
```
Live-only signal (dismiss an open ring screen immediately); the durable record is the
`call_missed` chat line + the `call.start`/no-`call.consent.*` audit gap, not this frame.

#### `call_recording` (server → both bound connections)

```json
{ "type": "call_recording", "channelId": "chan_9f2a", "recording": "on" }
```
Truthful ● REC (plan §2.3, suggested finding #7): `recording` is mediad's ACTUAL writer state
(`CallRecordingState`, `"none" | "on"`), mirrored onto the `calls` row (`Store.setCallRecording`)
the moment the backend learns it changed. Only ever sent for a `mode: "relayed"` call — a p2p call's
`recording` stays `"none"` for its whole duration (mediad is never involved) and this frame is never
sent for one. The backend isn't required to run a dedicated poll loop: piggybacking a `GET
/sessions/:id`-equivalent check on the existing `call_sdp` offer/answer broker round trip (§2.2) is
sufficient and is what the reference implementation does — a leg finishing its offer/answer exchange
is exactly when mediad's writer for that leg is next likely to have started. The client's ● REC
indicator reflects this pushed value directly; it MUST NOT be derived/guessed from `mode` alone
(mode `"relayed"` means recording was *attempted*, not that a byte has actually been written yet).

#### `call_error` (server → the ONE connection whose frame was rejected)

```json
{ "type": "call_error", "channelId": "chan_9f2a", "error": "user_busy" }
```
```json
{ "type": "call_error", "channelId": "chan_9f2a", "error": "mediad_broker_failed", "detail": "mediad session_not_found: ..." }
```
`channelId` is present whenever the rejected frame carried one (every `call_*` frame does per §1.2's
table); `detail` is optional human-readable text, included whenever the server has one, omitted
otherwise (the first example above; the second shows it present). `error` is a stable,
machine-readable code — the client's job is to render a friendly message per-code with an
"(unrecognized `error`)" fallback so the server can add new codes without a lockstep client release
(`call_controller.dart`'s `_describeCallError` does exactly this). The known codes as of this
document, by origin:

| Code | Origin | Meaning |
|---|---|---|
| `not_dm` | `call_invite` | The channel isn't a DM (D5 — calls are DM-only) |
| `not_member` | `call_invite` | The sender isn't a member of the channel |
| `invalid_dm` | `call_invite` | The DM doesn't have exactly two user members |
| `call_active` | `call_invite` | A call is already ringing/active for this channel (single-flight, non-glare case) |
| `glare_lost` | `call_invite` | Simultaneous both-sides invites — the higher-`sub` inviter loses the tiebreak (§2.1 of the plan) |
| `user_busy` | `call_invite` | Either party is already ringing/active in a DIFFERENT channel |
| `invite_failed` | `call_invite` | An unexpected internal error during invite (generic fallback — not a `CallSignalError`) |
| `not_ringing` | `call_accept` | Stale/expired/already-resolved invite — nothing ringing for this channel |
| `accept_failed` | `call_accept` | An unexpected internal error during accept (generic fallback) |
| `frame_too_large` | `call_sdp` | The SDP payload exceeds the 32 KiB cap (§1.3 below) |
| `mediad_broker_failed` | `call_sdp` (relayed mode) | Brokering the offer against mediad's control API failed (mediad down, non-2xx, etc.) — `detail` carries mediad's own error text |

A losing `call_accept` (a later tab racing an already-decided ringing call) is `call_taken`, a
DIFFERENT frame (§1.2's table) — not a `call_error`. `not_ringing` above is genuinely distinct: it
covers a `call_accept` for a channel with no live ringing call AT ALL (expired, never invited,
already ended), where `call_taken` would be misleading (nothing was "taken" — there was never
anything live to take).

### 1.3 Bounds on the p2p relay (§2.1/§4 of the plan)

In `mode: "p2p"`, `call_sdp`/`call_candidate` are a user-to-user content path the server relays
without inspecting — outside DLP/marking/chain governance by construction. Bounded, not trusted:

| Bound | Value |
|---|---|
| Per-frame size cap | 32 KiB (far below the hub's general 16 MiB frame ceiling) |
| Candidate frames per call | rate-capped (implementation detail; SDP parse-and-reserialize is noted follow-on hardening, not v1) |

A frame over the cap, or from a connection not bound to that call, is dropped (implementation may
also close the offending connection, matching the hub's existing "hostile frame" posture in
`src/ws/frame.ts`'s `FrameDecoder`).

---

## 2. secchat-mediad control API

A small Go/Pion daemon, ONE per suite deployment, reachable **only from the secchat backend** —
compose-internal network, never published to clients. Auth: a single shared bearer token
(`SECCHAT_MEDIAD_TOKEN`, matched to mediad's own `MEDIAD_TOKEN` env) on every request:

```
Authorization: Bearer <SECCHAT_MEDIAD_TOKEN>
```

There is no per-session or per-leg credential — "leg ids" below are backend-side ROUTING labels,
not auth tokens (the bearer above is the only auth on this API). Base URL: `SECCHAT_MEDIAD_URL`
(e.g. `http://mediad:47021` — the control API port; media itself is the separate UDP/TCP `:47020`
in §3). All request/response bodies are JSON (`Content-Type: application/json`) except where noted.

### 2.1 `POST /sessions` — create a session

`legId` is `"leg_caller"` / `"leg_callee"` — **fixed literal strings, NORMATIVE, not just this
example's placeholder names.** The backend does not mint random per-call leg ids: keeping them fixed
lets a post-crash reconciliation sweep (`reconcileUnclaimedSessions`, §2.4 REQUIRED #5) determine
which finalize-manifest file (`leg_caller.ogg` vs `leg_callee.ogg`) belongs to which participant
from the `calls` row's own `caller`/`callee` columns alone — no separate leg→sub mapping needs to be
persisted anywhere. mediad echoes these same strings back verbatim in every leg-scoped response
below (`GET /sessions/:id`, the finalize manifest) — it never needs to interpret them, only use them
as opaque per-leg keys.

Request:
```json
{
  "callId": "call_7e21",
  "legs": [
    { "legId": "leg_caller", "sub": "alice" },
    { "legId": "leg_callee", "sub": "bob" }
  ]
}
```
Response `201`:
```json
{ "sessionId": "sess_c9a0" }
```
mediad allocates two `PeerConnection`s (one per leg), gathers local ICE candidates for each,
opens per-leg OGG/Opus writers (not yet writing — no RTP has arrived), and establishes the
session's shared t0 (§2.3/§2.4 of the plan — the origin every leg's `startOffsetMs` below is
relative to).

### 2.2 `POST /sessions/:id/legs/:legId/offer` — per-leg SDP exchange (non-trickle)

The backend forwards ONE client's already-ICE-gathering-complete SDP OFFER; mediad returns its
OWN ICE-gathering-complete SDP ANSWER in the SAME response — no candidate trickling ever crosses
this API (§2.2 of the plan: `SetNAT1To1IPs` makes mediad's answer candidates correct up front, and
the client is expected to gather-complete before offering too).

Request:
```json
{ "sdp": "v=0\r\no=- 4611... \r\n..." }
```
Response `200`:
```json
{ "sdp": "v=0\r\no=- 8823... \r\n..." }
```
`404` if `sessionId`/`legId` is unknown. A RE-OFFER (a second `POST` to this same leg — reconnect,
ICE restart, or page reload) is **not** rejected: it returns `200` with a fresh answer, exactly like
the first offer. mediad tells the two re-offer cases apart by DTLS fingerprint (a browser mints a
new one per `RTCPeerConnection`; it's stable across a renegotiation of the SAME one):
- **Same fingerprint** (an ICE restart from the client's EXISTING `PeerConnection`): mediad
  renegotiates that SAME `PeerConnection` — `SetRemoteDescription`/`CreateAnswer`/
  `SetLocalDescription` on the PC already in place — preserving the SSRC/granule continuity the
  plan's §2.3 re-attach semantics call for.
- **Different fingerprint** (a brand-new client `PeerConnection` — page reload, fresh reconnect):
  WebRTC forbids changing DTLS identity across one PC's renegotiation, so mediad closes the stale PC
  and allocates a fresh one instead (`session/offer.go`'s `dtlsIdentityChanged` + `newPeerConnectionForLeg`)
  — the recorder's per-leg writer picks this up as a new-SSRC bridged segment (v3.1 REQUIRED #4),
  not an error.

`409 {"error": "leg_already_connected"}` is reserved for a **concurrent in-flight offer on the SAME
leg** — a second `POST` arriving while an earlier one for that leg is still being processed
(`session.ErrLegBusy`, a `TryLock` failure on the leg's own negotiation mutex) — never for "this leg
already has a connection", which is the NORMAL, expected shape of a re-offer above. Retry after the
in-flight offer resolves rather than treating this as a hard failure.

### 2.3 `GET /sessions/:id` — state

Response `200`:
```json
{
  "sessionId": "sess_c9a0",
  "legs": [
    { "legId": "leg_caller", "iceState": "connected" },
    { "legId": "leg_callee", "iceState": "connected" }
  ],
  "recording": "on"
}
```
`iceState` is Pion's `ICEConnectionState` passed through verbatim (`"new"`, `"checking"`,
`"connected"`, `"disconnected"`, `"failed"`, `"closed"`). `recording` is mediad's ACTUAL writer
state (`"none"` | `"on"`) — this is what the backend mirrors onto the `calls` row
(`Store.setCallRecording`) and broadcasts as the truthful ● REC signal; poll or let the backend
push state changes (implementation's choice — not prescribed here).

### 2.4 `DELETE /sessions/:id` — end + finalize

Response `200` — the finalize manifest:
```json
{
  "sessionId": "sess_c9a0",
  "files": [
    { "legId": "leg_caller", "path": "leg_caller.ogg", "startOffsetMs": 0, "durationMs": 742300 },
    { "legId": "leg_callee", "path": "leg_callee.ogg", "startOffsetMs": 1180, "durationMs": 741120 },
    { "path": "mixed.m4a", "startOffsetMs": 0, "durationMs": 742300 }
  ],
  "truncated": false
}
```
`path` is relative to the session's directory on the shared recordings volume (§4). Each per-leg
file's `startOffsetMs` is that leg's first-RTP-packet time relative to the SESSION's t0 (established
at `POST /sessions`, §2.1) — legs do NOT start recording at the same instant (dial jitter, one side
answering late), so this offset is REQUIRED for the backend's merge step to place transcript
segments correctly (`leg.startOffsetMs + segment.start_ms`). The mixed file's own `startOffsetMs`
is always `0` (ffmpeg's `amix` output starts at the earliest leg, padding the other). `truncated:
true` marks a session that ended via mediad crash/restart rather than a clean `DELETE` — the
backend surfaces this in the transcript header ("recording truncated — mediad restarted mid-call").

Closes both writers (flushing the last OGG page), runs the ffmpeg mix step, deletes the session's
in-memory PC state. Idempotent: a second `DELETE` on an already-ended session returns the SAME
manifest (read from disk) rather than erroring — this is what backs the backend's startup
reconciliation sweep (§2.4 REQUIRED #5) after a crash between finalize and ingest.

### 2.5 `GET /health`

Response `200` (no auth required — this is the compose healthcheck + P0 smoke target):
```json
{ "status": "ok", "activeSessions": 2, "diskFreeBytes": 48318382080 }
```
The backend also uses this pre-flight before offering a recorded call: unreachable/non-200 ⇒ the
caller is offered "call without recording" and, per §1.2 above, the callee is told recording is
unavailable even if they already granted consent.

### 2.6 Error shape

Non-2xx responses are `{"error": "<short machine-readable code>", "detail"?: "<human text>"}`,
e.g. `404 {"error": "session_not_found"}`, `409 {"error": "leg_already_connected"}`,
`401 {"error": "unauthorized"}` (missing/wrong bearer).

---

## 3. Media transport

- **Port**: a single well-known port for ALL sessions' media — **UDP `:47020`** (Pion `ICEUDPMux`)
  with **ICE-TCP fallback on the SAME port number** (Pion `SetICETCPMux`) for UDP-hostile networks.
  This is distinct from the control API port (§2, e.g. `:47021`) and from the existing `:47010`
  TCP-only publish secchat itself uses — do not conflate the three.
- **Advertised address**: `SECCHAT_MEDIAD_ADVERTISE_ADDR` (mediad's own env, set by secdeploy — NOT
  a secchat backend env) — the suite host's CROSS-HOST-reachable address, fed to Pion's
  `SetNAT1To1IPs`, applied to BOTH the UDP and TCP candidates mediad advertises. This is the #1
  containerized-Pion failure mode: mediad's in-container PC gathers unreachable container-internal
  IPs by default; without this override, every relayed call fails to connect from a second host
  even though it may spuriously appear to work loopback-to-loopback on the same machine. Get this
  wrong and P1/P2's two-host exit tests catch it immediately (calls never connect cross-host).
- **colima/Lima UDP caveat**: UDP port-forwarding through colima is historically less reliable than
  its TCP publishes — verify with an actual UDP reachability test from a second host (P0's exit
  test), not just "the container started". If it doesn't forward cleanly, an explicit
  `proto: udp` `portForwards` entry in the colima config may be required; ICE-TCP (same port
  number, above) is the documented fallback either way.

---

## 4. Shared recordings volume

A volume distinct from secchat's existing `uploads` volume (which mounts to the `secchat`
container only), mounted **rw on both** `mediad` and `secchat`:

```yaml
volumes:
  recordings: {}
services:
  mediad:
    volumes: [ "recordings:/var/lib/mediad/recordings" ]
  secchat:
    volumes: [ "recordings:/var/lib/secchat/recordings" ]
```
(Mirrors the existing `uploads:/var/lib/secchat/uploads` convention in `compose.yaml` — a NAMED
Docker volume, not a bind mount, so the two containers' mount PATHS may legitimately differ; only
the volume identity has to match.) The secchat backend learns ITS OWN mount path via
`SECCHAT_MEDIAD_RECORDINGS_DIR` (config.ts's `MediadConfig.recordingsDir`, secdeploy's
`secchat_voice_env` sets it to `/var/lib/secchat/recordings` to match the compose mount above) —
unset ⇒ the backend has a volume mounted with nothing telling it where, so a recorded call's mixed
file is never ingested as an attachment and no leg can be read for transcription even though mediad
is recording correctly. Layout, one directory per session:

```
<volume-root>/<sessionId>/
  leg_caller.ogg
  leg_callee.ogg
  mixed.m4a
  manifest.json        # the §2.4 finalize response, ALSO written to disk (not just returned)
```
`manifest.json` on disk is what makes the backend's startup-reconciliation sweep (§2.4 REQUIRED
#5) possible without a live mediad round-trip: on boot, the backend lists `calls` rows with
`endedAt` set and `recordingAttachmentId` null (`Store.listUnclaimedEndedCalls`), and for each one
whose `<volume-root>/<sessionId>/` directory still exists, re-reads `manifest.json` and resumes
ingest from there. The backend constrains every read/delete to `<volume-root>/<sessionId>/` (no
`..`-escaping a manifest-driven path) — the session id come from the `calls` row itself, not
attacker-controlled input, but treat it as untrusted anyway.

---

## 5. SecRecorder per-leg transcription

SecRecorder is **unauthenticated** — network isolation (reachable only from the secchat backend,
compose-internal / secproxy-fronted, never from clients) is the control. Base URL:
`SECCHAT_TRANSCRIBE_URL`.

### 5.1 `POST /v1/audio/transcriptions`

Multipart form (`Content-Type: multipart/form-data`), one leg's OGG/Opus file per call:

| Field | Value |
|---|---|
| `file` | the leg's audio bytes (`leg_caller.ogg` / `leg_callee.ogg` from §2.4's manifest) |
| `diarize` | `"false"` — calls need NO diarization; per-leg identity already gives exact speaker attribution (A7 of the plan). The `model`/`response_format`/`timestamp_granularities[]` fields an OpenAI-shaped client might send are accepted and IGNORED — SecRecorder always uses its one loaded model and always returns the full `verbose_json` + `words[]` shape below regardless of what's requested. |

Response `200` (`diarize=false` shape — no `speakers[]`, no per-word/per-segment `speaker`):
```json
{
  "task": "transcribe",
  "language": "en",
  "duration": 741.12,
  "text": "Hey, are you free to look at the deploy issue? ...",
  "words": [
    { "word": "Hey,", "start": 0.42, "end": 0.71 },
    { "word": "are", "start": 0.71, "end": 0.85 }
  ],
  "segments": [
    {
      "start": 0.42,
      "end": 3.10,
      "text": "Hey, are you free to look at the deploy issue?",
      "words": [
        { "word": "Hey,", "start": 0.42, "end": 0.71 },
        { "word": "are", "start": 0.71, "end": 0.85 }
      ]
    }
  ]
}
```
`words[]` is the flattened, top-level, real-per-word-timing field most clients read; `segments[]`
(each carrying its OWN `words[]`) is kept for the merge step's fallback + general compatibility.
Both `start`/`end` are seconds **relative to the LEG FILE**, not the call's session t0 — the merge
step (`transcribe/merge.ts`) re-bases with `leg.startOffsetMs` from §2.4's manifest before
interleaving the two legs chronologically.

Errors: `400 {"detail": "empty file"}` (zero-byte upload), `413` (upload exceeds
`WHISPER_MAX_UPLOAD_MB` if configured), `500 {"detail": "transcription failed: ..."}` (treat as
retryable — 5xx, per the retry/backoff queue in `transcribe/client.ts`).

### 5.2 Concurrency

`WHISPER_MAX_CONCURRENCY` (SecRecorder's own env, default `1`) serializes GPU work server-side —
the two per-leg jobs a recorded call produces are effectively sequential regardless of what the
backend's own client-side concurrency cap is set to. Budget ~2× the GPU time of a single mixed-file
pass per recorded call (§2.4 of the plan); this is the traded-off cost of per-leg attribution over
one-pass diarization. `SECCHAT_TRANSCRIBE_MODE=mixed` (backend config, not a SecRecorder env) is
the documented fallback if this throughput cost ever forces it — ONE transcription pass over the
ffmpeg-mixed file with `diarize=true` instead, yielding generic `Speaker 1`/`Speaker 2` labels
instead of real usernames. Not implemented in v1's scaffold; noted for completeness.

### 5.3 `GET /health` (pre-existing SecRecorder route, unchanged)

```json
{ "status": "ok", "backend": "mlx-whisper", "model": "large-v3", "max_concurrency": 1,
  "in_flight": 0, "loaded": true, "diarize_enabled": true }
```
Useful as a pre-flight before enqueuing per-leg jobs, same spirit as mediad's `/health` in §2.5 —
not required for v1's minimum viable pipeline (a down SecRecorder is otherwise handled by the
retry/backoff queue + the "transcription pending" visible-failure line, §2.4 of the plan).

---

## 6. `GET /me` — STUN configuration (finding #4)

Not a `call_*` frame, but the other TS↔Dart boundary voice calls need: the existing authenticated
`GET /me` response (`src/http/server.ts`) gains one field, the natural fit per A3/§2.5 of the plan
(mirrors how the deployment's marking policy already rides this same response):

```json
{
  "sub": "alice",
  "...": "... every other GET /me field, unchanged ...",
  "callStunUrls": ["stun:stun.example.internal:3478"]
}
```
`callStunUrls` is `SECCHAT_CALL_STUN` (config.ts's `Config.callStun`) verbatim, split on commas —
empty array (not omitted) when unconfigured, so the client can tell "no STUN configured" apart from
"the server predates this field" (`models.dart`'s `Principal.callStunUrls` defaults to `[]` either
way, so the distinction doesn't currently matter client-side, but the server sends `[]` rather than
omitting the key regardless). The client (`ChatScreen`) threads this into
`WebrtcCallController`/`MediaSession`'s `stunUrls` constructor parameter at signaling-controller
construction time — see `app/lib/calls/media_session.dart`'s `MediaSession.stunUrls` doc comment.
Relayed (recorded) calls never need this — mediad is a fixed host:port (§2.2 of the plan); only p2p
ICE gathering uses it.
