import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const consumer = realpathSync(process.argv[2]);
const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(receipt.status, 'pass');
assert.ok(!consumer.startsWith(root + sep));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(receipt.manifest.path, 'utf8'));
assert.equal(hash(readFileSync(receipt.manifest.path)), receipt.manifest.sha256);
for (const item of manifest.packages) for (const file of item.files)
  assert.equal(hash(readFileSync(join(consumer, 'node_modules', item.name, file.path))), file.sha256);

// Copy the exact already installed MQTT dependency graph, including licenses.
// No registry access, workspace alias or install script supplies a dependency.
const dependencies = new Map();
function addDependency(name, parent) {
  const resolver = createRequire(join(parent, 'package.json'));
  let selected;
  try { selected = resolver.resolve(name + '/package.json'); }
  catch { let directory = dirname(resolver.resolve(name));
    while (true) {
      const candidate = join(directory, 'package.json');
      if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === name) { selected = candidate; break; }
      const parentDirectory = dirname(directory); assert.notEqual(parentDirectory, directory);
      directory = parentDirectory;
    }
  }
  const directory = realpathSync(dirname(selected));
  const position = relative(join(root, 'node_modules'), directory);
  assert.ok(position && position !== '..' && !position.startsWith('..' + sep) && !isAbsolute(position));
  if (dependencies.has(directory)) return;
  const metadata = JSON.parse(readFileSync(selected, 'utf8'));
  assert.equal(metadata.name, name);
  dependencies.set(directory, { path: position, name, version: metadata.version, packageSha256: hash(readFileSync(selected)) });
  cpSync(directory, join(consumer, 'node_modules', position), { recursive: true, dereference: true });
  for (const dependency of Object.keys(metadata.dependencies ?? {})) addDependency(dependency, directory);
}
addDependency('mqtt', root);
assert.equal([...dependencies.values()].find(item => item.name === 'mqtt').version, '5.16.0');

const work = join(consumer, 'selected-node-connectors'); mkdirSync(work, { recursive: true });
const sourceSha256 = {};
function source(path) { const bytes = readFileSync(join(root, path)); sourceSha256[path] = hash(bytes); return bytes.toString('utf8'); }
function copy(path, name, rewrite = value => value) { writeFileSync(join(work, name), rewrite(source(path))); }
for (const connector of ['modbus-register', 'mqtt-connector']) {
  const path = `packages/hub-server/src/${connector}.ts`;
  const compiled = ts.transpileModule(source(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  writeFileSync(join(work, `${connector}.mjs`), compiled.outputText);
}
copy('examples/modbus-register/consumer.mjs', 'modbus-caller.mjs', value => value.replace("from '@101/hub-server'", "from './modbus-register.mjs'"));
for (const name of ['producer', 'decoder', 'profile']) copy(`examples/mqtt-connector/${name}.mjs`, `${name}.mjs`);
copy('examples/mqtt-connector/caller.mjs', 'caller.mjs', value => value
  .replace("from '@101/hub-server'", "from './mqtt-connector.mjs'")
  .replace("'../../packages/hub-server/src/mqtt-connector.ts'", "'./mqtt-connector.mjs'"));
copy('tools/qa-mqtt-connector.mjs', 'mqtt-qa.mjs', value => value.replace("'../examples/mqtt-connector/caller.mjs'", "'./caller.mjs'"));
const { runModbusRegisterConsumer } = await import(pathToFileURL(join(work, 'modbus-caller.mjs')).href);
const { runMqttConnectorQa } = await import(pathToFileURL(join(work, 'mqtt-qa.mjs')).href);
const modbus = await runModbusRegisterConsumer();
const mqtt = await runMqttConnectorQa();
const result = { schemaVersion: 1, status: 'pass', kind: 'installed-public-SDK-and-explicit-compiled-Node-providers',
  sdkManifest: receipt.manifest, sdkSourceTree: manifest.source.tree, sourceSha256,
  qaTool: { path: import.meta.filename, sha256: hash(readFileSync(import.meta.filename)) },
  dependencies: [...dependencies.values()], modbus, mqtt,
  scope: 'Verified installed seven-package SDK; separately compiled selected Node providers, exact copied local MQTT dependencies and actual owned loopback servers. No packed hub-server, physical device or remote clock/TLS qualification claim.' };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt: join(work, 'receipt.json'), modbus, mqtt }));
