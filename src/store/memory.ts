// MemoryStore — the in-memory Store (src/types.ts) implementation: single-process, dev/test
// backing. A Postgres implementation lands later behind the same interface (see
// db/migrations/0001_init.sql for its planned schema); until then this is what the HTTP/WS
// layers run against.
//
// Two invariants carried over from src/audit/chain.ts:
//   * Message rows never hold plaintext. Content lives in a SEPARATE map keyed by message id
//     (#content), so redactMessage() can delete just that entry — the Message row (and the
//     chain-bound fields on it: contentSha256/prevHash/hash) is never touched, so the chain
//     verifies before and after redaction alike.
//   * appendMessage/appendAudit own their chain's linkage (seq/prevHash/hash) internally, the
//     same way a correct Postgres implementation will: read the current tail, compute the next
//     link, append. Callers never construct these fields themselves.
//
// A third invariant added in this pass: Message.promptedBy and AuditEvent.detail ride along on
// their rows/events (and therefore round-trip through listMessages/listAudit) but are NOT bound
// into either hash — computeMessageHash/computeAuditHash (src/audit/chain.ts, frozen) simply
// don't take them as inputs, so carrying them costs nothing chain-wise.
//
// This pass also backs `SessionStore` (src/types.ts) — coding-agent sessions and their owner
// execute-grants (see src/agent/gate.ts for how a grant is consumed at the decision point). Two
// more maps, same "single in-memory row store" spirit as everything above: #sessions (id ->
// AgentSession) and #grants (sessionId -> ExecuteGrant[], append-ordered so "most recent" is
// just "last in the array"). Grants are never removed, only marked `consumed` — same
// tombstone-not-delete instinct as message redaction, and it keeps a full history per session.

import { randomUUID } from "node:crypto";
import {
  GENESIS,
  computeAuditHash,
  computeMessageHash,
  hashContent,
  verifyAuditChain,
  verifyMessageChain,
} from "../audit/chain.ts";
import type {
  Agent,
  AgentSession,
  AppendAuditInput,
  AppendMessageInput,
  AuditEvent,
  Channel,
  ExecuteGrant,
  Id,
  Member,
  Message,
  SessionStatus,
  SessionStore,
  Store,
} from "../types.ts";

export class MemoryStore implements Store, SessionStore {
  #channels = new Map<Id, Channel>();
  #members = new Map<Id, Member[]>(); // channelId -> members
  #agents = new Map<Id, Agent>();
  #messagesByChannel = new Map<Id, Message[]>(); // channelId -> messages, seq order
  #messagesById = new Map<Id, Message>(); // same row objects as #messagesByChannel's arrays
  #content = new Map<Id, string>(); // message id -> plaintext; absent once redacted
  #auditLog: AuditEvent[] = []; // one global chain
  #sessions = new Map<Id, AgentSession>(); // insertion order == creation order
  #grants = new Map<Id, ExecuteGrant[]>(); // sessionId -> grants, append order (last == most recent)

  async createChannel(input: Omit<Channel, "id" | "createdAt">): Promise<Channel> {
    const channel: Channel = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#channels.set(channel.id, channel);
    this.#members.set(channel.id, []);
    this.#messagesByChannel.set(channel.id, []);
    return channel;
  }

  async getChannel(id: Id): Promise<Channel | null> {
    return this.#channels.get(id) ?? null;
  }

  async addMember(m: Member): Promise<void> {
    const members = this.#members.get(m.channelId);
    if (!members) throw new Error(`MemoryStore.addMember: unknown channel ${m.channelId}`);
    members.push(m);
  }

  async listMembers(channelId: Id): Promise<Member[]> {
    return [...(this.#members.get(channelId) ?? [])];
  }

  async isMember(channelId: Id, ref: string): Promise<boolean> {
    return (this.#members.get(channelId) ?? []).some((m) => m.memberRef === ref);
  }

  /** All channels, creation order (Map iteration order == insertion order) — for the admin /
   * audit-review console (AU 3.3.5/6), same idiom as listMembers/listAgentsByOwner. */
  async listChannels(): Promise<Channel[]> {
    return [...this.#channels.values()];
  }

  async createAgent(input: Omit<Agent, "id" | "createdAt">): Promise<Agent> {
    const agent: Agent = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#agents.set(agent.id, agent);
    return agent;
  }

  async getAgent(id: Id): Promise<Agent | null> {
    return this.#agents.get(id) ?? null;
  }

  /** Owner's agents, in creation order (Map iteration order == insertion order). */
  async listAgentsByOwner(ownerSub: string): Promise<Agent[]> {
    return [...this.#agents.values()].filter((a) => a.ownerSub === ownerSub);
  }

  /** Every agent, creation order, regardless of owner — for the admin / audit-review console
   * (AU 3.3.5/6). Distinct from listAgentsByOwner, which filters to a single owner. */
  async listAllAgents(): Promise<Agent[]> {
    return [...this.#agents.values()];
  }

  async appendMessage(input: AppendMessageInput): Promise<Message> {
    const messages = this.#messagesByChannel.get(input.channelId);
    if (!messages) throw new Error(`MemoryStore.appendMessage: unknown channel ${input.channelId}`);

    const last = messages[messages.length - 1];
    const seq = last ? last.seq + 1 : 1;
    const prevHash = last ? last.hash : GENESIS;
    const contentSha256 = hashContent(input.content);
    const createdAt = new Date().toISOString();
    const hash = computeMessageHash(prevHash, {
      channelId: input.channelId,
      seq,
      authorRef: input.authorRef,
      authorType: input.authorType,
      contentSha256,
      createdAt,
    });

    const message: Message = {
      id: randomUUID(),
      channelId: input.channelId,
      seq,
      authorRef: input.authorRef,
      authorType: input.authorType,
      promptedBy: input.promptedBy, // NOT a hash input (see header comment) — carried for provenance only
      contentSha256,
      prevHash,
      hash,
      createdAt,
    };
    messages.push(message);
    this.#messagesById.set(message.id, message);
    this.#content.set(message.id, input.content);
    return message;
  }

  /** Messages in seq order; `content` is omitted (key absent, not undefined) for redacted rows. */
  async listMessages(channelId: Id): Promise<Array<Message & { content?: string }>> {
    const messages = this.#messagesByChannel.get(channelId) ?? [];
    return messages.map((m) => (m.redactedAt ? { ...m } : { ...m, content: this.#content.get(m.id) }));
  }

  /** Purges plaintext and records `reason` as the audit event's `detail` — still metadata (a
   * short note), never content, so it's safe on the metadata-only audit chain. */
  async redactMessage(id: Id, by: string, reason: string): Promise<void> {
    const message = this.#messagesById.get(id);
    if (!message) throw new Error(`MemoryStore.redactMessage: unknown message ${id}`);
    if (message.redactedAt) throw new Error(`MemoryStore.redactMessage: ${id} is already redacted`);

    this.#content.delete(id);
    message.redactedAt = new Date().toISOString();
    await this.appendAudit({ actor: by, action: "message.redact", target: id, detail: reason });
  }

  async appendAudit(input: AppendAuditInput): Promise<AuditEvent> {
    const last = this.#auditLog[this.#auditLog.length - 1];
    const seq = last ? last.seq + 1 : 1;
    const prevHash = last ? last.hash : GENESIS;
    const at = new Date().toISOString();
    const hash = computeAuditHash(prevHash, {
      seq,
      actor: input.actor,
      actAs: input.actAs,
      action: input.action,
      target: input.target,
      at,
    });

    const event: AuditEvent = {
      id: randomUUID(),
      seq,
      actor: input.actor,
      actAs: input.actAs,
      action: input.action,
      target: input.target,
      detail: input.detail, // NOT a hash input (computeAuditHash doesn't take it) — see header comment
      prevHash,
      hash,
      at,
    };
    this.#auditLog.push(event);
    return event;
  }

  /** Snapshot of the global audit log, in seq order — for the admin / audit-review console
   * (AU 3.3.5/6). Part of the frozen `Store` contract, alongside listChannels/listAllAgents. */
  async listAudit(): Promise<AuditEvent[]> {
    return [...this.#auditLog];
  }

  /** Recompute both chains end-to-end: every channel's message chain (all must pass) plus the
   * one global audit chain. */
  async verifyChains(): Promise<{ messagesOk: boolean; auditOk: boolean }> {
    let messagesOk = true;
    for (const messages of this.#messagesByChannel.values()) {
      if (!verifyMessageChain(messages).ok) {
        messagesOk = false;
        break;
      }
    }
    const auditOk = verifyAuditChain(this.#auditLog).ok;
    return { messagesOk, auditOk };
  }

  // ── SessionStore ───────────────────────────────────────────────────────────────────────────

  /** `status`/`leaseExpiresAt` come from the caller (the control plane decides the starting
   * state); this just assigns the id/createdAt and persists the row. */
  async createSession(input: Omit<AgentSession, "id" | "createdAt">): Promise<AgentSession> {
    const session: AgentSession = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#sessions.set(session.id, session);
    return session;
  }

  async getSession(id: Id): Promise<AgentSession | null> {
    return this.#sessions.get(id) ?? null;
  }

  /** A channel's sessions, in creation order (Map iteration order == insertion order) — same
   * pattern as listAgentsByOwner. */
  async listSessionsByChannel(channelId: Id): Promise<AgentSession[]> {
    return [...this.#sessions.values()].filter((s) => s.channelId === channelId);
  }

  /** Sessions still live in the control-plane sense: `starting` or `active`. Excludes `orphaned`
   * (lease lapsed — the reaper's territory) and `ended`. */
  async listActiveSessions(): Promise<AgentSession[]> {
    return [...this.#sessions.values()].filter((s) => s.status === "starting" || s.status === "active");
  }

  /** Every session, all statuses, creation order — for the admin console. Distinct from
   * listActiveSessions, which filters to starting/active only. */
  async listAllSessions(): Promise<AgentSession[]> {
    return [...this.#sessions.values()];
  }

  /** Fails closed on an unknown session (matches addMember/redactMessage's guard style). Moving
   * to `ended` also stamps `endedAt` — the one derived field this row carries. */
  async setSessionStatus(id: Id, status: SessionStatus): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`MemoryStore.setSessionStatus: unknown session ${id}`);
    session.status = status;
    if (status === "ended") session.endedAt = new Date().toISOString();
  }

  /** Called on runner heartbeats to push the lease forward. Unknown id fails closed. */
  async renewLease(id: Id, leaseExpiresAt: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`MemoryStore.renewLease: unknown session ${id}`);
    session.leaseExpiresAt = leaseExpiresAt;
  }

  async addGrant(grant: ExecuteGrant): Promise<void> {
    const grants = this.#grants.get(grant.sessionId);
    if (grants) grants.push(grant);
    else this.#grants.set(grant.sessionId, [grant]);
  }

  /** The most-recently-added, not-yet-consumed grant for this session — i.e. what
   * agent/gate.ts's evaluateTool() should be checking right now — or undefined if none. */
  async activeGrant(sessionId: Id): Promise<ExecuteGrant | undefined> {
    const grants = this.#grants.get(sessionId);
    if (!grants) return undefined;
    for (let i = grants.length - 1; i >= 0; i--) {
      const grant = grants[i]!;
      if (!grant.consumed) return grant;
    }
    return undefined;
  }

  /** Marks the current active grant consumed (tombstone, not delete — mirrors redactMessage's
   * approach to Message rows). No-op if there is no active grant, so a caller doesn't need to
   * check activeGrant() first just to make this call safe. */
  async consumeGrant(sessionId: Id): Promise<void> {
    const grants = this.#grants.get(sessionId);
    if (!grants) return;
    for (let i = grants.length - 1; i >= 0; i--) {
      const grant = grants[i]!;
      if (!grant.consumed) {
        grant.consumed = true;
        return;
      }
    }
  }
}
