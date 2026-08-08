# SecChat

Auditable **team chat + agentic chat** for CUI / air-gapped enclaves — the SecRouter suite's
purpose-built replacement for the Mattermost-based `secchat` and the LibreChat-based
`secassist`. One app: people talk to each other, spawn governed agents, and every message is
tamper-evidently logged.

> **Status: rearchitecture in progress** (this `rearchitecture` branch). The prior
> Mattermost stack lives on `main` until this reaches parity. See `docs/` for the design.

## Why it exists

- **Auditable by construction** — every message links into a per-channel SHA‑256 hash chain
  bound to the content *hash* (not the plaintext), plus a metadata-only audit chain. Tampering
  is detectable; CUI spillage is still purgeable (redaction removes plaintext, the chain
  stays verifiable).
- **Agents are first-class + governed** — spawn a SecAgent tied to you; it runs in *plan mode*
  by default, and only *you* can authorize code-executing work. Its model calls go through
  SecRouter, attributed and budgeted to you.
- **SSO from the ground up** — every session is a SecSSO (Authentik) session, validated via
  JWKS. No local passwords.

## Dependency policy (read before adding anything)

This is a supply-chain-conscious, CMMC/air-gap component. Dependencies are a **liability**, not
a convenience:

- **Runtime dependencies: `jose` only** (JWKS/JWT — security-focused, zero transitive deps),
  pinned to an exact version. WebSockets are implemented on the Node **standard library**.
  Postgres (`pg`) will be added — pinned, with its transitive tree vetted — when the data layer
  moves off the in-memory store; until then there is no `pg` import.
- **No web frameworks, no bundlers, no "utility" micro-packages.** Node 24 LTS + TypeScript
  (native type-stripping — no build step for dev) covers it.
- **Exact version pins, no floating ranges.** A committed lockfile is the source of truth.
- Adding *any* new package requires an explicit review of the package, its maintainer, and its
  entire transitive tree. When in doubt, use the standard library or write the ~100 lines.

## Toolchain

- **Node 24 LTS** (`engines: >=24`). TypeScript runs natively via Node's type-stripping — no
  compile step to run or test.
- `npm test` → `node --test` (the built-in runner; test files are `test/*.test.ts`).
- `npm run typecheck` → `tsc --noEmit`.

## Layout

```
src/
  types.ts        shared contracts (Principal, Store, Channel, Message, AuditEvent, …)
  config.ts       env-driven config (fails closed on missing secrets)
  audit/chain.ts  the tamper-evident hash chains (message + audit)
  store/          persistence behind the Store interface (memory now, Postgres later)
  auth/           SecSSO (Authentik) JWKS token verification
  http/           bare-Node HTTP server + routes
  ws/             stdlib WebSocket hub (realtime)
test/             node:test suites, one per module
db/migrations/    SQL schema (applied by the Postgres store when it lands)
```

## License

[Apache 2.0](LICENSE) — Copyright 2026 Austin Probe.
