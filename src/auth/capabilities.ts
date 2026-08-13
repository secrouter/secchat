// Privileged-capability authorization — the gate for the suite's high-consequence actions. Two
// independent dimensions, both a DEPLOYMENT SETTING and both fed from the identity the IdP already
// asserts:
//
//   1. GROUP. A capability may require membership in a named group. Groups arrive as the `groups`
//      claim on the verified token (SecSSO/Authentik today; Azure AD / Entra group claims later —
//      no code change, just configure the group NAME the IdP emits). Empty group ⇒ no group gate.
//
//   2. STEP-UP. A capability may require a recent re-authentication (a fresh, deliberate identity
//      proof — NIST 800-171 IA-11), expressed as a maximum age in seconds. 0 ⇒ no step-up.
//
// `authorizeCapability` is pure (group membership + a caller-supplied step-up age), so it's trivially
// testable; the HTTP layer supplies the step-up age from a signed step-up token (auth/stepup.ts) and
// maps a denial to 403. Defaults (built in config.ts) preserve today's behavior: redact/downgrade
// default to the admin group (as before), agent/webhook are ungated until a deployment ties them to a
// group, and step-up is off everywhere until enabled.

import type { Principal } from "../types.ts";

/** The gated privileged actions. `agent.manage` deliberately COMBINES spawning a coding agent and
 * granting it execute — both are "stand up / empower an executing delegate", one capability. */
export const CAPABILITIES = ["message.redact", "agent.manage", "marking.downgrade", "webhook.create"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityRule {
  /** IdP group whose members hold this capability (from the token `groups` claim). Empty ⇒ no gate. */
  group: string;
  /** Required re-auth freshness in seconds — an action needs a step-up no older than this. 0 ⇒ none. */
  stepUpSeconds: number;
}

export type CapabilityPolicy = Record<Capability, CapabilityRule>;

export type CapabilityDecision =
  | { allow: true }
  | { allow: false; reason: "forbidden_group"; group: string }
  | { allow: false; reason: "stepup_required"; capability: Capability; maxAgeSeconds: number };

/** Decide whether `principal` may exercise `capability`. `stepUpAgeSeconds` is how long ago they last
 * re-authenticated (Infinity if never / no valid step-up token). Group is checked first (you can't
 * step-up your way into a group you're not in), then freshness. */
export function authorizeCapability(
  principal: Principal,
  capability: Capability,
  policy: CapabilityPolicy,
  stepUpAgeSeconds: number,
): CapabilityDecision {
  const rule = policy[capability];
  if (rule.group && !principal.groups.includes(rule.group)) {
    return { allow: false, reason: "forbidden_group", group: rule.group };
  }
  if (rule.stepUpSeconds > 0 && stepUpAgeSeconds > rule.stepUpSeconds) {
    return { allow: false, reason: "stepup_required", capability, maxAgeSeconds: rule.stepUpSeconds };
  }
  return { allow: true };
}

/** Build a policy where the given capabilities require `adminGroup` and the rest are ungated, all with
 * step-up off — the safe, behavior-preserving default before any per-capability config is applied. */
export function defaultCapabilityPolicy(adminGroup: string): CapabilityPolicy {
  const ungated: CapabilityRule = { group: "", stepUpSeconds: 0 };
  return {
    // These default to the admin group; a deployment can re-point any of them at another IdP group.
    "message.redact": { group: adminGroup, stepUpSeconds: 0 },
    "marking.downgrade": { group: adminGroup, stepUpSeconds: 0 },
    // Minting/revoking a standing external credential defaults to admins too — set
    // SECCHAT_CAP_WEBHOOK_GROUP to widen it to another group (or "" to ungate).
    "webhook.create": { group: adminGroup, stepUpSeconds: 0 },
    // Still ungated by default (any member may stand up their own coding agent); a deployment ties
    // it to a group if it wants to restrict that.
    "agent.manage": { ...ungated },
  };
}
