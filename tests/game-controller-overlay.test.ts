import assert from "node:assert/strict";
import test from "node:test";
import { InputBus } from "@101/input";
import { GameControllerInput } from "../app/components/game-controller-input.ts";
import { BODYDODGE_ROLES } from "../games/bodydodge/src/roles.ts";
import { ORBITAL_CREW_ROLES } from "../games/orbitalcrew/src/roles.ts";
import { createBodyDodgeGame } from "../games/bodydodge/src/game.ts";

test("the screen deck controls the existing game's bus and simulation", () => {
  const bus = new InputBus(); const game = createBodyDodgeGame("screen-deck"); const state = game.initialState();
  const context = { state, input: bus, assets: { load: async () => undefined } };
  game.start?.(context);
  const deck = new GameControllerInput(bus, BODYDODGE_ROLES[0], "screen-panel");
  deck.start(); deck.setVector("body.move", 1, 0); deck.setAction("armsRaised", true);
  game.update(context, .1);
  assert.ok(state.playerX > .5);
  assert.equal(state.arms, 1);
  assert.equal(bus.connectedDevices()[0]!.source, "touch");
  deck.release(); game.update(context, .2);
  assert.equal(state.playerX, 0);
  assert.equal(state.arms, 0);
  deck.stop(); assert.equal(bus.connectedDevices().length, 0);
});

test("changing asymmetric roles releases only the local panel's previous role", () => {
  const bus = new InputBus();
  const pilot = ORBITAL_CREW_ROLES.find((role) => role.id === "pilot")!;
  const shields = ORBITAL_CREW_ROLES.find((role) => role.id === "shields")!;
  bus.accept({ deviceId: "keyboard", playerId: "player-1", source: "keyboard", sequence: 1, timestamp: 0, actions: { fire: true } });
  const first = new GameControllerInput(bus, pilot, "screen-panel");
  first.start(); first.setVector("flight", 1, -.5);
  assert.equal(bus.vector("flight", pilot.playerId).x, 1);
  first.stop();
  const second = new GameControllerInput(bus, shields, "screen-panel");
  second.start(); second.setAxis("shield", .7); second.setAction("fortify", true);
  assert.deepEqual(bus.vector("flight", pilot.playerId), { x: 0, y: 0 });
  assert.equal(bus.axis("shield", shields.playerId), .7);
  second.release();
  assert.equal(bus.action("fortify", shields.playerId), false);
  assert.equal(bus.axis("shield", shields.playerId), 0);
  assert.equal(bus.action("fire", "player-1"), true, "hiding a deck never resets unrelated devices");
  second.stop();
});

test("a late callback from hidden controls cannot revive held input on reopening", () => {
  const bus = new InputBus(); const deck = new GameControllerInput(bus, BODYDODGE_ROLES[0], "screen-panel");
  deck.start(); deck.setAction("jump", true); deck.stop();
  deck.setAction("jump", true); deck.setVector("body.move", 1, 1);
  assert.equal(bus.connectedDevices().length, 0);
  deck.start();
  assert.equal(bus.action("jump"), false);
  assert.deepEqual(bus.vector("body.move"), { x: 0, y: 0 });
  deck.stop();
});
