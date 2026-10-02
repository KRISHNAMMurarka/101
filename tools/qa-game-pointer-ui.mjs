import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const target = new URL(process.argv[2] ?? 'http://localhost:3001');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('Use a local server');
const files = ['examples/device-pipelines/game-pointer-bridge.ts','app/components/InputLab.tsx','app/components/RemotePointerPanel.tsx','packages/device-web/src/pointer-provider.ts','packages/device-web/src/pointer-driver.ts','packages/device-web/src/binding.ts','packages/device-web/src/manual-peer.ts','packages/transport-webrtc/src/peer.ts'];
const sourceSha256 = Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(resolve(import.meta.dirname,'..',file))).digest('hex')]));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(() => {
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function(x,y,radius,...rest) {
      if (radius === 13 && this.canvas.getAttribute('aria-label')?.startsWith('Interactive 101 input test arena')) {
        this.canvas.dataset.qaAimX = String(x); this.canvas.dataset.qaAimY = String(y);
      }
      return arc.call(this,x,y,radius,...rest);
    };
  });
  const source = await context.newPage(), receiver = await context.newPage(), errors = [];
  for (const page of [source,receiver]) page.on('pageerror',error=>errors.push(error.message));
  await Promise.all([source.goto(new URL('/pointer-lab',target).href),receiver.goto(new URL('/studio/input',target).href)]);
  await Promise.all([source.waitForLoadState('networkidle'),receiver.waitForLoadState('networkidle')]);
  await receiver.getByText('Remote pointer resources',{exact:true}).click();
  await source.getByRole('button',{name:'Send pointer',exact:true}).click();
  const pad = source.getByRole('group',{name:/^Touch pad/}); await pad.waitFor({state:'visible'});
  await source.getByRole('button',{name:'Create offer',exact:true}).click();
  await source.locator('#local-pointer-code').waitFor({state:'visible'});
  await receiver.locator('#input-lab-pointer-offer').fill(await source.locator('#local-pointer-code').inputValue());
  await receiver.getByRole('button',{name:'Use offer',exact:true}).click();
  await receiver.locator('#input-lab-pointer-answer').waitFor({state:'visible'});
  await source.locator('#remote-pointer-code').fill(await receiver.locator('#input-lab-pointer-answer').inputValue());
  await source.getByRole('button',{name:'Use answer',exact:true}).click();
  await receiver.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent==='Allow aim and trigger for one minute')?.disabled,undefined,{timeout:15000});
  await receiver.getByRole('button',{name:'Allow aim and trigger for one minute',exact:true}).click();
  await source.waitForFunction(()=>document.querySelector('[aria-label^="Touch pad"]')?.dataset.ready==='true',undefined,{timeout:15000});
  async function aim(x,y) {
    await receiver.waitForFunction(({x,y})=>{
      const canvas=document.querySelector('canvas[aria-label^="Interactive 101 input test arena"]');
      const ratio=window.devicePixelRatio || 1;
      return canvas && Math.abs(Number(canvas.dataset.qaAimX)/(canvas.width/ratio)-x)<0.015 && Math.abs(Number(canvas.dataset.qaAimY)/(canvas.height/ratio)-y)<0.015;
    },{x,y},{timeout:15000});
    return receiver.locator('canvas[aria-label^="Interactive 101 input test arena"]').evaluate(canvas=>({x:Number(canvas.dataset.qaAimX)/(canvas.width/devicePixelRatio),y:Number(canvas.dataset.qaAimY)/(canvas.height/devicePixelRatio)}));
  }
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
  assert.deepEqual(errors,[]);
  await receiver.screenshot({path:'/tmp/101-game-pointer-chromium.png',fullPage:true});
  console.log(JSON.stringify({scope:'Actual 101 Input Lab application consumer of owner-approved typed pointer/contact through real browser WebRTC and source DOM events. Canvas arc arguments instrumented while original renderer executes; no simulated bus frames. No physical/native/authenticated endpoint proof.',browser:'chromium',version:browser.version(),sourceSha256,
    result:{centered,contactBegin,diagonal,keyboardAim,released,heldPositionDoesNotRetrigger:true,errors}},null,2));
} finally {await browser.close();}
