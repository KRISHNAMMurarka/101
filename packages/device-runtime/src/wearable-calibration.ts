import { WATCH_COMPANION_REPORT_PROFILE, conjugateQuaternion, createSpatialPoseConverter,
  multiplyQuaternions, normalizeQuaternion, parseDeviceDescriptor, parseSignalValue, parseValueSchema,
  relativeQuaternion, snapshotJson, watchCompanionReportDevice } from '@101/device-model';
import type { DeviceDescriptor, JsonObject, Quaternion, SpatialFrame, SpatialPoseConverter, Vector3,
  WatchCompanionReport } from '@101/device-model';
import type { DeliveryContext, Observation, ResourceReference } from './types.ts';

export const WEARABLE_CALIBRATION_PROFILE = 'reviewed-wearable-projection/1';
export const WEARABLE_CALIBRATION_LIMITS = Object.freeze({ configurationAttempts: 32, activeHandles: 1,
  ownerMs: 30000, maxAgeMs: 250, maxHz: 30, inputBytes: 4096, outputBytes: 4096, sourceFloors: 32, profileFloors: 32,
  quaternionNormTolerance: 0.001, maxAbsAccelerationG: 32, maxAbsAngularDegPerSecond: 2000 });
/** Explicit host-reviewed reported semantics. This is neither authentication nor sensor qualification. */
export interface WearableReviewedProfile {
  readonly id: string; readonly version: string; readonly sha256: string; readonly revision: number;
  readonly reportProfile: typeof WATCH_COMPANION_REPORT_PROFILE;
  readonly orientationConvention: 'xyzw-device-to-reference'; readonly accelerationKind: 'reported-linear';
  readonly sourceFrame: SpatialFrame; readonly referenceFrame: string;
}
export interface WearableCalibrationConfiguration {
  readonly profile: WearableReviewedProfile;
  readonly calibration: Readonly<{ revision: number; hand: 'left' | 'right'; mounting: Quaternion;
    neutral: Quaternion; targetFrame: SpatialFrame }>;
  /** descriptorRevision is a host authorization-reference declaration; Observation cannot independently prove it. */
  readonly source: ResourceReference; readonly signal: AbortSignal; readonly expiresAt: number;
}
/** Runtime identity is held privately; copying the public generation does not issue a handle. */
export interface WearableCalibrationHandle { readonly generation: number }
export interface WearableFusionInput {
  readonly value: Readonly<{ orientation: Readonly<{ x: number; y: number; z: number; w: number }>;
    accelerationG: Readonly<{ x: number; y: number; z: number }>;
    rotationDegPerSecond: Readonly<{ x: number; y: number; z: number }>;
    profileRevision: number; calibrationRevision: number; generation: number; hand: 'left' | 'right';
    captureTimeKnown: false; physicalValidity: 'unspecified' }>;
  readonly timestamp: number; readonly clockDomain: string; readonly provenance: JsonObject;
}
export type WearableCalibrationResult<T = undefined> = Readonly<{ ok: true; value: T }> |
  Readonly<{ ok: false; reason: 'busy' | 'closed' | 'capacity' | 'invalid' | 'unsupported' | 'retired' | 'stale' | 'wrong-source' | 'replay' }>;
/** Conservative per-delivery snapshot of the actual compute route's limits.
 * The trusted host supplies it; it never issues or authenticates a route grant.
 */
export interface WearableCalibrationDeliveryScope {
  readonly routeId: string; readonly expiresAt: number; readonly maxAgeMs: number;
}
export interface WearableCalibrationOptions { readonly clockDomain: string; readonly now: () => number }
export interface WearableCalibrationProcessor {
  configure(configuration: WearableCalibrationConfiguration): WearableCalibrationResult<WearableCalibrationHandle>;
  process(handle: WearableCalibrationHandle, observation: Observation, context: DeliveryContext, delivery: WearableCalibrationDeliveryScope): WearableCalibrationResult<WearableFusionInput>;
  isCurrent(handle: WearableCalibrationHandle): boolean; reset(): void; close(): void;
}
type Calibration = WearableCalibrationConfiguration['calibration'];
interface Entry { readonly handle: WearableCalibrationHandle; readonly profile: WearableReviewedProfile;
  readonly calibration: Calibration; readonly source: ResourceReference; readonly sourceKey: string;
  readonly signal: AbortSignal; readonly expiresAt: number; readonly converter: SpatialPoseConverter }
interface Floor { readonly sourceKey: string; readonly timestamp: number; readonly sequence: number; readonly emission: number }
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const LIMITS = WEARABLE_CALIBRATION_LIMITS;
function aborted(signal: unknown): boolean { try { return nativeAborted.call(signal) !== false; } catch { return true; } }
function data(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object') throw Error('wearable-data');
  const property = Object.getOwnPropertyDescriptor(input, key);
  if (!property || !('value' in property)) throw Error('wearable-data');
  return property.value;
}
function fields(input: unknown, keys: readonly string[]): void {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== keys.length) throw Error('wearable-fields');
  for (const key of keys) data(input, key);
}
function bounded(input: unknown): unknown {
  const copy = snapshotJson(input);
  if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > LIMITS.inputBytes) throw Error('wearable-bytes');
  return copy;
}
function token(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(input)) throw Error('wearable-token');
  return input;
}
function revision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > 2147483647) throw Error('wearable-revision');
  return input;
}
function quaternion(input: unknown): Quaternion {
  if (!Array.isArray(input) || input.length !== 4 || input.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1) ||
    Math.abs(Math.hypot(...input) - 1) > LIMITS.quaternionNormTolerance) throw Error('wearable-quaternion');
  return Object.freeze(normalizeQuaternion(input as unknown as Quaternion));
}
function frame(input: unknown): SpatialFrame {
  const parsed = parseValueSchema({ type: 'quaternion', frame: input });
  if (parsed.type !== 'quaternion' || parsed.frame.unit !== 'm') throw Error('wearable-frame');
  return parsed.frame;
}
function profile(input: unknown): WearableReviewedProfile {
  const value = bounded(input);
  fields(value, ['id', 'version', 'sha256', 'revision', 'reportProfile', 'orientationConvention', 'accelerationKind', 'sourceFrame', 'referenceFrame']);
  if (data(value, 'reportProfile') !== WATCH_COMPANION_REPORT_PROFILE || data(value, 'orientationConvention') !== 'xyzw-device-to-reference' ||
    data(value, 'accelerationKind') !== 'reported-linear') throw Error('wearable-unsupported');
  const version = data(value, 'version'), sha256 = data(value, 'sha256');
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) || version.length > 64 ||
    typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw Error('wearable-profile');
  const sourceFrame = frame(data(value, 'sourceFrame')), referenceFrame = token(data(value, 'referenceFrame'));
  if (referenceFrame !== sourceFrame.origin) throw Error('wearable-frame');
  return Object.freeze({ id: token(data(value, 'id')), version, sha256, revision: revision(data(value, 'revision')),
    reportProfile: WATCH_COMPANION_REPORT_PROFILE, orientationConvention: 'xyzw-device-to-reference', accelerationKind: 'reported-linear',
    sourceFrame, referenceFrame });
}
function calibration(input: unknown): Calibration {
  const value = bounded(input); fields(value, ['revision', 'hand', 'mounting', 'neutral', 'targetFrame']);
  const hand = data(value, 'hand'); if (hand !== 'left' && hand !== 'right') throw Error('wearable-hand');
  return Object.freeze({ revision: revision(data(value, 'revision')), hand, mounting: quaternion(data(value, 'mounting')),
    neutral: quaternion(data(value, 'neutral')), targetFrame: frame(data(value, 'targetFrame')) });
}
function reference(input: unknown): ResourceReference {
  const value = bounded(input); fields(value, ['registrationId', 'deviceId', 'capabilityId', 'descriptorRevision', 'schemaVersion']);
  return Object.freeze({ registrationId: token(data(value, 'registrationId')), deviceId: token(data(value, 'deviceId')),
    capabilityId: token(data(value, 'capabilityId')), descriptorRevision: revision(data(value, 'descriptorRevision')),
    schemaVersion: revision(data(value, 'schemaVersion')) });
}
function triple(input: readonly number[]): Vector3 {
  if (input.length !== 3 || input.some(value => !Number.isFinite(value))) throw Error('wearable-vector');
  return input as Vector3;
}
function rotate(vector: Vector3, mounting: Quaternion): Vector3 {
  const q = multiplyQuaternions(multiplyQuaternions(conjugateQuaternion(mounting), [vector[0], vector[1], vector[2], 0]), mounting);
  return [q[0], q[1], q[2]];
}
function point(input: readonly number[]): Readonly<{ x: number; y: number; z: number }> {
  const clean = (value: number) => value === 0 ? 0 : value;
  return Object.freeze({ x: clean(input[0]!), y: clean(input[1]!), z: clean(input[2]!) });
}

/** Declares a reported projection, not a physically valid measurement or capture-time clock. */
export function wearableFusionInputDevice(id: string, targetFrame: SpatialFrame, descriptorRevision = 1): Readonly<DeviceDescriptor> {
  const outputFrame = frame(targetFrame), scalar = (max: number) => ({ type: 'scalar' as const, unit: '1', min: 1, max });
  return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Declared wearable projection', revision: revision(descriptorRevision),
    adapter: { id: 'wearable:reported-projection', version: '1.0.0' }, runtime: { platform: 'local-compute' },
    capabilities: [{ id: 'reported-motion', semantic: 'wearable:reported-fusion-input/1', schemaVersion: 2, kind: 'sample',
      permissions: ['subscribe'], delivery: { mode: 'latest', maxAgeMs: LIMITS.maxAgeMs, maxHz: LIMITS.maxHz }, value: { type: 'record', fields: {
        orientation: { type: 'quaternion', frame: outputFrame },
        accelerationG: { type: 'vector', components: ['x', 'y', 'z'], frame: outputFrame.id, unit: 'g', min: -56, max: 56 },
        rotationDegPerSecond: { type: 'vector', components: ['x', 'y', 'z'], frame: outputFrame.id, unit: 'deg/s', min: -3500, max: 3500 },
        profileRevision: scalar(2147483647), calibrationRevision: scalar(2147483647), generation: scalar(32),
        hand: { type: 'enum', values: ['left', 'right'] }, captureTimeKnown: { type: 'boolean' },
        physicalValidity: { type: 'enum', values: ['unspecified'] },
      } } }], metadata: { profile: WEARABLE_CALIBRATION_PROFILE, captureTimeKnown: false, physicalValidity: 'unspecified',
        authority: 'Host-reviewed reported semantics; no sensor presence or physical accuracy is inferred.' } });
}

/** Local compute consent and trusted currentness closures do not authenticate a source or issue route permission. */
export function createWearableCalibrationProcessor(options: WearableCalibrationOptions): WearableCalibrationProcessor {
  const clockDomain = token(data(options, 'clockDomain')), now = data(options, 'now');
  if (typeof now !== 'function') throw Error('wearable-options');
  const clock = now; // Keep the validated callback narrowing inside time().
  const handles = new WeakMap<object, Entry>();
  let active: Entry | undefined, closed = false, busy = false, attempts = 0, generation = 0, epoch = 0, lastNow = -1, lastOutputAt = -Infinity;
  const floors = new Map<string, Floor>();
  const profiles = new Map<string, Readonly<{ profile: WearableReviewedProfile; calibrationRevision: number }>>();
  const yes = <T>(value: T): WearableCalibrationResult<T> => Object.freeze({ ok: true, value });
  const no = (reason: Extract<WearableCalibrationResult, { ok: false }>['reason']): WearableCalibrationResult<never> => Object.freeze({ ok: false, reason });
  function retire(): void { active = undefined; epoch++; }
  function time(): number {
    let value: unknown; try { value = clock(); } catch { retire(); throw Error('wearable-clock'); }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || value < lastNow) {
      retire(); throw Error('wearable-clock');
    }
    lastNow = value; return value;
  }
  function intrinsic(entry: Entry): boolean { return !closed && active === entry && !aborted(entry.signal); }
  function lookup(handle: unknown): Entry | undefined { return handle !== null && typeof handle === 'object' ? handles.get(handle) : undefined; }
  function live(entry: Entry, at: number): boolean { return intrinsic(entry) && at < entry.expiresAt; }
  return Object.freeze({
    configure(input: WearableCalibrationConfiguration): WearableCalibrationResult<WearableCalibrationHandle> {
      if (closed) return no('closed'); if (busy) return no('busy'); if (attempts >= LIMITS.configurationAttempts) return no('capacity');
      // Reserve before descriptor/proxy traps, model parsing, and the trusted clock.
      busy = true; attempts++; const admittedEpoch = epoch;
      try {
        fields(input, ['profile', 'calibration', 'source', 'signal', 'expiresAt']);
        const declared = profile(data(input, 'profile')), calibrated = calibration(data(input, 'calibration'));
        const source = reference(data(input, 'source')), signal = data(input, 'signal'), expiresAt = data(input, 'expiresAt');
        if (aborted(signal) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return no('invalid');
        if (source.schemaVersion !== 1) return no('unsupported');
        if (declared.sourceFrame.origin !== calibrated.targetFrame.origin) return no('unsupported');
        // Only these three identifiers are observable at the actual delivery boundary.
        // A declared descriptor revision cannot mint a new replay epoch for the same registration.
        const sourceKey = JSON.stringify([source.registrationId, source.deviceId, source.capabilityId]);
        const prior = profiles.get(declared.id);
        if (prior) {
          if (declared.revision < prior.profile.revision) return no('invalid');
          if (declared.revision === prior.profile.revision && JSON.stringify(declared) !== JSON.stringify(prior.profile)) return no('invalid');
          if (calibrated.revision <= prior.calibrationRevision) return no('invalid');
        }
        const converter = createSpatialPoseConverter({ type: 'pose', frame: declared.sourceFrame, extent: 1 },
          { type: 'pose', frame: calibrated.targetFrame, extent: 2 }, { decimalPlaces: 8, maxAbsoluteError: 1e-6 });
        const at = time();
        if (closed || epoch !== admittedEpoch || aborted(signal)) return no('retired');
        if (expiresAt <= at || expiresAt > at + LIMITS.ownerMs) return no('invalid');
        const handle = Object.freeze({ generation: ++generation });
        const entry: Entry = Object.freeze({ handle, profile: declared, calibration: calibrated, source, sourceKey,
          signal: signal as AbortSignal, expiresAt, converter });
        handles.set(handle, entry); active = entry; epoch++;
        profiles.set(declared.id, Object.freeze({ profile: declared, calibrationRevision: calibrated.revision }));
        // At most32 accepted configurations can introduce32 distinct registrations/profiles.
        // A→B→A cannot erase A's floor. Reset and mounting changes preserve all retained floors.
        return yes(handle);
      } catch (error) { return no(error instanceof Error && error.message === 'wearable-unsupported' ? 'unsupported' : 'invalid'); }
      finally { busy = false; }
    },
    process(handle: WearableCalibrationHandle, input: Observation, context: DeliveryContext, delivery: WearableCalibrationDeliveryScope): WearableCalibrationResult<WearableFusionInput> {
      if (closed) return no('closed'); if (busy) return no('busy'); busy = true;
      try {
        const entry = lookup(handle); if (!entry || !intrinsic(entry)) return no('retired');
        const current = data(context, 'isCurrent'), signal = data(context, 'signal');
        if (typeof current !== 'function' || aborted(signal)) return no('retired');
        const routeScope = bounded(delivery);
        fields(routeScope, ['routeId', 'expiresAt', 'maxAgeMs']);
        const routeId = token(data(routeScope, 'routeId')), routeExpiry = data(routeScope, 'expiresAt'), routeAge = data(routeScope, 'maxAgeMs');
        if (routeId !== data(context, 'routeId') || typeof routeExpiry !== 'number' || !Number.isFinite(routeExpiry) ||
          routeExpiry < 0 || routeExpiry > Number.MAX_SAFE_INTEGER || typeof routeAge !== 'number' || !Number.isFinite(routeAge) ||
          routeAge < 1 || routeAge > 60000) return no('invalid');
        const observed = bounded(input) as Observation;
        const source = observed.source;
        if (!source || source.registrationId !== entry.source.registrationId || source.deviceId !== entry.source.deviceId ||
          source.capabilityId !== entry.source.capabilityId) return no('wrong-source');
        if (observed.clockDomain !== clockDomain || observed.quality !== 'valid' || typeof observed.timestamp !== 'number' ||
          !Number.isFinite(observed.timestamp) || observed.timestamp < 0) return no('invalid');
        const rawSchema = watchCompanionReportDevice('watch:grammar-only', 'watchos').capabilities[0]!.value;
        const report = parseSignalValue(observed.value, rawSchema) as unknown as WatchCompanionReport;
        if (!Number.isInteger(report.sequence) || !Number.isInteger(report.relayEmissionMs)) return no('invalid');
        const orientation = quaternion(report.orientationReported);
        if (report.accelerationG.some(v => Math.abs(v) > LIMITS.maxAbsAccelerationG) ||
          report.rotationDegPerSecond.some(v => Math.abs(v) > LIMITS.maxAbsAngularDegPerSecond)) return no('invalid');
        const floor = floors.get(entry.sourceKey);
        if (floor && (observed.timestamp <= floor.timestamp || report.relayEmissionMs < floor.emission ||
          (report.sequence - floor.sequence + 65536) % 65536 === 0 || (report.sequence - floor.sequence + 65536) % 65536 > 32767)) return no('replay');
        const mounted = normalizeQuaternion(multiplyQuaternions(orientation, entry.calibration.mounting));
        const relative = relativeQuaternion(mounted, entry.calibration.neutral);
        const pose = entry.converter.convert({ position: { x: 0, y: 0, z: 0 },
          orientation: { x: relative[0], y: relative[1], z: relative[2], w: relative[3] } }) as unknown as { orientation: WearableFusionInput['value']['orientation'] };
        const map = (vector: Vector3, axial: boolean): readonly number[] => entry.converter.metadata.axisMap.map(row =>
          row.reduce((sum, coefficient, i) => sum + coefficient * vector[i]!, 0) * (axial && entry.converter.metadata.mirrored ? -1 : 1));
        const value = Object.freeze({ orientation: Object.freeze(pose.orientation),
          accelerationG: point(map(rotate(triple(report.accelerationG), entry.calibration.mounting), false)),
          rotationDegPerSecond: point(map(rotate(triple(report.rotationDegPerSecond), entry.calibration.mounting), true)),
          profileRevision: entry.profile.revision, calibrationRevision: entry.calibration.revision, generation: entry.handle.generation,
          hand: entry.calibration.hand, captureTimeKnown: false as const, physicalValidity: 'unspecified' as const });
        const provenance = snapshotJson({ profile: WEARABLE_CALIBRATION_PROFILE, reviewedProfile: entry.profile.id,
          reviewedVersion: entry.profile.version, reviewedSha256: entry.profile.sha256, profileRevision: entry.profile.revision,
          calibrationRevision: entry.calibration.revision, generation: entry.handle.generation, hand: entry.calibration.hand,
          mounting: entry.calibration.mounting, neutral: entry.calibration.neutral, sourceFrame: entry.profile.sourceFrame,
          referenceFrame: entry.profile.referenceFrame, targetFrame: entry.calibration.targetFrame, mirrored: entry.converter.metadata.mirrored,
          deliveryScope: routeScope, sourceReference: entry.source, sourceReferenceMeaning: 'Host declaration; observation verifies registration/device/capability only.',
          relayEmissionMs: report.relayEmissionMs, reportSequence: report.sequence, observation: 'report-arrival',
          captureTimeKnown: false, physicalValidity: 'unspecified', processor: { id: 'wearable:reported-projection', version: '1.0.0',
            configurationRevision: entry.calibration.revision } }) as JsonObject;
        const output = Object.freeze({ value, timestamp: observed.timestamp, clockDomain, provenance });
        if (new TextEncoder().encode(JSON.stringify(output)).byteLength > LIMITS.outputBytes) return no('invalid');
        // Both callbacks are trusted host seams. Bound the checks to currentness→clock→
        // currentness: the processor clock can invalidate a narrower actual route grant.
        // The last clock is followed only by private/intrinsic checks and
        // conservative captured route limits. Either callout can advance time
        // without a fence loop or exact-clock equality that starves live clocks.
        if (current.call(context) !== true) return no('retired');
        time();
        if (current.call(context) !== true) return no('retired');
        const at = time();
        if (!live(entry, at) || aborted(signal) || at >= routeExpiry) return no('retired');
        if (at < observed.timestamp || at - observed.timestamp >= Math.min(LIMITS.maxAgeMs, routeAge)) return no('stale');
        if (at - lastOutputAt < 1000 / LIMITS.maxHz) return no('busy');
        lastOutputAt = at; floors.set(entry.sourceKey, Object.freeze({ sourceKey: entry.sourceKey, timestamp: observed.timestamp,
          sequence: report.sequence, emission: report.relayEmissionMs }));
        return yes(output);
      } catch { return no('invalid'); } finally { busy = false; }
    },
    isCurrent(handle: WearableCalibrationHandle): boolean {
      if (busy || closed) return false; busy = true;
      try { const entry = lookup(handle); if (!entry || !intrinsic(entry)) return false; return live(entry, time()); }
      catch { return false; } finally { busy = false; }
    },
    reset(): void { retire(); }, close(): void { if (!closed) { closed = true; retire(); floors.clear(); profiles.clear(); } },
  });
}
