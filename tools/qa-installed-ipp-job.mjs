import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { fileHash, installedSdk } from './build-pointer-bindings.mjs';

assert.equal(process.argv.length, 3, 'Pass the existing offline SDK consumer directory');
const root = resolve(import.meta.dirname, '..'), consumer = resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(receipt.status, 'pass');
const sdk = installedSdk(consumer, receipt.manifest.path);
assert.equal(sdk.manifestSha256, receipt.manifest.sha256, 'Consumer manifest fingerprint differs');
assert.ok(!sdk.directory.startsWith(root + '/'));
const work = mkdtempSync(join(sdk.directory, 'ipp-job-connector-'));
const sources = ['packages/hub-server/src/ipp-job-gateway.ts', 'examples/ipp-job/consumer.mjs',
  'examples/ipp-job/software-printer.mjs', 'tools/qa-installed-ipp-job.mjs'];
const sourceSha256 = Object.fromEntries(sources.map(path => [path, fileHash(join(root, path))]));
const compiled = ts.transpileModule(readFileSync(join(root, sources[0]), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
writeFileSync(join(work, 'ipp-job-gateway.mjs'), compiled.outputText);
const caller = readFileSync(join(root, sources[1]), 'utf8');
const importSource = "'../../packages/hub-server/src/ipp-job-gateway.ts'";
assert.equal(caller.split(importSource).length, 2);
writeFileSync(join(work, 'consumer.mjs'), caller.replace(importSource, "'./ipp-job-gateway.mjs'"));
writeFileSync(join(work, 'software-printer.mjs'), readFileSync(join(root, sources[2])));
writeFileSync(join(work, 'resolve.mjs'), "export const entry = import.meta.resolve('@101/connect'); export * from '@101/connect';\n");
const installed = await import(pathToFileURL(join(work, 'resolve.mjs')));
assert.ok(installed.entry.startsWith(pathToFileURL(join(sdk.directory, 'node_modules/@101/connect') + '/').href));
assert.equal(typeof installed.createDeviceRuntime, 'function');
const { runIppJobConsumer } = await import(pathToFileURL(join(work, 'consumer.mjs')));
const result = await runIppJobConsumer(); assert.equal(result.status, 'pass');
for (const [path, hash] of Object.entries(sourceSha256)) assert.equal(fileHash(join(root, path)), hash);
const proof = { schemaVersion: 1, status: 'pass', sdkManifest: receipt.manifest,
  sdkManifestSha256: sdk.manifestSha256, sourceSha256, installedPublicEntry: installed.entry,
  compiledProviderSha256: fileHash(join(work, 'ipp-job-gateway.mjs')), result,
  scope: 'Actual separate child loopback IPP caller using the verified installed public SDK and separately compiled gateway. Job acknowledgement and observed software server state only; no physical printer, remote authentication, durable reconciliation or output claim.' };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt: join(work, 'receipt.json'), result }));
