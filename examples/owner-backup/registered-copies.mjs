import { createOwnerBackupController, createOwnerDataController, createSettingsStore,
  createTelemetryHistory, verifyAssetContent } from '@101/connect';

const ownerId = 'registered-copy-recovery-owner';
const plain = Object.freeze({ backupId: 'registered-current', purpose: 'owner-copy-recovery', destinationId: 'local-recovery' });
const selected = Object.freeze({ ...plain, registeredCopies: 'include' });
const preferences = { preferences: { theme: 'dark', handedness: 'left', motion: 'reduce' }, profiles: [] };
// A clock origin belongs to this actual Node-process lifetime, never another process.
const sourceClockId = `owned-node-process:${process.pid}:${crypto.randomUUID()}`;
const need = value => { if (!value.ok) throw new Error('copy-recovery:' + value.reason); return value.value; };
const expect = (value, name) => { if (!value) throw new Error('copy-recovery:' + name); };

/** Ordinary public SDK caller. The host supplies a disposable owned storage port.
 * Samples are genuine current Node-process RSS, not a sensor or other process.
 * Controlled trusted ingestion time qualifies expiry boundaries, not wall-clock
 * autonomous deletion. Storage corruption below is an explicit recovery fixture.
 */
export async function runRegisteredCopyRecovery(storage, phase = 'recover', scenario = 'positive') {
  expect(['seed', 'recover', 'negative'].includes(phase), 'phase');
  expect(['positive', 'altered', 'foreign', 'stale', 'revoked', 'deleted', 'expired'].includes(scenario), 'scenario');
  expect(typeof process !== 'undefined' && typeof process.memoryUsage === 'function', 'native-node-producer-required');
  let time = 1000, allowed = true, copyAllowed = false, history, ports, retired = 0;
  let revokeAtRestore = false, commitRevocations = 0;
  const authority = new AbortController(), decisions = [];
  // A cooperative mutation hook runs inside the supplied genuine native transaction.
  // It is labeled as a scheduling fixture, never a substitute storage engine.
  const guardedStorage = { transact(owner, mutation, guard) {
    return storage.transact(owner, current => { const next = mutation(current);
      if (revokeAtRestore && next.state.epoch > current.epoch) { commitRevocations++; authority.abort(); }
      return next;
    }, guard);
  } };
  const backup = createOwnerBackupController({ ownerId, storage: guardedStorage, trustedNow: () => time, availableDevices: () => [],
    authorize(scope) {
      if (!allowed || scope.ownerId !== ownerId || scope.destinationId !== 'local-recovery') return undefined;
      if (scope.registeredCopies && (!copyAllowed || scope.registeredCopies.selection !== 'all-registered-local' ||
        scope.registeredCopies.count !== 1 || !/^[0-9a-f]{64}$/.test(scope.registeredCopies.sha256))) return undefined;
      decisions.push({ action: scope.action, stateSha256: scope.stateSha256, backupSha256: scope.backupSha256,
        registeredCopies: scope.registeredCopies });
      return { scope, expiresAt: scope.deadline, isCurrent: () => allowed, signal: authority.signal };
    } });
  const data = createOwnerDataController({ ownerId, storage: backup.managedStorage, trustedNow: () => time,
    authorize: scope => allowed && scope.ownerId === ownerId
      ? { scope, expiresAt: scope.deadline, isCurrent: () => allowed, signal: authority.signal } : undefined });
  const exportCopies = () => data.exportPage({ kind: 'copies', purpose: 'owner-copy-review', destinationId: 'owner-download' });
  try {
    if (phase === 'seed' || phase === 'negative') {
      ports = need(await data.openStores({ retireOwned() { history?.close(); } }));
      need(await createSettingsStore({ ownerId, storage: ports.settings, availableDevices: () => [] }).save(0, preferences));
      history = createTelemetryHistory({ ownerId, storage: ports.telemetry, trustedNow: () => time, limits: { retentionMs: 5000 },
        authorize: scope => ({ scope, expiresAt: scope.expiresAt }) });
      const rss = process.memoryUsage().rss, sourceTime = { clockId: sourceClockId, at: performance.now() };
      const capture = await history.requestCapture({ resourceId: 'owned-node:rss', schemaVersion: 1, fields: ['rss'], provenanceFields: [],
        destinationId: 'local-history', purpose: 'owner-rss-diagnostics', expiresAt: 51000,
        schema: { type: 'record', fields: { rss: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER } } } });
      expect(capture.ok, 'independent-capture-consent');
      expect(history.enqueue(capture.handle, { sourceTime, quality: 'observed', values: { rss } }).ok, 'genuine-source-enqueue');
      expect((await history.flush()).ok, 'genuine-source-commit');
      const upload = await history.requestUpload({ resourceId: 'owned-node:rss', schemaVersion: 1, fields: ['rss'], provenanceFields: [],
        destinationId: 'local-recipient', purpose: 'owner-local-recipient', expiresAt: 51000 }, async (batch, context) => {
        expect(!context.signal.aborted, 'current-upload');
        const copied = need(await data.storeLocalTelemetryCopy(batch, { purpose: 'owner-local-recipient', destinationId: 'local-recipient' }));
        expect(copied.copied === 1, 'actual-registered-copy');
        return { batchId: batch.batchId, recordIds: batch.records.map(record => record.id) };
      });
      expect(upload.ok && (await history.pumpUpload(upload.handle)).ok, 'independent-upload-consent');
      history.close(); ports.close(); history = undefined; ports = undefined;
      expect((await backup.backup(plain)).reason === 'unsupported', 'no-implicit-copy-inclusion');
      expect((await backup.backup(selected)).reason === 'denied', 'new-copy-backup-consent-required'); copyAllowed = true;
      const saved = need(await backup.backup(selected)); expect(saved.expiresAt === 6000, 'original-copy-retention');
      const bytes = need(await backup.readBackup(selected)); expect(await verifyAssetContent(bytes.receipt.reference, bytes.bytes), 'native-archive-integrity');
      const payload = JSON.parse(new TextDecoder().decode(bytes.bytes)), copy = payload.managed.copies[0];
      expect(payload.version === 1 && payload.managed.copies.length === 1 && copy.record.values.rss === rss &&
        copy.record.sourceTime.at === sourceTime.at && copy.record.sourceTime.clockId === sourceTime.clockId &&
        copy.record.quality === 'observed' && copy.record.expiresAt === 6000, 'producer-meaning-preserved');
      if (phase === 'seed') return { result: 'pass', phase, producer: 'actual-owned-node-process-rss', rss, sourceTime, saved,
        record: copy.record, sourceClockId, physical: false, decisions };
      if (scenario === 'altered') {
        await storage.transact(ownerId, state => { state.managed.copies[0].record.values.rss++; return { state, result: true }; });
        expect(!(await backup.backup({ ...selected, backupId: 'altered' })).ok, 'altered-copy-not-archived');
        return { result: 'pass', phase, scenario, refused: true, sourceClockId, physical: false };
      }
      if (scenario === 'foreign') await storage.transact(ownerId, state => { state.ownerId = 'foreign-owner'; return { state, result: true }; });
      if (scenario === 'stale') {
        ports = need(await data.openStores({ retireOwned() {} }));
        need(await createSettingsStore({ ownerId, storage: ports.settings, availableDevices: () => [] }).save(1, preferences)); ports.close(); ports = undefined;
      }
      if (scenario === 'deleted') {
        const deleting = need(await data.beginDeletion({ kinds: ['copies'], purpose: 'owner-copy-delete' }));
        need(await data.resumeDeletionReviewed(deleting.operationId));
        expect(need(await exportCopies()).records.length === 0, 'actual-copy-deletion');
      }
      if (scenario === 'expired') time = 6000;
      if (scenario === 'revoked') {
        await storage.transact(ownerId, state => { state.managed.records.settings = '{owned-damaged-inner-fixture'; return { state, result: true }; });
        revokeAtRestore = true;
      }
      const before = await storage.transact(ownerId, state => ({ state, result: JSON.stringify(state) }));
      const refusal = await backup.restoreReviewed({ ...selected, expectedSha256: saved.reference.sha256, retireOwned() { retired++; } });
      const after = await storage.transact(ownerId, state => ({ state, result: JSON.stringify(state) }));
      expect(!refusal.ok && before === after && (scenario === 'revoked' ? commitRevocations === 1 : retired === 0), 'negative-recovery-retains-state');
      return { result: 'pass', phase, scenario, refusal, commitRevocations, retired, sourceClockId, physical: false };
    }
    // This path is a genuinely fresh process and requires fresh owner and copy decisions.
    allowed = false; expect(!(await backup.readBackup(selected)).ok, 'restart-restores-no-approval'); allowed = true;
    copyAllowed = true; const retained = need(await backup.readBackup(selected));
    const payload = JSON.parse(new TextDecoder().decode(retained.bytes));
    expect(await verifyAssetContent(retained.receipt.reference, retained.bytes), 'fresh-process-content-verification');
    await storage.transact(ownerId, state => { state.managed.records.settings = '{owned-damaged-inner-fixture'; return { state, result: true }; });
    expect((await backup.restoreReviewed({ ...plain, expectedSha256: retained.receipt.reference.sha256, retireOwned() {} })).reason === 'unsupported',
      'recovery-does-not-inherit-copy-selection');
    copyAllowed = false;
    expect((await backup.restoreReviewed({ ...selected, expectedSha256: retained.receipt.reference.sha256, retireOwned() {} })).reason === 'denied',
      'new-copy-recovery-approval-required'); copyAllowed = true;
    const restored = need(await backup.restoreReviewed({ ...selected, expectedSha256: retained.receipt.reference.sha256, retireOwned() { retired++; } }));
    const copies = need(await exportCopies());
    expect(retired === 1 && restored.epoch > retained.receipt.epoch && JSON.stringify(copies.records) === JSON.stringify(payload.managed.copies.map(copy => copy.record)),
      'native-restored-original-registered-copy');
    ports = need(await data.openStores({ retireOwned() { history?.close(); } }));
    history = createTelemetryHistory({ ownerId, storage: ports.telemetry, trustedNow: () => time, authorize: () => undefined });
    expect(history.status().captureHandles === 0 && history.status().uploadHandles === 0, 'no-restored-capture-upload-authority');
    time = 6000; const swept = need(await data.sweep()), empty = need(await exportCopies());
    expect(swept.copiesRemoved === 1 && empty.records.length === 0, 'actual-native-original-copy-expiry');
    const raw = await storage.transact(ownerId, state => ({ state, result: state }));
    expect(raw.managed.audit.some(row => row.action === 'expiry' && row.removed.copies === 1), 'required-redacted-audit');
    return { result: 'pass', phase, producer: 'retained-actual-owned-node-process-rss', record: copies.records[0], restored,
      sourceTime: copies.records[0].sourceTime, decisions, expiry: swept, restoredAuthority: false, physical: false };
  } finally { history?.close(); ports?.close(); data.close(); await backup.close(); }
}
