import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime, createMediaRecording } from './index.ts';
import { verifyAssetContent } from '@101/device-model';
import type { MediaRecording, MediaRecordingResult, MediaRecordingSource } from './media-recording.ts';
import type { OwnerDataStorage } from './owner-data.ts';
import type { RecordingOwnerDataOptions, RecordingOwnerDataPort } from './recording-owner-data.ts';

// A synchronous guarded fixture proves controller logic; native persistence is separately qualified.
const api = await import('./recording-owner-data.ts').catch(() => undefined);
function memory() {
  const rows = new Map<string, unknown>();
  let gate: { entered(): void; release: Promise<void> } | undefined;
  let fail = false, pending = 0;
  let beforeCommit: (() => void) | undefined;
  let beforeFinalGuard: ((state: unknown) => void) | undefined;
  const storage: OwnerDataStorage = { async transact(owner, mutation, guard) {
    pending++;
    try {
      const held = gate; gate = undefined;
      if (held) { held.entered(); await held.release; }
      if (fail) throw new Error('PRIVATE_BACKEND_FAILURE');
      if (guard && (guard.signal.aborted || !guard.isCurrent() || guard.signal.aborted)) throw new Error('unit-cancelled');
      const next = mutation(structuredClone(rows.get(owner)));
      beforeFinalGuard?.(next.state);
      if (guard && (guard.signal.aborted || !guard.isCurrent() || guard.signal.aborted)) throw new Error('unit-cancelled');
      beforeCommit?.();
      if (guard?.signal.aborted) throw new Error('unit-cancelled');
      rows.set(owner, structuredClone(next.state));
      return next.result;
    } finally { pending--; }
  } };
  return { storage, rows, pending: () => pending,
    fail(value: boolean) { fail = value; }, beforeCommit(callback?: () => void) { beforeCommit = callback; },
    beforeFinalGuard(callback?: (state: unknown) => void) { beforeFinalGuard = callback; },
    holdNext() {
      let announce!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { announce = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      gate = { entered: announce, release: held };
      return { entered, release };
    } };
}
function required<T>(result: MediaRecordingResult<T> | Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: string }>): T {
  assert.ok(result.ok, result.ok ? undefined : result.reason); return result.value;
}
const SOURCE = { schemaVersion: 1, id: 'PRIVATE_DEVICE', label: 'PRIVATE_LABEL', revision: 1,
  adapter: { id: 'example:managed-recording', version: '1.0.0' }, runtime: { platform: 'owned-application' },
  capabilities: [{ id: 'rgba-frame', semantic: 'example:rgba-frame', schemaVersion: 1, kind: 'sample',
    value: { type: 'array', minItems: 8, maxItems: 8, items: { type: 'array', minItems: 32, maxItems: 32,
      items: { type: 'scalar', unit: '1', min: 0, max: 255 } } }, delivery: { mode: 'latest', maxHz: 100, maxAgeMs: 100 },
    permissions: ['subscribe'] }] };
const FRAME_BYTES = new Uint8Array(256).fill(23);
const SCOPE = { principalId: 'PRIVATE_PRINCIPAL', applicationId: 'PRIVATE_APPLICATION', sessionId: 'PRIVATE_SESSION' };
async function routedClip(recording: MediaRecording, retentionMs = 100) {
  const runtime = createDeviceRuntime({ now: () => 17.25, clockDomain: 'public-software-source-clock',
    authorize: () => ({ expiresAt: 10000, maxAgeMs: 100, maxHz: 100 }) });
  const source = runtime.registerSource({ device: SOURCE, capability: 'rgba-frame' });
  const facts: MediaRecordingSource = { deviceId: SOURCE.id, capabilityId: 'rgba-frame', registrationId: source.id,
    applicationId: SCOPE.applicationId, sessionId: SCOPE.sessionId, clockId: runtime.clockDomain };
  const selected = required(await recording.requestCapture({ source: facts, purpose: 'approved-recording', expiresAt: 2000, retentionMs }));
  let admitted = false;
  const sink = runtime.registerSink({ device: { ...SOURCE, id: 'PRIVATE_RECORD_SINK', capabilities: SOURCE.capabilities.map(capability =>
    ({ ...capability, kind: 'property', permissions: ['write'] })) }, capability: 'rgba-frame',
    apply(observation, context) {
      const rows = observation.value as readonly (readonly number[])[];
      admitted = recording.enqueue(selected.handle, { bytes: Uint8Array.from(rows.flat()), sourceTime: {
        clockId: observation.clockDomain, at: observation.timestamp }, sequence: observation.sequence, quality: observation.quality },
      { source: facts, signal: context.signal, isCurrent: () => context.isCurrent() }).ok;
    }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const route = runtime.route({ from: source, to: sink, ...SCOPE }); assert.equal(route.start().ok, true);
  assert.equal(runtime.publish(source, Array.from({ length: 8 }, (_, index) => Array.from(FRAME_BYTES.subarray(index * 32, index * 32 + 32))),
    { sequence: 1, timestamp: 17.25 }).ok, true);
  runtime.flush(); assert.equal(admitted, true);
  assert.equal(required(await recording.flush()).committed, 1);
  runtime.close(); return selected;
}

test('missing managed recorded-media binding is RED after real public routed recording export', async () => {
  const port = memory(), owner = new AbortController(), consent = new AbortController();
  const recording = createMediaRecording({ ownerId: 'owner-a', ownerSignal: owner.signal, storage: port.storage,
    trustedNow: () => 1000, authorize: request => ({ request, signal: consent.signal, expiresAt: request.expiresAt }) });
  let prefix: object | undefined;
  try {
    const clip = await routedClip(recording);
    const page = required(await recording.exportPage({ clipId: clip.clipId, destinationId: 'owned-local-copy', purpose: 'owner-portability',
      expiresAt: 2000, afterIndex: 0, limit: 4 }));
    assert.equal(page.frames.length, 1); assert.deepEqual(page.frames[0]?.bytes, FRAME_BYTES);
    assert.equal(await verifyAssetContent({ id: 'recording:frame', kind: 'blob', mediaType: 'application/octet-stream',
      byteLength: 256, sha256: page.frames[0]!.sha256 }, page.frames[0]!.bytes), true);
    prefix = { actualRoutedSourceSink: true, actualProducer: 'createMediaRecording', committed: 1,
      exportFrames: page.frames.length, frameBytes: page.frames[0]!.bytes.byteLength, sha256: page.frames[0]!.sha256,
      verifiedSha256: true, physicalCapture: false };
    assert.equal(typeof api?.createRecordingOwnerData, 'function',
      'Actual V11 recorded clips need the approved managed registered-copy deletion/expiry/audit binding');
  } finally {
    await recording.close();
    const status = recording.status();
    const cleanup = Object.fromEntries(['captures', 'players', 'pendingFrames', 'pendingBytes', 'rawPending', 'timers', 'listeners']
      .map(key => [key, status[key as keyof typeof status]]));
    for (const count of Object.values(cleanup)) assert.equal(count, 0);
    assert.equal(port.pending(), 0);
    console.log(JSON.stringify({ kind: 'recording-owner-data-old-feature-prefix', prefix, cleanup, storagePending: port.pending() }));
  }
});

function setup(storage = memory(), overrides: Partial<RecordingOwnerDataOptions> = {}) {
  assert.ok(api, 'managed-recorded-media-owner-data/1 must bind the actual recording producer');
  let time = 1000, allowed = true, retired = 0;
  const scopes: Parameters<RecordingOwnerDataOptions['authorize']>[0][] = [];
  const owner = new AbortController(), grant = new AbortController(), recordingGrant = new AbortController();
  const controller = api.createRecordingOwnerData({ ownerId: 'owner-a', ownerSignal: owner.signal, storage: storage.storage,
    trustedNow: () => time,
    authorizeRecording: request => ({ request, signal: recordingGrant.signal, expiresAt: request.expiresAt }),
    authorize: scope => { scopes.push(scope); return allowed ? { scope, signal: grant.signal, expiresAt: scope.deadline, isCurrent: () => true } : undefined; },
    ...overrides });
  return { controller, storage, owner, grant, recordingGrant, scopes, retired: () => retired,
    time(value: number) { time = value; }, allow(value: boolean) { allowed = value; },
    async open(): Promise<RecordingOwnerDataPort> { return required(await controller.openRecording({ purpose: 'approved-recording',
      expiresAt: time + 1000, retireOwned() { retired++; } })); } };
}
const exportRequest = (clipId: string) => ({ clipId, destinationId: 'owned-local-copy', purpose: 'owner-portability',
  expiresAt: 2000, afterIndex: 0, limit: 4 });

test('original recording TTL blocks export after the final content authorization advances trusted time', async () => {
  let at = 1000, contentApprovals = 0;
  const consent = new AbortController();
  const f = setup(memory(), { trustedNow: () => at, authorize(scope) {
    if (scope.action === 'export' && scope.frameHashes.length) { contentApprovals++; at = 1100; }
    return { scope, signal: consent.signal, expiresAt: scope.deadline, isCurrent: () => true };
  } });
  try {
    const port = await f.open(), clip = await routedClip(port.recording, 100);
    const reviewed = required(await port.recording.listReviewed({ purpose: 'owner-review', expiresAt: 2000 }));
    assert.equal(reviewed[0]?.createdAt, 1000); assert.equal(reviewed[0]?.expiresAt, 1100); assert.equal(reviewed[0]?.frameCount, 1);
    const result = await f.controller.exportPage(exportRequest(clip.clipId));
    assert.equal(contentApprovals, 1); assert.equal(at, reviewed[0]!.expiresAt);
    // The old controller emits the genuine256-byte, SHA-verified producer frame
    // here. The unchanged absolute ingestion TTL must block that final issuance.
    if (result.ok) {
      assert.deepEqual(result.value.frames[0]?.bytes, FRAME_BYTES);
      assert.equal(await verifyAssetContent(result.value.frames[0]!.reference, result.value.frames[0]!.bytes), true);
    }
    assert.deepEqual(result, { ok: false, reason: 'expired' });
  } finally {
    await f.controller.close(); assert.equal(f.storage.pending(), 0);
  }
});

test('original recording TTL blocks a registered copy at the actual final storage guard', async () => {
  let at = 1000, finalTransitions = 0;
  const f = setup(memory(), { trustedNow: () => at });
  try {
    const port = await f.open(), clip = await routedClip(port.recording, 100);
    const page = required(await f.controller.exportPage(exportRequest(clip.clipId)));
    assert.equal(page.expiresAt, 1100); assert.deepEqual(page.frames[0]?.bytes, FRAME_BYTES);
    assert.equal(await verifyAssetContent(page.frames[0]!.reference, page.frames[0]!.bytes), true);
    const before = structuredClone(f.storage.rows.get('owner-a'));
    f.storage.beforeFinalGuard(state => {
      // Observe only the actual next state produced by the supplied mutation;
      // no fabricated success or frame replaces producer output or its guard.
      if (!finalTransitions && (state as { copies?: readonly unknown[] }).copies?.length === 1) {
        finalTransitions++; at = page.expiresAt;
      }
    });
    const result = await f.controller.storeRegisteredExport(page, { purpose: 'owner-portability', destinationId: 'owned-local-copy' });
    assert.equal(finalTransitions, 1); assert.equal(at, page.expiresAt);
    assert.ok(f.scopes.find(scope => scope.action === 'register-copy')!.deadline > page.expiresAt);
    assert.deepEqual(result, { ok: false, reason: 'expired' });
    assert.deepEqual(f.storage.rows.get('owner-a'), before);
  } finally {
    f.storage.beforeFinalGuard(); await f.controller.close(); assert.equal(f.storage.pending(), 0);
  }
});

test('managed export is a closed verified public frame projection and only issued current pages can register', async () => {
  const f = setup();
  try {
    const port = await f.open(), clip = await routedClip(port.recording);
    f.allow(false); assert.deepEqual(await f.controller.exportPage(exportRequest(clip.clipId)), { ok: false, reason: 'denied' });
    f.allow(true); const page = required(await f.controller.exportPage(exportRequest(clip.clipId)));
    assert.equal(page.frames.length, 1); assert.deepEqual(page.frames[0]?.bytes, FRAME_BYTES);
    assert.equal(await verifyAssetContent(page.frames[0]!.reference, page.frames[0]!.bytes), true);
    const serialized = JSON.stringify(page);
    for (const secret of ['PRIVATE_DEVICE', 'PRIVATE_LABEL', 'PRIVATE_PRINCIPAL', 'PRIVATE_APPLICATION', 'PRIVATE_SESSION',
      'owner-a', 'registrationId', 'authorize', 'sourceContext']) assert.equal(serialized.includes(secret), false);
    assert.equal(Object.isFrozen(page), true); assert.equal(Object.isFrozen(page.frames), true);
    assert.equal((await f.controller.storeRegisteredExport({ ...page, secret: 'PRIVATE_TOKEN' },
      { purpose: 'owner-portability', destinationId: 'owned-local-copy' })).ok, false);
    assert.equal((await f.controller.storeRegisteredExport(page, { purpose: 'owner-portability', destinationId: 'forged-destination' })).ok, false);
    // A genuine metadata readback advances trusted time, not the recorded content pin.
    f.time(1001);
    assert.equal(required(await f.controller.storeRegisteredExport(page,
      { purpose: 'owner-portability', destinationId: 'owned-local-copy' })).copied, 1);
    assert.equal((await f.controller.storeRegisteredExport(page, { purpose: 'owner-portability', destinationId: 'owned-local-copy' })).ok, false);
    const pinned = f.scopes.filter(scope => scope.action === 'export' && scope.frameHashes.length || scope.action === 'register-copy');
    assert.equal(pinned.length, 2);
    for (const scope of pinned) {
      assert.deepEqual(scope.frameHashes, [page.frames[0]!.reference.sha256]); assert.deepEqual(scope.clipIds, [clip.clipId]);
      assert.equal(scope.afterIndex, 0); assert.equal(scope.limit, 4); assert.equal(scope.destinationId, 'owned-local-copy');
    }
    const original = structuredClone(f.storage.rows.get('owner-a')) as { version: number; ownerId: string;
      copies: { frames: { hex: string }[] }[]; recording: Record<string, unknown> };
    const corrupt = structuredClone(original); corrupt.copies[0]!.frames[0]!.hex = '00'.repeat(256);
    f.storage.rows.set('owner-a', corrupt);
    assert.deepEqual(await f.controller.listAudit(), { ok: false, reason: 'integrity' }); assert.deepEqual(f.storage.rows.get('owner-a'), corrupt);
    const future = { ...original, version: 2 }; f.storage.rows.set('owner-a', future);
    assert.deepEqual(await f.controller.listAudit(), { ok: false, reason: 'incompatible' }); assert.deepEqual(f.storage.rows.get('owner-a'), future);
    const foreign = { ...original, ownerId: 'other-owner' }; f.storage.rows.set('owner-a', foreign);
    assert.deepEqual(await f.controller.listAudit(), { ok: false, reason: 'wrong-owner' }); assert.deepEqual(f.storage.rows.get('owner-a'), foreign);
    const invalidInner = { ...original, recording: { ...original.recording, unknown: 'PRIVATE_TOKEN' } }; f.storage.rows.set('owner-a', invalidInner);
    assert.deepEqual(await f.controller.listAudit(), { ok: false, reason: 'corrupt' }); assert.deepEqual(f.storage.rows.get('owner-a'), invalidInner);
    f.storage.rows.set('owner-a', original);
  } finally { await f.controller.close(); }
});

test('deletion fences a held actual recording write and restart requires fresh stage review', async () => {
  const storage = memory(), left = setup(storage), right = setup(storage);
  try {
    const port = await left.open(), clip = await routedClip(port.recording);
    const page = required(await left.controller.exportPage(exportRequest(clip.clipId)));
    required(await left.controller.storeRegisteredExport(page, { purpose: 'owner-portability', destinationId: 'owned-local-copy' }));
    const held = storage.holdNext();
    const old = port.recording.listReviewed({ purpose: 'owner-review', expiresAt: 2000 });
    await held.entered;
    const deletion = required(await right.controller.beginDeletion({ clipIds: [clip.clipId], purpose: 'owner-remove' }));
    assert.equal(deletion.state, 'pending');
    held.release(); assert.equal((await old).ok, false);
    required(await right.controller.resumeDeletionReviewed(deletion.operationId));
    await right.controller.close();
    const reopened = setup(storage);
    try {
      reopened.allow(false);
      assert.deepEqual(await reopened.controller.resumeDeletionReviewed(deletion.operationId), { ok: false, reason: 'denied' });
      reopened.allow(true);
      let reviewed = required(await reopened.controller.inspectDeletion());
      for (let stage = 0; stage < 5 && reviewed?.state === 'pending'; stage++) reviewed = required(await reopened.controller.resumeDeletionReviewed(deletion.operationId));
      assert.equal(reviewed?.state, 'completed');
      const audit = required(await reopened.controller.listAudit());
      assert.equal(audit.at(-1)?.action, 'deletion'); assert.equal(audit.at(-1)?.state, 'completed');
      for (const privateValue of ['PRIVATE_', 'owned-local-copy', 'owner-a', 'clip:']) assert.equal(JSON.stringify(audit).includes(privateValue), false);
      const fresh = await reopened.open();
      assert.equal(required(await fresh.recording.listReviewed({ purpose: 'owner-review', expiresAt: 2000 })).length, 0);
      assert.equal(fresh.recording.status().captures, 0); assert.equal(fresh.recording.status().players, 0);
    } finally { await reopened.controller.close(); }
  } finally { await left.controller.close(); await right.controller.close(); }
});

test('original recording TTL removes registered copies and preserves only 30-day bounded expiry audit', async () => {
  const f = setup();
  try {
    const port = await f.open(), clip = await routedClip(port.recording, 100);
    const page = required(await f.controller.exportPage(exportRequest(clip.clipId)));
    required(await f.controller.storeRegisteredExport(page, { purpose: 'owner-portability', destinationId: 'owned-local-copy' }));
    assert.equal(page.expiresAt, 1100);
    f.time(1100);
    const swept = required(await f.controller.sweep());
    assert.equal(swept.clipsRemoved, 1); assert.equal(swept.copyFramesRemoved, 1);
    assert.equal((await f.controller.storeRegisteredExport(page, { purpose: 'owner-portability', destinationId: 'owned-local-copy' })).ok, false);
    const audit = required(await f.controller.listAudit());
    assert.equal(audit.length, 1); assert.equal(audit[0]?.action, 'expiry');
    assert.equal(audit[0]?.expiresAt, 1100 + 30 * 86400000);
    f.time(1100 + 30 * 86400000); required(await f.controller.sweep());
    assert.equal(required(await f.controller.listAudit()).length, 0);
  } finally { await f.controller.close(); }
});

test('required retained audit capacity is refused before a deletion changes recorded bytes or epoch', async () => {
  const f = setup();
  try {
    for (let row = 0; row < api!.RECORDING_OWNER_DATA_LIMITS.auditRows; row++) {
      const port = await f.open(), clip = await routedClip(port.recording);
      let deletion = required(await f.controller.beginDeletion({ clipIds: [clip.clipId], purpose: 'owner-remove' }));
      for (let stage = 0; stage < 5 && deletion.state === 'pending'; stage++) deletion = required(await f.controller.resumeDeletionReviewed(deletion.operationId));
      assert.equal(deletion.state, 'completed'); await port.close();
    }
    const port = await f.open(), clip = await routedClip(port.recording);
    const before = structuredClone(f.storage.rows.get('owner-a'));
    assert.deepEqual(await f.controller.beginDeletion({ clipIds: [clip.clipId], purpose: 'owner-remove' }), { ok: false, reason: 'capacity' });
    assert.deepEqual(f.storage.rows.get('owner-a'), before);
    assert.equal(required(await port.recording.listReviewed({ purpose: 'owner-review', expiresAt: 2000 })).length, 1);
  } finally { await f.controller.close(); }
});

test('owner abort at final commit and held close retain raw reservations until actual settlement', async () => {
  const cancelled = setup();
  cancelled.storage.beforeCommit(() => cancelled.owner.abort());
  assert.equal((await cancelled.controller.openRecording({ purpose: 'approved-recording', expiresAt: 2000, retireOwned() {} })).ok, false);
  assert.equal(cancelled.storage.rows.size, 0); await cancelled.controller.close();
  const f = setup();
  const held = f.storage.holdNext();
  const opening = f.controller.openRecording({ purpose: 'approved-recording', expiresAt: 2000, retireOwned() {} });
  await held.entered;
  let settled = false;
  const closing = f.controller.close().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(f.storage.pending(), 1);
  held.release(); assert.equal((await opening).ok, false); await closing;
  assert.equal(settled, true); assert.equal(f.storage.pending(), 0); assert.equal(f.storage.rows.size, 0);
  let callback!: () => void;
  const entered = new Promise<void>(resolve => { callback = resolve; });
  let release!: (value: undefined) => void;
  const authorizer = setup(memory(), { authorize() { callback(); return new Promise<undefined>(resolve => { release = resolve; }); } });
  const authorizing = authorizer.controller.openRecording({ purpose: 'approved-recording', expiresAt: 2000, retireOwned() {} });
  await entered;
  let authorizerCloseSettled = false;
  const authorizerClosing = authorizer.controller.close().then(() => { authorizerCloseSettled = true; });
  assert.equal((await authorizing).ok, false); assert.equal(authorizerCloseSettled, false);
  release(undefined); await authorizerClosing; assert.equal(authorizerCloseSettled, true);
  const reentrant = setup(); let retireCalls = 0;
  const reentrantPort = required(await reentrant.controller.openRecording({ purpose: 'approved-recording', expiresAt: 2000,
    retireOwned() { retireCalls++; void reentrant.controller.close(); } }));
  await reentrantPort.close(); await reentrant.controller.close(); assert.equal(retireCalls, 1);
  assert.equal(reentrantPort.recording.status().rawPending, 0);
});
