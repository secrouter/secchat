// Dependency-injected bare-Node HTTP server. Auth (verifyToken) and persistence (store) are
// injected — this module imports neither a concrete token verifier nor a concrete Store, so it
// is testable in isolation with fakes (see test/http.test.ts). src/auth and src/store are built
// in parallel and wired together only at the process entrypoint, not here.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AdminOverview, AgentControl, AgentKind, ChannelKind, LlmClient, Principal, Store, VerifyToken } from "../types.ts";
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

/** Notify realtime subscribers of a channel event (wired to the WS hub at the entrypoint).
 * Optional so the HTTP layer stays testable without a hub. */
type Broadcast = (channelId: string, payload: unknown) => void;

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

function buildRouter(store: Store, broadcast?: Broadcast, llm?: LlmClient, control?: AgentControl, admin?: AdminDeps): Router<Handler> {
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
    // Kick any assistant members of this channel (after responding — the reply arrives over WS).
    if (llm) void triggerAssistants(store, llm, broadcast, channelId, principal.sub, content);
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
}): Server {
  const router = buildRouter(deps.store, deps.broadcast, deps.llm, deps.control, deps.admin);

  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://internal").pathname;

    if (method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" });
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
