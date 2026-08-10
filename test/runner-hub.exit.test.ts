// RD2 EXIT TESTS — the /runner attach endpoint end to end over a REAL WebSocket (Node's built-in
// client, no `ws` package). A daemon authenticates, is registered as its owner's runner, receives a
// `start` when a coding session is spawned, streams events up, and has its mutating tool gated by
// the server. Proves the whole remote path — socket → registry → RemoteRunner → control plane / gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "../src/store/memory.ts";
import { makeControlPlane } from "../src/agent/control.ts";
import { makeRemoteRunner } from "../src/agent/remote-runner.ts";
import { makeRouterRunner } from "../src/agent/router-runner.ts";
import { RunnerRegistry } from "../src/agent/runner-registry.ts";
import { attachRunnerHub } from "../src/ws/runner-hub.ts";
import type { Runner, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  if (token === "alice") return { sub: "alice", groups: [] };
  throw new Error("invalid token");
};

async function waitFor(pred: () => boolean, ms = 1500): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function start() {
  const store = new MemoryStore();
  const registry = new RunnerRegistry();
  const remote = makeRemoteRunner({ registry, renewLease: () => {} });
  const serverRunner: Runner = { async start() {}, async sendInput() {}, async answerTool() {}, async stop() {}, onEvent() {} };
  const runner = makeRouterRunner({ server: serverRunner, remote: remote.runner, hasRemote: (s) => registry.has(s) });
  const events: Array<{ payload: { type?: string; text?: string; allow?: boolean } }> = [];
  const control = makeControlPlane({ sessions: store, runner, getAgent: (id) => store.getAgent(id), broadcast: (_c, payload) => events.push({ payload: payload as { type?: string } }) });
  const server = createServer((_req, res) => res.writeHead(404).end());
  const hub = attachRunnerHub(server, { verifyToken, registry, remote });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const agent = await store.createAgent({ ownerSub: "alice", kind: "coding", name: "Coder" });
  const channel = await store.createChannel({ workspaceId: "ws", kind: "agent", name: "c", createdBy: "alice" });
  return { store, registry, control, events, server, hub, port, agent, channel };
}

test("a daemon attaches over /runner, receives start, streams output, and its bash is server-gated", async () => {
  const h = await start();
  const msgs: Array<{ type?: string; sessionId?: string; requestId?: string; decision?: { allow: boolean } }> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${h.port}/runner?token=alice`);
  socket.addEventListener("message", (ev) => msgs.push(JSON.parse(ev.data as string)));
  try {
    await new Promise<void>((res, rej) => {
      socket.addEventListener("open", () => res(), { once: true });
      socket.addEventListener("error", () => rej(new Error("open failed")), { once: true });
    });
    await waitFor(() => h.registry.has("alice")); // registered on connect

    // Spawn a coding session for alice → routed to the attached daemon → it receives `start`.
    const session = await h.control.spawn({ agent: h.agent, channelId: h.channel.id, hostType: "local" });
    await waitFor(() => msgs.some((m) => m.type === "start" && m.sessionId === session.id));

    // Daemon streams output up → the server broadcasts agent_output.
    socket.send(JSON.stringify({ type: "event", sessionId: session.id, event: { type: "output", text: "hi" } }));
    await waitFor(() => h.events.some((e) => e.payload.type === "agent_output" && e.payload.text === "hi"));

    // Daemon asks to run bash with no grant → the SERVER gate denies; the daemon gets allow:false.
    socket.send(JSON.stringify({ type: "event", sessionId: session.id, event: { type: "tool_request", tool: "bash", requestId: "r1" } }));
    await waitFor(() => msgs.some((m) => m.type === "tool_answer" && m.requestId === "r1" && m.decision?.allow === false));

    // The owner grants → the daemon's next bash is allowed.
    await h.control.grantExecute({ sessionId: session.id, byUser: "alice", scope: "once" });
    socket.send(JSON.stringify({ type: "event", sessionId: session.id, event: { type: "tool_request", tool: "bash", requestId: "r2" } }));
    await waitFor(() => msgs.some((m) => m.type === "tool_answer" && m.requestId === "r2" && m.decision?.allow === true));
  } finally {
    socket.close();
    h.hub.close();
    await new Promise<void>((r) => h.server.close(() => r()));
  }
});

test("a daemon presenting an invalid token is rejected and never opens", async () => {
  const h = await start();
  const socket = new WebSocket(`ws://127.0.0.1:${h.port}/runner?token=nope`);
  try {
    const outcome = await new Promise<"open" | "rejected">((res) => {
      socket.addEventListener("open", () => res("open"), { once: true });
      socket.addEventListener("error", () => res("rejected"), { once: true });
      socket.addEventListener("close", () => res("rejected"), { once: true });
    });
    assert.equal(outcome, "rejected");
    assert.equal(h.registry.has("alice"), false);
  } finally {
    h.hub.close();
    await new Promise<void>((r) => h.server.close(() => r()));
  }
});
