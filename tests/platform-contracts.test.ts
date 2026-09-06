import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

/**
 * Discovered, not listed.
 *
 * A game is a directory under games/ that declares an input manifest and is not a tool. Writing the
 * ids out by hand made adding a game an edit to this file — and the three `assert.equal(…, 10)`
 * counts below meant an eleventh game failed the suite in four places while the launcher rendered
 * it correctly.
 */
const GAMES_DIR = resolve(import.meta.dirname, "../games");
const GAME_IDS = readdirSync(GAMES_DIR).filter((id) => {
  if (!existsSync(resolve(GAMES_DIR, id, "input.manifest.json"))) return false;
  const manifest = JSON.parse(readFileSync(resolve(GAMES_DIR, id, "manifest.json"), "utf8"));
  return manifest.surface !== "tool";
}).sort();
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
    assert.ok(rolesByGame[gameId], `${gameId} has no controller roles registered in this test`);
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
        const actionElement = element.type === "button"
          || element.type === "shoulder"
          || element.type === "trigger"
          || element.type === "analog-button";
        const declared = actionElement ? actions.has(element.action) : analog.has(element.action);
        assert.equal(declared, true, `${gameId}/${role.id} uses undeclared ${element.type} control ${element.action}`);
        if ((element.type === "button" || element.type === "shoulder") && element.interaction?.type === "chord") {
          for (const action of element.interaction.actions) {
            assert.equal(actions.has(action), true, `${gameId}/${role.id} chord uses undeclared action ${action}`);
          }
        }
      }
      if (layout.motion) {
        assert.equal(analog.has(layout.motion.action), true, `${gameId}/${role.id} uses undeclared motion control ${layout.motion.action}`);
        for (const action of Object.values(layout.motion.gestures ?? {})) assert.equal(action ? actions.has(action) : true, true, `${gameId}/${role.id} maps an undeclared motion gesture`);
      }
    }
  }
});

test("a shipped role exercises the real-gamepad controller contract", () => {
  const driver = rolesByGame.tiltdrift[0]!;
  const layout = parseControllerLayout(driver.layout);
  assert.equal(layout.handedness, "right");
  assert.deepEqual(layout.layout.map((element) => element.type), ["joystick", "trigger", "analog-button", "shoulder"]);
  const stick = layout.layout[0];
  assert.equal(stick?.type, "joystick");
  if (stick?.type === "joystick") {
    assert.equal(stick.deadZone, .14);
    assert.equal(stick.responseCurve, 1.35);
    assert.equal(stick.side, "left");
    assert.equal(stick.zone, "thumb");
  }
});

test("browser controller speaker requires opt-in and never replays a late cue", async () => {
  const { BrowserControllerSpeaker } = await import("../app/controller/controller-speaker.ts");
  const registered: Array<{ id: string; options: unknown }> = [];
  const played: Array<{ id: string; options: unknown }> = [];
  let resumes = 0;
  let unloaded = false;
  const audio = {
    registerTone(id: string, options: unknown) { registered.push({ id, options }); },
    async resume() { resumes += 1; },
    play(id: string, options: unknown) { played.push({ id, options }); return 1; },
    unload() { unloaded = true; },
  };
  let visible = true;
  const speaker = new BrowserControllerSpeaker(audio, () => visible);
  const cue = (sequence: number, pitch = 1.4, volume = .35) => ({
    type: "speaker.cue" as const,
    deviceId: "phone",
    sequence,
    cue: "pulse-v1" as const,
    pitch,
    volume,
  });

  assert.equal(registered.length, 1, "the private cue must be synthesized locally, not fetched");
  assert.equal(speaker.state, "locked");
  assert.equal(speaker.receive(cue(2)), false, "autoplay policy must not be bypassed before a gesture");
  assert.deepEqual(played, []);

  assert.equal(await speaker.enable(), true);
  assert.equal(resumes, 1);
  assert.equal(speaker.state, "ready");
  assert.equal(speaker.receive(cue(1)), false, "a cue older than one discarded while locked must stay discarded");
  assert.equal(speaker.receive(cue(3)), true);
  assert.deepEqual(played, [{ id: "private-cue", options: { category: "sfx", rate: 1.4, volume: .35 } }]);
  assert.equal(speaker.receive(cue(3)), false, "duplicates must not turn packet jitter into a second sound");

  visible = false;
  assert.equal(speaker.state, "locked", "a hidden, visibility-muted controller must restore host fallback");
  assert.equal(speaker.receive(cue(4)), false, "hidden cues are disposable, not queued for a late replay");
  visible = true;
  assert.equal(speaker.state, "ready");
  assert.equal(speaker.receive(cue(5, .8, .2)), true);
  assert.deepEqual(played.at(-1), { id: "private-cue", options: { category: "sfx", rate: .8, volume: .2 } });

  speaker.dispose();
  assert.equal(unloaded, true);
});

test("the browser advertises opted-in speaker audio and Echo Maze keeps a host fallback", () => {
  const controller = readFileSync(resolve(import.meta.dirname, "../app/controller/Controller.tsx"), "utf8");
  const echoMaze = readFileSync(resolve(import.meta.dirname, "../app/components/EchoMazeGame.tsx"), "utf8");

  assert.match(controller, /speaker:\s*true/, "101 Link must advertise its physical speaker");
  assert.match(controller, /speakerAudio:\s*speakerAudioRef\.current/, "the handshake must distinguish locked audio from ready audio");
  assert.match(controller, /payload\.type === "speaker\.cue"/, "realtime controller cues need a browser caller");
  // The invariant is the gesture, not the wording: browsers will not start audio without one, and a
  // controller that claimed a speaker it could not use would have the host route private cues into
  // silence. Matched on the handler rather than the label, which is a player-facing string.
  assert.match(controller, /onClick=\{enableSpeaker\}/, "a visible user gesture must unlock audio on this device");
  assert.match(controller, /configurationRef\.current\s*===\s*configuration\)\s*\{[\s\S]*?publishSnapshot\(inputRef\.current!\.snapshot\(\)\)[\s\S]*?return/,
    "a repeated hello must refresh held browser input for a newly mounted host without releasing it");
  assert.match(echoMaze, /host\.playControllerCue\("scanner"/, "the private clue must call the host speaker API");
  assert.match(echoMaze, /if \(!controllerCue[^)]*&& audioEnabledRef\.current\) audio\.play\("ping"/, "the TV cue is the fallback, not an echo beside the phone");
  assert.ok(rolesByGame.echomaze[0]?.preferredCapabilities?.includes("speaker"),
    "when two phones are eligible, Echo Maze should prefer the one that can actually play its private cue");
});

test("browser Link retries a transient initial Hub join without requiring a reload", () => {
  const controller = readFileSync(resolve(import.meta.dirname, "../app/controller/Controller.tsx"), "utf8");

  assert.match(controller, /const connectTransport = async \(\) => \{[\s\S]*?await transport\.connect\(\)[\s\S]*?window\.setTimeout\(\(\) => void connectTransport\(\)/,
    "the mounted controller must call connect again after an initial signaling failure");
  assert.match(controller, /return \(\) => \{[\s\S]*?connectCancelled = true[\s\S]*?window\.clearTimeout\(connectRetryTimer\)/,
    "unmount must cancel the browser-owned retry before disconnecting its transport");
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
    // Matched against the discovered games, not a filename suffix: a component named PreGame.tsx
    // satisfied `endsWith("Game.tsx")` and was counted as an eleventh game.
    .filter((file) => GAME_IDS.some((id) => file.toLowerCase() === `${id}game.tsx`));
  assert.equal(components.length, GAME_IDS.length, "every game must have a launcher component");

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

  assert.equal(checked, GAME_IDS.length, "every game must ship an input manifest");
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
  assert.equal(checked, GAME_IDS.length, "every game must pass the validation its launcher performs");
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
    // Matched against the discovered games, not a filename suffix: a component named PreGame.tsx
    // satisfied `endsWith("Game.tsx")` and was counted as an eleventh game.
    .filter((file) => GAME_IDS.some((id) => file.toLowerCase() === `${id}game.tsx`));
  for (const file of components) {
    const source = readFileSync(resolve(import.meta.dirname, `../app/components/${file}`), "utf8");
    assert.match(source, /playable === false \? " blocked" : ""/,
      `${file} must mark a blocked notice as blocked`);
  }
});

test("the documented path is the path that runs", () => {
  // Three layers shipped with no production caller at all: resolveInputManifest was reachable only
  // from tests, defineGamePackage from nothing, GameHost101 from nothing. Each looked supported,
  // each was documented, and none of them ran — so the validation in defineGamePackage was wrong in
  // a way that would have rejected correct third-party games, and nobody could know.
  //
  // Writing the fix reproduced the mistake: `resolveGameInput` in app/lib went dead the moment every
  // game moved onto the SDK, and only a deliberate check found it. Every test in this suite passes
  // for code nothing calls, which is exactly why this one counts callers instead.
  const roots = ["app", "packages", "games", "tools", "worker"];
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx|mjs)$/.test(entry.name)) files.push(path);
    }
  };
  for (const root of roots) collect(resolve(import.meta.dirname, `../${root}`));

  // Each entry is a promise the platform makes to whoever builds on it. `definedIn` is excluded so
  // an export cannot count as its own caller.
  const promises = [
    { name: "GameHost101", definedIn: "packages/game-host/" },
    { name: "defineGamePackage", definedIn: "packages/sdk/" },
    { name: "resolveInputManifest", definedIn: "packages/input/" },
    // `sessionSources`, not `capabilitySources`: the host asks what a whole session offers, and the
    // per-device helper is the building block it is made from. That distinction is not cosmetic —
    // this test failed on its first run because `capabilitySources` has no caller outside its own
    // package, which is true and fine for a building block and would be damning for a promise.
    { name: "sessionSources", definedIn: "packages/session/" },
    { name: "useGameHost", definedIn: "app/lib/use-game-host" },
    { name: "describeReadiness", definedIn: "app/lib/input-readiness" },
    { name: "describeSources", definedIn: "app/lib/input-readiness" },
    { name: "AudioTimeline101", definedIn: "packages/audio/" },
    { name: "BeatCueLookahead", definedIn: "games/beatforge/src/cue-scheduler" },
  ];

  for (const { name, definedIn } of promises) {
    const callers = files.filter((path) => {
      if (path.split("/Desktop/games/101/")[1]?.startsWith(definedIn)) return false;
      return new RegExp(`\\b${name}\\b`).test(readFileSync(path, "utf8"));
    });
    assert.ok(callers.length > 0,
      `${name} has no production caller — it is documented but dead, which is how a wrong `
      + "validation survives review");
  }
});

test("the site is monochrome; the games are not", () => {
  // The owner's rule, verbatim: "my website and stuff must be monochrome etc not the game etc".
  //
  // So this checks the surfaces that frame the product — the stylesheet, the launcher, the
  // controller, the labs — and deliberately does NOT check what a game paints inside its own play
  // field. Game art is meant to be colourful and an earlier pass left it alone on purpose.
  //
  // The Input Lab and Vision Lab draw to a canvas but are diagnostics of the site rather than games,
  // so they are held to the site's rule. Where their colour carried meaning it was re-expressed:
  // landmark visibility became solid-versus-dim instead of green-versus-orange, and handedness became
  // white against mid grey. State by weight, never by hue — which also survives a colour-blind reader.
  const chrome = [
    "app/globals.css",
    "app/Launcher.tsx",
    "app/layout.tsx",
    "app/controller/Controller.tsx",
    "app/studio/controller/ControllerLab.tsx",
    "app/components/InputLab.tsx",
    "app/studio/vision/VisionLab.tsx",
  ];

  const tinted: string[] = [];
  for (const file of chrome) {
    const source = readFileSync(resolve(import.meta.dirname, `../${file}`), "utf8");

    for (const match of source.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(match[1]!.slice(i, i + 2), 16));
      if (!(r === g && g === b)) tinted.push(`${file}: ${match[0]}`);
    }
    for (const match of source.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
      const [r, g, b] = [1, 2, 3].map((i) => Number(match[i]));
      if (!(r === g && g === b)) tinted.push(`${file}: ${match[0]})`);
    }
  }

  assert.deepEqual(tinted, [], `site chrome must be black, white and greys between:\n  ${tinted.join("\n  ")}`);

  // The other half of the rule: the games must still have their colour. A monochrome sweep that
  // flattened the play field would satisfy the check above and break what the owner asked for.
  const art = readFileSync(resolve(import.meta.dirname, "../app/components/SlashstormGame.tsx"), "utf8");
  const artHues = [...art.matchAll(/#([0-9a-fA-F]{6})\b/g)].filter((m) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16));
    return !(r === g && g === b);
  });
  assert.ok(artHues.length > 0, "game art must keep its colour — the rule stops at the play field");
});

test("browser Link consumes the complete real-gamepad controller contract", () => {
  // Protocol support is not product support until the shipped browser controller calls it. This
  // guard exists because 101 has previously carried complete, tested SDK layers with no caller.
  const source = readFileSync(resolve(import.meta.dirname, "../app/controller/Controller.tsx"), "utf8");

  for (const elementType of ["shoulder", "trigger", "analog-button"] as const) {
    assert.match(source, new RegExp(`element\\.type === ["']${elementType}["']`),
      `browser Link must render ${elementType} controls`);
  }
  for (const behavior of [
    "ControllerActionGesture",
    "normalizeJoystick",
    "resolveControllerSide",
    "setActions",
  ] as const) {
    assert.match(source, new RegExp(`\\b${behavior}\\b`),
      `browser Link must call ${behavior} rather than leaving the shared behavior unused`);
  }
  for (const hint of ["side", "zone", "size", "span", "priority"] as const) {
    assert.match(source, new RegExp(`element\\.${hint}\\b`),
      `browser Link must consume the ${hint} placement hint`);
  }
  assert.match(source, /layout\.handedness/, "the author's handedness preference must reach the renderer");
  assert.match(source, /101-link-handedness/, "the player's handedness override must persist locally");
  assert.match(source, /setActions\(values, owner\)/,
    "digital controls need stable owners so releasing a chord cannot clear another held control");
  assert.match(source, /element\.side \?\? defaultControlSide\(element\)/,
    "legacy hint-less layouts must receive the same left/right inference as native Link");
});

test("the launcher calls catalog discovery and windows complete rows", () => {
  // A fast catalog helper with no production caller is still an eager thousand-card page. This
  // protects the shipped boundary: defer the player's query, filter through the resolved input
  // profiles, and render only the complete rows that intersect the viewport.
  const source = readFileSync(resolve(import.meta.dirname, "../app/Launcher.tsx"), "utf8");

  for (const helper of [
    "filterCatalog",
    "planCatalogWindow",
  ] as const) {
    assert.match(source, new RegExp(`\\b${helper}\\b`),
      `Launcher must call ${helper} rather than leaving catalog scaling in a test-only layer`);
  }

  /*
   * Was an assertion that the launcher used CATALOG_INPUT_PROFILES. Those four device profiles are
   * gone: measured against every shipped manifest with the real resolver, keyboard-only,
   * keyboard-mouse and gamepad-only each matched all ten games, so three of the control's four
   * settings filtered nothing. The filter now asks the one question a player has, which means the
   * launcher has to tell it what this device can actually do.
   */
  assert.match(source, /available:\s*localSources/,
    "the catalog filter must be given this device's real sources, or it cannot answer what is playable now");

  assert.match(source, /useDeferredValue\(/,
    "typing in catalog search must not synchronously rebuild the visible grid");
  assert.match(source, /new ResizeObserver\(/,
    "the window must recompute complete rows when the responsive grid changes columns");
  assert.match(source, /addEventListener\(["']scroll["'][^;]+passive:\s*true/s,
    "catalog scroll measurement must use a passive listener");
  assert.match(source, /requestAnimationFrame\(/,
    "scroll updates must be coalesced to one render per animation frame");
  assert.match(source, /aria-live=["']polite["']/,
    "search result changes need a polite live-region announcement");
  assert.match(source, /aria-setsize=/,
    "windowed cards must expose the full result-set size");
  assert.match(source, /aria-posinset=/,
    "windowed cards must expose their position within the full result set");
});

test("the catalog benchmark is a studio route, and the player home is not", () => {
  // The benchmark must still receive its synthetic count before the server render — client-only URL
  // expansion would keep hydration safe but could not measure a thousand-entry first paint honestly.
  const bench = readFileSync(resolve(import.meta.dirname, "../app/studio/catalog-bench/page.tsx"), "utf8");

  assert.match(bench, /searchParams/, "the benchmark route must inspect its server-side query parameters");
  assert.match(bench, /createSyntheticCatalog\(gameCatalog,\s*size\)/,
    "the server must generate the complete benchmark catalog before the client boundary");
  assert.match(bench, /<Launcher[^>]+benchmarkMode/s,
    "all benchmark manifests must reach Launcher before SSR and hydration");
  // createSyntheticCatalog throws for a non-integer or out-of-range count, so an unvalidated query
  // parameter is an uncaught server exception rather than a bad render.
  assert.match(bench, /Number\.isInteger/, "the count must be validated before it reaches the generator");
  assert.match(bench, /Math\.min\(Math\.max/, "the count must be clamped, not merely checked");
  assert.match(bench, /robots:\s*\{\s*index:\s*false/, "a benchmark harness must not be indexed");

  // The player's front door carries none of it.
  const home = readFileSync(resolve(import.meta.dirname, "../app/page.tsx"), "utf8");
  assert.doesNotMatch(home, /benchmarkMode|createSyntheticCatalog|searchParams/,
    "a benchmark harness must not be reachable by query parameter on the player's home page");
});

test("windowed catalog results remain reachable without scroll geometry guesses", () => {
  const launcher = readFileSync(resolve(import.meta.dirname, "../app/Launcher.tsx"), "utf8");
  const styles = readFileSync(resolve(import.meta.dirname, "../app/globals.css"), "utf8");

  assert.match(launcher, /planCatalogPage\(/,
    "keyboard paging must mount a deterministic result slice independent of scroll position");
  assert.match(launcher, /const renderWindow = requestedPage \?\? windowPlan/,
    "a requested keyboard page must override, then hand back to, the scroll-driven window");
  assert.match(launcher, /filteredCatalog\.slice\(renderWindow\.startIndex, renderWindow\.endIndex\)/,
    "the requested page boundaries must determine which production cards mount");
  assert.match(launcher, /aria-label=["']Previous result page["']/,
    "the previous-page control needs an explicit accessible name");
  assert.match(launcher, /aria-label=["']Next result page["']/,
    "the next-page control needs an explicit accessible name");
  assert.match(launcher, /pageFocusTargetRef\.current\?\.focus\(\{\s*preventScroll:\s*true\s*\}\)/,
    "paging must preserve a useful keyboard focus target after mounting the requested slice");
  assert.match(launcher, /addEventListener\(["']scroll["'],\s*releasePageFromScroll/,
    "scrollbar, assistive, and programmatic scrolling must release a locked keyboard page");
  assert.match(launcher, /const focusScrollTop = pageFocusScrollTopRef\.current;\s*if \([^;]+\) return;\s*pageFocusScrollTopRef\.current = null;/s,
    "duplicate scroll events at the focus target must not collapse the requested page");
  assert.match(launcher, /if \(!pageFocusScrollSettledRef\.current\) return;/,
    "layout scrolls caused by relocating the focused pager must settle before scroll handoff");
  assert.match(launcher, /pageFocusSettleFrameRef\.current = window\.requestAnimationFrame/,
    "the focus-scroll guard must be bounded by rendered frames rather than a guessed timeout");
  assert.match(launcher, /requestAnimationFrame\(\(\) => \{[\s\S]*requestAnimationFrame\(\(\) => \{\s*pageFocusScrollTopRef\.current = window\.scrollY;\s*pageFocusScrollSettledRef\.current = true;/,
    "the expected scroll position must be sampled after the browser applies scrollIntoView");
  assert.match(launcher, /scrollIntoView\(\{\s*behavior:\s*["']instant["']/,
    "the one focus-induced scroll must finish synchronously before scroll handoff is armed");
  const catalogMap = launcher.indexOf("{visibleCatalog.map");
  const pagerRenders = [...launcher.matchAll(/\{catalogPager\}/g)].map((match) => match.index);
  assert.deepEqual(pagerRenders.length, 1,
    "one pager should serve both pointer and keyboard navigation without duplicate controls");
  assert.ok((pagerRenders[0] ?? Number.MAX_SAFE_INTEGER) < catalogMap,
    "the pager must stay before the moving virtual window so pointer scrolling cannot chase it");
  const keyboardPagerRender = launcher.indexOf("{catalogKeyboardPager}");
  assert.ok(keyboardPagerRender > catalogMap,
    "a keyboard-only continuation must follow the mounted slice in DOM order");
  assert.match(launcher, /className=["']catalog-pager-forward["']/,
    "forward Tab must expose an actionable page control without moving the pointer pager");
  assert.match(launcher, /--catalog-spacer-height-1/);
  assert.match(launcher, /--catalog-spacer-height-2/);
  assert.match(launcher, /--catalog-spacer-height-3/);
  assert.match(styles, /height:\s*var\(--catalog-spacer-height\)/,
    "SSR spacer geometry must use a server-rendered height rather than client-only measurement");
  assert.match(styles, /\.catalog-spacer\s*\{[^}]*--catalog-spacer-height:\s*var\(--catalog-spacer-height-3\)/s,
    "the spacer must resolve its default height against variables declared on that same element");
  assert.match(styles, /\.catalog-spacer\s*\{[^}]*--catalog-spacer-height:\s*var\(--catalog-spacer-height-2\)/s,
    "the two-column breakpoint must select its server-rendered height");
  assert.match(styles, /\.catalog-spacer\s*\{[^}]*--catalog-spacer-height:\s*var\(--catalog-spacer-height-1\)/s,
    "the one-column breakpoint must select its server-rendered height");
  assert.match(styles, /\.catalog-game-card:focus-visible/,
    "the programmatically focused result needs a visible keyboard focus edge");
});

test("a browser cue that fails to sound hands the role's audio back to the television", async () => {
  // Advertising `speakerAudio: "ready"` makes the host stop playing this role's cues through the TV.
  // Audio101.play() is synchronous and returns an id long before the browser decides whether it can
  // actually sound, so a silent failure used to be unrecoverable: the player heard nothing from the
  // controller and nothing from the television, permanently. Native Link already demoted itself on a
  // rejected play; this is the browser's equivalent.
  const { BrowserControllerSpeaker } = await import("../app/controller/controller-speaker.ts");

  let failPlayback: ((id: string) => void) | undefined;
  const played: string[] = [];
  const audio = {
    registerTone() {},
    async resume() {},
    play(id: string) { played.push(id); return 1; },
    unload() {},
    onPlaybackError(listener: (id: string) => void) {
      failPlayback = listener;
      return () => { failPlayback = undefined; };
    },
  };

  let announcements = 0;
  const speaker = new BrowserControllerSpeaker(audio, () => true, () => { announcements += 1; });
  const cue = (sequence: number) => ({
    type: "speaker.cue" as const, deviceId: "phone", sequence,
    cue: "pulse-v1" as const, pitch: 1, volume: .5,
  });

  assert.equal(await speaker.enable(), true);
  assert.equal(speaker.receive(cue(1)), true, "a live speaker plays the cue");
  assert.equal(played.length, 1);

  // The browser reports, after the fact, that the sound never started.
  assert.ok(failPlayback, "the speaker must subscribe to playback failures");
  failPlayback("private-cue");

  assert.equal(speaker.state, "locked", "a failed cue must demote the speaker");
  assert.equal(announcements, 1, "and re-announce, so the host resumes television audio");
  assert.equal(speaker.receive(cue(2)), false, "no further cue is claimed while locked");
  assert.equal(played.length, 1, "and none reaches the audio engine");

  // Demotion is reported once, not on every subsequent failure, so the host is not spammed.
  failPlayback("private-cue");
  assert.equal(announcements, 1);
});

test("enabling browser audio does not claim readiness the engine can disprove", async () => {
  // Audio101.resume() returns immediately when there is no context to resume, so a non-throwing
  // resume was being read as success. Claiming readiness makes the host stop routing this role's
  // cues to the television, so a wrong claim costs the player every clue for that session.
  const { BrowserControllerSpeaker } = await import("../app/controller/controller-speaker.ts");
  const base = {
    registerTone() {}, async resume() {},
    play() { return 1; }, unload() {},
  };

  // A suspended Web Audio context is a definite no, and must be believed.
  const suspended = new BrowserControllerSpeaker({ ...base, outputReady: false }, () => true);
  assert.equal(await suspended.enable(), false, "a suspended context must not be reported ready");
  assert.equal(suspended.state, "locked");

  // A running context is a definite yes.
  const running = new BrowserControllerSpeaker({ ...base, outputReady: true }, () => true);
  assert.equal(await running.enable(), true);
  assert.equal(running.state, "ready");

  // Howler's HTML5 fallback cannot answer in advance. Refusing there would disable private audio on
  // browsers where it works, so we proceed — and the playback-error path demotes us if it does not.
  const unknown = new BrowserControllerSpeaker({ ...base, outputReady: undefined }, () => true);
  assert.equal(await unknown.enable(), true, "an unknowable engine must not block private audio");
  assert.equal(unknown.state, "ready");
});

test("both renderers share one ordering rule, and it puts controls where the hand expects", async () => {
  // This was a regex over both renderers' source, asserting their duplicated comparators looked
  // alike. They had already drifted once — the browser sorted by priority alone while native sorted
  // by zone first, so a shoulder button sat above the thumbs on a phone and below them in a browser,
  // one layout producing two different gamepads.
  //
  // The rule now lives in @101/protocol and both renderers call it, so they cannot disagree by
  // construction. That also makes it directly testable: `node --experimental-strip-types` cannot
  // import a .tsx file at all, which is the real reason the controller tests were regexes.
  const { orderControllerElements, controllerZoneRank } = await import("@101/protocol");

  const element = (action: string, zone?: string, priority?: number) => ({
    type: "button" as const, action, label: action.toUpperCase(),
    ...(zone ? { zone: zone as never } : {}),
    ...(priority === undefined ? {} : { priority }),
  });

  // Zone outranks priority: a shoulder leads even when a thumb control asks to come first.
  const ordered = orderControllerElements(
    [element("aim", "thumb", 99), element("fire", "shoulder"), element("menu", "edge")],
    (item) => item,
  );
  assert.deepEqual(ordered.map((item) => item.action), ["fire", "menu", "aim"]);

  // Within a zone, higher priority leads.
  const byPriority = orderControllerElements(
    [element("low", "thumb", 10), element("high", "thumb", 90)],
    (item) => item,
  );
  assert.deepEqual(byPriority.map((item) => item.action), ["high", "low"]);

  // An unzoned control ranks with an edge control, so adding a zone to one element never reshuffles
  // the ones around it.
  assert.equal(controllerZoneRank(undefined), controllerZoneRank("edge"));
  assert.ok(controllerZoneRank("shoulder") < controllerZoneRank("thumb"));

  // Declaration order breaks a genuine tie, so a layout stays stable across renders.
  const stable = orderControllerElements([element("first"), element("second")], (item) => item);
  assert.deepEqual(stable.map((item) => item.action), ["first", "second"]);

  // And both renderers must actually call it rather than keeping a private copy.
  for (const file of ["../app/controller/Controller.tsx", "../apps/controller-native/src/controls.tsx"]) {
    const source = readFileSync(resolve(import.meta.dirname, file), "utf8");
    assert.match(source, /orderControllerElements\(/, `${file} must use the shared rule`);
    assert.equal(/function zoneRank\(/.test(source), false, `${file} must not keep its own copy`);
  }
});

test("the catalog ships no field it can derive or does not read", async () => {
  // The whole catalog is serialised across the server-to-client boundary on every page load, so a
  // field nobody reads is paid for per entry, per visit. Two were: `searchText`, 28% of an entry and
  // derivable from `id`/`name`/`tagline`/`inputs` which the entry already carries, and the full
  // `controllers` arrays — 120 bytes — to answer the two yes/no questions a card actually asks.
  //
  // Measured across the change: the homepage went 50,083 to 30,232 bytes, and the thousand-entry
  // benchmark route 864,336 to 478,962.
  const { createLauncherCatalogEntry, buildCatalogSearchIndex, filterCatalog } =
    await import("../app/lib/catalog.ts");
  const { parseGameManifest } = await import("@101/sdk");
  const { parseInputManifest } = await import("@101/input");

  const manifest = parseGameManifest(JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../games/slashstorm/manifest.json"), "utf8")));
  const input = parseInputManifest(JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../games/slashstorm/input.manifest.json"), "utf8")));
  const entry = createLauncherCatalogEntry(manifest, input);

  for (const derived of ["searchText", "controllers", "version", "engine", "offline", "procedural", "accent"]) {
    assert.equal(derived in entry, false, `${derived} must not cross the boundary`);
  }
  // The two questions a card asks, answered as booleans rather than as arrays.
  assert.equal(entry.enhanced, Boolean(manifest.controllers?.enhanced?.length));
  assert.equal(entry.immersive, Boolean(manifest.controllers?.immersive?.length));

  // Search still works without the shipped text, whether or not an index is supplied.
  const withIndex = filterCatalog([entry], { query: "slash", searchIndex: buildCatalogSearchIndex([entry]) });
  const withoutIndex = filterCatalog([entry], { query: "slash" });
  assert.equal(withIndex.length, 1, "an indexed search must still match");
  assert.equal(withoutIndex.length, 1, "and so must one that derives the text per entry");
  assert.equal(filterCatalog([entry], { query: "zzzznotagame" }).length, 0);
});

/**
 * The gate is structural, not a convention.
 *
 * A game runs because its component mounts: `useGameHost` calls `host.launch()` from a `useEffect`
 * with no condition in it. So the only way to show a player a game before starting it is to not
 * mount it — which is why the chooser and the game are two routes rather than one route with a flag.
 * Rendered HTML cannot see the third assertion here, because FullscreenToggle returns null on the
 * server.
 */
test("a game's own page offers it, and a separate route runs it", () => {
  for (const id of GAME_IDS) {
    const chooser = readFileSync(resolve(import.meta.dirname, `../app/games/${id}/page.tsx`), "utf8");
    assert.match(chooser, /<PreGame\b/, `${id}'s page must offer the game, not mount it`);
    assert.doesNotMatch(chooser, /<\w+Standalone\b/, `${id}'s page mounts the game, so it starts on arrival`);
    assert.ok(
      existsSync(resolve(import.meta.dirname, `../app/games/${id}/play/page.tsx`)),
      `${id} has no play route, so its game runs at no address`,
    );
  }

  // Full screen belongs where there is a game to fill the screen with, which is no longer the page
  // a player lands on from the library.
  const shell = readFileSync(resolve(import.meta.dirname, "../app/components/AppShell.tsx"), "utf8");
  assert.match(shell, /endsWith\("\/play"\)[^\n]*FullscreenToggle|FullscreenToggle[\s\S]{0,80}endsWith\("\/play"\)/,
    "the fullscreen control must be offered on the running game, not on the chooser");
});
