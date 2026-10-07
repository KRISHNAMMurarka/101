import { createBrowserHapticBackend, createDeviceRuntime, createHapticOutputController, getHapticOutputProfile,
  HAPTIC_OUTPUT_LIMITS, parseDeviceDescriptor } from '@101/connect';
import type { AuthorizationRequest, Connection, DeviceRuntime, EndpointHandle, HapticBackend,
  HapticBackendOutcome, HapticOutcome, HapticOutputController, HapticPreset, RouteGrant } from '@101/connect';

export const FEEDBACK_TASK_LIMITS = Object.freeze({ runs: 4, actions: 64, commands: 8, scopeMs: 30000,
  reviewMs: 5000, taskTimerMs: 100, callbacks: 320, maxHz: Math.min(2, HAPTIC_OUTPUT_LIMITS.maxHz),
  maxAgeMs: HAPTIC_OUTPUT_LIMITS.maxAgeMs, queueCapacity: HAPTIC_OUTPUT_LIMITS.queueCapacity });
export type FeedbackStage = 'source' | 'output';
export type FeedbackPhase = 'idle' | 'review' | 'ready' | 'pending' | 'settling' | 'stopped' | 'closed';
export type FeedbackReason = 'idle' | 'permission' | 'ready' | 'requested' | 'busy' | 'unavailable' | 'unsupported' |
  'invalid' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'quota' | 'closed';
export interface FeedbackReview {
  readonly stage: FeedbackStage; readonly expiresAt: number; readonly destination: 'This browser';
}
export interface FeedbackSnapshot {
  readonly phase: FeedbackPhase; readonly reason: FeedbackReason; readonly presets: readonly HapticPreset[];
  readonly approvals: Readonly<{ source: boolean; output: boolean }>; readonly deadline?: number; readonly review?: FeedbackReview;
  readonly last?: Readonly<{ preset: HapticPreset; outcome: HapticOutcome; effect: 'none' | 'dispatched'; physical: 'unverified' }>;
  readonly rawPending: number; readonly cleanupUnconfirmed: boolean; readonly canSend: boolean;
  readonly runs: number; readonly actions: number; readonly commands: number; readonly callbacks: number;
  readonly owned: Readonly<{ runtimes: number; sources: number; sinks: number; routes: number; taskTimers: number }>;
}
export interface FeedbackTaskOptions {
  readonly owner: AbortSignal; readonly now?: () => number;
  /** Trusted cooperative port seam; construction never calls this factory. */
  readonly createBackend?: () => HapticBackend;
  readonly lifecycle?: Readonly<{ target: EventTarget; document: EventTarget; hidden(): boolean; focused(): boolean }>;
  readonly setTimer?: (run: () => void, delay: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void; readonly onChange?: () => void;
}
export interface FeedbackTask {
  review(stage: FeedbackStage): FeedbackReview | undefined; approve(review: FeedbackReview): boolean;
  send(preset: HapticPreset): boolean; stop(): Promise<void>; close(): Promise<void>; snapshot(): FeedbackSnapshot;
}
interface RawSlot { readonly done: Promise<void>; readonly finish: () => void; finished: boolean }
interface TimerSlot { handle?: unknown; hasHandle: boolean; cancelled: boolean }
interface Run {
  readonly generation: number; readonly deadline: number;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly sourceId: string; readonly sinkId: string;
  approvals: { source: boolean; output: boolean }; retired: boolean; review?: FeedbackReview;
  runtime?: DeviceRuntime; source?: EndpointHandle; output?: HapticOutputController; route?: Connection;
  unlisten?: () => void; listeners: (() => void)[]; raw?: RawSlot; cancelRaw?: RawSlot; timer?: TimerSlot;
  setup: Promise<void>; callbacks: number; commands: number; nextAt: number; admitting: boolean;
  sourceRetired: boolean; outputRetired: boolean; routeRetired: boolean;
}
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
const promiseThen = Promise.prototype.then;
const aborted = (signal: AbortSignal): boolean => Reflect.apply(abortGetter, signal, []) as boolean;
const isPreset = (value: unknown): value is HapticPreset => value === 'tap' || value === 'impact' || value === 'warning';
const outcomes = new Set<HapticOutcome>(['api-returned', 'unavailable', 'busy', 'cancelled', 'api-rejected', 'rate-limited', 'expired']);
const noApprovals = () => ({ source: false, output: false });
let tasks = 0;

/** Local preset requests only. No physical confirmation, persistence, remote
 * recipient, acquisition, retry loop or timer-driven effect. Stop withdraws the
 * route immediately and keeps its runtime until both its public settlement and
 * the exact issued backend return settle. A hung return keeps the barrier pending. */
export function createFeedbackTask(options: FeedbackTaskOptions): FeedbackTask {
  const owner = options.owner;
  let alreadyAborted: boolean;
  try { alreadyAborted = aborted(owner); } catch { throw new TypeError('Invalid feedback task owner'); }
  if (++tasks > Number.MAX_SAFE_INTEGER) throw new RangeError('Feedback task capacity reached');
  const taskId = tasks, now = options.now ?? (() => performance.now());
  const makeBackend = options.createBackend ?? (() => createBrowserHapticBackend(typeof navigator === 'undefined' ? undefined : navigator));
  const setTimer = options.setTimer ?? ((run: () => void, delay: number) => setTimeout(run, delay));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const notify = options.onChange;
  if ([now, makeBackend, setTimer, clearTimer].some(value => typeof value !== 'function') || notify !== undefined && typeof notify !== 'function') {
    throw new TypeError('Invalid feedback task options');
  }
  const profile = getHapticOutputProfile('app:browser-haptic-presets/1'), value = profile.capability.value;
  if (value.type !== 'enum' || !value.values.every(isPreset)) throw new TypeError('Unsupported feedback profile');
  const presets: readonly HapticPreset[] = Object.freeze(value.values.filter(isPreset));
  const reviews = new WeakMap<object, Run>();
  let current: Run | undefined, retiring: Run | undefined;
  let closed = alreadyAborted, invalidClock = false, cleanupUnconfirmed = false, notifying = false, stopping = false;
  let phase: FeedbackPhase = closed ? 'closed' : 'idle', reason: FeedbackReason = closed ? 'closed' : 'idle';
  let runs = 0, actions = 0, lastAt = -1, lastCommands = 0, lastCallbacks = 0;
  let retiredEpoch = Symbol();
  let last: FeedbackSnapshot['last'], stopBarrier: Promise<void> | undefined, closeBarrier: Promise<void> | undefined;

  function emit(): void {
    if (!notify || notifying) return;
    notifying = true;
    try { notify(); } catch { void retire('unavailable'); }
    finally { notifying = false; }
  }
  function time(): number | undefined {
    let at: number;
    try { at = now(); } catch { invalidClock = true; void retire('invalid'); return; }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - FEEDBACK_TASK_LIMITS.scopeMs || at < lastAt) {
      invalidClock = true; void retire('invalid'); return;
    }
    lastAt = at; return at;
  }
  function alive(run: Run): boolean { return !closed && !run.retired && current === run && !aborted(owner); }
  function usable(run: Run): boolean {
    if (!alive(run)) return false;
    const at = time();
    if (at === undefined || !alive(run)) return false;
    if (at >= run.deadline) { void retire('expired'); return false; }
    return true;
  }
  function action(): boolean {
    if (closed || aborted(owner) || cleanupUnconfirmed || invalidClock) return false;
    if (actions >= FEEDBACK_TASK_LIMITS.actions) { void retire('quota'); return false; }
    actions++; return true;
  }
  function cancelTimer(run: Run): void {
    const slot = run.timer; run.timer = undefined;
    if (!slot) return;
    slot.cancelled = true;
    if (slot.hasHandle) try { clearTimer(slot.handle); } catch { cleanupUnconfirmed = true; }
  }
  function teardown(run: Run): void {
    cancelTimer(run);
    const unlisten = run.unlisten; run.unlisten = undefined;
    try { unlisten?.(); } catch { cleanupUnconfirmed = true; }
    const listeners = run.listeners; run.listeners = [];
    for (const remove of listeners) try { remove(); } catch { cleanupUnconfirmed = true; }
    if (run.route && !run.routeRetired) {
      run.routeRetired = true;
      try { run.route.stop('feedback-page-stopped'); } catch { cleanupUnconfirmed = true; }
    }
    if (run.output && !run.outputRetired) {
      run.outputRetired = true;
      try { run.output.close(); } catch { cleanupUnconfirmed = true; }
    }
    if (run.source && run.runtime && !run.sourceRetired) {
      run.sourceRetired = true;
      try { run.runtime.unregister(run.source); } catch { cleanupUnconfirmed = true; }
    }
  }
  function retire(why: FeedbackReason): Promise<void> {
    if (stopping && stopBarrier) return stopBarrier;
    retiredEpoch = Symbol();
    if (!current) {
      last = undefined; reason = closed ? 'closed' : why; phase = closed ? 'closed' : 'stopped';
      stopBarrier ??= Promise.resolve(); emit(); return stopBarrier;
    }
    // Publish the stable barrier and withdrawal before cancel/release/observer callouts.
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; }); stopBarrier = barrier; stopping = true;
    const run = current; current = undefined; retiring = run; run.retired = true;
    if (run.review) reviews.delete(run.review);
    run.review = undefined; run.approvals = noApprovals(); last = undefined;
    reason = closed ? 'closed' : why; phase = closed ? 'closed' : 'settling';
    lastCommands = run.commands; lastCallbacks = run.callbacks;
    teardown(run); emit();
    const settle = async () => {
      // A factory/constructor or invoke may reenter retirement before returning its owned resource.
      await run.setup;
      teardown(run);
      const raw = run.raw;
      if (raw) await raw.done;
      const cancellation = run.cancelRaw;
      if (cancellation) await cancellation.done;
      try {
        if (run.route) {
          if (typeof run.route.whenSettled !== 'function') cleanupUnconfirmed = true;
          else await run.route.whenSettled();
        }
      } catch { cleanupUnconfirmed = true; }
      try { run.runtime?.close(); run.runtime = undefined; } catch { cleanupUnconfirmed = true; }
      run.source = undefined; run.output = undefined; run.route = undefined;
      if (retiring === run) retiring = undefined;
      stopping = false; phase = closed ? 'closed' : 'stopped'; reason = closed ? 'closed' : why;
      emit(); finish();
    };
    void settle().catch(() => { cleanupUnconfirmed = true; stopping = false; emit(); finish(); });
    return barrier;
  }
  function close(): Promise<void> {
    if (closeBarrier) return closeBarrier;
    let finish!: () => void;
    closeBarrier = new Promise<void>(resolve => { finish = resolve; }); closed = true;
    try { Reflect.apply(removeListener, owner, ['abort', ownerAborted]); } catch { cleanupUnconfirmed = true; }
    void retire('closed').then(finish, () => { cleanupUnconfirmed = true; finish(); });
    return closeBarrier;
  }
  function ownerAborted(): void { void close(); }
  if (!alreadyAborted) Reflect.apply(addListener, owner, ['abort', ownerAborted, { once: true }]);

  function refresh(run: Run): void {
    if (!usable(run) || !run.output) return;
    let rows: ReturnType<HapticOutputController['records']>;
    try { rows = run.output.records(); } catch { void retire('unavailable'); return; }
    if (!alive(run)) return;
    const row = rows[rows.length - 1];
    // The helper retains a cancelled placeholder before its handler settles.
    // Non-placeholder outcomes are already finalized by the helper.
    const operation = run.route?.operations().find(item => item.id === String(run.commands));
    if (row && row.routeId === run.route?.id && row.operationId === String(run.commands) &&
      (row.outcome !== 'cancelled' || operation?.handlerResult === 'returned' || operation?.handlerResult === 'failed') &&
      isPreset(row.preset) && outcomes.has(row.outcome) && (row.effect === 'none' || row.effect === 'dispatched')) {
      last = Object.freeze({ preset: row.preset, outcome: row.outcome, effect: row.effect, physical: 'unverified' });
      if (row.outcome === 'unavailable' || row.outcome === 'api-rejected') { void retire('unavailable'); return; }
      reason = row.outcome === 'api-returned' ? 'requested' : run.raw ? 'busy' : 'ready';
    }
    if (!run.review) phase = run.raw ? 'pending' : 'ready';
    emit();
  }
  function arm(run: Run): void {
    if (!alive(run) || run.timer) return;
    if (run.callbacks >= FEEDBACK_TASK_LIMITS.callbacks) { void retire('quota'); return; }
    const slot: TimerSlot = { hasHandle: false, cancelled: false }; run.timer = slot;
    try {
      const handle = setTimer(() => {
        if (slot.cancelled || run.timer !== slot || !alive(run)) return;
        run.timer = undefined; slot.cancelled = true; run.callbacks++;
        if (!usable(run)) return;
        if (run.review && lastAt >= run.review.expiresAt) {
          reviews.delete(run.review); run.review = undefined; reason = 'permission'; phase = 'review'; emit();
        } else refresh(run);
        arm(run);
      }, FEEDBACK_TASK_LIMITS.taskTimerMs);
      slot.handle = handle; slot.hasHandle = true;
      if (slot.cancelled || !alive(run)) try { clearTimer(handle); } catch { cleanupUnconfirmed = true; }
    } catch { slot.cancelled = true; if (run.timer === slot) run.timer = undefined; cleanupUnconfirmed = true; void retire('unavailable'); }
  }
  function lifecycle(run: Run): boolean {
    const port = options.lifecycle ?? (typeof window === 'undefined' || typeof document === 'undefined' ? undefined : {
      target: window, document, hidden: () => document.hidden, focused: () => document.hasFocus(),
    });
    if (!port) return true;
    try {
      if (port.hidden()) { void retire('hidden'); return false; }
      if (!port.focused()) { void retire('unfocused'); return false; }
      const listen = (target: EventTarget, event: string, listener: () => void) => {
        Reflect.apply(addListener, target, [event, listener]);
        run.listeners.push(() => { Reflect.apply(removeListener, target, [event, listener]); });
      };
      listen(port.target, 'blur', () => { if (alive(run)) void retire('unfocused'); });
      listen(port.target, 'pagehide', () => { if (alive(run)) void retire('hidden'); });
      listen(port.document, 'visibilitychange', () => {
        if (!alive(run)) return;
        try { if (port.hidden()) void retire('hidden'); } catch { void retire('unavailable'); }
      });
      return alive(run);
    } catch { void retire('unavailable'); return false; }
  }
  function begin(): Run | undefined {
    if (current) return current;
    if (stopping || retiring || closed || cleanupUnconfirmed || invalidClock || runs >= FEEDBACK_TASK_LIMITS.runs) return;
    const generation = ++runs, beforeRetirement = retiredEpoch;
    const at = time();
    // A trusted clock may create/retire a run. Never replace its ownership.
    if (at === undefined || closed || stopping || retiring || current || cleanupUnconfirmed || invalidClock ||
      runs !== generation || retiredEpoch !== beforeRetirement) return;
    const run: Run = { generation, deadline: at + FEEDBACK_TASK_LIMITS.scopeMs,
      scope: Object.freeze({ principalId: `feedback-owner-${taskId}`, applicationId: 'feedback-page', sessionId: `feedback-${taskId}-${generation}` }),
      sourceId: `feedback-source-${taskId}-${generation}`, sinkId: `feedback-output-${taskId}-${generation}`,
      approvals: noApprovals(), retired: false, listeners: [], setup: Promise.resolve(), callbacks: 0, commands: 0,
      nextAt: -Infinity, admitting: false, sourceRetired: false, outputRetired: false, routeRetired: false };
    current = run; stopBarrier = undefined; last = undefined; lastCommands = 0; lastCallbacks = 0;
    phase = 'review'; reason = 'permission';
    if (!lifecycle(run) || !alive(run)) return;
    arm(run); return alive(run) ? run : undefined;
  }
  function grant(run: Run, request: Readonly<AuthorizationRequest>): RouteGrant | undefined {
    if (!usable(run) || !run.approvals.source || !run.approvals.output || !run.source || !run.output) return;
    if (request.principalId !== run.scope.principalId || request.applicationId !== run.scope.applicationId ||
      request.sessionId !== run.scope.sessionId || request.partition !== undefined ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'invoke' ||
      request.source.registrationId !== run.source.id || request.source.deviceId !== run.sourceId ||
      request.source.capabilityId !== profile.capability.id || request.source.descriptorRevision !== 1 || request.source.schemaVersion !== 1 ||
      request.sink.registrationId !== run.output.endpoint.id || request.sink.deviceId !== run.sinkId ||
      request.sink.capabilityId !== profile.capability.id || request.sink.descriptorRevision !== 1 || request.sink.schemaVersion !== 1) return;
    return { expiresAt: run.deadline, maxAgeMs: FEEDBACK_TASK_LIMITS.maxAgeMs, maxHz: FEEDBACK_TASK_LIMITS.maxHz };
  }
  function backend(run: Run, delegate: HapticBackend): HapticBackend {
    const fields = Object.getOwnPropertyDescriptors(delegate);
    for (const key of ['profileId', 'supported', 'invoke']) if (!fields[key] || !Object.hasOwn(fields[key]!, 'value')) throw new TypeError('Invalid feedback port');
    if (fields.cancel && !Object.hasOwn(fields.cancel, 'value')) throw new TypeError('Invalid feedback port');
    const invoke = fields.invoke!.value as HapticBackend['invoke'], cancel = fields.cancel?.value as HapticBackend['cancel'];
    if (fields.profileId!.value !== profile.id || typeof fields.supported!.value !== 'boolean' || typeof invoke !== 'function' ||
      cancel !== undefined && typeof cancel !== 'function') throw new TypeError('Invalid feedback port');
    return Object.freeze({ profileId: profile.id, supported: fields.supported!.value as boolean,
      invoke(preset: HapticPreset): HapticBackendOutcome | Promise<HapticBackendOutcome> {
        if (!usable(run)) return 'cancelled';
        if (run.raw) return 'busy';
        let finish!: () => void;
        const raw: RawSlot = { done: new Promise<void>(resolve => { finish = resolve; }), finish: () => { finish(); }, finished: false };
        // Own the provisional invocation before any delegate or observer can reenter Stop.
        run.raw = raw;
        const settled = () => {
          if (raw.finished) return;
          raw.finished = true; if (run.raw === raw) run.raw = undefined; raw.finish();
          queueMicrotask(() => { queueMicrotask(() => { if (alive(run)) refresh(run); }); });
        };
        let observationFailed = false;
        try {
          const returned = Reflect.apply(invoke, delegate, [preset]) as HapticBackendOutcome | Promise<HapticBackendOutcome>;
          if (typeof returned === 'string') {
            if (!['api-returned', 'unavailable', 'busy', 'cancelled'].includes(returned)) { cleanupUnconfirmed = true; settled(); throw new TypeError('Invalid feedback return'); }
            settled();
          } else {
            // Promise intrinsic observes the issued raw return without trusting an own .then.
            try { Reflect.apply(promiseThen, returned, [settled, settled]); }
            catch { cleanupUnconfirmed = true; observationFailed = true; throw new TypeError('Invalid feedback return'); }
          }
          return returned;
        } catch { if (!observationFailed) settled(); throw new Error('Feedback request unavailable'); }
      },
      cancel() {
        if (!cancel) return;
        let finish!: () => void;
        const raw: RawSlot = { done: new Promise<void>(resolve => { finish = resolve; }), finish: () => { finish(); }, finished: false };
        run.cancelRaw = raw;
        const settled = () => {
          if (raw.finished) return;
          raw.finished = true; if (run.cancelRaw === raw) run.cancelRaw = undefined; raw.finish();
        };
        let unobservable = false;
        try {
          const returned: unknown = Reflect.apply(cancel, delegate, []);
          if (returned === null || typeof returned !== 'object' && typeof returned !== 'function') { settled(); return; }
          // The declared port cancels synchronously. Deferred work is unsupported,
          // quarantined immediately, and still owned until its actual return.
          cleanupUnconfirmed = true;
          try { Reflect.apply(promiseThen, returned, [settled, settled]); }
          catch { unobservable = true; throw new Error('Feedback cleanup unavailable'); }
        } catch {
          cleanupUnconfirmed = true; if (!unobservable) settled();
          throw new Error('Feedback cleanup unavailable');
        }
      },
    });
  }
  function activate(run: Run): boolean {
    if (!usable(run)) return false;
    let finishSetup!: () => void;
    run.setup = new Promise<void>(resolve => { finishSetup = resolve; });
    try {
      const runtime = createDeviceRuntime({ now: () => {
        const at = time(); if (at === undefined) throw new Error('Feedback clock unavailable'); return at;
      }, clockDomain: `feedback-${taskId}`, authorize: request => grant(run, request),
      maxRegistrations: 2, maxRoutes: 1, maxSubscribers: 1, maxPendingDeliveries: 1, maxPendingDeliveriesPerScope: 1 });
      run.runtime = runtime;
      const delegate = makeBackend(); if (!alive(run)) return false;
      const port = backend(run, delegate);
      if (!port.supported) { void retire('unsupported'); return false; }
      const device = parseDeviceDescriptor({ schemaVersion: 1, id: run.sourceId, label: 'Page feedback buttons', revision: 1,
        adapter: { id: 'local:feedback-buttons', version: '1' }, runtime: { platform: 'browser' },
        capabilities: [{ ...profile.capability, kind: 'event', permissions: ['subscribe'] }] });
      run.source = runtime.registerSource({ device, capability: profile.capability.id });
      if (!usable(run)) return false;
      run.output = createHapticOutputController({ runtime, deviceId: run.sinkId, label: 'This browser feedback', backend: port,
        now: () => { const at = time(); if (at === undefined) throw new Error('Feedback clock unavailable'); return at; } });
      if (!usable(run)) return false;
      if (!runtime.setReadiness(run.source, 'available', run.deadline).ok) throw new Error('Feedback source unavailable');
      run.output.setAvailable(true); if (!usable(run)) return false;
      run.route = runtime.route({ from: run.source, to: run.output.endpoint, ...run.scope, sourceOperation: 'subscribe',
        leaseMs: Math.max(1, Math.floor(run.deadline - lastAt)), queueCapacity: FEEDBACK_TASK_LIMITS.queueCapacity,
        constraints: { expiresAt: run.deadline, maxAgeMs: FEEDBACK_TASK_LIMITS.maxAgeMs, maxHz: FEEDBACK_TASK_LIMITS.maxHz } });
      run.unlisten = run.route.onClose(() => { if (alive(run)) void retire('unavailable'); });
      if (!usable(run) || !run.route.start().ok || !usable(run)) { void retire('unavailable'); return false; }
      phase = 'ready'; reason = 'ready'; emit(); return alive(run);
    } catch { void retire('unavailable'); return false; }
    finally { finishSetup(); if (run.retired) teardown(run); }
  }
  function review(stage: FeedbackStage): FeedbackReview | undefined {
    if (!action() || stage !== 'source' && stage !== 'output' || stopping || retiring) return;
    const run = begin(); if (!run || !usable(run) || run.approvals[stage]) return;
    if (run.review) reviews.delete(run.review);
    const issued: FeedbackReview = Object.freeze({ stage, expiresAt: Math.min(lastAt + FEEDBACK_TASK_LIMITS.reviewMs, run.deadline), destination: 'This browser' });
    run.review = issued; reviews.set(issued, run); phase = 'review'; reason = 'permission'; emit();
    return alive(run) && run.review === issued ? issued : undefined;
  }
  function approve(issued: FeedbackReview): boolean {
    if (!action() || typeof issued !== 'object' || issued === null) return false;
    const run = reviews.get(issued);
    if (!run || current !== run || run.review !== issued) return false;
    reviews.delete(issued); run.review = undefined;
    if (!usable(run) || lastAt >= issued.expiresAt) { if (alive(run)) { reason = 'permission'; emit(); } return false; }
    run.approvals[issued.stage] = true;
    if (run.approvals.source && run.approvals.output) return activate(run);
    phase = 'review'; reason = 'permission'; emit(); return alive(run);
  }
  function send(preset: HapticPreset): boolean {
    if (!action() || !isPreset(preset) || !presets.includes(preset)) return false;
    const run = current;
    if (!run || !run.runtime || !run.source || !run.route || !run.approvals.source || !run.approvals.output || run.admitting || run.raw || !usable(run)) return false;
    if (run.commands >= FEEDBACK_TASK_LIMITS.commands) { reason = 'quota'; emit(); return false; }
    if (lastAt < run.nextAt) { reason = 'busy'; emit(); return false; }
    if (run.route.status().state !== 'active') { void retire('unavailable'); return false; }
    run.admitting = true;
    try {
      const at = lastAt, id = ++run.commands;
      last = undefined;
      const result = run.runtime.publish(run.source, preset, { operationId: String(id), timestamp: at,
        clockDomain: run.runtime.clockDomain, deadline: Math.min(at + FEEDBACK_TASK_LIMITS.maxAgeMs, run.deadline) });
      if (!result.ok || !alive(run)) { if (alive(run)) void retire('unavailable'); return false; }
      run.nextAt = at + 1000 / FEEDBACK_TASK_LIMITS.maxHz;
      run.runtime.flush(); if (alive(run)) { phase = run.raw ? 'pending' : 'ready'; reason = run.raw ? 'busy' : 'requested'; }
      emit(); return true;
    } catch { void retire('unavailable'); return false; }
    finally { run.admitting = false; }
  }
  function snapshot(): FeedbackSnapshot {
    const run = current ?? retiring;
    return Object.freeze({ phase, reason, presets, approvals: Object.freeze(current ? { ...current.approvals } : noApprovals()),
      ...(current ? { deadline: current.deadline } : {}), ...(current?.review ? { review: current.review } : {}),
      ...(last ? { last } : {}), rawPending: Number(run?.raw !== undefined) + Number(run?.cancelRaw !== undefined),
      cleanupUnconfirmed, canSend: !!current && !closed && !cleanupUnconfirmed && !invalidClock && !stopping &&
        current.approvals.source && current.approvals.output && !current.raw && !current.admitting &&
        current.commands < FEEDBACK_TASK_LIMITS.commands && actions < FEEDBACK_TASK_LIMITS.actions && lastAt >= current.nextAt,
      runs, actions, commands: run?.commands ?? lastCommands, callbacks: run?.callbacks ?? lastCallbacks,
      owned: Object.freeze({ runtimes: run?.runtime ? 1 : 0, sources: run?.source && !run.sourceRetired ? 1 : 0,
        sinks: run?.output && !run.outputRetired ? 1 : 0, routes: run?.route ? 1 : 0, taskTimers: run?.timer ? 1 : 0 }) });
  }
  return Object.freeze({ review, approve, send, stop: () => retire('stopped'), close, snapshot });
}
