-- Per-agent reasoning toggle: whether the agent's model runs with reasoning/thinking enabled.
-- For a coding agent it's passed to pi (the provider registration's reasoning capability); for an
-- assistant it can gate reasoning on the LLM call. NULL/false = off (the prior behaviour).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reasoning boolean;
