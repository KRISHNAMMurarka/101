import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetryHistory } from './telemetry-history.ts';
import { createSettingsStore } from './settings-store.ts';
import { createDurableArtifactJobStore } from './durable-artifact-jobs.ts';
import { createAssetReference } from '@101/device-model';
import { createTelemetryHistory as createPublicTelemetryHistory } from '@101/connect';
import type { TelemetryRecord } from '@101/connect';
import type { OwnerDataStorage, OwnerDataOptions, OwnerDataPorts, OwnerDataController } from './owner-data.ts';

// This unit port is not persistence qualification; the public caller uses real engines.
const api = await import('./owner-data.ts').catch(() => undefined);
function memory() {
  const rows = new Map<string, unknown>();
  let before: ((state: unknown) => void) | undefined;
  let fail = false;
  const storage: OwnerDataStorage = {
    async transact(owner, mutation, guard) {
      if (fail) throw new Error('private-backend-detail');
      const next = mutation(structuredClone(rows.get(owner)));
      if (guard && (guard.signal.aborted || guard.isCurrent() !== true || guard.signal.aborted)) throw new Error('unit-commit-cancelled');
      // A controlled native-commit boundary: after the last synchronous predicate, only the engine abort listener remains.
      before?.(next.state);
      if (guard?.signal.aborted) throw new Error('unit-commit-cancelled');
      rows.set(owner, structuredClone(next.state));
      return next.result;
    },
  };
  return { storage, rows, before(value?: (state: unknown) => void) { before = value; }, fail(value: boolean) { fail = value; } };
}
function required<T>(result: Readonly<{ok:true;value:T}> | Readonly<{ok:false;reason:string}>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
function setup(overrides: Partial<OwnerDataOptions> = {}, storage = memory()) {
  assert.ok(api, 'managed-owner-data/1 needs a current-authority export/deletion controller');
  let now = 1000, allowed = true, current = true, retired = 0;
  const controller = api.createOwnerDataController({ ownerId: 'owner-a', storage: storage.storage, trustedNow: () => now,
    availableDevices: () => ['device-a'], authorize: scope => allowed ? { scope, expiresAt: scope.deadline,
      isCurrent: () => current } : undefined, artifactRetentionMs: 100, ...overrides });
  return { controller, storage, time(value: number) { now = value; }, allow(value: boolean) { allowed = value; },
    current(value: boolean) { current = value; }, retired: () => retired,
    async ports() { return required(await controller.openStores({ retireOwned() { retired++; } })); } };
}
const choice = { preferences: { theme: 'dark', handedness: 'left', motion: 'reduce' }, profiles: [] };
const selection = { kinds: ['telemetry', 'settings', 'artifacts', 'copies'], purpose: 'owner-cleanup' } as const;
const exportSettings = { kind: 'settings', purpose: 'owner-portability', destinationId: 'owner-download' } as const;
const telemetryRequest = { resourceId: 'example:rss', schemaVersion: 1, fields: ['residentBytes'], provenanceFields: [],
  destinationId: 'local-history' as const, purpose: 'memory-diagnostics', expiresAt: 50000,
  schema: { type: 'record' as const, fields: { residentBytes: { type: 'scalar' as const,
    unit: 'By', min: 0, max: 100000 } } } };
const observation = { sourceTime: { clockId: 'process:clock', at: 17 }, quality: 'observed' as const, values: { residentBytes: 4321 } };
function history(ports: OwnerDataPorts, time = () => 1000) {
  return createTelemetryHistory({ ownerId: 'owner-a', storage: ports.telemetry, trustedNow: time,
    authorize: scope => ({ scope, expiresAt: scope.expiresAt }), limits: { retentionMs: 100 } });
}
async function seedTelemetry(ports: OwnerDataPorts) {
  const producer = history(ports), capture = await producer.requestCapture(telemetryRequest);
  assert.ok(capture.ok); assert.ok(producer.enqueue(capture.handle, observation).ok); assert.ok((await producer.flush()).ok);
  return producer;
}

test('an exact current owner grant controls export without touching identity or credentials', async () => {
  const f = setup(), ports = await f.ports();
  const settings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
  assert.ok((await settings.save(0, choice)).ok);
  f.allow(false); assert.deepEqual(await f.controller.exportPage(exportSettings), { ok: false, reason: 'denied' });
  f.allow(true); const page = required(await f.controller.exportPage(exportSettings));
  assert.deepEqual(page.records, [choice]);
  assert.equal(JSON.stringify(page).includes('owner-a'), false);
  assert.equal(JSON.stringify(page).includes('private-backend'), false);
  f.controller.close();
});

test('deletion commits a durable fence before any stage and old producer writes cannot resurrect data', async () => {
  const f = setup(), ports = await f.ports(), producer = await seedTelemetry(ports);
  const settings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
  assert.ok((await settings.save(0, choice)).ok);
  const queued = await producer.requestCapture(telemetryRequest); assert.ok(queued.ok);
  assert.ok(producer.enqueue(queued.handle, observation).ok);
  const deletion = required(await f.controller.beginDeletion(selection));
  assert.equal(deletion.state, 'pending'); assert.equal(deletion.completedStages, 0);
  assert.equal(ports.signal.aborted, true); assert.equal(f.retired(), 1);
  assert.equal((await settings.save(1, choice)).ok, false);
  assert.equal((await producer.flush()).ok, false);
  assert.deepEqual(await f.controller.exportPage(exportSettings), { ok: false, reason: 'review-required' });
  for (let stage = 0; stage < 4; stage++) required(await f.controller.resumeDeletionReviewed(deletion.operationId));
  const done = required(await f.controller.inspectDeletion()); assert.equal(done?.state, 'completed');
  const fresh = await f.ports(), loaded = createSettingsStore({ ownerId: 'owner-a', storage: fresh.settings, availableDevices: () => [] });
  const read = await loaded.load(); assert.ok(read.ok); assert.equal(read.value.preferences.theme, 'system');
  f.controller.close();
});

test('another controller is fenced at the transaction and the other owner survives deletion', async () => {
  const storage = memory(), left = setup({}, storage), right = setup({}, storage);
  const other = setup({ ownerId: 'owner-b' }, storage);
  const ports = await right.ports(), b = await other.ports();
  const settings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
  const otherSettings = createSettingsStore({ ownerId: 'owner-b', storage: b.settings, availableDevices: () => [] });
  assert.ok((await settings.save(0, choice)).ok); assert.ok((await otherSettings.save(0, choice)).ok);
  const operation = required(await left.controller.beginDeletion(selection));
  assert.equal((await settings.save(1, choice)).ok, false);
  for (let i = 0; i < 4; i++) required(await left.controller.resumeDeletionReviewed(operation.operationId));
  const read = await otherSettings.load(); assert.ok(read.ok); assert.equal(read.value.preferences.theme, 'dark');
  left.controller.close(); right.controller.close(); other.controller.close();
});

test('interrupted stages restore no grant and resume needs a fresh current owner decision', async () => {
  const f = setup(), ports = await f.ports(); await seedTelemetry(ports);
  const deletion = required(await f.controller.beginDeletion(selection));
  required(await f.controller.resumeDeletionReviewed(deletion.operationId));
  f.storage.fail(true); assert.deepEqual(await f.controller.resumeDeletionReviewed(deletion.operationId), { ok: false, reason: 'unavailable' });
  f.controller.close(); f.storage.fail(false);
  const reopened = setup({}, f.storage); reopened.allow(false);
  assert.equal(required(await reopened.controller.inspectDeletion())?.completedStages, 1);
  assert.deepEqual(await reopened.controller.resumeDeletionReviewed(deletion.operationId), { ok: false, reason: 'denied' });
  reopened.allow(true); reopened.current(false);
  assert.deepEqual(await reopened.controller.resumeDeletionReviewed(deletion.operationId), { ok: false, reason: 'revoked' });
  reopened.current(true); for (let i = 1; i < 4; i++) required(await reopened.controller.resumeDeletionReviewed(deletion.operationId));
  assert.equal(required(await reopened.controller.inspectDeletion())?.state, 'completed');
  reopened.controller.close();
});

test('expiry removes producer data and local copies while required redacted audit survives for thirty days', async () => {
  const f = setup(), ports = await f.ports(); await seedTelemetry(ports);
  const exported = required(await f.controller.exportPage({ kind: 'telemetry', purpose: 'owner-copy', destinationId: 'local-recipient',
    resourceId: 'example:rss', fields: ['residentBytes'] }));
  const batch = { batchId: 'local-batch-1', records: exported.records };
  required(await f.controller.storeLocalTelemetryCopy(batch, { purpose: 'owner-copy', destinationId: 'local-recipient' }));
  f.time(1100); const swept = required(await f.controller.sweep()); assert.equal(swept.telemetryRemoved, 1); assert.equal(swept.copiesRemoved, 1);
  const raw = JSON.stringify(f.storage.rows.get('owner-a')); assert.equal(raw.includes('4321'), false);
  assert.ok(raw.includes('expiry')); assert.equal(raw.includes('private-backend-detail'), false);
  f.time(1100 + 30 * 86400000); required(await f.controller.sweep());
  assert.equal(JSON.stringify(f.storage.rows.get('owner-a')).includes('"action":"expiry"'), false);
  f.controller.close();
});

test('a changed source or deletion rejects a late local recipient copy and duplicates stay idempotent', async () => {
  const f = setup(), ports = await f.ports(); await seedTelemetry(ports);
  const page = required(await f.controller.exportPage({ kind: 'telemetry', purpose: 'copy', destinationId: 'local-recipient',
    resourceId: 'example:rss', fields: ['residentBytes'] }));
  const batch = { batchId: 'copy-1', records: page.records }, request = { purpose: 'copy', destinationId: 'local-recipient' };
  assert.equal(required(await f.controller.storeLocalTelemetryCopy(batch, request)).copied, 1);
  assert.equal(required(await f.controller.storeLocalTelemetryCopy(batch, request)).copied, 0);
  const changed = structuredClone(batch); (changed.records[0] as { values: { residentBytes: number } }).values.residentBytes = 1;
  assert.deepEqual(await f.controller.storeLocalTelemetryCopy(changed, request), { ok: false, reason: 'integrity' });
  required(await f.controller.beginDeletion(selection));
  assert.deepEqual(await f.controller.storeLocalTelemetryCopy(batch, request), { ok: false, reason: 'review-required' });
  f.controller.close();
});

test('artifact output is verified and only an exact reviewed output pin permits bytes in export', async () => {
  const inputBytes = new TextEncoder().encode('bounded input'), outputBytes = new TextEncoder().encode('reviewed public artifact');
  const input = await createAssetReference('example:input', 'text', inputBytes), output = await createAssetReference('artifact:output', 'blob', outputBytes);
  const f = setup({ reviewedArtifacts: [{ applicationId: 'example:artifact', destinationId: 'owner-artifacts', sha256: output.sha256 }] });
  const ports = await f.ports();
  const jobs = createDurableArtifactJobStore({ ownerId: 'owner-a', storage: ports.artifacts, now: () => 1000,
    authorize: () => ({ expiresAt: 50000, isCurrent: () => true }) });
  required(await jobs.submit({ idempotencyKey: 'artifact-1', applicationId: 'example:artifact', profileId: '101:local-artifact',
    profileRevision: 1, destinationId: 'owner-artifacts', totalUnits: 1, input }));
  const attempt = required(await jobs.start('artifact-1', inputBytes)); required(await attempt.progress(1)); required(await attempt.commit(outputBytes));
  const metadata = required(await f.controller.exportPage({ kind: 'artifacts', purpose: 'portability', destinationId: 'owner-download' }));
  assert.equal(JSON.stringify(metadata).includes('reviewed public artifact'), false);
  const bytes = required(await f.controller.exportPage({ kind: 'artifacts', includeArtifactBytes: true, purpose: 'portability', destinationId: 'owner-download' }));
  assert.ok(JSON.stringify(bytes).includes(Buffer.from(outputBytes).toString('base64')));
  f.time(1100); required(await f.controller.sweep());
  const gone = required(await f.controller.exportPage({ kind: 'artifacts', purpose: 'portability', destinationId: 'owner-download' }));
  assert.equal(gone.records.length, 0); assert.equal(attempt.signal.aborted, true);
  f.controller.close(); await jobs.close();
});

test('corrupt future and foreign envelopes are preserved without exporting or silently erasing them', async () => {
  for (const raw of [{ version: 9, ownerId: 'owner-a' }, { version: 1, ownerId: 'owner-b' }, 'secret-corrupt-blob']) {
    const storage = memory(); storage.rows.set('owner-a', raw); const f = setup({}, storage);
    assert.equal((await f.controller.exportPage(exportSettings)).ok, false);
    assert.equal((await f.controller.beginDeletion(selection)).ok, false);
    assert.deepEqual(storage.rows.get('owner-a'), raw); f.controller.close();
  }
});

test('grant accessors, scope mismatch, non-current authority and throwing clocks fail closed', async () => {
  let getter = false;
  const accessor = setup({ authorize: scope => ({ scope, get expiresAt() { getter = true; return 50000; }, isCurrent: () => true }) });
  assert.deepEqual(await accessor.controller.openStores({ retireOwned() {} }), { ok: false, reason: 'denied' }); assert.equal(getter, false);
  const mismatched = setup({ authorize: scope => ({ scope: { ...scope, ownerId: 'other' }, expiresAt: scope.deadline, isCurrent: () => true }) });
  assert.deepEqual(await mismatched.controller.openStores({ retireOwned() {} }), { ok: false, reason: 'denied' });
  let clockThrows = false; const f = setup({ trustedNow: () => { if (clockThrows) throw new Error('clock'); return 1000; } });
  const ports = await f.ports(); clockThrows = true;
  assert.deepEqual(await f.controller.exportPage(exportSettings), { ok: false, reason: 'invalid-clock' }); assert.equal(ports.signal.aborted, true);
  clockThrows = false; assert.deepEqual(await f.controller.exportPage(exportSettings), { ok: false, reason: 'invalid-clock' });
  accessor.controller.close(); mismatched.controller.close(); f.controller.close();
});

test('expired/revoked writer leases and close retire authority and bounded callbacks immediately', async () => {
  const f = setup(), ports = await f.ports(); f.current(false);
  const settings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
  assert.equal((await settings.save(0, choice)).ok, false); assert.equal(ports.signal.aborted, true);
  f.current(true); const next = await f.ports(); f.time(61000);
  assert.equal((await next.settings.read('101.settings:owner-a').catch(() => 'failed')), 'failed');
  assert.equal(next.signal.aborted, true);
  f.controller.close(); assert.deepEqual(await f.controller.inspectDeletion(), { ok: false, reason: 'closed' });
});

test('owner ports reject foreign keys, reentrant authorization is reserved and capacities are finite', async () => {
  const f = setup(), ports = await f.ports();
  await assert.rejects(() => ports.settings.read('101.settings:owner-b'));
  for (let i = 1; i < 8; i++) await f.ports();
  assert.deepEqual(await f.controller.openStores({ retireOwned() {} }), { ok: false, reason: 'capacity' });
  assert.deepEqual(await f.controller.exportPage({ ...exportSettings, limit: 33 }), { ok: false, reason: 'invalid' });
  f.controller.close();
});

test('copy export rejects an extra persisted credential field instead of dumping a raw copied object', async () => {
  const f = setup();
  try {
    const ports = await f.ports(); await seedTelemetry(ports);
    const page = required(await f.controller.exportPage({ kind: 'telemetry', purpose: 'copy', destinationId: 'local-recipient' }));
    required(await f.controller.storeLocalTelemetryCopy({ batchId: 'copy-1', records: page.records }, { purpose: 'copy', destinationId: 'local-recipient' }));
    const raw = f.storage.rows.get('owner-a') as { copies: { record: Record<string, unknown> }[] };
    raw.copies[0]!.record.identityCredentials = 'never-export-this';
    const exported = await f.controller.exportPage({ kind: 'copies', purpose: 'portability', destinationId: 'owner-download' });
    assert.equal(exported.ok, false, 'unknown persisted copy keys must fail the closed producer schema');
    assert.equal(JSON.stringify(exported).includes('never-export-this'), false);
  } finally { f.controller.close(); }
});

test('a reused batch identity with different valid source rows conflicts before copying more data', async () => {
  const f = setup();
  try {
    const ports = await f.ports(), producer = await seedTelemetry(ports), capture = await producer.requestCapture(telemetryRequest);
    assert.ok(capture.ok); assert.ok(producer.enqueue(capture.handle, { ...observation, sourceTime: { ...observation.sourceTime, at: 18 } }).ok);
    assert.ok((await producer.flush()).ok);
    const page = required(await f.controller.exportPage({ kind: 'telemetry', purpose: 'copy', destinationId: 'local-recipient' }));
    required(await f.controller.storeLocalTelemetryCopy({ batchId: 'same-batch', records: [page.records[0]] }, { purpose: 'copy', destinationId: 'local-recipient' }));
    assert.deepEqual(await f.controller.storeLocalTelemetryCopy({ batchId: 'same-batch', records: [page.records[1]] }, { purpose: 'copy', destinationId: 'local-recipient' }),
      { ok: false, reason: 'conflict' });
  } finally { f.controller.close(); }
});

test('expired artifact bytes are inaccessible through an existing job handle before the host sweeps', async () => {
  const f = setup();
  try {
    const ports = await f.ports(), inputBytes = new TextEncoder().encode('input');
    const input = await createAssetReference('example:input', 'text', inputBytes);
    const jobs = createDurableArtifactJobStore({ ownerId: 'owner-a', storage: ports.artifacts, now: () => 1000,
      authorize: () => ({ expiresAt: 50000, isCurrent: () => true }) });
    required(await jobs.submit({ idempotencyKey: 'expired-1', applicationId: 'example:artifact', profileId: '101:local-artifact',
      profileRevision: 1, destinationId: 'owner-artifacts', totalUnits: 1, input }));
    const attempt = required(await jobs.start('expired-1', inputBytes)); required(await attempt.progress(1)); required(await attempt.commit(inputBytes));
    f.time(1100); assert.equal((await jobs.readOutput('expired-1')).ok, false);
    await jobs.close();
  } finally { f.controller.close(); }
});

test('read-only telemetry export after completed deletion cannot recreate a producer namespace', async () => {
  const f = setup();
  try {
    const ports = await f.ports(); await seedTelemetry(ports);
    const deletion = required(await f.controller.beginDeletion(selection));
    for (let stage = 0; stage < 4; stage++) required(await f.controller.resumeDeletionReviewed(deletion.operationId));
    assert.equal(required(await f.controller.exportPage({ kind: 'telemetry', purpose: 'inspect', destinationId: 'owner-download' })).records.length, 0);
    assert.deepEqual((f.storage.rows.get('owner-a') as { records: unknown }).records, {});
  } finally { f.controller.close(); }
});

test('deletion preserves incompatible or foreign producer envelopes inside an otherwise valid owner document', async () => {
  for (const producer of ['telemetry', 'settings', 'artifacts']) {
    for (const header of [{ version: 999, ownerId: 'owner-a' }, { version: 1, ownerId: 'foreign-owner' }]) {
      const f = setup();
      try {
        await f.ports(); const raw = f.storage.rows.get('owner-a') as { records: Record<string, unknown>; artifactExpiresAt?: number };
        raw.records[producer] = producer === 'telemetry' ? header : JSON.stringify(header);
        if (producer === 'artifacts') raw.artifactExpiresAt = 1100;
        const saved = structuredClone(raw);
        assert.equal((await f.controller.beginDeletion(selection)).ok, false, 'do not silently erase an unreadable producer');
        assert.deepEqual(f.storage.rows.get('owner-a'), saved);
      } finally { f.controller.close(); }
    }
  }
});

test('deletion validates actual producer row and output integrity before committing a barrier', async () => {
  const f = setup();
  try {
    const ports = await f.ports(); await seedTelemetry(ports);
    const raw = f.storage.rows.get('owner-a') as { records: { telemetry: { rows: { values: Record<string, unknown> }[] } } };
    raw.records.telemetry.rows[0]!.values.unselectedPrivateField = 'unreadable-corrupt-data';
    const saved = structuredClone(raw);
    assert.equal((await f.controller.beginDeletion(selection)).ok, false);
    assert.deepEqual(f.storage.rows.get('owner-a'), saved);
  } finally { f.controller.close(); }
});

test('retained copies verify exact recorded content rather than accepting a changed value under a known field', async () => {
  const f = setup();
  try {
    const ports = await f.ports(); await seedTelemetry(ports);
    const page = required(await f.controller.exportPage({ kind: 'telemetry', purpose: 'copy', destinationId: 'local-recipient' }));
    required(await f.controller.storeLocalTelemetryCopy({ batchId: 'copy-1', records: page.records }, { purpose: 'copy', destinationId: 'local-recipient' }));
    const raw = f.storage.rows.get('owner-a') as { copies: { record: { values: Record<string, unknown> } }[] };
    raw.copies[0]!.record.values.residentBytes = 'altered-unclassified-data';
    const saved = structuredClone(raw);
    const exported = await f.controller.exportPage({ kind: 'copies', purpose: 'portability', destinationId: 'owner-download' });
    assert.deepEqual(exported, { ok: false, reason: 'integrity' });
    assert.equal(JSON.stringify(exported).includes('altered-unclassified-data'), false);
    assert.equal((await f.controller.beginDeletion(selection)).ok, false);
    assert.deepEqual(f.storage.rows.get('owner-a'), saved);
  } finally { f.controller.close(); }
});

for (const reentry of ['close', 'abort-grant'] as const) test(`a final activation clock callback cannot ${reentry} and return a live writer or install a retired timer`, async t => {
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  const ownedTimers = new Set<ReturnType<typeof setTimeout>>();
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...args); if (args[1] === 60000) ownedTimers.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => {
    ownedTimers.delete(timer as ReturnType<typeof setTimeout>); originalClearTimeout(timer);
  });
  // Calibrate the ordinary public path, then reenter at its last trusted clock callback.
  let ordinaryReads = 0;
  const ordinary = setup({ trustedNow: () => { ordinaryReads++; return 1000; } });
  required(await ordinary.controller.openStores({ retireOwned() {} })); ordinary.controller.close();
  assert.equal(ownedTimers.size, 0);
  let reads = 0, retired = 0;
  const authority = new AbortController();
  const f = setup({ trustedNow: () => {
    if (++reads === ordinaryReads) { if (reentry === 'close') f.controller.close(); else authority.abort(); }
    return 1000;
  }, authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal }) });
  try {
    const result = await f.controller.openStores({ retireOwned() { retired++; } });
    assert.equal(result.ok, false, JSON.stringify({ lastClock: reads, resultOk: result.ok,
      returnedAborted: result.ok && result.value.signal.aborted, ownedTimers: ownedTimers.size }));
    assert.equal(ownedTimers.size, 0, 'no resource is installed after a callback retires activation');
    assert.equal(retired, 1);
    assert.deepEqual(await f.controller.openStores({ retireOwned() {} }), { ok: false, reason: reentry === 'close' ? 'closed' : 'revoked' });
  } finally {
    f.controller.close(); for (const timer of ownedTimers) originalClearTimeout(timer);
  }
});

test('a current-authority callback that retires its own writer cannot commit the just-produced state', async () => {
  let armed = false, ports: OwnerDataPorts | undefined;
  const f = setup({ authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent() {
    if (armed) ports!.close(); return true;
  } }) });
  try {
    ports = await f.ports(); await seedTelemetry(ports);
    const before = structuredClone(f.storage.rows.get('owner-a'));
    await assert.rejects(ports.telemetry.transact('owner-a', current => {
      const state = current as { rows: { values: { residentBytes: number } }[] };
      state.rows[0]!.values.residentBytes = 4322; armed = true;
      return { state, result: true };
    }));
    assert.equal(ports.signal.aborted, true);
    assert.deepEqual(f.storage.rows.get('owner-a'), before, 'retired callback mutation must not persist');
  } finally { f.controller.close(); }
});

test('a real filesystem artifact CAS preserves the actual producer document when its independent guard aborts after admission', async () => {
  assert.ok(api);
  const storageModule = await import(new URL('../../../examples/owner-data/filesystem-storage.mjs', import.meta.url).href);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), '101-owner-guard-test-')));
  const storage: OwnerDataStorage & { close(): void } = storageModule.createOwnerDataFilesystemStorage(directory);
  const authority = new AbortController(); let armed = false;
  const controller = api.createOwnerDataController({ ownerId: 'owner-a', storage, trustedNow() {
    if (armed) { armed = false; authority.abort(); } return 1000;
  }, authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
  let jobs: ReturnType<typeof createDurableArtifactJobStore> | undefined;
  try {
    const ports = required(await controller.openStores({ retireOwned() {} }));
    jobs = createDurableArtifactJobStore({ ownerId: 'owner-a', storage: ports.artifacts, now: () => 1000, authorize: () => undefined });
    const bytes = new TextEncoder().encode('actual producer guard fixture');
    required(await jobs.submit({ idempotencyKey: 'guard-fixture', applicationId: 'example:guard', profileId: '101:local-artifact',
      profileRevision: 1, destinationId: 'owner-artifacts', totalUnits: 1,
      input: await createAssetReference('example:guard-input', 'text', bytes) }));
    const expected = await ports.artifacts.read(jobs.key); assert.ok(expected);
    const producer = JSON.parse(expected) as { revision: number }; producer.revision++;
    const next = JSON.stringify(producer);
    const accepted = await ports.artifacts.compareAndSwap(jobs.key, expected, next, { signal: authority.signal,
      isCurrent() { armed = true; return true; } });
    const persisted = await storage.transact('owner-a', current => ({ state: current,
      result: (current as { records: { artifacts: string } }).records.artifacts }));
    assert.equal(accepted, false, JSON.stringify({ accepted, aborted: authority.signal.aborted, persisted: persisted === next }));
    assert.equal(authority.signal.aborted, true);
    assert.equal(persisted, expected, 'same engine transaction must retain the prior producer document');
  } finally { controller.close(); await jobs?.close(); storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const reentry of ['owner-grant', 'port-close'] as const) test(`the ${reentry} after the last synchronous predicate reaches the engine commit abort fence`, async () => {
  const authority = new AbortController();
  const f = setup({ authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal }) });
  try {
    const ports = await f.ports(), settings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
    assert.ok((await settings.save(0, choice)).ok);
    const before = structuredClone(f.storage.rows.get('owner-a')) as { records: { settings: string } };
    f.storage.before(state => {
      if ((state as { records: { settings: string } }).records.settings !== before.records.settings) {
        if (reentry === 'owner-grant') authority.abort(); else ports.close();
      }
    });
    const saved = await settings.save(1, { ...choice, preferences: { ...choice.preferences, theme: 'light' } });
    assert.equal(saved.ok, false, 'late native-commit cancellation cannot report a successful write');
    assert.equal(ports.signal.aborted, true);
    assert.deepEqual(f.storage.rows.get('owner-a'), before);
  } finally { f.controller.close(); }
});

// Selected-resource extension tests are authored before its implementation.
// These use the current public telemetry producer. Actual Node RSS/heap values
// are process diagnostics, never external-device measurements. The controlled
// trusted ingest clock is distinct from the per-process source receipt clock.
const telemetryOwnerResources = Object.freeze({ selected: 'owned-node:rss', retained: 'owned-node:heap-used' });
const selectedTelemetryDeletion = Object.freeze({ kinds: ['telemetry'] as const,
  purpose: 'owner-selected-resource-removal', telemetryResourceId: telemetryOwnerResources.selected });
const resourceExport = (resourceId: string, fields?: readonly string[]) => ({ kind: 'telemetry' as const,
  purpose: 'owner-resource-portability', destinationId: 'owner-download', resourceId, ...(fields ? { fields } : {}) });

async function seedCurrentPublicTelemetry(ports: OwnerDataPorts) {
  const observed = process.memoryUsage(), sourceTime = Object.freeze({
    clockId: `owned-node:${process.pid}:${crypto.randomUUID()}`, at: performance.now() });
  assert.ok(Number.isSafeInteger(observed.rss) && observed.rss > 0);
  assert.ok(Number.isSafeInteger(observed.heapUsed) && observed.heapUsed > 0);
  assert.ok(Number.isFinite(sourceTime.at) && sourceTime.at >= 0);
  const producer = createPublicTelemetryHistory({ ownerId: 'owner-a', storage: ports.telemetry,
    trustedNow: () => 1000, limits: { retentionMs: 5000 },
    authorize: scope => ({ scope, expiresAt: scope.expiresAt }) });
  const inputs = [{ resourceId: telemetryOwnerResources.selected, field: 'residentBytes', value: observed.rss },
    { resourceId: telemetryOwnerResources.retained, field: 'heapUsedBytes', value: observed.heapUsed }] as const;
  for (const input of inputs) {
    const capture = await producer.requestCapture({ resourceId: input.resourceId, schemaVersion: 1,
      fields: [input.field], provenanceFields: [], destinationId: 'local-history', purpose: 'owner-process-diagnostics',
      expiresAt: 51000, schema: { type: 'record', fields: { [input.field]: {
        type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER } } } });
    assert.ok(capture.ok, 'a genuine separately consented public producer capture must seed the fixture');
    assert.ok(producer.enqueue(capture.handle, { sourceTime, quality: 'observed', values: { [input.field]: input.value } }).ok);
  }
  const committed = await producer.flush(); assert.ok(committed.ok);
  assert.equal(committed.committed, 2, 'both actual process measurements must commit before the new feature assertion');
  return { producer, sourceTime, observed };
}

async function registerSelectedResourceCopies(controller: OwnerDataController) {
  const selected = required(await controller.exportPage(resourceExport(telemetryOwnerResources.selected, ['residentBytes'])));
  const retained = required(await controller.exportPage(resourceExport(telemetryOwnerResources.retained, ['heapUsedBytes'])));
  assert.equal(selected.records.length, 1); assert.equal(retained.records.length, 1);
  const selectedRecord = selected.records[0] as TelemetryRecord, retainedRecord = retained.records[0] as TelemetryRecord;
  assert.equal(selectedRecord.resourceId, telemetryOwnerResources.selected);
  assert.equal(retainedRecord.resourceId, telemetryOwnerResources.retained);
  for (const [batchId, records] of [['selected-process-rss', selected.records], ['retained-process-heap', retained.records]] as const) {
    assert.equal(required(await controller.storeLocalTelemetryCopy({ batchId, records }, {
      purpose: 'owner-reviewed-local-recipient', destinationId: 'local-recipient' })).copied, 1);
  }
  const copies = required(await controller.exportPage({ kind: 'copies', purpose: 'owner-copy-inspection', destinationId: 'owner-download' }));
  assert.equal(copies.records.length, 2, 'actual registered local copies must exist before selected deletion');
  return { selectedRecord, retainedRecord };
}

test('selected managed telemetry deletion removes only the reviewed resource and matching registered copies', async () => {
  assert.ok(api);
  const storageModule = await import(new URL('../../../examples/owner-data/filesystem-storage.mjs', import.meta.url).href);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), '101-telemetry-owner-selection-')));
  const storage: OwnerDataStorage & { close(): void } = storageModule.createOwnerDataFilesystemStorage(directory);
  const authority = new AbortController(), scopes: Parameters<OwnerDataOptions['authorize']>[0][] = [];
  let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined, retired = 0;
  const controller = api.createOwnerDataController({ ownerId: 'owner-a', storage, trustedNow: () => 1000,
    availableDevices: () => [], authorize(scope) {
      assert.equal(scope.ownerId, 'owner-a'); scopes.push(scope);
      return { scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal };
    } });
  const other = api.createOwnerDataController({ ownerId: 'owner-b', storage, trustedNow: () => 1000,
    availableDevices: () => [], authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
  const read = (ownerId: string) => storage.transact(ownerId, state => ({ state, result: structuredClone(state) }));
  try {
    const ports = required(await controller.openStores({ retireOwned() { retired++; producer?.close(); } }));
    const seeded = await seedCurrentPublicTelemetry(ports); producer = seeded.producer;
    const original = await registerSelectedResourceCopies(controller);
    assert.equal(original.selectedRecord.values.residentBytes, seeded.observed.rss);
    assert.equal(original.retainedRecord.values.heapUsedBytes, seeded.observed.heapUsed);
    for (const record of [original.selectedRecord, original.retainedRecord]) {
      assert.deepEqual(record.sourceTime, seeded.sourceTime); assert.equal(record.quality, 'observed');
      assert.equal(record.ingestedAt, 1000); assert.equal(record.expiresAt, 6000);
    }
    const ownerSettings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
    assert.ok((await ownerSettings.save(0, choice)).ok);
    const otherPorts = required(await other.openStores({ retireOwned() {} }));
    assert.ok((await createSettingsStore({ ownerId: 'owner-b', storage: otherPorts.settings,
      availableDevices: () => [] }).save(0, choice)).ok);
    const before = await read('owner-a') as { records: { telemetry: { rows: TelemetryRecord[] }; settings: string };
      copies: { record: TelemetryRecord }[] };
    const otherBefore = JSON.stringify(await read('owner-b'));
    const retainedProducerRow = before.records.telemetry.rows.find(row => row.resourceId === telemetryOwnerResources.retained);
    const retainedCopy = before.copies.find(row => row.record.resourceId === telemetryOwnerResources.retained);
    assert.ok(retainedProducerRow); assert.ok(retainedCopy);

    // OLD must fail here with {ok:false,reason:invalid}, after all genuine seeds.
    // A broad fallback is forbidden: it would destroy the unrelated resource.
    const deletion = required(await controller.beginDeletion(selectedTelemetryDeletion));
    assert.equal(deletion.state, 'pending'); assert.equal(ports.signal.aborted, true); assert.equal(retired, 1);
    assert.deepEqual(deletion.kinds, ['telemetry', 'copies']);
    const pending = await read('owner-a') as { deletion: { telemetryResourceId?: string } };
    assert.equal(pending.deletion.telemetryResourceId, telemetryOwnerResources.selected);
    assert.equal(scopes.find(scope => scope.action === 'delete')?.request.telemetryResourceId, telemetryOwnerResources.selected);
    assert.deepEqual(await controller.exportPage(resourceExport(telemetryOwnerResources.retained)), { ok: false, reason: 'review-required' });
    for (let stage = 0; stage < 2; stage++) required(await controller.resumeDeletionReviewed(deletion.operationId));
    const completed = required(await controller.inspectDeletion()); assert.equal(completed?.state, 'completed');
    assert.equal(completed?.removed.telemetry, 1); assert.equal(completed?.removed.copies, 1);
    const after = await read('owner-a') as { records: { telemetry: { rows: TelemetryRecord[] }; settings: string };
      copies: { record: TelemetryRecord }[]; deletion: Record<string, unknown>;
      audit: { action: string; state: string; expiresAt: number; removed: { telemetry: number; copies: number } }[] };
    assert.equal(after.records.telemetry.rows.length, 1); assert.deepEqual(after.records.telemetry.rows[0], retainedProducerRow);
    assert.equal(after.copies.length, 1); assert.deepEqual(after.copies[0], retainedCopy);
    assert.equal(after.records.settings, before.records.settings); assert.equal(JSON.stringify(await read('owner-b')), otherBefore);
    assert.equal(Object.hasOwn(after.deletion, 'telemetryResourceId'), false, 'completed durable metadata retains no resource selector');
    assert.equal(required(await controller.exportPage(resourceExport(telemetryOwnerResources.selected))).records.length, 0);
    assert.deepEqual(required(await controller.exportPage(resourceExport(telemetryOwnerResources.retained))).records, [original.retainedRecord]);
    const audit = after.audit.find(row => row.action === 'deletion'); assert.ok(audit);
    assert.deepEqual(Object.keys(audit).sort(), ['action', 'at', 'expiresAt', 'kinds', 'operationId', 'removed', 'state']);
    assert.equal(audit.state, 'completed'); assert.equal(audit.expiresAt, 1000 + 30 * 86400000);
    assert.equal(audit.removed.telemetry, 1); assert.equal(audit.removed.copies, 1);
    assert.equal(JSON.stringify(after.audit).includes(telemetryOwnerResources.selected), false);
    assert.equal(JSON.stringify(after.audit).includes('residentBytes'), false);
  } finally { authority.abort(); controller.close(); other.close(); producer?.close(); storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('selected telemetry deletion restart preserves its selector and requires fresh exact resume authority', async () => {
  const storage = memory(), scopes: Parameters<OwnerDataOptions['authorize']>[0][] = [];
  const first = setup({}, storage); let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  let resumed: ReturnType<typeof setup> | undefined, allow = false;
  try {
    const ports = await first.ports(); producer = (await seedCurrentPublicTelemetry(ports)).producer;
    const original = await registerSelectedResourceCopies(first.controller);
    const deletion = required(await first.controller.beginDeletion(selectedTelemetryDeletion));
    first.controller.close(); producer.close(); producer = undefined;
    resumed = setup({ authorize(scope) { scopes.push(scope); return allow
      ? { scope, expiresAt: scope.deadline, isCurrent: () => allow } : undefined; } }, storage);
    assert.equal(required(await resumed.controller.inspectDeletion())?.state, 'pending');
    assert.deepEqual(await resumed.controller.resumeDeletionReviewed(deletion.operationId), { ok: false, reason: 'denied' });
    const raw = storage.rows.get('owner-a') as { deletion: { completedStages: number; telemetryResourceId?: string } };
    assert.equal(raw.deletion.completedStages, 0); assert.equal(raw.deletion.telemetryResourceId, telemetryOwnerResources.selected);
    allow = true;
    for (let stage = 0; stage < 2; stage++) required(await resumed.controller.resumeDeletionReviewed(deletion.operationId));
    const requests = scopes.filter(scope => scope.action === 'resume-delete'); assert.equal(requests.length, 3);
    for (const scope of requests) {
      assert.equal(scope.ownerId, 'owner-a'); assert.equal(scope.request.operationId, deletion.operationId);
      assert.equal(scope.request.telemetryResourceId, telemetryOwnerResources.selected);
    }
    assert.equal(required(await resumed.controller.exportPage(resourceExport(telemetryOwnerResources.selected))).records.length, 0);
    assert.deepEqual(required(await resumed.controller.exportPage(resourceExport(telemetryOwnerResources.retained))).records, [original.retainedRecord]);
    const fresh = await resumed.ports(), history = createPublicTelemetryHistory({ ownerId: 'owner-a', storage: fresh.telemetry,
      trustedNow: () => 1000, authorize: () => undefined });
    assert.equal(history.status().captureHandles, 0); assert.equal(history.status().uploadHandles, 0); history.close(); fresh.close();
  } finally { first.controller.close(); resumed?.controller.close(); producer?.close(); }
});

test('telemetry resource selector is rejected outside exactly one telemetry kind before destructive authority', async () => {
  const scopes: Parameters<OwnerDataOptions['authorize']>[0][] = [];
  const f = setup({ authorize(scope) { scopes.push(scope); return { scope, expiresAt: scope.deadline, isCurrent: () => true }; } });
  let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(); producer = (await seedCurrentPublicTelemetry(ports)).producer;
    await registerSelectedResourceCopies(f.controller); const before = structuredClone(f.storage.rows.get('owner-a'));
    for (const kinds of [['settings'], ['copies'], ['telemetry', 'copies'], ['telemetry', 'settings'], ['telemetry', 'telemetry']] as const) {
      assert.deepEqual(await f.controller.beginDeletion({ ...selectedTelemetryDeletion, kinds }), { ok: false, reason: 'invalid' });
      assert.deepEqual(f.storage.rows.get('owner-a'), before); assert.equal(ports.signal.aborted, false);
    }
    assert.equal(scopes.filter(scope => scope.action === 'delete').length, 0);
    // Absent selector still follows the existing broad kind contract.
    const broad = required(await f.controller.beginDeletion({ kinds: ['telemetry'], purpose: 'owner-broad-resource-removal' }));
    for (let stage = 0; stage < 2; stage++) required(await f.controller.resumeDeletionReviewed(broad.operationId));
    const done = required(await f.controller.inspectDeletion()); assert.equal(done?.removed.telemetry, 2); assert.equal(done?.removed.copies, 2);
    assert.equal(required(await f.controller.exportPage({ kind: 'telemetry', purpose: 'owner-after-broad', destinationId: 'owner-download' })).records.length, 0);
  } finally { f.controller.close(); producer?.close(); }
});

test('selected telemetry deletion rejects malformed and accessor selectors without executing getters or authorizing deletion', async () => {
  let authorizations = 0, getters = 0;
  const f = setup({ authorize(scope) { if (scope.action === 'delete') authorizations++;
    return { scope, expiresAt: scope.deadline, isCurrent: () => true }; } });
  try {
    const ports = await f.ports(), producer = (await seedCurrentPublicTelemetry(ports)).producer;
    try {
      const before = structuredClone(f.storage.rows.get('owner-a'));
      for (const resource of ['', 'foreign resource', 'x'.repeat(129), undefined, 1]) {
        const value = { ...selectedTelemetryDeletion, telemetryResourceId: resource };
        assert.equal((await f.controller.beginDeletion(value as unknown as Parameters<OwnerDataController['beginDeletion']>[0])).ok, false);
      }
      const accessor = { kinds: ['telemetry'] as const, purpose: 'owner-selected-resource-removal',
        get telemetryResourceId() { getters++; return telemetryOwnerResources.selected; } };
      assert.equal((await f.controller.beginDeletion(accessor)).ok, false);
      assert.equal(getters, 0); assert.equal(authorizations, 0);
      assert.deepEqual(f.storage.rows.get('owner-a'), before); assert.equal(ports.signal.aborted, false);
    } finally { producer.close(); }
  } finally { f.controller.close(); }
});

test('selected deletion exact initial and resumed approval cannot widen or omit its resource selector', async () => {
  let mismatch: 'none' | 'initial' | 'resume' = 'initial';
  const f = setup({ authorize(scope) {
    const wrong = scope.action === 'delete' && mismatch === 'initial' || scope.action === 'resume-delete' && mismatch === 'resume';
    const request = { ...scope.request }; if (wrong) delete request.telemetryResourceId;
    return { scope: wrong ? { ...scope, request } : scope, expiresAt: scope.deadline, isCurrent: () => true };
  } });
  let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(); producer = (await seedCurrentPublicTelemetry(ports)).producer;
    await registerSelectedResourceCopies(f.controller);
    const before = structuredClone(f.storage.rows.get('owner-a'));
    assert.deepEqual(await f.controller.beginDeletion(selectedTelemetryDeletion), { ok: false, reason: 'denied' });
    assert.deepEqual(f.storage.rows.get('owner-a'), before); assert.equal(ports.signal.aborted, false);
    mismatch = 'none'; const deletion = required(await f.controller.beginDeletion(selectedTelemetryDeletion));
    const pending = structuredClone(f.storage.rows.get('owner-a')); mismatch = 'resume';
    assert.deepEqual(await f.controller.resumeDeletionReviewed(deletion.operationId), { ok: false, reason: 'denied' });
    assert.deepEqual(f.storage.rows.get('owner-a'), pending);
    mismatch = 'none'; for (let stage = 0; stage < 2; stage++) required(await f.controller.resumeDeletionReviewed(deletion.operationId));
    assert.equal(required(await f.controller.exportPage(resourceExport(telemetryOwnerResources.retained))).records.length, 1);
  } finally { f.controller.close(); producer?.close(); }
});

test('selected deletion retires queued old producer data and a late registered copy cannot resurrect it', async () => {
  const f = setup(); let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(), seeded = await seedCurrentPublicTelemetry(ports); producer = seeded.producer;
    const original = await registerSelectedResourceCopies(f.controller);
    const capture = await producer.requestCapture({ resourceId: telemetryOwnerResources.selected, schemaVersion: 1,
      fields: ['residentBytes'], provenanceFields: [], destinationId: 'local-history', purpose: 'owner-process-diagnostics', expiresAt: 51000,
      schema: { type: 'record', fields: { residentBytes: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER } } } });
    assert.ok(capture.ok); assert.ok(producer.enqueue(capture.handle, { sourceTime: seeded.sourceTime,
      quality: 'observed', values: { residentBytes: seeded.observed.rss } }).ok);
    const deletion = required(await f.controller.beginDeletion(selectedTelemetryDeletion));
    assert.equal(ports.signal.aborted, true); assert.equal((await producer.flush()).ok, false);
    assert.equal((await f.controller.storeLocalTelemetryCopy({ batchId: 'late-selected-copy', records: [original.selectedRecord] },
      { purpose: 'owner-reviewed-local-recipient', destinationId: 'local-recipient' })).ok, false);
    for (let stage = 0; stage < 2; stage++) required(await f.controller.resumeDeletionReviewed(deletion.operationId));
    assert.equal((await f.controller.storeLocalTelemetryCopy({ batchId: 'late-selected-copy', records: [original.selectedRecord] },
      { purpose: 'owner-reviewed-local-recipient', destinationId: 'local-recipient' })).ok, false);
    assert.equal(required(await f.controller.exportPage(resourceExport(telemetryOwnerResources.selected))).records.length, 0);
    assert.deepEqual(required(await f.controller.exportPage(resourceExport(telemetryOwnerResources.retained))).records, [original.retainedRecord]);
  } finally { f.controller.close(); producer?.close(); }
});

test('selected telemetry stage revoked at the supplied final guard preserves all producer rows and registered copies', async () => {
  const authority = new AbortController(); let revokeAtStage = false;
  const f = setup({ authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal }) });
  let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(); producer = (await seedCurrentPublicTelemetry(ports)).producer;
    await registerSelectedResourceCopies(f.controller);
    const deletion = required(await f.controller.beginDeletion(selectedTelemetryDeletion));
    const pending = structuredClone(f.storage.rows.get('owner-a'));
    f.storage.before(state => {
      const value = state as { deletion?: { completedStages: number } };
      if (revokeAtStage && value.deletion?.completedStages === 1) authority.abort();
    }); revokeAtStage = true;
    assert.equal((await f.controller.resumeDeletionReviewed(deletion.operationId)).ok, false);
    assert.equal(authority.signal.aborted, true); assert.deepEqual(f.storage.rows.get('owner-a'), pending);
  } finally { f.controller.close(); producer?.close(); }
});

test('selected telemetry stage clock expiry after producer work cannot commit a deletion stage', async () => {
  let time = 1000, expireAtStage = false;
  const engine = memory(), storage: OwnerDataStorage = { transact(ownerId, mutation, guard) {
    return engine.storage.transact(ownerId, raw => {
      const next = mutation(raw), plan = (next.state as { deletion?: { completedStages: number } }).deletion;
      if (expireAtStage && plan?.completedStages === 1) time = 2000;
      return next;
    }, guard);
  } };
  const f = setup({ storage, trustedNow: () => time,
    authorize: scope => ({ scope, expiresAt: 2000, isCurrent: () => true }) }, engine);
  let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(); producer = (await seedCurrentPublicTelemetry(ports)).producer;
    await registerSelectedResourceCopies(f.controller);
    const deletion = required(await f.controller.beginDeletion(selectedTelemetryDeletion)), pending = structuredClone(engine.rows.get('owner-a'));
    expireAtStage = true;
    assert.equal((await f.controller.resumeDeletionReviewed(deletion.operationId)).ok, false);
    assert.deepEqual(engine.rows.get('owner-a'), pending);
  } finally { f.controller.close(); producer?.close(); }
});

test('selected stage keeps the owner operation busy until supplied held storage actually settles after close', async () => {
  const engine = memory(); let release!: () => void, entered!: () => void, hold = false;
  const pending = new Promise<void>(resolve => { release = resolve; }), boundary = new Promise<void>(resolve => { entered = resolve; });
  const storage: OwnerDataStorage = { async transact(ownerId, mutation, guard) {
    const next = mutation(structuredClone(engine.rows.get(ownerId)));
    const plan = (next.state as { deletion?: { completedStages: number } }).deletion;
    if (hold && plan?.completedStages === 1) { entered(); await pending; }
    if (guard && (guard.signal.aborted || guard.isCurrent() !== true || guard.signal.aborted)) throw new Error('held-storage-cancelled');
    engine.rows.set(ownerId, structuredClone(next.state)); return next.result;
  } };
  const f = setup({ storage }, engine); let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(); producer = (await seedCurrentPublicTelemetry(ports)).producer;
    await registerSelectedResourceCopies(f.controller);
    const deletion = required(await f.controller.beginDeletion(selectedTelemetryDeletion)), before = structuredClone(engine.rows.get('owner-a'));
    hold = true; let settled = false;
    const stage = f.controller.resumeDeletionReviewed(deletion.operationId).finally(() => { settled = true; });
    await boundary; assert.equal(settled, false);
    assert.deepEqual(await f.controller.inspectDeletion(), { ok: false, reason: 'busy' });
    f.controller.close(); await Promise.resolve(); assert.equal(settled, false, 'synchronous close is authority retirement, not native settlement');
    release(); assert.equal((await stage).ok, false); assert.deepEqual(engine.rows.get('owner-a'), before);
  } finally { release(); f.controller.close(); producer?.close(); }
});

test('selected deletion authorizer reentry closes authority before the owner barrier can commit', async () => {
  let armed = false;
  const f = setup({ authorize(scope) {
    if (armed && scope.action === 'delete') controller.close();
    return { scope, expiresAt: scope.deadline, isCurrent: () => true };
  } }); const controller = f.controller;
  let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(); producer = (await seedCurrentPublicTelemetry(ports)).producer;
    await registerSelectedResourceCopies(f.controller);
    const before = structuredClone(f.storage.rows.get('owner-a')); armed = true;
    assert.equal((await f.controller.beginDeletion(selectedTelemetryDeletion)).ok, false);
    assert.equal(ports.signal.aborted, true); assert.deepEqual(f.storage.rows.get('owner-a'), before);
  } finally { f.controller.close(); producer?.close(); }
});

test('selected telemetry stage preserves corrupt producer bytes for separate recovery instead of whole-owner fallback', async () => {
  const f = setup(); let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(); producer = (await seedCurrentPublicTelemetry(ports)).producer;
    await registerSelectedResourceCopies(f.controller);
    const deletion = required(await f.controller.beginDeletion(selectedTelemetryDeletion));
    const raw = f.storage.rows.get('owner-a') as { records: { telemetry: { bytes: number } } };
    raw.records.telemetry.bytes++; const corrupt = structuredClone(raw);
    assert.equal((await f.controller.resumeDeletionReviewed(deletion.operationId)).ok, false);
    assert.deepEqual(f.storage.rows.get('owner-a'), corrupt);
  } finally { f.controller.close(); producer?.close(); }
});

test('real owner grant abort retires ports even with own signal shadows', async () => {
  const authority = new AbortController();
  const intrinsicAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
  Object.defineProperties(authority.signal, {
    aborted: { value: false, configurable: true },
    addEventListener: { value() {}, configurable: true },
    removeEventListener: { value() {}, configurable: true },
  });
  const f = setup({ authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal }) });
  try {
    const ports = await f.ports();
    const settings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
    assert.ok((await settings.save(0, choice)).ok);
    const before = JSON.stringify(f.storage.rows.get('owner-a'));
    authority.abort();
    assert.equal(intrinsicAborted.call(authority.signal), true, 'Actual native grant signal revoked');
    assert.equal(authority.signal.aborted, false, 'Faithful caller own data shadow');
    assert.equal(ports.signal.aborted, true, 'Native abort must retire already-open owner ports');
    assert.equal((await settings.save(1, { ...choice, preferences: { ...choice.preferences, theme: 'light' } })).ok, false);
    assert.equal(JSON.stringify(f.storage.rows.get('owner-a')), before);
    assert.equal(f.retired(), 1);
  } finally { f.controller.close(); }
});

test('shadowed native owner grant abort after selected mutation reaches the supplied final commit signal', async () => {
  const engine = memory(), authority = new AbortController();
  const intrinsicAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
  Object.defineProperties(authority.signal, { aborted: { value: false }, addEventListener: { value() {} }, removeEventListener: { value() {} } });
  let arm = false, queued = 0, composedAborted = false;
  const storage: OwnerDataStorage = { async transact(ownerId, mutation, guard) {
    const next = mutation(structuredClone(engine.rows.get(ownerId)));
    const plan = (next.state as { deletion?: { completedStages: number } }).deletion;
    if (arm && plan?.completedStages === 1) {
      queueMicrotask(() => { queued++; authority.abort(); composedAborted = intrinsicAborted.call(guard!.signal); });
      await Promise.resolve();
    }
    if (guard && (intrinsicAborted.call(guard.signal) || guard.isCurrent() !== true || intrinsicAborted.call(guard.signal)))
      throw new Error('queued-commit-cancelled');
    engine.rows.set(ownerId, structuredClone(next.state)); return next.result;
  } };
  const f = setup({ storage, authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal }) }, engine);
  let producer: ReturnType<typeof createPublicTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(); producer = (await seedCurrentPublicTelemetry(ports)).producer;
    await registerSelectedResourceCopies(f.controller);
    const deletion = required(await f.controller.beginDeletion(selectedTelemetryDeletion)), before = structuredClone(engine.rows.get('owner-a'));
    arm = true; assert.equal((await f.controller.resumeDeletionReviewed(deletion.operationId)).ok, false);
    assert.equal(queued, 1); assert.equal(composedAborted, true, 'Native abort propagation must survive no-op own listener methods');
    assert.equal(intrinsicAborted.call(authority.signal), true); assert.equal(authority.signal.aborted, false);
    assert.deepEqual(engine.rows.get('owner-a'), before);
  } finally { f.controller.close(); producer?.close(); }
});

test('unbranded AbortSignal prototype impostor cannot authorize owner ports', async () => {
  const impostor = Object.create(AbortSignal.prototype) as AbortSignal;
  const f = setup({ authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true, signal: impostor }) });
  try { assert.deepEqual(await f.controller.openStores({ retireOwned() {} }), { ok: false, reason: 'denied' }); }
  finally { f.controller.close(); }
});

test('actual producer guard native abort cannot be hidden by own signal shadows at the owner artifact port', async () => {
  const authority = new AbortController(), intrinsicAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
  Object.defineProperties(authority.signal, { aborted: { value: false }, addEventListener: { value() {} }, removeEventListener: { value() {} } });
  const f = setup(); let jobs: ReturnType<typeof createDurableArtifactJobStore> | undefined;
  try {
    const ports = await f.ports();
    jobs = createDurableArtifactJobStore({ ownerId: 'owner-a', storage: ports.artifacts, now: () => 1000, authorize: () => undefined });
    const input = new TextEncoder().encode('actual public artifact producer document');
    required(await jobs.submit({ idempotencyKey: 'shadow-guard-fixture', applicationId: 'example:guard', profileId: '101:local-artifact',
      profileRevision: 1, destinationId: 'owner-artifacts', totalUnits: 1,
      input: await createAssetReference('example:guard-input', 'text', input) }));
    const expected = await ports.artifacts.read(jobs.key); assert.ok(expected);
    const document = JSON.parse(expected) as { revision: number }; document.revision++;
    const before = structuredClone(f.storage.rows.get('owner-a')); authority.abort();
    assert.equal(intrinsicAborted.call(authority.signal), true); assert.equal(authority.signal.aborted, false);
    const accepted = await ports.artifacts.compareAndSwap(jobs.key, expected, JSON.stringify(document),
      { signal: authority.signal, isCurrent: () => true });
    assert.equal(accepted, false); assert.deepEqual(f.storage.rows.get('owner-a'), before);
    assert.equal(ports.signal.aborted, false, 'Producer cancellation does not revoke an independent still-current owner lease');
  } finally { f.controller.close(); await jobs?.close(); }
});


test('producer observer expiry at the supplied final artifact commit cannot outlive the owner grant', async () => {
  const engine = memory(); let time = 1000, armed = false, finalGuard = false, observed = 0;
  const storage: OwnerDataStorage = { async transact(ownerId, mutation, guard) {
    const next = mutation(structuredClone(engine.rows.get(ownerId)));
    finalGuard = armed;
    try {
      if (guard && (guard.signal.aborted || guard.isCurrent() !== true || guard.signal.aborted)) throw new Error('actual-final-commit-denied');
    } finally { finalGuard = false; }
    engine.rows.set(ownerId, structuredClone(next.state)); return next.result;
  } };
  const f = setup({ storage, trustedNow: () => time, artifactRetentionMs: 10000,
    authorize: scope => ({ scope, expiresAt: 2000, isCurrent: () => true }) }, engine);
  let jobs: ReturnType<typeof createDurableArtifactJobStore> | undefined;
  try {
    const ports = await f.ports();
    jobs = createDurableArtifactJobStore({ ownerId: 'owner-a', storage: ports.artifacts, now: () => 1000, authorize: () => undefined });
    required(await jobs.submit({ idempotencyKey: 'deadline-guard-fixture', applicationId: 'example:deadline-guard',
      profileId: '101:local-artifact', profileRevision: 1, destinationId: 'owner-artifacts', totalUnits: 1,
      input: await createAssetReference('example:deadline-input', 'text', new TextEncoder().encode('actual public artifact producer document')) }));
    const expected = await ports.artifacts.read(jobs.key); assert.ok(expected);
    const document = JSON.parse(expected) as { revision: number }; document.revision++;
    const before = structuredClone(engine.rows.get('owner-a')); armed = true;
    const accepted = await ports.artifacts.compareAndSwap(jobs.key, expected, JSON.stringify(document),
      { isCurrent() { if (finalGuard) { observed++; time = 2000; } return true; } });
    assert.equal(observed, 1, 'Actual supplied engine invokes the producer observer at its final commit boundary');
    assert.equal(accepted, false, 'Recheck owner expiry after the producer observer returns');
    assert.deepEqual(engine.rows.get('owner-a'), before);
  } finally { f.controller.close(); await jobs?.close(); }
});
