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
let featureRed = false;
while (args.length) {
  const name = args.shift();
  if (name === '--feature-red' && !featureRed) { featureRed = true; continue; }
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
  finalPinsVerified: false, retirements: [], failure: undefined, secondaryFailures: [], failedBuildRequests: [],
  cleanup: { pageTaskCloseAwaited: false, observedNativeReturnsSettled: false, ownedProbeRemoved: false,
    ownedPrefixLockSettled: false, pagesClosed: false, contextCloseAwaited: false, browserClosed: false },
  childToolsIssued: 0, workerExitObserved: false,
  scope: 'Owned local software reviewed persistence/inactive fresh lifetime only. Existing durable SDK adapter ancestry is bound, not requalified. No account, connector, native-device or whole U12/E10 acceptance; cross-page/native queued-close/quota fault journeys remain separate.' };
let failure, proof, sourceRoot, proofSHA, browser, context, page;
const build = new Map(), pendingResponses = new Set(), pendingRequests = new Map(), seenBuild = new Set();
async function settleBuildResponses() {
  // Adopt requests before headers arrive. A Settings link can start a prefetch
  // while navigation is rendering; join it and its body before replacing the
  // document. Read failures remain failed evidence and do not skip cleanup.
  while (pendingResponses.size || pendingRequests.size)
    await Promise.allSettled([...pendingResponses, ...[...pendingRequests.values()].map(value => value.closed)]);
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
  await page.keyboard.press('Space');
}
async function settled() {
  await page.waitForFunction(() => { const main = document.querySelector('[data-processor-phase]');
    return main?.dataset.processorRaw === '0' && !['opening', 'working'].includes(main.dataset.processorPhase); });
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
  await context.addInitScript(ownerKey => {
    const observed = { publicVerifyKeys: 0, verifiedTrue: 0, verifiedFalse: 0, cryptoPending: 0, ownerReads: 0, ownerWrites: 0, ownerLocks: 0, lockPending: 0 };
    globalThis.__durableProcessorOldNative = observed;
    for (const name of ['importKey', 'verify']) {
      const native = SubtleCrypto.prototype[name];
      Object.defineProperty(SubtleCrypto.prototype, name, { configurable: true, writable: true, value(...args) {
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
  }, ownerKey);
  page = await context.newPage(); page.on('pageerror', () => { report.pageErrors++; });
  page.on('request', request => {
    if (!build.has(request.url())) return;
    let finish; const closed = new Promise(resolveClosed => { finish = resolveClosed; });
    pendingRequests.set(request, { closed, finish });
  });
  const requestFinished = (request, failed) => {
    const owned = pendingRequests.get(request); if (!owned) return;
    if (failed) {
      const detail = { url: request.url(), reason: request.failure()?.errorText ?? 'Native request failed' };
      if (report.failedBuildRequests.length < 16) report.failedBuildRequests.push(detail);
      retain(Error(`Build asset request failed: ${detail.url}: ${detail.reason}`));
    }
    pendingRequests.delete(request); owned.finish();
  };
  page.on('requestfinished', request => requestFinished(request, false));
  page.on('requestfailed', request => requestFinished(request, true));
  page.on('response', response => { const expected = build.get(response.url()); if (!expected) return;
    const returned = response.body().then(content => { assert.equal(response.status(), 200); assert.equal(hash(content), expected); seenBuild.add(response.url()); });
    pendingResponses.add(returned); void returned.then(() => pendingResponses.delete(returned), cause => { pendingResponses.delete(returned); retain(cause); }); });
  await page.exposeFunction('__durableProcessorRetired', detail => { report.retirements.push(detail); });
  await page.addInitScript(() => window.addEventListener('101-processor-management-retired', event => { void globalThis.__durableProcessorRetired(event.detail); }));
  report.phase = 'genuine-existing-caller-prefix';
  assert.equal((await page.goto(new URL('/settings/processors', origin).href, { waitUntil: 'networkidle' }))?.status(), 200);
  await settleBuildResponses();
  assert.equal(await page.getByRole('heading', { name: 'Manage reviewed processors', exact: true }).count(), 1);
  assert.equal(await page.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'idle');
  const inert = await page.evaluate(() => globalThis.__durableProcessorOldNative);
  assert.deepEqual(inert, { publicVerifyKeys: 0, verifiedTrue: 0, verifiedFalse: 0, cryptoPending: 0, ownerReads: 0, ownerWrites: 0, ownerLocks: 0, lockPending: 0 });
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
    const before = report.retirements.length;
    await settleBuildResponses();
    await page.locator('main').getByRole('link', { name: 'Back to Settings', exact: true }).click(); await page.waitForURL(url => url.pathname === '/settings');
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    await settleBuildResponses();
    for (let turn = 0; report.retirements.length === before && turn < 100; turn++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    const closed = report.retirements.at(-1); assert.ok(report.retirements.length > before);
    assert.ok(closed.closeAwaited && closed.phase === 'closed' && closed.rawPending === 0 && closed.storagePending === 0
      && closed.routes === 0 && closed.registrations === 0 && !closed.timerArmed && !closed.flushArmed && closed.cleanupFailures === 0);
    const beforeNative = await page.evaluate(() => globalThis.__durableProcessorOldNative);
    await page.getByRole('link', { name: 'Manage reviewed processors', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/settings/processors');
    await page.getByRole('heading', { name: 'Manage reviewed processors', exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    await settleBuildResponses();
    const inert = await page.evaluate(() => globalThis.__durableProcessorOldNative);
    assert.deepEqual(inert, beforeNative, 'A new task reached through Settings cannot read or verify saved state before approval');
    assert.equal(await page.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'idle');
    await activate('Manage processors'); await chooseBrowser();
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
    try {
      const review = page.getByRole('button', { name: 'Decline management', exact: true }); if (await review.count()) await activate('Decline management');
      await settleBuildResponses();
      const before = report.retirements.length; await page.locator('main').getByRole('link', { name: 'Back to Settings', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/settings');
      await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
      await page.waitForLoadState('networkidle');
      await settleBuildResponses();
      for (let turn = 0; report.retirements.length === before && turn < 100; turn++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
      const retired = report.retirements.at(-1);
      report.cleanup.pageTaskCloseAwaited = report.retirements.length > before && retired.closeAwaited === true && retired.phase === 'closed'
        && retired.rawPending === 0 && retired.storagePending === 0 && retired.routes === 0 && retired.registrations === 0 && retired.timerArmed === false && retired.cleanupFailures === 0;
      const ending = await page.evaluate(async probe => { localStorage.removeItem(probe); const state = await navigator.locks.query();
        const observed = globalThis.__durableProcessorOldNative;
        return { probeRemoved: localStorage.getItem(probe) === null,
          prefixLockSettled: ![...(state.held ?? []), ...(state.pending ?? [])].some(lock => lock.name === probe),
          nativeReturnsSettled: observed.cryptoPending === 0 && observed.lockPending === 0 }; }, probe);
      report.cleanup.ownedProbeRemoved = ending.probeRemoved; report.cleanup.ownedPrefixLockSettled = ending.prefixLockSettled;
      report.cleanup.observedNativeReturnsSettled = ending.nativeReturnsSettled;
      await settleBuildResponses(); report.matchedBuildResponses = seenBuild.size;
      assert.equal(report.pageErrors, 0); assert.equal(report.foreignRequests, 0);
      assert.equal(report.requestsBlocked, 0); assert.equal(report.requestsOverLimit, false); assert.equal(report.webSocketsBlocked, 0);
    } catch (cause) { retain(cause); }
  }
  try { if (proof && sourceRoot && proofSHA) { guards(); report.finalPinsVerified = true; } } catch (cause) { retain(cause); }
  try { if (context) { await context.close(); report.cleanup.contextCloseAwaited = true; } } catch (cause) { retain(cause); }
  try { if (browser) { await browser.close(); report.cleanup.browserClosed = true; } } catch (cause) { retain(cause); }
  report.cleanup.pagesClosed = !page || page.isClosed();
  // Final acceptance follows every close callout and response read.
  try {
    await settleBuildResponses();
    assert.equal(pendingResponses.size, 0);
    assert.equal(pendingRequests.size, 0);
    for (const [name, complete] of Object.entries(report.cleanup)) assert.equal(complete, true, name);
    assert.equal(report.pageErrors, 0); assert.equal(report.foreignRequests, 0);
    assert.equal(report.requestsBlocked, 0); assert.equal(report.requestsOverLimit, false); assert.equal(report.webSocketsBlocked, 0);
    assert.equal(report.finalPinsVerified, true); assert.ok(report.matchedBuildResponses > 0);
  } catch (cause) { retain(cause); }
  if (failure) report.status = 'fail';
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: report.status, phase: report.failure?.phase, receipt: output,
    sha256: hash(readFileSync(output)), cleanup: report.cleanup, finalPinsVerified: report.finalPinsVerified, childToolsIssued: 0 }) + '\n');
}
process.exitCode = failure ? 1 : 0;
