import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { LocalHubServer } from '../packages/hub-server/src/index.ts';

const application = new URL(process.argv[2]);
if (application.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(application.hostname)
  || application.pathname !== '/' || application.search || application.hash) throw Error('Use a local application origin');
const files = ['app/Launcher.tsx', 'app/lib/session-id.ts', 'tools/qa-host-sessions.mjs'];
const hash = path => createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex');
const sourceSha256 = Object.fromEntries(files.map(path => [path, hash(path)]));
const hub = new LocalHubServer({ host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0 });
let browser;
try {
  const endpoint = await hub.start();
  browser = await chromium.launch();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const errors = [], foreign = [], rooms = [];
  async function open(context, pathname = '/', session) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const origin = new URL(route.request().url()).origin;
      if (origin !== application.origin && origin !== endpoint) { foreign.push(origin); return route.abort(); }
      return route.continue();
    });
    const target = new URL(pathname, application); target.searchParams.set('hub', endpoint);
    if (session) target.searchParams.set('session', session);
    await page.goto(target.toString()); await page.waitForLoadState('networkidle');
    if (pathname === '/') await page.getByRole('button', { name: 'Try a second-screen controller', exact: true }).click();
    const code = (await page.locator('.session-code strong').innerText()).trim();
    assert.match(code, /^[A-Z0-9-]{4,128}$/);
    return { page, code };
  }
  for (const context of contexts) {
    const { page, code } = await open(context); rooms.push(code);
    assert.equal(rooms.filter(room => room === code).length, 1, 'independent browser owners need distinct default rooms');
    await page.getByRole('button', { name: 'Check address', exact: true }).click();
    const connect = page.getByRole('button', { name: 'Connect', exact: true }); await connect.waitFor();
    await connect.focus(); await page.keyboard.press('Space');
    await page.getByText('Connected. The code below uses the address you selected.', { exact: true }).waitFor();
    await page.close();
  }
  const reloaded = await open(contexts[0]);
  assert.equal(reloaded.code, rooms[0], 'an owner keeps its room on document reload');
  await reloaded.page.close();
  const devices = await open(contexts[0], '/devices');
  assert.equal(devices.code, rooms[0], 'library and devices share the same owner room');
  await devices.page.close();
  const explicit = await open(contexts[0], '/', 'EXPLICIT-ROOM-101');
  assert.equal(explicit.code, 'EXPLICIT-ROOM-101', 'explicit valid URL room stays authoritative');
  await explicit.page.close();
  const navigation = await open(contexts[1], '/devices');
  const target = new URL('/', application);
  target.searchParams.set('hub', endpoint); target.searchParams.set('session', 'NAVIGATED-ROOM-101');
  await navigation.page.evaluate(async destination => {
    window.__hostSessionQaDocument = true;
    // Exercise Vinext's actual client navigation; opening another document misses cached hooks.
    const runtime = window[Symbol.for('vinext.navigationRuntime')];
    if (typeof runtime?.functions?.navigate !== 'function') throw Error('Client navigation unavailable');
    await runtime.functions.navigate(destination, 0, 'navigate', 'push');
  }, target.href);
  const trigger = navigation.page.getByRole('button', { name: 'Try a second-screen controller', exact: true });
  await trigger.waitFor(); await trigger.click();
  assert.equal((await navigation.page.locator('.session-code strong').innerText()).trim(), 'NAVIGATED-ROOM-101',
    'an explicit URL room wins after an earlier route resolved a different room');
  assert.equal(await navigation.page.evaluate(() => window.__hostSessionQaDocument), true, 'navigation kept the document');
  await navigation.page.close();
  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
  for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(path), pin);
  console.log(JSON.stringify({ result: 'pass', engine: browser.version(), sourceSha256,
    checks: ['independent-owner-rooms', 'real-selected-hub-connect', 'reload-room', 'shared-devices-room', 'explicit-url-room', 'explicit-client-navigation-room', 'zero-page-errors', 'zero-foreign-requests'] }, null, 2));
} finally { await browser?.close(); await hub.stop(); }
