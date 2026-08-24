import assert from "node:assert/strict";
import test from "node:test";
import type { ControllerLayout } from "@101/protocol";
import {
  ControllerActionGesture,
  ControllerInputModel,
  normalizeJoystick,
  resolveControllerSide,
} from "./index.ts";

const sword: ControllerLayout = {
  motion: { action: "aim", mode: "wand", gestures: { swing: "slash" } },
  layout: [
    { type: "touch-surface", action: "aim" },
    { type: "button", action: "trigger", label: "SLASH" },
  ],
};

test("normalizes controller vectors and their conventional axis aliases", () => {
  const model = new ControllerInputModel({ layout: [{ type: "dpad", action: "move" }] });
  const snapshot = model.setVector("move", 4, -.4);
  assert.deepEqual(snapshot.vectors.move, { x: 1, y: -.4 });
  assert.equal(snapshot.axes.moveX, 1);
  assert.equal(snapshot.axes.moveY, -.4);
});

test("role transitions release every old control before initializing the new panel", () => {
  const model = new ControllerInputModel(sword);
  model.setAction("trigger", true);
  model.setAction("slash", true);
  model.setVector("aim", .8, -.6);

  const transition = model.transition({
    layout: [
      { type: "slider", action: "power", label: "POWER", min: .2, max: 1 },
      { type: "button", action: "vent", label: "VENT" },
    ],
  });

  assert.equal(transition.release.actions.trigger, false);
  assert.equal(transition.release.actions.slash, false);
  assert.deepEqual(transition.release.vectors.aim, { x: 0, y: 0 });
  assert.deepEqual(transition.current.actions, { vent: false });
  assert.equal(transition.current.axes.power, .6);
  assert.equal("trigger" in transition.current.actions, false);
  assert.equal("aim" in transition.current.vectors, false);
});

test("disconnect release clears held inputs in the local model", () => {
  const model = new ControllerInputModel(sword);
  model.setAction("trigger", true);
  model.setVector("aim", .5, .25);
  const release = model.releaseAll();
  assert.equal(release.actions.trigger, false);
  assert.deepEqual(release.vectors.aim, { x: 0, y: 0 });
  assert.equal(model.snapshot().actions.trigger, false);
  assert.deepEqual(model.snapshot().vectors.aim, { x: 0, y: 0 });
});

test("joysticks use a radial dead zone and clamp diagonals to cardinal speed", () => {
  assert.deepEqual(normalizeJoystick(.08, -.06, .12, 1), { x: 0, y: 0 });

  const cardinal = normalizeJoystick(1, 0, 0, 1);
  const diagonal = normalizeJoystick(1, 1, 0, 1);
  assert.ok(Math.abs(Math.hypot(cardinal.x, cardinal.y) - 1) < 1e-12);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-12,
    "a diagonal must not move 1.41 times faster than a cardinal");
  assert.ok(Math.abs(diagonal.x - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(diagonal.y - Math.SQRT1_2) < 1e-12);

  const curved = normalizeJoystick(.5, 0, 0, 2);
  assert.ok(Math.abs(curved.x - .25) < 1e-12, "responseCurve is a radial exponent");
});

test("handedness mirrors advisory left and right placement without moving centered controls", () => {
  assert.equal(resolveControllerSide("left", "right", "right"), "left");
  assert.equal(resolveControllerSide("left", "right", "left"), "right");
  assert.equal(resolveControllerSide("right", "right", "left"), "left");
  assert.equal(resolveControllerSide("center", "right", "left"), "center");
  assert.equal(resolveControllerSide(undefined, "right", "left"), "center");
});

test("button semantics emit hold, double-tap, toggle, and chord actions at the controller", () => {
  const emitted: Array<Record<string, boolean | number>> = [];
  let now = 1_000;
  let hold: (() => void) | undefined;
  const options = {
    emit: (values: Record<string, boolean | number>) => emitted.push(values),
    now: () => now,
    schedule: (callback: () => void) => { hold = callback; return 1; },
    cancelSchedule: () => { hold = undefined; },
  };

  const held = new ControllerActionGesture({
    type: "button", action: "charge", label: "CHARGE",
    interaction: { type: "hold", thresholdMs: 450 },
  }, options);
  held.press();
  assert.deepEqual(emitted, [], "a hold is not active merely because a finger went down");
  hold?.();
  assert.deepEqual(emitted.pop(), { charge: true });
  held.release();
  assert.deepEqual(emitted.pop(), { charge: false });

  const doubleTap = new ControllerActionGesture({
    type: "shoulder", action: "dodge", label: "DODGE",
    interaction: { type: "double-tap", intervalMs: 300 },
  }, options);
  doubleTap.press();
  doubleTap.release();
  assert.deepEqual(emitted, [], "the first tap arms the gesture without firing it");
  now += 200;
  doubleTap.press();
  assert.deepEqual(emitted.pop(), { dodge: true });
  doubleTap.release();
  assert.deepEqual(emitted.pop(), { dodge: false });

  const toggle = new ControllerActionGesture({
    type: "button", action: "shield", label: "SHIELD",
    interaction: { type: "toggle" },
  }, options);
  toggle.press();
  toggle.release();
  assert.deepEqual(emitted.pop(), { shield: true });
  toggle.press();
  toggle.release();
  assert.deepEqual(emitted.pop(), { shield: false });

  const chord = new ControllerActionGesture({
    type: "button", action: "special", label: "SPECIAL",
    interaction: { type: "chord", actions: ["guard", "focus"] },
  }, options);
  chord.press();
  assert.deepEqual(emitted.pop(), { special: true, guard: true, focus: true });
  chord.release();
  assert.deepEqual(emitted.pop(), { special: false, guard: false, focus: false });
});

test("analog action kinds initialize and release as numbers while chords are atomic", () => {
  const model = new ControllerInputModel({
    layout: [
      { type: "trigger", action: "throttle", label: "RT", side: "right", zone: "index" },
      { type: "analog-button", action: "brake", label: "BRAKE" },
      {
        type: "button", action: "special", label: "SPECIAL",
        interaction: { type: "chord", actions: ["guard", "focus"] },
      },
    ],
  });
  assert.deepEqual(model.snapshot().actions, {
    throttle: 0,
    brake: 0,
    special: false,
    guard: false,
    focus: false,
  });

  const pressed = model.setActions({ special: true, guard: true, focus: true });
  assert.equal(pressed.actions.special, true);
  assert.equal(pressed.actions.guard, true);
  assert.equal(pressed.actions.focus, true);
  model.setAction("throttle", .72);
  const release = model.releaseAll();
  assert.equal(release.actions.throttle, 0);
  assert.equal(release.actions.special, false);
});

test("a chord release does not cancel the same action held by another physical control", () => {
  const model = new ControllerInputModel({
    layout: [
      { type: "shoulder", action: "guard", label: "LB" },
      {
        type: "button", action: "special", label: "X",
        interaction: { type: "chord", actions: ["guard", "focus"] },
      },
    ],
  });

  model.setActions({ guard: true }, "shoulder-guard");
  model.setActions({ special: true, guard: true, focus: true }, "button-special");
  model.setActions({ special: false, guard: false, focus: false }, "button-special");
  assert.equal(model.snapshot().actions.guard, true, "LB remains held after X releases its chord contribution");

  model.setActions({ guard: false }, "shoulder-guard");
  assert.equal(model.snapshot().actions.guard, false);
});

test("analog controller actions are normalized at the input model boundary", () => {
  const model = new ControllerInputModel({
    layout: [
      { type: "trigger", action: "throttle", label: "RT" },
      { type: "analog-button", action: "brake", label: "BRAKE" },
    ],
  });

  assert.equal(model.setAction("throttle", 4).actions.throttle, 1);
  assert.equal(model.setAction("brake", -.5).actions.brake, 0);
  assert.equal(model.setAction("brake", .35).actions.brake, .35);
});
