// Byte storage for attachments — deliberately SEPARATE from the metadata Store (src/types.ts), which
// holds only rows. Content-addressed: an attachment's bytes live at a path keyed by their sha256, so
// identical content is stored once (dedup) and the address is self-verifying. On-prem only: a local
// directory (FsBlobStore) in production, an in-memory Map (MemoryBlobStore) for tests/dev.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The sha256 (hex) of a byte buffer — the content address AND the value bound into the message hash. */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface BlobStore {
  /** Persist `bytes` under its content address `sha256` (idempotent — same content, same file). */
  write(sha256: string, bytes: Buffer): Promise<void>;
  /** The bytes for `sha256`, or null if absent (never stored, or purged on redaction). */
  read(sha256: string): Promise<Buffer | null>;
}

/** Filesystem-backed, content-addressed under `dir` (bytes at `<dir>/<sha256>`). */
export class FsBlobStore implements BlobStore {
  readonly #dir: string;
  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(sha256: string): string {
    // sha256 is always 64 lowercase hex (computed from the bytes / read off a trusted row), so it can
    // never traverse; guard anyway so a bad caller can't escape the uploads dir.
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("blob: invalid content address");
    return join(this.#dir, sha256);
  }

  async write(sha256: string, bytes: Buffer): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#path(sha256), bytes);
  }

  async read(sha256: string): Promise<Buffer | null> {
    try {
      return await readFile(this.#path(sha256));
    } catch {
      return null; // ENOENT (or a bad address) reads as "absent", not an error
    }
  }
}

/** In-memory blob store for tests / the dev in-memory deployment (no filesystem). */
export class MemoryBlobStore implements BlobStore {
  #blobs = new Map<string, Buffer>();
  async write(sha256: string, bytes: Buffer): Promise<void> {
    this.#blobs.set(sha256, Buffer.from(bytes));
  }
  async read(sha256: string): Promise<Buffer | null> {
    const b = this.#blobs.get(sha256);
    return b ? Buffer.from(b) : null;
  }
}
