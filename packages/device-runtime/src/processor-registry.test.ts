import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createProcessorRegistry } from './index.ts';

const source = new TextEncoder().encode('trusted-threshold-module-v1');
const digest = createHash('sha256').update(source).digest('hex');
const manifest = {
  schemaVersion: 1, id: 'example:threshold', version: '1.0.0', codeSha256: digest,
  inputs: [{ id: 'temperature', value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 } }],
  outputs: [{ id: 'switch', value: { type: 'boolean' } }],
  configuration: { type: 'record', fields: {
    onAt: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
    offAt: { type: 'scalar', unit: 'Cel', min: -40, max: 125 },
  } },
  state: { mode: 'resettable', resetOn: ['input-loss', 'stop', 'reconfigure'] },
  assets: [], license: 'MIT', budgets: { maxComputeMs: 5, maxMemoryBytes: 65536, privacy: 'local-only' },
};

test('registry resolves only an exact reviewed code pin and valid configuration', async () => {
  const registry = createProcessorRegistry();
  const calls: unknown[] = [];
  await registry.registerTrusted({ manifest, source, factory(configuration) {
    calls.push(configuration);
    return { process(inputs) { return { switch: Number(inputs.temperature) >= 30 }; }, reset() {} };
  } });
  const resolved = registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: digest,
    configuration: { onAt: 30, offAt: 28 } });
  assert.deepEqual(calls, [{ onAt: 30, offAt: 28 }]);
  assert.deepEqual(resolved.process({ temperature: 31 }), { switch: true });
  assert.throws(() => resolved.process({ temperature: '31' }));
  assert.throws(() => registry.resolve({ id: manifest.id, version: '1.0.1', codeSha256: digest,
    configuration: { onAt: 30, offAt: 28 } }));
  assert.throws(() => registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: '0'.repeat(64),
    configuration: { onAt: 30, offAt: 28 } }));
  assert.throws(() => registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: digest,
    configuration: { onAt: 300, offAt: 28 } }));
});

test('registry rejects changed source and does not register it', async () => {
  const registry = createProcessorRegistry();
  await assert.rejects(() => registry.registerTrusted({ manifest, source: new TextEncoder().encode('changed'),
    factory() { return { process() { return { switch: true }; }, reset() {} }; } }));
  assert.throws(() => registry.resolve({ id: manifest.id, version: manifest.version, codeSha256: digest,
    configuration: { onAt: 30, offAt: 28 } }));
});

test('untrusted lookup objects cannot run getters or supply extra authority', () => {
  const registry = createProcessorRegistry();
  let reads = 0;
  const request = Object.defineProperty({}, 'id', { enumerable: true, get() { reads += 1; return manifest.id; } });
  assert.throws(() => registry.resolve(request as never));
  assert.equal(reads, 0);
});
