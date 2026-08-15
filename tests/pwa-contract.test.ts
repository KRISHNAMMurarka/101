import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  assert.match(worker, /IMMUTABLE\.test\(url\.pathname\) \? cacheFirst\(request\) : staleWhileRevalidate\(request\)/,
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
