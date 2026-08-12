-- Widen execute_grants.scope for the coding strip's mode dropdown (see src/agent/gate.ts): `always`
-- (continual execution — every mutating tool until revoked) and `plan` (read-only mode — reads
-- allowed, mutations still gated). Migration 0002 constrained scope to ('once','turn'), so these
-- new modes failed the CHECK and surfaced as a 500. Recreate it to include both.
ALTER TABLE execute_grants DROP CONSTRAINT IF EXISTS execute_grants_scope_check;
ALTER TABLE execute_grants ADD CONSTRAINT execute_grants_scope_check CHECK (scope IN ('plan', 'once', 'turn', 'always'));
