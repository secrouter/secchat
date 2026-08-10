-- SecChat migration 0007 — @MENTIONS inbox.
--
-- When a message @-mentions a channel member (resolution in src/mentions/parse.ts), one row is
-- written here per mentioned user. This is the DURABLE inbox: the WS hub delivers a live `mention`
-- event too, but it has no offline queueing, so a mention that arrived while the user was
-- disconnected would be lost without this table. Also backs the unseen-count badge.
--
-- NOT part of the audit chain — a routing/social signal, not a governance event (redaction/DLP/
-- marking are the chained ones). Deleting the owning message cascades the mention away.

BEGIN;

CREATE TABLE mentions (
  id             uuid PRIMARY KEY,
  message_id     uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  channel_id     uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  mentioned_sub  text NOT NULL,
  author_sub     text NOT NULL,
  created_at     timestamptz NOT NULL,
  seen_at        timestamptz,                       -- NULL until the user views their inbox
  ins_seq        bigserial                          -- stable newest-first ordering
);

-- The inbox query is "my mentions, newest first" (+ an unseen filter for the badge).
CREATE INDEX mentions_recipient_idx ON mentions (mentioned_sub, ins_seq DESC);
CREATE INDEX mentions_message_idx ON mentions (message_id);
-- A message resolves the same recipient at most once (idempotent re-post safety).
CREATE UNIQUE INDEX mentions_message_recipient_uniq ON mentions (message_id, mentioned_sub);

COMMIT;
