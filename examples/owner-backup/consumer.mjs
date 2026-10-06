import { createOwnerBackupController, createOwnerDataController, createSettingsStore, createTelemetryHistory,
  createDurableArtifactJobStore, createAssetReference, verifyAssetContent } from '@101/connect';

export const OWNER_BACKUP_EXAMPLE_OWNER = 'owner-backup-example';
export const OWNER_BACKUP_EXAMPLE_REQUEST = Object.freeze({ backupId: 'current-snapshot', purpose: 'owner-local-recovery', destinationId: 'local-recovery' });
const input = new TextEncoder().encode('owned local artifact bytes\n');
const output = new TextEncoder().encode('OWNED LOCAL ARTIFACT BYTES\n');
const app = 'example:backup-artifact', destination = 'owner-local-artifacts';
const need = value => { if (!value.ok) throw Error('owner-backup-example:' + value.reason); return value.value; };
const expect = (value, message) => { if (!value) throw Error('owner-backup-example:' + message); };

/** Explicit current-owner first caller. Importing this module neither records nor restores anything. */
export async function runOwnerBackupExample(storage, phase = 'seed', options = {}) {
  const owner = options.ownerId ?? OWNER_BACKUP_EXAMPLE_OWNER, now = options.now ?? 1000;
  let approved = true, history, jobs, ports, retained = false;
  const authority = new AbortController(), outputReference = await createAssetReference('artifact:completed', 'blob', output);
  const backup = createOwnerBackupController({ ownerId: owner, storage, trustedNow: () => now,
    availableDevices: () => ['example-device'], reviewedArtifacts: [{ applicationId: app, destinationId: destination, sha256: outputReference.sha256 }],
    authorize: scope => approved && scope.ownerId === owner && scope.destinationId === 'local-recovery'
      ? { scope, expiresAt: scope.deadline, isCurrent: () => approved, signal: authority.signal } : undefined });
  const data = createOwnerDataController({ ownerId: owner, storage: phase === 'legacy-seed' ? storage : backup.managedStorage,
    trustedNow: () => now, availableDevices: () => ['example-device'], artifactRetentionMs: 5000,
    authorize: scope => approved && scope.ownerId === owner ? { scope, expiresAt: scope.deadline, isCurrent: () => approved, signal: authority.signal } : undefined });
  try {
    if (phase === 'seed' || phase === 'seed-crash' || phase === 'legacy-seed') {
      ports = need(await data.openStores({ retireOwned() { history?.close(); } }));
      const settings = createSettingsStore({ ownerId: owner, storage: ports.settings, availableDevices: () => ['example-device'] });
      expect((await settings.save(0, { preferences: { theme: 'dark', handedness: 'left', motion: 'reduce' }, profiles: [
        { id: 'chosen-layout', deviceId: 'example-device', profileId: 'example:layout', profileRevision: 1, calibration: { scale: 1, offset: 0 } },
      ] })).ok, 'actual-settings-producer');
      const node = typeof process !== 'undefined' && typeof process.memoryUsage === 'function';
      const measured = node ? process.memoryUsage().rss : innerWidth;
      expect(Number.isFinite(measured) && measured > 0, 'actual-local-measurement');
      history = createTelemetryHistory({ ownerId: owner, storage: ports.telemetry, trustedNow: () => now,
        authorize: scope => approved ? { scope, expiresAt: scope.expiresAt } : undefined, limits: { retentionMs: 5000 } });
      const capture = await history.requestCapture({ resourceId: 'example:owned-measurement', schemaVersion: 1, fields: ['measured'], provenanceFields: [],
        destinationId: 'local-history', purpose: 'owner-local-diagnostics', expiresAt: now + 50000,
        schema: { type: 'record', fields: { measured: { type: 'scalar', unit: node ? 'By' : 'px', min: 0, max: Number.MAX_SAFE_INTEGER } } } });
      expect(capture.ok, 'separate-recording-approval');
      expect(history.enqueue(capture.handle, { sourceTime: { clockId: 'example:source-clock', at: performance.now() }, quality: 'observed', values: { measured } }).ok, 'actual-enqueue');
      expect((await history.flush()).ok, 'actual-history-commit');
      jobs = createDurableArtifactJobStore({ ownerId: owner, storage: ports.artifacts, now: () => now,
        authorize: scope => approved && scope.ownerId === owner ? { expiresAt: now + 50000, isCurrent: () => approved, signal: ports.signal } : undefined });
      const reference = await createAssetReference('artifact:source', 'text', input);
      const request = { idempotencyKey: 'completed', applicationId: app, profileId: '101:local-artifact', profileRevision: 1,
        destinationId: destination, totalUnits: 2, input: reference };
      need(await jobs.submit(request)); const attempt = need(await jobs.start('completed', input));
      const chunks = [];
      for (let unit = 1; unit <= 2; unit++) {
        await new Promise(resolve => setTimeout(resolve, 0)); expect(!attempt.signal.aborted, 'current-generation');
        chunks.push(new TextDecoder().decode(input.subarray(Math.floor((unit - 1) * input.length / 2), Math.floor(unit * input.length / 2))).toUpperCase());
        need(await attempt.progress(unit));
      }
      need(await attempt.commit(new TextEncoder().encode(chunks.join(''))));
      const completed = need(await jobs.readOutput('completed')); expect(await verifyAssetContent(completed.reference, completed.bytes), 'actual-output-reference');
      need(await jobs.submit({ ...request, idempotencyKey: 'interrupted' }));
      if (phase === 'seed-crash') { const pending = need(await jobs.start('interrupted', input)); need(await pending.progress(1)); }
      else await jobs.close();
      if (phase === 'legacy-seed') return { phase, producer: 'managed-owner-data/1', measured };
      approved = false; expect(!(await backup.backup(OWNER_BACKUP_EXAMPLE_REQUEST)).ok, 'denied-backup-inert'); approved = true;
      const captured = need(await backup.backup(OWNER_BACKUP_EXAMPLE_REQUEST));
      const bytes = need(await backup.readBackup(OWNER_BACKUP_EXAMPLE_REQUEST));
      expect(await verifyAssetContent(bytes.receipt.reference, bytes.bytes), 'actual-backup-sha256');
      const payload = JSON.parse(new TextDecoder().decode(bytes.bytes));
      expect(Object.keys(payload).sort().join(',') === 'createdAt,expiresAt,managed,ownerId,profile,version', 'closed-backup-envelope');
      expect(Object.keys(payload.managed.records).sort().join(',') === 'artifacts,settings,telemetry', 'fixed-producer-namespaces');
      expect(payload.managed.copies.length === 0 && !Object.hasOwn(payload.managed, 'grants') && !Object.hasOwn(payload.managed, 'identity'), 'no-authority-or-recipient-copy');
      if (phase === 'seed-crash') {
        // The disposable QA child/context exits immediately after the acknowledged backup.
        // This deliberate process loss must not turn an in-progress API attempt into completion.
        globalThis.ownerBackupInterruptedFixture = { storage, backup, data, ports, history, jobs }; retained = true;
      }
      return { phase, profile: 'managed-owner-backup/1', captured, measured, outputSha256: completed.reference.sha256,
        sourceTime: payload.managed.records.telemetry.rows[0].sourceTime, quality: payload.managed.records.telemetry.rows[0].quality };
    }
    if (phase === 'migrate') {
      const migrated = need(await backup.migrateReviewed({ purpose: 'owner-reviewed-upgrade', destinationId: 'local-recovery' }));
      const captured = need(await backup.backup(OWNER_BACKUP_EXAMPLE_REQUEST)); return { phase, migrated, captured };
    }
    if (phase === 'inspect') {
      approved = false; expect(!(await backup.readBackup(OWNER_BACKUP_EXAMPLE_REQUEST)).ok, 'restart-no-restored-backup-authority');
      expect(!(await data.openStores({ retireOwned() {} })).ok, 'restart-no-restored-owner-port'); approved = true;
      const inspection = need(await backup.inspect({ purpose: 'owner-reviewed-inspection', destinationId: 'local-recovery' }));
      const bytes = need(await backup.readBackup(OWNER_BACKUP_EXAMPLE_REQUEST));
      expect(await verifyAssetContent(bytes.receipt.reference, bytes.bytes), 'reopened-actual-backup-sha');
      return { phase, inspection, reference: bytes.receipt.reference, restoredAuthority: false, automaticWork: 0 };
    }
    if (phase === 'restore' || phase === 'restore-attempt') {
      const inspection = need(await backup.inspect({ purpose: 'owner-reviewed-inspection', destinationId: 'local-recovery' }));
      const selected = inspection.archives.find(row => row.backupId === OWNER_BACKUP_EXAMPLE_REQUEST.backupId);
      expect(selected, 'current-reviewed-archive');
      if (phase === 'restore') { approved = false;
        expect(!(await backup.restoreReviewed({ ...OWNER_BACKUP_EXAMPLE_REQUEST, expectedSha256: selected.reference.sha256, retireOwned() {} })).ok, 'new-restore-consent-required'); approved = true; }
      const restored = await backup.restoreReviewed({ ...OWNER_BACKUP_EXAMPLE_REQUEST, expectedSha256: selected.reference.sha256, retireOwned() { ports?.close(); history?.close(); } });
      if (phase === 'restore-attempt') return restored;
      const result = need(restored); expect(result.epoch > selected.epoch, 'new-durable-owner-epoch'); return { phase, restored: result };
    }
    if (phase === 'reopen-restored') {
      approved = false; expect(!(await data.openStores({ retireOwned() {} })).ok, 'new-current-owner-port-required'); approved = true;
      ports = need(await data.openStores({ retireOwned() { history?.close(); } }));
      const settings = await createSettingsStore({ ownerId: owner, storage: ports.settings, availableDevices: () => ['example-device'] }).load();
      expect(settings.ok && settings.value.preferences.theme === 'dark', 'restored-settings');
      history = createTelemetryHistory({ ownerId: owner, storage: ports.telemetry, trustedNow: () => now, authorize: () => undefined });
      const rows = await history.exportPage(); expect(rows.ok && rows.records.length === 1, 'restored-history');
      expect(rows.records[0].quality === 'observed' && rows.records[0].expiresAt === 6000, 'original-quality-and-retention');
      expect(history.status().captureHandles === 0 && history.status().uploadHandles === 0, 'no-restored-history-authority');
      let outputAllowed = false;
      jobs = createDurableArtifactJobStore({ ownerId: owner, storage: ports.artifacts, now: () => now,
        authorize: scope => outputAllowed && scope.action === 'read-output' ? { expiresAt: now + 50000, isCurrent: () => outputAllowed, signal: ports.signal } : undefined });
      const records = need(await jobs.inspect());
      expect(records.jobs.find(row => row.request.idempotencyKey === 'interrupted')?.lastKnownState === 'interrupted', 'accurate-interrupted-history');
      expect(records.jobs.find(row => row.request.idempotencyKey === 'interrupted')?.requiresReview, 'owner-review-required');
      expect(!(await jobs.start('interrupted', input)).ok && !(await jobs.readOutput('completed')).ok, 'no-restored-job-grant');
      outputAllowed = true; const bytes = need(await jobs.readOutput('completed'));
      expect(await verifyAssetContent(bytes.reference, bytes.bytes) && bytes.reference.sha256 === outputReference.sha256, 'exact-completed-bytes-after-recovery');
      return { phase, restoredAuthority: false, automaticWork: 0, sourceTime: rows.records[0].sourceTime,
        quality: rows.records[0].quality, measured: rows.records[0].values.measured, outputSha256: bytes.reference.sha256,
        evidence: 'verified-local-artifact', physicalEffect: 'unverified' };
    }
    if (phase === 'expiry') {
      const swept = need(await backup.sweep({ purpose: 'owner-expiry', destinationId: 'local-recovery' }));
      const inspected = need(await backup.inspect({ purpose: 'owner-reviewed-inspection', destinationId: 'local-recovery' }));
      expect(inspected.archives.length === 0, 'expired-archive-bytes-removed'); return { phase, removed: swept.removed };
    }
    throw Error('owner-backup-example:unknown-phase');
  } finally {
    if (!retained) { history?.close(); await jobs?.close(); ports?.close(); data.close(); await backup.close(); }
  }
}

/** Genuine old producer baseline: a raw copy preserves the old epoch and therefore the old settings port. */
export async function runOwnerBackupRawCopyBaseline(storage) {
  const owner = OWNER_BACKUP_EXAMPLE_OWNER;
  const data = createOwnerDataController({ ownerId: owner, storage, trustedNow: () => 1000,
    authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
  try {
    const ports = need(await data.openStores({ retireOwned() {} }));
    const settings = createSettingsStore({ ownerId: owner, storage: ports.settings, availableDevices: () => [] });
    const choices = { preferences: { theme: 'dark', handedness: 'left', motion: 'reduce' }, profiles: [] };
    expect((await settings.save(0, choices)).ok, 'baseline-actual-producer');
    const snapshot = await storage.transact(owner, state => ({ state, result: structuredClone(state) }));
    await storage.transact(owner, () => ({ state: snapshot, result: undefined }));
    return { accepted: (await settings.save(1, choices)).ok };
  } finally { data.close(); }
}
