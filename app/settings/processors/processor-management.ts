import { createDeviceRuntime, createProcessorInstallation, createProcessorFailureController, validateProcessorGraph } from '@101/connect';
import type { AuthorizationRequest, Connection, DeliveryContext, DeviceRuntime, EndpointHandle, Observation,
  ProcessorExtensionActivation, ProcessorFailureController, ProcessorInstallation, ProcessorInstallationAction,
  ProcessorInstallationScope, ProcessorInstallationSnapshot, ProcessorInstallationStorage, ProcessorGraphPlan, RuntimeOptions } from '@101/connect';
import { loadTrustedProcessors } from './trusted-processors.ts';
import type { TrustedProcessorBundle, TrustedProcessorVersion } from './trusted-processors.ts';

export type ManagementVersion = '1.0.0' | '2.0.0';
export type ManagementAction = Exclude<ProcessorInstallationAction, 'read-release'>;
export type ManagementResult<T = undefined> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: string }>;
export interface ManagementReview {
  readonly id: number; readonly action: ManagementAction; readonly version?: ManagementVersion;
}
export interface ProcessorManagementState {
  readonly phase: 'idle' | 'opening' | 'ready' | 'working' | 'stopped' | 'expired' | 'closed';
  readonly reason?: string; readonly managementUntil?: number; readonly review?: ManagementReview;
  readonly installed: readonly Readonly<{ version: string; revoked: boolean }>[];
  readonly selectedVersion?: string; readonly activeVersion?: string; readonly publisherRevoked: boolean;
  readonly indicator: boolean | null; readonly effectCount: number; readonly releaseCount: number;
  readonly rawPending: number; readonly registrations: number; readonly routes: number;
  readonly documentBytes: number; readonly timerArmed: boolean; readonly flushArmed: boolean; readonly attemptsRemaining: number;
  readonly cleanupFailures: number; readonly closurePending: boolean; readonly inputAllowed: boolean; readonly outputAllowed: boolean;
}
export interface ProcessorManagementOptions {
  readonly now?: () => number;
  readonly managementMs?: number;
  readonly load?: () => Promise<TrustedProcessorBundle>;
  /** Trusted fixture callbacks. They never authorize scope or supply executable code remotely. */
  readonly beforeApprove?: (scope: Readonly<ProcessorInstallationScope>) => void | Promise<void>;
  readonly beforeStorage?: (action: 'read' | 'write') => void | Promise<void>;
  readonly allowRoute?: (request: Readonly<AuthorizationRequest>) => boolean;
  readonly makeRuntime?: (options: RuntimeOptions) => DeviceRuntime;
  readonly onEffect?: (value: boolean) => void | Promise<void>;
  readonly onChange?: () => void;
}
export interface ProcessorManagementTask {
  manage(): Promise<ManagementResult>;
  review(action: ManagementAction, version?: ManagementVersion): ManagementResult<ManagementReview>;
  allowInput(review: ManagementReview): ManagementResult;
  allowOutput(review: ManagementReview): ManagementResult;
  confirm(review: ManagementReview): Promise<ManagementResult>;
  decline(review: ManagementReview): ManagementResult;
  sendNumber(value: number): ManagementResult;
  stopLive(): void;
  stopManagement(): void;
  snapshot(): ProcessorManagementState;
  /** Same Promise waits for owned returned work and actual runtime route reservations.
   * This does not promise quiescence of WebCrypto internals hidden by the installer. */
  close(): Promise<void>;
}
interface Scope { readonly id: number; readonly end: number; readonly abort: AbortController }
interface Run {
  readonly scope: Scope; readonly end: number; readonly version: TrustedProcessorVersion; readonly inputApproved: boolean; readonly outputApproved: boolean;
  readonly handles: Set<EndpointHandle>; readonly routes: Set<Connection>; readonly waiting: Set<Connection>; readonly detach: Set<() => void>;
  runtime?: DeviceRuntime; input?: EndpointHandle; output?: EndpointHandle; inputSink?: EndpointHandle; outputSink?: EndpointHandle;
  inputRoute?: Connection; outputRoute?: Connection; activation?: ProcessorExtensionActivation;
  controller?: ProcessorFailureController; plan?: ProcessorGraphPlan;
  retired: boolean; cleaning: boolean; callouts: number; runtimeClosed: boolean; flush?: ReturnType<typeof setTimeout>;
}
class TaskFailure extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}
const good = <T = undefined>(value = undefined as T): ManagementResult<T> => Object.freeze({ ok: true, value });
const bad = (reason: string): ManagementResult<never> => Object.freeze({ ok: false, reason });
const PACKAGE = 'example:temperature-band', PUBLISHER = 'example:local-publisher';
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const aborted = (signal: AbortSignal) => abortedGetter.call(signal) === true;
const versions = new Set(['1.0.0', '2.0.0']);
const actions = new Set(['install', 'activate-reviewed', 'rollback-reviewed', 'revoke-release', 'revoke-publisher', 'remove']);

/** This page owns a single RAM document. No grant, key, factory or live authority is persisted. */
export function createProcessorManagementTask(options: ProcessorManagementOptions = {}): ProcessorManagementTask {
  const clock = options.now ?? (() => Math.floor(performance.now()));
  const load = options.load ?? loadTrustedProcessors, beforeApprove = options.beforeApprove,
    beforeStorage = options.beforeStorage, allowRoute = options.allowRoute,
    makeRuntime = options.makeRuntime ?? createDeviceRuntime, effect = options.onEffect, changed = options.onChange;
  const duration = options.managementMs ?? 30_000;
  if (typeof clock !== 'function' || typeof load !== 'function' || typeof makeRuntime !== 'function' ||
    !Number.isInteger(duration) || duration < 1 || duration > 30_000) throw new TypeError('management-options');
  let phase: ProcessorManagementState['phase'] = 'idle', reason: string | undefined, closed = false;
  let busy = false, generation = 0, attempts = 0, reviewSequence = 0, sequence = 0, lastTime = -1;
  let scope: Scope | undefined, bundle: TrustedProcessorBundle | undefined, store: ProcessorInstallation | undefined;
  let pendingReview: ManagementReview | undefined, allowedReview: ManagementReview | undefined;
  let permissions: { review: ManagementReview; input: boolean; output: boolean } | undefined;
  let latest: ProcessorInstallationSnapshot | undefined, incumbent: Run | undefined, candidate: Run | undefined;
  let indicator: boolean | null = null, effectCount = 0, releaseCount = 0, cleanupFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, storageClosed = false;
  let closePromise: Promise<void> | undefined, resolveClose: (() => void) | undefined;
  const documents = new Map<string, string>(), raw = new Set<Promise<unknown>>(), operations = new Set<Promise<unknown>>();
  const allRuns = new Set<Run>();
  const ownerId = 'page:processor-owner', identity = { principalId: ownerId, applicationId: 'settings-processors', sessionId: 'this-tab' };
  function notify() { try { changed?.(); } catch { /* Fixed diagnostics only; a UI observer cannot revive authority. */ } }
  function finishClose() {
    if (!closed || busy || raw.size || operations.size || [...allRuns].some(run => run.handles.size || run.routes.size)) return;
    storageClosed = true; documents.clear(); bundle = undefined; latest = undefined;
    const done = resolveClose; resolveClose = undefined; done?.();
  }
  function track<T>(call: () => T | Promise<T>): Promise<T> {
    // Reserve before invoking a trusted callback, including synchronous reentry.
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); raw.add(promise);
    void promise.then(() => { raw.delete(promise); finishClose(); notify(); }, () => { raw.delete(promise); finishClose(); notify(); });
    try { resolve(call()); } catch (cause) { reject(cause); }
    return promise;
  }
  function readTime(): number {
    let at: number;
    try { at = clock(); } catch { retireManagement('invalid-clock'); throw new TaskFailure('invalid-clock'); }
    if (!Number.isSafeInteger(at) || at < 0 || at < lastTime) { retireManagement('invalid-clock'); throw new TaskFailure('invalid-clock'); }
    lastTime = at; return at;
  }
  function intrinsic(selected: Scope, at: number): boolean {
    return !closed && scope === selected && !aborted(selected.abort.signal) && at < selected.end;
  }
  function current(selected: Scope): boolean {
    const at = readTime();
    if (!intrinsic(selected, at)) { if (scope === selected && at >= selected.end) retireManagement('expired'); return false; }
    return true;
  }
  function requireCurrent(selected: Scope) { if (!current(selected)) throw new TaskFailure(closed ? 'closed' : scope !== selected ? reason ?? 'stopped' : 'expired'); }
  function countRun(run: Run): boolean { return !run.retired && !closed && scope === run.scope && !aborted(run.scope.abort.signal); }
  function removeHandle(run: Run, handle: EndpointHandle) {
    if (!run.handles.has(handle)) return;
    try { if (run.runtime?.unregister(handle).ok) run.handles.delete(handle); else cleanupFailures++; }
    catch { cleanupFailures++; } // An unknown failed removal stays quarantined, never counted as cleanup.
  }
  function retireRun(run: Run) {
    // Revisit the collection after reentry: a late returned handle must still be cleaned.
    run.retired = true;
    if (run.flush !== undefined) { clearTimeout(run.flush); run.flush = undefined; }
    if (run.cleaning) return;
    run.cleaning = true;
    try {
      for (const detach of [...run.detach]) { run.detach.delete(detach); try { detach(); } catch { cleanupFailures++; } }
      try { run.controller?.stop(); } catch { cleanupFailures++; }
      try { run.activation?.close(); } catch { cleanupFailures++; }
      for (const route of [...run.routes]) {
        if (run.waiting.has(route)) continue;
        run.waiting.add(route);
        try { route.stop('processor-management-stopped'); } catch { cleanupFailures++; }
        const wait = route.whenSettled;
        if (typeof wait === 'function') {
          const pending = track(() => wait.call(route));
          void pending.then(() => { run.routes.delete(route); finishRun(run); }, () => { cleanupFailures++; run.routes.delete(route); finishRun(run); });
        } else { cleanupFailures++; run.routes.delete(route); }
      }
      for (const handle of [...run.handles]) removeHandle(run, handle);
      closeRunRuntime(run);
      if (incumbent === run) { incumbent = undefined; indicator = null; }
      if (candidate === run) candidate = undefined;
    } finally { run.cleaning = false; finishRun(run); }
  }
  function closeRunRuntime(run: Run) {
    if (!run.runtime || run.runtimeClosed || run.callouts) return;
    run.runtimeClosed = true; try { run.runtime.close(); } catch { cleanupFailures++; }
  }
  function finishRun(run: Run) {
    if (run.retired) closeRunRuntime(run);
    if (run.retired && !run.callouts && !run.handles.size && !run.routes.size) allRuns.delete(run);
    finishClose(); notify();
  }
  function retireManagement(why: string) {
    const previous = scope; scope = undefined; generation++; pendingReview = undefined; allowedReview = undefined; permissions = undefined;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    previous?.abort.abort(); store?.close(); store = undefined;
    for (const run of [...allRuns]) retireRun(run);
    phase = closed ? 'closed' : why === 'expired' ? 'expired' : 'stopped'; reason = why; indicator = null; notify(); finishClose();
  }
  function arm(selected: Scope) {
    const at = readTime();
    if (!intrinsic(selected, at)) throw new TaskFailure('expired');
    timer = setTimeout(() => { timer = undefined; if (scope === selected) retireManagement('expired'); }, Math.max(1, selected.end - at));
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  function scheduleFlush(run: Run) {
    if (run.flush !== undefined || !countRun(run)) return;
    const at = readTime();
    if (!intrinsic(run.scope, at)) { retireRun(run); return; }
    if (![...run.routes].some(route => route.status().pending > 0)) return;
    // At most one bounded 10 Hz wakeup drains the real latest/reliable queues.
    // The route's 500 ms age/deadline and original lease bound retained work.
    run.flush = setTimeout(() => {
      run.flush = undefined;
      if (!countRun(run)) return;
      try {
        requireCurrent(run.scope); run.runtime!.flush(); run.runtime!.flush(); scheduleFlush(run);
      } catch { reason = 'interrupted'; retireRun(run); }
      notify();
    }, Math.max(1, Math.min(100, run.end - at)));
    (run.flush as unknown as { unref?: () => void }).unref?.();
  }
  function remaining() { return Math.max(0, 32 - attempts); }
  function reserve(): string | undefined {
    if (closed) return 'closed'; if (busy || raw.size || cleanupFailures) return 'busy';
    if (!remaining()) return 'capacity'; busy = true; attempts++; return undefined;
  }
  function operation(run: () => Promise<ManagementResult>): Promise<ManagementResult> {
    const refusal = reserve(); if (refusal) return Promise.resolve(bad(refusal));
    let resolve!: (value: ManagementResult) => void;
    const returned = new Promise<ManagementResult>(done => { resolve = done; }); operations.add(returned);
    // The reservation exists before run() can execute any caller-supplied clock/provision callback.
    void (async () => {
      try { resolve(await run()); }
      catch (cause) { const why = cause instanceof TaskFailure ? cause.reason : 'unavailable'; reason = why; resolve(bad(why)); }
      finally { busy = false; operations.delete(returned); if (!closed && scope) phase = 'ready'; notify(); finishClose(); }
    })();
    return returned;
  }
  const storage: ProcessorInstallationStorage = {
    read(key) { return track(async () => { await beforeStorage?.('read'); if (storageClosed) throw new TaskFailure('closed'); return documents.get(key); }); },
    compareAndSwap(key, expected, value, guard) { return track(async () => {
      await beforeStorage?.('write');
      if (storageClosed || closed || typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 4 * 1024 * 1024 ||
        key !== `101:processor-installation:${encodeURIComponent(ownerId)}` || documents.get(key) !== expected || aborted(guard.signal)) return false;
      const approved = guard.isCurrent(), at = readTime(), selected = scope;
      if (!approved || !selected || !intrinsic(selected, at) || aborted(guard.signal) || documents.get(key) !== expected) return false;
      documents.set(key, value); return true;
    }); },
    isCurrent(key, expected) { return !storageClosed && !closed && documents.get(key) === expected; },
  };
  function known(version: ManagementVersion | undefined): TrustedProcessorVersion {
    const result = bundle?.versions.find(item => item.release.version === version);
    if (!result) throw new TaskFailure('incompatible'); return result;
  }
  function approve(selected: Scope, request: Readonly<ProcessorInstallationScope>) {
    return track(async () => {
      const review = allowedReview;
      const expectedVersion = review?.version;
      if (!review || request.ownerId !== ownerId || request.action !== review.action ||
        request.packageId !== (review.action === 'revoke-publisher' ? undefined : PACKAGE) ||
        request.publisherId !== (['install', 'activate-reviewed', 'rollback-reviewed', 'revoke-publisher'].includes(review.action) ? PUBLISHER : undefined) ||
        request.version !== expectedVersion) return undefined;
      await beforeApprove?.(request); requireCurrent(selected);
      if (allowedReview !== review) return undefined;
      return Object.freeze({ expiresAt: selected.end, signal: selected.abort.signal,
        isCurrent: () => current(selected) });
    });
  }
  function liveDevice(id: string, capabilities: unknown[]) {
    return { schemaVersion: 1, id, label: 'This page', revision: 1, adapter: { id: 'app:processor-management', version: '1.0.0' },
      runtime: { platform: 'browser' }, capabilities };
  }
  function register(run: Run, call: () => EndpointHandle): EndpointHandle {
    run.callouts++;
    try {
      const handle = call(); run.handles.add(handle);
      if (!countRun(run) || !current(run.scope)) { retireRun(run); throw new TaskFailure('expired'); }
      return handle;
    } finally { run.callouts--; if (run.retired) retireRun(run); }
  }
  function route(run: Run, from: EndpointHandle, to: EndpointHandle): Connection {
    const at = readTime(); if (!countRun(run) || !intrinsic(run.scope, at)) throw new TaskFailure('expired');
    let connection: Connection;
    run.callouts++;
    try {
      connection = run.runtime!.route({ ...identity, from, to, leaseMs: Math.max(1, Math.floor(run.end - at)), queueCapacity: 1 });
      run.routes.add(connection);
    } finally { run.callouts--; if (run.retired) retireRun(run); }
    if (!countRun(run) || !current(run.scope)) { retireRun(run); throw new TaskFailure('expired'); }
    if (typeof connection.whenSettled !== 'function') throw new TaskFailure('incompatible');
    const prepared = connection.prepare(); if (!prepared.ok) throw new TaskFailure(prepared.reason);
    const detach = connection.onClose(() => { if (!run.retired) { reason = 'interrupted'; retireRun(run); notify(); } });
    run.detach.add(detach);
    if (!countRun(run) || !current(run.scope)) { retireRun(run); throw new TaskFailure('expired'); }
    return connection;
  }
  function exactRoute(run: Run, request: Readonly<AuthorizationRequest>): boolean {
    if (request.principalId !== identity.principalId || request.applicationId !== identity.applicationId || request.sessionId !== identity.sessionId || request.partition !== undefined) return false;
    const input = request.source.registrationId === run.input?.id && request.source.deviceId === `app:number-${run.scope.id}-${run.version.release.version}` && request.source.capabilityId === 'number' &&
      request.sink.registrationId === run.inputSink?.id && request.sink.deviceId === `app:rule-${run.scope.id}-${run.version.release.version}` && request.sink.capabilityId === 'input' && request.sinkOperation === 'write';
    const output = request.source.registrationId === run.output?.id && request.source.deviceId === `app:rule-${run.scope.id}-${run.version.release.version}` && request.source.capabilityId === 'output' &&
      request.sink.registrationId === run.outputSink?.id && request.sink.deviceId === `app:indicator-${run.scope.id}-${run.version.release.version}` && request.sink.capabilityId === 'indicator' && request.sinkOperation === 'invoke';
    return (input || output) && request.sourceOperation === 'subscribe' && request.source.descriptorRevision === 1 && request.sink.descriptorRevision === 1 && request.source.schemaVersion === 1 && request.sink.schemaVersion === 1;
  }
  function delivery(run: Run, observation: Observation, context: DeliveryContext, connection: Connection | undefined): number | undefined {
    if (!connection || !countRun(run) || !context.isCurrent() || !run.activation?.isCurrent()) return undefined;
    const bounds = connection.limits(), state = connection.status(), record = context.operationId === undefined ? undefined : connection.operations().find(item => item.id === context.operationId);
    const at = readTime();
    // Last host observer is the clock; publication uses only native/private/numeric facts thereafter.
    const valid = countRun(run) && intrinsic(run.scope, at) && !aborted(context.signal) && context.routeId === connection.id &&
      state.state === 'active' && !!bounds && at < bounds.expiresAt && at < run.end && observation.clockDomain === run.runtime!.clockDomain &&
      Number.isFinite(observation.timestamp) && at >= observation.timestamp && at - observation.timestamp <= bounds.maxAgeMs &&
      (context.operationId === undefined || !!record && record.handlerResult === 'running' && at < record.deadline);
    return valid ? at : undefined;
  }
  function prepareRun(selected: Scope, version: TrustedProcessorVersion): Run {
    const run: Run = { scope: selected, end: selected.end, version, inputApproved: permissions?.input === true, outputApproved: permissions?.output === true, handles: new Set(), routes: new Set(), waiting: new Set(), detach: new Set(), retired: false, cleaning: false, callouts: 0, runtimeClosed: false };
    candidate = run; allRuns.add(run);
    const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 }, boolean = { type: 'boolean' };
    const source = liveDevice(`app:number-${selected.id}-${version.release.version}`, [{ id: 'number', semantic: 'app:entered-temperature', schemaVersion: 1,
      kind: 'sample', value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 500 }, permissions: ['subscribe'] }]);
    const rule = liveDevice(`app:rule-${selected.id}-${version.release.version}`, [
      { id: 'input', semantic: 'app:entered-temperature', schemaVersion: 1, kind: 'property', value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 500 }, permissions: ['write'], ownership: { mode: 'observe' } },
      { id: 'output', semantic: 'app:threshold-switch', schemaVersion: 1, kind: 'event', value: boolean, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['subscribe'] },
    ]);
    const target = liveDevice(`app:indicator-${selected.id}-${version.release.version}`, [{ id: 'indicator', semantic: 'app:threshold-switch', schemaVersion: 1,
      kind: 'command', value: boolean, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['invoke'], ownership: { mode: 'exclusive' } }]);
    run.callouts++;
    try { run.runtime = makeRuntime({ now: clock, clockDomain: 'processor-management:monotonic', maxRoutes: 2, maxSubscribers: 2, maxRegistrations: 4,
      // Two run runtimes together retain at most two delivery reservations.
      maxPendingDeliveries: 1, maxPendingDeliveriesPerScope: 1, authorize(request) {
        if (!countRun(run) || !exactRoute(run, request) ||
          (request.sinkOperation === 'write' ? !run.inputApproved : !run.outputApproved)) return undefined;
        const allowed = !allowRoute || allowRoute(request) === true, at = readTime();
        if (!allowed || !countRun(run) || !intrinsic(selected, at)) return undefined;
        return { expiresAt: run.end, maxHz: 10, maxAgeMs: 500 };
      } }); } finally { run.callouts--; }
    if (!countRun(run) || !current(selected)) { retireRun(run); throw new TaskFailure('expired'); }
    run.input = register(run, () => run.runtime!.registerSource({ device: source, capability: 'number' }));
    run.output = register(run, () => run.runtime!.registerSource({ device: rule, capability: 'output' }));
    run.inputSink = register(run, () => run.runtime!.registerSink({ device: rule, capability: 'input', apply(observation, context) {
      const at = delivery(run, observation, context, run.inputRoute); if (at === undefined) return;
      if (sequence >= 32) { reason = 'capacity'; retireRun(run); notify(); return; }
      run.controller!.run('rule', { temperature: observation.value }, { switch: { operationId: String(++sequence), deadline: Math.min(run.end, at + 500) } });
    }, release() {} }));
    run.outputSink = register(run, () => run.runtime!.registerSink({ device: target, capability: 'indicator', apply(observation, context) {
      if (delivery(run, observation, context, run.outputRoute) === undefined || typeof observation.value !== 'boolean') return;
      const value = observation.value; indicator = value; effectCount++;
      context.reportEvidence('observed'); // Observation of the owned application field only, never physical state.
      if (!effect) { notify(); return; }
      // A synchronous callout reservation protects close reentry even before the return is known.
      let release!: () => void; const reservation = new Promise<void>(resolve => { release = resolve; }); raw.add(reservation);
      try {
        const returned = effect(value);
        if (returned !== undefined) {
          const pending = Promise.resolve(returned); raw.add(pending);
          void pending.then(() => { raw.delete(pending); finishClose(); notify(); }, () => { raw.delete(pending); finishClose(); notify(); });
          notify(); return pending;
        }
        notify();
      } finally { raw.delete(reservation); release(); finishClose(); }
    }, release() { releaseCount++; indicator = null; notify(); } }));
    for (const handle of run.handles) {
      const ready = run.runtime.setReadiness(handle, 'available', selected.end);
      if (!ready.ok) throw new TaskFailure(ready.reason);
      if (!countRun(run) || !current(selected)) throw new TaskFailure('expired');
    }
    run.inputRoute = route(run, run.input, run.inputSink); run.outputRoute = route(run, run.output, run.outputSink);
    // The graph is independently validated using the same real descriptors and signed manifest.
    const graph = validateProcessorGraph({ schemaVersion: 1, nodes: [
      { id: 'number', kind: 'resource', direction: 'source', device: source, capability: 'number' },
      { id: 'rule', kind: 'processor', manifest: version.release.manifest },
      { id: 'indicator', kind: 'resource', direction: 'sink', device: target, capability: 'indicator' },
    ], edges: [{ from: { node: 'number', port: 'number' }, to: { node: 'rule', port: 'temperature' } },
      { from: { node: 'rule', port: 'switch' }, to: { node: 'indicator', port: 'indicator' } }] });
    // Store the validated plan on the closure, without exposing a fake processor or starting a route.
    run.plan = graph;
    return run;
  }
  async function activate(selected: Scope, version: TrustedProcessorVersion, rollback: boolean): Promise<ManagementResult> {
    let run: Run | undefined;
    try {
      run = prepareRun(selected, version); const prepared = run;
      const result = await store![rollback ? 'rollbackReviewed' : 'activateReviewed']({ packageId: PACKAGE,
        version: version.release.version, codeSha256: version.release.source.sha256, trusted: version.trusted,
        fixture: version.fixture, configuration: { onAt: 30, offAt: 28 }, retireOwned() { retireRun(prepared); notify(); } });
      if (!result.ok) { retireRun(run); return bad(result.reason); }
      run.activation = result.value;
      requireCurrent(selected); if (!countRun(run)) throw new TaskFailure('interrupted');
      const input = run.inputRoute!.activate(); if (!input.ok) throw new TaskFailure(input.reason);
      const output = run.outputRoute!.activate(); if (!output.ok) throw new TaskFailure(output.reason);
      run.controller = createProcessorFailureController({ plan: run.plan!, runtime: run.runtime!, now: clock,
        bindings: [{ node: 'rule', processor: result.value.processor, outputs: { switch: run.output! }, inputRoutes: [run.inputRoute!] }] });
      requireCurrent(selected); if (!countRun(run) || !result.value.isCurrent()) throw new TaskFailure('interrupted');
      if (incumbent && incumbent !== run) retireRun(incumbent);
      incumbent = run; candidate = undefined; reason = undefined; indicator = null;
      return good();
    } catch (cause) {
      if (run) retireRun(run); else if (candidate) retireRun(candidate);
      return bad(cause instanceof TaskFailure ? cause.reason : 'unavailable');
    }
  }
  async function refresh(selected: Scope) {
    const result = await store!.inspect(); requireCurrent(selected);
    if (!result.ok) throw new TaskFailure(result.reason); latest = result.value;
  }
  function snapshot(): ProcessorManagementState {
    const item = latest?.packages.find(value => value.packageId === PACKAGE);
    return Object.freeze({ phase, ...(reason ? { reason } : {}), ...(scope ? { managementUntil: scope.end } : {}),
      ...(pendingReview ? { review: pendingReview } : {}), installed: Object.freeze((item?.releases ?? []).map(value => Object.freeze({ version: value.release.version, revoked: value.revoked }))),
      ...(item?.selectedVersion ? { selectedVersion: item.selectedVersion } : {}),
      ...(incumbent && !incumbent.retired ? { activeVersion: incumbent.version.release.version } : {}),
      publisherRevoked: latest?.revokedPublishers.includes(PUBLISHER) ?? false, indicator, effectCount, releaseCount,
      rawPending: raw.size, registrations: [...allRuns].reduce((n, run) => n + run.handles.size, 0),
      routes: [...allRuns].reduce((n, run) => n + run.routes.size, 0), documentBytes: [...documents.values()].reduce((n, value) => n + new TextEncoder().encode(value).byteLength, 0),
      timerArmed: timer !== undefined, flushArmed: [...allRuns].some(run => run.flush !== undefined), attemptsRemaining: remaining(), cleanupFailures, closurePending: closed && !!resolveClose,
      inputAllowed: permissions?.input ?? false, outputAllowed: permissions?.output ?? false });
  }
  const task: ProcessorManagementTask = {
    manage() { return operation(async () => {
      if (scope) return bad('busy'); phase = 'opening'; reason = undefined;
      const before = generation, at = readTime();
      if (closed || generation !== before) throw new TaskFailure('closed');
      const selected: Scope = { id: ++generation, end: at + duration, abort: new AbortController() };
      scope = selected; arm(selected); notify();
      try {
        const supplied = await track(load); requireCurrent(selected);
        if (supplied.publisherId !== PUBLISHER || supplied.minimumSequence !== 1 || supplied.versions.length !== 2 ||
          !supplied.versions.every(value => versions.has(value.release.version) && value.release.packageId === PACKAGE && value.release.publisherId === PUBLISHER)) throw new TaskFailure('untrusted');
        bundle = supplied;
        store = createProcessorInstallation({ ownerId, storage, now: clock,
          publisherTrust(id) { return id === PUBLISHER && scope === selected && !aborted(selected.abort.signal) ? { key: supplied.key, minimumSequence: supplied.minimumSequence } : undefined; },
          authorize: request => approve(selected, request) });
        requireCurrent(selected); await refresh(selected); phase = 'ready'; return good();
      } catch (cause) { retireManagement(cause instanceof TaskFailure ? cause.reason : 'unavailable'); throw cause; }
    }); },
    review(action, version) {
      if (closed) return bad('closed'); if (busy || raw.size || cleanupFailures) return bad('busy');
      if (!scope || !current(scope)) return bad('expired');
      if (!actions.has(action) || (['install', 'activate-reviewed', 'rollback-reviewed', 'revoke-release'].includes(action) ? !versions.has(version ?? '') : version !== undefined)) return bad('incompatible');
      if (!remaining()) return bad('capacity');
      pendingReview = Object.freeze({ id: ++reviewSequence, action, ...(version ? { version } : {}) });
      permissions = { review: pendingReview, input: false, output: false }; reason = undefined; notify(); return good(pendingReview);
    },
    allowInput(review) {
      if (!scope || !current(scope) || busy || pendingReview !== review || permissions?.review !== review ||
        !['activate-reviewed', 'rollback-reviewed'].includes(review.action)) return bad('invalid-review');
      permissions.input = true; notify(); return good();
    },
    allowOutput(review) {
      if (!scope || !current(scope) || busy || pendingReview !== review || permissions?.review !== review ||
        !['activate-reviewed', 'rollback-reviewed'].includes(review.action)) return bad('invalid-review');
      permissions.output = true; notify(); return good();
    },
    confirm(review) { return operation(async () => {
      const selected = scope;
      if (!selected || pendingReview !== review) return bad('invalid-review'); requireCurrent(selected);
      if (['activate-reviewed', 'rollback-reviewed'].includes(review.action) &&
        (permissions?.review !== review || !permissions.input || !permissions.output)) return bad('denied');
      pendingReview = undefined; allowedReview = review; phase = 'working'; notify();
      try {
        let outcome: ManagementResult;
        if (review.action === 'activate-reviewed' || review.action === 'rollback-reviewed') outcome = await activate(selected, known(review.version), review.action === 'rollback-reviewed');
        else {
          const result = review.action === 'install' ? await store!.install(known(review.version).release, known(review.version).trusted.source)
            : review.action === 'revoke-release' ? await store!.revokeRelease(PACKAGE, review.version!)
              : review.action === 'revoke-publisher' ? await store!.revokePublisher(PUBLISHER) : await store!.remove(PACKAGE);
          outcome = result.ok ? good() : bad(result.reason);
          if (result.ok) latest = result.value;
        }
        requireCurrent(selected);
        if (outcome.ok) await refresh(selected); else reason = outcome.reason;
        return outcome;
      } finally { if (allowedReview === review) allowedReview = undefined; }
    }); },
    decline(review) {
      if (closed) return bad('closed'); if (busy || pendingReview !== review) return bad('invalid-review');
      pendingReview = undefined; permissions = undefined; reason = 'declined'; notify(); return good();
    },
    sendNumber(value) {
      if (busy) return bad('busy'); const run = incumbent;
      if (!run || !countRun(run) || !current(run.scope)) return bad('inactive');
      if (!Number.isFinite(value) || value < -40 || value > 125) return bad('invalid');
      if (sequence >= 32) return bad('capacity');
      const at = readTime(); if (!countRun(run) || !intrinsic(run.scope, at)) return bad('expired');
      const result = run.runtime!.publish(run.input!, value, { timestamp: at, clockDomain: run.runtime!.clockDomain,
        provenance: { kind: 'page-entered-number', unit: 'Cel' } });
      if (!result.ok) return bad(result.reason); if (!result.value.accepted) return bad('unavailable');
      run.runtime!.flush(); run.runtime!.flush(); scheduleFlush(run); notify(); return good();
    },
    stopLive() { for (const run of [...allRuns]) retireRun(run); indicator = null; reason = 'live-stopped'; notify(); },
    stopManagement() { retireManagement('stopped'); }, snapshot,
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>(done => { resolveClose = done; }); closed = true;
      retireManagement('closed'); finishClose(); return closePromise;
    },
  };
  return Object.freeze(task);
}
