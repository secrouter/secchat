// A minimal RFC 6455 WebSocket hub: performs the upgrade handshake (gated by the same
// VerifyToken the HTTP layer uses — no bearer token, no socket), then tracks per-principal
// connections and per-channel subscriptions for realtime broadcast.
//
// Kept dependency-free per the repo's dependency policy (see README) — no `ws` package; the
// wire protocol is src/ws/frame.ts, this file is just connection/subscription bookkeeping
// wired to node:http's `"upgrade"` event. Auth is injected (deps.verifyToken), matching the
// Store/VerifyToken injection pattern the rest of the backend uses — this module never
// imports a concrete verifier or store.
//
// v1 SCOPE / LIMITATIONS (see also frame.ts's header):
//  - No message fragmentation (frame.ts decodes single frames only).
//  - No cross-"data"-event reassembly: each socket `"data"` chunk is handed to decodeFrames()
//    independently. decodeFrames() keeps no state across calls (by design — see its doc
//    comment), so a frame split across two TCP segments would be silently dropped rather
//    than reassembled. Acceptable for v1: this hub only exchanges small JSON control/
//    broadcast messages, which fit in a single segment in practice.
//  - Text frames only. The one inbound message this hub interprets is a client "subscribe"
//    message: `{ "type": "subscribe", "channelId": "..." }`; anything else that isn't valid
//    JSON of that shape is silently ignored rather than erroring the connection.
//  - No offline queueing: `subscribe()` only affects connections that are already open for
//    that `sub`. A client must (re)send its subscriptions after reconnecting.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { AuthGateway, Principal, VerifyToken } from "../types.ts";
import {
  computeAcceptKey,
  decodeFrames,
  encodeCloseFrame,
  encodePong,
  encodeTextFrame,
  OPCODE,
  type DecodedFrame,
} from "./frame.ts";

/** One live upgraded socket. A `sub` may have more than one (multiple tabs/devices) — both
 * `connectionsBySub` and `channelSubscriptions` below are keyed by connection, not by sub. */
interface Connection {
  socket: Duplex;
  sub: string;
  channels: Set<string>;
}

export interface Hub {
  /** Subscribe every live connection for `sub` to `channelId`. No-op if `sub` has no open
   * connection right now (see the "no offline queueing" limitation above). */
  subscribe(sub: string, channelId: string): void;
  /** JSON-encode `payload` and push it as a text frame to every connection subscribed to
   * `channelId`. No-op if nobody is subscribed. */
  broadcast(channelId: string, payload: unknown): void;
  /** Close every open connection and detach from the server's `"upgrade"` event. */
  close(): void;
}

/** Attach a WebSocket hub to an existing http.Server's `"upgrade"` event. `deps.auth` (see
 * auth/bff.ts) is the SAME AuthGateway the HTTP server is wired with — it's optional here too,
 * and behaves identically: unset, or `resolveSession` returning null, just means the cookie
 * fallback below never fires and only `?token=`/subprotocol can authenticate. */
export function attachWsHub(server: Server, deps: { verifyToken: VerifyToken; auth?: AuthGateway }): Hub {
  const connections = new Set<Connection>();
  const connectionsBySub = new Map<string, Set<Connection>>(); // principal.sub -> its sockets
  const channelSubscriptions = new Map<string, Set<Connection>>(); // channelId -> subscribers

  function trackConnection(conn: Connection): void {
    connections.add(conn);
    let bySub = connectionsBySub.get(conn.sub);
    if (!bySub) {
      bySub = new Set();
      connectionsBySub.set(conn.sub, bySub);
    }
    bySub.add(conn);
  }

  function untrackConnection(conn: Connection): void {
    connections.delete(conn);

    const bySub = connectionsBySub.get(conn.sub);
    if (bySub) {
      bySub.delete(conn);
      if (bySub.size === 0) connectionsBySub.delete(conn.sub);
    }

    for (const channelId of conn.channels) {
      channelSubscriptions.get(channelId)?.delete(conn);
    }
  }

  /** Token comes from `?token=` on the request URL, or else the Sec-WebSocket-Protocol
   * header (some WebSocket clients, e.g. browsers, can't set custom headers on the upgrade
   * request, so the subprotocol slot doubles as an auth-token carrier). Reports which one it
   * used so the caller can echo the subprotocol back only when it was actually consumed. */
  function extractToken(req: IncomingMessage): { token?: string; usedProtocol?: string } {
    const url = new URL(req.url ?? "/", "http://ws.internal"); // base is a dummy; only the query matters
    const fromQuery = url.searchParams.get("token");
    if (fromQuery) return { token: fromQuery };

    const fromProtocolHeader = req.headers["sec-websocket-protocol"]?.split(",")[0]?.trim();
    if (fromProtocolHeader) return { token: fromProtocolHeader, usedProtocol: fromProtocolHeader };

    return {};
  }

  function handleFrame(conn: Connection, frame: DecodedFrame): void {
    switch (frame.opcode) {
      case OPCODE.PING:
        conn.socket.write(encodePong(frame.payload));
        return;
      case OPCODE.CLOSE:
        conn.socket.write(encodeCloseFrame());
        conn.socket.end();
        return;
      case OPCODE.TEXT:
        handleTextMessage(conn, frame.payload);
        return;
      default:
        return; // PONG (and anything else): no action needed in v1
    }
  }

  function handleTextMessage(conn: Connection, payload: Buffer): void {
    let msg: unknown;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      return; // v1 only understands JSON control messages — ignore anything else
    }
    if (!msg || typeof msg !== "object") return;

    const { type, channelId } = msg as { type?: unknown; channelId?: unknown };
    if (type === "subscribe" && typeof channelId === "string") {
      subscribe(conn.sub, channelId);
    }
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const { token, usedProtocol } = extractToken(req);

    // Same bearer-first order as the HTTP server (see http/server.ts's auth block): a `?token=`
    // or subprotocol token found by extractToken is the credential and must verify; only when
    // NEITHER is present do we fall back to `secchat_session` via deps.auth?.resolveSession — the
    // Cookie header a same-origin browser sends automatically on the upgrade request too.
    let principal: Principal;
    try {
      if (token) {
        principal = await deps.verifyToken(token);
      } else {
        const sessionPrincipal = await deps.auth?.resolveSession(req);
        if (!sessionPrincipal) throw new Error("no credentials (no token, no valid session cookie)");
        principal = sessionPrincipal;
      }
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const responseLines = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${computeAcceptKey(key)}`,
      ...(usedProtocol ? [`Sec-WebSocket-Protocol: ${usedProtocol}`] : []),
      "\r\n",
    ];
    socket.write(responseLines.join("\r\n"));

    const conn: Connection = { socket, sub: principal.sub, channels: new Set() };
    trackConnection(conn);

    socket.on("data", (chunk: Buffer) => {
      for (const frame of decodeFrames(chunk)) handleFrame(conn, frame);
    });
    socket.once("close", () => untrackConnection(conn));
    socket.once("error", () => untrackConnection(conn));

    // Bytes the client pipelined immediately after the handshake, before the 101 response
    // even went out, land in `head` rather than a later "data" event — decode those too so
    // an eager client's first message isn't silently lost. Empty in the common case (a
    // client that waits for "open" before sending anything).
    if (head.length > 0) {
      for (const frame of decodeFrames(head)) handleFrame(conn, frame);
    }
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    void handleUpgrade(req, socket, head).catch(() => socket.destroy());
  }
  server.on("upgrade", onUpgrade);

  function subscribe(sub: string, channelId: string): void {
    const conns = connectionsBySub.get(sub);
    if (!conns || conns.size === 0) return;

    let subs = channelSubscriptions.get(channelId);
    if (!subs) {
      subs = new Set();
      channelSubscriptions.set(channelId, subs);
    }
    for (const conn of conns) {
      subs.add(conn);
      conn.channels.add(channelId);
    }
  }

  function broadcast(channelId: string, payload: unknown): void {
    const subs = channelSubscriptions.get(channelId);
    if (!subs || subs.size === 0) return;

    const frame = encodeTextFrame(JSON.stringify(payload));
    for (const conn of subs) {
      try {
        conn.socket.write(frame);
      } catch {
        // A dead socket here just means its "close"/"error" listener hasn't fired yet —
        // don't let one bad connection break broadcast to the rest.
      }
    }
  }

  function close(): void {
    server.off("upgrade", onUpgrade);
    for (const conn of connections) {
      try {
        conn.socket.write(encodeCloseFrame());
      } catch {
        // ignore — we're tearing down the socket unconditionally next
      }
      conn.socket.destroy();
    }
    connections.clear();
    connectionsBySub.clear();
    channelSubscriptions.clear();
  }

  return { subscribe, broadcast, close };
}
