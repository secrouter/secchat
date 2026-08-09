// Local DLP (data-loss prevention) — a pure, on-premise content scanner run on every message post.
// No content ever leaves the box; the rules are named regexes and a match records only the RULE
// NAME (never the matched text — that would re-leak the very thing DLP exists to contain). It pairs
// with the marking + redaction controls: marking prevents mis-classification, DLP catches sensitive
// data in the body, and a flagged message can then be redacted (a governed purge).
//
// Three modes (a deployment setting):
//   * off   — no scanning.
//   * flag  — post the message, but record an audited `message.dlp_flag` event and alert live. The
//             default: detect + provable trail without blocking legitimate work (DLP false positives
//             make hard-blocking arbitrary chat risky).
//   * block — refuse the post (HTTP 422) when any rule matches; nothing is written.
//
// Rules are deliberately server-side only (never sent to the client) — exposing the patterns would
// help an insider tune content to evade them.

export type DlpMode = "off" | "flag" | "block";

export interface DlpRule {
  /** Short, stable identifier recorded in the audit trail on a match (metadata, not the content). */
  name: string;
  /** A JavaScript regex source, compiled case-insensitively at construction (fails closed if bad). */
  pattern: string;
}

/** Conservative, low-false-positive defaults, chosen NOT to trip on ordinary discussion (e.g. the
 * word "CUI" alone is not a rule — only unambiguous PII and explicit control markings are). A
 * deployment can replace this list via config. */
export const DEFAULT_DLP_RULES: readonly DlpRule[] = [
  { name: "us-ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b" },
  { name: "credit-card", pattern: "\\b(?:\\d[ -]?){13,16}\\b" },
  // Explicit dissemination / classification control markings that shouldn't appear in body text of
  // a channel that isn't itself marked for them — a strong spillage signal.
  { name: "control-marking", pattern: "\\bNOFORN\\b|\\bORCON\\b|//SP-|\\bSECRET//|\\bTOP\\s+SECRET//" },
];

/** The compiled DLP policy. Construction validates the mode and pre-compiles every rule's regex,
 * throwing on a malformed pattern (fail-closed at startup — never silently un-scanning). */
export class DlpPolicy {
  readonly mode: DlpMode;
  readonly rules: DlpRule[];
  readonly #compiled: Array<{ name: string; re: RegExp }>;

  constructor(mode: DlpMode, rules: readonly DlpRule[]) {
    if (mode !== "off" && mode !== "flag" && mode !== "block") {
      throw new Error(`DLP: invalid mode "${mode}" (want off|flag|block)`);
    }
    this.mode = mode;
    this.rules = rules.map((r) => ({ name: r.name, pattern: r.pattern }));
    this.#compiled = this.rules.map((r) => {
      try {
        return { name: r.name, re: new RegExp(r.pattern, "i") };
      } catch (err) {
        throw new Error(`DLP: rule "${r.name}" has an invalid pattern: ${(err as Error).message}`);
      }
    });
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  /** The names of every rule that matches [content], in rule order (empty when off or no match).
   * Returns names only — never the matched substrings. */
  scan(content: string): string[] {
    if (this.mode === "off" || !content) return [];
    const hits: string[] = [];
    for (const { name, re } of this.#compiled) {
      // Fresh test each rule; `re` has no /g state to reset since we only ever call .test once.
      if (re.test(content)) hits.push(name);
    }
    return hits;
  }
}

/** Parse the optional `SECCHAT_DLP_RULES` JSON override into a rule list, or return the defaults.
 * Fails closed: malformed JSON, or an entry missing name/pattern, throws (never silently empty). */
export function parseDlpRules(raw: string | undefined): DlpRule[] {
  if (!raw || !raw.trim()) return [...DEFAULT_DLP_RULES];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`DLP: SECCHAT_DLP_RULES is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("DLP: SECCHAT_DLP_RULES must be a JSON array");
  return parsed.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e?.name !== "string" || typeof e?.pattern !== "string") {
      throw new Error(`DLP: SECCHAT_DLP_RULES[${i}] needs string "name" and "pattern"`);
    }
    return { name: e.name, pattern: e.pattern };
  });
}
