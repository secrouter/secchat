// Dependency-injected bare-Node HTTP server. Auth (verifyToken) and persistence (store) are
// injected — this module imports neither a concrete token verifier nor a concrete Store, so it
// is testable in isolation with fakes (see test/http.test.ts). src/auth and src/store are built
// in parallel and wired together only at the process entrypoint, not here.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { AdminOverview, AgentControl, AgentKind, Channel, ChannelKind, LlmClient, Message, Principal, Store, VerifyToken } from "../types.ts";
import { Router } from "./router.ts";
import { handleAssistantTurn } from "../assistant/service.ts";
import { isAdmin } from "../admin/gate.ts";

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

/** Content-type for a static web asset, by extension — the small fixed set the SPA build emits
 * (see the static-serving block in createServer below). Anything else is served as opaque bytes
 * rather than guessed at. */
function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
    case ".map":
      return "application/json";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

/** Reads `absPath` (through `cache`, populated on first read — dev-served files don't change
 * within a running process, so a plain read-through Map needs no invalidation) and writes it as
 * the response body with `contentType`. ENOENT (no such file) → 404; anything else (e.g. `absPath`
 * is a directory, a permissions error) → 500 — the same split every other route here uses. */
function serveWebFile(res: ServerResponse, cache: Map<string, Buffer>, absPath: string, contentType: string): void {
  try {
    let data = cache.get(absPath);
    if (!data) {
      data = readFileSync(absPath);
      cache.set(absPath, data);
    }
    res.writeHead(200, { "content-type": contentType });
    res.end(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      sendJson(res, 404, { error: "not_found" });
    } else {
      sendJson(res, 500, { error: "internal" });
    }
  }
}

/** Notify realtime subscribers of a channel event (wired to the WS hub at the entrypoint).
 * Optional so the HTTP layer stays testable without a hub. */
type Broadcast = (channelId: string, payload: unknown) => void;

/** Optional full-text search port (whatever index the deployment wires up — not built here). A
 * deployment/test that doesn't wire one gets a clean 404 on GET /search, same pattern as
 * `control`/`admin` below rather than every route needing its own guard. */
type SearchFn = (userSub: string, q: string) => Promise<Array<Message & { content?: string }>>;

/** Optional admin / audit-review console port (AU 3.3.5/6) — src/admin/overview.ts (the
 * `overview` snapshot builder) and src/admin/console.ts (the `renderConsole` HTML renderer) are
 * built in parallel and injected here, never imported directly, so this module stays testable
 * with fakes. `devMode` additionally exposes `GET /admin` without a bearer token (see
 * createServer below) — a local/dev convenience, never set in a real deployment. A
 * deployment/test that doesn't wire `admin` gets a clean 404 on every /admin* route, same pattern
 * as `control` above. */
interface AdminDeps {
  adminGroup: string;
  devMode?: boolean;
  overview: () => Promise<AdminOverview>;
  renderConsole: (o: AdminOverview) => string;
}

/** After a human posts to a channel, run any ASSISTANT agents that are members of it (decision
 * #5 — server-side model chat, no runner). Fire-and-forget from the route: the user's POST has
 * already returned 201; the reply streams in over the WS hub. Only human-authored messages ever
 * reach here (an assistant's own reply is persisted by handleAssistantTurn directly, not via the
 * HTTP route), so there is no reply loop. Coding agents are ignored here — they run through the
 * agent control plane (Sprint 4), not this synchronous path. */
async function triggerAssistants(
  store: Store,
  llm: LlmClient,
  broadcast: Broadcast | undefined,
  channelId: string,
  promptedBy: string,
  userText: string,
): Promise<void> {
  const members = await store.listMembers(channelId);
  for (const m of members) {
    if (m.memberType !== "agent") continue;
    const agent = await store.getAgent(m.memberRef);
    if (agent?.kind !== "assistant") continue;
    try {
      await handleAssistantTurn({ store, llm, broadcast }, { channelId, agent, promptedBy, userText });
    } catch (err) {
      broadcast?.(channelId, { type: "assistant_error", agentId: agent.id, error: String(err) });
    }
  }
}

function buildRouter(
  store: Store,
  broadcast?: Broadcast,
  llm?: LlmClient,
  control?: AgentControl,
  admin?: AdminDeps,
  search?: SearchFn,
): Router<Handler> {
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

  // The SPA sidebar needs a list of the caller's channels; every other channel read here is
  // scoped to one already-known id. `store.listChannels()` returns every channel (the same read
  // the admin console uses), so this filters to membership itself rather than needing a new
  // Store method — the same isMember gate every per-channel route below already applies.
  router.add("GET", "/channels", async ({ res, principal }) => {
    const chans = await store.listChannels();
    const mine: Channel[] = [];
    for (const c of chans) {
      if (await store.isMember(c.id, principal.sub)) mine.push(c);
    }
    sendJson(res, 200, mine);
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
    const body = (await readJsonBody(req)) as { content?: string; parentId?: string };
    const content = body.content ?? "";
    const message = await store.appendMessage({
      channelId,
      authorRef: principal.sub,
      authorType: "user",
      content,
      parentId: body.parentId,
    });
    // Echo the plaintext the client just posted (the Message row carries only the content HASH),
    // and fan the same shape out to the channel's realtime subscribers.
    const enriched = { ...message, content };
    broadcast?.(channelId, { type: "message", message: enriched });
    sendJson(res, 201, enriched);
    // Kick any assistant members of this channel (after responding — the reply arrives over WS).
    if (llm) void triggerAssistants(store, llm, broadcast, channelId, principal.sub, content);
  });

  // ── Threads: a reply carries `parentId` (read above); this lists a parent's replies in seq
  // order. Same membership gate as every other channel-scoped read here. ─────────────────────────
  router.add("GET", "/channels/:id/threads/:parentId", async ({ res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    sendJson(res, 200, await store.listThread(channelId, params.parentId!));
  });

  // ── Reactions: a mutable per-(message,user,emoji) social signal — never chained (see Store).
  // v1 only requires the caller to be authenticated; it does not check that they can see the
  // message's channel (TODO below), unlike every other route in this file.
  router.add("POST", "/messages/:id/reactions", async ({ req, res, params, principal }) => {
    const body = (await readJsonBody(req)) as { emoji?: string };
    // TODO: verify the caller can see the message's channel
    await store.addReaction(params.id!, principal.sub, body.emoji ?? "");
    sendJson(res, 201, { ok: true });
  });

  router.add("DELETE", "/messages/:id/reactions/:emoji", async ({ res, params, principal }) => {
    await store.removeReaction(params.id!, principal.sub, params.emoji!); // router already decoded the segment
    sendJson(res, 200, { ok: true });
  });

  router.add("GET", "/messages/:id/reactions", async ({ res, params }) => {
    sendJson(res, 200, await store.listReactions(params.id!));
  });

  // ── Per-user read markers → unread counts. Same membership gate as the routes above.
  router.add("GET", "/channels/:id/unread", async ({ res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    sendJson(res, 200, { unread: await store.unreadCount(channelId, principal.sub) });
  });

  router.add("POST", "/channels/:id/read", async ({ req, res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const body = (await readJsonBody(req)) as { seq?: number };
    await store.setLastRead(channelId, principal.sub, body.seq ?? 0);
    sendJson(res, 200, { ok: true });
  });

  // ── Inbound webhooks: this route MINTS the token (returned once, to the member creating it).
  // POSTing TO that token is a separate, unauthenticated route handled before the auth block in
  // createServer below — see there for why (the token itself is the credential, not a bearer
  // token).
  router.add("POST", "/channels/:id/webhooks", async ({ res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const wh = await store.createWebhook(channelId, principal.sub);
    await store.appendAudit({ actor: principal.sub, action: "webhook.create", target: wh.id });
    sendJson(res, 201, wh);
  });

  // ── Full-text search. `search` is the injected port (see SearchFn above); a deployment/test
  // that doesn't wire one gets a clean 404, same pattern as `control`/`admin`.
  router.add("GET", "/search", async ({ req, res, principal }) => {
    if (!search) {
      sendJson(res, 404, { error: "search_unavailable" });
      return;
    }
    const q = new URL(req.url ?? "/", "http://internal").searchParams.get("q") ?? "";
    sendJson(res, 200, await search(principal.sub, q));
  });

  // Spawning an agent creates a channel with the agent pre-added as a member (decision #7: an
  // agent is a channel member, not a separate concept) plus the owning human as its owner.
  router.add("POST", "/agents", async ({ req, res, principal }) => {
    const body = (await readJsonBody(req)) as { kind?: AgentKind; name?: string; model?: string };
    const kind = body.kind ?? "assistant";
    const agent = await store.createAgent({ ownerSub: principal.sub, kind, name: body.name, model: body.model });
    const channel = await store.createChannel({
      workspaceId: "ws-default",
      kind: "agent",
      name: body.name ?? "agent",
      createdBy: principal.sub,
    });
    await store.addMember({ channelId: channel.id, memberRef: principal.sub, memberType: "user", role: "owner" });
    await store.addMember({ channelId: channel.id, memberRef: agent.id, memberType: "agent", role: "member" });
    await store.appendAudit({ actor: principal.sub, action: "agent.spawn", target: agent.id });
    // A coding agent needs a live runner session (Sprint 4's control plane); the assistant path
    // runs synchronously per-message (triggerAssistants) and never gets one. If this deployment
    // hasn't wired a control plane, a "coding" agent is still created — just without a session.
    if (kind === "coding" && control) {
      const session = await control.spawn({ agent, channelId: channel.id, hostType: "server" });
      sendJson(res, 201, { agent, channel, session });
      return;
    }
    sendJson(res, 201, { agent, channel });
  });

  router.add("GET", "/agents", async ({ res, principal }) => {
    sendJson(res, 200, await store.listAgentsByOwner(principal.sub));
  });

  // ── Coding-agent session routes (Sprint 4). `control` is the injected AgentControl port; a
  // deployment/test that doesn't wire one gets a clean 404 on every session route rather than a
  // crash on an undefined `control`.
  router.add("POST", "/sessions/:id/grant-execute", async ({ req, res, params, principal }) => {
    if (!control) {
      sendJson(res, 404, { error: "sessions_unavailable" });
      return;
    }
    const body = (await readJsonBody(req)) as { scope?: "once" | "turn"; turnId?: string };
    const decision = await control.grantExecute({
      sessionId: params.id!,
      byUser: principal.sub,
      scope: body.scope ?? "once",
      turnId: body.turnId,
    });
    // A denied grant is not a server error — it's a policy verdict (only the agent's owner may
    // grant execute; see src/agent/gate.ts) — so the body always carries the decision + reason.
    sendJson(res, decision.allow ? 200 : 403, decision);
  });

  router.add("POST", "/sessions/:id/input", async ({ req, res, params }) => {
    if (!control) {
      sendJson(res, 404, { error: "sessions_unavailable" });
      return;
    }
    const body = (await readJsonBody(req)) as { text?: string };
    // TODO(Sprint 4 follow-up): verify the caller is a participant in this session's channel
    // before accepting input — for now, any authenticated caller can send input.
    await control.sendInput(params.id!, body.text ?? "");
    sendJson(res, 202, { status: "accepted" });
  });

  router.add("GET", "/sessions/:id", async ({ res, params }) => {
    if (!control) {
      sendJson(res, 404, { error: "sessions_unavailable" });
      return;
    }
    const session = await control.getSession(params.id!);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    sendJson(res, 200, session);
  });

  // ── Admin / audit-review console (AU 3.3.5/6). `admin` is the injected port to
  // src/admin/overview.ts + console.ts — never imported directly here (see AdminDeps above). Both
  // routes run through the normal post-auth router pipeline, so `principal` is already a verified
  // identity here; access is gated by isAdmin (membership in admin.adminGroup), the same helper
  // used everywhere admin access is checked. The unauthenticated dev-mode bypass for GET /admin is
  // handled separately in createServer, before routing — see there for why.
  router.add("GET", "/admin/api/overview", async ({ res, principal }) => {
    if (!admin) {
      sendJson(res, 404, { error: "admin_unavailable" });
      return;
    }
    if (!isAdmin(principal, admin.adminGroup)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    sendJson(res, 200, await admin.overview());
  });

  router.add("GET", "/admin", async ({ res, principal }) => {
    if (!admin) {
      sendJson(res, 404, { error: "admin_unavailable" });
      return;
    }
    if (!isAdmin(principal, admin.adminGroup)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    // Render before writing any header: if overview()/renderConsole() throws, this lets the
    // dispatcher's catch-all (createServer below) turn it into a clean 500. Writing the 200
    // header first would leave headers already sent by the time the error is caught, so the
    // dispatcher's own 500 write would itself throw (ERR_HTTP_HEADERS_SENT) instead of a clean
    // response reaching the client.
    const html = admin.renderConsole(await admin.overview());
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });

  return router;
}

/** Builds (but does not start listening) the SecChat HTTP server. `GET /healthz` is always
 * unauthenticated, and so is `GET /admin` when `deps.admin?.devMode` is true (a local/dev
 * convenience — see the dev-mode bypass below); every other route requires a valid
 * `Authorization: Bearer <token>` resolved via `deps.verifyToken`. */
export function createHttpServer(deps: {
  verifyToken: VerifyToken;
  store: Store;
  broadcast?: Broadcast;
  llm?: LlmClient;
  control?: AgentControl;
  admin?: AdminDeps;
  search?: SearchFn;
  /** Static web root for the SPA shell (index.html + assets/*) — see the static-serving block
   * below. Unset in a deployment/test that doesn't serve the SPA from this process. */
  web?: { root: string };
}): Server {
  const router = buildRouter(deps.store, deps.broadcast, deps.llm, deps.control, deps.admin, deps.search);
  // Populated on first read by serveWebFile; see its doc comment for why caching is safe here.
  const webCache = new Map<string, Buffer>();

  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://internal").pathname;

    if (method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // INBOUND WEBHOOK: special-cased before the auth block the SAME way `/healthz` is — the path
    // token IS the credential (minted once, by the owning member, via POST
    // /channels/:id/webhooks above), so there is no bearer token to check here. The body is
    // always read to completion FIRST, before either branch below writes a response header
    // (including the 401 for an unknown token): leaving request-body bytes unconsumed while
    // ending the response can corrupt the next request on a reused keep-alive connection, so
    // draining is unconditional rather than only on the success path.
    if (method === "POST" && pathname.startsWith("/hooks/")) {
      try {
        const token = decodeURIComponent(pathname.slice("/hooks/".length));
        const body = (await readJsonBody(req)) as { text?: string };
        const wh = await deps.store.getWebhookByToken(token);
        if (!wh) {
          sendJson(res, 401, { error: "invalid_webhook" });
          return;
        }
        const text = body.text ?? "";
        const msg = await deps.store.appendMessage({
          channelId: wh.channelId,
          authorRef: "webhook:" + wh.id,
          authorType: "user",
          content: text,
        });
        await deps.store.appendAudit({ actor: "webhook:" + wh.id, action: "webhook.post", target: msg.id });
        deps.broadcast?.(wh.channelId, { type: "message", message: { ...msg, content: text } });
        sendJson(res, 201, { id: msg.id });
      } catch (err) {
        if (err instanceof BadJsonError) {
          sendJson(res, 400, { error: "bad_json" });
        } else {
          sendJson(res, 500, { error: "internal" });
        }
      }
      return;
    }

    // DEV-MODE BYPASS: special-cased the SAME way `/healthz` is (before the auth block below) so
    // the console is reachable in a browser with no bearer token — but ONLY when admin.devMode is
    // true (a local/dev convenience; never set in a real deployment). The production/authed path
    // is the `GET /admin` route registered in buildRouter, which requires isAdmin like every other
    // admin route. This has its own try/catch (rather than relying on the router's dispatcher,
    // which this bypasses entirely) so a render error becomes a 500 instead of an unhandled
    // rejection; rendering before writing any header keeps that 500 write clean (see the router's
    // GET /admin handler above for why order matters here).
    if (method === "GET" && pathname === "/admin" && deps.admin?.devMode) {
      try {
        const html = deps.admin.renderConsole(await deps.admin.overview());
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        sendJson(res, 500, { error: "internal" });
      }
      return;
    }

    // STATIC WEB ASSETS (the SPA shell): special-cased before the auth block the SAME way
    // `/healthz` is — the shell (index.html) and its assets (JS/CSS/...) must be fetchable by a
    // browser holding no bearer token yet, since loading the shell is how login happens in the
    // first place. Only engages when `deps.web` is set; a deployment/test that doesn't wire it
    // falls through `/` (and `/assets/...`) to the normal 401/404 below, same as any other route.
    // `/assets/<path>` is resolved against `<root>/assets` and rejected (404) if that would
    // escape the directory — defense in depth alongside the dot-segment normalization `new URL`
    // already applied to `pathname` above.
    if (method === "GET" && deps.web) {
      // Serve any EXISTING file under the web root (the SPA shell + all its assets). This must be
      // general, not just `/assets/*`: a Flutter build emits `/main.dart.js`, `/flutter.js`,
      // `/canvaskit/*`, `/assets/*`, etc. at arbitrary paths. The path is resolved against the root
      // and rejected if it would escape it (traversal-safe). A path that isn't a real file — an API
      // route like `/me`, or an in-app route — falls THROUGH to the auth+router below (we only
      // short-circuit when a file actually exists), so static serving never shadows the API.
      const rootAbs = resolve(deps.web.root);
      const rel = pathname === "/" || pathname === "" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
      const target = resolve(rootAbs, rel);
      if (target === rootAbs || target.startsWith(rootAbs + sep)) {
        try {
          if (statSync(target).isFile()) {
            serveWebFile(res, webCache, target, contentTypeFor(target));
            return;
          }
        } catch {
          // no such file (ENOENT) or not a regular file → fall through to the API router
        }
      }
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
