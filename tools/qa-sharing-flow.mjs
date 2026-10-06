import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';

const target = new URL(process.argv[2] ?? 'http://localhost:3248/sharing');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
assert.ok(['http:', 'https:'].includes(target.protocol));
assert.equal(target.pathname, '/sharing'); assert.equal(target.username, ''); assert.equal(target.password, '');
assert.equal(target.search, ''); assert.equal(target.hash, '');
const paths = ['app/sharing/page.tsx', 'app/sharing/SharingView.tsx', 'app/sharing/sharing-task.ts', 'app/sharing/sharing-task.test.ts', 'app/sharing/sharing.module.css', 'tools/qa-sharing-flow.mjs'];
const dependencies = ['packages/connect/src/index.ts', 'packages/device-runtime/src/input-ownership.ts', 'packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/route-group-runtime.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/index.ts', 'packages/device-runtime/src/lease.ts', 'packages/device-runtime/src/scheduler.ts', 'packages/device-web/src/pointer-driver.ts', 'packages/device-web/src/pointer-provider.ts', 'packages/device-model/src/input-profile.ts', 'packages/device-model/src/descriptor.ts', 'packages/device-model/src/route-group.ts', 'packages/device-model/src/index.ts', 'packages/device-web/src/index.ts', 'app/globals.css', 'app/components/AppShell.tsx', 'vite.config.ts', 'package-lock.json'];
const pin = list => Object.fromEntries(list.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const sourceSha256 = pin(paths), dependencySha256 = pin(dependencies);
const output = mkdtempSync(join(tmpdir(), '101-sharing-flow-'));
const results = [];
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
    const errors = [], foreign = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== target.origin) { foreign.push(new URL(route.request().url()).origin); return route.abort(); }
      return route.continue();
    });
    await context.addInitScript(() => {
      const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window), owned = new Set();
      window.__sharingFrames = owned;
      window.requestAnimationFrame = callback => {
        let id; id = request(at => { owned.delete(id); callback(at); });
        if (callback.name === 'sharingTick') owned.add(id); return id;
      };
      window.cancelAnimationFrame = id => { owned.delete(id); cancel(id); };
      const clock = performance.now.bind(performance); window.__sharingOffset = 0;
      Object.defineProperty(performance, 'now', { value: () => clock() + window.__sharingOffset });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const checks = [];
    await page.goto(target.href); await page.getByRole('heading', { name: 'Choose who can use your play area' }).waitFor(); await page.waitForLoadState('networkidle');
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.equal(await page.getByTestId('sharing-surface-left').count(), 0); checks.push('inert-entry');
    await page.getByRole('button', { name: 'Start sharing setup', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByTestId('sharing-controls-first').waitFor();
    const controls = id => page.getByTestId(`sharing-controls-${id}`), slot = id => page.getByTestId(`sharing-slot-${id}`);
    const surface = id => page.getByTestId(`sharing-surface-${id}`), owner = id => page.getByTestId(`sharing-owner-${id}`);
    async function request(id, side) {
      const card = controls(id), label = id === 'first' ? 'First controls' : 'Second controls';
      await card.getByRole('combobox', { name: `Area for ${label}` }).selectOption(side);
      await card.getByRole('checkbox').check(); await card.getByRole('button', { name: `Request sharing for ${label}`, exact: true }).click();
      await page.getByTestId(`sharing-review-${side}`).waitFor();
    }
    async function approve(side) {
      await page.getByTestId(`sharing-review-${side}`).getByRole('button', { name: /^Approve / }).click();
      await page.waitForFunction(id => document.querySelector(`[data-testid="sharing-owner-${id}"]`)?.textContent !== 'None', side);
      // Real initial provider release is subject to the declared 60Hz admission limit.
      await page.waitForFunction(id => document.querySelector(`[data-testid="sharing-surface-${id}"]`)?.hasAttribute('data-x'), side);
    }
    assert.equal(await controls('first').getByRole('button', { name: 'Request sharing for First controls' }).isDisabled(), true);
    await request('first', 'left');
    assert.equal(await surface('left').getAttribute('data-x'), null); assert.equal(await surface('left').getAttribute('data-held'), 'false');
    assert.equal(await page.locator('#sharing-approve-left').evaluate(element => document.activeElement === element), true);
    assert.match(await page.getByTestId('sharing-review-left').innerText(), /30 seconds/); checks.push('separate-consent-review');
    await approve('left'); assert.equal(await owner('left').innerText(), 'First controls');
    const firstPad = controls('first').getByRole('button', { name: 'First controls input pad' });
    await firstPad.focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="sharing-surface-left"]').dataset.x) > .5);
    await page.keyboard.down('Space'); await page.waitForFunction(() => document.querySelector('[data-testid="sharing-surface-left"]').dataset.held === 'true');
    await page.keyboard.up('Space'); await page.waitForFunction(() => document.querySelector('[data-testid="sharing-surface-left"]').dataset.held === 'false'); checks.push('actual-keyboard-position-press-release');
    // Hold via native button so focus can move between two independent software controls.
    await controls('first').getByRole('button', { name: 'Press First controls', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="sharing-surface-left"]').dataset.held === 'true');
    await request('second', 'left');
    assert.equal(await surface('left').getAttribute('data-held'), 'true');
    await page.getByTestId('sharing-review-left').getByRole('button', { name: 'Decline request' }).click();
    assert.equal(await surface('left').getAttribute('data-held'), 'true');
    await request('second', 'left'); await page.getByTestId('sharing-review-left').getByRole('button', { name: 'Cancel request' }).click();
    assert.equal(await surface('left').getAttribute('data-held'), 'true'); checks.push('incumbent-retained-decline-cancel');
    await slot('left').getByRole('button', { name: 'Stop sharing left side' }).click();
    await page.getByRole('combobox', { name: 'Sharing duration', exact: true }).selectOption('60');
    await request('second', 'left');
    assert.match(await page.getByTestId('sharing-review-left').innerText(), /60 seconds/);
    await approve('left');
    assert.match(await slot('left').innerText(), /60 seconds/);
    await page.getByRole('button', { name: 'Confirm stop sharing' }).click();
    await page.getByRole('alert').filter({ hasText: 'Sharing changed since this review' }).waitFor();
    assert.equal(await owner('left').innerText(), 'Second controls');
    await page.waitForFunction(() => document.activeElement.id === 'sharing-status');
    assert.equal(await page.locator('#sharing-status').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    await page.getByRole('button', { name: 'Review current sharing' }).click();
    await page.getByRole('button', { name: 'Keep current sharing' }).click();
    checks.push('stale-revoke-visible-safe-refresh-selected-60s');
    assert.equal(await owner('left').innerText(), 'Second controls'); assert.equal(await surface('left').getAttribute('data-held'), 'false');
    assert.equal(await controls('first').getByRole('button', { name: 'First controls input pad' }).isDisabled(), true); checks.push('transfer-releases-old-output');
    await slot('left').getByRole('button', { name: 'Stop sharing left side' }).click();
    assert.match(await page.getByRole('heading', { name: 'Review what will stop' }).locator('..').innerText(), /Second controls on left side/);
    await page.getByRole('button', { name: 'Keep current sharing' }).click(); assert.equal(await owner('left').innerText(), 'Second controls');
    await slot('left').getByRole('button', { name: 'Stop sharing left side' }).click(); await page.getByRole('button', { name: 'Confirm stop sharing' }).click();
    assert.equal(await owner('left').innerText(), 'None'); checks.push('revoke-preview-cancel-confirm');
    await request('first', 'left'); await approve('left'); await request('second', 'right'); await approve('right');
    await controls('first').getByRole('button', { name: 'Press First controls', exact: true }).click();
    await controls('second').getByRole('button', { name: 'Press Second controls', exact: true }).click();
    await page.waitForFunction(() => ['left','right'].every(id => document.querySelector(`[data-testid="sharing-surface-${id}"]`).dataset.held === 'true'));
    await controls('first').getByRole('button', { name: 'Move First controls right' }).click();
    await controls('second').getByRole('button', { name: 'Move Second controls left' }).click();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="sharing-surface-left"]').dataset.x) > .5 && Number(document.querySelector('[data-testid="sharing-surface-right"]').dataset.x) < .5);
    await page.screenshot({ path: join(output, `${engine.name()}-partitions.png`), fullPage: true }); checks.push('simultaneous-declared-partitions');
    await slot('left').getByRole('button', { name: 'Stop sharing left side' }).click(); await page.getByRole('button', { name: 'Confirm stop sharing' }).click();
    assert.equal(await surface('left').getAttribute('data-held'), 'false'); assert.equal(await surface('right').getAttribute('data-held'), 'true'); checks.push('partition-revoke-isolation');
    await controls('second').getByRole('button', { name: 'Disable Second controls' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="sharing-owner-right"]').textContent === 'None');
    assert.equal(await surface('right').getAttribute('data-held'), 'false');
    await controls('second').getByRole('button', { name: 'Enable Second controls' }).click(); assert.equal(await owner('right').innerText(), 'None');
    await request('second', 'right'); await approve('right'); checks.push('native-readiness-loss-fresh-retry');
    await page.getByRole('button', { name: 'Use one shared area' }).click(); await page.getByRole('button', { name: 'Keep current sharing' }).click();
    assert.equal(await owner('right').innerText(), 'Second controls');
    await page.getByRole('button', { name: 'Use one shared area' }).click(); await page.getByRole('button', { name: 'Stop sharing and change area' }).click();
    await surface('exclusive').waitFor(); assert.equal(await owner('exclusive').innerText(), 'None');
    await page.getByRole('combobox', { name: 'Sharing duration', exact: true }).selectOption('30');
    await request('first', 'exclusive'); await approve('exclusive'); checks.push('policy-review-and-fresh-consent');
    // Real native pointer events against the same public driver/runtime path.
    await firstPad.scrollIntoViewIfNeeded();
    const box = await firstPad.boundingBox(); await page.mouse.move(box.x + box.width * .2, box.y + box.height * .5); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .7, box.y + box.height * .5); await page.mouse.up();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="sharing-surface-exclusive"]').dataset.x) > .7); checks.push('actual-native-pointer');
    await controls('first').getByRole('button', { name: 'Press First controls', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="sharing-surface-exclusive"]').dataset.held === 'true');
    // Accelerated trusted-clock steps preserve real 1500ms route renewals until the absolute grant ends.
    await page.evaluate(async () => { for (let i=0;i<62;i++) { window.__sharingOffset += 500; await new Promise(resolve => requestAnimationFrame(resolve)); } });
    await page.waitForFunction(() => document.querySelector('[data-testid="sharing-owner-exclusive"]').textContent === 'None');
    assert.equal(await surface('exclusive').getAttribute('data-held'), 'false'); assert.equal(await surface('exclusive').getAttribute('data-x'), null); checks.push('absolute-quiet-expiry-no-restored-grant');
    await request('first', 'exclusive'); await approve('exclusive');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await owner('exclusive').innerText(), 'None'); checks.push('synthetic-background-release');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const controlsSize = await page.locator('main button,main select,main a,main label:has(input)').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height > 0).map(node => {
      const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height, name: node.textContent.trim().slice(0,100), tag: node.tagName };
    })); assert.ok(controlsSize.every(({width,height}) => width >= 44 && height >= 44), JSON.stringify(controlsSize.filter(({width,height}) => width < 44 || height < 44)));
    await page.locator('#sharing-status').focus(); await page.keyboard.press(engine.name() === 'webkit' ? 'Alt+Tab' : 'Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BUTTON');
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid'); checks.push('native-keyboard-focus-44px-reflow');
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      const colors = await page.locator('main').evaluate(node => {
        const style = getComputedStyle(node); return { text: style.color, background: getComputedStyle(document.body).backgroundColor };
      });
      const luminance = rgb => { const parts = rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(x => x/255).map(x => x <= .04045 ? x/12.92 : ((x+.055)/1.055)**2.4); return .2126*parts[0]+.7152*parts[1]+.0722*parts[2]; };
      const values = [luminance(colors.text), luminance(colors.background)].sort((a,b) => a-b);
      assert.ok((values[1]+.05)/(values[0]+.05) >= 4.5, JSON.stringify(colors));
      await page.screenshot({ path: join(output, `${engine.name()}-${scheme}-narrow.png`), fullPage: true });
    }
    checks.push('light-dark-readable-reduced-motion');
    assert.equal(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })), stored); checks.push('no-persisted-grants');
    await page.getByRole('button', { name: 'Stop this setup' }).click();
    assert.equal(await page.evaluate(() => window.__sharingFrames.size), 0);
    await page.getByRole('button', { name: 'Start sharing setup' }).click(); await owner('left').waitFor(); assert.equal(await owner('left').innerText(), 'None');
    await page.getByRole('link', { name: 'Back to Devices' }).click(); await page.waitForURL('**/devices');
    assert.equal(await page.evaluate(() => window.__sharingFrames.size), 0); checks.push('close-restart-client-navigation-teardown');
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
    results.push({ browser: engine.name(), version: browser.version(), traversalKey: engine.name() === 'webkit' ? 'Alt+Tab' : 'Tab', checks, pageErrors: errors.length, foreignRequests: foreign.length });
    writeFileSync(join(output, `${engine.name()}-result.json`), JSON.stringify(results.at(-1), null, 2));
    await context.close();
  } catch (error) { console.error(JSON.stringify({ engine: engine.name(), version: browser.version(), output })); throw error; }
  finally { await browser.close(); }
}
assert.deepEqual(pin(paths), sourceSha256); assert.deepEqual(pin(dependencies), dependencySha256);
const receipt = { result: 'pass', profile: 'local-application-sharing/1', sourceSha256, dependencySha256, results,
  scope: 'Actual same-page native keyboard/pointer, public SDK local input ownership/runtime effects. Accelerated trusted clock and synthetic blur are explicitly controlled lifecycle fixtures. No remote identity, observer distribution, phones, OS cursor, hardware or named screen reader qualification.', published: false };
writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)+'\n');
console.log(JSON.stringify({ result: 'pass', receipt: join(output, 'receipt.json'), results }, null, 2));
