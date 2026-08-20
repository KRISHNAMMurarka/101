import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseInputManifest, resolveInputManifest, type InputManifest, type InputSource } from "@101/input";
import { ControllerInputModel } from "@101/link-controller";
import { parseControllerLayout } from "@101/protocol";
import type { SessionRole } from "@101/session";
import { parseGameManifest, type GameManifest } from "@101/sdk";
import { BEATFORGE_ROLES } from "../games/beatforge/src/roles.ts";
import { BODYDODGE_ROLES } from "../games/bodydodge/src/roles.ts";
import { ECHO_MAZE_ROLES } from "../games/echomaze/src/roles.ts";
import { GRAVITYSTACK_ROLES } from "../games/gravitystack/src/roles.ts";
import { ORBITAL_CREW_ROLES } from "../games/orbitalcrew/src/roles.ts";
import { SHADOW_ARENA_ROLES } from "../games/shadowarena/src/roles.ts";
import { SLASHSTORM_ROLES } from "../games/slashstorm/src/roles.ts";
import { SPELLCASTER_ROLES } from "../games/spellcaster/src/roles.ts";
import { SWARM_COMMANDER_ROLES } from "../games/swarmcommander/src/roles.ts";
import { TILTDRIFT_ROLES } from "../games/tiltdrift/src/roles.ts";

const GAME_IDS = ["slashstorm", "tiltdrift", "bodydodge", "orbitalcrew", "beatforge", "gravitystack", "spellcaster", "echomaze", "shadowarena", "swarmcommander"] as const;
type GameId = typeof GAME_IDS[number];

const rolesByGame: Record<GameId, readonly SessionRole[]> = {
  slashstorm: SLASHSTORM_ROLES,
  tiltdrift: TILTDRIFT_ROLES,
  bodydodge: BODYDODGE_ROLES,
  orbitalcrew: ORBITAL_CREW_ROLES,
  beatforge: BEATFORGE_ROLES,
  gravitystack: GRAVITYSTACK_ROLES,
  spellcaster: SPELLCASTER_ROLES,
  echomaze: ECHO_MAZE_ROLES,
  shadowarena: SHADOW_ARENA_ROLES,
  swarmcommander: SWARM_COMMANDER_ROLES,
};

test("all ten games publish honest playable, local, procedural manifests and fallback inputs", () => {
  for (const gameId of GAME_IDS) {
    const manifest = parseGameManifest(json<GameManifest>(gameId, "manifest.json"));
    const input = parseInputManifest(json<InputManifest>(gameId, "input.manifest.json"));
    assert.equal(manifest.id, gameId);
    assert.equal(input.game, gameId);
    assert.equal(manifest.status, "playable", `${gameId} must be marked playable`);
    assert.equal(manifest.offline, true, `${gameId} must run offline once installed`);
    assert.equal(manifest.procedural, true, `${gameId} must use its seeded director`);
    assert.ok(manifest.controllers?.basic.length, `${gameId} needs conventional fallback controls`);
    assert.equal(manifest.inputs.includes("watch-motion"), false, `${gameId} cannot advertise the unfinished watch adapter`);
    assert.ok(manifest.players.max >= rolesByGame[gameId].length, `${gameId} player limit must cover every simultaneous Link role`);
    const resolution = resolveInputManifest(input, [...manifest.inputs, "custom"] as InputSource[]);
    assert.deepEqual(resolution.missing, [], `${gameId} manifest contains controls with no shipped source`);
  }
});

test("every Link role has a valid JSON controller layout backed by its game's semantic input contract", () => {
  const model = new ControllerInputModel();
  for (const gameId of GAME_IDS) {
    const manifest = json<InputManifest>(gameId, "input.manifest.json");
    const actions = new Set(Object.keys(manifest.actions ?? {}));
    const analog = new Set([...Object.keys(manifest.axes ?? {}), ...Object.keys(manifest.vectors ?? {})]);
    const roleIds = new Set<string>();
    const playerIds = new Set<string>();
    for (const role of rolesByGame[gameId]) {
      assert.equal(roleIds.has(role.id), false, `${gameId} repeats role ${role.id}`);
      assert.equal(playerIds.has(role.playerId), false, `${gameId} repeats player input channel ${role.playerId}`);
      roleIds.add(role.id);
      playerIds.add(role.playerId);
      const layout = parseControllerLayout(role.layout);
      const transition = model.transition(layout);
      assertNeutral(transition.release);
      for (const element of layout.layout) {
        const declared = element.type === "button" ? actions.has(element.action) : analog.has(element.action);
        assert.equal(declared, true, `${gameId}/${role.id} uses undeclared ${element.type} control ${element.action}`);
      }
      if (layout.motion) {
        assert.equal(analog.has(layout.motion.action), true, `${gameId}/${role.id} uses undeclared motion control ${layout.motion.action}`);
        for (const action of Object.values(layout.motion.gestures ?? {})) assert.equal(action ? actions.has(action) : true, true, `${gameId}/${role.id} maps an undeclared motion gesture`);
      }
    }
  }
});

test("game modules remain isolated from browser devices, transports, and permission APIs", () => {
  const forbidden = /navigator\.|getGamepads|DeviceMotionEvent|DeviceOrientationEvent|BroadcastChannel|WebSocket|RTCPeerConnection|getUserMedia|requestPermission/;
  for (const gameId of GAME_IDS) {
    const source = readFileSync(resolve("games", gameId, "src", "game.ts"), "utf8");
    assert.equal(forbidden.test(source), false, `${gameId} bypasses the 101 Input Bus or session boundary`);
  }
});

function json<Value>(gameId: GameId, filename: string): Value {
  return JSON.parse(readFileSync(resolve("games", gameId, filename), "utf8")) as Value;
}

function assertNeutral(snapshot: ReturnType<ControllerInputModel["snapshot"]>) {
  for (const value of Object.values(snapshot.actions)) assert.equal(Boolean(value), false);
  for (const value of Object.values(snapshot.axes)) assert.equal(value, 0);
  for (const value of Object.values(snapshot.vectors)) assert.deepEqual(value, { x: 0, y: 0 });
}

test("the launcher never statically imports a playable surface", () => {
  // Static imports made every game a hard dependency of the launcher's own chunk, so opening the
  // library downloaded all ten — 2.8 MB across 36 preloaded chunks, including a 1.6 MB physics
  // engine — before a single card rendered. Measured after this became lazy: 462 KB and zero game
  // chunks, and the cost stops growing with the catalog, which is the whole point at a thousand
  // games. One accidental `import GameX from "./components/GameX"` silently restores the old cost,
  // and nothing else in the suite would notice.
  const source = readFileSync(resolve(import.meta.dirname, "../app/Launcher.tsx"), "utf8");

  const staticSurface = /^import\s+\w+\s+from\s+"\.\/components\/(\w*Game|InputLab)"/m.exec(source);
  assert.equal(staticSurface, null,
    `playable surfaces must load with lazy(), found: ${staticSurface?.[0] ?? ""}`);

  // Every surface the view union can reach must have a lazy entry, or navigating renders nothing.
  const views = /type View =([^;]+);/.exec(source)?.[1] ?? "";
  const inline = new Set(["library", "system"]);
  const surfaces = new Set([...source.matchAll(/^\s{2}(\w+): lazy\(/gm)].map((match) => match[1]));
  for (const view of [...views.matchAll(/"([a-z]+)"/g)].map((match) => match[1]!)) {
    if (inline.has(view)) continue;
    assert.ok(surfaces.has(view), `view "${view}" has no lazy surface registered`);
  }
});

test("every game runs through the SDK, and the SDK resolves its input manifest", () => {
  // Three layers shipped with no callers at all: `resolveInputManifest` was reachable only from
  // tests, `defineGamePackage` from nothing, and `GameHost101` from nothing — while all ten game
  // components hand-assembled an Engine101, a LocalSession and a SessionHost themselves. Ten copies
  // of the same twenty lines, free to drift, and they had: seven status bars claimed a gamepad that
  // was not plugged in.
  //
  // The path a third-party developer is told to build on must be the path this app uses, or it is
  // documentation rather than a product.
  const hook = readFileSync(resolve(import.meta.dirname, "../app/lib/use-game-host.ts"), "utf8");
  assert.match(hook, /new GameHost101\(/, "the hook must run games through the real host");
  assert.match(hook, /onInputReadiness/, "readiness must come from the host, not a parallel copy");

  const host = readFileSync(resolve(import.meta.dirname, "../packages/game-host/src/index.ts"), "utf8");
  assert.match(host, /resolveInputManifest\(/, "the host is what resolves a game's declared needs");
  assert.match(host, /sessionSources\(/, "paired devices must count, or a phone is invisible");

  const components = readdirSync(resolve(import.meta.dirname, "../app/components"))
    .filter((file) => file.endsWith("Game.tsx"));
  assert.equal(components.length, 10, "all ten games must be present");

  for (const file of components) {
    const source = readFileSync(resolve(import.meta.dirname, `../app/components/${file}`), "utf8");
    assert.match(source, /useGameHost</, `${file} must run through the shared host`);
    assert.match(source, /defineGamePackage\(/, `${file} must build a validated game package`);
    assert.match(source, /input\.manifest\.json/, `${file} must declare its real input manifest`);

    // The duplication this replaced. Any of these coming back means a component is wiring its own
    // host again, which is how the copies drifted apart the first time.
    for (const banned of ["new SessionHost(", "new Engine101(", "new LocalSession("]) {
      assert.ok(!source.includes(banned), `${file} must not hand-roll ${banned}…) any more`);
    }
  }
});

test("a registered adapter is not the same claim as an available one", () => {
  // GamepadAdapter is registered on every game start and polls happily with nothing plugged in.
  // Counting registration as availability told games their `gamepad` requirement was satisfied on
  // machines with no controller, which is exactly the kind of confident wrong answer that makes
  // capability matching worthless.
  const adapter = readFileSync(resolve(import.meta.dirname, "../packages/adapter-gamepad/src/index.ts"), "utf8");
  assert.match(adapter, /get available\(\)/, "the gamepad adapter must report real availability");
  assert.match(adapter, /this\.activeDeviceId !== undefined/);

  const bus = readFileSync(resolve(import.meta.dirname, "../packages/input/src/index.ts"), "utf8");
  assert.match(bus, /adapter\.available === false/, "availableSources must honour that report");
});

test("every shipped game is playable on a plain keyboard, and says so honestly", () => {
  // 101's promise is that anything can be a controller, not that you need something exotic to
  // start. A game whose required controls cannot be served by a bare laptop is either mis-declared
  // or genuinely unplayable for most people, and both are worth failing over.
  //
  // This caught a real one: bodydodge's `body` pose had `"fallback": []` and a description reading
  // "Optional flattened 33-point body pose". The prose said optional, the schema had no way to say
  // it, so resolution correctly called it required and reported the game blocked on a laptop. The
  // manifest now declares `optional: true` and states why.
  const keyboardOnly: InputSource[] = ["keyboard", "mouse"];
  const games = readdirSync(resolve(import.meta.dirname, "../games"));
  let checked = 0;

  for (const id of games) {
    let manifest: InputManifest;
    try {
      manifest = parseInputManifest(JSON.parse(
        readFileSync(resolve(import.meta.dirname, `../games/${id}/input.manifest.json`), "utf8"),
      ));
    } catch {
      continue;
    }
    checked += 1;
    const bare = resolveInputManifest(manifest, keyboardOnly);
    assert.equal(bare.playable, true,
      `${id} cannot be played on a keyboard: ${bare.blocking.join(", ")}`);

    // Pairing a phone must never make a game worse, and for these games it should remove every
    // fallback substitution — that is what makes "pair a phone" worth telling the player.
    const paired = resolveInputManifest(manifest, [...keyboardOnly, "touch", "phone-motion"]);
    assert.equal(paired.playable, true, `${id} regressed when a phone joined`);
    assert.ok(paired.degraded.length <= bare.degraded.length,
      `${id} reports more degraded controls with a phone than without`);
  }

  assert.equal(checked, 10, "all ten games must ship an input manifest");
});

test("the readiness notice names the device that would actually help", async () => {
  // A camera game and a steering game are both "degraded" on a bare laptop, but telling a camera
  // game's player to pair a phone is confidently wrong advice — worse than saying nothing. The
  // suggestion is derived from the recommended sources of the controls that did not resolve.
  const { describeReadiness } = await import("../app/lib/input-readiness.ts");

  const camera = describeReadiness({
    mappings: {}, missing: [], blocking: [], degraded: ["lean"], playable: true,
    wanted: ["camera-pose"],
  });
  assert.match(camera ?? "", /Enable the camera/);

  const motion = describeReadiness({
    mappings: {}, missing: [], blocking: [], degraded: ["steer"], playable: true,
    wanted: ["phone-motion"],
  });
  assert.match(motion ?? "", /Pair a phone/);

  // Nothing to improve means nothing to say. A permanent nudge is noise.
  const happy = describeReadiness({
    mappings: {}, missing: [], blocking: [], degraded: [], playable: true,
    wanted: [],
  });
  assert.equal(happy, null);

  // A blocked game still says what is wrong even when no device maps to the missing source.
  const blocked = describeReadiness({
    mappings: {}, missing: ["draw"], blocking: ["draw"], degraded: [], playable: false,
    wanted: ["custom"],
  });
  assert.match(blocked ?? "", /draw/);
});

test("defineGamePackage accepts every game it is the gate for", async () => {
  // This validation is what every third-party package passes through, so an over-strict rule here
  // refuses correct games rather than catching broken ones — a failure mode that only shows up
  // once something actually calls it.
  //
  // It did. Routing the app through its own SDK made TiltDrift throw "Controller role driver uses
  // undeclared steer". The game was right: it renders a `steer` wheel and reads
  // `input.axis("steer")`, and `ControllerInputModel.setVector` writes `axes[action] = vector.x`
  // beside `axes[actionX]`/`axes[actionY]`. The validator simply did not know a pad aliases to its
  // axis name, so it demanded a vector declaration the runtime never required.
  const { defineGamePackage } = await import("@101/sdk");
  const games = readdirSync(resolve(import.meta.dirname, "../games"));
  let checked = 0;

  for (const id of games) {
    const dir = resolve(import.meta.dirname, `../games/${id}`);
    // input-lab ships a manifest but no input manifest — it is a diagnostic surface, not a game.
    let manifest: unknown;
    let input: unknown;
    try {
      manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
      input = JSON.parse(readFileSync(resolve(dir, "input.manifest.json"), "utf8"));
    } catch {
      continue;
    }
    const roles = rolesByGame[id as keyof typeof rolesByGame] ?? [];
    checked += 1;

    // A stub definition rather than the real one: importing ten game modules would drag three.js,
    // Phaser and Rapier into a unit test, and only `game.id` takes part in this validation. What is
    // under test is the agreement between manifest, input manifest and controller roles.
    const game = { id, initialState: () => ({}), update: () => {} };

    assert.doesNotThrow(
      () => defineGamePackage({ manifest, input, controllers: roles, game }),
      `${id} must survive the validation its own launcher performs`,
    );
  }
  assert.equal(checked, 10, "all ten games must be validated");
});

test("pairing a phone does not claim vision a phone never sends", async () => {
  // 101 Link declares `camera: true` in its hello, honestly — it has a camera and scans pairing QR
  // codes with it. But it runs no pose, hand or face model and emits no `camera-*` frame; the vision
  // adapters live in @101/adapter-camera and only ever register host-side.
  //
  // Mapping that capability to camera-hand/camera-pose/camera-face meant pairing any phone told a
  // camera game its vision controls were served. BodyDodge would report itself fully playable, drop
  // its "Enable the camera" advice, and then ignore the player — a capability check that answers
  // confidently and wrongly is worse than no check, and this is the same defect as the phantom
  // gamepad in a different costume.
  const { capabilitySources, sessionSources } = await import("@101/session");

  const phone = { touch: true, accelerometer: true, gyroscope: true, magnetometer: true, camera: true, microphone: false, haptics: true };
  const sources = capabilitySources(phone);
  assert.deepEqual(sources, ["touch", "phone-motion"],
    "a phone offers what it sends, not what hardware it owns");
  for (const vision of ["camera-hand", "camera-pose", "camera-face"]) {
    assert.equal(sources.includes(vision as never), false, `${vision} must not come from a lens`);
  }

  // An accelerometer without a gyroscope gives tilt but cannot track a turn.
  assert.deepEqual(capabilitySources({ touch: true, accelerometer: true }), ["touch"]);

  // The player-facing consequence, end to end: BodyDodge needs camera-pose for its body controls,
  // and a paired phone must not silence the advice that would get them working.
  const manifest = parseInputManifest(JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../games/bodydodge/input.manifest.json"), "utf8"),
  ));
  const available = ["keyboard", "mouse", ...sessionSources([
    { id: "phone", label: "Phone", capabilities: phone, connectedAt: 0, lastSeenAt: 0 },
  ])] as InputSource[];

  const resolved = resolveInputManifest(manifest, available);
  assert.ok(resolved.wanted.includes("camera-pose"),
    "with a phone paired, the camera is still the thing worth asking for");
  assert.ok(resolved.degraded.length > 0,
    "body controls served by a keyboard are degraded, not satisfied");
});

test("a blocked game reads differently from a merely degraded one", () => {
  // `playable: false` means a required control has nothing to serve it: the game starts and then
  // ignores the player until they act. It deliberately does not refuse to launch — graceful
  // degradation is the platform's premise, and a launcher that refuses is worse than one that
  // explains — but it must not look identical to "playable now, and better with a phone".
  //
  // No shipped game can reach this state; a test above asserts all ten run on a bare keyboard. It
  // exists for third-party games, which is precisely why it needs a test rather than a look.
  const style = readFileSync(resolve(import.meta.dirname, "../app/globals.css"), "utf8");
  const blocked = /\.input-readiness\.blocked \{([^}]*)\}/.exec(style);
  assert.ok(blocked, "the blocked state must have its own style");

  // State is carried by weight and edge, never by hue: the scheme is monochrome, and a colour-only
  // signal is invisible to a colour-blind player anyway.
  assert.match(blocked[1]!, /border-width|font-weight/, "it must differ in weight");
  assert.doesNotMatch(blocked[1]!, /#[0-9a-f]{3,6}|rgb|hsl/i, "and must not introduce a colour");

  const components = readdirSync(resolve(import.meta.dirname, "../app/components"))
    .filter((file) => file.endsWith("Game.tsx"));
  for (const file of components) {
    const source = readFileSync(resolve(import.meta.dirname, `../app/components/${file}`), "utf8");
    assert.match(source, /playable === false \? " blocked" : ""/,
      `${file} must mark a blocked notice as blocked`);
  }
});
