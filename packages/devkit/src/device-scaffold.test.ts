import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDeviceScaffold } from './device-scaffold.ts';

test('device scaffold contains a pinned processor, connector, caller and runnable check', () => {
  const files = createDeviceScaffold({ id: 'room-sensor' });
  assert.deepEqual(Object.keys(files).sort(), [
    'device-guidance.json', 'device-guidance.schema.json', 'package.json', 'processor.manifest.json', 'scripts/validate.mjs',
    'src/connector.ts', 'src/devices.json', 'src/index.mjs', 'src/processor.ts',
    'src/recipe.json', 'test/project.test.mjs', 'tsconfig.json',
  ]);
  const manifest = JSON.parse(files['processor.manifest.json']!);
  assert.equal(manifest.codeSha256, createHash('sha256').update(files['src/processor.ts']!).digest('hex'));
  assert.equal(manifest.id, 'room-sensor:threshold');
  const packageJson = JSON.parse(files['package.json']!);
  assert.equal(packageJson.scripts.validate, 'node scripts/validate.mjs');
  const guidance = JSON.parse(files['device-guidance.json']!);
  const guidanceSchema = JSON.parse(files['device-guidance.schema.json']!);
  assert.equal(guidance.schemaVersion, 1);
  assert.equal(guidanceSchema.additionalProperties, false);
  assert.equal(guidance.project.id, 'room-sensor');
  assert.ok(guidance.files.some((file: { path: string }) => file.path === 'src/recipe.json'));
  assert.ok(guidance.commands.some((command: { name: string }) => command.name === 'validate'));
  assert.match(guidance.trustBoundary.join(' '), /never.*authorization/i);
  const connector = files['src/connector.ts']!;
  assert.match(connector, /resolveRecipe\(/);
  assert.match(connector, /\.map\(parseDeviceDescriptor\)/);
  assert.match(connector, /with \{ type: 'json' \}/);
  assert.doesNotMatch(connector, /node:fs/);
  assert.match(connector, /request\.principalId === 'owner'/);
  assert.match(connector, /request\.source\.registrationId === sourceId/);
  assert.match(connector, /request\.sourceOperation === 'subscribe'/);
  assert.doesNotMatch(connector, /device-guidance\.json/);
  assert.match(files['src/index.mjs']!, /finally/);
  assert.match(files['test/project.test.mjs']!, /runProject/);
  assert.match(files['test/project.test.mjs']!, /principalId: 'attacker'/);
  assert.match(files['test/project.test.mjs']!, /applicationId: 'other-app'/);
  assert.match(files['test/project.test.mjs']!, /sessionId: 'other-session'/);
  assert.match(files['scripts/validate.mjs']!, /parseProcessorManifest/);
  assert.match(files['scripts/validate.mjs']!, /parseRecipe/);
  assert.match(files['scripts/validate.mjs']!, /resolveRecipe/);
});

test('device scaffold rejects unsafe identifiers without generating paths', () => {
  for (const id of ['../escape', 'with space', 'A', '__proto__', 'a'.repeat(65)]) {
    assert.throws(() => createDeviceScaffold({ id }), /kebab-case/);
  }
});
