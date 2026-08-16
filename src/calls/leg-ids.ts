// Fixed backend-side leg-correlation labels for secchat-mediad's two-leg control API
// (docs/plans/voice-contracts.md §2.1's `POST /sessions` example uses these exact literal
// strings). NOT random per-call ids (this used to mint a fresh `randomUUID()` pair per accept),
// and not a client credential either way — §2.3/§11's "leg tokens... backend-side routing labels".
//
// Kept fixed (rather than random) so a post-crash reconciliation sweep
// (calls/mediad-client.ts's `reconcileUnclaimedSessions`) can tell which finalize-manifest file is
// whose WITHOUT persisting a separate leg->sub mapping anywhere: `"leg_caller.ogg"` is always the
// caller's leg, `"leg_callee.ogg"` always the callee's, for every session past or present — the
// `calls` row's own `caller`/`callee` columns are the only mapping ever needed.
//
// A standalone module (rather than living in calls/registry.ts, which imports FROM
// calls/mediad-client.ts) so both registry.ts and mediad-client.ts can import these as runtime
// VALUES without creating an import cycle.

export const LEG_CALLER_ID = "leg_caller";
export const LEG_CALLEE_ID = "leg_callee";
