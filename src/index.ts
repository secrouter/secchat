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
import { startReaper } from "./agent/reaper.ts";
import { governedAgentAppend } from "./governance/append.ts";
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
import { makeOutboundDispatcher } from "./webhooks/outbound.ts";
import { migrate } from "./db/migrate.ts";
import { attachWsHub } from "./ws/hub.ts";
import { attachRunnerHub } from "./ws/runner-hub.ts";
import { RunnerRegistry } from "./agent/runner-registry.ts";
import { makeRemoteRunner } from "./agent/remote-runner.ts";
import { makeRouterRunner } from "./agent/router-runner.ts";
import { makePoolRunner, type PoolRunner } from "./agent/pool-runner.ts";
import { inClusterNamespace, inClusterRequest, makeK8sClient } from "./agent/k8s.ts";
import { FsBlobStore } from "./attachments/blobs.ts";
import { decryptSecret } from "./ssh/keys.ts";
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
// Per-user realtime delivery (the @mention path) — reaches every socket of one principal regardless
// of which channel they have open. Like `broadcast`, resolved lazily so the server can be created
// before the hub (which needs the server) — see the note above.
const notify = (sub: string, payload: unknown) => hub?.deliverToUser(sub, payload);
// Presence roster (who's online) — reads the hub's live connection set for GET /presence; the live
// online/offline transitions ride the hub's own `presence` broadcasts.
const presence = () => hub?.onlineSubs() ?? [];
// Coding-agent control plane (Sprint 5: the real pi runner). The execute-gate (plan-mode default,
// owner-authorized mutation) is fully real either way — selectRunner() only decides what's on the
// other end of the Runner port: the real pi CLI when it's usable, else the interactive demo stub
// (still handy for local dev without pi installed, or for exercising the gate without a model).
// Named (not inlined into makeControlPlane below) so the shutdown handler can stop every session's
// runner on the way out — unlike the demo runners, pi backs a session with a REAL OS process, and
// this is the one place that outlives the control plane's own lifecycle.
const serverRunner = selectRunner();
// Remote runner daemons attach over `/runner` (see attachRunnerHub below) and register by owner.
// The router sends a session to the owner's daemon when one is attached, else to the in-process
// server runner. A daemon's heartbeat renews its sessions' leases so the orphan reaper doesn't cull
// a healthy remote session.
const runnerRegistry = new RunnerRegistry();
const remoteRunner = makeRemoteRunner({
  registry: runnerRegistry,
  renewLease: (sessionId) => void store.renewLease(sessionId, new Date(Date.now() + 60_000).toISOString()).catch(() => {}),
});
// Optional Kubernetes agent pool: an agent whose launchEnv is "pool" runs in a server-launched pod
// (running the runnerd image) that attaches back at /runner?pool=<sessionId>. Enabled only when a pool
// image AND a runner-token minter are configured (the pod attaches as the owner with a minted token).
let poolRunner: PoolRunner | undefined;
if (config.pool && config.runnerToken) {
  const namespace = config.pool.namespace || inClusterNamespace() || "secchat-pool";
  const k8s = makeK8sClient({ namespace, request: inClusterRequest(config.pool.apiServer) });
  poolRunner = makePoolRunner({
    k8s,
    config: config.pool,
    mintRunnerToken: (sub) => config.runnerToken!.mint(sub),
    renewLease: (sessionId) => void store.renewLease(sessionId, new Date(Date.now() + 60_000).toISOString()).catch(() => {}),
  });
  console.error(`▸ agent pool: enabled (namespace ${namespace}, image ${config.pool.image})`);
} else if (config.pool && !config.runnerToken) {
  console.error("▸ agent pool: SECCHAT_POOL_IMAGE is set but no runner-token secret (SECCHAT_RUNNER_TOKEN_SECRET / session secret) — pool DISABLED");
}
const runner = makeRouterRunner({ server: serverRunner, remote: remoteRunner.runner, pool: poolRunner?.runner, hasRemote: (sub) => runnerRegistry.has(sub) });
// Per-user git SSH identity injection (K8s pool / desktop daemon): when a master key is configured
// (config.secretKey), resolve the spawning owner's key, decrypt the private half, and hand it to
// their runner so `git` in the coding session authenticates as them. Undefined when the feature is
// off — no key is ever injected. Only the owner's OWN key is fetched (keyed on ownerSub).
const getGitSsh = config.secretKey
  ? async (ownerSub: string) => {
      const row = await store.getUserSshKey(ownerSub);
      if (!row) return undefined;
      const privateKey = decryptSecret(row.privateKeyEnc, config.secretKey!);
      return { privateKey, publicKey: row.publicKey, ...(config.gitKnownHosts ? { knownHosts: config.gitKnownHosts } : {}) };
    }
  : undefined;
const control = makeControlPlane({
  sessions: store,
  runner,
  getAgent: (id) => store.getAgent(id),
  broadcast,
  getGitSsh,
  // Persist coding-agent output as real channel messages (survives session restart; renders as
  // markdown) — through the GOVERNED append: the channel's marking stamps the output, portion
  // markings fold/spillage-check, and DLP scans it like any human post (block ⇒ a clean withheld
  // notice, audited). Returns the enriched message; control.ts broadcasts exactly that.
  appendAgentMessage: (channelId, agentId, text) =>
    governedAgentAppend(
      { store, marking: config.marking, dlp: config.dlp },
      { channelId, authorRef: agentId, content: text },
    ),
});

// The orphan reaper — the ONLY thing that ends a coding session whose daemon is truly gone. A
// daemon renews its live sessions' leases on a heartbeat (every ~20s); once that stops for longer
// than the lease TTL (a real disconnect, not a reconnect blip — which no longer ends sessions, see
// remote-runner's handleDaemonGone), the sweep marks the session "orphaned". A reaped session is no
// longer "live", so the next message to that channel (re)spawns a fresh one — which pi resumes from
// the durable session id. Ticks every 15s.
const reaper = startReaper(store, { now: () => Date.now(), intervalMs: 15_000 });

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
  verifyToken, store, llm, control, broadcast, notify, presence, auth,
  // When the spawning owner has a runner daemon attached, the session is hosted there (hostType
  // "local"); the router routes to it. Purely informational for hostType — routing is decided at
  // start() by the same registry check.
  hasRemoteRunner: (sub) => runnerRegistry.has(sub),
  search: (userSub, q) => searchMessages(store, userSub, q),
  web: { root: webRoot },
  admin: { adminGroup: config.adminGroup, devMode: config.devMode, overview: () => buildOverview(store), renderConsole },
  marking: config.marking,
  dlp: config.dlp,
  capabilities: config.capabilities,
  stepUp: config.stepUp,
  runnerToken: config.runnerToken,
  assistantModel: config.assistantModel,
  // Subscribe a creator's live socket to a brand-new channel/agent/DM immediately (see the
  // subscribeAll snapshot note in ws/hub.ts) — lazy like `broadcast`, since hub is created after.
  subscribe: (sub, channelId) => hub?.subscribe(sub, channelId),
  attachments: { blobs: new FsBlobStore(config.uploadsDir), maxUploadBytes: config.maxUploadBytes },
  // Per-user git SSH identities (POST/GET/DELETE /me/ssh-key). Present only when a master key is
  // configured; unset ⇒ those routes 503 (feature off).
  ssh: config.secretKey ? { secretKey: config.secretKey, knownHosts: config.gitKnownHosts } : undefined,
  // Whether the Kubernetes agent pool is available — drives the "Online pool" launch-env option.
  poolConfigured: Boolean(poolRunner),
  // Outbound-webhook delivery (SecChat → external URLs on events), plus the destination allowlist
  // enforced when a subscription is created.
  outbound: makeOutboundDispatcher(store),
  outboundAllowedHosts: config.outboundAllowedHosts,
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
// Runner daemons attach here (a separate `/runner` protocol; the client hub above skips that path).
const runnerHub = attachRunnerHub(server, {
  verifyToken,
  registry: runnerRegistry,
  remote: remoteRunner,
  // Pool pods attach with `?pool=<sessionId>` and route to the PoolRunner (by session), off the
  // per-owner registry so they can't supersede the owner's desktop daemon.
  pool: poolRunner,
  // A daemon may attach with a scoped runner token (minted via POST /auth/runner-token) as well as
  // a full OIDC/dev bearer.
  verifyRunnerToken: config.runnerToken ? (t) => config.runnerToken!.verify(t) : undefined,
});

server.listen(config.port, config.host, () => {
  console.error(`▸ SecChat listening on http://${config.host}:${config.port} (in-memory store)`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    hub?.close();
    runnerHub.close();
    reaper.stop();
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
