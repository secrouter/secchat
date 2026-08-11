// interactive-runner: the dev demo Runner that actually exercises the execute-gate — unlike
// echo-runner (which never requests a tool), this one turns mutating-sounding input into a real
// "bash" tool_request and then narrates the gate's verdict back as chat output. Exercised directly
// against the Runner contract (src/types.ts) with a recording onEvent handler — no control plane
// involved, so this only proves the runner's own behavior: the start banner, the mutating-intent
// regex (tool_request vs. plain output), answerTool surfacing allow/deny as "ran"/"blocked" text,
// the pendingInput map staying correct under interleaved requests, and stop's exit event.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Id, Runner, RunnerEvent } from "../src/types.ts";
import { makeInteractiveRunner } from "../src/agent/interactive-runner.ts";

const SESSION_ID: Id = "sess-1";

/** Registers the runner's single onEvent handler and records every (sessionId, event) pair, in
 * order — mirrors how the control plane's one handler sees every event across every session. */
function recordEvents(runner: Runner): Array<{ sessionId: Id; event: RunnerEvent }> {
  const events: Array<{ sessionId: Id; event: RunnerEvent }> = [];
  runner.onEvent((sessionId, event) => {
    events.push({ sessionId, event });
  });
  return events;
}

/** Narrows a recorded event to its tool_request variant, failing loudly if it isn't one. */
function asToolRequest(event: RunnerEvent | undefined): Extract<RunnerEvent, { type: "tool_request" }> {
  assert.equal(event?.type, "tool_request");
  return event as Extract<RunnerEvent, { type: "tool_request" }>;
}

test("start emits the ready banner for the given session", async () => {
  const runner = makeInteractiveRunner();
  const events = recordEvents(runner);

  await runner.start({ sessionId: SESSION_ID, agentId: "agent-1", ownerSub: "owner-1" });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    sessionId: SESSION_ID,
    event: { type: "output", text: "▸ coding session ready (interactive demo runner)" },
  });
});

test("sendInput with a mutating verb echoes the ask, then requests the bash tool", async () => {
  const runner = makeInteractiveRunner();
  const events = recordEvents(runner);

  await runner.sendInput(SESSION_ID, "build the app");

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { sessionId: SESSION_ID, event: { type: "output", text: "· build the app" } });

  assert.equal(events[1]?.sessionId, SESSION_ID);
  const request = asToolRequest(events[1]?.event);
  assert.equal(request.tool, "bash");
  assert.equal(request.input, "build the app");
  assert.match(request.requestId, /^req-\d+$/);
  assert.equal(request.turnId, request.requestId.replace("req-", "turn-")); // same counter tick
});

test("sendInput without a mutating verb only echoes and suggests — no tool_request", async () => {
  const runner = makeInteractiveRunner();
  const events = recordEvents(runner);

  await runner.sendInput(SESSION_ID, "hello there");

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { sessionId: SESSION_ID, event: { type: "output", text: "· hello there" } });
  assert.deepEqual(events[1], {
    sessionId: SESSION_ID,
    event: { type: "output", text: "(demo runner — connect your desktop app to run a real coding agent)" },
  });
  assert.equal(
    events.some((e) => e.event.type === "tool_request"),
    false,
  );
});

test("answerTool with allow:true surfaces the gate's decision as a 'ran' output naming the original input", async () => {
  const runner = makeInteractiveRunner();
  const events = recordEvents(runner);

  await runner.sendInput(SESSION_ID, "build the app");
  const { requestId } = asToolRequest(events[1]?.event);

  await runner.answerTool(SESSION_ID, requestId, { allow: true, reason: "owner grant" });

  assert.equal(events.length, 3);
  assert.deepEqual(events[2], {
    sessionId: SESSION_ID,
    event: { type: "output", text: "✓ ran: build the app" },
  });
});

test("answerTool with allow:false surfaces a 'blocked' output containing the gate's reason", async () => {
  const runner = makeInteractiveRunner();
  const events = recordEvents(runner);

  await runner.sendInput(SESSION_ID, "deploy the service"); // a fresh request
  const { requestId } = asToolRequest(events[1]?.event);

  await runner.answerTool(SESSION_ID, requestId, { allow: false, reason: "plan mode" });

  assert.equal(events.length, 3);
  const output = events[2]?.event;
  assert.equal(output?.type, "output");
  assert.match((output as { text: string }).text, /blocked/);
  assert.match((output as { text: string }).text, /plan mode/);
  assert.deepEqual(events[2], {
    sessionId: SESSION_ID,
    event: { type: "output", text: "✗ blocked: plan mode" },
  });
});

test("two interleaved tool requests are tracked independently, in the pendingInput map, and resolve correctly answered out of order", async () => {
  const runner = makeInteractiveRunner();
  const events = recordEvents(runner);

  await runner.sendInput(SESSION_ID, "build the app");
  const first = asToolRequest(events[1]?.event);

  await runner.sendInput(SESSION_ID, "run the tests");
  const second = asToolRequest(events[3]?.event);

  assert.notEqual(first.requestId, second.requestId);

  // Answer the SECOND request first — its resolved text must be "run the tests", not "build the app".
  await runner.answerTool(SESSION_ID, second.requestId, { allow: true, reason: "owner grant" });
  assert.deepEqual(events[4], { sessionId: SESSION_ID, event: { type: "output", text: "✓ ran: run the tests" } });

  // Then the first — still resolves to its own original text, unaffected by the earlier answer.
  await runner.answerTool(SESSION_ID, first.requestId, { allow: false, reason: "plan mode" });
  assert.deepEqual(events[5], { sessionId: SESSION_ID, event: { type: "output", text: "✗ blocked: plan mode" } });
});

test("answerTool for an unrecognized requestId does not throw and still emits a decision output", async () => {
  const runner = makeInteractiveRunner();
  const events = recordEvents(runner);

  await runner.answerTool(SESSION_ID, "req-never-requested", { allow: true, reason: "owner grant" });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    sessionId: SESSION_ID,
    event: { type: "output", text: "✓ ran: (unknown request)" },
  });
});

test("stop emits an exit event with code 0", async () => {
  const runner = makeInteractiveRunner();
  const events = recordEvents(runner);

  await runner.stop(SESSION_ID);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { sessionId: SESSION_ID, event: { type: "exit", code: 0 } });
});

test("no events are emitted before onEvent registers a handler (no throw)", async () => {
  const runner = makeInteractiveRunner();
  // Deliberately no recordEvents() call — exercises the emit?.(...) guard on a fresh runner.
  await assert.doesNotReject(runner.start({ sessionId: SESSION_ID, agentId: "agent-1", ownerSub: "owner-1" }));
  await assert.doesNotReject(runner.sendInput(SESSION_ID, "build the app"));
});
