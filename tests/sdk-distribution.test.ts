import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import test from 'node:test';

test('immutable general SDK packs compiled public contracts and licenses without workspace source', () => {
  const root = resolve(import.meta.dirname, '..');
  const tree = execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim();
  const result = JSON.parse(execFileSync(process.execPath, ['tools/build-sdk.mjs', tree], { cwd: root, encoding: 'utf8' }));
  assert.ok(result.outputDir.startsWith(resolve(root, 'release', 'sdk-')) && result.outputDir.startsWith(resolve(root, 'release') + sep));
  const owned = [result.outputDir];
  try {
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.source.tree, tree);
    for (const [path, digest] of Object.entries(result.source.sha256)) {
      assert.equal(createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'), digest,
        `Stage the current SDK producer before the immutable pack contract: ${path}`);
    }
    assert.deepEqual(result.packages.map((item: { name: string }) => item.name).sort(),
      ['@101/connect', '@101/device-model', '@101/device-runtime', '@101/device-web', '@101/transport-webrtc', '@101/transport-websocket', '@101/vision']);
    for (const item of result.packages) {
      assert.equal(item.license, 'MIT', `${item.name} must declare its license in the provenance manifest`);
      const archive = readFileSync(item.tarball);
      assert.equal(archive.length, item.bytes);
      assert.equal(createHash('sha256').update(archive).digest('hex'), item.sha256);
      const packed = execFileSync('tar', ['-tzf', item.tarball], { encoding: 'utf8' }).trim().split('\n');
      assert.ok(packed.includes('package/dist/index.js'));
      assert.ok(packed.includes('package/dist/index.d.ts'));
      assert.ok(packed.includes('package/LICENSE'));
      assert.ok(packed.includes('package/README.md'));
      assert.ok(packed.every(path => !path.includes('/src/') && !path.includes('.test.') && !path.includes('node_modules')));
      assert.deepEqual(packed.map(path => path.replace(/^package\//, '')).sort(), item.files.map((file: { path: string }) => file.path).sort());
      if (item.name === '@101/connect' || item.name === '@101/device-model') assert.ok(packed.includes('package/schema/device-descriptor.json'));
      if (item.name === '@101/connect') assert.ok(packed.includes('package/examples/run.js'));
    }
    const repeated = JSON.parse(execFileSync(process.execPath, ['tools/build-sdk.mjs', tree], { cwd: root, encoding: 'utf8' }));
    assert.ok(repeated.outputDir.startsWith(resolve(root, 'release', 'sdk-')) && repeated.outputDir !== result.outputDir);
    owned.push(repeated.outputDir);
    assert.deepEqual(repeated.packages.map((item: { name: string; sha256: string }) => [item.name, item.sha256]),
      result.packages.map((item: { name: string; sha256: string }) => [item.name, item.sha256]), 'Two builds of one immutable source produce the same tarball bytes');
  } finally { for (const directory of owned) rmSync(directory, { recursive: true, force: true }); }
});
