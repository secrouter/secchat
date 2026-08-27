// Detailed tamper-evidence verification for the admin / audit-review console (AU 3.3.8) — the
// full report backing `GET /admin/api/audit/verify` and the `auditChain` slice of the evidence
// bundle (`GET /admin/api/evidence`, src/admin/evidence.ts).
//
// `Store.verifyChains()` (src/admin/overview.ts) already gives the console a cheap boolean
// summary for both chains; this builds the DETAILED report an auditor actually needs to act on a
// failure — which channel broke, at what seq, and how many events/messages were actually
// checked — by recomputing both chains with the same pure verifiers used everywhere else
// (src/audit/chain.ts's verifyAuditChain/verifyMessageChain), never a second implementation.
//
// Depends only on the `Store` PORT (src/types.ts), same testability posture as buildOverview.

import { verifyAuditChain, verifyMessageChain } from "../audit/chain.ts";
import type { Store } from "../types.ts";

/** One channel's message-chain verdict. `checked` is the number of messages recomputed (0 for an
 * empty channel, which trivially verifies). `brokenAtSeq` is the 1-based seq of the first broken
 * link — absent when `ok`. */
export interface ChannelChainVerdict {
  channelId: string;
  ok: boolean;
  checked: number;
  brokenAtSeq?: number;
}

/** The global audit chain's verdict, in the same shape. */
export interface AuditChainVerdict {
  ok: boolean;
  checked: number;
  brokenAtSeq?: number;
}

export interface AuditVerifyResult {
  /** True only when the audit chain AND every message chain that was actually checked verify. A
   * `truncated` report (more channels than `channelLimit`) still reflects only what was checked —
   * it is not a claim about the unchecked remainder. */
  ok: boolean;
  audit: AuditChainVerdict;
  messages: ChannelChainVerdict[];
  /** True when the deployment has more channels than `channelLimit` — `messages` covers only the
   * first `channelLimit` (by `listChannels()` order), not every channel. */
  truncated: boolean;
  ts: string;
}

/** Cap on channels verified in one call — a deployment with thousands of channels shouldn't make
 * this admin-gated GET recompute unbounded chain work inline. Chosen generously: at typical
 * per-channel message counts this stays a sub-second operation even at the cap. */
const DEFAULT_CHANNEL_LIMIT = 500;

/** Recompute the audit chain end-to-end plus every channel's message chain (up to `channelLimit`),
 * reporting a per-channel verdict alongside the aggregate. Pure read — never mutates the store. */
export async function buildAuditVerify(store: Store, channelLimit = DEFAULT_CHANNEL_LIMIT): Promise<AuditVerifyResult> {
  const [auditEvents, channels] = await Promise.all([store.listAudit(), store.listChannels()]);

  const auditVerdict = verifyAuditChain(auditEvents);
  const audit: AuditChainVerdict = {
    ok: auditVerdict.ok,
    checked: auditEvents.length,
    ...(auditVerdict.brokenAt !== undefined ? { brokenAtSeq: auditVerdict.brokenAt } : {}),
  };

  const capped = channels.slice(0, channelLimit);
  const truncated = channels.length > capped.length;

  const messages: ChannelChainVerdict[] = [];
  let messagesOk = true;
  for (const channel of capped) {
    const channelMessages = await store.listMessages(channel.id);
    const verdict = verifyMessageChain(channelMessages);
    if (!verdict.ok) messagesOk = false;
    messages.push({
      channelId: channel.id,
      ok: verdict.ok,
      checked: channelMessages.length,
      ...(verdict.brokenAt !== undefined ? { brokenAtSeq: verdict.brokenAt } : {}),
    });
  }

  return {
    ok: audit.ok && messagesOk,
    audit,
    messages,
    truncated,
    ts: new Date().toISOString(),
  };
}
