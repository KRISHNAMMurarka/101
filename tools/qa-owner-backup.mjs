#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { chromium, webkit } from 'playwright';

const args = process.argv.slice(2), workspace = args.includes('--workspace-exports');
const arg = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const sdkRoot = arg('--sdk-root');
const flags = new Set(['--workspace-exports', '--child', '--filesystem-only', '--old-copy-baseline']);
const values = new Set(['--sdk-root', '--fixture-dir', '--phase']);
const seen = new Set();
for (let index = 0; index < args.length; index++) {
  const key = args[index]; assert.ok(!seen.has(key)); seen.add(key);
  assert.ok(flags.has(key) || values.has(key));
  if (values.has(key)) { assert.ok(args[index + 1] && !args[index + 1].startsWith('--')); index++; }
}
assert.equal(args.includes('--child'), Boolean(arg('--fixture-dir') && arg('--phase')));
if (args.includes('--child')) assert.ok(['baseline', 'seed-crash', 'inspect', 'restore', 'reopen-restored', 'legacy-seed', 'migrate', 'seed', 'expiry'].includes(arg('--phase')));
if (workspace === Boolean(sdkRoot)) throw Error('Choose --workspace-exports or --sdk-root <fresh packed consumer>');
const root = resolve(import.meta.dirname, '..');
const names = ['@101/connect', '@101/device-model', '@101/device-runtime', '@101/device-web', '@101/vision', '@101/transport-webrtc', '@101/transport-websocket'];
const owned = ['packages/device-runtime/src/owner-backup.ts', 'packages/device-runtime/src/owner-backup.test.ts', 'examples/owner-backup/consumer.mjs', 'tools/qa-owner-backup.mjs'];
let resolver, server, context, hooks, packedSource, immutableManifest;
const hash = value => createHash('sha256').update(value).digest('hex');
try {
  let entries;
  if (sdkRoot) {
    const consumer = realpathSync(resolve(sdkRoot));
    assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
    assert.equal(packed.status, 'pass'); packedSource = packed.source.tree; assert.match(packedSource, /^[0-9a-f]{40}$/);
    for (const path of [...owned, 'examples/owner-data/filesystem-storage.mjs']) {
      const source = readFileSync(join(root, path));
      assert.equal(hash(source), hash(execFileSync('git', ['cat-file', 'blob', `${packedSource}:${path}`], { cwd: root, timeout: 5000, maxBuffer: 1048576 })));
    }
    for (const path of ['packages/device-runtime/src/owner-backup.ts', 'packages/device-runtime/src/owner-data.ts', 'packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/index.ts'])
      assert.equal(hash(readFileSync(join(root, path))), packed.source.sha256[path]);
    const manifestBytes = readFileSync(packed.manifest.path); assert.equal(hash(manifestBytes), packed.manifest.sha256);
    const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, packedSource); assert.equal(manifest.packages.length, names.length);
    for (const name of names) {
      const item = manifest.packages.find(item => item.name === name);
      assert.ok(item && Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024);
      const prefix = join(consumer, 'node_modules', name); assert.equal(realpathSync(prefix), prefix); assert.equal(lstatSync(prefix).isSymbolicLink(), false);
      for (const file of item.files) {
        const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + '/'));
        assert.equal(realpathSync(path), path); assert.ok(lstatSync(path).isFile());
        assert.equal(hash(readFileSync(path)), file.sha256);
      }
    }
    immutableManifest = packed.manifest;
    resolver = mkdtempSync(join(consumer, '.101-owner-backup-import-'));
    copyFileSync(join(root, 'examples/owner-data/filesystem-storage.mjs'), join(resolver, 'filesystem-storage.mjs'));
    copyFileSync(join(root, 'examples/owner-backup/consumer.mjs'), join(resolver, 'consumer.mjs'));
    const path = join(resolver, 'resolve.mjs');
    writeFileSync(path, 'export default {' + names.map(name => JSON.stringify(name) + ':import.meta.resolve(' + JSON.stringify(name) + ')').join(',') + '};\n');
    entries = (await import(pathToFileURL(path).href)).default;
    for (const name of names) assert.equal(entries[name], pathToFileURL(join(consumer, 'node_modules', name, 'dist/index.js')).href);
  } else entries = Object.fromEntries(names.map(name => [name, pathToFileURL(join(root, 'packages', name.slice(5), 'src/index.ts')).href]));
  if (workspace) hooks = registerHooks({ resolve(specifier, caller, next) { return next(entries[specifier] ?? specifier, caller); } });
  if (args.includes('--child')) {
    const { createOwnerDataFilesystemStorage } = await import(sdkRoot ? pathToFileURL(join(resolver, 'filesystem-storage.mjs')).href : '../examples/owner-data/filesystem-storage.mjs');
    const { runOwnerBackupExample, runOwnerBackupRawCopyBaseline } = await import(sdkRoot ? pathToFileURL(join(resolver, 'consumer.mjs')).href : '../examples/owner-backup/consumer.mjs');
    const storage = createOwnerDataFilesystemStorage(arg('--fixture-dir')), phase = arg('--phase');
    try {
      const result = phase === 'baseline' ? await runOwnerBackupRawCopyBaseline(storage) : await runOwnerBackupExample(storage, phase, { now: phase === 'expiry' ? 6000 : 1000 });
      console.log(JSON.stringify(result));
      if (phase === 'seed-crash') { if (resolver) rmSync(resolver, { recursive: true, force: true }); process.exit(0); } // Exactly this disposable child; no cleanup falsely records the unfinished attempt.
    } finally { storage.close(); }
  } else {
    const work = realpathSync(mkdtempSync(join(tmpdir(), '101-owner-backup-')));
    try {
      const command = (directory, phase) => spawnSync(process.execPath, [...(sdkRoot ? ['--no-experimental-strip-types'] : []), fileURLToPath(import.meta.url), '--child', '--fixture-dir', directory, '--phase', phase,
        ...(workspace ? ['--workspace-exports'] : ['--sdk-root', sdkRoot])], { encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
      const run = (directory, phase) => { const result = command(directory, phase); assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message); return JSON.parse(result.stdout.trim()); };
      if (args.includes('--old-copy-baseline')) {
        const result = run(join(work, 'old-copy'), 'baseline');
        assert.equal(result.accepted, false, 'the genuine old filesystem producer grant survives an unsafe raw restore');
      } else {
        const directory = join(work, 'restart'), phases = [];
        const seed = run(directory, 'seed-crash'); phases.push(seed);
        const ownerFile = join(directory, hash('owner-backup-example') + '.json');
        const interrupted = JSON.parse(readFileSync(ownerFile, 'utf8'));
        assert.equal(JSON.parse(interrupted.managed.records.artifacts).jobs.find(row => row.request.idempotencyKey === 'interrupted').state, 'running');
        phases.push(run(directory, 'inspect'));
        const damaged = JSON.parse(readFileSync(ownerFile, 'utf8')); damaged.managed.records.settings = '{damaged-inner';
        writeFileSync(ownerFile, JSON.stringify(damaged), { mode: 0o600 });
        phases.push(run(directory, 'restore'));
        const reopened = run(directory, 'reopen-restored'); phases.push(reopened);
        assert.equal(reopened.measured, seed.measured); assert.deepEqual(reopened.sourceTime, seed.sourceTime);
        assert.equal(reopened.outputSha256, seed.outputSha256); assert.equal(reopened.automaticWork, 0);
        const migration = join(work, 'migration'), migrated = [run(migration, 'legacy-seed'), run(migration, 'migrate'), run(migration, 'inspect')];
        const expiry = join(work, 'expiry'); run(expiry, 'seed'); const expired = run(expiry, 'expiry'); assert.equal(expired.removed, 1);
        const browserResults = [];
        if (!args.includes('--filesystem-only')) {
          const bases = Object.fromEntries(Object.entries(entries).map(([name, url]) => [name.slice(5), dirname(fileURLToPath(url))]));
          const importMap = { imports: Object.fromEntries(Object.entries(entries).map(([name, url]) => [name, '/sdk/' + name.slice(5) + '/' + basename(fileURLToPath(url))])) };
          const client = `import * as api from '@101/connect';import {runOwnerBackupExample,OWNER_BACKUP_EXAMPLE_OWNER,OWNER_BACKUP_EXAMPLE_REQUEST} from '/consumer.mjs';
window.backupApi=api;window.backupOwner=OWNER_BACKUP_EXAMPLE_OWNER;window.backupRequest=OWNER_BACKUP_EXAMPLE_REQUEST;
window.runBackup=async(name,phase)=>{const storage=api.createIndexedDbOwnerDataStorage({databaseName:name});try{return await runOwnerBackupExample(storage,phase);}finally{if(phase!=='seed-crash')storage.close();}};`;
          server = createServer((request, response) => {
            if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Owned local recovery qualification</title><script type="importmap">' + JSON.stringify(importMap) + '</script><script type="module" src="/client.js"></script>'); }
            else if (request.url === '/client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(client); }
            else if (request.url === '/consumer.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(join(root, 'examples/owner-backup/consumer.mjs'))); }
            else try {
              const match = /^\/sdk\/([^/]+)\/(.+\.(?:ts|js))$/.exec(decodeURIComponent(request.url));
              if (!match || !Object.hasOwn(bases, match[1])) throw Error('unowned');
              const base = bases[match[1]], path = resolve(base, match[2]), actual = realpathSync(path), subpath = relative(base, actual);
              if (isAbsolute(subpath) || subpath === '..' || subpath.startsWith('../') || subpath.includes('.test.')) throw Error('unowned');
              const source = readFileSync(actual, 'utf8'); response.setHeader('Content-Type', 'text/javascript');
              response.end(actual.endsWith('.ts') ? ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText : source);
            } catch { response.statusCode = 404; response.end(); }
          });
          await new Promise(ready => server.listen(0, '127.0.0.1', ready));
          const origin = 'http://127.0.0.1:' + server.address().port;
          for (const [engine, browser] of Object.entries({ chromium, webkit })) {
            const profile = join(work, engine + '-profile'), pageErrors = [], foreignRequests = [];
            const open = async () => {
              context = await browser.launchPersistentContext(profile, { headless: true });
              context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
              await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { foreignRequests.push(new URL(route.request().url()).origin); return route.abort(); } return route.continue(); });
              const page = await context.newPage(); await page.goto(origin); await page.waitForFunction(() => window.runBackup !== undefined); return page;
            };
            let page = await open(); const database = '101-backup-' + engine;
            const browserSeed = await page.evaluate(name => window.runBackup(name, 'seed-crash'), database);
            await context.close(); context = undefined; page = await open();
            await page.evaluate(name => window.runBackup(name, 'inspect'), database);
            const other = await context.newPage(); await other.goto(origin); await other.waitForFunction(() => window.backupApi !== undefined);
            await other.evaluate(async name => {
              const api = window.backupApi, storage = api.createIndexedDbOwnerDataStorage({ databaseName: name });
              const backup = api.createOwnerBackupController({ ownerId: window.backupOwner, storage, trustedNow: () => 1000, authorize: () => undefined });
              const data = api.createOwnerDataController({ ownerId: window.backupOwner, storage: backup.managedStorage, trustedNow: () => 1000,
                authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
              const ports = (await data.openStores({ retireOwned() {} })).value;
              const settings = api.createSettingsStore({ ownerId: window.backupOwner, storage: ports.settings, availableDevices: () => ['example-device'] });
              const previous = await settings.load();
              const history = api.createTelemetryHistory({ ownerId: window.backupOwner, storage: ports.telemetry, trustedNow: () => 1000,
                authorize: scope => ({ scope, expiresAt: scope.expiresAt }) });
              const capture = await history.requestCapture({ resourceId: 'example:queued', schemaVersion: 1, fields: ['value'], provenanceFields: [],
                destinationId: 'local-history', purpose: 'owner-queued', expiresAt: 50000, schema: { type: 'record', fields: { value: { type: 'boolean' } } } });
              if (!capture.ok || !history.enqueue(capture.handle, { sourceTime: { clockId: 'example:queued-clock', at: 17 }, quality: 'unverified', values: { value: true } }).ok) throw Error('queued-producer');
              window.oldBackupWriter = { storage, backup, data, ports, settings, previous, history };
            }, database);
            await page.evaluate(async name => {
              const storage = window.backupApi.createIndexedDbOwnerDataStorage({ databaseName: name });
              try { await storage.transact(window.backupOwner, state => { state.managed.records.settings = '{damaged-inner'; return { state, result: true }; }); }
              finally { storage.close(); }
            }, database);
            const restored = await page.evaluate(name => window.runBackup(name, 'restore'), database);
            const fenced = await other.evaluate(async () => {
              const value = window.oldBackupWriter;
              try { return { settingsAccepted: (await value.settings.save(value.previous.value.revision, { preferences: value.previous.value.preferences, profiles: value.previous.value.profiles })).ok,
                historyAccepted: (await value.history.flush()).ok, signalAborted: value.ports.signal.aborted }; }
              finally { value.history.close(); value.data.close(); await value.backup.close(); value.storage.close(); }
            });
            assert.deepEqual(fenced, { settingsAccepted: false, historyAccepted: false, signalAborted: true });
            const recovered = await page.evaluate(name => window.runBackup(name, 'reopen-restored'), database);
            assert.deepEqual(recovered.sourceTime, browserSeed.sourceTime); assert.equal(recovered.measured, browserSeed.measured); assert.equal(recovered.outputSha256, browserSeed.outputSha256);
            const grantAbort = await page.evaluate(async name => {
              const api = window.backupApi, owner = window.backupOwner, base = api.createIndexedDbOwnerDataStorage({ databaseName: name });
              const authority = new AbortController(); let armed = false;
              const storage = { transact(requested, mutate, guard) { return base.transact(requested, raw => { const next = mutate(raw);
                if (armed) queueMicrotask(() => authority.abort()); return next; }, guard); } };
              const backup = api.createOwnerBackupController({ ownerId: owner, storage, trustedNow: () => 1000,
                reviewedArtifacts: [{ applicationId: 'example:backup-artifact', destinationId: 'owner-local-artifacts',
                  sha256: (await api.createAssetReference('artifact:completed', 'blob', new TextEncoder().encode('OWNED LOCAL ARTIFACT BYTES\n'))).sha256 }],
                availableDevices: () => ['example-device'], authorize: scope => { if (scope.action === 'restore-reviewed') armed = true;
                  return { scope, expiresAt: scope.deadline, isCurrent: () => true, signal: authority.signal }; } });
              try {
                const capture = await backup.backup(window.backupRequest); if (!capture.ok) throw Error('new-checkpoint');
                await base.transact(owner, state => { state.managed.records.settings = '{damaged-inner'; return { state, result: true }; });
                const before = await base.transact(owner, state => ({ state, result: JSON.stringify(state) }));
                const result = await backup.restoreReviewed({ ...window.backupRequest, expectedSha256: capture.value.reference.sha256, retireOwned() {} });
                armed = false; const after = await base.transact(owner, state => ({ state, result: JSON.stringify(state) }));
                return { accepted: result.ok, grantAborted: authority.signal.aborted, unchanged: before === after };
              } finally { await backup.close(); base.close(); }
            }, database);
            assert.deepEqual(grantAbort, { accepted: false, grantAborted: true, unchanged: true });
            const raceDatabase = database + '-race';
            const raceSeed = await page.evaluate(name => window.runBackup(name, 'seed'), raceDatabase);
            await page.evaluate(async name => {
              const storage = window.backupApi.createIndexedDbOwnerDataStorage({ databaseName: name });
              try { await storage.transact(window.backupOwner, state => { state.managed.records.settings = '{damaged-inner'; return { state, result: true }; }); }
              finally { storage.close(); }
            }, raceDatabase);
            for (const tab of [page, other]) await tab.evaluate(async ({ name, sha256 }) => {
              const api = window.backupApi, storage = api.createIndexedDbOwnerDataStorage({ databaseName: name });
              const gate = new Promise(resolve => { window.releaseRestore = resolve; }); window.restoreReady = false;
              const pin = (await api.createAssetReference('artifact:completed', 'blob', new TextEncoder().encode('OWNED LOCAL ARTIFACT BYTES\n'))).sha256;
              const backup = api.createOwnerBackupController({ ownerId: window.backupOwner, storage, trustedNow: () => 1000,
                availableDevices: () => ['example-device'], reviewedArtifacts: [{ applicationId: 'example:backup-artifact', destinationId: 'owner-local-artifacts', sha256: pin }],
                authorize: async scope => { window.restoreReady = true; await gate; return { scope, expiresAt: scope.deadline, isCurrent: () => true }; } });
              window.competingRestore = backup.restoreReviewed({ ...window.backupRequest, expectedSha256: sha256, retireOwned() {} })
                .finally(async () => { await backup.close(); storage.close(); });
            }, { name: raceDatabase, sha256: raceSeed.captured.reference.sha256 });
            await Promise.all([page, other].map(tab => tab.waitForFunction(() => window.restoreReady === true)));
            const competing = await Promise.all([page, other].map(tab => tab.evaluate(async () => { window.releaseRestore(); return window.competingRestore; })));
            assert.equal(competing.filter(result => result.ok).length, 1);
            assert.equal(competing.filter(result => !result.ok && result.reason === 'conflict').length, 1);
            const raceRestored = await page.evaluate(name => window.runBackup(name, 'reopen-restored'), raceDatabase);
            assert.equal(raceRestored.outputSha256, raceSeed.outputSha256); assert.deepEqual(raceRestored.sourceTime, raceSeed.sourceTime);
            assert.deepEqual(pageErrors, []); assert.deepEqual(foreignRequests, []);
            browserResults.push({ engine, version: context.browser()?.version(), processRestart: true, restored, fenced, grantAbort, competing, pageErrors: 0, foreignRequests: 0 });
            await context.close(); context = undefined;
          }
        }
        console.log(JSON.stringify({ result: 'pass', profile: 'managed-owner-backup/1', node: process.version,
          publicResolution: workspace ? 'source-worktree-public-barrels-not-installed' : 'installed-sdk-public-exports',
          filesystem: { cleanProcesses: 9, originalRunning: true, phases, migration: migrated, expiry: expired }, browsers: browserResults,
          ...(sdkRoot ? { packedSource, immutableManifest, publicEsmResolutions: entries, externalCaller: 'Immutable repository example and filesystem adapter copied outside SDK into owned consumer; ordinary public ESM, no resolver hooks or type stripping.' } : {}),
          sourceSha256: Object.fromEntries([...owned, 'examples/owner-data/filesystem-storage.mjs'].map(path => [path, hash(readFileSync(join(root, path)))])),
          publicEntrySha256: Object.fromEntries(Object.entries(entries).map(([name, url]) => [name, hash(readFileSync(fileURLToPath(url)))])),
          exclusions: ['missing-or-corrupt-outer-fence-recovery', 'registered-recipient-copies', 'remote-storage', 'legacy-native-desktop', 'unmanaged-backup-copies', 'malicious-filesystem-host-tamper-resistance', 'restored-live-authority', 'physical-effect'] }, null, 2));
      }
    } finally { if (context) { await context.close(); context = undefined; } rmSync(work, { recursive: true, force: true }); }
  }
} finally {
  if (context) await context.close(); if (server) await new Promise(done => server.close(done));
  hooks?.deregister(); if (resolver) rmSync(resolver, { recursive: true, force: true });
}
