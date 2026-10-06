import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { build, version as viteVersion } from 'vite';
import ts from 'typescript';
import { chromium, webkit } from 'playwright';

// Actual React components and browser DOM, with explicit software doubles for
// clipboard/host responses. This never opens a user's clipboard or connection.
assert.equal(process.argv.length, 2, 'No endpoint, path or credential arguments accepted');
const root = resolve(import.meta.dirname, '..');
const files = ['app/lib/invitation-copy.ts', 'app/lib/invitation-copy.test.ts',
  'app/components/PairingLink.tsx', 'app/components/HostConnectionReview.tsx',
  'app/components/PreGame.tsx', 'app/Launcher.tsx', 'app/globals.css', 'tools/qa-invitation-copy.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceSha256 = Object.fromEntries(files.map(file => [file, hash(readFileSync(join(root,file)))]));
let server, browser, context; const results=[];
try {
  const hostPort = `
    export function readBrowserHubCandidates(){return []}
    export function getBrowserHostTransport(){return {
      async reviewEndpoint(endpoint){return {endpoint,phoneEndpoints:[endpoint]}},
      async preparePairing(endpoint,options){
        if(endpoint!==options.phoneEndpoint)throw Error('Fixture endpoint mismatch');
        window.__issued++;
        return {hubEndpoint:endpoint,controllerUrl:'http://127.0.0.1/controller?fixture='+window.__issued,
          ticket:{expiresAt:Date.now()+window.__pairingLifetime}};
      }
    }}
  `;
  const entry = `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {PairingLink} from './app/components/PairingLink';
    import {HostConnectionReview} from './app/components/HostConnectionReview';
    window.__issued=0;window.__pairingLifetime=60000;window.__writeMode='unavailable';window.__writes=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,get(){
      if(window.__writeMode==='getter-error')throw Error('Software getter failure');
      if(window.__writeMode==='unavailable')return undefined;
      return {writeText(text){window.__writes.push(text);
        if(window.__writeMode==='denied')return Promise.reject(new DOMException('Software permission detail','NotAllowedError'));
        if(window.__writeMode==='held')return new Promise(resolve=>{window.__settleWrite=resolve});
        return Promise.resolve();
      }};
    }});
    const timers=new Set(),set=window.setTimeout.bind(window),clear=window.clearTimeout.bind(window);
    window.setTimeout=(fn,delay,...args)=>{let token;token=set(()=>{timers.delete(token);fn(...args)},delay);timers.add(token);return token};
    window.clearTimeout=token=>{timers.delete(token);clear(token)};
    window.__timers=()=>timers.size;
    function Fixture(){const [pairing,setPairing]=useState(),[visible,setVisible]=useState(true);
      window.__setPairing=setPairing;window.__setVisible=setVisible;
      return <main style={{maxWidth:600,padding:12,margin:'auto',boxSizing:'border-box'}}>
        <h1>Invitation UI software fixture</h1>
        <HostConnectionReview sessionId='TEST101' onReady={setPairing}/>
        <output data-testid='code'>{pairing?'Current code '+window.__issued:'No current code'}</output>
        {visible&&<PairingLink url={pairing?.controllerUrl} expiresAt={pairing?.ticket.expiresAt}/>} 
      </main>;
    }
    const ownedRoot=createRoot(document.getElementById('root'));window.__unmount=()=>ownedRoot.unmount();ownedRoot.render(<Fixture/>);
  `;
  const bundle = await build({root,configFile:false,publicDir:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},
    build:{write:false,minify:false,lib:{entry:join(root,'invitation-ui-fixture.tsx'),formats:['iife'],name:'InvitationUiFixture',fileName:'bundle'}},
    plugins:[{name:'explicit-software-host-port',enforce:'pre',
      resolveId(id,importer){if(id===join(root,'invitation-ui-fixture.tsx'))return '\0invitation-ui-fixture.tsx';
        if(id.endsWith('browser-link')&&importer===join(root,'app/components/HostConnectionReview.tsx'))return '\0owned-host-port';
        if(importer==='\0invitation-ui-fixture.tsx'&&id.startsWith('./app/'))return join(root,id)+'.tsx';},
      load(id){if(id==='\0invitation-ui-fixture.tsx')return entry;if(id==='\0owned-host-port')return hostPort;},
      transform(code,id){if(id.endsWith('.tsx')||id.endsWith('.ts'))return {code:ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText,map:null};}
    }]});
  const outputs=Array.isArray(bundle)?bundle:[bundle];assert.equal(outputs.length,1);
  const chunks=outputs[0].output.filter(x=>x.type==='chunk');assert.equal(chunks.length,1);const js=Buffer.from(chunks[0].code);
  const buildInputs=Object.keys(chunks[0].modules);assert.ok(buildInputs.length<=128);
  const realInputs=[...new Set(buildInputs.filter(p=>!p.includes('\0')).map(p=>p.split('?')[0]).filter(p=>existsSync(p)))];
  const dependencySha256=Object.fromEntries(realInputs.map(p=>[p,hash(readFileSync(p))]));
  const served=new Map([['/', ['text/html; charset=utf-8',Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>')]],['/bundle.js',['text/javascript; charset=utf-8',js]],['/styles.css',['text/css; charset=utf-8',readFileSync(join(root,'app/globals.css'))]]]);
  server=createServer((request,response)=>{const value=served.get(request.url);if(!value){response.writeHead(404);response.end();return;}response.writeHead(200,{'content-type':value[0],'cache-control':'no-store'});response.end(value[1]);});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
    browser=await engine.launch({headless:true});context=await browser.newContext({viewport:{width:320,height:640},reducedMotion:'reduce'});
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    page.setDefaultTimeout(5000);await page.goto(origin);const checks=[];
    const link=page.getByRole('textbox',{name:'Controller link',exact:true});
    await assert.doesNotReject(()=>page.getByRole('button',{name:'Copy',exact:true}).waitFor());
    assert.equal(await page.getByRole('button',{name:'Copy',exact:true}).isDisabled(),true);assert.equal(await page.evaluate(()=>window.__writes.length),0);checks.push('initial no invitation, no copy or host activation');
    await page.getByRole('textbox',{name:'Connection address',exact:true}).fill('http://127.0.0.1:3141');
    await page.getByRole('button',{name:'Check address',exact:true}).click();await page.getByRole('button',{name:'Connect',exact:true}).click();
    await page.getByTestId('code').filter({hasText:'Current code 1'}).waitFor();
    await page.getByRole('button',{name:'Copy',exact:true}).click();await page.getByText('Copying is unavailable. The link is selected; copy it yourself, or scan the code.',{exact:true}).waitFor();
    assert.equal(await link.evaluate(e=>document.activeElement===e&&e.selectionStart===0&&e.selectionEnd===e.value.length),true);checks.push('missing software clipboard gives selected manual-copy recovery');
    await page.evaluate(()=>{window.__writeMode='denied'});await page.getByRole('button',{name:'Copy',exact:true}).click();
    await page.waitForFunction(()=>window.__writes.length===1);await page.getByText('Copying is unavailable. The link is selected; copy it yourself, or scan the code.',{exact:true}).waitFor();checks.push('software native rejection is caught without raw error');
    await page.evaluate(()=>{window.__writeMode='getter-error'});await page.getByRole('button',{name:'Copy',exact:true}).click();await page.getByText('Copying is unavailable. The link is selected; copy it yourself, or scan the code.',{exact:true}).waitFor();checks.push('throwing software native getter has recoverable manual selection');
    await page.evaluate(()=>{window.__writeMode='success'});await page.getByRole('button',{name:'Copy',exact:true}).click();await page.getByRole('button',{name:'Copied',exact:true}).waitFor();checks.push('actual settled software Promise alone announces Copied');
    await page.evaluate(()=>{window.__writeMode='held'});await page.getByRole('button',{name:'Copied',exact:true}).click();
    try { await page.getByRole('button',{name:'Copying…',exact:true}).waitFor(); }
    catch(error){console.error(JSON.stringify({browser:name,errors,ownedFixture:await page.evaluate(()=>({mode:window.__writeMode,writes:window.__writes,issued:window.__issued,body:document.body.innerText.slice(0,4096)}))}));throw error;}
    const writes=await page.evaluate(()=>window.__writes.length);await page.getByRole('button',{name:'Copying…',exact:true}).evaluate(e=>e.click());assert.equal(await page.evaluate(()=>window.__writes.length),writes);
    await page.evaluate(()=>window.__setPairing({controllerUrl:'http://127.0.0.1/controller?replacement',ticket:{expiresAt:Date.now()+60000}}));
    await page.waitForFunction(()=>document.querySelector('input[readonly]').value.includes('replacement'));
    assert.equal(await page.getByRole('button',{name:'Copying…',exact:true}).isDisabled(),true);
    await page.evaluate(()=>window.__settleWrite());await page.getByRole('button',{name:'Copy',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Copy',exact:true}).isEnabled(),true);checks.push('held software write reserves slot across replacement; old settlement restores no Copied');
    await page.getByRole('button',{name:'Copy',exact:true}).click();await page.getByRole('button',{name:'Copying…',exact:true}).waitFor();
    await page.evaluate(()=>window.__setVisible(false));await link.waitFor({state:'detached'});await page.evaluate(()=>window.__settleWrite());await page.evaluate(()=>window.__setVisible(true));await link.waitFor();assert.equal(await page.getByRole('button',{name:'Copy',exact:true}).isEnabled(),true);checks.push('actual React unmount fences late software completion; fresh view recovers');
    const keyboardNavigation=name==='webkit'?'Alt+Tab':'Tab';
    await link.focus();await page.keyboard.press(keyboardNavigation);
    const copyFocused=await page.getByRole('button',{name:'Copy',exact:true}).evaluate(e=>document.activeElement===e);
    if(!copyFocused)console.error(JSON.stringify({browser:name,keyboardFocus:await page.evaluate(()=>({tag:document.activeElement.tagName,text:document.activeElement.textContent.slice(0,200)}))}));
    assert.equal(copyFocused,true);
    assert.equal(await page.getByRole('button',{name:'Copy',exact:true}).evaluate(e=>getComputedStyle(e).outlineStyle!=='none'),true);checks.push('native '+keyboardNavigation+' button focus and visible outline');
    await page.getByRole('button',{name:'Change address',exact:true}).click();await page.evaluate(()=>{window.__pairingLifetime=180});
    await page.getByRole('button',{name:'Check address',exact:true}).click();await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByText('This code has expired. Connect again to make a new one.',{exact:true}).waitFor();
    assert.equal(await page.getByTestId('code').textContent(),'No current code');assert.equal(await page.getByRole('button',{name:'Copy',exact:true}).isDisabled(),true);checks.push('actual browser expiry timer withdraws code/link and offers explicit Connect recovery');
    await page.evaluate(()=>{window.__pairingLifetime=60000;window.__writeMode='success'});await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByTestId('code').filter({hasText:'Current code 3'}).waitFor();
    await page.getByRole('button',{name:'Copy',exact:true}).click();await page.getByRole('button',{name:'Copied',exact:true}).waitFor();checks.push('explicit fresh issued software invitation and copy recover after expiry');
    for(const theme of ['dark','light']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}checks.push('320px reflow in both themes');
    await page.evaluate(()=>window.__unmount());await page.waitForFunction(()=>window.__timers()===0);assert.deepEqual(errors,[]);checks.push('actual React expiry timers retired and no page errors');
    results.push({browser:name,version:browser.version(),checks,keyboardNavigation,clipboardIsSoftwareDouble:true,hostIsSoftwareDouble:true,clipboardNativeWrites:0,physicalPhonePairingQualified:false});
    await context.close();context=undefined;await browser.close();browser=undefined;
  }
  for(const [file,pin]of Object.entries(sourceSha256))assert.equal(hash(readFileSync(join(root,file))),pin,'source changed during proof');
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));server=undefined;
  for(const [path,pin]of Object.entries(dependencySha256))assert.equal(hash(readFileSync(resolve(root,path))),pin,'compiler input changed during proof');
  console.log(JSON.stringify({result:'pass',scope:'actual owned React/DOM software-port invitation copy and expiry only',node:process.version,viteVersion,typescript:ts.version,sourceSha256,dependencySha256,compilerVirtualInputs:buildInputs.filter(p=>p.includes('\0')),fixtureSha256:hash(entry),hostPortSha256:hash(hostPort),bundleSha256:hash(js),results,cleanup:{browsers:0,contexts:0,servers:0,ownedUiTimers:0},limitations:['No native/general clipboard accessed; native clipboard permission/write qualification remains open','Host method results are explicit software fixtures; no pairing protocol/native connection/hardware or whole U05/U10 claim','PreGame/Launcher bindings are source-pinned; composed fixture is not a completed production-route walkthrough']},null,2));
} finally {
  await context?.close();await browser?.close();
  if(server)await new Promise(resolve=>server.close(resolve));
}
