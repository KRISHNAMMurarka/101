import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRuntime } from './index.ts';
import * as runtimeApi from './index.ts';
import type { RouteGroupMember } from '@101/device-model';

const createGroup = (runtimeApi as Record<string, unknown>).createRouteGroupController as
  ((contract: unknown, devices: unknown, connect: (member: RouteGroupMember) => runtimeApi.Connection) =>
    runtimeApi.RouteGroupController) | undefined;
const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
const sensor = { schemaVersion: 1, id: 'sensor', label: 'Sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1, kind: 'sample',
    value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }] };
const processor = { schemaVersion: 1, id: 'processor', label: 'Processor', revision: 1,
  adapter: { id: 'example:processor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [
    { ...sensor.capabilities[0], id: 'temperature-input', kind: 'property', permissions: ['write'], ownership: { mode: 'observe' } },
    { id: 'relay-state', semantic: 'example:relay-state', schemaVersion: 1, kind: 'event',
      value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['subscribe'] },
  ] };
const relay = { schemaVersion: 1, id: 'relay', label: 'Relay', revision: 1,
  adapter: { id: 'example:relay', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ ...processor.capabilities[1], id: 'set-state', kind: 'command', permissions: ['invoke'],
    ownership: { mode: 'exclusive' } }] };
const compensation = { prepared: 'release-grant', active: 'stop-route', physicalEffects: 'not-undone' };
const consent = { purpose: 'Local feedback', sourceOwner: 'required', sinkOwner: 'required' };
const contract = { schemaVersion: 1, id: 'example:feedback', members: [
  { id: 'measure', required: true, from: { deviceId: 'sensor', capability: 'temperature', operation: 'subscribe' },
    to: { deviceId: 'processor', capability: 'temperature-input', operation: 'write' },
    startAfter: [], consent, compensation, safeState: { mode: 'provider-release' } },
  { id: 'actuate', required: true, from: { deviceId: 'processor', capability: 'relay-state', operation: 'subscribe' },
    to: { deviceId: 'relay', capability: 'set-state', operation: 'invoke' },
    startAfter: ['measure'], consent, compensation,
    safeState: { mode: 'authorized-command', value: false, authority: 'fresh-owner-grant' } },
], failure: { required: 'stop-all', optional: 'continue-degraded' } };

function fixture(authorize: (sinkId: string) => boolean) {
  const grants: string[] = [], delivered: string[] = [], released: string[] = [];
  const runtime = createDeviceRuntime({ now: () => 0, authorize(request) {
    grants.push(request.sink.deviceId);
    return authorize(request.sink.deviceId) ? { expiresAt: 10000, maxAgeMs: 1000, maxHz: 10 } : undefined;
  } });
  const source = runtime.registerSource({ device: sensor, capability: 'temperature' });
  const derived = runtime.registerSource({ device: processor, capability: 'relay-state' });
  const input = runtime.registerSink({ device: processor, capability: 'temperature-input',
    apply() { delivered.push('measure'); }, release() { released.push('measure'); } });
  const output = runtime.registerSink({ device: relay, capability: 'set-state',
    apply() { delivered.push('actuate'); }, release() { released.push('actuate'); } });
  for (const handle of [source, derived, input, output]) runtime.setReadiness(handle, 'available');
  const connections = new Map<string, runtimeApi.Connection>();
  const connect = (member: RouteGroupMember) => {
    const connection = runtime.route({ from: member.id === 'measure' ? source : derived,
      to: member.id === 'measure' ? input : output, principalId: 'owner', applicationId: 'example:feedback', sessionId: 'local' });
    connections.set(member.id, connection);
    return connection;
  };
  return { runtime, source, derived, input, output, connections, grants, delivered, released, connect };
}

test('group prepares every owner grant and lease before activating either required route', () => {
  assert.equal(typeof createGroup, 'function');
  const h = fixture(() => true);
  const group = createGroup!(contract, [sensor, processor, relay], h.connect);
  assert.equal(group.prepare().ok, true);
  assert.deepEqual(h.grants, ['processor', 'relay']);
  assert.deepEqual([...h.connections.values()].map(item => item.status().state), ['prepared', 'prepared']);
  h.runtime.publish(h.source, 31); h.runtime.flush();
  assert.deepEqual(h.delivered, []);
  assert.equal(group.activate().ok, true);
  assert.deepEqual(h.grants, ['processor', 'relay', 'processor', 'relay']);
  h.runtime.publish(h.source, 32); h.runtime.flush();
  assert.deepEqual(h.delivered, ['measure']);
  group.stop();
  assert.deepEqual(h.released, ['actuate', 'measure']);
  h.runtime.close();
});

test('failed required preparation releases prior leases with no physical effect', () => {
  assert.equal(typeof createGroup, 'function');
  const h = fixture(sink => sink !== 'relay');
  const group = createGroup!(contract, [sensor, processor, relay], h.connect);
  assert.deepEqual(group.prepare(), { ok: false, reason: 'denied' });
  assert.deepEqual([...h.connections.values()].map(item => item.status().state), ['closed', 'closed']);
  assert.deepEqual(h.released, []);
  const retry = h.runtime.route({ from: h.source, to: h.input,
    principalId: 'owner', applicationId: 'example:feedback', sessionId: 'local' });
  assert.equal(retry.start().ok, true);
  h.runtime.close();
});

test('activation rechecks authority and compensates started members without claiming physical rollback', () => {
  assert.equal(typeof createGroup, 'function');
  let relayChecks = 0;
  const h = fixture(sink => sink !== 'relay' || ++relayChecks === 1);
  const group = createGroup!(contract, [sensor, processor, relay], h.connect);
  assert.equal(group.prepare().ok, true);
  assert.deepEqual(group.activate(), { ok: false, reason: 'denied' });
  assert.deepEqual(h.released, ['measure']);
  assert.deepEqual([...h.connections.values()].map(item => item.status().state), ['closed', 'closed']);
  assert.deepEqual(h.delivered, []);
  h.runtime.close();
});

test('optional preparation denial may degrade without blocking required route', () => {
  assert.equal(typeof createGroup, 'function');
  const h = fixture(sink => sink !== 'relay');
  const optional = { ...contract, members: [contract.members[0], { ...contract.members[1], required: false }] };
  const group = createGroup!(optional, [sensor, processor, relay], h.connect);
  const start = group.start();
  assert.equal(start.ok, true);
  if (!start.ok) throw new Error('Expected degraded group');
  assert.deepEqual(start.value.omittedOptional, ['actuate']);
  h.runtime.publish(h.source, 31); h.runtime.flush();
  assert.deepEqual(h.delivered, ['measure']);
  group.stop(); h.runtime.close();
});

test('a host preparation exception releases every reserved route', () => {
  const h = fixture(() => true);
  const group = createGroup!(contract, [sensor, processor, relay], member => {
    const connection = h.connect(member);
    if (member.id === 'actuate') {
      const originalPrepare = connection.prepare.bind(connection);
      Object.assign(connection, { prepare() {
        originalPrepare();
        throw new Error('host failed after reservation');
      } });
    }
    return connection;
  });
  assert.deepEqual(group.prepare(), { ok: false, reason: 'preparation-failed' });
  assert.deepEqual([...h.connections.values()].map(item => item.status().state), ['closed', 'closed']);
  assert.deepEqual(h.released, []);
  const retry = h.runtime.route({ from: h.derived, to: h.output,
    principalId: 'owner', applicationId: 'example:feedback', sessionId: 'local' });
  assert.equal(retry.start().ok, true);
  h.runtime.close();
});

test('a falsely successful host reservation cannot advance the group', () => {
  const h = fixture(() => true);
  const group = createGroup!(contract, [sensor, processor, relay], member => {
    const connection = h.connect(member);
    if (member.id === 'actuate') Object.assign(connection, { prepare: () => ({ ok: true, value: undefined }) });
    return connection;
  });
  assert.deepEqual(group.prepare(), { ok: false, reason: 'preparation-lost' });
  assert.deepEqual([...h.connections.values()].map(item => item.status().state), ['closed', 'closed']);
  assert.deepEqual(h.released, []);
  h.runtime.close();
});

test('a host that starts a route during construction is rejected and stopped', () => {
  const h = fixture(() => true);
  assert.throws(() => createGroup!(contract, [sensor, processor, relay], member => {
    const connection = h.connect(member);
    if (member.id === 'actuate') assert.equal(connection.start().ok, true);
    return connection;
  }));
  assert.deepEqual([...h.connections.values()].map(item => item.status().state), ['closed', 'closed']);
  assert.deepEqual(h.released, ['actuate']);
  h.runtime.close();
});

test('required route loss stops the group and cancels queued dependent commands', () => {
  const h = fixture(() => true);
  const group = createGroup!(contract, [sensor, processor, relay], h.connect);
  assert.equal(group.start().ok, true);
  assert.equal(h.runtime.publish(h.derived, true, { operationId: '1', deadline: 500 }).ok, true);
  assert.equal(h.connections.get('actuate')!.status().pending, 1);
  h.runtime.revoke(h.connections.get('measure')!);
  assert.equal(group.status().state, 'closed');
  assert.equal(h.connections.get('actuate')!.status().state, 'closed');
  assert.equal(h.connections.get('actuate')!.operations()[0].state, 'cancelled');
  assert.equal(h.runtime.route({ from: h.derived, to: h.output,
    principalId: 'owner', applicationId: 'example:feedback', sessionId: 'local' }).start().ok, true);
  h.runtime.close();
});

test('optional route loss degrades and releases its lease without stopping required routes', () => {
  const h = fixture(() => true);
  const optional = { ...contract, members: [contract.members[0], { ...contract.members[1], required: false }] };
  const group = createGroup!(optional, [sensor, processor, relay], h.connect);
  assert.equal(group.start().ok, true);
  h.runtime.revoke(h.connections.get('actuate')!);
  assert.deepEqual(group.status(), { state: 'active', omittedOptional: ['actuate'] });
  assert.equal(h.connections.get('measure')!.status().state, 'active');
  assert.equal(h.runtime.route({ from: h.derived, to: h.output,
    principalId: 'owner', applicationId: 'example:feedback', sessionId: 'local' }).start().ok, true);
  group.stop(); h.runtime.close();
});

test('pause policy closes every route and resume obtains fresh routes and grants', () => {
  const h = fixture(() => true);
  const pausing = { ...contract, recovery: { required: 'pause', optional: 'pause' } };
  const group = createGroup!(pausing, [sensor, processor, relay], h.connect);
  assert.equal(group.start().ok, true);
  assert.equal(h.runtime.publish(h.derived, true, { operationId: '1', deadline: 500 }).ok, true);
  const oldOutput = h.connections.get('actuate')!;
  h.runtime.revoke(h.connections.get('measure')!);
  assert.equal(group.status().state, 'paused');
  assert.equal(oldOutput.status().state, 'closed');
  assert.equal(oldOutput.operations()[0].state, 'cancelled');
  const resumed = group.resume();
  assert.equal(resumed.ok, true);
  if (!resumed.ok) throw new Error('Expected a fresh group');
  assert.equal(resumed.value.status().state, 'active');
  assert.notEqual(h.connections.get('actuate'), oldOutput);
  assert.equal(h.grants.length, 8);
  assert.deepEqual(group.resume(), { ok: false, reason: 'invalid-state' });
  resumed.value.stop();
  group.stop(); h.runtime.close();
});

test('stop-all recovery policy closes a required dependent when an optional input is lost', () => {
  const h = fixture(() => true);
  const stopAll = { ...contract, members: [{ ...contract.members[0], required: false }, contract.members[1]],
    failure: { required: 'stop-all', optional: 'stop-all' },
    recovery: { required: 'stop-all', optional: 'stop-all' } };
  const group = createGroup!(stopAll, [sensor, processor, relay], h.connect);
  assert.equal(group.start().ok, true);
  h.runtime.setReadiness(h.source, 'unavailable');
  assert.equal(group.status().state, 'closed');
  assert.equal(h.connections.get('actuate')!.status().state, 'closed');
  assert.deepEqual(h.released, ['actuate', 'measure']);
  h.runtime.close();
});

test('degraded recovery stops transitive optional dependents and releases their leases', () => {
  const h = fixture(() => true);
  const spare = { ...relay, id: 'spare-relay' };
  const spareSink = h.runtime.registerSink({ device: spare, capability: 'set-state',
    apply() { h.delivered.push('spare'); }, release() { h.released.push('spare'); } });
  h.runtime.setReadiness(spareSink, 'available');
  const extra = { ...contract.members[1], id: 'spare', required: false,
    to: { deviceId: 'spare-relay', capability: 'set-state', operation: 'invoke' }, startAfter: ['actuate'] };
  const degraded = { ...contract, members: [contract.members[0], { ...contract.members[1], required: false }, extra] };
  const spareRoute = h.runtime.route({ from: h.derived, to: spareSink,
    principalId: 'owner', applicationId: 'example:feedback', sessionId: 'local' });
  const group = createGroup!(degraded, [sensor, processor, relay, spare], member =>
    member.id === 'spare' ? spareRoute : h.connect(member));
  assert.equal(group.start().ok, true);
  h.runtime.revoke(h.connections.get('actuate')!);
  assert.deepEqual(group.status(), { state: 'active', omittedOptional: ['actuate', 'spare'] });
  assert.equal(spareRoute.status().state, 'closed');
  assert.equal(h.connections.get('measure')!.status().state, 'active');
  assert.equal(h.runtime.route({ from: h.derived, to: spareSink,
    principalId: 'owner', applicationId: 'example:feedback', sessionId: 'local' }).start().ok, true);
  group.stop(); h.runtime.close();
});
