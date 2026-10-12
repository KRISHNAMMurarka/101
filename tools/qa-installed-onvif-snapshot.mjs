import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { fileHash, installedSdk } from './build-pointer-bindings.mjs';

function dependencyPins(directory) {
  const files = []; let totalBytes = 0;
  function walk(path, depth) {
    const state = lstatSync(path);
    assert.ok(!state.isSymbolicLink(), 'Dependency pins require ordinary local files');
    if (state.isDirectory()) {
      assert.ok(depth <= 4, 'Dependency pin depth bound exceeded');
      const names = readdirSync(path).sort();
      assert.ok(names.length <= 64, 'Dependency pin directory bound exceeded');
      for (const name of names) walk(join(path, name), depth + 1);
      return;
    }
    assert.ok(state.isFile() && state.size <= 1048576, 'Dependency pin file bound exceeded');
    totalBytes += state.size;
    assert.ok(files.length < 64 && totalBytes <= 4194304, 'Dependency pin total bound exceeded');
    files.push({ path: relative(directory, path).split(sep).join('/'), bytes: state.size, sha256: fileHash(path) });
  }
  walk(directory, 0);
  return files;
}

assert.equal(process.argv.length, 3, 'Pass the existing offline SDK consumer directory');
const root = resolve(import.meta.dirname, '..'), consumer = resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(receipt.status, 'pass');
const sdk = installedSdk(consumer, receipt.manifest.path);
assert.equal(sdk.manifestSha256, receipt.manifest.sha256, 'Consumer manifest fingerprint differs');
assert.ok(!sdk.directory.startsWith(root + '/'));
const work = mkdtempSync(join(sdk.directory, 'onvif-snapshot-'));
const sources = ['packages/hub-server/src/onvif-snapshot-gateway.ts', 'packages/hub-server/src/onvif-snapshot-gateway.test.ts',
  'examples/onvif-snapshot/consumer.mjs', 'examples/onvif-snapshot/software-camera.mjs',
  'tools/qa-onvif-snapshot.mjs', 'tools/qa-installed-onvif-snapshot.mjs', 'packages/hub-server/package.json'];
const sourceSha256 = Object.fromEntries(sources.map(path => [path, fileHash(join(root, path))]));
const dependencyRoot = dirname(createRequire(join(root, 'packages/hub-server/package.json')).resolve('@xmldom/xmldom/package.json'));
const dependencyPackage = JSON.parse(readFileSync(join(dependencyRoot, 'package.json'), 'utf8'));
assert.equal(dependencyPackage.name, '@xmldom/xmldom'); assert.equal(dependencyPackage.version, '0.9.12');
const dependency = { name: dependencyPackage.name, version: dependencyPackage.version,
  packageSha256: fileHash(join(dependencyRoot, 'package.json')), entrySha256: fileHash(join(dependencyRoot, 'lib/index.js')),
  files: dependencyPins(dependencyRoot) };
const copiedDependency = join(work, 'node_modules/@xmldom/xmldom');
cpSync(dependencyRoot, copiedDependency, { recursive: true, errorOnExist: true });
assert.deepEqual(dependencyPins(copiedDependency), dependency.files, 'Copied dependency bytes differ from pins');
assert.deepEqual(dependencyPins(dependencyRoot), dependency.files, 'Source dependency bytes differ from pins');
const compiled = ts.transpileModule(readFileSync(join(root, sources[0]), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
writeFileSync(join(work, 'onvif-snapshot-gateway.mjs'), compiled.outputText);
const caller = readFileSync(join(root, sources[2]), 'utf8');
const gatewayImport = "'../../packages/hub-server/src/onvif-snapshot-gateway.ts'";
assert.equal(caller.split(gatewayImport).length, 2);
writeFileSync(join(work, 'consumer.mjs'), caller.replace(gatewayImport, "'./onvif-snapshot-gateway.mjs'"));
writeFileSync(join(work, 'software-camera.mjs'), readFileSync(join(root, sources[3])));
writeFileSync(join(work, 'resolve.mjs'), "export const entry = import.meta.resolve('@101/connect'); export * from '@101/connect';\n");
const installed = await import(pathToFileURL(join(work, 'resolve.mjs')));
assert.ok(installed.entry.startsWith(pathToFileURL(join(sdk.directory, 'node_modules/@101/connect') + '/').href));
assert.equal(typeof installed.createDeviceRuntime, 'function');
const { runOnvifSnapshotConsumer } = await import(pathToFileURL(join(work, 'consumer.mjs')));
const result = await runOnvifSnapshotConsumer(); assert.equal(result.status, 'pass');
for (const [path, hash] of Object.entries(sourceSha256)) assert.equal(fileHash(join(root, path)), hash);
assert.deepEqual(dependencyPins(copiedDependency), dependency.files, 'Copied dependency bytes differ from pins');
assert.deepEqual(dependencyPins(dependencyRoot), dependency.files, 'Source dependency bytes differ from pins');
const proof = { schemaVersion: 1, status: 'pass', sdkManifest: receipt.manifest, sdkManifestSha256: sdk.manifestSha256,
  sourceSha256, installedPublicEntry: installed.entry, dependency,
  compiledProviderSha256: fileHash(join(work, 'onvif-snapshot-gateway.mjs')), result,
  scope: 'Actual separate child loopback ONVIF snapshot caller using the verified installed public SDK, exact xmldom 0.9.12 resolved from the hub-server package, and separately compiled reviewed gateway. Physical source unverified; remote authentication, playback, PTZ, firmware, and physical qualification remain open.' };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt: join(work, 'receipt.json'), result }));
