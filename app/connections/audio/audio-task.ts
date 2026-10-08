import { BROWSER_APPLICATION_AUDIO_LIMITS, createBrowserApplicationAudio, createDeviceRuntime } from '@101/connect';
import type { AuthorizationRequest, BrowserApplicationAudio, BrowserApplicationAudioBinding, BrowserApplicationAudioEnvironment,
  BrowserApplicationAudioOwnerRequest, BrowserApplicationAudioSource, DeviceRuntime, ResourceReference, RouteGrant } from '@101/connect';

export const AUDIO_TASK_LIMITS = Object.freeze({ runs: 4, actions: 64, reviewMs: 5000, scopeMs: 10000, callbacks: 1000,
  taskTimerMs: 20, volume: 0.5, initialVolume: 0.25 });
export type AudioTaskReason = 'idle' | 'permission' | 'opening' | 'active' | 'busy' | 'unavailable' | 'unsupported' | 'invalid' |
  'denied' | 'lost' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'cancelled' | 'quota' | 'closed' | 'cleanup-unconfirmed';
export interface AudioReview { readonly expiresAt: number; readonly audioReview?: never }
export interface AudioTone {
  readonly node: MediaStreamAudioDestinationNode; readonly stream: MediaStream;
  readonly ready: Promise<void>; close(): Promise<void>;
}
export interface AudioOutputPort { play(stream: MediaStream): Promise<void>; clear(): void }
export interface AudioTaskSnapshot {
  readonly phase: 'idle' | 'review' | 'opening' | 'active' | 'settling' | 'stopped' | 'closed'; readonly reason: AudioTaskReason;
  readonly review?: Readonly<{ handle: AudioReview; source: boolean; route: boolean; output: boolean }>;
  readonly muted: boolean; readonly volume: number; readonly runs: number; readonly actions: number; readonly rawPending: number;
  readonly cleanupUnconfirmed: boolean; readonly owned: Readonly<{ producers: number; providers: number; runtimes: number;
    sources: number; outputs: number; routes: number; timers: number }>;
}
export interface LocalAudioTask {
  review(): AudioReview | undefined; approve(handle: AudioReview, part: 'source' | 'route' | 'output'): boolean;
  start(handle: AudioReview): Promise<boolean>; setMuted(value: boolean): boolean; setVolume(value: number): boolean;
  stop(reason?: 'stopped' | 'hidden' | 'unfocused'): Promise<void>; close(): Promise<void>; snapshot(): AudioTaskSnapshot;
}
interface Timer { handle?: unknown; hasHandle: boolean; cancelled: boolean }
interface Review { handle: AudioReview; approvals: { source: boolean; route: boolean; output: boolean }; timer?: Timer }
interface Run {
  readonly owner: AbortController; readonly sourceConsent: AbortController; readonly outputConsent: AbortController;
  readonly deadline: number; readonly sourceId: string; readonly outputId: string; readonly sourcePrincipal: string;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly done: Promise<void>; readonly resolve: () => void; readonly pending: Set<Promise<unknown>>;
  retired: boolean; setupFinished: boolean; cleanupFinished: boolean; tone?: AudioTone; toneClosed: boolean; toneReleased: boolean;
  runtime?: DeviceRuntime; bus?: BrowserApplicationAudio; binding?: BrowserApplicationAudioBinding; source?: BrowserApplicationAudioSource;
  references?: { source: ResourceReference; sink: ResourceReference; generation: number }; routeGranted: boolean;
  timer?: Timer; detach: (() => void)[]; playAttempted: boolean; stream?: MediaStream;
}
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener, promiseThen = Promise.prototype.then;
const aborted = (signal: AbortSignal): boolean => Reflect.apply(abortGetter, signal, []) as boolean;
const sameReference = (a: ResourceReference, b: ResourceReference): boolean => a.registrationId === b.registrationId && a.deviceId === b.deviceId &&
  a.capabilityId === b.capabilityId && a.schemaVersion === b.schemaVersion && a.descriptorRevision === b.descriptorRevision;
let tasks = 0;

/** Page-generated tone only. SDK-owned clones and routing contexts remain with the
 * bus; this task owns the producer and its independently approved output port.
 * One run reservation survives raw readiness, play and close returns. Stop clears
 * the audio element synchronously; pending native work holds recovery until it
 * settles. Native graph configuration is not PCM metadata or physical hearing. */
export function createLocalAudioTask(options: {
  owner: AbortSignal; now: () => number; setTimer: (run: () => void, delay: number) => unknown; clearTimer: (token: unknown) => void;
  output: AudioOutputPort; environment?: BrowserApplicationAudioEnvironment; createTone?: (signal: AbortSignal) => AudioTone; onChange?: () => void;
}): LocalAudioTask {
  const owner = options.owner, now = options.now, setTimer = options.setTimer, clearTimer = options.clearTimer, output = options.output, notify = options.onChange;
  let closed: boolean;
  try { closed = aborted(owner); } catch { throw new TypeError('Invalid audio task owner'); }
  if ([now, setTimer, clearTimer, output?.play, output?.clear].some(fn => typeof fn !== 'function') ||
    options.createTone !== undefined && typeof options.createTone !== 'function' || notify !== undefined && typeof notify !== 'function') throw new TypeError('Invalid audio task options');
  if (++tasks > Number.MAX_SAFE_INTEGER) throw new RangeError('Audio task capacity reached');
  const taskId = tasks, reviews = new WeakSet<object>();
  let currentReview: Review | undefined, current: Run | undefined, retiring: Run | undefined;
  let phase: AudioTaskSnapshot['phase'] = closed ? 'closed' : 'idle', reason: AudioTaskReason = closed ? 'closed' : 'idle';
  let muted = false, volume = 0.25, runs = 0, actions = 0, callbacks = 0, lastAt = -1;
  let calling = false, notifying = false, teardown = false, retiringNotification = false, arming = false, cleanupUnconfirmed = false, invalidClock = false;
  let closing: Promise<void> | undefined, retiredEpoch = Symbol();

  function emit(): void { if (!notify || notifying) return; notifying = true; try { notify(); } catch { void retire('unavailable'); } finally { notifying = false; } }
  function time(): number | undefined {
    let at: number; try { at = now(); } catch { invalidClock = true; void retire('invalid'); return; }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 30000 || at < lastAt) { invalidClock = true; void retire('invalid'); return; }
    lastAt = at; return at;
  }
  function alive(run: Run): boolean { return current === run && !run.retired && !closed && !aborted(owner) && !aborted(run.owner.signal); }
  function usable(run: Run): boolean {
    if (!alive(run)) return false; const at = time(); if (at === undefined || !alive(run)) return false;
    if (at >= run.deadline) { void retire('expired'); return false; } return true;
  }
  function action(): boolean {
    if (closed || aborted(owner) || cleanupUnconfirmed || invalidClock || retiring || teardown || retiringNotification) return false;
    if (actions >= 64) { void retire('quota'); return false; } actions++; return true;
  }
  function cancelTimer(holder: { timer?: Timer }): void {
    const slot = holder.timer; holder.timer = undefined; if (!slot) return; slot.cancelled = true;
    if (slot.hasHandle) try { clearTimer(slot.handle); } catch { cleanupUnconfirmed = true; }
  }
  function clearOutput(run: Run): void { if (!run.playAttempted) return; try { output.clear(); } catch { cleanupUnconfirmed = true; } }
  function finish(run: Run): void {
    if (!run.retired || !run.setupFinished || !run.cleanupFinished || run.pending.size || teardown) return;
    run.runtime = undefined; run.bus = undefined; run.tone = undefined;
    if (retiring === run) retiring = undefined;
    phase = closed ? 'closed' : 'stopped'; if (cleanupUnconfirmed) reason = 'cleanup-unconfirmed'; run.resolve(); emit();
  }
  function track<T>(run: Run, raw: Promise<T>, settled?: (ok: boolean) => void): Promise<T> {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const reserved = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); run.pending.add(reserved);
    const complete = (ok: boolean, value: unknown) => {
      run.pending.delete(reserved); try { settled?.(ok); } catch { cleanupUnconfirmed = true; }
      if (ok) resolve(value as T); else reject(value); finish(run);
    };
    try { Reflect.apply(promiseThen, raw, [(value: T) => complete(true, value), (error: unknown) => complete(false, error)]); }
    catch (error) { complete(false, error); }
    return reserved;
  }
  function closeTone(run: Run): void {
    if (!run.tone || run.toneClosed) return; run.toneClosed = true;
    try { void track(run, run.tone.close(), ok => { run.toneReleased = true; if (!ok) cleanupUnconfirmed = true; }).catch(() => { cleanupUnconfirmed = true; finish(run); }); }
    catch { run.toneReleased = true; cleanupUnconfirmed = true; }
  }
  function closeBus(run: Run): void {
    if (!run.bus) return; const bus = run.bus;
    try { void track(run, bus.close(), ok => { if (!ok || bus.snapshot().cleanupFailures) cleanupUnconfirmed = true; }).catch(() => { cleanupUnconfirmed = true; finish(run); }); }
    catch { cleanupUnconfirmed = true; }
  }
  function retire(why: AudioTaskReason): Promise<void> {
    if (retiring) return retiring.done;
    if (retiringNotification) return Promise.resolve();
    retiringNotification = true;
    try {
      retiredEpoch = Symbol();
      const review = currentReview; currentReview = undefined; if (review) cancelTimer(review);
      const run = current; current = undefined;
      reason = closed ? 'closed' : why; phase = closed ? 'closed' : run ? 'settling' : 'stopped';
      if (!run) { if (cleanupUnconfirmed) reason = 'cleanup-unconfirmed'; emit(); return Promise.resolve(); }
      run.retired = true; retiring = run; teardown = true;
      try {
        cancelTimer(run); clearOutput(run);
        for (const remove of run.detach.splice(0)) try { remove(); } catch { cleanupUnconfirmed = true; }
        try { run.sourceConsent.abort(); run.outputConsent.abort(); run.owner.abort(); } catch { cleanupUnconfirmed = true; }
        try { run.binding?.stop(); } catch { cleanupUnconfirmed = true; }
        try { run.runtime?.close(); } catch { cleanupUnconfirmed = true; }
        closeTone(run); closeBus(run); run.cleanupFinished = true;
      } finally { teardown = false; }
      if (cleanupUnconfirmed) reason = 'cleanup-unconfirmed'; finish(run); emit(); return run.done;
    } finally { retiringNotification = false; }
  }
  function lifecycle(run: Run): boolean {
    const env = options.environment;
    const target = env?.target ?? (typeof window === 'undefined' ? undefined : window);
    const doc = env?.document ?? (typeof document === 'undefined' ? undefined : document);
    const hidden = env?.hidden ?? (() => typeof document === 'undefined' || document.hidden);
    const focused = env?.focused ?? (() => typeof document !== 'undefined' && document.hasFocus());
    if (!target || !doc) return false;
    const events = [[target, 'blur', () => { void retire('unfocused'); }], [target, 'pagehide', () => { void retire('hidden'); }],
      [doc, 'visibilitychange', () => { try { if (hidden()) void retire('hidden'); } catch { void retire('invalid'); } }]] as const;
    for (const [port, name, callback] of events) {
      let removed = false; const remove = (force = false) => { if (removed && !force) return; removed = true; port.removeEventListener(name, callback); };
      run.detach.push(remove);
      try { port.addEventListener(name, callback); } finally { if (!alive(run)) remove(true); }
      if (!alive(run)) return false;
    }
    const available = !hidden() && focused(); return available && usable(run);
  }
  function defaultTone(signal: AbortSignal): AudioTone {
    let context: AudioContext | undefined, oscillator: OscillatorNode | undefined, gain: GainNode | undefined, node: MediaStreamAudioDestinationNode | undefined;
    let started = false, closedTone = false, closeReturn: Promise<void> | undefined;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const tone: AudioTone = { get node() { if (!node) throw new Error('Tone unavailable'); return node; },
      get stream() { if (!node) throw new Error('Tone unavailable'); return node.stream; }, ready,
      close() {
        if (closedTone) return closeReturn!; closedTone = true; let failed = false;
        if (started) try { oscillator?.stop(); } catch { failed = true; }
        for (const owned of [oscillator, gain, node]) try { owned?.disconnect(); } catch { failed = true; }
        if (node) try { for (const track of node.stream.getTracks()) track.stop(); } catch { failed = true; }
        let returned: Promise<void>; try { returned = context?.close() ?? Promise.resolve(); } catch { returned = Promise.reject(new Error('Tone cleanup unavailable')); }
        closeReturn = Promise.resolve(returned).then(() => { if (failed) throw new Error('Tone cleanup unavailable'); }); return closeReturn;
      } };
    try {
      if (aborted(signal)) throw new Error('Tone cancelled');
      context = new AudioContext({ sampleRate: 48000 }); if (aborted(signal)) throw new Error('Tone cancelled');
      oscillator = context.createOscillator(); if (aborted(signal)) throw new Error('Tone cancelled');
      gain = context.createGain(); if (aborted(signal)) throw new Error('Tone cancelled');
      node = context.createMediaStreamDestination(); if (aborted(signal)) throw new Error('Tone cancelled');
      node.channelCount = 2; oscillator.frequency.value = 440; gain.gain.value = 0.05;
      oscillator.connect(gain); if (aborted(signal)) throw new Error('Tone cancelled');
      gain.connect(node); if (aborted(signal)) throw new Error('Tone cancelled'); started = true; oscillator.start();
      if (aborted(signal)) throw new Error('Tone cancelled');
      const returned = context.state === 'suspended' ? context.resume() : Promise.resolve();
      Reflect.apply(promiseThen, returned, [() => {
        if (aborted(signal) || context!.state !== 'running' || context!.sampleRate !== 48000 || node!.context !== context || node!.channelCount !== 2) reject(new Error('Tone unavailable'));
        else resolve();
      }, reject]);
    } catch (error) { reject(error); }
    return tone;
  }
  function grant(run: Run): RouteGrant { return { expiresAt: run.deadline, maxAgeMs: BROWSER_APPLICATION_AUDIO_LIMITS.maxAgeMs, maxHz: BROWSER_APPLICATION_AUDIO_LIMITS.maxHz }; }
  function ownerDecision(run: Run, request: BrowserApplicationAudioOwnerRequest, role: 'source' | 'output') {
    if (!usable(run) || !run.bus || !run.source || request.role !== role || request.operation !== 'route-private-audio' ||
      request.ownerPrincipalId !== (role === 'source' ? run.sourcePrincipal : run.scope.principalId) || request.recipientPrincipalId !== run.scope.principalId ||
      request.sourceOwnerPrincipalId !== run.sourcePrincipal || request.applicationId !== run.scope.applicationId || request.sessionId !== run.scope.sessionId ||
      request.sourceId !== run.sourceId || request.outputId !== run.outputId || request.purpose !== 'local-page-tone' || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' ||
      request.format.kind !== 'native-private-stream' || request.format.sampleRateHz !== 48000 || request.format.channels !== 2) return;
    const resources = run.bus.resources(run.source), capability = resources?.device.capabilities.find(item => item.id === 'audio');
    if (!resources || !capability || request.source.registrationId !== resources.audio.id || request.source.deviceId !== resources.device.id || request.source.capabilityId !== capability.id ||
      request.source.descriptorRevision !== resources.device.revision || request.source.schemaVersion !== capability.schemaVersion ||
      request.sink.deviceId !== run.outputId || request.sink.capabilityId !== capability.id || request.sink.descriptorRevision !== resources.device.revision || request.sink.schemaVersion !== capability.schemaVersion ||
      !Number.isSafeInteger(request.sourceGeneration) || request.sourceGeneration < 1 || !usable(run)) return;
    if (role === 'source') run.references = { source: request.source, sink: request.sink, generation: request.sourceGeneration };
    else if (!run.references || !sameReference(request.source, run.references.source) || !sameReference(request.sink, run.references.sink) || request.sourceGeneration !== run.references.generation) return;
    return { request, signal: role === 'source' ? run.sourceConsent.signal : run.outputConsent.signal, grant: grant(run) };
  }
  function authorize(run: Run, request: AuthorizationRequest): RouteGrant | undefined {
    if (!usable(run) || !run.references || request.principalId !== run.scope.principalId || request.applicationId !== run.scope.applicationId ||
      request.sessionId !== run.scope.sessionId || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || request.partition !== undefined ||
      !sameReference(request.source, run.references.source) || !sameReference(request.sink, run.references.sink) || !usable(run)) return;
    run.routeGranted = true; return grant(run);
  }
  function arm(holder: Review | Run, run?: Run): void {
    if (holder.timer || run && !alive(run) || !run && currentReview !== holder) return;
    if (callbacks >= 1000) { void retire('quota'); return; }
    const at = time(); if (at === undefined || run && !alive(run) || !run && currentReview !== holder) return;
    const deadline = run?.deadline ?? (holder as Review).handle.expiresAt;
    const slot: Timer = { hasHandle: false, cancelled: false }; holder.timer = slot;
    try {
      arming = true; slot.handle = setTimer(() => {
        if (slot.cancelled || holder.timer !== slot || run && !alive(run) || !run && currentReview !== holder) return;
        if (arming) { void retire('invalid'); return; }
        holder.timer = undefined; slot.cancelled = true; callbacks++;
        const currentAt = time(); if (currentAt === undefined || run && !alive(run) || !run && currentReview !== holder) return;
        if (currentAt >= deadline) { void retire('expired'); return; }
        if (run) {
          try {
            run.bus?.sweep(); if (!usable(run)) return;
            const state = run.binding?.status();
            if (state?.state === 'stopped') { void retire(state.reason === 'expired' ? 'expired' : state.reason === 'hidden' ? 'hidden' : state.reason === 'unfocused' ? 'unfocused' : 'lost'); return; }
            if (phase === 'active' && (!run.binding?.output() || run.binding.output() !== run.stream)) { void retire('lost'); return; }
            if (run.bus?.snapshot().cleanupFailures) { cleanupUnconfirmed = true; void retire('cleanup-unconfirmed'); return; }
          } catch { void retire('unavailable'); return; }
        }
        arm(holder, run);
      }, Math.max(1, Math.min(run ? 20 : 5000, deadline - at))); slot.hasHandle = true;
    } catch { cleanupUnconfirmed = true; void retire('unavailable'); }
    finally { arming = false; if (slot.cancelled && slot.hasHandle) try { clearTimer(slot.handle); } catch { cleanupUnconfirmed = true; } }
  }
  function review(): AudioReview | undefined {
    if (!action() || current) return;
    const turn = retiredEpoch, at = time(); if (at === undefined || closed || aborted(owner) || retiring || cleanupUnconfirmed || invalidClock || retiredEpoch !== turn) return;
    if (currentReview && at < currentReview.handle.expiresAt) return currentReview.handle;
    if (currentReview) { void retire('expired'); return; }
    const handle = Object.freeze({ expiresAt: at + 5000 }); reviews.add(handle);
    const entry: Review = { handle, approvals: { source: false, route: false, output: false } }; currentReview = entry;
    phase = 'review'; reason = 'permission'; arm(entry); emit(); return currentReview === entry && !closed ? handle : undefined;
  }
  function approve(handle: AudioReview, part: 'source' | 'route' | 'output'): boolean {
    if (!action() || !['source', 'route', 'output'].includes(part)) return false;
    const entry = currentReview;
    if (!entry || !handle || typeof handle !== 'object' || !reviews.has(handle) || entry.handle !== handle || entry.approvals[part]) return false;
    const at = time(); if (at === undefined || currentReview !== entry || closed) return false;
    if (at >= handle.expiresAt) { void retire('expired'); return false; }
    entry.approvals[part] = true; emit(); return currentReview === entry && !closed;
  }
  async function setup(run: Run): Promise<boolean> {
    try {
      if (!usable(run) || !lifecycle(run)) { if (alive(run)) void retire('unavailable'); return false; }
      if (!options.createTone && typeof AudioContext !== 'function') { void retire('unsupported'); return false; }
      let tone: AudioTone;
      try { tone = (options.createTone ?? defaultTone)(run.owner.signal); }
      catch { cleanupUnconfirmed = true; void retire('cleanup-unconfirmed'); return false; }
      run.tone = tone;
      const readiness = track(run, tone.ready);
      if (!alive(run)) { closeTone(run); await readiness; return false; }
      await readiness; if (!usable(run)) return false;
      const runtime = createDeviceRuntime({ now: () => time() ?? NaN, clockDomain: 'page-audio-observation', authorize: request => authorize(run, request),
        maxRegistrations: 4, maxRoutes: 1, maxSubscribers: 1, maxPendingDeliveries: 1, maxPendingDeliveriesPerScope: 1 });
      run.runtime = runtime; if (!usable(run)) { runtime.close(); return false; }
      const bus = createBrowserApplicationAudio({ runtime, ownerSignal: run.owner.signal, applicationId: run.scope.applicationId, sessionId: run.scope.sessionId,
        now: () => time() ?? NaN, authorizeSource: request => ownerDecision(run, request, 'source'), authorizeOutput: request => ownerDecision(run, request, 'output'),
        ...(options.environment ? { environment: options.environment } : {}) }); run.bus = bus;
      if (!usable(run)) { closeBus(run); return false; }
      const node = tone.node, stream = tone.stream; if (!usable(run)) return false;
      run.source = bus.registerSource({ sourceId: run.sourceId, ownerPrincipalId: run.sourcePrincipal, producerNode: node, stream });
      if (!usable(run)) return false;
      if (!run.source) { void retire('unsupported'); return false; }
      const binding = bus.bind({ source: run.source, outputId: run.outputId, ownerPrincipalId: run.scope.principalId, purpose: 'local-page-tone', signal: run.owner.signal }); run.binding = binding;
      const ready = await track(run, binding.ready); if (!usable(run)) return false;
      if (!ready) { void retire(binding.status().reason === 'denied' ? 'denied' : 'unavailable'); return false; }
      if (!binding.setVolume(volume) || !usable(run) || !binding.setMuted(muted) || !usable(run)) { void retire('unavailable'); return false; }
      const privateStream = binding.output(); if (!usable(run)) return false;
      if (!privateStream) { void retire('lost'); return false; } run.stream = privateStream;
      run.playAttempted = true;
      let played: Promise<void>;
      try { played = output.play(privateStream); } finally { if (!alive(run)) clearOutput(run); }
      await track(run, played, () => { if (run.retired) clearOutput(run); }); if (!usable(run)) return false;
      run.setupFinished = true; phase = 'active'; reason = 'active'; emit(); return alive(run);
    } catch { if (alive(run)) void retire('unavailable'); return false; }
    finally { run.setupFinished = true; if (run.retired) { closeTone(run); finish(run); } }
  }
  function start(handle: AudioReview): Promise<boolean> {
    if (!action() || current || retiring) return Promise.resolve(false);
    const entry = currentReview;
    if (!entry || !handle || typeof handle !== 'object' || !reviews.has(handle) || entry.handle !== handle || !Object.values(entry.approvals).every(Boolean)) return Promise.resolve(false);
    if (runs >= 4) { void retire('quota'); return Promise.resolve(false); }
    // First approved-start clock read pins the deadline before availability,
    // environment/native constructor getters, lifecycle, factory and SDK callouts.
    const turn = retiredEpoch, at = time(); if (at === undefined || closed || aborted(owner) || cleanupUnconfirmed || invalidClock || retiredEpoch !== turn || currentReview !== entry) return Promise.resolve(false);
    if (at >= handle.expiresAt) { void retire('expired'); return Promise.resolve(false); }
    runs++; currentReview = undefined; reviews.delete(handle); cancelTimer(entry);
    if (cleanupUnconfirmed) { void retire('cleanup-unconfirmed'); return Promise.resolve(false); }
    if (closed || aborted(owner) || invalidClock || retiredEpoch !== turn) return Promise.resolve(false);
    let resolve!: () => void; const done = new Promise<void>(yes => { resolve = yes; });
    const run: Run = { owner: new AbortController(), sourceConsent: new AbortController(), outputConsent: new AbortController(), deadline: at + 10000,
      sourceId: `app:page-tone-${taskId}-${runs}`, outputId: `app:page-audio-${taskId}-${runs}`, sourcePrincipal: `page-tone-owner-${taskId}`,
      scope: Object.freeze({ principalId: `page-output-owner-${taskId}`, applicationId: '101-local-audio', sessionId: `audio-${taskId}-${runs}` }),
      done, resolve, pending: new Set(), retired: false, setupFinished: false, cleanupFinished: false, toneClosed: false, toneReleased: false,
      routeGranted: false, detach: [], playAttempted: false };
    current = run; phase = 'opening'; reason = 'opening'; arm(run, run); emit();
    return setup(run);
  }
  function setMuted(value: boolean): boolean {
    if (!action() || typeof value !== 'boolean') return false; const run = current;
    if (!run || phase !== 'active' || !usable(run)) return false;
    try { if (!run.binding?.setMuted(value) || !usable(run)) return false; muted = value; emit(); return alive(run); }
    catch { void retire('unavailable'); return false; }
  }
  function setVolume(value: number): boolean {
    if (!action() || !Number.isFinite(value) || value < 0 || value > 0.5) return false; const run = current;
    if (!run || phase !== 'active' || !usable(run)) return false;
    try { if (!run.binding?.setVolume(value) || !usable(run)) return false; volume = value; emit(); return alive(run); }
    catch { void retire('unavailable'); return false; }
  }
  function operate<T>(fn: () => T, unavailable: T): T { if (calling) return unavailable; calling = true; try { return fn(); } finally { calling = false; } }
  function close(): Promise<void> {
    if (closing) return closing; closed = true; phase = 'closed'; reason = 'closed';
    try { Reflect.apply(removeListener, owner, ['abort', close]); } catch { cleanupUnconfirmed = true; }
    closing = retire('closed'); return closing;
  }
  if (!closed) Reflect.apply(addListener, owner, ['abort', close, { once: true }]);
  return Object.freeze({ review: () => operate(review, undefined), approve: (handle: AudioReview, part: 'source' | 'route' | 'output') => operate(() => approve(handle, part), false),
    start: (handle: AudioReview) => operate(() => start(handle), Promise.resolve(false)), setMuted: (value: boolean) => operate(() => setMuted(value), false),
    setVolume: (value: number) => operate(() => setVolume(value), false), stop: (why: 'stopped' | 'hidden' | 'unfocused' = 'stopped') => retire(['stopped', 'hidden', 'unfocused'].includes(why) ? why : 'stopped'), close,
    snapshot() { const run = current ?? retiring, state = run?.bus?.snapshot(); return Object.freeze({ phase, reason, ...(currentReview ? { review: Object.freeze({ handle: currentReview.handle, ...currentReview.approvals }) } : {}),
      muted, volume, runs, actions, rawPending: Number(run !== undefined && (!run.setupFinished || run.pending.size > 0)), cleanupUnconfirmed,
      owned: Object.freeze({ producers: Number(run?.tone !== undefined && !run.toneReleased), providers: Number(run?.bus !== undefined), runtimes: Number(run?.runtime !== undefined),
        sources: state?.sources ?? 0, outputs: (state?.activeOutputs ?? 0) + (state?.openingOutputs ?? 0), routes: Number(run?.routeGranted && ((state?.activeOutputs ?? 0) + (state?.openingOutputs ?? 0) > 0)),
        timers: Number(run?.timer !== undefined || currentReview?.timer !== undefined) }) }); },
  });
}
