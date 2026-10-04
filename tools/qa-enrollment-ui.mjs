import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const timeout = 15000;
export const confirmationLabel = 'Codes match — allow connection';
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Every run retains redacted stdout/stderr receipts and masks hand-transfer fields. */
export function createUiEvidence(name, target, extraFiles = []) {
  const prefix = `/tmp/101-${name}-${Date.now()}-${process.pid}`;
  const paths = { stdout: `${prefix}.stdout.json`, stderr: `${prefix}.stderr.json` };
  writeFileSync(paths.stdout, '', { flag: 'wx' }); writeFileSync(paths.stderr, '', { flag: 'wx' });
  const sourceSha256 = {};
  for (const directory of ['packages/device-model/src', 'packages/device-runtime/src', 'packages/device-web/src', 'packages/transport-webrtc/src', 'packages/connect/src', 'app/pointer-lab']) {
    for (const file of readdirSync(resolve(root, directory))) if (/\.(?:ts|tsx|css)$/.test(file) && !file.includes('.test.')) {
      const path = resolve(root, directory, file); sourceSha256[relative(root, path)] = hashFile(path);
    }
  }
  for (const file of ['examples/device-pipelines/remote-pointer.ts', 'app/components/use-endpoint-identity.ts', 'app/globals.css', 'tools/qa-enrollment-ui.mjs', ...extraFiles]) sourceSha256[file] = hashFile(resolve(root, file));
  const buildSha256 = { 'dist/server/index.js': hashFile(resolve(root, 'dist/server/index.js')) };
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const screenshots = [];
  const screenshotFailures = [];
  return {
    paths,
    async screenshot(page, label) {
      const path = `${prefix}-${label}.png`;
      try {
        await page.screenshot({ path, fullPage: true, animations: 'disabled', timeout: 10000, mask: [page.locator('textarea,input,[data-testid="reviewed-target"]')] });
        screenshots.push(path); return path;
      } catch (error) { screenshotFailures.push({ label, errorType: error.name }); throw error; }
    },
    record(outcome, details) {
      const value = JSON.stringify({ outcome, target: target.href, revision, sourceSha256, buildSha256, paths, screenshots, screenshotFailures, ...details }, null, 2);
      if (outcome === 'passed') { writeFileSync(paths.stdout, value + '\n'); console.log(value); }
      else { writeFileSync(paths.stderr, value + '\n'); console.error(value); process.exitCode = 1; }
    },
  };
}

export function observeActualPeers(context) {
  return context.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    window.__qaPointerPeers = [];
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration) { super(configuration); window.__qaPointerPeers.push(this); }
    };
    const message = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
    Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
      ...message,
      set(listener) {
        message.set.call(this, listener && function(event) {
          let finish = false;
          if (typeof event.data === 'string') {
            try { const packet = JSON.parse(event.data); finish = packet.protocol === 'connect-auth' && packet.type === 'finish'; } catch { /* Non-auth application data passes through unchanged. */ }
          }
          if (!finish || window.__qaFinishExpiryAt === undefined) return listener.call(this, event);
          const original = Date.now, expiresAt = window.__qaFinishExpiryAt;
          window.__qaFinishExpiryAt = undefined; window.__qaExpiredFinishObserved = true;
          Date.now = () => expiresAt + 1;
          try { return listener.call(this, event); } finally { Date.now = original; }
        });
      },
    });
  });
}

/** Preserve actual IndexedDB calls and observe ownership/close events only. */
export function observeActualIdentityDatabases(context) {
  return context.addInitScript(() => {
    window.__qaIdentityDatabases = [];
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function(name, ...args) {
      const request = open.call(this, name, ...args);
      if (name.startsWith('101.endpoint-identity.v1:')) request.addEventListener('success', () => {
        const database = request.result, entry = { name, closed: false };
        window.__qaIdentityDatabases.push(entry);
        const close = database.close.bind(database);
        database.close = () => { entry.closed = true; close(); };
      });
      return request;
    };
  });
}

/** Reload uses a replacement store; the actual SPA unmount must close that store. */
export async function assertReloadUnmountClosesStore(page, databaseName, exitName, exitPath) {
  const previouslyOpened = await page.evaluate(databaseName => window.__qaIdentityDatabases.filter(entry => entry.name === databaseName).length, databaseName);
  await keyboardClick(page, page.getByRole('button', { name: 'Reload local identity', exact: true }));
  await page.getByRole('button', { name: 'Remove saved identity', exact: true }).waitFor({ state: 'visible', timeout });
  await page.waitForFunction(({ databaseName, previouslyOpened }) => window.__qaIdentityDatabases.filter(entry => entry.name === databaseName).length > previouslyOpened
    && window.__qaIdentityDatabases.filter(entry => entry.name === databaseName && !entry.closed).length === 1,
  { databaseName, previouslyOpened }, { timeout });
  const before = await page.evaluate(databaseName => {
    window.__qaIdentityUnmountProbe = true;
    return window.__qaIdentityDatabases.filter(entry => entry.name === databaseName && !entry.closed).length;
  }, databaseName);
  assert.equal(before, 1, 'reload retains exactly one current identity store');
  await page.getByRole('link', { name: exitName, exact: true }).click();
  await page.waitForURL(url => url.pathname === exitPath, { timeout });
  await page.waitForFunction(databaseName => window.__qaIdentityUnmountProbe === true
    && window.__qaIdentityDatabases.filter(entry => entry.name === databaseName && !entry.closed).length === 0,
  databaseName, { timeout });
  return { reloadOpenStores: before, unmountOpenStores: 0, sameDocumentNavigation: true };
}

/** Read only the actual producer's record; no factory import or identity creation. */
export async function savedKeyId(page, databaseName) {
  return page.evaluate(async databaseName => {
    const names = await indexedDB.databases();
    if (!names.some(database => database.name === databaseName)) return undefined;
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Identity readback unavailable'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('identity', 'readonly'), request = transaction.objectStore('identity').get('endpoint');
        transaction.oncomplete = () => resolve(request.result?.keyId);
        transaction.onabort = transaction.onerror = () => reject(new Error('Identity readback failed'));
      });
    } finally { database.close(); }
  }, databaseName);
}

export async function keyboardClick(page, button) {
  const safari = page.context().browser()?.browserType().name() === 'webkit';
  await button.focus();
  await page.keyboard.press(safari ? 'Alt+Shift+Tab' : 'Shift+Tab');
  await page.keyboard.press(safari ? 'Alt+Tab' : 'Tab');
  assert.equal(await button.evaluate(element => document.activeElement === element), true, 'owner control is independently keyboard focusable');
  const visible = await button.evaluate(element => { const style = getComputedStyle(element);
    return parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none' || style.boxShadow !== 'none'; });
  assert.equal(visible, true, 'owner control retains visible keyboard focus');
  const box = await button.boundingBox(); assert.ok(box && box.height >= 44, 'owner control retains a 44px target');
  await page.keyboard.press('Enter');
}

export async function createLocalIdentity(page, databaseName) {
  const create = page.getByRole('button', { name: 'Create local identity', exact: true });
  await create.waitFor({ state: 'visible', timeout });
  assert.equal(await create.count(), 1, 'absent saved key exposes explicit Create local identity');
  assert.equal(await savedKeyId(page, databaseName), undefined, 'initial UI load never creates a saved key');
  await keyboardClick(page, create);
  await page.getByRole('button', { name: 'Remove saved identity', exact: true }).waitFor({ state: 'visible', timeout });
  const keyId = await savedKeyId(page, databaseName);
  assert.equal(typeof keyId === 'string' && /^[0-9a-f]{64}$/.test(keyId), true, 'explicit DOM action creates a saved key');
  return keyId;
}

export async function assertReloadPersistence(page, databaseName, expectedId, afterReload = async () => {}) {
  await page.reload(); await page.waitForLoadState('networkidle'); await afterReload();
  await page.getByRole('button', { name: 'Remove saved identity', exact: true }).waitFor({ state: 'visible', timeout });
  assert.equal(await page.getByRole('button', { name: 'Create local identity', exact: true }).count(), 0, 'reload exposes saved key without another creation action');
  assert.equal(await savedKeyId(page, databaseName) === expectedId, true, 'reload retains the same actual stored key');
}

export async function disabledOrAbsent(button) { return await button.count() === 0 || await button.isDisabled(); }
export async function codeValue(page, selector) {
  await page.waitForFunction(selector => !!document.querySelector(selector)?.value, selector, { timeout });
  const field = page.locator(selector); assert.equal(await field.getAttribute('readonly') !== null, true, 'hand-transfer proof is read-only');
  return field.inputValue();
}

export async function reviewTarget(source, code) {
  const invitation = code.startsWith('{') ? JSON.parse(code) : JSON.parse(decodeURIComponent(new URL(code).hash.slice('#invite='.length)));
  await source.locator('#source-invitation-code').fill(code);
  const connect = source.getByRole('button', { name: 'Connect to this receiver', exact: true });
  assert.equal(await disabledOrAbsent(connect), true, 'pasted invitation does not itself select authority');
  await keyboardClick(source, source.getByRole('button', { name: 'Review invitation', exact: true }));
  const reviewed = source.getByTestId('reviewed-target'); await reviewed.waitFor({ state: 'visible', timeout });
  const display = await reviewed.textContent();
  assert.equal(display.includes(invitation.applicationId) && display.includes(invitation.sessionId), true, 'source displays both locally reviewed scope dimensions');
  return invitation;
}

export async function exchangeOffer(source, receiver, receiverOffer, receiverAnswer) {
  await keyboardClick(source, source.getByRole('button', { name: 'Connect to this receiver', exact: true }));
  const offer = await codeValue(source, '#local-pointer-code');
  await receiver.locator(receiverOffer).fill(offer);
  await keyboardClick(receiver, receiver.getByRole('button', { name: 'Use offer', exact: true }));
  const answer = await codeValue(receiver, receiverAnswer);
  await source.locator('#remote-pointer-code').fill(answer);
  await keyboardClick(source, source.getByRole('button', { name: 'Use answer', exact: true }));
  return { offer, answer };
}

export async function compareAndEnroll(source, receiver, receiverComparison, allow, noOutput) {
  const [left, right] = await Promise.all([codeValue(source, '#endpoint-comparison-code'), codeValue(receiver, receiverComparison)]);
  assert.equal(/^[0-9a-f]{64}$/.test(left) && left === right, true, 'actual screens display the same full verified transcript digest');
  await noOutput(); assert.equal(await disabledOrAbsent(allow), true, 'verified proof alone does not permit resources');
  await keyboardClick(source, source.getByRole('button', { name: confirmationLabel, exact: true }));
  await source.waitForTimeout(50);
  await noOutput(); assert.equal(await disabledOrAbsent(allow), true, 'source consent alone does not permit description or resource selection');
  assert.equal(await source.locator('[aria-label^="Touch pad"]').getAttribute('data-ready'), 'false');
  await keyboardClick(receiver, receiver.getByRole('button', { name: confirmationLabel, exact: true }));
  await allow.waitFor({ state: 'visible', timeout });
  await receiver.waitForFunction(label => ![...document.querySelectorAll('button')].find(button => button.textContent === label)?.disabled,
    await allow.textContent(), { timeout });
  await noOutput();
}

/** Exercise the actual visibility handler while proof is enrolled but resources remain closed. */
export async function exerciseHiddenBeforeApproval(source, receiver, selectors, noOutput) {
  await keyboardClick(receiver, receiver.getByRole('button', { name: 'Create invitation', exact: true }));
  await reviewTarget(source, await codeValue(receiver, selectors.invitation));
  await exchangeOffer(source, receiver, selectors.offer, selectors.answer);
  const allow = receiver.getByRole('button', { name: selectors.allowLabel, exact: true });
  await compareAndEnroll(source, receiver, selectors.comparison, allow, noOutput);
  assert.equal(await allow.isEnabled(), true, 'enrollment completes before the visibility event');
  await receiver.evaluate(() => {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  try {
    await Promise.all([source, receiver].map(page => page.waitForFunction(() => {
      const peer = window.__qaPointerPeers?.at(-1); return peer && ['closed', 'failed', 'disconnected'].includes(peer.connectionState);
    }, undefined, { timeout })));
    assert.equal(await receiver.locator(selectors.comparison).count(), 0, 'hiding retires the enrolled comparison before resource approval');
    assert.equal(await disabledOrAbsent(allow), true, 'visibility loss cannot retain a resource grant action');
    await noOutput();
  } finally {
    await receiver.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  }
  await keyboardClick(source, source.getByRole('button', { name: 'Stop', exact: true }));
  await keyboardClick(receiver, receiver.getByRole('button', { name: selectors.stopLabel, exact: true }));
  return { hiddenBeforeResourceApprovalRetires: true, fixture: 'actual document.hidden branch and visibilitychange, no selected resources' };
}

/** Check normal-scroll viewport hit testing, separately from full-page fixed-nav captures. */
export async function assertControlReachability(page, labels) {
  const checks = [];
  for (const label of labels) {
    const control = page.getByRole('button', { name: label, exact: true });
    await control.focus();
    await control.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    const result = await control.evaluate(element => {
      const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { inViewport: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight, centerHitsControl: element === hit || element.contains(hit) };
    });
    assert.equal(result.inViewport && result.centerHitsControl, true, `${label} is reachable after normal scrolling`);
    checks.push({ control: label, ...result });
  }
  return checks;
}

/** Malicious hand-transfer text enters through the same DOM fields a user pastes. */
export async function exerciseEnrollmentFailures(source, receiver, selectors, noOutput) {
  const checks = [];
  await keyboardClick(source, source.getByRole('button', { name: 'Send pointer', exact: true }));
  await keyboardClick(receiver, receiver.getByRole('button', { name: 'Create invitation', exact: true }));
  let current = await codeValue(receiver, selectors.invitation);
  const expired = { ...JSON.parse(current), expiresAt: Date.now() - 1 };
  await source.locator('#source-invitation-code').fill(JSON.stringify(expired));
  await keyboardClick(source, source.getByRole('button', { name: 'Review invitation', exact: true }));
  await source.getByTestId('reviewed-target').waitFor({ state: 'hidden', timeout });
  assert.equal(await disabledOrAbsent(source.getByRole('button', { name: 'Connect to this receiver', exact: true })), true);
  assert.equal(await source.locator('[role="status"]').textContent().then(text => /fresh|clock|five minutes/i.test(text)), true, 'expired invitation has readable recovery');
  await noOutput(); checks.push('expired receiver invitation rejected before connection');

  await reviewTarget(source, current);
  await keyboardClick(source, source.getByRole('button', { name: 'Connect to this receiver', exact: true }));
  const staleOffer = await codeValue(source, '#local-pointer-code');
  await keyboardClick(receiver, receiver.getByRole('button', { name: 'Create invitation', exact: true }));
  const renewed = await codeValue(receiver, selectors.invitation);
  assert.equal(JSON.parse(renewed).epoch !== JSON.parse(current).epoch, true, 'new receiver invitation owns a fresh epoch');
  await receiver.locator(selectors.offer).fill(staleOffer);
  await keyboardClick(receiver, receiver.getByRole('button', { name: 'Use offer', exact: true }));
  await receiver.locator(selectors.status).filter({ hasText: /could not use this offer/i }).waitFor({ state: 'visible', timeout });
  assert.equal(await receiver.locator(selectors.answer).count(), 0, 'stale offer cannot produce an answer for a replacement invitation');
  assert.equal(await disabledOrAbsent(receiver.getByRole('button', { name: selectors.allowLabel, exact: true })), true);
  await noOutput(); checks.push('stale offer rejected against receiver-owned replacement scope');
  await keyboardClick(source, source.getByRole('button', { name: 'Stop', exact: true }));

  await keyboardClick(receiver, receiver.getByRole('button', { name: 'Create invitation', exact: true }));
  current = await codeValue(receiver, selectors.invitation);
  const wrongScope = { ...JSON.parse(current), applicationId: `${JSON.parse(current).applicationId}-other` };
  await reviewTarget(source, JSON.stringify(wrongScope));
  await exchangeOffer(source, receiver, selectors.offer, selectors.answer);
  await Promise.all([source, receiver].map(page => page.waitForFunction(() => {
    const peer = window.__qaPointerPeers?.at(-1); return peer && ['closed', 'failed', 'disconnected'].includes(peer.connectionState);
  }, undefined, { timeout })));
  assert.equal(await source.locator('#endpoint-comparison-code').count(), 0);
  assert.equal(await receiver.locator(selectors.comparison).count(), 0);
  assert.equal(await disabledOrAbsent(receiver.getByRole('button', { name: selectors.allowLabel, exact: true })), true);
  await noOutput(); checks.push('reviewed wrong application cannot borrow authority from offer or answer');
  await keyboardClick(source, source.getByRole('button', { name: 'Stop', exact: true }));
  await keyboardClick(receiver, receiver.getByRole('button', { name: selectors.stopLabel, exact: true }));

  await keyboardClick(receiver, receiver.getByRole('button', { name: 'Create invitation', exact: true }));
  current = await codeValue(receiver, selectors.invitation);
  await reviewTarget(source, current);
  await exchangeOffer(source, receiver, selectors.offer, selectors.answer);
  const [sourceComparison, receiverComparison] = await Promise.all([codeValue(source, '#endpoint-comparison-code'), codeValue(receiver, selectors.comparison)]);
  assert.equal(sourceComparison === receiverComparison && /^[0-9a-f]{64}$/.test(sourceComparison), true);
  await keyboardClick(source, source.getByRole('button', { name: confirmationLabel, exact: true }));
  await noOutput();
  const receiverConfirmation = receiver.getByRole('button', { name: confirmationLabel, exact: true });
  assert.equal(await receiverConfirmation.isEnabled(), true);
  const expiryBoundary = await receiver.evaluate(expiresAt => {
    const button = [...document.querySelectorAll('button')].find(value => value.textContent === 'Codes match — allow connection');
    const original = Date.now, beforeExpiry = original() < expiresAt;
    // Move only the wall clock at the actual DOM handler boundary, between timer ticks.
    Date.now = () => expiresAt + 1;
    try { button.click(); return { beforeExpiry, handlerClockExpired: Date.now() > expiresAt }; }
    finally { Date.now = original; }
  }, JSON.parse(current).expiresAt);
  assert.equal(expiryBoundary.beforeExpiry && expiryBoundary.handlerClockExpired, true, 'expiry fixture reaches an otherwise current final confirmation');
  await receiver.locator(selectors.status).filter({ hasText: /expired|fresh invitation/i }).waitFor({ state: 'visible', timeout });
  await Promise.all([source, receiver].map(page => page.waitForFunction(() => {
    const peer = window.__qaPointerPeers?.at(-1); return peer && ['closed', 'failed', 'disconnected'].includes(peer.connectionState);
  }, undefined, { timeout })));
  assert.equal(await disabledOrAbsent(receiver.getByRole('button', { name: selectors.allowLabel, exact: true })), true);
  assert.equal(await source.locator('[aria-label^="Touch pad"]').getAttribute('data-ready'), 'false');
  await noOutput(); checks.push('final owner confirmation rejects expiry between timer ticks');
  await keyboardClick(source, source.getByRole('button', { name: 'Stop', exact: true }));
  await keyboardClick(receiver, receiver.getByRole('button', { name: selectors.stopLabel, exact: true }));

  await keyboardClick(receiver, receiver.getByRole('button', { name: 'Create invitation', exact: true }));
  current = await codeValue(receiver, selectors.invitation);
  await reviewTarget(source, current);
  await exchangeOffer(source, receiver, selectors.offer, selectors.answer);
  const [lateSourceComparison, lateReceiverComparison] = await Promise.all([codeValue(source, '#endpoint-comparison-code'), codeValue(receiver, selectors.comparison)]);
  assert.equal(lateSourceComparison === lateReceiverComparison && /^[0-9a-f]{64}$/.test(lateSourceComparison), true);
  await keyboardClick(receiver, receiver.getByRole('button', { name: confirmationLabel, exact: true }));
  await noOutput();
  assert.equal(await disabledOrAbsent(receiver.getByRole('button', { name: selectors.allowLabel, exact: true })), true, 'receiver confirmation waits for the actual remote finish');
  await receiver.evaluate(expiresAt => { window.__qaFinishExpiryAt = expiresAt; window.__qaExpiredFinishObserved = false; }, JSON.parse(current).expiresAt);
  await keyboardClick(source, source.getByRole('button', { name: confirmationLabel, exact: true }));
  await receiver.waitForFunction(() => window.__qaExpiredFinishObserved === true, undefined, { timeout });
  await receiver.locator(selectors.status).filter({ hasText: /expired|fresh invitation/i }).waitFor({ state: 'visible', timeout });
  await Promise.all([source, receiver].map(page => page.waitForFunction(() => {
    const peer = window.__qaPointerPeers?.at(-1); return peer && ['closed', 'failed', 'disconnected'].includes(peer.connectionState);
  }, undefined, { timeout })));
  assert.equal(await disabledOrAbsent(receiver.getByRole('button', { name: selectors.allowLabel, exact: true })), true);
  await noOutput(); checks.push('actual remote finish arriving after invitation expiry cannot admit resources');
  await keyboardClick(source, source.getByRole('button', { name: 'Stop', exact: true }));
  await keyboardClick(receiver, receiver.getByRole('button', { name: selectors.stopLabel, exact: true }));
  return checks;
}

export async function redactedDiagnostics(pages) {
  return Promise.all(pages.map(page => page.evaluate(() => ({
    visibility: document.visibilityState,
    status: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent.replace(/[0-9a-f]{64}/gi, '[proof omitted]').slice(0, 240)),
    output: !!document.querySelector('[data-testid="application-pointer"]'),
    sourceReady: document.querySelector('[aria-label^="Touch pad"]')?.dataset.ready,
    peers: (window.__qaPointerPeers ?? []).map(peer => ({ connectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState, signalingState: peer.signalingState })),
  })).catch(() => ({ closed: true }))));
}
