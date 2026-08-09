-- SecChat migration 0005 — classification MARKING on messages (chain-bound).
--
-- Every message carries an EFFECTIVE marking (a rung of the deployment's marking ladder, see
-- src/marking/policy.ts): the channel's level when the channel is marked (channels.cui_marking,
-- already present since 0001), else the author's per-message choice. It is stamped at INSERT and
-- bound INTO the per-channel hash chain (src/audit/chain.ts computeMessageHash) — a classification
-- you could silently alter wouldn't be a control — so, like content_sha256, it must be immutable.
--
-- No channel change is needed: channels.cui_marking already exists (0001); PgStore.setChannelMarking
-- UPDATEs it and 0001 placed no guard trigger on channels.

BEGIN;

-- The default covers any pre-existing rows and satisfies NOT NULL; the app always stamps the real
-- effective marking explicitly on INSERT, so the default is only a floor-of-last-resort.
ALTER TABLE messages ADD COLUMN marking text NOT NULL DEFAULT 'UNCLASSIFIED' CHECK (marking <> '');

-- Fold `marking` into the append-only guard's immutable-column set (0001's messages_guard_update):
-- it is a hash-chain input, so it must stay byte-identical to OLD for the life of the row, exactly
-- like content_sha256/prev_hash/hash. CREATE OR REPLACE swaps the body; the 0001 trigger that calls
-- it picks up the new definition. (Every other line is reproduced verbatim from 0001.)
CREATE OR REPLACE FUNCTION messages_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id             IS DISTINCT FROM OLD.id
     OR NEW.channel_id     IS DISTINCT FROM OLD.channel_id
     OR NEW.seq            IS DISTINCT FROM OLD.seq
     OR NEW.author_ref     IS DISTINCT FROM OLD.author_ref
     OR NEW.author_type    IS DISTINCT FROM OLD.author_type
     OR NEW.prompted_by    IS DISTINCT FROM OLD.prompted_by
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.marking        IS DISTINCT FROM OLD.marking
     OR NEW.prev_hash      IS DISTINCT FROM OLD.prev_hash
     OR NEW.hash           IS DISTINCT FROM OLD.hash
     OR NEW.created_at     IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'messages is append-only: only redacted_at may change (id=%)', OLD.id;
  END IF;

  IF OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at THEN
    RAISE EXCEPTION 'messages.redacted_at is a one-way tombstone (id=%)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
