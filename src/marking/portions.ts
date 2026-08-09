// CUI PORTION MARKING within a message. Per DoDI 5200.48 / the CUI marking convention, individual
// portions of a document (paragraphs, bullets, sentences) carry an abbreviated marking in
// parentheses — e.g. "(U) unclassified line" / "(CUI) a controlled line" — and the overall marking
// of the whole is the HIGHEST of its portions. Here the portion markings are literal inline tokens
// in the message content (exactly the real convention, so no new storage or data model): this pure
// parser extracts them and derives the message's overall level, which the HTTP layer then uses as
// the effective marking (still subject to the channel ceiling + the chain binding).
//
// Only tokens that resolve to a KNOWN level of the deployment's ladder count — so ordinary
// parenthetical prose like "(see below)" or "(TODO)" is never mistaken for a marking. "(U)" is
// accepted as the universal abbreviation for UNCLASSIFIED.

import { isKnownMarking, markRank, normalizeMarking, type MarkingPolicy } from "./policy.ts";

/** Resolve a parenthesized token to a ladder level, or null if it isn't a marking. */
function resolvePortionToken(policy: MarkingPolicy, raw: string): string | null {
  const token = normalizeMarking(raw);
  if (token === "U") return policy.levels.includes("UNCLASSIFIED") ? "UNCLASSIFIED" : null;
  return isKnownMarking(policy, token) ? token : null;
}

/** Every distinct portion marking present in `content` (in first-seen order). Empty when the
 * message carries no inline portion markings. */
export function portionMarkings(policy: MarkingPolicy, content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // A short parenthesized token: letters plus a few marking punctuation chars (space, /, -).
  const re = /\(([A-Za-z][A-Za-z /-]{0,23})\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const level = resolvePortionToken(policy, match[1]!);
    if (level && !seen.has(level)) {
      seen.add(level);
      out.push(level);
    }
  }
  return out;
}

/** The overall marking a portion-marked message warrants — the HIGHEST of its portion markings — or
 * null when it carries none (the caller then falls back to the requested / channel marking). */
export function overallPortionMarking(policy: MarkingPolicy, content: string): string | null {
  const marks = portionMarkings(policy, content);
  if (marks.length === 0) return null;
  return marks.reduce((hi, m) => (markRank(policy, m) > markRank(policy, hi) ? m : hi));
}
