// Unit tests for transcribe/client.ts — multipart request shape, retry/backoff classification, and
// the concurrency limiter. No real filesystem/network: a temp fixture file on disk (readFile is real
// — it's cheap and avoids faking node:fs/promises) and a fake `fetchImpl`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeTranscribeClient, TranscribeError, type TranscribeResult } from "../src/transcribe/client.ts";

async function withFixtureFile(bytes: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "secchat-transcribe-test-"));
  const path = join(dir, "leg_caller.ogg");
  await writeFile(path, bytes);
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const OK_RESULT: TranscribeResult = {
  task: "transcribe",
  language: "en",
  duration: 1.2,
  text: "hey there",
  words: [],
  segments: [{ start: 0, end: 1.2, text: "hey there" }],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("transcribeLeg: posts multipart with file + diarize=false by default", async () => {
  await withFixtureFile("fake ogg bytes", async (path) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return jsonResponse(200, OK_RESULT);
    }) as typeof fetch;

    const client = makeTranscribeClient({ baseUrl: "http://mediad-transcribe.internal:9000", fetchImpl });
    const out = await client.transcribeLeg({ legId: "leg_caller", filePath: path });

    assert.deepEqual(out, OK_RESULT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "http://mediad-transcribe.internal:9000/v1/audio/transcriptions");
    assert.equal(calls[0]!.init.method, "POST");
    const form = calls[0]!.init.body as FormData;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("diarize"), "false");
    const file = form.get("file") as unknown as Blob;
    assert.ok(file instanceof Blob);
    assert.equal(await file.text(), "fake ogg bytes");
  });
});

test("transcribeLeg: diarize:true (the mixed-mode fallback) is sent as-is", async () => {
  await withFixtureFile("mixed file bytes", async (path) => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData;
      assert.equal(form.get("diarize"), "true");
      return jsonResponse(200, OK_RESULT);
    }) as typeof fetch;

    const client = makeTranscribeClient({ baseUrl: "http://x", fetchImpl });
    await client.transcribeLeg({ legId: "mixed", filePath: path, diarize: true });
  });
});

test("transcribeLeg: strips a trailing slash off baseUrl", async () => {
  await withFixtureFile("bytes", async (path) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return jsonResponse(200, OK_RESULT);
    }) as typeof fetch;
    const client = makeTranscribeClient({ baseUrl: "http://x/", fetchImpl });
    await client.transcribeLeg({ legId: "leg", filePath: path });
    assert.equal(calls[0], "http://x/v1/audio/transcriptions");
  });
});

test("transcribeLeg: retries a 500 with backoff, then succeeds", async () => {
  await withFixtureFile("bytes", async (path) => {
    let attempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      attempts++;
      if (attempts < 3) return new Response("boom", { status: 500 });
      return jsonResponse(200, OK_RESULT);
    }) as typeof fetch;

    const client = makeTranscribeClient({
      baseUrl: "http://x",
      fetchImpl,
      backoffMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const out = await client.transcribeLeg({ legId: "leg", filePath: path });
    assert.deepEqual(out, OK_RESULT);
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [10, 20], "doubling backoff between the two failed attempts");
  });
});

test("transcribeLeg: retries on a thrown network error (status 0)", async () => {
  await withFixtureFile("bytes", async (path) => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      if (attempts === 1) throw new Error("ECONNREFUSED");
      return jsonResponse(200, OK_RESULT);
    }) as typeof fetch;

    const client = makeTranscribeClient({ baseUrl: "http://x", fetchImpl, backoffMs: 0, sleep: async () => {} });
    const out = await client.transcribeLeg({ legId: "leg", filePath: path });
    assert.deepEqual(out, OK_RESULT);
    assert.equal(attempts, 2);
  });
});

test("transcribeLeg: a 400 (e.g. empty file) is NOT retried — fails immediately", async () => {
  await withFixtureFile("bytes", async (path) => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      return new Response(JSON.stringify({ detail: "empty file" }), { status: 400 });
    }) as typeof fetch;

    const client = makeTranscribeClient({ baseUrl: "http://x", fetchImpl, maxAttempts: 4, sleep: async () => {} });
    await assert.rejects(
      () => client.transcribeLeg({ legId: "leg", filePath: path }),
      (err: unknown) => {
        assert.ok(err instanceof TranscribeError);
        assert.equal(err.status, 400);
        assert.equal(err.retryable, false);
        return true;
      },
    );
    assert.equal(attempts, 1, "no retry for a permanent 4xx");
  });
});

test("transcribeLeg: exhausts retries and rejects with the last error", async () => {
  await withFixtureFile("bytes", async (path) => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      return new Response("still down", { status: 503 });
    }) as typeof fetch;

    const client = makeTranscribeClient({ baseUrl: "http://x", fetchImpl, maxAttempts: 3, backoffMs: 0, sleep: async () => {} });
    await assert.rejects(
      () => client.transcribeLeg({ legId: "leg", filePath: path }),
      (err: unknown) => {
        assert.ok(err instanceof TranscribeError);
        assert.equal(err.status, 503);
        return true;
      },
    );
    assert.equal(attempts, 3, "tried exactly maxAttempts times, no more");
  });
});

test("transcribeLeg: a 429 IS retried (rate limit, not a rejection)", async () => {
  await withFixtureFile("bytes", async (path) => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      if (attempts === 1) return new Response("slow down", { status: 429 });
      return jsonResponse(200, OK_RESULT);
    }) as typeof fetch;
    const client = makeTranscribeClient({ baseUrl: "http://x", fetchImpl, backoffMs: 0, sleep: async () => {} });
    const out = await client.transcribeLeg({ legId: "leg", filePath: path });
    assert.deepEqual(out, OK_RESULT);
    assert.equal(attempts, 2);
  });
});

test("transcribeLeg: maxConcurrency=1 serializes jobs (matches WHISPER_MAX_CONCURRENCY=1)", async () => {
  await withFixtureFile("bytes", async (path) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return jsonResponse(200, OK_RESULT);
    }) as typeof fetch;

    const client = makeTranscribeClient({ baseUrl: "http://x", fetchImpl, maxConcurrency: 1 });
    await Promise.all([
      client.transcribeLeg({ legId: "leg_caller", filePath: path }),
      client.transcribeLeg({ legId: "leg_callee", filePath: path }),
      client.transcribeLeg({ legId: "leg_third", filePath: path }),
    ]);
    assert.equal(maxInFlight, 1, "never more than one in-flight request");
  });
});

test("transcribeLeg: maxConcurrency=2 allows two jobs in flight at once", async () => {
  await withFixtureFile("bytes", async (path) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return jsonResponse(200, OK_RESULT);
    }) as typeof fetch;

    const client = makeTranscribeClient({ baseUrl: "http://x", fetchImpl, maxConcurrency: 2 });
    await Promise.all([
      client.transcribeLeg({ legId: "a", filePath: path }),
      client.transcribeLeg({ legId: "b", filePath: path }),
      client.transcribeLeg({ legId: "c", filePath: path }),
    ]);
    assert.equal(maxInFlight, 2);
  });
});
