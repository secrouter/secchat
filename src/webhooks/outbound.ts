// Outbound-webhook delivery — SecChat POSTs a SIGNED JSON payload to an external URL when a
// subscribed event fires (the opposite direction of the inbound `/hooks/:token` route). Kept
// behind a small port (`OutboundDispatcher`) so the HTTP layer fires events without knowing how
// delivery works, and so tests inject a fake transport instead of hitting the network.
//
// Delivery is FIRE-AND-FORGET from the event site: `dispatch()` is not awaited by the request
// handler (a slow/broken receiver must never delay a message post), retries in the background with
// bounded backoff, and records the last attempt's status on the row for observability.
//
// EGRESS SAFETY: this sends data OUT of a CUI system. Two guards: (1) message CONTENT is included
// only for subscriptions that opted in (`includeContent`) — otherwise payloads are metadata-only;
// (2) an optional destination-host allowlist (see `allowedHost`) blocks creation of a webhook
// pointing anywhere else.

import { createHmac, randomUUID } from "node:crypto";

import type { Id, OutboundEvent, OutboundWebhook, Store } from "../types.ts";

/** The signed envelope a receiver gets. `data` is event-specific and already content-filtered per
 * the subscription (see `filterData`). */
export interface OutboundPayload {
  id: string; // delivery id (unique per attempt-set), echoed in the X-Sec-Webhook-Id header
  event: OutboundEvent;
  channelId: Id;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface OutboundDispatcher {
  /** Deliver `event` for `channelId` to every ACTIVE subscription that wants it. Resolves once all
   * deliveries settle (tests await it); callers in the request path invoke it with `void`. `data`
   * may carry a `content` field — it is stripped for subscriptions without `includeContent`. */
  dispatch(channelId: Id, event: OutboundEvent, data: Record<string, unknown>): Promise<void>;
  /** Send a one-off test delivery to `hook` and return the outcome (also recorded on the row). */
  deliverTest(hook: OutboundWebhook): Promise<{ status: number; error?: string }>;
}

/** The transport `dispatch` uses — the global `fetch` in production, a stub in tests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

export interface OutboundOptions {
  fetchImpl?: FetchLike; // default: global fetch
  timeoutMs?: number; // per-attempt timeout (default 5000)
  maxAttempts?: number; // total tries including the first (default 3)
  backoffMs?: number; // base backoff, doubled each retry (default 500; 0 in tests)
  /** Deterministic delivery id + timestamp source (tests pass fixed values); defaults use crypto/Date. */
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

/** HMAC-SHA256 of `body` under `secret`, hex — the value of the `X-Sec-Webhook-Signature` header
 * (formatted `sha256=<hex>`, the de-facto convention receivers verify against). Exported so tests
 * and receivers share ONE definition. */
export function signBody(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/** Whether `url` may be used as an outbound-webhook destination: a well-formed http(s) URL whose
 * host is permitted. `allowedHosts` empty ⇒ any host (URL must still be valid http/https); non-empty
 * ⇒ the hostname must be listed. Enforced at CREATION so an operator can't point a webhook at an
 * arbitrary egress destination in a locked-down deployment. Pure + exported for testing + the route. */
export function isAllowedOutboundUrl(url: string, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (allowedHosts.length === 0) return true;
  return allowedHosts.includes(parsed.hostname);
}

/** Drop `content` from an event's data unless the subscription opted into content egress. Pure. */
function filterData(data: Record<string, unknown>, includeContent: boolean): Record<string, unknown> {
  if (includeContent) return data;
  const { content: _content, ...rest } = data;
  return rest;
}

export function makeOutboundDispatcher(store: Store, opts: OutboundOptions = {}): OutboundDispatcher {
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? ((url, init) => fetch(url, init).then((r) => ({ status: r.status })));
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const backoffMs = opts.backoffMs ?? 500;
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => randomUUID());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** POST `payload` to one hook, retrying transient failures (network error or 5xx / 429) up to
   * `maxAttempts`. A 2xx/3xx is success; a non-retryable 4xx stops immediately (the receiver
   * rejected it — retrying won't help). Records the final status on the row either way. */
  async function deliver(hook: OutboundWebhook, payload: OutboundPayload): Promise<{ status: number; error?: string }> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-sec-webhook-id": payload.id,
      "x-sec-webhook-event": payload.event,
      "x-sec-webhook-timestamp": payload.occurredAt,
      "x-sec-webhook-signature": signBody(hook.secret, body),
    };

    let lastStatus = 0;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const { status } = await fetchImpl(hook.url, { method: "POST", headers, body, signal: controller.signal });
        lastStatus = status;
        lastError = undefined;
        if (status < 400) break; // delivered
        if (status < 500 && status !== 429) break; // client rejected — don't retry a 4xx (except 429)
      } catch (err) {
        lastStatus = 0;
        lastError = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts) await sleep(backoffMs * 2 ** (attempt - 1));
    }

    await store.recordOutboundDelivery(hook.id, lastStatus, lastError ?? null);
    return { status: lastStatus, error: lastError };
  }

  return {
    async dispatch(channelId, event, data) {
      const hooks = (await store.listOutboundWebhooks(channelId)).filter(
        (h) => h.active && h.events.includes(event),
      );
      if (hooks.length === 0) return;
      const occurredAt = now().toISOString();
      // One delivery id per event-fan-out so a receiver can correlate the same event across hooks.
      const id = newId();
      await Promise.all(
        hooks.map((h) =>
          deliver(h, { id, event, channelId, occurredAt, data: filterData(data, h.includeContent) }).catch(
            () => undefined, // a single hook's failure never rejects the fan-out
          ),
        ),
      );
    },

    async deliverTest(hook) {
      return deliver(hook, {
        id: newId(),
        event: hook.events[0] ?? "message.created",
        channelId: hook.channelId,
        occurredAt: now().toISOString(),
        data: { test: true },
      });
    },
  };
}
