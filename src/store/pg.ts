// PgStore — the durable Postgres backing for `Store` + `SessionStore` (src/types.ts), behind the
// SAME interfaces MemoryStore (src/store/memory.ts) implements. Schema: db/migrations/0001_init.sql
// + 0002_parity.sql (applied via src/db/migrate.ts).
//
// Hashing stays in TS — every hash PgStore ever writes or verifies comes from src/audit/chain.ts
// (frozen), the exact same functions MemoryStore uses, so a chain built by one store and read by
// the other is byte-identical. Postgres only persists the rows; it never computes a hash itself.
//
// ── Concurrency safety (the crux of this file) ──────────────────────────────────────────────────
// appendMessage/appendAudit each do read-last-row → compute-next-link → insert. MemoryStore gets
// this for free (single-process, no other JS ever runs between the read and the write of one
// synchronous-enough call). Postgres has no such luxury — two concurrent appendMessage calls on
// the same channel could both read the same "last row", compute the same seq/prevHash, and insert
// two rows claiming the same seq (or worse, two different seqs with the same prevHash), silently
// forking the chain.
//
// The fix: each of the two chains gets a dedicated Postgres advisory lock, taken with
// `pg_advisory_xact_lock` (transaction-scoped — released automatically on COMMIT *or* ROLLBACK,
// so a thrown error can never leave a lock stuck) and held for the ENTIRE read → compute → insert
// section:
//   * messages — `pg_advisory_xact_lock(1, hashtext(channelId))`. Namespace 1 (arbitrary, just
//     keeps this keyspace separate from the audit lock's), sub-key = a 32-bit hash of the channel
//     id, so different channels lock independently and append fully in parallel — exactly
//     matching MemoryStore's independent per-channel arrays. hashtext() can theoretically collide
//     across two different channel ids; that only costs a little extra serialization between two
//     unrelated channels, never a correctness problem (a collision makes the lock MORE
//     conservative, not less).
//   * audit — `pg_advisory_xact_lock(2, 0)`. Namespace 2, a single fixed key — there is only one
//     global audit chain, so every appendAudit call (including the one inside redactMessage)
//     serializes against every other one.
// Whichever caller gets the lock first reads the true last row, writes the next link, and commits
// (releasing the lock); the next caller then reads THAT row. Net effect: concurrent appends to one
// channel/the audit log become a well-defined queue, producing a gapless, correctly-linked chain
// no matter how many callers race (see test/pg.test.ts's 20-way concurrent appendMessage test).
//
// ── Object-shape parity with MemoryStore ────────────────────────────────────────────────────────
// `Channel.name?`, `Agent.model?`, `Message.promptedBy?`, etc. are TS-optional. MemoryStore's
// `{ ...input, id, createdAt }` construction leaves an unset optional field's key genuinely ABSENT
// (spreading a key the caller never set doesn't create it) — not present-with-`undefined`, which
// `assert.deepStrictEqual` treats as a different object. `compact()` below reproduces that: every
// row-mapper strips null/undefined-valued keys before returning, so a PgStore round-trip has the
// same shape as MemoryStore's for the same logical row.
//
// All writes are parameterized (no string interpolation of values); the only interpolation
// anywhere is trusted, static SQL text.

import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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
  AgentKind,
  AgentSession,
  AppendAuditInput,
  AppendMessageInput,
  AuditEvent,
  AuthorType,
  Channel,
  ChannelKind,
  ExecuteGrant,
  Id,
  Member,
  MemberType,
  Message,
  MessageRevision,
  Reaction,
  SessionStatus,
  SessionStore,
  Store,
  User,
  Webhook,
} from "../types.ts";

// ── small shared helpers ───────────────────────────────────────────────────────────────────────

/** A Postgres `timestamptz` column comes back from `pg` as a JS `Date` (its default type parser).
 * We always WROTE it from `new Date().toISOString()`, and Date <-> ISO round-trips exactly at
 * millisecond precision (the only precision the app ever writes), so re-serializing here
 * reproduces the exact original string — which matters: that string is a hash-chain input, and it
 * must be byte-identical on verify. */
function iso(d: Date): string {
  return d.toISOString();
}

/** Strips null/undefined-valued keys from a fresh object literal — see the header comment on
 * object-shape parity with MemoryStore. Only ever applied to freshly-built return objects (never
 * to a caller's own object), so mutating in place is safe. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T;
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

// ── row shapes (snake_case columns, as `pg` hands them back) ──────────────────────────────────

interface ChannelRow {
  id: string;
  workspace_id: string;
  kind: string;
  name: string | null;
  cui_marking: string | null;
  created_by: string;
  created_at: Date;
}

interface UserRow {
  sub: string;
  email: string | null;
  display_name: string | null;
  groups: string[]; // Postgres text[] → JS string[]
  last_seen_at: Date;
}

interface MemberRow {
  channel_id: string;
  member_ref: string;
  member_type: string;
  role: string;
}

interface AgentRow {
  id: string;
  owner_sub: string;
  kind: string;
  name: string | null;
  model: string | null;
  created_at: Date;
}

interface MessageRow {
  id: string;
  channel_id: string;
  seq: number;
  author_ref: string;
  author_type: string;
  prompted_by: string | null;
  parent_id: string | null;
  content_sha256: string;
  prev_hash: string;
  hash: string;
  created_at: Date;
  redacted_at: Date | null;
  // Derived (not a stored column): MAX(at) over this message's revisions, present only once
  // edited. getMessage doesn't select it, so it's optional — absent there means editedAt undefined.
  edited_at?: Date | null;
}

interface MessageJoinRow extends MessageRow {
  content: string | null; // from message_content via LEFT JOIN; null once redacted (or never set)
}

interface MessageRevisionRow {
  message_id: string;
  revision: number;
  author_ref: string;
  content: string | null; // null once the message is redacted (tombstone)
  content_sha256: string;
  at: Date;
}

interface ReactionRow {
  message_id: string;
  user_sub: string;
  emoji: string;
  at: Date;
}

interface WebhookRow {
  id: string;
  channel_id: string;
  token: string;
  created_by: string;
  created_at: Date;
}

interface AuditRow {
  id: string;
  seq: number;
  actor: string;
  act_as: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  prev_hash: string;
  hash: string;
  at: Date;
}

interface SessionRow {
  id: string;
  agent_id: string;
  channel_id: string;
  host_type: string;
  runner_id: string | null;
  status: string;
  created_at: Date;
  lease_expires_at: Date;
  ended_at: Date | null;
}

interface GrantRow {
  session_id: string;
  granted_by: string;
  scope: string;
  turn_id: string | null;
  granted_at: Date;
  consumed: boolean;
}

// ── row -> TS-shape mappers ────────────────────────────────────────────────────────────────────

function rowToChannel(row: ChannelRow): Channel {
  return compact({
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as ChannelKind,
    name: row.name ?? undefined,
    cuiMarking: row.cui_marking ?? undefined,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  });
}

function rowToUser(row: UserRow): User {
  return compact({
    sub: row.sub,
    email: row.email ?? undefined,
    displayName: row.display_name ?? undefined,
    groups: row.groups ?? [],
    lastSeenAt: iso(row.last_seen_at),
  });
}

function rowToMember(row: MemberRow): Member {
  return {
    channelId: row.channel_id,
    memberRef: row.member_ref,
    memberType: row.member_type as MemberType,
    role: row.role as Member["role"],
  };
}

function rowToAgent(row: AgentRow): Agent {
  return compact({
    id: row.id,
    ownerSub: row.owner_sub,
    kind: row.kind as AgentKind,
    name: row.name ?? undefined,
    model: row.model ?? undefined,
    createdAt: iso(row.created_at),
  });
}

function rowToMessage(row: MessageRow): Message {
  return compact({
    id: row.id,
    channelId: row.channel_id,
    seq: row.seq,
    authorRef: row.author_ref,
    authorType: row.author_type as AuthorType,
    promptedBy: row.prompted_by ?? undefined,
    parentId: row.parent_id ?? undefined,
    contentSha256: row.content_sha256,
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: iso(row.created_at),
    redactedAt: row.redacted_at ? iso(row.redacted_at) : undefined,
    editedAt: row.edited_at ? iso(row.edited_at) : undefined,
  });
}

/** A single row from message_revisions. `content` is dropped (compacted out) once redacted,
 * matching MemoryStore.listRevisions' shape. */
function rowToMessageRevision(row: MessageRevisionRow): MessageRevision {
  return compact({
    messageId: row.message_id,
    revision: row.revision,
    authorRef: row.author_ref,
    content: row.content ?? undefined,
    contentSha256: row.content_sha256,
    at: iso(row.at),
  });
}

/** listMessages/listThread's row shape: same as rowToMessage, plus `content` — included only when
 * the row isn't redacted, and genuinely ABSENT (not `content: undefined`) otherwise, matching
 * MemoryStore's `(m.redactedAt ? { ...m } : { ...m, content: … })` exactly. */
function rowToMessageWithContent(row: MessageJoinRow): Message & { content?: string } {
  const message = rowToMessage(row);
  if (row.redacted_at) return message;
  return { ...message, content: row.content ?? "" };
}

function rowToReaction(row: ReactionRow): Reaction {
  return { messageId: row.message_id, userSub: row.user_sub, emoji: row.emoji, at: iso(row.at) };
}

function rowToWebhook(row: WebhookRow): Webhook {
  return { id: row.id, channelId: row.channel_id, token: row.token, createdBy: row.created_by, createdAt: iso(row.created_at) };
}

function rowToAuditEvent(row: AuditRow): AuditEvent {
  return compact({
    id: row.id,
    seq: row.seq,
    actor: row.actor,
    actAs: row.act_as ?? undefined,
    action: row.action,
    target: row.target ?? undefined,
    detail: row.detail ?? undefined,
    prevHash: row.prev_hash,
    hash: row.hash,
    at: iso(row.at),
  });
}

function rowToSession(row: SessionRow): AgentSession {
  return compact({
    id: row.id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    hostType: row.host_type as AgentSession["hostType"],
    runnerId: row.runner_id ?? undefined,
    status: row.status as SessionStatus,
    createdAt: iso(row.created_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    endedAt: row.ended_at ? iso(row.ended_at) : undefined,
  });
}

function rowToGrant(row: GrantRow): ExecuteGrant {
  return compact({
    sessionId: row.session_id,
    grantedBy: row.granted_by,
    scope: row.scope as ExecuteGrant["scope"],
    turnId: row.turn_id ?? undefined,
    grantedAt: iso(row.granted_at),
    consumed: row.consumed,
  });
}

export class PgStore implements Store, SessionStore {
  #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  // ── channels / members ──────────────────────────────────────────────────────────────────────

  async createChannel(input: Omit<Channel, "id" | "createdAt">): Promise<Channel> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.#pool.query(
      `INSERT INTO channels (id, workspace_id, kind, name, cui_marking, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, input.workspaceId, input.kind, input.name ?? null, input.cuiMarking ?? null, input.createdBy, createdAt],
    );
    return compact({
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      name: input.name,
      cuiMarking: input.cuiMarking,
      createdBy: input.createdBy,
      createdAt,
    });
  }

  async getChannel(id: Id): Promise<Channel | null> {
    const { rows } = await this.#pool.query<ChannelRow>(
      `SELECT id, workspace_id, kind, name, cui_marking, created_by, created_at FROM channels WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToChannel(rows[0]) : null;
  }

  /** Idempotent upsert on (channelId, memberRef): unlike MemoryStore's unconditional array push,
   * 0001's channel_members has a PRIMARY KEY (channel_id, member_ref) (frozen — not something 0002
   * can relax), so a literal duplicate row is not representable here. Re-adding the same member
   * updates memberType/role (last write wins) instead of throwing a unique-violation — the more
   * useful behavior for the plausible real case (a member re-joining, or a role change), and
   * nothing in the Store contract documents duplicate-add as meaningful. No test in this suite
   * (or store.test.ts) exercises calling addMember twice for the same member. */
  async addMember(m: Member): Promise<void> {
    await this.#pool.query(
      `INSERT INTO channel_members (channel_id, member_ref, member_type, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (channel_id, member_ref) DO UPDATE SET member_type = EXCLUDED.member_type, role = EXCLUDED.role`,
      [m.channelId, m.memberRef, m.memberType, m.role],
    );
    // An unknown channel fails closed via the channel_id FK violation (no pre-check needed).
  }

  async listMembers(channelId: Id): Promise<Member[]> {
    const { rows } = await this.#pool.query<MemberRow>(
      `SELECT channel_id, member_ref, member_type, role FROM channel_members WHERE channel_id = $1 ORDER BY member_ref`,
      [channelId],
    );
    return rows.map(rowToMember);
  }

  async isMember(channelId: Id, ref: string): Promise<boolean> {
    const { rows } = await this.#pool.query(
      `SELECT 1 FROM channel_members WHERE channel_id = $1 AND member_ref = $2`,
      [channelId, ref],
    );
    return rows.length > 0;
  }

  /** All channels, creation order (ins_seq — see db/migrations/0002_parity.sql) — for the admin /
   * audit-review console (AU 3.3.5/6), same idiom as listMembers/listAgentsByOwner. */
  async listChannels(): Promise<Channel[]> {
    const { rows } = await this.#pool.query<ChannelRow>(
      `SELECT id, workspace_id, kind, name, cui_marking, created_by, created_at FROM channels ORDER BY ins_seq`,
    );
    return rows.map(rowToChannel);
  }

  // ── directory of seen users (db/migrations/0003_users.sql) ─────────────────────────────────────

  /** Upsert on the `sub` PK: `email`/`display_name` use COALESCE(EXCLUDED, existing) so a thin
   * observation (a dev token, which carries neither) never nulls out a richer profile; `groups`
   * always takes the newest value; `last_seen_at` always advances. Mirrors MemoryStore.upsertUser. */
  async upsertUser(input: { sub: string; email?: string; displayName?: string; groups: string[] }): Promise<User> {
    const { rows } = await this.#pool.query<UserRow>(
      `INSERT INTO users (sub, email, display_name, groups, last_seen_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sub) DO UPDATE SET
         email = COALESCE(EXCLUDED.email, users.email),
         display_name = COALESCE(EXCLUDED.display_name, users.display_name),
         groups = EXCLUDED.groups,
         last_seen_at = EXCLUDED.last_seen_at
       RETURNING sub, email, display_name, groups, last_seen_at`,
      [input.sub, input.email ?? null, input.displayName ?? null, input.groups, new Date().toISOString()],
    );
    return rowToUser(rows[0]!);
  }

  async listUsers(): Promise<User[]> {
    const { rows } = await this.#pool.query<UserRow>(
      `SELECT sub, email, display_name, groups, last_seen_at FROM users ORDER BY ins_seq`,
    );
    return rows.map(rowToUser);
  }

  async getUser(sub: string): Promise<User | null> {
    const { rows } = await this.#pool.query<UserRow>(
      `SELECT sub, email, display_name, groups, last_seen_at FROM users WHERE sub = $1`,
      [sub],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  /** A dm channel whose user-members are exactly {subA, subB} — two user members, both present.
   * The count guard rules out a would-be group DM; the two EXISTS clauses pin both participants. */
  async findDmChannel(subA: string, subB: string): Promise<Channel | null> {
    const { rows } = await this.#pool.query<ChannelRow>(
      `SELECT c.id, c.workspace_id, c.kind, c.name, c.cui_marking, c.created_by, c.created_at
       FROM channels c
       WHERE c.kind = 'dm'
         AND (SELECT count(*) FROM channel_members m
              WHERE m.channel_id = c.id AND m.member_type = 'user') = 2
         AND EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.member_ref = $1)
         AND EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.member_ref = $2)
       ORDER BY c.ins_seq
       LIMIT 1`,
      [subA, subB],
    );
    return rows[0] ? rowToChannel(rows[0]) : null;
  }

  // ── agents ───────────────────────────────────────────────────────────────────────────────────

  async createAgent(input: Omit<Agent, "id" | "createdAt">): Promise<Agent> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.#pool.query(
      `INSERT INTO agents (id, owner_sub, kind, name, model, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.ownerSub, input.kind, input.name ?? null, input.model ?? null, createdAt],
    );
    return compact({ id, ownerSub: input.ownerSub, kind: input.kind, name: input.name, model: input.model, createdAt });
  }

  async getAgent(id: Id): Promise<Agent | null> {
    const { rows } = await this.#pool.query<AgentRow>(
      `SELECT id, owner_sub, kind, name, model, created_at FROM agents WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  /** Owner's agents, creation order (ins_seq). */
  async listAgentsByOwner(ownerSub: string): Promise<Agent[]> {
    const { rows } = await this.#pool.query<AgentRow>(
      `SELECT id, owner_sub, kind, name, model, created_at FROM agents WHERE owner_sub = $1 ORDER BY ins_seq`,
      [ownerSub],
    );
    return rows.map(rowToAgent);
  }

  /** Every agent, creation order, regardless of owner — for the admin / audit-review console. */
  async listAllAgents(): Promise<Agent[]> {
    const { rows } = await this.#pool.query<AgentRow>(
      `SELECT id, owner_sub, kind, name, model, created_at FROM agents ORDER BY ins_seq`,
    );
    return rows.map(rowToAgent);
  }

  // ── messages ─────────────────────────────────────────────────────────────────────────────────

  /** Race-safe: takes the per-channel advisory lock BEFORE reading the current tail, and holds it
   * for the whole read → compute → insert section (transaction-scoped, released at COMMIT/
   * ROLLBACK) — see the file header for why this is necessary and how it composes across
   * channels. */
  async appendMessage(input: AppendMessageInput): Promise<Message> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1, hashtext($1))", [input.channelId]);

      const { rows } = await client.query<{ seq: number; hash: string }>(
        `SELECT seq, hash FROM messages WHERE channel_id = $1 ORDER BY seq DESC LIMIT 1`,
        [input.channelId],
      );
      const last = rows[0];
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
      const id = randomUUID();

      // channel_id's FK makes an unknown channel fail closed here, matching MemoryStore's throw.
      await client.query(
        `INSERT INTO messages (id, channel_id, seq, author_ref, author_type, prompted_by, parent_id, content_sha256, prev_hash, hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, input.channelId, seq, input.authorRef, input.authorType, input.promptedBy ?? null, input.parentId ?? null, contentSha256, prevHash, hash, createdAt],
      );
      await client.query(`INSERT INTO message_content (message_id, content) VALUES ($1, $2)`, [id, input.content]);

      await client.query("COMMIT");

      return compact({
        id,
        channelId: input.channelId,
        seq,
        authorRef: input.authorRef,
        authorType: input.authorType,
        promptedBy: input.promptedBy,
        parentId: input.parentId,
        contentSha256,
        prevHash,
        hash,
        createdAt,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** One message by id (metadata only — no content), or null. */
  async getMessage(id: Id): Promise<Message | null> {
    const { rows } = await this.#pool.query<MessageRow>(
      `SELECT id, channel_id, seq, author_ref, author_type, prompted_by, parent_id,
              content_sha256, prev_hash, hash, created_at, redacted_at
       FROM messages WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToMessage(rows[0]) : null;
  }

  /** Messages in seq order; `content` is omitted (key absent, not undefined) for redacted rows. */
  async listMessages(channelId: Id): Promise<Array<Message & { content?: string }>> {
    const { rows } = await this.#pool.query<MessageJoinRow>(
      `SELECT m.id, m.channel_id, m.seq, m.author_ref, m.author_type, m.prompted_by, m.parent_id,
              m.content_sha256, m.prev_hash, m.hash, m.created_at, m.redacted_at, mc.content,
              rev.edited_at
       FROM messages m
       LEFT JOIN message_content mc ON mc.message_id = m.id
       LEFT JOIN (SELECT message_id, MAX(at) AS edited_at FROM message_revisions GROUP BY message_id) rev
              ON rev.message_id = m.id
       WHERE m.channel_id = $1
       ORDER BY m.seq`,
      [channelId],
    );
    return rows.map(rowToMessageWithContent);
  }

  /** Replies to `parentId` in `channelId`, seq order; same redaction-omits-content rule as
   * listMessages. `parent_id = $2` never matches a top-level row (parent_id IS NULL), matching
   * MemoryStore's `m.parentId === parentId` filter. */
  async listThread(channelId: Id, parentId: Id): Promise<Array<Message & { content?: string }>> {
    const { rows } = await this.#pool.query<MessageJoinRow>(
      `SELECT m.id, m.channel_id, m.seq, m.author_ref, m.author_type, m.prompted_by, m.parent_id,
              m.content_sha256, m.prev_hash, m.hash, m.created_at, m.redacted_at, mc.content,
              rev.edited_at
       FROM messages m
       LEFT JOIN message_content mc ON mc.message_id = m.id
       LEFT JOIN (SELECT message_id, MAX(at) AS edited_at FROM message_revisions GROUP BY message_id) rev
              ON rev.message_id = m.id
       WHERE m.channel_id = $1 AND m.parent_id = $2
       ORDER BY m.seq`,
      [channelId, parentId],
    );
    return rows.map(rowToMessageWithContent);
  }

  /** Revise a message's text, preserving history — in ONE transaction (revision rows + current
   * plaintext + audit event land together or not at all). The messages row is never touched, so
   * the hash chain is untouched: the tamper-evident record of the edit is its `message.edit` audit
   * event. FOR UPDATE on the row serializes concurrent edits (so revision numbers can't collide)
   * and fails closed on an unknown/redacted message (author-only is enforced at the route). */
  async editMessage(id: Id, by: string, content: string): Promise<Message> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");

      const { rows: mrows } = await client.query<MessageRow>(
        `SELECT id, channel_id, seq, author_ref, author_type, prompted_by, parent_id,
                content_sha256, prev_hash, hash, created_at, redacted_at
         FROM messages WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = mrows[0];
      if (!row) throw new Error(`PgStore.editMessage: unknown message ${id}`);
      if (row.redacted_at) throw new Error(`PgStore.editMessage: ${id} is redacted`);

      const { rows: maxRows } = await client.query<{ maxrev: number | null }>(
        `SELECT MAX(revision) AS maxrev FROM message_revisions WHERE message_id = $1`,
        [id],
      );
      let nextRevision = (maxRows[0]?.maxrev ?? 0) + 1;
      if (nextRevision === 1) {
        // First edit — seed revision 1 with the original (still the current text in message_content).
        const { rows: crows } = await client.query<{ content: string | null }>(
          `SELECT content FROM message_content WHERE message_id = $1`,
          [id],
        );
        await client.query(
          `INSERT INTO message_revisions (message_id, revision, author_ref, content, content_sha256, at)
           VALUES ($1, 1, $2, $3, $4, $5)`,
          [id, row.author_ref, crows[0]?.content ?? "", row.content_sha256, iso(row.created_at)],
        );
        nextRevision = 2;
      }

      const at = new Date().toISOString();
      await client.query(
        `INSERT INTO message_revisions (message_id, revision, author_ref, content, content_sha256, at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, nextRevision, row.author_ref, content, hashContent(content), at],
      );
      await client.query(`UPDATE message_content SET content = $2 WHERE message_id = $1`, [id, content]);
      await this.#appendAuditWithClient(client, { actor: by, action: "message.edit", target: id, detail: `rev ${nextRevision}` });

      await client.query("COMMIT");
      return { ...rowToMessage(row), editedAt: at };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Full history, revision order. An un-edited message synthesizes its single original revision
   * from messages + message_content; a redacted message returns tombstones (content dropped). */
  async listRevisions(id: Id): Promise<MessageRevision[]> {
    const { rows } = await this.#pool.query<MessageRevisionRow>(
      `SELECT message_id, revision, author_ref, content, content_sha256, at
       FROM message_revisions WHERE message_id = $1 ORDER BY revision`,
      [id],
    );
    if (rows.length > 0) return rows.map(rowToMessageRevision);

    // Never edited — the one revision is the original on the row (content omitted if redacted).
    const { rows: orows } = await this.#pool.query<MessageJoinRow>(
      `SELECT m.id, m.channel_id, m.seq, m.author_ref, m.author_type, m.prompted_by, m.parent_id,
              m.content_sha256, m.prev_hash, m.hash, m.created_at, m.redacted_at, mc.content
       FROM messages m
       LEFT JOIN message_content mc ON mc.message_id = m.id
       WHERE m.id = $1`,
      [id],
    );
    const o = orows[0];
    if (!o) return [];
    return [rowToMessageRevision({
      message_id: o.id,
      revision: 1,
      author_ref: o.author_ref,
      content: o.redacted_at ? null : o.content,
      content_sha256: o.content_sha256,
      at: o.created_at,
    })];
  }

  // ── Reactions (mutable; NOT chained) ────────────────────────────────────────────────────────

  /** Idempotent per (messageId, userSub, emoji) via ON CONFLICT DO NOTHING — the database enforces
   * the idempotency directly, rather than an app-level existence check. */
  async addReaction(messageId: Id, userSub: string, emoji: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO reactions (message_id, user_sub, emoji, at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id, user_sub, emoji) DO NOTHING`,
      [messageId, userSub, emoji, new Date().toISOString()],
    );
  }

  /** Removes exactly the (messageId, userSub, emoji) triple. No-op (0 rows affected) if absent. */
  async removeReaction(messageId: Id, userSub: string, emoji: string): Promise<void> {
    await this.#pool.query(
      `DELETE FROM reactions WHERE message_id = $1 AND user_sub = $2 AND emoji = $3`,
      [messageId, userSub, emoji],
    );
  }

  async listReactions(messageId: Id): Promise<Reaction[]> {
    const { rows } = await this.#pool.query<ReactionRow>(
      `SELECT message_id, user_sub, emoji, at FROM reactions WHERE message_id = $1 ORDER BY at`,
      [messageId],
    );
    return rows.map(rowToReaction);
  }

  /** Every reaction on any message in `channelId`, joined through messages, in message-seq order. */
  async listReactionsForChannel(channelId: Id): Promise<Reaction[]> {
    const { rows } = await this.#pool.query<ReactionRow>(
      `SELECT r.message_id, r.user_sub, r.emoji, r.at
       FROM reactions r JOIN messages m ON m.id = r.message_id
       WHERE m.channel_id = $1
       ORDER BY m.seq, r.at`,
      [channelId],
    );
    return rows.map(rowToReaction);
  }

  // ── Per-user read markers → unread counts ───────────────────────────────────────────────────

  async setLastRead(channelId: Id, userSub: string, seq: number): Promise<void> {
    await this.#pool.query(
      `INSERT INTO read_markers (channel_id, user_sub, seq) VALUES ($1, $2, $3)
       ON CONFLICT (channel_id, user_sub) DO UPDATE SET seq = EXCLUDED.seq`,
      [channelId, userSub, seq],
    );
  }

  /** Messages in `channelId` with seq > the user's last-read seq (default 0 — everything unread,
   * when no read_markers row exists yet). A live recount against `messages`, same "can never drift"
   * spirit as MemoryStore's version. */
  async unreadCount(channelId: Id, userSub: string): Promise<number> {
    const { rows } = await this.#pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM messages m
       WHERE m.channel_id = $1
         AND m.seq > COALESCE((SELECT seq FROM read_markers WHERE channel_id = $1 AND user_sub = $2), 0)`,
      [channelId, userSub],
    );
    return rows[0]?.count ?? 0;
  }

  // ── Inbound webhooks ─────────────────────────────────────────────────────────────────────────

  /** Mints a fresh bearer credential the same way MemoryStore does (24 bytes from node:crypto's
   * CSPRNG, base64url) — treat `token` like a secret. */
  async createWebhook(channelId: Id, createdBy: string): Promise<Webhook> {
    const webhook: Webhook = {
      id: randomUUID(),
      channelId,
      token: randomBytes(24).toString("base64url"),
      createdBy,
      createdAt: new Date().toISOString(),
    };
    await this.#pool.query(
      `INSERT INTO webhooks (id, channel_id, token, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [webhook.id, webhook.channelId, webhook.token, webhook.createdBy, webhook.createdAt],
    );
    return webhook;
  }

  /** A null/empty token never matches a row — guards a caller that forwards a missing/blank header
   * straight through instead of checking it first. */
  async getWebhookByToken(token: string): Promise<Webhook | null> {
    if (!token) return null;
    const { rows } = await this.#pool.query<WebhookRow>(
      `SELECT id, channel_id, token, created_by, created_at FROM webhooks WHERE token = $1`,
      [token],
    );
    return rows[0] ? rowToWebhook(rows[0]) : null;
  }

  /** Purges plaintext, stamps the tombstone, and appends the audit event — all in ONE transaction
   * (a stronger guarantee than "three separate steps"): either the whole redaction (content
   * deleted + redacted_at stamped + audit event recorded) lands, or none of it does. Fails closed
   * on an unknown or already-redacted message (message_content's absence for an unredacted row
   * should never happen given appendMessage's invariants, but redacted_at is the authoritative
   * one-way tombstone check either way). */
  async redactMessage(id: Id, by: string, reason: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query<{ redacted_at: Date | null }>(
        `SELECT redacted_at FROM messages WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new Error(`PgStore.redactMessage: unknown message ${id}`);
      if (row.redacted_at) throw new Error(`PgStore.redactMessage: ${id} is already redacted`);

      await client.query(`DELETE FROM message_content WHERE message_id = $1`, [id]);
      // Purge every prior version's plaintext too — an edited message's revisions are just as
      // sensitive; keep the revision metadata (hashes/timestamps) as a tombstone trail.
      await client.query(`UPDATE message_revisions SET content = NULL WHERE message_id = $1`, [id]);
      await client.query(`UPDATE messages SET redacted_at = $1 WHERE id = $2`, [new Date().toISOString(), id]);
      await this.#appendAuditWithClient(client, { actor: by, action: "message.redact", target: id, detail: reason });

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Shared by appendAudit and redactMessage (so redactMessage's audit event lands in the SAME
   * transaction as its message mutation). Caller is responsible for BEGIN/COMMIT/ROLLBACK around
   * this — see appendAudit and redactMessage. Takes the fixed global audit advisory lock; see the
   * file header. */
  async #appendAuditWithClient(client: PoolClient, input: AppendAuditInput): Promise<AuditEvent> {
    await client.query("SELECT pg_advisory_xact_lock(2, 0)");

    const { rows } = await client.query<{ seq: number; hash: string }>(
      `SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`,
    );
    const last = rows[0];
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
    const id = randomUUID();

    await client.query(
      `INSERT INTO audit_log (id, seq, actor, act_as, action, target, detail, prev_hash, hash, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, seq, input.actor, input.actAs ?? null, input.action, input.target ?? null, input.detail ?? null, prevHash, hash, at],
    );

    return compact({ id, seq, actor: input.actor, actAs: input.actAs, action: input.action, target: input.target, detail: input.detail, prevHash, hash, at });
  }

  async appendAudit(input: AppendAuditInput): Promise<AuditEvent> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const event = await this.#appendAuditWithClient(client, input);
      await client.query("COMMIT");
      return event;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Snapshot of the global audit log, in seq order — for the admin / audit-review console. */
  async listAudit(): Promise<AuditEvent[]> {
    const { rows } = await this.#pool.query<AuditRow>(
      `SELECT id, seq, actor, act_as, action, target, detail, prev_hash, hash, at FROM audit_log ORDER BY seq`,
    );
    return rows.map(rowToAuditEvent);
  }

  /** Recompute both chains end-to-end: every channel's message chain (all must pass, including
   * channels with zero messages, which trivially verify) plus the one global audit chain. */
  async verifyChains(): Promise<{ messagesOk: boolean; auditOk: boolean }> {
    const { rows: channelRows } = await this.#pool.query<{ id: string }>(`SELECT id FROM channels`);

    let messagesOk = true;
    for (const { id } of channelRows) {
      const messages = await this.listMessages(id);
      if (!verifyMessageChain(messages).ok) {
        messagesOk = false;
        break;
      }
    }

    const auditOk = verifyAuditChain(await this.listAudit()).ok;
    return { messagesOk, auditOk };
  }

  // ── SessionStore ─────────────────────────────────────────────────────────────────────────────

  async createSession(input: Omit<AgentSession, "id" | "createdAt">): Promise<AgentSession> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.#pool.query(
      `INSERT INTO agent_sessions (id, agent_id, channel_id, host_type, runner_id, status, created_at, lease_expires_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, input.agentId, input.channelId, input.hostType, input.runnerId ?? null, input.status, createdAt, input.leaseExpiresAt, input.endedAt ?? null],
    );
    return compact({
      id,
      agentId: input.agentId,
      channelId: input.channelId,
      hostType: input.hostType,
      runnerId: input.runnerId,
      status: input.status,
      createdAt,
      leaseExpiresAt: input.leaseExpiresAt,
      endedAt: input.endedAt,
    });
  }

  async getSession(id: Id): Promise<AgentSession | null> {
    const { rows } = await this.#pool.query<SessionRow>(
      `SELECT id, agent_id, channel_id, host_type, runner_id, status, created_at, lease_expires_at, ended_at
       FROM agent_sessions WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  /** A channel's sessions, creation order (ins_seq). */
  async listSessionsByChannel(channelId: Id): Promise<AgentSession[]> {
    const { rows } = await this.#pool.query<SessionRow>(
      `SELECT id, agent_id, channel_id, host_type, runner_id, status, created_at, lease_expires_at, ended_at
       FROM agent_sessions WHERE channel_id = $1 ORDER BY ins_seq`,
      [channelId],
    );
    return rows.map(rowToSession);
  }

  /** Sessions still live in the control-plane sense: `starting` or `active`, creation order. */
  async listActiveSessions(): Promise<AgentSession[]> {
    const { rows } = await this.#pool.query<SessionRow>(
      `SELECT id, agent_id, channel_id, host_type, runner_id, status, created_at, lease_expires_at, ended_at
       FROM agent_sessions WHERE status IN ('starting', 'active') ORDER BY ins_seq`,
    );
    return rows.map(rowToSession);
  }

  /** Every session, all statuses, creation order — for the admin console. */
  async listAllSessions(): Promise<AgentSession[]> {
    const { rows } = await this.#pool.query<SessionRow>(
      `SELECT id, agent_id, channel_id, host_type, runner_id, status, created_at, lease_expires_at, ended_at
       FROM agent_sessions ORDER BY ins_seq`,
    );
    return rows.map(rowToSession);
  }

  /** Fails closed on an unknown session (matches addMember/redactMessage's guard style). Moving to
   * `ended` also stamps `ended_at` — the one derived field this row carries. */
  async setSessionStatus(id: Id, status: SessionStatus): Promise<void> {
    const result =
      status === "ended"
        ? await this.#pool.query(`UPDATE agent_sessions SET status = $1, ended_at = $2 WHERE id = $3`, [status, new Date().toISOString(), id])
        : await this.#pool.query(`UPDATE agent_sessions SET status = $1 WHERE id = $2`, [status, id]);
    if (result.rowCount === 0) throw new Error(`PgStore.setSessionStatus: unknown session ${id}`);
  }

  /** Called on runner heartbeats to push the lease forward. Unknown id fails closed. */
  async renewLease(id: Id, leaseExpiresAt: string): Promise<void> {
    const result = await this.#pool.query(`UPDATE agent_sessions SET lease_expires_at = $1 WHERE id = $2`, [leaseExpiresAt, id]);
    if (result.rowCount === 0) throw new Error(`PgStore.renewLease: unknown session ${id}`);
  }

  async addGrant(grant: ExecuteGrant): Promise<void> {
    await this.#pool.query(
      `INSERT INTO execute_grants (session_id, granted_by, scope, turn_id, granted_at, consumed)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [grant.sessionId, grant.grantedBy, grant.scope, grant.turnId ?? null, grant.grantedAt, grant.consumed ?? false],
    );
  }

  /** The most-recently-added (highest `id` — see 0002_parity.sql), not-yet-consumed grant for this
   * session — i.e. what agent/gate.ts's evaluateTool() should be checking right now — or undefined
   * if none. */
  async activeGrant(sessionId: Id): Promise<ExecuteGrant | undefined> {
    const { rows } = await this.#pool.query<GrantRow>(
      `SELECT session_id, granted_by, scope, turn_id, granted_at, consumed
       FROM execute_grants WHERE session_id = $1 AND consumed = false ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? rowToGrant(rows[0]) : undefined;
  }

  /** Marks the current active grant consumed (tombstone, not delete — mirrors redactMessage's
   * approach to Message rows). No-op if there is no active grant. */
  async consumeGrant(sessionId: Id): Promise<void> {
    await this.#pool.query(
      `UPDATE execute_grants SET consumed = true
       WHERE id = (SELECT id FROM execute_grants WHERE session_id = $1 AND consumed = false ORDER BY id DESC LIMIT 1)`,
      [sessionId],
    );
  }

  /** Closes the underlying pool. Not part of the Store/SessionStore contract — callers (the app's
   * shutdown path, tests) that own a PgStore's lifecycle call this explicitly. */
  async close(): Promise<void> {
    await this.#pool.end();
  }
}
