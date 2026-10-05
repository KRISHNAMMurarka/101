import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProcessorGraph } from './index.ts';

const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
const sensor = { schemaVersion: 1, id: 'sensor', label: 'Sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1,
    kind: 'sample', value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 },
    permissions: ['subscribe'] }] };
const relay = { schemaVersion: 1, id: 'relay', label: 'Relay', revision: 1,
  adapter: { id: 'example:relay', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'set-state', semantic: 'example:set-state', schemaVersion: 1,
    kind: 'command', value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 },
    permissions: ['invoke'] }] };
const threshold = { schemaVersion: 1, id: 'example:threshold', version: '1.0.0', codeSha256: 'a'.repeat(64),
  inputs: [{ id: 'temperature', value: scalar }], outputs: [{ id: 'switch', value: { type: 'boolean' } }],
  configuration: { type: 'record', fields: {
    onAt: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
    offAt: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
  } },
  state: { mode: 'resettable', resetOn: ['input-loss', 'stop', 'reconfigure'] },
  assets: [], license: 'MIT', budgets: { maxComputeMs: 5, maxMemoryBytes: 65536, privacy: 'local-only' } };
const graph = { schemaVersion: 1, nodes: [
  { id: 'sensor', kind: 'resource', direction: 'source', device: sensor, capability: 'temperature' },
  { id: 'threshold', kind: 'processor', manifest: threshold },
  { id: 'relay', kind: 'resource', direction: 'sink', device: relay, capability: 'set-state' },
], edges: [
  { from: { node: 'sensor', port: 'temperature' }, to: { node: 'threshold', port: 'temperature' } },
  { from: { node: 'threshold', port: 'switch' }, to: { node: 'relay', port: 'set-state' } },
] };

test('graph validates exact ports and reports required resource operations without granting them', () => {
  const plan = validateProcessorGraph(graph);
  assert.deepEqual(plan.executionOrder, ['sensor', 'threshold', 'relay']);
  assert.deepEqual(plan.requiredOperations, [
    { node: 'sensor', deviceId: 'sensor', capability: 'temperature', operation: 'subscribe' },
    { node: 'relay', deviceId: 'relay', capability: 'set-state', operation: 'invoke' },
  ]);
  assert.equal(Object.isFrozen(plan.edges[0]), true);
});

test('graph rejects undeclared conversion, unavailable permissions and ambiguous ports', () => {
  for (const bad of [
    { ...graph, schemaVersion: 2 },
    { ...graph, nodes: graph.nodes.map((node) => node.id === 'threshold' ? {
      ...node, manifest: { ...threshold, inputs: [{ id: 'temperature', value: { ...scalar, unit: 'K' } }] },
    } : node) },
    { ...graph, nodes: graph.nodes.map((node) => node.id === 'sensor' ? {
      ...node, device: { ...sensor, capabilities: [{ ...sensor.capabilities[0], permissions: ['read'] }] },
    } : node) },
    { ...graph, nodes: graph.nodes.map((node) => node.id === 'relay' ? {
      ...node, device: { ...relay, capabilities: [{ ...relay.capabilities[0], permissions: ['subscribe'] }] },
    } : node) },
    { ...graph, edges: [...graph.edges, graph.edges[0]] },
    { ...graph, edges: [{ ...graph.edges[0], to: { node: 'threshold', port: 'missing' } }, graph.edges[1]] },
  ]) assert.throws(() => validateProcessorGraph(bad));
});

test('zero-delay cycles fail and delayed feedback requires explicit finite bounds', () => {
  const passing = { ...threshold, inputs: [{ id: 'input', value: scalar }, { id: 'loop', value: scalar }],
    outputs: [{ id: 'out', value: scalar }] };
  const follower = { ...threshold, id: 'example:follower', inputs: [{ id: 'input', value: scalar }],
    outputs: [{ id: 'out', value: scalar }] };
  const scalarSink = { ...relay, capabilities: [{ ...relay.capabilities[0], value: scalar }] };
  const cyclic = { schemaVersion: 1, nodes: [
    graph.nodes[0],
    { id: 'first', kind: 'processor', manifest: passing },
    { id: 'second', kind: 'processor', manifest: follower },
    { id: 'sink', kind: 'resource', direction: 'sink', device: scalarSink, capability: 'set-state' },
  ], edges: [
    { from: { node: 'sensor', port: 'temperature' }, to: { node: 'first', port: 'input' } },
    { from: { node: 'first', port: 'out' }, to: { node: 'second', port: 'input' } },
    { from: { node: 'second', port: 'out' }, to: { node: 'sink', port: 'set-state' } },
    { from: { node: 'second', port: 'out' }, to: { node: 'first', port: 'loop' } },
  ] };
  assert.throws(() => validateProcessorGraph(cyclic));
  for (const feedback of [
    { delayMs: 0, maxAgeMs: 100, maxPending: 2, maxIterations: 4 },
    { delayMs: 10, maxAgeMs: 5, maxPending: 2, maxIterations: 4 },
    { delayMs: 10, maxAgeMs: 100, maxPending: 0, maxIterations: 4 },
    { delayMs: 10, maxAgeMs: 100, maxPending: 2 },
  ]) assert.throws(() => validateProcessorGraph({ ...cyclic, edges: [
    ...cyclic.edges.slice(0, 3), { ...cyclic.edges[3], feedback },
  ] }));
  const accepted = validateProcessorGraph({ ...cyclic, edges: [
    ...cyclic.edges.slice(0, 3), { ...cyclic.edges[3],
      feedback: { delayMs: 10, maxAgeMs: 100, maxPending: 2, maxIterations: 4 } },
  ] });
  assert.deepEqual(accepted.executionOrder, ['sensor', 'first', 'second', 'sink']);
  assert.equal(accepted.edges[3]?.feedback?.maxIterations, 4);
});
