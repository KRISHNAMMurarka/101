import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import test from 'node:test';

test('immutable general SDK packs compiled public contracts and licenses without workspace source', () => {
  const root = resolve(import.meta.dirname, '..');
  // Controllers can qualify an immutable candidate without changing the developer's staging area.
  // Every packed producer byte is still checked against the current checkout below.
  const tree = process.env.SDK_TEST_SOURCE_TREE ?? execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim();
  assert.match(tree, /^[a-f0-9]{40}$/, 'SDK_TEST_SOURCE_TREE must be an immutable Git tree');
  const result = JSON.parse(execFileSync(process.execPath, ['tools/build-sdk.mjs', tree], { cwd: root, encoding: 'utf8' }));
  assert.ok(result.outputDir.startsWith(resolve(root, 'release', 'sdk-')) && result.outputDir.startsWith(resolve(root, 'release') + sep));
  const owned = [result.outputDir];
  try {
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.source.tree, tree);
    const content = JSON.parse(readFileSync(resolve(result.outputDir, 'content-audit.json'), 'utf8'));
    assert.equal(content.schemaVersion, 1); assert.equal(content.auditProfile, 'sdk-content-audit/1');
    assert.equal(content.result, 'pass'); assert.equal(content.reason, 'ok'); assert.equal(content.releaseAccepted, false);
    assert.equal(content.sourceTree, tree);
    assert.equal(content.toolSha256, result.source.sha256['tools/audit-sdk-contents.py']);
    assert.equal(content.sdkManifestSha256, createHash('sha256').update(readFileSync(resolve(result.outputDir, 'manifest.json'))).digest('hex'));
    assert.equal(content.artifacts.length, 7);
    assert.equal(content.files, result.packages.reduce((count: number, item: { files: unknown[] }) => count + item.files.length, 0));
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
      if (item.name === '@101/device-runtime') {
        for (const file of ['processor-node.js', 'processor-node.d.ts', 'processor-worker.js', 'processor-worker.d.ts', 'processor-language.js'])
          assert.ok(packed.includes('package/dist/' + file));
        const metadata = JSON.parse(readFileSync(resolve(item.directory, 'package.json'), 'utf8'));
        assert.deepEqual(metadata.exports['./node'], { types: './dist/processor-node.d.ts', import: './dist/processor-node.js' });
      }
      if (item.name === '@101/connect' || item.name === '@101/device-model') assert.ok(packed.includes('package/schema/device-descriptor.json'));
      if (item.name === '@101/connect') {
        assert.ok(packed.includes('package/examples/run.js'));
        assert.ok(packed.includes('package/examples/telemetry-owner.mjs'));
        const metadata = JSON.parse(readFileSync(resolve(item.directory, 'package.json'), 'utf8'));
        assert.equal(metadata.exports['./examples/telemetry-owner'], './examples/telemetry-owner.mjs');
        assert.deepEqual(metadata.exports['./examples/device-scaffold'], { types: './examples/device-scaffold.d.ts', import: './examples/device-scaffold.js' });
        assert.equal(metadata.exports['./examples/onboarding'], './examples/onboarding/onboarding.mjs');
        assert.deepEqual(metadata.exports['./examples/browser-storage'], { types: './examples/browser-storage.d.ts', import: './examples/browser-storage.js' });
        for (const path of ['browser-storage.js', 'browser-storage.d.ts', 'browser-storage.ts'])
          assert.ok(packed.includes('package/examples/' + path));
        for (const path of ['device-scaffold.js', 'device-scaffold.d.ts', 'device-scaffold.ts', 'onboarding/onboarding.mjs', 'onboarding/consumer.mjs'])
          assert.ok(packed.includes('package/examples/' + path));
      }
    }
    const repeated = JSON.parse(execFileSync(process.execPath, ['tools/build-sdk.mjs', tree], { cwd: root, encoding: 'utf8' }));
    assert.ok(repeated.outputDir.startsWith(resolve(root, 'release', 'sdk-')) && repeated.outputDir !== result.outputDir);
    owned.push(repeated.outputDir);
    assert.deepEqual(repeated.packages.map((item: { name: string; sha256: string }) => [item.name, item.sha256]),
      result.packages.map((item: { name: string; sha256: string }) => [item.name, item.sha256]), 'Two builds of one immutable source produce the same tarball bytes');
  } finally { for (const directory of owned) rmSync(directory, { recursive: true, force: true }); }
});
