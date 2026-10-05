import { DeviceValidationError, parseValueSchema, snapshotJson } from './descriptor.ts';
import type { ValueSchema } from './descriptor.ts';
import { parseMeasurementReport } from './quality.ts';
import { parseObservationTiming } from './observation-timing.ts';
import type { ClockStamp, ObservationTiming } from './observation-timing.ts';
import type { MeasurementFrame, ProcessorIdentity, ScalarMeasurementProcessor } from './measurement-processors.ts';

type ScalarSchema = Extract<ValueSchema, { type: 'scalar' }>;
export interface DeadzoneOptions extends ProcessorIdentity {
  readonly center: number; readonly halfSpan: number; readonly deadzone: number;
}
export interface HysteresisOptions extends ProcessorIdentity { readonly onAt: number; readonly offAt: number }
export interface ResamplerOptions extends ProcessorIdentity { readonly periodMs: number; readonly maxAgeMs: number }
export interface HysteresisEdge {
  readonly value: boolean; readonly timing: ObservationTiming;
  readonly source: Readonly<{ value: number; unit: string; absoluteErrorBound: number; calibrationRevision: number }>;
}
export interface HysteresisEdgeProcessor {
  evaluate(input: unknown, processed: unknown): HysteresisEdge | undefined;
  reset(): void;
}
export interface LatestResampler {
  push(input: unknown): boolean;
  sample(processed: unknown): MeasurementFrame | undefined;
  reset(): void;
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function scalar(input: ValueSchema): ScalarSchema {
  const schema = parseValueSchema(input);
  if (schema.type !== 'scalar') fail('generic-scalar-schema', '$.schema');
  return schema;
}
function options(input: unknown, fields: readonly string[]): Record<string, unknown> {
  const value = snapshotJson(input);
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)))
    fail('generic-options', '$.options');
  const data = value as Record<string, unknown>;
  parseObservationTiming({ capture: { clockId: 'generic-options', at: 0 },
    receipt: { clockId: 'generic-options', at: 0 }, mapping: null,
    processors: [{ id: data.id, version: data.version,
      configurationRevision: data.configurationRevision, processed: { clockId: 'generic-options', at: 0 } }] });
  return data;
}
function identity(data: Record<string, unknown>): ProcessorIdentity {
  return Object.freeze({ id: data.id as string, version: data.version as string,
    configurationRevision: data.configurationRevision as number });
}
function number(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    fail('generic-number', path);
  return value;
}
function frame(input: unknown, schema: ScalarSchema): MeasurementFrame {
  const value = snapshotJson(input);
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !Object.hasOwn(value, 'report') || !Object.hasOwn(value, 'timing'))
    fail('generic-frame', '$');
  return Object.freeze({ report: parseMeasurementReport(value.report, schema),
    timing: parseObservationTiming(value.timing) });
}
function append(input: ObservationTiming, step: ProcessorIdentity, processed: unknown): ObservationTiming {
  if (input.processors.length >= 8) fail('timing-processors', '$.timing.processors');
  return parseObservationTiming({ ...input, processors: [...input.processors, { ...step, processed }] });
}
function commonClock(timing: ObservationTiming): ClockStamp {
  if (timing.capture.clockId !== timing.receipt.clockId || timing.mapping !== null)
    fail('generic-clock', '$.timing');
  return timing.capture;
}
function lineage(timing: ObservationTiming): string {
  return JSON.stringify(timing.processors.map(processor =>
    [processor.id, processor.version, processor.configurationRevision]));
}

/** Maps a complete scalar range to [-1, 1] with a continuous zero-centered deadzone. */
export function createDeadzoneMapper(schemaInput: ValueSchema, inputOptions: DeadzoneOptions): ScalarMeasurementProcessor {
  const schema = scalar(schemaInput);
  const data = options(inputOptions, ['id', 'version', 'configurationRevision', 'center', 'halfSpan', 'deadzone']);
  const center = number(data.center, '$.options.center', schema.min, schema.max);
  const halfSpan = number(data.halfSpan, '$.options.halfSpan', Number.MIN_VALUE, 1e12);
  const deadzone = number(data.deadzone, '$.options.deadzone', 0, 0.95);
  if (center - halfSpan > schema.min || center + halfSpan < schema.max)
    fail('generic-mapping-range', '$.options.halfSpan');
  const step = identity(data);
  const outputSchema = scalar({ type: 'scalar', unit: '1', min: -1, max: 1 });
  return Object.freeze({
    process(input: unknown, processed: unknown): MeasurementFrame {
      const current = frame(input, schema), timing = append(current.timing, step, processed);
      if (current.report.status !== 'valid') return Object.freeze({ report: current.report, timing });
      const normalized = (current.report.value - center) / halfSpan;
      const magnitude = Math.abs(normalized);
      const mapped = magnitude <= deadzone ? 0 : Math.sign(normalized) * (magnitude - deadzone) / (1 - deadzone);
      const value = Math.max(-1, Math.min(1, mapped));
      const error = current.report.uncertainty.absoluteErrorBound / (halfSpan * (1 - deadzone)) +
        Number.EPSILON * (Math.abs(normalized) + Math.abs(mapped) + 1) * 16;
      const report = !Number.isFinite(value) || !Number.isFinite(error) || error > 2 ?
        parseMeasurementReport({ status: 'unavailable', faults: [{ code: 'processor:saturation' }] }, outputSchema) :
        parseMeasurementReport({ status: 'valid', value, calibration: current.report.calibration,
          uncertainty: { absoluteErrorBound: error, unit: '1' }, faults: [] }, outputSchema);
      return Object.freeze({ report, timing });
    },
    reset(): void { /* stateless */ },
  });
}

/** Emits a boolean only when uncertainty makes a threshold transition decisive. */
export function createHysteresisEdgeProcessor(schemaInput: ValueSchema,
  inputOptions: HysteresisOptions): HysteresisEdgeProcessor {
  const schema = scalar(schemaInput);
  const data = options(inputOptions, ['id', 'version', 'configurationRevision', 'onAt', 'offAt']);
  const onAt = number(data.onAt, '$.options.onAt', schema.min, schema.max);
  const offAt = number(data.offAt, '$.options.offAt', schema.min, schema.max);
  if (offAt >= onAt) fail('generic-hysteresis-order', '$.options');
  const step = identity(data);
  let state: boolean | undefined;
  let lastCapture: ClockStamp | undefined;
  let revision: number | undefined;
  let upstreamLineage: string | undefined;
  function reset(): void { state = undefined; lastCapture = undefined; revision = undefined; upstreamLineage = undefined; }
  return Object.freeze({
    evaluate(input: unknown, processed: unknown): HysteresisEdge | undefined {
      try {
        const current = frame(input, schema), timing = append(current.timing, step, processed);
        if (current.report.status !== 'valid') { reset(); return undefined; }
        const capture = commonClock(current.timing);
        const currentLineage = lineage(current.timing);
        if (revision !== undefined && (revision !== current.report.calibration.revision ||
            upstreamLineage !== currentLineage)) reset();
        if (lastCapture && (capture.clockId !== lastCapture.clockId || capture.at <= lastCapture.at))
          fail('generic-hysteresis-order', '$.timing.capture');
        lastCapture = capture;
        revision = current.report.calibration.revision;
        upstreamLineage = currentLineage;
        const lower = current.report.value - current.report.uncertainty.absoluteErrorBound;
        const upper = current.report.value + current.report.uncertainty.absoluteErrorBound;
        const next = lower >= onAt ? true : upper <= offAt ? false : state;
        if (next === state) return undefined;
        state = next;
        return Object.freeze({ value: next as boolean, timing,
          source: Object.freeze({ value: current.report.value, unit: schema.unit,
            absoluteErrorBound: current.report.uncertainty.absoluteErrorBound,
            calibrationRevision: current.report.calibration.revision }) });
      } catch (error) { reset(); throw error; }
    },
    reset,
  });
}

/** Zero-order hold at a bounded output period, retaining the actual source capture stamp. */
export function createLatestResampler(schemaInput: ValueSchema, inputOptions: ResamplerOptions): LatestResampler {
  const schema = scalar(schemaInput);
  const data = options(inputOptions, ['id', 'version', 'configurationRevision', 'periodMs', 'maxAgeMs']);
  const periodMs = number(data.periodMs, '$.options.periodMs', 1, 60000);
  const maxAgeMs = number(data.maxAgeMs, '$.options.maxAgeMs', periodMs, 60000);
  const step = identity(data);
  let latest: MeasurementFrame | undefined;
  let lastCapture: ClockStamp | undefined;
  let lastEmittedAt: number | undefined;
  let revision: number | undefined;
  let upstreamLineage: string | undefined;
  function reset(): void { latest = undefined; lastCapture = undefined; lastEmittedAt = undefined;
    revision = undefined; upstreamLineage = undefined; }
  return Object.freeze({
    push(input: unknown): boolean {
      try {
        const current = frame(input, schema);
        if (current.report.status !== 'valid') { reset(); return false; }
        const capture = commonClock(current.timing);
        const currentLineage = lineage(current.timing);
        if (revision !== undefined && (revision !== current.report.calibration.revision ||
            upstreamLineage !== currentLineage)) reset();
        if (lastCapture && (capture.clockId !== lastCapture.clockId || capture.at <= lastCapture.at))
          fail('generic-resample-order', '$.timing.capture');
        latest = current;
        lastCapture = capture;
        revision = current.report.calibration.revision;
        upstreamLineage = currentLineage;
        return true;
      } catch (error) { reset(); throw error; }
    },
    sample(processed: unknown): MeasurementFrame | undefined {
      try {
        if (!latest) return undefined;
        const timing = append(latest.timing, step, processed);
        const at = timing.processors[timing.processors.length - 1]!.processed.at;
        if (lastEmittedAt !== undefined && at < lastEmittedAt)
          fail('generic-resample-order', '$.processed');
        if (at - latest.timing.capture.at > maxAgeMs) { reset(); return undefined; }
        if (lastEmittedAt !== undefined && at - lastEmittedAt < periodMs) return undefined;
        lastEmittedAt = at;
        return Object.freeze({ report: latest.report, timing });
      } catch (error) { reset(); throw error; }
    },
    reset,
  });
}
