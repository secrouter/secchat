// Step-up token — the proof of a RECENT re-authentication, minted by POST /auth/stepup after a fresh
// identity check and presented (header `X-Sec-StepUp`) on a step-up-gated action. A short-lived HS256
// JWT in its OWN trust domain (iss/aud "secchat-stepup"), disjoint from both the SecSSO bearer tokens
// (auth/jwks.ts) and the session cookie (auth/session.ts): pinning HS256 + this iss/aud means a step-up
// token can never be replayed as a session/bearer credential, nor those as a step-up proof, even
// though the session and step-up secrets may coincide.
//
// The point is FRESHNESS: `verify` returns the token's AGE (now − iat), and the capability layer
// (auth/capabilities.ts) compares that age to each capability's required window. A stale-but-unexpired
// token still reports its true age; jose's exp only bounds how long a token is usable at all (set the
// TTL ≥ the largest step-up window).

import { jwtVerify, SignJWT } from "jose";

const ISSUER = "secchat-stepup";
const AUDIENCE = "secchat-stepup";

export interface StepUp {
  /** Mint a fresh step-up proof for `sub`, valid for `ttlSeconds`. */
  mint(sub: string): Promise<string>;
  /** Verify a step-up token; returns its subject + age in seconds, or null if invalid/expired. */
  verify(token: string): Promise<{ sub: string; ageSeconds: number } | null>;
}

export function makeStepUp(secret: string, ttlSeconds: number): StepUp {
  const key = new TextEncoder().encode(secret);
  return {
    async mint(sub: string): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(now + ttlSeconds)
        .sign(key);
    },
    async verify(token: string): Promise<{ sub: string; ageSeconds: number } | null> {
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
        if (!payload.sub || typeof payload.iat !== "number") return null;
        const now = Math.floor(Date.now() / 1000);
        return { sub: payload.sub, ageSeconds: Math.max(0, now - payload.iat) };
      } catch {
        return null;
      }
    },
  };
}
