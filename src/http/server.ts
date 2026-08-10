// Dependency-injected bare-Node HTTP server. Auth (verifyToken) and persistence (store) are
// injected — this module imports neither a concrete token verifier nor a concrete Store, so it
// is testable in isolation with fakes (see test/http.test.ts). src/auth and src/store are built
// in parallel and wired together only at the process entrypoint, not here.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { AdminOverview, AgentControl, AgentKind, Attachment, AuthGateway, Channel, ChannelKind, LlmClient, Member, Message, Principal, Reaction, Store, User, VerifyToken } from "../types.ts";
import { resolveMentions } from "../mentions/parse.ts";
import { Router } from "./router.ts";
import { handleAssistantTurn } from "../assistant/service.ts";
import { isAdmin } from "../admin/gate.ts";
import {
  DEFAULT_CUI_CATEGORIES,
  DEFAULT_MARKING,
  DEFAULT_MARKING_LEVELS,
  makeMarkingPolicy,
  type MarkingPolicy,
} from "../marking/policy.ts";
import { dominates, formatMarking, joinMarking, type Marking, parseMarking } from "../marking/caveats.ts";
import { overallPortionMarking } from "../marking/portions.ts";
import { type BlobStore, sha256Hex } from "../attachments/blobs.ts";
import { attachmentsManifest } from "../attachments/manifest.ts";

/** Attachment byte storage + the upload size cap (a deployment setting). Unset ⇒ the upload/download
 * routes 501 (attachments not configured); tests inject a MemoryBlobStore. */
interface AttachmentDeps {
  blobs: BlobStore;
  maxUploadBytes: number;
}

/** Read a raw (non-JSON) request body into a Buffer, rejecting once it exceeds `maxBytes`. Unlike
 * readJsonBody (unbounded), this is the bounded path for binary uploads. */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return; // over the cap already — ignore the rest (don't destroy: the 413 still needs to flush)
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(Object.assign(new Error("payload too large"), { tooLarge: true }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
import { DlpPolicy } from "../dlp/policy.ts";
import { authorizeCapability, type Capability, type CapabilityPolicy, defaultCapabilityPolicy } from "../auth/capabilities.ts";
import type { StepUp } from "../auth/stepup.ts";
import { parseCookies } from "../auth/session.ts";

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

/** One cached web asset, keyed to the on-disk mtime it was read at. */
type WebCacheEntry = { mtimeMs: number; data: Buffer };

/** Reads `absPath` (through `cache`) and writes it as the response body with `contentType`. The
 * cache is invalidated by mtime, NOT read-once: a rebuilt asset (a fresh `flutter build web` while
 * the server keeps running) must be served without a restart, so we re-read whenever the file's
 * mtime changes. The SPA shell and its assets are not content-hash-named (Flutter emits a stable
 * `main.dart.js`), so they're sent `Cache-Control: no-cache` — browsers may store them but must
 * revalidate every load, otherwise a redeploy leaves clients running a stale bundle indefinitely.
 * ENOENT (no such file) → 404; anything else (e.g. `absPath` is a directory, a permissions error)
 * → 500 — the same split every other route here uses. */
function serveWebFile(res: ServerResponse, cache: Map<string, WebCacheEntry>, absPath: string, contentType: string): void {
  try {
    const mtimeMs = statSync(absPath).mtimeMs;
    let entry = cache.get(absPath);
    if (!entry || entry.mtimeMs !== mtimeMs) {
      entry = { mtimeMs, data: readFileSync(absPath) };
      cache.set(absPath, entry);
    }
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
    res.end(entry.data);
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

/** Deliver a payload to ALL of one principal's realtime connections, regardless of which channel
 * they're viewing (wired to hub.deliverToUser). Powers user-targeted signals like @mention
 * notifications. Optional so the HTTP layer stays testable without a hub. */
type Notify = (sub: string, payload: unknown) => void;

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
  marking: MarkingPolicy,
  dlp: DlpPolicy,
  capabilities: CapabilityPolicy,
  stepUp: StepUp | undefined,
  broadcast?: Broadcast,
  llm?: LlmClient,
  control?: AgentControl,
  admin?: AdminDeps,
  search?: SearchFn,
  attachments?: AttachmentDeps,
  notify?: Notify,
): Router<Handler> {
  const router = new Router<Handler>();

  // How long ago (seconds) this request's caller last re-authenticated. The step-up proof arrives
  // either as the `X-Sec-StepUp` header (bearer/dev clients, from POST /auth/stepup) or the
  // `secchat_stepup` httpOnly cookie (the interactive OIDC re-auth flow, auth/bff.ts). Infinity
  // when there's no valid, matching proof.
  const stepUpAge = async (req: IncomingMessage, sub: string): Promise<number> => {
    const header = req.headers["x-sec-stepup"];
    const token = (Array.isArray(header) ? header[0] : header) || parseCookies(req.headers.cookie)["secchat_stepup"];
    if (!token || !stepUp) return Infinity;
    const proof = await stepUp.verify(token);
    return proof && proof.sub === sub ? proof.ageSeconds : Infinity;
  };

  // Enforce a privileged capability; on denial writes the right 403 and returns false. `forbidden_group`
  // and `stepup_required` are distinct so the client can offer re-authentication for the latter.
  const enforceCapability = async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    capability: Capability,
  ): Promise<boolean> => {
    const decision = authorizeCapability(principal, capability, capabilities, await stepUpAge(req, principal.sub));
    if (decision.allow) return true;
    if (decision.reason === "stepup_required") {
      sendJson(res, 403, { error: "stepup_required", capability: decision.capability, maxAgeSeconds: decision.maxAgeSeconds });
    } else {
      sendJson(res, 403, { error: "forbidden" });
    }
    return false;
  };

  router.add("GET", "/me", async ({ res, principal }) => {
    // Record/refresh this principal in the seen-users directory (from their real SSO claims) — the
    // client calls /me on every load, so this is where a user first enters the roster that powers
    // DM selection. Awaited so a just-signed-in user is discoverable by the /users call that
    // typically follows on the same load.
    await store.upsertUser({
      sub: principal.sub,
      email: principal.email,
      displayName: principal.displayName,
      groups: principal.groups,
    });
    // Carry the deployment's marking ladder + default so the client can render banners, populate
    // the marking picker, and compare ranks locally (it also enforces, but the server is authority).
    sendJson(res, 200, {
      ...principal,
      marking: {
        levels: marking.levels,
        default: marking.default,
        // The enabled CUI categories (optional caveats) the client offers on the marking picker.
        categories: marking.caveats.map((c) => ({ code: c.code, name: c.name, level: c.level })),
      },
    });
  });

  // Establish a step-up proof for NON-INTERACTIVE callers (a bearer/dev/service client presents the
  // returned token via `X-Sec-StepUp`), recorded in the audit chain. Interactive browser clients use
  // the genuine fresh-re-auth flow instead — GET /auth/stepup/start → OIDC prompt=login → the
  // callback verifies a fresh `auth_time` and sets the `secchat_stepup` cookie (see auth/bff.ts).
  router.add("POST", "/auth/stepup", async ({ res, principal }) => {
    if (!stepUp) {
      sendJson(res, 503, { error: "stepup_unavailable" });
      return;
    }
    const token = await stepUp.mint(principal.sub);
    await store.appendAudit({ actor: principal.sub, action: "auth.stepup" });
    sendJson(res, 200, { token });
  });

  // The user directory (seen-users): everyone who has signed in via SSO, with their real group
  // claims. Any authenticated user may read it (a team roster); it's what the DM picker lists.
  router.add("GET", "/users", async ({ res }) => {
    sendJson(res, 200, await store.listUsers());
  });

  // Groups derived from the directory — each group with the subs that claim it. "Real groups from
  // SSO" surfaced as a roster-by-group, without a separate group store (the claims ARE the source).
  router.add("GET", "/groups", async ({ res }) => {
    const users = await store.listUsers();
    const byGroup = new Map<string, string[]>();
    for (const user of users) {
      for (const group of user.groups) {
        const members = byGroup.get(group);
        if (members) members.push(user.sub);
        else byGroup.set(group, [user.sub]);
      }
    }
    const groups = [...byGroup.entries()]
      .map(([name, members]) => ({ name, members }))
      .sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, groups);
  });

  // Open (or reuse) a 1:1 DM with another user. Idempotent: one DM channel per pair, ever — a
  // second call returns the existing one (200) rather than minting a duplicate (201). The target
  // must be a known directory user (you can only DM someone SecChat has seen sign in).
  router.add("POST", "/dm", async ({ req, res, principal }) => {
    const body = (await readJsonBody(req)) as { user?: string };
    const other = (body.user ?? "").trim();
    if (!other) {
      sendJson(res, 400, { error: "user required" });
      return;
    }
    if (other === principal.sub) {
      sendJson(res, 400, { error: "cannot DM yourself" });
      return;
    }
    if (!(await store.getUser(other))) {
      sendJson(res, 404, { error: "unknown user" });
      return;
    }
    const existing = await store.findDmChannel(principal.sub, other);
    if (existing) {
      // Carry `members` so the client can label the DM with the peer immediately,
      // exactly as GET /channels does for a DM.
      sendJson(res, 200, { ...existing, members: [principal.sub, other] });
      return;
    }
    const channel = await store.createChannel({
      workspaceId: "ws-default",
      kind: "dm",
      createdBy: principal.sub,
    });
    await store.addMember({ channelId: channel.id, memberRef: principal.sub, memberType: "user", role: "owner" });
    await store.addMember({ channelId: channel.id, memberRef: other, memberType: "user", role: "member" });
    await store.appendAudit({ actor: principal.sub, action: "dm.create", target: channel.id, detail: other });
    sendJson(res, 201, { ...channel, members: [principal.sub, other] });
  });

  router.add("POST", "/channels", async ({ req, res, principal }) => {
    const body = (await readJsonBody(req)) as { name?: string; kind?: ChannelKind; workspaceId?: string; marking?: string };
    // An optional INITIAL channel marking (setting it later goes through POST /channels/:id/marking).
    // A supplied marking must be a valid level + legal caveats (e.g. "CUI//SP-PRVCY"); it is stored
    // in canonical banner form. Unset ⇒ unmarked (per-message marking applies).
    let cuiMarking: string | undefined;
    if (body.marking != null && body.marking.trim() !== "") {
      const parsed = parseMarking(marking, body.marking);
      if (!parsed) {
        sendJson(res, 400, { error: "unknown marking", levels: marking.levels });
        return;
      }
      cuiMarking = formatMarking(parsed);
    }
    const channel = await store.createChannel({
      workspaceId: body.workspaceId ?? "ws-default",
      kind: body.kind ?? "human",
      name: body.name,
      cuiMarking,
      createdBy: principal.sub,
    });
    await store.addMember({ channelId: channel.id, memberRef: principal.sub, memberType: "user", role: "owner" });
    await store.appendAudit({ actor: principal.sub, action: "channel.create", target: channel.id, detail: cuiMarking });
    sendJson(res, 201, channel);
  });

  // ── Classification marking: set (or change) a channel's level. When a channel is marked, the
  // channel IS the portion — every message inherits it and none may exceed it. Any member may SET a
  // marking or RAISE it; only an admin may DOWNGRADE (lower the level) — loosening a control is a
  // privileged act. Validated against the ladder; audited (`channel.mark`) by the store; a live
  // `channel_marking` event updates every viewer's banner.
  router.add("POST", "/channels/:id/marking", async ({ req, res, params, principal }) => {
    const channelId = params.id!;
    const channel = await store.getChannel(channelId);
    if (!channel) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const body = (await readJsonBody(req)) as { marking?: string };
    const parsedNext = parseMarking(marking, body.marking ?? "");
    if (!parsedNext) {
      sendJson(res, 400, { error: "unknown marking", levels: marking.levels });
      return;
    }
    const next = formatMarking(parsedNext);
    // Downgrade = LOOSENING the control: lowering the level OR dropping a caveat — i.e. the new
    // marking does NOT dominate the current one. That is the privileged `marking.downgrade`
    // capability (group-gated, default the admin group; step-up if configured). Raising the level or
    // adding a caveat (the new marking dominates the current) is an ordinary member act.
    const current = channel.cuiMarking ? parseMarking(marking, channel.cuiMarking) : null;
    const isDowngrade = current != null && !dominates(marking, parsedNext, current);
    if (isDowngrade && !(await enforceCapability(req, res, principal, "marking.downgrade"))) return;
    const updated = await store.setChannelMarking(channelId, next, principal.sub);
    broadcast?.(channelId, { type: "channel_marking", channelId, marking: next, by: principal.sub });
    sendJson(res, 200, updated);
  });

  // The SPA sidebar needs a list of the caller's channels; every other channel read here is
  // scoped to one already-known id. `store.listChannels()` returns every channel (the same read
  // the admin console uses), so this filters to membership itself rather than needing a new
  // Store method — the same isMember gate every per-channel route below already applies.
  router.add("GET", "/channels", async ({ res, principal }) => {
    const chans = await store.listChannels();
    const mine: Array<Channel & { members?: string[] }> = [];
    for (const c of chans) {
      if (!(await store.isMember(c.id, principal.sub))) continue;
      if (c.kind === "dm") {
        // A DM has no fixed name — the client labels it with the OTHER participant, so it needs
        // the member subs. Only dm channels carry this (few of them, and only they need it).
        const members = (await store.listMembers(c.id))
          .filter((m) => m.memberType === "user")
          .map((m) => m.memberRef);
        mine.push({ ...c, members });
      } else {
        mine.push(c);
      }
    }
    sendJson(res, 200, mine);
  });

  router.add("GET", "/channels/:id/messages", async ({ req, res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    // Optional cursor paging: `?limit=N` returns the most recent N (ascending), with `?before=<seq>`
    // for the previous (older) page. No `limit` ⇒ the legacy full-array shape (backwards-compatible).
    const q = new URL(req.url ?? "", "http://localhost").searchParams;
    const limit = q.has("limit") ? Math.max(1, Math.min(200, Number(q.get("limit")) || 0)) : undefined;
    const before = q.has("before") ? Number(q.get("before")) : undefined;
    const messages = await store.listMessages(channelId, { limit, before });
    // Attach each message's reactions in ONE read (not N per-message calls) so the client renders
    // reaction chips straight from history without a follow-up request per message.
    const byMessage = new Map<string, Reaction[]>();
    for (const reaction of await store.listReactionsForChannel(channelId)) {
      const list = byMessage.get(reaction.messageId);
      if (list) list.push(reaction);
      else byMessage.set(reaction.messageId, [reaction]);
    }
    // Same one-read enrichment for attachments (metadata only — bytes are fetched lazily via download).
    const filesByMessage = new Map<string, Attachment[]>();
    for (const a of await store.listAttachmentsForChannel(channelId)) {
      if (!a.messageId) continue;
      const list = filesByMessage.get(a.messageId);
      if (list) list.push(a);
      else filesByMessage.set(a.messageId, [a]);
    }
    const enriched = messages.map((m) => ({
      ...m,
      reactions: byMessage.get(m.id) ?? [],
      ...(filesByMessage.has(m.id) ? { attachments: filesByMessage.get(m.id) } : {}),
    }));
    if (limit == null) {
      sendJson(res, 200, enriched); // legacy: the whole channel as a bare array
      return;
    }
    // `nextCursor` = the oldest seq in this page, to pass as `before` for the next older page — or
    // null when we've reached the start (a short page, or the first message is included).
    const nextCursor = enriched.length === limit && enriched[0] && enriched[0].seq > 1 ? enriched[0].seq : null;
    sendJson(res, 200, { messages: enriched, nextCursor });
  });

  router.add("POST", "/channels/:id/messages", async ({ req, res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const channel = await store.getChannel(channelId);
    const channelMarking = channel?.cuiMarking ? parseMarking(marking, channel.cuiMarking) : null;
    const body = (await readJsonBody(req)) as {
      content?: string;
      parentId?: string;
      marking?: string;
      attachmentIds?: string[];
    };
    const content = body.content ?? "";
    // Resolve + ENFORCE the classification marking (blocking). A requested marking is a full banner
    // (level + optional categories, e.g. "CUI//SP-PRVCY"); an invalid one is a 400.
    let requested: Marking | null = null;
    if (body.marking != null && body.marking.trim() !== "") {
      requested = parseMarking(marking, body.marking);
      if (!requested) {
        sendJson(res, 400, { error: "unknown marking", levels: marking.levels });
        return;
      }
    }
    let effective: Marking;
    if (channelMarking) {
      // Marked channel: the channel IS the portion. A message may never EXCEED the channel ceiling —
      // the channel must DOMINATE it (≥ level AND superset of caveats), else spillage block. Otherwise
      // the message simply takes the channel marking, whatever was requested.
      if (requested && !dominates(marking, channelMarking, requested)) {
        sendJson(res, 422, { error: "marking_exceeds_channel", channel: channel!.cuiMarking });
        return;
      }
      effective = channelMarking;
    } else {
      // Unmarked channel / DM: per-message marking, defaulting to the policy floor (bare level).
      effective = requested ?? { level: marking.default, caveats: [] };
    }
    // Inline CUI PORTION markings — e.g. "(CUI) a controlled line", "(CUI//SP-PRVCY) …" — RAISE the
    // message's overall marking to the join of its portions (the CUI convention). In a marked channel
    // a portion the channel can't dominate is spillage; in an unmarked channel it drives the overall up.
    const portionMax = overallPortionMarking(marking, content);
    if (portionMax) {
      if (channelMarking) {
        if (!dominates(marking, channelMarking, portionMax)) {
          sendJson(res, 422, { error: "marking_exceeds_channel", channel: channel!.cuiMarking });
          return;
        }
      } else if (!dominates(marking, effective, portionMax)) {
        effective = joinMarking(marking, effective, portionMax);
      }
    }
    // Attachments (attach-on-post): each requested id must be an UNCLAIMED upload in THIS channel; its
    // marking is folded into the message's (a file can't out-classify the message carrying it — raise
    // an unmarked channel's message to cover it, or spillage-block a marked channel). The manifest
    // digest of the claimed set is bound into the message hash below.
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds : [];
    const attachedFiles: Attachment[] = [];
    for (const aid of attachmentIds) {
      const a = await store.getAttachment(aid);
      if (!a || a.channelId !== channelId || a.messageId != null) {
        sendJson(res, 400, { error: "invalid_attachment", attachmentId: aid });
        return;
      }
      const am = parseMarking(marking, a.marking) ?? { level: marking.default, caveats: [] };
      if (channelMarking) {
        if (!dominates(marking, channelMarking, am)) {
          sendJson(res, 422, { error: "marking_exceeds_channel", channel: channel!.cuiMarking });
          return;
        }
      } else if (!dominates(marking, effective, am)) {
        effective = joinMarking(marking, effective, am);
      }
      attachedFiles.push(a);
    }
    const attachmentsSha256 = attachedFiles.length > 0 ? attachmentsManifest(attachedFiles) : "";
    // Local DLP scan (on-premise; matches only rule NAMES, never the content). In `block` mode a
    // match refuses the post before anything is written; in `flag` mode the post proceeds but is
    // recorded as an audited `message.dlp_flag` and the flag rides along for live display.
    const dlpHits = dlp.scan(content);
    if (dlpHits.length > 0 && dlp.mode === "block") {
      sendJson(res, 422, { error: "dlp_blocked", rules: dlpHits });
      return;
    }
    const message = await store.appendMessage({
      channelId,
      authorRef: principal.sub,
      authorType: "user",
      content,
      parentId: body.parentId,
      marking: formatMarking(effective),
      attachmentsSha256,
    });
    // Claim the uploads for this message (sets their messageId) now that it exists.
    const attachments = attachmentIds.length > 0 ? await store.claimAttachments(message.id, attachmentIds) : [];
    if (dlpHits.length > 0) {
      // flag mode (block already returned): a provable, content-free trail on the audit chain.
      await store.appendAudit({ actor: principal.sub, action: "message.dlp_flag", target: message.id, detail: dlpHits.join(",") });
    }
    // @mentions: resolve @handle tokens against this channel's HUMAN members (you can only notify
    // someone who can read the channel), record a durable inbox row per mentioned user (survives a
    // reconnect — the WS hub has no offline queue), and push a live `mention` to their sockets. The
    // "@" pre-check skips the members load for the overwhelming no-mention case; persistence happens
    // BEFORE the 201 so the inbox is consistent the moment the post returns, and delivery is
    // best-effort (a notification hiccup never fails an already-written message).
    if (content.includes("@")) {
      try {
        const members = await store.listMembers(channelId);
        const memberUsers: User[] = [];
        for (const m of members) {
          if (m.memberType !== "user") continue;
          // Seen-users model: a member who hasn't signed in yet has no directory row — fall back to a
          // sub-only User so at least sub-based handle matching still works.
          memberUsers.push((await store.getUser(m.memberRef)) ?? { sub: m.memberRef, groups: [], lastSeenAt: message.createdAt });
        }
        for (const sub of resolveMentions(memberUsers, content, principal.sub)) {
          const mention = await store.addMention({ messageId: message.id, channelId, mentionedSub: sub, authorSub: principal.sub });
          notify?.(sub, { type: "mention", channelId, mention: { ...mention, seq: message.seq, content, channelName: channel?.name } });
        }
      } catch {
        // best-effort: the message is already posted + will broadcast below regardless
      }
    }
    // Echo the plaintext the client just posted (the Message row carries only the content HASH),
    // and fan the same shape out to the channel's realtime subscribers. `dlpFlags` (when present)
    // drives a live warning indicator; the durable record is the audit event above.
    const enriched = {
      ...message,
      content,
      ...(dlpHits.length ? { dlpFlags: dlpHits } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    broadcast?.(channelId, { type: "message", message: enriched });
    sendJson(res, 201, enriched);
    // Kick any assistant members of this channel (after responding — the reply arrives over WS).
    if (llm) void triggerAssistants(store, llm, broadcast, channelId, principal.sub, content);
  });

  // ── Attachments: upload (unclaimed) then reference from a message post (attach-on-post). Bytes are
  // sent as the RAW body with metadata in the query (?filename&contentType&marking); a size cap, the
  // channel marking ceiling, and DLP all apply. Returns the attachment row (id + sha256) to reference. ─
  router.add("POST", "/channels/:id/attachments", async ({ req, res, params, principal }) => {
    const channelId = params.id!;
    if (!attachments) {
      sendJson(res, 501, { error: "attachments_not_configured" });
      return;
    }
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const channel = await store.getChannel(channelId);
    const channelMarking = channel?.cuiMarking ? parseMarking(marking, channel.cuiMarking) : null;
    const q = new URL(req.url ?? "", "http://localhost").searchParams;
    const filename = (q.get("filename") ?? "file").slice(0, 255);
    const ctHeader = req.headers["content-type"];
    const contentType =
      (Array.isArray(ctHeader) ? ctHeader[0] : ctHeader) || q.get("contentType") || "application/octet-stream";
    // The file's marking: requested (query) or the channel's, defaulting to the floor. A marked
    // channel is the ceiling — a file may not exceed it.
    let fileMarking: Marking;
    if (q.get("marking")?.trim()) {
      const parsed = parseMarking(marking, q.get("marking")!);
      if (!parsed) {
        sendJson(res, 400, { error: "unknown marking", levels: marking.levels });
        return;
      }
      fileMarking = parsed;
    } else {
      fileMarking = channelMarking ?? { level: marking.default, caveats: [] };
    }
    if (channelMarking && !dominates(marking, channelMarking, fileMarking)) {
      sendJson(res, 422, { error: "marking_exceeds_channel", channel: channel!.cuiMarking });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readRawBody(req, attachments.maxUploadBytes);
    } catch (err) {
      if ((err as { tooLarge?: boolean }).tooLarge) {
        sendJson(res, 413, { error: "payload_too_large", maxBytes: attachments.maxUploadBytes });
        return;
      }
      throw err;
    }
    if (bytes.length === 0) {
      sendJson(res, 400, { error: "empty_upload" });
      return;
    }
    // DLP on TEXTUAL content only (on-prem, rule NAMES never content). `block` refuses the upload.
    const isText = contentType.startsWith("text/") || contentType === "application/json";
    const dlpHits = isText ? dlp.scan(bytes.toString("utf8")) : [];
    if (dlpHits.length > 0 && dlp.mode === "block") {
      sendJson(res, 422, { error: "dlp_blocked", rules: dlpHits });
      return;
    }
    const sha = sha256Hex(bytes);
    await attachments.blobs.write(sha, bytes);
    const attachment = await store.addAttachment({
      channelId,
      uploadedBy: principal.sub,
      filename,
      contentType,
      byteSize: bytes.length,
      sha256: sha,
      marking: formatMarking(fileMarking),
    });
    await store.appendAudit({ actor: principal.sub, action: "attachment.upload", target: attachment.id, detail: filename });
    if (dlpHits.length > 0) {
      await store.appendAudit({ actor: principal.sub, action: "attachment.dlp_flag", target: attachment.id, detail: dlpHits.join(",") });
    }
    sendJson(res, 201, dlpHits.length ? { ...attachment, dlpFlags: dlpHits } : attachment);
  });

  // Download an attachment's bytes. Membership on its channel is re-checked (attachments are CUI), and
  // a claimed attachment whose message was redacted is treated as purged (404).
  router.add("GET", "/attachments/:id", async ({ res, params, principal }) => {
    if (!attachments) {
      sendJson(res, 501, { error: "attachments_not_configured" });
      return;
    }
    const attachment = await store.getAttachment(params.id!);
    if (!attachment) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!(await store.isMember(attachment.channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    if (attachment.messageId) {
      const msg = await store.getMessage(attachment.messageId);
      if (msg?.redactedAt) {
        sendJson(res, 404, { error: "redacted" });
        return;
      }
    }
    const bytes = await attachments.blobs.read(attachment.sha256);
    if (!bytes) {
      sendJson(res, 404, { error: "bytes_missing" });
      return;
    }
    res.writeHead(200, {
      "content-type": attachment.contentType,
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename="${attachment.filename.replace(/["\r\n]/g, "")}"`,
      "cache-control": "private, no-store",
    });
    res.end(bytes);
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
  // Access-controlled by the reacted-to message's channel: you must be a member of the channel the
  // message lives in (resolved via getMessage). Add/remove broadcast a `reaction` event so peers
  // update live. A missing message is treated as forbidden (don't leak which ids exist).
  router.add("POST", "/messages/:id/reactions", async ({ req, res, params, principal }) => {
    const messageId = params.id!;
    const message = await store.getMessage(messageId);
    if (!message || !(await store.isMember(message.channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const body = (await readJsonBody(req)) as { emoji?: string };
    const emoji = body.emoji ?? "";
    await store.addReaction(messageId, principal.sub, emoji);
    broadcast?.(message.channelId, { type: "reaction", op: "add", channelId: message.channelId, messageId, userSub: principal.sub, emoji });
    sendJson(res, 201, { ok: true });
  });

  router.add("DELETE", "/messages/:id/reactions/:emoji", async ({ res, params, principal }) => {
    const messageId = params.id!;
    const message = await store.getMessage(messageId);
    if (!message || !(await store.isMember(message.channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const emoji = params.emoji!; // router already decoded the segment
    await store.removeReaction(messageId, principal.sub, emoji);
    broadcast?.(message.channelId, { type: "reaction", op: "remove", channelId: message.channelId, messageId, userSub: principal.sub, emoji });
    sendJson(res, 200, { ok: true });
  });

  router.add("GET", "/messages/:id/reactions", async ({ res, params, principal }) => {
    const message = await store.getMessage(params.id!);
    if (!message || !(await store.isMember(message.channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    sendJson(res, 200, await store.listReactions(params.id!));
  });

  // ── Redaction: a governed content PURGE (CUI-spillage / incident response), NOT a casual delete.
  // `redactMessage` drops the plaintext while keeping the row + content HASH + chain links, stamps
  // redactedAt, and appends an audited `message.redact` event carrying the reason — so the chain
  // still verifies and the purge is provable (who/when/why) WITHOUT retaining the content (decision
  // #9). Authorized for the message's AUTHOR or an admin; membership-gated; reason required; once
  // (409 if already redacted). Broadcasts a `redaction` event so every viewer's copy updates live.
  router.add("POST", "/messages/:id/redact", async ({ req, res, params, principal }) => {
    const messageId = params.id!;
    const message = await store.getMessage(messageId);
    if (!message) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!(await store.isMember(message.channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    // The author may always redact their own; redacting ANOTHER's message is the privileged
    // `message.redact` capability (group-gated, default the admin group; step-up if configured).
    if (message.authorRef !== principal.sub) {
      if (!(await enforceCapability(req, res, principal, "message.redact"))) return;
    }
    if (message.redactedAt) {
      sendJson(res, 409, { error: "already_redacted" });
      return;
    }
    const body = (await readJsonBody(req)) as { reason?: string };
    const reason = (body.reason ?? "").trim();
    if (!reason) {
      sendJson(res, 400, { error: "reason required" });
      return;
    }
    await store.redactMessage(messageId, principal.sub, reason);
    broadcast?.(message.channelId, { type: "redaction", channelId: message.channelId, messageId, by: principal.sub });
    sendJson(res, 200, { ok: true });
  });

  // ── Trackable edit: a revision, never an in-place rewrite. `editMessage` leaves the original row
  // (and the hash chain, which binds the ORIGINAL content) untouched, appends the new version to the
  // message's history, and records an audited `message.edit` event — so "who edited when" is provable
  // and every prior version is retained (until redaction purges them). AUTHOR-ONLY, deliberately
  // narrower than redaction: an admin's remedy for bad content is a visible redaction tombstone, never
  // a silent rewrite of someone else's words. Membership-gated; non-empty content required; 409 on a
  // redacted message. Broadcasts a `message_edit` event so every viewer's copy updates live.
  router.add("POST", "/messages/:id/edit", async ({ req, res, params, principal }) => {
    const messageId = params.id!;
    const message = await store.getMessage(messageId);
    if (!message) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!(await store.isMember(message.channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    if (message.authorRef !== principal.sub) {
      sendJson(res, 403, { error: "forbidden" }); // author-only — no admin override (see comment above)
      return;
    }
    if (message.redactedAt) {
      sendJson(res, 409, { error: "already_redacted" });
      return;
    }
    const body = (await readJsonBody(req)) as { content?: string };
    const content = (body.content ?? "").trim();
    if (!content) {
      sendJson(res, 400, { error: "content required" });
      return;
    }
    const updated = await store.editMessage(messageId, principal.sub, content);
    broadcast?.(message.channelId, {
      type: "message_edit",
      messageId,
      channelId: message.channelId,
      content,
      editedAt: updated.editedAt,
      by: principal.sub,
    });
    sendJson(res, 200, { message: updated, content });
  });

  // The full version history of a message (original + every edit), for the "edited · view history"
  // affordance. Any channel member may read it; content is omitted on every revision once redacted.
  router.add("GET", "/messages/:id/revisions", async ({ res, params, principal }) => {
    const message = await store.getMessage(params.id!);
    if (!message || !(await store.isMember(message.channelId, principal.sub))) {
      sendJson(res, message ? 403 : 404, { error: message ? "forbidden" : "not_found" });
      return;
    }
    sendJson(res, 200, { revisions: await store.listRevisions(params.id!) });
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

  // ── Channel membership management. Reading the roster needs only membership; CHANGING it (add /
  // remove / role) is owner-or-admin — per-channel ownership is the right authority for membership
  // (a global capability would let one group manage EVERY channel). A channel must always keep at
  // least one owner, so the last owner can't be removed or demoted.
  const adminGroup = admin?.adminGroup ?? "secchat-admins";
  /** True if `principal` may change `channelId`'s membership: an owner member, or a platform admin. */
  async function canManageMembers(channelId: string, principal: Principal): Promise<boolean> {
    if (isAdmin(principal, adminGroup)) return true;
    const members = await store.listMembers(channelId);
    return members.some((m) => m.memberRef === principal.sub && m.memberType === "user" && m.role === "owner");
  }

  router.add("GET", "/channels/:id/members", async ({ res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    // Enrich each member with a display label (user directory name / agent name) so the panel needs
    // no second fetch; falls back to the raw ref when unknown.
    const members = await store.listMembers(channelId);
    const enriched = await Promise.all(
      members.map(async (m) => {
        if (m.memberType === "user") {
          const u = await store.getUser(m.memberRef);
          return { ...m, displayName: u?.displayName, email: u?.email };
        }
        const a = await store.getAgent(m.memberRef);
        return { ...m, displayName: a?.name, agentKind: a?.kind };
      }),
    );
    sendJson(res, 200, enriched);
  });

  // Add a member, or change an existing member's role (idempotent upsert). Owner-or-admin only.
  router.add("POST", "/channels/:id/members", async ({ req, res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.getChannel(channelId))) {
      sendJson(res, 404, { error: "unknown_channel" });
      return;
    }
    if (!(await canManageMembers(channelId, principal))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const body = (await readJsonBody(req)) as { user?: string; role?: string };
    const memberRef = (body.user ?? "").trim();
    if (!memberRef) {
      sendJson(res, 400, { error: "user_required" });
      return;
    }
    const role: Member["role"] = body.role === "owner" ? "owner" : "member";
    // Guard the last owner: demoting the sole owner to member would orphan the channel.
    if (role === "member") {
      const members = await store.listMembers(channelId);
      const owners = members.filter((m) => m.role === "owner");
      if (owners.length === 1 && owners[0]!.memberRef === memberRef) {
        sendJson(res, 409, { error: "last_owner", detail: "a channel must keep at least one owner" });
        return;
      }
    }
    const existed = await store.isMember(channelId, memberRef);
    await store.addMember({ channelId, memberRef, memberType: "user", role });
    await store.appendAudit({ actor: principal.sub, action: existed ? "channel.set_role" : "channel.add_member", target: channelId, detail: `${memberRef}:${role}` });
    broadcast?.(channelId, { type: "membership", channelId, op: existed ? "role" : "add", memberRef, role });
    notify?.(memberRef, { type: "membership", channelId, op: existed ? "role" : "add", memberRef, role }); // refresh the affected user's channel list
    sendJson(res, existed ? 200 : 201, { channelId, memberRef, memberType: "user", role });
  });

  // Remove a member. Owner-or-admin only; the last owner can't be removed.
  router.add("DELETE", "/channels/:id/members/:ref", async ({ res, params, principal }) => {
    const channelId = params.id!;
    const memberRef = decodeURIComponent(params.ref!);
    if (!(await canManageMembers(channelId, principal))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const members = await store.listMembers(channelId);
    const target = members.find((m) => m.memberRef === memberRef);
    if (!target) {
      sendJson(res, 404, { error: "not_a_member" });
      return;
    }
    const owners = members.filter((m) => m.role === "owner");
    if (target.role === "owner" && owners.length === 1) {
      sendJson(res, 409, { error: "last_owner", detail: "a channel must keep at least one owner" });
      return;
    }
    await store.removeMember(channelId, memberRef);
    await store.appendAudit({ actor: principal.sub, action: "channel.remove_member", target: channelId, detail: memberRef });
    broadcast?.(channelId, { type: "membership", channelId, op: "remove", memberRef });
    notify?.(memberRef, { type: "membership", channelId, op: "remove", memberRef }); // let the removed user drop the channel
    sendJson(res, 200, { ok: true });
  });

  // ── @mentions inbox: the caller's own mentions across every channel (durable — see the mentions
  // table). `?unseen=1` limits to not-yet-seen; `?limit=N` caps the page. No channel id: mentions
  // are inherently cross-channel and always scoped to `principal.sub`, so there's no other user's
  // data to leak.
  router.add("GET", "/mentions", async ({ req, res, principal }) => {
    const url = new URL(req.url ?? "/", "http://x");
    const unseenOnly = url.searchParams.get("unseen") === "1";
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : undefined;
    const [mentions, unseen] = await Promise.all([
      store.listMentionsForUser(principal.sub, { unseenOnly, limit }),
      store.countUnseenMentions(principal.sub),
    ]);
    sendJson(res, 200, { mentions, unseen });
  });

  // Mark the caller's mentions seen — all of them, or just `{ ids: [...] }`. Returns the new unseen
  // count so the client can refresh its badge in one round-trip.
  router.add("POST", "/mentions/seen", async ({ req, res, principal }) => {
    const body = (await readJsonBody(req)) as { ids?: string[] };
    const ids = Array.isArray(body.ids) && body.ids.length > 0 ? body.ids : undefined;
    await store.markMentionsSeen(principal.sub, ids);
    sendJson(res, 200, { unseen: await store.countUnseenMentions(principal.sub) });
  });

  // ── Inbound webhooks: this route MINTS the token (returned once, to the member creating it).
  // POSTing TO that token is a separate, unauthenticated route handled before the auth block in
  // createServer below — see there for why (the token itself is the credential, not a bearer
  // token).
  router.add("POST", "/channels/:id/webhooks", async ({ req, res, params, principal }) => {
    const channelId = params.id!;
    if (!(await store.isMember(channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    // Minting a standing external credential is the `webhook.create` capability (ungated by default;
    // step-up-eligible). Membership is still required above.
    if (!(await enforceCapability(req, res, principal, "webhook.create"))) return;
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
    // Standing up an executing delegate is the `agent.manage` capability (combined with granting it
    // execute). Ungated by default; a deployment ties it to an operator group (from the IdP).
    if (!(await enforceCapability(req, res, principal, "agent.manage"))) return;
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
    // Empowering an agent to run a mutating tool is the same `agent.manage` capability as spawning
    // one — it composes with the owner-only check inside control.grantExecute below.
    if (!(await enforceCapability(req, res, principal, "agent.manage"))) return;
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

  router.add("POST", "/sessions/:id/input", async ({ req, res, params, principal }) => {
    if (!control) {
      sendJson(res, 404, { error: "sessions_unavailable" });
      return;
    }
    // Only a participant of the session's channel may drive it: resolve the session to its channel
    // and apply the same membership gate as every channel-scoped route (a missing session is 404).
    const session = await control.getSession(params.id!);
    if (!session) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!(await store.isMember(session.channelId, principal.sub))) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const body = (await readJsonBody(req)) as { text?: string };
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
 * convenience — see the dev-mode bypass below); every other route requires either a valid
 * `Authorization: Bearer <token>` resolved via `deps.verifyToken`, or (bearer absent, `deps.auth`
 * wired) a valid `secchat_session` cookie resolved via `deps.auth.resolveSession` — see the auth
 * block near the bottom of this function. `deps.auth` also serves `/auth/*` (login/callback/
 * logout/status) itself, pre-auth, exactly like `/healthz`. */
export function createHttpServer(deps: {
  verifyToken: VerifyToken;
  store: Store;
  broadcast?: Broadcast;
  llm?: LlmClient;
  control?: AgentControl;
  admin?: AdminDeps;
  search?: SearchFn;
  /** The SSO login BFF (see auth/bff.ts's makeAuthGateway). Unset ⇒ no /auth/* routes at all
   * (404, same as any other unmatched path) and cookie-session auth is never attempted — only
   * the bearer path works, same behavior as before this dependency existed. */
  auth?: AuthGateway;
  /** Static web root for the SPA shell (index.html + assets/*) — see the static-serving block
   * below. Unset in a deployment/test that doesn't serve the SPA from this process. */
  web?: { root: string };
  /** The classification-marking ladder (a deployment setting, see config.ts). Unset ⇒ the built-in
   * default ladder (UNCLASSIFIED→PROPRIETARY→CUI→CLASSIFIED, default UNCLASSIFIED), so tests and
   * bare deployments still enforce a sane policy. */
  marking?: MarkingPolicy;
  /** Local DLP scanner (a deployment setting). Unset ⇒ an OFF policy (no scanning), so tests and
   * bare deployments are unaffected until DLP is deliberately configured. */
  dlp?: DlpPolicy;
  /** Privileged-capability policy (a deployment setting). Unset ⇒ the behavior-preserving defaults
   * (redact/downgrade → the admin group; agent/webhook ungated; step-up off). */
  capabilities?: CapabilityPolicy;
  /** Step-up token verifier/minter. Unset ⇒ POST /auth/stepup is unavailable and any capability that
   * requires step-up fails closed (can't be satisfied). */
  stepUp?: StepUp;
  /** Attachment byte storage + upload size cap. Unset ⇒ the upload/download routes 501. */
  attachments?: AttachmentDeps;
  /** Per-user realtime delivery (wired to hub.deliverToUser). Unset ⇒ @mentions are still recorded
   * durably (the inbox route), just not pushed live. */
  notify?: Notify;
}): Server {
  const marking = deps.marking ?? makeMarkingPolicy([...DEFAULT_MARKING_LEVELS], DEFAULT_MARKING, [...DEFAULT_CUI_CATEGORIES]);
  const dlp = deps.dlp ?? new DlpPolicy("off", []);
  const capabilities = deps.capabilities ?? defaultCapabilityPolicy(deps.admin?.adminGroup ?? "secchat-admins");
  const router = buildRouter(deps.store, marking, dlp, capabilities, deps.stepUp, deps.broadcast, deps.llm, deps.control, deps.admin, deps.search, deps.attachments, deps.notify);
  // Populated on first read by serveWebFile; see its doc comment for why caching is safe here.
  const webCache = new Map<string, WebCacheEntry>();

  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://internal").pathname;

    if (method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // SSO LOGIN (OIDC BFF): special-cased before the auth block the SAME way `/healthz` is —
    // logging in can't itself require already being logged in. `deps.auth` (see auth/bff.ts)
    // owns GET /auth/status|login|callback and POST /auth/logout entirely — it writes the
    // response itself and reports whether it recognized the request. Placed first (right after
    // /healthz, before the webhook/dev-admin/static-serving special cases below) so nothing can
    // ever shadow it. A deployment/test that doesn't wire `auth` falls through unchanged: every
    // /auth/* request just reaches the normal 401/404 flow below, same as any other unknown path.
    if (deps.auth && (await deps.auth.handleAuthRoutes(req, res))) {
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

    // Bearer-first: a presented Authorization header is the credential — if it's invalid this is
    // a 401, full stop, with no silent fallback to the cookie. Only when NO bearer token is
    // present at all do we consult `secchat_session` (via deps.auth?.resolveSession), which reads
    // the Cookie header a same-origin browser sends automatically on every fetch/WS upgrade — see
    // auth/bff.ts. `deps.auth` unset (no SSO wired) behaves exactly as before this dependency
    // existed: no bearer ⇒ straight to 401.
    let principal: Principal;
    try {
      const token = bearerToken(req.headers.authorization);
      if (token) {
        principal = await deps.verifyToken(token);
      } else {
        const sessionPrincipal = await deps.auth?.resolveSession(req);
        if (!sessionPrincipal) throw new Error("no credentials (no bearer token, no valid session cookie)");
        principal = sessionPrincipal;
      }
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
