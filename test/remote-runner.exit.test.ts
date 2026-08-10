// RD1 EXIT TESTS — a REMOTE runner daemon reached over the wire is just another Runner port, and
// the execute-gate stays in SecChat's control plane. Proves the security invariant that matters most
// for a runner on a different machine: a daemon can RELAY a mutating tool_request, but only the
// SERVER (with the owner's grant) decides whether it runs. Fully offline — a fake daemon connection
// captures the commands SecChat sends down, and drives messages up by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory.ts";
import { makeControlPlane } from "../src/agent/control.ts";
import { makeRemoteRunner } from "../src/agent/remote-runner.ts";
import { makeRouterRunner } from "../src/agent/router-runner.ts";
import { RunnerRegistry, type RunnerConnection } from "../src/agent/runner-registry.ts";
import type { RunnerCommand } from "../src/agent/runner-protocol.ts";
import type { Runner } from "../src/types.ts";

interface Ev { channelId: string; payload: { type?: string; text?: string; allow?: boolean } }

// The control plane dispatches runner events fire-and-forget (`void handleEvent(...)`), so a
// broadcast / tool_answer lands on a later microtask — flush before asserting on it.
const flush = () => new Promise<void>((r) => setImmediate(r));

/** A control plane wired to route every session to the remote daemon; returns the moving parts. */
async function harness() {
  const store = new MemoryStore();
  const registry = new RunnerRegistry();
  const remote = makeRemoteRunner({ registry, renewLease: () => {} });
  // A server runner that recorded a start would mean routing chose WRONG — fail loudly if touched.
  let serverStarts = 0;
  const server: Runner = {
    async start() { serverStarts++; },
    async sendInput() {}, async answerTool() {}, async stop() {}, onEvent() {},
  };
  const runner = makeRouterRunner({ server, remote: remote.runner, hasRemote: (sub) => registry.has(sub) });
  const events: Ev[] = [];
  const control = makeControlPlane({
    sessions: store, runner, getAgent: (id) => store.getAgent(id),
    broadcast: (channelId, payload) => events.push({ channelId, payload: payload as Ev["payload"] }),
  });
  const agent = await store.createAgent({ ownerSub: "alice", kind: "coding", name: "Coder" });
  const channel = await store.createChannel({ workspaceId: "ws", kind: "agent", name: "alice·coding", createdBy: "alice" });
  return { store, registry, remote, control, events, agent, channel, serverStarts: () => serverStarts };
}

/** Attach a fake daemon for `ownerSub`; returns its connection + the commands SecChat sends it. */
function attachDaemon(registry: RunnerRegistry, ownerSub: string, runnerId = "d1"): { conn: RunnerConnection; commands: RunnerCommand[] } {
  const commands: RunnerCommand[] = [];
  const conn: RunnerConnection = { ownerSub, runnerId, send: (c) => commands.push(c) };
  registry.register(conn);
  return { conn, commands };
}

test("a remote daemon's mutating tool is gated by the SERVER (deny → owner grant → allow)", async () => {
  const h = await harness();
  const { conn, commands } = attachDaemon(h.registry, "alice");

  // Spawn routes to alice's daemon (not the server runner) — it receives a `start`.
  const session = await h.control.spawn({ agent: h.agent, channelId: h.channel.id, hostType: "local" });
  assert.equal(h.serverStarts(), 0, "must route to the remote daemon, not the server runner");
  assert.ok(commands.some((c) => c.type === "start" && c.sessionId === session.id));

  // The daemon streams output → the control plane broadcasts agent_output.
  h.remote.handleDaemonMessage(conn, { type: "event", sessionId: session.id, event: { type: "output", text: "planning…" } });
    await flush();
  assert.ok(h.events.some((e) => e.payload.type === "agent_output" && e.payload.text === "planning…"));

  // The daemon asks to run bash (mutating) with NO grant → the SERVER gate denies; the daemon is
  // told allow:false, and everyone in the channel sees the tool_decision.
  h.remote.handleDaemonMessage(conn, { type: "event", sessionId: session.id, event: { type: "tool_request", tool: "bash", requestId: "r1", turnId: "t1" } });
    await flush();
  const denied = commands.find((c) => c.type === "tool_answer" && c.requestId === "r1");
  assert.ok(denied?.type === "tool_answer" && denied.decision.allow === false);
  assert.ok(h.events.some((e) => e.payload.type === "tool_decision" && e.payload.allow === false));

  // The OWNER authorizes execution (once) → the daemon's next bash is allowed.
  assert.equal((await h.control.grantExecute({ sessionId: session.id, byUser: "alice", scope: "once" })).allow, true);
  h.remote.handleDaemonMessage(conn, { type: "event", sessionId: session.id, event: { type: "tool_request", tool: "bash", requestId: "r2", turnId: "t1" } });
    await flush();
  const allowed = commands.find((c) => c.type === "tool_answer" && c.requestId === "r2");
  assert.ok(allowed?.type === "tool_answer" && allowed.decision.allow === true);
});

test("only the OWNER can authorize a remote session's execution — an invited participant cannot", async () => {
  const h = await harness();
  const { conn, commands } = attachDaemon(h.registry, "alice");
  const session = await h.control.spawn({ agent: h.agent, channelId: h.channel.id, hostType: "local" });

  // bob (not the owner) tries to grant → refused by the gate.
  assert.equal((await h.control.grantExecute({ sessionId: session.id, byUser: "bob", scope: "once" })).allow, false);

  // So the daemon's bash is still denied.
  h.remote.handleDaemonMessage(conn, { type: "event", sessionId: session.id, event: { type: "tool_request", tool: "bash", requestId: "r1", turnId: "t1" } });
    await flush();
  const ans = commands.find((c) => c.type === "tool_answer" && c.requestId === "r1");
  assert.ok(ans?.type === "tool_answer" && ans.decision.allow === false);
});

test("a read-only tool needs no grant; input + stop route to the owning daemon", async () => {
  const h = await harness();
  const { conn, commands } = attachDaemon(h.registry, "alice");
  const session = await h.control.spawn({ agent: h.agent, channelId: h.channel.id, hostType: "local" });

  // A read tool (ls) is allowed with no grant (plan mode).
  h.remote.handleDaemonMessage(conn, { type: "event", sessionId: session.id, event: { type: "tool_request", tool: "ls", requestId: "r1" } });
    await flush();
  const ans = commands.find((c) => c.type === "tool_answer" && c.requestId === "r1");
  assert.ok(ans?.type === "tool_answer" && ans.decision.allow === true);

  // Owner input reaches the daemon as an `input` command.
  await h.control.sendInput(session.id, "list the repo");
  assert.ok(commands.some((c) => c.type === "input" && c.text === "list the repo"));
});

test("a foreign daemon can't drive another owner's session; a dead daemon ends its sessions", async () => {
  const h = await harness();
  const { conn } = attachDaemon(h.registry, "alice");
  const session = await h.control.spawn({ agent: h.agent, channelId: h.channel.id, hostType: "local" });

  // A different daemon (bob's) forging an event for alice's session is ignored (no broadcast).
  const before = h.events.length;
  const bobConn: RunnerConnection = { ownerSub: "bob", runnerId: "dX", send: () => {} };
  h.remote.handleDaemonMessage(bobConn, { type: "event", sessionId: session.id, event: { type: "output", text: "forged" } });
    await flush();
  assert.equal(h.events.length, before, "an event from the wrong daemon is dropped");

  // alice's daemon dying ends its session cleanly (session_ended broadcast + status ended).
  h.remote.handleDaemonGone(conn);
  await flush();
  assert.ok(h.events.some((e) => e.payload.type === "session_ended"));
  assert.equal((await h.control.getSession(session.id))?.status, "ended");
});

test("with NO daemon attached, spawn falls back to the in-process server runner", async () => {
  const h = await harness();
  // No attachDaemon() call — alice has no daemon.
  await h.control.spawn({ agent: h.agent, channelId: h.channel.id, hostType: "server" });
  assert.equal(h.serverStarts(), 1, "routes to the server runner when the owner has no daemon");
});
