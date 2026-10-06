import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { LocalHubServer } from '../packages/hub-server/src/index.ts';
import { encodePairingTicket } from '../packages/protocol/src/index.ts';

const application = new URL(process.argv[2]);
if (application.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(application.hostname) || application.pathname !== '/' || application.search || application.hash)
  throw Error('Use the current local application at an explicit loopback origin');
const work = mkdtempSync(join(tmpdir(), '101-pairing-intake-'));
const root = resolve(import.meta.dirname, '..');
const sourcePaths = [
  'app/controller/Controller.tsx', 'app/controller/controller-route.ts',
  'packages/protocol/src/index.ts', 'packages/pairing/src/index.ts',
  'packages/pairing/src/http-signaling.ts', 'packages/pairing/src/intake.ts',
  'apps/controller-native/App.tsx', 'apps/controller-native/src/pairing-code.ts',
  'apps/controller-native/src/controller-session.ts', 'app/lib/browser-link.ts',
  'app/lib/host-endpoint-review.ts', 'app/components/HostConnectionReview.tsx',
  'app/Launcher.tsx', 'app/devices/DevicesView.tsx', 'app/components/PreGame.tsx', 'tools/qa-pairing-intake.mjs',
];
const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
const results = [];
let browser;
const hub = new LocalHubServer({ host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0 });
try {
  const endpoint = await hub.start();
  for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const pageErrors = [], requests = [], foreign = [], replies = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', async response => {
      if (new URL(response.url()).origin === endpoint && response.request().method() === 'POST') {
        const body = await response.json().catch(() => ({}));
        replies.push({ status: response.status(), error: body.error, sessionId: body.ticket?.sessionId, endpoint: body.ticket?.endpoint });
      }
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== application.origin && url.origin !== endpoint) { foreign.push(url.origin); return route.abort(); }
      if (url.origin === endpoint) requests.push({ method: route.request().method(), path: url.pathname });
      return route.continue();
    });
    const sessionId = `INTAKE-${engine.toUpperCase()}`;
    const created = hub.createSession(sessionId, { hostName: 'Reviewed local game' });
    const code = encodePairingTicket(created.ticket);
    const target = new URL('/controller', application);
    target.searchParams.set('session', 'UNRELATED-ROOM');
    target.searchParams.set('pair', code);
    await page.goto(target.toString());
    await page.getByRole('heading', { name: 'Connect to this host?' }).waitFor();
    assert.equal(requests.length, 0, 'opening a ticket is inert');
    assert.equal(await page.getByText(endpoint, { exact: true }).count(), 1);
    const connect = page.getByRole('button', { name: 'Connect', exact: true });
    const bounds = await connect.boundingBox();
    assert.ok(bounds?.height >= 44, 'native connection target is at least44px');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(requests.length, 0, 'cancelled review has no network effect');
    await page.reload();
    await page.getByRole('heading', { name: 'Connect to this host?' }).waitFor();
    await connect.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('#pairing-review-title'));
    await page.waitForTimeout(100);
    for (let attempt = 0; attempt < 25 && !requests.some(r => r.method === 'POST' && r.path.endsWith('/peers')); attempt++) await page.waitForTimeout(100);
    assert.ok(requests.some(r => r.method === 'POST' && r.path === `/v1/sessions/${sessionId}/peers`), 'explicit native keyboard approval joins the reviewed ticket session');
    assert.ok(!requests.some(r => r.path.includes('UNRELATED-ROOM')), 'URL room cannot retarget the reviewed ticket');
    const other = hub.createSession(`HISTORY-${engine.toUpperCase()}`, { hostName: 'Other reviewed game' });
    const otherTarget = new URL('/controller', application); otherTarget.searchParams.set('pair', encodePairingTicket(other.ticket));
    const approvedJoins = requests.filter(request => request.method === 'POST' && request.path.endsWith('/peers')).length;
    // Seed the other history entry without notifying React, then exercise genuine Back/Forward events.
    await page.evaluate(url => history.pushState({}, '', url), otherTarget.toString());
    await page.goBack(); await page.goForward();
    await page.getByText('Other reviewed game', { exact: true }).waitFor();
    await page.goBack();
    await page.getByRole('heading', { name: 'Connect to this host?' }).waitFor();
    await page.waitForTimeout(200);
    assert.equal(requests.filter(request => request.method === 'POST' && request.path.endsWith('/peers')).length, approvedJoins,
      'Back to a previously approved URL never restores connection authority');
    await connect.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('#pairing-review-title'));
    await page.getByText('Connect to a game', { exact: true }).click();
    await page.getByRole('button', { name: 'STOP CONNECTION', exact: true }).click();
    await page.waitForTimeout(300);
    const settled = requests.length;
    await page.waitForTimeout(900);
    assert.equal(requests.length, settled, 'stop cancels pending polling and timers');
    const invalid = new URL('/controller', application);
    invalid.searchParams.append('pair', code);
    invalid.searchParams.append('pair', code);
    await page.goto(invalid.toString());
    await page.waitForLoadState('networkidle');
    await page.getByRole('heading', { name: 'Connect to this host?' }).waitFor({ state: 'hidden' });
    await page.waitForTimeout(200);
    assert.equal(requests.length, settled, 'duplicate URL ticket never dispatches');
    await page.getByText('Connect to a game', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Connection link', exact: true }).fill(code);
    await page.getByRole('button', { name: 'REVIEW CONNECTION', exact: true }).click();
    await page.getByRole('heading', { name: 'Connect to this host?' }).waitFor();
    assert.equal(requests.length, settled, 'paste recovery still requires review');
    await page.screenshot({ path: join(work, `${engine}-review.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const hostSurfaces = [];
    for (const [path, opener] of [['/', 'Try a second-screen controller'], ['/devices', 'Add a device'], ['/games/echomaze', 'Connect a phone']]) {
      const hostTarget = new URL(path, application); hostTarget.searchParams.set('hub', endpoint);
      hostTarget.searchParams.set('session', `HOST-${engine.toUpperCase()}-${hostSurfaces.length}`);
      const before = requests.length;
      await page.goto(hostTarget.toString());
      await page.waitForLoadState('networkidle');
      if (opener) await page.getByRole('button', { name: opener, exact: true }).click();
      const address = page.getByRole('textbox', { name: 'Connection address', exact: true });
      await address.waitFor(); await page.waitForTimeout(100);
      assert.equal(requests.length, before, `${path}: hints and showing review are inert`);
      assert.equal(await address.inputValue(), endpoint);
      const check = page.getByRole('button', { name: 'Check address', exact: true });
      const checkBounds = await check.boundingBox(); assert.ok(checkBounds?.height >= 44);
      await check.focus(); await page.keyboard.press('Space');
      const approve = page.getByRole('button', { name: 'Connect', exact: true }); await approve.waitFor();
      assert.ok(requests.slice(before).every(request => request.method === 'GET' && request.path === '/v1/health'), 'checking only reads selected health');
      assert.equal(await page.getByText(`Phone page: ${application.origin}. Select a network address for a different device.`, { exact: true }).count(), 1);
      await approve.focus(); await page.keyboard.press('Space');
      await page.getByText('Connected. The code below uses the address you selected.', { exact: true }).waitFor({ timeout: 8000 }).catch(async () => {
        throw new Error(JSON.stringify({ engine, path, statuses: await page.getByRole('status').allTextContents(), requests: requests.slice(before), replies, pageErrors }));
      });
      assert.ok(requests.slice(before).some(request => request.method === 'POST' && request.path === '/v1/sessions'), 'only approved selected service creates or resumes pairing');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(work, `${engine}-host-${hostSurfaces.length}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Change address', exact: true }).click();
      assert.equal(await address.evaluate(element => element === document.activeElement), true, 'change address restores focus');
      hostSurfaces.push(path);
    }
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(foreign, []);
    results.push({ engine, version: browser.version(), hostSurfaces, checks: ['inert-arrival', 'inert-cancel', 'native-keyboard-approval', 'selected-session-only', 'history-needs-fresh-approval', 'stop-polling', 'duplicate-link-denied', 'paste-recovery-review', '390px-no-overflow', '44px-control', 'three-inert-host-surfaces', 'read-only-health-review', 'explicit-host-connect', 'host-change-address-focus', 'zero-page-errors', 'zero-foreign-requests'], screenshot: join(work, `${engine}-review.png`) });
    await context.close();
    await browser.close();
    browser = undefined;
  }
  for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'), pin, 'candidate remained unchanged');
  console.log(JSON.stringify({ result: 'pass', scope: 'actual local Controller and three host UI surfaces with a real disposable Hub; browser-generated keyboard input; no native/phone/cryptographic legacy endpoint qualification', sourceSha256, results }, null, 2));
} finally {
  await browser?.close();
  await hub.stop();
}
