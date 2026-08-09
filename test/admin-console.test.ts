// renderConsole: the admin/audit-review console renders a complete, self-contained HTML
// document from an AdminOverview snapshot. The chain-integrity badge is the compliance
// headline (intact vs BROKEN), and every dynamic value must be HTML-escaped — proven here with
// a channel name carrying a <script> payload.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderConsole } from "../src/admin/console.ts";
import type { AdminOverview } from "../src/types.ts";

/** A small, realistic AdminOverview: one channel ("general"), one agent ("helper"), one audit
 * event ("message.redact"), one session, chains both verified. Returns a fresh object every
 * call so tests never share (or accidentally mutate) each other's state. */
function baseOverview(): AdminOverview {
  return {
    generatedAt: "2026-08-08T12:00:00.000Z",
    channels: [
      {
        id: "chan-1",
        workspaceId: "ws-1",
        kind: "human",
        name: "general",
        cuiMarking: "CUI//SP-PRVCY",
        createdBy: "user-alice",
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    ],
    agents: [
      {
        id: "agent-1",
        ownerSub: "user-alice",
        kind: "assistant",
        name: "helper",
        model: "claude-sonnet",
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    ],
    sessions: [
      {
        id: "sess-1",
        agentId: "agent-1",
        channelId: "chan-1",
        hostType: "server",
        status: "active",
        createdAt: "2026-08-08T00:00:00.000Z",
        leaseExpiresAt: "2026-08-08T01:00:00.000Z",
      },
    ],
    audit: [
      {
        id: "audit-1",
        seq: 1,
        actor: "user-alice",
        action: "message.redact",
        target: "msg-1",
        detail: "CUI spillage",
        prevHash: "0".repeat(64),
        hash: "a".repeat(64),
        at: "2026-08-08T00:00:01.000Z",
      },
    ],
    chains: { messagesOk: true, auditOk: true },
  };
}

test("renders a well-formed document with the channel, agent, audit action, and an intact-chain badge", () => {
  const html = renderConsole(baseOverview());
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("general"), "expected the channel name to appear");
  assert.ok(html.includes("helper"), "expected the agent name to appear");
  assert.ok(html.includes("message.redact"), "expected the audit action to appear");
  assert.ok(html.includes("intact"), "expected the chain-ok badge text to appear");
});

test("the Governance panel summarizes the CUI-lifecycle events with counts", () => {
  const overview = baseOverview();
  overview.audit = [
    { id: "a1", seq: 1, actor: "alice", action: "channel.mark", target: "chan-1", detail: "CUI", prevHash: "0".repeat(64), hash: "b".repeat(64), at: "2026-08-08T00:00:01.000Z" },
    { id: "a2", seq: 2, actor: "alice", action: "message.edit", target: "msg-1", detail: "rev 2", prevHash: "b".repeat(64), hash: "c".repeat(64), at: "2026-08-08T00:00:02.000Z" },
    { id: "a3", seq: 3, actor: "alice", action: "message.dlp_flag", target: "msg-2", detail: "us-ssn", prevHash: "c".repeat(64), hash: "d".repeat(64), at: "2026-08-08T00:00:03.000Z" },
    { id: "a4", seq: 4, actor: "carol", action: "message.redact", target: "msg-2", detail: "spillage", prevHash: "d".repeat(64), hash: "e".repeat(64), at: "2026-08-08T00:00:04.000Z" },
    { id: "a5", seq: 5, actor: "alice", action: "channel.create", target: "chan-1", prevHash: "e".repeat(64), hash: "f".repeat(64), at: "2026-08-08T00:00:05.000Z" },
  ];
  const html = renderConsole(overview);
  assert.ok(html.includes("Governance"), "the governance section is present");
  // Each governance category is labelled; the DLP flag detail (rule name) surfaces.
  for (const label of ["Redactions", "DLP spillage flags", "Classification changes", "Message edits"]) {
    assert.ok(html.includes(label), `expected the "${label}" tile`);
  }
  assert.ok(html.includes("us-ssn"), "the DLP rule name appears in the governance table");
});

test("flips to a CHAIN BROKEN badge (and drops the word 'intact' entirely) when a chain fails verification", () => {
  const overview = baseOverview();
  overview.chains.auditOk = false;

  const html = renderConsole(overview);
  assert.ok(html.includes("BROKEN"), "expected the broken-chain badge text to appear");
  assert.ok(!html.includes("intact"), "the word 'intact' must not appear anywhere once a chain is broken");
});

test("HTML-escapes a hostile channel name — no raw <script> tag reaches the output", () => {
  const overview = baseOverview();
  overview.channels[0]!.name = "<script>alert(1)</script>";

  const html = renderConsole(overview);
  assert.ok(!html.includes("<script>"), "a raw <script> tag must never appear in rendered output");
  // The escaped form should still be present — proving the value was rendered (safely), not
  // silently dropped.
  assert.ok(html.includes("&lt;script&gt;"));
});

test("empty sections render a muted 'none' row instead of a broken table", () => {
  const overview: AdminOverview = {
    generatedAt: "2026-08-08T12:00:00.000Z",
    channels: [],
    agents: [],
    sessions: [],
    audit: [],
    chains: { messagesOk: true, auditOk: true },
  };

  const html = renderConsole(overview);
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("none"));
});
