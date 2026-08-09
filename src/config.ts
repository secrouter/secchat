// Environment-driven configuration. No secrets are defaulted; a missing REQUIRED value fails
// closed at startup (never silently insecure). Kept dependency-free — plain process.env.

import {
  DEFAULT_MARKING_PROFILE,
  makeMarkingPolicy,
  type MarkingPolicy,
  markingProfile,
  parseMarkingLevels,
} from "./marking/policy.ts";
import { DlpPolicy, type DlpMode, parseDlpRules } from "./dlp/policy.ts";
import { type CapabilityPolicy, type CapabilityRule, defaultCapabilityPolicy } from "./auth/capabilities.ts";
import { makeStepUp, type StepUp } from "./auth/stepup.ts";

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

  /** Local DLP: an on-premise content scanner run on every message post. `SECCHAT_DLP_MODE`
   * (off|flag|block, default flag) and an optional `SECCHAT_DLP_RULES` JSON override. Fails closed
   * at startup on a bad mode or malformed rule. */
  dlp: DlpPolicy;

  /** Privileged-action authorization: each capability's required IdP group + step-up freshness.
   * `SECCHAT_CAP_<REDACT|AGENT|DOWNGRADE|WEBHOOK>_GROUP` / `_STEPUP`. Defaults preserve today's
   * behavior (redact/downgrade → admin group; agent/webhook ungated; step-up off). */
  capabilities: CapabilityPolicy;

  /** Step-up token minter/verifier — present when a signing secret is available
   * (`SECCHAT_STEPUP_SECRET`, else the session secret). Unset ⇒ step-up can't be satisfied, so any
   * capability configured to require it fails closed. */
  stepUp?: StepUp;
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
  // Marking: a deployment posture. `SECCHAT_MARKING_PROFILE` (dod-cui default | dod-classified |
  // commercial) presets the taxonomy + baseline; `SECCHAT_MARKING_LEVELS` fully overrides it (a
  // custom ladder). Either way `SECCHAT_MARKING_DEFAULT` can override the baseline. A malformed
  // profile/ladder (unknown profile, empty list, or a default outside the ladder) fails closed here.
  const markingLevelsRaw = env.SECCHAT_MARKING_LEVELS?.trim();
  const profile = markingLevelsRaw ? null : markingProfile(opt(env, "SECCHAT_MARKING_PROFILE", DEFAULT_MARKING_PROFILE));
  const markingLevels = markingLevelsRaw ? parseMarkingLevels(markingLevelsRaw) : [...profile!.levels];
  const markingDefault = opt(env, "SECCHAT_MARKING_DEFAULT", profile?.default ?? markingLevels[0] ?? "");
  const marking = makeMarkingPolicy(markingLevels, markingDefault);
  // Local DLP: default to `flag` (detect + record, never block legitimate work); a bad mode or
  // malformed rule override throws here, at startup.
  const dlp = new DlpPolicy(
    opt(env, "SECCHAT_DLP_MODE", "flag") as DlpMode,
    parseDlpRules(env.SECCHAT_DLP_RULES),
  );
  // Privileged-capability policy: start from the behavior-preserving defaults, then apply optional
  // per-capability group / step-up overrides (the group names a deployment maps to its IdP).
  const adminGroup = opt(env, "SECCHAT_ADMIN_GROUP", "secchat-admins");
  const capDefaults = defaultCapabilityPolicy(adminGroup);
  const capRule = (key: string, fallback: CapabilityRule): CapabilityRule => ({
    group: env[`SECCHAT_CAP_${key}_GROUP`]?.trim() ?? fallback.group,
    stepUpSeconds: env[`SECCHAT_CAP_${key}_STEPUP`]?.trim()
      ? Number(env[`SECCHAT_CAP_${key}_STEPUP`])
      : fallback.stepUpSeconds,
  });
  const capabilities: CapabilityPolicy = {
    "message.redact": capRule("REDACT", capDefaults["message.redact"]),
    "agent.manage": capRule("AGENT", capDefaults["agent.manage"]),
    "marking.downgrade": capRule("DOWNGRADE", capDefaults["marking.downgrade"]),
    "webhook.create": capRule("WEBHOOK", capDefaults["webhook.create"]),
  };
  // Step-up signing: a dedicated secret, else the session secret. Absent ⇒ step-up unavailable.
  const stepUpSecret = env.SECCHAT_STEPUP_SECRET?.trim() || sessionSecret;
  const stepUp = stepUpSecret ? makeStepUp(stepUpSecret, Number(opt(env, "SECCHAT_STEPUP_TTL", "900"))) : undefined;
  return {
    host: opt(env, "SECCHAT_HOST", "127.0.0.1"),
    port: Number(opt(env, "SECCHAT_PORT", "47010")),
    oidcIssuer: issuer,
    oidcAudience,
    jwksUrl: opt(env, "SECCHAT_JWKS_URL", `${issuer}/.well-known/jwks.json`),
    secrouterUrl: opt(env, "SECROUTER_URL", "http://127.0.0.1:47002"),
    secrouterToken: env.SECROUTER_TOKEN?.trim() || undefined,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    adminGroup,
    devMode: (env.SECCHAT_DEV_MODE?.trim() || "") === "1",
    oidcClientId: opt(env, "SECCHAT_OIDC_CLIENT_ID", oidcAudience),
    oidcClientSecret,
    publicUrl,
    sessionSecret,
    sessionTtl: Number(opt(env, "SECCHAT_SESSION_TTL", "28800")),
    ssoEnabled: Boolean(oidcClientSecret && publicUrl && sessionSecret),
    marking,
    dlp,
    capabilities,
    stepUp,
  };
}
