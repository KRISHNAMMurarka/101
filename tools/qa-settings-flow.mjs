import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, relative } from 'node:path';

const args = process.argv.slice(2), application = new URL(args.shift());
let proofPath, engine = 'chromium', engineSeen = false, missingRouteRed = false;
while (args.length) {
  const name = args.shift();
  if (name === '--served-proof' && !proofPath) proofPath = args.shift();
  else if (name === '--engine' && !engineSeen) { engine = args.shift(); engineSeen = true; }
  else if (name === '--missing-route-red' && !missingRouteRed) missingRouteRed = true;
  else throw Error(`Unknown or duplicate argument: ${name}`);
}
assert.ok(proofPath && ['chromium', 'webkit'].includes(engine));
assert.ok(application.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(application.hostname)
  && application.pathname === '/' && !application.search && !application.hash, 'Owned fixed loopback origin only');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const proofBytes = readFileSync(proofPath), proof = JSON.parse(proofBytes);
assert.equal(proof.origin, application.origin); assert.match(proof.sourceTree, /^[a-f0-9]{40}$/);
const root = realpathSync(proof.sourceRoot);
const sourcePaths = ['app/components/AppShell.tsx', 'app/components/Icon.tsx', 'app/connections/connections.module.css', 'app/layout.tsx', 'app/globals.css', 'package.json',
  ...(missingRouteRed ? [] : ['app/settings/page.tsx', 'app/settings/SettingsView.tsx', 'app/settings/settings-task.ts',
    'app/settings/settings-task.test.ts', 'app/settings/settings.module.css', 'tools/qa-settings-flow.mjs',
    'packages/device-runtime/src/owner-data.ts', 'packages/device-runtime/src/owner-data-storage.ts',
    'packages/device-runtime/src/settings-store.ts', 'packages/device-runtime/src/index.ts', 'packages/connect/src/index.ts'])];
for (const path of sourcePaths) {
  assert.match(proof.sourcePins?.[path] ?? '', /^[a-f0-9]{64}$/);
  assert.equal(hash(readFileSync(resolve(root, path))), proof.sourcePins[path], `Declared served source: ${path}`);
  assert.equal(hash(execFileSync('git', ['cat-file', 'blob', `${proof.sourceTree}:${path}`], { cwd: root, maxBuffer: 2 * 1024 * 1024 })), proof.sourcePins[path], `Immutable source: ${path}`);
}
assert.ok(Array.isArray(proof.buildInputs) && proof.buildInputs.length >= 2 && proof.buildInputs.length <= 2048);
let bytes = 0; const buildPaths = new Set();
for (const item of proof.buildInputs) {
  assert.ok(item && typeof item.path === 'string' && ['server', 'client'].includes(item.kind));
  assert.match(item.sha256 ?? '', /^[a-f0-9]{64}$/);
  const path = realpathSync(item.path), rel = relative(root, path);
  assert.ok(!rel.startsWith('..') && !rel.startsWith('/') && rel.startsWith(`dist/${item.kind}/`), 'Actual owned build input');
  assert.ok(!buildPaths.has(path)); buildPaths.add(path);
  const content = readFileSync(path); bytes += content.byteLength; assert.ok(bytes <= 64 * 1024 * 1024);
  assert.equal(hash(content), item.sha256, `Actual build input: ${rel}`);
}
assert.ok(proof.buildInputs.some(item => item.kind === 'server') && proof.buildInputs.some(item => item.kind === 'client'));
const require = createRequire(join(root, 'package.json'));
const { chromium, webkit } = require('playwright');
const databaseName = 'app-player-settings-managed-v1', ownerId = 'app-player-settings:this-browser';
let browser, context;
const pages = [], errors = [], foreign = [], checks = [], declinedReviews = [];
const cleanup = { pagesClosed: false, contextCloseAwaited: false, browserClosed: false };
let failure, version, nativeKeyboardSteps;
async function page() {
  const value = await context.newPage(); pages.push(value); value.on('pageerror', error => errors.push(error.message));
  const reply = await value.goto(new URL('/settings', application).toString(), { waitUntil: 'networkidle', timeout: 10000 });
  return { value, status: reply?.status() };
}
async function manage(value) {
  await value.getByRole('button', { name: 'Manage appearance', exact: true }).click();
  await value.getByRole('button', { name: 'Allow for 30 seconds', exact: true }).click();
  await value.getByRole('combobox', { name: 'Page appearance', exact: true }).waitFor({ state: 'visible' });
  await value.waitForFunction(() => !document.querySelector('select')?.disabled, undefined, { timeout: 6000 });
}
async function review(value, request, allow) {
  await value.getByRole('button', { name: request, exact: true }).click();
  await value.getByRole('button', { name: allow, exact: true }).click();
}
async function read(value) {
  return value.evaluate(({ databaseName, ownerId }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onerror = () => reject(Error('owned-read'));
    request.onsuccess = () => {
      const database = request.result, tx = database.transaction('owners', 'readonly'), get = tx.objectStore('owners').get(ownerId);
      let record; get.onsuccess = () => { record = get.result; };
      tx.oncomplete = () => { database.close(); resolve(record); }; tx.onabort = () => { database.close(); reject(Error('owned-read')); };
    };
  }), { databaseName, ownerId });
}
async function status(value, text) { await value.getByRole('status').filter({ hasText: text }).waitFor({ state: 'visible', timeout: 6000 }); }
async function nativeTab(value, target) {
  await value.bringToFront();
  for (let step = 0; step <= 32; step++) {
    if (await target.evaluate(element => document.hasFocus() && document.activeElement === element && element.matches(':focus-visible') &&
      getComputedStyle(element).outlineStyle !== 'none' && parseFloat(getComputedStyle(element).outlineWidth) >= 2)) return step;
    if (step < 32) await value.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
  }
  throw Error('Native keyboard focus was not established');
}
try {
  browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true }); version = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(10000);
  await context.route('**/*', route => new URL(route.request().url()).origin === application.origin
    ? route.continue() : (foreign.push(route.request().url()), route.abort()));
  await context.addInitScript(() => {
    const observed = { opens: 0, transactions: 0, rawOpen: 0, rawTransactions: 0 };
    globalThis.__settingsNative = observed;
    const nativeOpen = IDBFactory.prototype.open, nativeTransaction = IDBDatabase.prototype.transaction;
    Object.defineProperty(IDBFactory.prototype, 'open', { configurable: true, writable: true, value(...args) {
      observed.opens++; observed.rawOpen++; const request = Reflect.apply(nativeOpen, this, args);
      const settled = () => { observed.rawOpen--; request.removeEventListener('success', settled); request.removeEventListener('error', settled); };
      request.addEventListener('success', settled); request.addEventListener('error', settled); return request;
    } });
    Object.defineProperty(IDBDatabase.prototype, 'transaction', { configurable: true, writable: true, value(...args) {
      observed.transactions++; observed.rawTransactions++; const transaction = Reflect.apply(nativeTransaction, this, args);
      const settled = () => { observed.rawTransactions--; transaction.removeEventListener('complete', settled); transaction.removeEventListener('abort', settled); };
      transaction.addEventListener('complete', settled); transaction.addEventListener('abort', settled); return transaction;
    } });
  });
  const first = await page(), a = first.value;
  const arrival = { status: first.status, headings: await a.getByRole('heading', { name: 'Settings', exact: true }).count(),
    manage: await a.getByRole('button', { name: 'Manage appearance', exact: true }).count(),
    native: await a.evaluate(() => globalThis.__settingsNative), theme: await a.locator('html').getAttribute('data-theme') };
  if (missingRouteRed) {
    process.stderr.write(`${JSON.stringify({ phase: 'actual-old-settings-arrival', sourceTree: proof.sourceTree, arrival, errors, foreign })}\n`);
    assert.equal(arrival.status, 200, 'Real Settings route required; absent route is feature RED');
    throw Error('OLD missing route did not reproduce');
  }
  assert.equal(arrival.status, 200); assert.equal(arrival.headings, 1); assert.equal(arrival.manage, 1);
  assert.equal(await a.locator('nav.rail a[href="/settings"]').count(), 1);
  const phoneNavigation = a.locator('nav.tabbar');
  assert.equal(await phoneNavigation.getByRole('link', { name: 'Settings', exact: true }).getAttribute('aria-current'), 'page');
  assert.deepEqual(arrival.native, { opens: 0, transactions: 0, rawOpen: 0, rawTransactions: 0 }); checks.push('inert-native-storage-arrival');
  nativeKeyboardSteps = await nativeTab(a, a.getByRole('button', { name: 'Manage appearance', exact: true }));
  await a.keyboard.press('Enter'); await a.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await a.evaluate(() => globalThis.__settingsNative.opens), 0); checks.push('native-keyboard-declined-management-no-open');
  await manage(a); await a.getByRole('combobox', { name: 'Page appearance' }).selectOption('dark');
  assert.equal(await a.locator('html').getAttribute('data-theme'), 'dark');
  const declineBytes = JSON.stringify(await read(a));
  const declineTransactions = await a.evaluate(() => globalThis.__settingsNative.transactions);
  for (const request of ['Review save', 'Reset saved appearance', 'Remove saved appearance']) {
    await a.getByRole('button', { name: request, exact: true }).click();
    await a.getByRole('button', { name: 'Cancel', exact: true }).click();
    const observed = { request, selectedTheme: await a.getByRole('combobox', { name: 'Page appearance' }).inputValue(),
      ownedTheme: await a.locator('html').getAttribute('data-theme'),
      transactions: await a.evaluate(() => globalThis.__settingsNative.transactions),
      managementStillCurrent: await a.getByRole('button', { name: 'Stop management', exact: true }).isVisible() };
    declinedReviews.push(observed);
    process.stderr.write(`${JSON.stringify({ phase: 'actual-declined-review', observed, baselineTransactions: declineTransactions })}\n`);
    assert.equal(observed.selectedTheme, 'dark', 'Decline preserves current draft');
    assert.equal(observed.ownedTheme, 'dark', 'Decline preserves the actual owned page preview');
    assert.equal(observed.transactions, declineTransactions, 'Decline issues no storage operation');
    assert.equal(observed.managementStillCurrent, true, 'Decline retains current management');
  }
  assert.equal(JSON.stringify(await read(a)), declineBytes, 'Declined reviews do not replace producer bytes or stage deletion');
  checks.push('declined-save-reset-delete-preserve-native-preview-draft-and-storage');
  await review(a, 'Review save', 'Save appearance'); await status(a, 'was saved');
  let envelope = await read(a); assert.equal(JSON.parse(envelope.records.settings).preferences.theme, 'dark'); checks.push('actual-idb-reviewed-save');
  const second = await page(), b = second.value;
  assert.equal(await b.evaluate(() => globalThis.__settingsNative.opens), 0);
  assert.equal(await b.locator('html').getAttribute('data-theme'), arrival.theme);
  await manage(b); assert.equal(await b.getByRole('combobox', { name: 'Page appearance' }).inputValue(), 'dark');
  assert.equal(await b.locator('html').getAttribute('data-theme'), arrival.theme); checks.push('explicit-second-page-load-no-auto-theme');
  await b.getByRole('combobox', { name: 'Page appearance' }).selectOption('light'); await review(b, 'Review save', 'Save appearance'); await status(b, 'was saved');
  await review(a, 'Review save', 'Save appearance'); await status(a, 'changed in another page');
  await a.getByRole('button', { name: 'Reload saved appearance' }).click(); await status(a, 'ready to review');
  assert.equal(await a.getByRole('combobox', { name: 'Page appearance' }).inputValue(), 'light'); checks.push('native-cas-conflict-explicit-reload');
  await a.getByRole('combobox', { name: 'Page appearance' }).selectOption('dark');
  await a.getByRole('button', { name: 'Cancel preview' }).click(); assert.equal(await a.locator('html').getAttribute('data-theme'), arrival.theme);
  await a.getByRole('combobox', { name: 'Page appearance' }).selectOption('dark');
  await a.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await a.getByRole('button', { name: 'Stop management' }).click(); assert.equal(await a.locator('html').getAttribute('data-theme'), 'light');
  checks.push('owned-preview-cancel-and-competing-theme-preserved');
  await b.getByRole('button', { name: 'Stop management' }).click();
  await manage(a); await review(a, 'Reset saved appearance', 'Reset appearance'); await status(a, 'was reset');
  envelope = await read(a); assert.equal(JSON.parse(envelope.records.settings).preferences.theme, 'system'); checks.push('explicit-native-reset');
  await review(a, 'Remove saved appearance', 'Start removal'); await status(a, 'Removal has started');
  const staged = await read(a); assert.equal(staged.deletion.state, 'pending'); assert.equal(staged.epoch, 2); assert.ok(staged.records.settings);
  await review(a, 'Review Finish removal', 'Finish removal'); await status(a, 'was removed');
  envelope = await read(a); assert.equal(envelope.records.settings, undefined); assert.equal(envelope.deletion.state, 'completed');
  assert.deepEqual(envelope.audit[0].kinds, ['settings']); checks.push('actual-settings-only-staged-removal-retains-audit');
  for (const width of [320, 1280]) {
    await a.setViewportSize({ width, height: 844 });
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const theme of ['light', 'dark']) {
      await a.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      const metrics = await a.getByRole('button', { name: 'Manage appearance' }).evaluate(element => {
        const style = getComputedStyle(element), box = element.getBoundingClientRect();
        return { color: style.color, background: style.backgroundColor, height: box.height };
      });
      assert.ok(metrics.height >= 44); assert.notEqual(metrics.color, metrics.background);
    }
  }
  checks.push('responsive-two-theme-native-controls');
  await manage(a); await a.getByRole('combobox', { name: 'Page appearance' }).selectOption('dark');
  const quietBefore = await a.evaluate(() => globalThis.__settingsNative.transactions);
  await a.getByRole('status').filter({ hasText: 'Management ended after 30 seconds' }).waitFor({ timeout: 31000 });
  assert.equal(await a.evaluate(() => globalThis.__settingsNative.transactions), quietBefore);
  assert.equal(await a.locator('html').getAttribute('data-theme'), 'dark'); // prior competing theme captured before this preview
  assert.equal(await a.getByRole('button', { name: 'Manage appearance' }).isEnabled(), true);
  checks.push('quiet-absolute-management-expiry-no-storage-work');

  // Genuine native blocked-delete/open ordering. The existing SDK promise can
  // time out, but the app must retain the unresolved request and refuse retry.
  await a.evaluate(({ databaseName }) => new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1); open.onerror = () => reject(Error('blocker'));
    open.onsuccess = () => {
      globalThis.__settingsBlocker = open.result;
      const deletion = indexedDB.deleteDatabase(databaseName);
      deletion.onerror = () => reject(Error('blocked-delete')); deletion.onblocked = () => resolve(true);
      globalThis.__settingsDelete = deletion;
    };
  }), { databaseName });
  await a.getByRole('button', { name: 'Manage appearance' }).click(); await a.getByRole('button', { name: 'Allow for 30 seconds' }).click();
  await a.waitForFunction(() => globalThis.__settingsNative.rawOpen === 1, undefined, { timeout: 6000 });
  await a.getByRole('button', { name: 'Stop management' }).click();
  assert.equal(await a.getByRole('button', { name: 'Manage appearance' }).isEnabled(), false);
  const retainedOpenCount = await a.evaluate(() => globalThis.__settingsNative.opens);
  await a.waitForTimeout(5100); // fixed SDK open limit, not a grant renewal or a native terminal claim
  assert.equal(await a.getByRole('button', { name: 'Manage appearance' }).isEnabled(), false);
  assert.equal(await a.evaluate(() => globalThis.__settingsNative.rawOpen), 1);
  assert.equal(await a.evaluate(() => globalThis.__settingsNative.opens), retainedOpenCount);
  await a.evaluate(() => globalThis.__settingsBlocker.close());
  await a.waitForFunction(() => globalThis.__settingsNative.rawOpen === 0 && globalThis.__settingsNative.rawTransactions === 0, undefined, { timeout: 6000 });
  await a.getByRole('button', { name: 'Manage appearance' }).waitFor({ state: 'visible' });
  assert.equal(await a.getByRole('button', { name: 'Manage appearance' }).isEnabled(), true);
  await status(a, 'Management stopped');
  checks.push('actual-blocked-native-open-retained-through-timeout-stop-and-late-terminal');
  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
  for (const path of sourcePaths) assert.equal(hash(readFileSync(resolve(root, path))), proof.sourcePins[path], `Source remained exact: ${path}`);
  for (const item of proof.buildInputs) assert.equal(hash(readFileSync(item.path)), item.sha256, 'Served build remained exact');
} catch (error) { failure = error; }
finally {
  const cleanupErrors = [];
  for (const value of pages) { try { if (!value.isClosed()) await value.close(); } catch (error) { cleanupErrors.push(String(error)); } }
  cleanup.pagesClosed = pages.every(value => value.isClosed());
  try { if (context) { await context.close(); cleanup.contextCloseAwaited = true; } } catch (error) { cleanupErrors.push(String(error)); }
  try { if (browser) { await browser.close(); cleanup.browserClosed = !browser.isConnected(); } } catch (error) { cleanupErrors.push(String(error)); }
  process.stderr.write(`${JSON.stringify({ phase: 'actual-owned-cleanup', checks, declinedReviews, errors, foreign, cleanup, cleanupErrors, browserInternalResources: 'not measured' })}\n`);
  if (cleanupErrors.length && !failure) failure = Error('Owned cleanup failed');
}
if (failure) throw failure;
process.stdout.write(`${JSON.stringify({ status: 'pass', profile: 'browser-local-appearance-settings/1', engine, version,
  sourceTree: proof.sourceTree, sourcePins: Object.fromEntries(sourcePaths.map(path => [path, proof.sourcePins[path]])),
  servedProofSha256: hash(proofBytes), qaSha256: hash(readFileSync(new URL(import.meta.url))),
  checks, declinedReviews, nativeKeyboardSteps, cleanup, errors, foreign, scope: 'Owned browser native SettingsStore/managed IDB and page appearance only; no installed UI, account, provider, hardware or full U12 qualification' })}\n`);
