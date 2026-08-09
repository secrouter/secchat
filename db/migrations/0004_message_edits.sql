-- SecChat migration 0004 — trackable message edit (chain-safe revision history).
--
-- An edit must never rewrite a message in place. messages.content_sha256 (and therefore the
-- per-channel hash chain in src/audit/chain.ts) binds the ORIGINAL content, and 0001's
-- messages_guard_update() trigger forbids changing any column but redacted_at. So an edit is
-- recorded ENTIRELY OUT-OF-BAND: the original row stays byte-identical, the chain still verifies,
-- and each new version accrues here while the edit itself is written as a `message.edit` audit
-- event on the (metadata-only) audit chain — the tamper-evident record of who edited when.
--
-- Storage model (mirrors MemoryStore):
--   * message_content keeps holding the CURRENT plaintext — overwritten on edit, deleted on
--     redaction (unchanged behaviour; it's just no longer necessarily the original text).
--   * message_revisions holds the FULL history including revision 1 (the original), seeded on the
--     first edit. `content` is NULLed when the message is redacted — a prior version is exactly as
--     sensitive as the current one, so redaction purges every version's plaintext, leaving only
--     the revision metadata (hashes, timestamps) as a tombstone trail.
--
-- A fully MUTABLE table (like 0002's reactions/webhooks): it rides neither hash chain, so no
-- append-only trigger. Message.editedAt is NOT a column anywhere — the read paths derive it as
-- MAX(at) over a message's revisions (present only once edited).

BEGIN;

CREATE TABLE message_revisions (
  message_id     uuid    NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  revision       integer NOT NULL CHECK (revision >= 1),   -- 1 = original, ascending
  author_ref     text    NOT NULL,                         -- always the original author (edit is author-only)
  content        text,                                     -- CUI plaintext; NULLed on redaction (tombstone)
  content_sha256 text    NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  at             timestamptz NOT NULL,                     -- created_at for revision 1, the edit time thereafter
  -- Enforces one row per (message, revision) and backs both "history in order" and the MAX(at)
  -- editedAt derivation in listMessages/listThread.
  PRIMARY KEY (message_id, revision)
);

COMMIT;
