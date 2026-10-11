import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

// Root owns compilation, fresh application build, server and disposable profile.
// This caller observes native returns; it never supplies storage/lock/RTC ports.
const [originText, proofPath, engine, output] = process.argv.slice(2), origin = new URL(originText);
assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password);
assert.ok(['chromium', 'webkit'].includes(engine) && isAbsolute(proofPath) && isAbsolute(output) && !existsSync(output));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function regular(path, limit = 2 * 1024 * 1024) {
  assert.ok(isAbsolute(path)); const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= limit);
  const bytes = readFileSync(path), after = lstatSync(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
  assert.equal(bytes.length, before.size); return bytes;
}
const key = '101:remembered-resource-devices/1', lockName = `${key}:lock`;
const fixtureURL = new URL('/__owned_remembered_source__.js', origin).href;
const fixturePage = new URL('/__owned_remembered_source__', origin).href;
const report = { schemaVersion: 1, status: 'pending', engine, phase: 'pins', sourceTree: undefined,
  browserVersion: undefined, checks: [], sourcePins: {}, buildInputs: [], matchedBuildResponses: 0,
  pageErrors: [], failedRequests: [], foreignRequests: 0, socketAttempts: 0, requestCount: 0,
  nativeArrivals: [], nativeBoundaries: [], documentRetirements: [], failures: [], finalPinsVerified: false,
  cleanup: { sourceStopJoined: false, nativeReturnsJoined: false, documentsRetired: false,
    ownedStorageRemoved: false, pagesClosed: false, contextCloseAwaited: false, browserClosed: false },
  scope: 'Actual local native Chromium/WebKit, fresh isolated context, public SDK software descriptor, bilateral P256/RTC enrollment, built player UI and native Storage/Web Locks. No installed-package, browser-restart, hardware, account, downloaded/clipboard backup or whole B05/B06/U02 acceptance.' };
let browser, context, page, source, proof, proofSHA, failure;
const pages = [], retired = new Set(), bodies = new Set(), requests = new Map(), assets = new Map(), seen = new Set();
function retain(cause) {
  failure ??= cause;
  if (report.failures.length < 12) report.failures.push({ phase: report.phase,
    message: String(cause?.message ?? cause).slice(0, 4096), stack: String(cause?.stack ?? '').slice(0, 8192) });
}
function guard() {
  assert.equal(hash(regular(proofPath)), proofSHA);
  for (const [path, sha] of Object.entries(report.sourcePins)) assert.equal(hash(regular(join(proof.sourceRoot, path))), sha);
  for (const item of report.buildInputs) assert.equal(hash(regular(item.path, 32 * 1024 * 1024)), item.sha256);
  assert.equal(hash(regular(proof.fixture.path)), proof.fixture.sha256);
  assert.equal(hash(regular(proof.buildRecord.path)), proof.buildRecord.sha256);
}
async function joinRequests() {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Native HTTP/body observation timed out')), 30000); });
  try { while (bodies.size || requests.size) await Promise.race([
    Promise.allSettled([...bodies, ...[...requests.values()].map(value => value.returned)]), deadline]); }
  finally { clearTimeout(timer); }
}
async function openPage() {
  const selected = await context.newPage(); pages.push(selected); selected.setDefaultTimeout(15000);
  selected.on('pageerror', cause => { report.pageErrors.push(String(cause.message).slice(0, 4096)); retain(cause); });
  selected.on('request', request => {
    let finish; const returned = new Promise(resolveReturn => { finish = resolveReturn; }); requests.set(request, { returned, finish });
  });
  for (const event of ['requestfinished', 'requestfailed']) selected.on(event, request => {
    const owned = requests.get(request); if (!owned) return;
    if (event === 'requestfailed') { const detail = { url: request.url(), reason: request.failure()?.errorText };
      report.failedRequests.push(detail); retain(Error(`Native request failed: ${detail.url}: ${detail.reason}`)); }
    requests.delete(request); owned.finish();
  });
  selected.on('response', response => {
    const expected = assets.get(response.url()); if (!expected) return;
    const returned = response.body().then(bytes => { assert.equal(response.status(), 200); assert.equal(hash(bytes), expected); seen.add(response.url()); });
    bodies.add(returned); void returned.then(() => bodies.delete(returned), cause => { bodies.delete(returned); retain(cause); });
  }); return selected;
}
async function press(selected, name) {
  const button = selected.getByRole('button', { name, exact: true }); await button.click({ trial: true }); await button.focus();
  assert.equal(await button.evaluate(element => element === document.activeElement && element.matches(':focus')), true);
  await selected.keyboard.press('Space');
}
const memory = () => page.locator('[data-remembered-outcome]');
async function outcome(value) { await page.waitForFunction(value => document.querySelector('[data-remembered-outcome]')?.getAttribute('data-remembered-outcome') === value, value); }
async function native(selected = page) {
  await selected.waitForFunction(() => globalThis.__rememberedNative.state.cryptoPending === 0 && globalThis.__rememberedNative.state.rtcPending === 0);
  return selected.evaluate(() => globalThis.__rememberedNative.snapshot());
}
async function raw() { return page.evaluate(() => globalThis.__rememberedNative.read()); }
async function mutate(value) { await page.evaluate(value => globalThis.__rememberedNative.write(value), value); }
async function trace() { return page.evaluate(() => globalThis.__rememberedNative.trace()); }
async function expectWrite(start) {
  const events = (await trace()).slice(start);
  assert.deepEqual(events, [{ operation: 'get', inExclusiveCallback: true },
    { operation: 'get', inExclusiveCallback: true }, { operation: 'set', inExclusiveCallback: true }]);
  report.nativeStorageWriteOrders ??= []; report.nativeStorageWriteOrders.push(events);
}
async function arrive() {
  assert.equal((await page.goto(new URL('/devices?session=REMEMBERED-QA', origin).href, { waitUntil: 'networkidle' }))?.status(), 200);
  await page.getByRole('heading', { name: 'What is connected', exact: true }).waitFor();
  // A server-rendered heading alone does not establish a live player lifetime.
  await page.waitForFunction(() => typeof globalThis.__VINEXT_RSC_ROOT__?.unmount === 'function'
    && typeof globalThis[Symbol.for('vinext.navigationRuntime')]?.functions?.notifyLinkNavigationStart === 'function'
    && globalThis.__VINEXT_RSC_PREFETCH_CACHE__ instanceof Map
    && [...document.querySelectorAll('button')].some(button => button.textContent === 'Enroll resource device' && !button.disabled));
  const arrival = await native(); report.nativeArrivals.push(arrival);
  // Framework URL digests are observed and joined, but supply no pairing key.
  for (const field of ['reads', 'writes', 'removes', 'clears', 'locks', 'identityCryptoCalls', 'peersCreated']) assert.equal(arrival[field], 0);
  return arrival;
}
async function check(name) {
  assert.equal(await memory().getAttribute('data-remembered-pending'), '0');
  const state = await native(); assert.equal(state.lockPending, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  report.checks.push(name); report.nativeBoundaries.push({ name, ...state });
}
async function importReview(copy) {
  await press(page, 'Restore remembered names');
  await page.getByRole('textbox', { name: 'Public metadata JSON', exact: true }).fill(copy);
  await press(page, 'Review names to restore');
}
async function forget() {
  await press(page, 'Forget remembered device'); const start = (await trace()).length;
  await press(page, 'Confirm forgetting past device'); await outcome('forgotten'); await expectWrite(start);
  assert.deepEqual(JSON.parse(await raw()), { schemaVersion: 1, devices: [] });
}
async function holdLock() {
  await source.evaluate(lockName => {
    let entered, release;
    const started = new Promise(resolveStarted => { entered = resolveStarted; });
    const held = new Promise(resolveHeld => { release = resolveHeld; });
    const returned = navigator.locks.request(lockName, { mode: 'exclusive' }, lock => { if (lock?.mode !== 'exclusive') throw Error('Native exclusive lock missing'); entered(); return held; });
    globalThis.__rememberedHeldLock = { release, returned }; return started;
  }, lockName);
}
async function releaseLock() {
  await source.evaluate(async () => { const owned = globalThis.__rememberedHeldLock; if (!owned) return;
    owned.release(); await owned.returned; delete globalThis.__rememberedHeldLock; });
}
async function retireDocument(selected, application) {
  if (retired.has(selected)) return;
  if (application) {
    await selected.evaluate(() => {
      const root = globalThis.__VINEXT_RSC_ROOT__, runtime = globalThis[Symbol.for('vinext.navigationRuntime')];
      if (typeof root?.unmount !== 'function' || typeof runtime?.functions?.notifyLinkNavigationStart !== 'function'
        || !(globalThis.__VINEXT_RSC_PREFETCH_CACHE__ instanceof Map)) throw Error('Actual framework owners missing');
      root.unmount(); runtime.functions.notifyLinkNavigationStart();
    });
    await native(selected);
    await selected.evaluate(async () => {
      const cache = globalThis.__VINEXT_RSC_PREFETCH_CACHE__; let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Framework returns timed out')), 30000); });
      try { while (true) {
        const pending = [...new Set([...cache.values()].flatMap(entry => [entry.pending, entry.fetchPromise]).filter(value => value instanceof Promise))];
        if (!pending.length) break;
        const results = await Promise.race([Promise.allSettled(pending), deadline]);
        if (results.some(result => result.status === 'rejected')) throw Error('Framework prefetch failed');
      } } finally { clearTimeout(timer); }
    });
  }
  const state = await native(selected); assert.equal(state.lockPending, 0); assert.equal(state.openPeers, 0);
  await selected.waitForLoadState('networkidle'); await joinRequests();
  report.documentRetirements.push({ pageOrdinal: pages.indexOf(selected) + 1, application, native: state,
    frameworkUnmountIssued: application, nativeReturnsJoined: true });
  await selected.goto('about:blank'); await joinRequests(); retired.add(selected);
}
try {
  const bytes = regular(proofPath); proofSHA = hash(bytes); proof = JSON.parse(bytes);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.origin, origin.origin); assert.match(proof.sourceTree, /^[0-9a-f]{40}$/);
  assert.equal(proof.sourceRoot, realpathSync(proof.sourceRoot)); assert.equal(proof.sourceRoot, resolve(proof.sourceRoot));
  assert.equal(proof.qaToolSHA, hash(regular(fileURLToPath(import.meta.url)))); report.sourceTree = proof.sourceTree;
  const pins = Object.entries(proof.sourcePins); assert.ok(pins.length >= 10 && pins.length <= 512);
  for (const [path, sha] of pins) { assert.ok(!isAbsolute(path) && /^[A-Za-z0-9._/-]{1,512}$/.test(path)
    && !path.split('/').some(part => !part || part === '..')); assert.match(sha, /^[a-f0-9]{64}$/); report.sourcePins[path] = sha; }
  for (const path of ['app/devices/remembered-devices.ts', 'app/devices/enrolled-device.ts', 'app/devices/EnrolledDevices.tsx',
    'tools/qa-remembered-source.mjs', 'tools/qa-remembered-public-backup.mjs']) assert.ok(Object.hasOwn(report.sourcePins, path));
  assert.ok(proof.buildInputs.length >= 2 && proof.buildInputs.length <= 2048);
  let total = 0; const buildPaths = new Set();
  for (const item of proof.buildInputs) {
    assert.ok(['server', 'client'].includes(item.kind) && isAbsolute(item.path) && realpathSync(item.path) === resolve(item.path));
    assert.ok(!buildPaths.has(item.path)); buildPaths.add(item.path); assert.match(item.sha256, /^[a-f0-9]{64}$/);
    const rel = relative(join(proof.sourceRoot, 'dist', item.kind), item.path); assert.ok(!rel.startsWith('..') && !isAbsolute(rel));
    total += regular(item.path, 32 * 1024 * 1024).length; assert.ok(total <= 64 * 1024 * 1024); report.buildInputs.push(item);
    if (item.kind === 'client') assets.set(new URL(rel.replaceAll('\\', '/'), origin).href, item.sha256);
  }
  assert.ok(report.buildInputs.some(item => item.kind === 'server') && report.buildInputs.some(item => item.kind === 'client'));
  assert.ok(isAbsolute(proof.fixture.path)); assert.match(proof.fixture.sha256, /^[a-f0-9]{64}$/);
  assets.set(fixtureURL, proof.fixture.sha256); guard();
  browser = await ({ chromium, webkit })[engine].launch({ headless: true }); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    report.requestCount++; const url = route.request().url();
    if (new URL(url).origin !== origin.origin || report.requestCount > 1024) { report.foreignRequests++; retain(Error('Foreign or over-limit request denied')); await route.abort(); }
    else if (url === fixtureURL) await route.fulfill({ status: 200, contentType: 'text/javascript', body: regular(proof.fixture.path) });
    else if (url === fixturePage) await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned public metadata source</title><body></body></html>' });
    else await route.continue();
  });
  await context.routeWebSocket('**/*', socket => { report.socketAttempts++; retain(Error('Socket attempt denied')); socket.close(); });
  await context.addInitScript(({ key, lockName, ownedOrigin }) => {
    if (location.origin !== ownedOrigin) return;
    const state = { reads: 0, writes: 0, removes: 0, clears: 0, locks: 0, grants: 0, lockPending: 0, cryptoCalls: 0, cryptoPending: 0,
      identityCryptoCalls: 0, rtcCalls: 0, rtcPending: 0, peersCreated: 0, qaWrites: 0, traceOverLimit: false };
    const peers = new Set(), then = Promise.prototype.then, events = []; let exclusiveDepth = 0;
    function event(operation) { if (events.length < 512) events.push({ operation, inExclusiveCallback: exclusiveDepth > 0 }); else state.traceOverLimit = true; }
    function returned(issued, pending) { void then.call(issued, () => { state[pending]--; }, () => { state[pending]--; }); return issued; }
    for (const name of ['generateKey', 'exportKey', 'importKey', 'sign', 'verify', 'digest']) {
      const original = SubtleCrypto.prototype[name];
      SubtleCrypto.prototype[name] = function(...args) { state.cryptoCalls++; if (name !== 'digest') state.identityCryptoCalls++; state.cryptoPending++;
        try { return returned(Reflect.apply(original, this, args), 'cryptoPending'); } catch (cause) { state.cryptoPending--; throw cause; } };
    }
    const originalGet = Storage.prototype.getItem, originalSet = Storage.prototype.setItem, originalRemove = Storage.prototype.removeItem, originalClear = Storage.prototype.clear;
    Storage.prototype.getItem = function(...args) { if (args[0] === key) { state.reads++; event('get'); } return Reflect.apply(originalGet, this, args); };
    Storage.prototype.setItem = function(...args) { if (args[0] === key) { state.writes++; event('set'); } return Reflect.apply(originalSet, this, args); };
    Storage.prototype.removeItem = function(...args) { if (args[0] === key) { state.removes++; event('remove'); } return Reflect.apply(originalRemove, this, args); };
    Storage.prototype.clear = function(...args) { state.clears++; event('clear'); return Reflect.apply(originalClear, this, args); };
    const originalRequest = LockManager.prototype.request;
    LockManager.prototype.request = function(...args) {
      if (args[0] !== lockName) return Reflect.apply(originalRequest, this, args);
      state.locks++; state.lockPending++; const callback = args[args.length - 1];
      args[args.length - 1] = function(...values) {
        const exclusive = values[0]?.name === lockName && values[0]?.mode === 'exclusive';
        if (exclusive) { state.grants++; exclusiveDepth++; }
        try { return Reflect.apply(callback, this, values); } finally { if (exclusive) exclusiveDepth--; }
      };
      try { return returned(Reflect.apply(originalRequest, this, args), 'lockPending'); } catch (cause) { state.lockPending--; throw cause; }
    };
    const OriginalPeer = RTCPeerConnection;
    globalThis.RTCPeerConnection = new Proxy(OriginalPeer, { construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget); state.peersCreated++; peers.add(peer); return peer;
    } });
    for (const name of ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription']) {
      const original = OriginalPeer.prototype[name];
      OriginalPeer.prototype[name] = function(...args) { state.rtcCalls++; state.rtcPending++;
        try { return returned(Reflect.apply(original, this, args), 'rtcPending'); } catch (cause) { state.rtcPending--; throw cause; } };
    }
    globalThis.__rememberedNative = { state,
      snapshot: () => ({ ...state, openPeers: [...peers].filter(peer => peer.connectionState !== 'closed').length }),
      trace: () => events.map(value => ({ ...value })),
      read: () => Reflect.apply(originalGet, localStorage, [key]),
      write(value) { state.qaWrites++; if (value === null) Reflect.apply(originalRemove, localStorage, [key]); else Reflect.apply(originalSet, localStorage, [key, value]); },
    };
  }, { key, lockName, ownedOrigin: origin.origin });
  page = await openPage(); report.phase = 'inert-arrival';
  await arrive();
  assert.equal(await raw(), null); await check('inert-arrival-no-remembered-read-write-lock-key-or-peer');
  report.phase = 'actual-enrollment'; await press(page, 'Enroll resource device');
  const invitation = page.getByRole('textbox', { name: 'Receiver invitation', exact: true }); await invitation.waitFor();
  source = await openPage(); await source.goto(fixturePage);
  const label = `Owned software past name ${engine}`;
  const offer = await source.evaluate(async ({ url, invitation, label }) => (await import(url)).startSource(invitation, label),
    { url: fixtureURL, invitation: await invitation.inputValue(), label });
  await page.getByRole('textbox', { name: 'Complete resource offer', exact: true }).fill(offer); await press(page, 'Use resource offer');
  const answer = page.getByRole('textbox', { name: 'Receiver answer', exact: true }); await answer.waitFor();
  await source.evaluate(answer => globalThis.__rememberedSource.accept(answer), await answer.inputValue());
  const digest = page.locator('.devices-enrollment-digest'); await digest.waitFor();
  const compared = (await digest.textContent()).replace(/\s/g, ''); assert.match(compared, /^[a-f0-9]{64}$/);
  await source.waitForFunction(() => !!globalThis.__rememberedSource.comparison());
  assert.equal(await source.evaluate(() => globalThis.__rememberedSource.comparison()), compared);
  await press(source, 'Confirm owned source comparison'); await press(page, 'The complete codes match'); await press(page, 'Use enrolled resource device');
  await page.getByRole('heading', { name: `Inspect ${label}`, exact: true }).waitFor();
  await page.getByRole('heading', { name: 'software:counter', exact: true }).waitFor();
  await press(page, 'Remember this device in this browser'); assert.equal(await raw(), null);
  const saveStart = (await trace()).length;
  await press(page, 'Confirm remembering past device'); await outcome('saved'); await expectWrite(saveStart);
  const stored = await raw(), publicKeyId = await source.evaluate(() => globalThis.__rememberedSource.metrics().publicKeyId);
  const expected = { schemaVersion: 1, devices: [{ publicKeyId, label }] }; assert.match(publicKeyId, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(stored), expected); assert.equal(stored, JSON.stringify(expected));
  const saved = await native(); assert.equal(saved.writes, 1); assert.equal(saved.locks, 1); assert.equal(saved.grants, 1);
  assert.equal((await source.evaluate(() => globalThis.__rememberedSource.metrics())).binds, 0);
  await check('actual-bilateral-native-p256-rtc-remember-only-closed-public-metadata');
  report.phase = 'manual-export'; await press(page, 'Review public metadata export'); await outcome('reviewing');
  assert.equal(await page.getByRole('textbox', { name: 'Reviewed public metadata JSON', exact: true }).count(), 0);
  await press(page, 'Cancel metadata review'); assert.equal(await raw(), stored);
  await press(page, 'Review public metadata export'); await press(page, 'Confirm public metadata copy'); await outcome('exported');
  const copyBox = page.getByRole('textbox', { name: 'Reviewed public metadata JSON', exact: true });
  const copy = await copyBox.inputValue(); assert.equal(copy, stored);
  assert.equal(await copyBox.evaluate(element => element.readOnly && element === document.activeElement
    && element.selectionStart === 0 && element.selectionEnd === element.value.length), true);
  await press(page, 'Close metadata copy'); assert.equal(await copyBox.count(), 0);
  await check('cancelled-export-inert-confirmed-copy-exact-public-fields-manual-selection-close');
  await importReview(copy); await outcome('not-empty'); assert.equal(await raw(), stored);
  assert.equal(await page.getByRole('button', { name: 'Confirm restore into empty list', exact: true }).count(), 0);
  await press(page, 'Cancel restore'); await check('nonempty-restore-refused-existing-bytes-preserved');
  report.phase = 'connection-retirement'; await press(page, 'Stop resource connections');
  const stopped = await source.evaluate(() => globalThis.__rememberedSource.stop());
  assert.deepEqual(stopped, { rawPending: 0, timerArmed: false, state: 'disconnected', stopped: true, listeners: 0 });
  report.cleanup.sourceStopJoined = true; await page.waitForFunction(() => globalThis.__rememberedNative.snapshot().openPeers === 0);
  assert.equal(await page.locator('.devices-enrolled-value').count(), 0); await forget();
  report.phase = 'restore'; const beforeRestore = await native(), empty = await raw();
  await importReview(copy); await press(page, 'Cancel metadata review'); assert.equal(await raw(), empty);
  await importReview(copy); const restoreStart = (await trace()).length;
  await press(page, 'Confirm restore into empty list'); await outcome('restored'); await expectWrite(restoreStart); assert.equal(await raw(), copy);
  assert.equal(await page.getByRole('heading', { name: `Inspect ${label}`, exact: true }).count(), 0);
  assert.ok((await memory().textContent()).includes('Offline — past pairing only'));
  const afterRestore = await native(); assert.equal(afterRestore.identityCryptoCalls, beforeRestore.identityCryptoCalls);
  assert.equal(afterRestore.peersCreated, beforeRestore.peersCreated); assert.equal(afterRestore.writes, beforeRestore.writes + 1);
  await check('cancelled-import-inert-restored-records-offline-no-new-peer-key-or-preview');
  report.phase = 'new-native-document-offline-read'; await retireDocument(page, true); page = await openPage(); await arrive();
  assert.equal(await raw(), copy); await press(page, 'Show remembered devices'); await outcome('ready');
  assert.ok((await memory().textContent()).includes('Offline — past pairing only'));
  assert.equal(await page.getByRole('heading', { name: `Inspect ${label}`, exact: true }).count(), 0);
  assert.equal(await page.locator('.devices-enrolled-value').count(), 0);
  const reopened = await native(); assert.equal(reopened.identityCryptoCalls, 0); assert.equal(reopened.peersCreated, 0);
  await check('distinct-native-document-inert-then-explicit-stored-record-read-offline');
  report.phase = 'changed-review'; await press(page, 'Review public metadata export'); await mutate(copy + ' ');
  await press(page, 'Confirm public metadata copy'); await outcome('conflict'); assert.equal(await raw(), copy + ' ');
  assert.equal(await page.getByRole('textbox', { name: 'Reviewed public metadata JSON', exact: true }).count(), 0);
  await press(page, 'Show remembered devices'); await outcome('ready'); await forget();
  await importReview(copy); await mutate('{"schemaVersion":1,"devices":[]} ');
  await press(page, 'Confirm restore into empty list'); await outcome('conflict'); assert.equal(await raw(), '{"schemaVersion":1,"devices":[]} ');
  await check('native-external-raw-change-after-export-and-empty-import-review-refused');
  report.phase = 'invalid-preservation';
  for (const [value, result] of [['broken-owned-json', 'corrupt'], ['{"schemaVersion":2,"devices":[]}', 'future']]) {
    await mutate(value); await importReview(copy); await outcome(result); assert.equal(await raw(), value); await press(page, 'Cancel restore');
  }
  await mutate(null);
  const invalid = JSON.stringify({ ...expected, credentials: 'deliberate-owned-negative-field' });
  await importReview(invalid); await outcome('invalid-backup'); assert.equal(await raw(), null); await press(page, 'Cancel restore');
  await check('corrupt-future-store-and-open-field-backup-refused-without-overwrite');
  report.phase = 'actual-expiry'; await importReview(copy);
  const reviewedAt = Date.now(); await page.waitForTimeout(30100);
  await press(page, 'Confirm restore into empty list'); await outcome('expired'); assert.equal(await raw(), null);
  report.actualReviewExpiryElapsedMs = Date.now() - reviewedAt; await check('real-thirty-second-review-expiry-no-write');
  report.phase = 'queued-native-lock-cancel'; await importReview(copy); await holdLock();
  const beforeQueued = await native(); await press(page, 'Confirm restore into empty list');
  await page.waitForFunction(() => globalThis.__rememberedNative.state.lockPending === 1);
  const queued = await source.evaluate(async lockName => (await navigator.locks.query()).pending.filter(lock => lock.name === lockName && lock.mode === 'exclusive').length, lockName);
  assert.equal(queued, 1); await press(page, 'Cancel remembered-device change'); await outcome('stopped');
  const cancelled = await native(); assert.equal(cancelled.lockPending, 0); assert.equal(cancelled.grants, beforeQueued.grants);
  assert.equal(await raw(), null); await releaseLock(); await check('native-exclusive-lock-queued-cancel-real-rejection-joined-no-write');
  report.phase = 'queued-native-lock-unmount'; await importReview(copy); await holdLock();
  await press(page, 'Confirm restore into empty list'); await page.waitForFunction(() => globalThis.__rememberedNative.state.lockPending === 1);
  await retireDocument(page, true); await releaseLock();
  assert.equal(await source.evaluate(() => globalThis.__rememberedNative.read()), null);
  report.checks.push('real-framework-unmount-aborts-queued-native-lock-return-before-document-retirement');
  guard();
} catch (cause) {
  retain(cause);
  try { if (page && !retired.has(page)) report.failurePageState = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(element => element.textContent === 'Enroll resource device');
    const rect = button?.getBoundingClientRect(), style = button ? getComputedStyle(button) : undefined;
    const runtime = globalThis[Symbol.for('vinext.navigationRuntime')];
    return { url: location.pathname, readyState: document.readyState, hidden: document.hidden,
      title: document.title, frameworkRoot: typeof globalThis.__VINEXT_RSC_ROOT__?.unmount,
      navigationOwner: typeof runtime?.functions?.notifyLinkNavigationStart,
      prefetchCache: globalThis.__VINEXT_RSC_PREFETCH_CACHE__ instanceof Map,
      button: button && { disabled: button.disabled, rect: rect.toJSON(), display: style.display, visibility: style.visibility,
        ancestors: [...function* () { let element = button.parentElement; while (element) {
          const css = getComputedStyle(element); yield { tag: element.tagName, class: element.className, hidden: element.hidden, display: css.display, visibility: css.visibility }; element = element.parentElement;
        } }()] }, native: globalThis.__rememberedNative?.snapshot() };
  }); } catch (diagnosticFailure) { retain(diagnosticFailure); }
}
finally {
  report.phase = 'cleanup';
  try { if (source && !retired.has(source)) {
    const stopped = await source.evaluate(async () => globalThis.__rememberedSource ? globalThis.__rememberedSource.stop() : undefined);
    if (stopped) { assert.equal(stopped.rawPending, 0); assert.equal(stopped.timerArmed, false); assert.equal(stopped.state, 'disconnected'); report.cleanup.sourceStopJoined = true; }
  } } catch (cause) { retain(cause); }
  try { if (source && !retired.has(source)) await releaseLock(); } catch (cause) { retain(cause); }
  for (const selected of pages) try { await retireDocument(selected, selected !== source); } catch (cause) { retain(cause); }
  report.cleanup.documentsRetired = pages.length >= 2 && !!source && retired.size === pages.length;
  report.cleanup.nativeReturnsJoined = report.cleanup.documentsRetired && report.documentRetirements.every(item =>
    item.native.cryptoPending === 0 && item.native.rtcPending === 0 && item.native.lockPending === 0 && item.native.openPeers === 0);
  // This context is owned by this run. Removal happens after all writers and
  // callback returns retire, before closing its actual native pages/profile.
  try { if (context && report.cleanup.sourceStopJoined && report.cleanup.nativeReturnsJoined) { const cleanupPage = await context.newPage();
    await cleanupPage.goto(fixturePage); await cleanupPage.evaluate(() => globalThis.__rememberedNative.write(null));
    assert.equal(await cleanupPage.evaluate(() => globalThis.__rememberedNative.read()), null);
    await cleanupPage.goto('about:blank'); await cleanupPage.close(); report.cleanup.ownedStorageRemoved = true;
  } } catch (cause) { retain(cause); }
  try { for (const selected of pages) await selected.close(); if (context) report.cleanup.pagesClosed = context.pages().length === 0; } catch (cause) { retain(cause); }
  try { if (context) { await context.close(); report.cleanup.contextCloseAwaited = true; } } catch (cause) { retain(cause); }
  try { if (browser) { await browser.close(); report.cleanup.browserClosed = true; } } catch (cause) { retain(cause); }
  try { await joinRequests(); guard(); report.finalPinsVerified = true; } catch (cause) { retain(cause); }
  report.matchedBuildResponses = seen.size;
  try { assert.ok(seen.has(fixtureURL) && seen.size > 2); assert.equal(report.pageErrors.length, 0); assert.equal(report.failedRequests.length, 0);
    assert.equal(report.foreignRequests, 0); assert.equal(report.socketAttempts, 0); assert.ok(Object.values(report.cleanup).every(Boolean));
    assert.ok(report.nativeArrivals.every(state => !state.traceOverLimit) && report.nativeBoundaries.every(state => !state.traceOverLimit));
  } catch (cause) { retain(cause); }
  report.status = failure ? 'fail' : 'pass'; writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
if (failure) { console.error(JSON.stringify(report.failures)); process.exitCode = 1; }
else console.log(JSON.stringify({ status: report.status, engine, checks: report.checks.length, output }));
