import assert from 'node:assert/strict';
import { connectAsync } from 'mqtt';
import { createDeviceRuntime, createTrustedConnectorProfileRegistry, parseConnectorProfileManifest, parseDeviceDescriptor } from '@101/connect';
import { createClockedMqttConnector } from '../../packages/hub-server/src/mqtt-clocked-connector.ts';
import { signMqttClockFrame } from '../../packages/hub-server/src/mqtt-clock.ts';
import { createMqttExampleDecoder } from './decoder.mjs';
import { createMqttExampleProfile, MQTT_EXAMPLE_DECODER_SOURCE } from './profile.mjs';
import { REMOTE_CLOCK_TOPICS, REMOTE_KEY_ID, REMOTE_ORIGIN_OFFSET_MS, REMOTE_PRODUCER_ID } from './remote-clock-producer.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 4000) {
  const end = performance.now() + timeoutMs;
  while (!await predicate()) { assert.ok(performance.now() < end, label); await delay(5); }
}
function device(id, label, capabilities) { return parseDeviceDescriptor({ schemaVersion: 1, id, label, revision: 1,
  adapter: { id: 'example:mqtt-telemetry-command', version: '1.0.0' }, runtime: { platform: 'node-mqtt-local' }, capabilities }); }
function routeKey(request) { return [request.principalId, request.applicationId, request.sessionId, request.source.registrationId,
  request.sink.registrationId, request.sourceOperation, request.sinkOperation].join('\0'); }
function routeWithGrant(runtime, from, to, scope, allowed, sinkOperation = 'write') {
  allowed.add([scope.principalId, scope.applicationId, scope.sessionId, from.id, to.id, 'subscribe', sinkOperation].join('\0'));
  return runtime.route({ from, to, ...scope });
}
function childMessage(child, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`producer-${type}-timeout`)); }, timeoutMs);
    const receive = message => {
      if (message?.type === 'error') { cleanup(); reject(new Error(message.reason)); }
      else if (message?.type === type) { cleanup(); resolve(message); }
    };
    const exit = () => { cleanup(); reject(new Error(`producer-exited-before-${type}`)); };
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); };
    child.on('message', receive); child.once('exit', exit);
  });
}
async function producerStatus(child) { const waiting = childMessage(child, 'status'); child.send({ type: 'status' }); return (await waiting).value; }

/** Public runtime caller for one enrolled separate-process boolean producer. */
export async function runClockedMqttConnectorExample(endpoint, key, producerClockId, child) {
  const base = createMqttExampleProfile();
  const manifest = parseConnectorProfileManifest({ ...base, id: 'example:mqtt-remote-enabled',
    identityFilters: [{ field: 'backendId', equals: 'mqtt5' }, { field: 'wireVersion', equals: 1 },
      { field: 'clockId', equals: producerClockId }] });
  const registry = createTrustedConnectorProfileRegistry();
  await registry.registerTrusted({ manifest, source: MQTT_EXAMPLE_DECODER_SOURCE, factory: createMqttExampleDecoder });
  const binding = registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: manifest.decoder.codeSha256 });
  const owner = new AbortController(), connectionGrant = new AbortController(), clockGrant = new AbortController();
  const approvedRoutes = new Set(), sampleRows = [], stateRows = [];
  const scope = { principalId: 'mqtt-clock-owner', applicationId: 'mqtt-clock-example', sessionId: 'mqtt-clock-session' };
  const runtime = createDeviceRuntime({ clockDomain: 'mqtt-host-monotonic', now: () => performance.now(), maxRoutes: 8,
    maxPendingDeliveries: 8, authorize: request => approvedRoutes.has(routeKey(request))
      ? { expiresAt: performance.now() + 5000, maxAgeMs: 5000, maxHz: 10 } : undefined });
  const sourceDevice = device('mqtt-remote-producer', 'Enrolled software producer', manifest.resources.map(row => row.capability));
  const enabledSource = runtime.registerSource({ device: sourceDevice, capability: 'enabled' });
  const commandSink = runtime.registerSink({ device: sourceDevice, capability: 'set-enabled',
    apply: (observation, context) => connector.apply('set-enabled', observation, context),
    release: (reason, context) => connector.release('set-enabled', reason, context) });
  const stateCapability = manifest.resources.find(row => row.capability.id === 'enabled').capability;
  const stateSink = runtime.registerSink({ device: device('mqtt-remote-state-monitor', 'State monitor',
    [{ ...stateCapability, id: 'enabled-view', permissions: ['write'], ownership: { mode: 'observe' } }]),
    capability: 'enabled-view', apply(observation, context) {
      if (context.isCurrent() && !context.signal.aborted) stateRows.push(observation.value);
    }, release() {} });
  const commandCapability = manifest.resources.find(row => row.capability.id === 'set-enabled').capability;
  const controlCapability = { ...commandCapability, id: 'control', kind: 'event', permissions: ['subscribe'] };
  delete controlCapability.ownership;
  const control = runtime.registerSource({ device: device('mqtt-remote-control', 'Control', [controlCapability]), capability: 'control' });
  let connectionRequest, clockRequest, rogue, stateRoute, controlRoute, connector, oldAck;
  function buildConnector() { return createClockedMqttConnector({ endpoint, binding, producerId: REMOTE_PRODUCER_ID,
    producerClockId, localClockId: 'mqtt-host-monotonic', keyId: REMOTE_KEY_ID, key, topics: REMOTE_CLOCK_TOPICS,
    now: () => performance.now(),
    authorizeConnection(request) { connectionRequest = request; return { request, signal: connectionGrant.signal,
      expiresAt: performance.now() + 10000 }; },
    authorizeClock(request) { clockRequest = request; return { request, signal: clockGrant.signal,
      expiresAt: performance.now() + 10000 }; },
    onSample(frame, provenance) {
      sampleRows.push({ frame, provenance });
      runtime.setReadiness(enabledSource, 'available', frame.receivedAt + 1000);
      runtime.publish(enabledSource, frame.value, { sequence: frame.sequence, timestamp: frame.receivedAt,
        clockDomain: 'mqtt-host-monotonic', quality: frame.quality,
        provenance: { sourceTime: frame.sourceTime, translatedAt: provenance.translatedAt,
          producerId: provenance.producerId, keyId: provenance.keyId, profileId: manifest.id } }); runtime.flush();
    }, onUnavailable() { runtime.setReadiness(enabledSource, 'unavailable'); } }); }
  connector = buildConnector();
  for (const handle of [enabledSource, stateSink, commandSink, control]) runtime.setReadiness(handle, 'available');
  try {
    assert.deepEqual(await connector.connect({ purpose: 'approved-remote-clock-software-example', signal: owner.signal }), { ok: true });
    assert.equal(connectionRequest.endpoint, endpoint);
    assert.equal(connectionRequest.producerClockId, producerClockId);
    assert.equal(connectionRequest.keyId, REMOTE_KEY_ID);
    assert.equal(connectionRequest.profileId, manifest.id);
    assert.equal(connectionRequest.decoder.codeSha256, manifest.decoder.codeSha256);
    assert.equal(clockRequest.sessionNonce, connectionRequest.sessionNonce);
    assert.equal(clockRequest.clientId, connectionRequest.clientId);
    assert.deepEqual(connectionRequest.topics.map(row => row.topic), Object.values(REMOTE_CLOCK_TOPICS));
    assert.ok(connectionRequest.topics.every(row => row.qos === 1 && row.deadlineMs > 0 && row.expirySeconds > 0));
    assert.equal(clockRequest.action, 'mqtt-remote-clock');
    assert.equal(clockRequest.producerClockId, producerClockId);
    assert.notEqual(clockRequest, connectionRequest);
    const sampleSent = childMessage(child, 'sample-sent'); child.send({ type: 'sample' }); await sampleSent;
    await until(() => sampleRows.length > 0, 'signed remote sample through reviewed decoder');
    assert.equal(sampleRows[0].frame.sourceTime.clockId, producerClockId);
    assert.ok(sampleRows[0].frame.sourceTime.at - sampleRows[0].frame.receivedAt > 400000);
    assert.ok(sampleRows[0].provenance.translatedAt.latest <= sampleRows[0].provenance.receivedAt);
    const denied = runtime.route({ from: enabledSource, to: stateSink, ...scope });
    assert.equal(denied.start().ok, false, 'independent RouteGrant denied');
    stateRoute = routeWithGrant(runtime, enabledSource, stateSink, scope, approvedRoutes);
    assert.equal(stateRoute.start().ok, true);
    const secondSample = childMessage(child, 'sample-sent'); child.send({ type: 'sample' }); await secondSample;
    await until(() => stateRows.includes(false), 'approved route delivers observed source state');
    rogue = await connectAsync(endpoint, { protocolVersion: 5, clean: true, properties: { sessionExpiryInterval: 0 },
      reconnectPeriod: 0, resubscribe: false, queueQoSZero: false, connectTimeout: 3000,
      clientId: `101-clock-rogue-${process.pid}` });
    await rogue.subscribeAsync({ [REMOTE_CLOCK_TOPICS.ack]: { qos: 1 } });
    rogue.on('message', (topic, payload) => { if (topic === REMOTE_CLOCK_TOPICS.ack && !oldAck) oldAck = Buffer.from(payload); });
    const beforeForgery = sampleRows.length, beforeRejected = connector.status().rejectedMessages;
    const forged = signMqttClockFrame({ schemaVersion: 1, kind: 'sample', producerId: REMOTE_PRODUCER_ID,
      clockId: producerClockId, keyId: REMOTE_KEY_ID, clientId: connectionRequest.clientId,
      sessionNonce: connectionRequest.sessionNonce, resourceId: 'enabled', sequence: 900,
      sourceAt: performance.now() + REMOTE_ORIGIN_OFFSET_MS, value: true }, Buffer.alloc(32));
    await rogue.publishAsync(REMOTE_CLOCK_TOPICS.source, forged, { qos: 1, retain: false,
      properties: { messageExpiryInterval: 1 } });
    await until(() => connector.status().rejectedMessages > beforeRejected, 'forged source rejected');
    assert.equal(sampleRows.length, beforeForgery);
    controlRoute = routeWithGrant(runtime, control, commandSink, scope, approvedRoutes, 'invoke');
    assert.equal(controlRoute.start().ok, true);
    assert.equal(runtime.publish(control, true, { operationId: '1', deadline: performance.now() + 2500 }).ok, true); runtime.flush();
    await until(() => controlRoute.operations()[0]?.effectEvidence === 'observed',
      'broker PUBACK and signed application ACK with source readback');
    await until(() => oldAck, 'recorded signed ACK from first session');
    await delay(120);
    const readback = childMessage(child, 'sample-sent'); child.send({ type: 'sample' }); await readback;
    await until(() => stateRows.includes(true), 'observed state reaches authorized route');
    assert.ok(connector.status().brokerAccepted >= 1);
    const firstEvidence = controlRoute.operations()[0].effectEvidence;
    const firstSession = { clientId: connectionRequest.clientId, sessionNonce: connectionRequest.sessionNonce };
    await connector.close();
    runtime.revoke(controlRoute);
    connector = buildConnector();
    assert.deepEqual(await connector.connect({ purpose: 'fresh-same-boot-session', signal: owner.signal }), { ok: true });
    assert.equal(connectionRequest.producerClockId, producerClockId);
    assert.notEqual(connectionRequest.clientId, firstSession.clientId);
    assert.notEqual(connectionRequest.sessionNonce, firstSession.sessionNonce);
    assert.equal((await producerStatus(child)).sessions, 2, 'same producer boot holds two bounded session watermarks');
    const beforeFreshSample = sampleRows.length;
    const freshSample = childMessage(child, 'sample-sent'); child.send({ type: 'sample' }); await freshSample;
    await until(() => sampleRows.length > beforeFreshSample, 'fresh signed session source state');
    stateRoute = routeWithGrant(runtime, enabledSource, stateSink, scope, approvedRoutes);
    assert.equal(stateRoute.start().ok, true);
    const held = childMessage(child, 'ack-held'); child.send({ type: 'hold-ack' }); await held;
    controlRoute = routeWithGrant(runtime, control, commandSink, scope, approvedRoutes, 'invoke');
    assert.equal(controlRoute.start().ok, true);
    const beforeSecond = await producerStatus(child);
    assert.equal(runtime.publish(control, false, { operationId: '2', deadline: performance.now() + 2500 }).ok, true); runtime.flush();
    await until(async () => (await producerStatus(child)).effects > beforeSecond.effects,
      'fresh connector command ID one accepted on same producer boot');
    const oldBody = JSON.parse(oldAck.toString());
    assert.equal(oldBody.commandId, '1');
    assert.ok((await producerStatus(child)).remoteNow - oldBody.sourceAt < 1000, 'old ACK is still fresh enough to replay');
    const rejectedBeforeReplay = connector.status().rejectedMessages;
    await rogue.publishAsync(REMOTE_CLOCK_TOPICS.ack, oldAck, { qos: 1, retain: false,
      properties: { messageExpiryInterval: 1 } });
    await until(() => connector.status().rejectedMessages > rejectedBeforeReplay, 'recorded old-session ACK rejected');
    assert.notEqual(controlRoute.operations()[0]?.effectEvidence, 'target-acknowledged');
    assert.notEqual(controlRoute.operations()[0]?.effectEvidence, 'observed');
    const released = childMessage(child, 'ack-released'); child.send({ type: 'release-ack' }); await released;
    await until(() => controlRoute.operations()[0]?.effectEvidence === 'observed', 'current session ACK and readback');
    await delay(120);
    const secondReadback = childMessage(child, 'sample-sent'); child.send({ type: 'sample' }); await secondReadback;
    await until(() => stateRows.at(-1) === false, 'fresh session state reaches route');
    const beforeLate = await producerStatus(child);
    const expired = signMqttClockFrame({ schemaVersion: 1, kind: 'command', producerId: REMOTE_PRODUCER_ID,
      clockId: producerClockId, keyId: REMOTE_KEY_ID, clientId: connectionRequest.clientId,
      sessionNonce: connectionRequest.sessionNonce, resourceId: 'set-enabled', commandId: '999',
      commandNonce: 'c'.repeat(32), value: false,
      originalDeadlineLocal: performance.now() - 10, expiresAtRemote: beforeLate.remoteNow - 10 }, key);
    await rogue.publishAsync(REMOTE_CLOCK_TOPICS.command, expired, { qos: 1, retain: false,
      properties: { messageExpiryInterval: 1 } });
    await delay(80);
    const afterLate = await producerStatus(child);
    assert.equal(afterLate.effects, beforeLate.effects, 'producer rejects expired original deadline before effect');
    assert.ok(afterLate.rejected > beforeLate.rejected);
    runtime.revoke(controlRoute);
    await until(() => stateRows.at(-1) === false && connector.status().rawPending === 0,
      'Stop/revoke safe state observed');
    const operations = controlRoute.operations();
    const beforeClose = connector.status();
    await connector.close();
    assert.equal(connector.status().state, 'closed');
    assert.equal(connector.status().rawPending, 0);
    return Object.freeze({ kind: 'clocked-mqtt-public-runtime-software-proof', producerClockId,
      profile: { id: manifest.id, decoderSha256: manifest.decoder.codeSha256 },
      connectionTopics: connectionRequest.topics, clockApprovalIndependent: true,
      deniedRoute: true, qualifiedSamples: sampleRows.length, observedStates: stateRows,
      commandEvidence: [firstEvidence, ...operations.map(row => row.effectEvidence)], brokerAccepted: beforeClose.brokerAccepted,
      producerEffects: afterLate.effects, freshSessionCommandIdOneAccepted: true, oldAckRejected: true,
      expiredRejected: true, forgedSourceRejected: true,
      stopClosedTransport: true,
      limits: { authorship: 'enrolled key holder, not physical sensor identity; broker ACL/TLS required outside loopback',
        scope: 'one signed boolean sample and command profile, bounded clean MQTT5 sessions per producer boot',
        expiry: 'original local deadline conservatively converted; issued command effect after revoke remains uncertain',
        physicalDevice: 'not tested', remoteBroker: 'not tested' } });
  } catch (error) {
    let producer;
    try { producer = await producerStatus(child); } catch { /* diagnostic only */ }
    throw new Error(`${error instanceof Error ? error.message : 'clocked-caller'} ${JSON.stringify({
      connector: connector.status(), operations: controlRoute?.operations(), stateRoute: stateRoute?.status(),
      stateRows, sampleRows: sampleRows.length, producer })}`);
  } finally {
    owner.abort(); connectionGrant.abort(); clockGrant.abort();
    for (const route of [controlRoute, stateRoute]) if (route) route.stop();
    await connector.close(); await rogue?.endAsync(true); runtime.close();
  }
}
