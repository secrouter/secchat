// The protocol SecChat uses to relay a shared channel's chat to a coding agent's pi session.
//
// A coding-agent channel is an ordinary multi-member channel (people join via the members panel /
// /invite — it is NOT a private DM), so pi must be able to tell who is speaking. Each human message
// is delivered to pi as a compact JSON envelope; AGENT_CHAT_PRIMER is appended to pi's system prompt
// at spawn (pi `--append-system-prompt`) so it knows to expect that envelope and how to answer. pi's
// replies come back as plain text/markdown and are persisted into the channel like any message
// (see control.ts). Both ends — the primer's description and formatUserMessageForAgent's output —
// live here so they can never drift apart.

export interface AgentChatEnvelope {
  /** The sender's display name (falls back to their sub when the directory has no name yet). */
  from: string;
  /** The sender's chat message, verbatim. */
  message: string;
}

/** Encode one human chat message for delivery to pi — one JSON object per turn. */
export function formatUserMessageForAgent(from: string, message: string): string {
  const envelope: AgentChatEnvelope = { from, message };
  return JSON.stringify(envelope);
}

// Kept as a plain (non-exported) local so the runnerd bundler's import scanner (scripts/
// bundle-runnerd.mjs) doesn't misread the literal `"from": "` in the JSON example below as an
// `export … from "…"` import. The exported value is the joined string just beneath.
const PRIMER_LINES = [
  "You are a coding agent taking part in a shared SecChat team channel with one or more people.",
  "Each human message is delivered to you as a single JSON object on its own turn, with two string",
  'fields: the sender\'s display name, then their message. For example:',
  '  {"from": "Dana Lee", "message": "add a health check to the server"}',
  "Read the message field as the actual request, and use the sender field to tell who is speaking —",
  "several people may talk to you in the same channel, so address them by name when it helps.",
  "",
  "Reply in ordinary text or markdown, exactly as you normally would: your reply is posted straight",
  "into the channel for everyone to read. Do NOT reply with JSON, and never repeat or echo the",
  "envelope back.",
];

/** Appended to pi's system prompt at spawn so it understands the multi-user chat context and the
 * JSON envelope each message arrives in. Kept in lock-step with formatUserMessageForAgent above. */
export const AGENT_CHAT_PRIMER = PRIMER_LINES.join("\n");
