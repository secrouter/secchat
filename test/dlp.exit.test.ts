// EXIT TESTS — local DLP / spillage detection (Track 2b). A content scanner runs on message post.
// `block` mode refuses a matching post (422, nothing written); `flag` mode posts it but records an
// audited `message.dlp_flag` (RULE NAMES only, never the content) and rides a `dlpFlags` field on the
// live message for a warning indicator. `off` never scans. Real MemoryStore + a capturing broadcast +
// a real DlpPolicy.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http/server.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { DlpPolicy, DEFAULT_DLP_RULES } from "../src/dlp/policy.ts";
import type { Channel, Message, Store, VerifyToken } from "../src/types.ts";

const verifyToken: VerifyToken = async (token) =>
  token === "alice" ? { sub: "alice", groups: [] } : (() => { throw new Error("invalid token"); })();

const h = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

interface Ev {
  channelId: string;
  payload: { type?: string; message?: { id?: string; content?: string; dlpFlags?: string[] } };
}

async function withServer(
  dlp: DlpPolicy,
  fn: (base: string, store: Store, events: Ev[]) => Promise<void>,
): Promise<void> {
  const store = new MemoryStore();
  const events: Ev[] = [];
  const server = createHttpServer({
    verifyToken,
    store,
    dlp,
    broadcast: (channelId, payload) => events.push({ channelId, payload: payload as Ev["payload"] }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store, events);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function seed(base: string): Promise<Channel> {
  return (await (
    await fetch(`${base}/channels`, { method: "POST", headers: h("alice"), body: JSON.stringify({ name: "general" }) })
  ).json()) as Channel;
}

const post = (base: string, channelId: string, content: string) =>
  fetch(`${base}/channels/${channelId}/messages`, { method: "POST", headers: h("alice"), body: JSON.stringify({ content }) });

const SSN = "my ssn is 123-45-6789";
const flagPolicy = new DlpPolicy("flag", [...DEFAULT_DLP_RULES]);
const blockPolicy = new DlpPolicy("block", [...DEFAULT_DLP_RULES]);
const offPolicy = new DlpPolicy("off", [...DEFAULT_DLP_RULES]);

test("flag mode: the message posts, an audited message.dlp_flag is chained (names only), and the live message carries dlpFlags", async () => {
  await withServer(flagPolicy, async (base, store, events) => {
    const channel = await seed(base);
    const res = await post(base, channel.id, SSN);
    assert.equal(res.status, 201);
    const message = (await res.json()) as Message & { dlpFlags?: string[] };
    assert.deepEqual(message.dlpFlags, ["us-ssn"], "the flag rides the response for a live indicator");

    // The message was actually written (flag ≠ block).
    const msgs = (await (await fetch(`${base}/channels/${channel.id}/messages`, { headers: h("alice") })).json()) as Message[];
    assert.equal(msgs.length, 1);

    // A provable, content-free audit record.
    const evt = (await store.listAudit()).find((a) => a.action === "message.dlp_flag" && a.target === message.id);
    assert.ok(evt, "a message.dlp_flag event was chained");
    assert.equal(evt!.actor, "alice");
    assert.equal(evt!.detail, "us-ssn");
    assert.ok(!(evt!.detail ?? "").includes("123-45-6789"), "the audit never contains the matched content");
    assert.equal((await store.verifyChains()).auditOk, true);

    // The live message broadcast also carried the flag.
    assert.ok(events.some((e) => e.payload.type === "message" && e.payload.message?.dlpFlags?.includes("us-ssn")));
  });
});

test("block mode: a matching post is refused (422) and nothing is written", async () => {
  await withServer(blockPolicy, async (base, store) => {
    const channel = await seed(base);
    const res = await post(base, channel.id, SSN);
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: string }).error, "dlp_blocked");
    const msgs = (await (await fetch(`${base}/channels/${channel.id}/messages`, { headers: h("alice") })).json()) as Message[];
    assert.equal(msgs.length, 0, "nothing was appended");
    assert.equal((await store.listAudit()).some((a) => a.action === "message.dlp_flag"), false);
  });
});

test("clean content is never flagged, in any mode", async () => {
  for (const policy of [flagPolicy, blockPolicy]) {
    await withServer(policy, async (base, store) => {
      const channel = await seed(base);
      const res = await post(base, channel.id, "just a normal hello");
      assert.equal(res.status, 201);
      const message = (await res.json()) as Message & { dlpFlags?: string[] };
      assert.equal(message.dlpFlags, undefined, "no dlpFlags field on a clean message");
      assert.equal((await store.listAudit()).some((a) => a.action === "message.dlp_flag"), false);
    });
  }
});

test("off mode: matching content posts with no flag and no audit event", async () => {
  await withServer(offPolicy, async (base, store) => {
    const channel = await seed(base);
    const res = await post(base, channel.id, SSN);
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { dlpFlags?: string[] }).dlpFlags, undefined);
    assert.equal((await store.listAudit()).some((a) => a.action === "message.dlp_flag"), false);
  });
});
