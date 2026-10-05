#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { chromium, webkit } from 'playwright';

const args = process.argv.slice(2), workspace = args.includes('--workspace-exports');
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const sdkRoot = value('--sdk-root'), child = args.includes('--child');
if (!workspace && !sdkRoot) throw new Error('Use --workspace-exports or --sdk-root <fresh packed consumer>');
const root = resolve(import.meta.dirname, '..'), publicNames = ['@101/connect', '@101/device-model', '@101/device-runtime', '@101/device-web', '@101/vision', '@101/transport-webrtc', '@101/transport-websocket'];
let resolverDirectory, publicEntries, server;
let context;
let hooks;
try {
  if (sdkRoot) {
    resolverDirectory = mkdtempSync(join(resolve(sdkRoot), '.101-owner-import-'));
    const resolver = join(resolverDirectory, 'resolve.mjs');
    writeFileSync(resolver, 'export default {' + publicNames.map(name => JSON.stringify(name) + ': import.meta.resolve(' + JSON.stringify(name) + ')').join(',') + '};\n');
    publicEntries = (await import(pathToFileURL(resolver).href)).default;
  } else publicEntries = Object.fromEntries(publicNames.map(name => [name, pathToFileURL(resolve(root, 'packages', name.slice(5), 'src/index.ts')).href]));
  hooks = registerHooks({ resolve(specifier, ctx, next) { return next(publicEntries[specifier] ?? specifier, ctx); } });
  if (child) {
    const { createOwnerDataFilesystemStorage } = await import('../examples/owner-data/filesystem-storage.mjs');
    const { runOwnerDataExample, OWNER_DATA_EXAMPLE_OWNER } = await import('../examples/owner-data/consumer.mjs');
    const storage = createOwnerDataFilesystemStorage(value('--fixture-dir'));
    try {
      const result = await runOwnerDataExample(storage, value('--phase'));
      const proof = await storage.transact(OWNER_DATA_EXAMPLE_OWNER, state => ({ state, result: {
        dataKinds: Object.keys(state.records), copies: state.copies.length, auditRows: state.audit.length,
        onlyRedactedAudit: state.audit.every(event => Object.keys(event).sort().join(',') === 'action,at,expiresAt,kinds,operationId,removed,state'),
        noPrivateReason: !JSON.stringify(state).includes('private-backend-detail'),
      } }));
      console.log(JSON.stringify({ result, proof }));
    } finally { storage.close(); }
  } else {
    const work = realpathSync(mkdtempSync(join(tmpdir(), '101-owner-data-')));
    const ownedPaths = ['packages/device-runtime/src/owner-data.ts', 'packages/device-runtime/src/owner-data.test.ts',
      'packages/device-runtime/src/owner-data-storage.ts', 'packages/device-runtime/src/owner-data-storage.test.ts',
      'examples/owner-data/consumer.mjs', 'examples/owner-data/filesystem-storage.mjs', 'tools/qa-owner-data.mjs'];
    const sourceSha256 = Object.fromEntries(ownedPaths.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
    const phases = [];
    const runProcess = (directory, phase) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', '--fixture-dir', directory, '--phase', phase,
      ...(workspace ? ['--workspace-exports'] : ['--sdk-root', sdkRoot])], { encoding: 'utf8', timeout: 15000 });
    const run = (directory, phase) => {
      const result = runProcess(directory, phase);
      assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
      return JSON.parse(result.stdout.trim());
    };
    const durable = join(work, 'durable');
    for (const phase of ['seed', 'inspect', 'begin', 'stage']) phases.push(run(durable, phase));
    const ownerFile = join(durable, createHash('sha256').update('owner-data-example').digest('hex') + '.json');
    const stagedBytes = readFileSync(ownerFile), blockedLock = ownerFile + '.lock';
    mkdirSync(blockedLock, { mode: 0o700 });
    try { const failed = runProcess(durable, 'resume'); assert.notEqual(failed.status, 0, 'a genuine unavailable lock must stop recovery');
      assert.deepEqual(readFileSync(ownerFile), stagedBytes, 'failed persistence must preserve the exact pending stage'); }
    finally { rmdirSync(blockedLock); } // Fixture-owned lock is removed explicitly, never stolen by the storage adapter.
    phases.push(run(durable, 'resume'));
    assert.equal(phases[3].result.deletion.state, 'pending');
    assert.equal(phases[4].result.deletion.state, 'completed');
    assert.deepEqual(phases[4].proof.dataKinds, []); assert.equal(phases[4].proof.copies, 0);
    assert.ok(phases[4].proof.auditRows > 0); assert.ok(phases[4].proof.onlyRedactedAudit);
    const expiry = join(work, 'expiry'), expiryPhases = [];
    for (const phase of ['seed', 'expiry', 'audit-expiry']) expiryPhases.push(run(expiry, phase));
    assert.equal(expiryPhases[1].result.swept.telemetryRemoved, 1); assert.equal(expiryPhases[1].result.swept.artifactsRemoved, 1);
    assert.equal(expiryPhases[1].result.swept.copiesRemoved, 1); assert.equal(expiryPhases[2].proof.auditRows, 0);
    const results = [];
    if (!args.includes('--filesystem-only')) {
      // The public import map serves only this exact selected source/installed package graph.
      // Source-mode transpilation is a disposable browser fixture, not a build or package qualification.
      const bases = Object.fromEntries(Object.entries(publicEntries).map(([name, url]) => [name.slice(5), dirname(fileURLToPath(url))]));
      const importMap = { imports: Object.fromEntries(Object.entries(publicEntries).map(([name, url]) =>
        [name, '/sdk/' + name.slice(5) + '/' + basename(fileURLToPath(url))])) };
      const client = `import * as api from '@101/connect';\nimport {runOwnerDataExample} from '/consumer.mjs';\nwindow.ownerApi=api;window.runOwnerData=async(name,phase)=>{const storage=api.createIndexedDbOwnerDataStorage({databaseName:name});try{return await runOwnerDataExample(storage,phase);}finally{storage.close();}};`;
      server = createServer((request, response) => {
        if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Owned local data qualification</title><script type="importmap">' + JSON.stringify(importMap) + '</script><script type="module" src="/client.js"></script>'); }
        else if (request.url === '/client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(client); }
        else if (request.url === '/consumer.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(resolve(root, 'examples/owner-data/consumer.mjs'))); }
        else {
          try {
            const match = /^\/sdk\/([^/]+)\/(.+\.(?:ts|js))$/.exec(decodeURIComponent(request.url));
            if (!match || !Object.hasOwn(bases, match[1])) throw new Error('unowned module');
            const base = bases[match[1]], path = resolve(base, match[2]), subpath = relative(base, path);
            if (isAbsolute(subpath) || subpath === '..' || subpath.startsWith('../') || subpath.includes('.test.')) throw new Error('unowned module');
            const source = readFileSync(path, 'utf8');
            response.setHeader('Content-Type', 'text/javascript');
            response.end(path.endsWith('.ts') ? ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText : source);
          } catch { response.statusCode = 404; response.end(); }
        }
      });
      await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer));
      const address = server.address(), origin = 'http://127.0.0.1:' + address.port;
      for (const [engine, type] of Object.entries({ chromium, webkit })) {
        const profile = join(work, engine + '-profile');
        const open = async () => {
          context = await type.launchPersistentContext(profile, { headless: true, viewport: { width: 900, height: 700 } });
          const errors = [], foreign = [];
          context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
          await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { foreign.push(new URL(route.request().url()).origin); return route.abort(); } return route.continue(); });
          const page = await context.newPage(); await page.goto(origin); await page.waitForFunction(() => window.runOwnerData !== undefined);
          return { page, errors, foreign };
        };
        let { page, errors, foreign } = await open();
        const databaseName = '101-owned-' + engine;
        const identityKeyId = await page.evaluate(async name => {
          const store = window.ownerApi.createWebCryptoIdentityStore({ databaseName: name + '-identity' });
          try { const identity = await store.create(); return identity.keyId; } finally { store.close(); }
        }, databaseName);
        const seed = await page.evaluate(name => window.runOwnerData(name, 'seed'), databaseName);
        const adapterProof = await page.evaluate(async name => {
          const api = window.ownerApi, port = api.createIndexedDbOwnerDataStorage({ databaseName: name });
          const abort = new AbortController(); abort.abort(); let mutated = false;
          const started = performance.now();
          const pending = port.transact('aborted-owner', () => { mutated = true; return { state: { unexpected: true }, result: true }; },
            { signal: abort.signal, isCurrent: () => true }).then(() => 'accepted', () => 'rejected');
          let timer;
          const state = await Promise.race([pending, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout('timeout'), 150); })]);
          clearTimeout(timer); port.close();
          return { state, mutated, elapsedMs: performance.now() - started };
        }, databaseName);
        assert.equal(adapterProof.state, 'rejected', 'already aborted native transaction must reject promptly');
        assert.equal(adapterProof.mutated, false);
        const atomicClose = await page.evaluate(async name => {
          const api = window.ownerApi, port = api.createIndexedDbOwnerDataStorage({ databaseName: name });
          const result = await port.transact('close-inside', () => { port.close(); return { state: { unexpected: true }, result: true }; }).then(() => true, () => false);
          const reopened = api.createIndexedDbOwnerDataStorage({ databaseName: name });
          try { const absent = await reopened.transact('close-inside', state => ({ state: { checked: true }, result: state === undefined })); return { accepted: result, absent }; }
          finally { reopened.close(); }
        }, databaseName);
        assert.deepEqual(atomicClose, { accepted: false, absent: true });
        const capacityProof = await page.evaluate(async name => {
          const port = window.ownerApi.createIndexedDbOwnerDataStorage({ databaseName: name });
          try { const results = await Promise.all(Array.from({ length: 9 }, (_, index) => port.transact('capacity-' + index,
            () => ({ state: { index }, result: true })).then(() => true, () => false)));
            return { accepted: results.filter(Boolean).length, rejected: results.filter(result => !result).length }; }
          finally { port.close(); }
        }, databaseName);
        assert.deepEqual(capacityProof, { accepted: 8, rejected: 1 });
        const another = await context.newPage(); await another.goto(origin); await another.waitForFunction(() => window.ownerApi !== undefined);
        await another.evaluate(async name => {
          const api = window.ownerApi, storage = api.createIndexedDbOwnerDataStorage({ databaseName: name });
          const controller = api.createOwnerDataController({ ownerId: 'owner-data-example', storage, trustedNow: () => 1000,
            authorize: scope => ({ scope, expiresAt: scope.deadline, isCurrent: () => true }) });
          const ports = (await controller.openStores({ retireOwned() {} })).value;
          const settings = api.createSettingsStore({ ownerId: 'owner-data-example', storage: ports.settings, availableDevices: () => ['example-device'] });
          const old = await settings.load();
          const history = api.createTelemetryHistory({ ownerId: 'owner-data-example', storage: ports.telemetry, trustedNow: () => 1000,
            authorize: scope => ({ scope, expiresAt: scope.expiresAt }) });
          const capture = await history.requestCapture({ resourceId: 'example:held-measurement', schemaVersion: 1, fields: ['width'], provenanceFields: [],
            destinationId: 'local-history', purpose: 'pending-local-observation', expiresAt: 50000,
            schema: { type: 'record', fields: { width: { type: 'scalar', unit: 'px', min: 0, max: 100000 } } } });
          if (!capture.ok || !history.enqueue(capture.handle, { sourceTime: { clockId: 'held:clock', at: performance.now() }, quality: 'observed', values: { width: innerWidth } }).ok) throw new Error('held-capture-denied');
          const input = new TextEncoder().encode('pending local artifact');
          const jobs = api.createDurableArtifactJobStore({ ownerId: 'owner-data-example', storage: ports.artifacts, now: () => 1000,
            authorize: () => ({ expiresAt: 50000, isCurrent: () => true, signal: ports.signal }) });
          const submitted = await jobs.submit({ idempotencyKey: 'late-artifact', applicationId: 'example:pending-artifact', profileId: '101:local-artifact',
            profileRevision: 1, destinationId: 'owner-local-artifacts', totalUnits: 1,
            input: await api.createAssetReference('artifact:pending-input', 'text', input) });
          const started = submitted.ok && await jobs.start('late-artifact', input);
          if (!started?.ok) throw new Error('held-job-denied');
          window.heldWriter = { controller, storage, ports, settings, old, history, jobs, attempt: started.value, input };
        }, databaseName);
        const begun = await page.evaluate(name => window.runOwnerData(name, 'begin'), databaseName);
        const late = await another.evaluate(async () => { const held = window.heldWriter;
          try { const result = await held.settings.save(held.old.value.revision, { preferences: held.old.value.preferences, profiles: held.old.value.profiles });
            const flushed = await held.history.flush(), completed = await held.attempt.commit(held.input);
            return { accepted: result.ok, signalAborted: held.ports.signal.aborted, lateTelemetryAccepted: flushed.ok,
              lateArtifactAccepted: completed.ok, artifactSignalAborted: held.attempt.signal.aborted }; }
          finally { held.controller.close(); held.history.close(); await held.jobs.close(); held.storage.close(); } });
        assert.deepEqual(late, { accepted: false, signalAborted: true, lateTelemetryAccepted: false, lateArtifactAccepted: false, artifactSignalAborted: true });
        const stage = await page.evaluate(name => window.runOwnerData(name, 'stage'), databaseName);
        assert.equal(stage.deletion.completedStages, 1); assert.equal(stage.deletion.state, 'pending');
        assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
        await context.close(); context = undefined;
        ({ page, errors, foreign } = await open());
        const resumed = await page.evaluate(name => window.runOwnerData(name, 'resume'), databaseName);
        assert.equal(resumed.deletion.state, 'completed'); assert.equal(resumed.restoredAuthority, false);
        const identityProof = await page.evaluate(async ({ name, keyId }) => {
          const api = window.ownerApi, store = api.createWebCryptoIdentityStore({ databaseName: name + '-identity' });
          try { const identity = await store.load(); if (!identity || identity.keyId !== keyId) throw new Error('identity-separation-failed');
            const bytes = new TextEncoder().encode('independent identity remains current after managed data deletion');
            const signature = await identity.sign(bytes);
            return { current: await identity.isCurrent(), verified: await api.webEndpointCrypto.verify(identity.publicKey, bytes, signature) }; }
          finally { store.close(); }
        }, { name: databaseName, keyId: identityKeyId });
        assert.deepEqual(identityProof, { current: true, verified: true });
        assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
        results.push({ engine, version: context.browser()?.version(), seedRows: seed.exported.telemetry.records.length,
          artifactSha256: seed.artifactSha256, operationId: begun.deletion.operationId, adapterProof, atomicClose, capacityProof, late, identityProof,
          independentRoute: begun.independentRoute, processRestart: true, complete: true });
        await context.close(); context = undefined;
      }
    }
    for (const [path, hash] of Object.entries(sourceSha256)) assert.equal(createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'), hash, 'candidate unchanged');
    console.log(JSON.stringify({ result: 'pass', scope: 'PARTIAL managed-owner-data/1; actual owned SDK stores and registered local recipient only; no legacy/unmanaged/native/remote/forensic-erase qualification',
      work, sourceSha256, filesystem: { phases, expiryPhases, genuineBlockedLockPreservedStage: true, processRestart: true }, browsers: results }, null, 2));
  }
} finally {
  await context?.close(); if (server) await new Promise(resolveServer => server.close(resolveServer)); hooks?.deregister();
  if (resolverDirectory) rmSync(resolverDirectory, { recursive: true, force: true });
}
