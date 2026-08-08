// Permission-aware full-text search. SECURITY-CRITICAL: search is the classic RLS-bypass bug
// factory — a single unmembered channel slipping past the gate leaks its content to anyone who
// happens to search for the right word. The ACL check below is applied to EVERY channel
// `store.listChannels()` returns, no exceptions, before any of that channel's messages are ever
// read. Depends only on the `Store` PORT from ../types.ts, so this is fully testable offline
// with a fake — see test/search.test.ts (in particular "THE BOUNDARY TEST").

import type { Message, Store } from "../types.ts";

export async function searchMessages(
  store: Store,
  userSub: string,
  query: string,
): Promise<Array<Message & { content?: string }>> {
  const q = query.trim().toLowerCase();
  if (q === "") return []; // no query, no results — never dump every message the user can see

  const results: Array<Message & { content?: string }> = [];

  for (const channel of await store.listChannels()) {
    // The ACL gate — evaluated for every channel before touching its messages. Not a member?
    // Skip it entirely; nothing from this channel is even read, let alone matched.
    if (!(await store.isMember(channel.id, userSub))) continue;

    for (const message of await store.listMessages(channel.id)) {
      // Redacted rows have no `content` key at all (see store/memory.ts) — never matched.
      if (message.content === undefined) continue;
      if (message.content.toLowerCase().includes(q)) results.push(message);
    }
  }

  // Newest first. Plain string comparison (not localeCompare) — ISO-8601 UTC timestamps of
  // uniform format sort chronologically under ordinary code-unit order, with no locale-dependent
  // collation surprises.
  results.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0));

  return results;
}
