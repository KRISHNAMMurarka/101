import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// TESTS-FIRST, UNRUN. This is an actual-app harness, not a substitute UI or SDK.
// The parent owns the server and separately records its real close settlement.
const args = process.argv.slice(2), application = new URL(args.shift());
let proofPath, engine = 'both', engineSeen = false, missingRouteRed = false;
while (args.length) {
  const name = args.shift();
  if (name === '--served-proof' && !proofPath) proofPath = args.shift();
  else if (name === '--engine' && !engineSeen) { engine = args.shift(); engineSeen = true; }
  else if (name === '--missing-route-red' && !missingRouteRed) missingRouteRed = true;
  else throw Error(`Unknown or duplicate argument: ${name}`);
}
assert.equal(process.version, 'v24.14.0', 'Pinned root-owned Node toolchain');
assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
assert.ok(proofPath && ['chromium', 'webkit', 'both'].includes(engine));
assert.ok(application.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(application.hostname)
  && application.pathname === '/' && !application.search && !application.hash, 'Owned exact loopback application origin');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const proofBytes = readFileSync(proofPath), proof = JSON.parse(proofBytes), root = realpathSync(proof.sourceRoot);
assert.equal(proof.origin, application.origin); assert.match(proof.sourceTree, /^[a-f0-9]{40}$/);
assert.ok(['source', 'built'].includes(proof.mode));
const harnessSha256 = hash(readFileSync(fileURLToPath(import.meta.url)));
assert.equal(proof.schemaVersion, 1);
assert.equal(proof.harnessSha256, harnessSha256, 'OLD served bytes and NEW selector harness are separately pinned');
const required = ['app/components/AppShell.tsx', 'app/layout.tsx', 'app/globals.css', 'app/settings/page.tsx', 'app/settings/SettingsView.tsx',
  'app/connections/connections.module.css', 'app/settings/settings.module.css', 'package.json',
  'packages/device-runtime/src/owner-data.ts', 'packages/device-runtime/src/owner-data-storage.ts',
  'packages/device-runtime/src/telemetry-history.ts', 'packages/device-runtime/src/index.ts', 'packages/connect/src/index.ts',
  ...(missingRouteRed ? [] : ['app/settings/history/page.tsx', 'app/settings/history/HistoryView.tsx',
    'app/settings/history/history-task.ts', 'app/settings/history/history-task.test.ts', 'tools/qa-history-settings.mjs'])];
for (const path of required) assert.match(proof.sourcePins?.[path] ?? '', /^[a-f0-9]{64}$/, `Required served input: ${path}`);
if (proof.mode === 'built') {
  assert.equal(proof.fixturePublicSdkEntry, '/software-modules/packages/connect/src/index.ts');
  assert.match(proof.fixtureRecord?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(hash(readFileSync(proof.fixtureRecord.path)), proof.fixtureRecord.sha256, 'Owned current SDK seed graph');
}
const pins = Object.entries(proof.sourcePins ?? {}); assert.ok(pins.length >= required.length && pins.length <= 4096);
let sourceBytes = 0;
for (const [path, sha256] of pins) {
  assert.ok(/^[A-Za-z0-9._/-]+$/.test(path) && !path.startsWith('/') && !path.split('/').includes('..'));
  assert.match(sha256, /^[a-f0-9]{64}$/); const resolved = realpathSync(resolve(root, path));
  assert.ok(!relative(root, resolved).startsWith('..') && !relative(root, resolved).startsWith('/'));
  const bytes = readFileSync(resolved); sourceBytes += bytes.byteLength; assert.ok(sourceBytes <= 64 * 1024 * 1024);
  assert.equal(hash(bytes), sha256, `Current served source: ${path}`);
}
// One bounded immutable blob batch, not hundreds of per-file native Git forks.
const batch = execFileSync('git', ['cat-file', '--batch'], { cwd: root, timeout: 5000, maxBuffer: 64 * 1024 * 1024,
  input: Buffer.from(pins.map(([path]) => `${proof.sourceTree}:${path}\n`).join('')) });
let offset = 0;
for (const [path, sha256] of pins) {
  const end = batch.indexOf(10, offset); assert.ok(end >= offset);
  const header = batch.subarray(offset, end).toString('ascii'), match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(header);
  assert.ok(match, `Immutable blob exists: ${path}`); const size = Number(match[2]);
  assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 2 * 1024 * 1024);
  offset = end + 1; const bytes = batch.subarray(offset, offset + size); assert.equal(bytes.byteLength, size);
  assert.equal(hash(bytes), sha256, `Immutable served source: ${path}`); offset += size; assert.equal(batch[offset++], 10);
}
assert.equal(offset, batch.byteLength);
const buildInputs = proof.mode === 'built' ? proof.buildInputs : [];
if (proof.mode === 'built') assert.ok(Array.isArray(buildInputs) && buildInputs.length >= 2 && buildInputs.length <= 2048);
if (proof.mode === 'built') {
  assert.ok(proof.buildRecord && typeof proof.buildRecord.path === 'string');
  assert.match(proof.buildRecord.sha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(readFileSync(proof.buildRecord.path)), proof.buildRecord.sha256, 'Actual build record');
}
let buildBytes = 0; const buildPaths = new Set();
for (const item of buildInputs) {
  assert.ok(item && ['server', 'client'].includes(item.kind)); assert.match(item.sha256, /^[a-f0-9]{64}$/);
  const path = realpathSync(item.path), rel = relative(root, path);
  assert.ok(!rel.startsWith('..') && !rel.startsWith('/') && rel.startsWith(`dist/${item.kind}/`));
  assert.equal(buildPaths.has(path), false); buildPaths.add(path);
  const bytes = readFileSync(path); buildBytes += bytes.byteLength; assert.ok(buildBytes <= 64 * 1024 * 1024);
  assert.equal(hash(bytes), item.sha256, 'Actual immutable built input');
}
const require = createRequire(join(root, 'package.json')), { chromium, webkit } = require('playwright');
const databaseName = 'app-player-history-managed-v1', ownerId = 'app-player-history:this-browser', otherOwner = 'history-other-owner';
const viewport = 'browser-page:viewport', scroll = 'browser-page:scroll';
const engines = engine === 'both' ? ['chromium', 'webkit'] : [engine], results = [];
const artifactDirectory = mkdtempSync('/tmp/101-history-settings-'); chmodSync(artifactDirectory, 0o700);
let failure;

for (const selectedEngine of engines) {
  let browser, context, version, phase = 'prelaunch'; const pages = [], errors = [], foreign = [], checks = [], keyboard = [], diagnostics = [], screenshots = [];
  const engineArtifacts = join(artifactDirectory, selectedEngine); mkdirSync(engineArtifacts);
  const cleanup = { pagesClosed: false, contextCloseAwaited: false, browserCloseAwaited: false, browserClosed: false, ownedFixtureHandlesReleased: false };
  const main = page => page.locator('main[data-history-page]');
  async function nativeActivate(page, name, awaitAction = true) {
    const target = main(page).getByRole('button', { name, exact: true }); await target.click({ trial: true });
    const key = selectedEngine === 'webkit' ? 'Alt+Tab' : 'Tab';
    // Established owned-QA document entry: seed the real application link when
    // native traversal would otherwise begin at an unfocused BODY/browser rail.
    // The target still requires actual native traversal and :focus-visible.
    if (!await page.evaluate(() => document.hasFocus() && document.activeElement !== document.body)) {
      await main(page).getByRole('link', { name: 'Back to Settings', exact: true }).focus();
    }
    for (let step = 0; step <= 32; step++) {
      if (await target.evaluate(element => document.hasFocus() && document.activeElement === element && element.matches(':focus-visible'))) {
        keyboard.push({ name, key, step }); await page.keyboard.press('Space');
        if (awaitAction && name.startsWith('Allow ')) await page.waitForFunction(() => {
          const panel = document.querySelector('main[data-history-page]');
          return panel && [...panel.querySelectorAll('button')].some(button => button.matches(':enabled') &&
            ['Manage history', 'Export selected history', 'Resume selected removal'].includes(button.textContent.trim()));
        }, undefined, { timeout: 6000 });
        return;
      }
      if (step < 32) await page.keyboard.press(key);
    }
    throw Error(`Native current keyboard target not reached: ${name}`);
  }
  async function choose(page, name, value) {
    await main(page).getByRole('combobox', { name, exact: true }).selectOption(value);
    // Resource selection performs an approved SDK read. Wait for that actual
    // operation before taking a decline-preservation baseline; its trusted
    // monotonic metadata can advance while the read is still settling.
    if (name === 'Saved resource') await main(page).getByRole('button', { name: 'Record page measurements', exact: true }).click({ trial: true });
  }
  async function status(page, text, timeout = 6000) { await main(page).getByRole('status').filter({ hasText: text }).waitFor({ state: 'visible', timeout }); }
  async function manage(page) {
    await nativeActivate(page, 'Manage history'); await nativeActivate(page, 'Allow management for 30 seconds');
    await main(page).getByRole('combobox', { name: 'Saved resource', exact: true }).waitFor({ state: 'visible' });
    await main(page).getByRole('status').filter({ hasText: /Saved history is ready to inspect|Removal needs fresh review/ }).waitFor({ state: 'visible' });
  }
  async function capture(page, resourceId, retention = '60000') {
    await choose(page, 'Saved resource', resourceId); await choose(page, 'Keep data for', retention);
    await nativeActivate(page, 'Record page measurements'); await nativeActivate(page, 'Allow collection');
    await main(page).getByRole('button', { name: 'Stop collection', exact: true }).click({ trial: true });
  }
  async function read(page, selectedOwner = ownerId) {
    return page.evaluate(({ databaseName, selectedOwner }) => new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1); request.onerror = () => reject(Error('owned-history-read'));
      request.onsuccess = () => {
        const database = request.result, transaction = database.transaction('owners', 'readonly'), get = transaction.objectStore('owners').get(selectedOwner);
        let value; get.onsuccess = () => { value = get.result; };
        transaction.oncomplete = () => { database.close(); resolve(value); };
        transaction.onabort = () => { database.close(); reject(Error('owned-history-read')); };
      };
    }), { databaseName, selectedOwner });
  }
  async function waitRows(page, resourceId, count, accepted = () => true) {
    // This owned raw read neither updates the SDK's trusted clock nor sweeps.
    const end = Date.now() + 2500;
    for (;;) {
      const record = await read(page), rows = record?.records?.telemetry?.rows?.filter(row => row.resourceId === resourceId) ?? [];
      if (rows.length >= count && accepted(rows)) return rows;
      if (Date.now() >= end) throw Error(`Actual native rows did not reach ${count} for ${resourceId}`);
      await page.waitForTimeout(50);
    }
  }
  async function goto(path = '/settings/history') {
    const page = await context.newPage(); pages.push(page); page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(new URL(path, application).toString(), { waitUntil: 'networkidle', timeout: 10000 });
    return { page, status: response?.status() };
  }
  async function rawZero(page) { await page.waitForFunction(() => globalThis.__historyNative.rawOpen === 0 && globalThis.__historyNative.rawTransactions === 0, undefined, { timeout: 6000 }); }
  try {
    browser = await (selectedEngine === 'chromium' ? chromium : webkit).launch({ headless: true }); version = browser.version();
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', acceptDownloads: true });
    context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(10000);
    await context.route('**/*', route => new URL(route.request().url()).origin === application.origin
      ? route.continue() : (foreign.push(route.request().url()), route.abort()));
    await context.addInitScript(({ databaseName, ownerId }) => {
      const metrics = { opens: 0, rawOpen: 0, transactions: 0, rawTransactions: 0, nativeDeviceCalls: 0,
        windowListeners: { resize: 0, scroll: 0 }, windowEvents: { resize: 0, scroll: 0 }, queuedStopOnPut: false, queuedStops: 0 };
      globalThis.__historyNative = metrics;
      const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
      const registrations = new Map();
      Object.defineProperty(EventTarget.prototype, 'addEventListener', { configurable: true, writable: true, value(type, callback, options) {
        if (this !== window || !['resize', 'scroll'].includes(type) || callback == null) return add.call(this, type, callback, options);
        const capture = typeof options === 'boolean' ? options : !!options?.capture;
        let items = registrations.get(callback); if (!items) { items = []; registrations.set(callback, items); }
        let item = items.find(value => value.type === type && value.capture === capture);
        if (!item) {
          item = { type, capture, wrapped(event) { metrics.windowEvents[type]++; return typeof callback === 'function'
            ? callback.call(window, event) : callback.handleEvent(event); } }; items.push(item); metrics.windowListeners[type]++;
        }
        return add.call(this, type, item.wrapped, options);
      } });
      Object.defineProperty(EventTarget.prototype, 'removeEventListener', { configurable: true, writable: true, value(type, callback, options) {
        if (this !== window || !['resize', 'scroll'].includes(type) || callback == null) return remove.call(this, type, callback, options);
        const capture = typeof options === 'boolean' ? options : !!options?.capture, items = registrations.get(callback);
        const item = items?.find(value => value.type === type && value.capture === capture);
        if (item) { items.splice(items.indexOf(item), 1); metrics.windowListeners[type]--; return remove.call(this, type, item.wrapped, options); }
        return remove.call(this, type, callback, options);
      } });
      const nativeOpen = IDBFactory.prototype.open, nativeTransaction = IDBDatabase.prototype.transaction, nativePut = IDBObjectStore.prototype.put;
      Object.defineProperty(IDBFactory.prototype, 'open', { configurable: true, writable: true, value(name, ...rest) {
        if (name !== databaseName) return nativeOpen.call(this, name, ...rest);
        metrics.opens++; metrics.rawOpen++; let request;
        try { request = nativeOpen.call(this, name, ...rest); } catch (error) { metrics.rawOpen--; throw error; }
        const settle = () => { metrics.rawOpen--; remove.call(request, 'success', settle); remove.call(request, 'error', settle); };
        add.call(request, 'success', settle); add.call(request, 'error', settle); return request;
      } });
      Object.defineProperty(IDBDatabase.prototype, 'transaction', { configurable: true, writable: true, value(...args) {
        if (this.name !== databaseName) return Reflect.apply(nativeTransaction, this, args);
        metrics.transactions++; metrics.rawTransactions++; let transaction;
        try { transaction = Reflect.apply(nativeTransaction, this, args); } catch (error) { metrics.rawTransactions--; throw error; }
        const settle = () => { metrics.rawTransactions--; remove.call(transaction, 'complete', settle); remove.call(transaction, 'abort', settle); };
        add.call(transaction, 'complete', settle); add.call(transaction, 'abort', settle); return transaction;
      } });
      Object.defineProperty(IDBObjectStore.prototype, 'put', { configurable: true, writable: true, value(...args) {
        const request = Reflect.apply(nativePut, this, args);
        if (this.transaction.db.name === databaseName && args[1] === ownerId && metrics.queuedStopOnPut) {
          metrics.queuedStopOnPut = false;
          // Explicit trusted software lifecycle trigger after a genuine native
          // queued put. The real transaction abort/absence is the IDB evidence;
          // this is not a native user or hardware pagehide claim.
          queueMicrotask(() => { metrics.queuedStops++; window.dispatchEvent(new Event('pagehide')); });
        }
        return request;
      } });
      if (navigator.mediaDevices) for (const name of ['getUserMedia', 'getDisplayMedia']) if (typeof navigator.mediaDevices[name] === 'function') {
        Object.defineProperty(navigator.mediaDevices, name, { value() { metrics.nativeDeviceCalls++; throw Error('Device acquisition prohibited by owned fixture'); } });
      }
    }, { databaseName, ownerId });
    phase = 'arrival'; const arrived = await goto(), a = arrived.page;
    const arrival = { status: arrived.status, heading: await a.getByRole('heading', { name: 'History on this browser', exact: true }).count(),
      manage: await a.getByRole('button', { name: 'Manage history', exact: true }).count(), native: await a.evaluate(() => globalThis.__historyNative) };
    diagnostics.push({ phase, arrival });
    if (missingRouteRed) {
      assert.equal(arrival.native.opens, 0); assert.equal(arrival.native.nativeDeviceCalls, 0);
      const prerequisite = await goto('/settings'); assert.equal(prerequisite.status, 200, 'Existing actual Settings route prerequisite');
      assert.equal(await prerequisite.page.getByRole('heading', { name: 'Settings', exact: true }).count(), 1);
      process.stderr.write(`${JSON.stringify({ phase: 'actual-old-history-route', arrival, sourceTree: proof.sourceTree, sourceProducers: 0 })}\n`);
      assert.equal(arrival.status, 200, 'Missing /settings/history route is the selected feature absence');
      assert.equal(arrival.heading, 1, 'Missing history management heading is the selected feature absence');
      assert.equal(arrival.manage, 1, 'Missing history management action is the selected feature absence');
      throw Error('OLD history feature absence did not reproduce');
    }
    assert.equal(arrival.status, 200); assert.equal(arrival.heading, 1); assert.equal(arrival.manage, 1);
    assert.equal(arrival.native.opens, 0); assert.equal(arrival.native.transactions, 0); assert.equal(arrival.native.nativeDeviceCalls, 0);
    const listenerBaseline = arrival.native.windowListeners; checks.push('inert-history-arrival-no-native-storage-or-capture');
    await nativeActivate(a, 'Manage history'); await nativeActivate(a, 'Cancel');
    assert.equal(await a.evaluate(() => globalThis.__historyNative.opens), 0); checks.push('declined-management-native-open0');

    phase = 'native-consent-and-geometry'; await manage(a);
    assert.equal(await main(a).getByRole('button', { name: 'Stop collection', exact: true }).count(), 0);
    assert.equal((await read(a)).records.telemetry, undefined);
    await nativeActivate(a, 'Record page measurements'); await nativeActivate(a, 'Cancel');
    assert.equal((await read(a)).records.telemetry, undefined); checks.push('management-not-capture-and-declined-capture-no-records');
    await capture(a, viewport); const initialViewport = await waitRows(a, viewport, 1);
    await a.setViewportSize({ width: 420, height: 844 }); const viewportRows = await waitRows(a, viewport, 2);
    assert.equal(viewportRows.at(-1).values.width, 420); assert.equal(viewportRows.at(-1).quality, 'observed');
    assert.ok(viewportRows.every(row => row.resourceId === viewport && Number.isFinite(row.sourceTime.at) && typeof row.sourceTime.clockId === 'string'
      && row.expiresAt > row.ingestedAt && row.expiresAt <= row.ingestedAt + 30000));
    assert.notDeepEqual(viewportRows.at(-1).values, initialViewport[0].values);
    await capture(a, scroll); await waitRows(a, scroll, 1);
    await a.setViewportSize({ width: 420, height: 350 });
    await nativeActivate(a, 'Stop collection'); await capture(a, scroll);
    await a.keyboard.press('Escape'); await a.keyboard.press('PageDown');
    const scrollRows = await waitRows(a, scroll, 2, rows => rows.some(row => row.values.top > 0));
    assert.ok(scrollRows.some(row => row.values.top > 0), 'Actual owned native page scroll must change the observed value');
    await nativeActivate(a, 'Stop collection'); await rawZero(a); checks.push('actual-viewport-and-scroll-observations-no-hardware-clock-claim');

    phase = 'selected-export-and-copies'; await choose(a, 'Saved resource', viewport);
    const beforeExport = await read(a); await nativeActivate(a, 'Export selected history'); await nativeActivate(a, 'Cancel');
    assert.deepEqual((await read(a)).records.telemetry, beforeExport.records.telemetry); checks.push('declined-export-preserves-current-native-records');
    const downloadWork = a.waitForEvent('download', { timeout: 6000 }); await nativeActivate(a, 'Export selected history'); await nativeActivate(a, 'Allow download');
    const download = await downloadWork, downloadPath = await download.path(); assert.ok(downloadPath);
    const downloadBytes = readFileSync(downloadPath); assert.ok(downloadBytes.byteLength <= 262144);
    const exported = JSON.parse(downloadBytes.toString('utf8'));
    assert.ok(Array.isArray(exported.records) && exported.records.length >= 2 && exported.records.length <= 128);
    assert.ok(exported.records.every(row => row.resourceId === viewport && Object.keys(row.values).sort().join(',') === 'height,width'));
    for (const row of exported.records) {
      const original = beforeExport.records.telemetry.rows.find(original => original.id === row.id); assert.ok(original);
      const fields = ['id', 'resourceId', 'schemaVersion', 'sourceTime', 'quality', 'ingestedAt', 'expiresAt', 'values'];
      assert.deepEqual(Object.keys(row).sort(), [...fields].sort(), 'Public export never includes the stored private schema');
      for (const field of fields) assert.deepEqual(row[field], original[field], `Original public record field: ${field}`);
    }
    assert.equal(downloadBytes.includes(Buffer.from('history-owner-private-qa-sentinel')), false); await download.delete();
    checks.push('actual-selected-download-original-source-quality-ttl-closed-fields');
    // Public SDK fixture entry only, from the exact pinned current source graph. Genuine
    // public export/copy/settings producers seed owned auxiliary records, not a
    // static catalog or hidden runtime import. No browser-wide store scanning.
    const copyProof = await a.evaluate(async ({ databaseName, ownerId, otherOwner, viewport, sdkEntry }) => {
      const sdk = await import(sdkEntry), storage = sdk.createIndexedDbOwnerDataStorage({ databaseName });
      const authority = new AbortController(), sentinel = 'history-owner-private-qa-sentinel';
      const owner = sdk.createOwnerDataController({ ownerId, storage, trustedNow: Date.now, authorize: scope => {
        if (!sentinel) throw Error('fixture-closure'); return { scope, expiresAt: scope.deadline, signal: authority.signal, isCurrent: () => !authority.signal.aborted };
      } });
      const foreign = sdk.createOwnerDataController({ ownerId: otherOwner, storage, trustedNow: Date.now,
        authorize: scope => ({ scope, expiresAt: scope.deadline, signal: authority.signal, isCurrent: () => !authority.signal.aborted }) });
      try {
        const page = await owner.exportPage({ kind: 'telemetry', resourceId: viewport, purpose: 'owned-browser-copy-seed', destinationId: 'owned-browser-download' });
        if (!page.ok || page.value.records.length === 0) throw Error('actual-copy-seed');
        const copied = await owner.storeLocalTelemetryCopy({ batchId: 'owned-browser-viewport-copy', records: page.value.records.slice(0, 1) },
          { purpose: 'owned-browser-copy-seed', destinationId: 'local-recipient' }); if (!copied.ok) throw Error('actual-copy-register');
        const opened = await foreign.openStores({ retireOwned() {} }); if (!opened.ok) throw Error('actual-foreign-open');
        const settings = sdk.createSettingsStore({ ownerId: otherOwner, storage: opened.value.settings, availableDevices: () => [] });
        if (!(await settings.save(0, { preferences: { theme: 'dark', handedness: 'left', motion: 'reduce' }, profiles: [] })).ok) throw Error('actual-foreign-settings');
        opened.value.close(); return { copied: copied.value.copied, original: page.value.records[0] };
      } finally { authority.abort(); owner.close(); foreign.close(); storage.close(); }
    }, { databaseName, ownerId, otherOwner, viewport, sdkEntry: proof.fixturePublicSdkEntry ?? '/packages/connect/src/index.ts' });
    assert.equal(copyProof.copied, 1); await rawZero(a);
    const beforeRemoval = await read(a), otherBefore = await read(a, otherOwner), retained = beforeRemoval.records.telemetry.rows.filter(row => row.resourceId === scroll);
    phase = 'selected-delete-and-fresh-resume'; await nativeActivate(a, 'Remove selected history'); await nativeActivate(a, 'Cancel');
    assert.deepEqual((await read(a)).records.telemetry, beforeRemoval.records.telemetry);
    await nativeActivate(a, 'Remove selected history'); await nativeActivate(a, 'Allow removal'); await status(a, 'Removal needs fresh review');
    assert.equal((await read(a)).deletion.telemetryResourceId, viewport);
    await nativeActivate(a, 'Stop management'); await rawZero(a); await a.reload({ waitUntil: 'networkidle' });
    assert.equal(await main(a).getByRole('button', { name: 'Resume selected removal', exact: true }).count(), 0);
    await manage(a); await status(a, 'Removal needs fresh review');
    const pendingBefore = (await read(a)).deletion; await nativeActivate(a, 'Resume selected removal'); await nativeActivate(a, 'Cancel');
    assert.deepEqual((await read(a)).deletion, pendingBefore);
    for (let step = 0; step < 2; step++) { await nativeActivate(a, 'Resume selected removal'); await nativeActivate(a, 'Allow next removal step'); }
    await status(a, 'Selected history removed'); const afterRemoval = await read(a);
    assert.equal(afterRemoval.deletion.state, 'completed'); assert.equal(Object.hasOwn(afterRemoval.deletion, 'telemetryResourceId'), false);
    assert.deepEqual(afterRemoval.records.telemetry.rows, retained); assert.equal(afterRemoval.copies.length, 0);
    assert.deepEqual(await read(a, otherOwner), otherBefore);
    const audit = afterRemoval.audit.find(row => row.action === 'deletion'); assert.ok(audit);
    assert.deepEqual(Object.keys(audit).sort(), ['action', 'at', 'expiresAt', 'kinds', 'operationId', 'removed', 'state']);
    assert.equal(audit.removed.copies, 1); assert.equal(audit.expiresAt, audit.at + 30 * 86400000);
    assert.equal(JSON.stringify(afterRemoval).includes('history-owner-private-qa-sentinel'), false);
    checks.push('actual-selected-delete-copies-isolation-redacted-audit-restart-fresh-resume');

    phase = 'original-retention-expiry'; await manage(a); await capture(a, viewport, '15000');
    const ttlRows = await waitRows(a, viewport, 1); const originalExpiry = ttlRows[0].expiresAt; assert.equal(originalExpiry, ttlRows[0].ingestedAt + 15000);
    await nativeActivate(a, 'Stop collection');
    const remaining = originalExpiry - await a.evaluate(() => Date.now()); if (remaining > 0) await a.waitForTimeout(remaining + 20);
    const dormant = await read(a); assert.ok(dormant.records.telemetry.rows.some(row => row.id === ttlRows[0].id), 'No autonomous background deletion claim');
    await nativeActivate(a, 'Remove expired history'); await nativeActivate(a, 'Allow expiry cleanup');
    assert.equal((await read(a)).records.telemetry.rows.some(row => row.id === ttlRows[0].id), false);
    assert.ok((await read(a)).audit.some(row => row.action === 'expiry' && row.expiresAt === row.at + 30 * 86400000));
    await nativeActivate(a, 'Stop management'); await rawZero(a); checks.push('actual-original-15s-retention-dormant-until-reviewed-sweep');

    phase = 'native-queued-commit-abort'; await manage(a); await capture(a, viewport); await waitRows(a, viewport, 1);
    const beforeQueued = await read(a); await a.evaluate(() => { globalThis.__historyNative.queuedStopOnPut = true; });
    await a.setViewportSize({ width: 430, height: 350 });
    await a.waitForFunction(() => globalThis.__historyNative.queuedStops === 1, undefined, { timeout: 2500 });
    await rawZero(a); await status(a, 'Management stopped');
    assert.deepEqual((await read(a)).records.telemetry, beforeQueued.records.telemetry);
    checks.push('genuine-native-idb-queued-put-aborted-by-explicit-software-lifecycle-trigger');

    phase = 'quiet-absolute-collection-and-management-expiry'; await manage(a);
    const previousQuietRows = (await read(a)).records.telemetry?.rows?.filter(row => row.resourceId === viewport).length ?? 0;
    await capture(a, viewport); await waitRows(a, viewport, previousQuietRows + 1);
    await rawZero(a); const quietBefore = await a.evaluate(() => ({ transactions: globalThis.__historyNative.transactions,
      events: { ...globalThis.__historyNative.windowEvents } }));
    await status(a, 'Management ended after 30 seconds', 31000); await rawZero(a);
    const quietAfter = await a.evaluate(() => ({ transactions: globalThis.__historyNative.transactions,
      events: { ...globalThis.__historyNative.windowEvents }, listeners: { ...globalThis.__historyNative.windowListeners } }));
    assert.equal(quietAfter.transactions, quietBefore.transactions); assert.deepEqual(quietAfter.events, quietBefore.events);
    assert.deepEqual(quietAfter.listeners, listenerBaseline); checks.push('quiet-original-30s-expiry-retires-capture-no-events-or-storage-work');

    phase = 'native-blocked-open-true-settlement';
    await a.evaluate(({ databaseName }) => new Promise((resolve, reject) => {
      const opening = indexedDB.open(databaseName, 1); opening.onerror = () => reject(Error('owned-blocker'));
      opening.onsuccess = () => {
        globalThis.__historyBlocker = opening.result; const deletion = indexedDB.deleteDatabase(databaseName);
        globalThis.__historyDelete = deletion; deletion.onerror = () => reject(Error('owned-blocked-delete')); deletion.onblocked = () => resolve(true);
      };
    }), { databaseName });
    await nativeActivate(a, 'Manage history'); await nativeActivate(a, 'Allow management for 30 seconds', false);
    await a.waitForFunction(() => globalThis.__historyNative.rawOpen === 1, undefined, { timeout: 6000 });
    await nativeActivate(a, 'Stop management'); const retainedOpens = await a.evaluate(() => globalThis.__historyNative.opens);
    assert.equal(await main(a).getByRole('button', { name: 'Manage history', exact: true }).isEnabled(), false);
    await a.waitForTimeout(5100); assert.equal(await a.evaluate(() => globalThis.__historyNative.rawOpen), 1);
    assert.equal(await a.evaluate(() => globalThis.__historyNative.opens), retainedOpens);
    assert.equal(await main(a).getByRole('button', { name: 'Manage history', exact: true }).isEnabled(), false);
    await a.evaluate(() => globalThis.__historyBlocker.close()); await rawZero(a);
    await main(a).getByRole('button', { name: 'Manage history', exact: true }).click({ trial: true });
    checks.push('actual-native-open-reserved-beyond-fixed-5s-refusal-until-native-terminal');

    phase = 'theme-focus-unmount';
    for (const theme of ['dark', 'light']) {
      await a.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme); // Owned theme setup, not a synthetic focus/style positive.
      const target = main(a).getByRole('button', { name: 'Manage history', exact: true });
      await nativeActivate(a, 'Manage history'); await nativeActivate(a, 'Cancel');
      const focus = await target.evaluate(element => ({ active: document.hasFocus() && document.activeElement === element,
        visible: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle,
        outlinePx: parseFloat(getComputedStyle(element).outlineWidth), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
      assert.equal(focus.active, true); assert.equal(focus.visible, true); assert.notEqual(focus.outline, 'none'); assert.ok(focus.outlinePx >= 2);
      assert.ok(focus.width >= 44 && focus.height >= 44); diagnostics.push({ phase, theme, focus });
      const screenshot = join(engineArtifacts, `history-${theme}.png`); await a.screenshot({ path: screenshot, fullPage: true });
      const bytes = readFileSync(screenshot); assert.ok(bytes.byteLength <= 2 * 1024 * 1024); screenshots.push({ path: screenshot, sha256: hash(bytes) });
    }
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await manage(a); await capture(a, viewport); await waitRows(a, viewport, 1);
    await a.goto(new URL('/settings', application).toString(), { waitUntil: 'networkidle' }); await rawZero(a);
    assert.deepEqual(await a.evaluate(() => globalThis.__historyNative.windowListeners), listenerBaseline);
    checks.push('actual-two-theme-native-focus-44px-reduced-motion-narrow-and-unmount-release');
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
    for (const page of pages) assert.equal(await page.evaluate(() => globalThis.__historyNative.nativeDeviceCalls), 0);
    for (const [path, sha256] of pins) assert.equal(hash(readFileSync(resolve(root, path))), sha256, `Served input stayed fixed: ${path}`);
    for (const item of buildInputs) assert.equal(hash(readFileSync(item.path)), item.sha256, 'Literal build stayed fixed');
    if (proof.mode === 'built') assert.equal(hash(readFileSync(proof.buildRecord.path)), proof.buildRecord.sha256, 'Build record stayed fixed');
  } catch (error) {
    failure = error; diagnostics.push({ phase, error: String(error) });
    for (const page of pages) if (!page.isClosed()) {
      try { diagnostics.push({ phase: 'failure-readback', native: await page.evaluate(() => globalThis.__historyNative),
        status: await main(page).getByRole('status').allTextContents(), url: page.url() }); } catch { /* Retain the original failure. */ }
    }
    if (pages[0] && !pages[0].isClosed()) {
      try {
        const path = join(engineArtifacts, 'first-failure.png'); await pages[0].screenshot({ path, fullPage: true });
        const bytes = readFileSync(path); if (bytes.byteLength <= 2 * 1024 * 1024) screenshots.push({ path, sha256: hash(bytes) });
      } catch { /* Preserve the original failure. */ }
    }
  } finally {
    const cleanupErrors = [];
    for (const page of pages) if (!page.isClosed()) {
      try {
        await page.evaluate(() => { globalThis.__historyBlocker?.close(); window.dispatchEvent(new Event('pagehide')); });
        await rawZero(page);
      } catch (error) { cleanupErrors.push(`Owned native terminal unavailable before page exit: ${String(error)}`); }
    }
    cleanup.ownedFixtureHandlesReleased = cleanupErrors.length === 0;
    for (const page of pages) { try { if (!page.isClosed()) await page.close(); } catch (error) { cleanupErrors.push(String(error)); } }
    cleanup.pagesClosed = pages.every(page => page.isClosed());
    try { if (context) { await context.close(); cleanup.contextCloseAwaited = true; } } catch (error) { cleanupErrors.push(String(error)); }
    try { if (browser) { await browser.close(); cleanup.browserCloseAwaited = !browser.isConnected(); cleanup.browserClosed = cleanup.browserCloseAwaited; } } catch (error) { cleanupErrors.push(String(error)); }
    if (cleanupErrors.length && !failure) failure = Error('Actual owned cleanup did not confirm all native terminal events');
    const result = { status: failure ? 'fail' : 'pass', profile: 'browser-local-history-privacy/1', engine: selectedEngine, version, phase,
      sourceTree: proof.sourceTree, servedMode: proof.mode, sourcePins: proof.sourcePins, servedProofSha256: hash(proofBytes), harnessSha256,
      checks, keyboard, diagnostics, screenshots, artifactDirectory, errors, foreign, cleanup, cleanupErrors,
      scope: 'Selected owned native browser IndexedDB and page-geometry observations; software-triggered queued abort separately labeled. No account, browser-wide privacy, external deletion, device, hardware or whole U12/B05 closure.',
      cleanupTrigger: 'Explicit trusted software pagehide finalizer plus real request/transaction terminal events and awaited page/context/browser exit',
      parentServerSettlement: 'Parent-owned, separately required; not measured by this child', browserInternalResources: 'not measured' };
    results.push(result); process.stderr.write(`${JSON.stringify(result)}\n`);
  }
  if (failure) break; // No blind second-engine retry after a first failed journey.
}
process.stdout.write(`${JSON.stringify({ status: failure ? 'fail' : 'pass', results })}\n`);
if (failure) throw failure;
