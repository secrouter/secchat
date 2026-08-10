-- SecChat migration 0008 — pinned messages.
--
-- A pin is a channel-scoped bookmark on a message: a lightweight, mutable affordance (like a
-- reaction), NOT part of the tamper-evident hash chain. One pin per message (the PK), so pinning is
-- idempotent; unpinning deletes the row. Deleting the message cascades the pin away.

BEGIN;

CREATE TABLE pins (
  message_id  uuid PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  pinned_by   text NOT NULL,
  pinned_at   timestamptz NOT NULL,
  ins_seq     bigserial                      -- stable newest-pin-first ordering
);

CREATE INDEX pins_channel_idx ON pins (channel_id, ins_seq DESC);

COMMIT;
