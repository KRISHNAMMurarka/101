import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// This is an actual private-filesystem/owned Node producer proof, not browser,
// IndexedDB, external-recipient recall, physical sensor or general B05 evidence.
assert.equal(process.version, 'v24.14.0');
const root = realpathSync(resolve(import.meta.dirname, '..')), args = process.argv.slice(2);
const source = args.length === 1 && args[0] === '--source';
assert.ok(source || args.length === 4 && args[0] === '--installed', 'Use --source or --installed <manifest> <clean-consumer> <caller-tree>');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const owned = ['packages/device-runtime/src/owner-data.ts', 'packages/device-runtime/src/owner-data.test.ts',
  'examples/owner-data/telemetry-owner.mjs', 'tools/qa-telemetry-owner-data.mjs'];
const adapter = 'examples/owner-data/filesystem-storage.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function bytes(path, maximum = 4 * 1024 * 1024) {
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum);
  const value = readFileSync(path); assert.ok(value.byteLength <= maximum); return value;
}
function files(directory, budget = { left: 2048 }) {
  return readdirSync(directory).sort().flatMap(name => {
    assert.ok(--budget.left >= 0); const path = join(directory, name), stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false); return stat.isDirectory() ? files(path, budget) : [path];
  });
}
function immutableBlobs(queries) {
  const keys = [...new Set(queries)]; assert.ok(keys.length > 0 && keys.length <= 1028);
  for (const key of keys) assert.match(key, /^[0-9a-f]{40}:[A-Za-z0-9_./-]+$/);
  // One bounded Git batch avoids hundreds of short child launches.
  const raw = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: keys.join('\n') + '\n', timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
  let cursor = 0; const result = new Map();
  for (const key of keys) {
    const end = raw.indexOf(10, cursor); assert.ok(end >= cursor && end - cursor <= 128);
    const header = raw.subarray(cursor, end).toString('ascii').match(/^[0-9a-f]{40} blob ([0-9]+)$/); assert.ok(header);
    const length = Number(header[1]); assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= 1048576);
    const after = end + 1 + length; assert.ok(after < raw.length); assert.equal(raw[after], 10);
    result.set(key, hash(raw.subarray(end + 1, after))); cursor = after + 1;
  }
  assert.equal(cursor, raw.length); return result;
}
const sourcePins = Object.fromEntries(owned.map(path => [path, hash(bytes(join(root, path)))])), adapterPin = hash(bytes(join(root, adapter)));
let scratch, consumer, manifestPin, dependencyPins = {}, installedPins = {}, artifactPins = {}, receipt, failure;
const liveChildren = new Set(); let actualChildrenStarted = 0, actualChildrenClosed = 0;
function child(script, argv, imports = []) {
  return new Promise((done, reject) => {
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const native = spawn(process.execPath, [...imports, script, ...argv], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    liveChildren.add(native); actualChildrenStarted++; let out = '', err = '', over = false;
    const timer = setTimeout(() => { over = true; native.kill('SIGTERM'); }, 10000);
    const take = (kind, value) => { if (kind === 'out') out += value; else err += value;
      if (Buffer.byteLength(out) + Buffer.byteLength(err) > 65536) { over = true; native.kill('SIGTERM'); } };
    native.stdout.on('data', value => take('out', value)); native.stderr.on('data', value => take('err', value));
    native.once('error', error => { clearTimeout(timer); reject(error); });
    native.once('close', (code, signal) => {
      clearTimeout(timer); liveChildren.delete(native); actualChildrenClosed++; done({ code, signal, over, out, err });
    });
  });
}
try {
  scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), '101-telemetry-owner-data-')));
  if (source) {
    let total = 0;
    for (const name of names) for (const path of files(join(root, 'packages', name, 'src'))) {
      if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        const value = bytes(path, 1048576); total += value.byteLength; dependencyPins[path.slice(root.length + 1)] = hash(value);
      }
    }
    assert.ok(Object.keys(dependencyPins).length <= 512 && total <= 32 * 1024 * 1024);
  } else {
    consumer = realpathSync(resolve(args[2])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const accepted = JSON.parse(bytes(join(consumer, 'receipt.json'))); assert.equal(accepted.status, 'pass');
    const manifestPath = realpathSync(resolve(args[1])); assert.equal(manifestPath, accepted.manifest.path);
    manifestPin = { path: manifestPath, sha256: hash(bytes(manifestPath)) }; assert.equal(manifestPin.sha256, accepted.manifest.sha256);
    const manifest = JSON.parse(bytes(manifestPath)); dependencyPins = manifest.source.sha256;
    assert.equal(accepted.source.tree, manifest.source.tree); assert.deepEqual(accepted.source.sha256, dependencyPins);
    assert.ok(Object.keys(dependencyPins).length > 0 && Object.keys(dependencyPins).length <= 512);
    assert.equal(dependencyPins[owned[0]], sourcePins[owned[0]], 'Installed SDK must contain this selected-deletion controller');
    artifactPins[manifestPath] = manifestPin.sha256;
    assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => '@101/' + name).sort());
    for (const item of manifest.packages) {
      assert.equal(hash(bytes(item.tarball, 8 * 1024 * 1024)), item.sha256); artifactPins[item.tarball] = item.sha256;
      const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix);
      assert.ok(item.files.length > 0 && item.files.length <= 1024);
      assert.deepEqual(files(prefix).map(path => path.slice(prefix.length + 1)).sort(), item.files.map(file => file.path).sort());
      for (const file of item.files) {
        const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep)); assert.equal(realpathSync(path), path);
        assert.equal(hash(bytes(path)), file.sha256); assert.equal(lstatSync(path).size, file.size); installedPins[path] = file.sha256;
      }
    }
    assert.match(args[3], /^[0-9a-f]{40}$/);
    const queries = [...owned.map(path => args[3] + ':' + path), args[3] + ':' + adapter,
      ...Object.keys(dependencyPins).flatMap(path => [args[3] + ':' + path, manifest.source.tree + ':' + path])];
    const pinned = immutableBlobs(queries);
    for (const [path, pin] of Object.entries(sourcePins)) assert.equal(pinned.get(args[3] + ':' + path), pin);
    assert.equal(pinned.get(args[3] + ':' + adapter), adapterPin);
    for (const [path, pin] of Object.entries(dependencyPins)) {
      assert.ok(resolve(root, path).startsWith(root + sep)); assert.match(pin, /^[0-9a-f]{64}$/);
      assert.equal(hash(bytes(join(root, path))), pin); assert.equal(pinned.get(args[3] + ':' + path), pin);
      assert.equal(pinned.get(manifest.source.tree + ':' + path), pin);
    }
    symlinkSync(join(consumer, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  }
  const example = join(scratch, 'telemetry-owner.mjs'), port = join(scratch, 'filesystem-storage.mjs');
  copyFileSync(join(root, owned[2]), example); copyFileSync(join(root, adapter), port);
  const hook = join(scratch, 'source-public-hook.mjs');
  if (source) writeFileSync(hook, `import {registerHooks} from 'node:module';const entries=${JSON.stringify(Object.fromEntries(names.map(name =>
    ['@101/' + name, pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href])))};registerHooks({resolve(s,c,n){return n(entries[s]??s,c)}});`);
  const runner = join(scratch, 'caller.mjs');
  writeFileSync(runner, `import assert from 'node:assert/strict';import * as sdk from '@101/connect';import * as runtime from '@101/device-runtime';
import {createOwnerDataFilesystemStorage} from './filesystem-storage.mjs';import {runTelemetryOwnerSelection} from './telemetry-owner.mjs';
assert.equal(sdk.createOwnerDataController,runtime.createOwnerDataController);assert.equal(sdk.createTelemetryHistory,runtime.createTelemetryHistory);
const [directory,phase]=process.argv.slice(2);const storage=createOwnerDataFilesystemStorage(directory);let proof;
try{proof=await runTelemetryOwnerSelection(storage,phase)}finally{storage.close()}
console.log(JSON.stringify({proof,pid:process.pid,node:process.version,publicResolution:import.meta.resolve('@101/connect'),
storage:'genuine-private-filesystem',ownedStorageClosed:true}));`);
  const imports = source ? ['--experimental-strip-types', '--import', hook] : [];
  const directory = join(scratch, 'durable'); mkdirSync(directory, { mode: 0o700 });
  const phases = [], run = async phase => {
    const result = await child(runner, [directory, phase], imports);
    assert.equal(result.code, 0, JSON.stringify({ phase, ...result })); assert.equal(result.signal, null);
    assert.equal(result.over, false); assert.equal(result.err, '');
    const value = JSON.parse(result.out); assert.equal(value.ownedStorageClosed, true);
    const expected = source ? join(root, 'packages/connect/src/index.ts') : join(consumer, 'node_modules/@101/connect/dist/index.js');
    assert.equal(value.publicResolution, pathToFileURL(expected).href); phases.push(value); return value.proof;
  };
  const seed = await run('seed'), inspect = await run('inspect'), begun = await run('begin'), stage = await run('stage');
  assert.deepEqual(inspect.originalSelected, seed.originalSelected); assert.deepEqual(inspect.originalRetained, seed.originalRetained);
  assert.equal(begun.denied, true); assert.equal(begun.oldProducerRejected, true); assert.equal(stage.deletion.state, 'pending');
  const ownerFile = join(directory, hash('telemetry-owner-example') + '.json'), stagedBytes = bytes(ownerFile), lock = ownerFile + '.lock';
  mkdirSync(lock, { mode: 0o700 }); let blocked;
  try {
    blocked = await child(runner, [directory, 'complete'], imports);
    assert.notEqual(blocked.code, 0, 'The actual unavailable owned lock must stop persistence');
    assert.equal(blocked.signal, null); assert.equal(blocked.over, false); assert.match(blocked.err, /telemetry-owner-example:unavailable/);
    assert.deepEqual(bytes(ownerFile), stagedBytes, 'Unavailable engine must retain the exact pending stage');
  } finally { rmdirSync(lock); }
  const completed = await run('complete'), after = await run('inspect-completed');
  assert.equal(completed.deletion.state, 'completed'); assert.equal(completed.proof.pendingSelector, null);
  assert.equal(after.proof.selectedPersistedRows, 0); assert.equal(after.proof.telemetryRows, 1); assert.equal(after.proof.copies, 1);
  assert.equal(completed.deletion.removed.telemetry, 1); assert.equal(completed.deletion.removed.copies, 1);
  assert.deepEqual(after.originalRetained, seed.originalRetained); assert.equal(after.restoredCaptureOrUploadAuthority, false);
  for (const phase of phases) for (const key of ['retainedProducerSha256', 'retainedCopySha256', 'settingsSha256', 'otherOwnerSha256'])
    assert.equal(phase.proof.proof[key], seed.proof[key], key + ':' + phase.proof.phase);
  const expiry = await run('expiry'), auditExpiry = await run('audit-expiry');
  assert.equal(expiry.swept.telemetryRemoved, 1); assert.equal(expiry.swept.copiesRemoved, 1); assert.equal(auditExpiry.proof.auditRows, 0);
  for (const path of files(directory)) assert.equal(bytes(path).includes(Buffer.from('selected-owner-authorizer-private-sentinel')), false);
  for (const [path, pin] of Object.entries(sourcePins)) assert.equal(hash(bytes(join(root, path))), pin);
  assert.equal(hash(bytes(join(root, adapter))), adapterPin);
  for (const [path, pin] of Object.entries(dependencyPins)) assert.equal(hash(bytes(join(root, path))), pin);
  for (const [path, pin] of Object.entries(installedPins)) assert.equal(hash(bytes(path)), pin);
  for (const [path, pin] of Object.entries(artifactPins)) assert.equal(hash(bytes(path, 8 * 1024 * 1024)), pin);
  assert.equal(liveChildren.size, 0); assert.equal(actualChildrenStarted, 9); assert.equal(actualChildrenClosed, 9);
  receipt = { schemaVersion: 1, status: 'pass', profile: 'selected-managed-telemetry/1', mode: source ? 'explicit-public-source' : 'ordinary-installed-immutable-sdk',
    sourcePins, adapterPin, dependencySourcePins: dependencyPins, installedPins, artifactPins,
    ...(manifestPin ? { manifest: manifestPin, callerTree: args[3] } : {}),
    node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
    phases, blockedStorage: { code: blocked.code, signal: blocked.signal, timedOut: blocked.over, exactStagePreserved: true },
    actualChildrenStarted, actualChildrenClosed,
    scope: 'Selected owner-local software telemetry and matching registered filesystem copies only. Eight fresh Node process phases and one genuine unavailable-lock rejection. No IndexedDB, unmanaged/remote-copy recall, forensic erase, devices/phone or whole B05 completion.' };
} catch (error) { failure = error; }
finally {
  // Issued native children are never called settled on logical cancellation.
  // Normal timeout waits for each actual close event before reaching here.
  if (liveChildren.size === 0 && scratch) rmSync(scratch, { recursive: true, force: true });
}
if (failure) {
  console.error(JSON.stringify({ status: 'fail', sourcePins, adapterPin, nativeChildrenLive: liveChildren.size,
    actualChildrenStarted, actualChildrenClosed, scratchRetained: scratch ? existsSync(scratch) : false }));
  throw failure;
}
assert.equal(liveChildren.size, 0); assert.equal(existsSync(scratch), false);
console.log(JSON.stringify({ ...receipt, cleanup: { children: 0, filesystemPorts: 0, ownedDirectories: 0, network: 0 } }, null, 2));
