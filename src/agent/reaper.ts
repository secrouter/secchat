// The orphan reaper — a session's runner (a server process, or someone's laptop running the
// local `secagent daemon`) can simply go away without ever telling the control plane: no clean
// `exit` event, no final `status`. The runner is expected to renew the session's lease on a
// heartbeat (SessionStore.renewLease); once that stops, the lease lapses and the session must be
// marked `orphaned` — visible-but-dead in the channel transcript, per the review's
// session-semantics note — rather than sitting forever as `starting`/`active` while nothing is
// actually running.
//
// Split in two for testability: reapOrphaned is the PURE lapsed-lease rule (session list + a
// plain nowMs in, ids out — no I/O, no clock reads), and runReaperOnce is the thin store-effecting
// sweep built on top of it. Callers (startReaper, or a one-off invocation) always inject the
// clock — nothing in here calls Date.now()/new Date() itself — so every rule is deterministically
// testable against fixed timestamps.

import type { AgentSession, SessionStore } from "../types.ts";

/** Ids of sessions that are still `"starting"` or `"active"` but whose lease has already lapsed
 * as of `nowMs`. PURE. `ended`/`orphaned` sessions are ignored (already terminal — not the
 * reaper's concern), as are `starting`/`active` sessions whose lease is still current. A lease
 * exactly equal to `nowMs` counts as lapsed (`<=`, not `<`). */
export function reapOrphaned(sessions: AgentSession[], nowMs: number): string[] {
  const lapsed: string[] = [];
  for (const session of sessions) {
    if (session.status !== "starting" && session.status !== "active") continue;
    if (Date.parse(session.leaseExpiresAt) <= nowMs) lapsed.push(session.id);
  }
  return lapsed;
}

/** One reaper sweep: list the store's live sessions, work out which have lapsed, and transition
 * each to `"orphaned"`. Returns the reaped ids (empty if none lapsed this sweep). */
export async function runReaperOnce(store: SessionStore, nowMs: number): Promise<string[]> {
  const sessions = await store.listActiveSessions();
  const ids = reapOrphaned(sessions, nowMs);
  for (const id of ids) {
    await store.setSessionStatus(id, "orphaned");
  }
  return ids;
}

export interface StartReaperOptions {
  /** Injected clock — called fresh on every tick (never Date.now() directly), so the sweep's
   * notion of "now" stays test-controllable even while the reaper itself runs on a real timer. */
  now: () => number;
  intervalMs: number;
  /** Notified after every sweep with that sweep's reaped ids (possibly empty). */
  onReap?: (ids: string[]) => void;
}

/** Runs `runReaperOnce` on a `setInterval` until `stop()`ed. A failing tick (store I/O error) is
 * swallowed so it can never take down the loop — the next tick still fires on schedule. The timer
 * is `.unref()`d where supported, so a running reaper never by itself keeps the process alive. */
export function startReaper(store: SessionStore, opts: StartReaperOptions): { stop: () => void } {
  const timer = setInterval(() => {
    runReaperOnce(store, opts.now())
      .then((ids) => opts.onReap?.(ids))
      .catch(() => {
        // Swallow: one bad tick must not kill the interval loop. Nothing to surface it to here —
        // callers who need visibility should have their store implementation log its own errors.
      });
  }, opts.intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
