import assert from "node:assert/strict";
import test from "node:test";

import { NEUTRAL_FACE, readExpression, readOrientation } from "./face.ts";

const shape = (categoryName: string, score: number) => ({ categoryName, score });

test("expressions are read from the movements a game asks about", () => {
  const expression = readExpression([
    shape("eyeBlinkLeft", 0.9), shape("eyeBlinkRight", 0.85),
    shape("jawOpen", 0.6), shape("mouthSmileLeft", 0.4), shape("mouthSmileRight", 0.6),
    shape("browInnerUp", 0.3), shape("browOuterUpLeft", 0.5), shape("browOuterUpRight", 0.4),
  ]);

  assert.equal(expression.blinkLeft, 0.9);
  assert.equal(expression.mouthOpen, 0.6);
  // Multi-shape signals average rather than sum, so every signal stays 0-1 and a game can treat
  // them all the same way.
  assert.equal(expression.smile, 0.5);
  assert.ok(Math.abs(expression.browRaise - 0.4) < 1e-9);
});

test("a wink is not a blink", () => {
  // One eye closed hard, the other open. Taking either eye — or an average — would report a blink,
  // which is a different gesture and would fire whenever someone winked or their hair fell over one
  // eye. Both eyes have to agree.
  const wink = readExpression([shape("eyeBlinkLeft", 0.95), shape("eyeBlinkRight", 0.02)]);
  assert.equal(wink.blinkLeft, 0.95);
  assert.equal(wink.blink, 0.02, "one closed eye must not read as a blink");

  const blink = readExpression([shape("eyeBlinkLeft", 0.91), shape("eyeBlinkRight", 0.88)]);
  assert.equal(blink.blink, 0.88);
});

test("a signal the model did not report reads as no movement, not as missing", () => {
  const empty = readExpression([]);
  assert.deepEqual(empty, NEUTRAL_FACE);
  // A partial frame must not leave a signal undefined — a game multiplying by it would get NaN.
  for (const value of Object.values(readExpression([shape("jawOpen", 0.5)]))) {
    assert.equal(Number.isFinite(value), true);
  }
});

test("head orientation survives looking straight up", () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const level = readOrientation(identity)!;
  assert.ok(Math.abs(level.yaw) < 1e-9 && Math.abs(level.pitch) < 1e-9 && Math.abs(level.roll) < 1e-9);

  // Gimbal lock: at ±90° pitch, yaw and roll stop being separable and the usual formula reads noise.
  // The guard must still return a finite answer rather than NaN.
  const straightUp = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1];
  const locked = readOrientation(straightUp)!;
  assert.equal(Number.isFinite(locked.yaw), true);
  assert.ok(Math.abs(Math.abs(locked.pitch) - Math.PI / 2) < 1e-6);
  assert.equal(locked.roll, 0);

  assert.equal(readOrientation([1, 0, 0]), undefined, "a short matrix is not an orientation");
});
