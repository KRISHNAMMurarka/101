const identifier = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
const namespaced = { ...identifier, pattern: '^[A-Za-z][A-Za-z0-9._-]*:[^\\u0000-\\u001f\\u007f]+$' };
const positiveInteger = { type: 'integer', minimum: 1, maximum: 4294967295 };
const identifierList = { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: identifier };
const range = { unit: identifier, min: { type: 'number' }, max: { type: 'number' }, resolution: { type: 'number', exclusiveMinimum: 0 } };
const fieldName = { ...identifier, pattern: '^[A-Za-z_][A-Za-z0-9_]*$', not: { enum: ['__proto__', 'prototype', 'constructor'] } };
const arrayBound = { type: 'integer', minimum: 0, maximum: 128 };
const spatialFrame = { $ref: '#/definitions/spatialFrame' };
const positiveSpatial = { type: 'number', exclusiveMinimum: 0 };

function closed(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', required, properties, additionalProperties: false };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Editor validation handles structure. Runtime-only rules are annotated below. */
export const DEVICE_DESCRIPTOR_SCHEMA = freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:101:device-descriptor:1',
  title: '101 device descriptor',
  description: 'Inert device capabilities. A descriptor is descriptive data and never supplies authentication or an operation grant.',
  'x-runtime-validation': {
    descriptorMaxUtf8Bytes: 65536,
    jsonMaxDepth: 8,
    valueSchemaJsonMaxDepth: 10,
    jsonMaxEntriesPerContainer: 128,
    valueSchemaMaxDepth: 4,
    valueSchemaMaxNodes: 256,
    rules: ['finite numeric values', 'min must be no greater than max', 'array minItems must be no greater than maxItems', 'record optional members must be declared fields', 'spatial values require capability schemaVersion >= 2 recursively', 'rich input values require capability schemaVersion >= 2, event kind and reliable delivery recursively', 'spatial axes must be orthogonal and match declared handedness', 'joint names, parents and optional members must be declared, unique and acyclic', 'quaternion squared norm must be within 0.002 of 1', 'transform mirror parity must match frame handedness', 'value schema depth and total node limits apply recursively', 'capability IDs must be unique', 'metadata and extensions must be bounded immutable plain JSON data', 'object input must have only enumerable data properties without cycles or custom prototypes'],
  },
  ...closed({
    schemaVersion: { const: 1 }, id: identifier,
    label: { ...identifier, maxLength: 160 }, revision: positiveInteger,
    adapter: closed({ id: namespaced, version: identifier }, ['id', 'version']),
    runtime: closed({ platform: identifier }, ['platform']),
    capabilities: { type: 'array', maxItems: 128, items: { $ref: '#/definitions/capability' } },
    metadata: { $ref: '#/definitions/jsonObject' }, extensions: { $ref: '#/definitions/extensions' },
  }, ['schemaVersion', 'id', 'label', 'revision', 'adapter', 'runtime', 'capabilities']),
  definitions: {
    jsonValue: { anyOf: [
      { type: 'null' }, { type: 'boolean' }, { type: 'number' }, { type: 'string' },
      { type: 'array', maxItems: 128, items: { $ref: '#/definitions/jsonValue' } },
      { $ref: '#/definitions/jsonObject' },
    ] },
    jsonObject: { type: 'object', maxProperties: 128, additionalProperties: { $ref: '#/definitions/jsonValue' } },
    extensions: { type: 'object', maxProperties: 128, propertyNames: namespaced, additionalProperties: { $ref: '#/definitions/jsonValue' } },
    spatialFrame: closed({ id: namespaced, origin: namespaced,
      unit: { enum: ['m', 'cm', 'mm'] }, axes: { type: 'array', minItems: 3, maxItems: 3, items: { enum: ['right', 'left', 'up', 'down', 'forward', 'backward'] } },
      handedness: { enum: ['right', 'left'] },
    }, ['id', 'origin', 'unit', 'axes', 'handedness']),
    spatialJoint: closed({ name: fieldName, parent: fieldName }, ['name']),
    value: { oneOf: [
      closed({ type: { const: 'boolean' } }, ['type']),
      closed({ type: { const: 'scalar' }, ...range, frame: identifier }, ['type', 'unit', 'min', 'max']),
      closed({ type: { const: 'vector' }, ...range, frame: identifier, components: { enum: [['x', 'y'], ['x', 'y', 'z']] } }, ['type', 'unit', 'min', 'max', 'frame', 'components']),
      closed({ type: { const: 'enum' }, values: { ...identifierList, maxItems: 64 } }, ['type', 'values']),
      { $ref: '#/definitions/record' },
      { $ref: '#/definitions/array' },
      closed({ type: { const: 'quaternion' }, frame: spatialFrame }, ['type', 'frame']),
      closed({ type: { const: 'pose' }, frame: spatialFrame, extent: positiveSpatial }, ['type', 'frame', 'extent']),
      closed({ type: { const: 'joints' }, frame: spatialFrame, extent: positiveSpatial,
        joints: { type: 'array', minItems: 1, maxItems: 32, items: { $ref: '#/definitions/spatialJoint' } },
        optional: { type: 'array', maxItems: 32, uniqueItems: true, items: fieldName },
      }, ['type', 'frame', 'extent', 'joints']),
      closed({ type: { const: 'transform' }, from: spatialFrame, to: spatialFrame, maxTranslation: positiveSpatial },
        ['type', 'from', 'to', 'maxTranslation']),
      closed({ type: { const: 'contact' }, frame: identifier }, ['type', 'frame']),
      closed({ type: { const: 'pen' }, frame: identifier }, ['type', 'frame']),
      closed({ type: { const: 'key' } }, ['type']),
      closed({ type: { const: 'text' }, maxLength: { type: 'integer', minimum: 1, maximum: 2048 } }, ['type', 'maxLength']),
      closed({ type: { const: 'wheel' }, maxDelta: positiveSpatial }, ['type', 'maxDelta']),
      closed({ type: { const: 'relative-motion' }, frame: identifier, maxDelta: positiveSpatial }, ['type', 'frame', 'maxDelta']),
    ] },
    record: closed({
      type: { const: 'record' },
      fields: { type: 'object', minProperties: 1, maxProperties: 32, propertyNames: fieldName, additionalProperties: { $ref: '#/definitions/value' } },
      optional: { type: 'array', maxItems: 32, uniqueItems: true, items: fieldName },
    }, ['type', 'fields']),
    array: closed({ type: { const: 'array' }, items: { $ref: '#/definitions/value' }, minItems: arrayBound, maxItems: arrayBound }, ['type', 'items', 'minItems', 'maxItems']),
    delivery: { oneOf: [
      closed({ mode: { const: 'latest' }, maxHz: { type: 'integer', minimum: 1, maximum: 1000 }, maxAgeMs: { type: 'integer', minimum: 1, maximum: 60000 } }, ['mode', 'maxHz', 'maxAgeMs']),
      closed({ mode: { const: 'reliable' }, maxAgeMs: { type: 'integer', minimum: 1, maximum: 60000 } }, ['mode', 'maxAgeMs']),
    ] },
    ownership: { oneOf: [
      closed({ mode: { enum: ['exclusive', 'observe'] } }, ['mode']),
      closed({ mode: { const: 'partitioned' }, partitions: identifierList }, ['mode', 'partitions']),
    ] },
    capability: closed({
      id: identifier, semantic: namespaced, schemaVersion: positiveInteger,
      kind: { enum: ['sample', 'event', 'command', 'property', 'job'] }, value: { $ref: '#/definitions/value' },
      delivery: { $ref: '#/definitions/delivery' },
      permissions: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { enum: ['read', 'subscribe', 'write', 'invoke'] } },
      ownership: { $ref: '#/definitions/ownership' }, metadata: { $ref: '#/definitions/jsonObject' }, extensions: { $ref: '#/definitions/extensions' },
    }, ['id', 'semantic', 'schemaVersion', 'kind', 'value', 'delivery', 'permissions']),
  },
});
