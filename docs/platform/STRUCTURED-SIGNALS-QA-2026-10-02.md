# Structured signals, 2 October 2026

M01 is implemented in the containing commit, based on
`eadbeb88f1c3388fdd5313db7080221dd967e55b`. Bounded records, arrays, optional
members and timestamped batches have an authorized consumer, explicit version
migration and malformed/oversized regressions. Only M01 is promoted. Spatial,
rich input, general clock/provenance, extensions, native/physical qualification
and full release acceptance remain open.

Records declare 1–32 safe named fields; undeclared or missing required members
fail. Arrays declare integer bounds from zero to 128. Recursive schemas have at
most four nodes on a path and 256 total occurrences. The existing 64 KiB inert
JSON, depth and container limits remain. Value inputs are copied once, then
recursively validated and deep frozen. Optionality, item schemas and bounds
participate in exact semantic/capability-version compatibility; field and
optional-list ordering carry no meaning.

Structured samples and events negotiate `json/2` with connect version 2 value
envelopes. Controls and descriptions retain version 1. Primitive-only callers
retain `json/1` and applicable compact-pointer contracts. Codec lists derive
from actual capability schemas; every sample and event must match its slot's
negotiated codec. Unknown scope fields, old versions, wrong epochs/slots,
malformed members and replay do not acquire a route. Compact pointer encoding
requires exactly scalar x/y and cannot drop extra fields. Existing vector
snapshots retain input key order; the legacy wire encoder still canonicalizes
components, preserving its bytes.

The [telemetry consumer](../../examples/device-pipelines/telemetry-batch.ts)
publishes 1–16 records of timestamp/resident bytes through concrete authorized
registrations, computes the last reading and releases its owned state. Version
2 adds optional quality. Its explicit v1→v2 adapter validates both contracts
and labels migrated readings `unverified`; incompatible capabilities cannot
route silently. Inner timestamps stay in the application's source clock domain;
the remote bridge translates only the outer observation. Fixture tests and the
portable runner use labeled deterministic readings. The clean installed Node
consumer separately publishes actual `process.memoryUsage().rss` and
`performance.now()` readings and checks sink meaning and stop cleanup.

Wire values and full runtime observation/options envelopes each retain their
independent 4 KiB limit. Wire overflow fails before queueing or advancing sender
IDs. The independent reviewer reproduced a 3941-byte wire batch becoming a
4352-byte runtime envelope after provenance/options. Runtime correctly rejected
it, but the initial bridge removed its slot. The retained RED demonstrates that
recovery failure. The narrow fix reports `payload-limit`, preserves the current
grant, and returns before received sequence/operation/freshness advancement.
Both latest and reliable regressions recover with a smaller batch; repeated
rejected data cannot delay expiry or duplicate release. Sender success remains
transport handoff, not host admission or physical effect.

| Evidence | Result |
| --- | --- |
| [Model RED](receipts/2026-10-02-structured-model-red.log), [model GREEN](receipts/2026-10-02-structured-model-green.log) | Old parser rejects the first array-of-record caller; 39 focused model/clock checks pass after implementation |
| [Wire RED](receipts/2026-10-02-structured-wire-red.log), [wire GREEN](receipts/2026-10-02-structured-wire-green.log) | Old codec rejects `json/2`; 13 old/new wire checks pass |
| [Publisher budget RED](receipts/2026-10-02-structured-publisher-budget-red.log) | Initial implementation retained an oversized pending sample; preflight now rejects before queueing or consuming sequence |
| [Runtime recovery RED](receipts/2026-10-02-structured-runtime-budget-red.log), [review reproducer result](receipts/2026-10-02-structured-review-budget-before-recovery.log) | Wire-valid runtime rejection retired the grant, blocking smaller data; no rejected value was delivered |
| [Affected integration GREEN](receipts/2026-10-02-structured-recovery-integration-green.log) | 132 model, clock, runtime, wire, binding, authenticated facade, telemetry and application-pointer checks pass, including both delivery modes and deadman recovery |
| [Read-only review](receipts/2026-10-02-structured-review.json) | 23 focused checks plus reliable version probe; no reproduced authority/parser/replay/cleanup blocker. Follow-up inspected the narrow recovery delta and RED/GREEN with exact final source hashes |
| [Initial types failure](receipts/2026-10-02-structured-types-initial-failure.log) | Recursive union required explicit vector narrowing. Root TypeScript also included retained old release examples against the new workspace model; `release/` now excluded from source checking. Artifacts are checked separately through installed declarations |
| [SDK manifest](receipts/2026-10-02-structured-sdk-manifest.json), [clean consumer](receipts/2026-10-02-structured-sdk-consumer.json), [commands](receipts/2026-10-02-structured-sdk-consumer-commands.json) | Five compiled packages, 38 producer hashes, 84 tar members; offline install checks 85 files including its lockfile, no symlinks or aliases. Strict NodeNext/Bundler with `skipLibCheck:false`, ordinary Node with type stripping disabled, actual Node memory batch, schema assets, module identity and blocked private imports all pass |
| Installed browser APIs | Chromium 149.0.7827.55, Firefox 151.0 and WebKit 26.5 pass the packed structured fixture/migration, existing examples, WebCrypto and IndexedDB lifecycle checks. These are actual browser API checks; physical WebRTC is explicitly not exercised |

The accepted local artifact is `release/sdk-dDpS8M`, built from immutable tree
`379327ff0dc115d03c12b71407518af15b16600e`. Manifest SHA-256 is
`f85ee1d96d67899f05e387a28709146ba37f55b9e105e2edc569a0633bb6e37c`.
The manifest binds every source, tool, tarball and member hash. Qualification
documents added afterward do not change those producer/tool bytes; the final
unit gate repacks its staged candidate twice, requires working source/hash
agreement and identical tarballs. Preliminary `release/sdk-Ud53mh` predates the
recovery fix and is not this acceptance artifact. The builder's caught
tree-to-commit probe prints a diagnostic to the [retained stderr](receipts/2026-10-02-structured-sdk-build-stderr.log);
the build completes with `revision:null`, exact tree identity and exit zero.

Environment: macOS 26.5.2 arm64, Node 24.14.0, npm 11.9.0, TypeScript 5.9.3,
Playwright 1.61.1. DOM/DOM.Iterable libraries remain required for public facade
declarations. Node's declared minimum and other compiler/OS versions are not
newly qualified. Wire integration uses an explicit diagnostic delivery-port
fixture; it establishes no DTLS, native bridge or physical device claim. All
support rows remain unaccepted. No publication or external service was added.

```sh
node --experimental-strip-types --test packages/device-model/src/*.test.ts \
  packages/device-web/src/wire.test.ts packages/device-web/src/structured-wire.test.ts \
  packages/device-web/src/binding.test.ts packages/device-web/src/structured-binding.test.ts \
  packages/device-web/src/authenticated-peer.test.ts packages/device-runtime/src/*.test.ts \
  tests/telemetry-batch.test.ts tests/game-pointer-bridge.test.ts
node tools/build-sdk.mjs 379327ff0dc115d03c12b71407518af15b16600e
node tools/qa-sdk-consumer.mjs release/sdk-dDpS8M/manifest.json
npm run example:devices
node tools/audit-platform-records.mjs
```

The [spec](../superpowers/specs/2026-10-02-structured-signals.md),
[plan](../superpowers/plans/2026-10-02-structured-signals.md) and
`structured-signals-2026-10-02` in [task evidence](task-evidence.json) bind this
scope. Exact candidate types, lint, unit, fresh build and rendered gates are
required before the local integration commit.
