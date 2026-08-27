# SecChat — CMMC Level 2 Control Matrix

Maps SecChat (the chat application layer — channels, messages, coding/assistant agents, voice
calls) to **NIST SP 800-171 Rev 2** (CMMC L2, 110 requirements). This is *application-layer*
evidence for your System Security Plan (SSP) — it covers what this software enforces, not the
surrounding enclave (see [Shared Responsibility](#shared-responsibility)) — and it is **engineering
guidance, not a certification, assessment, or attestation**. Whether SecChat handles CUI at all is
your CUI determination to make.

SecChat never talks to an LLM endpoint directly — every assistant/coding-agent model call is
delegated to **SecRouter** (`src/secrouter/client.ts`), which owns egress allow-listing, per-request
classification gating, and provider-side audit. This document covers SecChat's own controls (access,
marking, DLP, audit, admin review); see SecRouter's `docs/compliance/cmmc-control-matrix.md` for the
model-egress controls it enforces.

Control citations follow the suite-wide style (spec B.5): table rows cite the bare **Family** + **ID**
(e.g. Family `AU`, ID `3.3.8`); prose uses the combined `FAMILY-ID` form (e.g. `AU-3.3.8`).

Status legend: ✅ enforced in code · ⚙️ configurable (opt-in) · 🤝 shared (environment/process) ·
⚠️ gap (not implemented — tracked below, never silently omitted).

## Access Control (AC)

| Family | ID | Requirement | Implementation | Evidence |
|---|---|---|---|---|
| AC | 3.1.1 / 3.1.2 | Limit system access to authorized users / transactions | Deny-by-default OIDC bearer/session auth on every route except `/healthz`, `/auth/*`, and the static SPA shell; privileged actions additionally gated by a named IdP-group capability policy | `src/auth/jwks.ts` (`makeVerifyToken`), `src/http/server.ts` (`createHttpServer`'s auth block), `src/auth/capabilities.ts` (`authorizeCapability`, `defaultCapabilityPolicy`) |
| AC | 3.1.3 | **Control the flow of CUI** | Classification-marking ladder (channel-as-portion + per-message portion folding) blocks a message whose marking exceeds its channel; local DLP scans every post; machine-authored output (assistant/coding-agent) gets the SAME governance via a dedicated append path, closing the historical LLM-output bypass | `src/marking/policy.ts` (`makeMarkingPolicy`), `src/marking/portions.ts` (`overallPortionMarking`), `src/dlp/policy.ts` (`DlpPolicy.scan`), `src/governance/append.ts` (`governedAgentAppend`) |
| AC | 3.1.5 | Least privilege | Per-capability group policy: redact/downgrade/webhook-create default to the admin group, agent-manage ungated by default — a deployment repoints any of them at another IdP group; step-up freshness stackable per capability | `src/auth/capabilities.ts` (`CapabilityPolicy`, `defaultCapabilityPolicy`) |
| AC | 3.1.11 | **Terminate a user session** | Logout clears SecChat's own httpOnly session cookie AND (when the IdP publishes `end_session_endpoint`) redirects through RP-initiated logout so the IdP's own SSO session ends too — a bare cookie-clear would leave the next `/auth/login` silently re-authenticating | `src/auth/bff.ts` (`handleLogout`) |
| AC | 3.1.20 | Control connections to external systems | Every external endpoint (SecRouter, mediad, transcribe, outbound webhooks) is explicit deployment config, never auto-discovered; outbound webhook destinations are additionally host-allow-listed | `src/config.ts` (`loadConfig`), `src/webhooks/outbound.ts` (`isAllowedOutboundUrl`) |
| AC | 3.1.4 / 3.1.6–3.1.10 / 3.1.12–3.1.19 / 3.1.21–3.1.22 | Separation of duties, session lock, mobile/wireless, boundary/remote-access monitoring, etc. | 🤝 environment / IdP responsibility — not implemented by this application | — |

## Audit and Accountability (AU)

| Family | ID | Requirement | Implementation | Evidence |
|---|---|---|---|---|
| AU | 3.3.1 / 3.3.2 | Create audit records traceable to individual users | Every audit event and every message carries `actor`/`authorRef` (+ `actAs` for a delegated agent turn); an admin-only read API surfaces the full trail | `src/audit/chain.ts` (`computeAuditHash`), `src/store/memory.ts` + `src/store/pg.ts` (`appendAudit`, `listAudit`) |
| AU | 3.3.1 (retention) | Retain audit records | ⚠️ **Gap** — no retention window or pruning job exists (unlike SecRouter's `security.audit.retentionDays`); the audit log and message chains grow unbounded in-process. Retention/archival is currently the environment's (Postgres backup + retention policy on the `audit_log`/`messages` tables) | 🤝 environment — see [Shared Responsibility](#shared-responsibility) |
| AU | 3.3.5 / 3.3.6 | Correlate audit records to support review, analysis, and reporting | An admin-gated review console (`GET /admin`, `GET /admin/api/overview`) surfaces channels/agents/sessions/audit/both chain verdicts in one snapshot; `GET /admin/api/audit/verify` gives a per-channel, per-seq detailed verdict for triage | `src/admin/gate.ts` (`isAdmin`), `src/admin/overview.ts` (`buildOverview`), `src/admin/verify.ts` (`buildAuditVerify`), `src/http/server.ts` (`GET /admin`, `/admin/api/overview`, `/admin/api/audit/verify`) |
| AU | 3.3.7 | Authoritative, time-synced timestamps | UTC ISO-8601 (`new Date().toISOString()`) on every audit event and message; host NTP is 🤝 | `src/store/memory.ts` / `src/store/pg.ts` (`appendAudit`, `appendMessage`) |
| AU | 3.3.8 | **Protect audit information** (tamper-evidence) | TWO independent SHA-256 hash chains: a metadata-only global audit chain (who did what) and a per-channel MESSAGE chain binding `contentSha256` + the classification `marking` (so a spillage purge can drop plaintext while the chain still verifies, and a silently-altered marking breaks the chain). Both re-verifiable on demand | `src/audit/chain.ts` (`computeAuditHash`, `computeMessageHash`, `verifyAuditChain`, `verifyMessageChain`), `src/admin/verify.ts` (`buildAuditVerify`), `GET /admin/api/audit/verify` |
| AU | 3.3.9 | Limit audit management to a subset of users | Every `/admin/api/*` route (including both new endpoints) requires membership in the configured admin group | `src/admin/gate.ts` (`isAdmin`), `src/http/server.ts` admin routes |
| — | **CUI-safe logging** | Audit records are metadata only — actor, action, target, hashes, counts — never message/prompt/completion content; DLP records rule NAMES only, never the matched text | `src/audit/chain.ts` header contract, `src/dlp/policy.ts` (`DlpPolicy.scan`) |

## Identification and Authentication (IA)

| Family | ID | Requirement | Implementation | Evidence |
|---|---|---|---|---|
| IA | 3.5.1 / 3.5.2 | Identify & authenticate users | OIDC bearer JWT verified against SecSSO's JWKS (signature/`iss`/`aud`/`exp`), or an httpOnly session cookie minted by the same OIDC flow (Authorization Code + PKCE, server-side — no OIDC token ever reaches the browser) | `src/auth/jwks.ts` (`makeVerifyToken`), `src/auth/bff.ts` (`makeAuthGateway`) |
| IA | 3.5.3 | **Multifactor authentication** | Full-login MFA is the IdP's (SecSSO/Authentik) — 🤝. SecChat additionally requires a FRESH re-authentication ("step-up") for capabilities configured to need one, independent of session age | 🤝 IdP; `src/auth/stepup.ts` (`makeStepUp`), `src/http/server.ts` (`stepUpAge`, `enforceCapability`) |
| IA | 3.5.4 | Replay-resistant authentication | Short-lived signed tokens (OIDC JWT `exp`/`nbf`; step-up and runner tokens both TTL-bound) verified over TLS | `src/auth/jwks.ts`, `src/auth/stepup.ts`, `src/auth/runner-token.ts` |
| IA | 3.5.10 | Cryptographically-protected secrets | No passwords in SecChat (delegated to the IdP); per-user git SSH private keys are AES-256-GCM-encrypted at rest under a deployment master key, never stored or logged in plaintext | `src/ssh/keys.ts` (`deriveSecretKey`, `encryptSecret`, `decryptSecret`) |

## Media Protection (MP)

| Family | ID | Requirement | Implementation | Evidence |
|---|---|---|---|---|
| MP | 3.8.2 | **Mark CUI media** and limit access to authorized users | The classification-marking ladder is a deployment posture (levels + default + CUI caveats); a marked channel IS the portion ceiling, rendered as a banner, enforced server-side (client marking is advisory) | `src/marking/policy.ts` (`makeMarkingPolicy`, `MARKING_PROFILES`), `src/marking/caveats.ts` (`dominates`, `formatMarking`) |
| MP | — (content scanning) | Detect sensitive data before it leaves the authoring boundary | Local, on-premise DLP scanner (regex rules, never sent to the client) runs on every human post AND every machine-authored append; `flag` (default) audits + alerts live, `block` refuses the post — either way only rule NAMES are ever recorded, never the matched text | `src/dlp/policy.ts` (`DlpPolicy`, `DEFAULT_DLP_RULES`), `src/governance/append.ts` (`governedAgentAppend`) |
| MP | 3.8.1 | Protect CUI media at rest | Attachment bytes are content-addressed (SHA-256) on a local/PV-backed filesystem store; message/audit content lives in Postgres. Neither is application-level-encrypted — at-rest encryption is provided by volume/disk encryption (🤝, the same accepted-baseline pattern as the rest of the suite) | `src/attachments/blobs.ts` (`FsBlobStore`, `sha256Hex`); 🤝 environment |
| MP | 3.8.9 | Protect backups of CUI | 🤝 environment — Postgres backup/retention policy (see [Shared Responsibility](#shared-responsibility)) | — |

## System and Communications Protection (SC)

| Family | ID | Requirement | Implementation | Evidence |
|---|---|---|---|---|
| SC | 3.13.6 | **Deny network traffic by default** (LLM egress) | SecChat never calls a model endpoint directly — the assistant path and the coding-agent's `/agent-llm/v1` proxy both forward to SecRouter, which owns the egress allow-list and classification gate. Delegated, not reimplemented | `src/secrouter/client.ts` (`makeLlmClient`), `src/http/server.ts` (`handleAgentLlmProxy`); see SecRouter's own control matrix for the enforcement itself |
| SC | 3.13.8 | Encrypt CUI in transit | 🤝 front-end/reverse-proxy TLS termination — SecChat itself speaks plain HTTP (`node:http`), matching SecRouter's supported "frontend" TLS mode. `publicUrl` being `https://` gates the session cookie's `Secure` flag | 🤝 environment; `src/config.ts` (`Config.publicUrl`), `src/auth/session.ts` (cookie `Secure`) |
| SC | 3.13.11 | FIPS-validated cryptography | ⚠️ **Gap** — unlike SecRouter/secagent, SecChat has no startup `assertFips()`-style check. It exclusively uses FIPS-approvable primitives via `node:crypto` (SHA-256 for both hash chains, AES-256-GCM for SSH-key envelopes), but nothing enforces a FIPS-validated OpenSSL build is actually in use | 🤝 environment must supply a FIPS-validated Node/OpenSSL build if FIPS attestation is required |
| SC | 3.13.15 | Session authenticity | Signed OIDC JWTs / session cookies (HS256) with `exp`; step-up and runner tokens are separately-scoped, separately-keyed signed tokens (a captured one can't be replayed as the other) | `src/auth/session.ts`, `src/auth/stepup.ts`, `src/auth/runner-token.ts` |
| SC | 3.13.16 | Protect CUI at rest | Per-user git SSH private keys: AES-256-GCM envelope under a dedicated deployment master key (never the session secret) | `src/ssh/keys.ts` (`encryptSecret`) |

## Configuration Management (CM)

| Family | ID | Requirement | Implementation | Evidence |
|---|---|---|---|---|
| CM | 3.4.1 / 3.4.2 | Baseline configuration; enforce security settings | Typed `Config` built once at startup; a missing REQUIRED value (OIDC issuer/audience, etc.) throws immediately — fails closed rather than booting silently insecure. Optional features (pool, SSH keys, voice/mediad, SSO) are present only when their full env is set, never partially | `src/config.ts` (`loadConfig`, `req`) |
| CM | 3.4.6 / 3.4.7 | Least functionality; disable nonessential services | Every optional subsystem (K8s pool, one-shot pool tasks, per-user SSH identities, voice calling/mediad, transcription, outbound webhooks) is OFF unless its full config is present, and each route reports a clean 404/503 rather than a partial/undefined behavior when its dependency is unset | `src/http/server.ts` (`AdminDeps`/route guards throughout), `src/config.ts` |

## Shared Responsibility

SecChat enforces the application layer described above. The accreditation boundary must also
provide:

- **Postgres backups & retention** — the durable store (`PgStore`, used when `DATABASE_URL` is
  set) holds channels/messages/audit/agents; backup cadence, encryption, and **audit-record
  retention** (AU-3.3.1 — SecChat itself has no pruning job, unlike SecRouter's
  `security.audit.retentionDays`) are the environment's to configure and enforce.
- **SecSSO identity** (IA-3.5.1–3.5.4) — the enterprise OIDC IdP (Authentik) backing every login:
  MFA/CAC enforcement, `groups` claims, JWKS rotation, and session/account lifecycle all live there,
  not in SecChat.
- **SecRouter LLM governance** (AC-3.1.3, SC-3.13.6) — every model call SecChat makes is delegated
  to SecRouter's egress allow-list, classification gate, and provider-side audit; SecChat carries no
  independent model-egress enforcement of its own. See SecRouter's control matrix for that coverage.
- **Enclave / network** (3.13.1/3.1.x) — host-based firewall, network segmentation, and TLS
  termination in front of SecChat's plain-HTTP listener.
- **FIPS module** (3.13.11) — a Node build linked to a CMVP-validated OpenSSL FIPS provider, or a
  FIPS-validated TLS front end, if FIPS attestation is required (SecChat does not assert this itself
  today — see the SC-3.13.11 gap above).
- **Volume/disk encryption** (MP-3.8.1/SC-3.13.16) — at-rest encryption for the Postgres data
  directory and the attachments filesystem store; SecChat's own application-level encryption is
  limited to the SSH-key envelope.
- **NTP** (AU-3.3.7) — host time sync so every timestamp in the audit trail is authoritative.

## Verification

```bash
npm run typecheck                      # clean build across src/ + test/
npm test                                # full backend suite, including:
node --test test/audit.test.ts          # chain primitives: valid/tampered/reordered/redacted
node --test test/admin-overview.test.ts # buildOverview snapshot + both chain verdicts
node --test test/admin.exit.test.ts     # admin console gating end-to-end
node --test test/admin-audit-evidence.test.ts  # NEW: /admin/api/audit/verify + /admin/api/evidence
```

Tamper-evidence can be re-verified at any time via `GET /admin/api/audit/verify` (admin-gated) —
any tampered message or audit row is reported with the exact channel/seq where the chain broke. A
full CMMC evidence bundle (this posture + the last 200 audit events + a live control
self-assessment) is downloadable via `GET /admin/api/evidence`.
