-- Execute grants are now keyed to the AGENT, not the ephemeral session.
--
-- The execute mode the owner picks (plan / once / continual) is a property of the AGENT: it must
-- survive a session respawn (a coding session is reaped on lease expiry / pi exit / restart and
-- comes back with a NEW id). Keyed to the session, the owner's mode silently vanished on every
-- respawn, and a UI holding a stale session id wrote grants to a dead session the gate never read —
-- so "changing the mode in the UI stopped affecting the backend gate." Re-key to agent_id.
--
-- Old grants are transient authorization state, not history worth migrating, so agent_id is left
-- NULL on any pre-existing rows (they'll never match an agent lookup) and session_id is kept
-- (nullable) only so this migration is non-destructive.

ALTER TABLE execute_grants ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE execute_grants ALTER COLUMN session_id DROP NOT NULL;

-- The hot path: the newest non-consumed grant for an agent (agent/gate.ts's evaluateTool).
CREATE INDEX IF NOT EXISTS execute_grants_agent_active_idx
  ON execute_grants (agent_id, id DESC) WHERE consumed = false;
