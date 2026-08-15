# The offline cache

101 Link is installable, so the browser controller keeps working when the host is briefly
unreachable. That is a real feature and also the easiest way to ship software nobody can update.

## The bug this replaced

```js
const CACHE_VERSION = "101-link-v1";   // no build step ever rewrote this
```

`activate` deletes every `101-link-` cache that is not `CACHE_VERSION`. Comparing a constant to
itself deletes nothing, so the cache created on a user's first visit survived every later release —
forever, by construction.

That was compounded by a blanket cache-first strategy which stored **any** same-origin GET and never
revalidated:

```js
const cached = await caches.match(request);
if (cached) return cached;   // and that is the end of it
```

For the bundler's content-hashed output that is harmless: the filename changes when the bytes do, so
a pinned copy is simply never requested again. The damage is in the 15 files that are *not* hashed.
`vinext-client-entry-manifest.json` and `.vite/manifest.json` map logical entries to hashed chunk
names, so a pinned manifest points at chunks that no longer exist and the app **fails to boot** after
an update rather than merely looking stale. The MediaPipe wasm and the pose/hand models are pinned
the same way.

## What it does now

| Request | Strategy | Why |
| --- | --- | --- |
| `?pair=…` | network only, never stored | the URL carries a temporary join secret |
| `/v1/…` | not intercepted | Hub signalling is never cached |
| `/sw.js`, `*manifest.json` | network only | a stale manifest names chunks that are gone |
| `/_next/static/…` | cache first | content-hashed: the name changes with the bytes |
| everything else | stale-while-revalidate | instant offline, and an update still lands |
| navigation | network first, `/controller` shell cached | offline fallback for the installed controller |

The cache name is `101-link-${BUILD_ID}`, and `BUILD_ID` is stamped into `dist/client/sw.js` after
every build by `tools/stamp-service-worker.mjs`, from a hash of the built client. A version derived
from the build is the only one nobody can forget to bump. `public/sw.js` keeps the `__BUILD_ID__`
placeholder; the stamper exits non-zero if it is missing, so an unstamped worker fails the build
instead of silently shipping one shared cache again.

## This build is not byte-reproducible

Worth knowing, because it is why the id changes on every release:

```
build 1: _next/static/chunks/BeatForgeGame-COqKi4BL.js
build 2: _next/static/chunks/BeatForgeGame-Dzfd_Vkr.js
```

Same source, same machine, different chunk names. The cause is a cyclic content hash, traced to the
byte:

- `index-*.js` embeds `__vite__mapDeps`, a literal array of 49 chunk **filenames**.
- Those chunks import `index-*.js` back.

So each chunk's hash depends on the other's, and a build settles on whichever fixed point it reaches
first. 24 of 59 chunks churn; the 35 outside the cycle are byte-identical every time, and the
churning ones differ *only* in the import specifiers they name — same length, same content
otherwise. The bundler also emits a fresh UUID directory of build manifests per run.

This is inside rolldown/Vite's chunking, not something application code can pin, so it is recorded
rather than worked around.

While that holds, evicting on every release is the correct outcome rather than a wasteful one: if
every chunk name changed, every cached chunk is already unreachable. The stamper excludes the
per-build manifest directories so the id will track real change if the build ever becomes
reproducible — which is worth doing on its own, since an unreproducible build cannot be verified
against its source.

## A correction

An earlier note in this repository suspected this cache of serving stale JavaScript during
development — instrumentation that had been deleted still appeared to run after a rebuild. That was
never confirmed and the service worker is not the cause: registration is refused outside a secure
context in the harness used to test it, so no worker was ever active during those runs. The cache
bug documented above is real and was found by reading the file, not by reproducing that symptom. The
original symptom remains unexplained; the likeliest candidate is ordinary HTTP caching or a stale
`vinext start` still holding the previous build's manifest, which has been observed here separately.
