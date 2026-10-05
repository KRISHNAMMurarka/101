import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProcessorManifest } from './index.ts';

const manifest = {
  schemaVersion: 1, id: 'example:threshold', version: '1.0.0',
  codeSha256: 'a'.repeat(64),
  inputs: [{ id: 'temperature', value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 } }],
  outputs: [{ id: 'switch', value: { type: 'boolean' } }],
  configuration: { type: 'record', fields: {
    onAt: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
    offAt: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
  } },
  state: { mode: 'resettable', resetOn: ['input-loss', 'stop', 'reconfigure'] },
  assets: [], license: 'MIT',
  budgets: { maxComputeMs: 5, maxMemoryBytes: 65536, privacy: 'local-only' },
};

test('processor manifest preserves bounded units, reset policy, license and budgets', () => {
  const parsed = parseProcessorManifest(manifest);
  assert.deepEqual(parsed, manifest);
  assert.equal(Object.isFrozen(parsed.inputs[0]?.value), true);
  assert.equal(Object.isFrozen(parsed.state.resetOn), true);
  const asset = { reference: { id: 'example:model', kind: 'blob', mediaType: 'application/octet-stream',
    byteLength: 12, sha256: 'b'.repeat(64) }, license: 'CC-BY-4.0' };
  assert.deepEqual(parseProcessorManifest({ ...manifest, assets: [asset] }).assets, [asset]);
  assert.throws(() => parseProcessorManifest({ ...manifest, assets: [asset, asset] }));
});

test('processor manifest rejects unknown authority, duplicate ports and malformed pins', () => {
  for (const bad of [
    { ...manifest, permissions: ['invoke'] },
    { ...manifest, inputs: [manifest.inputs[0], manifest.inputs[0]] },
    { ...manifest, outputs: [] },
    { ...manifest, version: 'latest' },
    { ...manifest, codeSha256: 'a'.repeat(63) },
    { ...manifest, state: { mode: 'resettable', resetOn: ['stop'] } },
    { ...manifest, budgets: { ...manifest.budgets, maxComputeMs: 0 } },
    { ...manifest, assets: [{ reference: { id: 'example:asset', kind: 'blob', mediaType: 'application/octet-stream', byteLength: 1, sha256: 'oops' }, license: 'MIT' }] },
  ]) assert.throws(() => parseProcessorManifest(bad));
});
