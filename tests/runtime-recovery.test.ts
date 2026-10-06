import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { RuntimeRecoveryOptions, RecoveryImpairment } from '../examples/runtime-recovery/runtime-recovery.ts';

const root = resolve(import.meta.dirname, '..');
const publicNames = ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision', 'hub-server', 'pairing', 'protocol', 'input'];
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@101/connect/examples/secure-websocket') return next(pathToFileURL(join(root, 'examples/device-pipelines/secure-websocket.ts')).href, context);
  const name = specifier.startsWith('@101/') ? specifier.slice(5) : '';
  return next(publicNames.includes(name) ? pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href : specifier, context);
} });
test.after(() => hook.deregister());

test('actual direct TLS SDK producer effects and release need the selected combined recovery runner', async () => {
  const { runMissingFeatureProducerPrefix } = await import('../examples/runtime-recovery/consumer.mjs');
  const proof = await runMissingFeatureProducerPrefix(new AbortController().signal);
  assert.equal(proof.nativePrefix, 'pass'); assert.deepEqual(proof.actualReliableInvokeEdges, [true, false]); console.log(JSON.stringify(proof));
  let runner: { runRuntimeRecoveryQualification?: unknown } | undefined;
  try { const path = '../examples/runtime-recovery/runtime-recovery.ts'; runner = await import(path); } catch { /* The missing selected harness is the intended feature RED. */ }
  assert.equal(typeof runner?.runRuntimeRecoveryQualification, 'function', 'actual native producer works; selected recovery runner is missing');
});

test('fixed native path rejects copied signals and pre-aborted owners without issuing a listener', async () => {
  const { createNodeRecoveryPath } = await import('../examples/runtime-recovery/consumer.mjs');
  await assert.rejects(createNodeRecoveryPath('direct-wss', { aborted: false } as unknown as AbortSignal));
  const owner = new AbortController(); owner.abort(); Object.defineProperty(owner.signal, 'aborted', { value: false });
  await assert.rejects(createNodeRecoveryPath('direct-wss', owner.signal));
  const fresh = await createNodeRecoveryPath('direct-wss', new AbortController().signal);
  assert.equal(fresh.snapshot().nativeSockets, 0); assert.equal((await fresh.close()).nativeContexts, 0);
});

interface NativeFixtureSocket {
  readonly _isServer?: boolean;
  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void;
}
test('actual issued direct native write callback retains path reservation through logical cancellation', async () => {
  const { runMissingFeatureProducerPrefix, createNodeRecoveryPath } = await import('../examples/runtime-recovery/consumer.mjs');
  const ws = createRequire(import.meta.url)('ws') as { WebSocket: { prototype: NativeFixtureSocket } };
  const original = ws.WebSocket.prototype.send, owner = new AbortController(); let release: (() => void) | undefined, observed!: () => void;
  const held = new Promise<void>(resolve => { observed = resolve; }); let settled = false;
  ws.WebSocket.prototype.send = function (data, callback) {
    const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    if (!this._isServer && !release && bytes.includes(Buffer.from('"type":"event"'))) {
      original.call(this, data, error => { release = () => callback?.(error); owner.abort(); observed(); }); return;
    }
    original.call(this, data, callback);
  };
  const running = runMissingFeatureProducerPrefix(owner.signal).finally(() => { settled = true; }); void running.catch(() => {});
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([held, new Promise<void>((_resolve, reject) => { watchdog = setTimeout(() => reject(Error('Owned native callback fixture deadline')), 3000); })]);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false);
    await assert.rejects(createNodeRecoveryPath('direct-wss', new AbortController().signal), /already active/);
    release!(); release = undefined; await assert.rejects(running);
    const next = await createNodeRecoveryPath('direct-wss', new AbortController().signal); assert.equal((await next.close()).nativeContexts, 0);
  } finally { clearTimeout(watchdog); ws.WebSocket.prototype.send = original; release?.(); await running.catch(() => {}); }
});

test('actual enrolled peers reject an undefined required fixture method before taking native ownership', async () => {
  const { createNodeRecoveryPath } = await import('../examples/runtime-recovery/consumer.mjs');
  const { runRuntimeRecoveryQualification } = await import('../examples/runtime-recovery/runtime-recovery.ts');
  const { authenticatedPeerScope } = await import('@101/connect');
  const owner = new AbortController(), sourceOwner = new AbortController(), sinkOwner = new AbortController();
  const path = await createNodeRecoveryPath('direct-wss', owner.signal), pair = await path.open();
  assert.ok(pair.sourcePeer); assert.ok(pair.receiverPeer);
  try {
    const options: RuntimeRecoveryOptions = { sourcePeer: pair.sourcePeer, receiverPeer: pair.receiverPeer, epoch: pair.epoch,
      sourceOwnerSignal: sourceOwner.signal, sinkOwnerSignal: sinkOwner.signal, signal: owner.signal, now: () => performance.now(), mode: 'owner-revoke',
      impairment: { path: 'direct-wss', disconnect: () => pair.disconnect(), close: undefined,
        revokeOwner: () => sinkOwner.abort(), remember() {}, replayPrevious: () => false } as unknown as RecoveryImpairment };
    await assert.rejects(runRuntimeRecoveryQualification(options), /Recovery fixture invalid/);
    assert.equal(authenticatedPeerScope(pair.sourcePeer)?.epoch, pair.epoch); assert.equal(authenticatedPeerScope(pair.receiverPeer)?.epoch, pair.epoch);
  } finally { owner.abort(); sourceOwner.abort(); sinkOwner.abort(); await pair.close(); assert.equal((await path.close()).nativeContexts, 0); }
});

test('held host observer retains runner ownership through cancel and actual callback settlement', async () => {
  const { createNodeRecoveryPath } = await import('../examples/runtime-recovery/consumer.mjs');
  const { runRuntimeRecoveryQualification } = await import('../examples/runtime-recovery/runtime-recovery.ts');
  const owner = new AbortController(), sourceOwner = new AbortController(), sinkOwner = new AbortController();
  const path = await createNodeRecoveryPath('direct-wss', owner.signal), pair = await path.open();
  assert.ok(pair.sourcePeer); assert.ok(pair.receiverPeer);
  let entered!: () => void, resume!: () => void, settled = false;
  const observed = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { resume = resolve; });
  const options: RuntimeRecoveryOptions = { sourcePeer: pair.sourcePeer, receiverPeer: pair.receiverPeer, epoch: pair.epoch,
    sourceOwnerSignal: sourceOwner.signal, sinkOwnerSignal: sinkOwner.signal, signal: owner.signal, now: () => performance.now(), mode: 'owner-revoke',
    impairment: { path: 'direct-wss', disconnect: () => pair.disconnect(), close: () => pair.close(), revokeOwner: () => sinkOwner.abort(), remember() {}, replayPrevious: () => false,
      onStage(stage) { if (stage === 'selected') { entered(); return hold; } } } };
  const running = runRuntimeRecoveryQualification(options).finally(() => { settled = true; }); void running.catch(() => {});
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([observed, new Promise<void>((_resolve,reject) => { watchdog = setTimeout(() => reject(Error('Owned observer fixture deadline')), 3000); })]);
    owner.abort(); await pair.close(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false);
    await assert.rejects(runRuntimeRecoveryQualification(options), /already active/);
    resume(); await assert.rejects(running, /retired/); assert.equal((await path.close()).nativeContexts, 0);
  } finally { clearTimeout(watchdog); resume(); owner.abort(); sourceOwner.abort(); sinkOwner.abort(); await running.catch(() => {}); await pair.close(); await path.close(); }
});

test('actual peer provenance and final native owner signals survive neither copied peers nor a reentrant clock abort', async () => {
  const { createNodeRecoveryPath } = await import('../examples/runtime-recovery/consumer.mjs');
  const { runRuntimeRecoveryQualification } = await import('../examples/runtime-recovery/runtime-recovery.ts');
  const owner = new AbortController(), sourceOwner = new AbortController(), sinkOwner = new AbortController();
  const path = await createNodeRecoveryPath('direct-wss', owner.signal), pair = await path.open(); let closeCalls = 0;
  assert.ok(pair.sourcePeer); assert.ok(pair.receiverPeer);
  const options: RuntimeRecoveryOptions = { sourcePeer: pair.sourcePeer, receiverPeer: pair.receiverPeer, epoch: pair.epoch,
    sourceOwnerSignal: sourceOwner.signal, sinkOwnerSignal: sinkOwner.signal, signal: owner.signal, now: () => performance.now(), mode: 'owner-revoke',
    impairment: { path: 'direct-wss', disconnect: () => pair.disconnect(), async close() { closeCalls++; await pair.close(); },
      revokeOwner: () => sinkOwner.abort(), remember() {}, replayPrevious: () => false } };
  try {
    await assert.rejects(runRuntimeRecoveryQualification({ ...options, sourcePeer: { ...pair.sourcePeer } }), /actual current enrolled peers/);
    await assert.rejects(runRuntimeRecoveryQualification({ ...options, epoch: 'wrong-owned-epoch' }), /actual current enrolled peers/);
    const aborted = new AbortController(); aborted.abort(); Object.defineProperty(aborted.signal, 'aborted', { value: false });
    await assert.rejects(runRuntimeRecoveryQualification({ ...options, sinkOwnerSignal: aborted.signal }), /native owner signals/); assert.equal(closeCalls, 0);
    await assert.rejects(runRuntimeRecoveryQualification({ ...options, now() { sinkOwner.abort(); return performance.now(); } }), /retired/);
    assert.equal(closeCalls, 1);
  } finally { owner.abort(); sourceOwner.abort(); sinkOwner.abort(); await pair.close(); assert.equal((await path.close()).nativeContexts, 0); }
});
