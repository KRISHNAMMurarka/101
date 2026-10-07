import { createBrowserCameraControls } from '../../../examples/browser-resources/camera-controls.ts';
import type { AuthorizationRequest, BrowserCameraActivation, BrowserCameraEnvironment, BrowserCameraFrame, BrowserCameraZoomFacts, Observation } from '@101/connect';

export const LOCAL_CAMERA_LIMITS = Object.freeze({ runs: 4, actions: 64, choices: 8, captureMs: 30000, reviewMs: 5000,
  commands: 16, maxHz: 2, maxAgeMs: 250, timerMs: 100, timerCallbacks: 360, timers: 1, frameBytes: 256 });
export type CameraAxis = 'zoom' | 'pan' | 'tilt';
export type CameraTaskReason = 'idle' | 'choice' | 'review' | 'opening' | 'active' | 'stopped' | 'hidden' | 'revoked' | 'closed' |
  'denied' | 'invalid' | 'busy' | 'quota' | 'expired' | 'lost' | 'unsupported' | 'unavailable' | 'cancelled' | 'cleanup-unconfirmed';
export type CameraTaskResult<T = undefined> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: CameraTaskReason }>;
export interface CameraChoice { readonly ordinal: number; readonly cameraChoice?: never }
export interface CameraCaptureReview { readonly ordinal: number; readonly expiresAt: number; readonly cameraCaptureReview?: never }
export interface CameraControlReview { readonly axis: CameraAxis; readonly facts: BrowserCameraZoomFacts; readonly expiresAt: number; readonly cameraControlReview?: never }
export interface CameraTaskSnapshot {
  readonly phase: 'idle' | 'inventory' | 'choice' | 'review' | 'opening' | 'active' | 'stopping' | 'stopped' | 'closed';
  readonly reason: CameraTaskReason; readonly runs: number; readonly actions: number;
  /** Pending actions/close barrier plus native acquisition/control returns; active frame callback shown separately. */
  readonly rawPending: number; readonly captureCallbacksPending: number; readonly cleanupUnconfirmed: boolean;
  readonly choices: readonly CameraChoice[]; readonly controls: readonly Readonly<{ axis: CameraAxis; facts: BrowserCameraZoomFacts }>[];
  readonly captureReview?: Readonly<{ handle: CameraCaptureReview; capture: boolean; source: boolean; preview: boolean }>;
  readonly controlReview?: Readonly<{ handle: CameraControlReview; control: boolean; source: boolean; target: boolean }>;
  readonly activeAxis?: CameraAxis; readonly reportedSetting?: number; readonly controlState: string;
  readonly previewVisible: boolean; readonly focusSupported: false; readonly exposureSupported: false;
  readonly owned: Readonly<{ callers: number; timers: number }>;
}
/** Cooperative trusted scheduling/preview observers; not a sandbox for lying host
 * factories or asynchronous output effects. Only the existing provider acquires
 * or owns tracks. Construction does not enumerate or acquire a camera. */
export interface CameraTaskOptions {
  readonly owner: AbortSignal; readonly now: () => number;
  readonly setTimer: (run: () => void, delay: number) => unknown; readonly clearTimer: (handle: unknown) => void;
  readonly environment?: BrowserCameraEnvironment; readonly onChange?: () => void;
  readonly onPreview?: (frame: BrowserCameraFrame | undefined) => void;
}
export interface LocalCameraTask {
  inventory(): Promise<CameraTaskResult<readonly CameraChoice[]>>;
  reviewCapture(choice: CameraChoice): CameraTaskResult<CameraCaptureReview>;
  approveCapture(review: CameraCaptureReview, part: 'capture' | 'source' | 'preview'): CameraTaskResult;
  start(review: CameraCaptureReview): Promise<CameraTaskResult>;
  reviewControl(axis: CameraAxis): CameraTaskResult<CameraControlReview>;
  approveControl(review: CameraControlReview, part: 'control' | 'source' | 'target'): CameraTaskResult;
  connectControl(review: CameraControlReview): CameraTaskResult; setSetting(value: number): CameraTaskResult;
  revokeCapture(part: 'capture' | 'source' | 'preview'): Promise<void>;
  isPreviewCurrent(): boolean; stop(reason?: 'stopped' | 'hidden' | 'revoked'): Promise<void>; close(): Promise<void>;
  snapshot(): CameraTaskSnapshot;
}
type Caller = ReturnType<typeof createBrowserCameraControls>;
type Selection = Parameters<Caller['activate']>[0];
type Pair = Readonly<{ source: AuthorizationRequest['source']; sink: AuthorizationRequest['sink'] }>;
interface ChoiceEntry { handle: CameraChoice; selection: Selection; expiresAt: number; run: Run }
interface CaptureEntry { handle: CameraCaptureReview; choice: ChoiceEntry; approved: Record<'capture' | 'source' | 'preview', boolean>;
  signals: Record<'capture' | 'source' | 'preview', AbortController>; expiresAt: number; pair?: Pair }
interface ControlEntry { handle: CameraControlReview; approved: Record<'control' | 'source' | 'target', boolean>;
  signals: Record<'control' | 'source' | 'target', AbortController>; expiresAt: number; pair?: Pair; bound: boolean }
interface Run {
  owner: AbortController; retired: boolean; constructing: boolean; constructed: ReturnType<typeof deferred<void>>;
  caller?: Caller; pending: Set<Promise<unknown>>; close?: Promise<void>; choices: ChoiceEntry[]; choiceExpiresAt: number; selectionExpiresAt: number;
  capture?: CaptureEntry; activation?: BrowserCameraActivation; control?: ControlEntry;
  controls: readonly Readonly<{ axis: CameraAxis; facts: BrowserCameraZoomFacts }>[];
  commands: number; timer?: unknown; timerPending: boolean; turns: number; preview?: Observation;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
const signalCurrent = (signal: AbortSignal) => { try { return Reflect.apply(aborted, signal, []) === false; } catch { return false; } };
const yes = <T>(value: T): CameraTaskResult<T> => Object.freeze({ ok: true, value });
const no = (reason: CameraTaskReason): CameraTaskResult<never> => Object.freeze({ ok: false, reason });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function sameRef(a: AuthorizationRequest['source'], b: AuthorizationRequest['source']) {
  return a.registrationId === b.registrationId && a.deviceId === b.deviceId && a.capabilityId === b.capabilityId && a.descriptorRevision === b.descriptorRevision && a.schemaVersion === b.schemaVersion;
}
const sameFacts = (a: BrowserCameraZoomFacts, b: BrowserCameraZoomFacts) => a.min === b.min && a.max === b.max && a.step === b.step && a.current === b.current;
const factsCopy = (facts: BrowserCameraZoomFacts): BrowserCameraZoomFacts => Object.freeze({ min: facts.min, max: facts.max, step: facts.step, current: facts.current });

export function createLocalCameraTask(options: CameraTaskOptions): LocalCameraTask {
  const owner = options.owner, now = options.now, setTimer = options.setTimer, clearTimer = options.clearTimer,
    onChange = options.onChange, onPreview = options.onPreview, environment = options.environment;
  let run: Run | undefined, runs = 0, actions = 0, lastAt = -Infinity, cleanupUnconfirmed = false, notifying = false;
  let phase: CameraTaskSnapshot['phase'] = 'idle', reason: CameraTaskReason = 'idle', closed = !signalCurrent(owner), closing: Promise<void> | undefined;
  const choices = new WeakMap<CameraChoice, ChoiceEntry>(), captures = new WeakMap<CameraCaptureReview, CaptureEntry>(), controls = new WeakMap<CameraControlReview, ControlEntry>();
  const emptyBarrier = Promise.resolve();
  function live(entry: Run) { return !closed && !entry.retired && run === entry && signalCurrent(owner) && signalCurrent(entry.owner.signal); }
  function emit() { if (notifying) return; notifying = true; try { onChange?.(); } catch { cleanupUnconfirmed = true; if (run) retire(run, 'cleanup-unconfirmed'); } finally { notifying = false; } }
  function time(): number | undefined {
    let at: unknown; try { at = now(); } catch { at = undefined; }
    if (typeof at !== 'number' || !Number.isFinite(at) || at < lastAt) { if (run) retire(run, 'invalid'); return; }
    lastAt = at; return at;
  }
  function admission(): CameraTaskReason | undefined {
    if (closed || !signalCurrent(owner)) return 'closed'; if (cleanupUnconfirmed) return 'cleanup-unconfirmed';
    if (actions >= LOCAL_CAMERA_LIMITS.actions) return 'quota'; actions++; return;
  }
  function consent(entry: Run, at: number, active = false): boolean {
    const capture = entry.capture;
    return live(entry) && !!capture && at < capture.expiresAt && (!active || !!entry.activation) &&
      capture.approved.capture && capture.approved.source && capture.approved.preview && Object.values(capture.signals).every(value => signalCurrent(value.signal));
  }
  function currentCapture(entry: Run): number | undefined {
    const source = entry.caller?.provider.snapshot(); const at = time();
    return at !== undefined && source?.phase === 'active' && source.activeSources === 1 && consent(entry, at, true) ? at : undefined;
  }
  function controlCurrent(entry: Run, review: ControlEntry, at: number): boolean {
    return consent(entry, at, true) && entry.control === review && at < review.expiresAt && (review.bound || at < review.handle.expiresAt) &&
      review.approved.control && review.approved.source && review.approved.target && Object.values(review.signals).every(value => signalCurrent(value.signal));
  }
  function clearPreview(entry: Run) {
    if (!entry.preview) return; entry.preview = undefined;
    try { onPreview?.(undefined); } catch { cleanupUnconfirmed = true; void retire(entry, 'cleanup-unconfirmed'); }
  }
  function cancelTimer(entry: Run) {
    if (!entry.timerPending) return; entry.timerPending = false; const token = entry.timer; entry.timer = undefined;
    try { clearTimer(token); } catch { cleanupUnconfirmed = true; }
  }
  function retire(entry: Run, why: CameraTaskReason): Promise<void> {
    if (entry.close) return entry.close;
    const done = deferred<void>(); entry.close = done.promise; entry.retired = true;
    if (run === entry) { phase = 'stopping'; reason = why; }
    cancelTimer(entry); clearPreview(entry);
    for (const signal of Object.values(entry.capture?.signals ?? {})) signal.abort();
    for (const signal of Object.values(entry.control?.signals ?? {})) signal.abort();
    entry.owner.abort(); try { entry.caller?.provider.stop(); } catch { cleanupUnconfirmed = true; }
    emit();
    void (async () => {
      try {
        await entry.constructed.promise;
        // A late real caller is still owned. Its true close includes native raw returns.
        try { if (entry.caller) await entry.caller.close(); }
        catch { cleanupUnconfirmed = true; if (entry.caller) await entry.caller.provider.close(); }
        while (entry.pending.size) await Promise.allSettled([...entry.pending]);
        if ((entry.caller?.provider.snapshot().cleanupFailures ?? 0) > 0) cleanupUnconfirmed = true;
      } catch { cleanupUnconfirmed = true; }
      finally {
        while (entry.pending.size) await Promise.allSettled([...entry.pending]);
        let pending = true;
        try { const native = entry.caller?.provider.snapshot(), control = entry.caller?.provider.controlStatus();
          pending = (native?.rawPending ?? 0) > 0 || (native?.framePending ?? 0) > 0 || (control?.rawPending ?? 0) > 0;
        } catch { cleanupUnconfirmed = true; }
        if (pending) { cleanupUnconfirmed = true; reason = 'cleanup-unconfirmed'; emit(); }
        else { if (run === entry) { run = undefined; phase = closed ? 'closed' : 'stopped'; if (cleanupUnconfirmed) reason = 'cleanup-unconfirmed'; } done.resolve(); emit(); }
      }
    })(); return done.promise;
  }
  function grantPair(entry: Run, request: Readonly<AuthorizationRequest>) {
    if (request.principalId !== 'camera-control-owner' || request.applicationId !== 'camera-controls-example' || request.sessionId !== 'camera-controls-session' || request.sourceOperation !== 'subscribe' || request.partition !== undefined) return;
    const capture = entry.capture, control = entry.control;
    const frame = request.source.capabilityId === 'camera-frame' && request.sink.capabilityId === 'camera-frame' && request.sinkOperation === 'write';
    const setting = !!control && request.source.capabilityId === 'camera-' + control.handle.axis && request.sink.capabilityId === 'camera-' + control.handle.axis && request.sinkOperation === 'invoke';
    const selected = frame ? capture : setting ? control : undefined; if (!selected) return;
    const prior = selected.pair; if (prior && (!sameRef(prior.source, request.source) || !sameRef(prior.sink, request.sink))) return;
    const at = time(); if (at === undefined || !consent(entry, at) || setting && (!control || !controlCurrent(entry, control, at))) return;
    // Bind exact issued registration/revision/schema tuple once within this private caller.
    selected.pair ??= Object.freeze({ source: Object.freeze({ ...request.source }), sink: Object.freeze({ ...request.sink }) });
    return { expiresAt: Math.min(capture!.expiresAt, selected.expiresAt), maxAgeMs: 250, maxHz: frame ? 10 : 2 };
  }
  function begin(): Run | undefined {
    if (run || runs >= LOCAL_CAMERA_LIMITS.runs) return;
    const entry: Run = { owner: new AbortController(), retired: false, constructing: true, constructed: deferred<void>(), pending: new Set(), choices: [], choiceExpiresAt: -Infinity, selectionExpiresAt: -Infinity, controls: Object.freeze([]), commands: 0, turns: 0, timerPending: false };
    run = entry; runs++; phase = 'inventory'; reason = 'choice'; emit();
    try {
      if (!live(entry)) return entry;
      const caller = createBrowserCameraControls({ ownerSignal: entry.owner.signal, routeLeaseMs: 30000, now: () => time() ?? NaN,
        ...(environment ? { environment } : {}),
        authorizeCapture(request) {
          const capture = entry.capture;
          if (!capture || phase !== 'opening' || request.purpose !== 'reviewed-camera-raster' || request.principalId !== 'camera-control-owner' || request.applicationId !== 'camera-controls-example' || request.sessionId !== 'camera-controls-session' || request.capabilityId !== 'camera-frame' || request.operation !== 'subscribe') return;
          const at = time(); if (at === undefined || !consent(entry, at)) return;
          return { request, signal: capture.signals.capture.signal, expiresAt: capture.expiresAt };
        },
        authorizeControl(request) {
          const selected = entry.control;
          if (!selected || !entry.activation || request.principalId !== 'camera-control-owner' || request.applicationId !== 'camera-controls-example' || request.sessionId !== 'camera-controls-session' || request.purpose !== 'reviewed-camera-api-' + selected.handle.axis || request.deviceId !== entry.activation.device.id || request.captureExpiresAt !== entry.capture?.expiresAt || request.activation !== entry.activation || request.selectionGeneration !== entry.activation.selectionGeneration || request.capabilityId !== 'camera-' + selected.handle.axis || request.operation !== 'invoke' || !sameFacts(request.facts, selected.handle.facts)) return;
          const at = time(); if (at === undefined || !controlCurrent(entry, selected, at)) return;
          return { request, signal: selected.signals.control.signal, expiresAt: selected.expiresAt };
        }, authorizeRoutes: request => grantPair(entry, request) });
      entry.caller = caller;
      if (!live(entry)) void retire(entry, 'cancelled');
    } catch { cleanupUnconfirmed = true; void retire(entry, 'cleanup-unconfirmed'); }
    finally { entry.constructing = false; entry.constructed.resolve(); }
    return entry;
  }
  function reserve<T>(entry: Run) {
    const done = deferred<CameraTaskResult<T>>(); entry.pending.add(done.promise);
    return { promise: done.promise, finish(value: CameraTaskResult<T>) {
      entry.pending.delete(done.promise); emit(); let delivered = value;
      if (value.ok) { const at = entry.activation ? currentCapture(entry) : time();
        if (!live(entry) || at === undefined) delivered = no('cancelled');
        else if (!entry.activation && at >= entry.choiceExpiresAt) { delivered = no('expired'); void retire(entry, 'expired'); }
      } done.resolve(delivered);
    } };
  }
  function arm(entry: Run) {
    if (!live(entry) || entry.timerPending) return;
    if (entry.turns >= LOCAL_CAMERA_LIMITS.timerCallbacks) { void retire(entry, 'quota'); return; }
    entry.timerPending = true;
    try { const token = setTimer(() => {
      if (!entry.timerPending) return; entry.timerPending = false; entry.timer = undefined; entry.turns++; tick(entry);
    }, 100); if (!live(entry) || !entry.timerPending) { clearTimer(token); return; } entry.timer = token; }
    catch { cleanupUnconfirmed = true; void retire(entry, 'cleanup-unconfirmed'); }
  }
  function readControls(entry: Run): boolean {
    const report = entry.caller?.report(); if (!report?.ok || currentCapture(entry) === undefined) return false;
    const supported: { axis: CameraAxis; facts: BrowserCameraZoomFacts }[] = [];
    for (const axis of ['zoom', 'pan', 'tilt'] as const) { const value = report.value[axis]; if (typeof value === 'object' && value.state === 'reported') supported.push(Object.freeze({ axis, facts: factsCopy(value) })); }
    const at = currentCapture(entry); if (at === undefined) return false; entry.controls = Object.freeze(supported); return true;
  }
  function show(entry: Run) {
    const latest = entry.caller?.state().latest, at = currentCapture(entry);
    if (at === undefined) { void retire(entry, 'lost'); return; }
    if (!latest || latest.clockDomain !== 'camera-controls-js-retrieval' || latest.quality !== 'valid' || !Number.isFinite(latest.timestamp) || latest.timestamp > at || at - latest.timestamp > 250) { clearPreview(entry); return; }
    if (latest === entry.preview) return;
    entry.preview = latest;
    try { onPreview?.(latest.value as unknown as BrowserCameraFrame); }
    catch { cleanupUnconfirmed = true; void retire(entry, 'cleanup-unconfirmed'); return; }
    const after = currentCapture(entry); if (after === undefined || after - latest.timestamp > 250) clearPreview(entry);
  }
  function tick(entry: Run) {
    if (!live(entry)) return;
    const at = time(); if (at === undefined || !live(entry)) return;
    const deadline = entry.capture && (entry.activation || phase === 'opening') ? entry.capture.expiresAt : entry.choiceExpiresAt;
    if (at >= deadline) { void retire(entry, 'expired'); return; }
    if (entry.activation) {
      try { entry.caller!.provider.sweep(); entry.caller!.tick(); }
      catch { void retire(entry, 'unavailable'); return; }
      if (currentCapture(entry) === undefined) { void retire(entry, 'lost'); return; }
      show(entry);
    }
    emit(); arm(entry);
  }
  async function inventory(): Promise<CameraTaskResult<readonly CameraChoice[]>> {
    const rejected = admission(); if (rejected) return no(rejected);
    if (run) return no('busy'); if (runs >= LOCAL_CAMERA_LIMITS.runs) return no('quota');
    const entry = begin(); if (!entry) return no('busy'); const work = reserve<readonly CameraChoice[]>(entry);
    void (async () => {
      let result: CameraTaskResult<readonly CameraChoice[]> = no('cancelled');
      try { const issued = time(); if (issued === undefined || !live(entry) || !entry.caller) return;
        entry.choiceExpiresAt = issued + 5000; entry.selectionExpiresAt = issued + 30000; const found = await entry.caller.provider.inspect();
        const at = time(); if (!live(entry) || at === undefined) return;
        if (!found.ok) { const why = found.reason === 'unfocused' ? 'unavailable' : found.reason; result = no(why); void retire(entry, why); return; }
        if (at >= entry.choiceExpiresAt) { result = no('expired'); void retire(entry, 'expired'); return; }
        entry.choices = found.value.slice(0, 8).map(item => { const handle = Object.freeze({ ordinal: item.ordinal });
          const choice = { handle, selection: item.selection, expiresAt: entry.choiceExpiresAt, run: entry }; choices.set(handle, choice); return choice; });
        phase = 'choice'; reason = 'choice'; result = yes(Object.freeze(entry.choices.map(item => item.handle))); arm(entry);
      } catch { result = no('unavailable'); void retire(entry, 'unavailable'); }
      finally { work.finish(result); }
    })(); return work.promise;
  }
  function reviewCapture(handle: CameraChoice): CameraTaskResult<CameraCaptureReview> {
    const rejected = admission(); if (rejected) return no(rejected);
    const selected = choices.get(handle), entry = run, at = time();
    if (!entry || !selected || selected.run !== entry || !live(entry) || at === undefined || entry.activation || phase === 'inventory' || phase === 'opening') return no('denied');
    if (at >= selected.expiresAt) { void retire(entry, 'expired'); return no('expired'); }
    for (const value of Object.values(entry.capture?.signals ?? {})) value.abort();
    const review = Object.freeze({ ordinal: handle.ordinal, expiresAt: selected.expiresAt });
    const capture: CaptureEntry = { handle: review, choice: selected, approved: { capture: false, source: false, preview: false }, signals: { capture: new AbortController(), source: new AbortController(), preview: new AbortController() }, expiresAt: -Infinity };
    entry.capture = capture; captures.set(review, capture); phase = 'review'; reason = 'review'; emit(); const after = time();
    return after !== undefined && live(entry) && entry.capture === capture && after < review.expiresAt ? yes(review) : no('cancelled');
  }
  function approveCapture(handle: CameraCaptureReview, part: 'capture' | 'source' | 'preview'): CameraTaskResult {
    const rejected = admission(); if (rejected) return no(rejected); const capture = captures.get(handle), entry = run, at = time();
    if (!entry || !capture || entry.capture !== capture || !live(entry) || at === undefined || !['capture', 'source', 'preview'].includes(part) || phase !== 'review') return no('denied');
    if (at >= handle.expiresAt) return no('expired');
    if (capture.expiresAt === -Infinity) capture.expiresAt = Math.min(at + 30000, entry.selectionExpiresAt);
    if (at >= capture.expiresAt || !signalCurrent(capture.signals[part].signal)) return no('expired');
    capture.approved[part] = true; emit(); const after = time();
    return after !== undefined && live(entry) && entry.capture === capture && after < handle.expiresAt && after < capture.expiresAt && signalCurrent(capture.signals[part].signal) ? yes(undefined) : no('cancelled');
  }
  function start(handle: CameraCaptureReview): Promise<CameraTaskResult> {
    const rejected = admission(); if (rejected) return Promise.resolve(no(rejected));
    const entry = run, capture = captures.get(handle), at = time();
    if (!entry || !capture || entry.capture !== capture || at === undefined || phase !== 'review' || !entry.caller) return Promise.resolve(no('denied'));
    if (at >= handle.expiresAt || at >= capture.expiresAt && capture.expiresAt !== -Infinity) { void retire(entry, 'expired'); return Promise.resolve(no('expired')); }
    if (!consent(entry, at)) return Promise.resolve(no('denied'));
    const work = reserve<undefined>(entry); phase = 'opening'; reason = 'opening'; emit();
    void (async () => { let result: CameraTaskResult = no('cancelled');
      try { if (!live(entry)) return; const active = await entry.caller!.activate(capture.choice.selection);
        const after = time(); if (!live(entry) || after === undefined || !consent(entry, after)) return;
        if (!active.ok) { const why = active.reason === 'unfocused' ? 'unavailable' : active.reason; result = no(why); void retire(entry, why); return; }
        entry.activation = active.value;
        if (!readControls(entry)) { result = no('lost'); void retire(entry, 'lost'); return; }
        phase = 'active'; reason = 'active'; arm(entry); result = yes(undefined);
      } catch { result = no('unavailable'); void retire(entry, 'unavailable'); }
      finally { work.finish(result); }
    })(); return work.promise;
  }
  function reviewControl(axis: CameraAxis): CameraTaskResult<CameraControlReview> {
    const rejected = admission(); if (rejected) return no(rejected); const entry = run;
    if (!entry || entry.control?.bound || phase !== 'active' || !['zoom', 'pan', 'tilt'].includes(axis) || !readControls(entry)) return no('denied');
    const selected = entry.controls.find(item => item.axis === axis), at = currentCapture(entry); if (!selected || at === undefined) return no('unsupported');
    for (const signal of Object.values(entry.control?.signals ?? {})) signal.abort();
    const handle = Object.freeze({ axis, facts: selected.facts, expiresAt: Math.min(entry.capture!.expiresAt, at + 5000) });
    const review: ControlEntry = { handle, expiresAt: -Infinity, approved: { control: false, source: false, target: false }, signals: { control: new AbortController(), source: new AbortController(), target: new AbortController() }, bound: false };
    entry.control = review; controls.set(handle, review); emit(); const after = currentCapture(entry);
    return after !== undefined && entry.control === review && after < handle.expiresAt ? yes(handle) : no('cancelled');
  }
  function approveControl(handle: CameraControlReview, part: 'control' | 'source' | 'target'): CameraTaskResult {
    const rejected = admission(); if (rejected) return no(rejected); const entry = run, review = controls.get(handle), at = entry ? currentCapture(entry) : undefined;
    if (!entry || !review || entry.control !== review || review.bound || at === undefined || !['control', 'source', 'target'].includes(part)) return no('denied');
    if (at >= handle.expiresAt || !signalCurrent(review.signals[part].signal)) return no('expired');
    if (review.expiresAt === -Infinity) review.expiresAt = Math.min(entry.capture!.expiresAt, at + 30000);
    if (at >= review.expiresAt) return no('expired'); review.approved[part] = true; emit();
    const after = currentCapture(entry); return after !== undefined && entry.control === review && after < handle.expiresAt && after < review.expiresAt && signalCurrent(review.signals[part].signal) ? yes(undefined) : no('cancelled');
  }
  function connectControl(handle: CameraControlReview): CameraTaskResult {
    const rejected = admission(); if (rejected) return no(rejected); const entry = run, review = controls.get(handle), at = entry ? currentCapture(entry) : undefined;
    if (!entry || !review || review.bound || !entry.caller || at === undefined || !controlCurrent(entry, review, at)) return no('denied');
    const bound = handle.axis === 'zoom' ? entry.caller.connectZoom() : handle.axis === 'pan' ? entry.caller.connectPan() : entry.caller.connectTilt();
    if (!bound.ok) return no(bound.reason === 'unfocused' ? 'unavailable' : bound.reason);
    const capability = bound.value.device.capabilities[0], value = capability?.value;
    const matches = bound.value.device.capabilities.length === 1 && capability?.id === 'camera-' + handle.axis && capability.semantic === 'media:camera-' + handle.axis + '-setting/1' && capability.permissions.includes('invoke') && value?.type === 'scalar' && value.unit === '1' && value.min === handle.facts.min && value.max === handle.facts.max && value.resolution === handle.facts.step;
    const after = currentCapture(entry);
    if (!matches || after === undefined || !controlCurrent(entry, review, after)) { void retire(entry, 'lost'); return no('cancelled'); }
    review.bound = true; emit(); const finalAt = currentCapture(entry);
    return finalAt !== undefined && controlCurrent(entry, review, finalAt) ? yes(undefined) : no('cancelled');
  }
  function setSetting(value: number): CameraTaskResult {
    const rejected = admission(); if (rejected) return no(rejected); const entry = run, review = entry?.control, at = entry ? currentCapture(entry) : undefined;
    if (!entry || !entry.caller || !review?.bound || at === undefined || !controlCurrent(entry, review, at) || entry.commands >= 16) return no('denied');
    const facts = review.handle.facts; if (typeof value !== 'number' || !Number.isFinite(value) || value < facts.min || value > facts.max) return no('invalid');
    const position = (value - facts.min) / facts.step;
    if (Math.abs(position - Math.round(position)) > Number.EPSILON * 8 * Math.max(1, Math.abs(position))) return no('invalid');
    entry.commands++; const deadline = Math.min(at + 250, review.expiresAt, entry.capture!.expiresAt);
    const result = review.handle.axis === 'zoom' ? entry.caller.setZoom(value, deadline) : review.handle.axis === 'pan' ? entry.caller.setPan(value, deadline) : entry.caller.setTilt(value, deadline);
    emit(); const after = currentCapture(entry); return after !== undefined && controlCurrent(entry, review, after) && result.ok ? yes(undefined) : no('denied');
  }
  function isPreviewCurrent() { const entry = run, at = entry ? currentCapture(entry) : undefined; return !!entry?.preview && at !== undefined && at - entry.preview.timestamp <= 250; }
  function stop(why: 'stopped' | 'hidden' | 'revoked' = 'stopped') { if (run) return retire(run, why); if (!closed) { phase = 'stopped'; reason = why; } return emptyBarrier; }
  function close(): Promise<void> {
    if (closing) return closing; const done = deferred<void>(); closing = done.promise; closed = true;
    try { Reflect.apply(remove, owner, ['abort', ownerClosed]); } catch { cleanupUnconfirmed = true; }
    const barrier = run ? retire(run, 'closed') : emptyBarrier; phase = run ? 'stopping' : 'closed'; reason = 'closed';
    void barrier.then(() => { phase = 'closed'; done.resolve(); emit(); }); return done.promise;
  }
  function ownerClosed() { void close(); }
  if (closed) { phase = 'closed'; reason = 'closed'; }
  else Reflect.apply(add, owner, ['abort', ownerClosed, { once: true }]);
  return Object.freeze({ inventory, reviewCapture, approveCapture, start, reviewControl, approveControl, connectControl, setSetting,
    revokeCapture(part: 'capture' | 'source' | 'preview') { if (run?.capture && ['capture', 'source', 'preview'].includes(part)) run.capture.signals[part].abort(); return stop('revoked'); },
    isPreviewCurrent, stop, close,
    snapshot(): CameraTaskSnapshot {
      const entry = run, native = entry?.caller?.provider.snapshot(), status = entry?.caller?.provider.controlStatus();
      const active = !!entry && !entry.retired;
      return Object.freeze({ phase, reason, runs, actions, rawPending: (entry?.pending.size ?? 0) + Number(entry?.constructing === true) + Number(entry?.close !== undefined) + (native?.rawPending ?? 0) + (status?.rawPending ?? 0), captureCallbacksPending: native?.framePending ?? 0, cleanupUnconfirmed,
        choices: Object.freeze(active ? entry.choices.map(item => item.handle) : []), controls: active ? entry.controls : Object.freeze([]),
        ...(active && entry.capture ? { captureReview: Object.freeze({ handle: entry.capture.handle, ...entry.capture.approved }) } : {}),
        ...(active && entry.control ? { controlReview: Object.freeze({ handle: entry.control.handle, ...entry.control.approved }) } : {}),
        ...(active && entry.control?.bound ? { activeAxis: entry.control.handle.axis } : {}),
        ...(active && status?.state === 'api-returned' && status.reportedSetting !== undefined ? { reportedSetting: status.reportedSetting } : {}),
        controlState: status?.state ?? 'idle', previewVisible: !!entry?.preview, focusSupported: false, exposureSupported: false,
        owned: Object.freeze({ callers: Number(entry?.caller !== undefined), timers: Number(entry?.timerPending === true) }) });
    } });
}
