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
