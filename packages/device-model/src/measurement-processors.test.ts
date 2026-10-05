import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from './index.ts';

type Factory = (...args: unknown[]) => model.ScalarMeasurementProcessor;
function valid(frame: model.MeasurementFrame) {
  assert.equal(frame.report.status, 'valid');
  if (frame.report.status !== 'valid') throw new Error('Expected a valid measurement');
  return frame.report;
}
const api = model as Record<string, unknown>;
const calibration = api.createScalarCalibrationProcessor as Factory | undefined;
const conversion = api.createScalarConversionProcessor as Factory | undefined;
const filter = api.createMovingAverageProcessor as Factory | undefined;
const cel = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
const kelvin = { type: 'scalar', unit: 'K', min: 0, max: 400 };
const identity = (id: string) => ({ id, version: '1.0.0', configurationRevision: 2 });
const frame = (value: number, capture: number, uncertainty = 0.5, revision = 7) => ({
  report: { status: 'valid', value, calibration: { revision },
    uncertainty: { absoluteErrorBound: uncertainty, unit: 'Cel' }, faults: [] },
  timing: { capture: { clockId: 'sensor', at: capture }, receipt: { clockId: 'sensor', at: capture + 1 },
    mapping: null, processors: [] },
});
const stamp = (at: number) => ({ clockId: 'sensor', at });

test('calibration keeps producer revision and capture time while propagating error', () => {
  assert.equal(typeof calibration, 'function');
  const processor = calibration!(cel, cel, { ...identity('example:calibration'), gain: 1.02, offset: -1,
    absoluteErrorBound: 0.2 });
  const output = processor.process(frame(30, 100), stamp(102));
  assert.equal(valid(output).value, 29.6);
  assert.equal(valid(output).calibration.revision, 7);
  assert.ok(valid(output).uncertainty.absoluteErrorBound >= 0.71);
  assert.equal(valid(output).uncertainty.unit, 'Cel');
  assert.equal(output.timing.capture.at, 100);
  assert.deepEqual(output.timing.processors[0], { ...identity('example:calibration'), processed: stamp(102) });
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.report), true);
});

test('saturation and invalid input never produce a valid calibrated reading', () => {
  assert.equal(typeof calibration, 'function');
  const processor = calibration!(cel, cel, { ...identity('example:calibration'), gain: 2, offset: 0,
    absoluteErrorBound: 0.1 });
  assert.deepEqual(processor.process(frame(100, 100), stamp(102)).report,
    { status: 'unavailable', faults: [{ code: 'processor:saturation' }] });
  assert.throws(() => processor.process(frame(Number.NaN, 100), stamp(102)), model.DeviceValidationError);
  assert.throws(() => processor.process(frame(30, 100), { clockId: 'other', at: 102 }), model.DeviceValidationError);
  assert.throws(() => calibration!(cel, kelvin, { ...identity('example:calibration'), gain: 1, offset: 0,
    absoluteErrorBound: 0.1 }), model.DeviceValidationError);
});

test('conversion preserves timing and scales the stated uncertainty', () => {
  assert.equal(typeof conversion, 'function');
  const processor = conversion!(cel, kelvin, { ...identity('example:conversion'),
    decimalPlaces: 2, maxAbsoluteError: 0.00501 });
  const output = processor.process(frame(30, 100), stamp(103));
  assert.equal(valid(output).value, 303.15);
  assert.equal(valid(output).uncertainty.unit, 'K');
  assert.ok(valid(output).uncertainty.absoluteErrorBound > 0.5);
  assert.equal(valid(output).calibration.revision, 7);
  assert.equal(output.timing.capture.at, 100);
  assert.equal(output.timing.processors[0].id, 'example:conversion');
  assert.deepEqual(processor.process({ ...frame(30, 105), report: { status: 'stale', faults: [] } }, stamp(107)).report,
    { status: 'stale', faults: [] });
});

test('moving average uses a conservative error bound and oldest capture', () => {
  assert.equal(typeof filter, 'function');
  const processor = filter!(cel, { ...identity('example:filter'), windowSize: 3, maxGapMs: 20 });
  assert.equal(valid(processor.process(frame(30, 100), stamp(102))).value, 30);
  const output = processor.process(frame(32, 110), stamp(112));
  assert.equal(valid(output).value, 31);
  assert.ok(valid(output).uncertainty.absoluteErrorBound >= 0.5);
  assert.equal(output.timing.capture.at, 100);
  assert.equal(output.timing.receipt.at, 111);
  assert.equal(output.timing.processors[0].processed.at, 112);
});

test('moving average resets on stale, invalid, changed calibration, gaps and explicit reset', () => {
  assert.equal(typeof filter, 'function');
  const processor = filter!(cel, { ...identity('example:filter'), windowSize: 3, maxGapMs: 20 });
  processor.process(frame(30, 100), stamp(102));
  const stale = { ...frame(0, 105), report: { status: 'stale', faults: [{ code: 'sensor:late' }] } };
  assert.deepEqual(processor.process(stale, stamp(107)).report, stale.report);
  assert.equal(valid(processor.process(frame(32, 110), stamp(112))).value, 32);
  assert.throws(() => processor.process(frame(999, 115), stamp(117)), model.DeviceValidationError);
  assert.equal(valid(processor.process(frame(34, 120), stamp(122))).value, 34);
  assert.equal(valid(processor.process(frame(36, 125, 0.5, 8), stamp(127))).value, 36);
  assert.equal(valid(processor.process(frame(38, 200, 0.5, 8), stamp(202))).value, 38);
  assert.throws(() => processor.process(frame(40, 190, 0.5, 8), stamp(203)), model.DeviceValidationError);
  assert.equal(valid(processor.process(frame(42, 205, 0.5, 8), stamp(207))).value, 42);
  processor.reset?.();
  assert.equal(valid(processor.process(frame(44, 210, 0.5, 8), stamp(212))).value, 44);
});

test('composed processors retain oldest capture, ordered lineage and same-clock uncertainty', () => {
  assert.equal(typeof calibration, 'function'); assert.equal(typeof conversion, 'function'); assert.equal(typeof filter, 'function');
  const correction = calibration!(cel, cel, { ...identity('example:calibration'), gain: 1, offset: 1,
    absoluteErrorBound: 0.25 });
  const toKelvin = conversion!(cel, kelvin, { ...identity('example:conversion'),
    decimalPlaces: 2, maxAbsoluteError: 0.00501 });
  const average = filter!(kelvin, { ...identity('example:filter'), windowSize: 2, maxGapMs: 20 });
  const first = toKelvin.process(correction.process(frame(20, 100), stamp(102)), stamp(103));
  const second = toKelvin.process(correction.process(frame(22, 110), stamp(112)), stamp(113));
  average.process(first, stamp(104));
  const output = average.process(second, stamp(114));
  assert.equal(valid(output).value, 295.15);
  assert.ok(valid(output).uncertainty.absoluteErrorBound > 0.75);
  assert.equal(valid(output).uncertainty.unit, 'K');
  assert.equal(output.timing.capture.at, 100);
  assert.deepEqual(output.timing.processors.map((step: { id: string }) => step.id),
    ['example:calibration', 'example:conversion', 'example:filter']);
  assert.deepEqual(output.timing.processors.map((step: { processed: { at: number } }) => step.processed.at),
    [112, 113, 114]);
});

test('filter rejects incomparable capture clocks and resets on saturation', () => {
  assert.equal(typeof filter, 'function');
  const processor = filter!(cel, { ...identity('example:filter'), windowSize: 2, maxGapMs: 20 });
  processor.process(frame(30, 100), stamp(102));
  const mapped = { ...frame(32, 110), timing: { capture: { clockId: 'remote', at: 110 },
    receipt: { clockId: 'sensor', at: 111 }, mapping: { earliest: 109, latest: 111,
      uncertaintyMs: 1, maxDriftPpm: 0 }, processors: [] } };
  assert.throws(() => processor.process(mapped, stamp(112)), model.DeviceValidationError);
  assert.equal(valid(processor.process(frame(34, 120), stamp(122))).value, 34);
  const narrow = filter!({ type: 'scalar', unit: 'Cel', min: -1, max: 1 },
    { ...identity('example:narrow-filter'), windowSize: 2, maxGapMs: 20 });
  const narrowFrame = { ...frame(0, 130, 2), report: { ...frame(0, 130, 2).report,
    uncertainty: { absoluteErrorBound: 2, unit: 'Cel' } } };
  assert.deepEqual(narrow.process(narrowFrame, stamp(132)).report,
    { status: 'unavailable', faults: [{ code: 'processor:saturation' }] });
  assert.equal(valid(narrow.process({ ...frame(1, 140, 0.1), report: { ...frame(1, 140, 0.1).report,
    uncertainty: { absoluteErrorBound: 0.1, unit: 'Cel' } } }, stamp(142))).value, 1);
});

test('filter resets when an upstream calibration configuration changes', () => {
  assert.equal(typeof filter, 'function');
  const processor = filter!(cel, { ...identity('example:filter'), windowSize: 3, maxGapMs: 20 });
  const withLineage = (value: number, capture: number, revision: number) => ({ ...frame(value, capture),
    timing: { ...frame(value, capture).timing, processors: [{ id: 'example:calibration', version: '1.0.0',
      configurationRevision: revision, processed: stamp(capture + 1) }] } });
  assert.equal(valid(processor.process(withLineage(30, 100, 1), stamp(102))).value, 30);
  assert.equal(valid(processor.process(withLineage(32, 110, 1), stamp(112))).value, 31);
  assert.equal(valid(processor.process(withLineage(34, 120, 2), stamp(122))).value, 34);
});
