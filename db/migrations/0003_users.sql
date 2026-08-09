-- SecChat migration 0003 — the seen-users directory (src/types.ts User; src/store/pg.ts
-- upsertUser/listUsers/getUser/findDmChannel). One row per real end user, captured from their SSO
-- token the first time they are seen and refreshed on every later sign-in. Powers DM target
-- selection and the roster / real-group display.
--
-- Deliberately standalone: member/actor/owner refs elsewhere stay bare text and are NOT FKed to
-- this table (0001/0002's convention) — a member_ref can be an agent id, not just a user sub, and
-- this directory is a discovery aid, not a referential-integrity authority. `groups` is a text[]
-- (the token's group claim, verbatim); `ins_seq bigserial` gives listUsers a stable creation-order
-- sort exactly the way it does for channels/agents in 0002 (created_at alone can tie within a ms).

BEGIN;

CREATE TABLE users (
  sub          text PRIMARY KEY,               -- Principal.sub — the IdP subject id, the directory key
  email        text,
  display_name text,
  groups       text[] NOT NULL DEFAULT '{}',   -- token group claim, verbatim
  last_seen_at timestamptz NOT NULL,
  ins_seq      bigserial
);

COMMIT;
