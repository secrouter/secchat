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

/** The kind of a caveat — the extra, UNRANKED qualifier a marking can carry beyond its level.
 * Today only `category` (a CUI Registry category, e.g. SP-PRVCY) exists; the discriminator is here
 * from day one so Limited Dissemination Controls (NOFORN, REL TO …) and classified compartments
 * (SI, TK, SAR …) can be added later as new kinds WITHOUT changing the marking data model. */
export type CaveatKind = "category";

/** A caveat definition in the deployment's marking vocabulary. Caveats are a SET, not a ladder —
 * they don't compare by rank; a container dominates content only if it carries a SUPERSET of the
 * content's caveats (see caveats.ts `dominates`). A `category` legally attaches to exactly one
 * level (its `level`) — you cannot put a CUI category on an UNCLASSIFIED message. */
export interface CaveatDef {
  /** The canonical banner token exactly as it appears in a marking string, e.g. "SP-PRVCY".
   * Upper-cased; matched case-insensitively on the wire. */
  code: string;
  /** Human-readable label, e.g. "Privacy". */
  name: string;
  /** What kind of caveat this is (see CaveatKind). */
  kind: CaveatKind;
  /** The ladder level this caveat qualifies (a category attaches to exactly this level). */
  level: string;
}

/** A curated STARTER set of CUI Specified categories (DoDI 5200.48 / the ISOO CUI Registry), all
 * attaching to the CUI level. Deliberately small and editable: a deployment overrides the whole set
 * via `SECCHAT_MARKING_CATEGORIES`, and the exact abbreviations / Basic-vs-Specified (`SP-`) prefix
 * should be VERIFIED against the relevant agency's CUI Registry entry — this is the mechanism plus a
 * reasonable default, not an authoritative Registry. */
export const DEFAULT_CUI_CATEGORIES: readonly CaveatDef[] = [
  { kind: "category", level: "CUI", code: "SP-PRVCY", name: "Privacy" },
  { kind: "category", level: "CUI", code: "SP-EXPT", name: "Export Controlled" },
  { kind: "category", level: "CUI", code: "SP-CTI", name: "Controlled Technical Information" },
  { kind: "category", level: "CUI", code: "SP-PCII", name: "Protected Critical Infrastructure Information" },
  { kind: "category", level: "CUI", code: "SP-SSI", name: "Sensitive Security Information" },
  { kind: "category", level: "CUI", code: "SP-NNPI", name: "Naval Nuclear Propulsion Information" },
  { kind: "category", level: "CUI", code: "SP-UCNI", name: "Unclassified Controlled Nuclear Information" },
];

/** An ordered ladder. `levels[0]` is the lowest (the fail-safe default); higher index = more
 * sensitive. `default` is always a member of `levels` (validated at construction). `caveats` is the
 * enabled, level-applicable caveat vocabulary (categories today) — always filtered so every caveat's
 * `level` is a rung of `levels` (an inapplicable caveat is dropped, never offered or accepted). */
export interface MarkingPolicy {
  levels: string[];
  default: string;
  caveats: CaveatDef[];
}

/** Built-in deployment PROFILES: each is a named preset of the marking ladder + its baseline/default,
 * chosen by the deployment's posture. The taxonomy IS the ceiling — a level absent from the profile
 * can never be selected or sent (so CLASSIFIED simply doesn't exist on an unclass system). The
 * baseline (= `default`) is the "everything is this unless labelled" floor whose display is
 * suppressed (no UNCLASSIFIED chrome cluttering the UI); markings show only ABOVE it. */
export interface MarkingProfileDef {
  levels: string[];
  default: string;
  /** The CUI categories this profile enables (the defense profiles ship the starter set; commercial
   * has no CUI so none). Filtered to applicable levels at policy construction. */
  categories?: CaveatDef[];
}

export const MARKING_PROFILES: Readonly<Record<string, MarkingProfileDef>> = {
  // DoD unclassified system (the default): up to CUI. CLASSIFIED is deliberately absent.
  "dod-cui": {
    levels: ["UNCLASSIFIED", "PROPRIETARY", "CUI"],
    default: "UNCLASSIFIED",
    categories: [...DEFAULT_CUI_CATEGORIES],
  },
  // A classified deployment unlocks the classified tiers — only when explicitly configured. CUI
  // categories still apply to CUI; classified compartments/caveats are a later caveat kind.
  "dod-classified": {
    levels: ["UNCLASSIFIED", "PROPRIETARY", "CUI", "CONFIDENTIAL", "SECRET", "TOP SECRET"],
    default: "UNCLASSIFIED",
    categories: [...DEFAULT_CUI_CATEGORIES],
  },
  // Non-defense / commercial: everything is unclassified unless labelled PROPRIETARY or SENSITIVE
  // (the CUI-equivalent tier covering PII + other regulated data). No defense/classified markings,
  // and no CUI categories (there is no CUI level here).
  commercial: { levels: ["UNCLASSIFIED", "PROPRIETARY", "SENSITIVE"], default: "UNCLASSIFIED", categories: [] },
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
 * of its levels (a default outside the ladder would let nothing be posted). Caveats are normalized
 * (upper-cased code/level), de-duplicated by code, and FILTERED to those whose `level` is a rung of
 * the ladder — an inapplicable caveat (e.g. a CUI category on a ladder without CUI) is silently
 * dropped, never offered or accepted. Throws on an invalid ladder. */
export function makeMarkingPolicy(levels: string[], def: string, caveats: CaveatDef[] = []): MarkingPolicy {
  const normalized = levels.map(normalizeMarking).filter((l) => l.length > 0);
  if (normalized.length === 0) throw new Error("marking policy: at least one level is required");
  if (new Set(normalized).size !== normalized.length) throw new Error("marking policy: levels must be unique");
  const dflt = normalizeMarking(def);
  if (!normalized.includes(dflt)) {
    throw new Error(`marking policy: default "${dflt}" is not one of the levels [${normalized.join(", ")}]`);
  }
  const seen = new Set<string>();
  const applicable: CaveatDef[] = [];
  for (const c of caveats) {
    const code = normalizeMarking(c.code);
    const level = normalizeMarking(c.level);
    if (!code || !normalized.includes(level) || seen.has(code)) continue;
    seen.add(code);
    applicable.push({ code, name: c.name.trim() || code, kind: c.kind, level });
  }
  return { levels: normalized, default: dflt, caveats: applicable };
}

/** The enabled caveats that qualify a given level (e.g. the CUI categories offered on a CUI message). */
export function caveatsForLevel(policy: MarkingPolicy, level: string): CaveatDef[] {
  const lvl = normalizeMarking(level);
  return policy.caveats.filter((c) => c.level === lvl);
}

/** Look up an enabled caveat by its (case-insensitive) code, or undefined if unknown/disabled. */
export function findCaveat(policy: MarkingPolicy, code: string): CaveatDef | undefined {
  const c = normalizeMarking(code);
  return policy.caveats.find((cv) => cv.code === c);
}

/** Parse the `SECCHAT_MARKING_CATEGORIES` override — a JSON array of `{code, name, level?, kind?}`
 * (level defaults to "CUI", kind to "category"). Fails CLOSED (throws) on malformed JSON or a
 * non-array so a typo can't silently disable categories. An empty string ⇒ [] (explicitly none). */
export function parseCaveatDefs(raw: string | undefined): CaveatDef[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`SECCHAT_MARKING_CATEGORIES: not valid JSON (${(e as Error).message})`);
  }
  if (!Array.isArray(parsed)) throw new Error("SECCHAT_MARKING_CATEGORIES: must be a JSON array");
  return parsed.map((entry, i) => {
    const o = entry as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code.trim() : "";
    if (!code) throw new Error(`SECCHAT_MARKING_CATEGORIES[${i}]: missing "code"`);
    const kind = (o.kind as CaveatKind) ?? "category";
    if (kind !== "category") throw new Error(`SECCHAT_MARKING_CATEGORIES[${i}]: unsupported kind "${String(o.kind)}"`);
    return {
      code,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : code,
      kind,
      level: typeof o.level === "string" && o.level.trim() ? o.level : "CUI",
    };
  });
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
