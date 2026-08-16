// Unit tests for calls/mediad-client.ts — the HTTP control-API client (createSession/offerLeg/
// getState/endSession/health) against a fake `fetchImpl` (no real mediad — it doesn't exist yet,
// see the file's own header), plus reconcileUnclaimedSessions' honestly-scoped no-op/logging
// behavior when its optional deps aren't (today's actual deployment) or partially are configured.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeMediadClient, MediadError } from "../src/calls/mediad-client.ts";
import { LEG_CALLEE_ID, LEG_CALLER_ID } from "../src/calls/leg-ids.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MemoryBlobStore } from "../src/attachments/blobs.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";
import type { AddAttachmentInput, Attachment, CallRow, Id } from "../src/types.ts";

const MARKING = makeMarkingPolicy(["UNCLASSIFIED", "CUI"], "UNCLASSIFIED", []);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { impl, calls };
}

test("createSession: POSTs /sessions with the bearer token and callId/legs, returns the sessionId", async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse(201, { sessionId: "sess-1" }));
  const client = makeMediadClient({ baseUrl: "http://mediad.internal:47021", token: "secret-tok", fetchImpl: impl });

  const out = await client.createSession({
    callId: "call-1",
    legs: [
      { legId: "leg-a", sub: "alice" },
      { legId: "leg-b", sub: "bob" },
    ],
  });

  assert.deepEqual(out, { sessionId: "sess-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://mediad.internal:47021/sessions");
  assert.equal(calls[0]!.init!.method, "POST");
  assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, "Bearer secret-tok");
  assert.deepEqual(JSON.parse(calls[0]!.init!.body as string), {
    callId: "call-1",
    legs: [
      { legId: "leg-a", sub: "alice" },
      { legId: "leg-b", sub: "bob" },
    ],
  });
});

test("createSession: strips a trailing slash off baseUrl", async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse(201, { sessionId: "s" }));
  const client = makeMediadClient({ baseUrl: "http://x/", token: "t", fetchImpl: impl });
  await client.createSession({ callId: "c", legs: [{ legId: "a", sub: "x" }, { legId: "b", sub: "y" }] });
  assert.equal(calls[0]!.url, "http://x/sessions");
});

test("offerLeg: POSTs the offer SDP to the leg-scoped URL and returns the answer", async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse(200, { sdp: "v=0 answer" }));
  const client = makeMediadClient({ baseUrl: "http://x", token: "t", fetchImpl: impl });

  const out = await client.offerLeg("sess-1", "leg-a", "v=0 offer");

  assert.deepEqual(out, { legId: "leg-a", sdp: "v=0 answer" });
  assert.equal(calls[0]!.url, "http://x/sessions/sess-1/legs/leg-a/offer");
  assert.deepEqual(JSON.parse(calls[0]!.init!.body as string), { sdp: "v=0 offer" });
});

test("offerLeg: URL-encodes sessionId/legId (defense against a stray path separator)", async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse(200, { sdp: "a" }));
  const client = makeMediadClient({ baseUrl: "http://x", token: "t", fetchImpl: impl });
  await client.offerLeg("sess/1", "leg a", "offer");
  assert.equal(calls[0]!.url, "http://x/sessions/sess%2F1/legs/leg%20a/offer");
});

test("getState: GETs the session and returns leg states + recording", async () => {
  const state = { sessionId: "sess-1", legs: [{ legId: "leg-a", iceState: "connected" }], recording: "on" as const };
  const { impl, calls } = fakeFetch(() => jsonResponse(200, state));
  const client = makeMediadClient({ baseUrl: "http://x", token: "t", fetchImpl: impl });

  const out = await client.getState("sess-1");
  assert.deepEqual(out, state);
  assert.equal(calls[0]!.init!.method, "GET");
});

test("endSession: DELETEs the session and returns the finalize manifest verbatim", async () => {
  const manifest = {
    sessionId: "sess-1",
    files: [
      { legId: "leg-a", path: "leg-a.ogg", startOffsetMs: 0, durationMs: 5000 },
      { legId: "leg-b", path: "leg-b.ogg", startOffsetMs: 180, durationMs: 4900 },
      { path: "mixed.m4a", startOffsetMs: 0, durationMs: 5000 },
    ],
    truncated: false,
  };
  const { impl, calls } = fakeFetch(() => jsonResponse(200, manifest));
  const client = makeMediadClient({ baseUrl: "http://x", token: "t", fetchImpl: impl });

  const out = await client.endSession("sess-1");
  assert.deepEqual(out, manifest);
  assert.equal(calls[0]!.init!.method, "DELETE");
  assert.equal(calls[0]!.url, "http://x/sessions/sess-1");
});

test("a non-2xx response throws MediadError with the error code + detail from the body (§2.6 shape)", async () => {
  const { impl } = fakeFetch(() => jsonResponse(404, { error: "session_not_found" }));
  const client = makeMediadClient({ baseUrl: "http://x", token: "t", fetchImpl: impl });

  await assert.rejects(
    () => client.getState("gone"),
    (err: unknown) => {
      assert.ok(err instanceof MediadError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "session_not_found");
      return true;
    },
  );
});

test("a non-2xx response with a non-JSON body still throws MediadError (falls back to http_<status>)", async () => {
  const { impl } = fakeFetch(() => new Response("plain text 500", { status: 500 }));
  const client = makeMediadClient({ baseUrl: "http://x", token: "t", fetchImpl: impl });
  await assert.rejects(
    () => client.getState("x"),
    (err: unknown) => err instanceof MediadError && err.status === 500 && err.code === "http_500",
  );
});

test("health: true only on a 200 with status:'ok'; false (never throws) on any other outcome", async () => {
  const okClient = makeMediadClient({
    baseUrl: "http://x",
    token: "t",
    fetchImpl: fakeFetch(() => jsonResponse(200, { status: "ok", activeSessions: 0, diskFreeBytes: 1 })).impl,
  });
  assert.equal(await okClient.health(), true);

  const badStatusClient = makeMediadClient({
    baseUrl: "http://x",
    token: "t",
    fetchImpl: fakeFetch(() => jsonResponse(200, { status: "degraded" })).impl,
  });
  assert.equal(await badStatusClient.health(), false);

  const httpErrorClient = makeMediadClient({
    baseUrl: "http://x",
    token: "t",
    fetchImpl: fakeFetch(() => jsonResponse(500, { error: "internal" })).impl,
  });
  assert.equal(await httpErrorClient.health(), false);

  const unreachableClient = makeMediadClient({
    baseUrl: "http://x",
    token: "t",
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  });
  assert.equal(await unreachableClient.health(), false, "unreachable never throws — this IS the availability check");
});

// ── reconcileUnclaimedSessions: the honestly-scoped startup sweep ────────────────────────────────

function callRow(over: Partial<CallRow> = {}): CallRow {
  return {
    id: "call-1",
    channelId: "chan-1",
    caller: "alice",
    callee: "bob",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
    consent: true,
    mode: "relayed",
    recording: "on",
    ...over,
  };
}

test("reconcileUnclaimedSessions: no reconcileStore configured — logs and returns, never throws (index.ts's actual deployment today)", async () => {
  const client = makeMediadClient({ baseUrl: "http://x", token: "t" });
  await assert.doesNotReject(() => client.reconcileUnclaimedSessions());
});

test("reconcileUnclaimedSessions: reconcileStore configured but recordingsDir/blobs/addAttachment aren't — logs and skips ingest, never throws", async () => {
  const listed: CallRow[] = [callRow()];
  const client = makeMediadClient({
    baseUrl: "http://x",
    token: "t",
    reconcileStore: {
      listUnclaimedEndedCalls: async () => listed,
      setCallRecordingAttachment: async (id: Id, attachmentId: Id) => {
        throw new Error(`should never be called (id=${id}, attachmentId=${attachmentId})`);
      },
    },
  });
  await assert.doesNotReject(() => client.reconcileUnclaimedSessions());
});

test("reconcileUnclaimedSessions: a p2p call is never a candidate (it has no mediad session) even if somehow unclaimed", async () => {
  let listedCount = 0;
  const client = makeMediadClient({
    baseUrl: "http://x",
    token: "t",
    recordingsDir: "/does/not/matter",
    blobs: { write: async () => {}, read: async () => null, delete: async () => {} },
    addAttachment: async (_input: AddAttachmentInput): Promise<Attachment> => {
      throw new Error("must not be called for a p2p call");
    },
    reconcileStore: {
      listUnclaimedEndedCalls: async () => {
        listedCount++;
        return [callRow({ mode: "p2p" })];
      },
      setCallRecordingAttachment: async () => {
        throw new Error("must not be called for a p2p call");
      },
    },
  });
  await client.reconcileUnclaimedSessions();
  assert.equal(listedCount, 1, "listUnclaimedEndedCalls was still called");
});

test("reconcileUnclaimedSessions: listUnclaimedEndedCalls failing is logged, never thrown", async () => {
  const client = makeMediadClient({
    baseUrl: "http://x",
    token: "t",
    recordingsDir: "/tmp",
    blobs: { write: async () => {}, read: async () => null, delete: async () => {} },
    addAttachment: async () => {
      throw new Error("must not be called");
    },
    reconcileStore: {
      listUnclaimedEndedCalls: async () => {
        throw new Error("db down");
      },
      setCallRecordingAttachment: async () => {
        throw new Error("must not be called");
      },
    },
  });
  await assert.doesNotReject(() => client.reconcileUnclaimedSessions());
});

test("reconcileUnclaimedSessions: a candidate row with no mediadSessionId is never ingested — nothing to soundly match a session directory to (defensive; every relayed call persists one at accept() post-migration)", async () => {
  let addAttachmentCalls = 0;
  const client = makeMediadClient({
    baseUrl: "http://x",
    token: "t",
    recordingsDir: "/does/not/matter",
    blobs: { write: async () => {}, read: async () => null, delete: async () => {} },
    addAttachment: async (): Promise<Attachment> => {
      addAttachmentCalls++;
      throw new Error("must not be called — no mediadSessionId to reconcile against");
    },
    reconcileStore: {
      listUnclaimedEndedCalls: async () => [callRow()], // no mediadSessionId set
      setCallRecordingAttachment: async () => {
        throw new Error("must not be called");
      },
    },
  });
  await client.reconcileUnclaimedSessions();
  assert.equal(addAttachmentCalls, 0);
});

test("reconcileUnclaimedSessions: an unclaimed relayed call WITH a persisted mediadSessionId is reconciled — ingests the mixed file via the idempotent endSession round trip (§2.4 v3.1 REQUIRED #5)", async () => {
  const sessionId = "sess-orphan-1";
  const manifest = {
    sessionId,
    files: [{ path: "mixed.m4a", startOffsetMs: 0, durationMs: 1000 }],
    truncated: false,
  };
  let endSessionCalls = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    endSessionCalls++;
    assert.equal(init?.method, "DELETE", "reconciliation re-uses endSession (idempotent per voice-contracts.md §2.4), not a manual manifest.json read");
    assert.ok(String(url).endsWith(`/sessions/${sessionId}`));
    return jsonResponse(200, manifest);
  }) as typeof fetch;

  const dir = await mkdtemp(join(tmpdir(), "secchat-mediad-test-"));
  try {
    await mkdir(join(dir, sessionId), { recursive: true });
    await writeFile(join(dir, sessionId, "mixed.m4a"), "audio bytes");

    let addAttachmentCalls = 0;
    let setRecordingAttachmentCalls = 0;
    const client = makeMediadClient({
      baseUrl: "http://x",
      token: "t",
      fetchImpl,
      recordingsDir: dir,
      blobs: { write: async () => {}, read: async () => null, delete: async () => {} },
      addAttachment: async (input: AddAttachmentInput): Promise<Attachment> => {
        addAttachmentCalls++;
        return { id: "att-1", channelId: input.channelId, uploadedBy: input.uploadedBy, filename: input.filename, contentType: input.contentType, byteSize: input.byteSize, sha256: input.sha256, marking: input.marking, createdAt: "now" };
      },
      reconcileStore: {
        listUnclaimedEndedCalls: async () => [callRow({ mediadSessionId: sessionId })],
        setCallRecordingAttachment: async (id: Id, attachmentId: Id) => {
          setRecordingAttachmentCalls++;
          return callRow({ id, recordingAttachmentId: attachmentId });
        },
      },
    });

    await client.reconcileUnclaimedSessions();
    assert.equal(endSessionCalls, 1);
    assert.equal(addAttachmentCalls, 1, "the mixed file was ingested as an attachment");
    assert.equal(setRecordingAttachmentCalls, 1, "the call row was linked to the new attachment");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── §2.4 v3.1 REQUIRED "the artifact is never invisible" — the reconciliation path ─────────────────
// `listAttachmentsForMessage` only returns CLAIMED attachments. Before this fix, `reconcileOneCall`
// ingested the mixed file (addAttachment + setCallRecordingAttachment, a `calls`-row column) but
// never claimed it onto any message, so a reconciled call's recording was durably stored yet
// PERMANENTLY invisible in the DM — the same failure calls/registry.ts's live pipeline was fixed
// for (see test/calls-registry.test.ts's matching tests). These use a REAL MemoryStore (not the
// bare-mock `reconcileStore` above) so `listAttachmentsForMessage` genuinely proves the claim.

test("reconcileUnclaimedSessions: with `pendingRecording` configured, the ingested attachment is CLAIMED onto a visible chat line — never left invisible", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: "ws-1", kind: "dm", createdBy: "alice" });
  await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "member" });
  await store.addMember({ channelId: channel.id, memberRef: "bob", memberType: "user", role: "member" });
  const row = await store.createCall({ channelId: channel.id, caller: "alice", callee: "bob", consent: true, mode: "relayed" });
  const sessionId = "sess-crash-1";
  await store.setCallMediadSessionId(row.id, sessionId);
  await store.endCall(row.id, new Date().toISOString());

  const dir = await mkdtemp(join(tmpdir(), "secchat-mediad-test-"));
  try {
    await mkdir(join(dir, sessionId), { recursive: true });
    await writeFile(join(dir, sessionId, "mixed.m4a"), "fake-mixed-audio");

    const fetchImpl = (async () =>
      jsonResponse(200, {
        sessionId,
        files: [{ path: "mixed.m4a", startOffsetMs: 0, durationMs: 1000 }],
        truncated: false,
      })) as typeof fetch;

    const broadcasts: Array<{ channelId: string; payload: unknown }> = [];
    const client = makeMediadClient({
      baseUrl: "http://x",
      token: "t",
      fetchImpl,
      recordingsDir: dir,
      blobs: new MemoryBlobStore(),
      addAttachment: (input) => store.addAttachment(input),
      reconcileStore: {
        listUnclaimedEndedCalls: () => store.listUnclaimedEndedCalls(),
        setCallRecordingAttachment: (id, attachmentId) => store.setCallRecordingAttachment(id, attachmentId),
      },
      pendingRecording: { store, marking: MARKING, broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }) },
      // no `transcription` — matches the primary crash window (before the live pipeline ever ran).
    });

    await client.reconcileUnclaimedSessions();

    const updated = await store.getCall(row.id);
    assert.ok(updated?.recordingAttachmentId, "the mixed file was ingested as an attachment");

    const message = await store.listMessages(channel.id).then((msgs) => msgs.find((m) => m.content?.includes("Recording stored")));
    assert.ok(message, "a chat line claims the recording — this is the fix: it used to not exist at all");
    assert.match(message!.content!, /transcription unavailable/, "no transcription configured for this reconciliation run");

    const claimed = await store.listAttachmentsForMessage(message!.id);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.id, updated!.recordingAttachmentId, "the SAME attachment the row points at is claimed here — not orphaned");
    assert.notEqual(claimed[0]!.marking, "", "the attachment carries the resolved channel marking, not an empty string");

    const broadcast = broadcasts.find((b) => (b.payload as { type: string }).type === "message");
    assert.ok(broadcast, "the pending-status line was broadcast live, not just persisted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconcileUnclaimedSessions: `pendingRecording` + `transcription` both configured — the reconciled transcript posts and the pending line is edited to its final state", async () => {
  const store = new MemoryStore();
  const channel = await store.createChannel({ workspaceId: "ws-1", kind: "dm", createdBy: "alice" });
  await store.addMember({ channelId: channel.id, memberRef: "alice", memberType: "user", role: "member" });
  await store.addMember({ channelId: channel.id, memberRef: "bob", memberType: "user", role: "member" });
  const row = await store.createCall({ channelId: channel.id, caller: "alice", callee: "bob", consent: true, mode: "relayed" });
  const sessionId = "sess-crash-2";
  await store.setCallMediadSessionId(row.id, sessionId);
  await store.endCall(row.id, new Date().toISOString());

  const dir = await mkdtemp(join(tmpdir(), "secchat-mediad-test-"));
  try {
    await mkdir(join(dir, sessionId), { recursive: true });
    await writeFile(join(dir, sessionId, "caller.ogg"), "fake-caller-audio");
    await writeFile(join(dir, sessionId, "callee.ogg"), "fake-callee-audio");
    await writeFile(join(dir, sessionId, "mixed.m4a"), "fake-mixed-audio");

    const fetchImpl = (async () =>
      jsonResponse(200, {
        sessionId,
        files: [
          { legId: LEG_CALLER_ID, path: "caller.ogg", startOffsetMs: 0, durationMs: 5000 },
          { legId: LEG_CALLEE_ID, path: "callee.ogg", startOffsetMs: 200, durationMs: 4800 },
          { path: "mixed.m4a", startOffsetMs: 0, durationMs: 5000 },
        ],
        truncated: false,
      })) as typeof fetch;

    const broadcasts: Array<{ channelId: string; payload: unknown }> = [];
    const client = makeMediadClient({
      baseUrl: "http://x",
      token: "t",
      fetchImpl,
      recordingsDir: dir,
      blobs: new MemoryBlobStore(),
      addAttachment: (input) => store.addAttachment(input),
      reconcileStore: {
        listUnclaimedEndedCalls: () => store.listUnclaimedEndedCalls(),
        setCallRecordingAttachment: (id, attachmentId) => store.setCallRecordingAttachment(id, attachmentId),
      },
      pendingRecording: { store, marking: MARKING, broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }) },
      transcription: {
        store,
        marking: MARKING,
        broadcast: (channelId, payload) => broadcasts.push({ channelId, payload }),
        transcribe: {
          async transcribeLeg(job) {
            const text = job.legId === LEG_CALLER_ID ? "hey are you free" : "yes go ahead";
            return { task: "transcribe", language: "en", duration: 5, text, words: [], segments: [{ start: 0.5, end: 2, text }] };
          },
          async enrollVoiceprint() {
            throw new Error("not fixtured: reconciliation's crash-recovery sweep doesn't enroll voiceprints");
          },
        },
      },
    });

    await client.reconcileUnclaimedSessions();

    const updated = await store.getCall(row.id);
    assert.ok(updated?.recordingAttachmentId, "the mixed file was ingested as an attachment");
    assert.ok(updated?.transcriptMessageId, "a transcript message was posted");

    const allMessages = await store.listMessages(channel.id);
    const posted = allMessages.find((m) => m.id === updated!.transcriptMessageId);
    assert.match(posted!.content!, /hey are you free/);
    assert.match(posted!.content!, /yes go ahead/);

    const pending = await store
      .listMessages(channel.id)
      .then((msgs) => msgs.find((m) => m.content?.includes("Recording stored") && m.id !== updated!.transcriptMessageId));
    assert.ok(pending, "the pending-recording line still exists — the SAME line the attachment was claimed onto");
    assert.equal(pending!.content, "🎙️ Recording stored.", "edited from 'pending' to its final state once the transcript posted");
    assert.ok(pending!.editedAt, "the edit is reflected on the row");

    const editBroadcast = broadcasts.find(
      (b) => (b.payload as { type: string; messageId?: string }).type === "message_edit" && (b.payload as { messageId?: string }).messageId === pending!.id,
    );
    assert.ok(editBroadcast, "the edit was broadcast live");
    assert.equal((editBroadcast!.payload as { content: string }).content, "🎙️ Recording stored.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
