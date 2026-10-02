# Device health and resource claims, 2 October 2026

M09 adds a closed immutable provider report for one exact device. It records
observation time and age limit, battery/charging and firmware when reported,
thermal/connectivity states, distinct fault codes and per-capability state,
maximum sample rate and maximum active routes. The model rejects unknown
fields, duplicates, invalid ranges, accessors and foreign-clock age
comparisons. `assessDeviceHealth()` returns limits only for a fresh available
resource. Zero battery or a firmware string does not independently imply a
working or failed route. Provider claims do not authenticate physical state.

The embedded temperature example applies assessment to the existing source.
Unavailable, stale, denied and busy states close its upstream route, reset
the processor and cancel pending relay commands. The runtime also stores a
readiness expiry deadline: route starts, publishes, flushes and renewals
recheck it, so a report that becomes stale during active use cannot continue
delivering or leave a queued command. No background timer runs while idle.
Recovery needs a new authorized route start. The reported rate and route
ceilings are diagnostic claims; they are not dynamic runtime quotas.

## Verification

- The health model test was RED for a missing module. The embedded caller test
  was RED for absent `publishHealth()`. Focused tests then passed for exact
  schema, immutability, bounds, freshness, identity, blocking conditions and
  pending command cancellation. `npm run example:devices` passed.
- Independent read-only review found that a once-available report remained
  active after expiry. A new pipeline regression reproduced an active route
  after clock advance; a runtime regression reproduced delivery after the
  deadline. Both were RED before the runtime deadline fix and pass now.
- [SDK build receipt](receipts/2026-10-02-device-health-sdk-build.json),
  [external consumer receipt](receipts/2026-10-02-device-health-sdk-consumer.json),
  [command receipt](receipts/2026-10-02-device-health-sdk-consumer-commands.json)
  and [builder diagnostic](receipts/2026-10-02-device-health-sdk-build-stderr.log)
  identify immutable source, artifacts, tools and checks. A clean five-package
  offline install audited 113 files, no symlinks or undeclared dependencies;
  strict NodeNext and Bundler declarations used `skipLibCheck:false`. Ordinary
  Node and Chromium 149.0.7827.55, Firefox 151.0 and WebKit 26.5 passed the
  parser, example caller and expiry checks.
- The containing commit records final exact candidate TypeScript, lint, unit,
  fresh build and rendered HTML gate counts. The evidence ledger is audited
  separately. Support rows remain `accepted:false`.

The accepted local unpublished artifact is `release/sdk-XLoyjV`, built from
immutable producer tree `9d534649815b850492a41f9933da554417b71c4d`.
The producer tree has no unique commit, so the builder records `revision:null`
and emits a caught commit-lookup diagnostic while exiting zero. Manifest
SHA-256: `efee24832920eff595054d85db072ea891bf4f9a249c56356ed19944c5eaea27`.
Builder SHA-256: `7e91360653dfbc1cd0c872eb7759d2a6a46cc2e1e5095cb0aff4079d4e0fd966`;
external QA tool SHA-256: `8970e4edc2d0dd61e0f14c395377943d513be78030760ac9d0c96a3c74892b4d`.
Environment: macOS 26.5.2 arm64, Node 24.14.0, npm 11.9.0,
TypeScript 5.9.3 and Playwright 1.61.1.

Reproduce the local software checks:

```sh
node --experimental-strip-types --test packages/device-model/src/health.test.ts packages/device-runtime/src/runtime.test.ts tests/device-pipelines.test.ts
npm run example:devices
node tools/build-sdk.mjs 9d534649815b850492a41f9933da554417b71c4d
node tools/qa-sdk-consumer.mjs release/sdk-XLoyjV/manifest.json
node tools/audit-platform-records.mjs
```

This closes M09's local model and embedded caller only. Physical device health,
provider authentication, live quota enforcement, remote health binding,
actual firmware verification and final support qualification remain open.
