// Unit tests for the CUI portion-marking parser (src/marking/portions.ts): extracting inline
// portion tokens (level + optional categories) and deriving the overall (join) marking, while
// ignoring ordinary parentheticals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { overallPortionMarking, portionMarkings } from "../src/marking/portions.ts";
import { formatMarking } from "../src/marking/caveats.ts";
import { DEFAULT_CUI_CATEGORIES, makeMarkingPolicy } from "../src/marking/policy.ts";

const policy = makeMarkingPolicy(["UNCLASSIFIED", "PROPRIETARY", "CUI"], "UNCLASSIFIED", [...DEFAULT_CUI_CATEGORIES]);

const formatted = (content: string) => portionMarkings(policy, content).map(formatMarking);
const overall = (content: string) => {
  const m = overallPortionMarking(policy, content);
  return m ? formatMarking(m) : null;
};

test("portionMarkings: extracts known-level tokens ('U' = UNCLASSIFIED), first-seen order, de-duped", () => {
  const content = "(U) intro line\n(CUI) a controlled paragraph\n(CUI) another controlled line";
  assert.deepEqual(formatted(content), ["UNCLASSIFIED", "CUI"]);
});

test("ordinary parentheticals are NOT mistaken for markings", () => {
  assert.deepEqual(formatted("see the note (below) and the (TODO) item — nothing here"), []);
  assert.deepEqual(formatted("a level that isn't in the ladder (SECRET) is ignored"), []);
});

test("overallPortionMarking: the HIGHEST portion wins; null when there are no portions", () => {
  assert.equal(overall("(U) fine\n(PROPRIETARY) trade secret\n(CUI) controlled"), "CUI");
  assert.equal(overall("(U) all unclassified here"), "UNCLASSIFIED");
  assert.equal(overall("no markings at all"), null);
});

test("category-qualified portions: parsed whole, unioned at the top level", () => {
  assert.deepEqual(formatted("(CUI//SP-PRVCY) a privacy portion"), ["CUI//SP-PRVCY"]);
  // Two CUI portions with different categories → the overall unions them (alphabetical, canonical).
  assert.equal(overall("(CUI//SP-PRVCY) name\n(CUI//SP-EXPT) tech"), "CUI//SP-EXPT/SP-PRVCY");
  // A lower plain portion doesn't strip the higher categorized one.
  assert.equal(overall("(U) intro\n(CUI//SP-PRVCY) controlled"), "CUI//SP-PRVCY");
});

test("a malformed category is fail-SAFE: the portion still resolves to its (known) level", () => {
  // "(CUI//SP-BOGUS)" — bad category, but CUI is a real level → recognized as CUI (never under-marked).
  assert.deepEqual(formatted("(CUI//SP-BOGUS) still controlled"), ["CUI"]);
  assert.equal(overall("(U) intro\n(CUI//SP-BOGUS) still controlled"), "CUI");
});
