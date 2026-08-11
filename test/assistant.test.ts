// The assistant orchestration, exercised fully offline with fakes for both injected ports
// (Store, LlmClient) — no real store or SecRouter client involved. Covers: context assembly
// (system preamble + history mapping/skip/cap + new turn last), owner-attributed actingUser
// (decision #2 — never the prompter), the delta/message broadcast sequence, and the
// empty-stream-must-not-persist rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent, LlmClient, LlmCompleteRequest, Message, Store } from "../src/types.ts";
import { handleAssistantTurn } from "../src/assistant/service.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";

const GENESIS = "0".repeat(64);

const AGENT: Agent = {
  id: "agent-1",
  ownerSub: "user-owner",
  kind: "assistant",
  name: "Assistant",
  model: "claude-x",
  createdAt: "2026-08-08T00:00:00.000Z",
};

type HistoryRow = Message & { content?: string };

/** MINIMAL fake Store — implements only listMessages/appendMessage/getChannel, the methods
 * handleAssistantTurn calls (getChannel only when a markingPolicy is wired). Cast through
 * `unknown` rather than structurally satisfying the full Store contract (matches the pattern in
 * test/http.test.ts). */
function makeFakeStore(history: HistoryRow[], channelMarking?: string) {
  const appended: Array<{ channelId: string; authorRef: string; authorType: string; content: string; promptedBy?: string }> = [];
  let nextId = 1;

  const store = {
    async listMessages() {
      return history;
    },
    async getChannel(id: string) {
      return { id, kind: "channel", name: "chan", createdBy: "user-owner", createdAt: "2026-08-08T00:00:00.000Z", cuiMarking: channelMarking };
    },
    async appendMessage(input: { channelId: string; authorRef: string; authorType: "user" | "agent"; content: string; promptedBy?: string }) {
      appended.push(input);
      const msg: Message = {
        id: `msg-${nextId++}`,
        channelId: input.channelId,
        seq: history.length + 1,
        authorRef: input.authorRef,
        authorType: input.authorType,
        promptedBy: input.promptedBy,
        contentSha256: GENESIS,
        marking: "UNCLASSIFIED",
        attachmentsSha256: "",
        prevHash: GENESIS,
        hash: GENESIS,
        createdAt: "2026-08-08T00:00:01.000Z",
      };
      return msg;
    },
  } as unknown as Store;

  return { store, appended };
}

/** Fake LlmClient — `complete` captures the request (so the test can assert on it later) and
 * yields the given deltas via an async generator, matching `LlmClient.complete`'s synchronous
 * `AsyncIterable<string>` return (no `Promise` wrapper, so it must not be declared `async`). */
function makeFakeLlm(deltas: string[]) {
  let captured: LlmCompleteRequest | undefined;
  const llm: LlmClient = {
    complete(req) {
      captured = req;
      return (async function* () {
        for (const d of deltas) yield d;
      })();
    },
  };
  return { llm, getCaptured: () => captured };
}

function makeFakeBroadcast() {
  const events: Array<{ channelId: string; payload: unknown }> = [];
  const broadcast = (channelId: string, payload: unknown) => {
    events.push({ channelId, payload });
  };
  return { broadcast, events };
}

function historyRow(partial: Partial<HistoryRow> & Pick<HistoryRow, "seq" | "authorType" | "authorRef">): HistoryRow {
  return {
    id: `m-seq-${partial.seq}`,
    channelId: "chan-1",
    contentSha256: GENESIS,
    marking: "UNCLASSIFIED",
    attachmentsSha256: "",
    prevHash: GENESIS,
    hash: GENESIS,
    createdAt: "2026-08-08T00:00:00.000Z",
    ...partial,
  };
}

test("persists the agent turn, attributes actingUser to the OWNER (never the prompter), and broadcasts deltas then the final message", async () => {
  const history: HistoryRow[] = [
    historyRow({ seq: 1, authorRef: "user-human", authorType: "user", content: "hi there" }),
  ];
  const { store, appended } = makeFakeStore(history);
  const { llm, getCaptured } = makeFakeLlm(["Hel", "lo"]);
  const { broadcast, events } = makeFakeBroadcast();

  const msg = await handleAssistantTurn(
    { store, llm, broadcast },
    { channelId: "chan-1", agent: AGENT, promptedBy: "user-human", userText: "hello there" },
  );

  // Returned/persisted message shape.
  assert.equal(msg.authorType, "agent");
  assert.equal(msg.authorRef, AGENT.id);
  assert.equal(msg.promptedBy, "user-human");

  // appendMessage was called exactly once, with the accumulated (not per-delta) content.
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.content, "Hello");
  assert.equal(appended[0]?.channelId, "chan-1");
  assert.equal(appended[0]?.authorType, "agent");
  assert.equal(appended[0]?.authorRef, AGENT.id);
  assert.equal(appended[0]?.promptedBy, "user-human");

  // The LLM request is attributed to the agent's OWNER, never the human who prompted it.
  const captured = getCaptured();
  assert.ok(captured);
  assert.equal(captured?.model, AGENT.model);
  assert.equal(captured?.actingUser, AGENT.ownerSub);
  assert.notEqual(captured?.actingUser, "user-human");

  // Message context: system preamble first, prior history next, new user turn last.
  const msgs = captured!.messages;
  assert.equal(msgs[0]?.role, "system");
  assert.ok(msgs[0]?.content.length > 0);
  assert.equal(msgs[1]?.role, "user");
  assert.equal(msgs[1]?.content, "hi there");
  const last = msgs[msgs.length - 1]!;
  assert.equal(last.role, "user");
  assert.equal(last.content, "hello there");

  // Broadcasts: assistant_delta x2, then exactly one final message event.
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { channelId: "chan-1", payload: { type: "assistant_delta", agentId: AGENT.id, delta: "Hel" } });
  assert.deepEqual(events[1], { channelId: "chan-1", payload: { type: "assistant_delta", agentId: AGENT.id, delta: "lo" } });
  const finalPayload = events[2]?.payload as { type: string; message: { content?: string; authorType?: string } };
  assert.equal(finalPayload.type, "message");
  assert.equal(finalPayload.message.content, "Hello");
  assert.equal(finalPayload.message.authorType, "agent");
});

test("works with no broadcast fn supplied (optional dep)", async () => {
  const { store } = makeFakeStore([]);
  const { llm } = makeFakeLlm(["ok"]);

  const msg = await handleAssistantTurn({ store, llm }, { channelId: "chan-1", agent: AGENT, promptedBy: "user-human", userText: "hi" });
  assert.equal(msg.authorType, "agent");
});

test("history mapping: agent rows become role \"assistant\", user rows stay \"user\", and content-less (redacted) rows are skipped", async () => {
  const history: HistoryRow[] = [
    historyRow({ seq: 1, authorRef: "user-human", authorType: "user", content: "u1" }),
    historyRow({ seq: 2, authorRef: AGENT.id, authorType: "agent", content: "a1" }),
    historyRow({ seq: 3, authorRef: "user-human", authorType: "user" }), // redacted: no `content` key at all
    historyRow({ seq: 4, authorRef: AGENT.id, authorType: "agent", content: "a2" }),
  ];
  assert.equal("content" in history[2]!, false); // sanity: truly absent, not `content: undefined`

  const { store } = makeFakeStore(history);
  const { llm, getCaptured } = makeFakeLlm(["ok"]);

  await handleAssistantTurn({ store, llm }, { channelId: "chan-1", agent: AGENT, promptedBy: "user-human", userText: "new turn" });

  const msgs = getCaptured()!.messages;
  // system + 3 surviving history rows (row 3 skipped) + the new turn = 5.
  assert.deepEqual(
    msgs.map((m) => [m.role, m.content]),
    [
      ["system", msgs[0]!.content],
      ["user", "u1"],
      ["assistant", "a1"],
      ["assistant", "a2"],
      ["user", "new turn"],
    ],
  );
});

test("history is capped to the last 20 mapped rows", async () => {
  const history: HistoryRow[] = [];
  for (let i = 1; i <= 25; i++) {
    history.push(historyRow({ seq: i, authorRef: "user-human", authorType: "user", content: `row-${i}` }));
  }
  const { store } = makeFakeStore(history);
  const { llm, getCaptured } = makeFakeLlm(["ok"]);

  await handleAssistantTurn({ store, llm }, { channelId: "chan-1", agent: AGENT, promptedBy: "user-human", userText: "new turn" });

  const msgs = getCaptured()!.messages;
  // [system, ...20 history rows, new turn] = 22.
  assert.equal(msgs.length, 22);
  const historyPortion = msgs.slice(1, -1);
  assert.equal(historyPortion.length, 20);
  assert.equal(historyPortion[0]?.content, "row-6"); // oldest kept: rows 1..5 dropped
  assert.equal(historyPortion[19]?.content, "row-25"); // newest kept
  assert.equal(msgs[msgs.length - 1]?.content, "new turn");
});

test("an empty stream (no deltas) rejects and does NOT persist a message", async () => {
  const { store, appended } = makeFakeStore([]);
  const { llm } = makeFakeLlm([]);
  const { broadcast, events } = makeFakeBroadcast();

  await assert.rejects(
    () => handleAssistantTurn({ store, llm, broadcast }, { channelId: "chan-1", agent: AGENT, promptedBy: "user-human", userText: "hi" }),
    /assistant produced no output/,
  );

  assert.equal(appended.length, 0);
  assert.equal(events.length, 0); // no deltas were emitted, and no final "message" broadcast either
});

// ── F1: the classification forwarded to the gateway (LlmCompleteRequest.classification) ──────
// The level sent must dominate EVERYTHING in the model context — the channel's marking plus every
// included history row — and must be a bare ladder LEVEL (never a category-bearing banner string).

const LADDER = makeMarkingPolicy(["UNCLASSIFIED", "CUI", "SECRET"], "UNCLASSIFIED", [
  { kind: "category", level: "CUI", code: "SP-PRVCY", name: "Privacy" },
]);

test("classification: a marked channel's level is forwarded even when every row is baseline", async () => {
  const { store } = makeFakeStore(
    [historyRow({ seq: 1, authorType: "user", authorRef: "user-a", content: "hello" })],
    "CUI",
  );
  const { llm, getCaptured } = makeFakeLlm(["ok"]);

  await handleAssistantTurn({ store, llm, markingPolicy: LADDER }, { channelId: "chan-1", agent: AGENT, promptedBy: "user-human", userText: "hi" });

  assert.equal(getCaptured()!.classification, "CUI");
});

test("classification: the highest INCLUDED history row raises it in an unmarked channel, and categories are stripped to the level", async () => {
  const { store } = makeFakeStore([
    historyRow({ seq: 1, authorType: "user", authorRef: "user-a", content: "plain" }),
    historyRow({ seq: 2, authorType: "user", authorRef: "user-a", content: "sensitive", marking: "CUI//SP-PRVCY" }),
  ]);
  const { llm, getCaptured } = makeFakeLlm(["ok"]);

  await handleAssistantTurn({ store, llm, markingPolicy: LADDER }, { channelId: "chan-1", agent: AGENT, promptedBy: "user-human", userText: "hi" });

  // "CUI//SP-PRVCY" contributes its LEVEL — the header carries "CUI", never the banner string.
  assert.equal(getCaptured()!.classification, "CUI");
});

test("classification: rows sliced out of the history window do NOT raise it", async () => {
  // Row 1 is SECRET but falls outside the 20-row window once rows 2..26 exist; nothing the model
  // actually sees is above baseline, so the call must NOT be escalated to SECRET.
  const rows: HistoryRow[] = [
    historyRow({ seq: 1, authorType: "user", authorRef: "user-a", content: "old secret", marking: "SECRET" }),
  ];
  for (let seq = 2; seq <= 26; seq++) {
    rows.push(historyRow({ seq, authorType: "user", authorRef: "user-a", content: `row-${seq}` }));
  }
  const { store } = makeFakeStore(rows);
  const { llm, getCaptured } = makeFakeLlm(["ok"]);

  await handleAssistantTurn({ store, llm, markingPolicy: LADDER }, { channelId: "chan-1", agent: AGENT, promptedBy: "user-human", userText: "hi" });

  assert.equal(getCaptured()!.classification, "UNCLASSIFIED");
});

test("classification: absent entirely when no markingPolicy is wired (back-compat)", async () => {
  const { store } = makeFakeStore([historyRow({ seq: 1, authorType: "user", authorRef: "user-a", content: "hello" })], "CUI");
  const { llm, getCaptured } = makeFakeLlm(["ok"]);

  await handleAssistantTurn({ store, llm }, { channelId: "chan-1", agent: AGENT, promptedBy: "user-human", userText: "hi" });

  assert.equal(getCaptured()!.classification, undefined);
});
