import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { assertControlReachability, assertReloadPersistence, assertReloadUnmountClosesStore, codeValue, compareAndEnroll, createLocalIdentity, createUiEvidence,
  exchangeOffer, exerciseEnrollmentFailures, exerciseHiddenBeforeApproval, keyboardClick, observeActualIdentityDatabases, observeActualPeers,
  redactedDiagnostics, reviewTarget, savedKeyId, timeout } from './qa-game-pointer-support.mjs';
import { resolve } from 'node:path';
import { startProdServer } from '../node_modules/vinext/dist/server/prod-server.js';
const root = resolve(import.meta.dirname, '..');
const files = ['examples/device-pipelines/game-pointer-bridge.ts', 'app/components/InputLab.tsx', 'app/components/RemotePointerPanel.tsx',
  'app/components/use-endpoint-identity.ts', 'app/lib/connection-ownership.ts', 'tools/qa-game-pointer-support.mjs', 'tools/qa-game-pointer-ui.mjs'];
let gameServer, connectServer, evidence;
let browser, stage = 'browser startup';
const pages = [];
try {
  gameServer = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, 'dist'), silent: true });
  connectServer = await startProdServer({ port: 0, host: '127.0.0.1', outDir: resolve(root, '../uynis-connect/apps/console/dist'), silent: true });
  const target = new URL(`http://127.0.0.1:${gameServer.port}`), sourceTarget = new URL(`http://127.0.0.1:${connectServer.port}`);
  evidence = createUiEvidence('game-pointer-ui-chromium', target, files);
  browser = await chromium.launch({ headless: true });
  const sourceContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const receiverContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  await Promise.all([observeActualPeers(sourceContext), observeActualPeers(receiverContext), observeActualIdentityDatabases(sourceContext), observeActualIdentityDatabases(receiverContext)]);
  await receiverContext.addInitScript(() => {
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function(x,y,radius,...rest) {
      if (radius === 13 && this.canvas.getAttribute('aria-label')?.startsWith('Interactive 101 input test arena')) {
        this.canvas.dataset.qaAimX = String(x); this.canvas.dataset.qaAimY = String(y);
      }
      return arc.call(this,x,y,radius,...rest);
    };
  });
  const source = await sourceContext.newPage(), receiver = await receiverContext.newPage(), errors = [];
  pages.push(source, receiver);
  for (const page of [source,receiver]) page.on('pageerror',error=>errors.push(error.name));
  await Promise.all([source.goto(new URL('/pointer-lab',sourceTarget).href),receiver.goto(new URL('/studio/input',target).href)]);
  await Promise.all([source.waitForLoadState('networkidle'),receiver.waitForLoadState('networkidle')]);
  await receiver.getByText('Remote pointer resources',{exact:true}).click();
  await keyboardClick(source, source.getByRole('button',{name:'Send pointer',exact:true}));
  const pad = source.getByRole('group',{name:/^Touch pad/}); await pad.waitFor({state:'visible'});
  stage = 'explicit scoped identities and reload';
  const sourceDatabase = '101.endpoint-identity.v1:pointer-source', receiverDatabase = '101.endpoint-identity.v1:input-lab-receiver';
  const sourceKey = await createLocalIdentity(source, sourceDatabase), receiverKey = await createLocalIdentity(receiver, receiverDatabase);
  assert.equal(sourceKey !== receiverKey, true);
  await assertReloadPersistence(source, sourceDatabase, sourceKey, () => keyboardClick(source, source.getByRole('button', { name: 'Send pointer', exact: true })));
  await assertReloadPersistence(receiver, receiverDatabase, receiverKey, () => receiver.getByText('Remote pointer resources', { exact: true }).click());
  async function aim(x,y) {
    await receiver.waitForFunction(({x,y})=>{
      const canvas=document.querySelector('canvas[aria-label^="Interactive 101 input test arena"]');
      const ratio=window.devicePixelRatio || 1;
      return canvas && Math.abs(Number(canvas.dataset.qaAimX)/(canvas.width/ratio)-x)<0.015 && Math.abs(Number(canvas.dataset.qaAimY)/(canvas.height/ratio)-y)<0.015;
    },{x,y},{timeout:15000});
    return receiver.locator('canvas[aria-label^="Interactive 101 input test arena"]').evaluate(canvas=>({x:Number(canvas.dataset.qaAimX)/(canvas.width/devicePixelRatio),y:Number(canvas.dataset.qaAimY)/(canvas.height/devicePixelRatio)}));
  }
  async function noOutput() { await aim(0.5, 0.5); assert.equal(await receiver.locator('.lab-page.is-triggered').count(), 0, 'unapproved endpoint cannot trigger the application'); }
  stage = 'expired invitation, stale offer and wrong application recovery';
  const selectors = { invitation: '#input-lab-pointer-invitation', offer: '#input-lab-pointer-offer',
    answer: '#input-lab-pointer-answer', comparison: '#input-lab-pointer-comparison', status: '[data-testid="game-pointer-status"]',
    allowLabel: 'Allow aim and trigger for one minute', stopLabel: 'Stop remote pointer' };
  const rejectionChecks = await exerciseEnrollmentFailures(source, receiver, selectors, noOutput);
  stage = 'Studio visibility loss before resource approval';
  const visibilityCheck = await exerciseHiddenBeforeApproval(source, receiver, selectors, noOutput);
  const pairingBaselines = [];
  async function pair() {
    // Input Lab displays a 90 ms flash for an accepted press. Release neutralizes
    // input immediately, but does not erase that feedback. Let the prior approved
    // action finish before testing a new invitation; assertions after new input
    // remain immediate so an unauthorized press cannot be hidden by this wait.
    const started = performance.now(), previousFlash = await receiver.locator('.lab-page.is-triggered').count() > 0;
    await aim(0.5, 0.5);
    await receiver.locator('.lab-page.is-triggered').waitFor({ state: 'detached', timeout: 1000 });
    pairingBaselines.push({ previousFlash, settledMs: Math.round(performance.now() - started) });
    stage = 'Studio invitation and independently reviewed source target';
    await keyboardClick(source, source.getByRole('button', { name: 'Send pointer', exact: true }));
    await keyboardClick(receiver, receiver.getByRole('button', { name: 'Create invitation', exact: true }));
    const invitation = await codeValue(receiver, '#input-lab-pointer-invitation');
    await reviewTarget(source, invitation); await noOutput();
    stage = 'actual Studio offer and answer exchange';
    await exchangeOffer(source, receiver, '#input-lab-pointer-offer', '#input-lab-pointer-answer');
    const allow = receiver.getByRole('button', { name: 'Allow aim and trigger for one minute', exact: true });
    stage = 'bilateral proof comparison and application mapping consent';
    await compareAndEnroll(source, receiver, '#input-lab-pointer-comparison', allow, noOutput);
    await keyboardClick(receiver, allow);
    await source.waitForFunction(()=>document.querySelector('[aria-label^="Touch pad"]')?.dataset.ready==='true',undefined,{timeout});
  }
  await pair(); stage = 'actual DOM pointer and keyboard application mapping';
  const centered = await aim(0.5,0.5), rect = await pad.boundingBox();
  await source.mouse.move(rect.x+rect.width*0.2,rect.y+rect.height*0.3); await source.mouse.down();
  await receiver.locator('.lab-page.is-triggered').waitFor({state:'visible',timeout:15000});
  const contactBegin=await aim(0.5,0.5);
  await source.mouse.move(rect.x+rect.width*0.4,rect.y+rect.height*0.1); const diagonal=await aim(0.7,0.3);
  await source.waitForTimeout(200);
  assert.equal(await receiver.locator('.lab-page.is-triggered').count(),0,'position-only heartbeat must not retrigger held contact');
  await source.mouse.up(); await source.waitForTimeout(50);
  await pad.focus(); await source.keyboard.down('Space');
  await receiver.locator('.lab-page.is-triggered').waitFor({state:'visible',timeout:15000}); await source.keyboard.up('Space');
  await source.keyboard.press('ArrowLeft'); const keyboardAim=await aim(0.68,0.3);
  await source.getByRole('button',{name:'Stop',exact:true}).click(); const released=await aim(0.5,0.5);
  await receiver.getByTestId('game-pointer-status').filter({hasText:'neutral'}).waitFor({state:'visible',timeout:15000});
  await receiver.getByRole('button', { name: 'Stop remote pointer', exact: true }).click();
  await pair(); await aim(0.5, 0.5);
  await pad.focus(); await source.keyboard.press('ArrowRight'); await aim(0.52, 0.5);
  stage = 'saved identity deletion retires application mapping';
  await keyboardClick(source, source.getByRole('button', { name: 'Press / release', exact: true }));
  await receiver.locator('.lab-page.is-triggered').waitFor({ state: 'visible', timeout });
  await keyboardClick(source, source.getByRole('button', { name: 'Remove saved identity', exact: true }));
  const deletionNeutral = await aim(0.5, 0.5);
  await receiver.getByTestId('game-pointer-status').filter({ hasText: 'neutral' }).waitFor({ state: 'visible', timeout });
  assert.equal(await savedKeyId(source, sourceDatabase), undefined);
  const freshKey = await createLocalIdentity(source, sourceDatabase); assert.equal(freshKey !== sourceKey, true);
  await pair(); const freshKeyReenrolled = await aim(0.5, 0.5);
  await Promise.all([source.setViewportSize({ width: 375, height: 812 }), receiver.setViewportSize({ width: 375, height: 812 })]);
  await pad.focus(); await source.keyboard.press('ArrowRight'); const narrowKeyboardAim = await aim(0.52, 0.5);
  const widths = await Promise.all([source, receiver].map(page => page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))));
  assert.ok(widths.every(value => value.document <= value.viewport), 'narrow reduced-motion application UI does not overflow');
  const narrowReachability = await assertControlReachability(source, ['Left', 'Up', 'Down', 'Right', 'Press / release', 'Remove saved identity']);
  await evidence.screenshot(receiver, 'studio-narrow'); await evidence.screenshot(source, 'source-narrow');
  await source.getByRole('button', { name: 'Stop', exact: true }).click(); await aim(0.5, 0.5);
  await receiver.getByRole('button', { name: 'Stop remote pointer', exact: true }).click();
  stage = 'replacement identity store closes on source and Studio SPA unmount';
  const storeCleanup = await Promise.all([
    assertReloadUnmountClosesStore(source, sourceDatabase, '101 Studio', '/studio'),
    assertReloadUnmountClosesStore(receiver, receiverDatabase, 'Back to 101', '/'),
  ]);
  assert.deepEqual(errors,[]);
  evidence.record('passed', {sourceTarget: sourceTarget.href, scope:'Actual Studio DOM invitation and local source review, persisted endpoint keys, bilateral comparison consent and separate aim/trigger mapping permission over real browser WebRTC. Source pointer/key events feed original canvas renderer; arc instrumentation observes rendering without simulated bus frames. Native, physical and account acceptance remains separate.',browser:'chromium',version:browser.version(),
    result:{rejectionChecks,visibilityCheck,storeCleanup,pairingBaselines,identityReloadPreserved:true,sourceOnlyEnrollmentBlocked:true,separateGamePermission:true,centered,contactBegin,diagonal,keyboardAim,released,
      deletionNeutral,freshKeyReenrolled,narrowKeyboardAim,widths,narrowReachability,heldPositionDoesNotRetrigger:true,errors}});
} catch(error) {
  await Promise.all(pages.map((page,index)=>evidence?.screenshot(page,`failed-${index}`).catch(()=>{})));
  evidence?.record('failed',{browser:'chromium',version:browser?.version(),stage,errorType:error.name,errorMessage:error.message,errorStack:error.stack,diagnostic:await redactedDiagnostics(pages)});
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of [gameServer, connectServer]) if (server) { server.server.closeAllConnections(); await new Promise((done, reject) => server.server.close(error => error ? reject(error) : done())); }
}
