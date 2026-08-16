# SecChat Voice: 1:1 Calls with Recording + SecRecorder Transcription — Implementation Plan

Status: **v3.1 — D2 amended to server-side recording (§10) + the v3-delta architect review folded in (§11)**. v2 folded the first architect review (§9). §§1–7 are current.
Package under evaluation: `flutter_webrtc` (pub.dev).

## 0. Decisions of record (locked with the operator)

| # | Decision | Choice |
|---|---|---|
| D1 | First capability | **1:1 live calls** (voice messages/group calls out of scope for v1) |
| D2 *(amended v3)* | Recording architecture | **Server-side recording via a media relay (`secchat-mediad`)**: consented-recorded calls route media through a server WebRTC endpoint that records each leg; unrecorded calls stay pure P2P (server cannot tap them). Rationale: platform-independent recording (enables future mobile/desktop), durable compliance artifact, truthful ● REC, technical (not advisory) enforcement of consent for the in-app recorder, and the same server media component group audio will require anyway. *(v1–v2: caller's client recorded both sides — superseded, see §10.)* |
| D3 | Recording policy | **Caller opts in per call; callee must consent** |
| D4 | Consent declined | **Call proceeds unrecorded** (pure P2P); the call *event* (who/when/duration/consent outcome) is still audited |
| D5 | Call surface & artifact home | **DMs only** — call button in DM channels; recording + transcript land in the DM, visible to exactly the two participants |

## 0.1 Stated assumptions (veto-able — flagged rather than asked)

| # | Assumption | Rationale |
|---|---|---|
| A1 | **Platforms v1: web app first** | The deployed client is Flutter web. With recording server-side, clients only need to *call* — `flutter_webrtc`'s weakest surface (client recording) is no longer used, so desktop/mobile become app-scope questions, not recording-capability questions (§5). |
| A2 | **Signaling rides the existing authenticated WS hub** | Per-user socket + channel subscriptions exist; new `call_*` frames reuse auth and presence. In recorded mode the backend brokers SDP between each client and mediad (SFU-standard); in unrecorded mode it relays client↔client. |
| A3 | **STUN in v1, no TURN** | Chromium hides host candidates behind mDNS `.local` names, so zero-ICE-server P2P connects can fail across hosts even on one LAN. v1 configures a STUN server; coturn remains the documented follow-up (§8, O2). Recorded-mode media doesn't need STUN to reach mediad (fixed host:port). P1 exit test is a **two-different-hosts** connect. |
| A4 *(amended v3)* | **Server records RTP Opus per leg — no transcoding in the hot path** | mediad depacketizes each peer's RTP Opus into an OGG/Opus file (pure remux, incremental page writes). ffmpeg (in the mediad image) post-mixes the two legs into one playback file. SecRecorder's ffmpeg ingests OGG/Opus. No MediaRecorder, no Safari container fallback. |
| A5 | **Artifact storage reuses the attachments pipeline** | The mixed playback file becomes an attachment claimed by the transcript message; server-side assembly attaches via the backend (no client upload of the recording at all). |
| A6 | **Transcription is server-brokered** | The secchat backend calls SecRecorder; clients never see its URL or the recording files. SecRecorder is unauthenticated — network isolation (reachable only from the backend, never from clients) is the control. |
| A7 *(amended v3)* | **Speaker labels are real usernames, deterministically** | Each recorded leg *is* one known participant. Per-leg transcription gives exact attribution with **no diarization and no voiceprints** — pyannote/HF-token machinery (old R3) and P4 voiceprint enrollment are unnecessary for 1:1 calls. |
| A8 | **SecRecorder is re-enabled in the deployment** | Currently dropped (`[deploy].without = ["secrecorder"]`). Voice transcription earns it back. |

## 1. Goals / non-goals

**Goals (v1):**
- Start/answer/decline/hang up a 1:1 voice call from a DM, with live presence-aware UI.
- Caller-initiated recording with an explicit callee consent prompt; ● REC driven by the server recorder's *actual* state.
- Post-call: mediad's per-leg recordings are assembled server-side; the backend transcribes each leg via SecRecorder, merges into a speaker-exact transcript, and posts a governed transcript message (marking + DLP applied) to the DM with the mixed audio attached.
- Full audit trail: `call.start`, `call.consent.granted` / `call.consent.declined`, `call.end`, `call.recording_stored`, `call.transcribed` (consent outcome in the hash-bound `action`, §4).

**Non-goals (v1):** video; group calls (mediad is deliberately the seed of that SFU — spec'd in P4, not built); TURN; screen share; live (streaming) transcription; voice messages; PSTN; mobile apps.

## 2. Architecture

### 2.1 Signaling (new `call_*` WS frames over the existing hub)

One active call per DM channel, tracked server-side (`CallState`: `ringing → active → ended`, with `mode: p2p | relayed` fixed at setup and `recording: none|on` for relayed calls).

```
caller                     secchat (WS hub + CallRegistry)                 callee
  │ call_invite {channelId, wantRecording} ─▶ validate DM member, no active call
  │                                          audit call.start(ringing)
  │                                          ──▶ call_invite {from, wantRecording}   (all tabs ring)
  │ ◀── call_accept ────────────────────────◀── call_accept {consent}  (first tab wins → call_taken to rest)
  │       audit call.consent.granted|declined ; mode := consent ? relayed : p2p
  │
  │  mode=p2p:      call_sdp/call_candidate relayed caller-conn ◀──▶ callee-conn (bound connections only)
  │  mode=relayed:  each side does offer/answer with mediad, brokered by the backend
  │                 (client → call_sdp → backend → mediad control API → answer → client)
  │
  │            p2p: media direct DTLS-SRTP — server never sees it
  │        relayed: media client ⇄ mediad ⇄ client; mediad records both legs
  │ call_end ────────────────────────────────▶ audit call.end ──────────────────────▶ │
```

Server responsibilities:
- **Membership + single-flight**: only the DM's two members; reject a second concurrent call per channel (and per user). Simultaneous both-sides invites (glare) resolve by a deterministic tiebreak (lower `sub` wins).
- **Connection-scoped routing** (v2 REQUIRED): the hub gains a per-connection send; the CallRegistry binds the call to exactly one connection per side (inviting connection; first-answering connection). `call_invite` rings all callee tabs; first `call_accept` wins, the rest get `call_taken`. This also pins the audited consent to the tab the human actually used.
- **Mode is fixed at setup** (O5 deferral makes this clean): consent=true ⇒ both sides connect to mediad from the start; consent=false ⇒ pure P2P. No mid-call renegotiation or topology switch.
- **Consent semantics**: for the *in-app* recorder, consent is now technically enforced — mediad only joins (and can only record) calls the backend authorizes after `call.consent.granted`. Out-of-band capture (hostile client build, OS recorder) remains possible on any call; ● REC and consent stay honest-UX + audit controls against that.
- **Relay bounds** (v2 REQUIRED): in p2p mode the SDP/ICE relay is a user-to-user content path outside DLP/marking/chain governance — per-frame size cap (e.g. 32 KiB, far below the 16 MiB frame ceiling), candidate count + rate caps per call; SDP parse-and-reserialize is follow-on hardening. In relayed mode client SDP terminates at the server/mediad, so no user-to-user covert channel exists.
- **Timeouts / teardown**: `ringing` auto-expires (e.g. 45 s) → `call_missed` line in the DM; an `active` call ends when a bound connection closes (hook `untrackConnection`) — no heartbeat lease. In relayed mode, mediad also reports ICE disconnect per leg to the backend.

### 2.2 Media (flutter_webrtc client; two modes)

- `getUserMedia({audio: true})` → local track; unified-plan **audio transceiver** (not legacy `offerToReceiveVideo`); DTLS-SRTP is mandatory in both modes.
- **p2p mode**: `RTCPeerConnection` peer-to-peer with a STUN server (A3). Encrypted end-to-end between the two browsers; no server tap — this is what an unrecorded call gets, preserving the original D2 privacy property where it still applies.
- **relayed mode**: each client's `RTCPeerConnection` peers with **mediad** (to the client it looks like a single remote peer — the same shape a future SFU presents). mediad forwards RTP between the legs and records. Clients hold no mediad credentials: their SDP/ICE go through the authenticated WS + backend, and DTLS certificate fingerprints in the SDP secure the media path **against the network** — the backend brokers the SDP and could swap fingerprints, so it is in the media-confidentiality TCB (acceptable: it already sees the plaintext transcript; stated for honesty).
- **relayed-mode ICE specifics** *(v3 review — REQUIRED/SUGGESTED)*: mediad's in-container PC gathers unreachable container IPs; it must advertise the **suite host's cross-host-reachable address** via Pion `SetNAT1To1IPs` (operator-configurable, applied to both UDP and TCP candidates) — the #1 containerized-Pion failure mode, forced correct by P1's two-host exit test. mediad's side is **non-trickle** (single muxed candidate → gather-and-answer in one response; client also gathers-complete before offering, keeping the control API plain request/response). Client *host* candidates are mDNS `.local` names a container can't resolve — connectivity relies on the client's srflx candidate and **peer-reflexive discovery** from the client's inbound binding requests; stated so nobody "fixes" it.
- Client audio sinks to a live `<audio>` element in both modes (also required test: echoCancellation across the two modes).

### 2.3 Recording (`secchat-mediad`, server-side — D2 v3)

A small Go/**Pion** daemon deployed alongside secchat (compose service; image via `[[builds]]`):

- **Control API** (HTTP, compose-internal network only, bearer token shared with the secchat backend): `POST /sessions` (callId, two **leg-correlation ids** — backend-side routing labels for proxying each SDP to the right leg, *not* client-held auth; the only auth is the control-API bearer) → single-response SDP answer per leg (non-trickle, §2.2); `GET /sessions/:id` (leg ICE states, recording writer state); `DELETE /sessions/:id` (end + finalize); `GET /health` (compose healthcheck + P0 smoke).
- **Media**: a **single well-known UDP port for all sessions** (Pion `ICEUDPMux`, e.g. :47020; ICE-TCP fallback via `SetICETCPMux` on the same port number — a distinct L4 socket and a half-open-connection DoS surface, bounded by session caps). Advertised candidates per §2.2 (`NAT1To1IPs` = suite host address).
- **Recording** = RTP Opus depacketization → **per-leg OGG/Opus files** written incrementally (page-level flush) to a volume shared with the secchat container. **A sequence-number reorder/dedup buffer sits in front of the OGG writer** *(v3 review — REQUIRED)*: Pion's `oggwriter` advances the granule by RTP-timestamp delta and assumes in-order arrival — unbuffered UDP reorder yields corrupt pages. Loss policy: skip → granule gap (no PLC; we never decode). With ordering fixed, Opus DTX silence gaps reproduce correctly through the timestamp-delta granule mapping (48 kHz both sides; test with `usedtx=1`). RTCP: **generate a Sender Report per leg** (timebase + loss feedback); ignore PLI/FIR (video-only). No decode in the hot path; a crash loses at most the last page — durability is inherent, no chunk-upload protocol, no client-side recovery machinery (this replaces v2 REQUIRED #5; the *relocated* durability item — backend handoff recovery — is in §2.4).
- **Shared timebase** *(v3 review — REQUIRED)*: the legs do **not** share t0 (each OGG starts at that leg's first received packet, seconds of skew possible). mediad establishes a session t0 and emits per-leg `start_offset_ms` in the finalize manifest; the merge places segments at `leg_start_offset + segment_time`. Browser capture-clock drift over a 2 h call is sub-second — noted, not corrected.
- **Finalize** (on session end): ffmpeg (in-image — the only optional component and the only shell invocation; kept because a single playback file is much better UX) mixes the two legs into one playback file (`amix`, m4a or ogg) and emits the manifest (files, per-leg durations, `start_offset_ms`). The backend constrains manifest-driven reads/deletes to the session directory (path-traversal hardening); an orphaned-session janitor cleans dirs that never finalize (beyond `activeDeadline`).
- **Leg re-attach semantics** *(v3 review — REQUIRED)*: a single-leg ICE blip recovers via **ICE restart on the same PeerConnection** (same SSRC → RTP/granule continuity, no recorder impact; the other leg holds). A *new* PC on client reconnect is a new SSRC with a reset timestamp base — the recorder treats it as a **new segment** (re-based granule with a bridging gap at the wall-clock offset). Whole-call drop is reserved for mediad crash or both-legs loss.
- **● REC truth**: recording state is mediad's actual writer state, reported to the backend and broadcast to both UIs. The indicator is now truthful by construction (v2's client-honesty caveat shrinks to the out-of-band capture note in §2.1).
- **Failure modes**: mediad unreachable at setup ⇒ the caller is offered "call without recording" (p2p) — recording **fails closed, calling fails open**. The downgrade is surfaced to **both** parties: the callee consented specifically to a *recorded* call, so the callee's accept screen shows "recording unavailable — this call will NOT be recorded" (● REC absence alone is too subtle for a consent-relevant change; product decision recorded here rather than silent downgrade). mediad crash mid-call ⇒ the relayed call drops (clients may redial; partial per-leg files up to the last flushed page are finalized and still transcribed, with the truncation stated in the transcript header); single-leg blips recover per the re-attach semantics above.

### 2.4 Post-call pipeline (assemble → transcribe per leg → governed post)

```
mediad (shared volume)            secchat backend                       SecRecorder
  │ session end: caller.ogg,
  │ callee.ogg, mixed.m4a,
  │ manifest (start_offset_ms) ──▶ ingest mixed.m4a: sha256 → blobs.write → addAttachment
  │                                (a NEW internal path — server-side attachment creation,
  │                                 uploadedBy = the "system" principal; NOT the client
  │                                 HTTP upload route. Recordings volume is a NEW volume,
  │                                 distinct from `uploads`, mounted mediad rw + secchat rw)
  │                                audit call.recording_stored
  │                                enqueue 2 transcription jobs:
  │                                  caller.ogg ──▶ POST /v1/audio/transcriptions ──▶
  │                                  callee.ogg ──▶ (diarize=false; server always returns
  │                                                 verbose_json + words[]/segments)
  │                                merge segments at leg_start_offset + segment_time
  │                                (shared session t0, §2.3) → speaker-exact turns
  │                                governedCallAppend(DM, transcript, attachment)
  │                                  → marking stamp + DLP scan (block ⇒ withheld notice)
  │                                audit call.transcribed
  │                                broadcast the message (both parties see it live)
```

- Transcript body: header (`Call — 12m 34s (recorded 11m 58s) — recorded with consent`) then merged speaker turns with **real usernames** (`**Alice** [00:12] …`) — leg identity makes attribution exact (A7). Call duration (wall clock) vs recorded duration labeled distinctly; timestamps recording-relative.
- **Governed append is new code** (v2 REQUIRED): `governedCallAppend` shares the DLP/marking/withhold core with `governedAgentAppend`, adds attachment claiming (`attachmentsSha256` + `claimAttachments`, factored from the message-post route), authors as the new `"system"` type (§8 O4). The message chain already binds `attachmentsSha256`, so the recording is tamper-evidently tied to the transcript.
- No attachment `kind` field exists — the recording is identified by filename + `content_type`, no schema change.
- **Two SecRecorder calls per recording** ≈ 2× GPU time vs one mixed-file pass, serialized by `WHISPER_MAX_CONCURRENCY=1` — the retry/backoff queue is load-bearing; the deploy sets `WHISPER_MAX_UPLOAD_MB`. In exchange, pyannote/diarization (and its HF token, and old R3) drop out of the calls path entirely. Config fallback `SECCHAT_TRANSCRIBE_MODE=mixed` (one pass, `diarize=true`, Speaker 1/2 labels) if transcription throughput ever forces it.
- **Failure isolation**: SecRecorder down ⇒ jobs retry with backoff; the attachment is already stored; a `transcription pending` line posts immediately (the artifact is never invisible); poison audio ⇒ visible failure line, never silent. Retention of the raw per-leg files after successful transcription: deleted (the mixed attachment + transcript are the artifacts of record).
- **Handoff crash recovery** *(v3 review — REQUIRED; the relocated durability item)*: if the backend crashes between mediad's finalize and attachment-ingest/transcript-post, the artifact would sit un-ingested on the volume. On startup the backend **reconciles**: scan for `calls` rows with `endedAt` set and `recordingAttachmentId` null whose session dir exists → ingest + transcribe; if legs exist but the mixed file is missing/partial (mid-finalize crash), re-run the ffmpeg mix. Without this, the compliance-artifact guarantee that motivated v3 has a hole at the last hop.
- Marking: the DM's marking stamps transcript + attachment; the store's append-time marking re-stamp (advisory lock) keeps it server-authoritative.

### 2.5 Deployment changes (secdeploy)

1. Remove `secrecorder` from `[deploy].without` (existing component, fronted via secproxy — no new secdeploy feature).
2. **New compose service `mediad`** in the secchat stack: image `secchat-mediad:local` (new `[[builds]]` entry, Go/Pion + ffmpeg), UDP+TCP :47020 published. **colima UDP caveat** *(v3 review)*: :47010 is a *TCP* publish — UDP forwarding through colima/Lima is historically less reliable and may need explicit `portForwards` `proto: udp` config; P0's "UDP port reachable" exit test gates this, with ICE-TCP as the fallback. Media is DTLS-SRTP, so LAN exposure is far less sensitive than the plaintext HTTP port. **New recordings volume** (distinct from `uploads`, which mounts to secchat only today) mounted to mediad (rw) + secchat (rw: ingest + delete). Control API on the compose-internal network only + `SECCHAT_MEDIAD_TOKEN`.
3. New secchat env: `SECCHAT_TRANSCRIBE_URL`, `SECCHAT_MEDIAD_URL`, `SECCHAT_MEDIAD_TOKEN`, `SECCHAT_CALL_STUN`, and `SECCHAT_MEDIAD_ADVERTISE_ADDR` — the suite host's cross-host-reachable address fed to Pion `NAT1To1IPs` (§2.2; **the #1 containerized-Pion failure mode** — operator-configurable, applied to UDP and TCP candidates).
4. **STUN default is suite-local, not public** *(v3 review)*: a public default (e.g. Google STUN) leaks each unrecorded call's existence + client IPs to a third party and breaks the suite's air-gap posture. Default: coturn in STUN-only mode as a tiny suite service (it's the P4 TURN component anyway), or empty (LAN/VPN p2p usually connects via host/peer-reflexive candidates; relayed calls never need STUN — mediad is a fixed host:port).
5. `wiring.sync_secchat_env` gains these (same pattern as the pool env).

## 3. Component work breakdown (pedantic)

### 3.1 secchat backend (`src/`)
| Item | Detail |
|---|---|
| `ws/hub.ts` | New `call_*` inbound frames + **a per-connection send primitive**; CallRegistry hooks; `untrackConnection` → call teardown; size/rate caps on `call_*` payloads (§2.1). |
| new `calls/registry.ts` | `CallRegistry`: per-DM single-flight state machine bound to one connection per side; mode fixed at setup (p2p/relayed); ringing timeout, glare tiebreak, first-accept-wins pinning, socket-drop teardown, consent bookkeeping, duration tracking. Pure + injected clock. |
| new `calls/mediad-client.ts` | mediad control API client: create session, broker per-leg SDP, poll/receive state, end + collect finalize manifest from the shared volume (reads/deletes constrained to the session dir); **startup reconciliation** of finalized-but-unclaimed sessions (§2.4); server-side attachment ingest (sha256 → blobs.write → addAttachment, `"system"` uploader). |
| `http/server.ts` | `GET /calls/:id` (state, for reconnecting clients — P3 specs ICE-restart/re-offer and, for relayed mode, leg re-attach). *(No recording upload endpoints — recording never transits the client.)* |
| `transcribe/client.ts` + `transcribe/merge.ts` | SecRecorder client (multipart POST, retry/backoff queue); per-leg jobs; merge per-leg segments into speaker-turn transcript; mixed-mode fallback formatting. |
| `governance` | **New:** `governedCallAppend` — shared DLP/marking/withhold core + attachment claim + `"system"` author (v2 REQUIRED). Audit `call.*` actions with outcome-in-`action` (§4). |
| `types.ts` | Add `"system"` to `AuthorType` (+ chain input); renderers display the service principal. |
| store | `calls` table (id, channelId, caller, callee, startedAt, endedAt, consent, mode, recordingAttachmentId, transcriptMessageId) — **four edits**: migration `0019_calls.sql` (self-contained BEGIN/COMMIT, modeled on 0006) + `Store` interface + MemoryStore + PgStore. Respect the messages append-only guard trigger (0006) on cross-references. |

### 3.2 `secchat-mediad` (NEW, Go/Pion)
| Item | Detail |
|---|---|
| WebRTC | Pion: one `PeerConnection` per leg, audio transceiver recvonly+sendonly pair, `ICEUDPMux` single-port + `SetICETCPMux` fallback, `SetNAT1To1IPs(advertiseAddr)`, non-trickle answer, DTLS-SRTP. RTP forwarding between legs (packet-level, no decode). RTCP: emit SR per leg; ignore PLI/FIR. ICE restart on same PC for single-leg blips. |
| Recording | **Seq-number reorder/dedup buffer** → OGG/Opus writer per leg (Pion `oggwriter` shape; loss ⇒ granule gap, DTX-safe), page-level flush; session t0 + per-leg `start_offset_ms`; new-segment handling on re-attach with new SSRC; rotation-safe finalize; ffmpeg mix step. |
| Control API | Token-auth HTTP: sessions CRUD, single-response SDP per leg, state reporting (leg ICE states, recording writer state), finalize manifest (files, durations, `start_offset_ms`), `/health`. |
| Hardening | Non-root container, no shell needed at runtime except ffmpeg invocation, recordings volume as its only write mount, session cap + per-session `activeDeadline` (mirrors pool-pod discipline), orphaned-session janitor. |
| Tests | Go: state machine + writer unit tests (incl. **out-of-order/duplicate/lost RTP → valid OGG with granule gaps; DTX timestamp jumps; re-attach new-SSRC segmenting**); an integration test dialing it with a second Pion client as a fake browser (offline, no real browser), asserting per-leg OGG output + manifest with `start_offset_ms`. |

### 3.3 Flutter app (`app/`)
| Item | Detail |
|---|---|
| deps | `flutter_webrtc` (pin latest stable). **No client recording stack** — no MediaRecorder, no Web Audio mix, no `dart:js_interop` audio graph (v2's R1 machinery deleted). |
| `lib/calls/` | `CallController` (signaling state machine, p2p vs relayed connect paths — the PC setup differs only in who the remote peer is), `MediaSession` (getUserMedia/PC lifecycle). |
| UI | DM header call button (presence-aware), ring screen (accept / accept-without-consent / decline), in-call bar (mute, hang up, ● REC from server state, duration), transcription-pending/failure lines. Compact-layout compliant. |
| WS | `call_*` frame types in `models.dart` + `api.dart` send helpers. |
| permissions | Web: browser mic prompt UX copy. (Desktop entitlements documented but deferred with desktop itself.) |

### 3.4 SecRecorder
No code changes. Config only: re-enabled, reachable from the backend via secproxy, models prewarmed. Diarization extras (pyannote/HF token) **not required** for calls (A7); only needed if the `mixed` fallback mode is used.

### 3.5 secdeploy
`without` change + mediad compose service + `[[builds]]` entry + env wiring + docs. (One PR.)

## 4. Governance, audit, retention
- **Audit events** (v2 REQUIRED): `computeAuditHash` binds `seq, actor, actAs, action, target, at` — `detail` is NOT hash-bound. Consent outcome is encoded in the `action`: `call.start`, `call.consent.granted`, `call.consent.declined`, `call.end`, `call.recording_stored`, `call.transcribed` (`action` is free-form — no type change). Durations etc. ride in `detail` as un-chained provenance.
- **Signaling covert channel**: exists only in p2p (unrecorded) mode; bounded per §2.1. Relayed-mode SDP terminates at the server.
- **Server sees media**: in relayed (consented-recorded) calls, mediad handles cleartext RTP inside DTLS termination — by design and only after consent; unrecorded calls remain end-to-end between browsers. This trust statement goes in user-facing docs verbatim.
- **Marking**: DM marking stamps transcript + attachment; append-time re-stamp under advisory lock keeps it server-authoritative. The DLP/marking *policy* core is reused; the transcript append path is new code (§2.4).
- **DLP**: the transcript body passes the DLP scan on append — spoken CUI gets the same flag/block behavior as typed text. Voice becomes governable; with per-leg attribution, DLP hits attribute to the *speaker's* words in a transcript authored by the service principal.
- **Unrecorded calls** (D4): only `call.*` events exist — content is never captured anywhere, including the server.
- **Retention**: recording + transcript are ordinary attachment/message rows and inherit DM retention. Raw per-leg files are deleted after successful transcription; on transcription failure they're retained until the job is resolved or abandoned (visible failure line).

## 5. Platform matrix + package risks

| Platform | Call | Record | Notes |
|---|---|---|---|
| Web (Chromium) | ✅ v1 | ✅ (server-side — no client capability needed) | Primary target. |
| Web (Safari) | ✅ v1 | ✅ (server-side) | No MediaRecorder involvement ⇒ no mp4/AAC fallback needed; Safari WebRTC audio itself is mature. Test-matrix row, not a risk. |
| macOS desktop (flutter native) | ⏸ deferred (app scope) | ✅ when the app lands (server-side) | The old "desktop can't record" problem is gone; desktop returns purely as an app/packaging effort. |
| iOS/Android | ⏸ no mobile app today | ✅ when an app lands (server-side) | Remaining mobile work is app + call lifecycle (CallKit/audio session, backgrounding, push-wake) — not recording. |

**R1 (was: client recording inconsistency — retired).** Replaced by: **mediad is new custom infrastructure** — a Go/Pion daemon we own. Mitigations: packet-level remux only (no codec work in Go), Pion is mature and pure-Go, integration-tested with a Pion fake-browser client, session caps + deadlines.
**R2:** Echo/noise: browser constraints (`echoCancellation`, `noiseSuppression`); verify in both p2p and relayed modes (the relay adds latency that echo cancellers must track).
**R3 (was: diarization degradation — retired for calls).** Per-leg transcription needs no diarization. The `mixed` fallback mode reintroduces it, config-gated.
**R4:** Long calls: server disk, not client memory — cap recording length (default 2 h, configurable) with UI warning; disk-space monitoring on the recordings volume.
**R5:** Relayed-call availability: mediad down ⇒ recording unavailable but calling still works (fail-closed recording, fail-open calling, §2.3); mediad mid-call crash drops the call with partial artifact finalized and labeled.
**R6:** UDP reachability: :47020 must be reachable from clients (firewalled sites need the port opened), and **colima's UDP forwarding is not at parity with its TCP publishes** — may need explicit `proto: udp` port-forward config; gated by P0's reachability exit test. ICE-TCP fallback on the same port covers UDP-hostile paths at some quality cost. The advertised candidate address (`SECCHAT_MEDIAD_ADVERTISE_ADDR` → `NAT1To1IPs`) must be the cross-host-reachable suite address — wrong value = relayed calls never connect (P1/P2 two-host tests catch it).

## 6. Phases

| Phase | Deliverable | Exit test |
|---|---|---|
| P0 | SecRecorder re-enabled; secchat reaches it (canned transcription from the backend). mediad image builds + deploys; control API healthy; UDP port reachable | `curl` transcription round-trip; mediad session-create smoke test from the secchat container |
| P1 | Signaling + P2P (unrecorded) calls: CallRegistry, WS frames + per-connection routing, DM call UI, presence-gated, STUN | **Two different hosts** complete a call; audit events present; multi-tab ring/first-accept verified |
| P2 | Relayed recorded calls end-to-end: consent → relay connect → per-leg recording → assembly → per-leg transcription → merged governed transcript post | Recorded two-host call yields a speaker-exact transcript message in the DM; DLP flag test with a seeded spoken pattern; mediad-down ⇒ offered unrecorded call |
| P3 | Reconnection (ICE restart / re-offer, relayed leg re-attach), glare tiebreak, missed-call lines, polish | Reconnect matrix green; glare test deterministic |
| P4 (spec only) | Group audio design doc: mediad → SFU growth path (N legs, mixing matrix, recording all legs), coturn component spec | Doc reviewed |

## 7. Testing strategy
- **CallRegistry**: pure unit tests (state machine, single-flight, glare, timeouts, consent→mode, first-accept pinning, socket-drop) — offline, injected clock.
- **WS frames**: hub-level tests incl. per-connection routing (frames land only on bound connections; non-participant relay rejected; size/rate caps enforced).
- **mediad**: Go unit tests + Pion fake-browser integration test (dial, exchange audio, assert per-leg OGG output + finalize manifest) — no real browser needed.
- **Transcribe**: mock SecRecorder (multipart shape, retry on 5xx, per-leg merge correctness incl. overlapping speech, poison file → visible failure); `mixed` fallback formatting.
- **Pipeline**: integration test with fixture OGG legs: assembly → jobs → (mock) transcripts → merge → `governedCallAppend` (DLP block case included; attachment claimed; `"system"` author asserted).
- **Flutter**: widget tests for ring/in-call/consent UI with a fake CallController; both connect modes against a fake signaling layer.
- **Live**: two-browser, two-host manual matrix on the test instance (alice/bob), recorded + unrecorded + mediad-down runs.

## 8. Open items — resolved
- **O1 (record-capable side negotiation):** **Mooted by v3** — recording is server-side; no per-platform record capability exists.
- **O2 (TURN):** STUN ships in v1 (A3); coturn spec'd in P4 alongside the SFU growth path.
- **O3 (callee-requested recording):** Deferred; revisit post-v1.
- **O4 (transcript authorship):** **Decided — new `"system"` author type**; transcript posts as the service principal, both participants named in the body, DLP/audit attributed per-speaker via leg identity within a system-authored message. The one deliberate type-model extension.
- **O5 (mid-call arming):** Deferred — invite-time arming only. In v3 this is also what keeps topology fixed at setup (no mid-call P2P→relay migration).

## 9. Architect review outcomes (v2 — 2026-08)

An Opus architect review (grounded in direct reads of `governance/append.ts`, `audit/chain.ts`, `types.ts`, `attachments/manifest.ts`, the server attachment/message routes, `ws/hub.ts`, migrations, and SecRecorder's `server.py`) confirmed the D1–D5 scope and SecRecorder API usage, and required seven changes, all reflected above:

1. **Connection-scoped signaling** — per-connection hub send; call bound to one connection per side. *(§2.1, §3.1)*
2. **Governed transcript-with-attachment is new code** — `governedCallAppend` with manifest+claim. *(§2.4, §3.1)*
3. **Consent outcome in the audit `action`** — `detail` is not hash-bound. *(§4)*
4. **O4 decided: add `"system"` AuthorType.** *(§8)*
5. **Recording durability** — v2 answered with chunk-streaming; **v3 supersedes it** with server-side recording (durability inherent). *(§2.3)*
6. **Signaling covert channel named + bounded.** *(§2.1, §4)*
7. **Corrected "reuses existing machinery" claims** — no attachment `kind`, no hub lease, four-part store work, append-only guard respected. *(§2.4, §3.1)*

Suggested items folded: STUN in v1 + two-host P1 exit; `words[]` second attachment cut; heartbeat lease cut; desktop dropped from near-term; ● REC truth direction (mooted by v3 — server state *is* recorder state); consent/REC stated as advisory against out-of-band capture; P3 reconnection + glare; SecRecorder unauthenticated (network isolation is the control); voiceprints-as-biometric-store note (now moot for calls — per-leg attribution needs no voiceprints).

## 10. v3 amendment record — D2 moved server-side (2026-08)

**Trigger (operator):** group audio will eventually force a server media component (mesh doesn't scale), and server-side recording is what makes recording platform-independent for future mobile/desktop clients — so the client-side recording stack (Web Audio mix, MediaRecorder, Safari fallback, chunk-streaming durability machinery) would be disposable work.

**Shape chosen:** recorder-peer/relay (`secchat-mediad`, Go/Pion): consented-recorded calls relay through mediad (which records per leg); unrecorded calls stay pure P2P. Topology fixed at call setup (enabled by the O5 deferral).

**What v3 buys:** platform-independent recording; inherent durability (server disk, incremental writes); truthful ● REC; technical consent enforcement for the in-app recorder; speaker-exact transcripts from leg identity (no diarization/voiceprints); no user-to-user SDP covert channel in recorded mode; the SFU seed for group audio.
**What v3 costs:** a new custom media daemon (R1); server sees cleartext RTP for consented-recorded calls (documented trust statement, §4); a published UDP media port (R6); ~2× transcription GPU time per recording (config fallback to mixed+diarize).
**Deleted from v2:** client recording stack, chunk-streaming endpoints, IndexedDB recovery, Safari mp4 fallback, ● REC direction fix (moot), O1's capability negotiation (moot).

## 11. v3-delta review outcomes (v3.1 — 2026-08)

The same architect reviewed the v3 media architecture (grounded in the deploy surface: compose port publishes, `uploads` volume mounts, `[[builds]]`). Verdict: **architecturally sound** — the relay shape, ICEUDPMux single-port, packet-level forward, per-leg OGG remux, all four security/trust claims, the fail-closed-recording/fail-open-calling policy, per-leg transcription retiring diarization, and P4 SFU-as-spec-only were all confirmed. It agreed v3 **replaces v2 REQUIRED #5** (chunk streaming), with the durability concern *relocated*, not eliminated. Five REQUIRED items, all folded into §§2–7:

1. **Reorder/dedup buffer before the OGG writer** — Pion's `oggwriter` assumes in-order RTP; unbuffered UDP reorder corrupts every recording. Loss ⇒ granule gap; DTX correctness rides on the same fix. *(§2.3, §3.2)*
2. **Shared cross-leg timebase** — legs start at different instants; mediad emits per-leg `start_offset_ms` against a session t0 or every merged transcript is misordered by the inter-leg skew. *(§2.3, §2.4)*
3. **Advertised ICE address** — `NAT1To1IPs` = the suite host's cross-host-reachable address (`SECCHAT_MEDIAD_ADVERTISE_ADDR`), the #1 containerized-Pion failure mode. *(§2.2, §2.5, R6)*
4. **Leg re-attach semantics** — single-leg blip: ICE restart on the same PC (SSRC continuity); new PC = new SSRC = new recording segment; whole-call drop only on mediad crash/both-legs loss. *(§2.3)*
5. **Handoff crash recovery** — startup reconciliation of finalized-but-unclaimed sessions (ingest + transcribe; re-mix on mid-finalize crash). *(§2.4, §3.1)*

Suggested items folded: suite-local STUN default (public STUN leaks call metadata to a third party — CUI/air-gap posture); RTCP reframed to SR-per-leg (not "PLI-noop"); non-trickle mediad SDP + reliance on client srflx/peer-reflexive (mDNS host candidates unresolvable in-container); "leg tokens" clarified as backend-side correlation ids; backend named in the media-confidentiality TCB; mediad `/health`, orphaned-session janitor, session-dir path constraint; colima **UDP**-forwarding caveat (not parity with the TCP :47010 publish); new recordings volume + server-side `addAttachment` ingest path made explicit; recorded→unrecorded downgrade surfaced to the **callee** (consent-relevant, not silent). One SFU-doc caution recorded for P4: don't hard-code "exactly two PCs/two files" into the session model.
