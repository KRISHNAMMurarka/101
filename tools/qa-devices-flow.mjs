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
const featureRed = process.argv.includes('--feature-red'), enrollmentOnly = process.argv.includes('--enrollment-only') || process.argv.includes('--enrollment-feature-red');
const enrollmentRed = process.argv.includes('--enrollment-feature-red'), root = resolve(import.meta.dirname, '..');
const paths = ['app/devices/DevicesView.tsx', 'app/devices/device-inspection.ts', 'app/devices/device-inspection.test.ts', 'app/devices/devices.css', 'tools/qa-devices-flow.mjs',
  'app/lib/browser-link.ts', 'app/lib/host-endpoint-review.ts', 'app/components/HostConnectionReview.tsx', 'app/lib/local-capabilities.ts', 'app/lib/catalog.ts', 'app/lib/session-id.ts', 'app/controller/Controller.tsx', 'packages/protocol/src/index.ts', 'packages/session/src/index.ts', 'packages/input/src/index.ts', 'packages/adapter-camera/src/cameras.ts', 'packages/pairing/src/index.ts', 'packages/pairing/src/http-signaling.ts', 'packages/hub-server/src/index.ts'];
if (enrollmentOnly && !enrollmentRed) paths.push('app/devices/enrolled-device.ts', 'app/devices/enrolled-device.test.ts', 'app/devices/EnrolledDevices.tsx',
  'packages/device-web/src/index.ts', 'packages/device-web/src/authenticated-peer.ts', 'packages/device-web/src/binding.ts', 'packages/device-web/src/web-identity.ts',
  'packages/device-web/src/manual-peer.ts', 'packages/device-web/src/invitation.ts', 'packages/device-web/src/wire.ts',
  'packages/device-model/src/index.ts', 'packages/device-model/src/descriptor.ts', 'packages/device-model/src/remote-clock.ts',
  'packages/device-runtime/src/index.ts', 'packages/device-runtime/src/runtime.ts', 'packages/transport-webrtc/src/peer.ts');
const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const sourceSha256 = Object.fromEntries(paths.map(path => [path, hash(path)]));
const work = mkdtempSync(join(tmpdir(), '101-devices-flow-')), results = [];
let browser, hub;
async function keyboardActivate(page, locator) { await locator.click({ trial: true }); await locator.focus(); assert.ok(await locator.evaluate(element => element === document.activeElement)); await page.keyboard.press('Space'); }
async function noOverflow(page) { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'flow fits the viewport'); }
async function closedEndpoint() {
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return `http://127.0.0.1:${port}`;
}
async function enrollmentJourney() {
  for (const [engine, browserType] of Object.entries(enrollmentRed ? { chromium } : { chromium, webkit })) {
    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const errors = [], foreign = [], producers = [], checks = [];
    let phase = 'arrival';
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/*', route => new URL(route.request().url()).origin === application.origin ? route.continue() : (foreign.push(route.request().url()), route.abort()));
    const page = await context.newPage();
    async function source(invitation, label) {
      const producer = await context.newPage(); producers.push(producer);
      const fixturePage = new URL('/__101_owned_software_source__', application).toString();
      await producer.route(fixturePage, route => route.fulfill({ status: 200, contentType: 'text/html',
        body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned software source</title><body></body></html>' }));
      await producer.goto(fixturePage);
      const offer = await producer.evaluate(async ({ invitation, label }) => {
        // Actual public source entry; this source proof is not an installed-package qualification.
        const sdk = await import('/packages/device-web/src/index.ts');
        const { PeerDataTransport } = await import('/packages/transport-webrtc/src/index.ts');
        const target = sdk.decodeReceiverInvitation(invitation, Date.now());
        const identity = await sdk.createEphemeralWebIdentity(), peer = new PeerDataTransport({ initiator: true, iceServers: [] });
        const auth = new sdk.AuthenticatedResourcePeer({ transport: peer, identity, crypto: sdk.webEndpointCrypto, ...target,
          role: 'source', now: () => performance.now(), timeoutMs: 60000 });
        const descriptor = { schemaVersion: 1, id: `software-meter:${target.epoch}`, label, revision: 1,
          adapter: { id: 'owned:software-meter', version: '1.0.0' }, runtime: { platform: 'browser-timer-and-button' }, capabilities: [
            { id: 'level', semantic: 'software:counter', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
              value: { type: 'scalar', unit: '1', min: 0, max: 100 }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 } },
            { id: 'contact', semantic: 'software:contact', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
              value: { type: 'boolean' }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 } },
            { id: 'action', semantic: 'software:unavailable-action', schemaVersion: 1, kind: 'command', permissions: ['invoke'],
              value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 250 } },
          ] };
        const owned = { approved: false, stopped: false, contact: false, samples: 0, binds: 0, raw: new Set(), timer: undefined };
        const publisher = new sdk.RemoteResourcePublisher({ peer: auth, epoch: target.epoch, clockId: `owned-software:${target.epoch}`,
          now: () => performance.now(), device: descriptor, available: () => owned.approved && !owned.stopped });
        const detach = auth.onData((lane, bytes) => { const packet = sdk.decodePacket(bytes, lane); if (packet?.packet.type === 'bind') owned.binds++; });
        const sourceButton = document.createElement('button'); sourceButton.textContent = 'Approve software source publishing';
        const toggle = document.createElement('button'); toggle.textContent = 'Toggle software contact';
        const confirm = document.createElement('button'); confirm.textContent = 'Confirm owned source comparison';
        const approve = () => { owned.approved = true; }, change = () => { if (owned.approved && !owned.stopped) owned.contact = !owned.contact; };
        const confirmCode = () => { const digest = auth.status().comparisonDigest; if (digest) auth.confirmEnrollment(digest); };
        sourceButton.addEventListener('click', approve); toggle.addEventListener('click', change); confirm.addEventListener('click', confirmCode);
        document.body.replaceChildren(sourceButton, toggle, confirm);
        let started = false, last = -Infinity, counter = 0;
        function loop() {
          if (owned.stopped) return; const now = performance.now(); auth.tick();
          if (!started && auth.state === 'connected') started = publisher.start();
          if (started) {
            publisher.tick();
            if (owned.approved && now - last >= 100) {
              last = now; counter = (counter + 1) % 101;
              if (publisher.publish('level', counter, { capturedAt: now })) owned.samples++;
              publisher.publish('contact', owned.contact, { capturedAt: now });
            }
          }
          if (!owned.stopped) owned.timer = setTimeout(loop, 20);
        }
        const issued = operation => { const work = Promise.resolve().then(() => { if (owned.stopped) throw Error('Owned source stopped'); return operation(); });
          owned.raw.add(work); void work.then(() => owned.raw.delete(work), () => owned.raw.delete(work)); return work; };
        globalThis.__enrolledOwnedSource = { accept: answer => issued(() => peer.acceptAnswer(sdk.decodeManualPeerCode(answer, 'answer', target.epoch).description)),
          comparison: () => auth.status().comparisonDigest,
          metrics: () => ({ approved: owned.approved, samples: owned.samples, binds: owned.binds, publisher: publisher.status(), rawPending: owned.raw.size, state: peer.state, stopped: owned.stopped }),
          async stop() {
            if (!owned.stopped) { owned.stopped = true; clearTimeout(owned.timer); owned.timer = undefined;
              sourceButton.removeEventListener('click', approve); toggle.removeEventListener('click', change); confirm.removeEventListener('click', confirmCode);
              publisher.stop(); detach(); auth.stop(); await peer.disconnect(); }
            while (owned.raw.size) await Promise.allSettled([...owned.raw]);
            return { rawPending: owned.raw.size, timerArmed: owned.timer !== undefined, state: peer.state, stopped: owned.stopped, listeners: 0 };
          },
        };
        loop(); const offer = await issued(() => peer.createOffer()); return sdk.encodeManualPeerCode(target.epoch, offer);
      }, { invitation, label });
      return { page: producer, offer };
    }
    async function enroll(label, decline = false) {
      await keyboardActivate(page, page.getByRole('button', { name: 'Enroll resource device', exact: true }));
      const invitation = page.getByRole('textbox', { name: 'Receiver invitation', exact: true }); await invitation.waitFor();
      const created = await source(await invitation.inputValue(), label);
      await page.getByRole('textbox', { name: 'Complete resource offer', exact: true }).fill(created.offer);
      await keyboardActivate(page, page.getByRole('button', { name: 'Use resource offer', exact: true }));
      const answer = page.getByRole('textbox', { name: 'Receiver answer', exact: true }); await answer.waitFor();
      await created.page.evaluate(answer => globalThis.__enrolledOwnedSource.accept(answer), await answer.inputValue());
      // <output> has implicit status semantics; use its fixed accessible name rather than SDK globals.
      await page.locator('.devices-enrollment-digest').waitFor();
      const receiverDigest = (await page.locator('.devices-enrollment-digest').textContent()).replace(/\s/g, '');
      assert.match(receiverDigest, /^[0-9a-f]{64}$/);
      await created.page.waitForFunction(() => !!globalThis.__enrolledOwnedSource.comparison());
      assert.equal(await created.page.evaluate(() => globalThis.__enrolledOwnedSource.comparison()), receiverDigest);
      assert.equal((await created.page.evaluate(() => globalThis.__enrolledOwnedSource.metrics())).binds, 0, 'comparison/enrollment grants no resources');
      if (decline) {
        await keyboardActivate(page, page.getByRole('button', { name: 'Codes do not match', exact: true }));
        await created.page.waitForFunction(() => ['failed', 'disconnected'].includes(globalThis.__enrolledOwnedSource.metrics().state));
        return created.page;
      }
      await keyboardActivate(created.page, created.page.getByRole('button', { name: 'Confirm owned source comparison', exact: true }));
      await keyboardActivate(page, page.getByRole('button', { name: 'The complete codes match', exact: true }));
      await keyboardActivate(page, page.getByRole('button', { name: /^(Use enrolled resource device|Replace current resource device)$/ }));
      await page.getByRole('heading', { name: `Inspect ${label}`, exact: true }).waitFor();
      await page.getByRole('heading', { name: 'software:counter', exact: true }).waitFor();
      assert.equal(await page.getByRole('checkbox', { name: 'Preview software:unavailable-action', exact: true }).count(), 0);
      await page.getByRole('heading', { name: 'software:unavailable-action', exact: true }).waitFor();
      assert.equal(await page.locator('.devices-enrolled-value').count(), 0);
      await keyboardActivate(created.page, created.page.getByRole('button', { name: 'Approve software source publishing', exact: true }));
      return created.page;
    }
    async function approvePreview() {
      await page.getByRole('checkbox', { name: 'Preview software:counter', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Preview software:contact', exact: true }).check();
      await keyboardActivate(page, page.getByRole('button', { name: 'Approve selected input preview', exact: true }));
      await page.getByRole('status', { name: 'Preview value software:counter', exact: true }).waitFor();
    }
    try {
      await page.goto(new URL(`/devices?session=ENROLLED-${engine.toUpperCase()}`, application).toString());
      await page.getByRole('heading', { name: 'What is connected', exact: true }).waitFor();
      const add = page.getByRole('button', { name: 'Enroll resource device', exact: true });
      assert.equal(await add.count(), 1, 'the original Devices page is missing the owned enrollment/resource/removal task');
      assert.equal(enrollmentRed, false, 'feature absence RED stops before any producer or enrollment effect');
      assert.equal(await page.getByRole('textbox', { name: 'Receiver invitation', exact: true }).count(), 0);
      assert.equal(await page.locator('.devices-enrolled-value').count(), 0); checks.push('inert-arrival');
      phase = 'enrollment'; const first = await enroll('Owned software meter A'); checks.push('actual-native-rtc-bilateral-whole-digest-enrollment', 'declared-resources-not-authority', 'unsupported-command-recovery');
      phase = 'separate-preview'; await approvePreview();
      const metrics = await first.evaluate(() => globalThis.__enrolledOwnedSource.metrics()); assert.equal(metrics.binds, 2); assert.ok(metrics.samples > 0);
      await keyboardActivate(first, first.getByRole('button', { name: 'Toggle software contact', exact: true }));
      await page.waitForFunction(() => document.querySelector('[aria-label="Preview value software:contact"]')?.textContent === 'true');
      checks.push('separate-source-and-exact-two-resource-preview-approvals', 'actual-timer-and-native-button-software-values');
      phase = 'candidate-cancel'; await keyboardActivate(page, add); await page.getByRole('textbox', { name: 'Receiver invitation', exact: true }).waitFor();
      await keyboardActivate(page, page.getByRole('button', { name: 'Cancel enrollment', exact: true }));
      assert.equal(await page.getByRole('status', { name: 'Preview value software:contact', exact: true }).textContent(), 'true');
      assert.equal(await add.evaluate(element => element === document.activeElement), true); checks.push('candidate-cancel-retains-incumbent-and-focus');
      phase = 'enrolled-candidate-decline'; await enroll('Owned declined candidate', true);
      assert.equal(await page.getByRole('status', { name: 'Preview value software:contact', exact: true }).textContent(), 'true');
      assert.equal(await page.getByRole('heading', { name: 'Inspect Owned software meter A', exact: true }).count(), 1);
      checks.push('actual-native-candidate-comparison-decline-retains-incumbent');
      phase = 'invalid-offer'; await keyboardActivate(page, add); await page.getByRole('textbox', { name: 'Receiver invitation', exact: true }).waitFor();
      await page.getByRole('textbox', { name: 'Complete resource offer', exact: true }).fill('not a complete offer');
      await keyboardActivate(page, page.getByRole('button', { name: 'Use resource offer', exact: true }));
      await page.waitForFunction(() => document.querySelector('[data-enrollment-outcome]')?.getAttribute('data-enrollment-outcome') === 'invalid-offer');
      assert.equal(await page.getByRole('status', { name: 'Preview value software:contact', exact: true }).textContent(), 'true'); checks.push('invalid-offer-retains-current-values');
      phase = 'remove-cancel'; await keyboardActivate(page, page.getByRole('button', { name: 'Remove resource device', exact: true }));
      await keyboardActivate(page, page.getByRole('button', { name: 'Keep resource device', exact: true }));
      assert.equal(await page.getByRole('status', { name: 'Preview value software:contact', exact: true }).textContent(), 'true');
      assert.equal(await page.getByRole('button', { name: 'Remove resource device', exact: true }).evaluate(element => element === document.activeElement), true);
      checks.push('cancel-removal-retains-connection-preview-and-focus');
      phase = 'preview-stop'; await keyboardActivate(page, page.getByRole('button', { name: 'Stop input preview', exact: true }));
      assert.equal(await page.locator('.devices-enrolled-value').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Approve selected input preview', exact: true }).count(), 0);
      await first.waitForFunction(() => globalThis.__enrolledOwnedSource.metrics().publisher.active === 0);
      checks.push('terminal-preview-stop-releases-held-values-and-source-slots');
      phase = 'remove-confirm'; await keyboardActivate(page, page.getByRole('button', { name: 'Remove resource device', exact: true }));
      await keyboardActivate(page, page.getByRole('button', { name: 'Confirm resource removal', exact: true }));
      await page.getByText('Device removed. Its connection and previews are closed here.', { exact: true }).waitFor();
      await first.waitForFunction(() => ['failed', 'disconnected'].includes(globalThis.__enrolledOwnedSource.metrics().state));
      assert.equal(await page.getByRole('heading', { name: 'Inspect Owned software meter A', exact: true }).count(), 0); checks.push('confirmed-removal-actual-peer-loss-and-no-retained-values');
      phase = 'fresh-retry'; const second = await enroll('Owned software meter B'); assert.equal(await page.locator('.devices-enrolled-value').count(), 0);
      await approvePreview(); checks.push('fresh-retry-new-comparison-and-resource-approval');
      phase = 'quiet-expiry'; await page.getByText('Preview permission expired. Reconnect and approve again.', { exact: true }).waitFor({ timeout: 32000 });
      assert.equal(await page.locator('.devices-enrolled-value').count(), 0); await second.waitForFunction(() => globalThis.__enrolledOwnedSource.metrics().publisher.active === 0);
      checks.push('absolute-preview-expiry-without-new-approval-or-input-access');
      phase = 'source-loss'; await second.evaluate(() => globalThis.__enrolledOwnedSource.stop());
      await page.getByText('This device stopped responding. Check the other screen, then prepare a fresh invitation.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Confirm resource removal', exact: true }).count(), 0); checks.push('actual-source-loss-and-explicit-recovery');
      phase = 'viewports'; for (const width of [320, 390, 1280]) { await page.setViewportSize({ width, height: 844 }); await noOverflow(page); }
      const targets = await page.locator('.devices-enrolled button:not([disabled]), .devices-enrolled a').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0).map(element => ({ height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width })));
      assert.ok(targets.every(value => value.height >= 44 && value.width >= 44), 'enrollment task has native44px action targets');
      const reduced = await add.evaluate(element => ({ transition: getComputedStyle(element).transitionDuration, animation: getComputedStyle(element).animationName }));
      assert.deepEqual(reduced, { transition: '0s', animation: 'none' }); checks.push('keyboard-focus-responsive-reduced-motion');
      phase = 'explicit-stop'; const third = await enroll('Owned software meter C'); await approvePreview();
      await keyboardActivate(page, page.getByRole('button', { name: 'Stop resource connections', exact: true }));
      await third.waitForFunction(() => ['failed', 'disconnected'].includes(globalThis.__enrolledOwnedSource.metrics().state));
      assert.equal(await page.locator('.devices-enrolled-value').count(), 0);
      await add.click({ trial: true });
      assert.equal(await add.evaluate(element => element === document.activeElement), true);
      checks.push('explicit-stop-closes-current-peer-preview-and-restores-focus');
      phase = 'unmount'; const fourth = await enroll('Owned software meter D'); await approvePreview();
      await page.goto(new URL('/', application).toString());
      await fourth.waitForFunction(() => ['failed', 'disconnected'].includes(globalThis.__enrolledOwnedSource.metrics().state));
      checks.push('route-unmount-closes-owned-peer-and-preview');
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      results.push({ engine, version: browser.version(), checks, physical: false, source: 'authored browser software timer/button with native RTC/P256, not hardware inventory',
        limits: { peers: 'one current + one candidate', unsettledSetup: 1, resources: 4, previewMs: 30000, connectionMs: 60000 }, cleanup: [] });
    } catch (error) { console.error(JSON.stringify({ phase, engine, errors, foreign, producerCount: producers.length })); throw error; }
    finally {
      const cleanup = [];
      for (const producer of producers) if (!producer.isClosed()) {
        const settled = await producer.evaluate(() => globalThis.__enrolledOwnedSource?.stop());
        if (settled) { assert.deepEqual(settled, { rawPending: 0, timerArmed: false, state: 'disconnected', stopped: true, listeners: 0 }); cleanup.push(settled); }
      }
      if (results.at(-1)?.engine === engine) results.at(-1).cleanup = cleanup;
      await context.close(); await browser.close(); browser = undefined;
    }
  }
  for (const [path, pin] of Object.entries(sourceSha256)) assert.equal(hash(path), pin, 'candidate changed during enrollment proof');
  const receipt = { result: 'pass', profile: 'devices-enrolled-input-inspection/1', sourceSha256, results,
    scope: 'ephemeral whole-digest enrollment, actual owned software subscribe preview and removal; no persistent saved enrollment, read-only property/command/job/media operation, physical/hardware or account-owner qualification' };
  writeFileSync(join(work, 'enrollment-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, receipt: join(work, 'enrollment-receipt.json') }, null, 2));
}
if (enrollmentOnly) {
  try { await enrollmentJourney(); } finally { await browser?.close(); }
} else try {
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
