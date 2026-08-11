# Per-user git SSH keys

SecChat can give each user a **git SSH identity** — an ed25519 keypair — and inject it into their
**coding-agent runtimes** so `git` inside a coding session authenticates as them against the enclave
git host. The user never handles the private key: SecChat generates it, holds it encrypted, and hands
it to the runtimes the user owns (their online-pool pod and their desktop runner daemon).

This is the credential half of the **optional Kubernetes agent pool** — the pool runs coding agents
server-side, and those pods need git auth that isn't a shared secret. It works the same way for the
desktop daemon.

```
profile ──POST /me/ssh-key──► SecChat generates ed25519
                              stores PRIVATE key AES-256-GCM-encrypted (SECCHAT_SECRET_KEY)
                              returns PUBLIC key + fingerprint  ──► user adds it to the git host

coding session spawns ──► control plane decrypts the owner's key
                          ──► injects it into the runner (pool pod / desktop daemon)
                          ──► git authenticates as the owner
```

## Security model

- **The private key is never stored in plaintext.** It is wrapped in an AES-256-GCM envelope
  (`v1.<iv>.<tag>.<ciphertext>`) before it reaches the store; the database row holds only that opaque
  blob (`user_ssh_keys.private_key_enc`). Authenticated encryption — a wrong key or tampered ciphertext
  fails closed rather than returning garbage.
- **The at-rest key is a dedicated deployment secret.** `SECCHAT_SECRET_KEY` is folded to a 256-bit key
  with SHA-256. It is deliberately **separate** from the session-cookie secret: SSH keys are long-lived
  credentials, so their at-rest key isn't the short-lived cookie signer. **No master key ⇒ the feature
  is off** (the routes 503, nothing is injected) — never a guessable fallback.
- **The private key never leaves the server via any API.** Every route returns only
  `{ keyType, publicKey, fingerprint, createdAt }`.
- **Injected only into runtimes the user owns**, keyed on the agent's `ownerSub`. It rides the authed
  `/runner` channel (TLS via secproxy) to a remote daemon and is written to an **ephemeral per-session**
  key file (`chmod 0600`) that is torn down when the session ends; `GIT_SSH_COMMAND` points git at it
  with `IdentitiesOnly=yes` so no other key is offered.
- **Rotation / revocation.** Regenerating replaces the key (the old one stops working everywhere it was
  added); `DELETE` revokes it. Both are recorded on the audit chain (`ssh_key.generate` /
  `ssh_key.revoke`) — the fingerprint as metadata, never the key.
- **Threat model caveat.** As with any at-rest encryption the app must be able to reverse, a combined
  compromise of `SECCHAT_SECRET_KEY` *and* the database recovers the keys. The derivation can later be
  swapped to a KMS/HSM-held key without a schema change (the stored blob stays opaque).

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECCHAT_SECRET_KEY` | *(unset ⇒ feature off)* | Master secret for encrypting SSH private keys at rest. Use a long, high-entropy value. Required to enable per-user SSH keys. |
| `SECCHAT_GIT_KNOWN_HOSTS` | *(unset)* | Pinned `known_hosts` content for the enclave git host(s), injected into runtimes so git verifies the host key strictly. Unset ⇒ `StrictHostKeyChecking=accept-new` (trust-on-first-use, which still pins after the first connect). |

## Routes

All under the caller's own identity (there is no cross-user access):

- `POST /me/ssh-key` — generate, or **regenerate** (replacing the prior key). Returns the public key +
  fingerprint. `503` when the feature is off.
- `GET /me/ssh-key` — the current public key + fingerprint, or `404` if none. `503` when off.
- `DELETE /me/ssh-key` — revoke. `200 {removed:true}` / `404 {removed:false}`.

## Using it

1. In the app, open **Git SSH key** (the key icon in the top bar) and **Generate**.
2. **Copy the public key** and add it to your account on the enclave git host (e.g. as an authorized SSH
   key), exactly as you would a laptop key.
3. Spawn a coding agent (online pool or desktop). Inside its session, `git clone` / `push` over SSH to
   the enclave host authenticates as you — no per-agent credential setup.

The key is per **user**, not per agent, so it is reused across every coding session you run.
