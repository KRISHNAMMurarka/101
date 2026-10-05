import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from './index.ts';

const parse = (model as Record<string, unknown>).parseWorkloadRequirements as
  ((input: unknown, context: unknown) => model.WorkloadRequirements) | undefined;
const scalar = { type: 'scalar', unit: 'Cel', min: -40, max: 125 };
const sensor = { schemaVersion: 1, id: 'sensor', label: 'Sensor', revision: 1,
  adapter: { id: 'example:sensor', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'temperature', semantic: 'example:temperature', schemaVersion: 1, kind: 'sample',
    value: scalar, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 }, permissions: ['subscribe'] }] };
const relay = { schemaVersion: 1, id: 'relay', label: 'Relay', revision: 1,
  adapter: { id: 'example:relay', version: '1.0.0' }, runtime: { platform: 'embedded-test' },
  capabilities: [{ id: 'set-state', semantic: 'example:relay-state', schemaVersion: 1, kind: 'command',
    value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['invoke'] }] };
const asset = { id: 'example:processor-data', kind: 'blob', mediaType: 'application/octet-stream',
  byteLength: 4, sha256: 'b'.repeat(64) };
const processor = { schemaVersion: 1, id: 'example:threshold', version: '1.0.0', codeSha256: 'a'.repeat(64),
  inputs: [{ id: 'temperature', value: scalar }], outputs: [{ id: 'state', value: { type: 'boolean' } }],
  configuration: { type: 'record', fields: { threshold: scalar } },
  state: { mode: 'resettable', resetOn: ['input-loss', 'stop', 'reconfigure'] },
  assets: [{ reference: asset, license: 'MIT' }], license: 'MIT',
  budgets: { maxComputeMs: 5, maxMemoryBytes: 65536, privacy: 'local-only' } };
const context = { devices: [sensor, relay], processors: [processor] };
const nodeRuntime = { platform: 'node', minimumVersion: '24.0.0' };
const manifest = { schemaVersion: 1, id: 'example:feedback-workload', version: '1.0.0',
  application: { codeSha256: 'c'.repeat(64), runtime: nodeRuntime,
    budget: { maxComputeMs: 5, maxMemoryBytes: 65536 } },
  processors: [{ id: processor.id, version: processor.version, codeSha256: processor.codeSha256,
    runtime: nodeRuntime }],
  assets: [asset],
  resources: [
    { deviceId: 'sensor', capability: 'temperature', operation: 'subscribe', required: true },
    { deviceId: 'relay', capability: 'set-state', operation: 'invoke', required: true },
  ],
  privacy: { mode: 'local-only', purpose: null, destinations: [], retention: 'none' },
  budget: { maxComputeMs: 10, maxMemoryBytes: 131072 },
  restart: { mode: 'cold' } };

test('workload pins app and processor runtime, assets, resources, privacy and aggregate budget', () => {
  assert.equal(typeof parse, 'function');
  const plan = parse!(manifest, context);
  assert.equal(plan.id, manifest.id);
  assert.equal(plan.processors[0]?.manifest.codeSha256, processor.codeSha256);
  assert.deepEqual(plan.resources.map(item => item.operation), ['subscribe', 'invoke']);
  assert.deepEqual(plan.budget, manifest.budget);
  assert.equal(plan.restart.mode, 'cold');
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.processors[0]?.manifest), true);
});

test('missing or changed pins and assets fail before placement', () => {
  assert.equal(typeof parse, 'function');
  for (const bad of [
    { ...manifest, processors: [{ ...manifest.processors[0], codeSha256: 'd'.repeat(64) }] },
    { ...manifest, processors: [{ ...manifest.processors[0], version: '2.0.0' }] },
    { ...manifest, assets: [] },
    { ...manifest, assets: [{ ...asset, sha256: 'e'.repeat(64) }] },
    { ...manifest, processors: [manifest.processors[0], manifest.processors[0]] },
  ]) assert.throws(() => parse!(bad, context), model.DeviceValidationError);
});

test('budget and privacy cannot understate processor requirements', () => {
  assert.equal(typeof parse, 'function');
  assert.throws(() => parse!({ ...manifest, budget: { ...manifest.budget, maxComputeMs: 9 } }, context), model.DeviceValidationError);
  assert.throws(() => parse!({ ...manifest, budget: { ...manifest.budget, maxMemoryBytes: 131071 } }, context), model.DeviceValidationError);
  assert.throws(() => parse!({ ...manifest, privacy: { ...manifest.privacy, mode: 'explicit-sharing' } }, context), model.DeviceValidationError);
  assert.throws(() => parse!({ ...manifest, privacy: { mode: 'explicit-sharing', purpose: 'Remote feedback',
    destinations: ['example:approved-host'], retention: 'none' } }, context), model.DeviceValidationError);
  const sharingProcessor = { ...processor, budgets: { ...processor.budgets, privacy: 'explicit-sharing' } };
  assert.throws(() => parse!(manifest, { ...context, processors: [sharingProcessor] }), model.DeviceValidationError);
  const shared = { ...manifest, privacy: { mode: 'explicit-sharing', purpose: 'Remote feedback',
    destinations: ['example:approved-host'], retention: 'none' } };
  assert.equal(parse!(shared, { ...context, processors: [sharingProcessor] }).privacy.mode, 'explicit-sharing');
});

test('resource permission and kind must match live descriptor declarations', () => {
  assert.equal(typeof parse, 'function');
  for (const bad of [
    { ...manifest, resources: [{ ...manifest.resources[0], deviceId: 'missing' }, manifest.resources[1]] },
    { ...manifest, resources: [{ ...manifest.resources[0], operation: 'read' }, manifest.resources[1]] },
    { ...manifest, resources: [manifest.resources[0], { ...manifest.resources[1], operation: 'write' }] },
    { ...manifest, resources: [manifest.resources[0], manifest.resources[0]] },
    { ...manifest, resources: [] },
  ]) assert.throws(() => parse!(bad, context), model.DeviceValidationError);
});

test('snapshot compatibility must pin this app code and choose cold fallback', () => {
  assert.equal(typeof parse, 'function');
  const snapshot = { mode: 'snapshot', formatVersion: 1, applicationCodeSha256: manifest.application.codeSha256,
    processorState: 'reset-on-resume', onIncompatible: 'cold-restart' };
  assert.equal(parse!({ ...manifest, restart: snapshot }, context).restart.mode, 'snapshot');
  for (const bad of [
    { ...snapshot, applicationCodeSha256: 'd'.repeat(64) },
    { ...snapshot, formatVersion: 0 },
    { ...snapshot, processorState: 'keep-running' },
    { ...snapshot, onIncompatible: 'force-restore' },
  ]) assert.throws(() => parse!({ ...manifest, restart: bad }, context), model.DeviceValidationError);
});

test('runtime and closed input validation reject unsupported or active data', () => {
  assert.equal(typeof parse, 'function');
  for (const bad of [
    { ...manifest, schemaVersion: 2 },
    { ...manifest, application: { ...manifest.application,
      runtime: { platform: 'cloud', minimumVersion: '24.0.0' } } },
    { ...manifest, application: { ...manifest.application,
      runtime: { platform: 'node', minimumVersion: '24' } } },
    { ...manifest, unexpected: true },
  ]) assert.throws(() => parse!(bad, context), model.DeviceValidationError);
  let reads = 0;
  const accessor = Object.defineProperty({ ...manifest }, 'assets', { enumerable: true,
    get() { reads++; return [asset]; } });
  assert.throws(() => parse!(accessor, context), model.DeviceValidationError);
  assert.equal(reads, 0);
  const contextAccessor = Object.defineProperty({ processors: [processor] }, 'devices', { enumerable: true,
    get() { reads++; return [sensor, relay]; } });
  assert.throws(() => parse!(manifest, contextAccessor), model.DeviceValidationError);
  assert.equal(reads, 0);
});
