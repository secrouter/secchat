// Environment-driven configuration. No secrets are defaulted; a missing REQUIRED value fails
// closed at startup (never silently insecure). Kept dependency-free — plain process.env.

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
  return {
    host: opt(env, "SECCHAT_HOST", "127.0.0.1"),
    port: Number(opt(env, "SECCHAT_PORT", "47010")),
    oidcIssuer: issuer,
    oidcAudience: req(env, "SECCHAT_OIDC_AUDIENCE"),
    jwksUrl: opt(env, "SECCHAT_JWKS_URL", `${issuer}/.well-known/jwks.json`),
    secrouterUrl: opt(env, "SECROUTER_URL", "http://127.0.0.1:47002"),
    secrouterToken: env.SECROUTER_TOKEN?.trim() || undefined,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    adminGroup: opt(env, "SECCHAT_ADMIN_GROUP", "secchat-admins"),
    devMode: (env.SECCHAT_DEV_MODE?.trim() || "") === "1",
  };
}
