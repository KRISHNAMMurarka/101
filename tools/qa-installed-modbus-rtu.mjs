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
const work = mkdtempSync(join(sdk.directory, 'modbus-rtu-connector-'));
const sources = ['packages/hub-server/src/modbus-rtu.ts', 'examples/modbus-rtu/consumer.mjs',
  'examples/modbus-rtu/producer.mjs', 'tools/qa-installed-modbus-rtu.mjs'];
const sourceSha256 = Object.fromEntries(sources.map(path => [path, fileHash(join(root, path))]));
const compiled = ts.transpileModule(readFileSync(join(root, sources[0]), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
writeFileSync(join(work, 'modbus-rtu.mjs'), compiled.outputText);
const caller = readFileSync(join(root, sources[1]), 'utf8');
const importSource = "'../../packages/hub-server/src/modbus-rtu.ts'";
assert.equal(caller.split(importSource).length, 2);
writeFileSync(join(work, 'consumer.mjs'), caller.replace(importSource, "'./modbus-rtu.mjs'"));
writeFileSync(join(work, 'producer.mjs'), readFileSync(join(root, sources[2])));
const { runModbusRtuConsumer } = await import(pathToFileURL(join(work, 'consumer.mjs')));
const result = await runModbusRtuConsumer(); assert.equal(result.status, 'pass');
for (const [path, hash] of Object.entries(sourceSha256)) assert.equal(fileHash(join(root, path)), hash);
const proof = { schemaVersion: 1, status: 'pass', sdkManifest: receipt.manifest,
  sdkManifestSha256: sdk.manifestSha256, sourceSha256,
  compiledProviderSha256: fileHash(join(work, 'modbus-rtu.mjs')), result,
  scope: 'Actual separate child byte-stream caller using the verified installed public SDK and separately compiled RTU provider. Software pipe receipt only; no physical serial timing, port enrollment or target effect claim.' };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt: join(work, 'receipt.json'), result }));
