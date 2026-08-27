// One-shot CMMC evidence bundle for the admin / audit-review console (spec B.6) — backs
// `GET /admin/api/evidence`. Modeled on secrouter's `handleEvidence`/`buildControlSelfAssessment`
// (work/secrouter/src/server.ts): product/version/generatedAt/generatedBy, a SANITIZED config
// posture (booleans and rule/level NAMES only — never a secret, token, or DSN), the tamper-evidence
// verdict (src/admin/verify.ts), the last N audit events (already metadata-only by construction —
// see src/audit/chain.ts's header), and a live control self-assessment.
//
// Depends only on the `Store` PORT plus the deployment's already-loaded policy objects (marking,
// dlp, capabilities) — never `Config` itself, so this never has a secret/token/DSN field to
// accidentally serialize. Testable offline with a fake store, same posture as buildOverview.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuditEvent, Store } from "../types.ts";
import type { MarkingPolicy } from "../marking/policy.ts";
import type { DlpPolicy } from "../dlp/policy.ts";
import type { CapabilityPolicy } from "../auth/capabilities.ts";
import { buildAuditVerify, type AuditVerifyResult } from "./verify.ts";

/** How many recent audit events the bundle carries (spec B.6: "last N"). Metadata-only rows (see
 * AuditEvent), so this is a volume choice, not a content-safety one. */
const AUDIT_RECENT_LIMIT = 200;

/** Everything the bundle needs beyond the store — the deployment's already-constructed policy
 * objects (never raw env/Config, so there is no secret field to filter out). */
export interface EvidenceDeps {
  store: Store;
  marking: MarkingPolicy;
  dlp: DlpPolicy;
  capabilities: CapabilityPolicy;
  adminGroup: string;
  /** Whether a step-up minter/verifier is configured (config.stepUp !== undefined) — never the
   * secret itself. */
  stepUpConfigured: boolean;
  /** Whether the Kubernetes agent pool is configured (config.pool && a runner-token minter). */
  poolConfigured: boolean;
  /** Whether voice calling is usable (config.mediad configured — recording/relay available), i.e.
   * the same signal `calls` being wired represents. */
  voiceConfigured: boolean;
}

export interface SanitizedConfig {
  marking: { levels: string[]; default: string; caveats: Array<{ code: string; name: string; level: string }> };
  dlp: { mode: string; ruleNames: string[] };
  capabilities: Record<string, { grouped: boolean; stepUpRequired: boolean }>;
  adminGroup: string;
  stepUp: { configured: boolean };
  pool: { configured: boolean };
  voice: { configured: boolean };
}

export interface ControlAssessment {
  /** FAMILY-ID citation form (spec B.5), e.g. "AU-3.3.8". A slash joins multiple ids one entry
   * jointly addresses (e.g. "AU-3.3.1/3.3.2"). */
  id: string;
  requirement: string;
  /** file:function evidence for this assessment (never just a filename). */
  evidence: string;
  status: string;
}

export interface EvidenceBundle {
  product: string;
  version: string;
  generatedAt: string;
  generatedBy: string;
  config: SanitizedConfig;
  auditChain: AuditVerifyResult;
  auditRecent: AuditEvent[];
  controls: ControlAssessment[];
}

/** Reads `package.json`'s `version` next to the project root. Best-effort: an unreadable/missing
 * file (e.g. a bundled build without it alongside) falls back to "0.0.0" rather than throwing —
 * this is evidence metadata, not something that should ever break the admin console. */
function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The config posture slice of the bundle — names, levels, and booleans only. Never the DLP rule
 * PATTERNS (dlp/policy.ts's own header: exposing them would help an insider tune content to evade
 * them — the same reason they're never sent to the client), and never a secret/token/DSN, because
 * this is built from the already-loaded policy objects, not from `Config`. */
function sanitizedConfig(deps: EvidenceDeps): SanitizedConfig {
  return {
    marking: {
      levels: deps.marking.levels,
      default: deps.marking.default,
      caveats: deps.marking.caveats.map((c) => ({ code: c.code, name: c.name, level: c.level })),
    },
    dlp: {
      mode: deps.dlp.mode,
      ruleNames: deps.dlp.rules.map((r) => r.name),
    },
    capabilities: Object.fromEntries(
      Object.entries(deps.capabilities).map(([capability, rule]) => [
        capability,
        { grouped: rule.group !== "", stepUpRequired: rule.stepUpSeconds > 0 },
      ]),
    ),
    adminGroup: deps.adminGroup,
    stepUp: { configured: deps.stepUpConfigured },
    pool: { configured: deps.poolConfigured },
    voice: { configured: deps.voiceConfigured },
  };
}

/** Derive a live control self-assessment from the running config + verified chain state — the
 * fixed family of controls this component claims (spec: AC-3.1.1, IA-3.5.3, AU-3.3.1/3.3.2,
 * AU-3.3.5, AU-3.3.8, MP marking/DLP, SC governed-LLM egress). See
 * docs/compliance/cmmc-control-matrix.md for the fuller mapping (more controls, Shared
 * Responsibility) — this is the SUBSET a live endpoint can actually self-attest to from state. */
function buildControlSelfAssessment(deps: EvidenceDeps, verify: AuditVerifyResult): ControlAssessment[] {
  const gatedCapabilities = Object.entries(deps.capabilities).filter(([, rule]) => rule.group !== "");
  return [
    {
      id: "AC-3.1.1",
      requirement: "Limit system access to authorized users / privileged transactions",
      evidence: "src/auth/capabilities.ts (authorizeCapability, defaultCapabilityPolicy), src/http/server.ts (enforceCapability)",
      status: gatedCapabilities.length > 0
        ? `enforced — ${gatedCapabilities.length}/${Object.keys(deps.capabilities).length} capabilities group-gated`
        : "NO capabilities group-gated",
    },
    {
      id: "IA-3.5.3",
      requirement: "Multifactor / step-up authentication for privileged actions",
      evidence: "src/auth/stepup.ts (makeStepUp), src/http/server.ts (stepUpAge, enforceCapability)",
      status: deps.stepUpConfigured ? "step-up available (per-capability opt-in)" : "NOT configured",
    },
    {
      id: "AU-3.3.1/3.3.2",
      requirement: "Create audit records traceable to individual users",
      evidence: "src/audit/chain.ts (computeAuditHash), src/store/memory.ts + src/store/pg.ts (appendAudit — actor/actAs on every event)",
      status: `active — ${verify.audit.checked} event(s) recorded`,
    },
    {
      id: "AU-3.3.5",
      requirement: "Correlate audit records to support review, analysis, and reporting",
      evidence: "src/admin/gate.ts (isAdmin), src/admin/overview.ts (buildOverview), src/http/server.ts (GET /admin, /admin/api/overview, /admin/api/audit/verify)",
      status: `admin console gated to group "${deps.adminGroup}"`,
    },
    {
      id: "AU-3.3.8",
      requirement: "Protect audit information from unauthorized access, modification, and deletion",
      evidence: "src/audit/chain.ts (verifyAuditChain, verifyMessageChain), src/admin/verify.ts (buildAuditVerify)",
      status: verify.ok
        ? `intact — audit chain + ${verify.messages.length} message chain(s) verified${verify.truncated ? " (truncated)" : ""}`
        : "BROKEN — see /admin/api/audit/verify for the failing chain",
    },
    {
      id: "MP-3.8.2",
      requirement: "Mark CUI media (banners) and scan content for sensitive data before it's posted",
      evidence: "src/marking/policy.ts (makeMarkingPolicy), src/dlp/policy.ts (DlpPolicy.scan), src/governance/append.ts (governedAgentAppend)",
      status: `marking ladder [${deps.marking.levels.join(" < ")}], DLP mode "${deps.dlp.mode}" (${deps.dlp.rules.length} rule(s))`,
    },
    {
      id: "SC-3.13.6",
      requirement: "Deny-by-default network flow for LLM egress (CUI leaving the boundary)",
      evidence: "src/secrouter/client.ts (makeLlmClient) — delegated to SecRouter's egress allowlist + classification gate (see secrouter's own control matrix); SecChat never calls a model endpoint directly",
      status: "delegated to SecRouter",
    },
  ];
}

/** Build the full evidence bundle. `generatedBy` is the REQUESTING admin's principal id (never a
 * service identity) — the route supplies it from the verified caller, same as every other admin
 * action's audit attribution. */
export async function buildEvidence(deps: EvidenceDeps, generatedBy: string): Promise<EvidenceBundle> {
  const [verify, auditEvents] = await Promise.all([buildAuditVerify(deps.store), deps.store.listAudit()]);
  return {
    product: "SecChat",
    version: readPackageVersion(),
    generatedAt: new Date().toISOString(),
    generatedBy,
    config: sanitizedConfig(deps),
    auditChain: verify,
    auditRecent: auditEvents.slice(-AUDIT_RECENT_LIMIT),
    controls: buildControlSelfAssessment(deps, verify),
  };
}
