import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { GamepadAdapter } from "@101/adapter-gamepad";
import { canTravel, shortestPath } from "@101/maze";
import { createEchoMazeGame } from "../games/echomaze/src/game.ts";
import { ECHO_MAZE_ROLES } from "../games/echomaze/src/roles.ts";
import { BEATFORGE_ROLES } from "../games/beatforge/src/roles.ts";
import { InputBus } from "@101/input";
import type { GameDefinition } from "@101/sdk";
import { createBodyDodgeGame } from "../games/bodydodge/src/game.ts";
import { createShadowArenaGame } from "../games/shadowarena/src/game.ts";
import { createBeatForgeGame } from "../games/beatforge/src/game.ts";
import { createSpellcasterGame } from "../games/spellcaster/src/game.ts";
import { createSwarmCommanderGame } from "../games/swarmcommander/src/game.ts";
import { createSlashstormGame } from "../games/slashstorm/src/game.ts";
import { SLASHSTORM_ROLES } from "../games/slashstorm/src/roles.ts";
import { GameControllerInput } from "../app/components/game-controller-input.ts";

async function keyboardGame<State>(t: TestContext, game: GameDefinition<State>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const window = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  const input = new InputBus(); const keyboard = new KeyboardAdapter();
  const state = game.initialState(); const context = { state, input, assets: { load: async () => undefined } };
  await input.register(keyboard); game.start?.(context);
  t.after(async () => {
    try { game.stop?.(context); await input.destroy(); }
    finally { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); }
  });
  const key = (type: "keydown" | "keyup", code: string) => window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code }));
  return { state, input, down: (code: string) => key("keydown", code), up: (code: string) => key("keyup", code), blur: () => window.dispatchEvent(new Event("blur")), step: (delta = .05) => game.update(context, delta) };
}

test("keyboard events reach BodyDodge movement and release when the window blurs", async (t) => {
  const run = await keyboardGame(t, createBodyDodgeGame("keys-body"));
  run.down("KeyD"); run.step(.1);
  assert.ok(run.state.playerX > .5);
  assert.equal(run.state.players[1]!.active, false, "solo keyboard play does not invent a teammate");
  run.blur(); run.step(.2);
  assert.equal(run.state.playerX, 0);
  assert.equal(run.input.axis("dodgeX"), 0);
});

test("keyboard punches reach ShadowArena damage once per press", async (t) => {
  const run = await keyboardGame(t, createShadowArenaGame("keys-shadow"));
  const enemy = run.state.enemies[0]!; enemy.spawnAt = 0; enemy.x = 1; enemy.hitPoints = 6;
  run.state.enemies = [enemy];
  run.down("KeyK"); run.step();
  assert.ok(enemy.hitPoints < 6);
  assert.equal(run.state.actionSequence, 1);
  run.step(); assert.equal(run.state.actionSequence, 1);
  run.up("KeyK"); run.step(); run.down("KeyK"); run.step();
  assert.equal(run.state.actionSequence, 2);
});

test("a keyboard press judges a real generated BeatForge chart target", async (t) => {
  const run = await keyboardGame(t, createBeatForgeGame("keys-beat"));
  const target = run.state.targets[0]!;
  const keys = { left: "ArrowLeft", right: "ArrowRight", punch: "Space", raise: "KeyE", duck: "ArrowDown" };
  run.state.elapsed = target.targetSeconds - .05;
  run.down(keys[target.action]); run.step();
  assert.equal(target.status, "perfect");
  assert.equal(run.state.judged, 1);
  assert.ok(run.state.score > 0);
});

test("keyboard shield casts reach Spellcaster and holding the key does not recast", async (t) => {
  const run = await keyboardGame(t, createSpellcasterGame("keys-spell"));
  run.down("KeyQ"); run.step();
  assert.equal(run.state.lastCast, "shield");
  assert.equal(run.state.castSequence, 1);
  assert.ok(run.state.shieldUntil > run.state.elapsed);
  run.step(); assert.equal(run.state.castSequence, 1);
  run.up("KeyQ"); run.step(); run.down("KeyQ"); run.step();
  assert.equal(run.state.castSequence, 2);
});

test("keyboard formation and pulse controls affect the real SwarmCommander simulation", async (t) => {
  const run = await keyboardGame(t, createSwarmCommanderGame("keys-swarm"));
  run.down("Digit4"); run.step();
  assert.equal(run.state.formation, "ring");
  run.up("Digit4"); run.down("KeyQ"); run.step();
  assert.ok(run.state.effects.some((effect) => effect.kind === "pulse"));
  assert.ok(run.state.pulseReadyAt > run.state.elapsed);
  assert.ok(run.state.energy < 100);
});


test("Slashstorm keyboard pause freezes generated targets until a fresh press resumes", async (t) => {
  const run = await keyboardGame(t, createSlashstormGame("keys-slash-pause"));
  for (let tick = 0; tick < 10; tick++) run.step(.1);
  assert.ok(run.state.targets.length > 0, "the real director has generated targets");
  const elapsed = run.state.elapsed;
  run.down("Escape"); run.step(.1);
  assert.equal(run.state.elapsed, elapsed, "the declared Pause action must freeze game time");
  assert.equal(run.state.paused, true);
  const frozen = JSON.stringify({ targets: run.state.targets, particles: run.state.particles, score: run.state.score, lives: run.state.lives });
  for (let tick = 0; tick < 20; tick++) { run.down("Escape"); run.step(.1); }
  assert.equal(run.state.paused, true, "held/repeated Escape is one pause press");
  assert.equal(run.state.elapsed, elapsed);
  assert.equal(JSON.stringify({ targets: run.state.targets, particles: run.state.particles, score: run.state.score, lives: run.state.lives }), frozen);
  run.up("Escape"); run.down("ArrowRight"); run.down("Space"); run.step(.1);
  run.blur(); run.step(.1);
  assert.equal(run.input.action("slash"), false, "blur releases slashing while paused");
  assert.deepEqual(run.input.vector("aim"), { x: 0, y: 0 });
  run.down("Escape"); run.step(.1);
  assert.equal(run.state.paused, false);
  assert.equal(run.state.elapsed, elapsed + .1, "paused wall time is not added on resume");
  assert.equal(run.state.bladeOneSlashing, false);
  assert.equal(run.state.trail.length, 0, "resume does not connect an old blade stroke");
});

test("either Slashstorm sword controller can pause and resume through its declared local input", async (t) => {
  for (const role of SLASHSTORM_ROLES) {
    const game = createSlashstormGame("local-pause-" + role.id);
    const input = new InputBus(), state = game.initialState();
    const context = { input, state, assets: { load: async () => undefined } };
    game.start?.(context);
    const controller = new GameControllerInput(input, role, "pause-" + role.id);
    controller.start();
    t.after(async () => { controller.stop(); await input.destroy(); });
    game.update(context, .1); const elapsed = state.elapsed;
    controller.setAction("pause", true); game.update(context, .1);
    assert.equal(state.elapsed, elapsed, role.id + " must reach the declared pause action");
    assert.equal(state.paused, true);
    controller.release(); game.update(context, .1);
    assert.equal(state.paused, true, "releasing the button keeps the run paused");
    controller.setAction("pause", true); game.update(context, .1);
    assert.equal(state.paused, false);
    assert.equal(state.elapsed, elapsed + .1);
    controller.stop();
  }
});

test("EchoMaze keyboard marks one place per press and can remove a mark", async (t) => {
  const run = await keyboardGame(t, createEchoMazeGame("keys-echo-mark"));
  const here = `${run.state.player.x},${run.state.player.y}`;
  run.down("KeyM"); run.step();
  assert.deepEqual(run.state.marked, [here], "the required Mark action must affect the real game");
  for (let index = 0; index < 5; index++) { run.down("KeyM"); run.step(.1); }
  assert.deepEqual(run.state.marked, [here], "holding Mark does not toggle every frame");
  const direction = (["north", "east", "south", "west"] as const).find(value => canTravel(run.state.floor, run.state.player, value));
  assert.ok(direction);
  const key = { north: "ArrowUp", east: "ArrowRight", south: "ArrowDown", west: "ArrowLeft" }[direction];
  run.down(key); run.step(.2); run.up(key);
  const next = `${run.state.player.x},${run.state.player.y}`;
  assert.notEqual(next, here);
  assert.deepEqual(run.state.marked, [here], "walking with Mark held cannot create extra marks");
  run.up("KeyM"); run.step(); run.down("KeyM"); run.step();
  assert.deepEqual(new Set(run.state.marked), new Set([here, next]));
  run.blur(); run.step(); run.down("KeyM"); run.step();
  assert.deepEqual(run.state.marked, [here], "a fresh press removes only the current place");
});

test("EchoMaze scanner MARK consumes its actual local role action", async () => {
  const game = createEchoMazeGame("role-echo-mark"), input = new InputBus();
  const context = { state: game.initialState(), input, assets: { load: async () => undefined } };
  const control = new GameControllerInput(input, ECHO_MAZE_ROLES[0]!, "owned-mark-controller");
  try {
    control.start(); game.start?.(context);
    control.setAction("maze.mark", true); game.update(context, .05);
    assert.deepEqual(context.state.marked, [`${context.state.player.x},${context.state.player.y}`]);
    control.release(); game.update(context, .05);
    control.setAction("maze.mark", true); game.update(context, .05);
    assert.deepEqual(context.state.marked, []);
  } finally { control.stop(); game.stop?.(context); await input.destroy(); }
});

test("BeatForge keyboard swing activates its held direction without a second direction press", async (t) => {
  const run = await keyboardGame(t, createBeatForgeGame("keys-beat-swing"));
  const target = run.state.targets.find(value => (value.action === "left" || value.action === "right") && value.status === "pending");
  assert.ok(target, "use an actual director-generated directional target");
  run.down(target.action === "left" ? "KeyA" : "KeyD"); run.step(0);
  run.state.elapsed = target.targetSeconds;
  run.down("KeyG"); run.step(0);
  assert.equal(target.status, "perfect", "the new explicit swing must consume the held gesture direction");
  const judged = run.state.judged;
  run.down("KeyG"); run.step(0);
  assert.equal(run.state.judged, judged, "one held activation cannot swing repeatedly");
});

test("BeatForge gesture pad activates through its declared pressAction", async () => {
  const game = createBeatForgeGame("role-beat-swing"), input = new InputBus();
  const role = BEATFORGE_ROLES[0]!, context = { state: game.initialState(), input, assets: { load: async () => undefined } };
  const surface = role.layout.layout.find(value => value.type === "touch-surface" && value.action === "gesture");
  assert.ok(surface && surface.type === "touch-surface");
  const control = new GameControllerInput(input, role, "owned-swing-controller");
  try {
    control.start(); game.start?.(context);
    const target = context.state.targets.find(value => (value.action === "left" || value.action === "right") && value.status === "pending");
    assert.ok(target);
    context.state.elapsed = target.targetSeconds;
    // Match the actual DynamicControllerDeck atomic surface producer contract.
    if (surface.pressAction) control.setSurface(surface.action, surface.pressAction, target.action === "left" ? -1 : 1, 0, true);
    else control.setVector(surface.action, target.action === "left" ? -1 : 1, 0);
    game.update(context, 0);
    assert.equal(target.status, "perfect", "a conventional gesture pad must have an activation path");
  } finally { control.stop(); game.stop?.(context); await input.destroy(); }
});


test("BeatForge standard gamepad trigger swings in the held stick direction", async () => {
  const saved = new Map(["navigator", "requestAnimationFrame", "cancelAnimationFrame"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
  const pad = { id: "Owned standard pad", index: 0, mapping: "standard", connected: true, timestamp: 1,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), hapticActuators: [] };
  Object.defineProperties(globalThis, {
    navigator: { configurable: true, value: { getGamepads: () => [pad] } },
    requestAnimationFrame: { configurable: true, value: (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; } },
    cancelAnimationFrame: { configurable: true, value: (id: number) => frames.delete(id) },
  });
  const game = createBeatForgeGame("pad-beat-swing"), input = new InputBus();
  const context = { state: game.initialState(), input, assets: { load: async () => undefined } };
  const poll = () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(performance.now()); };
  try {
    await input.register(new GamepadAdapter()); game.start?.(context);
    const target = context.state.targets.find(value => (value.action === "left" || value.action === "right") && value.status === "pending");
    assert.ok(target);
    pad.axes[0] = target.action === "left" ? -1 : 1; poll(); game.update(context, 0);
    context.state.elapsed = target.targetSeconds;
    pad.buttons[7] = { pressed: true, touched: true, value: 1 }; poll(); game.update(context, 0);
    assert.equal(target.status, "perfect");
    const judged = context.state.judged;
    poll(); game.update(context, 0); assert.equal(context.state.judged, judged);
  } finally {
    try { game.stop?.(context); await input.destroy(); assert.equal(frames.size, 0); }
    finally { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } }
  }
});

test("EchoMaze clears old floor marks without repeating a held Mark on the new floor", async (t) => {
  const run = await keyboardGame(t, createEchoMazeGame("keys-echo-mark-floor"));
  run.down("KeyM"); run.step();
  assert.deepEqual(run.state.marked, [`${run.state.player.x},${run.state.player.y}`]);
  const walk = (destination: { x: number; y: number }) => {
    const path = shortestPath(run.state.floor, run.state.player, destination);
    for (const point of path.slice(1)) {
      const dx = point.x - run.state.player.x, dy = point.y - run.state.player.y;
      const key = dx > 0 ? "ArrowRight" : dx < 0 ? "ArrowLeft" : dy > 0 ? "ArrowDown" : "ArrowUp";
      run.down(key); run.step(.18); run.up(key); run.step(0);
    }
  };
  for (const fragment of run.state.floor.fragments) walk(fragment);
  walk(run.state.floor.exit);
  assert.equal(run.state.floorNumber, 2, "actual navigation collected fragments and reached the exit");
  assert.deepEqual(run.state.marked, [], "floor-local marks do not survive or repeat from a held button");
  run.up("KeyM"); run.step(); run.down("KeyM"); run.step();
  assert.deepEqual(run.state.marked, [`${run.state.player.x},${run.state.player.y}`]);
});
