// The SecChat-minted login session: an HS256 JWT carried in an httpOnly cookie (see auth/bff.ts),
// never exposed to client JS. This is a DELIBERATELY SEPARATE trust domain from the SecSSO bearer
// JWTs verified in auth/jwks.ts — self-issued (iss/aud "secchat"), HS256 with a locally-held
// secret, never signed by (or verifiable against) the IdP's keys. That separation means a real
// SecSSO token can never be replayed as a session cookie, and a session cookie can never be
// presented as a SecSSO bearer token — the two verifiers pin disjoint algorithms/issuers.
//
// Also hosts the (small, hand-rolled) cookie codec: the repo's dependency policy is zero new npm
// packages, and all this needs is "k=v; k2=v2" parsing/serializing for cookies THIS module itself
// sets — not the full RFC 6265 grammar a general-purpose cookie library would cover.

import { jwtVerify, SignJWT } from "jose";
import type { Principal } from "../types.ts";

// Self-issued and self-verified — SecChat is both the issuer and the sole audience. Fixed
// (not configurable) so a session token is unambiguously "a SecChat session" and nothing else.
const ISSUER = "secchat";
const AUDIENCE = "secchat";

function keyFrom(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Mints an httpOnly-cookie session JWT for `principal`, HS256-signed with `secret`, expiring in
 * `ttlSeconds`. Carries exactly what `verifySession` needs to reconstruct the Principal — no more
 * (in particular, never anything from the upstream id_token beyond the claims Principal itself
 * models, so a session cookie can't accidentally leak extra IdP claims to the browser). */
export async function mintSession(principal: Principal, secret: string, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: principal.email,
    name: principal.displayName,
    groups: principal.groups,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(principal.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(keyFrom(secret));
}

/** Verifies a session token minted by `mintSession` and returns the Principal it carries. Pins
 * `algorithms:["HS256"]` plus this app's own iss/aud, so a token using "none" or an RS* alg (even
 * one an attacker fully controls the header of) is rejected before jose ever looks at a
 * signature, and a token signed for a different purpose entirely (with the same secret) can't be
 * replayed here. Throws on any failure (bad signature, wrong secret, expired, wrong alg/iss/aud,
 * missing `sub`) — callers (see auth/bff.ts's resolveSession) treat "no session" and "bad
 * session" identically, so they don't need to distinguish the failure mode. */
export async function verifySession(token: string, secret: string): Promise<Principal> {
  const { payload } = await jwtVerify(token, keyFrom(secret), {
    algorithms: ["HS256"],
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  if (!payload.sub) throw new Error("session token missing required 'sub' claim");

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    displayName: typeof payload.name === "string" ? payload.name : undefined,
    groups: Array.isArray(payload.groups) ? payload.groups.map(String) : [],
  };
}

export interface CookieOptions {
  /** Seconds until expiry. Omitted ⇒ a session cookie (cleared when the browser closes). `0` ⇒
   * immediately expired (how auth/bff.ts clears a cookie on logout / after the OIDC callback). */
  maxAge?: number;
  /** Send only over HTTPS. auth/bff.ts sets this from whether `publicUrl` is https — never
   * hardcoded true, so plain-http local/dev deployments still work. */
  secure?: boolean;
  /** Defaults to true — every cookie this app sets is a credential, never legitimately read by
   * page JS. Exposed as an option only so a future non-credential cookie could opt out. */
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

/** Serializes one Set-Cookie header value. `value` is percent-encoded so it's always a valid
 * cookie-octet sequence regardless of what it contains (a compact JWT is already cookie-safe —
 * `.`, `-`, `_`, base64url — but this is defensive rather than assuming that forever). */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Parses a request `Cookie` header ("k=v; k2=v2") into a plain name→value map. Only needs to
 * round-trip what `serializeCookie` above produces (percent-encoded values, "; "-separated
 * pairs) — not the full RFC 6265 grammar a general cookie-parsing library would handle. A
 * malformed individual pair (no "=", undecodable percent-escape) is skipped rather than
 * throwing, so one bad cookie in the header can't take down parsing of the rest. */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const rawValue = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(rawValue);
    } catch {
      out[key] = rawValue; // not percent-encoded (or malformed) — keep the raw value rather than drop it
    }
  }
  return out;
}
