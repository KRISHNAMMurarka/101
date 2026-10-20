import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fixtureWebRuntimePaths = [
  'client/models/pose_landmarker_lite.task', 'client/models/hand_landmarker.task',
  'client/mediapipe/wasm/vision_wasm_internal.js', 'client/mediapipe/wasm/vision_wasm_internal.wasm',
  'client/mediapipe/wasm/vision_wasm_nosimd_internal.js', 'client/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  'client/sw.js', 'client/link.webmanifest', 'client/manifest.webmanifest', 'client/icons/101-link.svg', 'server/BUILD_ID',
  'client/_next/static/chunks/fixture.js', 'client/_next/static/chunks/dependency.js',
  'client/_next/static/css/fixture.css', 'client/_next/static/media/fixture.woff2',
];
const fixtureWebManifest = {
  'virtual:vinext-app-browser-entry': { file: '_next/static/chunks/fixture.js', imports: ['dependency'], css: ['_next/static/css/fixture.css'] },
  dependency: { file: '_next/static/chunks/dependency.js', assets: ['_next/static/media/fixture.woff2'] },
};
const fixtureLegalText = 'Fixture terms — exact bytes\n';
const fixtureLegalHash = digest(fixtureLegalText);
const fixtureLock = JSON.stringify({ packages: {
  'node_modules/runtime-fixture': { version: '1.0.0', license: 'MIT' },
} });
// Exact collector-format records, including text provenance and honest coverage.
const fixtureTexts = [{ sha256: fixtureLegalHash, bytes: Buffer.byteLength(fixtureLegalText), text: fixtureLegalText }];
const fixtureCoverage = { complete: true, lockedPackages: 1, missingPackages: 0, packagesWithoutText: 0,
  distinctTexts: 1, textBytes: Buffer.byteLength(fixtureLegalText) };
const fixtureLicenseInventory = JSON.stringify({ schemaVersion: 1, generatedFrom: 'package-lock.json',
  lockSha256: digest(fixtureLock), declaredSources: null, packages: [{ name: 'runtime-fixture', version: '1.0.0', license: 'MIT',
    installedPath: 'node_modules/runtime-fixture', coverage: 'local-texts', licenseFiles: [{ path: 'LICENSE', sha256: fixtureLegalHash }] }],
  licenseTexts: fixtureTexts, coverage: { ...fixtureCoverage,
    scope: 'Exact ordinary local package legal files and locked declarations; missing optional targets, native/model terms and legal review remain separate.' } }, null, 2) + '\n';
function metadataBytes(path: string) {
  return path === 'THIRD_PARTY_LICENSES.json' ? fixtureLicenseInventory : `fixture ${path}`;
}

function fixture(states: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), '101-package-contract-'));
  mkdirSync(join(root, 'tools'));
  for (const name of ['package-release.mjs', 'license-inventory-validation.mjs', 'generate-license-inventory.mjs', 'web-artifact-validation.mjs']) {
    copyFileSync(resolve(import.meta.dirname, '../tools', name), join(root, 'tools', name));
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'local-packaging-fixture', version: '0.1.0', private: true,
    scripts: { build: 'node emit.mjs web' } }));
  writeFileSync(join(root, 'package-lock.json'), fixtureLock);
  writeFileSync(join(root, 'emit.mjs'), `
    import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    import { gzipSync } from 'node:zlib';
    const target = process.argv[2], state = ${JSON.stringify(states)}[target] ?? 'ok';
    appendFileSync('invoked.log', target + '\\n');
    if (state === 'fail') { console.error('fixture toolchain unavailable'); process.exit(7); }
    if (state === 'missing') process.exit(0);
    const paths = { web: 'dist/server/index.js' };
    const path = paths[target]; mkdirSync(dirname(path), { recursive: true });
    if (state === 'empty') process.exit(0);
    if (state === 'symlink') { writeFileSync('private-fixture.txt', 'outside artifact'); symlinkSync(process.cwd() + '/private-fixture.txt', path); }
    else if (state === 'private-key-content') writeFileSync(path, '-----BEGIN PRIVATE KEY-----\\nfixture\\n-----END PRIVATE KEY-----');
    else if (state === 'local-path-content') writeFileSync(path, 'workspace: ' + process.cwd());
    else writeFileSync(path, 'production-path fixture bytes for ' + target + (['source-drift', 'source-stable'].includes(state) ? readFileSync('build-source.txt', 'utf8') : ''));
    if (state === 'source-drift') appendFileSync('build-source.txt', ' changed during producer');
    if (state === 'lock-drift') appendFileSync('package-lock.json', '\\n ');
    if (state === 'builder-drift') appendFileSync('tools/package-release.mjs', '\\n// changed while running\\n');
    if (state === 'helper-drift') appendFileSync('tools/web-artifact-validation.mjs', '\\n// changed after import\\n');
    if (state === 'declared-source-drift') appendFileSync('THIRD_PARTY_LICENSE_SOURCES.json', '\\n ');
    if (target === 'web') {
      for (const asset of ${JSON.stringify(fixtureWebRuntimePaths)}) {
        mkdirSync(dirname('dist/' + asset), { recursive: true }); writeFileSync('dist/' + asset, 'public asset');
      }
      mkdirSync('dist/client/.vite', { recursive: true });
      const manifest = ${JSON.stringify(fixtureWebManifest)};
      if (state === 'dangling-import') manifest['virtual:vinext-app-browser-entry'].imports = ['not-in-manifest'];
      if (state === 'unsafe-path') manifest.dependency.file = '../outside.js';
      writeFileSync('dist/client/.vite/manifest.json', JSON.stringify(manifest));
      writeFileSync('dist/client/vinext-client-entry-manifest.json', JSON.stringify({ appBrowserEntry: '_next/static/chunks/fixture.js' }));
      if (state === 'missing-model') rmSync('dist/client/models/hand_landmarker.task');
      if (state === 'empty-model') writeFileSync('dist/client/models/hand_landmarker.task', '');
      if (state === 'missing-dependency') rmSync('dist/client/_next/static/chunks/dependency.js');
      if (state === 'empty-css') writeFileSync('dist/client/_next/static/css/fixture.css', '');
      if (state === 'missing-font') rmSync('dist/client/_next/static/media/fixture.woff2');
    }
    if (state === 'input-not-regular') { rmSync('package-lock.json'); mkdirSync('package-lock.json'); }
    if (state === 'mismatched-compression' && target === 'web') {
      mkdirSync('dist/client/_next/static', { recursive: true });
      writeFileSync('dist/client/_next/static/fixture.js', 'public asset');
      writeFileSync('dist/client/_next/static/fixture.js.gz', gzipSync('different private payload'));
    }
  `);
  for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES.json',
    'third_party/APACHE-2.0.txt', 'docs/vision.md']) {
    mkdirSync(resolve(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), metadataBytes(path));
  }
  mkdirSync(join(root, 'release/sdk-existing'), { recursive: true });
  writeFileSync(join(root, 'release/sdk-existing/keep.tgz'), 'prior immutable artifact');
  return { root,
    run(args: string[]) { return spawnSync(process.execPath, ['tools/package-release.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 }); },
    manifests() { return readdirSync(join(root, 'release')).filter(name => name.startsWith('package-')).map(name => ({
      path: join(root, 'release', name, 'manifest.json'), value: JSON.parse(readFileSync(join(root, 'release', name, 'manifest.json'), 'utf8')) })); },
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test('release packaging fails the required web producer and retains prior artifacts', () => {
  const f = fixture({ web: 'fail' });
  try {
    const result = f.run(['--release', 'web']); assert.equal(result.status, 1, result.stdout + result.stderr);
    const { value: manifest } = f.manifests()[0];
    assert.equal(manifest.mode, 'release'); assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.releaseAccepted, false); assert.equal(manifest.packagingComplete, false);
    assert.deepEqual(manifest.requiredTargets, ['web']); assert.deepEqual(manifest.produced, []);
    assert.deepEqual(manifest.skipped.map((entry: {target:string}) => entry.target), ['web']);
    assert.equal(readFileSync(join(f.root, 'release/sdk-existing/keep.tgz'), 'utf8'), 'prior immutable artifact');
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
    const result = f.run(['--release', 'web']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const manifest = f.manifests()[0].value;
    assert.equal(manifest.status, 'complete'); assert.equal(manifest.packagingComplete, true);
    assert.equal(manifest.releaseAccepted, false);
    assert.deepEqual(manifest.requiredTargets, ['web']);
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
      'third_party/APACHE-2.0.txt', 'docs/vision.md']) {
      assert.equal(readFileSync(join(artifact, path), 'utf8'), metadataBytes(path));
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
      if (drift === 'extra') inventory.packages.push({ ...inventory.packages[0], name: 'not-locked' });
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

test('default release selects only the production web application', () => {
  const f = fixture(); try {
    assert.equal(f.run(['--release']).status, 0);
    const manifest = f.manifests()[0].value;
    assert.deepEqual(manifest.requiredTargets, ['web']);
    assert.equal(manifest.releaseAccepted, false); assert.equal(manifest.packagingComplete, true);
    assert.equal(readFileSync(join(f.root, 'invoked.log'), 'utf8'), 'web\n');
  } finally { f.close(); }
});

test('diagnostic mode reports a web build skip without acceptance', () => {
  const f = fixture({web:'fail'}); try {
    assert.equal(f.run([]).status, 0);
    const manifest = f.manifests()[0].value;
    assert.equal(manifest.mode, 'diagnostic'); assert.equal(manifest.status, 'diagnostic');
    assert.equal(manifest.packagingComplete, false); assert.equal(manifest.releaseAccepted, false);
    assert.deepEqual(manifest.requiredTargets, []); assert.deepEqual(manifest.produced, []);
    assert.deepEqual(manifest.skipped.map((entry:{target:string}) => entry.target), ['web']);
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


test('web packaging needs no native source tree or Rust inventory', () => {
  const f = fixture(); try {
    assert.equal(existsSync(join(f.root, 'apps')), false);
    assert.equal(existsSync(join(f.root, 'THIRD_PARTY_RUST_LICENSES.json')), false);
    const result = f.run(['--release','web']); assert.equal(result.status, 0, result.stdout + result.stderr);
    const {value, path} = f.manifests()[0];
    assert.equal(value.packagingComplete, true);
    assert.equal(existsSync(resolve(path,'..','web','THIRD_PARTY_RUST_LICENSES.json')), false);
  } finally { f.close(); }
});

test('web packaging rejects broken embedded license provenance for the game dependency inventory before building', () => {
  for (const file of ['THIRD_PARTY_LICENSES.json']) {
    for (const drift of ['lock', 'text', 'bytes', 'reference', 'package', 'coverage', 'duplicate']) {
      const f = fixture();
      try {
        const inventory = JSON.parse(metadataBytes(file));
        if (drift === 'lock') inventory.lockSha256 = '0'.repeat(64);
        if (drift === 'text') inventory.licenseTexts[0].text += 'changed';
        if (drift === 'bytes') inventory.licenseTexts[0].bytes++;
        if (drift === 'reference') inventory.licenseTexts = [];
        if (drift === 'package') {
          if (file === 'THIRD_PARTY_LICENSES.json') inventory.packages[0].installedPath = 'node_modules/substitute';
          else inventory.packages[0].name = 'substitute';
        }
        if (drift === 'coverage') inventory.coverage.textBytes++;
        if (drift === 'duplicate') inventory.packages.push(inventory.packages[0]);
        writeFileSync(join(f.root, file), JSON.stringify(inventory));
        const result = f.run(['--release', 'web']);
        assert.equal(result.status, 1, `${file} ${drift}: ${result.stdout}${result.stderr}`);
        const { path, value } = f.manifests()[0];
        assert.deepEqual(value.produced, []);
        assert.equal(existsSync(join(f.root, 'invoked.log')), false);
        assert.equal(existsSync(resolve(path, '..', 'web')), false);
      } finally { f.close(); }
    }
  }
});

test('valid inventories with missing local legal texts retain their incomplete coverage', () => {
  const f = fixture();
  try {
    for (const file of ['THIRD_PARTY_LICENSES.json']) {
      const inventory = JSON.parse(metadataBytes(file));
      inventory.packages[0].coverage = 'no-local-text'; inventory.packages[0].licenseFiles = [];
      inventory.licenseTexts = [];
      inventory.coverage = { ...inventory.coverage, complete: false, packagesWithoutText: 1, distinctTexts: 0, textBytes: 0 };
      writeFileSync(join(f.root, file), JSON.stringify(inventory));
    }
    const result = f.run(['--release', 'web']); assert.equal(result.status, 0, result.stdout + result.stderr);
    const { path, value } = f.manifests()[0]; assert.equal(value.packagingComplete, true); assert.equal(value.releaseAccepted, false);
    for (const file of ['THIRD_PARTY_LICENSES.json']) {
      const copied = JSON.parse(readFileSync(resolve(path, '..', 'web', file), 'utf8'));
      assert.equal(copied.coverage.complete, false); assert.equal(copied.coverage.packagesWithoutText, 1);
    }
  } finally { f.close(); }
});


test('packaging fixtures preserve the actual JavaScript collector output contract', async () => {
  const f = fixture();
  try {
    const root = realpathSync(f.root), installed = join(root, 'node_modules/runtime-fixture');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'runtime-fixture', version: '1.0.0' }));
    writeFileSync(join(installed, 'LICENSE'), fixtureLegalText);
    const js = await import('../tools/generate-license-inventory.mjs');
    assert.deepEqual(await js.collectLicenseInventory({ root }), JSON.parse(fixtureLicenseInventory));
  } finally { f.close(); }
});


test('web packaging rejects absent and empty declared runtime assets after a successful producer', () => {
  for (const state of ['missing-model', 'empty-model', 'missing-dependency', 'empty-css', 'missing-font']) {
    const f = fixture({ web: state });
    try {
      const result = f.run(['--release', 'web']); assert.equal(result.status, 1, state + ': ' + result.stdout + result.stderr);
      const { path, value } = f.manifests()[0]; assert.deepEqual(value.produced, []);
      assert.equal(value.packagingComplete, false); assert.match(value.skipped[0].reason, /required web asset/i);
      assert.equal(readFileSync(join(f.root, 'invoked.log'), 'utf8'), 'web\n');
      assert.equal(existsSync(resolve(path, '..', 'web')), false);
    } finally { f.close(); }
  }
});

test('web packaging rejects dangling manifest imports and unsafe dependency paths', () => {
  for (const state of ['dangling-import', 'unsafe-path']) {
    const f = fixture({ web: state });
    try {
      const result = f.run(['--release', 'web']); assert.equal(result.status, 1, state + ': ' + result.stdout + result.stderr);
      const { path, value } = f.manifests()[0]; assert.deepEqual(value.produced, []);
      assert.match(value.skipped[0].reason, /web (?:manifest|asset path)/i);
      assert.equal(existsSync(resolve(path, '..', 'web')), false);
    } finally { f.close(); }
  }
});

for (const drift of ['lock-drift', 'builder-drift', 'helper-drift', 'source-drift']) {
  test(`packaging rejects ${drift} during a successful producer`, () => {
    const f = fixture({ web: drift });
    try {
      if (drift === 'source-drift') {
        writeFileSync(join(f.root, '.gitignore'), 'dist/\nrelease/\ninvoked.log\n');
        writeFileSync(join(f.root, 'build-source.txt'), 'committed source');
        for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Owned fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Owned source fixture']]) {
          const git = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' }); assert.equal(git.status, 0, git.stderr);
        }
        writeFileSync(join(f.root, 'build-source.txt'), 'dirty source consumed by producer');
      }
      const result = f.run(['--release', 'web']);
      const record = f.manifests()[0];
      const copied = resolve(record.path, '..', 'web/THIRD_PARTY_LICENSES.json');
      const proof = { drift, status: result.status, stdout: result.stdout, stderr: result.stderr, manifest: record.value,
        originalLockSha256: digest(fixtureLock), currentLockSha256: digest(readFileSync(join(f.root, 'package-lock.json'))),
        copiedInventoryLockSha256: existsSync(copied) ? JSON.parse(readFileSync(copied, 'utf8')).lockSha256 : null,
        invoked: readFileSync(join(f.root, 'invoked.log'), 'utf8'),
        finalSource: drift === 'source-drift' ? readFileSync(join(f.root, 'build-source.txt'), 'utf8') : null };
      assert.equal(result.status, 1, JSON.stringify(proof));
      assert.equal(record.value.packagingComplete, false);
      assert.equal(record.value.buildInputVerification.stable, false);
      assert.ok(record.value.buildInputVerification.changedInputs.length > 0);
      assert.deepEqual(record.value.produced, []);
      assert.equal(existsSync(resolve(record.path, '..', 'web')), false);
    } finally { f.close(); }
  });
}

test('a stable initially dirty source remains eligible for packaging with exact input provenance', () => {
  const f = fixture({ web: 'source-stable' });
  try {
    writeFileSync(join(f.root, '.gitignore'), 'dist/\nrelease/\ninvoked.log\n');
    writeFileSync(join(f.root, 'build-source.txt'), 'committed source');
    for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Owned fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Owned source fixture']]) {
      const git = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' }); assert.equal(git.status, 0, git.stderr);
    }
    writeFileSync(join(f.root, 'build-source.txt'), 'dirty source consumed by producer');
    const result = f.run(['--release', 'web']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const { value, path } = f.manifests()[0];
    assert.equal(value.packagingComplete, true);
    assert.equal(value.source.workingTreeClean, false);
    assert.equal(value.buildInputVerification.stable, true);
    assert.deepEqual(value.buildInputVerification.changedInputs, []);
    assert.equal(value.source.inputs.files.find((entry: { path: string }) => entry.path === 'build-source.txt').sha256, digest('dirty source consumed by producer'));
    assert.match(readFileSync(resolve(path, '..', 'web/server/index.js'), 'utf8'), /dirty source consumed by producer/);
  } finally { f.close(); }
});

for (const mode of ['release', 'diagnostic']) {
  test(`a failed final input snapshot withdraws copies and retains a ${mode} report`, () => {
    const f = fixture({ web: 'input-not-regular' });
    try {
      const result = f.run(mode === 'release' ? ['--release', 'web'] : ['web']);
      const owned = readdirSync(join(f.root, 'release')).find(name => name.startsWith('package-'))!;
      const manifestPath = join(f.root, 'release', owned, 'manifest.json');
      assert.equal(existsSync(manifestPath), true, result.stdout + result.stderr);
      const value = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.equal(result.status, mode === 'release' ? 1 : 0, result.stdout + result.stderr);
      assert.equal(value.status, mode === 'release' ? 'incomplete' : 'diagnostic');
      assert.equal(value.packagingComplete, false);
      assert.equal(value.buildInputVerification.stable, false);
      assert.equal(value.buildInputVerification.after, null);
      // Either the general snapshot or the earlier legal-source preflight can refuse the same invalid lock input.
      assert.match(value.buildInputVerification.error, /^(?:Build input is not a regular file: package-lock\.json|License inventory requires ordinary local files and directories)$/);
      assert.deepEqual(value.produced, []);
      assert.equal(existsSync(join(f.root, 'release', owned, 'web')), false);
      assert.equal(readFileSync(join(f.root, 'release/sdk-existing/keep.tgz'), 'utf8'), 'prior immutable artifact');
    } finally { f.close(); }
  });
}

test('web packaging rejects omitted declared legal sources before invoking its producer', () => {
  const f = fixture();
  try {
    const sources = JSON.stringify({ schemaVersion: 1, packages: [{ name: 'runtime-fixture', version: '1.0.0', installedPath: 'node_modules/runtime-fixture',
      licenseFiles: [{ path: 'README.md', sha256: fixtureLegalHash }] }] }) + '\n';
    writeFileSync(join(f.root, 'THIRD_PARTY_LICENSE_SOURCES.json'), sources);
    const inventory = JSON.parse(fixtureLicenseInventory);
    inventory.declaredSources = { path: 'THIRD_PARTY_LICENSE_SOURCES.json', sha256: digest(sources) };
    // The embedded bytes remain internally valid, but the required README source is missing.
    writeFileSync(join(f.root, 'THIRD_PARTY_LICENSES.json'), JSON.stringify(inventory));
    const result = f.run(['--release', 'web']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(f.manifests()[0].value.produced, []); assert.equal(existsSync(join(f.root, 'invoked.log')), false);
  } finally { f.close(); }
});

function declareFixtureSources(root: string) {
  const sources = JSON.stringify({ schemaVersion: 1, packages: [{ name: 'runtime-fixture', version: '1.0.0', installedPath: 'node_modules/runtime-fixture',
    licenseFiles: [{ path: 'README.md', sha256: fixtureLegalHash }] }] }) + '\n';
  writeFileSync(join(root, 'THIRD_PARTY_LICENSE_SOURCES.json'), sources);
  const inventory = JSON.parse(fixtureLicenseInventory);
  inventory.declaredSources = { path: 'THIRD_PARTY_LICENSE_SOURCES.json', sha256: digest(sources) };
  inventory.packages[0].licenseFiles = [{ path: 'README.md', sha256: fixtureLegalHash }];
  writeFileSync(join(root, 'THIRD_PARTY_LICENSES.json'), JSON.stringify(inventory));
  return { sources, inventory };
}

test('packaging admits exact declared source provenance and preserves its embedded terms', () => {
  const f = fixture(); try {
    declareFixtureSources(f.root); const result = f.run(['--release', 'web']); assert.equal(result.status, 0, result.stdout + result.stderr);
    const record = f.manifests()[0]; const embedded = JSON.parse(readFileSync(resolve(record.path, '..', 'web/THIRD_PARTY_LICENSES.json'), 'utf8'));
    assert.equal(embedded.licenseTexts[0].text, fixtureLegalText); assert.equal(embedded.packages[0].licenseFiles[0].path, 'README.md');
    assert.equal(record.value.source.inputs.files.find((entry: { path: string }) => entry.path === 'THIRD_PARTY_LICENSE_SOURCES.json').sha256, digest(readFileSync(join(f.root, 'THIRD_PARTY_LICENSE_SOURCES.json'))));
    assert.equal(record.value.releaseAccepted, false);
  } finally { f.close(); }
});

test('packaging rejects changed, removed or dangling declared source provenance before invoking a producer', () => {
  for (const drift of ['manifest-hash', 'source-hash', 'removed-manifest', 'unresolved-manifest']) {
    const f = fixture(); try {
      const { inventory } = declareFixtureSources(f.root);
      if (drift === 'manifest-hash') inventory.declaredSources.sha256 = '0'.repeat(64);
      if (drift === 'source-hash') {
        const changed = JSON.parse(readFileSync(join(f.root, 'THIRD_PARTY_LICENSE_SOURCES.json'), 'utf8'));
        changed.packages[0].licenseFiles[0].sha256 = '0'.repeat(64); const raw = JSON.stringify(changed); writeFileSync(join(f.root, 'THIRD_PARTY_LICENSE_SOURCES.json'), raw);
        inventory.declaredSources.sha256 = digest(raw);
      }
      if (drift === 'removed-manifest') rmSync(join(f.root, 'THIRD_PARTY_LICENSE_SOURCES.json'));
      if (drift === 'unresolved-manifest') delete inventory.declaredSources;
      writeFileSync(join(f.root, 'THIRD_PARTY_LICENSES.json'), JSON.stringify(inventory));
      const result = f.run(['--release', 'web']); assert.equal(result.status, 1, drift + result.stdout + result.stderr);
      assert.deepEqual(f.manifests()[0].value.produced, []); assert.equal(existsSync(join(f.root, 'invoked.log')), false);
    } finally { f.close(); }
  }
});

test('a declared source manifest changed during the actual producer withdraws its owned package copy', () => {
  const f = fixture({ web: 'declared-source-drift' }); try {
    declareFixtureSources(f.root); const result = f.run(['--release', 'web']); assert.equal(result.status, 1, result.stdout + result.stderr);
    const record = f.manifests()[0]; assert.equal(record.value.buildInputVerification.stable, false);
    assert.ok(record.value.buildInputVerification.changedInputs.some((entry: { path: string }) => entry.path === 'THIRD_PARTY_LICENSE_SOURCES.json'));
    assert.deepEqual(record.value.produced, []); assert.equal(existsSync(resolve(record.path, '..', 'web')), false);
    assert.equal(readFileSync(join(f.root, 'release/sdk-existing/keep.tgz'), 'utf8'), 'prior immutable artifact');
  } finally { f.close(); }
});

test('101 refuses moved native targets before producing output', () => {
  const f = fixture();
  try {
    for (const target of ['hub', 'link', 'wear']) {
      assert.equal(f.run([target]).status, 1);
      assert.equal(f.manifests().length, 0);
      assert.equal(existsSync(join(f.root, 'invoked.log')), false);
    }
  } finally { f.close(); }
});
