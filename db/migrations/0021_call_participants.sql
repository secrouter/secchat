-- SecChat migration 0021 — `call_participants`: the durable leg->sub map for a call
-- (voice-call plan's group-calling extension; src/types.ts's CallParticipantRow doc comment).
--
-- 0019_calls.sql's `calls` table carries a fixed `caller`/`callee` pair, which was enough for a 1:1
-- DM call (and a solo self-DM memo, where `caller = callee`) but doesn't generalize to an
-- N-participant GROUP call (a `kind:"human"` channel, join-on-demand via `call_start`/`call_join`).
-- This table is the generalization: one row per participant's LEG on a call, populated for every
-- relayed call going forward (1:1, solo, AND group — not just group calls), so the crash-recovery
-- reconciliation sweep (mediad-client.ts's `reconcileUnclaimedSessions`) and the live post-call
-- pipeline (calls/registry.ts's `runPostCallPipeline`) both iterate the SAME leg->sub map instead of
-- assuming exactly two legs identified by the fixed LEG_CALLER_ID/LEG_CALLEE_ID constants.
--
-- A row survives a mid-call departure (`left_at` stamped, row never deleted) — that participant's
-- leg audio still exists in mediad's finalize manifest and still needs transcribing once the call
-- (as a whole) ends. `PRIMARY KEY (call_id, sub)` doubles as the upsert target for a rejoin (a group
-- participant who left and comes back — `Store.addCallParticipant`).

BEGIN;

CREATE TABLE call_participants (
  call_id    uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  -- Principal.sub — no local FK, same "identity lives in the IdP" reasoning as calls.caller/callee.
  sub        text NOT NULL,
  leg_id     text NOT NULL,
  joined_at  timestamptz NOT NULL,
  left_at    timestamptz,
  PRIMARY KEY (call_id, sub)
);

-- The post-call pipeline's + reconciliation's "every participant this call ever had" read.
CREATE INDEX call_participants_call_idx ON call_participants (call_id);

COMMIT;
