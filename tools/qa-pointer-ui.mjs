import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { chromium, webkit, firefox } from 'playwright';
const name = process.argv[2] ?? 'chromium';
const target = new URL(process.argv[3] ?? 'http://localhost:3001/pointer-lab');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/pointer-lab') throw new Error('Use the local pointer lab');
const browserType = { chromium, webkit, firefox }[name]; if (!browserType) throw new Error('Choose chromium, webkit or firefox');
const root = resolve(import.meta.dirname, '..'), sourceSha256 = {};
for (const directory of ['packages/device-model/src', 'packages/device-runtime/src', 'packages/device-web/src', 'packages/transport-webrtc/src', 'packages/connect/src', 'app/pointer-lab']) {
  for (const file of readdirSync(resolve(root, directory))) if (/\.(?:ts|tsx|css)$/.test(file) && !file.includes('.test.')) {
    const path = resolve(root, directory, file); sourceSha256[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}
for (const file of ['examples/device-pipelines/remote-pointer.ts', 'app/globals.css']) sourceSha256[file] = createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex');
const browser = await browserType.launch({ headless: true });
const pages = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  await context.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    window.__qaPointerPeers = [];
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration) { super(configuration); window.__qaPointerPeers.push(this); }
    };
  });
  const source = await context.newPage(), receiver = await context.newPage();
  pages.push(source, receiver);
  const errors = []; for (const page of [source, receiver]) page.on('pageerror', error => errors.push(error.message));
  await Promise.all([source.goto(target.href), receiver.goto(target.href)]);
  await Promise.all([source.waitForLoadState('networkidle'), receiver.waitForLoadState('networkidle')]);
  const sourcePad = source.getByRole('group', { name: /^Touch pad/ });
  const receiverPad = receiver.getByRole('img', { name: 'Application pointer surface' });
  const marker = receiver.getByTestId('application-pointer');
  const timeout = 15000;
  async function pair() {
    await source.getByRole('button', { name: 'Send pointer', exact: true }).click();
    await sourcePad.waitFor({ state: 'visible', timeout });
    await source.getByRole('button', { name: 'Create offer', exact: true }).click();
    await source.waitForFunction(() => !!document.querySelector('#local-pointer-code')?.value, undefined, { timeout });
    const offer = await source.locator('#local-pointer-code').inputValue();
    await receiver.locator('#remote-pointer-code').fill(offer);
    await receiver.getByRole('button', { name: 'Use offer', exact: true }).click();
    await receiver.waitForFunction(() => !!document.querySelector('#local-pointer-code')?.value, undefined, { timeout });
    const answer = await receiver.locator('#local-pointer-code').inputValue();
    await source.locator('#remote-pointer-code').fill(answer);
    await source.getByRole('button', { name: 'Use answer', exact: true }).click();
    const allow = receiver.getByRole('button', { name: 'Allow pointer for one minute', exact: true });
    await allow.waitFor({ state: 'visible', timeout });
    await receiver.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Allow pointer for one minute')?.disabled, undefined, { timeout });
    assert.equal(await marker.count(), 0, 'there is no output before owner selection');
    await allow.click(); await marker.waitFor({ state: 'visible', timeout });
    await source.waitForFunction(() => document.querySelector('[aria-label^="Touch pad"]')?.dataset.ready === 'true', undefined, { timeout });
  }
  async function point() {
    return marker.evaluate(element => {
      const pad = element.parentElement;
      return { x: parseFloat(element.style.left) / pad.clientWidth, y: parseFloat(element.style.top) / pad.clientHeight,
        contact: pad.dataset.contact === 'true', sequence: Number(element.dataset.sequence),
        earliest: Number(element.dataset.captureEarliest), latest: Number(element.dataset.captureLatest),
        receivedAt: Number(element.dataset.receivedAt), renderedAt: Number(element.dataset.renderedAt), uncertaintyMs: Number(element.dataset.uncertaintyMs) };
    });
  }
  async function near(x, y, contact) {
    await receiver.waitForFunction(({ x, y, contact }) => {
      const element = document.querySelector('[data-testid="application-pointer"]'); if (!element) return false;
      const pad = element.parentElement;
      return Math.abs(parseFloat(element.style.left) / pad.clientWidth - x) < 0.015 && Math.abs(parseFloat(element.style.top) / pad.clientHeight - y) < 0.015 && (contact === undefined || (pad.dataset.contact === 'true') === contact);
    }, { x, y, contact }, { timeout });
    return point();
  }
  await pair(); await near(0.5, 0.5, false);
  let bounds = await sourcePad.boundingBox();
  const padPoint = (x, y) => ({ x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y });
  let anchor = padPoint(0.2, 0.3); await source.mouse.move(anchor.x, anchor.y); await source.mouse.down();
  const begin = await near(0.5, 0.5, true);
  let next = padPoint(0.4, 0.5); await source.mouse.move(next.x, next.y); const downRight = await near(0.7, 0.7, true);
  next = padPoint(0.2, 0.3); await source.mouse.move(next.x, next.y); const upLeft = await near(0.5, 0.5, true);
  next = padPoint(0.4, 0.1); await source.mouse.move(next.x, next.y); const upRight = await near(0.7, 0.3, true);
  next = padPoint(0.2, 0.3); await source.mouse.move(next.x, next.y); const downLeft = await near(0.5, 0.5, true);
  await source.mouse.up(); await near(0.5, 0.5, false);
  anchor = padPoint(0.8, 0.8); await source.mouse.move(anchor.x, anchor.y); await source.mouse.down(); const recontact = await near(0.5, 0.5, true);
  await source.mouse.up(); await near(0.5, 0.5, false);
  await sourcePad.focus(); await source.keyboard.press('ArrowRight'); await near(0.52, 0.5, false);
  await source.keyboard.down('Space'); const keyPress = await near(0.52, 0.5, true);
  await source.keyboard.up('Space'); const keyRelease = await near(0.52, 0.5, false);
  await source.keyboard.down('Space'); await near(0.52, 0.5, true);
  await source.getByRole('button', { name: 'Left', exact: true }).focus(); const blurRelease = await near(0.52, 0.5, false);
  await source.keyboard.up('Space');
  await receiver.setViewportSize({ width: 700, height: 700 }); const resized = await near(0.52, 0.5, false);
  await sourcePad.focus(); const latencies = [];
  for (let index = 0; index < 80; index++) {
    const x = index % 2 === 0 ? 0.54 : 0.52;
    await source.keyboard.press(index % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
    const state = await near(x, 0.5, false);
    assert.ok(state.earliest <= state.latest && state.latest <= state.receivedAt && state.receivedAt <= state.renderedAt);
    latencies.push({ minMs: Math.max(0, state.renderedAt - state.latest), maxMs: state.renderedAt - state.earliest, uncertaintyMs: state.uncertaintyMs });
    await source.waitForTimeout(20);
  }
  const widths = await Promise.all([source, receiver].map(page => page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))));
  assert.ok(widths.every(value => value.document <= value.viewport));
  await receiver.screenshot({ path: `/tmp/101-pointer-${name}-receiver.png` });
  await source.getByRole('button', { name: 'Stop', exact: true }).click(); await marker.waitFor({ state: 'hidden', timeout });
  assert.equal(await receiverPad.getAttribute('data-contact'), 'false');
  await receiver.getByRole('button', { name: 'Stop', exact: true }).click();
  await pair(); const replacement = await near(0.5, 0.5, false);
  await receiver.getByRole('button', { name: 'Stop', exact: true }).click(); await marker.waitFor({ state: 'hidden', timeout });
  await source.getByRole('button', { name: 'Stop', exact: true }).click();
  assert.deepEqual(errors, []);
  const percentile = (values, fraction) => values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
  console.log(JSON.stringify({ scope: 'Local UI real WebRTC; Playwright pointer/key events reach actual React source handlers, shared driver, approved independent sinks and DOM commit. No human/native/physical/authenticated endpoint proof. Timing is mapped JS source capture to receiver DOM commit callback, not display scanout.',
    browser: name, version: browser.version(), sourceSha256, environment: { node: process.versions.node, playwright: '1.61.1' },
    result: { begin, downRight, upLeft, upRight, downLeft, recontact, keyPress, keyRelease, blurRelease, resized, replacement, widths,
      timing: { count: latencies.length, minP50Ms: percentile(latencies.map(value => value.minMs), 0.5), maxP50Ms: percentile(latencies.map(value => value.maxMs), 0.5),
        maxP95Ms: percentile(latencies.map(value => value.maxMs), 0.95), maxP99Ms: percentile(latencies.map(value => value.maxMs), 0.99), maxMs: Math.max(...latencies.map(value => value.maxMs)),
        maxClockUncertaintyMs: Math.max(...latencies.map(value => value.uncertaintyMs)), samples: latencies }, errors } }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ browser: name, version: browser.version(), sourceSha256, outcome: 'failed', scope: 'Local two-page pointer UI over actual WebRTC; no physical/native/authenticated identity proof.', diagnostic: await Promise.all(pages.map(page => page.evaluate(async () => ({
    visibility: document.visibilityState, status: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent),
    output: !!document.querySelector('[data-testid="application-pointer"]'), buttons: [...document.querySelectorAll('button')].filter(button => !['Expand'].includes(button.textContent)).map(button => ({ label: button.textContent, disabled: button.disabled })),
    peers: await Promise.all(window.__qaPointerPeers.map(async peer => ({ connectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState,
      signalingState: peer.signalingState, stats: [...(await peer.getStats()).values()].filter(stat => stat.type === 'candidate-pair' || stat.type === 'data-channel').map(stat => ({ type: stat.type, state: stat.state, nominated: stat.nominated, bytesSent: stat.bytesSent, bytesReceived: stat.bytesReceived, messagesSent: stat.messagesSent, messagesReceived: stat.messagesReceived })) }))),
  })).catch(() => ({ closed: true })))) }, null, 2));
  throw error;
} finally { await browser.close(); }
