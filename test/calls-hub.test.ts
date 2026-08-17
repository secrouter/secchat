// ws/hub.ts's call_* frame handling (docs/plans/voice-calls-plan.md §2.1/§7's explicit test brief:
// "hub-level tests incl. per-connection routing — frames land only on bound connections;
// non-participant relay rejected; size/rate caps enforced"). Most tests here run against a FAKE
// CallRegistry so the hub's OWN routing/caps/fan-out logic is isolated from the state machine
// (already covered offline in test/calls-registry.test.ts); the last two tests use the REAL
// CallRegistry + MemoryStore for end-to-end confidence over real sockets.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";

import { attachWsHub } from "../src/ws/hub.ts";
import { makeCallRegistry, CallSignalError, type CallRegistry, type LiveCall } from "../src/calls/registry.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";
import type { CallMode, VerifyToken } from "../src/types.ts";

const MARKING = makeMarkingPolicy(["UNCLASSIFIED"], "UNCLASSIFIED", []);

/** A fully-stubbed CallRegistry whose behavior each test configures via the `*Impl` fields — isolates
 * ws/hub.ts's own routing/caps/fan-out from the real state machine (tested separately, offline, in
 * test/calls-registry.test.ts). */
class FakeCallRegistry implements CallRegistry {
  inviteImpl: (input: { channelId: string; callerConnId: string; caller: string; wantRecording: boolean }) => Promise<LiveCall> = async () => {
    throw new Error("inviteImpl not configured");
  };
  acceptImpl: (input: { channelId: string; connId: string; consent: boolean }) => Promise<LiveCall | "taken" | "not_ringing"> = async () =>
    "not_ringing";
  relayCalls: Array<{ channelId: string; fromConnId: string; frame: unknown }> = [];
  endCalls: Array<{ channelId: string; connId?: string; sub?: string; reason: "hangup" | "timeout" | "disconnect" }> = [];
  untrackCalls: string[] = [];
  checkRingingTimeoutsImpl: () => Promise<Array<{ channelId: string; caller: string; callee: string }>> = async () => [];

  soloImpl: (input: { channelId: string; connId: string; sub: string; wantRecording: boolean }) => Promise<LiveCall> = async () => {
    throw new Error("soloImpl not configured");
  };

  startGroupImpl: (input: { channelId: string; connId: string; sub: string }) => Promise<LiveCall> = async () => {
    throw new Error("startGroupImpl not configured");
  };
  joinGroupImpl: (input: { channelId: string; connId: string; sub: string }) => Promise<LiveCall> = async () => {
    throw new Error("joinGroupImpl not configured");
  };
  leaveGroupCalls: Array<{ channelId: string; connId: string; sub: string }> = [];

  async invite(input: { channelId: string; callerConnId: string; caller: string; wantRecording: boolean }) {
    return this.inviteImpl(input);
  }
  async startSolo(input: { channelId: string; connId: string; sub: string; wantRecording: boolean }) {
    return this.soloImpl(input);
  }
  async accept(input: { channelId: string; connId: string; consent: boolean }) {
    return this.acceptImpl(input);
  }
  async relay(input: { channelId: string; fromConnId: string; frame: unknown }): Promise<void> {
    this.relayCalls.push(input);
  }
  async end(input: { channelId: string; connId?: string; sub?: string; reason: "hangup" | "timeout" | "disconnect" }): Promise<void> {
    this.endCalls.push(input);
  }
  untrackConnection(connId: string): void {
    this.untrackCalls.push(connId);
  }
  getActiveCall(): LiveCall | undefined {
    return undefined;
  }
  async checkRingingTimeouts() {
    return this.checkRingingTimeoutsImpl();
  }
  async startGroup(input: { channelId: string; connId: string; sub: string }) {
    return this.startGroupImpl(input);
  }
  async joinGroup(input: { channelId: string; connId: string; sub: string }) {
    return this.joinGroupImpl(input);
  }
  async leaveGroup(input: { channelId: string; connId: string; sub: string }): Promise<void> {
    this.leaveGroupCalls.push(input);
  }
}

function makeLiveCall(over: Partial<LiveCall> = {}): LiveCall {
  return { channelId: "chan-1", caller: "alice", callee: "bob", state: "ringing", wantRecording: true, callerConnId: "alice-c1", ...over };
}

const twoUsers: VerifyToken = async (token) => {
  if (token === "alice") return { sub: "alice", groups: [] };
  if (token === "bob") return { sub: "bob", groups: [] };
  throw new Error("invalid token");
};

async function startServer(calls?: CallRegistry, ringingSweepIntervalMs?: number) {
  const server = createServer((_req, res) => res.writeHead(404).end());
  const hub = attachWsHub(server, { verifyToken: twoUsers, calls, ringingSweepIntervalMs });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, hub, port };
}

async function stopServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const opened = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("errored before open")), { once: true });
  });
const nextMessage = (socket: WebSocket) =>
  new Promise<unknown>((resolve) => socket.addEventListener("message", (ev) => resolve(JSON.parse(ev.data as string)), { once: true }));
const closed = (socket: WebSocket) => new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));

// ── call_invite: multi-tab fan-out + error routing ────────────────────────────────────────────

test("call_invite: fans the invite out to EVERY live connection of the callee (multi-tab ring)", async () => {
  const registry = new FakeCallRegistry();
  registry.inviteImpl = async (input) => makeLiveCall({ channelId: input.channelId, caller: input.caller, callee: "bob", callerConnId: input.callerConnId, wantRecording: input.wantRecording });
  const { server, hub, port } = await startServer(registry);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  const bobTab1 = new WebSocket(`ws://127.0.0.1:${port}/?token=bob`);
  const bobTab2 = new WebSocket(`ws://127.0.0.1:${port}/?token=bob`);
  try {
    await Promise.all([opened(alice), opened(bobTab1), opened(bobTab2)]);
    const got1 = nextMessage(bobTab1);
    const got2 = nextMessage(bobTab2);
    alice.send(JSON.stringify({ type: "call_invite", channelId: "chan-1", wantRecording: true }));
    assert.deepEqual(await got1, { type: "call_invite", channelId: "chan-1", from: "alice", wantRecording: true });
    assert.deepEqual(await got2, { type: "call_invite", channelId: "chan-1", from: "alice", wantRecording: true });
  } finally {
    alice.close();
    bobTab1.close();
    bobTab2.close();
    hub.close();
    await stopServer(server);
  }
});

test("call_invite: a rejected invite (CallSignalError) sends call_error back to the SENDER only", async () => {
  const registry = new FakeCallRegistry();
  registry.inviteImpl = async () => {
    throw new CallSignalError("call_active", "a call is already active for this channel");
  };
  const { server, hub, port } = await startServer(registry);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  const bob = new WebSocket(`ws://127.0.0.1:${port}/?token=bob`);
  try {
    await Promise.all([opened(alice), opened(bob)]);
    let bobGot: unknown = null;
    bob.addEventListener("message", (ev) => (bobGot = JSON.parse(ev.data as string)), { once: true });
    const got = nextMessage(alice);
    alice.send(JSON.stringify({ type: "call_invite", channelId: "chan-1", wantRecording: false }));
    assert.deepEqual(await got, { type: "call_error", channelId: "chan-1", error: "call_active", detail: "a call is already active for this channel" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(bobGot, null, "the non-caller never hears about a rejected invite");
  } finally {
    alice.close();
    bob.close();
    hub.close();
    await stopServer(server);
  }
});

// ── call_accept: taken / not_ringing routing ──────────────────────────────────────────────────

test("call_accept: 'taken' is sent back to the losing sender only", async () => {
  const registry = new FakeCallRegistry();
  registry.acceptImpl = async () => "taken";
  const { server, hub, port } = await startServer(registry);
  const bob = new WebSocket(`ws://127.0.0.1:${port}/?token=bob`);
  try {
    await opened(bob);
    const got = nextMessage(bob);
    bob.send(JSON.stringify({ type: "call_accept", channelId: "chan-1", consent: false }));
    assert.deepEqual(await got, { type: "call_taken", channelId: "chan-1" });
  } finally {
    bob.close();
    hub.close();
    await stopServer(server);
  }
});

test("call_accept: 'not_ringing' sends a call_error", async () => {
  const registry = new FakeCallRegistry(); // default acceptImpl -> "not_ringing"
  const { server, hub, port } = await startServer(registry);
  const bob = new WebSocket(`ws://127.0.0.1:${port}/?token=bob`);
  try {
    await opened(bob);
    const got = nextMessage(bob);
    bob.send(JSON.stringify({ type: "call_accept", channelId: "chan-1", consent: true }));
    assert.deepEqual(await got, { type: "call_error", channelId: "chan-1", error: "not_ringing" });
  } finally {
    bob.close();
    hub.close();
    await stopServer(server);
  }
});

test("call_accept: a winning accept calls CallRegistry.accept with the connection's own sub/connId — the hub sends nothing extra itself (the registry owns notifying both bound connections)", async () => {
  const registry = new FakeCallRegistry();
  let seen: { channelId: string; connId: string; consent: boolean } | undefined;
  registry.acceptImpl = async (input) => {
    seen = input;
    return makeLiveCall({ state: "active", calleeConnId: input.connId, mode: "p2p" as CallMode, consent: input.consent });
  };
  const { server, hub, port } = await startServer(registry);
  const bob = new WebSocket(`ws://127.0.0.1:${port}/?token=bob`);
  try {
    await opened(bob);
    let bobGot: unknown = null;
    bob.addEventListener("message", (ev) => (bobGot = JSON.parse(ev.data as string)), { once: true });
    bob.send(JSON.stringify({ type: "call_accept", channelId: "chan-1", consent: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(seen?.channelId, "chan-1");
    assert.equal(seen?.consent, true);
    assert.equal(bobGot, null);
  } finally {
    bob.close();
    hub.close();
    await stopServer(server);
  }
});

// ── call_sdp / call_candidate: relay + size caps ──────────────────────────────────────────────

test("call_sdp: relayed to CallRegistry.relay with the reconstructed frame", async () => {
  const registry = new FakeCallRegistry();
  const { server, hub, port } = await startServer(registry);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  try {
    await opened(alice);
    alice.send(JSON.stringify({ type: "call_sdp", channelId: "chan-1", sdpType: "offer", sdp: "v=0 offer" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(registry.relayCalls.length, 1);
    assert.equal(registry.relayCalls[0]!.channelId, "chan-1");
    assert.deepEqual(registry.relayCalls[0]!.frame, { type: "call_sdp", channelId: "chan-1", sdpType: "offer", sdp: "v=0 offer" });
  } finally {
    alice.close();
    hub.close();
    await stopServer(server);
  }
});

test("call_sdp: an oversized SDP (>32 KiB) is rejected with frame_too_large and NEVER reaches CallRegistry.relay", async () => {
  const registry = new FakeCallRegistry();
  const { server, hub, port } = await startServer(registry);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  try {
    await opened(alice);
    const huge = "x".repeat(33 * 1024);
    const got = nextMessage(alice);
    alice.send(JSON.stringify({ type: "call_sdp", channelId: "chan-1", sdpType: "offer", sdp: huge }));
    assert.deepEqual(await got, { type: "call_error", channelId: "chan-1", error: "frame_too_large" });
    assert.equal(registry.relayCalls.length, 0);
  } finally {
    alice.close();
    hub.close();
    await stopServer(server);
  }
});

test("call_candidate: relayed with sdpMid/sdpMLineIndex null PRESERVED (the WebRTC candidate-completion sentinel)", async () => {
  const registry = new FakeCallRegistry();
  const { server, hub, port } = await startServer(registry);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  try {
    await opened(alice);
    alice.send(JSON.stringify({ type: "call_candidate", channelId: "chan-1", candidate: "", sdpMid: null, sdpMLineIndex: null }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(registry.relayCalls.length, 1);
    const frame = registry.relayCalls[0]!.frame as { sdpMid: unknown; sdpMLineIndex: unknown };
    assert.equal(frame.sdpMid, null);
    assert.equal(frame.sdpMLineIndex, null);
  } finally {
    alice.close();
    hub.close();
    await stopServer(server);
  }
});

test("call_candidate: an oversized candidate string is dropped (never reaches relay)", async () => {
  const registry = new FakeCallRegistry();
  const { server, hub, port } = await startServer(registry);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  try {
    await opened(alice);
    alice.send(JSON.stringify({ type: "call_candidate", channelId: "chan-1", candidate: "x".repeat(33 * 1024) }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(registry.relayCalls.length, 0);
  } finally {
    alice.close();
    hub.close();
    await stopServer(server);
  }
});

test("call_candidate: a connection that floods past the per-connection cap is destroyed (hostile/broken-peer posture)", async () => {
  const registry = new FakeCallRegistry();
  const { server, hub, port } = await startServer(registry);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  try {
    await opened(alice);
    const wasClosed = closed(alice);
    // MAX_CALL_CANDIDATES_PER_CONNECTION is 500 (ws/hub.ts) — send comfortably past it.
    for (let i = 0; i < 501; i++) {
      alice.send(JSON.stringify({ type: "call_candidate", channelId: "chan-1", candidate: `cand-${i}` }));
    }
    await wasClosed;
    assert.ok(registry.relayCalls.length <= 500, "at most the cap's worth of frames were ever relayed");
  } finally {
    hub.close();
    await stopServer(server);
  }
});

// ── call_end + untrackConnection (socket-drop teardown) ───────────────────────────────────────

test("call_end: routed to CallRegistry.end with reason 'hangup' and the sender's sub (a ringing callee's decline must be attributable — registry.end() only recognizes a decline via `sub === live.callee`)", async () => {
  const registry = new FakeCallRegistry();
  const { server, hub, port } = await startServer(registry);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  try {
    await opened(alice);
    alice.send(JSON.stringify({ type: "call_end", channelId: "chan-1" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(registry.endCalls.length, 1);
    assert.equal(registry.endCalls[0]!.reason, "hangup");
    assert.equal(registry.endCalls[0]!.channelId, "chan-1");
    assert.equal(registry.endCalls[0]!.sub, "alice");
  } finally {
    alice.close();
    hub.close();
    await stopServer(server);
  }
});

test("socket-drop: closing a connection calls CallRegistry.untrackConnection (§2.1's socket-drop teardown hook)", async () => {
  const registry = new FakeCallRegistry();
  const { server, hub, port } = await startServer(registry);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  try {
    await opened(alice);
    alice.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(registry.untrackCalls.length, 1);
  } finally {
    hub.close();
    await stopServer(server);
  }
});

test("voice calls not configured: a call_* frame is silently ignored (no crash, no reply)", async () => {
  const { server, hub, port } = await startServer(undefined);
  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  try {
    await opened(alice);
    let gotAnything = false;
    alice.addEventListener("message", () => (gotAnything = true));
    alice.send(JSON.stringify({ type: "call_invite", channelId: "chan-1", wantRecording: false }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(gotAnything, false);
  } finally {
    alice.close();
    hub.close();
    await stopServer(server);
  }
});

// ── end-to-end with the REAL CallRegistry + MemoryStore ───────────────────────────────────────

async function makeDm(store: MemoryStore) {
  const channel = await store.createChannel({ workspaceId: "ws-1", kind: "dm", createdBy: "alice" });
  await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "member" });
  await store.addMember({ channelId: channel.id, memberRef: "bob", memberType: "user", role: "member" });
  return channel;
}

/** Wires a REAL CallRegistry to a REAL hub's connection-scoped send — the same lazy-resolution
 * trick index.ts uses for broadcast/notify/sendToConnection (the hub doesn't exist yet at the point
 * the registry needs to be constructed, and the registry needs to exist before the hub is attached
 * so `deps.calls` can be passed in). */
async function startServerWithRealRegistry(registryOpts: { ringingTimeoutMs?: number } = {}, ringingSweepIntervalMs?: number) {
  const store = new MemoryStore();
  const channel = await makeDm(store);
  const server = createServer((_req, res) => res.writeHead(404).end());
  let hub: ReturnType<typeof attachWsHub> | undefined;
  const sendToConnection = (connId: string, payload: unknown) => hub?.sendToConnection(connId, payload) ?? false;
  const deliverToUser = (sub: string, payload: unknown) => hub?.deliverToUser(sub, payload);
  const registry = makeCallRegistry({
    store,
    send: sendToConnection,
    deliverToUser,
    now: () => Date.now(),
    ringingTimeoutMs: registryOpts.ringingTimeoutMs,
    marking: MARKING,
    broadcast: () => {},
  });
  hub = attachWsHub(server, { verifyToken: twoUsers, calls: registry, ringingSweepIntervalMs });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, hub, port, channel };
}

test("end-to-end (real CallRegistry): invite -> multi-tab ring -> first-accept-wins -> p2p SDP relay -> hangup notifies the other side", async () => {
  const { server, hub, port, channel } = await startServerWithRealRegistry();

  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  const bobTab1 = new WebSocket(`ws://127.0.0.1:${port}/?token=bob`);
  const bobTab2 = new WebSocket(`ws://127.0.0.1:${port}/?token=bob`);
  try {
    await Promise.all([opened(alice), opened(bobTab1), opened(bobTab2)]);

    const ring1 = nextMessage(bobTab1);
    const ring2 = nextMessage(bobTab2);
    alice.send(JSON.stringify({ type: "call_invite", channelId: channel.id, wantRecording: false }));
    assert.deepEqual(await ring1, { type: "call_invite", channelId: channel.id, from: "alice", wantRecording: false });
    assert.deepEqual(await ring2, { type: "call_invite", channelId: channel.id, from: "alice", wantRecording: false });

    const aliceAccepted = nextMessage(alice);
    const tab1Accepted = nextMessage(bobTab1);
    const tab2Taken = nextMessage(bobTab2);
    bobTab1.send(JSON.stringify({ type: "call_accept", channelId: channel.id, consent: false }));
    bobTab2.send(JSON.stringify({ type: "call_accept", channelId: channel.id, consent: false })); // loses the race
    assert.deepEqual(await aliceAccepted, { type: "call_accept", channelId: channel.id, consent: false, mode: "p2p" });
    assert.deepEqual(await tab1Accepted, { type: "call_accept", channelId: channel.id, consent: false, mode: "p2p" });
    assert.deepEqual(await tab2Taken, { type: "call_taken", channelId: channel.id });

    const offerArrives = nextMessage(bobTab1);
    alice.send(JSON.stringify({ type: "call_sdp", channelId: channel.id, sdpType: "offer", sdp: "v=0 alice-offer" }));
    assert.deepEqual(await offerArrives, { type: "call_sdp", channelId: channel.id, sdpType: "offer", sdp: "v=0 alice-offer" });
    // bobTab2 (the losing tab, never bound) must NOT see the SDP relay at all.
    let tab2GotSdp = false;
    bobTab2.addEventListener("message", () => (tab2GotSdp = true));

    const hangupArrives = nextMessage(bobTab1);
    alice.send(JSON.stringify({ type: "call_end", channelId: channel.id }));
    assert.deepEqual(await hangupArrives, { type: "call_end", channelId: channel.id });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(tab2GotSdp, false);
  } finally {
    alice.close();
    bobTab1.close();
    bobTab2.close();
    hub.close();
    await stopServer(server);
  }
});

test("end-to-end (real CallRegistry, short sweep interval): an unanswered ring times out and both members get call_missed", async () => {
  const { server, hub, port, channel } = await startServerWithRealRegistry({ ringingTimeoutMs: 20 }, 15); // sweep every 15ms

  const alice = new WebSocket(`ws://127.0.0.1:${port}/?token=alice`);
  const bob = new WebSocket(`ws://127.0.0.1:${port}/?token=bob`);
  try {
    await Promise.all([opened(alice), opened(bob)]);
    const bobRang = nextMessage(bob);
    alice.send(JSON.stringify({ type: "call_invite", channelId: channel.id, wantRecording: false }));
    await bobRang; // consume the invite so the NEXT message on each socket is the miss signal

    const aliceMissed = nextMessage(alice);
    const bobMissed = nextMessage(bob);
    assert.deepEqual(await aliceMissed, { type: "call_missed", channelId: channel.id });
    assert.deepEqual(await bobMissed, { type: "call_missed", channelId: channel.id });
  } finally {
    alice.close();
    bob.close();
    hub.close();
    await stopServer(server);
  }
});
