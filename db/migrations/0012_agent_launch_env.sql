-- SecChat migration 0012 — persist a coding agent's LAUNCH ENVIRONMENT (src/types.ts Agent.launchEnv;
-- src/agent/launch-env.ts). WHERE the agent's runner runs: 'desktop' (the owner's desktop daemon) or
-- 'pool' (a server-launched Kubernetes pod). Persisted so every (re)spawn of the same agent routes to
-- the SAME place — routing is per-AGENT, not per-owner, so a user can run a desktop agent and a pool
-- agent at the same time (src/agent/router-runner.ts). NULL ⇒ a legacy agent (created before this
-- column), which keeps the prior daemon-if-attached-else-server behavior.

ALTER TABLE agents ADD COLUMN launch_env text;
