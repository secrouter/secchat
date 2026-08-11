-- SecChat migration 0011 — per-user git SSH identities (src/types.ts UserSshKey; src/ssh/keys.ts;
-- routes POST/GET/DELETE /me/ssh-key). One ed25519 keypair per user, minted server-side so it can be
-- INJECTED into the agentic runtimes (the Kubernetes agent pool pod and the desktop runner daemon)
-- for git authentication — the user never handles the private key.
--
-- The private half is stored ONLY as `private_key_enc`: an AES-256-GCM envelope of the OpenSSH
-- private key under the deployment master key (SECCHAT_SECRET_KEY). Plaintext is never persisted and
-- the private key is NEVER returned by the API (routes project to public_key + fingerprint). One row
-- per user, keyed on `sub` — regenerating a key REPLACES the row (ON CONFLICT upsert).
--
-- Standalone like the users directory (0003): `sub` is not FKed — the same bare-text-ref convention
-- as members/actors elsewhere, and a key may be minted for a principal before any other row exists.

BEGIN;

CREATE TABLE user_ssh_keys (
  sub             text PRIMARY KEY,          -- owner (Principal.sub) — one key per user
  key_type        text NOT NULL,             -- "ssh-ed25519"
  public_key      text NOT NULL,             -- authorized_keys line ("ssh-ed25519 AAAA... <comment>")
  fingerprint     text NOT NULL,             -- "SHA256:..." (matches ssh-keygen -lf)
  private_key_enc text NOT NULL,             -- AES-256-GCM envelope of the OpenSSH private key
  created_at      timestamptz NOT NULL
);

COMMIT;
