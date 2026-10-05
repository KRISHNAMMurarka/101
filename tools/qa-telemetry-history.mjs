#!/usr/bin/env node
/** Native IndexedDB qualification using only an installed public SDK consumer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = String.raw`
import { createDeviceRuntime, createIndexedDbTelemetryStorage, createTelemetryHistory } from '@101/connect';
import { createMemoryTelemetryHistory } from '@101/connect/examples/telemetry-history';
const assert = (value, label) => { if (!value) throw new Error(label); };
const schema = { type: 'record', fields: {
  residentBytes: { type: 'scalar', unit: 'By', min: 0, max: Number.MAX_SAFE_INTEGER }, ready: { type: 'boolean' },
} };
const captureRequest = { resourceId: 'process:memory', schemaVersion: 2, schema, fields: ['residentBytes', 'ready'],
  provenanceFields: ['calibrationRevision'], destinationId: 'local-history', purpose: 'local-memory-check', expiresAt: 100000 };
const uploadRequest = { resourceId: 'process:memory', schemaVersion: 2, fields: ['residentBytes'],
  provenanceFields: [], destinationId: 'owned-local-recipient', purpose: 'local-memory-check', expiresAt: 100000 };
const entry = { sourceTime: { clockId: 'process:clock', at: 123.75 }, quality: 'observed',
  values: { residentBytes: 65536, ready: true }, provenance: { calibrationRevision: 3 } };
let storage, history, handle, time = 1000, databaseName;
const allow = scope => ({ scope, expiresAt: scope.expiresAt });
function options(ownerId = 'owner-a', selectedStorage = storage, limits = {}) {
  return { ownerId, storage: selectedStorage, trustedNow: () => time, authorize: allow, limits };
}
async function grant(target = history) { const result = await target.requestCapture(captureRequest); assert(result.ok, 'Capture denied'); return result.handle; }
async function rawRead() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onerror = () => reject(new Error('Raw read unavailable'));
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('owners'), read = transaction.objectStore('owners').getAll();
      read.onsuccess = () => resolve(read.result); read.onerror = () => reject(new Error('Raw read failed'));
      transaction.oncomplete = () => db.close();
    };
  });
}
async function rawWrite(ownerId, value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('owners', 'readwrite');
      transaction.objectStore('owners').put(value, ownerId);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(new Error('Raw write failed')); };
    };
    request.onerror = () => reject(new Error('Raw open failed'));
  });
}
export async function setup(name) {
  databaseName = name; time = 1000;
  storage = createIndexedDbTelemetryStorage({ databaseName }); history = createTelemetryHistory(options());
  assert(!history.enqueue({}, entry).ok, 'History recorded without opt-in');
  const empty = await history.exportPage(); assert(empty.ok && empty.records.length === 0, 'Default history was nonempty');
  handle = await grant();
  assert(history.enqueue(handle, entry).ok, 'Capture rejected'); assert((await history.flush()).committed === 1, 'Capture was not durable');
  const rows = await history.exportPage(); assert(rows.ok && rows.records[0].sourceTime.at === 123.75 &&
    rows.records[0].sourceTime.clockId === 'process:clock' && rows.records[0].quality === 'observed' &&
    rows.records[0].provenance.calibrationRevision === 3, 'Original observation metadata changed');
  history.close(); storage.close();
  storage = createIndexedDbTelemetryStorage({ databaseName }); history = createTelemetryHistory(options());
  const reopened = await history.exportPage(); assert(reopened.ok && reopened.records.length === 1, 'Restart lost durable rows');
  assert(!history.enqueue(handle, entry).ok && history.status().captureHandles === 0 && history.status().uploadHandles === 0, 'Restart restored authority');
  return { durableRestart: true, noRestoredAuthority: true, originalClockTimeQualityProvenance: true };
}
export async function offlineUpload() {
  const credential = 'credential-sentinel';
  const upload = await history.requestUpload(uploadRequest, async (batch, context) => {
    const response = await fetch('/recipient', { method: 'POST', signal: context.signal,
      headers: { 'content-type': 'application/json', 'x-local-auth': credential }, body: JSON.stringify(batch) });
    if (!response.ok) throw new Error('redacted-recipient-failure');
    return response.json();
  }); assert(upload.ok, 'Upload denied');
  assert(!(await history.pumpUpload(upload.handle)).ok, 'Offline recipient unexpectedly acknowledged');
  assert((await history.pumpUpload(upload.handle)).status === 'backoff', 'Offline retry did not back off');
  // The recorder and live commands have independent queues while the recipient is unavailable.
  let delivered = false;
  const runtime = createDeviceRuntime({ now: () => time, authorize: () => ({ expiresAt: 100000, maxAgeMs: 1000 }) });
  const device = (id, sink) => ({ schemaVersion: 1, id, label: 'Command', revision: 1, adapter: { id: 'example:command', version: '1' },
    runtime: { platform: 'embedded-application' }, capabilities: [{ id: 'command', semantic: 'example:command', schemaVersion: 1,
    kind: sink ? 'command' : 'event', value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 },
    permissions: sink ? ['invoke'] : ['subscribe'] }] });
  const source = runtime.registerSource({ device: device('source', false), capability: 'command' });
  const sink = runtime.registerSink({ device: device('sink', true), capability: 'command', apply() { delivered = true; }, release() {} });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  assert(runtime.route({ from: source, to: sink, principalId: 'command-owner', applicationId: 'commands', sessionId: 'session' }).start().ok, 'Command route did not start');
  assert(runtime.publish(source, true, { operationId: '1', deadline: 1500 }).ok, 'Command was rejected'); runtime.flush();
  assert(delivered, 'Offline history prevented command delivery'); runtime.close();
  time = 2000; const sent = await history.pumpUpload(upload.handle); assert(sent.ok && sent.sent === 1, 'Retry did not acknowledge');
  assert((await history.pumpUpload(upload.handle)).status === 'idle', 'Acknowledged batch was uploaded twice');
  assert(!JSON.stringify(await rawRead()).includes(credential) && !JSON.stringify(await history.exportPage()).includes(credential), 'Credential persisted or exported');
  return { offlineRetryThenAck: true, credentialOnlyInUploaderClosure: true, independentRealCommandDelivery: true };
}
export async function isolationAndCorruption() {
  const other = createTelemetryHistory(options('owner-b')); const grantB = await grant(other);
  other.enqueue(grantB, entry); await other.flush();
  await history.delete();
  const remaining = await other.exportPage(); assert(remaining.ok && remaining.records.length === 1, 'Delete affected another owner');
  await rawWrite('owner-a', { version: 999, secret: 'never-export' });
  assert(!(await history.exportPage()).ok, 'Future owner envelope was accepted');
  assert((await history.delete()).ok, 'Explicit delete failed to recover corrupt owner');
  const recovered = await history.exportPage(); assert(recovered.ok && recovered.records.length === 0, 'Corrupt owner data was exposed');
  handle = await grant(); history.enqueue(handle, entry); await history.flush();
  const raw = (await rawRead()).find(row => row.ownerId === 'owner-a'); raw.rows[0].values.secret = 'never-export';
  await rawWrite('owner-a', raw); assert(!(await history.exportPage()).ok && history.status().captureHandles === 0, 'Corruption retained authority');
  await history.delete();
  time = 1999; assert(!(await other.exportPage()).ok, 'Clock rollback accepted'); other.close(); time = 2000;
  return { ownerIsolation: true, futureAndCorruptEnvelopesFailClosed: true, explicitRecovery: true, rollbackFailsClosed: true };
}
export async function prepareConcurrent(name, owner = 'shared-owner') {
  history?.close(); storage?.close(); time = 3000; databaseName = name;
  storage = createIndexedDbTelemetryStorage({ databaseName }); history = createTelemetryHistory(options(owner, storage, { maxRows: 2 }));
  handle = await grant();
}
export async function concurrentCommit(sourceClock) {
  for (let index = 0; index < 2; index++) assert(history.enqueue(handle, { ...entry, sourceTime: { clockId: sourceClock, at: index } }).ok, 'Concurrent enqueue rejected');
  return history.flush();
}
export async function concurrentRead() {
  const page = await history.exportPage(); assert(page.ok && page.records.length === 2 && new Set(page.records.map(row => row.id)).size === 2, 'Concurrent quota or IDs were not atomic');
  const raw = (await rawRead()).find(row => row.ownerId === 'shared-owner');
  assert(raw.bytes === raw.rows.reduce((sum, row) => sum + new TextEncoder().encode(JSON.stringify(row)).byteLength, 0), 'Byte accounting drifted');
  return { rows: page.records.length, atomicQuotaAndByteAccountingAcrossTabs: true };
}
export async function deleteAndLateAppend() {
  assert(history.enqueue(handle, entry).ok, 'Pending capture rejected');
  const another = createTelemetryHistory(options('shared-owner', storage, { maxRows: 2 }));
  await another.delete(); assert(!(await history.flush()).ok, 'Deleted epoch allowed delayed append');
  const page = await another.exportPage(); assert(page.ok && page.records.length === 0, 'Deleted rows resurrected'); another.close();
  return { deletedEpochFencesDelayedAppend: true };
}
export async function lateAck() {
  const capture = await grant(); history.enqueue(capture, entry); await history.flush();
  let resume, batch;
  const upload = await history.requestUpload(uploadRequest, value => { batch = value; return new Promise(resolve => { resume = resolve; }); });
  assert(upload.ok, 'Late ACK grant denied'); const pending = history.pumpUpload(upload.handle);
  for (let attempt = 0; attempt < 100 && !resume; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert(resume, 'Upload did not begin');
  const another = createTelemetryHistory(options('shared-owner', storage)); await another.delete();
  const fresh = await grant(another); another.enqueue(fresh, entry); await another.flush();
  resume({ batchId: batch.batchId, recordIds: batch.records.map(row => row.id) });
  const result = await pending; assert(!result.ok && result.reason === 'epoch-changed' && history.status().uploaded === 0, 'Late ACK crossed deleted epoch');
  const rows = await another.exportPage(); assert(rows.ok && rows.records.length === 1, 'Late ACK removed new history'); another.close();
  return { nativeEpochFencesLateAck: true };
}
export async function expiryAndExample() {
  const expiring = createTelemetryHistory(options('expiring-owner', storage, { retentionMs: 10 }));
  const expiringHandle = await grant(expiring); expiring.enqueue(expiringHandle, { ...entry, sourceTime: { clockId: 'future-source:clock', at: 999999999 } });
  await expiring.flush(); expiring.close(); time = 3010;
  const resumed = createTelemetryHistory(options('expiring-owner')); const page = await resumed.exportPage();
  assert(page.ok && page.records.length === 0, 'Dormant expiry used source time'); resumed.close();
  const example = createMemoryTelemetryHistory(options('example-owner'));
  const consent = await example.requestCapture({ purpose: 'memory-inspection', expiresAt: 4000 }); assert(consent.ok, 'Example capture denied');
  const admission = example.recordBatch(consent.handle, [{ timestamp: 100.25, residentBytes: 69632, quality: 'observed' },
    { timestamp: 101.5, residentBytes: 73728, quality: 'unverified' }], 'node-process:clock'); assert(admission.admitted === 2, 'Example did not split producer readings');
  await example.history.flush(); const observations = await example.history.exportPage();
  assert(observations.ok && observations.records[0].sourceTime.at === 100.25 && observations.records[1].sourceTime.at === 101.5 &&
    observations.records[1].quality === 'unverified' && observations.records[0].sourceTime.clockId === 'node-process:clock', 'Example reinterpreted nested readings');
  example.history.close(); return { dormantTrustedIngestExpiry: true, publicV2BatchExample: true };
}
export async function futureDatabase(name) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 2); request.onupgradeneeded = () => request.result.createObjectStore('owners');
    request.onerror = () => reject(new Error('Future DB creation failed')); request.onsuccess = () => { request.result.close(); resolve(); };
  });
  const futureStorage = createIndexedDbTelemetryStorage({ databaseName: name });
  const future = createTelemetryHistory(options('owner-a', futureStorage));
  const result = await future.exportPage();
  assert(!result.ok && result.reason === 'storage-invalid', 'Unsupported native database version was not a closed incompatible state'); future.close(); futureStorage.close();
  return { nativeFutureDatabaseVersionFailsClosed: true };
}
export async function closeInsideMutation(name) {
  const port = createIndexedDbTelemetryStorage({ databaseName: name });
  const rejection = await port.transact('owner', () => {
    port.close(); return { state: { test: 1 }, result: 1 };
  }).then(() => { throw new Error('Closed mutation committed'); }, error => error);
  assert(rejection.name === 'Error' && rejection.message === 'storage-unavailable', 'Native close inside mutation leaked a backend error');
  const reopened = createIndexedDbTelemetryStorage({ databaseName: name });
  const absent = await reopened.transact('owner', current => ({ state: { checked: true }, result: current === undefined }));
  reopened.close(); assert(absent, 'Closed mutation persisted its state');
  await new Promise(resolve => setTimeout(resolve, 0));
  return { nativeCloseInsideMutationFailsClosedWithoutPageErrors: true };
}
export function close() { history?.close(); storage?.close(); }
`;

function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function contained(base, path) {
  const name = relative(base, path); return name !== '..' && !name.startsWith('../') && !isAbsolute(name);
}
function inventory(directory, base = directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name), stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), 'Installed SDK must contain real consumer files');
    assert.ok(contained(base, realpathSync(path)), 'Installed file escaped consumer');
    return stat.isDirectory() ? inventory(path, base) : [{ path: relative(base, path), absolute: path, sha256: hash(path) }];
  });
}

/** The caller must already have audited/installed its source-bound SDK tarballs offline. */
export async function runTelemetryHistoryBrowserChecks({ consumerDirectory, engines = ['chromium'] }) {
  const consumer = realpathSync(consumerDirectory), served = new Map(), imports = {}, installed = [];
  for (const name of ['device-model', 'device-runtime', 'transport-webrtc', 'device-web', 'vision', 'connect']) {
    const directory = join(consumer, 'node_modules', '@101', name);
    assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Consumer packages must be installed without workspace links');
    assert.ok(contained(consumer, realpathSync(directory)), 'Installed package escaped its consumer directory');
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@101/' + name);
    const files = inventory(directory);
    installed.push({ name: pkg.name, version: pkg.version, files: files.map(({ path, sha256 }) => ({ path, sha256 })) });
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const file = typeof target === 'string' ? target : target.import ?? target.default;
      assert.ok(file.startsWith('./') && files.some(item => './' + item.path === file), 'Public runtime export is missing');
      imports[pkg.name + (subpath === '.' ? '' : subpath.slice(1))] = '/packages/' + name + '/' + file.slice(2);
    }
    for (const file of files.filter(item => item.path.endsWith('.js'))) served.set('/packages/' + name + '/' + file.path, file.absolute);
  }
  assert.ok(imports['@101/connect/examples/telemetry-history'], 'Public telemetry-history example must be packed');
  const html = '<!doctype html><title>Local telemetry verification</title><script type="importmap">' + JSON.stringify({ imports }) + '</script>';
  const checks = [], received = [], recipient = { attempts: 0, credentialVerified: false };
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/recipient' && request.method === 'POST') {
      let body = '', overflow = false;
      request.on('data', bytes => { if (body.length + bytes.length > 32768) { overflow = true; request.destroy(); } else body += bytes; });
      request.on('end', () => {
        try {
          assert.ok(!overflow && request.headers['x-local-auth'] === 'credential-sentinel'); recipient.credentialVerified = true;
          const batch = JSON.parse(body); assert.ok(batch.records.length > 0 && batch.records.length <= 16);
          assert.ok(batch.records.every(row => Object.keys(row.values).join(',') === 'residentBytes' && !row.provenance));
          assert.ok(!body.includes('credential-sentinel'));
          recipient.attempts++; received.push({ batchId: batch.batchId, ids: batch.records.map(row => row.id) });
          if (recipient.attempts === 1) response.writeHead(503).end('temporarily-offline');
          else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ batchId: batch.batchId, recordIds: batch.records.map(row => row.id) }));
        } catch { response.writeHead(400).end('invalid-batch'); }
      }); return;
    }
    if (path === '/') response.writeHead(200, { 'content-type': 'text/html' }).end(html);
    else if (path === '/fixture.mjs') response.writeHead(200, { 'content-type': 'text/javascript' }).end(fixture);
    else if (path === '/favicon.ico') response.writeHead(204).end();
    else if (served.has(path)) response.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(served.get(path)));
    else response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address(), baseURL = 'http://127.0.0.1:' + address.port;
  const result = { schemaVersion: 1, kind: 'local-native-indexeddb', consumer, installed,
    tool: { path: fileURLToPath(import.meta.url), sha256: hash(fileURLToPath(import.meta.url)) },
    server: { bind: '127.0.0.1', port: address.port, closed: false }, checks };
  try {
    const playwright = await import('playwright');
    for (const engine of engines) {
      assert.ok(['chromium', 'firefox', 'webkit'].includes(engine));
      let browser, context; const pageErrors = [];
      try {
        recipient.attempts = 0; received.length = 0;
        browser = await playwright[engine].launch({ headless: true, timeout: 30000 }); context = await browser.newContext();
        await context.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort('blockedbyclient'));
        const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
        assert.equal((await page.goto(baseURL))?.status(), 200);
        const call = (target, method, ...args) => target.evaluate(async ({ method, args }) => (await import('/fixture.mjs'))[method](...args), { method, args });
        const suffix = engine + '-' + Date.now();
        const proof = { ...await call(page, 'setup', 'telemetry-history-' + suffix), ...await call(page, 'offlineUpload') };
        assert.equal(recipient.attempts, 2); assert.equal(received[0].batchId, received[1].batchId); assert.deepEqual(received[0].ids, received[1].ids);
        Object.assign(proof, await call(page, 'isolationAndCorruption'));
        const other = await context.newPage(); other.on('pageerror', error => pageErrors.push(error.message)); await other.goto(baseURL);
        const concurrentName = 'telemetry-concurrent-' + suffix;
        await Promise.all([call(page, 'prepareConcurrent', concurrentName), call(other, 'prepareConcurrent', concurrentName)]);
        const commits = await Promise.all([call(page, 'concurrentCommit', 'tab-a:clock'), call(other, 'concurrentCommit', 'tab-b:clock')]);
        assert.ok(commits.every(commit => commit.ok && commit.committed === 2));
        Object.assign(proof, await call(page, 'concurrentRead'), await call(page, 'deleteAndLateAppend'), await call(page, 'lateAck'),
          await call(page, 'expiryAndExample'), await call(page, 'futureDatabase', 'telemetry-future-' + suffix),
          await call(page, 'closeInsideMutation', 'telemetry-close-' + suffix));
        await call(page, 'close'); await call(other, 'close'); assert.deepEqual(pageErrors, []);
        checks.push({ name: 'native-indexeddb:' + engine, status: 'pass', version: browser.version(), ...proof,
          recipient: { offline503ThenAck: true, sameIdempotencyKey: true, selectedFieldsOnly: true, credentialVerified: recipient.credentialVerified } });
      } catch (error) {
        checks.push({ name: 'native-indexeddb:' + engine, status: 'fail', failure: { name: error.name, message: error.message }, pageErrors });
      } finally { await context?.close(); await browser?.close(); }
    }
    result.status = checks.every(check => check.status === 'pass') ? 'pass' : 'fail';
  } finally {
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); result.server.closed = true;
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = mkdtempSync('/tmp/101-telemetry-browser-'), receiptPath = join(output, 'receipt.json');
  let receipt;
  try {
    assert.equal(process.argv.length, 3, 'Usage: node tools/qa-telemetry-history.mjs <installed-consumer-directory>');
    receipt = await runTelemetryHistoryBrowserChecks({ consumerDirectory: process.argv[2] });
    if (receipt.status !== 'pass') process.exitCode = 1;
  } catch (error) { receipt = { status: 'fail', failure: { name: error.name, message: error.message } }; process.exitCode = 1; }
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: receipt.status, receipt: receiptPath, checks: receipt.checks?.map(({ name, status, failure }) => ({ name, status, failure })) }));
}
