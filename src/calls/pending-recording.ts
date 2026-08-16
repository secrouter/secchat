// Shared helper for the §2.4 "the artifact is never invisible" fix (v3.1 REQUIRED): claim a
// recording attachment onto a fresh, content-free system chat line the MOMENT it's ingested,
// rather than leaving it unclaimed (and so invisible in the DM — `listAttachmentsForMessage` only
// returns CLAIMED rows) until/unless a transcript later posts.
//
// Used by BOTH the live post-call pipeline (calls/registry.ts's `runPostCallPipeline`, right after
// `end()`) and the startup crash-recovery sweep (calls/mediad-client.ts's `reconcileUnclaimedSessions`,
// after a backend crash orphaned a session between mediad's finalize and the live pipeline's ingest
// step) — the two ONLY places recording bytes get attached to a call, and both need the exact same
// claim-immediately sequencing so a reconciled call is never left in the same "ingested but
// unclaimed" hole the live path was fixed for. Extracted here (rather than duplicated like
// mediad-client.ts's `deleteSessionDir`) because the two callers' claim/edit LOGIC must stay
// identical — only their surrounding pipeline (live vs. crash-recovery, transcription attempted vs.
// not) differs.

import { formatMarking, parseMarking } from "../marking/caveats.ts";
import type { MarkingPolicy } from "../marking/policy.ts";
import { attachmentsManifest } from "../attachments/manifest.ts";
import type { AppendMessageInput, Attachment, Id, Message, Store } from "../types.ts";

/** The narrow Store slice this module needs — matches this codebase's narrow-injection style (see
 * ws/hub.ts's `channelsForSub`, mediad-client.ts's own `reconcileStore`/`addAttachment` deps) rather
 * than threading a whole `Store` through just for this. A full `Store` structurally satisfies this. */
export type PendingRecordingStore = Pick<Store, "getChannel" | "appendMessage" | "claimAttachments" | "editMessage">;

export interface PendingRecordingDeps {
  store: PendingRecordingStore;
  marking: MarkingPolicy;
  /** Live-broadcasts the pending line (and its later edit) into the DM, same as every other
   * live-post path (index.ts's `broadcast` closure). */
  broadcast: (channelId: string, payload: unknown) => void;
}

/** The marking a plain, content-free system chat line should carry: the DM's own marking when set
 * (channel-as-portion, same rule the message-post route and governedAgentAppend both use), else the
 * policy floor. No DLP scan needed — there is no free text here, just a fixed notice string. */
export async function resolveChannelMarking(deps: Pick<PendingRecordingDeps, "store" | "marking">, channelId: Id): Promise<string> {
  const channel = await deps.store.getChannel(channelId);
  if (channel?.cuiMarking) {
    const parsed = parseMarking(deps.marking, channel.cuiMarking);
    if (parsed) return formatMarking(parsed);
  }
  return formatMarking({ level: deps.marking.default, caveats: [] });
}

/** Claim `attachment` onto a fresh system chat line RIGHT NOW — before transcription has even been
 * attempted. Fixed text, no spoken content ⇒ (like a missed-call notice) this bypasses
 * governedCallAppend's DLP/marking pipeline and posts+claims directly, mirroring http/server.ts's own
 * attach-on-post sequence (resolve marking -> appendMessage with attachmentsSha256 -> claimAttachments).
 * Returns the posted message's id so the caller can `editPendingRecordingMessage` it in place once the
 * real outcome (transcript posted / transcription failed / unavailable) is known, instead of leaving a
 * stale "pending" line or double-posting a second attachment claim (which `governedCallAppend` would
 * reject as `invalid_attachment` — already claimed). */
export async function postPendingRecordingMessage(
  deps: PendingRecordingDeps,
  call: { channelId: Id },
  attachment: Attachment,
  content: string,
): Promise<Id> {
  const marking = await resolveChannelMarking(deps, call.channelId);
  const attachmentsSha256 = attachmentsManifest([attachment]);
  const input: AppendMessageInput = {
    channelId: call.channelId,
    authorRef: "system",
    authorType: "system",
    content,
    marking,
    attachmentsSha256,
  };
  const message: Message = await deps.store.appendMessage(input);
  const claimed = await deps.store.claimAttachments(message.id, [attachment.id]);
  deps.broadcast(call.channelId, { type: "message", message: { ...message, content, attachments: claimed } });
  return message.id;
}

/** Revises the pending-recording line in place once the real outcome is known (transcript posted,
 * transcription failed/exhausted, or unavailable). Same "fixed, content-free system text, no DLP
 * needed" posture as the post above; mirrors http/server.ts's own `POST /messages/:id/edit` ->
 * `editMessage` -> broadcast(`message_edit`) sequence so already-connected clients (which handle live
 * edits for human messages the same way) update this line with no new wire type needed. */
export async function editPendingRecordingMessage(
  deps: PendingRecordingDeps,
  call: { channelId: Id },
  messageId: Id,
  content: string,
): Promise<void> {
  const updated = await deps.store.editMessage(messageId, "system", content);
  deps.broadcast(call.channelId, {
    type: "message_edit",
    messageId,
    channelId: call.channelId,
    content,
    editedAt: updated.editedAt,
    by: "system",
  });
}

/** `editPendingRecordingMessage`, tolerant of `pendingMessageId` being unset (the initial claim
 * attempt itself failed, already logged there) — the common early-return shape every exit path in
 * both pipelines needs, without repeating `if (pendingMessageId) try { } catch { }` at each one.
 * Never thrown past its caller — a failed edit leaves the "pending" line stale, which is a lesser
 * problem than the attachment being unclaimed ever was, so it's logged, not escalated. */
export async function editPendingIfClaimed(
  deps: PendingRecordingDeps,
  call: { channelId: Id },
  pendingMessageId: Id | undefined,
  content: string,
): Promise<void> {
  if (!pendingMessageId) return;
  try {
    await editPendingRecordingMessage(deps, call, pendingMessageId, content);
  } catch (err) {
    console.error(`pending-recording: editing pending message ${pendingMessageId} failed:`, err instanceof Error ? err.message : err);
  }
}
