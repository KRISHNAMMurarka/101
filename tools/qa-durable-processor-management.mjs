import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Root supplies a fresh immutable built app/server and owns all execution.
// No compiler, installation, server, child tool or SDK rebuild runs here.
// Native software QA only; no device, account or whole U12 acceptance.
const args = process.argv.slice(2), origin = new URL(args.shift()), options = new Map();
let featureRed = false, coldDocument = false;
while (args.length) {
  const name = args.shift();
  if (name === '--feature-red' && !featureRed) { featureRed = true; continue; }
  if (name === '--cold-document' && !coldDocument) { coldDocument = true; continue; }
  assert.ok(['--served-proof', '--engine', '--output'].includes(name) && !options.has(name));
  const value = args.shift(); assert.ok(value && !value.startsWith('--')); options.set(name, value);
}
assert.ok(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  && origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash);
const engine = options.get('--engine'); assert.ok(['chromium', 'webkit'].includes(engine));
const proofPath = options.get('--served-proof'); assert.ok(proofPath && isAbsolute(proofPath));
const outputDirectory = fileURLToPath(new URL('../outputs/qa/', import.meta.url));
if (!options.has('--output')) mkdirSync(outputDirectory, { recursive: true });
const output = options.get('--output') ?? join(outputDirectory, `durable-processor-management-${randomUUID()}.json`);
assert.ok(isAbsolute(output) && !existsSync(output));
const hash = value => createHash('sha256').update(value).digest('hex'), sha = /^[a-f0-9]{64}$/;
function regular(path, limit = 2 * 1024 * 1024) {
  assert.ok(isAbsolute(path)); const before = lstatSync(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= limit);
  const bytes = readFileSync(path), after = lstatSync(path);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
  assert.equal(bytes.length, before.size); return bytes;
}
const fixed = ['app/settings/processors/processor-management.ts', 'app/settings/processors/page.tsx',
  'app/settings/processors/trusted-processors.ts', 'packages/device-web/src/processor-installation-storage.ts',
  'packages/device-web/src/index.ts', 'packages/connect/src/index.ts', 'packages/device-runtime/src/processor-installation.ts',
  'packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/processor-registry.ts',
  'packages/device-runtime/src/conformance.ts', 'packages/device-model/src/extension-release.ts',
  'examples/external-processor/processor.mjs', 'examples/extension-installation/temperature-band-v2.mjs'];
const ownerKey = '101:processor-installation:page%3Aprocessor-owner', probe = `qa-durable-processor-${randomUUID()}`;
const report = { schemaVersion: 1, status: 'pending', phase: 'source-build-pins', mode: featureRed ? 'genuine-old-choice-absence' : 'durable-reviewed-software-caller',
  engine, browserVersion: undefined, sourceTree: undefined, actualServedProof: undefined, prefix: undefined,
  sourcePins: {}, buildInputs: [], pageErrors: 0, foreignRequests: 0, requestCount: 0, matchedBuildResponses: 0,
  requestsBlocked: 0, requestsOverLimit: false, webSocketsBlocked: 0, journey: [],
  finalPinsVerified: false, retirements: [], failure: undefined, secondaryFailures: [], failedBuildRequests: [], failedOriginRequests: [],
  documentMode: coldDocument ? 'new-native-page-same-context' : 'settings-link-same-document', documentReopens: [], documentRetirements: [],
  processorVisits: [], nativeArrivals: [],
  cleanup: { pageTaskCloseAwaited: false, observedNativeReturnsSettled: false, ownedProbeRemoved: false,
    ownedPrefixLockSettled: false, documentsRetired: false, pagesClosed: false, contextCloseAwaited: false, browserClosed: false },
  childToolsIssued: 0, workerExitObserved: false,
  scope: 'Owned local software reviewed persistence/inactive fresh lifetime. Optional cold-document opens distinct native pages in the same isolated browser context; no browser restart/profile persistence claim. Existing durable SDK adapter ancestry is bound, not requalified. No account, connector, native-device or whole U12/E10 acceptance; simultaneous cross-page/native queued-close/quota fault journeys remain separate.' };
let failure, proof, sourceRoot, proofSHA, browser, context, page;
const build = new Map(), pendingResponses = new Set(), pendingRequests = new Map(), seenBuild = new Set();
const ownedPages = [];
const currentVisits = new Map();
const noAuthority = { importKeyCalls: 0, verifyCalls: 0, publicVerifyKeys: 0, verifiedTrue: 0, verifiedFalse: 0,
  ownerReads: 0, ownerWrites: 0, ownerLocks: 0, lockPending: 0 };
function authority(native) {
  // Digests also belong to framework navigation. Keep their pending count in
  // the receipt and join it at retirement; approval fences count invocations.
  const snapshot = { ...native }; delete snapshot.cryptoPending; return snapshot;
}
function beginVisit(selected) {
  const visit = { pageOrdinal: ownedPages.indexOf(selected) + 1, visitOrdinal: report.processorVisits.length + 1,
    retirementStart: report.retirements.length, approvalIssued: false, taskRetirementObserved: false, inertDepartureObserved: false };
  currentVisits.set(selected, visit); report.processorVisits.push(visit);
}
async function observeInertDeparture(selected) {
  const visit = currentVisits.get(selected); assert.ok(visit && !visit.approvalIssued);
  const main = selected.locator('[data-processor-phase]');
  assert.equal(await main.getAttribute('data-processor-phase'), 'idle');
  for (const key of ['routes', 'registrations', 'effects']) assert.equal(await main.getAttribute(`data-processor-${key}`), '0');
  visit.inertDepartureObserved = true;
}
async function observeTaskRetirement(selected) {
  const visit = currentVisits.get(selected); assert.ok(visit?.approvalIssued);
  const retirement = () => report.retirements.slice(visit.retirementStart).find(detail => detail.pageOrdinal === visit.pageOrdinal);
  for (let turn = 0; !retirement() && turn < 100; turn++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
  const retired = retirement();
  assert.ok(retired?.closeAwaited && retired.phase === 'closed' && retired.rawPending === 0 && retired.storagePending === 0
    && retired.routes === 0 && retired.registrations === 0 && !retired.timerArmed && !retired.flushArmed && retired.cleanupFailures === 0);
  visit.taskRetirementObserved = true; return retired;
}
async function settleBuildResponses() {
  // Adopt parent prefetches and response reads. A stalled observation must
  // fail within the native operation timeout, then let finally close owners.
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`Native request/body observation timed out: ${pendingRequests.size} requests, ${pendingResponses.size} bodies`)), 30_000);
  });
  try {
    while (pendingResponses.size || pendingRequests.size)
      await Promise.race([Promise.allSettled([...pendingResponses, ...[...pendingRequests.values()].map(value => value.closed)]), expired]);
  } finally { clearTimeout(timer); }
}

function diagnostic(cause) {
  const bounded = (value, limit) => typeof value === 'string' ? value.replaceAll(probe, '[owned probe]').slice(0, limit) : '';
  return { name: bounded(cause instanceof Error ? cause.name : 'UnknownThrownValue', 128),
    message: bounded(cause instanceof Error ? cause.message : 'Unsupported QA error value', 4096),
    stack: bounded(cause instanceof Error ? cause.stack : '', 8192), phase: report.phase, engine, browserVersion: report.browserVersion };
}
function retain(cause) { if (!failure) { failure = cause; report.status = 'fail'; report.failure = diagnostic(cause); }
  else if (report.secondaryFailures.length < 8) report.secondaryFailures.push(diagnostic(cause)); }
function guards() {
  assert.equal(hash(regular(proofPath)), proofSHA);
  for (const [path, expected] of Object.entries(report.sourcePins)) assert.equal(hash(regular(join(sourceRoot, path))), expected);
  for (const item of report.buildInputs) assert.equal(hash(regular(item.path, 32 * 1024 * 1024)), item.sha256);
  assert.equal(hash(regular(proof.buildRecord.path)), proof.buildRecord.sha256);
}
async function activate(name) {
  const button = page.getByRole('button', { name, exact: true }); await button.click({ trial: true }); await button.focus();
  assert.equal(await button.evaluate(element => document.activeElement === element && element.matches(':focus')), true);
  if (name === 'Allow management for 30 seconds') {
    const visit = currentVisits.get(page); assert.ok(visit); visit.approvalIssued = true;
  }
  await page.keyboard.press('Space');
}
async function settled() {
  await page.waitForFunction(() => { const main = document.querySelector('[data-processor-phase]');
    return main?.dataset.processorRaw === '0' && !['opening', 'working'].includes(main.dataset.processorPhase); });
  await page.waitForFunction(() => globalThis.__durableProcessorOldNative.cryptoPending === 0 && globalThis.__durableProcessorOldNative.lockPending === 0);
}
async function openOwnedPage() {
  const selected = await context.newPage(), ordinal = ownedPages.push(selected);
  selected.on('pageerror', () => { report.pageErrors++; });
  selected.on('request', request => {
    let finish; const closed = new Promise(resolveClosed => { finish = resolveClosed; });
    pendingRequests.set(request, { closed, finish, pageOrdinal: ordinal });
  });
  const requestFinished = (request, failed) => {
    const owned = pendingRequests.get(request); if (!owned) return;
    if (failed) {
      const detail = { url: request.url(), reason: request.failure()?.errorText ?? 'Native request failed', pageOrdinal: ordinal,
        buildAsset: build.has(request.url()) };
      if (report.failedOriginRequests.length < 16) report.failedOriginRequests.push(detail);
      if (detail.buildAsset && report.failedBuildRequests.length < 16) report.failedBuildRequests.push(detail);
      retain(Error(`Native request failed: ${detail.url}: ${detail.reason}`));
    }
    pendingRequests.delete(request); owned.finish();
  };
  selected.on('requestfinished', request => requestFinished(request, false));
  selected.on('requestfailed', request => requestFinished(request, true));
  selected.on('response', response => { const expected = build.get(response.url()); if (!expected) return;
    const returned = response.body().then(content => { assert.equal(response.status(), 200); assert.equal(hash(content), expected); seenBuild.add(response.url()); });
    pendingResponses.add(returned); void returned.then(() => pendingResponses.delete(returned), cause => { pendingResponses.delete(returned); retain(cause); }); });
  await selected.exposeFunction('__durableProcessorRetired', detail => { report.retirements.push({ ...detail, pageOrdinal: ordinal }); });
  await selected.addInitScript(() => window.addEventListener('101-processor-management-retired', event => { void globalThis.__durableProcessorRetired(event.detail); }));
  return selected;
}
async function retireDocument(selected) {
  const visit = currentVisits.get(selected);
  if (visit && !visit.approvalIssued && !visit.inertDepartureObserved) {
    try { await observeInertDeparture(selected); } catch (cause) { retain(cause); }
  }
  // Stop the actual framework producers. Joining HTTP alone cannot own a
  // queued Link setup or a response decoder that will issue another fetch.
  await selected.evaluate(() => {
    const root = globalThis.__VINEXT_RSC_ROOT__;
    const runtime = globalThis[Symbol.for('vinext.navigationRuntime')];
    const cache = globalThis.__VINEXT_RSC_PREFETCH_CACHE__;
    if (typeof root?.unmount !== 'function' || typeof runtime?.functions?.notifyLinkNavigationStart !== 'function' || !(cache instanceof Map))
      throw Error('Actual framework producer owners are unavailable');
    root.unmount(); runtime.functions.notifyLinkNavigationStart();
  });
  if (visit?.approvalIssued && !visit.taskRetirementObserved) {
    try { await observeTaskRetirement(selected); } catch (cause) { retain(cause); }
  }
  // Already-issued URL digests can register a prefetch owner after the epoch
  // changes; let their real native returns settle before adopting that owner.
  await selected.waitForFunction(() => globalThis.__durableProcessorOldNative.cryptoPending === 0);
  const producers = await selected.evaluate(async () => {
    const cache = globalThis.__VINEXT_RSC_PREFETCH_CACHE__;
    if (!(cache instanceof Map)) throw Error('Actual framework prefetch owner is unavailable');
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Native framework prefetch observation timed out')), 30_000);
    });
    const seen = new Set();
    try {
      while (true) {
        const pending = [...new Set([...cache.values()].flatMap(entry => [entry.pending, entry.fetchPromise]).filter(value => value instanceof Promise))];
        if (!pending.length) break;
        for (const issued of pending) seen.add(issued);
        const outcomes = await Promise.race([Promise.allSettled(pending), expired]);
        const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
        if (rejected.length) throw Error(`Actual framework prefetch failed: ${rejected.map(outcome => String(outcome.reason)).join('; ')}`);
      }
      return { rootUnmounted: true, queuedLinkSetupRetired: true, prefetchReturnsJoined: seen.size };
    } finally { clearTimeout(timer); }
  });
  await selected.waitForFunction(() => globalThis.__durableProcessorOldNative.cryptoPending === 0);
  await selected.waitForLoadState('networkidle'); await settleBuildResponses();
  const native = await selected.evaluate(() => globalThis.__durableProcessorOldNative);
  assert.equal(native.cryptoPending, 0); assert.equal(native.lockPending, 0);
  await selected.goto('about:blank'); assert.equal(selected.url(), 'about:blank');
  await settleBuildResponses();
  report.documentRetirements.push({ pageOrdinal: ownedPages.indexOf(selected) + 1, ...producers,
    nativeCryptoPending: native.cryptoPending, nativeLockPending: native.lockPending, nativeDocumentBlank: true });
}

async function returnToSettings() {
  const visit = currentVisits.get(page); assert.ok(visit);
  const ordinal = ownedPages.indexOf(page) + 1;
  await settleBuildResponses();
  if (!visit.approvalIssued) await observeInertDeparture(page);
  await page.locator('main').getByRole('link', { name: 'Back to Settings', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/settings');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.waitForLoadState('networkidle'); await settleBuildResponses();
  const retired = visit.approvalIssued ? await observeTaskRetirement(page) : undefined;
  await page.waitForFunction(() => globalThis.__durableProcessorOldNative.cryptoPending === 0);
  const native = await page.evaluate(() => globalThis.__durableProcessorOldNative);
  assert.equal(native.cryptoPending, 0); assert.equal(native.lockPending, 0);
  return { retired, native, ordinal };
}
try {
  const bytes = regular(proofPath); proofSHA = hash(bytes); proof = JSON.parse(bytes);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.origin, origin.origin); assert.match(proof.sourceTree, /^[a-f0-9]{40}$/);
  assert.equal(proof.qaToolSHA, hash(regular(fileURLToPath(import.meta.url), 256 * 1024)));
  sourceRoot = realpathSync(proof.sourceRoot); assert.equal(sourceRoot, resolve(proof.sourceRoot));
  const entries = Object.entries(proof.sourcePins ?? {}); assert.ok(entries.length >= fixed.length && entries.length <= 512);
  let sourceBytes = 0;
  for (const [path, expected] of entries) {
    assert.ok(!isAbsolute(path) && /^[A-Za-z0-9._/-]{1,512}$/.test(path) && !path.split('/').some(part => !part || part === '..'));
    assert.match(expected, sha); const content = regular(join(sourceRoot, path)); sourceBytes += content.length; assert.ok(sourceBytes <= 64 * 1024 * 1024);
    assert.equal(hash(content), expected); report.sourcePins[path] = expected;
  }
  for (const path of fixed) assert.ok(Object.hasOwn(report.sourcePins, path));
  assert.ok(Array.isArray(proof.buildInputs) && proof.buildInputs.length >= 2 && proof.buildInputs.length <= 2048);
  const seen = new Set(); let buildBytes = 0;
  for (const item of proof.buildInputs) {
    assert.ok(['server', 'client'].includes(item.kind)); assert.match(item.sha256, sha); assert.ok(isAbsolute(item.path));
    const path = realpathSync(item.path); assert.equal(path, resolve(item.path)); assert.ok(!seen.has(path)); seen.add(path);
    const rel = relative(join(sourceRoot, 'dist', item.kind), path); assert.ok(!rel.startsWith('..') && !isAbsolute(rel));
    const content = regular(path, 32 * 1024 * 1024); buildBytes += content.length; assert.ok(buildBytes <= 64 * 1024 * 1024);
    assert.equal(hash(content), item.sha256); report.buildInputs.push({ path, sha256: item.sha256, kind: item.kind });
    if (item.kind === 'client') build.set(new URL(rel.replaceAll('\\', '/'), origin).href, item.sha256);
  }
  assert.ok(report.buildInputs.some(item => item.kind === 'server') && report.buildInputs.some(item => item.kind === 'client'));
  assert.equal(hash(regular(proof.buildRecord.path)), proof.buildRecord.sha256);
  const text = regular(join(sourceRoot, 'app/settings/processors/trusted-processors.ts')).toString('utf8');
  const provision = JSON.parse(text.match(/const provision = ([\s\S]*?);\n/)[1]), sources = JSON.parse(text.match(/const sources = (\[[\s\S]*?\]) as const;/)[1]);
  assert.deepEqual(provision.publisherKey.key_ops, ['verify']); assert.equal(provision.releases.length, 2);
  for (const [index, path] of fixed.slice(-2).entries()) { const content = regular(join(sourceRoot, path)), release = provision.releases[index];
    assert.equal(content.toString('utf8'), sources[index]); assert.equal(content.length, release.source.byteLength);
    assert.equal(hash(content), release.source.sha256); assert.equal(hash(content), release.manifest.codeSha256); }
  report.sourceTree = proof.sourceTree; report.actualServedProof = { path: proofPath, sha256: proofSHA, sourceTree: proof.sourceTree };
  const require = createRequire(join(sourceRoot, 'package.json')), engines = require('playwright');
  browser = await engines[engine].launch({ headless: true }); report.browserVersion = browser.version(); context = await browser.newContext();
  // Deny before dispatch. No remote request or socket is issued by this task.
  await context.route('**/*', async route => {
    report.requestCount = Math.min(1025, report.requestCount + 1);
    let allowed = false;
    try { const url = new URL(route.request().url()); allowed = url.protocol === origin.protocol && url.origin === origin.origin; } catch { /* Invalid URL is denied. */ }
    if (!allowed || report.requestCount > 1024) {
      if (!allowed) report.foreignRequests = Math.min(1025, report.foreignRequests + 1);
      if (report.requestCount > 1024) report.requestsOverLimit = true;
      report.requestsBlocked = Math.min(1025, report.requestsBlocked + 1); await route.abort(); return;
    }
    await route.continue();
  });
  assert.equal(typeof context.routeWebSocket, 'function', 'WebSocket denial must be supported before page activity');
  await context.routeWebSocket('**/*', socket => {
    report.webSocketsBlocked = Math.min(1025, report.webSocketsBlocked + 1); socket.close();
  });
  await context.addInitScript(({ ownerKey, ownedOrigin }) => {
    if (location.origin !== ownedOrigin) return;
    const observed = { importKeyCalls: 0, verifyCalls: 0, publicVerifyKeys: 0, verifiedTrue: 0, verifiedFalse: 0,
      cryptoPending: 0, ownerReads: 0, ownerWrites: 0, ownerLocks: 0, lockPending: 0 };
    globalThis.__durableProcessorOldNative = observed;
    for (const name of ['importKey', 'verify', 'digest']) {
      const native = SubtleCrypto.prototype[name];
      Object.defineProperty(SubtleCrypto.prototype, name, { configurable: true, writable: true, value(...args) {
        if (name === 'importKey') observed.importKeyCalls++;
        if (name === 'verify') observed.verifyCalls++;
        observed.cryptoPending++; let issued;
        try { issued = Reflect.apply(native, this, args); } catch (cause) { observed.cryptoPending--; throw cause; }
        void Promise.prototype.then.call(issued, result => { observed.cryptoPending--;
          if (name === 'importKey' && result.type === 'public' && result.usages.join(',') === 'verify' && !result.extractable) observed.publicVerifyKeys++;
          if (name === 'verify') observed[result === true ? 'verifiedTrue' : 'verifiedFalse']++;
        }, () => { observed.cryptoPending--; });
        return issued;
      } });
    }
    for (const name of ['getItem', 'setItem']) { const native = Storage.prototype[name];
      Object.defineProperty(Storage.prototype, name, { configurable: true, writable: true, value(...args) {
        if (args[0] === ownerKey) observed[name === 'getItem' ? 'ownerReads' : 'ownerWrites']++; return Reflect.apply(native, this, args);
      } }); }
    const native = LockManager.prototype.request;
    Object.defineProperty(LockManager.prototype, 'request', { configurable: true, writable: true, value(...args) {
      const own = args[0] === `${ownerKey}:storage-lock`; if (own) { observed.ownerLocks++; observed.lockPending++; }
      let issued; try { issued = Reflect.apply(native, this, args); } catch (cause) { if (own) observed.lockPending--; throw cause; }
      if (own) void Promise.prototype.then.call(issued, () => { observed.lockPending--; }, () => { observed.lockPending--; }); return issued;
    } });
  }, { ownerKey, ownedOrigin: origin.origin });
  page = await openOwnedPage();
  beginVisit(page);
  report.phase = 'genuine-existing-caller-prefix';
  assert.equal((await page.goto(new URL('/settings/processors', origin).href, { waitUntil: 'networkidle' }))?.status(), 200);
  await settleBuildResponses();
  assert.equal(await page.getByRole('heading', { name: 'Manage reviewed processors', exact: true }).count(), 1);
  assert.equal(await page.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'idle');
  const inert = await page.evaluate(() => globalThis.__durableProcessorOldNative);
  report.nativeArrivals.push({ visitOrdinal: currentVisits.get(page).visitOrdinal, native: inert });
  assert.deepEqual(authority(inert), noAuthority);
  const native = await page.evaluate(async ({ probe, ownerKey }) => {
    if (localStorage.getItem(ownerKey) !== null) throw Error('owned-context-storage-not-fresh');
    localStorage.setItem(probe, 'owned-prefix'); const roundtrip = localStorage.getItem(probe) === 'owned-prefix'; localStorage.removeItem(probe);
    const granted = await navigator.locks.request(probe, { mode: 'exclusive' }, lock => lock?.name === probe && lock.mode === 'exclusive');
    const state = await navigator.locks.query();
    return { roundtrip, exclusiveNativeLock: granted, probeRemoved: localStorage.getItem(probe) === null,
      prefixLockSettled: ![...(state.held ?? []), ...(state.pending ?? [])].some(lock => lock.name === probe) };
  }, { probe, ownerKey });
  assert.deepEqual(native, { roundtrip: true, exclusiveNativeLock: true, probeRemoved: true, prefixLockSettled: true });
  await activate('Manage processors'); await activate('Allow management for 30 seconds'); await settled();
  assert.equal(await page.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'ready');
  await activate('Review install'); await activate('Confirm installation'); await settled();
  assert.equal(await page.getByText('Installed in this page: 1.0.0.', { exact: true }).count(), 1);
  for (const key of ['routes', 'registrations', 'effects']) assert.equal(await page.locator('[data-processor-phase]').getAttribute(`data-processor-${key}`), '0');
  const observed = await page.evaluate(() => globalThis.__durableProcessorOldNative);
  assert.ok(observed.publicVerifyKeys >= 1 && observed.verifiedTrue >= 3); assert.equal(observed.verifiedFalse, 0);
  assert.equal(observed.cryptoPending, 0); assert.equal(observed.ownerWrites, 0); assert.equal(observed.ownerLocks, 0);
  await activate('Stop management'); await settled(); await activate('Manage processors');
  report.prefix = { inertArrival: true, ...native, genuineSignedInactiveTabInstall: true, freshManagementReviewOpened: true, observedNative: observed };
  report.phase = 'durable-choice-availability';
  assert.equal(await page.getByRole('radio', { name: 'Save on this browser', exact: true }).count(), 1,
    'missing reviewed Save on this browser choice after genuine native/signed caller prefix');
  if (featureRed) throw Error('Feature-red expects the old absence; use GREEN for an existing durable choice');
  report.phase = 'durable-software-journey';
  async function chooseBrowser() {
    const radio = page.getByRole('radio', { name: 'Save on this browser', exact: true });
    await radio.focus(); await page.keyboard.press('Space'); assert.equal(await radio.isChecked(), true);
    await activate('Allow management for 30 seconds'); await settled();
    assert.equal(await page.locator('[data-processor-phase]').getAttribute('data-processor-storage'), 'browser');
  }
  async function enterFreshPage() {
    const { native: beforeNative, ordinal } = await returnToSettings();
    if (coldDocument) {
      const previous = page, href = await previous.getByRole('link', { name: 'Manage reviewed processors', exact: true }).getAttribute('href');
      assert.equal(new URL(href, origin).pathname, '/settings/processors');
      const marker = randomUUID(); await previous.evaluate(marker => { globalThis.__durableProcessorPreviousDocument = marker; }, marker);
      page = await openOwnedPage(); assert.notEqual(page, previous);
      beginVisit(page);
      assert.equal((await page.goto(new URL(href, origin).href, { waitUntil: 'networkidle' }))?.status(), 200);
      await settleBuildResponses();
      assert.equal(await page.evaluate(() => typeof globalThis.__durableProcessorPreviousDocument), 'undefined');
      await retireDocument(previous); await previous.close(); assert.equal(previous.isClosed(), true);
      report.documentReopens.push({ previousPageOrdinal: ordinal, newPageOrdinal: ownedPages.length,
        previousTaskClosed: true, previousNativeReturnsSettled: true, previousPageClosed: true, distinctNativeDocument: true });
    } else {
      beginVisit(page);
      await page.getByRole('link', { name: 'Manage reviewed processors', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/settings/processors');
      await page.waitForLoadState('networkidle'); await settleBuildResponses();
    }
    await page.getByRole('heading', { name: 'Manage reviewed processors', exact: true }).waitFor();
    const inert = await page.evaluate(() => globalThis.__durableProcessorOldNative);
    report.nativeArrivals.push({ visitOrdinal: currentVisits.get(page).visitOrdinal, native: inert });
    assert.deepEqual(authority(inert), coldDocument ? noAuthority : authority(beforeNative),
    'A new task or document cannot read or verify saved state before approval');
    assert.equal(await page.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'idle');
    for (const key of ['routes', 'registrations', 'effects']) assert.equal(await page.locator('[data-processor-phase]').getAttribute(`data-processor-${key}`), '0');
    await activate('Manage processors'); await chooseBrowser();
    if (coldDocument) {
      const restored = await page.evaluate(() => globalThis.__durableProcessorOldNative);
      assert.ok(restored.ownerReads > 0); assert.equal(restored.ownerWrites, 0); assert.equal(restored.ownerLocks, 0);
      assert.equal(restored.cryptoPending, 0); assert.equal(restored.lockPending, 0); assert.equal(restored.verifiedFalse, 0);
      report.documentReopens.at(-1).arrivalNative = inert;
      report.documentReopens.at(-1).restoredNative = restored;
    }
  }
  await chooseBrowser();
  assert.equal(await page.getByText('No installed version in the current choice.', { exact: true }).count(), 1);
  const browserEmpty = await page.evaluate(() => globalThis.__durableProcessorOldNative);
  assert.ok(browserEmpty.ownerReads > 0); assert.equal(browserEmpty.ownerWrites, 0); assert.equal(browserEmpty.ownerLocks, 0);
  report.journey.push('explicit-browser-read-no-tab-migration');
  await activate('Review install'); await activate('Confirm installation'); await settled();
  assert.equal(await page.getByText('Installed in this browser: 1.0.0.', { exact: true }).count(), 1);
  const saved = await page.evaluate(() => globalThis.__durableProcessorOldNative);
  assert.ok(saved.ownerWrites > 0 && saved.ownerLocks > 0); assert.equal(saved.cryptoPending, 0); assert.equal(saved.lockPending, 0);
  for (const key of ['routes', 'registrations', 'effects']) assert.equal(await page.locator('[data-processor-phase]').getAttribute(`data-processor-${key}`), '0');
  report.journey.push('native-locked-signed-inactive-save');
  await enterFreshPage();
  assert.equal(await page.getByText('Installed in this browser: 1.0.0.', { exact: true }).count(), 1);
  assert.equal(await page.getByText('No live version. Installation is separate from live use.', { exact: true }).count(), 1);
  await activate('Review live use');
  assert.equal(await page.getByRole('button', { name: 'Start approved example', exact: true }).isDisabled(), true);
  await activate('Allow this page’s number input');
  assert.equal(await page.getByRole('button', { name: 'Start approved example', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('[data-processor-phase]').getAttribute('data-processor-routes'), '0');
  await activate('Allow this page’s indicator output'); await activate('Start approved example'); await settled();
  await activate('Send number'); assert.equal(await page.getByRole('status', { name: 'Page indicator', exact: true }).textContent(), 'On');
  report.journey.push('inactive-fresh-lifetime-independent-input-output');
  await activate('Stop live use'); await settled();
  await activate('Revoke built-in publisher'); await activate('Confirm publisher revocation'); await settled();
  await activate('Remove installed versions'); await activate('Confirm removal'); await settled();
  await enterFreshPage();
  assert.equal(await page.getByText('No installed version in the current choice.', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Both versions are blocked because this browser revoked the built-in publisher.', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Review install', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('[data-processor-phase]').getAttribute('data-processor-routes'), '0');
  report.journey.push('source-removal-retains-publisher-block-on-fresh-lifetime');
  report.status = 'pass';
} catch (cause) { retain(cause); }
finally {
  if (page && !page.isClosed()) {
    let requestsJoined = false;
    try { await settleBuildResponses(); requestsJoined = true; } catch (cause) { retain(cause); }
    // A stalled startup goes directly to native owner close. Once requests
    // join, a task assertion failure must not skip actual producer retirement.
    if (requestsJoined) {
      try {
        const review = page.getByRole('button', { name: 'Decline management', exact: true }); if (await review.count()) await activate('Decline management');
        if (new URL(page.url()).pathname === '/settings/processors') await returnToSettings();
      } catch (cause) { retain(cause); }
      try {
        await page.waitForFunction(() => globalThis.__durableProcessorOldNative.cryptoPending === 0 && globalThis.__durableProcessorOldNative.lockPending === 0);
        const ending = await page.evaluate(async probe => { localStorage.removeItem(probe); const state = await navigator.locks.query();
          const observed = globalThis.__durableProcessorOldNative;
          return { probeRemoved: localStorage.getItem(probe) === null,
            prefixLockSettled: ![...(state.held ?? []), ...(state.pending ?? [])].some(lock => lock.name === probe),
            nativeReturnsSettled: observed.cryptoPending === 0 && observed.lockPending === 0 }; }, probe);
        report.cleanup.ownedProbeRemoved = ending.probeRemoved; report.cleanup.ownedPrefixLockSettled = ending.prefixLockSettled;
        report.cleanup.observedNativeReturnsSettled = ending.nativeReturnsSettled;
        await settleBuildResponses();
      } catch (cause) { retain(cause); }
      for (const selected of ownedPages) if (!selected.isClosed()) {
        try { await retireDocument(selected); } catch (cause) { retain(cause); }
      }
      try {
        report.cleanup.pageTaskCloseAwaited = report.processorVisits.every(visit => visit.approvalIssued ? visit.taskRetirementObserved : visit.inertDepartureObserved);
        report.cleanup.documentsRetired = ownedPages.every(selected => selected.isClosed() || selected.url() === 'about:blank');
        report.matchedBuildResponses = seenBuild.size;
        assert.equal(report.pageErrors, 0); assert.equal(report.foreignRequests, 0);
        assert.equal(report.requestsBlocked, 0); assert.equal(report.requestsOverLimit, false); assert.equal(report.webSocketsBlocked, 0);
      } catch (cause) { retain(cause); }
    }
  }
  try { if (proof && sourceRoot && proofSHA) { guards(); report.finalPinsVerified = true; } } catch (cause) { retain(cause); }
  try { if (context) { await context.close(); report.cleanup.contextCloseAwaited = true; } } catch (cause) { retain(cause); }
  try { if (browser) { await browser.close(); report.cleanup.browserClosed = true; } } catch (cause) { retain(cause); }
  report.cleanup.pagesClosed = ownedPages.every(selected => selected.isClosed());
  // Final acceptance follows every close callout and response read.
  try {
    // After native shutdown an observer with no terminal event cannot settle.
    // Preserve that missing outcome as failure; never manufacture a callback.
    await Promise.allSettled([...pendingResponses]);
    assert.equal(pendingResponses.size, 0);
    assert.equal(pendingRequests.size, 0, `Missing native terminal request events: ${JSON.stringify([...pendingRequests].map(([request, owned]) => ({ url: request.url(), pageOrdinal: owned.pageOrdinal })))}`);
    for (const [name, complete] of Object.entries(report.cleanup)) assert.equal(complete, true, name);
    assert.equal(report.pageErrors, 0); assert.equal(report.foreignRequests, 0);
    assert.equal(report.requestsBlocked, 0); assert.equal(report.requestsOverLimit, false); assert.equal(report.webSocketsBlocked, 0);
    assert.equal(report.finalPinsVerified, true); assert.ok(report.matchedBuildResponses > 0);
    if (coldDocument && !featureRed) assert.equal(report.documentReopens.length, 2);
  } catch (cause) { retain(cause); }
  if (failure) report.status = 'fail';
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: report.status, phase: report.failure?.phase, receipt: output,
    sha256: hash(readFileSync(output)), cleanup: report.cleanup, finalPinsVerified: report.finalPinsVerified, childToolsIssued: 0 }) + '\n');
}
process.exitCode = failure ? 1 : 0;
