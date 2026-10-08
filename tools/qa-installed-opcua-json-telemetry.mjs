import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import ts from 'typescript';
import { installedSdk, fileHash } from './build-pointer-bindings.mjs';
import { opcUaQaSourceFingerprints } from './qa-opcua-json-telemetry.mjs';

// Integration owner runs this against an existing offline consumer; no install.
assert.equal(process.argv.length, 3, 'Pass the existing offline SDK consumer directory');
const root = resolve(import.meta.dirname, '..'), consumer = realpathSync(process.argv[2]);
assert.ok(!consumer.startsWith(root + sep));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptPath = join(consumer, 'receipt.json'), dependencyReceiptPath = join(consumer, 'selected-node-connectors/receipt.json');
const receiptBytes = readFileSync(receiptPath), dependencyReceiptBytes = readFileSync(dependencyReceiptPath);
const receipt = JSON.parse(receiptBytes.toString('utf8')), providers = JSON.parse(dependencyReceiptBytes.toString('utf8'));
assert.equal(receipt.status, 'pass'); assert.equal(providers.status, 'pass');
const sdk = installedSdk(consumer, receipt.manifest.path);
assert.equal(sdk.manifestSha256, receipt.manifest.sha256);
const resolver = createRequire(join(consumer, 'package.json'));
assert.equal(JSON.parse(readFileSync(resolver.resolve('mqtt/package.json'), 'utf8')).version, '5.16.0');
function ordinary(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    assert.ok(entry.isFile() || entry.isDirectory(), 'installed dependency must contain ordinary files');
    const path = join(directory, entry.name);
    return entry.isDirectory() ? ordinary(path) : [path];
  });
}
const fingerprints = paths => Object.fromEntries([...new Set(paths)].sort().map(path => [path, fileHash(path)]));
function installedDependencies(selected) {
  const paths = [], directories = new Set();
  for (const dependency of selected.dependencies) {
    const directory = join(consumer, 'node_modules', dependency.path);
    assert.equal(realpathSync(directory), directory);
    assert.equal(fileHash(join(directory, 'package.json')), dependency.packageSha256);
    directories.add(directory); paths.push(...ordinary(directory));
  }
  // Resolve the actual installed MQTT graph through ordinary Node package ancestors.
  // Every executed package must belong to the independently recorded selected graph.
  const visited = new Set();
  function dependencies(directory) {
    if (visited.has(directory)) return; visited.add(directory);
    assert.ok(directories.has(directory), `unrecorded executed dependency ${directory}`);
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      let at = directory;
      for (;;) {
        const candidate = join(at, 'node_modules', dependency, 'package.json');
        let found = false;
        try { found = statSync(candidate).isFile(); } catch { /* Search normal package ancestors. */ }
        if (found) { dependencies(dirname(realpathSync(candidate))); break; }
        const parent = dirname(at); assert.notEqual(parent, at, `installed dependency missing ${dependency}`); at = parent;
      }
    }
  }
  dependencies(dirname(realpathSync(resolver.resolve('mqtt/package.json'))));
  return fingerprints(paths);
}
const sdkFiles = () => fingerprints(sdk.manifest.packages.flatMap(record => ordinary(join(consumer, 'node_modules', record.name))));
function sourceClosure() {
  const hashes = opcUaQaSourceFingerprints();
  hashes[join(root, 'tools/build-pointer-bindings.mjs')] = fileHash(join(root, 'tools/build-pointer-bindings.mjs'));
  const compilerDirectory = dirname(realpathSync(createRequire(import.meta.url).resolve('typescript/package.json')));
  return { ...hashes, ...fingerprints(ordinary(compilerDirectory)), [realpathSync(process.execPath)]: fileHash(realpathSync(process.execPath)) };
}
const dependencyBefore = installedDependencies(providers), sdkBefore = sdkFiles(), sourceBefore = sourceClosure();
const sources = ['packages/hub-server/src/opcua-json-telemetry.ts', 'packages/hub-server/src/opcua-json-telemetry.test.ts',
  'examples/opcua-json-telemetry/producer.mjs', 'examples/opcua-json-telemetry/consumer.mjs',
  'tools/qa-opcua-json-telemetry.mjs', 'tools/qa-installed-opcua-json-telemetry.mjs'];
const sourceBytes = Object.fromEntries(sources.map(path => [path, readFileSync(join(root, path))]));
const sourceSha256 = Object.fromEntries(sources.map(path => [path, digest(sourceBytes[path])]));
for (const path of sources) assert.equal(sourceSha256[path], sourceBefore[join(root, path)]);
const work = mkdtempSync(join(consumer, 'opcua-json-telemetry-'));
const copiedSourcePaths = Object.fromEntries(sources.map((path, index) => {
  const copy = join(work, `source-${index}.bin`); writeFileSync(copy, sourceBytes[path]); return [path, copy];
}));
const compiled = ts.transpileModule(sourceBytes[sources[0]].toString('utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const providerPath = join(work, 'opcua-json-telemetry.mjs'), callerPath = join(work, 'consumer.mjs'), producerPath = join(work, 'producer.mjs');
writeFileSync(providerPath, compiled.outputText);
const caller = sourceBytes['examples/opcua-json-telemetry/consumer.mjs'].toString('utf8'), old = "'../../packages/hub-server/src/opcua-json-telemetry.ts'";
assert.equal(caller.split(old).length, 2); writeFileSync(callerPath, caller.replace(old, "'./opcua-json-telemetry.mjs'"));
writeFileSync(producerPath, sourceBytes['examples/opcua-json-telemetry/producer.mjs']);
assert.ok(!readFileSync(callerPath, 'utf8').includes('../../packages/'));
const resolverPath = join(work, 'resolve.mjs'), runnerPath = join(work, 'run.mjs');
writeFileSync(resolverPath, "export const entry=import.meta.resolve('@101/connect');export * from '@101/connect';\n");
// The runner exits naturally: execFile resolves after child close, including stdio,
// native producer/broker exits, socket closes and any owned helper timers.
writeFileSync(runnerPath, `import { startOwnedMqttBroker } from ${JSON.stringify(pathToFileURL(join(root, 'tools/qa-mqtt-connector.mjs')).href)};
import { runOpcUaJsonTelemetryConsumer } from './consumer.mjs';
import { entry } from './resolve.mjs';
let broker,result,closing,terminated=false;
const closeBroker=()=>closing??=(broker?broker.close():Promise.resolve());
const terminate=()=>{terminated=true;if(broker)void closeBroker().catch(()=>{});};
process.once('SIGTERM',terminate);
try { broker=await startOwnedMqttBroker();if(terminated)throw new Error('owned runner interrupted');result=await runOpcUaJsonTelemetryConsumer(broker.endpoint); }
finally { await closeBroker();process.off('SIGTERM',terminate); }
console.log(JSON.stringify({publicEntry:entry,broker:{version:broker.version,ownedPid:broker.pid,settled:true},result}));
`);
const artifactPaths = { ...copiedSourcePaths, providerPath, callerPath, producerPath, resolverPath, runnerPath };
const artifactSha256 = Object.fromEntries(Object.entries(artifactPaths).map(([name,path]) => [name,fileHash(path)]));
for (const path of sources) assert.equal(artifactSha256[path], sourceSha256[path]);
const { stdout } = await promisify(execFile)(process.execPath, [...process.execArgv, runnerPath], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
const execution = JSON.parse(stdout.trim()); assert.equal(execution.result.status, 'pass');
const publicResolution = fileURLToPath(execution.publicEntry);
assert.ok(publicResolution.startsWith(join(consumer, 'node_modules/@101/connect') + sep));
const finalArtifactSha256 = Object.fromEntries(Object.entries(artifactPaths).map(([name,path]) => [name,fileHash(path)]));
assert.deepEqual(finalArtifactSha256, artifactSha256, 'copied source/provider/caller/producer/helper artifacts changed');
const finalReceiptBytes = readFileSync(receiptPath), finalDependencyReceiptBytes = readFileSync(dependencyReceiptPath);
assert.equal(digest(finalReceiptBytes), digest(receiptBytes), 'SDK receipt bytes changed');
assert.equal(digest(finalDependencyReceiptBytes), digest(dependencyReceiptBytes), 'selected dependency receipt bytes changed');
const finalReceipt = JSON.parse(finalReceiptBytes.toString('utf8')), finalProviders = JSON.parse(finalDependencyReceiptBytes.toString('utf8'));
assert.equal(finalReceipt.status, 'pass'); assert.equal(finalProviders.status, 'pass');
assert.deepEqual(finalReceipt.manifest, receipt.manifest);
const finalSdk = installedSdk(consumer, finalReceipt.manifest.path);
assert.equal(finalSdk.directory, sdk.directory); assert.equal(finalSdk.manifestSha256, sdk.manifestSha256);
assert.equal(finalSdk.manifestSha256, finalReceipt.manifest.sha256);
assert.deepEqual(sdkFiles(), sdkBefore, 'installed SDK closure changed');
assert.deepEqual(installedDependencies(finalProviders), dependencyBefore, 'installed dependency closure changed');
assert.deepEqual(sourceClosure(), sourceBefore, 'executed source/helper/compiler/runtime dependency closure changed');
const proof = { schemaVersion: 1, status: 'pass', sdkManifest: receipt.manifest, finalSdkManifestSha256: finalSdk.manifestSha256,
  receiptSha256: { sdk: digest(receiptBytes), dependencies: digest(dependencyReceiptBytes) }, sourceSha256, sourceClosureSha256: sourceBefore,
  installedSdkSha256: sdkBefore, installedDependencySha256: dependencyBefore, artifactPaths, artifactSha256, finalArtifactSha256,
  publicResolution, runner: { naturallyExited: true, childSocketsTimersSettled: true }, ...execution,
  scope: 'Verified installed public SDK caller with separately compiled selected gateway; no released gateway SDK export, physical publisher, secure remote broker, CAN/CANopen or certification proof.' };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify({ status: 'pass', receipt: join(work, 'receipt.json'), result: execution.result }));
