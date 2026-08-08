// Admin access control for the audit-review console (AU 3.3.5/6: only authorized reviewers may
// read the audit trail). Membership in the configured admin group — a claim carried in the
// SecSSO token, verified via JWKS like everything else — is the sole gate. Pure + trivial, but
// kept in one place so the check is consistent across every /admin* route.

import type { Principal } from "../types.ts";

export function isAdmin(principal: Principal, adminGroup: string): boolean {
  return principal.groups.includes(adminGroup);
}
