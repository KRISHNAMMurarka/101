import { parseDeviceDescriptor, snapshotResourceBytes } from '@101/device-model';
import type { DeviceDescriptor } from '@101/device-model';
import type { DeviceRuntime, EndpointHandle, DeliveryContext, Observation } from '@101/device-runtime';

export const BROWSER_CAMERA_LIMITS = Object.freeze({ devices: 8, nativeInventory: 32, attempts: 64, rawPending: 1,
  captureMs: 30000, openMs: 5000, width: 8, height: 8, bytes: 256, nativeWidth: 1280, nativeHeight: 720,
  maxHz: 10, samples: 300, frameCallbacks: 600, latest: 1, listeners: 12, expiryTimers: 1, controlSinks: 1, controlRawPending: 1, controlAttempts: 32,
  controlMaxHz: 2, controlRecords: 16, controlWaitMs: 5000, controlTimers: 1, zoomMin: 0, zoomMax: 1024, reportedAxisMin: -1024, reportedAxisMax: 1024, zoomMinimumStep: 0.000001, zoomMaximumSteps: 1024 });
export interface BrowserCameraFrame { readonly format: 'rgba8'; readonly width: 8; readonly height: 8; readonly rows: readonly (readonly number[])[] }
export type BrowserCameraFailure = 'invalid' | 'unsupported' | 'unavailable' | 'denied' | 'busy' | 'closed' | 'lost' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'cancelled' | 'quota';
export type BrowserCameraResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: BrowserCameraFailure }>;
export interface BrowserCameraSelection { readonly browserCameraSelection?: never }
export interface BrowserCameraInventory { readonly ordinal: number; readonly selection: BrowserCameraSelection }
export interface BrowserCameraCaptureRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly selectionGeneration: number; readonly deviceId: string; readonly nativeDeviceId: string;
  readonly capabilityId: 'camera-frame'; readonly operation: 'subscribe';
}
export interface BrowserCameraCaptureGrant { readonly request: BrowserCameraCaptureRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface BrowserCameraActivation { readonly device: DeviceDescriptor; readonly source: EndpointHandle; readonly selectionGeneration: number }
/** Native API-reported numeric setting facts; no optical/angle/movement qualification.
 * The legacy ZoomFacts name is retained; the same finite snapshot shape serves pan/tilt. */
export interface BrowserCameraZoomFacts { readonly min: number; readonly max: number; readonly step: number; readonly current: number }
export interface BrowserCameraControlReport {
  readonly zoom: Readonly<{ state: 'reported' } & BrowserCameraZoomFacts> | Readonly<{ state: 'unsupported' }>;
  readonly focus: 'unsupported'; readonly exposure: 'unsupported';
  /** Unsupported retains the existing string; reported numeric units are opaque API settings, never angles. */
  readonly pan: 'unsupported' | Readonly<{ state: 'reported' } & BrowserCameraZoomFacts>;
  readonly tilt: 'unsupported' | Readonly<{ state: 'reported' } & BrowserCameraZoomFacts>; readonly opticalVerification: false;
}
export interface BrowserCameraControlRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly activation: BrowserCameraActivation; readonly selectionGeneration: number; readonly deviceId: string; readonly nativeDeviceId: string;
  readonly capabilityId: 'camera-zoom' | 'camera-pan' | 'camera-tilt'; readonly operation: 'invoke'; readonly facts: BrowserCameraZoomFacts; readonly captureExpiresAt: number;
}
export interface BrowserCameraControlGrant { readonly request: BrowserCameraControlRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface BrowserCameraControlActivation { readonly device: DeviceDescriptor; readonly sink: EndpointHandle; readonly selectionGeneration: number; readonly expiresAt: number }
/** Trusted caller snapshot of the exact real active Connection and its running
 * reliable operation. This is a separate numeric bound, never permission. */
export interface BrowserCameraControlDeliveryLimits {
  readonly context: DeliveryContext; readonly expiresAt: number; readonly maxAgeMs: number; readonly maxHz: number;
}
export interface BrowserCameraControlStatus {
  readonly state: 'idle' | 'bound' | 'issued' | 'api-returned' | 'rejected' | 'uncertain' | 'retired';
  readonly attempts: number; readonly activeSinks: number; readonly rawPending: number; readonly bindingPending: number;
  /** Last returned-API getSettings snapshot; never optical evidence or current after retirement. */
  readonly reportedSetting?: number; readonly records: readonly BrowserCameraControlStatus['state'][]; readonly expiryArmed: boolean;
}
/** Explicit cooperative factory; owned native canvas fixtures never qualify camera hardware.
 * Returned native objects must belong to the same declared realm and be exclusively owned. */
export interface BrowserCameraEnvironment {
  readonly fixtureKind: 'owned-canvas-fixture' | 'software-fixture';
  readonly enumerateDevices?: () => Promise<readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId'>[]>;
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createVideo?: () => HTMLVideoElement; readonly createCanvas?: () => HTMLCanvasElement;
  readonly MediaStream?: typeof MediaStream; readonly HTMLVideoElement?: typeof HTMLVideoElement;
  readonly HTMLCanvasElement?: typeof HTMLCanvasElement; readonly ImageData?: typeof ImageData;
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly mediaDevicesTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly hidden: () => boolean; readonly focused: () => boolean; readonly secureContext: () => boolean;
}
export interface BrowserCameraOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly now: () => number; readonly authorizeCapture: (request: BrowserCameraCaptureRequest) => BrowserCameraCaptureGrant | undefined;
  /** Synchronous explicit control review; omission denies all native mutations. */
  readonly authorizeControl?: (request: BrowserCameraControlRequest) => BrowserCameraControlGrant | undefined;
  /** Default deny. Match exact context.routeId to an owned real Connection; find
   * context.operationId in operations() with handlerResult running. expiresAt
   * must narrow both Connection.limits().expiresAt and that operation.deadline.
   * Options.now and runtime.now must share the same host clock. */
  readonly controlDeliveryLimits?: (context: DeliveryContext) => BrowserCameraControlDeliveryLimits | undefined;
  readonly environment?: BrowserCameraEnvironment;
}
export interface BrowserCameraProvider {
  inspect(): Promise<BrowserCameraResult<readonly BrowserCameraInventory[]>>;
  start(selection: BrowserCameraSelection, options: Readonly<{ purpose: string }>): Promise<BrowserCameraResult<BrowserCameraActivation>>;
  inspectControls(activation: BrowserCameraActivation): BrowserCameraResult<BrowserCameraControlReport>;
  bindZoom(activation: BrowserCameraActivation, options: Readonly<{ purpose: string }>): BrowserCameraResult<BrowserCameraControlActivation>;
  bindPan(activation: BrowserCameraActivation, options: Readonly<{ purpose: string }>): BrowserCameraResult<BrowserCameraControlActivation>;
  bindTilt(activation: BrowserCameraActivation, options: Readonly<{ purpose: string }>): BrowserCameraResult<BrowserCameraControlActivation>;
  controlStatus(): BrowserCameraControlStatus;
  stop(): void; sweep(): void; close(): Promise<void>;
  snapshot(): Readonly<{ phase: 'idle' | 'selected' | 'opening' | 'active' | 'closed'; reason: BrowserCameraFailure | 'idle' | 'selected' | 'active';
    attempts: number; selectionGeneration: number; activeSources: number; rawPending: number; framePending: number; cleanupFailures: number; listeners: number; samples: number; expiryArmed: boolean }>;
}
interface Choice { handle: BrowserCameraSelection; nativeId: string; generation: number; expiresAt: number; device: DeviceDescriptor }
interface FrameWork { token?: number; settled: boolean; unknown: boolean; resolve(): void }
interface Work {
  revision: number; deadline: number; cancelled: boolean; finished: boolean; rawDone: boolean; uncertainCleanup: boolean;
  resolve: (result: BrowserCameraResult<unknown>) => void; grant?: Readonly<{ signal: AbortSignal; expiresAt: number }>;
  choice?: Choice; stream?: MediaStream; tracks?: MediaStreamTrack[]; trackId?: string; video?: HTMLVideoElement; canvas?: HTMLCanvasElement; paint?: CanvasRenderingContext2D;
  source?: EndpointHandle; frame?: FrameWork; requestingFrame: boolean; firstPicture?: (present: boolean) => void;
  callbacks: number; samples: number; lastSample: number; lastMedia: number; sequence: number;
}
type ControlAxis = 'zoom' | 'pan' | 'tilt';
interface ControlBinding {
  work: Work; activation: BrowserCameraActivation; axis: ControlAxis; facts: BrowserCameraZoomFacts; signal: AbortSignal; expiresAt: number;
  sink?: EndpointHandle; retired: boolean; dispose?: () => void;
}
interface ControlOperation {
  binding: ControlBinding; contextSignal?: AbortSignal; issued: boolean; cancelled: boolean; unknown: boolean;
  finish(): void; settled(): void; remove?: () => void;
}
const promiseThen = Promise.prototype.then;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const signalAdd = EventTarget.prototype.addEventListener, signalRemove = EventTarget.prototype.removeEventListener;
const arrayBytes = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const arraySet = Uint8Array.prototype.set;
function isAborted(value: AbortSignal): boolean { return Reflect.apply(aborted, value, []) as boolean; }
function intrinsicSignal(value: unknown): value is AbortSignal { try { isAborted(value as AbortSignal); return true; } catch { return false; } }
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const result: Record<string, unknown> = Object.create(null), descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) { if (typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key]!)) return; result[key] = descriptors[key]!.value; }
    return result;
  } catch { return; }
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(value);
const no = (reason: BrowserCameraFailure): BrowserCameraResult<never> => Object.freeze({ ok: false, reason });
const yes = <T>(value: T): BrowserCameraResult<T> => Object.freeze({ ok: true, value });
function failure(error: unknown): BrowserCameraFailure {
  try { if (typeof DOMException !== 'undefined' && error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) return 'denied'; } catch { return 'unavailable'; }
  const copied = fields(error, ['ok', 'reason']); return copied?.ok === false ? copied.reason as BrowserCameraFailure : 'unavailable';
}
function descriptor(id: string): DeviceDescriptor {
  const fixed = (value: number) => ({ type: 'scalar' as const, unit: '1', min: value, max: value });
  return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Selected camera raster', revision: 1,
    adapter: { id: 'app:browser-camera', version: '1.0.0' }, runtime: { platform: 'browser-video-api' }, capabilities: [{
      id: 'camera-frame', semantic: 'media:camera-rgba8/1', schemaVersion: 1, kind: 'sample',
      value: { type: 'record', fields: { format: { type: 'enum', values: ['rgba8'] }, width: fixed(8), height: fixed(8),
        rows: { type: 'array', minItems: 8, maxItems: 8, items: { type: 'array', minItems: 32, maxItems: 32, items: { type: 'scalar', unit: '1', min: 0, max: 255, resolution: 1 } } } } },
      delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 }, permissions: ['subscribe'] }] });
}
function defaults(): Omit<BrowserCameraEnvironment, 'fixtureKind'> {
  const win = typeof window === 'undefined' ? undefined : window, doc = typeof document === 'undefined' ? undefined : document;
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  return { enumerateDevices: media?.enumerateDevices?.bind(media), getUserMedia: media?.getUserMedia?.bind(media),
    createVideo: doc ? () => doc.createElement('video') : undefined, createCanvas: doc ? () => doc.createElement('canvas') : undefined,
    MediaStream: typeof MediaStream === 'undefined' ? undefined : MediaStream, HTMLVideoElement: typeof HTMLVideoElement === 'undefined' ? undefined : HTMLVideoElement,
    HTMLCanvasElement: typeof HTMLCanvasElement === 'undefined' ? undefined : HTMLCanvasElement, ImageData: typeof ImageData === 'undefined' ? undefined : ImageData,
    target: win ?? new EventTarget(), document: doc ?? new EventTarget(), mediaDevicesTarget: media ?? new EventTarget(),
    hidden: () => doc?.hidden !== false, focused: () => doc?.hasFocus() === true, secureContext: () => globalThis.isSecureContext === true };
}
let controllers = 0;
/** Exact selected video input to scaled full-frame RGBA8; no default acquisition,
 * encoded media, physical freshness, calibration or clock mapping. The selected
 * zoom/pan/tilt endpoint represents a reported API setting only and requires independent control and invoke grants.
 * JS retrieval and native decoded media position are distinct. Source native buffers
 * remain opaque. Trusted factory/removal effects are not a host sandbox: an unreturned
 * native frame token or failed cleanup keeps a truthful reservation/failure. Pending
 * getUserMedia/play and owned callbacks remain tracked through actual settlement. */
export function createBrowserCameraProvider(input: BrowserCameraOptions): BrowserCameraProvider {
  const options = fields(input, ['runtime', 'ownerSignal', 'scope', 'now', 'authorizeCapture', 'authorizeControl', 'controlDeliveryLimits', 'environment']);
  const scope = options && fields(options.scope, ['principalId', 'applicationId', 'sessionId']);
  if (!options || !scope || Object.keys(scope).length !== 3 || !Object.values(scope).every(identifier) || !intrinsicSignal(options.ownerSignal) || typeof options.now !== 'function' || typeof options.authorizeCapture !== 'function') throw new TypeError('Invalid camera owner');
  if (options.controlDeliveryLimits !== undefined && typeof options.controlDeliveryLimits !== 'function') throw new TypeError('Invalid camera delivery bounds');
  if (options.authorizeControl !== undefined && typeof options.authorizeControl !== 'function') throw new TypeError('Invalid camera control reviewer');
  const runtime = options.runtime as DeviceRuntime, owner = options.ownerSignal, now = options.now as () => number, authorize = options.authorizeCapture as BrowserCameraOptions['authorizeCapture'];
  if (!runtime || !identifier(runtime.clockDomain) || ['registerSource', 'registerSink', 'setReadiness', 'unregister', 'publish'].some(key => typeof runtime[key as keyof DeviceRuntime] !== 'function')) throw new TypeError('Invalid camera runtime');
  const fixture = options.environment === undefined ? undefined : fields(options.environment, ['fixtureKind', 'enumerateDevices', 'getUserMedia', 'createVideo', 'createCanvas', 'MediaStream', 'HTMLVideoElement', 'HTMLCanvasElement', 'ImageData', 'target', 'document', 'mediaDevicesTarget', 'hidden', 'focused', 'secureContext']);
  if (options.environment !== undefined && (!fixture || !['owned-canvas-fixture', 'software-fixture'].includes(fixture.fixtureKind as string))) throw new TypeError('Explicit camera fixture kind required');
  const env = (fixture ?? defaults()) as BrowserCameraEnvironment;
  if (['hidden', 'focused', 'secureContext'].some(key => typeof env[key as keyof BrowserCameraEnvironment] !== 'function') || !env.target || !env.document || !env.mediaDevicesTarget) throw new TypeError('Invalid camera environment');
  const ownedScope = Object.freeze({ ...scope }), controller = ++controllers; if (!Number.isSafeInteger(controller)) throw new RangeError('Camera identity exhausted');
  const activations = new WeakMap<object, Work>();
  const handles = new WeakMap<object, Choice>(), removals: (() => void)[] = [], tasks = new Set<Promise<void>>();
  let closed = isAborted(owner), tearing = false, attempts = 0, generation = 0, revision = 0, lastAt = -1, cleanupFailures = 0;
  let choices: Choice[] = [], slot: Work | undefined, active: Work | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let controlBinding: ControlBinding | undefined, controlOperation: ControlOperation | undefined, bindingPending = false, controlQuarantine = false, controlAttempts = 0, lastControlAt = -Infinity;
  let controlTimer: ReturnType<typeof setTimeout> | undefined, controlState: BrowserCameraControlStatus['state'] = 'idle', reportedSetting: number | undefined;
  const controlRecords: BrowserCameraControlStatus['state'][] = [];
  let reason: BrowserCameraFailure | 'idle' | 'selected' | 'active' = closed ? 'closed' : 'idle';
  function usable(): boolean { return !closed && !tearing && !isAborted(owner); }
  function track(task: Promise<void>): void { tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {}); }
  function issue<T>(work: Work, native: () => T): T {
    try { return native(); } catch (error) { work.uncertainCleanup = true; cleanupFailures++; throw error; }
  }
  function finish(work: Work, result: BrowserCameraResult<unknown>): void { if (!work.finished) { work.finished = true; work.resolve(result); } }
  function release(work: Work): void { if (slot === work && work.rawDone && (!work.frame || work.frame.settled) && !work.uncertainCleanup) slot = undefined; }
  function settleFrame(work: Work, frame: FrameWork): void {
    if (!frame.settled) { frame.settled = true; frame.resolve(); }
    if (work.frame === frame) work.frame = undefined; release(work);
  }
  function cancelFrame(work: Work): void {
    const frame = work.frame; if (!frame || frame.settled) return;
    if (frame.token === undefined) return; // Still issuing, or an unknown effect without a returned token.
    try { work.video!.cancelVideoFrameCallback(frame.token); settleFrame(work, frame); }
    catch { frame.unknown = true; cleanupFailures++; }
  }
  function cleanup(work: Work): void {
    slot ??= work; cancelFrame(work); work.firstPicture?.(false); work.firstPicture = undefined;
    const tracks = work.tracks ?? (() => { try { return work.stream?.getTracks(); } catch { work.uncertainCleanup = true; cleanupFailures++; return; } })();
    if (tracks && tracks.length > 32) { work.uncertainCleanup = true; cleanupFailures++; }
    for (const native of (tracks ?? []).slice(0, 32)) { try { native.stop(); } catch { work.uncertainCleanup = true; cleanupFailures++; } }
    try { work.video?.pause(); if (work.video) { work.video.srcObject = null; work.video.remove(); } } catch { work.uncertainCleanup = true; cleanupFailures++; }
    try { if (work.canvas) { work.canvas.width = 1; work.canvas.height = 1; work.canvas.remove(); } } catch { work.uncertainCleanup = true; cleanupFailures++; }
    release(work);
  }
  function retire(why: BrowserCameraFailure): void {
    revision++; const old = active; active = undefined; retireControl(); choices = []; reason = why;
    const pending = slot; if (pending) { pending.cancelled = true; finish(pending, no(why)); }
    if (old) old.cancelled = true;
    if (tearing) return; tearing = true;
    try {
      if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined;
      for (const dispose of removals.splice(0)) { try { dispose(); } catch { cleanupFailures++; } }
      for (const work of new Set([old, pending])) if (work) {
        if (work.source) { const endpoint = work.source; work.source = undefined; try { runtime.unregister(endpoint); } catch { work.uncertainCleanup = true; cleanupFailures++; } }
        cleanup(work);
      }
    } finally { tearing = false; }
  }
  function time(): number {
    let at: number; try { at = now(); } catch { retire('invalid'); return NaN; }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 30000 || at < lastAt) { retire('invalid'); return NaN; } lastAt = at; return at;
  }
  function valid(work: Work): boolean {
    if (!usable() || work.cancelled || revision !== work.revision || slot !== work && active !== work || work.grant && isAborted(work.grant.signal)) return false;
    const at = time(); return usable() && revision === work.revision && !work.cancelled && (slot === work || active === work) && Number.isFinite(at) && at < work.deadline && (!work.grant || !isAborted(work.grant.signal) && at < work.grant.expiresAt);
  }
  function listen(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, type: string, callback: () => void, intrinsic = false): void {
    const turn = revision, guarded = () => { if (turn === revision && !closed) callback(); };
    const dispose = () => { if (intrinsic) Reflect.apply(signalRemove, target, [type, guarded]); else target.removeEventListener(type, guarded); }; removals.push(dispose);
    try { if (intrinsic) Reflect.apply(signalAdd, target, [type, guarded, { once: true }]); else target.addEventListener(type, guarded); }
    finally { if (turn !== revision || !usable()) dispose(); }
    if (turn !== revision || !usable()) throw no('cancelled');
  }
  function lifecycle(): void {
    if (removals.length) return;
    listen(owner, 'abort', () => { closed = true; retire('closed'); }, true);
    listen(env.target, 'blur', () => retire('unfocused')); listen(env.target, 'pagehide', () => retire('stopped'));
    listen(env.document, 'visibilitychange', () => { if (env.hidden()) retire('hidden'); });
    listen(env.mediaDevicesTarget, 'devicechange', () => retire('lost'));
  }
  function availability(): BrowserCameraFailure | undefined { if (!env.secureContext()) return 'denied'; if (env.hidden()) return 'hidden'; if (!env.focused()) return 'unfocused'; }
  function begin<T>(): { work: Work; result: Promise<BrowserCameraResult<T>> } | BrowserCameraResult<never> {
    if (!usable()) return no('closed'); if (slot || active || tearing || bindingPending || controlOperation || controlQuarantine) return no('busy'); if (attempts >= 64) return no('quota'); attempts++;
    let resolve!: Work['resolve']; const result = new Promise<BrowserCameraResult<T>>(yes => { resolve = value => yes(value as BrowserCameraResult<T>); });
    const work: Work = { revision, deadline: Infinity, cancelled: false, finished: false, rawDone: false, uncertainCleanup: false, requestingFrame: false,
      callbacks: 0, samples: 0, lastSample: -Infinity, lastMedia: -1, sequence: 0, resolve }; slot = work; return { work, result };
  }
  function done(work: Work): void { work.rawDone = true; release(work); }
  function arm(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined;
    if (!usable()) return; const turn = revision, at = time(); if (!usable() || revision !== turn) return;
    const deadline = active?.deadline ?? (slot && !slot.cancelled ? slot.deadline : undefined) ?? Math.min(...choices.map(choice => choice.expiresAt));
    if (Number.isFinite(deadline)) expiryTimer = setTimeout(() => { expiryTimer = undefined; if (turn === revision) sweep(); }, Math.max(1, deadline - at));
  }
  function sweep(): void { const turn = revision, at = time(); if (turn !== revision || !usable()) return;
    if (controlBinding && at >= controlBinding.expiresAt) retireControl();
    if (active && at >= active.deadline || slot && !slot.cancelled && at >= slot.deadline || choices.length && at >= choices[0]!.expiresAt) retire('expired'); else arm(); }
  function nativePicture(work: Work, metadata: VideoFrameCallbackMetadata): { mediaTime: number; presentedFrames: number; width: number; height: number } {
    const selected: Record<string, number> = {};
    for (const key of ['mediaTime', 'presentedFrames', 'width', 'height']) { const property = Object.getOwnPropertyDescriptor(metadata, key); if (!property || !('value' in property) || typeof property.value !== 'number' || !Number.isFinite(property.value)) throw no('unsupported'); selected[key] = property.value; }
    const video = work.video!, native = work.tracks![0]!, current = work.stream!.getTracks();
    if (!valid(work)) throw no('cancelled');
    if (!Array.isArray(current) || current.length !== 1 || current[0] !== native || video.srcObject !== work.stream || native.id !== work.trackId) throw no('lost');
    if (native.readyState !== 'live' || native.muted || video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1 || video.videoWidth > 1280 || video.videoHeight > 720 ||
        selected.width! < 1 || selected.width! > 1280 || selected.height! < 1 || selected.height! > 720 || selected.mediaTime! < 0 || selected.mediaTime! < work.lastMedia || selected.mediaTime! > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(selected.presentedFrames) || selected.presentedFrames! < 1) throw no('lost');
    const settings = native.getSettings(); if (!valid(work)) throw no('cancelled');
    if (!(env.fixtureKind === 'owned-canvas-fixture' && settings.deviceId === undefined) && settings.deviceId !== work.choice!.nativeId) throw no('lost');
    return { mediaTime: selected.mediaTime!, presentedFrames: selected.presentedFrames!, width: video.videoWidth, height: video.videoHeight };
  }
  function sample(work: Work, picture: ReturnType<typeof nativePicture>): void {
    if (!valid(work)) return; const at = time(); if (!valid(work) || at - work.lastSample < 100) return;
    if (work.samples >= 300) throw no('quota');
    work.paint!.drawImage(work.video!, 0, 0, 8, 8); if (!valid(work)) return;
    const image = work.paint!.getImageData(0, 0, 8, 8); if (!valid(work)) return;
    if (!(image instanceof env.ImageData!) || image.width !== 8 || image.height !== 8) throw no('unsupported');
    const data = image.data; if (!valid(work)) return;
    if (!(data instanceof Uint8ClampedArray) || Reflect.apply(arrayBytes, data, []) !== 256) throw no('unsupported');
    const bytes = new Uint8Array(256); Reflect.apply(arraySet, bytes, [data]); const copied = snapshotResourceBytes(bytes); bytes.fill(0); if (!valid(work)) return;
    const rows = Array.from({ length: 8 }, (_, row) => Object.freeze(Array.from(copied.subarray(row * 32, row * 32 + 32)))); copied.fill(0);
    const value: BrowserCameraFrame = Object.freeze({ format: 'rgba8', width: 8, height: 8, rows: Object.freeze(rows) });
    const observedAt = time(); if (!valid(work)) return; work.lastSample = observedAt; work.lastMedia = picture.mediaTime; work.samples++;
    const published = runtime.publish(work.source!, value, { timestamp: observedAt, clockDomain: runtime.clockDomain, sequence: ++work.sequence,
      provenance: { samplePoint: 'javascript-decoded-raster-retrieval', captureTimeKnown: false, clockMappingEstablished: false,
        mediaTimeSeconds: picture.mediaTime, presentedFrames: picture.presentedFrames, nativeWidthPx: picture.width, nativeHeightPx: picture.height,
        videoContextId: `camera-${controller}:video-${work.choice!.generation}`, selectionGeneration: work.choice!.generation,
        factoryKind: fixture ? env.fixtureKind : 'selected-browser-videoinput' } });
    if (!published.ok && valid(work)) throw no('unavailable');
  }
  function requestFrame(work: Work): void {
    if (!valid(work) || work.frame && !work.frame.settled) return;
    if (work.callbacks >= 600) { retire('quota'); return; } work.callbacks++;
    let resolve!: () => void; const pending = new Promise<void>(yes => { resolve = yes; });
    const frame: FrameWork = { settled: false, unknown: false, resolve }; work.frame = frame; track(pending); work.requestingFrame = true;
    try {
      const token = work.video!.requestVideoFrameCallback((_at, metadata) => {
        if (frame.settled || work.frame !== frame) return;
        try {
          if (work.requestingFrame) { retire('unsupported'); return; }
          if (!valid(work)) return;
          const picture = nativePicture(work, metadata); if (!valid(work)) return;
          if (work.firstPicture) { const ready = work.firstPicture; work.firstPicture = undefined; work.lastMedia = picture.mediaTime; ready(true); }
          else if (active === work) sample(work, picture);
        } catch (error) { if (active === work || slot === work) retire(failure(error)); }
        finally {
          if (!work.requestingFrame) { settleFrame(work, frame); if (active === work && valid(work)) requestFrame(work); }
        }
      });
      if (!Number.isSafeInteger(token) || token < 0) { frame.unknown = true; cleanupFailures++; retire('unsupported'); }
      else frame.token = token;
    } catch { frame.unknown = true; cleanupFailures++; retire('unavailable'); }
    finally { work.requestingFrame = false; if (!valid(work)) cancelFrame(work); }
  }
  function inspect(): Promise<BrowserCameraResult<readonly BrowserCameraInventory[]>> {
    const started = begin<readonly BrowserCameraInventory[]>(); if ('ok' in started) return Promise.resolve(started); const { work, result } = started;
    const run = (async () => {
      try {
        if (!env.enumerateDevices) throw no('unsupported'); const at = time(), unavailable = availability(); if (!usable() || revision !== work.revision) throw no('cancelled'); if (unavailable) throw no(unavailable);
        work.deadline = at + 5000; lifecycle(); if (!valid(work)) throw no('cancelled'); arm();
        const devices = await env.enumerateDevices(); if (!valid(work)) throw no('cancelled');
        if (!Array.isArray(devices) || devices.length > 32) throw no('unsupported'); const ids: string[] = [];
        for (const device of devices) { const kind = device.kind, id = device.deviceId; if (!valid(work)) throw no('cancelled');
          if (kind !== 'videoinput' || id === '' || id === 'default' || id === 'communications') continue;
          if (typeof id !== 'string' || id.length > 512 || ids.includes(id)) throw no('unsupported'); ids.push(id); if (ids.length > 8) throw no('unsupported'); }
        const after = time(); if (!valid(work)) throw no('cancelled'); generation++; choices = ids.map(id => {
          const handle = Object.freeze({}); const choice = { handle, nativeId: id, generation, expiresAt: after + 30000, device: descriptor(`browser-camera-${controller}:generation-${generation}`) }; handles.set(handle, choice); return choice; });
        reason = choices.length ? 'selected' : 'unavailable'; finish(work, yes(Object.freeze(choices.map((choice, ordinal) => Object.freeze({ ordinal, selection: choice.handle })))));
      } catch (error) { retire(failure(error)); finish(work, no(failure(error))); } finally { done(work); arm(); }
    })(); track(run); return result;
  }
  function start(handle: BrowserCameraSelection, raw: Readonly<{ purpose: string }>): Promise<BrowserCameraResult<BrowserCameraActivation>> {
    const started = begin<BrowserCameraActivation>(); if ('ok' in started) return Promise.resolve(started); const { work, result } = started;
    const run = (async () => {
      try {
        const selected = handle && typeof handle === 'object' ? handles.get(handle) : undefined, request = fields(raw, ['purpose']), at = time();
        if (!usable() || revision !== work.revision) throw no('cancelled'); if (!selected || !choices.includes(selected)) throw no('denied'); if (!request || Object.keys(request).length !== 1 || !identifier(request.purpose)) throw no('invalid');
        const unavailable = availability(); if (!usable() || revision !== work.revision) throw no('cancelled'); if (unavailable) throw no(unavailable);
        work.choice = selected; work.deadline = Math.min(at + 5000, selected.expiresAt); lifecycle();
        const captureRequest: BrowserCameraCaptureRequest = Object.freeze({ ...ownedScope as BrowserCameraOptions['scope'], purpose: request.purpose, selectionGeneration: selected.generation,
          deviceId: selected.device.id, nativeDeviceId: selected.nativeId, capabilityId: 'camera-frame', operation: 'subscribe' });
        const granted = fields(authorize(captureRequest), ['request', 'signal', 'expiresAt']), after = time(); if (!valid(work) || !choices.includes(selected)) throw no('cancelled');
        if (!granted || Object.keys(granted).length !== 3 || granted.request !== captureRequest || !intrinsicSignal(granted.signal) || isAborted(granted.signal) || typeof granted.expiresAt !== 'number' || !Number.isFinite(granted.expiresAt) || granted.expiresAt <= after || granted.expiresAt > after + 30000 || granted.expiresAt > selected.expiresAt) throw no('denied');
        work.grant = Object.freeze({ signal: granted.signal, expiresAt: granted.expiresAt }); work.deadline = Math.min(work.deadline, granted.expiresAt); listen(granted.signal, 'abort', () => retire('denied'), true); arm(); if (!valid(work)) throw no('cancelled');
        if (!env.getUserMedia || !env.createVideo || !env.createCanvas || !env.MediaStream || !env.HTMLVideoElement || !env.HTMLCanvasElement || !env.ImageData) throw no('unsupported');
        work.video = issue(work, () => env.createVideo!()); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (!(work.video instanceof env.HTMLVideoElement) || typeof work.video.requestVideoFrameCallback !== 'function' || typeof work.video.cancelVideoFrameCallback !== 'function') throw no('unsupported');
        work.canvas = issue(work, () => env.createCanvas!()); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (!(work.canvas instanceof env.HTMLCanvasElement)) throw no('unsupported');
        work.canvas.width = 8; if (!valid(work)) throw no('cancelled'); work.canvas.height = 8; if (!valid(work)) throw no('cancelled');
        work.paint = work.canvas.getContext('2d', { willReadFrequently: true }) ?? undefined; if (!valid(work)) throw no('cancelled'); if (!work.paint) throw no('unsupported');
        const constraints = Object.freeze({ video: Object.freeze({ deviceId: Object.freeze({ exact: selected.nativeId }), width: Object.freeze({ ideal: 640, max: 1280 }), height: Object.freeze({ ideal: 480, max: 720 }), frameRate: Object.freeze({ ideal: 10, max: 15 }) }), audio: false });
        work.stream = await issue(work, () => env.getUserMedia!(constraints)); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (!(work.stream instanceof env.MediaStream)) throw no('unsupported'); work.tracks = work.stream.getTracks(); if (!valid(work)) throw no('cancelled');
        if (work.tracks.length !== 1 || work.tracks[0]!.kind !== 'video' || work.tracks[0]!.readyState !== 'live' || work.tracks[0]!.muted) throw no('unsupported');
        work.trackId = work.tracks[0]!.id; if (!valid(work)) throw no('cancelled'); if (typeof work.trackId !== 'string' || work.trackId.length < 1 || work.trackId.length > 512) throw no('unsupported');
        const settings = work.tracks[0]!.getSettings(); if (!valid(work)) throw no('cancelled'); if (!(env.fixtureKind === 'owned-canvas-fixture' && settings.deviceId === undefined) && settings.deviceId !== selected.nativeId) throw no('lost');
        listen(work.tracks[0]!, 'ended', () => retire('lost')); listen(work.tracks[0]!, 'mute', () => retire('lost')); listen(work.video, 'error', () => retire('lost'));
        work.video.muted = true; if (!valid(work)) throw no('cancelled'); work.video.playsInline = true; if (!valid(work)) throw no('cancelled'); work.video.srcObject = work.stream; if (!valid(work)) throw no('cancelled');
        await issue(work, () => work.video!.play()); if (!valid(work)) throw no('cancelled');
        const picture = new Promise<boolean>(resolve => { work.firstPicture = resolve; }); requestFrame(work); if (!await picture || !valid(work)) throw no('cancelled');
        work.source = runtime.registerSource({ device: selected.device, capability: 'camera-frame' }); if (!valid(work)) throw no('cancelled');
        if (!runtime.setReadiness(work.source, 'available', granted.expiresAt).ok || !valid(work)) throw no('unavailable');
        active = work; work.deadline = granted.expiresAt; reason = 'active'; arm(); requestFrame(work); if (!valid(work)) throw no('cancelled');
        const activation = Object.freeze({ device: selected.device, source: work.source, selectionGeneration: selected.generation }); activations.set(activation, work);
        finish(work, yes(activation));
      } catch (error) {
        if (active === work || work.grant) retire(failure(error)); else { if (work.source) { runtime.unregister(work.source); work.source = undefined; } cleanup(work); }
        finish(work, no(work.cancelled ? reason as BrowserCameraFailure : failure(error)));
      } finally { done(work); arm(); }
    })(); track(run); return result;
  }
  function controlRecord(state: BrowserCameraControlStatus['state']): void {
    controlState = state; controlRecords.push(state); if (controlRecords.length > 16) controlRecords.shift();
  }
  function direct(work: Work, at: number, binding?: ControlBinding, signal?: AbortSignal): boolean {
    return usable() && active === work && !work.cancelled && revision === work.revision && !!work.grant && !isAborted(work.grant.signal) &&
      Number.isFinite(at) && at < work.deadline && at < work.grant.expiresAt && (!binding || controlBinding === binding && !binding.retired && !isAborted(binding.signal) && at < binding.expiresAt) &&
      (!signal || intrinsicSignal(signal) && !isAborted(signal));
  }
  function currentActivation(value: BrowserCameraActivation): Work | undefined {
    const work = value && typeof value === 'object' ? activations.get(value) : undefined;
    return work && direct(work, lastAt) ? work : undefined;
  }
  function reserveControlTask(): () => void {
    let resolve!: () => void; const task = new Promise<void>(yes => { resolve = yes; }); track(task); return resolve;
  }
  function aligned(value: number, facts: Pick<BrowserCameraZoomFacts, 'min' | 'max' | 'step'>): boolean {
    if (!Number.isFinite(value) || value < facts.min || value > facts.max) return false;
    const position = (value - facts.min) / facts.step;
    return Math.abs(position - Math.round(position)) <= Number.EPSILON * 8 * Math.max(1, Math.abs(position));
  }
  // Native WebIDL fields can live on prototypes. Each individual native getter is
  // followed by a private epoch/signal fence; caller options remain own-data only.
  function controlFacts(work: Work, axis: ControlAxis): BrowserCameraZoomFacts | undefined {
    const check = () => { if (!direct(work, lastAt)) throw no('cancelled'); };
    const native = work.tracks?.[0]; if (!native || !work.stream || !work.video || !work.choice) throw no('lost');
    const getTracks = work.stream.getTracks; check(); const tracks = Reflect.apply(getTracks, work.stream, []) as MediaStreamTrack[]; check();
    if (!Array.isArray(tracks) || tracks.length !== 1 || tracks[0] !== native) throw no('lost');
    const kind = native.kind; check(); const state = native.readyState; check(); const muted = native.muted; check(); const id = native.id; check();
    const source = work.video.srcObject; check(); if (kind !== 'video' || state !== 'live' || muted || id !== work.trackId || source !== work.stream) throw no('lost');
    const getSettings = native.getSettings; check(); if (typeof getSettings !== 'function') return;
    const settings = Reflect.apply(getSettings, native, []) as MediaTrackSettings & Partial<Record<ControlAxis, number>>; check();
    const deviceId = settings.deviceId; check(); if (!(env.fixtureKind === 'owned-canvas-fixture' && deviceId === undefined) && deviceId !== work.choice.nativeId) throw no('lost');
    const getCapabilities = native.getCapabilities; check(); if (typeof getCapabilities !== 'function') return;
    const capabilities = Reflect.apply(getCapabilities, native, []) as MediaTrackCapabilities & Partial<Record<ControlAxis, { min?: number; max?: number; step?: number }>>; check();
    const range = capabilities[axis]; check(); if (!range || typeof range !== 'object' || Array.isArray(range)) return;
    const min = range.min; check(); const max = range.max; check(); const step = range.step; check(); const current = settings[axis]; check();
    if (typeof min !== 'number' || typeof max !== 'number' || typeof step !== 'number' || typeof current !== 'number' ||
        ![min, max, step, current].every(Number.isFinite) || min < (axis === 'zoom' ? BROWSER_CAMERA_LIMITS.zoomMin : BROWSER_CAMERA_LIMITS.reportedAxisMin) || max > BROWSER_CAMERA_LIMITS.reportedAxisMax || min >= max || step < 0.000001 || step > max - min || Math.floor((max - min) / step) + 1 > 1024) return;
    const facts = Object.freeze({ min, max, step, current }); if (!aligned(current, facts)) return;
    return facts;
  }
  function sameRange(left: BrowserCameraZoomFacts, right: BrowserCameraZoomFacts): boolean { return left.min === right.min && left.max === right.max && left.step === right.step; }
  function controlDescriptor(work: Work, facts: BrowserCameraZoomFacts, axis: ControlAxis): DeviceDescriptor {
    return parseDeviceDescriptor({ schemaVersion: 1, id: work.choice!.device.id + ':' + axis, label: 'Selected camera API ' + axis + ' setting', revision: 1,
      adapter: { id: 'app:browser-camera', version: '1.0.0' }, runtime: { platform: 'browser-video-api' }, capabilities: [{
        id: 'camera-' + axis, semantic: 'media:camera-' + axis + '-setting/1', schemaVersion: 1, kind: 'command',
        value: { type: 'scalar', unit: '1', min: facts.min, max: facts.max, resolution: facts.step },
        delivery: { mode: 'reliable', maxAgeMs: 250 }, permissions: ['invoke'] }] });
  }
  function inspectControls(activation: BrowserCameraActivation): BrowserCameraResult<BrowserCameraControlReport> {
    if (!usable()) return no('closed'); if (bindingPending || controlOperation || controlQuarantine) return no('busy'); if (controlAttempts >= 32) return no('quota');
    bindingPending = true; controlAttempts++; const settled = reserveControlTask();
    try {
      const work = currentActivation(activation); if (!work) return no('denied');
      const facts = controlFacts(work, 'zoom'), pan = controlFacts(work, 'pan'), tilt = controlFacts(work, 'tilt'), at = time(); if (!direct(work, at)) return no('cancelled');
      return yes(Object.freeze({ zoom: facts ? Object.freeze({ state: 'reported' as const, ...facts }) : Object.freeze({ state: 'unsupported' as const }),
        focus: 'unsupported', exposure: 'unsupported', pan: pan ? Object.freeze({ state: 'reported' as const, ...pan }) : 'unsupported' as const,
        tilt: tilt ? Object.freeze({ state: 'reported' as const, ...tilt }) : 'unsupported' as const, opticalVerification: false }));
    } catch (error) { return no(failure(error)); } finally { bindingPending = false; settled(); }
  }
  function retireControl(): void {
    const binding = controlBinding; controlBinding = undefined;
    if (controlTimer !== undefined) clearTimeout(controlTimer); controlTimer = undefined;
    if (binding) {
      binding.retired = true; const sink = binding.sink; binding.sink = undefined;
      try { binding.dispose?.(); } catch { controlQuarantine = true; cleanupFailures++; } binding.dispose = undefined;
      if (sink) try { if (!runtime.unregister(sink).ok) { controlQuarantine = true; cleanupFailures++; } } catch { controlQuarantine = true; cleanupFailures++; }
    }
    const operation = controlOperation;
    if (operation) {
      operation.cancelled = true; operation.finish();
      if (operation.issued) { controlRecord('uncertain'); if (active === operation.binding.work) retire('cancelled'); }
      else if (controlState !== 'uncertain') controlRecord('retired');
    } else if (binding && controlState !== 'uncertain') controlRecord('retired');
  }
  function armControl(binding: ControlBinding, deadline: number, operation?: ControlOperation): void {
    if (controlTimer !== undefined) clearTimeout(controlTimer); controlTimer = undefined;
    const turn = revision; if (!direct(binding.work, lastAt, binding)) return;
    controlTimer = setTimeout(() => {
      controlTimer = undefined; if (turn !== revision || controlBinding !== binding) return;
      if (operation && controlOperation === operation) { retireControl(); return; }
      const after = time(); if (!direct(binding.work, after, binding)) retireControl();
    }, Math.max(1, deadline - lastAt));
  }
  function bindControl(activation: BrowserCameraActivation, raw: Readonly<{ purpose: string }>, axis: ControlAxis): BrowserCameraResult<BrowserCameraControlActivation> {
    if (!usable()) return no('closed'); if (bindingPending || controlOperation || controlQuarantine || controlBinding) return no('busy'); if (controlAttempts >= 32) return no('quota');
    bindingPending = true; controlAttempts++; const settled = reserveControlTask(); let binding: ControlBinding | undefined;
    try {
      const work = currentActivation(activation), request = fields(raw, ['purpose']);
      if (!work) throw no('denied'); if (!request || Object.keys(request).length !== 1 || !identifier(request.purpose)) throw no('invalid');
      const facts = controlFacts(work, axis), at = time(); if (!direct(work, at)) throw no('cancelled'); if (!facts) throw no('unsupported');
      if (typeof options!.authorizeControl !== 'function') throw no('denied');
      const review: BrowserCameraControlRequest = Object.freeze({ ...ownedScope as BrowserCameraOptions['scope'], activation, purpose: request.purpose,
        selectionGeneration: work.choice!.generation, deviceId: work.choice!.device.id, nativeDeviceId: work.choice!.nativeId,
        capabilityId: `camera-${axis}`, operation: 'invoke', facts, captureExpiresAt: work.grant!.expiresAt });
      const grant = fields((options!.authorizeControl as NonNullable<BrowserCameraOptions['authorizeControl']>)(review), ['request', 'signal', 'expiresAt']);
      const current = controlFacts(work, axis), after = time(); if (!direct(work, after)) throw no('cancelled');
      if (!current || !sameRange(current, facts) || current.current !== facts.current) throw no('unsupported');
      if (!grant || Object.keys(grant).length !== 3 || grant.request !== review || !intrinsicSignal(grant.signal) || isAborted(grant.signal) || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) ||
          grant.expiresAt <= after || grant.expiresAt > work.grant!.expiresAt || grant.expiresAt > after + 30000) throw no('denied');
      binding = { work, activation, axis, facts, signal: grant.signal, expiresAt: grant.expiresAt, retired: false }; controlBinding = binding;
      const selected = binding; const abort = () => { if (controlBinding === selected) retireControl(); };
      binding.dispose = () => Reflect.apply(signalRemove, selected.signal, ['abort', abort]);
      Reflect.apply(signalAdd, binding.signal, ['abort', abort, { once: true }]);
      const device = controlDescriptor(work, facts, axis); if (!direct(work, time(), binding)) throw no('cancelled');
      let endpoint: EndpointHandle;
      try { endpoint = runtime.registerSink({ device, capability: 'camera-' + axis, apply: (observation, context) => applyControl(selected, observation, context),
        release() { if (controlBinding === selected) retireControl(); } }); }
      catch { controlQuarantine = true; cleanupFailures++; throw no('unavailable'); }
      // The returned real endpoint remains owned even when its factory retired us.
      if (binding.retired || controlBinding !== binding) {
        try { if (!runtime.unregister(endpoint).ok) { controlQuarantine = true; cleanupFailures++; } }
        catch { controlQuarantine = true; cleanupFailures++; }
        throw no('cancelled');
      }
      binding.sink = endpoint;
      if (!direct(work, time(), binding) || !runtime.setReadiness(endpoint, 'available', binding.expiresAt).ok || !direct(work, time(), binding)) throw no('cancelled');
      controlRecord('bound'); reportedSetting = facts.current;
      const deadline = binding.expiresAt; armControl(binding, deadline);
      if (!direct(work, time(), binding)) throw no('cancelled');
      return yes(Object.freeze({ device, sink: endpoint, selectionGeneration: work.choice!.generation, expiresAt: deadline }));
    } catch (error) { if (binding && controlBinding === binding) retireControl(); return no(failure(error)); }
    finally { bindingPending = false; settled(); }
  }
  function applyControl(binding: ControlBinding, observation: Observation, context: DeliveryContext): Promise<void> | void {
    if (controlOperation || bindingPending || controlQuarantine || controlBinding !== binding || binding.retired || controlAttempts >= 32) return;
    controlAttempts++;
    let resultResolve!: () => void; const result = new Promise<void>(yes => { resultResolve = yes; });
    const settled = reserveControlTask();
    const operation: ControlOperation = { binding, issued: false, cancelled: false, unknown: false, finish: resultResolve, settled }; controlOperation = operation;
    const run = async () => {
      try {
        const signalProperty = Object.getOwnPropertyDescriptor(context, 'signal'), currentProperty = Object.getOwnPropertyDescriptor(context, 'isCurrent');
        if (!signalProperty || !('value' in signalProperty) || !intrinsicSignal(signalProperty.value) || !currentProperty || !('value' in currentProperty) || typeof currentProperty.value !== 'function') return;
        const signal = signalProperty.value as AbortSignal; operation.contextSignal = signal;
        const cancel = () => { if (controlOperation === operation) retireControl(); }; operation.remove = () => Reflect.apply(signalRemove, signal, ['abort', cancel]);
        Reflect.apply(signalAdd, signal, ['abort', cancel, { once: true }]);
        if (!Reflect.apply(currentProperty.value, context, []) || typeof options!.controlDeliveryLimits !== 'function') return;
        const delivery = fields((options!.controlDeliveryLimits as NonNullable<BrowserCameraOptions['controlDeliveryLimits']>)(context), ['context', 'expiresAt', 'maxAgeMs', 'maxHz']);
        if (!delivery || Object.keys(delivery).length !== 4 || delivery.context !== context || typeof delivery.expiresAt !== 'number' || !Number.isFinite(delivery.expiresAt) ||
            typeof delivery.maxAgeMs !== 'number' || !Number.isFinite(delivery.maxAgeMs) || delivery.maxAgeMs <= 0 || delivery.maxAgeMs > 250 ||
            typeof delivery.maxHz !== 'number' || !Number.isFinite(delivery.maxHz) || delivery.maxHz <= 0 || delivery.maxHz > 2) return;
        const facts = controlFacts(binding.work, binding.axis);
        const valueProperty = Object.getOwnPropertyDescriptor(observation, 'value'), stamp = Object.getOwnPropertyDescriptor(observation, 'timestamp'), clock = Object.getOwnPropertyDescriptor(observation, 'clockDomain');
        const value = valueProperty && 'value' in valueProperty ? valueProperty.value : undefined;
        if (!facts || !sameRange(facts, binding.facts)) { retireControl(); return; }
        if (typeof value !== 'number' || !aligned(value, facts) || !stamp || !('value' in stamp) || typeof stamp.value !== 'number' || !clock || !('value' in clock) || clock.value !== runtime.clockDomain) return;
        const native = binding.work.tracks![0]!, method = native.applyConstraints;
        if (typeof method !== 'function') { retireControl(); return; }
        // Complete every callback observer before the final fresh clock. The
        // final fence thereafter is intrinsic signals + private epoch/deadlines.
        const at = time();
        if (!direct(binding.work, at, binding, signal) || operation.cancelled || controlOperation !== operation || !Number.isFinite(stamp.value) || at < stamp.value || at >= delivery.expiresAt || at - stamp.value > delivery.maxAgeMs || at - lastControlAt < 1000 / delivery.maxHz) return;
        lastControlAt = at; operation.issued = true; controlRecord('issued');
        armControl(binding, Math.min(at + 5000, binding.expiresAt, binding.work.deadline, delivery.expiresAt, stamp.value + delivery.maxAgeMs), operation);
        const constraints = Object.freeze({ advanced: Object.freeze([Object.freeze({ [binding.axis]: value })]) }) as unknown as MediaTrackConstraints;
        let returned: Promise<void>;
        try { returned = Reflect.apply(method, native, [constraints]) as Promise<void>; }
        catch { operation.unknown = true; controlQuarantine = true; cleanupFailures++; retireControl(); return; }
        // Intrinsic Promise consumption ignores shadowed then methods and keeps
        // the reservation until actual native return settlement, never destroyed flags.
        let nativeWork: Promise<void>;
        try { nativeWork = new Promise<void>((yes, reject) => { try { Reflect.apply(promiseThen, returned, [yes, reject]); } catch (error) { operation.unknown = true; controlQuarantine = true; cleanupFailures++; retireControl(); reject(error); } }); }
        catch { operation.unknown = true; controlQuarantine = true; cleanupFailures++; retireControl(); return; }
        try { await nativeWork; }
        catch { if (!operation.cancelled) { retireControl(); controlRecord('rejected'); } return; }
        if (operation.cancelled || controlOperation !== operation || !direct(binding.work, lastAt, binding, signal)) return;
        const reported = controlFacts(binding.work, binding.axis); if (!Reflect.apply(currentProperty.value, context, [])) return;
        const after = time(); if (!direct(binding.work, after, binding, signal) || operation.cancelled || !reported || !sameRange(reported, binding.facts) || after >= delivery.expiresAt || after - stamp.value > delivery.maxAgeMs) return;
        reportedSetting = reported.current; controlRecord('api-returned');
      } catch { if (operation.issued) retireControl(); }
      finally {
        try { operation.remove?.(); } catch { cleanupFailures++; controlQuarantine = true; }
        operation.finish();
        if (!operation.unknown) {
          if (controlOperation === operation) controlOperation = undefined;
          if (controlBinding === binding) { const at = time(); if (direct(binding.work, at, binding)) armControl(binding, binding.expiresAt); else retireControl(); }
          operation.settled();
        }
      }
    };
    // The owning task and raw slot were published before run enters any getters.
    void run(); return result;
  }
  async function close(): Promise<void> { closed = true; retire('closed'); while (tasks.size) await Promise.allSettled([...tasks]); }
  return Object.freeze({ inspect, start, inspectControls,
    bindZoom: (activation: BrowserCameraActivation, raw: Readonly<{ purpose: string }>) => bindControl(activation, raw, 'zoom'),
    bindPan: (activation: BrowserCameraActivation, raw: Readonly<{ purpose: string }>) => bindControl(activation, raw, 'pan'),
    bindTilt: (activation: BrowserCameraActivation, raw: Readonly<{ purpose: string }>) => bindControl(activation, raw, 'tilt'),
    controlStatus: () => Object.freeze({ state: controlState, attempts: controlAttempts, activeSinks: Number(controlBinding?.sink !== undefined), rawPending: Number(controlOperation !== undefined), bindingPending: Number(bindingPending),
      ...(reportedSetting === undefined ? {} : { reportedSetting }), records: Object.freeze([...controlRecords]), expiryArmed: controlTimer !== undefined }), stop: () => retire('stopped'), sweep, close,
    snapshot: () => Object.freeze({ phase: closed || isAborted(owner) ? 'closed' : active ? 'active' : slot && !slot.cancelled ? 'opening' : choices.length ? 'selected' : 'idle', reason,
      attempts, selectionGeneration: generation, activeSources: Number(active?.source !== undefined), rawPending: Number(slot !== undefined), framePending: Number((active ?? slot)?.frame !== undefined), cleanupFailures,
      listeners: removals.length, samples: active?.samples ?? 0, expiryArmed: expiryTimer !== undefined }) });
}
