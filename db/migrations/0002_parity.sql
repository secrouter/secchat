-- SecChat migration 0002 — Sprint 3/5 parity: adds what 0001 didn't yet cover so PgStore
-- (src/store/pg.ts) can implement the full Store + SessionStore surface (src/types.ts).
--
-- Three kinds of change here:
--   1. One pre-existing constraint relaxed: channels.workspace_id (see its own section below) —
--      not a new addition, a fix to a 0001 column whose constraint can never be satisfied through
--      the Store interface as it stands.
--   2. One column on the existing (frozen) `messages` table: `parent_id`, for Message.parentId
--      (thread replies). Metadata only, exactly like `prompted_by` in 0001 — set at INSERT, never
--      touched again by app convention. Deliberately NOT added to 0001's messages_guard_update()
--      immutable column set (that trigger is 0001's and is left untouched here); PgStore simply
--      never issues an UPDATE that touches it after insert. See src/store/pg.ts.
--   3. Five new, fully MUTABLE tables (no append-only triggers — none of these ride either
--      tamper-evident hash chain from src/audit/chain.ts): reactions, read_markers, webhooks,
--      agent_sessions, execute_grants.
--
-- `ins_seq bigserial` columns added to channels/agents/agent_sessions are NOT part of any TS
-- contract (never read back into a Channel/Agent/AgentSession) — they exist purely so PgStore's
-- listChannels / listAllAgents / listAgentsByOwner / listSessionsByChannel / listActiveSessions /
-- listAllSessions can ORDER BY true insertion order, matching MemoryStore's Map-iteration-order
-- (== insertion order) semantics exactly, which test/store.test.ts asserts on directly (e.g.
-- "listAgentsByOwner filters by owner and preserves creation order"). created_at alone can't do
-- this safely: two rows created in the same millisecond (very plausible in a test loop, or any
-- import order — timestamptz's on-the-wire text from the app is millisecond-precision) would sort
-- ambiguously. execute_grants doesn't need one of these — its own `id serial` already IS that
-- ordering key (see below).
--
-- Same conventions as 0001 throughout: app-supplied ids/timestamps (no DEFAULT/gen_random_uuid()),
-- no local users table (member/actor/owner refs are bare text, never FKed to a users table).

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- channels.workspace_id — relax `uuid NOT NULL REFERENCES workspaces (id)` to a bare `text`
-- column (still NOT NULL; just no type/FK constraint).
--
-- 0001's own header comment already flags this as unfinished: src/types.ts defines
-- Channel.workspaceId but exports no `Workspace` interface, and the Store port has no
-- createWorkspace/getWorkspace method — so MemoryStore does no workspace bookkeeping at all,
-- treating workspaceId as an opaque caller-supplied string (test/store.test.ts uses the literal
-- "ws-1" everywhere, never a UUID). As shipped, a NOT NULL FK to `workspaces` can never be
-- satisfied through the Store interface (nothing can INSERT a row there to satisfy it), and the
-- `uuid` column type alone rejects any non-UUID-shaped id like "ws-1" regardless of the FK.
-- Matching MemoryStore's actual behavior (accept any string, no existence check, no format
-- validation) means dropping both here rather than growing the Store contract with an unrequested
-- createWorkspace path. The `workspaces` table itself is untouched — still present, just no
-- longer referenced by anything; a real Workspace contract can revisit this later.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE channels DROP CONSTRAINT channels_workspace_id_fkey;
ALTER TABLE channels ALTER COLUMN workspace_id TYPE text;

-- ---------------------------------------------------------------------------------------------
-- messages.parent_id — Message.parentId (thread replies; src/types.ts)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN parent_id uuid REFERENCES messages (id) ON DELETE RESTRICT;

-- Backs listThread(channelId, parentId)'s WHERE channel_id = … AND parent_id = … ORDER BY seq.
CREATE INDEX messages_parent_id_idx ON messages (channel_id, parent_id, seq);

-- ---------------------------------------------------------------------------------------------
-- Insertion-order columns on the existing tables that need creation-order listing — see header.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE channels ADD COLUMN ins_seq bigserial;
ALTER TABLE agents ADD COLUMN ins_seq bigserial;

-- ---------------------------------------------------------------------------------------------
-- reactions — mirrors src/types.ts Reaction. Mutable social signal, deliberately OUTSIDE both
-- hash chains (no append-only trigger, unlike messages/audit_log). (message_id, user_sub, emoji)
-- is the natural key, so addReaction can be a plain `INSERT … ON CONFLICT DO NOTHING` —
-- idempotency enforced by the database itself rather than an app-level existence check.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE reactions (
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE RESTRICT,
  user_sub   text NOT NULL,             -- Principal.sub; no local FK (see channels.created_by)
  emoji      text NOT NULL,
  at         timestamptz NOT NULL,
  PRIMARY KEY (message_id, user_sub, emoji)
);

-- ---------------------------------------------------------------------------------------------
-- read_markers — backs setLastRead/unreadCount. One row per (channel, user); seq is that user's
-- last-read message seq in that channel. A missing row means "never read" (unreadCount treats an
-- absent row as last-read seq 0 — see src/store/pg.ts), so there's no need to pre-seed a row per
-- member.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE read_markers (
  channel_id uuid NOT NULL REFERENCES channels (id) ON DELETE RESTRICT,
  user_sub   text NOT NULL,
  seq        integer NOT NULL CHECK (seq >= 0),
  PRIMARY KEY (channel_id, user_sub)
);

-- ---------------------------------------------------------------------------------------------
-- webhooks — mirrors src/types.ts Webhook. `token` is the bearer credential an external system
-- presents to post into `channel_id` as a bot author; UNIQUE so getWebhookByToken is a plain
-- indexed lookup.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE webhooks (
  id         uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES channels (id) ON DELETE RESTRICT,
  token      text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- agent_sessions — mirrors src/types.ts AgentSession (the coding-agent control plane). Mutable:
-- status/lease_expires_at/ended_at are updated in place by setSessionStatus/renewLease — this
-- table carries no integrity-chain obligation, unlike messages/audit_log.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agent_sessions (
  id               uuid PRIMARY KEY,
  agent_id         uuid NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  channel_id       uuid NOT NULL REFERENCES channels (id) ON DELETE RESTRICT,
  host_type        text NOT NULL CHECK (host_type IN ('server', 'local')),
  runner_id        text,
  status           text NOT NULL CHECK (status IN ('starting', 'active', 'orphaned', 'ended')),
  created_at       timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  ended_at         timestamptz,
  ins_seq          bigserial
);

CREATE INDEX agent_sessions_channel_id_idx ON agent_sessions (channel_id, ins_seq);  -- listSessionsByChannel
CREATE INDEX agent_sessions_status_idx ON agent_sessions (status);                  -- listActiveSessions

-- ---------------------------------------------------------------------------------------------
-- execute_grants — mirrors src/types.ts ExecuteGrant. NOTE: ExecuteGrant has no `id` field in the
-- TS contract — `id` here is purely a Postgres-internal monotonic ordering key (never read back
-- into an ExecuteGrant), standing in for MemoryStore's "append order within a per-session array".
-- activeGrant/consumeGrant both want "the most-recently-added, not-yet-consumed grant for this
-- session"; granted_at alone has the same same-millisecond ambiguity risk called out above, so on
-- its own it isn't a reliable enough tiebreak.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE execute_grants (
  id          serial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES agent_sessions (id) ON DELETE RESTRICT,
  granted_by  text NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('once', 'turn')),
  turn_id     text,
  granted_at  timestamptz NOT NULL,
  consumed    boolean NOT NULL DEFAULT false
);

-- Backs activeGrant/consumeGrant: "most recent non-consumed grant for this session".
CREATE INDEX execute_grants_session_id_idx ON execute_grants (session_id, id);

COMMIT;
