import assert from "node:assert/strict";
import test from "node:test";
import type { ControllerLayout } from "@101/protocol";
import { ControllerInputModel } from "./index.ts";

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
