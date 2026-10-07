import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

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
assert.ok(application.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(application.hostname)
  && application.pathname === '/' && !application.username && !application.password && !application.search && !application.hash,
  'Use one owned loopback application origin');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const proofBytes = readFileSync(proofPath), proof = JSON.parse(proofBytes), root = realpathSync(proof.sourceRoot);
assert.equal(proof.origin, application.origin); assert.match(proof.sourceTree, /^[a-f0-9]{40}$/);
const owned = ['app/settings/processors/page.tsx', 'app/settings/processors/processor-management.ts',
  'app/settings/processors/processor-management.test.ts', 'app/settings/processors/trusted-processors.ts',
  'tools/qa-processor-management.mjs'];
const dependencies = ['packages/connect/src/index.ts', 'packages/device-model/src/index.ts',
  'packages/device-model/src/extension-release.ts', 'packages/device-model/src/processor-graph.ts', 'packages/device-model/src/processor-manifest.ts',
  'packages/device-runtime/src/index.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/runtime.ts',
  'packages/device-runtime/src/scheduler.ts', 'packages/device-runtime/src/inspector.ts', 'packages/device-runtime/src/lease.ts',
  'packages/device-runtime/src/processor-installation.ts', 'packages/device-runtime/src/processor-registry.ts',
  'packages/device-runtime/src/processor-failure.ts', 'packages/device-runtime/src/conformance.ts',
  'examples/external-processor/manifest.json', 'examples/external-processor/processor.mjs',
  'examples/extension-installation/temperature-band-v2.mjs', 'app/connections/resources/resource-task.module.css',
  'app/connections/connections.module.css', 'app/settings/settings.module.css', 'app/layout.tsx',
  'app/globals.css', 'app/components/AppShell.tsx', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'];
const sourcePins = {};
for (const path of [...(missingRouteRed ? [] : owned), ...dependencies]) {
  const bytes = readFileSync(resolve(root, path)); assert.ok(bytes.length <= 2 * 1024 * 1024);
  sourcePins[path] = hash(bytes); assert.equal(proof.sourcePins?.[path], sourcePins[path], `Actual served source: ${path}`);
  assert.equal(hash(execFileSync('git', ['cat-file', 'blob', `${proof.sourceTree}:${path}`],
    { cwd: root, maxBuffer: 2 * 1024 * 1024 })), sourcePins[path], `Immutable source: ${path}`);
}
assert.ok(Array.isArray(proof.buildInputs) && proof.buildInputs.length >= 2 && proof.buildInputs.length <= 2048);
const buildPaths = new Set(); let totalBuildBytes = 0;
for (const item of proof.buildInputs) {
  assert.ok(item && typeof item.path === 'string' && ['server', 'client'].includes(item.kind));
  assert.match(item.sha256 ?? '', /^[a-f0-9]{64}$/);
  const path = realpathSync(item.path), rel = relative(root, path);
  assert.ok(!rel.startsWith('..') && !rel.startsWith('/') && rel.startsWith(`dist/${item.kind}/`));
  assert.ok(!buildPaths.has(path)); buildPaths.add(path);
  const bytes = readFileSync(path); totalBuildBytes += bytes.length; assert.ok(totalBuildBytes <= 64 * 1024 * 1024);
  assert.equal(hash(bytes), item.sha256);
}
assert.ok(proof.buildInputs.some(item => item.kind === 'server') && proof.buildInputs.some(item => item.kind === 'client'));
let provision;
if (!missingRouteRed) {
  const trustedText = readFileSync(join(root, owned[3]), 'utf8');
  provision = JSON.parse(trustedText.match(/const provision = ([\s\S]*?);\n/)[1]);
  const sources = JSON.parse(trustedText.match(/const sources = (\[[\s\S]*?\]) as const;/)[1]);
  assert.equal(provision.releases.length, 2); assert.deepEqual(provision.publisherKey.key_ops, ['verify']);
  for (const [index, path] of ['examples/external-processor/processor.mjs', 'examples/extension-installation/temperature-band-v2.mjs'].entries()) {
    const bytes = readFileSync(join(root, path)), release = provision.releases[index];
    assert.equal(sources[index], bytes.toString('utf8')); assert.equal(release.source.byteLength, bytes.length);
    assert.equal(release.source.sha256, hash(bytes)); assert.equal(release.manifest.codeSha256, hash(bytes));
    assert.deepEqual(release.privileges, ['compute-local']); assert.deepEqual(release.dependencies, []);
  }
}
const require = createRequire(join(root, 'package.json')), { chromium, webkit } = require('playwright');
const work = mkdtempSync(join(tmpdir(), '101-processor-management-'));
const checks = [], errors = [], foreign = [], retirements = [], pages = [], palettes = [];
const cleanup = { pagesClosed: false, contextCloseAwaited: false, browserClosed: false };
let browser, context, version, phase = 'arrival', failure, arrival, quiet, nativeAfterJourney;
async function page() {
  const value = await context.newPage(); pages.push(value); value.on('pageerror', error => errors.push(error.message));
  await value.exposeFunction('__processorRetired', result => retirements.push(result));
  await value.addInitScript(() => window.addEventListener('101-processor-management-retired', event => { void window.__processorRetired(event.detail); }));
  const reply = await value.goto(new URL('/settings/processors', application).href, { waitUntil: 'networkidle' });
  return { value, status: reply?.status() };
}
async function nativeFocus(value, target) {
  await value.bringToFront(); await target.click({ trial: true });
  // Enter the owned document at its existing navigation link. WebKit's
  // headless initial BODY focus can tab out of the document; the control
  // under test must still be reached by a real keyboard navigation step.
  await value.locator('main').getByRole('link', { name: 'Back to Settings', exact: true }).focus();
  for (let step = 0; step <= 32; step++) {
    if (step > 0 && await target.evaluate(element => !element.disabled && document.hasFocus() && document.activeElement === element &&
      element.matches(':focus') && element.matches(':focus-visible'))) return step;
    if (step < 32) await value.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
  }
  throw Error('Native keyboard did not reach the enabled control in 32 steps');
}
async function activate(value, name) {
  const button = value.getByRole('button', { name, exact: true });
  await button.click({ trial: true }); await button.focus();
  assert.equal(await button.evaluate(element => document.activeElement === element), true);
  await value.keyboard.press('Space');
}
async function settled(value) {
  await value.waitForFunction(() => {
    const element = document.querySelector('[data-processor-phase]');
    return element && element.dataset.processorRaw === '0' && !['opening', 'working'].includes(element.dataset.processorPhase);
  });
}
async function manage(value) {
  await activate(value, 'Manage processors'); await activate(value, 'Allow management for 30 seconds'); await settled(value);
  assert.equal(await value.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'ready');
}
async function install(value, selected) {
  await value.getByRole('combobox', { name: 'Reviewed version', exact: true }).selectOption(selected);
  await activate(value, 'Review install');
  await value.evaluate(() => { globalThis.__processorGates.verify.armed = true; });
  await activate(value, 'Confirm installation');
  await value.waitForFunction(() => globalThis.__processorGates.verify.held);
  assert.equal(await value.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'working');
  assert.equal(await value.getByRole('button', { name: 'Review install', exact: true }).isDisabled(), true);
  await value.evaluate(() => { globalThis.__processorGates.verify.release(); }); await settled(value);
  assert.equal(await value.getByRole('button', { name: 'Review install', exact: true }).evaluate(element => document.activeElement === element), true);
}
async function live(value, rollback = false) {
  await activate(value, rollback ? 'Review rollback' : 'Review live use');
  const start = value.getByRole('button', { name: rollback ? 'Confirm rollback and use' : 'Start approved example', exact: true });
  assert.equal(await start.isDisabled(), true);
  await activate(value, 'Allow this page’s number input'); assert.equal(await start.isDisabled(), true);
  await activate(value, 'Allow this page’s indicator output'); assert.equal(await start.isDisabled(), false);
  await activate(value, rollback ? 'Confirm rollback and use' : 'Start approved example'); await settled(value);
}
async function send(value, input) {
  const range = value.getByRole('slider', { name: 'Number in degrees Celsius', exact: true });
  await range.focus(); await value.keyboard.press('Home');
  for (let step = -40; step < input; step++) await value.keyboard.press('ArrowRight');
  assert.equal(await range.inputValue(), String(input));
  await activate(value, 'Send number');
}
async function released(value) {
  await value.waitForFunction(() => { const element = document.querySelector('[data-processor-phase]');
    return element && element.dataset.processorRaw === '0' && element.dataset.processorRoutes === '0' && element.dataset.processorRegistrations === '0'; });
  assert.equal(await value.getByRole('status', { name: 'Page indicator', exact: true }).textContent(), 'Released');
}
const contrast = (a, b) => {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
    });
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};
try {
  browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true }); version = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(10000);
  await context.route('**/*', route => new URL(route.request().url()).origin === application.origin
    ? route.continue() : (foreign.push(route.request().url()), route.abort()));
  await context.addInitScript(() => {
    const counts = { imports: 0, verifies: 0, pendingCrypto: 0, indexedDbOpens: 0, storageWrites: 0 };
    globalThis.__processorNative = counts; globalThis.__processorGates = {};
    for (const name of ['importKey', 'verify']) {
      const gate = { armed: false, issued: false, rawSettled: false, held: false, release: undefined };
      globalThis.__processorGates[name] = gate;
      const native = SubtleCrypto.prototype[name];
      Object.defineProperty(SubtleCrypto.prototype, name, { configurable: true, writable: true, value(...args) {
        counts[name === 'importKey' ? 'imports' : 'verifies']++; counts.pendingCrypto++;
        let returned; const hold = gate.armed; gate.armed = false;
        try { returned = Reflect.apply(native, this, args); } catch (error) { counts.pendingCrypto--; throw error; }
        if (hold) gate.issued = true;
        return returned.then(result => {
          counts.pendingCrypto--; if (!hold) return result;
          gate.rawSettled = true; gate.held = true;
          // Hold only this genuinely fulfilled native value. Page close must
          // retain its issued public loader/installer work until actual return.
          return new Promise(resolveHeld => { gate.release = () => { gate.held = false; resolveHeld(result); }; });
        }, error => { counts.pendingCrypto--; throw error; });
      } });
    }
    const open = IDBFactory.prototype.open, write = Storage.prototype.setItem;
    Object.defineProperty(IDBFactory.prototype, 'open', { configurable: true, writable: true, value(...args) {
      counts.indexedDbOpens++; return Reflect.apply(open, this, args);
    } });
    Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, writable: true, value(...args) {
      counts.storageWrites++; return Reflect.apply(write, this, args);
    } });
  });
  const first = await page(), a = first.value, main = a.locator('[data-processor-phase]');
  arrival = { status: first.status, heading: await a.getByRole('heading', { name: 'Manage reviewed processors', exact: true }).count(),
    manage: await a.getByRole('button', { name: 'Manage processors', exact: true }).count(), native: await a.evaluate(() => globalThis.__processorNative) };
  if (missingRouteRed) {
    process.stderr.write(`${JSON.stringify({ phase: 'actual-old-route', sourceTree: proof.sourceTree, arrival })}\n`);
    assert.equal(arrival.status, 200, 'The missing nested route is feature absence, not an installer bug');
    throw Error('Expected missing route was not observed');
  }
  assert.equal(arrival.status, 200); assert.equal(arrival.heading, 1); assert.equal(arrival.manage, 1);
  assert.deepEqual(arrival.native, { imports: 0, verifies: 0, pendingCrypto: 0, indexedDbOpens: 0, storageWrites: 0 });
  assert.equal(await main.getAttribute('data-processor-phase'), 'idle');
  for (const key of ['raw', 'routes', 'registrations', 'timers', 'effects']) assert.equal(await main.getAttribute(`data-processor-${key}`), '0');
  checks.push('inert-arrival-no-crypto-storage-routes-or-effects');
  phase = 'native-focus-palettes';
  for (const theme of ['dark', 'light']) {
    await a.emulateMedia({ colorScheme: theme });
    const button = a.getByRole('button', { name: 'Manage processors', exact: true }), steps = await nativeFocus(a, button);
    const palette = await button.evaluate(element => {
      // A positive outline offset borders the containing surface. Transparent
      // control backgrounds must not be scored as opaque black in light mode.
      let surface = element.parentElement;
      while (surface && /^(transparent|rgba\([^)]*,\s*0\))$/.test(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement;
      return { color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor,
        adjacentBackground: getComputedStyle(surface ?? document.body).backgroundColor,
        outlineColor: getComputedStyle(element).outlineColor, outlineStyle: getComputedStyle(element).outlineStyle,
        outlineWidth: parseFloat(getComputedStyle(element).outlineWidth), outlineOffset: parseFloat(getComputedStyle(element).outlineOffset),
        body: getComputedStyle(document.body).backgroundColor,
        statusColor: getComputedStyle(document.querySelector('[aria-label="Processor management status"]')).color,
        focus: element.matches(':focus-visible'), documentFocus: document.hasFocus() };
    });
    assert.equal(palette.focus, true); assert.equal(palette.documentFocus, true); assert.equal(palette.outlineStyle, 'solid');
    assert.ok(palette.outlineWidth >= 2); assert.ok(contrast(palette.statusColor, palette.body) >= 4.5);
    palettes.push({ theme, steps, ...palette });
    assert.ok(palette.outlineOffset > 0); assert.ok(contrast(palette.outlineColor, palette.adjacentBackground) >= 3);
  }
  await a.emulateMedia({ colorScheme: 'dark' }); checks.push('native-keyboard-focus-and-two-theme-readable-chrome');
  phase = 'declined-management'; await activate(a, 'Manage processors'); await activate(a, 'Decline management');
  assert.equal(await a.evaluate(() => globalThis.__processorNative.imports), 0); checks.push('declined-management-keeps-native-imports-zero');
  phase = 'opening-cancellation';
  const openingPage = await page(), c = openingPage.value; assert.equal(openingPage.status, 200);
  await c.evaluate(() => { globalThis.__processorGates.importKey.armed = true; });
  await activate(c, 'Manage processors'); await activate(c, 'Allow management for 30 seconds');
  await c.waitForFunction(() => globalThis.__processorGates.importKey.held);
  assert.equal(await c.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'opening');
  assert.equal(await c.getByRole('button', { name: 'Stop management', exact: true }).isEnabled(), true);
  await activate(c, 'Stop management');
  assert.equal(await c.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'stopped');
  assert.equal(await c.locator('[data-processor-phase]').getAttribute('data-processor-timers'), '0');
  assert.equal(await c.getByRole('button', { name: 'Manage processors', exact: true }).isDisabled(), true);
  const beforeOpeningClose = retirements.length;
  await c.locator('main').getByRole('link', { name: 'Back to Settings', exact: true }).click(); await c.waitForURL(url => url.pathname === '/settings');
  assert.equal(retirements.length, beforeOpeningClose, 'Held issued return must keep actual page close pending');
  await c.evaluate(() => { globalThis.__processorGates.importKey.release(); });
  for (let turn = 0; retirements.length === beforeOpeningClose && turn < 100; turn++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
  assert.equal(retirements.length, beforeOpeningClose + 1); assert.equal(retirements.at(-1).rawPending, 0);
  assert.equal(retirements.at(-1).closeAwaited, true); assert.equal(retirements.at(-1).cleanupFailures, 0);
  checks.push('opening-stop-and-actual-close-retain-held-genuine-public-provision-return');
  await a.bringToFront();
  phase = 'install'; await manage(a);
  await a.getByRole('combobox', { name: 'Reviewed version', exact: true }).selectOption('1.0.0');
  await activate(a, 'Review install'); await activate(a, 'Decline change');
  assert.equal(await main.getAttribute('data-processor-effects'), '0');
  await install(a, '1.0.0'); assert.equal(await main.getAttribute('data-processor-routes'), '0');
  const afterInstall = await a.evaluate(() => globalThis.__processorNative);
  assert.equal(afterInstall.imports, 1); assert.ok(afterInstall.verifies >= 3); assert.equal(afterInstall.pendingCrypto, 0);
  checks.push('signed-native-verification-and-explicit-install-without-activation');
  checks.push('keyboard-confirmation-restores-action-focus-after-held-genuine-native-verification-return');
  phase = 'actual-v1'; await live(a); await send(a, 30);
  const indicator = a.getByRole('status', { name: 'Page indicator', exact: true });
  await indicator.filter({ hasText: /^On$/ }).waitFor(); await send(a, 28); await indicator.filter({ hasText: /^Off$/ }).waitFor();
  checks.push('independent-input-output-approvals-and-real-v1-runtime-effects');
  phase = 'update-preserves-incumbent'; await send(a, 30);
  await a.getByRole('combobox', { name: 'Reviewed version', exact: true }).selectOption('2.0.0');
  await activate(a, 'Review install'); await activate(a, 'Decline change'); assert.equal(await indicator.textContent(), 'On');
  await install(a, '2.0.0'); assert.equal(await indicator.textContent(), 'On');
  assert.equal(await main.getAttribute('data-processor-routes'), '2'); checks.push('declined-and-installed-update-preserve-current-v1');
  // A new explicit management scope follows a real Stop, never an automatic renewal.
  await activate(a, 'Stop management'); await released(a); await manage(a);
  phase = 'actual-v2'; await live(a); assert.equal(await indicator.textContent(), 'Released');
  await send(a, 30); assert.equal(await indicator.textContent(), 'Released');
  await send(a, 31); await indicator.filter({ hasText: /^On$/ }).waitFor();
  checks.push('explicit-v2-switch-release-and-actual-distinct-threshold');
  phase = 'rollback'; await a.getByRole('combobox', { name: 'Reviewed version', exact: true }).selectOption('1.0.0');
  await live(a, true); await send(a, 30); await indicator.filter({ hasText: /^On$/ }).waitFor();
  checks.push('fresh-bilateral-approval-and-real-earlier-version-rollback');
  phase = 'version-revocation'; await activate(a, 'Revoke selected version'); await activate(a, 'Confirm version revocation'); await settled(a); await released(a);
  assert.equal(await a.getByRole('button', { name: 'Review live use', exact: true }).isDisabled(), true);
  checks.push('version-revocation-fences-live-use-and-releases-indicator');
  phase = 'publisher-revocation'; await activate(a, 'Revoke built-in publisher'); await activate(a, 'Confirm publisher revocation'); await settled(a);
  assert.equal(await a.getByRole('button', { name: 'Review install', exact: true }).isDisabled(), true);
  checks.push('publisher-revocation-blocks-both-known-versions');
  phase = 'removal'; await activate(a, 'Remove installed versions'); await activate(a, 'Confirm removal'); await settled(a);
  assert.equal(await main.getAttribute('data-processor-routes'), '0');
  assert.equal(await a.getByText('No installed version in this page.', { exact: true }).count(), 1);
  checks.push('reviewed-removal-clears-source-content-with-retained-revocation-floor');
  phase = 'stop'; await activate(a, 'Stop management'); await released(a);
  assert.equal(await main.getAttribute('data-processor-timers'), '0');
  await manage(a); assert.equal(await a.getByRole('button', { name: 'Review install', exact: true }).isDisabled(), true);
  checks.push('explicit-stop-and-fresh-management-do-not-restore-revoked-trust');
  phase = 'responsive'; await activate(a, 'Stop management'); await released(a);
  for (const width of [320, 390, 768, 1280]) {
    await a.setViewportSize({ width, height: 844 }); assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.equal(await a.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  const controls = await main.locator('button').evaluateAll(elements => elements.filter(element => getComputedStyle(element).display !== 'none')
    .map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
  assert.ok(controls.every(item => item.width >= 44 && item.height >= 44)); checks.push('responsive-44px-native-controls-and-reduced-motion');
  nativeAfterJourney = await a.evaluate(() => globalThis.__processorNative);
  assert.equal(nativeAfterJourney.pendingCrypto, 0); assert.equal(nativeAfterJourney.indexedDbOpens, 0); assert.equal(nativeAfterJourney.storageWrites, 0);
  phase = 'quiet-expiry-fresh-page';
  const second = await page(), b = second.value; assert.equal(second.status, 200); await manage(b); await install(b, '1.0.0'); await live(b); await send(b, 30);
  const effects = await b.locator('[data-processor-phase]').getAttribute('data-processor-effects'), started = await b.evaluate(() => performance.now()),
    until = Number(await b.locator('[data-processor-phase]').getAttribute('data-processor-until'));
  assert.ok(until > started && until - started <= 30000);
  await b.waitForFunction(() => document.querySelector('[data-processor-phase]')?.dataset.processorPhase === 'expired', undefined, { timeout: 32000 });
  await released(b); const ended = await b.evaluate(() => performance.now());
  assert.equal(await b.locator('[data-processor-phase]').getAttribute('data-processor-effects'), effects);
  assert.equal(await b.locator('[data-processor-phase]').getAttribute('data-processor-timers'), '0');
  assert.ok(ended >= until);
  quiet = { started, absoluteUntil: until, ended, waitMs: ended - started, unchangedEffects: effects, phase: 'expired' };
  checks.push('quiet-original-30s-expiry-without-source-polling-or-renewal');
  phase = 'unmount'; const before = retirements.length;
  await b.locator('main').getByRole('link', { name: 'Back to Settings', exact: true }).click(); await b.waitForURL(url => url.pathname === '/settings');
  for (let turn = 0; retirements.length === before && turn < 100; turn++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
  assert.ok(retirements.length > before); const retired = retirements.at(-1);
  assert.equal(retired.closeAwaited, true); assert.equal(retired.phase, 'closed'); assert.equal(retired.rawPending, 0);
  assert.equal(retired.registrations, 0); assert.equal(retired.routes, 0); assert.equal(retired.timerArmed, false); assert.equal(retired.documentBytes, 0);
  assert.equal(retired.cleanupFailures, 0); checks.push('actual-route-navigation-emits-awaited-closure-and-cleared-tab-document');
  phase = 'reload-isolation'; await a.reload({ waitUntil: 'networkidle' });
  assert.equal(await a.locator('[data-processor-phase]').getAttribute('data-processor-phase'), 'idle');
  assert.equal(await a.getByText('No installed version in this page.', { exact: true }).count(), 1);
  assert.deepEqual(await a.evaluate(() => globalThis.__processorNative), arrival.native);
  checks.push('fresh-page-forgets-installation-and-authority-without-persistence');
  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
} catch (error) {
  failure = error;
  process.stderr.write(`${JSON.stringify({ phase, engine, error: String(error), checks, errors, foreign, retirements })}\n`);
} finally {
  // Navigation triggers real page-owned async close; context exit remains a separately observed outer cleanup.
  for (const value of pages) if (!value.isClosed()) {
    // Release owned fixture holds before navigation so genuine returned page
    // work can settle; closing the browser alone is not a page-task barrier.
    await value.evaluate(() => { for (const gate of Object.values(globalThis.__processorGates ?? {})) gate.release?.(); }).catch(() => {});
    try { if (new URL(value.url()).pathname === '/settings/processors') await value.goto(new URL('/settings', application).href); }
    catch { /* No page-task settlement claim is manufactured if navigation cannot finish. */ }
    await value.close();
  }
  cleanup.pagesClosed = pages.every(value => value.isClosed());
  if (context) { await context.close(); cleanup.contextCloseAwaited = true; }
  if (browser) { await browser.close(); cleanup.browserClosed = true; }
}
const receipt = { schemaVersion: 1, status: failure ? 'fail' : 'pass', phase, engine, version, checks,
  sourcePins, actualServedProof: { path: resolve(proofPath), sha256: hash(proofBytes), sourceTree: proof.sourceTree },
  arrival, nativeAfterJourney, palettes, quiet, errors, foreign, retirements, cleanup, work,
  producer: 'Original statically imported reviewed v1/v2 factories; genuine native WebCrypto verification; actual page-entered numbers and public runtime application-indicator effects',
  instrumentation: 'Native SubtleCrypto/IDB/Storage calls retain their genuine methods and returned promises; counts describe observed issued calls only',
  persistence: 'RAM document and grants belong to this page lifetime; no installed SDK package claim',
  scope: 'Selected local software processor-management page. No physical sensor/actuator, arbitrary code loading, vendor identity, native WebCrypto-internal quiescence, or general U12/E10 completion.',
  serverOwnership: 'Root owns the supplied loopback server; this QA neither starts nor claims to stop it' };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
if (failure) process.exitCode = 1;
