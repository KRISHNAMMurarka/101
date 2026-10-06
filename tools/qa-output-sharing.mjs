#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync, lstatSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { chromium, firefox, webkit } from 'playwright';

const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2), hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 2 && ['--sdk-root', '--feature-red'].includes(args[0]), 'Use --source, --sdk-root OWNED_CONSUMER, or --feature-red OWNED_CONSUMER');
assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
const sourceMode = args[0] === '--source', feature = args[0] === '--feature-red';
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const paths = ['packages/device-runtime/src/output-sharing.ts', 'packages/device-runtime/src/output-sharing.test.ts', 'packages/device-web/src/output-sharing.ts',
  'packages/device-web/src/output-sharing.test.ts', 'examples/device-pipelines/output-sharing.ts', 'tools/qa-output-sharing.mjs'];
const pins = Object.fromEntries(paths.map(path => [path, hash(readFileSync(join(root, path)))])), installed = new Map(), compilerPins = new Map();
const require = createRequire(import.meta.url), compilerMain = realpathSync(require.resolve('typescript'));
for (const path of [compilerMain, realpathSync(join(dirname(compilerMain), '..', 'package.json'))]) compilerPins.set(path, hash(readFileSync(path)));
function json(path, cap) { const bytes = readFileSync(path); assert.ok(bytes.length <= cap); return JSON.parse(bytes.toString('utf8')); }
function inventory(directory) {
  const result = []; let visits = 0;
  function walk(path) { assert.equal(realpathSync(path), path); assert.equal(lstatSync(path).isSymbolicLink(), false);
    for (const item of readdirSync(path).sort()) { assert.ok(++visits <= 2048); const full = join(path, item), stat = lstatSync(full);
      assert.equal(realpathSync(full), full); assert.equal(stat.isSymbolicLink(), false); if (stat.isDirectory()) walk(full); else { assert.ok(stat.isFile() && result.length < 1024); result.push(relative(directory, full)); } } }
  walk(directory); return result.sort();
}
let compiled, consumer, probeDirectory, provenance;
try {
  if (sourceMode) {
    compiled = mkdtempSync(join(tmpdir(), '101-output-sharing-source-'));
    const program = ts.createProgram([join(root, 'packages/connect/src/index.ts'), join(root, paths[4])], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmitOnError: true, rewriteRelativeImportExtensions: true,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: [], rootDir: root, outDir: compiled,
      paths: Object.fromEntries(names.map(name => ['@101/' + name, [join(root, 'packages', name, 'src/index.ts')]])) });
    const diagnostics = ts.getPreEmitDiagnostics(program); assert.equal(diagnostics.length, 0, diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
    const source = {}; for (const file of program.getSourceFiles()) { if (file.isDeclarationFile) { compilerPins.set(realpathSync(file.fileName), hash(readFileSync(file.fileName))); continue; }
      const path = relative(root, file.fileName); assert.ok(path === paths[4] || names.some(name => path.startsWith('packages/' + name + '/src/') && !path.endsWith('.test.ts'))); source[path] = hash(readFileSync(file.fileName)); }
    assert.ok(Object.keys(source).length <= 256); const emitted = program.emit(); assert.equal(emitted.emitSkipped, false); assert.equal(emitted.diagnostics.length, 0);
    provenance = { mode: 'owned-worker-public-source-resolver', installedSdkClaim: false, source, compiler: ts.version };
  } else {
    consumer = realpathSync(resolve(args[1])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    const receipt = json(join(consumer, 'receipt.json'), 512 * 1024); assert.equal(receipt.status, 'pass');
    const manifestBytes = readFileSync(receipt.manifest.path); assert.ok(manifestBytes.length <= 2 * 1024 * 1024); assert.equal(hash(manifestBytes), receipt.manifest.sha256);
    const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, receipt.source.tree); assert.deepEqual(manifest.source.sha256, receipt.source.sha256);
    assert.match(manifest.source.tree, /^[0-9a-f]{40}$/); assert.equal(manifest.packages.length, 7); assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const sources = Object.entries(manifest.source.sha256); assert.ok(sources.length > 0 && sources.length <= 256);
    for (const [path, pin] of sources) { assert.match(path, /^(LICENSE|schemas\/device-descriptor\.schema\.json|(packages|examples)\/[A-Za-z0-9_./-]+)$/); assert.equal(path.includes('..'), false);
      assert.equal(hash(execFileSync('git', ['show', manifest.source.tree + ':' + path], { cwd: root, maxBuffer: 2 * 1024 * 1024 })), pin); }
    for (const name of names) { const item = manifest.packages.find(item => item.name === '@101/' + name); assert.ok(item?.files.length && item.files.length <= 1024);
      const directory = join(consumer, 'node_modules', item.name); assert.deepEqual(inventory(directory), item.files.map(file => file.path).sort());
      for (const file of item.files) { const path = resolve(directory, file.path); assert.ok(path.startsWith(directory + '/')); assert.equal(hash(readFileSync(path)), file.sha256); installed.set(path, file.sha256); } }
    if (!feature) {
      for (const path of [paths[0], paths[2], paths[4], 'packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/index.ts',
        'packages/device-runtime/src/application-views.ts', 'packages/device-web/src/index.ts', 'packages/device-web/src/application-audio.ts', 'packages/device-web/src/browser-camera.ts'])
        assert.equal(hash(readFileSync(join(root, path))), manifest.source.sha256[path]);
      probeDirectory = mkdtempSync(join(consumer, 'output-sharing-types-')); const probe = join(probeDirectory, 'consumer.mts');
      writeFileSync(probe, "import {createOutputSharingController,createBrowserOutputSharing} from '@101/connect';\nimport {createOutputSharingExample} from '@101/connect/examples/output-sharing';\nvoid createOutputSharingController;void createBrowserOutputSharing;const example=createOutputSharingExample(document.createElement('section'),{ownerSignal:new AbortController().signal});void example.stop();\n");
      const program = ts.createProgram([probe], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] });
      const diagnostics = ts.getPreEmitDiagnostics(program); assert.equal(diagnostics.length, 0, diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
      const library = realpathSync(dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }))); assert.ok(program.getSourceFiles().length <= 512);
      for (const file of program.getSourceFiles()) { const path = realpathSync(file.fileName), pin = hash(readFileSync(path));
        assert.ok(path === probe || installed.get(path) === pin || file.isDeclarationFile && dirname(path) === library && /^lib(?:\.[a-z0-9]+)*\.d\.ts$/.test(relative(library, path))); compilerPins.set(path, pin); }
    }
    provenance = { mode: 'ordinary-installed-seven-sdk', manifest: receipt.manifest, tree: manifest.source.tree, sourcePins: sources.length, installedFiles: installed.size,
      sourceAliases: false, sdkTypeStripping: false, strict: !feature, noUncheckedIndexedAccess: true, skipLibCheck: false };
  }
  const imports = Object.fromEntries(names.map(name => ['@101/' + name, '/@101/' + name + '/dist/index.js']));
  if (!feature) imports['@101/connect/examples/output-sharing'] = '/@101/connect/examples/output-sharing.js';
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned output policies</title><section id="output"><p>Borrowed sentinel</p></section>
<script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import * as api from '@101/connect';
${feature ? '' : "import {createOutputSharingExample} from '@101/connect/examples/output-sharing';"}
const container=document.querySelector('#output'),NativeAudio=globalThis.AudioContext,contexts=[],checks=[],readers=[];let owner,example,approvalAction,upstreamAction,clockAction,clockOffset=0,raw=0;
const started=performance.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function bounded(){if(performance.now()-started>15000)throw Error('owned-policy-fixture-lifetime');}
function check(value,label){bounded();if(!value||checks.length>=32)throw Error(label);checks.push(label);}
if(NativeAudio)globalThis.AudioContext=class extends NativeAudio{constructor(...args){if(contexts.length>=32)throw Error('owned-context-capacity');super(...args);contexts.push(this);}resume(){raw++;try{return super.resume().finally(()=>raw--);}catch(error){raw--;throw error;}}close(){raw++;try{return super.close().finally(()=>raw--);}catch(error){raw--;throw error;}}};
if(typeof AudioNode==='function'){const nativeConnect=AudioNode.prototype.connect;AudioNode.prototype.connect=function(target,...args){if(target===this.context.destination)throw Error('speaker-output-forbidden');return nativeConnect.call(this,target,...args);};}
async function until(fn,ms=1500){const end=performance.now()+ms;let turns=0;while(!fn()){bounded();if(performance.now()>=end||++turns>40)throw Error('actual-output-policy-effect-deadline');example?.tick();await wait(50);}return fn();}
async function reader(stream){const context=new AudioContext({sampleRate:48000}),node=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=2048;node.connect(analyser);const samples=new Float32Array(2048),spectrum=new Float32Array(1024);await context.resume();const result={context,node,analyser,samples,spectrum,stream};readers.push(result);return result;}
function rms(value){value.analyser.getFloatTimeDomainData(value.samples);let sum=0;for(const sample of value.samples){if(!Number.isFinite(sample)||Math.abs(sample)>1)throw Error('native-audio-sample-bound');sum+=sample*sample;}return Math.sqrt(sum/2048);}
function peaks(value){value.analyser.getFloatFrequencyData(value.spectrum);function peak(hz){const center=Math.round(hz*2048/value.context.sampleRate);let maximum=-Infinity;for(let index=center-1;index<=center+1;index++)maximum=Math.max(maximum,value.spectrum[index]);return Math.pow(10,maximum/20);}return{a:peak(480),b:peak(960)};}
async function audioMeasurement(value,accept,label){const started=performance.now(),end=started+1500;let turns=0,last;
while(true){bounded();if(performance.now()>=end||++turns>40)throw Error(label+':'+JSON.stringify({elapsedMs:performance.now()-started,last}));
const sample={rms:rms(value),peaks:peaks(value)};last=sample;
if(performance.now()>=end)throw Error(label+':'+JSON.stringify({elapsedMs:performance.now()-started,last}));
if(accept(sample))return sample;example?.tick();await wait(50);}}
async function retireReaders(){for(const value of readers.splice(0)){value.node.disconnect();value.analyser.disconnect();await value.context.close();}}
async function prefix(){if(!NativeAudio)return{supported:false,reason:'native-private-audio-unavailable'};
const owner=new AbortController(),grant=new AbortController(),expiry=performance.now()+3000,producer=new AudioContext({sampleRate:48000}),oscillator=producer.createOscillator(),gain=producer.createGain(),destination=producer.createMediaStreamDestination();gain.gain.value=.2;oscillator.frequency.value=480;oscillator.connect(gain);gain.connect(destination);oscillator.start();
const runtime=api.createDeviceRuntime({now:()=>performance.now(),authorize:request=>request.principalId==='recipient'&&request.sourceOperation==='subscribe'&&request.sinkOperation==='write'?{expiresAt:expiry,maxHz:20,maxAgeMs:250}:undefined});
let bus,binding,value;try{await producer.resume();bus=api.createBrowserApplicationAudio({runtime,ownerSignal:owner.signal,applicationId:'policy-prefix',sessionId:'session',now:()=>performance.now(),authorizeSource:request=>({request,signal:grant.signal,grant:{expiresAt:expiry,maxHz:20,maxAgeMs:250}}),authorizeOutput:request=>({request,signal:grant.signal,grant:{expiresAt:expiry,maxHz:20,maxAgeMs:250}})});
const source=bus.registerSource({sourceId:'app:policy-prefix',ownerPrincipalId:'producer',producerNode:destination,stream:destination.stream});if(!source)throw Error('genuine-public-source-prefix');binding=bus.bind({source,outputId:'app:policy-prefix-output',ownerPrincipalId:'recipient',purpose:'native-positive-prefix',signal:owner.signal});if(!await binding.ready||!binding.output())throw Error('genuine-public-route-prefix');
const probe=await reader(binding.output());await until(()=>rms(probe)>.08);value={supported:true,rms:rms(probe),sourceOperation:'subscribe',sinkOperation:'write',nativeFormatMetadata:'unknown-unless-emitted',publicNativeProducer:true};
}finally{owner.abort();await bus?.close();runtime.close();oscillator.stop();oscillator.disconnect();gain.disconnect();destination.disconnect();destination.stream.getTracks().forEach(track=>track.stop());await producer.close();await retireReaders();}return value;}
async function reset(){if(example)await example.stop();await retireReaders();owner=new AbortController();approvalAction=upstreamAction=clockAction=undefined;clockOffset=0;
${feature ? '' : "example=createOutputSharingExample(container,{ownerSignal:owner.signal,now(){const at=performance.now()+clockOffset;clockAction?.();return at;},beforeApproval(request){approvalAction?.(request);},beforeUpstream(){upstreamAction?.();}});"}}
function consent(){for(const name of ['native-audio','native-camera','upstream','policy-audio','policy-camera','policy-application','source-audio-a','source-audio-b','source-camera','source-app-a','source-app-b','sink-audio','sink-camera','sink-application'])example.setConsent(name,true);}
function canvas(label,index=0){return container.querySelector('section[aria-label="'+label+'"]')?.querySelectorAll('canvas')[index];}
function pixel(label,x=0,index=0){const value=canvas(label,index);return value?[...value.getContext('2d').getImageData(x,0,1,1).data]:[0,0,0,0];}
globalThis.fixture={prefix,async run(){const producer=await prefix();if(!producer.supported)return{unsupported:producer.reason,missingApi:false};check(producer.rms>.08,'actual-existing-private-audio-producer-and-independent-runtime-route');
${feature ? "return{checks,producer,missingApi:typeof api.createOutputSharingController!=='function'||typeof api.createBrowserOutputSharing!=='function'};" : `
await reset();check(await example.start()===false&&container.children.length===1,'default-deny-before-owned-producers');consent();const producerStarted=await example.start();check(producerStarted,'actual-native-and-authorized-view-producers'+(producerStarted?'':':'+JSON.stringify(example.snapshot())));
check(example.change('audio','mix'),'explicit-audio-mix-policy');await until(()=>example.output());let stream=example.output(),read=await reader(stream);const mixSample=await audioMeasurement(read,value=>value.rms>.12&&value.rms<.21&&value.peaks.b/value.peaks.a>1.4&&value.peaks.b/value.peaks.a<2.8,'actual-native-mix-both-frequency-contributions');const mix=mixSample.rms,mixPeaks=mixSample.peaks;check(mix>.12&&mix<.21&&mixPeaks.b/mixPeaks.a>1.4&&mixPeaks.b/mixPeaks.a<2.8,'actual-native-mix-both-frequency-contributions');
example.denyNextPolicyReview();check(example.change('audio','exclusive')===false&&example.output()===stream&&stream.getTracks().every(track=>track.readyState==='live'),'denied-transfer-retains-native-incumbent');check(example.conflict('audio')===false&&example.output()===stream,'duplicate-slot-conflict-retains-incumbent');
check(example.change('audio','duck'),'explicit-duck-foreground-a');await until(()=>example.output());await retireReaders();stream=example.output();read=await reader(stream);const duckSample=await audioMeasurement(read,value=>value.rms>.04&&value.rms<.11&&value.rms<mix*.8&&value.peaks.b/value.peaks.a>.3&&value.peaks.b/value.peaks.a<.8,'actual-native-duck-retains-reduced-background-frequency');const duck=duckSample.rms,duckPeaks=duckSample.peaks;check(duck<mix*.8&&duckPeaks.b/duckPeaks.a>.3&&duckPeaks.b/duckPeaks.a<.8,'actual-native-duck-retains-reduced-background-frequency');
check(example.change('audio','exclusive',true),'reviewed-exclusive-transfer-to-input-b');await until(()=>example.output());await retireReaders();stream=example.output();read=await reader(stream);const exclusiveSample=await audioMeasurement(read,value=>value.rms>.23&&value.rms<.34&&value.peaks.a<value.peaks.b*.05,'actual-native-exclusive-only-selected-frequency');const exclusive=exclusiveSample.rms,exclusivePeaks=exclusiveSample.peaks;check(exclusive>.23&&exclusive<.34&&exclusivePeaks.a<exclusivePeaks.b*.05,'actual-native-exclusive-only-selected-frequency');
check(!example.snapshot().projectionPublicationReason,'actual-projection-local-publication:'+JSON.stringify({publications:example.snapshot().projectionPublications,reason:example.snapshot().projectionPublicationReason}));
check(example.change('application','layers'),'explicit-ordered-app-layers');example.tick();await until(()=>pixel('Application layers or regions')[0]>110);const layered=pixel('Application layers or regions');check(layered[0]>=120&&layered[0]<=136&&layered[3]===255,'actual-layer-composition-and-no-private-value');
check(example.conflict('application')===false&&pixel('Application layers or regions')[0]===layered[0],'overlap-slot-conflict-preserves-app-output');
// Native premultiplied8bit half-alpha192 readback was observed as191/128. Bound only that one-channel quantization.
const halfAlphaRegion=rgba=>rgba.slice(0,3).every(value=>Math.abs(value-192)<=1)&&rgba[3]>=126&&rgba[3]<=129;
check(example.change('application','regions'),'explicit-disjoint-left-right-regions');example.tick();await until(()=>pixel('Application layers or regions')[0]===64&&halfAlphaRegion(pixel('Application layers or regions',24)));const left=pixel('Application layers or regions',0),right=pixel('Application layers or regions',24),regionsCurrent=left.slice(0,3).every(value=>value===64)&&left[3]===255&&halfAlphaRegion(right);check(regionsCurrent,'actual-region-pixels-stay-in-owned-partitions'+(regionsCurrent?'':':'+JSON.stringify({left,right,state:example.snapshot()})));
check(example.change('application','regions',true),'reviewed-region-slot-transfer');example.tick();await until(()=>pixel('Application layers or regions',24)[0]===64&&halfAlphaRegion(pixel('Application layers or regions')));check(halfAlphaRegion(pixel('Application layers or regions')),'fresh-projection-region-transfer-effect');
let camera={supported:example.snapshot().cameraSupported};if(camera.supported){check(example.change('camera','observers'),'explicit-read-only-camera-observers');example.tick();await until(()=>pixel('Camera observers',0,0)[0]>240&&pixel('Camera observers',0,1)[0]>240);check(pixel('Camera observers',0,0)[3]===255&&pixel('Camera observers',0,1)[3]===255,'actual-native-decoded-raster-fanout');
const opens=example.snapshot().camera.opens;example.setCameraBlue(true);example.tick();await until(()=>pixel('Camera observers',0,1)[2]>240);check(example.revokeObserver('a'),'explicit-observer-output-transfer');example.tick();await until(()=>container.querySelector('section[aria-label="Camera observers"]').querySelectorAll('canvas').length===1&&pixel('Camera observers',0,0)[2]>240);check(example.snapshot().camera.opens===opens,'observer-transfer-does-not-reacquire-or-retarget-camera');camera={supported:true,physicalCamera:false};}
const state=example.snapshot();check(state.borrowedPrivateValueExposed===false&&state.engineTurns>0&&state.viewAuthorizations===2,'one-authoritative-engine-and-exact-reviewed-projections');
// Fresh explicit admission uses the same captured grant deadline; unrelated policy checks may outlive a1s lease.
await retireReaders();check(example.change('audio','exclusive',true),'fresh-exact-exclusive-admission-before-clock-negative');await until(()=>example.output());
const beforeClock=example.output();if(!beforeClock||beforeClock.getTracks().some(track=>track.readyState!=='live'))throw Error('clock-negative-needs-current-actual-private-stream');
let finalObservers=0;upstreamAction=()=>{if(++finalObservers===2)clockOffset=11000;};const afterClock=example.output();upstreamAction=undefined;
check(finalObservers>=2&&clockOffset===11000&&owner.signal.aborted===false&&afterClock===undefined,'final-upstream-clock-only-expiry-blocks-current-private-native-stream');
owner.abort();await example.stop();await retireReaders();check(!example.output()&&container.children.length===1&&container.firstElementChild.textContent==='Borrowed sentinel','owner-revoke-removes-only-owned-output');check(raw===0&&contexts.every(context=>context.state==='closed')&&example.snapshot().sharing.rawPending===0&&example.snapshot().sharing.providerPending===0,'actual-native-promises-and-route-effects-settled');
await reset();consent();check(await example.start(),'fresh-native-and-grant-recovery');approvalAction=()=>{approvalAction=undefined;void example.stop();};check(example.change('application','layers')===false,'policy-review-callback-stop-fences-transfer');await example.stop();check(raw===0&&contexts.every(context=>context.state==='closed')&&container.children.length===1,'reentrant-cancel-cleanup-and-borrowed-child-preservation');
return{checks,producer,mix,duck,exclusive,mixPeaks,duckPeaks,exclusivePeaks,application:{layered,left,right,nativeHalfAlphaColorQuantization:1},camera,upstreamStatusSnapshot:'actual-before-callout-not-refreshed-after',final:example.snapshot(),rawNative:raw,ownedAudioContexts:contexts.length,speakerConnections:0,physicalCamera:false,hardwareInput:false,nativeCaptureClock:'unknown',softwarePolicyEffects:true};
`}
},async finish(){owner?.abort();if(example)await example.stop();await retireReaders();}};globalThis.ready=true;
</script></html>`;
  const server = createServer((request, response) => { if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    if (!/^\/@101\/(device-model|device-runtime|transport-webrtc|transport-websocket|device-web|vision|connect)\/(dist|examples)\/[a-z0-9-]+\.js$/.test(request.url ?? '')) { response.writeHead(404); response.end(); return; }
    const [, , name, kind, file] = request.url.split('/'); const path = sourceMode ? kind === 'examples' ? join(compiled, 'examples/device-pipelines', file) : join(compiled, 'packages', name, 'src', file) : join(consumer, 'node_modules/@101', name, kind, file);
    try { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(path)); } catch { response.writeHead(404); response.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port, results = []; let missing = false;
  try { for (const [name, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) { const browser = await engine.launch({ headless: true });
    try { const page = await browser.newPage(), errors = [], foreign = []; page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (!request.url().startsWith(origin + '/')) foreign.push(request.url()); });
      await page.goto(origin); await page.waitForFunction(() => globalThis.ready); let result;
      try { result = await page.evaluate(() => globalThis.fixture.run()); if (result.unsupported) assert.equal(result.missingApi, false);
        else if (feature) { assert.equal(result.missingApi, true); missing = true; }
        else assert.ok(result.checks.length >= 20 && result.rawNative === 0 && result.final.sharing.cleanupFailures === 0 && result.final.sharing.ownedContexts === 0); }
      finally { await page.evaluate(() => globalThis.fixture.finish()); }
      assert.deepEqual(errors, []); assert.deepEqual(foreign, []); results.push({ engine: name, version: browser.version(), result, pageErrors: 0, foreignRequests: 0 });
    } finally { await browser.close(); } } } finally { await new Promise(resolve => server.close(resolve)); }
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(readFileSync(join(root, path))), pin);
  for (const [path, pin] of installed) assert.equal(hash(readFileSync(path)), pin); for (const [path, pin] of compilerPins) assert.equal(hash(readFileSync(path)), pin);
  const proof = mkdtempSync(join(tmpdir(), '101-output-sharing-proof-')), receipt = join(proof, 'provenance.json');
  writeFileSync(receipt, JSON.stringify({ pins, provenance, compilerPins: Object.fromEntries(compilerPins), node: process.version }, null, 2)); const bytes = readFileSync(receipt); assert.ok(bytes.length <= 512 * 1024);
  const serialized = JSON.stringify({ result: 'pass', profile: 'output-sharing-policy/1', results, provenance: { path: receipt, sha256: hash(bytes) }, ownedBrowsers: 0, ownedServers: 0,
    hardwareInput: false, physicalCameraControls: false, speakerOutput: false, transportOrClockQualification: false, nativeInternalQuiescenceClaim: false }) + '\n';
  assert.ok(Buffer.byteLength(serialized) <= 16384); process.stdout.write(serialized); if (feature) assert.equal(missing, false, 'genuine private audio producer works; explicit public sharing policy controller is missing');
} finally { if (compiled) rmSync(compiled, { recursive: true, force: true }); if (probeDirectory) rmSync(probeDirectory, { recursive: true, force: true }); }
