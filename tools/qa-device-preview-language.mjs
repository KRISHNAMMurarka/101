import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const origin = args.find(value => value.startsWith('http://')) ?? '';
const engine = args.find(value => value.startsWith('--engine='))?.slice('--engine='.length) ?? 'chromium';
const runId = args.find(value => value.startsWith('--run-id='))?.slice('--run-id='.length) ?? `${engine}-${Date.now()}-${process.pid}`;
const output = resolve(root, 'outputs/controllers/2026-10-16-device-preview-language');
const parsedOrigin = new URL(origin);
assert.equal(parsedOrigin.origin, origin, 'Use a canonical loopback origin');
assert.equal(parsedOrigin.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsedOrigin.hostname), 'Origin must be loopback-only');
assert.ok(Number(parsedOrigin.port) > 0 && Number(parsedOrigin.port) <= 65535, 'Use the owned ephemeral server port');
assert.ok(engine === 'chromium' || engine === 'webkit', 'Choose chromium or webkit');
assert.match(runId, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/, 'Output run ID must be a safe unique filename');
mkdirSync(output, { recursive: true });

const sourcePaths = [
  'app/devices/enrolled-device.ts', 'app/devices/EnrolledDevices.tsx', 'app/devices/enrolled-device.test.ts',
  'packages/device-web/src/index.ts', 'packages/device-web/src/authenticated-peer.ts', 'packages/device-web/src/binding.ts',
  'packages/device-web/src/web-identity.ts', 'packages/device-web/src/invitation.ts', 'packages/device-web/src/manual-peer.ts',
  'packages/transport-webrtc/src/index.ts', 'packages/transport-webrtc/src/peer.ts',
  'packages/device-model/src/index.ts', 'packages/device-model/src/descriptor.ts', 'packages/device-model/src/sample.ts',
  'dist/server/index.js',
];
const sha256 = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const sourceSha256 = Object.fromEntries(sourcePaths.map(path => [path, sha256(path)]));
const sourceFencePaths = sourcePaths.filter(path => path !== 'dist/server/index.js');
const sourceSha256Before = Object.fromEntries(sourceFencePaths.map(path => [path, sha256(path)]));
const buildSha256Before = sha256('dist/server/index.js');

// Bundle the real public SDK source in memory. The browser producer uses real WebRTC,
// P-256 endpoint proof, descriptor validation, and resource publisher/receiver codecs.
const fixtureSource = `
import { AuthenticatedResourcePeer, RemoteResourcePublisher, createEphemeralWebIdentity,
  decodeReceiverInvitation, decodeManualPeerCode, encodeManualPeerCode, webEndpointCrypto } from '@101/device-web';
import { PeerDataTransport } from '@101/transport-webrtc';
import { parseDeviceDescriptor } from '@101/device-model';
import { decodePacket } from '@101/device-web';
globalThis.__ownedDeviceLanguageFixture = {
  decodeBind: (bytes, lane) => { try { return decodePacket(bytes, lane)?.packet?.type === 'bind'; } catch { return false; } },
  encodeOffer: (epoch, value) => encodeManualPeerCode(epoch, value),
  decodeAnswer: (value, epoch) => decodeManualPeerCode(value, 'answer', epoch).description,
  async create(invitationText) {
    const invitation = decodeReceiverInvitation(invitationText, Date.now());
    const peer = new PeerDataTransport({ initiator: true, iceServers: [] });
    const auth = new AuthenticatedResourcePeer({ transport: peer, identity: await createEphemeralWebIdentity(),
      crypto: webEndpointCrypto, ...invitation, role: 'source', now: () => performance.now(), timeoutMs: 60000 });
    const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'software-preview-source', label: 'Software input source', revision: 1,
      adapter: { id: 'owned:software-preview', version: '1.0.0' }, runtime: { platform: 'browser-software-fixture' }, capabilities: [
        { id: 'switch', semantic: 'app:pointer-contact/1', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
          value: { type: 'boolean' }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 500 } },
        { id: 'level', semantic: 'example:level', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
          value: { type: 'scalar', unit: 'Cel', min: -100, max: 100 }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 500 } },
        { id: 'position', semantic: 'app:pointer-position/1', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
          value: { type: 'vector', unit: 'm', frame: 'screen', components: ['x', 'y'], min: -10, max: 10 },
          delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 500 } },
      ] });
    const state = { approved: false, stopped: false, values: { switch: false, level: 21.5, position: { x: 0.5, y: 0.25 } },
      sent: 0, binds: 0, timer: undefined };
    const publisher = new RemoteResourcePublisher({ peer: auth, epoch: invitation.epoch, clockId: 'owned-device-preview-clock',
      now: () => performance.now(), device, available: () => state.approved && !state.stopped });
    const detach = auth.onData((lane, bytes) => {
      const decoded = globalThis.__ownedDeviceLanguageFixture.decodeBind?.(bytes, lane);
      if (decoded) state.binds++;
    });
    const approve = document.createElement('button'); approve.textContent = 'Approve software source publishing';
    approve.addEventListener('click', () => { state.approved = true; });
    const turnOn = document.createElement('button'); turnOn.textContent = 'Set software switch on';
    turnOn.addEventListener('click', () => { state.values.switch = true; });
    const turnOff = document.createElement('button'); turnOff.textContent = 'Set software switch off';
    turnOff.addEventListener('click', () => { state.values.switch = false; });
    document.body.replaceChildren(approve, turnOn, turnOff);
    let started = false, last = -Infinity;
    const loop = () => {
      if (state.stopped) return;
      const now = performance.now(); auth.tick();
      if (!started && auth.state === 'connected') started = publisher.start();
      if (started) {
        publisher.tick();
        if (state.approved && now - last >= 100) {
          last = now;
          for (const [id, value] of Object.entries(state.values)) if (publisher.publish(id, value, { capturedAt: now })) state.sent++;
        }
      }
      if (!state.stopped) state.timer = setTimeout(loop, 20);
    };
    loop();
    const offer = await peer.createOffer();
    globalThis.__ownedDeviceLanguageFixture.current = {
      async accept(answerText) {
        const answer = globalThis.__ownedDeviceLanguageFixture.decodeAnswer(answerText, invitation.epoch);
        await peer.acceptAnswer(answer);
        return auth.status().comparisonDigest;
      },
      digest: () => auth.status().comparisonDigest,
      confirm: digest => auth.confirmEnrollment(digest),
      approveButton: () => approve.click(),
      setSwitch: value => { state.values.switch = value; },
      metrics: () => ({ ...publisher.status(), sent: state.sent, binds: state.binds, peer: peer.state, stopped: state.stopped }),
      async stop() {
        if (!state.stopped) { state.stopped = true; clearTimeout(state.timer); state.timer = undefined;
          approve.removeEventListener('click', () => {}); publisher.stop(); detach(); auth.stop(); await peer.disconnect(); }
        return this.metrics();
      },
    };
    return globalThis.__ownedDeviceLanguageFixture.encodeOffer(invitation.epoch, offer);
  },
};`;

const entry = fixtureSource;
const bundled = await build({ configFile: false, root, logLevel: 'error',
  plugins: [{ name: 'memory-device-preview-fixture', resolveId(id) { return id === 'virtual:device-preview' ? '\0device-preview' : undefined; },
    load(id) { return id === '\0device-preview' ? entry : undefined; } }],
  build: { write: false, minify: false, lib: { entry: 'virtual:device-preview', name: 'DevicePreviewFixture', formats: ['iife'] },
    rollupOptions: { input: 'virtual:device-preview' } },
});
const bundle = bundled[0]?.output.find(item => item.type === 'chunk')?.code;
assert.ok(bundle && bundle.length <= 1024 * 1024, 'bounded in-memory public SDK producer bundle');

let browser, sourcePage, page;
const report = { result: 'not-run', profile: 'authenticated-device-primitive-preview-language/1', origin,
  node: process.version, engine, browser: undefined, sourceSha256, publisherBundleSha256: createHash('sha256').update(bundle).digest('hex'),
  fenceBefore: { sourceSha256: sourceSha256Before, buildSha256: buildSha256Before },
  observed: {}, checks: [], cleanup: { sourceStopped: false, sourcePageClosed: false, receiverPageClosed: false, browserClosed: false } };
try {
  browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true }); report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  page = await context.newPage(); await page.goto(`${origin}/devices?session=DEVICE-PREVIEW-LANGUAGE`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'What is connected', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pair a device', exact: true }).click();
  const invitationBox = page.getByRole('textbox', { name: 'Pairing invitation', exact: true }); await invitationBox.waitFor();
  sourcePage = await context.newPage(); await sourcePage.goto(`${origin}/devices?session=SOFTWARE-PUBLISHER`, { waitUntil: 'networkidle' });
  await sourcePage.addScriptTag({ content: bundle });
  const offer = await sourcePage.evaluate(invitation => globalThis.__ownedDeviceLanguageFixture.create(invitation), await invitationBox.inputValue());
  await page.getByRole('textbox', { name: 'Complete device reply', exact: true }).fill(offer);
  await page.getByRole('button', { name: 'Use device reply', exact: true }).click();
  const answerBox = page.getByRole('textbox', { name: 'Pairing answer', exact: true }); await answerBox.waitFor();
  await sourcePage.evaluate(answer => globalThis.__ownedDeviceLanguageFixture.current.accept(answer), await answerBox.inputValue());
  const digest = await sourcePage.waitForFunction(() => globalThis.__ownedDeviceLanguageFixture.current.digest(), undefined, { timeout: 10000 });
  const sourceDigest = await digest.jsonValue(); assert.match(sourceDigest, /^[0-9a-f]{64}$/);
  await page.getByRole('button', { name: 'The complete codes match', exact: true }).waitFor();
  const shownDigest = (await page.getByLabel('Complete connection code', { exact: true }).textContent()).replace(/\s/g, '');
  assert.equal(shownDigest, sourceDigest, 'actual independent endpoint comparison');
  assert.equal(await sourcePage.evaluate(value => globalThis.__ownedDeviceLanguageFixture.current.confirm(value), sourceDigest), true);
  await page.getByRole('button', { name: 'The complete codes match', exact: true }).click();
  await page.getByRole('button', { name: 'Use this device', exact: true }).click();
  for (const name of ['On/off input', 'Number input', 'Multi-value input'])
    await page.getByRole('heading', { name, exact: true }).waitFor();
  assert.equal((await sourcePage.evaluate(() => globalThis.__ownedDeviceLanguageFixture.current.metrics())).active, 0,
    'pairing and resource description grant no preview access');
  report.checks.push('real-webRTC-p256-endpoint-proof', 'independent-whole-digest-confirmation', 'descriptor-validation', 'no-resource-access-before-preview-approval');

  await sourcePage.getByRole('button', { name: 'Approve software source publishing', exact: true }).click();
  assert.equal((await sourcePage.evaluate(() => globalThis.__ownedDeviceLanguageFixture.current.metrics())).active, 0,
    'source publishing approval alone does not create receiver resource slots');
  report.checks.push('source-publication-owner-approval-alone-grants-no-receiver-preview');
  for (const name of ['Preview On/off input', 'Preview Number input', 'Preview Multi-value input'])
    await page.getByRole('checkbox', { name, exact: true }).check();
  await page.getByRole('button', { name: 'Approve selected input preview', exact: true }).click();
  const outputFor = label => page.getByRole('status', { name: `Preview value ${label}`, exact: true });
  await page.waitForFunction(() => {
    const labels = ['On/off input', 'Number input', 'Multi-value input'];
    return labels.every(label => document.querySelector(`[aria-label="Preview value ${label}"]`)?.textContent);
  });
  await page.waitForFunction(() => ['false', 'Off'].includes(document.querySelector('[aria-label="Preview value On/off input"]')?.textContent ?? ''));
  report.observed.switchOff = await outputFor('On/off input').textContent();
  await sourcePage.getByRole('button', { name: 'Set software switch on', exact: true }).click();
  await page.waitForFunction(() => ['true', 'On'].includes(document.querySelector('[aria-label="Preview value On/off input"]')?.textContent ?? ''));
  report.observed.switchOn = await outputFor('On/off input').textContent();
  report.observed.scalar = await outputFor('Number input').textContent();
  report.observed.vector = await outputFor('Multi-value input').textContent();
  report.observed.switchSchemaUnit = await page.getByText('Reported actions: Live updates', { exact: false }).count() > 0;
  report.observed.publisher = await sourcePage.evaluate(() => globalThis.__ownedDeviceLanguageFixture.current.metrics());
  assert.ok(report.observed.publisher.active === 3 && report.observed.publisher.sent > 0 && report.observed.publisher.binds === 3,
    'three explicit preview grants and actual software publications');
  report.checks.push('separate-three-resource-preview-approval', 'actual-published-switch-scalar-vector-values', 'publisher-authority-and-current-routes');

  // Readable resource labels retain the existing switch, number and component value wording.
  assert.equal(report.observed.switchOff, 'Off', 'false switch values should read Off');
  assert.equal(report.observed.switchOn, 'On', 'switch values should read On or Off');
  assert.equal(report.observed.scalar, '21.5 Cel', 'scalar values should include their declared unit');
  assert.equal(report.observed.vector, 'x: 0.5 m, y: 0.25 m', 'vector values should name declared components and unit');
  report.checks.push('plain-switch-language', 'scalar-with-declared-unit', 'labeled-vector-components');

  await page.getByRole('button', { name: 'Stop input preview', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.devices-enrolled-value').length === 0);
  const retired = await sourcePage.evaluate(() => globalThis.__ownedDeviceLanguageFixture.current.stop());
  assert.ok(retired.active === 0 && retired.peer === 'disconnected' && retired.stopped);
  report.cleanup.sourceStopped = true; report.checks.push('stop-releases-values-and-resource-authority');
  report.result = 'pass';
} catch (error) {
  if (sourcePage && !sourcePage.isClosed()) {
    try { report.observed.publisherAtFailure = await sourcePage.evaluate(() => globalThis.__ownedDeviceLanguageFixture.current?.metrics()); }
    catch (captureError) { report.observed.publisherCaptureError = String(captureError).slice(0, 512); }
  }
  if (page && !page.isClosed()) {
    try { report.observed.receiverAtFailure = (await page.locator('main').innerText()).slice(-3000); }
    catch (captureError) { report.observed.receiverCaptureError = String(captureError).slice(0, 512); }
  }
  report.result = error?.name === 'AssertionError' && report.observed.publisher?.active === 3 ? 'expected-old-red' : 'failed';
  report.error = { name: error?.name ?? 'Unknown', message: String(error?.message ?? error).slice(0, 2048) };
  throw error;
} finally {
  try {
    if (sourcePage && !sourcePage.isClosed()) {
      try {
        if (!report.cleanup.sourceStopped) {
          const stopped = await sourcePage.evaluate(() => globalThis.__ownedDeviceLanguageFixture?.current?.stop());
          report.cleanup.sourceStopped = stopped?.stopped === true && stopped?.peer === 'disconnected';
        }
      } catch (cleanupError) { report.cleanup.sourceStopError = String(cleanupError).slice(0, 512); }
      await sourcePage.close(); report.cleanup.sourcePageClosed = true;
    }
  } finally {
    if (page && !page.isClosed()) { await page.close(); report.cleanup.receiverPageClosed = true; }
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    const sourceSha256After = Object.fromEntries(sourceFencePaths.map(path => [path, sha256(path)]));
    const buildSha256After = sha256('dist/server/index.js');
    report.fenceAfter = { sourceSha256: sourceSha256After, buildSha256: buildSha256After };
    report.fenceStable = JSON.stringify(sourceSha256Before) === JSON.stringify(sourceSha256After) && buildSha256Before === buildSha256After;
    if (!report.fenceStable) { report.observedResultBeforeFence = report.result; report.result = 'fence-failed'; }
    writeFileSync(resolve(output, `${runId}-${report.result}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
}
