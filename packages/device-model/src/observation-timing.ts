import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import type { JsonValue } from './descriptor.ts';

export interface ClockStamp { readonly clockId: string; readonly at: number }
export interface CaptureMapping {
  readonly earliest: number; readonly latest: number;
  readonly uncertaintyMs: number; readonly maxDriftPpm: number;
}
export interface ProcessorTimingStep {
  readonly id: string; readonly version: string; readonly configurationRevision: number;
  readonly processed: ClockStamp;
}
export interface ObservationTiming {
  readonly capture: ClockStamp; readonly receipt: ClockStamp;
  readonly mapping: CaptureMapping | null; readonly processors: readonly ProcessorTimingStep[];
}

const PROCESSOR_ID = /^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(input: JsonValue | undefined, path: string): Record<string, JsonValue> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('timing-object', path);
  return input;
}
function closed(value: Record<string, JsonValue>, keys: readonly string[], path: string): void {
  const names = Object.keys(value);
  if (names.length !== keys.length || names.some(name => !keys.includes(name)) || keys.some(name => !Object.hasOwn(value, name)))
    fail('timing-fields', path);
}
function finiteTime(value: JsonValue | undefined, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    fail('timing-time', path);
  return value;
}
function clockId(value: JsonValue | undefined, path: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 128 || value.trim() !== value ||
      Array.from(value).some(character => { const code = character.charCodeAt(0); return code <= 31 || code >= 127 && code <= 159; }))
    fail('timing-clock-id', path);
  return value;
}
function stamp(input: JsonValue | undefined, path: string): ClockStamp {
  const value = object(input, path); closed(value, ['clockId', 'at'], path);
  return Object.freeze({ clockId: clockId(value.clockId, `${path}.clockId`), at: finiteTime(value.at, `${path}.at`) });
}

/** Validates inert timing evidence; it cannot authenticate a producer's clock claim. */
export function parseObservationTiming(input: unknown): ObservationTiming {
  const value = object(snapshotJson(input), '$');
  closed(value, ['capture', 'receipt', 'mapping', 'processors'], '$');
  const capture = stamp(value.capture, '$.capture');
  const receipt = stamp(value.receipt, '$.receipt');
  let mapping: CaptureMapping | null = null;
  if (capture.clockId === receipt.clockId) {
    if (value.mapping !== null || capture.at > receipt.at) fail('timing-mapping', '$.mapping');
  } else {
    const map = object(value.mapping, '$.mapping');
    closed(map, ['earliest', 'latest', 'uncertaintyMs', 'maxDriftPpm'], '$.mapping');
    const earliest = finiteTime(map.earliest, '$.mapping.earliest');
    const latest = finiteTime(map.latest, '$.mapping.latest');
    if (earliest > latest || earliest > receipt.at) fail('timing-mapping', '$.mapping');
    const uncertaintyMs = finiteTime(map.uncertaintyMs, '$.mapping.uncertaintyMs');
    if (uncertaintyMs > 60000 || uncertaintyMs !== (latest - earliest) / 2)
      fail('timing-uncertainty', '$.mapping.uncertaintyMs');
    if (typeof map.maxDriftPpm !== 'number' || !Number.isFinite(map.maxDriftPpm) ||
        map.maxDriftPpm < 0 || map.maxDriftPpm > 10000) fail('timing-drift', '$.mapping.maxDriftPpm');
    mapping = Object.freeze({ earliest, latest, uncertaintyMs, maxDriftPpm: map.maxDriftPpm });
  }
  if (!Array.isArray(value.processors) || value.processors.length > 8) fail('timing-processors', '$.processors');
  let previous = receipt.at;
  const processors = value.processors.map((input, index) => {
    const path = `$.processors[${index}]`, step = object(input, path);
    closed(step, ['id', 'version', 'configurationRevision', 'processed'], path);
    if (typeof step.id !== 'string' || step.id.length > 128 || !PROCESSOR_ID.test(step.id)) fail('timing-processor-id', `${path}.id`);
    if (typeof step.version !== 'string' || !step.version.length || step.version.length > 64 || step.version.trim() !== step.version ||
        Array.from(step.version).some(character => character.charCodeAt(0) < 32)) fail('timing-processor-version', `${path}.version`);
    if (typeof step.configurationRevision !== 'number' || !Number.isSafeInteger(step.configurationRevision) ||
        step.configurationRevision < 1 || step.configurationRevision > 2147483647)
      fail('timing-processor-revision', `${path}.configurationRevision`);
    const processed = stamp(step.processed, `${path}.processed`);
    if (processed.clockId !== receipt.clockId || processed.at < previous) fail('timing-processor-order', `${path}.processed`);
    previous = processed.at;
    return Object.freeze({ id: step.id, version: step.version, configurationRevision: step.configurationRevision, processed });
  });
  return Object.freeze({ capture, receipt, mapping, processors: Object.freeze(processors) });
}

/** Returns only a conservative age interval in the receipt clock. */
export function observationAgeBounds(input: unknown): Readonly<{ earliestMs: number; latestMs: number }> {
  const timing = parseObservationTiming(input);
  const latestMs = timing.receipt.at - (timing.mapping?.earliest ?? timing.capture.at);
  const earliestMs = Math.max(0, timing.receipt.at - (timing.mapping?.latest ?? timing.capture.at));
  return Object.freeze({ earliestMs, latestMs });
}

/** Raw timestamps are comparable only within the same declared clock. */
export function compareClockStamps(first: unknown, second: unknown): -1 | 0 | 1 {
  const left = stamp(snapshotJson(first), '$.first'), right = stamp(snapshotJson(second), '$.second');
  if (left.clockId !== right.clockId) fail('unsupported-clock-comparison', '$');
  return left.at < right.at ? -1 : left.at > right.at ? 1 : 0;
}
