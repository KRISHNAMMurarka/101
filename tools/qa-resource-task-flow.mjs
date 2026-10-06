import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const root = resolve(import.meta.dirname, '..'), target = new URL(process.argv[2]);
assert.equal(target.protocol, 'http:'); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
assert.equal(target.pathname, '/'); assert.equal(target.username, ''); assert.equal(target.password, '');
assert.equal(target.search, ''); assert.equal(target.hash, '');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
assert.ok(process.argv.filter(value => value === '--engine').length <= 1, 'Choose one explicit QA engine');
const selectedEngine = argument('--engine');
if (process.argv.includes('--engine')) assert.ok(['chromium', 'webkit'].includes(selectedEngine), 'The QA engine must be chromium or webkit');
const engines = selectedEngine === 'chromium' ? { chromium } : selectedEngine === 'webkit' ? { webkit } : { chromium, webkit };
const proofPath = argument('--served-proof'); assert.ok(proofPath, 'Bind the actual owned application server to a source/build proof');
const served = JSON.parse(readFileSync(proofPath, 'utf8'));
assert.equal(served.origin, target.origin); assert.match(served.sourceTree, /^[0-9a-f]{40}$/);
assert.ok(served.sourcePins && typeof served.sourcePins === 'object');
const paths = ['app/connections/resources/page.tsx', 'app/connections/resources/ResourceTaskView.tsx',
  'app/connections/resources/resource-task.ts', 'app/connections/resources/resource-task.test.ts',
  'app/connections/resources/resource-task.module.css', 'tools/qa-resource-task-flow.mjs'];
const dependencies = ['packages/connect/src/index.ts', 'packages/device-model/src/index.ts',
  'packages/device-model/src/descriptor.ts', 'packages/device-model/src/sample.ts', 'packages/device-model/src/recipe.ts',
  'packages/device-model/src/recipe-resolver.ts', 'packages/device-model/src/route-group.ts',
  'packages/device-runtime/src/index.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/runtime.ts',
  'packages/device-runtime/src/recipe-session.ts', 'packages/device-runtime/src/route-group-runtime.ts',
  'packages/device-runtime/src/scheduler.ts', 'packages/device-runtime/src/lease.ts',
  'app/globals.css', 'app/components/AppShell.tsx', 'vite.config.ts', 'package-lock.json'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = list => Object.fromEntries(list.map(path => [path, hash(readFileSync(resolve(root, path)))]));
const sourcePins = pin(paths), dependencyPins = pin(dependencies);
// A QA harness pin is not a claim that its drafted UI is served. Root supplies the actual server/build graph.
for (const path of [...paths.slice(0, -1), ...dependencies])
  assert.equal(served.sourcePins[path], sourcePins[path] ?? dependencyPins[path], `The actual server must use these exact bytes: ${path}`);
const work = mkdtempSync(join(tmpdir(), '101-resource-task-flow-')), results = [];
const proof = { path: resolve(proofPath), sha256: hash(readFileSync(proofPath)), sourceTree: served.sourceTree };
let failure;
async function keyboardActivate(page, locator) {
  // Resolve the current hydrated node, never hold a potentially detached SSR element handle.
  await locator.click({ trial: true }); await locator.focus();
  assert.equal(await locator.evaluate(element => element === document.activeElement), true); await page.keyboard.press('Space');
}
async function keyboardFocus(page, locator, nativeKey) {
  await locator.click({ trial: true });
  for (let steps = 0; steps <= 32; steps++) {
    // activeElement alone can remain the button while native browser-content focus is elsewhere.
    if (await locator.evaluate(element => !element.disabled && document.hasFocus() && element === document.activeElement &&
        element.matches(':focus') && element.matches(':focus-visible'))) return steps;
    if (steps < 32) await page.keyboard.press(nativeKey);
  }
  assert.fail(`Native ${nativeKey} did not focus the current enabled control within 32 steps`);
}
const contrast = (foreground, background) => {
  const luminance = color => {
    const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return .2126 * r + .7152 * g + .0722 * b;
  };
  const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};
for (const [name, engine] of Object.entries(engines)) {
  let browser, context, page, phase = 'arrival';
  const checks = [], errors = [], foreign = [], retirements = [], palettes = [];
  try {
    browser = await engine.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(5000);
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== target.origin) { foreign.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__resourceTaskRetired', value => retirements.push(value));
    await page.addInitScript(() => {
      window.addEventListener('101-local-resource-retired', event => { void window.__resourceTaskRetired(event.detail); });
    });
    const response = await page.goto(new URL('/connections/resources', target).href); assert.equal(response.status(), 200);
    await page.getByRole('heading', { name: 'Connect page controls', exact: true }).waitFor();
    const review = page.getByRole('button', { name: 'Review selected connection', exact: true });
    await review.click({ trial: true });
    const main = page.locator('[data-resource-task-state]'), meter = page.getByRole('meter', { name: 'Connected page meter', exact: true });
    const number = page.getByRole('status', { name: 'Connected number readout', exact: true });
    const indicator = page.getByRole('status', { name: 'Connected switch readout', exact: true });
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.equal(await main.getAttribute('data-resource-task-registrations'), '0');
    assert.equal(await main.getAttribute('data-resource-task-routes'), '0'); assert.equal(await main.getAttribute('data-resource-task-timers'), '0');
    assert.equal(await number.textContent(), 'Waiting'); assert.equal(await indicator.textContent(), 'Waiting'); checks.push('inert-entry-no-registered-resource-or-timer');
    phase = 'actual-application-palettes';
    // Explicitly selected QA engine policy, established by retained owned native diagnostics; no product UA detection.
    const nativeFocusKey = name === 'webkit' ? 'Alt+Tab' : 'Tab';
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme }); const nativeTabSteps = await keyboardFocus(page, review, nativeFocusKey);
      const palette = await main.evaluate(element => {
        const style = getComputedStyle(element), rootStyle = getComputedStyle(document.documentElement),
          panel = getComputedStyle(element.querySelector('#resource-choice')),
          button = getComputedStyle(element.querySelector('#resource-choice button'));
        return { paper: rootStyle.getPropertyValue('--paper').trim(), panel: rootStyle.getPropertyValue('--panel').trim(),
          lineControl: rootStyle.getPropertyValue('--line-control').trim(), color: style.color,
          statusColor: getComputedStyle(element.querySelector('[data-resource-task-reason]')).color,
          bodyBackground: getComputedStyle(document.body).backgroundColor, panelBackground: panel.backgroundColor,
          panelBorder: panel.borderTopColor, outlineColor: button.outlineColor, outlineStyle: button.outlineStyle,
          outlineWidth: button.outlineWidth, documentHasFocus: document.hasFocus(),
          reviewIsActive: element.querySelector('#resource-choice button') === document.activeElement,
          reviewMatchesFocus: element.querySelector('#resource-choice button').matches(':focus'),
          reviewMatchesFocusVisible: element.querySelector('#resource-choice button').matches(':focus-visible') };
      });
      assert.equal(palette.paper, scheme === 'dark' ? '#f2f2f2' : '#0a0a0a');
      assert.equal(palette.panel, scheme === 'dark' ? '#101010' : '#f7f7f7');
      assert.equal(palette.color, scheme === 'dark' ? 'rgb(242, 242, 242)' : 'rgb(10, 10, 10)');
      assert.equal(palette.statusColor, palette.color);
      assert.equal(palette.panelBackground, scheme === 'dark' ? 'rgb(16, 16, 16)' : 'rgb(247, 247, 247)');
      assert.equal(palette.panelBorder, palette.lineControl); assert.equal(palette.outlineColor, palette.color);
      assert.equal(palette.documentHasFocus, true); assert.equal(palette.reviewIsActive, true);
      assert.equal(palette.reviewMatchesFocus, true); assert.equal(palette.reviewMatchesFocusVisible, true);
      assert.equal(palette.outlineStyle, 'solid'); assert.equal(palette.outlineWidth, '2px');
      assert.ok(contrast(palette.statusColor, palette.bodyBackground) >= 4.5);
      assert.ok(contrast(palette.outlineColor, palette.panelBackground) >= 3);
      palettes.push({ scheme, nativeFocusKey, nativeTabSteps, ...palette });
    }
    await page.emulateMedia({ colorScheme: 'dark' }); checks.push('actual-dark-and-light-palette-status-and-focus-contrast');
    async function select(source, output) {
      await page.getByRole('combobox', { name: 'Page input', exact: true }).selectOption(source);
      await page.getByRole('combobox', { name: 'Page output', exact: true }).selectOption(output);
    }
    async function approveAndStart(replacement = false) {
      await keyboardActivate(page, review);
      await keyboardActivate(page, page.getByRole('button', { name: 'Allow selected input', exact: true }));
      const start = page.getByRole('button', { name: replacement ? 'Replace current connection' : 'Start selected connection', exact: true });
      assert.equal(await start.isDisabled(), true, 'input approval does not grant an output operation');
      await keyboardActivate(page, page.getByRole('button', { name: 'Allow selected output', exact: true }));
      await keyboardActivate(page, start); await page.waitForFunction(() => document.querySelector('[data-resource-task-state]')?.dataset.resourceTaskState === 'active');
    }
    async function stopped() {
      await page.waitForFunction(() => { const node = document.querySelector('[data-resource-task-state]');
        return node && node.dataset.resourceTaskRaw === '0' && node.dataset.resourceTaskRegistrations === '0' &&
          node.dataset.resourceTaskRoutes === '0' && node.dataset.resourceTaskTimers === '0'; });
    }
    phase = 'compatibility'; await select('page-toggle', 'page-meter'); assert.equal(await review.isDisabled(), true);
    await select('page-slider', 'page-meter'); assert.equal(await review.isDisabled(), false); checks.push('actual-schema-compatible-options-and-recoverable-mismatch');
    phase = 'selected-slider'; await approveAndStart();
    assert.equal(await meter.getAttribute('data-receiving'), 'false', 'Start alone is not a fabricated source event');
    await page.getByRole('slider', { name: 'Page slider value', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[aria-label="Connected page meter"]')?.value === 51);
    assert.equal(await number.textContent(), 'Waiting'); assert.equal(await indicator.textContent(), 'Waiting');
    checks.push('independent-source-output-consent', 'actual-native-range-event-to-exact-public-runtime-meter');
    phase = 'candidate-cancel'; await select('page-toggle', 'page-indicator'); await keyboardActivate(page, review);
    assert.equal(await meter.evaluate(element => element.value), 51);
    await keyboardActivate(page, page.getByRole('button', { name: 'Cancel review', exact: true }));
    assert.equal(await meter.evaluate(element => element.value), 51); assert.equal(await review.evaluate(element => element === document.activeElement), true);
    checks.push('inert-candidate-cancel-preserves-current-effect-and-focus');
    phase = 'candidate-decline'; await keyboardActivate(page, review);
    await keyboardActivate(page, page.getByRole('button', { name: 'Decline choice', exact: true })); assert.equal(await meter.evaluate(element => element.value), 51);
    checks.push('declined-review-grants-no-effect-and-preserves-incumbent');
    phase = 'explicit-replacement'; await approveAndStart(true); assert.equal(await meter.evaluate(element => element.value), 0);
    assert.equal(await meter.getAttribute('data-receiving'), 'false'); assert.equal(await indicator.textContent(), 'Waiting');
    await keyboardActivate(page, page.getByRole('button', { name: 'Toggle page switch', exact: true }));
    await page.waitForFunction(() => document.querySelector('[aria-label="Connected switch readout"]')?.value === 'On');
    checks.push('old-output-release-before-explicit-replacement', 'actual-native-button-boolean-to-current-runtime-output');
    phase = 'revoke'; await keyboardActivate(page, page.getByRole('button', { name: 'Remove input permission', exact: true })); await stopped();
    assert.equal(await indicator.textContent(), 'Waiting'); assert.equal(await review.evaluate(element => element === document.activeElement), true);
    checks.push('source-revoke-releases-output-and-focus-after-settlement');
    phase = 'actual-timer-count'; await select('page-ticks', 'page-number'); await approveAndStart();
    await page.waitForFunction(() => document.querySelector('[aria-label="Connected number readout"]')?.dataset.receiving === 'true');
    assert.ok(Number(await number.textContent()) >= 0); checks.push('actual-owned-timer-callback-counter-through-public-recipe-route');
    await keyboardActivate(page, page.getByRole('button', { name: 'Stop connection', exact: true })); await stopped();
    assert.equal(await number.textContent(), 'Waiting');
    phase = 'quiet-expiry'; await select('page-slider', 'page-number'); await approveAndStart();
    // No source events after this grant: the original absolute 30s deadline must retire a quiet route.
    const beforeQuietDeliveries = await main.getAttribute('data-resource-task-deliveries');
    assert.equal(await number.textContent(), 'Waiting'); assert.equal(await number.getAttribute('data-receiving'), 'false');
    assert.equal(await main.getAttribute('data-resource-task-timers'), '1', 'Only the owned expiry timer is active');
    await page.locator('[data-resource-task-reason="expired"]').waitFor({ timeout: 32000 }); await stopped();
    assert.equal(await number.textContent(), 'Waiting'); assert.equal(await page.getByRole('button', { name: 'Stop connection', exact: true }).count(), 0);
    assert.equal(await main.getAttribute('data-resource-task-deliveries'), beforeQuietDeliveries, 'No timer or input samples were emitted during quiet expiry');
    checks.push('absolute-quiet-expiry-without-renewal-and-all-owned-timers-released');
    phase = 'fresh-stop'; await select('page-slider', 'page-number'); await approveAndStart();
    await page.getByRole('slider', { name: 'Page slider value', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('[aria-label="Connected number readout"]')?.value === '52');
    await keyboardActivate(page, page.getByRole('button', { name: 'Stop connection', exact: true })); await stopped();
    assert.equal(await number.textContent(), 'Waiting'); assert.equal(await review.evaluate(element => element === document.activeElement), true);
    checks.push('fresh-selection-fresh-approvals-after-expiry', 'explicit-stop-clears-exact-output-and-settled-focus');
    phase = 'focus-loss-fixture'; await select('page-toggle', 'page-indicator'); await approveAndStart();
    await keyboardActivate(page, page.getByRole('button', { name: 'Toggle page switch', exact: true }));
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await stopped(); assert.equal(await indicator.textContent(), 'Waiting');
    checks.push('explicit-software-window-blur-lifecycle-fixture-retires-route');
    phase = 'responsive'; for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await review.focus(); assert.notEqual(await review.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    assert.equal(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })), stored);
    checks.push('responsive-visible-focus-reduced-motion-and-no-resource-storage');
    phase = 'unmount'; await select('page-ticks', 'page-number'); await approveAndStart();
    await page.waitForFunction(() => document.querySelector('[aria-label="Connected number readout"]')?.dataset.receiving === 'true');
    const before = retirements.length; const back = main.getByRole('link', { name: 'Connections', exact: true }); await back.focus(); await page.keyboard.press('Enter');
    await page.waitForURL(url => url.pathname === '/connections');
    // Actual application close emits only redacted post-settlement counts. No raw promise is equated with logical Stop.
    await page.waitForFunction(() => !document.querySelector('[data-resource-task-state]'));
    await new Promise((resolveWait, reject) => {
      const end = setTimeout(() => { clearInterval(check); reject(Error('Actual unmount settlement readback was not observed')); }, 2500);
      const check = setInterval(() => { if (retirements.length > before) { clearTimeout(end); clearInterval(check); resolveWait(); } }, 10);
    });
    const retired = retirements.at(-1); assert.equal(retired.state, 'closed'); assert.equal(retired.rawPending, 0); assert.equal(retired.startPending, false);
    assert.deepEqual(retired.owned, { registrations: 0, routes: 0, producerTimers: 0, expiryTimers: 0 }); assert.equal(retired.cleanupUnconfirmed, false);
    checks.push('actual-route-unmount-awaits-owned-work-and-redacted-zero-resource-readback');
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
    results.push({ engine: name, version: browser.version(), status: 'pass', checks, actualEffects: 'owned-page-timer/native-range/native-button through real public SDK routing into actual native DOM displays',
      physical: false, lifecycleFixture: 'window.blur dispatch is explicitly software; unmount is actual application route navigation', palettes, retirements });
    await page.screenshot({ path: join(work, `${name}-completed.png`), fullPage: true });
  } catch (error) {
    failure = error; let state;
    try { state = await page?.locator('[data-resource-task-state]').evaluate(element => ({ ...element.dataset })); } catch { state = 'task-not-present'; }
    results.push({ engine: name, status: 'fail', phase, checks, error: String(error), state, errors, foreign, palettes, retirements });
  } finally {
    if (page && !page.isClosed()) { try {
      const stop = page.getByRole('button', { name: 'Stop connection', exact: true });
      if (await stop.count()) await keyboardActivate(page, stop);
    } catch { /* The owned context exit below is explicit; no unobserved Stop is claimed settled. */ } }
    await context?.close(); await browser?.close();
  }
  if (failure) break;
}
const receipt = { schemaVersion: 1, status: failure ? 'fail' : 'pass', sourcePins, dependencyPins, actualServedProof: proof,
  requestedEngine: selectedEngine ?? 'both', executedEngines: results.map(result => result.engine),
  results, ownedBrowserContextsAfterExit: 0, ownedBrowsersAfterExit: 0, serverOwnership: 'Caller owns the supplied loopback application server; this QA does not create or claim to close it',
  scope: 'Selected local software general-resource connection task only. No device enrollment, remote/relay, physical input/output or arbitrary schema support.' };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ ...receipt, work }, null, 2));
if (failure) { console.error(String(failure)); process.exitCode = 1; }
