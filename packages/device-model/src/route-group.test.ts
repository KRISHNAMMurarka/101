import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from './index.ts';

const plan = (model as Record<string, unknown>).planRouteGroup as
  ((contract: unknown, devices: unknown) => model.RouteGroupPlan) | undefined;
const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
const source = { schemaVersion: 1, id: 'sensor', label: 'Temperature sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1, kind: 'sample',
    value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }] };
const processor = { schemaVersion: 1, id: 'processor', label: 'Temperature processor', revision: 1,
  adapter: { id: 'example:processor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [
    { ...source.capabilities[0], id: 'temperature-input', kind: 'property', permissions: ['write'] },
    { id: 'relay-state', semantic: 'example:relay-state', schemaVersion: 1, kind: 'event',
      value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['subscribe'] },
  ] };
const relay = { schemaVersion: 1, id: 'relay', label: 'Relay', revision: 1,
  adapter: { id: 'example:relay', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ ...processor.capabilities[1], id: 'set-state', kind: 'command', permissions: ['invoke'] }] };
const compensation = { prepared: 'release-grant', active: 'stop-route', physicalEffects: 'not-undone' };
const consent = { purpose: 'Local temperature feedback', sourceOwner: 'required', sinkOwner: 'required' };
const contract = { schemaVersion: 1, id: 'example:temperature-feedback', members: [
  { id: 'measure', required: true,
    from: { deviceId: 'sensor', capability: 'temperature', operation: 'subscribe' },
    to: { deviceId: 'processor', capability: 'temperature-input', operation: 'write' },
    startAfter: [], consent, compensation, safeState: { mode: 'provider-release' } },
  { id: 'actuate', required: true,
    from: { deviceId: 'processor', capability: 'relay-state', operation: 'subscribe' },
    to: { deviceId: 'relay', capability: 'set-state', operation: 'invoke' },
    startAfter: ['measure'], consent, compensation,
    safeState: { mode: 'authorized-command', value: false, authority: 'fresh-owner-grant' } },
], failure: { required: 'stop-all', optional: 'continue-degraded' } };
const devices = [source, processor, relay];

test('route-group plan validates actual typed routes, consent and stable startup order', () => {
  assert.equal(typeof plan, 'function');
  const result = plan!(contract, devices);
  assert.deepEqual(result.startupOrder, ['measure', 'actuate']);
  assert.deepEqual(result.requiredOperations.map(item => [item.member, item.side, item.operation]), [
    ['measure', 'source', 'subscribe'], ['measure', 'sink', 'write'],
    ['actuate', 'source', 'subscribe'], ['actuate', 'sink', 'invoke'],
  ]);
  assert.equal(result.members[1]?.safeState.mode, 'authorized-command');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.members[0]?.consent), true);
});

test('optional member may degrade only when no required member depends on it', () => {
  assert.equal(typeof plan, 'function');
  const optional = { ...contract, members: [contract.members[0], { ...contract.members[1], required: false }] };
  assert.deepEqual(plan!(optional, devices).startupOrder, ['measure', 'actuate']);
  const unsafe = { ...contract, members: [{ ...contract.members[0], required: false }, contract.members[1]] };
  assert.throws(() => plan!(unsafe, devices), model.DeviceValidationError);
  assert.doesNotThrow(() => plan!({ ...unsafe, failure: { required: 'stop-all', optional: 'stop-all' } }, devices));
});

test('missing consent, unsafe compensation and untyped safe command fail closed', () => {
  assert.equal(typeof plan, 'function');
  for (const bad of [
    { ...contract, members: [{ ...contract.members[0], consent: { ...consent, sinkOwner: 'implicit' } }, contract.members[1]] },
    { ...contract, members: [{ ...contract.members[0], compensation: { ...compensation, physicalEffects: 'undone' } }, contract.members[1]] },
    { ...contract, members: [contract.members[0], { ...contract.members[1], safeState: { ...contract.members[1].safeState, value: 'off' } }] },
    { ...contract, members: [contract.members[0], { ...contract.members[1], safeState: { mode: 'authorized-command', value: false } }] },
    { ...contract, members: [{ ...contract.members[0], safeState: { mode: 'authorized-command', value: 0,
      authority: 'fresh-owner-grant' } }, contract.members[1]] },
  ]) assert.throws(() => plan!(bad, devices), model.DeviceValidationError);
});

test('unknown and incompatible resources, undeclared operations and duplicate routes fail', () => {
  assert.equal(typeof plan, 'function');
  for (const bad of [
    { ...contract, members: [{ ...contract.members[0], from: { ...contract.members[0].from, deviceId: 'missing' } }, contract.members[1]] },
    { ...contract, members: [{ ...contract.members[0], from: { ...contract.members[0].from, operation: 'read' } }, contract.members[1]] },
    { ...contract, members: [{ ...contract.members[0], to: { ...contract.members[0].to, capability: 'relay-state' } }, contract.members[1]] },
    { ...contract, members: [contract.members[0], { ...contract.members[1], id: 'actuate', from: contract.members[0].from, to: contract.members[0].to }] },
  ]) assert.throws(() => plan!(bad, devices), model.DeviceValidationError);
});

test('startup dependencies reject cycles, unknown members and repeated names', () => {
  assert.equal(typeof plan, 'function');
  for (const bad of [
    { ...contract, members: [{ ...contract.members[0], startAfter: ['actuate'] }, contract.members[1]] },
    { ...contract, members: [contract.members[0], { ...contract.members[1], startAfter: ['missing'] }] },
    { ...contract, members: [contract.members[0], { ...contract.members[1], id: 'measure' }] },
    { ...contract, schemaVersion: 2 },
  ]) assert.throws(() => plan!(bad, devices), model.DeviceValidationError);
});
