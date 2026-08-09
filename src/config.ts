// Environment-driven configuration. No secrets are defaulted; a missing REQUIRED value fails
// closed at startup (never silently insecure). Kept dependency-free — plain process.env.

import {
  DEFAULT_MARKING_LEVELS,
  makeMarkingPolicy,
  type MarkingPolicy,
  parseMarkingLevels,
} from "./marking/policy.ts";

export interface Config {
  host: string;
  port: number;
  /** SecSSO (Authentik) OIDC issuer — its JWKS is the ONLY trust root for user tokens. */
  oidcIssuer: string;
  /** Expected audience (SecChat's OIDC client id). Tokens for other audiences are rejected. */
  oidcAudience: string;
  /** JWKS endpoint; derived from the issuer when not set explicitly. */
  jwksUrl: string;
  /** SecRouter gateway base URL — the assistant path routes model calls here (delegated). */
  secrouterUrl: string;
  /** Service token SecChat presents to SecRouter (the assistant path needs it; a bare chat
   * without agents does not). The real client-credentials flow replaces the static token later. */
  secrouterToken?: string;
  /** Postgres DSN for the PgStore (unset ⇒ in-memory store; dev/test only). */
  databaseUrl?: string;
  /** SecSSO group whose members may read the admin / audit-review console (/admin*). */
  adminGroup: string;
  /** DEV ONLY: serve /admin with a synthetic admin principal (no real login). Off by default;
   * never enable outside local development — the real console auths via SecSSO. */
  devMode: boolean;

  // ── SSO login (OIDC BFF — see auth/bff.ts). The backend runs the Authorization Code + PKCE
  // dance itself and issues an httpOnly session cookie; no OIDC token ever reaches the browser.
  // Fully optional — the bearer-JWT path above (and dev tokens) work with none of this set. ────

  /** OIDC client id for the BFF login flow. Defaults to `oidcAudience` — the same SecChat OIDC
   * client is normally used for both the bearer-JWT audience check and the login flow. */
  oidcClientId: string;
  /** Confidential-client secret for the BFF's server-side token exchange. Unset ⇒ SSO login is
   * disabled (see `ssoEnabled`) — only the bearer-JWT path (and dev tokens) work. */
  oidcClientSecret?: string;
  /** External base URL this app is reachable at (e.g. https://secchatng.sec.internal) — builds
   * the OIDC redirect_uri (`${publicUrl}/auth/callback`) and decides the cookie `Secure` flag.
   * Unset ⇒ SSO login is disabled. */
  publicUrl?: string;
  /** HS256 signing key for the SecChat-minted session cookie (see auth/session.ts). Unset ⇒ SSO
   * login is disabled — never falls back to an unsigned or guessable key. */
  sessionSecret?: string;
  /** Session cookie TTL, seconds. */
  sessionTtl: number;
  /** True only once `oidcClientSecret`, `publicUrl`, and `sessionSecret` are ALL set. When
   * false, `/auth/login|callback|logout` 503 and the client falls back to the dev/bearer path;
   * `/auth/status` always reports this value so the client knows which login UI to show. */
  ssoEnabled: boolean;

  /** The classification-marking ladder + default level (a DEPLOYMENT SETTING). Drives channel/
   * message marking, the rendered banners, and the blocking spillage checks. Defaults to
   * UNCLASSIFIED → PROPRIETARY → CUI → CLASSIFIED with UNCLASSIFIED as the fail-safe default.
   * Set `SECCHAT_MARKING_LEVELS` (comma-separated, low→high) and `SECCHAT_MARKING_DEFAULT`. */
  marking: MarkingPolicy;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v || !v.trim()) throw new Error(`missing required env ${key}`);
  return v.trim();
}

function opt(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key];
  return v && v.trim() ? v.trim() : fallback;
}

/** Build a Config from an env bag (defaults to process.env). Throws on missing required keys. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const issuer = req(env, "SECCHAT_OIDC_ISSUER").replace(/\/+$/, "");
  const oidcAudience = req(env, "SECCHAT_OIDC_AUDIENCE");
  const oidcClientSecret = env.SECCHAT_OIDC_CLIENT_SECRET?.trim() || undefined;
  const publicUrl = env.SECCHAT_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined;
  const sessionSecret = env.SECCHAT_SESSION_SECRET?.trim() || undefined;
  // Marking ladder: a deployment setting. An override that's malformed (empty, or a default outside
  // the ladder) fails closed at startup via makeMarkingPolicy — never silently insecure.
  const markingLevelsRaw = env.SECCHAT_MARKING_LEVELS?.trim();
  const markingLevels = markingLevelsRaw ? parseMarkingLevels(markingLevelsRaw) : [...DEFAULT_MARKING_LEVELS];
  const marking = makeMarkingPolicy(markingLevels, opt(env, "SECCHAT_MARKING_DEFAULT", markingLevels[0] ?? ""));
  return {
    host: opt(env, "SECCHAT_HOST", "127.0.0.1"),
    port: Number(opt(env, "SECCHAT_PORT", "47010")),
    oidcIssuer: issuer,
    oidcAudience,
    jwksUrl: opt(env, "SECCHAT_JWKS_URL", `${issuer}/.well-known/jwks.json`),
    secrouterUrl: opt(env, "SECROUTER_URL", "http://127.0.0.1:47002"),
    secrouterToken: env.SECROUTER_TOKEN?.trim() || undefined,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    adminGroup: opt(env, "SECCHAT_ADMIN_GROUP", "secchat-admins"),
    devMode: (env.SECCHAT_DEV_MODE?.trim() || "") === "1",
    oidcClientId: opt(env, "SECCHAT_OIDC_CLIENT_ID", oidcAudience),
    oidcClientSecret,
    publicUrl,
    sessionSecret,
    sessionTtl: Number(opt(env, "SECCHAT_SESSION_TTL", "28800")),
    ssoEnabled: Boolean(oidcClientSecret && publicUrl && sessionSecret),
    marking,
  };
}
