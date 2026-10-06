import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright';

assert.equal(process.version, 'v24.14.0');
const root = realpathSync(resolve(import.meta.dirname, '..'));
const args = process.argv.slice(2), names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const source = args[0] === '--source' && (args.length === 1 || args.length === 2 && args[1] === '--signal-probe');
const probeOnly = source && args[1] === '--signal-probe';
assert.ok(source || args.length === 4 && args[0] === '--installed', 'Use --source or --installed <manifest> <clean-consumer> <caller-tree>');
const owned = ['packages/device-runtime/src/owner-backup.ts', 'packages/device-runtime/src/owner-backup.test.ts', 'examples/owner-backup/registered-copies.mjs', 'tools/qa-owner-backup-copies.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = (path, maximum = 4 * 1024 * 1024) => { const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum);
  const value = readFileSync(path); assert.ok(value.byteLength <= maximum); return value; };
const sourcePins = Object.fromEntries(owned.map(path => [path, hash(bytes(join(root, path)))]));
const adapter = 'examples/owner-data/filesystem-storage.mjs', adapterPin = hash(bytes(join(root, adapter)));
let consumer, manifestPin, dependencyPins = {}, installedPins = {}, artifactPins = {}, scratch, receipt;
function files(directory, left = { count: 2048 }) { return readdirSync(directory).sort().flatMap(name => {
  assert.ok(--left.count >= 0); const path = join(directory, name), stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
  return stat.isDirectory() ? files(path, left) : [path];
}); }
function immutableBlobs(queries) {
  const keys = [...new Set(queries)]; assert.ok(keys.length <= 1028);
  for (const key of keys) assert.match(key, /^[0-9a-f]{40}:[A-Za-z0-9_./-]+$/);
  const raw = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: keys.join('\n') + '\n', timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
  let cursor = 0; const output = new Map();
  for (const key of keys) { const end = raw.indexOf(10, cursor); assert.ok(end >= cursor && end - cursor <= 128);
    const header = raw.subarray(cursor, end).toString('ascii').match(/^[0-9a-f]{40} blob ([0-9]+)$/); assert.ok(header);
    const size = Number(header[1]); assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 1048576);
    const last = end + 1 + size; assert.ok(last < raw.length); assert.equal(raw[last], 10);
    output.set(key, hash(raw.subarray(end + 1, last))); cursor = last + 1;
  }
  assert.equal(cursor, raw.length); return output;
}
function child(script, argv, cwd, imports = []) {
  return new Promise((resolveChild, reject) => {
    const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
    const processChild = spawn(process.execPath, [...imports, script, ...argv], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', over = false;
    const timer = setTimeout(() => { over = true; processChild.kill('SIGTERM'); }, 10000);
    const take = (kind, value) => { if (kind === 'out') out += value; else err += value;
      if (Buffer.byteLength(out) + Buffer.byteLength(err) > 65536) { over = true; processChild.kill('SIGTERM'); } };
    processChild.stdout.on('data', value => take('out', value)); processChild.stderr.on('data', value => take('err', value));
    processChild.on('error', error => { clearTimeout(timer); reject(error); });
    processChild.on('close', (code, signal) => { clearTimeout(timer); resolveChild({ code, signal, over, out, err }); });
  });
}
async function nativeAbortProof() {
  const modules = new Map();
  for (const [path, pin] of Object.entries(source ? dependencyPins : installedPins)) {
    const match = source ? /^packages\/([^/]+)\/src\/(.+\.ts)$/.exec(path)
      : /\/node_modules\/@101\/([^/]+)\/dist\/(.+\.js)$/.exec(path);
    if (match) modules.set('/sdk/' + match[1] + '/' + match[2], { path: source ? join(root, path) : path, pin });
  }
  const imports = Object.fromEntries(names.map(name => ['@101/' + name, '/sdk/' + name + '/index.' + (source ? 'ts' : 'js')]));
  let browser, context, server;
  const errors = [], foreign = [];
  try {
    server = createServer((request, response) => {
      if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Owned abort qualification</title><script type="importmap">' +
        JSON.stringify({ imports }) + '</script><script type="module">import * as api from "@101/connect";window.abortApi=api;</script>'); return; }
      try { const entry = modules.get(request.url); assert.ok(entry); const value = bytes(entry.path, 1048576); assert.equal(hash(value), entry.pin);
        response.setHeader('Content-Type', 'text/javascript'); response.end(entry.path.endsWith('.ts') ? ts.transpileModule(value.toString('utf8'),
          { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText : value);
      } catch { response.statusCode = 404; response.end(); }
    });
    await new Promise(ready => server.listen(0, '127.0.0.1', ready)); const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true }); context = await browser.newContext(); const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(5000);
    await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { foreign.push(route.request().url()); return route.abort(); } return route.continue(); });
    await page.goto(origin); await page.waitForFunction(() => window.abortApi !== undefined);
    const proof = await page.evaluate(async () => {
      const api = window.abortApi, ownerId = 'native-copy-abort-owner', databaseName = '101-copy-abort-' + crypto.randomUUID();
      const base = api.createIndexedDbOwnerDataStorage({ databaseName }), authority = new AbortController();
      let armed = false, queued = 0, composedAborted = false, history, ports;
      const need = result => { if (!result.ok) throw Error('native-abort:' + result.reason); return result.value; };
      const storage = { transact(owner, mutation, guard) { return base.transact(owner, current => {
        const next = mutation(current);
        if (armed && next.state.archives.length > current.archives.length) {
          queueMicrotask(() => { queued++; authority.abort(); composedAborted = guard.signal.aborted; });
        }
        return next;
      }, guard); } };
      const backup = api.createOwnerBackupController({ ownerId, storage, trustedNow: () => 1000,
        authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal }) });
      const data = api.createOwnerDataController({ ownerId, storage: backup.managedStorage, trustedNow: () => 1000,
        authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
      let result, before, after;
      try {
        ports = need(await data.openStores({ retireOwned() { history?.close(); } }));
        history = api.createTelemetryHistory({ ownerId, storage: ports.telemetry, trustedNow: () => 1000,
          limits: { retentionMs: 5000 }, authorize: scope => ({ scope, expiresAt: scope.expiresAt }) });
        const capture = await history.requestCapture({ resourceId: 'owned-js:elapsed', schemaVersion: 1, fields: ['elapsedMs'], provenanceFields: [],
          destinationId: 'local-history', purpose: 'native-abort-review', expiresAt: 51000,
          schema: { type: 'record', fields: { elapsedMs: { type: 'scalar', unit: 'ms', min: 0, max: Number.MAX_SAFE_INTEGER } } } });
        if (!capture.ok) throw Error('native-abort:capture'); const stamp = performance.now();
        if (!history.enqueue(capture.handle, { sourceTime: { clockId: 'owned-browser-clock:' + crypto.randomUUID(), at: stamp }, quality: 'observed', values: { elapsedMs: stamp } }).ok ||
          !(await history.flush()).ok) throw Error('native-abort:producer');
        const upload = await history.requestUpload({ resourceId: 'owned-js:elapsed', schemaVersion: 1, fields: ['elapsedMs'], provenanceFields: [],
          destinationId: 'local-recipient', purpose: 'native-abort-copy', expiresAt: 51000 }, async batch => {
          need(await data.storeLocalTelemetryCopy(batch, { purpose: 'native-abort-copy', destinationId: 'local-recipient' }));
          return { batchId: batch.batchId, recordIds: batch.records.map(row => row.id) };
        });
        if (!upload.ok || !(await history.pumpUpload(upload.handle)).ok) throw Error('native-abort:registered-copy');
        history.close(); ports.close(); history = undefined; ports = undefined;
        before = await base.transact(ownerId, state => ({ state, result: JSON.stringify(state) }));
        Object.defineProperty(authority.signal, 'addEventListener', { value() {} }); armed = true;
        result = await backup.backup({ backupId: 'native-abort', purpose: 'native-abort-review', destinationId: 'local-recovery', registeredCopies: 'include' });
        after = await base.transact(ownerId, state => ({ state, result: JSON.stringify(state) }));
      } finally { history?.close(); ports?.close(); data.close(); await backup.close(); base.close(); }
      await new Promise((done, reject) => { const request = indexedDB.deleteDatabase(databaseName), timer = setTimeout(() => reject(Error('native-abort:cleanup-timeout')), 5000);
        request.onsuccess = () => { clearTimeout(timer); done(); }; request.onerror = request.onblocked = () => { clearTimeout(timer); reject(Error('native-abort:cleanup')); }; });
      return { result, queued, composedAborted, unchanged: before === after, persistedArchives: JSON.parse(after).archives.length,
        producer: 'actual-owned-browser-performance-sample', actualIndexedDb: true, databaseDeleted: true, ownerPortsClosed: true };
    });
    assert.deepEqual(proof.result, { ok: false, reason: 'revoked' }); assert.equal(proof.queued, 1);
    assert.equal(proof.composedAborted, true, JSON.stringify(proof)); assert.equal(proof.unchanged, true); assert.equal(proof.persistedArchives, 0);
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
    return { ...proof, engine: 'chromium', browserVersion: browser.version(), pageErrors: errors, foreignRequests: foreign,
      cleanup: { browsers: 0, contexts: 0, pages: 0, servers: 0, databases: 0 } };
  } finally { if (context) await context.close(); if (browser) await browser.close(); if (server) await new Promise(done => server.close(done)); }
}
try {
  scratch = mkdtempSync(join(realpathSync(tmpdir()), '101-owner-backup-copies-')); assert.equal(realpathSync(scratch), scratch);
  if (source) {
    let sourceBytes = 0;
    for (const name of names) for (const file of files(join(root, 'packages', name, 'src'))) {
      if (file.endsWith('.ts') && !file.endsWith('.test.ts')) { const value = bytes(file, 1048576); sourceBytes += value.byteLength;
        dependencyPins[file.slice(root.length + 1)] = hash(value); }
    }
    assert.ok(Object.keys(dependencyPins).length <= 512 && sourceBytes <= 32 * 1024 * 1024);
  } else {
    consumer = realpathSync(resolve(args[2])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const accepted = JSON.parse(bytes(join(consumer, 'receipt.json'))); assert.equal(accepted.status, 'pass');
    const manifestPath = realpathSync(resolve(args[1])); assert.equal(manifestPath, accepted.manifest.path);
    manifestPin = { path: manifestPath, sha256: hash(bytes(manifestPath)) }; assert.equal(manifestPin.sha256, accepted.manifest.sha256);
    const manifest = JSON.parse(bytes(manifestPath)); dependencyPins = manifest.source.sha256;
    assert.equal(accepted.source.tree, manifest.source.tree); assert.deepEqual(accepted.source.sha256, dependencyPins);
    artifactPins[manifestPath] = manifestPin.sha256;
    assert.equal(dependencyPins[owned[0]], sourcePins[owned[0]], 'Installed SDK must include exact repaired copy recovery');
    assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => '@101/' + name).sort());
    for (const item of manifest.packages) {
      assert.equal(hash(bytes(item.tarball, 8 * 1024 * 1024)), item.sha256); artifactPins[item.tarball] = item.sha256;
      const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix);
      assert.deepEqual(files(prefix).map(path => path.slice(prefix.length + 1)).sort(), item.files.map(file => file.path).sort());
      for (const file of item.files) { const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep));
        assert.equal(hash(bytes(path)), file.sha256); assert.equal(lstatSync(path).size, file.size); installedPins[path] = file.sha256; }
    }
    assert.match(args[3], /^[0-9a-f]{40}$/);
    const requested = [...owned.map(path => args[3] + ':' + path), args[3] + ':' + adapter,
      ...Object.keys(dependencyPins).map(path => args[3] + ':' + path)];
    const pinned = immutableBlobs(requested);
    for (const [path, pin] of Object.entries(sourcePins)) assert.equal(pinned.get(args[3] + ':' + path), pin);
    assert.equal(pinned.get(args[3] + ':' + adapter), adapterPin);
    for (const [path, pin] of Object.entries(dependencyPins)) { assert.equal(hash(bytes(join(root, path))), pin); assert.equal(pinned.get(args[3] + ':' + path), pin); }
    symlinkSync(join(consumer, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  }
  const example = join(scratch, 'registered-copies.mjs'), port = join(scratch, 'filesystem-storage.mjs');
  copyFileSync(join(root, owned[2]), example); copyFileSync(join(root, adapter), port);
  const hook = join(scratch, 'source-public-hook.mjs');
  if (source) writeFileSync(hook, `import {registerHooks} from 'node:module';const entries=${JSON.stringify(Object.fromEntries(names.map(name => ['@101/' + name, pathToFileURL(join(root, 'packages', name, 'src/index.ts')).href])))};registerHooks({resolve(s,c,n){return n(entries[s]??s,c)}});`);
  const runner = join(scratch, 'caller.mjs');
  writeFileSync(runner, `import assert from 'node:assert/strict';import {createOwnerDataFilesystemStorage} from './filesystem-storage.mjs';import {runRegisteredCopyRecovery} from './registered-copies.mjs';
const [directory,phase,scenario]=process.argv.slice(2);const storage=createOwnerDataFilesystemStorage(directory);let proof;try{proof=await runRegisteredCopyRecovery(storage,phase,scenario)}finally{storage.close()}
assert.equal(proof.result,'pass');console.log(JSON.stringify({proof,pid:process.pid,publicResolution:import.meta.resolve('@101/connect'),node:process.version,storage:'genuine-private-filesystem',ownedStorageClosed:true}));`);
  const results = [], imports = source ? ['--experimental-strip-types', '--import', hook] : [];
  const scenarios = [['current', 'seed', 'positive'], ['current', 'recover', 'positive'],
    ...['altered', 'foreign', 'stale', 'revoked', 'deleted', 'expired'].map(value => [value, 'negative', value])];
  for (const [name, phase, scenario] of probeOnly ? [] : scenarios) {
    const directory = join(scratch, name); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const result = await child(runner, [directory, phase, scenario], scratch, imports);
    assert.equal(result.code, 0, JSON.stringify({ phase, scenario, ...result })); assert.equal(result.signal, null); assert.equal(result.over, false); assert.equal(result.err, '');
    const output = JSON.parse(result.out); assert.equal(output.ownedStorageClosed, true); assert.equal(output.node, process.version);
    const expected = source ? pathToFileURL(join(root, 'packages/connect/src/index.ts')).href : pathToFileURL(join(consumer, 'node_modules/@101/connect/dist/index.js')).href;
    assert.equal(output.publicResolution, expected); results.push(output);
    assert.equal(readdirSync(directory).some(file => file.endsWith('.lock') || file.endsWith('.pending')), false);
  }
  if (!probeOnly) { const before = results[0].proof, after = results[1].proof;
  assert.deepEqual(after.record, before.record); assert.deepEqual(after.sourceTime, before.sourceTime); assert.equal(after.restoredAuthority, false);
  const seeded = results.filter(item => item.proof.phase !== 'recover');
  assert.equal(new Set(seeded.map(item => item.proof.sourceClockId)).size, seeded.length);
  for (const item of seeded) assert.match(item.proof.sourceClockId,
    new RegExp('^owned-node-process:' + item.pid + ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
  assert.ok(after.restored.epoch > before.saved.epoch); assert.equal(after.expiry.copiesRemoved, 1);
  assert.equal(results.find(item => item.proof.scenario === 'revoked').proof.commitRevocations, 1);
  }
  const nativeAbort = await nativeAbortProof();
  for (const [path, pin] of Object.entries(sourcePins)) assert.equal(hash(bytes(join(root, path))), pin);
  for (const [path, pin] of Object.entries(dependencyPins)) assert.equal(hash(bytes(join(root, path))), pin);
  for (const [path, pin] of Object.entries(installedPins)) assert.equal(hash(bytes(path)), pin);
  for (const [path, pin] of Object.entries(artifactPins)) assert.equal(hash(bytes(path, 8 * 1024 * 1024)), pin);
  assert.equal(hash(bytes(join(root, adapter))), adapterPin);
  receipt = { result: 'pass', mode: source ? 'source-public-exports-native-filesystem' : 'ordinary-installed-sdk-native-filesystem',
    sourcePins, dependencyPins, installedPins, artifactPins, manifestPin, adapterPin, node: process.version, results, nativeAbort,
    scope: 'Registered local recipient-copy recovery with real own-process RSS and controlled trusted-ingest expiry boundary. No remote/legacy/native-user-store/general B06 qualification.',
    cleanup: { ownedChildren: 0, rawOperations: 0, storagePorts: 0, directories: 0 } };
} finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
assert.equal(existsSync(scratch), false); console.log(JSON.stringify(receipt, null, 2));
