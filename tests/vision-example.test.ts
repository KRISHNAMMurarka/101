import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runVisionExample, visionFixtureModels } from '../examples/device-pipelines/vision.ts';

test('independent vision caller preserves metric points and scoped calibration/gesture loss', () => {
  const result = runVisionExample();
  assert.equal(result.kind, 'producer-fixtures-only');
  assert.equal(result.projectedPose!.length, 33); assert.equal(result.projectedHand!.landmarks.length, 21);
  assert.equal(result.poseCalibrating.status, 'calibrating'); assert.equal(result.poseNeutral.status, 'valid');
  assert.ok(result.poseMoved.signals.axes.bodyX > .3);
  assert.equal(result.poseMoved.signals.landmarks[11]!.world!.x, result.projectedPose![11]!.world!.x);
  assert.equal(result.poseLost.status, 'unavailable'); assert.equal(result.poseRestarted.status, 'calibrating');
  assert.equal(result.handSettling.signals.gestures.openPalm, false);
  assert.equal(result.handStable.signals.gestures.openPalm, true);
  assert.equal(result.handStable.timing.capture.at, 1000);
  assert.equal(result.handLost.status, 'unavailable'); assert.equal(result.handRestarted.signals.gestures.openPalm, false);
  assert.ok(Object.values(result.handLost.signals.gestures).every(v => !v));
});

test('fixture model provenance identifies the exact committed upstream inference assets', () => {
  for (const [name, path] of [['pose', '../public/models/pose_landmarker_lite.task'], ['hand', '../public/models/hand_landmarker.task']] as const) {
    const bytes = readFileSync(new URL(path, import.meta.url)), reference = visionFixtureModels[name];
    assert.equal(reference.byteLength, bytes.length);
    assert.equal(reference.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
});
