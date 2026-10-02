import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceValidationError } from './descriptor.ts';
import { parseMeasurementReport } from './quality.ts';

const celsius = { type: 'scalar', unit: 'Cel', min: -40, max: 125 } as const;
const valid = { status: 'valid', value: 31.25, calibration: { revision: 7 },
  uncertainty: { absoluteErrorBound: 0.5, unit: 'Cel' }, faults: [] } as const;

test('valid measurement preserves producer revision, exact unit and error bound as immutable data', () => {
  const report = parseMeasurementReport(valid, celsius);
  assert.deepEqual(report, valid);
  assert.equal(Object.isFrozen(report), true);
  if (report.status === 'valid') {
    assert.equal(Object.isFrozen(report.calibration), true);
    assert.equal(Object.isFrozen(report.uncertainty), true);
  }
  assert.throws(() => parseMeasurementReport({ ...valid, uncertainty: { absoluteErrorBound: 0.5, unit: 'K' } }, celsius));
  assert.throws(() => parseMeasurementReport({ ...valid, value: 126 }, celsius));
  assert.throws(() => parseMeasurementReport({ ...valid, calibration: { revision: 0 } }, celsius));
  assert.throws(() => parseMeasurementReport({ ...valid, calibration: { revision: 2147483648 } }, celsius));
  assert.throws(() => parseMeasurementReport({ ...valid, uncertainty: { absoluteErrorBound: 166, unit: 'Cel' } }, celsius));
  assert.throws(() => parseMeasurementReport({ ...valid, working: true }, celsius));
  assert.throws(() => parseMeasurementReport(valid, { type: 'boolean' }));
});

test('loss reports preserve distinct producer faults and cannot contain a value', () => {
  const lost = { status: 'unavailable', faults: [{ code: 'sensor:disconnected' }] } as const;
  const report = parseMeasurementReport(lost, celsius);
  assert.deepEqual(report, lost);
  assert.equal(Object.isFrozen(report.faults[0]), true);
  assert.deepEqual(parseMeasurementReport({ status: 'stale', faults: [] }, celsius), { status: 'stale', faults: [] });
  assert.throws(() => parseMeasurementReport({ ...lost, value: 31.25 }, celsius));
  assert.throws(() => parseMeasurementReport({ ...lost, calibration: { revision: 7 } }, celsius));
  assert.throws(() => parseMeasurementReport({ ...lost, faults: [{ code: 'sensor:disconnected' }, { code: 'sensor:disconnected' }] }, celsius));
  assert.throws(() => parseMeasurementReport({ ...lost, faults: Array.from({ length: 9 }, (_, index) => ({ code: `sensor:fault-${index}` })) }, celsius));
  assert.throws(() => parseMeasurementReport({ ...lost, faults: [{ code: 'not-namespaced' }] }, celsius));
});

test('report accessors never execute', () => {
  let reads = 0;
  const input = { ...valid, calibration: { get revision() { reads += 1; return 7; } } };
  assert.throws(() => parseMeasurementReport(input, celsius), DeviceValidationError);
  assert.equal(reads, 0);
});
