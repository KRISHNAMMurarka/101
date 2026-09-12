import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { execFileSync } from "node:child_process";

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

test("server-renders the player library, and nothing built for developers", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>101 — Anything can be a controller<\/title>/i);
  assert.match(html, /Anything can be/);
  assert.match(html, /Slashstorm 101/);
  // A link with a real href, not a button that swapped a useState value: the ten /games/<id> routes
  // already existed and nothing in app/ pointed at them, so launching a game produced no URL, no
  // history entry and no way back.
  assert.match(html, /href="\/games\/slashstorm"/);
  assert.match(html, /href="\/games\/echomaze"/);
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

  /*
   * The player home is a library, not a tour of the architecture. These assertions protect the
   * removal rather than merely surviving it: each string was on this page and each described the
   * system to someone building on it, not to someone about to play.
   *
   * The Input Lab is the sharpest case. gameCatalog.ts filters it out of the catalog precisely
   * because it is not a game, and the launcher then hand-re-added it as the largest card in the
   * library — a frame-rate readout presented as the featured title.
   */
  assert.doesNotMatch(html, /101 Input Lab|Launch diagnostic/i, "a diagnostic must not be featured in the game library");
  assert.doesNotMatch(html, /INPUT BUS|normalized events|one stable API|SYSTEM \/ 001/i, "architecture vocabulary is developer copy");
  assert.doesNotMatch(html, /No cloud gameplay|Offline by design|local path/i, "claims that stop being true once 101 runs a server");
  assert.doesNotMatch(html, /Game eleven/i, "a hardcoded ordinal goes stale the moment a game is added");
});

test("server-renders a bounded first window for the 1000-entry catalog benchmark", async () => {
  const response = await render("/studio/catalog-bench?count=1000");
  assert.equal(response.status, 200);
  const html = await response.text();
  const renderedText = html.replaceAll("<!-- -->", "");
  const cards = html.match(/class="[^"]*\bcatalog-game-card\b[^"]*"/g) ?? [];
  const cardHeadings = [...html.matchAll(
    /<article\b[^>]*\bcatalog-game-card\b[^>]*>[\s\S]*?<h3>([^<]+)<\/h3>[\s\S]*?<\/article>/g,
  )].map((match) => match[1]);

  assert.equal(cards.length, 12, "SSR must emit one bounded twelve-card window");
  assert.equal(cardHeadings.length, 12, "only twelve manifest cards belong in the rendered DOM");
  assert.equal((html.match(/aria-setsize="1000"/g) ?? []).length, 12);
  assert.match(renderedText, /1000 games\. One way to play\./i);
  assert.match(cardHeadings.at(-1) ?? "", /Catalog Fixture 0012/);
  assert.doesNotMatch(cardHeadings.join("\n"), /Catalog Fixture 0013|Catalog Fixture 1000/,
    "the server must not eagerly mount the rest of the synthetic catalog");
  assert.match(html, /Catalog Fixture 1000/,
    "all one thousand manifest records must cross the production server-to-client boundary");
});

test("no game screen labels itself with its development stage or its engine", async () => {
  for (const id of ["slashstorm", "tiltdrift", "bodydodge", "orbitalcrew", "beatforge", "gravitystack", "spellcaster", "echomaze", "shadowarena", "swarmcommander"]) {
    const html = await (await render(`/games/${id}/play`)).text();
    assert.doesNotMatch(html, /Playable [a-z0-9 +-]*(slice|physics|co-op|survival|exploration|movement|combat|command)/i, `${id} still names its development stage`);
    assert.doesNotMatch(html, /· Seed /i, `${id} still prints its RNG seed label`);
    assert.doesNotMatch(html, /INPUT BUS|RAPIER|SPATIAL HASH|SESSION HOST|RHYTHM CLOCK|STATE MACHINE|SEEDED MAZE/i, `${id} still names a subsystem in its status bar`);
  }
});

test("serves Slashstorm as an independently playable game route", async () => {
  const response = await render("/games/slashstorm/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Slashstorm 101/);
});

test("serves TiltDrift as an independently playable 3D game route", async () => {
  const response = await render("/games/tiltdrift/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /TiltDrift 101/);
});

test("serves BodyDodge with optional local camera and conventional controls", async () => {
  const response = await render("/games/bodydodge/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /BodyDodge 101/);
  assert.match(html, /Use the camera/);
  assert.match(html, /CONNECT PANEL/);
  // This used to assert the literal "KEYBOARD · GAMEPAD", which the page printed whether or not a
  // gamepad existed. The slot now reports what the game's input manifest actually resolved against
  // the hardware present, and a server render has measured nothing yet — so the honest server-side
  // value is neither a device list nor "NO INPUT", both of which would be claims we cannot support.
  assert.match(html, /Checking…|No controller yet|Keyboard/);
  assert.doesNotMatch(html, /KEYBOARD · GAMEPAD/,
    "the status bar must not claim hardware it has not detected");
  assert.match(html, /nothing is uploaded, nothing is recorded/i);
});

test("serves Orbital Crew with asymmetric roles and conventional fallback", async () => {
  const response = await render("/games/orbitalcrew/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Orbital Crew 101/);
  assert.match(html, /Play on this screen/);
  assert.match(html, /CONNECT CREW/);
});

test("serves BeatForge with offline rhythm, Link motion, and local pose choices", async () => {
  const response = await render("/games/beatforge/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /BeatForge 101/);
  assert.match(html, /ENABLE AUDIO/);
  assert.match(html, /Use the camera/);
  assert.match(html, /nothing is uploaded, nothing is recorded/i);
});

test("serves GravityStack through the 101 physics facade and asymmetric roles", async () => {
  const response = await render("/games/gravitystack/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /GravityStack 101/);
  assert.match(html, /Gravity Controller/);
  assert.match(html, /Shape Builder/);
  assert.match(html, /On this screen/);
});

test("serves Spellcaster through shared hand, motion, and conventional spell actions", async () => {
  const response = await render("/games/spellcaster/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Spellcaster 101/);
  assert.match(html, /Use the camera/);
  assert.match(html, /Every spell also works on the keyboard or a gamepad/i);
});

test("serves Echo Maze with private Link clues and a conventional fallback", async () => {
  const response = await render("/games/echomaze/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Echo Maze 101/);
  assert.match(html, /YOUR CLUE/);
  assert.match(html, /No camera or microphone is needed/i);
});

test("serves Shadow Arena through reusable combat-pose semantics and conventional controls", async () => {
  const response = await render("/games/shadowarena/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Shadow Arena 101/);
  assert.match(html, /Use the camera/);
  assert.match(html, /Every move also works on the keyboard or a gamepad/i);
});

test("serves Swarm Commander with scalable simulation and asymmetric specialist roles", async () => {
  const response = await render("/games/swarmcommander/play");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Swarm Commander 101/);
  assert.match(html, /Use the camera/);
  assert.match(html, /navigator can tilt the shared direction while a tactician sets targets and formations/i);
});

test("server-renders the local Motion Lab and permission explanation", async () => {
  const response = await render("/studio/motion");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Motion Lab/);
  assert.match(html, /Enable device motion/);
  assert.match(html, /Permission is requested only by the button/);
  assert.match(html, /Use keyboard simulation/);
});

test("server-renders the local Vision Lab and simulated fallback", async () => {
  const response = await render("/studio/vision");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Vision Lab/);
  assert.match(html, /Enable local/);
  assert.match(html, /HANDS · 21 LANDMARKS/);
  assert.match(html, /Use keyboard simulation/);
  assert.match(html, /never uploaded or recorded/);
  assert.match(html, /MEDIAPIPE/);
});

test("server-renders the offline WebRTC Network Lab", async () => {
  const response = await render("/studio/network");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Network Lab/);
  assert.match(html, /Connect two browsers/);
  assert.match(html, /No signaling server/);
  assert.match(html, /STRICT LOCAL/);
});

test("server-renders the dynamic Controller Lab", async () => {
  const response = await render("/studio/controller");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Controller Lab/);
  assert.match(html, /Design the panel/);
  assert.match(html, /Validate \+ apply layout/);
  assert.match(html, /LATEST NORMALIZED FRAME/);
});

test("server-renders optional specialist hardware with honest capability state", async () => {
  const response = await render("/studio/hardware");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Hardware Lab/);
  assert.match(html, /Wire bytes into/);
  assert.match(html, /WebHID/);
  assert.match(html, /Web Bluetooth/);
  assert.match(html, /Web Serial/);
  assert.match(html, /FALLBACK GUARANTEE/);
});

test("serves the controller surface and product metadata", async () => {
  const response = await render("/controller?session=TEST01");
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /101 Link — Browser controller/);
  // Was /LINK \/ CLASSIC/. "Link" is the product's internal name for the controller app and
  // "classic" was the role id, printed as the title of the thing a player is holding.
  assert.doesNotMatch(html, /LINK \/|SAME-BROWSER|OFFLINE SHELL|PRIVATE AUDIO/i,
    "the controller must not name its transport, its internal app name, or its role id");
  assert.match(html, /Ready to connect/);
  assert.doesNotMatch(html, /class="[^"]*dynamic-controller-deck[^"]*"/,
    "an unassigned controller must not show inactive game controls");
  // The SDK guarantee that a host can swap the panel is a developer fact, and it was printed on the
  // surface a player holds while playing.
  assert.doesNotMatch(html, /JSON-defined panel|normalized 101 input/i);
  // The invariant is that the server and the first client render agree — the controller hydrates
  // over whatever this says, and a mismatch is a hydration error on the surface a player is holding.
  // The wording moved from "SAME-BROWSER · ONLINE", which named the transport.
  assert.match(html.replaceAll("<!-- -->", ""), /Connect to a game/,
    "server and first client render need the same connectivity text so the controller hydrates cleanly");
  assert.doesNotMatch(html, /OFFLINE SHELL/,
    "the browser updates real connectivity after hydration; the server must not guess from its worker navigator");

  const [manifest, packageJson] = await Promise.all([
    readFile(new URL("public/manifest.webmanifest", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);
  // The social tags are asserted against the rendered <head> further down rather than against the
  // source of app/layout.tsx. Matching /openGraph/ in the source only proved the key was typed: it
  // passed for months while every one of those tags was being rendered into a hidden div in the
  // body, where nothing that unfurls a link would ever look.
  assert.match(manifest, /"display": "standalone"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await access(new URL("public/og.png", root));
  await access(new URL("public/models/pose_landmarker_lite.task", root));
  await access(new URL("public/models/hand_landmarker.task", root));
  await access(new URL("public/mediapipe/wasm/vision_wasm_internal.wasm", root));
  await access(new URL("dist/client/models/pose_landmarker_lite.task", root));
  await access(new URL("dist/client/models/hand_landmarker.task", root));
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
});

/**
 * The shell is an invariant, not a component one page happens to include.
 *
 * Before it existed, `app/layout.tsx` returned `<html><body>{children}</body></html>` and every
 * piece of navigation lived inside Launcher.tsx — so it was present on exactly one of seventeen
 * routes. Land on a game, a lab, or the controller and there was no way back and no indication of
 * where you were. That is the failure this asserts against, and it is the kind that returns quietly
 * the moment someone renders a route outside the shell.
 */
test("every route ships the navigation shell, and the controller deliberately does not", async () => {
  const shellRoutes = ["/", "/devices", "/games/slashstorm", "/games/echomaze"];

  for (const path of shellRoutes) {
    const html = await (await render(path)).text();
    assert.match(html, /class="rail"/, `${path} renders without the rail`);
    assert.match(html, /class="tabbar"/, `${path} renders without the phone tab bar`);
    // Both destinations reachable from anywhere: this is what the old header lost below 760px,
    // where `.nav { display: none }` left eight of ten destinations with no replacement at all.
    assert.match(html, /href="\/devices"/, `${path} offers no way to reach Devices`);
    assert.match(html, /href="\/"/, `${path} offers no way back to the library`);
  }

  // The controller is a device you hold and do not look at; chrome on it would be chrome in your hand.
  const controller = await (await render("/controller")).text();
  assert.doesNotMatch(controller, /class="rail"/, "the controller must stay bare");
});

/**
 * The split is the invariant, not a convention.
 *
 * Six diagnostics used to sit in the player's rail, and one of them held a slot in the three-item
 * phone tab bar — so a thumb tap on a player's home screen opened a page whose first readout is
 * "INPUT 0 Hz / FRAME AGE 0 ms / DROPPED 0%". These assertions are what stop that returning by
 * someone adding "just one" tool link back to the product side.
 */
test("the player surface and the studio do not leak into each other", async () => {
  const player = await (await render("/")).text();
  assert.doesNotMatch(player, /href="\/studio\/[a-z]/, "the player home must not link to a developer tool");
  assert.doesNotMatch(player, /Frame age|Dropped|inference|quaternion|GATT|baud/i, "developer telemetry must not reach a player surface");

  for (const path of ["/studio", "/studio/input", "/studio/network"]) {
    const html = await (await render(path)).text();
    assert.doesNotMatch(html, /class="tabbar"/, `${path} renders the player's phone tab bar`);
    assert.doesNotMatch(html, /class="rail"/, `${path} renders the player's rail`);
    assert.match(html, /class="studio-rail"/, `${path} is missing the studio's own navigation`);
    // A developer who lands here from a deep link should not have to guess where the product is.
    assert.match(html, /href="\/"/, `${path} offers no way back to 101`);
  }
});

test("Devices answers what is connected and how to add something", async () => {
  const html = await (await render("/devices")).text();
  assert.match(html, /What is connected/);
  assert.match(html, /Add a device/);
  /*
   * The "Screen and sound" card is deliberately gone. It was a visible, honestly locked row — which
   * is the right pattern — but its explanation was written in developer terms ("the renderer to move
   * inside each game package"), which is not a sentence a player can do anything with. The
   * constraint belongs in docs/architecture.md, and the card returns when output routing ships with
   * a picker that works.
   */
  assert.doesNotMatch(html, /renderer to move inside|game package/i, "a player surface must not explain unbuilt internals");
});

/**
 * A player who mistypes a URL, or follows a link to a game that has been retired, previously landed
 * on Next's stock 404 — unstyled, with no way back into the product.
 */
test("a wrong URL is a page, not a dead end", async () => {
  const response = await render("/games/not-a-real-game");
  const html = await response.text();
  assert.match(html, /isn.t here/i, "a missing page must say so in words");
  assert.match(html, /href="\/"/, "a missing page must offer a way back");
  assert.doesNotMatch(html, /call stack|webpack|__next|Application error/i, "a player must never see a stack trace");
});

/**
 * A game opens; it does not start.
 *
 * Pressing Play used to drop a player straight into a running game, which is the wrong moment to
 * arrive for a title built around a second device: the notice telling you to pair one appears while
 * the game is already going. A mounted game is a running game — useGameHost launches from an effect
 * with no condition in it — so the chooser and the game are two addresses, and this asserts that
 * boundary in both directions.
 */
test("a game opens at its own page and does not start until the player asks", async () => {
  // Markup only the running game emits, each verified present at /play and absent at the chooser.
  const running = {
    slashstorm: /slash-arena/, tiltdrift: /drift-arena/, bodydodge: /body-arena/,
    orbitalcrew: /orbital-stage/, beatforge: /beat-arena/, gravitystack: /gravity-stage/,
    spellcaster: /spell-arena/, echomaze: /echo-stage/, shadowarena: /shadow-arena/,
    swarmcommander: /swarm-arena/,
  };

  for (const [id, marker] of Object.entries(running)) {
    const chooser = await (await render(`/games/${id}`)).text();
    assert.doesNotMatch(chooser, marker, `${id} starts before the player asks for it`);
    assert.doesNotMatch(chooser, /<canvas/, `${id} mounts a canvas on a screen that is not the game`);
    assert.match(chooser, new RegExp(`href="/games/${id}/play`), `${id} offers no way to start`);
    assert.match(chooser, /How do you want to play/, `${id} does not ask the question`);

    const playing = await (await render(`/games/${id}/play`)).text();
    assert.match(playing, marker, `${id} does not run at its own play route`);
  }
});

/**
 * The screen offers what each game declares, rather than a menu written by hand.
 */
test("the chooser option count and multiplayer action follow the shipped roles", async () => {
  // Load real ordinary-TS role exports in the same supported Node stripping mode as unit tests.
  const catalog = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { readdir, readFile } from "node:fs/promises";
    import { pathToFileURL } from "node:url";
    import { resolve } from "node:path";
    const rows = [];
    for (const id of await readdir("games")) {
      const manifest = JSON.parse(await readFile("games/" + id + "/manifest.json", "utf8"));
      if (manifest.surface === "tool") continue;
      const exports = await import(pathToFileURL(resolve("games", id, "src/roles.ts")));
      const roles = Object.values(exports).find(Array.isArray);
      rows.push({ id: manifest.id, seats: Math.min(manifest.players.max, Math.max(roles.length, 1)), hasPhone: Boolean(roles[0]) });
    }
    console.log(JSON.stringify(rows));
  `], { cwd: root, encoding: "utf8" }));
  for (const { id, seats, hasPhone } of catalog) {
    const html = (await (await render(`/games/${id}`)).text()).replaceAll("<!-- -->", "");
    const options = html.match(/<article class="pre-game-option"/g) ?? [];
    assert.equal(options.length, 1 + Number(hasPhone) + Number(seats > 1), `${id}: initial options must follow roles; camera options await enumeration`);
    if (seats > 1) {
      assert.match(html, new RegExp(`Up to ${seats}`));
      assert.match(html, /Connect players/);
    } else assert.doesNotMatch(html, /With other people/);
  }
});

test("the complete client stays inside the initial compressed bundle budget", async () => {
  const { readdir } = await import("node:fs/promises");
  const { gzipSync } = await import("node:zlib");
  const client = new URL("dist/client/", root);
  const files = (await readdir(client, { recursive: true })).filter((path) => /\.(js|css)$/.test(path));
  assert.ok(files.length > 0, "build output is required");
  let scripts = 0;
  let styles = 0;
  for (const file of files) {
    const size = gzipSync(await readFile(new URL(file, client))).length;
    if (file.endsWith(".css")) styles += size;
    else {
      scripts += size;
      assert.ok(size <= 800 * 1024, `${file}: ${size} gzip bytes exceeds 800 KiB`);
    }
  }
  assert.ok(scripts <= 2 * 1024 * 1024, `all client JavaScript: ${scripts} gzip bytes exceeds 2 MiB`);
  assert.ok(styles <= 32 * 1024, `all CSS: ${styles} gzip bytes exceeds 32 KiB`);
});


test("every production font URL resolves to an emitted file", async () => {
  const { readdir } = await import("node:fs/promises");
  const client = new URL("dist/client/", root);
  const cssFiles = (await readdir(client, { recursive: true })).filter((file) => file.endsWith(".css"));
  let checked = 0;
  for (const file of cssFiles) {
    const css = await readFile(new URL(file, client), "utf8");
    for (const match of css.matchAll(/url\(["']?([^"')]+\.woff2(?:\?[^"')]*)?)["']?\)/g)) {
      const pathname = new URL(match[1], "http://localhost/" + file).pathname;
      await access(new URL(pathname.slice(1), client));
      checked++;
    }
  }
  assert.ok(checked >= 4, "font checks must exercise the real stylesheet");
});

test("the tags browsers only honour in <head> are in <head>", async () => {
  /*
   * This framework's metadata shim renders its tags inside the streamed part of the tree and relies
   * on React hoisting them. It does not happen from the root layout: title, description, keywords,
   * the Open Graph and Twitter sets, the icon and the web app manifest were all left in a
   * `<div hidden>` in the body, before and after hydration.
   *
   * The manifest is the one that costs something. A browser only honours `<link rel="manifest">` in
   * the head, so the controller could not be installed — which is the first step of the
   * offline-update case in the acceptance runbook. Nothing that unfurls a link could read a
   * description or find an image either.
   */
  const head = (html) => html.slice(html.indexOf("<head"), html.indexOf("</head>"));
  const body = (html) => html.slice(html.indexOf("<body"));

  const home = await (await render("/")).text();
  for (const tag of [/<title>/, /<meta name="description"/, /<link rel="manifest"/, /<meta property="og:image"/]) {
    assert.match(head(home), tag, `missing from <head>: ${tag}`);
  }
  assert.doesNotMatch(body(home), /<meta name="description"/, "description was stranded in the body again");
  assert.doesNotMatch(body(home), /<link rel="manifest"/, "manifest was stranded in the body again");
});

test("each route carries exactly one title, and the controller keeps its own manifest", async () => {
  /*
   * A <title> in the root layout won out at runtime over the page's, so the controller tab read
   * "101 — Anything can be a controller" instead of "101 Link". Titles are per route; the root
   * layout does not set one.
   *
   * The controller declares its own manifest because it installs as its own app. Both links reach
   * the head on that route and the browser takes the first, so the order is load-bearing — which is
   * exactly why it is asserted rather than assumed.
   */
  const head = (html) => html.slice(html.indexOf("<head"), html.indexOf("</head>"));

  for (const [path, expected] of [
    ["/", "101 — Anything can be a controller"],
    ["/controller?session=T", "101 Link — Browser controller"],
    ["/games/bodydodge", "BodyDodge 101"],
    ["/studio", "101 Studio — Build and test controllers"],
  ]) {
    const titles = [...head(await (await render(path)).text()).matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]);
    assert.equal(titles.length, 1, `${path} has ${titles.length} titles: ${titles.join(" | ")}`);
    assert.equal(titles[0], expected, `${path} title`);
  }

  const controller = head(await (await render("/controller?session=T")).text());
  const manifests = [...controller.matchAll(/<link rel="manifest" href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(manifests[0], "/link.webmanifest", `the controller must install as itself, not the site: ${manifests.join(" | ")}`);
});
