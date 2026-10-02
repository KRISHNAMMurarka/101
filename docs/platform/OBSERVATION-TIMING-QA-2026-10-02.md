# Clock and observation provenance contract, 2 October 2026

M08 adds a closed, immutable `ObservationTiming` record with capture and
receipt clock identities/timestamps, a bounded remote-to-local interval and
the map's drift ceiling, plus at most eight ordered processor steps. The
existing `RemoteClockMap` provides offset/uncertainty and drift expansion from
four-timestamp exchanges. A common clock permits exact age. Different clocks
require a mapped interval; `compareClockStamps()` rejects raw cross-clock
comparisons. `observationAgeBounds()` returns only the supported age interval
and clips a possible future upper capture bound at receipt. A claimed capture
time and mapping are inert data, not proof of an honest producer clock.

The [remote receiver](../../packages/device-web/src/binding.ts) builds timing
from its own clock-map result and local receipt. It retains existing raw
provenance fields, 4 KiB runtime packet limits and the unchanged wire format.
The [embedded temperature processor](../../examples/device-pipelines/sensor-feedback.ts)
appends its version/configuration step using runtime-owned observation time;
source-supplied metadata cannot replace that timing. It retains original
upstream provenance separately. No physical end-to-end latency claim follows
from this fixture.

## Verification

- The new model tests failed for a missing module before implementation.
  Caller tests then failed for absent drift readback, receiver timing and
  processor lineage. An uncertainty interval wider than the map's 60000 ms
  ceiling was reproduced RED and rejected. A forged source-provenance timing
  record was reproduced RED and fixed at the local processor's trust boundary.
  Focused final tests cover same/cross-clock comparisons, causal age clipping,
  malformed/missing mapping, processor order, drift readback, actual receiver
  provenance and derived local lineage: 58 passed.
- Independent read-only review confirmed the forged timing regression now uses
  runtime-owned fields and found no remaining concrete defect. The reviewer
  noted that the packed consumer checks public helper behavior and the
  embedded example; remote receiver mapping is exercised in repository
  `binding.test.ts`, not by a packed remote consumer.
- [SDK build receipt](receipts/2026-10-02-observation-timing-sdk-build.json),
  [external consumer receipt](receipts/2026-10-02-observation-timing-sdk-consumer.json),
  [command receipt](receipts/2026-10-02-observation-timing-sdk-consumer-commands.json)
  and [builder diagnostic](receipts/2026-10-02-observation-timing-sdk-build-stderr.log)
  identify immutable source and tool hashes. A clean five-package install
  audits 111 files with no symlinks or undeclared dependencies, checks strict
  NodeNext and Bundler declarations with `skipLibCheck:false`, and runs
  ordinary Node plus Chromium, Firefox and WebKit.
- Exact candidate gates are TypeScript, lint, unit tests, a fresh build and
  rendered HTML tests. The containing commit records final counts.
  `node tools/audit-platform-records.mjs` checks the ledger. All support rows
  remain `accepted:false`.

The accepted local artifact is `release/sdk-Uzox95`, built from immutable
producer tree `2484646811e1fd6ab8486b91656980f5598442f9`. Earlier
`release/sdk-Pb4z4V` predates the forged-provenance fix and is superseded.
Both are ignored local files and unpublished. The producer tree has no unique
commit, so the builder records `revision:null` and emits a caught commit-lookup
diagnostic while exiting zero. Manifest SHA-256:
`197573b3941e95a0784940adb7be8d57690355c1d5f7aacb9eaffb9fcfbafeca`.
Builder SHA-256: `7e91360653dfbc1cd0c872eb7759d2a6a46cc2e1e5095cb0aff4079d4e0fd966`;
external QA tool SHA-256: `5f722fb0fbfea3f2827fb8a778e0a1fe064ed024cc296977bbe55fc28a4d3c2f`.
Installed browser versions: Chromium 149.0.7827.55, Firefox 151.0 and WebKit
26.5. Environment: macOS 26.5.2 arm64, Node 24.14.0, npm 11.9.0,
TypeScript 5.9.3 and Playwright 1.61.1.

Reproduce the local software checks:

```sh
node --experimental-strip-types --test packages/device-model/src/observation-timing.test.ts packages/device-model/src/remote-clock.test.ts packages/device-web/src/binding.test.ts tests/device-pipelines.test.ts
npm run example:devices
node tools/build-sdk.mjs 2484646811e1fd6ab8486b91656980f5598442f9
node tools/qa-sdk-consumer.mjs release/sdk-Uzox95/manifest.json
node tools/audit-platform-records.mjs
```

This evidence closes only M08's local clock/provenance contract. Authenticated
global clock identity, physical capture truth, cross-network timing,
processor execution beyond the embedded example, device support and final
release qualification remain open.
