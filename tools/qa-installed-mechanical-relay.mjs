import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { fileHash, installedSdk } from './build-pointer-bindings.mjs';

assert.equal(process.argv.length, 3, 'Pass existing offline SDK consumer directory');
const root = resolve(import.meta.dirname, '..');
const consumerDirectory = resolve(process.argv[2]);
const receiptPath = join(consumerDirectory, 'receipt.json');
const initialReceiptBytes = readFileSync(receiptPath);
const initialReceipt = JSON.parse(initialReceiptBytes.toString('utf8'));
const sdk = installedSdk(consumerDirectory, initialReceipt.manifest.path);
assert.equal(initialReceipt.status, 'pass');
assert.equal(sdk.manifestSha256, initialReceipt.manifest.sha256);
assert.ok(!sdk.directory.startsWith(`${root}/`));

const sources = [
  'packages/hub-server/src/mechanical-relay-gateway.ts',
  'packages/hub-server/src/mechanical-relay-gateway.test.ts',
  'examples/mechanical-relay/software-relay-fixtures.mjs',
  'examples/mechanical-relay/consumer.mjs',
  'tools/qa-mechanical-relay.mjs',
  'tools/qa-installed-mechanical-relay.mjs',
];
const sourceBytes = Object.fromEntries(sources.map(path => [path, readFileSync(join(root, path))]));
const sourceSha256 = Object.fromEntries(sources.map(path =>
  [path, createHash('sha256').update(sourceBytes[path]).digest('hex')]));
const work = mkdtempSync(join(sdk.directory, 'mechanical-relay-connector-'));
const copiedSourcePaths = Object.fromEntries(sources.map((path, index) => {
  const copy = join(work, `source-${index}.bin`);
  writeFileSync(copy, sourceBytes[path]);
  return [path, copy];
}));
const copiedSourceSha256 = Object.fromEntries(Object.entries(copiedSourcePaths).map(([path, copy]) =>
  [path, fileHash(copy)]));
assert.deepEqual(copiedSourceSha256, sourceSha256);

const gateway = ts.transpileModule(sourceBytes[sources[0]].toString('utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const gatewayPath = join(work, 'gateway.mjs');
writeFileSync(gatewayPath, gateway.outputText);
const caller = sourceBytes['examples/mechanical-relay/consumer.mjs'].toString('utf8');
const gatewayImport = "'../../packages/hub-server/src/mechanical-relay-gateway.ts'";
assert.equal(caller.split(gatewayImport).length, 2);
const callerPath = join(work, 'consumer.mjs');
const fixturePath = join(work, 'software-relay-fixtures.mjs');
const resolverPath = join(work, 'resolve.mjs');
writeFileSync(callerPath, caller.replace(gatewayImport, "'./gateway.mjs'"));
writeFileSync(fixturePath, sourceBytes['examples/mechanical-relay/software-relay-fixtures.mjs']);
writeFileSync(resolverPath,
  "export const entry=import.meta.resolve('@101/connect');export * from '@101/connect';\n");
const artifactPaths = Object.freeze({ ...copiedSourcePaths, gatewayPath, callerPath, fixturePath, resolverPath });
const artifactSha256 = Object.fromEntries(Object.entries(artifactPaths).map(([name, path]) => [name, fileHash(path)]));

const installedEntry = await import(pathToFileURL(resolverPath));
assert.ok(installedEntry.entry.startsWith(pathToFileURL(join(sdk.directory, 'node_modules/@101/connect') + '/').href));
const { runMechanicalRelayConsumer } = await import(pathToFileURL(callerPath));
const result = await runMechanicalRelayConsumer();
assert.equal(result.status, 'pass');

const finalReceiptBytes = readFileSync(receiptPath);
const finalReceipt = JSON.parse(finalReceiptBytes.toString('utf8'));
const finalSdk = installedSdk(consumerDirectory, finalReceipt.manifest.path);
assert.equal(createHash('sha256').update(finalReceiptBytes).digest('hex'),
  createHash('sha256').update(initialReceiptBytes).digest('hex'));
assert.equal(finalReceipt.manifest.path, initialReceipt.manifest.path);
assert.equal(finalReceipt.manifest.sha256, initialReceipt.manifest.sha256);
assert.equal(finalSdk.directory, sdk.directory);
assert.equal(finalSdk.manifestSha256, sdk.manifestSha256);
assert.equal(finalSdk.manifestSha256, finalReceipt.manifest.sha256);
for (const [path, hash] of Object.entries(sourceSha256)) assert.equal(fileHash(join(root, path)), hash);
const finalArtifactSha256 = Object.fromEntries(Object.entries(artifactPaths).map(([name, path]) => [name, fileHash(path)]));
assert.deepEqual(finalArtifactSha256, artifactSha256);

const proof = { schemaVersion: 1, status: 'pass', sourceSha256, copiedSourceSha256,
  artifactPaths, artifactSha256, finalArtifactSha256, installedPublicEntry: installedEntry.entry,
  sdkManifest: initialReceipt.manifest, sdkManifestSha256: sdk.manifestSha256,
  finalSdkManifestSha256: finalSdk.manifestSha256, result };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt: join(work, 'receipt.json'), result }));
