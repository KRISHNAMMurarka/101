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

test("serves TiltDrift as an independently playable 3D game route", async () => {
  const response = await render("/games/tiltdrift");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /TiltDrift 101 — Infinite local racing/);
  assert.match(html, /Playable 3D vertical slice/);
  assert.match(html, /INPUT BUS \/ STEER ACTIVE/);
});

test("serves BodyDodge with optional local camera and conventional controls", async () => {
  const response = await render("/games/bodydodge");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /BodyDodge 101 — Local camera survival/);
  assert.match(html, /Playable local vision slice/);
  assert.match(html, /ENABLE BODY CAMERA/);
  assert.match(html, /KEYBOARD · GAMEPAD/);
  assert.match(html, /video is neither uploaded nor recorded/i);
});

test("serves Orbital Crew with asymmetric roles and conventional fallback", async () => {
  const response = await render("/games/orbitalcrew");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Orbital Crew 101 — Asymmetric local co-op/);
  assert.match(html, /Playable asymmetric co-op/);
  assert.match(html, /SESSION HOST \/ ROLE ROUTING ACTIVE/);
  assert.match(html, /Keyboard captain fallback/);
  assert.match(html, /CONNECT CREW/);
});

test("server-renders the local Motion Lab and permission explanation", async () => {
  const response = await render("/motion");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Motion Lab/);
  assert.match(html, /Enable device motion/);
  assert.match(html, /Permission is requested only by the button/);
  assert.match(html, /Use keyboard simulation/);
});

test("server-renders the local Vision Lab and simulated fallback", async () => {
  const response = await render("/vision");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Vision Lab/);
  assert.match(html, /Enable local camera/);
  assert.match(html, /Use keyboard simulation/);
  assert.match(html, /never uploaded or recorded/);
  assert.match(html, /MEDIAPIPE/);
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

test("server-renders the dynamic Controller Lab", async () => {
  const response = await render("/controller-lab");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Controller Lab/);
  assert.match(html, /Design the panel/);
  assert.match(html, /Validate \+ apply layout/);
  assert.match(html, /LATEST NORMALIZED FRAME/);
});

test("serves the controller surface and product metadata", async () => {
  const response = await render("/controller?session=TEST01");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Link — Browser controller/);
  assert.match(html, /LINK \/ (?:<!-- -->)?CLASSIC/);
  assert.match(html, /Classic Controller/);
  assert.match(html, /JSON-defined panel/);

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
  await access(new URL("public/models/pose_landmarker_lite.task", root));
  await access(new URL("public/mediapipe/wasm/vision_wasm_internal.wasm", root));
  await access(new URL("dist/client/models/pose_landmarker_lite.task", root));
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
});
