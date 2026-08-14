-- SecChat migration 0015 — admit 'pool' as an agent_sessions host_type. The Kubernetes agent pool
-- (docs/agent-pool.md) labels its sessions hostType "pool" (src/http/server.ts deriveHostType;
-- src/types.ts AgentSession), but the CHECK from 0002_parity.sql predates the pool and only allowed
-- ('server','local') — so spawning a pool agent's session violated the constraint and POST /agents
-- 500'd AFTER the agent+channel rows were committed (the in-memory store has no CHECKs, which is why
-- tests never caught it).

ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_host_type_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_host_type_check
  CHECK (host_type IN ('server', 'local', 'pool'));
