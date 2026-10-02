# Rich input event contract, 2 October 2026

M03 adds version 2 contact, pen, key, text/IME, wheel and relative-motion
schemas to the local SDK. Every capability using one of these types, including
within a bounded record or array, must be an event with reliable delivery.
These are closed, bounded, deep-frozen event values carried by `json/2`.
Descriptor schema 1 and existing capability v1 values retain their prior
contract. The editor JSON schema describes the shapes and identifies
version/kind/delivery and cross-field checks as runtime validation.

Contacts and pen values keep down/move/up/cancel edges, normalized position
and stable contact identity. Pen pressure, tilt and twist are bounded. Key
down/up/repeat, physical code, logical label, location, composition state and
modifiers are separate from text insertion. Text keeps start/update/end/commit
phases and a Unicode-code-point bound; `end` never implies `commit`. Wheel
deltas retain pixel/line/page mode, and relative CSS-pixel motion remains a
delta rather than an absolute sample. Malformed fields, unknown fields,
unsupported bounds and incompatible source/sink schemas fail before effect.

The [embedded example](../../examples/device-pipelines/rich-input.ts) uses six
separately authorized source/sink pairs and deterministic DOM-shaped fixtures.
The ordered bounded log demonstrates separate edges and consecutive deltas;
stop releases all six sinks. The example has a ten-second route lease under
a sixty-second example grant. Continuing callers renew before lease expiry
and call `flush()`; the runtime has no timer. This is a simulated software
caller, with no claim of actual browser/native input provider availability,
physical keyboard/touch/pen behavior, or support-row qualification.

## Verification

- Focused RED regressions first observed missing rich model exports, the
  `json/2` key event binding, the first caller, event 65 rejected despite no
  pending delivery, and a route expired at 2.5 seconds. The reviewed queue
  fix retires oldest settled, unpinned diagnostic evidence under capacity
  pressure; its monotonic operation-ID watermark still rejects replay.
  Active/pinned work remains capacity bounded. The example now exposes lease
  renewal. Focused model, binding, scheduler and pipeline tests pass.
- The [SDK build receipt](receipts/2026-10-02-rich-input-sdk-build.json) and
  [external consumer receipt](receipts/2026-10-02-rich-input-sdk-consumer.json)
  identify immutable source and tool hashes. Five tarballs install as a closed
  graph with 95 audited files and no symlinks or undeclared dependencies. The
  clean installed consumer checks strict
  NodeNext and Bundler declarations with `skipLibCheck:false`, ordinary Node
  with type stripping disabled, and the packed API example in Chromium,
  Firefox and WebKit. The [command receipt](receipts/2026-10-02-rich-input-sdk-consumer-commands.json)
  records the executed commands. These are local API/runtime checks.
- Exact candidate gates are TypeScript, lint, unit tests, a fresh build and
  rendered HTML tests. The containing commit records final counts and log
  hashes. `node tools/audit-platform-records.mjs` checks the ledger after
  this record is added. All support rows remain `accepted:false`.

The accepted local artifact is `release/sdk-hKSJxr`, built from immutable
producer tree `18ec481f395568690596674a86ec300fc40284c3`. An earlier
`release/sdk-Y7bIVP` predates the queue and lease review fixes and is
superseded; both artifacts are ignored local files and unpublished. The
producer tree has no unique commit, so the builder records `revision:null`
and emits a caught commit-lookup diagnostic while exiting zero.
Manifest SHA-256: `23d8a479ca674552ec92e7e664d777fdfe677326048c12a4b8d3c2612588837f`.
Builder SHA-256: `c812b3a0f83d858c78ba558a8c0118103749cc96fd39c42c0eed7c14a6d2898c`;
external QA tool SHA-256: `2dcd1ce7346ba585d69043c809937b93da5d04faf133e9bb9c74b844575ab9ab`.
The installed browser versions were Chromium 149.0.7827.55, Firefox 151.0
and WebKit 26.5.

Environment: macOS 26.5.2 arm64, Node 24.14.0, npm 11.9.0,
TypeScript 5.9.3 and Playwright 1.61.1. Node 22.13 and other operating
systems remain unqualified.

Reproduce the local software checks:

```sh
node --experimental-strip-types --test packages/device-model/src/rich-input.test.ts packages/device-web/src/structured-binding.test.ts packages/device-runtime/src/scheduler.test.ts tests/rich-input-pipeline.test.ts
npm run example:devices
npm run schemas:devices
node tools/build-sdk.mjs 18ec481f395568690596674a86ec300fc40284c3
node tools/qa-sdk-consumer.mjs release/sdk-hKSJxr/manifest.json
node tools/audit-platform-records.mjs
```
