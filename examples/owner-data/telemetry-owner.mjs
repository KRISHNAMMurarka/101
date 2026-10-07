import { createHash, randomUUID } from 'node:crypto';
import { createOwnerDataController, createTelemetryHistory, createSettingsStore,
  OWNER_DATA_PROFILE } from '@101/connect';

export const TELEMETRY_OWNER_SELECTION_PROFILE = 'selected-managed-telemetry/1';
const owner = 'telemetry-owner-example', otherOwner = 'telemetry-other-owner';
const selected = 'owned-node:rss', retained = 'owned-node:heap-used';
const privateAuthorizationSentinel = 'selected-owner-authorizer-private-sentinel';
const select = Object.freeze({ kinds: Object.freeze(['telemetry']), purpose: 'owner-selected-resource-removal', telemetryResourceId: selected });
const exportResource = resourceId => ({ kind: 'telemetry', resourceId, purpose: 'owner-resource-portability', destinationId: 'owner-download' });
const exportCopies = { kind: 'copies', purpose: 'owner-copy-inspection', destinationId: 'owner-download' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function expect(condition, message) { if (!condition) throw new Error('telemetry-owner-example:' + message); }
function required(result) { expect(result.ok, result.reason ?? 'unexpected-result'); return result.value; }

/**
 * Inert import. The host explicitly supplies its owned storage; every phase
 * creates fresh owner decisions. Native process RSS/heap are diagnostics of
 * this authored process, not sensor/hardware evidence. No route/upload/capture
 * authority is restored from persistent records or a deletion plan.
 */
export async function runTelemetryOwnerSelection(storage, phase) {
  const phases = ['seed', 'inspect', 'begin', 'stage', 'complete', 'inspect-completed', 'expiry', 'audit-expiry'];
  expect(phases.includes(phase), 'unreviewed-phase');
  const time = phase === 'expiry' ? 6000 : phase === 'audit-expiry' ? 6000 + 30 * 86400000 : 1000;
  let approved = true, retired = 0, producer;
  const authority = new AbortController(), scopes = [];
  const authorize = scope => {
    // The sentinel stands for a credential held only by this closure. It is
    // neither an export field nor part of persisted owner/copy/audit data.
    expect(privateAuthorizationSentinel.length > 0, 'private-authorizer');
    scopes.push(scope);
    return approved ? { scope, expiresAt: scope.deadline, isCurrent: () => approved, signal: authority.signal } : undefined;
  };
  const controller = createOwnerDataController({ ownerId: owner, storage, trustedNow: () => time, availableDevices: () => [], authorize });
  const other = createOwnerDataController({ ownerId: otherOwner, storage, trustedNow: () => time, availableDevices: () => [],
    authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal }) });
  const read = ownerId => storage.transact(ownerId, state => ({ state, result: structuredClone(state) }));
  const makeHistory = ports => createTelemetryHistory({ ownerId: owner, storage: ports.telemetry, trustedNow: () => time,
    authorize: scope => approved ? { scope, expiresAt: scope.expiresAt } : undefined, limits: { retentionMs: 5000 } });
  async function proof() {
    const state = await read(owner), foreign = await read(otherOwner);
    expect(state.profile === OWNER_DATA_PROFILE, 'actual-managed-envelope');
    const serialized = JSON.stringify({ state, foreign });
    expect(!serialized.includes(privateAuthorizationSentinel), 'authorizer-not-persisted');
    const row = state.records.telemetry?.rows.find(value => value.resourceId === retained);
    const copy = state.copies.find(value => value.record.resourceId === retained);
    expect(state.audit.every(event => Object.keys(event).sort().join(',') === 'action,at,expiresAt,kinds,operationId,removed,state' &&
      event.expiresAt === event.at + 30 * 86400000), 'closed-original-audit');
    expect(!JSON.stringify(state.audit).includes(selected) && !JSON.stringify(state.audit).includes('residentBytes'), 'redacted-audit');
    return { retainedProducerSha256: row ? digest(row) : null, retainedCopySha256: copy ? digest(copy) : null,
      settingsSha256: digest(state.records.settings), otherOwnerSha256: digest(foreign),
      telemetryRows: state.records.telemetry?.rows.length ?? 0, copies: state.copies.length, auditRows: state.audit.length,
      selectedPersistedRows: state.records.telemetry?.rows.filter(value => value.resourceId === selected).length ?? 0,
      pendingSelector: state.deletion?.telemetryResourceId ?? null,
      originalExpiry: row?.expiresAt ?? null, closedSecretFreeAudit: true, authorizerNotPersisted: true };
  }
  try {
    if (phase === 'seed') {
      const ports = required(await controller.openStores({ retireOwned() { retired++; producer?.close(); } }));
      producer = makeHistory(ports);
      expect(producer.status().captureHandles === 0 && producer.status().uploadHandles === 0 && producer.status().pending === 0, 'default-no-authority');
      const measured = process.memoryUsage(), sourceTime = Object.freeze({ clockId: `owned-node:${process.pid}:${randomUUID()}`, at: performance.now() });
      expect(Number.isSafeInteger(measured.rss) && measured.rss > 0 && Number.isSafeInteger(measured.heapUsed) && measured.heapUsed > 0, 'actual-process-measurements');
      for (const [resourceId, field, value] of [[selected, 'residentBytes', measured.rss], [retained, 'heapUsedBytes', measured.heapUsed]]) {
        const capture = await producer.requestCapture({ resourceId, schemaVersion: 1, fields: [field], provenanceFields: [],
          destinationId: 'local-history', purpose: 'owner-process-diagnostics', expiresAt: 51000,
          schema: { type: 'record', fields: { [field]: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER } } } });
        expect(capture.ok, 'explicit-current-capture');
        expect(producer.enqueue(capture.handle, { sourceTime, quality: 'observed', values: { [field]: value } }).ok, 'actual-process-enqueue');
      }
      const flushed = await producer.flush(); expect(flushed.ok && flushed.committed === 2, 'actual-producer-commit');
      const pages = [];
      for (const [resourceId, field, batchId] of [[selected, 'residentBytes', 'selected-rss-copy'], [retained, 'heapUsedBytes', 'retained-heap-copy']]) {
        const page = required(await controller.exportPage({ ...exportResource(resourceId), fields: [field] }));
        expect(page.records.length === 1 && page.records[0].expiresAt === 6000 && page.records[0].ingestedAt === 1000 &&
          page.records[0].quality === 'observed' && JSON.stringify(page.records[0].sourceTime) === JSON.stringify(sourceTime), 'original-producer-meaning');
        expect(required(await controller.storeLocalTelemetryCopy({ batchId, records: page.records },
          { purpose: 'owner-reviewed-local-recipient', destinationId: 'local-recipient' })).copied === 1, 'registered-copy');
        pages.push(page);
      }
      expect((await createSettingsStore({ ownerId: owner, storage: ports.settings, availableDevices: () => [] }).save(0,
        { preferences: { theme: 'dark', handedness: 'left', motion: 'reduce' }, profiles: [] })).ok, 'actual-settings');
      const otherPorts = required(await other.openStores({ retireOwned() {} }));
      expect((await createSettingsStore({ ownerId: otherOwner, storage: otherPorts.settings, availableDevices: () => [] }).save(0,
        { preferences: { theme: 'light', handedness: 'right', motion: 'reduce' }, profiles: [] })).ok, 'other-owner-settings');
      return { phase, profile: TELEMETRY_OWNER_SELECTION_PROFILE, actualProcessProducer: true,
        originalSelected: pages[0].records[0], originalRetained: pages[1].records[0], proof: await proof() };
    }
    if (phase === 'begin') {
      // Pending actual producer input must lose its old port/capture epoch when
      // the separately approved managed deletion barrier is committed.
      const ports = required(await controller.openStores({ retireOwned() { retired++; producer?.close(); } }));
      producer = makeHistory(ports);
      const capture = await producer.requestCapture({ resourceId: selected, schemaVersion: 1, fields: ['residentBytes'], provenanceFields: [],
        destinationId: 'local-history', purpose: 'owner-process-diagnostics', expiresAt: 51000,
        schema: { type: 'record', fields: { residentBytes: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER } } } });
      expect(capture.ok, 'fresh-not-restored-capture');
      expect(producer.enqueue(capture.handle, { sourceTime: { clockId: `owned-node:${process.pid}:${randomUUID()}`, at: performance.now() },
        quality: 'observed', values: { residentBytes: process.memoryUsage().rss } }).ok, 'actual-queued-data');
      approved = false; const denied = await controller.beginDeletion(select);
      expect(!denied.ok && denied.reason === 'denied', 'default-denied-selection'); approved = true;
      const deletion = required(await controller.beginDeletion(select));
      expect(deletion.state === 'pending' && deletion.telemetryResourceId === selected && ports.signal.aborted && retired === 1, 'selected-owned-barrier');
      expect((await producer.flush()).ok === false, 'old-queued-producer-rejected');
      const exported = await controller.exportPage(exportResource(retained)); expect(!exported.ok && exported.reason === 'review-required', 'pending-review-barrier');
      expect(scopes.filter(scope => scope.action === 'delete').every(scope => scope.request.telemetryResourceId === selected), 'exact-delete-authority');
      return { phase, deletion, denied: true, oldProducerRejected: true, retired, proof: await proof() };
    }
    if (phase === 'stage' || phase === 'complete') {
      const pending = required(await controller.inspectDeletion()); expect(pending?.state === 'pending' && pending.telemetryResourceId === selected, 'persisted-review-not-authority');
      approved = false; const denied = await controller.resumeDeletionReviewed(pending.operationId);
      expect(!denied.ok && denied.reason === 'denied', 'restart-needs-fresh-decision'); approved = true;
      const deletion = required(await controller.resumeDeletionReviewed(pending.operationId));
      expect(scopes.filter(scope => scope.action === 'resume-delete').every(scope => scope.request.operationId === pending.operationId &&
        scope.request.telemetryResourceId === selected), 'exact-fresh-resume-authority');
      expect(deletion.completedStages === (phase === 'stage' ? 1 : 2) && deletion.state === (phase === 'stage' ? 'pending' : 'completed'), 'exact-stage');
      expect(deletion.removed.telemetry === 1 && deletion.removed.copies === (phase === 'stage' ? 0 : 1), 'selected-counts');
      return { phase, deletion, freshResumeApproved: true, proof: await proof() };
    }
    if (phase === 'expiry' || phase === 'audit-expiry') {
      const swept = required(await controller.sweep());
      if (phase === 'expiry') expect(swept.telemetryRemoved === 1 && swept.copiesRemoved === 1, 'original-retention-not-extended');
      const snapshot = await proof(); expect(snapshot.telemetryRows === 0 && snapshot.copies === 0, 'local-content-expired');
      if (phase === 'audit-expiry') expect(snapshot.auditRows === 0, 'only-at-original-audit-retention');
      return { phase, swept, proof: snapshot };
    }
    const ports = required(await controller.openStores({ retireOwned() { retired++; producer?.close(); } })); producer = makeHistory(ports);
    expect(producer.status().captureHandles === 0 && producer.status().uploadHandles === 0, 'reopen-restores-data-only');
    const selectedPage = required(await controller.exportPage({ ...exportResource(selected), fields: ['residentBytes'] }));
    const retainedPage = required(await controller.exportPage({ ...exportResource(retained), fields: ['heapUsedBytes'] }));
    expect(selectedPage.records.length === (phase === 'inspect' ? 1 : 0) && retainedPage.records.length === 1, 'selected-export-counts');
    const copies = required(await controller.exportPage(exportCopies)); expect(copies.records.length === (phase === 'inspect' ? 2 : 1), 'selected-copy-counts');
    approved = false; const deniedExport = await controller.exportPage(exportResource(retained));
    expect(!deniedExport.ok && deniedExport.reason === 'denied', 'export-consent-independent'); approved = true;
    return { phase, originalSelected: selectedPage.records[0] ?? null, originalRetained: retainedPage.records[0],
      restoredCaptureOrUploadAuthority: false, exportDeniedWithoutFreshApproval: true, proof: await proof() };
  } finally { authority.abort(); producer?.close(); controller.close(); other.close(); }
}
