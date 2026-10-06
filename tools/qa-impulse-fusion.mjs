import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedSdk, fileHash } from './build-pointer-bindings.mjs';

assert.ok(process.argv.length === 6 && process.argv[2] === '--sdk-root' && process.argv[4] === '--sdk-manifest',
  'Use --sdk-root <ordinary installed SDK consumer> --sdk-manifest <immutable SDK manifest>');
const root = resolve(import.meta.dirname, '..'), sdk = installedSdk(process.argv[3], process.argv[5]);
const paths = ['packages/device-model/src/impulse-fusion.ts', 'packages/device-model/src/impulse-fusion.test.ts',
  'packages/device-model/src/index.ts', 'examples/impulse-fusion/consumer.mjs', 'tools/qa-impulse-fusion.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(path => [path, fileHash(join(root, path))]));
for (const path of ['packages/device-model/src/impulse-fusion.ts', 'packages/device-model/src/index.ts'])
  assert.equal(sourceSha256[path], sdk.manifest.source.sha256[path], 'Installed fusion producer differs from current source');
for (const [path, hash] of Object.entries(sdk.manifest.source.sha256))
  assert.equal(fileHash(join(root, path)), hash, 'Dependency differs from immutable installed SDK source');
const owned = realpathSync(mkdtempSync(join(sdk.directory, '.101-impulse-caller-')));
try {
  copyFileSync(join(root, 'examples/impulse-fusion/consumer.mjs'), join(owned, 'consumer.mjs'));
  writeFileSync(join(owned, 'resolve.mjs'), `import * as sdk from '@101/connect';import * as model from '@101/device-model';
if(sdk.createImpulseFusionProcessor!==model.createImpulseFusionProcessor||sdk.measurePcmImpulse!==model.measurePcmImpulse)throw Error('Public facade identity');
console.log(JSON.stringify({connect:import.meta.resolve('@101/connect'),model:import.meta.resolve('@101/device-model')}));\n`);
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const run = name => execFileSync(process.execPath, ['--no-experimental-strip-types', join(owned, name)],
    { cwd: owned, env, encoding: 'utf8', timeout: 10000, maxBuffer: 131072 });
  const resolutions = JSON.parse(run('resolve.mjs'));
  for (const [key, packageName] of [['connect', 'connect'], ['model', 'device-model']])
    assert.equal(resolutions[key], pathToFileURL(join(sdk.directory, 'node_modules/@101', packageName, 'dist/index.js')).href);
  const proof = JSON.parse(run('consumer.mjs')); assert.equal(proof.status, 'pass'); assert.equal(proof.checks.length, 15);
  assert.equal(proof.hardwareAccuracy, 'unqualified'); assert.equal(proof.microphonePermissionOpened, false); assert.equal(proof.recording, false);
  for (const [path, hash] of Object.entries(sourceSha256)) assert.equal(fileHash(join(root, path)), hash, 'Caller source changed during proof');
  console.log(JSON.stringify({ result: 'pass', mode: 'ordinary-installed-public-sdk', node: process.version,
    sdkManifestSha256: sdk.manifestSha256, sdkSourceTree: sdk.manifest.source.tree,
    sourceSha256, dependencySourceSha256: sdk.manifest.source.sha256, resolutions, proof, ownedCallerRemoved: true }));
} finally { rmSync(owned, { recursive: true, force: true }); }
