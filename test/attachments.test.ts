// Store-level tests for the attachment DATA LAYER (A1a): unclaimed upload → claim at message post →
// the message binds the manifest digest, and the hash chain still verifies. Real MemoryStore.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory.ts";
import { attachmentsManifest } from "../src/attachments/manifest.ts";
import type { AddAttachmentInput } from "../src/types.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const upload = (channelId: string, sha: string, filename: string): AddAttachmentInput => ({
  channelId,
  uploadedBy: "alice",
  filename,
  contentType: "text/plain",
  byteSize: 12,
  sha256: sha,
  marking: "CUI",
});

test("attachments: upload (unclaimed) → claim on message post → manifest bound, chain verifies", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: "ws", kind: "human", name: "g", createdBy: "alice" });
  await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "owner" });

  // Two uploads, unclaimed (no message yet) → not in the channel's claimed list.
  const a1 = await store.addAttachment(upload(channel.id, SHA_A, "a.txt"));
  const a2 = await store.addAttachment(upload(channel.id, SHA_B, "b.txt"));
  assert.equal(a1.messageId, undefined);
  assert.deepEqual(await store.listAttachmentsForChannel(channel.id), []);
  assert.equal((await store.getAttachment(a1.id))?.sha256, SHA_A);

  // Post a message that CLAIMS them, binding the manifest digest computed from the claim order.
  const manifest = attachmentsManifest([a1, a2]);
  assert.match(manifest, /^[0-9a-f]{64}$/);
  const msg = await store.appendMessage({
    channelId: channel.id,
    authorRef: "alice",
    authorType: "user",
    content: "here are two files",
    attachmentsSha256: manifest,
  });
  const claimed = await store.claimAttachments(msg.id, [a1.id, a2.id]);
  assert.deepEqual(claimed.map((a) => a.filename), ["a.txt", "b.txt"], "claim order preserved");

  // The message binds the digest; the chain verifies with it.
  assert.equal(msg.attachmentsSha256, manifest);
  assert.equal((await store.verifyChains()).messagesOk, true);

  // Now claimed → visible on the message + channel, in upload order.
  assert.deepEqual((await store.listAttachmentsForMessage(msg.id)).map((a) => a.filename), ["a.txt", "b.txt"]);
  assert.deepEqual((await store.listAttachmentsForChannel(channel.id)).map((a) => a.sha256), [SHA_A, SHA_B]);
});

test("attachments: a message with none hashes as '' (unattached messages unchanged); claim is idempotent", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: "ws", kind: "human", createdBy: "alice" });
  await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "owner" });

  const plain = await store.appendMessage({ channelId: channel.id, authorRef: "alice", authorType: "user", content: "no files" });
  assert.equal(plain.attachmentsSha256, "");
  assert.equal(attachmentsManifest([]), "");

  const a = await store.addAttachment(upload(channel.id, SHA_A, "a.txt"));
  await store.claimAttachments(plain.id, [a.id]);
  // A second claim of an already-claimed attachment is a no-op (returns the message's set, unchanged).
  const again = await store.claimAttachments(plain.id, [a.id]);
  assert.equal(again.length, 1);
  assert.equal((await store.getAttachment(a.id))?.messageId, plain.id);
  assert.equal((await store.verifyChains()).messagesOk, true);
});
