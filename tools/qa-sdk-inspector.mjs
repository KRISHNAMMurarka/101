import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createUiEvidence, keyboardClick, timeout } from './qa-enrollment-ui.mjs';

const origin = process.env.QA_BASE_URL ?? 'http://localhost:3000';
const target = new URL('/studio/inspector', origin);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'SDK inspector QA is local only');
const evidence = createUiEvidence('sdk-inspector', target, [
  'app/studio/inspector/InspectorLab.tsx', 'app/studio/inspector/page.tsx', 'tools/qa-sdk-inspector.mjs',
]);
const receipts = [];
let stage = 'browser-launch';
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      let pageErrorCount = 0;
      page.on('pageerror', () => { pageErrorCount++; });
      stage = `${engine.name()}:load`;
      await page.goto(target.href, { waitUntil: 'networkidle' });
      await page.getByTestId('resource-graph').waitFor({ timeout });
      assert.match(await page.getByTestId('resource-graph').innerText(), /source.*available.*event \/ boolean v1/);
      assert.match(await page.getByTestId('resource-graph').innerText(), /sink.*available.*command \/ boolean v1/);
      assert.match(await page.getByTestId('current-route').innerText(), /idle.*not-requested/);
      const click = name => keyboardClick(page, page.getByRole('button', { name, exact: true }));
      stage = `${engine.name()}:deny-allow-queue`;
      await click('Deny grant');
      assert.match(await page.getByTestId('current-route').innerText(), /grant: denied/);
      assert.equal(await page.getByRole('button', { name: 'Enqueue event', exact: true }).isDisabled(), true);
      await click('Allow grant');
      assert.match(await page.getByTestId('current-route').innerText(), /active.*allowed/);
      await click('Probe queue bound');
      assert.match(await page.getByTestId('queue-status').innerText(), /Pending: 4 \/ 4.*observed deliveries: 0/);
      assert.match(await page.getByTestId('inspector-errors').innerText(), /capacity/);
      await click('Flush queue');
      assert.match(await page.getByTestId('queue-status').innerText(), /Pending: 0 \/ 4.*observed deliveries: 4/);
      assert.match(await page.getByTestId('operation-records').innerText(), /observed.*handler returned.*effect observed/);
      stage = `${engine.name()}:loss-recovery-revoke`;
      await click('Lose source readiness');
      assert.match(await page.getByTestId('resource-graph').innerText(), /source.*unavailable/);
      assert.match(await page.getByTestId('current-route').innerText(), /closed/);
      await click('Allow grant');
      assert.match(await page.getByTestId('inspector-errors').innerText(), /unavailable/);
      await click('Restore source readiness'); await click('Allow grant'); await click('Enqueue event'); await click('Revoke grant');
      assert.match(await page.getByTestId('current-route').innerText(), /closed.*revoked/);
      assert.match(await page.getByTestId('queue-status').innerText(), /Pending: 0 \/ 4.*observed deliveries: 4/);
      assert.match(await page.getByTestId('operation-records').innerText(), /cancelled/);
      stage = `${engine.name()}:schema-expiry-bounds`;
      await click('Probe invalid schema'); await click('Probe unsupported version');
      assert.match(await page.getByTestId('inspector-errors').innerText(), /schema-invalid/);
      assert.match(await page.getByTestId('inspector-errors').innerText(), /schema-version/);
      await click('Allow grant'); await click('Expire grant');
      assert.match(await page.getByTestId('current-route').innerText(), /closed.*expired/);
      for (let index = 0; index < 12; index++) { await click('Allow grant'); await click('Revoke grant'); }
      assert.match(await page.getByTestId('trace-bound').innerText(), /Retained: 24 \/ 24 entries/);
      assert.ok(await page.getByTestId('route-graph').locator('li').count() <= 8);
      const diagnostics = await page.locator('[data-testid="resource-graph"], [data-testid="route-graph"], [data-testid="inspector-trace"], [data-testid="inspector-errors"], [data-testid="operation-records"]').allInnerTexts();
      assert.equal(diagnostics.join('').includes('inspector-source'), false);
      assert.equal(diagnostics.join('').includes('inspector-sink'), false);
      assert.equal(diagnostics.join('').includes('Local developer fixture'), false);
      await evidence.screenshot(page, `${engine.name()}-diagnostics`);
      stage = `${engine.name()}:close-responsive`;
      await click('Close runtime');
      assert.match(await page.getByTestId('inspector-status').innerText(), /Runtime closed/);
      assert.equal(await page.getByRole('button', { name: 'Allow grant', exact: true }).isDisabled(), true);
      assert.equal(await page.getByTestId('route-graph').locator('li').count(), 0);
      await click('Reset runtime');
      assert.match(await page.getByTestId('current-route').innerText(), /idle.*not-requested/);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'phone viewport has no horizontal overflow');
      await evidence.screenshot(page, `${engine.name()}-narrow`);
      assert.equal(pageErrorCount, 0, 'actual browser journey has no page errors');
      receipts.push({ engine: engine.name(), denyAllowRevoke: true, typedSourceSink: true, queueBound: 4, retainedTraceBound: 24,
        routeRetentionBound: 8, schemaVersionErrors: true, readinessRecovery: true, expiry: true,
        teardownReset: true, keyboardFocus: true, responsiveWidth: 390, pageErrorCount });
      await context.close();
    } finally { await browser.close(); }
  }
  evidence.record('passed', { receipts, physicalQualification: 'not-run' });
} catch (error) {
  evidence.record('failed', { stage, errorType: error.name, receipts, physicalQualification: 'not-run' });
}
