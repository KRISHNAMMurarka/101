import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { fileHash, installedSdk } from './build-pointer-bindings.mjs';

assert.equal(process.argv.length, 3, 'Pass the existing offline SDK consumer directory');
const root = resolve(import.meta.dirname, '..'), consumer = resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(receipt.status, 'pass'); const sdk = installedSdk(consumer, receipt.manifest.path);
assert.equal(sdk.manifestSha256, receipt.manifest.sha256, 'Consumer manifest fingerprint differs');
assert.ok(!sdk.directory.startsWith(root + '/'));
const work = mkdtempSync(join(sdk.directory, 'ir-emitter-connector-'));
const sources = ['packages/hub-server/src/nec32-ir-emitter-gateway.ts', 'packages/hub-server/src/nec32-ir-emitter-gateway.test.ts',
  'examples/ir-emitter/software-emitter.mjs', 'examples/ir-emitter/consumer.mjs', 'tools/qa-ir-emitter.mjs',
  'tools/qa-installed-ir-emitter.mjs'];
const sourceBytes = Object.fromEntries(sources.map(path => [path, readFileSync(join(root, path))]));
const sourceSha256 = Object.fromEntries(sources.map(path => [path, createHash('sha256').update(sourceBytes[path]).digest('hex')]));
const copiedSourceSha256 = Object.fromEntries(sources.map((path, index) => { const copied = join(work, `source-${index}.bin`);
  writeFileSync(copied, sourceBytes[path]); return [path, fileHash(copied)]; }));
assert.deepEqual(copiedSourceSha256, sourceSha256);
const compiled = ts.transpileModule(sourceBytes[sources[0]].toString('utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
writeFileSync(join(work, 'nec32-ir-emitter-gateway.mjs'), compiled.outputText);
const caller = sourceBytes['examples/ir-emitter/consumer.mjs'].toString('utf8');
const importSource = "'../../packages/hub-server/src/nec32-ir-emitter-gateway.ts'";
assert.equal(caller.split(importSource).length, 2);
writeFileSync(join(work, 'consumer.mjs'), caller.replace(importSource, "'./nec32-ir-emitter-gateway.mjs'"));
writeFileSync(join(work, 'software-emitter.mjs'), sourceBytes['examples/ir-emitter/software-emitter.mjs']);
writeFileSync(join(work, 'source-nec32-ir-emitter-gateway.test.ts'), sourceBytes['packages/hub-server/src/nec32-ir-emitter-gateway.test.ts']);
writeFileSync(join(work, 'source-qa-ir-emitter.mjs'), sourceBytes['tools/qa-ir-emitter.mjs']);
writeFileSync(join(work, 'resolve.mjs'), "export const entry = import.meta.resolve('@101/connect'); export * from '@101/connect';\n");
const installed = await import(pathToFileURL(join(work, 'resolve.mjs')));
assert.ok(installed.entry.startsWith(pathToFileURL(join(sdk.directory, 'node_modules/@101/connect') + '/').href));
assert.equal(typeof installed.createDeviceRuntime, 'function');
const { runIrEmitterConsumer } = await import(pathToFileURL(join(work, 'consumer.mjs')));
const result = await runIrEmitterConsumer(); assert.equal(result.status, 'pass');
const finalReceipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(finalReceipt.manifest.path, receipt.manifest.path, 'SDK manifest path changed during caller execution');
assert.equal(finalReceipt.manifest.sha256, receipt.manifest.sha256, 'SDK receipt fingerprint changed during caller execution');
const finalSdk = installedSdk(consumer, finalReceipt.manifest.path);
assert.equal(finalSdk.directory, sdk.directory, 'Installed SDK directory changed during caller execution');
assert.equal(finalSdk.manifestSha256, sdk.manifestSha256, 'Installed SDK manifest changed during caller execution');
assert.equal(finalSdk.manifestSha256, finalReceipt.manifest.sha256, 'Final installed SDK manifest fingerprint differs');
for (const [path, hash] of Object.entries(sourceSha256)) assert.equal(fileHash(join(root, path)), hash);
const proof = { schemaVersion: 1, status: 'pass', sdkManifest: receipt.manifest, sdkManifestSha256: sdk.manifestSha256,
  finalSdkManifestSha256: finalSdk.manifestSha256, sourceSha256, copiedSourceSha256, installedPublicEntry: installed.entry,
  compiledProviderSha256: fileHash(join(work, 'nec32-ir-emitter-gateway.mjs')),
  result, scope: 'Actual separate child software NEC32 caller using the verified installed public SDK and separately compiled gateway. Provider completion only; no physical carrier, appliance acknowledgement, observed appliance state, GPIO, remote service or firmware claim.' };
writeFileSync(join(work, 'receipt.json'), `${JSON.stringify(proof, null, 2)}\n`);
console.log(JSON.stringify({ status: 'pass', receipt: join(work, 'receipt.json'), result }));
