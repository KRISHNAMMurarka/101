import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { verifyAssetContent } from '@101/connect';
import type { MediaApprovalRequest, MediaControlOptions } from '../examples/media-control/media-control.ts';

const api = await import('../examples/media-control/media-control.ts').catch(() => undefined);

test('an independent public media/control composition exists beyond the shared pending-work example', () => {
  assert.equal(typeof api?.runMediaControlQualification, 'function', 'Missing separate media/control runtime composition');
});

test('selected RGBA adaptation preserves actual sampled pixels and an exact new content hash', async () => {
  assert.ok(api);
  const pixels = api.createAuthoredRgbaFrame(128, 7);
  const smaller = api.downscaleAuthoredRgbaFrame(pixels);
  assert.equal(smaller.byteLength, 16384);
  for (const [x, y] of [[0, 0], [17, 31], [63, 63]]) {
    const original = ((y! * 2) * 128 + x! * 2) * 4, adapted = (y! * 64 + x!) * 4;
    assert.deepEqual(smaller.slice(adapted, adapted + 4), pixels.slice(original, original + 4));
  }
  const frame = await api.prepareAuthoredMediaFrame(smaller, 64, 2, 8);
  assert.equal(frame.reference.byteLength, 16384);
  assert.ok(await verifyAssetContent(frame.reference, smaller));
  assert.equal(frame.epoch, 2);
  assert.ok(Object.isFrozen(frame));
});

test('selected frame boundary rejects oversize and getter inputs before copying or native dispatch', async () => {
  assert.ok(api);
  await assert.rejects(api.prepareAuthoredMediaFrame(new Uint8Array(65537), 128, 1, 1));
  let read = 0;
  const wrong = Object.create(Uint8Array.prototype, { byteLength: { get() { read++; return 65536; } } });
  await assert.rejects(api.prepareAuthoredMediaFrame(wrong, 128, 1, 1));
  assert.equal(read, 0);
});

function approvals(signal: AbortSignal) {
  return {
    signal,
    authorize(request: { principalId: string; applicationId: string; sessionId: string }) {
      if (!['media-recipient-0', 'media-recipient-1', 'control-owner'].includes(request.principalId) ||
          request.applicationId !== 'media-control-example' || request.sessionId !== 'owned-worker-session') return;
      return { expiresAt: performance.now() + 9000, maxAgeMs: 1000, maxHz: 30 };
    },
    approveMedia(request: MediaApprovalRequest) {
      return { request, signal, grant: { expiresAt: performance.now() + 9000, maxAgeMs: 1000, maxHz: 30 } };
    },
    authorizeResource(request: { principalId: string; applicationId: string; sessionId: string }) {
      if (!['media-recipient-0', 'media-recipient-1'].includes(request.principalId) || request.applicationId !== 'media-control-example' || request.sessionId !== 'owned-worker-session') return;
      return { expiresAt: performance.now() + 9000, maxBytes: 65536 };
    },
  };
}

test('actual split native workers preserve contact progress during held media and settle owned cleanup', async () => {
  assert.ok(api);
  const owner = new AbortController();
  const result = await api.runMediaControlQualification(approvals(owner.signal));
  assert.equal(result.status, 'pass', result.reason);
  assert.equal(result.controlDuringHeldMedia, true);
  assert.equal(result.latestReplacementObserved, true);
  assert.equal(result.slowFastIsolationObserved, true);
  assert.equal(result.adaptedFrameObserved, true);
  assert.equal(result.oldEpochAckActivated, false);
  assert.equal(result.ownedCleanup.workersStarted, 2);
  assert.equal(result.ownedCleanup.workersExited, 2);
  assert.equal(result.ownedCleanup.rawOperations, 0);
  assert.equal(result.ownedCleanup.rawBytes, 0);
  assert.equal(result.ownedCleanup.timers, 0);
  assert.equal(result.ownedCleanup.listeners, 0);
});

test('explicit media denial prevents native raster dispatch and reports denied after real Worker cleanup', async () => {
  assert.ok(api);
  const owner = new AbortController();
  const result = await api.runMediaControlQualification({ ...approvals(owner.signal), approveMedia: () => undefined });
  assert.equal(result.status, 'denied');
  assert.ok(result.targets.every(target => target.mediaDispatched === 0));
  assert.deepEqual(result.ownedCleanup, { workersStarted: 2, workersExited: 2, rawOperations: 0, rawBytes: 0, timers: 0, listeners: 0 });
});

test('a reentrant owner abort during exact media approval cannot dispatch a native raster', async () => {
  assert.ok(api);
  const owner = new AbortController();
  const result = await api.runMediaControlQualification({ ...approvals(owner.signal), approveMedia(request) {
    assert.ok(Object.isFrozen(request)); owner.abort();
    return { request, signal: owner.signal, grant: { expiresAt: performance.now() + 9000, maxAgeMs: 1000, maxHz: 30 } };
  } });
  assert.equal(result.status, 'cancelled');
  assert.ok(result.targets.every(target => target.mediaDispatched === 0));
  assert.equal(result.ownedCleanup.workersStarted, result.ownedCleanup.workersExited);
  assert.equal(result.ownedCleanup.rawOperations + result.ownedCleanup.rawBytes + result.ownedCleanup.timers + result.ownedCleanup.listeners, 0);
});

test('forged owners and accessor-bearing options are inert before native construction', async () => {
  assert.ok(api);
  const owner = new AbortController();
  const forged = await api.runMediaControlQualification({ ...approvals(owner.signal), signal: { aborted: false } } as unknown as MediaControlOptions);
  assert.equal(forged.status, 'invalid'); assert.equal(forged.ownedCleanup.workersStarted, 0);
  let reads = 0; const accessor = { ...approvals(owner.signal) };
  Object.defineProperty(accessor, 'approveMedia', { enumerable: true, get() { reads++; throw Error('Must not call getter'); } });
  const rejected = await api.runMediaControlQualification(accessor);
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.ownedCleanup.workersStarted, 0); assert.equal(reads, 0);
});
