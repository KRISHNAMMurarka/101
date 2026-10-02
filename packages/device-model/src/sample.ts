import { DeviceValidationError, parseValueSchema, snapshotJson } from './descriptor.ts';
import type { DeviceCapability, JsonValue, SignalValue, ValueSchema } from './descriptor.ts';

function exactObject(value: JsonValue, keys: readonly string[], path: string): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeviceValidationError('spatial-value', path);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new DeviceValidationError('spatial-fields', path);
  return value;
}

function spatialCoordinate(value: JsonValue, extent: number, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > extent) throw new DeviceValidationError('spatial-range', path);
}

function validatePosition(value: JsonValue, extent: number, path: string): void {
  const point = exactObject(value, ['x', 'y', 'z'], path);
  for (const key of ['x', 'y', 'z']) spatialCoordinate(point[key], extent, `${path}.${key}`);
}

function validateQuaternion(value: JsonValue, path: string): void {
  const point = exactObject(value, ['x', 'y', 'z', 'w'], path);
  let norm = 0;
  for (const key of ['x', 'y', 'z', 'w']) {
    spatialCoordinate(point[key], 1, `${path}.${key}`);
    norm += (point[key] as number) ** 2;
  }
  if (Math.abs(norm - 1) > 0.002) throw new DeviceValidationError('quaternion-norm', path);
}

function validatePose(value: JsonValue, extent: number, path: string): void {
  const pose = exactObject(value, ['position', 'orientation'], path);
  validatePosition(pose.position, extent, `${path}.position`);
  validateQuaternion(pose.orientation, `${path}.orientation`);
}

function containsSpatial(schema: ValueSchema): boolean {
  if (schema.type === 'record') return Object.values(schema.fields).some(containsSpatial);
  if (schema.type === 'array') return containsSpatial(schema.items);
  return schema.type === 'quaternion' || schema.type === 'pose' || schema.type === 'joints' || schema.type === 'transform';
}

function canonicalSpatial(value: JsonValue, schema: ValueSchema): JsonValue {
  if (schema.type === 'array') return (value as JsonValue[]).map((member) => canonicalSpatial(member, schema.items));
  if (schema.type === 'record') return Object.fromEntries(Object.entries(schema.fields)
    .filter(([name]) => Object.hasOwn(value as object, name))
    .map(([name, member]) => [name, canonicalSpatial((value as Record<string, JsonValue>)[name], member)]));
  if (schema.type === 'quaternion') {
    const q = value as Record<string, JsonValue>;
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }
  if (schema.type === 'pose') {
    const pose = value as Record<string, JsonValue>;
    return { position: canonicalPosition(pose.position), orientation: canonicalSpatial(pose.orientation, { type: 'quaternion', frame: schema.frame }) };
  }
  if (schema.type === 'joints') {
    const joints = value as Record<string, JsonValue>;
    return Object.fromEntries(schema.joints.filter((joint) => Object.hasOwn(joints, joint.name))
      .map((joint) => [joint.name, canonicalSpatial(joints[joint.name], { type: 'pose', frame: schema.frame, extent: schema.extent })]));
  }
  if (schema.type === 'transform') {
    const transform = value as Record<string, JsonValue>;
    return { translation: canonicalPosition(transform.translation),
      rotation: canonicalSpatial(transform.rotation, { type: 'quaternion', frame: schema.to }), mirrored: transform.mirrored };
  }
  return value;
}

function canonicalPosition(value: JsonValue): JsonValue {
  const point = value as Record<string, JsonValue>;
  return { x: point.x, y: point.y, z: point.z };
}

function inputObject(value: JsonValue, fields: readonly string[], path: string): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeviceValidationError('input-value', path);
  const names = Object.keys(value);
  if (names.length !== fields.length || names.some((name) => !fields.includes(name))) throw new DeviceValidationError('input-fields', path);
  return value;
}
function inputString(value: JsonValue, path: string, max: number, empty = false): void {
  if (typeof value !== 'string' || (!empty && value.length === 0) || Array.from(value).length > max ||
      (!empty && Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)))
    throw new DeviceValidationError('input-string', path);
}
function inputNumber(value: JsonValue, path: string, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new DeviceValidationError('input-range', path);
}
function inputPosition(value: JsonValue, path: string): void {
  const point = inputObject(value, ['x', 'y'], path);
  inputNumber(point.x, `${path}.x`, 0, 1);
  inputNumber(point.y, `${path}.y`, 0, 1);
}
function inputModifiers(value: JsonValue, path: string): void {
  const flags = inputObject(value, ['shift', 'control', 'alt', 'meta'], path);
  for (const name of ['shift', 'control', 'alt', 'meta']) if (typeof flags[name] !== 'boolean') throw new DeviceValidationError('input-modifier', `${path}.${name}`);
}
function validateRichInput(value: JsonValue, schema: ValueSchema, path: string): void {
  if (schema.type === 'contact' || schema.type === 'pen') {
    const pen = schema.type === 'pen';
    const input = inputObject(value, pen ? ['id', 'phase', 'position', 'primary', 'pressure', 'tiltX', 'tiltY', 'twist'] :
      ['id', 'phase', 'position', 'primary'], path);
    inputString(input.id, `${path}.id`, 64);
    if (!['down', 'move', 'up', 'cancel'].includes(input.phase as string)) throw new DeviceValidationError('input-phase', `${path}.phase`);
    inputPosition(input.position, `${path}.position`);
    if (typeof input.primary !== 'boolean') throw new DeviceValidationError('input-primary', `${path}.primary`);
    if (pen) {
      inputNumber(input.pressure, `${path}.pressure`, 0, 1);
      inputNumber(input.tiltX, `${path}.tiltX`, -90, 90);
      inputNumber(input.tiltY, `${path}.tiltY`, -90, 90);
      inputNumber(input.twist, `${path}.twist`, 0, 359);
    }
    return;
  }
  if (schema.type === 'key') {
    const input = inputObject(value, ['code', 'key', 'phase', 'repeat', 'location', 'composing', 'modifiers'], path);
    inputString(input.code, `${path}.code`, 64);
    inputString(input.key, `${path}.key`, 128);
    if (input.phase !== 'down' && input.phase !== 'up') throw new DeviceValidationError('input-phase', `${path}.phase`);
    if (typeof input.repeat !== 'boolean' || input.phase === 'up' && input.repeat) throw new DeviceValidationError('input-repeat', `${path}.repeat`);
    if (typeof input.location !== 'number' || !Number.isInteger(input.location) || input.location < 0 || input.location > 3)
      throw new DeviceValidationError('input-location', `${path}.location`);
    if (typeof input.composing !== 'boolean') throw new DeviceValidationError('input-composing', `${path}.composing`);
    inputModifiers(input.modifiers, `${path}.modifiers`);
    return;
  }
  if (schema.type === 'text') {
    const input = inputObject(value, ['compositionId', 'phase', 'text'], path);
    inputString(input.compositionId, `${path}.compositionId`, 64);
    if (!['start', 'update', 'end', 'commit'].includes(input.phase as string)) throw new DeviceValidationError('input-phase', `${path}.phase`);
    inputString(input.text, `${path}.text`, schema.maxLength, true);
    return;
  }
  if (schema.type === 'wheel') {
    const input = inputObject(value, ['x', 'y', 'z', 'mode', 'modifiers'], path);
    for (const component of ['x', 'y', 'z']) inputNumber(input[component], `${path}.${component}`, -schema.maxDelta, schema.maxDelta);
    if (!['pixel', 'line', 'page'].includes(input.mode as string)) throw new DeviceValidationError('input-wheel-mode', `${path}.mode`);
    inputModifiers(input.modifiers, `${path}.modifiers`);
    return;
  }
  if (schema.type === 'relative-motion') {
    const input = inputObject(value, ['x', 'y', 'unit', 'locked'], path);
    inputNumber(input.x, `${path}.x`, -schema.maxDelta, schema.maxDelta);
    inputNumber(input.y, `${path}.y`, -schema.maxDelta, schema.maxDelta);
    if (input.unit !== 'css-px') throw new DeviceValidationError('input-unit', `${path}.unit`);
    if (typeof input.locked !== 'boolean') throw new DeviceValidationError('input-lock', `${path}.locked`);
  }
}

function containsRichInput(schema: ValueSchema): boolean {
  if (schema.type === 'record') return Object.values(schema.fields).some(containsRichInput);
  if (schema.type === 'array') return containsRichInput(schema.items);
  return isRichInputSchema(schema);
}
function isRichInputSchema(schema: ValueSchema): schema is Extract<ValueSchema,
  { type: 'contact' | 'pen' | 'key' | 'text' | 'wheel' | 'relative-motion' }> {
  return schema.type === 'contact' || schema.type === 'pen' || schema.type === 'key' || schema.type === 'text' ||
    schema.type === 'wheel' || schema.type === 'relative-motion';
}

export function parseSignalValue(input: unknown, schema: ValueSchema): SignalValue {
  const definition = parseValueSchema(schema);
  const snapshot = snapshotJson(input);
  function validate(value: JsonValue, definition: ValueSchema, path: string): void {
    if (definition.type === 'boolean') {
      if (typeof value !== 'boolean') throw new DeviceValidationError('boolean-value', path);
      return;
    }
    if (definition.type === 'enum') {
      if (typeof value !== 'string' || !definition.values.includes(value)) throw new DeviceValidationError('enum-value', path);
      return;
    }
    if (definition.type === 'array') {
      if (!Array.isArray(value)) throw new DeviceValidationError('array-value', path);
      if (value.length < definition.minItems || value.length > definition.maxItems) throw new DeviceValidationError('array-length', path);
      value.forEach((item, index) => validate(item, definition.items, `${path}[${index}]`));
      return;
    }
    if (definition.type === 'record') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeviceValidationError('record-value', path);
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(definition.fields, key)) throw new DeviceValidationError('unknown-property', `${path}.${key}`);
      }
      for (const [key, member] of Object.entries(definition.fields)) {
        if (!Object.hasOwn(value, key)) {
          if (!definition.optional?.includes(key)) throw new DeviceValidationError('required-property', `${path}.${key}`);
        } else validate(value[key], member, `${path}.${key}`);
      }
      return;
    }
    if (definition.type === 'quaternion') return validateQuaternion(value, path);
    if (definition.type === 'pose') return validatePose(value, definition.extent, path);
    if (definition.type === 'joints') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeviceValidationError('joint-value', path);
      const names = new Set(definition.joints.map((joint) => joint.name));
      for (const key of Object.keys(value)) {
        if (!names.has(key)) throw new DeviceValidationError('unknown-joint', `${path}.${key}`);
        validatePose(value[key], definition.extent, `${path}.${key}`);
      }
      for (const joint of definition.joints) {
        if (!Object.hasOwn(value, joint.name) && !definition.optional?.includes(joint.name))
          throw new DeviceValidationError('required-joint', `${path}.${joint.name}`);
      }
      return;
    }
    if (definition.type === 'transform') {
      const transform = exactObject(value, ['translation', 'rotation', 'mirrored'], path);
      validatePosition(transform.translation, definition.maxTranslation, `${path}.translation`);
      validateQuaternion(transform.rotation, `${path}.rotation`);
      if (transform.mirrored !== (definition.from.handedness !== definition.to.handedness))
        throw new DeviceValidationError('transform-parity', `${path}.mirrored`);
      return;
    }
    if (isRichInputSchema(definition)) return validateRichInput(value, definition, path);
    const { min, max } = definition;
    function coordinate(value: JsonValue, path: string): void {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new DeviceValidationError('value-range', path);
    }
    if (definition.type === 'scalar') return coordinate(value, path);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeviceValidationError('vector-value', path);
    const keys = Object.keys(value);
    if (keys.length !== definition.components.length || keys.some((key) => !definition.components.includes(key as 'x' | 'y'))) throw new DeviceValidationError('vector-components', path);
    for (const component of definition.components) coordinate(value[component], `${path}.${component}`);
  }
  validate(snapshot, definition, '$');
  return (containsSpatial(definition) ? snapshotJson(canonicalSpatial(snapshot, definition)) : snapshot) as SignalValue;
}

function valuesCompatible(a: ValueSchema, b: ValueSchema): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'boolean') return true;
  if (a.type === 'enum' && b.type === 'enum') return a.values.length === b.values.length && a.values.every((value, index) => value === b.values[index]);
  if (a.type === 'array' && b.type === 'array') return a.minItems === b.minItems && a.maxItems === b.maxItems && valuesCompatible(a.items, b.items);
  if (a.type === 'record' && b.type === 'record') {
    const names = Object.keys(a.fields);
    if (names.length !== Object.keys(b.fields).length || names.some((name) => !Object.hasOwn(b.fields, name))) return false;
    const aOptional = a.optional ?? [];
    const bOptional = b.optional ?? [];
    if (aOptional.length !== bOptional.length || aOptional.some((name) => !bOptional.includes(name))) return false;
    return names.every((name) => valuesCompatible(a.fields[name], b.fields[name]));
  }
  if ((a.type === 'quaternion' && b.type === 'quaternion') || (a.type === 'pose' && b.type === 'pose'))
    return JSON.stringify(a.frame) === JSON.stringify(b.frame) && (a.type === 'quaternion' || (b.type === 'pose' && a.extent === b.extent));
  if (a.type === 'transform' && b.type === 'transform')
    return JSON.stringify(a.from) === JSON.stringify(b.from) && JSON.stringify(a.to) === JSON.stringify(b.to) && a.maxTranslation === b.maxTranslation;
  if (a.type === 'joints' && b.type === 'joints') {
    if (JSON.stringify(a.frame) !== JSON.stringify(b.frame) || a.extent !== b.extent || a.joints.length !== b.joints.length) return false;
    if (a.joints.some((joint) => !b.joints.some((other) => other.name === joint.name && other.parent === joint.parent))) return false;
    const aa = a.optional ?? [], bb = b.optional ?? [];
    return aa.length === bb.length && aa.every((name) => bb.includes(name));
  }
  if ((a.type === 'contact' && b.type === 'contact') || (a.type === 'pen' && b.type === 'pen')) return a.frame === b.frame;
  if (a.type === 'key' && b.type === 'key') return true;
  if (a.type === 'text' && b.type === 'text') return a.maxLength === b.maxLength;
  if (a.type === 'wheel' && b.type === 'wheel') return a.maxDelta === b.maxDelta;
  if (a.type === 'relative-motion' && b.type === 'relative-motion') return a.frame === b.frame && a.maxDelta === b.maxDelta;
  if ((a.type === 'scalar' && b.type === 'scalar') || (a.type === 'vector' && b.type === 'vector')) {
    if (a.unit !== b.unit || a.min !== b.min || a.max !== b.max || a.frame !== b.frame || a.resolution !== b.resolution) return false;
    return a.type === 'scalar' || (b.type === 'vector' && a.components.length === b.components.length && a.components.every((value, index) => value === b.components[index]));
  }
  return false;
}

export function schemasCompatible(source: DeviceCapability, sink: DeviceCapability): boolean {
  if (source.semantic !== sink.semantic || source.schemaVersion !== sink.schemaVersion) return false;
  try {
    const a = parseValueSchema(source.value), b = parseValueSchema(sink.value);
    if (source.schemaVersion < 2 && (containsSpatial(a) || containsSpatial(b) || containsRichInput(a) || containsRichInput(b))) return false;
    if ((containsRichInput(a) || containsRichInput(b)) &&
        (source.kind !== 'event' || sink.kind !== 'event' || source.delivery.mode !== 'reliable' || sink.delivery.mode !== 'reliable')) return false;
    return valuesCompatible(a, b);
  } catch (error) {
    if (error instanceof DeviceValidationError) return false;
    throw error;
  }
}
