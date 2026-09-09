import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("101 Link publishes an installable standalone controller manifest", () => {
  const manifest = JSON.parse(readFileSync("public/link.webmanifest", "utf8")) as { id: string; start_url: string; scope: string; display: string; icons: Array<{ purpose: string }> };
  assert.equal(manifest.id, "/controller");
  assert.match(manifest.start_url, /^\/controller/);
  assert.equal(manifest.scope, "/controller");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.purpose.includes("maskable")));
});

test("offline cache excludes pairing secrets and obsolete OpenAI hosting metadata", () => {
  const worker = readFileSync("public/sw.js", "utf8");
  assert.match(worker, /searchParams\.has\("pair"\)/);
  assert.match(worker, /Never persist that URL or response/);
  assert.equal(existsSync(".openai/hosting.json"), false);
  assert.equal(existsSync("build/sites-vite-plugin.ts"), false);
  assert.doesNotMatch(readFileSync("vite.config.ts", "utf8"), /openai|sites\(/i);
});

test("the offline cache is disposable, so a release cannot be pinned forever", () => {
  // `CACHE_VERSION` used to be the literal "101-link-v1", which no build step ever rewrote. The
  // activate handler deletes every "101-link-" cache that is not the current one, so comparing a
  // constant to itself deleted nothing: the cache from a user's first visit survived every later
  // release. The id is now stamped from the build itself, which is the only version that cannot be
  // forgotten to bump.
  const worker = readFileSync("public/sw.js", "utf8");
  assert.match(worker, /const BUILD_ID = "__BUILD_ID__"/,
    "source must keep the placeholder the build stamps over");
  assert.match(worker, /101-link-\$\{BUILD_ID\}/, "the cache name must carry the build id");
  assert.match(worker, /key !== CACHE_VERSION/, "activate must drop every other build's cache");

  const stamper = readFileSync("tools/stamp-service-worker.mjs", "utf8");
  assert.match(stamper, /__BUILD_ID__/);
  assert.match(stamper, /createHash/, "the id must be derived from the build, not hand-maintained");

  const build = JSON.parse(readFileSync("package.json", "utf8")).scripts.build;
  assert.match(build, /stamp-service-worker/,
    "an unstamped build ships the placeholder and every release shares one cache");
});

test("only content-hashed assets may be answered from cache without checking the network", () => {
  // A blanket cache-first stored any same-origin GET forever. Content-hashed files are safe that
  // way because the name changes with the bytes, but the build manifests are not hashed: a pinned
  // `vinext-client-entry-manifest.json` or `.vite/manifest.json` lists chunk names that no longer
  // exist, so the app fails to boot after an update rather than merely looking stale.
  const worker = readFileSync("public/sw.js", "utf8");

  assert.match(worker, /const IMMUTABLE = \/\^\\\/_next\\\/static\\\//,
    "only the bundler's hashed output counts as immutable");
  assert.match(worker, /NEVER_CACHE/, "build manifests must bypass the cache entirely");
  assert.match(worker, /manifest\\\.json\$/, "…including the vite and vinext entry manifests");
  assert.match(worker, /staleWhileRevalidate/,
    "unversioned assets must still refresh, or an update never reaches an installed controller");
  assert.match(worker, /IMMUTABLE\.test\(url\.pathname\) \? cacheFirst\(request\) : staleWhileRevalidate\(request, event\)/,
    "the split between the two strategies must stay explicit");

  // The privacy rules this file already carried must survive the rewrite.
  assert.match(worker, /searchParams\.has\("pair"\)/);
  assert.match(worker, /Never persist that URL or response/);
});

test("the build is pinned to its source, so two builds of it are identical", async () => {
  // vinext mints a fresh randomUUID() per build for both the build id and the RSC compatibility id:
  //
  //     function createRscCompatibilityId(nextConfig) {
  //       if (nextConfig.deploymentId) return nextConfig.deploymentId;
  //       return randomUUID();
  //     }
  //
  // That UUID is baked into a chunk, so its content hash changed every build, and the 22 chunks
  // importing it changed with it — 24 of 59 chunk filenames churned on a build of identical source.
  // Two consequences: no build could be verified against its source, and the service worker's cache
  // id (a hash of the output) changed on every release, evicting every user's cache for nothing.
  //
  // Pinning both to a hash of the source keeps the property the ids exist for — they must differ
  // when the deployed app differs, so a stale client hard-navigates instead of accepting a
  // mismatched RSC payload — while dropping the part that was pure noise.
  const config = readFileSync("next.config.ts", "utf8");
  assert.match(config, /deploymentId:/, "the RSC compatibility id must not be random per build");
  assert.match(config, /generateBuildId:/, "nor the build id");
  assert.match(config, /sourceId\(\)/, "both must come from the source, not a constant to bump");

  // A constant would pin the build but never change, so a real release would not invalidate
  // anything. The id has to track the source in both directions.
  const { sourceId } = await import("../tools/source-id.mjs");
  const first = await sourceId();
  const second = await sourceId();
  assert.equal(first, second, "the same tree must hash the same way twice");
  assert.match(first, /^[0-9a-f]{32}$/);

  const helper = readFileSync("tools/source-id.mjs", "utf8");
  assert.match(helper, /package-lock\.json/,
    "a dependency bump changes the output without touching this repo's source");
  for (const derived of ["dist", "node_modules"]) {
    assert.match(helper, new RegExp(`"${derived}"`),
      `${derived} is build output, and hashing it into the id would be circular`);
  }
});

test("starting a server refuses a port something else already holds", () => {
  // A different project on this machine ran its own dev server on [::1]:3000 while this one bound
  // *:3000 on IPv4. Both bind without error — they are different sockets — and macOS resolves
  // "localhost" to ::1 first, so every localhost:3000 request was answered by the other
  // application. Deleted code appeared to still run and a rebuild appeared to change nothing.
  // Nothing was stale; we were reading a different program.
  const guard = readFileSync("tools/check-port.mjs", "utf8");
  assert.match(guard, /LISTEN/, "it must look for an existing listener");
  assert.match(guard, /process\.exit\(1\)/, "and refuse to start, not merely warn");
  assert.match(guard, /PORT=/, "and offer a way through, or it is just an obstacle");
  // A check that cannot run must never block a build — lsof is absent on plenty of machines.
  assert.match(guard, /return \[\];/);

  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  for (const hook of ["predev", "prestart"]) {
    assert.match(scripts[hook] ?? "", /check-port/, `${hook} must run the guard`);
  }
});

for (const sharedController of [false, true]) test(`offline stamping follows ${sharedController ? "shared" : "route"} controller dependencies without downloading every game`, async (context) => {
  const { controllerAssets, stampServiceWorker } = await import("../tools/stamp-service-worker.mjs");
  const dir = await mkdtemp(join(tmpdir(), "101-offline-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const client = join(dir, "client");
  const files: Record<string, string> = {
    "_next/static/chunks/index.js": "browser registry",
    "_next/static/chunks/controller.js": "controller",
    "_next/static/chunks/shared.js": "shared dependency",
    "_next/static/chunks/controller-lazy.js": "controller lazy dependency",
    "_next/static/chunks/framework-lazy.js": "framework lazy dependency",
    "_next/static/chunks/game.js": "unrelated game",
    "_next/static/css/controller.css": "@font-face{src:url('../fonts/controller.woff2?dpl=build')} body{color:black}",
    "_next/static/fonts/controller.woff2": "font",
    "link.webmanifest": "{}",
    "icons/101-link.svg": "<svg/>",
  };
  // Rolldown promotes Controller into a named shared chunk once another route imports it.
  // Such chunks have no src/isDynamicEntry fields and no source-path manifest key.
  const controllerKey = sharedController ? "_Controller-controller.js" : "app/controller/Controller.tsx";
  const manifest = {
    "virtual:vinext-app-browser-entry": { file: "_next/static/chunks/index.js", dynamicImports: [controllerKey, "app/games/unused.tsx", "node_modules/framework/lazy.js"] },
    [controllerKey]: { file: "_next/static/chunks/controller.js", name: "Controller", imports: ["shared"], dynamicImports: ["controller-lazy"], css: ["_next/static/css/controller.css"] },
    shared: { file: "_next/static/chunks/shared.js" },
    "controller-lazy": { file: "_next/static/chunks/controller-lazy.js" },
    "node_modules/framework/lazy.js": { file: "_next/static/chunks/framework-lazy.js" },
    "app/games/unused.tsx": { file: "_next/static/chunks/game.js" },
  };
  files[".vite/manifest.json"] = JSON.stringify(manifest);
  const template = readFileSync("public/sw.js", "utf8");
  files["sw.js"] = template;
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(client, path)), { recursive: true });
    await writeFile(join(client, path), content);
  }
  const html = '<!doctype html><script src="/_next/static/chunks/index.js"></script><script src="/_next/static/chunks/controller.js"></script>';
  const assets = await controllerAssets(client, html);
  assert.deepEqual(assets, [
    "/_next/static/chunks/controller-lazy.js", "/_next/static/chunks/controller.js",
    "/_next/static/chunks/framework-lazy.js", "/_next/static/chunks/index.js", "/_next/static/chunks/shared.js",
    "/_next/static/css/controller.css", "/_next/static/fonts/controller.woff2?dpl=build", "/icons/101-link.svg", "/link.webmanifest",
  ]);
  // Render locally against a tiny built-worker fixture; stamping never calls a remote server.
  const server = join(dir, "server.mjs");
  await writeFile(server, `export default {fetch: async () => new Response(${JSON.stringify(html)}, {headers: {"content-type":"text/html"}})};`);
  const first = await stampServiceWorker(client, server);
  const stamped = readFileSync(join(client, "sw.js"), "utf8");
  assert.doesNotMatch(stamped, /__BUILD_ID__|__CONTROLLER_SHELL__|__PRECACHE__/);
  assert.equal(readFileSync(join(client, first.shellPath.slice(1)), "utf8"), html);
  await assert.rejects(stampServiceWorker(client, server), /stamp exactly once/);
  await writeFile(join(client, "sw.js"), template);
  assert.equal((await stampServiceWorker(client, server)).id, first.id, "identical output must retain its cache id");
  await writeFile(join(client, "sw.js"), `${template}\n// lifecycle change\n`);
  assert.notEqual((await stampServiceWorker(client, server)).id, first.id, "worker changes must create an update even when chunks match");
  await rm(join(client, "_next/static/chunks/shared.js"));
  await assert.rejects(controllerAssets(client, html), /ENOENT/, "missing required assets must fail the build");
});
