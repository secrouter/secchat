// The execute-gate is agent-safety-critical, so it gets exhaustive tests: plan mode denies
// mutation, only the owner can authorize it, grants are scope-bounded, and unknown tools fail closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canGrantExecute, classifyTool, evaluateTool } from "../src/agent/gate.ts";
import type { Agent, ExecuteGrant } from "../src/types.ts";

const agent: Agent = { id: "agent-1", ownerSub: "owner-1", kind: "coding", createdAt: "2026-08-08T00:00:00Z" };

test("classifyTool: reads are reads, mutations are mutations, unknowns fail closed", () => {
  for (const t of ["read", "ls", "grep", "GREP", " find "]) assert.equal(classifyTool(t), "read");
  for (const t of ["bash", "write", "edit", "rm", "apply_patch"]) assert.equal(classifyTool(t), "mutate");
  assert.equal(classifyTool("frobnicate"), "mutate"); // unrecognized → mutate (fail closed)
});

test("only the owner can authorize execution (C1)", () => {
  assert.equal(canGrantExecute(agent, "owner-1").allow, true);
  const other = canGrantExecute(agent, "colleague-2");
  assert.equal(other.allow, false);
  assert.match(other.reason, /only the agent's owner/);
});

test("plan mode: a read tool is always allowed, with or without a grant", () => {
  assert.equal(evaluateTool({ tool: "grep" }).allow, true);
  assert.equal(evaluateTool({ tool: "read", grant: undefined }).allow, true);
});

test("plan mode: a mutating tool with no grant is denied", () => {
  const d = evaluateTool({ tool: "bash" });
  assert.equal(d.allow, false);
  assert.match(d.reason, /requires the owner to authorize/);
});

test("a 'once' owner grant authorizes a mutation, and is refused once consumed", () => {
  const grant: ExecuteGrant = { sessionId: "s1", grantedBy: "owner-1", scope: "once", grantedAt: "t" };
  assert.equal(evaluateTool({ tool: "bash", grant }).allow, true);
  assert.equal(evaluateTool({ tool: "write", grant: { ...grant, consumed: true } }).allow, false);
});

test("a 'turn' grant applies only within its own turn", () => {
  const grant: ExecuteGrant = { sessionId: "s1", grantedBy: "owner-1", scope: "turn", turnId: "turn-9", grantedAt: "t" };
  assert.equal(evaluateTool({ tool: "edit", grant, turnId: "turn-9" }).allow, true);
  assert.equal(evaluateTool({ tool: "edit", grant, turnId: "turn-10" }).allow, false); // different turn
  assert.equal(evaluateTool({ tool: "edit", grant, turnId: undefined }).allow, false);
});
