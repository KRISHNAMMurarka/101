import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMotionUnitProcessor, createMotionCalibrationProcessor, createMotionSmoothingProcessor,
  parseMotionMeasurement, type MotionMeasurement,
} from './index.ts';

const identity = { id: 'test:motion', version: '1.0.0', configurationRevision: 1 };
const processed = (at: number) => ({ clockId: 'sensor', at });
function frame(at: number, acceleration: readonly number[] = [0, 0, 0]) {
  return { orientation: [0, 0, 0, 1], acceleration, angularVelocity: [0, 0, 0],
    units: { acceleration: 'm/s2', angularVelocity: 'rad/s' },
    deviceFrame: 'phone:body', referenceFrame: 'phone:start', accelerationKind: 'linear',
    calibrationRevision: 0,
    timing: { capture: processed(at), receipt: processed(at), mapping: null, processors: [] } };
}
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('explicit browser, Expo and decoded watch units preserve physical values and source clocks', () => {
  const convert = createMotionUnitProcessor(identity);
  // Browser DeviceMotion and Expo native modules produce m/s2 and degrees/second.
  // The watch payloads produce gravity-removed g and degrees/second after native conversion.
  for (const [unit, vector] of [['m/s2', [9.80665, -4.903325, 0]], ['g', [1, -0.5, 0]]] as const) {
    const input = { ...frame(1250, vector), angularVelocity: [180, -90, 0],
      units: { acceleration: unit, angularVelocity: 'deg/s' } };
    const result = convert.process(input, processed(1251));
    close(result.acceleration[0], 9.80665); close(result.acceleration[1], -4.903325);
    close(result.angularVelocity[0], Math.PI); close(result.angularVelocity[1], -Math.PI / 2);
    assert.deepEqual(result.units, { acceleration: 'm/s2', angularVelocity: 'rad/s' });
    assert.deepEqual(result.timing.capture, input.timing.capture);
    assert.equal(result.timing.processors[0]?.id, identity.id);
    assert.equal(result.accelerationKind, 'linear');
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.acceleration));
  }
  const remote = { ...frame(100), timing: { capture: { clockId: 'watch', at: 100 },
    receipt: processed(1100), mapping: { earliest: 1080, latest: 1100, uncertaintyMs: 10, maxDriftPpm: 20 }, processors: [] } };
  assert.deepEqual(convert.process(remote, processed(1101)).timing.mapping, remote.timing.mapping);
});

test('motion measurement rejects missing values, unknown units, invalid quaternions and authority fields', () => {
  for (const input of [
    { ...frame(0), acceleration: [0, 0] }, { ...frame(0), angularVelocity: [0, NaN, 0] },
    { ...frame(0), orientation: [0, 0, 0, 0] }, { ...frame(0), orientation: [1, 1, 1, 1] },
    { ...frame(0), units: { acceleration: 'g', angularVelocity: 'unknown' } },
    { ...frame(0), accelerationKind: 'unknown' }, { ...frame(0), deviceFrame: '' },
    { ...frame(0), calibrationRevision: -1 }, { ...frame(0), permission: true },
  ]) assert.throws(() => parseMotionMeasurement(input));
  const input = frame(0, [1, 2, 3]), result = parseMotionMeasurement(input);
  (input.acceleration as number[])[0] = 99;
  assert.equal(result.acceleration[0], 1);
  const float32 = Math.fround(Math.SQRT1_2);
  close(Math.hypot(...parseMotionMeasurement({ ...frame(0), orientation: [float32, 0, 0, float32] }).orientation), 1);
  assert.throws(() => createMotionUnitProcessor(identity).process({ ...frame(0, [1e6, 0, 0]),
    units: { acceleration: 'g', angularVelocity: 'rad/s' } }, processed(1)), /motion-number/);
});

test('neutral calibration changes only the orientation reference and appends its configuration', () => {
  const held = [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as const;
  const calibrate = createMotionCalibrationProcessor({ ...identity, configurationRevision: 2,
    deviceFrame: 'phone:body', sourceReferenceFrame: 'phone:start', targetReferenceFrame: 'phone:neutral', neutral: held });
  const result = calibrate.process({ ...frame(10, [9.80665, 0, 0]), orientation: held,
    angularVelocity: [Math.PI, 0, 0], calibrationRevision: 3 }, processed(11));
  result.orientation.forEach((value, index) => close(value, index === 3 ? 1 : 0));
  assert.deepEqual(result.acceleration, [9.80665, 0, 0]);
  assert.deepEqual(result.angularVelocity, [Math.PI, 0, 0]);
  assert.equal(result.referenceFrame, 'phone:neutral');
  assert.equal(result.calibrationRevision, 3);
  assert.equal(result.timing.processors[0]?.configurationRevision, 2);
  assert.throws(() => calibrate.process({ ...frame(12), deviceFrame: 'watch:body' }, processed(13)), /motion-calibration-frame/);
});

test('smoothing uses the shortest quaternion hemisphere and conservatively retains source age', () => {
  const filter = createMotionSmoothingProcessor({ ...identity, alpha: 0.5, maxGapMs: 100, maxWindowMs: 300 });
  filter.process(frame(0, [10, 0, 0]), processed(1));
  const next = filter.process({ ...frame(16, [0, 0, 0]), orientation: [0, 0, 0, -1] }, processed(17));
  assert.deepEqual(next.acceleration, [5, 0, 0]);
  close(Math.abs(next.orientation[3]), 1);
  assert.equal(next.timing.capture.at, 0);
  assert.equal(next.timing.receipt.at, 16);
  assert.equal(filter.process(frame(117, [8, 0, 0]), processed(118)).acceleration[0], 8, 'gap resets retained state');
  filter.reset();
  filter.process(frame(0, [10, 0, 0]), processed(1));
  for (const at of [100, 200, 300]) filter.process(frame(at), processed(at + 1));
  assert.equal(filter.process(frame(301, [8, 0, 0]), processed(302)).acceleration[0], 8, 'bounded history restarts');
});

test('smoothing resets across frame, calibration, clock and upstream configuration changes', () => {
  for (const patch of [
    { deviceFrame: 'watch:body' }, { referenceFrame: 'phone:neutral' }, { accelerationKind: 'including-gravity' },
    { calibrationRevision: 1 },
    { timing: { capture: { clockId: 'other', at: 16 }, receipt: { clockId: 'other', at: 16 }, mapping: null, processors: [] } },
    { timing: { ...frame(16).timing, processors: [{ ...identity, configurationRevision: 2, processed: processed(16) }] } },
  ]) {
    const filter = createMotionSmoothingProcessor({ ...identity, alpha: 0.5, maxGapMs: 100, maxWindowMs: 300 });
    filter.process(frame(0, [10, 0, 0]), processed(1));
    const input = { ...frame(16, [2, 0, 0]), ...patch };
    assert.equal(filter.process(input, { ...input.timing.receipt, at: 17 }).acceleration[0], 2);
  }
});

test('full passthrough smoothing retains only the current contributing capture', () => {
  const filter = createMotionSmoothingProcessor({ ...identity, alpha: 1, maxGapMs: 100, maxWindowMs: 300 });
  for (const at of [0, 90, 180]) {
    const input = frame(at, [at, 0, 0]);
    const result = filter.process(input, processed(at + 1));
    assert.deepEqual(result.acceleration, input.acceleration);
    assert.deepEqual(result.orientation, input.orientation);
    assert.equal(result.timing.capture.at, at);
  }
});

test('malformed, duplicate-time and unsupported remote filtering inputs reset before recovery', () => {
  const filter = createMotionSmoothingProcessor({ ...identity, alpha: 0.5, maxGapMs: 100, maxWindowMs: 300 });
  for (const bad of [frame(0), { ...frame(16), orientation: [0, 0, 0, 0] },
    { ...frame(16), units: { acceleration: 'g', angularVelocity: 'rad/s' } },
    { ...frame(16), timing: { capture: { clockId: 'watch', at: 10 }, receipt: processed(16),
      mapping: { earliest: 10, latest: 12, uncertaintyMs: 1, maxDriftPpm: 0 }, processors: [] } }]) {
    filter.reset(); filter.process(frame(0, [10, 0, 0]), processed(1));
    assert.throws(() => filter.process(bad, processed(17)));
    assert.equal(filter.process(frame(18, [2, 0, 0]), processed(19)).acceleration[0], 2);
  }
  assert.throws(() => createMotionSmoothingProcessor({ ...identity, alpha: 0, maxGapMs: 100, maxWindowMs: 300 }));
  assert.throws(() => createMotionUnitProcessor({ ...identity, configurationRevision: 0 }));
  assert.throws(() => createMotionSmoothingProcessor({ ...identity, alpha: 1, maxGapMs: 100,
    maxWindowMs: 300, sensitivity: 2 } as never));
  const canonical: MotionMeasurement = parseMotionMeasurement(frame(1));
  assert.equal(canonical.deviceFrame, 'phone:body');
});
