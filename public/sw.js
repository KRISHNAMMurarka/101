const CACHE_VERSION = "101-link-v1";
const CONTROLLER_SHELL = "/controller?session=101LAB";
const PRECACHE = [CONTROLLER_SHELL, "/link.webmanifest", "/icons/101-link.svg"];

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

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request, url));
    return;
  }

  event.respondWith(cacheFirst(request));
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
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE_VERSION);
    await cache.put(request, response.clone());
  }
  return response;
}
