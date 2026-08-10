// RD3 EXIT TEST — the daemon bridge (src/daemon/runner-client.ts) with a FAKE local runner + fake
// transport (no socket, no pi). Proves the daemon translates SecChat's RunnerCommands into local
// Runner calls, forwards the runner's events UP, and — critically — never decides tool authorization
// itself: a tool_request goes up undecided and the verdict comes back as a tool_answer command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRunnerClient } from "../src/daemon/runner-client.ts";
import type { Id, Runner, RunnerEvent } from "../src/types.ts";
import type { RunnerMessage } from "../src/agent/runner-protocol.ts";

function fakeRunner() {
  const calls: string[] = [];
  let emit: ((sessionId: Id, event: RunnerEvent) => void) | null = null;
  const runner: Runner = {
    async start(input) { calls.push(`start:${input.sessionId}`); },
    async sendInput(sessionId, text) { calls.push(`input:${sessionId}:${text}`); },
    async answerTool(_sessionId, requestId, decision) { calls.push(`answer:${requestId}:${decision.allow}`); },
    async stop(sessionId) { calls.push(`stop:${sessionId}`); },
    onEvent(cb) { emit = cb; },
  };
  return { runner, calls, emit: (sid: Id, ev: RunnerEvent) => emit?.(sid, ev) };
}

test("daemon bridge: commands drive the runner, events go up, and the gate is NOT decided locally", async () => {
  const f = fakeRunner();
  const sent: RunnerMessage[] = [];
  const client = makeRunnerClient({ runner: f.runner, send: (m) => sent.push(m) });

  client.hello();
  assert.ok(sent.some((m) => m.type === "register"));

  // A `start` command starts the local runner and tracks the session.
  await client.handleCommand(JSON.stringify({ type: "start", sessionId: "s1", agentId: "a1", ownerSub: "alice" }));
  assert.ok(f.calls.includes("start:s1"));
  assert.deepEqual(client.sessions(), ["s1"]);

  // A runner output event is forwarded up as an `event` message.
  f.emit("s1", { type: "output", text: "hello" });
  assert.ok(sent.some((m) => m.type === "event" && m.sessionId === "s1" && m.event.type === "output"));

  // A tool_request goes UP undecided (the daemon never gates); SecChat's verdict comes back down.
  f.emit("s1", { type: "tool_request", tool: "bash", requestId: "r1" });
  assert.ok(sent.some((m) => m.type === "event" && m.event.type === "tool_request"));
  await client.handleCommand(JSON.stringify({ type: "tool_answer", sessionId: "s1", requestId: "r1", decision: { allow: true, reason: "owner grant" } }));
  assert.ok(f.calls.includes("answer:r1:true"));

  // Owner input routes to the runner.
  await client.handleCommand(JSON.stringify({ type: "input", sessionId: "s1", text: "go" }));
  assert.ok(f.calls.includes("input:s1:go"));

  // A heartbeat reports the live session so its lease doesn't lapse.
  sent.length = 0;
  client.beat();
  assert.ok(sent.some((m) => m.type === "heartbeat" && m.sessionIds?.includes("s1")));

  // Exit forgets the session — an idle daemon then sends no heartbeat.
  f.emit("s1", { type: "exit" });
  assert.deepEqual(client.sessions(), []);
  sent.length = 0;
  client.beat();
  assert.equal(sent.length, 0);
});

test("daemon bridge: a malformed command frame is ignored, not thrown", async () => {
  const f = fakeRunner();
  const client = makeRunnerClient({ runner: f.runner, send: () => {} });
  await client.handleCommand("not json");
  await client.handleCommand(JSON.stringify({ type: "start" })); // missing fields
  assert.deepEqual(f.calls, []);
});
