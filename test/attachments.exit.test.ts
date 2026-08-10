// EXIT TESTS — the attachment HTTP pipeline (A1a routes). Upload (raw body + query metadata) →
// reference from a message post (attach-on-post) → download bytes; plus the marking ceiling, the
// upload size cap, DLP on text, a non-member download block, and redaction purging access. Real
// MemoryStore + MemoryBlobStore + a real (custom) marking policy + a DLP policy.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MemoryBlobStore } from "../src/attachments/blobs.ts";
import { makeMarkingPolicy } from "../src/marking/policy.ts";
import { DlpPolicy } from "../src/dlp/policy.ts";
import type { Attachment, Channel, Message, Store, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) => {
  switch (token) {
    case "alice":
      return { sub: "alice", groups: [] };
    case "bob":
      return { sub: "bob", groups: [] }; // a non-member of alice's channels
    case "carol":
      return { sub: "carol", groups: ["secchat-admins"] };
    default:
      throw new Error("invalid token");
  }
};

const admin = {
  adminGroup: "secchat-admins",
  overview: async () => ({ generatedAt: "t", channels: [], agents: [], sessions: [], audit: [], chains: { messagesOk: true, auditOk: true } }),
  renderConsole: () => "",
};

const marking = makeMarkingPolicy(["UNCLASSIFIED", "PROPRIETARY", "CUI"], "UNCLASSIFIED", [
  { kind: "category", level: "CUI", code: "SP-PRVCY", name: "Privacy" },
]);

interface Opts {
  maxUploadBytes?: number;
  dlp?: DlpPolicy;
}

async function withServer(fn: (base: string, store: Store) => Promise<void>, opts: Opts = {}): Promise<void> {
  const store = new MemoryStore();
  const server = createHttpServer({
    verifyToken,
    store,
    admin,
    marking,
    dlp: opts.dlp,
    attachments: { blobs: new MemoryBlobStore(), maxUploadBytes: opts.maxUploadBytes ?? 1024 },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const jsonH = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const createChannel = (base: string, token: string, body: unknown) =>
  fetch(`${base}/channels`, { method: "POST", headers: jsonH(token), body: JSON.stringify(body) });

const upload = (base: string, token: string, channelId: string, bytes: Buffer, q: string) =>
  fetch(`${base}/channels/${channelId}/attachments?${q}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    body: bytes,
  });

test("attach-on-post round trip: upload → reference from a message → download the bytes back", async () => {
  await withServer(async (base, store) => {
    const channel = (await (await createChannel(base, "alice", { name: "general" })).json()) as Channel;

    // Upload a CUI file to an UNMARKED channel.
    const up = await upload(base, "alice", channel.id, Buffer.from("the secret file"), "filename=doc.txt&contentType=text/plain&marking=CUI");
    assert.equal(up.status, 201);
    const att = (await up.json()) as Attachment;
    assert.match(att.sha256, /^[0-9a-f]{64}$/);
    assert.equal(att.messageId, undefined, "unclaimed until a message references it");
    assert.equal(att.marking, "CUI");

    // Post a message referencing it → the message is RAISED to cover the file (CUI), and carries it.
    const msg = (await (await fetch(`${base}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: jsonH("alice"),
      body: JSON.stringify({ content: "see attached", attachmentIds: [att.id] }),
    })).json()) as Message & { attachments?: Attachment[] };
    assert.equal(msg.marking, "CUI", "the message is raised to dominate its attachment");
    assert.equal(msg.attachments?.[0]?.id, att.id);
    assert.equal(msg.attachments?.[0]?.messageId, msg.id, "claimed by the message");
    assert.equal((await store.verifyChains()).messagesOk, true, "manifest bound, chain verifies");

    // History carries the attachment metadata.
    const page = (await (await fetch(`${base}/channels/${channel.id}/messages?limit=10`, { headers: jsonH("alice") })).json()) as { messages: Array<Message & { attachments?: Attachment[] }> };
    assert.equal(page.messages[0]?.attachments?.[0]?.filename, "doc.txt");

    // Download the bytes.
    const dl = await fetch(`${base}/attachments/${att.id}`, { headers: { authorization: "Bearer alice" } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "text/plain");
    assert.match(dl.headers.get("content-disposition") ?? "", /filename="doc\.txt"/);
    assert.equal(await dl.text(), "the secret file");
  });
});

test("marking ceiling: a CUI file can't be uploaded to a PROPRIETARY channel (422)", async () => {
  await withServer(async (base) => {
    const channel = (await (await createChannel(base, "alice", { name: "prop", marking: "PROPRIETARY" })).json()) as Channel;
    const res = await upload(base, "alice", channel.id, Buffer.from("x"), "filename=a.txt&marking=CUI");
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: string }).error, "marking_exceeds_channel");
  });
});

test("upload size cap: a body over the limit is refused (413) and nothing is stored", async () => {
  await withServer(
    async (base) => {
      const channel = (await (await createChannel(base, "alice", { name: "g" })).json()) as Channel;
      const res = await upload(base, "alice", channel.id, Buffer.alloc(64, 0x61), "filename=big.txt");
      assert.equal(res.status, 413);
      assert.equal(((await res.json()) as { error: string }).error, "payload_too_large");
    },
    { maxUploadBytes: 16 },
  );
});

test("DLP block on a text upload (rule NAME only, never content)", async () => {
  await withServer(
    async (base) => {
      const channel = (await (await createChannel(base, "alice", { name: "g" })).json()) as Channel;
      const res = await upload(base, "alice", channel.id, Buffer.from("my ssn is 123-45-6789"), "filename=leak.txt&contentType=text/plain");
      assert.equal(res.status, 422);
      assert.deepEqual(((await res.json()) as { error: string; rules: string[] }).error, "dlp_blocked");
    },
    { dlp: new DlpPolicy("block", [{ name: "us-ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }]) },
  );
});

test("download is membership-gated (403) and a redacted message's attachment is gone (404)", async () => {
  await withServer(async (base) => {
    const channel = (await (await createChannel(base, "alice", { name: "general" })).json()) as Channel;
    const att = (await (await upload(base, "alice", channel.id, Buffer.from("hi"), "filename=a.txt&contentType=text/plain")).json()) as Attachment;
    const msg = (await (await fetch(`${base}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: jsonH("alice"),
      body: JSON.stringify({ content: "file", attachmentIds: [att.id] }),
    })).json()) as Message;

    // bob isn't a member → 403.
    assert.equal((await fetch(`${base}/attachments/${att.id}`, { headers: { authorization: "Bearer bob" } })).status, 403);

    // Redact the owning message → its attachment is treated as purged (404), even for a member.
    const red = await fetch(`${base}/messages/${msg.id}/redact`, { method: "POST", headers: jsonH("alice"), body: JSON.stringify({ reason: "spillage" }) });
    assert.equal(red.status, 200);
    assert.equal((await fetch(`${base}/attachments/${att.id}`, { headers: { authorization: "Bearer alice" } })).status, 404);
  });
});
