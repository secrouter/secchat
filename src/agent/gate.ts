// The execute-gate — SecChat's agent-safety core (decision #2; review finding C1).
//
// A coding agent runs in NO-EXECUTION MODE by default: it may converse and plan in TEXT, but runs
// NO tools at all — not even read-only ones — until the OWNER raises the mode. The owner escalates
// via the coding strip's mode dropdown, each level a grant scope:
//   • no-execution (no active grant) — no tools; text-only planning. The safe default.
//   • plan   — read-only tools (ls/read/grep/…); still no side effects.
//   • once   — read-only PLUS one mutating call, then back to no-execution.
//   • always — read-only PLUS every mutating call, until the owner revokes it (continual).
// Only the OWNER may raise the mode; invited participants can prompt the agent but never change it
// — the whole point of tying an agent to one owner. Unknown tools fail CLOSED (treated as mutating),
// so a tool we don't recognize can never slip through as "read".
//
// Pure functions over the session's current grant (held by the SessionStore). The control plane
// calls evaluateTool() on every runner tool_request and consumes a "once" grant on use.

import type { Agent, ExecuteGrant, ToolClass } from "../types.ts";

// Deliberately explicit allowlists rather than a "looks read-only" heuristic. Anything not on the
// read list is mutating — including anything unrecognized.
const READONLY_TOOLS = new Set([
  "read", "view", "cat", "open", "ls", "list", "grep", "search", "find", "glob", "tree", "stat", "diff", "show",
]);
const MUTATING_TOOLS = new Set([
  "bash", "sh", "shell", "exec", "run", "write", "edit", "apply_patch", "patch", "create", "append",
  "delete", "rm", "mv", "move", "cp", "mkdir", "chmod", "install", "commit", "push",
]);

export function classifyTool(tool: string): ToolClass {
  const t = tool.trim().toLowerCase();
  if (READONLY_TOOLS.has(t)) return "read";
  if (MUTATING_TOOLS.has(t)) return "mutate";
  return "mutate"; // fail closed: an unrecognized tool is treated as side-effectful
}

export interface GateDecision {
  allow: boolean;
  reason: string;
}

/** Only the agent's OWNER may authorize execution (C1: a shared/invited participant cannot).
 * The HTTP layer calls this before recording an ExecuteGrant. */
export function canGrantExecute(agent: Agent, byUser: string): GateDecision {
  if (byUser !== agent.ownerSub) {
    return { allow: false, reason: "only the agent's owner can authorize code execution" };
  }
  return { allow: true, reason: "owner" };
}

/** An active (present, not-consumed) grant, or undefined = no-execution mode. */
function activeGrant(grant: ExecuteGrant | undefined): ExecuteGrant | undefined {
  return grant && !grant.consumed ? grant : undefined;
}

/** Is this grant currently usable to authorize ONE MUTATING tool call in the given turn? `plan`
 * never authorizes a mutation (it's read-only); once/turn/always do. */
function mutateUsable(grant: ExecuteGrant | undefined, turnId: string | undefined): boolean {
  const g = activeGrant(grant);
  if (!g) return false;
  if (g.scope === "always") return true; // continual execution — every mutation, until revoked
  if (g.scope === "once") return true; // one mutation, until it is consumed
  if (g.scope === "turn") return g.turnId !== undefined && g.turnId === turnId; // this turn only
  return false; // "plan" — read-only, never a mutation
}

/** The decision point, called on every runner tool_request. In no-execution mode (the default —
 * no active grant) NOTHING runs, not even a read. Plan mode allows read-only tools; a mutating tool
 * additionally needs an execute grant (once/turn/always). A caller that gets `{allow:true}` for a
 * `once` grant must then consume it. */
export function evaluateTool(args: { tool: string; grant?: ExecuteGrant; turnId?: string }): GateDecision {
  const g = activeGrant(args.grant);
  if (!g) {
    return { allow: false, reason: "no-execution mode — the owner must enable plan or execute mode" };
  }
  if (classifyTool(args.tool) === "read") {
    return { allow: true, reason: `read-only tool (${g.scope === "plan" ? "plan" : "execute"} mode)` };
  }
  if (mutateUsable(args.grant, args.turnId)) {
    const how = g.scope === "once"
      ? "owner grant (once)"
      : g.scope === "always"
        ? "owner grant (continual)"
        : "owner grant (this turn)";
    return { allow: true, reason: `mutating tool authorized by ${how}` };
  }
  return { allow: false, reason: "mutating tool requires execute mode — plan mode is read-only" };
}
