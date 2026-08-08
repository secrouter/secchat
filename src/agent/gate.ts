// The execute-gate — SecChat's agent-safety core (decision #2; review finding C1).
//
// A coding agent runs in PLAN MODE by default: it may use read-only tools and converse with
// anyone in the channel, but a MUTATING tool (bash / write / edit — anything with side effects)
// is DENIED unless the agent's OWNER has issued an execute grant. Invited participants can prompt
// the agent all day (plan mode) but can NEVER authorize execution — that is the whole point of
// tying an agent to one owner. Unknown tools fail CLOSED (treated as mutating), so a tool we
// don't recognize can never slip through as "read".
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

/** Is this grant currently usable to authorize ONE mutating tool call in the given turn? */
function grantUsable(grant: ExecuteGrant | undefined, turnId: string | undefined): boolean {
  if (!grant || grant.consumed) return false;
  if (grant.scope === "once") return true; // one mutation, until it is consumed
  if (grant.scope === "turn") return grant.turnId !== undefined && grant.turnId === turnId; // this turn only
  return false;
}

/** The decision point, called on every runner tool_request. Read tools are always allowed (plan
 * mode); a mutating tool is allowed ONLY when the session carries an active owner grant valid for
 * this turn. A caller that gets `{allow:true}` for a `once` grant must then consume it. */
export function evaluateTool(args: { tool: string; grant?: ExecuteGrant; turnId?: string }): GateDecision {
  if (classifyTool(args.tool) === "read") {
    return { allow: true, reason: "read-only tool (plan mode)" };
  }
  if (grantUsable(args.grant, args.turnId)) {
    const how = args.grant!.scope === "once" ? "owner grant (once)" : "owner grant (this turn)";
    return { allow: true, reason: `mutating tool authorized by ${how}` };
  }
  return { allow: false, reason: "mutating tool requires the owner to authorize execution (plan mode)" };
}
