-- SecChat migration 0015 — record the model that served an agent/assistant turn.
--
-- messages.model = the model SecRouter actually served for an agent/assistant message (captured
-- from the chat-completion response; may differ from the requested id when the request routes via
-- "auto"). Pure provenance METADATA — like prompted_by / parent_id, it is NOT bound into the
-- per-channel hash chain (src/audit/chain.ts computeMessageHash never reads it) and is stamped
-- once at INSERT (NULL for human messages, and when the response carried no model). No guard
-- change is needed: it's not a hash input, so it never joins the immutable chain-input set, and
-- the table's append-only UPDATE guard already blocks any post-hoc edit to it.

BEGIN;

ALTER TABLE messages ADD COLUMN model text;

COMMIT;
