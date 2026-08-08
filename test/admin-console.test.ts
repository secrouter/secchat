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
