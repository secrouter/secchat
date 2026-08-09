// CUI PORTION MARKING within a message. Per DoDI 5200.48 / the CUI marking convention, individual
// portions of a document (paragraphs, bullets, sentences) carry an abbreviated marking in
// parentheses — e.g. "(U) unclassified line" / "(CUI) a controlled line" / "(CUI//SP-PRVCY) a
// privacy portion" — and the overall marking of the whole is the HIGHEST of its portions (carrying,
// at that level, the union of their caveats). Here the portion markings are literal inline tokens in
// the message content (exactly the real convention, so no new storage or data model): this pure
// parser extracts them and derives the message's overall marking, which the HTTP layer then uses as
// the effective marking (still subject to the channel ceiling + the chain binding).
//
// Only tokens that resolve to a KNOWN marking of the deployment's policy count — so ordinary
// parenthetical prose like "(see below)" or "(TODO)" is never mistaken for a marking. "(U)" is
// accepted as the universal abbreviation for UNCLASSIFIED.

import { markRank, normalizeMarking, type MarkingPolicy } from "./policy.ts";
import { formatMarking, joinMarking, type Marking, parseMarking } from "./caveats.ts";

/** Resolve a parenthesized token to a Marking, or null if it isn't one. "(U)" is UNCLASSIFIED; any
 * other token is parsed as a full banner marking (`CUI`, `CUI//SP-PRVCY`) against the policy. If a
 * categorized token fails to fully parse (a malformed/unknown category) but its LEVEL is a known
 * rung, it still resolves to that bare level — fail-SAFE, so a typo'd category never under-marks a
 * portion (the worst case is a benign over-mark on marking-shaped prose). */
function resolvePortionToken(policy: MarkingPolicy, raw: string): Marking | null {
  const token = normalizeMarking(raw);
  if (token === "U") return policy.levels.includes("UNCLASSIFIED") ? { level: "UNCLASSIFIED", caveats: [] } : null;
  const full = parseMarking(policy, token);
  if (full) return full;
  if (token.includes("//")) {
    const level = normalizeMarking(token.split("//")[0] ?? "");
    if (markRank(policy, level) >= 0) return { level, caveats: [] };
  }
  return null;
}

/** Every distinct portion marking present in `content` (in first-seen order, de-duped by canonical
 * form). Empty when the message carries no inline portion markings. */
export function portionMarkings(policy: MarkingPolicy, content: string): Marking[] {
  const seen = new Set<string>();
  const out: Marking[] = [];
  // A parenthesized token: letters plus marking punctuation (space, /, -) so a category-qualified
  // marking like "CUI//SP-PRVCY" is captured whole; widened length allows multiple categories.
  const re = /\(([A-Za-z][A-Za-z /-]{0,47})\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const marking = resolvePortionToken(policy, match[1]!);
    if (marking) {
      const key = formatMarking(marking);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(marking);
      }
    }
  }
  return out;
}

/** The overall marking a portion-marked message warrants — the join (highest level + union of that
 * level's caveats) of its portion markings — or null when it carries none (the caller then falls
 * back to the requested / channel marking). */
export function overallPortionMarking(policy: MarkingPolicy, content: string): Marking | null {
  const marks = portionMarkings(policy, content);
  if (marks.length === 0) return null;
  return marks.reduce((hi, m) => joinMarking(policy, hi, m));
}
