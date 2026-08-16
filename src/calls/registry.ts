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
import type { AddAttachmentInput, Attachment, CallMode, CallRecordingState, Id, Store } from "../types.ts";
import { LEG_CALLEE_ID, LEG_CALLER_ID } from "./leg-ids.ts";

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
   * self-DM, or a call is already active there. */
  startSolo(input: { channelId: Id; connId: string; sub: string; wantRecording: boolean }): Promise<LiveCall>;

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

  const liveCalls = new Map<Id, LiveCall>(); // channelId -> the one live call for that DM
  const connToChannel = new Map<string, Id>(); // bound connId -> its channelId (relay/teardown lookup)
  const busyBySub = new Map<string, Id>(); // sub -> the channelId they're ringing/active in

  /** Remove all bookkeeping for a live call. Does NOT touch the durable store — callers decide
   * separately whether/what to persist (a ringing call never got a row; an active one already has
   * one updated by the time this runs). */
  function teardown(channelId: Id): void {
    const live = liveCalls.get(channelId);
    if (!live) return;
    liveCalls.delete(channelId);
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

  async function startSolo(input: { channelId: Id; connId: string; sub: string; wantRecording: boolean }): Promise<LiveCall> {
    const { channelId, connId, sub, wantRecording } = input;

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

  async function relay(input: { channelId: Id; fromConnId: string; frame: unknown }): Promise<void> {
    const { channelId, fromConnId, frame } = input;
    const live = liveCalls.get(channelId);
    if (!live || live.state !== "active") return; // no active call, or still ringing — drop

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

    // Relayed mode: the server TERMINATES this client's SDP (§2.2) — only a `call_sdp` OFFER gets
    // brokered against mediad; anything else (an "answer", or any `call_candidate` — never
    // legitimate in relayed mode per voice-contracts.md §1.2's non-trickle exchange) is dropped.
    const f = frame as { type?: unknown; sdpType?: unknown; sdp?: unknown };
    if (f.type !== "call_sdp" || f.sdpType !== "offer" || typeof f.sdp !== "string") return;
    if (!deps.mediad || !live.mediadSessionId) return;
    const legId = isCaller ? live.legCaller : live.legCallee;
    if (!legId) return;
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
        caller: live.caller,
        callee: live.callee,
        mediadSessionId: live.mediadSessionId,
        solo: live.solo,
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
   * extra mapping. */
  interface PostCallInput {
    callId: Id;
    channelId: Id;
    caller: string;
    callee: string;
    mediadSessionId: string;
    /** A solo self-DM memo — one leg (the caller) instead of two. */
    solo?: boolean;
  }

  /** Server-side attachment ingest (sha256 -> BlobStore.write -> Store.addAttachment, uploadedBy =
   * "system", §2.4/A5) for a session's mixed playback file. Requires `recordingsDir`/`blobs`/
   * `addAttachment` all configured on `deps` — see CallRegistryDeps' doc comments. Returns the new
   * (still UNCLAIMED) attachment row — the caller claims it immediately onto a pending-status chat
   * line, below, rather than leaving it unclaimed until (if ever) a transcript posts. */
  async function ingestMixedFile(call: PostCallInput, manifest: MediadFinalizeManifest): Promise<Attachment | undefined> {
    if (!deps.recordingsDir || !deps.blobs || !deps.addAttachment) return undefined;
    // The mixed playback file (legId absent). For a solo memo, if mediad's mix step didn't emit one
    // (e.g. ffmpeg amix declined a single input), fall back to the sole per-leg file so the memo
    // still gets a playable attachment.
    const mixed = manifest.files.find((f) => !f.legId)
      ?? (call.solo ? manifest.files.find((f) => f.legId === LEG_CALLER_ID) : undefined);
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

    let manifest: MediadFinalizeManifest;
    try {
      manifest = await deps.mediad.endSession(call.mediadSessionId);
    } catch (err) {
      await deps.store.appendAudit({ actor: "system", action: "call.recording_failed", target: call.callId, detail: describeError(err) });
      return;
    }

    let attachment: Attachment | undefined;
    try {
      attachment = await ingestMixedFile(call, manifest);
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

    // The legs to transcribe: a solo memo has just the caller's leg; a 2-party call has both.
    const legSpecs = call.solo
      ? [{ legId: LEG_CALLER_ID, sub: call.caller }]
      : [{ legId: LEG_CALLER_ID, sub: call.caller }, { legId: LEG_CALLEE_ID, sub: call.callee }];
    const legFiles = legSpecs.map((l) => ({ ...l, file: manifest.files.find((f) => f.legId === l.legId) }));
    if (legFiles.some((l) => !l.file)) {
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
        legFiles.map((l) => transcribe.transcribeLeg({ legId: l.legId, filePath: join(sessionDir, l.file!.path) })),
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
      await editPendingIfClaimed(call, pendingMessageId, "🎙️ Recording stored.");
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

  return { invite, startSolo, accept, relay, end, untrackConnection, getActiveCall, checkRingingTimeouts };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
