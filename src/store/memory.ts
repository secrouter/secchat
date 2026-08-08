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
  AppendAuditInput,
  AppendMessageInput,
  AuditEvent,
  Channel,
  Id,
  Member,
  Message,
  Store,
} from "../types.ts";

export class MemoryStore implements Store {
  #channels = new Map<Id, Channel>();
  #members = new Map<Id, Member[]>(); // channelId -> members
  #agents = new Map<Id, Agent>();
  #messagesByChannel = new Map<Id, Message[]>(); // channelId -> messages, seq order
  #messagesById = new Map<Id, Message>(); // same row objects as #messagesByChannel's arrays
  #content = new Map<Id, string>(); // message id -> plaintext; absent once redacted
  #auditLog: AuditEvent[] = []; // one global chain

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

  /** Snapshot of the global audit log, in seq order. NOT part of the frozen `Store` contract —
   * that interface exposes no read path for AuditEvent content, only verifyChains()'s pass/fail
   * boolean. Added here (a concrete-class extra, same spirit as the doc comment on verifyChains
   * anticipating an "audit-review console") so tests — and that future console — can inspect
   * event fields like `detail`. Flagged as contract friction in this task's report. */
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
}
