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
import { makeInteractiveRunner } from "./agent/interactive-runner.ts";
import { makePiRunner } from "./agent/pi-runner.ts";
import { makeAuthGateway } from "./auth/bff.ts";
import { makeVerifyToken } from "./auth/jwks.ts";
import { loadConfig } from "./config.ts";
import { devVerifyToken } from "./dev/auth.ts";
import { searchMessages } from "./search/search.ts";
import { createHttpServer } from "./http/server.ts";
import { makeLlmClient } from "./secrouter/client.ts";
import { MemoryStore } from "./store/memory.ts";
import { PgStore } from "./store/pg.ts";
import { migrate } from "./db/migrate.ts";
import { attachWsHub } from "./ws/hub.ts";
import { FsBlobStore } from "./attachments/blobs.ts";
import type { Hub } from "./ws/hub.ts";
import type { Runner, SessionStore, Store } from "./types.ts";
import { fileURLToPath } from "node:url";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { delimiter as pathDelimiter, join as pathJoin } from "node:path";
import pg from "pg";
const { Pool } = pg;

/** Resolves a binary name (or path) to an executable file, searching `PATH` like a shell would —
 * used only to decide, at startup, whether the real pi runner is usable (see `selectRunner`
 * below). A relative/absolute path (contains "/" or starts with ".") is checked directly instead
 * of searched, matching normal shell lookup rules. Returns undefined rather than throwing — this
 * is a best-effort probe, never a hard requirement. */
function resolveBin(name: string): string | undefined {
  const candidates = name.includes("/")
    ? [name]
    : (process.env.PATH ?? "")
        .split(pathDelimiter)
        .filter((dir) => dir.length > 0)
        .map((dir) => pathJoin(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return undefined;
}

/** Picks the coding-agent Runner: the real pi runner (spawns the external `pi` CLI — see
 * agent/pi-runner.ts) when it's usable, else the interactive demo stub (agent/interactive-runner.ts).
 * "Usable" is `SECCHAT_PI_RUNNER=1` (explicit opt-in — trust the operator, fail loudly per-session
 * via pi-runner.ts's own spawn-error handling if PI_BIN turns out not to resolve after all) OR
 * `PI_BIN` (default `"pi"`) actually resolving on PATH right now. Either way the execute-gate
 * (plan-mode default, owner-authorized mutation) is identically real — only what's on the other
 * end of the Runner port changes. */
function selectRunner(): Runner {
  const piBin = process.env.PI_BIN?.trim() || "pi";
  const forced = (process.env.SECCHAT_PI_RUNNER?.trim() ?? "") === "1";
  const resolved = resolveBin(piBin);

  if (forced || resolved) {
    console.error(`▸ coding-agent runner: pi (${resolved ?? piBin}${forced && !resolved ? " — not found on PATH yet; SECCHAT_PI_RUNNER=1 forces it anyway" : ""})`);
    return makePiRunner();
  }
  console.error("▸ coding-agent runner: interactive demo stub (pi not found on PATH — set PI_BIN, install pi, or force with SECCHAT_PI_RUNNER=1)");
  return makeInteractiveRunner();
}

const config = loadConfig();
// In dev-mode (SECCHAT_DEV_MODE=1) accept `dev.<sub>.<groups>` tokens so the local web client
// works without a real IdP; production always verifies real SecSSO JWTs via JWKS.
const verifyToken = config.devMode ? devVerifyToken : makeVerifyToken(config);
if (config.devMode) console.error("! DEV MODE: dev tokens accepted + /admin open + web client served — never in production");
// The assistant path: model calls go through SecRouter, delegated to each agent's owner.
const llm = makeLlmClient(config);

// SSO login (OIDC BFF, see auth/bff.ts): the backend runs the Authorization Code + PKCE dance
// itself and issues an httpOnly session cookie — no OIDC token ever reaches the browser. Always
// built (not conditionally); makeAuthGateway itself degrades to 503-ing /auth/login|callback|
// logout (while still answering /auth/status truthfully) when config.ssoEnabled is false, so the
// bearer/dev-token path above keeps working unchanged either way.
const auth = makeAuthGateway(config);
console.error(
  config.ssoEnabled
    ? `▸ SSO login: enabled (OIDC BFF via ${config.oidcIssuer})`
    : "▸ SSO login: disabled (SECCHAT_OIDC_CLIENT_SECRET/PUBLIC_URL/SESSION_SECRET not all set) — bearer/dev tokens only",
);

// Durable Postgres store when DATABASE_URL is set (migrations applied on boot); else the
// in-memory store (dev/eval — state is lost on restart). Both implement Store + SessionStore.
let store: Store & SessionStore;
if (config.databaseUrl) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  await migrate(pool);
  store = new PgStore(pool);
  console.error(`▸ store: Postgres (${config.databaseUrl.replace(/\/\/[^@/]*@/, "//****@")})`);
} else {
  store = new MemoryStore();
  console.error("▸ store: in-memory (DATABASE_URL unset — dev/eval only, not durable)");
}

let hub: Hub | undefined;
const broadcast = (channelId: string, payload: unknown) => hub?.broadcast(channelId, payload);
// Coding-agent control plane (Sprint 5: the real pi runner). The execute-gate (plan-mode default,
// owner-authorized mutation) is fully real either way — selectRunner() only decides what's on the
// other end of the Runner port: the real pi CLI when it's usable, else the interactive demo stub
// (still handy for local dev without pi installed, or for exercising the gate without a model).
// Named (not inlined into makeControlPlane below) so the shutdown handler can stop every session's
// runner on the way out — unlike the demo runners, pi backs a session with a REAL OS process, and
// this is the one place that outlives the control plane's own lifecycle.
const runner = selectRunner();
const control = makeControlPlane({ sessions: store, runner, getAgent: (id) => store.getAgent(id), broadcast });

if (config.devMode && !config.databaseUrl) {
  // DEV ONLY (SECCHAT_DEV_MODE=1, in-memory only): seed so /admin + the client have sample data.
  // Skipped with a real DB so it doesn't accumulate duplicate rows on every restart.
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
  // Seed the directory so the DM picker has people to choose from in dev (in a real deployment
  // it fills as users sign in via SSO). A dev sign-in later refreshes the matching row's groups.
  for (const u of [
    { sub: "alice", displayName: "Alice Ng", email: "alice@example.mil", groups: ["secchat-admins", "eng"] },
    { sub: "bob", displayName: "Bob Reyes", email: "bob@example.mil", groups: ["eng"] },
    { sub: "carol", displayName: "Carol Diaz", email: "carol@example.mil", groups: ["security"] },
    { sub: "dave", displayName: "Dave Okafor", email: "dave@example.mil", groups: ["eng", "security"] },
  ]) {
    await store.upsertUser(u);
  }
  console.error("▸ dev seed loaded (SECCHAT_DEV_MODE=1) — visit /admin");
}

// Serve the Flutter build when it exists (the primary client — web/desktop/mobile, one codebase),
// else fall back to the archived dependency-free minimal client (clients/web-minimal).
const flutterWeb = fileURLToPath(new URL("../app/build/web", import.meta.url));
const minimalWeb = fileURLToPath(new URL("../clients/web-minimal", import.meta.url));
const webRoot = existsSync(`${flutterWeb}/index.html`) ? flutterWeb : minimalWeb;
if (config.devMode) console.error(`▸ web client: ${webRoot === flutterWeb ? "Flutter build" : "minimal JS (fallback)"} — ${webRoot}`);

const server = createHttpServer({
  verifyToken, store, llm, control, broadcast, auth,
  search: (userSub, q) => searchMessages(store, userSub, q),
  web: { root: webRoot },
  admin: { adminGroup: config.adminGroup, devMode: config.devMode, overview: () => buildOverview(store), renderConsole },
  marking: config.marking,
  dlp: config.dlp,
  capabilities: config.capabilities,
  stepUp: config.stepUp,
  attachments: { blobs: new FsBlobStore(config.uploadsDir), maxUploadBytes: config.maxUploadBytes },
});
hub = attachWsHub(server, {
  verifyToken,
  auth,
  // The channels a principal may receive events for — same membership filter as GET /channels.
  channelsForSub: async (sub) => {
    const mine: string[] = [];
    for (const c of await store.listChannels()) {
      if (await store.isMember(c.id, sub)) mine.push(c.id);
    }
    return mine;
  },
});

server.listen(config.port, config.host, () => {
  console.error(`▸ SecChat listening on http://${config.host}:${config.port} (in-memory store)`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    hub?.close();
    // Best-effort: stop every still-active session's runner so a real subprocess (pi) never
    // outlives this process as an orphan. Never blocks shutdown on it — a hung/slow runner.stop()
    // must not delay the exit any more than the SIGKILL fallback it already carries internally.
    void store
      .listActiveSessions()
      .then((sessions) => Promise.allSettled(sessions.map((s) => runner.stop(s.id))))
      .catch(() => {});
    server.close(() => process.exit(0));
  });
}
