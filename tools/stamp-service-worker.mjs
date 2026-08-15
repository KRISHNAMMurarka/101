#!/usr/bin/env node
/**
 * Stamps the built service worker with an id derived from the build itself.
 *
 * The service worker names its cache `101-link-${BUILD_ID}` and deletes every other `101-link-`
 * cache on activate. That only evicts anything if the id actually changes between releases, so it
 * is computed here from the bytes of the built client rather than hand-maintained — a constant
 * someone has to remember to bump is a constant that does not get bumped, which is exactly how the
 * previous "v1" survived every release.
 *
 * Runs against the build output, never against `public/sw.js`, so the placeholder stays in source.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const CLIENT_DIR = "dist/client";
const WORKER = join(CLIENT_DIR, "sw.js");
const PLACEHOLDER = "__BUILD_ID__";

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/**
 * Per-build manifest directories are excluded: they are uniquely named, so they can never be served
 * stale, and they carry no information about whether anything a client caches actually changed.
 *
 * With the build id and RSC compatibility id pinned to the source (see next.config.ts), the output
 * is byte-reproducible and this id is therefore stable across builds of identical source — so a
 * release that changes nothing no longer evicts every user's cache, while one that changes anything
 * still does.
 */
const PER_BUILD = /\/_next\/static\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//;

async function buildId() {
  const hash = createHash("sha256");
  const files = [];
  for await (const path of walk(CLIENT_DIR)) {
    // The worker is what we are about to rewrite, so hashing it would make the id depend on itself.
    if (path === WORKER) continue;
    if (PER_BUILD.test(path)) continue;
    files.push(path);
  }
  // Directory order is not guaranteed across machines; sorting keeps the id from depending on the
  // filesystem rather than on the build.
  files.sort();
  for (const path of files) {
    hash.update(relative(CLIENT_DIR, path));
    hash.update(await readFile(path));
  }
  return hash.digest("hex").slice(0, 16);
}

const worker = await readFile(WORKER, "utf8").catch(() => {
  throw new Error(`${WORKER} is missing — run the build before stamping the service worker.`);
});

if (!worker.includes(PLACEHOLDER)) {
  throw new Error(
    `${WORKER} has no ${PLACEHOLDER} to replace. Either it was stamped twice, or public/sw.js lost `
    + "the placeholder — without it every release shares one cache and old files are never evicted.",
  );
}

const id = await buildId();
await writeFile(WORKER, worker.replaceAll(PLACEHOLDER, id));

const { size } = await stat(WORKER);
console.log(`Stamped ${WORKER} with build ${id} (${size} bytes).`);
