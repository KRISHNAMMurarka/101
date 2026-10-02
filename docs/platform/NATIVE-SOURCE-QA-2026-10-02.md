# Native module source ownership, 2 October 2026

Base `b67b1dc`. The containing commit adds the existing local watch module
implementation to version control without changing its bytes. The native app's
unanchored `ios/` and `android/` ignore rules excluded module implementation
directories as well as generated Expo app projects. Earlier native builds used
these local files; they did not prove that the committed tree could reproduce
those modules. The watch config plugin does not generate this implementation.

The ignore rules now anchor generated app projects and separately exclude module
build directories. Swift, podspec, Kotlin, Gradle and Wear capability resources
belong to immutable repository source. No credential, signing file or build tree
is added.

`tools/qa-native-module-sources.mjs <revision-or-tree>` archives only committed
native app source into a disposable snapshot, runs the installed Expo resolver
for Apple and Android, and verifies that each declared local module resolves its
declared classes and implementation from that snapshot. Installed dependencies
are reused; this is a source ownership check, not a clean dependency install,
native compilation, physical watch pairing or standalone release acceptance.

The check fails against `b67b1dc`: `one01-watch: apple source is absent`, 0 resolved
modules where 1 is required. The candidate source tree
`4afc16b2f9b4718bd8690466aebb51d66b368037` resolves both platforms and includes all
five native files. Their SHA256 values are in the accompanying
[receipt](receipts/2026-10-02-native-source.json). Node is 24.14.0 and Expo module
autolinking is 57.0.9. The resolver's canonical `/private/var` path is compared
using filesystem realpaths, avoiding macOS `/var` alias mismatches.

Run the check against the exact staged tree with:

```sh
candidate_tree=$(git write-tree)
node tools/qa-native-module-sources.mjs "$candidate_tree"
npm run native:typecheck
npm run native:test
```

The native suite passes 27 tests. Repository commit gates and native typechecking
are recorded in the integration receipt once the candidate freezes. No checklist
row or support level is promoted by this narrower repair. T07's native touch
movement, T08/T14's physical phones and all release/install qualifications remain
open.
