import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BrowserCameraAdapter } from "@101/adapter-camera";
import { InputBus } from "@101/input";
import type { GameDefinition } from "@101/sdk";
import type { PoseLandmark } from "@101/vision";
import { createBodyDodgeGame } from "../games/bodydodge/src/game.ts";
import { createShadowArenaGame } from "../games/shadowarena/src/game.ts";

function body(x: number): PoseLandmark[] {
  const pose = Array.from({ length: 33 }, () => ({ x, y: .5, z: 0, visibility: .98 }));
  for (const [index, dx, y] of [[0, 0, .12], [11, -.07, .3], [12, .07, .3], [15, -.09, .52], [16, .09, .52], [23, -.05, .58], [24, .05, .58], [25, -.05, .74], [26, .05, .74], [27, -.05, .94], [28, .05, .94]]) {
    pose[index!] = { x: x + dx!, y: y!, z: 0, visibility: .98 };
  }
  return pose.map((point, index) => ({ ...point, world: { x: point.x - x, y: point.y - .58, z: index % 2 ? -.05 : .05 } }));
}

function mockGlobal(name: string, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  return () => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); };
}

async function cameraGame<State>(t: TestContext, game: GameDefinition<State>) {
  class Track extends EventTarget { readyState = "live"; stop() { this.readyState = "ended"; } }
  const track = new Track();
  const cleanups: Array<() => void> = [];
  const callbacks = new Map<number, FrameRequestCallback>(); let handle = 0;
  let detections = [body(.25), body(.75)];
  const video = { readyState: 2, currentTime: 1, videoWidth: 1280, videoHeight: 720, srcObject: null, play: async () => undefined, pause: () => undefined } as unknown as HTMLVideoElement;
  cleanups.push(mockGlobal("navigator", { mediaDevices: { enumerateDevices: async () => [{ kind: "videoinput" }], getUserMedia: async () => ({ getTracks: () => [track] }) } }));
  cleanups.push(mockGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 }));
  cleanups.push(mockGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++handle, callback); return handle; }));
  cleanups.push(mockGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id)));
  const input = new InputBus(); const state = game.initialState(); const context = { state, input, assets: { load: async () => undefined } };
  game.start?.(context);
  const adapter = new BrowserCameraAdapter({ video, maxPeople: 2, mirror: false, classifier: { smoothing: 1, autoCalibrationFrames: 1, gestureCooldownMs: 80 }, backend: { initialize: async () => undefined, close: () => undefined, detect: () => detections } });
  await input.register(adapter);
  t.after(async () => { try { game.stop?.(context); await input.destroy(); } finally { cleanups.reverse().forEach((cleanup) => cleanup()); } });
  return {
    state, input, track,
    frame(poses: PoseLandmark[][], now: number, delta = .05) {
      detections = poses;
      const [id, callback] = callbacks.entries().next().value!;
      callbacks.delete(id); video.currentTime++; callback(now);
      game.update(context, delta);
    },
  };
}

test("two real-shaped camera detections independently drive BodyDodge and gate results", async (t) => {
  const run = await cameraGame(t, createBodyDodgeGame("camera-body"));
  run.frame([body(.25), body(.75)], 0);
  assert.equal(run.state.players.filter((player) => player.active).length, 2);
  run.frame([body(.82), body(.25)], 50, .2);
  assert.ok(run.state.players[1]!.playerX > .5, "player two's movement reaches their own game state");
  assert.equal(run.state.players[0]!.playerX, 0);
  const gate = run.state.gates[0]!; gate.requirement = "right"; gate.distance = run.state.distance + 1;
  const before = run.state.integrity;
  run.frame([body(.82), body(.25)], 100, .1);
  assert.equal(run.state.players[1]!.cleared, 1);
  assert.equal(run.state.players[0]!.missed, 1);
  assert.equal(run.state.integrity, before - 25);
  assert.ok(run.state.score >= 100);
  run.frame([body(.25)], 150);
  assert.equal(run.state.players[1]!.active, false);
  assert.equal(run.input.axis("dodgeX", "player-2"), 0);
  run.frame([body(.81), body(.25)], 200);
  assert.equal(run.state.players[1]!.slot, 2);
  assert.equal(run.state.players[1]!.active, true);
  assert.equal(run.state.players[1]!.cleared, 1);
});

test("camera player two can strike a ShadowArena enemy without moving player one", async (t) => {
  const run = await cameraGame(t, createShadowArenaGame("camera-shadow"));
  run.frame([body(.25), body(.75)], 0);
  assert.equal(run.state.players.filter((player) => player.active).length, 2);
  const second = run.state.players[1]!;
  const enemy = run.state.enemies[0]!;
  run.state.enemies = [enemy]; enemy.x = second.playerX + 1; enemy.spawnAt = 0; enemy.hitPoints = 5;
  const strike = body(.75); strike[16] = { ...strike[16]!, x: .99, y: .3 };
  run.frame([strike, body(.25)], 100);
  assert.ok(enemy.hitPoints < 5, "the second camera slot's punch affects a real enemy");
  assert.equal(run.state.players[0]!.lastAction, "READY");
  assert.equal(run.state.players[1]!.lastAction, "RIGHT PUNCH");
  run.frame([body(.25)], 150);
  assert.equal(second.active, false);
  assert.equal(run.input.action("combat.punchRight", "player-2"), false);
  run.track.dispatchEvent(new Event("ended"));
  assert.equal(run.input.action("combat.punchRight", "player-2"), false);
});

test("ShadowArena enemies use the second fighter's defense when targeting that fighter", async (t) => {
  const run = await cameraGame(t, createShadowArenaGame("camera-defense"));
  run.frame([body(.25), body(.75)], 0);
  const enemy = run.state.enemies[0]!;
  run.state.enemies = [enemy]; enemy.spawnAt = 0; enemy.x = run.state.players[1]!.playerX + 1;
  enemy.hitPoints = 5; enemy.attack = "heavy"; enemy.attackAt = 0; enemy.windup = .01;
  const guard = body(.75);
  guard[15] = { ...guard[15]!, x: .73, y: .32 };
  guard[16] = { ...guard[16]!, x: .77, y: .32 };
  run.frame([body(.25), guard], 100);
  assert.equal(enemy.targetSlot, 2);
  assert.equal(run.state.players[0]!.block, false);
  run.frame([body(.25), guard], 200);
  assert.equal(run.state.health, 100, "the teammate who is attacked can protect the team");
  assert.ok(run.state.effects.some((effect) => effect.kind === "block" && effect.x === run.state.players[1]!.playerX));
});
