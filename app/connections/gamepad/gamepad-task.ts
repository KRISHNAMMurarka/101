import { createBrowserGamepadProvider, createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { AuthorizationRequest, BrowserGamepadActivation, BrowserGamepadCaptureRequest,
  BrowserGamepadEnvironment, BrowserGamepadFailure, BrowserGamepadProvider, BrowserGamepadSelection,
  Connection, DeviceCapability, DeviceRuntime, EndpointHandle, RouteGrant } from '@101/connect';

export const GAMEPAD_TASK_LIMITS = Object.freeze({ runs: 4, actions: 64, reviewMs: 5000, scopeMs: 10000,
  callbacks: 1000, taskTimerMs: 20, pendingTimerMs: 1, queueCapacity: 64, pendingDeliveries: 64 });
export type GamepadTaskReason = 'idle' | 'permission' | 'waiting' | 'active' | BrowserGamepadFailure | 'cleanup-unconfirmed';
export interface GamepadReview { readonly expiresAt: number; readonly gamepadReview?: never }
type Choice = Readonly<{ index: number; axes: number; buttons: number; label: string }>;
type Button = Readonly<{ id: string; label: string; pressed: boolean; pressure?: number; observed: boolean }>;
export interface GamepadTaskSnapshot {
  readonly phase: 'idle' | 'available' | 'selected' | 'review' | 'active' | 'stopped' | 'closed';
  readonly reason: GamepadTaskReason; readonly choices: readonly Choice[]; readonly selected?: Choice;
  readonly review?: Readonly<{ handle: GamepadReview; capture: boolean; source: boolean; display: boolean }>;
  readonly axes: readonly Readonly<{ label: string; value: number }>[]; readonly buttons: readonly Button[];
  readonly runs: number; readonly actions: number; readonly cleanupUnconfirmed: boolean;
  readonly owned: Readonly<{ providers: number; runtimes: number; routes: number; sinks: number; timers: number }>;
}
export interface LocalGamepadTask {
  inspect(): boolean; select(index: number): boolean; review(): GamepadReview | undefined;
  approve(handle: GamepadReview, part: 'capture' | 'source' | 'display'): boolean;
  start(handle: GamepadReview): boolean; stop(reason?: 'stopped' | 'hidden' | 'unfocused'): void;
  close(): void; snapshot(): GamepadTaskSnapshot;
}
interface Timer { handle?: unknown; hasHandle: boolean; cancelled: boolean }
interface Binding { capability: DeviceCapability; source: EndpointHandle; sink: EndpointHandle; sinkId: string; route?: Connection; unlisten?: () => void }
interface Run {
  readonly owner: AbortController; readonly capture: AbortController;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  retired: boolean; runtime?: DeviceRuntime; provider?: BrowserGamepadProvider; selection?: BrowserGamepadSelection;
  selected?: Choice; review?: GamepadReview; approvals: { capture: boolean; source: boolean; display: boolean };
  deadline?: number; captureRequest?: BrowserGamepadCaptureRequest; activation?: BrowserGamepadActivation; bindings: Binding[]; timer?: Timer;
}
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
const aborted = (signal: AbortSignal): boolean => Reflect.apply(abortGetter, signal, []) as boolean;
const noApprovals = () => ({ capture: false, source: false, display: false });
let tasks = 0;

/** Selected browser observations on this page only. Construction is inert. The
 * opaque provider selection is retained from selection through approved start;
 * no browser mapping, physical button meaning or identity authentication is
 * inferred. Reliable pressure belongs only to a real pressed-state edge.
 * Cleanup counters represent owned software resources; a trusted removal failure
 * quarantines this task instead of asserting native cleanup. */
export function createLocalGamepadTask(options: {
  owner: AbortSignal; now: () => number; setTimer: (run: () => void, delay: number) => unknown;
  clearTimer: (token: unknown) => void; environment?: BrowserGamepadEnvironment; onChange?: () => void;
}): LocalGamepadTask {
  const owner = options.owner, now = options.now, setTimer = options.setTimer, clearTimer = options.clearTimer, notify = options.onChange;
  let closed: boolean;
  try { closed = aborted(owner); } catch { throw new TypeError('Invalid gamepad task owner'); }
  if ([now, setTimer, clearTimer].some(fn => typeof fn !== 'function') || notify !== undefined && typeof notify !== 'function') throw new TypeError('Invalid gamepad task options');
  if (++tasks > Number.MAX_SAFE_INTEGER) throw new RangeError('Gamepad task capacity reached');
  const taskId = tasks, reviews = new WeakMap<object, Run>();
  let current: Run | undefined, phase: GamepadTaskSnapshot['phase'] = closed ? 'closed' : 'idle';
  let reason: GamepadTaskReason = closed ? 'closed' : 'idle', cleanupUnconfirmed = false, invalidClock = false;
  let choices: readonly Choice[] = [], selected: Choice | undefined, axes: GamepadTaskSnapshot['axes'] = [], buttons: readonly Button[] = [];
  let runs = 0, actions = 0, callbacks = 0, inspection = 0, lastAt = -1, axesAt: number | undefined;
  let busy = false, retiring = false, notifying = false, arming = false, calling = false;

  function emit(): void {
    if (!notify || notifying) return;
    notifying = true;
    try { notify(); } catch { retire('unavailable'); }
    finally { notifying = false; }
  }
  function time(): number | undefined {
    let at: number;
    try { at = now(); } catch { invalidClock = true; retire('invalid'); return; }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 30000 || at < lastAt) { invalidClock = true; retire('invalid'); return; }
    lastAt = at; return at;
  }
  function alive(run: Run): boolean { return current === run && !run.retired && !closed && !aborted(owner) && !aborted(run.owner.signal); }
  function usable(run: Run): boolean {
    if (!alive(run)) return false;
    const at = time(); if (at === undefined || !alive(run)) return false;
    if (run.deadline !== undefined && at >= run.deadline) { retire('expired'); return false; }
    return true;
  }
  function action(): boolean {
    if (closed || aborted(owner) || cleanupUnconfirmed || invalidClock || retiring || busy) return false;
    if (actions >= GAMEPAD_TASK_LIMITS.actions) { retire('quota'); return false; }
    actions++; return true;
  }
  function clearReadings(): void {
    axes = []; axesAt = undefined;
    buttons = Object.freeze(buttons.map(button => Object.freeze({ id: button.id, label: button.label, pressed: false, observed: false })));
  }
  function cancel(run: Run): void {
    const slot = run.timer; run.timer = undefined;
    if (!slot) return; slot.cancelled = true;
    if (slot.hasHandle) try { clearTimer(slot.handle); } catch { cleanupUnconfirmed = true; }
  }
  function retire(why: GamepadTaskReason): void {
    if (retiring) return;
    const run = current; current = undefined; if (run) run.retired = true;
    phase = closed ? 'closed' : 'stopped'; reason = closed ? 'closed' : why; clearReadings();
    retiring = true;
    try {
      if (run) {
        run.review = undefined; run.approvals = noApprovals(); cancel(run);
        try { run.capture.abort(); } catch { cleanupUnconfirmed = true; }
        try { run.owner.abort(); } catch { cleanupUnconfirmed = true; }
        for (const binding of run.bindings) {
          try { binding.unlisten?.(); } catch { cleanupUnconfirmed = true; }
          try { binding.route?.stop('gamepad-page-stopped'); } catch { cleanupUnconfirmed = true; }
          try { run.runtime?.unregister(binding.sink); } catch { cleanupUnconfirmed = true; }
        }
        run.bindings = [];
        try { run.provider?.close(); } catch { cleanupUnconfirmed = true; }
        try { run.runtime?.close(); } catch { cleanupUnconfirmed = true; }
      }
    } finally {
      if (cleanupUnconfirmed) reason = 'cleanup-unconfirmed';
      // Withdrawal still owns admission during the final observer callout.
      // A status callback cannot reopen input before Stop or expiry returns.
      try { emit(); } finally { retiring = false; }
    }
  }
  function defaultEnvironment(): BrowserGamepadEnvironment {
    const win = typeof window === 'undefined' ? new EventTarget() : window;
    const doc = typeof document === 'undefined' ? undefined : document;
    return { getGamepads: typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads.bind(navigator) : undefined,
      requestAnimationFrame: run => globalThis.requestAnimationFrame(run), cancelAnimationFrame: id => globalThis.cancelAnimationFrame(id),
      target: win, document: doc ?? new EventTarget(), hidden: () => doc?.hidden !== false, focused: () => doc?.hasFocus() === true };
  }
  function guardedEnvironment(): BrowserGamepadEnvironment {
    const env = options.environment ?? defaultEnvironment();
    const target = (port: BrowserGamepadEnvironment['target']): BrowserGamepadEnvironment['target'] => ({
      addEventListener: (name, listener, flags) => port.addEventListener(name, listener, flags),
      removeEventListener(name, listener, flags) { try { port.removeEventListener(name, listener, flags); } catch (error) { cleanupUnconfirmed = true; throw error; } },
    });
    return { ...(env.getGamepads ? { getGamepads: () => env.getGamepads!() } : {}),
      requestAnimationFrame: run => env.requestAnimationFrame(run),
      cancelAnimationFrame(id) { try { env.cancelAnimationFrame(id); } catch (error) { cleanupUnconfirmed = true; throw error; } },
      target: target(env.target), document: target(env.document), hidden: () => env.hidden(), focused: () => env.focused() };
  }
  function capture(run: Run, request: BrowserGamepadCaptureRequest) {
    if (!usable(run) || !run.selected || !run.selection || !run.approvals.capture || !run.approvals.source || !run.approvals.display || run.deadline === undefined ||
      request.principalId !== run.scope.principalId || request.applicationId !== run.scope.applicationId || request.sessionId !== run.scope.sessionId ||
      request.purpose !== 'local-gamepad-readings' || request.selectedIndex !== run.selected.index || request.axes !== run.selected.axes || request.buttons !== run.selected.buttons) return;
    const ids = [...(run.selected.axes ? ['axes'] : []), ...(run.selected.buttons ? ['button'] : [])];
    if (request.resources.length !== ids.length || request.resources.some((resource, i) => resource.capabilityId !== ids[i] || resource.operation !== 'subscribe') || !usable(run)) return;
    run.captureRequest = request;
    return { request, signal: run.capture.signal, expiresAt: run.deadline };
  }
  function authorize(run: Run, request: AuthorizationRequest): RouteGrant | undefined {
    if (!usable(run) || !run.activation || run.deadline === undefined || !Object.values(run.approvals).every(Boolean) ||
      request.principalId !== run.scope.principalId || request.applicationId !== run.scope.applicationId || request.sessionId !== run.scope.sessionId ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || request.partition !== undefined) return;
    const binding = run.bindings.find(item => item.capability.id === request.source.capabilityId);
    if (!binding || request.source.registrationId !== binding.source.id || request.sink.registrationId !== binding.sink.id ||
      request.source.deviceId !== run.activation.device.id || request.sink.deviceId !== binding.sinkId ||
      request.sink.capabilityId !== binding.capability.id || request.source.schemaVersion !== binding.capability.schemaVersion ||
      request.sink.schemaVersion !== binding.capability.schemaVersion || request.source.descriptorRevision !== run.activation.device.revision ||
      request.sink.descriptorRevision !== run.activation.device.revision || !usable(run)) return;
    return { expiresAt: run.deadline, maxAgeMs: Math.min(100, binding.capability.delivery.maxAgeMs),
      maxHz: binding.capability.delivery.mode === 'latest' ? binding.capability.delivery.maxHz : 1000 };
  }
  function check(run: Run): boolean {
    if (!usable(run)) return false;
    if (cleanupUnconfirmed) { retire('cleanup-unconfirmed'); return false; }
    const state = run.provider?.snapshot();
    if (run.selection && state?.phase !== (run.activation ? 'active' : 'selected')) {
      retire(state?.reason === 'selected' || state?.reason === 'active' || state?.reason === 'idle' ? 'lost' : state?.reason ?? 'lost'); return false;
    }
    const at = time(); if (at === undefined || !alive(run)) return false;
    if (run.review && !run.activation && at >= run.review.expiresAt) { retire('expired'); return false; }
    return alive(run);
  }
  function arm(run: Run): void {
    if (!alive(run) || run.timer) return;
    if (callbacks >= GAMEPAD_TASK_LIMITS.callbacks) { retire('quota'); return; }
    const pending = run.bindings.some(item => (item.route?.status().pending ?? 0) > 0);
    const slot: Timer = { hasHandle: false, cancelled: false }; run.timer = slot;
    const at = time(); if (at === undefined || !alive(run)) return;
    const expiry = run.deadline ?? run.review?.expiresAt;
    const delay = Math.max(1, Math.min(pending ? 1 : 20, expiry === undefined ? 20 : expiry - at));
    try {
      arming = true;
      slot.handle = setTimer(() => {
        if (slot.cancelled || !alive(run) || run.timer !== slot) return;
        if (arming) { retire('invalid'); return; }
        run.timer = undefined; slot.cancelled = true; callbacks++;
        try {
          if (!check(run)) return;
          if (run.activation) {
            // Actual runtime permits one reliable dispatch per millisecond per
            // route. A second flush gives the axes and edge routes fair access.
            run.runtime!.flush(); if (!check(run)) return; run.runtime!.flush(); if (!check(run)) return;
            const currentAt = time(); if (currentAt === undefined || !alive(run)) return;
            const axesCapability = run.activation.device.capabilities.find(item => item.id === 'axes');
            if (axesAt !== undefined && axesCapability && currentAt - axesAt > Math.min(100, axesCapability.delivery.maxAgeMs)) { axes = []; axesAt = undefined; }
            emit();
          }
          if (alive(run)) arm(run);
        } catch { retire('unavailable'); }
      }, delay);
      slot.hasHandle = true;
    } catch { cleanupUnconfirmed = true; retire('unavailable'); }
    finally { arming = false; if (slot.cancelled && slot.hasHandle) try { clearTimer(slot.handle); } catch { cleanupUnconfirmed = true; } }
  }
  function inspect(): boolean {
    if (!action()) return false;
    if (phase === 'active') return false;
    retire('stopped'); if (closed || cleanupUnconfirmed || invalidClock) return false;
    const scope = Object.freeze({ principalId: `gamepad-page-${taskId}`, applicationId: '101-local-gamepad', sessionId: `inspection-${++inspection}` });
    const run: Run = { owner: new AbortController(), capture: new AbortController(), scope, retired: false, bindings: [], approvals: noApprovals() };
    current = run; choices = []; selected = undefined; buttons = []; busy = true;
    try {
      const runtime = createDeviceRuntime({ now: () => time() ?? NaN, clockDomain: 'gamepad-page-observation', authorize: request => authorize(run, request),
        maxRoutes: 2, maxSubscribers: 1, maxRegistrations: 4, maxPendingDeliveries: 64, maxPendingDeliveriesPerScope: 64 });
      run.runtime = runtime; if (!alive(run)) { runtime.close(); return false; }
      const provider = createBrowserGamepadProvider({ runtime, now: () => time() ?? NaN, scope, ownerSignal: run.owner.signal,
        environment: guardedEnvironment(), authorizeCapture: request => capture(run, request) });
      run.provider = provider; if (!alive(run)) { provider.close(); runtime.close(); return false; }
      const result = provider.inspect(); if (!alive(run)) return false;
      if (!result.ok) { retire(result.reason); return false; }
      choices = Object.freeze(result.value.map(item => Object.freeze({ ...item, label: `Gamepad ${item.index + 1}` })));
      phase = 'available'; reason = choices.length ? 'permission' : 'waiting'; emit(); return alive(run);
    } catch { retire('unavailable'); return false; }
    finally { busy = false; }
  }
  function select(index: number): boolean {
    if (!action()) return false;
    const run = current, row = choices.find(item => item.index === index);
    if (!run || !row || run.activation || !usable(run)) return false;
    busy = true;
    try {
      const result = run.provider!.select(index); if (!alive(run)) return false;
      if (!result.ok) { retire(result.reason); return false; }
      run.selection = result.value; run.selected = row; selected = row; run.review = undefined; run.approvals = noApprovals();
      phase = 'selected'; reason = 'permission'; cancel(run); emit(); return alive(run);
    } catch { retire('unavailable'); return false; }
    finally { busy = false; }
  }
  function review(): GamepadReview | undefined {
    if (!action()) return;
    const run = current; if (!run?.selection || !run.selected || run.activation || !check(run)) return;
    const at = time(); if (at === undefined || !alive(run)) return;
    const handle = Object.freeze({ expiresAt: at + GAMEPAD_TASK_LIMITS.reviewMs });
    run.review = handle; run.approvals = noApprovals(); reviews.set(handle, run); phase = 'review'; reason = 'permission';
    cancel(run); arm(run); emit(); return alive(run) ? handle : undefined;
  }
  function validReview(run: Run, handle: GamepadReview): boolean {
    if (!handle || typeof handle !== 'object' || reviews.get(handle) !== run || run.review !== handle || !check(run)) return false;
    const at = time(); if (at === undefined || !alive(run)) return false;
    if (at >= handle.expiresAt) { retire('expired'); return false; }
    return true;
  }
  function approve(handle: GamepadReview, part: 'capture' | 'source' | 'display'): boolean {
    if (!action()) return false;
    const run = current;
    if (!run || !['capture', 'source', 'display'].includes(part) || !validReview(run, handle) || run.approvals[part]) return false;
    run.approvals[part] = true; emit(); return alive(run);
  }
  function bind(run: Run): boolean {
    const activation = run.activation!, runtime = run.runtime!;
    if (!run.captureRequest || run.captureRequest.deviceId !== activation.device.id || run.captureRequest.connectionGeneration !== activation.connectionGeneration) return false;
    const device = parseDeviceDescriptor({ ...activation.device, id: `${activation.device.id}:local-display`,
      capabilities: activation.device.capabilities.map(capability => ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const axesCapability = activation.device.capabilities.find(capability => capability.id === 'axes');
    if (axesCapability && (axesCapability.value.type !== 'array' || axesCapability.value.minItems !== selected?.axes || axesCapability.value.maxItems !== selected?.axes)) return false;
    const buttonCapability = activation.device.capabilities.find(capability => capability.id === 'button');
    if (buttonCapability) {
      if (buttonCapability.value.type !== 'record' || buttonCapability.value.fields.id?.type !== 'enum' || buttonCapability.value.fields.id.values.length !== selected?.buttons) return false;
      buttons = Object.freeze(buttonCapability.value.fields.id.values.map((id, i) => Object.freeze({ id, label: `Button ${i + 1}`, pressed: false, observed: false })));
    }
    for (const capability of activation.device.capabilities) {
      if (!['axes', 'button'].includes(capability.id) || !activation.sources[capability.id] || !usable(run)) return false;
      const sink = runtime.registerSink({ device, capability: capability.id,
        apply(observation, context) {
          if (!usable(run) || context.signal.aborted || !context.isCurrent()) return;
          if (capability.id === 'axes') {
            const values = observation.value as readonly number[];
            axes = Object.freeze(values.map((value, i) => Object.freeze({ label: `Axis ${i + 1}`, value }))); axesAt = observation.timestamp;
          } else {
            const value = observation.value as { id: string; pressed: boolean; pressure: number };
            buttons = Object.freeze(buttons.map(button => button.id === value.id ? Object.freeze({ ...button, pressed: value.pressed, pressure: value.pressure, observed: true }) : button));
          }
        }, release: clearReadings });
      const binding: Binding = { capability, source: activation.sources[capability.id]!, sink, sinkId: device.id }; run.bindings.push(binding);
      if (!usable(run)) { runtime.unregister(sink); return false; }
      if (!runtime.setReadiness(sink, 'available', run.deadline).ok || !usable(run)) return false;
      const at = time(); if (at === undefined || !alive(run)) return false;
      const route = runtime.route({ from: binding.source, to: sink, ...run.scope, sourceOperation: 'subscribe', leaseMs: Math.max(1, run.deadline! - at),
        queueCapacity: 64, constraints: { expiresAt: run.deadline!, maxAgeMs: Math.min(100, capability.delivery.maxAgeMs) } });
      binding.route = route; binding.unlisten = route.onClose(why => { if (alive(run)) retire(why === 'expired' ? 'expired' : 'lost'); });
      if (!route.start().ok || !usable(run)) return false;
    }
    return usable(run);
  }
  function start(handle: GamepadReview): boolean {
    if (!action()) return false;
    const run = current;
    if (!run?.selection || run.activation || !handle || typeof handle !== 'object' || reviews.get(handle) !== run || run.review !== handle || !Object.values(run.approvals).every(Boolean)) return false;
    if (runs >= GAMEPAD_TASK_LIMITS.runs) { retire('quota'); return false; }
    const at = time(); if (at === undefined || !alive(run)) return false;
    if (at >= handle.expiresAt) { retire('expired'); return false; }
    // This deadline starts before the first native/provider callout and is never
    // renewed by slower setup, route admission, flushing or subsequent actions.
    run.deadline = at + GAMEPAD_TASK_LIMITS.scopeMs; runs++; reviews.delete(handle); run.review = undefined;
    if (!check(run)) return false;
    busy = true;
    try {
      const started = run.provider!.start(run.selection, { purpose: 'local-gamepad-readings' });
      if (!usable(run)) return false;
      if (!started.ok) { retire(started.reason); return false; }
      run.activation = started.value;
      if (!bind(run)) { if (alive(run)) retire('denied'); return false; }
      reviews.delete(handle); run.review = undefined; phase = 'active'; reason = 'active'; cancel(run); arm(run); emit(); return alive(run);
    } catch { retire('unavailable'); return false; }
    finally { busy = false; }
  }
  function close(): void {
    if (closed) return; closed = true;
    phase = 'closed'; reason = 'closed';
    try { Reflect.apply(removeListener, owner, ['abort', close]); } catch { cleanupUnconfirmed = true; }
    retire('closed');
  }
  if (!closed) Reflect.apply(addListener, owner, ['abort', close, { once: true }]);
  function operate<T>(run: () => T, unavailable: T): T {
    if (calling) return unavailable;
    calling = true;
    try { return run(); } finally { calling = false; }
  }
  return Object.freeze({ inspect: () => operate(inspect, false), select: (index: number) => operate(() => select(index), false),
    review: () => operate(review, undefined), approve: (handle: GamepadReview, part: 'capture' | 'source' | 'display') => operate(() => approve(handle, part), false),
    start: (handle: GamepadReview) => operate(() => start(handle), false),
    stop(why: 'stopped' | 'hidden' | 'unfocused' = 'stopped') { retire(['stopped', 'hidden', 'unfocused'].includes(why) ? why : 'stopped'); }, close,
    snapshot() { const run = current; return Object.freeze({ phase, reason, choices, ...(selected ? { selected } : {}),
      ...(run?.review ? { review: Object.freeze({ handle: run.review, ...run.approvals }) } : {}), axes, buttons, runs, actions, cleanupUnconfirmed,
      owned: Object.freeze({ providers: Number(run?.provider !== undefined), runtimes: Number(run?.runtime !== undefined),
        routes: run?.bindings.filter(binding => binding.route !== undefined).length ?? 0, sinks: run?.bindings.length ?? 0, timers: Number(run?.timer !== undefined) }) }); },
  });
}
