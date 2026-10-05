import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDeviceScaffold } from './device-scaffold.ts';

test('device scaffold contains a pinned processor, connector, caller and runnable check', () => {
  const files = createDeviceScaffold({ id: 'room-sensor' });
  assert.deepEqual(Object.keys(files).sort(), [
    'package.json', 'processor.manifest.json', 'src/connector.ts', 'src/index.mjs',
    'src/processor.ts', 'test/project.test.mjs', 'tsconfig.json',
  ]);
  const manifest = JSON.parse(files['processor.manifest.json']!);
  assert.equal(manifest.codeSha256, createHash('sha256').update(files['src/processor.ts']!).digest('hex'));
  assert.equal(manifest.id, 'room-sensor:threshold');
  assert.match(files['src/connector.ts']!, /authorize\(/);
  assert.match(files['src/index.mjs']!, /finally/);
  assert.match(files['test/project.test.mjs']!, /runProject/);
});

test('device scaffold rejects unsafe identifiers without generating paths', () => {
  for (const id of ['../escape', 'with space', 'A', '__proto__', 'a'.repeat(65)]) {
    assert.throws(() => createDeviceScaffold({ id }), /kebab-case/);
  }
});
