-- SecChat migration 0019 — 1:1 DM voice CALLS (docs/plans/voice-calls-plan.md, v3.1).
--
-- Two independent changes:
--
--  1. `messages.author_type` gains `'system'` (§8 O4 / the plan's ONE deliberate type-model
--     extension): the service principal that authors a call transcript (both participants are
--     named IN the body, not via author_ref — see src/governance/append.ts's governedCallAppend).
--     Just a CHECK-constraint widening, reproduced (not a fresh CREATE) so the existing rows and
--     the append-only guard trigger (messages_guard_update, last amended by 0006_attachments.sql)
--     are untouched — this migration never UPDATEs a messages row, only widens what a FUTURE
--     INSERT may carry.
--
--  2. A new `calls` table: the durable record of a call, from `active` onward (first
--     `call_accept`) — a ringing call that's declined/missed/glare-lost never gets a row here, only
--     the audited `call.*` events (+ a `call_missed`/decline chat line) record it (src/types.ts's
--     CallRow doc comment). `consent`/`mode` are fixed at creation and never change (§2.1's O5
--     deferral: no mid-call P2P<->relay migration). `recording` mirrors secchat-mediad's ACTUAL
--     writer state (§2.3 — reported to the backend, broadcast to both UIs, and re-readable here
--     across a backend restart). `recording_attachment_id`/`transcript_message_id` are filled in as
--     the §2.4 post-call pipeline progresses (server-side attachment ingest, then the governed
--     transcript post) — both stay NULL forever for an unrecorded (`mode = 'p2p'`) call.
--
--     `calls` CROSS-REFERENCES `messages`/`attachments` (nullable FKs) but never the reverse —
--     nothing is added to the messages/attachments tables themselves, so their own append-only
--     guards (messages_guard_update; attachments has none — its rows are claimed once via
--     Store.claimAttachments, then otherwise immutable by convention) are respected by construction:
--     this migration cannot touch a messages/attachments row, only point AT one.
--
--     `ended_at IS NOT NULL AND recording_attachment_id IS NULL` is the startup-reconciliation
--     candidate set (§2.4 v3.1 REQUIRED #5 — Store.listUnclaimedEndedCalls / mediad-client.ts's
--     reconcileUnclaimedSessions), backed by its own partial index below.

BEGIN;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_author_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_author_type_check
  CHECK (author_type IN ('user', 'agent', 'system'));

CREATE TABLE calls (
  id                     uuid PRIMARY KEY,
  channel_id             uuid NOT NULL REFERENCES channels (id) ON DELETE RESTRICT,
  -- Principal.sub of each participant. No local FK by design (see channels.created_by / messages
  -- .author_ref) — identity lives in the IdP, verified via JWKS on every request, never mirrored
  -- locally as a users table with referential integrity.
  caller                 text NOT NULL,
  callee                 text NOT NULL,
  started_at             timestamptz NOT NULL,   -- when the call went `active` (first call_accept)
  ended_at               timestamptz,            -- set on call_end / bound-connection-drop teardown
  consent                boolean NOT NULL,        -- the callee's recording-consent outcome (D3/D4)
  mode                   text NOT NULL CHECK (mode IN ('p2p', 'relayed')),
  recording              text NOT NULL DEFAULT 'none' CHECK (recording IN ('none', 'on')),
  recording_attachment_id uuid REFERENCES attachments (id) ON DELETE SET NULL,
  transcript_message_id   uuid REFERENCES messages (id) ON DELETE SET NULL
);

-- "is there already an active call in this channel" (CallRegistry's single-flight check) and the
-- DM-history "past calls" listing both key off this.
CREATE INDEX calls_channel_idx ON calls (channel_id);

-- Startup-reconciliation candidate set (§2.4 v3.1 REQUIRED #5) — small and cheap to scan even on a
-- busy deployment, since it only ever holds calls the pipeline hasn't finished with yet.
CREATE INDEX calls_unclaimed_ended_idx ON calls (ended_at)
  WHERE ended_at IS NOT NULL AND recording_attachment_id IS NULL;

COMMIT;
