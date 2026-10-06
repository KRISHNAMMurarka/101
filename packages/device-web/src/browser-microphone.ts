import { parseDeviceDescriptor } from '@101/device-model';
import type { DeviceDescriptor } from '@101/device-model';
import type { DeviceRuntime, EndpointHandle } from '@101/device-runtime';

export const BROWSER_MICROPHONE_LIMITS = Object.freeze({ devices: 8, nativeInventory: 32, attempts: 64, rawPending: 1,
  captureMs: 30000, openMs: 5000, maxHz: 20, polls: 600, samples: 256, latest: 1, listeners: 10, pollTimers: 1, expiryTimers: 1 });
export type BrowserMicrophoneFailure = 'invalid' | 'unsupported' | 'unavailable' | 'denied' | 'busy' | 'closed' | 'lost' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'cancelled' | 'quota';
export type BrowserMicrophoneResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: BrowserMicrophoneFailure }>;
export interface BrowserMicrophoneSelection { readonly browserMicrophoneSelection?: never }
export interface BrowserMicrophoneInventory { readonly ordinal: number; readonly selection: BrowserMicrophoneSelection }
export interface BrowserMicrophoneCaptureRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly selectionGeneration: number; readonly deviceId: string; readonly nativeDeviceId: string;
  readonly capabilityId: 'envelope'; readonly operation: 'subscribe';
}
export interface BrowserMicrophoneCaptureGrant { readonly request: BrowserMicrophoneCaptureRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface BrowserMicrophoneActivation { readonly device: DeviceDescriptor; readonly source: EndpointHandle; readonly selectionGeneration: number }
/** Explicit cooperative test factory. Its data never qualifies microphone hardware.
 * Native constructors must belong to the same declared realm as returned objects. */
export interface BrowserMicrophoneEnvironment {
  readonly fixtureKind: 'owned-audio-fixture' | 'software-fixture';
  readonly enumerateDevices?: () => Promise<readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId'>[]>;
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createAudioContext?: () => AudioContext;
  readonly MediaStream?: typeof MediaStream; readonly AudioContext?: typeof AudioContext;
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly mediaDevicesTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly hidden: () => boolean; readonly focused: () => boolean; readonly secureContext: () => boolean;
}
export interface BrowserMicrophoneOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly now: () => number; readonly authorizeCapture: (request: BrowserMicrophoneCaptureRequest) => BrowserMicrophoneCaptureGrant | undefined;
  readonly environment?: BrowserMicrophoneEnvironment;
}
export interface BrowserMicrophoneProvider {
  inspect(): Promise<BrowserMicrophoneResult<readonly BrowserMicrophoneInventory[]>>;
  start(selection: BrowserMicrophoneSelection, options: Readonly<{ purpose: string }>): Promise<BrowserMicrophoneResult<BrowserMicrophoneActivation>>;
  stop(): void; sweep(): void; close(): Promise<void>;
  snapshot(): Readonly<{ phase: 'idle' | 'selected' | 'opening' | 'active' | 'closed'; reason: BrowserMicrophoneFailure | 'idle' | 'selected' | 'active';
    attempts: number; selectionGeneration: number; activeSources: number; rawPending: number; cleanupPending: number; cleanupFailures: number; listeners: number; polls: number; pollArmed: boolean; expiryArmed: boolean }>;
}
interface Choice { handle: BrowserMicrophoneSelection; nativeId: string; generation: number; expiresAt: number; device: DeviceDescriptor }
interface Work {
  revision: number; deadline: number; cancelled: boolean; finished: boolean; rawDone: boolean; cleanupDone: boolean;
  resolve: (value: BrowserMicrophoneResult<unknown>) => void; grant?: Readonly<{ signal: AbortSignal; expiresAt: number }>;
  choice?: Choice; stream?: MediaStream; tracks?: MediaStreamTrack[]; context?: AudioContext; node?: MediaStreamAudioSourceNode; analyser?: AnalyserNode;
  source?: EndpointHandle; closeIssued: boolean; polls: number; lastPoll: number; lastContext: number; sequence: number;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const signalAdd = EventTarget.prototype.addEventListener, signalRemove = EventTarget.prototype.removeEventListener;
function isAborted(value: AbortSignal): boolean { return Reflect.apply(aborted, value, []) as boolean; }
function intrinsicSignal(value: unknown): value is AbortSignal { try { isAborted(value as AbortSignal); return true; } catch { return false; } }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const result: Record<string, unknown> = Object.create(null), descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) { if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]!)) return; result[key] = descriptors[key]!.value; }
    return result;
  } catch { return; }
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(value);
const no = (reason: BrowserMicrophoneFailure): BrowserMicrophoneResult<never> => Object.freeze({ ok: false, reason });
const yes = <T>(value: T): BrowserMicrophoneResult<T> => Object.freeze({ ok: true, value });
function failure(error: unknown): BrowserMicrophoneFailure {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && ['SecurityError', 'NotAllowedError'].includes(error.name)) return 'denied';
  const own = fields(error, ['ok', 'reason']); return own?.ok === false ? own.reason as BrowserMicrophoneFailure : 'unavailable';
}
function descriptor(id: string): DeviceDescriptor {
  const scalar = (unit: string, min: number, max: number) => ({ type: 'scalar' as const, unit, min, max });
  return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Selected microphone envelope', revision: 1,
    adapter: { id: 'app:browser-microphone', version: '1.0.0' }, runtime: { platform: 'browser-audio-api' }, capabilities: [{
      id: 'envelope', semantic: 'media:microphone-envelope/1', schemaVersion: 1, kind: 'sample',
      value: { type: 'record', fields: { rms: scalar('1', 0, 1), peak: scalar('1', 0, 1), sampleCount: scalar('1', 256, 256), sampleRateHz: scalar('Hz', 8000, 384000) } },
      delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 250 }, permissions: ['subscribe'] }] });
}
function defaults(): Omit<BrowserMicrophoneEnvironment, 'fixtureKind'> {
  const win = typeof window === 'undefined' ? undefined : window, doc = typeof document === 'undefined' ? undefined : document;
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  return { enumerateDevices: media?.enumerateDevices?.bind(media), getUserMedia: media?.getUserMedia?.bind(media),
    createAudioContext: typeof AudioContext === 'undefined' ? undefined : () => new AudioContext(),
    MediaStream: typeof MediaStream === 'undefined' ? undefined : MediaStream, AudioContext: typeof AudioContext === 'undefined' ? undefined : AudioContext,
    target: win ?? new EventTarget(), document: doc ?? new EventTarget(), mediaDevicesTarget: media ?? new EventTarget(),
    hidden: () => doc?.hidden !== false, focused: () => doc?.hasFocus() === true, secureContext: () => globalThis.isSecureContext === true };
}
let controllers = 0;
/** One exact selected audioinput; no ambient/default selector, PCM retention or playback.
 * JS retrieval and AudioContext position are distinct unmapped clocks, not capture freshness.
 * The fixed analyser window measures digital amplitude only, without acoustic calibration.
 * Raw inspection/open/resume/close work stays reserved through actual settlement. A native
 * promise which never settles can keep close pending; logical deadline cannot abort getUserMedia.
 * Native browser buffering and trusted factory/removal failures are not a host sandbox or a
 * native cleanup guarantee. Explicit factory seams qualify only their labeled software producer. */
export function createBrowserMicrophoneProvider(input: BrowserMicrophoneOptions): BrowserMicrophoneProvider {
  const options = fields(input, ['runtime', 'ownerSignal', 'scope', 'now', 'authorizeCapture', 'environment']);
  const scope = options && fields(options.scope, ['principalId', 'applicationId', 'sessionId']);
  if (!options || !scope || Object.keys(scope).length !== 3 || !Object.values(scope).every(identifier) || !intrinsicSignal(options.ownerSignal) || typeof options.now !== 'function' || typeof options.authorizeCapture !== 'function') throw new TypeError('Invalid microphone owner');
  const runtime = options.runtime as DeviceRuntime, owner = options.ownerSignal, now = options.now as () => number, authorize = options.authorizeCapture as BrowserMicrophoneOptions['authorizeCapture'];
  if (!runtime || !identifier(runtime.clockDomain) || ['registerSource', 'setReadiness', 'unregister', 'publish'].some(key => typeof runtime[key as keyof DeviceRuntime] !== 'function')) throw new TypeError('Invalid microphone runtime');
  const fixture = options.environment === undefined ? undefined : fields(options.environment, ['fixtureKind', 'enumerateDevices', 'getUserMedia', 'createAudioContext', 'MediaStream', 'AudioContext', 'target', 'document', 'mediaDevicesTarget', 'hidden', 'focused', 'secureContext']);
  if (options.environment !== undefined && (!fixture || !['owned-audio-fixture', 'software-fixture'].includes(fixture.fixtureKind as string))) throw new TypeError('Explicit microphone fixture kind required');
  const env = (fixture ?? defaults()) as BrowserMicrophoneEnvironment;
  if (['hidden', 'focused', 'secureContext'].some(key => typeof env[key as keyof BrowserMicrophoneEnvironment] !== 'function') || !env.target || !env.document || !env.mediaDevicesTarget) throw new TypeError('Invalid microphone environment');
  const ownedScope = Object.freeze({ ...scope }), controller = ++controllers; if (!Number.isSafeInteger(controller)) throw new RangeError('Microphone identity exhausted');
  const handles = new WeakMap<object, Choice>(), removals: (() => void)[] = [], tasks = new Set<Promise<void>>(), samples = new Float32Array(256);
  let closed = isAborted(owner), tearing = false, attempts = 0, generation = 0, revision = 0, lastAt = -1, cleanupFailures = 0;
  let choices: Choice[] = [], slot: Work | undefined, active: Work | undefined, pollTimer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let reason: BrowserMicrophoneFailure | 'idle' | 'selected' | 'active' = closed ? 'closed' : 'idle';
  function usable(): boolean { return !closed && !tearing && !isAborted(owner); }
  function finish(work: Work, result: BrowserMicrophoneResult<unknown>): void { if (!work.finished) { work.finished = true; work.resolve(result); } }
  function release(work: Work): void { if (slot === work && work.rawDone && work.cleanupDone) slot = undefined; }
  function track(task: Promise<void>): void { tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {}); }
  function cleanup(work: Work): void {
    // Repeat exact disconnects after obsolete native return; teardown may precede its effect.
    for (const node of [work.node, work.analyser]) { try { node?.disconnect(); } catch { cleanupFailures++; } }
    const tracks = work.tracks ?? (() => { try { return work.stream?.getTracks(); } catch { cleanupFailures++; return; } })();
    for (const track of tracks ?? []) { try { track.stop(); } catch { cleanupFailures++; } }
    if (work.context && !work.closeIssued) {
      work.closeIssued = true; work.cleanupDone = false; slot ??= work;
      let promise: Promise<void>; try { promise = Promise.resolve(work.context.close()); } catch { cleanupFailures++; promise = Promise.resolve(); }
      const closing = promise.catch(() => { cleanupFailures++; }).finally(() => { work.cleanupDone = true; release(work); }); track(closing);
    }
  }
  function retire(why: BrowserMicrophoneFailure): void {
    revision++; const old = active; active = undefined; choices = []; reason = why;
    const pending = slot; if (pending) { pending.cancelled = true; finish(pending, no(why)); }
    if (tearing) return; tearing = true;
    try {
      if (pollTimer !== undefined) clearTimeout(pollTimer); pollTimer = undefined;
      if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined;
      for (const dispose of removals.splice(0)) { try { dispose(); } catch { cleanupFailures++; } }
      for (const work of new Set([old, pending])) if (work?.source) { const endpoint = work.source; work.source = undefined; try { runtime.unregister(endpoint); } catch { cleanupFailures++; } }
      if (old) cleanup(old); if (pending && pending !== old) cleanup(pending); samples.fill(0);
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
  function availability(): BrowserMicrophoneFailure | undefined {
    if (!env.secureContext()) return 'denied'; if (env.hidden()) return 'hidden'; if (!env.focused()) return 'unfocused';
  }
  function begin<T>(): { work: Work; result: Promise<BrowserMicrophoneResult<T>> } | BrowserMicrophoneResult<never> {
    if (!usable()) return no('closed'); if (slot || active || tearing) return no('busy'); if (attempts >= 64) return no('quota'); attempts++;
    let resolve!: Work['resolve']; const result = new Promise<BrowserMicrophoneResult<T>>(yes => { resolve = value => yes(value as BrowserMicrophoneResult<T>); });
    const work: Work = { revision, deadline: Infinity, cancelled: false, finished: false, rawDone: false, cleanupDone: true, closeIssued: false, polls: 0, lastPoll: -Infinity, lastContext: -1, sequence: 0, resolve }; slot = work;
    return { work, result };
  }
  function done(work: Work): void { work.rawDone = true; release(work); }
  function arm(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer); expiryTimer = undefined;
    if (!usable()) return; const turn = revision, at = time(); if (!usable() || revision !== turn) return;
    const deadline = active?.deadline ?? slot?.deadline ?? Math.min(...choices.map(choice => choice.expiresAt));
    if (Number.isFinite(deadline)) expiryTimer = setTimeout(() => { expiryTimer = undefined; if (turn === revision) sweep(); }, Math.max(1, deadline - at));
  }
  function sweep(): void { const turn = revision, at = time(); if (turn !== revision || !usable()) return;
    if (active && at >= active.deadline || slot && !slot.cancelled && at >= slot.deadline || choices.length && at >= choices[0]!.expiresAt) retire('expired'); else arm(); }
  function schedule(work: Work): void {
    if (!valid(work) || pollTimer !== undefined) return; const turn = revision;
    pollTimer = setTimeout(() => { pollTimer = undefined; if (turn === revision && active === work) poll(work); }, 50);
  }
  function poll(work: Work): void {
    try {
      if (!valid(work)) { if (active === work) retire('expired'); return; }
      const at = time(); if (!valid(work)) return; if (at - work.lastPoll < 50) { schedule(work); return; }
      if (work.polls >= 600) { retire('quota'); return; } work.polls++; work.lastPoll = at;
      const context = work.context!, analyser = work.analyser!, track = work.tracks![0]!;
      if (track.readyState !== 'live' || track.muted || context.state !== 'running') { retire('lost'); return; }
      const audioAt = context.currentTime; if (!valid(work)) return;
      analyser.getFloatTimeDomainData(samples); if (!valid(work)) return;
      if (!Number.isFinite(audioAt) || audioAt < work.lastContext || audioAt < 0 || audioAt > Number.MAX_SAFE_INTEGER) throw no('invalid'); work.lastContext = audioAt;
      let squared = 0, peak = 0; for (const sample of samples) { if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw no('unsupported'); squared += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      const observedAt = time(); if (!valid(work)) return;
      const value = Object.freeze({ rms: Math.sqrt(squared / 256), peak, sampleCount: 256, sampleRateHz: context.sampleRate });
      if (!valid(work)) return;
      runtime.publish(work.source!, value, { timestamp: observedAt, clockDomain: runtime.clockDomain, sequence: ++work.sequence,
        provenance: { samplePoint: 'javascript-analyser-retrieval', captureTimeKnown: false, clockMappingEstablished: false,
          audioContextTimeSeconds: audioAt, audioContextId: `microphone-${controller}:context-${work.choice!.generation}`, selectionGeneration: work.choice!.generation,
          factoryKind: fixture ? env.fixtureKind : 'selected-browser-audioinput' } });
      if (valid(work)) schedule(work);
    } catch (error) { if (active === work) retire(failure(error)); }
  }
  function inspect(): Promise<BrowserMicrophoneResult<readonly BrowserMicrophoneInventory[]>> {
    const started = begin<readonly BrowserMicrophoneInventory[]>(); if ('ok' in started) return Promise.resolve(started); const { work, result } = started;
    const run = (async () => {
      try {
        if (!env.enumerateDevices) throw no('unsupported');
        const at = time(), unavailable = availability(); if (!usable() || revision !== work.revision) throw no('cancelled'); if (unavailable) throw no(unavailable);
        work.deadline = at + 5000; lifecycle(); if (!valid(work)) throw no('cancelled'); arm();
        if (!env.enumerateDevices) throw no('unsupported'); const devices = await env.enumerateDevices(); if (!valid(work)) throw no('cancelled');
        if (!Array.isArray(devices) || devices.length > 32) throw no('unsupported'); const ids: string[] = [];
        for (const device of devices) { const kind = device.kind, id = device.deviceId; if (!valid(work)) throw no('cancelled');
          if (kind !== 'audioinput' || id === '' || id === 'default' || id === 'communications') continue;
          if (typeof id !== 'string' || id.length > 512 || ids.includes(id)) throw no('unsupported'); ids.push(id); if (ids.length > 8) throw no('unsupported'); }
        const after = time(); if (!valid(work)) throw no('cancelled'); generation++; choices = ids.map(id => {
          const handle = Object.freeze({}); const choice = { handle, nativeId: id, generation, expiresAt: after + 30000, device: descriptor(`browser-microphone-${controller}:generation-${generation}`) }; handles.set(handle, choice); return choice; });
        reason = choices.length ? 'selected' : 'unavailable'; finish(work, yes(Object.freeze(choices.map((choice, ordinal) => Object.freeze({ ordinal, selection: choice.handle })))));
      } catch (error) { finish(work, no(failure(error))); } finally { done(work); arm(); }
    })(); track(run); return result;
  }
  function start(handle: BrowserMicrophoneSelection, raw: Readonly<{ purpose: string }>): Promise<BrowserMicrophoneResult<BrowserMicrophoneActivation>> {
    const started = begin<BrowserMicrophoneActivation>(); if ('ok' in started) return Promise.resolve(started); const { work, result } = started;
    const run = (async () => {
      try {
        const selected = handle && typeof handle === 'object' ? handles.get(handle) : undefined, request = fields(raw, ['purpose']), at = time();
        if (!usable() || revision !== work.revision) throw no('cancelled'); if (!selected || !choices.includes(selected)) throw no('denied');
        if (!request || Object.keys(request).length !== 1 || !identifier(request.purpose)) throw no('invalid');
        const unavailable = availability(); if (!usable() || revision !== work.revision) throw no('cancelled'); if (unavailable) throw no(unavailable);
        work.choice = selected; work.deadline = Math.min(at + 5000, selected.expiresAt); lifecycle();
        const captureRequest: BrowserMicrophoneCaptureRequest = Object.freeze({ ...ownedScope as BrowserMicrophoneOptions['scope'], purpose: request.purpose,
          selectionGeneration: selected.generation, deviceId: selected.device.id, nativeDeviceId: selected.nativeId, capabilityId: 'envelope', operation: 'subscribe' });
        const granted = fields(authorize(captureRequest), ['request', 'signal', 'expiresAt']), after = time(); if (!valid(work) || !choices.includes(selected)) throw no('cancelled');
        if (!granted || Object.keys(granted).length !== 3 || granted.request !== captureRequest || !intrinsicSignal(granted.signal) || isAborted(granted.signal) || typeof granted.expiresAt !== 'number' || !Number.isFinite(granted.expiresAt) || granted.expiresAt <= after || granted.expiresAt > after + 30000 || granted.expiresAt > selected.expiresAt) throw no('denied');
        work.grant = Object.freeze({ signal: granted.signal, expiresAt: granted.expiresAt }); work.deadline = Math.min(work.deadline, granted.expiresAt);
        listen(granted.signal, 'abort', () => retire('denied'), true); arm(); if (!valid(work)) throw no('cancelled');
        if (!env.getUserMedia || !env.createAudioContext || !env.MediaStream || !env.AudioContext) throw no('unsupported');
        const constraints = Object.freeze({ audio: Object.freeze({ deviceId: Object.freeze({ exact: selected.nativeId }) }), video: false });
        work.stream = await env.getUserMedia(constraints); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (!(work.stream instanceof env.MediaStream)) throw no('unsupported'); work.tracks = work.stream.getTracks(); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (work.tracks.length !== 1 || work.tracks[0]!.kind !== 'audio' || work.tracks[0]!.readyState !== 'live' || work.tracks[0]!.muted) throw no('unsupported');
        const settings = work.tracks[0]!.getSettings(); if (!valid(work)) throw no('cancelled');
        if (!fixture && settings.deviceId !== selected.nativeId || settings.deviceId !== undefined && settings.deviceId !== selected.nativeId) throw no('lost');
        listen(work.tracks[0]!, 'ended', () => retire('lost')); listen(work.tracks[0]!, 'mute', () => retire('lost'));
        work.context = env.createAudioContext(); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (!(work.context instanceof env.AudioContext) || !Number.isFinite(work.context.sampleRate) || work.context.sampleRate < 8000 || work.context.sampleRate > 384000) throw no('unsupported');
        listen(work.context, 'statechange', () => { if (active === work && work.context!.state !== 'running') retire('lost'); });
        work.node = work.context.createMediaStreamSource(work.stream); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        work.analyser = work.context.createAnalyser(); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        work.analyser.fftSize = 256; if (!valid(work)) throw no('cancelled'); work.node.connect(work.analyser); if (!valid(work)) { cleanup(work); throw no('cancelled'); }
        if (work.context.state === 'suspended') { await work.context.resume(); if (!valid(work)) { cleanup(work); throw no('cancelled'); } }
        if (work.context.state !== 'running') throw no('unavailable');
        work.source = runtime.registerSource({ device: selected.device, capability: 'envelope' }); if (!valid(work)) { runtime.unregister(work.source); work.source = undefined; throw no('cancelled'); }
        if (!runtime.setReadiness(work.source, 'available', granted.expiresAt).ok || !valid(work)) throw no('unavailable');
        active = work; work.deadline = granted.expiresAt; reason = 'active'; arm(); schedule(work); if (!valid(work)) throw no('cancelled');
        finish(work, yes(Object.freeze({ device: selected.device, source: work.source, selectionGeneration: selected.generation })));
      } catch (error) {
        if (active === work || work.grant) retire(failure(error)); else { if (work.source) { runtime.unregister(work.source); work.source = undefined; } cleanup(work); }
        finish(work, no(work.cancelled ? reason as BrowserMicrophoneFailure : failure(error)));
      } finally { done(work); arm(); }
    })(); track(run); return result;
  }
  async function close(): Promise<void> { closed = true; retire('closed'); while (tasks.size) await Promise.allSettled([...tasks]); }
  return Object.freeze({ inspect, start, stop: () => retire('stopped'), sweep, close,
    snapshot: () => Object.freeze({ phase: closed || isAborted(owner) ? 'closed' : active ? 'active' : slot && !slot.cancelled ? 'opening' : choices.length ? 'selected' : 'idle', reason,
      attempts, selectionGeneration: generation, activeSources: Number(active?.source !== undefined), rawPending: Number(slot !== undefined), cleanupPending: Number(slot !== undefined && !slot.cleanupDone), cleanupFailures,
      listeners: removals.length, polls: active?.polls ?? 0, pollArmed: pollTimer !== undefined, expiryArmed: expiryTimer !== undefined }) });
}
