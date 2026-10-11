import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

// Native QA of the built player UI. Caller owns the exact loopback server.
// Example: node tools/qa-screen-player.mjs ORIGIN ABS_PROOF ENGINE ABS_FRESH_OUTPUT
// Proof pins the candidate source and actual emitted server/client bytes.
// A browser without observable restrictive capture policy remains unqualified.
const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
assert.equal(args.length, 4, 'origin, served proof, engine, fresh output file');
const origin = new URL(args[0]), proofPath = resolve(args[1]), engine = args[2], output = resolve(args[3]);
assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/' && !origin.search && !origin.hash);
assert.ok(!origin.username && !origin.password && ['chromium', 'webkit'].includes(engine));
assert.ok(isAbsolute(output) && !existsSync(output));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const regular = path => { const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink()); return readFileSync(path); };
const proofRaw = regular(proofPath), proof = JSON.parse(proofRaw), harnessSHA = hash(regular(import.meta.filename));
const required = ['app/connections/screen/page.tsx', 'app/connections/screen/ScreenView.tsx', 'app/connections/screen/screen-task.ts',
  'examples/browser-resources/screen-preview.ts', 'packages/device-web/src/browser-screen-preview.ts', 'packages/connect/src/index.ts',
  'app/connections/resources/resource-task.module.css', 'app/globals.css', 'vite.config.ts', 'package-lock.json'];
const report = { schemaVersion: 1, status: 'pending', engine, sourceTree: proof.sourceTree,
  phase: 'source-build-pins', harnessSHA, proofSHA: hash(proofRaw), checks: [], keyboard: [], responses: [], native: [], retirements: [],
  errors: [], cleanupErrors: [], cleanup: {}, scope: 'Selected unchanged built player permission refusal and keyboard recovery; no successful OS capture, chooser cancellation, physical screen or named assistive technology acceptance.' };
let server, browser, context, page, child, childClosed, failure, closeJob;
const responseJobs = new Set(), requests = new Map(), matched = new Map(); let count = 0, servedBytes = 0;
const ownedCloseJobs = new Map();
let visitedScreen = false, expectedRetirements = 0;
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
async function retireScreenDocument() {
  if (!visitedScreen || page.isClosed()) return;
  if (await page.locator('[data-screen-phase]').count()) {
    const button = page.getByRole('button', { name: 'Stop preview access', exact: true });
    // Cleanup uses a native click; journey keyboard claims are recorded separately.
    if (await button.isEnabled()) await button.click();
    await page.waitForFunction(() => { const main = document.querySelector('[data-screen-phase]');
      return main?.dataset.screenPending === '0' && globalThis.__screenQA.snapshot().pending === 0;
    }, undefined, { timeout: 30000 });
    await page.getByRole('link', { name: 'Back to Connections', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/connections');
  }
  await page.waitForFunction(count => globalThis.__screenQA.snapshot().retirements.length >= count && globalThis.__screenQA.snapshot().pending === 0,
    expectedRetirements, { timeout: 30000 });
  const native = await nativeSnapshot();
  for (const retired of native.retirements) {
    assert.equal(retired.phase, 'closed'); assert.equal(retired.rawPending, 0); assert.equal(retired.framePending, 0);
    assert.equal(retired.cleanupUnconfirmed, false); assert.deepEqual(retired.owned, { pipelines: 0, timers: 0 });
  }
  report.retirements = native.retirements; report.cleanup.documentTaskAndNativeReturnsJoined = true;
}
async function nativeSnapshot() { return page.evaluate(() => globalThis.__screenQA.snapshot()); }
async function inactive() {
  await page.waitForFunction(() => { const main = document.querySelector('[data-screen-phase]'); return main?.dataset.screenPending === '0' && main.dataset.screenPreview === 'false'; });
  assert.equal(await page.locator('canvas').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Remove capture permission', exact: true }).isDisabled(), true);
  const observed = await nativeSnapshot(); assert.equal(observed.pending, 0); assert.equal(observed.resolved, 0); return observed;
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
      if (request.isNavigationRequest()) {
        // The browser receives a real restrictive policy; HTML stays unchanged.
        const response = await route.fetch({ maxRedirects: 0, timeout: 30000 });
        assert.ok(response.status() < 300 || response.status() >= 400, 'Redirects cannot escape the loopback route guard');
        assert.equal(new URL(response.url()).origin, origin.origin);
        const body = await response.body();
        await route.fulfill({ response, body, headers: { ...response.headers(), 'permissions-policy': 'display-capture=()' } }); return;
      }
      await route.continue();
    })().catch(async error => { report.errors.push(String(error)); try { await route.abort(); } catch { /* Already answered by native teardown. */ } })
      .finally(() => responseJobs.delete(job));
    responseJobs.add(job); return job;
  });
  await context.routeWebSocket('**/*', socket => { report.errors.push('Unexpected page WebSocket'); socket.close(); });
  await context.addInitScript(() => {
    const observations = { calls: 0, pending: 0, resolved: 0, refused: [], policy: null, options: [], returnedStreams: [], retirements: [] };
    const media = navigator.mediaDevices, native = media?.getDisplayMedia;
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    observations.policy = policy?.allowsFeature('display-capture') ?? null;
    if (typeof native === 'function') {
      media.getDisplayMedia = function (...args) {
        observations.calls++; observations.pending++; observations.options.push(args[0]);
        let returned;
        try { returned = Reflect.apply(native, this, args); }
        catch (error) { observations.pending--; observations.refused.push(error.name); throw error; }
        // Passive observation leaves the original native promise/value and rejection intact.
        void Promise.resolve(returned).then(stream => { observations.resolved++; observations.returnedStreams.push(stream); },
          error => { observations.refused.push(error.name); }).finally(() => { observations.pending--; });
        return returned;
      };
    }
    addEventListener('101-local-screen-retired', event => observations.retirements.push(event.detail));
    globalThis.__screenQA = { snapshot: () => ({ calls: observations.calls, pending: observations.pending, resolved: observations.resolved,
      refused: [...observations.refused], policy: observations.policy, options: observations.options,
      nativeMethodAvailable: typeof native === 'function', retirements: observations.retirements }),
      stopUnexpected: () => { for (const stream of observations.returnedStreams) for (const track of stream.getTracks()) track.stop(); } };
  });
  context.on('request', request => { let resolveClosed; const closed = new Promise(done => { resolveClosed = done; }); requests.set(request, { closed, resolveClosed }); });
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
  report.phase = 'built-player-arrival';
  const response = await page.goto(new URL('/connections/screen', origin).href, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200); assert.equal(response.headers()['permissions-policy'], 'display-capture=()');
  await page.getByRole('heading', { name: 'Brief screen preview', exact: true }).waitFor();
  const review = page.getByRole('button', { name: 'Review screen preview', exact: true }); await review.click({ trial: true });
  visitedScreen = true; expectedRetirements = 1;
  report.native.push(await inactive()); assert.equal(report.native.at(-1).calls, 0);
  assert.equal(await page.locator('[data-screen-phase]').getAttribute('data-screen-phase'), 'idle');
  report.checks.push('inert-built-player-arrival-no-capture-or-display');
  report.phase = 'separate-keyboard-approvals';
  await activate('Review screen preview');
  const choose = page.getByRole('button', { name: 'Choose a screen or window', exact: true }); assert.equal(await choose.isDisabled(), true);
  await activate('Allow selected screen capture'); assert.equal(await choose.isDisabled(), true);
  await activate('Allow preview frames'); assert.equal(await choose.isDisabled(), true);
  assert.equal((await nativeSnapshot()).calls, 0); await activate('Allow display on this page'); assert.equal(await choose.isDisabled(), false);
  report.checks.push('three-separate-native-keyboard-approvals-before-capture');
  report.phase = 'native-refusal';
  const beforeChoose = await nativeSnapshot(); report.native.push(beforeChoose);
  if (beforeChoose.nativeMethodAvailable) assert.equal(beforeChoose.policy, false,
    'Native capture cannot be issued unless this browser reports restrictive policy enforcement; absent policy support remains unqualified');
  await activate('Choose a screen or window');
  await page.waitForFunction(() => document.querySelector('[data-screen-phase]')?.dataset.screenPhase === 'stopped');
  const refusal = await inactive(); report.native.push(refusal);
  if (refusal.nativeMethodAvailable) {
    assert.equal(refusal.policy, false); assert.equal(refusal.calls, 1); assert.deepEqual(refusal.refused, ['NotAllowedError']);
    assert.deepEqual(refusal.options, [{ video: true, audio: false }]);
    assert.match(await page.getByRole('status').textContent(), /Screen sharing was not allowed/);
  } else {
    assert.equal(refusal.calls, 0); assert.match(await page.getByRole('status').textContent(), /This browser cannot start this preview/);
  }
  report.checks.push('actual-native-policy-refusal-or-native-capability-unavailable-guidance');
  if (refusal.nativeMethodAvailable) {
    report.phase = 'actionable-refusal-recovery-guidance';
    assert.equal(await review.isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Stop preview access', exact: true }).isDisabled(), true);
    const guidance = await page.getByRole('status').textContent();
    assert.doesNotMatch(guidance, /\bStop\b/, 'Refusal guidance must not require disabled Stop');
    assert.match(guidance, /Review screen preview/, 'Refusal guidance must name the available fresh-review action');
    report.checks.push('refusal-guidance-names-enabled-fresh-review-instead-of-disabled-stop');
  }
  report.phase = 'fresh-review-and-stop';
  await activate('Review screen preview');
  for (const name of ['Allow selected screen capture', 'Allow preview frames', 'Allow display on this page']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), false);
  assert.equal(await choose.isDisabled(), true); assert.equal((await nativeSnapshot()).calls, refusal.calls);
  await activate('Stop preview access', 'button', true); await inactive();
  assert.equal(await review.evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true);
  assert.match(await page.getByRole('status').textContent(), /Preview stopped/);
  report.checks.push('fresh-review-resets-independent-approvals-stop-returns-visible-focus');
  await activate('Review screen preview'); await activate('Cancel preview review'); await inactive();
  assert.equal(await review.evaluate(element => element === document.activeElement), true);
  report.checks.push('keyboard-cancel-review-no-new-native-capture');
  report.phase = 'native-framework-unmount';
  await activate('Back to Connections', 'link', true); await page.waitForURL(url => url.pathname === '/connections');
  await page.waitForFunction(() => globalThis.__screenQA.snapshot().retirements.length === 1);
  report.retirements = (await nativeSnapshot()).retirements;
  for (const retired of report.retirements) { assert.equal(retired.phase, 'closed'); assert.equal(retired.rawPending, 0); assert.equal(retired.framePending, 0);
    assert.equal(retired.cleanupUnconfirmed, false); assert.deepEqual(retired.owned, { pipelines: 0, timers: 0 }); }
  report.checks.push('actual-framework-unmount-awaited-task-close-zero-owned-work');
  await joinResponses(); guard(); assert.deepEqual(report.errors, []);
} catch (error) {
  failure ??= error;
  if (page && !page.isClosed()) try { report.failedPage = { text: (await page.locator('body').innerText()).slice(0, 8192),
    native: await nativeSnapshot(), url: page.url() }; } catch (observationError) { report.cleanupErrors.push(String(observationError)); }
}
finally {
  if (page && !page.isClosed()) {
    try { await page.evaluate(() => globalThis.__screenQA?.stopUnexpected()); } catch (error) { report.cleanupErrors.push(String(error)); }
    try { await retireScreenDocument(); } catch (error) { report.cleanup.documentTaskAndNativeReturnsJoined = false; report.cleanupErrors.push(String(error)); }
    try { await closeOwned('Page close', () => page.close()); report.cleanup.pageClosed = true; } catch (error) { report.cleanupErrors.push(String(error)); }
    // Page close ends background prefetch. Keep the browser connection alive
    // while observing actual request terminal events and route/body returns.
    try { await joinResponses(); report.cleanup.requestsJoinedBeforeContextClose = true; } catch (error) { report.cleanupErrors.push(String(error)); }
  }
  try { await closeOwned('Context close', () => context?.close()); report.cleanup.contextCloseAwaited = true; } catch (error) { report.cleanupErrors.push(String(error)); }
  try { await closeOwned('Browser close', () => browser?.close()); report.cleanup.browserCloseAwaited = true; } catch (error) { report.cleanupErrors.push(String(error)); }
  try { await bounded(closeServer(), 'Browser server close'); report.cleanup.browserServerCloseAwaited = true; } catch (error) { report.cleanupErrors.push(String(error)); }
  if (childClosed) try { await bounded(childClosed, 'Actual native child close'); report.cleanup.actualNativeChildCloseAwaited = true; }
    catch (error) { report.cleanup.actualNativeChildCloseAwaited = false; report.cleanup.unresolvedOwnedNativePID = child.pid; report.cleanupErrors.push(String(error)); }
  try { await bounded(Promise.allSettled([...ownedCloseJobs.values()].map(value => value.work)), 'Previously issued close returns'); }
    catch (error) { report.cleanupErrors.push(String(error)); }
  report.cleanup.ownedCloseOperations = [...ownedCloseJobs.values()].map(value => value.record);
  report.cleanup.allIssuedCloseReturnsJoined = report.cleanup.ownedCloseOperations.every(value => value.settled);
  try { await joinResponses(); report.cleanup.requestAndBodyReturnsJoined = true; } catch (error) { report.cleanupErrors.push(String(error)); }
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
