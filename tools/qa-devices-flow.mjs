import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium, webkit } from 'playwright';
import { LocalHubServer } from '../packages/hub-server/src/index.ts';

const application = new URL(process.argv[2]);
assert.ok(application.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(application.hostname) && application.pathname === '/' && !application.search && !application.hash,
  'Use the owned application at a fixed loopback origin');
const featureRed = process.argv.includes('--feature-red'), root = resolve(import.meta.dirname, '..');
const paths = ['app/devices/DevicesView.tsx', 'app/devices/device-inspection.ts', 'app/devices/device-inspection.test.ts', 'app/devices/devices.css', 'tools/qa-devices-flow.mjs',
  'app/lib/browser-link.ts', 'app/lib/host-endpoint-review.ts', 'app/components/HostConnectionReview.tsx', 'app/lib/local-capabilities.ts', 'app/lib/catalog.ts', 'app/lib/session-id.ts', 'app/controller/Controller.tsx', 'packages/protocol/src/index.ts', 'packages/session/src/index.ts', 'packages/input/src/index.ts', 'packages/adapter-camera/src/cameras.ts', 'packages/pairing/src/index.ts', 'packages/pairing/src/http-signaling.ts', 'packages/hub-server/src/index.ts'];
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const sourceSha256 = Object.fromEntries(paths.map(path => [path, hash(path)]));
const work = mkdtempSync(join(tmpdir(), '101-devices-flow-')), results = [];
let browser, hub;
async function keyboardActivate(page, locator) { await locator.waitFor(); await page.waitForFunction(element => !element.disabled, await locator.elementHandle()); await locator.focus(); assert.ok(await locator.evaluate(element => element === document.activeElement)); await page.keyboard.press('Space'); }
async function noOverflow(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'flow fits the viewport'); }
async function closedEndpoint() {
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return `http://127.0.0.1:${port}`;
}
try {
  for (const [engine, browserType] of Object.entries(featureRed ? { chromium } : { chromium, webkit })) {
    hub = new LocalHubServer({ host: '127.0.0.1', advertisedHost: '127.0.0.1', port: 0 });
    const endpoint = await hub.start(); assert.equal((await fetch(endpoint + '/v1/health')).status, 200);
    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const errors = [], foreign = [], requests = [], controlSent = [];
    let missingEndpoint;
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (![application.origin, endpoint, missingEndpoint].includes(url.origin)) { foreign.push(url.origin); return route.abort(); }
      if (url.origin !== application.origin) requests.push({ method: route.request().method(), path: url.pathname });
      return route.continue();
    });
    const page = await context.newPage(), room = `DEVICE-FLOW-${engine.toUpperCase()}`;
    const target = new URL('/devices', application); target.searchParams.set('hub', endpoint); target.searchParams.set('session', room);
    await page.goto(target.toString()); await page.getByRole('heading', { name: 'What is connected', exact: true }).waitFor();
    if (engine === 'chromium') {
      // Set actual native permissions on this disposable context; never replace an API getter/provider.
      const cdp = await context.newCDPSession(page), { targetInfo } = await cdp.send('Target.getTargetInfo');
      for (const name of ['camera', 'clipboard-write']) await cdp.send('Browser.setPermission', { permission: { name }, setting: 'denied', origin: application.origin, browserContextId: targetInfo.browserContextId });
      // Keep the owned session alive: Chromium retires these overrides when it detaches.
    }
    const find = page.getByRole('button', { name: 'Find connected devices', exact: true });
    assert.equal(await find.count(), 1, 'actual local Devices screen needs explicit discovery and inspect recovery');
    assert.equal(featureRed, false, 'RED mode is only for the original missing device flow');
    await page.waitForTimeout(200); assert.equal(requests.length, 0, 'arrival does not contact the hinted Hub');
    assert.equal(await page.getByRole('textbox', { name: 'Connection address' }).count(), 0, 'Add opens the connection task');
    await keyboardActivate(page, find);
    await page.getByText('No connected devices found yet. Keep this room open on the other device, or add a device.', { exact: true }).waitFor();
    assert.equal(requests.length, 0, 'passive room discovery does not contact unreviewed addresses');
    await keyboardActivate(page, page.getByRole('button', { name: 'Stop looking', exact: true }));
    await page.getByText('Stopped looking. Find devices again when you’re ready.', { exact: true }).waitFor();
    await keyboardActivate(page, find);

    // Genuine existing controller producer in a different tab and wrong selected room.
    const wrong = await context.newPage(); await wrong.goto(new URL(`/controller?session=WRONG-${engine.toUpperCase()}`, application).toString());
    await wrong.waitForFunction(() => sessionStorage.getItem('101-link-device-id'));
    await page.waitForTimeout(1800); assert.equal(await page.locator('.devices-flow-list > li').count(), 0, 'other rooms never populate this list');
    await wrong.close();
    const controller = await context.newPage(); await controller.goto(new URL(`/controller?session=${room}`, application).toString());
    await page.getByRole('heading', { name: '101 Link browser controller', exact: true }).waitFor();
    assert.equal(await page.locator('.devices-flow-list > li').count(), 1);
    await keyboardActivate(page, page.getByRole('button', { name: 'Inspect 101 Link browser controller', exact: true }));
    await page.getByRole('heading', { name: 'Inspect 101 Link browser controller', exact: true }).waitFor();
    assert.equal(await page.locator('#devices-inspect-title').evaluate(element => element === document.activeElement), true);
    await page.getByText('Reported by this controller. Choose an application before using it.', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('Input received', { exact: true }).count(), 0, 'hello metadata alone cannot claim input activity');
    await keyboardActivate(page, page.getByRole('button', { name: 'Back to devices', exact: true }));
    assert.equal(await page.getByRole('button', { name: 'Inspect 101 Link browser controller', exact: true }).evaluate(element => element === document.activeElement), true);

    // A real public protocol software producer, not a simulated hardware provider.
    const producer = await context.newPage(); await producer.goto(new URL('/devices?session=FIXTURE-SOFTWARE', application).toString());
    await producer.evaluate(async room => {
      const { BroadcastChannelTransport } = await import('/packages/protocol/src/index.ts');
      const port = new BroadcastChannelTransport(room); await port.connect(); globalThis.__ownedInspectionPort = port;
      port.onMessage(message => { (globalThis.__receivedControls ??= []).push(message.channel === 'control' ? message.payload.type : 'realtime'); });
      port.sendReliable({ type: 'hello', version: 2, deviceId: 'local-device', device: 'Owned software metadata', capabilities: { camera: true } });
    }, room);
    await page.getByRole('heading', { name: 'Owned software metadata', exact: true }).waitFor();
    await keyboardActivate(page, page.getByRole('button', { name: 'Inspect Owned software metadata', exact: true }));
    await page.getByRole('heading', { name: 'Inspect Owned software metadata', exact: true }).waitFor();
    await page.getByText('This controller does not send camera input to this screen. Use this screen’s camera setup in an application.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Inputs not identified. These are connection details, not a device identity check or permission to control an application.', { exact: true }).count(), 1);
    await producer.evaluate(() => globalThis.__ownedInspectionPort.sendRealtime({ deviceId: 'local-device', playerId: 'software-fixture', sequence: 1, timestamp: performance.now(), source: 'custom', actions: { trigger: false }, axes: {}, vectors: {} }));
    await page.getByText('A valid input report arrived recently. This does not grant an application permission.', { exact: true }).waitFor();
    await page.getByText('Input received. These are connection details, not a device identity check or permission to control an application.', { exact: true }).waitFor();
    await page.waitForTimeout(2300);
    assert.equal(await page.getByText('A valid input report arrived recently. This does not grant an application permission.', { exact: true }).count(), 0, 'quiet input activity expires');
    controlSent.push(...await producer.evaluate(() => globalThis.__receivedControls ?? []));
    assert.deepEqual(controlSent.filter(type => !['hello', 'ping'].includes(type)), [], 'inspection never sends roles or resource commands; genuine other controllers may announce themselves');
    await producer.evaluate(() => globalThis.__ownedInspectionPort.disconnect()); await producer.close();
    await keyboardActivate(page, page.getByRole('button', { name: 'Back to devices', exact: true }));

    // Native browser permission state is read without a permission prompt or a fake camera.
    await keyboardActivate(page, page.getByRole('button', { name: 'Inspect this computer', exact: true }));
    await page.getByRole('button', { name: 'Refresh inputs', exact: true }).waitFor();
    if (engine === 'chromium') await page.getByText('Camera access is blocked here. Review this site’s browser permissions or choose another input.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Input received', { exact: true }).count(), 0);
    const permission = await page.evaluate(async () => { try { return (await navigator.permissions.query({ name: 'camera' })).state; } catch { return 'query-unavailable'; } });
    await noOverflow(page); await page.screenshot({ path: join(work, `${engine}-local-inspection.png`), fullPage: true });
    await keyboardActivate(page, page.getByRole('button', { name: 'Back to devices', exact: true }));

    const add = page.getByRole('button', { name: 'Add a device', exact: true }); await keyboardActivate(page, add);
    assert.equal(await page.locator('#devices-add-title').evaluate(element => element === document.activeElement), true);
    const address = page.getByRole('textbox', { name: 'Connection address', exact: true }); await address.waitFor();
    await page.waitForFunction(endpoint => [...document.querySelectorAll('input[type=url]')].some(element => element.value === endpoint), endpoint);
    assert.equal(await address.inputValue(), endpoint); assert.equal(requests.length, 0, 'opening Add still requires address review');
    missingEndpoint = await closedEndpoint(); await address.fill(missingEndpoint);
    await keyboardActivate(page, page.getByRole('button', { name: 'Check address', exact: true }));
    await page.getByText('Couldn’t check this address. Check that the connection service is running, or choose another address.', { exact: true }).waitFor();
    await address.fill(endpoint); await keyboardActivate(page, page.getByRole('button', { name: 'Check address', exact: true }));
    await keyboardActivate(page, page.getByRole('button', { name: 'Connect', exact: true }));
    const invitation = page.getByRole('textbox', { name: 'Connection link', exact: true }); await invitation.waitFor();
    const link = await invitation.inputValue(); const parsed = new URL(link); assert.equal(parsed.origin, application.origin); assert.equal(parsed.searchParams.get('session'), room);
    const invited = await context.newPage(); await invited.goto(link); await invited.getByRole('heading', { name: 'Connect to this host?', exact: true }).waitFor();
    const beforeJoin = requests.filter(value => value.method === 'POST' && value.path.endsWith('/peers')).length;
    await keyboardActivate(invited, invited.getByRole('button', { name: 'Connect', exact: true }));
    await invited.waitForFunction(() => !document.querySelector('#pairing-review-title'));
    await page.waitForFunction(() => document.querySelectorAll('.devices-flow-list > li').length === 3, undefined, { timeout: 10000 });
    assert.ok(requests.filter(value => value.method === 'POST' && value.path.endsWith('/peers')).length > beforeJoin, 'reviewed public controller uses the actual selected Hub');
    await keyboardActivate(page, page.getByRole('button', { name: 'Copy link', exact: true }));
    let clipboard;
    if (engine === 'chromium') {
      await page.getByText('Copy wasn’t available. Select the link and copy it yourself.', { exact: true }).waitFor();
      assert.equal(await invitation.evaluate(element => element === document.activeElement), true); clipboard = 'native-permission-denied-recovery';
    } else {
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(element => element.textContent === 'Copied') || document.body.textContent.includes('Copy wasn’t available.'));
      clipboard = await page.getByRole('button', { name: 'Copied', exact: true }).count() ? 'native-write-returned' : 'native-unavailable-recovery';
    }
    await noOverflow(page);
    for (const width of [320, 1280]) { await page.setViewportSize({ width, height: 900 }); await noOverflow(page); }
    await page.setViewportSize({ width: 390, height: 844 });
    const controls = await page.locator('.devices-flow button:not([disabled]), .devices-flow a, .devices-flow input:not([type=radio])').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0).map(element => ({ height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width })));
    assert.ok(controls.every(value => value.height >= 44 && value.width >= 44), 'reachable flow controls meet the44px target');
    const reduced = await page.getByRole('button', { name: 'Add a device', exact: true }).evaluate(element => ({ transition: getComputedStyle(element).transitionDuration, animation: getComputedStyle(element).animationName }));
    assert.deepEqual(reduced, { transition: '0s', animation: 'none' });
    await invitation.evaluate(element => { element.value = '[disposable invitation omitted from screenshot]'; });
    await page.screenshot({ path: join(work, `${engine}-add-device.png`), fullPage: true });
    await keyboardActivate(page, page.getByRole('button', { name: 'Back to devices', exact: true }));
    await controller.close(); await invited.close();
    await page.waitForTimeout(6500); await page.getByText('Not responding', { exact: true }).first().waitFor();
    const retry = await context.newPage(); await retry.goto(new URL(`/controller?session=${room}`, application).toString());
    await page.waitForFunction(() => [...document.querySelectorAll('.devices-flow-list li p')].some(element => ['Some inputs need setup', 'Inputs reported'].includes(element.textContent))); await retry.close();
    await context.setOffline(true); await page.getByText('You’re offline. You can inspect local inputs. Reconnect, then find devices again.', { exact: true }).waitFor();
    await context.setOffline(false); await page.getByText('Stopped looking. Find devices again when you’re ready.', { exact: true }).waitFor();
    await keyboardActivate(page, find); await page.getByRole('button', { name: 'Stop looking', exact: true }).waitFor();
    await keyboardActivate(page, page.getByRole('button', { name: 'Stop looking', exact: true }));
    await page.screenshot({ path: join(work, `${engine}-offline-recovery.png`), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
    results.push({ engine, version: browser.version(), permission, clipboard, checks: ['inert-arrival-and-add', 'explicit-find-no-results', 'stop-retry', 'actual-separate-controller-tab', 'wrong-room-excluded', 'reported-input-is-unchecked', 'unknown-and-unsupported-software-metadata', 'opaque-id-not-local-identity', 'actual-software-input-observed-and-expires', 'zero-role-and-command-emissions', 'native-permission-inspection', 'missing-hub-recovery', 'selected-hub-ticket-and-controller-review', 'native-clipboard-result-or-recovery', 'quiet-device-offline', 'controller-reappears', 'browser-offline-requires-explicit-retry', 'keyboard-and-return-focus', '320-390-1280-no-overflow', '44px-controls', 'reduced-motion', 'zero-page-errors-and-foreign-requests'], requests: requests.length, screenshots: ['local-inspection', 'add-device', 'offline-recovery'].map(name => join(work, `${engine}-${name}.png`)) });
    await context.close(); await browser.close(); browser = undefined; await hub.stop(); hub = undefined;
  }
  for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(path), pin, 'candidate changed during proof');
  const receipt = { result: 'pass', profile: 'devices-add-inspect/1', scope: 'real source-bound Devices/Controller browser UI and local Hub; software protocol metadata/input and native browser permission states; no native/phone/hardware discovery, authenticated endpoint identity, resource grants or physical input qualification', sourceSha256, results };
  writeFileSync(join(work, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ ...receipt, receipt: join(work, 'receipt.json') }, null, 2));
} finally { await browser?.close(); await hub?.stop(); }
