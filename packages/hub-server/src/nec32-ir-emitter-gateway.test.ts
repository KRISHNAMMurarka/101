import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import readline from 'node:readline';
import {
  NEC32_IR_LIMITS,
  NEC32_IR_PROFILE,
  compileNec32IrFrame,
  createNec32IrEmitterGateway,
  type Nec32IrApprovalRequest,
  type Nec32IrEmitterProvider,
  type Nec32IrGrant,
} from './nec32-ir-emitter-gateway.ts';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const scope = { principalId: 'operator', applicationId: 'ir-test', sessionId: 'session-a' } as const;
const selectedEmitter = { id: 'software-emitter-a', profileId: 'app:nec-inverse-byte-command-one-shot/1',
  codebook: [{ codeId: 'fixture-34-a2', address: 0x34, command: 0xa2 }] } as const;
const operation = (signal = new AbortController().signal) => ({ operationId: crypto.randomUUID(), codeId: 'fixture-34-a2',
  purpose: 'test selected code', signal, deadline: performance.now() + 400 });

function provider(overrides: Partial<Nec32IrEmitterProvider> = {}) {
  let pending: Promise<void> = Promise.resolve(), stopCalls = 0, closeCalls = 0;
  const transmissions: Uint8Array[] = [];
  const value: Nec32IrEmitterProvider = {
    supported: true, carrierRanges: Object.freeze([{ minHz: 38000, maxHz: 38000 }]),
    open: async () => 'ready' as const,
    transmit(envelope) { transmissions.push(new Uint8Array(envelope)); return 'completed'; },
    stop() { stopCalls++; }, close() { closeCalls++; }, whenSettled() { return pending; }, ...overrides,
  };
  return { value, transmissions, stopCalls: () => stopCalls, closeCalls: () => closeCalls,
    setPending(next: Promise<void>) { pending = next; } };
}

function fixture(p = provider(), hooks: { control?: (request: Nec32IrApprovalRequest) => Nec32IrGrant | undefined;
  emission?: (request: Nec32IrApprovalRequest) => Nec32IrGrant | undefined } = {}) {
  const owner = new AbortController(), control = new AbortController(), emission = new AbortController();
  const approvals: Nec32IrApprovalRequest[] = [];
  const gateway = createNec32IrEmitterGateway({ ownerSignal: owner.signal, scope, selectedEmitter, selectedProvider: p.value,
    authorizeEmitter(request) { approvals.push(request); return hooks.control ? hooks.control(request) :
      { request, signal: control.signal, expiresAt: performance.now() + 4000 }; },
    authorizeEmission(request) { approvals.push(request); return hooks.emission ? hooks.emission(request) :
      { request, signal: emission.signal, expiresAt: performance.now() + 4000 }; } });
  return { gateway, owner, control, emission, approvals, provider: p };
}

test('the selected NEC32 compiler produces the reviewed fixed envelope and no repeat frame', () => {
  const compiled = compileNec32IrFrame(0x34, 0xa2);
  assert.equal(NEC32_IR_PROFILE.id, selectedEmitter.profileId);
  assert.deepEqual([...compiled.frame], [0x34, 0xcb, 0xa2, 0x5d]);
  assert.equal(compiled.timings.length, 67); assert.equal(compiled.totalMicros, 68060);
  assert.equal(compiled.envelope.length, 282);
  assert.equal(digest(compiled.envelope), '334f1028fb8488a2ca7f43d27b75c4a2a0d762509740bb5a00f1472f78205f8e');
});

test('construction is inert and denial performs no provider callout', async () => {
  let open = 0; const p = provider({ open() { open++; return 'ready'; } });
  const owner = new AbortController(); let authority = 0;
  const gateway = createNec32IrEmitterGateway({ ownerSignal: owner.signal, scope, selectedEmitter, selectedProvider: p.value,
    authorizeEmitter() { authority++; return undefined; }, authorizeEmission: () => undefined });
  assert.equal(authority, 0); assert.equal(open, 0);
  assert.deepEqual(await gateway.start({ purpose: 'activate selected emitter', deadline: performance.now() + 500 }), { ok: false, reason: 'denied' });
  assert.equal(authority, 1); assert.equal(open, 0); await gateway.close();
});

test('emission uses one allowlisted code, a fresh exact grant, and conservative evidence', async () => {
  const value = fixture(); const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 }); assert.ok(started.ok);
  const emitted = await value.gateway.emit(started.value, operation()); assert.ok(emitted.ok);
  assert.equal(value.provider.transmissions.length, 1); assert.equal(digest(value.provider.transmissions[0]!), emitted.value.frameSha256);
  assert.deepEqual({ evidence: emitted.value.evidence, effect: emitted.value.effect, physicalCarrier: emitted.value.physicalCarrier,
    targetAcknowledgement: emitted.value.targetAcknowledgement, observedState: emitted.value.observedState },
  { evidence: 'provider-completed', effect: 'dispatched', physicalCarrier: 'unverified', targetAcknowledgement: false, observedState: false });
  assert.deepEqual(value.approvals.map(item => item.action), ['activate-emitter', 'emit-code']);
  assert.equal(value.approvals[1]!.frameSha256, '334f1028fb8488a2ca7f43d27b75c4a2a0d762509740bb5a00f1472f78205f8e');
  await value.gateway.close();
});

test('unknown codes, replayed operation IDs, extra fields, and already-aborted callers never transmit', async () => {
  const value = fixture(); const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 }); assert.ok(started.ok);
  assert.deepEqual(await value.gateway.emit(started.value, { ...operation(), codeId: 'unknown' }), { ok: false, reason: 'invalid' });
  const request = operation(); assert.ok((await value.gateway.emit(started.value, request)).ok);
  assert.deepEqual(await value.gateway.emit(started.value, request), { ok: false, reason: 'replay' });
  assert.deepEqual(await value.gateway.emit(started.value, { ...operation(), repeat: 1 } as never), { ok: false, reason: 'invalid' });
  const cancelled = new AbortController(); cancelled.abort(); const approvals = value.approvals.length;
  assert.deepEqual(await value.gateway.emit(started.value, operation(cancelled.signal)), { ok: false, reason: 'cancelled' });
  assert.equal(value.approvals.length, approvals); assert.equal(value.provider.transmissions.length, 1); await value.gateway.close();
});

test('reentrant Stop fences every authority and provider callout', async () => {
  const p = provider();
  const owner = new AbortController(), grant = new AbortController();
  const gateway: ReturnType<typeof createNec32IrEmitterGateway> = createNec32IrEmitterGateway({ ownerSignal: owner.signal, scope, selectedEmitter, selectedProvider: p.value,
    authorizeEmitter(request) { void gateway.stop(); return { request, signal: grant.signal, expiresAt: performance.now() + 1000 }; },
    authorizeEmission: () => undefined });
  assert.deepEqual(await gateway.start({ purpose: 'activate', deadline: performance.now() + 400 }), { ok: false, reason: 'denied' });
  assert.equal(p.transmissions.length, 0); await gateway.close();
});

test('exact provider identity is exclusively owned across gateway instances until Stop settles', async () => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const shared = provider(); shared.setPending(held);
  const first = fixture(shared), second = fixture({ ...shared, value: shared.value });
  const started = await first.gateway.start({ purpose: 'first', deadline: performance.now() + 400 }); assert.ok(started.ok);
  assert.deepEqual(await second.gateway.start({ purpose: 'second', deadline: performance.now() + 400 }), { ok: false, reason: 'busy' });
  const stopping = first.gateway.stop(); let stopped = false; void stopping.then(() => { stopped = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  assert.deepEqual(await second.gateway.start({ purpose: 'second', deadline: performance.now() + 400 }), { ok: false, reason: 'busy' });
  release(); await stopping; assert.ok((await second.gateway.start({ purpose: 'second', deadline: performance.now() + 400 })).ok);
  await first.gateway.close(); await second.gateway.close();
});

for (const hook of ['stop', 'close', 'whenSettled'] as const) {
  for (const action of ['stop', 'close'] as const) {
    test(`reentrant provider ${hook}/${action} joins one retirement and retains exact ownership`, async () => {
      let release!: () => void, reentered = false, stops = 0, closes = 0;
      const held = new Promise<void>(resolve => { release = resolve; });
      const reenter = () => {
        if (reentered) return;
        reentered = true;
        void gateway[action]();
      };
      const shared = provider({
        stop() { stops++; if (hook === 'stop') reenter(); },
        close() { closes++; if (hook === 'close') reenter(); },
        whenSettled() { if (hook === 'whenSettled') reenter(); return held; },
      });
      const first = fixture(shared), second = fixture({ ...shared, value: shared.value });
      const gateway: ReturnType<typeof createNec32IrEmitterGateway> = first.gateway;
      try {
        assert.ok((await gateway.start({ purpose: 'first', deadline: performance.now() + 400 })).ok);
        const stopping = gateway.stop();
        let stopped = false;
        void stopping.then(() => { stopped = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(stopped, false);
        assert.equal(stops, 1);
        assert.equal(closes, 0);
        assert.deepEqual(await second.gateway.start({ purpose: 'second', deadline: performance.now() + 400 }),
          { ok: false, reason: 'busy' });
        release(); await stopping; await gateway.close();
        assert.equal(closes, 1, 'Reentrant retirement must close its exact provider once');
        assert.ok((await second.gateway.start({ purpose: 'second', deadline: performance.now() + 400 })).ok);
        await gateway.close();
        assert.equal(closes, 1, 'Former-owner close must not touch the replacement');
        await second.gateway.close();
        assert.equal(closes, 2, 'Each actual owner closes its own session once');
      } finally {
        release(); await gateway.close(); await second.gateway.close();
      }
    });
  }
}

test('synchronous effectful open fault still invokes previously captured cleanup and joins settlement', async () => {
  let release!: () => void, effect = false, closes = 0; const held = new Promise<void>(resolve => { release = resolve; });
  const p = provider({ open() { effect = true; throw new Error('fault after acquisition'); }, close() { closes++; effect = false; } }); p.setPending(held);
  const value = fixture(p); const starting = value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(effect, true); assert.equal(p.stopCalls(), 1);
  let settled = false; void starting.then(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(); assert.deepEqual(await starting, { ok: false, reason: 'provider', issued: true }); assert.equal(closes, 1); assert.equal(effect, false);
  await value.gateway.close(); assert.equal(closes, 1);
});

test('Stop aborts and joins an issued transmit, with the outcome remaining uncertain', async () => {
  let entered!: () => void, release!: () => void; const transmitting = new Promise<void>(resolve => { entered = resolve; });
  const p = provider({ transmit() { entered(); return new Promise(resolve => { release = () => resolve('completed'); }); } });
  const value = fixture(p); const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 }); assert.ok(started.ok);
  const emitting = value.gateway.emit(started.value, operation()); await transmitting; const stopping = value.gateway.stop();
  let stopped = false; void stopping.then(() => { stopped = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release(); await stopping; assert.deepEqual(await emitting, { ok: false, reason: 'cancelled', issued: true, emission: 'uncertain' });
  await value.gateway.close();
});

test('synchronous effectful transmit fault invokes captured cleanup and keeps the raw slot through settlement', async () => {
  let release!: () => void, effect = false; const held = new Promise<void>(resolve => { release = resolve; });
  const p = provider({ transmit() { effect = true; throw new Error('fault after emission may have begun'); } }); p.setPending(held);
  const value = fixture(p); const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 }); assert.ok(started.ok);
  const emitting = value.gateway.emit(started.value, operation()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(effect, true); assert.equal(p.stopCalls(), 1); assert.equal(value.gateway.status().rawPending, 1);
  let settled = false; void emitting.then(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(); assert.deepEqual(await emitting, { ok: false, reason: 'provider', issued: true, emission: 'uncertain' });
  assert.equal(value.gateway.status().rawPending, 0); await value.gateway.close();
});

test('grant expiry clamps live provider work and completion after expiry is not delivered', async () => {
  let release!: () => void; const p = provider({ transmit() { return new Promise(resolve => { release = () => resolve('completed'); }); } });
  const value = fixture(p, { emission(request) { return { request, signal: value.emission.signal, expiresAt: performance.now() + 25 }; } });
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 }); assert.ok(started.ok);
  const emitted = value.gateway.emit(started.value, { ...operation(), deadline: performance.now() + 400 });
  await new Promise(resolve => setTimeout(resolve, 40)); release();
  assert.deepEqual(await emitted, { ok: false, reason: 'expired', issued: true, emission: 'uncertain' }); await value.gateway.close();
});

test('operation deadline actively stops a provider that ignores its AbortSignal', async () => {
  let finish: ((value: 'rejected') => void) | undefined, stops = 0;
  const p = provider({ transmit() { return new Promise(resolve => { finish = resolve; }); }, stop() { stops++; finish?.('rejected'); } });
  const value = fixture(p); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 }); assert.ok(started.ok);
    const request = operation(); const emitting = value.gateway.emit(started.value, { ...request, deadline: performance.now() + 30 });
    const result = await Promise.race([emitting, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline did not stop provider')), 300); })]);
    assert.deepEqual(result, { ok: false, reason: 'expired', issued: true, emission: 'uncertain' }); assert.equal(stops, 1);
  } finally { clearTimeout(timer); await value.gateway.close(); }
});

test('limits expose one raw operation and a conservative fixed minimum interval', () => {
  assert.equal(NEC32_IR_LIMITS.rawOperations, 1); assert.equal(NEC32_IR_LIMITS.minimumIntervalMs, 108);
});

test('only the exact provider owner may close, including after ownership transfers', async () => {
  let opened = false, closes = 0;
  const p = provider({ open() { opened = true; return 'ready'; }, transmit() { return opened ? 'completed' : 'unavailable'; },
    close() { closes++; opened = false; } });
  const first = fixture(p), neverOwner = fixture(p), next = fixture(p);
  const firstEpoch = await first.gateway.start({ purpose: 'first', deadline: performance.now() + 400 }); assert.ok(firstEpoch.ok);
  await neverOwner.gateway.close(); assert.equal(closes, 0); assert.ok((await first.gateway.emit(firstEpoch.value, operation())).ok);
  await first.gateway.stop(); const nextEpoch = await next.gateway.start({ purpose: 'next', deadline: performance.now() + 400 }); assert.ok(nextEpoch.ok);
  await first.gateway.close(); assert.equal(closes, 1); assert.ok((await next.gateway.emit(nextEpoch.value, operation())).ok);
  await next.gateway.close(); assert.equal(closes, 2);
});

test('denied attempts and replay records remain bounded across Stop and restart', async () => {
  const p = provider(); let authorizations = 0; const value = fixture(p, { emission() { authorizations++; return undefined; } });
  let started = await value.gateway.start({ purpose: 'first', deadline: performance.now() + 400 }); assert.ok(started.ok);
  for (let index = 0; index < 8; index++) assert.deepEqual(await value.gateway.emit(started.value, { ...operation(), operationId: `denied-a-${index}` }), { ok: false, reason: 'denied' });
  await value.gateway.stop(); started = await value.gateway.start({ purpose: 'second', deadline: performance.now() + 400 }); assert.ok(started.ok);
  for (let index = 0; index < 8; index++) assert.deepEqual(await value.gateway.emit(started.value, { ...operation(), operationId: `denied-b-${index}` }), { ok: false, reason: 'denied' });
  assert.deepEqual(await value.gateway.emit(started.value, { ...operation(), operationId: 'denied-seventeenth' }), { ok: false, reason: 'quota' });
  assert.equal(authorizations, 16); assert.deepEqual(value.gateway.status(), { phase: 'ready', starts: 2, emissions: 0,
    emissionAttempts: 16, retainedRecords: 16, rawPending: 0 }); await value.gateway.close();
});

test('duplicate address and command pairs are rejected even under distinct code IDs', () => {
  const p = provider(), owner = new AbortController();
  assert.throws(() => createNec32IrEmitterGateway({ ownerSignal: owner.signal, scope, selectedProvider: p.value,
    selectedEmitter: { ...selectedEmitter, codebook: [{ codeId: 'one', address: 1, command: 2 }, { codeId: 'two', address: 1, command: 2 }] },
    authorizeEmitter: () => undefined, authorizeEmission: () => undefined }));
});

test('close removes only its exact owner abort listener', async () => {
  const value = fixture(); const unrelated = () => {}; value.owner.signal.addEventListener('abort', unrelated);
  assert.equal(getEventListeners(value.owner.signal, 'abort').length, 2); await value.gateway.close();
  assert.deepEqual(getEventListeners(value.owner.signal, 'abort'), [unrelated]); value.owner.signal.removeEventListener('abort', unrelated);
});

test('software child rejects a valid frame from a retired generation and token', async () => {
  const startupEnvironment = process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: `0x${process.getuid!().toString(16).toUpperCase()}:0:0` } : {};
  const child = spawn(process.execPath, [new URL('../../../examples/ir-emitter/software-emitter.mjs', import.meta.url).pathname],
    { env: { NODE_ENV: 'production', ...startupEnvironment }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity }); const messages: Record<string, unknown>[] = [];
  lines.on('line', line => messages.push(JSON.parse(line)));
  const wait = async (predicate: (value: Record<string, unknown>) => boolean) => {
    for (let turn = 0; turn < 100; turn++) { const found = messages.find(predicate); if (found) return found; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('child response deadline');
  };
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`); const closed = new Promise(resolve => child.once('close', resolve));
  const token1 = randomBytes(16).toString('hex'), token2 = randomBytes(16).toString('hex');
  try {
    await wait(value => value.type === 'hello'); send({ type: 'open', generation: 1, token: token1, deadline: performance.now() + 400 });
    await wait(value => value.type === 'ready' && value.token === token1); send({ type: 'stop', generation: 1, token: token1 });
    await wait(value => value.type === 'stopped' && value.token === token1); send({ type: 'open', generation: 2, token: token2, deadline: performance.now() + 400 });
    await wait(value => value.type === 'ready' && value.token === token2); const compiled = compileNec32IrFrame(0x34, 0xa2);
    send({ type: 'emit', generation: 1, token: token1, operationId: 'stale-generation', deadline: performance.now() + 400,
      envelope: Buffer.from(compiled.envelope).toString('base64'), sha256: compiled.envelopeSha256 });
    assert.equal((await wait(value => value.operationId === 'stale-generation')).type, 'rejected'); send({ type: 'close' });
    await wait(value => value.type === 'closed'); await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed; lines.close();
  }
});
