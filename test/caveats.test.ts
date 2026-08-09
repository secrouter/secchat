// Unit tests for the COMPOSITE marking value (src/marking/caveats.ts): the level+caveat parser,
// the canonical banner string, lattice DOMINANCE, and JOIN — plus the policy-level caveat vocabulary
// (enabling/filtering CUI categories). Pure, no I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dominates, formatMarking, joinMarking, parseMarking } from "../src/marking/caveats.ts";
import {
  caveatsForLevel,
  DEFAULT_CUI_CATEGORIES,
  findCaveat,
  makeMarkingPolicy,
  parseCaveatDefs,
} from "../src/marking/policy.ts";

// A CUI ladder with the starter categories enabled.
const policy = makeMarkingPolicy(["UNCLASSIFIED", "PROPRIETARY", "CUI"], "UNCLASSIFIED", [...DEFAULT_CUI_CATEGORIES]);

test("makeMarkingPolicy: enables only caveats whose level is on the ladder; de-dups by code", () => {
  // Categories all attach to CUI → present on a CUI ladder.
  assert.ok(policy.caveats.length >= 5);
  assert.ok(policy.caveats.every((c) => c.level === "CUI"));
  // A commercial ladder (no CUI) drops every CUI category.
  const commercial = makeMarkingPolicy(["UNCLASSIFIED", "PROPRIETARY", "SENSITIVE"], "UNCLASSIFIED", [...DEFAULT_CUI_CATEGORIES]);
  assert.deepEqual(commercial.caveats, []);
  // Duplicate codes collapse.
  const dup = makeMarkingPolicy(["UNCLASSIFIED", "CUI"], "UNCLASSIFIED", [
    { kind: "category", level: "CUI", code: "SP-X", name: "One" },
    { kind: "category", level: "CUI", code: "sp-x", name: "Dup (same code, lowercased)" },
  ]);
  assert.equal(dup.caveats.length, 1);
});

test("caveatsForLevel / findCaveat: level-scoped vocabulary lookups", () => {
  assert.ok(caveatsForLevel(policy, "CUI").length === policy.caveats.length);
  assert.deepEqual(caveatsForLevel(policy, "UNCLASSIFIED"), []); // categories don't attach to the floor
  assert.equal(findCaveat(policy, "sp-prvcy")?.name, "Privacy"); // case-insensitive
  assert.equal(findCaveat(policy, "nope"), undefined);
});

test("formatMarking: bare level vs level//categories (categories already sorted)", () => {
  assert.equal(formatMarking({ level: "CUI", caveats: [] }), "CUI");
  assert.equal(formatMarking({ level: "CUI", caveats: ["SP-EXPT", "SP-PRVCY"] }), "CUI//SP-EXPT/SP-PRVCY");
});

test("parseMarking: valid level + legal categories → canonical (sorted, de-duped); else null", () => {
  assert.deepEqual(parseMarking(policy, "CUI"), { level: "CUI", caveats: [] });
  // Case-insensitive, sorted alphabetically regardless of input order, de-duped.
  assert.deepEqual(parseMarking(policy, "cui//sp-prvcy/sp-expt/sp-prvcy"), {
    level: "CUI",
    caveats: ["SP-EXPT", "SP-PRVCY"],
  });
  assert.equal(parseMarking(policy, "TICKLISH"), null, "unknown level");
  assert.equal(parseMarking(policy, "CUI//SP-BOGUS"), null, "unknown category");
  assert.equal(parseMarking(policy, "UNCLASSIFIED//SP-PRVCY"), null, "a CUI category is illegal on UNCLASSIFIED");
});

test("dominates: ≥ level AND superset of caveats", () => {
  const cui = parseMarking(policy, "CUI")!;
  const cuiPrvcy = parseMarking(policy, "CUI//SP-PRVCY")!;
  const cuiExpt = parseMarking(policy, "CUI//SP-EXPT")!;
  const prop = parseMarking(policy, "PROPRIETARY")!;
  // A CUI//SP-PRVCY channel holds plain CUI (superset ∅) and CUI//SP-PRVCY, but not CUI//SP-EXPT.
  assert.equal(dominates(policy, cuiPrvcy, cui), true);
  assert.equal(dominates(policy, cuiPrvcy, cuiPrvcy), true);
  assert.equal(dominates(policy, cuiPrvcy, cuiExpt), false, "disjoint category is not dominated");
  // A plain CUI channel does NOT dominate a categorized CUI message (it lacks the caveat).
  assert.equal(dominates(policy, cui, cuiPrvcy), false);
  // Level still governs: CUI dominates PROPRIETARY, not vice-versa.
  assert.equal(dominates(policy, cui, prop), true);
  assert.equal(dominates(policy, prop, cui), false);
});

test("joinMarking: higher level + union of that level's caveats (lower-level caveats dropped)", () => {
  const u = parseMarking(policy, "UNCLASSIFIED")!;
  const cuiPrvcy = parseMarking(policy, "CUI//SP-PRVCY")!;
  const cuiExpt = parseMarking(policy, "CUI//SP-EXPT")!;
  // Same level → union of caveats.
  assert.equal(formatMarking(joinMarking(policy, cuiPrvcy, cuiExpt)), "CUI//SP-EXPT/SP-PRVCY");
  // Higher level wins and keeps its caveats; the lower contributes none.
  assert.equal(formatMarking(joinMarking(policy, u, cuiPrvcy)), "CUI//SP-PRVCY");
});

test("parseCaveatDefs: JSON override; fails closed on malformed", () => {
  const defs = parseCaveatDefs('[{"code":"SP-PRVCY","name":"Privacy"},{"code":"NF","name":"No Foreign","level":"CUI"}]');
  assert.equal(defs.length, 2);
  assert.equal(defs[0]!.level, "CUI"); // defaults to CUI
  assert.equal(defs[0]!.kind, "category");
  assert.deepEqual(parseCaveatDefs(""), []);
  assert.deepEqual(parseCaveatDefs(undefined), []);
  assert.throws(() => parseCaveatDefs("not json"), /not valid JSON/);
  assert.throws(() => parseCaveatDefs('{"code":"x"}'), /must be a JSON array/);
  assert.throws(() => parseCaveatDefs('[{"name":"no code"}]'), /missing "code"/);
});
