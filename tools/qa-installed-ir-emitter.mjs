import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileHash, installedSdk } from './build-pointer-bindings.mjs';

assert.equal(process.argv.length, 3, 'Pass the existing offline SDK consumer directory');
const root = resolve(import.meta.dirname, '..'), consumer = resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(receipt.status, 'pass');
const sdk = installedSdk(consumer, receipt.manifest.path);
assert.equal(sdk.manifestSha256, receipt.manifest.sha256, 'Consumer manifest fingerprint differs');
assert.ok(!sdk.directory.startsWith(root + '/'));
const work = mkdtempSync(join(sdk.directory, 'ir-emitter-connector-'));
const sources = ['packages/hub-server/src/nec32-ir-emitter-gateway.ts', 'packages/hub-server/src/nec32-ir-emitter-gateway.test.ts',
  'examples/ir-emitter/software-emitter.mjs', 'examples/ir-emitter/consumer.mjs',
  'tools/qa-ir-provider-runtime-observer.mjs', 'tools/qa-ir-emitter.mjs',
  'tools/qa-installed-ir-emitter.mjs', 'tools/build-pointer-bindings.mjs'];
const sourceBytes = Object.fromEntries(sources.map(path => [path, readFileSync(join(root, path))]));
const sourceSha256 = Object.fromEntries(sources.map(path => [path, createHash('sha256').update(sourceBytes[path]).digest('hex')]));
const copiedSources = sources.map(path => {
  const copied = join(work, path);
  mkdirSync(dirname(copied), { recursive: true });
  writeFileSync(copied, sourceBytes[path]);
  return { source: path, path: copied, bytes: sourceBytes[path].length, sha256: fileHash(copied) };
});
const copiedSourceSha256 = Object.fromEntries(copiedSources.map(row => [row.source, row.sha256]));
assert.deepEqual(copiedSourceSha256, sourceSha256);
const resolverPath = join(work, 'examples/ir-emitter/resolve.mjs');
writeFileSync(resolverPath, "export const entry = import.meta.resolve('@101/connect'); export * from '@101/connect';\n");
const executedPaths = ['packages/hub-server/src/nec32-ir-emitter-gateway.ts',
  'examples/ir-emitter/consumer.mjs', 'examples/ir-emitter/software-emitter.mjs',
  'tools/qa-ir-provider-runtime-observer.mjs', 'examples/ir-emitter/resolve.mjs'];
const executedArtifacts = executedPaths.map(path => ({ path: join(work, path),
  bytes: readFileSync(join(work, path)).length, sha256: fileHash(join(work, path)) }));
const installed = await import(pathToFileURL(resolverPath));
assert.equal(fileURLToPath(installed.entry), join(sdk.directory, 'node_modules/@101/connect/dist/index.js'),
  'Normal installed public JS entry required');
assert.equal(typeof installed.createDeviceRuntime, 'function');
const { runIrEmitterConsumer } = await import(pathToFileURL(join(work, 'examples/ir-emitter/consumer.mjs')));
const result = await runIrEmitterConsumer();
assert.equal(result.status, 'pass');
const finalReceipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(finalReceipt.manifest.path, receipt.manifest.path, 'SDK manifest path changed during caller execution');
assert.equal(finalReceipt.manifest.sha256, receipt.manifest.sha256, 'SDK receipt fingerprint changed during caller execution');
const finalSdk = installedSdk(consumer, finalReceipt.manifest.path);
assert.equal(finalSdk.directory, sdk.directory, 'Installed SDK directory changed during caller execution');
assert.equal(finalSdk.manifestSha256, sdk.manifestSha256, 'Installed SDK manifest changed during caller execution');
assert.equal(finalSdk.manifestSha256, finalReceipt.manifest.sha256, 'Final installed SDK manifest fingerprint differs');
for (const [path, hash] of Object.entries(sourceSha256))
  assert.equal(fileHash(join(root, path)), hash, `Source changed while QA copied or executed ${path}`);
for (const row of [...copiedSources, ...executedArtifacts])
  assert.equal(fileHash(row.path), row.sha256, `Copied or executed artifact changed: ${row.path}`);
const proof = { schemaVersion: 1, status: 'pass', sourceSha256, copiedSourceSha256, copiedSources, executedArtifacts,
  postExecutionClosureVerified: true, installedPublicEntry: installed.entry, sdkManifest: receipt.manifest,
  sdkManifestSha256: sdk.manifestSha256, finalSdkManifestSha256: finalSdk.manifestSha256,
  privateGatewayMode: 'native-typescript-strip', result,
  scope: 'Actual separate child software IR caller using the verified ordinary installed public JS SDK and byte-exact private gateway with native TypeScript stripping. Provider completion only; no physical carrier, appliance acknowledgement, independently observed appliance state, GPIO, remote service or firmware claim.' };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt: join(work, 'receipt.json'), result }));
