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
import type { Id, Message, Store } from "../types.ts";

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
