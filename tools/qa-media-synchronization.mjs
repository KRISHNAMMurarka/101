#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync, lstatSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium, firefox, webkit } from 'playwright';

const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2), hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.ok(args.length === 1 && args[0] === '--source' || args.length === 2 && ['--sdk-root', '--feature-red'].includes(args[0]), 'Use --source, --sdk-root OWNED_CONSUMER, or --feature-red OWNED_CONSUMER');
assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
const sourceMode = args[0] === '--source', feature = args[0] === '--feature-red';
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const paths = ['packages/device-runtime/src/media-synchronization.ts', 'packages/device-runtime/src/media-synchronization.test.ts',
  'examples/device-pipelines/media-synchronization.ts', 'tools/qa-media-synchronization.mjs'];
const pins = Object.fromEntries(paths.map(path => [path, hash(readFileSync(join(root, path)))]));
const installed = new Map(), compilerPins = new Map();
const require = createRequire(import.meta.url), compilerMain = realpathSync(require.resolve('typescript'));
for (const path of [compilerMain, realpathSync(join(dirname(compilerMain), '..', 'package.json'))]) compilerPins.set(path, hash(readFileSync(path)));
function json(path, cap) { const bytes = readFileSync(path); assert.ok(bytes.length <= cap); return JSON.parse(bytes.toString('utf8')); }
function inventory(directory) {
  const result = []; let visits = 0;
  function walk(path) {
    assert.equal(realpathSync(path), path); assert.equal(lstatSync(path).isSymbolicLink(), false);
    for (const item of readdirSync(path).sort()) { assert.ok(++visits <= 2048); const full = join(path, item), stat = lstatSync(full);
      assert.equal(realpathSync(full), full); assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) walk(full); else { assert.ok(stat.isFile() && result.length < 1024); result.push(relative(directory, full)); }
    }
  }
  walk(directory); return result.sort();
}
let compiled, consumer, probeDirectory, provenance;
try {
  if (sourceMode) {
    compiled = mkdtempSync(join(tmpdir(), '101-media-synchronization-source-'));
    const program = ts.createProgram([join(root, 'packages/connect/src/index.ts'), join(root, paths[2])], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmitOnError: true, rewriteRelativeImportExtensions: true,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: [], rootDir: root, outDir: compiled,
      paths: Object.fromEntries(names.map(name => ['@101/' + name, [join(root, 'packages', name, 'src/index.ts')]])),
    });
    const diagnostics = ts.getPreEmitDiagnostics(program); assert.equal(diagnostics.length, 0, diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
    const source = {};
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile) { compilerPins.set(realpathSync(file.fileName), hash(readFileSync(file.fileName))); continue; }
      const path = relative(root, file.fileName);
      assert.ok(path === paths[2] || names.some(name => path.startsWith('packages/' + name + '/src/') && !path.endsWith('.test.ts')));
      source[path] = hash(readFileSync(file.fileName));
    }
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
    for (const name of names) {
      const item = manifest.packages.find(item => item.name === '@101/' + name); assert.ok(item?.files.length && item.files.length <= 1024);
      const directory = join(consumer, 'node_modules', item.name); assert.deepEqual(inventory(directory), item.files.map(file => file.path).sort());
      for (const file of item.files) { const path = resolve(directory, file.path); assert.ok(path.startsWith(directory + '/')); assert.equal(hash(readFileSync(path)), file.sha256); installed.set(path, file.sha256); }
    }
    if (!feature) {
      for (const path of ['packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts', 'packages/device-runtime/src/index.ts',
        'packages/device-model/src/remote-clock.ts', 'packages/device-model/src/observation-timing.ts', paths[0], paths[2]]) assert.equal(hash(readFileSync(join(root, path))), manifest.source.sha256[path]);
      probeDirectory = mkdtempSync(join(consumer, 'media-synchronization-types-')); const probe = join(probeDirectory, 'consumer.mts');
      writeFileSync(probe, "import {MEDIA_SYNCHRONIZATION_PROFILE,createMediaSynchronizationController} from '@101/connect';\nimport {createMediaSynchronizationExample} from '@101/connect/examples/media-synchronization';\nconst example=createMediaSynchronizationExample(document.createElement('section'),{ownerSignal:new AbortController().signal});void example.stop();void MEDIA_SYNCHRONIZATION_PROFILE;const factory:typeof createMediaSynchronizationController=createMediaSynchronizationController;void factory;\n");
      const program = ts.createProgram([probe], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] });
      const diagnostics = ts.getPreEmitDiagnostics(program); assert.equal(diagnostics.length, 0, diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
      const library = realpathSync(dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }))); assert.ok(program.getSourceFiles().length <= 512);
      for (const file of program.getSourceFiles()) { const path = realpathSync(file.fileName), pin = hash(readFileSync(path));
        assert.ok(path === probe || installed.get(path) === pin || file.isDeclarationFile && dirname(path) === library && /^lib(?:\.[a-z0-9]+)*\.d\.ts$/.test(relative(library, path)));
        compilerPins.set(path, pin);
      }
    }
    provenance = { mode: 'ordinary-installed-seven-sdk', manifest: receipt.manifest, tree: manifest.source.tree, sourcePins: sources.length,
      installedFiles: installed.size, sourceAliases: false, sdkTypeStripping: false, strict: !feature, noUncheckedIndexedAccess: true, skipLibCheck: false };
  }
  const imports = Object.fromEntries(names.map(name => ['@101/' + name, '/@101/' + name + '/dist/index.js']));
  if (!feature) imports['@101/connect/examples/media-synchronization'] = '/@101/connect/examples/media-synchronization.js';
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned software media events</title>
<style>body{font:16px system-ui;background:#fff;color:#111}canvas{width:320px;height:180px;image-rendering:pixelated}section{min-height:44px}</style>
<section id="output"><p>Borrowed container sentinel</p></section><script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import * as api from '@101/connect';
${feature ? '' : "import {createMediaSynchronizationExample} from '@101/connect/examples/media-synchronization';"}
const container=document.querySelector('#output'),NativeAudio=globalThis.OfflineAudioContext,NativeRaf=requestAnimationFrame;
const checks=[],held=[];let owner,example,clockObserver,beforeApproval,beforeEffect,rawAudio=0,audioInstances=0,holdRaf=false,rawRaf=0;
const startedAt=performance.now();function bounded(){if(performance.now()-startedAt>15000)throw Error('owned-software-fixture-deadline');}
function check(ok,label){bounded();if(!ok||checks.length>=32)throw Error(label);checks.push(label);}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=1500){const start=performance.now();while(!fn()){bounded();if(performance.now()-start>ms)throw Error('software-effect-deadline');await wait(10);}}
if(NativeAudio)globalThis.OfflineAudioContext=class extends NativeAudio{constructor(...args){super(...args);audioInstances++;}startRendering(){rawAudio++;try{return super.startRendering().finally(()=>rawAudio--);}catch(error){rawAudio--;throw error;}}};
globalThis.requestAnimationFrame=callback=>NativeRaf(at=>{if(holdRaf){rawRaf++;held.push(()=>{rawRaf--;callback(at);});}else callback(at);});
function release(){holdRaf=false;for(const invoke of held.splice(0))invoke();}
async function prefix(){if(!NativeAudio)return{supported:false,reason:'missing-offline-pcm-api'};const context=new OfflineAudioContext(1,256,48000),input=context.createBuffer(1,256,48000),source=context.createBufferSource();input.getChannelData(0).fill(.25);source.buffer=input;source.connect(context.destination);source.start();
let rendered;const canvas=document.createElement('canvas');canvas.width=32;canvas.height=18;try{rendered=await context.startRendering();const samples=rendered.getChannelData(0);let sum=0;for(const sample of samples)sum+=sample*sample;
const paint=canvas.getContext('2d');paint.fillStyle='#e6e6e6';paint.fillRect(0,0,32,18);const pixel=[...paint.getImageData(0,0,1,1).data];return{supported:true,frames:rendered.length,sampleRate:rendered.sampleRate,rms:Math.sqrt(sum/samples.length),pixel,nativePcmCaptureMapping:'unknown',scanoutMapping:'unknown'};
}finally{input.getChannelData(0).fill(0);rendered?.getChannelData(0).fill(0);source.disconnect();source.buffer=null;canvas.width=canvas.height=1;}}
async function reset(){release();if(example)await example.stop();clockObserver=beforeApproval=beforeEffect=undefined;owner=new AbortController();${feature ? '' : "example=createMediaSynchronizationExample(container,{ownerSignal:owner.signal,now(){const at=performance.now();clockObserver?.();return at;},beforeApproval(request){beforeApproval?.(request);},beforeEffect(){beforeEffect?.();}});"}}
function consent(){for(const role of ['audio','video'])for(const side of ['source','sink'])example.setConsent(role,side,true);}
async function samples(count=1,options={}){for(let index=0;index<count;index++){bounded();checkSample(example.sample(options));await wait(45);}}
function checkSample(value){if(!value)throw Error('sample-admission-refused');}
function snapshot(){return example.snapshot();}function pixel(){const canvas=container.querySelector('canvas');return canvas?[...canvas.getContext('2d').getImageData(8,8,1,1).data]:[0,0,0,0];}
globalThis.fixture={prefix,async run(){const producer=await prefix();check(producer.supported&&producer.frames===256&&Math.abs(producer.rms-.25)<.001&&producer.pixel[0]===230,'real-owned-offline-pcm-and-raster-prefix');
${feature ? "return{producer,checks,missingApi:typeof api.createMediaSynchronizationController!=='function'};" : `
await reset();const baseline=audioInstances;check(await example.start()===false&&audioInstances===baseline,'all-independent-owner-consents-default-deny');
for(const missing of ['audio-source','audio-sink','video-source','video-sink']){await reset();consent();const [role,side]=missing.split('-');example.setConsent(role,side,false);const before=audioInstances;check(await example.start()===false&&audioInstances===before,'separate-'+missing+'-denial-before-pcm');}
await reset();consent();check(await example.start(),'actual-messageport-clock-exchanges-and-granted-routes');check(snapshot().nativePcm.frames===256&&snapshot().nativePcmCaptureMapping==='unknown','actual-pcm-generation-does-not-map-capture');
await samples(2);check(snapshot().painted===0&&snapshot().synchronization.recoveryPairs===2,'two-fresh-pairs-remain-recovering');await samples(1);await until(()=>snapshot().painted>0);check(pixel()[0]===230&&snapshot().synchronization.state==='aligned-software-observations'&&snapshot().lastSoftwareSkew.earliestMs<=snapshot().lastSoftwareSkew.latestMs&&Math.max(Math.abs(snapshot().lastSoftwareSkew.earliestMs),Math.abs(snapshot().lastSoftwareSkew.latestMs))<=20,'third-pair-actual-owned-raster-effect-and-conservative-skew');
const aligned=snapshot().painted;await samples(1,{nativeClockUnknown:true});check(snapshot().painted===aligned&&snapshot().synchronization.reason==='native-clock-unmapped','unknown-native-provenance-never-becomes-capture-mapping');
check(await example.mapClocks(),'fresh-software-map-after-degradation');await samples(3);await until(()=>snapshot().painted>aligned);check(snapshot().synchronization.recoveryPairs===3,'three-fresh-pair-recovery-after-unknown');
const beforeSkew=snapshot();await samples(1,{skewMs:30});check(snapshot().painted===beforeSkew.painted&&snapshot().synchronization.reason==='skew-budget'&&snapshot().synchronization.epoch>beforeSkew.synchronization.epoch,'conservative-skew-budget-discards-pair-and-maps');
check(await example.mapClocks(),'new-epoch-map-after-skew');await samples(3);await until(()=>snapshot().painted>beforeSkew.painted);
await example.mapClocks();const missingPaint=snapshot().painted;checkSample(example.sample({onlyAudio:true}));await wait(120);check(snapshot().painted===missingPaint&&snapshot().synchronization.pendingContexts===0,'missing-lane-age-expiry-settles-real-apply');
await example.mapClocks();await samples(2);holdRaf=true;checkSample(example.sample());await until(()=>held.length>0);check(snapshot().pendingRenders===1&&snapshot().synchronization.pendingContexts===2,'controlled-owned-raf-delay-holds-both-real-contexts');release();await until(()=>snapshot().pendingRenders===0);check(rawRaf===0,'issued-host-raf-callback-actually-returned');
const prior=snapshot().painted;example.setConsent('audio','source',false);check(snapshot().painted===prior&&pixel()[3]===0&&snapshot().synchronization.pendingContexts===0,'source-owner-revoke-retires-route-and-clears-output');await example.stop();
await reset();consent();check(await example.start(),'fresh-instance-and-owner-grants-recover');await samples(3);await until(()=>snapshot().painted>0);check(pixel()[0]===230,'fresh-recovery-has-an-actual-effect');
await reset();consent();beforeApproval=()=>{beforeApproval=undefined;void example.stop();};const nativeBefore=audioInstances;check(await example.start()===false&&audioInstances===nativeBefore,'authorization-callback-stop-before-native-pcm-acquisition');await example.stop();
await reset();consent();check(await example.start(),'effect-cancellation-fixture');await samples(2);beforeEffect=()=>{beforeEffect=undefined;owner.abort();};checkSample(example.sample());await until(()=>snapshot().stopped);await example.stop();check(snapshot().painted===0&&!container.querySelector('canvas'),'effect-observer-owner-abort-blocks-visible-effect');
await reset();consent();check(await example.start(),'final-clock-fixture');await samples(2);beforeEffect=()=>{beforeEffect=undefined;clockObserver=()=>{clockObserver=undefined;owner.abort();};};checkSample(example.sample());await until(()=>snapshot().stopped);await example.stop();check(snapshot().painted===0,'final-clock-owner-abort-blocks-visible-effect');
await reset();consent();check(await example.start(),'intrinsic-signal-fixture');Object.defineProperty(owner.signal,'aborted',{value:false});owner.abort();await example.stop();check(snapshot().stopped&&snapshot().ports===0,'shadowed-owner-aborted-property-cannot-restore-authority');
check(snapshot().synchronization.pendingContexts===0&&snapshot().synchronization.pendingEffects===0&&snapshot().pendingRenders===0&&snapshot().pendingExchanges===0&&snapshot().pendingAudio===0&&rawAudio===0&&rawRaf===0&&held.length===0,'actual-returned-native-work-and-owned-contexts-settled');
check(container.children.length===1&&container.firstElementChild.textContent==='Borrowed container sentinel'&&snapshot().raf===0&&snapshot().timers===0,'borrowed-children-preserved-owned-ports-timer-raf-retired');
return{producer,checks,state:snapshot(),rawAudio,rawRaf,audioInstances,softwareImpairment:'owned-RAF-callback-delay',clockAuthentication:false,nativePcmCaptureMapping:'unknown',videoPtsMapping:'unknown',scanoutMapping:'unknown',physicalSynchronization:false};
`}
},async finish(){release();if(example)await example.stop();owner?.abort();}};globalThis.ready=true;
</script></html>`;
  const server = createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    if (!/^\/@101\/(device-model|device-runtime|transport-webrtc|transport-websocket|device-web|vision|connect)\/(dist|examples)\/[a-z0-9-]+\.js$/.test(request.url ?? '')) { response.writeHead(404); response.end(); return; }
    const [, , name, kind, file] = request.url.split('/');
    const path = sourceMode ? kind === 'examples' ? join(compiled, 'examples/device-pipelines', file) : join(compiled, 'packages', name, 'src', file) : join(consumer, 'node_modules/@101', name, kind, file);
    try { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(path)); } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, results = []; let genuineMissing = false;
  try {
    for (const [name, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage(), errors = [], foreign = [];
        page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (!request.url().startsWith(origin + '/')) foreign.push(request.url()); });
        await page.goto(origin); await page.waitForFunction(() => globalThis.ready); const prefix = await page.evaluate(() => globalThis.fixture.prefix());
        let result;
        try {
          if (!prefix.supported) result = { unsupported: prefix.reason, missingFeatureClaim: false };
          else { assert.ok(prefix.frames === 256 && Math.abs(prefix.rms - 0.25) < 0.001 && prefix.pixel[0] === 230, JSON.stringify({ engine: name, prefix }));
            result = await page.evaluate(() => globalThis.fixture.run());
            if (feature) { assert.equal(result.missingApi, true); genuineMissing ||= result.missingApi; }
            else assert.ok(result.checks.length >= 24 && result.rawAudio === 0 && result.rawRaf === 0 && result.state.synchronization.pendingContexts === 0);
          }
        } finally { await page.evaluate(() => globalThis.fixture.finish()); }
        assert.deepEqual(errors, []); assert.deepEqual(foreign, []); results.push({ engine: name, nativePrefix: prefix, result, pageErrors: 0, foreignRequests: 0 });
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(readFileSync(join(root, path))), pin);
  for (const [path, pin] of installed) assert.equal(hash(readFileSync(path)), pin);
  for (const [path, pin] of compilerPins) assert.equal(hash(readFileSync(path)), pin);
  const proof = mkdtempSync(join(tmpdir(), '101-media-synchronization-proof-')), receipt = join(proof, 'provenance.json');
  writeFileSync(receipt, JSON.stringify({ pins, provenance, compilerPins: Object.fromEntries(compilerPins), node: process.version }, null, 2)); const bytes = readFileSync(receipt); assert.ok(bytes.length <= 256 * 1024);
  const output = { result: 'pass', profile: 'software-media-observation-sync/1', results, provenance: { path: receipt, sha256: hash(bytes) }, ownedBrowsers: 0, ownedServers: 0,
    physicalSynchronization: false, speakerOrCameraPermission: false, nativeInternalQuiescenceClaim: false, fullV10Matrix: false };
  const serialized = JSON.stringify(output) + '\n'; assert.ok(Buffer.byteLength(serialized) <= 16384); process.stdout.write(serialized);
  if (feature) assert.equal(genuineMissing, false, 'actual native software producer works; selected public synchronization controller is missing');
} finally { if (compiled) rmSync(compiled, { recursive: true, force: true }); if (probeDirectory) rmSync(probeDirectory, { recursive: true, force: true }); }
