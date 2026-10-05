import { DeviceValidationError, snapshotJson } from './descriptor.ts';
import { parseObservationTiming } from './observation-timing.ts';
import type { ClockStamp, ObservationTiming } from './observation-timing.ts';
import type { ProcessorIdentity } from './measurement-processors.ts';
import { normalizeQuaternion, relativeQuaternion } from './motion-math.ts';
import type { Quaternion, Vector3 } from './motion-math.ts';

/** Orientation maps deviceFrame into referenceFrame; vectors remain in deviceFrame axes. */
export interface MotionMeasurement {
  readonly orientation: Quaternion;
  readonly acceleration: Vector3;
  readonly angularVelocity: Vector3;
  readonly units: { readonly acceleration: 'm/s2' | 'g'; readonly angularVelocity: 'rad/s' | 'deg/s' };
  readonly deviceFrame: string;
  readonly referenceFrame: string;
  readonly accelerationKind: 'linear' | 'including-gravity';
  /** Producer calibration generation (0 = unverified), independent of processor configuration. */
  readonly calibrationRevision: number;
  readonly timing: ObservationTiming;
}
export interface MotionMeasurementProcessor {
  process(input: unknown, processed: unknown): MotionMeasurement;
  reset(): void;
}
export interface MotionCalibrationOptions extends ProcessorIdentity {
  readonly deviceFrame: string; readonly sourceReferenceFrame: string;
  readonly targetReferenceFrame: string; readonly neutral: Quaternion;
}
export interface MotionSmoothingOptions extends ProcessorIdentity {
  readonly alpha: number; readonly maxGapMs: number; readonly maxWindowMs: number;
}

function fail(code: string, path: string): never { throw new DeviceValidationError(code, path); }
function object(input: unknown, fields: readonly string[], path: string): Record<string, unknown> {
  const value = snapshotJson(input);
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)))
    fail('motion-fields', path);
  return value;
}
function number(input: unknown, min: number, max: number, path: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) fail('motion-number', path);
  return input;
}
function token(input: unknown, path: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(input)) fail('motion-frame', path);
  return input;
}
function vector(input: unknown, size: number, path: string): readonly number[] {
  if (!Array.isArray(input) || input.length !== size) fail('motion-vector', path);
  return Object.freeze(input.map((value, index) => number(value, -1e6, 1e6, `${path}[${index}]`)));
}
function quaternion(input: unknown, path: string): Quaternion {
  const value = vector(input, 4, path) as Quaternion;
  // Native watch float32 values need a small tolerance, not arbitrary magnitude repair.
  if (Math.abs(Math.hypot(...value) - 1) > 0.001) fail('motion-quaternion', path);
  return Object.freeze(normalizeQuaternion(value));
}
function options(input: unknown, fields: readonly string[]) {
  const data = object(input, ['id', 'version', 'configurationRevision', ...fields], '$.options');
  const step = parseObservationTiming({ capture: { clockId: 'options', at: 0 }, receipt: { clockId: 'options', at: 0 },
    mapping: null, processors: [{ id: data.id, version: data.version, configurationRevision: data.configurationRevision,
      processed: { clockId: 'options', at: 0 } }] }).processors[0]!;
  const identity: ProcessorIdentity = { id: step.id, version: step.version, configurationRevision: step.configurationRevision };
  return { data, identity };
}
function append(timing: ObservationTiming, identity: ProcessorIdentity, processed: unknown,
  capture: ClockStamp = timing.capture): ObservationTiming {
  return parseObservationTiming({ ...timing, capture, processors: [...timing.processors, { ...identity, processed }] });
}

/** Copies declared physical values and timing; no device identity, permission or accuracy is inferred. */
export function parseMotionMeasurement(input: unknown): MotionMeasurement {
  const data = object(input, ['orientation', 'acceleration', 'angularVelocity', 'units', 'deviceFrame',
    'referenceFrame', 'accelerationKind', 'calibrationRevision', 'timing'], '$');
  const units = object(data.units, ['acceleration', 'angularVelocity'], '$.units');
  if (units.acceleration !== 'm/s2' && units.acceleration !== 'g') fail('motion-unit', '$.units.acceleration');
  if (units.angularVelocity !== 'rad/s' && units.angularVelocity !== 'deg/s') fail('motion-unit', '$.units.angularVelocity');
  if (data.accelerationKind !== 'linear' && data.accelerationKind !== 'including-gravity') fail('motion-gravity', '$.accelerationKind');
  const revision = number(data.calibrationRevision, 0, 2147483647, '$.calibrationRevision');
  if (!Number.isInteger(revision)) fail('motion-calibration-revision', '$.calibrationRevision');
  return Object.freeze({ orientation: quaternion(data.orientation, '$.orientation'),
    acceleration: vector(data.acceleration, 3, '$.acceleration') as Vector3,
    angularVelocity: vector(data.angularVelocity, 3, '$.angularVelocity') as Vector3,
    units: Object.freeze({ acceleration: units.acceleration, angularVelocity: units.angularVelocity }),
    deviceFrame: token(data.deviceFrame, '$.deviceFrame'), referenceFrame: token(data.referenceFrame, '$.referenceFrame'),
    accelerationKind: data.accelerationKind, calibrationRevision: revision, timing: parseObservationTiming(data.timing) });
}

/** Explicit standard-g and degree conversion; gravity semantics, axes and capture clocks are preserved. */
export function createMotionUnitProcessor(inputOptions: ProcessorIdentity): MotionMeasurementProcessor {
  const { identity } = options(inputOptions, []);
  return Object.freeze({ process(input: unknown, processed: unknown): MotionMeasurement {
    const current = parseMotionMeasurement(input);
    const scale = (value: Vector3, factor: number) => value.map(component => component * factor);
    return parseMotionMeasurement({ ...current, units: { acceleration: 'm/s2', angularVelocity: 'rad/s' },
      acceleration: scale(current.acceleration, current.units.acceleration === 'g' ? 9.80665 : 1),
      angularVelocity: scale(current.angularVelocity, current.units.angularVelocity === 'deg/s' ? Math.PI / 180 : 1),
      timing: append(current.timing, identity, processed) });
  }, reset(): void { /* stateless */ } });
}

/** Changes only the attitude reference. Sensor vectors are neither scaled nor rotated into game controls. */
export function createMotionCalibrationProcessor(inputOptions: MotionCalibrationOptions): MotionMeasurementProcessor {
  const { data, identity } = options(inputOptions, ['deviceFrame', 'sourceReferenceFrame', 'targetReferenceFrame', 'neutral']);
  const deviceFrame = token(data.deviceFrame, '$.options.deviceFrame');
  const source = token(data.sourceReferenceFrame, '$.options.sourceReferenceFrame');
  const target = token(data.targetReferenceFrame, '$.options.targetReferenceFrame');
  if (source === target) fail('motion-calibration-frame', '$.options.targetReferenceFrame');
  const neutral = quaternion(data.neutral, '$.options.neutral');
  return Object.freeze({ process(input: unknown, processed: unknown): MotionMeasurement {
    const current = parseMotionMeasurement(input);
    if (current.deviceFrame !== deviceFrame || current.referenceFrame !== source) fail('motion-calibration-frame', '$');
    return parseMotionMeasurement({ ...current, orientation: relativeQuaternion(current.orientation, neutral),
      referenceFrame: target, timing: append(current.timing, identity, processed) });
  }, reset(): void { /* stateless */ } });
}

/** Constant-memory EMA with finite history and same-clock capture order; missing/lost input requires reset(). */
export function createMotionSmoothingProcessor(inputOptions: MotionSmoothingOptions): MotionMeasurementProcessor {
  const { data, identity } = options(inputOptions, ['alpha', 'maxGapMs', 'maxWindowMs']);
  const alpha = number(data.alpha, Number.EPSILON, 1, '$.options.alpha');
  const maxGapMs = number(data.maxGapMs, 1, 60000, '$.options.maxGapMs');
  const maxWindowMs = number(data.maxWindowMs, 1, 60000, '$.options.maxWindowMs');
  let previous: MotionMeasurement | undefined, first: ClockStamp | undefined, last: number | undefined, key: string | undefined;
  function reset(): void { previous = undefined; first = undefined; last = undefined; key = undefined; }
  return Object.freeze({ process(input: unknown, processed: unknown): MotionMeasurement {
    try {
      const current = parseMotionMeasurement(input), capture = current.timing.capture;
      if (current.units.acceleration !== 'm/s2' || current.units.angularVelocity !== 'rad/s') fail('motion-filter-units', '$.units');
      if (capture.clockId !== current.timing.receipt.clockId || current.timing.mapping !== null) fail('motion-filter-clock', '$.timing');
      const nextKey = JSON.stringify([capture.clockId, current.deviceFrame, current.referenceFrame, current.accelerationKind,
        current.calibrationRevision, current.timing.processors.map(step => [step.id, step.version, step.configurationRevision])]);
      if (key !== nextKey) reset();
      if (last !== undefined && capture.at <= last) fail('motion-filter-order', '$.timing.capture');
      if (last !== undefined && (capture.at - last > maxGapMs || capture.at - first!.at > maxWindowMs)) reset();
      const blend = (value: readonly number[], prior: readonly number[]) => value.map((component, i) => prior[i]! + (component - prior[i]!) * alpha);
      let orientation = current.orientation, acceleration = current.acceleration, angularVelocity = current.angularVelocity;
      if (previous && alpha < 1) {
        const dot = current.orientation.reduce((sum, component, i) => sum + component * previous!.orientation[i]!, 0);
        const aligned = current.orientation.map(component => dot < 0 ? -component : component);
        orientation = normalizeQuaternion(blend(aligned, previous.orientation) as unknown as Quaternion);
        acceleration = blend(current.acceleration, previous.acceleration) as unknown as Vector3;
        angularVelocity = blend(current.angularVelocity, previous.angularVelocity) as unknown as Vector3;
      }
      const oldest = alpha === 1 ? capture : first ?? capture;
      const result = parseMotionMeasurement({ ...current, orientation, acceleration, angularVelocity,
        timing: append(current.timing, identity, processed, oldest) });
      previous = result; first = oldest; last = capture.at; key = nextKey;
      return result;
    } catch (error) { reset(); throw error; }
  }, reset });
}
