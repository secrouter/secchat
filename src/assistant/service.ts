// The assistant orchestration — server-side model chat, no runner (decision #5). Builds the
// LLM context from a channel's message history, calls the agent's LlmClient attributed to the
// agent's OWNER (never whoever prompted it — decision #2), streams deltas to any live
// subscribers via `broadcast`, and persists exactly one agent message per turn.
//
// Depends only on the `Store` / `LlmClient` PORTS from ../types.ts (never a concrete store or
// SecRouter client), so this orchestration is fully testable offline with fakes — see
// test/assistant.test.ts.

import type { Agent, LlmClient, LlmMessage, Message, Store } from "../types.ts";

/** Short, fixed preamble — every assistant turn starts the model context with this. */
const SYSTEM_PREAMBLE =
  "You are the SecChat assistant, participating in an auditable team chat channel. Be helpful, " +
  "clear, and concise.";

/** How many prior turns (post-mapping, post-redaction-filtering) to keep as model context. */
const HISTORY_LIMIT = 20;

export async function handleAssistantTurn(
  deps: {
    store: Store;
    llm: LlmClient;
    broadcast?: (channelId: string, payload: unknown) => void;
    /** Model for an agent with no explicit one — the deployment default (config.assistantModel).
     * Falls back to "auto" if not wired. */
    defaultModel?: string;
  },
  args: { channelId: string; agent: Agent; promptedBy: string; userText: string },
): Promise<Message> {
  const history = await deps.store.listMessages(args.channelId);

  // Map to LlmMessage[]; rows with no content (e.g. redacted — the `content` key is absent
  // entirely, see store/memory.ts) are skipped rather than sent to the model as empty turns.
  const historyMessages: LlmMessage[] = [];
  for (const row of history) {
    if (row.content === undefined) continue;
    historyMessages.push({ role: row.authorType === "agent" ? "assistant" : "user", content: row.content });
  }

  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PREAMBLE },
    ...historyMessages.slice(-HISTORY_LIMIT),
    { role: "user", content: args.userText },
  ];

  // actingUser is the agent's OWNER, not `args.promptedBy` — an agent always acts as the user
  // who owns it (decision #2), so SecRouter's policy/budget/audit land on the owner regardless
  // of who prompted this particular turn.
  const stream = deps.llm.complete({
    // Per-agent model (set via the picker) wins; else the deployment default; else "auto". Never
    // "default" — SecRouter treats that as a passthrough to an unconfigured provider and 502s.
    model: args.agent.model ?? deps.defaultModel ?? "auto",
    messages,
    actingUser: args.agent.ownerSub,
  });

  let full = "";
  for await (const delta of stream) {
    full += delta;
    deps.broadcast?.(args.channelId, { type: "assistant_delta", agentId: args.agent.id, delta });
  }

  // An empty stream means the model produced no output at all. We deliberately do NOT persist
  // an empty-content agent message in that case: an agent row with no content would still
  // consume a seq slot and a chain link, permanently recording a "turn" nothing was actually
  // said in, and would render as a blank bubble downstream. Throwing (without persisting) lets
  // the caller surface a clean error instead of chaining a hollow agent turn into history.
  if (full === "") {
    throw new Error("assistant produced no output");
  }

  const msg = await deps.store.appendMessage({
    channelId: args.channelId,
    authorRef: args.agent.id,
    authorType: "agent",
    content: full,
    promptedBy: args.promptedBy,
  });

  deps.broadcast?.(args.channelId, { type: "message", message: { ...msg, content: full } });

  return msg;
}
