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
