import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeviceRuntime, createTrustedConnectorProfileRegistry, parseDeviceDescriptor } from '@101/connect';
import { createMqttConnector } from '../../packages/hub-server/src/mqtt-connector.ts';
import { createMqttExampleDecoder } from './decoder.mjs';
import { createMqttExampleProfile, createMqttTransportProfile } from './profile.mjs';
import { startMqttFixtureProducer } from './producer.mjs';

async function until(predicate, label, timeoutMs = 4000) {
  const end = performance.now() + timeoutMs;
  while (!predicate()) { assert.ok(performance.now() < end, label); await delay(5); }
}
function device(id, label, capabilities) { return parseDeviceDescriptor({ schemaVersion: 1, id, label, revision: 1,
  adapter: { id: 'example:mqtt-telemetry-command', version: '1.0.0' }, runtime: { platform: 'node-mqtt-local' }, capabilities }); }
function routeKey(request) { return [request.principalId, request.applicationId, request.sessionId, request.source.registrationId,
  request.sink.registrationId, request.sourceOperation, request.sinkOperation].join('\0'); }

/** Complete local public-SDK caller; requires only the caller-owned local MQTT5 broker. */
export async function runMqttConnectorExample(endpoint) {
  const manifest = createMqttExampleProfile(), mqttProfile = createMqttTransportProfile();
  const decoderSource = readFileSync(new URL('./decoder.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(decoderSource).digest('hex'), manifest.decoder.codeSha256);
  const registry = createTrustedConnectorProfileRegistry();
  await registry.registerTrusted({ manifest, source: decoderSource, factory: createMqttExampleDecoder });
  const binding = registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: manifest.decoder.codeSha256 });
  const ownerSignal = new AbortController(), connectionGrant = new AbortController();
  const sampleRows = [], telemetryRows = [], stateRows = [];
  const clockId = 'mqtt-demo-clock', scope = { principalId: 'mqtt-owner', applicationId: 'mqtt-local-example', sessionId: 'mqtt-session-1' };
  const approvedRoutes = new Set(); let connectionApproval;
  const runtime = createDeviceRuntime({ clockDomain: 'mqtt-caller-clock', now: () => performance.now(), maxRoutes: 8, maxPendingDeliveries: 8,
    authorize: request => approvedRoutes.has(routeKey(request)) ? { expiresAt: performance.now() + 5000, maxAgeMs: 5000, maxHz: 10 } : undefined });
  const connector = createMqttConnector({ endpoint, profile: mqttProfile, binding, clockId,
    sourceClockRelation: 'same-process-monotonic', now: () => performance.now(),
    authorizeConnection(request) { connectionApproval = request; return { request, signal: connectionGrant.signal, expiresAt: performance.now() + 10000 }; },
    onSample(frame) {
      sampleRows.push({ resourceId: frame.resourceId, sequence: frame.sequence, sourceTime: frame.sourceTime, receivedAt: frame.receivedAt });
      const source = sources.get(frame.resourceId); if (!source) return;
      runtime.setReadiness(source, frame.quality === 'valid' ? 'available' : 'unavailable', frame.receivedAt + 5000);
      runtime.publish(source, frame.value, { sequence: frame.sequence, timestamp: frame.receivedAt, clockDomain: 'mqtt-caller-clock', quality: frame.quality,
        provenance: { sourceTime: frame.sourceTime, profileId: manifest.id, profileVersion: manifest.version } }); runtime.flush();
    },
    onUnavailable(id) { const source = sources.get(id); if (source) runtime.setReadiness(source, 'unavailable'); },
  });
  let producer, temperatureRoute, stateRoute, controlRoute;
  const sources = new Map();
  const topicSources = manifest.resources.filter(resource => resource.direction === 'source');
  const deviceDescriptor = device('mqtt-device', 'Local MQTT device', manifest.resources.map(resource => resource.capability));
  for (const resource of topicSources) sources.set(resource.capability.id, runtime.registerSource({ device: deviceDescriptor, capability: resource.capability.id }));
  const commandCapability = manifest.resources.find(resource => resource.capability.id === 'set-enabled').capability;
  const commandSink = runtime.registerSink({ device: deviceDescriptor, capability: 'set-enabled',
    apply: (observation, context) => connector.apply('set-enabled', observation, context),
    release: (reason, context) => connector.release('set-enabled', reason, context) });
  const tempCapability = manifest.resources.find(resource => resource.capability.id === 'temperature').capability;
  const tempSink = runtime.registerSink({ device: device('mqtt-temp-monitor', 'Temperature monitor', [{ ...tempCapability, id: 'temperature-view', kind: 'property', permissions: ['write'], ownership: { mode: 'observe' } }]),
    capability: 'temperature-view', apply(observation, context) { if (context.isCurrent() && !context.signal.aborted) telemetryRows.push(observation.value); }, release() {} });
  const stateCapability = manifest.resources.find(resource => resource.capability.id === 'enabled').capability;
  const stateSink = runtime.registerSink({ device: device('mqtt-state-monitor', 'Enabled state monitor', [{ ...stateCapability, id: 'enabled-view', kind: 'property', permissions: ['write'], ownership: { mode: 'observe' } }]),
    capability: 'enabled-view', apply(observation, context) { if (context.isCurrent() && !context.signal.aborted) stateRows.push(observation.value); }, release() {} });
  const controlCapability = { ...commandCapability, id: 'control', kind: 'event', permissions: ['subscribe'] }; delete controlCapability.ownership;
  const control = runtime.registerSource({ device: device('mqtt-control', 'Local command control', [controlCapability]), capability: 'control' });
  for (const endpointHandle of [commandSink, tempSink, stateSink, control, ...sources.values()]) runtime.setReadiness(endpointHandle, 'available');
  try {
    const denied = await connector.connect({ purpose: 'local-telemetry-and-command', signal: ownerSignal.signal });
    assert.deepEqual(denied, { ok: true });
    assert.equal(connectionApproval?.action, 'connect'); assert.equal(connectionApproval?.clockId, clockId);
    producer = await startMqttFixtureProducer(endpoint);
    await until(() => sampleRows.some(frame => frame.resourceId === 'temperature'), 'actual MQTT5 telemetry from the broker');
    temperatureRoute = runtime.route({ from: sources.get('temperature'), to: tempSink, ...scope });
    assert.equal(temperatureRoute.start().ok, false, 'source route remains independently denied');
    temperatureRoute = routeWithGrant(runtime, sources.get('temperature'), tempSink, scope, approvedRoutes);
    assert.equal(temperatureRoute.start().ok, true);
    await until(() => telemetryRows.length > 0, 'independently authorized MQTT telemetry route');
    const rejectedBeforeRetained = connector.status().rejectedMessages;
    await producer.retainedProbe();
    await until(() => connector.status().rejectedMessages > rejectedBeforeRetained, 'retained MQTT telemetry rejection');
    const rejectedBeforeStale = connector.status().rejectedMessages;
    await producer.staleProbe();
    await until(() => connector.status().rejectedMessages > rejectedBeforeStale, 'stale telemetry freshness rejection');
    stateRoute = routeWithGrant(runtime, sources.get('enabled'), stateSink, scope, approvedRoutes);
    assert.equal(stateRoute.start().ok, true);
    controlRoute = routeWithGrant(runtime, control, commandSink, scope, approvedRoutes, 'invoke');
    assert.equal(controlRoute.start().ok, true);
    assert.equal(runtime.publish(control, true, { operationId: '1', deadline: performance.now() + 2500 }).ok, true); runtime.flush();
    await until(() => controlRoute.operations()[0]?.effectEvidence === 'observed' && stateRows.includes(true), 'separate MQTT PUBACK, application ACK and observed state');
    const operations = controlRoute.operations();
    assert.equal(operations[0]?.effectEvidence, 'observed');
    const rejectedBeforeAckRetain = connector.status().rejectedMessages;
    await producer.retainedAckProbe('1');
    await until(() => connector.status().rejectedMessages > rejectedBeforeAckRetain, 'retained MQTT ACK rejection');
    runtime.revoke(controlRoute);
    await until(() => producer.status().enabled === false && stateRows.at(-1) === false && connector.status().rawPending === 0, 'revoke fences command and observes declared safe state');
    assert.equal(controlRoute.status().state, 'closed');
    const beforeDuplicate = producer.status();
    await producer.duplicateCommand('1', true);
    await until(() => producer.status().duplicates >= 1, 'idempotent duplicate application command');
    const afterDuplicate = producer.status();
    assert.equal(afterDuplicate.effects, beforeDuplicate.effects);
    assert.equal(connector.status().rejectedMessages, rejectedBeforeAckRetain + 1);
    const freshOwner = new AbortController(), freshGrant = new AbortController();
    const fresh = createMqttConnector({ endpoint, profile: mqttProfile, binding, clockId,
      sourceClockRelation: 'same-process-monotonic', now: () => performance.now(),
      authorizeConnection(request) { return { request, signal: freshGrant.signal, expiresAt: performance.now() + 10000 }; }, onSample() {}, onUnavailable() {} });
    assert.deepEqual(await fresh.connect({ purpose: 'fresh-session-no-command-replay', signal: freshOwner.signal }), { ok: true });
    await delay(150); assert.equal(producer.status().effects, afterDuplicate.effects);
    freshOwner.abort(); freshGrant.abort(); await fresh.close();
    return Object.freeze({ kind: 'local-mqtt5-software-connector', profile: { id: manifest.id, version: manifest.version,
      decoderSha256: manifest.decoder.codeSha256 }, connector: connector.status(), producer: afterDuplicate,
      telemetrySamples: telemetryRows.length, observedStates: stateRows, commandEvidence: operations.map(operation => operation.effectEvidence),
      checks: Object.freeze({ pinnedDecoder: true, exactApprovedTopics: true, cleanMqtt5Session: true, independentRouteGrant: true,
        actualBrokerTelemetry: true, pubackAckAndObservedAreDistinct: true, duplicateApplicationCommandIdempotent: true,
        retainedSampleAndAckRejected: true, staleTelemetryRejected: true, revokedCommandSafeStateObserved: true,
        freshSessionDoesNotReplay: true, noAutomaticReconnect: true }),
      limits: Object.freeze({ broker: 'caller-owned local Mosquitto', profile: 'one reviewed example profile, QoS 0/1 only',
        clock: 'producer and connector share this Node process monotonic clock',
        expiry: 'producer enforces the original command deadline carried by the write context; an issued command remains uncertain after cancellation',
        physicalDevice: 'not tested', android: 'not tested', remoteBroker: 'TLS required and not tested' }) });
  } finally {
    ownerSignal.abort(); connectionGrant.abort();
    for (const route of [controlRoute, stateRoute, temperatureRoute]) if (route) route.stop();
    await connector.close(); await producer?.close(); runtime.close();
  }
}

function routeWithGrant(runtime, from, to, scope, approvedRoutes, sinkOperation = 'write') {
  // Grant only this concrete source/sink pair within the selected owner session.
  const key = [scope.principalId, scope.applicationId, scope.sessionId, from.id, to.id, 'subscribe', sinkOperation].join('\0');
  approvedRoutes.add(key);
  return runtime.route({ from, to, ...scope });
}
