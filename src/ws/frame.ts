// A minimal RFC 6455 WebSocket framing codec — pure functions over Buffers plus one small
// stateful per-connection decoder (FrameDecoder), no I/O, so trivially unit-testable (mirrors
// audit/chain.ts's split of "pure primitive" vs. the stateful thing that drives it; here
// that's hub.ts / runner-hub.ts driving sockets).
//
//  - FrameDecoder is what a connection should use: it CARRIES partial bytes across socket
//    "data" events (TCP has no notion of frame boundaries — a frame larger than one segment
//    ~1460 bytes routinely arrives split) and reassembles FIN=0 + continuation (opcode 0x0)
//    fragmentation into whole messages. Without this, a runner daemon's multi-KB
//    output/tool_request frame silently vanished mid-handshake.
//  - decodeFrames() remains the stateless primitive: complete frames within ONE buffer, no
//    carry, no continuation reassembly (each frame reported as-is). Kept for tests and any
//    caller that genuinely has a whole buffer in hand.
//  - Binary frames (0x2) are out of scope; encodeTextFrame is the only application-payload
//    encoder. Both decoders will still hand back a binary frame's raw bytes (opcode 0x2) —
//    it just isn't a case any encoder here produces or the hubs specifically interpret.

import { createHash } from "node:crypto";

const WS_ACCEPT_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC 6455 §1.3, fixed GUID

/** Opcodes this server encodes/decodes. CONTINUATION (0x0) exists only on the wire —
 * FrameDecoder reassembles it away, emitting whole messages under the initiating opcode. */
export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export interface DecodedFrame {
  opcode: number;
  payload: Buffer;
}

/** One parsed wire frame + where parsing may resume, or null if `buf` ends mid-frame at
 * `offset` (short header, incomplete extended length/mask/payload — never throws on that). */
interface ParsedWireFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  next: number;
}

function parseWireFrame(buf: Buffer, offset: number): ParsedWireFrame | null {
  if (offset + 2 > buf.length) return null;
  const byte0 = buf[offset]!;
  const byte1 = buf[offset + 1]!;
  const fin = (byte0 & 0x80) !== 0;
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen: number = byte1 & 0x7f;
  let cursor = offset + 2;

  if (payloadLen === 126) {
    if (cursor + 2 > buf.length) return null; // extended length not fully arrived yet
    payloadLen = buf.readUInt16BE(cursor);
    cursor += 2;
  } else if (payloadLen === 127) {
    if (cursor + 8 > buf.length) return null;
    const big = buf.readBigUInt64BE(cursor);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null; // refuse to even attempt absurd sizes
    payloadLen = Number(big);
    cursor += 8;
  }

  let maskKey: Buffer | undefined;
  if (masked) {
    if (cursor + 4 > buf.length) return null; // masking key not fully arrived yet
    maskKey = buf.subarray(cursor, cursor + 4);
    cursor += 4;
  }

  if (cursor + payloadLen > buf.length) return null; // payload not fully arrived yet

  const raw = buf.subarray(cursor, cursor + payloadLen);
  const payload = maskKey ? unmask(raw, maskKey) : Buffer.from(raw);
  return { fin, opcode, payload, next: cursor + payloadLen };
}

/** The `Sec-WebSocket-Accept` value for a given `Sec-WebSocket-Key`: base64(sha1(key + the
 * RFC 6455 magic GUID)). Verified in tests against the RFC's own worked example. */
export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_ACCEPT_MAGIC, "utf8").digest("base64");
}

/** Encode one RFC 6455 frame (§5.2). Server→client frames are always sent unmasked (MASK=0)
 * — per spec only client→server frames carry a masking key. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

/** A single unmasked server→client TEXT frame (FIN=1, opcode=0x1), UTF-8 encoded, with
 * correct 7-bit / 16-bit / 64-bit payload-length encoding per RFC 6455 §5.2. */
export function encodeTextFrame(text: string): Buffer {
  return encodeFrame(OPCODE.TEXT, Buffer.from(text, "utf8"));
}

/** A CLOSE frame. Payload is the 2-byte status code followed by the optional UTF-8 reason
 * (RFC 6455 §5.5.1); we always include the code so the peer gets a real close reason. */
export function encodeCloseFrame(code = 1000, reason = ""): Buffer {
  const reasonBuf = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  return encodeFrame(OPCODE.CLOSE, payload);
}

/** A PONG frame. RFC 6455 §5.5.3 requires echoing the PING's application payload verbatim. */
export function encodePong(payload: Buffer = Buffer.alloc(0)): Buffer {
  return encodeFrame(OPCODE.PONG, payload);
}

/** XOR-unmask a client frame's payload with its 4-byte masking key (RFC 6455 §5.3). */
function unmask(data: Uint8Array, key: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! ^ key[i % 4]!;
  }
  return out;
}

/**
 * Parse zero or more complete client→server frames out of `buf`. Client frames are always
 * MASKED (§5.3); each payload is unmasked with its 4-byte masking key before being returned.
 * Handles TEXT(0x1), CLOSE(0x8), PING(0x9), and PONG(0xA) — see hub.ts for how each is used.
 *
 * STATELESS (see file header): FIN is not inspected — every frame is decoded as if it were a
 * complete message in itself, no continuation-frame reassembly, and a frame split across two
 * socket `"data"` events is not reassembled. Connections must use FrameDecoder below; this
 * stays as the pure single-buffer primitive.
 *
 * Defensive by design: if `buf` ends mid-frame (a short base header, an extended-length field
 * that isn't fully present yet, a payload promised-but-not-fully-arrived, …) parsing simply
 * stops there and whatever complete frames were already found are returned — never throws on
 * truncated input.
 */
export function decodeFrames(buf: Buffer): DecodedFrame[] {
  const frames: DecodedFrame[] = [];
  let offset = 0;
  for (;;) {
    const parsed = parseWireFrame(buf, offset);
    if (!parsed) return frames;
    frames.push({ opcode: parsed.opcode, payload: parsed.payload });
    offset = parsed.next;
  }
}

/**
 * The PER-CONNECTION decoder: feed every socket `"data"` chunk (and the upgrade `head`) to
 * `push()` and act on the complete MESSAGES it returns. Fixes the two gaps the stateless
 * primitive deliberately has:
 *
 *  1. **Cross-read carry.** Bytes that end mid-frame are buffered and re-parsed when the next
 *     chunk arrives — a frame larger than one TCP segment (runner output, tool_request, a
 *     multi-KB SDP) no longer vanishes.
 *  2. **Fragmentation (§5.4).** A FIN=0 data frame opens a message; CONTINUATION frames append;
 *     the FIN=1 continuation completes it, emitted under the INITIATING opcode. Control frames
 *     (CLOSE/PING/PONG) may legally interleave mid-fragmentation and are emitted immediately.
 *
 * Fail-safe on protocol slop rather than strict-closing: a stray CONTINUATION with no message
 * in progress is dropped; a new data frame arriving mid-fragmentation discards the unfinished
 * message and starts over (never mixes two messages' bytes).
 *
 * Resource-bounded: `maxMessageBytes` (default 16 MiB) caps the un-parsed carry AND an
 * in-progress fragmented message. Exceeding it THROWS — the connection is hostile or broken,
 * and the caller should destroy the socket (both hubs do).
 */
export class FrameDecoder {
  #carry: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #fragmentOpcode: number | null = null;
  readonly #maxMessageBytes: number;

  constructor(opts: { maxMessageBytes?: number } = {}) {
    this.#maxMessageBytes = opts.maxMessageBytes ?? 16 * 1024 * 1024;
  }

  push(chunk: Buffer): DecodedFrame[] {
    // Common case first: nothing carried, so parse the chunk in place (no concat allocation).
    const buf = this.#carry.length === 0 ? chunk : Buffer.concat([this.#carry, chunk]);
    if (buf.length > this.#maxMessageBytes) {
      throw new Error(`ws: frame exceeds ${this.#maxMessageBytes} bytes`);
    }

    const messages: DecodedFrame[] = [];
    let offset = 0;
    for (;;) {
      const parsed = parseWireFrame(buf, offset);
      if (!parsed) break;
      offset = parsed.next;
      this.#accept(parsed, messages);
    }

    // Carry the incomplete tail (COPIED, so we never pin the big concat buffer alive).
    this.#carry = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
    return messages;
  }

  #accept(frame: ParsedWireFrame, out: DecodedFrame[]): void {
    // Control frames are never fragmented (§5.5 requires FIN=1) and may interleave — pass through.
    if (frame.opcode >= 0x8) {
      out.push({ opcode: frame.opcode, payload: frame.payload });
      return;
    }

    if (frame.opcode === OPCODE.CONTINUATION) {
      if (this.#fragmentOpcode === null) return; // stray continuation — drop (fail-safe)
      this.#fragments.push(frame.payload);
      this.#fragmentBytes += frame.payload.length;
      if (this.#fragmentBytes > this.#maxMessageBytes) {
        this.#resetFragments();
        throw new Error(`ws: fragmented message exceeds ${this.#maxMessageBytes} bytes`);
      }
      if (frame.fin) {
        out.push({ opcode: this.#fragmentOpcode, payload: Buffer.concat(this.#fragments) });
        this.#resetFragments();
      }
      return;
    }

    // A data frame (TEXT/BINARY). Mid-fragmentation this is protocol slop — discard the
    // unfinished message rather than interleaving two messages' bytes.
    if (this.#fragmentOpcode !== null) this.#resetFragments();

    if (frame.fin) {
      out.push({ opcode: frame.opcode, payload: frame.payload });
    } else {
      this.#fragmentOpcode = frame.opcode;
      this.#fragments = [frame.payload];
      this.#fragmentBytes = frame.payload.length;
    }
  }

  #resetFragments(): void {
    this.#fragments = [];
    this.#fragmentBytes = 0;
    this.#fragmentOpcode = null;
  }
}
