import { snapshotJson } from './descriptor.ts';
import type { JsonValue } from './descriptor.ts';
import { parseObservationTiming } from './observation-timing.ts';
import type { CaptureMapping } from './observation-timing.ts';

export const PIPELINE_TIMING_PROFILE = 'capture-output-timing/1' as const;
export const PIPELINE_TIMING_LIMITS = Object.freeze({ samples: 2048, durationMs: 60000 });
export interface PipelineTimingTrace {
  readonly source: { readonly clockId: string; readonly capturedAt: number; readonly encodingStartedAt: number; readonly encodedAt: number };
  readonly target: { readonly clockId: string; readonly receivedAt: number; readonly decodedAt: number; readonly appliedAt: number; readonly renderedAt: number };
  readonly mapping: CaptureMapping | null;
}
export interface PipelineTimingInterval { readonly minMs: number; readonly maxMs: number }
export type PipelineTimingStage = 'processing' | 'encoding' | 'transit' | 'decoding' | 'sink' | 'render' | 'captureToOutput';
export interface PipelineTimingDistribution {
  readonly p50: PipelineTimingInterval | null; readonly p95: PipelineTimingInterval | null; readonly p99: PipelineTimingInterval | null;
}
export interface PipelineTimingSnapshot {
  readonly profile: typeof PIPELINE_TIMING_PROFILE; readonly capacity: number; readonly samples: number;
  readonly accepted: number; readonly rejected: number; readonly evicted: number; readonly closed: boolean;
  readonly maxClockUncertaintyMs: number | null;
  readonly stages: Readonly<Record<PipelineTimingStage, PipelineTimingDistribution>>;
}
export interface PipelineTimingCollector {
  /** Complete local instrumentation only. This does not authenticate a clock or authorize an effect. */
  record(input: unknown): boolean;
  snapshot(): PipelineTimingSnapshot;
  clear(): void;
  close(): void;
}
const STAGES: readonly PipelineTimingStage[] = ['processing', 'encoding', 'transit', 'decoding', 'sink', 'render', 'captureToOutput'];
type Sample = { stages: Record<PipelineTimingStage, PipelineTimingInterval>; uncertaintyMs: number };
function object(input: JsonValue | undefined, keys: readonly string[]): Record<string, JsonValue> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length ||
      keys.some(key => !Object.hasOwn(input, key))) throw new TypeError('Incomplete timing fields');
  return input;
}
function time(input: JsonValue | undefined): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > Number.MAX_SAFE_INTEGER)
    throw new TypeError('Invalid timing stamp');
  return input;
}
function interval(minMs: number, maxMs = minMs): PipelineTimingInterval {
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs < 0 || maxMs < minMs || maxMs > PIPELINE_TIMING_LIMITS.durationMs)
    throw new RangeError('Invalid timing duration');
  return Object.freeze({ minMs, maxMs });
}
function sample(input: unknown): Sample {
  const value = object(snapshotJson(input), ['source', 'target', 'mapping']);
  const source = object(value.source, ['clockId', 'capturedAt', 'encodingStartedAt', 'encodedAt']);
  const target = object(value.target, ['clockId', 'receivedAt', 'decodedAt', 'appliedAt', 'renderedAt']);
  const capturedAt = time(source.capturedAt), encodingStartedAt = time(source.encodingStartedAt), encodedAt = time(source.encodedAt);
  const receivedAt = time(target.receivedAt), decodedAt = time(target.decodedAt), appliedAt = time(target.appliedAt), renderedAt = time(target.renderedAt);
  if (capturedAt > encodingStartedAt || encodingStartedAt > encodedAt || receivedAt > decodedAt || decodedAt > appliedAt || appliedAt > renderedAt)
    throw new RangeError('Reversed timing stamps');
  const timing = parseObservationTiming({ capture: { clockId: source.clockId, at: capturedAt },
    receipt: { clockId: target.clockId, at: receivedAt }, mapping: value.mapping, processors: [] });
  const earliest = timing.mapping?.earliest ?? capturedAt, latest = timing.mapping?.latest ?? capturedAt;
  const encodedElapsed = encodedAt - capturedAt;
  const drift = (timing.mapping?.maxDriftPpm ?? 0) / 1_000_000;
  const duration = (elapsed: number) => interval(elapsed / (1 + drift), elapsed / (1 - drift));
  const encodingElapsed = duration(encodedElapsed);
  const encodedEarliest = earliest + encodingElapsed.minMs, encodedLatest = latest + encodingElapsed.maxMs;
  if (encodedEarliest > receivedAt) throw new RangeError('Encoded data arrives before its conservative time bound');
  return { uncertaintyMs: (encodedLatest - encodedEarliest) / 2, stages: {
    processing: duration(encodingStartedAt - capturedAt), encoding: duration(encodedAt - encodingStartedAt),
    transit: interval(Math.max(0, receivedAt - encodedLatest), receivedAt - encodedEarliest),
    decoding: interval(decodedAt - receivedAt), sink: interval(appliedAt - decodedAt), render: interval(renderedAt - appliedAt),
    captureToOutput: interval(Math.max(0, renderedAt - latest), renderedAt - earliest),
  } };
}
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

/** Bounded in-memory latest window. Quantiles are nearest-rank bounds, not physical touch-to-photon measurements. */
export function createPipelineTimingCollector(options: { capacity?: number } = {}): PipelineTimingCollector {
  const capacity = options.capacity ?? 256;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > PIPELINE_TIMING_LIMITS.samples) throw new RangeError('Invalid timing capacity');
  const samples: Sample[] = [];
  let accepted = 0, rejected = 0, evicted = 0, cursor = 0, closed = false;
  function clear() { samples.length = 0; accepted = 0; rejected = 0; evicted = 0; cursor = 0; }
  return Object.freeze({
    record(input: unknown) {
      if (closed) return false;
      let parsed: Sample;
      try { parsed = sample(input); } catch { rejected = increment(rejected); return false; }
      if (samples.length < capacity) samples.push(parsed);
      else { samples[cursor] = parsed; cursor = (cursor + 1) % capacity; evicted = increment(evicted); }
      accepted = increment(accepted); return true;
    },
    snapshot() {
      const stages = {} as Record<PipelineTimingStage, PipelineTimingDistribution>;
      for (const stage of STAGES) {
        const minima = samples.map(value => value.stages[stage].minMs).sort((a, b) => a - b);
        const maxima = samples.map(value => value.stages[stage].maxMs).sort((a, b) => a - b);
        function quantile(fraction: number) {
          if (!samples.length) return null;
          const rank = Math.ceil(samples.length * fraction) - 1;
          return interval(minima[rank]!, maxima[rank]!);
        }
        stages[stage] = Object.freeze({ p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99) });
      }
      return Object.freeze({ profile: PIPELINE_TIMING_PROFILE, capacity, samples: samples.length, accepted, rejected, evicted, closed,
        maxClockUncertaintyMs: samples.length ? Math.max(...samples.map(value => value.uncertaintyMs)) : null, stages: Object.freeze(stages) });
    },
    clear() { if (!closed) clear(); },
    close() { closed = true; clear(); },
  });
}
