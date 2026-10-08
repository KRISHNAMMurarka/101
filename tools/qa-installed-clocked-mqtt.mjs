import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const consumer = realpathSync(process.argv[2]);
assert.ok(!consumer.startsWith(root + sep));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const installed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(installed.status, 'pass');
assert.equal(hash(readFileSync(installed.manifest.path)), installed.manifest.sha256);
const manifest = JSON.parse(readFileSync(installed.manifest.path, 'utf8'));
assert.equal(manifest.packages.length, 7);
for (const item of manifest.packages) for (const file of item.files)
  assert.equal(hash(readFileSync(join(consumer, 'node_modules', item.name, file.path))), file.sha256);
const providers = JSON.parse(readFileSync(join(consumer, 'selected-node-connectors/receipt.json'), 'utf8'));
assert.equal(providers.status, 'pass');
for (const dependency of providers.dependencies) {
  const metadata = readFileSync(join(consumer, 'node_modules', dependency.path, 'package.json'));
  assert.equal(hash(metadata), dependency.packageSha256);
}
assert.equal(JSON.parse(readFileSync(join(consumer, 'node_modules/mqtt/package.json'), 'utf8')).version, '5.16.0');

const work = join(consumer, 'clocked-node-connector'); mkdirSync(work, { recursive: true });
const sourceSha256 = {};
function source(path) {
  const bytes = readFileSync(join(root, path)); sourceSha256[path] = hash(bytes); return bytes.toString('utf8');
}
function copy(path, name, rewrite = value => value) { writeFileSync(join(work, name), rewrite(source(path))); }
for (const name of ['mqtt-clock', 'mqtt-clocked-connector']) {
  const compiled = ts.transpileModule(source(`packages/hub-server/src/${name}.ts`), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  writeFileSync(join(work, `${name}.mjs`), compiled.outputText.replace("'./mqtt-clock.ts'", "'./mqtt-clock.mjs'"));
}
for (const name of ['producer', 'decoder', 'profile', 'caller']) copy(`examples/mqtt-connector/${name}.mjs`, `${name}.mjs`, value => value
  .replace("from '@101/hub-server'", "from '../selected-node-connectors/mqtt-connector.mjs'")
  .replace("'../../packages/hub-server/src/mqtt-connector.ts'", "'../selected-node-connectors/mqtt-connector.mjs'"));
for (const name of ['remote-clock-producer', 'remote-clock-caller']) copy(`examples/mqtt-connector/${name}.mjs`, `${name}.mjs`, value => value
  .replaceAll("'../../packages/hub-server/src/mqtt-clock.ts'", "'./mqtt-clock.mjs'")
  .replaceAll("'../../packages/hub-server/src/mqtt-clocked-connector.ts'", "'./mqtt-clocked-connector.mjs'"));
copy('tools/qa-mqtt-connector.mjs', 'qa-mqtt-connector.mjs', value => value.replace("'../examples/mqtt-connector/caller.mjs'", "'./caller.mjs'"));
copy('tools/qa-mqtt-clocked-connector.mjs', 'qa-mqtt-clocked-connector.mjs', value => value
  .replaceAll("'../examples/mqtt-connector/remote-clock-caller.mjs'", "'./remote-clock-caller.mjs'")
  .replaceAll("'../examples/mqtt-connector/remote-clock-producer.mjs'", "'./remote-clock-producer.mjs'"));
const { runClockedMqttConnectorQa } = await import(pathToFileURL(join(work, 'qa-mqtt-clocked-connector.mjs')).href);
const proof = await runClockedMqttConnectorQa();
const result = { schemaVersion: 1, status: 'pass', sdkManifest: installed.manifest, sdkSourceTree: manifest.source.tree,
  qaTool: { path: import.meta.filename, sha256: hash(readFileSync(import.meta.filename)) }, sourceSha256, proof,
  scope: 'Seven verified installed public SDK packages, separately compiled reviewed Node provider, copied local MQTT dependency closure, actual owned loopback broker and separate producer process. No packed hub-server, remote TLS/ACL or physical-device claim.' };
const receipt = join(work, 'receipt.json'); writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt, proof }));
