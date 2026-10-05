import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const fixtureLicenseInventory = JSON.stringify({ schemaVersion: 1, generatedFrom: 'package-lock.json',
  packages: [{ name: 'runtime-fixture', version: '1.0.0', license: 'MIT' }] }, null, 2) + '\n';

function fixture(states: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), '101-package-contract-'));
  mkdirSync(join(root, 'tools'));
  copyFileSync(resolve(import.meta.dirname, '../tools/package-release.mjs'), join(root, 'tools/package-release.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'local-packaging-fixture', version: '0.1.0', private: true,
    scripts: { build: 'node emit.mjs web', 'desktop:app': 'node emit.mjs hub', 'native:export': 'node emit.mjs link', 'watch:wear:build': 'node emit.mjs wear' } }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/runtime-fixture': { version: '1.0.0', license: 'MIT' },
  } }));
  writeFileSync(join(root, 'emit.mjs'), `
    import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    import { gzipSync } from 'node:zlib';
    const target = process.argv[2], state = ${JSON.stringify(states)}[target] ?? 'ok';
    appendFileSync('invoked.log', target + '\\n');
    if (state === 'fail') { console.error('fixture toolchain unavailable'); process.exit(7); }
    if (state === 'missing') process.exit(0);
    const paths = { web: 'dist/server/index.js', hub: 'apps/desktop-hub/src-tauri/target/release/bundle/macos/101 Hub.app/Contents/MacOS/101 Hub',
      link: 'apps/controller-native/dist/_expo/static/js/ios/entry-test.hbc', wear: 'apps/watch-wear/app/build/outputs/apk/debug/app-debug.apk' };
    const path = paths[target]; mkdirSync(dirname(path), { recursive: true });
    if (state === 'empty') process.exit(0);
    if (state === 'symlink') { writeFileSync('private-fixture.txt', 'outside artifact'); symlinkSync(process.cwd() + '/private-fixture.txt', path); }
    else if (state === 'private-key-content') writeFileSync(path, '-----BEGIN PRIVATE KEY-----\\nfixture\\n-----END PRIVATE KEY-----');
    else if (state === 'local-path-content') writeFileSync(path, 'workspace: ' + process.cwd());
    else writeFileSync(path, 'production-path fixture bytes for ' + target);
    if (state === 'mismatched-compression' && target === 'web') {
      mkdirSync('dist/client/_next/static', { recursive: true });
      writeFileSync('dist/client/_next/static/fixture.js', 'public asset');
      writeFileSync('dist/client/_next/static/fixture.js.gz', gzipSync('different private payload'));
    }
  `);
  for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.json',
    'THIRD_PARTY_RUST_LICENSES.json', 'third_party/APACHE-2.0.txt', 'docs/vision.md']) {
    mkdirSync(resolve(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), path === 'THIRD_PARTY_LICENSES.json' ? fixtureLicenseInventory : `fixture ${path}`);
  }
  mkdirSync(join(root, 'release/sdk-existing'), { recursive: true });
  writeFileSync(join(root, 'release/sdk-existing/keep.tgz'), 'prior immutable artifact');
  return { root,
    run(args: string[]) { return spawnSync(process.execPath, ['tools/package-release.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 }); },
    manifests() { return readdirSync(join(root, 'release')).filter(name => name.startsWith('package-')).map(name => ({
      path: join(root, 'release', name, 'manifest.json'), value: JSON.parse(readFileSync(join(root, 'release', name, 'manifest.json'), 'utf8')) })); },
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test('release packaging fails a missing required target while retaining successful artifacts', () => {
  const f = fixture({ hub: 'fail' });
  try {
    const result = f.run(['--release', 'web', 'hub']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const { value: manifest, path } = f.manifests()[0];
    assert.equal(manifest.mode, 'release'); assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.releaseAccepted, false); assert.equal(manifest.packagingComplete, false);
    assert.deepEqual(manifest.requiredTargets, ['web', 'hub']);
    assert.deepEqual(manifest.produced.map((entry: { target: string }) => entry.target), ['web']);
    assert.deepEqual(manifest.skipped.map((entry: { target: string }) => entry.target), ['hub']);
    assert.ok(existsSync(resolve(path, '..', 'web/server/index.js')));
  } finally { f.close(); }
});

test('packaging preserves prior artifacts and creates a different owned output on each invocation', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['web']).status, 0);
    assert.equal(readFileSync(join(f.root, 'release/sdk-existing/keep.tgz'), 'utf8'), 'prior immutable artifact');
    const first = f.manifests()[0];
    assert.equal(f.run(['web']).status, 0);
    assert.equal(f.manifests().length, 2);
    assert.equal(readFileSync(first.path, 'utf8'), JSON.stringify(first.value, null, 2) + '\n');
    assert.equal(first.value.status, 'diagnostic'); assert.equal(first.value.releaseAccepted, false);
  } finally { f.close(); }
});

test('complete production packaging is distinct from release acceptance', () => {
  const f = fixture();
  try {
    const result = f.run(['--release', 'hub', 'web']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const manifest = f.manifests()[0].value;
    assert.equal(manifest.status, 'complete'); assert.equal(manifest.packagingComplete, true);
    assert.equal(manifest.releaseAccepted, false);
    assert.deepEqual(manifest.requiredTargets, ['hub', 'web']);
    assert.ok(manifest.produced.every((entry: { profile: string }) => entry.profile === 'production'));
    assert.deepEqual(manifest.skipped, []);
  } finally { f.close(); }
});

test('the web release artifact carries its license, model attribution and locked inventories', () => {
  const f = fixture();
  try {
    const result = f.run(['--release', 'web']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const artifact = resolve(f.manifests()[0].path, '..', 'web');
    for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.json',
      'THIRD_PARTY_RUST_LICENSES.json', 'third_party/APACHE-2.0.txt', 'docs/vision.md']) {
      assert.equal(readFileSync(join(artifact, path), 'utf8'), path === 'THIRD_PARTY_LICENSES.json' ? fixtureLicenseInventory : `fixture ${path}`);
    }
  } finally { f.close(); }
});

test('the release manifest fingerprints copied files and records provenance honestly', () => {
  const f = fixture();
  try {
    const result = f.run(['--release', 'web']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const manifest = f.manifests()[0].value;
    const artifact = manifest.produced[0];
    const license = artifact.contents?.find((entry: { path: string }) => entry.path === 'LICENSE');
    assert.equal(license?.bytes, Buffer.byteLength('fixture LICENSE'));
    assert.equal(license?.sha256, createHash('sha256').update('fixture LICENSE').digest('hex'));
    assert.ok(artifact.contents.some((entry: { path: string }) => entry.path === 'server/index.js'));
    assert.equal(artifact.bytes, artifact.contents.reduce((sum: number, entry: { bytes: number }) => sum + entry.bytes, 0));
    const digest = createHash('sha256');
    for (const entry of artifact.contents) digest.update(JSON.stringify(entry) + '\n');
    assert.equal(artifact.sha256, digest.digest('hex'));
    assert.ok(artifact.bytes > license.bytes);
    assert.match(manifest.builderSha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(manifest.source?.workingTreeClean, null, 'a fixture outside Git cannot claim a clean revision');
    assert.equal(manifest.releaseAccepted, false);
  } finally { f.close(); }
});

test('a missing required attribution leaves no distributable web artifact', () => {
  const f = fixture();
  try {
    rmSync(join(f.root, 'third_party/APACHE-2.0.txt'));
    const result = f.run(['--release', 'web']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const { path, value } = f.manifests()[0];
    assert.equal(value.packagingComplete, false);
    assert.deepEqual(value.produced, []);
    assert.equal(existsSync(resolve(path, '..', 'web')), false);
  } finally { f.close(); }
});

test('a stale JavaScript license inventory cannot be packaged as a release', () => {
  for (const drift of ['version', 'license', 'missing', 'extra']) {
    const f = fixture();
    try {
      const inventory = JSON.parse(fixtureLicenseInventory);
      if (drift === 'version') inventory.packages[0].version = '0.9.0';
      if (drift === 'license') inventory.packages[0].license = 'Apache-2.0';
      if (drift === 'missing') inventory.packages = [];
      if (drift === 'extra') inventory.packages.push({ name: 'not-locked', version: '1.0.0', license: 'MIT' });
      writeFileSync(join(f.root, 'THIRD_PARTY_LICENSES.json'), JSON.stringify(inventory));
      const result = f.run(['--release', 'web']);
      assert.equal(result.status, 1, `${drift}: ${result.stdout}${result.stderr}`);
      const { path, value } = f.manifests()[0];
      assert.deepEqual(value.produced, []);
      assert.equal(existsSync(resolve(path, '..', 'web')), false);
    } finally { f.close(); }
  }
});

test('packaging rejects credentials accidentally emitted into an artifact', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'dist/client'), { recursive: true });
    writeFileSync(join(f.root, 'dist/client/.env.production'), 'PRIVATE_TOKEN=fixture');
    const result = f.run(['--release', 'web']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const { path, value } = f.manifests()[0];
    assert.deepEqual(value.produced, []);
    assert.equal(existsSync(resolve(path, '..', 'web')), false);
  } finally { f.close(); }
});

test('release packaging rejects private key text and local workspace paths inside allowed files', () => {
  for (const state of ['private-key-content', 'local-path-content']) {
    const f = fixture({ web: state });
    try {
      const result = f.run(['--release', 'web']);
      assert.equal(result.status, 1, state + ': ' + result.stdout + result.stderr);
      const { path, value } = f.manifests()[0];
      assert.deepEqual(value.produced, []);
      assert.equal(existsSync(resolve(path, '..', 'web')), false);
    } finally { f.close(); }
  }
});

test('web packaging rejects compressed assets that differ from their plain sibling', () => {
  const f = fixture({ web: 'mismatched-compression' });
  try {
    const result = f.run(['--release', 'web']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const { path, value } = f.manifests()[0];
    assert.deepEqual(value.produced, []);
    assert.equal(existsSync(resolve(path, '..', 'web')), false);
  } finally { f.close(); }
});

test('web packaging rejects an unexpected build output file', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'dist/client'), { recursive: true });
    writeFileSync(join(f.root, 'dist/client/debug.log'), 'fixture diagnostic');
    const result = f.run(['--release', 'web']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const { path, value } = f.manifests()[0];
    assert.deepEqual(value.produced, []);
    assert.equal(existsSync(resolve(path, '..', 'web')), false);
  } finally { f.close(); }
});

test('release mode blocks debug and intermediate targets before invoking their producer', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['--release', 'wear', 'link']).status, 1);
    const manifest = f.manifests()[0].value;
    assert.equal(manifest.status, 'incomplete'); assert.equal(manifest.releaseAccepted, false);
    assert.deepEqual(manifest.produced, []);
    assert.deepEqual(manifest.skipped.map((entry: { profile: string }) => entry.profile), ['debug', 'intermediate']);
    assert.equal(existsSync(join(f.root, 'invoked.log')), false);
    assert.equal(f.run(['--release']).status, 1);
    assert.deepEqual(f.manifests().find(entry => entry.value.requiredTargets.length === 4)?.value.requiredTargets, ['web', 'hub', 'link', 'wear']);
  } finally { f.close(); }
});

test('diagnostic mode reports independent build skips and debug profiles without acceptance', () => {
  const f = fixture({ hub: 'fail' });
  try {
    assert.equal(f.run(['web', 'hub', 'wear']).status, 0);
    const manifest = f.manifests()[0].value;
    assert.equal(manifest.mode, 'diagnostic'); assert.equal(manifest.status, 'diagnostic');
    assert.equal(manifest.packagingComplete, false); assert.equal(manifest.releaseAccepted, false);
    assert.deepEqual(manifest.requiredTargets, []);
    assert.deepEqual(manifest.produced.map((entry: { profile: string }) => entry.profile), ['production', 'debug']);
    assert.deepEqual(manifest.skipped.map((entry: { target: string }) => entry.target), ['hub']);
  } finally { f.close(); }
});

test('release packaging rejects missing, empty and symlink artifacts even when the producer exits zero', () => {
  for (const state of ['missing', 'empty', 'symlink']) {
    const f = fixture({ web: state });
    try {
      const result = f.run(['--release', 'web']);
      assert.equal(result.status, 1, state + ': ' + result.stdout + result.stderr);
      const { value: manifest, path } = f.manifests()[0];
      assert.deepEqual(manifest.produced, []); assert.equal(manifest.skipped.length, 1);
      assert.equal(manifest.releaseAccepted, false); assert.equal(existsSync(resolve(path, '..', 'web')), false);
    } finally { f.close(); }
  }
});

test('unknown, mixed, duplicate and conflicting arguments fail before invoking or creating outputs', () => {
  const f = fixture();
  try {
    for (const args of [['web', 'unknown'], ['--unknown', 'web'], ['--release', '--release', 'web'], ['web', 'web']]) {
      assert.equal(f.run(args).status, 1, args.join(' '));
      assert.equal(f.manifests().length, 0); assert.equal(existsSync(join(f.root, 'invoked.log')), false);
    }
    assert.equal(readFileSync(join(f.root, 'release/sdk-existing/keep.tgz'), 'utf8'), 'prior immutable artifact');
  } finally { f.close(); }
});
