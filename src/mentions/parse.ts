// @mention parsing — pure, dependency-free. A message body may name other channel members with
// `@handle` tokens; the highest-value, lowest-surprise resolution is against the CHANNEL MEMBERS
// only (you can't notify someone who can't read the channel), matching each parsed token to a
// member's derived handle.
//
// The handle is DERIVED (never stored or transmitted): both this backend and the Flutter client
// compute the identical function from the fields they already hold (email/sub), so a mention
// round-trips without a schema or wire change. Keep `mentionHandle` in lockstep with the client's
// `mentionHandle` in app/lib/mentions.dart.

import type { User } from "../types.ts";

/** A stable, whitespace-free handle for a user, derived from what people actually SEE: the display
 * name first ("Alice Ng" → "aliceng"), falling back to the email local-part (alice@x.mil → "alice")
 * and finally the raw subject id. Lowercased and reduced to `[a-z0-9._-]` (spaces removed) so it's
 * safe to both parse out of free text and render inline. The client's autocomplete inserts this same
 * handle, so a picked "@Alice Ng" round-trips. Keep in lockstep with app/lib/mentions.dart. */
export function mentionHandle(user: Pick<User, "sub" | "email" | "displayName">): string {
  const base =
    user.displayName && user.displayName.trim() !== ""
      ? user.displayName
      : user.email && user.email.includes("@")
        ? user.email.split("@")[0]!
        : user.sub;
  return base.toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

// `@handle` must sit at a word start — line start, whitespace, or an opening bracket/paren — so an
// email address ("reach me at alice@x.mil") never reads as a mention of `@x`. The handle itself
// starts alphanumeric and then allows the same `[a-z0-9._-]` set `mentionHandle` produces.
const MENTION_RE = /(?:^|[\s([{<])@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;

/** The distinct `@handle` tokens in `content`, lowercased, in first-seen order. Purely lexical —
 * resolution against real members happens in [resolveMentions]; a token matching nobody is just
 * text. A trailing `.`/`-`/`_` is trimmed so "ping @alice." yields "alice", not "alice.". */
export function parseMentionTokens(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of content.matchAll(MENTION_RE)) {
    const handle = m[1]!.toLowerCase().replace(/[._-]+$/, "");
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}

/** The subs of `members` mentioned in `content` — those whose derived [mentionHandle] matches a
 * parsed token — EXCLUDING `authorSub` (you don't notify yourself). Distinct, in member order.
 * Over-delivery is the fail-safe here: if two members share a handle, both are notified. */
export function resolveMentions(members: User[], content: string, authorSub: string): string[] {
  const tokens = new Set(parseMentionTokens(content));
  if (tokens.size === 0) return [];
  const out: string[] = [];
  const added = new Set<string>();
  for (const m of members) {
    if (m.sub === authorSub || added.has(m.sub)) continue;
    if (tokens.has(mentionHandle(m))) {
      out.push(m.sub);
      added.add(m.sub);
    }
  }
  return out;
}
