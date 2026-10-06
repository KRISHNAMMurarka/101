import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { chromium, webkit } from 'playwright';

const args = process.argv.slice(2);
assert.ok(['--legacy', '--workspace-exports', '--sdk-root'].includes(args[0]) && args.length === 2, 'Use --legacy/--sdk-root <installed consumer> or --workspace-exports <owned worktree>');
const legacy = args[0] === '--legacy', workspace = args[0] === '--workspace-exports';
const consumer = realpathSync(resolve(args[1]));
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
let compiled, packed;
if (workspace) {
  compiled = mkdtempSync(join(tmpdir(), '101-application-media-source-'));
  const rootNames = [join(consumer, 'packages/connect/src/index.ts'), join(consumer, 'examples/device-pipelines/application-media.ts')];
  const program = ts.createProgram(rootNames, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true, types: [],
    noEmitOnError: true, rewriteRelativeImportExtensions: true, rootDir: consumer, outDir: compiled,
    paths: Object.fromEntries(names.map(name => [`@101/${name}`, [join(consumer, `packages/${name}/src/index.ts`)]])),
  });
  try {
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => consumer, getCanonicalFileName: file => file, getNewLine: () => '\n' }));
    const sources = program.getSourceFiles().filter(source => !source.isDeclarationFile);
    for (const source of sources) {
      const path = relative(consumer, source.fileName).split(sep).join('/');
      assert.ok(path === 'examples/device-pipelines/application-media.ts' || names.some(name => path.startsWith(`packages/${name}/src/`) && !path.endsWith('.test.ts')), 'Only the owned public SDK graph may compile');
    }
    const result = program.emit(); assert.equal(result.emitSkipped, false); assert.deepEqual(result.diagnostics, []);
    packed = { proof: 'owned-worker-public-resolver', source: Object.fromEntries(sources.map(source => [relative(consumer, source.fileName), createHash('sha256').update(readFileSync(source.fileName)).digest('hex')])) };
  } catch (error) { rmSync(compiled, { recursive: true, force: true }); throw error; }
} else if (!legacy) {
  packed = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8')); assert.equal(packed.status, 'pass');
  // Bind the browser proof to ordinary installed bytes from the immutable pack.
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifestBytes = readFileSync(packed.manifest.path);
  assert.equal(hash(manifestBytes), packed.manifest.sha256);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.source.tree, packed.source.tree);
  assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
  for (const name of names) {
    const pkg = manifest.packages.find(value => value.name === '@101/' + name);
    assert.ok(pkg && Array.isArray(pkg.files) && pkg.files.length <= 1024);
    const directory = join(consumer, 'node_modules/@101', name);
    assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
    for (const file of pkg.files) {
      const path = resolve(directory, file.path);
      assert.ok(path.startsWith(directory + sep));
      assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
      assert.equal(hash(readFileSync(path)), file.sha256);
    }
  }
  for (const path of ['packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/media-grants.ts',
    'packages/device-web/src/application-media.ts', 'examples/device-pipelines/application-media.ts']) {
    assert.equal(hash(readFileSync(resolve(import.meta.dirname, '..', path))), packed.source.sha256[path]);
  }
}
const imports = Object.fromEntries(names.map(name => [`@101/${name}`, `/@101/${name}/dist/index.js`]));
imports['@101/connect/examples/application-media'] = '/@101/connect/examples/application-media.js';
const oldHtml = `<!doctype html><html><meta charset="utf-8"><title>Application video producer regression</title>
<canvas id="source" width="64" height="48"></canvas><canvas id="output" width="64" height="48"></canvas>
<script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import * as api from '@101/connect';
globalThis.runProducer=async()=>{
 const source=document.querySelector('#source'),output=document.querySelector('#output');
 source.getContext('2d').fillStyle='rgb(255,0,0)';source.getContext('2d').fillRect(0,0,64,48);
 const stream=source.captureStream(10),track=stream.getVideoTracks()[0],video=document.createElement('video');
 video.muted=true;video.playsInline=true;video.srcObject=stream;
 try {
  await video.play();
  const start=performance.now();while(video.readyState<2||video.videoWidth!==64){if(performance.now()-start>2000)throw Error('native-producer-unavailable');await new Promise(resolve=>setTimeout(resolve,10));}
  const probe=document.createElement('canvas');probe.width=64;probe.height=48;probe.getContext('2d').drawImage(video,0,0);
  const pixels=[...probe.getContext('2d').getImageData(0,0,1,1).data],settings=track.getSettings();
  const videoDescription={type:'track',id:'media:application',media:'video',direction:'capture',codecs:['video/raw'],video:{widthPx:{min:64,max:64},heightPx:{min:48,max:48},frameRateHz:{min:1,max:30}}};
  const target={type:'render-target',id:'media:output',media:'video',geometry:{widthPx:64,heightPx:48,pixelRatio:1}};
  const manifest=api.parseMediaManifest({schemaVersion:1,id:'media:producer-regression',tracks:[videoDescription],renderTargets:[target]});
  const plan=api.planMediaBinding(manifest,videoDescription.id,target.id,{source:{resourceId:videoDescription.id,registrationId:'native-source',state:'available',codecs:['video/raw'],video:{widthPx:settings.width,heightPx:settings.height,frameRateHz:settings.frameRate}},target:{resourceId:target.id,registrationId:'native-output',state:'available',codecs:['video/raw'],geometry:target.geometry}});
  return {track:{native:track instanceof MediaStreamTrack,kind:track.kind,readyState:track.readyState,settings:{width:settings.width,height:settings.height,...(settings.frameRate===undefined?{}:{frameRate:settings.frameRate})}},decodedPixel:pixels,compatibleNativePlan:plan.ok,authorizedApi:typeof api.createBrowserApplicationMedia==='function',outputAlpha:output.getContext('2d').getImageData(0,0,1,1).data[3]};
 }finally {video.pause();video.srcObject=null;stream.getTracks().forEach(track=>track.stop());}
};globalThis.ready=true;
</script></html>`;
const newHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local application video</title>
<style>body{background:#fff;color:#111;font:16px system-ui;margin:20px}button{min-height:44px;padding:10px;border:1px solid #777;background:#fff;color:#111;font:inherit}button:focus-visible{outline:3px solid;outline-offset:3px}canvas{max-width:100%;height:auto}section{margin:12px 0;min-width:0}@media(prefers-reduced-motion:reduce){*{animation:none;transition:none}}</style>
<h1>Application video</h1><p>Each output needs the source owner and recipient to approve access.</p>
<canvas id="source" width="64" height="48" aria-label="Generated application source"></canvas>
<button id="share">Approve first display</button><button id="stop">Stop</button><p id="status" role="status">Not shared.</p>
<section id="first"><p>First recipient</p></section><section id="second"><p>Second recipient</p></section>
<script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import { createBrowserApplicationMedia } from '@101/connect';
import { createApplicationMediaExample } from '@101/connect/examples/application-media';
const source=document.querySelector('#source'),containers={first:document.querySelector('#first'),second:document.querySelector('#second')};
const nativeCapture=HTMLCanvasElement.prototype.captureStream,nativePlay=HTMLMediaElement.prototype.play,nativeDraw=CanvasRenderingContext2D.prototype.drawImage;
const tracks=[], videos=[], playResolvers=[];let captureCalls=0, playMode='normal', drawMode='normal', drawObserver, approvalMode='normal', silentCallbacks=false, color='rgb(255,0,0)';
const paints=setInterval(()=>{const paint=source.getContext('2d');paint.fillStyle=color;paint.fillRect(0,0,64,48);},30);source.getContext('2d').fillStyle=color;source.getContext('2d').fillRect(0,0,64,48);
HTMLCanvasElement.prototype.captureStream=function(...args){captureCalls++;const stream=nativeCapture.apply(this,args);tracks.push(...stream.getTracks());return stream;};
HTMLMediaElement.prototype.play=function(...args){videos.push(this);const result=nativePlay.apply(this,args);if(playMode==='late')return result.then(()=>new Promise(resolve=>playResolvers.push(resolve)));if(playMode==='reject')return result.then(()=>{throw new Error('owned-host-play-failure');});return result;};
CanvasRenderingContext2D.prototype.drawImage=function(...args){const result=nativeDraw.apply(this,args);drawObserver?.(this.canvas,args[0]);if(drawMode==='revoke'&&args[0] instanceof HTMLVideoElement){drawMode='normal';example.setConsent('second','source',false);}return result;};
const frameRequest=HTMLVideoElement.prototype.requestVideoFrameCallback,frameCancel=HTMLVideoElement.prototype.cancelVideoFrameCallback,frames=new Set();
if(frameRequest){HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){let id;id=frameRequest.call(this,(...args)=>{frames.delete(id);if(!silentCallbacks)callback(...args);});frames.add(id);return id;};HTMLVideoElement.prototype.cancelVideoFrameCallback=function(id){frames.delete(id);return frameCancel.call(this,id);};}
const rafRequest=requestAnimationFrame.bind(window),rafCancel=cancelAnimationFrame.bind(window),rafs=new Set();window.requestAnimationFrame=callback=>{let id;id=rafRequest(at=>{rafs.delete(id);if(!silentCallbacks)callback(at);});rafs.add(id);return id;};window.cancelAnimationFrame=id=>{rafs.delete(id);rafCancel(id);};
let at=performance.now(),manualClock=false;const now=()=>manualClock?at:performance.now();
let example=createApplicationMediaExample(source,containers,{now,beforeApproval(){if(approvalMode==='close'){approvalMode='normal';example.stop();}}});
function pixels(key){const canvas=containers[key].querySelector('canvas');return canvas?[...canvas.getContext('2d').getImageData(0,0,1,1).data]:[0,0,0,0];}
function reset(){example.stop();manualClock=false;approvalMode='normal';drawMode='normal';drawObserver=undefined;playMode='normal';silentCallbacks=false;example=createApplicationMediaExample(source,containers,{now,beforeApproval(){if(approvalMode==='close'){approvalMode='normal';example.stop();}}});}
globalThis.fixture={source,containers,pixels,reset,get example(){return example;},get captureCalls(){return captureCalls;},get tracks(){return tracks;},get videos(){return videos;},get nativeFrames(){return frames.size;},get nativeRafs(){return rafs.size;},set silentCallbacks(v){silentCallbacks=v;},set playMode(v){playMode=v;},set drawMode(v){drawMode=v;},set drawObserver(v){drawObserver=v;},set approvalMode(v){approvalMode=v;},set color(v){color=v;},clock(value){manualClock=true;at=value;},releasePlays(){playResolvers.splice(0).forEach(resolve=>resolve());},get deferredPlays(){return playResolvers.length;},finish(){example.stop();clearInterval(paints);},api:createBrowserApplicationMedia};
document.querySelector('#share').onclick=async()=>{example.setConsent('first','source',true);example.setConsent('first','sink',true);const result=await example.start('first')?.ready;document.querySelector('#status').textContent=result?'First display shared.':'Display unavailable. Try again.';};document.querySelector('#stop').onclick=()=>{example.stop();document.querySelector('#status').textContent='Displays stopped.';};globalThis.ready=true;
</script></html>`;
const html = legacy ? oldHtml : newHtml;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  if (!/^\/@101\/(device-model|device-runtime|transport-webrtc|transport-websocket|device-web|vision|connect)\/(dist|examples)\/[a-z0-9-]+\.js$/.test(path)) { response.writeHead(404); response.end(); return; }
  const [, , name, kind, file] = path.split('/');
  const filePath = workspace ? kind === 'examples' ? join(compiled, 'examples/device-pipelines', file) : join(compiled, 'packages', name, 'src', file) : join(consumer, 'node_modules', path);
  try { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(filePath)); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, results = [];
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage(), errors = [], foreign = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (!request.url().startsWith(origin + '/')) foreign.push(request.url()); });
      await page.goto(origin); await page.waitForFunction(() => globalThis.ready);
      if (!legacy) {
        const checks=[];
        const denied=await page.evaluate(async()=>{const f=globalThis.fixture;const initial=await f.example.start('first').ready;f.example.setConsent('first','source',true);const one=await f.example.start('first').ready;f.example.setConsent('first','source',false);f.example.setConsent('first','sink',true);const other=await f.example.start('first').ready;return{initial,one,other,calls:f.captureCalls,children:f.containers.first.children.length};});
        assert.deepEqual(denied,{initial:false,one:false,other:false,calls:0,children:1});checks.push('both-separate-owner-decisions-before-native-capture');
        await page.locator('#share').focus();await page.keyboard.press('Space');
        await page.waitForFunction(()=>globalThis.fixture.example.state().bindings.first.state!=='opening');
        const opened=await page.evaluate(()=>({state:globalThis.fixture.example.state(),settings:globalThis.fixture.tracks.at(-1).getSettings(),native:globalThis.fixture.tracks.at(-1) instanceof MediaStreamTrack}));
        assert.equal(opened.native,true);
        if(opened.settings.frameRate===undefined){
          assert.equal(opened.state.bindings.first.state,'stopped');assert.equal(opened.state.bindings.first.reason,'unsupported');
          assert.equal(opened.state.controller.captures,0);assert.equal(opened.state.controller.outputs,0);checks.push('honest-missing-native-format-unsupported');
        }else{
          assert.equal(opened.state.bindings.first.state,'active');
          await page.waitForFunction(()=>globalThis.fixture.pixels('first')[0]>200&&globalThis.fixture.example.state().bindings.first.frames>0);
          const first=await page.evaluate(()=>({pixels:globalThis.fixture.pixels('first'),denied:globalThis.fixture.pixels('second'),calls:globalThis.fixture.captureCalls,label:globalThis.fixture.containers.first.querySelector('canvas').getAttribute('aria-label')}));
          assert.deepEqual(first.pixels,[255,0,0,255]);assert.equal(first.denied[3],0);assert.equal(first.calls,1);assert.equal(first.label,'First application display');checks.push('actual-runtime-native-track-decoded-authorized-pixels','separate-denied-recipient-no-output');
          const second=await page.evaluate(async()=>{globalThis.fixture.example.setConsent('second','source',true);globalThis.fixture.example.setConsent('second','sink',true);return await globalThis.fixture.example.start('second').ready;});assert.equal(second,true);
          await page.waitForFunction(()=>globalThis.fixture.pixels('second')[0]>200);assert.equal(await page.evaluate(()=>globalThis.fixture.captureCalls),1);checks.push('two-current-recipient-routes-one-native-capture');
          const revoked=await page.evaluate(()=>{const f=globalThis.fixture;const owned=f.containers.first.querySelector('canvas');f.example.setConsent('first','sink',false);return{first:f.pixels('first'),second:f.pixels('second'),ownedSize:owned.width,children:f.containers.first.children.length,outputs:f.example.state().controller.outputs};});
          assert.equal(revoked.first[3],0);assert.equal(revoked.second[3],255);assert.equal(revoked.ownedSize,1);assert.equal(revoked.children,1);assert.equal(revoked.outputs,1);checks.push('revoke-one-preserves-other-and-caller-container');
          await page.evaluate(()=>{globalThis.fixture.drawMode='revoke';globalThis.fixture.color='rgb(0,0,255)';});
          await page.waitForFunction(()=>globalThis.fixture.example.state().controller.outputs===0);assert.equal(await page.evaluate(()=>globalThis.fixture.pixels('second')[3]),0);checks.push('staged-native-draw-reentrant-revoke-no-visible-copy');
          const narrowed=await page.evaluate(async()=>{
            const f=globalThis.fixture;f.example.stop();f.silentCallbacks=true;
            let calls=0,expiry=0;const now=()=>performance.now();const approve=request=>{if(request.role==='source'){calls++;if(calls===1)expiry=now()+1000;else expiry=Math.min(expiry,now()+80);}return{request,grant:{expiresAt:expiry,maxHz:10,maxAgeMs:1000}};};
            const media=f.api({applicationId:'timer',sessionId:'session',clockDomain:'local',now,authorizeSource:approve,authorizeSink:approve});
            const source=media.registerSource({sourceId:'media:timer-source',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});
            const binding=media.bind({source,outputId:'media:timer-output',ownerPrincipalId:'alice',container:f.containers.first,label:'Timer output'});
            const ready=await binding.ready;await new Promise(resolve=>setTimeout(resolve,180));const status=binding.status();media.close();f.silentCallbacks=false;return{ready,status};
          });
          assert.equal(narrowed.ready,true);assert.equal(narrowed.status.state,'stopped','Earlier activation grant must clear output even while native frame/animation callbacks are quiet');checks.push('current-activation-expiry-owned-timer-with-quiet-native-callbacks');
          const domClose=await page.evaluate(async()=>{
            const f=globalThis.fixture;f.example.stop();
            const now=()=>performance.now(),approve=request=>({request,grant:{expiresAt:now()+1000,maxHz:10,maxAgeMs:1000}});
            const media=f.api({applicationId:'dom',sessionId:'session',clockDomain:'local',now,authorizeSource:approve,authorizeSink:approve});
            const source=media.registerSource({sourceId:'media:dom-source',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});
            const create=document.createElement.bind(document),owned=[];document.createElement=(name,...args)=>{const element=create(name,...args);if(name==='canvas'){owned.push(element);media.close();}return element;};
            try{const binding=media.bind({source,outputId:'media:dom-output',ownerPrincipalId:'alice',container:f.containers.first,label:'DOM output'});const ready=await binding.ready;await new Promise(resolve=>setTimeout(resolve,20));return{ready,closed:media.status().closed,backings:owned.map(canvas=>[canvas.width,canvas.height]),children:f.containers.first.children.length};}
            finally{document.createElement=create;media.close();}
          });
          assert.equal(domClose.ready,false);assert.equal(domClose.closed,true);assert.equal(domClose.children,1);assert.ok(domClose.backings.every(([width,height])=>width===1&&height===1),'A late native DOM callback must retire SDK-created backing stores');checks.push('native-dom-callback-close-no-late-owned-allocation');
          const renewed=await page.evaluate(async()=>{
            const f=globalThis.fixture;f.example.stop();let phase='initial',badClock=false;let expiry=performance.now()+1500;
            const now=()=>badClock?NaN:performance.now();const approve=request=>phase==='deny'&&request.role==='sink'?undefined:{request,grant:{expiresAt:phase==='long'?performance.now()+2000:expiry,maxHz:10,maxAgeMs:1000}};
            const media=f.api({applicationId:'renew',sessionId:'session',clockDomain:'local',now,authorizeSource:approve,authorizeSink:approve});
            const source=media.registerSource({sourceId:'media:renew-source',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});
            const bind=id=>media.bind({source,outputId:id,ownerPrincipalId:'alice',container:f.containers.first,label:'Renew output'});
            const first=bind('media:renew-first');const ready=await first.ready;const original=first.status().expiresAt;phase='long';const later=first.renew(),same=first.status().expiresAt===original;
            phase='short';expiry=performance.now()+80;f.silentCallbacks=true;const shorter=first.renew();await new Promise(resolve=>setTimeout(resolve,180));const stopped=first.status().state;f.silentCallbacks=false;
            phase='initial';expiry=performance.now()+1500;const second=bind('media:renew-second');const secondReady=await second.ready;phase='deny';const denied=second.renew(),deniedState=second.status().state;
            phase='initial';expiry=performance.now()+1500;const third=bind('media:renew-third');const thirdReady=await third.ready;badClock=true;const closed=media.status();badClock=false;const permanent=media.status().closed;media.close();
            return{ready,later,same,shorter,stopped,secondReady,denied,deniedState,thirdReady,closed,permanent};
          });
          assert.equal(renewed.ready,true);assert.equal(renewed.later,true);assert.equal(renewed.same,true);assert.equal(renewed.shorter,true);assert.equal(renewed.stopped,'stopped');assert.equal(renewed.secondReady,true);assert.equal(renewed.denied,false);assert.equal(renewed.deniedState,'stopped');assert.equal(renewed.thirdReady,true);assert.equal(renewed.closed.closed,true);assert.equal(renewed.closed.outputs,0);assert.equal(renewed.permanent,true);checks.push('fresh-renewal-cannot-extend-opening-ceiling-earlier-timer-and-denial','invalid-clock-closes-live-native-output-permanently');
          const lifetime=await page.evaluate(async()=>{
            const f=globalThis.fixture;f.example.stop();let at=1000;const approve=request=>({request,grant:{expiresAt:at+30000,maxHz:10,maxAgeMs:1000}});
            const media=f.api({applicationId:'lifetime',sessionId:'session',clockDomain:'local',now:()=>at,authorizeSource:approve,authorizeSink:approve});
            const source=media.registerSource({sourceId:'media:lifetime-source',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});
            const first=media.bind({source,outputId:'media:lifetime-first',ownerPrincipalId:'alice',container:f.containers.first,label:'Lifetime first'});const firstReady=await first.ready;
            at=2000;const second=media.bind({source,outputId:'media:lifetime-second',ownerPrincipalId:'bob',container:f.containers.second,label:'Lifetime second'});const secondReady=await second.ready;const laterGrant=second.status().expiresAt;
            at=31000;await new Promise(resolve=>setTimeout(resolve,80));const state=media.status();media.close();return{firstReady,secondReady,laterGrant,state,outputs:[first.status().state,second.status().state]};
          });assert.equal(lifetime.firstReady,true);assert.equal(lifetime.secondReady,true);assert.ok(lifetime.laterGrant>31000);assert.equal(lifetime.state.outputs,0);assert.equal(lifetime.state.captures,0);assert.deepEqual(lifetime.outputs,['stopped','stopped']);checks.push('shared-capture-thirty-second-ceiling-survives-later-recipient-grant');
          const freshAdmission=await page.evaluate(async()=>{
            const f=globalThis.fixture;f.example.stop();f.color='rgb(255,0,0)';f.source.getContext('2d').fillStyle='rgb(255,0,0)';f.source.getContext('2d').fillRect(0,0,64,48);
            const cases=[];
            for(const boundary of ['owner','staging']){
              let at=1000,phase='opening',shifted=false;
              const grant=()=>({expiresAt:20000,maxHz:10,maxAgeMs:phase==='opening'?1000:1});
              const sourceApprove=request=>{if(phase==='narrow'&&boundary==='owner'&&!shifted){at+=20;shifted=true;}return{request,grant:grant()};};
              const media=f.api({applicationId:'age-'+boundary,sessionId:'session',clockDomain:'local',now:()=>at,authorizeSource:sourceApprove,authorizeSink:request=>({request,grant:grant()})});
              try{
                const source=media.registerSource({sourceId:'media:age-source',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});
                const binding=media.bind({source,outputId:'media:age-output',ownerPrincipalId:'alice',container:f.containers.first,label:'Fresh output'});
                const ready=await binding.ready;phase='narrow';
                f.drawObserver=(_canvas,image)=>{if(boundary==='staging'&&image instanceof HTMLVideoElement&&!shifted){at+=20;shifted=true;}};
                const deadline=performance.now()+2000;while(!shifted&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
                const stale=binding.status(),alpha=f.pixels('first')[3];at=1120;
                const freshDeadline=performance.now()+2000;while(binding.status().frames===stale.frames&&performance.now()<freshDeadline)await new Promise(resolve=>setTimeout(resolve,5));
                cases.push({boundary,ready,shifted,staleFrames:stale.frames,staleAlpha:alpha,freshFrames:binding.status().frames-stale.frames,pixels:f.pixels('first')});
              }finally{f.drawObserver=undefined;media.close();}
            }
            let committedAge=1000,phase='opening',shifted=false;
            const commitApprove=request=>({request,grant:{expiresAt:20000,maxHz:10,maxAgeMs:phase==='opening'?1000:1}});
            const committed=f.api({applicationId:'age-commit',sessionId:'session',clockDomain:'local',now:()=>committedAge,authorizeSource:commitApprove,authorizeSink:commitApprove});
            let postCopy;
            try{
              const source=committed.registerSource({sourceId:'media:commit-source',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});
              const binding=committed.bind({source,outputId:'media:commit-output',ownerPrincipalId:'alice',container:f.containers.first,label:'Current output'});
              const ready=await binding.ready;phase='narrow';
              f.drawObserver=(canvas,image)=>{if(canvas.parentElement===f.containers.first&&image instanceof HTMLCanvasElement&&!shifted){committedAge+=20;shifted=true;}};
              const deadline=performance.now()+2000;while(!shifted&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
              postCopy={ready,shifted,state:binding.status().state,frames:binding.status().frames,alpha:f.pixels('first')[3],outputs:committed.status().outputs,captures:committed.status().captures};
            }finally{f.drawObserver=undefined;committed.close();}
            let allowed=true;f.playMode='late';const now=()=>performance.now(),approve=request=>({request,grant:{expiresAt:now()+5000,maxHz:10,maxAgeMs:1000}});
            const media=f.api({applicationId:'late-denial',sessionId:'session',clockDomain:'local',now,authorizeSource:request=>allowed?approve(request):undefined,authorizeSink:approve});
            try{
              const source=media.registerSource({sourceId:'media:late-denial-source',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});
              const binding=media.bind({source,outputId:'media:late-denial-output',ownerPrincipalId:'alice',container:f.containers.first,label:'Declined output'});
              const deadline=performance.now()+1500;while(f.deferredPlays!==1&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
              const realPlayDeferred=f.deferredPlays===1;allowed=false;f.releasePlays();const ready=await binding.ready;
              return{cases,postCopy,lateDenial:{realPlayDeferred,ready,reason:binding.status().reason,outputs:media.status().outputs,captures:media.status().captures,pending:media.status().pending}};
            }finally{f.playMode='normal';f.releasePlays();media.close();}
          });
          assert.deepEqual({cases:freshAdmission.cases.map(value=>({boundary:value.boundary,ready:value.ready,shifted:value.shifted,staleFrames:value.staleFrames,staleAlpha:value.staleAlpha})),lateDenial:freshAdmission.lateDenial},{cases:[
            {boundary:'owner',ready:true,shifted:true,staleFrames:0,staleAlpha:0},{boundary:'staging',ready:true,shifted:true,staleFrames:0,staleAlpha:0}],
            lateDenial:{realPlayDeferred:true,ready:false,reason:'denied',outputs:0,captures:0,pending:0}},
          'Fresh owner and native callback boundaries enforce the current age limit and report late consent denial truthfully');
          assert.ok(freshAdmission.cases.every(value=>value.freshFrames>0&&value.pixels[0]>200&&value.pixels[3]===255),'A later fresh native notification still reaches each approved output');
          assert.deepEqual(freshAdmission.postCopy,{ready:true,shifted:true,state:'stopped',frames:0,alpha:0,outputs:0,captures:0},'A stale native copy callback retires owned output instead of retaining an active detached backing');
          checks.push('fresh-owner-age-narrowing-before-native-pixel-copy','native-staging-callback-age-fence-before-visible-copy','late-current-source-denial-honest-status','late-native-copy-age-retirement-without-active-detached-output');
        }
        const stopped=await page.evaluate(()=>{globalThis.fixture.example.stop();return{tracks:globalThis.fixture.tracks.map(track=>track.readyState),videos:globalThis.fixture.videos.every(video=>video.srcObject===null),state:globalThis.fixture.example.state(),frames:globalThis.fixture.nativeFrames,rafs:globalThis.fixture.nativeRafs,source:[globalThis.fixture.source.width,globalThis.fixture.source.height],children:[globalThis.fixture.containers.first.children.length,globalThis.fixture.containers.second.children.length]};});
        assert.ok(stopped.tracks.every(state=>state==='ended'));assert.equal(stopped.videos,true);assert.equal(stopped.frames,0);assert.equal(stopped.rafs,0);assert.deepEqual(stopped.source,[64,48]);assert.deepEqual(stopped.children,[1,1]);checks.push('sdk-native-track-video-frame-raf-teardown-source-borrowed');
        const closeDuringApproval=await page.evaluate(async()=>{globalThis.fixture.reset();globalThis.fixture.example.setConsent('first','source',true);globalThis.fixture.example.setConsent('first','sink',true);const before=globalThis.fixture.captureCalls;globalThis.fixture.approvalMode='close';const ready=await globalThis.fixture.example.start('first').ready;return{ready,newCaptures:globalThis.fixture.captureCalls-before,closed:globalThis.fixture.example.state().closed};});assert.deepEqual(closeDuringApproval,{ready:false,newCaptures:0,closed:true});checks.push('reentrant-owner-callback-close-before-capture');
        await page.evaluate(()=>{globalThis.fixture.reset();globalThis.fixture.playMode='late';globalThis.fixture.example.setConsent('first','source',true);globalThis.fixture.example.setConsent('first','sink',true);globalThis.fixture.example.start('first');});
        await page.waitForFunction(()=>globalThis.fixture.deferredPlays===1);
        const late=await page.evaluate(async()=>{globalThis.fixture.example.stop();globalThis.fixture.releasePlays();await new Promise(resolve=>setTimeout(resolve,30));return{state:globalThis.fixture.example.state().controller,tracks:globalThis.fixture.tracks.every(track=>track.readyState==='ended'),children:globalThis.fixture.containers.first.children.length};});
        assert.equal(late.state.closed,true);assert.equal(late.state.outputs,0);assert.equal(late.state.pending,0);assert.equal(late.tracks,true);assert.equal(late.children,1);checks.push('actual-native-play-late-resolution-never-reactivates');
        const scope=await page.evaluate(async()=>{
          const f=globalThis.fixture;f.example.stop();let mode='copied',saved,decisions=0;
          const approve=request=>{decisions++;const grant={expiresAt:performance.now()+1000,maxHz:10,maxAgeMs:1000};if(request.role==='source'){if(mode==='copied')return{request:{...request},grant};if(mode==='save'){saved={request,grant};return saved;}if(mode==='replay')return saved;}return mode==='save'&&request.role==='sink'?undefined:{request,grant};};
          const media=f.api({applicationId:'scope',sessionId:'session',clockDomain:'local',now:()=>performance.now(),authorizeSource:approve,authorizeSink:approve});
          const source=media.registerSource({sourceId:'media:scope-source',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});
          const before=f.captureCalls;const bind=(handle,id,container)=>media.bind({source:handle,outputId:id,ownerPrincipalId:'alice',container,label:'Scope output'});
          const copiedHandle=await bind({...source},'media:copy',f.containers.first).ready;
          const copiedGrant=await bind(source,'media:copy-grant',f.containers.first).ready;
          mode='save';const save=await bind(source,'media:save-grant',f.containers.first).ready;mode='replay';const replay=await bind(source,'media:replay-grant',f.containers.first).ready;
          const second=f.api({applicationId:'other',sessionId:'session',clockDomain:'local',now:()=>performance.now(),authorizeSource:approve,authorizeSink:approve});
          const foreign=await second.bind({source,outputId:'media:foreign',ownerPrincipalId:'alice',container:f.containers.first,label:'Foreign'}).ready;
          const duplicate=second.registerSource({sourceId:'media:duplicate',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});second.close();
          const huge=document.createElement('canvas');huge.width=1048577;huge.height=1;const oversized=media.registerSource({sourceId:'media:huge',ownerPrincipalId:'source-owner',canvas:huge,maxHz:10});huge.width=1;
          const secondCanvas=document.createElement('canvas');secondCanvas.width=64;secondCanvas.height=48;const secondSource=media.registerSource({sourceId:'media:second-source',ownerPrincipalId:'source-owner',canvas:secondCanvas,maxHz:10});
          const third=media.registerSource({sourceId:'media:third-source',ownerPrincipalId:'source-owner',canvas:document.createElement('canvas'),maxHz:10});
          const noCaptures=f.captureCalls-before;mode='fresh';const outputs=[];
          for(let i=0;i<4;i++)outputs.push(bind(source,'media:bounded-'+i,document.createElement('section')));
          const fifth=bind(source,'media:bounded-5',document.createElement('section'));const cap=fifth.status();const reserved=media.status();media.close();await Promise.all(outputs.map(binding=>binding.ready));await new Promise(resolve=>setTimeout(resolve,30));
          return{copiedHandle,copiedGrant,save,replay,foreign,duplicate:duplicate===undefined,oversized:oversized===undefined,secondSource:!!secondSource,third:third===undefined,noCaptures,cap,reserved,final:media.status(),decisions};
        });
        for(const key of ['copiedHandle','copiedGrant','save','replay','foreign'])assert.equal(scope[key],false);
        for(const key of ['duplicate','oversized','secondSource','third'])assert.equal(scope[key],true);
        assert.equal(scope.noCaptures,0);assert.equal(scope.cap.reason,'capacity');assert.equal(scope.reserved.outputs,4);assert.ok(scope.reserved.pending<=2);assert.equal(scope.final.outputs,0);assert.equal(scope.final.pending,0);checks.push('opaque-source-and-request-bound-grant-replay-denial','one-megapixel-two-source-four-output-bounds-before-native-work');
        await page.evaluate(()=>{globalThis.fixture.reset();globalThis.fixture.playMode='late';globalThis.fixture.example.setConsent('first','source',true);globalThis.fixture.example.setConsent('first','sink',true);globalThis.fixture.pendingFirst=globalThis.fixture.example.start('first');});
        await page.waitForFunction(()=>globalThis.fixture.deferredPlays===1);
        await page.evaluate(()=>{const f=globalThis.fixture;f.pendingFirst.stop();f.example.setConsent('second','source',true);f.example.setConsent('second','sink',true);f.pendingSecond=f.example.start('second');});
        await page.waitForFunction(()=>globalThis.fixture.deferredPlays===2);
        const bounded=await page.evaluate(async()=>{const f=globalThis.fixture;f.pendingSecond.stop();const before=f.captureCalls;const third=f.example.start('first');const ready=await third.ready;const state=f.example.state().controller;f.example.stop();f.releasePlays();await new Promise(resolve=>setTimeout(resolve,30));return{ready,reason:third.status().reason,newCaptures:f.captureCalls-before,pending:state.pending,final:f.example.state().controller};});
        assert.equal(bounded.ready,false);assert.equal(bounded.reason,'capacity');assert.equal(bounded.newCaptures,0);assert.equal(bounded.pending,2);assert.equal(bounded.final.pending,0);checks.push('two-unsettled-native-play-attempt-cap-reserved-before-callback');
        await page.evaluate(()=>{
          const f=globalThis.fixture;f.example.stop();f.playMode='late';const now=()=>performance.now(),approve=request=>({request,grant:{expiresAt:now()+5000,maxHz:10,maxAgeMs:1000}});
          const media=f.api({applicationId:'signal',sessionId:'session',clockDomain:'local',now,authorizeSource:approve,authorizeSink:approve});const source=media.registerSource({sourceId:'media:signal-source',ownerPrincipalId:'source-owner',canvas:f.source,maxHz:10});const abort=new AbortController();
          f.abortProbe={media,abort,binding:media.bind({source,outputId:'media:signal-output',ownerPrincipalId:'alice',container:f.containers.first,label:'Signal output',signal:abort.signal})};
        });
        await page.waitForFunction(()=>globalThis.fixture.deferredPlays===1);
        const aborted=await page.evaluate(async()=>{const f=globalThis.fixture,p=f.abortProbe;p.abort.abort();const ready=await p.binding.ready;const state=p.binding.status();f.releasePlays();await new Promise(resolve=>setTimeout(resolve,30));const final=p.media.status();p.media.close();return{ready,state,final};});
        assert.equal(aborted.ready,false);assert.equal(aborted.state.reason,'cancelled');assert.equal(aborted.final.outputs,0);assert.equal(aborted.final.pending,0);checks.push('abort-signal-retires-real-native-open-before-late-resolution');
        await page.evaluate(()=>{globalThis.fixture.reset();globalThis.fixture.playMode='late';globalThis.fixture.example.setConsent('first','source',true);globalThis.fixture.example.setConsent('first','sink',true);globalThis.fixture.deadlineBinding=globalThis.fixture.example.start('first');});
        await page.waitForFunction(()=>globalThis.fixture.deferredPlays===1);
        const deadline=await page.evaluate(async()=>{const f=globalThis.fixture;const ready=await f.deadlineBinding.ready;const status=f.deadlineBinding.status(),state=f.example.state().controller;f.releasePlays();await new Promise(resolve=>setTimeout(resolve,30));return{ready,status,state,final:f.example.state().controller};});
        assert.equal(deadline.ready,false);assert.equal(deadline.status.reason,'failed');assert.equal(deadline.state.outputs,0);assert.equal(deadline.state.pending,1);assert.equal(deadline.final.pending,0);assert.equal(await page.evaluate(()=>globalThis.fixture.tracks.filter(track=>track.readyState==='live').length),0);checks.push('two-second-open-deadline-retains-bounded-unsettled-slot-and-cleans-native-resources');
        const failed=await page.evaluate(async()=>{const f=globalThis.fixture;f.reset();f.playMode='reject';f.example.setConsent('first','source',true);f.example.setConsent('first','sink',true);const binding=f.example.start('first');const ready=await binding.ready;return{ready,reason:binding.status().reason,live:f.tracks.filter(track=>track.readyState==='live').length};});
        assert.equal(failed.ready,false);assert.equal(failed.reason,'failed','Host/native play rejection is a failed open, not missing format support');assert.equal(failed.live,0);checks.push('failed-native-open-honest-status-and-cleanup');
        const retry=await page.evaluate(async()=>{const f=globalThis.fixture;f.playMode='normal';const binding=f.example.start('first');const ready=await binding.ready;return{ready,status:binding.status()};});assert.equal(retry.ready,opened.settings.frameRate!==undefined);checks.push('fresh-explicit-retry-after-failed-open');
        if(retry.ready){
          const disconnect=await page.evaluate(()=>{globalThis.fixture.tracks.at(-1).stop();return true;});assert.equal(disconnect,true);
          await page.waitForFunction(()=>globalThis.fixture.example.state().controller.outputs===0);assert.equal(await page.evaluate(()=>globalThis.fixture.pixels('first')[3]),0);checks.push('native-track-end-retires-route-and-output');
        }
        await page.evaluate(()=>globalThis.fixture.finish());assert.deepEqual(errors,[]);assert.deepEqual(foreign,[]);
        results.push({engine:engine.name(),version:browser.version(),status:'pass',nativeFormat:opened.settings.frameRate===undefined?'unsupported-missing-native-frame-rate':'supported',checks,errors,foreign});continue;
      }
      const producer = await page.evaluate(() => globalThis.runProducer());
      assert.equal(producer.track.native, true); assert.equal(producer.track.kind, 'video'); assert.equal(producer.track.readyState, 'live');
      assert.ok(producer.decodedPixel[0] > 200 && producer.decodedPixel[3] === 255, 'Actual native decoded source pixels');
      if (producer.track.settings.frameRate !== undefined) assert.equal(producer.compatibleNativePlan, true, 'Actual source probe must negotiate the declared local format');
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
      results.push({ engine: engine.name(), version: browser.version(), producer, nativeFormat: producer.compatibleNativePlan ? 'supported' : 'missing-actual-frame-rate', errors, foreign });
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ profile: 'local-application-video/1', proof: legacy ? 'old-installed-sdk-native-producer' : workspace ? 'owned-worker-public-resolver' : 'ordinary-installed-sdk-public-import', qaToolSha256:createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'), ...(packed?{producer:packed}:{}), results, limits:['generated local application video only; separate current host source/sink grants','no camera/microphone/screen/RTC/phone/OS or encoded network claim','cooperative host isolation, not a same-origin sandbox','native browser buffering opaque; caps cover SDK-owned allocations and pending work'] }, null, 2));
  if(legacy){assert.ok(results.some(result => result.producer.compatibleNativePlan), 'A genuine compatible producer is required');assert.ok(results.filter(result => result.producer.compatibleNativePlan).every(result => result.producer.outputAlpha > 0), 'Compatible descriptions do not produce an authorized output route in the old SDK');}
  else assert.ok(results.some(result=>result.nativeFormat==='supported'),'A supported real native producer/output is required');
} finally { await new Promise(resolve => server.close(resolve)); if(compiled)rmSync(compiled,{recursive:true,force:true}); }
