-- Pool analysis sidecars per agent: which analyzer containers attach to the agent's pod
-- (names from the deployment's SECCHAT_POOL_ANALYSIS_IMAGES catalog), and whether the pod may
-- reach the internet (the open-egress pod label; DEFAULT OFF — NULL/false keeps the restricted
-- egress allowlist).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS analysis text[];
ALTER TABLE agents ADD COLUMN IF NOT EXISTS analysis_egress boolean;
