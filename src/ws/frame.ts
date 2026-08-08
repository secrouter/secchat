// A minimal RFC 6455 WebSocket framing codec — pure functions over Buffers, no I/O, so
// trivially unit-testable (mirrors audit/chain.ts's split of "pure primitive" vs. the
// stateful thing that drives it; here that's hub.ts driving sockets).
//
// v1 SCOPE / LIMITATIONS:
//  - No fragmentation support. A WebSocket message may legally be split across a FIN=0
//    initial frame and FIN=0/1 continuation frames (opcode 0x0). decodeFrames() does not
//    reassemble these — it decodes each frame independently and reports whatever opcode is
//    on the wire (FIN is not inspected at all). This is fine for this hub's use case (small,
//    single-frame JSON control/broadcast messages) but is NOT a general-purpose client.
//  - Binary frames (0x2) are out of scope; encodeTextFrame is the only application-payload
//    encoder. decodeFrames will still hand back a binary frame's raw bytes (opcode 0x2) —
//    it just isn't a case any encoder here produces or hub.ts specifically interprets.

import { createHash } from "node:crypto";

const WS_ACCEPT_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC 6455 §1.3, fixed GUID

/** Opcodes this v1 server encodes/decodes. Continuation (0x0) and binary (0x2) are out of
 * scope for v1 — see the file header. */
export const OPCODE = {
  TEXT: 0x1,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export interface DecodedFrame {
  opcode: number;
  payload: Buffer;
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
 * v1 SCOPE (see file header): FIN is not inspected — every frame is decoded as if it were a
 * complete message in itself; no continuation-frame reassembly.
 *
 * Defensive by design: if `buf` ends mid-frame (a short base header, an extended-length field
 * that isn't fully present yet, a payload promised-but-not-fully-arrived, …) parsing simply
 * stops there and whatever complete frames were already found are returned — this function
 * never throws on truncated input. Because it keeps no state across calls, a frame split
 * across two socket `"data"` events is NOT reassembled here; see hub.ts's file header for how
 * that limitation is handled (or rather, deliberately not handled, in v1).
 */
export function decodeFrames(buf: Buffer): DecodedFrame[] {
  const frames: DecodedFrame[] = [];
  let offset = 0;

  while (offset + 2 <= buf.length) {
    const byte0 = buf[offset]!;
    const byte1 = buf[offset + 1]!;
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let payloadLen: number = byte1 & 0x7f;
    let cursor = offset + 2;

    if (payloadLen === 126) {
      if (cursor + 2 > buf.length) break; // extended length not fully arrived yet
      payloadLen = buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLen === 127) {
      if (cursor + 8 > buf.length) break;
      const big = buf.readBigUInt64BE(cursor);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break; // refuse to even attempt absurd sizes
      payloadLen = Number(big);
      cursor += 8;
    }

    let maskKey: Buffer | undefined;
    if (masked) {
      if (cursor + 4 > buf.length) break; // masking key not fully arrived yet
      maskKey = buf.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (cursor + payloadLen > buf.length) break; // payload not fully arrived yet

    const raw = buf.subarray(cursor, cursor + payloadLen);
    const payload = maskKey ? unmask(raw, maskKey) : Buffer.from(raw);

    frames.push({ opcode, payload });
    offset = cursor + payloadLen;
  }

  return frames;
}
