# Spatial signal contract, 2 October 2026

M02 adds typed quaternions, poses, joint hierarchies, transforms and metric
reference frames to the local SDK. A capability must declare schema version 2
to use a spatial type, including one nested in a record or array. Descriptor
schema 1 and the previous primitive/structured signal contracts remain valid.
Frame ID, origin, unit, signed axes and handedness are validated together and
participate in exact route compatibility. The editor schema is regenerated;
runtime-only annotations identify quaternion norm, handedness, hierarchy,
cross-field and bounded JSON rules.

Spatial values are strict inert immutable snapshots. Quaternion squared norm
may differ from one by at most 0.002; serialized input is not silently
normalized. Position and translation ranges, closed component fields, joint
name/parent graph, optional members and transform parity are checked before
effect. New spatial values negotiate the existing `json/2` structured lane,
with separate 4 KiB wire and runtime envelope limits. The ordinary `json/1`
and compact pointer formats retain their prior meaning.

`createSpatialPoseConverter()` requires source/target pose schemas and an
explicit decimal precision and absolute position-error budget. A shared
origin permits signed axis and metric mapping. Different origins require an
explicit matching transform; the SDK checks its structure and numeric bounds,
while the application remains responsible for physical calibration. The
signed permutation maps position, and its determinant maps quaternion axial
terms. A supplied target-space rotation composes on the left, followed by
target-space translation for position. Rotation arithmetic divides by the
admitted quaternion norm, preventing unintended scale; computed composition
is returned as a valid unit quaternion. Converter construction projects the
entire declared source box through the mapping against the strict target
extent. Routing never inserts a converter automatically.

The [embedded example](../../examples/device-pipelines/spatial-joints.ts)
validates a simulated watch-style wrist/index hierarchy in a right-handed
metre frame, converts each pose into a left-handed centimetre display frame,
then publishes through a concrete authorized source and sink. Observation
provenance identifies the simulated source frame and conversion. Stop clears
owned state. This is a deterministic software fixture: no physical watch,
sensor calibration, native OS operation or release support row is qualified.

## Verification

- Focused RED regressions covered missing spatial exports, schema/codec types,
  the missing example, v1 compatibility admission, canonical quaternion field
  order, strict extent admission, near-unit composition, and a depth-four
  nested spatial schema that the generic JSON snapshot had rejected. The
  corresponding parser, converter, binding and example tests passed after
  implementation. An independent read-only review contributed the nesting
  case; a predecessor reference probe contributed the extent/composition
  boundary fixtures. All 48 signed axis permutations passed a separate
  vector-rotation oracle in the model test.
- [SDK build receipt](receipts/2026-10-02-spatial-sdk-build.json) and
  [external consumer receipt](receipts/2026-10-02-spatial-sdk-consumer.json)
  identify immutable source and tool hashes. Five tarballs contain 41 hashed
  source files and 91 packed members; the clean install audits 92 files
  including its lockfile, with no undeclared dependency or symlink. The
  installed five-package
  consumer compiles NodeNext and Bundler declarations with `skipLibCheck:false`,
  executes ordinary Node with type stripping disabled, and runs the packed API
  example in Chromium 149.0.7827.55, Firefox 151.0 and WebKit 26.5. These are API/runtime checks; they
  do not exercise physical WebRTC, watch hardware or calibration.
- Exact candidate gates are TypeScript, lint, unit tests, a fresh build and
  rendered HTML tests. The containing commit records their final counts and
  log hashes. `node tools/audit-platform-records.mjs` checks the ledger after
  this record is added. All support rows remain `accepted:false`.

The accepted local artifact is `release/sdk-6XoKue`, built from producer tree
`076af025ce1e67fb4b3794223141244bbd83f84c`. Manifest SHA-256:
`06f36897fcd876b26d8c8e5af397e458c5f9d8ffb10f1ac66c32c5c7228e15c4`.
Builder SHA-256: `cbeaffef30059dfb7fd2bfb24e24d1c45dc9db2a08a275cf3a54ac15e2f12fe2`;
external QA tool SHA-256: `efe7e4f9c011d01c39735da00c7e48525edf6b044502e8ee97438b2f66ffb060`.
The producer tree has no unique commit, so the builder records `revision:null`
and emits a caught commit-lookup diagnostic while exiting zero. An earlier
`release/sdk-dWZdnE` predates the final schema-depth fix and is superseded;
both artifacts are ignored local files and unpublished.

Environment: macOS 26.5.2 arm64, Node 24.14.0, npm 11.9.0,
TypeScript 5.9.3 and Playwright 1.61.1. Node 22.13 and other operating systems
remain unqualified.

Reproduce the local software checks:

```sh
node --experimental-strip-types --test packages/device-model/src/spatial.test.ts packages/device-web/src/structured-binding.test.ts tests/spatial-pipeline.test.ts tests/device-platform-boundary.test.ts
npm run example:devices
npm run schemas:devices
node tools/build-sdk.mjs 076af025ce1e67fb4b3794223141244bbd83f84c
node tools/qa-sdk-consumer.mjs release/sdk-6XoKue/manifest.json
node tools/audit-platform-records.mjs
```
