// A registry of REMOTE runner daemons currently attached to this SecChat (see the /runner attach
// endpoint). Keyed by the daemon's owner sub — a user runs their own runner (bundled in their
// desktop app, or standalone on their server/container) on their own token, so a coding agent owned
// by that user routes to their daemon. One live daemon per owner in v1 (a second registration for
// the same owner supersedes the first — last-attach wins).
//
// Dependency-free + I/O-free: `send` is injected (the attach endpoint wires it to the socket write),
// so this is fully testable offline.

import type { RunnerCommand } from "./runner-protocol.ts";

/** One attached daemon: its owner, a unique runnerId, and a `send` that pushes a command to it. */
export interface RunnerConnection {
  ownerSub: string;
  runnerId: string;
  send: (cmd: RunnerCommand) => void;
}

export class RunnerRegistry {
  #byOwner = new Map<string, RunnerConnection>(); // ownerSub -> the owner's live daemon (last wins)

  /** Attach (or replace) the daemon for an owner. Returns the superseded connection, if any, so the
   * caller can close its socket. */
  register(conn: RunnerConnection): RunnerConnection | undefined {
    const prev = this.#byOwner.get(conn.ownerSub);
    this.#byOwner.set(conn.ownerSub, conn);
    return prev && prev.runnerId !== conn.runnerId ? prev : undefined;
  }

  /** Detach a daemon — only if it's still the registered one (a superseded daemon disconnecting
   * later must not evict its replacement). */
  unregister(ownerSub: string, runnerId: string): void {
    const cur = this.#byOwner.get(ownerSub);
    if (cur && cur.runnerId === runnerId) this.#byOwner.delete(ownerSub);
  }

  /** The owner's live daemon, or undefined if none is attached. */
  get(ownerSub: string): RunnerConnection | undefined {
    return this.#byOwner.get(ownerSub);
  }

  has(ownerSub: string): boolean {
    return this.#byOwner.has(ownerSub);
  }

  /** The owner subs with a live daemon (for a status/console view). */
  owners(): string[] {
    return [...this.#byOwner.keys()];
  }
}
