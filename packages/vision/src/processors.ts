import { DeviceValidationError, parseAssetReference, parseObservationTiming, snapshotJson } from '@101/device-model';
import type { AssetReference, ClockStamp, ObservationTiming, ProcessorIdentity } from '@101/device-model';
import { HandGestureClassifier, PoseClassifier } from './index.ts';
import type { HandGestureClassifierOptions, HandLandmark, HandSignals, PoseClassifierOptions, PoseLandmark, PoseSignals, TrackedHand } from './index.ts';

interface VisionObservation {
  readonly subjectId: string;
  readonly frameId: string;
  /** Inference model provenance; parsing a reference does not verify or load its bytes. */
  readonly model: Readonly<AssetReference>;
  readonly quality: 'valid' | 'stale' | 'unavailable';
  readonly timing: ObservationTiming;
}
export interface PoseObservation extends VisionObservation { readonly landmarks: readonly PoseLandmark[] }
export interface HandObservation extends VisionObservation { readonly hand: TrackedHand | null; readonly frameAspect: number }
export interface LandmarkProcessorOptions extends ProcessorIdentity {
  readonly maxGapMs: number; readonly maxWindowMs: number; readonly maxFrames: number;
}
export interface PoseLandmarkProcessorOptions extends LandmarkProcessorOptions { readonly classifier?: PoseClassifierOptions }
export interface HandLandmarkProcessorOptions extends LandmarkProcessorOptions { readonly classifier?: HandGestureClassifierOptions }
export interface LandmarkProcessorResult<T> extends Omit<VisionObservation, 'quality'> {
  readonly status: 'valid' | 'calibrating' | 'unavailable';
  readonly signals: Readonly<T>;
}
export interface PoseLandmarkProcessor {
  process(input: unknown, processed: unknown): LandmarkProcessorResult<PoseSignals>;
  /** Consumes this frame as an explicit neutral; the next process frame must be newer. */
  calibrateNeutral(input: unknown): boolean;
  reset(): void;
}
export interface HandLandmarkProcessor {
  process(input: unknown, processed: unknown): LandmarkProcessorResult<HandSignals>;
  reset(): void;
}
function fail(code: string, path = '$'): never { throw new DeviceValidationError(code, path); }
function object(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('vision-object');
  const value = input as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('vision-fields');
  return value;
}
function number(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) fail('vision-number');
  return input;
}
function integer(input: unknown, min: number, max: number): number {
  const value = number(input, min, max); if (!Number.isInteger(value)) fail('vision-integer'); return value;
}
function label(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(input)) fail('vision-frame');
  return input;
}
const fields = ['subjectId', 'frameId', 'model', 'quality', 'timing'];
function common(data: Record<string, unknown>): VisionObservation {
  if (!['valid', 'stale', 'unavailable'].includes(data.quality as string)) fail('vision-quality');
  const model = parseAssetReference(data.model);
  if (model.kind !== 'blob' || model.byteLength === 0) fail('vision-model');
  return { subjectId: label(data.subjectId), frameId: label(data.frameId), model,
    quality: data.quality as VisionObservation['quality'], timing: parseObservationTiming(data.timing) };
}
function points(input: unknown, count: number, pose: boolean): (PoseLandmark | HandLandmark)[] {
  if (!Array.isArray(input) || input.length !== count) fail('vision-landmark-count');
  return input.map(point => {
    const data = object(point, pose ? ['x', 'y', 'z', 'visibility'] : ['x', 'y', 'z'], pose ? ['world'] : ['world', 'visibility']);
    // Predictions can extend beyond the image. Keep them, rather than clamping to the visible rectangle.
    const result = { x: number(data.x, -8, 8), y: number(data.y, -8, 8), z: number(data.z, -8, 8),
      ...(Object.hasOwn(data, 'visibility') ? { visibility: number(data.visibility, 0, 1) } : {}) };
    if (!Object.hasOwn(data, 'world')) return result;
    const world = object(data.world, ['x', 'y', 'z']);
    return { ...result, world: { x: number(world.x, -100, 100), y: number(world.y, -100, 100), z: number(world.z, -100, 100) } };
  });
}
/** Selected subject in the adapter's unmirrored image space; metric points keep their model-local origin. */
export function parsePoseObservation(input: unknown): Readonly<PoseObservation> {
  const data = object(snapshotJson(input), [...fields, 'landmarks']);
  const landmarks = Array.isArray(data.landmarks) && data.landmarks.length === 0 ? [] : points(data.landmarks, 33, true);
  return snapshotJson({ ...common(data), landmarks }) as unknown as Readonly<PoseObservation>;
}
/** confidence is the adapter's handedness category score, never per-point visibility or certified accuracy. */
export function parseHandObservation(input: unknown): Readonly<HandObservation> {
  const data = object(snapshotJson(input), [...fields, 'hand', 'frameAspect']);
  let hand = null;
  if (data.hand !== null) {
    const value = object(data.hand, ['landmarks', 'handedness', 'confidence']);
    if (!['left', 'right', 'unknown'].includes(value.handedness as string)) fail('vision-handedness');
    hand = { landmarks: points(value.landmarks, 21, false), handedness: value.handedness, confidence: number(value.confidence, 0, 1) };
  }
  return snapshotJson({ ...common(data), hand, frameAspect: number(data.frameAspect, .01, 100) }) as unknown as Readonly<HandObservation>;
}

function projectedPoints(image: unknown, metric: unknown, pose: boolean, score = 0): (PoseLandmark | HandLandmark)[] {
  const count = pose ? 33 : 21;
  if (!Array.isArray(image) || image.length !== count || !Array.isArray(metric) || (metric.length !== 0 && metric.length !== count)) fail('vision-landmark-count');
  const projected = image.map((point, index) => {
    const value = object(point, ['x', 'y', 'z'], ['visibility']);
    if (Object.hasOwn(value, 'visibility')) number(value.visibility, 0, 1);
    const world = metric[index] === undefined ? undefined : object(metric[index], ['x', 'y', 'z'], ['visibility']);
    if (world && Object.hasOwn(world, 'visibility')) number(world.visibility, 0, 1);
    return { x: value.x, y: value.y, z: value.z, visibility: pose ? value.visibility ?? 0 : score,
      ...(world ? { world: { x: world.x, y: world.y, z: world.z } } : {}) };
  });
  return points(projected, count, pose);
}
/** Bounded projection of the consumed MediaPipe result fields, shared with the actual camera backend. */
export function projectPoseLandmarkerResult(input: unknown): PoseLandmark[][] {
  const data = object(snapshotJson(input), ['landmarks', 'worldLandmarks']);
  if (!Array.isArray(data.landmarks) || data.landmarks.length > 4 || !Array.isArray(data.worldLandmarks) ||
      data.worldLandmarks.length !== 0 && data.worldLandmarks.length !== data.landmarks.length) fail('vision-subject-count');
  return snapshotJson(data.landmarks.map((image, index) => projectedPoints(image,
    (data.worldLandmarks as unknown[])[index] ?? [], true))) as unknown as PoseLandmark[][];
}
/** Hand visibility mirrors the existing adapter's category score; it is not per-point visibility evidence. */
export function projectHandLandmarkerResult(input: unknown): TrackedHand[] {
  const data = object(snapshotJson(input), ['landmarks', 'worldLandmarks', 'handedness']);
  if (!Array.isArray(data.landmarks) || data.landmarks.length > 2 || !Array.isArray(data.worldLandmarks) ||
      data.worldLandmarks.length !== 0 && data.worldLandmarks.length !== data.landmarks.length ||
      !Array.isArray(data.handedness) || data.handedness.length > data.landmarks.length) fail('vision-subject-count');
  const categories = data.handedness.map(list => {
    if (!Array.isArray(list) || list.length > 2) fail('vision-category-count');
    return list.map(item => {
      const category = object(item, ['categoryName', 'score'], ['index', 'displayName']);
      if (typeof category.categoryName !== 'string' || category.categoryName.length > 128 ||
          category.displayName !== undefined && (typeof category.displayName !== 'string' || category.displayName.length > 128)) fail('vision-category');
      if (Object.hasOwn(category, 'index')) integer(category.index, -1, 1000);
      return { label: category.categoryName.toLowerCase(), score: number(category.score, 0, 1) };
    });
  });
  return snapshotJson(data.landmarks.map((image, index) => {
    const category = categories[index]?.[0];
    return { handedness: category?.label === 'left' || category?.label === 'right' ? category.label : 'unknown',
      confidence: category?.score ?? 0, landmarks: projectedPoints(image,
        (data.worldLandmarks as unknown[])[index] ?? [], false, category?.score ?? 0) };
  })) as unknown as TrackedHand[];
}
function options(input: unknown, pose: boolean) {
  const data = object(snapshotJson(input), ['id', 'version', 'configurationRevision', 'maxGapMs', 'maxWindowMs', 'maxFrames'], ['classifier']);
  const identity = parseObservationTiming({ capture: { clockId: 'options', at: 0 }, receipt: { clockId: 'options', at: 0 },
    mapping: null, processors: [{ id: data.id, version: data.version, configurationRevision: data.configurationRevision,
      processed: { clockId: 'options', at: 0 } }] }).processors[0]!;
  const classifier = data.classifier === undefined ? {} : object(data.classifier, [], pose ?
    ['autoCalibrationFrames', 'smoothing', 'visibilityThreshold', 'gestureCooldownMs'] :
    ['smoothing', 'stableFrames', 'gestureCooldownMs', 'historyMs']);
  const maxFrames = integer(data.maxFrames, 1, 128), maxWindowMs = number(data.maxWindowMs, 1, 60000);
  const maxGapMs = number(data.maxGapMs, 1, 60000);
  const smoothing = number(classifier.smoothing ?? (pose ? .38 : .45), Number.EPSILON, 1);
  const gestureCooldownMs = number(classifier.gestureCooldownMs ?? (pose ? 340 : 420), pose ? 0 : 80, 60000);
  const poseOptions: Required<PoseClassifierOptions> | undefined = pose ? { smoothing, gestureCooldownMs,
    autoCalibrationFrames: integer(classifier.autoCalibrationFrames ?? 12, 1, Math.min(120, maxFrames)),
    visibilityThreshold: number(classifier.visibilityThreshold ?? .45, 0, 1) } : undefined;
  const handOptions: Required<HandGestureClassifierOptions> | undefined = pose ? undefined : { smoothing, gestureCooldownMs,
    stableFrames: integer(classifier.stableFrames ?? 3, 1, Math.min(120, maxFrames)),
    historyMs: number(classifier.historyMs ?? 1250, 420, maxWindowMs) };
  // Only the selected classifier's options are relevant (small pose windows need no hand history).
  return { identity: { id: identity.id, version: identity.version, configurationRevision: identity.configurationRevision },
    maxFrames, maxWindowMs, maxGapMs, poseOptions, handOptions };
}
function history(config: ReturnType<typeof options>, clearClassifier: () => void) {
  let key: string | undefined, first: ClockStamp | undefined, last: number | undefined, count = 0;
  function reset() { key = undefined; first = undefined; last = undefined; count = 0; clearClassifier(); }
  function consume(input: VisionObservation, processed: unknown, aspect?: number): ObservationTiming {
    const capture = input.timing.capture;
    if (capture.clockId !== input.timing.receipt.clockId || input.timing.mapping !== null) fail('vision-clock');
    const nextKey = JSON.stringify([input.subjectId, input.frameId, input.model, capture.clockId, aspect,
      input.timing.processors.map(step => [step.id, step.version, step.configurationRevision])]);
    if (key !== nextKey) reset();
    if (last !== undefined && capture.at <= last) fail('vision-order');
    if (last !== undefined && (capture.at - last > config.maxGapMs || capture.at - first!.at > config.maxWindowMs || count >= config.maxFrames)) reset();
    const oldest = first ?? capture;
    const timing = parseObservationTiming({ ...input.timing, capture: oldest,
      processors: [...input.timing.processors, { ...config.identity, processed }] });
    first = oldest; last = capture.at; key = nextKey; count++;
    return timing;
  }
  return { reset, consume };
}
function result<T>(input: VisionObservation, signals: T, timing: ObservationTiming,
  status: LandmarkProcessorResult<T>['status']): LandmarkProcessorResult<T> {
  return snapshotJson({ subjectId: input.subjectId, frameId: input.frameId, model: input.model, status, signals, timing }) as unknown as LandmarkProcessorResult<T>;
}
function poseUsable(input: PoseObservation, threshold: number): boolean {
  return input.quality === 'valid' && input.landmarks.length === 33 &&
    [11, 12, 23, 24].reduce((sum, index) => sum + input.landmarks[index]!.visibility, 0) / 4 >= threshold;
}
export function createPoseLandmarkProcessor(inputOptions: PoseLandmarkProcessorOptions): PoseLandmarkProcessor {
  const config = options(inputOptions, true), classifier = new PoseClassifier(config.poseOptions!);
  const state = history(config, () => classifier.reset());
  return Object.freeze({
    process(input: unknown, processed: unknown) {
      try {
        const observation = parsePoseObservation(input);
        if (!poseUsable(observation, config.poseOptions!.visibilityThreshold)) {
          state.reset();
          const timing = state.consume(observation, processed);
          const output = result(observation, classifier.process([], observation.timing.capture.at), timing, 'unavailable');
          state.reset(); return output;
        }
        const timing = state.consume(observation, processed);
        const signals = classifier.process(observation.landmarks, observation.timing.capture.at);
        return result(observation, signals, timing, signals.calibrated ? 'valid' : 'calibrating');
      } catch (error) { state.reset(); throw error; }
    },
    calibrateNeutral(input: unknown): boolean {
      try {
        const observation = parsePoseObservation(input); state.reset();
        if (!poseUsable(observation, config.poseOptions!.visibilityThreshold)) return false;
        state.consume(observation, observation.timing.receipt);
        return classifier.calibrateNeutral(observation.landmarks);
      } catch (error) { state.reset(); throw error; }
    },
    reset: state.reset,
  });
}
export function createHandLandmarkProcessor(inputOptions: HandLandmarkProcessorOptions): HandLandmarkProcessor {
  const config = options(inputOptions, false), classifier = new HandGestureClassifier(config.handOptions!);
  const state = history(config, () => classifier.reset());
  return Object.freeze({
    process(input: unknown, processed: unknown) {
      try {
        const observation = parseHandObservation(input);
        if (observation.quality !== 'valid' || !observation.hand || observation.hand.confidence === 0) {
          state.reset(); const timing = state.consume(observation, processed, observation.frameAspect);
          const output = result(observation, classifier.process([], observation.timing.capture.at), timing, 'unavailable');
          state.reset(); return output;
        }
        const timing = state.consume(observation, processed, observation.frameAspect);
        return result(observation, classifier.process([observation.hand], observation.timing.capture.at, observation.frameAspect), timing, 'valid');
      } catch (error) { state.reset(); throw error; }
    },
    reset: state.reset,
  });
}
