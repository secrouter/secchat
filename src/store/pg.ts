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
import { DEFAULT_MARKING } from "../marking/policy.ts";
import type {
  AddAttachmentInput,
  Agent,
  AgentKind,
  AgentSession,
  AppendAuditInput,
  AppendMessageInput,
  Attachment,
  AuditEvent,
  AuthorType,
  Channel,
  ChannelKind,
  ExecuteGrant,
  Id,
  Member,
  MemberType,
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
  UserSshKey,
  Webhook,
  OutboundWebhook,
  OutboundEvent,
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
  archived: boolean | null;
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

interface SshKeyRow {
  sub: string;
  key_type: string;
  public_key: string;
  fingerprint: string;
  private_key_enc: string;
  created_at: Date;
}

interface AgentRow {
  id: string;
  owner_sub: string;
  kind: string;
  name: string | null;
  model: string | null;
  workspace: string | null;
  launch_env: string | null;
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
  marking: string;
  attachments_sha256: string;
  prev_hash: string;
  hash: string;
  created_at: Date;
  redacted_at: Date | null;
  model: string | null;
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

interface AttachmentRow {
  id: string;
  message_id: string | null;
  channel_id: string;
  uploaded_by: string;
  filename: string;
  content_type: string;
  byte_size: string; // bigint → string from `pg` (avoids precision loss); Number()ed on read
  sha256: string;
  marking: string;
  created_at: Date;
}

interface MentionRow {
  id: string;
  message_id: string;
  channel_id: string;
  mentioned_sub: string;
  author_sub: string;
  created_at: Date;
  seen_at: Date | null;
  seq: number;
  redacted_at: Date | null;
  content: string | null; // from message_content via LEFT JOIN; null once redacted (or never set)
  channel_name: string | null;
}

interface WebhookRow {
  id: string;
  channel_id: string;
  token: string;
  created_by: string;
  created_at: Date;
}

interface OutboundWebhookRow {
  id: string;
  channel_id: string;
  url: string;
  secret: string;
  events: string[];
  include_content: boolean;
  active: boolean;
  created_by: string;
  created_at: Date;
  last_status: number | null;
  last_error: string | null;
  last_delivery_at: Date | null;
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
    archived: row.archived ?? undefined,
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

function rowToSshKey(row: SshKeyRow): UserSshKey {
  return {
    sub: row.sub,
    keyType: row.key_type,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    privateKeyEnc: row.private_key_enc,
    createdAt: iso(row.created_at),
  };
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
    workspace: row.workspace ?? undefined,
    launchEnv: (row.launch_env as Agent["launchEnv"]) ?? undefined,
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
    model: row.model ?? undefined,
    contentSha256: row.content_sha256,
    marking: row.marking,
    attachmentsSha256: row.attachments_sha256,
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

function rowToAttachment(row: AttachmentRow): Attachment {
  return compact({
    id: row.id,
    messageId: row.message_id ?? undefined,
    channelId: row.channel_id,
    uploadedBy: row.uploaded_by,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    marking: row.marking,
    createdAt: iso(row.created_at),
  });
}

function rowToReaction(row: ReactionRow): Reaction {
  return { messageId: row.message_id, userSub: row.user_sub, emoji: row.emoji, at: iso(row.at) };
}

function rowToWebhook(row: WebhookRow): Webhook {
  return { id: row.id, channelId: row.channel_id, token: row.token, createdBy: row.created_by, createdAt: iso(row.created_at) };
}

function rowToOutboundWebhook(row: OutboundWebhookRow): OutboundWebhook {
  return compact({
    id: row.id,
    channelId: row.channel_id,
    url: row.url,
    secret: row.secret,
    events: row.events as OutboundEvent[],
    includeContent: row.include_content,
    active: row.active,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    lastStatus: row.last_status ?? undefined,
    lastError: row.last_error ?? undefined,
    lastDeliveryAt: row.last_delivery_at ? iso(row.last_delivery_at) : undefined,
  }) as OutboundWebhook;
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
      `SELECT id, workspace_id, kind, name, cui_marking, archived, created_by, created_at FROM channels WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToChannel(rows[0]) : null;
  }

  /** Sets the channel's classification level and chains a `channel.mark` audit event in ONE
   * transaction. The route validates the level + owns the set/raise-vs-downgrade authz. */
  async setChannelMarking(channelId: Id, marking: string, by: string): Promise<Channel> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<ChannelRow>(
        `UPDATE channels SET cui_marking = $2 WHERE id = $1
         RETURNING id, workspace_id, kind, name, cui_marking, archived, created_by, created_at`,
        [channelId, marking],
      );
      const row = rows[0];
      if (!row) throw new Error(`PgStore.setChannelMarking: unknown channel ${channelId}`);
      await this.#appendAuditWithClient(client, { actor: by, action: "channel.mark", target: channelId, detail: marking });
      await client.query("COMMIT");
      return rowToChannel(row);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async setChannelArchived(channelId: Id, archived: boolean): Promise<Channel> {
    const { rows } = await this.#pool.query<ChannelRow>(
      `UPDATE channels SET archived = $2 WHERE id = $1
       RETURNING id, workspace_id, kind, name, cui_marking, archived, created_by, created_at`,
      [channelId, archived],
    );
    const row = rows[0];
    if (!row) throw new Error(`PgStore.setChannelArchived: unknown channel ${channelId}`);
    return rowToChannel(row);
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

  async removeMember(channelId: Id, memberRef: string): Promise<boolean> {
    const result = await this.#pool.query(
      `DELETE FROM channel_members WHERE channel_id = $1 AND member_ref = $2`,
      [channelId, memberRef],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setMemberRole(channelId: Id, memberRef: string, role: Member["role"]): Promise<Member | null> {
    const { rows } = await this.#pool.query<MemberRow>(
      `UPDATE channel_members SET role = $3 WHERE channel_id = $1 AND member_ref = $2
       RETURNING channel_id, member_ref, member_type, role`,
      [channelId, memberRef, role],
    );
    return rows[0] ? rowToMember(rows[0]) : null;
  }

  /** All channels, creation order (ins_seq — see db/migrations/0002_parity.sql) — for the admin /
   * audit-review console (AU 3.3.5/6), same idiom as listMembers/listAgentsByOwner. */
  async listChannels(): Promise<Channel[]> {
    const { rows } = await this.#pool.query<ChannelRow>(
      `SELECT id, workspace_id, kind, name, cui_marking, archived, created_by, created_at FROM channels ORDER BY ins_seq`,
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

  // ── per-user git SSH identity (db/migrations/0011_user_ssh_keys.sql) ───────────────────────────

  /** Upsert on the `sub` PK — regenerating a key REPLACES the prior row. `private_key_enc` is the
   * AES-256-GCM envelope; the plaintext private key is never stored. Mirrors MemoryStore.setUserSshKey. */
  async setUserSshKey(key: UserSshKey): Promise<void> {
    await this.#pool.query(
      `INSERT INTO user_ssh_keys (sub, key_type, public_key, fingerprint, private_key_enc, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sub) DO UPDATE SET
         key_type = EXCLUDED.key_type,
         public_key = EXCLUDED.public_key,
         fingerprint = EXCLUDED.fingerprint,
         private_key_enc = EXCLUDED.private_key_enc,
         created_at = EXCLUDED.created_at`,
      [key.sub, key.keyType, key.publicKey, key.fingerprint, key.privateKeyEnc, key.createdAt],
    );
  }

  async getUserSshKey(sub: string): Promise<UserSshKey | null> {
    const { rows } = await this.#pool.query<SshKeyRow>(
      `SELECT sub, key_type, public_key, fingerprint, private_key_enc, created_at
         FROM user_ssh_keys WHERE sub = $1`,
      [sub],
    );
    return rows[0] ? rowToSshKey(rows[0]) : null;
  }

  async listUserSshKeys(): Promise<UserSshKey[]> {
    const { rows } = await this.#pool.query<SshKeyRow>(
      `SELECT sub, key_type, public_key, fingerprint, private_key_enc, created_at
         FROM user_ssh_keys ORDER BY created_at`,
    );
    return rows.map(rowToSshKey);
  }

  async deleteUserSshKey(sub: string): Promise<boolean> {
    const result = await this.#pool.query(`DELETE FROM user_ssh_keys WHERE sub = $1`, [sub]);
    return (result.rowCount ?? 0) > 0;
  }

  /** A dm channel whose user-members are exactly {subA, subB} — two user members, both present.
   * The count guard rules out a would-be group DM; the two EXISTS clauses pin both participants. */
  async findDmChannel(subA: string, subB: string): Promise<Channel | null> {
    const { rows } = await this.#pool.query<ChannelRow>(
      `SELECT c.id, c.workspace_id, c.kind, c.name, c.cui_marking, c.archived, c.created_by, c.created_at
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
      `INSERT INTO agents (id, owner_sub, kind, name, model, workspace, launch_env, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, input.ownerSub, input.kind, input.name ?? null, input.model ?? null, input.workspace ?? null, input.launchEnv ?? null, createdAt],
    );
    return compact({ id, ownerSub: input.ownerSub, kind: input.kind, name: input.name, model: input.model, workspace: input.workspace, launchEnv: input.launchEnv, createdAt });
  }

  async getAgent(id: Id): Promise<Agent | null> {
    const { rows } = await this.#pool.query<AgentRow>(
      `SELECT id, owner_sub, kind, name, model, workspace, launch_env, created_at FROM agents WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async updateAgentModel(id: Id, model: string): Promise<Agent | null> {
    const { rows } = await this.#pool.query<AgentRow>(
      `UPDATE agents SET model = $2 WHERE id = $1
       RETURNING id, owner_sub, kind, name, model, workspace, launch_env, created_at`,
      [id, model],
    );
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  /** Owner's agents, creation order (ins_seq). */
  async listAgentsByOwner(ownerSub: string): Promise<Agent[]> {
    const { rows } = await this.#pool.query<AgentRow>(
      `SELECT id, owner_sub, kind, name, model, workspace, launch_env, created_at FROM agents WHERE owner_sub = $1 ORDER BY ins_seq`,
      [ownerSub],
    );
    return rows.map(rowToAgent);
  }

  /** Every agent, creation order, regardless of owner — for the admin / audit-review console. */
  async listAllAgents(): Promise<Agent[]> {
    const { rows } = await this.#pool.query<AgentRow>(
      `SELECT id, owner_sub, kind, name, model, workspace, launch_env, created_at FROM agents ORDER BY ins_seq`,
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
      // Effective marking: a marked channel IS the portion; else the author's per-message choice,
      // defaulting to the floor. Read under the same lock; bound into the hash below.
      const { rows: chanRows } = await client.query<{ cui_marking: string | null }>(
        `SELECT cui_marking FROM channels WHERE id = $1`,
        [input.channelId],
      );
      const marking = chanRows[0]?.cui_marking ?? input.marking ?? DEFAULT_MARKING;
      const attachmentsSha256 = input.attachmentsSha256 ?? ""; // '' when no attachments
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
      const id = randomUUID();

      // channel_id's FK makes an unknown channel fail closed here, matching MemoryStore's throw.
      await client.query(
        `INSERT INTO messages (id, channel_id, seq, author_ref, author_type, prompted_by, parent_id, content_sha256, marking, attachments_sha256, prev_hash, hash, created_at, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, input.channelId, seq, input.authorRef, input.authorType, input.promptedBy ?? null, input.parentId ?? null, contentSha256, marking, attachmentsSha256, prevHash, hash, createdAt, input.model ?? null],
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
        marking,
        attachmentsSha256,
        prevHash,
        hash,
        createdAt,
        model: input.model,
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
              content_sha256, marking, attachments_sha256, prev_hash, hash, created_at, redacted_at
       FROM messages WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToMessage(rows[0]) : null;
  }

  /** Messages in seq order; `content` is omitted (key absent, not undefined) for redacted rows. With
   * `opts.limit`/`before`, returns a cursor page — the most recent `limit` at seq < `before` — via a
   * DESC+LIMIT query that is then reversed to ascending. Unbounded when both are unset. */
  async listMessages(channelId: Id, opts?: MessagePageOpts): Promise<Array<Message & { content?: string }>> {
    const select = `SELECT m.id, m.channel_id, m.seq, m.author_ref, m.author_type, m.prompted_by, m.parent_id,
              m.content_sha256, m.marking, m.attachments_sha256, m.prev_hash, m.hash, m.created_at, m.redacted_at, mc.content,
              rev.edited_at
       FROM messages m
       LEFT JOIN message_content mc ON mc.message_id = m.id
       LEFT JOIN (SELECT message_id, MAX(at) AS edited_at FROM message_revisions GROUP BY message_id) rev
              ON rev.message_id = m.id`;
    const args: unknown[] = [channelId];
    let where = "WHERE m.channel_id = $1";
    if (opts?.before != null) {
      args.push(opts.before);
      where += ` AND m.seq < $${args.length}`;
    }
    let sql: string;
    if (opts?.limit != null) {
      args.push(opts.limit);
      sql = `${select} ${where} ORDER BY m.seq DESC LIMIT $${args.length}`;
    } else {
      sql = `${select} ${where} ORDER BY m.seq`;
    }
    const { rows } = await this.#pool.query<MessageJoinRow>(sql, args);
    const mapped = rows.map(rowToMessageWithContent);
    return opts?.limit != null ? mapped.reverse() : mapped;
  }

  /** Replies to `parentId` in `channelId`, seq order; same redaction-omits-content rule as
   * listMessages. `parent_id = $2` never matches a top-level row (parent_id IS NULL), matching
   * MemoryStore's `m.parentId === parentId` filter. */
  async listThread(channelId: Id, parentId: Id): Promise<Array<Message & { content?: string }>> {
    const { rows } = await this.#pool.query<MessageJoinRow>(
      `SELECT m.id, m.channel_id, m.seq, m.author_ref, m.author_type, m.prompted_by, m.parent_id,
              m.content_sha256, m.marking, m.attachments_sha256, m.prev_hash, m.hash, m.created_at, m.redacted_at, mc.content,
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
                content_sha256, marking, attachments_sha256, prev_hash, hash, created_at, redacted_at
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
              m.content_sha256, m.marking, m.attachments_sha256, m.prev_hash, m.hash, m.created_at, m.redacted_at, mc.content
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

  // ── Attachments (metadata; bytes are content-addressed on the filesystem) ─────────────────────

  async addAttachment(input: AddAttachmentInput): Promise<Attachment> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.#pool.query(
      `INSERT INTO attachments (id, message_id, channel_id, uploaded_by, filename, content_type, byte_size, sha256, marking, created_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, input.channelId, input.uploadedBy, input.filename, input.contentType, input.byteSize, input.sha256, input.marking, createdAt],
    );
    return compact({
      id,
      channelId: input.channelId,
      uploadedBy: input.uploadedBy,
      filename: input.filename,
      contentType: input.contentType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      marking: input.marking,
      createdAt,
    });
  }

  #attachmentCols = `id, message_id, channel_id, uploaded_by, filename, content_type, byte_size, sha256, marking, created_at`;

  async getAttachment(id: Id): Promise<Attachment | null> {
    const { rows } = await this.#pool.query<AttachmentRow>(
      `SELECT ${this.#attachmentCols} FROM attachments WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToAttachment(rows[0]) : null;
  }

  async claimAttachments(messageId: Id, attachmentIds: Id[]): Promise<Attachment[]> {
    if (attachmentIds.length === 0) return [];
    // Only UNCLAIMED rows are claimed (message_id IS NULL) — a second claim is a no-op.
    await this.#pool.query(
      `UPDATE attachments SET message_id = $1 WHERE id = ANY($2::uuid[]) AND message_id IS NULL`,
      [messageId, attachmentIds],
    );
    return this.listAttachmentsForMessage(messageId);
  }

  async listAttachmentsForMessage(messageId: Id): Promise<Attachment[]> {
    const { rows } = await this.#pool.query<AttachmentRow>(
      `SELECT ${this.#attachmentCols} FROM attachments WHERE message_id = $1 ORDER BY ins_seq`,
      [messageId],
    );
    return rows.map(rowToAttachment);
  }

  async hasLiveAttachmentReference(sha256: string, excludingMessageId: Id): Promise<boolean> {
    // Live = an unclaimed upload row (may yet be claimed), or a claimed row of any OTHER message
    // that is not redacted. One indexed probe; content addressing means one sha can back many rows.
    const { rows } = await this.#pool.query(
      `SELECT 1
         FROM attachments a
         LEFT JOIN messages m ON m.id = a.message_id
        WHERE a.sha256 = $1
          AND (a.message_id IS NULL OR (a.message_id <> $2 AND m.redacted_at IS NULL))
        LIMIT 1`,
      [sha256, excludingMessageId],
    );
    return rows.length > 0;
  }

  async listAttachmentsForChannel(channelId: Id): Promise<Attachment[]> {
    const { rows } = await this.#pool.query<AttachmentRow>(
      `SELECT ${this.#attachmentCols} FROM attachments WHERE channel_id = $1 AND message_id IS NOT NULL ORDER BY ins_seq`,
      [channelId],
    );
    return rows.map(rowToAttachment);
  }

  // ── Mentions (@-mentions inbox) ─────────────────────────────────────────────────────────────

  async addMention(input: { messageId: Id; channelId: Id; mentionedSub: string; authorSub: string }): Promise<Mention> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    // Idempotent per (message_id, mentioned_sub) — the unique index makes a re-resolve a no-op; on
    // conflict we return the pre-existing row rather than a fresh one.
    const { rows } = await this.#pool.query<{ id: string; created_at: Date; seen_at: Date | null }>(
      `INSERT INTO mentions (id, message_id, channel_id, mentioned_sub, author_sub, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (message_id, mentioned_sub) DO UPDATE SET message_id = EXCLUDED.message_id
       RETURNING id, created_at, seen_at`,
      [id, input.messageId, input.channelId, input.mentionedSub, input.authorSub, createdAt],
    );
    const row = rows[0]!;
    return compact({
      id: row.id,
      messageId: input.messageId,
      channelId: input.channelId,
      mentionedSub: input.mentionedSub,
      authorSub: input.authorSub,
      createdAt: iso(row.created_at),
      seenAt: row.seen_at ? iso(row.seen_at) : undefined,
    });
  }

  async listMentionsForUser(sub: string, opts?: { limit?: number; unseenOnly?: boolean }): Promise<MentionView[]> {
    const limit = opts?.limit ?? 50;
    const { rows } = await this.#pool.query<MentionRow>(
      `SELECT mn.id, mn.message_id, mn.channel_id, mn.mentioned_sub, mn.author_sub, mn.created_at, mn.seen_at,
              m.seq, m.redacted_at, mc.content, c.name AS channel_name
       FROM mentions mn
       JOIN messages m ON m.id = mn.message_id
       LEFT JOIN message_content mc ON mc.message_id = mn.message_id
       LEFT JOIN channels c ON c.id = mn.channel_id
       WHERE mn.mentioned_sub = $1 ${opts?.unseenOnly ? "AND mn.seen_at IS NULL" : ""}
       ORDER BY mn.ins_seq DESC
       LIMIT $2`,
      [sub, limit],
    );
    return rows.map((r) => {
      // `content` is a required field (string | null) — a redacted/absent message is an explicit
      // null tombstone, NOT a dropped key — so it must stay out of compact() (which strips nulls).
      const view: MentionView = {
        id: r.id,
        messageId: r.message_id,
        channelId: r.channel_id,
        mentionedSub: r.mentioned_sub,
        authorSub: r.author_sub,
        createdAt: iso(r.created_at),
        seq: r.seq,
        content: r.redacted_at ? null : r.content,
      };
      if (r.seen_at) view.seenAt = iso(r.seen_at);
      if (r.channel_name) view.channelName = r.channel_name;
      return view;
    });
  }

  async countUnseenMentions(sub: string): Promise<number> {
    const { rows } = await this.#pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM mentions WHERE mentioned_sub = $1 AND seen_at IS NULL`,
      [sub],
    );
    return rows[0]?.count ?? 0;
  }

  async markMentionsSeen(sub: string, ids?: Id[]): Promise<number> {
    const now = new Date().toISOString();
    // All of the user's unseen mentions, or just the given ids (still scoped to the user).
    const result = ids
      ? await this.#pool.query(
          `UPDATE mentions SET seen_at = $2 WHERE mentioned_sub = $1 AND seen_at IS NULL AND id = ANY($3::uuid[])`,
          [sub, now, ids],
        )
      : await this.#pool.query(
          `UPDATE mentions SET seen_at = $2 WHERE mentioned_sub = $1 AND seen_at IS NULL`,
          [sub, now],
        );
    return result.rowCount ?? 0;
  }

  // ── Pins (channel-scoped message bookmarks) ─────────────────────────────────────────────────

  async pinMessage(channelId: Id, messageId: Id, by: string): Promise<Pin> {
    const pinnedAt = new Date().toISOString();
    // Idempotent per message (PK) — a re-pin keeps the ORIGINAL pinnedBy/pinnedAt.
    const { rows } = await this.#pool.query<{ pinned_by: string; pinned_at: Date }>(
      `INSERT INTO pins (message_id, channel_id, pinned_by, pinned_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id) DO UPDATE SET message_id = EXCLUDED.message_id
       RETURNING pinned_by, pinned_at`,
      [messageId, channelId, by, pinnedAt],
    );
    const row = rows[0]!;
    return { channelId, messageId, pinnedBy: row.pinned_by, pinnedAt: iso(row.pinned_at) };
  }

  async unpinMessage(messageId: Id): Promise<boolean> {
    const result = await this.#pool.query(`DELETE FROM pins WHERE message_id = $1`, [messageId]);
    return (result.rowCount ?? 0) > 0;
  }

  async listPinnedMessages(channelId: Id): Promise<PinnedMessage[]> {
    const { rows } = await this.#pool.query<{
      message_id: string;
      channel_id: string;
      pinned_by: string;
      pinned_at: Date;
      seq: number;
      author_ref: string;
      redacted_at: Date | null;
      content: string | null;
    }>(
      `SELECT p.message_id, p.channel_id, p.pinned_by, p.pinned_at,
              m.seq, m.author_ref, m.redacted_at, mc.content
       FROM pins p
       JOIN messages m ON m.id = p.message_id
       LEFT JOIN message_content mc ON mc.message_id = p.message_id
       WHERE p.channel_id = $1
       ORDER BY p.ins_seq DESC`,
      [channelId],
    );
    return rows.map((r) => ({
      channelId: r.channel_id,
      messageId: r.message_id,
      pinnedBy: r.pinned_by,
      pinnedAt: iso(r.pinned_at),
      seq: r.seq,
      authorRef: r.author_ref,
      content: r.redacted_at ? null : r.content,
    }));
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

  /** A channel's inbound webhooks, newest first, for the management UI. */
  async listWebhooks(channelId: Id): Promise<Webhook[]> {
    const { rows } = await this.#pool.query<WebhookRow>(
      `SELECT id, channel_id, token, created_by, created_at FROM webhooks
         WHERE channel_id = $1 ORDER BY created_at DESC`,
      [channelId],
    );
    return rows.map(rowToWebhook);
  }

  /** Revokes a webhook, scoped to `channelId` (a member of one channel can't delete another's by
   * id). Returns whether a row was actually removed — rowCount 0 ⇒ no such webhook here (404). */
  async deleteWebhook(channelId: Id, webhookId: Id): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      `DELETE FROM webhooks WHERE id = $1 AND channel_id = $2`,
      [webhookId, channelId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ── Outbound webhooks ──────────────────────────────────────────────────────────────────────

  async createOutboundWebhook(input: {
    channelId: Id;
    url: string;
    events: OutboundEvent[];
    includeContent: boolean;
    createdBy: string;
  }): Promise<OutboundWebhook> {
    const hook: OutboundWebhook = {
      id: randomUUID(),
      channelId: input.channelId,
      url: input.url,
      secret: randomBytes(24).toString("base64url"),
      events: [...input.events],
      includeContent: input.includeContent,
      active: true,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    };
    await this.#pool.query(
      `INSERT INTO outbound_webhooks
         (id, channel_id, url, secret, events, include_content, active, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [hook.id, hook.channelId, hook.url, hook.secret, hook.events, hook.includeContent, hook.active, hook.createdBy, hook.createdAt],
    );
    return hook;
  }

  async listOutboundWebhooks(channelId: Id): Promise<OutboundWebhook[]> {
    const { rows } = await this.#pool.query<OutboundWebhookRow>(
      `SELECT id, channel_id, url, secret, events, include_content, active, created_by, created_at,
              last_status, last_error, last_delivery_at
         FROM outbound_webhooks WHERE channel_id = $1 ORDER BY created_at DESC`,
      [channelId],
    );
    return rows.map(rowToOutboundWebhook);
  }

  async getOutboundWebhook(channelId: Id, id: Id): Promise<OutboundWebhook | null> {
    const { rows } = await this.#pool.query<OutboundWebhookRow>(
      `SELECT id, channel_id, url, secret, events, include_content, active, created_by, created_at,
              last_status, last_error, last_delivery_at
         FROM outbound_webhooks WHERE id = $1 AND channel_id = $2`,
      [id, channelId],
    );
    return rows[0] ? rowToOutboundWebhook(rows[0]) : null;
  }

  async deleteOutboundWebhook(channelId: Id, id: Id): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      `DELETE FROM outbound_webhooks WHERE id = $1 AND channel_id = $2`,
      [id, channelId],
    );
    return (rowCount ?? 0) > 0;
  }

  async recordOutboundDelivery(id: Id, status: number, error: string | null): Promise<void> {
    await this.#pool.query(
      `UPDATE outbound_webhooks SET last_status = $2, last_error = $3, last_delivery_at = $4 WHERE id = $1`,
      [id, status, error, new Date().toISOString()],
    );
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
