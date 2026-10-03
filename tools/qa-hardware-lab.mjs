import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const target = new URL(process.argv[2] ?? 'http://localhost:3001/studio/hardware');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/studio/hardware') {
  throw new Error('Use the local Hardware Lab');
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const device = Object.assign(new EventTarget(), {
      opened: false,
      vendorId: 0x0101,
      productId: 1,
      productName: 'QA HID',
      async open() { this.opened = true; window.__hardwareProbe.opens += 1; },
      async close() { this.opened = false; window.__hardwareProbe.closes += 1; },
      async sendReport() {},
    });
    window.__hardwareProbe = { requests: 0, opens: 0, closes: 0, pending: [], device };
    const manager = Object.assign(new EventTarget(), {
      async getDevices() { return []; },
      requestDevice() {
        window.__hardwareProbe.requests += 1;
        return new Promise(resolve => window.__hardwareProbe.pending.push(resolve));
      },
    });
    Object.defineProperty(navigator, 'hid', { configurable: true, value: manager });
  });

  await page.goto(target.href);
  const select = page.locator('.hardware-card').filter({ has: page.getByRole('heading', { name: 'WebHID' }) }).getByRole('button');
  await select.click();
  await page.waitForFunction(() => window.__hardwareProbe.requests === 1);
  assert.equal(await select.isDisabled(), true, 'a pending chooser disables repeated selection');
  assert.equal(await page.evaluate(() => window.__hardwareProbe.requests), 1);

  await page.getByRole('link', { name: '101 HARDWARE LAB' }).click();
  await page.waitForURL(url => url.pathname === '/');
  assert.equal(await page.evaluate(() => window.__hardwareProbe.pending.length), 1, 'SPA navigation retains the pending browser chooser');
  await page.evaluate(() => window.__hardwareProbe.pending.shift()([window.__hardwareProbe.device]));
  await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => ({ opens: window.__hardwareProbe.opens, closes: window.__hardwareProbe.closes })),
    { opens: 0, closes: 0 }, 'a chooser resolved after unmount must not open the device');

  await page.goto(target.href);
  await select.click();
  await page.waitForFunction(() => window.__hardwareProbe.requests === 1);
  await page.evaluate(() => window.__hardwareProbe.pending.shift()([]));
  await page.getByRole('alert').waitFor({ state: 'visible' });
  await select.waitFor({ state: 'visible' });
  assert.equal(await select.isDisabled(), false, 'cancelled chooser permits retry');
  await select.click();
  await page.waitForFunction(() => window.__hardwareProbe.requests === 2);
  await page.evaluate(() => window.__hardwareProbe.pending.shift()([window.__hardwareProbe.device]));
  await page.getByRole('button', { name: 'DISCONNECT' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'DISCONNECT' }).click();
  await page.waitForFunction(() => window.__hardwareProbe.closes === 1);
  assert.deepEqual(await page.evaluate(() => ({ opens: window.__hardwareProbe.opens, closes: window.__hardwareProbe.closes })), { opens: 1, closes: 1 });
  assert.deepEqual(pageErrors, []);
  console.log('Hardware Lab chooser lifecycle: passed');
} finally {
  await browser.close();
}
