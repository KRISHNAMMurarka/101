import { DeviceValidationError, parseValueSchema, snapshotJson } from './descriptor.ts';
import type { DeviceCapability, SignalValue, ValueSchema } from './descriptor.ts';

export function parseSignalValue(input: unknown, schema: ValueSchema): SignalValue {
  const definition = parseValueSchema(schema);
  if (definition.type === 'boolean') {
    if (typeof input !== 'boolean') throw new DeviceValidationError('boolean-value');
    return input;
  }
  if (definition.type === 'enum') {
    if (typeof input !== 'string' || !definition.values.includes(input)) throw new DeviceValidationError('enum-value');
    return input;
  }
  const { min, max } = definition;
  function coordinate(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new DeviceValidationError('value-range');
    return value;
  }
  if (definition.type === 'scalar') return coordinate(input);
  const value = snapshotJson(input);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new DeviceValidationError('vector-value');
  const keys = Object.keys(value);
  if (keys.length !== definition.components.length || keys.some((key) => !definition.components.includes(key as 'x' | 'y'))) throw new DeviceValidationError('vector-components');
  return Object.freeze({ x: coordinate(value.x), y: coordinate(value.y), ...(definition.components.length === 3 ? { z: coordinate(value.z) } : {}) });
}

export function schemasCompatible(source: DeviceCapability, sink: DeviceCapability): boolean {
  if (source.semantic !== sink.semantic || source.schemaVersion !== sink.schemaVersion) return false;
  try {
    const a = parseValueSchema(source.value);
    const b = parseValueSchema(sink.value);
    if (a.type !== b.type) return false;
    if (a.type === 'boolean') return true;
    if (a.type === 'enum' && b.type === 'enum') return a.values.length === b.values.length && a.values.every((value, index) => value === b.values[index]);
    if ((a.type === 'scalar' && b.type === 'scalar') || (a.type === 'vector' && b.type === 'vector')) {
      if (a.unit !== b.unit || a.min !== b.min || a.max !== b.max || a.frame !== b.frame || a.resolution !== b.resolution) return false;
      return a.type === 'scalar' || (b.type === 'vector' && a.components.length === b.components.length && a.components.every((value, index) => value === b.components[index]));
    }
    return false;
  } catch (error) {
    if (error instanceof DeviceValidationError) return false;
    throw error;
  }
}
