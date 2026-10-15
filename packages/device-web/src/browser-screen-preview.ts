import { parseDeviceDescriptor, snapshotResourceBytes } from '@101/device-model';
import type { DeviceDescriptor } from '@101/device-model';
import type { DeviceRuntime, EndpointHandle } from '@101/device-runtime';

/** Pixel payload and owned-work bounds; native capture/decoder buffers and JS heap size remain opaque. */
export const BROWSER_SCREEN_PREVIEW_LIMITS = Object.freeze({ nativeTracks: 8, attempts: 32, rawPending: 1,
  captureMs: 30000, openMs: 5000, width: 8, height: 8, bytes: 256, nativeWidth: 8192, nativeHeight: 8192,
  maxHz: 10, samples: 300, frameCallbacks: 600, latest: 1, listeners: 12, expiryTimers: 1 });
export interface BrowserScreenPreviewFrame { readonly format: 'rgba8'; readonly width: 8; readonly height: 8; readonly rows: readonly (readonly number[])[] }
export type BrowserScreenPreviewFailure = 'invalid' | 'unsupported' | 'unavailable' | 'denied' | 'busy' | 'closed' | 'lost' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'cancelled' | 'quota' | 'gesture-required' | 'changed';
export type BrowserScreenPreviewResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: BrowserScreenPreviewFailure }>;
export interface BrowserScreenPreviewFacts {
  readonly width: number | 'unknown'; readonly height: number | 'unknown';
  readonly displaySurface: 'monitor' | 'window' | 'browser' | 'unknown';
  readonly cursor: 'always' | 'motion' | 'never' | 'unknown';
}
export interface BrowserScreenPreviewCaptureRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly selectionGeneration: number; readonly deviceId: string;
  readonly profile: 'browser-screen-preview/1'; readonly capabilityId: 'screen-preview'; readonly operation: 'subscribe';
  readonly capture: Readonly<{ video: true; audio: false }>;
}
export interface BrowserScreenPreviewCaptureGrant { readonly request: BrowserScreenPreviewCaptureRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface BrowserScreenPreviewActivation { readonly device: DeviceDescriptor; readonly source: EndpointHandle; readonly selectionGeneration: number; readonly facts: BrowserScreenPreviewFacts }
/** Explicit cooperative factory; owned native canvas fixtures never qualify native screen capture.
 * Returned native objects must belong to the same declared realm and be exclusively owned. */
export interface BrowserScreenPreviewEnvironment {
  readonly fixtureKind: 'owned-canvas-fixture' | 'software-fixture';
  readonly getDisplayMedia?: (options: Readonly<{ video: true; audio: false }>) => Promise<MediaStream>;
  readonly createVideo?: () => HTMLVideoElement; readonly createCanvas?: () => HTMLCanvasElement;
  readonly MediaStream?: typeof MediaStream; readonly HTMLVideoElement?: typeof HTMLVideoElement;
  readonly HTMLCanvasElement?: typeof HTMLCanvasElement; readonly ImageData?: typeof ImageData;
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly userActivation: () => boolean;
  readonly hidden: () => boolean; readonly focused: () => boolean; readonly secureContext: () => boolean;
}
export interface BrowserScreenPreviewOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly now: () => number; readonly authorizeCapture: (request: BrowserScreenPreviewCaptureRequest) => BrowserScreenPreviewCaptureGrant | undefined;
  readonly environment?: BrowserScreenPreviewEnvironment;
}
export interface BrowserScreenPreviewProvider {
  start(options: Readonly<{ purpose: string }>): Promise<BrowserScreenPreviewResult<BrowserScreenPreviewActivation>>;
  stop(): void; sweep(): void; close(): Promise<void>;
  snapshot(): Readonly<{ phase: 'idle' | 'opening' | 'active' | 'closed'; reason: BrowserScreenPreviewFailure | 'idle' | 'active';
    attempts: number; selectionGeneration: number; activeSources: number; rawPending: number; framePending: number; cleanupFailures: number; listeners: number; samples: number; expiryArmed: boolean }>;
}
interface FrameWork { token?: number; settled: boolean; unknown: boolean; resolve(): void }
interface Work {
  revision: number; deadline: number; cancelled: boolean; finished: boolean; rawDone: boolean; uncertainCleanup: boolean;
  resolve: (result: BrowserScreenPreviewResult<unknown>) => void; grant?: Readonly<{ signal: AbortSignal; expiresAt: number }>;
  generation: number; device: DeviceDescriptor; facts?: BrowserScreenPreviewFacts; decodedWidth?: number; decodedHeight?: number; stream?: MediaStream; tracks?: MediaStreamTrack[]; trackId?: string; video?: HTMLVideoElement; canvas?: HTMLCanvasElement; paint?: CanvasRenderingContext2D;
  source?: EndpointHandle; frame?: FrameWork; requestingFrame: boolean; firstPicture?: (present: boolean) => void;
  callbacks: number; samples: number; lastSample: number; lastMedia: number; sequence: number;
}
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
const captureOptions = Object.freeze({ video: true as const, audio: false as const });
const no = (reason: BrowserScreenPreviewFailure): BrowserScreenPreviewResult<never> => Object.freeze({ ok: false, reason });
const yes = <T>(value: T): BrowserScreenPreviewResult<T> => Object.freeze({ ok: true, value });
function failure(error: unknown): BrowserScreenPreviewFailure {
  try { if (typeof DOMException !== 'undefined' && error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) return 'denied'; } catch { return 'unavailable'; }
  const copied = fields(error, ['ok', 'reason']); return copied?.ok === false ? copied.reason as BrowserScreenPreviewFailure : 'unavailable';
}
function descriptor(id: string): DeviceDescriptor {
  const fixed = (value: number) => ({ type: 'scalar' as const, unit: '1', min: value, max: value });
  return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Selected screen preview', revision: 1,
    adapter: { id: 'app:browser-screen-preview', version: '1.0.0' }, runtime: { platform: 'browser-video-api' }, capabilities: [{
      id: 'screen-preview', semantic: 'media:screen-preview-rgba8/1', schemaVersion: 1, kind: 'sample',
      value: { type: 'record', fields: { format: { type: 'enum', values: ['rgba8'] }, width: fixed(8), height: fixed(8),
        rows: { type: 'array', minItems: 8, maxItems: 8, items: { type: 'array', minItems: 32, maxItems: 32, items: { type: 'scalar', unit: '1', min: 0, max: 255, resolution: 1 } } } } },
      delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 }, permissions: ['subscribe'] }] });
}
function nativeFacts(settings: MediaTrackSettings): BrowserScreenPreviewFacts {
  const get = (key: string): unknown => { const property = Object.getOwnPropertyDescriptor(settings, key); if (!property) return undefined; if (!('value' in property)) throw no('unsupported'); return property.value; };
  const dimension = (key: string): number | 'unknown' => { const value = get(key); if (value === undefined) return 'unknown'; if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 8192) throw no('unsupported'); return value as number; };
  const surface = get('displaySurface'), cursor = get('cursor');
  if (surface !== undefined && !['monitor', 'window', 'browser'].includes(surface as string) || cursor !== undefined && !['always', 'motion', 'never'].includes(cursor as string)) throw no('unsupported');
  return Object.freeze({ width: dimension('width'), height: dimension('height'), displaySurface: (surface ?? 'unknown') as BrowserScreenPreviewFacts['displaySurface'], cursor: (cursor ?? 'unknown') as BrowserScreenPreviewFacts['cursor'] });
}
function sameFacts(left: BrowserScreenPreviewFacts, right: BrowserScreenPreviewFacts): boolean { return left.width === right.width && left.height === right.height && left.displaySurface === right.displaySurface && left.cursor === right.cursor; }
function defaults(): Omit<BrowserScreenPreviewEnvironment, 'fixtureKind'> {
  const win = typeof window === 'undefined' ? undefined : window, doc = typeof document === 'undefined' ? undefined : document;
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  return { getDisplayMedia: media?.getDisplayMedia?.bind(media),
    createVideo: doc ? () => doc.createElement('video') : undefined, createCanvas: doc ? () => doc.createElement('canvas') : undefined,
    MediaStream: typeof MediaStream === 'undefined' ? undefined : MediaStream, HTMLVideoElement: typeof HTMLVideoElement === 'undefined' ? undefined : HTMLVideoElement,
    HTMLCanvasElement: typeof HTMLCanvasElement === 'undefined' ? undefined : HTMLCanvasElement, ImageData: typeof ImageData === 'undefined' ? undefined : ImageData,
    target: win ?? new EventTarget(), document: doc ?? new EventTarget(), userActivation: () => typeof navigator !== 'undefined' && navigator.userActivation?.isActive === true,
    hidden: () => doc?.hidden !== false, focused: () => doc?.hasFocus() === true, secureContext: () => globalThis.isSecureContext === true };
}
let controllers = 0;
/** Explicit one-shot display chooser to a downsized 8x8 private RGBA8 resource.
 * Native selected-surface settings and decoded-video dimensions are facts, not identity
 * or permission. No acquisition on arrival, audio, full-size raster retention, cursor
 * mapping, encoded streaming or hardware capture timestamp. A resize requires fresh
 * capture consent. Native internal buffers remain opaque. Held chooser/play/frame work
 * stays owned through actual API settlement; trusted factories are not a sandbox. */
export function createBrowserScreenPreviewProvider(input: BrowserScreenPreviewOptions): BrowserScreenPreviewProvider {
  const options = fields(input, ['runtime', 'ownerSignal', 'scope', 'now', 'authorizeCapture', 'environment']);
  const scope = options && fields(options.scope, ['principalId', 'applicationId', 'sessionId']);
  if (!options || !scope || Object.keys(scope).length !== 3 || !Object.values(scope).every(identifier) || !intrinsicSignal(options.ownerSignal) || typeof options.now !== 'function' || typeof options.authorizeCapture !== 'function') throw new TypeError('Invalid screen preview owner');
  const runtime = options.runtime as DeviceRuntime, owner = options.ownerSignal, now = options.now as () => number, authorize = options.authorizeCapture as BrowserScreenPreviewOptions['authorizeCapture'];
  if (!runtime || !identifier(runtime.clockDomain) || ['registerSource', 'setReadiness', 'unregister', 'publish'].some(key => typeof runtime[key as keyof DeviceRuntime] !== 'function')) throw new TypeError('Invalid screen preview runtime');
  const fixture = options.environment === undefined ? undefined : fields(options.environment, ['fixtureKind', 'getDisplayMedia', 'createVideo', 'createCanvas', 'MediaStream', 'HTMLVideoElement', 'HTMLCanvasElement', 'ImageData', 'target', 'document', 'userActivation', 'hidden', 'focused', 'secureContext']);
  if (options.environment !== undefined && (!fixture || !['owned-canvas-fixture', 'software-fixture'].includes(fixture.fixtureKind as string))) throw new TypeError('Explicit screen preview fixture kind required');
  const env = (fixture ?? defaults()) as BrowserScreenPreviewEnvironment;
  if (['hidden', 'focused', 'secureContext', 'userActivation'].some(key => typeof env[key as keyof BrowserScreenPreviewEnvironment] !== 'function') || !env.target || !env.document) throw new TypeError('Invalid screen preview environment');
  const ownedScope = Object.freeze({ ...scope }), controller = ++controllers; if (!Number.isSafeInteger(controller)) throw new RangeError('Screen preview identity exhausted');
  const removals: (() => void)[] = [], tasks = new Set<Promise<void>>();
  let closed = isAborted(owner), tearing = false, attempts = 0, generation = 0, revision = 0, lastAt = -1, cleanupFailures = 0;
  let slot: Work | undefined, active: Work | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let reason: BrowserScreenPreviewFailure | 'idle' | 'active' = closed ? 'closed' : 'idle';
  let closing: Promise<void> | undefined;
  function usable(): boolean { return !closed && !tearing && !isAborted(owner); }
  function track(task: Promise<void>): void { tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {}); }
  function issue<T>(work: Work, native: () => T): T {
    try { return native(); } catch (error) { work.uncertainCleanup = true; cleanupFailures++; throw error; }
  }
  function finish(work: Work, result: BrowserScreenPreviewResult<unknown>): void { if (!work.finished) { work.finished = true; work.resolve(result); } }
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
  function unregisterSource(work: Work): void {
    const endpoint = work.source; if (!endpoint) return;
    // Clear before the callout: reentrant Stop/close cannot retire this handle twice.
    work.source = undefined;
    try { if (!runtime.unregister(endpoint).ok) { work.uncertainCleanup = true; cleanupFailures++; } }
    catch { work.uncertainCleanup = true; cleanupFailures++; }
  }
  function cleanup(work: Work): void {
    slot ??= work; unregisterSource(work); cancelFrame(work); work.firstPicture?.(false); work.firstPicture = undefined;
    const tracks = work.tracks ?? (() => { try { return work.stream?.getTracks(); } catch { work.uncertainCleanup = true; cleanupFailures++; return; } })();
    if (tracks && tracks.length > 8) { work.uncertainCleanup = true; cleanupFailures++; }
    for (const native of (tracks ?? []).slice(0, 8)) { try { native.stop(); } catch { work.uncertainCleanup = true; cleanupFailures++; } }
    try { work.video?.pause(); if (work.video) { work.video.srcObject = null; work.video.remove(); } } catch { work.uncertainCleanup = true; cleanupFailures++; }
    try { if (work.canvas) { work.canvas.width = 1; work.canvas.height = 1; work.canvas.remove(); } } catch { work.uncertainCleanup = true; cleanupFailures++; }
    release(work);
  }
  function retire(why: BrowserScreenPreviewFailure): void {
    revision++; const old = active; active = undefined; reason = why;
    const pending = slot; if (pending) { pending.cancelled = true; finish(pending, no(why)); }
    if (old) old.cancelled = true;
    if (tearing) return; tearing = true;
    try {
      if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined;
      for (const dispose of removals.splice(0)) { try { dispose(); } catch { cleanupFailures++; } }
      for (const work of new Set([old, pending])) if (work) {
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
  }
  function availability(): BrowserScreenPreviewFailure | undefined { if (!env.secureContext()) return 'denied'; if (env.hidden()) return 'hidden'; if (!env.focused()) return 'unfocused'; }
  function begin<T>(): { work: Work; result: Promise<BrowserScreenPreviewResult<T>> } | BrowserScreenPreviewResult<never> {
    if (!usable()) return no('closed'); if (slot || active || tearing) return no('busy'); if (attempts >= 32) return no('quota'); attempts++;
    let resolve!: Work['resolve']; const result = new Promise<BrowserScreenPreviewResult<T>>(yes => { resolve = value => yes(value as BrowserScreenPreviewResult<T>); });
    generation++; const work: Work = { generation, device: descriptor(`browser-screen-${controller}:generation-${generation}`), revision, deadline: Infinity, cancelled: false, finished: false, rawDone: false, uncertainCleanup: false, requestingFrame: false,
      callbacks: 0, samples: 0, lastSample: -Infinity, lastMedia: -1, sequence: 0, resolve }; slot = work; return { work, result };
  }
  function done(work: Work): void { work.rawDone = true; release(work); }
  function arm(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined;
    if (!usable()) return; const turn = revision, at = time(); if (!usable() || revision !== turn) return;
    const deadline = active?.deadline ?? (slot && !slot.cancelled ? slot.deadline : undefined);
    if (deadline !== undefined && Number.isFinite(deadline)) expiryTimer = setTimeout(() => { expiryTimer = undefined; if (turn === revision) sweep(); }, Math.max(1, deadline - at));
  }
  function sweep(): void { const turn = revision, at = time(); if (turn !== revision || !usable()) return;
    if (active && at >= active.deadline || slot && !slot.cancelled && at >= slot.deadline) retire('expired'); else arm(); }
  function nativePicture(work: Work, metadata: VideoFrameCallbackMetadata): { mediaTime: number; presentedFrames: number; width: number; height: number } {
    const selected: Record<string, number> = {};
    for (const key of ['mediaTime', 'presentedFrames', 'width', 'height']) { const property = Object.getOwnPropertyDescriptor(metadata, key); if (!property || !('value' in property) || typeof property.value !== 'number' || !Number.isFinite(property.value)) throw no('unsupported'); selected[key] = property.value; }
    const video = work.video!, native = work.tracks![0]!, current = work.stream!.getTracks();
    if (!valid(work)) throw no('cancelled');
    if (!Array.isArray(current) || current.length !== 1 || current[0] !== native || video.srcObject !== work.stream || native.id !== work.trackId) throw no('lost');
    if (native.readyState !== 'live' || native.muted || video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1 || video.videoWidth > 8192 || video.videoHeight > 8192 ||
        selected.width! < 1 || selected.width! > 8192 || selected.height! < 1 || selected.height! > 8192 || selected.mediaTime! < 0 || selected.mediaTime! < work.lastMedia || selected.mediaTime! > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(selected.presentedFrames) || selected.presentedFrames! < 1) throw no('lost');
    const settings = native.getSettings(); if (!valid(work)) throw no('cancelled');
    const facts = nativeFacts(settings); if (!valid(work)) throw no('cancelled');
    if (!sameFacts(facts, work.facts!) || work.decodedWidth !== undefined && (work.decodedWidth !== video.videoWidth || work.decodedHeight !== video.videoHeight)) throw no('changed');
    work.decodedWidth = video.videoWidth; work.decodedHeight = video.videoHeight;
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
    const value: BrowserScreenPreviewFrame = Object.freeze({ format: 'rgba8', width: 8, height: 8, rows: Object.freeze(rows) });
    const observedAt = time(); if (!valid(work)) return; work.lastSample = observedAt; work.lastMedia = picture.mediaTime; work.samples++;
    const published = runtime.publish(work.source!, value, { timestamp: observedAt, clockDomain: runtime.clockDomain, sequence: ++work.sequence,
      provenance: { samplePoint: 'javascript-decoded-raster-retrieval', captureTimeKnown: false, clockMappingEstablished: false,
        mediaTimeSeconds: picture.mediaTime, presentedFrames: picture.presentedFrames, nativeWidthPx: picture.width, nativeHeightPx: picture.height,
        videoContextId: `screen-${controller}:video-${work.generation}`, selectionGeneration: work.generation,
        factoryKind: fixture ? env.fixtureKind : 'native-display-chooser', downsizedPreview: true, previewWidthPx: 8, previewHeightPx: 8 } });
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
  function start(raw: Readonly<{ purpose: string }>): Promise<BrowserScreenPreviewResult<BrowserScreenPreviewActivation>> {
    const started = begin<BrowserScreenPreviewActivation>(); if ('ok' in started) return Promise.resolve(started); const { work, result } = started;
    // Publish the task reservation before any request trap, clock, consent or native factory.
    let settled!: () => void; const reserved = new Promise<void>(resolve => { settled = resolve; }); track(reserved);
    void (async () => {
      try {
        const request = fields(raw, ['purpose']), at = time();
        if (!usable() || revision !== work.revision) throw no('cancelled');
        if (!request || Object.keys(request).length !== 1 || !identifier(request.purpose)) throw no('invalid');
        if (!env.getDisplayMedia || !env.createVideo || !env.createCanvas || !env.MediaStream || !env.HTMLVideoElement || !env.HTMLCanvasElement || !env.ImageData) throw no('unsupported');
        work.deadline = at + 5000;
        const unavailable = availability(); if (!valid(work)) throw no('cancelled'); if (unavailable) throw no(unavailable);
        const gesture = env.userActivation(); if (!valid(work)) throw no('cancelled'); if (!gesture) throw no('gesture-required');
        lifecycle(); if (!valid(work)) throw no('cancelled');
        const captureRequest: BrowserScreenPreviewCaptureRequest = Object.freeze({ ...ownedScope as BrowserScreenPreviewOptions['scope'], purpose: request.purpose,
          selectionGeneration: work.generation, deviceId: work.device.id, profile: 'browser-screen-preview/1', capabilityId: 'screen-preview', operation: 'subscribe', capture: captureOptions });
        const granted = fields(authorize(captureRequest), ['request', 'signal', 'expiresAt']), after = time(); if (!valid(work)) throw no('cancelled');
        if (!granted || Object.keys(granted).length !== 3 || granted.request !== captureRequest || !intrinsicSignal(granted.signal) || isAborted(granted.signal) || typeof granted.expiresAt !== 'number' || !Number.isFinite(granted.expiresAt) || granted.expiresAt <= after || granted.expiresAt > at + 30000) throw no('denied');
        work.grant = Object.freeze({ signal: granted.signal, expiresAt: granted.expiresAt }); work.deadline = Math.min(work.deadline, granted.expiresAt); listen(granted.signal, 'abort', () => retire('denied'), true); arm(); if (!valid(work)) throw no('cancelled');
        if (!valid(work)) throw no('cancelled');
        const beforeChooser = availability(), currentGesture = env.userActivation();
        // Availability and activation are trusted synchronous callouts, then the
        // clock is reread. Final intrinsic fences follow; no unbounded observer loop.
        // Native getDisplayMedia also enforces transient activation at issuance.
        const beforeNative = time();
        if (!usable() || work.cancelled || work.revision !== revision || slot !== work || isAborted(work.grant.signal) || !Number.isFinite(beforeNative)) throw no('cancelled');
        if (beforeNative >= work.deadline || beforeNative >= work.grant.expiresAt) throw no('expired');
        if (beforeChooser) throw no(beforeChooser); if (!currentGesture) throw no('gesture-required');
        // Fixed video-only options; chooser chooses the surface. No exact/min constraints or remembered device ID.
        work.stream = await issue(work, () => env.getDisplayMedia!(captureOptions)); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (!(work.stream instanceof env.MediaStream)) throw no('unsupported'); work.tracks = work.stream.getTracks(); if (!valid(work)) throw no('cancelled');
        if (work.tracks.length !== 1 || work.tracks[0]!.kind !== 'video' || work.tracks[0]!.readyState !== 'live' || work.tracks[0]!.muted) throw no('unsupported');
        work.trackId = work.tracks[0]!.id; if (!valid(work)) throw no('cancelled'); if (typeof work.trackId !== 'string' || work.trackId.length < 1 || work.trackId.length > 512) throw no('unsupported');
        work.facts = nativeFacts(work.tracks[0]!.getSettings()); if (!valid(work)) throw no('cancelled');
        listen(work.tracks[0]!, 'ended', () => retire('lost')); listen(work.tracks[0]!, 'mute', () => retire('lost'));
        work.video = issue(work, () => env.createVideo!()); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (!(work.video instanceof env.HTMLVideoElement) || typeof work.video.requestVideoFrameCallback !== 'function' || typeof work.video.cancelVideoFrameCallback !== 'function') throw no('unsupported');
        listen(work.video, 'error', () => retire('lost'));
        work.canvas = issue(work, () => env.createCanvas!()); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (!(work.canvas instanceof env.HTMLCanvasElement)) throw no('unsupported');
        work.canvas.width = 8; if (!valid(work)) throw no('cancelled'); work.canvas.height = 8; if (!valid(work)) throw no('cancelled');
        work.paint = work.canvas.getContext('2d', { willReadFrequently: true }) ?? undefined; if (!valid(work)) throw no('cancelled'); if (!work.paint) throw no('unsupported');
        work.video.muted = true; if (!valid(work)) throw no('cancelled'); work.video.playsInline = true; if (!valid(work)) throw no('cancelled'); work.video.srcObject = work.stream; if (!valid(work)) throw no('cancelled');
        await issue(work, () => work.video!.play()); if (!valid(work)) throw no('cancelled');
        const picture = new Promise<boolean>(resolve => { work.firstPicture = resolve; }); requestFrame(work); if (!await picture || !valid(work)) throw no('cancelled');
        work.source = runtime.registerSource({ device: work.device, capability: 'screen-preview' }); if (!valid(work)) throw no('cancelled');
        if (!runtime.setReadiness(work.source, 'available', granted.expiresAt).ok || !valid(work)) throw no('unavailable');
        active = work; work.deadline = granted.expiresAt; reason = 'active'; arm(); requestFrame(work); if (!valid(work)) throw no('cancelled');
        finish(work, yes(Object.freeze({ device: work.device, source: work.source, selectionGeneration: work.generation, facts: work.facts! })));
      } catch (error) {
        if (!work.cancelled) retire(failure(error)); else cleanup(work);
        finish(work, no(work.cancelled ? reason as BrowserScreenPreviewFailure : failure(error)));
      } finally { try { done(work); arm(); } finally { settled(); } }
    })(); return result;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    let resolve!: () => void; closing = new Promise<void>(yes => { resolve = yes; });
    closed = true; retire('closed');
    void (async () => { while (tasks.size) await Promise.allSettled([...tasks]); resolve(); })(); return closing;
  }
  return Object.freeze({ start, stop: () => retire('stopped'), sweep, close,
    snapshot: () => Object.freeze({ phase: closed || isAborted(owner) ? 'closed' : active ? 'active' : slot && !slot.cancelled ? 'opening' : 'idle', reason,
      attempts, selectionGeneration: generation, activeSources: Number(active?.source !== undefined), rawPending: Number(slot !== undefined), framePending: Number((active ?? slot)?.frame !== undefined), cleanupFailures,
      listeners: removals.length, samples: active?.samples ?? 0, expiryArmed: expiryTimer !== undefined }) });
}
