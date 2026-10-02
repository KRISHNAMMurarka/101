import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { DEVICE_DESCRIPTOR_SCHEMA, DeviceValidationError, parseDeviceDescriptor, parseSignalValue, parseValueSchema, schemasCompatible } from './index.ts';
import type { DeviceCapability, ValueSchema } from './index.ts';

const modifiers = { shift: false, control: false, alt: false, meta: false };
const declarations: ValueSchema[] = [
  { type: 'contact', frame: 'surface-normalized' },
  { type: 'pen', frame: 'surface-normalized' },
  { type: 'key' },
  { type: 'text', maxLength: 32 },
  { type: 'wheel', maxDelta: 1000 },
  { type: 'relative-motion', frame: 'viewport', maxDelta: 1000 },
];
const values = [
  { id: 'pointer:1', phase: 'down', position: { x: 0.2, y: 0.8 }, primary: true },
  { id: 'pointer:2', phase: 'move', position: { x: 0.4, y: 0.6 }, primary: true,
    pressure: 0.5, tiltX: -20, tiltY: 30, twist: 359 },
  { code: 'KeyA', key: 'a', phase: 'down', repeat: false, location: 0, composing: false, modifiers },
  { compositionId: 'composition:1', phase: 'update', text: 'न' },
  { x: 0, y: -120, z: 0, mode: 'pixel', modifiers },
  { x: 4, y: -2, unit: 'css-px', locked: true },
];

function descriptor(value: ValueSchema, version = 2, kind = 'event', delivery: unknown = { mode: 'reliable', maxAgeMs: 1000 }) {
  return { schemaVersion: 1, id: 'input-fixture', label: 'Simulated rich input', revision: 1,
    adapter: { id: 'test:rich-input', version: '1' }, runtime: { platform: 'embedded' },
    capabilities: [{ id: 'input', semantic: 'test:rich-input', schemaVersion: version, kind,
      value, delivery, permissions: ['subscribe'] }] };
}
function capability(value: ValueSchema): DeviceCapability {
  return descriptor(value).capabilities[0] as DeviceCapability;
}

test('six rich input schemas require version-two reliable event capabilities, even nested', () => {
  const validate = new Ajv().compile(DEVICE_DESCRIPTOR_SCHEMA);
  for (const schema of declarations) {
    assert.deepEqual(parseValueSchema(schema), schema);
    assert.doesNotThrow(() => parseDeviceDescriptor(descriptor(schema)));
    assert.equal(validate(descriptor(schema)), true, JSON.stringify(validate.errors));
    for (const changed of [descriptor(schema, 1), descriptor(schema, 2, 'sample'),
      descriptor(schema, 2, 'event', { mode: 'latest', maxHz: 60, maxAgeMs: 1000 })])
      assert.throws(() => parseDeviceDescriptor(changed), DeviceValidationError);
  }
  const nested: ValueSchema = { type: 'record', fields: { event: declarations[2] } };
  assert.doesNotThrow(() => parseDeviceDescriptor(descriptor(nested)));
  assert.throws(() => parseDeviceDescriptor(descriptor(nested, 1)), DeviceValidationError);
  assert.throws(() => parseDeviceDescriptor(descriptor(nested, 2, 'sample')), DeviceValidationError);
  assert.equal(schemasCompatible({ ...capability(declarations[0]), schemaVersion: 1 },
    { ...capability(declarations[0]), schemaVersion: 1 }), false);
});

test('all rich input values remain separate closed immutable snapshots', () => {
  for (let index = 0; index < declarations.length; index++) {
    const input = structuredClone(values[index]);
    const parsed = parseSignalValue(input, declarations[index]);
    assert.deepEqual(parsed, values[index]);
    assert.equal(Object.isFrozen(parsed), true);
    Object.assign(input, { extra: true });
    assert.deepEqual(parsed, values[index]);
    assert.throws(() => parseSignalValue({ ...values[index], extra: true }, declarations[index]), DeviceValidationError);
  }
});

test('contact and pen preserve edges, position and bounded stylus measurements', () => {
  const contact = declarations[0], pen = declarations[1];
  for (const phase of ['down', 'move', 'up', 'cancel']) {
    assert.doesNotThrow(() => parseSignalValue({ ...values[0], phase }, contact));
    assert.doesNotThrow(() => parseSignalValue({ ...values[1], phase }, pen));
  }
  for (const invalid of [
    { ...values[0], id: '' }, { ...values[0], phase: 'hover' },
    { ...values[0], position: { x: 1.1, y: 0 } },
    { ...values[0], position: { x: 0.5, y: 0.5, z: 0 } },
    { ...values[0], primary: 1 },
  ]) assert.throws(() => parseSignalValue(invalid, contact), DeviceValidationError);
  for (const invalid of [
    { ...values[1], pressure: 1.1 }, { ...values[1], tiltX: -91 },
    { ...values[1], tiltY: 91 }, { ...values[1], twist: 360 },
  ]) assert.throws(() => parseSignalValue(invalid, pen), DeviceValidationError);
});

test('key transitions are distinct from text and IME end is not an implicit commit', () => {
  const key = declarations[2], text = declarations[3];
  assert.deepEqual(parseSignalValue({ ...values[2], phase: 'up' }, key), { ...values[2], phase: 'up' });
  assert.deepEqual(parseSignalValue({ ...values[3], phase: 'end' }, text), { ...values[3], phase: 'end' });
  assert.deepEqual(parseSignalValue({ ...values[3], phase: 'commit', text: '' }, text), { ...values[3], phase: 'commit', text: '' });
  for (const invalid of [
    { ...values[2], phase: 'up', repeat: true }, { ...values[2], code: '' },
    { ...values[2], location: 4 }, { ...values[2], modifiers: { ...modifiers, fn: true } },
    { ...values[2], key: '\n' },
  ]) assert.throws(() => parseSignalValue(invalid, key), DeviceValidationError);
  assert.throws(() => parseSignalValue({ ...values[3], text: 'x'.repeat(33) }, text), DeviceValidationError);
  assert.doesNotThrow(() => parseSignalValue({ ...values[3], text: '😀'.repeat(32) }, text));
  assert.throws(() => parseSignalValue({ ...values[3], phase: 'input' }, text), DeviceValidationError);
});

test('wheel mode and relative deltas are not silently converted or accumulated', () => {
  for (const mode of ['pixel', 'line', 'page']) assert.doesNotThrow(() => parseSignalValue({ ...values[4], mode }, declarations[4]));
  assert.deepEqual(parseSignalValue(values[5], declarations[5]), values[5]);
  for (const [schema, invalid] of [
    [declarations[4], { ...values[4], mode: 'css-px' }],
    [declarations[4], { ...values[4], y: -1001 }],
    [declarations[5], { ...values[5], unit: 'normalized' }],
    [declarations[5], { ...values[5], x: 1001 }],
  ] as const) assert.throws(() => parseSignalValue(invalid, schema), DeviceValidationError);
  assert.equal(schemasCompatible(capability(declarations[4]), capability({ type: 'wheel', maxDelta: 2000 })), false);
  assert.equal(schemasCompatible(capability(declarations[5]), capability({ type: 'relative-motion', frame: 'other', maxDelta: 1000 })), false);
});
