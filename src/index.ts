// Process entrypoint — the ONE place the concrete modules are wired together (everything else
// takes its dependencies by injection). Config → JWKS verifier → Store → HTTP server → WS hub.
//
// The HTTP layer and the WS hub have a mutual reference (a posted message must fan out to
// subscribers), resolved here without a cycle: the server is created with a `broadcast` closure
// that reads `hub` lazily, and `hub` is assigned immediately after. By the time any request can
// fire, both exist.

import { makeVerifyToken } from "./auth/jwks.ts";
import { loadConfig } from "./config.ts";
import { createHttpServer } from "./http/server.ts";
import { MemoryStore } from "./store/memory.ts";
import { attachWsHub } from "./ws/hub.ts";
import type { Hub } from "./ws/hub.ts";

const config = loadConfig();
const verifyToken = makeVerifyToken(config);

// Sprint 1 uses the in-memory store (state is lost on restart). The Postgres store lands in
// Sprint 2 behind the same `Store` interface; until then DATABASE_URL is accepted but unused.
if (config.databaseUrl) {
  console.error("! DATABASE_URL is set but the Postgres store isn't wired yet (Sprint 2) — using the in-memory store");
}
const store = new MemoryStore();

let hub: Hub | undefined;
const server = createHttpServer({
  verifyToken,
  store,
  broadcast: (channelId, payload) => hub?.broadcast(channelId, payload),
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
