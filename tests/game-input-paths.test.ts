import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { KeyboardAdapter } from "@101/adapter-keyboard";
import { InputBus } from "@101/input";
import type { GameDefinition } from "@101/sdk";
import { createBodyDodgeGame } from "../games/bodydodge/src/game.ts";
import { createShadowArenaGame } from "../games/shadowarena/src/game.ts";
import { createBeatForgeGame } from "../games/beatforge/src/game.ts";
import { createSpellcasterGame } from "../games/spellcaster/src/game.ts";
import { createSwarmCommanderGame } from "../games/swarmcommander/src/game.ts";

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
