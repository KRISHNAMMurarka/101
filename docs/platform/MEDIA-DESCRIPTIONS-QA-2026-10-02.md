# Media and render-surface description contract, 2 October 2026

M05 adds a separate version 1 `MediaManifest` for bounded audio/video capture
and output track descriptions, exact codec tokens, audio sample-rate/channel
ranges, video pixel/frame-rate ranges and video render-target geometry. It does
not change descriptor schema 1, signal values or the 4 KiB wire packets.
Parsed descriptions are closed, deeply frozen data. Static `ready`, `working`
and permission claims are rejected; a codec token does not establish actual
OS or browser codec availability.

`planMediaBinding()` requires a host probe naming the exact selected manifest
resource IDs and two concrete registrations. The whole probe is copied as
closed inert data before endpoints are read; an accessor cannot execute. Both
endpoints must report availability and exact codec support. Current
audio properties or video geometry must fit the declared ranges and match the
output without silent mixing, transcoding or scaling. Its result is an inert
binding proposal, never a started route or observed frame. Missing, denied,
busy or incompatible resources cannot produce a proposal. The
[simulated first caller](../../examples/device-pipelines/media-description.ts)
proposes video-to-canvas use and demonstrates unavailable microphone and
codec failures. It starts no capture or output.

## Verification

- Focused RED tests first observed missing media model exports and the first
  caller. Independent review found that a camera B probe could authorize a
  camera A proposal and that a host-wrapper getter could execute before
  validation. Each regression failed on the previous implementation; resource
  identity binding and a whole-wrapper inert snapshot fixed both. Other tests
  cover closed fields, duplicate IDs/codecs, contradictory ranges, static
  readiness rejection, exact audio output properties, video geometry,
  unavailable probes and codec mismatch.
- [SDK build receipt](receipts/2026-10-02-media-description-sdk-build.json),
  [external consumer receipt](receipts/2026-10-02-media-description-sdk-consumer.json)
  and [command receipt](receipts/2026-10-02-media-description-sdk-consumer-commands.json)
  identify immutable source and tool hashes. A clean five-package install
  audits 107 files with no symlinks or undeclared dependencies, checks strict
  NodeNext and Bundler declarations with `skipLibCheck:false`, ordinary Node
  without type stripping, and packed examples in Chromium, Firefox and WebKit.
  The example constructs simulated probe data; green results prove proposal
  logic and packaging only, not provider readiness or a working media route.
- Exact candidate gates are TypeScript, lint, unit tests, a fresh build and
  rendered HTML tests. The containing commit records final counts and log
  hashes. `node tools/audit-platform-records.mjs` checks the ledger. All
  support rows remain `accepted:false`.

This evidence closes only the M05 description contract. Physical camera,
microphone, speaker and display behavior, permission prompts, actual media
tracks, capture/transport/rendering, codecs on specific devices and release
support remain open under their own checklist rows.

The accepted local artifact is `release/sdk-LeM7RM`, built from immutable
producer tree `f404fda32ae2a9630ce2818dfa817d6814f2c805`. Earlier
`release/sdk-UAaTS4` predates the two review fixes and is superseded. Both
artifacts are ignored local files and unpublished. The producer tree has no
unique commit, so the builder records `revision:null` and emits a caught
commit-lookup diagnostic while exiting zero. Manifest SHA-256:
`b5602ae1b4b48507e690d4e1742fc2eb49732acad57edef5c068857baf6f65d2`.
Builder SHA-256: `7e91360653dfbc1cd0c872eb7759d2a6a46cc2e1e5095cb0aff4079d4e0fd966`;
external QA tool SHA-256: `74140e166d786da5f48c74bcadc7e9b07497a6b523d0baa01913eb973a9404f0`.
Installed browser versions: Chromium 149.0.7827.55, Firefox 151.0 and WebKit
26.5. Environment: macOS 26.5.2 arm64, Node 24.14.0, npm 11.9.0,
TypeScript 5.9.3 and Playwright 1.61.1.

Reproduce the local software checks:

```sh
node --experimental-strip-types --test packages/device-model/src/media.test.ts tests/media-description-pipeline.test.ts
npm run example:devices
node tools/build-sdk.mjs f404fda32ae2a9630ce2818dfa817d6814f2c805
node tools/qa-sdk-consumer.mjs release/sdk-LeM7RM/manifest.json
node tools/audit-platform-records.mjs
```
