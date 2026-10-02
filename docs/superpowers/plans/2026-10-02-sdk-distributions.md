# Installable general SDK distributions

Base: `5bb84e6`. Owner authorization covers local implementation, dry runs and
inline integration. No registry publication, remote operation or service is part
of this plan. K01/K02/K10/K12 evidence remains bounded to the produced artifacts;
native-language/app releases and wider unfinished SDK APIs remain separate.

## Contract and decisions

Produce versioned local npm tarballs for the five current general packages:
`@101/device-model`, `@101/device-runtime`, `@101/transport-webrtc`,
`@101/device-web` and `@101/connect`. Preserve workspace `.ts` exports so existing
Node strip-types tests and app/native builds keep their established inputs.
Distribution manifests expose compiled ESM JavaScript and declarations, the
descriptor JSON schema through defined subpaths, MIT license and useful public
package documentation. Export no test/source internals. CommonJS, Swift/Kotlin/C,
registry/store publication and a complete future platform are outside this lane.

Use the installed TypeScript compiler and standard npm pack, with no new runtime
dependency. The compiler's `rewriteRelativeImportExtensions` emits `.js` imports
from relative `.ts` source imports; declaration compatibility is verified with
strict external consumers rather than inferred. Bare `@101/*` imports remain
versioned package dependencies so transport class/provenance identity is shared.
See the [official compiler contract](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html#path-rewriting-for-relative-paths).

Build from an explicitly selected immutable Git revision/tree into a newly owned
output directory under ignored `release/`. Archive only the package source,
public schema/license/docs and selected examples; never traverse native build
trees, receipts or arbitrary working files. Do not replace/delete an existing
output. Record selected revision/tree, source hashes, compiler/Node/npm versions,
tarball sizes/hashes and packed file inventory. No publishing lifecycle script is
installed or invoked; npm pack is local with scripts disabled.

Verify outside the repository with installed packed artifacts, offline npm and
no workspace links, path aliases, TS stripping or runtime transpiler. Compile and
run the distributed pointer and temperature/feedback examples; validate schema
subpaths, complete dependency resolution and rejection of private subpaths.
Compile consumer types under NodeNext and browser Bundler resolution with
skipLibCheck disabled. Exercise the packed ESM in actual browser engines using a
local-only server/import map, including WebCrypto and receiver invitation APIs.
Packed import identity must use the same transport module through the public
facade and direct package. Retain limitations of available Node/TypeScript/browser
versions and qualification rather than inferring unrun compatibility.

## Execution

1. Write the smallest runnable distribution/consumer regression, run it on the
   baseline and retain the missing/TypeScript-only distribution RED.
2. Implement a bounded immutable-snapshot compiler/packer with public manifests,
   explicit schema exports and standalone example/documentation assets. Reject
   unsupported package graph/version or out-of-scope compiler inputs.
3. Run the clean offline consumer and artifact-content checks against actual
   tarballs. Resolve real compiler/runtime/pack failures at the narrowest cause.
4. Obtain one independent read-only packaging risk review with exact candidate
   bytes, packed inventory and consumer outputs. Root owns tooling, manifests,
   central evidence and integration; workers may own disjoint consumer QA files.
5. Freeze one candidate; record partial qualification in SDK/evidence docs and
   preserve all failures. Run repository exact commit gates, then commit locally.

Acceptance requires successful install, strict declaration compile and executed
examples from real tarballs outside repository ancestry; schema/assets/license
presence; no workspace/symlink/undeclared dependency; closed packed inventory;
actual browser import/runtime checks; and exact source/artifact hashes. K01/K02
cannot assert completion for unfinished API/platform coverage or unrun minimum
toolchains. K10/K12 receipts cover these tarballs only.

## Integration ledger

Baseline actual packed TypeScript consumer RED retained. Immutable compiler/packer,
closed public tarballs and actual Node/three-browser external consumer pass.
Independent review found the DOM declaration requirement; readmes/guide state it
and the corrected final artifact set passed the external consumer again. Two
fresh builds have identical tarball bytes. Native, minimum toolchain, full API and
upgrade/rollback qualification remain open; final exact candidate gates required.
