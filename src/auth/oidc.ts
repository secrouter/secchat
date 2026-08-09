// The OIDC client half of the login BFF (see auth/bff.ts for the route handlers that drive
// these): discovery, PKCE, the authorize-URL builder, the server-side code-for-tokens exchange,
// and id_token verification. Dependency-free beyond `jose` + `node:crypto` + the global `fetch`,
// matching the rest of this repo's zero-new-deps policy. Every function here is a pure/stateless
// operation on its inputs except `discover`, which caches per issuer (see its own comment).

import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Principal } from "../types.ts";

export interface OidcEndpoints {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  [key: string]: unknown;
}

// discover() result, cached per issuer for the life of the process — an OIDC discovery document
// doesn't change on any timescale that matters here, and re-fetching it on every /auth/login
// would add a needless round-trip (and a needless dependency on the IdP's availability) to every
// login. Caches the in-flight PROMISE (not just the resolved value) so concurrent callers before
// the first fetch completes share one request rather than firing one each; a failed lookup is
// evicted so a later call retries (e.g. the IdP was only briefly unreachable).
const discoveryCache = new Map<string, Promise<OidcEndpoints>>();

async function fetchDiscovery(issuer: string): Promise<OidcEndpoints> {
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery returned ${res.status}`);
  const json = (await res.json()) as Partial<OidcEndpoints>;
  if (!json.authorization_endpoint || !json.token_endpoint || !json.jwks_uri) {
    throw new Error("OIDC discovery document missing required endpoints");
  }
  return json as OidcEndpoints;
}

/** GETs `<issuer>/.well-known/openid-configuration` and returns the parsed document (cached — see
 * above). Throws if the endpoint is unreachable, non-200, or missing any endpoint the BFF flow
 * needs (authorization_endpoint, token_endpoint, jwks_uri). */
export function discover(issuer: string): Promise<OidcEndpoints> {
  let pending = discoveryCache.get(issuer);
  if (!pending) {
    pending = fetchDiscovery(issuer);
    discoveryCache.set(issuer, pending);
    pending.catch(() => discoveryCache.delete(issuer));
  }
  return pending;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** A fresh PKCE code_verifier: base64url(32 random bytes) — RFC 7636's high-entropy end of the
 * allowed range (43–128 chars; this yields 43). */
export function newVerifier(): string {
  return base64url(randomBytes(32));
}

/** The PKCE S256 code_challenge for `verifier`: base64url(SHA256(ASCII(verifier))). SecChat only
 * ever generates S256 challenges (never "plain" — see the security checklist in the sprint
 * contract), so there is no `challengePlain` counterpart. */
export function challengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export interface BuildAuthorizeUrlInput {
  endpoints: Pick<OidcEndpoints, "authorization_endpoint">;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** OIDC `prompt` (e.g. "login" to FORCE a fresh re-authentication even with an active IdP
   * session — used by the step-up flow). Omitted ⇒ normal login (silent SSO allowed). */
  prompt?: string;
  /** OIDC `max_age`: maximum acceptable seconds since the user last authenticated. `0` demands a
   * brand-new authentication and makes the IdP include a fresh `auth_time` claim. */
  maxAge?: number;
}

/** Builds the SecSSO authorize-endpoint URL for the Authorization Code + PKCE (S256) flow. Every
 * dynamic value here (state, nonce, codeChallenge) is caller-supplied and caller-generated —
 * this function only assembles the URL, it doesn't mint anything itself. */
export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(input.endpoints.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.prompt) url.searchParams.set("prompt", input.prompt);
  if (input.maxAge !== undefined) url.searchParams.set("max_age", String(input.maxAge));
  return url.toString();
}

export interface ExchangeCodeInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

export interface TokenResponse {
  id_token: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** Exchanges an authorization `code` for tokens at the IdP's token endpoint — server-side only
 * (the client_secret and code_verifier never leave this process). Standard confidential-client
 * `grant_type=authorization_code` request, form-encoded per RFC 6749. Throws on a non-200
 * response or a response with no `id_token` (this BFF has nothing useful to do without one). */
export async function exchangeCode(input: ExchangeCodeInput): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
  });

  const res = await fetch(input.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`OIDC token endpoint returned ${res.status}`);

  const json = (await res.json()) as Partial<TokenResponse>;
  if (!json.id_token || typeof json.id_token !== "string") {
    throw new Error("OIDC token response missing id_token");
  }
  return json as TokenResponse;
}

// One remote JWK set per jwks_uri, reused across verifications (mirrors auth/jwks.ts's
// makeVerifyToken: jose caches/refreshes the key set internally, refetching only on a `kid`
// miss) — verifyIdToken is called once per login, so without this cache every login would
// re-fetch the IdP's JWKS from scratch.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

export interface VerifyIdTokenInput {
  jwksUri: string;
  issuer: string;
  clientId: string;
  /** When set, require the id_token's `auth_time` to be no older than this many seconds — proof
   * that the user authenticated FRESH (used by the step-up flow, which requests `max_age=0` so the
   * IdP must include `auth_time`). A missing or stale `auth_time` is rejected. */
  maxAuthAgeSeconds?: number;
  /** The nonce this process generated for the /auth/login that started this flow — must match
   * the id_token's `nonce` claim exactly, or the token is rejected (replay/injection guard). */
  nonce: string;
}

/** Verifies an id_token against the IdP's published JWKS: signature (pinned to RS256 — SecSSO's
 * signing alg; never accepts "none" or an HMAC alg an attacker could self-sign with a guessed
 * key), issuer, audience (=clientId), expiry (all via jose's jwtVerify), and the `nonce` claim
 * (checked here — jose has no built-in nonce option). Reshapes the verified payload into a
 * Principal, same shape/rules as auth/jwks.ts's bearer-token verifier. */
export async function verifyIdToken(idToken: string, opts: VerifyIdTokenInput): Promise<Principal> {
  const jwks = jwksFor(opts.jwksUri);
  const { payload } = await jwtVerify(idToken, jwks, {
    algorithms: ["RS256"],
    issuer: opts.issuer,
    audience: opts.clientId,
  });

  if (!payload.sub) throw new Error("id_token missing required 'sub' claim");
  if (payload.nonce !== opts.nonce) throw new Error("id_token nonce mismatch");

  if (opts.maxAuthAgeSeconds !== undefined) {
    // Step-up: prove the authentication is FRESH. `auth_time` must be present (max_age was
    // requested) and within the window; otherwise the IdP silently reused an old SSO session.
    const authTime = typeof payload.auth_time === "number" ? payload.auth_time : undefined;
    if (authTime === undefined) throw new Error("id_token missing 'auth_time' (step-up requires a fresh re-auth)");
    const age = Math.floor(Date.now() / 1000) - authTime;
    if (age > opts.maxAuthAgeSeconds) throw new Error(`stale auth_time: re-authentication was ${age}s ago`);
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    displayName: typeof payload.name === "string" ? payload.name : undefined,
    groups: Array.isArray(payload.groups) ? payload.groups.map(String) : [],
  };
}
