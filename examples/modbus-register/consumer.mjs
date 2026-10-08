import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createModbusRegisterConnector } from '@101/hub-server';

// A real owned TCP register server. It is software evidence for this exact
// unsigned register map, never an inferred physical device or actuator profile.
export async function runModbusRegisterConsumer() {
  const sockets = new Set(); let state = 37, writes = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]); if (input.length > 260) { socket.destroy(); return; }
      while (input.length >= 12) {
        const frame = input.subarray(0, 12); input = input.subarray(12);
        if (frame.readUInt16BE(2) !== 0 || frame.readUInt16BE(4) !== 6 || frame[6] !== 1 || frame.readUInt16BE(8) !== 0) { socket.destroy(); return; }
        if (frame[7] === 6) { state = frame.readUInt16BE(10); writes++; socket.write(frame); }
        else if (frame[7] === 3 && frame.readUInt16BE(10) === 1) {
          const result = Buffer.from([frame[0], frame[1], 0, 0, 0, 5, 1, 3, 2, state >> 8, state & 255]); socket.write(result);
        } else socket.destroy();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const owner = new AbortController(), nativeGrant = new AbortController();
  const scope = { principalId: 'owned-operator', applicationId: 'modbus-register', sessionId: 'actual-tcp' };
  const connector = createModbusRegisterConnector({ ownerSignal: owner.signal, scope,
    endpoint: { host: '127.0.0.1', port: address.port, transport: 'loopback' },
    profile: { id: 'example:holding-register', revision: 1, unitId: 1, registers: [
      { id: 'reading', address: 0, access: 'read', unit: '1', scale: 0.5, offset: 1 },
      { id: 'set-value', address: 0, access: 'write', unit: '1', scale: 0.5, offset: 1 },
    ] }, authorize(request) { return { request, signal: nativeGrant.signal, expiresAt: performance.now() + 10000 }; } });
  const approved = new Set(), readings = [];
  const key = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId,
    request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
  const runtime = createDeviceRuntime({ authorize: request => approved.has(key(request)) ? { expiresAt: performance.now() + 10000, maxAgeMs: 1000 } : undefined });
  const value = { type: 'scalar', unit: '1', min: 1, max: 32768.5 };
  const capability = (id, kind, permissions) => ({ id, semantic: 'example:holding-register-value', schemaVersion: 1, kind, value,
    delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions, ...(kind === 'command' ? { ownership: { mode: 'exclusive' } } : {}) });
  const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-modbus-server', label: 'Owned register server', revision: 1,
    adapter: { id: 'example:modbus-tcp', version: '1.0.0' }, runtime: { platform: 'node-loopback' }, capabilities: [
      capability('reading', 'event', ['subscribe']), capability('setting', 'command', ['invoke']),
      capability('control', 'event', ['subscribe']), capability('display', 'command', ['invoke']),
    ] });
  let epoch;
  const source = runtime.registerSource({ device, capability: 'reading' });
  const control = runtime.registerSource({ device, capability: 'control' });
  const sink = runtime.registerSink({ device, capability: 'setting', async apply(observation, context) {
    if (!context.isCurrent() || context.signal.aborted || !epoch) return;
    const result = await connector.write(epoch, 'set-value', observation.value, { purpose: 'selected-register-write', signal: context.signal });
    if (result.ok && context.isCurrent() && !context.signal.aborted) context.reportEvidence(result.value.evidence);
  }, release() {} });
  const display = runtime.registerSink({ device, capability: 'display', apply(observation, context) {
    if (context.isCurrent() && !context.signal.aborted) readings.push(observation.value);
  }, release() {} });
  for (const handle of [source, control, sink, display]) runtime.setReadiness(handle, 'available');
  const route = (from, to, allow) => {
    if (allow) approved.add(JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId, from.id, to.id, 'subscribe', 'invoke']));
    return runtime.route({ from, to, ...scope, queueCapacity: 1 });
  };
  async function settle(connection) {
    for (let turn = 0; turn < 100 && connection.status().pending; turn++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(connection.status().pending, 0);
  }
  try {
    const started = await connector.start({ purpose: 'explicit-local-register-server' }); assert.ok(started.ok); epoch = started.value;
    assert.equal(route(control, sink, false).start().ok, false); assert.equal(writes, 0);
    const command = route(control, sink, true); assert.ok(command.start().ok);
    assert.ok(runtime.publish(control, 22, { operationId: '1', deadline: performance.now() + 1000 }).ok); runtime.flush(); await settle(command);
    assert.equal(writes, 1); assert.equal(state, 42); assert.equal(command.operations()[0].effectEvidence, 'target-acknowledged');
    assert.equal(command.operations().some(record => record.effectEvidence === 'observed'), false);
    assert.equal(route(source, display, false).start().ok, false); assert.equal(readings.length, 0);
    const output = route(source, display, true); assert.ok(output.start().ok);
    const reading = await connector.read(epoch, 'reading', { purpose: 'separate-readback', signal: owner.signal }); assert.ok(reading.ok);
    assert.ok(runtime.publish(source, reading.value.value, { sequence: reading.value.sequence, operationId: '1', deadline: performance.now() + 1000,
      timestamp: performance.now(), provenance: { transport: 'local-modbus-tcp', rawValue: reading.value.rawValue, receivedAt: reading.value.receivedAt, receiptClockId: reading.value.receiptClockId } }).ok);
    runtime.flush(); await settle(output); assert.deepEqual(readings, [22]);
    runtime.revoke(command); assert.equal(runtime.publish(control, 30, { operationId: '2', deadline: performance.now() + 1000 }).ok, false);
    runtime.flush(); assert.equal(writes, 1);
    const oldEpoch = epoch; await connector.stop();
    assert.equal((await connector.read(oldEpoch, 'reading', { purpose: 'stale-epoch', signal: owner.signal })).ok, false);
    const recovered = await connector.start({ purpose: 'fresh-explicit-connection' }); assert.ok(recovered.ok);
    assert.ok((await connector.read(recovered.value, 'reading', { purpose: 'fresh-readback', signal: owner.signal })).ok); assert.equal(writes, 1);
    await connector.stop();
    return { status: 'pass', kind: 'actual-loopback-modbus-tcp', checks: { deniedCommand: true, currentCommand: true,
      targetAckSeparateFromObservation: true, separateReadGrant: true, typedReadback: true, revokeNoWrite: true, staleEpoch: true,
      freshRecoveryNoReplay: true, actualSocketClose: connector.status().nativeSockets === 0 }, writes, readings };
  } finally {
    runtime.close(); await connector.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(() => resolve()));
  }
}
if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(await runModbusRegisterConsumer()));
