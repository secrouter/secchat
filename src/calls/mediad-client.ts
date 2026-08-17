// MediadClient — the secchat backend's client for secchat-mediad's control API (§2.3/§3.1/§3.2 of
// docs/plans/voice-calls-plan.md; see docs/plans/voice-contracts.md §2 for the exact wire shape
// non-TS agents build against — mediad itself is Go/Pion, a separate component).
//
// Pure HTTP client (createSession/offerLeg/getState/endSession/health) plus the startup
// reconciliation entry point (§2.4 v3.1 REQUIRED #5). Every method is real; mediad itself doesn't
// exist yet (it's a separate Go/Pion component, §3.2) — these HTTP calls are exercised in tests
// against a fake fetchImpl, not a real daemon. Live-infra verification is a P0 exit test
// (`docs/plans/voice-calls-plan.md` §6), not something this file can do.
//
// `reconcileUnclaimedSessions` matches an ended-but-unclaimed `calls` row back to its on-disk
// mediad session directory via `CallRow.mediadSessionId` (db/migrations/0020_calls_mediad_session_id.sql,
// persisted by `calls/registry.ts`'s `accept()` the moment `createSession` succeeds — well before the
// call ever ends) — no guessing, unlike the earlier scaffold that refused to match at all without it.
// Per-leg files are identified by `call_participants` (db/migrations/0021_call_participants.sql —
// see src/types.ts's `CallParticipantRow` doc comment), populated by the live pipeline the moment
// each leg exists (well before the call ever ends), so which finalize-manifest file belongs to which
// participant is always derivable without guessing — generalizes the earlier fixed
// `LEG_CALLER_ID`/`LEG_CALLEE_ID` (calls/leg-ids.ts) + `calls.caller`/`calls.callee` scheme to an
// arbitrary N-participant (group) call; those two constants are still what the 1:1 DM/solo paths
// persist their leg ids as, just no longer the ONLY place this file looks. The re-ingest itself
// reuses `endSession` (idempotent per voice-contracts.md §2.4: "a second DELETE on an already-ended
// session returns the SAME manifest... this is what backs the backend's startup reconciliation
// sweep") rather than reading `manifest.json` off disk by hand.

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex, type BlobStore } from "../attachments/blobs.ts";
import { governedCallAppend } from "../governance/append.ts";
import { formatTranscript, mergeTranscripts, type LegTranscript, type TranscriptHeaderInput } from "../transcribe/merge.ts";
import type { TranscribeClient } from "../transcribe/client.ts";
import type { DlpPolicy } from "../dlp/policy.ts";
import type { MarkingPolicy } from "../marking/policy.ts";
import {
  editPendingIfClaimed,
  postPendingRecordingMessage,
  resolveChannelMarking,
  type PendingRecordingDeps,
} from "./pending-recording.ts";
import type { AddAttachmentInput, Attachment, CallRow, Id, Store } from "../types.ts";

export interface MediadClientDeps {
  /** mediad's control-API base URL (SECCHAT_MEDIAD_URL), compose-internal network only. */
  baseUrl: string;
  /** Shared bearer token (SECCHAT_MEDIAD_TOKEN) — the ONLY auth on the control API; leg-correlation
   * ids (below) are backend-side routing labels, never client-held credentials (§2.3). */
  token: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** The shared recordings-volume directory this backend process can read
   * (docs/plans/voice-contracts.md §4 — `<volume-root>/<sessionId>/...`, `SECCHAT_MEDIAD_RECORDINGS_DIR`).
   * Unset ⇒ `reconcileUnclaimedSessions` logs and no-ops (recording isn't configured for this
   * deployment, so there's never anything on disk to reconcile anyway). */
  recordingsDir?: string;
  /** The attachments byte store, for ingesting a reconciled session's mixed recording. */
  blobs?: BlobStore;
  /** Narrowed to the one Store write reconciliation's ingest step needs, matching this codebase's
   * narrow-injection style (see ws/hub.ts's `channelsForSub` for the same pattern) instead of
   * threading the whole Store through just for this. */
  addAttachment?: (input: AddAttachmentInput) => Promise<Attachment>;
  /** The narrow Store slice reconciliation needs to find candidates and record the ingest result
   * (types.ts's `Store.listUnclaimedEndedCalls` / `Store.setCallRecordingAttachment`). */
  reconcileStore?: {
    listUnclaimedEndedCalls: () => Promise<CallRow[]>;
    setCallRecordingAttachment: (id: Id, attachmentId: Id) => Promise<CallRow>;
  };
  /** OPTIONAL — present whenever the caller wants a reconciled call's recording to actually become
   * VISIBLE in the DM (not just durably stored + linked on the `calls` row): claims the ingested
   * mixed-file attachment onto a fresh system chat line via calls/pending-recording.ts, the SAME
   * shared helper calls/registry.ts's live `runPostCallPipeline` uses (v3.1 REQUIRED "the artifact
   * is never invisible" — `listAttachmentsForMessage` only returns CLAIMED rows, so an ingested-but-
   * unclaimed attachment is otherwise permanently invisible). Unset ⇒ `reconcileOneCall` still
   * ingests + links the attachment (above), but logs that it's left UNCLAIMED — index.ts's real
   * construction always passes this whenever `addAttachment` is configured, so this only degrades a
   * deployment/test that configures mediad+recording without it. NOT gated on `transcription`: a
   * crash can happen BEFORE the live pipeline ever posted a pending line (the primary reconciliation
   * case — mediad finalized but the backend crashed before `runPostCallPipeline`'s ingest step ran),
   * so there's no pending line to reuse and this must post its own regardless of whether a
   * transcript will ever follow. */
  pendingRecording?: PendingRecordingDeps;
  /** OPTIONAL — present only when SecRecorder + the marking/DLP policy + a full Store are ALL
   * configured: kicks per-leg transcription for a reconciled call too, mirroring
   * calls/registry.ts's live post-call pipeline (governedCallAppend + Store.setCallTranscriptMessage
   * + a live broadcast). Unset ⇒ reconciliation still ingests the recording (above); no transcript is
   * produced for a reconciled call (matches the live pipeline's own "SecRecorder not configured"
   * fallback) — the pending line (when `pendingRecording` is configured) is left reading
   * "transcription unavailable". */
  transcription?: {
    store: Store;
    transcribe: TranscribeClient;
    marking: MarkingPolicy;
    dlp?: DlpPolicy;
    /** Live-broadcasts the reconciled transcript into the DM, same as the live pipeline. Unset ⇒
     * the transcript still posts durably; already-connected clients just don't see it until their
     * next reload/resubscribe. */
    broadcast?: (channelId: string, payload: unknown) => void;
  };
}

/** One leg of a session — a backend-side routing label (§2.3's "leg tokens ... clarified as
 * backend-side correlation ids", §11), not a credential. */
export interface MediadLeg {
  legId: string;
  /** The participant this leg belongs to (Principal.sub) — for the finalize manifest's per-file
   * attribution and the reconciliation scan's cross-check against the `calls` row. */
  sub: string;
}

export interface MediadCreateSessionInput {
  callId: Id;
  // One leg per participant: a normal 1:1 call sends [caller, callee]; a solo self-DM voice memo
  // sends a single [caller] leg (mediad records + mixes an N-leg session, N>=1 — see
  // mediad/internal/session/finalize.go). The wire layer passes this straight through.
  legs: MediadLeg[];
}

/** mediad's single-response (non-trickle, §2.2) SDP answer for one leg's offer. */
export interface MediadSdpAnswer {
  legId: string;
  sdp: string;
}

export interface MediadLegState {
  legId: string;
  iceState: string; // Pion ICEConnectionState, passed through as-is
}

export interface MediadSessionState {
  sessionId: string;
  legs: MediadLegState[];
  recording: "none" | "on"; // mediad's ACTUAL writer state — see types.ts's CallRecordingState
}

/** One finalized recording file (§2.3/§2.4's shared-timebase requirement — v3.1 REQUIRED #2). */
export interface MediadFinalizeFile {
  legId?: string; // absent for the mixed playback file
  path: string; // path on the shared recordings volume (relative to the session dir)
  startOffsetMs: number; // this file's offset from the session t0 (0 for the mixed file)
  durationMs: number;
}

export interface MediadFinalizeManifest {
  sessionId: string;
  files: MediadFinalizeFile[]; // per-leg OGG/Opus files + the ffmpeg-mixed playback file
  truncated?: boolean; // set when mediad crashed mid-call (§2.3) — surfaced in the transcript header
}

export interface MediadClient {
  createSession(input: MediadCreateSessionInput): Promise<{ sessionId: string }>;
  /** Group calls only (voice-call plan's group-calling extension): add a new leg to an ALREADY-LIVE
   * session — a participant joining. Wires the leg into the SFU's existing tracks; the caller is
   * still responsible for separately renegotiating every OTHER already-connected leg (below) so
   * their downstream actually picks up the new leg's track. */
  addLeg(sessionId: string, leg: MediadLeg): Promise<void>;
  /** Group calls only: remove a leg from a still-live session — a participant leaving while others
   * remain (as opposed to `endSession`, which tears down the whole session for the LAST leg out). */
  removeLeg(sessionId: string, legId: string): Promise<void>;
  /** Broker one leg's client SDP OFFER to mediad; returns its single-response ANSWER (§2.2's
   * non-trickle exchange — no candidate trickling crosses this client). */
  offerLeg(sessionId: string, legId: string, offerSdp: string): Promise<MediadSdpAnswer>;
  /** Group calls only: ask mediad for a FRESH, SERVER-initiated offer for one already-connected leg
   * (a roster change elsewhere — another leg was added/removed and this leg's downstream tracks need
   * to change). The caller relays this offer to the participant via a server-sent `call_sdp` frame
   * and brokers their answer back through `answerLeg` once it arrives. */
  renegotiate(sessionId: string, legId: string): Promise<{ sdp: string }>;
  /** Group calls only: complete a server-initiated renegotiation — the participant's answer to the
   * offer `renegotiate` produced. */
  answerLeg(sessionId: string, legId: string, answerSdp: string): Promise<void>;
  getState(sessionId: string): Promise<MediadSessionState>;
  /** Ends the session (mediad finalizes: reorder/dedup-buffered OGG close + ffmpeg mix, §2.3) and
   * returns the finalize manifest. Pure HTTP — attachment ingest is the CALLER's job (see
   * calls/registry.ts's post-call pipeline), not this method's; see the file header for why. */
  endSession(sessionId: string): Promise<MediadFinalizeManifest>;
  /** GET /health — the P0 smoke target; also usable as mediad's availability check before offering
   * "call without recording" (§2.3's fail-closed-recording, fail-open-calling policy). */
  health(): Promise<boolean>;
  /** Startup reconciliation (§2.4 v3.1 REQUIRED #5): ended calls with no recording attachment yet
   * (`reconcileStore.listUnclaimedEndedCalls()`, filtered to `mode: "relayed"` rows that have a
   * `mediadSessionId`) get their mixed file ingested and — when `pendingRecording` is configured —
   * CLAIMED onto a fresh system chat line (else the ingested attachment stays durably stored but
   * invisible in the DM, logged loudly) — and, when `transcription` is configured too, are
   * transcribed too. Called once at backend startup (index.ts) — errors are logged, never thrown
   * past this call (a crash-recovery sweep must not itself crash the boot sequence it's protecting).
   * A no-op (logged) when `recordingsDir`/`blobs`/`addAttachment`/`reconcileStore` aren't all
   * configured (recording was never configured for this deployment). */
  reconcileUnclaimedSessions(): Promise<void>;
}

/** mediad's error-response shape (docs/plans/voice-contracts.md §2.6). */
interface MediadErrorBody {
  error?: string;
  detail?: string;
}

export class MediadError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, detail?: string) {
    super(detail ? `mediad ${code}: ${detail}` : `mediad ${code} (status ${status})`);
    this.status = status;
    this.code = code;
  }
}

/** Content type for a manifest file entry, by its extension — the small fixed set mediad emits
 * (§2.3: OGG/Opus per leg, an ffmpeg-mixed m4a/ogg playback file). Mirrors http/server.ts's
 * `contentTypeFor` in spirit (a small explicit switch, not a MIME-sniffing library). */
function contentTypeForRecording(path: string): string {
  if (path.endsWith(".ogg")) return "audio/ogg";
  if (path.endsWith(".m4a")) return "audio/mp4";
  return "application/octet-stream";
}

/** Retention (§4/finding #8 — "raw per-leg files are deleted after successful transcription").
 * Duplicated (not imported) from calls/registry.ts's identical helper: registry.ts imports FROM
 * this module, so importing back would create a runtime cycle; the two copies are small enough
 * that keeping them independently is cheaper than a third shared module just for this. Path-
 * constrained to `<recordingsDir>/<sessionId>` — `sessionId` is server-minted (mediad's own
 * response) and never attacker-controlled, but voice-contracts.md §4 says treat it as untrusted
 * anyway, so anything that isn't a bare path segment is rejected before it reaches a filesystem
 * call. Never thrown past its caller. */
async function deleteSessionDir(recordingsDir: string, sessionId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    console.error(`mediad-client: refusing to delete session dir for a malformed session id: ${JSON.stringify(sessionId)}`);
    return;
  }
  try {
    await rm(join(recordingsDir, sessionId), { recursive: true, force: true });
  } catch (err) {
    console.error(`mediad-client: deleting session dir for ${sessionId} failed:`, err instanceof Error ? err.message : err);
  }
}

/** Construction never throws. Every method is real; mediad itself doesn't exist yet to test live
 * against (see the file header). */
export function makeMediadClient(deps: MediadClientDeps): MediadClient {
  const fetchFn = deps.fetchImpl ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, "");

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetchFn(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${deps.token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      let parsed: MediadErrorBody = {};
      try {
        parsed = (await response.json()) as MediadErrorBody;
      } catch {
        // non-JSON error body — fall through with the bare status
      }
      throw new MediadError(response.status, parsed.error ?? `http_${response.status}`, parsed.detail);
    }
    // Most mediad responses carry a JSON body (§2) — parsed unconditionally. `answerLeg`/`removeLeg`
    // (the group-calling extension's `POST .../answer` / `DELETE .../legs/{legId}`) are the two
    // exceptions: mediad answers those with a bare `204 No Content`, which has no body to parse —
    // `.json()` on an empty body throws, so a 204 short-circuits to `undefined` instead. Every other
    // endpoint this client calls always carries a body; a truly empty 200 elsewhere would be a
    // protocol bug mediad shouldn't produce, not something to silently paper over here.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async function createSession(input: MediadCreateSessionInput): Promise<{ sessionId: string }> {
    return request<{ sessionId: string }>("POST", "/sessions", input);
  }

  async function addLeg(sessionId: string, leg: MediadLeg): Promise<void> {
    await request<unknown>("POST", `/sessions/${encodeURIComponent(sessionId)}/legs`, leg);
  }

  async function removeLeg(sessionId: string, legId: string): Promise<void> {
    await request<unknown>("DELETE", `/sessions/${encodeURIComponent(sessionId)}/legs/${encodeURIComponent(legId)}`);
  }

  async function offerLeg(sessionId: string, legId: string, offerSdp: string): Promise<MediadSdpAnswer> {
    const res = await request<{ sdp: string }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/legs/${encodeURIComponent(legId)}/offer`,
      { sdp: offerSdp },
    );
    return { legId, sdp: res.sdp };
  }

  async function renegotiate(sessionId: string, legId: string): Promise<{ sdp: string }> {
    return request<{ sdp: string }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/legs/${encodeURIComponent(legId)}/renegotiate`,
    );
  }

  async function answerLeg(sessionId: string, legId: string, answerSdp: string): Promise<void> {
    await request<unknown>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/legs/${encodeURIComponent(legId)}/answer`,
      { sdp: answerSdp },
    );
  }

  async function getState(sessionId: string): Promise<MediadSessionState> {
    return request<MediadSessionState>("GET", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async function endSession(sessionId: string): Promise<MediadFinalizeManifest> {
    return request<MediadFinalizeManifest>("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async function health(): Promise<boolean> {
    try {
      // GET /health needs no auth (§2.5) — still fine to send the bearer, mediad just ignores it.
      const response = await fetchFn(`${base}/health`, { headers: { authorization: `Bearer ${deps.token}` } });
      if (!response.ok) return false;
      const body = (await response.json()) as { status?: string };
      return body.status === "ok";
    } catch {
      return false; // unreachable ⇒ unhealthy, never throw (this IS the availability check)
    }
  }

  /** Per-leg transcription for a reconciled call — the SAME shape as calls/registry.ts's live
   * `runPostCallPipeline` transcription step, sourced from a bare `CallRow` instead of an in-memory
   * `LiveCall` (there is no live call anymore; the backend crashed). No-ops (logged) unless
   * `deps.transcription` is fully configured. Applies the retention rule (finding #8) on success.
   * `pendingMessageId` — the message `reconcileOneCall` already claimed the recording attachment
   * onto (undefined if that claim itself failed or `deps.pendingRecording` isn't configured) — is
   * edited in place to the final outcome at every exit, mirroring `runPostCallPipeline`'s own
   * `editPendingIfClaimed` calls exactly (same shared helper, calls/pending-recording.ts).
   *
   * Reads `call_participants` (db/migrations/0021_call_participants.sql) for the leg->sub map
   * instead of the fixed LEG_CALLER_ID/LEG_CALLEE_ID constants + `call.caller`/`call.callee` — this
   * generalizes reconciliation to an arbitrary N-participant (group) call, not just a 1:1 DM pair;
   * `transcription.store` is a full `Store`, so this is the same table the live pipeline populates. */
  async function kickReconciledTranscription(call: CallRow, manifest: MediadFinalizeManifest, pendingMessageId: Id | undefined): Promise<void> {
    const transcription = deps.transcription;
    if (!transcription || !deps.recordingsDir || !call.mediadSessionId) return;

    const participants = await transcription.store.listCallParticipants(call.id);
    const legFiles = participants.map((p) => ({ sub: p.sub, legId: p.legId, file: manifest.files.find((f) => f.legId === p.legId) }));
    if (legFiles.length === 0 || legFiles.some((l) => !l.file)) {
      console.error(`mediad-client: reconciled session ${call.mediadSessionId} (call ${call.id}) is missing a leg file — no transcript`);
      if (deps.pendingRecording) {
        await editPendingIfClaimed(deps.pendingRecording, call, pendingMessageId, "🎙️ Recording stored — transcription failed (missing leg audio).");
      }
      return;
    }
    const sessionDir = join(deps.recordingsDir, call.mediadSessionId);

    try {
      const results = await Promise.all(
        legFiles.map((l) => transcription.transcribe.transcribeLeg({ legId: l.legId, filePath: join(sessionDir, l.file!.path) })),
      );
      const users = await Promise.all(legFiles.map((l) => transcription.store.getUser(l.sub)));
      const legs: LegTranscript[] = legFiles.map((l, i) => ({
        speaker: users[i]?.displayName || l.sub,
        startOffsetMs: l.file!.startOffsetMs,
        result: results[i]!,
      }));
      const turns = mergeTranscripts(legs);
      const header: TranscriptHeaderInput = {
        callDurationMs: call.endedAt ? Date.parse(call.endedAt) - Date.parse(call.startedAt) : 0,
        recordedDurationMs: manifest.files.find((f) => !f.legId)?.durationMs ?? 0,
        truncated: manifest.truncated,
      };
      const body = formatTranscript(header, turns);

      // attachmentIds: [] — the recording was already claimed by `reconcileOneCall`'s
      // `postPendingRecordingMessage` call onto the pending line above; re-claiming here would fail
      // governedCallAppend's `invalid_attachment` check (already claimed).
      const posted = await governedCallAppend(
        { store: transcription.store, marking: transcription.marking, dlp: transcription.dlp },
        { channelId: call.channelId, content: body, attachmentIds: [] },
      );
      await transcription.store.setCallTranscriptMessage(call.id, posted.id);
      transcription.broadcast?.(call.channelId, { type: "message", message: posted });
      // NOTE: governedCallAppend already audits `call.transcribed` itself.
      if (deps.pendingRecording) {
        await editPendingIfClaimed(deps.pendingRecording, call, pendingMessageId, "🎙️ Recording stored.");
      }
      await deleteSessionDir(deps.recordingsDir, call.mediadSessionId);
    } catch (err) {
      console.error(`mediad-client: reconciled transcription failed for call ${call.id} (session ${call.mediadSessionId}):`, err instanceof Error ? err.message : err);
      if (deps.pendingRecording) {
        await editPendingIfClaimed(deps.pendingRecording, call, pendingMessageId, "🎙️ Recording stored — transcription failed.");
      }
    }
  }

  /** Ingest one ended-but-unclaimed call's mixed recording, CLAIM it onto a fresh system chat line
   * (v3.1 REQUIRED "the artifact is never invisible" — see `deps.pendingRecording`'s doc comment for
   * why this can't assume a live-pipeline pending line already exists), then (if configured)
   * transcribe it too. Requires `recordingsDir`/`blobs`/`addAttachment`/`reconcileStore` all
   * configured (checked by the caller). Reuses `endSession` — idempotent per voice-contracts.md
   * §2.4 — rather than reading `manifest.json` off disk directly, so this also correctly re-runs
   * mediad's finalize for a call whose backend crashed BEFORE ever calling `endSession` the first
   * time. */
  async function reconcileOneCall(call: CallRow): Promise<void> {
    const sessionId = call.mediadSessionId!;
    const manifest = await endSession(sessionId);
    const mixed = manifest.files.find((f) => !f.legId);
    if (!mixed) {
      console.error(`mediad-client: reconciled session ${sessionId} (call ${call.id}) has no mixed file yet — a mid-finalize crash; nothing to ingest`);
      return;
    }
    const bytes = await readFile(join(deps.recordingsDir!, sessionId, mixed.path));
    const sha256 = sha256Hex(bytes);
    await deps.blobs!.write(sha256, bytes);
    // The resolved channel marking (channel-as-portion, else the policy floor) — same rule
    // calls/registry.ts's `ingestMixedFile` stamps on the live path — rather than an empty string:
    // an unclaimed-then-claimed attachment's `marking` column is never re-stamped later (only the
    // CHAT LINE's own marking gets resolved at post time), so leaving it '' here would permanently
    // under-mark a reconciled call's recording relative to its live-path twin.
    const marking = deps.pendingRecording ? await resolveChannelMarking(deps.pendingRecording, call.channelId) : "";
    const attachment = await deps.addAttachment!({
      channelId: call.channelId,
      uploadedBy: "system",
      filename: mixed.path,
      contentType: contentTypeForRecording(mixed.path),
      byteSize: bytes.length,
      sha256,
      marking,
    });
    await deps.reconcileStore!.setCallRecordingAttachment(call.id, attachment.id);
    console.error(`mediad-client: reconciled call ${call.id} (session ${sessionId}) — attachment ${attachment.id}`);

    // Claim the attachment onto a visible chat line RIGHT NOW (v3.1 REQUIRED: "the artifact is
    // never invisible") — `listAttachmentsForMessage` only returns CLAIMED rows, so without this the
    // attachment above is durably stored but permanently invisible in the DM. Unlike the live
    // pipeline, this can NOT assume a pending line already exists: the primary reconciliation case is
    // a crash BETWEEN mediad's finalize and the live pipeline's own ingest step, i.e. BEFORE any
    // attachment (and so any pending line) ever existed.
    let pendingMessageId: Id | undefined;
    if (deps.pendingRecording) {
      const pendingText = deps.transcription
        ? "🎙️ Recording stored — transcription pending."
        : "🎙️ Recording stored — transcription unavailable.";
      try {
        pendingMessageId = await postPendingRecordingMessage(deps.pendingRecording, call, attachment, pendingText);
      } catch (err) {
        console.error(`mediad-client: pending-recording message failed for call ${call.id}:`, err instanceof Error ? err.message : err);
      }
    } else {
      console.error(
        `mediad-client: reconciled call ${call.id} — no pendingRecording deps configured, attachment ${attachment.id} ` +
          "remains UNCLAIMED and invisible in the DM until a later reconciliation sweep runs with it configured",
      );
    }

    await kickReconciledTranscription(call, manifest, pendingMessageId);
  }

  async function reconcileUnclaimedSessions(): Promise<void> {
    if (!deps.reconcileStore) {
      console.error("mediad-client: reconcileUnclaimedSessions — no reconcileStore configured, skipping (see file header)");
      return;
    }
    let candidates: CallRow[];
    try {
      candidates = (await deps.reconcileStore.listUnclaimedEndedCalls()).filter((c) => c.mode === "relayed" && c.mediadSessionId);
    } catch (err) {
      console.error("mediad-client: reconcileUnclaimedSessions — listUnclaimedEndedCalls failed:", err instanceof Error ? err.message : err);
      return;
    }
    if (candidates.length === 0) return;
    if (!deps.recordingsDir || !deps.blobs || !deps.addAttachment) {
      console.error(
        `mediad-client: reconcileUnclaimedSessions — ${candidates.length} unclaimed relayed call(s) found, but ` +
          "recordingsDir/blobs/addAttachment aren't all configured — skipping (see file header)",
      );
      return;
    }
    for (const call of candidates) {
      try {
        await reconcileOneCall(call);
      } catch (err) {
        console.error(`mediad-client: reconciling call ${call.id} (session ${call.mediadSessionId}) failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return { createSession, addLeg, removeLeg, offerLeg, renegotiate, answerLeg, getState, endSession, health, reconcileUnclaimedSessions };
}
