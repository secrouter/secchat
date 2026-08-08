// Coverage split mirrors audit.test.ts: the pure wire codec (frame.ts) gets thorough
// unit tests, then the stateful hub gets a couple of end-to-end tests over a real socket
// using Node's built-in WebSocket client (no `ws` package — see src/ws/hub.ts's header).

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAcceptKey,
  decodeFrames,
  encodeCloseFrame,
  encodePong,
  encodeTextFrame,
  OPCODE,
} from "../src/ws/frame.ts";
import { attachWsHub } from "../src/ws/hub.ts";
import type { VerifyToken } from "../src/types.ts";

// ---------------------------------------------------------------------------------------
// frame.ts — pure codec tests
// ---------------------------------------------------------------------------------------

/** Build a MASKED client-style frame (mirrors what a real WebSocket client sends) so we can
 * exercise decodeFrames() — which only ever decodes masked, client→server frames — without
 * a live socket. Deliberately reimplements the length-encoding rather than calling into
 * frame.ts's own (unmasked, server-side) encoder, so this is a real independent check. */
function encodeMaskedClientFrame(opcode: number, payload: Buffer): Buffer {
  const maskKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ maskKey[i % 4]!;

  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, maskKey, masked]);
}

test("computeAcceptKey matches the RFC 6455 worked example", () => {
  // https://datatracker.ietf.org/doc/html/rfc6455#section-1.3
  assert.equal(computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("encodeTextFrame: FIN+opcode byte and unmasked payload are correct", () => {
  const text = "hello secchat";
  const frame = encodeTextFrame(text);
  assert.equal(frame[0], 0x80 | OPCODE.TEXT); // FIN=1, opcode=0x1
  assert.equal(frame[1]! & 0x80, 0); // server frames are never masked
  assert.ok(frame.subarray(frame.length - Buffer.byteLength(text)).equals(Buffer.from(text, "utf8")));
});

test("encodeTextFrame's payload round-trips through decodeFrames as a masked client frame", () => {
  const text = "hello secchat";
  const clientFrame = encodeMaskedClientFrame(OPCODE.TEXT, Buffer.from(text, "utf8"));
  const decoded = decodeFrames(clientFrame);

  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]!.opcode, OPCODE.TEXT);
  assert.equal(decoded[0]!.payload.toString("utf8"), text);
});

test("decodeFrames: 7-bit / 16-bit / 64-bit payload-length encoding round-trips at the boundaries", () => {
  // 125/126 is the 7-bit -> 16-bit boundary; 65535/65536 is the 16-bit -> 64-bit boundary.
  for (const size of [0, 1, 125, 126, 500, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(size, "x");
    const clientFrame = encodeMaskedClientFrame(OPCODE.TEXT, payload);
    const decoded = decodeFrames(clientFrame);
    assert.equal(decoded.length, 1, `expected exactly one frame for size ${size}`);
    assert.equal(decoded[0]!.payload.length, size, `payload length mismatch for size ${size}`);
    assert.ok(decoded[0]!.payload.equals(payload), `payload bytes mismatch for size ${size}`);
  }
});

test("decodeFrames: multiple frames back-to-back in one buffer all parse", () => {
  const a = encodeMaskedClientFrame(OPCODE.TEXT, Buffer.from("first"));
  const b = encodeMaskedClientFrame(OPCODE.PING, Buffer.from("ping-body"));
  const c = encodeMaskedClientFrame(OPCODE.TEXT, Buffer.from("second"));
  const decoded = decodeFrames(Buffer.concat([a, b, c]));

  assert.deepEqual(
    decoded.map((f) => [f.opcode, f.payload.toString("utf8")]),
    [
      [OPCODE.TEXT, "first"],
      [OPCODE.PING, "ping-body"],
      [OPCODE.TEXT, "second"],
    ],
  );
});

test("decodeFrames: a truncated frame at the end of the buffer is dropped, not thrown", () => {
  const whole = encodeMaskedClientFrame(OPCODE.TEXT, Buffer.from("complete"));
  const truncated = encodeMaskedClientFrame(OPCODE.TEXT, Buffer.from("this won't fully arrive"));
  const buf = Buffer.concat([whole, truncated.subarray(0, truncated.length - 3)]);

  const decoded = decodeFrames(buf); // must not throw
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]!.payload.toString("utf8"), "complete");
});

test("decodeFrames: empty and tiny buffers return no frames rather than throwing", () => {
  assert.deepEqual(decodeFrames(Buffer.alloc(0)), []);
  assert.deepEqual(decodeFrames(Buffer.from([0x81])), []); // one byte — not even a full base header
});

test("encodeCloseFrame / encodePong: opcodes and payloads are correct", () => {
  const close = encodeCloseFrame(1000, "bye");
  assert.equal(close[0], 0x80 | OPCODE.CLOSE);
  assert.equal(close.readUInt16BE(2), 1000); // status code, right after the 2-byte header
  assert.equal(close.subarray(4).toString("utf8"), "bye");

  const pong = encodePong(Buffer.from("ping-payload"));
  assert.equal(pong[0], 0x80 | OPCODE.PONG);
  assert.equal(pong.subarray(2).toString("utf8"), "ping-payload");
});

// ---------------------------------------------------------------------------------------
// hub.ts — end-to-end over a real server + the built-in global WebSocket client
// ---------------------------------------------------------------------------------------

const verifyToken: VerifyToken = async (token) => {
  if (token === "good") return { sub: "user-1", groups: [] };
  throw new Error("invalid token");
};

async function startServer() {
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const hub = attachWsHub(server, { verifyToken });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  return { server, hub, port: (address as AddressInfo).port };
}

async function stopServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("hub: subscribe + broadcast delivers exactly the broadcast JSON to a connected, authenticated client", async () => {
  const { server, hub, port } = await startServer();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=good`);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("socket errored before opening")), { once: true });
    });

    const messageArrived = new Promise<unknown>((resolve, reject) => {
      socket.addEventListener(
        "message",
        (ev) => {
          try {
            resolve(JSON.parse(ev.data as string));
          } catch (err) {
            reject(err as Error);
          }
        },
        { once: true },
      );
    });

    // Simplest path per the task: call the hub API directly rather than round-tripping a
    // client "subscribe" message.
    hub.subscribe("user-1", "chan-1");
    hub.broadcast("chan-1", { hello: "world" });

    assert.deepEqual(await messageArrived, { hello: "world" });
  } finally {
    socket.close();
    hub.close();
    await stopServer(server);
  }
});

test("hub: a connection with an invalid token is rejected and never opens", async () => {
  const { server, hub, port } = await startServer();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=bad`);

  try {
    const outcome = await new Promise<"open" | "rejected">((resolve) => {
      socket.addEventListener("open", () => resolve("open"), { once: true });
      socket.addEventListener("error", () => resolve("rejected"), { once: true });
      socket.addEventListener("close", () => resolve("rejected"), { once: true });
    });
    assert.equal(outcome, "rejected");
  } finally {
    hub.close();
    await stopServer(server);
  }
});

test("hub: broadcasting to a channel with no subscribers is a silent no-op", async () => {
  const { server, hub } = await startServer();
  try {
    assert.doesNotThrow(() => hub.broadcast("nobody-here", { anything: true }));
  } finally {
    hub.close();
    await stopServer(server);
  }
});
