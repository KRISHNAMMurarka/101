# Required-target local packaging

Base: `239ae56f362f87b9cbb325130817871600301069`. Implements K08 only. The
owner authorized inline integration and waived repeated design approval for the
full SDK plan. This small sequential lane stays with the integration controller.

Observable outcome: `npm run package:release -- --release web hub` exits nonzero
when either required target is unavailable. A successful check identifies only
complete production packaging; it never grants release acceptance, signing,
installation, support or publication. Default invocation remains diagnostic.

The current tool catches every build failure and exits zero, accepts mixed known
and unknown target names, exports a debug Wear APK without a profile distinction,
and deletes all of `release/`, including unrelated SDK artifacts. The only direct
caller is the root npm script; no app imports this tool.

## Contract and files

- `tools/package-release.mjs`: strict arguments; all selected targets required
  in `--release` mode, or all known targets when names are omitted. Preserve
  diagnostic mode's independent target attempts and zero exit on build skips.
- Web and Hub use their existing production build commands. Link is an
  intermediate JavaScript export, Wear is debug. Release mode records these
  targets as blocked and does not execute their build commands. No new signing
  or native distribution target is invented.
- Every run creates one unique `release/package-*` directory. Copy only produced
  nonempty regular artifacts; reject symlinks. Remove only a failed target's
  partial copy. Preserve prior outputs and failure manifests for inspection.
- Manifest schema 1 records mode, required targets, profiles, produced/skipped
  targets, packaging status and `releaseAccepted: false`. Nonzero release exit
  on any skip; complete production packaging does not imply an accepted release.
- `tests/release-packaging.test.ts`: run the actual CLI copied into a disposable
  fixture repository with real npm scripts producing the exact existing target
  paths. No production dependencies, credential access or root-output mutation.
- Documentation and `task-evidence.json` bind RED/GREEN, source/tool versions,
  actual local Web production packaging and actual debug/intermediate rejection.
  Close K08 only after its acceptance and exact commit gates pass.

## Validation order

1. Observe old CLI fail required-failure and prior-artifact-preservation checks.
2. Implement and run focused actual-CLI tests: required failure, production
   success, missing/empty/symlink artifact, debug/intermediate rejection,
   diagnostic partial success, strict unknown/duplicate flags and fresh outputs.
3. Run actual `--release web` locally; retain manifest and redacted command/output.
   Run actual `--release wear link`; verify nonzero and no build/artifact claim.
4. Stage the final candidate, run types/lint/unit/fresh build/rendered once, then
   commit locally. Keep K04–K07, broader release acceptance and publishing open.

## Execution evidence

The two baseline regressions failed against the old actual CLI. Final seven
focused tests pass after correcting the Hub producer path. Actual local
`--release web` succeeds and preserves exact SDK/legacy hashes; actual
`--release wear link` exits one without producing artifacts or invoking native
builders. See the [QA receipt](../../platform/REQUIRED-TARGET-PACKAGING-QA-2026-10-02.md).
