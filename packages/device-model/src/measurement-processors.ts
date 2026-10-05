import { DeviceValidationError, parseValueSchema, snapshotJson } from './descriptor.ts';
import type { ValueSchema } from './descriptor.ts';
import { parseSignalValue } from './sample.ts';
import { createUnitConverter } from './units.ts';
import { parseMeasurementReport } from './quality.ts';
import type { MeasurementReport } from './quality.ts';
import { parseObservationTiming } from './observation-timing.ts';
import type { ClockStamp, ObservationTiming } from './observation-timing.ts';

type ScalarSchema = Extract<ValueSchema, { type: 'scalar' }>;
export interface MeasurementFrame { readonly report: MeasurementReport; readonly timing: ObservationTiming }
export interface ProcessorIdentity { readonly id: string; readonly version: string; readonly configurationRevision: number }
export interface CalibrationOptions extends ProcessorIdentity {
  readonly gain: number; readonly offset: number; readonly absoluteErrorBound: number;
}
export interface ConversionOptions extends ProcessorIdentity {
  readonly decimalPlaces: number; readonly maxAbsoluteError: number;
}
export interface MovingAverageOptions extends ProcessorIdentity {
  readonly windowSize: number; readonly maxGapMs: number;
}
export interface ScalarMeasurementProcessor {
  process(input: unknown, processed: unknown): MeasurementFrame;
  reset(): void;
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function scalar(input: ValueSchema): ScalarSchema {
  const schema = parseValueSchema(input);
  if (schema.type !== 'scalar') fail('processor-scalar-schema', '$.schema');
  return schema;
}
function options(input: unknown, fields: readonly string[]): Record<string, unknown> {
  const value = snapshotJson(input);
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)))
    fail('processor-options', '$.options');
  const data = value as Record<string, unknown>;
  parseObservationTiming({ capture: { clockId: 'processor-options', at: 0 },
    receipt: { clockId: 'processor-options', at: 0 }, mapping: null,
    processors: [{ id: data.id, version: data.version,
      configurationRevision: data.configurationRevision, processed: { clockId: 'processor-options', at: 0 } }] });
  return data;
}
function number(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    fail('processor-number', path);
  return value;
}
function frame(input: unknown, schema: ScalarSchema): MeasurementFrame {
  const value = snapshotJson(input);
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !Object.hasOwn(value, 'report') || !Object.hasOwn(value, 'timing'))
    fail('processor-frame', '$');
  return Object.freeze({ report: parseMeasurementReport(value.report, schema),
    timing: parseObservationTiming(value.timing) });
}
function append(input: ObservationTiming, identity: ProcessorIdentity, processed: unknown,
  capture: ClockStamp = input.capture): ObservationTiming {
  if (input.processors.length >= 8) fail('timing-processors', '$.timing.processors');
  return parseObservationTiming({ capture, receipt: input.receipt, mapping: input.mapping,
    processors: [...input.processors, { ...identity, processed }] });
}
function identity(data: Record<string, unknown>): ProcessorIdentity {
  return Object.freeze({ id: data.id as string, version: data.version as string,
    configurationRevision: data.configurationRevision as number });
}
function output(report: MeasurementReport, timing: ObservationTiming): MeasurementFrame {
  return Object.freeze({ report, timing });
}
function invalidOutput(): MeasurementReport {
  return Object.freeze({ status: 'unavailable', faults: Object.freeze([Object.freeze({ code: 'processor:saturation' })]) });
}
function checkedOutput(value: number, uncertainty: number, schema: ScalarSchema, revision: number): MeasurementReport {
  if (!Number.isFinite(value) || !Number.isFinite(uncertainty) || uncertainty < 0 ||
      uncertainty > schema.max - schema.min || value < schema.min || value > schema.max) return invalidOutput();
  parseSignalValue(value, schema);
  return parseMeasurementReport({ status: 'valid', value, calibration: { revision },
    uncertainty: { absoluteErrorBound: uncertainty, unit: schema.unit }, faults: [] }, schema);
}
function floatingMargin(...values: number[]): number {
  return Number.EPSILON * values.reduce((sum, value) => sum + Math.abs(value), 1) * 16;
}

/** Applies declared affine calibration in one unit; coefficients are not physical certification. */
export function createScalarCalibrationProcessor(sourceInput: ValueSchema, targetInput: ValueSchema,
  inputOptions: CalibrationOptions): ScalarMeasurementProcessor {
  const source = scalar(sourceInput), target = scalar(targetInput);
  if (source.unit !== target.unit || source.frame !== target.frame)
    fail('processor-calibration-unit', '$.target');
  const data = options(inputOptions, ['id', 'version', 'configurationRevision', 'gain', 'offset', 'absoluteErrorBound']);
  const gain = number(data.gain, '$.options.gain', -1e6, 1e6);
  if (gain === 0) fail('processor-calibration-gain', '$.options.gain');
  const offset = number(data.offset, '$.options.offset', -1e9, 1e9);
  const error = number(data.absoluteErrorBound, '$.options.absoluteErrorBound', 0, target.max - target.min);
  const step = identity(data);
  return Object.freeze({
    process(input: unknown, processed: unknown): MeasurementFrame {
      const current = frame(input, source), timing = append(current.timing, step, processed);
      if (current.report.status !== 'valid') return output(current.report, timing);
      const value = current.report.value * gain + offset;
      const uncertainty = Math.abs(gain) * current.report.uncertainty.absoluteErrorBound + error +
        floatingMargin(value, current.report.value * gain, offset);
      return output(checkedOutput(value, uncertainty, target, current.report.calibration.revision), timing);
    },
    reset(): void { /* stateless */ },
  });
}

/** Converts a measured scalar through the explicit unit converter and carries a conservative error bound. */
export function createScalarConversionProcessor(sourceInput: ValueSchema, targetInput: ValueSchema,
  inputOptions: ConversionOptions): ScalarMeasurementProcessor {
  const source = scalar(sourceInput), target = scalar(targetInput);
  const data = options(inputOptions, ['id', 'version', 'configurationRevision', 'decimalPlaces', 'maxAbsoluteError']);
  const converter = createUnitConverter(source, target, {
    decimalPlaces: data.decimalPlaces as number, maxAbsoluteError: data.maxAbsoluteError as number,
  });
  const step = identity(data);
  return Object.freeze({
    process(input: unknown, processed: unknown): MeasurementFrame {
      const current = frame(input, source), timing = append(current.timing, step, processed);
      if (current.report.status !== 'valid') return output(current.report, timing);
      const value = converter.convert(current.report.value) as number;
      const uncertainty = Math.abs(converter.metadata.scale) * current.report.uncertainty.absoluteErrorBound +
        converter.metadata.worstCaseAbsoluteError;
      return output(checkedOutput(value, uncertainty, target, current.report.calibration.revision), timing);
    },
    reset(): void { /* stateless */ },
  });
}

/** Bounded, same-clock moving average; no independence assumption reduces source uncertainty. */
export function createMovingAverageProcessor(schemaInput: ValueSchema,
  inputOptions: MovingAverageOptions): ScalarMeasurementProcessor {
  const schema = scalar(schemaInput);
  const data = options(inputOptions, ['id', 'version', 'configurationRevision', 'windowSize', 'maxGapMs']);
  const windowSize = number(data.windowSize, '$.options.windowSize', 1, 64);
  if (!Number.isInteger(windowSize)) fail('processor-window-size', '$.options.windowSize');
  const maxGapMs = number(data.maxGapMs, '$.options.maxGapMs', 1, 60000);
  const step = identity(data);
  const samples: Array<{ value: number; error: number; capture: ClockStamp }> = [];
  let lastCapture: ClockStamp | undefined;
  let revision: number | undefined;
  let upstreamLineage: string | undefined;
  function reset(): void { samples.length = 0; lastCapture = undefined; revision = undefined; upstreamLineage = undefined; }
  return Object.freeze({
    process(input: unknown, processed: unknown): MeasurementFrame {
      try {
        const current = frame(input, schema);
        if (current.report.status !== 'valid') {
          reset();
          return output(current.report, append(current.timing, step, processed));
        }
        const capture = current.timing.capture;
        if (capture.clockId !== current.timing.receipt.clockId || current.timing.mapping !== null)
          fail('processor-filter-clock', '$.timing');
        if (lastCapture && capture.clockId !== lastCapture.clockId) reset();
        if (lastCapture && capture.at <= lastCapture.at) fail('processor-filter-order', '$.timing.capture');
        if (lastCapture && capture.at - lastCapture.at > maxGapMs) reset();
        if (revision !== undefined && current.report.calibration.revision !== revision) reset();
        const lineage = JSON.stringify(current.timing.processors.map(processor =>
          [processor.id, processor.version, processor.configurationRevision]));
        if (upstreamLineage !== undefined && lineage !== upstreamLineage) reset();
        samples.push({ value: current.report.value,
          error: current.report.uncertainty.absoluteErrorBound, capture });
        if (samples.length > windowSize) samples.shift();
        lastCapture = capture;
        revision = current.report.calibration.revision;
        upstreamLineage = lineage;
        const sum = samples.reduce((total, sample) => total + sample.value, 0);
        const value = sum / samples.length;
        const uncertainty = samples.reduce((total, sample) => total + sample.error, 0) / samples.length +
          floatingMargin(sum, ...samples.map(sample => sample.value));
        const report = checkedOutput(value, uncertainty, schema, revision);
        const oldestCapture = samples[0]?.capture ?? capture;
        if (report.status !== 'valid') reset();
        return output(report, append(current.timing, step, processed, oldestCapture));
      } catch (error) { reset(); throw error; }
    },
    reset,
  });
}
