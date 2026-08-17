// CallRegistry — the server-side call state machine (docs/plans/voice-calls-plan.md §2.1, §3.1).
//
// Per-DM single-flight (one ringing/active call per channel, one per user across ALL their DMs),
// mode fixed at ACCEPT time (§2.1's O5 deferral: no mid-call P2P<->relay migration),
// connection-scoped binding (a call is pinned to exactly one connection per side — the inviting
// connection for the caller, the first-accepting connection for the callee — via the hub's
// per-connection send primitive, ws/hub.ts's `sendToConnection`), glare tiebreak (simultaneous
// both-sides invites resolve by lower `sub` wins), ringing timeout (default 45s, driven by
// `checkRingingTimeouts` — see its own doc comment for who calls it), and socket-drop teardown (the
// hub's `untrackConnection` hook). Pure + an injected clock (deps.now) so it unit-tests offline,
// matching audit/chain.ts's "pure primitive, driven by something stateful" split — here ws/hub.ts is
// the stateful thing that drives this.
//
// On a relayed call's end, this also kicks off the §2.4 post-call pipeline (mediad.endSession ->
// attachment ingest -> claim onto a pending-status chat line -> transcribeClient.transcribeLeg x2
// -> mergeTranscripts -> governedCallAppend -> broadcast) — fire-and-forget from `end()` so the
// signaling teardown itself stays fast; every failure point is audited
// (`call.recording_failed`/`call.transcribe_failed`), never thrown past the caller, matching §2.4's
// failure-isolation note ("poison audio => visible failure line, never silent" — and, per the v3.1
// review, "the artifact is never invisible": the ingested recording is claimed onto a chat line the
// MOMENT it's ingested, not left unclaimed until a transcript that may never arrive — see
// `runPostCallPipeline`'s comment for the full sequencing). The attachment-ingest step needs a
// BlobStore + the shared recordings-volume path this backend process can read — both are OPTIONAL
// on CallRegistryDeps (see its doc comment) so this module still unit-tests without them wired;
// index.ts's real construction DOES pass them (`SECCHAT_MEDIAD_RECORDINGS_DIR` + the shared
// FsBlobStore + `store.addAttachment`) whenever mediad itself is configured.

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { governedCallAppend } from "../governance/append.ts";
import { parseMarking } from "../marking/caveats.ts";
import type { MarkingPolicy } from "../marking/policy.ts";
import type { DlpPolicy } from "../dlp/policy.ts";
import { sha256Hex, type BlobStore } from "../attachments/blobs.ts";
import {
  editPendingIfClaimed as sharedEditPendingIfClaimed,
  postPendingRecordingMessage as sharedPostPendingRecordingMessage,
  resolveChannelMarking as sharedResolveChannelMarking,
  type PendingRecordingDeps,
} from "./pending-recording.ts";
import type { MediadClient, MediadFinalizeManifest } from "./mediad-client.ts";
import { formatTranscript, mergeTranscripts, type LegTranscript, type MergedTurn, type TranscriptHeaderInput } from "../transcribe/merge.ts";
import type { TranscribeClient } from "../transcribe/client.ts";
import type { AddAttachmentInput, Attachment, CallMediaState, CallMode, CallParticipantRow, CallRecordingState, Id, LlmClient, Store } from "../types.ts";
import { groupLegId, LEG_CALLEE_ID, LEG_CALLER_ID } from "./leg-ids.ts";

/** Injected per-connection send (ws/hub.ts's `Hub.sendToConnection`) — CallRegistry never touches
 * a raw socket itself, matching how the rest of the backend takes its transport by injection
 * (VerifyToken, Broadcast, etc. — see types.ts's header comment). Returns whether the connection
 * was still live to receive it (mirrors hub.ts's broadcast/deliverToUser "no-op if gone" shape). */
export type SendToConnection = (connId: string, payload: unknown) => boolean;

/** Thrown by `invite`/`accept`/`relay`/`end` for an expected, client-facing rejection (bad request,
 * a policy conflict) — as opposed to an unexpected internal error. `code` is the stable
 * machine-readable reason (ws/hub.ts turns it into a `call_error` frame back to the sender); the
 * plan doesn't prescribe a wire shape for this (voice-contracts.md §1.3 just says "a WS-level error
 * frame"), so this is this implementation's own, private to the signaling layer. */
export class CallSignalError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** CallRegistry is the calls domain's "control plane" (the AgentControl of calls, types.ts) — it
 * owns not just the signaling state machine but, on a relayed call's end, kicking off the whole
 * §2.4 post-call pipeline. That's why its deps bag is wide, mirroring makeControlPlane's
 * (agent/control.ts) shape. */
export interface CallRegistryDeps {
  store: Store;
  send: SendToConnection;
  /** Injected per-SUB delivery (ws/hub.ts's `Hub.deliverToUser`) — pushes to EVERY live connection
   * of a principal, unlike `send` (exactly one bound connection). CallRegistry needs this for the
   * cases connection-scoped `send` structurally can't reach: a ringing call's non-winning/never-
   * bound tabs (ws/hub.ts finding #2 — the callee's OTHER ringing tabs on a winning accept; BOTH
   * parties' ringing tabs on a decline/cancel/disconnect, incl. the decline itself, registry.ts
   * finding #1, since a ringing callee connection is never bound in the first place). */
  deliverToUser: (sub: string, payload: unknown) => void;
  /** Injected clock (ms since epoch) — pure + testable, same instinct as agent/reaper.ts's. */
  now: () => number;
  /** Ringing auto-expiry, ms (§2.1; default 45_000 when omitted). */
  ringingTimeoutMs?: number;
  /** Present only when secchat-mediad is configured (SECCHAT_MEDIAD_URL/_TOKEN) — a
   * consent-granted invite downgrades to p2p when this is unset, and BOTH parties are told
   * recording is unavailable before the callee's consent prompt shows (§2.3's fail-closed-
   * recording / fail-open-calling policy — the downgrade must reach the callee too, v3.1's folded
   * suggestion, since they consented specifically to a recorded call). */
  mediad?: MediadClient;
  /** Present only when SecRecorder is configured (SECCHAT_TRANSCRIBE_URL) — a relayed call that
   * finishes without one still posts its recording, just with a "transcription unavailable" line
   * instead of a transcript (mirrors mediad's fail-closed shape, §2.4's failure-isolation note). */
  transcribe?: TranscribeClient;
  /** governedCallAppend's marking/DLP deps (governance/append.ts's GovernedAppendDeps — `store`
   * above doubles for both, so this bag is a strict superset). */
  marking: MarkingPolicy;
  dlp?: DlpPolicy;
  /** Broadcasts the finished transcript message live into the DM once posted (wired to
   * hub.broadcast — the same "resolved lazily" closure index.ts already uses for every other
   * live-post path, see its header comment). */
  broadcast: (channelId: string, payload: unknown) => void;
  /** OPTIONAL — the shared recordings-volume directory this backend process can read
   * (docs/plans/voice-contracts.md §4 — `<volume-root>/<sessionId>/...`, `SECCHAT_MEDIAD_RECORDINGS_DIR`),
   * the attachments byte store, and the narrow Store write the post-call pipeline's ingest step
   * needs. index.ts's real construction passes all three whenever mediad itself is configured;
   * unset only in a deployment/test that configures mediad without them (or a unit test exercising
   * the signaling path alone) ⇒ a relayed call's recording still gets recorded by mediad and its
   * finalize manifest is still fetched, but the mixed file is never claimed as an attachment
   * (mediad-client.ts's `reconcileUnclaimedSessions` is the eventual backstop for a later restart
   * once these ARE configured) and per-leg transcription can't read the audio at all (both failure
   * points are audited, never thrown — see `runPostCallPipeline`). */
  recordingsDir?: string;
  blobs?: BlobStore;
  addAttachment?: (input: AddAttachmentInput) => Promise<Attachment>;
  /** OPTIONAL — present only when SecRecorder is configured (mirrors `transcribe`'s condition;
   * index.ts constructs this as a thin closure over the same `TranscribeClient` instance, never a
   * second one — see transcribe/client.ts's `enrollVoiceprint`). Backs the solo memo flow's opt-in
   * `enroll:true` path (`runPostCallPipeline`, below) — unset just means enrollment is silently
   * skipped there (same "absence = feature unavailable, never a hard error" posture as `mediad`/
   * `transcribe`). */
  enrollVoiceprint?: (input: { name: string; filePath: string }) => Promise<void>;
  /** OPTIONAL — present whenever SecRouter is configured for the assistant path (index.ts wires the
   * SAME `LlmClient` instance the assistant uses, never a second one — matches `enrollVoiceprint`'s
   * "one instance" reasoning). Backs the post-call transcript SUMMARY step (`runPostCallPipeline`,
   * below): unset just means summarization is silently skipped there (same "absence = feature
   * unavailable, never a hard error" posture as `mediad`/`transcribe`/`enrollVoiceprint`). */
  llm?: LlmClient;
  /** Model id for the summary call (mirrors the assistant path's `config.assistantModel` — index.ts
   * passes the SAME value). Defaults to `"auto"` when `llm` is wired but this isn't. */
  summaryModel?: string;
  /** OPTIONAL — delay (ms) between a call_media toggle's OWN-leg renegotiation and the "renegotiate
   * every OTHER leg" follow-up pass (`setParticipantMedia`'s renegotiation orchestration, below).
   * mediad only fans a newly-admitted inbound video track out to the OTHER legs' PCs once that
   * track's RTP actually starts arriving — which lands shortly AFTER the sender's own-leg answer
   * completes, not at the moment the offer/answer round trip finishes — so firing the other-legs
   * pass too early frequently finds nothing new to surface yet (mediad never pushes; secchat has to
   * ask). Defaults to 750ms. Tests override this (typically 0) together with `scheduleDelayed` so
   * they don't sleep. */
  mediaRenegotiateDelayMs?: number;
  /** OPTIONAL — schedule injection for `mediaRenegotiateDelayMs` above (defaults to real
   * `setTimeout`) — pure + injected, same instinct as `now`. Tests substitute a synchronous
   * `(fn) => fn()` to avoid a real sleep while still exercising the coalescing logic. */
  scheduleDelayed?: (fn: () => void, delayMs: number) => void;
}

/** CallRegistry's live view of one call — the ringing/active bookkeeping that exists only while
 * the call is live. A `CallRow` (src/types.ts) is the DURABLE record, created once this reaches
 * `active` (see CallRow's doc comment — a ringing call that's declined/missed/glare-lost never
 * gets one). The `mediad*`/`leg*` fields are internal bookkeeping for the relayed-mode broker path
 * and the post-call pipeline; callers besides this module should treat them as read-only. */
export interface LiveCall {
  channelId: Id;
  caller: string;
  callee: string;
  state: "ringing" | "active";
  wantRecording: boolean;
  /** The bound connection ids (§2.1's connection-scoped routing) — set once each side is pinned. */
  callerConnId: string;
  calleeConnId?: string;
  mode?: CallMode; // fixed once accepted; unset while ringing
  consent?: boolean; // fixed once accepted; unset while ringing
  /** A solo self-DM voice memo (one participant, one leg) rather than a 2-party call. Set by
   * `startSolo`; it goes straight to `active` (no ring/accept/glare), records a single leg, and the
   * post-call pipeline transcribes just that leg. `callee` equals `caller` for a solo call. */
  solo?: boolean;
  /** Opt-in voiceprint enrollment for a solo memo (§ solo self-DM voice memos) — set by `startSolo`
   * from the `call_solo_start` frame's `enroll` field (default false), read by `end()` when it kicks
   * off the post-call pipeline. Meaningless (never read) for a non-solo call. */
  enroll?: boolean;
  callId?: Id; // the durable CallRow's id, once created at accept
  /** `deps.now()` value at which an unanswered ring auto-expires (§2.1) — set at invite, cleared
   * (irrelevant) once accepted. */
  ringingDeadlineMs?: number;
  /** Set once a relayed call's mediad session is created (at accept, §2.3). */
  mediadSessionId?: string;
  /** mediad leg-correlation ids (backend-side routing labels, NOT client credentials — §2.3/§11) —
   * set alongside `mediadSessionId`. Always the fixed `LEG_CALLER_ID`/`LEG_CALLEE_ID` constants
   * (never random) — see their own doc comment for why. */
  legCaller?: string;
  legCallee?: string;
  /** The recording state last pushed to both bound connections (truthful ● REC, §2.3/finding #7) —
   * `undefined` until the first successful `syncRecordingState` check, so that first check always
   * broadcasts even if mediad's actual state happens to already be `"none"` (the client's initial
   * assumption). Never set for a p2p call (mediad is never involved). */
  recordingKnown?: CallRecordingState;
  /** 1:1 (non-group, non-solo) calls only — the caller's/callee's last-signaled camera/screen state
   * (types.ts's `CallMediaState`, set by `setParticipantMedia`). Unlike the group path's
   * `participants` map, a 1:1 `LiveCall` has no natural per-side bag to hang this on, so it lives
   * directly here. `undefined` until that side's first `call_media` frame — treated as the all-off
   * default (never sent to a client directly; a 1:1 call has no `call_roster` to carry it, only the
   * live `call_media` relay itself). EPHEMERAL, same as the group path's fields — never persisted. */
  callerMedia?: CallMediaState;
  calleeMedia?: CallMediaState;

  // ── Group calls (N participants, `kind:"human"` channel, join-on-demand) ───────────────────────
  /** True for a group call started via `startGroup`/joined via `joinGroup`, as opposed to a 1:1 DM
   * call (`invite`/`accept`) or a solo self-DM memo (`startSolo`). When set, `caller`/`callee`/
   * `callerConnId`/`calleeConnId`/`legCaller`/`legCallee` above are VESTIGIAL (mirrors `startSolo`'s
   * `callee = caller` convention — `caller` is whoever started the call, `callee` equals `caller`,
   * `callerConnId` is the starter's connection) — `participants` below is the actual source of truth
   * for who's on the call, their bound connection, and their mediad leg id. Always `mode: "relayed"`/
   * `consent: true` (no p2p mesh for a group call). */
  group?: boolean;
  /** GROUP calls only — the live participant set, keyed by sub (one entry per participant currently
   * on the call; a participant who left has their entry removed here but survives as a
   * `call_participants` row with `leftAt` stamped, for the post-call pipeline). Each participant's
   * mediad leg id is `groupLegId(sub)` (`leg_<sub>`, calls/leg-ids.ts) — NOT the DM/solo path's fixed
   * LEG_CALLER_ID/LEG_CALLEE_ID constants, since a group call has more than two possible legs.
   * `cameraOn`/`screenOn`/`*TrackId` (types.ts's `CallMediaState`) are EPHEMERAL signaling state set
   * by `setParticipantMedia` — never persisted to the store (no durable record, no migration; a
   * fresh join always starts camera/screen off, matching `CallParticipantJoinedFrame`'s doc
   * comment). */
  participants?: Map<string, { connId: string; legId: string; joinedAt: number } & CallMediaState>;
}

export interface CallRegistry {
  /** caller -> invite: validates DM membership + single-flight, audits `call.start`. Resolves the
   * DM's other member as the callee internally (the `call_invite` WIRE frame carries no explicit
   * callee, voice-contracts.md §1.2 — only `channelId`/`wantRecording`); the CALLER fanning the
   * resulting invite out to every one of the callee's live connections is the caller's job (hub.ts
   * has the multi-connection-per-sub visibility this module deliberately doesn't — see
   * `SendToConnection`'s doc comment). Throws {@link CallSignalError} on a validation/policy
   * rejection (not a member, channel isn't a DM, already busy, glare loss). */
  invite(input: { channelId: Id; callerConnId: string; caller: string; wantRecording: boolean }): Promise<LiveCall>;

  /** Solo self-DM voice memo: the caller records THEMSELVES in a DM whose only user member is
   * them. Unlike `invite`/`accept`, there is no peer to ring and no consent to negotiate (you're
   * recording yourself) — this goes straight to an `active`, `relayed`, single-leg call bound to
   * `connId`, then the client offers its one leg via the normal `call_sdp` relay path and hangs up
   * via `call_end`, at which point the standard post-call pipeline transcribes the single leg into
   * the DM. Requires mediad (there is no p2p fallback — a memo with no server-side recording is
   * pointless); throws {@link CallSignalError} if mediad is unavailable, the channel isn't a
   * self-DM, or a call is already active there. `enroll` (default false) is the opt-in voiceprint
   * enrollment flag: when true AND transcription succeeds, the post-call pipeline enrolls the
   * caller's voiceprint from this memo's own audio (`runPostCallPipeline`) — never blocks or
   * fails the memo itself if enrollment isn't configured or errors. */
  startSolo(input: { channelId: Id; connId: string; sub: string; wantRecording: boolean; enroll?: boolean }): Promise<LiveCall>;

  /** callee -> accept: the FIRST call against a given ringing call wins (pinned to `connId`);
   * later calls resolve `"taken"` so the caller sends `CallTakenFrame` back down that connection.
   * `"not_ringing"` covers a stale/expired/already-resolved invite. A win creates the durable
   * `CallRow` (mode fixed by `consent`, per D3/D4 — downgraded to p2p if `consent` is true but
   * mediad is unset/unhealthy, §2.3), audits `call.consent.granted` or `call.consent.declined`, and
   * sends the fixed-mode confirmation to BOTH bound connections (the caller per
   * voice-contracts.md's table, and the callee's own winning connection too — needed so IT can
   * detect a consent->p2p downgrade, since only the server knows mediad was unavailable). */
  accept(input: { channelId: Id; connId: string; consent: boolean }): Promise<LiveCall | "taken" | "not_ringing">;

  /** Relay one `call_sdp`/`call_candidate` frame from `fromConnId` to the call's OTHER bound
   * connection (p2p mode) or broker it against secchat-mediad (relayed mode, `call_sdp` offers
   * only — anything else, including any `call_candidate`, is silently dropped per
   * voice-contracts.md §1.2's non-trickle relayed exchange). A frame from a connection not bound to
   * this call is dropped, never forwarded. Size/rate/candidate caps on the payload are ws/hub.ts's
   * job (§2.1) — this method assumes an already-bounded `frame`. */
  relay(input: { channelId: Id; fromConnId: string; frame: unknown }): Promise<void>;

  /** Either side hangs up, the ringing timeout fires (see `checkRingingTimeouts`), or a bound
   * connection drops (`untrackConnection`) — ends the live call, notifies the OTHER bound
   * connection (`byDisconnect` set for the disconnect path), stamps `endedAt` on the durable row
   * (if one was created), audits `call.end`, and — for a relayed call that reached `active` — kicks
   * off the post-call pipeline (fire-and-forget; see the file header). A `connId` that isn't bound
   * to this call's channel is ignored UNLESS it's the callee declining a still-RINGING call — the
   * callee's ringing tabs are never bound (only the caller's inviting connection is, §2.1), so a
   * decline is recognized by `sub` instead (finding #1; the hub passes `conn.sub` through). Every
   * ringing-call end (decline, cancel, disconnect) fans a dismissal frame out to BOTH parties' every
   * live connection via `deliverToUser` (finding #2), since none of a ringing callee's tabs are
   * bound and a bound-connection-only `send` structurally can't reach them. */
  end(input: { channelId: Id; connId?: string; sub?: string; reason: "hangup" | "timeout" | "disconnect" }): Promise<void>;

  /** ws/hub.ts's `untrackConnection` hook (§2.1): tears down any call bound to `connId` — an
   * active call losing its only connection on that side, or a ringing call losing its caller
   * connection. No-op if `connId` isn't bound to anything live (this includes every one of the
   * callee's non-winning ringing tabs — they were never bound in the first place). */
  untrackConnection(connId: string): void;

  /** The live call for a channel, if any (ringing or active) — backs the "no active call" check
   * `invite` needs and a reconnecting client's state read (see http/server.ts's `GET /calls/:id`). */
  getActiveCall(channelId: Id): LiveCall | undefined;

  // ── Group calls (N participants, `kind:"human"` channel, join-on-demand) ───────────────────────

  /** A member -> server: start a group call on a `kind:"human"` channel (channel membership
   * required). Relayed-only (no p2p mesh, D5's p2p path is DM-only) — fails LOUD if mediad is
   * unavailable (`recording_unavailable`), the same "no live conversation to keep alive without it"
   * posture as `startSolo`, not the 1:1 DM path's fail-open-calling downgrade. Rejected
   * (`call_active`) if the channel already has a live call — a member should `joinGroup` it instead.
   * Posts a content-free "call started — tap to join" system chat line (mirrors the missed-call /
   * declined-call notices) and creates the durable `CallRow` immediately (`caller`/`callee` both the
   * starter's sub — vestigial, see `LiveCall.group`'s doc comment). Throws {@link CallSignalError} on
   * a validation/policy rejection. */
  startGroup(input: { channelId: Id; connId: string; sub: string }): Promise<LiveCall>;

  /** A member -> server: join an already-live group call. Adds a leg (MediadClient.addLeg), sends
   * the joiner a `call_roster` snapshot, fans a `call_participant_joined` out to every OTHER bound
   * participant connection, and kicks off server-orchestrated renegotiation
   * (MediadClient.renegotiate -> a server-sent `call_sdp` offer -> the participant's `call_sdp`
   * answer, relayed back via `relay()` -> MediadClient.answerLeg) for every OTHER live leg so their
   * downstream picks up the new participant's track. Throws {@link CallSignalError} if there's no
   * live group call in this channel, the caller isn't a member, they're already on the call, or
   * they're busy in another call. */
  joinGroup(input: { channelId: Id; connId: string; sub: string }): Promise<LiveCall>;

  /** A participant -> server: their camera/screen on-off (and/or track id) state changed
   * (types.ts's `CallMediaFrame`/`CallMediaState`). Group calls AND 1:1 (DM) calls, p2p or relayed
   * — a solo self-DM memo is the only call shape this ignores (no peer to relay to). Validates
   * `sub` is bound to `connId` as a LIVE party of the LIVE call in `channelId` (a group call's
   * `participants` map, or a 1:1 call's `caller`/`callerConnId`/`callee`/`calleeConnId`); anything
   * else (no live call, still ringing, a solo call, an unknown/unbound sub) is silently dropped —
   * same "unbound sender -> never forwarded" posture as `relay()`, not a client-facing error (this
   * is routine state, not a request that can fail). On success, updates this party's EPHEMERAL
   * state (never persisted — no durable record) and relays a `call_media` broadcast frame to the
   * OTHER bound party/parties — every other participant for a group call, the one peer for a 1:1
   * call — never echoed back to the sender. For a RELAYED call (group, or a 1:1 call accepted with
   * `consent:true`) whose fields actually CHANGED vs. the previous state (a duplicate/no-op frame
   * triggers no renegotiation), also kicks off mediad renegotiation: the sender's OWN leg
   * immediately, then — after `CallRegistryDeps.mediaRenegotiateDelayMs` — every OTHER live leg, so
   * mediad's newly fanned-out track surfaces to them too (coalesced: rapid toggles on the same call
   * never stack more than one queued follow-up pass). A p2p 1:1 call makes NO mediad calls (no
   * session exists) — the relayed broadcast frame alone is enough; the peer's client renegotiates
   * directly, as it already does for any p2p track change. */
  setParticipantMedia(input: { channelId: Id; connId: string; sub: string } & CallMediaState): void;

  /** A participant -> server: leave a group call they're on. A thin wrapper over `end()`'s group
   * branch (LEAVE when other participants remain: drop the leg, fan `call_participant_left` out,
   * MediadClient.removeLeg, renegotiate the rest; LAST-OUT when they're the last one: tear the whole
   * call down and run the post-call pipeline) — exposed as its own method for callers (ws/hub.ts's
   * `call_end` handling on a group channel) that want the group-specific name rather than reaching
   * for the shared `end()` entry point directly. No-op if the caller isn't currently on this
   * channel's live call. */
  leaveGroup(input: { channelId: Id; connId: string; sub: string }): Promise<void>;

  /** Sweeps every ringing call whose deadline has passed: ends it, audits `call.missed`, posts the
   * `call_missed` chat line into the DM (a plain, content-free system message — no DLP scan needed,
   * matches the plan's "a normal governed chat message" framing without needing governedCallAppend's
   * machine-author path, which is for the TRANSCRIPT specifically), and returns the channels that
   * just missed so the caller can push the LIVE `call_missed` WS signal to both members' every
   * connection (again hub.ts's multi-connection fan-out job, not this module's — see `invite`'s doc
   * comment for why). Meant to be driven on an interval by ws/hub.ts (mirrors agent/reaper.ts's
   * `startReaper` shape: the pure sweep lives here, the `setInterval` lives with its caller). */
  checkRingingTimeouts(): Promise<Array<{ channelId: Id; caller: string; callee: string }>>;
}

export function makeCallRegistry(deps: CallRegistryDeps): CallRegistry {
  const ringingTimeoutMs = deps.ringingTimeoutMs ?? 45_000;
  const mediaRenegotiateDelayMs = deps.mediaRenegotiateDelayMs ?? 750;
  const scheduleDelayed = deps.scheduleDelayed ?? ((fn: () => void, delayMs: number) => void setTimeout(fn, delayMs));

  const liveCalls = new Map<Id, LiveCall>(); // channelId -> the one live call for that DM
  const connToChannel = new Map<string, Id>(); // bound connId -> its channelId (relay/teardown lookup)
  const busyBySub = new Map<string, Id>(); // sub -> the channelId they're ringing/active in
  // channelId -> the call_media "renegotiate every OTHER leg" pass's coalescing state (see
  // `requestOtherLegsRenegotiation`'s doc comment) — a call's entry is left behind (harmlessly
  // inert) once the call ends rather than explicitly cleaned up, matching this module's existing
  // "no cleanup needed, the channelId key just goes cold" posture for per-call bookkeeping maps.
  const mediaRenego = new Map<Id, { scheduled: boolean; inFlight: boolean; pending: boolean; exceptSub: string }>();

  /** Remove all bookkeeping for a live call. Does NOT touch the durable store — callers decide
   * separately whether/what to persist (a ringing call never got a row; an active one already has
   * one updated by the time this runs). */
  function teardown(channelId: Id): void {
    const live = liveCalls.get(channelId);
    if (!live) return;
    liveCalls.delete(channelId);
    if (live.group) {
      // Group calls: `caller`/`callee` are vestigial (see LiveCall.group's doc comment) and MUST
      // NOT be used to clear busyBySub/connToChannel here — `endGroupParticipant` already cleared
      // every real participant's entry as they left, one at a time, well before this (LAST-OUT-only)
      // call runs. Blindly deleting by `live.caller`/`live.callee` (the starter's sub) would be
      // WRONG once the starter has already left this call and since started a DIFFERENT one
      // elsewhere: their busyBySub entry would then belong to that other call, and this delete would
      // incorrectly free them as "not busy" out from under it.
      return;
    }
    connToChannel.delete(live.callerConnId);
    if (live.calleeConnId) connToChannel.delete(live.calleeConnId);
    busyBySub.delete(live.caller);
    busyBySub.delete(live.callee);
  }

  /** This registry's slice of `PendingRecordingDeps` (calls/pending-recording.ts) — shared with
   * mediad-client.ts's `reconcileUnclaimedSessions` crash-recovery sweep so BOTH the live and
   * reconciled paths claim a recording attachment onto a chat line with identical sequencing (v3.1
   * REQUIRED "the artifact is never invisible" — see that module's header for why this is shared,
   * not duplicated). */
  const pendingRecordingDeps: PendingRecordingDeps = { store: deps.store, marking: deps.marking, broadcast: deps.broadcast };

  /** The marking a plain, content-free system chat line (the missed-call notice) should carry: the
   * DM's own marking when set (channel-as-portion, same rule the message-post route and
   * governedAgentAppend both use), else the policy floor. No DLP scan needed — there is no free
   * text here, just a fixed notice string. */
  async function resolveChannelMarking(channelId: Id): Promise<string> {
    return sharedResolveChannelMarking(pendingRecordingDeps, channelId);
  }

  async function invite(input: { channelId: Id; callerConnId: string; caller: string; wantRecording: boolean }): Promise<LiveCall> {
    const { channelId, callerConnId, caller, wantRecording } = input;

    const channel = await deps.store.getChannel(channelId);
    if (!channel || channel.kind !== "dm") throw new CallSignalError("not_dm", "calls are DM-only (D5)");
    const members = (await deps.store.listMembers(channelId)).filter((m) => m.memberType === "user").map((m) => m.memberRef);
    if (!members.includes(caller)) throw new CallSignalError("not_member", "you are not a member of this DM");
    if (members.length !== 2) throw new CallSignalError("invalid_dm", "a DM call needs exactly two user members");
    const callee = members.find((m) => m !== caller)!;

    const existing = liveCalls.get(channelId);
    if (existing) {
      // Glare: the existing ringing call's callee is the one now inviting (a symmetric cross-call).
      // Deterministic tiebreak — lower `sub` wins (§2.1) — rather than a hard single-flight reject.
      const isGlare = existing.state === "ringing" && existing.caller === callee && existing.callee === caller;
      if (!isGlare) throw new CallSignalError("call_active", "a call is already active for this channel");
      if (caller >= existing.caller) {
        throw new CallSignalError("glare_lost", "the other party is already calling you — accept their invite instead");
      }
      // The new inviter has the lower sub: they win. Supersede the existing ringing call silently
      // (no `call.missed`/audit noise — it's resolved by a symmetric invite, not abandoned; the old
      // caller's tabs will receive THIS invite as the new callee moments later via the normal
      // call_invite fan-out, so their UI transitions cleanly from "calling" to "being called").
      teardown(channelId);
    } else {
      const callerBusy = busyBySub.get(caller);
      if (callerBusy && callerBusy !== channelId) throw new CallSignalError("user_busy", "you're already in a call");
      const calleeBusy = busyBySub.get(callee);
      if (calleeBusy && calleeBusy !== channelId) throw new CallSignalError("user_busy", "the other user is already in a call");
    }

    const live: LiveCall = {
      channelId,
      caller,
      callee,
      state: "ringing",
      wantRecording,
      callerConnId,
      ringingDeadlineMs: deps.now() + ringingTimeoutMs,
    };
    liveCalls.set(channelId, live);
    connToChannel.set(callerConnId, channelId);
    busyBySub.set(caller, channelId);
    busyBySub.set(callee, channelId);

    await deps.store.appendAudit({ actor: caller, action: "call.start", target: channelId });
    return live;
  }

  async function startSolo(input: { channelId: Id; connId: string; sub: string; wantRecording: boolean; enroll?: boolean }): Promise<LiveCall> {
    const { channelId, connId, sub, wantRecording, enroll } = input;

    const channel = await deps.store.getChannel(channelId);
    if (!channel || channel.kind !== "dm") throw new CallSignalError("not_dm", "solo recording is DM-only");
    const members = (await deps.store.listMembers(channelId)).filter((m) => m.memberType === "user").map((m) => m.memberRef);
    if (!members.includes(sub)) throw new CallSignalError("not_member", "you are not a member of this DM");
    // Guard against a solo record in a 2-party DM — that's a normal call. Solo is only for a
    // self-DM (the single user member is you).
    if (members.some((m) => m !== sub)) throw new CallSignalError("not_self_dm", "solo recording is only for a self-DM");

    if (liveCalls.get(channelId)) throw new CallSignalError("call_active", "a recording is already active for this channel");
    const busy = busyBySub.get(sub);
    if (busy && busy !== channelId) throw new CallSignalError("user_busy", "you're already in a call");

    // No p2p fallback: a memo with no server-side recording records nothing, so fail loud rather
    // than silently downgrade the way a 2-party call does (§2.3's fail-open-CALLING doesn't apply —
    // there's no live conversation to keep alive, only a recording that either happens or doesn't).
    if (!deps.mediad) throw new CallSignalError("recording_unavailable", "server-side recording is not configured");
    const healthy = await deps.mediad.health().catch(() => false);
    if (!healthy) throw new CallSignalError("recording_unavailable", "the recording service is unavailable");
    let session: { sessionId: string };
    try {
      session = await deps.mediad.createSession({ callId: channelId, legs: [{ legId: LEG_CALLER_ID, sub }] });
    } catch (err) {
      throw new CallSignalError("recording_unavailable", `could not start a recording session: ${describeError(err)}`);
    }

    const live: LiveCall = {
      channelId,
      caller: sub,
      callee: sub, // self — a solo memo is a call with one party
      state: "active",
      wantRecording,
      solo: true,
      enroll: enroll === true,
      mode: "relayed",
      consent: true,
      callerConnId: connId,
      mediadSessionId: session.sessionId,
      legCaller: LEG_CALLER_ID,
    };
    liveCalls.set(channelId, live);
    connToChannel.set(connId, channelId);
    busyBySub.set(sub, channelId);

    const row = await deps.store.createCall({ channelId, caller: sub, callee: sub, consent: true, mode: "relayed" });
    live.callId = row.id;
    try {
      await deps.store.setCallMediadSessionId(row.id, session.sessionId);
    } catch (err) {
      console.error(`calls/registry: setCallMediadSessionId failed for solo call ${row.id}:`, describeError(err));
    }
    try {
      await deps.store.addCallParticipant({ callId: row.id, sub, legId: LEG_CALLER_ID });
    } catch (err) {
      console.error(`calls/registry: addCallParticipant failed for solo call ${row.id}:`, describeError(err));
    }
    await deps.store.appendAudit({ actor: sub, action: "call.start", target: channelId, detail: "solo" });
    return live;
  }

  async function accept(input: { channelId: Id; connId: string; consent: boolean }): Promise<LiveCall | "taken" | "not_ringing"> {
    const { channelId, connId, consent } = input;
    const live = liveCalls.get(channelId);
    if (!live) return "not_ringing"; // nothing live for this channel at all — stale/expired/never invited
    if (live.state !== "ringing") return "taken"; // already resolved (won by a different tab, or this one racing itself)

    // Claim the win SYNCHRONOUSLY (before any await) so a second accept() racing this one — even
    // for the same channel — observes state "active" and returns "taken" rather than winning too.
    // Node's single-threaded event loop makes this atomic: nothing else can run between this line
    // and the read of `live.state` above.
    live.state = "active";
    live.calleeConnId = connId;
    live.consent = consent;
    connToChannel.set(connId, channelId);

    let mode: CallMode = consent ? "relayed" : "p2p";
    let legCaller: string | undefined;
    let legCallee: string | undefined;
    let mediadSessionId: string | undefined;
    if (consent && deps.mediad) {
      try {
        const healthy = await deps.mediad.health();
        if (!healthy) throw new Error("mediad reported unhealthy");
        const session = await deps.mediad.createSession({
          callId: channelId, // correlation only — see mediad-client.ts's header for why this isn't the durable CallRow id
          legs: [
            { legId: LEG_CALLER_ID, sub: live.caller },
            { legId: LEG_CALLEE_ID, sub: live.callee },
          ],
        });
        legCaller = LEG_CALLER_ID;
        legCallee = LEG_CALLEE_ID;
        mediadSessionId = session.sessionId;
      } catch {
        // Fail-closed recording, fail-open calling (§2.3): mediad unreachable/unhealthy/erroring
        // downgrades the call to p2p rather than failing the whole accept.
        mode = "p2p";
        legCaller = undefined;
        legCallee = undefined;
      }
    } else if (consent && !deps.mediad) {
      mode = "p2p"; // recording was never configured for this deployment
    }
    live.mode = mode;
    live.mediadSessionId = mediadSessionId;
    live.legCaller = legCaller;
    live.legCallee = legCallee;

    const row = await deps.store.createCall({ channelId, caller: live.caller, callee: live.callee, consent, mode });
    live.callId = row.id;
    if (mediadSessionId) {
      // §2.4 v3.1 REQUIRED #5: persisted the MOMENT it's known (well before the call ever ends) so
      // a crash-recovery sweep can always match an ended-but-unclaimed row back to its on-disk
      // session directory — see CallRow.mediadSessionId's doc comment. Never blocks the accept on
      // failure (logged, not thrown): the live pipeline still works from in-memory `live` either
      // way; only the crash-recovery backstop would be degraded.
      try {
        await deps.store.setCallMediadSessionId(row.id, mediadSessionId);
      } catch (err) {
        console.error(`calls/registry: setCallMediadSessionId failed for call ${row.id}:`, describeError(err));
      }
      // Generalizes the leg->sub map (db/migrations/0021_call_participants.sql) that crash-recovery
      // reconciliation and the post-call pipeline read instead of the fixed caller/callee pair —
      // never blocks accept() on failure, same posture as setCallMediadSessionId above.
      try {
        await deps.store.addCallParticipant({ callId: row.id, sub: live.caller, legId: legCaller! });
        await deps.store.addCallParticipant({ callId: row.id, sub: live.callee, legId: legCallee! });
      } catch (err) {
        console.error(`calls/registry: addCallParticipant failed for call ${row.id}:`, describeError(err));
      }
    }
    await deps.store.appendAudit({
      actor: live.callee,
      action: consent ? "call.consent.granted" : "call.consent.declined",
      target: row.id,
    });

    // Caller's bound connection: mode is now fixed (voice-contracts.md §1.2's documented frame).
    deps.send(live.callerConnId, { type: "call_accept", channelId, consent, mode });
    // The callee's OWN winning connection also gets this (beyond what the contracts doc tabulates)
    // — required so a consent:true->mode:"p2p" downgrade reaches the party who asked for recording;
    // only the server knows mediad was unavailable (§2.3 v3.1's "surfaced to both parties" REQUIRED
    // item — the client can't infer this from anything it already knows).
    deps.send(connId, { type: "call_accept", channelId, consent, mode });

    // Dismiss every OTHER live connection of the callee's (ws/hub.ts finding #2): a tab that's
    // simply sitting on the ring screen and never itself calls `accept()` never races into the
    // hub's own "taken" branch (which only fires for a SECOND accept() call) — deliverToUser is the
    // only way to reach it. This also reaches the WINNING connection (`connId`) itself, since
    // deliverToUser fans to every live connection of a sub with no exclusion primitive; harmless —
    // call_controller.dart's `_onTaken` only tears down a call that isn't yet accept-confirmed, so
    // the winner (already past that point by the time this arrives) safely ignores it.
    deps.deliverToUser(live.callee, { type: "call_taken", channelId });

    return live;
  }

  // ── Group calls (N participants, `kind:"human"` channel, join-on-demand) ───────────────────────

  async function startGroup(input: { channelId: Id; connId: string; sub: string }): Promise<LiveCall> {
    const { channelId, connId, sub } = input;

    const channel = await deps.store.getChannel(channelId);
    if (!channel || channel.kind !== "human") throw new CallSignalError("not_group_channel", "group calls are for channels only");
    const members = (await deps.store.listMembers(channelId)).filter((m) => m.memberType === "user").map((m) => m.memberRef);
    if (!members.includes(sub)) throw new CallSignalError("not_member", "you are not a member of this channel");

    if (liveCalls.get(channelId)) throw new CallSignalError("call_active", "a call is already active in this channel — join it instead");
    const busy = busyBySub.get(sub);
    if (busy && busy !== channelId) throw new CallSignalError("user_busy", "you're already in a call");

    // Relayed-only, fail LOUD (no p2p mesh, no fail-open-calling downgrade) — same "no live
    // conversation to keep alive without it" reasoning as `startSolo`.
    if (!deps.mediad) throw new CallSignalError("recording_unavailable", "server-side calling is not configured");
    const healthy = await deps.mediad.health().catch(() => false);
    if (!healthy) throw new CallSignalError("recording_unavailable", "the calling service is unavailable");

    const legId = groupLegId(sub);
    let session: { sessionId: string };
    try {
      session = await deps.mediad.createSession({ callId: channelId, legs: [{ legId, sub }] });
    } catch (err) {
      throw new CallSignalError("recording_unavailable", `could not start a call session: ${describeError(err)}`);
    }

    const live: LiveCall = {
      channelId,
      caller: sub, // vestigial — see LiveCall.group's doc comment
      callee: sub,
      state: "active",
      wantRecording: true,
      group: true,
      mode: "relayed",
      consent: true,
      callerConnId: connId,
      mediadSessionId: session.sessionId,
      participants: new Map([[sub, { connId, legId, joinedAt: deps.now(), cameraOn: false, screenOn: false }]]),
    };
    liveCalls.set(channelId, live);
    connToChannel.set(connId, channelId);
    busyBySub.set(sub, channelId);

    const row = await deps.store.createCall({ channelId, caller: sub, callee: sub, consent: true, mode: "relayed" });
    live.callId = row.id;
    try {
      await deps.store.setCallMediadSessionId(row.id, session.sessionId);
    } catch (err) {
      console.error(`calls/registry: setCallMediadSessionId failed for group call ${row.id}:`, describeError(err));
    }
    try {
      await deps.store.addCallParticipant({ callId: row.id, sub, legId });
    } catch (err) {
      console.error(`calls/registry: addCallParticipant failed for group call ${row.id}:`, describeError(err));
    }

    await deps.store.appendAudit({ actor: sub, action: "call.start", target: channelId, detail: "group" });

    // "call started — tap to join" — a content-free system chat line, same posture as the
    // missed-call/declined-call notices (no DLP scan needed, fixed text).
    const marking = await resolveChannelMarking(channelId);
    const content = "📞 Call started — tap to join.";
    const posted = await deps.store.appendMessage({ channelId, authorRef: "system", authorType: "system", content, marking });
    deps.broadcast(channelId, { type: "message", message: { ...posted, content } });

    return live;
  }

  async function joinGroup(input: { channelId: Id; connId: string; sub: string }): Promise<LiveCall> {
    const { channelId, connId, sub } = input;
    const live = liveCalls.get(channelId);
    if (!live || !live.group || live.state !== "active") throw new CallSignalError("not_active", "no active call to join in this channel");
    const participants = live.participants!;

    const members = (await deps.store.listMembers(channelId)).filter((m) => m.memberType === "user").map((m) => m.memberRef);
    if (!members.includes(sub)) throw new CallSignalError("not_member", "you are not a member of this channel");
    if (participants.has(sub)) throw new CallSignalError("already_in_call", "you are already on this call");
    const busy = busyBySub.get(sub);
    if (busy && busy !== channelId) throw new CallSignalError("user_busy", "you're already in a call");
    if (!deps.mediad || !live.mediadSessionId) throw new CallSignalError("recording_unavailable", "the calling service is unavailable");

    const legId = groupLegId(sub);
    try {
      await deps.mediad.addLeg(live.mediadSessionId, { legId, sub });
    } catch (err) {
      throw new CallSignalError("join_failed", `could not add you to the call: ${describeError(err)}`);
    }

    participants.set(sub, { connId, legId, joinedAt: deps.now(), cameraOn: false, screenOn: false });
    connToChannel.set(connId, channelId);
    busyBySub.set(sub, channelId);

    if (live.callId) {
      try {
        await deps.store.addCallParticipant({ callId: live.callId, sub, legId });
      } catch (err) {
        console.error(`calls/registry: addCallParticipant failed for call ${live.callId}:`, describeError(err));
      }
    }
    await deps.store.appendAudit({ actor: sub, action: "call.participant_joined", target: live.callId ?? channelId });

    // Roster snapshot to the joiner (everyone currently on the call, including themselves) — each
    // entry carries that participant's CURRENT media state so the joiner renders existing
    // camera/screen tiles without a second round trip (types.ts's `CallRosterFrame` doc comment).
    deps.send(connId, {
      type: "call_roster",
      channelId,
      participants: [...participants.entries()].map(([s, p]) => ({
        sub: s,
        cameraOn: p.cameraOn,
        screenOn: p.screenOn,
        ...(p.cameraTrackId !== undefined ? { cameraTrackId: p.cameraTrackId } : {}),
        ...(p.screenTrackId !== undefined ? { screenTrackId: p.screenTrackId } : {}),
      })),
    });

    // Announce the join to every OTHER bound participant connection.
    const joinedFrame = { type: "call_participant_joined", channelId, sub };
    for (const [otherSub, p] of participants) {
      if (otherSub !== sub) deps.send(p.connId, joinedFrame);
    }

    // Server-orchestrated renegotiation: every OTHER live leg gets a fresh mediad offer so its
    // downstream picks up the new participant's track. The corresponding answer arrives later via a
    // normal `call_sdp` frame from that connection, handled by `relayGroup`'s "answer" branch.
    void renegotiateOthers(live, sub).catch((err) => {
      console.error(`calls/registry: renegotiation after join failed for call ${live.callId}:`, describeError(err));
    });

    return live;
  }

  /** `call_media` (types.ts's `CallMediaFrame`): a party's camera/screen on-off (and/or track id)
   * state changed. Group AND 1:1 calls (p2p or relayed) — only a solo self-DM memo is ignored (no
   * peer, nothing to relay to). Silently dropped — never throws — unless `sub` is a LIVE party of
   * the LIVE call in `channelId` AND is currently bound to `connId` (the same "unbound/spoofed
   * sender -> never forwarded" posture as `relay()`): covers a solo call, no live call, still
   * ringing, an unknown sub, and a sub sending from a connection that isn't the one it's bound to
   * (stale tab, race with a leave/hangup). State is EPHEMERAL (never persisted — no store write, no
   * audit, routine signaling not worth a durable record): the group path's `LiveCall.participants`
   * entries, or the 1:1 path's `LiveCall.callerMedia`/`calleeMedia`. On a genuine state CHANGE (not
   * a duplicate/no-op resend) for a RELAYED call, also kicks off mediad renegotiation —
   * `triggerCallMediaRenegotiation`'s doc comment has the sender-leg-then-others orchestration. */
  function setParticipantMedia(input: { channelId: Id; connId: string; sub: string } & CallMediaState): void {
    const { channelId, connId, sub, cameraOn, screenOn, cameraTrackId, screenTrackId } = input;
    const live = liveCalls.get(channelId);
    if (!live || live.state !== "active" || live.solo) return; // no live call, still ringing, or a solo memo — ignore

    const next: CallMediaState = { cameraOn, screenOn, cameraTrackId, screenTrackId };

    if (live.group) {
      if (!live.participants) return;
      const p = live.participants.get(sub);
      if (!p || p.connId !== connId) return; // unbound/unknown/spoofed sender — drop, never trust

      const changed = mediaStateChanged(p, next);
      p.cameraOn = cameraOn;
      p.screenOn = screenOn;
      p.cameraTrackId = cameraTrackId;
      p.screenTrackId = screenTrackId;

      const frame = mediaBroadcastFrame(channelId, sub, next);
      for (const [otherSub, op] of live.participants) {
        if (otherSub !== sub) deps.send(op.connId, frame);
      }
      if (changed) triggerCallMediaRenegotiation(live, sub, p.legId, p.connId);
      return;
    }

    // 1:1 (non-group, non-solo) call — validate the sender is a BOUND party. `live.state ===
    // "active"` above already rules out a still-ringing call, where the callee side is never bound
    // (§2.1 finding #1) — so a plain connId match against callerConnId/calleeConnId is sufficient
    // here, unlike `end()`'s ringing-decline special case.
    let selfKey: "callerMedia" | "calleeMedia";
    let selfLegId: string | undefined;
    let peerConnId: string | undefined;
    if (sub === live.caller && connId === live.callerConnId) {
      selfKey = "callerMedia";
      selfLegId = live.legCaller;
      peerConnId = live.calleeConnId;
    } else if (sub === live.callee && live.calleeConnId != null && connId === live.calleeConnId) {
      selfKey = "calleeMedia";
      selfLegId = live.legCallee;
      peerConnId = live.callerConnId;
    } else {
      return; // not a bound party of this call — drop, never trust an unbound/spoofed sender
    }

    const changed = mediaStateChanged(live[selfKey] ?? DEFAULT_MEDIA_STATE, next);
    live[selfKey] = next;

    if (peerConnId) deps.send(peerConnId, mediaBroadcastFrame(channelId, sub, next));

    // p2p: no mediad session exists at all — the relayed frame above is the whole signal; the peer's
    // client renegotiates directly, the same reaction it already has for any p2p track change
    // (onRenegotiationNeeded). Relayed: same sender-leg-then-others orchestration as a group call.
    if (changed && live.mode === "relayed" && selfLegId && peerConnId) {
      triggerCallMediaRenegotiation(live, sub, selfLegId, connId);
    }
  }

  /** Renegotiate exactly ONE leg: ask mediad for a fresh offer and push it to that leg's bound
   * connection as a server-initiated `call_sdp` offer. The shared per-leg mechanics behind both
   * `renegotiateOthers`' fan-out and a call_media toggle's own-leg step
   * (`triggerCallMediaRenegotiation`) — never throws (logged, not thrown), same posture as every
   * other post-accept mediad call. The matching answer, once the client sends it, is brokered back
   * to mediad by `relayGroup`'s (group) or `relay`'s (1:1 relayed) "answer" branch — this function
   * only sends the offer half. */
  async function renegotiateLeg(live: LiveCall, legId: string, connId: string): Promise<void> {
    if (!deps.mediad || !live.mediadSessionId) return;
    try {
      const offer = await deps.mediad.renegotiate(live.mediadSessionId, legId);
      deps.send(connId, { type: "call_sdp", channelId: live.channelId, sdpType: "offer", sdp: offer.sdp });
    } catch (err) {
      console.error(`calls/registry: renegotiate leg ${legId} failed for call ${live.callId}:`, describeError(err));
    }
  }

  /** Ask mediad for a fresh offer for every OTHER live leg on this call (group OR 1:1 relayed)
   * besides `exceptSub`, and push each via `renegotiateLeg` — fire-and-forget per leg, one leg's
   * failure never blocks the others. Used both for a group join's "everyone else picks up the new
   * participant's track" fan-out (§ Group calls' renegotiation orchestration) and, via
   * `requestOtherLegsRenegotiation`'s delayed/coalesced call below, a call_media toggle's "surface
   * mediad's newly fanned-out track to everyone else" pass. */
  async function renegotiateOthers(live: LiveCall, exceptSub: string): Promise<void> {
    if (!deps.mediad || !live.mediadSessionId) return;
    for (const leg of liveCallLegs(live)) {
      if (leg.sub === exceptSub) continue;
      await renegotiateLeg(live, leg.legId, leg.connId);
    }
  }

  /** Schedules `renegotiateOthers` (the "surface mediad's fanned-out track to everyone else" pass)
   * `deps.mediaRenegotiateDelayMs` after a call_media toggle's own-leg renegotiation — see
   * `triggerCallMediaRenegotiation`'s doc comment for the race this delay accounts for. Rapid
   * toggles on the SAME call never stack more than one timer: a toggle that lands while a pass is
   * merely QUEUED (not yet fired) is a no-op besides refreshing `exceptSub` — the queued pass
   * recomputes the live leg set when it actually runs, so it already picks up the newer state; a
   * toggle that lands while a pass is ACTIVELY RUNNING (mid-`await` against mediad, so this run's
   * leg list is already fixed) sets `pending` to queue exactly ONE follow-up for right after it
   * finishes. Either way `exceptSub` always tracks the MOST RECENT toggle's sender, so whichever
   * pass runs next excludes whoever toggled last, not a stale sender from several toggles ago. */
  function requestOtherLegsRenegotiation(live: LiveCall, exceptSub: string): void {
    const channelId = live.channelId;
    let state = mediaRenego.get(channelId);
    if (!state) {
      state = { scheduled: false, inFlight: false, pending: false, exceptSub };
      mediaRenego.set(channelId, state);
    }
    state.exceptSub = exceptSub;
    if (state.scheduled) return; // already queued, not yet fired — it'll pick up this latest state when it does
    if (state.inFlight) {
      state.pending = true; // currently executing — queue exactly one follow-up for right after
      return;
    }
    state.scheduled = true;
    scheduleDelayed(() => {
      state!.scheduled = false;
      // A stale pass for a call that's since ended (or been superseded by a fresh call on the same
      // channel — media state is ephemeral per call) is skipped, not run against dead/wrong state;
      // the toggle that lost this race self-heals on the call's next real renegotiation (a
      // join/leave/another toggle) — matches `renegotiateOthers`'/`renegotiateLeg`'s "never fatal,
      // logged not thrown" posture for the same underlying race mediad's push-less design creates.
      if (liveCalls.get(channelId) !== live || live.state !== "active") {
        state!.pending = false;
        return;
      }
      state!.inFlight = true;
      void renegotiateOthers(live, state!.exceptSub)
        .catch((err) => {
          console.error(`calls/registry: call_media other-legs renegotiation failed for call ${live.callId}:`, describeError(err));
        })
        .finally(() => {
          state!.inFlight = false;
          if (state!.pending) {
            state!.pending = false;
            requestOtherLegsRenegotiation(live, state!.exceptSub);
          }
        });
    }, mediaRenegotiateDelayMs);
  }

  /** After a call_media state CHANGE on a RELAYED call (group or 1:1 relayed — a p2p 1:1 call never
   * reaches here, `setParticipantMedia` already filtered it out since it has no mediad session at
   * all), renegotiate the SENDER's own leg immediately, then schedule the "every OTHER leg" pass
   * (`requestOtherLegsRenegotiation`) once its offer/answer round trip completes. The delay before
   * that follow-up pass exists because mediad never pushes: it only fans a newly-admitted inbound
   * video track out to the OTHER legs' PCs once that track's RTP actually starts arriving, which
   * lands shortly AFTER the sender's answer completes — not at the moment the offer/answer exchange
   * itself finishes — so firing the other-legs pass immediately would frequently find nothing new to
   * surface yet. A toggle that loses this race anyway self-heals on the call's next renegotiation. */
  function triggerCallMediaRenegotiation(live: LiveCall, senderSub: string, senderLegId: string, senderConnId: string): void {
    if (!deps.mediad || !live.mediadSessionId) return;
    void renegotiateLeg(live, senderLegId, senderConnId).then(() => {
      requestOtherLegsRenegotiation(live, senderSub);
    });
  }

  /** `relay()`'s group branch: relayed-only (no candidate trickling, no p2p — same as a 1:1 relayed
   * call), but `call_sdp` is now genuinely bidirectional per-leg (see types.ts's `CallSdpFrame` doc
   * comment) — an "offer" from a participant is their OWN leg's initial offer (brokered exactly like
   * a 1:1 relayed call's offer); an "answer" is their response to a SERVER-initiated renegotiation
   * offer (`renegotiateOthers`, above), brokered back to mediad via `answerLeg`. */
  async function relayGroup(live: LiveCall, fromConnId: string, frame: unknown): Promise<void> {
    if (!live.participants || !deps.mediad || !live.mediadSessionId) return;
    let fromSub: string | undefined;
    let fromLegId: string | undefined;
    for (const [sub, p] of live.participants) {
      if (p.connId === fromConnId) {
        fromSub = sub;
        fromLegId = p.legId;
        break;
      }
    }
    if (!fromSub || !fromLegId) return; // unbound connection for this call — drop, never forward

    const f = frame as { type?: unknown; sdpType?: unknown; sdp?: unknown };
    if (f.type !== "call_sdp" || typeof f.sdp !== "string") return; // no candidate trickling for group

    if (f.sdpType === "offer") {
      try {
        const answer = await deps.mediad.offerLeg(live.mediadSessionId, fromLegId, f.sdp);
        deps.send(fromConnId, { type: "call_sdp", channelId: live.channelId, sdpType: "answer", sdp: answer.sdp });
      } catch (err) {
        deps.send(fromConnId, { type: "call_error", channelId: live.channelId, error: "mediad_broker_failed", detail: describeError(err) });
      }
      return;
    }

    if (f.sdpType === "answer") {
      try {
        await deps.mediad.answerLeg(live.mediadSessionId, fromLegId, f.sdp);
      } catch (err) {
        console.error(`calls/registry: answerLeg failed for call ${live.callId} leg ${fromLegId}:`, describeError(err));
      }
      return;
    }
  }

  /** `end()`'s group branch, shared by an explicit `leaveGroup`/`call_end`, a socket drop
   * (`untrackConnection`), and — indirectly — nothing else (a group call never rings, so there's no
   * "decline"/timeout path here). LEAVE (participants remain): drops the leg, fans
   * `call_participant_left` out, removes the leg from mediad, and renegotiates the rest.
   * LAST-OUT (this was the only participant left): tears down like a 1:1 call ending — stamps
   * `endCall`, audits `call.end`, and runs the post-call pipeline. */
  async function endGroupParticipant(live: LiveCall, sub: string, reason: "hangup" | "timeout" | "disconnect"): Promise<void> {
    const participants = live.participants!;
    const p = participants.get(sub);
    if (!p) return; // not currently on this call — no-op (a race with an already-processed leave)

    participants.delete(sub);
    connToChannel.delete(p.connId);
    busyBySub.delete(sub);

    if (live.callId) {
      try {
        await deps.store.setCallParticipantLeft(live.callId, sub, new Date(deps.now()).toISOString());
      } catch (err) {
        console.error(`calls/registry: setCallParticipantLeft failed for call ${live.callId}:`, describeError(err));
      }
    }
    await deps.store.appendAudit({ actor: sub, action: "call.participant_left", target: live.callId ?? live.channelId, detail: reason });

    if (participants.size === 0) {
      // LAST OUT.
      teardown(live.channelId);
      if (live.callId) await deps.store.endCall(live.callId, new Date(deps.now()).toISOString());
      await deps.store.appendAudit({ actor: sub, action: "call.end", target: live.callId ?? live.channelId, detail: reason });

      if (live.callId && live.mediadSessionId) {
        const callId = live.callId;
        const channelId = live.channelId;
        const mediadSessionId = live.mediadSessionId;
        void runPostCallPipeline({ callId, channelId, mediadSessionId }).catch((err) => {
          console.error(`calls/registry: post-call pipeline failed for group call ${callId}:`, describeError(err));
        });
      }
      return;
    }

    // Others remain: notify them, drop the leg, and renegotiate.
    const dismiss = { type: "call_participant_left", channelId: live.channelId, sub };
    for (const [, rp] of participants) deps.send(rp.connId, dismiss);

    if (deps.mediad && live.mediadSessionId) {
      try {
        await deps.mediad.removeLeg(live.mediadSessionId, p.legId);
      } catch (err) {
        console.error(`calls/registry: removeLeg failed for call ${live.callId} leg ${p.legId}:`, describeError(err));
      }
    }
    void renegotiateOthers(live, sub).catch((err) => {
      console.error(`calls/registry: renegotiation after leave failed for call ${live.callId}:`, describeError(err));
    });
  }

  async function leaveGroup(input: { channelId: Id; connId: string; sub: string }): Promise<void> {
    await end({ channelId: input.channelId, connId: input.connId, sub: input.sub, reason: "hangup" });
  }

  async function relay(input: { channelId: Id; fromConnId: string; frame: unknown }): Promise<void> {
    const { channelId, fromConnId, frame } = input;
    const live = liveCalls.get(channelId);
    if (!live || live.state !== "active") return; // no active call, or still ringing — drop

    if (live.group) {
      await relayGroup(live, fromConnId, frame);
      return;
    }

    const isCaller = fromConnId === live.callerConnId;
    const isCallee = live.calleeConnId != null && fromConnId === live.calleeConnId;
    if (!isCaller && !isCallee) return; // unbound connection for this call — drop, never forward

    if (live.mode === "p2p") {
      // Dumb relay: no interpretation, forwarded verbatim (§2.1 — the user-to-user content path
      // outside DLP/marking/chain governance; size/rate caps were already enforced by ws/hub.ts
      // before this was called).
      const otherConnId = isCaller ? live.calleeConnId : live.callerConnId;
      if (otherConnId) deps.send(otherConnId, frame);
      return;
    }

    // Relayed mode: the server TERMINATES this client's SDP (§2.2/§2.3). Any `call_candidate` is
    // still dropped (never legitimate in relayed mode per voice-contracts.md §1.2's non-trickle
    // exchange). An "offer" is this client's own leg's offer (its initial one, brokered via
    // `offerLeg` exactly as before). An "answer" is new (call_media renegotiation, below) — this
    // client's response to a SERVER-initiated renegotiation offer (`renegotiateLeg`, fired by a
    // call_media toggle's own-leg step or the delayed "every other leg" pass) — brokered back to
    // mediad via `answerLeg`, mirroring `relayGroup`'s answer branch so a 1:1 relayed call and a
    // group call share the same server-offer/client-answer mechanics.
    const f = frame as { type?: unknown; sdpType?: unknown; sdp?: unknown };
    if (f.type !== "call_sdp" || typeof f.sdp !== "string") return;
    if (!deps.mediad || !live.mediadSessionId) return;
    const legId = isCaller ? live.legCaller : live.legCallee;
    if (!legId) return;

    if (f.sdpType === "answer") {
      try {
        await deps.mediad.answerLeg(live.mediadSessionId, legId, f.sdp);
      } catch (err) {
        console.error(`calls/registry: answerLeg failed for call ${live.callId} leg ${legId}:`, describeError(err));
      }
      return;
    }
    if (f.sdpType !== "offer") return;

    try {
      const answer = await deps.mediad.offerLeg(live.mediadSessionId, legId, f.sdp);
      deps.send(fromConnId, { type: "call_sdp", channelId, sdpType: "answer", sdp: answer.sdp });
      // Truthful ● REC (§2.3, suggested finding #7): piggyback a recording-state check on this
      // broker round trip rather than run a separate poll loop — a leg finishing its offer/answer
      // exchange is exactly when mediad's writer for that leg is next likely to have started.
      // Fire-and-forget: a failed/delayed check just means the indicator catches up on the OTHER
      // leg's offer instead (or, worst case, never updates for THIS call — no regression from the
      // client-side approximation this replaces).
      void syncRecordingState(live).catch((err) => {
        console.error(`calls/registry: recording-state sync failed for call ${live.callId}:`, describeError(err));
      });
    } catch (err) {
      deps.send(fromConnId, { type: "call_error", channelId, error: "mediad_broker_failed", detail: describeError(err) });
    }
  }

  /** Truthful ● REC (§2.3, suggested finding #7): fetch mediad's ACTUAL writer state and, only if
   * it changed since the last check, mirror it onto the durable row (`Store.setCallRecording`) and
   * push a `call_recording` frame (voice-contracts.md) to both bound connections. Never fatal on
   * failure — the caller logs and moves on, same posture as every other post-accept mediad call. */
  async function syncRecordingState(live: LiveCall): Promise<void> {
    if (!deps.mediad || !live.mediadSessionId) return;
    const state = await deps.mediad.getState(live.mediadSessionId);
    if (state.recording === live.recordingKnown) return; // unchanged — nothing to persist/broadcast
    live.recordingKnown = state.recording;
    if (live.callId) {
      try {
        await deps.store.setCallRecording(live.callId, state.recording);
      } catch (err) {
        console.error(`calls/registry: setCallRecording failed for call ${live.callId}:`, describeError(err));
      }
    }
    const frame = { type: "call_recording", channelId: live.channelId, recording: state.recording };
    deps.send(live.callerConnId, frame);
    if (live.calleeConnId) deps.send(live.calleeConnId, frame);
  }

  async function end(input: { channelId: Id; connId?: string; sub?: string; reason: "hangup" | "timeout" | "disconnect" }): Promise<void> {
    const { channelId, connId, sub, reason } = input;
    const live = liveCalls.get(channelId);
    if (!live) return; // nothing live for this channel — no-op (a race with an already-ended call)

    if (live.group) {
      // Group calls never ring (they go straight to `active`, like a solo memo), so there's no
      // decline/glare shape to recognize here — just resolve WHICH participant is leaving, by
      // `sub` when given (an explicit `leaveGroup`/`call_end`) or by connId (a socket-drop
      // teardown, `untrackConnection`, which only ever passes a connId).
      const resolvedSub = sub ?? (connId ? [...live.participants!.entries()].find(([, p]) => p.connId === connId)?.[0] : undefined);
      if (!resolvedSub) return; // unbound connection / unknown participant — ignore
      await endGroupParticipant(live, resolvedSub, reason);
      return;
    }

    const isBoundCaller = connId != null && connId === live.callerConnId;
    const isBoundCallee = connId != null && live.calleeConnId != null && connId === live.calleeConnId;
    // Finding #1: a ringing call's callee is NEVER bound (only the caller's inviting connection is,
    // and only the FIRST winning `call_accept` binds the callee's — §2.1) — so a decline (`call_end`
    // from one of the callee's still-ringing tabs) always arrives on an unbound connection. Recognize
    // it by `sub` (the hub passes `conn.sub` through) instead of requiring a bound connId that
    // structurally can't exist yet at this state.
    const isRingingDecline = connId != null && live.state === "ringing" && sub === live.callee;
    if (connId && !isBoundCaller && !isBoundCallee && !isRingingDecline) return; // unbound sender — ignore, no spoofed hangups

    const wasRinging = live.state === "ringing";
    const otherConnId = connId ? (isBoundCaller ? live.calleeConnId : live.callerConnId) : undefined;
    const actor = connId ? (isBoundCaller ? live.caller : live.callee) : "system";

    teardown(channelId);

    if (wasRinging) {
      const detail = isRingingDecline ? "declined" : reason;
      await deps.store.appendAudit({ actor, action: "call.end", target: channelId, detail });

      // Finding #2: NEITHER side's ringing tabs are all bound (only the caller's inviting connection
      // is, §2.1's connection-scoped routing) — so whichever side ended this ringing call (a decline
      // from one of the callee's tabs, a cancel from the caller, or the caller's bound connection
      // dropping) fans the dismissal out to BOTH parties' every live connection via `deliverToUser`,
      // not just the one bound connection `send` could reach. Idempotent on the receiving end:
      // call_controller.dart's `_onRemoteEnd` no-ops once already `idle`/`ended`.
      const dismiss = { type: "call_end", channelId, ...(reason === "disconnect" ? { byDisconnect: true } : {}) };
      deps.deliverToUser(live.caller, dismiss);
      deps.deliverToUser(live.callee, dismiss);

      if (isRingingDecline) {
        // A decline is content-free system text (like the missed-call line below) — no
        // governedCallAppend/DLP needed, same reasoning as `checkRingingTimeouts`'s missed-call post.
        const marking = await resolveChannelMarking(channelId);
        const content = "☎️ Call declined";
        const posted = await deps.store.appendMessage({ channelId, authorRef: "system", authorType: "system", content, marking });
        deps.broadcast(channelId, { type: "message", message: { ...posted, content } });
      }
      return;
    }

    if (otherConnId) {
      deps.send(otherConnId, { type: "call_end", channelId, ...(reason === "disconnect" ? { byDisconnect: true } : {}) });
    }

    if (!live.callId) return; // shouldn't happen once active (accept() always creates the row first)
    await deps.store.endCall(live.callId, new Date(deps.now()).toISOString());
    await deps.store.appendAudit({ actor, action: "call.end", target: live.callId, detail: reason });

    if (live.mode === "relayed" && live.mediadSessionId) {
      // Fire-and-forget: the §2.4 post-call pipeline is asynchronous by design (voice-contracts.md
      // §1.2 — "the client sees the transcript arrive later as a normal message broadcast").
      void runPostCallPipeline({
        callId: live.callId,
        channelId: live.channelId,
        mediadSessionId: live.mediadSessionId,
        enroll: live.enroll,
      }).catch((err) => {
        console.error(`calls/registry: post-call pipeline failed for call ${live.callId}:`, describeError(err));
      });
    }
  }

  function untrackConnection(connId: string): void {
    const channelId = connToChannel.get(connId);
    if (!channelId) return; // not bound to anything live — most commonly a non-winning ringing tab
    void end({ channelId, connId, reason: "disconnect" }).catch((err) => {
      console.error(`calls/registry: untrackConnection teardown failed for connection ${connId}:`, describeError(err));
    });
  }

  function getActiveCall(channelId: Id): LiveCall | undefined {
    return liveCalls.get(channelId);
  }

  async function checkRingingTimeouts(): Promise<Array<{ channelId: Id; caller: string; callee: string }>> {
    const now = deps.now();
    const expired: Array<{ channelId: Id; caller: string; callee: string }> = [];
    for (const [channelId, live] of liveCalls) {
      if (live.state !== "ringing") continue;
      if (live.ringingDeadlineMs == null || live.ringingDeadlineMs > now) continue;
      expired.push({ channelId, caller: live.caller, callee: live.callee });
    }
    for (const missed of expired) {
      teardown(missed.channelId);
      await deps.store.appendAudit({ actor: "system", action: "call.missed", target: missed.channelId });
      const marking = await resolveChannelMarking(missed.channelId);
      const content = "☎️ Missed call";
      const posted = await deps.store.appendMessage({
        channelId: missed.channelId,
        authorRef: "system",
        authorType: "system",
        content,
        marking,
      });
      deps.broadcast(missed.channelId, { type: "message", message: { ...posted, content } });
    }
    return expired;
  }

  /** The minimal shape the post-call pipeline needs, so it can run from either an in-memory
   * `LiveCall` (the live path, right after `end()`) or a bare `CallRow` read back from the store
   * (mediad-client.ts's `reconcileUnclaimedSessions`, after a backend crash — §2.4 v3.1 REQUIRED
   * #5). `LiveCall` is a structural superset of this, so it's passed as-is from `end()` with no
   * extra mapping. Deliberately carries NO caller/callee/solo fields — every leg this pipeline needs
   * (1:1, solo, OR group) comes from `Store.listCallParticipants(call.callId)`
   * (db/migrations/0021_call_participants.sql) instead, generalizing this to an arbitrary
   * N-participant call rather than a hardcoded pair. */
  interface PostCallInput {
    callId: Id;
    channelId: Id;
    mediadSessionId: string;
    /** Solo-memo-only opt-in voiceprint enrollment flag — see `LiveCall.enroll`'s doc comment.
     * Applied below only when the call turns out to have had exactly one participant (true for a
     * solo memo by construction; a group/1:1 call never sets this field in the first place, so the
     * "exactly one participant" check alone would never misfire for them either). */
    enroll?: boolean;
  }

  /** Server-side attachment ingest (sha256 -> BlobStore.write -> Store.addAttachment, uploadedBy =
   * "system", §2.4/A5) for a session's mixed playback file. Requires `recordingsDir`/`blobs`/
   * `addAttachment` all configured on `deps` — see CallRegistryDeps' doc comments. Returns the new
   * (still UNCLAIMED) attachment row — the caller claims it immediately onto a pending-status chat
   * line, below, rather than leaving it unclaimed until (if ever) a transcript posts. */
  async function ingestMixedFile(call: PostCallInput, participants: CallParticipantRow[], manifest: MediadFinalizeManifest): Promise<Attachment | undefined> {
    if (!deps.recordingsDir || !deps.blobs || !deps.addAttachment) return undefined;
    // The mixed playback file (legId absent). For a single-participant call (a solo memo, or a
    // group call that happened to end back down to one participant), if mediad's mix step didn't
    // emit one (e.g. ffmpeg amix declined a single input), fall back to that sole participant's
    // per-leg file so the recording still gets a playable attachment.
    const mixed = manifest.files.find((f) => !f.legId)
      ?? (participants.length === 1 ? manifest.files.find((f) => f.legId === participants[0]!.legId) : undefined);
    if (!mixed) return undefined;
    const bytes = await readFile(join(deps.recordingsDir, call.mediadSessionId, mixed.path));
    const sha256 = sha256Hex(bytes);
    await deps.blobs.write(sha256, bytes);
    const marking = await resolveChannelMarking(call.channelId);
    return deps.addAttachment({
      channelId: call.channelId,
      uploadedBy: "system",
      filename: mixed.path,
      contentType: mixed.path.endsWith(".ogg") ? "audio/ogg" : mixed.path.endsWith(".m4a") ? "audio/mp4" : "application/octet-stream",
      byteSize: bytes.length,
      sha256,
      marking,
    });
  }

  // ── §2.4 post-call pipeline (relayed calls only) ──────────────────────────────────────────────
  // mediad.endSession -> attachment ingest -> claim onto a pending-status line (v3.1 REQUIRED
  // failure-isolation fix, see calls/pending-recording.ts's `postPendingRecordingMessage` doc
  // comment — shared with mediad-client.ts's reconciliation sweep) -> transcribeClient.
  // transcribeLeg x2 -> mergeTranscripts -> governedCallAppend -> broadcast, editing the pending
  // line to its final state at every exit. Every failure point is caught and audited
  // (`call.recording_failed`/`call.transcribe_failed`) rather than thrown past `end()`'s own
  // `.catch()` — §2.4's failure-isolation posture ("poison audio => visible failure line, never
  // silent" / v3.1's "the artifact is never invisible"). Unlike the audit trail (which stays the
  // system-of-record for WHY), the pending line is now a genuine user-visible chat line throughout
  // — no step here needs to route a failure through governedCallAppend/DLP, because the line is
  // fixed system text (like `checkRingingTimeouts`'s missed-call notice), not derived from anything
  // spoken on the call.
  async function runPostCallPipeline(call: PostCallInput): Promise<void> {
    if (!deps.mediad) return;

    // The leg->sub map for every participant this call ever had (join order; includes anyone who
    // left mid-call — their leg's audio still exists in the finalize manifest below).
    const participants = await deps.store.listCallParticipants(call.callId);

    let manifest: MediadFinalizeManifest;
    try {
      manifest = await deps.mediad.endSession(call.mediadSessionId);
    } catch (err) {
      await deps.store.appendAudit({ actor: "system", action: "call.recording_failed", target: call.callId, detail: describeError(err) });
      return;
    }

    let attachment: Attachment | undefined;
    try {
      attachment = await ingestMixedFile(call, participants, manifest);
    } catch (err) {
      // The finalize manifest still exists on the shared volume even if THIS ingest attempt failed
      // (e.g. a transient blob-write error) — mediad-client.ts's reconciliation sweep is the
      // backstop, not a reason to abort the rest of this pipeline (transcription can still run,
      // though with no attachment to claim there's nothing for a pending line to point at yet).
      console.error(`calls/registry: attachment ingest failed for call ${call.callId}:`, describeError(err));
    }
    if (attachment) await deps.store.setCallRecordingAttachment(call.callId, attachment.id);
    await deps.store.appendAudit({
      actor: "system",
      action: "call.recording_stored",
      target: call.callId,
      detail: manifest.truncated ? "truncated" : undefined,
    });

    // Claim the attachment onto a visible chat line RIGHT NOW — before transcription is even
    // attempted — so it's never sitting unclaimed (v3.1 REQUIRED: "the artifact is never
    // invisible"). Its own failure is logged, not escalated: the recording is still safely stored
    // and still recoverable via mediad-client.ts's reconciliation sweep even if this particular
    // claim attempt fails.
    let pendingMessageId: Id | undefined;
    if (attachment) {
      const pendingText = deps.transcribe
        ? "🎙️ Recording stored — transcription pending."
        : "🎙️ Recording stored — transcription unavailable.";
      try {
        pendingMessageId = await sharedPostPendingRecordingMessage(pendingRecordingDeps, call, attachment, pendingText);
      } catch (err) {
        console.error(`calls/registry: pending-recording message failed for call ${call.callId}:`, describeError(err));
      }
    }

    if (!deps.transcribe) return; // SecRecorder not configured — the pending line already says "unavailable"

    // The legs to transcribe: every participant this call ever had (1:1's caller+callee, solo's
    // sole leg, or a group call's N legs — all uniformly from `call_participants` now).
    const legFiles = participants.map((p) => ({ legId: p.legId, sub: p.sub, file: manifest.files.find((f) => f.legId === p.legId) }));
    if (legFiles.length === 0 || legFiles.some((l) => !l.file)) {
      await deps.store.appendAudit({ actor: "system", action: "call.transcribe_failed", target: call.callId, detail: "manifest missing a leg file" });
      await editPendingIfClaimed(call, pendingMessageId, "🎙️ Recording stored — transcription failed (missing leg audio).");
      return;
    }
    // transcribeLeg reads bytes off disk itself (transcribe/client.ts's `postOnce`) — it needs an
    // actually-readable path, not the manifest's session-relative one; requires `recordingsDir`
    // (same wiring gap as ingestMixedFile above).
    if (!deps.recordingsDir) {
      await deps.store.appendAudit({ actor: "system", action: "call.transcribe_failed", target: call.callId, detail: "recordingsDir not configured" });
      await editPendingIfClaimed(call, pendingMessageId, "🎙️ Recording stored — transcription unavailable.");
      return;
    }
    const recordingsDir = deps.recordingsDir; // hoisted past the guard above so it stays narrowed non-undefined below
    const transcribe = deps.transcribe; // ditto — checked non-null at the top of this block
    const sessionDir = join(recordingsDir, call.mediadSessionId);

    try {
      const results = await Promise.all(
        // identify:true — match each leg's speaker against SecRecorder's enrolled-voiceprint
        // registry (transcribe/client.ts's `TranscribeSpeaker`) so a solo-memo enrollment gets
        // matched on a LATER call's transcript. Independent of per-leg identity (A7) / `diarize`
        // (unset here, as before) — this is purely about the identify=true match, not attribution.
        legFiles.map((l) => transcribe.transcribeLeg({ legId: l.legId, filePath: join(sessionDir, l.file!.path), identify: true })),
      );
      const users = await Promise.all(legFiles.map((l) => deps.store.getUser(l.sub)));
      const legs: LegTranscript[] = legFiles.map((l, i) => ({
        speaker: users[i]?.displayName || l.sub,
        startOffsetMs: l.file!.startOffsetMs,
        result: results[i]!,
      }));
      const turns: MergedTurn[] = mergeTranscripts(legs);
      const row = await deps.store.getCall(call.callId);
      const header: TranscriptHeaderInput = {
        callDurationMs: row?.startedAt && row.endedAt ? Date.parse(row.endedAt) - Date.parse(row.startedAt) : 0,
        recordedDurationMs: manifest.files.find((f) => !f.legId)?.durationMs ?? 0,
        truncated: manifest.truncated,
      };
      const body = formatTranscript(header, turns);

      // attachmentIds: [] — the recording was already claimed onto the pending line above;
      // re-claiming it here would fail governedCallAppend's `invalid_attachment` check (a claimed
      // attachment can't be claimed twice). The transcript posts as its own message, exactly as
      // before (CallRow.transcriptMessageId still means what its doc comment says).
      const posted = await governedCallAppend(
        { store: deps.store, marking: deps.marking, dlp: deps.dlp },
        { channelId: call.channelId, content: body, attachmentIds: [] },
      );
      await deps.store.setCallTranscriptMessage(call.callId, posted.id);
      deps.broadcast(call.channelId, { type: "message", message: posted });
      // NOTE: governedCallAppend already audits `call.transcribed` itself (governance/append.ts) —
      // not duplicated here.

      // Best-effort LLM summary of the transcript we just posted — its OWN governed system
      // message, right after the transcript (§ Feature 1). No audio involved (it's over the
      // merged TEXT, `body`), so unlike enrollment below it has no ordering dependency on
      // `deleteSessionDir`. Own try/catch: a summarization failure must never crash the pipeline
      // or take the transcript down with it (which has already posted by this point either way).
      if (deps.llm) {
        try {
          // Attributed to a call PARTICIPANT (the starter, first in join order for 1:1/solo/group
          // alike — `Store.addCallParticipant`'s call order in `accept`/`startSolo`/`startGroup`)
          // via actingUser, so SecRouter governs/budgets/audits this as a real user's call, never
          // as SecChat's own service identity (secrouter/client.ts's X-Sec-Acting-User contract).
          const summarizingSub = participants[0]?.sub;
          if (!summarizingSub) throw new Error("no call participant to attribute the summary to");
          // Classification = the TRANSCRIPT message's own effective marking (the exact content
          // being summarized) — forwarded so SecRouter's clearance/data-residency egress gate
          // evaluates this call at the right level instead of its deployment default (mirrors
          // assistant/service.ts's `classification` derivation).
          const classification = parseMarking(deps.marking, posted.marking)?.level;
          const stream = deps.llm.complete({
            model: deps.summaryModel ?? "auto",
            messages: [
              { role: "system", content: "Summarize this call transcript concisely; do not add information not present." },
              { role: "user", content: body },
            ],
            actingUser: summarizingSub,
            classification,
          });
          let summaryText = "";
          for await (const delta of stream) summaryText += delta;
          summaryText = summaryText.trim();
          if (!summaryText) throw new Error("summarizer produced no output");

          const summaryPosted = await governedCallAppend(
            { store: deps.store, marking: deps.marking, dlp: deps.dlp },
            { channelId: call.channelId, content: `📝 Summary\n\n${summaryText}`, attachmentIds: [] },
          );
          deps.broadcast(call.channelId, { type: "message", message: summaryPosted });
          await deps.store.appendAudit({ actor: "system", action: "call.summarized", target: call.callId });
        } catch (err) {
          await deps.store.appendAudit({ actor: "system", action: "call.summarize_failed", target: call.callId, detail: describeError(err) });
        }
      }

      await editPendingIfClaimed(call, pendingMessageId, "🎙️ Recording stored.");

      // Opt-in voiceprint enrollment (solo memos only, `enroll:true` — a solo memo always has
      // EXACTLY one participant by construction, so that's the guard, rather than a `solo` flag on
      // `call` which no longer exists): best-effort, same failure-isolation posture as the rest of
      // this pipeline — an enrollment failure must never crash the pipeline or take the transcript
      // down with it (the transcript has already posted by this point either way). MUST run before
      // `deleteSessionDir` below — that's what deletes the very leg file this reads.
      if (call.enroll && participants.length === 1 && deps.enrollVoiceprint) {
        try {
          // `users[0]`/`legFiles[0]` are always the sole participant's — reuses the lookup already
          // done for the transcript's speaker labels rather than a second `store.getUser` call.
          const soloName = users[0]?.displayName || legFiles[0]!.sub;
          await deps.enrollVoiceprint({ name: soloName, filePath: join(sessionDir, legFiles[0]!.file!.path) });
          await deps.store.appendAudit({ actor: "system", action: "call.voiceprint_enrolled", target: call.callId });
        } catch (err) {
          await deps.store.appendAudit({ actor: "system", action: "call.voiceprint_enroll_failed", target: call.callId, detail: describeError(err) });
        }
      }

      // Retention (§4/finding #8): "raw per-leg files are deleted after successful transcription" —
      // only reached once the transcript has actually posted; left in place on every earlier
      // return/catch above so a retry/reconciliation sweep always still has raw audio to work with.
      await deleteSessionDir(recordingsDir, call.mediadSessionId);
    } catch (err) {
      await deps.store.appendAudit({ actor: "system", action: "call.transcribe_failed", target: call.callId, detail: describeError(err) });
      await editPendingIfClaimed(call, pendingMessageId, "🎙️ Recording stored — transcription failed.");
    }
  }

  /** `editPendingRecordingMessage`, tolerant of `pendingMessageId` being unset (the initial claim
   * attempt itself failed, already logged there) — the common early-return shape every exit path in
   * `runPostCallPipeline` needs, without repeating the `if (pendingMessageId) try { } catch { }`
   * three times over. Delegates to calls/pending-recording.ts's shared implementation (also used by
   * mediad-client.ts's reconciliation sweep). */
  async function editPendingIfClaimed(call: { channelId: Id }, pendingMessageId: Id | undefined, content: string): Promise<void> {
    return sharedEditPendingIfClaimed(pendingRecordingDeps, call, pendingMessageId, content);
  }

  return {
    invite,
    startSolo,
    accept,
    relay,
    end,
    untrackConnection,
    getActiveCall,
    checkRingingTimeouts,
    startGroup,
    joinGroup,
    setParticipantMedia,
    leaveGroup,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The implicit state before any `call_media` frame has ever been sent for a side (a 1:1 call's
 * `LiveCall.callerMedia`/`calleeMedia` starts `undefined`, unlike a group call's `participants`
 * entries which are eagerly initialized to this same shape at join time) — camera/screen off, no
 * track ids. Used only to detect whether a party's FIRST-ever `call_media` frame is itself a
 * genuine change (it isn't, if it just restates this default). */
const DEFAULT_MEDIA_STATE: CallMediaState = { cameraOn: false, screenOn: false };

/** Whether `a` and `b` (types.ts's `CallMediaState`) differ in any field — the "was this call_media
 * frame a genuine change, or a duplicate/no-op resend" check `setParticipantMedia` uses to decide
 * whether a renegotiation is even worth kicking off. */
function mediaStateChanged(a: CallMediaState, b: CallMediaState): boolean {
  return a.cameraOn !== b.cameraOn || a.screenOn !== b.screenOn || a.cameraTrackId !== b.cameraTrackId || a.screenTrackId !== b.screenTrackId;
}

/** Builds the `call_media` broadcast frame (types.ts's `CallMediaBroadcastFrame`) for `sub`'s
 * current `state` — track-id fields are omitted entirely (not sent as `undefined`) when unset,
 * matching `call_roster`'s per-participant shape. Shared by `setParticipantMedia`'s group and 1:1
 * branches. */
function mediaBroadcastFrame(channelId: Id, sub: string, state: CallMediaState) {
  return {
    type: "call_media",
    channelId,
    sub,
    cameraOn: state.cameraOn,
    screenOn: state.screenOn,
    ...(state.cameraTrackId !== undefined ? { cameraTrackId: state.cameraTrackId } : {}),
    ...(state.screenTrackId !== undefined ? { screenTrackId: state.screenTrackId } : {}),
  };
}

/** Every LIVE leg of a call — group OR 1:1 RELAYED — as `{sub, legId, connId}`, the shared shape
 * `renegotiateOthers`' fan-out iterates over regardless of call shape. A group call's legs come
 * from `LiveCall.participants`; a 1:1 relayed call's are its fixed `legCaller`/`legCallee` (set
 * alongside `mediadSessionId` at accept — see `LiveCall`'s doc comment). Returns `[]` for a p2p or
 * solo call — a p2p call has no mediad session to renegotiate at all, and a solo call's single leg
 * never needs an "every OTHER leg" pass (there IS no other leg). */
function liveCallLegs(live: LiveCall): Array<{ sub: string; legId: string; connId: string }> {
  if (live.group) {
    if (!live.participants) return [];
    return [...live.participants.entries()].map(([sub, p]) => ({ sub, legId: p.legId, connId: p.connId }));
  }
  if (live.solo || live.mode !== "relayed") return [];
  const legs: Array<{ sub: string; legId: string; connId: string }> = [];
  if (live.legCaller) legs.push({ sub: live.caller, legId: live.legCaller, connId: live.callerConnId });
  if (live.legCallee && live.calleeConnId) legs.push({ sub: live.callee, legId: live.legCallee, connId: live.calleeConnId });
  return legs;
}

/** Retention (§4/finding #8 — "raw per-leg files are deleted after successful transcription"):
 * removes an entire session directory under the shared recordings volume. Path-constrained to
 * `<recordingsDir>/<sessionId>` and NOTHING else — `sessionId` is server-minted (mediad's own
 * `POST /sessions` response) and never attacker-controlled, but voice-contracts.md §4 says treat it
 * as untrusted anyway, so a value that isn't a bare path segment (no `/`, no `..`) is rejected
 * before it ever reaches a filesystem call rather than trusted to `join()`'s normalization. Never
 * thrown past its caller — a failed cleanup just leaves the raw files on disk a bit longer, not a
 * correctness problem (the artifacts of record, the mixed attachment + transcript, are unaffected
 * either way). */
async function deleteSessionDir(recordingsDir: string, sessionId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    console.error(`calls/registry: refusing to delete session dir for a malformed session id: ${JSON.stringify(sessionId)}`);
    return;
  }
  try {
    await rm(join(recordingsDir, sessionId), { recursive: true, force: true });
  } catch (err) {
    console.error(`calls/registry: deleting session dir for ${sessionId} failed:`, describeError(err));
  }
}
