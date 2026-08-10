// The runner-daemon ATTACH endpoint: a WebSocket upgrade on `/runner` over which a remote runner
// daemon (bundled in a user's desktop app, or standalone on their server/container) connects to
// SecChat, authenticates with its own token, and is registered as the runner for its owner (see
// remote-runner.ts + runner-registry.ts). The daemon then speaks the runner protocol
// (runner-protocol.ts): SecChat sends it RunnerCommands, it sends up RunnerMessages.
//
// Deliberately a SEPARATE hub from the client ws/hub.ts (different protocol, different auth surface):
// the client hub skips `/runner`, this one owns only `/runner`. Dependency-free framing is reused
// from ws/frame.ts (no `ws` package), matching the client hub.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { VerifyToken } from "../types.ts";
import type { RunnerRegistry, RunnerConnection } from "../agent/runner-registry.ts";
import type { RemoteRunner } from "../agent/remote-runner.ts";
import { parseRunnerMessage, type RunnerCommand } from "../agent/runner-protocol.ts";
import { computeAcceptKey, decodeFrames, encodeCloseFrame, encodePong, encodeTextFrame, OPCODE } from "./frame.ts";

export interface RunnerHub {
  close(): void;
}

/** Attach the `/runner` daemon-attach hub to an existing http.Server. */
export function attachRunnerHub(
  server: Server,
  deps: {
    verifyToken: VerifyToken;
    registry: RunnerRegistry;
    remote: RemoteRunner;
    /** Verify a scoped runner token (auth/runner-token.ts). Tried FIRST — a cookie-session desktop
     * user mints one of these for its daemon; a standalone daemon on a server still authenticates
     * with its own OIDC bearer via `verifyToken`. Unset ⇒ only the bearer path. */
    verifyRunnerToken?: (token: string) => Promise<{ sub: string } | null>;
  },
): RunnerHub {
  // runnerId -> its socket, so a superseded daemon (same owner reconnecting) can be closed.
  const socketByRunner = new Map<string, Duplex>();

  function extractToken(req: IncomingMessage): string | undefined {
    const url = new URL(req.url ?? "/", "http://runner.internal");
    const fromQuery = url.searchParams.get("token");
    if (fromQuery) return fromQuery;
    return req.headers["sec-websocket-protocol"]?.split(",")[0]?.trim();
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if ((req.url ?? "/").split("?")[0] !== "/runner") return; // not ours — leave it for the client hub

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    // A daemon authenticates with its OWNER's token (dev bearer or OIDC) — same VerifyToken the rest
    // of the server uses. The authenticated sub is the owner the daemon runs for.
    let ownerSub: string;
    try {
      const token = extractToken(req);
      if (!token) throw new Error("no token");
      // A scoped runner token (the common desktop path) first; else a full OIDC/dev bearer.
      const viaRunner = deps.verifyRunnerToken ? await deps.verifyRunnerToken(token) : null;
      ownerSub = viaRunner ? viaRunner.sub : (await deps.verifyToken(token)).sub;
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.write(
      ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${computeAcceptKey(key)}`, "\r\n"].join("\r\n"),
    );

    const runnerId = randomUUID();
    const conn: RunnerConnection = {
      ownerSub,
      runnerId,
      send: (cmd: RunnerCommand) => {
        try {
          socket.write(encodeTextFrame(JSON.stringify(cmd)));
        } catch {
          // a dead socket whose close handler hasn't fired yet — ignore
        }
      },
    };
    socketByRunner.set(runnerId, socket);

    // Register — superseding any prior daemon for this owner (last-attach wins); close the old one.
    const superseded = deps.registry.register(conn);
    if (superseded) {
      const old = socketByRunner.get(superseded.runnerId);
      socketByRunner.delete(superseded.runnerId);
      try {
        old?.write(encodeCloseFrame());
        old?.destroy();
      } catch {
        // ignore
      }
    }

    let gone = false;
    const teardown = () => {
      if (gone) return;
      gone = true;
      socketByRunner.delete(runnerId);
      deps.registry.unregister(ownerSub, runnerId);
      deps.remote.handleDaemonGone(conn); // ends the daemon's live sessions cleanly
    };

    const onData = (chunk: Buffer) => {
      for (const frame of decodeFrames(chunk)) {
        switch (frame.opcode) {
          case OPCODE.PING:
            socket.write(encodePong(frame.payload));
            break;
          case OPCODE.CLOSE:
            socket.write(encodeCloseFrame());
            socket.end();
            break;
          case OPCODE.TEXT: {
            const msg = parseRunnerMessage(frame.payload.toString("utf8"));
            if (msg) deps.remote.handleDaemonMessage(conn, msg);
            break;
          }
          default:
            break; // PONG / anything else: no action
        }
      }
    };

    socket.on("data", onData);
    socket.once("close", teardown);
    socket.once("error", teardown);
    if (head.length > 0) onData(head);
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    void handleUpgrade(req, socket, head).catch(() => socket.destroy());
  }
  server.on("upgrade", onUpgrade);

  return {
    close(): void {
      server.off("upgrade", onUpgrade);
      for (const socket of socketByRunner.values()) {
        try {
          socket.write(encodeCloseFrame());
        } catch {
          // ignore
        }
        socket.destroy();
      }
      socketByRunner.clear();
    },
  };
}
