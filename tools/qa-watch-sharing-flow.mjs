import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// TESTS-FIRST / UNRUN. The caller owns the actual app server and its settlement.
// OLD serves only its preserved original UI. A new selector is not served UI.
const args = process.argv.slice(2);
assert.ok(args.length >= 3, 'ORIGIN --served-proof ABSOLUTE_JSON [--engine chromium|webkit] [--old-red]');
const application = new URL(args.shift());
let proofPath, selected = 'both', engineSeen = false, old = false;
while (args.length) {
  const argument = args.shift();
  if (argument === '--served-proof' && !proofPath) proofPath = args.shift();
  else if (argument === '--engine' && !engineSeen) { engineSeen = true; selected = args.shift(); }
  else if (argument === '--old-red' && !old) old = true;
  else throw Error('Unknown or duplicate selector');
}
assert.equal(process.version, 'v24.14.0');
assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
assert.ok(['chromium', 'webkit', 'both'].includes(selected) && proofPath && isAbsolute(proofPath));
if (old) assert.equal(selected, 'chromium', 'One genuine old prefix, not duplicated engine qualification');
assert.ok(application.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(application.hostname)
  && application.pathname === '/' && !application.username && !application.password && !application.search && !application.hash,
  'Exact owned loopback application origin only');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const harnessPath = fileURLToPath(import.meta.url), harnessSha256 = hash(readFileSync(harnessPath));
const proofBytes = readFileSync(proofPath); assert.ok(proofBytes.byteLength <= 2 * 1024 * 1024);
const proof = JSON.parse(proofBytes), root = realpathSync(proof.sourceRoot);
assert.equal(proof.schemaVersion, 1); assert.equal(proof.origin, application.origin);
assert.match(proof.sourceTree, /^[a-f0-9]{40}$/); assert.ok(['source', 'built'].includes(proof.mode));
assert.equal(proof.harnessSha256, harnessSha256, 'Separate exact served graph and selector harness');
const required = ['app/layout.tsx', 'app/globals.css', 'app/components/AppShell.tsx', 'app/sharing/page.tsx',
  'app/sharing/SharingView.tsx', 'app/sharing/sharing-task.ts', 'app/sharing/sharing.module.css',
  'app/sharing/sharing-peer.ts', 'packages/connect/src/index.ts', 'packages/device-runtime/src/runtime.ts',
  'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/index.ts', 'packages/device-model/src/descriptor.ts',
  'packages/device-model/src/index.ts', 'packages/device-web/src/index.ts', 'packages/device-web/src/binding.ts',
  'packages/device-web/src/authenticated-peer.ts', 'packages/device-web/src/web-identity.ts',
  'packages/device-web/src/identity-format.ts', 'packages/device-web/src/invitation.ts', 'packages/device-web/src/wire.ts',
  'packages/transport-webrtc/src/peer.ts', 'packages/transport-webrtc/src/ports.ts', 'vite.config.ts', 'package.json', 'package-lock.json',
  ...(!old ? ['app/sharing/watch/page.tsx', 'app/sharing/watch/WatchSharingView.tsx', 'app/sharing/watch/watch-sharing-task.ts',
    'app/sharing/watch/watch-sharing-task.test.ts', 'tools/qa-watch-sharing-flow.mjs'] : [])];
for (const path of required) assert.match(proof.sourcePins?.[path] ?? '', /^[a-f0-9]{64}$/, `Required actual served input: ${path}`);
const pins = Object.entries(proof.sourcePins ?? {}); assert.ok(pins.length >= required.length && pins.length <= 4096);
function verifySources() {
  let bytesRead = 0;
  for (const [path, sha256] of pins) {
    assert.ok(/^[A-Za-z0-9._/-]+$/.test(path) && !path.startsWith('/') && !path.split('/').includes('..'));
    assert.match(sha256, /^[a-f0-9]{64}$/); const actual = realpathSync(resolve(root, path)), rel = relative(root, actual);
    assert.ok(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
    const bytes = readFileSync(actual); bytesRead += bytes.byteLength; assert.ok(bytesRead <= 64 * 1024 * 1024);
    assert.equal(hash(bytes), sha256, `Actual current source input: ${path}`);
  }
}
verifySources();
// One bounded blob batch: no per-file Git children and no source substitution.
const batch = execFileSync('git', ['cat-file', '--batch'], { cwd: root, timeout: 5000, maxBuffer: 64 * 1024 * 1024,
  input: Buffer.from(pins.map(([path]) => `${proof.sourceTree}:${path}\n`).join('')) });
let offset = 0;
for (const [path, sha256] of pins) {
  const end = batch.indexOf(10, offset); assert.ok(end >= offset);
  const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(batch.subarray(offset, end).toString('ascii'));
  assert.ok(match, `Immutable served blob: ${path}`); const size = Number(match[2]);
  assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 2 * 1024 * 1024);
  offset = end + 1; const bytes = batch.subarray(offset, offset + size); assert.equal(bytes.byteLength, size);
  assert.equal(hash(bytes), sha256, `Immutable served source: ${path}`); offset += size; assert.equal(batch[offset++], 10);
}
assert.equal(offset, batch.byteLength);
const buildInputs = proof.mode === 'built' ? proof.buildInputs : [];
if (proof.mode === 'built') {
  assert.ok(Array.isArray(buildInputs) && buildInputs.length >= 2 && buildInputs.length <= 2048);
  assert.ok(proof.buildRecord && isAbsolute(proof.buildRecord.path)); assert.match(proof.buildRecord.sha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(readFileSync(proof.buildRecord.path)), proof.buildRecord.sha256);
}
function verifyBuild() {
  let total = 0; const seen = new Set();
  for (const item of buildInputs) {
    assert.ok(item && ['server', 'client'].includes(item.kind) && isAbsolute(item.path)); assert.match(item.sha256, /^[a-f0-9]{64}$/);
    const path = realpathSync(item.path), rel = relative(root, path);
    assert.ok(rel.startsWith(`dist/${item.kind}/`) && !rel.split('/').includes('..'));
    assert.equal(seen.has(path), false); seen.add(path); const bytes = readFileSync(path); total += bytes.byteLength;
    assert.ok(total <= 64 * 1024 * 1024); assert.equal(hash(bytes), item.sha256);
  }
}
verifyBuild();
const require = createRequire(join(root, 'package.json')), { chromium, webkit } = require('playwright');
const playwrightBytes = readFileSync(require.resolve('playwright/package.json'));
const toolchain = { node: process.version, nodePath: process.execPath, playwright: JSON.parse(playwrightBytes).version,
  playwrightPackageSha256: hash(playwrightBytes) };
const limits = Object.freeze({ engines: 2, contexts: 3, peers: 4, negotiationMs: 30000, nativeRunMs: old ? 30000 : 120000,
  stepMs: 5000, navigationMs: 10000, fixedExpiryMs: 30000, expiryWaitMs: 31000, nativeTabs: 32,
  requests: 1024, checks: 48, errors: 16, receiptBytes: 32768 });
const output = mkdtempSync('/tmp/101-watch-sharing-'); chmodSync(output, 0o700);
const results = [], engines = selected === 'both' ? ['chromium', 'webkit'] : [selected]; let failure;

for (const engineName of engines) {
  const engine = engineName === 'chromium' ? chromium : webkit, pages = [], contexts = [], errors = [], foreign = [], checks = [], keyboard = [];
  const artifactRoot = join(output, engineName); mkdirSync(artifactRoot);
  let phase = 'prelaunch', browserServer, browser, browserVersion, childClose, childClosed = false, serverClosed = false;
  let timeout = false, interrupted = false, requests = 0, clientBytes = 0, prefixComplete = false, missing = false;
  let quiet, snapshotsBeforeClose, finalNative, nativeKeyHold, closeJob;
  const cleanupErrors = [], responseJobs = new Set(), responsePins = new Map();
  const cleanup = { pagesClosed: false, contextCloseAwaited: false, browserCloseAwaited: false, browserClosed: false,
    browserServerClosed: false, nativeChildCloseObserved: false, appRawObservedZero: false, ownedPeerOpen: null,
    appServerOwnedByHarness: false, responseReadsSettled: false, signalListeners: 2, timers: 1 };
  function current() { assert.ok(!timeout && !interrupted, 'Owned run cancelled or reached its original deadline'); }
  function check(name) { current(); assert.ok(checks.length < limits.checks); checks.push(name); }
  function closeServer() { if (!browserServer) return Promise.resolve(); closeJob ??= browserServer.close(); return closeJob; }
  const cancel = () => { interrupted = true; void closeServer().catch(error => cleanupErrors.push(String(error.message).slice(0, 256))); };
  const watchdog = setTimeout(() => { timeout = true; void closeServer().catch(error => cleanupErrors.push(String(error.message).slice(0, 256))); }, limits.nativeRunMs);
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const main = page => page.locator('main[data-watch-sharing-page]');
  async function nativeActivate(page, name, within = main(page)) {
    const target = within.getByRole('button', { name, exact: true }); await target.click({ trial: true });
    const key = engineName === 'webkit' ? 'Alt+Tab' : 'Tab';
    if (!await page.evaluate(() => document.hasFocus() && document.activeElement !== document.body)) {
      await main(page).getByRole('link', { name: 'Back to Sharing', exact: true }).focus();
    }
    for (let step = 0; step <= limits.nativeTabs; step++) {
      if (await target.evaluate(element => document.hasFocus() && document.activeElement === element && element.matches(':focus-visible'))) {
        keyboard.push({ name, key, step }); await page.keyboard.press('Space'); current(); return;
      }
      if (step < limits.nativeTabs) await page.keyboard.press(key);
    }
    throw Error('Actual native keyboard target was not reached');
  }
  async function recordResponses(page) {
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== application.origin || !/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/.test(response.headers()['content-type'] ?? '')) return;
      const job = (async () => {
        const bytes = await response.body(); clientBytes += bytes.byteLength; assert.ok(clientBytes <= 64 * 1024 * 1024);
        if (proof.mode === 'built') {
          const path = join(root, 'dist/client', '.' + url.pathname), pin = buildInputs.find(item => item.kind === 'client' && item.path === path);
          assert.ok(pin, 'Every emitted public/app JS response belongs to the pinned build'); assert.equal(hash(bytes), pin.sha256);
        }
        const sha256 = hash(bytes); assert.ok(responsePins.size < limits.requests || responsePins.has(url.pathname));
        const path = join(artifactRoot, `served-${sha256}.js`); writeFileSync(path, bytes);
        responsePins.set(url.pathname, { sha256, bytes: bytes.byteLength, status: response.status(), path });
      })().catch(error => errors.push(String(error.message).slice(0, 256))).finally(() => responseJobs.delete(job));
      responseJobs.add(job);
    });
  }
  async function ownedPage() {
    assert.ok(contexts.length < limits.contexts);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', acceptDownloads: false }); contexts.push(context);
    context.setDefaultTimeout(limits.stepMs); context.setDefaultNavigationTimeout(limits.navigationMs);
    await context.route('**/*', route => {
      requests++; const url = new URL(route.request().url());
      if (url.origin !== application.origin || requests > limits.requests) { foreign.push('blocked-request'); return route.abort(); }
      return route.continue();
    });
    await context.routeWebSocket('**/*', socket => { foreign.push('blocked-page-websocket'); socket.close(); });
    await context.addInitScript(() => {
      const NativePeer = globalThis.RTCPeerConnection, peers = new Set(); let issued = 0, deviceCalls = 0;
      const generate = SubtleCrypto.prototype.generateKey, nativeAdd = EventTarget.prototype.addEventListener, nativeRemove = EventTarget.prototype.removeEventListener;
      let held = false, generated = 0, pendingKeyReturns = 0, releaseKey;
      const listeners = new Map();
      globalThis.__watchNative = Object.freeze({
        snapshot: () => ({ issued, open: [...peers].filter(peer => peer.connectionState !== 'closed').length,
          closed: [...peers].filter(peer => peer.connectionState === 'closed').length, deviceCalls, generated, pendingKeyReturns,
          lifecycleListeners: [...listeners.values()].flat().filter(item => item.active).length }),
        holdNextIdentity() { held = true; }, releaseIdentity() { releaseKey?.(); },
      });
      if (typeof NativePeer === 'function') globalThis.RTCPeerConnection = new Proxy(NativePeer, { construct(Target, args) {
        if (++issued > 2) throw Error('Owned page native peer bound'); const peer = Reflect.construct(Target, args, Target); peers.add(peer); return peer;
      } });
      SubtleCrypto.prototype.generateKey = function(...arguments_) {
        const result = Reflect.apply(generate, this, arguments_); generated++;
        if (!held) return result; held = false; pendingKeyReturns++;
        const gate = new Promise(resolve => { releaseKey = resolve; });
        return Promise.all([result, gate]).then(([value]) => value).finally(() => { pendingKeyReturns--; releaseKey = undefined; });
      };
      EventTarget.prototype.addEventListener = function(type, listener, options) {
        if ((this === document || this === window) && ['visibilitychange', 'pagehide', 'blur'].includes(type) && listener) {
          const capture = typeof options === 'boolean' ? options : !!options?.capture;
          let records = listeners.get(listener); if (!records) { records = []; listeners.set(listener, records); }
          if (!records.some(item => item.target === this && item.type === type && item.capture === capture && item.active)) {
            records.push({ target: this, type, capture, active: true });
          }
        }
        return Reflect.apply(nativeAdd, this, [type, listener, options]);
      };
      EventTarget.prototype.removeEventListener = function(type, listener, options) {
        const capture = typeof options === 'boolean' ? options : !!options?.capture;
        for (const item of listeners.get(listener) ?? []) if (item.target === this && item.type === type && item.capture === capture) item.active = false;
        return Reflect.apply(nativeRemove, this, [type, listener, options]);
      };
      for (const [object, method] of [[navigator.mediaDevices, 'getUserMedia'], [navigator.mediaDevices, 'getDisplayMedia'],
        [navigator.hid, 'requestDevice'], [navigator.bluetooth, 'requestDevice'], [navigator.serial, 'requestPort']]) {
        if (object && typeof object[method] === 'function') Object.defineProperty(object, method, { configurable: true,
          value() { deviceCalls++; throw Error('Device acquisition prohibited in owned watch fixture'); } });
      }
    });
    const page = await context.newPage(); pages.push(page); await recordResponses(page);
    page.on('pageerror', error => { if (errors.length < limits.errors) errors.push(error.message.slice(0, 256)); });
    return page;
  }
  async function arrival(page) {
    const response = await page.goto(new URL('/sharing/watch', application).href, { waitUntil: 'networkidle' });
    assert.ok(response?.ok()); await main(page).getByRole('heading', { name: 'Share a read-only page view', exact: true }).waitFor();
    await main(page).getByRole('button', { name: 'Start watch setup', exact: true }).click({ trial: true });
    assert.equal(await page.evaluate(() => globalThis.__watchNative.snapshot().issued), 0);
    assert.equal(await main(page).getByTestId('watch-display').getAttribute('data-held'), 'false');
    assert.equal(await main(page).getByTestId('watch-display').getAttribute('data-x'), null);
  }
  async function start(page, role) { await main(page).getByRole('combobox', { name: 'Page role', exact: true }).selectOption(role); await nativeActivate(page, 'Start watch setup'); }
  async function effect(page, pressed) {
    await page.waitForFunction(value => document.querySelector('[data-testid="watch-display"]')?.getAttribute('data-held') === String(value), pressed);
  }
  async function ask(page) { await main(page).getByRole('checkbox', { name: 'Allow this page to display the shared view', exact: true }).check(); await nativeActivate(page, 'Request a read-only view'); }
  async function approve(page, id) {
    const review = main(page).getByTestId(`watch-review-${id}`); await review.waitFor();
    await nativeActivate(page, `Allow Observer ${id.slice(-1)} to view`, review);
  }
  async function stop(page) {
    const button = main(page).getByRole('button', { name: 'Stop watch setup', exact: true });
    if (await button.count()) { await button.click(); await main(page).getByRole('button', { name: 'Start watch setup', exact: true }).click({ trial: true }); }
    await page.waitForFunction(() => globalThis.__watchNative.snapshot().open === 0 && globalThis.__watchNative.snapshot().pendingKeyReturns === 0
      && document.querySelector('[data-testid="watch-raw"]')?.getAttribute('data-pending') === '0');
  }
  try {
    browserServer = await engine.launchServer({ host: '127.0.0.1', port: 0, headless: true, timeout: limits.navigationMs,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    browserServer.once('close', () => { serverClosed = true; }); const child = browserServer.process();
    childClose = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
    const endpoint = new URL(browserServer.wsEndpoint()); assert.equal(endpoint.hostname, '127.0.0.1');
    browser = await engine.connect(endpoint.href, { timeout: limits.navigationMs }); browserVersion = browser.version(); current();
    const owner = await ownedPage();
    phase = 'genuine-existing-public-effect-prefix';
    const response = await owner.goto(new URL('/sharing', application).href, { waitUntil: 'networkidle' }); assert.ok(response?.ok());
    await owner.getByRole('heading', { name: 'Choose who can use your play area', exact: true }).waitFor();
    await owner.getByRole('button', { name: 'Start sharing setup', exact: true }).click();
    const controls = owner.getByTestId('sharing-controls-first'), surface = owner.getByTestId('sharing-surface-left');
    await controls.getByRole('combobox', { name: 'Area for First controls', exact: true }).selectOption('left');
    await controls.getByRole('checkbox').check(); await controls.getByRole('button', { name: 'Request sharing for First controls', exact: true }).click();
    await owner.getByTestId('sharing-review-left').getByRole('button', { name: 'Approve sharing', exact: true }).click();
    await owner.waitForFunction(() => document.querySelector('[data-testid="sharing-surface-left"]')?.hasAttribute('data-x'));
    const initial = Number(await surface.getAttribute('data-x'));
    await controls.getByRole('button', { name: 'Move First controls right', exact: true }).click();
    await owner.waitForFunction(x => Number(document.querySelector('[data-testid="sharing-surface-left"]')?.getAttribute('data-x')) > x, initial);
    await controls.getByRole('button', { name: 'Press First controls', exact: true }).click();
    await owner.waitForFunction(() => document.querySelector('[data-testid="sharing-surface-left"]')?.getAttribute('data-held') === 'true');
    await owner.getByRole('button', { name: 'Stop all sharing', exact: true }).click();
    await owner.waitForFunction(() => document.querySelector('[data-testid="sharing-surface-left"]')?.getAttribute('data-held') === 'false'
      && !document.querySelector('[data-testid="sharing-surface-left"]')?.hasAttribute('data-x'));
    await owner.getByRole('button', { name: 'Stop this setup', exact: true }).click();
    await owner.getByRole('button', { name: 'Start sharing setup', exact: true }).waitFor();
    assert.equal(await owner.evaluate(() => globalThis.__watchNative.snapshot().issued), 0);
    prefixComplete = true; check('existing-public-producer-route-effect-stop-prefix');
    phase = 'new-watch-feature';
    if (old) {
      const newResponse = await owner.goto(new URL('/sharing/watch', application).href, { waitUntil: 'networkidle' });
      missing = newResponse?.status() === 404 && await owner.getByRole('heading', { name: 'Share a read-only page view', exact: true }).count() === 0;
      assert.equal(newResponse?.status(), 200, 'The independent read-only observer route must exist after the public positive prefix');
      await owner.getByRole('heading', { name: 'Share a read-only page view', exact: true }).waitFor();
    } else {
      await arrival(owner); const first = await ownedPage(), second = await ownedPage();
      await arrival(first); await arrival(second); check('three-context-inert-arrival-no-capture-or-peers');
      for (const theme of ['dark', 'light']) {
        await owner.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await nativeActivate(owner, 'Start watch setup');
        const style = await main(owner).getByRole('button', { name: 'Stop watch setup', exact: true }).evaluate(element => {
          const computed = getComputedStyle(element), page = getComputedStyle(document.querySelector('main[data-watch-sharing-page]'));
          const root = getComputedStyle(document.documentElement);
          return { text: page.color, background: getComputedStyle(document.body).backgroundColor,
            paper: root.getPropertyValue('--paper').trim(), ink: root.getPropertyValue('--ink').trim(),
            minHeight: parseFloat(computed.minHeight), width: document.documentElement.scrollWidth, viewport: innerWidth };
        });
        assert.ok(style.paper && style.ink); assert.notEqual(style.text, style.background);
        assert.ok(style.minHeight >= 44); assert.ok(style.width <= style.viewport + 1);
        await stop(owner); check(`actual-${theme}-palette-native-keyboard-reduced-motion-arrival`);
      }
      await start(owner, 'owner'); await start(first, 'observer'); await start(second, 'observer');
      phase = 'held-genuine-identity-stop-negative';
      await second.evaluate(() => globalThis.__watchNative.holdNextIdentity()); await nativeActivate(second, 'Create owner invitation');
      await second.waitForFunction(() => globalThis.__watchNative.snapshot().pendingKeyReturns === 1);
      await main(second).getByRole('button', { name: 'Stop watch setup', exact: true }).click();
      assert.equal(await main(second).getByRole('button', { name: 'Start watch setup', exact: true }).isDisabled(), true);
      nativeKeyHold = await second.evaluate(() => globalThis.__watchNative.snapshot());
      await second.evaluate(() => globalThis.__watchNative.releaseIdentity()); await stop(second); await start(second, 'observer');
      check('actual-native-key-return-held-through-stop-no-peer-dispatch');
      phase = 'bilateral-native-enrollment';
      for (const [index, observer] of [first, second].entries()) {
        const id = `observer-${index + 1}`, peer = main(owner).getByTestId(`watch-peer-${id}`), observerPeer = main(observer).getByTestId('watch-peer-owner');
        await nativeActivate(observer, 'Create owner invitation');
        const invitation = main(observer).getByRole('textbox', { name: 'owner outgoing code', exact: true }); await invitation.waitFor();
        await main(owner).getByRole('textbox', { name: 'Observer invitation', exact: true }).fill(await invitation.inputValue());
        await nativeActivate(owner, 'Review observer invitation'); await nativeActivate(owner, 'Create connection offer', peer);
        const offer = peer.getByRole('textbox', { name: `${id} outgoing code`, exact: true }); await offer.waitFor();
        await observerPeer.getByRole('textbox', { name: 'owner incoming code', exact: true }).fill(await offer.inputValue());
        await nativeActivate(observer, 'Accept owner offer', observerPeer);
        await observer.waitForFunction(() => {
          const code = document.querySelector('[data-testid="watch-peer-owner"] textarea[readonly]')?.value;
          if (!code?.startsWith('101-sharing-1.') || code.length > 65536) return false;
          try { const body = code.slice('101-sharing-1.'.length); return JSON.parse(atob(body.replaceAll('-', '+').replaceAll('_', '/')
            + '='.repeat((4 - body.length % 4) % 4))).kind === 'answer'; } catch { return false; }
        });
        await peer.getByRole('textbox', { name: `${id} incoming code`, exact: true }).fill(await invitation.inputValue());
        await nativeActivate(owner, 'Accept observer answer', peer);
        const a = peer.getByTestId(`watch-comparison-${id}`), b = observerPeer.getByTestId('watch-comparison-owner');
        await a.waitFor(); await b.waitFor(); assert.equal(await a.innerText(), await b.innerText());
        await nativeActivate(owner, 'The codes match', peer); await nativeActivate(observer, 'The codes match', observerPeer);
        await peer.getByText('The connected page is verified. Viewing still needs approval.', { exact: true }).waitFor();
        await observerPeer.getByText('The connected page is verified. Viewing still needs approval.', { exact: true }).waitFor();
        assert.equal(await main(observer).getByRole('button', { name: 'Press', exact: true }).count(), 0);
        assert.equal(await main(observer).getByTestId('watch-display').getAttribute('data-x'), null);
        check(`native-${id}-bilateral-enrollment-without-display-authority`);
      }
      phase = 'independent-display-consent';
      await main(owner).getByRole('checkbox', { name: 'Allow sharing my page controls', exact: true }).check();
      await nativeActivate(owner, 'Start my page controls');
      await ask(first); await main(owner).getByTestId('watch-review-observer-1').waitFor();
      assert.equal(await main(first).getByTestId('watch-display').getAttribute('data-x'), null);
      await approve(owner, 'observer-1'); await nativeActivate(owner, 'Move right'); await nativeActivate(owner, 'Press');
      await effect(first, true); assert.equal(await main(second).getByTestId('watch-display').getAttribute('data-x'), null);
      check('requested-consented-display-still-needs-exact-owner-approval');
      await ask(second); await approve(owner, 'observer-2'); await nativeActivate(owner, 'Move left'); await nativeActivate(owner, 'Press');
      await effect(first, true); await effect(second, true);
      const projection = async page => main(page).getByTestId('watch-display').evaluate(element => Object.fromEntries(['data-x', 'data-y', 'data-held',
        'data-generation', 'data-emitted-at'].map(name => [name, element.getAttribute(name)])));
      await first.waitForFunction(() => document.querySelector('[data-testid="watch-display"]')?.getAttribute('data-x') === '.5'
        || Number(document.querySelector('[data-testid="watch-display"]')?.getAttribute('data-x')) === .5);
      const coherenceDeadline = Date.now() + limits.stepMs; let coherent = false;
      do {
        const [a, b] = await Promise.all([projection(first), projection(second)]);
        coherent = JSON.stringify(a) === JSON.stringify(b) && a['data-emitted-at'] !== null;
        if (coherent) break;
        if (Date.now() >= coherenceDeadline) break;
        await owner.waitForTimeout(20);
      } while (Date.now() < coherenceDeadline);
      assert.equal(coherent, true, 'Two actual recipients eventually show one identical stamped owner record');
      for (const observer of [first, second]) assert.ok(await main(observer).getByTestId('watch-display').getAttribute('data-endpoint'),
        'Each receipt retains its own verified peer endpoint, not an assumed shared account identity');
      check('actual-owner-record-two-independent-read-only-display-sinks');
      phase = 'observer-cannot-control-owner';
      const ownerValue = await main(owner).getByTestId('watch-source').getAttribute('data-x');
      assert.equal(await main(first).getByRole('button', { name: /^(Move|Press|Release)/ }).count(), 0);
      await main(first).getByTestId('watch-display').focus(); await first.keyboard.press('ArrowRight'); await first.keyboard.press('Space');
      assert.equal(await main(owner).getByTestId('watch-source').getAttribute('data-x'), ownerValue);
      check('observer-no-control-writer-or-control-effect');
      phase = 'recipient-isolation-decline-cancel';
      await nativeActivate(owner, 'Stop Observer 2 viewing'); await second.waitForFunction(() => !document.querySelector('[data-testid="watch-display"]')?.hasAttribute('data-x'));
      assert.equal(await main(first).getByTestId('watch-display').getAttribute('data-held'), 'true');
      await ask(second); await nativeActivate(owner, 'Decline view request', main(owner).getByTestId('watch-review-observer-2'));
      await main(owner).getByTestId('watch-review-observer-2').waitFor({ state: 'detached' });
      assert.equal(await main(first).getByTestId('watch-display').getAttribute('data-held'), 'true');
      await ask(second); await main(owner).getByTestId('watch-review-observer-2').waitFor(); await nativeActivate(second, 'Cancel my view request');
      await main(owner).getByTestId('watch-review-observer-2').waitFor({ state: 'detached' });
      assert.equal(await main(first).getByTestId('watch-display').getAttribute('data-held'), 'true');
      check('scoped-revoke-decline-cancel-preserve-owner-and-other-observer');
      phase = 'native-key-held-focus-release';
      const pad = main(owner).getByRole('button', { name: 'Your shared movement pad', exact: true }); await pad.focus();
      await owner.keyboard.down('Space'); await effect(first, true); await owner.keyboard.press(engineName === 'webkit' ? 'Alt+Tab' : 'Tab');
      await effect(first, false); await owner.keyboard.up('Space'); check('native-held-key-focus-loss-clears-observer-contact');
      phase = 'quiet-original-absolute-consent-expiry';
      await nativeActivate(owner, 'Stop my page controls');
      await first.waitForFunction(() => !document.querySelector('[data-testid="watch-display"]')?.hasAttribute('data-x'));
      await main(owner).getByRole('checkbox', { name: 'Allow sharing my page controls', exact: true }).check(); await nativeActivate(owner, 'Start my page controls');
      await ask(first); await approve(owner, 'observer-1'); await nativeActivate(owner, 'Press'); await effect(first, true);
      await nativeActivate(owner, 'Pause view updates');
      const quietStart = await main(owner).getByTestId('watch-source').evaluate(element => ({ emittedAt: element.getAttribute('data-emitted-at'),
        emissions: Number(element.getAttribute('data-emissions')), expiresAt: Number(element.getAttribute('data-expires-at')), now: performance.now() }));
      assert.ok(Number.isFinite(quietStart.expiresAt) && quietStart.expiresAt > quietStart.now && quietStart.expiresAt <= quietStart.now + limits.fixedExpiryMs);
      // The explicit local pause narrows source effects and cannot renew consent.
      // No movement, key, pointer, publication, renewed approval or task access in
      // the quiet interval. The DOM observation does not drive SDK clocks.
      await owner.waitForFunction(end => performance.now() >= end && document.querySelector('[data-testid="watch-source"]')?.getAttribute('data-active') === 'false',
        quietStart.expiresAt, { timeout: limits.expiryWaitMs });
      await first.waitForFunction(() => !document.querySelector('[data-testid="watch-display"]')?.hasAttribute('data-x'));
      const quietEnd = await main(owner).getByTestId('watch-source').evaluate(element => ({ emittedAt: element.getAttribute('data-emitted-at'),
        emissions: Number(element.getAttribute('data-emissions')), active: element.getAttribute('data-active'), now: performance.now() }));
      assert.equal(quietEnd.emissions, quietStart.emissions, 'No software data emissions during the actual quiet interval');
      quiet = { start: quietStart, end: quietEnd, zeroProducerEventsDuringWait: true,
        causality: 'Original source consent is inactive at its deadline. A receiver freshness/deadman may retire sooner; no sole-timer causality claim.' };
      assert.equal(await main(first).getByTestId('watch-display').getAttribute('data-held'), 'false');
      check('quiet-no-events-original-fixed-consent-ends-without-renewal');
      phase = 'fresh-review-and-unmount';
      await main(owner).getByRole('checkbox', { name: 'Allow sharing my page controls', exact: true }).check(); await nativeActivate(owner, 'Start my page controls');
      await ask(second); await approve(owner, 'observer-2'); await nativeActivate(owner, 'Press'); await effect(second, true);
      await main(second).getByRole('link', { name: 'Back to Sharing', exact: true }).click();
      await second.getByRole('heading', { name: 'Choose who can use your play area', exact: true }).waitFor();
      await second.waitForFunction(() => globalThis.__watchNative.snapshot().open === 0 && globalThis.__watchNative.snapshot().pendingKeyReturns === 0);
      await main(owner).getByTestId('watch-peer-observer-2').getByText('The connection stopped. Start a new setup.', { exact: true }).waitFor();
      check('fresh-separate-approvals-native-recipient-unmount-peer-release');
      await stop(first); await stop(owner); cleanup.appRawObservedZero = true;
      snapshotsBeforeClose = await Promise.all(pages.map(page => page.evaluate(() => globalThis.__watchNative.snapshot())));
      finalNative = snapshotsBeforeClose.reduce((sum, item) => ({ issued: sum.issued + item.issued, closed: sum.closed + item.closed,
        open: sum.open + item.open, deviceCalls: sum.deviceCalls + item.deviceCalls, pendingKeyReturns: sum.pendingKeyReturns + item.pendingKeyReturns }),
      { issued: 0, closed: 0, open: 0, deviceCalls: 0, pendingKeyReturns: 0 });
      assert.equal(finalNative.issued, 4); assert.equal(finalNative.closed, 4); assert.equal(finalNative.open, 0);
      assert.equal(finalNative.deviceCalls, 0); assert.equal(finalNative.pendingKeyReturns, 0); cleanup.ownedPeerOpen = 0;
      check('actual-owned-four-peer-returned-work-and-private-resource-release');
    }
    await Promise.allSettled([...responseJobs]); assert.deepEqual(errors, []); assert.deepEqual(foreign, []); current();
  } catch (error) {
    failure = error;
    for (const [index, page] of pages.entries()) if (!page.isClosed()) try { await page.screenshot({ path: join(artifactRoot, `failure-${index}.png`), fullPage: true }); }
    catch (screenshotError) { cleanupErrors.push(String(screenshotError.message).slice(0, 256)); }
  } finally {
    clearTimeout(watchdog); cleanup.timers = 0; process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); cleanup.signalListeners = 0;
    for (const page of pages) if (!page.isClosed()) try {
      await page.evaluate(() => globalThis.__watchNative.releaseIdentity());
      if (!old && await main(page).count()) await stop(page);
    } catch (error) { cleanupErrors.push(String(error.message).slice(0, 256)); }
    await Promise.allSettled([...responseJobs]); cleanup.responseReadsSettled = responseJobs.size === 0;
    for (const page of pages) if (!page.isClosed()) try { await page.close(); } catch (error) { cleanupErrors.push(String(error.message).slice(0, 256)); }
    cleanup.pagesClosed = pages.every(page => page.isClosed());
    for (const context of contexts) try { await context.close(); } catch (error) { cleanupErrors.push(String(error.message).slice(0, 256)); }
    cleanup.contextCloseAwaited = contexts.every(context => context.pages().length === 0);
    if (browser?.isConnected()) try { await browser.close(); cleanup.browserCloseAwaited = true; } catch (error) { cleanupErrors.push(String(error.message).slice(0, 256)); }
    try { await closeServer(); } catch (error) { cleanupErrors.push(String(error.message).slice(0, 256)); }
    if (childClose) await childClose;
    cleanup.browserClosed = !browser?.isConnected(); cleanup.browserServerClosed = serverClosed; cleanup.nativeChildCloseObserved = childClosed;
    try { verifySources(); verifyBuild(); assert.equal(hash(readFileSync(harnessPath)), harnessSha256); }
    catch (error) { cleanupErrors.push(String(error.message).slice(0, 256)); }
  }
  if (errors.length || foreign.length) failure ??= Error('Actual owned journey reported an error or foreign request');
  const classification = old && prefixComplete && missing && phase === 'new-watch-feature' && !timeout && !interrupted && !cleanupErrors.length
    && errors.length === 0 && foreign.length === 0
    ? 'intended-new-watch-route-absence' : failure || cleanupErrors.length ? 'unqualified-prerequisite-or-journey-failure' : 'selected-software-native-journey-pass';
  const responseInventoryPath = join(artifactRoot, 'emitted-module-inventory.json');
  const responseInventoryBytes = JSON.stringify([...responsePins].sort(([a], [b]) => a.localeCompare(b))) + '\n';
  writeFileSync(responseInventoryPath, responseInventoryBytes);
  results.push({ engine: engineName, browserVersion, status: failure || cleanupErrors.length ? 'fail' : 'pass', classification, phase,
    prefixComplete, checks, keyboard, quiet, nativeKeyHold, snapshotsBeforeClose, finalNative, cleanup, cleanupErrors,
    errors, foreignRequests: foreign.length, requests, timeout, interrupted, responseCount: responsePins.size,
    responseInventoryPath, responseInventorySha256: hash(responseInventoryBytes), clientBytes,
    failure: failure ? { name: failure.name, message: String(failure.message).slice(0, 1024) } : undefined });
  if (failure || cleanupErrors.length) { failure ??= Error('Actual owned cleanup failed'); break; }
}
const receipt = { schemaVersion: 1, profile: 'connected-read-only-watch/1', status: failure ? 'fail' : 'pass', selector: old ? '--old-red' : 'native',
  selectedEngine: selected, toolchain, limits, harness: { path: harnessPath, sha256: harnessSha256 },
  servedProof: { path: proofPath, sha256: hash(proofBytes), sourceTree: proof.sourceTree, mode: proof.mode,
    sourceCount: pins.length, sourceInventorySha256: hash(JSON.stringify(proof.sourcePins)), buildCount: buildInputs.length },
  results, artifacts: output, scope: ['Owned page-control software producer only; actual public SDK/runtime bytes and private native browser RTC endpoints.',
    'Observers can display only. Endpoint comparison does not identify an account/person or confer source/display approval.',
    'No device, getUserMedia, screen chooser, OS pointer, physical hardware, account administration, remote network, persistence or whole-U04 claim.',
    'Returned host key work and native JS peer closure are observed; browser-internal crypto/DTLS quiescence is not independently asserted.',
    'The parent owns loopback app service closure. This harness awaits its owned pages, contexts, native browser child/server and response reads.'],
  published: false };
const bytes = JSON.stringify(receipt) + '\n'; assert.ok(Buffer.byteLength(bytes) <= limits.receiptBytes);
const receiptPath = join(output, 'receipt.json'); writeFileSync(receiptPath, bytes);
console.log(JSON.stringify({ status: receipt.status, receipt: receiptPath, sha256: hash(bytes), results: results.map(result => ({ engine: result.engine,
  status: result.status, phase: result.phase, classification: result.classification, checks: result.checks, cleanup: result.cleanup })) }));
if (failure) throw failure;
