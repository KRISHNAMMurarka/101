import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const target = new URL(process.argv.find(value => value.startsWith('http')) ?? 'http://localhost:3247/studio/ownership');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
assert.equal(target.pathname, '/studio/ownership');
const paths = [
  'packages/device-runtime/src/input-ownership.ts', 'packages/device-runtime/src/input-ownership.test.ts', 'examples/device-pipelines/input-ownership.ts',
  'app/components/InputOwnershipPanel.tsx', 'app/studio/ownership/OwnershipLab.tsx', 'app/studio/ownership/page.tsx',
  'app/studio/ownership/ownership-lab.module.css', 'tools/qa-input-ownership.mjs'];
const sourceSha256 = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const results = [];
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' });
    const errors = [], foreign = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== target.origin) { foreign.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await context.addInitScript(() => {
      const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const owned = new Set(); window.__ownershipRaf = owned;
      window.requestAnimationFrame = callback => {
        let id; id = request(at => { owned.delete(id); callback(at); });
        if (callback.name === 'tick') owned.add(id); return id;
      };
      window.cancelAnimationFrame = id => { owned.delete(id); cancel(id); };
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push({ name: error.name, message: error.message }));
    await page.goto(target.href); await page.waitForLoadState('networkidle');
    {
      await page.getByTestId('input-ownership-panel').waitFor();
      const policy = page.getByRole('combobox', { name: 'Surface policy' });
      await policy.selectOption('exclusive'); await page.getByTestId('ownership-slot-exclusive').waitFor();
      const slot = page.getByTestId('ownership-slot-exclusive'), surface = page.getByTestId('application-surface-exclusive');
      const choose = page.getByRole('combobox', { name: 'Input requesting control' });
      assert.equal(await surface.getAttribute('data-contact'), 'false');
      assert.match(await page.getByRole('status', { name: 'Local delivery counters' }).innerText(), /observed frames: 0/);
      await slot.getByRole('button', { name: 'Request control of surface', exact: true }).click();
      const allowFirst = slot.getByRole('button', { name: 'Allow Local input 1', exact: true });
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Allow Local input 1');
      assert.equal(await allowFirst.evaluate(element => document.activeElement === element), true);
      await page.keyboard.press('Enter'); await page.getByTestId('ownership-owner-exclusive').filter({ hasText: 'Local input 1' }).waitFor();
      assert.equal(await slot.getByRole('button', { name: 'Release control', exact: true }).evaluate(element => document.activeElement === element), true);
      await page.getByRole('button', { name: 'Local input 1 contact', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="application-surface-exclusive"]')?.dataset.contact === 'true');
      await page.getByRole('button', { name: 'Local input 1 right', exact: true }).click();
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="application-surface-exclusive"]')?.dataset.x) > 0.5);
      await choose.selectOption('second');
      const requestSecond = () => slot.getByRole('button', { name: 'Request control of surface', exact: true }).click();
      await requestSecond(); assert.equal(await surface.getAttribute('data-contact'), 'true');
      await slot.getByRole('button', { name: 'Decline request', exact: true }).click(); assert.equal(await surface.getAttribute('data-contact'), 'true');
      await requestSecond(); await slot.getByRole('button', { name: 'Cancel request', exact: true }).click(); assert.equal(await surface.getAttribute('data-contact'), 'true');
      await requestSecond(); await slot.getByRole('button', { name: 'Allow transfer to Local input 2', exact: true }).click();
      await page.getByTestId('ownership-owner-exclusive').filter({ hasText: 'Local input 2' }).waitFor();
      assert.equal(await surface.getAttribute('data-contact'), 'false');
      const pad = page.getByRole('group', { name: 'Local input 2 pad', exact: true });
      await pad.focus(); await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => Math.abs(Number(document.querySelector('[data-testid="application-surface-exclusive"]')?.dataset.x) - 0.52) < 0.001);
      await page.keyboard.down('Space'); await page.waitForFunction(() => document.querySelector('[data-testid="application-surface-exclusive"]')?.dataset.contact === 'true');
      await page.keyboard.up('Space'); await page.waitForFunction(() => document.querySelector('[data-testid="application-surface-exclusive"]')?.dataset.contact === 'false');
      const bounds = await pad.boundingBox(); await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.5); await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.3); await page.mouse.up();
      await page.waitForFunction(() => Number(document.querySelector('[data-testid="application-surface-exclusive"]')?.dataset.x) > 0.7);
      await page.getByRole('button', { name: 'Deny new host grants', exact: true }).click(); await choose.selectOption('first'); await requestSecond();
      await slot.getByRole('button', { name: 'Allow transfer to Local input 1', exact: true }).click();
      await slot.getByRole('status').filter({ hasText: 'could not start' }).waitFor(); assert.equal(await surface.getAttribute('data-contact'), 'false');
      assert.match(await page.getByTestId('ownership-owner-exclusive').innerText(), /None/);
      await page.getByRole('button', { name: 'Deny new host grants', exact: true }).click();
      await slot.getByRole('button', { name: 'Request again', exact: true }).click(); await slot.getByRole('button', { name: 'Allow Local input 1', exact: true }).click();
      await policy.selectOption('partitioned'); await page.getByTestId('ownership-slot-left').waitFor();
      const left = page.getByTestId('ownership-slot-left'), right = page.getByTestId('ownership-slot-right');
      await choose.selectOption('first'); await left.getByRole('button', { name: 'Request control of left', exact: true }).click(); await left.getByRole('button', { name: 'Allow Local input 1', exact: true }).click();
      await choose.selectOption('second'); await right.getByRole('button', { name: 'Request control of right', exact: true }).click(); await right.getByRole('button', { name: 'Allow Local input 2', exact: true }).click();
      await page.getByRole('button', { name: 'Local input 1 contact', exact: true }).click(); await page.getByRole('button', { name: 'Local input 2 contact', exact: true }).click();
      await page.waitForFunction(() => ['left', 'right'].every(id => document.querySelector(`[data-testid="application-surface-${id}"]`)?.dataset.contact === 'true'));
      await left.getByRole('button', { name: 'Release left', exact: true }).click();
      assert.equal(await page.getByTestId('application-surface-left').getAttribute('data-contact'), 'false');
      assert.equal(await page.getByTestId('application-surface-right').getAttribute('data-contact'), 'true');
      await choose.selectOption('first'); await left.getByRole('button', { name: 'Request control of left', exact: true }).click();
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      assert.equal(await page.getByRole('button', { name: /^Allow / }).count(), 0);
      assert.equal(await page.getByTestId('application-surface-right').getAttribute('data-contact'), 'false');
      await page.keyboard.press(engine.name() === 'webkit' ? 'Alt+Tab' : 'Tab'); await policy.focus();
      await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await policy.evaluate(element => document.activeElement === element), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const dimensions = await page.locator('main button,main select').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect(); return { width: box.width, height: box.height };
      })); assert.ok(dimensions.every(box => box.width >= 44 && box.height >= 44), JSON.stringify(dimensions));
      assert.equal(await policy.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      await page.getByRole('button', { name: 'Close controls', exact: true }).click(); await page.getByRole('button', { name: 'Restart controls', exact: true }).click();
      await page.getByTestId('ownership-slot-left').waitFor(); assert.match(await page.getByTestId('ownership-owner-left').innerText(), /None/);
      await page.getByRole('link', { name: '101 Studio', exact: true }).click(); await page.waitForURL('**/studio');
      assert.equal(await page.evaluate(() => window.__ownershipRaf.size), 0, 'The owned input tick is cancelled on actual client navigation');
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      results.push({ browser: engine.name(), version: browser.version(), actualPointerAndKeyboard: true, currentOwnerRetained: true,
        explicitConsent: true, partitionIsolation: true, grantDenialRecovery: true, focus: true, targets44: true, narrowReducedMotion: true,
        syntheticBlurReleases: true, clientNavigationTeardown: true, pageErrors: 0, foreignRequests: 0 });
    }
    await context.close();
  } catch (error) { console.error(JSON.stringify({ browser: engine.name(), sourceSha256 })); throw error; }
  finally { await browser.close(); }
}
assert.deepEqual(Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])), sourceSha256, 'Source remains frozen throughout browser proof');
console.log(JSON.stringify({ result: 'pass', profile: 'application-input-ownership/1', sourceSha256, results,
  scope: 'Actual local browser publisher, host grants, typed runtime groups and application effects. Blur fixture is synthetic; phone/remote/OS qualification deferred.', published: false }, null, 2));
