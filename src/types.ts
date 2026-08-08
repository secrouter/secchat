// SecChat shared contracts — the integration surface every module builds against.
//
// Kept deliberately small and dependency-free (matches SecRouter's zero-dep ethos). The
// backend depends only on `jose` (JWKS) at runtime; persistence is behind the `Store`
// interface (an in-memory impl now, a Postgres impl when the network is back), and the
// HTTP/WS/LLM layers take their dependencies by injection so each is testable in isolation.

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
  redactMessage(id: Id, by: string, reason: string): Promise<void>;

  appendAudit(input: AppendAuditInput): Promise<AuditEvent>;
  /** Recompute both chains end-to-end; used by the audit-review console + tests. */
  verifyChains(): Promise<{ messagesOk: boolean; auditOk: boolean }>;
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
