# Security model

## Authentication (SecSSO BFF)

Two accepted credential shapes, both rooted in SecSSO (Authentik):

- **Bearer JWT** — a SecSSO-issued OIDC access token, verified against SecSSO's JWKS (signature,
  `iss`, `aud`, `exp`) by `src/auth/jwks.ts`. This is the only path when the login BFF isn't
  configured.
- **Session cookie (BFF)** — `src/auth/bff.ts` runs the Authorization Code + PKCE flow itself
  server-side and mints its own httpOnly session cookie (`src/auth/session.ts`); the OIDC token
  never reaches the browser. This is a **deliberately separate trust domain** from the bearer path
  above: the session cookie is a self-issued, self-verified HS256 JWT (`iss`/`aud` = `"secchat"`),
  disjoint keys/algorithm from anything SecSSO signs — a real SecSSO token can never be replayed as
  a session cookie, and vice versa. Enabled only once `SECCHAT_OIDC_CLIENT_SECRET`,
  `SECCHAT_PUBLIC_URL`, and `SECCHAT_SESSION_SECRET` are all set (see
  [configuration.md](configuration.md#sso-login-oidc-bff)); `GET /auth/status` reports which mode
  is live so the client shows the right login UI.
- **Logout** clears the session cookie and, when the IdP publishes `end_session_endpoint`,
  redirects through RP-initiated logout so the IdP's own SSO session actually ends too — not just
  a local cookie clear.

Dev-only escape hatch: `SECCHAT_DEV_MODE=1` accepts synthetic `dev.<sub>.<groups>` tokens with no
real IdP — never enable this outside local development.

## Privileged capabilities + step-up

Four gated actions (`src/auth/capabilities.ts`): `message.redact`, `marking.downgrade`,
`webhook.create` (default: the admin group), and `agent.manage` (default: ungated — any member may
run their own coding agent). Each capability independently combines:

1. **Group membership** — from the verified token's `groups` claim; empty group ⇒ no gate.
2. **Step-up freshness** — an optional maximum re-authentication age. `POST /auth/stepup` forces a
   fresh IdP login (`prompt=login`, `max_age=0`) and mints a short-lived, separately-keyed step-up
   token (`src/auth/stepup.ts`) whose `iss`/`aud` (`"secchat-stepup"`) again make it unreplayable as
   either a session cookie or a bearer token, even when the same secret backs more than one of
   them.

Both dimensions are configured per capability — see
[configuration.md](configuration.md#privileged-capabilities--step-up).

## Tamper-evident hash chains

Two independent SHA-256 chains (`src/audit/chain.ts`), both re-verifiable on demand
(`GET /admin/api/audit/verify`, admin-gated):

- **The audit chain** — a metadata-only, suite-wide log of who did what (actor, action, target,
  `actAs` for a delegated agent turn). Never message content.
- **The per-channel message chain** — binds `contentSha256` (the content **hash**, not the
  plaintext) plus the message's classification `marking` into the chain. This is why redaction can
  purge plaintext (a CUI spillage cleanup) while the chain still verifies unbroken, and why a
  silently altered marking breaks the chain — the marking is bound into the same tamper-evidence
  as the content.

`GET /admin/api/evidence` bundles a chain-verify result, a sanitized config posture, the last 200
audit events, and a live control self-assessment into one CMMC evidence download — see
[compliance/cmmc-control-matrix.md](compliance/cmmc-control-matrix.md) for the full control
mapping and what's shared with the surrounding environment (e.g. audit retention, at-rest volume
encryption, FIPS).

## Marking & DLP

- **Classification marking** (`src/marking/policy.ts`) is an ordered ladder (low→high), a
  deployment posture (`SECCHAT_MARKING_PROFILE`/`_LEVELS`/`_DEFAULT`/`_CATEGORIES`). A channel may
  carry a marking — when it does, the channel *is* the portion ceiling for every message in it;
  an unmarked channel or a DM takes per-message marking instead, folded up from inline `(CUI)`/`(U)`
  portion tokens. Enforcement is server-side and by rank: content may never land in a channel whose
  ceiling is lower than its own marking (a blocking spillage check), and *lowering* a marking
  (`marking.downgrade`) is itself a gated, audited act.
- **Local DLP** (`src/dlp/policy.ts`) is an on-premise regex scanner run on every post — human or
  machine. `flag` (default) posts + records an audited `message.dlp_flag` (rule **name** only,
  never the matched text — exposing the pattern or the hit would help evade it); `block` refuses
  the post outright (422). Rules are never sent to the client.
- **Machine-authored output gets the same governance as a human post.** `src/governance/append.ts`
  is the dedicated path the assistant and coding-agent flows append through — historically, model
  output bypassed marking/DLP entirely by writing straight to the store; this closes that gap.
  Output that would exceed a channel's marking ceiling, or that DLP blocks, is withheld with a
  clean in-channel notice (never silently dropped, never leaked via the live broadcast).

## Governed LLM path (acting-user attribution)

SecChat never calls a model endpoint directly. Every assistant turn and every coding agent's
`/agent-llm/v1` proxy call forwards to **SecRouter**, and every one of those calls carries
`X-Sec-Acting-User: <owner's sub>` (`src/secrouter/client.ts`, `src/http/server.ts`'s
`handleAgentLlmProxy`) — set unconditionally, regardless of who or what prompted the turn. This
means SecRouter's own policy, budget, and audit land on the actual human owner, never on a bare
SecChat service identity: a coding agent burns *its owner's* budget, and a policy denial at
SecRouter is a denial of *that user*, not of SecChat as a whole. SecRouter's own egress allow-list
and classification gate are the enforcement point; SecChat carries no independent model-egress
control of its own (see SecRouter's control matrix for that coverage).

## Per-user git SSH keys & the coding-agent execute-gate

Covered in depth in [git-ssh-keys.md](git-ssh-keys.md) and [runner-daemon.md](runner-daemon.md):
private keys are AES-256-GCM-encrypted at rest under a dedicated master key
(`SECCHAT_SECRET_KEY`) and never leave the server in plaintext; a coding agent's mutating tool
calls always require the owner's explicit, live grant, evaluated on the server regardless of
where the runner itself executes (desktop daemon or pool pod).
