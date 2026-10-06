import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('./hosted-application.ts').catch(() => undefined);
test('hosted execution needs a reviewed native provider rather than application metadata', () => {
  assert.equal(typeof api?.createHostedApplication, 'function', 'Missing genuine owned hosted application provider');
});

import { createConnection } from 'node:net';
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createWorkloadHandoff } from '@101/device-runtime';
import type { DeliveryContext, HandoffEpoch } from '@101/device-runtime';
import type { HostedApplicationOptions, HostedApplicationApprovalRequest, HostedApplicationEpoch } from './hosted-application.ts';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { const end = performance.now() + 2500; while (!check()) { assert.ok(performance.now() < end); await pause(5); } }
function fixture(providerId = 'host-a', customize: Partial<HostedApplicationOptions> = {}) {
  const owner = new AbortController(), grants = new Map<string, AbortController>(), scopes: HostedApplicationApprovalRequest[] = [], observations: { pid: number; socketPath: string; epoch: number }[] = [];
  const provider = api!.createHostedApplication({ ownerId: 'owner', providerId, applicationId: 'raster-app', sessionId: 'owned-session', signal: owner.signal,
    authorize(request) { scopes.push(request); const grant = new AbortController(); grants.set(request.action, grant); return { request, signal: grant.signal, expiresAt: performance.now() + 9000 }; },
    onChild(observation) { observations.push(observation); }, ...customize });
  const selected = api!.hostedApplicationRequirements(providerId);
  const handoff = createWorkloadHandoff({ ...selected, source: provider.handoffHost(), validateState: state => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    return Object.keys(state).length === 3 && Number.isInteger(state.x) && Number.isInteger(state.y) && Number.isInteger(state.revision);
  } });
  return { provider, owner, grants, scopes, observations, handoff };
}
async function active(selected: ReturnType<typeof fixture>) {
  const result = await selected.provider.start({ purpose: 'explicit-launch', version: 1 }); assert.ok(result.ok);
  await selected.provider.handoffHost().resume(selected.handoff.authority()); return result.value;
}
function context(signal = new AbortController().signal): DeliveryContext {
  return { signal, routeId: 'input-route', generation: 1, isCurrent: () => !signal.aborted, reportEvidence() {} };
}
async function raw(path: string, frame: unknown) {
  const socket = createConnection(path), chunks: Buffer[] = [];
  socket.on('error', () => {}); socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  socket.once('connect', () => socket.end(JSON.stringify(frame) + '\n')); await closed;
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('constructor is inert and a denied launch creates no child or socket', async () => {
  assert.ok(api); const selected = fixture('denied', { authorize: () => undefined });
  try { assert.equal(selected.provider.status().nativeChildren, 0); assert.deepEqual(await selected.provider.start({ purpose: 'launch', version: 1 }), { ok: false, reason: 'denied' }); assert.equal(selected.observations.length, 0); }
  finally { await selected.provider.close(); assert.equal(selected.provider.status().cleanupVerified, true); }
});

test('actual separate child accepts only authenticated current input and renders changed native pixel bytes', async () => {
  assert.ok(api); const selected = fixture();
  try {
    const epoch = await active(selected), observed = selected.observations[0]!;
    assert.notEqual(observed.pid, process.pid); assert.equal(statSync(observed.socketPath).mode & 0o777, 0o600); assert.equal(statSync(observed.socketPath.slice(0, -2)).mode & 0o777, 0o700);
    const first = await selected.provider.frame(epoch, { purpose: 'view', signal: selected.owner.signal }); assert.ok(first.ok);
    const denied = await raw(observed.socketPath, { version: 1, epoch: observed.epoch, id: 'a'.repeat(32), capability: '0'.repeat(64), action: 'input', target: { x: 3, y: 2 } }); assert.equal(denied.ok, false);
    const wrongVersion = await raw(observed.socketPath, { version: 2, epoch: observed.epoch, id: 'a'.repeat(32), capability: '0'.repeat(64), action: 'frame' }); assert.equal(wrongVersion.ok, false);
    const accepted = await selected.provider.input(epoch, { x: 3, y: 2 }, { purpose: 'move', signal: selected.owner.signal, context: context() }); assert.ok(accepted.ok);
    const second = await selected.provider.frame(epoch, { purpose: 'view', signal: selected.owner.signal }); assert.ok(second.ok);
    assert.equal(second.value.state.x, 3); assert.equal(second.value.state.y, 2); assert.equal(second.value.state.revision, 1);
    assert.equal(second.value.pixels.length, 64); assert.notEqual(createHash('sha256').update(Buffer.from(first.value.pixels)).digest('hex'), createHash('sha256').update(Buffer.from(second.value.pixels)).digest('hex'));
    assert.equal(second.value.sourceTime.clockId, `hosted-raster:${observed.pid}:${observed.epoch}`); assert.equal(second.value.quality, 'valid'); assert.ok(Number.isFinite(second.value.receivedAt)); assert.ok(second.value.sourceTime.at >= 0);
    assert.notEqual(second.value.receiptClockId, second.value.sourceTime.clockId); assert.ok(Object.isFrozen(second.value.pixels));
  } finally { await selected.provider.close(); assert.equal(selected.provider.status().cleanupVerified, true); for (const observation of selected.observations) assert.equal(existsSync(observation.socketPath.slice(0, -2)), false); }
});

test('input approval cannot establish frame approval and expired retained bytes are unavailable', async () => {
  assert.ok(api); let allowFrame = false;
  const selected = fixture('scoped', { authorize(request) { if (request.action === 'frame' && !allowFrame) return; return { request, signal: selected.owner.signal, expiresAt: performance.now() + 9000 }; } });
  try {
    const epoch = await active(selected); assert.ok((await selected.provider.input(epoch, { x: 1, y: 1 }, { purpose: 'move', signal: selected.owner.signal, context: context() })).ok);
    assert.deepEqual(await selected.provider.frame(epoch, { purpose: 'view', signal: selected.owner.signal }), { ok: false, reason: 'denied' });
    allowFrame = true; assert.ok((await selected.provider.frame(epoch, { purpose: 'view', signal: selected.owner.signal })).ok); assert.ok(selected.provider.currentFrame(epoch));
    await pause(260); assert.equal(selected.provider.currentFrame(epoch), undefined);
  } finally { await selected.provider.close(); }
});

test('authorization reentry retains one raw reservation and cancel before dispatch performs no input', async () => {
  assert.ok(api); let nested: Promise<unknown> | undefined, revoke = false, epoch: HostedApplicationEpoch;
  const selected = fixture('reentry', { authorize(request) {
    if (request.action === 'input') { nested = selected.provider.frame(epoch, { purpose: 'nested', signal: selected.owner.signal }); if (revoke) selected.owner.abort(); }
    return { request, signal: selected.owner.signal, expiresAt: performance.now() + 9000 };
  } });
  try {
    epoch = await active(selected); revoke = true;
    const result = await selected.provider.input(epoch, { x: 2, y: 2 }, { purpose: 'move', signal: selected.owner.signal, context: context() }); assert.equal(result.ok, false);
    assert.deepEqual(await nested, { ok: false, reason: 'busy' }); assert.equal(selected.provider.status().inputs, 0);
  } finally { await selected.provider.close(); assert.equal(selected.provider.status().cleanupVerified, true); }
});

test('foreign handles, accessors and forged signals fail without native input', async () => {
  assert.ok(api); const selected = fixture('invalid'); let getters = 0;
  try {
    const epoch = await active(selected);
    assert.equal((await selected.provider.frame(Object.freeze({}), { purpose: 'view', signal: selected.owner.signal })).ok, false);
    assert.equal((await selected.provider.input(epoch, { get x() { getters++; return 1; }, y: 1 }, { purpose: 'move', signal: selected.owner.signal, context: context() })).ok, false);
    assert.equal((await selected.provider.frame(epoch, { purpose: 'view', signal: Object.create(AbortSignal.prototype) })).ok, false); assert.equal(getters, 0); assert.equal(selected.provider.status().inputs, 0);
  } finally { await selected.provider.close(); }
});

test('two real child hosts hand off exact snapshot state after old native settlement', async () => {
  assert.ok(api); const source = fixture('host-a'), target = fixture('host-b');
  try {
    const old = await active(source); assert.ok((await source.provider.input(old, { x: 2, y: 3 }, { purpose: 'move', signal: source.owner.signal, context: context() })).ok);
    const oldToken = source.handoff.authority(), result = await source.handoff.transfer(target.provider.handoffHost()); assert.ok(result.ok);
    assert.equal(source.provider.status().nativeChildren, 0); assert.equal(oldToken.signal.aborted, true); assert.equal(source.provider.currentFrame(old), undefined);
    const next = target.provider.epoch(); assert.ok(next); const frame = await target.provider.frame(next, { purpose: 'view', signal: target.owner.signal }); assert.ok(frame.ok); assert.deepEqual(frame.value.state, { x: 2, y: 3, revision: 1 });
    assert.notEqual(source.observations[0]!.pid, target.observations[0]!.pid);
    assert.equal((await source.provider.input(old, { x: 0, y: 0 }, { purpose: 'stale', signal: source.owner.signal, context: context() })).ok, false);
  } finally { await source.provider.close(); await target.provider.close(); assert.equal(source.provider.status().cleanupVerified, true); assert.equal(target.provider.status().cleanupVerified, true); }
});

test('native crash retires old authority and a replacement needs fresh launch and resume grants', async () => {
  assert.ok(api); const selected = fixture('crash');
  try {
    const old = await active(selected); process.kill(selected.observations[0]!.pid, 'SIGKILL'); await until(() => selected.provider.status().phase === 'idle');
    assert.equal((await selected.provider.frame(old, { purpose: 'stale', signal: selected.owner.signal })).ok, false);
    const replacement = await active(selected); assert.notEqual(replacement, old); assert.equal(selected.scopes.filter(scope => scope.action === 'launch').length, 2);
    assert.ok((await selected.provider.frame(replacement, { purpose: 'view', signal: selected.owner.signal })).ok);
  } finally { await selected.provider.close(); }
});

test('late reentrant DeliveryContext cancellation fences dispatch and releases native ownership', async () => {
  assert.ok(api); const selected = fixture('context');
  try {
    const epoch = await active(selected), delivery = context(); delivery.isCurrent = () => { selected.owner.abort(); return true; };
    assert.equal((await selected.provider.input(epoch, { x: 1, y: 2 }, { purpose: 'move', signal: selected.owner.signal, context: delivery })).ok, false); assert.equal(selected.provider.status().inputs, 0);
  } finally { await selected.provider.close(); assert.equal(selected.provider.status().cleanupVerified, true); }
});

test('a reentrant handoff currentness callback cannot relaunch after Stop', async () => {
  assert.ok(api); const selected = fixture('resume-reentry'), authority = new AbortController();
  const token: HandoffEpoch = Object.freeze({ hostId: 'resume-reentry', epoch: 1, signal: authority.signal,
    isCurrent() { void selected.provider.stop(); return true; } });
  try {
    await assert.rejects(async () => { await selected.provider.handoffHost().resume(token); }, /Application unavailable/);
    assert.equal(selected.provider.status().starts, 0, 'Stop from currentness callback must fence fresh native creation');
  } finally { await selected.provider.close(); assert.equal(selected.provider.status().cleanupVerified, true); }
});

test('cancellation during target launch settles the late child and cannot leave staged authority', async () => {
  assert.ok(api); const targetOwner = new AbortController(); let cancel!: () => void;
  const source = fixture('source-cancel'), target = fixture('target-cancel', {
    authorize(request) { if (request.action === 'launch') queueMicrotask(() => cancel()); return { request, signal: targetOwner.signal, expiresAt: performance.now() + 9000 }; },
  });
  try {
    await active(source); cancel = () => { source.handoff.cancel(); };
    assert.equal((await source.handoff.transfer(target.provider.handoffHost())).ok, false);
    await until(() => target.provider.status().phase !== 'starting');
    assert.equal(target.provider.status().nativeChildren, 0); assert.equal(target.provider.status().cleanupVerified, true);
    assert.equal(source.handoff.status().hostId, 'source-cancel');
  } finally { await source.provider.close(); await target.provider.close(); }
});

test('missing source capture after genuine child loss cannot claim cold restart as recovered state', async () => {
  assert.ok(api); const source = fixture('lost-source'), target = fixture('lost-target');
  try {
    const epoch = await active(source); assert.ok((await source.provider.input(epoch, { x: 3, y: 3 }, { purpose: 'move', signal: source.owner.signal, context: context() })).ok);
    process.kill(source.observations[0]!.pid, 'SIGKILL'); await until(() => source.provider.status().phase === 'idle');
    assert.deepEqual(await source.handoff.transfer(target.provider.handoffHost()), { ok: false, reason: 'recovery-failed', recovered: false });
    assert.equal(source.provider.status().starts, 1); assert.equal(target.provider.status().starts, 0); assert.equal(source.handoff.status().state, 'paused');
  } finally { await source.provider.close(); await target.provider.close(); }
});

test('a genuinely suspended native child hits the unchanged deadline and closes before raw release', async () => {
  assert.ok(api); const selected = fixture('deadline');
  try {
    const epoch = await active(selected); process.kill(selected.observations[0]!.pid, 'SIGSTOP'); const at = performance.now();
    const result = await selected.provider.frame(epoch, { purpose: 'frame', signal: selected.owner.signal });
    assert.deepEqual(result, { ok: false, reason: 'expired' }); assert.ok(performance.now() - at < 3500);
    assert.equal(selected.provider.status().nativePending, 0); assert.equal(selected.provider.status().nativeChildren, 0); assert.equal(selected.provider.status().cleanupVerified, true);
  } finally { await selected.provider.close(); }
});

import { parseSignalValue } from '@101/device-model';
test('frame declarations require exact observed bounded clocks without executing clock accessors', () => {
  assert.ok(api); let getters = 0;
  assert.equal(api.hostedApplicationRequirements('inert').frameValue, undefined);
  assert.throws(() => api.hostedApplicationRequirements('inert', { get sourceClockId() { getters++; return 'hosted-raster:1:1'; }, receiptClockId: 'hosted-receipt:1:0123456789abcdef' }), /Invalid hosted application clocks/);
  assert.throws(() => api.hostedApplicationRequirements('inert', { sourceClockId: 'hosted-raster:1:65', receiptClockId: 'hosted-receipt:1:0123456789abcdef' }), /Invalid hosted application clocks/);
  assert.equal(getters, 0);
});
test('denied launch attempts preserve their real epoch in later valid native frame declarations', async () => {
  assert.ok(api); let allow = false;
  const selected = fixture('epoch-bounds', { authorize(request) { if (!allow) return; return { request, signal: selected.owner.signal, expiresAt: performance.now() + 9000 }; } });
  try {
    for (let index = 0; index < 4; index++) assert.equal((await selected.provider.start({ purpose: 'deny', version: 1 })).ok, false);
    allow = true; const epoch = await active(selected), result = await selected.provider.frame(epoch, { purpose: 'frame', signal: selected.owner.signal }); assert.ok(result.ok); assert.equal(result.value.providerEpoch, 5);
    const { state: _state, ...projection } = result.value; void _state;
    const definition = api.hostedApplicationRequirements('epoch-bounds', { sourceClockId: result.value.sourceTime.clockId, receiptClockId: result.value.receiptClockId }); assert.ok(definition.frameValue);
    assert.deepEqual(parseSignalValue(projection, definition.frameValue), projection);
    assert.throws(() => parseSignalValue({ ...projection, sourceTime: { ...projection.sourceTime, clockId: 'hosted-raster:1:1' } }, definition.frameValue!), /enum-value/);
  } finally { await selected.provider.close(); }
});
