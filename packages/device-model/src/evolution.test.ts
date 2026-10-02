import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceValidationError, parseDeviceDescriptor } from './descriptor.ts';
import { planDescriptorEvolution } from './evolution.ts';

const capability = { id: 'temperature', semantic: 'example:temperature', schemaVersion: 1,
  kind: 'sample', value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
  delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] } as const;
const old = { schemaVersion: 1, id: 'thermometer', label: 'Thermometer', revision: 1,
  adapter: { id: 'example:thermometer', version: '1.0.0' }, runtime: { platform: 'embedded' },
  capabilities: [capability] } as const;

test('additive revision and inert extension changes preserve existing route contracts', () => {
  const next = { ...old, revision: 2, label: 'Room thermometer', extensions: { 'vendor:feature': { authorize: true } },
    capabilities: [capability, { ...capability, id: 'humidity', semantic: 'example:humidity',
      value: { type: 'scalar', unit: '%', min: 0, max: 100 } }] };
  const plan = planDescriptorEvolution(old, next);
  assert.deepEqual(plan, { compatibility: 'compatible', addedCapabilities: ['humidity'] });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.addedCapabilities), true);
  assert.deepEqual(parseDeviceDescriptor(next).extensions, { 'vendor:feature': { authorize: true } });
  assert.deepEqual(planDescriptorEvolution(next, { ...next, revision: 3,
    capabilities: [...next.capabilities].reverse() }), { compatibility: 'compatible', addedCapabilities: [] });
});

test('identity, permission, schema, delivery and removals are incompatible', () => {
  const changed = [
    { ...old, revision: 2, id: 'other' },
    { ...old, revision: 2, adapter: { id: 'example:other', version: '1.0.0' } },
    { ...old, revision: 2, capabilities: [] },
    { ...old, revision: 2, capabilities: [{ ...capability, permissions: ['subscribe', 'read'] }] },
    { ...old, revision: 2, capabilities: [{ ...capability, schemaVersion: 2 }] },
    { ...old, revision: 2, capabilities: [{ ...capability, delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 1000 } }] },
    { ...old, revision: 2, capabilities: [{ ...capability, value: { type: 'scalar', unit: 'K', min: 0, max: 400 } }] },
  ];
  for (const next of changed) assert.equal(planDescriptorEvolution(old, next).compatibility, 'incompatible');
  assert.deepEqual(planDescriptorEvolution(old, old), { compatibility: 'incompatible', reason: 'revision' });
  assert.deepEqual(planDescriptorEvolution({ ...old, revision: 2 }, old), { compatibility: 'incompatible', reason: 'revision' });
});

test('malformed revisions and unknown types reject before compatibility planning', () => {
  assert.throws(() => planDescriptorEvolution(old, { ...old, revision: 2, executable: true }), DeviceValidationError);
  assert.throws(() => planDescriptorEvolution(old, { ...old, revision: 2,
    capabilities: [{ ...capability, kind: 'unknown-job' }] }), DeviceValidationError);
  assert.throws(() => planDescriptorEvolution(old, { ...old, schemaVersion: 2, revision: 2 }), DeviceValidationError);
});
