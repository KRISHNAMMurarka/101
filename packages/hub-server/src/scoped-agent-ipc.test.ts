import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import test from 'node:test';

const api = await import('./scoped-agent-ipc.ts').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return undefined;
});
test('the selected native agent IPC boundary exists', () => {
  assert.equal(typeof api?.createScopedAgentIpc, 'function', 'Real scoped-agent IPC implementation is required');
});

// These exercise an actual fixed child and actual Unix-domain socket; no fake
// replies or arbitrary producer/factory injection are part of this boundary.
if (api) {
  const { createScopedAgentIpc } = api;
  const signal = () => new AbortController();
  function setup(overrides: Partial<Parameters<typeof createScopedAgentIpc>[0]> = {}) {
    const owner = signal(), registration = signal(), read = signal();
    const observations: { pid: number; socketPath: string; epoch: number }[] = [];
    let registrations = 0, reads = 0;
    const controller = createScopedAgentIpc({ ownerId: 'owned-agent-operator', signal: owner.signal,
      authorizeRegistration(request) { registrations++; return { request, signal: registration.signal, expiresAt: performance.now() + 9000 }; },
      authorizeRead(request) { reads++; return { request, signal: read.signal, expiresAt: performance.now() + 9000 }; },
      onAgent(observation) { observations.push(observation); }, ...overrides });
    return { controller, owner, registration, read, observations, counts: () => ({ registrations, reads }) };
  }
  const delivery = () => ({ purpose: 'selected-process-rss', signal: signal().signal });
  async function unauthorized(socketPath: string, frame: unknown) {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `
      import net from 'node:net';
      const s=net.createConnection(process.argv[1]); let text='';
      s.on('connect',()=>s.end(process.argv[2]+'\\n'));
      s.on('data',c=>{text+=c;if(text.length>4096)process.exit(65)});
      s.on('end',()=>{process.stdout.write(text);});
      s.on('error',()=>process.exit(66));setTimeout(()=>process.exit(67),2000).unref();
    `, socketPath, JSON.stringify(frame)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise<number | null>(resolve => child.once('close', resolve));
    assert.equal(code, 0); assert.equal(errors, ''); return JSON.parse(output.trim());
  }
  test('construction is inert and denied registration starts no process', async () => {
    const h = setup({ authorizeRegistration: () => undefined });
    assert.equal(h.controller.status().starts, 0);
    assert.equal((await h.controller.start({ purpose: 'rss', version: 1 })).ok, false);
    assert.equal(h.observations.length, 0); assert.equal(h.controller.status().nativeChildren, 0); await h.controller.close();
  });
  test('actual private socket rejects separate missing/wrong capability and version before RSS acquisition', async () => {
    const h = setup();
    try {
      const started = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(started.ok);
      const observation = h.observations[0]!;
      assert.equal((await stat(observation.socketPath)).mode & 0o777, 0o600);
      for (const frame of [{ version: 1, epoch: observation.epoch, action: 'read-rss', id: 'foreign' },
        { version: 1, epoch: observation.epoch, action: 'read-rss', id: 'foreign', capability: 'wrong' },
        { version: 1, epoch: observation.epoch, action: 'read-rss', id: 'foreign', capability: 'é'.repeat(64) },
        { version: 2, epoch: observation.epoch, action: 'read-rss', id: 'foreign', capability: 'wrong' }]) {
        assert.deepEqual(await unauthorized(observation.socketPath, frame), { ok: false, reason: 'denied' });
      }
      const result = await h.controller.readRss(started.value, delivery()); assert.ok(result.ok);
      assert.equal(result.value.sequence, 1, 'native unauthorized callers performed zero memoryUsage reads');
      assert.ok(result.value.rssBytes > 0); assert.equal(result.value.sourceTime.clockId, `agent-rss:${observation.pid}:${observation.epoch}`);
      assert.equal(result.value.quality, 'valid'); assert.ok(result.value.sourceTime.at >= 0);
      assert.ok(result.value.receivedAt >= 0); assert.notEqual(result.value.receiptClockId, result.value.sourceTime.clockId);
    } finally { await h.controller.close(); }
    assert.equal(h.controller.status().nativeChildren, 0); assert.equal(h.controller.status().nativePending, 0);
  });
  test('declared version mismatch is checked against the actual native handshake', async () => {
    const h = setup(); try {
      const result = await h.controller.start({ purpose: 'rss', version: 2 }); assert.deepEqual(result, { ok: false, reason: 'version-mismatch' });
      assert.equal(h.controller.status().starts, 1); assert.equal(h.controller.status().reads, 0);
    } finally { await h.controller.close(); }
  });
  test('forged and foreign handles and closed signal approvals never dispatch a read', async () => {
    const h = setup(), other = setup();
    try {
      const start = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(start.ok);
      assert.equal((await other.controller.readRss(start.value, delivery())).ok, false);
      assert.equal((await h.controller.readRss(Object.freeze({}), delivery())).ok, false);
      h.read.abort(); assert.equal((await h.controller.readRss(start.value, delivery())).ok, false);
      assert.equal(h.controller.status().reads, 0);
    } finally { await h.controller.close(); await other.controller.close(); }
  });
  test('intrinsic AbortSignal branding rejects structural and shadowed authority', async () => {
    assert.throws(() => setup({ signal: { aborted: false, addEventListener() {} } as unknown as AbortSignal }), /Invalid agent IPC options/);
    const h = setup({ authorizeRead(request) { return { request, signal: { aborted: false } as AbortSignal, expiresAt: performance.now() + 1000 }; } });
    try { const start = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(start.ok);
      assert.equal((await h.controller.readRss(start.value, delivery())).ok, false); assert.equal(h.controller.status().reads, 0);
    } finally { await h.controller.close(); }
  });
  test('registration callback reentrancy cannot exceed one native start or survive stop', async () => {
    const owner = signal(), grant = signal(); let nested: Promise<unknown> | undefined;
    const controller = createScopedAgentIpc({ ownerId: 'operator', signal: owner.signal, authorizeRegistration(request) {
      nested = controller.start({ purpose: 'nested', version: 1 }); void controller.stop();
      return { request, signal: grant.signal, expiresAt: performance.now() + 1000 };
    }, authorizeRead: () => undefined });
    assert.equal((await controller.start({ purpose: 'rss', version: 1 })).ok, false);
    assert.deepEqual(await nested, { ok: false, reason: 'busy' }); assert.equal(controller.status().starts, 0); await controller.close();
  });
  test('read callback abort and observer cancellation fence actual native dispatch', async () => {
    const registration = signal(); const h = setup({ authorizeRead(request) { registration.abort(); return { request, signal: signal().signal, expiresAt: performance.now() + 1000 }; },
      authorizeRegistration(request) { return { request, signal: registration.signal, expiresAt: performance.now() + 9000 }; } });
    try { const start = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(start.ok);
      assert.equal((await h.controller.readRss(start.value, delivery())).ok, false); assert.equal(h.controller.status().reads, 0);
    } finally { await h.controller.close(); }
    const second = setup({ onAgent() { void second.controller.close(); } });
    assert.equal((await second.controller.start({ purpose: 'rss', version: 1 })).ok, false);
    await second.controller.close(); assert.equal(second.controller.status().nativeChildren, 0);
  });
  test('one raw native slot stays reserved through cancellation settlement', async () => {
    const h = setup(); const abort = signal();
    try { const start = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(start.ok);
      const first = h.controller.readRss(start.value, { purpose: 'rss', signal: abort.signal });
      assert.equal(h.controller.status().nativePending, 1); abort.abort();
      assert.equal(h.controller.status().nativePending, 1);
      assert.equal((await h.controller.start({ purpose: 'replacement', version: 1 })).ok, false);
      const result = await first; assert.equal(result.ok, false);
      assert.equal(h.controller.status().nativePending, 0); assert.equal(h.controller.status().nativeChildren, 0);
    } finally { await h.controller.close(); }
  });
  test('actual crash retires authority and replacement requires fresh registration; stale epoch cannot read it', async () => {
    const h = setup();
    try { const first = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(first.ok);
      process.kill(h.observations[0]!.pid, 'SIGKILL'); await h.controller.stop();
      const next = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(next.ok);
      assert.equal(h.counts().registrations, 2); assert.notEqual(h.observations[0]!.pid, h.observations[1]!.pid);
      assert.equal((await h.controller.readRss(first.value, delivery())).ok, false);
      const fresh = await h.controller.readRss(next.value, delivery()); assert.ok(fresh.ok); assert.equal(fresh.value.sequence, 1);
    } finally { await h.controller.close(); }
  });
  test('quiet registration expiry retires native authority and frees pending/timers', async () => {
    const h = setup({ authorizeRegistration(request) { return { request, signal: signal().signal, expiresAt: performance.now() + 150 }; } });
    try { const start = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(start.ok);
      await new Promise(resolve => setTimeout(resolve, 200)); await h.controller.stop();
      assert.equal((await h.controller.readRss(start.value, delivery())).ok, false);
      assert.equal(h.controller.status().nativeChildren, 0); assert.equal(h.controller.status().nativePending, 0); assert.equal(h.controller.status().timers, 0);
    } finally { await h.controller.close(); }
  });
  test('approval must preserve exact frozen request and narrow finite expiry', async () => {
    const h = setup({ authorizeRegistration(request) { assert.ok(Object.isFrozen(request));
      return { request: { ...request }, signal: signal().signal, expiresAt: Infinity }; } });
    assert.equal((await h.controller.start({ purpose: 'rss', version: 1 })).ok, false);
    assert.equal(h.controller.status().starts, 0); await h.controller.close();
  });
  test('retirement is reserved before thrown and reentrant callbacks and all raw work is awaited', async () => {
    let retired = 0, nested: Promise<unknown> | undefined;
    const h = setup({ onRetire(observed) {
      retired++; assert.equal(observed.epoch, h.observations[0]!.epoch);
      nested = h.controller.start({ purpose: 'reentrant-replacement', version: 1 }); void h.controller.stop();
      throw Error('private-retirement-error-sentinel');
    } });
    const started = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(started.ok);
    await h.controller.stop(); assert.equal(retired, 1); assert.deepEqual(await nested, { ok: false, reason: 'busy' });
    assert.equal(h.controller.status().cleanupVerified, true); assert.equal(h.controller.status().nativePending, 0); await h.controller.close();
    assert.equal(JSON.stringify(h.controller.status()).includes('sentinel'), false);
  });
  test('native operation and lifetime start quotas do not widen through fresh epochs', async () => {
    const h = setup();
    try {
      const started = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(started.ok);
      for (let i = 0; i < 32; i++) {
        const result = await h.controller.readRss(started.value, delivery()); assert.ok(result.ok); assert.equal(result.value.sequence, i + 1);
      }
      assert.deepEqual(await h.controller.readRss(started.value, delivery()), { ok: false, reason: 'quota' });
      await h.controller.stop();
      for (let i = 0; i < 2; i++) { assert.ok((await h.controller.start({ purpose: 'fresh', version: 1 })).ok); await h.controller.stop(); }
      assert.deepEqual(await h.controller.start({ purpose: 'over-limit', version: 1 }), { ok: false, reason: 'quota' });
      assert.equal(h.controller.status().starts, 3); assert.equal(h.controller.status().reads, 32);
    } finally { await h.controller.close(); }
  });
}
