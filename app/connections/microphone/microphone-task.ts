import { createBrowserMicrophoneProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { AuthorizationRequest, BrowserMicrophoneActivation, BrowserMicrophoneEnvironment,
  BrowserMicrophoneInventory, BrowserMicrophoneOptions, BrowserMicrophoneProvider, Connection,
  DeviceCapability, DeviceRuntime, EndpointHandle, RouteGrant } from '@101/connect';
import { readingChoices, readingTable } from '../readings/readings-schema.ts';
import type { ReadingTable } from '../readings/readings-schema.ts';

export const MICROPHONE_TASK_LIMITS = Object.freeze({ attempts: 4, actions: 64, choices: 8,
  captureMs: 30000, reviewMs: 5000, taskTimerMs: 100, callbacks: 360, latest: 1, routes: 1, sinks: 1 });
export type MicrophoneStage = 'capture' | 'source' | 'display';
export type MicrophoneReason = 'idle' | 'permission' | 'active' | 'unavailable' | 'invalid' | 'denied' |
  'unsupported' | 'lost' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'cancelled' | 'quota' | 'busy' | 'closed';
export type MicrophonePhase = 'idle' | 'finding' | 'no-inputs' | 'selected' | 'review' | 'opening' |
  'captured' | 'active' | 'settling' | 'stopped' | 'closed';
export interface MicrophoneReview {
  readonly stage: MicrophoneStage; readonly expiresAt: number; readonly label: string;
  readonly microphoneReview?: never;
}
export interface MicrophoneSnapshot {
  readonly phase: MicrophonePhase; readonly reason: MicrophoneReason;
  readonly choices: readonly Readonly<{ ordinal: number; label: string }>[];
  readonly selectedOrdinal?: number; readonly deadline?: number; readonly latest?: ReadingTable;
  readonly approvals: Readonly<{ capture: boolean; source: boolean; display: boolean }>;
  readonly rawPending: number; readonly cleanupUnconfirmed: boolean;
  readonly attempts: number; readonly actions: number; readonly callbacks: number;
  readonly owned: Readonly<{ runtimes: number; providers: number; routes: number; sinks: number; taskTimers: number }>;
}
export interface MicrophoneTaskOptions {
  readonly owner: AbortSignal; readonly now?: () => number; readonly environment?: BrowserMicrophoneEnvironment;
  /** Cooperative observer seam. Tests delegate to the actual public provider. */
  readonly createProvider?: (options: BrowserMicrophoneOptions) => BrowserMicrophoneProvider;
  readonly setTimer?: (run: () => void, delay: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void; readonly onChange?: () => void;
}
export interface MicrophoneTask {
  findInputs(): Promise<boolean>; select(ordinal: number): boolean;
  review(stage: MicrophoneStage): MicrophoneReview | undefined; approve(review: MicrophoneReview): Promise<boolean>;
  stop(): Promise<void>; close(): Promise<void>; snapshot(): MicrophoneSnapshot;
}
interface Run {
  readonly generation: number; readonly deadline: number; readonly runtime: DeviceRuntime;
  readonly owner: AbortController; readonly capture: AbortController;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly setupSettled: Promise<void>; readonly finishSetup: () => void;
  retired: boolean; provider?: BrowserMicrophoneProvider; choices: readonly BrowserMicrophoneInventory[];
  selected?: BrowserMicrophoneInventory; activation?: BrowserMicrophoneActivation; capability?: DeviceCapability;
  approvals: { capture: boolean; source: boolean; display: boolean };
  review?: MicrophoneReview; callbacks: number; timer?: unknown;
  sink?: EndpointHandle; sinkId?: string; route?: Connection; unlisten?: () => void;
}
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
const aborted = (signal: AbortSignal): boolean => Reflect.apply(abortGetter, signal, []) as boolean;
const reasons = new Set<MicrophoneReason>(['idle', 'permission', 'active', 'unavailable', 'invalid', 'denied', 'unsupported',
  'lost', 'hidden', 'unfocused', 'expired', 'stopped', 'cancelled', 'quota', 'busy', 'closed']);
function fixedReason(value: unknown): MicrophoneReason { return typeof value === 'string' && reasons.has(value as MicrophoneReason) ? value as MicrophoneReason : 'lost'; }
const noApprovals = () => ({ capture: false, source: false, display: false });
let tasks = 0;

/** Selected digital levels on this page only. Construction never inspects or opens
 * an input. No PCM, speaker, recording, persistence, default permission bootstrap
 * or remote recipient. Bounds are per task/run; native buffering is not measured.
 * Stop withdraws authority immediately but waits for the actual provider close;
 * a hung native return can leave that stable retirement promise pending. */
export function createMicrophoneTask(options: MicrophoneTaskOptions): MicrophoneTask {
  const ownerSignal = options.owner, environment = options.environment;
  let alreadyAborted: boolean;
  try { alreadyAborted = aborted(ownerSignal); } catch { throw new TypeError('Invalid microphone task owner'); }
  if (++tasks > Number.MAX_SAFE_INTEGER) throw new RangeError('Microphone task capacity reached');
  const id = tasks, now = options.now ?? (() => performance.now());
  const makeProvider = options.createProvider ?? createBrowserMicrophoneProvider;
  const setTimer = options.setTimer ?? ((run: () => void, delay: number) => setTimeout(run, delay));
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const notify = options.onChange;
  if ([now, makeProvider, setTimer, clearTimer].some(value => typeof value !== 'function') || notify !== undefined && typeof notify !== 'function') throw new TypeError('Invalid microphone task options');
  const reviews = new WeakMap<object, Run>();
  let closed = alreadyAborted, phase: MicrophonePhase = closed ? 'closed' : 'idle', reason: MicrophoneReason = closed ? 'closed' : 'idle';
  let current: Run | undefined, retiring: Run | undefined, latest: ReadingTable | undefined;
  let attempts = 0, actions = 0, generation = 0, lastAt = -1, lastCallbacks = 0, cleanupUnconfirmed = false;
  let stopping = false, notifying = false, stopBarrier: Promise<void> | undefined, closeBarrier: Promise<void> | undefined;

  function emit(): void {
    if (!notify || notifying) return;
    notifying = true;
    try { notify(); } catch { void retire('unavailable'); }
    finally { notifying = false; }
  }
  function time(): number | undefined {
    let at: number;
    try { at = now(); } catch { void retire('invalid'); return; }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 30000 || at < lastAt) { void retire('invalid'); return; }
    lastAt = at; return at;
  }
  function alive(run: Run): boolean { return !closed && !run.retired && current === run && !aborted(ownerSignal) && !aborted(run.owner.signal); }
  function usable(run: Run): boolean {
    if (!alive(run)) return false;
    const at = time();
    if (at === undefined || !alive(run)) return false;
    if (at >= run.deadline) { void retire('expired'); return false; }
    return true;
  }
  function action(): boolean {
    if (closed || aborted(ownerSignal)) return false;
    if (actions >= 64) { reason = 'quota'; void retire('quota'); emit(); return false; }
    actions++; return true;
  }
  function cancelTimer(run: Run): void {
    const handle = run.timer; run.timer = undefined;
    if (handle !== undefined) try { clearTimer(handle); } catch { cleanupUnconfirmed = true; }
  }
  function providerState(run: Run) {
    try { return run.provider?.snapshot(); } catch { cleanupUnconfirmed = true; void retire('unavailable'); return; }
  }
  function retire(why: MicrophoneReason): Promise<void> {
    if (stopping && stopBarrier) return stopBarrier;
    if (!current) {
      reason = closed ? 'closed' : why; phase = closed ? 'closed' : 'stopped'; latest = undefined;
      stopBarrier ??= Promise.resolve(); emit(); return stopBarrier;
    }
    // Publish the barrier and logical withdrawal before all trusted callouts.
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; }); stopBarrier = barrier; stopping = true;
    const run = current; current = undefined; retiring = run; run.retired = true; run.review = undefined;
    run.choices = []; run.selected = undefined; run.approvals = noApprovals(); latest = undefined;
    lastCallbacks = run.callbacks; reason = closed ? 'closed' : why; phase = closed ? 'closed' : 'settling';
    cancelTimer(run);
    const route = run.route, sink = run.sink, unlisten = run.unlisten;
    run.route = undefined; run.sink = undefined; run.sinkId = undefined; run.unlisten = undefined;
    try { unlisten?.(); } catch { cleanupUnconfirmed = true; }
    try { route?.stop('microphone-page-stopped'); } catch { cleanupUnconfirmed = true; }
    try { if (sink) run.runtime.unregister(sink); } catch { cleanupUnconfirmed = true; }
    try { run.capture.abort(); } catch { cleanupUnconfirmed = true; }
    try { run.owner.abort(); } catch { cleanupUnconfirmed = true; }
    try { run.provider?.stop(); } catch { cleanupUnconfirmed = true; }
    emit();
    const settle = async () => {
      // A synchronous factory may reenter Stop before returning its provider.
      await run.setupSettled;
      try { await run.provider?.close(); if ((run.provider?.snapshot().cleanupFailures ?? 0) > 0) cleanupUnconfirmed = true; } catch { cleanupUnconfirmed = true; }
      try { if (route?.whenSettled) await route.whenSettled(); } catch { cleanupUnconfirmed = true; }
      try { run.runtime.close(); } catch { cleanupUnconfirmed = true; }
      if (retiring === run) retiring = undefined;
      stopping = false; phase = closed ? 'closed' : 'stopped'; emit(); finish();
    };
    void settle().catch(() => { cleanupUnconfirmed = true; stopping = false; if (retiring === run) retiring = undefined; phase = closed ? 'closed' : 'stopped'; emit(); finish(); });
    return barrier;
  }
  function authorize(run: Run, request: Readonly<AuthorizationRequest>): RouteGrant | undefined {
    if (!usable(run) || !run.activation || !run.capability || !run.sink || !run.sinkId ||
      !run.approvals.capture || !run.approvals.source || !run.approvals.display) return;
    const scope = run.scope, source = run.activation.device, cap = run.capability;
    if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || request.partition !== undefined ||
      request.source.registrationId !== run.activation.source.id || request.sink.registrationId !== run.sink.id ||
      request.source.deviceId !== source.id || request.sink.deviceId !== run.sinkId ||
      request.source.capabilityId !== cap.id || request.sink.capabilityId !== cap.id ||
      request.source.descriptorRevision !== source.revision || request.sink.descriptorRevision !== source.revision ||
      request.source.schemaVersion !== cap.schemaVersion || request.sink.schemaVersion !== cap.schemaVersion ||
      cap.delivery.mode !== 'latest' || !usable(run)) return;
    return { expiresAt: run.deadline, maxAgeMs: cap.delivery.maxAgeMs, maxHz: Math.min(10, cap.delivery.maxHz) };
  }
  function arm(run: Run): void {
    if (!alive(run) || run.timer !== undefined || !run.review && !run.approvals.capture) return;
    if (run.callbacks >= 360) { void retire('quota'); return; }
    const issued: { handle?: unknown } = {};
    try {
      issued.handle = setTimer(() => {
        run.timer = undefined;
        if (!alive(run)) return;
        run.callbacks++; lastCallbacks = run.callbacks;
        if (!usable(run)) return;
        const at = time(); if (at === undefined || !alive(run)) return;
        if (run.review && at >= run.review.expiresAt) { void retire('expired'); return; }
        try { run.provider?.sweep(); } catch { void retire('unavailable'); return; }
        if (!alive(run)) return;
        const status = providerState(run); if (!alive(run)) return;
        if (run.approvals.capture && status?.phase !== 'active' && status?.phase !== 'opening') { void retire(fixedReason(status?.reason)); return; }
        try { if (run.route) run.runtime.flush(); } catch { void retire('unavailable'); return; }
        if (alive(run)) { emit(); arm(run); }
      }, 100);
    } catch { void retire('unavailable'); return; }
    if (!alive(run)) { try { clearTimer(issued.handle); } catch { cleanupUnconfirmed = true; } return; }
    run.timer = issued.handle;
  }
  async function findInputs(): Promise<boolean> {
    if (!action()) return false;
    if (stopping || current) { reason = 'busy'; emit(); return false; }
    if (attempts >= 4 || cleanupUnconfirmed) { reason = cleanupUnconfirmed ? 'unavailable' : 'quota'; emit(); return false; }
    const at = time(); if (at === undefined || closed || aborted(ownerSignal)) return false;
    // The trusted clock can reenter and install or retire another real run.
    if (stopping || current) { reason = 'busy'; emit(); return false; }
    if (attempts >= 4 || cleanupUnconfirmed) { reason = cleanupUnconfirmed ? 'unavailable' : 'quota'; emit(); return false; }
    attempts++; generation++; stopBarrier = undefined; lastCallbacks = 0;
    const owner = new AbortController(), capture = new AbortController();
    const scope = Object.freeze({ principalId: `microphone-owner-${id}`, applicationId: 'microphone-level-page', sessionId: `microphone-${id}-${generation}` });
    const authority: { run?: Run } = {};
    const runtime = createDeviceRuntime({ clockDomain: `microphone-page-${id}`, now: () => time() ?? NaN,
      authorize: request => authority.run ? authorize(authority.run, request) : undefined,
      maxRegistrations: 2, maxRoutes: 1, maxSubscribers: 1, maxPendingDeliveries: 1, maxPendingDeliveriesPerScope: 1 });
    let finishSetup!: () => void;
    const setupSettled = new Promise<void>(resolve => { finishSetup = resolve; });
    const run: Run = { generation, deadline: at + 30000, runtime, owner, capture, scope,
      setupSettled, finishSetup, retired: false, choices: [], approvals: noApprovals(), callbacks: 0 };
    authority.run = run; current = run; phase = 'finding'; reason = 'permission'; emit();
    try {
      if (!alive(run)) return false;
      const provider = makeProvider({ runtime, ownerSignal: owner.signal, scope, now: () => time() ?? NaN,
        ...(environment ? { environment } : {}),
        authorizeCapture(request) {
          if (!usable(run) || !run.selected || !run.approvals.capture || request.principalId !== scope.principalId ||
            request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId || request.purpose !== 'local-digital-levels' ||
            request.operation !== 'subscribe' || request.capabilityId !== 'envelope' || !usable(run)) return;
          return { request, signal: capture.signal, expiresAt: run.deadline };
        } });
      run.provider = provider;
    } catch { void retire('unavailable'); return false; }
    finally { run.finishSetup(); }
    if (!usable(run)) { void retire('stopped'); return false; }
    try {
      const result = await run.provider!.inspect();
      if (!usable(run)) return false;
      if (!result.ok) { void retire(fixedReason(result.reason)); return false; }
      if (result.value.length > 8) { void retire('unsupported'); return false; }
      run.choices = Object.freeze([...result.value]); phase = run.choices.length ? 'selected' : 'no-inputs'; reason = run.choices.length ? 'permission' : 'unavailable';
      emit(); return alive(run);
    } catch { void retire('unavailable'); return false; }
  }
  function select(ordinal: number): boolean {
    if (!action()) return false;
    const run = current;
    if (!run || !usable(run) || run.approvals.capture || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 8) return false;
    const selection = run.choices.find(choice => choice.ordinal + 1 === ordinal); if (!selection) return false;
    run.selected = selection; run.review = undefined; phase = 'selected'; reason = 'permission'; emit(); return alive(run);
  }
  function review(stage: MicrophoneStage): MicrophoneReview | undefined {
    if (!action()) return;
    const run = current;
    if (!run || !usable(run) || !run.selected || !['capture', 'source', 'display'].includes(stage) || run.approvals[stage] ||
      stage !== 'capture' && (!run.activation || !run.approvals.capture) || stage === 'display' && !run.approvals.source) return;
    const at = time(); if (at === undefined || !alive(run)) return;
    const handle = Object.freeze({ stage, expiresAt: Math.min(at + 5000, run.deadline), label: `Input ${run.selected.ordinal + 1}` });
    run.review = handle; reviews.set(handle, run); phase = 'review'; reason = 'permission'; arm(run); emit();
    return alive(run) ? handle : undefined;
  }
  function connectDisplay(run: Run): boolean {
    if (!usable(run) || !run.activation || !run.capability) return false;
    const source = run.activation.device, capability = run.capability;
    try {
      const device = parseDeviceDescriptor({ ...source, id: `${source.id}:level-view`, capabilities: [{ ...capability, permissions: ['write'], ownership: { mode: 'observe' } }] });
      const sink = run.runtime.registerSink({ device, capability: capability.id,
        apply(observation, context) {
          if (!usable(run) || !run.approvals.source || !run.approvals.display || context.signal.aborted || !context.isCurrent()) return;
          const projected = readingTable(capability, observation.value);
          if (!projected) { void retire('unsupported'); return; }
          if (!usable(run) || context.signal.aborted || !context.isCurrent()) return;
          latest = projected; emit();
        }, release() { latest = undefined; } });
      run.sink = sink; run.sinkId = device.id;
      if (!usable(run)) { run.runtime.unregister(sink); run.sink = undefined; return false; }
      if (!run.runtime.setReadiness(sink, 'available', run.deadline).ok || !usable(run)) { void retire('unavailable'); return false; }
      const route = run.runtime.route({ from: run.activation.source, to: sink, ...run.scope, sourceOperation: 'subscribe', leaseMs: Math.max(1, run.deadline - (time() ?? run.deadline)), queueCapacity: 1 });
      run.route = route;
      if (!usable(run)) { route.stop('microphone-page-stopped'); run.route = undefined; return false; }
      run.unlisten = route.onClose(() => { if (alive(run)) void retire('lost'); });
      const admitted = route.start(); if (!admitted.ok || !usable(run)) { void retire('denied'); return false; }
      phase = 'active'; reason = 'active'; arm(run); emit(); return alive(run);
    } catch { void retire('unavailable'); return false; }
  }
  async function approve(handle: MicrophoneReview): Promise<boolean> {
    if (!action()) return false;
    const run = current;
    if (!run || !usable(run) || !handle || typeof handle !== 'object' || reviews.get(handle) !== run || run.review !== handle) return false;
    const at = time(); if (at === undefined || !alive(run)) return false;
    if (at >= handle.expiresAt) { void retire('expired'); return false; }
    const stage = handle.stage; reviews.delete(handle); run.review = undefined;
    if (stage === 'capture') {
      if (!run.selected || !run.provider || run.approvals.capture) return false;
      run.approvals.capture = true; phase = 'opening'; reason = 'permission'; arm(run); emit();
      if (!usable(run)) return false;
      try {
        const result = await run.provider.start(run.selected.selection, { purpose: 'local-digital-levels' });
        if (!usable(run)) return false;
        if (!result.ok) { void retire(fixedReason(result.reason)); return false; }
        const device = parseDeviceDescriptor(result.value.device), choices = readingChoices(device);
        const capability = device.capabilities.find(value => value.id === 'envelope');
        if (!capability || choices.length !== 1 || !choices[0]?.supported || capability.semantic !== 'media:microphone-envelope/1') { void retire('unsupported'); return false; }
        run.activation = result.value; run.capability = capability; phase = 'captured'; emit(); return alive(run);
      } catch { void retire('unavailable'); return false; }
    }
    if (!run.activation || !run.approvals.capture || run.approvals[stage]) return false;
    if (stage === 'source') { run.approvals.source = true; phase = 'captured'; emit(); return alive(run); }
    if (!run.approvals.source) return false;
    run.approvals.display = true; return connectDisplay(run);
  }
  function stop(): Promise<void> { return retire('stopped'); }
  function close(): Promise<void> {
    if (closeBarrier) return closeBarrier;
    let finish!: () => void;
    closeBarrier = new Promise<void>(resolve => { finish = resolve; });
    closed = true; phase = 'closed'; reason = 'closed'; latest = undefined;
    try { Reflect.apply(removeListener, ownerSignal, ['abort', ownerAborted]); } catch { cleanupUnconfirmed = true; }
    const retired = retire('closed'); emit();
    void retired.then(finish, () => { cleanupUnconfirmed = true; finish(); });
    return closeBarrier;
  }
  function ownerAborted(): void { void close(); }
  if (!closed) Reflect.apply(addListener, ownerSignal, ['abort', ownerAborted, { once: true }]);
  function snapshot(): MicrophoneSnapshot {
    const run = current, retained = run ?? retiring;
    let rawPending = 0;
    try { rawPending = retained?.provider?.snapshot().rawPending ?? 0; } catch { cleanupUnconfirmed = true; void retire('unavailable'); }
    return Object.freeze({ phase, reason, choices: Object.freeze((run?.choices ?? []).map(choice => Object.freeze({ ordinal: choice.ordinal + 1, label: `Input ${choice.ordinal + 1}` }))),
      ...(run?.selected ? { selectedOrdinal: run.selected.ordinal + 1 } : {}), ...(run ? { deadline: run.deadline } : {}), ...(latest ? { latest } : {}),
      approvals: Object.freeze({ ...(run?.approvals ?? noApprovals()) }), rawPending, cleanupUnconfirmed, attempts, actions, callbacks: retained?.callbacks ?? lastCallbacks,
      owned: Object.freeze({ runtimes: Number(retained !== undefined), providers: Number(retained?.provider !== undefined), routes: Number(run?.route !== undefined),
        sinks: Number(run?.sink !== undefined), taskTimers: Number(run?.timer !== undefined) }) });
  }
  return Object.freeze({ findInputs, select, review, approve, stop, close, snapshot });
}
