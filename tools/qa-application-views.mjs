import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';

const consumer = realpathSync(resolve(process.argv[2] ?? ''));
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')), 'Use an owned external packed SDK consumer');
const packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(packed.status, 'pass');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/@101/${name}/dist/index.js`]));
imports['@101/connect/examples/application-views'] = '/@101/connect/examples/application-views.js';
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local application views QA</title>
<style>*{box-sizing:border-box}body{font:16px system-ui;margin:24px;color:#111;background:#fff}button{font:inherit;background:#fff;color:#111;border:1px solid;min-height:44px;padding:10px;margin:4px}button:focus-visible{outline:3px solid;outline-offset:3px}.actions{display:flex;flex-wrap:wrap}.frames{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{min-width:0;margin:0}canvas{display:block;width:100%;height:160px;border:1px solid #999}figcaption{margin:8px 0}@media(max-width:600px){body{margin:16px}.frames{grid-template-columns:1fr}}</style>
<h1>Application displays</h1><p>Each display has its own access. Stop clears the displays.</p><div class="actions"><button id="public">Share common view</button><button id="owner">Show owner view</button><button id="revoke">Remove owner access</button><button id="stop">Stop</button></div><p id="status" role="status">Access has not been approved.</p>
<div class="frames"><figure><canvas id="left"></canvas><figcaption>First shared display</figcaption></figure><figure><canvas id="right"></canvas><figcaption>Second shared display</figcaption></figure><figure><canvas id="private"></canvas><figcaption>Owner display</figcaption></figure></div>
<script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import { createApplicationViewsExample } from '@101/connect/examples/application-views';
import { mountApplicationViewCanvas } from '@101/connect';
const NativeObserver = ResizeObserver;globalThis.activeObservers=0;globalThis.pendingFrames=0;
globalThis.ResizeObserver=class extends NativeObserver{constructor(callback){super(callback);this.active=true;globalThis.activeObservers++;}disconnect(){super.disconnect();if(this.active){this.active=false;globalThis.activeObservers--;}}};
const request=requestAnimationFrame.bind(window),cancel=cancelAnimationFrame.bind(window),owned=new Set();
window.requestAnimationFrame=callback=>{const id=request(at=>{if(owned.delete(id))globalThis.pendingFrames--;callback(at);});owned.add(id);globalThis.pendingFrames++;return id;};window.cancelAnimationFrame=id=>{if(owned.delete(id))globalThis.pendingFrames--;cancel(id);};
globalThis.viewAt=performance.now();globalThis.drawMode='normal';
globalThis.canvases={left:document.getElementById('left'),right:document.getElementById('right'),owner:document.getElementById('private')};
globalThis.makeViews=()=>createApplicationViewsExample(canvases,{now:()=>globalThis.viewAt,beforeDraw(id){if(id==='owner'&&globalThis.drawMode==='revoke'){globalThis.drawMode='normal';example.revoke('alice');}if(id==='owner'&&globalThis.drawMode==='throw')throw new Error('private-renderer-failure');}});
globalThis.example=makeViews();globalThis.tickViews=(count=1)=>{for(let i=0;i<count;i++){globalThis.viewAt+=20;example.tick();}};
globalThis.canvasPixels=id=>{const canvas=canvases[id],pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let alpha=0;for(let i=3;i<pixels.length;i+=4)alpha+=pixels[i];return{alpha,width:canvas.width,height:canvas.height};};
globalThis.duplicateCanvas=()=>mountApplicationViewCanvas({canvas:canvases.left,views:example.views,viewId:'shared',outputId:'left',principalId:'alice',label:'Duplicate',draw(){throw new Error('duplicate draw');}}).reason;
document.getElementById('public').onclick=()=>{example.approvePublic();document.getElementById('status').textContent='Common view approved.';tickViews();};document.getElementById('owner').onclick=()=>{example.approveOwner();document.getElementById('status').textContent='Owner view approved.';tickViews();};document.getElementById('revoke').onclick=()=>{example.revoke('alice');document.getElementById('status').textContent='Owner access removed.';};document.getElementById('stop').onclick=()=>{example.stop();document.getElementById('status').textContent='Displays stopped.';};globalThis.ready=true;
</script></html>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  if (!/^\/@101\/(device-model|device-runtime|transport-webrtc|transport-websocket|device-web|vision|connect)\/(dist|examples)\/[a-z0-9-]+\.js$/.test(path)) { response.writeHead(404); response.end(); return; }
  try { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(join(consumer, 'node_modules', path))); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, receipts = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = [], foreignRequests = [];
      page.on('pageerror', error => errors.push({ name: error.name, message: error.message }));
      page.on('request', request => { if (!request.url().startsWith(origin + '/')) foreignRequests.push(request.url()); });
      await page.goto(origin); await page.waitForFunction(() => globalThis.ready);
      const denied = await page.evaluate(() => { globalThis.tickViews(); return { state: globalThis.example.state(), pixels: globalThis.canvasPixels('owner') }; });
      assert.equal(denied.state.steps, 1); assert.equal(denied.state.outputs, 0); assert.equal(denied.pixels.alpha, 0);
      await page.locator('#public').focus(); await page.keyboard.press('Space');
      const shared = await page.evaluate(() => { globalThis.tickViews(2); return { state: globalThis.example.state(), duplicate: globalThis.duplicateCanvas() }; });
      assert.equal(shared.state.steps, 4); assert.equal(shared.state.outputs, 2); assert.equal(shared.duplicate, 'in-use');
      assert.deepEqual(shared.state.received.left, shared.state.received.right);
      assert.equal(Object.hasOwn(shared.state.received.left, 'privateValue'), false); assert.equal(shared.state.received.owner, undefined);
      const foreign = await page.evaluate(() => { const admitted = globalThis.example.approveOwner(true, 'bob'); globalThis.tickViews(); return { admitted, owner: globalThis.canvasPixels('owner') }; });
      assert.equal(foreign.admitted, false); assert.equal(foreign.owner.alpha, 0);
      await page.locator('#owner').click();
      const owner = await page.evaluate(() => ({ state: globalThis.example.state(), pixels: globalThis.canvasPixels('owner') }));
      assert.equal(owner.state.outputs, 3); assert.equal(owner.state.received.owner.privateValue, 7319); assert.ok(owner.pixels.alpha > 0);
      assert.equal(Object.hasOwn(owner.state.received.right, 'privateValue'), false);
      await page.evaluate(() => { globalThis.canvases.left.style.width='320px';globalThis.canvases.left.style.height='120px'; });
      await page.waitForFunction(() => globalThis.canvases.left.width === 318 && globalThis.canvases.left.height === 118);
      const resize = await page.evaluate(() => globalThis.canvasPixels('left')); assert.ok(resize.alpha > 0);
      await page.evaluate(() => { globalThis.canvases.left.style.width='5000px';globalThis.canvases.left.style.height='4000px'; });
      await page.waitForFunction(() => globalThis.canvases.left.width * globalThis.canvases.left.height <= 1048576 && globalThis.canvases.left.width !== 320);
      const cap = await page.evaluate(() => globalThis.canvasPixels('left')); assert.ok(cap.width * cap.height <= 1048576);
      const revoked = await page.evaluate(() => { globalThis.drawMode='revoke';globalThis.tickViews();return { state:globalThis.example.state(),left:globalThis.canvasPixels('left'),owner:globalThis.canvasPixels('owner'),right:globalThis.canvasPixels('right'),observers:globalThis.activeObservers }; });
      assert.equal(revoked.state.outputs, 1); assert.equal(revoked.owner.alpha, 0); assert.equal(revoked.left.alpha, 0); assert.ok(revoked.right.alpha > 0); assert.equal(revoked.observers, 1);
      await page.locator('#stop').click();
      const stopped = await page.evaluate(() => ({state:globalThis.example.state(),observers:globalThis.activeObservers,frames:globalThis.pendingFrames,pixels:globalThis.canvasPixels('right')}));
      assert.equal(stopped.state.engineStops, 1); assert.equal(stopped.state.outputs, 0); assert.equal(stopped.pixels.alpha, 0); assert.equal(stopped.observers, 0); assert.equal(stopped.frames, 0);
      await page.evaluate(() => { globalThis.canvases.left.style.width='100%';globalThis.canvases.left.style.height='160px';globalThis.example=globalThis.makeViews();globalThis.example.approvePublic();globalThis.example.approveOwner();globalThis.tickViews(); });
      const expired = await page.evaluate(() => { globalThis.viewAt+=10001;globalThis.example.tick();return {outputs:globalThis.example.state().outputs,left:globalThis.canvasPixels('left'),owner:globalThis.canvasPixels('owner'),observers:globalThis.activeObservers}; });
      assert.equal(expired.outputs, 0); assert.equal(expired.left.alpha, 0); assert.equal(expired.owner.alpha, 0); assert.equal(expired.observers, 0);
      await page.evaluate(() => { globalThis.example.stop();globalThis.example=globalThis.makeViews();globalThis.example.approvePublic();globalThis.example.approveOwner();globalThis.drawMode='throw';globalThis.tickViews();globalThis.drawMode='normal'; });
      const failed = await page.evaluate(() => ({outputs:globalThis.example.state().outputs,owner:globalThis.canvasPixels('owner'),right:globalThis.canvasPixels('right')}));
      assert.equal(failed.outputs, 2); assert.equal(failed.owner.alpha, 0); assert.ok(failed.right.alpha > 0);
      await page.locator('#status').evaluate(element => { element.textContent = 'Common displays active. Owner display unavailable.'; });
      await page.setViewportSize({width:390,height:900});
      await page.waitForFunction(() => document.documentElement.scrollWidth <= 390);
      const screenshot = join(consumer, `application-views-${engine.name()}.png`); await page.screenshot({path:screenshot,fullPage:true});
      await page.evaluate(() => globalThis.example.stop());
      assert.deepEqual(errors, []); assert.deepEqual(foreignRequests, []);
      receipts.push({engine:engine.name(),version:browser.version(),status:'pass',checks:['one-authoritative-engine-two-displays','default-and-foreign-owner-denial','private-projection-isolation','native-canvas-pixels','resize-and-one-megapixel-backing-cap','reentrant-revocation-before-visible-copy','expiry-clear','renderer-failure-isolation','stop-observer-frame-teardown','keyboard-approval','narrow-layout'],screenshot});
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({status:'pass',consumer,manifest:packed.manifest,source:packed.source,qaToolSha256:createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),receipts,limits:['local Canvas2D typed-frame profile','generated application state; no phone or physical display qualification','host owns projection and synchronous renderer code','no capture/encoded-media or cross-host transport claim']},null,2));
} finally { await new Promise(resolve => server.close(resolve)); }
