// Runner token — a short-lived, OWNER-SCOPED credential a client mints (POST /auth/runner-token)
// and hands to its runner daemon so the daemon can attach at /runner AS that user. It exists for the
// session-cookie path: a desktop user authenticated by the `secchat_session` cookie has no bearer
// token to give the daemon, and handing the daemon a full bearer would over-privilege it. This token
// authorizes exactly one thing — attaching a runner for `sub` — and nothing else.
//
// Same shape/threat-model as the step-up token (auth/stepup.ts): an HS256 JWT in its OWN trust domain
// (iss/aud "secchat-runner"), disjoint from the SecSSO bearer tokens (auth/jwks.ts), the session
// cookie (auth/session.ts), and the step-up proof — so pinning HS256 + this iss/aud means a runner
// token can never be replayed as any of those, nor they as a runner credential, even if the secrets
// coincide. The /runner attach hub accepts it IN ADDITION to a full OIDC bearer (standalone daemons
// on a server still authenticate with their own service token).

import { jwtVerify, SignJWT } from "jose";

const ISSUER = "secchat-runner";
const AUDIENCE = "secchat-runner";

export interface RunnerToken {
  /** Mint a runner credential for `sub`, valid for `ttlSeconds`. */
  mint(sub: string): Promise<string>;
  /** Verify a runner token; returns its subject, or null if invalid/expired/not a runner token. */
  verify(token: string): Promise<{ sub: string } | null>;
}

export function makeRunnerToken(secret: string, ttlSeconds: number): RunnerToken {
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
    async verify(token: string): Promise<{ sub: string } | null> {
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
        return payload.sub ? { sub: payload.sub } : null;
      } catch {
        return null;
      }
    },
  };
}
