import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from './index.ts';
import { DeviceValidationError } from '@101/device-model';

const create = (runtime as Record<string, unknown>).createDeviceSimulator as
  ((options: unknown) => runtime.DeviceSimulator) | undefined;
const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
const sensor = { schemaVersion: 1, id: 'sensor', label: 'Sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'embedded-simulation' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1, kind: 'sample',
    value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }] };
const display = { schemaVersion: 1, id: 'display', label: 'Display', revision: 1,
  adapter: { id: 'example:display', version: '1.0.0' }, runtime: { platform: 'embedded-simulation' },
  capabilities: [{ ...sensor.capabilities[0], id: 'temperature-input', kind: 'property', permissions: ['write'],
    ownership: { mode: 'exclusive' } }] };
const fixture = { sources: [{ id: 'thermometer', device: sensor, capability: 'temperature' }],
  sinks: [{ id: 'screen', device: display, capability: 'temperature-input' }],
  routes: [{ id: 'display-temperature', from: 'thermometer', to: 'screen',
    principalId: 'owner', applicationId: 'example:dashboard', sessionId: 'local-test' }] };

test('bounded typed replay drives the actual runtime and records only simulated effects', () => {
  assert.equal(typeof create, 'function');
  const simulator = create!(fixture);
  const results = simulator.replay([
    { at: 0, kind: 'grant', routeId: 'display-temperature' },
    { at: 0, kind: 'connect', routeId: 'display-temperature' },
    { at: 10, kind: 'sample', sourceId: 'thermometer', value: 31 },
    { at: 10, kind: 'flush' },
  ]);
  assert.ok(results.every(item => item.ok));
  assert.deepEqual(simulator.events(), [{ at: 10, kind: 'delivery', sinkId: 'screen', value: 31 }]);
  simulator.close();
});

test('revocation cancels queued delivery and requires a new route generation', () => {
  assert.equal(typeof create, 'function');
  const simulator = create!(fixture);
  simulator.replay([{ at: 0, kind: 'grant', routeId: 'display-temperature' },
    { at: 0, kind: 'connect', routeId: 'display-temperature' },
    { at: 10, kind: 'sample', sourceId: 'thermometer', value: 31 },
    { at: 10, kind: 'revoke', routeId: 'display-temperature' },
    { at: 10, kind: 'flush' }]);
  assert.deepEqual(simulator.events(), [{ at: 10, kind: 'release', sinkId: 'screen', reason: 'revoked' }]);
  assert.deepEqual(simulator.replay([{ at: 20, kind: 'connect', routeId: 'display-temperature' }])[0],
    { ok: false, reason: 'denied' });
  simulator.replay([{ at: 30, kind: 'grant', routeId: 'display-temperature' },
    { at: 30, kind: 'connect', routeId: 'display-temperature' },
    { at: 40, kind: 'flush' }]);
  assert.equal(simulator.events().filter(item => item.kind === 'delivery').length, 0);
  simulator.replay([{ at: 50, kind: 'sample', sourceId: 'thermometer', value: 29 }, { at: 50, kind: 'flush' }]);
  assert.deepEqual(simulator.events().at(-1), { at: 50, kind: 'delivery', sinkId: 'screen', value: 29 });
  simulator.close();
});

test('disconnect releases ownership and reconnection needs a fresh grant', () => {
  assert.equal(typeof create, 'function');
  const simulator = create!(fixture);
  simulator.replay([{ at: 0, kind: 'grant', routeId: 'display-temperature' },
    { at: 0, kind: 'connect', routeId: 'display-temperature' },
    { at: 20, kind: 'disconnect', endpointId: 'thermometer' }]);
  assert.deepEqual(simulator.events(), [{ at: 20, kind: 'release', sinkId: 'screen', reason: 'unavailable' }]);
  assert.deepEqual(simulator.replay([{ at: 30, kind: 'reconnect', endpointId: 'thermometer' },
    { at: 30, kind: 'connect', routeId: 'display-temperature' }]).at(-1), { ok: false, reason: 'denied' });
  assert.equal(simulator.replay([{ at: 40, kind: 'grant', routeId: 'display-temperature' },
    { at: 40, kind: 'connect', routeId: 'display-temperature' }]).at(-1)?.ok, true);
  simulator.close();
});

test('source loss clears pending delivery and marks the route stale', () => {
  assert.equal(typeof create, 'function');
  const simulator = create!(fixture);
  const results = simulator.replay([{ at: 0, kind: 'grant', routeId: 'display-temperature' },
    { at: 0, kind: 'connect', routeId: 'display-temperature' },
    { at: 10, kind: 'sample', sourceId: 'thermometer', value: 31 },
    { at: 10, kind: 'loss', sourceId: 'thermometer' },
    { at: 10, kind: 'flush' }]);
  assert.ok(results.every(item => item.ok));
  assert.deepEqual(simulator.events(), [{ at: 10, kind: 'release', sinkId: 'screen', reason: 'stale' }]);
  assert.deepEqual(simulator.replay([{ at: 20, kind: 'reconnect', endpointId: 'thermometer' },
    { at: 20, kind: 'connect', routeId: 'display-temperature' }]).at(-1), { ok: false, reason: 'denied' });
  simulator.close();
});

test('malformed scripts reject before any step, and typed invalid samples do not deliver', () => {
  assert.equal(typeof create, 'function');
  const simulator = create!(fixture);
  for (const script of [
    [{ at: 0, kind: 'grant', routeId: 'display-temperature' }, { at: -1, kind: 'flush' }],
    Array.from({ length: 257 }, (_, at) => ({ at, kind: 'flush' })),
    [{ at: 0, kind: 'unknown' }],
  ]) assert.throws(() => simulator.replay(script), DeviceValidationError);
  let reads = 0;
  const getter = Object.defineProperty({ at: 0, kind: 'sample', sourceId: 'thermometer' }, 'value',
    { enumerable: true, get() { reads++; return 31; } });
  assert.throws(() => simulator.replay([getter]), DeviceValidationError);
  assert.equal(reads, 0);
  assert.deepEqual(simulator.replay([{ at: 0, kind: 'connect', routeId: 'display-temperature' }])[0],
    { ok: false, reason: 'denied' });
  simulator.replay([{ at: 0, kind: 'grant', routeId: 'display-temperature' },
    { at: 0, kind: 'connect', routeId: 'display-temperature' }]);
  assert.equal(simulator.replay([{ at: 10, kind: 'sample', sourceId: 'thermometer', value: 'hot' },
    { at: 10, kind: 'flush' }])[0]?.ok, false);
  assert.deepEqual(simulator.events(), []);
  simulator.close();
});
