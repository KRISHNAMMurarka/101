import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
assert.ok(args.length === 1 || args.length === 2 && args[1] === '--old-regression',
  'Usage: node tools/qa-fair-delivery.mjs <owned consumer> [--old-regression]');
const consumer = realpathSync(resolve(process.argv[2] ?? ''));
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-')));
assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
const receipt = JSON.parse(readFileSync(join(consumer, 'receipt.json'), 'utf8'));
assert.equal(receipt.status, 'pass');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePath = 'packages/device-runtime/src/runtime.ts';
const sourcePins = Object.fromEntries([sourcePath, 'packages/device-runtime/src/types.ts'].map(path =>
  [path, hash(readFileSync(join(root, path)))]));
// Allow the old pack only for the explicitly requested before-fix regression.
if (!process.argv.includes('--old-regression')) {
  for (const [path, pin] of Object.entries(sourcePins)) {
    assert.equal(pin, receipt.source.sha256[path]);
    assert.equal(pin, hash(execFileSync('git', ['cat-file', 'blob', `${receipt.source.tree}:${path}`], { cwd: root })));
  }
}
const manifestBytes = readFileSync(receipt.manifest.path);
assert.equal(hash(manifestBytes), receipt.manifest.sha256);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.source.tree, receipt.source.tree);
assert.equal(manifest.packages.length, 7);
for (const name of ['device-model', 'device-runtime', 'transport-webrtc', 'transport-websocket', 'device-web', 'vision', 'connect']) {
  const pkg = manifest.packages.find(value => value.name === '@101/' + name);
  assert.ok(pkg && Array.isArray(pkg.files) && pkg.files.length > 0 && pkg.files.length <= 1024);
  const directory = join(consumer, 'node_modules/@101', name);
  assert.equal(lstatSync(directory).isSymbolicLink(), false);
  assert.equal(realpathSync(directory), directory);
  for (const file of pkg.files) {
    const path = resolve(directory, file.path);
    assert.ok(path.startsWith(directory + '/'));
    assert.equal(lstatSync(path).isSymbolicLink(), false);
    assert.equal(realpathSync(path), path);
    assert.equal(hash(readFileSync(path)), file.sha256);
  }
}
const caller = `import assert from 'node:assert/strict';
import { createDeviceRuntime } from '@101/connect';
function device(id,reliable,sink=false){return{schemaVersion:1,id,label:id,revision:1,
 adapter:{id:'example:fair-delivery',version:'1.0.0'},runtime:{platform:'embedded-node'},
 capabilities:[{id:'signal',semantic:'example:fair-delivery',schemaVersion:1,
 kind:sink?reliable?'command':'property':reliable?'event':'sample',value:{type:'boolean'},
 delivery:reliable?{mode:'reliable',maxAgeMs:5000}:{mode:'latest',maxHz:100,maxAgeMs:1000},
 permissions:sink?[reliable?'invoke':'write']:['subscribe'],...(sink?{ownership:{mode:'exclusive'}}:{})}]};}
async function run(reliable,recipients,slots,rounds){
 let now=0,peak=0,current=0,releases=0;const counts=Array(recipients).fill(0),finishes=[],routes=[],sources=[],approved=new Set();
 const key=r=>[r.principalId,r.applicationId,r.sessionId,r.source.deviceId,r.sink.deviceId].join('|');
 const runtime=createDeviceRuntime({now:()=>now,maxRoutes:128,maxPendingDeliveries:slots,
 authorize:r=>approved.has(key(r))?{expiresAt:100000,maxAgeMs:5000,maxHz:100}:undefined});
 try{
  for(let group=0;group<Math.ceil(recipients/32);group++){
   const source=runtime.registerSource({device:device('source-'+group,reliable),capability:'signal'});
   runtime.setReadiness(source,'available');sources.push(source);
  }
  for(let i=0;i<recipients;i++){
   const source=sources[Math.floor(i/32)];const sink=runtime.registerSink({device:device('sink-'+i,reliable,true),capability:'signal',
    apply(o,c){assert.equal(o.value,true);assert.equal(c.isCurrent(),true);counts[i]++;current++;peak=Math.max(peak,current);
     return new Promise(resolve=>finishes.push(()=>{current--;resolve();}));},release(){releases++;}});
   runtime.setReadiness(sink,'available');
   const request={from:source,to:sink,principalId:'owner-'+i,applicationId:'fair-delivery',sessionId:'session-'+i,queueCapacity:16};
   const denied=runtime.route(request);assert.equal(denied.start().ok,false);
   approved.add([request.principalId,request.applicationId,request.sessionId,'source-'+Math.floor(i/32),'sink-'+i].join('|'));
   const route=runtime.route(request);assert.equal(route.start().ok,true);routes.push(route);
  }
  for(let round=0;round<rounds;round++){
   now+=20;for(const source of sources)assert.equal(runtime.publish(source,true,reliable?{operationId:String(round+1),deadline:now+5000}:{}).ok,true);
   runtime.flush();assert.equal(current,slots);for(const finish of finishes.splice(0))finish();
   await new Promise(resolve=>setImmediate(resolve));assert.equal(current,0);
   if(round+1===Math.ceil(recipients/slots))assert.equal(counts.filter(value=>value>0).length,recipients,'all continuously eligible recipients served within one bounded round');
  }
  assert.ok(Math.max(...counts)-Math.min(...counts)<=1);assert.equal(peak,slots);
  runtime.close();assert.ok(routes.every(route=>route.status().state==='closed'&&route.status().pending===0));assert.equal(releases,recipients);
  return{delivery:reliable?'reliable':'latest',recipients,sourceGroups:sources.length,slots,rounds,deliveries:counts.reduce((a,b)=>a+b,0),minimum:Math.min(...counts),maximum:Math.max(...counts),peakPending:peak,releases};
 }finally{runtime.close();for(const finish of finishes.splice(0))finish();}
}
async function runScoped(reliable,failed){
 let now=0,operation=0,effects=0,sequence=0;const approved=new Map(),held=[],routes=[];
 const scope={principalId:'scope-owner',applicationId:'scope-app',sessionId:'scope-session'};
 const scopeKey=r=>JSON.stringify([r.principalId,r.applicationId,r.sessionId]);
 let sourceId='';
 const runtime=createDeviceRuntime({now:()=>now,maxPendingDeliveries:4,maxPendingDeliveriesPerScope:1,
  authorize:r=>r.source.registrationId===sourceId&&approved.get(r.sink.registrationId)===scopeKey(r)&&r.sourceOperation==='subscribe'&&r.sinkOperation===(reliable?'invoke':'write')?{expiresAt:10000,maxAgeMs:5000,maxHz:100}:undefined});
 const source=runtime.registerSource({device:device('scoped-source',reliable),capability:'signal'});sourceId=source.id;runtime.setReadiness(source,'available');
 function route(selected,slow){
  const sink=runtime.registerSink({device:device('scoped-sink-'+(++sequence),reliable,true),capability:'signal',
   apply(o,c){assert.equal(o.value,true);assert.equal(c.isCurrent(),true);if(!slow){effects++;return;}
    return new Promise((resolve,reject)=>held.push({context:c,finish:()=>failed?reject(Error('retired provider failure')):resolve()}));},release(){}});
  runtime.setReadiness(sink,'available');const request={from:source,to:sink,...selected,queueCapacity:4};
  assert.equal(runtime.route(request).start().ok,false);approved.set(sink.id,scopeKey(selected));
  const result=runtime.route(request);assert.equal(result.start().ok,true);routes.push(result);return result;
 }
 function publish(){now+=20;assert.equal(runtime.publish(source,true,reliable?{operationId:String(++operation),deadline:now+1000}:{}).ok,true);runtime.flush();}
 try{
  const first=route(scope,true);route(scope,true);route(scope,true);
  route({...scope,principalId:'another-owner'},false);route({...scope,applicationId:'another-app'},false);route({...scope,sessionId:'another-session'},false);
  publish();assert.equal(held.length,1,'one exact authorized scope cannot occupy every global slot');assert.equal(effects,3);
  first.stop('replacement');assert.equal(held[0].context.signal.aborted,true);assert.equal(held[0].context.isCurrent(),false);
  publish();assert.equal(held.length,1,'retirement retains actual unsettled scope reservation');assert.equal(effects,6);
  held[0].finish();await new Promise(resolve=>setImmediate(resolve));publish();assert.equal(held.length,2);assert.equal(effects,9);
  runtime.close();for(const entry of held)entry.finish();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(routes.every(route=>route.status().state==='closed'&&route.status().pending===0));
  return{delivery:reliable?'reliable':'latest',originalProviderResult:failed?'rejected':'returned',globalCap:4,scopeCap:1,otherScopes:3,otherEffects:effects,successorInvocations:held.length-1,retiredScopeHeldUntilRawSettlement:true};
 }finally{runtime.close();for(const entry of held)entry.finish();}
}
const workloads=[await run(false,6,2,12),await run(true,6,2,12),await run(false,128,4,64)];
const scopedWorkloads=[];for(const reliable of [false,true])for(const failed of [false,true])scopedWorkloads.push(await runScoped(reliable,failed));
console.log(JSON.stringify({status:'pass',node:process.versions.node,workloads,scopedWorkloads,checks:['exact-host-approval','bounded-global-pending','no-starvation-under-completing-provider-contention','balanced-recipient-service','reliable-and-latest','route-and-release-teardown','exact-scope-cap','no-slot-release-on-logical-retirement','raw-settlement-allows-current-successor']}));
`;
const callerPath = join(consumer, 'fair-delivery-caller.mjs');
writeFileSync(callerPath, caller);
const proof = JSON.parse(execFileSync(process.execPath, ['--no-experimental-strip-types', callerPath], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, cwd: consumer,
  env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } }));
const result = { ...proof, sourceTree: receipt.source.tree, sourceSha256: receipt.source.sha256[sourcePath],
  sourcePins: Object.fromEntries(Object.keys(sourcePins).map(path => [path, receipt.source.sha256[path]])),
  manifest: receipt.manifest,
  qaToolSha256: hash(readFileSync(import.meta.filename)),
  limitations: ['Cooperating local JavaScript providers; callback CPU is not sandboxed.',
    'Omitted scope cap preserves the global policy; enough independently authorized scopes can still occupy every global slot.',
    'No physical, network, browser scheduling or per-tenant CPU/byte quota qualification.'] };
writeFileSync(join(consumer, 'fair-delivery-receipt.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
