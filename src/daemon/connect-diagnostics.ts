// WHY the runner daemon can't attach — turned into an operator-readable diagnosis. The daemon dials
// SecChat's `/runner` WebSocket; when that attach fails, Node's built-in (undici) `WebSocket` hands the
// `error` handler NOTHING useful — an empty message, no `code`, no `cause`, and a bare 1006 close — so a
// TLS-trust failure, a rejected token, and a wrong URL all look identical and undiagnosable (the exact
// gap this module closes: a real missing-CA-root failure was invisible). So on a failed attach the
// daemon replays the SAME opening handshake over a plain http(s) request, which DOES surface the real
// reason: the HTTP status (401/403 ⇒ bad token), the TLS error code (UNABLE_TO_GET_ISSUER_CERT ⇒ the
// served chain isn't trusted), or the socket errno (ECONNREFUSED / ENOTFOUND ⇒ server down / wrong URL).
// `diagnoseConnect` maps that outcome to a one-line summary + a targeted remediation hint; the mapping
// and the backoff are pure and unit-tested (test/connect-diagnostics.test.ts), keeping main.ts a thin
// shell (the same pure-core / transport-shell split as runner-client.ts).

import { randomBytes } from "node:crypto";
import type { ClientRequest } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** The outcome of one diagnostic handshake probe (see `probeHandshake`). Never an exception — a probe
 * that itself throws is reported as an `error` result, so the caller always has something to log. */
export type ProbeResult =
  | { kind: "status"; status: number } // got an HTTP status line: 101 ⇒ reachable+authed; 401/403 ⇒ token
  | { kind: "error"; code?: string; message?: string } // transport/TLS failure before any status line
  | { kind: "timeout" }; // no response within the deadline

/** A one-line reason + an optional multi-line remediation hint (newline-joined, no leading indent). */
export interface Diagnosis {
  summary: string;
  hint?: string;
}

/** TLS verification errors that all mean "this process doesn't trust the chain SecChat served" —
 * almost always a missing root/intermediate in the trust store rather than a bad server. The reported
 * bug was `UNABLE_TO_GET_ISSUER_CERT`: the server serves leaf+intermediate but the root isn't trusted. */
const TLS_TRUST_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
]);

const CA_TRUST_HINT =
  "SecChat's TLS certificate chain isn't trusted by this process.\n" +
  "Node needs the FULL chain — including the ROOT CA — in NODE_EXTRA_CA_CERTS; the leaf+intermediate the\n" +
  "server serves is not enough. Point NODE_EXTRA_CA_CERTS at a PEM bundle holding the root (and any\n" +
  "intermediates) and restart the daemon. On Node 24+, `--use-system-ca` uses the OS trust store instead.";

const TOKEN_HINT =
  "SecChat rejected the daemon's credential. Check SECCHAT_RUNNER_TOKEN (or SECCHAT_TOKEN): it may be\n" +
  "missing, expired, or issued for a different SecChat instance. A desktop-minted runner token is short-lived.";

/** First `code` string found by walking an error's `cause` chain and any AggregateError `errors[]` — a
 * Node/undici network error nests the real errno (ECONNREFUSED, ENOTFOUND, a TLS code) one or more
 * levels down, or spread across the addresses it tried. */
export function firstErrorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const x = stack.pop();
    if (!x || typeof x !== "object" || seen.has(x)) continue;
    seen.add(x);
    const o = x as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof o.code === "string") return o.code;
    if (o.cause) stack.push(o.cause);
    if (Array.isArray(o.errors)) for (const e of o.errors) stack.push(e);
  }
  return undefined;
}

/** Map a probe outcome to an operator-facing diagnosis. Pure — the whole point is that this is
 * exhaustively unit-testable without a socket. */
export function diagnoseConnect(r: ProbeResult): Diagnosis {
  if (r.kind === "timeout") {
    return { summary: "timed out reaching the server (no response) — check SECCHAT_URL and network reachability" };
  }
  if (r.kind === "status") {
    // 101 means the handshake ACTUALLY succeeds now — the drop that triggered us was transient (a proxy
    // idle timeout, a server restart) and the scheduled reconnect will recover. Nothing to fix.
    if (r.status === 101) return { summary: "server reachable and token accepted (the drop looks transient) — reconnecting" };
    if (r.status === 401 || r.status === 403) return { summary: `server rejected the attach (HTTP ${r.status})`, hint: TOKEN_HINT };
    if (r.status === 400) return { summary: "server rejected the handshake (HTTP 400) — check the SecChat version and that SECCHAT_URL has no stray path" };
    return { summary: `unexpected HTTP ${r.status} from /runner — is SECCHAT_URL pointing at a SecChat server?` };
  }
  const code = r.code;
  if (code && TLS_TRUST_CODES.has(code)) return { summary: `TLS certificate chain not trusted [${code}]`, hint: CA_TRUST_HINT };
  if (code === "CERT_HAS_EXPIRED") return { summary: "TLS certificate has expired [CERT_HAS_EXPIRED] — the server's certificate needs renewing" };
  if (code === "ECONNREFUSED") return { summary: "connection refused [ECONNREFUSED] — is SECCHAT_URL correct and the server running?" };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { summary: `host not found [${code}] — check the hostname in SECCHAT_URL` };
  if (code === "ECONNRESET") return { summary: "connection reset [ECONNRESET] — a proxy or the server closed the connection mid-handshake" };
  const detail = code ? `[${code}]` : r.message ? `(${r.message})` : "(unknown transport error)";
  return { summary: `could not reach /runner ${detail}` };
}

/** Exponential reconnect backoff: `baseMs`, 2×, 4×, … capped at `maxMs`. `failures` is the count of
 * consecutive failed attaches (1 = the first failure). Pure; used so a persistent outage becomes a
 * slow, quiet retry instead of a silent tight loop. */
export function backoffDelay(failures: number, baseMs: number, maxMs: number): number {
  if (failures <= 1) return Math.min(baseMs, maxMs);
  return Math.min(baseMs * 2 ** (failures - 1), maxMs);
}

/** Replay the `/runner` WebSocket opening handshake over a plain http(s) request purely to learn WHY a
 * real attach failed (the built-in WebSocket won't tell us). Uses the same URL — and so the same token
 * — reads only the status line / transport error, and tears the request down at once. Because it only
 * ever runs while the daemon is otherwise DISCONNECTED, the brief upgrade it may complete on a healthy
 * server (status 101) can't supersede a live daemon. Never rejects. `wsUrl` may be ws/wss or http/https. */
export function probeHandshake(wsUrl: string, timeoutMs = 4_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ProbeResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let req: ClientRequest;
    try {
      const u = new URL(wsUrl);
      const tls = u.protocol === "wss:" || u.protocol === "https:";
      u.protocol = tls ? "https:" : "http:";
      req = (tls ? httpsRequest : httpRequest)(u, {
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        },
        timeout: timeoutMs,
      });
    } catch (e) {
      done({ kind: "error", code: firstErrorCode(e), message: e instanceof Error ? e.message : String(e) });
      return;
    }
    // A good token yields 101 ('upgrade'); any non-101 (401/403/…) arrives as a normal 'response'. Either
    // way we only want the status line, then we destroy — never speaking the runner protocol.
    req.on("upgrade", (res) => {
      done({ kind: "status", status: res.statusCode ?? 101 });
      req.destroy();
    });
    req.on("response", (res) => {
      done({ kind: "status", status: res.statusCode ?? 0 });
      res.destroy();
      req.destroy();
    });
    req.on("timeout", () => {
      done({ kind: "timeout" });
      req.destroy();
    });
    req.on("error", (e) => done({ kind: "error", code: firstErrorCode(e), message: e.message }));
    req.end();
  });
}
