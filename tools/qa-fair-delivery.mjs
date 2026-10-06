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
const sourceSha256 = hash(readFileSync(join(root, sourcePath)));
// Allow the old pack only for the explicitly requested before-fix regression.
if (!process.argv.includes('--old-regression')) {
  assert.equal(sourceSha256, receipt.source.sha256[sourcePath]);
  assert.equal(sourceSha256, hash(execFileSync('git', ['cat-file', 'blob', `${receipt.source.tree}:${sourcePath}`], { cwd: root })));
}
const manifestBytes = readFileSync(receipt.manifest.path);
assert.equal(hash(manifestBytes), receipt.manifest.sha256);
const manifest = JSON.parse(manifestBytes);
for (const name of ['device-model', 'device-runtime', 'connect']) {
  const pkg = manifest.packages.find(value => value.name === '@101/' + name);
  assert.ok(pkg && Array.isArray(pkg.files));
  const directory = join(consumer, 'node_modules/@101', name);
  assert.equal(lstatSync(directory).isSymbolicLink(), false);
  for (const file of pkg.files) {
    const path = resolve(directory, file.path);
    assert.ok(path.startsWith(directory + '/'));
    assert.equal(lstatSync(path).isSymbolicLink(), false);
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
const workloads=[await run(false,6,2,12),await run(true,6,2,12),await run(false,128,4,64)];
console.log(JSON.stringify({status:'pass',node:process.versions.node,workloads,checks:['exact-host-approval','bounded-global-pending','no-starvation-under-completing-provider-contention','balanced-recipient-service','reliable-and-latest','route-and-release-teardown']}));
`;
const callerPath = join(consumer, 'fair-delivery-caller.mjs');
writeFileSync(callerPath, caller);
const proof = JSON.parse(execFileSync(process.execPath, ['--no-experimental-strip-types', callerPath], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, cwd: consumer,
  env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } }));
const result = { ...proof, sourceTree: receipt.source.tree, sourceSha256: receipt.source.sha256[sourcePath],
  manifest: receipt.manifest,
  qaToolSha256: hash(readFileSync(import.meta.filename)),
  limitations: ['Cooperating local JavaScript providers; callback CPU is not sandboxed.',
    'Providers retaining every global slot indefinitely can still block admission.',
    'No physical, network, browser scheduling or per-tenant CPU/byte quota qualification.'] };
writeFileSync(join(consumer, 'fair-delivery-receipt.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
