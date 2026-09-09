#!/usr/bin/env node
/** Render a matching offline controller and stamp its dependency closure into the built worker. */
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLIENT_DIR = "dist/client";
const PLACEHOLDER = "__BUILD_ID__";
const BROWSER_ENTRY = "virtual:vinext-app-browser-entry";
const SHELL_ROUTE = "/controller?session=101LAB";
const ORIGIN = "http://offline-controller.invalid";
const PER_BUILD = /\/_next\/static\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//;
const GENERATED_SHELL = /\/controller-shell-[0-9a-f]+\.html$/;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * HTML identifies this route's client modules; the manifest supplies their dependency closure.
 * The browser entry's dynamic app registry contains every game, so only the app modules actually
 * present in this document are followed there. Framework and controller-specific dynamic imports
 * are still included. CSS fonts/assets join the same atomic batch.
 */
export async function controllerAssets(clientDir, html) {
  const manifest = JSON.parse(await readFile(join(clientDir, ".vite/manifest.json"), "utf8"));
  if (!manifest[BROWSER_ENTRY]) {
    throw new Error("The build manifest has no browser entry; refusing an incomplete offline cache.");
  }
  const byFile = new Map(Object.entries(manifest).map(([key, entry]) => [entry.file, key]));
  const assets = new Set(html.match(/\/_next\/static\/[^"'<>\\\s)]+/g) ?? []);
  const seededEntries = new Set([...assets].map((path) => byFile.get(new URL(path, ORIGIN).pathname.slice(1))).filter(Boolean));
  // A module used by several routes becomes a named shared chunk, losing its source-path key.
  // Check the rendered dependency's manifest identity, not one bundler-dependent key spelling.
  if (![...seededEntries].some((key) => key === "app/controller/Controller.tsx" || manifest[key].name === "Controller")) {
    throw new Error("Rendered offline page does not contain the controller.");
  }
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing build dependency: ${key}`);
    for (const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) assets.add(`/${file}`);
    for (const dependency of entry.imports ?? []) visit(dependency);
    for (const dependency of entry.dynamicImports ?? []) {
      if (key === BROWSER_ENTRY && dependency.startsWith("app/") && !seededEntries.has(dependency)) continue;
      visit(dependency);
    }
  };
  for (const entry of seededEntries) visit(entry);
  for (const path of assets) {
    const assetURL = new URL(path, ORIGIN);
    if (!assetURL.pathname.endsWith(".css")) continue;
    const css = await readFile(join(clientDir, assetURL.pathname.slice(1)), "utf8");
    for (const match of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
      const url = new URL(match[1], `${ORIGIN}${path}`);
      if (url.origin === ORIGIN) assets.add(`${url.pathname}${url.search}`);
    }
  }
  assets.add("/link.webmanifest");
  assets.add("/icons/101-link.svg");
  for (const asset of assets) {
    const url = new URL(asset, ORIGIN);
    if (url.origin !== ORIGIN || url.searchParams.has("pair") || url.hash || asset.includes("..")) {
      throw new Error(`Unsafe offline asset path: ${asset}`);
    }
    if (!(await stat(join(clientDir, url.pathname.slice(1)))).isFile()) throw new Error(`Missing offline asset: ${asset}`);
  }
  return [...assets].sort();
}

export async function renderController(serverFile) {
  const { default: worker } = await import(pathToFileURL(resolve(serverFile)).href);
  // Invoke the built route directly: no listening port, remote service, or deployed HTML involved.
  const response = await worker.fetch(new Request(`${ORIGIN}${SHELL_ROUTE}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`Could not render the offline controller (${response.status}).`);
  }
  return response.text();
}

export async function stampServiceWorker(clientDir = CLIENT_DIR, serverFile = "dist/server/index.js") {
  const workerPath = join(clientDir, "sw.js");
  const worker = await readFile(workerPath, "utf8");
  for (const token of [PLACEHOLDER, "__CONTROLLER_SHELL__", "/* __PRECACHE__ */ []"]) {
    if (!worker.includes(token)) throw new Error(`${workerPath} has no ${token}; build first and stamp exactly once.`);
  }
  const html = await renderController(serverFile);
  const assets = await controllerAssets(clientDir, html);
  const shellHash = createHash("sha256").update(html).digest("hex").slice(0, 16);
  const shellPath = `/_next/static/controller-shell-${shellHash}.html`;
  const hash = createHash("sha256").update(worker).update(html);
  const files = [];
  for await (const path of walk(clientDir)) {
    if (path === workerPath || PER_BUILD.test(path) || GENERATED_SHELL.test(path)) continue;
    files.push(path);
  }
  // Hash source worker bytes too: a lifecycle fix must install even if application chunks match.
  for (const path of files.sort()) hash.update(relative(clientDir, path)).update(await readFile(path));
  const id = hash.digest("hex").slice(0, 16);
  await writeFile(join(clientDir, shellPath.slice(1)), html);
  await writeFile(workerPath, worker.replaceAll(PLACEHOLDER, id).replaceAll("__CONTROLLER_SHELL__", shellPath)
    .replace("/* __PRECACHE__ */ []", JSON.stringify([shellPath, ...assets])));
  console.log(`Stamped ${workerPath} with build ${id} and ${assets.length} controller assets.`);
  return { id, assets, shellPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await stampServiceWorker();
