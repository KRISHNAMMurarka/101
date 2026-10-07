import { createBrowserScreenPreviewPipeline } from '../../../examples/browser-resources/screen-preview.ts';
import type { AuthorizationRequest, BrowserScreenPreviewCaptureRequest, BrowserScreenPreviewEnvironment, BrowserScreenPreviewFacts, Observation } from '@101/connect';

export const LOCAL_SCREEN_LIMITS = Object.freeze({ runs: 4, actions: 64, reviewMs: 5000, captureMs: 10000,
  timerMs: 100, timerCallbacks: 160, timers: 1, frameBytes: 256, maxAgeMs: 250, maxHz: 10 });
export type ScreenTaskReason = 'idle' | 'review' | 'opening' | 'capturing' | 'waiting' | 'stopped' | 'closed' |
  'invalid' | 'unsupported' | 'unavailable' | 'denied' | 'busy' | 'lost' | 'hidden' | 'unfocused' | 'expired' |
  'cancelled' | 'quota' | 'gesture-required' | 'changed' | 'revoked' | 'cleanup-unconfirmed';
export type ScreenTaskResult<T = undefined> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: ScreenTaskReason }>;
export interface ScreenReview { readonly expiresAt: number; readonly screenReview?: never }
export interface ScreenTaskSnapshot {
  readonly phase: 'idle' | 'review' | 'opening' | 'capturing' | 'waiting' | 'stopping' | 'stopped' | 'closed';
  readonly reason: ScreenTaskReason; readonly runs: number; readonly actions: number;
  readonly previewVisible: boolean; readonly capturePresent: boolean; readonly facts?: BrowserScreenPreviewFacts;
  readonly review?: Readonly<{ handle: ScreenReview; capture: boolean; source: boolean; display: boolean }>;
  readonly rawPending: number; readonly framePending: number; readonly cleanupUnconfirmed: boolean;
  readonly owned: Readonly<{ pipelines: number; timers: number }>;
}
/** Cooperative trusted clock, scheduler, observers and exact owned output only.
 * The existing provider exclusively owns capture. Construction never reads pixels
 * or invokes capture. A source-ready phase does not establish an active display.
 * Returned-work settlement does not certify native internal quiescence. */
export interface ScreenTaskOptions {
  readonly owner: AbortSignal; readonly now: () => number; readonly preview: HTMLCanvasElement;
  readonly setTimer: (run: () => void, delay: number) => unknown; readonly clearTimer: (handle: unknown) => void;
  readonly environment?: BrowserScreenPreviewEnvironment; readonly onChange?: () => void;
}
export interface LocalScreenTask {
  review(): ScreenTaskResult<ScreenReview>; approve(handle: ScreenReview, part: 'capture' | 'source' | 'display'): ScreenTaskResult;
  start(handle: ScreenReview): Promise<ScreenTaskResult>; revoke(part: 'capture' | 'source' | 'display'): Promise<void>;
  stop(reason?: 'stopped' | 'hidden' | 'revoked'): Promise<void>; close(): Promise<void>; snapshot(): ScreenTaskSnapshot;
}
type Pipeline = ReturnType<typeof createBrowserScreenPreviewPipeline>;
type Part = 'capture' | 'source' | 'display';
interface Run {
  owner: AbortController; handle?: ScreenReview; approved: Record<Part, boolean>; signals: Record<Part, AbortController>;
  reviewExpiresAt: number; expiresAt: number; retired: boolean; constructed: ReturnType<typeof deferred<void>>; constructing: boolean;
  pipeline?: Pipeline; pending: Set<Promise<unknown>>; closing?: Promise<void>; closeSettled: boolean;
  request?: BrowserScreenPreviewCaptureRequest; pair?: Readonly<{ source: AuthorizationRequest['source']; sink: AuthorizationRequest['sink'] }>;
  facts?: BrowserScreenPreviewFacts; timerPending: boolean; timer?: unknown; turns: number; visible: boolean;
}
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const signalAdd = EventTarget.prototype.addEventListener, signalRemove = EventTarget.prototype.removeEventListener;
const signalCurrent = (signal: AbortSignal) => { try { return Reflect.apply(nativeAborted, signal, []) === false; } catch { return false; } };
const yes = <T>(value: T): ScreenTaskResult<T> => Object.freeze({ ok: true, value });
const no = (reason: ScreenTaskReason): ScreenTaskResult<never> => Object.freeze({ ok: false, reason });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function sameRef(a: AuthorizationRequest['source'], b: AuthorizationRequest['source']) {
  return a.registrationId === b.registrationId && a.deviceId === b.deviceId && a.capabilityId === b.capabilityId && a.descriptorRevision === b.descriptorRevision && a.schemaVersion === b.schemaVersion;
}

export function createLocalScreenTask(options: ScreenTaskOptions): LocalScreenTask {
  const owner = options.owner, now = options.now, preview = options.preview, environment = options.environment,
    setTimer = options.setTimer, clearTimer = options.clearTimer, onChange = options.onChange;
  let run: Run | undefined, runs = 0, actions = 0, lastAt = -Infinity, cleanupUnconfirmed = false, notifying = false;
  let closed = !signalCurrent(owner), closing: Promise<void> | undefined;
  let phase: ScreenTaskSnapshot['phase'] = closed ? 'closed' : 'idle', reason: ScreenTaskReason = closed ? 'closed' : 'idle';
  const handles = new WeakMap<ScreenReview, Run>(), emptyBarrier = Promise.resolve();
  function live(entry: Run) { return !closed && run === entry && !entry.retired && signalCurrent(owner) && signalCurrent(entry.owner.signal); }
  function emit() { if (notifying) return; notifying = true;
    try { onChange?.(); } catch { cleanupUnconfirmed = true; if (run) void retire(run, 'cleanup-unconfirmed'); }
    finally { notifying = false; }
  }
  function time(): number | undefined {
    let at: unknown; try { at = now(); } catch { at = undefined; }
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 10000 || at < lastAt) { if (run) void retire(run, 'invalid'); return; }
    lastAt = at; return at;
  }
  function admission(): ScreenTaskReason | undefined {
    if (closed || !signalCurrent(owner)) return 'closed'; if (cleanupUnconfirmed) return 'cleanup-unconfirmed';
    if (actions >= LOCAL_SCREEN_LIMITS.actions) return 'quota'; actions++; return;
  }
  function consent(entry: Run, at: number) { return live(entry) && at < entry.expiresAt && entry.approved.capture && entry.approved.source && entry.approved.display &&
    signalCurrent(entry.signals.capture.signal) && signalCurrent(entry.signals.source.signal) && signalCurrent(entry.signals.display.signal); }
  function clearOutput(entry: Run) {
    entry.visible = false;
    try { const context = preview.getContext('2d'); if (!context) throw Error('Owned preview context missing'); context.clearRect(0, 0, 8, 8); }
    catch { cleanupUnconfirmed = true; }
  }
  function cancelTimer(entry: Run) {
    if (!entry.timerPending) return; entry.timerPending = false; const token = entry.timer; entry.timer = undefined;
    try { clearTimer(token); } catch { cleanupUnconfirmed = true; }
  }
  function retire(entry: Run, why: ScreenTaskReason): Promise<void> {
    if (entry.closing) return entry.closing;
    const done = deferred<void>(); entry.closing = done.promise; entry.retired = true;
    if (run === entry) { phase = 'stopping'; reason = why; }
    cancelTimer(entry); clearOutput(entry);
    for (const value of Object.values(entry.signals)) value.abort(); entry.owner.abort();
    try { entry.pipeline?.stop(); } catch { cleanupUnconfirmed = true; }
    emit();
    void (async () => {
      try {
        await entry.constructed.promise;
        // Always await true owned work, even if a display/observer/stop failed.
        try { if (entry.pipeline) await entry.pipeline.close(); }
        catch { cleanupUnconfirmed = true; if (entry.pipeline) await entry.pipeline.provider.close(); }
      } catch { cleanupUnconfirmed = true; }
      finally {
        while (entry.pending.size) await Promise.allSettled([...entry.pending]);
        let clean = false;
        try { const actual = entry.pipeline?.provider.snapshot();
          if ((actual?.cleanupFailures ?? 0) > 0) cleanupUnconfirmed = true;
          clean = (actual?.rawPending ?? 0) === 0 && (actual?.framePending ?? 0) === 0;
          if (!clean) cleanupUnconfirmed = true;
        } catch { cleanupUnconfirmed = true; }
        entry.closeSettled = true;
        // Unconfirmed native cleanup remains retained and quarantined; never
        // zero its reservation merely because logical authority was retired.
        if (run === entry) { if (clean) run = undefined; phase = closed ? 'closed' : 'stopped'; if (cleanupUnconfirmed) reason = 'cleanup-unconfirmed'; }
        done.resolve(); emit();
      }
    })(); return done.promise;
  }
  function previewCurrent(entry: Run, latest: Observation | undefined, at: number) {
    return consent(entry, at) && !!latest && latest.quality === 'valid' && latest.clockDomain === 'screen-javascript-retrieval' &&
      typeof latest.timestamp === 'number' && Number.isFinite(latest.timestamp) && latest.timestamp <= at && at - latest.timestamp <= 250;
  }
  function refresh(entry: Run): boolean {
    if (!live(entry)) return false;
    let native: ReturnType<Pipeline['provider']['snapshot']>, latest: Observation | undefined;
    try { native = entry.pipeline!.provider.snapshot(); latest = entry.pipeline!.state().latest; }
    catch { cleanupUnconfirmed = true; void retire(entry, 'cleanup-unconfirmed'); return false; }
    const at = time(); if (at === undefined || !live(entry)) return false;
    if (!consent(entry, at)) { void retire(entry, at >= entry.expiresAt ? 'expired' : 'revoked'); return false; }
    if (native.cleanupFailures > 0) { cleanupUnconfirmed = true; void retire(entry, 'cleanup-unconfirmed'); return false; }
    if (native.activeSources !== 1) { void retire(entry, native.reason === 'idle' || native.reason === 'active' ? 'lost' : native.reason); return false; }
    const visible = previewCurrent(entry, latest, at); entry.visible = visible;
    if (!visible) clearOutput(entry);
    // The independent clear is a trusted synchronous callout: fence again.
    const finalAt = time(); if (cleanupUnconfirmed) { void retire(entry, 'cleanup-unconfirmed'); return false; }
    if (finalAt === undefined || !consent(entry, finalAt)) { if (live(entry)) void retire(entry, finalAt !== undefined && finalAt >= entry.expiresAt ? 'expired' : 'revoked'); return false; }
    entry.visible = previewCurrent(entry, latest, finalAt);
    if (!entry.visible && visible) {
      clearOutput(entry); const clearedAt = time();
      if (cleanupUnconfirmed || clearedAt === undefined || !consent(entry, clearedAt)) {
        if (live(entry)) void retire(entry, cleanupUnconfirmed ? 'cleanup-unconfirmed' : clearedAt !== undefined && clearedAt >= entry.expiresAt ? 'expired' : 'revoked');
        return false;
      }
    }
    if (live(entry)) { phase = entry.visible ? 'capturing' : 'waiting'; reason = entry.visible ? 'capturing' : 'waiting'; }
    return live(entry);
  }
  function arm(entry: Run) {
    if (!live(entry) || entry.timerPending) return;
    if (entry.turns >= LOCAL_SCREEN_LIMITS.timerCallbacks) { void retire(entry, 'quota'); return; }
    entry.timerPending = true;
    try { const token = setTimer(() => { if (!entry.timerPending) return; entry.timerPending = false; entry.timer = undefined; entry.turns++; tick(entry); }, 100);
      if (!live(entry) || !entry.timerPending) { clearTimer(token); return; } entry.timer = token;
    } catch { cleanupUnconfirmed = true; void retire(entry, 'cleanup-unconfirmed'); }
  }
  function tick(entry: Run) {
    if (!live(entry)) return; const at = time(); if (at === undefined || !live(entry)) return;
    if (at >= (phase === 'review' ? entry.reviewExpiresAt : entry.expiresAt)) { void retire(entry, 'expired'); return; }
    if (entry.pipeline && phase !== 'opening') {
      try { entry.pipeline.provider.sweep(); entry.pipeline.tick(); } catch { void retire(entry, 'unavailable'); return; }
      if (!refresh(entry)) return;
    }
    emit(); arm(entry);
  }
  function review(): ScreenTaskResult<ScreenReview> {
    const rejected = admission(); if (rejected) return no(rejected); if (run) return no('busy'); if (runs >= 4) return no('quota');
    const constructed = deferred<void>(); constructed.resolve();
    const entry: Run = { owner: new AbortController(), approved: { capture: false, source: false, display: false },
      signals: { capture: new AbortController(), source: new AbortController(), display: new AbortController() }, reviewExpiresAt: -Infinity, expiresAt: -Infinity,
      retired: false, constructing: false, constructed, pending: new Set(), closeSettled: false, timerPending: false, turns: 0, visible: false };
    run = entry; runs++; phase = 'review'; reason = 'review';
    const at = time(); if (at === undefined || !live(entry)) return no('cancelled');
    const handle = Object.freeze({ expiresAt: at + 5000 }); entry.handle = handle; entry.reviewExpiresAt = handle.expiresAt; handles.set(handle, entry);
    arm(entry); emit(); const after = time(); return after !== undefined && live(entry) && after < handle.expiresAt ? yes(handle) : no('cancelled');
  }
  function approve(handle: ScreenReview, part: Part): ScreenTaskResult {
    const rejected = admission(); if (rejected) return no(rejected); const entry = handles.get(handle), at = time();
    if (!entry || run !== entry || !live(entry) || phase !== 'review' || at === undefined || !['capture', 'source', 'display'].includes(part)) return no('denied');
    if (at >= handle.expiresAt) { void retire(entry, 'expired'); return no('expired'); }
    if (entry.expiresAt === -Infinity) entry.expiresAt = at + 10000;
    if (at >= entry.expiresAt || !signalCurrent(entry.signals[part].signal)) return no('expired');
    entry.approved[part] = true; emit(); const after = time();
    return after !== undefined && live(entry) && after < handle.expiresAt && after < entry.expiresAt && signalCurrent(entry.signals[part].signal) ? yes(undefined) : no('cancelled');
  }
  function start(handle: ScreenReview): Promise<ScreenTaskResult> {
    const rejected = admission(); if (rejected) return Promise.resolve(no(rejected)); const entry = handles.get(handle), at = time();
    if (!entry || run !== entry || phase !== 'review' || at === undefined) return Promise.resolve(no('denied'));
    if (at >= handle.expiresAt || entry.expiresAt !== -Infinity && at >= entry.expiresAt) { void retire(entry, 'expired'); return Promise.resolve(no('expired')); }
    if (!consent(entry, at)) return Promise.resolve(no('denied'));
    const done = deferred<ScreenTaskResult>(); entry.pending.add(done.promise); entry.constructing = true; entry.constructed = deferred<void>(); phase = 'opening'; reason = 'opening'; emit();
    void (async () => {
      let result: ScreenTaskResult = no('cancelled');
      try {
        const before = time(); if (before === undefined || !consent(entry, before)) return;
        const pipeline = createBrowserScreenPreviewPipeline({ ownerSignal: entry.owner.signal, preview, now: () => time() ?? NaN,
          ...(environment ? { environment } : {}),
          authorizeCapture(request) {
            if (phase !== 'opening' || request.principalId !== 'screen-owner' || request.applicationId !== 'screen-example' || request.sessionId !== 'screen-session' || request.purpose !== 'selected-local-screen-preview' || request.profile !== 'browser-screen-preview/1' || request.capabilityId !== 'screen-preview' || request.operation !== 'subscribe' || request.capture.video !== true || request.capture.audio !== false) return;
            const current = time(); if (current === undefined || !consent(entry, current)) return;
            if (entry.request && entry.request !== request) return; entry.request = request;
            return { request, signal: entry.signals.capture.signal, expiresAt: entry.expiresAt };
          },
          authorizeRoutes(request) {
            const issued = entry.request;
            if (!issued || request.principalId !== 'screen-owner' || request.applicationId !== 'screen-example' || request.sessionId !== 'screen-session' || request.partition !== undefined || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || request.source.capabilityId !== 'screen-preview' || request.sink.capabilityId !== 'screen-preview' || request.source.deviceId !== issued.deviceId || request.sink.deviceId !== issued.deviceId + ':preview') return;
            const prior = entry.pair; if (prior && (!sameRef(prior.source, request.source) || !sameRef(prior.sink, request.sink))) return;
            const current = time(); if (current === undefined || !consent(entry, current)) return;
            entry.pair ??= Object.freeze({ source: Object.freeze({ ...request.source }), sink: Object.freeze({ ...request.sink }) });
            return { expiresAt: entry.expiresAt, maxAgeMs: 250, maxHz: 10 };
          } });
        entry.pipeline = pipeline;
        const ready = time(); if (ready === undefined || !consent(entry, ready)) return;
        // Synchronous issuance in the explicit Start gesture; no await before it.
        const opening = pipeline.activate('selected-local-screen-preview'); entry.constructing = false; entry.constructed.resolve();
        const started = await opening;
        const after = time(); if (after === undefined || !consent(entry, after)) return;
        if (!started.ok) { result = no(started.reason); void retire(entry, started.reason); return; }
        entry.facts = Object.freeze({ ...started.value.facts });
        if (!refresh(entry)) return; arm(entry); result = yes(undefined);
      } catch { result = no('unavailable'); void retire(entry, 'unavailable'); }
      finally {
        entry.constructing = false; entry.constructed.resolve(); entry.pending.delete(done.promise); emit();
        const after = time(); if (result.ok && (after === undefined || !consent(entry, after))) result = no('cancelled');
        done.resolve(result);
      }
    })(); return done.promise;
  }
  function stop(why: 'stopped' | 'hidden' | 'revoked' = 'stopped') { if (run) return retire(run, why); if (!closed) { phase = 'stopped'; reason = why; } return emptyBarrier; }
  function close(): Promise<void> {
    if (closing) return closing; const done = deferred<void>(); closing = done.promise; closed = true;
    try { Reflect.apply(signalRemove, owner, ['abort', ownerClosed]); } catch { cleanupUnconfirmed = true; }
    const barrier = run ? retire(run, 'closed') : emptyBarrier; phase = run ? 'stopping' : 'closed'; reason = 'closed';
    void barrier.then(() => { phase = 'closed'; done.resolve(); emit(); }); return closing;
  }
  function ownerClosed() { void close(); }
  if (!closed) Reflect.apply(signalAdd, owner, ['abort', ownerClosed, { once: true }]);
  return Object.freeze({ review, approve, start, stop, close,
    revoke(part: Part) { if (run && ['capture', 'source', 'display'].includes(part)) run.signals[part].abort(); return stop('revoked'); },
    snapshot(): ScreenTaskSnapshot {
      const entry = run;
      if (entry && entry.pipeline && !entry.retired && phase !== 'opening') refresh(entry);
      let native: ReturnType<Pipeline['provider']['snapshot']> | undefined;
      try { native = entry?.pipeline?.provider.snapshot(); } catch { cleanupUnconfirmed = true; if (entry) void retire(entry, 'cleanup-unconfirmed'); }
      const current = !!entry && live(entry), at = time();
      let latest: Observation | undefined; try { latest = entry?.pipeline?.state().latest; } catch { cleanupUnconfirmed = true; if (entry) void retire(entry, 'cleanup-unconfirmed'); }
      const finalAt = time();
      if (entry && live(entry) && phase !== 'review' && finalAt !== undefined && finalAt >= entry.expiresAt) void retire(entry, 'expired');
      const present = !!entry && live(entry);
      const visible = present && current && at !== undefined && finalAt !== undefined && previewCurrent(entry!, latest, finalAt);
      return Object.freeze({ phase, reason, runs, actions, previewVisible: visible, capturePresent: present && native?.activeSources === 1,
        ...(present && entry?.facts ? { facts: entry.facts } : {}),
        ...(present && entry?.handle ? { review: Object.freeze({ handle: entry.handle, ...entry.approved }) } : {}),
        rawPending: (entry?.pending.size ?? 0) + Number(entry?.constructing === true) + Number(entry?.closing !== undefined && !entry.closeSettled) + (native?.rawPending ?? 0),
        framePending: native?.framePending ?? 0, cleanupUnconfirmed,
        owned: Object.freeze({ pipelines: Number(entry?.pipeline !== undefined), timers: Number(entry?.timerPending === true) }) });
    } });
}
