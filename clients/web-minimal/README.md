# web-minimal — the dependency-free fallback client

A zero-dependency vanilla HTML/CSS/JS SecChat client (no framework, no build step, no external
assets — air-gap safe). Built in Sprint 6 and **kept as a minimal fallback**: useful where the
Flutter client is overkill or unavailable (locked-down kiosks, strict 508/no-canvas contexts,
smoke-testing the backend without a toolchain).

The primary client going forward is Flutter (`../../app`, web + desktop + mobile, one codebase).
The backend serves the Flutter build when present (`app/build/web`) and falls back to this client
otherwise — see `src/index.ts`. This client talks to the same HTTP + WS API and dev-auth.
