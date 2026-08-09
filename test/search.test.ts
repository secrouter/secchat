// Permission-aware full-text search, exercised fully offline with a fake Store — no real store
// involved. SECURITY-CRITICAL: the review flagged search as "the classic RLS-bypass bug
// factory," so THE BOUNDARY TEST below is the one that matters most — a message from a channel
// the user isn't a member of must never come back, no matter how well it matches the query.
// Also covers: case-insensitivity, redacted (content-less) rows being skipped, the
// empty/whitespace-query guard, and newest-first ordering.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Channel, Message, Store } from "../src/types.ts";
import { searchMessages } from "../src/search/search.ts";

const GENESIS = "0".repeat(64);

type Row = Message & { content?: string };

function makeChannel(id: string): Channel {
  return {
    id,
    workspaceId: "ws-1",
    kind: "human",
    createdBy: "user-owner",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeMessage(partial: Partial<Row> & Pick<Row, "id" | "channelId" | "seq">): Row {
  return {
    authorRef: "user-1",
    authorType: "user",
    contentSha256: GENESIS,
    marking: "UNCLASSIFIED",
    attachmentsSha256: "",
    prevHash: GENESIS,
    hash: GENESIS,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

/** MINIMAL fake Store — implements only listChannels/isMember/listMessages, the three methods
 * searchMessages calls. Cast through `unknown` rather than structurally satisfying the full
 * Store contract (matches the pattern in test/assistant.test.ts). */
function makeFakeStore(opts: {
  channels: Channel[];
  members: Record<string, string[]>; // channelId -> member subs
  messages: Record<string, Row[]>; // channelId -> messages
}) {
  const store = {
    async listChannels() {
      return opts.channels;
    },
    async isMember(channelId: string, ref: string) {
      return (opts.members[channelId] ?? []).includes(ref);
    },
    async listMessages(channelId: string) {
      return opts.messages[channelId] ?? [];
    },
  } as unknown as Store;

  return store;
}

test("THE BOUNDARY TEST: a message in a channel the user is NOT a member of is never returned, even when it matches", async () => {
  const ch1 = makeChannel("ch1");
  const ch2 = makeChannel("ch2");
  const store = makeFakeStore({
    channels: [ch1, ch2],
    members: { ch1: ["user-1"], ch2: ["user-2"] }, // user-1 is a member of ch1 only
    messages: {
      ch1: [makeMessage({ id: "m1", channelId: "ch1", seq: 1, content: "the secret plan" })],
      ch2: [makeMessage({ id: "m2", channelId: "ch2", seq: 1, content: "another secret plan" })],
    },
  });

  const results = await searchMessages(store, "user-1", "secret");

  const channelIds = results.map((m) => m.channelId);
  assert.ok(channelIds.includes("ch1"));
  assert.ok(!channelIds.includes("ch2"));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, "m1");
});

test("query matching is case-insensitive", async () => {
  const ch1 = makeChannel("ch1");
  const store = makeFakeStore({
    channels: [ch1],
    members: { ch1: ["user-1"] },
    messages: {
      ch1: [makeMessage({ id: "m1", channelId: "ch1", seq: 1, content: "this is top secret" })],
    },
  });

  const results = await searchMessages(store, "user-1", "SECRET");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.id, "m1");
});

test("a redacted message (no `content` key) is never returned even if a sibling in the same channel matches", async () => {
  const ch1 = makeChannel("ch1");
  const redacted = makeMessage({ id: "m-redacted", channelId: "ch1", seq: 1 }); // no `content` passed
  assert.equal("content" in redacted, false); // sanity: truly absent, not `content: undefined`

  const store = makeFakeStore({
    channels: [ch1],
    members: { ch1: ["user-1"] },
    messages: {
      ch1: [redacted, makeMessage({ id: "m-ok", channelId: "ch1", seq: 2, content: "secret sibling" })],
    },
  });

  const results = await searchMessages(store, "user-1", "secret");
  const ids = results.map((m) => m.id);
  assert.ok(!ids.includes("m-redacted"));
  assert.deepEqual(ids, ["m-ok"]);
});

test("an empty or whitespace-only query returns [] rather than dumping every message", async () => {
  const ch1 = makeChannel("ch1");
  const store = makeFakeStore({
    channels: [ch1],
    members: { ch1: ["user-1"] },
    messages: {
      ch1: [makeMessage({ id: "m1", channelId: "ch1", seq: 1, content: "anything at all" })],
    },
  });

  assert.deepEqual(await searchMessages(store, "user-1", ""), []);
  assert.deepEqual(await searchMessages(store, "user-1", "   "), []);
});

test("results are ordered newest-first by createdAt", async () => {
  const ch1 = makeChannel("ch1");
  const store = makeFakeStore({
    channels: [ch1],
    members: { ch1: ["user-1"] },
    messages: {
      ch1: [
        makeMessage({ id: "old", channelId: "ch1", seq: 1, content: "match one", createdAt: "2026-08-01T00:00:00.000Z" }),
        makeMessage({ id: "newest", channelId: "ch1", seq: 3, content: "match three", createdAt: "2026-08-03T00:00:00.000Z" }),
        makeMessage({ id: "mid", channelId: "ch1", seq: 2, content: "match two", createdAt: "2026-08-02T00:00:00.000Z" }),
      ],
    },
  });

  const results = await searchMessages(store, "user-1", "match");
  assert.deepEqual(results.map((m) => m.id), ["newest", "mid", "old"]);
});
