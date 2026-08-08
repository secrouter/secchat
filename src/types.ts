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
  cuiMarking?: string; // e.g. "CUI//SP-PRVCY" — channel-level marking (32 CFR 2002)
  createdBy: string; // Principal.sub
  createdAt: string; // ISO-8601 UTC
}

export interface Member {
  channelId: Id;
  memberRef: string; // Principal.sub for users, agent id for agents
  memberType: MemberType;
  role: "owner" | "member";
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
  prevHash: Sha256Hex;
  hash: Sha256Hex;
  createdAt: string;
  redactedAt?: string; // set when plaintext is purged (tombstone); chain still verifies
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

export interface AppendMessageInput {
  channelId: Id;
  authorRef: string;
  authorType: AuthorType;
  content: string;
  promptedBy?: string;
  parentId?: Id;
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
  addMember(m: Member): Promise<void>;
  listMembers(channelId: Id): Promise<Member[]>;
  isMember(channelId: Id, ref: string): Promise<boolean>;

  createAgent(input: Omit<Agent, "id" | "createdAt">): Promise<Agent>;
  getAgent(id: Id): Promise<Agent | null>;
  listAgentsByOwner(ownerSub: string): Promise<Agent[]>;

  appendMessage(input: AppendMessageInput): Promise<Message>;
  /** Messages in seq order; `content` is omitted for redacted rows. */
  listMessages(channelId: Id): Promise<Array<Message & { content?: string }>>;
  /** Replies to `parentId` in `channelId`, seq order; `content` omitted for redacted rows. */
  listThread(channelId: Id, parentId: Id): Promise<Array<Message & { content?: string }>>;
  redactMessage(id: Id, by: string, reason: string): Promise<void>;

  // Reactions (mutable; not chained).
  addReaction(messageId: Id, userSub: string, emoji: string): Promise<void>; // idempotent per (user,emoji)
  removeReaction(messageId: Id, userSub: string, emoji: string): Promise<void>;
  listReactions(messageId: Id): Promise<Reaction[]>;

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
