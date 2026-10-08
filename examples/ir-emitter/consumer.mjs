import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createNec32IrEmitterGateway } from '../../packages/hub-server/src/nec32-ir-emitter-gateway.ts';

function softwareProvider() {
  let child, exitPromise = Promise.resolve(), settlement = Promise.resolve(), buffer = '', outputBytes = 0, spawnCount = 0;
  let liveTimers = 0, session;
  const waiters = new Set(), messages = [], sentTypes = [];
  const schedule = (callback, delay) => { let live = true; liveTimers++; const id = setTimeout(() => {
    if (!live) return; live = false; liveTimers--; callback();
  }, delay); return { cancel() { if (!live) return; live = false; liveTimers--; clearTimeout(id); } }; };
  const within = (promise, timeout, message) => new Promise((resolve, reject) => { const timer = schedule(() => reject(new Error(message)), timeout);
    Promise.resolve(promise).then(value => { timer.cancel(); resolve(value); }, error => { timer.cancel(); reject(error); }); });
  const settleWaiters = error => { for (const item of waiters) { item.timer.cancel(); item.reject(error); } waiters.clear(); };
  const waitFor = (match, timeout = 500) => new Promise((resolve, reject) => {
    const item = { match, resolve, reject, timer: undefined };
    item.timer = schedule(() => { waiters.delete(item); reject(new Error('software emitter deadline')); }, timeout);
    waiters.add(item);
  });
  const line = raw => {
    if (raw.length > 1024) throw new Error('software emitter line too large'); const value = JSON.parse(raw); messages.push(value);
    for (const item of waiters) if (item.match(value)) { item.timer.cancel(); waiters.delete(item); item.resolve(value); break; }
  };
  const launch = async () => {
    if (child && child.exitCode === null) return;
    child = spawn(process.execPath, [new URL('./software-emitter.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] }); spawnCount++;
    buffer = ''; outputBytes = 0; let stderr = 0;
    exitPromise = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => {
      const error = code === 0 ? undefined : new Error(`software emitter exited ${code ?? signal}`); settleWaiters(error ?? new Error('software emitter exited'));
      child = undefined; session = undefined; if (error) reject(error); else resolve();
    }); }); void exitPromise.catch(() => {});
    child.stderr.on('data', chunk => { stderr += chunk.length; if (stderr > 16_384) child?.kill('SIGKILL'); });
    child.stdout.on('data', chunk => { try { outputBytes += chunk.length; if (outputBytes > 16_384) throw new Error('software emitter output too large');
      buffer += chunk.toString('utf8'); while (buffer.includes('\n')) { const end = buffer.indexOf('\n'); const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1); line(raw); }
    } catch (error) { settleWaiters(error); child?.kill('SIGKILL'); } });
    try {
      const hello = await waitFor(value => value?.type === 'hello', 1500);
      assert.deepEqual(hello, { type: 'hello', revision: 1, profileId: 'app:nec-inverse-byte-command-one-shot/1',
        carrierRanges: [{ minHz: 38000, maxHz: 38000 }] });
    } catch (error) {
      const running = child; running?.kill('SIGKILL');
      await within(exitPromise.catch(() => {}), 1000, 'startup cleanup timeout').catch(() => {});
      if (child === running) child = undefined; throw error;
    }
  };
  const send = message => { if (!child?.stdin.writable) throw new Error('software emitter unavailable'); sentTypes.push(message.type);
    child.stdin.write(`${JSON.stringify(message)}\n`); };
  const provider = {
    supported: true, carrierRanges: Object.freeze([{ minHz: 38000, maxHz: 38000 }]),
    async open(context) { await launch(); const token = randomBytes(16).toString('hex');
      const waiting = waitFor(value => value?.type === 'ready' && value.generation === context.generation && value.token === token);
      send({ type: 'open', generation: context.generation, token, deadline: context.deadline }); await waiting;
      session = Object.freeze({ generation: context.generation, token }); return 'ready'; },
    async transmit(envelope, context) { if (!session || session.generation !== context.generation) return 'rejected';
      const sha256 = createHash('sha256').update(envelope).digest('hex');
      const waiting = waitFor(value => (value?.type === 'completed' || value?.type === 'cancelled' || value?.type === 'rejected') && value.operationId === context.operationId,
        Math.max(1, Math.ceil(context.deadline - performance.now())));
      send({ type: 'emit', generation: context.generation, token: session.token, operationId: context.operationId, deadline: context.deadline,
        envelope: Buffer.from(envelope).toString('base64'), sha256 });
      const result = await waiting; return result.type === 'completed' && result.sha256 === sha256 ? 'completed' : 'rejected'; },
    stop() { if (!child?.stdin.writable || !session) return; const stopping = session;
      const waiting = waitFor(value => value?.type === 'stopped' && value.generation === stopping.generation && value.token === stopping.token);
      send({ type: 'stop', generation: stopping.generation, token: stopping.token });
      settlement = waiting.then(() => { if (session === stopping) session = undefined; }); },
    async close() { if (!child) return; const running = child; const waiting = waitFor(value => value?.type === 'closed');
      try { send({ type: 'close' }); await waiting; await within(exitPromise, 1000, 'close timeout'); }
      catch { running.kill('SIGKILL'); await within(exitPromise.catch(() => {}), 1000, 'kill timeout').catch(() => {}); } },
    whenSettled() { return settlement; },
  };
  return { provider, messages, sentTypes, spawnCount: () => spawnCount,
    status: () => Object.freeze({ waiters: waiters.size, timers: liveTimers, childRunning: Boolean(child) }) };
}

export async function runIrEmitterConsumer() {
  const software = softwareProvider(); const owner = new AbortController(), controlGrant = new AbortController(), emissionGrant = new AbortController();
  const scope = { principalId: 'owned-operator', applicationId: 'ir-emitter-example', sessionId: 'loopback-ir-session' };
  let controlAllowed = false, emissionAllowed = false, epoch; const results = [], deadlines = new Map(), grantedRoutes = new Set();
  const gateway = createNec32IrEmitterGateway({ ownerSignal: owner.signal, scope,
    selectedEmitter: { id: 'software-emitter-a', profileId: 'app:nec-inverse-byte-command-one-shot/1',
      codebook: [{ codeId: 'fixture-34-a2', address: 0x34, command: 0xa2 }] }, selectedProvider: software.provider,
    authorizeEmitter(request) { return controlAllowed ? { request, signal: controlGrant.signal, expiresAt: performance.now() + 5000 } : undefined; },
    authorizeEmission(request) { return emissionAllowed ? { request, signal: emissionGrant.signal, expiresAt: performance.now() + 5000 } : undefined; } });
  const runtime = createDeviceRuntime({ authorize: request => grantedRoutes.has(JSON.stringify([request.principalId, request.applicationId,
    request.sessionId, request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]))
    ? { expiresAt: performance.now() + 5000, maxAgeMs: 400 } : undefined });
  const capability = (id, kind, permissions) => ({ id, semantic: 'example:selected-nec32-code/1', schemaVersion: 1, kind,
    value: { type: 'enum', values: ['fixture-34-a2'] }, delivery: { mode: 'reliable', maxAgeMs: 400 }, permissions,
    ...(kind === 'command' ? { ownership: { mode: 'exclusive' } } : {}) });
  const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'software-nec32-emitter', label: 'Software NEC32 emitter', revision: 1,
    adapter: { id: 'example:nec32-loopback', version: '1.0.0' }, runtime: { platform: 'node-loopback-fixture' },
    capabilities: [capability('selected-code', 'event', ['subscribe']), capability('emit', 'command', ['invoke'])] });
  const source = runtime.registerSource({ device, capability: 'selected-code' });
  const sink = runtime.registerSink({ device, capability: 'emit', async apply(observation, context) {
    const deadline = deadlines.get(context.operationId); deadlines.delete(context.operationId);
    if (!epoch || !context.isCurrent() || context.signal.aborted || typeof deadline !== 'number') return;
    const result = await gateway.emit(epoch, { operationId: context.operationId, codeId: observation.value, purpose: 'approved selected code', signal: context.signal, deadline });
    results.push(result); if (result.ok && context.isCurrent() && !context.signal.aborted) context.reportEvidence('dispatched');
  }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const route = allow => { if (allow) grantedRoutes.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId,
    source.id, sink.id, 'subscribe', 'invoke'])); return runtime.route({ from: source, to: sink, ...scope, queueCapacity: 1 }); };
  const settle = async connection => { for (let turn = 0; turn < 200 && connection.status().pending; turn++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(connection.status().pending, 0); };
  let connection;
  try {
    assert.deepEqual(await gateway.start({ purpose: 'selected emitter', deadline: performance.now() + 400 }), { ok: false, reason: 'denied' });
    assert.equal(software.spawnCount(), 0); controlAllowed = true;
    const started = await gateway.start({ purpose: 'selected emitter', deadline: performance.now() + 400 }); assert.ok(started.ok, JSON.stringify(started)); epoch = started.value;
    assert.equal(route(false).start().ok, false); assert.equal(results.length, 0);
    connection = route(true); assert.ok(connection.start().ok); let deadline = performance.now() + 400; deadlines.set('1', deadline);
    const published = runtime.publish(source, 'fixture-34-a2', { operationId: '1', deadline }); assert.ok(published.ok, JSON.stringify(published)); runtime.flush(); await settle(connection);
    assert.deepEqual(results, [{ ok: false, reason: 'denied' }]); assert.equal(software.sentTypes.includes('emit'), false);
    emissionAllowed = true; deadline = performance.now() + 400; deadlines.set('2', deadline);
    assert.ok(runtime.publish(source, 'fixture-34-a2', { operationId: '2', deadline }).ok); runtime.flush(); await settle(connection);
    assert.equal(results.length, 2); assert.ok(results[1].ok, JSON.stringify(results[1]));
    const accepted = connection.operations().find(item => item.id === '2'); assert.equal(accepted?.effectEvidence, 'dispatched');
    assert.notEqual(accepted?.effectEvidence, 'observed');
    runtime.revoke(connection); assert.equal(runtime.publish(source, 'fixture-34-a2', { operationId: '3', deadline: performance.now() + 400 }).ok, false);
    await gateway.stop(); assert.deepEqual(software.status(), { waiters: 0, timers: 0, childRunning: false });
    const restarted = await gateway.start({ purpose: 'fresh selected emitter session', deadline: performance.now() + 400 });
    assert.ok(restarted.ok, JSON.stringify(restarted)); epoch = restarted.value; assert.equal(software.spawnCount(), 2);
  } finally { runtime.close(); await gateway.close(); }
  const lifecycle = software.status(); assert.deepEqual(lifecycle, { waiters: 0, timers: 0, childRunning: false });
  assert.equal(software.messages.at(-1)?.type, 'closed'); assert.equal(gateway.status().rawPending, 0);
  const readyTokens = software.messages.filter(value => value.type === 'ready').map(value => value.token);
  assert.equal(new Set(readyTokens).size, 2);
  return { status: 'pass', kind: 'separate-process-loopback-nec32-emitter', checks: { deniedControlNoChild: true,
    deniedRouteNoEmission: true, approvedRoutePrivateDeniedNoChildEmit: true, approvedExactCode: true, routeRevocation: true,
    closeSettled: true, restartUsesFreshOwnedChild: true, zeroWaitersAndTimersAfterChildExit: true, providerCompletionOnly: true, physicalCarrierUnverified: true,
    targetAcknowledgementFalse: true, observedStateFalse: true },
    limitations: { providerIdentity: 'exact-in-process-provider-object', hardware: 'unverified', applianceMeaning: 'opaque-codebook-only',
      targetAcknowledgement: false, independentlyObservedState: false }, childMessages: software.messages.map(value => value.type),
    childCommands: [...software.sentTypes], lifecycle };
}
if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(await runIrEmitterConsumer()));
