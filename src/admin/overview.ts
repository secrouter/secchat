// The read-only snapshot builder for the admin / audit-review console (AU 3.3.5/6). Gathers
// every read path the console needs — channels, agents, sessions, audit events, and the two
// tamper-evident chain verdicts (src/audit/chain.ts, surfaced via `verifyChains`) — into one
// `AdminOverview` (src/types.ts) stamped with a single `generatedAt` timestamp.
//
// Deliberately does NO filtering, redaction, or shaping of its own: it's a faithful snapshot of
// whatever the store currently holds: the renderer (src/admin/console.ts, built in parallel) owns
// every presentation decision. Depends only on the `Store` / `SessionStore` PORTS (src/types.ts)
// — never a concrete store (src/store/memory.ts is built in parallel; this module doesn't import
// it) — so it's fully testable offline with a fake — see test/admin-overview.test.ts.

import type { AdminOverview, SessionStore, Store } from "../types.ts";

export async function buildOverview(store: Store & SessionStore): Promise<AdminOverview> {
  const [channels, agents, sessions, audit, chains] = await Promise.all([
    store.listChannels(),
    store.listAllAgents(),
    store.listAllSessions(),
    store.listAudit(),
    store.verifyChains(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    channels,
    agents,
    sessions,
    audit,
    chains,
  };
}
