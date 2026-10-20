import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { verifyConsoleReceiverBundle } from '../apps/console-receiver/verify-bundle.mjs';

const root = resolve(import.meta.dirname, '..'), output = join(root, 'outputs/controllers/2026-10-18-console-receiver');
type Manifest = { schemaVersion: number; sourceSha256: Record<string, string>; artifacts: Record<string, string>; windowsCompiled: boolean; xboxQualified: boolean };
let producer: Manifest | undefined;
function fixture(t: TestContext) {
  if (!producer) {
    execFileSync(process.execPath, ['apps/console-receiver/build.mjs'], { cwd: root, stdio: 'pipe', timeout: 60000 });
    producer = JSON.parse(readFileSync(join(root, 'release/console-receiver/source-manifest.json'), 'utf8')) as Manifest;
  }
  mkdirSync(output, { recursive: true });
  const repository = mkdtempSync(join(output, 'manifest-fixture-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const copy = (source: string, destination: string) => { mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination); };
  for (const path of Object.keys(producer.sourceSha256)) copy(join(root, path), join(repository, path));
  for (const path of Object.keys(producer.artifacts)) copy(join(root, 'release/console-receiver', path), join(repository, 'release/console-receiver', path));
  const manifestPath = join(repository, 'release/console-receiver/source-manifest.json');
  copy(join(root, 'release/console-receiver/source-manifest.json'), manifestPath);
  return { repository, manifestPath, manifest: JSON.parse(JSON.stringify(producer)) as Manifest,
    save(manifest: Manifest | object) { writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n'); } };
}

test('console receiver verifies actual producer source and artifact bytes, including the verifier itself', t => {
  const f = fixture(t), pin = verifyConsoleReceiverBundle(f.repository);
  assert.equal(pin.status, 'verified');
  assert.equal(pin.manifest.sha256, createHash('sha256').update(readFileSync(f.manifestPath)).digest('hex'));
  assert.equal(pin.sourceFiles, Object.keys(f.manifest.sourceSha256).length);
  assert.equal(pin.artifacts, Object.keys(f.manifest.artifacts).length);
  assert.ok(f.manifest.sourceSha256['apps/console-receiver/verify-bundle.mjs']);
  const cli = JSON.parse(execFileSync(process.execPath, [join(root, 'apps/console-receiver/verify-bundle.mjs'), f.repository], { encoding: 'utf8' }));
  assert.deepEqual(cli, pin);
});
test('console receiver rejects changed source after its real producer manifest', t => {
  const f = fixture(t), path = join(f.repository, 'apps/console-receiver/src/receiver.ts');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n// stale source after build\n');
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /source hash mismatch/);
});
test('console receiver rejects changed or missing web bundle bytes', t => {
  const f = fixture(t), asset = Object.keys(f.manifest.artifacts).find(path => path.endsWith('.js'))!;
  const path = join(f.repository, 'release/console-receiver', asset);
  writeFileSync(path, readFileSync(path, 'utf8') + '\n// stale bundle after build\n');
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /artifact hash mismatch/);
  rmSync(path);
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /artifact inventory differs/);
});
test('console receiver rejects source, artifact directory and manifest symbolic links', t => {
  const f = fixture(t), source = 'apps/console-receiver/src/receiver.ts';
  rmSync(join(f.repository, source)); symlinkSync(join(root, source), join(f.repository, source));
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /symbolic link input/);
  rmSync(join(f.repository, source)); copyFileSync(join(root, source), join(f.repository, source));
  const assets = join(f.repository, 'release/console-receiver/web/assets');
  rmSync(assets, { recursive: true }); symlinkSync(join(root, 'release/console-receiver/web/assets'), assets, 'dir');
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /symbolic link artifact/);
  rmSync(f.manifestPath); symlinkSync(join(root, 'release/console-receiver/source-manifest.json'), f.manifestPath);
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /symbolic link input/);
});
test('console receiver rejects unsafe manifest paths, bad digests and omitted required pins', t => {
  const f = fixture(t);
  for (const path of ['../outside', '/absolute', 'C:/absolute', 'web\\index.html', 'web/../index.html', 'web//index.html', 'web/assets./index.js']) {
    const manifest = structuredClone(f.manifest); manifest.artifacts[path] = 'a'.repeat(64); f.save(manifest);
    assert.throws(() => verifyConsoleReceiverBundle(f.repository), /unsafe relative path/);
  }
  const digest = structuredClone(f.manifest); digest.artifacts['web/index.html'] = 'A'.repeat(64); f.save(digest);
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /invalid artifact digest/);
  const omitted = structuredClone(f.manifest); delete omitted.sourceSha256['apps/console-receiver/verify-bundle.mjs']; f.save(omitted);
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /missing required source pin/);
});
test('console receiver rejects unlisted artifacts and nonproducer manifest schemas', t => {
  const f = fixture(t);
  writeFileSync(join(f.repository, 'release/console-receiver/web/assets/unlisted.js'), 'stale prior output');
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /artifact inventory differs/);
  rmSync(join(f.repository, 'release/console-receiver/web/assets/unlisted.js'));
  f.save({ ...f.manifest, windowsCompiled: true });
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /invalid manifest schema/);
  f.save({ ...f.manifest, unrelated: true });
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /invalid manifest schema/);
  f.save(f.manifest);
  writeFileSync(f.manifestPath, readFileSync(f.manifestPath, 'utf8').replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'));
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /producer JSON form/);
  rmSync(f.manifestPath);
  assert.throws(() => verifyConsoleReceiverBundle(f.repository), /missing input/);
});
