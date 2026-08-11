import assert from "node:assert/strict";
import test from "node:test";
import {
  MotionGestureRecognizer,
  MotionPipeline,
  quaternionFromDeviceOrientation,
  quaternionToAngles,
  type MotionSample,
} from "./index.ts";

const sample = (timestamp: number, acceleration: readonly [number, number, number] = [0, 0, 0], angularVelocity: readonly [number, number, number] = [0, 0, 0]): MotionSample => ({
  timestamp,
  acceleration,
  angularVelocity,
  orientation: quaternionFromDeviceOrientation(0, 0, 30),
});

test("neutral calibration makes the held orientation zero", () => {
  const pipeline = new MotionPipeline({ neutral: [0, 0, 0, 1], sensitivity: 1, deadZone: 0, smoothing: 1 });
  const held = sample(0);
  pipeline.calibrateNeutral(held);
  const angles = quaternionToAngles(pipeline.process({ ...held, timestamp: 1 }).orientation);
  assert.ok(Math.abs(angles.pitch) < 1e-8);
  assert.ok(Math.abs(angles.roll) < 1e-8);
  assert.ok(Math.abs(angles.yaw) < 1e-8);
});

test("motion filtering applies sensitivity, dead zone, and smoothing", () => {
  const pipeline = new MotionPipeline({ neutral: [0, 0, 0, 1], sensitivity: 2, deadZone: 0.5, smoothing: 0.5 });
  assert.deepEqual(pipeline.process(sample(0, [0.1, 1, 0])).acceleration, [0, 2, 0]);
  assert.deepEqual(pipeline.process(sample(16, [1.1, 0, 0])).acceleration, [1.1, 1, 0]);
});

test("gesture recognition requires a shake reversal and swing hysteresis", () => {
  const gestures = new MotionGestureRecognizer({ cooldownMs: 100, swingAngularVelocity: 100, spinAngularVelocity: 250 });
  assert.equal(gestures.update(sample(0, [9, 0, 0])).shake, false);
  assert.equal(gestures.update(sample(40, [-9, 0, 0])).shake, true);
  assert.equal(gestures.update(sample(200, [0, 0, 0], [120, 0, 0])).swing, false);
  assert.equal(gestures.update(sample(216, [0, 0, 0], [130, 0, 0])).swing, true);
  assert.equal(gestures.update(sample(400, [0, 0, 0], [300, 0, 0])).spin, true);
});
