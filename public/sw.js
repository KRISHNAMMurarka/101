/**
 * 101 Link caches one complete controller build before installing an update. The browser keeps
 * that update waiting until clients of the previous worker close; it never replaces their code.
 * The shell is rendered from the same build as its stamped dependency list, not fetched from a
 * moving /controller endpoint during installation.
 */
const BUILD_ID = "__BUILD_ID__";
const CACHE_VERSION = `101-link-${BUILD_ID}`;
const CONTROLLER_SHELL = "/controller?session=101LAB";
const OFFLINE_SHELL = "__CONTROLLER_SHELL__";
const PRECACHE = /* __PRECACHE__ */ [];

/** Content-hashed by the bundler: the filename changes when the bytes do, so pinning is safe. */
const IMMUTABLE = /^\/_next\/static\//;

/**
 * Build manifests map logical entries to hashed filenames. Serving a stale one hands the app a list
 * of chunks that no longer exist, so these are never cached at any age.
 */
const NEVER_CACHE = /(^\/sw\.js$)|(manifest\.json$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(installBuild());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("101-link-") && key !== CACHE_VERSION).map((key) => caches.delete(key)))),
  );
});

async function installBuild() {
  if (!PRECACHE.length || BUILD_ID.startsWith("__")) throw new Error("The controller cache was not stamped by the build");
  const cache = await caches.open(CACHE_VERSION);
  try {
    // addAll commits only once every response succeeds. Reload avoids a stale browser HTTP cache.
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })));
    const shell = await cache.match(OFFLINE_SHELL);
    if (!shell) throw new Error("The matching controller shell is missing");
    await cache.put(CONTROLLER_SHELL, shell);
  } catch (error) {
    await caches.delete(CACHE_VERSION);
    throw error;
  }
}

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
  event.respondWith(IMMUTABLE.test(url.pathname) ? cacheFirst(request) : staleWhileRevalidate(request, event));
});

async function navigationResponse(request, url) {
  try {
    // Never persist that URL or response: an online navigation can already be serving the next
    // release, while this active worker must keep its own complete offline fallback intact.
    return await fetch(request);
  } catch {
    if (url.pathname === "/controller") {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(CONTROLLER_SHELL);
      if (cached) return cached;
    }
    return new Response("101 Link is offline. Reopen the installed controller when the host is reachable.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  await store(request, response);
  return response;
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      await store(request, response);
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    // Answer instantly and refresh behind the player; a controller on a slow LAN must not wait.
    event.waitUntil(network);
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
