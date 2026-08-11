-- A coding agent may mount a local directory (on its runner daemon's host) as its pi workspace —
-- e.g. the user's repo — chosen at launch. NULL ⇒ a private per-agent scratch workspace.
ALTER TABLE agents ADD COLUMN workspace text;
