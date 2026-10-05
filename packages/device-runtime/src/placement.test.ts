import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from './index.ts';
import { DeviceValidationError } from '@101/device-model';
import type { PlacementAuthorityRequest } from './placement.ts';

const create = (runtime as Record<string, unknown>).createPlacementScheduler as
  ((options: unknown) => runtime.PlacementScheduler) | undefined;
const sensor = { schemaVersion: 1, id: 'sensor', label: 'Sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1, kind: 'sample',
    value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
    delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }] };
const relay = { schemaVersion: 1, id: 'relay', label: 'Relay', revision: 1,
  adapter: { id: 'example:relay', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'set-state', semantic: 'example:relay-state', schemaVersion: 1, kind: 'command',
    value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['invoke'] }] };
const processor = { schemaVersion: 1, id: 'example:threshold', version: '1.0.0', codeSha256: 'a'.repeat(64),
  inputs: [{ id: 'temperature', value: sensor.capabilities[0].value }],
  outputs: [{ id: 'state', value: { type: 'boolean' } }],
  configuration: { type: 'record', fields: { threshold: sensor.capabilities[0].value } },
  state: { mode: 'stateless' }, assets: [], license: 'MIT',
  budgets: { maxComputeMs: 5, maxMemoryBytes: 65536, privacy: 'local-only' } };
const workload = { schemaVersion: 1, id: 'example:feedback', version: '1.0.0',
  application: { codeSha256: 'b'.repeat(64), runtime: { platform: 'node', minimumVersion: '24.0.0' },
    budget: { maxComputeMs: 5, maxMemoryBytes: 65536 } },
  processors: [{ id: processor.id, version: processor.version, codeSha256: processor.codeSha256,
    runtime: { platform: 'node', minimumVersion: '24.0.0' } }],
  assets: [], resources: [
    { deviceId: 'sensor', capability: 'temperature', operation: 'subscribe', required: true },
    { deviceId: 'relay', capability: 'set-state', operation: 'invoke', required: false },
  ],
  privacy: { mode: 'local-only', purpose: null, destinations: [], retention: 'none' },
  budget: { maxComputeMs: 10, maxMemoryBytes: 131072 }, restart: { mode: 'cold' } };
const host = { id: 'host-b', runtimes: [{ platform: 'node', version: '24.14.0' }],
  applications: [{ id: workload.id, version: workload.version, codeSha256: workload.application.codeSha256 }],
  processors: [{ id: processor.id, version: processor.version, codeSha256: processor.codeSha256 }],
  assets: [], resources: [
    { deviceId: 'sensor', capability: 'temperature', operation: 'subscribe', ownerId: 'owner-sensor' },
    { deviceId: 'relay', capability: 'set-state', operation: 'invoke', ownerId: 'owner-relay' },
  ],
  sharingDestinations: [], quota: { maxComputeMs: 10, maxMemoryBytes: 131072, maxWorkloads: 1 } };
const principal = { principalId: 'player', applicationId: workload.id, sessionId: 'session-1' };
const context = { devices: [sensor, relay], processors: [processor] };

test('scheduler selects an eligible host, reserves quota and releases it once', () => {
  assert.equal(typeof create, 'function');
  const scheduler = create!({ context, hosts: [{ ...host, id: 'host-a', runtimes: [{ platform: 'node', version: '23.9.0' }] }, host],
    isAuthorized: () => true });
  const first = scheduler.place(workload, principal);
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error('Expected placement');
  assert.equal(first.placement.hostId, 'host-b');
  assert.deepEqual(first.placement.resources.map(item => item.capability), ['temperature', 'set-state']);
  assert.equal(scheduler.place(workload, principal).ok, false);
  assert.equal(scheduler.release(first.placement.id), true);
  assert.equal(scheduler.release(first.placement.id), false);
  assert.equal(scheduler.place(workload, principal).ok, true);
});

test('owner denial rejects required resources without leaking quota', () => {
  assert.equal(typeof create, 'function');
  let allowed = false, checks = 0;
  const scheduler = create!({ context, hosts: [host], isAuthorized: (request: PlacementAuthorityRequest) => {
    checks++; return allowed || request.capability === 'set-state';
  } });
  assert.deepEqual(scheduler.place(workload, principal), { ok: false, reason: 'unauthorized' });
  assert.ok(checks >= 1);
  allowed = true;
  assert.equal(scheduler.place(workload, principal).ok, true);
});

test('optional unavailable or denied resource is omitted without granting it', () => {
  assert.equal(typeof create, 'function');
  const scheduler = create!({ context, hosts: [{ ...host, resources: [host.resources[0]] }],
    isAuthorized: (request: PlacementAuthorityRequest) => request.capability === 'temperature' });
  const result = scheduler.place(workload, principal);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Expected placement');
  assert.deepEqual(result.placement.resources.map(item => item.capability), ['temperature']);
  assert.deepEqual(result.placement.omittedOptional, ['relay/set-state']);
});

test('asset identity and full owner scope are checked before reservation', () => {
  assert.equal(typeof create, 'function');
  const asset = { id: 'example:calibration', kind: 'json-document', mediaType: 'application/json',
    byteLength: 2, sha256: 'd'.repeat(64) };
  const withAsset = { ...workload, assets: [asset] };
  const seen: runtime.PlacementAuthorityRequest[] = [];
  const scheduler = create!({ context, hosts: [{ ...host, assets: [asset] }],
    isAuthorized: (request: runtime.PlacementAuthorityRequest) => { seen.push(request); return true; } });
  const selected = scheduler.place(withAsset, principal);
  assert.equal(selected.ok, true);
  assert.deepEqual(seen.map(item => ({ owner: item.ownerId, host: item.hostId, principal: item.principalId,
    app: item.applicationId, session: item.sessionId, operation: item.operation })), [
    { owner: 'owner-sensor', host: 'host-b', principal: 'player', app: workload.id, session: 'session-1', operation: 'subscribe' },
    { owner: 'owner-relay', host: 'host-b', principal: 'player', app: workload.id, session: 'session-1', operation: 'invoke' },
  ]);
  const wrongAsset = create!({ context, hosts: [{ ...host, assets: [{ ...asset, byteLength: 3 }] }],
    isAuthorized: () => true });
  assert.deepEqual(wrongAsset.place(withAsset, principal), { ok: false, reason: 'incompatible' });
});

test('untrusted code, runtime, assets, sharing and resource inventory cannot place', () => {
  assert.equal(typeof create, 'function');
  const variants = [
    { ...host, applications: [{ ...host.applications[0], codeSha256: 'c'.repeat(64) }] },
    { ...host, processors: [{ ...host.processors[0], codeSha256: 'c'.repeat(64) }] },
    { ...host, runtimes: [{ platform: 'node', version: '24.0.0-beta.1' }] },
    { ...host, resources: [host.resources[1]] },
    { ...host, quota: { ...host.quota, maxComputeMs: 9 } },
    { ...host, quota: { ...host.quota, maxMemoryBytes: 131071 } },
  ];
  for (const candidate of variants) {
    const scheduler = create!({ context, hosts: [candidate], isAuthorized: () => true });
    assert.equal(scheduler.place(workload, principal).ok, false);
  }
  const sharing = { ...workload, processors: [], privacy: { mode: 'explicit-sharing', purpose: 'Remote use',
    destinations: ['example:other-host'], retention: 'none' }, budget: workload.application.budget };
  const scheduler = create!({ context, hosts: [host], isAuthorized: () => true });
  assert.equal(scheduler.place(sharing, principal).ok, false);
});

test('manifest, principal and host inventory are validated before authority checks', () => {
  assert.equal(typeof create, 'function');
  let checks = 0;
  const scheduler = create!({ context, hosts: [host], isAuthorized: () => { checks++; return true; } });
  assert.throws(() => scheduler.place({ ...workload, budget: { ...workload.budget, maxComputeMs: 9 } }, principal), DeviceValidationError);
  assert.throws(() => scheduler.place(workload, { ...principal, applicationId: 'other' }), DeviceValidationError);
  assert.equal(checks, 0);
  assert.throws(() => create!({ context, hosts: [{ ...host, quota: { ...host.quota, maxWorkloads: 0 } }],
    isAuthorized: () => true }), DeviceValidationError);
});
