// The attachments-manifest digest that a message binds into its hash chain (Message.attachmentsSha256,
// see src/audit/chain.ts). It is a sha256 over the ORDERED `sha256|filename|byteSize|marking` of each
// attachment — so which files a message carries, their content hashes, names, sizes AND markings are
// all tamper-evident: change any of them (or add/remove/reorder a file) and the message hash no longer
// verifies. A message with no attachments hashes as '' (identical to how it hashed before attachments
// existed), so unattached messages are unaffected.

import { createHash } from "node:crypto";
import type { Attachment } from "../types.ts";

type ManifestPart = Pick<Attachment, "sha256" | "filename" | "byteSize" | "marking">;

/** The manifest digest for `attachments` (in claim/upload order), or '' when there are none. */
export function attachmentsManifest(attachments: ManifestPart[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((a) => `${a.sha256}|${a.filename}|${a.byteSize}|${a.marking}`);
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
