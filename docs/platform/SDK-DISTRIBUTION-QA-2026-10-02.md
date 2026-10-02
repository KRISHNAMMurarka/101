# General SDK local distributions, 2 October 2026

Base `5bb84e6`; build/QA implementation is the containing commit. The selected
immutable SDK producer is `5bb84e6ce691845d2ac85aac092dd06ed7a9ae57`, tree
`cdad9c73bccaf094cd19fd042447c3a19e47c1b0`. All 37 consumed source hashes match
the containing candidate. The manifest separately binds the exact build tool;
the consumer receipt binds its QA tool. This is partial K01/K02/K10/K11/K12 and
L01/L02/L03 evidence for the current five-package API, with no master checklist
or support acceptance promoted.

The baseline packed the actual TypeScript workspace packages and installed all
five offline outside this repository. Ordinary Node with type stripping disabled
then failed `ERR_UNKNOWN_FILE_EXTENSION` on installed `connect/src/index.ts`.
That RED demonstrates the producer problem rather than a fabricated tarball.
The build contract also observed the absent packer before its implementation.

The new packer uses an explicitly selected immutable Git revision/tree, archives
only the five package directories and public license/schema/examples, and
compiles with installed TypeScript. It checks exact dependency versions and
compiler source scope. The generated schema asset must match the actual compiled
model producer. Each fresh output has compiled ESM and declaration roots,
explicit schema/example subpaths, MIT license and public readme. Bare package
imports retain one installed module identity; workspace `.ts` exports are
preserved for existing app/native/test tools. Private source/test/receipt files,
install scripts and undeclared dependencies are absent from the tarballs.

| Check | Result and boundary |
| --- | --- |
| Actual packed inventory | Five versioned `0.1.0` tarballs, 81 members; sizes/hashes/individual file inventory retained |
| External install | Offline npm in a fresh `/tmp` directory; exactly five packages, 82 installed files including lockfile, no workspace links, aliases or symlinks |
| Declaration consumers | TypeScript `5.9.3`, strict NodeNext and Bundler resolution, `skipLibCheck: false`, no paths or consumer-linked compiler; `ES2022`, `DOM`, `DOM.Iterable` libraries |
| Ordinary Node | Node `24.14.0`, type stripping disabled; compiled pointer/threshold/temperature-feedback examples, schema exports, module identity, WebCrypto sign/verify, invitation expiry, private-subpath rejection and facade acceptance of direct-package transport pass |
| Actual browsers | Chromium `149.0.7827.55`, Firefox `151.0`, WebKit `26.5`; packed ESM via owned loopback-only import-map server; embedded examples, module identity, schema assets, WebCrypto, invitation expiry and real IndexedDB create/sign/remove lifecycle pass |
| Byte reproducibility | Two new builds from one immutable source produce identical tarball hashes; test verifies staged producer tree and current consumed source hashes |
| Independent risk review | 81 actual tar members, 37 immutable source hashes, builder identity and 103 static import targets inspected; no dependency/import/byte/runtime failure found; declaration-library qualification corrected |
| DOM declaration requirement | Actual external NodeNext consumer with only `ES2022`, no ambient types and strict declarations fails with 22 TS2304 diagnostics; public facade readmes and SDK guide explicitly require DOM libraries |
| Cleanup | Builder removes only its owned snapshot and failed output; contract test removes its owned temporary artifact directories; final tarballs retained. Browser server closes on every result |

The independent review inspected the initial manifest
`2baae542cf8b561f1ab3b33cc59e74161905bcec139eef87d64d0ad8d9c621df`.
Only public readme qualification changed the packaged payload afterward; the
final consumer verifies the corrected artifact set and its exact installed
bytes. Earlier manifest/consumer records remain alongside the final records with
`before-readme-repair` names. The DOM-library failure is a documented unsupported
configuration, not a new runtime bug or a passed server-only type qualification.

Declared Node `>=22.13.0` minimum is unverified on this host; other TypeScript/OS
versions, CommonJS, physical/WebRTC transport, actual native bridges, native-
language distributions, complete future APIs and upgrade/rollback acceptance
remain open. The three browser passes exercise the packed embedded/API subset;
they do not supersede earlier Firefox raw-channel and WebKit ICE failures. No
registry, app-store or service publication occurred. Tarballs are local dry runs,
not an accepted full release or a public package support promise.

## Retained artifacts and reproduction

- [Final artifact manifest](receipts/2026-10-02-sdk-distribution-manifest.json)
  retains source/tree/toolchain/build-tool binding, tarball paths, sizes/hashes
  and closed file inventories. The actual tarballs are in the recorded ignored
  `release/sdk-3PMz0F/tarballs` directory on this host.
- [Final external consumer](receipts/2026-10-02-sdk-consumer.json),
  [redacted commands](receipts/2026-10-02-sdk-consumer-commands.json) and stdout/
  stderr files alongside them. The compiler is called by its absolute installed
  executable; it is not linked into the consumer dependency graph.
- [Actual workspace baseline RED](receipts/2026-10-02-sdk-consumer-baseline-red.json)
  and [baseline commands](receipts/2026-10-02-sdk-consumer-baseline-commands.json).
- [DOM-only-library qualification failure](receipts/2026-10-02-sdk-dom-library-qualification.log)
  and pack contract RED/GREEN logs alongside these receipts.
- [Plan](../superpowers/plans/2026-10-02-sdk-distributions.md) and
  `sdk-distributions-2026-10-02` in [task evidence](task-evidence.json).

```sh
npm run build:sdk -- HEAD
# Use the concrete manifest.json path printed by the packer.
node tools/qa-sdk-consumer.mjs /absolute/path/to/release/sdk-unique/manifest.json
# The integration test builds the staged immutable tree and checks current input hashes.
node --experimental-strip-types --test tests/sdk-distribution.test.ts
npx tsc --noEmit
npm run lint
npm run test:unit
npm run build
node --test tests/rendered-html.test.mjs
```

Builds reuse installed TypeScript `5.9.3`, Node `24.14.0` and npm `11.9.0`.
Browser checks reuse Playwright `1.61.1`. Package output is ESM only, with defined
public imports; source examples require a TypeScript compile before execution.
The final broad gates apply to the exact containing candidate and fresh local
application build; they are distinct from the source-bound SDK producer receipt.
