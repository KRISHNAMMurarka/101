export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type SignalValue = boolean | number | string | readonly SignalValue[] | { readonly [key: string]: SignalValue };
export type SpatialAxis = 'right' | 'left' | 'up' | 'down' | 'forward' | 'backward';
export interface SpatialFrame {
  readonly id: string; readonly origin: string; readonly unit: 'm' | 'cm' | 'mm';
  readonly axes: readonly [SpatialAxis, SpatialAxis, SpatialAxis];
  readonly handedness: 'right' | 'left';
}
export interface SpatialJoint { readonly name: string; readonly parent?: string }
export type ValueSchema =
  | { type: 'boolean' }
  | { type: 'scalar'; unit: string; min: number; max: number; frame?: string; resolution?: number }
  | { type: 'vector'; unit: string; min: number; max: number; frame: string;
      components: readonly ['x', 'y'] | readonly ['x', 'y', 'z']; resolution?: number }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'record'; fields: Readonly<Record<string, ValueSchema>>; optional?: readonly string[] }
  | { type: 'array'; items: ValueSchema; minItems: number; maxItems: number }
  | { type: 'quaternion'; frame: SpatialFrame }
  | { type: 'pose'; frame: SpatialFrame; extent: number }
  | { type: 'joints'; frame: SpatialFrame; extent: number; joints: readonly SpatialJoint[]; optional?: readonly string[] }
  | { type: 'transform'; from: SpatialFrame; to: SpatialFrame; maxTranslation: number }
  | { type: 'contact'; frame: string }
  | { type: 'pen'; frame: string }
  | { type: 'key' }
  | { type: 'text'; maxLength: number }
  | { type: 'wheel'; maxDelta: number }
  | { type: 'relative-motion'; frame: string; maxDelta: number };
export type DeliveryPolicy = { mode: 'latest'; maxHz: number; maxAgeMs: number }
  | { mode: 'reliable'; maxAgeMs: number };
export type PermissionOperation = 'read' | 'subscribe' | 'write' | 'invoke';
export type OwnershipPolicy = { mode: 'exclusive' } | { mode: 'observe' }
  | { mode: 'partitioned'; partitions: readonly string[] };
export interface DeviceCapability {
  id: string; semantic: string; schemaVersion: number;
  kind: 'sample' | 'event' | 'command' | 'property' | 'job';
  value: ValueSchema; delivery: DeliveryPolicy;
  permissions: readonly PermissionOperation[]; ownership?: OwnershipPolicy;
  metadata?: JsonObject; extensions?: JsonObject;
}
export interface DeviceDescriptor {
  schemaVersion: 1; id: string; label: string; revision: number;
  adapter: { id: string; version: string }; runtime: { platform: string };
  capabilities: readonly DeviceCapability[]; metadata?: JsonObject; extensions?: JsonObject;
}

const MAX_BYTES = 65536;
const MAX_ENTRIES = 128;
const MAX_JSON_DEPTH = 8;
// Spatial frame/joint declarations add containers inside the four schema nodes.
const MAX_SCHEMA_JSON_DEPTH = 10;
const MAX_SCHEMA_DEPTH = 4;
const MAX_SCHEMA_NODES = 256;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);
const NAMESPACE = /^[A-Za-z][A-Za-z0-9._-]*:[\s\S]+$/;

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export class DeviceValidationError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path = '$') {
    super(`${code} at ${path}`);
    this.name = 'DeviceValidationError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: string, path: string): never {
  throw new DeviceValidationError(code, path);
}

function ensureBytes(input: string, path: string): void {
  if (input.length > MAX_BYTES || new TextEncoder().encode(input).length > MAX_BYTES) fail('byte-limit', path);
}

function copyJson(input: unknown, maxDepth: number): JsonValue {
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  function consume(count: number, path: string): void {
    bytes += count;
    if (bytes > MAX_BYTES) fail('byte-limit', path);
  }
  function consumeText(value: string, path: string): void {
    ensureBytes(value, path);
    consume(new TextEncoder().encode(JSON.stringify(value)).length, path);
  }
  function copy(value: unknown, depth: number, path: string): JsonValue {
    nodes += 1;
    // Each JSON node occupies at least one byte; cap traversal as well as output.
    if (nodes > MAX_BYTES) fail('node-limit', path);
    if (value === null || typeof value === 'boolean') {
      consume(value === null || value === true ? 4 : 5, path);
      return value;
    }
    if (typeof value === 'string') {
      consumeText(value, path);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('nonfinite-number', path);
      consume(JSON.stringify(value).length, path);
      return value;
    }
    if (typeof value !== 'object') fail('json-value', path);
    if (depth > maxDepth) fail('depth-limit', path);
    if (ancestors.has(value)) fail('cyclic-json', path);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('plain-data-object', path);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) fail('json-key', path);
    const entries = keys.filter((key) => !(array && key === 'length')) as string[];
    if (entries.length > MAX_ENTRIES) fail('entry-limit', path);
    const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
    for (const key of entries) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) fail('data-property', `${path}.${key}`);
      descriptors[key] = property;
    }
    consume(2 + Math.max(0, entries.length - 1), path);
    ancestors.add(value);
    let result: JsonValue;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as number;
      if (length > MAX_ENTRIES) fail('entry-limit', path);
      if (entries.length !== length || entries.some((key, index) => key !== String(index))) fail('dense-json-array', path);
      result = entries.map((key) => {
        const property = descriptors[key]; if (!property) fail('data-property', `${path}[${key}]`);
        return copy(property.value, depth + 1, `${path}[${key}]`);
      });
    } else {
      const object: JsonObject = {};
      for (const key of entries) {
        consumeText(key, path);
        consume(1, path);
        // Defining the data property keeps __proto__ and constructor inert.
        const property = descriptors[key]; if (!property) fail('data-property', `${path}.${key}`);
        Object.defineProperty(object, key, { value: copy(property.value, depth + 1, `${path}.${key}`), enumerable: true, writable: true, configurable: true });
      }
      result = object;
    }
    ancestors.delete(value);
    Object.freeze(result);
    return result;
  }
  const result = copy(input, 1, '$');
  ensureBytes(JSON.stringify(result), '$');
  return result;
}

/** A bounded JSON-only immutable copy; no property getter is evaluated. */
export function snapshotJson(input: unknown): JsonValue {
  return copyJson(input, MAX_JSON_DEPTH);
}

function object(input: unknown, path: string): JsonObject {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('object-required', path);
  return input as JsonObject;
}

function closed(input: JsonObject, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of required) if (!Object.hasOwn(input, key)) fail('required-property', `${path}.${key}`);
  for (const key of Object.keys(input)) if (!required.includes(key) && !optional.includes(key)) fail('unknown-property', `${path}.${key}`);
}

function text(input: unknown, path: string, max = 128, namespaced = false): string {
  if (typeof input !== 'string' || input.length === 0 || Array.from(input).length > max || hasControl(input)) fail('bounded-string', path);
  if (namespaced && !NAMESPACE.test(input)) fail('namespaced-id', path);
  return input;
}

function integer(input: unknown, path: string, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > max) fail('integer-range', path);
  return input;
}

function finite(input: unknown, path: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) fail('finite-number', path);
  return input;
}

function stringList(input: unknown, path: string, max: number): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > max) fail('bounded-array', path);
  const list = input.map((value, index) => text(value, `${path}[${index}]`));
  if (new Set(list).size !== list.length) fail('duplicate-value', path);
  return list;
}

const AXIS_DIRECTION: Readonly<Record<SpatialAxis, readonly [number, number, number]>> = Object.freeze({
  right: [1, 0, 0], left: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
  forward: [0, 0, 1], backward: [0, 0, -1],
});

function parseSpatialFrame(input: unknown, path: string): SpatialFrame {
  const value = object(input, path);
  closed(value, ['id', 'origin', 'unit', 'axes', 'handedness'], [], path);
  const id = text(value.id, `${path}.id`, 128, true);
  const origin = text(value.origin, `${path}.origin`, 128, true);
  if (value.unit !== 'm' && value.unit !== 'cm' && value.unit !== 'mm') fail('spatial-unit', `${path}.unit`);
  if (!Array.isArray(value.axes) || value.axes.length !== 3) fail('spatial-axes', `${path}.axes`);
  const axes = value.axes as [SpatialAxis, SpatialAxis, SpatialAxis];
  if (axes.some((axis) => typeof axis !== 'string' || !Object.hasOwn(AXIS_DIRECTION, axis))) fail('spatial-axes', `${path}.axes`);
  const [x, y, z] = [AXIS_DIRECTION[axes[0]], AXIS_DIRECTION[axes[1]], AXIS_DIRECTION[axes[2]]];
  const dot = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (dot(x, y) || dot(x, z) || dot(y, z)) fail('spatial-axes', `${path}.axes`);
  const determinant = x[0] * (y[1] * z[2] - y[2] * z[1]) -
    y[0] * (x[1] * z[2] - x[2] * z[1]) +
    z[0] * (x[1] * y[2] - x[2] * y[1]);
  if (value.handedness !== 'right' && value.handedness !== 'left') fail('spatial-handedness', `${path}.handedness`);
  if (determinant !== (value.handedness === 'right' ? 1 : -1)) fail('spatial-handedness', `${path}.handedness`);
  return Object.freeze({ id, origin, unit: value.unit, axes: Object.freeze(axes.slice()) as SpatialFrame['axes'], handedness: value.handedness });
}

function positiveSpatial(input: unknown, path: string): number {
  const value = finite(input, path);
  if (value <= 0) fail('positive-spatial-bound', path);
  return value;
}

function parseSpatialJoints(input: unknown, path: string): readonly SpatialJoint[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) fail('joint-count', path);
  const joints = input.map((entry, index) => {
    const point = `${path}[${index}]`;
    const objectEntry = object(entry, point);
    closed(objectEntry, ['name'], ['parent'], point);
    const name = text(objectEntry.name, `${point}.name`);
    if (!FIELD_NAME.test(name) || UNSAFE_FIELDS.has(name)) fail('joint-name', `${point}.name`);
    const parent = Object.hasOwn(objectEntry, 'parent') ? text(objectEntry.parent, `${point}.parent`) : undefined;
    if (parent !== undefined && (!FIELD_NAME.test(parent) || UNSAFE_FIELDS.has(parent))) fail('joint-name', `${point}.parent`);
    return Object.freeze({ name, ...(parent === undefined ? {} : { parent }) });
  });
  const parents = new Map(joints.map((joint) => [joint.name, joint.parent]));
  if (parents.size !== joints.length) fail('duplicate-joint', path);
  for (const joint of joints) {
    const visited = new Set<string>();
    let current: string | undefined = joint.name;
    while (current !== undefined) {
      if (visited.has(current)) fail('joint-cycle', path);
      visited.add(current);
      if (!parents.has(current)) fail('joint-parent', path);
      current = parents.get(current);
    }
  }
  return Object.freeze(joints);
}

function usesSpatial(schema: ValueSchema): boolean {
  if (schema.type === 'record') return Object.values(schema.fields).some(usesSpatial);
  if (schema.type === 'array') return usesSpatial(schema.items);
  return schema.type === 'quaternion' || schema.type === 'pose' || schema.type === 'joints' || schema.type === 'transform';
}

function usesRichInput(schema: ValueSchema): boolean {
  if (schema.type === 'record') return Object.values(schema.fields).some(usesRichInput);
  if (schema.type === 'array') return usesRichInput(schema.items);
  return schema.type === 'contact' || schema.type === 'pen' || schema.type === 'key' ||
    schema.type === 'text' || schema.type === 'wheel' || schema.type === 'relative-motion';
}

/** A bounded immutable value definition, including recursive record and array members. */
export function parseValueSchema(input: unknown, path = '$.value'): ValueSchema {
  const snapshot = copyJson(input, MAX_SCHEMA_JSON_DEPTH);
  let nodes = 0;
  function parse(input: JsonValue, path: string, depth: number): ValueSchema {
    if (depth > MAX_SCHEMA_DEPTH) fail('schema-depth-limit', path);
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) fail('schema-node-limit', path);
    const value = object(input, path);
    if (value.type === 'record') {
      closed(value, ['type', 'fields'], ['optional'], path);
      const declared = object(value.fields, `${path}.fields`);
      const names = Object.keys(declared);
      if (names.length < 1 || names.length > 32) fail('record-field-count', `${path}.fields`);
      const fields: Record<string, ValueSchema> = {};
      for (const name of names) {
        text(name, `${path}.fields.${name}`);
        if (!FIELD_NAME.test(name) || UNSAFE_FIELDS.has(name)) fail('record-field-name', `${path}.fields.${name}`);
        const member = declared[name];
        if (member === undefined) fail('required-property', `${path}.fields.${name}`);
        fields[name] = parse(member, `${path}.fields.${name}`, depth + 1);
      }
      let optional: readonly string[] | undefined;
      if (Object.hasOwn(value, 'optional')) {
        if (!Array.isArray(value.optional) || value.optional.length > 32) fail('bounded-array', `${path}.optional`);
        const list = value.optional.map((member, index) => text(member, `${path}.optional[${index}]`));
        if (new Set(list).size !== list.length) fail('duplicate-value', `${path}.optional`);
        if (list.some((name) => !Object.hasOwn(fields, name))) fail('optional-field', `${path}.optional`);
        optional = Object.freeze(list);
      }
      return Object.freeze({ type: 'record', fields: Object.freeze(fields), ...(optional === undefined ? {} : { optional }) });
    }
    if (value.type === 'array') {
      closed(value, ['type', 'items', 'minItems', 'maxItems'], [], path);
      const { minItems, maxItems } = value;
      if (typeof minItems !== 'number' || !Number.isInteger(minItems) || minItems < 0 || minItems > 128) fail('array-bounds', `${path}.minItems`);
      if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < minItems || maxItems > 128) fail('array-bounds', `${path}.maxItems`);
      const items = value.items;
      if (items === undefined) fail('required-property', `${path}.items`);
      return Object.freeze({ type: 'array', items: parse(items, `${path}.items`, depth + 1), minItems, maxItems });
    }
    if (value.type === 'boolean') {
      closed(value, ['type'], [], path);
      return Object.freeze({ type: 'boolean' });
    }
    if (value.type === 'enum') {
      closed(value, ['type', 'values'], [], path);
      return Object.freeze({ type: 'enum', values: Object.freeze(stringList(value.values, `${path}.values`, 64)) });
    }
    if (value.type === 'quaternion') {
      closed(value, ['type', 'frame'], [], path);
      return Object.freeze({ type: 'quaternion', frame: parseSpatialFrame(value.frame, `${path}.frame`) });
    }
    if (value.type === 'pose' || value.type === 'joints') {
      const joints = value.type === 'joints';
      closed(value, joints ? ['type', 'frame', 'extent', 'joints'] : ['type', 'frame', 'extent'], joints ? ['optional'] : [], path);
      const frame = parseSpatialFrame(value.frame, `${path}.frame`);
      const extent = positiveSpatial(value.extent, `${path}.extent`);
      if (!joints) return Object.freeze({ type: 'pose', frame, extent });
      const declared = parseSpatialJoints(value.joints, `${path}.joints`);
      let optional: readonly string[] | undefined;
      if (Object.hasOwn(value, 'optional')) {
        if (!Array.isArray(value.optional) || value.optional.length > declared.length) fail('bounded-array', `${path}.optional`);
        const names = value.optional.map((name, index) => text(name, `${path}.optional[${index}]`));
        if (new Set(names).size !== names.length) fail('duplicate-value', `${path}.optional`);
        if (names.some((name) => !declared.some((joint) => joint.name === name))) fail('optional-joint', `${path}.optional`);
        optional = Object.freeze(names);
      }
      return Object.freeze({ type: 'joints', frame, extent, joints: declared, ...(optional === undefined ? {} : { optional }) });
    }
    if (value.type === 'transform') {
      closed(value, ['type', 'from', 'to', 'maxTranslation'], [], path);
      return Object.freeze({ type: 'transform', from: parseSpatialFrame(value.from, `${path}.from`),
        to: parseSpatialFrame(value.to, `${path}.to`), maxTranslation: positiveSpatial(value.maxTranslation, `${path}.maxTranslation`) });
    }
    if (value.type === 'contact' || value.type === 'pen') {
      closed(value, ['type', 'frame'], [], path);
      return Object.freeze({ type: value.type, frame: text(value.frame, `${path}.frame`) });
    }
    if (value.type === 'key') {
      closed(value, ['type'], [], path);
      return Object.freeze({ type: 'key' });
    }
    if (value.type === 'text') {
      closed(value, ['type', 'maxLength'], [], path);
      return Object.freeze({ type: 'text', maxLength: integer(value.maxLength, `${path}.maxLength`, 2048) });
    }
    if (value.type === 'wheel' || value.type === 'relative-motion') {
      closed(value, value.type === 'wheel' ? ['type', 'maxDelta'] : ['type', 'frame', 'maxDelta'], [], path);
      const maxDelta = positiveSpatial(value.maxDelta, `${path}.maxDelta`);
      if (value.type === 'wheel') return Object.freeze({ type: 'wheel', maxDelta });
      return Object.freeze({ type: 'relative-motion', frame: text(value.frame, `${path}.frame`), maxDelta });
    }
    if (value.type !== 'scalar' && value.type !== 'vector') fail('value-type', `${path}.type`);
    const vector = value.type === 'vector';
    closed(value, vector ? ['type', 'unit', 'min', 'max', 'frame', 'components'] : ['type', 'unit', 'min', 'max'], vector ? ['resolution'] : ['frame', 'resolution'], path);
    const unit = text(value.unit, `${path}.unit`);
    const min = finite(value.min, `${path}.min`);
    const max = finite(value.max, `${path}.max`);
    if (min > max) fail('ordered-range', path);
    const frame = Object.hasOwn(value, 'frame') ? text(value.frame, `${path}.frame`) : undefined;
    const resolution = Object.hasOwn(value, 'resolution') ? finite(value.resolution, `${path}.resolution`) : undefined;
    if (resolution !== undefined && resolution <= 0) fail('positive-resolution', `${path}.resolution`);
    const common = { unit, min, max, ...(frame === undefined ? {} : { frame }), ...(resolution === undefined ? {} : { resolution }) };
    if (!vector) return Object.freeze({ type: 'scalar', ...common });
    const components = stringList(value.components, `${path}.components`, 3);
    if ((components.length !== 2 && components.length !== 3) || components[0] !== 'x' || components[1] !== 'y' || (components.length === 3 && components[2] !== 'z')) fail('vector-components', `${path}.components`);
    return Object.freeze({ type: 'vector', ...common, frame: frame as string, components: Object.freeze(components) as readonly ['x', 'y'] | readonly ['x', 'y', 'z'] });
  }
  return parse(snapshot, path, 1);
}

function parseDelivery(input: unknown, path: string): DeliveryPolicy {
  const delivery = object(input, path);
  if (delivery.mode === 'latest') {
    closed(delivery, ['mode', 'maxHz', 'maxAgeMs'], [], path);
    return Object.freeze({ mode: 'latest', maxHz: integer(delivery.maxHz, `${path}.maxHz`, 1000), maxAgeMs: integer(delivery.maxAgeMs, `${path}.maxAgeMs`, 60000) });
  }
  if (delivery.mode === 'reliable') {
    closed(delivery, ['mode', 'maxAgeMs'], [], path);
    return Object.freeze({ mode: 'reliable', maxAgeMs: integer(delivery.maxAgeMs, `${path}.maxAgeMs`, 60000) });
  }
  return fail('delivery-mode', `${path}.mode`);
}

function parseOwnership(input: unknown, path: string): OwnershipPolicy {
  const ownership = object(input, path);
  if (ownership.mode === 'exclusive' || ownership.mode === 'observe') {
    closed(ownership, ['mode'], [], path);
    return Object.freeze({ mode: ownership.mode });
  }
  if (ownership.mode === 'partitioned') {
    closed(ownership, ['mode', 'partitions'], [], path);
    return Object.freeze({ mode: 'partitioned', partitions: Object.freeze(stringList(ownership.partitions, `${path}.partitions`, 128)) });
  }
  return fail('ownership-mode', `${path}.mode`);
}

function parseMetadata(input: unknown, path: string, extensions = false): JsonObject {
  const metadata = object(snapshotJson(input), path);
  if (extensions) for (const key of Object.keys(metadata)) text(key, `${path}.${key}`, 128, true);
  return metadata;
}

function parseCapability(input: unknown, path: string): DeviceCapability {
  const capability = object(input, path);
  closed(capability, ['id', 'semantic', 'schemaVersion', 'kind', 'value', 'delivery', 'permissions'], ['ownership', 'metadata', 'extensions'], path);
  const kind = capability.kind;
  if (kind !== 'sample' && kind !== 'event' && kind !== 'command' && kind !== 'property' && kind !== 'job') fail('capability-kind', `${path}.kind`);
  const permissions = stringList(capability.permissions, `${path}.permissions`, 4);
  if (permissions.some((permission) => !['read', 'subscribe', 'write', 'invoke'].includes(permission))) fail('permission-operation', `${path}.permissions`);
  const schemaVersion = integer(capability.schemaVersion, `${path}.schemaVersion`, 4294967295);
  const value = parseValueSchema(capability.value, `${path}.value`);
  if (schemaVersion < 2 && usesSpatial(value)) fail('spatial-schema-version', `${path}.schemaVersion`);
  const richInput = usesRichInput(value);
  if (schemaVersion < 2 && richInput) fail('input-schema-version', `${path}.schemaVersion`);
  const delivery = parseDelivery(capability.delivery, `${path}.delivery`);
  if (richInput && (kind !== 'event' || delivery.mode !== 'reliable')) fail('input-event-delivery', path);
  return Object.freeze({
    id: text(capability.id, `${path}.id`), semantic: text(capability.semantic, `${path}.semantic`, 128, true),
    schemaVersion, kind,
    value, delivery,
    permissions: Object.freeze(permissions) as readonly PermissionOperation[],
    ...(Object.hasOwn(capability, 'ownership') ? { ownership: parseOwnership(capability.ownership, `${path}.ownership`) } : {}),
    ...(Object.hasOwn(capability, 'metadata') ? { metadata: parseMetadata(capability.metadata, `${path}.metadata`) } : {}),
    ...(Object.hasOwn(capability, 'extensions') ? { extensions: parseMetadata(capability.extensions, `${path}.extensions`, true) } : {}),
  });
}

export function parseDeviceDescriptor(input: unknown): Readonly<DeviceDescriptor> {
  let json: unknown = input;
  if (typeof input === 'string') {
    ensureBytes(input, '$');
    try { json = JSON.parse(input); } catch { fail('invalid-json', '$'); }
  }
  // Core container nesting adds four levels above a capability's metadata.
  // Each metadata/extension subtree is subsequently checked at its own root.
  const descriptor = object(copyJson(json, MAX_JSON_DEPTH + 4), '$');
  closed(descriptor, ['schemaVersion', 'id', 'label', 'revision', 'adapter', 'runtime', 'capabilities'], ['metadata', 'extensions'], '$');
  if (descriptor.schemaVersion !== 1) fail('descriptor-schema-version', '$.schemaVersion');
  const adapter = object(descriptor.adapter, '$.adapter');
  closed(adapter, ['id', 'version'], [], '$.adapter');
  const runtime = object(descriptor.runtime, '$.runtime');
  closed(runtime, ['platform'], [], '$.runtime');
  if (!Array.isArray(descriptor.capabilities) || descriptor.capabilities.length > 128) fail('capability-count', '$.capabilities');
  const capabilities = descriptor.capabilities.map((capability, index) => parseCapability(capability, `$.capabilities[${index}]`));
  if (new Set(capabilities.map((capability) => capability.id)).size !== capabilities.length) fail('duplicate-capability', '$.capabilities');
  return Object.freeze({
    schemaVersion: 1, id: text(descriptor.id, '$.id'), label: text(descriptor.label, '$.label', 160),
    revision: integer(descriptor.revision, '$.revision', 4294967295),
    adapter: Object.freeze({ id: text(adapter.id, '$.adapter.id', 128, true), version: text(adapter.version, '$.adapter.version') }),
    runtime: Object.freeze({ platform: text(runtime.platform, '$.runtime.platform') }), capabilities: Object.freeze(capabilities),
    ...(Object.hasOwn(descriptor, 'metadata') ? { metadata: parseMetadata(descriptor.metadata, '$.metadata') } : {}),
    ...(Object.hasOwn(descriptor, 'extensions') ? { extensions: parseMetadata(descriptor.extensions, '$.extensions', true) } : {}),
  });
}
