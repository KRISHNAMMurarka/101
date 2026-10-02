import { DeviceValidationError, parseValueSchema, snapshotJson } from './descriptor.ts';
import type { DeviceCapability, JsonValue, SignalValue, ValueSchema } from './descriptor.ts';

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
  return snapshot as SignalValue;
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
  if ((a.type === 'scalar' && b.type === 'scalar') || (a.type === 'vector' && b.type === 'vector')) {
    if (a.unit !== b.unit || a.min !== b.min || a.max !== b.max || a.frame !== b.frame || a.resolution !== b.resolution) return false;
    return a.type === 'scalar' || (b.type === 'vector' && a.components.length === b.components.length && a.components.every((value, index) => value === b.components[index]));
  }
  return false;
}

export function schemasCompatible(source: DeviceCapability, sink: DeviceCapability): boolean {
  if (source.semantic !== sink.semantic || source.schemaVersion !== sink.schemaVersion) return false;
  try {
    return valuesCompatible(parseValueSchema(source.value), parseValueSchema(sink.value));
  } catch (error) {
    if (error instanceof DeviceValidationError) return false;
    throw error;
  }
}
