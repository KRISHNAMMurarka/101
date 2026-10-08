import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createOpcUaJsonTelemetryConnector } from '../../packages/hub-server/src/opcua-json-telemetry.ts';

const scope = Object.freeze({ principalId: 'owned-operator', applicationId: 'opcua-telemetry-example', sessionId: 'software-session' });
function selectedProfile() { return { id: 'example:opcua-temperature', revision: 1, topic: 'opcua/json/data/owned-publisher', publisherId: 'owned-publisher',
  writerGroupName: 'OwnedGroup', dataSetClassId: '11111111-1111-4111-8111-111111111111', dataSetWriterId: 1,
  metadataVersion: { major: 1, minor: 1 }, field: { name: 'Temperature', builtInType: 11, dataType: 'i=11', valueRank: -1,
    engineeringUnits: { namespaceUri: 'http://www.opcfoundation.org/UA/units/un/cefact', unitId: 4408652 }, unit: 'Cel', min: -50, max: 150 }, receiveTimeoutMs: 3000 }; }
async function until(predicate, label) { const deadline = performance.now() + 1500;
  while (!predicate()) { assert.ok(performance.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 5)); } }
function startProducer(endpoint) {
  const child = fork(new URL('./producer.mjs', import.meta.url), [endpoint], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', next = 0, exited = false;
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
  function response(id, send) { return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`producer timeout ${stderr}`)), 3000);
    const onExit = () => finish(new Error(`producer exit ${stderr}`));
    const onMessage = message => { if ((id === 0 && message?.kind === 'ready') || message?.id === id) finish(message?.kind === 'error' ? new Error(message.reason) : undefined, message); };
    function finish(error, message) { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); if (error) reject(error); else resolve(message); }
    child.on('message', onMessage); child.once('exit', onExit); if (send) child.send(send, error => { if (error) finish(error); });
  }); }
  const ready = response(0);
  return { child, ready, request(kind) { const id = ++next; return response(id, { kind, id }); },
    async close() {
      if (!exited) { try { await response(++next, { kind: 'close', id: next }); } catch { /* Exit result remains the settlement check. */ }
        const timer = setTimeout(() => { if (!exited) child.kill('SIGTERM'); }, 1000);
        const outcome = await exit; clearTimeout(timer); assert.ok(outcome.code === 0 || outcome.signal === 'SIGTERM', stderr);
      }
      assert.equal(child.exitCode !== null || child.signalCode !== null, true, 'owned child settled');
    } };
}
export async function runOpcUaJsonTelemetryConsumer(endpoint) {
  const owner = new AbortController(), grant = new AbortController(), readings = [], applied = [], measurements = [], wire = [], unavailable = [];
  let routeAllowed = false, route, producer; const readingResults = [];
  const value = { type: 'record', fields: { severity: { type: 'enum', values: ['good','uncertain','bad'] },
    statusCode: { type: 'scalar', unit: '1', min: 0, max: 0xffffffff }, dataSetStatusCode: { type: 'scalar', unit: '1', min: 0, max: 0xffffffff },
    sourceSequence: { type: 'scalar', unit: '1', min: 0, max: 0xffffffff }, missingMessages: { type: 'scalar', unit: '1', min: 0, max: 0xffffffff },
    temperature: { type: 'scalar', unit: 'Cel', min: -50, max: 150 }, sourcePicoseconds: { type: 'scalar', unit: '1', min: 0, max: 9999 }, serverPicoseconds: { type: 'scalar', unit: '1', min: 0, max: 9999 } },
    optional: ['temperature','sourcePicoseconds','serverPicoseconds'] };
  const descriptor = parseDeviceDescriptor({ schemaVersion: 1, id: 'opcua-software-gateway', label: 'Owned software telemetry', revision: 1,
    adapter: { id: 'example:opcua-json', version: '1.0.0' }, runtime: { platform: 'node-loopback' }, capabilities: [
      { id: 'telemetry', semantic: 'industrial:opcua-datavalue', schemaVersion: 1, kind: 'sample', value, permissions: ['subscribe'], delivery: { mode: 'latest', maxHz: 120, maxAgeMs: 1000 } },
      { id: 'display', semantic: 'industrial:opcua-datavalue', schemaVersion: 1, kind: 'property', value, permissions: ['write'], ownership: { mode: 'observe' }, delivery: { mode: 'latest', maxHz: 120, maxAgeMs: 1000 } },
    ] });
  const runtime = createDeviceRuntime({ clockDomain: 'opcua-gateway-monotonic', now: () => performance.now(), authorize: request => routeAllowed &&
    request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId &&
    request.source.registrationId === source.id && request.sink.registrationId === sink.id && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write'
      ? { expiresAt: performance.now() + 5000, maxAgeMs: 1000 } : undefined });
  const source = runtime.registerSource({ device: descriptor, capability: 'telemetry' });
  const sink = runtime.registerSink({ device: descriptor, capability: 'display', apply(observation, context) {
    if (!context.isCurrent() || context.signal.aborted) return; applied.push(observation);
    if (observation.value.severity === 'good') measurements.push(observation.value.temperature);
  }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const connector = createOpcUaJsonTelemetryConnector({ ownerSignal: owner.signal, scope, endpoint, profile: selectedProfile(),
    authorize: request => ({ request, signal: grant.signal, expiresAt: performance.now() + 10000 }),
    onReading(reading) { readings.push(reading);
      const { sourceTimestamp, serverTimestamp, ...publicRecord } = reading.record;
      const result = runtime.publish(source, publicRecord, { sequence: reading.localSequence, timestamp: reading.receivedAt,
        clockDomain: reading.receiptClockId, quality: 'valid', provenance: { profileId: 'example:opcua-temperature', profileRevision: 1,
          publisherId: 'owned-publisher', dataSetWriterId: 1, topic: selectedProfile().topic, messageId: reading.messageId,
          payloadSha256: reading.payloadSha256, receivedAt: reading.receivedAt, receiptClockId: reading.receiptClockId,
          datasetTimestamp: reading.datasetTimestamp, ...(sourceTimestamp === undefined ? {} : { sourceTimestamp }), ...(serverTimestamp === undefined ? {} : { serverTimestamp }) } });
      readingResults.push(result); if (routeAllowed) assert.ok(result.ok, JSON.stringify(result)); runtime.flush();
    }, onUnavailable(reason) { unavailable.push(reason); runtime.setReadiness(source, 'unavailable'); } });
  try {
    assert.ok((await connector.start({ purpose: 'selected-read-only-telemetry', signal: owner.signal })).ok);
    route = runtime.route({ from: source, to: sink, ...scope }); assert.equal(route.start().ok, false);
    producer = startProducer(endpoint); const ready = await producer.ready; assert.equal(ready.pid, producer.child.pid);
    wire.push(await producer.request('good')); await until(() => readings.length === 1, 'denied-route transport sample'); assert.equal(applied.length, 0);
    routeAllowed = true; route = runtime.route({ from: source, to: sink, ...scope }); assert.ok(route.start().ok);
    for (const [kind, count] of [['good',1],['uncertain',2],['bad',3],['gap',4]]) {
      wire.push(await producer.request(kind)); await until(() => { runtime.flush(); return applied.length === count; }, `public ${kind} record`);
    }
    assert.deepEqual(applied.map(item => item.value.severity), ['good','uncertain','bad','good']);
    assert.equal(Object.hasOwn(applied[2].value, 'temperature'), false); assert.equal(applied[1].value.statusCode, 0x40000000);
    assert.equal(applied[2].value.statusCode, 0x80000000); assert.equal(applied[3].value.missingMessages, 2);
    for (const observation of applied) { assert.equal(observation.provenance.sourceTimestamp, '2026-10-08T00:00:00.1234567Z');
      assert.equal(observation.value.sourcePicoseconds, 12); assert.equal(observation.clockDomain, 'opcua-gateway-monotonic');
      assert.equal(observation.provenance.receivedAt, observation.timestamp); assert.ok(observation.timestamp < 1e12);
      assert.ok(wire.some(item => item.payloadSha256 === observation.provenance.payloadSha256)); }
    const rejected = connector.status().rejectedMessages; wire.push(await producer.request('duplicate'));
    await until(() => connector.status().rejectedMessages === rejected + 1, 'native duplicate rejection'); assert.equal(applied.length, 4);
    await connector.stop(); assert.equal(connector.status().nativeClients, 0);
    wire.push(await producer.request('good')); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(applied.length, 4); assert.equal(readings.length, 5);
    await producer.close(); producer = undefined;
    return Object.freeze({ status: 'pass', kind: 'actual-standard-opcua-json-mqtt-software-proof', checks: {
      nativeQualityPreserved: true, originalUtcPreserved: true, routeDenied: true, gapObserved: true, replayRejected: true, retired: true },
      applied: applied.map(item => ({ value: item.value, timestamp: item.timestamp, provenance: item.provenance })), measurements,
      wire, unavailable, statusAfterStop: connector.status(),
      scope: 'Software producer and owned loopback broker; publisher/units/status are reviewed claims, UTC clocks unmapped, no physical/certification/CAN evidence.' });
  } catch (error) { throw new Error(JSON.stringify({ message:error.message, connector:connector.status(), readingResults, readings:readings.length, applied:applied.length, wire, route:route?.status() }), {cause:error}); } finally { await connector.close(); if (producer) await producer.close(); route?.stop(); runtime.close(); }
}
