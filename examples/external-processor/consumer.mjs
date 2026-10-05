import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTemperatureBand } from '@example/temperature-band-processor';
import declaredManifest from '@example/temperature-band-processor/manifest.json' with { type: 'json' };
import { parseProcessorManifest, validateProcessorGraph } from '@101/device-model';
import { createDeviceRuntime, createProcessorFailureController, createProcessorRegistry } from '@101/device-runtime';

const manifest = parseProcessorManifest(declaredManifest);
const source = new Uint8Array(readFileSync(fileURLToPath(import.meta.resolve('@example/temperature-band-processor'))));
const registry = createProcessorRegistry();
await assert.rejects(registry.registerTrusted({ manifest, source: new TextEncoder().encode('changed code'),
  factory: createTemperatureBand }));
await registry.registerTrusted({ manifest, source, factory: createTemperatureBand });
const request = { id: manifest.id, version: manifest.version, codeSha256: manifest.codeSha256,
  configuration: { onAt: 30, offAt: 28 } };
assert.throws(() => registry.resolve({ ...request,
  configuration: { ...request.configuration, network: 'forbidden' } }));
assert.throws(() => registry.resolve({ ...request,
  configuration: { onAt: 20, offAt: 30 } }));
const processor = registry.resolve(request);

const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
const binary = { type: 'boolean' };
const sensor = { schemaVersion: 1, id: 'external-sensor', label: 'External sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'node' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1,
    kind: 'sample', value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 },
    permissions: ['subscribe'] }] };
const processorDevice = { schemaVersion: 1, id: 'external-processor', label: 'External processor', revision: 1,
  adapter: { id: 'example:processor', version: '1.0.0' }, runtime: { platform: 'node' },
  capabilities: [
    { id: 'temperature-input', semantic: 'example:temperature', schemaVersion: 1,
      kind: 'property', value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 },
      permissions: ['write'], ownership: { mode: 'observe' } },
    { id: 'switch-output', semantic: 'example:switch', schemaVersion: 1,
      kind: 'event', value: binary, delivery: { mode: 'reliable', maxAgeMs: 500 },
      permissions: ['subscribe'] },
  ] };
const relay = { schemaVersion: 1, id: 'external-relay', label: 'External relay', revision: 1,
  adapter: { id: 'example:relay', version: '1.0.0' }, runtime: { platform: 'node' },
  capabilities: [{ id: 'switch', semantic: 'example:switch', schemaVersion: 1,
    kind: 'command', value: binary, delivery: { mode: 'reliable', maxAgeMs: 500 },
    permissions: ['invoke'], ownership: { mode: 'exclusive' } }] };
const graph = { schemaVersion: 1, nodes: [
  { id: 'sensor', kind: 'resource', direction: 'source', device: sensor, capability: 'temperature' },
  { id: 'processor', kind: 'processor', manifest },
  { id: 'relay', kind: 'resource', direction: 'sink', device: relay, capability: 'switch' },
], edges: [
  { from: { node: 'sensor', port: 'temperature' }, to: { node: 'processor', port: 'temperature' } },
  { from: { node: 'processor', port: 'switch' }, to: { node: 'relay', port: 'switch' } },
] };
const plan = validateProcessorGraph(graph);
assert.deepEqual(plan.requiredOperations.map(item => item.operation), ['subscribe', 'invoke']);
assert.throws(() => validateProcessorGraph({ ...graph,
  nodes: graph.nodes.map(node => node.id === 'processor'
    ? { ...node, manifest: { ...declaredManifest,
      outputs: [{ id: 'switch', value: scalar }] } } : node) }));

let now = 100, sequence = 0;
const authorizations = [], effects = [];
const runtime = createDeviceRuntime({ now: () => now, authorize(permission) {
  authorizations.push(permission);
  if (permission.principalId !== 'owner' || permission.applicationId !== 'external-consumer' ||
      permission.sessionId !== 'local') return undefined;
  const input = permission.source.deviceId === sensor.id && permission.source.capabilityId === 'temperature' &&
    permission.sourceOperation === 'subscribe' && permission.sink.deviceId === processorDevice.id &&
    permission.sink.capabilityId === 'temperature-input' && permission.sinkOperation === 'write';
  const output = permission.source.deviceId === processorDevice.id && permission.source.capabilityId === 'switch-output' &&
    permission.sourceOperation === 'subscribe' && permission.sink.deviceId === relay.id &&
    permission.sink.capabilityId === 'switch' && permission.sinkOperation === 'invoke';
  return input || output ? { expiresAt: 10000, maxAgeMs: 1000, maxHz: 10 } : undefined;
} });
try {
  const sourceHandle = runtime.registerSource({ device: sensor, capability: 'temperature' });
  const derivedHandle = runtime.registerSource({ device: processorDevice, capability: 'switch-output' });
  let controller;
  const inputHandle = runtime.registerSink({ device: processorDevice, capability: 'temperature-input',
    apply(observation, context) {
      if (context.signal.aborted || !context.isCurrent()) return;
      controller.run('processor', { temperature: observation.value },
        { switch: { operationId: String(++sequence), deadline: now + 500 } });
    }, release() {} });
  const relayHandle = runtime.registerSink({ device: relay, capability: 'switch',
    apply(observation, context) { if (context.isCurrent()) effects.push(observation.value); },
    release() {} });
  for (const handle of [sourceHandle, derivedHandle, inputHandle, relayHandle])
    assert.equal(runtime.setReadiness(handle, 'available').ok, true);
  const identity = { principalId: 'owner', applicationId: 'external-consumer', sessionId: 'local' };
  const inputRoute = runtime.route({ from: sourceHandle, to: inputHandle, ...identity });
  const outputRoute = runtime.route({ from: derivedHandle, to: relayHandle, ...identity });
  assert.equal(inputRoute.start().ok, true);
  assert.equal(outputRoute.start().ok, true);
  const denied = runtime.route({ from: sourceHandle, to: inputHandle,
    ...identity, principalId: 'unapproved' });
  assert.equal(denied.start().reason, 'denied');
  controller = createProcessorFailureController({ plan, runtime, now: () => now,
    bindings: [{ node: 'processor', processor, outputs: { switch: derivedHandle }, inputRoutes: [inputRoute] }] });
  assert.equal(runtime.publish(sourceHandle, 31).ok, true);
  runtime.flush(); runtime.flush();
  assert.deepEqual(effects, [true]);
  now = 200;
  assert.equal(runtime.publish(sourceHandle, 27).ok, true);
  runtime.flush();
  assert.equal(outputRoute.status().pending, 1);
  runtime.revoke(inputRoute);
  assert.equal(controller.status('processor').state, 'failed');
  assert.equal(outputRoute.operations().at(-1).state, 'cancelled');
  runtime.flush();
  assert.deepEqual(effects, [true]);
  assert.equal(authorizations.filter(item => item.principalId === 'owner').length, 2);
  console.log(JSON.stringify({ status: 'pass', installedProcessor: manifest.id,
    pin: manifest.codeSha256, declaredOperations: plan.requiredOperations.map(item => item.operation),
    deniedPrincipal: true, incompatibleSchemaRejected: true, staleCommandCancelled: true }));
} finally { runtime.close(); }
