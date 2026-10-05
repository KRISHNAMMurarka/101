import { createOwnerDataController, createTelemetryHistory, createSettingsStore, createDurableArtifactJobStore,
  createAssetReference, verifyAssetContent, OWNER_DATA_PROFILE } from '@101/connect';
import { createDeviceRuntime } from '@101/connect';

export const OWNER_DATA_EXAMPLE_OWNER = 'owner-data-example';
const kinds = ['telemetry', 'settings', 'artifacts', 'copies'];
const selection = { kinds, purpose: 'owner-requested-removal' };
const encoder = new TextEncoder();
const inputBytes = encoder.encode('reviewed local artifact data\n');
const outputBytes = encoder.encode('REVIEWED LOCAL ARTIFACT DATA\n');
const chosen = { applicationId: 'example:owner-artifact', profileId: '101:local-artifact', profileRevision: 1,
  destinationId: 'owner-local-artifacts', idempotencyKey: 'owned-artifact', totalUnits: 4 };
function required(result) { if (!result.ok) throw new Error('owner-data-example:' + result.reason); return result.value; }
function expect(condition, message) { if (!condition) throw new Error('owner-data-example:' + message); }
const request = kind => ({ kind, purpose: 'owner-portability', destinationId: 'owner-download' });

/** An explicit host caller supplies a real storage port; loading this module starts no capture, jobs or export. */
export async function runOwnerDataExample(storage, phase = 'seed', options = {}) {
  const owner = options.ownerId ?? OWNER_DATA_EXAMPLE_OWNER;
  const time = options.now ?? (phase === 'expiry' ? 7000 : phase === 'audit-expiry' ? 7000 + 30 * 86400000 : 1000);
  const output = await createAssetReference('artifact:owned-artifact', 'blob', outputBytes);
  let approved = true, history, jobs, routeRuntime, retired = 0;
  const authority = new AbortController();
  const controller = createOwnerDataController({ ownerId: owner, storage, trustedNow: () => time,
    availableDevices: () => ['example-device'], artifactRetentionMs: 5000,
    reviewedArtifacts: [{ applicationId: chosen.applicationId, destinationId: chosen.destinationId, sha256: output.sha256 }],
    authorize: scope => approved && scope.ownerId === owner ? { scope, expiresAt: scope.deadline,
      isCurrent: () => approved, signal: authority.signal } : undefined });
  const summaries = async () => {
    const pages = {};
    for (const kind of kinds) pages[kind] = required(await controller.exportPage({ ...request(kind), ...(kind === 'artifacts' ? { includeArtifactBytes: true } : {}) }));
    for (const page of Object.values(pages)) expect(Object.keys(page).sort().join(',') === 'kind,profile,records', 'closed-export-page');
    for (const row of pages.telemetry.records) expect(Object.keys(row).sort().join(',') === 'expiresAt,id,ingestedAt,quality,resourceId,schemaVersion,sourceTime,values', 'closed-observation-projection');
    for (const row of pages.settings.records) expect(Object.keys(row).sort().join(',') === 'preferences,profiles', 'closed-settings-projection');
    for (const row of pages.artifacts.records) expect(Object.keys(row).sort().join(',') ===
      'applicationId,bytesBase64,createdAt,destinationId,evidence,historicalOutcome,idempotencyKey,output,profileId,profileRevision,requiresReview,updatedAt', 'closed-artifact-projection');
    return pages;
  };
  try {
    if (phase === 'seed') {
      const ports = required(await controller.openStores({ retireOwned() { retired++; history?.close(); void jobs?.close(); } }));
      const settings = createSettingsStore({ ownerId: owner, storage: ports.settings, availableDevices: () => ['example-device'] });
      expect((await settings.save(0, { preferences: { theme: 'dark', handedness: 'right', motion: 'reduce' }, profiles: [
        { id: 'owner-choice', deviceId: 'example-device', profileId: 'example:reviewed-layout', profileRevision: 1, calibration: { scale: 1, offset: 0 } },
      ] })).ok, 'actual-settings-write');
      const node = typeof process !== 'undefined' && typeof process.memoryUsage === 'function';
      const measured = node ? process.memoryUsage().rss : globalThis.innerWidth;
      expect(Number.isFinite(measured) && measured > 0, 'actual-bounded-measurement');
      const captureRequest = { resourceId: 'example:owner-measurement', schemaVersion: 1, fields: ['measured'], provenanceFields: [],
        destinationId: 'local-history', purpose: 'owner-local-diagnostics', expiresAt: time + 50000,
        schema: { type: 'record', fields: { measured: { type: 'scalar', unit: node ? 'By' : 'px', min: 0, max: Number.MAX_SAFE_INTEGER } } } };
      history = createTelemetryHistory({ ownerId: owner, storage: ports.telemetry, trustedNow: () => time,
        authorize: scope => approved ? { scope, expiresAt: scope.expiresAt } : undefined, limits: { retentionMs: 5000 } });
      const capture = await history.requestCapture(captureRequest); expect(capture.ok, 'capture-explicit');
      expect(history.enqueue(capture.handle, { sourceTime: { clockId: 'owner:monotonic', at: performance.now() }, quality: 'observed', values: { measured } }).ok, 'actual-enqueue');
      expect((await history.flush()).ok, 'actual-history-write');
      let duplicateCopied;
      const uploadRequest = { resourceId: captureRequest.resourceId, schemaVersion: captureRequest.schemaVersion,
        fields: captureRequest.fields, provenanceFields: captureRequest.provenanceFields, destinationId: 'local-recipient',
        purpose: captureRequest.purpose, expiresAt: captureRequest.expiresAt };
      const upload = await history.requestUpload(uploadRequest, async (batch, context) => {
        expect(!context.signal.aborted, 'explicit-upload-current');
        const copied = required(await controller.storeLocalTelemetryCopy(batch, { purpose: 'owner-local-diagnostics', destinationId: 'local-recipient' }));
        duplicateCopied = required(await controller.storeLocalTelemetryCopy(batch, { purpose: 'owner-local-diagnostics', destinationId: 'local-recipient' })).copied;
        expect(copied.copied === 1 && duplicateCopied === 0 && !context.signal.aborted, 'recipient-copy-idempotence');
        return { batchId: batch.batchId, recordIds: batch.records.map(row => row.id) };
      });
      // Upload requests have a closed schema; remove the capture-only schema before asking for a new destination grant.
      expect(upload.ok, 'separate-upload-approval');
      expect((await history.pumpUpload(upload.handle)).ok, 'genuine-local-recipient-write');
      const input = await createAssetReference('artifact:owned-input', 'text', inputBytes), jobRequest = { ...chosen, input };
      jobs = createDurableArtifactJobStore({ ownerId: owner, storage: ports.artifacts, now: () => time,
        authorize: scope => approved && scope.ownerId === owner && scope.request?.idempotencyKey === chosen.idempotencyKey
          ? { expiresAt: time + 50000, isCurrent: () => approved, signal: ports.signal } : undefined });
      required(await jobs.submit(jobRequest)); const attempt = required(await jobs.start(chosen.idempotencyKey, inputBytes));
      const chunks = [];
      for (let unit = 1; unit <= 4; unit++) {
        await new Promise(resolve => setTimeout(resolve, 0)); expect(!attempt.signal.aborted, 'owned-generation-current');
        const start = Math.floor((unit - 1) * inputBytes.length / 4), end = Math.floor(unit * inputBytes.length / 4);
        chunks.push(new TextDecoder().decode(inputBytes.subarray(start, end)).toUpperCase()); required(await attempt.progress(unit));
      }
      required(await attempt.commit(encoder.encode(chunks.join(''))));
      const retained = required(await jobs.readOutput(chosen.idempotencyKey)); expect(await verifyAssetContent(retained.reference, retained.bytes), 'actual-artifact-hash');
      const exported = await summaries();
      expect(exported.telemetry.records.length === 1 && exported.copies.records.length === 1 && exported.artifacts.records.length === 1, 'all-producers-export');
      return { profile: OWNER_DATA_PROFILE, phase, measured, duplicateCopied, artifactSha256: retained.reference.sha256, exported };
    }
    if (phase === 'inspect') {
      approved = false; expect((await controller.exportPage(request('telemetry'))).reason === 'denied', 'restart-no-restored-export-grant');
      approved = true; const exported = await summaries();
      expect(exported.telemetry.records.length === 1 && exported.artifacts.records[0]?.output.sha256 === output.sha256, 'persisted-real-bytes');
      return { profile: OWNER_DATA_PROFILE, phase, automaticWork: 0, restoredAuthority: false, exported };
    }
    if (phase === 'begin') {
      const ports = required(await controller.openStores({ retireOwned() { retired++; routeRuntime?.close(); } }));
      const writer = createSettingsStore({ ownerId: owner, storage: ports.settings, availableDevices: () => ['example-device'] });
      const old = await writer.load(); expect(old.ok, 'pre-delete-owner-settings');
      // This issued effect lives outside managed storage. The caller separately owns its route grant and cancellation.
      let routeApproved = false, issuedEffects = 0, delivery, finish;
      routeRuntime = createDeviceRuntime({ now: () => time, authorize: scope => routeApproved && !ports.signal.aborted &&
        scope.principalId === owner && scope.applicationId === 'example:local-command' && scope.sessionId === 'owner-delete-session'
        ? { expiresAt: time + 50000, maxAgeMs: 1000 } : undefined });
      const device = sink => ({ schemaVersion: 1, id: sink ? 'owner-command-sink' : 'owner-command-source', label: 'Owned local command', revision: 1,
        adapter: { id: 'example:owner-command', version: '1' }, runtime: { platform: 'embedded-application' }, capabilities: [{
          id: 'command', semantic: 'example:owner-command', schemaVersion: 1, kind: sink ? 'command' : 'event', value: { type: 'boolean' },
          delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: sink ? ['invoke'] : ['subscribe'] }] });
      const source = routeRuntime.registerSource({ device: device(false), capability: 'command' });
      const sink = routeRuntime.registerSink({ device: device(true), capability: 'command', apply(_observation, context) {
        expect(context.isCurrent(), 'independent-command-current'); issuedEffects++; delivery = context;
        return new Promise(resolveCommand => { finish = resolveCommand; });
      }, release() {} });
      routeRuntime.setReadiness(source, 'available'); routeRuntime.setReadiness(sink, 'available');
      const routeRequest = { from: source, to: sink, principalId: owner, applicationId: 'example:local-command', sessionId: 'owner-delete-session' };
      expect(!routeRuntime.route(routeRequest).start().ok, 'no-command-effect-without-route-grant');
      routeApproved = true; const connection = routeRuntime.route(routeRequest); expect(connection.start().ok, 'explicit-command-route');
      expect(routeRuntime.publish(source, true, { operationId: '1', deadline: time + 1000 }).ok, 'issued-command-admission');
      routeRuntime.flush(); expect(issuedEffects === 1 && typeof finish === 'function', 'actual-local-command-issued');
      expect(routeRuntime.publish(source, true, { operationId: '2', deadline: time + 1000 }).ok, 'queued-command-admission');
      const deletion = required(await controller.beginDeletion(selection));
      expect(ports.signal.aborted && retired === 1, 'immediate-local-authority-retirement');
      expect(delivery.signal.aborted && !delivery.isCurrent(), 'caller-cancelled-external-route');
      finish(); await new Promise(resolveLate => setTimeout(resolveLate, 0)); routeRuntime.flush();
      expect(issuedEffects === 1 && connection.status().state === 'closed', 'late-handler-and-queued-effect-fenced-without-undo');
      expect(!(await writer.save(old.value.revision, { preferences: old.value.preferences, profiles: old.value.profiles })).ok, 'late-owner-write-fenced');
      expect((await controller.exportPage(request('telemetry'))).reason === 'review-required', 'barrier-before-delete-stages');
      return { profile: OWNER_DATA_PROFILE, phase, deletion, retired, independentRoute: { deniedWithoutGrant: true,
        alreadyIssuedLocalEffects: issuedEffects, queuedEffectsFenced: true, deliveryAborted: delivery.signal.aborted, undoClaim: false } };
    }
    if (phase === 'stage' || phase === 'resume') {
      const pending = required(await controller.inspectDeletion()); expect(pending?.state === 'pending', 'persisted-pending-deletion');
      approved = false; expect((await controller.resumeDeletionReviewed(pending.operationId)).reason === 'denied', 'restart-needs-new-owner-review');
      approved = true;
      let deletion = pending;
      const attempts = phase === 'stage' ? 1 : 4;
      for (let stage = 0; stage < attempts && deletion.state === 'pending'; stage++) deletion = required(await controller.resumeDeletionReviewed(deletion.operationId));
      const exported = deletion.state === 'completed' ? await summaries() : undefined;
      if (exported) expect(exported.telemetry.records.length === 0 && exported.artifacts.records.length === 0 && exported.copies.records.length === 0,
        'verified-staged-delete');
      return { profile: OWNER_DATA_PROFILE, phase, deletion, restoredAuthority: false, ...(exported ? { exported } : {}) };
    }
    if (phase === 'expiry' || phase === 'audit-expiry') {
      const swept = required(await controller.sweep()), exported = await summaries();
      expect(exported.telemetry.records.length === 0 && exported.artifacts.records.length === 0 && exported.copies.records.length === 0, 'expired-data-unavailable');
      return { profile: OWNER_DATA_PROFILE, phase, swept, exported };
    }
    throw new Error('owner-data-example:unknown-phase');
  } finally { authority.abort(); controller.close(); routeRuntime?.close(); history?.close(); await jobs?.close(); }
}
