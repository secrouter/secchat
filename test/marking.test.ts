// Unit tests for the pure marking policy (src/marking/policy.ts) — the ordered ladder, its
// fail-closed validation, and the rank comparisons the HTTP enforcement is built on.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MARKING,
  DEFAULT_MARKING_LEVELS,
  isElevatedMarking,
  isKnownMarking,
  makeMarkingPolicy,
  markingAtMost,
  markingProfile,
  markRank,
  MARKING_PROFILES,
  parseMarkingLevels,
} from "../src/marking/policy.ts";

test("parseMarkingLevels: splits, trims, upper-cases, de-dupes, preserves order", () => {
  assert.deepEqual(parseMarkingLevels(" unclassified, CUI ,cui, classified "), ["UNCLASSIFIED", "CUI", "CLASSIFIED"]);
  assert.deepEqual(parseMarkingLevels(""), []);
});

test("makeMarkingPolicy: builds a normalized ladder and rank-orders it", () => {
  const p = makeMarkingPolicy([...DEFAULT_MARKING_LEVELS], DEFAULT_MARKING);
  // The default ladder is the dod-cui profile — up to CUI, no CLASSIFIED.
  assert.deepEqual(p.levels, ["UNCLASSIFIED", "PROPRIETARY", "CUI"]);
  assert.equal(p.default, "UNCLASSIFIED");
  assert.equal(markRank(p, "UNCLASSIFIED"), 0);
  assert.equal(markRank(p, "CUI"), 2);
  assert.equal(markRank(p, "unknown"), -1);
  assert.equal(markRank(p, "CLASSIFIED"), -1, "CLASSIFIED does not exist on an unclass deployment");
});

test("profiles: dod-cui hides CLASSIFIED; dod-classified unlocks it; commercial swaps in SENSITIVE", () => {
  assert.equal(markingProfile("dod-cui").levels.includes("CLASSIFIED"), false);
  assert.ok(markingProfile("dod-classified").levels.includes("SECRET"));
  assert.deepEqual(markingProfile("commercial").levels, ["UNCLASSIFIED", "PROPRIETARY", "SENSITIVE"]);
  assert.ok(!markingProfile("commercial").levels.includes("CUI"), "no defense markings on a commercial deployment");
  assert.throws(() => markingProfile("nonsense"), /unknown profile/);
  // Every profile's default is one of its own levels.
  for (const def of Object.values(MARKING_PROFILES)) assert.ok(def.levels.includes(def.default));
});

test("isElevatedMarking: baseline (default) and below are not elevated; above it is", () => {
  const p = makeMarkingPolicy(["UNCLASSIFIED", "PROPRIETARY", "CUI"], "UNCLASSIFIED");
  assert.equal(isElevatedMarking(p, "UNCLASSIFIED"), false, "baseline suppresses its own display");
  assert.equal(isElevatedMarking(p, "PROPRIETARY"), true);
  assert.equal(isElevatedMarking(p, "CUI"), true);
  assert.equal(isElevatedMarking(p, "unknown"), false);
});

test("makeMarkingPolicy: fails CLOSED on a bad ladder", () => {
  assert.throws(() => makeMarkingPolicy([], "X"), /at least one level/);
  assert.throws(() => makeMarkingPolicy(["A", "A"], "A"), /unique/);
  assert.throws(() => makeMarkingPolicy(["UNCLASSIFIED", "CUI"], "SECRET"), /not one of the levels/);
});

test("markingAtMost: rank comparison, unknowns never compare true", () => {
  const p = makeMarkingPolicy([...DEFAULT_MARKING_LEVELS], DEFAULT_MARKING);
  assert.equal(markingAtMost(p, "UNCLASSIFIED", "CUI"), true);
  assert.equal(markingAtMost(p, "CUI", "CUI"), true);
  assert.equal(markingAtMost(p, "CLASSIFIED", "CUI"), false); // exceeds the ceiling
  assert.equal(markingAtMost(p, "bogus", "CUI"), false);
  assert.equal(isKnownMarking(p, "cui"), true); // case-insensitive
  assert.equal(isKnownMarking(p, "nope"), false);
});

test("a custom deployment ladder is honored end-to-end", () => {
  const p = makeMarkingPolicy(parseMarkingLevels("public, internal, secret"), "public");
  assert.deepEqual(p.levels, ["PUBLIC", "INTERNAL", "SECRET"]);
  assert.equal(markingAtMost(p, "INTERNAL", "SECRET"), true);
  assert.equal(markingAtMost(p, "SECRET", "INTERNAL"), false);
});
