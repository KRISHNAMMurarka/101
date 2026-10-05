import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConnectorProfileManifest } from './connector-profile.ts';

function manifest() { return {
  schemaVersion: 1, id: 'example:node-memory', version: '1.0.0',
  decoder: { id: 'example:node-memory-jsonl', version: '1.0.0', codeSha256: 'a'.repeat(64) },
  identityFilters: [{ field: 'backendId', equals: 'node-memory' }, { field: 'wireVersion', equals: 1 }],
  framing: { kind: 'jsonl', maxFrameBytes: 4096, maxChunkBytes: 8192, maxFramesPerPush: 16 },
  resources: [
    { capability: { id: 'resident', semantic: 'example:resident-memory', schemaVersion: 1, kind: 'sample', value: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER }, delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 1000 }, permissions: ['subscribe'] }, direction: 'source', calibration: { revision: 1, unit: 'By', maxAbsoluteErrorBound: 0 }, command: null },
    { capability: { id: 'enabled', semantic: 'example:sampling-enabled', schemaVersion: 1, kind: 'event', value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: ['subscribe'] }, direction: 'source', calibration: null, command: null },
    { capability: { id: 'sampling', semantic: 'example:sampling-enabled', schemaVersion: 1, kind: 'command', value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: ['invoke'], ownership: { mode: 'exclusive' } }, direction: 'sink', calibration: null, command: { idempotent: true, deadlineMs: 1000, feedback: ['dispatched', 'target-acknowledged', 'observed'], observedState: 'enabled', safeState: false } },
  ], budgets: { maxBufferedBytes: 4096, maxOutputsPerFrame: 8, maxPendingCommands: 4, maxCommandBytes: 1024, callbackTimeoutMs: 1000 }, license: 'MIT',
}; }

test('A01 parses a closed inert profile with general typed units, calibration, safe state and feedback', () => {
  const input = manifest(); const parsed = parseConnectorProfileManifest(input);
  assert.equal(parsed.resources[0]!.capability.value.type, 'scalar');
  assert.deepEqual(parsed.resources[0]!.calibration, { revision: 1, unit: 'By', maxAbsoluteErrorBound: 0 });
  assert.equal(parsed.resources[2]!.command!.safeState, false);
  assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.resources[0]!.capability));
  input.resources[0]!.capability.id = 'changed'; assert.equal(parsed.resources[0]!.capability.id, 'resident');
});

test('profile data rejects unknown code paths, getters, prototypes and incompatible versions before execution', () => {
  let reads = 0;
  const getter = { ...manifest(), get decoder() { reads++; throw Error('credential-sentinel'); } };
  for (const input of [getter, { ...manifest(), importPath: '/tmp/unreviewed.mjs' }, { ...manifest(), schemaVersion: 2 }, Object.assign(Object.create({ hidden: true }), manifest())]) assert.throws(() => parseConnectorProfileManifest(input));
  assert.equal(reads, 0);
});

test('profile parsing enforces whole-byte, finite framing, work, pending and output ceilings', () => {
  for (const change of [
    (m: ReturnType<typeof manifest>) => { m.framing.maxFrameBytes = 65537; },
    (m: ReturnType<typeof manifest>) => { m.framing.maxFramesPerPush = 65; },
    (m: ReturnType<typeof manifest>) => { m.budgets.maxPendingCommands = 17; },
    (m: ReturnType<typeof manifest>) => { m.budgets.maxOutputsPerFrame = 33; },
    (m: ReturnType<typeof manifest>) => { m.budgets.callbackTimeoutMs = Infinity; },
    (m: ReturnType<typeof manifest>) => { m.decoder.codeSha256 = 'unverified'; },
  ]) { const m = manifest(); change(m); assert.throws(() => parseConnectorProfileManifest(m)); }
  assert.throws(() => parseConnectorProfileManifest(' '.repeat(65537)));
});

test('calibration, permissions and feedback cannot widen the declared resource contract', () => {
  for (const change of [
    (m: ReturnType<typeof manifest>) => { m.resources[0]!.calibration!.unit = 'Cel'; },
    (m: ReturnType<typeof manifest>) => { m.resources[0]!.capability.permissions = ['invoke']; },
    (m: ReturnType<typeof manifest>) => { m.resources[2]!.command!.observedState = 'resident'; },
    (m: ReturnType<typeof manifest>) => { m.resources[2]!.capability.delivery.mode = 'latest'; },
    (m: ReturnType<typeof manifest>) => { m.resources[2]!.command!.safeState = 'not-a-boolean' as never; },
  ]) { const m = manifest(); change(m); assert.throws(() => parseConnectorProfileManifest(m)); }
  const duplicate = manifest(); duplicate.identityFilters.push({ field: 'backendId', equals: 'node-memory' }); assert.throws(() => parseConnectorProfileManifest(duplicate));
  const resources = manifest(); resources.resources.push(resources.resources[0]!); assert.throws(() => parseConnectorProfileManifest(resources));
});

test('profile resource arrays never execute caller map or index accessors', () => {
  const input = manifest(); let reads = 0;
  Object.defineProperty(input.resources, 'map', { get() { reads++; return Array.prototype.map; }, enumerable: true });
  assert.throws(() => parseConnectorProfileManifest(input)); assert.equal(reads, 0);
  const indexed = manifest(); Object.defineProperty(indexed.resources, '0', { get() { reads++; return manifest().resources[0]; }, enumerable: true });
  assert.throws(() => parseConnectorProfileManifest(indexed)); assert.equal(reads, 0);
});
