import { DeviceValidationError, parseValueSchema, snapshotJson } from './descriptor.ts';
import { parseSignalValue } from './sample.ts';
import type { SignalValue, ValueSchema } from './descriptor.ts';

type NumericSchema = Extract<ValueSchema, { type: 'scalar' | 'vector' }>;
type UnitDimension = 'temperature' | 'length' | 'angle' | 'time' | 'mass' | 'information' | 'dimensionless';
interface KnownUnit { readonly dimension: UnitDimension; readonly scale: number; readonly offset: number }

const UNITS: Readonly<Record<string, KnownUnit>> = Object.freeze({
  Cel: { dimension: 'temperature', scale: 1, offset: 273.15 },
  K: { dimension: 'temperature', scale: 1, offset: 0 },
  m: { dimension: 'length', scale: 1, offset: 0 },
  cm: { dimension: 'length', scale: 0.01, offset: 0 },
  mm: { dimension: 'length', scale: 0.001, offset: 0 },
  rad: { dimension: 'angle', scale: 1, offset: 0 },
  deg: { dimension: 'angle', scale: Math.PI / 180, offset: 0 },
  s: { dimension: 'time', scale: 1, offset: 0 },
  ms: { dimension: 'time', scale: 0.001, offset: 0 },
  kg: { dimension: 'mass', scale: 1, offset: 0 },
  g: { dimension: 'mass', scale: 0.001, offset: 0 },
  By: { dimension: 'information', scale: 1, offset: 0 },
  KiBy: { dimension: 'information', scale: 1024, offset: 0 },
  '1': { dimension: 'dimensionless', scale: 1, offset: 0 },
});
const UNIT_TOKEN = /^(?:1|[A-Za-z][A-Za-z0-9]*(?:[.*/][A-Za-z][A-Za-z0-9]*)*)$/;

export interface UnitConverterOptions {
  readonly decimalPlaces: number;
  readonly maxAbsoluteError: number;
}

export interface UnitConversionMetadata {
  readonly sourceUnit: string;
  readonly targetUnit: string;
  readonly scale: number;
  readonly offset: number;
  readonly decimalPlaces: number;
  readonly maxAbsoluteError: number;
  readonly worstCaseAbsoluteError: number;
}

export interface UnitConverter {
  readonly metadata: UnitConversionMetadata;
  convert(input: unknown): SignalValue;
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }

/** Validates an explicit-conversion token without changing legacy descriptor/1 parsing. */
export function parseUnitToken(input: unknown): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 128 || !UNIT_TOKEN.test(input))
    fail('unit-representation', '$.unit');
  return input;
}

/** Explicitly converts a complete numeric schema, without relaxing route compatibility. */
export function createUnitConverter(sourceInput: ValueSchema, targetInput: ValueSchema, options: UnitConverterOptions): UnitConverter {
  const source = parseValueSchema(sourceInput);
  const target = parseValueSchema(targetInput);
  if ((source.type !== 'scalar' && source.type !== 'vector') || source.type !== target.type)
    fail('unit-shape', '$.target');
  const numericSource = source as NumericSchema;
  const numericTarget = target as NumericSchema;
  parseUnitToken(numericSource.unit);
  parseUnitToken(numericTarget.unit);
  if (numericSource.frame !== numericTarget.frame ||
      (numericSource.type === 'vector' && numericTarget.type === 'vector' &&
        (numericSource.components.length !== numericTarget.components.length ||
          numericSource.components.some((name, index) => name !== numericTarget.components[index]))))
    fail('unit-frame', '$.target.frame');
  const optionsSnapshot = snapshotJson(options);
  if (optionsSnapshot === null || typeof optionsSnapshot !== 'object' || Array.isArray(optionsSnapshot) ||
      Object.keys(optionsSnapshot).length !== 2 || !Object.hasOwn(optionsSnapshot, 'decimalPlaces') ||
      !Object.hasOwn(optionsSnapshot, 'maxAbsoluteError')) fail('conversion-options', '$.options');
  const { decimalPlaces, maxAbsoluteError } = optionsSnapshot;
  if (typeof decimalPlaces !== 'number' || !Number.isInteger(decimalPlaces) ||
      decimalPlaces < 0 || decimalPlaces > 12)
    fail('conversion-precision', '$.options.decimalPlaces');
  if (typeof maxAbsoluteError !== 'number' || !Number.isFinite(maxAbsoluteError) || maxAbsoluteError < 0)
    fail('conversion-budget', '$.options.maxAbsoluteError');
  const budget: number = maxAbsoluteError;

  const from = UNITS[numericSource.unit];
  const to = UNITS[numericTarget.unit];
  if (numericSource.unit !== numericTarget.unit && (!from || !to || from.dimension !== to.dimension))
    fail('incompatible-unit', '$.target.unit');
  const scale = numericSource.unit === numericTarget.unit ? 1 : from!.scale / to!.scale;
  const offset = numericSource.unit === numericTarget.unit ? 0 : (from!.offset - to!.offset) / to!.scale;
  if (!Number.isFinite(scale) || !Number.isFinite(offset)) fail('conversion-overflow', '$.target');

  const factor = 10 ** decimalPlaces;
  const step = 1 / factor;
  const endpoints = [numericSource.min * scale + offset, numericSource.max * scale + offset];
  if (endpoints.some((value) => !Number.isFinite(value) || Math.abs(value * factor) > Number.MAX_SAFE_INTEGER))
    fail('conversion-precision', '$.target');
  const maxOutput = Math.max(...endpoints.map(Math.abs));
  const maxInput = Math.max(Math.abs(numericSource.min), Math.abs(numericSource.max));
  const floatMargin = Number.EPSILON * (maxInput * Math.abs(scale) + Math.abs(offset) + maxOutput + 1) * 16;
  const sourceError = (numericSource.resolution ?? 0) * Math.abs(scale) / 2;
  const worstCaseAbsoluteError = sourceError + step / 2 + floatMargin;
  if (!Number.isFinite(worstCaseAbsoluteError) || worstCaseAbsoluteError > budget)
    fail('conversion-budget', '$.options.maxAbsoluteError');
  if (numericTarget.resolution !== undefined) {
    const requiredResolution = Math.max(numericSource.resolution === undefined ? 0 : numericSource.resolution * Math.abs(scale), step);
    const resolutionTolerance = Number.EPSILON * Math.max(requiredResolution, numericTarget.resolution) * 4;
    if (numericTarget.resolution + resolutionTolerance < requiredResolution)
      fail('conversion-resolution', '$.target.resolution');
  }
  if (endpoints.some((value) => {
    const rounded = Math.round(value * factor) / factor;
    return rounded < numericTarget.min || rounded > numericTarget.max;
  })) fail('conversion-range', '$.target');

  const metadata: UnitConversionMetadata = Object.freeze({ sourceUnit: numericSource.unit, targetUnit: numericTarget.unit,
    scale, offset, decimalPlaces, maxAbsoluteError: budget, worstCaseAbsoluteError });
  function coordinate(input: number): number {
    const raw = input * scale + offset;
    if (!Number.isFinite(raw) || Math.abs(raw * factor) > Number.MAX_SAFE_INTEGER) fail('conversion-overflow', '$');
    const result = Math.round(raw * factor) / factor;
    if (!Number.isFinite(result) || Math.abs(result - raw) + sourceError > budget)
      fail('conversion-budget', '$');
    return result;
  }
  return Object.freeze({
    metadata,
    convert(input: unknown): SignalValue {
      const value = parseSignalValue(input, numericSource);
      const converted = numericSource.type === 'scalar' ? coordinate(value as number) :
        Object.fromEntries(numericSource.components.map((name) => {
          const component = (value as Record<string, unknown>)[name];
          if (typeof component !== 'number') fail('conversion-shape', '$');
          return [name, coordinate(component)];
        }));
      return parseSignalValue(converted, numericTarget);
    },
  });
}
