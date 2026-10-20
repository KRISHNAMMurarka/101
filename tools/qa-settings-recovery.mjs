import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

// Regressions: unsafe reset of foreign/newer data, missing explicit recovery of
// corrupt private choices, or Cancel issuing a mutation through the real page.
const [origin, engine, proofPath, selection, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert.ok(selection === undefined || ["--future-focus-only", "--fault-states-only"].includes(selection));
const application = new URL(origin);
assert.ok(application.protocol === 'http:' && application.hostname === '127.0.0.1' && application.pathname === '/' && !application.search && !application.hash);
assert.ok(['chromium', 'webkit'].includes(engine) && proofPath);
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = JSON.parse(readFileSync(proofPath));
assert.equal(proof.origin, application.origin);
assert.equal(proof.profile, 'settings-recovery-preserved-build/1');
assert.match(proof.builtSourceTree, /^[a-f0-9]{40}$/);
const sourcePaths = Object.keys(proof.sourcePins);
for (const path of ['app/settings/page.tsx', 'app/settings/SettingsView.tsx', 'app/settings/settings-task.ts', 'packages/device-runtime/src/owner-data-storage.ts', 'packages/device-runtime/src/owner-data.ts', 'packages/device-runtime/src/settings-store.ts']) assert.ok(sourcePaths.includes(path));
const sourceBytes = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: sourcePaths.map(path => `${proof.builtSourceTree}:${path}`).join('\n') + '\n', maxBuffer: 32 * 1024 * 1024 });
let cursor = 0;
for (const path of sourcePaths) {
  const end = sourceBytes.indexOf(10, cursor), header = sourceBytes.subarray(cursor, end).toString().split(' ');
  assert.equal(header[1], 'blob'); const size = Number(header[2]);
  assert.ok(Number.isSafeInteger(size) && size >= 0);
  const start = end + 1, last = start + size;
  assert.equal(sourceBytes[last], 10);
  assert.equal(hash(sourceBytes.subarray(start, last)), proof.sourcePins[path], path);
  assert.equal(hash(readFileSync(resolve(root, path))), proof.sourcePins[path], path);
  cursor = last + 1;
}
assert.equal(cursor, sourceBytes.length);
for (const field of ['serverBuildPins', 'clientBuildPins']) {
  assert.ok(Object.keys(proof[field]).length > 1);
  for (const [path, pin] of Object.entries(proof[field])) assert.equal(hash(readFileSync(path)), pin, path);
}
assert.equal(hash(readFileSync(proof.requiredBuildProvenance.path)), proof.requiredBuildProvenance.sha256);
const databaseName = 'app-player-settings-managed-v1', ownerId = 'app-player-settings:this-browser';
const checks = [], states = [], errors = [], foreign = [];
let browser, context, page, version, failure;
const cleanup = { ownedDatabaseRemoved: false, pagesClosed: false, contextClosed: false, browserClosed: false, nativePendingBeforeClose: null };
async function record(value, write = false) {
  return page.evaluate(({ databaseName, ownerId, value, write }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onerror = () => reject(Error('owned-storage-open'));
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('owners', write ? 'readwrite' : 'readonly'), store = tx.objectStore('owners');
      const operation = write ? store.put(value, ownerId) : store.get(ownerId);
      let result; operation.onsuccess = () => { result = operation.result; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(Error('owned-storage-transaction')); };
    };
  }), { databaseName, ownerId, value, write });
}
async function arrive() {
  const response = await page.goto(new URL('/settings', application).href, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  await page.getByRole('button', { name: 'Manage appearance', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.__settingsRecovery), { opens: 0, transactions: 0, puts: 0, pending: 0 });
}
async function manage() {
  await page.getByRole('button', { name: 'Manage appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Allow for 30 seconds', exact: true }).click();
}
async function message(text) {
  await page.getByRole('status').filter({ hasText: text }).waitFor({ state: 'visible' });
}
async function stop() {
  const button = page.getByRole('button', { name: 'Stop management', exact: true });
  if (await button.count()) await button.click();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(value => value.textContent === 'Manage appearance');
    return button && !button.disabled && globalThis.__settingsRecovery.pending === 0;
  });
}
async function keyboard(target) {
  await page.bringToFront();
  for (let index = 0; index <= 40; index++) {
    if (await target.evaluate(element => document.hasFocus() && document.activeElement === element && element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none')) return;
    if (index < 40) await page.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
  }
  throw Error('Native keyboard did not reach recovery control with visible focus');
}
try {
  browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true }); version = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(6000); context.setDefaultNavigationTimeout(10000);
  await context.route('**/*', route => new URL(route.request().url()).origin === application.origin ? route.continue() : (foreign.push(route.request().url()), route.abort()));
  await context.addInitScript(() => {
    const observed = { opens: 0, transactions: 0, puts: 0, pending: 0 };
    globalThis.__settingsRecovery = observed;
    globalThis.__settingsFocusTrace = [];
    document.addEventListener('focusin', event => {
      const trace = globalThis.__settingsFocusTrace;
      trace.push({ at: performance.now(), tag: event.target.tagName, text: event.target.textContent?.slice(0, 100) });
      if (trace.length > 32) trace.shift();
    }, true);
    const open = IDBFactory.prototype.open, transaction = IDBDatabase.prototype.transaction, put = IDBObjectStore.prototype.put;
    IDBFactory.prototype.open = function (...args) {
      observed.opens++; observed.pending++; const request = Reflect.apply(open, this, args);
      const done = () => { observed.pending--; request.removeEventListener('success', done); request.removeEventListener('error', done); };
      request.addEventListener('success', done); request.addEventListener('error', done); return request;
    };
    IDBDatabase.prototype.transaction = function (...args) {
      observed.transactions++; observed.pending++; const value = Reflect.apply(transaction, this, args);
      const done = () => { observed.pending--; value.removeEventListener('complete', done); value.removeEventListener('abort', done); };
      value.addEventListener('complete', done); value.addEventListener('abort', done); return value;
    };
    IDBObjectStore.prototype.put = function (...args) { observed.puts++; return Reflect.apply(put, this, args); };
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await arrive(); checks.push('native-storage-inert-on-arrival');
  await manage(); await message('Appearance is ready to review');
  await page.getByRole('combobox', { name: 'Page appearance' }).selectOption('dark');
  await page.getByRole('button', { name: 'Review save', exact: true }).click();
  await page.getByRole('button', { name: 'Save appearance', exact: true }).click(); await message('was saved');
  const baseline = await record();
  assert.equal(JSON.parse(baseline.records.settings).preferences.theme, 'dark');
  assert.equal(JSON.parse(baseline.records.settings).version, 2); await stop();
  checks.push('negative-fixtures-derived-from-real-page-native-producer');

  if (!selection) {
  const corrupt = structuredClone(baseline), privateChoices = JSON.parse(corrupt.records.settings);
  privateChoices.preferences.theme = 'sepia'; corrupt.records.settings = JSON.stringify(privateChoices);
  await record(corrupt, true); await arrive(); await manage(); await message('could not be read');
  assert.equal(await page.getByRole('combobox', { name: 'Page appearance' }).isDisabled(), true);
  for (const name of ['Review save', 'Remove saved appearance']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
  assert.equal((await record()).records.settings, corrupt.records.settings); checks.push('corrupt-private-choices-no-implicit-reset-or-save');
  const reset = page.getByRole('button', { name: 'Reset saved appearance', exact: true });
  await keyboard(reset); await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('heading', { name: 'Reset saved appearance?', exact: true }).evaluate(element => element === document.activeElement), true);
  const puts = await page.evaluate(() => globalThis.__settingsRecovery.puts);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await reset.evaluate(element => element === document.activeElement), true);
  assert.equal(await page.evaluate(() => globalThis.__settingsRecovery.puts), puts);
  assert.equal((await record()).records.settings, corrupt.records.settings); checks.push('keyboard-reset-review-cancel-preserves-private-bytes-and-focus');
  await reset.click(); await page.getByRole('button', { name: 'Reset appearance', exact: true }).click(); await message('was reset');
  const recovered = await record(), recoveredPrivate = JSON.parse(recovered.records.settings);
  assert.deepEqual(recoveredPrivate.preferences, { theme: 'system', handedness: 'right', motion: 'system' });
  assert.deepEqual(recovered.copies, baseline.copies); assert.deepEqual(recovered.audit, baseline.audit);
  assert.equal(await page.getByRole('combobox', { name: 'Page appearance' }).isEnabled(), true);
  assert.equal(await page.locator('html').getAttribute('data-theme'), null); await stop();
  checks.push('explicit-reviewed-reset-recovers-current-private-choices');

  }
  for (const fault of (selection === '--future-focus-only' ? ['future-private-version'] : ['future-private-version', 'foreign-envelope-owner'])) {
    const value = structuredClone(baseline);
    if (fault === 'future-private-version') { const settings = JSON.parse(value.records.settings); settings.version = 3; value.records.settings = JSON.stringify(settings); }
    else value.ownerId = 'app-player-settings:another-browser';
    await record(value, true); await arrive();
    const before = JSON.stringify(await record()), beforePuts = await page.evaluate(() => globalThis.__settingsRecovery.puts);
    const focusBefore = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 100) }));
    await manage(); await message(fault === 'future-private-version' ? 'format this page cannot manage' : 'do not belong to this page');
    const refused = { phase: 'before-stop', comboboxes: await page.getByRole('combobox', { name: 'Page appearance' }).count(), resetControls: await page.getByRole('button', { name: 'Reset saved appearance', exact: true }).count(), stopControls: await page.getByRole('button', { name: 'Stop management', exact: true }).count() };
    assert.equal(refused.comboboxes, 0); assert.equal(refused.resetControls, 0);
    assert.equal(JSON.stringify(await record()), before);
    assert.equal(await page.evaluate(() => globalThis.__settingsRecovery.puts), beforePuts);
    assert.equal(await page.getByRole('combobox', { name: 'Page appearance' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Reset saved appearance', exact: true }).count(), 0);
    try {
      await page.waitForFunction(() => document.activeElement?.textContent === 'Manage appearance', undefined, { timeout: 6000 });
    } catch (error) {
      process.stderr.write(JSON.stringify({ phase: 'actual-focus-refusal', fault, focusBefore, observed: await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 200), focus: globalThis.__settingsFocusTrace })) }) + '\n');
      throw error;
    }
    await stop();
    states.push({ fault, refused, nativeEnvelopeSha256: hash(Buffer.from(before)), preserved: true, unsafeMutationsOffered: false });
    checks.push(`${fault}-preserved-and-unsafe-mutations-unavailable`);
  }
  await record(baseline, true); await arrive(); await manage(); await message('Appearance is ready to review');
  assert.equal(await page.getByRole('combobox', { name: 'Page appearance' }).inputValue(), 'dark');
  await stop(); checks.push('current-data-reentry-requires-fresh-management');
  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
} catch (error) { failure = error; }
finally {
  const cleanupErrors = [];
  if (page && !page.isClosed()) {
    try {
      await stop(); cleanup.nativePendingBeforeClose = await page.evaluate(() => globalThis.__settingsRecovery.pending);
      cleanup.ownedDatabaseRemoved = await page.evaluate(databaseName => new Promise(resolve => {
        const request = indexedDB.deleteDatabase(databaseName); request.onsuccess = () => resolve(true); request.onerror = () => resolve(false); request.onblocked = () => resolve(false);
      }), databaseName);
    } catch (error) { cleanupErrors.push(String(error)); }
  }
  try { if (context) { await context.close(); cleanup.pagesClosed = context.pages().length === 0; cleanup.contextClosed = true; } } catch (error) { cleanupErrors.push(String(error)); }
  try { if (browser) { await browser.close(); cleanup.browserClosed = !browser.isConnected(); } } catch (error) { cleanupErrors.push(String(error)); }
  process.stderr.write(JSON.stringify({ phase: 'settings-recovery-cleanup', engine, checks, states, errors, foreign, cleanup, cleanupErrors }) + '\n');
  if (!failure && (cleanupErrors.length || !cleanup.ownedDatabaseRemoved || cleanup.nativePendingBeforeClose !== 0)) failure = Error('Owned cleanup incomplete');
}
for (const [path, pin] of Object.entries(proof.sourcePins)) assert.equal(hash(readFileSync(resolve(root, path))), pin, `Source drift: ${path}`);
for (const field of ['serverBuildPins', 'clientBuildPins']) for (const [path, pin] of Object.entries(proof[field])) assert.equal(hash(readFileSync(path)), pin, `Build drift: ${path}`);
if (failure) throw failure;
process.stdout.write(JSON.stringify({ status: 'pass', profile: 'settings-recovery/1', engine, version, checks, states, cleanup,
  sourceTree: proof.builtSourceTree, servedProofSha256: hash(readFileSync(proofPath)), qaSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  scope: 'Actual preserved built Settings route and default native IndexedDB. Single-field negative mutations of real page-produced bytes; no other provider, OS permission, installed-app or whole-U12 qualification.' }) + '\n');
