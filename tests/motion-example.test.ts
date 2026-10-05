import assert from 'node:assert/strict';
import test from 'node:test';
import { runMotionExample } from '../examples/device-pipelines/motion.ts';

test('independent motion caller projects actual producer field orders, units and conservative capture age', () => {
  const result = runMotionExample();
  assert.equal(result.kind, 'producer-fixtures-only');
  assert.equal(result.measurements.length, 5);
  assert.equal(new Set(result.measurements.map(sample => sample.deviceFrame)).size, 5);
  for (const measurement of result.measurements) {
    assert.equal(measurement.acceleration[0], 4.903325);
    assert.equal(measurement.acceleration[1], -9.80665);
    assert.equal(measurement.angularVelocity[0], Math.PI / 4);
    assert.equal(measurement.angularVelocity[1], -Math.PI / 2);
    assert.equal(measurement.angularVelocity[2], Math.PI);
    assert.equal(measurement.timing.capture.at, 1240);
  }
  assert.ok(Math.abs(result.calibrated.orientation[3] - 1) < 1e-12);
  assert.equal(result.calibrated.referenceFrame, 'browser:neutral');
  assert.equal(result.smoothed.acceleration[0], 2.4516625);
  assert.equal(result.smoothed.timing.capture.at, 1240);
  assert.equal(result.restarted.acceleration[0], 0);
  assert.equal(result.restarted.timing.capture.at, 1260);
});
