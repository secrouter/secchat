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
//
// Chat-parity pass (threads/reactions/unread/webhooks), same instincts throughout:
//   * Threads: `Message.parentId` rides along exactly like `promptedBy` (set in appendMessage,
//     never a hash input — computeMessageHash doesn't take it). listThread is listMessages'
//     seq-order + redaction-omits-content rule, filtered to one parent.
//   * Reactions are mutable social signal, deliberately OUTSIDE both hash chains: #reactions
//     (messageId -> Reaction[]) with add/remove doing straight linear scans — row counts here
//     are tiny (one message's reactions), so no need for a nested per-(user,emoji) index.
//   * Read markers: #lastRead (channelId -> (userSub -> last-read seq)), same Map-of-Map shape
//     as everything else here. unreadCount is a live recount (seq > lastRead), not a maintained
//     counter, so it can never drift from the message list.
//   * Webhooks: #webhooksById/#webhooksByToken are two indexes over the same rows (id lookup
//     isn't required by the Store contract yet, but keeping it mirrors #messagesByChannel /
//     #messagesById and costs nothing). The token is the bearer credential an external system
//     presents, so it's minted with node:crypto's CSPRNG, never Math.random or a counter.

import { randomBytes, randomUUID } from "node:crypto";
import {
  GENESIS,
  computeAuditHash,
  computeMessageHash,
  hashContent,
  verifyAuditChain,
  verifyMessageChain,
} from "../audit/chain.ts";
import { DEFAULT_MARKING } from "../marking/policy.ts";
import type {
  Agent,
  AgentSession,
  AddAttachmentInput,
  AppendAuditInput,
  AppendMessageInput,
  Attachment,
  AuditEvent,
  Channel,
  ExecuteGrant,
  Id,
  Member,
  Mention,
  MentionView,
  Message,
  MessagePageOpts,
  MessageRevision,
  Pin,
  PinnedMessage,
  Reaction,
  SessionStatus,
  SessionStore,
  Store,
  User,
  Webhook,
} from "../types.ts";

export class MemoryStore implements Store, SessionStore {
  #channels = new Map<Id, Channel>();
  #members = new Map<Id, Member[]>(); // channelId -> members
  #agents = new Map<Id, Agent>();
  #messagesByChannel = new Map<Id, Message[]>(); // channelId -> messages, seq order
  #messagesById = new Map<Id, Message>(); // same row objects as #messagesByChannel's arrays
  #content = new Map<Id, string>(); // message id -> CURRENT plaintext; absent once redacted
  #revisions = new Map<Id, MessageRevision[]>(); // message id -> full history INCL. revision 1; only for edited messages
  #auditLog: AuditEvent[] = []; // one global chain
  #sessions = new Map<Id, AgentSession>(); // insertion order == creation order
  #grants = new Map<Id, ExecuteGrant[]>(); // sessionId -> grants, append order (last == most recent)
  #reactions = new Map<Id, Reaction[]>(); // messageId -> reactions, append order
  #attachments = new Map<Id, Attachment>(); // attachment id -> row (messageId null until claimed); insertion order = upload order
  #mentions: Mention[] = []; // append order; newest-first is a reverse-scan (dev-scale)
  #pins: Pin[] = []; // append order (newest pin last); one entry per message id
  #lastRead = new Map<Id, Map<string, number>>(); // channelId -> (userSub -> last-read seq)
  #webhooksById = new Map<Id, Webhook>();
  #webhooksByToken = new Map<string, Webhook>(); // same rows as #webhooksById, keyed by the bearer token
  #users = new Map<string, User>(); // sub -> directory entry (seen-users), insertion order

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

  /** Sets the channel's classification level in place and chains a `channel.mark` audit event. The
   * route validates the level + owns the set/raise-vs-downgrade authz; this just persists + audits. */
  async setChannelMarking(channelId: Id, marking: string, by: string): Promise<Channel> {
    const channel = this.#channels.get(channelId);
    if (!channel) throw new Error(`MemoryStore.setChannelMarking: unknown channel ${channelId}`);
    channel.cuiMarking = marking;
    await this.appendAudit({ actor: by, action: "channel.mark", target: channelId, detail: marking });
    return channel;
  }

  async setChannelArchived(channelId: Id, archived: boolean): Promise<Channel> {
    const channel = this.#channels.get(channelId);
    if (!channel) throw new Error(`MemoryStore.setChannelArchived: unknown channel ${channelId}`);
    channel.archived = archived;
    return channel;
  }

  async addMember(m: Member): Promise<void> {
    const members = this.#members.get(m.channelId);
    if (!members) throw new Error(`MemoryStore.addMember: unknown channel ${m.channelId}`);
    // Idempotent per memberRef: re-adding an existing member updates their role rather than
    // duplicating the row (matches PgStore's ON CONFLICT).
    const existing = members.findIndex((x) => x.memberRef === m.memberRef);
    if (existing >= 0) members[existing] = m;
    else members.push(m);
  }

  async listMembers(channelId: Id): Promise<Member[]> {
    return [...(this.#members.get(channelId) ?? [])];
  }

  async isMember(channelId: Id, ref: string): Promise<boolean> {
    return (this.#members.get(channelId) ?? []).some((m) => m.memberRef === ref);
  }

  async removeMember(channelId: Id, memberRef: string): Promise<boolean> {
    const members = this.#members.get(channelId);
    if (!members) return false;
    const i = members.findIndex((m) => m.memberRef === memberRef);
    if (i < 0) return false;
    members.splice(i, 1);
    return true;
  }

  async setMemberRole(channelId: Id, memberRef: string, role: Member["role"]): Promise<Member | null> {
    const member = this.#members.get(channelId)?.find((m) => m.memberRef === memberRef);
    if (!member) return null;
    member.role = role;
    return { ...member };
  }

  /** All channels, creation order (Map iteration order == insertion order) — for the admin /
   * audit-review console (AU 3.3.5/6), same idiom as listMembers/listAgentsByOwner. */
  async listChannels(): Promise<Channel[]> {
    return [...this.#channels.values()];
  }

  // ── Directory of seen users (captured from SSO tokens) ────────────────────────────────────────

  /** `email`/`displayName` are preserved from the prior observation when this one omits them (a
   * dev token carries neither, so a real profile field isn't clobbered by a later thin sign-in);
   * `groups` always reflects the latest token. Absent optional keys (not present-with-undefined)
   * keep the object shape identical to PgStore's `compact`-ed rows. */
  async upsertUser(input: { sub: string; email?: string; displayName?: string; groups: string[] }): Promise<User> {
    const existing = this.#users.get(input.sub);
    const email = input.email ?? existing?.email;
    const displayName = input.displayName ?? existing?.displayName;
    const user: User = {
      sub: input.sub,
      ...(email !== undefined ? { email } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      groups: input.groups,
      lastSeenAt: new Date().toISOString(),
    };
    this.#users.set(user.sub, user);
    return user;
  }

  async listUsers(): Promise<User[]> {
    return [...this.#users.values()];
  }

  async getUser(sub: string): Promise<User | null> {
    return this.#users.get(sub) ?? null;
  }

  /** Scans dm channels for one whose user members are exactly {subA, subB}. There are few DMs per
   * user, so a linear scan is fine (PgStore does the equivalent with a SQL predicate). */
  async findDmChannel(subA: string, subB: string): Promise<Channel | null> {
    for (const channel of this.#channels.values()) {
      if (channel.kind !== "dm") continue;
      const userRefs = (this.#members.get(channel.id) ?? [])
        .filter((m) => m.memberType === "user")
        .map((m) => m.memberRef);
      if (userRefs.length === 2 && userRefs.includes(subA) && userRefs.includes(subB)) return channel;
    }
    return null;
  }

  async createAgent(input: Omit<Agent, "id" | "createdAt">): Promise<Agent> {
    const agent: Agent = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.#agents.set(agent.id, agent);
    return agent;
  }

  async getAgent(id: Id): Promise<Agent | null> {
    return this.#agents.get(id) ?? null;
  }

  async updateAgentModel(id: Id, model: string): Promise<Agent | null> {
    const agent = this.#agents.get(id);
    if (!agent) return null;
    const updated: Agent = { ...agent, model };
    this.#agents.set(id, updated);
    return updated;
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
    // Effective marking: a marked channel IS the portion (its level wins); otherwise the author's
    // per-message choice, defaulting to the floor. Bound into the hash below (tamper-evident).
    const marking = this.#channels.get(input.channelId)?.cuiMarking ?? input.marking ?? DEFAULT_MARKING;
    const attachmentsSha256 = input.attachmentsSha256 ?? ""; // '' when the message has no attachments
    const createdAt = new Date().toISOString();
    const hash = computeMessageHash(prevHash, {
      channelId: input.channelId,
      seq,
      authorRef: input.authorRef,
      authorType: input.authorType,
      contentSha256,
      marking,
      attachmentsSha256,
      createdAt,
    });

    const message: Message = {
      id: randomUUID(),
      channelId: input.channelId,
      seq,
      authorRef: input.authorRef,
      authorType: input.authorType,
      promptedBy: input.promptedBy, // NOT a hash input (see header comment) — carried for provenance only
      parentId: input.parentId, // thread parent — same deal: metadata only, not bound into the hash
      contentSha256,
      marking, // chain-bound (see computeMessageHash) — immutable, tamper-evident
      attachmentsSha256, // chain-bound manifest digest — immutable
      prevHash,
      hash,
      createdAt,
    };
    messages.push(message);
    this.#messagesById.set(message.id, message);
    this.#content.set(message.id, input.content);
    return message;
  }

  /** One message by id (metadata only — no content), or null. Same row objects the channel arrays
   * hold, so it reflects redactions immediately. */
  async getMessage(id: Id): Promise<Message | null> {
    return this.#messagesById.get(id) ?? null;
  }

  /** Messages in seq order; `content` is omitted (key absent, not undefined) for redacted rows. With
   * `opts.limit`/`before`, returns a cursor page (most recent `limit` at or below `before`). */
  async listMessages(channelId: Id, opts?: MessagePageOpts): Promise<Array<Message & { content?: string }>> {
    let messages = this.#messagesByChannel.get(channelId) ?? []; // already ascending by seq
    if (opts?.before != null) messages = messages.filter((m) => m.seq < opts.before!);
    if (opts?.limit != null && messages.length > opts.limit) messages = messages.slice(messages.length - opts.limit);
    return messages.map((m) => (m.redactedAt ? { ...m } : { ...m, content: this.#content.get(m.id) }));
  }

  /** Replies to `parentId` in `channelId`, seq order; same redaction-omits-content rule as
   * listMessages. Top-level messages (parentId unset) never match — parentId must equal exactly. */
  async listThread(channelId: Id, parentId: Id): Promise<Array<Message & { content?: string }>> {
    const messages = this.#messagesByChannel.get(channelId) ?? [];
    return messages
      .filter((m) => m.parentId === parentId)
      .map((m) => (m.redactedAt ? { ...m } : { ...m, content: this.#content.get(m.id) }));
  }

  /** Appends a revision (capturing the original as revision 1 on the first edit), overwrites the
   * current plaintext, stamps `editedAt`, and records a `message.edit` audit event. The message
   * row's `contentSha256`/`hash` (the original) are untouched, so the chain still verifies — the
   * edit lives entirely out-of-band. Author-only is enforced by the route; a redacted message has
   * no plaintext to revise, so it throws (the route maps this to 409). */
  async editMessage(id: Id, by: string, content: string): Promise<Message> {
    const message = this.#messagesById.get(id);
    if (!message) throw new Error(`MemoryStore.editMessage: unknown message ${id}`);
    if (message.redactedAt) throw new Error(`MemoryStore.editMessage: ${id} is redacted`);

    let revisions = this.#revisions.get(id);
    if (!revisions) {
      // First edit — seed history with the original (still in #content) as revision 1.
      revisions = [{
        messageId: id,
        revision: 1,
        authorRef: message.authorRef,
        content: this.#content.get(id),
        contentSha256: message.contentSha256,
        at: message.createdAt,
      }];
      this.#revisions.set(id, revisions);
    }
    const at = new Date().toISOString();
    revisions.push({
      messageId: id,
      revision: revisions[revisions.length - 1]!.revision + 1,
      authorRef: message.authorRef,
      content,
      contentSha256: hashContent(content),
      at,
    });
    this.#content.set(id, content); // current text listMessages returns
    message.editedAt = at; // metadata only — NOT a hash input, so the chain is unaffected
    await this.appendAudit({ actor: by, action: "message.edit", target: id, detail: `rev ${revisions.length}` });
    return message;
  }

  /** Full history, revision order. Un-edited messages synthesize their single original revision on
   * the fly; a redacted message returns its revisions as tombstones (metadata, no content). */
  async listRevisions(id: Id): Promise<MessageRevision[]> {
    const message = this.#messagesById.get(id);
    if (!message) return [];
    const revisions = this.#revisions.get(id);
    if (!revisions) {
      // Never edited — the one revision is the original on the row.
      return [{
        messageId: id,
        revision: 1,
        authorRef: message.authorRef,
        ...(message.redactedAt ? {} : { content: this.#content.get(id) }),
        contentSha256: message.contentSha256,
        at: message.createdAt,
      }];
    }
    // Edited — drop content on every revision once redacted (the stored plaintext is already gone).
    return revisions.map((r) => (message.redactedAt ? { ...r, content: undefined } : { ...r }));
  }

  // ── Reactions (mutable; NOT chained) ──────────────────────────────────────────────────────

  /** Idempotent per (messageId, userSub, emoji): reacting twice with the same emoji is a no-op. */
  async addReaction(messageId: Id, userSub: string, emoji: string): Promise<void> {
    const reactions = this.#reactions.get(messageId);
    if (reactions) {
      if (reactions.some((r) => r.userSub === userSub && r.emoji === emoji)) return;
      reactions.push({ messageId, userSub, emoji, at: new Date().toISOString() });
    } else {
      this.#reactions.set(messageId, [{ messageId, userSub, emoji, at: new Date().toISOString() }]);
    }
  }

  /** Removes exactly the (messageId, userSub, emoji) triple. No-op if it isn't present. */
  async removeReaction(messageId: Id, userSub: string, emoji: string): Promise<void> {
    const reactions = this.#reactions.get(messageId);
    if (!reactions) return;
    this.#reactions.set(
      messageId,
      reactions.filter((r) => !(r.userSub === userSub && r.emoji === emoji)),
    );
  }

  async listReactions(messageId: Id): Promise<Reaction[]> {
    return [...(this.#reactions.get(messageId) ?? [])];
  }

  /** Every reaction on any message in `channelId`, in message-then-append order. */
  async listReactionsForChannel(channelId: Id): Promise<Reaction[]> {
    const messages = this.#messagesByChannel.get(channelId) ?? [];
    const out: Reaction[] = [];
    for (const message of messages) {
      const reactions = this.#reactions.get(message.id);
      if (reactions) out.push(...reactions);
    }
    return out;
  }

  // ── Attachments (metadata; bytes handled by the HTTP layer) ───────────────────────────────

  async addAttachment(input: AddAttachmentInput): Promise<Attachment> {
    const attachment: Attachment = {
      id: randomUUID(),
      channelId: input.channelId,
      uploadedBy: input.uploadedBy,
      filename: input.filename,
      contentType: input.contentType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      marking: input.marking,
      createdAt: new Date().toISOString(),
    };
    this.#attachments.set(attachment.id, attachment);
    return { ...attachment };
  }

  async getAttachment(id: Id): Promise<Attachment | null> {
    const a = this.#attachments.get(id);
    return a ? { ...a } : null;
  }

  async claimAttachments(messageId: Id, attachmentIds: Id[]): Promise<Attachment[]> {
    for (const id of attachmentIds) {
      const a = this.#attachments.get(id);
      if (a && a.messageId == null) a.messageId = messageId; // unclaimed → claimed, once
    }
    // Return the message's full set in upload order (matches PgStore) — a re-claim is a no-op.
    return this.listAttachmentsForMessage(messageId);
  }

  async listAttachmentsForMessage(messageId: Id): Promise<Attachment[]> {
    return [...this.#attachments.values()].filter((a) => a.messageId === messageId).map((a) => ({ ...a }));
  }

  async listAttachmentsForChannel(channelId: Id): Promise<Attachment[]> {
    return [...this.#attachments.values()]
      .filter((a) => a.messageId != null && a.channelId === channelId)
      .map((a) => ({ ...a }));
  }

  // ── Mentions (@-mentions inbox) ───────────────────────────────────────────────────────────

  async addMention(input: { messageId: Id; channelId: Id; mentionedSub: string; authorSub: string }): Promise<Mention> {
    // Idempotent per (messageId, mentionedSub), matching PgStore's unique index — a re-resolve of
    // the same message can't double-notify. Return the existing row untouched if present.
    const existing = this.#mentions.find((m) => m.messageId === input.messageId && m.mentionedSub === input.mentionedSub);
    if (existing) return { ...existing };
    const mention: Mention = {
      id: randomUUID(),
      messageId: input.messageId,
      channelId: input.channelId,
      mentionedSub: input.mentionedSub,
      authorSub: input.authorSub,
      createdAt: new Date().toISOString(),
    };
    this.#mentions.push(mention);
    return { ...mention };
  }

  async listMentionsForUser(sub: string, opts?: { limit?: number; unseenOnly?: boolean }): Promise<MentionView[]> {
    const limit = opts?.limit ?? 50;
    const out: MentionView[] = [];
    for (let i = this.#mentions.length - 1; i >= 0 && out.length < limit; i--) {
      const m = this.#mentions[i]!; // newest first (reverse append order)
      if (m.mentionedSub !== sub) continue;
      if (opts?.unseenOnly && m.seenAt) continue;
      const msg = this.#messagesById.get(m.messageId);
      out.push({
        ...m,
        seq: msg?.seq ?? 0,
        // Redacted (or vanished) message ⇒ no content, but the row still says who/where/when.
        content: msg && !msg.redactedAt ? (this.#content.get(m.messageId) ?? null) : null,
        channelName: this.#channels.get(m.channelId)?.name,
      });
    }
    return out;
  }

  async countUnseenMentions(sub: string): Promise<number> {
    return this.#mentions.filter((m) => m.mentionedSub === sub && !m.seenAt).length;
  }

  async markMentionsSeen(sub: string, ids?: Id[]): Promise<number> {
    const now = new Date().toISOString();
    const idSet = ids ? new Set(ids) : null;
    let changed = 0;
    for (const m of this.#mentions) {
      if (m.mentionedSub !== sub || m.seenAt) continue;
      if (idSet && !idSet.has(m.id)) continue;
      m.seenAt = now;
      changed++;
    }
    return changed;
  }

  // ── Pins (channel-scoped message bookmarks) ───────────────────────────────────────────────

  async pinMessage(channelId: Id, messageId: Id, by: string): Promise<Pin> {
    const existing = this.#pins.find((p) => p.messageId === messageId);
    if (existing) return { ...existing }; // idempotent per message
    const pin: Pin = { channelId, messageId, pinnedBy: by, pinnedAt: new Date().toISOString() };
    this.#pins.push(pin);
    return { ...pin };
  }

  async unpinMessage(messageId: Id): Promise<boolean> {
    const i = this.#pins.findIndex((p) => p.messageId === messageId);
    if (i < 0) return false;
    this.#pins.splice(i, 1);
    return true;
  }

  async listPinnedMessages(channelId: Id): Promise<PinnedMessage[]> {
    const out: PinnedMessage[] = [];
    for (let i = this.#pins.length - 1; i >= 0; i--) {
      const p = this.#pins[i]!; // newest pin first
      if (p.channelId !== channelId) continue;
      const msg = this.#messagesById.get(p.messageId);
      if (!msg) continue;
      out.push({
        ...p,
        seq: msg.seq,
        authorRef: msg.authorRef,
        content: msg.redactedAt ? null : (this.#content.get(p.messageId) ?? null),
      });
    }
    return out;
  }

  // ── Per-user read markers → unread counts ─────────────────────────────────────────────────

  async setLastRead(channelId: Id, userSub: string, seq: number): Promise<void> {
    const perUser = this.#lastRead.get(channelId);
    if (perUser) perUser.set(userSub, seq);
    else this.#lastRead.set(channelId, new Map([[userSub, seq]]));
  }

  /** Messages in `channelId` with seq > the user's last-read seq (default 0 — everything
   * unread). Recomputed live off the message list, so it can never drift out of sync. */
  async unreadCount(channelId: Id, userSub: string): Promise<number> {
    const lastRead = this.#lastRead.get(channelId)?.get(userSub) ?? 0;
    const messages = this.#messagesByChannel.get(channelId) ?? [];
    return messages.filter((m) => m.seq > lastRead).length;
  }

  // ── Inbound webhooks ───────────────────────────────────────────────────────────────────────

  /** Mints a fresh bearer credential (24 bytes from node:crypto's CSPRNG, base64url-encoded) —
   * treat `token` like a secret; it's what an external system presents to post as this webhook. */
  async createWebhook(channelId: Id, createdBy: string): Promise<Webhook> {
    const webhook: Webhook = {
      id: randomUUID(),
      channelId,
      token: randomBytes(24).toString("base64url"),
      createdBy,
      createdAt: new Date().toISOString(),
    };
    this.#webhooksById.set(webhook.id, webhook);
    this.#webhooksByToken.set(webhook.token, webhook);
    return webhook;
  }

  /** A null/empty token never matches a row — guards a caller that forwards a missing/blank
   * header straight through instead of checking it first. */
  async getWebhookByToken(token: string): Promise<Webhook | null> {
    if (!token) return null;
    return this.#webhooksByToken.get(token) ?? null;
  }

  /** Purges plaintext and records `reason` as the audit event's `detail` — still metadata (a
   * short note), never content, so it's safe on the metadata-only audit chain. */
  async redactMessage(id: Id, by: string, reason: string): Promise<void> {
    const message = this.#messagesById.get(id);
    if (!message) throw new Error(`MemoryStore.redactMessage: unknown message ${id}`);
    if (message.redactedAt) throw new Error(`MemoryStore.redactMessage: ${id} is already redacted`);

    this.#content.delete(id);
    // Purge every revision's plaintext too — an edited message's prior versions are just as
    // sensitive. The revision metadata (hashes, timestamps) stays as a tombstone trail.
    for (const r of this.#revisions.get(id) ?? []) r.content = undefined;
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
