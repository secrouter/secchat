// SecSSO (Authentik) token verification, backed by the IdP's published JWKS. This is the ONLY
// place a Principal is derived from a bearer token: signature, issuer, audience, and expiry are
// all enforced by jose (jwtVerify) — we just fail closed on top and reshape the verified payload.
//
// The remote key set is built ONCE per verifier and reused for every call; jose caches it
// internally and refetches only when a `kid` misses (see jose's createRemoteJWKSet).

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "../config.ts";
import type { Principal, VerifyToken } from "../types.ts";

/** Builds a VerifyToken bound to one SecSSO (Authentik) issuer/audience/JWKS. Tokens with a bad
 * signature, wrong issuer/audience, or that are expired are rejected by jose itself — those
 * errors just propagate. The only extra check here is `sub`, which Principal requires. */
export function makeVerifyToken(cfg: Pick<Config, "jwksUrl" | "oidcIssuer" | "oidcAudience">): VerifyToken {
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUrl));

  return async (token: string): Promise<Principal> => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: cfg.oidcIssuer,
      audience: cfg.oidcAudience,
    });

    if (!payload.sub) throw new Error("verified token missing required 'sub' claim");

    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
      displayName: typeof payload.name === "string" ? payload.name : undefined,
      groups: Array.isArray(payload.groups) ? payload.groups.map(String) : [],
    };
  };
}
