// governance/append.ts — the governed append for MACHINE-authored content (assistant turns +
// coding-agent output). Closes the historical bypass where LLM output skipped DLP + marking
// entirely (governance lived only in the HTTP post route). Real MemoryStore + real marking/DLP
// policies — no fakes, so the marking stamp, audit events, and chain are the genuine article.

import { test } from "node:test";
import assert from "node:assert/strict";
import { governedAgentAppend } from "../src/governance/append.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";
import { DlpPolicy } from "../src/dlp/policy.ts";

const WORKSPACE = "ws-1";
const marking = makeMarkingPolicy(["UNCLASSIFIED", "CUI", "SECRET"], "UNCLASSIFIED", [
  { kind: "category", level: "CUI", code: "SP-PRVCY", name: "Privacy" },
]);
const SSN_RULE = { name: "ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b" };

async function makeChannel(store: MemoryStore, cuiMarking?: string) {
  const channel = await store.createChannel({ workspaceId: WORKSPACE, kind: "human", name: "chan", createdBy: "alice", cuiMarking });
  await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "owner" });
  return channel;
}

test("agent output in a MARKED channel is stamped with the channel marking (was: policy floor)", async () => {
  const store = new MemoryStore();
  const channel = await makeChannel(store, "CUI//SP-PRVCY");

  const msg = await governedAgentAppend(
    { store, marking },
    { channelId: channel.id, authorRef: "agent-1", content: "a governed reply", promptedBy: "alice" },
  );

  assert.equal(msg.marking, "CUI//SP-PRVCY", "output inherits the channel marking, not the floor");
  assert.equal(msg.content, "a governed reply");
  assert.equal(msg.authorType, "agent");
  assert.equal(msg.promptedBy, "alice");
  assert.equal((await store.verifyChains()).messagesOk, true);
});

test("portion markings in the OUTPUT raise the effective marking in an unmarked channel", async () => {
  const store = new MemoryStore();
  const channel = await makeChannel(store);

  const msg = await governedAgentAppend(
    { store, marking },
    { channelId: channel.id, authorRef: "agent-1", content: "(CUI) a controlled line the model echoed" },
  );

  assert.equal(msg.marking, "CUI", "portion join raises the stamped marking");
});

test("output whose portion EXCEEDS a marked channel's ceiling is WITHHELD — notice + audit, content nowhere", async () => {
  const store = new MemoryStore();
  const channel = await makeChannel(store, "CUI"); // ceiling CUI; the output carries SECRET

  const msg = await governedAgentAppend(
    { store, marking },
    { channelId: channel.id, authorRef: "agent-1", content: "(SECRET) the model echoed above-ceiling content" },
  );

  assert.match(msg.content, /withheld.*ceiling/i, "a clean notice replaces the output");
  assert.ok(!msg.content.includes("echoed"), "none of the real output appears in the notice");
  // The real content was never persisted anywhere: the only message row is the notice.
  const rows = await store.listMessages(channel.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.content, msg.content);
  const audit = await store.listAudit();
  assert.ok(audit.some((e) => e.action === "message.marking_withheld" && e.target === msg.id));
  assert.equal((await store.verifyChains()).messagesOk, true);
});

test("DLP block mode: agent output matching a rule is WITHHELD — notice names the rule, audit is content-free", async () => {
  const store = new MemoryStore();
  const channel = await makeChannel(store);
  const dlp = new DlpPolicy("block", [SSN_RULE]);

  const msg = await governedAgentAppend(
    { store, marking, dlp },
    { channelId: channel.id, authorRef: "agent-1", content: "the SSN is 123-45-6789" },
  );

  assert.match(msg.content, /withheld.*ssn/i, "notice names the rule");
  assert.ok(!msg.content.includes("123-45-6789"), "the matched content never appears");
  const audit = await store.listAudit();
  const block = audit.find((e) => e.action === "message.dlp_block" && e.target === msg.id);
  assert.ok(block, "message.dlp_block audited");
  assert.ok(!String(block!.detail).includes("123-45-6789"), "audit detail is rule names, never content");
});

test("DLP flag mode: agent output is appended, flagged, and audited exactly like a human post", async () => {
  const store = new MemoryStore();
  const channel = await makeChannel(store);
  const dlp = new DlpPolicy("flag", [SSN_RULE]);

  const msg = await governedAgentAppend(
    { store, marking, dlp },
    { channelId: channel.id, authorRef: "agent-1", content: "the SSN is 123-45-6789" },
  );

  assert.equal(msg.content, "the SSN is 123-45-6789", "flag mode persists the content");
  assert.deepEqual(msg.dlpFlags, ["ssn"], "flags ride the enriched result for live display");
  const audit = await store.listAudit();
  assert.ok(audit.some((e) => e.action === "message.dlp_flag" && e.target === msg.id));
});

test("clean output in an unmarked channel: floor marking, no flags, no extra audit", async () => {
  const store = new MemoryStore();
  const channel = await makeChannel(store);
  const dlp = new DlpPolicy("block", [SSN_RULE]);

  const msg = await governedAgentAppend(
    { store, marking, dlp },
    { channelId: channel.id, authorRef: "agent-1", content: "nothing sensitive here" },
  );

  assert.equal(msg.marking, "UNCLASSIFIED");
  assert.equal(msg.dlpFlags, undefined);
  const audit = await store.listAudit();
  assert.ok(!audit.some((e) => e.action.startsWith("message.dlp")), "no DLP audit for a clean post");
});
