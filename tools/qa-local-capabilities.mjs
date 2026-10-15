import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const application = new URL(process.argv[2]);
assert.ok(application.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(application.hostname)
  && !application.username && !application.password && application.pathname === '/' && !application.search && !application.hash);
const output = await mkdtemp(path.join(tmpdir(), '101-local-capabilities-'));
const paths = ['app/lib/local-capabilities.ts', 'app/lib/camera-setup.test.ts', 'app/devices/DevicesView.tsx',
  'app/devices/device-inspection.ts', 'app/connections/gamepad/GamepadView.tsx', 'app/connections/gamepad/gamepad-task.ts', 'app/connections/gamepad/gamepad-task.test.ts', 'packages/device-web/src/browser-gamepad.ts', 'tools/qa-local-capabilities.mjs', 'package-lock.json'];
const sourceSha256 = Object.fromEntries(await Promise.all(paths.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const browser = await chromium.launch();
const errors = [], foreign = [];
let denied = true, policyResult, page;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== application.origin) { foreign.push(route.request().url()); return route.abort(); }
    if (!route.request().isNavigationRequest()) return route.continue();
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), 'permissions-policy': denied ? 'gamepad=()' : 'gamepad=(self)' } });
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/devices', application).href);
  policyResult = await page.evaluate(() => { try { navigator.getGamepads(); return 'allowed'; } catch (error) { return error.name; } });
  assert.equal(policyResult, 'SecurityError', 'the native browser must actually refuse gamepad access');
  await page.getByRole('heading', { name: 'What is connected', exact: true }).waitFor({ timeout: 6000 });
  await page.getByText('Local inputs to choose in an application', { exact: true }).waitFor({ timeout: 6000 });
  await page.getByRole('button', { name: 'Inspect this computer', exact: true }).click();
  for (const name of ['Keyboard', 'Mouse', 'Gamepad']) await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 6000 });
  await page.getByRole('button', { name: 'Refresh inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh inputs', exact: true }).waitFor({ timeout: 6000 });
  assert.equal(await page.getByText('Not available', { exact: true }).count() > 0, true);
  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
  denied = false;
  await page.reload();
  assert.equal(await page.evaluate(() => { try { navigator.getGamepads(); return 'allowed'; } catch (error) { return error.name; } }), 'allowed');
  await page.getByText('Local inputs to choose in an application', { exact: true }).waitFor({ timeout: 6000 });
  await page.getByRole('button', { name: 'Inspect this computer', exact: true }).click();
  await page.getByRole('heading', { name: 'Keyboard', exact: true }).waitFor({ timeout: 6000 });
  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
  denied = true;
  await page.goto(new URL('/connections/gamepad', application).href);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Find gamepads' && !button.disabled), undefined, { timeout: 6000 });
  const find = page.getByRole('button', { name: 'Find gamepads', exact: true });
  await find.focus(); await page.keyboard.press('Enter');
  const status = page.locator('main [role="status"]');
  await page.waitForFunction(() => document.querySelector('main [role="status"]')?.textContent.includes('Gamepad access was blocked.'), undefined, { timeout: 6000 });
  assert.equal(await page.getByRole('button', { name: 'Stop gamepad access', exact: true }).isDisabled(), true);
  assert.equal(await find.isEnabled(), true);
  assert.doesNotMatch(await status.innerText(), /then Stop|Stop and find/i, 'already-retired denial must not require the disabled Stop control');
  assert.match(await status.innerText(), /Find gamepads/);
  await find.focus(); await page.keyboard.press('Enter');
  assert.equal(await find.isEnabled(), true);
  await page.getByRole('link', { name: 'Back to Connections', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.waitForURL(new URL('/connections', application).href, { timeout: 6000 });
  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ engine: 'chromium', version: browser.version(), node: process.version,
    sourceSha256, policyResult, checks: ['native-policy-denial', 'devices-survives', 'keyboard-and-mouse-retained', 'refresh-survives', 'fresh-policy-recovery', 'gamepad-denial-usable-guidance', 'gamepad-denial-fresh-find', 'gamepad-denial-keyboard-return'],
    scope: 'Actual native Permissions-Policy refusal and fresh-page recovery; no physical gamepad, named assistive technology or full device qualification', pageErrors: errors, foreign }, null, 2));
  console.log(JSON.stringify({ output, policyResult, checks: 8 }));
} catch (error) {
  const observed = await page?.evaluate(() => ({ finePointer: matchMedia('(pointer: fine)').matches,
    headings: [...document.querySelectorAll('h1,h2,h3')].map(element => element.textContent), body: document.body.innerText.slice(0, 6000) })).catch(() => undefined);
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ sourceSha256, policyResult, pageErrors: errors, foreign, observed, error: String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
