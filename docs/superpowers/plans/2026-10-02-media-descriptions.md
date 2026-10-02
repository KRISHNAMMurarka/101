# M05 media and render-surface description implementation plan

1. Add RED tests for closed, bounded versioned media manifests: audio/video
   tracks, output tracks, render targets, codec lists, numeric ranges,
   geometry and rejection of static readiness claims. Implement immutable
   parser in the device model and export it through the public facade.
2. Add RED tests for a binding proposal driven by two concrete host probes.
   Require available registrations, exact codec overlap and unambiguous
   capture/output geometry; reject unavailable, denied, busy or incompatible
   resources. Keep this proposal separate from route start/effect evidence.
3. Add a simulated first caller showing compatible video capture-to-canvas
   and unavailable microphone/codec failure. Include it in the SDK allowlist.
4. Extend strict external declarations, ordinary Node and three-browser
   packed consumer checks. Obtain read-only review for the new contract.
5. Freeze immutable source, run clean package QA and exact
   TypeScript/lint/unit/fresh-build/rendered gates. Record receipts, audit the
   ledger and close only M05's bounded description contract locally.

The controller is the sole writer. Any repaired bug first gets a smallest
regression observed RED. Physical/browser/native media routes stay open.
