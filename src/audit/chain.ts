// The tamper-evident hash chains — SecChat's crown-jewel integrity primitive.
//
// Two chains, both here (pure functions over node:crypto — no I/O, so trivially testable):
//
//  1. MESSAGE chain (per channel): each message's `hash` is over the previous hash + the
//     message metadata + the CONTENT HASH. Because the chain binds `contentSha256` and never
//     the plaintext, a spillage purge can drop the plaintext (redaction tombstone) while the
//     chain still verifies — reconciling "tamper-evident" with "CUI must be purgeable"
//     (decision #9). A verifier reports the chain intact even for redacted rows.
//
//  2. AUDIT chain (global): metadata-only events (the SecRouter auditor pattern — content is
//     NEVER passed here), chained the same way, for who-did-what integrity.
//
// Hash construction is canonical (fixed field order, length-prefixed joins) so it can never be
// ambiguous or field-injectable, and is recomputed identically on verify.

import { createHash } from "node:crypto";
import type { AuditEvent, Message, Sha256Hex } from "../types.ts";

/** Chain anchor — the `prevHash` of the first entry in any chain. */
export const GENESIS: Sha256Hex = "0".repeat(64);

function sha256(input: string): Sha256Hex {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Length-prefixed join so no field value can forge a boundary (e.g. a message body that
 * contains our delimiter can't shift another field). */
function canonical(fields: Array<string | number>): string {
  return fields.map((f) => `${String(f).length}:${f}`).join("|");
}

/** SHA-256 of message CONTENT — what the chain binds and what `redactMessage` preserves. */
export function hashContent(plaintext: string): Sha256Hex {
  return sha256(plaintext);
}

/** The link hash for one message, given the previous link's hash. Deterministic; the exact
 * function `verifyMessageChain` recomputes. `contentSha256` (not the plaintext) is bound. */
export function computeMessageHash(
  prevHash: Sha256Hex,
  m: Pick<Message, "channelId" | "seq" | "authorRef" | "authorType" | "contentSha256" | "createdAt">,
): Sha256Hex {
  return sha256(
    canonical([prevHash, m.channelId, m.seq, m.authorRef, m.authorType, m.contentSha256, m.createdAt]),
  );
}

/** The link hash for one audit event. Metadata only (matches AuditEvent's fields). */
export function computeAuditHash(
  prevHash: Sha256Hex,
  e: Pick<AuditEvent, "seq" | "actor" | "actAs" | "action" | "target" | "at">,
): Sha256Hex {
  return sha256(
    canonical([prevHash, e.seq, e.actor, e.actAs ?? "", e.action, e.target ?? "", e.at]),
  );
}

export interface ChainVerdict {
  ok: boolean;
  /** 1-based index of the first entry whose recomputed hash/linkage failed, if any. */
  brokenAt?: number;
  reason?: string;
}

/** Recompute a channel's message chain end-to-end. Redacted rows verify fine — the chain binds
 * `contentSha256`, which redaction preserves; only the plaintext (held elsewhere) is gone. */
export function verifyMessageChain(messages: Message[]): ChainVerdict {
  let prev = GENESIS;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.seq !== i + 1) return { ok: false, brokenAt: i + 1, reason: `seq gap: expected ${i + 1}, got ${m.seq}` };
    if (m.prevHash !== prev) return { ok: false, brokenAt: i + 1, reason: "prevHash mismatch" };
    if (computeMessageHash(prev, m) !== m.hash) return { ok: false, brokenAt: i + 1, reason: "hash mismatch (tampered)" };
    prev = m.hash;
  }
  return { ok: true };
}

/** Recompute the global audit chain end-to-end. */
export function verifyAuditChain(events: AuditEvent[]): ChainVerdict {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i + 1) return { ok: false, brokenAt: i + 1, reason: `seq gap: expected ${i + 1}, got ${e.seq}` };
    if (e.prevHash !== prev) return { ok: false, brokenAt: i + 1, reason: "prevHash mismatch" };
    if (computeAuditHash(prev, e) !== e.hash) return { ok: false, brokenAt: i + 1, reason: "hash mismatch (tampered)" };
    prev = e.hash;
  }
  return { ok: true };
}
