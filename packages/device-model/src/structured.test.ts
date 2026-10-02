import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { DEVICE_DESCRIPTOR_SCHEMA, DeviceValidationError, parseDeviceDescriptor, parseSignalValue, parseValueSchema, schemasCompatible } from './index.ts';
import type { DeviceCapability, DeviceDescriptor, SignalValue, ValueSchema } from './index.ts';

const boolean: ValueSchema = { type: 'boolean' };
const scalar: ValueSchema = { type: 'scalar', unit: 'By', min: 0, max: 1000000000 };
const batch: ValueSchema = {
  type: 'array', minItems: 1, maxItems: 16,
  items: {
    type: 'record', fields: {
      timestamp: { type: 'scalar', unit: 'ms', min: 0, max: 1000000 },
      residentBytes: scalar,
      quality: { type: 'enum', values: ['observed', 'unverified'] },
    }, optional: ['quality'],
  },
};

function capability(value: ValueSchema): DeviceCapability {
  return {
    id: 'telemetry', semantic: 'example:telemetry-batch', schemaVersion: 1,
    kind: 'sample', value, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: ['subscribe'],
  };
}

function descriptor(value: ValueSchema): DeviceDescriptor {
  return {
    schemaVersion: 1, id: 'telemetry-fixture', label: 'Telemetry fixture', revision: 1,
    adapter: { id: 'example:telemetry', version: '1' }, runtime: { platform: 'contract-test' },
    capabilities: [capability(value)],
  };
}

function rejectsSchema(value: unknown, code?: string) {
  assert.throws(() => parseValueSchema(value), (error: unknown) => error instanceof DeviceValidationError && (code === undefined || error.code === code));
}

function assertFrozen(value: SignalValue) {
  if (typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozen(child);
}

test('a bounded telemetry batch accepts nested records with an omitted optional field', () => {
  // Contract fixture: timestamps and memory values are not live sensor readings.
  assert.deepEqual(parseSignalValue([{ timestamp: 12.5, residentBytes: 4096 }], batch), [
    { timestamp: 12.5, residentBytes: 4096 },
  ]);
});

test('nested values are independent deep frozen snapshots with present optional fields', () => {
  const schema: ValueSchema = {
    type: 'record', fields: {
      readings: batch,
      pointer: { type: 'vector', unit: '1', min: 0, max: 1, frame: 'normalized', components: ['x', 'y'] },
      ready: boolean,
    },
  };
  const source = { readings: [{ timestamp: 5, residentBytes: 512, quality: 'observed' }], pointer: { x: 0.25, y: 0.75 }, ready: true };
  const result = parseSignalValue(source, schema);
  source.readings[0].residentBytes = 2048;
  source.pointer.x = 1;
  source.readings.push({ timestamp: 10, residentBytes: 4096, quality: 'unverified' });
  assert.deepEqual(result, { readings: [{ timestamp: 5, residentBytes: 512, quality: 'observed' }], pointer: { x: 0.25, y: 0.75 }, ready: true });
  assertFrozen(result);
  assert.deepEqual(parseDeviceDescriptor(JSON.stringify(descriptor(schema))).capabilities[0].value, schema);
});

test('recursive value validation never drops unknown fields or fills missing required fields', () => {
  for (const value of [
    [], [{ timestamp: 1 }], [{ residentBytes: 512 }], [{ timestamp: 1, residentBytes: 512, extra: true }],
    [{ timestamp: 1, residentBytes: 512, quality: null }], [{ timestamp: 1, residentBytes: 512, quality: undefined }],
    [{ timestamp: 1, residentBytes: '512' }], [{ timestamp: -1, residentBytes: 512 }],
    [{ timestamp: 1, residentBytes: 512, quality: 'trusted' }], [null], [undefined], {}, null,
  ]) assert.throws(() => parseSignalValue(value, batch), DeviceValidationError);
  assert.throws(() => parseSignalValue([{ timestamp: 1, residentBytes: 512, quality: 'trusted' }], batch), (error: unknown) => error instanceof DeviceValidationError && error.path === '$[0].quality');
});

test('each input container is snapshotted once before recursive value validation', () => {
  let recordSnapshots = 0;
  const record = new Proxy({ timestamp: 1, residentBytes: 512 }, { ownKeys(target) { recordSnapshots += 1; return Reflect.ownKeys(target); } });
  assert.deepEqual(parseSignalValue([record], batch), [{ timestamp: 1, residentBytes: 512 }]);
  assert.equal(recordSnapshots, 1);
});

test('nested executable and malformed JSON data fail without evaluating getters', () => {
  let getterCalls = 0;
  const getter = Object.defineProperty({ timestamp: 1 }, 'residentBytes', { enumerable: true, get() { getterCalls += 1; return 512; } });
  const sparse = [{ timestamp: 1, residentBytes: 512 }, { timestamp: 2, residentBytes: 1024 }];
  delete sparse[0];
  const cyclic: Record<string, unknown> = { timestamp: 1, residentBytes: 512 };
  cyclic.self = cyclic;
  const extraArray = Object.assign([{ timestamp: 1, residentBytes: 512 }], { extra: true });
  for (const value of [
    [getter], sparse, extraArray, [cyclic], [new Date()], [Object.create({ timestamp: 1, residentBytes: 512 })],
    [{ timestamp: 1, residentBytes: NaN }], [{ timestamp: 1, residentBytes: Infinity }],
    [{ timestamp: 1, residentBytes: 1n }], [{ timestamp: 1, residentBytes: () => 512 }],
    [{ timestamp: 1, residentBytes: 512, [Symbol('hidden')]: true }],
    [Object.defineProperty({ timestamp: 1, residentBytes: 512 }, 'hidden', { value: true })],
  ]) assert.throws(() => parseSignalValue(value, batch), DeviceValidationError);
  rejectsSchema({ type: 'record', fields: { reading: Object.defineProperty({}, 'type', { enumerable: true, get() { getterCalls += 1; return 'boolean'; } }) } });
  assert.equal(getterCalls, 0);
});

test('record declarations enforce bounded safe names and declared unique optional members', () => {
  const fields = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field_${index}`, boolean]));
  assert.doesNotThrow(() => parseValueSchema({ type: 'record', fields }));
  assert.doesNotThrow(() => parseValueSchema({ type: 'record', fields: { ['a'.repeat(128)]: boolean }, optional: [] }));
  for (const invalid of [
    { type: 'record', fields: {} }, { type: 'record', fields: { ...fields, excess: boolean } },
    { type: 'record', fields: { ['a'.repeat(129)]: boolean } },
    ...['', 'two words', 'a.b', 'a/b', '1reading', '__proto__', 'constructor', 'prototype'].map((name) => ({ type: 'record', fields: Object.fromEntries([[name, boolean]]) })),
    { type: 'record', fields: { reading: boolean }, optional: ['missing'] },
    { type: 'record', fields: { reading: boolean }, optional: ['reading', 'reading'] },
    { type: 'record', fields: { reading: boolean }, optional: null },
    { type: 'record', fields: { reading: boolean }, unknown: true },
    { type: 'record', fields: { reading: { type: 'boolean', unknown: true } } },
  ]) rejectsSchema(invalid);
});

test('array schema and value bounds accept zero and 128 but reject their first excess', () => {
  const schema: ValueSchema = { type: 'array', items: boolean, minItems: 0, maxItems: 128 };
  assert.deepEqual(parseSignalValue([], schema), []);
  assert.equal((parseSignalValue(Array(128).fill(true), schema) as readonly SignalValue[]).length, 128);
  assert.throws(() => parseSignalValue(Array(129).fill(true), schema), DeviceValidationError);
  for (const [minItems, maxItems] of [[-1, 1], [0, 129], [2, 1], [0.5, 1], [0, 1.5], [NaN, 1], [0, Infinity]]) {
    rejectsSchema({ type: 'array', items: boolean, minItems, maxItems });
  }
  rejectsSchema({ type: 'array', items: boolean, maxItems: 1 });
  rejectsSchema({ type: 'array', items: boolean, minItems: 0, maxItems: 1, unknown: true });
});

test('schema nesting allows four nodes along a path and rejects a fifth', () => {
  const four: ValueSchema = { type: 'record', fields: { group: { type: 'record', fields: { batch: { type: 'array', items: boolean, minItems: 0, maxItems: 1 } } } } };
  assert.deepEqual(parseSignalValue({ group: { batch: [true] } }, four), { group: { batch: [true] } });
  assert.doesNotThrow(() => parseDeviceDescriptor(descriptor(four)));
  rejectsSchema({ type: 'array', items: four, minItems: 0, maxItems: 1 }, 'schema-depth-limit');
});

test('schema node budget counts all declared occurrences, allowing 256 and rejecting 257', () => {
  function tree(lastFields: number): ValueSchema {
    return {
      type: 'record', fields: Object.fromEntries(Array.from({ length: 8 }, (_, branch) => [
        `branch${branch}`, { type: 'record', fields: Object.fromEntries(Array.from({ length: branch === 7 ? lastFields : 31 }, (_, leaf) => [`leaf${leaf}`, boolean])) },
      ])),
    };
  }
  assert.doesNotThrow(() => parseValueSchema(tree(30)));
  rejectsSchema(tree(31), 'schema-node-limit');
});

test('structured schema and value snapshots retain the existing aggregate JSON byte budget', () => {
  const text = 'x'.repeat(128);
  const fields: Record<string, ValueSchema> = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field${index}`, { type: 'enum', values: [text] }]));
  const schema: ValueSchema = { type: 'array', minItems: 0, maxItems: 128, items: { type: 'record', fields } };
  const row = Object.fromEntries(Object.keys(fields).map((name) => [name, text]));
  assert.doesNotThrow(() => parseSignalValue(Array(14).fill(row), schema));
  assert.throws(() => parseSignalValue(Array(16).fill(row), schema), (error: unknown) => error instanceof DeviceValidationError && error.code === 'byte-limit');
  const hugeFields = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field${index}`, { type: 'enum', values: Array.from({ length: 64 }, (_, choice) => `${choice}${text.slice(3)}`) }]));
  rejectsSchema({ type: 'record', fields: hugeFields }, 'byte-limit');
});

test('recursive compatibility ignores record and optional ordering while retaining exact meaning', () => {
  const source: ValueSchema = {
    type: 'record', fields: { batch, active: boolean, count: scalar }, optional: ['count', 'active'],
  };
  const reordered: ValueSchema = {
    type: 'record', fields: { count: scalar, active: boolean, batch }, optional: ['active', 'count'],
  };
  assert.equal(schemasCompatible(capability(source), capability(reordered)), true);
  assert.equal(schemasCompatible(capability({ type: 'record', fields: { active: boolean } }), capability({ type: 'record', fields: { active: boolean }, optional: [] })), true);
  for (const changed of [
    { ...capability(source), semantic: 'example:other' }, { ...capability(source), schemaVersion: 2 },
    capability({ ...source, optional: ['count'] }), capability({ ...source, fields: { ...source.fields, extra: boolean } }),
    capability({ ...source, fields: { ...source.fields, batch: { ...batch, minItems: 0 } } }),
    capability({ ...source, fields: { ...source.fields, batch: { ...batch, maxItems: 17 } } }),
    capability({ ...source, fields: { ...source.fields, count: { ...scalar, unit: 'KiBy' } } }),
    capability({ ...source, fields: { ...source.fields, count: { ...scalar, max: 1000000001 } } }),
    capability({ ...source, fields: { ...source.fields, batch: { ...batch, items: { type: 'record', fields: { timestamp: scalar, residentBytes: scalar } } } } }),
  ]) {
    assert.equal(schemasCompatible(capability(source), changed), false);
    assert.equal(schemasCompatible(changed, capability(source)), false);
  }
});

test('draft-07 editor schema matches recursive structural fixtures and annotates runtime bounds', () => {
  const validate = new Ajv({ allErrors: true }).compile(DEVICE_DESCRIPTOR_SCHEMA);
  for (const schema of [batch, { type: 'array', minItems: 0, maxItems: 128, items: boolean }, { type: 'record', fields: { ready: boolean }, optional: [] }] as ValueSchema[]) {
    assert.equal(validate(descriptor(schema)), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => parseDeviceDescriptor(descriptor(schema)));
  }
  for (const schema of [
    { type: 'record', fields: {} }, { type: 'record', fields: { ['a'.repeat(129)]: boolean } },
    { type: 'record', fields: { constructor: boolean } }, { type: 'record', fields: { 'bad.name': boolean } },
    { type: 'record', fields: { ready: boolean }, optional: ['ready', 'ready'] },
    { type: 'array', minItems: -1, maxItems: 1, items: boolean },
    { type: 'array', minItems: 0, maxItems: 129, items: boolean },
    { type: 'array', minItems: 0, maxItems: 1, items: { type: 'boolean', extra: true } },
  ]) {
    assert.equal(validate(descriptor(schema as ValueSchema)), false, JSON.stringify(schema));
    rejectsSchema(schema);
  }
  const runtime = DEVICE_DESCRIPTOR_SCHEMA['x-runtime-validation'];
  assert.equal(runtime.valueSchemaMaxDepth, 4);
  assert.equal(runtime.valueSchemaMaxNodes, 256);
  rejectsSchema({ type: 'array', minItems: 2, maxItems: 1, items: boolean });
  rejectsSchema({ type: 'record', fields: { ready: boolean }, optional: ['missing'] });
});
