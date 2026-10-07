import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerDataController, createSettingsStore, createTelemetryHistory } from '@101/connect';
import type { OwnerDataStorage, TelemetryRecord, ValueSchema } from '@101/connect';
import type { HistoryTask, HistoryTaskOptions, HistoryStorageSession } from './history-task.ts';

// TESTS-FIRST: history-task.ts is deliberately absent in this snapshot. The
// selected first test turns that actual missing module into an explicit feature
// assertion, after proving the current public producer imports are available.
// All remaining cooperative fixtures are software; none qualify native IDB.
async function implementation() {
  try { return await import('./history-task.ts'); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail('Missing browser history privacy task factory');
    }
    throw error;
  }
}
const viewport = 'browser-page:viewport', scroll = 'browser-page:scroll';
const own = 'app-player-history:this-browser', otherOwner = 'history-other-owner';
const intrinsicAbort = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const schema = (resourceId: string): ValueSchema => ({ type: 'record' as const, fields: resourceId === viewport
  ? { width: { type: 'scalar' as const, unit: 'px', min: 0, max: 16384 }, height: { type: 'scalar' as const, unit: 'px', min: 0, max: 16384 } }
  : { left: { type: 'scalar' as const, unit: 'px', min: 0, max: 1000000 }, top: { type: 'scalar' as const, unit: 'px', min: 0, max: 1000000 } } });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memory() {
  const rows = new Map<string, unknown>();
  let calls = 0, pending = 0, before: (() => void | Promise<void>) | undefined;
  let observeGuard: ((guard: Parameters<OwnerDataStorage['transact']>[2]) => void) | undefined;
  const storage: OwnerDataStorage = { async transact<T>(ownerId: string, mutation: (current: unknown) => { state: unknown; result: T }, guard?: Parameters<OwnerDataStorage['transact']>[2]) {
    calls++; pending++; observeGuard?.(guard);
    try {
      if (guard && (intrinsicAbort.call(guard.signal) || !guard.isCurrent())) throw Error('cooperative-refused');
      const next = mutation(structuredClone(rows.get(ownerId)));
      await before?.();
      if (guard && (intrinsicAbort.call(guard.signal) || !guard.isCurrent() || intrinsicAbort.call(guard.signal))) throw Error('cooperative-refused');
      rows.set(ownerId, structuredClone(next.state)); return next.result;
    } finally { pending--; }
  } };
  return { storage, rows, calls: () => calls, pending: () => pending,
    before: (callback?: () => void | Promise<void>) => { before = callback; },
    observeGuard: (callback?: (guard: Parameters<OwnerDataStorage['transact']>[2]) => void) => { observeGuard = callback; } };
}
async function fixture(options: Partial<HistoryTaskOptions> = {}, data = memory()) {
  const api = await implementation();
  let time = 1000, sourceAt = 12.5, factories = 0, closes = 0, observations = 0, removals = 0;
  const observers = new Map<string, (values: Readonly<Record<string, number>>) => void>();
  const delivered: { resourceId: string; bytes: Uint8Array }[] = [];
  const task = api.createHistoryTask({ now: () => time,
    sourceClock: () => ({ clockId: 'cooperative-page-lifetime:test', at: sourceAt }),
    createStorage() { factories++; return { storage: data.storage, async close() { closes++; } }; },
    observePage(resourceId, receive) {
      observations++; observers.set(resourceId, receive); let removed = false;
      return { stop() { if (!removed) { removed = true; removals++; observers.delete(resourceId); } } };
    },
    deliverExport(document, context) {
      assert.equal(intrinsicAbort.call(context.signal), false); assert.equal(context.isCurrent(), true);
      delivered.push({ resourceId: document.resourceId, bytes: document.bytes.slice() });
    }, ...options });
  return { task, data, delivered, observers, setTime: (at: number) => { time = at; }, setSourceAt: (at: number) => { sourceAt = at; },
    factories: () => factories, closes: () => closes, observations: () => observations, removals: () => removals,
    emit(resourceId: string, values: Readonly<Record<string, number>>) { const receive = observers.get(resourceId); assert.ok(receive, 'Approved current observer required'); receive(values); } };
}
async function manage(task: HistoryTask) { const token = task.review('manage'); assert.ok(token); await task.decide(token, true); assert.equal(task.snapshot().active, true); }
async function capture(task: HistoryTask, resourceId = viewport, retentionMs = 60000) {
  await task.selectResource(resourceId); const token = task.review('capture', { resourceId, retentionMs }); assert.ok(token);
  await task.decide(token, true); assert.equal(task.snapshot().capture?.resourceId, resourceId);
}
async function seed(storage: OwnerDataStorage, ownerId = own, time = 1000) {
  const authority = new AbortController();
  const owner = createOwnerDataController({ ownerId, storage, trustedNow: () => time, availableDevices: () => [],
    authorize: scope => ({ scope, expiresAt: scope.deadline, signal: authority.signal, isCurrent: () => !intrinsicAbort.call(authority.signal) }) });
  const opened = await owner.openStores({ retireOwned() {} }); assert.equal(opened.ok, true); if (!opened.ok) throw Error('seed-open');
  const history = createTelemetryHistory({ ownerId, storage: opened.value.telemetry, trustedNow: () => time,
    authorize: scope => ({ scope, expiresAt: scope.expiresAt }), limits: { retentionMs: 60000, maxRows: 32, maxBytes: 65536 } });
  const originals: TelemetryRecord[] = [];
  try {
    for (const resourceId of [viewport, scroll]) {
      const fields = resourceId === viewport ? ['width', 'height'] : ['left', 'top'];
      const handle = await history.requestCapture({ resourceId, schemaVersion: 1, fields, provenanceFields: [], destinationId: 'local-history',
        purpose: 'cooperative-history-seed', expiresAt: time + 30000, schema: schema(resourceId) });
      assert.ok(handle.ok); if (!handle.ok) throw Error('seed-capture');
      assert.ok(history.enqueue(handle.handle, { sourceTime: { clockId: 'cooperative-seed-lifetime:test', at: 7.25 }, quality: 'observed',
        values: resourceId === viewport ? { width: 390, height: 844 } : { left: 0, top: 42 } }).ok);
    }
    const flushed = await history.flush(); assert.ok(flushed.ok); if (flushed.ok) assert.equal(flushed.committed, 2);
    for (const resourceId of [viewport, scroll]) {
      const page = await owner.exportPage({ kind: 'telemetry', resourceId, purpose: 'cooperative-seed-copy', destinationId: 'owned-seed' });
      assert.ok(page.ok); if (!page.ok) throw Error('seed-export');
      originals.push(page.value.records[0] as TelemetryRecord);
      const copied = await owner.storeLocalTelemetryCopy({ batchId: `seed-${resourceId.replace(':', '-')}`, records: page.value.records },
        { purpose: 'cooperative-seed-copy', destinationId: 'local-recipient' }); assert.ok(copied.ok);
    }
    const settings = createSettingsStore({ ownerId, storage: opened.value.settings, availableDevices: () => [] });
    assert.ok((await settings.save(0, { preferences: { theme: 'dark', handedness: 'left', motion: 'reduce' }, profiles: [] })).ok);
    return originals;
  } finally { authority.abort(); history.close(); opened.value.close(); owner.close(); }
}
async function publicRows(storage: OwnerDataStorage, resourceId: string, time: number) {
  const owner = createOwnerDataController({ ownerId: own, storage, trustedNow: () => time,
    authorize: scope => scope.action === 'export' && scope.request.kind === 'telemetry' && scope.request.resourceId === resourceId
      ? { scope, expiresAt: scope.deadline, isCurrent: () => true } : undefined });
  try {
    const page = await owner.exportPage({ kind: 'telemetry', resourceId, purpose: 'cooperative-original-inspection', destinationId: 'cooperative-test' });
    assert.ok(page.ok); if (!page.ok) throw Error('public-inspection'); return page.value.records as readonly TelemetryRecord[];
  } finally { owner.close(); }
}
const envelope = (data: ReturnType<typeof memory>, ownerId = own) => structuredClone(data.rows.get(ownerId)) as {
  records: { telemetry?: { rows: TelemetryRecord[] }; settings?: string }; copies: { record: TelemetryRecord }[];
  deletion?: { operationId: string; state: string; completedStages: number; telemetryResourceId?: string };
  audit: { action: string; state: string; removed: { telemetry: number; copies: number }; expiresAt: number; at: number }[];
};

test('browser history privacy task exists beside the current inert public owner producers', async () => {
  assert.equal(typeof createOwnerDataController, 'function'); assert.equal(typeof createTelemetryHistory, 'function');
  const data = memory(), owner = createOwnerDataController({ ownerId: own, storage: data.storage, trustedNow: () => 1000, authorize: () => undefined });
  try {
    assert.equal(data.calls(), 0, 'Public owner constructor is inert before the missing feature assertion');
    const api = await implementation(); assert.equal(typeof api.createHistoryTask, 'function');
    assert.equal(typeof api.createHistoryStorageSession, 'function');
  } finally { owner.close(); }
});

test('history arrival and declined management are inert for storage capture and export', async () => {
  const f = await fixture();
  try {
    assert.equal(f.task.snapshot().message, 'arrival'); assert.equal(f.task.snapshot().active, false);
    assert.equal(f.factories(), 0); assert.equal(f.observations(), 0); assert.equal(f.data.calls(), 0); assert.equal(f.delivered.length, 0);
    const token = f.task.review('manage'); assert.ok(token); await f.task.decide(token, false);
    assert.equal(f.factories(), 0); assert.equal(f.data.calls(), 0); assert.equal(f.observations(), 0);
    for (const action of ['capture', 'export', 'delete', 'resume-delete', 'sweep'] as const) assert.equal(f.task.review(action), undefined);
  } finally { await f.task.close(); }
});

test('management reads only retained data and never implies capture or download', async () => {
  const data = memory(); await seed(data.storage); const f = await fixture({}, data);
  try {
    await manage(f.task); assert.equal(f.factories(), 1); assert.equal(f.task.snapshot().capture, undefined); assert.equal(f.observations(), 0);
    assert.equal(f.task.snapshot().count, 1); assert.equal(f.delivered.length, 0);
    await f.task.selectResource(scroll); assert.equal(f.task.snapshot().count, 1);
    assert.equal(f.observations(), 0); assert.equal(f.delivered.length, 0);
  } finally { await f.task.close(); }
});

test('separately approved page observations preserve exact source time quality and original retention in selected export', async () => {
  const f = await fixture();
  try {
    await manage(f.task); await capture(f.task, viewport, 15000);
    f.emit(viewport, { width: 390, height: 844 }); await f.task.flushCapture();
    const first = (await publicRows(f.data.storage, viewport, 1000))[0]!;
    assert.deepEqual(first.sourceTime, { clockId: 'cooperative-page-lifetime:test', at: 12.5 });
    assert.equal(first.quality, 'observed'); assert.equal(first.ingestedAt, 1000); assert.equal(first.expiresAt, 16000);
    assert.deepEqual(first.values, { width: 390, height: 844 });
    f.setTime(2000); f.setSourceAt(98.125); await capture(f.task, scroll, 60000);
    assert.equal(f.observers.has(viewport), false); f.emit(scroll, { left: 0, top: 42.5 }); await f.task.flushCapture();
    const second = (await publicRows(f.data.storage, scroll, 2000))[0]!;
    assert.equal(second.expiresAt, Math.min(second.ingestedAt + 60000, f.task.snapshot().capture!.deadline));
    assert.equal(second.expiresAt, 31000, 'A retention choice never extends the original thirty-second approval');
    await f.task.selectResource(viewport); const token = f.task.review('export'); assert.ok(token); await f.task.decide(token, true);
    assert.equal(f.delivered.length, 1); assert.equal(f.delivered[0]!.resourceId, viewport);
    const exported = JSON.parse(new TextDecoder().decode(f.delivered[0]!.bytes)) as { records: TelemetryRecord[] };
    assert.equal(exported.records.length, 1); assert.deepEqual(exported.records[0], first);
    assert.equal(f.task.snapshot().capture?.resourceId, scroll, 'Inspection/export do not silently replace current capture');
    assert.equal(f.data.pending(), 0);
  } finally { await f.task.close(); }
});

test('declined capture export deletion and sweep preserve incumbent capture selected data and deadline', async () => {
  const f = await fixture();
  try {
    await manage(f.task); await capture(f.task); f.emit(viewport, { width: 390, height: 844 }); await f.task.flushCapture();
    const before = envelope(f.data), deadline = f.task.snapshot().deadline, calls = f.data.calls(), observers = f.observations();
    for (const action of ['capture', 'export', 'delete', 'sweep'] as const) {
      const token = f.task.review(action); assert.ok(token); await f.task.decide(token, false);
      assert.equal(f.task.snapshot().active, true); assert.equal(f.task.snapshot().capture?.resourceId, viewport);
      assert.equal(f.task.snapshot().deadline, deadline); assert.equal(f.task.snapshot().review, undefined);
      assert.equal(f.data.calls(), calls); assert.equal(f.observations(), observers); assert.deepEqual(envelope(f.data), before);
    }
    assert.equal(f.delivered.length, 0);
  } finally { await f.task.close(); }
});

test('forged stale and absolute-expired reviews cannot create a storage session or capture', async () => {
  const f = await fixture();
  try {
    await f.task.decide({}, true); assert.equal(f.factories(), 0);
    const old = f.task.review('manage')!; f.task.stop(); await f.task.decide(old, true); assert.equal(f.factories(), 0);
    const current = f.task.review('manage')!; f.setTime(31000); await f.task.decide(current, true);
    assert.equal(f.factories(), 0); assert.equal(f.task.snapshot().active, false);
    f.setTime(32000); await manage(f.task); const captureReview = f.task.review('capture')!;
    f.setTime(62000); await f.task.decide(captureReview, true); assert.equal(f.observations(), 0);
    assert.equal(f.task.snapshot().active, false);
  } finally { await f.task.close(); }
});

test('review snapshots reject foreign resources extra fields accessors and unsupported retention before effects', async () => {
  const f = await fixture(); let getters = 0;
  try {
    await manage(f.task); const calls = f.data.calls();
    for (const details of [{ resourceId: 'foreign:resource', retentionMs: 60000 }, { resourceId: viewport, retentionMs: 60001 },
      { resourceId: viewport, retentionMs: 15000, destinationId: 'remote-copy' },
      { get resourceId() { getters++; return viewport; }, retentionMs: 15000 }]) {
      assert.equal(f.task.review('capture', details as never), undefined);
    }
    assert.equal(getters, 0); assert.equal(f.observations(), 0); assert.equal(f.data.calls(), calls);
  } finally { await f.task.close(); }
});

test('reentrant notification retirement reserves work and fences the storage factory before dispatch', async () => {
  const api = await implementation(); let calls = 0;
  const task: HistoryTask = api.createHistoryTask({ now: () => 1000,
    createStorage() { calls++; throw Error('unexpected-storage'); }, onChange(state) { if (state.pending) task.stop(); } });
  try { await task.decide(task.review('manage')!, true); assert.equal(calls, 0); assert.equal(task.snapshot().active, false); }
  finally { await task.close(); }
});

test('a stopped observation installer cannot retain its late returned subscription or enqueue data', async () => {
  const api = await implementation(), data = memory(); let stopped = 0;
  const task: HistoryTask = api.createHistoryTask({ now: () => 1000, sourceClock: () => ({ clockId: 'cooperative-page:test', at: 5 }),
    createStorage: () => ({ storage: data.storage, async close() {} }),
    observePage(_id, receive) { task.stop(); receive({ width: 390, height: 844 }); return { stop() { stopped++; } }; } });
  try {
    await manage(task); await task.decide(task.review('capture')!, true);
    assert.equal(task.snapshot().active, false); assert.equal(stopped, 1);
    assert.equal(envelope(data).records.telemetry?.rows.length ?? 0, 0);
  } finally { await task.close(); }
});

test('held producer commit stays reserved after Stop and close waits for its actual settlement', async () => {
  const f = await fixture(), entered = deferred(), held = deferred(); let operation: Promise<void> | undefined;
  try {
    await manage(f.task); await capture(f.task); f.emit(viewport, { width: 390, height: 844 });
    f.data.before(async () => { entered.resolve(); await held.promise; });
    operation = f.task.flushCapture(); await entered.promise;
    f.task.stop(); assert.equal(f.task.snapshot().active, false); assert.equal(f.task.snapshot().pending, true);
    assert.equal(f.task.review('manage'), undefined); let complete = false;
    const first = f.task.close(), second = f.task.close(); assert.equal(first, second); void first.then(() => { complete = true; });
    await Promise.resolve(); assert.equal(complete, false); assert.equal(f.data.pending(), 1);
    held.resolve(); await operation; await first; assert.equal(complete, true);
    assert.equal(envelope(f.data).records.telemetry?.rows.length ?? 0, 0);
  } finally { held.resolve(); await operation; await f.task.close(); }
});

test('late storage factory and held late cleanup cannot let close or a new session finish early', async () => {
  const api = await implementation(), data = memory(), started = deferred(), late = deferred<HistoryStorageSession>(), heldClose = deferred();
  let closes = 0, operation: Promise<void> | undefined;
  const task: HistoryTask = api.createHistoryTask({ now: () => 1000, createStorage() { started.resolve(); return late.promise; } });
  try {
    operation = task.decide(task.review('manage')!, true); await started.promise; task.stop();
    let done = false; const closing = task.close(); void closing.then(() => { done = true; });
    late.resolve({ storage: data.storage, async close() { closes++; await heldClose.promise; } });
    await Promise.resolve(); await Promise.resolve(); assert.equal(done, false); assert.equal(task.snapshot().pending, true);
    assert.equal(data.calls(), 0); heldClose.resolve(); await operation; await closing; assert.equal(closes, 1);
  } finally { late.resolve({ storage: data.storage, async close() {} }); heldClose.resolve(); await operation; await task.close(); }
});

test('selected telemetry removal uses actual public producer and matching copies while preserving other resources owners and settings', async () => {
  const data = memory(), originals = await seed(data.storage); await seed(data.storage, otherOwner);
  const otherBefore = structuredClone(data.rows.get(otherOwner)), before = envelope(data), f = await fixture({}, data);
  try {
    await manage(f.task); await f.task.selectResource(viewport);
    await f.task.decide(f.task.review('delete')!, true);
    assert.equal(f.task.snapshot().capture, undefined); assert.equal(f.task.snapshot().message, 'pending-deletion');
    assert.equal(envelope(data).deletion?.telemetryResourceId, viewport);
    for (let stage = 0; stage < 2; stage++) { const token = f.task.review('resume-delete'); assert.ok(token); await f.task.decide(token, true); }
    const after = envelope(data); assert.equal(after.deletion?.state, 'completed');
    assert.deepEqual(after.records.telemetry?.rows, before.records.telemetry?.rows.filter(row => row.resourceId === scroll));
    assert.deepEqual(after.copies.map(copy => copy.record), [originals[1]]);
    assert.equal(after.records.settings, before.records.settings); assert.deepEqual(data.rows.get(otherOwner), otherBefore);
    const audit = after.audit.find(row => row.action === 'deletion'); assert.ok(audit);
    assert.deepEqual(Object.keys(audit).sort(), ['action', 'at', 'expiresAt', 'kinds', 'operationId', 'removed', 'state']);
    assert.equal(audit.state, 'completed'); assert.equal(audit.removed.telemetry, 1); assert.equal(audit.removed.copies, 1);
    assert.equal(audit.expiresAt, audit.at + 30 * 86400000); assert.equal(JSON.stringify(after.audit).includes(viewport), false);
    assert.equal(Object.hasOwn(after.deletion!, 'telemetryResourceId'), false);
  } finally { await f.task.close(); }
});

test('pending selected deletion reopens inert and requires fresh management and exact resume review', async () => {
  const data = memory(); await seed(data.storage); const first = await fixture({}, data);
  try { await manage(first.task); await first.task.decide(first.task.review('delete')!, true); }
  finally { await first.task.close(); }
  const before = envelope(data), second = await fixture({}, data);
  try {
    assert.equal(second.factories(), 0); assert.equal(second.task.review('resume-delete'), undefined);
    await manage(second.task); assert.equal(second.task.snapshot().message, 'pending-deletion'); assert.equal(second.observations(), 0);
    const review = second.task.review('resume-delete')!; await second.task.decide(review, false);
    assert.deepEqual(envelope(data).deletion, before.deletion);
    await second.task.decide(review, true); assert.deepEqual(envelope(data).deletion, before.deletion, 'Consumed declined token cannot resume');
    for (let stage = 0; stage < 2; stage++) await second.task.decide(second.task.review('resume-delete')!, true);
    assert.equal(envelope(data).deletion?.state, 'completed'); assert.equal(second.observations(), 0); assert.equal(second.delivered.length, 0);
  } finally { await second.task.close(); }
});

test('owner Stop with shadowed supplied guard methods propagates intrinsic abort to the final commit fence', async () => {
  const f = await fixture(); let stopOnCommit = false, observed: AbortSignal | undefined;
  try {
    await manage(f.task); await capture(f.task); f.emit(viewport, { width: 390, height: 844 });
    f.data.observeGuard(guard => {
      if (!stopOnCommit || !guard) return; observed = guard.signal;
      Object.defineProperties(guard.signal, { aborted: { value: false }, addEventListener: { value() {} }, removeEventListener: { value() {} } });
    });
    f.data.before(async () => { if (stopOnCommit) { queueMicrotask(() => f.task.stop()); await Promise.resolve(); } });
    stopOnCommit = true; await f.task.flushCapture(); assert.ok(observed);
    assert.equal(intrinsicAbort.call(observed), true); assert.equal(envelope(f.data).records.telemetry?.rows.length ?? 0, 0);
    assert.equal(f.task.snapshot().active, false);
  } finally { await f.task.close(); }
});

test('final storage guard clock at exact reviewed expiry rejects the durable frame before its deadline timer', async () => {
  const f = await fixture(); let finalGuard = false;
  try {
    await manage(f.task); await capture(f.task); f.emit(viewport, { width: 390, height: 844 });
    f.data.before(() => { finalGuard = true; f.setTime(31000); });
    await f.task.flushCapture(); assert.equal(finalGuard, true);
    assert.equal(envelope(f.data).records.telemetry?.rows.length ?? 0, 0); assert.equal(f.task.snapshot().active, false);
  } finally { await f.task.close(); }
});

test('actual export callback Promise remains reserved after retirement and no second export is admitted', async () => {
  const entered = deferred(), held = deferred(), data = memory(); await seed(data.storage); let delivered = 0;
  const f = await fixture({ async deliverExport(document, context) {
    delivered++; assert.equal(document.resourceId, viewport); assert.equal(context.isCurrent(), true); entered.resolve(); await held.promise;
  } }, data); let operation: Promise<void> | undefined;
  try {
    await manage(f.task); operation = f.task.decide(f.task.review('export')!, true); await entered.promise; f.task.stop();
    assert.equal(f.task.snapshot().pending, true); assert.equal(f.task.review('manage'), undefined); let complete = false;
    const closing = f.task.close(); void closing.then(() => { complete = true; }); await Promise.resolve(); assert.equal(complete, false);
    held.resolve(); await operation; await closing; assert.equal(delivered, 1); assert.equal(complete, true);
  } finally { held.resolve(); await operation; await f.task.close(); }
});

test('expired export authority after actual projection cannot dispatch the trusted file callback', async () => {
  const data = memory(); await seed(data.storage); const f = await fixture({}, data); let armed = false;
  try {
    await manage(f.task); const token = f.task.review('export')!;
    f.data.before(() => { if (armed) f.setTime(31000); }); armed = true; await f.task.decide(token, true);
    assert.equal(f.delivered.length, 0); assert.equal(f.task.snapshot().active, false);
  } finally { await f.task.close(); }
});

test('invalid source clock extra values and accessor observations cannot become recorded data', async () => {
  const f = await fixture(); let getters = 0;
  try {
    await manage(f.task); await capture(f.task);
    f.emit(viewport, { width: 390, height: 844, secret: 1 });
    f.emit(viewport, { get width() { getters++; return 390; }, height: 844 });
    await f.task.flushCapture(); assert.equal(getters, 0); assert.equal(envelope(f.data).records.telemetry?.rows.length ?? 0, 0);
    f.setSourceAt(Number.NaN); f.emit(viewport, { width: 390, height: 844 }); await f.task.flushCapture();
    assert.equal(envelope(f.data).records.telemetry?.rows.length ?? 0, 0);
  } finally { await f.task.close(); }
});

test('capture coalesces one latest observation and enforces sixteen accepted samples without renewing authority', async () => {
  const f = await fixture();
  try {
    await manage(f.task); await capture(f.task); const deadline = f.task.snapshot().capture!.deadline;
    f.emit(viewport, { width: 100, height: 100 }); f.emit(viewport, { width: 390, height: 844 }); await f.task.flushCapture();
    assert.deepEqual(envelope(f.data).records.telemetry!.rows[0]!.values, { width: 390, height: 844 });
    for (let index = 1; index < 16; index++) {
      f.setTime(1000 + index * 1000); f.setSourceAt(index + 12.5); f.emit(viewport, { width: 390 + index, height: 844 }); await f.task.flushCapture();
    }
    assert.equal(envelope(f.data).records.telemetry!.rows.length, 16);
    f.setTime(17000); const receive = f.observers.get(viewport); receive?.({ width: 500, height: 844 }); await f.task.flushCapture();
    assert.equal(envelope(f.data).records.telemetry!.rows.length, 16); assert.equal(f.task.snapshot().deadline, deadline);
    assert.equal(f.observers.has(viewport), false, 'Sample cap retires collection rather than keeping listeners silently active');
  } finally { await f.task.close(); }
});

test('collection reapproval cannot reset same-resource cadence or its sixteen-item management-session ceiling', async () => {
  const f = await fixture();
  try {
    await manage(f.task); await capture(f.task); const deadline = f.task.snapshot().deadline;
    f.emit(viewport, { width: 100, height: 100 }); await f.task.flushCapture(); f.task.stopCapture();
    await capture(f.task); f.emit(viewport, { width: 101, height: 100 }); await f.task.flushCapture();
    assert.equal(envelope(f.data).records.telemetry!.rows.length, 1, 'Fresh collection consent does not reset the one-second cadence');
    f.setTime(2000); await f.task.flushCapture();
    for (let index = 2; index < 16; index++) {
      f.setTime(1000 + index * 1000); f.setSourceAt(index + 1.5);
      f.emit(viewport, { width: 100 + index, height: 100 }); await f.task.flushCapture();
    }
    assert.equal(envelope(f.data).records.telemetry!.rows.length, 16); assert.equal(f.task.snapshot().deadline, deadline);
    assert.equal(f.task.review('capture'), undefined); assert.equal(f.observations(), 2); assert.equal(f.observers.size, 0);
  } finally { await f.task.close(); }
});

test('Stop collection fences a held producer commit without retiring still-current management', async () => {
  const f = await fixture(), entered = deferred(), held = deferred(); let operation: Promise<void> | undefined;
  try {
    await manage(f.task); await capture(f.task); f.emit(viewport, { width: 390, height: 844 });
    f.data.before(async () => { entered.resolve(); await held.promise; }); operation = f.task.flushCapture(); await entered.promise;
    f.task.stopCapture(); assert.equal(f.task.snapshot().active, true); assert.equal(f.task.snapshot().pending, true);
    assert.equal(f.task.snapshot().capture, undefined); assert.equal(f.data.pending(), 1);
    held.resolve(); await operation; assert.equal(envelope(f.data).records.telemetry?.rows.length ?? 0, 0);
    assert.equal(f.task.snapshot().active, true); assert.equal(f.observers.size, 0);
  } finally { held.resolve(); await operation; await f.task.close(); }
});

test('clock-reentrant management approval cannot leave an outer review able to replace its actual session', async () => {
  let armed = false, nested: Promise<void> | undefined;
  const f = await fixture({ now() {
    if (armed) { armed = false; const token = task.review('manage'); assert.ok(token); nested = task.decide(token, true); }
    return 1000;
  } }); const task = f.task;
  try {
    armed = true; assert.equal(task.review('manage'), undefined); assert.ok(nested); await nested;
    assert.equal(f.factories(), 1); assert.equal(task.snapshot().active, true); assert.equal(task.snapshot().review, undefined);
    assert.equal(task.review('manage'), undefined); assert.equal(f.observations(), 0);
  } finally { await task.close(); }
});

test('fresh approved sweep uses original ingest expiry and does not restart capture', async () => {
  const f = await fixture();
  try {
    await manage(f.task); await capture(f.task, viewport, 15000); f.emit(viewport, { width: 390, height: 844 }); await f.task.flushCapture();
    f.task.stopCapture(); f.setTime(16000); await f.task.decide(f.task.review('sweep')!, true);
    assert.equal(envelope(f.data).records.telemetry?.rows.length ?? 0, 0); assert.equal(f.task.snapshot().capture, undefined);
    assert.equal(f.observations(), 1); assert.equal(f.observers.size, 0);
    const audit = envelope(f.data).audit.find(row => row.action === 'expiry'); assert.ok(audit); assert.equal(audit.removed.telemetry, 1);
    assert.equal(audit.expiresAt, 16000 + 30 * 86400000);
  } finally { await f.task.close(); }
});

test('foreign future and corrupt managed data stay untouched and do not enable recovery deletion', async () => {
  const api = await implementation();
  for (const scenario of ['wrong-owner', 'incompatible', 'corrupt'] as const) {
    const data = memory(); await seed(data.storage);
    const raw = data.rows.get(own) as { ownerId: string; version: number; records: { telemetry: { bytes: unknown } } };
    if (scenario === 'wrong-owner') raw.ownerId = otherOwner;
    else if (scenario === 'incompatible') raw.version = 99;
    else raw.records.telemetry.bytes = 'invalid-byte-accounting';
    const before = structuredClone(raw), f = await fixture({}, data);
    try {
      await f.task.decide(f.task.review('manage')!, true); assert.equal(f.task.snapshot().message, scenario);
      assert.equal(f.task.review('delete'), undefined); assert.equal(f.task.review('capture'), undefined);
      assert.deepEqual(data.rows.get(own), before); assert.equal(f.observations(), 0); assert.equal(f.delivered.length, 0);
    } finally { await f.task.close(); }
  }
  assert.equal(api.HISTORY_OWNER, own);
});

test('blocked native-shaped opening retains the namespace after public refusal until actual terminal event', async () => {
  // Cooperative EventTarget request, explicitly NOT native IndexedDB proof.
  const api = await implementation(), request = new EventTarget() as IDBOpenDBRequest; let opens = 0, closes = 0;
  Object.defineProperty(request, 'result', { value: { close() { closes++; }, objectStoreNames: { length: 1, contains: () => true } } });
  const factory = { open(name: string, version: number) { assert.equal(name, api.HISTORY_DATABASE); assert.equal(version, 1); opens++; return request; } } as unknown as IDBFactory;
  const session = api.createHistoryStorageSession(factory), operation = session.storage.transact(own, raw => ({ state: raw, result: 1 }));
  request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent); await assert.rejects(operation);
  let done = false; const first = session.close(), second = session.close(); assert.equal(first, second); void first.then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false); assert.throws(() => api.createHistoryStorageSession(factory)); assert.equal(opens, 1);
  request.dispatchEvent(new Event('success')); request.onsuccess?.call(request, new Event('success')); await first;
  assert.equal(done, true); assert.ok(closes >= 1); const fresh = api.createHistoryStorageSession(factory); await fresh.close();
});

test('a genuine committed return retired by Stop remains charged to the session quota', async () => {
 const data=memory(),base=data.storage.transact,entered=deferred(),held=deferred();let hold=false;
 data.storage.transact=async (...args) => {
  const result=await base(...args);
  if(hold && (envelope(data).records.telemetry?.rows.length ?? 0)===16){hold=false;entered.resolve();await held.promise;}
  return result;
 };
 const f=await fixture({},data);let operation:Promise<void>|undefined;
 try{
  await manage(f.task);await capture(f.task);
  for(let i=0;i<15;i++){f.setTime(1000+i*1000);f.emit(viewport,{width:390+i,height:844});await f.task.flushCapture();assert.equal((envelope(data).records.telemetry?.rows.length ?? 0),i+1);}
  f.setTime(16000);hold=true;f.emit(viewport,{width:420,height:844});operation=f.task.flushCapture();await entered.promise;
  assert.equal((envelope(data).records.telemetry?.rows.length ?? 0),16);f.task.stopCapture();held.resolve();await operation;
  const next=f.task.review('capture',{resourceId:viewport,retentionMs:60000});
  if(next){await f.task.decide(next,true);f.setTime(17000);f.emit(viewport,{width:430,height:844});await f.task.flushCapture();}
  assert.equal((envelope(data).records.telemetry?.rows.length ?? 0),16,'Committed rows retain their admission charge after Stop and late return');
 }finally{held.resolve();await operation;await f.task.close();}
});
