import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const consumer = realpathSync(resolve(process.argv[2] ?? ''));
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')), 'Use an owned external packed SDK consumer');
const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(packed.status, 'pass');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'device-web', 'vision', 'connect'];
const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/@101/${name}/dist/index.js`]));
imports['@101/connect/examples/control-surface'] = '/@101/connect/examples/control-surface.js';
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local control surface QA</title>
<style>body{margin:0}#mount{max-width:1200px;margin:auto}</style><main id="mount"></main><div id="literal"></div>
<script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import { mountControlSurface } from '@101/connect';
import { createControlSurfaceExample, controlSurfaceDescription } from '@101/connect/examples/control-surface';
const NativeObserver = ResizeObserver; globalThis.activeObservers = 0;
globalThis.ResizeObserver = class extends NativeObserver { constructor(callback) { super(callback); this.active = true; globalThis.activeObservers++; } disconnect() { super.disconnect(); if(this.active) { this.active=false;globalThis.activeObservers--; } } };
globalThis.mode = 'normal'; globalThis.callbackCalls = 0; globalThis.aborts = 0;
globalThis.example = createControlSurfaceExample(document.getElementById('mount'), {callbackTimeoutMs:500, beforeInput(_event,{signal}) {
  globalThis.callbackCalls++;
  if(globalThis.mode === 'reject') return Promise.reject(new Error('private-backend-error'));
  if(globalThis.mode === 'hold') return new Promise(resolve => {globalThis.release = resolve; signal.addEventListener('abort',()=>globalThis.aborts++,{once:true});});
}});
const inert = structuredClone(controlSurfaceDescription); inert.nodes[0].children[0].text = '<img src="https://invalid.example/secret" onerror="alert(1)">';
inert.nodes.push({kind:'button',id:'activate-status',label:'Additional action',style:'plain'});
globalThis.literal = mountControlSurface({container:document.getElementById('literal'),description:inert,onControl(){throw new Error('not enabled');}});
globalThis.ready = true;
</script></html>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  if (!/^\/@101\/(device-model|device-runtime|transport-webrtc|device-web|vision|connect)\/(dist|examples)\/[a-z0-9-]+\.js$/.test(path)) {
    response.writeHead(404); response.end(); return;
  }
  try { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(join(consumer, 'node_modules', path))); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, receipts = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true });
      const page = await context.newPage(), errors = [], foreignRequests = [];
      page.on('pageerror', error => errors.push({name:error.name,message:error.message}));
      page.on('request', request => { if (!request.url().startsWith(origin + '/')) foreignRequests.push(request.url()); });
      await page.goto(origin); await page.waitForFunction(() => globalThis.ready);
      const ids = await page.locator('[id]').evaluateAll(elements => elements.map(element => element.id));
      assert.equal(ids.length, new Set(ids).size, 'Authored node IDs cannot collide with generated labels/statuses');
      const controls = page.locator('#mount button, #mount input, #mount select');
      assert.equal(await controls.count(), 4);
      assert.equal(await page.locator('#mount :is(button,input,select):disabled').count(), 4);
      assert.equal(await page.locator('#literal img').count(), 0);
      assert.match(await page.locator('#literal').innerText(), /<img src=/);
      assert.equal(await page.locator('#mount').getByRole('status', {name:'Application input',exact:true}).count(), 1);
      assert.equal(await page.evaluate(() => globalThis.example.approve(false)), false);
      assert.equal(await page.locator('#mount :is(button,input,select):disabled').count(), 4);
      assert.equal(await page.evaluate(() => globalThis.example.state().received.length), 0);
      assert.equal(await page.evaluate(() => globalThis.example.approve()), true);
      const activate = page.locator('#mount button').first(), toggle = page.locator('#mount button').nth(1);
      const range = page.locator('#mount input'), choice = page.locator('#mount select');
      const tabKey = engine.name() === 'webkit' ? 'Alt+Tab' : 'Tab';
      await page.keyboard.press(tabKey); assert.equal(await activate.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => globalThis.example.state().received.length === 1);
      assert.equal(await activate.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
      await page.keyboard.press(tabKey); assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Space');
      try { await page.waitForFunction(() => globalThis.example.state().received.length === 2, null, {timeout:3000}); }
      catch (error) { console.error(JSON.stringify(await page.evaluate(() => ({state:globalThis.example.state(),calls:globalThis.callbackCalls,status:document.querySelector('#mount button:nth-of-type(1)').parentElement.textContent})))); throw error; }
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
      await page.keyboard.press(tabKey); assert.equal(await range.evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => globalThis.example.state().received.length === 3);
      await page.keyboard.press(tabKey); assert.equal(await choice.evaluate(element => element === document.activeElement), true);
      await choice.selectOption('normal'); await page.waitForFunction(() => globalThis.example.state().received.length === 4);
      assert.deepEqual(await page.evaluate(() => globalThis.example.state().received), [
        {id:'activate',value:true},{id:'enabled',value:true},{id:'level',value:4},{id:'mode',value:'normal'},
      ]);
      assert.equal(await page.evaluate(() => globalThis.example.surface.setValue('level', 4.5)), false);
      assert.equal(await page.evaluate(() => globalThis.example.surface.setText('received', '<b>Literal</b>')), true);
      assert.equal(await page.locator('#mount b').count(), 0);
      const dimensions = await controls.evaluateAll(elements => elements.map(element => {const r=element.getBoundingClientRect();return {width:r.width,height:r.height};}));
      assert.ok(dimensions.every(rect => rect.width >= 44 && rect.height >= 44), JSON.stringify({engine:engine.name(),dimensions}));
      assert.equal(await page.evaluate(() => globalThis.example.surface.state().columns), 2);
      await page.setViewportSize({width:390,height:844});
      await page.waitForFunction(() => globalThis.example.surface.state().columns === 1);
      assert.equal(await choice.evaluate(element => element === document.activeElement), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.evaluate(() => document.getElementById('mount').style.width = '200px');
      await page.waitForFunction(() => document.getElementById('mount').getBoundingClientRect().width === 200);
      assert.equal(await page.evaluate(() => document.getElementById('mount').scrollWidth <= 200), true);
      await page.evaluate(() => document.getElementById('mount').style.width = '');
      await page.emulateMedia({reducedMotion:'reduce'});
      assert.equal(await activate.evaluate(element => getComputedStyle(element).transitionDuration), '0s');
      await page.emulateMedia({reducedMotion:'no-preference', colorScheme:'dark'});
      assert.equal(await page.locator('#mount .sdk-control-surface').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(23, 23, 23)');
      await page.evaluate(() => {globalThis.mode='hold';}); await activate.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#mount button').getAttribute('aria-busy') === 'true');
      assert.equal(await activate.evaluate(element => document.activeElement === element), true);
      const beforeBusy = await page.evaluate(() => globalThis.callbackCalls);
      await page.keyboard.press('Enter'); await activate.evaluate(element => element.click());
      assert.equal(await page.evaluate(() => globalThis.callbackCalls), beforeBusy);
      await page.evaluate(() => {globalThis.mode='normal';globalThis.release();});
      await page.waitForFunction(() => document.querySelector('#mount button').getAttribute('aria-busy') === 'false');
      await page.evaluate(() => {globalThis.mode='reject';}); await activate.click();
      await page.waitForFunction(() => document.querySelector('#mount button').parentElement.textContent.includes('Try again.'));
      assert.doesNotMatch(await page.locator('#mount').innerText(), /private-backend-error/);
      await page.evaluate(() => {globalThis.mode='normal';}); await activate.click();
      await page.waitForFunction(() => document.querySelector('#mount button').parentElement.textContent.includes('Input sent.'));
      await page.evaluate(() => {globalThis.mode='hold';}); await activate.click();
      await page.waitForFunction(() => document.querySelector('#mount button').parentElement.textContent.includes('Try again.'));
      assert.equal(await page.evaluate(() => globalThis.aborts), 1);
      const beforeLate = await page.evaluate(() => globalThis.example.state().received.length);
      await page.evaluate(() => {globalThis.mode='normal';globalThis.release();});
      assert.equal(await page.evaluate(() => globalThis.example.state().received.length), beforeLate);
      await page.evaluate(() => {globalThis.mode='hold';}); await activate.click();
      await page.waitForFunction(() => document.querySelector('#mount button').getAttribute('aria-busy') === 'true');
      await page.evaluate(() => globalThis.example.revoke()); assert.equal(await page.locator('#mount :is(button,input,select):disabled').count(), 4);
      await page.evaluate(() => {globalThis.mode='normal';globalThis.release();});
      assert.equal(await page.evaluate(() => globalThis.example.state().received.length), beforeLate);
      assert.equal(await page.evaluate(() => globalThis.aborts), 2);
      assert.equal(await page.evaluate(() => globalThis.example.approve()), true); await toggle.tap();
      await page.waitForFunction(expected => globalThis.example.state().received.length === expected, beforeLate + 1);
      await page.screenshot({path:join(consumer, `control-surface-${engine.name()}.png`)});
      const teardown = await page.evaluate(() => {
        const oldButton = document.querySelector('#mount button'), before=globalThis.callbackCalls;
        globalThis.example.stop(); globalThis.literal.close(); oldButton.click(); globalThis.example.stop();
        return {observers:globalThis.activeObservers, closed:globalThis.example.surface.state().closed, children:document.getElementById('mount').childElementCount, noEvent:globalThis.callbackCalls===before};
      });
      assert.deepEqual(teardown, {observers:0,closed:true,children:0,noEvent:true});
      assert.deepEqual(errors, []); assert.deepEqual(foreignRequests, []);
      receipts.push({engine:engine.name(),version:browser.version(),nativeTabKey:tabKey,checks:{typedApplicationDelivery:true, explicitApproval:true, denialRecovery:true,
        keyboardAndFocus:true, trustedTouch:true, target44px:true, measuredColumns:true, narrowAnd200px:true, literalText:true, reducedMotion:true, darkMode:true,
        busyDuplicateSuppression:true, failureRetry:true, timeoutAbort:true, revokeFence:true, teardown:true},pageErrors:0,foreignRequests:0});
      await context.close();
    } finally {await browser.close();}
  }
  const receipt={schemaVersion:1,task:'E05',result:'pass',sourceTree:packed.source.tree,sdkManifestSha256:packed.manifest.sha256,
    qaToolSha256:createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),environment:{node:process.version},receipts,
    physicalQualification:'deferred',published:false};
  writeFileSync(join(consumer,'control-surface-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt,null,2));
} finally {await new Promise(resolve => server.close(resolve));}
