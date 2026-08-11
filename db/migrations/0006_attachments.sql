-- SecChat migration 0006 — file ATTACHMENTS (chain-bound, marking-aware).
--
-- Attachments are uploaded first (unclaimed), then CLAIMED by a message at post time. The message
-- binds a MANIFEST DIGEST of its attachments — messages.attachments_sha256 = sha256 over the ordered
-- [sha256|filename|byte_size|marking] of each attachment (or '' when none) — INTO the per-channel hash
-- chain (src/audit/chain.ts computeMessageHash), so which files a message carries (and their content
-- hashes/markings) is tamper-evident exactly like content_sha256/marking. It is stamped at INSERT and
-- immutable.
--
-- Bytes live OUTSIDE Postgres: content-addressed on the filesystem under SECCHAT_UPLOADS_DIR, at
-- <dir>/<sha256> (dedup by content; the download route re-checks channel membership). Redaction of the
-- owning message deletes the bytes UNLESS the same sha256 is still referenced by an unclaimed upload
-- or another unredacted message (content-address dedup ⇒ refcount first — see the redact route +
-- Store.hasLiveAttachmentReference); the row + its sha256 stay as a tombstone, bound in the chain.

BEGIN;

-- The manifest digest for each message: '' (no attachments) or a 64-hex sha256. Chain input ⇒ immutable.
ALTER TABLE messages ADD COLUMN attachments_sha256 text NOT NULL DEFAULT ''
  CHECK (attachments_sha256 = '' OR attachments_sha256 ~ '^[0-9a-f]{64}$');

-- Fold attachments_sha256 into the append-only guard's immutable set (0001's messages_guard_update,
-- as amended by 0005). Every other line is reproduced verbatim.
CREATE OR REPLACE FUNCTION messages_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id                 IS DISTINCT FROM OLD.id
     OR NEW.channel_id         IS DISTINCT FROM OLD.channel_id
     OR NEW.seq                IS DISTINCT FROM OLD.seq
     OR NEW.author_ref         IS DISTINCT FROM OLD.author_ref
     OR NEW.author_type        IS DISTINCT FROM OLD.author_type
     OR NEW.prompted_by        IS DISTINCT FROM OLD.prompted_by
     OR NEW.content_sha256     IS DISTINCT FROM OLD.content_sha256
     OR NEW.marking            IS DISTINCT FROM OLD.marking
     OR NEW.attachments_sha256 IS DISTINCT FROM OLD.attachments_sha256
     OR NEW.prev_hash          IS DISTINCT FROM OLD.prev_hash
     OR NEW.hash               IS DISTINCT FROM OLD.hash
     OR NEW.created_at         IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'messages is append-only: only redacted_at may change (id=%)', OLD.id;
  END IF;

  IF OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
    RAISE EXCEPTION 'messages.redacted_at is a one-way tombstone (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attachment metadata. message_id is NULL until the upload is CLAIMED by a message post; once set it
-- never changes. Bytes are on the filesystem (content-addressed by sha256), never here.
CREATE TABLE attachments (
  id           uuid PRIMARY KEY,
  message_id   uuid REFERENCES messages (id) ON DELETE CASCADE,   -- NULL until claimed at post time
  channel_id   uuid NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  uploaded_by  text NOT NULL,
  filename     text NOT NULL,
  content_type text NOT NULL,
  byte_size    bigint NOT NULL CHECK (byte_size >= 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  marking      text NOT NULL CHECK (marking <> ''),
  created_at   timestamptz NOT NULL,
  ins_seq      bigserial                                          -- stable upload order for the manifest
);

CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_channel_idx ON attachments (channel_id);

COMMIT;
