import { createIndexedDbOwnerDataStorage, createOwnerDataController, createTelemetryHistory, parseValueSchema } from '@101/connect';
import type { OwnerDataController, OwnerDataDeletion, OwnerDataPorts, OwnerDataScope, OwnerDataStorage,
  TelemetryCaptureHandle, TelemetryEntry, TelemetryHistory, TelemetryRecord, ValueSchema } from '@101/connect';

export const HISTORY_OWNER = 'app-player-history:this-browser';
export const HISTORY_DATABASE = 'app-player-history-managed-v1';
export const HISTORY_LIMITS = Object.freeze({ managementMs: 30000, sessions: 8, operations: 64, rows: 32,
  bytes: 65536, acceptedPerCapture: 16, sampleMs: 1000, exportPages: 4, exportPageRows: 32, exportBytes: 262144 });
export const HISTORY_RESOURCES = Object.freeze([
  Object.freeze({ id: 'browser-page:viewport', label: 'Page size', fields: Object.freeze(['width', 'height']), maximum: 16384 }),
  Object.freeze({ id: 'browser-page:scroll', label: 'Page position', fields: Object.freeze(['left', 'top']), maximum: 1000000 }),
]);
type Resource = typeof HISTORY_RESOURCES[number];
export type HistoryAction = 'manage' | 'capture' | 'export' | 'delete' | 'resume-delete' | 'sweep';
type Message = 'arrival' | 'review' | 'loading' | 'ready' | 'collecting' | 'collection-stopped' | 'exported' | 'pending-deletion' |
  'deleted' | 'swept' | 'cancelled' | 'stopped' | 'expired' | 'wrong-owner' | 'incompatible' | 'corrupt' | 'unavailable' | 'limit';
export interface HistoryTaskState {
  readonly active: boolean; readonly pending: boolean; readonly message: Message; readonly selectedResource: string;
  readonly count: number; readonly partial: boolean; readonly deadline?: number;
  readonly capture?: Readonly<{ resourceId: string; deadline: number }>;
  readonly review?: Readonly<{ action: HistoryAction; token: object; resourceId: string; retentionMs: number }>;
  readonly canCapture: boolean; readonly canExport: boolean; readonly canDelete: boolean; readonly canResume: boolean; readonly canSweep: boolean;
}
export interface HistoryStorageSession { readonly storage: OwnerDataStorage; close(): Promise<void> }
export interface HistoryExportDocument { readonly resourceId: string; readonly bytes: Uint8Array }
export interface HistoryExportContext { readonly signal: AbortSignal; readonly expiresAt: number; isCurrent(): boolean }
export interface HistoryTaskOptions {
  readonly now?: () => number;
  readonly sourceClock?: () => Readonly<{ clockId: string; at: number }>;
  readonly createStorage?: () => HistoryStorageSession | Promise<HistoryStorageSession>;
  readonly observePage?: (resourceId: string, receive: (values: Readonly<Record<string, number>>) => void) => { stop(): void };
  readonly deliverExport?: (document: HistoryExportDocument, context: HistoryExportContext) => void | Promise<void>;
  readonly onChange?: (state: HistoryTaskState) => void;
}
export interface HistoryTask {
  snapshot(): HistoryTaskState;
  review(action: HistoryAction, details?: Readonly<{ resourceId?: string; retentionMs?: number }>): object | undefined;
  decide(token: object, allow: boolean): Promise<void>;
  selectResource(resourceId: string): Promise<void>;
  flushCapture(): Promise<void>;
  refresh(): Promise<void>;
  stopCapture(): void;
  stop(): void;
  close(): Promise<void>;
}
const abortState = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const listen = EventTarget.prototype.addEventListener, unlisten = EventTarget.prototype.removeEventListener;
function aborted(signal: AbortSignal) { try { return abortState.call(signal) !== false; } catch { return true; } }
function object(input: unknown): Record<string, unknown> | undefined {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return;
    const keys = Reflect.ownKeys(input); if (keys.length > 8) return;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') return;
      const item = Object.getOwnPropertyDescriptor(input, key); if (!item?.enumerable || !('value' in item)) return;
      result[key] = item.value;
    }
    return result;
  } catch { return; }
}
const profile = (id: string) => HISTORY_RESOURCES.find(value => value.id === id);
function valueSchema(resource: Resource): ValueSchema {
  const fields: Record<string, ValueSchema> = Object.create(null);
  for (const key of resource.fields) fields[key] = { type: 'scalar', unit: 'px', min: 0, max: resource.maximum };
  return parseValueSchema({ type: 'record', fields });
}
const nativeSessions = new WeakMap<IDBFactory, Promise<void>>();

/** SDK atomic storage, with actual native open/returned transaction settlement
 * retained separately from the SDK's logical blocked/5-second refusal. */
export function createHistoryStorageSession(factory: IDBFactory = globalThis.indexedDB): HistoryStorageSession {
  if (!factory || nativeSessions.has(factory)) throw Error('unavailable');
  let finishSession!: () => void;
  const lifetime = new Promise<void>(resolve => { finishSession = resolve; });
  nativeSessions.set(factory, lifetime);
  let retired = false, opening = false, closing: Promise<void> | undefined;
  const issued = new Set<Promise<unknown>>();
  let adapter: ReturnType<typeof createIndexedDbOwnerDataStorage>;
  try {
    const nativeOpen = factory.open, observed = Object.create(factory) as IDBFactory;
    Object.defineProperty(observed, 'open', { value(name: string, version?: number) {
      if (retired || opening || name !== HISTORY_DATABASE || version !== 1) throw Error('unavailable');
      opening = true;
      let finish!: () => void;
      const work = new Promise<void>(resolve => { finish = resolve; }); issued.add(work);
      let request: IDBOpenDBRequest;
      try { request = nativeOpen.call(factory, name, version); }
      catch (error) { opening = false; issued.delete(work); finish(); throw error; }
      let settled = false;
      const terminal = () => {
        if (settled) return; settled = true;
        unlisten.call(request, 'success', terminal); unlisten.call(request, 'error', terminal);
        if (retired) { try { request.result.close(); } catch { /* Failed request has no database. */ } }
        opening = false; issued.delete(work); finish();
      };
      // Native terminal events coexist with the SDK on* handlers. Blocked is
      // deliberately not terminal; no request or database is invented.
      listen.call(request, 'success', terminal); listen.call(request, 'error', terminal);
      return request;
    } });
    adapter = createIndexedDbOwnerDataStorage({ databaseName: HISTORY_DATABASE, indexedDB: observed });
  } catch (error) { nativeSessions.delete(factory); finishSession(); throw error; }
  const storage: OwnerDataStorage = Object.freeze({
    transact<T>(ownerId: string, mutation: (current: unknown) => { state: unknown; result: T }, guard?: Parameters<OwnerDataStorage['transact']>[2]): Promise<T> {
      if (retired || ownerId !== HISTORY_OWNER) return Promise.reject(Error('unavailable'));
      let finish!: () => void;
      const reservation = new Promise<void>(resolve => { finish = resolve; }); issued.add(reservation);
      let work: Promise<T>;
      try { work = adapter.transact(ownerId, mutation, guard); }
      catch (error) { issued.delete(reservation); finish(); return Promise.reject(error); }
      void work.then(() => { issued.delete(reservation); finish(); }, () => { issued.delete(reservation); finish(); });
      return work;
    },
  });
  return Object.freeze({ storage, close() {
    if (closing) return closing;
    let finish!: () => void; closing = new Promise<void>(resolve => { finish = resolve; });
    retired = true; adapter.close();
    void Promise.allSettled([...issued]).then(() => {
      if (nativeSessions.get(factory) === lifetime) nativeSessions.delete(factory);
      finishSession(); finish();
    });
    return closing;
  } });
}

interface Capture {
  readonly resource: Resource; readonly deadline: number; readonly abort: AbortController;
  readonly history: TelemetryHistory; handle?: TelemetryCaptureHandle; observation?: { stop(): void };
  latest?: TelemetryEntry; accepted: number; lastCommit: number;
}
interface Lease {
  readonly generation: number; readonly deadline: number; readonly abort: AbortController;
  readonly accepted: Map<string, number>; readonly lastCommit: Map<string, number>;
  session?: HistoryStorageSession; owner?: OwnerDataController; ports?: OwnerDataPorts; capture?: Capture;
  deletion?: OwnerDataDeletion; scope?: Readonly<{ action: OwnerDataScope['action']; request: Readonly<Record<string, unknown>> }>;
  cleanup?: Promise<void>;
}
interface Review { readonly action: HistoryAction; readonly token: object; readonly generation: number;
  readonly deadline: number; readonly resourceId: string; readonly retentionMs: number; readonly operationId?: string }

/** Construction is inert. Every storage, observation or download effect starts
 * only under a live exact review. All injected callbacks are trusted host code. */
export function createHistoryTask(options: HistoryTaskOptions = {}): HistoryTask {
  const clock = options.now ?? Date.now, makeStorage = options.createStorage ?? (() => createHistoryStorageSession());
  const sourceClock = options.sourceClock ?? (() => {
    pageClock ??= `browser-page:${crypto.randomUUID()}`;
    return { clockId: pageClock, at: performance.now() };
  });
  const observe = options.observePage ?? observeNativePage, deliver = options.deliverExport ?? deliverNativeExport;
  let pageClock: string | undefined, closed = false, generation = 0, sessions = 0, operations = 0, lastNow = -1, notifying = false;
  let lease: Lease | undefined, review: Review | undefined, pending: Promise<void> | undefined, closing: Promise<void> | undefined;
  const cleanups = new Set<Promise<void>>();
  let timer: ReturnType<typeof setTimeout> | undefined, drainTimer: ReturnType<typeof setTimeout> | undefined;
  let selected = HISTORY_RESOURCES[0]!.id as string, count = 0, partial = false, message: Message = 'arrival';
  function snapshot(): HistoryTaskState {
    const enabled = !!lease?.ports && !lease.deletion;
    return Object.freeze({ active: !!lease, pending: !!pending || cleanups.size > 0, message, selectedResource: selected, count, partial,
      ...(lease ? { deadline: lease.deadline } : {}),
      ...(lease?.capture ? { capture: Object.freeze({ resourceId: lease.capture.resource.id, deadline: lease.capture.deadline }) } : {}),
      ...(review ? { review: Object.freeze({ action: review.action, token: review.token, resourceId: review.resourceId, retentionMs: review.retentionMs }) } : {}),
      canCapture: enabled && (lease?.accepted.get(selected) ?? 0) < HISTORY_LIMITS.acceptedPerCapture,
      canExport: enabled, canDelete: enabled, canResume: !!lease?.deletion, canSweep: enabled });
  }
  function publish() {
    if (notifying) return;
    notifying = true;
    try { options.onChange?.(snapshot()); } catch { /* Notification never grants authority. */ }
    finally { notifying = false; }
  }
  function trackCleanup(work: Promise<void>) {
    cleanups.add(work);
    void work.then(() => { cleanups.delete(work); publish(); }, () => { message = 'unavailable'; publish(); });
    return work;
  }
  function retireCapture(value: Lease) {
    clearTimeout(drainTimer); drainTimer = undefined;
    const capture = value.capture; value.capture = undefined;
    if (!capture) return;
    capture.abort.abort(); capture.latest = undefined;
    if (capture.handle) capture.history.revoke(capture.handle);
    capture.history.close();
    const observation = capture.observation; capture.observation = undefined;
    try { observation?.stop(); } catch { message = 'unavailable'; }
  }
  function closeLease(value: Lease): Promise<void> {
    value.abort.abort(); retireCapture(value); value.ports?.close(); value.ports = undefined; value.owner?.close();
    if (!value.session) return Promise.resolve(); // Late factories are still held by pending.
    if (value.cleanup) return value.cleanup;
    let finish!: () => void, reject!: (reason: unknown) => void;
    const raw = new Promise<void>((yes, no) => { finish = yes; reject = no; }); value.cleanup = raw; trackCleanup(raw);
    try { Promise.resolve(value.session.close()).then(finish, reject); } catch (error) { reject(error); }
    return raw;
  }
  function retire(next: Message) {
    generation++; clearTimeout(timer); timer = undefined; review = undefined;
    const old = lease; lease = undefined; message = next; count = 0; partial = false;
    if (old) { void closeLease(old); } publish();
  }
  function now(): number {
    let value: unknown; try { value = clock(); } catch { retire('unavailable'); throw Error('unavailable'); }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value < lastNow || value > Number.MAX_SAFE_INTEGER - 30 * 86400000) {
      retire('unavailable'); throw Error('unavailable');
    }
    lastNow = value; return value;
  }
  function intrinsicCurrent(value: Lease) { return !closed && lease === value && generation === value.generation && !aborted(value.abort.signal); }
  function current(value: Lease) {
    if (!intrinsicCurrent(value)) return false;
    let at: number; try { at = now(); } catch { return false; }
    if (!intrinsicCurrent(value)) return false;
    if (at >= value.deadline) { retire('expired'); return false; }
    return true;
  }
  function captureCurrent(value: Lease, capture: Capture) {
    return current(value) && value.capture === capture && !aborted(capture.abort.signal) && lastNow < capture.deadline;
  }
  function arm(deadline: number, expected: number) {
    clearTimeout(timer); timer = undefined;
    let at: number; try { at = now(); } catch { return; }
    if (closed || generation !== expected) return;
    if (at >= deadline) { retire('expired'); return; }
    timer = setTimeout(() => { if (!closed && generation === expected) retire('expired'); }, deadline - at);
  }
  function start(action: () => Promise<void>): Promise<void> {
    if (closed || pending || cleanups.size || operations >= HISTORY_LIMITS.operations) {
      if (!closed && operations >= HISTORY_LIMITS.operations) retire('limit'); return Promise.resolve();
    }
    operations++;
    let finish!: () => void; const work = new Promise<void>(resolve => { finish = resolve; }); pending = work;
    // Publish the reservation before any clock/factory/observer callout.
    publish();
    void Promise.resolve().then(action).catch(() => { if (lease) retire('unavailable'); }).finally(() => {
      if (pending === work) pending = undefined; finish(); publish(); scheduleDrain();
    });
    return work;
  }
  function guardStorage(value: Lease, storage: OwnerDataStorage): OwnerDataStorage {
    return Object.freeze({ async transact<T>(ownerId: string, mutation: (raw: unknown) => { state: unknown; result: T }, guard?: Parameters<OwnerDataStorage['transact']>[2]): Promise<T> {
      if (ownerId !== HISTORY_OWNER || !current(value)) throw Error('unavailable');
      const capture = value.capture;
      const commit = new AbortController(), signals = [value.abort.signal, ...(capture ? [capture.abort.signal] : []), ...(guard ? [guard.signal] : [])];
      const abort = () => commit.abort();
      try {
        for (const signal of signals) { listen.call(signal, 'abort', abort); if (aborted(signal)) abort(); }
        if (!current(value) || aborted(commit.signal)) throw Error('unavailable');
        return await storage.transact(ownerId, mutation, { signal: commit.signal, isCurrent() {
          if (!current(value) || aborted(commit.signal)) return false;
          let permitted = false; try { permitted = !guard || guard.isCurrent() === true; } catch { return false; }
          // All observer callouts finish before the final fresh numeric clock.
          // Then only intrinsic signal/epoch reads remain at this guard boundary.
          let at: number; try { at = now(); } catch { return false; }
          if (at >= value.deadline) { retire('expired'); return false; }
          return permitted && intrinsicCurrent(value) && (!capture || value.capture === capture && at < capture.deadline) &&
            signals.every(signal => !aborted(signal)) && !aborted(commit.signal);
        } });
      } finally { for (const signal of signals) unlisten.call(signal, 'abort', abort); }
    } });
  }
  function authorize(value: Lease, scope: OwnerDataScope) {
    if (!current(value) || scope.ownerId !== HISTORY_OWNER || scope.action !== value.scope?.action ||
      JSON.stringify(scope.request) !== JSON.stringify(value.scope.request)) return undefined;
    if (!current(value)) return undefined;
    return Object.freeze({ scope, expiresAt: Math.min(scope.deadline, value.deadline), signal: value.abort.signal, isCurrent: () => current(value) });
  }
  async function ownerCall<T>(value: Lease, action: OwnerDataScope['action'], request: Readonly<Record<string, unknown>>, run: () => Promise<T>): Promise<T> {
    if (!current(value) || value.scope) throw Error('unavailable');
    const permitted = Object.freeze({ action, request }); value.scope = permitted;
    try { return await run(); } finally { if (value.scope === permitted) value.scope = undefined; }
  }
  function failure(reason: string) {
    retire(reason === 'wrong-owner' || reason === 'incompatible' || reason === 'corrupt' ? reason : 'unavailable');
  }
  async function project(value: Lease, resourceId: string, destination: 'inspect' | 'download') {
    const resource = profile(resourceId); if (!resource || !value.owner || !current(value)) throw Error('unavailable');
    const rows: TelemetryRecord[] = []; let cursor: Parameters<OwnerDataController['exportPage']>[0]['cursor'];
    for (let page = 0; page < HISTORY_LIMITS.exportPages; page++) {
      const request = Object.freeze({ kind: 'telemetry' as const, purpose: destination === 'inspect' ? 'player-history-inspect' : 'player-history-export',
        destinationId: destination === 'inspect' ? 'current-history-page' : 'browser-download', resourceId,
        fields: resource.fields, limit: HISTORY_LIMITS.exportPageRows, ...(cursor ? { cursor } : {}) });
      const result = await ownerCall(value, 'export', request, () => value.owner!.exportPage(request));
      if (!current(value)) throw Error('unavailable');
      if (!result.ok) { failure(result.reason); throw Error('unavailable'); }
      rows.push(...result.value.records as readonly TelemetryRecord[]);
      if (rows.length > HISTORY_LIMITS.rows || new TextEncoder().encode(JSON.stringify(rows)).byteLength > HISTORY_LIMITS.exportBytes) throw Error('capacity');
      if (!result.value.next) return rows;
      cursor = result.value.next;
    }
    throw Error('capacity');
  }
  async function refreshValue(value: Lease) {
    if (!current(value) || value.deletion) return;
    const resourceId = selected, rows = await project(value, resourceId, 'inspect');
    if (current(value) && selected === resourceId) { count = rows.length; partial = false; }
  }
  async function manage(approved: Review) {
    const expected = generation;
    if (closed || lease || expected !== approved.generation || now() >= approved.deadline || generation !== expected || lease) return;
    if (++sessions > HISTORY_LIMITS.sessions) { message = 'limit'; return; }
    const value: Lease = { generation, deadline: approved.deadline, abort: new AbortController(), accepted: new Map(), lastCommit: new Map() };
    lease = value; message = 'loading'; publish(); arm(value.deadline, value.generation);
    if (!current(value)) return;
    const session = await makeStorage(); value.session = session;
    if (!current(value)) { await closeLease(value); return; }
    value.owner = createOwnerDataController({ ownerId: HISTORY_OWNER, storage: guardStorage(value, session.storage), trustedNow: now,
      authorize: scope => authorize(value, scope), availableDevices: () => [] });
    const opened = await ownerCall(value, 'open-stores', Object.freeze({ kinds: ['telemetry', 'settings', 'artifacts', 'copies'], artifactRetentionMs: 7 * 86400000 }),
      () => value.owner!.openStores({ retireOwned() { retireCapture(value); value.ports?.close(); value.ports = undefined; } }));
    if (!current(value)) { if (opened.ok) opened.value.close(); await closeLease(value); return; }
    if (!opened.ok) {
      if (opened.reason === 'review-required') {
        const deletion = await value.owner.inspectDeletion();
        if (!current(value)) return;
        if (deletion.ok && deletion.value?.state === 'pending' && profile(deletion.value.telemetryResourceId ?? '')) {
          value.deletion = deletion.value; selected = deletion.value.telemetryResourceId!; count = 0; message = 'pending-deletion'; return;
        }
      }
      failure(opened.reason); return;
    }
    value.ports = opened.value; await refreshValue(value);
    if (current(value)) message = 'ready';
  }
  function observation(value: Lease, capture: Capture, input: Readonly<Record<string, number>>) {
    if (!captureCurrent(value, capture) || capture.accepted >= HISTORY_LIMITS.acceptedPerCapture) return;
    const values = object(input);
    if (!values || Object.keys(values).length !== capture.resource.fields.length || Object.keys(values).some(key => !capture.resource.fields.includes(key))) return;
    for (const field of capture.resource.fields) {
      const entry = values[field]; if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > capture.resource.maximum) return;
    }
    if (!captureCurrent(value, capture)) return;
    let stamp: Record<string, unknown> | undefined;
    try { stamp = object(sourceClock()); } catch { return; }
    if (!stamp || Object.keys(stamp).length !== 2 || typeof stamp.clockId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stamp.clockId) ||
      typeof stamp.at !== 'number' || !Number.isFinite(stamp.at) || stamp.at < 0 || stamp.at > Number.MAX_SAFE_INTEGER || !captureCurrent(value, capture)) return;
    capture.latest = Object.freeze({ sourceTime: Object.freeze({ clockId: stamp.clockId, at: stamp.at }), quality: 'observed',
      values: Object.freeze(values as Record<string, number>) }); scheduleDrain();
  }
  async function beginCapture(value: Lease, approved: Review) {
    if (!current(value) || !value.ports || !profile(approved.resourceId)) return;
    if ((value.accepted.get(approved.resourceId) ?? 0) >= HISTORY_LIMITS.acceptedPerCapture) { message = 'limit'; return; }
    retireCapture(value);
    if (!current(value)) return;
    const resource = profile(approved.resourceId)!;
    const history = createTelemetryHistory({ ownerId: HISTORY_OWNER, storage: value.ports.telemetry, trustedNow: now,
      limits: { retentionMs: approved.retentionMs, maxRows: HISTORY_LIMITS.rows, maxBytes: HISTORY_LIMITS.bytes },
      authorize(scope) {
        if (!captureCurrent(value, capture) || scope.action !== 'capture' || scope.ownerId !== HISTORY_OWNER || scope.resourceId !== resource.id ||
          scope.schemaVersion !== 1 || scope.destinationId !== 'local-history' || scope.purpose !== 'player-page-history' ||
          scope.expiresAt !== approved.deadline || JSON.stringify(scope.fields) !== JSON.stringify(resource.fields) || scope.provenanceFields.length !== 0) return undefined;
        return Object.freeze({ scope, expiresAt: approved.deadline });
      } });
    const capture: Capture = { resource, deadline: approved.deadline, abort: new AbortController(), history,
      accepted: value.accepted.get(resource.id) ?? 0, lastCommit: value.lastCommit.get(resource.id) ?? -Infinity };
    value.capture = capture;
    const result = await history.requestCapture({ resourceId: resource.id, schemaVersion: 1, schema: valueSchema(resource), fields: resource.fields,
      provenanceFields: [], destinationId: 'local-history', purpose: 'player-page-history', expiresAt: approved.deadline });
    if (!captureCurrent(value, capture)) { history.close(); return; }
    if (!result.ok) { retireCapture(value); message = 'unavailable'; return; }
    capture.handle = result.handle;
    const subscription = observe(resource.id, values => observation(value, capture, values));
    if (!captureCurrent(value, capture)) { try { subscription.stop(); } catch { message = 'unavailable'; } return; }
    capture.observation = subscription; message = 'collecting';
  }
  async function flush(value: Lease, capture: Capture) {
    if (!captureCurrent(value, capture) || !capture.handle || !capture.latest) return;
    const at = lastNow;
    if (at < capture.lastCommit + HISTORY_LIMITS.sampleMs) { scheduleDrain(); return; }
    const latest = capture.latest; capture.latest = undefined;
    const admitted = capture.history.enqueue(capture.handle, latest);
    if (!admitted.ok || !captureCurrent(value, capture)) return;
    // Charge admission before the asynchronous commit can retire this capture.
    // A cancelled or failed commit keeps its charge; a new approval cannot
    // bypass this management session's finite admission/cadence bounds.
    capture.accepted++; capture.lastCommit = at;
    value.accepted.set(capture.resource.id, capture.accepted); value.lastCommit.set(capture.resource.id, at);
    const result = await capture.history.flush();
    if (!captureCurrent(value, capture)) return;
    if (!result.ok) { retireCapture(value); message = 'unavailable'; return; }
    if (capture.accepted >= HISTORY_LIMITS.acceptedPerCapture) { retireCapture(value); message = 'collection-stopped'; }
    await refreshValue(value);
  }
  function scheduleDrain() {
    clearTimeout(drainTimer); drainTimer = undefined;
    const value = lease, capture = value?.capture;
    if (!value || !capture?.latest || pending || cleanups.size || !captureCurrent(value, capture)) return;
    const delay = Math.max(0, capture.lastCommit + HISTORY_LIMITS.sampleMs - lastNow);
    drainTimer = setTimeout(() => { drainTimer = undefined; if (lease === value && value.capture === capture) void task.flushCapture(); }, delay);
  }
  async function execute(value: Lease, approved: Review) {
    if (!current(value) || !value.owner || approved.deadline !== value.deadline) return;
    if (approved.action === 'capture') { await beginCapture(value, approved); return; }
    if (approved.action === 'export') {
      const rows = await project(value, approved.resourceId, 'download'); if (!current(value)) return;
      const bytes = new TextEncoder().encode(JSON.stringify({ profile: 'browser-page-history-export/1', resourceId: approved.resourceId, records: rows }));
      if (bytes.byteLength > HISTORY_LIMITS.exportBytes || !current(value)) return;
      const document = Object.freeze({ resourceId: approved.resourceId, bytes });
      const context = Object.freeze({ signal: value.abort.signal, expiresAt: approved.deadline, isCurrent: () => current(value) });
      // Same pending reservation covers the actual supplied async delivery.
      await deliver(document, context); if (current(value)) message = 'exported'; return;
    }
    if (approved.action === 'delete') {
      retireCapture(value); value.ports?.close(); value.ports = undefined;
      if (!current(value)) return;
      const request = Object.freeze({ kinds: ['telemetry'] as const, purpose: 'player-history-delete', telemetryResourceId: approved.resourceId });
      const result = await ownerCall(value, 'delete', Object.freeze({ ...request, kinds: ['telemetry', 'copies'] }), () => value.owner!.beginDeletion(request));
      if (!current(value)) return;
      if (!result.ok) { failure(result.reason); return; }
      value.deletion = result.value; count = 0; message = 'pending-deletion'; return;
    }
    const deletion = value.deletion;
    if (approved.action === 'resume-delete' && deletion && deletion.operationId === approved.operationId) {
      const request = Object.freeze({ operationId: approved.operationId, telemetryResourceId: deletion.telemetryResourceId });
      const result = await ownerCall(value, 'resume-delete', request, () => value.owner!.resumeDeletionReviewed(approved.operationId!));
      if (!current(value)) return;
      if (!result.ok) { failure(result.reason); return; }
      value.deletion = result.value;
      if (result.value.state === 'completed') retire('deleted'); else message = 'pending-deletion'; return;
    }
    if (approved.action === 'sweep') {
      retireCapture(value);
      const result = await ownerCall(value, 'sweep', Object.freeze({ kinds: ['telemetry', 'settings', 'artifacts', 'copies'], artifactRetentionMs: 7 * 86400000 }),
        () => value.owner!.sweep());
      if (!current(value)) return;
      if (!result.ok) { failure(result.reason); return; }
      await refreshValue(value); if (current(value)) message = 'swept';
    }
  }
  const task: HistoryTask = Object.freeze({
    snapshot,
    review(action: HistoryAction, details?: Readonly<{ resourceId?: string; retentionMs?: number }>) {
      if (closed || pending || cleanups.size || review || !['manage', 'capture', 'export', 'delete', 'resume-delete', 'sweep'].includes(action)) return;
      if (operations >= HISTORY_LIMITS.operations) { retire('limit'); return; }
      if (action === 'manage' && sessions >= HISTORY_LIMITS.sessions) { message = 'limit'; publish(); return; }
      const expected = generation, observedLease = lease;
      if (action === 'manage' ? !!lease : !lease || !current(lease)) return;
      if (action !== 'manage' && (action === 'resume-delete' ? !lease?.deletion : !lease?.ports || !!lease.deletion)) return;
      const input: Record<string, unknown> | undefined = details === undefined ? {} : object(details);
      if (!input || Object.keys(input).some(key => !['resourceId', 'retentionMs'].includes(key))) return;
      const resourceId = input.resourceId ?? selected, retentionMs = input.retentionMs ?? 60000;
      if (typeof resourceId !== 'string' || !profile(resourceId) || retentionMs !== 15000 && retentionMs !== 60000) return;
      if (action === 'capture' && (lease?.accepted.get(resourceId) ?? 0) >= HISTORY_LIMITS.acceptedPerCapture) return;
      if (action !== 'capture' && details !== undefined) return;
      let at: number; try { at = now(); } catch { return; }
      if (closed || pending || review || cleanups.size || expected !== generation || lease !== observedLease || lease && !intrinsicCurrent(lease)) return;
      const token = Object.freeze({}), deadline = lease?.deadline ?? at + HISTORY_LIMITS.managementMs;
      review = Object.freeze({ action, token, generation, resourceId, retentionMs, deadline,
        ...(action === 'resume-delete' && lease?.deletion ? { operationId: lease.deletion.operationId } : {}) });
      message = 'review'; arm(deadline, generation); publish();
      return review?.token === token ? token : undefined;
    },
    decide(token: object, allow: boolean) {
      const approved = review;
      if (!approved || token !== approved.token || pending || cleanups.size || typeof allow !== 'boolean') return Promise.resolve();
      review = undefined;
      if (!allow) {
        const expected = generation, value = lease;
        let at: number; try { at = now(); } catch { return Promise.resolve(); }
        if (closed || pending || review || expected !== generation || lease !== value) return Promise.resolve();
        if (at >= approved.deadline) retire('expired');
        else { message = lease?.deletion ? 'pending-deletion' : lease?.capture ? 'collecting' : lease ? 'ready' : 'cancelled'; publish(); }
        return Promise.resolve();
      }
      return start(async () => {
        if (closed || generation !== approved.generation) return;
        const at = now();
        if (generation !== approved.generation || closed) return;
        if (at >= approved.deadline) { retire('expired'); return; }
        if (approved.action === 'manage') await manage(approved);
        else if (lease) await execute(lease, approved);
      });
    },
    selectResource(resourceId: string) {
      if (!profile(resourceId) || closed || pending || review || cleanups.size || !lease || !current(lease) || lease.deletion) return Promise.resolve();
      const value = lease; selected = resourceId;
      return start(async () => { await refreshValue(value); if (current(value)) message = value.capture ? 'collecting' : 'ready'; });
    },
    flushCapture() {
      if (pending) return pending;
      const value = lease, capture = value?.capture;
      if (!value || !capture?.latest || !captureCurrent(value, capture)) return Promise.resolve();
      clearTimeout(drainTimer); drainTimer = undefined;
      return start(() => flush(value, capture));
    },
    refresh() { const value = lease; return value && !review && !pending && !value.deletion && current(value)
      ? start(() => refreshValue(value)) : Promise.resolve(); },
    stopCapture() { if (!lease) return; review = undefined; retireCapture(lease); message = 'collection-stopped'; publish(); },
    stop() { if (!closed) retire('stopped'); },
    close() {
      if (closing) return closing;
      let finish!: () => void; closing = new Promise<void>(resolve => { finish = resolve; });
      closed = true; retire('stopped');
      void (async () => { if (pending) await pending; while (cleanups.size) await Promise.all([...cleanups]); })().then(finish, () => {
        // A rejected cleanup cannot establish quiescence. Keep close pending and
        // admission closed; a trusted host must dispose its failed resource.
        message = 'unavailable'; publish();
      });
      return closing;
    },
  });
  return task;
}

/** Actual page geometry at JS observation time, never hardware acquisition. */
function observeNativePage(resourceId: string, receive: (values: Readonly<Record<string, number>>) => void) {
  const resource = profile(resourceId); if (!resource || typeof window === 'undefined') throw Error('unavailable');
  let stopped = false;
  const callback = () => { if (!stopped) receive(resourceId === HISTORY_RESOURCES[0]!.id
    ? { width: window.innerWidth, height: window.innerHeight } : { left: window.scrollX, top: window.scrollY }); };
  const name = resourceId === HISTORY_RESOURCES[0]!.id ? 'resize' : 'scroll';
  // Provision idempotent removal before native registration and repeat removal
  // after the call if a same-call receiver retires this returned subscription.
  const stop = () => { stopped = true; unlisten.call(window, name, callback); };
  try { listen.call(window, name, callback, { passive: true }); callback(); }
  catch (error) { stop(); throw error; }
  return Object.freeze({ stop });
}

/** A single explicitly requested browser download. Revocation cannot recall a
 * copy already handed to the browser; URL cleanup is owned, not copy deletion. */
function deliverNativeExport(document: HistoryExportDocument, context: HistoryExportContext): Promise<void> {
  if (typeof window === 'undefined' || aborted(context.signal) || !context.isCurrent() || aborted(context.signal)) return Promise.resolve();
  const blob = new Blob([document.bytes.slice().buffer as ArrayBuffer], { type: 'application/json' });
  const url = URL.createObjectURL(blob); let anchor: HTMLAnchorElement | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<void>(resolve => {
    let retired = false;
    function finish() {
      // Cleanup repeats for a node returned after reentrant retirement; only
      // Promise resolution is consumed once. Logical abort is not URL cleanup.
      clearTimeout(timer); unlisten.call(context.signal, 'abort', finish); anchor?.remove(); URL.revokeObjectURL(url);
      if (!retired) { retired = true; resolve(); }
    }
    listen.call(context.signal, 'abort', finish);
    try {
      if (aborted(context.signal) || !context.isCurrent() || Date.now() >= context.expiresAt || aborted(context.signal)) { finish(); return; }
      anchor = window.document.createElement('a'); anchor.href = url; anchor.download = 'page-history.json'; anchor.hidden = true;
      if (retired || !context.isCurrent() || Date.now() >= context.expiresAt || aborted(context.signal)) { finish(); return; }
      window.document.body.append(anchor);
      if (retired || !context.isCurrent() || Date.now() >= context.expiresAt || aborted(context.signal)) { finish(); return; }
      anchor.click(); if (retired) finish(); else timer = setTimeout(finish, 0);
    } catch { finish(); }
  });
}
