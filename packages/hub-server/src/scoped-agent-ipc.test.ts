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
  const { createScopedAgentIpc, SCOPED_AGENT_IPC_LIMITS } = api;
  const signal = () => new AbortController();
  function setup(overrides: Partial<Parameters<typeof createScopedAgentIpc>[0]> = {}) {
    const owner = signal(), registration = signal(), read = signal();
    const observations: { pid: number; socketPath: string; epoch: number }[] = [];
    let registrations = 0, reads = 0;
    const milestones: { registrationApprovedAt?: number; registrationExpiresAt?: number; readyAt?: number; retiredAt?: number } = {};
    const controller = createScopedAgentIpc({ ownerId: 'owned-agent-operator', signal: owner.signal,
      authorizeRegistration(request) { registrations++; const at = performance.now();
        milestones.registrationApprovedAt = at; milestones.registrationExpiresAt = at + 9000;
        return { request, signal: registration.signal, expiresAt: at + 9000 }; },
      authorizeRead(request) { reads++; return { request, signal: read.signal, expiresAt: performance.now() + 9000 }; },
      onAgent(observation) { milestones.readyAt = performance.now(); observations.push(observation); },
      onRetire() { milestones.retiredAt = performance.now(); }, ...overrides });
    return { controller, owner, registration, read, observations, milestones, counts: () => ({ registrations, reads }) };
  }
  const delivery = () => ({ purpose: 'selected-process-rss', signal: signal().signal });
  interface Probe { ordinal: number; spawnEnteredAt: number; spawnReturnedAt?: number; spawnAt?: number;
    closeAt?: number; exitCode?: number | null; signalCode?: string | null; socketErrorCode?: string }
  async function unauthorized(socketPath: string, frame: unknown, probe: Probe) {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `
      import net from 'node:net';
      const s=net.createConnection(process.argv[1]); let text='';
      s.on('connect',()=>s.end(process.argv[2]+'\\n'));
      s.on('data',c=>{text+=c;if(text.length>4096)process.exit(65)});
      s.on('end',()=>{process.stdout.write(text);});
      s.on('error',e=>{process.stderr.write(JSON.stringify({socketErrorCode:typeof e.code==='string'&&/^[A-Z0-9_]{1,32}$/.test(e.code)?e.code:'unknown'})+'\\n',()=>process.exit(66))});setTimeout(()=>process.exit(67),2000).unref();
    `, socketPath, JSON.stringify(frame)], { stdio: ['ignore', 'pipe', 'pipe'] });
    probe.spawnReturnedAt = performance.now(); child.once('spawn', () => { probe.spawnAt = performance.now(); });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise<number | null>(resolve => child.once('close', (code, signal) => {
      probe.closeAt = performance.now(); probe.exitCode = code; probe.signalCode = signal; resolve(code);
    }));
    try { const parsed = JSON.parse(errors); if (typeof parsed.socketErrorCode === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(parsed.socketErrorCode)) probe.socketErrorCode = parsed.socketErrorCode; }
    catch { /* Unstructured helper stderr is never copied into diagnostics. */ }
    assert.equal(code, 0, JSON.stringify({ kind: 'ipc-negative-probe', clock: 'parent-performance', ...probe }));
    assert.equal(errors.length, 0, 'Negative helper must emit no unexpected stderr'); return JSON.parse(output.trim());
  }
  test('construction is inert and denied registration starts no process', async () => {
    const h = setup({ authorizeRegistration: () => undefined });
    assert.equal(h.controller.status().starts, 0);
    assert.equal((await h.controller.start({ purpose: 'rss', version: 1 })).ok, false);
    assert.equal(h.observations.length, 0); assert.equal(h.controller.status().nativeChildren, 0); await h.controller.close();
  });
  test('actual private socket rejects separate missing/wrong capability and version before RSS acquisition', async t => {
    const h = setup(), probes: Probe[] = []; let failed = false;
    try {
      const started = await h.controller.start({ purpose: 'rss', version: 1 });
      assert.ok(started.ok, JSON.stringify({ operation: 'start', result: started, status: h.controller.status() }));
      const observation = h.observations[0]!;
      assert.equal((await stat(observation.socketPath)).mode & 0o777, 0o600);
      for (const frame of [{ version: 1, epoch: observation.epoch, action: 'read-rss', id: 'foreign' },
        { version: 1, epoch: observation.epoch, action: 'read-rss', id: 'foreign', capability: 'wrong' },
        { version: 1, epoch: observation.epoch, action: 'read-rss', id: 'foreign', capability: 'é'.repeat(64) },
        { version: 2, epoch: observation.epoch, action: 'read-rss', id: 'foreign', capability: 'wrong' }]) {
        const probe = { ordinal: probes.length + 1, spawnEnteredAt: performance.now() }; probes.push(probe);
        assert.deepEqual(await unauthorized(observation.socketPath, frame, probe), { ok: false, reason: 'denied' });
      }
      const result = await h.controller.readRss(started.value, delivery()); assert.ok(result.ok);
      assert.equal(result.value.sequence, 1, 'native unauthorized callers performed zero memoryUsage reads');
      assert.ok(result.value.rssBytes > 0); assert.equal(result.value.sourceTime.clockId, `agent-rss:${observation.pid}:${observation.epoch}`);
      assert.equal(result.value.quality, 'valid'); assert.ok(result.value.sourceTime.at >= 0);
      assert.ok(result.value.receivedAt >= 0); assert.notEqual(result.value.receiptClockId, result.value.sourceTime.clockId);
    } catch (error) { failed = true; throw error; }
    finally { try { await h.controller.close(); } finally { if (failed) t.diagnostic(JSON.stringify({ kind: 'ipc-startup',
      clock: 'parent-performance', ...h.milestones, probes, status: h.controller.status() })); } }
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
    const startupEnteredAt = performance.now();
    try { const start = await h.controller.start({ purpose: 'rss', version: 1 });
      assert.ok(start.ok, JSON.stringify({ operation: 'start-before-read-abort', result: start,
        elapsedMs: performance.now() - startupEnteredAt, limits: SCOPED_AGENT_IPC_LIMITS, status: h.controller.status() }));
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
    let expiresAt = 0;
    // One fixed grant covers the existing native ready allowance and an active
    // tail. Startup is not required to finish within the 150 ms active tail.
    const h = setup({ authorizeRegistration(request) {
      expiresAt = performance.now() + SCOPED_AGENT_IPC_LIMITS.deadlineMs + 150;
      return { request, signal: signal().signal, expiresAt };
    } });
    try { const start = await h.controller.start({ purpose: 'rss', version: 1 }); assert.ok(start.ok, JSON.stringify(start));
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - performance.now())));
      const cleanupDeadline = expiresAt + SCOPED_AGENT_IPC_LIMITS.killMs + SCOPED_AGENT_IPC_LIMITS.terminateMs;
      while (!h.controller.status().cleanupVerified && performance.now() < cleanupDeadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // No stop/read call may cause the cleanup being asserted here.
      assert.ok(performance.now() >= expiresAt);
      assert.equal(h.controller.status().phase, 'idle'); assert.equal(h.controller.status().cleanupVerified, true);
      assert.equal(h.controller.status().nativeChildren, 0); assert.equal(h.controller.status().nativePending, 0); assert.equal(h.controller.status().timers, 0);
      assert.equal((await h.controller.readRss(start.value, delivery())).ok, false); assert.equal(h.controller.status().reads, 0);
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
