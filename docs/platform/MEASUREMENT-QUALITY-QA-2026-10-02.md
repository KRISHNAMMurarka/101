# Measurement calibration and quality contract, 2 October 2026

M07 adds a closed, immutable scalar `MeasurementReport`. A valid report has a
range-checked value, positive calibration revision and finite nonnegative
absolute error bound in the capability's exact unit. The bound is a producer
assertion, not verified sensor accuracy. Stale and unavailable reports have no
value and may carry up to eight distinct namespaced fault codes. The parser
rejects invalid ranges, cross-unit metadata, unknown fields, duplicate faults,
ordinary own getters, non-plain data and contradictory loss/value shapes.
JavaScript Proxy traps can run during object inspection; hostile in-process
providers need a serialized JSON boundary before parsing.

The [temperature caller](../../examples/device-pipelines/sensor-feedback.ts)
uses `publishReport()` to publish a valid Celsius value through the existing
authorized processor routes. It preserves the producer's calibration revision
and uncertainty in derived command provenance without conversion. Stale and
unavailable reports enter the runtime's existing loss path, close affected
routes, reset processor state and cancel pending derived commands. Its
`lastReport` retains the parsed producer report as local diagnostics. The
existing `publishTemperature()` path remains available.

## Verification

- RED tests first observed the missing parser and missing caller method.
  Parser tests cover revision, value, unit, bound, closed shape, faults,
  frozen snapshots and accessor rejection. Caller tests cover exact
  provenance, different revisions across readings, unavailable loss,
  invalid-report state retention and stale loss canceling a pending command.
  The latter was added after independent read-only review identified a
  report-path evidence gap. No implementation defect was found in that review.
- [SDK build receipt](receipts/2026-10-02-measurement-quality-sdk-build.json),
  [external consumer receipt](receipts/2026-10-02-measurement-quality-sdk-consumer.json),
  [command receipt](receipts/2026-10-02-measurement-quality-sdk-consumer-commands.json)
  and [builder diagnostic](receipts/2026-10-02-measurement-quality-sdk-build-stderr.log)
  identify the immutable producer tree and tool hashes. A clean five-package
  install audits 109 files with no symlinks or undeclared dependencies, checks
  strict NodeNext and Bundler declarations with `skipLibCheck:false`, and runs
  ordinary Node plus Chromium, Firefox and WebKit. Packed QA checks valid
  parser status/revision and the embedded example's valid report; report-path
  loss and provenance checks run in the repository's focused tests.
- Exact candidate gates are TypeScript, lint, unit tests, a fresh build and
  rendered HTML tests. The containing commit records their final counts.
  `node tools/audit-platform-records.mjs` checks the ledger. All support rows
  remain `accepted:false`.

The local artifact `release/sdk-DHuCYJ` was built from immutable producer
tree `62185d2b9fca454ff36e8b2f700ea2d6b4262d20`. The tree has no unique
commit, so the builder records `revision:null` and emits a caught commit-lookup
diagnostic while exiting zero. Manifest SHA-256:
`872e63ae3613f75c07339beca4394f36938e6248348c74f7ce2a05f41ef4bb2c`.
Builder SHA-256: `7e91360653dfbc1cd0c872eb7759d2a6a46cc2e1e5095cb0aff4079d4e0fd966`;
external QA tool SHA-256: `6e816792c3e5e1e7a1c91bdf4ad7ca878a3a34d3c4cf09291d6890e677556f05`.
Installed browser versions: Chromium 149.0.7827.55, Firefox 151.0 and WebKit
26.5. Environment: macOS 26.5.2 arm64, Node 24.14.0, npm 11.9.0,
TypeScript 5.9.3 and Playwright 1.61.1. The artifact is local and unpublished.

Reproduce the local software checks:

```sh
node --experimental-strip-types --test packages/device-model/src/quality.test.ts tests/device-pipelines.test.ts
npm run example:devices
node tools/build-sdk.mjs 62185d2b9fca454ff36e8b2f700ea2d6b4262d20
node tools/qa-sdk-consumer.mjs release/sdk-DHuCYJ/manifest.json
node tools/audit-platform-records.mjs
```

The receipt closes only M07's scalar producer-report contract. Physical
calibration, vector/spatial uncertainty, remote provenance clocks, native
providers, supported hardware and full-release qualification remain open.
