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
| navigation | network first, fixed matching `/controller` shell on failure | a newer online page cannot replace an older worker's fallback |

The cache name is `101-link-${BUILD_ID}`, and `BUILD_ID` is stamped into `dist/client/sw.js` after
every build by `tools/stamp-service-worker.mjs`, from a hash of the built client, source worker, and
rendered controller shell. A version derived
from the build is the only one nobody can forget to bump. `public/sw.js` keeps the `__BUILD_ID__`
placeholder; the stamper exits non-zero if it is missing, so an unstamped worker fails the build
instead of silently shipping one shared cache again.

## Installing an update atomically

The stamper invokes the built server's controller route locally, writes the resulting HTML to a
content-addressed `/_next/static/controller-shell-….html` file, and walks the build manifest from
the modules present in that document. It includes their static dependencies, controller/framework
dynamic dependencies, stylesheets, CSS fonts/assets, manifest, and icon. It does not follow the
browser entry's registry of unrelated game and Studio routes. Every selected file must exist in
the built client; missing assets fail the build.

The worker installs this complete list with one `Cache.addAll` batch, then stores the matching
HTML under the offline controller lookup key. A failed fetch or cache write rejects installation
and removes the candidate cache; the previous worker and cache remain available. Fetching the
content-addressed shell avoids mixing an older worker's asset list with HTML from a newer release
that reaches the server during installation.

Updates use the browser's normal waiting lifecycle. There is no forced `skipWaiting` or
`clients.claim`: an update waits until clients controlled by the old worker close. Activation can
then delete the old build's cache. Cache reads stay within the active worker's named cache, so a
waiting update cannot supply a different build's fallback. Online navigation responses are served
but never saved over the fixed offline shell.

The fallback is the default controller page (`session=101LAB`), not a saved private pairing page.
Pairing-secret URLs and signalling always require the network. Offline caching preserves the
controller interface; it does not make an unreachable game host available or install every game.

`tests/service-worker.test.ts` runs the actual worker source in a VM with simulated browser cache,
fetch, and lifecycle events. It exercises v1 → waiting v2 → activated v2 offline shell/JS/CSS,
failed-update preservation, takeover avoidance, online-page isolation, and secret exclusions.
`tests/pwa-contract.test.ts` tests the stamper against a dependency fixture, including fonts,
controller lazy imports, unrelated-game exclusion, missing assets, and stable build IDs. Browser
device lifecycle and offline launch still require browser verification; the VM explicitly models
the point at which the browser permits activation.

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

## Solved: the stale-JavaScript symptom

An earlier note here suspected this cache of serving stale JavaScript during development —
instrumentation that had been deleted still appeared to run after a rebuild. **The service worker was
innocent**, and so was every build artefact. The cause was a port collision:

```
pid 76445  node  [::1]:3000   ~/Desktop/edilec mail  → vinext dev
pid 78096  node  *:3000       ~/Desktop/games/101    → vinext start
```

A different project was serving on IPv6 localhost; 101 binds the IPv4 wildcard. Both bind
successfully — they are different sockets, so there is no `EADDRINUSE` — and macOS resolves
`localhost` to `::1` first. Every `http://localhost:3000` request went to the other application.

Proof, on one build:

| Request | Result |
| --- | --- |
| `http://localhost:3000/sw.js` | **404** — the other project has no such route |
| `http://127.0.0.1:3000/sw.js` | **200**, build `78b48e4971414de9` — exactly what was just built |

Nothing was stale. We were reading a different program, which is why every explanation involving
caches, hashes and manifests failed to fit.

`tools/check-port.mjs` now runs before `dev` and `start` and refuses to launch when anything is
already listening, printing the owning pid and its full command line, plus `PORT=3001 npm start` as
the way through. A check that cannot run — no `lsof`, another platform — never blocks the build.

The general lesson is worth keeping: when a symptom implicates caching, verify *which server
answered* before investigating what it served.
