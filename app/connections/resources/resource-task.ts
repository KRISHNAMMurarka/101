import { createDeviceRuntime, createRecipeSession, parseDeviceDescriptor, parseRecipe,
  resolveRecipe, schemasCompatible } from '@101/connect';
import type { AuthorizationRequest, Connection, DeliveryContext, DeviceDescriptor, DeviceRuntime,
  EndpointHandle, Observation, Recipe, RecipeSession, Result } from '@101/connect';

export const LOCAL_RESOURCE_LIMITS = Object.freeze({ lifetimeMs: 30000, maxHz: 10, maxAgeMs: 250,
  attempts: 16, publications: 1200, timerTicks: 300, registrations: 4, routes: 2, rawDeliveries: 2 });
export interface LocalResourceChoice {
  readonly id: string; readonly label: string; readonly descriptor: Readonly<DeviceDescriptor>;
}
function choice(id: string, label: string, boolean: boolean, output: boolean): LocalResourceChoice {
  return Object.freeze({ id, label, descriptor: parseDeviceDescriptor({ schemaVersion: 1,
    id: `local-resource:${id}`, label, revision: 1,
    adapter: { id: 'oneohone:owned-page-resource', version: '1.0.0' }, runtime: { platform: 'owned-browser-page' },
    capabilities: [{ id: 'value', semantic: boolean ? 'software:boolean' : 'software:scalar', schemaVersion: 1,
      kind: output ? 'property' : 'sample', permissions: [output ? 'write' : 'subscribe'],
      value: boolean ? { type: 'boolean' } : { type: 'scalar', unit: '1', min: 0, max: 100 },
      delivery: { mode: 'latest', maxHz: LOCAL_RESOURCE_LIMITS.maxHz, maxAgeMs: LOCAL_RESOURCE_LIMITS.maxAgeMs },
      ...(output ? { ownership: { mode: 'exclusive' } } : {}) }] }) });
}
/** Declarations of these page controls only; neither device discovery nor a grant. */
export const localResourceChoices = Object.freeze({
  sources: Object.freeze([choice('page-ticks', 'Page timer count', false, false),
    choice('page-slider', 'Page slider', false, false), choice('page-toggle', 'Page switch', true, false)]),
  outputs: Object.freeze([choice('page-meter', 'Page meter', false, true),
    choice('page-number', 'Number readout', false, true), choice('page-indicator', 'Switch readout', true, true)]),
});
declare const reviewBrand: unique symbol;
export interface LocalResourceReview { readonly [reviewBrand]: true }
export interface LocalResourceTaskSnapshot {
  readonly state: 'idle' | 'reviewing' | 'starting' | 'active' | 'released' | 'closing' | 'closed';
  readonly reason: string; readonly rawPending: number; readonly startPending: boolean;
  readonly attempts: number; readonly publications: number; readonly deliveries: number;
  readonly cleanupUnconfirmed: boolean;
  readonly candidate?: Readonly<{ handle: LocalResourceReview; sourceId: string; outputId: string;
    sourceApproved: boolean; outputApproved: boolean; expiresAt: number }>;
  readonly current?: Readonly<{ handle: LocalResourceReview; sourceId: string; outputId: string; expiresAt: number; value?: number | boolean }>;
  readonly owned: Readonly<{ registrations: number; routes: number; producerTimers: number; expiryTimers: number }>;
}
export interface LocalResourceTaskOptions {
  readonly owner: AbortSignal; readonly now: () => number;
  readonly setTimer: (run: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** Trusted local display hook. It must check the supplied current context before an effect. */
  readonly apply: (outputId: string, observation: Observation, context: DeliveryContext) => void | Promise<void>;
  /** Synchronous display release, not a promise of undoing an external physical effect. */
  readonly release: (outputId: string) => void;
  readonly onChange?: (snapshot: LocalResourceTaskSnapshot) => void;
}
export interface LocalResourceTask {
  compatible(sourceId: string, outputId: string): boolean;
  review(sourceId: string, outputId: string): Result<LocalResourceReview>;
  approve(handle: LocalResourceReview, side: 'source' | 'output'): Result;
  decline(handle: LocalResourceReview): Result;
  cancel(handle: LocalResourceReview): Result;
  start(handle: LocalResourceReview): Promise<Result>;
  publish(handle: LocalResourceReview, value: unknown): Result;
  revoke(side: 'source' | 'output'): void;
  sweep(): void;
  stop(reason?: string): void;
  snapshot(): LocalResourceTaskSnapshot;
  close(): Promise<void>;
}
type Review = { handle: LocalResourceReview; source: LocalResourceChoice; output: LocalResourceChoice;
  recipe: Readonly<Recipe>; expiresAt: number; sourceGrant?: AbortController; outputGrant?: AbortController; live: boolean };
type Work = { review: Review; epoch: number; phase: 'starting' | 'active' | 'retired';
  handles: Set<EndpointHandle>; routes: Set<Connection>; detach: Set<() => void>;
  source?: EndpointHandle; sink?: EndpointHandle; session?: RecipeSession; released: boolean;
  activeEver: boolean; value?: number | boolean; tick: number; sequence: number; lastFlush: number };
type Timer = { live: boolean; handle?: unknown };
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
const aborted = (signal: AbortSignal) => Reflect.apply(abortedGetter, signal, []) as boolean;
const ok = (): Result => Object.freeze({ ok: true, value: undefined });
const failed = (reason: string): Result<never> => Object.freeze({ ok: false, reason });
let instances = 0;

function recipeFor(source: LocalResourceChoice, output: LocalResourceChoice): Readonly<Recipe> {
  const from = source.descriptor.capabilities[0]!, to = output.descriptor.capabilities[0]!;
  return parseRecipe({ schemaVersion: 1, id: 'oneohone:local-resource-task', version: '1.0.0',
    resources: [{ id: 'input', direction: 'source', semantic: from.semantic, schemaVersion: from.schemaVersion, required: true },
      { id: 'output', direction: 'sink', semantic: to.semantic, schemaVersion: to.schemaVersion, required: true }], processors: [],
    routes: [{ id: 'selected', from: { node: 'input', port: 'value' }, to: { node: 'output', port: 'value' }, required: true }],
    permissions: [{ route: 'selected', side: 'from', operation: 'subscribe', owner: 'required', purpose: 'Observe this selected page control' },
      { route: 'selected', side: 'to', operation: 'write', owner: 'required', purpose: 'Update this selected page display' }],
    styles: [{ id: 'default', tone: 'normal', density: 'comfortable' }],
    surfaces: [{ id: 'display', title: 'Selected page output', components: [{ id: 'value', kind: 'value', label: 'Current value',
      from: { node: 'input', port: 'value' }, style: 'default' }] }] });
}
const environment = (review: Review) => ({ devices: [review.source.descriptor, review.output.descriptor], processors: [],
  selections: { input: { deviceId: review.source.descriptor.id, capability: 'value' },
    output: { deviceId: review.output.descriptor.id, capability: 'value' } } });

export function localResourcesCompatible(sourceId: string, outputId: string): boolean {
  const source = localResourceChoices.sources.find(item => item.id === sourceId), output = localResourceChoices.outputs.find(item => item.id === outputId);
  if (!source || !output || !schemasCompatible(source.descriptor.capabilities[0]!, output.descriptor.capabilities[0]!)) return false;
  return resolveRecipe(recipeFor(source, output), { devices: [source.descriptor, output.descriptor], processors: [],
    selections: { input: { deviceId: source.descriptor.id, capability: 'value' }, output: { deviceId: output.descriptor.id, capability: 'value' } } }).ok;
}
function fixedOptions(input: LocalResourceTaskOptions): LocalResourceTaskOptions {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw new TypeError('Local resource task options required');
  const copy: Record<string, unknown> = Object.create(null), allowed = ['owner', 'now', 'setTimer', 'clearTimer', 'apply', 'release', 'onChange'];
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new TypeError('Local resource task options required');
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw new TypeError('Local resource task options required');
    copy[key] = property.value;
  }
  for (const key of ['now', 'setTimer', 'clearTimer', 'apply', 'release'])
    if (typeof copy[key] !== 'function') throw new TypeError('Local resource task options required');
  if (copy.onChange !== undefined && typeof copy.onChange !== 'function') throw new TypeError('Local resource task options required');
  return Object.freeze(copy) as unknown as LocalResourceTaskOptions;
}

/** Local page/session consent only. It neither authenticates remote owners nor registers external devices. */
export function createLocalResourceTask(input: LocalResourceTaskOptions): LocalResourceTask {
  const options = fixedOptions(input);
  // Intrinsic brand checks and listeners avoid caller-shadowed signal methods.
  const owner = options.owner; let closed = aborted(owner), epoch = 0, lastAt = -1, attempts = 0,
    publications = 0, deliveries = 0, startPending = false, tearing = false, cleanupUnconfirmed = false;
  let candidate: Review | undefined, work: Work | undefined, reason = closed ? 'closed' : 'idle';
  let producerTimer: Timer | undefined, expiryTimer: Timer | undefined, closePromise: Promise<void> | undefined;
  const reviews = new WeakMap<object, Review>(), tasks = new Set<Promise<unknown>>(), effects = new Set<Promise<unknown>>();
  const sessionId = `local-resource-session:${++instances}`, applicationId = 'oneohone:local-resource-task', principalId = 'selected-page-owner';
  function tracked<T>(set?: Set<Promise<unknown>>) {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    tasks.add(promise); set?.add(promise);
    void promise.then(() => { tasks.delete(promise); set?.delete(promise); }, () => { tasks.delete(promise); set?.delete(promise); });
    return { promise, resolve(value: T) { tasks.delete(promise); set?.delete(promise); resolve(value); },
      reject(error: unknown) { tasks.delete(promise); set?.delete(promise); reject(error); } };
  }
  function view(): LocalResourceTaskSnapshot {
    return Object.freeze({ state: closed ? tasks.size ? 'closing' : 'closed' : startPending ? 'starting' :
      work?.phase === 'active' ? 'active' : candidate ? 'reviewing' : reason === 'idle' ? 'idle' : 'released',
    reason, rawPending: effects.size, startPending, attempts, publications, deliveries, cleanupUnconfirmed,
    ...(candidate ? { candidate: Object.freeze({ handle: candidate.handle, sourceId: candidate.source.id,
      outputId: candidate.output.id, sourceApproved: !!candidate.sourceGrant && !aborted(candidate.sourceGrant.signal),
      outputApproved: !!candidate.outputGrant && !aborted(candidate.outputGrant.signal), expiresAt: candidate.expiresAt }) } : {}),
    ...(work?.phase === 'active' ? { current: Object.freeze({ handle: work.review.handle, sourceId: work.review.source.id, outputId: work.review.output.id,
      expiresAt: work.review.expiresAt, ...(work.value === undefined ? {} : { value: work.value }) }) } : {}),
    owned: Object.freeze({ registrations: work?.handles.size ?? 0, routes: work?.routes.size ?? 0,
      producerTimers: Number(producerTimer?.live === true), expiryTimers: Number(expiryTimer?.live === true) }) });
  }
  function notify(): void { try { options.onChange?.(view()); } catch { /* Status cannot grant or reopen authority. */ } }
  function cancelTimer(which: 'producer' | 'expiry'): void {
    const timer = which === 'producer' ? producerTimer : expiryTimer;
    if (which === 'producer') producerTimer = undefined; else expiryTimer = undefined;
    if (!timer) return; timer.live = false;
    if (timer.handle !== undefined) try { options.clearTimer(timer.handle); } catch { cleanupUnconfirmed = true; }
  }
  function discard(review: Review): void {
    review.live = false; review.sourceGrant?.abort(); review.outputGrant?.abort(); if (candidate === review) candidate = undefined;
  }
  function release(old: Work): void {
    if (!old.activeEver || old.released) return; old.released = true; old.value = undefined;
    try { options.release(old.review.output.id); } catch { cleanupUnconfirmed = true; }
  }
  function retire(old: Work, why: string): void {
    if (old.phase === 'retired') return;
    const outer = tearing; tearing = true; old.phase = 'retired';
    if (work === old) { work = undefined; epoch++; reason = why; cancelTimer('producer'); cancelTimer('expiry'); }
    discard(old.review); old.session?.stop(why);
    for (const detach of old.detach) try { detach(); } catch { cleanupUnconfirmed = true; } old.detach.clear();
    for (const route of old.routes) route.stop(why); old.routes.clear();
    for (const handle of old.handles) runtime.unregister(handle); old.handles.clear();
    release(old); tearing = outer;
  }
  function stop(why = 'stopped'): void {
    if (!work && !candidate && reason === why) return;
    if (candidate) discard(candidate);
    if (work) retire(work, why); else { epoch++; reason = why; cancelTimer('producer'); cancelTimer('expiry'); }
    notify();
  }
  function clock(): number {
    let at: number;
    try { at = options.now(); } catch { stop('invalid-clock'); return NaN; }
    if (!Number.isFinite(at) || at < 0 || at < lastAt || at > Number.MAX_SAFE_INTEGER - LOCAL_RESOURCE_LIMITS.lifetimeMs) {
      stop('invalid-clock'); return NaN;
    }
    lastAt = at; return at;
  }
  function fence(old: Work, starting = false): boolean {
    const review = old.review;
    return !closed && !tearing && work === old && old.epoch === epoch &&
      (old.phase === 'active' || starting && old.phase === 'starting') && review.live && !aborted(owner) &&
      !!review.sourceGrant && !!review.outputGrant && !aborted(review.sourceGrant.signal) && !aborted(review.outputGrant.signal);
  }
  function current(old: Work, starting = false): boolean {
    if (!fence(old, starting)) return false;
    const at = clock();
    if (!fence(old, starting) || !Number.isFinite(at)) return false;
    if (at >= old.review.expiresAt) { retire(old, 'expired'); notify(); return false; }
    return true;
  }
  function deliveryCurrent(old: Work, context: DeliveryContext): boolean {
    if (aborted(context.signal) || !current(old)) return false;
    let approved = false; try { approved = context.isCurrent(); } catch { return false; }
    // The observer may change the clock/authority. No observer callout follows this final clock and intrinsic fence.
    return approved && current(old) && !aborted(context.signal) && fence(old);
  }
  function exact(request: Readonly<AuthorizationRequest>, old: Work): boolean {
    const review = old.review;
    return request.principalId === principalId && request.applicationId === applicationId && request.sessionId === sessionId &&
      request.sourceOperation === 'subscribe' && request.sinkOperation === 'write' && request.partition === undefined &&
      request.source.registrationId === old.source?.id && request.sink.registrationId === old.sink?.id &&
      request.source.deviceId === review.source.descriptor.id && request.sink.deviceId === review.output.descriptor.id &&
      request.source.capabilityId === 'value' && request.sink.capabilityId === 'value' &&
      request.source.descriptorRevision === review.source.descriptor.revision && request.sink.descriptorRevision === review.output.descriptor.revision &&
      request.source.schemaVersion === 1 && request.sink.schemaVersion === 1;
  }
  const runtime = createDeviceRuntime({ now: clock, clockDomain: sessionId, maxRegistrations: LOCAL_RESOURCE_LIMITS.registrations,
    maxRoutes: LOCAL_RESOURCE_LIMITS.routes, maxSubscribers: 2, maxPendingDeliveries: LOCAL_RESOURCE_LIMITS.rawDeliveries,
    authorize(request) {
      const old = work; if (!old || !exact(request, old) || !current(old, true)) return;
      return Object.freeze({ expiresAt: old.review.expiresAt, maxAgeMs: LOCAL_RESOURCE_LIMITS.maxAgeMs, maxHz: LOCAL_RESOURCE_LIMITS.maxHz });
    } });
  function installTimer(which: 'producer' | 'expiry', old: Work, delay: number, run: () => void): boolean {
    cancelTimer(which);
    if (cleanupUnconfirmed || !current(old)) { if (work === old) stop('cleanup-unconfirmed'); return false; }
    const ticket: Timer = { live: true };
    if (which === 'producer') producerTimer = ticket; else expiryTimer = ticket;
    try {
      const handle = options.setTimer(() => {
        if (!ticket.live || (which === 'producer' ? producerTimer : expiryTimer) !== ticket) return;
        ticket.live = false; if (which === 'producer') producerTimer = undefined; else expiryTimer = undefined;
        if (current(old)) run();
      }, Math.max(0, delay));
      ticket.handle = handle;
      if (handle === undefined) { cleanupUnconfirmed = true; stop('cleanup-unconfirmed'); return false; }
      if (!ticket.live || !current(old)) {
        ticket.live = false; try { options.clearTimer(handle); } catch { cleanupUnconfirmed = true; }
        if ((which === 'producer' ? producerTimer : expiryTimer) === ticket) {
          if (which === 'producer') producerTimer = undefined; else expiryTimer = undefined;
        }
        return false;
      }
      return true;
    } catch {
      // A trusted wrapper that creates native work then throws without its handle cannot prove native cleanup.
      cleanupUnconfirmed = true; ticket.live = false; stop('cleanup-unconfirmed'); return false;
    }
  }
  function compatible(sourceId: string, outputId: string): boolean {
    return localResourcesCompatible(sourceId, outputId);
  }
  function lookup(handle: LocalResourceReview): Review | undefined {
    if (!handle || typeof handle !== 'object') return;
    const review = reviews.get(handle); if (!review || review !== candidate || !review.live || closed || tearing || aborted(owner)) return;
    const at = clock();
    if (candidate !== review || !review.live || closed || aborted(owner) || !Number.isFinite(at)) return;
    if (at >= review.expiresAt) { discard(review); reason = 'review-expired'; notify(); return; }
    return review;
  }
  function publish(handle: LocalResourceReview, value: unknown): Result {
    const old = work;
    if (!old || old.review.handle !== handle || !current(old)) return failed('denied');
    const sourceId = old.review.source.id;
    const at = clock(); if (!fence(old) || !Number.isFinite(at) || at >= old.review.expiresAt) return failed('expired');
    if (publications >= LOCAL_RESOURCE_LIMITS.publications) { stop('quota'); return failed('quota'); }
    // The SDK validates the selected scalar/boolean envelope; no arbitrary value is stored on failure.
    publications++;
    const result = runtime.publish(old.source!, value, { timestamp: at, sequence: ++old.sequence, clockDomain: sessionId,
      provenance: { producer: sourceId === 'page-ticks' ? 'actual-page-timer-callback' : 'actual-page-control-event', physicalDevice: false } });
    if (!result.ok) { notify(); return failed(result.reason); }
    if (!current(old)) return failed('cancelled');
    if (at - old.lastFlush >= 1000 / LOCAL_RESOURCE_LIMITS.maxHz) { old.lastFlush = at; runtime.flush(); }
    else if (sourceId !== 'page-ticks' && !producerTimer?.live) {
      // Reuse the public runtime's latest queue. This timer advances no producer and never restamps the queued sample.
      installTimer('producer', old, 1000 / LOCAL_RESOURCE_LIMITS.maxHz - (at - old.lastFlush), () => {
        const deliveredAt = clock(); if (!current(old) || !Number.isFinite(deliveredAt)) return;
        old.lastFlush = deliveredAt; runtime.flush(); notify();
      });
    }
    notify();
    return result.value.accepted > 0 ? ok() : failed('unavailable');
  }
  function scheduleProducer(old: Work): void {
    if (!current(old) || old.review.source.id !== 'page-ticks') return;
    if (old.tick >= LOCAL_RESOURCE_LIMITS.timerTicks) { stop('quota'); return; }
    installTimer('producer', old, 1000 / LOCAL_RESOURCE_LIMITS.maxHz, () => {
      old.tick++; publish(old.review.handle, old.tick % 101);
      if (current(old)) scheduleProducer(old);
    });
  }
  async function activate(review: Review): Promise<Result> {
    // Approval and compatibility are already pinned; replacement is the only step which retires an incumbent.
    if (work) retire(work, 'replaced');
    if (closed || tearing || aborted(owner) || candidate !== review || !review.live) return failed('cancelled');
    candidate = undefined;
    const old: Work = { review, epoch: ++epoch, phase: 'starting', handles: new Set(), routes: new Set(), detach: new Set(),
      released: false, activeEver: false, tick: 0, sequence: 0, lastFlush: -Infinity }; work = old;
    try {
      if (!current(old, true)) return failed('cancelled');
      old.source = runtime.registerSource({ device: review.source.descriptor, capability: 'value' }); old.handles.add(old.source);
      if (!current(old, true)) return failed('cancelled');
      old.sink = runtime.registerSink({ device: review.output.descriptor, capability: 'value',
        apply(observation, context) {
          if (!deliveryCurrent(old, context)) return;
          const owned = tracked<void>(effects); old.value = observation.value as number | boolean; deliveries++;
          let returned: void | Promise<void>;
          try { returned = options.apply(review.output.id, observation, context); }
          catch (error) { owned.reject(error); if (work === old) { retire(old, 'output-unavailable'); notify(); } return owned.promise; }
          if (returned !== undefined) {
            void Promise.resolve(returned).then(() => { owned.resolve(); notify(); }, error => {
              owned.reject(error); if (work === old) retire(old, 'output-unavailable'); notify();
            });
            return owned.promise;
          }
          owned.resolve(); return;
        }, release() { release(old); } }); old.handles.add(old.sink);
      if (!current(old, true)) return failed('cancelled');
      if (!runtime.setReadiness(old.source, 'available', review.expiresAt).ok ||
          !runtime.setReadiness(old.sink, 'available', review.expiresAt).ok || !current(old, true)) return failed('unavailable');
      // This public wrapper returns the REAL Connection unchanged. It only narrows its lease and observes its lifecycle.
      const boundRuntime: DeviceRuntime = {
        clockDomain: runtime.clockDomain,
        registerSource: provider => runtime.registerSource(provider), registerSink: provider => runtime.registerSink(provider),
        setReadiness: (handle, readiness, expiresAt) => runtime.setReadiness(handle, readiness, expiresAt),
        unregister: handle => runtime.unregister(handle), publish: (handle, value, settings) => runtime.publish(handle, value, settings),
        flush: () => runtime.flush(), revoke: route => runtime.revoke(route), close: () => runtime.close(),
        route(request) {
        if (!current(old, true)) throw Error('Task retired');
        const at = clock(); if (!fence(old, true) || !Number.isFinite(at)) throw Error('Task retired');
        const remaining = Math.floor(review.expiresAt - at); if (remaining < 1) throw Error('Task expired');
        const route = runtime.route({ ...request, leaseMs: Math.min(LOCAL_RESOURCE_LIMITS.lifetimeMs, remaining), queueCapacity: 1,
          constraints: { expiresAt: review.expiresAt, maxHz: LOCAL_RESOURCE_LIMITS.maxHz, maxAgeMs: LOCAL_RESOURCE_LIMITS.maxAgeMs } });
        old.routes.add(route);
        if (!current(old, true)) { route.stop('task-retired'); throw Error('Task retired'); }
        // Provision before onClose: an immediate callback may retire this subscription before it returns its handle.
        // eslint-disable-next-line prefer-const
        let removeReturned: (() => void) | undefined, retired = false;
        const detach = () => { retired = true; removeReturned?.(); }; old.detach.add(detach);
        removeReturned = route.onClose(() => { if (work === old) { retire(old, 'connection-lost'); notify(); } });
        if (retired || !current(old, true)) { removeReturned(); old.detach.delete(detach); route.stop('task-retired'); }
        return route;
      } };
      old.session = createRecipeSession(review.recipe, { runtime: boundRuntime,
        identity: { principalId, applicationId, sessionId }, getEnvironment: () => environment(review),
        requestConsent: () => current(old, true), bind(reference, side) {
          if (!current(old, true) || reference.port !== 'value' || reference.node !== (side === 'from' ? 'input' : 'output')) throw Error('Task binding retired');
          return { device: side === 'from' ? review.source.descriptor : review.output.descriptor,
            capability: 'value', handle: side === 'from' ? old.source! : old.sink! };
        } });
      const started = await old.session.start();
      if (!started.ok || !current(old, true)) return failed(started.ok ? 'cancelled' : started.reason);
      old.phase = 'active'; old.activeEver = true; reason = 'active';
      const at = clock(); if (!current(old) || !Number.isFinite(at)) return failed('cancelled');
      if (!installTimer('expiry', old, review.expiresAt - at, () => { if (work === old) { retire(old, 'expired'); notify(); } })) return failed('cancelled');
      scheduleProducer(old); if (!current(old)) return failed('cancelled'); notify(); return ok();
    } catch { return failed('unavailable'); }
    finally { if (work === old && old.phase !== 'active') { retire(old, 'unavailable'); notify(); } }
  }
  function start(handle: LocalResourceReview): Promise<Result> {
    if (startPending || effects.size || tearing || cleanupUnconfirmed) return Promise.resolve(failed('busy'));
    const review = lookup(handle);
    if (!review) return Promise.resolve(failed('invalid-review'));
    if (!review.sourceGrant || !review.outputGrant || aborted(review.sourceGrant.signal) || aborted(review.outputGrant.signal)) return Promise.resolve(failed('denied'));
    startPending = true;
    // Reserve before activate enters clock/provider/route callbacks. close() sees this work immediately.
    const issued = tracked<Result>(); notify();
    void activate(review).then(result => { startPending = false; issued.resolve(result); notify(); }, () => {
      startPending = false; stop('unavailable'); issued.resolve(failed('unavailable')); notify();
    });
    return issued.promise;
  }
  const ownerAbort = () => stop('owner-revoked');
  if (!closed) Reflect.apply(add, owner, ['abort', ownerAbort, { once: true }]);
  const api: LocalResourceTask = {
    compatible,
    review(sourceId, outputId) {
      if (closed || tearing || startPending || cleanupUnconfirmed || aborted(owner)) return failed('busy');
      if (attempts >= LOCAL_RESOURCE_LIMITS.attempts) return failed('quota');
      if (!compatible(sourceId, outputId)) return failed('incompatible');
      attempts++; const reservedEpoch = epoch, at = clock();
      if (closed || tearing || reservedEpoch !== epoch || aborted(owner) || !Number.isFinite(at)) return failed('cancelled');
      if (candidate) discard(candidate);
      const handle = Object.freeze(Object.create(null)) as LocalResourceReview;
      const source = localResourceChoices.sources.find(item => item.id === sourceId)!, output = localResourceChoices.outputs.find(item => item.id === outputId)!;
      const review: Review = { handle, source, output, recipe: recipeFor(source, output), expiresAt: at + LOCAL_RESOURCE_LIMITS.lifetimeMs, live: true };
      reviews.set(handle, review); candidate = review; reason = 'review-ready'; notify();
      return candidate === review && review.live && !closed && !aborted(owner) ? Object.freeze({ ok: true, value: handle }) : failed('cancelled');
    },
    approve(handle, side) {
      if (side !== 'source' && side !== 'output') return failed('invalid-side');
      const review = lookup(handle); if (!review) return failed('invalid-review');
      if (side === 'source') review.sourceGrant ??= new AbortController(); else review.outputGrant ??= new AbortController();
      reason = 'approval-ready'; notify(); return candidate === review && review.live && !closed && !aborted(owner) ? ok() : failed('cancelled');
    },
    cancel(handle) { const review = lookup(handle); if (!review) return failed('invalid-review'); discard(review); reason = 'cancelled'; notify(); return ok(); },
    decline(handle) { const review = lookup(handle); if (!review) return failed('invalid-review'); discard(review); reason = 'declined'; notify(); return ok(); },
    start, publish,
    revoke(side) { if (side !== 'source' && side !== 'output') return;
      const old = work; if (!old) return; (side === 'source' ? old.review.sourceGrant : old.review.outputGrant)?.abort(); retire(old, 'revoked'); notify(); },
    sweep() { const at = clock(); if (!Number.isFinite(at)) return;
      if (candidate && at >= candidate.expiresAt) { discard(candidate); reason = 'review-expired'; }
      if (work && (!fence(work, true) || at >= work.review.expiresAt)) retire(work, at >= work.review.expiresAt ? 'expired' : 'revoked');
      runtime.flush(); notify(); },
    stop: (why = 'stopped') => stop(why === 'hidden' ? 'hidden' : 'stopped'), snapshot: view,
    close() {
      if (closePromise) return closePromise;
      // Install the returned reservation before stop/release/status callouts can reenter close.
      let complete!: () => void; closePromise = new Promise<void>(resolve => { complete = resolve; });
      closed = true; stop('closed'); Reflect.apply(remove, owner, ['abort', ownerAbort]); runtime.close();
      void (async () => { while (tasks.size) await Promise.allSettled([...tasks]); complete(); notify(); })(); return closePromise;
    },
  };
  return Object.freeze(api);
}
