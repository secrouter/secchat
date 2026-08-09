// SecChat shared contracts — the integration surface every module builds against.
//
// Kept deliberately small and dependency-free (matches SecRouter's zero-dep ethos). The
// backend depends only on `jose` (JWKS) at runtime; persistence is behind the `Store`
// interface (an in-memory impl now, a Postgres impl when the network is back), and the
// HTTP/WS/LLM layers take their dependencies by injection so each is testable in isolation.

// Type-only import of Node's built-in http types (not an npm dependency — erased at compile
// time by `verbatimModuleSyntax`); needed for AuthGateway's method signatures below.
import type { IncomingMessage, ServerResponse } from "node:http";

export type Id = string; // uuid v4 (string form)
export type Sha256Hex = string; // 64-char lowercase hex

/** An authenticated end user, derived ONLY from a SecSSO (Authentik) token (see auth/jwks). */
export interface Principal {
  sub: string; // stable subject id from the IdP
  email?: string;
  displayName?: string;
  groups: string[]; // group claims → drive per-group authz downstream
}

/** Verifies a bearer token and returns the Principal, or throws. Injected everywhere so the
 * HTTP layer never imports a concrete verifier (testable with a fake). */
export type VerifyToken = (token: string) => Promise<Principal>;

/** The SSO login port (server-side OIDC Backend-For-Frontend): a concrete implementation is
 * built by auth/bff.ts's `makeAuthGateway` and injected into both the HTTP server and the WS hub
 * — mirroring how VerifyToken above is defined here but implemented in auth/jwks.ts, so neither
 * transport module imports auth/bff.ts directly (stays testable with a fake). The BFF flow keeps
 * every OIDC token server-side; the browser only ever holds an httpOnly session cookie. */
export interface AuthGateway {
  /** Serves GET /auth/status, GET /auth/login, GET /auth/callback, and POST /auth/logout —
   * writing the response itself and returning true when it did. Returns false (response
   * untouched) for any other request, so the caller falls through to its normal routing; called
   * PRE-AUTH (alongside /healthz), since logging in can't itself require already being logged
   * in. */
  handleAuthRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Parses and verifies the `secchat_session` cookie (if any) from `req`'s Cookie header,
   * returning the Principal it carries. Null — never throws — if the cookie is absent, expired,
   * or invalid, so callers can treat "no cookie" and "bad cookie" identically. The fallback
   * credential behind a missing bearer token (see http/server.ts and ws/hub.ts). */
  resolveSession(req: IncomingMessage): Promise<Principal | null>;
}

export type ChannelKind = "human" | "agent" | "dm";
export type MemberType = "user" | "agent";
export type AuthorType = "user" | "agent";
export type AgentKind = "assistant" | "coding";

export interface Channel {
  id: Id;
  workspaceId: Id;
  kind: ChannelKind;
  name?: string;
  /** The channel's classification level (a rung of the deployment's marking ladder, see
   * marking/policy.ts). When set, the channel IS the portion — every message inherits it and no
   * message may exceed it (spillage block). Unset ("unspecified") ⇒ marking is per-message. */
  cuiMarking?: string;
  createdBy: string; // Principal.sub
  createdAt: string; // ISO-8601 UTC
}

export interface Member {
  channelId: Id;
  memberRef: string; // Principal.sub for users, agent id for agents
  memberType: MemberType;
  role: "owner" | "member";
}

/** A directory entry for a real end user, captured from their SSO token the first time they are
 * seen and refreshed on every later sign-in — the "seen-users" directory. It powers DM target
 * selection and surfaces real group membership. `groups` is whatever the IdP put in the token's
 * group claim (so it always reflects the user's current groups as of their last sign-in). This
 * needs no Authentik admin API and holds no standing secret; an optional IdP-directory sync that
 * also lists users who have never signed in is a later, additive step. */
export interface User {
  sub: string; // stable subject id from the IdP — the directory key
  email?: string;
  displayName?: string;
  groups: string[];
  lastSeenAt: string; // ISO-8601 UTC — most recent time this principal was observed
}

/** A spawned agent, owned by — and acting as — exactly one user (decision #2/#7). Sprint 2
 * implements `assistant` (server-side model chat, NO runner); `coding` (runner + tools +
 * owner-gated execution) lands in Sprint 4. Its model calls are always attributed to
 * `ownerSub` at SecRouter, regardless of who prompts. */
export interface Agent {
  id: Id;
  ownerSub: string;
  kind: AgentKind;
  name?: string;
  model?: string; // SecRouter model id used for the assistant path
  createdAt: string;
}

/** A message row. The hash chain is over metadata + the CONTENT HASH (never the plaintext),
 * so a redaction can drop the plaintext while leaving the chain verifiable (see audit/chain). */
export interface Message {
  id: Id;
  channelId: Id;
  seq: number; // 1-based, per channel
  authorRef: string; // Principal.sub for users; agent id for agent messages
  authorType: AuthorType;
  /** For an agent message, the human whose prompt triggered this turn (decision #2). Recorded
   * on the row AND in the chained audit event; not itself bound into the message hash. */
  promptedBy?: string;
  /** Thread parent — a reply points at the message it answers. Metadata (like promptedBy); not
   * bound into the message hash. Top-level messages leave it unset. */
  parentId?: Id;
  contentSha256: Sha256Hex; // hash of the ORIGINAL content — stays even after redaction
  /** The message's EFFECTIVE classification level (a rung of the marking ladder), stamped at write:
   * the channel's level when the channel is marked, else the author's per-message choice (defaulting
   * to the policy default). Bound INTO the hash chain — a marking you could silently alter wouldn't
   * be a control — so it's immutable and tamper-evident like contentSha256. */
  marking: string;
  prevHash: Sha256Hex;
  hash: Sha256Hex;
  createdAt: string;
  redactedAt?: string; // set when plaintext is purged (tombstone); chain still verifies
  /** Set to the latest edit time once the author has revised this message. Metadata (like
   * promptedBy/parentId/redactedAt) — NOT bound into the message hash, so edits never touch the
   * chain: the row stays anchored to `contentSha256` (the original) while revisions accrue
   * out-of-band and each edit is recorded as an audited `message.edit` event. */
  editedAt?: string;
}

/** One version of a message's text. Revision 1 is the original (held on the Message row itself);
 * an edit appends revision 2, 3, … Each revision keeps its own content hash so the history is
 * self-describing; `content` is dropped (tombstoned) if the message is later redacted. Revisions
 * are NOT a separate chain — the tamper-evident record of an edit is its `message.edit` audit
 * event; the message chain stays bound to the original `contentSha256`. */
export interface MessageRevision {
  messageId: Id;
  revision: number; // 1 = original, ascending
  authorRef: string; // who wrote this revision (always the original author — edit is author-only)
  content?: string; // omitted for a redacted message
  contentSha256: Sha256Hex;
  at: string; // createdAt for revision 1, the edit time thereafter
}

/** Metadata-only audit event (the SecRouter pattern — NEVER content). Its own global chain. */
export interface AuditEvent {
  id: Id;
  seq: number;
  actor: string; // who acted (Principal.sub, or a service id)
  actAs?: string; // delegated end-user, when an agent/service acts on someone's behalf
  action: string; // e.g. "message.redact", "channel.create", "agent.spawn"
  target?: string;
  detail?: string; // short non-content note, e.g. a redaction reason (still metadata, not CUI)
  prevHash: Sha256Hex;
  hash: Sha256Hex;
  at: string;
}

/** Cursor paging for `listMessages`. `before` is a seq (exclusive upper bound); `limit` caps the page
 * size, taking the most recent messages within the bound. Both unset ⇒ the whole channel. */
export interface MessagePageOpts {
  limit?: number;
  before?: number;
}

export interface AppendMessageInput {
  channelId: Id;
  authorRef: string;
  authorType: AuthorType;
  content: string;
  promptedBy?: string;
  parentId?: Id;
  /** The author's requested per-message marking. Ignored when the channel is marked (the channel
   * level is stamped instead). When the channel is unmarked, this is the message's level, defaulting
   * to the policy default when omitted. The store validates/stamps the EFFECTIVE marking. */
  marking?: string;
}

/** A reaction (emoji) a user placed on a message. Mutable social signal — NOT in the audit
 * chain. (userSub, messageId, emoji) is unique: reacting twice with the same emoji is a no-op. */
export interface Reaction {
  messageId: Id;
  userSub: string;
  emoji: string;
  at: string;
}

/** An inbound webhook: an opaque token that lets an external system post into ONE channel as a
 * bot author. The token is the credential; treat it like a secret. */
export interface Webhook {
  id: Id;
  channelId: Id;
  token: string;
  createdBy: string;
  createdAt: string;
}

export interface AppendAuditInput {
  actor: string;
  action: string;
  actAs?: string;
  target?: string;
  detail?: string;
}

/** Persistence port. MemoryStore implements it now; PgStore later (behind the same interface).
 * appendMessage/appendAudit own the chain linkage internally (via audit/chain). */
export interface Store {
  createChannel(input: Omit<Channel, "id" | "createdAt">): Promise<Channel>;
  getChannel(id: Id): Promise<Channel | null>;
  /** Set (or change) a channel's classification level, recording an audited `channel.mark` event.
   * The route owns authz (member to set/raise; admin to downgrade) and validates the level against
   * the policy; the store just persists + audits atomically. Returns the updated channel. */
  setChannelMarking(channelId: Id, marking: string, by: string): Promise<Channel>;
  addMember(m: Member): Promise<void>;
  listMembers(channelId: Id): Promise<Member[]>;
  isMember(channelId: Id, ref: string): Promise<boolean>;

  // Directory of users seen via SSO (captured from their tokens) — powers DMs + the roster.
  /** Record or refresh a user from their token claims; `email`/`displayName` are preserved when
   * the new observation omits them (a dev token carries neither), `groups` always overwrites. */
  upsertUser(input: { sub: string; email?: string; displayName?: string; groups: string[] }): Promise<User>;
  listUsers(): Promise<User[]>;
  getUser(sub: string): Promise<User | null>;
  /** The existing 1:1 DM channel whose two user members are exactly these subs (order-independent),
   * or null. Used to keep POST /dm idempotent (one DM per pair, never a duplicate). */
  findDmChannel(subA: string, subB: string): Promise<Channel | null>;

  createAgent(input: Omit<Agent, "id" | "createdAt">): Promise<Agent>;
  getAgent(id: Id): Promise<Agent | null>;
  listAgentsByOwner(ownerSub: string): Promise<Agent[]>;

  appendMessage(input: AppendMessageInput): Promise<Message>;
  /** One message by id (metadata only — no content), or null. Used to resolve a message's channel
   * for an access-control check on message-scoped routes (e.g. reactions). */
  getMessage(id: Id): Promise<Message | null>;
  /** Messages in seq order; `content` is omitted for redacted rows. With `opts.limit`, returns the
   * most recent `limit` (the tail), or — with `opts.before` (a seq cursor, exclusive) — the `limit`
   * messages just before it (the previous page for scroll-back). Unbounded (both unset) ⇒ the whole
   * channel, so existing callers are unaffected. Always ascending by seq. */
  listMessages(channelId: Id, opts?: MessagePageOpts): Promise<Array<Message & { content?: string }>>;
  /** Replies to `parentId` in `channelId`, seq order; `content` omitted for redacted rows. */
  listThread(channelId: Id, parentId: Id): Promise<Array<Message & { content?: string }>>;
  redactMessage(id: Id, by: string, reason: string): Promise<void>;
  /** Revise a message's text, preserving history. Appends a revision, stamps `editedAt`, and
   * records an audited `message.edit` event; the original row (and the message chain) is
   * untouched. Author-only is enforced at the route — an admin's remedy for bad content is
   * redaction, not a silent rewrite. Throws on a redacted message (no plaintext to revise).
   * Returns the updated message (with `editedAt` set). */
  editMessage(id: Id, by: string, content: string): Promise<Message>;
  /** Full version history for a message, revision order (1 = original). `content` is omitted on
   * every revision once the message is redacted. */
  listRevisions(id: Id): Promise<MessageRevision[]>;

  // Reactions (mutable; not chained).
  addReaction(messageId: Id, userSub: string, emoji: string): Promise<void>; // idempotent per (user,emoji)
  removeReaction(messageId: Id, userSub: string, emoji: string): Promise<void>;
  listReactions(messageId: Id): Promise<Reaction[]>;
  /** All reactions on any message in `channelId` — lets the message-history route attach reactions
   * to each message in one read instead of N per-message calls. */
  listReactionsForChannel(channelId: Id): Promise<Reaction[]>;

  // Per-user read markers → unread counts.
  setLastRead(channelId: Id, userSub: string, seq: number): Promise<void>;
  unreadCount(channelId: Id, userSub: string): Promise<number>; // messages with seq > last-read

  // Inbound webhooks.
  createWebhook(channelId: Id, createdBy: string): Promise<Webhook>; // mints a random token
  getWebhookByToken(token: string): Promise<Webhook | null>;

  appendAudit(input: AppendAuditInput): Promise<AuditEvent>;
  /** Recompute both chains end-to-end; used by the audit-review console + tests. */
  verifyChains(): Promise<{ messagesOk: boolean; auditOk: boolean }>;

  // Read paths for the admin / audit-review console (AU 3.3.5/6).
  listAudit(): Promise<AuditEvent[]>;
  listChannels(): Promise<Channel[]>;
  listAllAgents(): Promise<Agent[]>;
}

/** A read-only snapshot for the admin / audit-review console. */
export interface AdminOverview {
  generatedAt: string;
  channels: Channel[];
  agents: Agent[];
  sessions: AgentSession[];
  audit: AuditEvent[];
  chains: { messagesOk: boolean; auditOk: boolean };
}

// ── The LLM egress port (the assistant path) ────────────────────────────────────────────────
// The assistant path calls SecRouter's OpenAI-compatible endpoint, delegated to the agent's
// owner (X-Sec-Acting-User) so policy/budget/audit land on that user. Behind a port so the
// orchestration is testable against a stub upstream (no running SecRouter needed).

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteRequest {
  model: string;
  messages: LlmMessage[];
  /** The owner sub — forwarded as X-Sec-Acting-User so SecRouter governs this call as them. */
  actingUser: string;
}

/** Streams assistant text deltas. The real impl talks to SecRouter; tests use a fake. */
export interface LlmClient {
  complete(req: LlmCompleteRequest): AsyncIterable<string>;
}

// ── Coding-agent control plane: sessions, the execute-gate, the runner port ──────────────────
// The sharp-edged subsystem (decision #2, review C1). A coding agent runs on a RUNNER (a pi
// process, server- or laptop-hosted) as a SESSION; its transcript streams to the channel. It is
// in PLAN MODE by default — reads/analysis only; a mutating tool needs the OWNER's execute grant.

export type SessionStatus = "starting" | "active" | "orphaned" | "ended";

/** A live coding-agent instance. Lease is renewed by runner heartbeats; a lapsed lease → the
 * reaper marks it `orphaned` (the runner/laptop went away). */
export interface AgentSession {
  id: Id;
  agentId: Id;
  channelId: Id;
  hostType: "server" | "local";
  runnerId?: string;
  status: SessionStatus;
  createdAt: string;
  leaseExpiresAt: string;
  endedAt?: string;
}

/** A tool is `read` (safe — allowed in plan mode) or `mutate` (side-effectful — needs an owner
 * execute grant). Unknown tools classify as `mutate` (fail closed). */
export type ToolClass = "read" | "mutate";

/** The owner's scoped authorization to let an agent run mutating tools. ONLY the agent's owner
 * can create one — the execute-gate enforces that (an invited participant never can). */
export interface ExecuteGrant {
  sessionId: Id;
  grantedBy: string; // must equal the agent's ownerSub
  scope: "once" | "turn"; // one mutating call, or all mutations within one turn
  turnId?: string;
  grantedAt: string;
  consumed?: boolean;
}

/** Events a runner emits to the control plane. `tool_request` is the gate's decision point. */
export type RunnerEvent =
  | { type: "output"; text: string }
  | { type: "tool_request"; tool: string; input?: string; requestId: string; turnId?: string }
  | { type: "status"; status: SessionStatus }
  | { type: "exit"; code?: number };

/** Hosts a pi process for a session. Abstract so the control plane is testable against a fake;
 * a real server runner + the local `secagent daemon` (Sprint 5) implement it later. */
export interface Runner {
  start(input: { sessionId: Id; agentId: Id; ownerSub: string; workspace?: string }): Promise<void>;
  sendInput(sessionId: Id, text: string): Promise<void>;
  /** Deliver the gate's verdict for a pending tool_request back to the runner. */
  answerTool(sessionId: Id, requestId: string, decision: { allow: boolean; reason: string }): Promise<void>;
  stop(sessionId: Id): Promise<void>;
  onEvent(cb: (sessionId: Id, event: RunnerEvent) => void): void;
}

/** Session + execute-grant persistence. MemoryStore implements it alongside `Store`. */
export interface SessionStore {
  createSession(input: Omit<AgentSession, "id" | "createdAt">): Promise<AgentSession>;
  getSession(id: Id): Promise<AgentSession | null>;
  listSessionsByChannel(channelId: Id): Promise<AgentSession[]>;
  listActiveSessions(): Promise<AgentSession[]>;
  listAllSessions(): Promise<AgentSession[]>; // for the admin console (all statuses)
  setSessionStatus(id: Id, status: SessionStatus): Promise<void>;
  renewLease(id: Id, leaseExpiresAt: string): Promise<void>;
  addGrant(grant: ExecuteGrant): Promise<void>;
  /** The current usable (non-consumed) grant for a session, if any. */
  activeGrant(sessionId: Id): Promise<ExecuteGrant | undefined>;
  consumeGrant(sessionId: Id): Promise<void>;
}

/** The control plane's surface, as the HTTP layer sees it. The concrete implementation drives a
 * Runner, applies the execute-gate to tool requests, and streams output to the channel; the HTTP
 * routes just call these. A port so the HTTP layer stays testable with a fake. */
export interface AgentControl {
  spawn(input: { agent: Agent; channelId: Id; hostType: "server" | "local" }): Promise<AgentSession>;
  /** Owner-only (enforced via the gate). Returns the gate decision — deny is not an error. */
  grantExecute(input: { sessionId: Id; byUser: string; scope: "once" | "turn"; turnId?: string }): Promise<{ allow: boolean; reason: string }>;
  sendInput(sessionId: Id, text: string): Promise<void>;
  getSession(id: Id): Promise<AgentSession | null>;
}
