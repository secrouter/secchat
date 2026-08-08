// Process entrypoint — the ONE place the concrete modules are wired together (everything else
// takes its dependencies by injection). Config → JWKS verifier → Store → HTTP server → WS hub.
//
// The HTTP layer and the WS hub have a mutual reference (a posted message must fan out to
// subscribers), resolved here without a cycle: the server is created with a `broadcast` closure
// that reads `hub` lazily, and `hub` is assigned immediately after. By the time any request can
// fire, both exist.

import { buildOverview } from "./admin/overview.ts";
import { renderConsole } from "./admin/console.ts";
import { makeControlPlane } from "./agent/control.ts";
import { makeEchoRunner } from "./agent/echo-runner.ts";
import { makeVerifyToken } from "./auth/jwks.ts";
import { loadConfig } from "./config.ts";
import { devVerifyToken } from "./dev/auth.ts";
import { searchMessages } from "./search/search.ts";
import { createHttpServer } from "./http/server.ts";
import { makeLlmClient } from "./secrouter/client.ts";
import { MemoryStore } from "./store/memory.ts";
import { attachWsHub } from "./ws/hub.ts";
import type { Hub } from "./ws/hub.ts";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const config = loadConfig();
// In dev-mode (SECCHAT_DEV_MODE=1) accept `dev.<sub>.<groups>` tokens so the local web client
// works without a real IdP; production always verifies real SecSSO JWTs via JWKS.
const verifyToken = config.devMode ? devVerifyToken : makeVerifyToken(config);
if (config.devMode) console.error("! DEV MODE: dev tokens accepted + /admin open + web client served — never in production");
// The assistant path: model calls go through SecRouter, delegated to each agent's owner.
const llm = makeLlmClient(config);

// Sprint 1 uses the in-memory store (state is lost on restart). The Postgres store lands in
// Sprint 2 behind the same `Store` interface; until then DATABASE_URL is accepted but unused.
if (config.databaseUrl) {
  console.error("! DATABASE_URL is set but the Postgres store isn't wired yet (Sprint 2) — using the in-memory store");
}
const store = new MemoryStore();

let hub: Hub | undefined;
const broadcast = (channelId: string, payload: unknown) => hub?.broadcast(channelId, payload);
// Coding-agent control plane. The echo runner is a dev stand-in until a real pi runner lands
// (Sprint 5); the execute-gate (plan-mode default, owner-authorized mutation) is fully real.
const control = makeControlPlane({ sessions: store, runner: makeEchoRunner(), getAgent: (id) => store.getAgent(id), broadcast });

if (config.devMode) {
  // DEV ONLY (SECCHAT_DEV_MODE=1): seed the in-memory store so /admin has something to show.
  // Never runs in a real deployment (in-memory store + no real login is dev-only anyway).
  const gen = await store.createChannel({ workspaceId: "ws-dev", kind: "human", name: "general", createdBy: "alice" });
  await store.addMember({ channelId: gen.id, memberRef: "alice", memberType: "user", role: "owner" });
  await store.appendAudit({ actor: "alice", action: "channel.create", target: gen.id });
  await store.appendMessage({ channelId: gen.id, authorRef: "alice", authorType: "user", content: "morning all" });
  const spill = await store.appendMessage({ channelId: gen.id, authorRef: "bob", authorType: "user", content: "pasted the CUI doc here by mistake" });
  await store.redactMessage(spill.id, "admin", "CUI spillage — wrong channel");
  const asst = await store.createAgent({ ownerSub: "alice", kind: "assistant", name: "Research Assistant", model: "balanced" });
  const asstCh = await store.createChannel({ workspaceId: "ws-dev", kind: "agent", name: "alice · assistant", createdBy: "alice" });
  await store.addMember({ channelId: asstCh.id, memberRef: "alice", memberType: "user", role: "owner" });
  await store.addMember({ channelId: asstCh.id, memberRef: asst.id, memberType: "agent", role: "member" });
  await store.appendAudit({ actor: "alice", action: "agent.spawn", target: asst.id });
  const coder = await store.createAgent({ ownerSub: "bob", kind: "coding", name: "Build Bot" });
  const coderCh = await store.createChannel({ workspaceId: "ws-dev", kind: "agent", name: "bob · coding", createdBy: "bob" });
  await store.addMember({ channelId: coderCh.id, memberRef: "bob", memberType: "user", role: "owner" });
  await store.addMember({ channelId: coderCh.id, memberRef: coder.id, memberType: "agent", role: "member" });
  await store.appendAudit({ actor: "bob", action: "agent.spawn", target: coder.id });
  await control.spawn({ agent: coder, channelId: coderCh.id, hostType: "server" });
  console.error("▸ dev seed loaded (SECCHAT_DEV_MODE=1) — visit /admin");
}

// Serve the Flutter build when it exists (the primary client — web/desktop/mobile, one codebase),
// else fall back to the archived dependency-free minimal client (clients/web-minimal).
const flutterWeb = fileURLToPath(new URL("../app/build/web", import.meta.url));
const minimalWeb = fileURLToPath(new URL("../clients/web-minimal", import.meta.url));
const webRoot = existsSync(`${flutterWeb}/index.html`) ? flutterWeb : minimalWeb;
if (config.devMode) console.error(`▸ web client: ${webRoot === flutterWeb ? "Flutter build" : "minimal JS (fallback)"} — ${webRoot}`);

const server = createHttpServer({
  verifyToken, store, llm, control, broadcast,
  search: (userSub, q) => searchMessages(store, userSub, q),
  web: { root: webRoot },
  admin: { adminGroup: config.adminGroup, devMode: config.devMode, overview: () => buildOverview(store), renderConsole },
});
hub = attachWsHub(server, { verifyToken });

server.listen(config.port, config.host, () => {
  console.error(`▸ SecChat listening on http://${config.host}:${config.port} (in-memory store)`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    hub?.close();
    server.close(() => process.exit(0));
  });
}
