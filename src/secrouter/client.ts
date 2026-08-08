// SecRouter LLM egress client — the assistant path's model call (see types.ts LlmClient). Talks
// to SecRouter's OpenAI-compatible /v1/chat/completions endpoint over SSE and streams assistant
// text deltas back to the caller. Every call is attributed to the agent's owner via
// X-Sec-Acting-User so SecRouter's policy/budget/audit land on that user, never on SecChat's own
// service identity — this header is set unconditionally, regardless of who prompted the turn.

import type { Config } from "../config.ts";
import type { LlmClient, LlmCompleteRequest } from "../types.ts";

type SecRouterClientConfig = Pick<Config, "secrouterUrl" | "secrouterToken">;

/** The slice of an OpenAI-style chat-completion SSE chunk the assistant path reads. SecRouter's
 * chunks may carry more fields (id, usage, ...); everything else is ignored. */
interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

/** Builds an LlmClient bound to one SecRouter gateway. `complete` is lazy: nothing is sent over
 * the network until the returned AsyncIterable is actually iterated (so a non-2xx response, or
 * any other request failure, surfaces as a rejection from that iteration, not from this call). */
export function makeLlmClient(cfg: SecRouterClientConfig): LlmClient {
  return {
    complete(req: LlmCompleteRequest): AsyncIterable<string> {
      return streamCompletion(cfg, req);
    },
  };
}

async function* streamCompletion(cfg: SecRouterClientConfig, req: LlmCompleteRequest): AsyncGenerator<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // ALWAYS set, even when no service token is configured — this is how SecRouter attributes
    // policy/budget/audit to the agent's owner (LlmCompleteRequest.actingUser), never to SecChat.
    "X-Sec-Acting-User": req.actingUser,
  };
  if (cfg.secrouterToken) {
    headers["Authorization"] = `Bearer ${cfg.secrouterToken}`;
  }

  const response = await fetch(`${cfg.secrouterUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: req.model, messages: req.messages, stream: true }),
  });

  if (!response.ok) {
    throw new Error(`SecRouter chat completion failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new Error("SecRouter chat completion failed: response had no body");
  }

  yield* parseSseDeltas(response.body);
}

/** Parses an OpenAI-style SSE byte stream into assistant text deltas. A `data: ` line's bytes can
 * land split across two reads of the stream (TCP has no notion of the SSE framing), so the
 * partial trailing line is buffered and glued onto the front of the next decoded chunk before
 * re-splitting. */
async function* parseSseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // last element is "" (buffer ended on \n) or a partial line

      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (parsed === "done") return;
        if (parsed !== null) yield parsed;
      }
    }
  } finally {
    // Releases the connection (a harmless no-op if the stream already ran to completion) —
    // matters when a caller stops iterating early, e.g. right after `[DONE]`, so we don't leave
    // the underlying request dangling.
    await reader.cancel().catch(() => {});
  }
}

/** Parses one SSE line. Returns "done" on the `[DONE]` sentinel, the delta text for a chunk that
 * carries one, or null for anything to skip (blank lines, non-`data:` lines, deltas with no
 * content). */
function parseSseLine(rawLine: string): string | "done" | null {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine; // tolerate CRLF framing
  if (!line.startsWith("data: ")) return null;

  const payload = line.slice("data: ".length);
  if (payload === "[DONE]") return "done";

  const chunk = JSON.parse(payload) as ChatCompletionChunk;
  const content = chunk.choices?.[0]?.delta?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}
