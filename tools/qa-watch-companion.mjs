import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { kotlinTools } from './build-pointer-bindings.mjs';
const root=resolve(import.meta.dirname,'..'), hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const directory=realpathSync(mkdtempSync(join(tmpdir(),'101-watch-companion-proof-')));
const owned=['packages/device-model/src/watch-companion-report.ts','packages/device-model/src/watch-companion-report.test.ts',
 'packages/device-runtime/src/watch-companion.ts','packages/device-runtime/src/watch-companion.test.ts','apps/controller-native/modules/one01-watch/index.ts',
 'apps/controller-native/modules/one01-watch/ios/One01WatchModule.swift',
 'apps/controller-native/modules/one01-watch/android/src/main/java/com/oneohone/link/watch/One01WatchModule.kt',
 'examples/watch-companion/consumer.mjs','tools/qa-watch-companion.mjs'];
const initialPins=process.argv[2]==='--producer-red'?undefined:Object.fromEntries(owned.map(p=>[p,hash(readFileSync(join(root,p)))]));

const swiftPath='apps/watch-ios/Sources/One01WatchCore/WatchPayload.swift';
const kotlinPath='apps/watch-wear/app/src/main/java/com/oneohone/wear/WatchPayload.kt';
const producerPins=Object.fromEntries([swiftPath,kotlinPath].map(p=>[p,hash(readFileSync(join(root,p)))]));
function run(program,args,options={}) { return execFileSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:1048576,stdio:['pipe','pipe','pipe'],...options}); }
writeFileSync(join(directory,'main.swift'),`import Foundation
let report = WatchPayload(sequence:4321,milliseconds:1234567,orientation:(0.1,-0.2,0.3,0.927),acceleration:(0.5,-1.25,0.125),rotationRate:(120.5,-45.25,8),crown:42.5,tap:true)
print(report.encoded().map{String(format:"%02x",$0)}.joined())
`);
run('/usr/bin/xcrun',['swiftc',join(root,swiftPath),join(directory,'main.swift'),'-o',join(directory,'swift-producer')]);
const swiftHex=run(join(directory,'swift-producer'),[]).trim();
writeFileSync(join(directory,'Producer.kt'),`import com.oneohone.wear.WatchPayload
fun main() { val report=WatchPayload(4321,1234567,floatArrayOf(0.1f,-0.2f,0.3f,0.927f),floatArrayOf(0.5f,-1.25f,0.125f),floatArrayOf(120.5f,-45.25f,8f),42.5f,true); println(report.encode().joinToString(""){"%02x".format(it.toInt() and 255)}) }
`);
const kotlin=kotlinTools();
kotlin.compile(['-classpath',kotlin.stdlib+':'+kotlin.annotations,'-jvm-target','17','-d',join(directory,'kotlin.jar'),join(root,kotlinPath),join(directory,'Producer.kt')]);
const kotlinHex=run(kotlin.java,['-cp',join(directory,'kotlin.jar')+':'+kotlin.stdlib,'ProducerKt']).trim();
assert.equal(swiftHex,kotlinHex); assert.equal(swiftHex.length,106);
writeFileSync(join(directory,'producer.json'),JSON.stringify({swiftHex,kotlinHex,producerPins}));
if(process.argv[2]==='--producer-red') {
 const probe=join(directory,'missing-provider.mjs');
 writeFileSync(probe,`import assert from 'node:assert/strict';let sdk;try{sdk=await import(${JSON.stringify(pathToFileURL(join(root,'packages/device-model/src/watch-companion-report.ts')).href)})}catch{};assert.equal(typeof sdk?.decodeWatchCompanionReport,'function','Actual Swift/Kotlin report has no ordinary SDK provider');sdk.decodeWatchCompanionReport(Uint8Array.from(Buffer.from(${JSON.stringify(swiftHex)},'hex')));`);
 const result=spawnSync(process.execPath,[probe],{encoding:'utf8'});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;
} else {
 const argument=process.argv[2];assert.ok(argument==='--source'&&process.argv.length===3||argument==='--sdk-root'&&(process.argv.length===4||process.argv.length===6&&process.argv[4]==='--candidate-tree'),'Use --source or --sdk-root <fresh consumer> [--candidate-tree <tree>]');
 let consumer=directory,dependencyPins,immutableManifest,installedBytes,sourceTree,callerTree,mode;

 const names=['device-model','device-runtime','transport-webrtc','transport-websocket','device-web','vision','connect'];
 const paths=Object.fromEntries(names.map(name=>['@101/'+name,[join(root,'packages',name,'src/index.ts')]]));
 function diagnose(selected) {const diagnostics=ts.getPreEmitDiagnostics(selected);assert.equal(diagnostics.length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:file=>file,getNewLine:()=> '\n'}));}
 function copy(from,to){mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);}
 function files(base){return readdirSync(base).sort().flatMap(name=>{const file=join(base,name);assert.equal(lstatSync(file).isSymbolicLink(),false);return lstatSync(file).isDirectory()?files(file):[file];});}
 if(argument==='--source') {
  mode='owned-seven-package-public-source-closure';sourceTree=run('git',['rev-parse','HEAD'],{cwd:root}).trim();
  const program=ts.createProgram(names.map(name=>join(root,'packages',name,'src/index.ts')),{
   target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
   lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts'],strict:true,noUncheckedIndexedAccess:true,types:[],skipLibCheck:false,
   noEmitOnError:true,rewriteRelativeImportExtensions:true,rootDir:root,outDir:join(directory,'compiled'),paths});
  diagnose(program);
  const sources=program.getSourceFiles().filter(file=>!file.isDeclarationFile);
  assert.ok(sources.length<=512&&sources.every(file=>names.some(name=>file.fileName.startsWith(join(root,'packages',name,'src')+'/'))&&!file.fileName.endsWith('.test.ts')));
  dependencyPins=Object.fromEntries(sources.map(file=>[relative(root,file.fileName),hash(Buffer.from(file.text))]));
  for(const [path,pin]of Object.entries(dependencyPins))assert.equal(hash(readFileSync(join(root,path))),pin);
  assert.equal(program.emit().emitSkipped,false);
  for(const name of names){const source=join(directory,'compiled/packages',name,'src'),target=join(directory,'node_modules/@101',name);
   const emitted=files(source);assert.ok(emitted.length<=1024);
   for(const file of emitted)copy(file,join(target,'dist',relative(source,file)));
   writeFileSync(join(target,'package.json'),JSON.stringify({name:'@101/'+name,type:'module',exports:{'.':{import:'./dist/index.js'}}}));
  }
 } else {
  mode='installed-immutable-public-sdk';consumer=realpathSync(resolve(process.argv[3]));assert.ok(consumer.startsWith(join(realpathSync('/tmp'),'101-sdk-consumer-')));
  function json(path){const data=readFileSync(path);assert.ok(data.byteLength<=4*1024*1024);return JSON.parse(data);}
  const receipt=json(join(consumer,'receipt.json'));assert.equal(receipt.status,'pass');sourceTree=receipt.source.tree;assert.match(sourceTree,/^[0-9a-f]{40}$/);
  callerTree=process.argv[5]??sourceTree;assert.match(callerTree,/^[0-9a-f]{40}$/);
  for(const [path,pin]of Object.entries(initialPins)){const bytes=execFileSync('git',['cat-file','blob',callerTree+':'+path],{cwd:root,maxBuffer:1048576,timeout:5000});assert.equal(hash(bytes),pin);}
  const manifestRaw=readFileSync(receipt.manifest.path);assert.ok(manifestRaw.byteLength<=4*1024*1024);assert.equal(hash(manifestRaw),receipt.manifest.sha256);
  const manifest=JSON.parse(manifestRaw);assert.equal(manifest.source.tree,sourceTree);assert.deepEqual(manifest.source.sha256,receipt.source.sha256);dependencyPins=manifest.source.sha256;
  assert.ok(Object.keys(dependencyPins).length>0&&Object.keys(dependencyPins).length<=512&&Object.hasOwn(dependencyPins,'packages/device-runtime/src/watch-companion.ts')&&Object.hasOwn(dependencyPins,'packages/device-model/src/watch-companion-report.ts'));
  for(const [path,pin]of Object.entries(dependencyPins)){
   assert.ok(resolve(root,path).startsWith(root+'/'));assert.match(pin,/^[0-9a-f]{64}$/);
   for(const tree of new Set([sourceTree,callerTree]))assert.equal(hash(execFileSync('git',['cat-file','blob',tree+':'+path],{cwd:root,maxBuffer:1048576,timeout:5000})),pin);
   assert.equal(hash(readFileSync(join(root,path))),pin);
  }
  assert.deepEqual(manifest.packages.map(item=>item.name).sort(),names.map(name=>'@101/'+name).sort());installedBytes={};
  assert.equal(lstatSync(join(consumer,'node_modules')).isSymbolicLink(),false);
  for(const item of manifest.packages){const prefix=join(consumer,'node_modules',item.name);assert.equal(realpathSync(prefix),prefix);assert.ok(Array.isArray(item.files)&&item.files.length>0&&item.files.length<=1024);
   for(const file of item.files){const installed=resolve(prefix,file.path);assert.ok(installed.startsWith(prefix+'/'));assert.equal(realpathSync(dirname(installed)),dirname(installed));assert.equal(realpathSync(installed),installed);assert.ok(lstatSync(installed).isFile());assert.equal(hash(readFileSync(installed)),file.sha256);installedBytes[item.name+'/'+file.path]=file.sha256;}
  }
  immutableManifest={path:receipt.manifest.path,sha256:receipt.manifest.sha256};
 }
 const nativePath='apps/controller-native/modules/one01-watch/index.ts';
 const nativeProgram=ts.createProgram([join(root,nativePath)],{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
  lib:['lib.es2022.d.ts','lib.dom.d.ts'],strict:true,noUncheckedIndexedAccess:true,skipLibCheck:true,noEmit:true,allowImportingTsExtensions:true,paths});
 diagnose(nativeProgram);
 const nativeSource=readFileSync(join(root,nativePath),'utf8');
 writeFileSync(join(directory,'native.js'),ts.transpileModule(nativeSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
 const expo=join(directory,'node_modules/expo-modules-core');mkdirSync(expo,{recursive:true});
 writeFileSync(join(expo,'package.json'),JSON.stringify({type:'module',exports:'./index.js'}));
 writeFileSync(join(expo,'index.js'),"export class NativeModule{};export function requireNativeModule(){return globalThis.__watchSoftwarePort;}\n");
 writeFileSync(join(directory,'package.json'),JSON.stringify({type:'module'}));
 const callerDirectory=realpathSync(mkdtempSync(join(consumer,'watch-companion-caller-')));
 copy(join(root,'examples/watch-companion/consumer.mjs'),join(callerDirectory,'consumer.mjs'));
 writeFileSync(join(callerDirectory,'resolve.mjs'),`import * as sdk from '@101/connect';import * as runtime from '@101/device-runtime';import * as model from '@101/device-model';
if(sdk.createWatchCompanionResources!==runtime.createWatchCompanionResources||sdk.decodeWatchCompanionReport!==model.decodeWatchCompanionReport)throw Error('Facade identity');
console.log(import.meta.resolve('@101/connect'));`);
 const environment={...process.env};delete environment.NODE_OPTIONS;delete environment.NODE_PATH;
 const publicUrl=run(process.execPath,['--no-experimental-strip-types',join(callerDirectory,'resolve.mjs')],{env:environment}).trim();
 assert.equal(publicUrl,pathToFileURL(join(consumer,'node_modules/@101/connect/dist/index.js')).href);
 const caller=JSON.parse(run(process.execPath,['--no-experimental-strip-types',join(callerDirectory,'consumer.mjs'),join(directory,'producer.json')],{env:environment}));
 assert.equal(caller.status,'pass');assert.equal(caller.checks.length,32);
 writeFileSync(join(directory,'issuer.mjs'),`import assert from 'node:assert/strict';
const checks=[], listeners=new Map();let epoch=0,stopCalls=0,startCalls=0,holding,dispatchReentry;const removed=[];
const port={async enrollResources(){return{platform:'wearos',epoch:++epoch,companionPaired:true,appInstalled:true,reachable:true,nearby:true};},
 async startResources(value){assert.equal(value,epoch);startCalls++;await holding;},async stopResources(value){assert.equal(value,epoch);stopCalls++;},
 addListener(name,fn){listeners.set(name,fn);dispatchReentry?.();return{remove(){removed.push(name);if(listeners.get(name)===fn)listeners.delete(name);}};}};
globalThis.__watchSoftwarePort=port;
const {createWatchResourceBridge}=await import('./native.js');const bridge=createWatchResourceBridge(),replacement=createWatchResourceBridge();
const owner=new AbortController();const enrolled=await bridge.enroll(owner.signal);
await assert.rejects(replacement.start({...enrolled},()=>{},()=>{},owner.signal));checks.push('copied enrollment refused across helper');
await assert.rejects(bridge.start({...enrolled},()=>{},()=>{},owner.signal));checks.push('copied enrollment refused within helper');
let reports=0,losses=0;await bridge.start(enrolled,event=>{assert.equal(event.enrollment,enrolled);reports++;},()=>losses++,owner.signal);
const sample=listeners.get('onWatchResourceSample'),loss=listeners.get('onWatchResourceLoss');
sample({epoch:epoch+1,data:'A'.repeat(72)});assert.equal(reports,0);checks.push('old epoch fenced before ingress');
sample({epoch,data:'A'.repeat(72)});assert.equal(reports,1);checks.push('native-issued token preserved on software ingress');
loss({epoch:epoch+1});assert.equal(enrolled.signal.aborted,false);checks.push('foreign loss does not retire scope');
loss({epoch});assert.equal(enrolled.signal.aborted,true);assert.equal(losses,1);sample({epoch,data:'A'.repeat(72)});assert.equal(reports,1);checks.push('native loss aborts issuer and late reports inert');
await bridge.stop(enrolled);assert.equal(listeners.size,0);checks.push('owned listeners removed');
const nextOwner=new AbortController(),next=await replacement.enroll(nextOwner.signal);assert.notEqual(next,enrolled);checks.push('fresh helper enrollment after actual cleanup');
let finish;holding=new Promise(resolve=>{finish=resolve;});const pending=replacement.start(next,()=>{},()=>{},nextOwner.signal);await new Promise(resolve=>setImmediate(resolve));
nextOwner.abort();await assert.rejects(bridge.enroll(new AbortController().signal));assert.equal(stopCalls,1);checks.push('replacement busy while raw native start unresolved');
finish();await assert.rejects(pending);await replacement.stop(next);assert.equal(stopCalls,2);checks.push('cleanup waits actual native settlement');
holding=undefined;const reentrantOwner=new AbortController(),last=await bridge.enroll(reentrantOwner.signal);
dispatchReentry=()=>reentrantOwner.abort();await assert.rejects(bridge.start(last,()=>{},()=>{},reentrantOwner.signal));dispatchReentry=undefined;
await bridge.stop(last);assert.equal(listeners.size,0);assert.equal(startCalls,2);checks.push('listener callback cancellation prevents native start and removes late subscription');
const spoof=new AbortController();Object.defineProperty(spoof.signal,'aborted',{value:false});spoof.abort();await assert.rejects(bridge.enroll(spoof.signal));checks.push('intrinsic signal rejects shadowed aborted state');
console.log(JSON.stringify({status:'pass',checks,nativeDelivery:'unqualified software port',removed:removed.length}));`);
 const issuer=JSON.parse(run(process.execPath,['--no-experimental-strip-types',join(directory,'issuer.mjs')],{env:environment}));
 assert.equal(issuer.status,'pass');assert.equal(issuer.checks.length,12);
 const pins=initialPins;
 for(const [p,pin]of Object.entries(pins))assert.equal(hash(readFileSync(join(root,p))),pin,'Owned source changed during proof');
 for(const [p,pin]of Object.entries({...producerPins,...dependencyPins}))assert.equal(hash(readFileSync(join(root,p))),pin,'Source changed during proof');
 const receipt={status:'pass',profile:'watch-companion-report/1',mode,directory,consumer,callerDirectory,sourceBaseOrPackedTree:sourceTree,...(immutableManifest?{immutableManifest,installedBytes,callerTree}:{}),sourceSha256:pins,dependencySha256:dependencyPins,producerSha256:producerPins,
  publicEsmUrl:publicUrl,producer:{swiftHex,kotlinHex,swift:run('/usr/bin/xcrun',['swiftc','--version']).trim(),kotlin:'2.1.21',kotlinCompiler:kotlin.compilerSha256,jvmTarget:17,qualifiedJvmRuntime:21},
  caller,issuer,nativeIssuerTypecheck:'Actual installed Expo TypeScript declarations; Swift/Kotlin native issuer compilation and OS delivery unqualified',
  scope:'Pure unchanged watch software producers plus ordinary JS public runtime effects and native bridge software ports. No physical measurements, capture time, hardware identity/authentication, phone/watch permissions or native OS delivery qualification.'};
 writeFileSync(join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({receiptPath:join(directory,'receipt.json'),...receipt}));
}
