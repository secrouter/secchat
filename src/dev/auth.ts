// ════════════════════════════════════════════════════════════════════════════════════════════
// DEV-ONLY TOKEN VERIFIER — THIS IS NOT AUTHENTICATION.
//
// Real auth is SecSSO (Authentik) JWTs, verified against the IdP's JWKS — signature, issuer,
// audience, and expiry are all enforced by `jose` (see src/auth/jwks.ts's `makeVerifyToken`, the
// ONLY verifier a real deployment wires in). This module instead trusts whatever `sub`/`groups`
// the caller puts directly in the token string — NO signature check at all, so anyone who can
// send a request can mint themselves any identity and any group membership.
//
// Wire this in ONLY when SECCHAT_DEV_MODE=1 (see src/config.ts's `devMode`) — local development
// with no real IdP available. NEVER enable it in a real deployment.
// ════════════════════════════════════════════════════════════════════════════════════════════

import type { VerifyToken } from "../types.ts";

// "dev.<sub>.<comma-separated-groups>" — e.g. "dev.alice.eng,secchat-admins" or "dev.bob." (no
// groups). `sub` may not contain ".", so the middle "." unambiguously separates it from groups.
const DEV_TOKEN_RE = /^dev\.([^.]+)\.(.*)$/;

/** Parses a "dev.<sub>.<comma-separated-groups>" token into a Principal — see the module header
 * above. Throws if the token doesn't match that shape, or `sub` is empty. `groups` drops empty
 * entries, so a token with no groups (e.g. "dev.bob.") yields `[]` rather than `[""]`. */
export const devVerifyToken: VerifyToken = async (token) => {
  const m = DEV_TOKEN_RE.exec(token);
  if (!m) throw new Error(`invalid dev token: ${JSON.stringify(token)}`);
  const sub = m[1];
  if (!sub) throw new Error(`invalid dev token: empty sub`);
  const groups = (m[2] ?? "").split(",").filter((g) => g.length > 0);
  return { sub, groups };
};
