// Per-user git SSH identities — generated server-side so they can be INJECTED into the agentic
// runtimes (the Kubernetes pool pod and the desktop runner daemon) for git authentication, without
// the user ever pasting a private key anywhere. An ed25519 keypair is minted with Node's built-in
// crypto (no npm dependency — matches the jose+pg discipline), hand-encoded into the exact OpenSSH
// wire formats `ssh`/`git` expect, and the PRIVATE half is held AES-256-GCM-encrypted at rest
// (src/store) under a deployment master key; only the PUBLIC key + fingerprint ever leave the
// server. The private key is decrypted solely to hand it to a runner the requesting user owns.
//
// Why hand-encode instead of shelling out to `ssh-keygen`: the backend must run air-gapped and can't
// assume ssh-keygen is on PATH, and generating in-process keeps the private bytes off disk except
// where WE choose to write them (encrypted). The OpenSSH formats are small, deterministic, and
// fully covered by test/ssh-keys.test.ts (round-tripped against the real `ssh-keygen` when present).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

/** The generated identity. `privateKeyOpenSSH` is the sensitive half — it is encrypted before it
 * ever touches the store and is NEVER included in an API response (see http/server.ts's projection
 * to a public shape). `publicKey` is an `authorized_keys` line; `fingerprint` matches
 * `ssh-keygen -lf` (`SHA256:...`). */
export interface GeneratedSshKey {
  keyType: "ssh-ed25519";
  publicKey: string; // "ssh-ed25519 AAAA... <comment>"
  privateKeyOpenSSH: string; // "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END..."
  fingerprint: string; // "SHA256:<base64 no padding>"
}

const KEY_TYPE = "ssh-ed25519";
const AUTH_MAGIC = Buffer.from("openssh-key-v1\0", "binary"); // 15 bytes incl. trailing NUL

/** SSH wire `string`: a 4-byte big-endian length prefix followed by the bytes. The one primitive
 * every OpenSSH blob is built from. */
function sshString(bytes: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function sshUint32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** The public-key blob: string("ssh-ed25519") || string(A). Shared by the authorized_keys line, the
 * OpenSSH private file, and the fingerprint — so all three describe the same key by construction. */
function ed25519PublicBlob(publicRaw: Buffer): Buffer {
  return Buffer.concat([sshString(Buffer.from(KEY_TYPE)), sshString(publicRaw)]);
}

/** `SHA256:<base64(sha256(blob)) without padding>` — byte-for-byte what `ssh-keygen -lf` prints. */
function fingerprintOf(publicBlob: Buffer): string {
  const digest = createHash("sha256").update(publicBlob).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** Wrap raw bytes as an `authorized_keys` line: `ssh-ed25519 <base64(blob)> <comment>`. */
function authorizedKeysLine(publicRaw: Buffer, comment: string): string {
  const b64 = ed25519PublicBlob(publicRaw).toString("base64");
  return comment ? `${KEY_TYPE} ${b64} ${comment}` : `${KEY_TYPE} ${b64}`;
}

/** Encode the OpenSSH v1 private-key file for an ed25519 key with NO passphrase (cipher/kdf "none").
 * The at-rest confidentiality is provided by our own AES-256-GCM envelope, not by an SSH passphrase —
 * so the on-the-wire form handed to a runner is a standard unencrypted OpenSSH key it can use
 * directly. Structure per PROTOCOL.key: magic, ciphername, kdfname, kdfoptions, key-count, the public
 * blob, then a length-prefixed private section (two matching check-ints, the key, a comment, and
 * 1..n padding to an 8-byte boundary). */
function encodeOpenSshPrivateKey(publicRaw: Buffer, seed: Buffer, comment: string): string {
  const publicBlob = ed25519PublicBlob(publicRaw);
  // OpenSSH's ed25519 private field is seed(32) || public(32).
  const privateRaw = Buffer.concat([seed, publicRaw]);

  const check = randomBytes(4); // two identical check-ints guard against a bad passphrase on decrypt
  let inner = Buffer.concat([
    check,
    check,
    sshString(Buffer.from(KEY_TYPE)),
    sshString(publicRaw),
    sshString(privateRaw),
    sshString(Buffer.from(comment)),
  ]);
  // Pad the inner block to a multiple of 8 (the "none" cipher's block size) with 1,2,3,… .
  const blockSize = 8;
  const padLen = (blockSize - (inner.length % blockSize)) % blockSize;
  if (padLen > 0) {
    const pad = Buffer.allocUnsafe(padLen);
    for (let i = 0; i < padLen; i++) pad[i] = i + 1;
    inner = Buffer.concat([inner, pad]);
  }

  const body = Buffer.concat([
    AUTH_MAGIC,
    sshString(Buffer.from("none")), // ciphername
    sshString(Buffer.from("none")), // kdfname
    sshString(Buffer.alloc(0)), // kdfoptions (empty)
    sshUint32(1), // number of keys
    sshString(publicBlob),
    sshString(inner),
  ]);

  // PEM-ish framing: base64 wrapped at 70 columns between the OpenSSH markers.
  const b64 = body.toString("base64");
  const lines = b64.match(/.{1,70}/g) ?? [b64];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** Mint a fresh ed25519 identity. `comment` becomes the trailing comment on both the public line and
 * inside the private file (conventionally an email / label — here the owner's sub or email). */
export function generateEd25519(comment = ""): GeneratedSshKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  // JWK export gives the raw 32-byte public (`x`) and private seed (`d`) directly (RFC 8037 OKP),
  // avoiding brittle DER offset arithmetic.
  const jwk = privateKey.export({ format: "jwk" }) as { x?: string; d?: string };
  if (!jwk.x || !jwk.d) throw new Error("ed25519 key export missing x/d");
  const publicRaw = Buffer.from(jwk.x, "base64url");
  const seed = Buffer.from(jwk.d, "base64url");
  if (publicRaw.length !== 32 || seed.length !== 32) throw new Error("unexpected ed25519 key size");

  return {
    keyType: KEY_TYPE,
    publicKey: authorizedKeysLine(publicRaw, comment),
    privateKeyOpenSSH: encodeOpenSshPrivateKey(publicRaw, seed, comment),
    fingerprint: fingerprintOf(ed25519PublicBlob(publicRaw)),
  };
}

/** Fingerprint an existing `authorized_keys` line (the `ssh-ed25519 <base64> [comment]` form) exactly
 * as `ssh-keygen -lf` would. Throws on anything that isn't a well-formed ed25519 public line. */
export function fingerprintPublicKey(publicLine: string): string {
  const parts = publicLine.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== KEY_TYPE) throw new Error("not an ssh-ed25519 public key");
  const blob = Buffer.from(parts[1]!, "base64");
  return fingerprintOf(blob);
}

// ── At-rest encryption for the private key (AES-256-GCM, node:crypto — no dependency) ──────────

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12; // GCM standard nonce length

/** Derive the 32-byte AES key from the deployment's `SECCHAT_SECRET_KEY`. The secret may be any
 * high-entropy string; SHA-256 folds it to a fixed 256-bit key so operators aren't forced to supply
 * exactly 32 raw bytes. (Documented in docs as: use a long random secret.) */
export function deriveSecretKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Encrypt a UTF-8 secret into a self-describing envelope string: `v1.<iv>.<tag>.<ciphertext>` with
 * each field base64url. Safe to persist as opaque text (the store treats it as a blob). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** Inverse of encryptSecret. Throws on a malformed envelope, an unknown version, or a failed GCM
 * auth check (wrong key or tampered ciphertext) — never returns garbage. */
export function decryptSecret(envelope: string, key: Buffer): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) throw new Error("unrecognized secret envelope");
  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const ct = Buffer.from(parts[3]!, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
