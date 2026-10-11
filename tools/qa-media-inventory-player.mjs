import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

// Native QA of the built player UI. Caller owns the exact loopback server.
// Example: node tools/qa-media-inventory-player.mjs ORIGIN ABS_PROOF ENGINE ABS_FRESH_OUTPUT
// Proof pins the candidate source and actual emitted server/client bytes.
// Inventory only: capture stays at zero; no OS chooser is opened.
const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
assert.equal(args.length, 4, 'origin, served proof, engine, fresh output file');
const origin = new URL(args[0]), proofPath = resolve(args[1]), engine = args[2], output = resolve(args[3]);
assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/' && !origin.search && !origin.hash);
assert.ok(!origin.username && !origin.password && ['chromium', 'webkit'].includes(engine));
assert.ok(isAbsolute(output) && !existsSync(output));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const regular = path => { const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink()); return readFileSync(path); };
const proofRaw = regular(proofPath), proof = JSON.parse(proofRaw), harnessSHA = hash(regular(import.meta.filename));
const required = ['app/connections/camera/page.tsx', 'app/connections/camera/CameraView.tsx', 'app/connections/camera/camera-task.ts',
  'app/connections/microphone/page.tsx', 'app/connections/microphone/MicrophoneView.tsx', 'app/connections/microphone/microphone-task.ts',
  'packages/device-web/src/browser-camera.ts', 'packages/device-web/src/browser-microphone.ts', 'packages/connect/src/index.ts',
  'app/connections/resources/resource-task.module.css', 'app/globals.css', 'vite.config.ts', 'package-lock.json'];
const report = { schemaVersion: 1, status: 'pending', engine, sourceTree: proof.sourceTree,
  phase: 'source-build-pins', harnessSHA, proofSHA: hash(proofRaw), checks: [], keyboard: [], responses: [], native: [], retirements: [],
  blockedPrefetch: [], lateRequestAnnouncements: [], errors: [], cleanupErrors: [], cleanup: {}, scope: 'Selected built camera/microphone inventory under restrictive native policy, keyboard recovery, fourth-attempt quota Stop/reload into a distinct inert document, and navigation. No capture approval/refusal, streams, physical devices, settings, named assistive technology or full support acceptance.' };
let pageClosing = false;
let server, browser, context, page, child, childClosed, failure, closeJob;
const responseJobs = new Set(), requests = new Map(), matched = new Map(); let count = 0, servedBytes = 0;
const ownedCloseJobs = new Map();
const ownedNavigationJobs = new Map();
let activeKind;
function guard() {
  assert.equal(hash(regular(proofPath)), report.proofSHA);
  for (const [path, sha] of Object.entries(proof.sourcePins)) assert.equal(hash(regular(join(root, path))), sha, path);
  for (const item of proof.buildInputs) assert.equal(hash(regular(item.path)), item.sha256, item.path);
  assert.equal(hash(regular(import.meta.filename)), harnessSHA);
}
for (const path of required) assert.equal(proof.sourcePins[path], hash(regular(join(root, path))), `Missing actual source pin ${path}`);
assert.equal(proof.origin, origin.origin); assert.match(proof.sourceTree, /^[a-f0-9]{40}$/); guard();
async function closeServer() { if (server) { closeJob ??= server.close(); await closeJob; } }
const interrupted = () => { failure ??= Error('Owned QA interrupted'); };
process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
const watchdog = setTimeout(() => { failure ??= Error('Original 60000ms QA deadline'); }, 60000);
async function bounded(work, label) {
  let timer;
  try { await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ': original30000ms cleanup deadline')), 30000); })]); }
  finally { clearTimeout(timer); }
}
async function closeOwned(label, invoke) {
  const record = { label, settled: false, status: 'pending' };
  const work = Promise.resolve(invoke()).then(() => { record.settled = true; record.status = 'fulfilled'; }, error => {
    record.settled = true; record.status = 'rejected'; throw error;
  });
  ownedCloseJobs.set(label, { record, work }); await bounded(work, label);
}
function observeNavigation(label, invoke) {
  assert.ok(!ownedNavigationJobs.has(label));
  const record = { label, settled: false, status: 'pending' };
  // Observe rejection before keyboard activation can fail. Keep the actual
  // issued wait until cleanup joins it, even when activation never returns.
  const work = invoke().then(response => {
    record.settled = true; record.status = 'fulfilled'; return { status: 'fulfilled', response };
  }, error => {
    record.settled = true; record.status = 'rejected'; record.error = String(error.message);
    return { status: 'rejected', error };
  });
  ownedNavigationJobs.set(label, { record, work }); return work;
}
async function joinResponses() {
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Original 30000ms response closure deadline')), 30000); });
    while (responseJobs.size || requests.size)
      await Promise.race([Promise.allSettled([...responseJobs, ...[...requests.values()].map(value => value.closed)]), deadline]);
  } catch (error) {
    report.cleanup.outstandingRequests = [...requests.keys()].map(request => ({ url: request.url(), failure: request.failure(), navigation: request.isNavigationRequest() }));
    report.cleanup.outstandingResponseJobs = responseJobs.size; throw error;
  } finally { clearTimeout(timer); }
}
async function activate(name, role = 'button', backwards = false) {
  if (failure) throw failure;
  const locator = page.getByRole(role, { name, exact: true }); await locator.click({ trial: true });
  const key = (backwards ? 'Shift+' : '') + (engine === 'webkit' ? 'Alt+Tab' : 'Tab');
  if (!await page.evaluate(() => document.hasFocus() && document.activeElement !== document.body)) {
    await page.getByRole('link', { name: 'Back to Connections', exact: true }).focus();
  }
  for (let step = 0; step <= 32; step++) {
    if (await locator.evaluate(element => document.hasFocus() && document.activeElement === element && element.matches(':focus-visible'))) {
      report.keyboard.push({ name, key, step, role }); await page.keyboard.press(role === 'link' ? 'Enter' : 'Space'); return;
    }
    if (step < 32) await page.keyboard.press(key);
  }
  assert.fail('Actual native keyboard target unavailable: ' + name);
}
async function nativeSnapshot() { return page.evaluate(() => globalThis.__mediaInventoryQA.snapshot()); }
async function retireDocument() {
  if (!activeKind || page.isClosed()) return;
  const name = activeKind === 'camera' ? 'Stop camera access' : 'Stop';
  const button = page.getByRole('button', { name, exact: true });
  if (await button.count() && await button.isEnabled()) await button.click();
  const back = page.getByRole('link', { name: 'Back to Connections', exact: true });
  if (await back.count()) { await back.click(); await page.waitForURL(url => url.pathname === '/connections'); }
  await page.waitForFunction(() => globalThis.__mediaInventoryQA.snapshot().pending === 0);
  const native = await nativeSnapshot();
  assert.equal(native.captureCalls, 0);
  report.native.push({ kind: activeKind, stage: 'retired-after-navigation', ...native });
  for (const retired of native.retirements) {
    assert.equal(retired.phase, 'closed'); assert.equal(retired.rawPending, 0); assert.equal(retired.captureCallbacksPending, 0);
    assert.equal(retired.cleanupUnconfirmed, false); assert.deepEqual(retired.owned, { callers: 0, timers: 0 });
  }
  report.retirements.push(...native.retirements);
  report.cleanup.nativeInventoryReturnsJoined = true;
  activeKind = undefined;
}
try {
  report.phase = 'native-browser-launch';
  server = await ({ chromium, webkit }[engine]).launchServer({ headless: true });
  child = server.process(); assert.ok(child?.pid); report.nativeChild = { pid: child.pid, spawnfile: child.spawnfile,
    executableOrLauncherSHA: hash(regular(realpathSync(child.spawnfile))) };
  childClosed = new Promise(resolveClosed => child.once('close', (code, signal) => { Object.assign(report.nativeChild, { code, signal, actualCloseObserved: true }); resolveClosed(); }));
  browser = await ({ chromium, webkit }[engine]).connect(server.wsEndpoint()); report.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', acceptDownloads: false });
  context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(10000);
  await context.route('**/*', route => {
    const job = (async () => {
      const request = route.request(), url = new URL(request.url()); count++;
      if (url.origin !== origin.origin || count > 1024) { report.errors.push('Foreign or over-budget request'); return route.abort(); }
      if (url.searchParams.has('_rsc') && request.headers()['next-router-prefetch'] === '1') {
        report.blockedPrefetch.push({ path: url.pathname, purpose: request.headers()['purpose'] ?? null, routerPrefetch: request.headers()['next-router-prefetch'] ?? null });
        return route.abort();
      }
      if (request.isNavigationRequest()) {
        // The browser receives a real restrictive policy; HTML stays unchanged.
        const response = await route.fetch({ maxRedirects: 0, timeout: 30000 });
        assert.ok(response.status() < 300 || response.status() >= 400, 'Redirects cannot escape the loopback route guard');
        assert.equal(new URL(response.url()).origin, origin.origin);
        const body = await response.body();
        await route.fulfill({ response, body, headers: { ...response.headers(), 'permissions-policy': 'camera=(), microphone=()' } }); return;
      }
      await route.continue();
    })().catch(async error => { report.errors.push(String(error)); try { await route.abort(); } catch { /* Already answered by native teardown. */ } })
      .finally(() => responseJobs.delete(job));
    responseJobs.add(job); return job;
  });
  await context.routeWebSocket('**/*', socket => { report.errors.push('Unexpected page WebSocket'); socket.close(); });
  await context.addInitScript(() => {
    const observations = { enumerations: [], captureCalls: 0, pending: 0, returnedStreams: [], retirements: [] };
    const documentId = crypto.randomUUID();
    const media = navigator.mediaDevices, policy = document.permissionsPolicy ?? document.featurePolicy;
    const features = { camera: policy?.allowsFeature('camera') ?? null, microphone: policy?.allowsFeature('microphone') ?? null };
    const observers = {}, available = {};
    for (const method of ['enumerateDevices', 'getUserMedia']) {
      const native = media?.[method]; available[method] = typeof native === 'function';
      if (typeof native !== 'function') continue;
      const observed = function (...args) {
        const record = { method, status: 'pending' };
        if (method === 'getUserMedia') observations.captureCalls++;
        else observations.enumerations.push(record);
        observations.pending++;
        let returned;
        try { returned = Reflect.apply(native, this, args); }
        catch (error) { observations.pending--; record.status = 'rejected'; record.error = error.name; throw error; }
        void Promise.resolve(returned).then(value => {
          record.status = 'fulfilled';
          if (method === 'enumerateDevices') record.devices = value.map(item => ({ kind: item.kind, hasId: item.deviceId !== '', hasLabel: item.label !== '' }));
          else observations.returnedStreams.push(value);
        }, error => { record.status = 'rejected'; record.error = error.name; }).finally(() => { observations.pending--; });
        return returned;
      };
      observers[method] = observed; media[method] = observed;
    }
    addEventListener('101-local-camera-retired', event => observations.retirements.push(event.detail));
    globalThis.__mediaInventoryQA = { snapshot: () => ({ enumerations: observations.enumerations.map(item => ({ ...item })),
      documentId, captureCalls: observations.captureCalls, pending: observations.pending, features, available,
      observersInstalled: Object.fromEntries(Object.keys(available).map(method => [method, navigator.mediaDevices?.[method] === observers[method]])), retirements: observations.retirements }),
      stopUnexpected: () => { for (const stream of observations.returnedStreams) for (const track of stream.getTracks()) track.stop(); } };
  });
  context.on('request', request => {
    if (pageClosing) { report.lateRequestAnnouncements.push({ path: new URL(request.url()).pathname }); return; }
    let resolveClosed; const closed = new Promise(done => { resolveClosed = done; }); requests.set(request, { closed, resolveClosed }); });
  for (const event of ['requestfinished', 'requestfailed']) context.on(event, request => { const value = requests.get(request); if (value) { requests.delete(request); value.resolveClosed(); } });
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(String(error)));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== origin.origin || !/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/.test(response.headers()['content-type'] ?? '')) return;
    const job = (async () => {
      const raw = await response.body(); servedBytes += raw.length; assert.ok(servedBytes <= 64 * 1024 * 1024);
      const path = join(root, 'dist/client', '.' + url.pathname), pin = proof.buildInputs.find(item => item.kind === 'client' && item.path === path);
      assert.ok(pin); assert.equal(hash(raw), pin.sha256); assert.equal(response.status(), 200);
      matched.set(url.pathname, { sha256: hash(raw), bytes: raw.length });
    })().catch(error => report.errors.push(String(error))).finally(() => responseJobs.delete(job)); responseJobs.add(job);
  });
  for (const kind of ['camera', 'microphone']) {
    report.phase = kind + '-built-player-arrival';
    const response = await page.goto(new URL('/connections/' + kind, origin).href, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200); assert.equal(response.headers()['permissions-policy'], 'camera=(), microphone=()');
    activeKind = kind;
    const findName = kind === 'camera' ? 'List cameras' : 'Find inputs', stopName = kind === 'camera' ? 'Stop camera access' : 'Stop';
    const find = page.getByRole('button', { name: findName, exact: true }); await find.click({ trial: true });
    const initial = await nativeSnapshot();
    assert.deepEqual(initial.available, { enumerateDevices: true, getUserMedia: true }, 'Native media methods required for this qualification');
    assert.deepEqual(initial.observersInstalled, { enumerateDevices: true, getUserMedia: true }, 'Passive native observers must be installed on the actual media object');
    assert.equal(initial.captureCalls, 0); assert.equal(initial.enumerations.length, 0);
    report.native.push({ kind, stage: 'arrival', ...initial });
    report.checks.push(kind + '-inert-arrival-no-inventory-or-capture');
    await activate(findName);
    await page.waitForFunction(() => globalThis.__mediaInventoryQA.snapshot().enumerations.length === 1 && globalThis.__mediaInventoryQA.snapshot().pending === 0);
    const result = await nativeSnapshot(); report.native.push({ kind, stage: 'inventory', ...result });
    assert.equal(result.captureCalls, 0); assert.equal(result.enumerations[0].status, 'fulfilled');
    assert.equal(result.enumerations[0].devices.some(item => item.kind === (kind === 'camera' ? 'videoinput' : 'audioinput') && item.hasId), false);
    // Restrictive policy may be inspectable only in Chromium. Enumeration still
    // performs no capture; absent policy inspection is recorded, never promoted.
    if (engine === 'chromium') assert.equal(result.features[kind], false);
    const status = page.locator('p[role="status"]');
    if (kind === 'camera') await page.waitForFunction(() => document.querySelector('[data-camera-phase]')?.dataset.cameraPhase === 'choice');
    else await status.filter({ hasText: /No input is available/ }).waitFor();
    report.inventoryGuidance = { kind, text: await status.textContent() };
    assert.match(report.inventoryGuidance.text, /No (?:camera|input) is available/, 'Empty inventory must explain the missing input instead of requiring a disabled choice');
    const selector = page.getByRole('combobox');
    if (await selector.count()) assert.equal(await selector.isDisabled(), true);
    for (const name of kind === 'camera' ? ['Review selected camera'] : ['Review microphone processing', 'Review microphone readings', 'Review level display'])
      assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: stopName, exact: true }).isEnabled(), true);
    assert.match(await status.textContent(), /(?:browser|access).*(?:stop|Stop)/);
    report.checks.push(kind + '-actual-native-empty-inventory-actionable-guidance-no-capture');
    await activate(stopName);
    if (kind === 'camera') {
      await page.waitForFunction(() => document.querySelector('[data-camera-phase]')?.dataset.cameraPhase === 'stopped');
      report.stopFocus = await find.evaluate(element => ({ expectedActive: element === document.activeElement, visible: element.matches(':focus-visible'), disabled: element.disabled, actual: document.activeElement?.textContent?.slice(0, 100), documentFocused: document.hasFocus() }));
      await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'List cameras'); return button === document.activeElement && button.matches(':focus-visible'); });
    } else {
      await status.filter({ hasText: /Microphone use stopped/ }).waitFor();
      await page.waitForFunction(() => { const status = document.querySelector('p[role="status"]'); return status === document.activeElement && status.matches(':focus-visible'); });
    }
    assert.equal(await find.isEnabled(), true);
    await activate(findName);
    await page.waitForFunction(() => globalThis.__mediaInventoryQA.snapshot().enumerations.length === 2 && globalThis.__mediaInventoryQA.snapshot().pending === 0);
    await status.filter({ hasText: /No (?:camera|input) is available/ }).waitFor();
    const retried = await nativeSnapshot();
    assert.equal(retried.captureCalls, 0);
    assert.deepEqual(retried.observersInstalled, { enumerateDevices: true, getUserMedia: true });
    report.checks.push(kind + '-keyboard-stop-visible-focus-fresh-native-inventory');
    report.phase = kind + '-quota-recovery';
    const reload = page.getByRole('button', { name: 'Reload this page', exact: true });
    assert.equal(await reload.count(), 0);
    for (let attempt = 3; attempt <= 4; attempt++) {
      await activate(stopName);
      await status.filter({ hasText: /(?:Camera access|Microphone use) stopped/ }).waitFor();
      assert.equal(await find.isEnabled(), true);
      await activate(findName);
      await page.waitForFunction(expected => globalThis.__mediaInventoryQA.snapshot().enumerations.length === expected && globalThis.__mediaInventoryQA.snapshot().pending === 0, attempt);
      await status.filter({ hasText: /No (?:camera|input) is available/ }).waitFor();
    }
    assert.equal(await find.isDisabled(), true);
    assert.equal(await reload.isDisabled(), true, 'Reload cannot leave a live inventory owner');
    await activate(stopName);
    await status.filter({ hasText: /(?:Camera access|Microphone use) stopped/ }).waitFor();
    assert.match(await status.textContent(), /limit.*reload/i);
    await page.waitForFunction(() => { const status = document.querySelector('p[role="status"]'); return status === document.activeElement && status.matches(':focus-visible'); });
    assert.equal(await reload.isEnabled(), true);
    const quota = await nativeSnapshot();
    assert.equal(quota.enumerations.length, 4); assert.equal(quota.captureCalls, 0); assert.equal(quota.pending, 0);
    assert.deepEqual(quota.observersInstalled, { enumerateDevices: true, getUserMedia: true });
    report.native.push({ kind, stage: 'stopped-at-quota', ...quota });
    report.checks.push(kind + '-four-native-inventories-quota-stop-visible-status-focus-reload-guidance');
    report.phase = kind + '-fresh-document-reload';
    const navigation = observeNavigation(kind + ' reload', () => page.waitForNavigation({ waitUntil: 'networkidle' }));
    await activate('Reload this page'); const navigationResult = await navigation;
    if (navigationResult.status === 'rejected') throw navigationResult.error;
    const reloadedResponse = navigationResult.response;
    assert.equal(reloadedResponse.status(), 200);
    assert.equal(reloadedResponse.headers()['permissions-policy'], 'camera=(), microphone=()');
    await find.click({ trial: true });
    const fresh = await nativeSnapshot();
    assert.notEqual(fresh.documentId, quota.documentId);
    assert.deepEqual(fresh.enumerations, []); assert.equal(fresh.captureCalls, 0); assert.equal(fresh.pending, 0);
    assert.deepEqual(fresh.available, { enumerateDevices: true, getUserMedia: true });
    assert.deepEqual(fresh.observersInstalled, { enumerateDevices: true, getUserMedia: true });
    assert.equal(await reload.count(), 0);
    report.native.push({ kind, stage: 'distinct-inert-reloaded-document', ...fresh });
    await activate(findName);
    await page.waitForFunction(() => globalThis.__mediaInventoryQA.snapshot().enumerations.length === 1 && globalThis.__mediaInventoryQA.snapshot().pending === 0);
    await status.filter({ hasText: /No (?:camera|input) is available/ }).waitFor();
    const foundAfterReload = await nativeSnapshot();
    assert.equal(foundAfterReload.captureCalls, 0);
    assert.deepEqual(foundAfterReload.observersInstalled, { enumerateDevices: true, getUserMedia: true });
    report.native.push({ kind, stage: 'fresh-reloaded-native-inventory', ...foundAfterReload });
    report.checks.push(kind + '-keyboard-reload-distinct-inert-document-fresh-native-inventory');
    await activate(stopName);
    await activate('Back to Connections', 'link', true); await page.waitForURL(url => url.pathname === '/connections');
    if (kind === 'camera') await page.waitForFunction(() => globalThis.__mediaInventoryQA.snapshot().retirements.length === 1);
    await retireDocument();
    report.checks.push(kind + '-keyboard-navigation-native-inventory-returns-joined');
  }
  await joinResponses(); guard(); assert.deepEqual(report.errors, []);
} catch (error) {
  failure ??= error;
  if (page && !page.isClosed()) try { report.failedPage = { text: (await page.locator('body').innerText()).slice(0, 8192),
    native: await nativeSnapshot(), url: page.url() }; } catch (observationError) { report.cleanupErrors.push(String(observationError)); }
}
finally {
  if (page && !page.isClosed()) {
    try { await page.evaluate(() => globalThis.__mediaInventoryQA?.stopUnexpected()); } catch (error) { report.cleanupErrors.push(String(error)); }
    try { await retireDocument(); } catch (error) { report.cleanup.nativeInventoryReturnsJoined = false; report.cleanupErrors.push(String(error)); }
    try { await joinResponses(); report.cleanup.requestsJoinedBeforePageClose = true; } catch (error) { report.cleanupErrors.push(String(error)); }
    // Events announced after native page closure begins cannot establish a live
    // request owner. Keep them explicit; actual route/body jobs remain tracked.
    pageClosing = true;
    try { await closeOwned('Page close', () => page.close()); report.cleanup.pageClosed = true; } catch (error) { report.cleanupErrors.push(String(error)); }
    // Page close ends background prefetch. Keep the browser connection alive
    // while observing actual request terminal events and route/body returns.
    try { await joinResponses(); report.cleanup.requestsJoinedBeforeContextClose = true; } catch (error) { report.cleanupErrors.push(String(error)); }
  }
  try { await closeOwned('Context close', () => context?.close()); report.cleanup.contextCloseAwaited = true; } catch (error) { report.cleanupErrors.push(String(error)); }
  try { await bounded(Promise.all([...ownedNavigationJobs.values()].map(value => value.work)), 'Previously issued navigation returns'); }
    catch (error) { report.cleanupErrors.push(String(error)); }
  report.cleanup.ownedNavigationOperations = [...ownedNavigationJobs.values()].map(value => value.record);
  report.cleanup.allIssuedNavigationReturnsJoined = report.cleanup.ownedNavigationOperations.every(value => value.settled);
  try { await closeOwned('Browser close', () => browser?.close()); report.cleanup.browserCloseAwaited = true; } catch (error) { report.cleanupErrors.push(String(error)); }
  try { await bounded(closeServer(), 'Browser server close'); report.cleanup.browserServerCloseAwaited = true; } catch (error) { report.cleanupErrors.push(String(error)); }
  if (childClosed) try { await bounded(childClosed, 'Actual native child close'); report.cleanup.actualNativeChildCloseAwaited = true; }
    catch (error) { report.cleanup.actualNativeChildCloseAwaited = false; report.cleanup.unresolvedOwnedNativePID = child.pid; report.cleanupErrors.push(String(error)); }
  try { await bounded(Promise.allSettled([...ownedCloseJobs.values()].map(value => value.work)), 'Previously issued close returns'); }
    catch (error) { report.cleanupErrors.push(String(error)); }
  report.cleanup.ownedCloseOperations = [...ownedCloseJobs.values()].map(value => value.record);
  report.cleanup.allIssuedCloseReturnsJoined = report.cleanup.ownedCloseOperations.every(value => value.settled);
  try { await joinResponses(); report.cleanup.trackedPreCloseRequestsAndIssuedRouteBodyReturnsJoined = true; } catch (error) { report.cleanupErrors.push(String(error)); }
  clearTimeout(watchdog); report.cleanup.watchdogCleared = true;
  process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); report.cleanup.signalListenersRemoved = true;
  try { guard(); report.cleanup.finalPinsVerified = true; } catch (error) { report.cleanupErrors.push(String(error)); }
}
if (report.nativeChild?.actualCloseObserved && (report.nativeChild.code !== 0 || report.nativeChild.signal !== null)) failure ??= Error('Native child did not exit normally');
report.responses = [...matched].sort(([a], [b]) => a.localeCompare(b)); report.requests = count;
report.status = failure || report.cleanupErrors.length || report.errors.length ? 'fail' : 'pass';
if (failure) report.failure = { name: failure.name, message: String(failure.message).slice(0, 4096), stack: String(failure.stack).slice(0, 8192) };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: report.status, checks: report.checks, output }));
if (report.status !== 'pass') throw failure ?? Error('Observed QA/cleanup failure');
