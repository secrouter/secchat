// The assistant orchestration — server-side model chat, no runner (decision #5). Builds the
// LLM context from a channel's message history, calls the agent's LlmClient attributed to the
// agent's OWNER (never whoever prompted it — decision #2), streams deltas to any live
// subscribers via `broadcast`, and persists exactly one agent message per turn.
//
// Depends only on the `Store` / `LlmClient` PORTS from ../types.ts (never a concrete store or
// SecRouter client), so this orchestration is fully testable offline with fakes — see
// test/assistant.test.ts.

import { governedAgentAppend } from "../governance/append.ts";
import { parseMarking } from "../marking/caveats.ts";
import type { MarkingPolicy } from "../marking/policy.ts";
import type { DlpPolicy } from "../dlp/policy.ts";
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
    /** The deployment's marking ladder. When wired, the model call carries the classification
     * LEVEL of its content (see below) so SecRouter's clearance/egress gate evaluates it at the
     * right level, AND the assistant's own output is appended through the governed pipeline
     * (marking stamp + DLP — see governance/append.ts). Optional so offline fakes/tests without
     * a marking policy keep working (plain append, the historical behavior). */
    markingPolicy?: MarkingPolicy;
    /** DLP policy for scanning the assistant's OUTPUT (only applies when markingPolicy is wired). */
    dlp?: DlpPolicy;
  },
  args: { channelId: string; agent: Agent; promptedBy: string; userText: string },
): Promise<Message> {
  const history = await deps.store.listMessages(args.channelId);

  // Rows with no content (e.g. redacted — the `content` key is absent entirely, see
  // store/memory.ts) are skipped rather than sent to the model as empty turns. The inclusion
  // window is materialized BEFORE mapping so the classification below is computed over exactly
  // the rows the model will see — never over history that was sliced away.
  const included = history.filter((row) => row.content !== undefined).slice(-HISTORY_LIMIT);
  const historyMessages: LlmMessage[] = included.map((row) => ({
    role: row.authorType === "agent" ? "assistant" : "user",
    content: row.content!,
  }));

  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PREAMBLE },
    ...historyMessages,
    { role: "user", content: args.userText },
  ];

  // The classification forwarded to the gateway = the HIGHEST marking level across everything in
  // the model context: the channel's own marking plus every included history row's stamped
  // marking (the just-posted trigger message is already in `included` — the route persists it
  // before firing the assistant). A summary/reply can never be requested BELOW its sources'
  // level, and SecRouter's egress gate authorizes the call at that level instead of its default.
  let classification: string | undefined;
  if (deps.markingPolicy) {
    const policy = deps.markingPolicy;
    const channel = await deps.store.getChannel(args.channelId);
    let maxIdx = 0; // levels[0] is the deployment floor — the fail-safe minimum
    const raise = (raw: string | undefined) => {
      if (!raw) return;
      const idx = policy.levels.indexOf(parseMarking(policy, raw)?.level ?? "");
      if (idx > maxIdx) maxIdx = idx;
    };
    raise(channel?.cuiMarking);
    for (const row of included) raise(row.marking);
    classification = policy.levels[maxIdx];
  }

  // actingUser is the agent's OWNER, not `args.promptedBy` — an agent always acts as the user
  // who owns it (decision #2), so SecRouter's policy/budget/audit land on the owner regardless
  // of who prompted this particular turn.
  // Filled by complete() as the stream arrives with the model SecRouter actually served (which may
  // differ from the requested id when routing via "auto") — stamped onto the persisted message.
  const meta: { model?: string } = {};
  const stream = deps.llm.complete({
    // Per-agent model (set via the picker) wins; else the deployment default; else "auto". Never
    // "default" — SecRouter treats that as a passthrough to an unconfigured provider and 502s.
    model: args.agent.model ?? deps.defaultModel ?? "auto",
    messages,
    actingUser: args.agent.ownerSub,
    classification,
  }, meta);

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

  // Persist the turn through the GOVERNED append when the marking policy is wired: the output is
  // stamped with the channel's marking, portion markings fold/spillage-check, and DLP runs on it
  // exactly like a human post (block ⇒ a clean withheld-notice message, never a silent drop —
  // see governance/append.ts). What gets broadcast is what was actually persisted, so withheld
  // content cannot leak via the live FINAL message event. Honest limit: the transient
  // assistant_delta stream above already ran (scanning happens at persistence, not per token) —
  // the durable record and the final broadcast are clean, and the client's streaming bubble is
  // replaced by the withheld notice. Without a policy (offline fakes), plain append.
  if (deps.markingPolicy) {
    const enriched = await governedAgentAppend(
      { store: deps.store, marking: deps.markingPolicy, dlp: deps.dlp },
      { channelId: args.channelId, authorRef: args.agent.id, content: full, promptedBy: args.promptedBy, model: meta.model },
    );
    deps.broadcast?.(args.channelId, { type: "message", message: enriched });
    return enriched;
  }

  const msg = await deps.store.appendMessage({
    channelId: args.channelId,
    authorRef: args.agent.id,
    authorType: "agent",
    content: full,
    promptedBy: args.promptedBy,
    model: meta.model,
  });

  deps.broadcast?.(args.channelId, { type: "message", message: { ...msg, content: full } });

  return msg;
}
