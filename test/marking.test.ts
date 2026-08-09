// Unit tests for the pure marking policy (src/marking/policy.ts) — the ordered ladder, its
// fail-closed validation, and the rank comparisons the HTTP enforcement is built on.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MARKING,
  DEFAULT_MARKING_LEVELS,
  isKnownMarking,
  makeMarkingPolicy,
  markingAtMost,
  markRank,
  parseMarkingLevels,
} from "../src/marking/policy.ts";

test("parseMarkingLevels: splits, trims, upper-cases, de-dupes, preserves order", () => {
  assert.deepEqual(parseMarkingLevels(" unclassified, CUI ,cui, classified "), ["UNCLASSIFIED", "CUI", "CLASSIFIED"]);
  assert.deepEqual(parseMarkingLevels(""), []);
});

test("makeMarkingPolicy: builds a normalized ladder and rank-orders it", () => {
  const p = makeMarkingPolicy([...DEFAULT_MARKING_LEVELS], DEFAULT_MARKING);
  assert.deepEqual(p.levels, ["UNCLASSIFIED", "PROPRIETARY", "CUI", "CLASSIFIED"]);
  assert.equal(p.default, "UNCLASSIFIED");
  assert.equal(markRank(p, "UNCLASSIFIED"), 0);
  assert.equal(markRank(p, "CUI"), 2);
  assert.equal(markRank(p, "unknown"), -1);
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
