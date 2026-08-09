// The classification-marking policy — a pure, ordered ladder of levels (low → high sensitivity),
// dependency-free so it's trivially testable and shared by the store, the HTTP enforcement, and
// the audit console. The taxonomy is a DEPLOYMENT SETTING (config-driven); the default level is
// always the LOWEST rung, so nothing is ever auto-mismarked upward (fail-safe UNCLASSIFIED).
//
// Model (decisions from the CUI-marking design):
//   * A channel MAY carry a marking. When it does, the channel IS the portion — every message in
//     it takes that level. When a channel is unmarked ("unspecified") or is a DM, marking is
//     per-message.
//   * A message's stored marking is its EFFECTIVE level, stamped at write and bound into the hash
//     chain (see audit/chain.ts) — a marking you could silently alter wouldn't be a control.
//   * Enforcement is by RANK (index in the ladder): content may never sit in a channel whose
//     ceiling is lower than the content's marking (spillage block), and lowering a marking
//     (downgrade) is a privileged, audited act.

/** An ordered ladder. `levels[0]` is the lowest (the fail-safe default); higher index = more
 * sensitive. `default` is always a member of `levels` (validated at construction). */
export interface MarkingPolicy {
  levels: string[];
  default: string;
}

/** Built-in deployment PROFILES: each is a named preset of the marking ladder + its baseline/default,
 * chosen by the deployment's posture. The taxonomy IS the ceiling — a level absent from the profile
 * can never be selected or sent (so CLASSIFIED simply doesn't exist on an unclass system). The
 * baseline (= `default`) is the "everything is this unless labelled" floor whose display is
 * suppressed (no UNCLASSIFIED chrome cluttering the UI); markings show only ABOVE it. */
export interface MarkingProfileDef {
  levels: string[];
  default: string;
}

export const MARKING_PROFILES: Readonly<Record<string, MarkingProfileDef>> = {
  // DoD unclassified system (the default): up to CUI. CLASSIFIED is deliberately absent.
  "dod-cui": { levels: ["UNCLASSIFIED", "PROPRIETARY", "CUI"], default: "UNCLASSIFIED" },
  // A classified deployment unlocks the classified tiers — only when explicitly configured.
  "dod-classified": {
    levels: ["UNCLASSIFIED", "PROPRIETARY", "CUI", "CONFIDENTIAL", "SECRET", "TOP SECRET"],
    default: "UNCLASSIFIED",
  },
  // Non-defense / commercial: everything is unclassified unless labelled PROPRIETARY or SENSITIVE
  // (the CUI-equivalent tier covering PII + other regulated data). No defense/classified markings.
  commercial: { levels: ["UNCLASSIFIED", "PROPRIETARY", "SENSITIVE"], default: "UNCLASSIFIED" },
};

export const DEFAULT_MARKING_PROFILE = "dod-cui";

/** The out-of-the-box ladder when a deployment sets no profile or levels — the `dod-cui` profile. */
export const DEFAULT_MARKING_LEVELS: readonly string[] = MARKING_PROFILES[DEFAULT_MARKING_PROFILE]!.levels;

/** The floor / fail-safe default level. A store stamps this when nobody specified a marking and the
 * channel is unmarked (real posts go through the HTTP layer, which passes the configured default). */
export const DEFAULT_MARKING = "UNCLASSIFIED";

/** Resolve a profile name to its definition, or throw (fails closed on an unknown profile). */
export function markingProfile(name: string): MarkingProfileDef {
  const p = MARKING_PROFILES[name];
  if (!p) throw new Error(`marking: unknown profile "${name}" (want ${Object.keys(MARKING_PROFILES).join("|")})`);
  return p;
}

/** Normalize a raw level token: trim + uppercase (markings are case-insensitive on the wire, canonical
 * upper in storage/display). Returns "" for blank input. */
export function normalizeMarking(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Parse a comma/whitespace-separated ladder (e.g. the `SECCHAT_MARKING_LEVELS` env) into an ordered,
 * de-duplicated, upper-cased list, preserving first-seen order. */
export function parseMarkingLevels(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const level = normalizeMarking(part);
    if (level && !seen.has(level)) {
      seen.add(level);
      out.push(level);
    }
  }
  return out;
}

/** Build + validate a policy. Fails CLOSED: a ladder must be non-empty and its default must be one
 * of its levels (a default outside the ladder would let nothing be posted). Throws otherwise. */
export function makeMarkingPolicy(levels: string[], def: string): MarkingPolicy {
  const normalized = levels.map(normalizeMarking).filter((l) => l.length > 0);
  if (normalized.length === 0) throw new Error("marking policy: at least one level is required");
  if (new Set(normalized).size !== normalized.length) throw new Error("marking policy: levels must be unique");
  const dflt = normalizeMarking(def);
  if (!normalized.includes(dflt)) {
    throw new Error(`marking policy: default "${dflt}" is not one of the levels [${normalized.join(", ")}]`);
  }
  return { levels: normalized, default: dflt };
}

/** Rank (0-based, higher = more sensitive) of a level, or -1 if the level isn't in the ladder. */
export function markRank(policy: MarkingPolicy, level: string): number {
  return policy.levels.indexOf(normalizeMarking(level));
}

/** Whether `level` is a known rung of the ladder. */
export function isKnownMarking(policy: MarkingPolicy, level: string): boolean {
  return markRank(policy, level) >= 0;
}

/** True when `a` is no more sensitive than `b` (rank(a) ≤ rank(b)). Unknown levels are never ≤ anything. */
export function markingAtMost(policy: MarkingPolicy, a: string, b: string): boolean {
  const ra = markRank(policy, a);
  const rb = markRank(policy, b);
  return ra >= 0 && rb >= 0 && ra <= rb;
}

/** Whether `level` sits ABOVE the baseline (the default/floor) — i.e. it warrants a visible marking.
 * Baseline (and anything at/below it, or unknown) is NOT elevated, so its display is suppressed. */
export function isElevatedMarking(policy: MarkingPolicy, level: string): boolean {
  const r = markRank(policy, level);
  return r > markRank(policy, policy.default);
}
