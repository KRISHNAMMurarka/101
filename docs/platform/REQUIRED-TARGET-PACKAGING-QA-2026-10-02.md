# Required-target packaging, 2 October 2026

K08 is implemented in the containing commit, based on `239ae56`. The actual tool
SHA-256 is `6d687254d0ab5728134181b5d21bedfd30a5d79447b0917b656516e31984e2c0`;
test SHA-256 is `b4e2c69278b9ef3618e5c7037762a35d1e93b6ebcf1a24f02d6abe8ae36ec216`.
This closes the collector's required-target semantics only. No support row or
native/browser release, provenance, license or publication acceptance is promoted.

The old actual CLI reported `1 produced, 1 skipped` with exit zero after its
required Hub producer failed. It also removed a prior SDK artifact by deleting
all of `release/`. Both smallest regressions failed before the implementation.
The tests copy the real CLI into an owned disposable repository and run actual
npm fixture scripts at the real producer paths. Their bytes are fixtures, not
qualified Web/Hub/APK runtime artifacts.

The collector now creates one unique `release/package-*` output. It rejects
unknown/duplicate arguments before any build or output, and rejects missing,
empty, symlink or unsupported artifacts. Failed partial copies are removed only
inside the current run. Prior outputs and current failure manifests remain.

In `--release` mode every named target is required; omission of names requires
all four current targets. Web and Hub use existing production commands. Link is
an intermediate JavaScript export, Wear is debug: release mode skips their
producers and exits nonzero. Diagnostic mode still attempts independent targets
and reports skips with exit zero. Both modes always record
`releaseAccepted: false`. `packagingComplete: true` means only that selected
production packaging completed; signing, installation and release approval need
their separate evidence and authorization.

| Evidence | Result |
| --- | --- |
| [Old CLI RED](receipts/2026-10-02-required-packaging-red.log) | Required producer failure exited zero; prior artifact was deleted |
| [Focused final tests](receipts/2026-10-02-required-packaging-green.log) | Seven actual-CLI tests pass, including successful production fixtures, diagnostic skips, blocked profiles, missing/empty/symlink artifacts, strict arguments and preservation across two outputs |
| [Intermediate failure](receipts/2026-10-02-required-packaging-hub-path-failure.log) | Six of seven passed; Hub collection had a duplicated absolute root; relative producer path fixed before final GREEN |
| [Actual Web receipt](receipts/2026-10-02-required-packaging-web.receipt.json) | Node 24.14.0/npm 11.9.0/macOS arm64; real production build/copy, exit zero; 431 files/53,551,435 bytes; legacy manifest and all five final SDK tarballs preserve exact hashes |
| [Actual profile rejection](receipts/2026-10-02-required-packaging-blocked.receipt.json) | Release request for Wear and Link exits one, no artifacts produced, debug/intermediate reasons retained; no native export/Gradle invocation |

Manifests and normalized stdout/stderr transcripts are retained alongside these
receipts. Transcript normalization trims trailing whitespace on lines; original
logs remain under the matching `/tmp/101-required-packaging-*` paths on this host.
Actual local outputs remain at `release/package-mAUDi0` and
`release/package-bk9sEB`. The Web package receipt is packaging evidence; offline,
cache/update, installed native, signing and target-OS qualifications remain open.
This collector trusts the existing local build commands and their output paths;
it does not establish immutable build inputs or binary provenance (K10/K11).

```sh
npm run package:release -- --release web
npm run package:release -- --release web hub
# Expected failure: current profiles are debug and intermediate.
npm run package:release -- --release wear link
# Independent diagnostic attempts, never release acceptance.
npm run package:release -- web hub wear
node --experimental-strip-types --test tests/release-packaging.test.ts
node tools/audit-platform-records.mjs
```

[Implementation plan](../superpowers/plans/2026-10-02-required-target-packaging.md)
and `required-target-packaging-2026-10-02` in [task evidence](task-evidence.json)
record the scoped acceptance. Exact candidate types, lint, unit, fresh build and
rendered gates are required before the local integration commit.
