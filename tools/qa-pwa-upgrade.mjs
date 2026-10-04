#!/usr/bin/env node
/** Exercise two packaged production builds on one real browser origin. */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const roots = process.argv.slice(2).map((path) => resolve(path));
if (roots.length !== 2) throw new Error("Usage: node tools/qa-pwa-upgrade.mjs OLD_WEB_DIR NEW_WEB_DIR");
const builds = await Promise.all(roots.map(async (root) => ({
  root,
  worker: (await import(pathToFileURL(resolve(root, "server/index.js")).href)).default,
  script: await readFile(resolve(root, "client/sw.js"), "utf8"),
})));
const ids = builds.map(({ script }) => script.match(/const BUILD_ID = "([0-9a-f]+)"/)?.[1]);
assert.ok(ids.every(Boolean) && ids[0] !== ids[1], "The two packaged builds must have distinct stamped workers");

let current = builds[0];
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host}`);
    const request = new Request(url, { method: incoming.method, headers: incoming.headers });
    const asset = await assetResponse(current.root, request);
    const response = asset.status !== 404 ? asset : await current.worker.fetch(request,
      { ASSETS: { fetch: (requested) => assetResponse(current.root, requested) } },
      { waitUntil() {}, passThroughOnException() {} });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(incoming.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500); outgoing.end(String(error));
  }
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  await room(page, `${base}/controller?session=BUILDA`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  assert.ok((await page.evaluate(() => caches.keys())).includes(`101-link-${ids[0]}`));

  current = builds[1];
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((registration) => Boolean(registration?.waiting)));
  assert.deepEqual((await page.evaluate(() => caches.keys())).sort(), [`101-link-${ids[0]}`, `101-link-${ids[1]}`].sort());
  await context.setOffline(true);
  await room(page, `${base}/controller?session=OLDROOM`);
  assert.ok((await page.evaluate(() => caches.keys())).includes(`101-link-${ids[0]}`), "Old active build lost its assets");

  await context.setOffline(false);
  await page.close();
  const updated = await context.newPage();
  await room(updated, `${base}/controller?session=NEWROOM`);
  await updated.waitForFunction((id) => caches.keys().then((keys) => keys.length === 1 && keys[0] === `101-link-${id}`), ids[1]);
  const retainedData = await updated.evaluate(async (id) => {
    const path = "/controller?session=PRIVATE&_rsc=stream";
    await fetch(path);
    return Boolean(await (await caches.open(`101-link-${id}`)).match(path));
  }, ids[1]);
  assert.equal(retainedData, false, "The updated worker cached room data");
  await context.setOffline(true);
  await room(updated, `${base}/controller?session=ANOTHERROOM`);
  await context.close();
  console.log(`PWA upgrade: PASS (${ids[0]} → ${ids[1]}; old active and new offline rooms)`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

async function room(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const name = new URL(url).searchParams.get("session");
  await page.locator(".controller-session strong").getByText(name).waitFor();
}

async function assetResponse(root, request) {
  const url = new URL(request.url);
  const assetRoot = resolve(root, "client");
  let file;
  try { file = resolve(assetRoot, `.${decodeURIComponent(url.pathname)}`); }
  catch { return new Response("Invalid path", { status: 400 }); }
  if (!file.startsWith(`${assetRoot}${sep}`)) return new Response("Invalid path", { status: 400 });
  try {
    if (!(await stat(file)).isFile()) return new Response("Missing", { status: 404 });
    const ext = file.slice(file.lastIndexOf("."));
    const type = ({ ".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".wasm": "application/wasm" })[ext] ?? "application/octet-stream";
    return new Response(request.method === "HEAD" ? null : await readFile(file), { headers: { "Content-Type": type } });
  } catch { return new Response("Missing", { status: 404 }); }
}
