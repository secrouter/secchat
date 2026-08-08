// Sprint 8 EXIT TEST — the interactive coding-agent loop, end to end (red until built). An
// interactive runner emits a real tool_request when asked to "build"; the control plane runs it
// through the execute-gate: DENIED in plan mode, ALLOWED once the owner grants. This is the
// product centerpiece (decision #2 / review C1) exercised through the runner protocol, not a stub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeControlPlane } from "../src/agent/control.ts";
import { makeInteractiveRunner } from "../src/agent/interactive-runner.ts";
import { MemoryStore } from "../src/store/memory.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(get: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await delay(10);
  }
}

test("interactive coding agent: a 'build' request is gate-denied in plan mode, allowed after the owner grants", async () => {
  const store = new MemoryStore();
  const events: Array<{ type: string; text?: string; allow?: boolean; tool?: string }> = [];
  const control = makeControlPlane({
    sessions: store,
    runner: makeInteractiveRunner(),
    getAgent: (id) => store.getAgent(id),
    broadcast: (_channelId, payload) => events.push(payload as { type: string }),
  });

  const agent = await store.createAgent({ ownerSub: "owner-1", kind: "coding", name: "Build Bot" });
  const channel = await store.createChannel({ workspaceId: "ws", kind: "agent", name: "build", createdBy: "owner-1" });
  await store.addMember({ channelId: channel.id, memberRef: "owner-1", memberType: "user", role: "owner" });
  await store.addMember({ channelId: channel.id, memberRef: agent.id, memberType: "agent", role: "member" });
  const session = await control.spawn({ agent, channelId: channel.id, hostType: "server" });

  // Plan mode: asking it to build triggers a mutating tool_request → the gate DENIES it.
  await control.sendInput(session.id, "build the project");
  const denied = await waitFor(() => events.find((e) => e.type === "tool_decision" && e.allow === false));
  assert.equal(denied.allow, false);
  await waitFor(() => events.find((e) => e.type === "agent_output" && /blocked/i.test(e.text ?? "")));

  // The OWNER authorizes execution (once), then the same request is ALLOWED.
  const grant = await control.grantExecute({ sessionId: session.id, byUser: "owner-1", scope: "once" });
  assert.equal(grant.allow, true);
  await control.sendInput(session.id, "build the project");
  const allowed = await waitFor(() => events.find((e) => e.type === "tool_decision" && e.allow === true));
  assert.equal(allowed.allow, true);
  await waitFor(() => events.find((e) => e.type === "agent_output" && /ran|done|✓/i.test(e.text ?? "")));
});
