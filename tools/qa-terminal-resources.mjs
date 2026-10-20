import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { arch, platform, release } from 'node:os';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'];
const owned = ['examples/terminal-resources/disposable-host.mjs', 'examples/terminal-resources/ssh-connector.mjs', 'examples/terminal-resources/consumer.mjs',
  'packages/device-runtime/src/terminal-resources.test.ts', 'tools/qa-terminal-resources.mjs'];
assert.ok(process.argv.length === 6 && process.argv[2] === '--sdk-root' && process.argv[4] === '--candidate-tree',
  'Use --sdk-root <owned installed consumer> --candidate-tree <immutable caller tree>');
const callerTree = process.argv[5]; assert.match(callerTree, /^[0-9a-f]{40}$/);
const consumer = realpathSync(resolve(process.argv[3])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
const fingerprints = Object.fromEntries(owned.map(path => [path, hash(readFileSync(join(root, path)))]));
function immutable(tree, path) { return execFileSync('git', ['cat-file', 'blob', tree + ':' + path], { cwd: root, timeout: 5000, maxBuffer: 1048576 }); }
for (const path of owned) assert.equal(hash(immutable(callerTree, path)), fingerprints[path], 'Caller immutable source mismatch: ' + path);
const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(packed.status, 'pass');
const packedTree = packed.source.tree; assert.match(packedTree, /^[0-9a-f]{40}$/);
const manifestBytes = readFileSync(packed.manifest.path); assert.equal(hash(manifestBytes), packed.manifest.sha256);
const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, packedTree); assert.deepEqual(manifest.source.sha256, packed.source.sha256);
const dependencySource = manifest.source.sha256; assert.ok(Object.keys(dependencySource).length >= 100 && Object.keys(dependencySource).length <= 512);
for (const [path, digest] of Object.entries(dependencySource)) {
  assert.match(path, /^[A-Za-z0-9_./-]+$/); assert.ok(resolve(root, path).startsWith(root + sep)); assert.match(digest, /^[0-9a-f]{64}$/);
  for (const tree of new Set([packedTree, callerTree])) assert.equal(hash(immutable(tree, path)), digest, 'Original packed dependency changed: ' + path);
  assert.equal(hash(readFileSync(join(root, path))), digest, 'Current dependency differs from original installed SDK: ' + path);
}
const moduleRoot = join(consumer, 'node_modules'); assert.equal(realpathSync(moduleRoot), moduleRoot); assert.equal(lstatSync(moduleRoot).isSymbolicLink(), false);
assert.deepEqual(readdirSync(join(moduleRoot, '@101')).sort(), names.slice().sort());
assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => '@101/' + name).sort());
function inventory(prefix) {
  const found = [];
  function visit(directory, depth) {
    assert.ok(depth <= 8); assert.equal(realpathSync(directory), directory);
    const entries = readdirSync(directory); assert.ok(entries.length <= 1024);
    for (const name of entries) {
      const path = join(directory, name), stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
      assert.equal(realpathSync(path), path);
      if (stat.isDirectory()) visit(path, depth + 1);
      else { assert.ok(stat.isFile()); found.push(relative(prefix, path)); assert.ok(found.length <= 1024); }
    }
  }
  visit(prefix, 0); return found.sort();
}
const installed = {};
for (const item of manifest.packages) {
  assert.ok(item.files.length >= 1 && item.files.length <= 1024);
  const prefix = join(moduleRoot, item.name); assert.equal(realpathSync(prefix), prefix);
  assert.deepEqual(inventory(prefix), item.files.map(file => file.path).sort(), 'Exact installed package inventory differs: ' + item.name);
  for (const file of item.files) {
    const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep)); assert.equal(realpathSync(path), path);
    const stat = lstatSync(path); assert.ok(stat.isFile()); const bytes = readFileSync(path);
    assert.equal(hash(bytes), file.sha256, 'Installed SDK bytes differ: ' + item.name + '/' + file.path);
    installed[item.name + '/' + file.path] = file.sha256;
  }
}
const caller = mkdtempSync(join(consumer, 'terminal-resources-caller-'));
for (const name of ['disposable-host.mjs', 'ssh-connector.mjs', 'consumer.mjs']) {
  copyFileSync(join(root, 'examples/terminal-resources', name), join(caller, name));
  assert.equal(hash(readFileSync(join(caller, name))), fingerprints['examples/terminal-resources/' + name]);
}
writeFileSync(join(caller, 'public-resolution.mjs'), `import * as sdk from '@101/connect';
import * as runtime from '@101/device-runtime';import * as model from '@101/device-model';
if(sdk.createDeviceRuntime!==runtime.createDeviceRuntime||sdk.parseDeviceDescriptor!==model.parseDeviceDescriptor)throw Error('Public facade identity');
for(const name of ${JSON.stringify(names)})console.log(JSON.stringify({name,url:import.meta.resolve('@101/'+name)}));\n`);
const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
function run(name) {
  const result = spawnSync(process.execPath, ['--no-experimental-strip-types', join(caller, name)], { cwd: consumer, env: environment,
    encoding: 'utf8', timeout: 12000, maxBuffer: 131072 });
  assert.equal(result.status, 0, 'Actual native SSH public caller failed: ' + (result.error?.code ?? result.stderr.slice(0, 2000)));
  assert.equal(result.stderr, ''); return result.stdout;
}
const resolutions = run('public-resolution.mjs').trim().split('\n').map(value => JSON.parse(value));
for (const item of resolutions) assert.equal(item.url, pathToFileURL(join(moduleRoot, '@101', item.name, 'dist/index.js')).href);
const proof = JSON.parse(run('consumer.mjs')); assert.equal(proof.result, 'pass'); assert.equal(proof.kind, 'actual-native-openssh-public-runtime');
assert.equal(proof.receipts.length, 2); assert.equal(proof.cleanup.length, 2); assert.equal(proof.checks.length, 15);
assert.ok(proof.cleanup.every(value => value.removedOwnedRoot && value.nativePending === 0 && !value.timerArmed));
for (const entry of proof.receipts) { assert.equal(entry.connectorStatus.rawPending, 0); assert.equal(entry.connectorStatus.retainedResults, 0);
  assert.equal(entry.connectorStatus.issued, entry.connectorStatus.settled); assert.equal(entry.connectorStatus.timerArmed, false); }
for (const path of owned) assert.equal(hash(readFileSync(join(root, path))), fingerprints[path], 'Caller source changed during proof: ' + path);
const operationProof = proof.allowedOperations;
assert.equal(operationProof.result, 'pass'); assert.equal(operationProof.profile, 'loopback-openssh-fixture-summary/1');
assert.equal(operationProof.kind, 'actual-native-openssh-public-runtime');
assert.equal(operationProof.receipts.length, 2); assert.equal(operationProof.cleanup.length, 2); assert.equal(operationProof.checks.length, 17);
assert.ok(operationProof.cleanup.every(value => value.removedOwnedRoot && value.nativePending === 0 && !value.timerArmed));
assert.notEqual(operationProof.receipts[0].hostIdentity.hostFingerprint, operationProof.receipts[1].hostIdentity.hostFingerprint);
for (const entry of operationProof.receipts) {
  assert.equal(entry.operation, 'fixture-summary'); assert.equal(entry.result.profile, operationProof.profile);
  assert.equal(entry.result.sha256, entry.fixtureDocumentSha256); assert.equal(entry.result.lines, 2);
  assert.equal(entry.connectorStatus.rawPending, 0); assert.equal(entry.connectorStatus.retainedResults, 0);
  assert.equal(entry.connectorStatus.issued, 2); assert.equal(entry.connectorStatus.issued, entry.connectorStatus.settled);
  assert.equal(entry.connectorStatus.timerArmed, false);
  assert.ok(entry.connectorStatus.audit.every(row => row.operation === 'fixture-summary' && row.profile === operationProof.profile));
  assert.ok(entry.connectorStatus.audit.some(row => row.issued && ['cancelled', 'revoked'].includes(row.outcome)));
}
const receipt = { schemaVersion: 1, result: 'pass', profile: 'loopback-openssh-metadata/1', allowedOperationProfile: 'loopback-openssh-fixture-summary/1', createdAt: new Date().toISOString(),
  mode: 'unchanged-installed-immutable-public-sdk-with-separate-new-native-caller', packedTree, callerTree,
  immutableManifest: packed.manifest, dependencySourceSha256: dependencySource, installedSha256: installed, sourceSha256: fingerprints,
  consumer, caller, publicEsmResolutions: resolutions, environment: { node: process.version, platform: platform(), arch: arch(), kernel: release() }, proof,
  scope: 'New owned non-root loopback OpenSSH hosts for unchanged metadata and one declared fixed document-summary job, with explicit pinned native host/client identity. Summary proof cancels an issued job, joins native close, reconnects with fresh identity/approvals and validates bounded operation-specific audit. Exact actual public runtime invoke and subscribe->write result grants, with separate current operation/result owner consent before one validated result is published. No remote host, interactive shell, PTY/forwarding/agent, existing keys/config/account changes, OS sandbox, issued-operation undo or physical support qualification.' };
const receiptPath = join(caller, 'receipt.json'); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ receiptPath, ...receipt }));
