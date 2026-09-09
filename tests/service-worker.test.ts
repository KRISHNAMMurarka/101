import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const template = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://controller.test";
const SHELL = "/controller?session=101LAB";
const shellFile = (version: string) => `/_next/static/controller-shell-${version}.html`;
const script = (version: string) => `/_next/static/chunks/controller-${version}.js`;
const stylesheet = (version: string) => `/_next/static/css/controller-${version}.css`;
const shell = (version: string) => `<script src="${script(version)}"></script><link href="${stylesheet(version)}">`;

function harness() {
  const stores = new Map<string, Map<string, Response>>();
  let online = true;
  let serving = "v1";
  let failedPath: string | undefined;
  const key = (request: string | { url: string }) => new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
  const network = async (request: string | { url: string }) => {
    const url = new URL(key(request));
    if (!online) throw new TypeError("Offline");
    if (url.pathname === failedPath) return new Response("Missing", { status: 404 });
    const version = url.pathname.match(/controller-shell-(v\d+)\.html/)?.[1];
    const response = new Response(url.pathname === "/controller" ? shell(serving) : version ? shell(version) : `${url.pathname} bytes`);
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name)!;
      return {
        async match(request: string | { url: string }) { return entries.get(key(request))?.clone(); },
        async put(request: string | { url: string }, response: Response) { entries.set(key(request), response.clone()); },
        async addAll(requests: Array<string | { url: string }>) {
          // Cache.addAll commits its batch only after every fetch has succeeded.
          const responses = await Promise.all(requests.map(network));
          if (responses.some((response) => !response.ok)) throw new TypeError("Precache failed");
          requests.forEach((request, index) => entries.set(key(request), responses[index]!.clone()));
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
    async match(request: string | { url: string }, options?: { ignoreSearch?: boolean }) {
      for (const entries of stores.values()) {
        const entry = options?.ignoreSearch
          ? [...entries].find(([url]) => new URL(url).pathname === new URL(key(request)).pathname)?.[1]
          : entries.get(key(request));
        if (entry) return entry.clone();
      }
      return undefined;
    },
  };
  function worker(version: string) {
    const listeners = new Map<string, (event: unknown) => void>();
    let skipWaiting = 0;
    let claims = 0;
    const assets = [shellFile(version), script(version), stylesheet(version), "/link.webmanifest", "/icons/101-link.svg"];
    const source = template.replaceAll("__BUILD_ID__", version).replaceAll("__CONTROLLER_SHELL__", shellFile(version))
      .replace("/* __PRECACHE__ */ []", JSON.stringify(assets));
    runInNewContext(source, {
      caches, fetch: network, URL, Response,
      Request: class extends Request {
        constructor(input: string, init?: RequestInit) { super(key(input), init); }
      },
      self: {
        location: { origin: ORIGIN },
        addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
        skipWaiting: async () => { skipWaiting++; },
        clients: { claim: async () => { claims++; } },
      },
    });
    return {
      get skipWaiting() { return skipWaiting; },
      get claims() { return claims; },
      async lifecycle(name: string) {
        const pending: Promise<unknown>[] = [];
        listeners.get(name)?.({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
        await Promise.all(pending);
      },
      async request(path: string, mode = "cors") {
        const pending: Promise<unknown>[] = [];
        let response: Promise<Response> | undefined;
        listeners.get("fetch")?.({ request: { url: key(path), method: "GET", mode },
          respondWith: (value: Promise<Response>) => { response = value; },
          waitUntil: (value: Promise<unknown>) => pending.push(value) });
        const result = response ? await response : await network(path);
        await Promise.all(pending);
        return result;
      },
    };
  }
  return {
    worker, caches,
    setOnline(value: boolean) { online = value; },
    serve(version: string) { serving = version; },
    fail(path: string) { failedPath = path; },
  };
}

test("an installed upgrade has a matching offline shell, JavaScript and CSS before activation", async () => {
  const browser = harness();
  const v1 = browser.worker("v1");
  await v1.lifecycle("install");
  await v1.lifecycle("activate");
  // An existing controller has already loaded its first build's code.
  await v1.request(script("v1"));
  await v1.request(stylesheet("v1"));
  browser.serve("v2");
  const v2 = browser.worker("v2");
  await v2.lifecycle("install");
  const candidate = await browser.caches.open("101-link-v2");
  assert.ok(await candidate.match(script("v2")), "installation omitted the new controller JavaScript");
  assert.ok(await candidate.match(stylesheet("v2")), "installation omitted the new controller CSS");
  browser.setOnline(false);
  assert.equal(await (await v1.request(SHELL, "navigate")).text(), shell("v1"));
  assert.equal((await v1.request(script("v1"))).status, 200);
  // The browser dispatches activate only once all clients controlled by v1 have closed.
  await v2.lifecycle("activate");
  assert.deepEqual(await browser.caches.keys(), ["101-link-v2"]);
  assert.equal(await (await v2.request(SHELL, "navigate")).text(), shell("v2"));
  assert.equal((await v2.request(script("v2"))).status, 200);
  assert.equal((await v2.request(stylesheet("v2"))).status, 200);
});

test("an update waits for old clients instead of forcing takeover", async () => {
  const browser = harness();
  const update = browser.worker("v2");
  await update.lifecycle("install");
  assert.equal(update.skipWaiting, 0);
  await update.lifecycle("activate");
  assert.equal(update.claims, 0, "an unclaimed document may still be running an older build");
});

test("a failed update preserves the previous build and removes the incomplete candidate", async () => {
  const browser = harness();
  const v1 = browser.worker("v1");
  await v1.lifecycle("install");
  await v1.lifecycle("activate");
  browser.serve("v2");
  browser.fail("/icons/101-link.svg");
  await assert.rejects(browser.worker("v2").lifecycle("install"));
  assert.deepEqual(await browser.caches.keys(), ["101-link-v1"]);
  browser.setOnline(false);
  assert.equal(await (await v1.request(SHELL, "navigate")).text(), shell("v1"));
});

test("a newer online document never overwrites the active build's offline shell", async () => {
  const browser = harness();
  const active = browser.worker("v1");
  await active.lifecycle("install");
  browser.serve("v2");
  assert.equal(await (await active.request(SHELL, "navigate")).text(), shell("v2"));
  browser.setOnline(false);
  assert.equal(await (await active.request(SHELL, "navigate")).text(), shell("v1"));
});

test("pairing secrets and signalling requests never enter a build cache", async () => {
  const browser = harness();
  const active = browser.worker("v1");
  await active.lifecycle("install");
  const secret = "/controller?session=private&pair=secret";
  await active.request(secret, "navigate");
  await active.request("/v1/sessions/private");
  await active.request("/vinext-client-entry-manifest.json");
  const cache = await browser.caches.open("101-link-v1");
  for (const path of [secret, "/v1/sessions/private", "/vinext-client-entry-manifest.json"]) assert.equal(await cache.match(path), undefined);
  browser.setOnline(false);
  await assert.rejects(active.request(secret, "navigate"));
});
