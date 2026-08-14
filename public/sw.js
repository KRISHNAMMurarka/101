/**
 * 101 Link offline shell.
 *
 * `BUILD_ID` is rewritten by tools/stamp-service-worker.mjs after every build, from a hash of the
 * built client. That stamp is what makes the cache disposable: `activate` deletes every cache from
 * a different build, so a release cannot inherit the previous one.
 *
 * It used to be the literal "v1", which no build step ever changed, so `activate` compared the
 * constant to itself and deleted nothing — the cache from a user's first visit survived every
 * subsequent release. Combined with a blanket cache-first that stored *any* same-origin GET, an
 * installed controller could keep serving arbitrarily old files. The worst case was not merely
 * stale UI: `vinext-client-entry-manifest.json` and `.vite/manifest.json` are unversioned, so a
 * pinned copy pointed at content-hashed chunks that no longer existed and the app failed to boot
 * after an update.
 */
const BUILD_ID = "__BUILD_ID__";
const CACHE_VERSION = `101-link-${BUILD_ID}`;
const CONTROLLER_SHELL = "/controller?session=101LAB";
const PRECACHE = [CONTROLLER_SHELL, "/link.webmanifest", "/icons/101-link.svg"];

/** Content-hashed by the bundler: the filename changes when the bytes do, so pinning is safe. */
const IMMUTABLE = /^\/_next\/static\//;

/**
 * Build manifests map logical entries to hashed filenames. Serving a stale one hands the app a list
 * of chunks that no longer exist, so these are never cached at any age.
 */
const NEVER_CACHE = /(^\/sw\.js$)|(manifest\.json$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("101-link-") && key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/v1/")) return;
  if (url.searchParams.has("pair")) {
    event.respondWith(fetch(request));
    return;
  }
  if (NEVER_CACHE.test(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request, url));
    return;
  }

  // Only content-hashed files may be answered from cache without checking the network. Everything
  // else is served fast and refreshed behind the player, so an update lands on the next launch
  // instead of never.
  event.respondWith(IMMUTABLE.test(url.pathname) ? cacheFirst(request) : staleWhileRevalidate(request));
});

async function navigationResponse(request, url) {
  try {
    const response = await fetch(request);
    // Pairing URLs contain a temporary join secret. Never persist that URL or response.
    if (!url.searchParams.has("pair") && url.pathname === "/controller" && response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(CONTROLLER_SHELL, response.clone());
    }
    return response;
  } catch {
    if (url.pathname === "/controller") {
      const cached = await caches.match(CONTROLLER_SHELL, { ignoreSearch: true });
      if (cached) return cached;
    }
    return new Response("101 Link is offline. Reopen the installed controller when the host is reachable.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  await store(request, response);
  return response;
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (response) => {
      await store(request, response);
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    // Answer instantly and refresh behind the player; a controller on a slow LAN must not wait.
    void network;
    return cached;
  }
  const response = await network;
  if (response) return response;
  return new Response("101 Link could not reach the host for this asset.", {
    status: 504,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function store(request, response) {
  if (!response || !response.ok || response.type !== "basic") return;
  const cache = await caches.open(CACHE_VERSION);
  await cache.put(request, response.clone());
}
