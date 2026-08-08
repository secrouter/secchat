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

  async redactMessage(id: Id, by: string, reason: string): Promise<void> {
    // `reason` is accepted (the Store contract requires it) but has nowhere to be persisted:
    // AppendAuditInput has no `reason` field (the audit chain is metadata-only by design, see
    // audit/chain.ts) and Message has no redaction-reason field either. Flagged as contract
    // friction in this task's report rather than silently smuggled into `action`/`target`.
    void reason;

    const message = this.#messagesById.get(id);
    if (!message) throw new Error(`MemoryStore.redactMessage: unknown message ${id}`);
    if (message.redactedAt) throw new Error(`MemoryStore.redactMessage: ${id} is already redacted`);

    this.#content.delete(id);
    message.redactedAt = new Date().toISOString();
    await this.appendAudit({ actor: by, action: "message.redact", target: id });
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
      prevHash,
      hash,
      at,
    };
    this.#auditLog.push(event);
    return event;
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
