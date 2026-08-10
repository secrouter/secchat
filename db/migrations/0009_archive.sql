-- SecChat migration 0009 — ARCHIVE flag on channels.
--
-- A soft-hide for decluttering the sidebar (heavy testing spawns many channels/agent channels).
-- Nothing is deleted; an archived channel is just filtered out of the default list and can be
-- restored. No hash-chain / append-only concern (channels carry no chain; cf. 0005's note that
-- channels.cui_marking is freely UPDATE-able), so a plain mutable column suffices.

BEGIN;

ALTER TABLE channels ADD COLUMN archived boolean NOT NULL DEFAULT false;

COMMIT;
