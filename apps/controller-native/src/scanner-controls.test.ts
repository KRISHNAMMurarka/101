import assert from "node:assert/strict";
import test from "node:test";

import { pinchDistance, zoomFromPinch } from "./scanner-controls.ts";

test("pinch distance uses both touch positions", () => {
  assert.equal(pinchDistance([{ pageX: 0, pageY: 0 }, { pageX: 30, pageY: 40 }]), 50);
  assert.equal(pinchDistance([{ pageX: 0, pageY: 0 }]), undefined);
});

test("pinching smoothly changes zoom and stays inside the camera range", () => {
  assert.equal(zoomFromPinch(0, 100, 160), 0.2);
  assert.equal(zoomFromPinch(0.4, 100, 40), 0.2);
  assert.equal(zoomFromPinch(0, 100, 0), 0);
  assert.equal(zoomFromPinch(0.9, 100, 200), 1);
});
