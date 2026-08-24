import assert from "node:assert/strict";
import test from "node:test";
import type { InputVector } from "@101/input";
import type { GameContext, GameDefinition, GameInput } from "@101/sdk";
import { createBeatForgeGame } from "../games/beatforge/src/game.ts";
import { createBodyDodgeGame } from "../games/bodydodge/src/game.ts";
import { createEchoMazeGame } from "../games/echomaze/src/game.ts";
import { createGravityStackGame } from "../games/gravitystack/src/game.ts";
import { createOrbitalCrewGame } from "../games/orbitalcrew/src/game.ts";
import { createShadowArenaGame } from "../games/shadowarena/src/game.ts";
import { createSlashstormGame } from "../games/slashstorm/src/game.ts";
import { createSpellcasterGame } from "../games/spellcaster/src/game.ts";
import { createSwarmCommanderGame } from "../games/swarmcommander/src/game.ts";
import { createTiltDriftGame } from "../games/tiltdrift/src/game.ts";

const STEP = 1 / 60;
const FRAMES = 480;

simulate("Slashstorm supports two independent swords deterministically", () => createSlashstormGame("sim-slash"), (input, _state, frame) => {
  input.vector("aim", Math.sin(frame * .07) * .8, Math.cos(frame * .09) * .65, "player-1");
  input.action("trigger", true, "player-1");
  input.vector("aim", Math.cos(frame * .06) * .75, Math.sin(frame * .08) * .7, "player-2");
  input.action("trigger", true, "player-2");
}, (state) => {
  assert.equal(state.playerTwoActive, true);
  assert.ok(state.elapsed > 1);
  return pick(state, "score", "lives", "wave", "bestCombo", "playerTwoActive", "lastHit");
});

simulate("TiltDrift advances an infinite road under normalized steering", () => createTiltDriftGame("sim-drift"), (input, _state, frame) => {
  input.axis("steer", Math.sin(frame * .018) * .32);
  input.action("drift", frame % 180 > 105);
  input.action("boost", frame % 240 < 90);
}, (state) => {
  assert.ok(state.distance > 100);
  assert.ok(state.segments.length > 0);
  return pick(state, "distance", "score", "integrity", "boost", "environment", "gameOver");
});

test("TiltDrift scales acceleration, braking, and boost drain with analog pressure", () => {
  const step = (boost: number, brake: number) => {
    const game = createTiltDriftGame("analog-pressure");
    const input = new ScriptedInput();
    const state = game.initialState();
    const context: GameContext<typeof state> = { input, state, assets: { load: async () => {} } };
    game.start?.(context);
    input.action("boost", boost);
    input.action("brake", brake);
    game.update(context, .1);
    return { speed: state.speed, boost: state.boost };
  };

  const lightBoost = step(.1, 0);
  const fullBoost = step(1, 0);
  assert.ok(lightBoost.speed < fullBoost.speed, "a lightly squeezed trigger must accelerate less than a full squeeze");
  assert.ok(lightBoost.boost > fullBoost.boost, "boost energy drain must scale with trigger travel");

  const lightBrake = step(0, .1);
  const fullBrake = step(0, 1);
  assert.ok(lightBrake.speed > fullBrake.speed, "a light analog brake press must slow less than a full press");
});

simulate("BodyDodge accepts its Link movement panel and pose-equivalent actions", () => createBodyDodgeGame("sim-body"), (input, state) => {
  const next = state.gates.find((gate) => !gate.resolved)?.requirement ?? "center";
  const x = next === "left" || next === "lean-left" ? -1 : next === "right" || next === "lean-right" ? 1 : 0;
  input.vector("body.move", x, next === "duck" ? 1 : next === "jump" ? -1 : 0);
  input.action("duck", next === "duck");
  input.action("jump", next === "jump");
  input.action("armsRaised", next === "arms");
}, (state) => {
  assert.ok(state.distance > 80);
  assert.ok(state.gates.length > 0);
  return pick(state, "distance", "score", "combo", "integrity", "lastEvent", "gameOver");
});

simulate("Orbital Crew processes all five asymmetric Link roles", () => createOrbitalCrewGame("sim-orbit"), (input, state) => {
  const threat = state.events.find((event) => !event.resolved && event.startAt <= state.elapsed + STEP);
  const bearing = threat?.bearing ?? 0;
  input.vector("flight", Math.cos(bearing), Math.sin(bearing), "role-pilot");
  input.vector("target", Math.cos(bearing), Math.sin(bearing), "role-weapons");
  input.action("fire", true, "role-weapons");
  input.axis("shield", .35, "role-shields");
  input.action("fortify", true, "role-shields");
  input.axis("power", .8, "role-reactor");
  input.action("vent", state.heat > 55, "role-reactor");
  input.action("emergency", state.hull < 70, "role-emergency");
}, (state) => {
  assert.ok(state.elapsed > 5);
  assert.ok(state.score > 0);
  return pick(state, "sector", "score", "hull", "shields", "energy", "heat", "lastEvent");
});

simulate("BeatForge judges generated rhythm targets from the universal performer role", () => createBeatForgeGame("sim-beat"), (input, state) => {
  const nextTime = state.elapsed + STEP;
  for (const target of state.targets) {
    if (target.status === "pending" && Math.abs(target.targetSeconds - nextTime) < STEP * .55) input.action(`beat.${target.action}`, true, "role-performer");
  }
}, (state) => {
  assert.ok(state.judged > 0);
  assert.ok(state.score > 0);
  return pick(state, "score", "judged", "bestCombo", "health", "accuracy", "lastJudge");
});

simulate("GravityStack remains finite while physics, drops, and gravity controls run", () => createGravityStackGame("sim-gravity"), (input, _state, frame) => {
  input.vector("gravity", Math.sin(frame * .01) * .08, 1, "role-gravity");
  input.axis("placeX", Math.sin(frame * .04) * .55, "role-builder");
  input.action("drop", frame % 48 === 0, "role-builder");
}, (state) => {
  assert.equal(state.ready, true);
  assert.ok(state.pieces.length >= 5);
  return pick(state, "score", "towerHeight", "stability", "integrity", "lostPieces", "gameOver");
});

simulate("Spellcaster consumes semantic casts from its Link and fallback contract", () => createSpellcasterGame("sim-spell"), (input, state, frame) => {
  const target = state.enemies.find((enemy) => enemy.spawnAt <= state.elapsed + STEP && enemy.hitPoints > 0);
  input.vector("spell.aim", Math.cos(target?.angle ?? 0), Math.sin(target?.angle ?? 0), "role-sorcerer");
  const spells = ["projectile", "shield", "blade", "grab", "vortex", "charge"] as const;
  if (frame % 42 === 0) input.action(`spell.cast.${spells[Math.floor(frame / 42) % spells.length]}`, true, "role-sorcerer");
}, (state) => {
  assert.ok(state.castSequence > 0);
  assert.ok(state.wave > 0);
  return pick(state, "score", "wave", "health", "mana", "castSequence", "impactSequence", "lastCast");
});

simulate("Echo Maze runs local scanner controls over a deterministic floor", () => createEchoMazeGame("sim-echo"), (input, _state, frame) => {
  input.vector("maze.scanDirection", Math.sin(frame * .025), -Math.cos(frame * .025), "role-scanner");
  input.action("maze.scan", frame % 75 === 0, "role-scanner");
  input.action("maze.flashlight", frame === 180 || frame === 300, "role-scanner");
}, (state) => {
  assert.ok(state.scanSequence > 0);
  assert.ok(state.elapsed > 5);
  return pick(state, "floorNumber", "score", "health", "battery", "scanSequence", "flashlight", "lastEvent");
});

simulate("Shadow Arena handles movement, defense, and combat action edges", () => createShadowArenaGame("sim-shadow"), (input, state, frame) => {
  const enemy = state.enemies.find((candidate) => candidate.spawnAt <= state.elapsed + STEP && candidate.hitPoints > 0);
  const direction = enemy ? Math.sign(enemy.x - state.playerX) : 0;
  input.vector("combat.move", direction, 0, "role-fighter");
  input.action("combat.block", true, "role-fighter");
  if (frame % 24 === 0) input.action(direction < 0 ? "combat.punchLeft" : "combat.punchRight", true, "role-fighter");
  if (frame % 210 === 0) input.action("combat.special", true, "role-fighter");
}, (state) => {
  assert.ok(state.actionSequence > 0);
  assert.ok(state.round > 0);
  return pick(state, "score", "round", "health", "focus", "combo", "actionSequence", "lastAction");
});

simulate("Swarm Commander updates 100+ agents through both asymmetric roles", () => createSwarmCommanderGame("sim-swarm"), (input, _state, frame) => {
  input.vector("swarm.direction", Math.cos(frame * .012) * .65, Math.sin(frame * .015) * .55, "role-navigator");
  input.vector("swarm.command", Math.sin(frame * .008) * .6, Math.cos(frame * .01) * .55, "role-tactician");
  if (frame % 180 === 0) input.action("swarm.ability.shield", true, "role-navigator");
  if (frame % 150 === 0) input.action("swarm.ability.pulse", true, "role-tactician");
  if (frame === 120) input.action("swarm.formation.wedge", true, "role-tactician");
  if (frame === 300) input.action("swarm.select", true, "role-tactician");
}, (state) => {
  assert.ok(state.agents.length >= 100);
  assert.ok(state.actionSequence > 0);
  return pick(state, "wave", "score", "energy", "formation", "selected", "actionSequence", "impactSequence", "gameOver");
});

function simulate<State>(
  name: string,
  create: () => GameDefinition<State>,
  drive: (input: ScriptedInput, state: State, frame: number) => void,
  verify: (state: State) => unknown,
) {
  test(name, async () => {
    const first = await run(create(), drive, verify);
    const second = await run(create(), drive, verify);
    assert.deepEqual(second, first, "same seed and input script must reconstruct the same result");
  });
}

async function run<State>(game: GameDefinition<State>, drive: (input: ScriptedInput, state: State, frame: number) => void, verify: (state: State) => unknown) {
  const scripted = new ScriptedInput();
  const context: GameContext<State> = { input: scripted, state: game.initialState(), assets: { load: async () => {} } };
  await game.preload?.(context);
  game.start?.(context);
  try {
    for (let frame = 0; frame < FRAMES; frame += 1) {
      scripted.beginFrame();
      drive(scripted, context.state, frame);
      game.update(context, STEP);
      assertFiniteState(context.state);
    }
    return verify(context.state);
  } finally {
    game.stop?.(context);
  }
}

class ScriptedInput implements GameInput {
  private readonly actions = new Map<string, boolean | number>();
  private readonly axes = new Map<string, number>();
  private readonly vectors = new Map<string, InputVector>();

  bind() {}
  beginFrame() { for (const control of this.actions.keys()) this.actions.set(control, false); }
  action(name: string, valueOrPlayer: boolean | number | string = "player-1", playerId = "player-1"): boolean | number {
    if (typeof valueOrPlayer === "string") return this.actions.get(key(valueOrPlayer, name)) ?? false;
    this.actions.set(key(playerId, name), valueOrPlayer);
    return valueOrPlayer;
  }
  axis(name: string, valueOrPlayer: number | string = "player-1", playerId = "player-1"): number {
    if (typeof valueOrPlayer === "string") return this.axes.get(key(valueOrPlayer, name)) ?? 0;
    this.axes.set(key(playerId, name), valueOrPlayer);
    return valueOrPlayer;
  }
  vector(name: string, xOrPlayer: number | string = "player-1", y = 0, playerId = "player-1"): InputVector {
    if (typeof xOrPlayer === "string") return this.vectors.get(key(xOrPlayer, name)) ?? { x: 0, y: 0 };
    const value = { x: xOrPlayer, y };
    this.vectors.set(key(playerId, name), value);
    return value;
  }
  pose() { return undefined; }
}

function key(playerId: string, control: string) { return `${playerId}\u0000${control}`; }

function assertFiniteState(value: unknown, path = "state", seen = new WeakSet<object>()) {
  if (typeof value === "number") assert.ok(Number.isFinite(value), `${path} must be finite`);
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => assertFiniteState(entry, `${path}[${index}]`, seen));
  else if (Object.getPrototypeOf(value) === Object.prototype) for (const [name, entry] of Object.entries(value)) assertFiniteState(entry, `${path}.${name}`, seen);
}

function pick<State extends object, Key extends keyof State>(state: State, ...keys: Key[]) {
  return Object.fromEntries(keys.map((name) => [name, state[name]]));
}
