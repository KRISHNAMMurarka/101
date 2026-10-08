import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createModbusRtuConnector } from '../../packages/hub-server/src/modbus-rtu.ts';

function openFixturePort(spec, children) {
  const child = spawn(process.execPath, [new URL('./producer.mjs', import.meta.url).pathname],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.stderr.on('data', () => {});
  let closed;
  let pendingDelivery = 0;
  const deliveryWaiters = new Set();
  return {
    identity: spec.id,
    bytes: (async function* () {
      for await (const chunk of child.stdout) {
        const at = performance.now();
        for (const byte of chunk) {
          pendingDelivery++;
          yield { byte, at };
          pendingDelivery--;
          if (!pendingDelivery) { for (const wake of deliveryWaiters) wake(); deliveryWaiters.clear(); }
        }
      }
    })(),
    write(frame) { return new Promise((resolve, reject) => {
      child.stdin.write(Buffer.from(frame), error => error ? reject(error) : resolve());
    }); },
    async watermark(throughAt) {
      // Pipe-receipt-domain analogue only. A production serial adapter must
      // certify physical byte timestamps and ordered delivery through t3.5.
      while (performance.now() < throughAt)
        await new Promise(resolve => setTimeout(resolve, Math.max(1, throughAt - performance.now())));
      while (pendingDelivery) await new Promise(resolve => deliveryWaiters.add(resolve));
      return throughAt;
    },
    close() {
      if (!closed) closed = new Promise((resolve, reject) => {
        if (child.exitCode !== null) { children.delete(child); resolve(); return; }
        const timer = setTimeout(() => child.kill('SIGTERM'), 1000);
        child.once('exit', (code, signal) => { clearTimeout(timer); children.delete(child);
          if (code === 0 || signal === 'SIGTERM') resolve(); else reject(new Error(`fixture producer exit ${code}`)); });
        child.stdin.end();
      });
      return closed;
    },
  };
}

// This tests a selected RTU byte-stream gateway, not a physical serial port.
// Only a host-owned opener may bind an enrolled serial device in deployment.
export async function runModbusRtuConsumer() {
  const owner = new AbortController(), grant = new AbortController();
  const children = new Set(); let allowed = false, opens = 0;
  const scope = { principalId: 'owned-operator', applicationId: 'rtu-register-gateway', sessionId: 'fixture-session' };
  const connector = createModbusRtuConnector({ ownerSignal: owner.signal, scope,
    port: { id: 'fixture:child-rtu-1', baudRate: 1200, parity: 'even', dataBits: 8, stopBits: 1 },
    profile: { id: 'example:single-holding-register', revision: 1, unitId: 1, registers: [
      { id: 'reading', address: 0, access: 'read', unit: '1', scale: 0.5, offset: 1 },
      { id: 'setting', address: 0, access: 'write', unit: '1', scale: 0.5, offset: 1 },
    ] },
    authorize(request) { return allowed ? { request, signal: grant.signal, expiresAt: performance.now() + 10_000 } : undefined; },
    async openPort(spec) { opens++; return openFixturePort(spec, children); },
  });
  const routes = new Set(), readings = [];
  const routeKey = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId,
    request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
  const runtime = createDeviceRuntime({ authorize: request => routes.has(routeKey(request))
    ? { expiresAt: performance.now() + 10_000, maxAgeMs: 1000 } : undefined });
  const value = { type: 'scalar', unit: '1', min: 1, max: 32768.5 };
  const capability = (id, kind, permissions) => ({ id, semantic: 'example:rtu-register-value', schemaVersion: 1, kind, value,
    delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions,
    ...(kind === 'command' ? { ownership: { mode: 'exclusive' } } : {}) });
  const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-rtu-fixture', label: 'Owned RTU fixture', revision: 1,
    adapter: { id: 'example:modbus-rtu', version: '1.0.0' }, runtime: { platform: 'node-local-fixture' }, capabilities: [
      capability('reading', 'event', ['subscribe']), capability('setting', 'command', ['invoke']),
      capability('control', 'event', ['subscribe']), capability('display', 'command', ['invoke']),
    ] });
  let epoch;
  const commandResults = [];
  const commandDeadlines = new Map();
  const source = runtime.registerSource({ device, capability: 'reading' });
  const control = runtime.registerSource({ device, capability: 'control' });
  const sink = runtime.registerSink({ device, capability: 'setting', async apply(observation, context) {
    if (!context.isCurrent() || context.signal.aborted || !epoch) return;
    const deadline = commandDeadlines.get(context.operationId);
    commandDeadlines.delete(context.operationId);
    if (typeof deadline !== 'number') return;
    const result = await connector.write(epoch, 'setting', observation.value,
      { purpose: 'selected-register-write', signal: context.signal, deadline });
    commandResults.push(result);
    if (result.ok && context.isCurrent() && !context.signal.aborted) context.reportEvidence(result.value.evidence);
  }, release() {} });
  const display = runtime.registerSink({ device, capability: 'display', apply(observation, context) {
    if (context.isCurrent() && !context.signal.aborted) readings.push(observation.value);
  }, release() {} });
  for (const handle of [source, control, sink, display]) runtime.setReadiness(handle, 'available');
  const route = (from, to, allow) => {
    if (allow) routes.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId,
      from.id, to.id, 'subscribe', 'invoke']));
    return runtime.route({ from, to, ...scope, queueCapacity: 1 });
  };
  async function settle(connection) {
    for (let turn = 0; turn < 100 && connection.status().pending; turn++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(connection.status().pending, 0);
  }
  try {
    assert.equal((await connector.start({ purpose: 'selected-fixture', deadline: performance.now() + 1000 })).ok, false);
    assert.equal(opens, 0);
    allowed = true;
    const started = await connector.start({ purpose: 'selected-fixture', deadline: performance.now() + 1000 });
    assert.ok(started.ok); epoch = started.value;
    assert.equal(route(control, sink, false).start().ok, false);
    const command = route(control, sink, true); assert.ok(command.start().ok);
    const commandDeadline = performance.now() + 1000;
    commandDeadlines.set('1', commandDeadline);
    assert.ok(runtime.publish(control, 22, { operationId: '1', deadline: commandDeadline }).ok);
    runtime.flush(); await settle(command);
    assert.equal(command.operations()[0].effectEvidence, 'target-acknowledged',
      JSON.stringify({ commandResults, operations: command.operations(), status: connector.status() }));
    assert.equal(command.operations().some(record => record.effectEvidence === 'observed'), false);
    assert.equal(route(source, display, false).start().ok, false);
    const output = route(source, display, true); assert.ok(output.start().ok);
    const read = await connector.read(epoch, 'reading', { purpose: 'separate-readback', signal: owner.signal,
      deadline: performance.now() + 1000 }); assert.ok(read.ok);
    assert.equal(read.value.rawValue, 42); assert.equal(read.value.value, 22);
    const published = runtime.publish(source, read.value.value, { sequence: read.value.sequence, operationId: '1',
      deadline: read.value.receivedAt + 1000, timestamp: read.value.receivedAt,
      provenance: { transport: 'local-rtu-byte-stream', rawValue: read.value.rawValue,
        receivedAt: read.value.receivedAt, receiptClockId: read.value.receiptClockId } });
    assert.ok(published.ok, JSON.stringify(published));
    runtime.flush(); await settle(output); assert.deepEqual(readings, [22]);
    runtime.revoke(command);
    assert.equal(runtime.publish(control, 30, { operationId: '2', deadline: performance.now() + 1000 }).ok, false);
    const oldEpoch = epoch; await connector.stop();
    assert.equal(children.size, 0); assert.equal(connector.status().nativePorts, 0);
    assert.equal((await connector.read(oldEpoch, 'reading', { purpose: 'stale', signal: owner.signal,
      deadline: performance.now() + 1000 })).ok, false);
    return { status: 'pass', kind: 'separate-process-rtu-byte-stream', timingEvidence: 'software-pipe-receipt-only', checks: { deniedConnect: true,
      deniedRoute: true, approvedCommand: true, readbackSeparate: true, revokeNoWrite: true,
      staleEpoch: true, actualClose: true, noPhysicalDeviceClaim: true }, rawReadback: read.value.rawValue };
  } finally {
    runtime.close(); await connector.close();
    for (const child of children) { child.stdin.end(); child.kill('SIGTERM'); }
  }
}
if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(await runModbusRtuConsumer()));
