# Binary and document resource contract, 2 October 2026

M04 adds an installable local resource path separate from the 4 KiB signal
packets. An inert `AssetReference` binds a namespaced ID, kind, exact media
type, byte length and SHA-256. The initial kinds are opaque blob
(`application/octet-stream`, at most 8 MiB), UTF-8 text
(`text/plain;charset=utf-8`, at most 64 KiB), and JSON document
(`application/json`, at most 64 KiB). The latter must parse as a bounded
inert object or array. A reference is not a URL, permission, filesystem
handle or content decoder for other formats.

`chunkResource()` snapshots caller bytes and emits ordered chunks of at most
16 KiB; no resource may require more than 512 chunks. The copy uses intrinsic
typed-array storage, so an overridden iterator cannot change the checked
byte count. `readVerifiedResource()` requires an explicit principal,
application and session, a per-read host grant with expiry and byte ceiling,
an `AbortSignal`, and a caller-owned chunk source. It rejects duplicate,
reordered, malformed, oversized, truncated and trailing chunks. Complete
length, SHA-256 and declared content are checked before a fresh byte copy is
returned. Aborted or expired reads expose no partial bytes; a stalled source
is interrupted by abort or grant expiry. The reader returns verified bytes,
not evidence that any downstream effect occurred.

The [embedded example](../../examples/device-pipelines/resource-documents.ts)
reads simulated text and JSON documents through `@101/connect`, separately
authorizing each exact resource identity. It demonstrates denial, changed
bytes and cancellation. No URL, file chooser, native source, remote resource
transport, physical device or support row is qualified by this fixture.

## Verification

- Focused RED tests first observed missing resource API exports and example.
  Independent read-only review found two lifecycle/bounds defects. Regressions
  demonstrated that `Uint8Array.from()` could follow an overridden iterator,
  changing one checked byte into two, and that a stalled read's expiry timer
  counted authorization time twice. Intrinsic storage copying and a fresh
  post-authorization timer fixed both. Further tests cover content/type
  mismatch, denial before source iteration, prompt abort, bounded chunk
  count/order/trailing data and grant expiry during a partial read.
- [SDK build receipt](receipts/2026-10-02-binary-resource-sdk-build.json),
  [external consumer receipt](receipts/2026-10-02-binary-resource-sdk-consumer.json)
  and [command receipt](receipts/2026-10-02-binary-resource-sdk-consumer-commands.json)
  identify immutable source and tool hashes. The clean five-package consumer
  audits 102 installed files, with no symlinks or undeclared dependencies, and
  checks strict NodeNext and Bundler declarations with `skipLibCheck:false`,
  ordinary Node with type stripping disabled, and the packed example in
  Chromium, Firefox and WebKit. These are local API/runtime checks.
- Exact candidate gates are TypeScript, lint, unit tests, a fresh build and
  rendered HTML tests. The containing commit records final counts and log
  hashes. `node tools/audit-platform-records.mjs` checks the ledger after
  this record is added. All support rows remain `accepted:false`.

The accepted local artifact is `release/sdk-LNbmEe`, built from immutable
producer tree `521cf5260e88d89d6d41ae88503e11bfa0e8a689`. An earlier
`release/sdk-gW2Deg` predates the two review fixes and is superseded; both
artifacts are ignored local files and unpublished. The producer tree has no
unique commit, so the builder records `revision:null` and emits a caught
commit-lookup diagnostic while exiting zero.
Manifest SHA-256: `29655994cf00ca38b807fd3b9b66ad015f1c249989bf6ae6a8672a9b3689985f`.
Builder SHA-256: `002d33467e5403bc70288c982cf8534ce6764c0dc862893fed378c77bb4f20b8`;
external QA tool SHA-256: `f6f8eb46a7b3803a4a70ea408717962db3df7e9261a3b0a66136385ada054da3`.
The installed browser versions were Chromium 149.0.7827.55, Firefox 151.0
and WebKit 26.5.

Environment: macOS 26.5.2 arm64, Node 24.14.0, npm 11.9.0,
TypeScript 5.9.3 and Playwright 1.61.1. Node 22.13 and other operating
systems remain unqualified.

Reproduce the local software checks:

```sh
node --experimental-strip-types --test packages/device-model/src/resource.test.ts packages/device-runtime/src/resource.test.ts tests/resource-documents-pipeline.test.ts
npm run example:devices
node tools/build-sdk.mjs 521cf5260e88d89d6d41ae88503e11bfa0e8a689
node tools/qa-sdk-consumer.mjs release/sdk-LNbmEe/manifest.json
node tools/audit-platform-records.mjs
```
