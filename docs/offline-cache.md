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

## The build is reproducible, and that took finding one UUID

For a while it was not, and the cache id changed on every release as a result. Two builds of
identical source emitted different chunk filenames — 24 of 59 churned. The trail:

1. `index-*.js` embeds `__vite__mapDeps`, an array of 49 chunk filenames, and those chunks import it
   back. That looked like a cyclic content hash with no stable fixed point. **It was not the cause** —
   disabling `build.modulePreload` removed `__vite__mapDeps` entirely and all 24 still churned.
2. Normalising every `name-hash.js` specifier to `name.js` before comparing separated chunks that
   really changed from chunks that only *named* a changed chunk. Exactly **one** was a real change:
   `app-rsc-cache-busting`.
3. Its single differing token:

```js
build 1:  function w(){ return C(`e8a50267-745d-4e15-869d-29395e600f62`) }
build 2:  function w(){ return C(`97d6651a-273b-4c29-b582-4bf7ed1df160`) }
```

That is `getVinextRscCompatibilityId()`. From vinext's own source:

```js
function createRscCompatibilityId(nextConfig) {
  if (nextConfig.deploymentId) return nextConfig.deploymentId;
  return randomUUID();
}
```

One random string, baked into one chunk, cascading to 22 more through their import specifiers.
`generateBuildId` defaults the same way, which is where the per-build UUID directory came from.

Both are now derived from a hash of the source tree (`tools/source-id.mjs`), which keeps precisely
the property they exist for. The RSC compatibility id must differ when the deployed app differs, so a
browser holding an old client rejects a mismatched payload and hard-navigates. A source hash does
that faithfully; a fresh UUID did it only by accident, and also differed when nothing had changed.

Verified: two consecutive builds are byte-for-byte identical, the service worker cache id is stable
across them, and a one-line source edit still changes it. A release that changes nothing no longer
evicts every user's cache; a release that changes something still does.

## A correction

An earlier note in this repository suspected this cache of serving stale JavaScript during
development — instrumentation that had been deleted still appeared to run after a rebuild. That was
never confirmed and the service worker is not the cause: registration is refused outside a secure
context in the harness used to test it, so no worker was ever active during those runs. The cache
bug documented above is real and was found by reading the file, not by reproducing that symptom. The
original symptom remains unexplained; the likeliest candidate is ordinary HTTP caching or a stale
`vinext start` still holding the previous build's manifest, which has been observed here separately.
