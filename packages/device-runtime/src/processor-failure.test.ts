import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProcessorManifest, validateProcessorGraph } from '@101/device-model';
import type { ProcessorManifest } from '@101/device-model';
import * as runtime from './index.ts';
import type { Connection, ResolvedProcessor } from './index.ts';

const create = (runtime as Record<string, unknown>).createProcessorFailureController as
  ((options: unknown) => {
    run(node: string, inputs: unknown, options?: unknown): { ok: boolean; emitted?: boolean; reason?: string };
    invalidate(node: string, reason: string): void;
    status(node: string): { state: string; reason?: string };
    stop(): void;
  }) | undefined;
const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 } as const;
const binary = { type: 'boolean' } as const;
const latest = { mode: 'latest', maxHz: 10, maxAgeMs: 1000 } as const;
const reliable = { mode: 'reliable', maxAgeMs: 500 } as const;
const sensor = { schemaVersion: 1, id: 'sensor', label: 'Sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1,
    kind: 'sample', value: scalar, delivery: latest, permissions: ['subscribe'] }] };
const middle = { schemaVersion: 1, id: 'middle', label: 'Middle', revision: 1,
  adapter: { id: 'example:middle', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [
    { id: 'temperature-in', semantic: 'example:temperature', schemaVersion: 1,
      kind: 'property', value: scalar, delivery: latest, permissions: ['write'], ownership: { mode: 'observe' } },
    { id: 'temperature-out', semantic: 'example:temperature', schemaVersion: 1,
      kind: 'sample', value: scalar, delivery: latest, permissions: ['subscribe'] },
  ] };
const last = { schemaVersion: 1, id: 'last', label: 'Last', revision: 1,
  adapter: { id: 'example:last', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [
    { id: 'temperature-in', semantic: 'example:temperature', schemaVersion: 1,
      kind: 'property', value: scalar, delivery: latest, permissions: ['write'], ownership: { mode: 'observe' } },
    { id: 'switch-out', semantic: 'example:switch', schemaVersion: 1,
      kind: 'event', value: binary, delivery: reliable, permissions: ['subscribe'] },
  ] };
const relay = { schemaVersion: 1, id: 'relay', label: 'Relay', revision: 1,
  adapter: { id: 'example:relay', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'switch', semantic: 'example:switch', schemaVersion: 1,
    kind: 'command', value: binary, delivery: reliable, permissions: ['invoke'],
    ownership: { mode: 'exclusive' } }] };
function manifest(id: string, input: string, output: string, outputValue: unknown): ProcessorManifest {
  return parseProcessorManifest({ schemaVersion: 1, id, version: '1.0.0', codeSha256: 'a'.repeat(64),
    inputs: [{ id: input, value: scalar }], outputs: [{ id: output, value: outputValue }],
    configuration: { type: 'record', fields: { gain: { type: 'scalar', unit: '1', min: 0, max: 2 } } },
    state: { mode: 'resettable', resetOn: ['input-loss', 'stop', 'reconfigure'] },
    assets: [], license: 'MIT', budgets: { maxComputeMs: 5, maxMemoryBytes: 65536, privacy: 'local-only' } });
}
const first = manifest('example:first', 'temperature', 'value', scalar);
const second = manifest('example:second', 'value', 'switch', binary);
const graph = validateProcessorGraph({ schemaVersion: 1, nodes: [
  { id: 'sensor', kind: 'resource', direction: 'source', device: sensor, capability: 'temperature' },
  { id: 'first', kind: 'processor', manifest: first },
  { id: 'second', kind: 'processor', manifest: second },
  { id: 'relay', kind: 'resource', direction: 'sink', device: relay, capability: 'switch' },
], edges: [
  { from: { node: 'sensor', port: 'temperature' }, to: { node: 'first', port: 'temperature' } },
  { from: { node: 'first', port: 'value' }, to: { node: 'second', port: 'value' } },
  { from: { node: 'second', port: 'switch' }, to: { node: 'relay', port: 'switch' } },
] });

function harness() {
  let clock = 0, firstResets = 0, secondResets = 0, fault: 'none' | 'throw' | 'timeout' = 'none';
  let commandSequence = 0;
  const effects: boolean[] = [];
  const local = runtime.createDeviceRuntime({ now: () => clock,
    authorize: () => ({ expiresAt: clock + 10000, maxAgeMs: 1000, maxHz: 10 }) });
  const input = local.registerSource({ device: sensor, capability: 'temperature' });
  const firstOutput = local.registerSource({ device: middle, capability: 'temperature-out' });
  const secondOutput = local.registerSource({ device: last, capability: 'switch-out' });
  let controller!: ReturnType<NonNullable<typeof create>>;
  const firstInput = local.registerSink({ device: middle, capability: 'temperature-in',
    apply(observation) { controller.run('first', { temperature: observation.value }); }, release() {} });
  const secondInput = local.registerSink({ device: last, capability: 'temperature-in',
    apply(observation) { controller.run('second', { value: observation.value },
      { switch: { operationId: String(++commandSequence), deadline: clock + 500 } }); }, release() {} });
  const output = local.registerSink({ device: relay, capability: 'switch',
    apply(observation, context) { if (context.isCurrent()) effects.push(Boolean(observation.value)); }, release() {} });
  for (const handle of [input, firstOutput, secondOutput, firstInput, secondInput, output])
    assert.equal(local.setReadiness(handle, 'available').ok, true);
  const request = { principalId: 'owner', applicationId: 'example:processor', sessionId: 'local' };
  const sourceRoute = local.route({ from: input, to: firstInput, ...request });
  const middleRoute = local.route({ from: firstOutput, to: secondInput, ...request });
  const commandRoute = local.route({ from: secondOutput, to: output, ...request });
  for (const route of [sourceRoute, middleRoute, commandRoute]) assert.equal(route.start().ok, true);
  const firstProcessor: ResolvedProcessor = { manifest: first,
    process(inputs) {
      if (fault === 'throw') throw new Error('processor exception');
      if (fault === 'timeout') clock += 6;
      const frame = inputs as { temperature: number };
      return { value: frame.temperature };
    }, reset() { firstResets++; } };
  let lastOutput: boolean | undefined;
  const secondProcessor: ResolvedProcessor = { manifest: second,
    process(inputs) { const next = Number((inputs as { value: number }).value) >= 30;
      if (next === lastOutput) return undefined;
      lastOutput = next; return { switch: next }; },
    reset() { lastOutput = undefined; secondResets++; } };
  assert.equal(typeof create, 'function');
  function bind(upstream: Connection, middleConnection: Connection) {
    return create!({ plan: graph, runtime: local, now: () => clock, bindings: [
      { node: 'first', processor: firstProcessor, outputs: { value: firstOutput }, inputRoutes: [upstream] },
      { node: 'second', processor: secondProcessor, outputs: { switch: secondOutput }, inputRoutes: [middleConnection] },
    ] });
  }
  controller = bind(sourceRoute, middleRoute);
  return { local, controller, input, firstOutput, secondOutput, sourceRoute, middleRoute, commandRoute,
    effects, fault: (value: typeof fault) => { fault = value; }, resets: () => [firstResets, secondResets],
    rebind() {
      controller.stop();
      for (const handle of [input, firstOutput, secondOutput]) assert.equal(local.setReadiness(handle, 'available').ok, true);
      const nextSource = local.route({ from: input, to: firstInput, ...request });
      const nextMiddle = local.route({ from: firstOutput, to: secondInput, ...request });
      const nextCommand = local.route({ from: secondOutput, to: output, ...request });
      for (const route of [nextSource, nextMiddle, nextCommand]) assert.equal(route.start().ok, true);
      controller = bind(nextSource, nextMiddle);
      return { controller, sourceRoute: nextSource, middleRoute: nextMiddle, commandRoute: nextCommand };
    } };
}

test('input loss cascades through processors and cancels an already queued command', () => {
  const h = harness();
  assert.equal(h.local.publish(h.input, 31).ok, true);
  h.local.flush(); h.local.flush();
  assert.equal(h.commandRoute.status().pending, 1);
  h.controller.invalidate('sensor', 'input-loss');
  assert.deepEqual(h.resets(), [1, 1]);
  assert.equal(h.sourceRoute.status().state, 'closed');
  assert.equal(h.middleRoute.status().state, 'closed');
  assert.equal(h.commandRoute.status().state, 'closed');
  assert.equal(h.commandRoute.operations()[0]?.state, 'cancelled');
  h.local.flush();
  assert.deepEqual(h.effects, []);
  assert.equal(h.controller.run('first', { temperature: 35 }).ok, false);
  h.local.close();
});

test('processor exceptions and compute overruns fail closed before publishing derived output', () => {
  for (const failure of ['throw', 'timeout'] as const) {
    const h = harness();
    h.fault(failure);
    assert.equal(h.local.publish(h.input, 31).ok, true);
    h.local.flush(); h.local.flush(); h.local.flush();
    assert.deepEqual(h.effects, []);
    assert.deepEqual(h.resets(), [1, 1]);
    assert.equal(h.controller.status('first').state, 'failed');
    assert.equal(h.commandRoute.status().state, 'closed');
    h.local.close();
  }
});

test('revoking an input route automatically invalidates descendants', () => {
  const h = harness();
  h.local.revoke(h.sourceRoute);
  assert.deepEqual(h.resets(), [1, 1]);
  assert.equal(h.controller.status('second').state, 'failed');
  assert.equal(h.local.publish(h.secondOutput, true, { operationId: '1', deadline: 500 }).ok, false);
  h.local.close();
});

test('restart needs fresh routes, resets state, and never replays the previous command', () => {
  const h = harness();
  assert.equal(h.local.publish(h.input, 31).ok, true);
  h.local.flush(); h.local.flush(); h.local.flush();
  assert.deepEqual(h.effects, [true]);
  h.local.revoke(h.sourceRoute);
  assert.deepEqual(h.resets(), [1, 1]);
  const restarted = h.rebind();
  assert.equal(restarted.commandRoute.status().pending, 0);
  h.local.flush();
  assert.deepEqual(h.effects, [true]);
  assert.equal(h.local.publish(h.input, 31).ok, true);
  h.local.flush(); h.local.flush(); h.local.flush();
  assert.deepEqual(h.effects, [true, true]);
  assert.equal(restarted.controller.status('second').state, 'active');
  h.local.close();
});
