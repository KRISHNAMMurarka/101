import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from './index.ts';

const converter = (model as Record<string, unknown>).createUnitConverter as
  ((source: unknown, target: unknown, options: { decimalPlaces: number; maxAbsoluteError: number }) =>
    { metadata: Record<string, unknown>; convert(input: unknown): unknown }) | undefined;

test('legacy descriptor spelling remains accepted while explicit unit tokens reject ambiguity', () => {
  for (const unit of [' Cel', 'Cel ', '°C', 'm//s', '/s', 'm/', 'm..s', 'm s']) {
    assert.deepEqual(model.parseValueSchema({ type: 'scalar', unit, min: -40, max: 125 }),
      { type: 'scalar', unit, min: -40, max: 125 });
    assert.throws(() => (model as Record<string, unknown>).parseUnitToken instanceof Function &&
      ((model as Record<string, unknown>).parseUnitToken as (input: unknown) => string)(unit), model.DeviceValidationError);
  }
  assert.equal(typeof (model as Record<string, unknown>).parseUnitToken, 'function');
  assert.equal(((model as Record<string, unknown>).parseUnitToken as (input: unknown) => string)('vendor.unit'), 'vendor.unit');
  assert.throws(() => model.parseValueSchema({ type: 'scalar', unit: 'm\n/s', min: 0, max: 1 }), model.DeviceValidationError);
});

test('explicit affine conversion preserves Celsius and Kelvin meaning', () => {
  assert.equal(typeof converter, 'function');
  const toKelvin = converter!({ type: 'scalar', unit: 'Cel', min: -40, max: 125 },
    { type: 'scalar', unit: 'K', min: 0, max: 400 }, { decimalPlaces: 2, maxAbsoluteError: 0.00501 });
  assert.equal(toKelvin.convert(0), 273.15);
  assert.equal(toKelvin.convert(37), 310.15);
  assert.equal(toKelvin.metadata.scale, 1);
  assert.equal(toKelvin.metadata.offset, 273.15);
  assert.equal(Object.isFrozen(toKelvin.metadata), true);
  const toCelsius = converter!({ type: 'scalar', unit: 'K', min: 200, max: 400 },
    { type: 'scalar', unit: 'Cel', min: -100, max: 150 }, { decimalPlaces: 2, maxAbsoluteError: 0.00501 });
  assert.equal(toCelsius.convert(303.15), 30);
  assert.equal(toCelsius.metadata.offset, -273.15);
});

test('metric, information and vector conversions retain frames, components and inputs', () => {
  assert.equal(typeof converter, 'function');
  const metres = { type: 'vector', unit: 'm', min: -2, max: 2, frame: 'room-right-handed', components: ['x', 'y', 'z'] };
  const centimetres = { ...metres, unit: 'cm', min: -200, max: 200 };
  const vector = converter!(metres, centimetres, { decimalPlaces: 1, maxAbsoluteError: 0.051 });
  const input = { x: 1.25, y: -0.5, z: 0 };
  const output = vector.convert(input) as Record<string, number>;
  assert.deepEqual(output, { x: 125, y: -50, z: 0 });
  assert.deepEqual(input, { x: 1.25, y: -0.5, z: 0 });
  assert.equal(Object.isFrozen(output), true);
  const bytes = converter!({ type: 'scalar', unit: 'KiBy', min: 0, max: 1000000 },
    { type: 'scalar', unit: 'By', min: 0, max: 1024000000 }, { decimalPlaces: 0, maxAbsoluteError: 0.51 });
  assert.equal(bytes.convert(64.5), 66048);
  assert.equal(bytes.metadata.scale, 1024);
});

test('unknown unit identity is explicit; incompatible dimensions and frames fail closed', () => {
  assert.equal(typeof converter, 'function');
  const custom = { type: 'scalar', unit: 'vendor.unit', min: 0, max: 10 };
  assert.equal(converter!(custom, custom, { decimalPlaces: 2, maxAbsoluteError: 0.00501 }).convert(2.5), 2.5);
  for (const target of [
    { ...custom, unit: 'vendor.other' }, { ...custom, unit: 'm' },
    { type: 'scalar', unit: 'kg', min: 0, max: 10 },
  ]) assert.throws(() => converter!(custom, target, { decimalPlaces: 2, maxAbsoluteError: 0.01 }), model.DeviceValidationError);
  const framed = { type: 'vector', unit: 'm', min: -1, max: 1, frame: 'left-handed', components: ['x', 'y'] };
  assert.throws(() => converter!(framed, { ...framed, unit: 'cm', min: -100, max: 100, frame: 'right-handed' },
    { decimalPlaces: 1, maxAbsoluteError: 0.1 }), model.DeviceValidationError);
  assert.throws(() => converter!({ type: 'scalar', unit: 'Cel', min: 0, max: 50 },
    { type: 'scalar', unit: 'm', min: 0, max: 100 }, { decimalPlaces: 2, maxAbsoluteError: 0.1 }), model.DeviceValidationError);
});

test('precision, range and error budgets reject overclaims before publication', () => {
  assert.equal(typeof converter, 'function');
  const source = { type: 'scalar', unit: 'm', min: 0, max: 2, resolution: 0.1 };
  const target = { type: 'scalar', unit: 'cm', min: 0, max: 200, resolution: 10 };
  assert.throws(() => converter!(source, target, { decimalPlaces: 1, maxAbsoluteError: 4.9 }), model.DeviceValidationError);
  const valid = converter!(source, target, { decimalPlaces: 1, maxAbsoluteError: 5.051 });
  assert.equal(valid.convert(1.237), 123.7);
  assert.throws(() => valid.convert(2.1), model.DeviceValidationError);
  assert.throws(() => valid.convert(Infinity), model.DeviceValidationError);
  assert.throws(() => converter!(source, { ...target, resolution: 1 },
    { decimalPlaces: 1, maxAbsoluteError: 5.051 }), model.DeviceValidationError);
  assert.throws(() => converter!(source, { ...target, max: 199 },
    { decimalPlaces: 1, maxAbsoluteError: 5.051 }), model.DeviceValidationError);
  for (const options of [
    { decimalPlaces: -1, maxAbsoluteError: 100 }, { decimalPlaces: 13, maxAbsoluteError: 100 },
    { decimalPlaces: 1.5, maxAbsoluteError: 100 }, { decimalPlaces: 1, maxAbsoluteError: -1 },
    { decimalPlaces: 1, maxAbsoluteError: Infinity },
  ]) assert.throws(() => converter!(source, target, options), model.DeviceValidationError);
  assert.throws(() => converter!({ type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER },
    { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER },
    { decimalPlaces: 12, maxAbsoluteError: 1 }), model.DeviceValidationError);
});

test('conversion options must be inert exact data before an untrusted manifest can use them', () => {
  assert.equal(typeof converter, 'function');
  const source = { type: 'scalar', unit: 'm', min: 0, max: 1 };
  const target = { type: 'scalar', unit: 'cm', min: 0, max: 100 };
  let reads = 0;
  const accessor = Object.defineProperty({ maxAbsoluteError: 0.1 }, 'decimalPlaces',
    { enumerable: true, get() { reads++; return 1; } });
  assert.throws(() => converter!(source, target, accessor as { decimalPlaces: number; maxAbsoluteError: number }), model.DeviceValidationError);
  assert.equal(reads, 0);
  assert.throws(() => converter!(source, target, { decimalPlaces: 1, maxAbsoluteError: 0.1, ignoreBudget: true } as
    { decimalPlaces: number; maxAbsoluteError: number }), model.DeviceValidationError);
  const options = { decimalPlaces: 2, maxAbsoluteError: 0.00501 };
  const identity = converter!({ type: 'scalar', unit: 'vendor.unit', min: 0, max: 2 },
    { type: 'scalar', unit: 'vendor.unit', min: 0, max: 2 }, options);
  options.maxAbsoluteError = 0;
  assert.equal(identity.convert(1.234), 1.23);
  assert.equal(identity.metadata.maxAbsoluteError, 0.00501);
});

test('a large range cannot mask a target resolution finer than the source or decimal step', () => {
  assert.equal(typeof converter, 'function');
  assert.throws(() => converter!(
    { type: 'scalar', unit: 'vendor.unit', min: 0, max: 2000000000000, resolution: 0.01 },
    { type: 'scalar', unit: 'vendor.unit', min: -1, max: 2000000000001, resolution: 0.000000001 },
    { decimalPlaces: 2, maxAbsoluteError: 0.025 }), model.DeviceValidationError);
});

test('equal transformed resolution remains valid despite decimal scale representation', () => {
  assert.equal(typeof converter, 'function');
  const value = converter!(
    { type: 'scalar', unit: 'mm', min: 0, max: 1, resolution: 0.2 },
    { type: 'scalar', unit: 'cm', min: 0, max: 0.1, resolution: 0.02 },
    { decimalPlaces: 3, maxAbsoluteError: 0.02 });
  assert.equal(value.convert(0.4), 0.04);
});

test('an advertised worst-case budget accepts valid rounded values', () => {
  assert.equal(typeof converter, 'function');
  const schema = { type: 'scalar', unit: 'vendor.unit', min: 0, max: 10 };
  const provisional = converter!(schema, schema, { decimalPlaces: 1, maxAbsoluteError: 0.051 });
  const exact = converter!(schema, schema, { decimalPlaces: 1,
    maxAbsoluteError: provisional.metadata.worstCaseAbsoluteError as number });
  assert.equal(exact.convert(1.15), 1.2);
  assert.equal(exact.convert(9.95), 10);
});
