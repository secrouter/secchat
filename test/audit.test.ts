// The crown-jewel integrity primitive gets the most thorough tests: valid chains verify,
// tampering is caught, and — the decision-#9 property — a redaction leaves the chain intact.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENESIS,
  computeAuditHash,
  computeMessageHash,
  hashContent,
  verifyAuditChain,
  verifyMessageChain,
} from "../src/audit/chain.ts";
import type { AuditEvent, Message } from "../src/types.ts";

/** Build a valid message chain of `n` links in the same channel — the way a Store should. */
function buildMessages(n: number): Message[] {
  const out: Message[] = [];
  let prev = GENESIS;
  for (let i = 1; i <= n; i++) {
    const base = {
      channelId: "chan-1",
      seq: i,
      authorRef: `user-${i}`,
      authorType: "user" as const,
      contentSha256: hashContent(`message ${i}`),
      marking: "UNCLASSIFIED",
      attachmentsSha256: "",
      createdAt: `2026-08-08T00:00:0${i}.000Z`,
    };
    const hash = computeMessageHash(prev, base);
    out.push({ id: `m${i}`, prevHash: prev, hash, ...base });
    prev = hash;
  }
  return out;
}

test("a well-formed message chain verifies", () => {
  assert.deepEqual(verifyMessageChain(buildMessages(5)), { ok: true });
});

test("tampering with content (without recomputing the hash) is detected", () => {
  const msgs = buildMessages(3);
  msgs[1] = { ...msgs[1]!, contentSha256: hashContent("forged") }; // change bound field, keep old hash
  const v = verifyMessageChain(msgs);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

test("reordering / a seq gap is detected", () => {
  const msgs = buildMessages(3);
  const swapped = [msgs[0]!, msgs[2]!, msgs[1]!];
  assert.equal(verifyMessageChain(swapped).ok, false);
});

test("REDACTION preserves the chain — plaintext gone, contentSha256 + hash intact", () => {
  const msgs = buildMessages(4);
  // Redaction removes plaintext elsewhere and stamps redactedAt; the row's bound fields are untouched.
  msgs[2] = { ...msgs[2]!, redactedAt: "2026-08-08T01:00:00.000Z" };
  assert.deepEqual(verifyMessageChain(msgs), { ok: true });
});

test("the audit (metadata) chain verifies and catches tampering", () => {
  const events: AuditEvent[] = [];
  let prev = GENESIS;
  for (let i = 1; i <= 3; i++) {
    const base = { seq: i, actor: "svc-secchat", actAs: `user-${i}`, action: "message.append", target: `m${i}`, at: `2026-08-08T00:00:0${i}.000Z` };
    const hash = computeAuditHash(prev, base);
    events.push({ id: `a${i}`, prevHash: prev, hash, ...base });
    prev = hash;
  }
  assert.deepEqual(verifyAuditChain(events), { ok: true });
  events[1] = { ...events[1]!, action: "message.delete" }; // tamper the action, keep the hash
  assert.equal(verifyAuditChain(events).ok, false);
});
