#!/usr/bin/env node
/** Ordinary installed public JS with explicitly software-only held haptic ports.
 * This tool never acquires a native/browser haptic backend or claims physical cancellation. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
assert.ok(args.length === 4 && args[0] === '--installed', 'Use --installed <manifest> <clean-consumer> <immutable-caller-tree>');
assert.equal(process.version, 'v24.14.0');
const root = realpathSync(resolve(import.meta.dirname, '..')), names = ['connect', 'device-model', 'device-runtime', 'device-web', 'vision', 'transport-webrtc', 'transport-websocket'];
const owned = ['packages/device-runtime/src/haptic-output.ts', 'packages/device-runtime/src/haptic-output.test.ts', 'tools/qa-haptic-retirement.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function bytes(path, limit = 4 * 1024 * 1024) {
  assert.equal(realpathSync(path), path); const stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.isFile(), true); assert.ok(stat.size <= limit);
  const value = readFileSync(path); assert.ok(value.byteLength <= limit); return value;
}
function json(path) { return JSON.parse(bytes(path)); }
function files(directory, budget = { left: 1024 }) {
  return readdirSync(directory).sort().flatMap(name => {
    assert.ok(--budget.left >= 0); const path = join(directory, name), stat = lstatSync(path); assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) return files(path, budget); assert.equal(stat.isFile(), true); return [path];
  });
}
function gitBlobs(queries) {
  const keys = [...new Set(queries)]; assert.ok(keys.length > 0 && keys.length <= 1028);
  for (const key of keys) assert.match(key, /^[0-9a-f]{40}:[A-Za-z0-9_./-]+$/);
  const data = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: keys.join('\n') + '\n', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  let cursor = 0; const result = new Map();
  for (const key of keys) {
    const end = data.indexOf(10, cursor); assert.ok(end >= cursor && end - cursor <= 128);
    const header = data.subarray(cursor, end).toString('ascii').match(/^([0-9a-f]{40}) blob ([0-9]+)$/); assert.ok(header);
    const size = Number(header[2]); assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 1048576);
    const first = end + 1, last = first + size; assert.ok(last < data.byteLength); assert.equal(data[last], 10);
    result.set(key, hash(data.subarray(first, last))); cursor = last + 1;
  }
  assert.equal(cursor, data.byteLength); assert.equal(result.size, keys.length); return result;
}
const consumer = realpathSync(resolve(args[2])), manifestPath = realpathSync(resolve(args[1])), callerTree = args[3];
assert.ok(consumer.startsWith(join(realpathSync('/tmp'), '101-sdk-consumer-'))); assert.equal(lstatSync(join(consumer, 'node_modules')).isSymbolicLink(), false);
assert.match(callerTree, /^[0-9a-f]{40}$/);
const consumerReceipt = json(join(consumer, 'receipt.json')), manifestBytes = bytes(manifestPath), manifest = JSON.parse(manifestBytes);
assert.equal(consumerReceipt.status, 'pass'); assert.equal(consumerReceipt.manifest.path, manifestPath); assert.equal(consumerReceipt.manifest.sha256, hash(manifestBytes));
assert.equal(manifest.schemaVersion, 1); assert.match(manifest.source.tree, /^[0-9a-f]{40}$/); assert.equal(consumerReceipt.source.tree, manifest.source.tree);
assert.deepEqual(consumerReceipt.source.sha256, manifest.source.sha256);
assert.equal(manifest.packages.length, 7); assert.deepEqual(manifest.packages.map(item => item.name).sort(), names.map(name => '@101/' + name).sort());
const sourceTree = manifest.source.tree, sourcePins = Object.fromEntries(owned.map(path => [path, hash(bytes(join(root, path)))]));
const dependencies = manifest.source.sha256, dependencyPaths = Object.keys(dependencies); assert.ok(dependencyPaths.length > 0 && dependencyPaths.length <= 512);
assert.equal(dependencies[owned[0]], sourcePins[owned[0]], 'Fresh installed haptic implementation required');
const queries = owned.map(path => callerTree + ':' + path);
for (const path of dependencyPaths) {
  assert.ok(!isAbsolute(path) && !path.split('/').includes('..') && resolve(root, path).startsWith(root + sep)); assert.match(dependencies[path], /^[0-9a-f]{64}$/);
  assert.equal(hash(bytes(join(root, path))), dependencies[path]);
  for (const tree of new Set([sourceTree, callerTree])) queries.push(tree + ':' + path);
}
const blobs = gitBlobs(queries);
for (const path of owned) assert.equal(blobs.get(callerTree + ':' + path), sourcePins[path]);
for (const path of dependencyPaths) for (const tree of new Set([sourceTree, callerTree])) assert.equal(blobs.get(tree + ':' + path), dependencies[path]);
const installedBytes = {}, tarballs = {};
const releaseRoot = realpathSync(join(root, 'release')), output = realpathSync(manifest.outputDir);
assert.ok(output.startsWith(join(releaseRoot, 'sdk-')) && manifestPath.startsWith(output + sep));
for (const item of manifest.packages) {
  assert.ok(isAbsolute(item.tarball) && item.tarball.startsWith(output + sep)); const archive = bytes(item.tarball, 8 * 1024 * 1024);
  assert.match(item.sha256, /^[0-9a-f]{64}$/); assert.equal(hash(archive), item.sha256); assert.equal(archive.byteLength, item.bytes); tarballs[item.tarball] = item.sha256;
  assert.ok(Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 1024);
  const paths = item.files.map(file => { assert.ok(typeof file.path === 'string' && file.path && !isAbsolute(file.path) && !file.path.split('/').includes('..'));
    assert.match(file.sha256, /^[0-9a-f]{64}$/); assert.ok(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 4 * 1024 * 1024); return file.path; });
  assert.equal(new Set(paths).size, paths.length);
  const archiveFiles = execFileSync('tar', ['-tzf', item.tarball], { timeout: 5000, maxBuffer: 1048576, encoding: 'utf8' }).trim().split('\n');
  assert.ok(archiveFiles.every(path => path.startsWith('package/') && !path.split('/').includes('..')));
  assert.deepEqual(archiveFiles.filter(path => !path.endsWith('/')).map(path => path.slice(8)).sort(), [...paths].sort());
  const prefix = join(consumer, 'node_modules', item.name); assert.equal(realpathSync(prefix), prefix);
  assert.deepEqual(files(prefix).map(path => relative(prefix, path)).sort(), [...paths].sort());
  for (const file of item.files) { const path = resolve(prefix, file.path); assert.ok(path.startsWith(prefix + sep)); const value = bytes(path);
    assert.equal(value.byteLength, file.size); assert.equal(hash(value), file.sha256); installedBytes[item.name + '/' + file.path] = file.sha256; }
}
let scratch, childResult;
try {
  scratch = realpathSync(mkdtempSync(join(consumer, 'haptic-retirement-caller-'))); mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  const caller = join(scratch, 'caller.mjs');
  const program = String.raw`import assert from 'node:assert/strict';
import * as api from '@101/connect';
import * as model from '@101/device-model';
import * as runtimeApi from '@101/device-runtime';
assert.equal(api.createHapticOutputController,runtimeApi.createHapticOutputController);
assert.equal(api.createDeviceRuntime,runtimeApi.createDeviceRuntime);
assert.equal(api.getHapticOutputProfile,model.getHapticOutputProfile);
const publicNames=${JSON.stringify(names)};
const publicResolutions=publicNames.map(name=>({name,url:import.meta.resolve('@101/'+name)}));
const results=[];let heldIssued=0,heldSettled=0;
const drain=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let at=1000,approved=true,calls=0,cancellationRequests=0,invoke=()=>held;
 let settle;let settled=false;const held=new Promise(resolve=>{settle=value=>{if(settled)return;settled=true;heldSettled++;resolve(value);};});
 const scope={principalId:'owner',applicationId:'haptic-retirement-software',sessionId:'local'};
 const runtime=api.createDeviceRuntime({now:()=>at,clockDomain:'declared-software-haptic-clock',authorize:request=>approved&&request.principalId===scope.principalId&&request.applicationId===scope.applicationId&&request.sessionId===scope.sessionId&&request.source.deviceId==='haptic-source'&&request.sink.deviceId==='haptic-output'&&request.sourceOperation==='subscribe'&&request.sinkOperation==='invoke'?{expiresAt:30000,maxAgeMs:100,maxHz:10}:undefined});
 const output=api.createHapticOutputController({runtime,deviceId:'haptic-output',now:()=>at,backend:{profileId:'app:expo-haptic-presets/1',supported:true,invoke(preset){calls++;const returned=invoke(preset);if(returned===held)heldIssued++;return returned;},cancel(){cancellationRequests++;}}});
 const cap=api.getHapticOutputProfile('app:expo-haptic-presets/1').capability;
 const source=runtime.registerSource({device:{schemaVersion:1,id:'haptic-source',label:'Software haptic source',revision:1,adapter:{id:'local:software-haptic-source',version:'1'},runtime:{platform:'owned-node-software-port'},capabilities:[{...cap,kind:'event',permissions:['subscribe']}]},capability:'preset'});
 runtime.setReadiness(source,'available');output.setAvailable(true);
 const routes=[];function route(){const value=runtime.route({from:source,to:output.endpoint,...scope,leaseMs:1000,queueCapacity:1});routes.push(value);return value;}
 const initial=route();
 return{runtime,output,source,held,route:initial,freshRoute:route,setInvoke:value=>{invoke=value;},time:value=>{at=value;},deny:()=>{approved=false;},calls:()=>calls,cancels:()=>cancellationRequests,settle,settled:()=>settled,publish:id=>runtime.publish(source,'tap',{operationId:id,deadline:at+100}),async cleanup(){settle('api-returned');await held;await drain();for(const value of routes)value.stop('software-fixture-close');output.close();runtime.close();}};
}
for(const kind of ['route-stop','runtime-revoke','output-close']){
 const f=fixture();try{
  f.setInvoke(()=>{if(kind==='route-stop')f.route.stop('inside-issued-software-port');else if(kind==='runtime-revoke')f.runtime.revoke(f.route);else f.output.close();return f.held;});
  // The exact issued held Promise is owned and settled explicitly; no polling or physical observation.
  assert.equal(f.route.start().ok,true);assert.equal(f.publish('1').ok,true);f.runtime.flush();await drain();
  assert.equal(f.calls(),1);assert.equal(f.cancels(),1);assert.equal(f.settled(),false);
  const historical=f.output.records();assert.equal(Object.isFrozen(historical),true);assert.equal(Object.isFrozen(historical[0]),true);
  assert.equal(historical[0].effect,'dispatched');assert.equal(historical[0].physical,'unverified');assert.equal(historical[0].outcome,'cancelled');assert.equal(f.route.operations()[0].effectEvidence,'dispatched');assert.equal(f.route.operations()[0].state,'cancelled');
  if(kind!=='output-close'){f.time(1100);const replacement=f.freshRoute();assert.equal(replacement.start().ok,true);assert.equal(f.publish('2').ok,true);f.runtime.flush();await drain();assert.equal(f.calls(),1);assert.equal(f.output.records()[1].outcome,'busy');assert.equal(f.output.records()[1].effect,'none');}
  else{assert.equal(f.runtime.setReadiness(f.output.endpoint,'available').ok,false);f.output.setAvailable(true);f.output.close();}
  f.settle('api-returned');await drain();await drain();assert.equal(f.cancels(),1);assert.equal(f.output.records()[0].outcome,'cancelled');assert.equal(historical[0].outcome,'cancelled');
  if(kind!=='output-close')assert.equal(f.publish('2').ok,false);else assert.equal(f.runtime.setReadiness(f.output.endpoint,'available').ok,false);
  results.push({kind,result:'pass',calls:f.calls(),cancellationRequests:f.cancels(),history:historical,physical:'unverified',cancellation:'software-request-only'});
 }finally{await f.cleanup();}
}
for(const refusal of ['busy','unavailable']){
 const f=fixture();try{f.setInvoke(()=>{f.route.stop('inside-unissued-software-refusal');return refusal;});assert.equal(f.route.start().ok,true);assert.equal(f.publish('1').ok,true);f.runtime.flush();await drain();assert.equal(f.cancels(),0);assert.equal(f.output.records()[0].effect,'none');assert.equal(f.route.operations()[0].effectEvidence,'none');results.push({kind:'sync-'+refusal,result:'pass',calls:f.calls(),cancellationRequests:0,effect:'none'});}finally{await f.cleanup();}
}
{
 const f=fixture();try{assert.equal(f.route.start().ok,true);assert.equal(f.publish('1').ok,true);f.runtime.flush();
  const until=performance.now()+500;while(f.output.records()[0]?.outcome!=='expired'&&performance.now()<until)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.output.records()[0].outcome,'expired');assert.equal(f.settled(),false);
  f.time(1100);assert.equal(f.publish('2').ok,true);f.runtime.flush();await drain();assert.equal(f.calls(),1);assert.equal(f.output.records()[1].outcome,'busy');
  f.route.stop('held-timeout-software-retirement');assert.equal(f.cancels(),1);const historical=f.output.records();f.settle('api-returned');await drain();assert.equal(f.output.records()[0].outcome,'expired');assert.equal(historical[0].physical,'unverified');results.push({kind:'logical-timeout-raw-held',result:'pass',calls:1,cancellationRequests:1,history:historical});
 }finally{await f.cleanup();}
}
{
 const f=fixture();try{f.deny();assert.equal(f.route.start().ok,false);f.publish('1');f.runtime.flush();assert.equal(f.calls(),0);assert.equal(f.cancels(),0);results.push({kind:'denied-current-route',result:'pass',calls:0,cancellationRequests:0});}finally{await f.cleanup();}
}
assert.equal(results.length,7);assert.equal(heldIssued,4);assert.equal(heldSettled,7);
console.log(JSON.stringify({result:'pass',kind:'ordinary-installed-public-software-haptic-retirement',publicResolutions,results,issuedSoftwarePromises:heldIssued,settledOwnedPromises:heldSettled,hardwareCalls:0,physicalQualification:false,closeContract:'synchronous retirement; no native/API-quiescence promise',scope:'Explicit software ports only. Optional cancel is a request, not observed physical cancellation. Controlled owner clock, real runtime grants/queues/history. All owned promises settled in finally before ordinary child exits.'}));
`;
  writeFileSync(caller, program); const callerSha256 = hash(bytes(caller));
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  childResult = await new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--no-experimental-strip-types', caller], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure, deadline = false;
    const timer = setTimeout(() => { deadline = true; child.kill('SIGTERM'); }, 5000);
    const collect = (name, chunk) => { if (name === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65536) { failure = Error('Bounded software proof output'); child.kill('SIGTERM'); } };
    child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk)); child.on('error', error => { failure = error; });
    child.on('close', (status, signal) => { clearTimeout(timer); if (failure) fail(failure); else if (deadline) fail(Error('Owned software proof deadline: ' + signal)); else done({ status, signal, stdout, stderr }); });
  });
  assert.equal(childResult.status, 0, childResult.stderr); assert.equal(childResult.signal, null); assert.equal(childResult.stderr, '');
  const proof = JSON.parse(childResult.stdout); assert.equal(proof.result, 'pass'); assert.equal(proof.results.length, 7); assert.equal(proof.hardwareCalls, 0); assert.equal(proof.physicalQualification, false);
  assert.equal(proof.publicResolutions.length, 7); assert.deepEqual(proof.publicResolutions.map(item => item.name).sort(), [...names].sort());
  for (const item of proof.publicResolutions) assert.equal(item.url, pathToFileURL(join(consumer, 'node_modules', '@101', item.name, 'dist/index.js')).href);
  for (const [path, pin] of Object.entries(installedBytes)) assert.equal(hash(bytes(join(consumer, 'node_modules', path))), pin);
  for (const [path, pin] of Object.entries(tarballs)) assert.equal(hash(bytes(path, 8 * 1024 * 1024)), pin);
  for (const path of dependencyPaths) assert.equal(hash(bytes(join(root, path))), dependencies[path]);
  for (const path of owned) assert.equal(hash(bytes(join(root, path))), sourcePins[path]); assert.equal(hash(bytes(manifestPath)), hash(manifestBytes));
  const receipt = { result: 'pass', kind: 'ordinary-installed-public-software-haptic-retirement', node: process.version,
    sourceTree, callerTree, sourcePins, dependencyPins: dependencies, manifest: { path: manifestPath, sha256: hash(manifestBytes) },
    consumerReceipt: { path: join(consumer, 'receipt.json'), sha256: hash(bytes(join(consumer, 'receipt.json'))) }, installedBytes, tarballs,
    generatedCallerSha256: callerSha256, proof, cleanup: { ownedNodeChildren: 0, ownedDirectories: 0 }, physicalQualification: false };
  rmSync(scratch, { recursive: true, force: true }); assert.equal(existsSync(scratch), false); scratch = undefined;
  console.log(JSON.stringify(receipt, null, 2));
} finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
