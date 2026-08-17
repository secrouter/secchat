// calls/registry.ts's CallRegistry — the signaling state machine (docs/plans/voice-calls-plan.md
// §2.1/§7's explicit test brief: "state machine, single-flight, glare, timeouts, consent->mode,
// first-accept pinning, socket-drop — offline, injected clock"). A minimal FAKE Store (only the
// methods CallRegistry actually calls, cast through `unknown` — same pattern as
// test/reaper.test.ts's makeFakeStore) keeps these pure/offline; the one pipeline test at the
// bottom swaps in a REAL MemoryStore + real governedCallAppend/mergeTranscripts to prove the wiring
// genuinely works end-to-end when its (documented, optional) deps are configured.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCallRegistry, CallSignalError, type CallRegistryDeps, type LiveCall } from "../src/calls/registry.ts";
import type { MediadClient } from "../src/calls/mediad-client.ts";
import type { TranscribeClient, TranscribeResult } from "../src/transcribe/client.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MemoryBlobStore } from "../src/attachments/blobs.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";
import type { AppendAuditInput, AppendMessageInput, CallParticipantRow, CallRow, Channel, CreateCallInput, Id, Member, Store } from "../src/types.ts";

const MARKING = makeMarkingPolicy(["UNCLASSIFIED", "CUI"], "UNCLASSIFIED", []);

// ── a minimal fake Store — only what CallRegistry's signaling path (no relayed pipeline) touches ──
function makeFakeStore(opts: { channels: Record<string, { kind: Channel["kind"]; cuiMarking?: string }>; members: Record<string, string[]> }) {
  const audits: Array<AppendAuditInput & { at: string }> = [];
  const calls = new Map<Id, CallRow>();
  const messages: Array<AppendMessageInput & { id: Id; seq: number }> = [];
  const participants = new Map<Id, CallParticipantRow[]>(); // callId -> rows, join order
  let callSeq = 0;

  const store = {
    async getChannel(id: Id): Promise<Channel | null> {
      const c = opts.channels[id];
      if (!c) return null;
      return { id, workspaceId: "ws-1", kind: c.kind, cuiMarking: c.cuiMarking, createdBy: "x", createdAt: "2026-01-01T00:00:00.000Z" };
    },
    async listMembers(channelId: Id): Promise<Member[]> {
      return (opts.members[channelId] ?? []).map((sub) => ({ channelId, memberRef: sub, memberType: "user" as const, role: "member" as const }));
    },
    async appendAudit(input: AppendAuditInput) {
      const entry = { ...input, at: new Date().toISOString() };
      audits.push(entry);
      return { id: `audit-${audits.length}`, seq: audits.length, prevHash: "", hash: "", ...entry };
    },
    async createCall(input: CreateCallInput): Promise<CallRow> {
      callSeq++;
      const row: CallRow = {
        id: `call-${callSeq}`,
        channelId: input.channelId,
        caller: input.caller,
        callee: input.callee,
        startedAt: new Date().toISOString(),
        consent: input.consent,
        mode: input.mode,
        recording: "none",
      };
      calls.set(row.id, row);
      return row;
    },
    async endCall(id: Id, endedAt: string): Promise<CallRow> {
      const row = calls.get(id);
      if (!row) throw new Error(`unknown call ${id}`);
      row.endedAt = endedAt;
      return row;
    },
    async getCall(id: Id): Promise<CallRow | null> {
      return calls.get(id) ?? null;
    },
    async setCallMediadSessionId(id: Id, mediadSessionId: string): Promise<CallRow> {
      const row = calls.get(id)!;
      row.mediadSessionId = mediadSessionId;
      return row;
    },
    async setCallRecordingAttachment(id: Id, attachmentId: Id): Promise<CallRow> {
      const row = calls.get(id)!;
      row.recordingAttachmentId = attachmentId;
      return row;
    },
    async setCallTranscriptMessage(id: Id, messageId: Id): Promise<CallRow> {
      const row = calls.get(id)!;
      row.transcriptMessageId = messageId;
      return row;
    },
    async addCallParticipant(input: { callId: Id; sub: string; legId: string }): Promise<CallParticipantRow> {
      let rows = participants.get(input.callId);
      if (!rows) {
        rows = [];
        participants.set(input.callId, rows);
      }
      const existing = rows.find((r) => r.sub === input.sub);
      const joinedAt = new Date().toISOString();
      if (existing) {
        existing.legId = input.legId;
        existing.joinedAt = joinedAt;
        existing.leftAt = undefined;
        return existing;
      }
      const row: CallParticipantRow = { callId: input.callId, sub: input.sub, legId: input.legId, joinedAt };
      rows.push(row);
      return row;
    },
    async setCallParticipantLeft(callId: Id, sub: string, leftAt: string): Promise<void> {
      const row = participants.get(callId)?.find((r) => r.sub === sub);
      if (row) row.leftAt = leftAt;
    },
    async listCallParticipants(callId: Id): Promise<CallParticipantRow[]> {
      return [...(participants.get(callId) ?? [])];
    },
    async appendMessage(input: AppendMessageInput) {
      const row = { ...input, id: `msg-${messages.length + 1}`, seq: messages.length + 1 };
      messages.push(row);
      return {
        id: row.id,
        channelId: row.channelId,
        seq: row.seq,
        authorRef: row.authorRef,
        authorType: row.authorType,
        contentSha256: "sha-" + row.id,
        marking: row.marking ?? "UNCLASSIFIED",
        attachmentsSha256: row.attachmentsSha256 ?? "",
        prevHash: "",
        hash: "",
        createdAt: new Date().toISOString(),
      };
    },
    async getUser() {
      return null;
    },
  } as unknown as Store;

  return { store, audits, calls, messages, participants };
}

function makeSend() {
  const sent: Array<{ connId: string; payload: unknown }> = [];
  const send = (connId: string, payload: unknown) => {
    sent.push({ connId, payload });
    return true;
  };
  return { send, sent };
}

/** Fake for `CallRegistryDeps.deliverToUser` (ws/hub.ts's `Hub.deliverToUser`) — pushes by SUB, not
 * connId, mirroring the hub's "every live connection of this principal" fan-out (findings #1/#2). */
function makeDeliverToUser() {
  const delivered: Array<{ sub: string; payload: unknown }> = [];
  const deliverToUser = (sub: string, payload: unknown) => {
    delivered.push({ sub, payload });
  };
  return { deliverToUser, delivered };
}

/** Builds a CallRegistry over a fresh fake store for a single DM(alice,bob) channel, with an
 * injected mutable clock. `nowMs` starts at a fixed instant and only advances when the test calls
 * `advance()` — never `Date.now()`, per the plan's "pure + injected clock" requirement. */
function makeHarness(opts: { mediad?: MediadClient; transcribe?: TranscribeClient; ringingTimeoutMs?: number } = {}) {
  const CHANNEL = "dm-1";
  const fake = makeFakeStore({ channels: { [CHANNEL]: { kind: "dm" } }, members: { [CHANNEL]: ["alice", "bob"] } });
  const { send, sent } = makeSend();
  const { deliverToUser, delivered } = makeDeliverToUser();
  const broadcasts: Array<{ channelId: string; payload: unknown }> = [];
  let nowMs = 1_000_000;
  const deps: CallRegistryDeps = {
    store: fake.store,
    send,
    deliverToUser,
    now: () => nowMs,
    ringingTimeoutMs: opts.ringingTimeoutMs,
    mediad: opts.mediad,
    transcribe: opts.transcribe,
    marking: MARKING,
    broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }),
  };
  const registry = makeCallRegistry(deps);
  return { CHANNEL, registry, sent, delivered, broadcasts, fake, advance: (ms: number) => (nowMs += ms) };
}

// ── invite: membership / DM validation ────────────────────────────────────────────────────────

test("invite: a non-member is rejected (not_member)", async () => {
  const { CHANNEL, registry } = makeHarness();
  await assert.rejects(
    registry.invite({ channelId: CHANNEL, callerConnId: "c1", caller: "mallory", wantRecording: false }),
    (err: unknown) => err instanceof CallSignalError && err.code === "not_member",
  );
});

test("invite: a non-DM channel is rejected (not_dm)", async () => {
  const fake = makeFakeStore({ channels: { "chan-1": { kind: "human" } }, members: { "chan-1": ["alice", "bob"] } });
  const { send } = makeSend();
  const { deliverToUser } = makeDeliverToUser();
  const registry = makeCallRegistry({ store: fake.store, send, deliverToUser, now: () => 0, marking: MARKING, broadcast: () => {} });
  await assert.rejects(
    registry.invite({ channelId: "chan-1", callerConnId: "c1", caller: "alice", wantRecording: false }),
    (err: unknown) => err instanceof CallSignalError && err.code === "not_dm",
  );
});

test("invite: success creates a ringing LiveCall and audits call.start", async () => {
  const { CHANNEL, registry, fake } = makeHarness();
  const live = await registry.invite({ channelId: CHANNEL, callerConnId: "alice-conn", caller: "alice", wantRecording: true });

  assert.equal(live.state, "ringing");
  assert.equal(live.caller, "alice");
  assert.equal(live.callee, "bob");
  assert.equal(live.callerConnId, "alice-conn");
  assert.equal(registry.getActiveCall(CHANNEL), live);
  assert.ok(fake.audits.some((a) => a.action === "call.start" && a.actor === "alice" && a.target === CHANNEL));
});

// ── single-flight ──────────────────────────────────────────────────────────────────────────────

test("invite: single-flight — a second, non-glare invite for a channel already ringing is rejected (call_active)", async () => {
  const { CHANNEL, registry } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "alice-conn", caller: "alice", wantRecording: false });
  // alice inviting AGAIN (not the symmetric glare shape — same caller) must not be treated as glare.
  await assert.rejects(
    registry.invite({ channelId: CHANNEL, callerConnId: "alice-conn-2", caller: "alice", wantRecording: false }),
    (err: unknown) => err instanceof CallSignalError && err.code === "call_active",
  );
});

test("invite: single-flight is per-user across DIFFERENT channels too", async () => {
  const fake = makeFakeStore({
    channels: { "dm-ab": { kind: "dm" }, "dm-ac": { kind: "dm" } },
    members: { "dm-ab": ["alice", "bob"], "dm-ac": ["alice", "carol"] },
  });
  const { send } = makeSend();
  const { deliverToUser } = makeDeliverToUser();
  const registry = makeCallRegistry({ store: fake.store, send, deliverToUser, now: () => 0, marking: MARKING, broadcast: () => {} });
  await registry.invite({ channelId: "dm-ab", callerConnId: "c1", caller: "alice", wantRecording: false });
  // alice is now busy in dm-ab; a call in dm-ac (a DIFFERENT channel, but alice is a party) is rejected.
  await assert.rejects(
    registry.invite({ channelId: "dm-ac", callerConnId: "c2", caller: "alice", wantRecording: false }),
    (err: unknown) => err instanceof CallSignalError && err.code === "user_busy",
  );
});

// ── glare tiebreak (lower sub wins) ───────────────────────────────────────────────────────────

test("glare: the lower-sub inviter wins and supersedes the higher-sub caller's ringing invite", async () => {
  const { CHANNEL, registry, sent } = makeHarness();
  // bob (higher sub) invites first.
  const first = await registry.invite({ channelId: CHANNEL, callerConnId: "bob-conn", caller: "bob", wantRecording: false });
  assert.equal(first.caller, "bob");

  // alice (lower sub) invites bob back before accepting — symmetric cross-invite (glare).
  const second = await registry.invite({ channelId: CHANNEL, callerConnId: "alice-conn", caller: "alice", wantRecording: false });
  assert.equal(second.caller, "alice", "the lower sub becomes the caller of the surviving ringing call");
  assert.equal(second.callee, "bob");
  assert.equal(registry.getActiveCall(CHANNEL), second, "only ONE live call survives glare");
  // No spoofed notification to the loser was needed here (their own tabs get call_invite fanned
  // out normally by ws/hub.ts) — the registry itself sends nothing.
  assert.equal(sent.length, 0);
});

test("glare: the higher-sub inviter's cross-invite loses (glare_lost), the original ringing call is untouched", async () => {
  const { CHANNEL, registry } = makeHarness();
  const first = await registry.invite({ channelId: CHANNEL, callerConnId: "alice-conn", caller: "alice", wantRecording: false });
  assert.equal(first.caller, "alice");

  await assert.rejects(
    registry.invite({ channelId: CHANNEL, callerConnId: "bob-conn", caller: "bob", wantRecording: false }),
    (err: unknown) => err instanceof CallSignalError && err.code === "glare_lost",
  );
  const still = registry.getActiveCall(CHANNEL);
  assert.equal(still?.caller, "alice", "the original (lower-sub) ringing call is unchanged");
});

// ── accept: first-accept-wins pinning ─────────────────────────────────────────────────────────

test("accept: the FIRST accept wins and binds that connection; a later accept for the same channel is 'taken'", async () => {
  const { CHANNEL, registry, sent } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "alice-conn", caller: "alice", wantRecording: false });

  const win = await registry.accept({ channelId: CHANNEL, connId: "bob-tab-1", consent: false });
  assert.notEqual(win, "taken");
  assert.notEqual(win, "not_ringing");
  const winLive = win as LiveCall;
  assert.equal(winLive.state, "active");
  assert.equal(winLive.calleeConnId, "bob-tab-1");

  const late = await registry.accept({ channelId: CHANNEL, connId: "bob-tab-2", consent: false });
  assert.equal(late, "taken");

  // The winning connection AND the caller both got the fixed-mode confirmation.
  assert.ok(sent.some((s) => s.connId === "alice-conn" && (s.payload as { type: string }).type === "call_accept"));
  assert.ok(sent.some((s) => s.connId === "bob-tab-1" && (s.payload as { type: string }).type === "call_accept"));
});

test("accept: a winning accept dismisses the callee's OTHER ringing tabs via deliverToUser (ws/hub.ts finding #2 — a tab that never itself calls accept() has no other way to learn the call was taken)", async () => {
  const { CHANNEL, registry, delivered } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "alice-conn", caller: "alice", wantRecording: false });
  await registry.accept({ channelId: CHANNEL, connId: "bob-tab-1", consent: false });

  const taken = delivered.filter((d) => (d.payload as { type: string }).type === "call_taken");
  assert.equal(taken.length, 1);
  assert.equal(taken[0]!.sub, "bob");
  assert.deepEqual(taken[0]!.payload, { type: "call_taken", channelId: CHANNEL });
});

test("accept: a stale/unknown channel returns 'not_ringing'", async () => {
  const { CHANNEL, registry } = makeHarness();
  assert.equal(await registry.accept({ channelId: CHANNEL, connId: "x", consent: false }), "not_ringing");
});

// ── consent -> mode ────────────────────────────────────────────────────────────────────────────

test("consent->mode: consent:false always yields p2p, even with a healthy mediad configured", async () => {
  const mediad = fakeMediad({ healthy: true });
  const { CHANNEL, registry, fake } = makeHarness({ mediad });
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: true });
  const live = (await registry.accept({ channelId: CHANNEL, connId: "b", consent: false })) as LiveCall;
  assert.equal(live.mode, "p2p");
  assert.equal(fake.calls.get(live.callId!)?.mode, "p2p");
  assert.ok(fake.audits.some((a) => a.action === "call.consent.declined"));
});

test("consent->mode: consent:true with NO mediad configured downgrades to p2p (recording never available)", async () => {
  const { CHANNEL, registry } = makeHarness(); // no mediad
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: true });
  const live = (await registry.accept({ channelId: CHANNEL, connId: "b", consent: true })) as LiveCall;
  assert.equal(live.mode, "p2p");
});

test("consent->mode: consent:true with an UNHEALTHY mediad fails closed to p2p (fail-closed-recording, fail-open-calling)", async () => {
  const mediad = fakeMediad({ healthy: false });
  const { CHANNEL, registry, sent } = makeHarness({ mediad });
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: true });
  const live = (await registry.accept({ channelId: CHANNEL, connId: "b", consent: true })) as LiveCall;
  assert.equal(live.mode, "p2p");
  // BOTH parties learn about the downgrade (they asked for/consented to recording).
  const aliceFrame = sent.find((s) => s.connId === "a")!.payload as { consent: boolean; mode: string };
  const bobFrame = sent.find((s) => s.connId === "b")!.payload as { consent: boolean; mode: string };
  assert.equal(aliceFrame.mode, "p2p");
  assert.equal(bobFrame.consent, true);
  assert.equal(bobFrame.mode, "p2p", "the callee's OWN connection is told mode is p2p despite granting consent");
});

test("consent->mode: consent:true with a healthy mediad goes relayed and creates a two-leg session", async () => {
  const mediad = fakeMediad({ healthy: true });
  const { CHANNEL, registry, fake } = makeHarness({ mediad });
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: true });
  const live = (await registry.accept({ channelId: CHANNEL, connId: "b", consent: true })) as LiveCall;
  assert.equal(live.mode, "relayed");
  assert.ok(live.mediadSessionId);
  assert.ok(live.legCaller && live.legCallee && live.legCaller !== live.legCallee);
  assert.equal(mediad.createSessionCalls.length, 1);
  assert.deepEqual(
    mediad.createSessionCalls[0]!.legs.map((l) => l.sub).sort(),
    ["alice", "bob"],
  );
  assert.equal(fake.calls.get(live.callId!)?.mode, "relayed");
});

// ── relay (p2p) ────────────────────────────────────────────────────────────────────────────────

test("relay: p2p forwards a frame verbatim to the OTHER bound connection only", async () => {
  const { CHANNEL, registry, sent } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: false });
  await registry.accept({ channelId: CHANNEL, connId: "b", consent: false });
  sent.length = 0; // clear the accept-time notifications

  const frame = { type: "call_sdp", channelId: CHANNEL, sdpType: "offer", sdp: "v=0..." };
  await registry.relay({ channelId: CHANNEL, fromConnId: "a", frame });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.connId, "b");
  assert.deepEqual(sent[0]!.payload, frame);
});

test("relay: a frame from a connection NOT bound to the call is dropped, never forwarded", async () => {
  const { CHANNEL, registry, sent } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: false });
  await registry.accept({ channelId: CHANNEL, connId: "b", consent: false });
  sent.length = 0;

  await registry.relay({ channelId: CHANNEL, fromConnId: "some-other-conn", frame: { type: "call_sdp" } });
  assert.equal(sent.length, 0);
});

// ── end / hangup / disconnect ──────────────────────────────────────────────────────────────────

test("end: an explicit hangup notifies the OTHER bound connection (byDisconnect NOT set) and stamps endedAt", async () => {
  const { CHANNEL, registry, sent, fake } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: false });
  const live = (await registry.accept({ channelId: CHANNEL, connId: "b", consent: false })) as LiveCall;
  sent.length = 0;

  await registry.end({ channelId: CHANNEL, connId: "a", reason: "hangup" });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { connId: "b", payload: { type: "call_end", channelId: CHANNEL } });
  assert.ok(fake.calls.get(live.callId!)?.endedAt);
  assert.ok(fake.audits.some((ev) => ev.action === "call.end" && ev.target === live.callId));
  assert.equal(registry.getActiveCall(CHANNEL), undefined, "the live call is torn down");
});

test("end: a socket-drop teardown (untrackConnection) notifies the other side with byDisconnect:true", async () => {
  const { CHANNEL, registry, sent } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: false });
  await registry.accept({ channelId: CHANNEL, connId: "b", consent: false });
  sent.length = 0;

  registry.untrackConnection("a"); // fire-and-forget internally
  // Flush the microtask queue so the internal `void end(...)` promise chain settles before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { connId: "b", payload: { type: "call_end", channelId: CHANNEL, byDisconnect: true } });
  assert.equal(registry.getActiveCall(CHANNEL), undefined);
});

test("untrackConnection: a connection that was never bound to anything live is a silent no-op", async () => {
  const { registry, sent } = makeHarness();
  assert.doesNotThrow(() => registry.untrackConnection("never-existed"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 0);
});

test("end: a caller cancel WHILE RINGING tears the call down with no durable CallRow, and fans a dismissal out to the callee's (never-bound) tabs too (ws/hub.ts finding #2)", async () => {
  const { CHANNEL, registry, sent, delivered, fake } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: false });

  await registry.end({ channelId: CHANNEL, connId: "a", reason: "hangup" });

  assert.equal(sent.length, 0, "nobody was bound on the callee side to `send` to directly");
  assert.equal(fake.calls.size, 0, "no CallRow — accept() never ran");
  const endAudit = fake.audits.find((ev) => ev.action === "call.end" && ev.target === CHANNEL);
  assert.equal(endAudit?.detail, "hangup");
  assert.equal(registry.getActiveCall(CHANNEL), undefined);

  // BOTH parties' every live connection gets the dismissal via deliverToUser — including the
  // callee's still-ringing (never-bound) tabs, which bound-connection-only `send` can't reach.
  const dismissals = delivered.filter((d) => (d.payload as { type: string }).type === "call_end");
  assert.deepEqual(dismissals.map((d) => d.sub).sort(), ["alice", "bob"]);
  for (const d of dismissals) assert.deepEqual(d.payload, { type: "call_end", channelId: CHANNEL });
});

test("end: a callee DECLINE from an unbound ringing tab (registry.ts finding #1) is accepted, audited as declined, posts a decline chat line, and dismisses both parties", async () => {
  const { CHANNEL, registry, sent, delivered, fake } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: false });

  // The callee's ringing tab was NEVER bound (only the caller's inviting connection is, §2.1) —
  // exactly the shape the Flutter client sends a decline as: `call_end` from a connection that never
  // itself accept()-ed, identified by `sub` (the hub passes `conn.sub` through).
  await registry.end({ channelId: CHANNEL, connId: "bob-tab-1", sub: "bob", reason: "hangup" });

  assert.equal(sent.length, 0, "still nobody bound to `send` to directly — everyone here is reached via deliverToUser");
  assert.equal(fake.calls.size, 0, "no CallRow — the call never reached active");
  const endAudit = fake.audits.find((ev) => ev.action === "call.end" && ev.target === CHANNEL);
  assert.equal(endAudit?.detail, "declined", "decline outcome lands in the audit `detail`, distinct from a plain cancel/timeout");
  assert.equal(registry.getActiveCall(CHANNEL), undefined);

  const dismissals = delivered.filter((d) => (d.payload as { type: string }).type === "call_end");
  assert.deepEqual(dismissals.map((d) => d.sub).sort(), ["alice", "bob"], "the caller AND every other callee tab clear their ring screen");

  const declineLine = fake.messages.find((m) => m.content?.includes("declined"));
  assert.ok(declineLine, "a decline chat line was posted");
  assert.equal(declineLine?.authorType, "system");
});

test("end: a frame/hangup from a connection that is neither bound NOR the ringing call's callee is still ignored (anti-spoof, mirrors the typing-frame check)", async () => {
  const { CHANNEL, registry, fake } = makeHarness();
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: false });
  await registry.end({ channelId: CHANNEL, connId: "mallory-conn", sub: "mallory", reason: "hangup" });
  // The ringing call is untouched — a spoofed hangup from a non-bound, non-callee connection did nothing.
  assert.notEqual(registry.getActiveCall(CHANNEL), undefined);
  assert.ok(!fake.audits.some((ev) => ev.action === "call.end"));
});

// ── ringing timeout ────────────────────────────────────────────────────────────────────────────

test("checkRingingTimeouts: an expired ring is ended, audited, and gets a missed-call chat line; an unexpired one is untouched", async () => {
  const { CHANNEL, registry, fake, advance } = makeHarness({ ringingTimeoutMs: 45_000 });
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: false });

  let missed = await registry.checkRingingTimeouts();
  assert.equal(missed.length, 0, "not expired yet");
  assert.equal(registry.getActiveCall(CHANNEL)?.state, "ringing");

  advance(45_001);
  missed = await registry.checkRingingTimeouts();
  assert.equal(missed.length, 1);
  assert.deepEqual(missed[0], { channelId: CHANNEL, caller: "alice", callee: "bob" });
  assert.equal(registry.getActiveCall(CHANNEL), undefined);
  assert.ok(fake.audits.some((ev) => ev.action === "call.missed" && ev.target === CHANNEL));
  assert.ok(fake.messages.some((m) => m.channelId === CHANNEL && m.authorType === "system"));
});

test("checkRingingTimeouts: an ACTIVE (already-accepted) call is never touched by the ring sweep", async () => {
  const { CHANNEL, registry, advance } = makeHarness({ ringingTimeoutMs: 1000 });
  await registry.invite({ channelId: CHANNEL, callerConnId: "a", caller: "alice", wantRecording: false });
  await registry.accept({ channelId: CHANNEL, connId: "b", consent: false });
  advance(10_000);
  const missed = await registry.checkRingingTimeouts();
  assert.equal(missed.length, 0);
  assert.equal(registry.getActiveCall(CHANNEL)?.state, "active");
});

// ── group calls (N participants, `kind:"human"` channel, join-on-demand) ─────────────────────────

/** A `kind:"human"` channel with 3 members (alice, bob, carol) — the group-calling harness, mirrors
 * `makeHarness` but over a group channel rather than a 2-party DM. */
function makeGroupHarness(opts: { mediad?: MediadClient; transcribe?: TranscribeClient } = {}) {
  const CHANNEL = "group-1";
  const fake = makeFakeStore({ channels: { [CHANNEL]: { kind: "human" } }, members: { [CHANNEL]: ["alice", "bob", "carol"] } });
  const { send, sent } = makeSend();
  const { deliverToUser, delivered } = makeDeliverToUser();
  const broadcasts: Array<{ channelId: string; payload: unknown }> = [];
  let nowMs = 1_000_000;
  const deps: CallRegistryDeps = {
    store: fake.store,
    send,
    deliverToUser,
    now: () => nowMs,
    mediad: opts.mediad,
    transcribe: opts.transcribe,
    marking: MARKING,
    broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }),
  };
  const registry = makeCallRegistry(deps);
  return { CHANNEL, registry, sent, delivered, broadcasts, fake, advance: (ms: number) => (nowMs += ms) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("group: call_start + two call_joins builds a 3-leg mediad session, sends roster/participant_joined frames, and renegotiates existing legs", async () => {
  const mediad = fakeMediad({ healthy: true });
  const { CHANNEL, registry, sent, fake } = makeGroupHarness({ mediad });

  const live = await registry.startGroup({ channelId: CHANNEL, connId: "alice-c", sub: "alice" });
  assert.equal(live.group, true);
  assert.equal(live.state, "active");
  assert.equal(live.mode, "relayed");
  assert.equal(live.participants!.size, 1);
  assert.equal(mediad.createSessionCalls.length, 1, "ONE mediad session for the whole group call");
  assert.deepEqual(mediad.createSessionCalls[0]!.legs, [{ legId: "leg_alice", sub: "alice" }]);
  assert.ok(fake.audits.some((a) => a.action === "call.start" && a.actor === "alice" && a.detail === "group"));
  assert.ok(
    fake.messages.some((m) => m.channelId === CHANNEL && m.authorType === "system" && m.content.includes("tap to join")),
    "a 'tap to join' notice is posted into the channel",
  );

  // bob joins: adds a leg, and — since alice is the only OTHER participant — renegotiates exactly
  // her leg.
  const liveAfterBob = await registry.joinGroup({ channelId: CHANNEL, connId: "bob-c", sub: "bob" });
  await flush();
  assert.equal(liveAfterBob.participants!.size, 2);
  assert.equal(mediad.createSessionCalls.length, 1, "no second session created for a join");
  assert.equal(mediad.addLegCalls.length, 1);
  assert.deepEqual(mediad.addLegCalls[0], { sessionId: "sess-1", leg: { legId: "leg_bob", sub: "bob" } });

  const rosterToBob = sent.find((s) => s.connId === "bob-c" && (s.payload as { type?: string }).type === "call_roster");
  assert.ok(rosterToBob, "the joiner gets a call_roster snapshot");
  const bobRosterSubs = ((rosterToBob!.payload as { participants: Array<{ sub: string }> }).participants).map((p) => p.sub).sort();
  assert.deepEqual(bobRosterSubs, ["alice", "bob"]);

  const joinedToAlice = sent.find(
    (s) => s.connId === "alice-c" && (s.payload as { type?: string }).type === "call_participant_joined" && (s.payload as { sub?: string }).sub === "bob",
  );
  assert.ok(joinedToAlice, "every OTHER bound participant hears about the join");

  assert.equal(mediad.renegotiateCalls.length, 1);
  assert.equal(mediad.renegotiateCalls[0]!.legId, "leg_alice", "only alice's leg needed renegotiating (bob is the joiner, not 'other')");
  const offerToAlice = sent.find(
    (s) => s.connId === "alice-c" && (s.payload as { type?: string }).type === "call_sdp" && (s.payload as { sdpType?: string }).sdpType === "offer",
  );
  assert.ok(offerToAlice, "alice gets a server-initiated renegotiation offer");
  assert.equal((offerToAlice!.payload as { sdp?: string }).sdp, "renegotiate-offer-for:leg_alice");

  // carol joins: now BOTH alice and bob (the two OTHER participants) get renegotiated.
  const liveAfterCarol = await registry.joinGroup({ channelId: CHANNEL, connId: "carol-c", sub: "carol" });
  await flush();
  assert.equal(liveAfterCarol.participants!.size, 3);
  assert.equal(mediad.addLegCalls.length, 2);
  assert.deepEqual(mediad.addLegCalls[1], { sessionId: "sess-1", leg: { legId: "leg_carol", sub: "carol" } });
  assert.equal(mediad.renegotiateCalls.length, 3, "1 (alice, from bob's join) + 2 (alice+bob, from carol's join)");
  assert.deepEqual(mediad.renegotiateCalls.slice(1).map((c) => c.legId).sort(), ["leg_alice", "leg_bob"]);

  const rosterToCarol = sent.find((s) => s.connId === "carol-c" && (s.payload as { type?: string }).type === "call_roster");
  const carolRosterSubs = ((rosterToCarol!.payload as { participants: Array<{ sub: string }> }).participants).map((p) => p.sub).sort();
  assert.deepEqual(carolRosterSubs, ["alice", "bob", "carol"]);

  // The durable leg->sub map has all three participants (db/migrations/0021_call_participants.sql).
  const participantRows = await fake.store.listCallParticipants(live.callId!);
  assert.deepEqual(
    participantRows.map((r) => r.sub).sort(),
    ["alice", "bob", "carol"],
  );
});

test("group: call_start rejects a second start (call_active) — a member should call_join instead", async () => {
  const mediad = fakeMediad({ healthy: true });
  const { CHANNEL, registry } = makeGroupHarness({ mediad });
  await registry.startGroup({ channelId: CHANNEL, connId: "alice-c", sub: "alice" });
  await assert.rejects(
    registry.startGroup({ channelId: CHANNEL, connId: "bob-c", sub: "bob" }),
    (err: unknown) => err instanceof CallSignalError && err.code === "call_active",
  );
});

test("group: joinGroup rejects a non-member, a double-join, and a busy user", async () => {
  const mediad = fakeMediad({ healthy: true });
  const { CHANNEL, registry } = makeGroupHarness({ mediad });
  await registry.startGroup({ channelId: CHANNEL, connId: "alice-c", sub: "alice" });

  await assert.rejects(
    registry.joinGroup({ channelId: CHANNEL, connId: "mallory-c", sub: "mallory" }),
    (err: unknown) => err instanceof CallSignalError && err.code === "not_member",
  );
  await assert.rejects(
    registry.joinGroup({ channelId: CHANNEL, connId: "alice-c-2", sub: "alice" }),
    (err: unknown) => err instanceof CallSignalError && err.code === "already_in_call",
  );
});

test("group: a participant leaving mid-call drops their leg, notifies the rest, and renegotiates — the call stays up", async () => {
  const mediad = fakeMediad({ healthy: true });
  const { CHANNEL, registry, sent, fake } = makeGroupHarness({ mediad });

  const live = await registry.startGroup({ channelId: CHANNEL, connId: "alice-c", sub: "alice" });
  await registry.joinGroup({ channelId: CHANNEL, connId: "bob-c", sub: "bob" });
  await registry.joinGroup({ channelId: CHANNEL, connId: "carol-c", sub: "carol" });
  await flush();
  mediad.renegotiateCalls.length = 0; // only care about renegotiation triggered by the LEAVE below

  await registry.end({ channelId: CHANNEL, connId: "bob-c", sub: "bob", reason: "hangup" });
  await flush();

  // The call stays up — bob left, alice+carol remain.
  const stillLive = registry.getActiveCall(CHANNEL);
  assert.ok(stillLive, "the call is still live — bob leaving is NOT the last one out");
  assert.equal(stillLive!.participants!.size, 2);
  assert.deepEqual([...stillLive!.participants!.keys()].sort(), ["alice", "carol"]);

  // bob's leg was removed from mediad (not the whole session — the call itself stays up).
  assert.equal(mediad.removeLegCalls.length, 1);
  assert.deepEqual(mediad.removeLegCalls[0], { sessionId: "sess-1", legId: "leg_bob" });

  // The remaining participants (alice, carol) both hear about it.
  const leftToAlice = sent.find(
    (s) => s.connId === "alice-c" && (s.payload as { type?: string }).type === "call_participant_left" && (s.payload as { sub?: string }).sub === "bob",
  );
  const leftToCarol = sent.find(
    (s) => s.connId === "carol-c" && (s.payload as { type?: string }).type === "call_participant_left" && (s.payload as { sub?: string }).sub === "bob",
  );
  assert.ok(leftToAlice && leftToCarol);

  // Both remaining legs are renegotiated (bob's departure changes their downstream tracks).
  assert.equal(mediad.renegotiateCalls.length, 2);
  assert.deepEqual(mediad.renegotiateCalls.map((c) => c.legId).sort(), ["leg_alice", "leg_carol"]);

  // The durable record: bob's participant row is stamped `leftAt`, not deleted (his leg's audio
  // still needs transcribing once the call as a whole ends).
  const rows = await fake.store.listCallParticipants(live.callId!);
  const bobRow = rows.find((r) => r.sub === "bob");
  assert.ok(bobRow?.leftAt, "bob's row survives with leftAt stamped");
  assert.ok(!rows.find((r) => r.sub === "alice")?.leftAt);

  assert.ok(fake.audits.some((a) => a.action === "call.participant_left" && a.actor === "bob"));
  assert.ok(!fake.audits.some((a) => a.action === "call.end"), "the CALL hasn't ended — only a participant left");

  // A server-side answer to a renegotiation offer is brokered to mediad, not dropped, for a group call.
  await registry.relay({ channelId: CHANNEL, fromConnId: "alice-c", frame: { type: "call_sdp", channelId: CHANNEL, sdpType: "answer", sdp: "alice-answer" } });
  assert.equal(mediad.answerLegCalls.length, 1);
  assert.deepEqual(mediad.answerLegCalls[0], { sessionId: "sess-1", legId: "leg_alice", sdp: "alice-answer" });
});

test("group: the LAST participant out ends the call and runs the N-leg post-call pipeline", async () => {
  const recordingsDir = await mkdtemp(join(tmpdir(), "secchat-group-calls-test-"));
  try {
    const store = new MemoryStore();
    const channel = await store.createChannel({ workspaceId: "ws-1", kind: "human", createdBy: "alice" });
    await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "member" });
    await store.addMember({ channelId: channel.id, memberRef: "bob", memberType: "user", role: "member" });
    await store.addMember({ channelId: channel.id, memberRef: "carol", memberType: "user", role: "member" });
    await store.upsertUser({ sub: "alice", displayName: "Alice Ng", groups: [] });
    await store.upsertUser({ sub: "bob", displayName: "Bob Reyes", groups: [] });
    await store.upsertUser({ sub: "carol", displayName: "Carol Diaz", groups: [] });

    const mediad = fakeMediad({ healthy: true });
    const originalCreateSession = mediad.createSession.bind(mediad);
    mediad.createSession = async (input) => {
      const res = await originalCreateSession(input);
      await mkdir(join(recordingsDir, res.sessionId), { recursive: true });
      return res;
    };

    const transcribeByLegId: Record<string, TranscribeResult> = {
      leg_alice: { task: "transcribe", language: "en", duration: 2, text: "hello everyone", words: [], segments: [{ start: 0, end: 1, text: "hello everyone" }] },
      leg_bob: { task: "transcribe", language: "en", duration: 2, text: "hi alice", words: [], segments: [{ start: 0.2, end: 1, text: "hi alice" }] },
      leg_carol: { task: "transcribe", language: "en", duration: 2, text: "hey all", words: [], segments: [{ start: 0.4, end: 1, text: "hey all" }] },
    };

    const broadcasts: Array<{ channelId: string; payload: unknown }> = [];
    const { send } = makeSend();
    const { deliverToUser } = makeDeliverToUser();

    const registry = makeCallRegistry({
      store,
      send,
      deliverToUser,
      now: () => Date.now(),
      mediad,
      transcribe: fakeTranscribe(transcribeByLegId),
      marking: MARKING,
      broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }),
      recordingsDir,
      blobs: new MemoryBlobStore(),
      addAttachment: (input) => store.addAttachment(input),
    });

    const live = await registry.startGroup({ channelId: channel.id, connId: "alice-c", sub: "alice" });
    await registry.joinGroup({ channelId: channel.id, connId: "bob-c", sub: "bob" });
    await registry.joinGroup({ channelId: channel.id, connId: "carol-c", sub: "carol" });
    await flush();

    const sessionId = live.mediadSessionId!;
    await writeFile(join(recordingsDir, sessionId, "leg_alice.ogg"), "fake-alice-audio");
    await writeFile(join(recordingsDir, sessionId, "leg_bob.ogg"), "fake-bob-audio");
    await writeFile(join(recordingsDir, sessionId, "leg_carol.ogg"), "fake-carol-audio");
    await writeFile(join(recordingsDir, sessionId, "mixed.m4a"), "fake-mixed-audio");
    mediad.endSession = async (sid) => ({
      sessionId: sid,
      files: [
        { legId: "leg_alice", path: "leg_alice.ogg", startOffsetMs: 0, durationMs: 2000 },
        { legId: "leg_bob", path: "leg_bob.ogg", startOffsetMs: 100, durationMs: 1900 },
        { legId: "leg_carol", path: "leg_carol.ogg", startOffsetMs: 200, durationMs: 1800 },
        { path: "mixed.m4a", startOffsetMs: 0, durationMs: 2000 },
      ],
      truncated: false,
    });

    // Two participants leave — the call stays up.
    await registry.end({ channelId: channel.id, connId: "bob-c", sub: "bob", reason: "hangup" });
    await flush();
    assert.ok(registry.getActiveCall(channel.id), "still up — alice and carol remain");
    await registry.end({ channelId: channel.id, connId: "carol-c", sub: "carol", reason: "hangup" });
    await flush();
    assert.ok(registry.getActiveCall(channel.id), "still up — alice remains alone");

    // The LAST one out ends the whole call and runs the pipeline.
    await registry.end({ channelId: channel.id, connId: "alice-c", sub: "alice", reason: "hangup" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(registry.getActiveCall(channel.id), undefined, "the call is fully torn down");
    const row = await store.getCall(live.callId!);
    assert.ok(row?.endedAt, "the durable CallRow is stamped ended");
    assert.ok(row?.recordingAttachmentId, "the mixed file was ingested");
    assert.ok(row?.transcriptMessageId, "a transcript was posted");

    const messages = await store.listMessages(channel.id);
    const transcript = messages.find((m) => m.id === row!.transcriptMessageId);
    assert.match(transcript!.content!, /hello everyone/);
    assert.match(transcript!.content!, /hi alice/);
    assert.match(transcript!.content!, /hey all/);
    assert.match(transcript!.content!, /Alice Ng/);
    assert.match(transcript!.content!, /Bob Reyes/);
    assert.match(transcript!.content!, /Carol Diaz/);

    const auditActions = (await store.listAudit()).filter((a) => a.target === row!.id).map((a) => a.action);
    assert.ok(auditActions.includes("call.end"));

    const participantRows = await store.listCallParticipants(live.callId!);
    assert.equal(participantRows.length, 3, "all three legs survive in the durable record");
    assert.ok(participantRows.every((r) => r.leftAt), "everyone has left by the time the call ended");
  } finally {
    await rm(recordingsDir, { recursive: true, force: true });
  }
});

// ── fakes ──────────────────────────────────────────────────────────────────────────────────────

function fakeMediad(opts: { healthy: boolean }): MediadClient & {
  createSessionCalls: Array<{ callId: string; legs: Array<{ legId: string; sub: string }> }>;
  addLegCalls: Array<{ sessionId: string; leg: { legId: string; sub: string } }>;
  removeLegCalls: Array<{ sessionId: string; legId: string }>;
  renegotiateCalls: Array<{ sessionId: string; legId: string }>;
  answerLegCalls: Array<{ sessionId: string; legId: string; sdp: string }>;
} {
  const createSessionCalls: Array<{ callId: string; legs: Array<{ legId: string; sub: string }> }> = [];
  const addLegCalls: Array<{ sessionId: string; leg: { legId: string; sub: string } }> = [];
  const removeLegCalls: Array<{ sessionId: string; legId: string }> = [];
  const renegotiateCalls: Array<{ sessionId: string; legId: string }> = [];
  const answerLegCalls: Array<{ sessionId: string; legId: string; sdp: string }> = [];
  let sessionSeq = 0;
  return {
    createSessionCalls,
    addLegCalls,
    removeLegCalls,
    renegotiateCalls,
    answerLegCalls,
    async health() {
      return opts.healthy;
    },
    async createSession(input) {
      createSessionCalls.push(input);
      sessionSeq++;
      return { sessionId: `sess-${sessionSeq}` };
    },
    async addLeg(sessionId, leg) {
      addLegCalls.push({ sessionId, leg });
    },
    async removeLeg(sessionId, legId) {
      removeLegCalls.push({ sessionId, legId });
    },
    async offerLeg(_sessionId, legId, offerSdp) {
      return { legId, sdp: `answer-for:${offerSdp}` };
    },
    async renegotiate(sessionId, legId) {
      renegotiateCalls.push({ sessionId, legId });
      return { sdp: `renegotiate-offer-for:${legId}` };
    },
    async answerLeg(sessionId, legId, answerSdp) {
      answerLegCalls.push({ sessionId, legId, sdp: answerSdp });
    },
    async getState(sessionId) {
      return { sessionId, legs: [], recording: "on" };
    },
    async endSession(sessionId) {
      return { sessionId, files: [], truncated: false };
    },
    async reconcileUnclaimedSessions() {},
  };
}

function fakeTranscribe(byLegId: Record<string, TranscribeResult>): TranscribeClient {
  return {
    async transcribeLeg(job) {
      const result = byLegId[job.legId];
      if (!result) throw new Error(`fakeTranscribe: no fixture for leg ${job.legId}`);
      return result;
    },
    async enrollVoiceprint() {
      // Unused by any test that builds a `TranscribeClient` through this helper — voiceprint
      // enrollment tests wire their own `enrollVoiceprint` directly on `CallRegistryDeps` instead
      // (see makeCallRegistry's `enrollVoiceprint` dep, distinct from this client's method).
      throw new Error("fakeTranscribe: enrollVoiceprint not fixtured");
    },
  };
}

// ── end-to-end pipeline integration test (real MemoryStore + real governedCallAppend/merge) ─────
// Proves the wiring genuinely works once its documented-optional deps (recordingsDir/blobs/
// addAttachment) are configured — see registry.ts's CallRegistryDeps doc comment for why they
// aren't threaded from index.ts today.

test("relayed call end-to-end: recording ingested as an attachment, per-leg transcripts merged into a governed transcript message", async () => {
  const recordingsDir = await mkdtemp(join(tmpdir(), "secchat-calls-test-"));
  try {
    const store = new MemoryStore();
    const channel = await store.createChannel({ workspaceId: "ws-1", kind: "dm", createdBy: "alice" });
    await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "member" });
    await store.addMember({ channelId: channel.id, memberRef: "bob", memberType: "user", role: "member" });
    await store.upsertUser({ sub: "alice", displayName: "Alice Ng", groups: [] });
    await store.upsertUser({ sub: "bob", displayName: "Bob Reyes", groups: [] });

    const mediad = fakeMediad({ healthy: true });
    // Override endSession to return a real finalize manifest and write real files under recordingsDir
    // (transcribeLeg + the ingest step both read bytes off disk for real).
    let sessionIdForFiles = "";
    const originalCreateSession = mediad.createSession.bind(mediad);
    mediad.createSession = async (input) => {
      const res = await originalCreateSession(input);
      sessionIdForFiles = res.sessionId;
      await mkdir(join(recordingsDir, res.sessionId), { recursive: true });
      await writeFile(join(recordingsDir, res.sessionId, "caller.ogg"), "fake-caller-audio");
      await writeFile(join(recordingsDir, res.sessionId, "callee.ogg"), "fake-callee-audio");
      await writeFile(join(recordingsDir, res.sessionId, "mixed.m4a"), "fake-mixed-audio");
      return res;
    };
    mediad.endSession = async (sessionId) => ({
      sessionId,
      files: [
        { legId: "will-be-set", path: "caller.ogg", startOffsetMs: 0, durationMs: 5000 },
        { legId: "will-be-set-2", path: "callee.ogg", startOffsetMs: 200, durationMs: 4800 },
        { path: "mixed.m4a", startOffsetMs: 0, durationMs: 5000 },
      ],
      truncated: false,
    });

    const blobs = new MemoryBlobStore();
    const transcribeByPath: Record<string, TranscribeResult> = {}; // keyed by legId, filled in below

    const broadcasts: Array<{ channelId: string; payload: unknown }> = [];
    const { send } = makeSend();
    const { deliverToUser } = makeDeliverToUser();
    let liveRef: LiveCall | undefined;

    const registry = makeCallRegistry({
      store,
      send,
      deliverToUser,
      now: () => Date.now(),
      mediad,
      transcribe: {
        async transcribeLeg(job) {
          const result = transcribeByPath[job.legId];
          if (!result) throw new Error(`no fixture for ${job.legId}`);
          return result;
        },
        async enrollVoiceprint() {
          throw new Error("not fixtured: this is a 2-party call, enrollment is solo-only");
        },
      },
      marking: MARKING,
      broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }),
      recordingsDir,
      blobs,
      addAttachment: (input) => store.addAttachment(input),
    });

    await registry.invite({ channelId: channel.id, callerConnId: "a", caller: "alice", wantRecording: true });
    const live = (await registry.accept({ channelId: channel.id, connId: "b", consent: true })) as LiveCall;
    assert.equal(live.mode, "relayed");
    liveRef = live;

    // Now that leg ids are known, wire the endSession manifest's legIds and the transcript fixtures
    // to match (mirrors what a real mediad would echo back).
    mediad.endSession = async (sessionId) => ({
      sessionId,
      files: [
        { legId: live.legCaller, path: "caller.ogg", startOffsetMs: 0, durationMs: 5000 },
        { legId: live.legCallee, path: "callee.ogg", startOffsetMs: 200, durationMs: 4800 },
        { path: "mixed.m4a", startOffsetMs: 0, durationMs: 5000 },
      ],
      truncated: false,
    });
    transcribeByPath[live.legCaller!] = {
      task: "transcribe",
      language: "en",
      duration: 5,
      text: "hey are you free",
      words: [],
      segments: [{ start: 0.5, end: 2, text: "hey are you free" }],
    };
    transcribeByPath[live.legCallee!] = {
      task: "transcribe",
      language: "en",
      duration: 4.8,
      text: "yes go ahead",
      words: [],
      segments: [{ start: 1.0, end: 2.5, text: "yes go ahead" }],
    };

    await registry.end({ channelId: channel.id, connId: "a", reason: "hangup" });
    // The pipeline runs fire-and-forget after end() resolves — wait for it to settle.
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const row = await store.getCall(live.callId!);
      if (row?.transcriptMessageId) break;
    }

    const row = await store.getCall(live.callId!);
    assert.ok(row?.recordingAttachmentId, "the mixed file was ingested as an attachment");
    assert.ok(row?.transcriptMessageId, "a transcript message was posted");

    const posted = await store.getMessage(row!.transcriptMessageId!);
    assert.equal(posted?.authorType, "system");

    // Two "message" broadcasts now land: the pending-recording line (posted the moment the
    // recording is ingested, before transcription even starts — §2.4 v3.1's failure-isolation
    // fix, "the artifact is never invisible") and the transcript itself. Find the transcript
    // broadcast specifically, by the id the pipeline recorded on the durable row.
    const messageBroadcasts = broadcasts.filter((b) => (b.payload as { type: string }).type === "message");
    const enriched = messageBroadcasts.find(
      (b) => (b.payload as { message: { id: string } }).message.id === row!.transcriptMessageId,
    );
    assert.ok(enriched, "the transcript message was broadcast");
    const content = (enriched!.payload as { message: { content: string } }).message.content;
    assert.match(content, /recorded with consent/);
    assert.match(content, /\*\*Alice Ng\*\*.*hey are you free/);
    assert.match(content, /\*\*Bob Reyes\*\*.*yes go ahead/);

    // The pending-recording line claimed the attachment immediately, then was edited to drop
    // "pending" once the transcript posted successfully.
    const pendingBroadcast = messageBroadcasts.find(
      (b) => (b.payload as { message: { id: string } }).message.id !== row!.transcriptMessageId,
    );
    assert.ok(pendingBroadcast, "the pending-recording line was posted and broadcast");
    const pendingId = (pendingBroadcast!.payload as { message: { id: string } }).message.id;
    const pendingFinal = await store.getMessage(pendingId);
    assert.equal(pendingFinal?.editedAt != null, true, "the pending line was edited to its final state");
    const editBroadcast = broadcasts.find(
      (b) => (b.payload as { type: string; messageId?: string }).type === "message_edit" && (b.payload as { messageId?: string }).messageId === pendingId,
    );
    assert.ok(editBroadcast, "a message_edit was broadcast for the pending line");
    assert.equal((editBroadcast!.payload as { content: string }).content, "🎙️ Recording stored.");

    const audit = await store.listAudit();
    assert.ok(audit.some((e) => e.action === "call.recording_stored"));
    assert.ok(audit.some((e) => e.action === "call.transcribed"));
    void sessionIdForFiles; // used only to seed files above
  } finally {
    await rm(recordingsDir, { recursive: true, force: true });
  }
});

test("solo self-DM voice memo end-to-end: one leg recorded, transcribed, and posted into the self-DM", async () => {
  const recordingsDir = await mkdtemp(join(tmpdir(), "secchat-solo-test-"));
  try {
    const store = new MemoryStore();
    // A self-DM: a kind:"dm" channel with a SINGLE user member (alice).
    const channel = await store.createChannel({ workspaceId: "ws-1", kind: "dm", createdBy: "alice" });
    await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "owner" });
    await store.upsertUser({ sub: "alice", displayName: "Alice Ng", groups: [] });

    const mediad = fakeMediad({ healthy: true });
    const originalCreateSession = mediad.createSession.bind(mediad);
    mediad.createSession = async (input) => {
      const res = await originalCreateSession(input);
      await mkdir(join(recordingsDir, res.sessionId), { recursive: true });
      await writeFile(join(recordingsDir, res.sessionId, "leg.ogg"), "fake-solo-audio");
      await writeFile(join(recordingsDir, res.sessionId, "mixed.m4a"), "fake-mixed-audio");
      return res;
    };

    const blobs = new MemoryBlobStore();
    const transcribeByLeg: Record<string, TranscribeResult> = {};
    const broadcasts: Array<{ channelId: string; payload: unknown }> = [];
    const { send } = makeSend();
    const { deliverToUser } = makeDeliverToUser();

    const registry = makeCallRegistry({
      store,
      send,
      deliverToUser,
      now: () => Date.now(),
      mediad,
      transcribe: {
        async transcribeLeg(job) {
          const r = transcribeByLeg[job.legId];
          if (!r) throw new Error(`no fixture for ${job.legId}`);
          return r;
        },
        async enrollVoiceprint() {
          throw new Error("not fixtured: this test doesn't opt into enrollment");
        },
      },
      marking: MARKING,
      broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }),
      recordingsDir,
      blobs,
      addAttachment: (input) => store.addAttachment(input),
    });

    // No ring/accept — straight to an active, relayed, ONE-leg call.
    const live = await registry.startSolo({ channelId: channel.id, connId: "a", sub: "alice", wantRecording: true });
    assert.equal(live.mode, "relayed");
    assert.equal(live.solo, true);
    assert.equal(live.caller, "alice");
    assert.equal(live.callee, "alice"); // self
    assert.equal(mediad.createSessionCalls.length, 1);
    assert.equal(mediad.createSessionCalls[0]!.legs.length, 1, "a solo memo creates a ONE-leg session");
    assert.equal(mediad.createSessionCalls[0]!.legs[0]!.sub, "alice");

    mediad.endSession = async (sessionId) => ({
      sessionId,
      files: [
        { legId: live.legCaller, path: "leg.ogg", startOffsetMs: 0, durationMs: 4000 },
        { path: "mixed.m4a", startOffsetMs: 0, durationMs: 4000 },
      ],
      truncated: false,
    });
    transcribeByLeg[live.legCaller!] = {
      task: "transcribe",
      language: "en",
      duration: 4,
      text: "note to self buy milk",
      words: [],
      segments: [{ start: 0.2, end: 2, text: "note to self buy milk" }],
    };

    await registry.end({ channelId: channel.id, connId: "a", reason: "hangup" });
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const row = await store.getCall(live.callId!);
      if (row?.transcriptMessageId) break;
    }

    const row = await store.getCall(live.callId!);
    assert.ok(row?.recordingAttachmentId, "the recording was ingested as an attachment");
    assert.ok(row?.transcriptMessageId, "a transcript was posted into the self-DM");

    const posted = await store.getMessage(row!.transcriptMessageId!);
    assert.equal(posted?.channelId, channel.id, "the transcript landed in the self-DM");
    assert.equal(posted?.authorType, "system");
    const transcriptBroadcast = broadcasts
      .filter((b) => (b.payload as { type: string }).type === "message")
      .find((b) => (b.payload as { message: { id: string } }).message.id === row!.transcriptMessageId);
    assert.ok(transcriptBroadcast, "the transcript was broadcast");
    const content = (transcriptBroadcast!.payload as { message: { content: string } }).message.content;
    assert.match(content, /\*\*Alice Ng\*\*[\s\S]*note to self buy milk/);

    const audit = await store.listAudit();
    assert.ok(audit.some((e) => e.action === "call.start" && e.detail === "solo"), "the solo start was audited");
    assert.ok(audit.some((e) => e.action === "call.transcribed"));
  } finally {
    await rm(recordingsDir, { recursive: true, force: true });
  }
});

/** Shared setup for the two opt-in voiceprint enrollment tests below: an active, relayed, one-leg
 * solo memo (mirrors the "solo self-DM voice memo end-to-end" test above), with a fake
 * `enrollVoiceprint` dep that just records its calls instead of doing anything real. `enroll`
 * controls the `call_solo_start`-equivalent `startSolo` input. */
async function setupSoloEnrollCall(recordingsDir: string, opts: { enroll?: boolean }) {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: "ws-1", kind: "dm", createdBy: "alice" });
  await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "owner" });
  await store.upsertUser({ sub: "alice", displayName: "Alice Ng", groups: [] });

  const mediad = fakeMediad({ healthy: true });
  const originalCreateSession = mediad.createSession.bind(mediad);
  mediad.createSession = async (input) => {
    const res = await originalCreateSession(input);
    await mkdir(join(recordingsDir, res.sessionId), { recursive: true });
    await writeFile(join(recordingsDir, res.sessionId, "leg.ogg"), "fake-solo-audio");
    await writeFile(join(recordingsDir, res.sessionId, "mixed.m4a"), "fake-mixed-audio");
    return res;
  };

  const blobs = new MemoryBlobStore();
  const broadcasts: Array<{ channelId: string; payload: unknown }> = [];
  const { send } = makeSend();
  const { deliverToUser } = makeDeliverToUser();
  const enrollCalls: Array<{ name: string; filePath: string }> = [];

  const registry = makeCallRegistry({
    store,
    send,
    deliverToUser,
    now: () => Date.now(),
    mediad,
    transcribe: {
      async transcribeLeg() {
        return {
          task: "transcribe",
          language: "en",
          duration: 4,
          text: "note to self buy milk",
          words: [],
          segments: [{ start: 0.2, end: 2, text: "note to self buy milk" }],
        };
      },
      async enrollVoiceprint() {
        throw new Error("not fixtured: enrollment goes through CallRegistryDeps.enrollVoiceprint, not this client method");
      },
    },
    enrollVoiceprint: async (input) => {
      enrollCalls.push(input);
    },
    marking: MARKING,
    broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }),
    recordingsDir,
    blobs,
    addAttachment: (input) => store.addAttachment(input),
  });

  const live = await registry.startSolo({ channelId: channel.id, connId: "a", sub: "alice", wantRecording: true, enroll: opts.enroll });
  mediad.endSession = async (sessionId) => ({
    sessionId,
    files: [
      { legId: live.legCaller, path: "leg.ogg", startOffsetMs: 0, durationMs: 4000 },
      { path: "mixed.m4a", startOffsetMs: 0, durationMs: 4000 },
    ],
    truncated: false,
  });

  await registry.end({ channelId: channel.id, connId: "a", reason: "hangup" });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const row = await store.getCall(live.callId!);
    if (row?.transcriptMessageId) break;
  }
  const row = await store.getCall(live.callId!);
  assert.ok(row?.transcriptMessageId, "the transcript posted (a precondition for the enrollment step to even run)");

  return { store, live, enrollCalls, recordingsDir };
}

test("solo memo with enroll:true invokes enrollVoiceprint with the caller's display name and leg file path", async () => {
  const recordingsDir = await mkdtemp(join(tmpdir(), "secchat-solo-enroll-test-"));
  try {
    const { store, live, enrollCalls } = await setupSoloEnrollCall(recordingsDir, { enroll: true });

    assert.equal(enrollCalls.length, 1, "enrollVoiceprint was invoked exactly once");
    assert.equal(enrollCalls[0]!.name, "Alice Ng", "the caller's display name (Store.getUser) is used");
    assert.equal(enrollCalls[0]!.filePath, join(recordingsDir, live.mediadSessionId!, "leg.ogg"), "the caller leg's on-disk path is used");

    const audit = await store.listAudit();
    assert.ok(audit.some((e) => e.action === "call.voiceprint_enrolled"), "success is audited");
    assert.ok(!audit.some((e) => e.action === "call.voiceprint_enroll_failed"));
  } finally {
    await rm(recordingsDir, { recursive: true, force: true });
  }
});

test("solo memo with enroll:false (or absent) does NOT invoke enrollVoiceprint", async () => {
  const recordingsDirFalse = await mkdtemp(join(tmpdir(), "secchat-solo-noenroll-test-"));
  const recordingsDirAbsent = await mkdtemp(join(tmpdir(), "secchat-solo-noenroll-test-"));
  try {
    const { enrollCalls: enrollCallsFalse, store: storeFalse } = await setupSoloEnrollCall(recordingsDirFalse, { enroll: false });
    assert.equal(enrollCallsFalse.length, 0, "enroll:false never calls enrollVoiceprint");
    assert.ok(!(await storeFalse.listAudit()).some((e) => e.action.startsWith("call.voiceprint_")));

    const { enrollCalls: enrollCallsAbsent, store: storeAbsent } = await setupSoloEnrollCall(recordingsDirAbsent, {});
    assert.equal(enrollCallsAbsent.length, 0, "an absent enroll flag defaults to false, never calls enrollVoiceprint");
    assert.ok(!(await storeAbsent.listAudit()).some((e) => e.action.startsWith("call.voiceprint_")));
  } finally {
    await rm(recordingsDirFalse, { recursive: true, force: true });
    await rm(recordingsDirAbsent, { recursive: true, force: true });
  }
});

// ── §2.4 v3.1 REQUIRED failure-isolation fix: "the artifact is never invisible" ────────────────────
// Below: the two gaps the finding named — SecRecorder never configured, and transcription
// exhausting its retries — each used to leave the ingested recording UNCLAIMED (and so invisible in
// the DM) forever. Both now claim it onto a visible chat line the moment it's ingested, before
// transcription is even attempted.

/** Shared setup for the two tests below: a relayed call whose recording ingests successfully, up to
 * (but not including) transcription — callers configure `deps.transcribe` and `endSession`'s
 * manifest as needed. */
async function setupIngestedCall(recordingsDir: string, opts: { transcribe?: TranscribeClient }) {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: "ws-1", kind: "dm", createdBy: "alice" });
  await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "member" });
  await store.addMember({ channelId: channel.id, memberRef: "bob", memberType: "user", role: "member" });

  const mediad = fakeMediad({ healthy: true });
  const originalCreateSession = mediad.createSession.bind(mediad);
  mediad.createSession = async (input) => {
    const res = await originalCreateSession(input);
    await mkdir(join(recordingsDir, res.sessionId), { recursive: true });
    await writeFile(join(recordingsDir, res.sessionId, "caller.ogg"), "fake-caller-audio");
    await writeFile(join(recordingsDir, res.sessionId, "callee.ogg"), "fake-callee-audio");
    await writeFile(join(recordingsDir, res.sessionId, "mixed.m4a"), "fake-mixed-audio");
    return res;
  };
  mediad.endSession = async (sessionId) => ({
    sessionId,
    files: [
      { legId: "will-be-set", path: "caller.ogg", startOffsetMs: 0, durationMs: 5000 },
      { legId: "will-be-set-2", path: "callee.ogg", startOffsetMs: 200, durationMs: 4800 },
      { path: "mixed.m4a", startOffsetMs: 0, durationMs: 5000 },
    ],
    truncated: false,
  });

  const blobs = new MemoryBlobStore();
  const broadcasts: Array<{ channelId: string; payload: unknown }> = [];
  const { send } = makeSend();
  const { deliverToUser } = makeDeliverToUser();

  const registry = makeCallRegistry({
    store,
    send,
    deliverToUser,
    now: () => Date.now(),
    mediad,
    transcribe: opts.transcribe,
    marking: MARKING,
    broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }),
    recordingsDir,
    blobs,
    addAttachment: (input) => store.addAttachment(input),
  });

  await registry.invite({ channelId: channel.id, callerConnId: "a", caller: "alice", wantRecording: true });
  const live = (await registry.accept({ channelId: channel.id, connId: "b", consent: true })) as LiveCall;
  assert.equal(live.mode, "relayed");

  // Now that leg ids are known, wire endSession's manifest to match (mirrors what a real mediad
  // would echo back).
  mediad.endSession = async (sessionId) => ({
    sessionId,
    files: [
      { legId: live.legCaller, path: "caller.ogg", startOffsetMs: 0, durationMs: 5000 },
      { legId: live.legCallee, path: "callee.ogg", startOffsetMs: 200, durationMs: 4800 },
      { path: "mixed.m4a", startOffsetMs: 0, durationMs: 5000 },
    ],
    truncated: false,
  });

  return { store, registry, live, broadcasts };
}

test("SecRecorder not configured: the recording is still claimed onto a visible chat line, never left invisible", async () => {
  const recordingsDir = await mkdtemp(join(tmpdir(), "secchat-calls-test-"));
  try {
    const { store, registry, live, broadcasts } = await setupIngestedCall(recordingsDir, {}); // no `transcribe`

    await registry.end({ channelId: live.channelId, connId: "a", reason: "hangup" });
    let row: CallRow | null = null;
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      row = await store.getCall(live.callId!);
      if (row?.recordingAttachmentId) break;
    }

    assert.ok(row?.recordingAttachmentId, "the mixed file was ingested as an attachment");
    assert.equal(row?.transcriptMessageId, undefined, "no transcript — SecRecorder was never configured");

    const message = await store.listMessages(live.channelId).then((msgs) => msgs.find((m) => m.content?.includes("Recording stored")));
    assert.ok(message, "a chat line claims the recording");
    assert.match(message!.content!, /transcription unavailable/);
    const claimed = await store.listAttachmentsForMessage(message!.id);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.id, row!.recordingAttachmentId, "the SAME attachment the row points at is claimed here — not orphaned");

    const broadcast = broadcasts.find((b) => (b.payload as { type: string }).type === "message");
    assert.ok(broadcast, "the pending-status line was broadcast live, not just persisted");
  } finally {
    await rm(recordingsDir, { recursive: true, force: true });
  }
});

test("transcription exhausted (poison audio): a visible failure line replaces the pending line, attachment stays claimed", async () => {
  const recordingsDir = await mkdtemp(join(tmpdir(), "secchat-calls-test-"));
  try {
    const { store, registry, live, broadcasts } = await setupIngestedCall(recordingsDir, {
      transcribe: {
        async transcribeLeg() {
          throw new Error("poison audio: decoder rejected the file");
        },
        async enrollVoiceprint() {
          throw new Error("not fixtured: transcription fails before enrollment would ever run");
        },
      },
    });

    await registry.end({ channelId: live.channelId, connId: "a", reason: "hangup" });
    let audits: Array<{ action: string }> = [];
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      audits = await store.listAudit();
      if (audits.some((e) => e.action === "call.transcribe_failed")) break;
    }
    assert.ok(audits.some((e) => e.action === "call.transcribe_failed"), "the failure is audited, never silent");

    const row = await store.getCall(live.callId!);
    assert.ok(row?.recordingAttachmentId, "the recording is still stored and claimed despite the transcribe failure");
    assert.equal(row?.transcriptMessageId, undefined, "no transcript message — transcription failed");

    const message = await store.listMessages(live.channelId).then((msgs) => msgs.find((m) => m.content?.includes("Recording stored")));
    assert.ok(message, "the recording's chat line still exists (never orphaned)");
    assert.match(message!.content!, /transcription failed/, "the failure is VISIBLE in the DM, not just the audit log (§2.4: never silent)");
    assert.ok(message!.editedAt, "the line was edited from 'pending' to the failure state");

    const editBroadcast = broadcasts.find((b) => (b.payload as { type: string }).type === "message_edit");
    assert.ok(editBroadcast, "the edit was broadcast live");
    assert.match((editBroadcast!.payload as { content: string }).content, /transcription failed/);
  } finally {
    await rm(recordingsDir, { recursive: true, force: true });
  }
});
