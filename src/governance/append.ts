// Governed append for MACHINE-authored content — assistant turns and coding-agent output.
//
// The HTTP post route runs the full governance stack inline (marking resolve/enforce, portion
// folding, DLP, mentions) — but machine output never passes through that route: the assistant
// path and the agent control plane append straight to the Store, which historically meant LLM
// output was stamped at the policy floor and NEVER DLP-scanned. This module closes that bypass:
// every machine append gets the same marking + DLP treatment as a human post, with the failure
// modes adapted for an async producer (there is no request to 422):
//
//   * marking: the channel's marking stamps the output (channel-as-portion, same as the route);
//     in an unmarked channel, inline portion markings RAISE the effective marking via the join.
//   * spillage: output whose portions EXCEED a marked channel's ceiling is WITHHELD — a clean
//     notice message is appended in its place (the turn is never silently dropped) and the event
//     is audited content-free.
//   * DLP block: same withhold-with-notice shape, audited as `message.dlp_block` (rule names
//     only). DLP flag: the output is appended and flagged exactly like a human post
//     (`message.dlp_flag` audit + `dlpFlags` riding the enriched result for live display).
//
// Returns the ENRICHED message (plaintext content + any dlpFlags) — the caller broadcasts that,
// never the original text, so withheld content can't leak via the live event.

import { dominates, joinMarking, parseMarking, formatMarking, type Marking } from "../marking/caveats.ts";
import type { MarkingPolicy } from "../marking/policy.ts";
import { overallPortionMarking } from "../marking/portions.ts";
import type { DlpPolicy } from "../dlp/policy.ts";
import { attachmentsManifest } from "../attachments/manifest.ts";
import type { Attachment, Id, Message, Store } from "../types.ts";

export interface GovernedAppendDeps {
  store: Store;
  marking: MarkingPolicy;
  /** Unset ⇒ no DLP scanning (deployments without a DLP policy), matching the route's default. */
  dlp?: DlpPolicy;
}

export interface GovernedAppendInput {
  channelId: Id;
  /** The agent whose turn this is (authorType is always "agent" here). */
  authorRef: string;
  content: string;
  promptedBy?: string;
  /** The model SecRouter served this turn (provenance metadata; see Message.model). */
  model?: string;
}

export type GovernedMessage = Message & { content: string; dlpFlags?: string[] };

/** See the file header. Never throws for governance reasons — a blocked turn appends a clean
 * notice instead — so an async producer's pipeline keeps flowing while the record stays honest. */
export async function governedAgentAppend(deps: GovernedAppendDeps, input: GovernedAppendInput): Promise<GovernedMessage> {
  const policy = deps.marking;
  const channel = await deps.store.getChannel(input.channelId);
  const channelMarking: Marking | null = channel?.cuiMarking ? parseMarking(policy, channel.cuiMarking) : null;

  // Effective marking: the channel's when marked (channel-as-portion), else the policy floor —
  // machine output carries no per-message "requested" marking of its own.
  let effective: Marking = channelMarking ?? { level: policy.default, caveats: [] };

  // Inline portion markings in the OUTPUT (a model can echo portion-marked source content).
  // Marked channel: a portion the channel can't dominate is spillage → withhold. Unmarked:
  // portions raise the overall marking, exactly like the route.
  const portionMax = overallPortionMarking(policy, input.content);
  if (portionMax) {
    if (channelMarking) {
      if (!dominates(policy, channelMarking, portionMax)) {
        return withhold(deps, input, effective, "marking_exceeds_channel",
          "output carried a portion marking above the channel ceiling");
      }
    } else if (!dominates(policy, effective, portionMax)) {
      effective = joinMarking(policy, effective, portionMax);
    }
  }

  // Local DLP (rule NAMES only, never content — identical to the route's scan).
  const dlpHits = deps.dlp ? deps.dlp.scan(input.content) : [];
  if (dlpHits.length > 0 && deps.dlp!.mode === "block") {
    return withhold(deps, input, effective, "dlp_block", `rule(s): ${dlpHits.join(", ")}`, dlpHits);
  }

  const message = await deps.store.appendMessage({
    channelId: input.channelId,
    authorRef: input.authorRef,
    authorType: "agent",
    content: input.content,
    promptedBy: input.promptedBy,
    marking: formatMarking(effective),
    model: input.model,
  });
  if (dlpHits.length > 0) {
    // flag mode: a provable, content-free trail on the audit chain — same action as the route.
    await deps.store.appendAudit({ actor: input.authorRef, action: "message.dlp_flag", target: message.id, detail: dlpHits.join(",") });
  }
  return { ...message, content: input.content, ...(dlpHits.length ? { dlpFlags: dlpHits } : {}) };
}

/** The withhold path: the real output is NOT persisted anywhere; a clean, floor/channel-marked
 * notice message records that a turn happened and why it was withheld (content-free), plus an
 * audit event. The notice is what the caller broadcasts. */
async function withhold(
  deps: GovernedAppendDeps,
  input: GovernedAppendInput,
  effective: Marking,
  reason: "dlp_block" | "marking_exceeds_channel",
  detail: string,
  rules: string[] = [],
): Promise<GovernedMessage> {
  const notice = reason === "dlp_block"
    ? `[output withheld — blocked by DLP ${rules.length === 1 ? "rule" : "rules"}: ${rules.join(", ")}]`
    : "[output withheld — it carried a portion marking above this channel's ceiling]";
  const message = await deps.store.appendMessage({
    channelId: input.channelId,
    authorRef: input.authorRef,
    authorType: "agent",
    content: notice,
    promptedBy: input.promptedBy,
    marking: formatMarking(effective),
  });
  await deps.store.appendAudit({
    actor: input.authorRef,
    action: reason === "dlp_block" ? "message.dlp_block" : "message.marking_withheld",
    target: message.id,
    detail,
  });
  return { ...message, content: notice };
}

// ── Voice calls: governed transcript append (docs/plans/voice-calls-plan.md §2.4, v2 REQUIRED #2) ─

/** The service principal `governedCallAppend` authors as (§8 O4 — the ONE deliberate type-model
 * extension the voice-calls plan makes: `AuthorType` gains `"system"`). Both call participants are
 * named IN the transcript body, not via `authorRef` — there's no natural single "author" for a
 * two-party conversation transcript, so this is a fixed service id, not a per-call value. */
export const SYSTEM_AUTHOR_REF = "system";

export interface GovernedCallAppendInput {
  channelId: Id;
  /** The assembled transcript body — header (`Call — 12m 34s (recorded 11m 58s) — recorded with
   * consent`) + merged speaker turns with REAL usernames (`**Alice** [00:12] …`, A7), produced by
   * transcribe/merge.ts's `mergeTranscripts` + `formatTranscript`. */
  content: string;
  /** The already-stored, UNCLAIMED mixed-recording attachment id(s) (MediadClient.endSession's
   * server-side ingest — sha256 -> BlobStore.write -> Store.addAttachment) to claim ATOMICALLY
   * with this post, mirroring the HTTP message-post route's manifest+claim logic
   * (attachments/manifest.ts's `attachmentsManifest` + `Store.claimAttachments`) — factored out
   * here since a machine-authored, no-request post bypasses that route entirely. Always exactly
   * one element in v1 (the ffmpeg-mixed playback file); an array for shape-parity with the route. */
  attachmentIds: Id[];
}

/** `governedAgentAppend`'s `GovernedMessage`, extended with the CLAIMED attachment rows (when any)
 * — the shape the HTTP route's own enriched broadcast carries (`attachments` alongside `content`),
 * so `CallRegistryDeps.broadcast` (calls/registry.ts) can fan out the recording exactly like a
 * human-posted attachment. `governedAgentAppend` never carries this (machine text has none). */
export type GovernedCallMessage = GovernedMessage & { attachments?: Attachment[] };

type AttachmentResolution =
  | { ok: true; attachments: Attachment[]; manifest: string; effective: Marking }
  | { ok: false; attachmentId: Id; reason: "invalid_attachment" | "marking_exceeds_channel" };

/** Resolve + marking-fold a set of UNCLAIMED attachment ids against a channel — the same shape the
 * HTTP message-post route inlines (read src/http/server.ts's `POST /channels/:id/messages` handler:
 * fetch each unclaimed row, fold its marking into the message's effective marking — raising an
 * unmarked channel, or spillage-blocking a marked one whose ceiling the file exceeds), factored out
 * here as the "shared path" the plan calls for (v2 REQUIRED #2) so `governedCallAppend` below (and
 * any future non-HTTP append site) doesn't reimplement it. Does NOT call `Store.claimAttachments` —
 * claiming happens after `Store.appendMessage`, once the manifest digest is actually bound into the
 * message hash, exactly like the route. */
async function resolveAttachmentsForAppend(
  store: Pick<Store, "getAttachment">,
  policy: MarkingPolicy,
  channelId: Id,
  attachmentIds: Id[],
  channelMarking: Marking | null,
  effective: Marking,
): Promise<AttachmentResolution> {
  const resolved: Attachment[] = [];
  for (const attachmentId of attachmentIds) {
    const a = await store.getAttachment(attachmentId);
    if (!a || a.channelId !== channelId || a.messageId != null) {
      return { ok: false, attachmentId, reason: "invalid_attachment" };
    }
    const am = parseMarking(policy, a.marking) ?? { level: policy.default, caveats: [] };
    if (channelMarking) {
      if (!dominates(policy, channelMarking, am)) {
        return { ok: false, attachmentId, reason: "marking_exceeds_channel" };
      }
    } else if (!dominates(policy, effective, am)) {
      effective = joinMarking(policy, effective, am);
    }
    resolved.push(a);
  }
  return { ok: true, attachments: resolved, manifest: attachmentsManifest(resolved), effective };
}

/** Governed append for a call TRANSCRIPT. Shares `governedAgentAppend`'s DLP/marking/withhold core
 * above (same channel-as-portion marking resolution, same local DLP scan/block/flag shape), but:
 *
 *   (a) authors as `SYSTEM_AUTHOR_REF` / `authorType: "system"` (§8 O4);
 *   (b) claims `input.attachmentIds` ATOMICALLY with the post — resolves + marking-folds them via
 *       `resolveAttachmentsForAppend` above, computes `attachmentsManifest` for
 *       `Message.attachmentsSha256`, and calls `Store.claimAttachments` right after
 *       `Store.appendMessage`, so the recording is tamper-evidently bound into the message hash
 *       chain exactly like a human-uploaded attachment (genuinely NEW code, not a reuse of the HTTP
 *       route — v2 REQUIRED #2's finding).
 *
 * Ordering deliberately differs from the HTTP route: attachments are resolved BEFORE the
 * content-portion / DLP checks (the route does the reverse, but the route can safely leave an
 * unclaimed upload untouched on an early reject — a browser can re-post). Here the attachment IS
 * the call's audio, already captured server-side with nowhere else to go; it must land on SOME
 * message regardless of what happens to the spoken-word TEXT, so a DLP block — or a portion marking
 * the channel can't dominate — still claims it (the compliance artifact is never dropped; only the
 * TEXT transcript is), via `withholdCall` below rather than the private `withhold()` helper above
 * (which never claims anything). The one case attachments AREN'T claimed is `attachmentId`'s OWN
 * marking exceeding the channel ceiling — claiming a too-high-classified file into a lower channel
 * would BE the spillage marking exists to prevent, so that one fails closed with the attachment left
 * unclaimed (a should-never-happen path: v1 always ingests exactly one file, server-side, expected
 * to already carry the call's own effective marking).
 *
 * Every path ends by auditing `call.transcribed` (§4's outcome-in-`action` convention — see
 * `call.start` / `call.consent.granted|declined` / `call.end` / `call.recording_stored`, the sibling
 * events this one completes the trail for) against whatever message actually got posted — the full
 * transcript, or a withheld notice — because from the CALL's perspective transcription did run
 * either way; only the governance layer chose whether the text was postable. Returns the enriched
 * message; the caller broadcasts it (same "never broadcast the original, only what this returns"
 * rule as `governedAgentAppend`) via the injected `broadcast` in `CallRegistryDeps`
 * (calls/registry.ts). */
export async function governedCallAppend(deps: GovernedAppendDeps, input: GovernedCallAppendInput): Promise<GovernedCallMessage> {
  const policy = deps.marking;
  const channel = await deps.store.getChannel(input.channelId);
  const channelMarking: Marking | null = channel?.cuiMarking ? parseMarking(policy, channel.cuiMarking) : null;
  let effective: Marking = channelMarking ?? { level: policy.default, caveats: [] };

  const resolved = await resolveAttachmentsForAppend(
    deps.store,
    policy,
    input.channelId,
    input.attachmentIds,
    channelMarking,
    effective,
  );
  if (!resolved.ok) {
    // Defensive-only (see the doc comment above) — audited content-free like every other withhold,
    // but nothing is claimed: claiming a too-high-classified attachment into this channel would
    // itself be the spillage this check exists to prevent. TODO(voice): once mediad-client.ts's
    // server-side ingest is live, confirm it always stamps the CALL's own effective marking on the
    // recording attachment so this branch stays unreachable in practice.
    return withholdCall(
      deps,
      input,
      effective,
      "marking_exceeds_channel",
      `attachment ${resolved.attachmentId}: ${resolved.reason}`,
      [],
    );
  }
  effective = resolved.effective;

  // Portion markings in the TRANSCRIBED TEXT (spoken CUI a participant said aloud) — identical
  // shape to governedAgentAppend's handling of a model's echoed portions, above.
  const portionMax = overallPortionMarking(policy, input.content);
  if (portionMax) {
    if (channelMarking) {
      if (!dominates(policy, channelMarking, portionMax)) {
        return withholdCall(
          deps,
          input,
          effective,
          "marking_exceeds_channel",
          "transcript carried a portion marking above the channel ceiling",
          resolved.attachments,
        );
      }
    } else if (!dominates(policy, effective, portionMax)) {
      effective = joinMarking(policy, effective, portionMax);
    }
  }

  // Local DLP (rule NAMES only, never content) — identical shape to governedAgentAppend's scan.
  const dlpHits = deps.dlp ? deps.dlp.scan(input.content) : [];
  if (dlpHits.length > 0 && deps.dlp!.mode === "block") {
    return withholdCall(deps, input, effective, "dlp_block", `rule(s): ${dlpHits.join(", ")}`, resolved.attachments, dlpHits);
  }

  const message = await deps.store.appendMessage({
    channelId: input.channelId,
    authorRef: SYSTEM_AUTHOR_REF,
    authorType: "system",
    content: input.content,
    marking: formatMarking(effective),
    attachmentsSha256: resolved.manifest,
  });
  const claimed = input.attachmentIds.length > 0 ? await deps.store.claimAttachments(message.id, input.attachmentIds) : [];
  if (dlpHits.length > 0) {
    // flag mode: a provable, content-free trail on the audit chain — same action as the route.
    await deps.store.appendAudit({ actor: SYSTEM_AUTHOR_REF, action: "message.dlp_flag", target: message.id, detail: dlpHits.join(",") });
  }
  await deps.store.appendAudit({ actor: SYSTEM_AUTHOR_REF, action: "call.transcribed", target: message.id });
  return {
    ...message,
    content: input.content,
    ...(dlpHits.length ? { dlpFlags: dlpHits } : {}),
    ...(claimed.length ? { attachments: claimed } : {}),
  };
}

/** The withhold path for a call transcript — see `governedCallAppend`'s doc comment for why this
 * can't delegate to the private `withhold()` helper above unchanged: a call's recording attachment
 * (when safe to claim — see the caller) is claimed onto the notice message, never left orphaned just
 * because the spoken-word TEXT was blocked/over-ceiling. Always finishes by auditing
 * `call.transcribed` in addition to the block/withhold-specific event, so the call's audit trail is
 * complete regardless of governance outcome. */
async function withholdCall(
  deps: GovernedAppendDeps,
  input: GovernedCallAppendInput,
  effective: Marking,
  reason: "dlp_block" | "marking_exceeds_channel",
  detail: string,
  attachments: Attachment[],
  rules: string[] = [],
): Promise<GovernedCallMessage> {
  const notice = reason === "dlp_block"
    ? `[transcript withheld — blocked by DLP ${rules.length === 1 ? "rule" : "rules"}: ${rules.join(", ")}]`
    : "[transcript withheld — it carried a portion marking above this channel's ceiling]";
  const manifest = attachmentsManifest(attachments);
  const message = await deps.store.appendMessage({
    channelId: input.channelId,
    authorRef: SYSTEM_AUTHOR_REF,
    authorType: "system",
    content: notice,
    marking: formatMarking(effective),
    attachmentsSha256: manifest,
  });
  const attachmentIds = attachments.map((a) => a.id);
  const claimed = attachmentIds.length > 0 ? await deps.store.claimAttachments(message.id, attachmentIds) : [];
  await deps.store.appendAudit({
    actor: SYSTEM_AUTHOR_REF,
    action: reason === "dlp_block" ? "message.dlp_block" : "message.marking_withheld",
    target: message.id,
    detail,
  });
  await deps.store.appendAudit({ actor: SYSTEM_AUTHOR_REF, action: "call.transcribed", target: message.id });
  return { ...message, content: notice, ...(claimed.length ? { attachments: claimed } : {}) };
}
