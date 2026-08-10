// Unit tests for the @mention parser (src/mentions/parse.ts): deriving a user's handle, lexing
// `@handle` tokens out of free text (without mistaking emails for mentions), and resolving them
// against channel members while excluding the author.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionHandle, parseMentionTokens, resolveMentions } from "../src/mentions/parse.ts";
import type { User } from "../src/types.ts";

const user = (sub: string, email?: string, displayName?: string): User => ({
  sub,
  email,
  displayName,
  groups: [],
  lastSeenAt: "2026-01-01T00:00:00.000Z",
});

test("mentionHandle: display name drives the handle (what users see), lowercased + whitespace-stripped", () => {
  // Display name wins — "Alice Ng" is what teammates see, so @aliceng mentions her.
  assert.equal(mentionHandle({ sub: "u-1", email: "alice@example.mil", displayName: "Alice Ng" }), "aliceng");
  // No display name ⇒ fall back to the email local-part, then the sub.
  assert.equal(mentionHandle({ sub: "u-2", email: "bob.reyes@x.mil" }), "bob.reyes");
  assert.equal(mentionHandle({ sub: "carol", email: undefined }), "carol");
  // A sub with characters outside the handle set is reduced to the safe set.
  assert.equal(mentionHandle({ sub: "Weird Sub!", email: undefined }), "weirdsub");
});

test("parseMentionTokens: distinct, first-seen order, lowercased", () => {
  assert.deepEqual(parseMentionTokens("hey @alice and @Bob, cc @alice"), ["alice", "bob"]);
});

test("parseMentionTokens: an email address is NOT a mention", () => {
  assert.deepEqual(parseMentionTokens("reach me at alice@example.mil please"), []);
});

test("parseMentionTokens: a mention at line start and after a bracket is caught; trailing punctuation trimmed", () => {
  assert.deepEqual(parseMentionTokens("@alice: ping (@bob) thanks @carol."), ["alice", "bob", "carol"]);
});

test("resolveMentions: maps tokens to member subs, excluding the author, in member order", () => {
  const members = [user("alice", "alice@example.mil"), user("bob", "bob@example.mil"), user("carol", "carol@example.mil")];
  const subs = resolveMentions(members, "@carol @alice look here", "alice");
  // alice is the author (excluded); carol + alice tokens present → only carol resolves.
  assert.deepEqual(subs, ["carol"]);
});

test("resolveMentions: a token matching no member is silently ignored", () => {
  const members = [user("alice", "alice@example.mil"), user("bob", "bob@example.mil")];
  assert.deepEqual(resolveMentions(members, "@nobody @bob", "alice"), ["bob"]);
});

test("resolveMentions: no tokens ⇒ no mentions", () => {
  const members = [user("alice", "alice@example.mil")];
  assert.deepEqual(resolveMentions(members, "just a normal message", "bob"), []);
});
