// The COMPOSITE marking value — a level plus an unranked SET of caveats (CUI categories today) — and
// the arithmetic over it. This is the layer above the pure level ladder (policy.ts): where a level
// compares by RANK (a total order), caveats compare by SUBSET (a partial order), so a full marking
// forms a lattice. Enforcement generalizes the old rank-only ceiling to lattice DOMINANCE: a
// container (a marked channel) may hold content only if it is at least as high AND carries a superset
// of the content's caveats.
//
// Canonical wire/storage form is the real CUI banner grammar: `LEVEL//CAT1/CAT2` (categories in
// alphabetical order, per CUI marking guidance) — a bare level serializes to just `LEVEL`, so
// existing single-level markings are byte-identical and the hash chain / append-only guard are
// unaffected. The grammar already tolerates a second `//` group, so a later caveat kind (Limited
// Dissemination Controls, classified compartments) slots in as `LEVEL//CATS//DISSEM` with no change
// to callers of this module.

import { findCaveat, markRank, normalizeMarking, type MarkingPolicy } from "./policy.ts";

/** A resolved marking: a ladder level plus its (possibly empty) caveat codes, canonical upper-cased
 * and sorted. Construct only via `parseMarking` (which validates) so an in-hand Marking is always
 * legal for its policy. */
export interface Marking {
  level: string;
  caveats: string[];
}

/** Render a marking to its canonical banner string: `LEVEL` or `LEVEL//CAT1/CAT2`. */
export function formatMarking(m: Marking): string {
  return m.caveats.length > 0 ? `${m.level}//${m.caveats.join("/")}` : m.level;
}

/** Parse a banner string (`CUI`, `CUI//SP-PRVCY`, `CUI//SP-EXPT/SP-PRVCY`) into a validated Marking,
 * or null if the level is unknown OR any caveat is unknown/disabled/illegal at that level. Caveats
 * are de-duplicated and sorted alphabetically (the canonical, hash-stable order). Fails CLOSED — the
 * HTTP layer turns null into a 400 rather than storing an unverifiable marking. */
export function parseMarking(policy: MarkingPolicy, raw: string): Marking | null {
  const parts = String(raw).split("//");
  const level = normalizeMarking(parts[0] ?? "");
  if (markRank(policy, level) < 0) return null;
  const seen = new Set<string>();
  const caveats: string[] = [];
  for (const group of parts.slice(1)) {
    for (const tok of group.split("/")) {
      const code = normalizeMarking(tok);
      if (!code) continue;
      const def = findCaveat(policy, code);
      // Unknown/disabled, or legal only on a different level (a category qualifies exactly its level).
      if (!def || def.level !== level) return null;
      if (!seen.has(code)) {
        seen.add(code);
        caveats.push(code);
      }
    }
  }
  caveats.sort();
  return { level, caveats };
}

/** Lattice DOMINANCE: does `container` dominate `content` — is it at least as high AND does it carry a
 * SUPERSET of the content's caveats? This is the channel-ceiling test (the marked channel is the
 * container; a message it can't dominate is a spillage block). Generalizes the level-only `atMost`. */
export function dominates(policy: MarkingPolicy, container: Marking, content: Marking): boolean {
  if (markRank(policy, container.level) < markRank(policy, content.level)) return false;
  return content.caveats.every((c) => container.caveats.includes(c));
}

/** The least marking that dominates BOTH `a` and `b`: the higher level, carrying the union of the
 * caveats that are legal at that level (a caveat from the lower marking that doesn't apply to the
 * joined level is dropped). Used to RAISE an unmarked-channel message when an inline portion marking
 * exceeds what was requested. */
export function joinMarking(policy: MarkingPolicy, a: Marking, b: Marking): Marking {
  const level = markRank(policy, a.level) >= markRank(policy, b.level) ? a.level : b.level;
  const seen = new Set<string>();
  const caveats: string[] = [];
  for (const code of [...a.caveats, ...b.caveats]) {
    const def = findCaveat(policy, code);
    if (def && def.level === level && !seen.has(code)) {
      seen.add(code);
      caveats.push(code);
    }
  }
  caveats.sort();
  return { level, caveats };
}
