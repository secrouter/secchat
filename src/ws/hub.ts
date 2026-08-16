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
// SCOPE / LIMITATIONS (see also frame.ts's header):
//  - Inbound framing goes through a per-connection FrameDecoder: bytes are carried across
//    socket `"data"` events and FIN=0/continuation fragmentation is reassembled, so a frame
//    split across TCP segments arrives whole. A decoder that reports a hostile frame (over
//    the size bound) destroys the connection.
//  - Text frames only. The inbound messages this hub interprets are a per-channel `{ "type":
//    "subscribe", "channelId": "..." }` and an all-my-channels `{ "type": "subscribeAll" }` (the
//    latter needs deps.channelsForSub); anything else that isn't valid JSON of those shapes is
//    silently ignored rather than erroring the connection.
//  - No offline queueing: `subscribe()` only affects connections that are already open for
//    that `sub`. A client must (re)send its subscriptions after reconnecting.
//  - Every connection carries an opaque `id` (independent of its `sub`) so `sendToConnection` can
//    target exactly one — needed once a `sub` may have several live tabs but a stateful exchange
//    (a voice call, docs/plans/voice-calls-plan.md §2.1) must stay pinned to the one the human
//    actually used. `deps.calls` is that feature's wiring point: constructed in index.ts and
//    threaded through here already, but not yet consumed — see its own doc comment below.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { CallSignalError, type CallRegistry, type LiveCall } from "../calls/registry.ts";
import type { AuthGateway, Principal, VerifyToken } from "../types.ts";
import {
  computeAcceptKey,
  encodeCloseFrame,
  encodePong,
  encodeTextFrame,
  FrameDecoder,
  OPCODE,
  type DecodedFrame,
} from "./frame.ts";

/** One live upgraded socket. A `sub` may have more than one (multiple tabs/devices) — both
 * `connectionsBySub` and `channelSubscriptions` below are keyed by connection, not by sub. `id` is
 * this connection's opaque handle for `sendToConnection` (voice calls' connection-scoped routing,
 * docs/plans/voice-calls-plan.md §2.1 — a call is bound to exactly one connection per side, not to
 * a `sub`, so multi-tab ring/first-accept-wins can be pinned to the tab the human actually used). */
interface Connection {
  id: string;
  socket: Duplex;
  sub: string;
  channels: Set<string>;
  /** How many `call_candidate` frames this connection has sent, ever — the rate/volume cap below
   * (§2.1/§4's "candidate frames per call... rate-capped"). Simplest sound bound: a WS connection's
   * lifetime roughly brackets one call attempt in practice (a fresh tab/reconnect gets a fresh
   * connection id), and ICE gathering produces at most a few dozen candidates per call — nowhere
   * near the cap below. */
  callCandidateCount?: number;
}

/** call_* payload bounds (§2.1/§4, voice-contracts.md §1.3): in p2p mode, `call_sdp`/`call_candidate`
 * are a user-to-user content path the server relays without inspecting — outside DLP/marking/chain
 * governance by construction, so bounded rather than trusted. 32 KiB is "far below the hub's general
 * 16 MiB frame ceiling" per the plan. A frame over the cap is dropped; a connection that blows past
 * the candidate-count cap is treated as hostile/broken and destroyed — the same posture frame.ts's
 * FrameDecoder already takes for an oversized frame. */
const MAX_CALL_FRAME_BYTES = 32 * 1024;
const MAX_CALL_CANDIDATES_PER_CONNECTION = 500;

/** How often ws/hub.ts sweeps for expired ringing calls (calls/registry.ts's `checkRingingTimeouts`
 * is the pure check; this interval is the "something stateful drives it" half — mirrors
 * agent/reaper.ts's `startReaper` shape). Well under the 45s default ringing timeout so a missed
 * call's `call_missed` signal + chat line land promptly. */
const RINGING_SWEEP_INTERVAL_MS = 2_000;

export interface Hub {
  /** Subscribe every live connection for `sub` to `channelId`. No-op if `sub` has no open
   * connection right now (see the "no offline queueing" limitation above). */
  subscribe(sub: string, channelId: string): void;
  /** JSON-encode `payload` and push it as a text frame to every connection subscribed to
   * `channelId`. No-op if nobody is subscribed. */
  broadcast(channelId: string, payload: unknown): void;
  /** Push `payload` to EVERY live connection of a single principal, regardless of channel
   * subscription — the primitive for user-targeted signals like @mention notifications. No-op if
   * `sub` has no open connection right now (the hub has no offline queueing; durable delivery is the
   * caller's job, e.g. the mentions table). */
  deliverToUser(sub: string, payload: unknown): void;
  /** The subs with at least one live connection right now — the presence roster (seeds GET /presence
   * before the live connect/disconnect events take over). */
  onlineSubs(): string[];
  /** Push `payload` to exactly ONE connection by its opaque id (see the `Connection.id` doc
   * comment) — the primitive voice calls need for connection-scoped routing (§2.1), distinct from
   * `broadcast` (channel-wide) and `deliverToUser` (every connection of one principal). Returns
   * whether that connection was still live to receive it; false (no throw) for an unknown/gone id,
   * matching broadcast/deliverToUser's "no-op if gone" shape. */
  sendToConnection(connId: string, payload: unknown): boolean;
  /** Close every open connection and detach from the server's `"upgrade"` event. */
  close(): void;
}

/** Attach a WebSocket hub to an existing http.Server's `"upgrade"` event. `deps.auth` (see
 * auth/bff.ts) is the SAME AuthGateway the HTTP server is wired with — it's optional here too,
 * and behaves identically: unset, or `resolveSession` returning null, just means the cookie
 * fallback below never fires and only `?token=`/subprotocol can authenticate. */
export function attachWsHub(
  server: Server,
  deps: {
    verifyToken: VerifyToken;
    auth?: AuthGateway;
    /** Membership lookup for `{type:"subscribeAll"}` — the channel ids a principal may receive events
     * for. Injected (not a Store import) to keep this module store-agnostic. Unset ⇒ subscribeAll is
     * a no-op and only per-channel `subscribe` works. */
    channelsForSub?: (sub: string) => Promise<string[]>;
    /** Voice calls' server-side state machine (calls/registry.ts, docs/plans/voice-calls-plan.md
     * §2.1). Unset ⇒ every `call_*` frame is silently ignored (see `handleCallFrame`'s first line)
     * and no ringing-timeout sweep runs — same "feature just isn't there" posture as `control`/
     * `admin` elsewhere in this codebase when their dep is unset. */
    calls?: CallRegistry;
    /** Overrides `RINGING_SWEEP_INTERVAL_MS` (default 2s) — test-only knob, same spirit as
     * agent/reaper.ts's `startReaper({intervalMs})`, so a ringing-timeout test isn't stuck waiting
     * on a real 2s wall-clock tick. */
    ringingSweepIntervalMs?: number;
  },
): Hub {
  const connections = new Set<Connection>();
  const connectionsById = new Map<string, Connection>(); // connection id -> connection (sendToConnection)
  const connectionsBySub = new Map<string, Set<Connection>>(); // principal.sub -> its sockets
  const channelSubscriptions = new Map<string, Set<Connection>>(); // channelId -> subscribers

  function trackConnection(conn: Connection): void {
    connections.add(conn);
    connectionsById.set(conn.id, conn);
    let bySub = connectionsBySub.get(conn.sub);
    const firstForSub = !bySub || bySub.size === 0; // this connection brings the principal online
    if (!bySub) {
      bySub = new Set();
      connectionsBySub.set(conn.sub, bySub);
    }
    bySub.add(conn);
    if (firstForSub) void announcePresence(conn.sub, true);
  }

  function untrackConnection(conn: Connection): void {
    // Voice calls (§2.1): tear down any call bound to this connection — an active call losing its
    // only connection on that side, or a ringing call losing its caller connection. No-op if this
    // connection was never bound to anything live (every non-winning ringing tab, most calls).
    deps.calls?.untrackConnection(conn.id);

    connections.delete(conn);
    connectionsById.delete(conn.id);

    const bySub = connectionsBySub.get(conn.sub);
    if (bySub) {
      bySub.delete(conn);
      if (bySub.size === 0) {
        connectionsBySub.delete(conn.sub);
        void announcePresence(conn.sub, false); // last socket closed ⇒ the principal went offline
      }
    }

    for (const channelId of conn.channels) {
      channelSubscriptions.get(channelId)?.delete(conn);
    }
  }

  /** Fan a presence change out to every channel the principal belongs to, so members subscribed to
   * those channels (via subscribeAll) see them go online/offline live. Fire-and-forget; a channel
   * lookup failure just drops the announcement. */
  async function announcePresence(sub: string, online: boolean): Promise<void> {
    if (!deps.channelsForSub) return;
    let channelIds: string[];
    try {
      channelIds = await deps.channelsForSub(sub);
    } catch {
      return;
    }
    for (const channelId of channelIds) broadcast(channelId, { type: "presence", channelId, userSub: sub, online });
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
    } else if (type === "subscribeAll") {
      void subscribeAll(conn);
    } else if (type === "typing" && typeof channelId === "string") {
      // Relay an ephemeral typing signal to the channel — but ONLY into a channel the sender is
      // actually subscribed to (a member), so typing can't be spoofed into arbitrary channels. Not
      // persisted; every recipient (incl. the sender, who filters its own) sees it live and briefly.
      if (conn.channels.has(channelId)) {
        broadcast(channelId, { type: "typing", channelId, userSub: conn.sub });
      }
    } else if (typeof type === "string" && type.startsWith("call_")) {
      // Voice calls (docs/plans/voice-calls-plan.md §2.1; docs/plans/voice-contracts.md §1). Mirrors
      // the typing frame's anti-spoof posture above (never trust a client-asserted identity beyond
      // `conn.sub`/`conn.id`) — every validation beyond "is this well-formed JSON" is CallRegistry's
      // job (DM membership, single-flight, connection binding); this hub only decodes the frame,
      // applies the size/rate caps below, and routes the fan-out CallRegistry can't do itself
      // (multi-connection-per-sub — see calls/registry.ts's `invite`/`checkRingingTimeouts` doc
      // comments for why).
      // Caught here (not left as a bare `void`, unlike subscribeAll above which never throws
      // internally): CallRegistry.invite/accept already catch their own expected rejections into a
      // `call_error` frame, but `end`/`relay` can still surface a genuine internal error (e.g. a
      // store I/O failure) — an unhandled rejection here would otherwise be silent/crash-prone.
      handleCallFrame(conn, msg as Record<string, unknown>, type).catch((err) => {
        console.error("ws/hub: call_* frame handling failed:", err instanceof Error ? err.message : err);
      });
    }
  }

  /** Send a `call_error` frame back to the ONE connection that sent a bad/rejected call_* frame —
   * never broadcast, never to the other party (voice-contracts.md doesn't prescribe a wire shape
   * for this; §1.3 just says "a WS-level error frame", so this is this implementation's own). */
  function sendCallError(conn: Connection, channelId: string | undefined, error: string, detail?: string): void {
    sendToConnection(conn.id, { type: "call_error", channelId, error, ...(detail ? { detail } : {}) });
  }

  async function handleCallFrame(conn: Connection, msg: Record<string, unknown>, type: string): Promise<void> {
    if (!deps.calls) return; // voice calls not configured for this deployment — ignore, like any unrecognized message
    const calls = deps.calls;
    const channelId = typeof msg.channelId === "string" ? msg.channelId : undefined;
    if (!channelId) return; // every call_* frame carries channelId (voice-contracts.md §1.2) — malformed, drop

    if (type === "call_invite") {
      if (typeof msg.wantRecording !== "boolean") return;
      let live: LiveCall;
      try {
        live = await calls.invite({ channelId, callerConnId: conn.id, caller: conn.sub, wantRecording: msg.wantRecording });
      } catch (err) {
        sendCallError(conn, channelId, err instanceof CallSignalError ? err.code : "invite_failed", err instanceof Error ? err.message : undefined);
        return;
      }
      // Ring EVERY live connection for the callee's sub (all tabs) — the hub is the one place with
      // multi-connection-per-sub visibility (calls/registry.ts deliberately doesn't have it).
      deliverToUser(live.callee, { type: "call_invite", channelId, from: live.caller, wantRecording: live.wantRecording });
      return;
    }

    if (type === "call_solo_start") {
      // Solo self-DM voice memo: no ring, no consent negotiation (you're recording yourself). Goes
      // straight to an active relayed one-leg call; the caller then drives the SAME relayed-mode
      // offer path (call_sdp) and hangs up with call_end, exactly like a 2-party relayed call.
      const wantRecording = typeof msg.wantRecording === "boolean" ? msg.wantRecording : true;
      try {
        await calls.startSolo({ channelId, connId: conn.id, sub: conn.sub, wantRecording });
      } catch (err) {
        sendCallError(conn, channelId, err instanceof CallSignalError ? err.code : "solo_failed", err instanceof Error ? err.message : undefined);
        return;
      }
      // Mirror the `call_accept` confirmation a 2-party relayed call sends its caller, so the app's
      // existing relayed-mode offer path can drive the memo unchanged (`solo:true` lets the UI skip
      // any remote-audio/peer rendering).
      sendToConnection(conn.id, { type: "call_accept", channelId, mode: "relayed", solo: true });
      return;
    }

    if (type === "call_accept") {
      if (typeof msg.consent !== "boolean") return;
      let result: LiveCall | "taken" | "not_ringing";
      try {
        result = await calls.accept({ channelId, connId: conn.id, consent: msg.consent });
      } catch (err) {
        sendCallError(conn, channelId, err instanceof CallSignalError ? err.code : "accept_failed", err instanceof Error ? err.message : undefined);
        return;
      }
      if (result === "not_ringing") {
        sendCallError(conn, channelId, "not_ringing");
      } else if (result === "taken") {
        sendToConnection(conn.id, { type: "call_taken", channelId });
      }
      // A win already sent both bound connections their `call_accept` confirmation from inside
      // CallRegistry.accept() (it has the connection-scoped `send` primitive too) — nothing more to
      // do here.
      return;
    }

    if (type === "call_sdp") {
      if ((msg.sdpType !== "offer" && msg.sdpType !== "answer") || typeof msg.sdp !== "string") return;
      if (Buffer.byteLength(msg.sdp, "utf8") > MAX_CALL_FRAME_BYTES) {
        sendCallError(conn, channelId, "frame_too_large");
        return;
      }
      await calls.relay({ channelId, fromConnId: conn.id, frame: { type: "call_sdp", channelId, sdpType: msg.sdpType, sdp: msg.sdp } });
      return;
    }

    if (type === "call_candidate") {
      conn.callCandidateCount = (conn.callCandidateCount ?? 0) + 1;
      if (conn.callCandidateCount > MAX_CALL_CANDIDATES_PER_CONNECTION) {
        // Hostile/broken peer — same posture frame.ts's FrameDecoder takes on an oversized frame.
        conn.socket.destroy();
        return;
      }
      if (typeof msg.candidate !== "string" || Buffer.byteLength(msg.candidate, "utf8") > MAX_CALL_FRAME_BYTES) return;
      // `sdpMid`/`sdpMLineIndex` may legitimately be `null` (the WebRTC spec's candidate-completion
      // sentinel, voice-contracts.md §1.2) — forwarded as-is, never coerced.
      const sdpMid = msg.sdpMid === null || typeof msg.sdpMid === "string" ? msg.sdpMid : undefined;
      const sdpMLineIndex = msg.sdpMLineIndex === null || typeof msg.sdpMLineIndex === "number" ? msg.sdpMLineIndex : undefined;
      await calls.relay({
        channelId,
        fromConnId: conn.id,
        frame: { type: "call_candidate", channelId, candidate: msg.candidate, sdpMid, sdpMLineIndex },
      });
      return;
    }

    if (type === "call_end") {
      await calls.end({ channelId, connId: conn.id, sub: conn.sub, reason: "hangup" });
    }
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // The runner-daemon attach path (`/runner`) is a DIFFERENT protocol handled by its own hub
    // (ws/runner-hub.ts) — leave that upgrade alone (don't touch the socket) so its listener claims
    // it. This client hub owns every other path.
    if ((req.url ?? "/").split("?")[0] === "/runner") return;

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

    const conn: Connection = { id: randomUUID(), socket, sub: principal.sub, channels: new Set() };
    trackConnection(conn);

    // Per-connection decoder: carries partial frames across "data" events + reassembles
    // fragmentation (frame.ts FrameDecoder). A thrown decode (over the size bound) means a
    // hostile/broken peer — destroy the socket rather than buffering unboundedly.
    const decoder = new FrameDecoder();
    const onData = (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) handleFrame(conn, frame);
      } catch {
        socket.destroy();
      }
    };
    socket.on("data", onData);
    socket.once("close", () => untrackConnection(conn));
    socket.once("error", () => untrackConnection(conn));

    // Bytes the client pipelined immediately after the handshake, before the 101 response
    // even went out, land in `head` rather than a later "data" event — decode those too so
    // an eager client's first message isn't silently lost. Empty in the common case (a
    // client that waits for "open" before sending anything). Runs through the SAME decoder,
    // so a message split between `head` and the first "data" event reassembles too.
    if (head.length > 0) onData(head);
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    void handleUpgrade(req, socket, head).catch(() => socket.destroy());
  }
  server.on("upgrade", onUpgrade);

  // Voice calls' ringing-timeout sweep (§2.1) — CallRegistry.checkRingingTimeouts() is the pure
  // check (mirrors agent/reaper.ts's split); this interval is what drives it. A failing sweep is
  // swallowed so it can never take down the loop, same posture agent/reaper.ts's startReaper takes.
  // unref'd so a running hub never by itself keeps the process alive.
  let ringingSweepTimer: ReturnType<typeof setInterval> | undefined;
  if (deps.calls) {
    const calls = deps.calls;
    ringingSweepTimer = setInterval(() => {
      calls
        .checkRingingTimeouts()
        .then((missed) => {
          for (const m of missed) {
            deliverToUser(m.caller, { type: "call_missed", channelId: m.channelId });
            deliverToUser(m.callee, { type: "call_missed", channelId: m.channelId });
          }
        })
        .catch(() => {
          // one bad sweep must not kill the interval loop
        });
    }, deps.ringingSweepIntervalMs ?? RINGING_SWEEP_INTERVAL_MS);
    ringingSweepTimer.unref?.();
  }

  /** Subscribe a SINGLE connection to a channel (the shared primitive for both entry points). */
  function subscribeConn(conn: Connection, channelId: string): void {
    let subs = channelSubscriptions.get(channelId);
    if (!subs) {
      subs = new Set();
      channelSubscriptions.set(channelId, subs);
    }
    subs.add(conn);
    conn.channels.add(channelId);
  }

  function subscribe(sub: string, channelId: string): void {
    const conns = connectionsBySub.get(sub);
    if (!conns || conns.size === 0) return;
    for (const conn of conns) subscribeConn(conn, channelId);
  }

  /** Subscribe THIS connection to every channel its principal is a member of (via deps.channelsForSub).
   * Powers the client's single long-lived socket: one `{type:"subscribeAll"}` and it receives events
   * for all the user's channels — so background channels update unread (and later @mentions) live. */
  async function subscribeAll(conn: Connection): Promise<void> {
    if (!deps.channelsForSub) return;
    let channelIds: string[];
    try {
      channelIds = await deps.channelsForSub(conn.sub);
    } catch {
      return; // a failed lookup just leaves the connection with no subscriptions
    }
    for (const channelId of channelIds) subscribeConn(conn, channelId);
  }

  function broadcast(channelId: string, payload: unknown): void {
    const subs = channelSubscriptions.get(channelId);
    if (!subs || subs.size === 0) return;

    // Stamp the channel into every frame so a single (subscribeAll) client can route ANY event —
    // including agent-stream events whose payloads don't otherwise name a channel — by `channelId`.
    // A payload that already carries `channelId` keeps its own (same value); non-objects pass through.
    const enriched = payload && typeof payload === "object" ? { channelId, ...(payload as object) } : payload;
    const frame = encodeTextFrame(JSON.stringify(enriched));
    for (const conn of subs) {
      try {
        conn.socket.write(frame);
      } catch {
        // A dead socket here just means its "close"/"error" listener hasn't fired yet —
        // don't let one bad connection break broadcast to the rest.
      }
    }
  }

  /** Push a payload to all of one principal's sockets (see the Hub interface). Unlike broadcast this
   * is NOT gated on channel subscription — the recipient need not have the channel open. */
  function deliverToUser(sub: string, payload: unknown): void {
    const conns = connectionsBySub.get(sub);
    if (!conns || conns.size === 0) return;
    const frame = encodeTextFrame(JSON.stringify(payload));
    for (const conn of conns) {
      try {
        conn.socket.write(frame);
      } catch {
        // A dead socket whose close/error listener hasn't fired yet — don't break delivery to the rest.
      }
    }
  }

  /** See the Hub interface doc comment. Unlike broadcast/deliverToUser this targets exactly ONE
   * connection by its opaque id — voice calls' connection-scoped routing (§2.1). */
  function sendToConnection(connId: string, payload: unknown): boolean {
    const conn = connectionsById.get(connId);
    if (!conn) return false;
    try {
      conn.socket.write(encodeTextFrame(JSON.stringify(payload)));
      return true;
    } catch {
      return false; // a dead socket here just means close/error hasn't fired yet — not a throw
    }
  }

  function close(): void {
    server.off("upgrade", onUpgrade);
    if (ringingSweepTimer) clearInterval(ringingSweepTimer);
    for (const conn of connections) {
      try {
        conn.socket.write(encodeCloseFrame());
      } catch {
        // ignore — we're tearing down the socket unconditionally next
      }
      conn.socket.destroy();
    }
    connections.clear();
    connectionsById.clear();
    connectionsBySub.clear();
    channelSubscriptions.clear();
  }

  function onlineSubs(): string[] {
    return [...connectionsBySub.keys()];
  }

  return { subscribe, broadcast, deliverToUser, onlineSubs, sendToConnection, close };
}
