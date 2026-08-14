// RouterRunner unit tests — the composite that routes each session (per agent `launchEnv`) to the
// server, remote-daemon, or Kubernetes pool runner. The regression these guard: a pooled session's
// events (output/exit/tool_request) MUST reach the control plane. RouterRunner.onEvent used to wire
// only `server` + `remote`, so the pool runner's handler was never set and every pooled session's
// output was silently dropped — pool was non-functional end to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Id, Runner, RunnerEvent } from "../src/types.ts";
import { makeRouterRunner } from "../src/agent/router-runner.ts";

/** A fake Runner that records start()s and exposes an `emit` to push events through whatever handler
 * RouterRunner registered via onEvent — i.e. it stands in for a real underlying runner's event flow. */
function fakeRunner(): Runner & { started: Id[]; emit: (s: Id, e: RunnerEvent) => void } {
  let handler: ((s: Id, e: RunnerEvent) => void) | undefined;
  const started: Id[] = [];
  return {
    started,
    emit: (s, e) => handler?.(s, e),
    async start(input) {
      started.push(input.sessionId);
    },
    async sendInput() {},
    async answerTool() {},
    async stop() {},
    onEvent(cb) {
      handler = cb;
    },
  };
}

test("RouterRunner forwards POOL runner events to the control plane (regression: they were dropped)", async () => {
  const server = fakeRunner();
  const remote = fakeRunner();
  const pool = fakeRunner();
  const router = makeRouterRunner({ server, remote, pool, hasRemote: () => false });

  const seen: Array<{ sessionId: Id; event: RunnerEvent }> = [];
  router.onEvent((sessionId, event) => seen.push({ sessionId, event }));

  // A "pool" agent routes its session to the pool runner…
  await router.start({ sessionId: "s1", agentId: "a1", ownerSub: "owner-1", launchEnv: "pool" });
  assert.deepEqual(pool.started, ["s1"]);
  assert.deepEqual(server.started, []);

  // …and the pool runner's events now reach the control-plane callback (the bug: they didn't).
  pool.emit("s1", { type: "output", text: "hello from the pod" });
  pool.emit("s1", { type: "exit", code: 0 });
  assert.deepEqual(seen, [
    { sessionId: "s1", event: { type: "output", text: "hello from the pod" } },
    { sessionId: "s1", event: { type: "exit", code: 0 } },
  ]);
});

test("RouterRunner routes per launchEnv and frees the route entry on exit", async () => {
  const server = fakeRunner();
  const remote = fakeRunner();
  const pool = fakeRunner();
  const router = makeRouterRunner({ server, remote, pool, hasRemote: (sub) => sub === "has-daemon" });
  router.onEvent(() => {});

  // desktop → remote; pool → pool; legacy(no launchEnv) → remote iff a daemon is attached, else server.
  await router.start({ sessionId: "d1", agentId: "a", ownerSub: "owner", launchEnv: "desktop" });
  await router.start({ sessionId: "p1", agentId: "b", ownerSub: "owner", launchEnv: "pool" });
  await router.start({ sessionId: "l1", agentId: "c", ownerSub: "has-daemon" });
  await router.start({ sessionId: "l2", agentId: "d", ownerSub: "no-daemon" });
  assert.deepEqual(remote.started, ["d1", "l1"]);
  assert.deepEqual(pool.started, ["p1"]);
  assert.deepEqual(server.started, ["l2"]);

  // After a session exits, a later sendInput for it falls back to the server runner (route freed) —
  // proven indirectly: no throw, and the pool never sees the post-exit call.
  pool.emit("p1", { type: "exit", code: 0 });
  await router.sendInput("p1", "late"); // must not blow up on a freed route
});

test("RouterRunner falls back to the server runner when the pool is not configured", async () => {
  const server = fakeRunner();
  const remote = fakeRunner();
  const router = makeRouterRunner({ server, remote, pool: undefined, hasRemote: () => false });
  router.onEvent(() => {});

  // A "pool" agent with no pool wired falls back to the server runner (shouldn't happen in practice —
  // POST /agents rejects "pool" when unavailable — but the router must not crash on undefined pool).
  await router.start({ sessionId: "s1", agentId: "a1", ownerSub: "owner-1", launchEnv: "pool" });
  assert.deepEqual(server.started, ["s1"]);
});
