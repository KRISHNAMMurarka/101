import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks, createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '..');
const publicNames = ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'];
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@101/connect/examples/secure-websocket') return next(pathToFileURL(join(root, 'examples/device-pipelines/secure-websocket.ts')).href, context);
  const name = specifier.startsWith('@101/') ? specifier.slice(5) : '';
  return next(publicNames.includes(name) ? pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href : specifier, context);
} });
test.after(() => hook.deregister());

test('actual native SDK 101W producer works before the selected wire replay runner exists', async () => {
  const { runWireReplayProducerPrefix } = await import('../examples/wire-replay/consumer.mjs');
  const proof = await runWireReplayProducerPrefix(new AbortController().signal);
  assert.deepEqual(proof.actualReliableEffects, [true, false]); assert.equal(proof.capturedNativeFrame, true); console.log(JSON.stringify(proof));
  let runner: { runWireReplayQualification?: unknown } | undefined;
  try { const leaf = '../examples/wire-replay/wire-replay.ts'; runner = await import(leaf); } catch { /* Genuine missing-feature RED after an actual owned native producer effect. */ }
  assert.equal(typeof runner?.runWireReplayQualification, 'function', 'actual native 101W producer works; selected replay qualification runner is missing');
});

test('native fixture rejects copied and intrinsically aborted signals before binding', async () => {
  const { createNodeWireReplayFixture } = await import('../examples/wire-replay/consumer.mjs');
  await assert.rejects(createNodeWireReplayFixture({ aborted: false } as unknown as AbortSignal));
  const aborted = new AbortController(); aborted.abort(); Object.defineProperty(aborted.signal, 'aborted', { value: false });
  await assert.rejects(createNodeWireReplayFixture(aborted.signal));
  const fixture = await createNodeWireReplayFixture(new AbortController().signal);
  assert.equal(fixture.snapshot().nativeSockets, 0); assert.equal((await fixture.close()).nativeContexts, 0);
});

test('cancel retains fixture reservation until the actually issued native send callback settles', async () => {
  const { runWireReplayProducerPrefix, createNodeWireReplayFixture } = await import('../examples/wire-replay/consumer.mjs');
  interface NativeSocket { readonly _isServer?: boolean; send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void }
  const ws = createRequire(import.meta.url)('ws') as { WebSocket: { prototype: NativeSocket } };
  const original = ws.WebSocket.prototype.send, owner = new AbortController(); let release: (() => void) | undefined, entered!: () => void, settled = false;
  const held = new Promise<void>(resolve => { entered = resolve; });
  ws.WebSocket.prototype.send = function (data, callback) {
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    if (!this._isServer && !release && bytes.includes(Buffer.from('"type":"event"'))) {
      original.call(this, data, error => { release = () => callback?.(error); owner.abort(); entered(); }); return;
    }
    original.call(this, data, callback);
  };
  const running = runWireReplayProducerPrefix(owner.signal).finally(() => { settled = true; }); void running.catch(() => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([held, new Promise<void>((_resolve, reject) => { timeout = setTimeout(() => reject(Error('Owned held callback deadline.')), 3000); })]);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false);
    await assert.rejects(createNodeWireReplayFixture(new AbortController().signal), /already active/);
    release!(); release = undefined; await assert.rejects(running);
    const fresh = await createNodeWireReplayFixture(new AbortController().signal); assert.equal((await fresh.close()).nativeContexts, 0);
  } finally { clearTimeout(timeout); ws.WebSocket.prototype.send = original; release?.(); await running.catch(() => {}); }
});

test('issued provenance and final intrinsic owner signals reject copied peers and clock callback revocation', async () => {
  const { createNodeWireReplayFixture } = await import('../examples/wire-replay/consumer.mjs');
  const { runWireReplayQualification } = await import('../examples/wire-replay/wire-replay.ts');
  const owner = new AbortController(), fixture = await createNodeWireReplayFixture(owner.signal), pair = await fixture.open('baseline');
  const sourceOwner = new AbortController(), sinkOwner = new AbortController();
  assert.ok(pair.sourcePeer); assert.ok(pair.receiverPeer);
  const options = { sourcePeer: pair.sourcePeer, receiverPeer: pair.receiverPeer, epoch: pair.epoch, sourceOwnerSignal: sourceOwner.signal,
    sinkOwnerSignal: sinkOwner.signal, signal: owner.signal, now: () => performance.now(), boundary: pair.boundary(sourceOwner, sinkOwner) };
  try {
    await assert.rejects(runWireReplayQualification({ ...options, sourcePeer: { ...pair.sourcePeer } }), /actual current enrolled/);
    await assert.rejects(runWireReplayQualification({ ...options, now() { sinkOwner.abort(); return performance.now(); } }), /retired/);
  } finally { sourceOwner.abort(); sinkOwner.abort(); owner.abort(); await pair.close(); await fixture.close(); }
});

test('actual direct WSS captured application frames exercise receiver protections and fresh owner recovery', async () => {
  const { runNodeWireReplayQualification } = await import('../examples/wire-replay/consumer.mjs');
  const proof = await runNodeWireReplayQualification(new AbortController().signal);
  assert.equal(proof.result, 'pass'); assert.equal(proof.actualGenerations, 4); assert.equal(proof.tlsCiphertextReplay, false);
  assert.ok(proof.checks.length <= 32); assert.equal(proof.cleanup.nativeContexts, 0); assert.equal(proof.cleanup.pendingWrites, 0);
  assert.ok(proof.captureCount <= 32); assert.ok(proof.replayAttempts <= 64); assert.ok(proof.peakPendingNativeCallbacks <= 8);
  const baseline = proof.trials[0]; assert.ok(baseline);
  const expiry = baseline.grantExpiry; assert.ok(expiry);
  assert.ok(Math.abs(expiry.deadlineAfterStartMs - 700) <= Number.EPSILON * 8 * Math.max(1, Math.abs(expiry.deadlineAfterStartMs)));
  assert.equal(expiry.retirements.length, 3);
  assert.ok(expiry.deadlineAfterStartMs - expiry.lastConfirmedCurrentAfterStartMs <= 20);
  assert.ok(expiry.retirements.every(retired => retired.reason === 'expired' && retired.afterStartMs >= expiry.deadlineAfterStartMs));
});

test('software delay that retires incumbent routes cannot become a passing receiver boundary verdict', async () => {
  const { createNodeWireReplayFixture } = await import('../examples/wire-replay/consumer.mjs');
  const { runWireReplayQualification } = await import('../examples/wire-replay/wire-replay.ts');
  const owner = new AbortController(), sourceOwner = new AbortController(), sinkOwner = new AbortController();
  const fixture = await createNodeWireReplayFixture(owner.signal), pair = await fixture.open('baseline'); assert.ok(pair.sourcePeer); assert.ok(pair.receiverPeer);
  const boundary = pair.boundary(sourceOwner, sinkOwner), original = boundary.replay; let delayed = false;
  const reviewedDelay = { ...boundary, async replay(kind: Parameters<typeof original>[0], mutation: Parameters<typeof original>[1]) {
    if (mutation === 'expired-capture' && !delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 550)); }
    return original(kind, mutation);
  } };
  try {
    await assert.rejects(runWireReplayQualification({ sourcePeer: pair.sourcePeer, receiverPeer: pair.receiverPeer, epoch: pair.epoch, sourceOwnerSignal: sourceOwner.signal,
      sinkOwnerSignal: sinkOwner.signal, signal: owner.signal, now: () => performance.now(), boundary: reviewedDelay }), /incumbent routes retired/);
    assert.equal(delayed, true);
  } finally { owner.abort(); sourceOwner.abort(); sinkOwner.abort(); await pair.close(); assert.equal((await fixture.close()).nativeContexts, 0); }
});
