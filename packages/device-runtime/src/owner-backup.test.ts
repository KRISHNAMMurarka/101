import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { createOwnerDataController } from './owner-data.ts';
import { createSettingsStore } from './settings-store.ts';
import { createTelemetryHistory } from './telemetry-history.ts';
import { createDurableArtifactJobStore } from './durable-artifact-jobs.ts';
import { createAssetReference } from '@101/device-model';
import type { OwnerDataStorage } from './owner-data.ts';
import type { OwnerBackupOptions } from './owner-backup.ts';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@101/device-model') return next(new URL('../../device-model/src/index.ts', import.meta.url).href, context);
  return next(specifier, context);
} });
const api = await import('./owner-backup.ts').catch(() => undefined);
const choice = { preferences: { theme: 'dark', handedness: 'left', motion: 'reduce' }, profiles: [] };
const required = <T>(value: { ok: true; value: T } | { ok: false; reason: string }): T => { assert.ok(value.ok, JSON.stringify(value)); return value.value; };
function memory() {
  const values = new Map<string, unknown>();
  let before: (() => void) | undefined;
  const storage: OwnerDataStorage = { async transact(owner, mutate, guard) {
    if (guard?.signal.aborted || guard && !guard.isCurrent()) throw Error('unit-cancelled');
    const next = mutate(structuredClone(values.get(owner)));
    if (guard?.signal.aborted || guard && !guard.isCurrent()) throw Error('unit-cancelled');
    before?.(); if (guard?.signal.aborted || guard && !guard.isCurrent()) throw Error('unit-cancelled');
    values.set(owner, structuredClone(next.state)); return next.result;
  } };
  return { storage, values, before(value?: () => void) { before = value; } };
}
function setup(overrides: Partial<OwnerBackupOptions> = {}, engine = memory()) {
  assert.ok(api, 'managed-owner-backup/1 must provide guarded recovery rather than a raw storage copy');
  let now = 1000, allowed = true, retired = 0;
  const authority = new AbortController();
  const backup = api.createOwnerBackupController({ ownerId: 'owner-a', storage: engine.storage, trustedNow: () => now,
    authorize: scope => allowed ? { scope, expiresAt: scope.deadline, isCurrent: () => allowed, signal: authority.signal } : undefined,
    availableDevices: () => [], ...overrides });
  const data = createOwnerDataController({ ownerId: 'owner-a', storage: backup.managedStorage, trustedNow: () => now,
    authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
  return { backup, data, engine, authority, time(value: number) { now = value; }, allow(value: boolean) { allowed = value; },
    retireOwned() { retired++; }, retired: () => retired,
    async ports() { return required(await data.openStores({ retireOwned() {} })); }, close() { data.close(); backup.close(); } };
}
const request = { backupId: 'snapshot-a', purpose: 'owner-recovery', destinationId: 'local-recovery' } as const;
const copyRequest = { ...request, registeredCopies: 'include' } as const;

async function seedRegisteredCopy(f: ReturnType<typeof setup>) {
  const ports = await f.ports();
  required(await createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] }).save(0, choice));
  const history = createTelemetryHistory({ ownerId: 'owner-a', storage: ports.telemetry, trustedNow: () => 1000,
    authorize: scope => ({ scope, expiresAt: scope.expiresAt }), limits: { retentionMs: 5000 } });
  try {
    const capture = await history.requestCapture({ resourceId: 'example:copied-rss', schemaVersion: 1,
      fields: ['rss'], provenanceFields: [], destinationId: 'local-history', purpose: 'owner-diagnostics', expiresAt: 51000,
      schema: { type: 'record', fields: { rss: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER } } } });
    assert.ok(capture.ok);
    const rss = process.memoryUsage().rss, stamp = performance.now();
    assert.ok(history.enqueue(capture.handle, { sourceTime: { clockId: 'owned-node-process-clock', at: stamp },
      quality: 'observed', values: { rss } }).ok);
    assert.ok((await history.flush()).ok);
    const upload = await history.requestUpload({ resourceId: 'example:copied-rss', schemaVersion: 1, fields: ['rss'], provenanceFields: [],
      destinationId: 'local-recipient', purpose: 'owner-local-copy', expiresAt: 51000 }, async batch => {
      required(await f.data.storeLocalTelemetryCopy(batch, { purpose: 'owner-local-copy', destinationId: 'local-recipient' }));
      return { batchId: batch.batchId, recordIds: batch.records.map(row => row.id) };
    });
    assert.ok(upload.ok); assert.ok((await history.pumpUpload(upload.handle)).ok);
    return { rss, stamp };
  } finally { history.close(); ports.close(); }
}

test('explicit registered-copy backup and damaged recovery preserve genuine producer bytes and require new copy consent', async () => {
  const scopes: Parameters<OwnerBackupOptions['authorize']>[0][] = [];
  const consent = new AbortController();
  const f = setup({ authorize: scope => { scopes.push(scope); return { scope, expiresAt: scope.deadline, isCurrent: () => true, signal: consent.signal }; } });
  try {
    const actual = await seedRegisteredCopy(f);
    assert.deepEqual(await f.backup.backup(request), { ok: false, reason: 'unsupported' });
    const saved = required(await f.backup.backup(copyRequest));
    assert.equal(saved.expiresAt, 6000);
    const bytes = required(await f.backup.readBackup(copyRequest));
    const payload = JSON.parse(new TextDecoder().decode(bytes.bytes));
    assert.equal(payload.managed.copies.length, 1); assert.equal(payload.managed.copies[0].record.values.rss, actual.rss);
    assert.equal(payload.managed.copies[0].record.sourceTime.at, actual.stamp);
    const selected = scopes.find(scope => scope.action === 'backup')?.registeredCopies;
    assert.equal(selected?.selection, 'all-registered-local'); assert.equal(selected?.count, 1);
    assert.match(selected?.sha256 ?? '', /^[0-9a-f]{64}$/); assert.ok(Object.isFrozen(selected));
    assert.deepEqual(await f.backup.readBackup(request), { ok: false, reason: 'unsupported' });
    damageInner(f);
    assert.deepEqual(await f.backup.restoreReviewed({ ...request, expectedSha256: saved.reference.sha256, retireOwned() {} }),
      { ok: false, reason: 'unsupported' });
    required(await f.backup.restoreReviewed({ ...copyRequest, expectedSha256: saved.reference.sha256, retireOwned: f.retireOwned }));
    const copies = required(await f.data.exportPage({ kind: 'copies', purpose: 'review-restored-copies', destinationId: 'owner-download' }));
    assert.deepEqual(copies.records, payload.managed.copies.map((copy: { record: unknown }) => copy.record));
    const next = await f.ports();
    const history = createTelemetryHistory({ ownerId: 'owner-a', storage: next.telemetry, trustedNow: () => 1000, authorize: () => undefined });
    assert.equal(history.status().captureHandles, 0); assert.equal(history.status().uploadHandles, 0); history.close(); next.close();
  } finally { f.close(); }
});

test('registered-copy approval requires exact selected content and a genuine current abort signal', async () => {
  for (const fault of ['missing-signal', 'forged-signal', 'changed-selection', 'getter'] as const) {
    let calls = 0;
    const f = setup({ authorize: scope => {
      const value = { scope, expiresAt: scope.deadline, isCurrent: () => true,
        signal: new AbortController().signal };
      if (fault === 'missing-signal') return { scope, expiresAt: scope.deadline, isCurrent: () => true };
      if (fault === 'forged-signal') value.signal = Object.create(AbortSignal.prototype) as AbortSignal;
      if (fault === 'changed-selection') value.scope = { ...scope, registeredCopies: { ...scope.registeredCopies!, count: 0 } };
      if (fault === 'getter') Object.defineProperty(value, 'signal', { enumerable: true, get() { calls++; return new AbortController().signal; } });
      return value;
    } });
    try {
      await seedRegisteredCopy(f); const before = structuredClone(f.engine.values.get('owner-a'));
      assert.deepEqual(await f.backup.backup(copyRequest), { ok: false, reason: 'denied' });
      assert.deepEqual(f.engine.values.get('owner-a'), before); assert.equal(calls, 0);
    } finally { f.close(); }
  }
});

test('a selected copy grant cannot hide real revocation behind shadow signal properties', async () => {
  const f = setup();
  try {
    await seedRegisteredCopy(f); const saved = required(await f.backup.backup(copyRequest)); damageInner(f);
    Object.defineProperties(f.authority.signal, {
      aborted: { value: false }, addEventListener: { value() {} },
    });
    let commits = 0; f.engine.before(() => { if (++commits === 2) f.authority.abort(); });
    const before = structuredClone(f.engine.values.get('owner-a'));
    assert.equal((await f.backup.restoreReviewed({ ...copyRequest, expectedSha256: saved.reference.sha256, retireOwned() {} })).ok, false);
    assert.deepEqual(f.engine.values.get('owner-a'), before);
  } finally { f.close(); }
});

test('queued selected-grant revocation reaches the actual composed storage abort signal', async () => {
  const engine = memory(); let armed = false, release: () => void = () => {}, entered: () => void = () => {};
  let nativeSignal: AbortSignal | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const storage: OwnerDataStorage = { async transact(owner, mutation, guard) {
    const before = structuredClone(engine.values.get(owner)), next = mutation(before);
    if (armed && (next.state as { archives: unknown[] }).archives.length > (before as { archives: unknown[] }).archives.length) {
      nativeSignal = guard?.signal; entered(); await held;
    }
    return engine.storage.transact(owner, () => next, guard);
  } };
  const f = setup({}, { ...engine, storage });
  try {
    await seedRegisteredCopy(f);
    Object.defineProperty(f.authority.signal, 'addEventListener', { value() {} });
    armed = true; const awaiting = f.backup.backup(copyRequest); await entry;
    queueMicrotask(() => f.authority.abort()); await Promise.resolve();
    // This is actual intrinsic AbortSignal propagation at a held supplied-storage seam.
    // It does not claim to prove an IndexedDB commit or persistence outcome.
    assert.equal(nativeSignal?.aborted, true);
    release(); assert.equal((await awaiting).ok, false);
  } finally { release(); f.data.close(); await f.backup.close(); }
});

test('a timed-out storage operation retains busy and close completion until its actual returned work settles', async () => {
  const engine = memory(); let release: () => void = () => {}, entered: () => void = () => {};
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const storage: OwnerDataStorage = { async transact(owner, mutation, guard) {
    entered(); await held; return engine.storage.transact(owner, mutation, guard);
  } };
  const authority = new AbortController();
  const backup = api!.createOwnerBackupController({ ownerId: 'held-owner', storage, trustedNow: () => 1000,
    authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal }) });
  let closeSettled = false;
  try {
    const waiting = backup.inspect({ purpose: 'held-inspection', destinationId: 'local-recovery' }); await entry;
    assert.deepEqual(await waiting, { ok: false, reason: 'expired' });
    assert.deepEqual(await backup.inspect({ purpose: 'second-inspection', destinationId: 'local-recovery' }), { ok: false, reason: 'busy' });
    const closing = Promise.resolve(backup.close()).then(() => { closeSettled = true; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(closeSettled, false);
    release(); await closing; assert.equal(closeSettled, true); assert.equal(engine.values.size, 0);
  } finally { release(); await backup.close(); }
});

test('close also awaits raw work issued through the direct managed storage port', async () => {
  const engine = memory(); let release: () => void = () => {}, entered: () => void = () => {};
  let reentrantClose: Promise<void> | undefined;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const backup = api!.createOwnerBackupController({ ownerId: 'direct-held-owner', trustedNow: () => 1000,
    storage: { async transact(owner, mutation, guard) {
      guard?.signal.addEventListener('abort', () => { reentrantClose = backup.close(); }, { once: true });
      entered(); await held; return engine.storage.transact(owner, mutation, guard);
    } },
    authorize: () => undefined });
  const writing = backup.managedStorage.transact('direct-held-owner', () => { assert.fail('retired direct writer reached mutation'); });
  const observedFailure = writing.then(() => assert.fail('retired direct write accepted'), () => {});
  let settled = false;
  try {
    await entry;
    const closing = Promise.resolve(backup.close()).then(() => { settled = true; });
    assert.equal(backup.close(), backup.close()); assert.equal(reentrantClose, backup.close());
    await Promise.resolve(); assert.equal(settled, false);
    release(); await observedFailure; await closing; assert.equal(settled, true); assert.equal(engine.values.size, 0);
  } finally { release(); await observedFailure; await backup.close(); }
});

test('an authorization timeout retains its actual approval work through busy and close settlement', async () => {
  const engine = memory(); let release: () => void = () => {}, entered: () => void = () => {};
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = setup({ authorize: async scope => { entered(); await held;
    return { scope, expiresAt: scope.deadline, isCurrent: () => true, signal: new AbortController().signal };
  } }, engine);
  let settled = false;
  try {
    const ports = await f.ports(); ports.close();
    const awaiting = f.backup.inspect({ purpose: 'held-approval', destinationId: 'local-recovery' }); await entry;
    assert.deepEqual(await awaiting, { ok: false, reason: 'denied' });
    assert.deepEqual(await f.backup.inspect({ purpose: 'second-approval', destinationId: 'local-recovery' }), { ok: false, reason: 'busy' });
    const before = structuredClone(engine.values.get('owner-a'));
    const closing = Promise.resolve(f.backup.close()).then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
    release(); await closing; assert.equal(settled, true); assert.deepEqual(engine.values.get('owner-a'), before);
  } finally { release(); f.data.close(); await f.backup.close(); }
});

test('registered-copy archives refuse altered content, stale state, final revoke, deletion and expiry', async () => {
  for (const fault of ['altered', 'foreign', 'stale', 'revoked', 'deleted', 'expired'] as const) {
    const f = setup();
    try {
      await seedRegisteredCopy(f); const saved = required(await f.backup.backup(copyRequest));
      if (fault === 'altered') {
        const outer = f.engine.values.get('owner-a') as { managed: { copies: { record: { values: { rss: number } } }[] } };
        outer.managed.copies[0]!.record.values.rss++;
        assert.equal((await f.backup.backup({ ...copyRequest, backupId: 'altered' })).ok, false); continue;
      }
      if (fault === 'foreign') (f.engine.values.get('owner-a') as { ownerId: string }).ownerId = 'owner-b';
      if (fault === 'stale') {
        const ports = await f.ports(); required(await createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] }).save(1, choice)); ports.close();
      }
      if (fault === 'deleted') {
        const deletion = required(await f.data.beginDeletion({ kinds: ['copies'], purpose: 'owner-copy-delete' }));
        required(await f.data.resumeDeletionReviewed(deletion.operationId));
      }
      if (fault === 'expired') f.time(6000);
      if (fault === 'revoked') { damageInner(f); let commits = 0; f.engine.before(() => { if (++commits === 2) f.authority.abort(); }); }
      const before = structuredClone(f.engine.values.get('owner-a'));
      assert.equal((await f.backup.restoreReviewed({ ...copyRequest, expectedSha256: saved.reference.sha256, retireOwned() {} })).ok, false);
      assert.deepEqual(f.engine.values.get('owner-a'), before);
    } finally { f.close(); }
  }
});

function damageInner(f: ReturnType<typeof setup>) {
  const outer = f.engine.values.get('owner-a') as { managed: { records: { settings?: string } } };
  outer.managed.records.settings = '{damaged-producer-settings';
}

test('reviewed recovery refuses healthy current producer data rather than resetting its authority epoch', async () => {
  const f = setup();
  try {
    const ports = await f.ports();
    required(await createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] }).save(0, choice));
    const captured = required(await f.backup.backup(request)), before = structuredClone(f.engine.values.get('owner-a'));
    assert.deepEqual(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned: f.retireOwned }),
      { ok: false, reason: 'review-required' });
    assert.deepEqual(f.engine.values.get('owner-a'), before); assert.equal(f.retired(), 0);
  } finally { f.close(); }
});

test('restoring real producer data advances authority epoch and fences the prior settings port', async () => {
  // The old SDK has no backup API. This explicit raw-copy baseline demonstrates why its
  // genuine producer envelopes alone cannot implement safe restore; it is not a B05 bug claim.
  if (process.env.B06_OLD_COPY_BASELINE === '1') {
    const engine = memory();
    const data = createOwnerDataController({ ownerId: 'owner-a', storage: engine.storage, trustedNow: () => 1000,
      authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
    try {
      const ports = required(await data.openStores({ retireOwned() {} }));
      const settings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
      assert.ok((await settings.save(0, choice)).ok);
      const copy = structuredClone(engine.values.get('owner-a'));
      await engine.storage.transact('owner-a', () => ({ state: copy, result: true }));
      assert.equal((await settings.save(1, choice)).ok, false, 'a pre-restore grant must not survive restore');
    } finally { data.close(); }
    return;
  }
  const f = setup();
  try {
    const ports = await f.ports(), settings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
    assert.ok((await settings.save(0, choice)).ok);
    const captured = required(await f.backup.backup(request));
    damageInner(f);
    const restored = required(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned: f.retireOwned }));
    assert.ok(restored.epoch > captured.epoch); assert.equal(f.retired(), 1);
    assert.equal((await settings.save(1, choice)).ok, false);
    assert.equal(ports.signal.aborted, true);
    const next = await f.ports(), read = await createSettingsStore({ ownerId: 'owner-a', storage: next.settings, availableDevices: () => [] }).load();
    assert.ok(read.ok); assert.equal(read.value.preferences.theme, 'dark');
  } finally { f.close(); }
});

test('backup/restore needs exact current owner consent and never creates a restored grant', async () => {
  const f = setup();
  try {
    await f.ports(); f.allow(false);
    assert.deepEqual(await f.backup.backup(request), { ok: false, reason: 'denied' });
    f.allow(true); const captured = required(await f.backup.backup(request)); f.allow(false);
    assert.deepEqual(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned() {} }), { ok: false, reason: 'denied' });
    f.allow(true); f.authority.abort();
    assert.equal((await f.backup.readBackup(request)).ok, false);
  } finally { f.close(); }
});

test('an older backup cannot overwrite newer data or the current deletion fence', async () => {
  const f = setup();
  try {
    const ports = await f.ports(), settings = createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] });
    assert.ok((await settings.save(0, choice)).ok); const captured = required(await f.backup.backup(request));
    assert.ok((await settings.save(1, { ...choice, preferences: { ...choice.preferences, theme: 'light' } })).ok);
    assert.equal((await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned() {} })).ok, false);
    required(await f.data.beginDeletion({ kinds: ['settings'], purpose: 'owner-delete' }));
    assert.equal((await f.backup.backup({ ...request, backupId: 'after-delete' })).ok, false);
  } finally { f.close(); }
});

test('damaged inner data recovers only with an intact outer fence and current verified bytes', async () => {
  const f = setup();
  try {
    const ports = await f.ports(); assert.ok((await createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] }).save(0, choice)).ok);
    const captured = required(await f.backup.backup(request));
    const raw = f.engine.values.get('owner-a') as { managed: { records: { settings: string } } };
    raw.managed.records.settings = '{damaged';
    required(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned() {} }));
    f.engine.values.delete('owner-a');
    assert.deepEqual(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned() {} }), { ok: false, reason: 'fence-missing' });
  } finally { f.close(); }
});

test('the actual telemetry producer retains source clock, quality and expiry without capture authority', async () => {
  const f = setup(); let history: ReturnType<typeof createTelemetryHistory> | undefined;
  try {
    const ports = await f.ports(); history = createTelemetryHistory({ ownerId: 'owner-a', storage: ports.telemetry, trustedNow: () => 1000,
      authorize: scope => ({ scope, expiresAt: scope.expiresAt }), limits: { retentionMs: 100 } });
    const capture = await history.requestCapture({ resourceId: 'example:measure', schemaVersion: 1, fields: ['value'], provenanceFields: [],
      destinationId: 'local-history', purpose: 'owner-recording', expiresAt: 50000, schema: { type: 'record', fields: { value: { type: 'scalar', unit: 'By', min: 0, max: 10000 } } } });
    assert.ok(capture.ok); assert.ok(history.enqueue(capture.handle, { sourceTime: { clockId: 'producer:clock', at: 17 }, quality: 'unverified', values: { value: 4321 } }).ok);
    assert.ok((await history.flush()).ok);
    const captured = required(await f.backup.backup(request)); assert.equal(captured.expiresAt, 1100);
    damageInner(f);
    required(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned() { history?.close(); } }));
    const next = await f.ports(), reader = createTelemetryHistory({ ownerId: 'owner-a', storage: next.telemetry, trustedNow: () => 1000, authorize: () => undefined });
    try { const page = await reader.exportPage(); assert.ok(page.ok); assert.deepEqual(page.records[0]?.sourceTime, { clockId: 'producer:clock', at: 17 });
      assert.equal(page.records[0]?.quality, 'unverified'); assert.equal(page.records[0]?.expiresAt, 1100); assert.equal(reader.status().captureHandles, 0); }
    finally { reader.close(); }
  } finally { history?.close(); f.close(); }
});

test('completed artifacts require reviewed exact pins while interrupted work never replays', async () => {
  const bytes = new TextEncoder().encode('actual retained bytes');
  const output = await createAssetReference('artifact:done', 'blob', bytes);
  const f = setup({ reviewedArtifacts: [{ applicationId: 'example:artifact', destinationId: 'owner-local', sha256: output.sha256 }] });
  let jobs;
  try {
    const ports = await f.ports(); jobs = createDurableArtifactJobStore({ ownerId: 'owner-a', storage: ports.artifacts, now: () => 1000,
      authorize: () => ({ expiresAt: 50000, isCurrent: () => true, signal: ports.signal }) });
    const input = await createAssetReference('artifact:input', 'text', bytes);
    const job = { idempotencyKey: 'done', applicationId: 'example:artifact', profileId: '101:local-artifact', profileRevision: 1, destinationId: 'owner-local', totalUnits: 1, input };
    required(await jobs.submit(job)); const active = required(await jobs.start('done', bytes)); required(await active.progress(1)); required(await active.commit(bytes));
    required(await jobs.submit({ ...job, idempotencyKey: 'unfinished' }));
    const captured = required(await f.backup.backup(request));
    damageInner(f);
    required(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned() { ports.close(); } }));
    const next = await f.ports(); const reader = createDurableArtifactJobStore({ ownerId: 'owner-a', storage: next.artifacts, now: () => 1000, authorize: () => undefined });
    try { const inspection = required(await reader.inspect()); assert.equal(inspection.jobs[0]?.evidence, 'artifact-stored');
      assert.equal(inspection.jobs[1]?.lastKnownState, 'interrupted'); assert.equal(inspection.jobs[1]?.requiresReview, true);
      assert.equal((await reader.start('unfinished', bytes)).ok, false); assert.equal((await reader.readOutput('done')).ok, false); }
    finally { await reader.close(); }
  } finally { await jobs?.close(); f.close(); }
});

test('corruption of otherwise valid outer audit counts cannot become historical evidence', async () => {
  const f = setup();
  try {
    const ports = await f.ports(); assert.ok((await createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] }).save(0, choice)).ok);
    const deletion = required(await f.data.beginDeletion({ kinds: ['settings'], purpose: 'owner-delete' }));
    required(await f.data.resumeDeletionReviewed(deletion.operationId));
    const captured = required(await f.backup.backup(request));
    const outer = f.engine.values.get('owner-a') as { audit: { removed: { settings: number } }[] };
    outer.audit[0]!.removed.settings++;
    const before = structuredClone(outer);
    assert.equal((await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned() {} })).ok, false);
    assert.deepEqual(f.engine.values.get('owner-a'), before, 'a corrupt recovery fence must remain intact for review');
  } finally { f.close(); }
});

test('damaged inner audit cannot replace the authoritative retained outer audit during backup or recovery', async () => {
  const f = setup();
  try {
    const ports = await f.ports(); required(await createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] }).save(0, choice));
    const deletion = required(await f.data.beginDeletion({ kinds: ['settings'], purpose: 'owner-delete' }));
    required(await f.data.resumeDeletionReviewed(deletion.operationId)); const captured = required(await f.backup.backup(request));
    const outer = f.engine.values.get('owner-a') as { audit: { removed: { settings: number } }[]; managed: { audit: { removed: { settings: number } }[] } };
    const evidence = structuredClone(outer.audit); outer.managed.audit[0]!.removed.settings++;
    assert.equal((await f.backup.backup({ ...request, backupId: 'corrupt-copy' })).ok, false);
    assert.deepEqual((f.engine.values.get('owner-a') as typeof outer).audit, evidence);
    required(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned: f.retireOwned }));
    const recovered = f.engine.values.get('owner-a') as typeof outer;
    assert.deepEqual(recovered.audit, evidence); assert.deepEqual(recovered.managed.audit, evidence);
  } finally { f.close(); }
});

test('foreign and future recovery documents and altered archive bytes are preserved without recovery', async () => {
  for (const fault of ['owner', 'version', 'bytes'] as const) {
    const f = setup();
    try {
      await f.ports(); const captured = required(await f.backup.backup(request)); damageInner(f);
      const state = f.engine.values.get('owner-a') as { ownerId: string; version: number; archives: { bytesBase64: string }[] };
      if (fault === 'owner') state.ownerId = 'owner-b';
      if (fault === 'version') state.version = 2;
      if (fault === 'bytes') { const row = state.archives[0]!; row.bytesBase64 = (row.bytesBase64[0] === 'A' ? 'B' : 'A') + row.bytesBase64.slice(1); }
      const before = structuredClone(state);
      assert.deepEqual(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned: f.retireOwned }),
        { ok: false, reason: fault === 'owner' ? 'wrong-owner' : fault === 'version' ? 'incompatible' : 'integrity' });
      assert.deepEqual(f.engine.values.get('owner-a'), before); assert.equal(f.retired(), 0);
    } finally { f.close(); }
  }
});

test('grant accessors and a throwing trusted clock cannot acquire or resume backup authority', async () => {
  let getterReads = 0;
  const accessor = setup({ authorize: scope => ({ scope, get expiresAt() { getterReads++; return scope.deadline; }, isCurrent: () => true }) });
  try { await accessor.ports(); assert.deepEqual(await accessor.backup.backup(request), { ok: false, reason: 'denied' }); assert.equal(getterReads, 0); }
  finally { accessor.close(); }
  let throws = false;
  const clock = setup({ trustedNow: () => { if (throws) throw Error('clock-fault'); return 1000; } });
  try {
    await clock.ports(); throws = true; assert.deepEqual(await clock.backup.backup(request), { ok: false, reason: 'invalid-clock' });
    throws = false; assert.deepEqual(await clock.backup.backup(request), { ok: false, reason: 'invalid-clock' });
  } finally { clock.close(); }
});

test('migration is explicit and validates the genuine prior managed producer envelope', async () => {
  const engine = memory();
  const prior = createOwnerDataController({ ownerId: 'owner-a', storage: engine.storage, trustedNow: () => 1000,
    authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
  const ports = required(await prior.openStores({ retireOwned() {} }));
  assert.ok((await createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] }).save(0, choice)).ok); prior.close();
  const f = setup({}, engine);
  try {
    f.allow(false); assert.equal((await f.backup.migrateReviewed({ purpose: 'owner-upgrade', destinationId: 'local-recovery' })).ok, false);
    assert.equal((engine.values.get('owner-a') as { profile: string }).profile, 'managed-owner-data/1');
    f.allow(true); required(await f.backup.migrateReviewed({ purpose: 'owner-upgrade', destinationId: 'local-recovery' }));
    assert.equal((engine.values.get('owner-a') as { profile: string }).profile, 'managed-owner-backup/1');
    const current = await f.ports(), loaded = await createSettingsStore({ ownerId: 'owner-a', storage: current.settings, availableDevices: () => [] }).load();
    assert.ok(loaded.ok); assert.equal(loaded.value.preferences.theme, 'dark');
  } finally { f.close(); }
});

test('reentrant close and a grant abort at the commit boundary preserve the previous owner document', async () => {
  const f = setup();
  try {
    await f.ports(); const captured = required(await f.backup.backup(request)); damageInner(f); const before = structuredClone(f.engine.values.get('owner-a'));
    assert.deepEqual(await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned() { f.backup.close(); } }), { ok: false, reason: 'closed' });
    assert.deepEqual(f.engine.values.get('owner-a'), before);
  } finally { f.close(); }
  const late = setup();
  try {
    await late.ports(); const captured = required(await late.backup.backup(request)); damageInner(late); const before = structuredClone(late.engine.values.get('owner-a'));
    late.engine.before(() => { late.authority.abort(); });
    assert.equal((await late.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned() {} })).ok, false);
    assert.deepEqual(late.engine.values.get('owner-a'), before);
  } finally { late.close(); }
});

test('two finite archives, immutable duplicate identity and expiry do not extend source retention', async () => {
  const f = setup();
  try {
    await f.ports(); const first = required(await f.backup.backup(request));
    f.time(1001); assert.deepEqual(required(await f.backup.backup(request)), first);
    required(await f.backup.backup({ ...request, backupId: 'snapshot-b' }));
    assert.deepEqual(await f.backup.backup({ ...request, backupId: 'snapshot-c' }), { ok: false, reason: 'capacity' });
    f.time(1001 + 7 * 86400000); assert.equal((await f.backup.readBackup(request)).ok, false);
    assert.equal(required(await f.backup.sweep({ purpose: 'owner-expiry', destinationId: 'local-recovery' })).removed, 2);
    assert.equal(required(await f.backup.inspect({ purpose: 'owner-inspect', destinationId: 'local-recovery' })).archives.length, 0);
  } finally { f.close(); }
});

for (const action of ['read', 'duplicate', 'restore'] as const) {
  test(`archive expiry during real producer validation denies ${action}`, async () => {
    let armed = false;
    const f = setup({ availableDevices() { if (armed) f.time(1100); return []; } });
    let history: ReturnType<typeof createTelemetryHistory> | undefined;
    try {
      const ports = await f.ports();
      required(await createSettingsStore({ ownerId: 'owner-a', storage: ports.settings, availableDevices: () => [] }).save(0, choice));
      history = createTelemetryHistory({ ownerId: 'owner-a', storage: ports.telemetry, trustedNow: () => 1000,
        authorize: scope => ({ scope, expiresAt: scope.expiresAt }), limits: { retentionMs: 100 } });
      const capture = await history.requestCapture({ resourceId: 'example:expiry', schemaVersion: 1, fields: ['value'], provenanceFields: [],
        destinationId: 'local-history', purpose: 'owner-recording', expiresAt: 50000,
        schema: { type: 'record', fields: { value: { type: 'scalar', unit: 'By', min: 0, max: 10000 } } } });
      assert.ok(capture.ok); assert.ok(history.enqueue(capture.handle, { sourceTime: { clockId: 'producer:clock', at: 17 }, quality: 'observed', values: { value: 4321 } }).ok);
      assert.ok((await history.flush()).ok); const captured = required(await f.backup.backup(request)); assert.equal(captured.expiresAt, 1100);
      if (action === 'restore') damageInner(f);
      const before = structuredClone(f.engine.values.get('owner-a')); armed = true;
      const result = action === 'read' ? await f.backup.readBackup(request) : action === 'duplicate' ? await f.backup.backup(request) :
        await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned: f.retireOwned });
      assert.deepEqual(result, { ok: false, reason: 'expired' });
      assert.deepEqual(f.engine.values.get('owner-a'), before); assert.equal(f.retired(), 0);
    } finally { history?.close(); f.close(); }
  });
}

for (const boundary of ['retire-owned', 'storage-commit'] as const) {
  test(`archive deadline remains current through restore ${boundary}`, async () => {
    const f = setup(); let history: ReturnType<typeof createTelemetryHistory> | undefined;
    try {
      const ports = await f.ports();
      history = createTelemetryHistory({ ownerId: 'owner-a', storage: ports.telemetry, trustedNow: () => 1000,
        authorize: scope => ({ scope, expiresAt: scope.expiresAt }), limits: { retentionMs: 100 } });
      const capture = await history.requestCapture({ resourceId: 'example:expiry', schemaVersion: 1, fields: ['value'], provenanceFields: [],
        destinationId: 'local-history', purpose: 'owner-recording', expiresAt: 50000,
        schema: { type: 'record', fields: { value: { type: 'boolean' } } } });
      assert.ok(capture.ok); assert.ok(history.enqueue(capture.handle, { sourceTime: { clockId: 'producer:clock', at: 17 }, quality: 'observed', values: { value: true } }).ok);
      assert.ok((await history.flush()).ok); const captured = required(await f.backup.backup(request));
      damageInner(f); const before = structuredClone(f.engine.values.get('owner-a'));
      const retireOwned = () => { f.retireOwned(); if (boundary === 'retire-owned') f.time(1100); else f.engine.before(() => f.time(1100)); };
      const result = await f.backup.restoreReviewed({ ...request, expectedSha256: captured.reference.sha256, retireOwned });
      assert.deepEqual(result, { ok: false, reason: 'expired' }); assert.deepEqual(f.engine.values.get('owner-a'), before);
    } finally { f.engine.before(); history?.close(); f.close(); }
  });
}
