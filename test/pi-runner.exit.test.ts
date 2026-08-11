// Sprint 5 EXIT TEST — the REAL pi coding-agent runner, end to end, against a real `pi` subprocess
// (no fakes on that side) and a scripted in-process mock of an OpenAI-completions upstream (no
// network). Mirrors interactive.exit.test.ts's shape (drive the SAME control plane + gate.ts a
// stub runner already proves) but through the real Runner protocol this time: a mutating tool
// request is gate-DENIED in plan mode — and pi provably never runs the command — then ALLOWED
// once the owner grants execute, and this time pi's REAL tool output flows back into chat.
//
// Requires an installed pi 0.84.1 CLI (`npm i @earendil-works/pi-coding-agent@0.84.1` in a scratch
// dir — see the task notes; not a dependency of this package, see pi-runner.ts's header comment)
// reachable via `PI_BIN` or on `PATH`. Skips cleanly (not a failure) when neither is found, so this
// suite stays green in environments that never installed pi.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { accessSync, constants as fsConstants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter as pathDelimiter, join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { makeControlPlane } from "../src/agent/control.ts";
import { makePiRunner, resolveMountPath } from "../src/agent/pi-runner.ts";
import { MemoryStore } from "../src/store/memory.ts";

test("resolveMountPath: expands ~ , resolves relative to home, leaves absolute alone", () => {
  assert.equal(resolveMountPath("~"), homedir());
  assert.equal(resolveMountPath("~/project"), pathJoin(homedir(), "project"));
  assert.equal(resolveMountPath("  ~/agent_test/  "), pathJoin(homedir(), "agent_test"));
  assert.equal(resolveMountPath("repo"), pathJoin(homedir(), "repo")); // bare relative → under home
  assert.equal(resolveMountPath("/Users/me/project"), "/Users/me/project");
});

// ── Locate pi, exactly like pi-runner.ts's own PI_BIN resolution (env override, else PATH) ────

function resolveBin(name: string): string | undefined {
  const candidates = name.includes("/")
    ? [name]
    : (process.env.PATH ?? "")
        .split(pathDelimiter)
        .filter((dir) => dir.length > 0)
        .map((dir) => pathJoin(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here — keep looking
    }
  }
  return undefined;
}

const PI_BIN = resolveBin(process.env.PI_BIN?.trim() || "pi");

// ── A tiny scripted OpenAI-completions upstream ─────────────────────────────────────────────
//
// Streaming only: pi's openai-completions provider unconditionally sends `stream: true` (verified
// against the installed package's source — packages/ai/src/api/openai-completions.js always sets
// `params.stream = true`, with no non-streaming code path at all), so a non-streaming branch here
// would be untested dead code, not extra coverage.

interface MockMessage {
  role?: unknown;
  content?: unknown;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? ((block as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

function sseChunk(res: import("node:http").ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** Scripted turns: (a) a plain "hello from pi" reply to a greeting; (b) an assistant turn that
 * calls the bash tool with {"command":"ls"} when the latest user message contains "run ls"; (c) a
 * plain "done" reply otherwise — in particular for the follow-up call pi makes once a tool result
 * (blocked OR real) is fed back, which arrives as the last message with role "tool". */
function startMockModelServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let counter = 0;
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: { messages?: MockMessage[] };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: MockMessage[] };
      } catch {
        res.writeHead(400).end();
        return;
      }
      const messages = body.messages ?? [];
      const last = messages[messages.length - 1];
      const lastText = last ? extractText(last.content) : "";
      const base = { id: `chatcmpl-${++counter}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "secrouter-test-model" };

      res.writeHead(200, { "content-type": "text/event-stream" });

      if (last?.role === "user" && lastText.includes("run ls")) {
        sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }, finish_reason: null }] });
        sseChunk(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "ls" }) } }] }, finish_reason: null }] });
        sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else if (last?.role === "user" && /\b(hi|hello)\b/i.test(lastText)) {
        sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "hello from pi" }, finish_reason: null }] });
        sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else {
        sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] });
        sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ── Test plumbing ────────────────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real subprocess + real event-loop round trips are slower than the in-memory fakes the rest of
 * this suite uses — a generous timeout with a short poll, never a wall-clock sleep on its own. */
async function waitFor<T>(get: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await delay(25);
  }
}

type Broadcast = { type: string; text?: string; allow?: boolean; tool?: string; reason?: string };

test(
  "pi coding agent: greets over the mock model, gate-denies 'run ls' in plan mode (pi never runs it), then allows and actually executes it after the owner grants",
  { skip: PI_BIN ? false : "pi binary not found on PI_BIN/PATH — install @earendil-works/pi-coding-agent@0.84.1 and set PI_BIN to run this exit test" },
  async () => {
    const mock = await startMockModelServer();
    // A real workspace with a known file in it, so an actually-executed `ls` is unambiguous —
    // this is what tells the ALLOW phase apart from a coincidentally-plausible-looking fake.
    const workspace = mkdtempSync(pathJoin(tmpdir(), "secchat-pi-exit-test-"));
    writeFileSync(pathJoin(workspace, "secchat-marker.txt"), "present\n", "utf8");

    const store = new MemoryStore();
    const events: Broadcast[] = [];
    const runner = makePiRunner({
      piBin: PI_BIN,
      baseUrl: mock.baseUrl,
      provider: "secrouter-test",
      model: "secrouter-test-model",
      apiKey: "unused",
      workspace,
    });
    const control = makeControlPlane({
      sessions: store,
      runner,
      getAgent: (id) => store.getAgent(id),
      broadcast: (_channelId, payload) => events.push(payload as Broadcast),
    });

    let sessionId: string | undefined;
    try {
      const agent = await store.createAgent({ ownerSub: "owner-1", kind: "coding", name: "Pi Bot" });
      const channel = await store.createChannel({ workspaceId: "ws", kind: "agent", name: "pi", createdBy: "owner-1" });
      await store.addMember({ channelId: channel.id, memberRef: "owner-1", memberType: "user", role: "owner" });
      await store.addMember({ channelId: channel.id, memberRef: agent.id, memberType: "agent", role: "member" });

      const session = await control.spawn({ agent, channelId: channel.id, hostType: "server" });
      sessionId = session.id;

      // 1. A greeting turn streams an agent_output containing the assistant's text.
      await control.sendInput(session.id, "hello there");
      const greeting = await waitFor(() => events.find((e) => e.type === "agent_output" && /hello from pi/.test(e.text ?? "")));
      assert.match(greeting.text ?? "", /hello from pi/);

      // 2. Plan mode: "run ls" produces a bash tool_request that the gate DENIES (no execute
      //    grant yet) — surfaced as a tool_decision(allow:false) and a "blocked" agent_output.
      const beforeDeny = events.length;
      await control.sendInput(session.id, "please run ls");
      const denied = await waitFor(() => events.find((e, i) => i >= beforeDeny && e.type === "tool_decision" && e.tool === "bash" && e.allow === false));
      assert.equal(denied.reason, "mutating tool requires the owner to authorize execution (plan mode)");
      const deniedOutput = await waitFor(() => events.find((e, i) => i >= beforeDeny && e.type === "agent_output" && /blocked/i.test(e.text ?? "")));
      assert.match(deniedOutput.text ?? "", /plan mode/);
      // The point of the gate: pi must never have actually run the command while denied.
      assert.equal(
        events.some((e, i) => i >= beforeDeny && e.type === "agent_output" && /secchat-marker\.txt/.test(e.text ?? "")),
        false,
        "ls must not have actually executed while the tool call was denied",
      );

      // 3. The OWNER grants execute (once); the identical "please run ls" ask now produces a
      //    tool_decision(allow:true), and this time pi's bash tool really ran — its real stdout
      //    (naming the marker file we planted in the workspace) comes back as an agent_output.
      const grant = await control.grantExecute({ sessionId: session.id, byUser: "owner-1", scope: "once" });
      assert.equal(grant.allow, true);

      const beforeAllow = events.length;
      await control.sendInput(session.id, "please run ls");
      const allowed = await waitFor(() => events.find((e, i) => i >= beforeAllow && e.type === "tool_decision" && e.tool === "bash" && e.allow === true));
      assert.equal(allowed.reason, "mutating tool authorized by owner grant (once)");
      const allowedOutput = await waitFor(() => events.find((e, i) => i >= beforeAllow && e.type === "agent_output" && /secchat-marker\.txt/.test(e.text ?? "")));
      assert.match(allowedOutput.text ?? "", /secchat-marker\.txt/);
    } finally {
      if (sessionId) await runner.stop(sessionId).catch(() => {});
      await mock.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);
