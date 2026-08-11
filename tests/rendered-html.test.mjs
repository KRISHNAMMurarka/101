import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the 101 launcher and all ten catalog games", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>101 — Anything can be a controller<\/title>/i);
  assert.match(html, /Anything can be/);
  assert.match(html, /101 Input Lab/);
  assert.match(html, /Slashstorm 101/);
  assert.match(html, /Launch game/);
  assert.match(html, /TiltDrift 101/);
  assert.match(html, /BodyDodge 101/);
  assert.match(html, /Orbital Crew 101/);
  assert.match(html, /BeatForge 101/);
  assert.match(html, /GravityStack 101/);
  assert.match(html, /Spellcaster 101/);
  assert.match(html, /Echo Maze 101/);
  assert.match(html, /Shadow Arena 101/);
  assert.match(html, /Swarm Commander 101/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("serves Slashstorm as an independently playable game route", async () => {
  const response = await render("/games/slashstorm");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Slashstorm 101 — Play locally/);
  assert.match(html, /Playable vertical slice/);
  assert.match(html, /INPUT BUS \/ SWORD ACTIVE/);
});

test("server-renders the offline WebRTC Network Lab", async () => {
  const response = await render("/network");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Network Lab/);
  assert.match(html, /Connect two browsers/);
  assert.match(html, /No signaling server/);
  assert.match(html, /STRICT LOCAL/);
});

test("serves the controller surface and product metadata", async () => {
  const response = await render("/controller?session=TEST01");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Link — Browser controller/);
  assert.match(html, /LINK \/ CLASSIC/);

  const [layout, manifest, packageJson] = await Promise.all([
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("public/manifest.webmanifest", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);
  assert.match(layout, /openGraph/);
  assert.match(layout, /twitter/);
  assert.match(manifest, /"display": "standalone"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("public/og.png", root));
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
});
