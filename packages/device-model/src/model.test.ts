import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import {
  DEVICE_DESCRIPTOR_SCHEMA,
  DeviceValidationError,
  parseDeviceDescriptor,
  parseSignalValue,
  schemasCompatible,
  snapshotJson,
} from './index.ts';
import type { DeviceCapability, DeviceDescriptor, JsonObject, ValueSchema } from './index.ts';

const temperature: DeviceCapability = {
  id: 'temperature', semantic: 'example:temperature', schemaVersion: 1,
  kind: 'sample', value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
  delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 5000 }, permissions: ['subscribe'],
};
const thermometer: DeviceDescriptor = {
  schemaVersion: 1, id: 'room-thermometer', label: 'Room temperature', revision: 1,
  adapter: { id: 'example:temperature', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [temperature],
};

function rejects(input: unknown) {
  assert.throws(() => parseDeviceDescriptor(input), DeviceValidationError);
}

test('a descriptor preserves signal meaning and is an immutable snapshot', () => {
  const input = {
    ...thermometer, capabilities: [{ ...temperature, metadata: { calibration: { offset: 0.25 } } }],
    extensions: { 'vendor:quality': { available: true } },
  };
  const result = parseDeviceDescriptor(input);
  input.capabilities[0].metadata.calibration.offset = 100;
  assert.deepEqual(result.capabilities[0].metadata, { calibration: { offset: 0.25 } });
  assert.equal(result.capabilities[0].value.type, 'scalar');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.capabilities[0].value), true);
  assert.equal(Object.isFrozen(result.capabilities), true);
  assert.equal(Object.isFrozen(result.capabilities[0].metadata?.calibration), true);
  assert.deepEqual(parseDeviceDescriptor(JSON.stringify(thermometer)), thermometer);
});

test('unknown fields, duplicate capability IDs and unnamespaced definitions fail closed', () => {
  rejects({ ...thermometer, server: 'https://example.invalid' });
  rejects({ ...thermometer, capabilities: [temperature, temperature] });
  rejects({ ...thermometer, adapter: { id: 'temperature', version: '1.0.0' } });
  rejects({ ...thermometer, capabilities: [{ ...temperature, semantic: 'temperature' }] });
  rejects({ ...thermometer, extensions: { quality: true } });
  rejects({ ...thermometer, capabilities: [{ ...temperature, extensions: { quality: true } }] });
  rejects({ ...thermometer, runtime: { platform: 'embedded-test', executable: 'code' } });
});

test('an asynchronous job is a declared reliable invoke capability', () => {
  const job = { ...temperature, id: 'print', semantic: 'example:print', kind: 'job',
    value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 },
    permissions: ['invoke'] };
  assert.deepEqual(parseDeviceDescriptor({ ...thermometer, capabilities: [job] }).capabilities[0].kind, 'job');
  rejects({ ...thermometer, capabilities: [{ ...job, kind: 'task' }] });
});

test('descriptor strings, revision, delivery and enumeration limits reject their first excess', () => {
  assert.doesNotThrow(() => parseDeviceDescriptor({ ...thermometer, id: 'x'.repeat(128), label: 'x'.repeat(160), revision: 4294967295 }));
  for (const changes of [
    { id: 'x'.repeat(129) }, { id: 'room\u0000temperature' }, { label: 'x'.repeat(161) },
    { revision: 0 }, { revision: 4294967296 }, { revision: 1.5 }, { schemaVersion: 2 },
  ]) rejects({ ...thermometer, ...changes });
  for (const delivery of [
    { mode: 'latest', maxHz: 0, maxAgeMs: 1 }, { mode: 'latest', maxHz: 1001, maxAgeMs: 1 },
    { mode: 'latest', maxHz: 1.5, maxAgeMs: 1 }, { mode: 'latest', maxHz: 1, maxAgeMs: 60001 },
    { mode: 'reliable', maxAgeMs: 1, maxHz: 1 },
  ]) rejects({ ...thermometer, capabilities: [{ ...temperature, delivery }] });
  rejects({ ...thermometer, capabilities: [{ ...temperature, permissions: ['subscribe', 'subscribe'] }] });
  rejects({ ...thermometer, capabilities: [{ ...temperature, permissions: ['execute'] }] });
  rejects({ ...thermometer, capabilities: [{ ...temperature, value: { type: 'enum', values: ['on', 'on'] } }] });
  rejects({ ...thermometer, capabilities: [{ ...temperature, value: { type: 'enum', values: [] } }] });
  rejects({ ...thermometer, capabilities: [{ ...temperature, ownership: { mode: 'partitioned', partitions: ['left', 'left'] } }] });
});

test('capability count and UTF-8 byte limits apply to strings and object input', () => {
  const capabilities = Array.from({ length: 128 }, (_, index) => ({ ...temperature, id: `temperature-${index}` }));
  assert.equal(parseDeviceDescriptor({ ...thermometer, capabilities }).capabilities.length, 128);
  rejects({ ...thermometer, capabilities: [...capabilities, { ...temperature, id: 'one-too-many' }] });
  const base = { ...thermometer, metadata: { note: '' } };
  const size = new TextEncoder().encode(JSON.stringify(base)).length;
  const exactly = { ...thermometer, metadata: { note: 'x'.repeat(65536 - size) } };
  assert.doesNotThrow(() => parseDeviceDescriptor(exactly));
  assert.doesNotThrow(() => parseDeviceDescriptor(JSON.stringify(exactly)));
  rejects({ ...thermometer, metadata: { note: `${exactly.metadata.note}x` } });
  rejects(JSON.stringify({ ...thermometer, metadata: { note: `${exactly.metadata.note}x` } }));
  rejects({ ...thermometer, metadata: { note: 'é'.repeat(32768) } });
});

test('JSON snapshots reject getters, cycles, custom prototypes, sparse arrays and non-JSON values', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls += 1; return 1; } });
  assert.throws(() => snapshotJson(getter), DeviceValidationError);
  rejects({ ...thermometer, metadata: getter });
  assert.equal(calls, 0);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => snapshotJson(cyclic), DeviceValidationError);
  const sparse = [1, 2, 3];
  delete sparse[1];
  for (const input of [new Date(), Object.create({ inherited: 1 }), sparse, undefined, NaN, Infinity, 1n, () => 1]) {
    assert.throws(() => snapshotJson(input), DeviceValidationError);
  }
  assert.throws(() => snapshotJson({ [Symbol('hidden')]: true }), DeviceValidationError);
  assert.throws(() => snapshotJson(Object.defineProperty({}, 'hidden', { value: 1 })), DeviceValidationError);
  const source = { values: [1, true, null], nested: { label: 'sensor' } };
  const copy = snapshotJson(source);
  source.values[0] = 100;
  assert.deepEqual(copy, { values: [1, true, null], nested: { label: 'sensor' } });
  assert.equal(Object.isFrozen(copy), true);
  assert.equal(Object.isFrozen((copy as JsonObject).values), true);
  const shared = { reading: 1 };
  assert.deepEqual(snapshotJson({ a: shared, b: shared }), { a: { reading: 1 }, b: { reading: 1 } });
});

test('metadata and extension snapshots bound container count and nesting without executing keys', () => {
  function nested(containers: number): JsonObject {
    let result: JsonObject = { value: 1 };
    for (let index = 1; index < containers; index += 1) result = { child: result };
    return result;
  }
  assert.doesNotThrow(() => snapshotJson(nested(8)));
  assert.throws(() => snapshotJson(nested(9)), DeviceValidationError);
  assert.doesNotThrow(() => parseDeviceDescriptor({ ...thermometer, metadata: nested(8) }));
  rejects({ ...thermometer, metadata: nested(9) });
  assert.doesNotThrow(() => parseDeviceDescriptor({ ...thermometer, extensions: { 'vendor:nesting': nested(7) } }));
  rejects({ ...thermometer, extensions: { 'vendor:nesting': nested(8) } });
  assert.doesNotThrow(() => snapshotJson(Array(128).fill(1)));
  assert.throws(() => snapshotJson(Array(129).fill(1)), DeviceValidationError);
  assert.throws(() => snapshotJson(Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key${index}`, 1]))), DeviceValidationError);
  const safe = snapshotJson(JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}')) as JsonObject;
  assert.equal(Object.hasOwn(safe, '__proto__'), true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.equal(safe.constructor, 'data');
});

test('aggregate byte overflow aborts traversal before inspecting later nested objects', () => {
  let inspectedTail = false;
  const tail = new Proxy({}, { ownKeys() { inspectedTail = true; return []; } });
  assert.throws(() => snapshotJson({ first: 'x'.repeat(32768), second: 'x'.repeat(32768), tail }), DeviceValidationError);
  assert.equal(inspectedTail, false);
  // JSON escaping, rather than just raw string length, consumes the byte budget.
  assert.throws(() => snapshotJson({ note: '\u0000'.repeat(12000) }), DeviceValidationError);
});

test('signal values retain scalar units and reject nonfinite, out-of-range or coercible input', () => {
  const schema: ValueSchema = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
  assert.equal(parseSignalValue(31.25, schema), 31.25);
  assert.equal(parseSignalValue(2.5, { type: 'scalar', unit: 'kg', min: 0, max: 50 }), 2.5);
  for (const input of [NaN, Infinity, -41, 126, '31.25', true, null]) {
    assert.throws(() => parseSignalValue(input, schema), DeviceValidationError);
  }
  assert.throws(() => parseSignalValue(1, { type: 'scalar', unit: 'Cel', min: 10, max: 0 }), DeviceValidationError);
  assert.throws(() => parseSignalValue(1, { type: 'scalar', unit: 'Cel', min: 0, max: 10, resolution: 0 }), DeviceValidationError);
});

test('vectors have exactly the declared finite coordinates and are independent immutable copies', () => {
  const schema: ValueSchema = { type: 'vector', unit: '1', min: 0, max: 1, frame: 'surface-normalized', components: ['x', 'y'] };
  const input = { x: 0.2, y: 0.8 };
  const result = parseSignalValue(input, schema);
  input.x = 1;
  assert.deepEqual(result, { x: 0.2, y: 0.8 });
  assert.equal(Object.isFrozen(result), true);
  for (const value of [{ x: 0.2 }, { x: 0.2, y: 0.8, z: 0.1 }, { x: 2, y: 0 }, { x: 0, y: NaN }, [0.2, 0.8]]) {
    assert.throws(() => parseSignalValue(value, schema), DeviceValidationError);
  }
  assert.deepEqual(parseSignalValue({ x: -1, y: 0, z: 1 }, { ...schema, min: -1, components: ['x', 'y', 'z'] }), { x: -1, y: 0, z: 1 });
});

test('boolean and enumeration schemas do not coerce or accept undeclared choices', () => {
  assert.equal(parseSignalValue(false, { type: 'boolean' }), false);
  assert.throws(() => parseSignalValue(0, { type: 'boolean' }), DeviceValidationError);
  assert.equal(parseSignalValue('on', { type: 'enum', values: ['off', 'on'] }), 'on');
  assert.throws(() => parseSignalValue('ON', { type: 'enum', values: ['off', 'on'] }), DeviceValidationError);
});

test('compatibility requires exact semantic, version, units, frame, range and representation', () => {
  const reordered = { ...temperature, value: { max: 125, min: -40, unit: 'Cel', type: 'scalar' } } as DeviceCapability;
  assert.equal(schemasCompatible(temperature, reordered), true);
  for (const changed of [
    { ...temperature, semantic: 'example:weight' }, { ...temperature, schemaVersion: 2 },
    { ...temperature, value: { type: 'scalar', unit: 'K', min: -40, max: 125 } },
    { ...temperature, value: { type: 'scalar', unit: 'Cel', min: 0, max: 125 } },
    { ...temperature, value: { type: 'scalar', unit: 'Cel', min: -40, max: 125, resolution: 0.5 } },
    { ...temperature, value: { type: 'scalar', unit: 'Cel', min: -40, max: 125, frame: 'relative' } },
    { ...temperature, value: { type: 'boolean' } },
  ]) assert.equal(schemasCompatible(temperature, changed as DeviceCapability), false);
});

test('draft-07 editor schema agrees with runtime structural fixtures', () => {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(DEVICE_DESCRIPTOR_SCHEMA);
  const valid = [
    thermometer,
    { ...thermometer, capabilities: [{ ...temperature, value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 50 }, ownership: { mode: 'exclusive' }, permissions: ['invoke'] }] },
    { ...thermometer, capabilities: [{ ...temperature, kind: 'job', value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 50 }, permissions: ['invoke'] }] },
    { ...thermometer, capabilities: [{ ...temperature, value: { type: 'vector', unit: '1', frame: 'surface-normalized', min: 0, max: 1, components: ['x', 'y'] } }], extensions: { 'vendor:info': { version: 1 } } },
  ];
  const invalid = [
    { ...thermometer, unknown: true }, { ...thermometer, revision: 0 },
    { ...thermometer, adapter: { id: 'missing-namespace', version: '1' } },
    { ...thermometer, capabilities: [{ ...temperature, value: { type: 'boolean', unit: '1' } }] },
    { ...thermometer, capabilities: [{ ...temperature, value: { type: 'vector', unit: '1', min: 0, max: 1, frame: 'normalized', components: ['y', 'x'] } }] },
    { ...thermometer, capabilities: [{ ...temperature, value: { type: 'enum', values: ['on', 'on'] } }] },
    { ...thermometer, extensions: { invalid: true } },
    { ...thermometer, capabilities: [{ ...temperature, permissions: ['read', 'read'] }] },
  ];
  for (const fixture of valid) {
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => parseDeviceDescriptor(fixture));
  }
  for (const fixture of invalid) {
    assert.equal(validate(fixture), false, JSON.stringify(fixture));
    rejects(fixture);
  }
});
