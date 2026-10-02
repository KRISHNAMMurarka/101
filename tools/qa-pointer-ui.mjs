import assert from 'node:assert/strict';
import { chromium, webkit, firefox } from 'playwright';
import { assertControlReachability, assertReloadPersistence, assertReloadUnmountClosesStore, codeValue, compareAndEnroll, createLocalIdentity, createUiEvidence,
  exerciseEnrollmentFailures, exerciseHiddenBeforeApproval, exchangeOffer, keyboardClick, observeActualIdentityDatabases, observeActualPeers,
  redactedDiagnostics, reviewTarget, savedKeyId, timeout } from './qa-enrollment-ui.mjs';
const name = process.argv[2] ?? 'chromium';
const target = new URL(process.argv[3] ?? 'http://localhost:3001/pointer-lab');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/pointer-lab') throw new Error('Use the local pointer lab');
const browserType = { chromium, webkit, firefox }[name]; if (!browserType) throw new Error('Choose chromium, webkit or firefox');
const evidence = createUiEvidence(`pointer-ui-${name}`, target, ['tools/qa-pointer-ui.mjs']);
let browser, stage = 'browser startup';
const pages = [];
try {
  browser = await browserType.launch({ headless: true });
  const sourceContext = await browser.newContext({ viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
  const receiverContext = await browser.newContext({ viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
  await Promise.all([observeActualPeers(sourceContext), observeActualPeers(receiverContext), observeActualIdentityDatabases(sourceContext), observeActualIdentityDatabases(receiverContext)]);
  const source = await sourceContext.newPage(), receiver = await receiverContext.newPage();
  pages.push(source, receiver);
  const errors = []; for (const page of [source, receiver]) page.on('pageerror', error => errors.push(error.name));
  await Promise.all([source.goto(target.href), receiver.goto(target.href)]);
  await Promise.all([source.waitForLoadState('networkidle'), receiver.waitForLoadState('networkidle')]);
  const sourcePad = source.getByRole('group', { name: /^Touch pad/ });
  const receiverPad = receiver.getByRole('img', { name: 'Application pointer surface' });
  const marker = receiver.getByTestId('application-pointer');
  stage = 'explicit identity creation and reload';
  const sourceDatabase = '101.endpoint-identity.v1:pointer-source', receiverDatabase = '101.endpoint-identity.v1:pointer-receiver';
  await keyboardClick(source, source.getByRole('button', { name: 'Send pointer', exact: true }));
  const sourceKey = await createLocalIdentity(source, sourceDatabase), receiverKey = await createLocalIdentity(receiver, receiverDatabase);
  assert.equal(sourceKey !== receiverKey, true, 'independent endpoint contexts do not share the same saved identity');
  await assertReloadPersistence(source, sourceDatabase, sourceKey, () => keyboardClick(source, source.getByRole('button', { name: 'Send pointer', exact: true })));
  await assertReloadPersistence(receiver, receiverDatabase, receiverKey);
  const consentChecks = [];
  async function noOutput() { assert.equal(await marker.count(), 0, 'there is no application pointer before owner resource permission'); }
  stage = 'expired invitation, stale offer and wrong application recovery';
  const selectors = { invitation: '#receiver-invitation-code', offer: '#remote-pointer-code', answer: '#local-pointer-code',
    comparison: '#endpoint-comparison-code', status: '[role="status"]', allowLabel: 'Allow pointer for one minute', stopLabel: 'Stop' };
  const rejectionChecks = await exerciseEnrollmentFailures(source, receiver, selectors, noOutput);
  stage = 'visibility loss before resource approval';
  const visibilityCheck = await exerciseHiddenBeforeApproval(source, receiver, selectors, noOutput);
  async function pair() {
    stage = 'receiver invitation and source review';
    await keyboardClick(source, source.getByRole('button', { name: 'Send pointer', exact: true }));
    await sourcePad.waitFor({ state: 'visible', timeout });
    await keyboardClick(receiver, receiver.getByRole('button', { name: 'Create invitation', exact: true }));
    const invitation = await codeValue(receiver, '#receiver-invitation-code');
    assert.ok(new TextEncoder().encode(invitation).length <= 2048, 'receiver invitation stays byte bounded');
    await noOutput(); await reviewTarget(source, invitation); await noOutput();
    stage = 'actual offer and answer exchange';
    await exchangeOffer(source, receiver, '#remote-pointer-code', '#local-pointer-code');
    const allow = receiver.getByRole('button', { name: 'Allow pointer for one minute', exact: true });
    stage = 'bilateral endpoint comparison and separate resource permission';
    await compareAndEnroll(source, receiver, '#endpoint-comparison-code', allow, noOutput);
    consentChecks.push('reviewed local application/session', 'matching full verified screens', 'source consent alone blocked', 'separate receiver resource permission');
    await keyboardClick(receiver, allow); await marker.waitFor({ state: 'visible', timeout });
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
  await pair(); stage = 'actual pointer and keyboard resource delivery'; await near(0.5, 0.5, false);
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
  await evidence.screenshot(receiver, 'receiver-active');
  await source.getByRole('button', { name: 'Stop', exact: true }).click(); await marker.waitFor({ state: 'hidden', timeout });
  assert.equal(await receiverPad.getAttribute('data-contact'), 'false');
  await receiver.getByRole('button', { name: 'Stop', exact: true }).click();
  await pair(); const replacement = await near(0.5, 0.5, false);
  await receiver.getByRole('button', { name: 'Stop', exact: true }).click(); await marker.waitFor({ state: 'hidden', timeout });
  await source.getByRole('button', { name: 'Stop', exact: true }).click();
  stage = 'identity removal and fresh endpoint reenrollment';
  await pair(); await near(0.5, 0.5, false);
  await keyboardClick(source, source.getByRole('button', { name: 'Press / release', exact: true })); await near(0.5, 0.5, true);
  await keyboardClick(source, source.getByRole('button', { name: 'Remove saved identity', exact: true }));
  await marker.waitFor({ state: 'hidden', timeout });
  assert.equal(await receiverPad.getAttribute('data-contact'), 'false');
  assert.equal(await savedKeyId(source, sourceDatabase), undefined, 'explicit deletion removes saved key and held resource authority');
  const replacementKey = await createLocalIdentity(source, sourceDatabase);
  assert.equal(replacementKey !== sourceKey, true, 'explicit fresh key cannot reuse old enrollment');
  await receiver.getByRole('button', { name: 'Stop', exact: true }).click();
  await pair(); const freshKeyReenrolled = await near(0.5, 0.5, false);
  await Promise.all([source.setViewportSize({ width: 375, height: 812 }), receiver.setViewportSize({ width: 375, height: 812 })]);
  await sourcePad.focus(); await source.keyboard.press('ArrowRight'); const narrowInput = await near(0.52, 0.5, false);
  const narrowWidths = await Promise.all([source, receiver].map(page => page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))));
  assert.ok(narrowWidths.every(value => value.document <= value.viewport), 'narrow reduced-motion screen remains usable without horizontal overflow');
  const narrowReachability = await assertControlReachability(source, ['Left', 'Up', 'Down', 'Right', 'Press / release', 'Remove saved identity']);
  await evidence.screenshot(source, 'source-narrow'); await evidence.screenshot(receiver, 'receiver-narrow');
  await source.getByRole('button', { name: 'Stop', exact: true }).click(); await marker.waitFor({ state: 'hidden', timeout });
  await receiver.getByRole('button', { name: 'Stop', exact: true }).click();
  stage = 'replacement identity store closes on SPA unmount';
  const storeCleanup = await Promise.all([
    assertReloadUnmountClosesStore(source, sourceDatabase, '101 Studio', '/studio'),
    assertReloadUnmountClosesStore(receiver, receiverDatabase, '101 Studio', '/studio'),
  ]);
  assert.deepEqual(errors, []);
  const percentile = (values, fraction) => values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
  evidence.record('passed', { scope: 'Local actual DOM invitation/review, persisted endpoint keys, bilateral proof comparison and distinct resource permission over real WebRTC. Playwright pointer/key events reach the actual source handlers, driver, independent sinks and DOM commit. Timing is mapped JS capture to DOM callback; physical/native/account identity acceptance remains separate.',
    browser: name, version: browser.version(), environment: { node: process.versions.node, playwright: '1.61.1' },
    result: { consentChecks, rejectionChecks, visibilityCheck, storeCleanup, identityReloadPreserved: true, identityRemovalReleases: true, freshKeyReenrolled, narrowInput, narrowWidths, narrowReachability,
      begin, downRight, upLeft, upRight, downLeft, recontact, keyPress, keyRelease, blurRelease, resized, replacement, widths,
      timing: { count: latencies.length, minP50Ms: percentile(latencies.map(value => value.minMs), 0.5), maxP50Ms: percentile(latencies.map(value => value.maxMs), 0.5),
        maxP95Ms: percentile(latencies.map(value => value.maxMs), 0.95), maxP99Ms: percentile(latencies.map(value => value.maxMs), 0.99), maxMs: Math.max(...latencies.map(value => value.maxMs)),
        maxClockUncertaintyMs: Math.max(...latencies.map(value => value.uncertaintyMs)), samples: latencies }, errors } });
} catch (error) {
  await Promise.all(pages.map((page, index) => evidence.screenshot(page, `failed-${index}`).catch(() => {})));
  evidence.record('failed', { browser: name, version: browser?.version(), stage, errorType: error.name,
    expectedFeature: stage === 'explicit identity creation and reload' ? 'explicit identity creation is available without silent key creation' : undefined,
    diagnostic: await redactedDiagnostics(pages) });
} finally { await browser?.close(); }
