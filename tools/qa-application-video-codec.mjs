#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync, lstatSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { chromium, firefox, webkit } from 'playwright';

const root = resolve(import.meta.dirname, '..'), args = process.argv.slice(2), hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.ok(args.length === 1 && ['--source', '--failures-source'].includes(args[0]) || args.length === 2 && ['--sdk-root', '--failures-sdk-root', '--feature-red'].includes(args[0]), 'Use --source, --failures-source, --sdk-root OWNED_CONSUMER, --failures-sdk-root OWNED_CONSUMER, or --feature-red OWNED_CONSUMER');
assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined);
const sourceMode = ['--source', '--failures-source'].includes(args[0]), feature = args[0] === '--feature-red', failuresOnly = args[0].startsWith('--failures-');
const names = ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect'];
const paths = ['packages/device-web/src/application-video-codec.ts', 'packages/device-web/src/application-video-codec.test.ts',
  'examples/device-pipelines/application-video-codec.ts', 'tools/qa-application-video-codec.mjs'];
const pins = Object.fromEntries(paths.map(path => [path, hash(readFileSync(join(root, path)))]));
function json(path, cap) { const bytes = readFileSync(path); assert.ok(bytes.length <= cap); return JSON.parse(bytes.toString('utf8')); }
function inventory(directory) {
  const files = []; let visits = 0;
  function walk(path) { assert.equal(realpathSync(path), path); assert.equal(lstatSync(path).isSymbolicLink(), false);
    for (const item of readdirSync(path).sort()) { assert.ok(++visits <= 2048); const full = join(path, item), stat = lstatSync(full);
      assert.equal(realpathSync(full), full); assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) walk(full); else { assert.ok(stat.isFile() && files.length < 1024); files.push(relative(directory, full)); }
    }
  } walk(directory); return files.sort();
}
let compiled, consumer, provenance, ownedProbe;
const installed = new Map(), compilerPins = new Map();
const require = createRequire(import.meta.url), compilerMain = realpathSync(require.resolve('typescript'));
for (const path of [compilerMain, realpathSync(join(dirname(compilerMain), '..', 'package.json'))]) compilerPins.set(path, hash(readFileSync(path)));
try {
  if (sourceMode) {
    compiled = mkdtempSync(join(tmpdir(), '101-application-video-codec-source-'));
    const program = ts.createProgram([join(root, 'packages/connect/src/index.ts'), join(root, paths[2])], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false,
      noEmitOnError: true, rewriteRelativeImportExtensions: true, types: [], rootDir: root, outDir: compiled,
      paths: Object.fromEntries(names.map(name => ['@101/' + name, [join(root, 'packages', name, 'src/index.ts')]])),
    });
    const diagnostics = ts.getPreEmitDiagnostics(program); assert.equal(diagnostics.length, 0, diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
    const sourcePins = {};
    for (const file of program.getSourceFiles()) {
      if (file.isDeclarationFile) { compilerPins.set(realpathSync(file.fileName), hash(readFileSync(file.fileName))); continue; }
      const path = relative(root, file.fileName);
      assert.ok(path === paths[2] || names.some(name => path.startsWith('packages/' + name + '/src/') && !path.endsWith('.test.ts')));
      sourcePins[path] = hash(readFileSync(file.fileName));
    }
    assert.ok(Object.keys(sourcePins).length <= 256);
    const emitted = program.emit(); assert.equal(emitted.emitSkipped, false); assert.equal(emitted.diagnostics.length, 0);
    provenance = { mode: 'owned-worker-public-source-resolver', source: sourcePins, installedSdkClaim: false, compiler: ts.version };
  } else {
    consumer = realpathSync(resolve(args[1])); assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
    const receipt = json(join(consumer, 'receipt.json'), 512 * 1024); assert.equal(receipt.status, 'pass');
    const manifestBytes = readFileSync(receipt.manifest.path); assert.ok(manifestBytes.length <= 2 * 1024 * 1024); assert.equal(hash(manifestBytes), receipt.manifest.sha256);
    const manifest = JSON.parse(manifestBytes); assert.equal(manifest.source.tree, receipt.source.tree); assert.deepEqual(manifest.source.sha256, receipt.source.sha256);
    assert.match(manifest.source.tree, /^[0-9a-f]{40}$/); assert.equal(manifest.packages.length, 7); assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
    const sourcePins = Object.entries(manifest.source.sha256); assert.ok(sourcePins.length > 0 && sourcePins.length <= 256);
    for (const [path, pin] of sourcePins) { assert.match(path, /^(LICENSE|schemas\/device-descriptor\.schema\.json|(packages|examples)\/[A-Za-z0-9_./-]+)$/); assert.equal(path.includes('..'), false);
      assert.equal(hash(execFileSync('git', ['show', manifest.source.tree + ':' + path], { cwd: root, maxBuffer: 2 * 1024 * 1024 })), pin); }
    for (const name of names) {
      const item = manifest.packages.find(item => item.name === '@101/' + name); assert.ok(item?.files.length && item.files.length <= 1024);
      const directory = join(consumer, 'node_modules', item.name); assert.deepEqual(inventory(directory), item.files.map(file => file.path).sort());
      for (const file of item.files) { const path = resolve(directory, file.path); assert.ok(path.startsWith(directory + '/')); assert.equal(hash(readFileSync(path)), file.sha256); installed.set(path, file.sha256); }
    }
    if (!feature) {
      for (const path of ['packages/device-model/src/media.ts', 'packages/device-runtime/src/runtime.ts', 'packages/device-runtime/src/types.ts',
        'packages/device-runtime/src/media-grants.ts', 'packages/device-web/src/index.ts', paths[0], paths[2]]) assert.equal(hash(readFileSync(join(root, path))), manifest.source.sha256[path]);
      ownedProbe = mkdtempSync(join(consumer, 'application-video-codec-types-')); const probe = join(ownedProbe, 'consumer.mts');
      writeFileSync(probe, "import {createBrowserApplicationVideoCodec} from '@101/connect';\nimport {createApplicationVideoCodecExample} from '@101/connect/examples/application-video-codec';\nconst owner=new AbortController();const canvas=document.createElement('canvas');const controller=createBrowserApplicationVideoCodec({ownerSignal:owner.signal,applicationId:'owned',sessionId:'session',clockDomain:'host',now:()=>performance.now(),authorizeSource:()=>undefined,authorizeSink:()=>undefined});const example=createApplicationVideoCodecExample(canvas,{first:document.createElement('div'),second:document.createElement('div')},{ownerSignal:owner.signal});void controller.close();void example.stop();\n");
      const program = ts.createProgram([probe], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true, noUncheckedIndexedAccess: true, skipLibCheck: false, noEmit: true, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'] });
      const diagnostics = ts.getPreEmitDiagnostics(program); assert.equal(diagnostics.length, 0, diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n'));
      const library = realpathSync(dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }))); assert.ok(program.getSourceFiles().length <= 512);
      for (const file of program.getSourceFiles()) { const path = realpathSync(file.fileName), pin = hash(readFileSync(path));
        assert.ok(path === probe || installed.get(path) === pin || file.isDeclarationFile && dirname(path) === library && /^lib(?:\.[a-z0-9]+)*\.d\.ts$/.test(relative(library, path)));
        compilerPins.set(path, pin);
      }
    }
    provenance = { mode: 'ordinary-installed-seven-sdk', manifest: receipt.manifest, tree: manifest.source.tree, sourcePins: sourcePins.length, installedFiles: installed.size,
      packages: 7, sourceAliases: false, sdkTypeStripping: false, compiler: ts.version, strict: !feature, skipLibCheck: false };
  }
  const imports = Object.fromEntries(names.map(name => ['@101/' + name, '/@101/' + name + '/dist/index.js']));
  if (!feature) imports['@101/connect/examples/application-video-codec'] = '/@101/connect/examples/application-video-codec.js';
  // Dedicated cells extend the old evidence without repeating adaptation/loss runs.
  // Refusals are explicit fault injection around genuine native VP8 probes.
  const failureCells = String.raw`
globalThis.failureFixture={async run(){
 const evidence=[],assertions=[];
 function expect(value,label){bounded();if(!value||assertions.length>=96)throw Error(label);assertions.push(label);}
 const nativeSupport=[];
 for(const tier of [{width:320,height:180,frameRate:20,bitrate:384000},{width:160,height:90,frameRate:10,bitrate:128000}]){
  const encoder=await NativeEncoder.isConfigSupported({codec:'vp8',width:tier.width,height:tier.height,framerate:tier.frameRate,bitrate:tier.bitrate,latencyMode:'realtime',bitrateMode:'variable',hardwareAcceleration:'prefer-software'});
  const decoder=await NativeDecoder.isConfigSupported({codec:'vp8',codedWidth:tier.width,codedHeight:tier.height,optimizeForLatency:true});
  expect(encoder.supported===true&&decoder.supported===true,'native-vp8-supported-'+tier.width);nativeSupport.push({tier,encoder:encoder.supported,decoder:decoder.supported});
 }
 async function vp8Open(){example.setConsent('first','source',true);example.setConsent('first','sink',true);const binding=await example.start('first',['video/vp8']);if(!binding)throw Error('missing-vp8-binding');return binding;}
 async function recovered(label){const binding=await vp8Open();expect(await binding.ready&&binding.status().codec==='video/vp8',label+'-fresh-ready');await samples();await until(()=>binding.status().frames>0);expect(pixels('first')[0]>150&&pixels('first')[1]<80,label+'-fresh-native-pixels');return binding;}
 for(const name of ['VideoEncoder','VideoDecoder','VideoFrame','EncodedVideoChunk']){
  await reset();const original=Object.getOwnPropertyDescriptor(globalThis,name),before={encoders:encoders.length,decoders:decoders.length};let refusal;
  try{expect(original?.configurable===true,'missing-'+name+'-fault-installed');delete globalThis[name];const binding=await vp8Open();expect(await binding.ready===false,'missing-'+name+'-refused');await binding.closed;refusal={...binding.status(),controller:example.video.status()};expect(refusal.reason==='unsupported'&&refusal.controller.outputs===0&&refusal.controller.pendingNative===0&&refusal.controller.probes===0&&encoders.length===before.encoders&&decoders.length===before.decoders&&!containers.first.querySelector('canvas'),'missing-'+name+'-no-native-acquisition');}
  finally{Object.defineProperty(globalThis,name,original);}
  const recovery=await recovered('missing-'+name);evidence.push({cell:'missing-'+name,injection:'required realm API removed',refusal,recovery:recovery.status()});await example.stop();
 }
 for(const kind of ['encoder','decoder'])for(const width of [320,160]){
  await reset();const before={encoders:encoders.length,decoders:decoders.length},probes=[];let refusal;
  const Encoder=globalThis.VideoEncoder,Decoder=globalThis.VideoDecoder;
  Object.defineProperty(Encoder,'isConfigSupported',{configurable:true,value:async config=>{const result=await NativeEncoder.isConfigSupported(config),refuse=kind==='encoder'&&config.width===width;probes.push({kind:'encoder',codec:config.codec,width:config.width,nativeSupported:result.supported,injectedRefusal:refuse});return refuse?{...result,supported:false}:result;}});
  Object.defineProperty(Decoder,'isConfigSupported',{configurable:true,value:async config=>{const result=await NativeDecoder.isConfigSupported(config),refuse=kind==='decoder'&&config.codedWidth===width;probes.push({kind:'decoder',codec:config.codec,width:config.codedWidth,nativeSupported:result.supported,injectedRefusal:refuse});return refuse?{...result,supported:false}:result;}});
  try{const binding=await vp8Open();expect(await binding.ready===false,'unsupported-'+kind+'-'+width+'-refused');await binding.closed;refusal={...binding.status(),controller:example.video.status()};expect(refusal.reason==='unsupported'&&refusal.controller.outputs===0&&refusal.controller.pendingNative===0&&refusal.controller.probes===4&&probes.length===4&&probes.every(probe=>probe.codec==='vp8'&&probe.nativeSupported===true)&&probes.filter(probe=>probe.injectedRefusal).length===1&&encoders.length===before.encoders&&decoders.length===before.decoders&&!containers.first.querySelector('canvas'),'unsupported-'+kind+'-'+width+'-bounded-native-probes');}
  finally{delete Encoder.isConfigSupported;delete Decoder.isConfigSupported;}
  const recovery=await recovered('unsupported-'+kind+'-'+width);evidence.push({cell:'unsupported-'+kind+'-'+width,injection:'one native support result narrowed to unsupported',probes,refusal,recovery:recovery.status()});await example.stop();
 }
 function direct(ttl=2000){
  const owner=new AbortController(),sourceOwner=new AbortController(),sinkOwner=new AbortController(),deadline={at:performance.now()+ttl};
  const approve=request=>request.codec==='video/vp8'?{request,signal:request.role==='source'?sourceOwner.signal:sinkOwner.signal,grant:{expiresAt:deadline.at,maxHz:20,maxAgeMs:1000}}:undefined;
  const video=api.createBrowserApplicationVideoCodec({ownerSignal:owner.signal,applicationId:'independent-vp8-failure-caller',sessionId:'local-vp8',clockDomain:'caller-performance',now:()=>performance.now(),authorizeSource:approve,authorizeSink:approve});
  let handle=video.registerSource({sourceId:'video:independent',ownerPrincipalId:'source-owner',canvas:source});if(!handle)throw Error('independent-source-unavailable');
  return{video,owner,deadline,get source(){return handle;},register(){handle=video.registerSource({sourceId:'video:independent',ownerPrincipalId:'source-owner',canvas:source});return handle;},async open(){const binding=video.bind({source:handle,outputId:'video:independent-output',ownerPrincipalId:'independent-recipient',container:containers.first,label:'Independent VP8 output',codecs:['video/vp8'],ownerSignal:new AbortController().signal});expect(await binding.ready&&binding.status().codec==='video/vp8','independent-vp8-ready');return binding;},async stop(){release();owner.abort();await video.close();}};
 }
 async function directPixels(caller,binding){expect(caller.video.capture(caller.source),'independent-native-capture');await until(()=>binding.status().frames>0);expect(pixels('first')[0]>150&&pixels('first')[1]<80,'independent-native-pixels');}
 let caller;
 try{
  caller=direct(250);let binding=await caller.open();await directPixels(caller,binding);const expiresAt=binding.status().expiresAt,frames=binding.status().frames;
  await until(()=>binding.status().state==='stopped',1200);await binding.closed;
  expect(binding.status().reason==='expired'&&performance.now()>=expiresAt&&binding.status().frames===frames&&binding.status().pendingNative===0&&caller.video.status().outputs===0&&!containers.first.querySelector('canvas')&&!caller.video.capture(caller.source),'actual-timer-grant-expiry-cleans-output-without-capture');
  const refusal={...binding.status(),controller:caller.video.status()};caller.deadline.at=performance.now()+2000;binding=await caller.open();await directPixels(caller,binding);evidence.push({cell:'actual-grant-expiry',injection:false,expiresAt,refusal,recovery:binding.status()});
 }finally{if(caller)await caller.stop();caller=undefined;}
 for(const loss of ['source-dimension-change','source-revocation'])try{
  caller=direct();const binding=await caller.open();await directPixels(caller,binding);holdDecoder=decoders.length;await wait(55);expect(caller.video.capture(caller.source),'loss-pending-native-capture');await until(()=>held.length===1);const before=binding.status();
  if(loss==='source-dimension-change'){source.width=319;expect(!caller.video.capture(caller.source),'source-dimension-loss-refuses-capture');}
  else{expect(caller.video.revokeSource(caller.source),'source-revocation-accepted');expect(caller.register()===undefined,'source-reservation-retained-until-native-settlement');}
  expect(binding.status().state==='stopped'&&binding.status().pendingNative>0&&!containers.first.querySelector('canvas'),'source-loss-clears-owned-output-before-native-settlement');let settled=false;binding.closed.then(()=>{settled=true;});await wait(0);expect(!settled,'source-loss-closed-waits-for-issued-work');release();await binding.closed;
  expect(binding.status().frames===before.frames&&binding.status().pendingNative===0&&caller.video.status().outputs===0,'source-loss-no-late-frame-and-no-pending-work');const refusal={...binding.status(),controller:caller.video.status()};
  source.width=320;color();if(loss==='source-revocation')expect(!!caller.register(),'source-registers-after-native-settlement');caller.deadline.at=performance.now()+2000;const recovery=await caller.open();await directPixels(caller,recovery);evidence.push({cell:loss,injection:false,pendingAtLoss:before.pendingNative,refusal,recovery:recovery.status()});
 }finally{source.width=320;color();if(caller)await caller.stop();caller=undefined;}
 expect(encoders.every(codec=>codec.state==='closed')&&decoders.every(codec=>codec.state==='closed')&&rawCallbacks===0&&held.length===0&&nativeFrames===frameClosures,'all-failure-cell-owned-native-work-closed');
 expect(source.width===320&&source.height===180&&containers.first.children.length===1&&containers.second.children.length===1,'failure-cell-borrowed-source-and-sentinels-preserved');
 return{assertions,evidence,nativeSupport,nativeFrames,frameClosures,rawCallbacks,ownedCodecsClosed:true,offeredCodecs:['video/vp8'],hardwareClaim:false,browserInternalQuiescenceClaim:false};
}};
`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Owned application codec fixture</title>
<style>body{font:16px system-ui;color:#111;background:#fff}canvas{max-width:100%;height:auto}section{min-height:44px}</style>
<canvas id="source" width="320" height="180" aria-label="Owned generated source"></canvas><section id="first"><p>First recipient sentinel</p></section><section id="second"><p>Second recipient sentinel</p></section>
<script type="importmap">${JSON.stringify({ imports })}</script><script type="module">
import * as api from '@101/connect';
${feature ? '' : "import {createApplicationVideoCodecExample} from '@101/connect/examples/application-video-codec';"}
const source=document.querySelector('#source'),containers={first:document.querySelector('#first'),second:document.querySelector('#second')};
const NativeEncoder=globalThis.VideoEncoder,NativeDecoder=globalThis.VideoDecoder,NativeFrame=globalThis.VideoFrame,NativeChunk=globalThis.EncodedVideoChunk;
const paint=source.getContext('2d');function color(value='rgb(230,20,20)'){paint.fillStyle=value;paint.fillRect(0,0,320,180);}color();
const checks=[],encoders=[],decoders=[],held=[],configurations=[];let owner,example,approvalMode='',holdDecoder=0,omitEncoder=0,omittedEncoder=0,oversizeNext=false,descriptionNext=false,nativeChunks=0,decodeAdmissions=0,observedTypes=[],drawObserver,clockObserver;
let nativeFrames=0,frameClosures=0,rawCallbacks=0;const started=performance.now();
const closedFrames=new WeakSet(),nativeFrameClose=NativeFrame?.prototype.close,nativeDraw=CanvasRenderingContext2D.prototype.drawImage;
if(NativeFrame)NativeFrame.prototype.close=function(){const result=nativeFrameClose.call(this);closedFrames.add(this);return result;};
CanvasRenderingContext2D.prototype.drawImage=function(...values){const result=nativeDraw.apply(this,values);drawObserver?.(this.canvas,values[0]);return result;};
function bounded(){if(performance.now()-started>15000)throw Error('owned-native-budget');}
function check(value,label){bounded();if(!value||checks.length>=32)throw Error(label);checks.push(label);}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=2000){const at=performance.now();while(!fn()){bounded();if(performance.now()-at>ms)throw Error('effect-deadline');await wait(10);}}
async function prefix(){
 if(!NativeEncoder||!NativeDecoder||!NativeFrame||!NativeChunk)return{supported:false,reason:'missing-api'};
 let selected;for(const codec of ['vp8','vp09.00.10.08']){const e=await NativeEncoder.isConfigSupported({codec,width:320,height:180,framerate:20,bitrate:384000,latencyMode:'realtime',bitrateMode:'variable',hardwareAcceleration:'prefer-software'}),d=await NativeDecoder.isConfigSupported({codec,codedWidth:320,codedHeight:180,optimizeForLatency:true});if(e.supported&&d.supported){selected=codec;break;}}
 if(!selected)return{supported:false,reason:'no-common-codec'};
 const output=document.createElement('canvas');output.width=320;output.height=180;let emitted=0,decoded=0,decoder,encoder;const chunks=[],frames=[];
 const encoderConfig={codec:selected,width:320,height:180,framerate:20,bitrate:384000,latencyMode:'realtime',bitrateMode:'variable',hardwareAcceleration:'prefer-software'},decoderConfig={codec:selected,codedWidth:320,codedHeight:180,optimizeForLatency:true};
 try{decoder=new NativeDecoder({output(frame){try{frames.push({width:frame.displayWidth,height:frame.displayHeight,timestamp:frame.timestamp});output.getContext('2d').drawImage(frame,0,0);decoded++;}finally{frame.close();}},error(error){throw error;}});decoder.configure(decoderConfig);
 encoder=new NativeEncoder({output(chunk,metadata){emitted++;chunks.push({type:chunk.type,byteLength:chunk.byteLength,timestamp:chunk.timestamp,decoderConfig:metadata?.decoderConfig?{codec:metadata.decoderConfig.codec,codedWidth:metadata.decoderConfig.codedWidth,codedHeight:metadata.decoderConfig.codedHeight}:null});if(metadata?.decoderConfig)decoder.configure(metadata.decoderConfig);decoder.decode(chunk);},error(error){throw error;}});encoder.configure(encoderConfig);
 const frame=new NativeFrame(source,{timestamp:1});try{encoder.encode(frame,{keyFrame:true});}finally{frame.close();}await encoder.flush();await decoder.flush();const pixel=[...output.getContext('2d').getImageData(10,10,1,1).data];return{supported:true,codec:selected,emitted,decoded,pixel,sourcePixel:[...paint.getImageData(10,10,1,1).data],encoderConfig,decoderConfig,chunks,frames,api:typeof api.createBrowserApplicationVideoCodec};
 }finally{encoder?.close();decoder?.close();output.width=1;output.height=1;}
}
if(NativeEncoder)globalThis.VideoEncoder=class extends NativeEncoder{constructor(init){const ownedId=encoders.length+1;super({...init,output(chunk,metadata){nativeChunks++;if(observedTypes.length>=256)throw Error('native-callback-quota');observedTypes.push(chunk.type);if(omitEncoder===ownedId){omittedEncoder=ownedId;omitEncoder=0;return;}if(oversizeNext){oversizeNext=false;const data=new Uint8Array(65537);chunk.copyTo(data);chunk=new NativeChunk({type:chunk.type,timestamp:chunk.timestamp,data});Object.defineProperty(chunk,'byteLength',{value:1});}if(descriptionNext){descriptionNext=false;const data=new Uint8Array(4097);Object.defineProperty(data,'byteLength',{value:1});metadata={decoderConfig:{codec:'vp8',description:data}};}init.output(chunk,metadata);}});this.ownedId=ownedId;encoders.push(this);}configure(config){if(configurations.length>=64)throw Error('native-config-quota');configurations.push({encoder:this.ownedId,width:config.width,height:config.height,frameRate:config.framerate,requestedBitrate:config.bitrate});return super.configure(config);}};
if(NativeDecoder)globalThis.VideoDecoder=class extends NativeDecoder{constructor(init){super({...init,output(frame){nativeFrames++;try{init.output(frame);}finally{if(closedFrames.has(frame))frameClosures++;}}});this.ownedId=decoders.length+1;decoders.push(this);}decode(chunk){decodeAdmissions++;return super.decode(chunk);}flush(){const issued=super.flush();if(this.ownedId===holdDecoder){rawCallbacks++;return issued.then(()=>new Promise(resolve=>held.push(()=>{rawCallbacks--;resolve();})),error=>{rawCallbacks--;throw error;});}return issued;}};
function pixels(key){const canvas=containers[key].querySelector('canvas');return canvas?[...canvas.getContext('2d').getImageData(10,10,1,1).data]:[0,0,0,0];}
function release(){holdDecoder=0;for(const settle of held.splice(0))settle();}
async function reset(){release();drawObserver=clockObserver=undefined;if(example)await example.stop();owner=new AbortController();approvalMode='';omitEncoder=0;oversizeNext=descriptionNext=false;color();${feature ? '' : "example=createApplicationVideoCodecExample(source,containers,{ownerSignal:owner.signal,now(){const at=performance.now();clockObserver?.();return at;},beforeApproval(){if(approvalMode==='close'){approvalMode='';void example.stop();}}});"}}
async function open(key){example.setConsent(key,'source',true);example.setConsent(key,'sink',true);const binding=await example.start(key);if(!binding)throw Error('missing-binding');await binding.ready;return binding;}
async function samples(count=1,delay=60){for(let i=0;i<count;i++){bounded();example.capture();await wait(delay);}}
globalThis.fixture={prefix,async run(){
 const producer=await prefix();check(producer.supported&&producer.emitted>0&&producer.decoded>0&&producer.pixel[0]>150&&producer.pixel[1]<80,'real-native-encode-decode-pixel-prefix');
 ${feature ? "return{producer,missingApi:typeof api.createBrowserApplicationVideoCodec!=='function',checks};" : `
 await reset();let binding=await example.start('first');check(await binding.ready===false&&encoders.length===0,'source-and-sink-denial-before-codec-acquisition');
 example.setConsent('first','source',true);binding=await example.start('first');check(await binding.ready===false&&encoders.length===0,'sink-denial-is-independent');
 example.setConsent('first','source',false);example.setConsent('first','sink',true);binding=await example.start('first');check(await binding.ready===false&&encoders.length===0,'source-denial-is-independent');
 await reset();let first=await open('first'),second=await open('second');check(await first.ready&&await second.ready,'two-independently-approved-codec-bindings');await samples(3);await until(()=>first.status().frames>0&&second.status().frames>0);check(pixels('first')[0]>150&&pixels('second')[0]>150,'actual-decoded-pixels-at-both-current-recipients');
 const prior=second.status().frames;holdDecoder=decoders.indexOf(decoders.at(-2))+1;await samples(6);check(held.length===1&&first.status().pendingNative>0,'held-returned-native-flush-remains-reserved');check(second.status().frames>prior,'slow-recipient-does-not-starve-other-scope');check(first.status().dropped>=4,'pressure-counts-drops-with-one-queued-slot');release();await samples(6);await until(()=>first.status().tier===1);check(containers.first.querySelector('canvas').width===160&&first.status().adaptations>0&&configurations.some(config=>config.width===160&&config.requestedBitrate===128000),'actual-lower-resolution-and-bitrate-native-configuration');await samples(10,105);await until(()=>first.status().tier===0);check(containers.first.querySelector('canvas').width===320,'successful-effects-recover-original-approved-tier');
 const lossFrames=first.status().frames,types=observedTypes.length,targetEncoder=encoders.length-1;omitEncoder=targetEncoder;await samples(3);check(omittedEncoder===targetEncoder&&first.status().frames>lossFrames&&observedTypes.slice(types).includes('key'),'controlled-genuine-chunk-omission-recovers-with-keyframe');
 const other=second.status().frames;example.setConsent('first','source',false);await first.closed;check(first.status().state==='stopped'&&!containers.first.querySelector('canvas'),'owner-revocation-retires-real-route-and-owned-output');await samples(2);check(second.status().frames>other,'unrelated-recipient-survives-owner-revocation');example.setConsent('first','source',true);first=await example.start('first');check(await first.ready,'fresh-owner-signal-recovery');await samples(2);check(first.status().frames>0,'fresh-binding-real-pixel-recovery');
 await reset();approvalMode='close';binding=await open('first');check(await binding.ready===false,'authorizer-reentry-cannot-open-codec-output');await binding.closed;check(!containers.first.querySelector('canvas')&&example.video.status().pendingNative===0,'authorizer-cancel-cleans-owned-api-work');
 await reset();binding=await open('first');check(await binding.ready,'native-oversize-fixture-binding');const admissions=decodeAdmissions;oversizeNext=true;await samples(1);check(decodeAdmissions===admissions,'intrinsic-native-chunk-byte-limit-before-decoder');await samples(2);check(binding.status().frames>0,'oversize-rejection-has-fresh-keyframe-recovery');
 await reset();binding=await open('first');check(await binding.ready,'native-description-fixture-binding');descriptionNext=true;const before=decodeAdmissions;await samples(1);await binding.closed;check(decodeAdmissions===before&&binding.status().state==='stopped','intrinsic-description-size-before-decoder');
 await reset();binding=await open('first');check(await binding.ready,'held-work-cancellation-fixture');holdDecoder=decoders.length;await samples(1);owner.abort();check(binding.status().state==='stopped'&&binding.status().pendingNative>0,'logical-cancel-retains-issued-native-flush');release();await binding.closed;check(!containers.first.querySelector('canvas')&&example.video.status().pendingNative===0,'actual-api-settlement-after-cancel');
 await reset();binding=await open('first');check(await binding.ready,'controller-owner-fixture');Object.defineProperty(owner.signal,'aborted',{value:false});owner.abort();await binding.closed;check(binding.status().state==='stopped','intrinsic-controller-owner-revocation');
 await reset();binding=await open('first');drawObserver=(canvas,input)=>{if(input instanceof NativeFrame){drawObserver=undefined;owner.abort();}};await samples(1);await binding.closed;check(binding.status().frames===0&&!containers.first.querySelector('canvas'),'native-staging-callback-revocation-blocks-visible-copy');
 await reset();binding=await open('first');drawObserver=(canvas,input)=>{if(input instanceof NativeFrame){drawObserver=undefined;clockObserver=()=>{clockObserver=undefined;owner.abort();};}};await samples(1);await binding.closed;check(binding.status().frames===0&&!containers.first.querySelector('canvas'),'final-host-clock-revocation-blocks-visible-copy');
 await example.stop();check(source.width===320&&source.height===180&&containers.first.children.length===1&&containers.second.children.length===1,'borrowed-source-and-container-sentinels-preserved');check(encoders.every(codec=>codec.state==='closed')&&decoders.every(codec=>codec.state==='closed')&&rawCallbacks===0&&held.length===0&&nativeFrames===frameClosures,'owned-codecs-frames-and-observed-api-callbacks-closed');return{producer,checks,nativeChunks,decodeAdmissions,nativeFrames,frameClosures,nativeChunkTypes:{key:observedTypes.filter(type=>type==='key').length,delta:observedTypes.filter(type=>type==='delta').length},configuredFormats:[...new Map(configurations.map(({encoder,...format})=>[JSON.stringify(format),format])).values()],rawCallbacks,controller:example.video.status(),browserInternalQuiescenceClaim:false,softwareChunkLoss:true,ipNetworkLoss:false,interFrameStreaming:false,achievedBitrate:'unknown'};
 `}
 },async unsupported(){await reset();const binding=await open('first'),ready=await binding.ready;await binding.closed;await example.stop();return{ready,reason:binding.status().reason,encoders:encoders.length,decoders:decoders.length,pending:example.video.status().pendingNative};},async finish(){release();if(example)await example.stop();owner?.abort();}};
${failuresOnly ? failureCells : ''}
globalThis.ready=true;
</script></html>`;
  const server = createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    if (!/^\/@101\/(device-model|device-runtime|transport-webrtc|transport-websocket|device-web|vision|connect)\/(dist|examples)\/[a-z0-9-]+\.js$/.test(request.url ?? '')) { response.writeHead(404); response.end(); return; }
    const [, , name, kind, file] = request.url.split('/');
    const path = sourceMode ? kind === 'examples' ? join(compiled, 'examples/device-pipelines', file) : join(compiled, 'packages', name, 'src', file) : join(consumer, 'node_modules/@101', name, kind, file);
    try { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(path)); } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, results = []; let genuineFeatureMissing = false;
  try {
    for (const [name, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage(), errors = [], foreign = [];
        page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (!request.url().startsWith(origin + '/')) foreign.push(request.url()); });
        await page.goto(origin); await page.waitForFunction(() => globalThis.ready); const prefix = failuresOnly ? undefined : await page.evaluate(() => globalThis.fixture.prefix());
        let result;
        try {
          if (failuresOnly) { result = await page.evaluate(() => globalThis.failureFixture.run()); assert.equal(result.evidence.length, 11); assert.equal(result.rawCallbacks, 0); assert.equal(result.nativeFrames, result.frameClosures); }
          else if (!prefix.supported) { result = feature ? { unsupported: prefix.reason, missingFeatureClaim: false } : await page.evaluate(() => globalThis.fixture.unsupported());
            if (!feature) assert.deepEqual(result, { ready: false, reason: 'unsupported', encoders: 0, decoders: 0, pending: 0 });
          } else { assert.ok(prefix.emitted > 0 && prefix.decoded > 0 && prefix.pixel[0] > 150, JSON.stringify({engine:name,nativePrefix:prefix})); result = await page.evaluate(() => globalThis.fixture.run());
            if (feature) { genuineFeatureMissing ||= result.missingApi; assert.equal(result.missingApi, true); }
            else assert.ok(result.checks.length > 20 && result.controller.pendingNative === 0 && result.rawCallbacks === 0);
          }
        } finally { await page.evaluate(() => globalThis.fixture.finish()); }
        assert.deepEqual(errors, []); assert.deepEqual(foreign, []); results.push({ engine: name, browserVersion: browser.version(), nativePrefix: prefix, result, pageErrors: 0, foreignRequests: 0 });
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(readFileSync(join(root, path))), pin);
  for (const [path, pin] of installed) assert.equal(hash(readFileSync(path)), pin);
  for (const [path, pin] of compilerPins) assert.equal(hash(readFileSync(path)), pin);
  const directory = mkdtempSync(join(tmpdir(), '101-application-video-codec-proof-')), receipt = join(directory, 'provenance.json');
  writeFileSync(receipt, JSON.stringify({ pins, provenance, compilerPins: Object.fromEntries(compilerPins), node: process.version }, null, 2));
  const bytes = readFileSync(receipt); assert.ok(bytes.length <= 256 * 1024);
  const output = { result: 'pass', profile: 'local-application-video-codec/1', selection: failuresOnly ? 'vp8-refusal-and-lifecycle-only' : 'existing-codec-profile', results, provenance: { path: receipt, sha256: hash(bytes) }, ownedBrowserContexts: 0,
    ownedServers: 0, cameraPermission: false, hardwareCodecClaim: false, networkLossClaim: false, browserInternalMemoryClaim: false, v06FullMatrix: false };
  const serialized = JSON.stringify(output) + '\n'; assert.ok(Buffer.byteLength(serialized) <= (failuresOnly ? 65536 : 16384)); process.stdout.write(serialized);
  if (feature) assert.equal(genuineFeatureMissing, false, 'actual native codec producer works; selected public encoded controller is missing');
} finally { if (compiled) rmSync(compiled, { recursive: true, force: true }); if (ownedProbe) rmSync(ownedProbe, { recursive: true, force: true }); }
