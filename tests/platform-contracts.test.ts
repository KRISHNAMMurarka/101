import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
