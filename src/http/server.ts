// Dependency-injected bare-Node HTTP server. Auth (verifyToken) and persistence (store) are
// injected — this module imports neither a concrete token verifier nor a concrete Store, so it
// is testable in isolation with fakes (see test/http.test.ts). src/auth and src/store are built
// in parallel and wired together only at the process entrypoint, not here.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { ChannelKind, Principal, Store, VerifyToken } from "../types.ts";
import { Router } from "./router.ts";

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  principal: Principal;
}

type Handler = (ctx: RouteContext) => Promise<void>;

/** Thrown by `readJsonBody` on malformed input. The dispatcher maps it to 400; every other
 * handler exception maps to 500 — so individual route handlers don't need their own try/catch. */
class BadJsonError extends Error {}

/** Pull the token out of `Authorization: Bearer <token>`; null if absent/malformed. */
function bearerToken(header: string | undefined): string | null {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Buffers and JSON-parses the request body. An empty body resolves to `{}` (every route here
 * treats "no body" as "no fields given" rather than an error); malformed JSON throws
 * BadJsonError for the dispatcher to turn into a 400. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BadJsonError("invalid JSON body"));
      }
    });
  });
}

/** Notify realtime subscribers of a channel event (wired to the WS hub at the entrypoint).
 * Optional so the HTTP layer stays testable without a hub. */
type Broadcast = (channelId: string, payload: unknown) => void;

function buildRouter(store: Store, broadcast?: Broadcast): Router<Handler> {
  const router = new Router<Handler>();

  router.add("GET", "/me", async ({ res, principal }) => {
    sendJson(res, 200, principal);
  });

  router.add("POST", "/channels", async ({ req, res, principal }) => {
    const body = (await readJsonBody(req)) as { name?: string; kind?: ChannelKind; workspaceId?: string };
    const channel = await store.createChannel({
      workspaceId: body.workspaceId ?? "ws-default",
      kind: body.kind ?? "human",
      name: body.name,
      createdBy: principal.sub,
    });
    await store.addMember({ channelId: channel.id, memberRef: principal.sub, memberType: "user", role: "owner" });
    await store.appendAudit({ actor: principal.sub, action: "channel.create", target: channel.id });
    sendJson(res, 201, channel);
  });

  router.add("GET", "/channels/:id/messages", async ({ res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    sendJson(res, 200, await store.listMessages(channelId));
  });

  router.add("POST", "/channels/:id/messages", async ({ req, res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const body = (await readJsonBody(req)) as { content?: string };
    const content = body.content ?? "";
    const message = await store.appendMessage({ channelId, authorRef: principal.sub, authorType: "user", content });
    // Echo the plaintext the client just posted (the Message row carries only the content HASH),
    // and fan the same shape out to the channel's realtime subscribers.
    const enriched = { ...message, content };
    broadcast?.(channelId, { type: "message", message: enriched });
    sendJson(res, 201, enriched);
  });

  return router;
}

/** Builds (but does not start listening) the SecChat HTTP server. `GET /healthz` is the only
 * unauthenticated route; every other route requires a valid `Authorization: Bearer <token>`
 * resolved via `deps.verifyToken`. */
export function createHttpServer(deps: {
  verifyToken: VerifyToken;
  store: Store;
  broadcast?: Broadcast;
}): Server {
  const router = buildRouter(deps.store, deps.broadcast);

  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://internal").pathname;

    if (method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    let principal: Principal;
    try {
      const token = bearerToken(req.headers.authorization);
      if (!token) throw new Error("missing bearer token");
      principal = await deps.verifyToken(token);
    } catch {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const matched = router.match(method, pathname);
    if (!matched) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    try {
      await matched.handler({ req, res, params: matched.params, principal });
    } catch (err) {
      if (err instanceof BadJsonError) {
        sendJson(res, 400, { error: "bad_json" });
      } else {
        sendJson(res, 500, { error: "internal" });
      }
    }
  });
}
