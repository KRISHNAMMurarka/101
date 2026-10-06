import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import { parseMotionMeasurement } from './motion-processors.ts';
import type { MotionMeasurement } from './motion-processors.ts';
import { parseObservationTiming } from './observation-timing.ts';
import type { ClockStamp, ObservationTiming } from './observation-timing.ts';
import type { ProcessorIdentity } from './measurement-processors.ts';

export const IMPULSE_FUSION_PROFILE = 'microphone-linear-motion-impulse/1' as const;
export interface PcmImpulseOptions {
  readonly samples: readonly number[] | Float32Array;
  readonly sampleRate: number; readonly sourceId: string; readonly epoch: string;
  readonly calibrationRevision: number; readonly timing: ObservationTiming;
}
/** Dimensionless full-scale PCM features. Neither acoustic pressure nor microphone accuracy is inferred. */
export interface AudioImpulseFeature {
  readonly kind: 'audio'; readonly sourceId: string; readonly epoch: string;
  readonly calibrationRevision: number; readonly quality: 'valid' | 'unavailable';
  readonly peak: number; readonly rms: number; readonly sampleRate: number; readonly sampleCount: number;
  /** Capture denotes the end of the PCM window in its producer clock. */
  readonly timing: ObservationTiming;
}
export interface MotionImpulseFeature {
  readonly kind: 'motion'; readonly sourceId: string; readonly epoch: string;
  readonly quality: 'valid' | 'unavailable'; readonly measurement: MotionMeasurement;
}
export interface ImpulseFusionOptions extends ProcessorIdentity {
  readonly audioSourceId: string; readonly motionSourceId: string;
  readonly audioEpoch: string; readonly motionEpoch: string;
  readonly audioCalibrationRevision: number; readonly motionCalibrationRevision: number; readonly clockId: string;
  readonly audioHigh: number; readonly audioLow: number; readonly motionHigh: number; readonly motionLow: number;
  readonly coincidenceWindowMs: number; readonly refractoryMs: number;
  readonly maxAgeMs: number; readonly maxUncertaintyMs: number; readonly maxGapMs: number;
}
export interface ImpulseCandidate {
  readonly semantic: 'sensor:coincident-impulse/1'; readonly sequence: number;
  readonly audioTiming: ObservationTiming; readonly motionTiming: ObservationTiming; readonly processed: ClockStamp;
}
export type ImpulseFusionResult = Readonly<{ state: 'none' }> | Readonly<{ state: 'candidate'; candidate: ImpulseCandidate }> |
  Readonly<{ state: 'unavailable'; reason: 'source' | 'quality' | 'units' | 'clock' | 'stale' | 'uncertain' }>;
export interface ImpulseFusionProcessor {
  process(input: unknown, processed: unknown): ImpulseFusionResult;
  /** Clears pending/rearming evidence; keeps same-epoch replay/refractory floors. New epochs require a new processor. */
  reset(): void;
}
const NONE = Object.freeze({ state: 'none' as const });
function fail(code: string, path = '$'): never { throw new DeviceValidationError('impulse-' + code, path); }
function fields(input: unknown, names: readonly string[]): Record<string, unknown> {
  const value = snapshotJson(input);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== names.length || names.some(key => !Object.hasOwn(value, key))) fail('fields');
  return value;
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('number');
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  const n = number(value, min, max); if (!Number.isInteger(n)) fail('integer'); return n;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) fail('identity'); return value;
}
function quality(value: unknown): AudioImpulseFeature['quality'] {
  if (value !== 'valid' && value !== 'unavailable') fail('quality'); return value;
}
function parseAudio(input: unknown): AudioImpulseFeature {
  const v = fields(input, ['kind', 'sourceId', 'epoch', 'calibrationRevision', 'quality', 'peak', 'rms', 'sampleRate', 'sampleCount', 'timing']);
  if (v.kind !== 'audio') fail('kind');
  const peak = number(v.peak, 0, 1), rms = number(v.rms, 0, 1);
  if (rms > peak) fail('energy');
  const sampleRate = integer(v.sampleRate, 8000, 96000), sampleCount = integer(v.sampleCount, 1, 1024);
  if (1000 * sampleCount / sampleRate > 50) fail('window');
  return Object.freeze({ kind: 'audio', sourceId: token(v.sourceId), epoch: token(v.epoch),
    calibrationRevision: integer(v.calibrationRevision, 0, 2147483647), quality: quality(v.quality), peak, rms, sampleRate, sampleCount,
    timing: parseObservationTiming(v.timing) });
}
function parseMotion(input: unknown): MotionImpulseFeature {
  const v = fields(input, ['kind', 'sourceId', 'epoch', 'quality', 'measurement']);
  if (v.kind !== 'motion') fail('kind');
  return Object.freeze({ kind: 'motion', sourceId: token(v.sourceId), epoch: token(v.epoch), quality: quality(v.quality),
    measurement: parseMotionMeasurement(v.measurement) });
}

/** Copies at most 1024 finite PCM samples, then drops them. No capture, storage, device selection or permissions. */
export function measurePcmImpulse(input: PcmImpulseOptions): AudioImpulseFeature {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) fail('fields');
  const names = ['samples', 'sampleRate', 'sourceId', 'epoch', 'calibrationRevision', 'timing'];
  const keys = Reflect.ownKeys(input); if (keys.length !== names.length || names.some(key => !keys.includes(key))) fail('fields');
  const v: Record<string, unknown> = {};
  for (const key of names) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('fields'); v[key] = property.value;
  }
  const samples = v.samples;
  let count: number, read: (index: number) => unknown;
  if (Array.isArray(samples) && Object.getPrototypeOf(samples) === Array.prototype) {
    count = integer(Object.getOwnPropertyDescriptor(samples, 'length')?.value, 1, 1024);
    if (Reflect.ownKeys(samples).length !== count + 1) fail('pcm');
    read = index => {
      const property = Object.getOwnPropertyDescriptor(samples, String(index));
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('pcm'); return property.value;
    };
  } else if (ArrayBuffer.isView(samples) && Object.getPrototypeOf(samples) === Float32Array.prototype) {
    const proto = Object.getPrototypeOf(Float32Array.prototype);
    const length = Object.getOwnPropertyDescriptor(proto, 'length')!.get!, buffer = Object.getOwnPropertyDescriptor(proto, 'buffer')!.get!;
    if (!(Reflect.apply(buffer, samples, []) instanceof ArrayBuffer)) fail('pcm');
    count = integer(Reflect.apply(length, samples, []), 1, 1024);
    read = index => (samples as Float32Array)[index];
  } else fail('pcm');
  const sampleRate = integer(v.sampleRate, 8000, 96000); if (1000 * count / sampleRate > 50) fail('window');
  let peak = 0, sum = 0;
  for (let i = 0; i < count; i++) { const sample = number(read(i), -1, 1); peak = Math.max(peak, Math.abs(sample)); sum += sample * sample; }
  return parseAudio({ kind: 'audio', sourceId: v.sourceId, epoch: v.epoch, calibrationRevision: v.calibrationRevision,
    quality: 'valid', peak, rms: Math.min(peak, Math.sqrt(sum / count)), sampleRate, sampleCount: count, timing: v.timing });
}

interface Pulse { readonly timing: ObservationTiming; readonly earliest: number; readonly latest: number }
/**
 * A two-source coincidence candidate, not a physical tap classifier or safety control.
 * Fixed reviewed sources/calibrations, local processing, at most two retained timing envelopes.
 * Both low baselines must rearm; invalid/lost/stale inputs erase pending evidence.
 * Capture mappings are supplied evidence, not authentication. Runtime grants are still required.
 */
export function createImpulseFusionProcessor(input: ImpulseFusionOptions): ImpulseFusionProcessor {
  const v = fields(input, ['id', 'version', 'configurationRevision', 'audioSourceId', 'motionSourceId', 'audioEpoch', 'motionEpoch',
    'audioCalibrationRevision', 'motionCalibrationRevision', 'clockId', 'audioHigh', 'audioLow', 'motionHigh', 'motionLow',
    'coincidenceWindowMs', 'refractoryMs', 'maxAgeMs', 'maxUncertaintyMs', 'maxGapMs']);
  const identity = parseObservationTiming({ ...{ capture: { clockId: 'options', at: 0 }, receipt: { clockId: 'options', at: 0 }, mapping: null },
    processors: [{ id: v.id, version: v.version, configurationRevision: v.configurationRevision, processed: { clockId: 'options', at: 0 } }] }).processors[0]!;
  const audioId = token(v.audioSourceId), motionId = token(v.motionSourceId), audioEpoch = token(v.audioEpoch), motionEpoch = token(v.motionEpoch);
  if (audioId === motionId) fail('source');
  const audioCalibration = integer(v.audioCalibrationRevision, 1, 2147483647), motionCalibration = integer(v.motionCalibrationRevision, 1, 2147483647);
  const clockId = token(v.clockId), audioHigh = number(v.audioHigh, Number.EPSILON, 1), audioLow = number(v.audioLow, 0, 1);
  const motionHigh = number(v.motionHigh, Number.EPSILON, 1000), motionLow = number(v.motionLow, 0, 1000);
  const window = number(v.coincidenceWindowMs, 1, 100), refractory = number(v.refractoryMs, window, 5000);
  const maxAge = number(v.maxAgeMs, window, 1000), maxUncertainty = number(v.maxUncertaintyMs, 0, window / 2), maxGap = number(v.maxGapMs, maxAge, 5000);
  if (audioLow >= audioHigh || motionLow >= motionHigh) fail('threshold');
  let audioArmed = false, motionArmed = false, audioPulse: Pulse | undefined, motionPulse: Pulse | undefined;
  let lastAt: number | undefined, lastAudio: ClockStamp | undefined, lastMotion: ClockStamp | undefined, emittedAt: number | undefined, sequence = 0;
  function clear(): void { audioArmed = false; motionArmed = false; audioPulse = undefined; motionPulse = undefined; }
  function reset(): void { clear(); }
  function unavailable(reason: Extract<ImpulseFusionResult, { state: 'unavailable' }>['reason']): ImpulseFusionResult {
    clear(); return Object.freeze({ state: 'unavailable', reason });
  }
  function append(timing: ObservationTiming, processed: ClockStamp): ObservationTiming {
    return parseObservationTiming({ ...timing, processors: [...timing.processors, { id: identity.id, version: identity.version,
      configurationRevision: identity.configurationRevision, processed }] });
  }
  return Object.freeze({ reset, process(input: unknown, processed: unknown): ImpulseFusionResult {
    try {
      const point = fields(processed, ['clockId', 'at']), at = number(point.at, 0, Number.MAX_SAFE_INTEGER);
      if (point.clockId !== clockId) return unavailable('clock');
      if (lastAt !== undefined && at < lastAt) fail('order');
      if (lastAt !== undefined && at - lastAt > maxGap) clear(); lastAt = at;
      const raw = snapshotJson(input); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('fields');
      const value = raw.kind === 'audio' ? parseAudio(raw) : parseMotion(raw), isAudio = value.kind === 'audio';
      const t = isAudio ? value.timing : value.measurement.timing;
      const calibration = isAudio ? value.calibrationRevision : value.measurement.calibrationRevision;
      if (value.sourceId !== (isAudio ? audioId : motionId) || value.epoch !== (isAudio ? audioEpoch : motionEpoch) ||
          calibration !== (isAudio ? audioCalibration : motionCalibration)) return unavailable('source');
      if (value.quality !== 'valid') return unavailable('quality');
      if (!isAudio && (value.measurement.units.acceleration !== 'm/s2' || value.measurement.accelerationKind !== 'linear')) return unavailable('units');
      if (t.receipt.clockId !== clockId || t.receipt.at > at || t.processors.some(step => step.processed.at > at)) return unavailable('clock');
      const previous = isAudio ? lastAudio : lastMotion;
      if (previous && (previous.clockId !== t.capture.clockId || t.capture.at <= previous.at)) fail('order');
      if (isAudio) lastAudio = t.capture; else lastMotion = t.capture;
      const duration = isAudio ? 1000 * value.sampleCount / value.sampleRate : 0;
      const earliest = (t.mapping?.earliest ?? t.capture.at) - duration, latest = t.mapping?.latest ?? t.capture.at;
      if ((t.mapping?.uncertaintyMs ?? 0) > maxUncertainty || latest > at || earliest < 0) return unavailable('uncertain');
      if (at - earliest > maxAge) return unavailable('stale');
      if (audioPulse && at - audioPulse.earliest > maxAge) audioPulse = undefined;
      if (motionPulse && at - motionPulse.earliest > maxAge) motionPulse = undefined;
      const magnitude = isAudio ? value.peak : Math.hypot(...value.measurement.acceleration);
      const high = isAudio ? audioHigh : motionHigh, low = isAudio ? audioLow : motionLow;
      let armed = isAudio ? audioArmed : motionArmed;
      if (magnitude <= low) armed = true;
      if (magnitude >= high) {
        if (armed && (emittedAt === undefined || at - emittedAt >= refractory)) {
          const pulse = Object.freeze({ timing: append(t, { clockId, at }), earliest, latest });
          if (isAudio) audioPulse = pulse; else motionPulse = pulse;
        }
        armed = false;
      }
      if (isAudio) audioArmed = armed; else motionArmed = armed;
      if (!audioPulse || !motionPulse || Math.max(audioPulse.latest, motionPulse.latest) - Math.min(audioPulse.earliest, motionPulse.earliest) > window) return NONE;
      if (sequence === Number.MAX_SAFE_INTEGER) fail('sequence');
      const candidate = Object.freeze({ semantic: 'sensor:coincident-impulse/1' as const, sequence: ++sequence,
        audioTiming: audioPulse.timing, motionTiming: motionPulse.timing, processed: Object.freeze({ clockId, at }) });
      audioPulse = undefined; motionPulse = undefined; audioArmed = false; motionArmed = false; emittedAt = at;
      return Object.freeze({ state: 'candidate', candidate });
    } catch (error) { reset(); throw error; }
  } });
}
