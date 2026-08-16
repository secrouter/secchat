// TranscribeClient — the secchat backend's client for SecRecorder's transcription API (§2.4/§3.1
// of docs/plans/voice-calls-plan.md; see docs/plans/voice-contracts.md §5 for the exact wire shape).
// SecRecorder is UNAUTHENTICATED — network isolation (reachable only from this backend, never from
// clients) is the control (A6, §9's folded suggestions) — this client's `baseUrl` is expected to be
// a compose-internal address.
//
// Two things make this more than a bare `fetch` wrapper:
//   * Retry/backoff (mirrors webhooks/outbound.ts's OutboundOptions shape): a network error or a
//     5xx/429 response is retried with doubling backoff; any other 4xx (bad/empty file, 413 over
//     WHISPER_MAX_UPLOAD_MB) is a permanent failure — retrying an empty file won't un-empty it.
//     `transcribeLeg` NEVER partially succeeds (§2.4's contract): either the full `TranscribeResult`
//     comes back or the promise rejects with a `TranscribeError | Error` the caller's failure-
//     isolation path turns into a "transcription pending"/failure line (§2.4).
//   * A concurrency limiter (default 1, matching SecRecorder's own `WHISPER_MAX_CONCURRENCY=1`,
//     which serializes GPU work server-side regardless) — this just stops a burst of per-leg jobs
//     piling up client-side retries behind an already-saturated SecRecorder instead of queueing.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface TranscribeClientDeps {
  /** SecRecorder base URL (SECCHAT_TRANSCRIBE_URL), compose-internal / secproxy-fronted only. */
  baseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Caps in-flight transcribeLeg calls (mirrors SecRecorder's own WHISPER_MAX_CONCURRENCY, which
   * serializes GPU work server-side regardless — this just avoids piling up client-side retries
   * behind it). Default 1. */
  maxConcurrency?: number;
  /** Total attempts per job including the first (default 4 — a GPU-bound service can take a while
   * to recover from a transient 5xx/OOM). */
  maxAttempts?: number;
  /** Base backoff in ms, doubled each retry (default 1000; pass 0 in tests). */
  backoffMs?: number;
  /** Injectable sleep (tests pass a no-op / instrumented one), same knob as OutboundOptions.sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** One word-level timestamp — SecRecorder's `words[]` shape (server.py's flattened
 * segment-words), the field most clients read for real per-word timing. */
export interface TranscribeWord {
  word: string;
  start: number; // seconds
  end: number;
  /** Only ever present on a `diarize=true` response (the `SECCHAT_TRANSCRIBE_MODE=mixed` fallback,
   * §2.4) — a diarization-assigned speaker id. Calls need none of this in the default per-leg mode
   * (A7: leg identity already gives exact attribution); `transcribe/merge.ts`'s `mergeMixedTranscript`
   * remaps whatever raw id SecRecorder assigns to generic "Speaker 1"/"Speaker 2" labels. TODO(voice):
   * confirm SecRecorder's exact diarize=true field name/shape once it's added to
   * docs/plans/voice-contracts.md (§5.2 notes the mixed fallback is "not implemented in v1's
   * scaffold" on the wire-contract side — this client sends the flag, but nothing yet exercises a
   * real diarized response against it). */
  speaker?: string;
}

/** One segment — SecRecorder's `segments[]` shape (kept for the merge's fallback + general
 * compatibility, per server.py's own doc comment). */
export interface TranscribeSegment {
  start: number; // seconds, relative to the LEG file (not the call's session t0 — see merge.ts)
  end: number;
  text: string;
  words?: TranscribeWord[];
  /** See {@link TranscribeWord.speaker} — same diarize=true-only, mixed-mode-only caveat. */
  speaker?: string;
}

/** SecRecorder's `POST /v1/audio/transcriptions` response. The `diarize=false` shape (calls' default
 * per-leg mode) carries no `speaker` on any word/segment — per-leg identity already gives exact
 * attribution (A7), so calls need none of that. */
export interface TranscribeResult {
  task: "transcribe";
  language: string;
  duration: number; // seconds
  text: string;
  words: TranscribeWord[];
  segments: TranscribeSegment[];
}

export interface TranscribeLegJob {
  /** Which leg this is (caller/callee) — carried through only for logging/error attribution; the
   * merge step's speaker attribution comes from the CALLER's `LegTranscript.speaker`, not this. */
  legId: string;
  /** The leg's OGG/Opus file path on the shared recordings volume (mediad's finalize output), OR —
   * for the `SECCHAT_TRANSCRIBE_MODE=mixed` fallback — the ffmpeg-mixed playback file's path. */
  filePath: string;
  /** `true` ONLY for the mixed-mode fallback's single pass over the mixed file (§2.4: "one
   * transcription pass ... with diarize=true"); omitted/false (the default) for the normal per-leg
   * jobs, where diarization is unnecessary (A7). */
  diarize?: boolean;
}

export interface TranscribeClient {
  /** POST one leg's (or, in mixed mode, the whole call's) audio file to SecRecorder. Retries with
   * backoff on a network error or 5xx/429; queued per `maxConcurrency`. Never partially succeeds —
   * either the full `TranscribeResult` comes back or the promise rejects (the caller's
   * failure-isolation path, §2.4, posts a "transcription pending"/failure line and may retry later). */
  transcribeLeg(job: TranscribeLegJob): Promise<TranscribeResult>;
}

/** Thrown by `transcribeLeg` on a non-2xx SecRecorder response (see docs/plans/voice-contracts.md
 * §2.6-equivalent for SecRecorder's error shape, §5.1). `retryable` mirrors webhooks/outbound.ts's
 * "5xx/429 retryable, other 4xx permanent" classification. A network-level failure (fetch throws,
 * timeout) surfaces as this too, with `status: 0` — same convention OutboundDispatcher uses. */
export class TranscribeError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string, retryable: boolean) {
    super(message);
    this.name = "TranscribeError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** A simple counting semaphore — `run(fn)` waits for a free slot (out of `max`), runs `fn`, then
 * releases exactly one queued waiter. No external deps; queue order is FIFO. */
function makeLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  function acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (active < max) {
        active++;
        resolve();
      } else {
        queue.push(() => {
          active++;
          resolve();
        });
      }
    });
  }
  function release(): void {
    active--;
    const next = queue.shift();
    if (next) next();
  }
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** Construction never throws (matches every other `make*Client` in this codebase — see
 * calls/mediad-client.ts). All the retry/concurrency machinery lives in the closure below. */
export function makeTranscribeClient(deps: TranscribeClientDeps): TranscribeClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxConcurrency = Math.max(1, deps.maxConcurrency ?? 1);
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 4);
  const backoffMs = deps.backoffMs ?? 1000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const limiter = makeLimiter(maxConcurrency);
  const baseUrl = deps.baseUrl.replace(/\/+$/, "");

  /** One HTTP attempt — multipart POST, `diarize` per the job (§5.1 of voice-contracts.md: the
   * other OpenAI-shaped fields SecRecorder accepts are irrelevant to calls and simply omitted). */
  async function postOnce(job: TranscribeLegJob): Promise<TranscribeResult> {
    const bytes = await readFile(job.filePath);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }), basename(job.filePath));
    form.append("diarize", job.diarize ? "true" : "false");

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/v1/audio/transcriptions`, { method: "POST", body: form });
    } catch (err) {
      // Network error / timeout — no status to report; treat like a 5xx (retryable).
      throw new TranscribeError(0, err instanceof Error ? err.message : String(err), true);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const retryable = res.status >= 500 || res.status === 429;
      throw new TranscribeError(res.status, detail || `SecRecorder HTTP ${res.status}`, retryable);
    }
    return (await res.json()) as TranscribeResult;
  }

  return {
    async transcribeLeg(job: TranscribeLegJob): Promise<TranscribeResult> {
      return limiter(async () => {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            return await postOnce(job);
          } catch (err) {
            const retryable = err instanceof TranscribeError ? err.retryable : true;
            if (!retryable || attempt === maxAttempts) throw err;
            await sleep(backoffMs * 2 ** (attempt - 1));
          }
        }
        // Unreachable (the loop above always returns or throws on its last attempt) — satisfies
        // TS's control-flow analysis without an `as never` cast.
        throw new TranscribeError(0, "transcribeLeg: exhausted retries", false);
      });
    },
  };
}
