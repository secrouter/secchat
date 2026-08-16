// Unit tests for transcribe/merge.ts — pure, offline (fixture SecRecorder responses), no I/O.
// Covers the placement rule (leg.startOffsetMs + segment.start*1000), overlapping speech (an
// interleaved segment from the OTHER leg breaks the same-speaker fold), same-speaker folding, the
// mixed-mode fallback's generic speaker labeling, and the header/turn formatting.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeTranscripts,
  mergeMixedTranscript,
  formatTranscriptHeader,
  formatTurn,
  formatTranscript,
  type LegTranscript,
} from "../src/transcribe/merge.ts";
import type { TranscribeResult, TranscribeSegment } from "../src/transcribe/client.ts";

function segment(start: number, end: number, text: string, speaker?: string): TranscribeSegment {
  return { start, end, text, ...(speaker !== undefined ? { speaker } : {}) };
}

function result(segments: TranscribeSegment[]): TranscribeResult {
  return {
    task: "transcribe",
    language: "en",
    duration: segments.length ? segments[segments.length - 1]!.end : 0,
    text: segments.map((s) => s.text).join(" "),
    words: [],
    segments,
  };
}

test("mergeTranscripts: places each leg's segments at leg.startOffsetMs + segment.start*1000", () => {
  const legs: LegTranscript[] = [
    { speaker: "Alice", startOffsetMs: 0, result: result([segment(0.5, 2, "Hey there")]) },
    // Bob's leg started 1180ms later (dial jitter) — his segment at t=1.0s of HIS file lands at
    // 1180 + 1000 = 2180ms of the SESSION timeline, not 1000ms.
    { speaker: "Bob", startOffsetMs: 1180, result: result([segment(1.0, 2.5, "Hi Alice")]) },
  ];

  const turns = mergeTranscripts(legs);
  assert.deepEqual(turns, [
    { speaker: "Alice", atMs: 500, text: "Hey there" },
    { speaker: "Bob", atMs: 2180, text: "Hi Alice" }, // 1180 + 1.0*1000
  ]);
});

test("mergeTranscripts: consecutive same-speaker segments fold into one turn", () => {
  const legs: LegTranscript[] = [
    {
      speaker: "Alice",
      startOffsetMs: 0,
      result: result([segment(0, 1, "Hey,"), segment(1.1, 2, "are you free"), segment(2.1, 3, "to look at this?")]),
    },
  ];

  const turns = mergeTranscripts(legs);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.speaker, "Alice");
  assert.equal(turns[0]!.atMs, 0);
  assert.equal(turns[0]!.text, "Hey, are you free to look at this?");
});

test("mergeTranscripts: overlapping speech from the OTHER leg breaks the same-speaker fold", () => {
  // Alice: 0-2s ("go ahead"), 2.5-4s ("did you get that")
  // Bob:   1-1.8s ("wait what") — interleaves chronologically BETWEEN Alice's two segments.
  const legs: LegTranscript[] = [
    {
      speaker: "Alice",
      startOffsetMs: 0,
      result: result([segment(0, 2, "go ahead"), segment(2.5, 4, "did you get that")]),
    },
    { speaker: "Bob", startOffsetMs: 0, result: result([segment(1, 1.8, "wait what")]) },
  ];

  const turns = mergeTranscripts(legs);
  // Sorted chronologically: Alice(0), Bob(1000), Alice(2500) — three turns, Alice's two segments
  // stay SEPARATE because Bob's overlapping segment sits between them in the global order.
  assert.deepEqual(turns, [
    { speaker: "Alice", atMs: 0, text: "go ahead" },
    { speaker: "Bob", atMs: 1000, text: "wait what" },
    { speaker: "Alice", atMs: 2500, text: "did you get that" },
  ]);
});

test("mergeTranscripts: empty/whitespace-only segments are dropped", () => {
  const legs: LegTranscript[] = [
    { speaker: "Alice", startOffsetMs: 0, result: result([segment(0, 1, "  "), segment(1, 2, "actual words")]) },
  ];
  const turns = mergeTranscripts(legs);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.text, "actual words");
});

test("mergeTranscripts: three-leg input (§11 SFU-growth caution) still merges chronologically", () => {
  const legs: LegTranscript[] = [
    { speaker: "Alice", startOffsetMs: 0, result: result([segment(0, 1, "one")]) },
    { speaker: "Bob", startOffsetMs: 0, result: result([segment(1, 2, "two")]) },
    { speaker: "Carol", startOffsetMs: 0, result: result([segment(2, 3, "three")]) },
  ];
  const turns = mergeTranscripts(legs);
  assert.deepEqual(turns.map((t) => t.speaker), ["Alice", "Bob", "Carol"]);
});

test("mergeMixedTranscript: remaps raw diarization ids to Speaker N labels in first-appearance order", () => {
  const r = result([
    segment(0, 1, "hello", "SPEAKER_01"),
    segment(1.2, 2, "hi", "SPEAKER_00"),
    segment(2.2, 3, "how are you", "SPEAKER_01"),
  ]);
  const turns = mergeMixedTranscript(r);
  assert.deepEqual(turns, [
    { speaker: "Speaker 1", atMs: 0, text: "hello" },
    { speaker: "Speaker 2", atMs: 1200, text: "hi" },
    { speaker: "Speaker 1", atMs: 2200, text: "how are you" },
  ]);
});

test("mergeMixedTranscript: consecutive same (mapped) speaker segments still fold", () => {
  const r = result([segment(0, 1, "part one", "X"), segment(1.1, 2, "part two", "X")]);
  const turns = mergeMixedTranscript(r);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.text, "part one part two");
});

test("mergeMixedTranscript: no speaker field on any segment ⇒ everything maps to one 'Speaker 1' (and folds into one turn)", () => {
  const r = result([segment(0, 1, "a"), segment(2, 3, "b")]);
  const turns = mergeMixedTranscript(r);
  assert.deepEqual(turns, [{ speaker: "Speaker 1", atMs: 0, text: "a b" }]);
});

test("formatTranscriptHeader: exact worked example from the plan", () => {
  const header = formatTranscriptHeader({ callDurationMs: (12 * 60 + 34) * 1000, recordedDurationMs: (11 * 60 + 58) * 1000 });
  assert.equal(header, "Call — 12m 34s (recorded 11m 58s) — recorded with consent");
});

test("formatTranscriptHeader: truncated flag appends the mediad-crash note", () => {
  const header = formatTranscriptHeader({ callDurationMs: 60_000, recordedDurationMs: 45_000, truncated: true });
  assert.match(header, /recording truncated \(mediad restarted mid-call\)$/);
});

test("formatTurn: exact worked shape **Alice** [00:12] …", () => {
  assert.equal(formatTurn({ speaker: "Alice", atMs: 12_000, text: "hey there" }), "**Alice** [00:12] hey there");
});

test("formatTurn: minutes past 59 are not clamped/wrapped", () => {
  assert.equal(formatTurn({ speaker: "Bob", atMs: (62 * 60 + 7) * 1000, text: "still going" }), "**Bob** [62:07] still going");
});

test("formatTranscript: header + blank line + turns, blank-separated", () => {
  const body = formatTranscript(
    { callDurationMs: 30_000, recordedDurationMs: 30_000 },
    [
      { speaker: "Alice", atMs: 0, text: "hi" },
      { speaker: "Bob", atMs: 5_000, text: "hey" },
    ],
  );
  assert.equal(
    body,
    "Call — 0m 30s (recorded 0m 30s) — recorded with consent\n\n**Alice** [00:00] hi\n\n**Bob** [00:05] hey",
  );
});

test("formatTranscript: no turns (silent call) ⇒ header only, no trailing separator", () => {
  const body = formatTranscript({ callDurationMs: 5_000, recordedDurationMs: 5_000 }, []);
  assert.equal(body, "Call — 0m 5s (recorded 0m 5s) — recorded with consent");
});
