// merge.ts — merges two (or more, per §11's SFU-growth caution against hard-coding "exactly two")
// SecRecorder per-leg transcripts into one speaker-exact, chronological transcript, and formats it
// into the message body governedCallAppend posts (docs/plans/voice-calls-plan.md §2.4). Pure
// functions (no I/O), like audit/chain.ts and attachments/manifest.ts — trivially unit-testable
// with fixture SecRecorder responses.
//
// Placement rule (§2.3's shared-timebase requirement, v3.1 REQUIRED #2): each leg's segments are
// relative to that leg's OWN OGG file start, NOT the call's session t0 — mediad's finalize manifest
// supplies `startOffsetMs` per leg (legs do NOT share t0: dial jitter, one side answering late).
// Every segment is placed at `leg.startOffsetMs + segment.start*1000`; all segments (every leg
// interleaved) are then sorted by that absolute time, and consecutive segments from the SAME
// speaker are folded into one turn (SecRecorder segments are typically sub-utterance; consecutive
// same-speaker segments read better joined). "Consecutive" means adjacent in the GLOBAL sorted
// order — an interleaved segment from the other leg (overlapping speech) breaks the fold, so two
// same-speaker segments either side of an interruption stay as separate turns.

import type { TranscribeResult } from "./client.ts";

/** One leg's transcript, ready to merge — `speaker` is the REAL username/displayName (A7: per-leg
 * identity gives exact attribution, no diarization needed), `startOffsetMs` is mediad's finalize
 * manifest's per-leg offset against the session t0 (§2.3). */
export interface LegTranscript {
  speaker: string;
  startOffsetMs: number;
  result: TranscribeResult;
}

/** One merged, chronologically-placed speaker turn. `atMs` is relative to the session t0 (the SAME
 * origin the mixed playback file's timeline uses), so a rendered transcript's timestamps line up
 * with the attached audio. */
export interface MergedTurn {
  speaker: string;
  atMs: number;
  text: string;
}

/** Merge per-leg transcripts into speaker-exact, chronologically-ordered turns. See the file header
 * for the placement/folding rule. Segments with empty (whitespace-only) text are dropped — SecRecorder
 * can emit these for silence/noise-only stretches and they'd otherwise produce a blank turn. */
export function mergeTranscripts(legs: LegTranscript[]): MergedTurn[] {
  const placed: MergedTurn[] = [];
  for (const leg of legs) {
    for (const segment of leg.result.segments) {
      const text = segment.text.trim();
      if (!text) continue;
      placed.push({ speaker: leg.speaker, atMs: Math.round(leg.startOffsetMs + segment.start * 1000), text });
    }
  }
  // Stable sort (Array#sort is stable per spec/V8) — ties (rare: two legs' segments landing at the
  // exact same ms) keep the legs' relative array order, which is deterministic given the caller's
  // input order.
  placed.sort((a, b) => a.atMs - b.atMs);

  const turns: MergedTurn[] = [];
  for (const seg of placed) {
    const prev = turns[turns.length - 1];
    if (prev && prev.speaker === seg.speaker) {
      prev.text = `${prev.text} ${seg.text}`;
    } else {
      turns.push({ ...seg });
    }
  }
  return turns;
}

/** `SECCHAT_TRANSCRIBE_MODE=mixed` fallback (§2.4): ONE transcription pass over the ffmpeg-mixed
 * playback file with `diarize=true` (see transcribe/client.ts's `TranscribeLegJob.diarize`),
 * yielding generic `Speaker 1`/`Speaker 2` labels instead of real usernames — no per-leg identity
 * exists in this mode, so real attribution isn't derivable. A DISTINCT function from
 * `mergeTranscripts` (not bolted onto it, per the file's original design note): the input shape is
 * one `TranscribeResult` whose segments/words carry a diarization `speaker` id, not two per-leg
 * transcripts to interleave — there's no cross-leg offset math here, the mixed file's own timeline
 * IS the session timeline (mediad's finalize manifest gives the mixed file `startOffsetMs: 0`,
 * §2.4/voice-contracts.md §2.4). Same same-speaker folding rule as `mergeTranscripts`, and the same
 * empty-segment drop. Raw diarization ids are remapped to "Speaker N" labels in FIRST-APPEARANCE
 * order (deterministic given SecRecorder returns segments in chronological order, per its own
 * verbose_json contract) — never SecRecorder's own internal id verbatim, since that's an
 * implementation detail, not a stable display label. */
export function mergeMixedTranscript(result: TranscribeResult): MergedTurn[] {
  const labels = new Map<string, string>();
  function labelFor(raw: string | undefined): string {
    const key = raw ?? "unknown";
    let label = labels.get(key);
    if (!label) {
      label = `Speaker ${labels.size + 1}`;
      labels.set(key, label);
    }
    return label;
  }

  const turns: MergedTurn[] = [];
  for (const segment of result.segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const speaker = labelFor(segment.speaker);
    const atMs = Math.round(segment.start * 1000);
    const prev = turns[turns.length - 1];
    if (prev && prev.speaker === speaker) {
      prev.text = `${prev.text} ${text}`;
    } else {
      turns.push({ speaker, atMs, text });
    }
  }
  return turns;
}

/** `mm:ss` (not `hh:mm:ss` — v1 caps recordings at a couple hours, R4, and per-turn timestamps read
 * better short); minutes are NOT clamped to 59, so a turn past the hour mark still renders correctly
 * (e.g. "62:07") rather than wrapping. Negative input (shouldn't happen — offsets/segment starts are
 * both ≥ 0) clamps to 0 rather than rendering a garbled negative timestamp. */
function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** `12m 34s` — the header's duration phrasing (see `formatTranscriptHeader`); deliberately distinct
 * from `formatTimestamp`'s `mm:ss` (a duration reads as prose in the header, a per-turn timestamp
 * reads as a clock position in the body). */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s}s`;
}

export interface TranscriptHeaderInput {
  /** Wall-clock call duration (CallRow.endedAt - startedAt), ms. */
  callDurationMs: number;
  /** Recorded duration from mediad's finalize manifest (the mixed file's durationMs), ms — may
   * differ from `callDurationMs` by the dial/answer/ICE-connect latency before recording started. */
  recordedDurationMs: number;
  /** mediad's finalize manifest `truncated` flag (§2.3/voice-contracts.md §2.4) — a mid-call mediad
   * crash/restart, surfaced here rather than silently yielding a shorter-than-expected recording. */
  truncated?: boolean;
}

/** `Call — 12m 34s (recorded 11m 58s) — recorded with consent` (§2.4's exact worked example) —
 * always "recorded with consent" (governedCallAppend / this header only ever run for a `relayed`,
 * consented call; a p2p call has no recording/transcript pipeline at all, D4). */
export function formatTranscriptHeader(input: TranscriptHeaderInput): string {
  const truncNote = input.truncated ? " — recording truncated (mediad restarted mid-call)" : "";
  return `Call — ${formatDuration(input.callDurationMs)} (recorded ${formatDuration(input.recordedDurationMs)}) — recorded with consent${truncNote}`;
}

/** One turn as `**Alice** [00:12] …` (§2.4's exact worked shape). */
export function formatTurn(turn: MergedTurn): string {
  return `**${turn.speaker}** [${formatTimestamp(turn.atMs)}] ${turn.text}`;
}

/** The full transcript body governedCallAppend posts: the header, a blank line, then every turn
 * separated by a blank line (readable as chat-style paragraphs, not a wall of text). */
export function formatTranscript(header: TranscriptHeaderInput, turns: MergedTurn[]): string {
  const body = turns.map(formatTurn).join("\n\n");
  return body ? `${formatTranscriptHeader(header)}\n\n${body}` : formatTranscriptHeader(header);
}
