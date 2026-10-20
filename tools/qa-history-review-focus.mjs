import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';

const [engine, proofPath, selection, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert.ok(['chromium', 'webkit'].includes(engine));
assert.ok(selection === undefined || selection === '--cancel-only');
const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function changedFields(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [{ path, before, after }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => changedFields(before[key], after[key], path ? `${path}.${key}` : key));
}
const proof = JSON.parse(readFileSync(proofPath));
assert.equal(proof.profile, 'history-review-focus-preserved-build/1');
assert.match(proof.builtSourceTree, /^[a-f0-9]{40}$/);
assert.equal(hash(readFileSync(proof.buildProvenance.path)), proof.buildProvenance.sha256);
const recordedBuild = JSON.parse(readFileSync(proof.buildProvenance.path));
assert.equal(recordedBuild.tree, proof.builtSourceTree);
assert.equal(recordedBuild.exitCode, 0);
assert.deepEqual(proof.artifactPins, recordedBuild.artifactPins);
assert.ok(Object.keys(proof.artifactPins).length > 10);
assert.ok(proof.artifactPins[resolve(root, 'dist/server/index.js')]);
assert.ok(Object.keys(proof.artifactPins).some(path => /\/dist\/client\/.*HistoryView-.*\.js$/.test(path)));
for (const path of ['app/settings/history/HistoryView.tsx', 'app/settings/history/history-task.ts', 'app/settings/history/page.tsx', 'packages/device-runtime/src/owner-data.ts', 'packages/device-runtime/src/owner-data-storage.ts']) assert.ok(proof.sourcePins[path]);
for (const [path, pin] of Object.entries(proof.sourcePins)) {
  assert.equal(hash(execFileSync('git', ['show', `${proof.builtSourceTree}:${path}`], { cwd: root })), pin, path);
}
function verifyPins() {
  for (const [path, pin] of Object.entries(proof.sourcePins)) assert.equal(hash(readFileSync(resolve(root, path))), pin, `Source drift: ${path}`);
  for (const [path, pin] of Object.entries(proof.artifactPins)) assert.equal(hash(readFileSync(path)), pin, `Build drift: ${path}`);
}
verifyPins();
const database = 'app-player-history-managed-v1';
const owner = 'app-player-history:this-browser';
const checks = [], observations = [], errors = [], remote = [];
let app, browser, context, page, failure, version;
const cleanup = { nativePending: null, databaseRemoved: false, pagesClosed: false, contextClosed: false, browserClosed: false, serverClosed: false };
async function focusReceipt(phase) {
  observations.push(await page.evaluate(phase => ({ phase, active: { tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 180) }, status: document.querySelector('[data-history-page] [role="status"]')?.textContent, focused: document.hasFocus(), hidden: document.hidden, trace: globalThis.__historyFocus.trace.slice(-24), native: { ...globalThis.__historyFocus.native } }), phase));
}
async function keyboard(target) {
  await page.bringToFront();
  for (let count = 0; count <= 40; count++) {
    if (await target.evaluate(element => document.hasFocus() && document.activeElement === element && element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none')) return;
    if (count < 40) {
      const reverse = await target.evaluate(element => document.activeElement !== document.body && !!(element.compareDocumentPosition(document.activeElement) & Node.DOCUMENT_POSITION_FOLLOWING));
      await page.keyboard.press(engine === 'webkit' ? reverse ? 'Alt+Shift+Tab' : 'Alt+Tab' : reverse ? 'Shift+Tab' : 'Tab');
    }
  }
  throw Error('Native keyboard did not reach the History control with visible focus');
}
const button = name => page.getByRole('button', { name, exact: true });
async function activate(name, input) {
  const target = button(name);
  if (input === 'keyboard') { await keyboard(target); await page.keyboard.press('Enter'); }
  else await target.click();
}
async function returned(name) {
  await page.waitForFunction(name => [...document.querySelectorAll('button')].some(element => element.textContent === name && !element.disabled && document.activeElement === element), name, { timeout: 6000 });
}
async function arrive() {
  const response = await page.goto(`${app.origin}/settings/history`, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  await button('Manage history').waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.__historyFocus.native), { opens: 0, transactions: 0, puts: 0, pending: 0 });
}
async function record(value, write = false) {
  return page.evaluate(({ database, owner, value, write }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onerror = () => reject(Error('History fixture open failed'));
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('owners', write ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('owners'), operation = write ? store.put(value, owner) : store.get(owner);
      let result; operation.onsuccess = () => { result = operation.result; };
      transaction.oncomplete = () => { db.close(); resolve(result); };
      transaction.onabort = () => { db.close(); reject(Error('History fixture transaction failed')); };
    };
  }), { database, owner, value, write });
}
async function message(text, timeout = 6000) {
  await page.getByRole('status').filter({ hasText: text }).waitFor({ state: 'visible', timeout });
}
async function manage(input = 'mouse') {
  await activate('Manage history', input);
  await activate('Allow management for 30 seconds', input);
  await message('Saved history is ready to inspect.');
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'status');
}
async function stop(input = 'mouse') {
  if (await button('Stop management').count()) await activate('Stop management', input);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(element => element.textContent === 'Manage history' && !element.disabled) && globalThis.__historyFocus.native.pending === 0);
}
async function cancelReview(trigger, title, input) {
  const before = JSON.stringify(await record()), puts = await page.evaluate(() => globalThis.__historyFocus.native.puts);
  await activate(trigger, input);
  assert.equal(await page.getByRole('heading', { name: title, exact: true }).evaluate(element => document.activeElement === element), true);
  await activate('Cancel', input);
  await returned(trigger);
  assert.equal(await page.evaluate(() => globalThis.__historyFocus.native.puts), puts);
  assert.equal(JSON.stringify(await record()), before);
  await focusReceipt(`${input}-${trigger}-cancel`);
  checks.push(`${input}-${trigger}-cancel-restores-trigger-with-no-write`);
}
try {
  const served = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  app = { ...served, origin: `http://127.0.0.1:${served.port}` };
  browser = await ({ chromium, webkit }[engine]).launch({ headless: true }); version = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  context.setDefaultTimeout(6000); context.setDefaultNavigationTimeout(10000);
  await context.route('**/*', route => new URL(route.request().url()).origin === app.origin ? route.continue() : (remote.push(route.request().url()), route.abort()));
  await context.addInitScript(() => {
    const native = { opens: 0, transactions: 0, puts: 0, pending: 0 };
    globalThis.__historyFocus = { native, trace: [] };
    window.addEventListener('blur', () => { globalThis.__historyFocus.trace.push({ at: performance.now(), event: 'window-blur' }); });
    document.addEventListener('focusin', event => { globalThis.__historyFocus.trace.push({ at: performance.now(), tag: event.target.tagName, text: event.target.textContent?.slice(0, 100) }); }, true);
    const open = IDBFactory.prototype.open, transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    IDBFactory.prototype.open = function (...args) {
      native.opens++; native.pending++; const request = Reflect.apply(open, this, args);
      const done = () => { native.pending--; request.removeEventListener('success', done); request.removeEventListener('error', done); };
      request.addEventListener('success', done); request.addEventListener('error', done); return request;
    };
    IDBDatabase.prototype.transaction = function (...args) {
      native.transactions++; native.pending++; const value = Reflect.apply(transaction, this, args);
      const done = () => { native.pending--; value.removeEventListener('complete', done); value.removeEventListener('abort', done); };
      value.addEventListener('complete', done); value.addEventListener('abort', done); return value;
    };
    IDBObjectStore.prototype.put = function (...args) { native.puts++; return Reflect.apply(put, this, args); };
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  for (const input of ['mouse', 'keyboard']) {
    await arrive();
    await activate('Manage history', input);
    assert.equal(await page.getByRole('heading', { name: 'Allow page history management?', exact: true }).evaluate(element => document.activeElement === element), true);
    await focusReceipt(`${input}-management-review`);
    await activate('Cancel', input);
    await page.getByRole('status').filter({ hasText: 'Management was not started.' }).waitFor();
    await focusReceipt(`${input}-cancel-before-return-check`);
    await returned('Manage history');
    assert.deepEqual(await page.evaluate(() => globalThis.__historyFocus.native), { opens: 0, transactions: 0, puts: 0, pending: 0 });
    checks.push(`${input}-management-cancel-restores-trigger-with-no-storage`);
  }
  if (!selection) {
    await arrive(); await manage(); checks.push('approved-management-focuses-readable-status-after-trigger-is-removed');
    await activate('Record page measurements', 'mouse');
    await activate('Allow collection', 'mouse');
    await message('Collection is on');
    await page.waitForFunction(() => [...document.querySelectorAll('p')].some(element => /Page size: 1 saved item\./.test(element.textContent)));
    await activate('Stop collection', 'mouse'); await message('Collection stopped.');
    const baseline = await record();
    assert.equal(baseline.version, 1); assert.equal(baseline.ownerId, owner);
    assert.equal(baseline.records.telemetry.rows.length, 1);
    assert.deepEqual(baseline.records.telemetry.rows[0].values, { width: 390, height: 844 });
    observations.push({ phase: 'actual-page-produced-fixture', envelope: baseline, envelopeSha256: hash(Buffer.from(JSON.stringify(baseline))) });
    checks.push('negative-fixtures-derived-from-real-History-page-native-producer');
    for (const input of ['mouse', 'keyboard']) {
      for (const [trigger, title] of [
        ['Record page measurements', 'Collect this page measurement?'],
        ['Export selected history', 'Download selected history?'],
        ['Remove selected history', 'Remove selected history?'],
        ['Remove expired history', 'Remove expired saved items?'],
      ]) await cancelReview(trigger, title, input);
    }
    await activate('Remove selected history', 'mouse'); await activate('Allow removal', 'mouse');
    await message('Removal needs fresh review.');
    assert.equal(await button('Record page measurements').count(), 0);
    for (const input of ['mouse', 'keyboard']) await cancelReview('Resume selected removal', 'Continue selected removal?', input);
    await stop();
    for (const input of ['mouse', 'keyboard']) {
      for (const fault of ['future-version', 'wrong-owner', 'corrupt']) {
        const refused = structuredClone(baseline);
        if (fault === 'future-version') refused.version = 99;
        else if (fault === 'wrong-owner') refused.ownerId = 'another-history-page';
        else refused.records.telemetry.bytes = 'invalid-byte-accounting';
        await record(refused, true); await arrive();
        const before = await record(), puts = await page.evaluate(() => globalThis.__historyFocus.native.puts);
        await activate('Manage history', input); await activate('Allow management for 30 seconds', input);
        await message(fault === 'future-version' ? 'This saved format cannot be managed' : fault === 'wrong-owner' ? 'do not belong to this page' : 'could not be read safely');
        await returned('Manage history');
        assert.equal(await page.getByRole('combobox').count(), 0);
        for (const name of ['Stop management', 'Record page measurements', 'Export selected history', 'Remove selected history', 'Remove expired history', 'Resume selected removal']) assert.equal(await button(name).count(), 0);
        const after = await record(), actualPuts = await page.evaluate(() => globalThis.__historyFocus.native.puts) - puts;
        const differences = changedFields(before, after);
        observations.push({ phase: `${input}-${fault}-storage-comparison`, before, after, differences, actualPuts,
          exactEnvelopePreserved: differences.length === 0, exactPrivateHistoryPreserved: JSON.stringify(before.records) === JSON.stringify(after.records),
          wording: 'Saved history could not be read safely. It has been kept untouched.' });
        if (fault === 'corrupt') {
          // Owner approval transactions advance only envelope clock/revision
          // before the producer rejects malformed telemetry byte accounting.
          // The private producer, copies, audit and deletion data must remain exact.
          assert.ok(differences.every(change => ['lastNow', 'revision'].includes(change.path)));
          assert.ok(after.lastNow >= before.lastNow && after.revision >= before.revision);
          const { lastNow: beforeTime, revision: beforeRevision, ...beforeData } = before;
          const { lastNow: afterTime, revision: afterRevision, ...afterData } = after;
          assert.ok(Number.isSafeInteger(beforeTime) && Number.isSafeInteger(afterTime) && Number.isSafeInteger(beforeRevision) && Number.isSafeInteger(afterRevision));
          assert.deepEqual(afterData, beforeData);
        } else {
          assert.equal(actualPuts, 0);
          assert.deepEqual(after, before);
        }
        await focusReceipt(`${input}-${fault}-management-refusal`);
        checks.push(`${input}-${fault}-refusal-restores-management-${fault === 'corrupt' ? 'with-exact-private-history-and-only-owner-bookkeeping' : 'with-no-write'}`);
      }
    }
    await record(baseline, true);
    for (const input of ['mouse', 'keyboard']) {
      await arrive(); await manage(input);
      await activate('Record page measurements', input);
      const puts = await page.evaluate(() => globalThis.__historyFocus.native.puts);
      await activate('Stop management', input);
      await message('Management stopped.'); await returned('Manage history');
      assert.equal(await page.getByRole('heading', { name: 'Collect this page measurement?', exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => globalThis.__historyFocus.native.puts), puts);
      await focusReceipt(`${input}-active-review-stopped`);
      checks.push(`${input}-Stop-during-review-restores-available-management-control`);
    }
    // Wait for the actual production 30-second approval; never replace its clock.
    for (const [input, active] of [['mouse', false], ['keyboard', true]]) {
      await arrive();
      if (active) { await manage(input); await activate('Record page measurements', input); }
      else await activate('Manage history', input);
      const before = { at: await page.evaluate(() => Date.now()), puts: await page.evaluate(() => globalThis.__historyFocus.native.puts) };
      await message('Management ended after 30 seconds.', 35000); await returned('Manage history');
      assert.equal(await page.locator('#history-review-title').count(), 0);
      assert.equal(await button('Record page measurements').count(), 0);
      assert.equal(await page.evaluate(() => globalThis.__historyFocus.native.puts), before.puts);
      if (!active) assert.equal(await page.evaluate(() => globalThis.__historyFocus.native.opens), 0);
      await focusReceipt(`${input}-${active ? 'active' : 'management'}-review-natural-expiry`);
      observations.at(-1).elapsedMs = await page.evaluate(() => Date.now()) - before.at;
      checks.push(`${input}-${active ? 'active' : 'management'}-review-natural-30-second-expiry-restores-management`);
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(remote, []);
} catch (error) { failure = error; if (page && !page.isClosed()) await focusReceipt('first-failure'); }
finally {
  const cleanupErrors = [];
  if (page && !page.isClosed()) {
    try {
      if (await button('Stop management').count()) await button('Stop management').click();
      await page.waitForFunction(() => globalThis.__historyFocus.native.pending === 0);
      cleanup.nativePending = await page.evaluate(() => globalThis.__historyFocus.native.pending);
      cleanup.databaseRemoved = await page.evaluate(database => new Promise(resolve => {
        const request = indexedDB.deleteDatabase(database); request.onsuccess = () => resolve(true); request.onerror = () => resolve(false); request.onblocked = () => resolve(false);
      }), database);
    } catch (error) { cleanupErrors.push(String(error)); }
  }
  try { if (context) { await context.close(); cleanup.pagesClosed = context.pages().length === 0; cleanup.contextClosed = true; } } catch (error) { cleanupErrors.push(String(error)); }
  try { if (browser) { await browser.close(); cleanup.browserClosed = !browser.isConnected(); } } catch (error) { cleanupErrors.push(String(error)); }
  try { if (app) { app.server.closeAllConnections(); await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())); cleanup.serverClosed = true; } } catch (error) { cleanupErrors.push(String(error)); }
  process.stderr.write(JSON.stringify({ phase: 'history-review-focus-cleanup', engine, checks, observations, errors, remote, cleanup, cleanupErrors }) + '\n');
  if (!failure && (cleanupErrors.length || Object.values(cleanup).some(value => value !== true && value !== 0))) failure = Error('Owned cleanup incomplete');
}
verifyPins();
if (failure) throw failure;
process.stdout.write(JSON.stringify({ status: 'pass', profile: 'history-review-focus/1', engine, version, selection: selection ?? 'full', checks, observations, cleanup,
  sourceTree: proof.builtSourceTree, proofSha256: hash(readFileSync(proofPath)), toolSha256: hash(readFileSync(import.meta.filename)),
  scope: 'Actual built History route, native mouse and keyboard focus and default IndexedDB; no native permission or whole-U12 qualification.' }) + '\n');
