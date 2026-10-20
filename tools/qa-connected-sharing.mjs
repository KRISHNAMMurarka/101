import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

// OLD selects a genuine existing local producer before checking the new action.
// The caller owns the already-built loopback app server and its build receipt.
const args = process.argv.slice(2);
assert.equal(args.length, 6, 'Usage: node tools/qa-connected-sharing.mjs ORIGIN (--old-red|--connected) --served-proof PATH --engine (chromium|firefox|webkit)');
const options = new Map(); let origin;
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--old-red' || argument === '--connected') { assert.ok(!options.has(argument)); options.set(argument, true); }
  else if (argument === '--served-proof' || argument === '--engine') {
    assert.ok(!options.has(argument) && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('--'));
    options.set(argument, args[++index]);
  } else { assert.ok(!origin && !argument.startsWith('--')); origin = argument; }
}
const old = options.get('--old-red') === true;
assert.equal(Number(old) + Number(options.get('--connected') === true), 1);
const engineName = options.get('--engine'); assert.ok(['chromium', 'firefox', 'webkit'].includes(engineName));
if (old) assert.equal(engineName, 'chromium');
const engine = { chromium, firefox, webkit }[engineName];
assert.ok(typeof options.get('--served-proof') === 'string' && isAbsolute(options.get('--served-proof')));
assert.ok(typeof origin === 'string' && origin.length <= 2048 && /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/.test(origin), 'Only an exact owned loopback origin is permitted');
const originURL = new URL(origin);
assert.ok(origin === originURL.origin || origin === originURL.origin + '/', 'Use a canonical loopback origin');
const target = new URL('/sharing', originURL);
assert.equal(target.username, ''); assert.equal(target.password, '');
assert.equal(target.search, ''); assert.equal(target.hash, '');
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const limits = Object.freeze({ nativeRunMs: old ? 30000 : 120000, stepMs: 5000, expiryMs: 31000, navigationMs: 10000, requests: old ? 256 : 768, checks: old ? 12 : 40, receiptBytes: 16384 });
const sources = ['app/sharing/page.tsx', 'app/sharing/SharingView.tsx', 'app/sharing/sharing-task.ts', 'app/sharing/sharing.module.css', 'tools/qa-connected-sharing.mjs',
  ...(!old ? ['app/sharing/ConnectedSharingView.tsx', 'app/sharing/connected-sharing-task.ts', 'app/sharing/sharing-peer.ts'] : [])];
const dependencies = ['packages/connect/src/index.ts', 'packages/device-runtime/src/input-ownership.ts', 'packages/device-runtime/src/route-group-runtime.ts', 'packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/index.ts', 'packages/device-runtime/src/lease.ts', 'packages/device-runtime/src/scheduler.ts', 'packages/device-web/src/pointer-driver.ts', 'packages/device-web/src/pointer-provider.ts', 'packages/device-web/src/index.ts', 'packages/device-model/src/input-profile.ts', 'packages/device-model/src/descriptor.ts', 'packages/device-model/src/route-group.ts', 'packages/device-model/src/index.ts', 'app/globals.css', 'app/components/AppShell.tsx', 'vite.config.ts', 'package.json', 'package-lock.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (!old) dependencies.push('packages/device-web/src/authenticated-peer.ts', 'packages/device-web/src/identity-format.ts', 'packages/device-web/src/web-identity.ts',
  'packages/device-web/src/invitation.ts', 'packages/device-web/src/manual-peer.ts', 'packages/device-web/src/binding.ts', 'packages/device-web/src/wire.ts',
  'packages/transport-webrtc/src/peer.ts', 'packages/transport-webrtc/src/ports.ts', 'packages/device-model/src/remote-clock.ts', 'packages/device-model/src/observation-timing.ts');
const pin = paths => Object.fromEntries(paths.map(path => [path, digest(readFileSync(join(root, path)))]));
const sourcePins = pin(sources), dependencyPins = pin(dependencies);
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 16384 }).trim();
const sourceRevision = { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
function boundedFile(path, maximum) {
  assert.ok(isAbsolute(path) && path.length <= 4096);
  for (let index = 0; index < path.length; index++) { const code = path.charCodeAt(index); assert.ok(code > 31 && code !== 127); }
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum);
  const bytes = readFileSync(path); assert.ok(bytes.length <= maximum); return bytes;
}
const proofPath = options.get('--served-proof'), proofBytes = boundedFile(proofPath, 524288);
const proof = JSON.parse(proofBytes.toString('utf8'));
assert.deepEqual(Object.keys(proof).sort(), ['schemaVersion', 'profile', 'origin', 'sourceCommit', 'builtSourceTree', 'requiredBuildProvenance', 'serverRoot', 'clientRoot', 'serverBuildPins', 'clientBuildPins'].sort());
assert.equal(proof.schemaVersion, 1); assert.equal(proof.profile, 'connected-sharing-preserved-build/1');
assert.equal(proof.origin, target.origin); assert.equal(proof.sourceCommit, sourceRevision.head);
assert.match(proof.sourceCommit, /^[a-f0-9]{40}$/); assert.match(proof.builtSourceTree, /^[a-f0-9]{40}$/);
assert.deepEqual(Object.keys(proof.requiredBuildProvenance).sort(), ['path', 'sha256']);
assert.match(proof.requiredBuildProvenance.sha256, /^[a-f0-9]{64}$/);
const gateBytes = boundedFile(proof.requiredBuildProvenance.path, 524288);
assert.equal(digest(gateBytes), proof.requiredBuildProvenance.sha256);
const gates = JSON.parse(gateBytes.toString('utf8'));
assert.equal(gates.status, 'pass'); assert.equal(gates.tree, proof.builtSourceTree);
assert.ok(Array.isArray(gates.gates) && gates.gates.length > 0 && gates.gates.length <= 5);
if (old) { assert.equal(gates.gates.length, 5); assert.deepEqual(gates.gates.map(gate => gate.name).sort(), ['build', 'lint', 'rendered', 'types', 'unit']); }
assert.equal(gates.gates.filter(gate => gate.name === 'build').length, 1);
for (const gate of gates.gates) { assert.equal(gate.exitCode, 0); assert.equal(gate.signal, null); assert.equal(gate.timedOut, false); }
function verifyBuild(rootPath, pins, expectedCount) {
  assert.ok(isAbsolute(rootPath) && rootPath.length <= 4096 && lstatSync(rootPath).isDirectory() && !lstatSync(rootPath).isSymbolicLink());
  assert.ok(pins !== null && typeof pins === 'object' && !Array.isArray(pins));
  const paths = Object.keys(pins).sort(); assert.ok(paths.length > 0 && paths.length <= 1024); if (expectedCount !== undefined) assert.equal(paths.length, expectedCount);
  const actual = [], pending = [rootPath], rootReal = realpathSync(rootPath); let directories = 0;
  while (pending.length) {
    const directory = pending.pop(); assert.ok(++directories <= 1024);
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      assert.ok(!item.isSymbolicLink(), 'Preserved build inventory cannot contain links');
      if (item.isDirectory()) pending.push(path);
      else { assert.ok(item.isFile()); actual.push(path); assert.ok(actual.length <= 1024); }
    }
  }
  assert.deepEqual(actual.sort(), paths, 'Complete literal preserved build inventory');
  for (const path of paths) {
    const inside = relative(rootReal, realpathSync(path));
    assert.ok(inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside));
    assert.match(pins[path], /^[a-f0-9]{64}$/); assert.equal(digest(boundedFile(path, 33554432)), pins[path]);
  }
  return { count: paths.length, inventorySha256: digest(JSON.stringify(pins)) };
}
const serverInventory = verifyBuild(proof.serverRoot, proof.serverBuildPins, old ? 180 : undefined);
const clientInventory = verifyBuild(proof.clientRoot, proof.clientBuildPins, old ? 334 : undefined);
assert.ok(Object.hasOwn(proof.serverBuildPins, join(proof.serverRoot, 'index.js')));
const clientManifestPath = join(proof.clientRoot, '.vite/manifest.json');
assert.ok(Object.hasOwn(proof.clientBuildPins, clientManifestPath));
const clientManifest = JSON.parse(boundedFile(clientManifestPath, 1048576).toString('utf8'));
const entries = Object.values(clientManifest).filter(entry => entry && entry.isEntry === true && entry.src === 'virtual:vinext-app-browser-entry');
assert.equal(entries.length, 1, 'Actual preserved browser entry is required');
const clientEntry = new URL('/' + entries[0].file, target.origin).pathname;
assert.ok(Object.hasOwn(proof.clientBuildPins, join(proof.clientRoot, '.' + clientEntry)));
// Sharing and its selected dependencies must be the immutable built source,
// rather than unrelated mutable primary package fixes present at execution.
for (const path of [...sources.filter(path => path !== 'tools/qa-connected-sharing.mjs'), ...dependencies]) {
  const builtBytes = execFileSync('git', ['show', proof.builtSourceTree + ':' + path], { cwd: root, maxBuffer: 1048576 });
  assert.equal(digest(builtBytes), sourcePins[path] ?? dependencyPins[path], 'Exact preserved Sharing dependency: ' + path);
}
const servedBuild = { proof: { path: proofPath, sha256: digest(proofBytes) }, sourceCommit: proof.sourceCommit,
  builtSourceTree: proof.builtSourceTree, requiredBuildProvenance: proof.requiredBuildProvenance, serverInventory, clientInventory };
const packageBytes = readFileSync(require.resolve('playwright/package.json'));
const playwright = { version: JSON.parse(packageBytes.toString('utf8')).version, packageSha256: digest(packageBytes) };
const output = mkdtempSync(join(tmpdir(), old ? '101-connected-sharing-old-' : '101-connected-sharing-native-'));
const checks = [], cleanupErrors = [], errors = [], foreign = [];
const clientResponseFacts = []; let clientResponseCount = 0, entryResponse;
let phase = 'launch', browserServer, browser, context, page, child, childClosed, browserVersion;
const additionalContexts = [], additionalPages = [];
let nativeRTC = { issued: 0, closed: 0, open: 0 }, finalSharingReleased = false;
let childCloseObserved = false, browserServerCloseObserved = false, timedOut = false, interrupted = false;
let prefixComplete = false, localOutputReleased = false, localSetupStopped = false, requests = 0, missingActionObserved = false;
let failure, closeJob;
const transferObservations = [];
async function observeTransfer(label) {
  const pages = [page, ...additionalPages];
  const observations = await Promise.all(pages.map(async (owned, index) => {
    if (!owned || owned.isClosed()) return { index, closed: true };
    return owned.evaluate(index => ({ index, clock: 'this-page-performance', at: performance.now(),
      visibility: document.visibilityState, focused: document.hasFocus(),
      status: document.querySelector('#connected-sharing-status')?.textContent?.slice(0, 160),
      padStatus: document.querySelector('#connected-sharing-pad-status')?.textContent?.slice(0, 160),
      pressDisabled: [...document.querySelectorAll('button')].find(button => button.textContent === 'Press')?.disabled,
      transitions: globalThis.__connectedSharingTransitions?.(),
      exclusive: { owner: document.querySelector('[data-testid="connected-owner-exclusive"]')?.textContent?.slice(0, 80),
        held: document.querySelector('[data-testid="connected-output-exclusive"]')?.getAttribute('data-held') },
      events: globalThis.__connectedSharingEvents?.slice(-6), native: globalThis.__connectedSharingNative?.(),
    }), index);
  }));
  transferObservations.push({ label, observations });
}
function current() { assert.ok(!timedOut && !interrupted, 'Owned QA run expired or was cancelled'); }
function check(name) { current(); assert.ok(checks.length < limits.checks); checks.push(name); }
function closeServer() {
  if (!browserServer) return Promise.resolve();
  closeJob ??= browserServer.close(); return closeJob;
}
async function nativeTracking(ownedContext) {
  await ownedContext.addInitScript(() => {
    const NativePeer = globalThis.RTCPeerConnection, peers = new Set(); let issued = 0;
    // Read-only diagnostic listeners: no clock, visibility, authority or input substitutions.
    const events = []; Object.defineProperty(globalThis, '__connectedSharingEvents', { value: events });
    const observe = type => { if (events.length === 32) events.shift(); events.push([performance.now(), type, document.visibilityState]); };
    observe('initial');
    for (const type of ['focus', 'blur', 'pagehide']) window.addEventListener(type, () => observe(type), { passive: true });
    document.addEventListener('visibilitychange', () => observe('visibilitychange'), { passive: true });
    const transitions = []; let previous = '', lastRequest;
    const snapshot = type => {
      const controls = document.querySelector('[data-testid="connected-participant-controls"]');
      if (!controls) return;
      const buttons = [...controls.querySelectorAll('button')], press = buttons.find(button => button.textContent === 'Press');
      const value = { status: document.querySelector('#connected-sharing-status')?.textContent?.slice(0, 160),
        padStatus: document.querySelector('#connected-sharing-pad-status')?.textContent?.slice(0, 160), pressDisabled: press?.disabled,
        requestAction: buttons.find(button => ['Stop my sharing', 'Cancel my request'].includes(button.textContent))?.textContent,
        visibility: document.visibilityState };
      const signature = JSON.stringify(value); if (type === 'dom' && signature === previous) return; previous = signature;
      if (transitions.length === 32) transitions.shift(); transitions.push({ at: performance.now(), type, ...value });
    };
    // Observe the original native click and rendered state; never modify input,
    // focus, visibility, clocks, consent, time bounds or product state.
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button') : undefined;
      if (button && /^Request (?:whole play area|left side|right side)$/.test(button.textContent ?? '')) {
        const duration = [...document.querySelectorAll('select')].find(select => select.closest('label')?.textContent?.startsWith('Sharing duration'))?.value;
        lastRequest = { at: performance.now(), durationSeconds: Number(duration) }; snapshot('request-click');
      }
    }, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => snapshot('visibilitychange'), { passive: true });
    const observeDOM = () => { snapshot('initial'); new MutationObserver(() => snapshot('dom')).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled'] }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeDOM, { once: true }); else observeDOM();
    Object.defineProperty(globalThis, '__connectedSharingTransitions', { value: () => ({ clock: 'this-page-performance', lastRequest, recent: transitions.slice(-4) }) });
    Object.defineProperty(globalThis, '__connectedSharingNative', { value: () => ({ issued, closed: [...peers].filter(peer => peer.connectionState === 'closed').length,
      open: [...peers].filter(peer => peer.connectionState !== 'closed').length,
      states: [...peers].map(peer => [peer.connectionState, peer.iceConnectionState]) }) });
    if (typeof NativePeer !== 'function') return;
    globalThis.RTCPeerConnection = new Proxy(NativePeer, { construct(Target, args) {
      if (++issued > 4) throw Error('Owned native peer fixture quota');
      const peer = Reflect.construct(Target, args, Target); peers.add(peer);
      peer.addEventListener('connectionstatechange', () => observe('peer:' + peer.connectionState), { passive: true }); return peer;
    } });
  });
}
async function configureContext(ownedContext) {
  ownedContext.setDefaultTimeout(limits.stepMs); ownedContext.setDefaultNavigationTimeout(limits.navigationMs);
  await ownedContext.route('**/*', route => {
    requests++; const url = new URL(route.request().url());
    if (url.origin !== target.origin || requests > limits.requests) { if (url.origin !== target.origin) foreign.push('blocked-foreign-request'); return route.abort(); }
    return route.continue();
  });
  await ownedContext.routeWebSocket('**/*', socket => { foreign.push('blocked-unexpected-page-websocket'); socket.close(); });
  await nativeTracking(ownedContext);
}
function cancel() { interrupted = true; void closeServer().catch(error => { cleanupErrors.push(error); }); }
const watchdog = setTimeout(() => { timedOut = true; void closeServer().catch(error => { cleanupErrors.push(error); }); }, limits.nativeRunMs);
process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
try {
  browserServer = await engine.launchServer({ host: '127.0.0.1', port: 0, headless: true, timeout: limits.navigationMs,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  browserServer.once('close', () => { browserServerCloseObserved = true; });
  child = browserServer.process();
  childClosed = new Promise(resolve => { child.once('close', () => { childCloseObserved = true; resolve(); }); });
  current();
  const controlEndpoint = new URL(browserServer.wsEndpoint());
  assert.equal(controlEndpoint.hostname, '127.0.0.1');
  browser = await engine.connect(controlEndpoint.href, { timeout: limits.navigationMs }); current();
  browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce', acceptDownloads: false }); current();
  if (!old) await nativeTracking(context);
  context.setDefaultTimeout(limits.stepMs); context.setDefaultNavigationTimeout(limits.navigationMs);
  await context.route('**/*', route => {
    requests++;
    const url = new URL(route.request().url());
    if (url.origin !== target.origin || requests > limits.requests) {
      if (url.origin !== target.origin) foreign.push('blocked-foreign-request');
      return route.abort();
    }
    return route.continue();
  });
  // This prefix needs no page transport. No ambient WebSocket may be contacted.
  await context.routeWebSocket('**/*', socket => { foreign.push('blocked-unexpected-page-websocket'); socket.close(); });
  page = await context.newPage(); current();
  page.on('pageerror', error => { if (errors.length < 8) errors.push(error); });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== target.origin || !Object.hasOwn(proof.clientBuildPins, join(proof.clientRoot, '.' + url.pathname))) return;
    clientResponseCount++;
    const fact = { path: url.pathname.slice(0, 256), status: response.status(), contentType: (response.headers()['content-type'] ?? '').slice(0, 128) };
    if (clientResponseFacts.length < 8) clientResponseFacts.push(fact);
    if (url.pathname === clientEntry) entryResponse = fact;
  });
  phase = 'existing-sharing-arrival';
  const response = await page.goto(target.href); current();
  assert.ok(response && response.ok(), 'Actual existing Sharing route must load');
  await page.getByRole('heading', { name: 'Choose who can use your play area', exact: true }).waitFor(); current();
  await page.getByRole('button', { name: 'Start sharing setup', exact: true }).waitFor(); current();
  // These controls also exist in server HTML before their React handlers attach.
  // Match the existing genuine Sharing QA's client-load barrier before input.
  await page.waitForLoadState('networkidle'); current();
  assert.ok(entryResponse, 'The actual pinned browser entry must be requested');
  assert.equal(entryResponse.status, 200, 'The actual pinned browser entry must be served successfully');
  assert.match(entryResponse.contentType, /^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/, 'The actual browser entry needs a JavaScript response, not application HTML');
  check('actual-pinned-client-entry-loaded');
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.match(await page.locator('#sharing-status').innerText(), /Nothing is shared/);
  assert.equal(await page.getByTestId('sharing-surface-left').count(), 0); check('actual-sharing-inert-arrival');

  phase = 'existing-local-consent-and-approval';
  await page.getByRole('button', { name: 'Start sharing setup', exact: true }).click(); current();
  const controls = page.getByTestId('sharing-controls-first'), surface = page.getByTestId('sharing-surface-left');
  await controls.waitFor(); current();
  assert.equal(await controls.getByRole('button', { name: 'Request sharing for First controls', exact: true }).isDisabled(), true);
  await controls.getByRole('combobox', { name: 'Area for First controls', exact: true }).selectOption('left'); current();
  await controls.getByRole('checkbox').check(); current();
  await controls.getByRole('button', { name: 'Request sharing for First controls', exact: true }).click(); current();
  const review = page.getByTestId('sharing-review-left');
  await review.waitFor(); current();
  assert.equal(await surface.getAttribute('data-x'), null);
  assert.equal(await surface.getAttribute('data-held'), 'false'); check('actual-source-consent-pending-owner-approval');
  await review.getByRole('button', { name: 'Approve sharing', exact: true }).click(); current();
  await page.waitForFunction(() => document.querySelector('[data-testid="sharing-owner-left"]')?.textContent === 'First controls' && document.querySelector('[data-testid="sharing-surface-left"]')?.hasAttribute('data-x'));
  current(); check('actual-public-runtime-owner-activation');

  phase = 'existing-local-producer-effects';
  const initialX = Number(await surface.getAttribute('data-x')); assert.ok(Number.isFinite(initialX));
  await controls.getByRole('button', { name: 'Move First controls right', exact: true }).click(); current();
  await page.waitForFunction(before => Number(document.querySelector('[data-testid="sharing-surface-left"]')?.getAttribute('data-x')) > before, initialX);
  current(); check('actual-native-button-provider-movement');
  await controls.getByRole('button', { name: 'Press First controls', exact: true }).click(); current();
  await page.waitForFunction(() => document.querySelector('[data-testid="sharing-surface-left"]')?.getAttribute('data-held') === 'true');
  current(); check('actual-native-button-provider-held-press');

  phase = 'existing-local-release-and-stop';
  // Stop this setup removes its output DOM. Observe genuine route release via
  // Stop all sharing while that output still exists, then close the setup.
  await page.getByRole('button', { name: 'Stop all sharing', exact: true }).click(); current();
  await page.waitForFunction(() => document.querySelector('[data-testid="sharing-surface-left"]')?.getAttribute('data-held') === 'false' && document.querySelector('[data-testid="sharing-owner-left"]')?.textContent === 'None' && !document.querySelector('[data-testid="sharing-surface-left"]')?.hasAttribute('data-x'));
  current(); localOutputReleased = true; check('actual-owner-stop-releases-held-output');
  await page.getByRole('button', { name: 'Stop this setup', exact: true }).click(); current();
  await page.getByRole('button', { name: 'Start sharing setup', exact: true }).waitFor(); current();
  assert.equal(await surface.count(), 0); localSetupStopped = true; check('actual-local-setup-stopped');
  assert.equal(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })), stored);
  assert.deepEqual(errors, []); assert.deepEqual(foreign, []); check('existing-prefix-no-storage-or-foreign-effects');
  prefixComplete = true;

  phase = 'connected-action';
  const connected = page.getByRole('button', { name: 'Connect participants', exact: true });
  const connectedCount = await connected.count(); missingActionObserved = connectedCount === 0;
  assert.equal(connectedCount, 1, 'After actual existing producer movement, held press and release, Sharing must expose the accessible Connect participants action');
  assert.equal(await connected.isVisible(), true); assert.equal(await connected.isEnabled(), true);
  check('accessible-connect-participants-action');
  if (!old) {
    phase = 'connected-inert-arrival';
    await connected.click(); current();
    const initialNative = await page.evaluate(() => globalThis.__connectedSharingNative()); assert.equal(initialNative.issued, 0);
    await page.getByRole('button', { name: 'Start connected setup', exact: true }).click(); current();
    assert.equal(await page.evaluate(() => globalThis.__connectedSharingNative().issued), 0); check('connected-owner-setup-inert-before-invitation');
    const participantPages = [], storage = [stored];
    for (let index = 0; index < 2; index++) {
      const ownedContext = await browser.newContext({ viewport: { width: index ? 360 : 1280, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: false }); additionalContexts.push(ownedContext);
      await configureContext(ownedContext); const sourcePage = await ownedContext.newPage(); additionalPages.push(sourcePage); participantPages.push(sourcePage);
      sourcePage.on('pageerror', error => { if (errors.length < 8) errors.push(error); });
      await sourcePage.goto(target.href); await sourcePage.waitForLoadState('networkidle'); current();
      storage.push(await sourcePage.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })));
      await sourcePage.getByRole('button', { name: 'Connect participants', exact: true }).click();
      await sourcePage.getByRole('combobox', { name: 'Page role', exact: true }).selectOption('participant');
      await sourcePage.getByRole('button', { name: 'Start connected setup', exact: true }).click();
      assert.equal(await sourcePage.evaluate(() => globalThis.__connectedSharingNative().issued), 0); current();
      phase = `actual-native-enrollment-${index + 1}`;
      await page.getByRole('button', { name: 'Create participant invitation', exact: true }).click();
      const ownerPeer = page.getByTestId(`connected-peer-participant-${index + 1}`), sourcePeer = sourcePage.getByTestId('connected-peer-participant-1');
      const invitation = ownerPeer.getByRole('textbox', { name: `Participant ${index + 1} Code for the participant`, exact: true }); await invitation.waitFor();
      await sourcePage.getByRole('textbox', { name: 'Owner invitation', exact: true }).fill(await invitation.inputValue());
      await sourcePage.getByRole('button', { name: 'Review invitation', exact: true }).click();
      await sourcePage.getByRole('button', { name: 'Create connection offer', exact: true }).click();
      const offer = sourcePeer.getByRole('textbox', { name: 'Connected owner page Code for the owner', exact: true }); await offer.waitFor();
      await ownerPeer.getByRole('textbox', { name: `Participant ${index + 1} Participant offer`, exact: true }).fill(await offer.inputValue());
      await ownerPeer.getByRole('button', { name: 'Accept participant offer', exact: true }).click();
      await page.waitForFunction(id => {
        const code = document.querySelector(`[data-testid="connected-peer-${id}"] textarea[readonly]`)?.value;
        if (!code?.startsWith('101-sharing-1.') || code.length > 65536) return false;
        try { const body = code.slice('101-sharing-1.'.length); return JSON.parse(atob(body.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - body.length % 4) % 4))).kind === 'answer'; } catch { return false; }
      }, `participant-${index + 1}`); current();
      const answerCode = await invitation.inputValue();
      await sourcePeer.getByRole('textbox', { name: 'Connected owner page Owner answer', exact: true }).fill(answerCode);
      await sourcePeer.getByRole('button', { name: 'Accept owner answer', exact: true }).click();
      const ownerComparison = page.getByTestId(`connected-comparison-participant-${index + 1}`), sourceComparison = sourcePage.getByTestId('connected-comparison-participant-1');
      await ownerComparison.waitFor(); await sourceComparison.waitFor(); assert.equal(await ownerComparison.innerText(), await sourceComparison.innerText());
      await ownerPeer.getByRole('button', { name: 'The codes match', exact: true }).click();
      await sourcePeer.getByRole('button', { name: 'The codes match', exact: true }).click();
      await ownerPeer.getByText('The connected page is verified. Connecting does not share controls.', { exact: true }).waitFor();
      await sourcePeer.getByText('The connected page is verified. Connecting does not share controls.', { exact: true }).waitFor(); current();
      assert.equal(await sourcePage.getByRole('button', { name: 'Press', exact: true }).count(), 0); check(`native-peer-${index + 1}-bilateral-comparison-without-input`);
    }
    await page.getByRole('button', { name: 'Finish participant setup', exact: true }).click();
    for (const sourcePage of participantPages) { await sourcePage.getByTestId('connected-participant-controls').waitFor(); assert.equal(await sourcePage.getByRole('button', { name: 'Press', exact: true }).isDisabled(), true); }
    assert.equal(await page.getByRole('button', { name: 'Create participant invitation', exact: true }).isDisabled(), true); check('actual-roster-frozen-no-input-on-connection');
    async function ask(sourcePage, areaName) {
      await sourcePage.getByRole('combobox', { name: 'Requested area', exact: true }).selectOption(areaName);
      await sourcePage.getByRole('combobox', { name: 'Sharing duration', exact: true }).selectOption('30');
      await sourcePage.getByTestId('connected-participant-controls').getByRole('checkbox').check();
      await sourcePage.getByRole('button', { name: `Request ${areaName === 'exclusive' ? 'whole play area' : areaName + ' side'}`, exact: true }).click(); current();
    }
    async function approve(areaName) {
      const review = page.getByTestId(`connected-review-${areaName}`); await review.waitFor();
      const button = review.getByRole('button', { name: /^Approve Participant/ }); await button.waitFor();
      await button.click(); current();
    }
    async function active(sourcePage) { await sourcePage.getByRole('button', { name: 'Press', exact: true }).waitFor();
      await sourcePage.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Press')?.disabled); current(); }
    async function effect(areaName, held) { await page.waitForFunction(({ id, held }) => document.querySelector(`[data-testid="connected-output-${id}"]`)?.getAttribute('data-held') === String(held), { id: areaName, held }); current(); }
    phase = 'actual-source-and-owner-consent';
    const first = participantPages[0], second = participantPages[1];
    await ask(first, 'left'); await page.getByTestId('connected-review-left').waitFor();
    assert.equal(await first.getByRole('button', { name: 'Press', exact: true }).isDisabled(), true);
    assert.equal(await page.getByTestId('connected-owner-left').innerText(), 'None'); check('actual-source-request-does-not-authorize-output');
    await approve('left'); await active(first); await ask(second, 'right'); await approve('right'); await active(second); check('independent-source-and-owner-approvals');
    const pad = first.getByRole('button', { name: 'Your connected movement pad', exact: true }); await pad.focus();
    await first.keyboard.down('Space'); await effect('left', true); await first.keyboard.up('Space'); await effect('left', false);
    await first.keyboard.down('Space'); await effect('left', true); await first.locator('#connected-sharing-status').focus(); await effect('left', false); await first.keyboard.up('Space');
    check('actual-keyboard-held-and-focus-loss-release');
    await first.getByRole('button', { name: 'Move right', exact: true }).click();
    await second.getByRole('button', { name: 'Move left', exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="connected-output-left"]')?.getAttribute('data-x')) > .5 && Number(document.querySelector('[data-testid="connected-output-right"]')?.getAttribute('data-x')) < .5);
    await first.getByRole('button', { name: 'Press', exact: true }).click(); await effect('left', true); check('native-two-partition-position-and-held-effect');
    await second.getByRole('button', { name: 'Press', exact: true }).click(); await effect('right', true);
    await page.getByRole('button', { name: 'Stop Participant 1 on left side', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm stop sharing', exact: true }).click(); await effect('left', false);
    assert.equal(await page.getByTestId('connected-owner-right').innerText(), 'Participant 2'); assert.equal(await page.getByTestId('connected-output-right').getAttribute('data-held'), 'true'); check('scoped-native-revoke-retains-other-partition-held-output');
    await ask(first, 'left'); await approve('left'); await active(first); await first.getByRole('button', { name: 'Press', exact: true }).click(); await effect('left', true);
    phase = 'incumbent-preserving-decline';
    await second.getByRole('button', { name: 'Stop my sharing', exact: true }).click(); await effect('right', false);
    await ask(second, 'left'); await page.getByTestId('connected-review-left').getByRole('button', { name: 'Decline request', exact: true }).click();
    await second.getByRole('button', { name: 'Request left side', exact: true }).waitFor();
    assert.equal(await page.getByTestId('connected-owner-left').innerText(), 'Participant 1'); assert.equal(await page.getByTestId('connected-output-left').getAttribute('data-held'), 'true'); check('decline-retains-current-native-held-output');
    phase = 'layout-release-and-exclusive-transfer';
    await page.getByRole('button', { name: 'Use one shared area', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm stop sharing', exact: true }).click();
    await page.getByTestId('connected-output-exclusive').waitFor(); assert.equal(await page.getByTestId('connected-owner-exclusive').innerText(), 'None');
    await ask(first, 'exclusive'); await approve('exclusive'); await active(first); await first.getByRole('button', { name: 'Press', exact: true }).click(); await effect('exclusive', true);
    await ask(second, 'exclusive'); await approve('exclusive'); await active(second);
    await observeTransfer('second-active-before-incumbent-release-observation');
    await first.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Press')?.disabled === true);
    assert.equal(await page.getByTestId('connected-owner-exclusive').innerText(), 'Participant 2'); await effect('exclusive', false); check('native-exclusive-transfer-releases-prior-held-input');
    phase = 'cancel-and-scoped-revoke';
    await observeTransfer('incumbent-released-before-second-press');
    await second.getByRole('button', { name: 'Press', exact: true }).click(); await effect('exclusive', true);
    await ask(first, 'exclusive'); await page.getByTestId('connected-review-exclusive').waitFor();
    await first.getByRole('button', { name: 'Cancel my request', exact: true }).click();
    await page.getByTestId('connected-review-exclusive').waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('connected-owner-exclusive').innerText(), 'Participant 2'); assert.equal(await page.getByTestId('connected-output-exclusive').getAttribute('data-held'), 'true'); check('cancel-retains-incumbent-native-held-output');
    await page.getByRole('button', { name: 'Stop Participant 2 on whole play area', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm stop sharing', exact: true }).click(); await effect('exclusive', false);
    assert.equal(await page.getByTestId('connected-owner-exclusive').innerText(), 'None'); check('explicit-scoped-revoke-releases-native-output');
    phase = 'captured-30-second-natural-expiry';
    await ask(first, 'exclusive'); await approve('exclusive'); await active(first);
    await first.getByRole('button', { name: 'Press', exact: true }).click(); await effect('exclusive', true);
    await page.waitForFunction(() => document.querySelector('[data-testid="connected-owner-exclusive"]')?.textContent === 'None' && document.querySelector('[data-testid="connected-output-exclusive"]')?.getAttribute('data-held') === 'false', undefined, { timeout: limits.expiryMs }); current();
    assert.equal(await first.getByRole('button', { name: 'Press', exact: true }).isDisabled(), true); check('natural-fixed-consent-expiry-releases-held-output');
    phase = 'fresh-request-after-expiry-and-native-loss';
    await ask(second, 'exclusive'); await approve('exclusive'); await active(second);
    await observeTransfer('second-active-before-incumbent-release-observation'); await second.getByRole('button', { name: 'Press', exact: true }).click(); await effect('exclusive', true);
    await second.getByRole('button', { name: 'Stop connected setup', exact: true }).click();
    await effect('exclusive', false); assert.equal(await page.getByTestId('connected-owner-exclusive').innerText(), 'None'); check('fresh-consent-recovery-and-native-peer-close-release');
    phase = 'connected-layout-keyboard-storage-and-stop';
    assert.equal(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await first.getByRole('button', { name: 'Your connected movement pad', exact: true }).count();
    for (let index = 0; index < 3; index++) {
      const ownedPage = index === 0 ? page : participantPages[index - 1];
      assert.equal(await ownedPage.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })), storage[index]);
      if (await ownedPage.getByRole('button', { name: 'Stop connected setup', exact: true }).count()) await ownedPage.getByRole('button', { name: 'Stop connected setup', exact: true }).click();
      await ownedPage.getByRole('button', { name: 'Start connected setup', exact: true }).waitFor();
      await ownedPage.waitForFunction(() => globalThis.__connectedSharingNative().open === 0 && [...document.querySelectorAll('button')].find(button => button.textContent === 'Start connected setup')?.disabled === false);
      const counts = await ownedPage.evaluate(() => globalThis.__connectedSharingNative()); for (const key of ['issued', 'closed', 'open']) nativeRTC[key] += counts[key];
    }
    assert.equal(nativeRTC.issued, 4); assert.equal(nativeRTC.closed, 4); assert.equal(nativeRTC.open, 0); finalSharingReleased = true;
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []); check('actual-native-peer-close-await-and-storage-inert-cleanup');
  }
} catch (error) {
  failure = error;
  if (!old) try { await observeTransfer('failure-before-cleanup'); } catch (observationError) { transferObservations.push({ label: 'observation-unavailable', message: observationError.message.slice(0, 128) }); }
}
finally {
  clearTimeout(watchdog); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  if (!old) {
    nativeRTC = { issued: 0, closed: 0, open: 0 };
    for (const ownedPage of [page, ...additionalPages]) if (ownedPage && !ownedPage.isClosed()) try {
      const stop = ownedPage.getByRole('button', { name: 'Stop connected setup', exact: true });
      if (await stop.count()) { await stop.click(); await ownedPage.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Start connected setup')?.disabled === false); }
      const counts = await ownedPage.evaluate(() => globalThis.__connectedSharingNative());
      for (const key of ['issued', 'closed', 'open']) nativeRTC[key] += counts[key];
      assert.equal(counts.open, 0, 'Actual issued native peer closes before its page');
    } catch (error) { cleanupErrors.push(error); }
  }
  for (const ownedPage of additionalPages) if (!ownedPage.isClosed()) try { await ownedPage.close(); } catch (error) { cleanupErrors.push(error); }
  for (const ownedContext of additionalContexts) try { await ownedContext.close(); } catch (error) { cleanupErrors.push(error); }
  if (page && !page.isClosed()) try { await page.close(); } catch (error) { cleanupErrors.push(error); }
  if (context) try { await context.close(); } catch (error) { cleanupErrors.push(error); }
  if (browser?.isConnected()) try { await browser.close(); } catch (error) { cleanupErrors.push(error); }
  try { await closeServer(); } catch (error) { cleanupErrors.push(error); }
  if (childClosed) await childClosed;
  try { assert.deepEqual(pin(sources), sourcePins); assert.deepEqual(pin(dependencies), dependencyPins); }
  catch (error) { cleanupErrors.push(error); }
  try { verifyBuild(proof.serverRoot, proof.serverBuildPins, old ? 180 : undefined); verifyBuild(proof.clientRoot, proof.clientBuildPins, old ? 334 : undefined); }
  catch (error) { cleanupErrors.push(error); }
}
const cleanup = { pageClosed: !page || page.isClosed(), contextPages: context ? context.pages().length : 0,
  additionalPagesClosed: additionalPages.every(ownedPage => ownedPage.isClosed()), additionalContextPages: additionalContexts.reduce((count, ownedContext) => count + ownedContext.pages().length, 0),
  browserConnected: !!browser?.isConnected(), nativeBrowserChildCloseObserved: child ? childCloseObserved : null,
  browserServerCloseObserved: browserServer ? browserServerCloseObserved : null,
  qaTimers: 0, qaSignalListeners: Number(process.listeners('SIGINT').includes(cancel)) + Number(process.listeners('SIGTERM').includes(cancel)),
  appServerOwnedByQA: false, errors: cleanupErrors.length };
const intendedMissing = prefixComplete && missingActionObserved && failure instanceof assert.AssertionError && phase === 'connected-action' && cleanupErrors.length === 0 && !timedOut && !interrupted;
let transferDiagnostics;
if (!old) {
  const bytes = JSON.stringify({ schemaVersion: 1, profile: 'connected-sharing-transfer-observations/1', observations: transferObservations }) + '\n';
  assert.ok(Buffer.byteLength(bytes) <= 32768, 'Bounded separate read-only transfer observations');
  const path = join(output, 'transfer-observations.json'); writeFileSync(path, bytes);
  transferDiagnostics = { path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes), maximumBytes: 32768 };
}
const receipt = { schemaVersion: 1, profile: old ? 'connected-sharing-old-action/1' : 'connected-page-sharing-native/1', result: failure || cleanupErrors.length ? 'fail' : 'pass', selector: old ? '--old-red' : '--connected', phase,
  classification: intendedMissing ? 'intended-old-missing-action-red' : failure || cleanupErrors.length ? 'unexpected-prerequisite-or-cleanup-failure' : old ? 'connected-action-present' : 'selected-native-journey-pass',
  prefixComplete, localOutputReleased, localSetupStopped, checks, limits, sourcePins, dependencyPins, sourceRevision, servedBuild,
  toolchain: { node: process.version, playwright, engine: engineName, browserVersion, executable: engine.executablePath() },
  nativeBrowserPid: child?.pid, pageErrors: errors.length, foreignRequests: foreign.length, requests, timedOut, interrupted, cleanup,
  clientReadiness: { entry: clientEntry, entryResponse, clientResponseCount, retainedClientResponses: clientResponseFacts },
  nativeRTC: old ? undefined : nativeRTC, finalSharingReleased, transferDiagnostics,
  scope: [old ? 'Actual existing same-page public SDK local producer and runtime effects; new connected action is checked only after that prefix.' : 'Actual three isolated browser contexts, native RTC/cryptographic bilateral enrollment and separately approved source/owner page-control effects. Wrapper observes genuine native peer construction/state, never substitutes a data producer.',
    old ? 'No page peer/native RTC enrollment, connected participant authority, observer, phone, OS pointer, hardware or full accessibility qualification.' : 'Selected native software journey only. No account identity, observer distribution, phone, OS pointer, cross-network or hardware/full accessibility claim. SDK-internal native crypto quiescence is not independently observable from this app caller.',
    'Caller owns loopback app server and endpoint-to-build attachment. Literal preserved server/client inventories and successful exact build record are verified; this tool starts no app server.'], published: false };
const bytes = JSON.stringify(receipt) + '\n';
assert.ok(Buffer.byteLength(bytes) <= limits.receiptBytes, 'Bounded actual receipt including newline');
writeFileSync(join(output, 'receipt.json'), bytes);
console.log(JSON.stringify({ result: receipt.result, classification: receipt.classification, receipt: join(output, 'receipt.json'),
  receiptSha256: digest(bytes), phase, prefixComplete, checks, cleanup }));
if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Connected Sharing old selector or actual cleanup failed');
if (failure) throw failure;
