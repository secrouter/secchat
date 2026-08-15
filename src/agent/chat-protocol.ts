// The protocol SecChat uses to relay a shared channel's chat to a coding agent's pi session.
//
// A coding-agent channel is an ordinary multi-member channel (people join via the members panel /
// /invite — it is NOT a private DM), so pi must be able to tell who is speaking. Each human message
// is delivered to pi as a compact JSON envelope; AGENT_CHAT_PRIMER is appended to pi's system prompt
// at spawn (pi `--append-system-prompt`) so it knows to expect that envelope and how to answer. pi's
// replies come back as plain text/markdown and are persisted into the channel like any message
// (see control.ts). Both ends — the primer's description and formatUserMessageForAgent's output —
// live here so they can never drift apart.

/** The exact text pi must emit when a message isn't for it (see AGENT_CHAT_PRIMER) — the runner
 * recognises this and posts NOTHING to the channel. Kept here so the primer and the runner's
 * suppression check (pi-runner.ts) can never drift. A distinctive token no human would type. */
export const NO_REPLY_SENTINEL = "<<secchat:no-reply>>";

export interface AgentChatEnvelope {
  /** The sender's display name (falls back to their sub when the directory has no name yet). */
  from: string;
  /** The sender's chat message, verbatim. */
  message: string;
  /** Whether this sender may authorize edits/execution (the agent's owner). When false the sender
   * can converse and plan with the agent but may NOT trigger changes — and the execute-gate enforces
   * this server-side regardless, so this is pi's cue to behave cooperatively, not the security
   * boundary. */
  authorized: boolean;
  /** Whether this message is addressed to the agent — it's @mentioned, named, or the channel is a
   * 1:1 with it. A hint (not a rule): when true, reply; when false, use judgment and prefer silence
   * unless a reply is genuinely natural/helpful (see the primer + NO_REPLY_SENTINEL). */
  addressed: boolean;
}

/** Encode one human chat message for delivery to pi — one JSON object per turn. */
export function formatUserMessageForAgent(from: string, message: string, authorized: boolean, addressed: boolean): string {
  const envelope: AgentChatEnvelope = { from, message, authorized, addressed };
  return JSON.stringify(envelope);
}

// Kept as a plain (non-exported) local so the runnerd bundler's import scanner (scripts/
// bundle-runnerd.mjs) doesn't misread the literal `"from": "` in the JSON example below as an
// `export … from "…"` import. The exported value is the joined string just beneath.
const PRIMER_LINES = [
  "You are a coding agent in a shared SecChat channel used by one or more people. Each turn, the",
  "channel hands you ONE person's chat message wrapped in a small JSON envelope:",
  '  {"from": "<name>", "message": "<what they said>", "authorized": <true|false>, "addressed": <true|false>}',
  "This envelope is only how messages are delivered to you — it is NOT part of what they said and",
  "NOT something to talk about.",
  "",
  'Respond to the "message" text exactly as if that person had typed it straight to you, in plain',
  "text or markdown. Do NOT restate, quote, summarise, describe, or acknowledge the envelope or any",
  'of its fields. Never begin with things like "You have a message from ..." or "They asked ..." and',
  "never mention the authorization status. Just answer the message directly.",
  "",
  "Use the fields silently as context, never as something to report:",
  '  - "from" is who is speaking (several people may share this channel). Use it silently to track',
  "    who said what — you do NOT need to put a name in your reply, and usually should not. Just",
  "    answer directly, with no name at all. Only address someone by name when it genuinely adds",
  "    clarity — e.g. to disambiguate when several people are talking to you at once.",
  '  - "authorized" is whether that person may authorize changes. If true, you may create/edit files',
  "    and run commands for them (each mutating action is still separately approved). If false, only",
  "    discuss and plan — do not edit files or run mutating commands for them; if changes are needed,",
  "    say an authorized user has to approve them.",
  '  - "addressed" is whether this message is for YOU (you were named/@mentioned, or it is a 1:1',
  "    channel with you). Use it to decide WHETHER to reply at all — see below.",
  "",
  "DECIDE WHETHER TO REPLY. You are one participant in a shared channel, not a bot that answers every",
  "line. Reply only when it's natural: when \"addressed\" is true, or when a reply is genuinely helpful",
  "in the flow (e.g. a direct question you can answer, or a task clearly meant for you). When the",
  "message is NOT for you — small talk between others, a comment to another person, or anything you",
  "weren't asked about — do NOT reply. In that case output EXACTLY this and nothing else, and do not",
  `use any tools: ${NO_REPLY_SENTINEL}`,
  "That token is a private signal to the channel software that you are staying silent; it is never",
  "shown to anyone. When you DO reply, never include that token.",
  "",
  "Your reply is posted straight into the channel for everyone to read, and it is rendered as",
  "MARKDOWN — so use it: put code, commands, and file contents in fenced ``` code blocks (with a",
  "language tag when you know it), use inline `code` for identifiers/paths, and lists or headings",
  "where they help. Never output JSON, and never echo the envelope back.",
];

/** Appended to pi's system prompt at spawn so it understands the multi-user chat context and the
 * JSON envelope each message arrives in. Kept in lock-step with formatUserMessageForAgent above. */
export const AGENT_CHAT_PRIMER = PRIMER_LINES.join("\n");
