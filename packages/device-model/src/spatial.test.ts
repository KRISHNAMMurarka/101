import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { createSpatialPoseConverter, DEVICE_DESCRIPTOR_SCHEMA, DeviceValidationError,
  parseDeviceDescriptor, parseSignalValue, parseValueSchema, schemasCompatible } from './index.ts';
import type { DeviceCapability, SpatialFrame, ValueSchema } from './index.ts';

const right: SpatialFrame = { id: 'test:right', origin: 'test:room', unit: 'm', axes: ['right', 'up', 'forward'], handedness: 'right' };
const centimeters: SpatialFrame = { ...right, id: 'test:cm', unit: 'cm' };
const left: SpatialFrame = { ...right, id: 'test:left', axes: ['left', 'up', 'forward'], handedness: 'left' };
const other: SpatialFrame = { ...right, id: 'test:other', origin: 'test:other-room' };
const pose: ValueSchema = { type: 'pose', frame: right, extent: 2 };
const q = { x: 0, y: 0, z: 0, w: 1 };
const sample = { position: { x: 1, y: 0.5, z: -1 }, orientation: q };

function descriptor(schema: ValueSchema, version = 2) {
  return { schemaVersion: 1, id: 'spatial-fixture', label: 'Simulated spatial fixture', revision: 1,
    adapter: { id: 'test:spatial', version: '1' }, runtime: { platform: 'embedded' },
    capabilities: [{ id: 'pose', semantic: 'test:spatial-pose', schemaVersion: version,
      kind: 'sample', value: schema, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }] };
}
function capability(value: ValueSchema): DeviceCapability {
  return { ...descriptor(value).capabilities[0], value } as DeviceCapability;
}
function rejects(value: unknown, code?: string) {
  assert.throws(() => parseValueSchema(value), (error: unknown) => error instanceof DeviceValidationError && (!code || error.code === code));
}

test('spatial schemas require capability v2, including nested declarations, while v1 values stay valid', () => {
  assert.deepEqual(parseDeviceDescriptor(descriptor(pose)).capabilities[0].value, pose);
  assert.throws(() => parseDeviceDescriptor(descriptor(pose, 1)), DeviceValidationError);
  assert.throws(() => parseDeviceDescriptor(descriptor({ type: 'record', fields: { pose } }, 1)), DeviceValidationError);
  assert.equal(schemasCompatible({ ...capability(pose), schemaVersion: 1 }, { ...capability(pose), schemaVersion: 1 }), false);
  assert.doesNotThrow(() => parseDeviceDescriptor(descriptor({ type: 'vector', unit: 'old arbitrary label', min: 0, max: 1, frame: 'legacy', components: ['x', 'y'] }, 1)));
  const validate = new Ajv().compile(DEVICE_DESCRIPTOR_SCHEMA);
  for (const schema of [pose, { type: 'quaternion', frame: right },
    { type: 'joints', frame: right, extent: 2, joints: [{ name: 'wrist' }] },
    { type: 'transform', from: right, to: other, maxTranslation: 1 }] as ValueSchema[]) {
    assert.equal(validate(descriptor(schema)), true, JSON.stringify(validate.errors));
    assert.doesNotThrow(() => parseDeviceDescriptor(descriptor(schema)));
  }
});

test('depth-four nested spatial schemas and values reach the advertised schema limit', () => {
  const fourth: ValueSchema = { type: 'record', fields: { a: { type: 'record', fields: {
    a: { type: 'record', fields: { a: pose } },
  } } } };
  const value = { a: { a: { a: sample } } };
  assert.deepEqual(parseValueSchema(fourth), fourth);
  assert.deepEqual(parseSignalValue(value, fourth), value);
  assert.doesNotThrow(() => parseDeviceDescriptor(descriptor(fourth)));
  assert.throws(() => parseDeviceDescriptor(descriptor(fourth, 1)), DeviceValidationError);
  assert.throws(() => parseValueSchema({ type: 'record', fields: { a: fourth } }), DeviceValidationError);
});

test('frame axis permutations, handedness, IDs and metric units are exact and bounded', () => {
  assert.doesNotThrow(() => parseValueSchema({ type: 'quaternion', frame: left }));
  for (const frame of [
    { ...right, axes: ['right', 'up', 'backward'] },
    { ...right, axes: ['right', 'left', 'forward'] },
    { ...right, axes: ['right', 'up', 'forward'], handedness: 'left' },
    { ...right, unit: 'deg' }, { ...right, id: 'no-namespace' },
    { ...right, extra: true },
  ]) rejects({ type: 'pose', frame, extent: 1 });
  rejects({ type: 'pose', frame: right, extent: 0 });
  rejects({ type: 'pose', frame: right, extent: Infinity });
});

test('quaternion, pose, joint and transform values are strict immutable snapshots', () => {
  const source = structuredClone(sample);
  const parsed = parseSignalValue(source, pose);
  source.position.x = 0;
  assert.deepEqual(parsed, sample);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen((parsed as typeof sample).position), true);
  assert.equal(Object.isFrozen((parsed as typeof sample).orientation), true);
  for (const invalid of [
    { ...sample, position: { x: 2.1, y: 0, z: 0 } },
    { ...sample, orientation: { x: 0, y: 0, z: 0, w: 0 } },
    { ...sample, orientation: { ...q, extra: 1 } },
    { ...sample, extra: 1 },
  ]) assert.throws(() => parseSignalValue(invalid, pose), DeviceValidationError);
  assert.deepEqual(parseSignalValue({ x: 0, y: 0, z: 0.7074602462329598, w: 0.7074602462329598 }, { type: 'quaternion', frame: right }),
    { x: 0, y: 0, z: 0.7074602462329598, w: 0.7074602462329598 });
  assert.deepEqual(Object.keys(parseSignalValue({ w: 1, z: 0, y: 0, x: 0 }, { type: 'quaternion', frame: right })), ['x', 'y', 'z', 'w']);
  const joints: ValueSchema = { type: 'joints', frame: right, extent: 2,
    joints: [{ name: 'wrist' }, { name: 'index', parent: 'wrist' }], optional: ['index'] };
  assert.deepEqual(parseSignalValue({ wrist: sample }, joints), { wrist: sample });
  assert.deepEqual(parseSignalValue({ wrist: sample, index: sample }, joints), { wrist: sample, index: sample });
  assert.throws(() => parseSignalValue({ index: sample }, joints), DeviceValidationError);
  assert.throws(() => parseSignalValue({ wrist: sample, extra: sample }, joints), DeviceValidationError);
  const transform: ValueSchema = { type: 'transform', from: right, to: other, maxTranslation: 10 };
  assert.deepEqual(parseSignalValue({ translation: { x: 1, y: 2, z: 3 }, rotation: q, mirrored: false }, transform),
    { translation: { x: 1, y: 2, z: 3 }, rotation: q, mirrored: false });
  assert.throws(() => parseSignalValue({ translation: { x: 1, y: 2, z: 3 }, rotation: q, mirrored: true }, transform), DeviceValidationError);
});

test('joint hierarchy is bounded, safe, acyclic and compatible by named structure', () => {
  const schema: ValueSchema = { type: 'joints', frame: right, extent: 2,
    joints: [{ name: 'wrist' }, { name: 'index', parent: 'wrist' }], optional: ['index'] };
  for (const joints of [
    [{ name: 'wrist' }, { name: 'wrist' }], [{ name: 'index', parent: 'missing' }],
    [{ name: 'wrist', parent: 'index' }, { name: 'index', parent: 'wrist' }],
    [{ name: 'constructor' }], Array.from({ length: 33 }, (_, index) => ({ name: `joint${index}` })),
  ]) rejects({ ...schema, joints });
  assert.equal(schemasCompatible(capability(pose), capability({ ...pose, frame: centimeters })), false);
  assert.equal(schemasCompatible(capability(schema), capability({ ...schema, joints: [{ name: 'index', parent: 'wrist' }, { name: 'wrist' }] })), true);
  assert.equal(schemasCompatible(capability(schema), capability({ ...schema, optional: [] })), false);
});

test('explicit pose converter scales axes and handedness, with immutable provenance', () => {
  const target: ValueSchema = { type: 'pose', frame: { ...left, unit: 'cm' }, extent: 200 };
  const converter = createSpatialPoseConverter(pose, target, { decimalPlaces: 2, maxAbsoluteError: 0.01 });
  const result = converter.convert(sample) as typeof sample;
  assert.deepEqual(result.position, { x: -100, y: 50, z: -100 });
  assert.deepEqual(result.orientation, q);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(converter.metadata), true);
  assert.equal(converter.metadata.mirrored, true);
  assert.throws(() => createSpatialPoseConverter(pose, { ...target, extent: 199 }, { decimalPlaces: 2, maxAbsoluteError: 0.01 }), DeviceValidationError);
});

test('different origins require a matching transform and near-unit rotation preserves lengths', () => {
  const target: ValueSchema = { type: 'pose', frame: other, extent: 3 };
  const transform: ValueSchema = { type: 'transform', from: right, to: other, maxTranslation: 1 };
  const rotation = { x: 0, y: 0, z: 0.7074602462329598, w: 0.7074602462329598 };
  assert.throws(() => createSpatialPoseConverter(pose, target, { decimalPlaces: 6, maxAbsoluteError: 0.000001 }), DeviceValidationError);
  const converter = createSpatialPoseConverter(pose, target, { decimalPlaces: 6, maxAbsoluteError: 0.000001,
    transform: { schema: transform, value: { translation: { x: 0, y: 0, z: 0 }, rotation, mirrored: false } } });
  const result = converter.convert({ position: { x: 1, y: 0, z: 0 }, orientation: q }) as typeof sample;
  assert.ok(Math.abs(result.position.x) < 0.000001);
  assert.equal(result.position.y, 1);
  assert.throws(() => createSpatialPoseConverter(pose, target, { decimalPlaces: 6, maxAbsoluteError: 0.000001,
    transform: { schema: { ...transform, from: left }, value: { translation: { x: 0, y: 0, z: 0 }, rotation: q, mirrored: true } } }), DeviceValidationError);
});

test('composition of two admitted near-unit rotations remains a valid pure rotation', () => {
  const target: ValueSchema = { type: 'pose', frame: other, extent: 3 };
  const transform: ValueSchema = { type: 'transform', from: right, to: other, maxTranslation: 1 };
  for (const component of [0.7077782138495081, 0.7064347103589971]) {
    const rotation = { x: 0, y: 0, z: component, w: component };
    const converter = createSpatialPoseConverter(pose, target, { decimalPlaces: 6, maxAbsoluteError: 0.000001,
      transform: { schema: transform, value: { translation: { x: 0, y: 0, z: 0 }, rotation, mirrored: false } } });
    const result = converter.convert({ position: { x: 1, y: 0, z: 0 }, orientation: rotation }) as typeof sample;
    assert.ok(Math.abs(result.position.x) < 0.000001);
    assert.equal(result.position.y, 1);
    assert.ok(Math.abs(result.orientation.z) <= 1);
    assert.ok(Math.abs(result.orientation.w) < 0.000001);
    assert.ok(Math.abs(result.orientation.z ** 2 + result.orientation.w ** 2 - 1) < 0.000001);
  }
});

test('converter admission preserves the strict target extent without epsilon overhang', () => {
  assert.throws(() => createSpatialPoseConverter({ type: 'pose', frame: right, extent: 1 },
    { type: 'pose', frame: right, extent: 1 - Number.EPSILON },
    { decimalPlaces: 12, maxAbsoluteError: 0.000001 }), DeviceValidationError);
});

test('rotated source-box corners must fit the entire target extent', () => {
  const rotation = { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) };
  const schema: ValueSchema = { type: 'transform', from: right, to: other, maxTranslation: 1 };
  const options = { decimalPlaces: 6, maxAbsoluteError: 0.000001,
    transform: { schema, value: { translation: { x: 0, y: 0, z: 0 }, rotation, mirrored: false } } };
  assert.throws(() => createSpatialPoseConverter({ type: 'pose', frame: right, extent: 1 },
    { type: 'pose', frame: other, extent: 1.4 }, options), DeviceValidationError);
  assert.doesNotThrow(() => createSpatialPoseConverter({ type: 'pose', frame: right, extent: 1 },
    { type: 'pose', frame: other, extent: 1.42 }, options));
});

test('computed near-unit composition does not overflow a quaternion component by one ulp', () => {
  const rotation = { x: 0, y: 0, z: 0.7071071400000001, w: 0.7071071400000001 };
  const target: ValueSchema = { type: 'pose', frame: other, extent: 3 };
  const transform: ValueSchema = { type: 'transform', from: right, to: other, maxTranslation: 1 };
  const converter = createSpatialPoseConverter(pose, target, { decimalPlaces: 6, maxAbsoluteError: 0.000001,
    transform: { schema: transform, value: { translation: { x: 0, y: 0, z: 0 }, rotation, mirrored: false } } });
  const output = converter.convert({ position: { x: 0, y: 0, z: 0 }, orientation: rotation }) as typeof sample;
  assert.equal(output.orientation.z, 1);
  assert.ok(Math.abs(output.orientation.w) < 0.000001);
});

test('all 48 signed axis permutations preserve rotation meaning across handedness', () => {
  type Vec = readonly [number, number, number];
  const basis: Record<string, Vec> = { right: [1, 0, 0], left: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
    forward: [0, 0, 1], backward: [0, 0, -1] };
  const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const map = (axes: readonly string[], v: Vec): Vec => axes.map((axis) => dot(basis[axis], v)) as unknown as Vec;
  const rotate = (q: { x: number; y: number; z: number; w: number }, v: Vec): Vec => {
    const norm = Math.hypot(q.x, q.y, q.z, q.w), vector: Vec = [q.x / norm, q.y / norm, q.z / norm];
    const twice = cross(vector, v).map(value => 2 * value) as unknown as Vec;
    const remainder = cross(vector, twice);
    return v.map((value, index) => value + q.w / norm * twice[index] + remainder[index]) as unknown as Vec;
  };
  const sourceOrientation = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
  const input = { position: { x: 1, y: 0.2, z: -0.4 }, orientation: sourceOrientation };
  const pairs = [['right', 'left'], ['up', 'down'], ['forward', 'backward']];
  let count = 0;
  for (const a of pairs) for (const b of pairs) for (const c of pairs) {
    if (a === b || a === c || b === c) continue;
    for (const x of a) for (const y of b) for (const z of c) {
      const axes = [x, y, z] as SpatialFrame['axes'];
      const parity = dot(basis[x], cross(basis[y], basis[z]));
      const frame: SpatialFrame = { ...right, id: `test:permutation-${count}`, axes, handedness: parity === 1 ? 'right' : 'left' };
      const converter = createSpatialPoseConverter(pose, { type: 'pose', frame, extent: 2 },
        { decimalPlaces: 6, maxAbsoluteError: 0.000001 });
      const output = converter.convert(input) as typeof input;
      const actual = rotate(output.orientation, map(axes, [1, 0, 0]));
      const expected = map(axes, rotate(sourceOrientation, [1, 0, 0]));
      for (let index = 0; index < 3; index++) assert.ok(Math.abs(actual[index] - expected[index]) < 1e-9, JSON.stringify({ axes, actual, expected }));
      const mappedPosition = map(axes, [1, 0.2, -0.4]);
      for (let index = 0; index < 3; index++) assert.ok(Math.abs(Object.values(output.position)[index] - mappedPosition[index]) < 1e-6);
      count++;
    }
  }
  assert.equal(count, 48);
});
