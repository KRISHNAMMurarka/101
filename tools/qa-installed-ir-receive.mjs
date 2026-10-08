import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { fileHash, installedSdk } from './build-pointer-bindings.mjs';

assert.equal(process.argv.length, 3, 'Pass existing offline SDK consumer directory');
const root = resolve(import.meta.dirname, '..'), consumer = resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
const sdk = installedSdk(consumer, receipt.manifest.path);
assert.equal(receipt.status, 'pass');
assert.equal(sdk.manifestSha256, receipt.manifest.sha256);
assert.ok(!sdk.directory.startsWith(root + '/'));
const work = mkdtempSync(join(sdk.directory, 'ir-receive-connector-'));
const sources = ['packages/hub-server/src/nec32-ir-receive-gateway.ts',
  'packages/hub-server/src/nec32-ir-receive-gateway.test.ts',
  'examples/ir-receive/software-receiver.mjs', 'examples/ir-receive/consumer.mjs',
  'tools/qa-ir-receive.mjs', 'tools/qa-installed-ir-receive.mjs'];
const bytes = Object.fromEntries(sources.map(path => [path, readFileSync(join(root, path))]));
const sourceSha256 = Object.fromEntries(sources.map(path =>
  [path, createHash('sha256').update(bytes[path]).digest('hex')]));
const copiedSources = sources.map((path, index) => {
  const copied = join(work, `source-${index}.bin`);
  writeFileSync(copied, bytes[path]);
  return { source: path, path: copied, sha256: fileHash(copied) };
});
const copiedSourceSha256 = Object.fromEntries(copiedSources.map(row => [row.source, row.sha256]));
assert.deepEqual(copiedSourceSha256, sourceSha256);
const compiled = ts.transpileModule(bytes[sources[0]].toString('utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
writeFileSync(join(work, 'gateway.mjs'), compiled.outputText);
const caller = bytes['examples/ir-receive/consumer.mjs'].toString('utf8');
const needle = "'../../packages/hub-server/src/nec32-ir-receive-gateway.ts'";
assert.equal(caller.split(needle).length, 2);
writeFileSync(join(work, 'consumer.mjs'), caller.replace(needle, "'./gateway.mjs'"));
writeFileSync(join(work, 'software-receiver.mjs'), bytes['examples/ir-receive/software-receiver.mjs']);
writeFileSync(join(work, 'resolve.mjs'), "export const entry=import.meta.resolve('@101/connect');export * from '@101/connect';\n");
const executedArtifacts = ['gateway.mjs', 'consumer.mjs', 'software-receiver.mjs', 'resolve.mjs']
  .map(name => ({ path: join(work, name), sha256: fileHash(join(work, name)) }));
const installed = await import(pathToFileURL(join(work, 'resolve.mjs')));
assert.ok(installed.entry.startsWith(pathToFileURL(join(sdk.directory, 'node_modules/@101/connect') + '/').href));
const { runIrReceiveConsumer } = await import(pathToFileURL(join(work, 'consumer.mjs')));
const result = await runIrReceiveConsumer();
assert.equal(result.status, 'pass');
const finalReceipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
const finalSdk = installedSdk(consumer, finalReceipt.manifest.path);
assert.equal(finalReceipt.manifest.path, receipt.manifest.path);
assert.equal(finalReceipt.manifest.sha256, receipt.manifest.sha256);
assert.equal(finalSdk.directory, sdk.directory);
assert.equal(finalSdk.manifestSha256, sdk.manifestSha256);
assert.equal(finalSdk.manifestSha256, finalReceipt.manifest.sha256);
for (const [path, hash] of Object.entries(sourceSha256)) assert.equal(fileHash(join(root, path)), hash);
for (const row of [...copiedSources, ...executedArtifacts])
  assert.equal(fileHash(row.path), row.sha256, `Copied or executed artifact changed: ${row.path}`);
const proof = { schemaVersion: 1, status: 'pass', sourceSha256, copiedSourceSha256,
  copiedSources, executedArtifacts, postExecutionClosureVerified: true,
  installedPublicEntry: installed.entry, sdkManifest: receipt.manifest,
  sdkManifestSha256: sdk.manifestSha256, finalSdkManifestSha256: finalSdk.manifestSha256, result };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt: join(work, 'receipt.json'), result }));
