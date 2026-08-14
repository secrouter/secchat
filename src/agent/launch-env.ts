// Launch environments for a coding agent — WHERE its pi session runs. The user picks one when
// creating the agent (see POST /agents / GET /runner/environments). Two exist:
//
//   - "desktop": the user's own SecChat desktop app, whose runner daemon attaches over /runner and
//     is registered per-owner in RunnerRegistry. Available only while that app is connected.
//   - "pool":    shared server-side online runners — a per-session ephemeral Kubernetes pod
//     (agent/pool-runner.ts). Available when the deployment configures the pool (SECCHAT_POOL_IMAGE
//     + a runner-token minter); when it doesn't, this env is surfaced as unavailable for this box.
//
// Kept in one place so the availability the picker shows and the check POST /agents enforces can
// never disagree.

export type LaunchEnvId = "desktop" | "pool";

export interface LaunchEnvStatus {
  id: LaunchEnvId;
  label: string;
  /** Whether the agent can actually be launched here right now. */
  available: boolean;
  /** Machine-readable hint: "connected" | "not_connected" | "available" | "not_deployed". */
  reason: string;
  /** Human sentence for the picker / the block message. */
  detail: string;
}

/** The launch environments for one user, given what's currently reachable. `desktopConnected` is
 * whether that user's desktop runner daemon is attached; `poolConfigured` is whether an online pool
 * is deployed (false until it lands). */
export function launchEnvironmentsFor(opts: {
  desktopConnected: boolean;
  poolConfigured: boolean;
}): LaunchEnvStatus[] {
  return [
    {
      id: "desktop",
      label: "My desktop app",
      available: opts.desktopConnected,
      reason: opts.desktopConnected ? "connected" : "not_connected",
      detail: opts.desktopConnected
        ? "Runs on your connected desktop app."
        : "Open the SecChat desktop app and sign in, then it can host agents here.",
    },
    {
      id: "pool",
      label: "Online pool",
      available: opts.poolConfigured,
      reason: opts.poolConfigured ? "available" : "not_deployed",
      detail: opts.poolConfigured
        ? "Runs on shared online resources."
        : "No online pool is configured for this deployment.",
    },
  ];
}

/** Resolve a requested env id (defaulting to "desktop") to its current status, or null if the id is
 * unknown. The single choke point POST /agents uses to accept-or-reject a launch. */
export function resolveLaunchEnv(
  requested: string | undefined,
  opts: { desktopConnected: boolean; poolConfigured: boolean },
): LaunchEnvStatus | null {
  const id = requested ?? "desktop";
  return launchEnvironmentsFor(opts).find((e) => e.id === id) ?? null;
}
