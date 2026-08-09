// Unit tests for the CUI portion-marking parser (src/marking/portions.ts): extracting inline
// portion tokens and deriving the overall (highest) marking, while ignoring ordinary parentheticals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { overallPortionMarking, portionMarkings } from "../src/marking/portions.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";

const policy = makeMarkingPolicy(["UNCLASSIFIED", "PROPRIETARY", "CUI"], "UNCLASSIFIED");

test("portionMarkings: extracts known-level tokens ('U' = UNCLASSIFIED), first-seen order, de-duped", () => {
  const content = "(U) intro line\n(CUI) a controlled paragraph\n(CUI) another controlled line";
  assert.deepEqual(portionMarkings(policy, content), ["UNCLASSIFIED", "CUI"]);
});

test("ordinary parentheticals are NOT mistaken for markings", () => {
  assert.deepEqual(portionMarkings(policy, "see the note (below) and the (TODO) item — nothing here"), []);
  assert.deepEqual(portionMarkings(policy, "a level that isn't in the ladder (SECRET) is ignored"), []);
});

test("overallPortionMarking: the HIGHEST portion wins; null when there are no portions", () => {
  assert.equal(overallPortionMarking(policy, "(U) fine\n(PROPRIETARY) trade secret\n(CUI) controlled"), "CUI");
  assert.equal(overallPortionMarking(policy, "(U) all unclassified here"), "UNCLASSIFIED");
  assert.equal(overallPortionMarking(policy, "no markings at all"), null);
});
