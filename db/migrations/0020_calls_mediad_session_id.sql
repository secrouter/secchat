-- SecChat migration 0020 — persist mediad's own session id on `calls` (docs/plans/voice-calls-plan.md
-- v3.1 §2.4 REQUIRED #5, "the relocated durability item").
--
-- 0019_calls.sql's `calls` table tracked everything the LIVE post-call pipeline needs from memory
-- (CallRegistry's in-process `LiveCall`), but not mediad's own `sessionId` — so a startup-
-- reconciliation sweep (mediad-client.ts's `reconcileUnclaimedSessions`) that finds an ended-but-
-- unclaimed row (a backend crash between mediad's finalize and attachment-ingest) had no sound way
-- to match that row back to its on-disk session directory (`<recordings-volume>/<sessionId>/...`,
-- voice-contracts.md §4) without guessing — unacceptable for a CUI compliance artifact. This column
-- closes that gap: `CallRegistry.accept()` persists it immediately after `MediadClient.createSession`
-- succeeds (well before the call ever ends), so by the time a row is a reconciliation candidate
-- (`ended_at IS NOT NULL AND recording_attachment_id IS NULL`, 0019's own partial index), the session
-- id has always already been recorded.
--
-- NULL for a `mode = 'p2p'` call (no mediad session ever exists) and for a relayed call whose
-- `createSession` itself failed (the mid-accept downgrade-to-p2p path, §2.3) — both cases are already
-- excluded from the reconciliation candidate set by `mode = 'relayed'`, not by this column being set,
-- so no additional CHECK constraint ties the two together here.

BEGIN;

ALTER TABLE calls ADD COLUMN mediad_session_id text;

COMMIT;
