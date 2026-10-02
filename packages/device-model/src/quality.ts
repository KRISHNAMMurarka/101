import { DeviceValidationError, parseValueSchema, snapshotJson } from './descriptor.ts';
import type { JsonValue, ValueSchema } from './descriptor.ts';
import { parseSignalValue } from './sample.ts';

export interface MeasurementFault { readonly code: string }
export type MeasurementReport =
  | Readonly<{ status: 'valid'; value: number; calibration: Readonly<{ revision: number }>;
      uncertainty: Readonly<{ absoluteErrorBound: number; unit: string }>;
      faults: readonly MeasurementFault[] }>
  | Readonly<{ status: 'stale' | 'unavailable'; faults: readonly MeasurementFault[] }>;

const FAULT_CODE = /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(input: JsonValue, path: string): Record<string, JsonValue> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('measurement-object', path);
  return input;
}
function closed(value: Record<string, JsonValue>, keys: readonly string[], path: string): void {
  const names = Object.keys(value);
  if (names.length !== keys.length || names.some(name => !keys.includes(name)) || keys.some(key => !Object.hasOwn(value, key)))
    fail('measurement-fields', path);
}

/** Parses producer claims as inert evidence; it does not verify physical accuracy. */
export function parseMeasurementReport(input: unknown, schema: ValueSchema): MeasurementReport {
  const definition = parseValueSchema(schema);
  if (definition.type !== 'scalar') fail('measurement-schema', '$.schema');
  const value = object(snapshotJson(input), '$');
  if (value.status === 'valid') {
    closed(value, ['status', 'value', 'calibration', 'uncertainty', 'faults'], '$');
    const parsed = parseSignalValue(value.value, definition);
    if (typeof parsed !== 'number') fail('measurement-value', '$.value');
    const calibration = object(value.calibration, '$.calibration');
    closed(calibration, ['revision'], '$.calibration');
    if (typeof calibration.revision !== 'number' || !Number.isSafeInteger(calibration.revision) ||
        calibration.revision < 1 || calibration.revision > 2147483647) fail('calibration-revision', '$.calibration.revision');
    const uncertainty = object(value.uncertainty, '$.uncertainty');
    closed(uncertainty, ['absoluteErrorBound', 'unit'], '$.uncertainty');
    if (typeof uncertainty.absoluteErrorBound !== 'number' || !Number.isFinite(uncertainty.absoluteErrorBound) ||
        uncertainty.absoluteErrorBound < 0 || uncertainty.absoluteErrorBound > definition.max - definition.min)
      fail('measurement-uncertainty', '$.uncertainty.absoluteErrorBound');
    if (uncertainty.unit !== definition.unit) fail('measurement-unit', '$.uncertainty.unit');
    if (!Array.isArray(value.faults) || value.faults.length !== 0) fail('measurement-faults', '$.faults');
    return value as unknown as MeasurementReport;
  }
  if (value.status !== 'stale' && value.status !== 'unavailable') fail('measurement-status', '$.status');
  closed(value, ['status', 'faults'], '$');
  if (!Array.isArray(value.faults) || value.faults.length > 8) fail('measurement-faults', '$.faults');
  const seen = new Set<string>();
  value.faults.forEach((fault, index) => {
    const path = `$.faults[${index}]`;
    const entry = object(fault, path);
    closed(entry, ['code'], path);
    if (typeof entry.code !== 'string' || entry.code.length > 128 || !FAULT_CODE.test(entry.code) || seen.has(entry.code))
      fail('measurement-fault-code', `${path}.code`);
    seen.add(entry.code);
  });
  return value as unknown as MeasurementReport;
}
