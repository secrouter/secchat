// governance/append.ts's governedCallAppend — the call-transcript sibling of governedAgentAppend
// (test/governance-append.test.ts). Real MemoryStore + real marking/DLP policies — no fakes, so the
// "system" author, the attachment claim, the marking stamp, and the audit chain are the genuine
// article. See docs/plans/voice-calls-plan.md §2.4/§7: "attachment claimed; 'system' author
// asserted; DLP block case included" is the explicit test brief for this path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { governedCallAppend, SYSTEM_AUTHOR_REF } from "../src/governance/append.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";
import { DlpPolicy } from "../src/dlp/policy.ts";
import type { AddAttachmentInput } from "../src/types.ts";

const WORKSPACE = "ws-1";
const marking = makeMarkingPolicy(["UNCLASSIFIED", "CUI", "SECRET"], "UNCLASSIFIED", [
  { kind: "category", level: "CUI", code: "SP-PRVCY", name: "Privacy" },
]);
const SSN_RULE = { name: "ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b" };

async function makeDm(store: MemoryStore, cuiMarking?: string) {
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "dm", createdBy: "alice", cuiMarking });
  await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "member" });
  await store.addMember({ channelId: channel.id, memberRef: "bob", memberType: "user", role: "member" });
  return channel;
}

/** A system-ingested, UNCLAIMED mixed-recording attachment — mirrors what
 * MediadClient.endSession's server-side ingest would have already written (sha256 -> blobs.write ->
 * addAttachment, uploadedBy = "system") before governedCallAppend ever runs. */
async function addRecording(store: MemoryStore, channelId: string, mark: string) {
  const input: AddAttachmentInput = {
    channelId,
    uploadedBy: "system",
    filename: "mixed.m4a",
    contentType: "audio/mp4",
    byteSize: 123456,
    sha256: "c".repeat(64),
    marking: mark,
  };
  return store.addAttachment(input);
}

test("recorded call: transcript posts as \"system\", claims the recording attachment, audits call.transcribed", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);
  const recording = await addRecording(store, channel.id, "UNCLASSIFIED");

  const msg = await governedCallAppend(
    { store, marking },
    {
      channelId: channel.id,
      content: "Call — 2m 3s (recorded 2m 0s) — recorded with consent\n\n**Alice** [00:00] hey Bob",
      attachmentIds: [recording.id],
    },
  );

  assert.equal(msg.authorType, "system");
  assert.equal(msg.authorRef, SYSTEM_AUTHOR_REF);
  assert.match(msg.content, /hey Bob/);
  assert.equal(msg.attachments?.length, 1);
  assert.equal(msg.attachments?.[0]!.id, recording.id);

  // The attachment is CLAIMED (messageId set) and the manifest digest is bound into the chain.
  const claimed = await store.getAttachment(recording.id);
  assert.equal(claimed?.messageId, msg.id);
  assert.notEqual(msg.attachmentsSha256, "");
  assert.equal((await store.verifyChains()).messagesOk, true);

  const audit = await store.listAudit();
  const transcribed = audit.find((e) => e.action === "call.transcribed" && e.target === msg.id);
  assert.ok(transcribed, "call.transcribed audited");
  assert.equal(transcribed!.actor, SYSTEM_AUTHOR_REF);
});

test("a channel with no attachments still posts (v1 always has exactly one, but the path is generic)", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);

  const msg = await governedCallAppend({ store, marking }, { channelId: channel.id, content: "no audio in this fixture", attachmentIds: [] });
  assert.equal(msg.attachments, undefined);
  assert.equal(msg.attachmentsSha256, "");
});

test("MARKED DM: transcript + attachment both inherit the channel marking (channel-as-portion)", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store, "CUI//SP-PRVCY");
  const recording = await addRecording(store, channel.id, "CUI//SP-PRVCY");

  const msg = await governedCallAppend({ store, marking }, { channelId: channel.id, content: "a governed transcript", attachmentIds: [recording.id] });

  assert.equal(msg.marking, "CUI//SP-PRVCY");
});

test("DLP block: transcript TEXT withheld, but the recording attachment is STILL claimed", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);
  const recording = await addRecording(store, channel.id, "UNCLASSIFIED");
  const dlp = new DlpPolicy("block", [SSN_RULE]);

  const msg = await governedCallAppend(
    { store, marking, dlp },
    { channelId: channel.id, content: "**Alice** [00:03] my SSN is 123-45-6789", attachmentIds: [recording.id] },
  );

  assert.match(msg.content, /withheld.*ssn/i, "notice names the rule");
  assert.ok(!msg.content.includes("123-45-6789"), "the matched content never appears");
  assert.equal(msg.authorType, "system");

  // The audio is NOT dropped — the compliance artifact survives even though the text was blocked.
  const claimed = await store.getAttachment(recording.id);
  assert.equal(claimed?.messageId, msg.id);
  assert.equal(msg.attachments?.length, 1);

  const audit = await store.listAudit();
  const block = audit.find((e) => e.action === "message.dlp_block" && e.target === msg.id);
  assert.ok(block, "message.dlp_block audited");
  assert.ok(!String(block!.detail).includes("123-45-6789"), "audit detail is rule names, never content");
  assert.ok(audit.some((e) => e.action === "call.transcribed" && e.target === msg.id), "call.transcribed still audited on a block");
  assert.equal((await store.verifyChains()).messagesOk, true);
});

test("DLP flag mode: transcript persists in full, flagged and audited like a human post", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);
  const dlp = new DlpPolicy("flag", [SSN_RULE]);

  const msg = await governedCallAppend({ store, marking, dlp }, { channelId: channel.id, content: "SSN mentioned: 123-45-6789", attachmentIds: [] });

  assert.equal(msg.content, "SSN mentioned: 123-45-6789");
  assert.deepEqual(msg.dlpFlags, ["ssn"]);
  const audit = await store.listAudit();
  assert.ok(audit.some((e) => e.action === "message.dlp_flag" && e.target === msg.id));
});

test("portion marking above a marked channel's ceiling: withheld, recording still claimed", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store, "CUI"); // ceiling CUI; the transcript carries SECRET
  const recording = await addRecording(store, channel.id, "CUI");

  const msg = await governedCallAppend(
    { store, marking },
    { channelId: channel.id, content: "(SECRET) something above the channel ceiling was said", attachmentIds: [recording.id] },
  );

  assert.match(msg.content, /withheld.*ceiling/i);
  const claimed = await store.getAttachment(recording.id);
  assert.equal(claimed?.messageId, msg.id);
  const audit = await store.listAudit();
  assert.ok(audit.some((e) => e.action === "message.marking_withheld" && e.target === msg.id));
});

test("an attachment already claimed by another message is rejected (invalid_attachment) — withheld, nothing claimed twice", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);
  const recording = await addRecording(store, channel.id, "UNCLASSIFIED");
  const other = await store.appendMessage({ channelId: channel.id, authorRef: "alice", authorType: "user", content: "unrelated" });
  await store.claimAttachments(other.id, [recording.id]); // pre-claim it elsewhere

  const msg = await governedCallAppend({ store, marking }, { channelId: channel.id, content: "a transcript", attachmentIds: [recording.id] });

  assert.match(msg.content, /withheld/i);
  assert.equal(msg.attachments, undefined, "the already-claimed attachment isn't re-claimed onto this message");
  // Ownership is unchanged — still bound to the original message.
  assert.equal((await store.getAttachment(recording.id))?.messageId, other.id);
});

test("clean transcript in an unmarked channel: floor marking, no DLP flags", async () => {
  const store = new MemoryStore();
  const channel = await makeDm(store);
  const dlp = new DlpPolicy("block", [SSN_RULE]);

  const msg = await governedCallAppend({ store, marking, dlp }, { channelId: channel.id, content: "nothing sensitive was said", attachmentIds: [] });

  assert.equal(msg.marking, "UNCLASSIFIED");
  assert.equal(msg.dlpFlags, undefined);
  const audit = await store.listAudit();
  assert.ok(!audit.some((e) => e.action.startsWith("message.dlp")));
  assert.ok(audit.some((e) => e.action === "call.transcribed"));
});
