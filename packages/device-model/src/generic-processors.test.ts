import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from './index.ts';

const api = model as Record<string, unknown>;
const deadzone = api.createDeadzoneMapper as typeof model.createDeadzoneMapper | undefined;
const hysteresis = api.createHysteresisEdgeProcessor as typeof model.createHysteresisEdgeProcessor | undefined;
const resampler = api.createLatestResampler as typeof model.createLatestResampler | undefined;
const scalar = { type: 'scalar', unit: 'deg', min: -90, max: 90 } as const;
const step = (id: string) => ({ id, version: '1.0.0', configurationRevision: 1 });
function frame(value: number, capture: number, error = 1, status: 'valid' | 'stale' = 'valid') {
  return { report: status === 'valid' ? { status, value, calibration: { revision: 4 },
    uncertainty: { absoluteErrorBound: error, unit: 'deg' }, faults: [] } :
    { status, faults: [{ code: 'sensor:late' }] },
  timing: { capture: { clockId: 'sensor', at: capture }, receipt: { clockId: 'sensor', at: capture + 1 },
    mapping: null, processors: [] } };
}
const stamp = (at: number) => ({ clockId: 'sensor', at });
function valid(input: model.MeasurementFrame) {
  assert.equal(input.report.status, 'valid');
  if (input.report.status !== 'valid') throw new Error('Expected valid');
  return input.report;
}

test('deadzone mapping is unitless, continuous and carries a conservative error bound', () => {
  assert.equal(typeof deadzone, 'function');
  const mapper = deadzone!(scalar, { ...step('example:deadzone'), center: 0, halfSpan: 90, deadzone: 0.2 });
  assert.equal(valid(mapper.process(frame(0, 100), stamp(102))).value, 0);
  assert.equal(valid(mapper.process(frame(18, 110), stamp(112))).value, 0);
  const mapped = mapper.process(frame(54, 120), stamp(122));
  assert.ok(Math.abs(valid(mapped).value - 0.5) < 1e-12);
  assert.equal(valid(mapped).uncertainty.unit, '1');
  assert.ok(valid(mapped).uncertainty.absoluteErrorBound >= 1 / 72);
  assert.equal(mapped.timing.capture.at, 120);
  assert.equal(mapped.timing.processors[0]?.id, 'example:deadzone');
  assert.equal(valid(mapper.process(frame(-90, 130), stamp(132))).value, -1);
  assert.equal(valid(mapper.process(frame(90, 140), stamp(142))).value, 1);
});

test('deadzone rejects incompatible range, invalid readings and stale values', () => {
  assert.equal(typeof deadzone, 'function');
  assert.throws(() => deadzone!(scalar, { ...step('example:deadzone'), center: 0, halfSpan: 45, deadzone: 0.2 }), model.DeviceValidationError);
  assert.throws(() => deadzone!(scalar, { ...step('example:deadzone'), center: 0, halfSpan: 90, deadzone: 1 }), model.DeviceValidationError);
  const mapper = deadzone!(scalar, { ...step('example:deadzone'), center: 0, halfSpan: 90, deadzone: 0.2 });
  assert.deepEqual(mapper.process(frame(0, 100, 1, 'stale'), stamp(102)).report,
    { status: 'stale', faults: [{ code: 'sensor:late' }] });
  assert.throws(() => mapper.process(frame(Number.NaN, 100), stamp(102)), model.DeviceValidationError);
});

test('hysteresis emits only decisive edges and resets on stale input', () => {
  assert.equal(typeof hysteresis, 'function');
  const edge = hysteresis!(scalar, { ...step('example:edge'), onAt: 30, offAt: 20 });
  assert.equal(edge.evaluate(frame(25, 100), stamp(102)), undefined);
  const on = edge.evaluate(frame(32, 110), stamp(112));
  assert.equal(on?.value, true);
  assert.equal(on?.timing.capture.at, 110);
  assert.equal(on?.source.unit, 'deg');
  assert.equal(edge.evaluate(frame(35, 120), stamp(122)), undefined);
  assert.equal(edge.evaluate(frame(21, 130), stamp(132)), undefined);
  assert.equal(edge.evaluate(frame(18, 140), stamp(142))?.value, false);
  assert.equal(edge.evaluate(frame(19, 150), stamp(152)), undefined);
  edge.evaluate(frame(0, 160, 1, 'stale'), stamp(162));
  assert.equal(edge.evaluate(frame(32, 170), stamp(172))?.value, true);
});

test('threshold uncertainty cannot trigger an ambiguous edge', () => {
  assert.equal(typeof hysteresis, 'function');
  const edge = hysteresis!(scalar, { ...step('example:edge'), onAt: 30, offAt: 20 });
  assert.equal(edge.evaluate(frame(30, 100, 1), stamp(102)), undefined);
  assert.equal(edge.evaluate(frame(31, 110, 1), stamp(112))?.value, true);
  assert.equal(edge.evaluate(frame(20, 120, 1), stamp(122)), undefined);
  assert.equal(edge.evaluate(frame(19, 130, 1), stamp(132))?.value, false);
  assert.throws(() => hysteresis!(scalar, { ...step('example:edge'), onAt: 20, offAt: 30 }), model.DeviceValidationError);
});

test('latest resampler enforces a configured period and source age without changing capture time', () => {
  assert.equal(typeof resampler, 'function');
  const sampler = resampler!(scalar, { ...step('example:resample'), periodMs: 20, maxAgeMs: 50 });
  sampler.push(frame(10, 100));
  assert.equal(valid(sampler.sample(stamp(102))!).value, 10);
  assert.equal(sampler.sample(stamp(110)), undefined);
  sampler.push(frame(20, 115));
  const next = sampler.sample(stamp(122));
  assert.equal(valid(next!).value, 20);
  assert.equal(next?.timing.capture.at, 115);
  assert.equal(next?.timing.processors[0]?.processed.at, 122);
  assert.equal(sampler.sample(stamp(141)), undefined);
  assert.equal(valid(sampler.sample(stamp(142))!).value, 20);
  assert.equal(sampler.sample(stamp(166)), undefined);
  assert.equal(sampler.sample(stamp(180)), undefined);
});

test('resampler resets on stale, invalid, reordered, cross-clock input and explicit reset', () => {
  assert.equal(typeof resampler, 'function');
  const sampler = resampler!(scalar, { ...step('example:resample'), periodMs: 20, maxAgeMs: 50 });
  sampler.push(frame(10, 100));
  assert.equal(sampler.push(frame(0, 110, 1, 'stale')), false);
  assert.equal(sampler.sample(stamp(120)), undefined);
  sampler.push(frame(20, 130));
  assert.throws(() => sampler.push(frame(30, 120)), model.DeviceValidationError);
  assert.equal(sampler.sample(stamp(140)), undefined);
  const remote = { ...frame(10, 150), timing: { capture: { clockId: 'remote', at: 150 },
    receipt: { clockId: 'sensor', at: 151 }, mapping: { earliest: 149, latest: 151,
      uncertaintyMs: 1, maxDriftPpm: 0 }, processors: [] } };
  assert.throws(() => sampler.push(remote), model.DeviceValidationError);
  sampler.push(frame(40, 160));
  sampler.reset();
  assert.equal(sampler.sample(stamp(162)), undefined);
  assert.throws(() => sampler.push(frame(Number.NaN, 170)), model.DeviceValidationError);
});

test('stateful processors discard prior state after calibration or upstream configuration changes', () => {
  assert.equal(typeof hysteresis, 'function'); assert.equal(typeof resampler, 'function');
  const withRevision = (value: number, capture: number, revision: number, configurationRevision = 1) => ({
    ...frame(value, capture),
    report: { ...frame(value, capture).report, calibration: { revision } },
    timing: { ...frame(value, capture).timing, processors: [{ id: 'example:calibration', version: '1.0.0',
      configurationRevision, processed: stamp(capture + 1) }] },
  });
  const edge = hysteresis!(scalar, { ...step('example:edge'), onAt: 30, offAt: 20 });
  assert.equal(edge.evaluate(withRevision(32, 100, 1), stamp(102))?.value, true);
  assert.equal(edge.evaluate(withRevision(25, 110, 2), stamp(112)), undefined);
  assert.equal(edge.evaluate(withRevision(18, 120, 2), stamp(122))?.value, false);
  assert.equal(edge.evaluate(withRevision(32, 130, 2, 2), stamp(132))?.value, true);
  const sampler = resampler!(scalar, { ...step('example:resample'), periodMs: 20, maxAgeMs: 50 });
  sampler.push(withRevision(10, 200, 1));
  assert.equal(valid(sampler.sample(stamp(202))!).value, 10);
  sampler.push(withRevision(20, 210, 2));
  assert.equal(valid(sampler.sample(stamp(212))!).value, 20);
});
