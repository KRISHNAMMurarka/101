import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, lstatSync, rmSync, mkdtempSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import ts from 'typescript';
import { installedSdk, fileHash } from './build-pointer-bindings.mjs';
import { zigbeeSourceFingerprints, zigbeeBrokerBinary } from './qa-zigbee2mqtt-bridge.mjs';

/** Captures actual artifact and receipt bytes; caller verifies only after its owned
 * native child has naturally exited and emitted close. No fixture bypass. */
export function captureZigbeeAcceptance({artifactPaths,receiptPath,dependencyReceiptPath,readClosure}) {
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const artifactSha256=Object.fromEntries(Object.entries(artifactPaths).map(([name,path])=>[name,fileHash(path)]));
  const sdkBytes=readFileSync(receiptPath),dependencyBytes=readFileSync(dependencyReceiptPath),closure=readClosure();
  return Object.freeze({artifactSha256,verify(){
    const finalArtifacts=Object.fromEntries(Object.entries(artifactPaths).map(([name,path])=>[name,fileHash(path)]));
    assert.deepEqual(finalArtifacts,artifactSha256,'Copied executed artifacts changed');
    const finalSdkBytes=readFileSync(receiptPath),finalDependencyBytes=readFileSync(dependencyReceiptPath);
    assert.equal(digest(finalSdkBytes),digest(sdkBytes),'SDK receipt bytes changed');
    assert.equal(digest(finalDependencyBytes),digest(dependencyBytes),'Selected dependency receipt bytes changed');
    const sdkReceipt=JSON.parse(finalSdkBytes.toString('utf8')),dependencyReceipt=JSON.parse(finalDependencyBytes.toString('utf8'));
    assert.equal(sdkReceipt.status,'pass');assert.equal(dependencyReceipt.status,'pass');
    assert.deepEqual(readClosure(sdkReceipt,dependencyReceipt),closure,'Executed SDK/dependency/source closure changed');
    return Object.freeze({finalArtifactSha256:finalArtifacts,sdkReceipt,dependencyReceipt});
  }});
}
// Adopt every lifecycle leg before waiting for IPC or running assertions.
async function runOwnedZigbeeControlChild(runnerPath,onReady) {
  const child=fork(runnerPath,[],{stdio:['ignore','ignore','pipe','ipc']});let stderr='',readyTimer,closeTimer,escalation;
  const onStderr=bytes=>{stderr=(stderr+bytes).slice(-4096);};child.stderr.on('data',onStderr);
  let onNativeError,onNativeExit,onNativeClose;
  const exit=new Promise((resolve,reject)=>{onNativeError=error=>reject(error);onNativeExit=(code,signal)=>resolve({code,signal});child.once('error',onNativeError);child.once('exit',onNativeExit);});
  const close=new Promise(resolve=>{onNativeClose=()=>resolve();child.once('close',onNativeClose);});void exit.catch(()=>{});
  let onMessage,onReadyError,onReadyExit;
  const clearReady=()=>{if(readyTimer)clearTimeout(readyTimer);if(onMessage)child.off('message',onMessage);if(onReadyError)child.off('error',onReadyError);if(onReadyExit)child.off('exit',onReadyExit);};
  try{
    const ready=await new Promise((resolve,reject)=>{const finish=(error,value)=>{clearReady();if(error)reject(error);else resolve(value);};
      onMessage=message=>finish(undefined,message);onReadyError=error=>finish(error);onReadyExit=()=>finish(new Error('Owned mutation-control child exited before ready '+stderr));
      child.once('message',onMessage);child.once('error',onReadyError);child.once('exit',onReadyExit);readyTimer=setTimeout(()=>finish(new Error('Owned mutation-control child timeout')),3000);
    });
    await onReady(ready);
    await new Promise((resolve,reject)=>child.send({finish:true},error=>error?reject(error):resolve()));
    const outcomes=await Promise.race([Promise.allSettled([exit,close]),new Promise((_,reject)=>{closeTimer=setTimeout(()=>reject(new Error('Owned mutation-control child close timeout')),3000);})]);
    const errors=outcomes.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Owned mutation-control child failed');
    assert.equal(outcomes[0].value.code,0,stderr);assert.equal(outcomes[0].value.signal,null);
  }finally{
    clearReady();if(closeTimer)clearTimeout(closeTimer);
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');escalation=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1000);}
    await Promise.allSettled([exit,close]);if(escalation)clearTimeout(escalation);
    child.stderr.off('data',onStderr);child.off('error',onNativeError);child.off('exit',onNativeExit);child.off('close',onNativeClose);
  }
}
/** Explicit opt-in: copied SDK files only; never registered in the unit gate. */
export async function runZigbeeControlledCopyChecks(authoritative) {
  const profile={id:'example:zigbee2mqtt-switch',revision:1,ieeeAddress:'0x0000000000000007',model:'WXKG01LM',baseTopic:'zigbee2mqtt'};
  assert.ok(authoritative);const work=mkdtempSync('/tmp/101-zigbee-controls-'),receiptPath=join(work,'receipt.json'),dependencyReceiptPath=join(work,'dependencies.json');
  try{
  const receiptBytes=readFileSync(join(authoritative,'receipt.json')),dependencyBytes=readFileSync(join(authoritative,'selected-node-connectors/receipt.json'));
  const sdkReceipt=JSON.parse(receiptBytes.toString()),dependencies=JSON.parse(dependencyBytes.toString());assert.equal(sdkReceipt.status,'pass');assert.equal(dependencies.status,'pass');
  const sdk=installedSdk(authoritative,sdkReceipt.manifest.path);assert.equal(sdk.manifestSha256,sdkReceipt.manifest.sha256);
  function ordinary(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(e=>{const path=join(directory,e.name);assert.ok(!lstatSync(path).isSymbolicLink());return e.isDirectory()?ordinary(path):[path];});}
    for(const record of sdk.manifest.packages){const target=join(work,'node_modules',record.name);mkdirSync(join(target,'..'),{recursive:true});cpSync(join(authoritative,'node_modules',record.name),target,{recursive:true,dereference:false});}
    for(const d of dependencies.dependencies){const source=join(authoritative,'node_modules',d.path),target=join(work,'node_modules',d.path);assert.equal(fileHash(join(source,'package.json')),d.packageSha256);ordinary(source);mkdirSync(join(target,'..'),{recursive:true});cpSync(source,target,{recursive:true,dereference:false});}
    assert.equal(installedSdk(work,sdkReceipt.manifest.path).manifestSha256,sdkReceipt.manifest.sha256);writeFileSync(receiptPath,receiptBytes);writeFileSync(dependencyReceiptPath,dependencyBytes);
    const providerPath=join(work,'provider.mjs'),runnerPath=join(work,'runner.mjs');
    const providerBytes=readFileSync(new URL('../packages/hub-server/src/zigbee2mqtt-bridge.ts',import.meta.url));writeFileSync(providerPath,ts.transpileModule(providerBytes.toString(),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
    writeFileSync(runnerPath,`import{parseZigbee2MqttProfile,decodeZigbee2MqttMessage}from'./provider.mjs';const p=parseZigbee2MqttProfile(${JSON.stringify(profile)});const value=decodeZigbee2MqttMessage('zigbee2mqtt/0x0000000000000007',Buffer.from('{"action":"single"}'),false,p);process.on('message',()=>{setTimeout(()=>process.disconnect(),5);});process.send({value});`);
    const artifactPaths={providerPath,runnerPath};const sdkFile=ordinary(join(work,'node_modules/@101/connect')).find(path=>path.endsWith('.js'));assert.ok(sdkFile);const dependencyFile=join(work,'node_modules/mqtt/package.json');const originals=new Map([[providerPath,readFileSync(providerPath)],[receiptPath,receiptBytes],[dependencyReceiptPath,dependencyBytes],[sdkFile,readFileSync(sdkFile)],[dependencyFile,readFileSync(dependencyFile)]]);
    const closure=()=>Object.fromEntries(ordinary(join(work,'node_modules')).sort().map(path=>[path,fileHash(path)]));
    for(const [target,pattern] of [[providerPath,/artifacts changed/],[receiptPath,/SDK receipt bytes changed/],[dependencyReceiptPath,/dependency receipt bytes changed/],[sdkFile,/closure changed/],[dependencyFile,/closure changed/]]){
      const fence=captureZigbeeAcceptance({artifactPaths,receiptPath,dependencyReceiptPath,readClosure:closure});
      await runOwnedZigbeeControlChild(runnerPath,ready=>{assert.deepEqual(ready.value,{kind:'state',retained:false,action:'single'});writeFileSync(target,Buffer.concat([originals.get(target),Buffer.from('\n')]));});
      assert.throws(()=>fence.verify(),pattern);writeFileSync(target,originals.get(target));
    }
    const stable=captureZigbeeAcceptance({artifactPaths,receiptPath,dependencyReceiptPath,readClosure:closure});assert.ok(stable.verify());return Object.freeze({status:'pass',checks:5,actualCopiedSdk:true,actualChildExitAndClose:true,scope:'Explicit controlled-copy acceptance fences only; no ordinary installed qualification.'});
  }finally{rmSync(work,{recursive:true,force:true});}
}
// Integration owner runs this against an existing offline consumer; no install.
export async function qualifyInstalledZigbee(consumerPath) {
const root = resolve(import.meta.dirname, '..'), consumer = realpathSync(consumerPath);
assert.ok(!consumer.startsWith(root + sep));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptPath = join(consumer, 'receipt.json'), dependencyReceiptPath = join(consumer, 'selected-node-connectors/receipt.json');
const receiptBytes = readFileSync(receiptPath), dependencyReceiptBytes = readFileSync(dependencyReceiptPath);
const receipt = JSON.parse(receiptBytes.toString('utf8')), providers = JSON.parse(dependencyReceiptBytes.toString('utf8'));
assert.equal(receipt.status, 'pass'); assert.equal(providers.status, 'pass');
const sdk = installedSdk(consumer, receipt.manifest.path);
assert.equal(sdk.manifestSha256, receipt.manifest.sha256);
const resolver = createRequire(join(consumer, 'package.json'));
assert.equal(JSON.parse(readFileSync(resolver.resolve('mqtt/package.json'), 'utf8')).version, '5.16.0');
function ordinary(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    assert.ok(entry.isFile() || entry.isDirectory(), 'installed dependency must contain ordinary files');
    const path = join(directory, entry.name);
    return entry.isDirectory() ? ordinary(path) : [path];
  });
}
const fingerprints = paths => Object.fromEntries([...new Set(paths)].sort().map(path => [path, fileHash(path)]));
function installedDependencies(selected) {
  const paths = [], directories = new Set();
  for (const dependency of selected.dependencies) {
    const directory = join(consumer, 'node_modules', dependency.path);
    assert.equal(realpathSync(directory), directory);
    assert.equal(fileHash(join(directory, 'package.json')), dependency.packageSha256);
    directories.add(directory); paths.push(...ordinary(directory));
  }
  // Resolve the actual installed MQTT graph through ordinary Node package ancestors.
  // Every executed package must belong to the independently recorded selected graph.
  const visited = new Set();
  function dependencies(directory) {
    if (visited.has(directory)) return; visited.add(directory);
    assert.ok(directories.has(directory), `unrecorded executed dependency ${directory}`);
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      let at = directory;
      for (;;) {
        const candidate = join(at, 'node_modules', dependency, 'package.json');
        let found = false;
        try { found = statSync(candidate).isFile(); } catch { /* Search normal package ancestors. */ }
        if (found) { dependencies(dirname(realpathSync(candidate))); break; }
        const parent = dirname(at); assert.notEqual(parent, at, `installed dependency missing ${dependency}`); at = parent;
      }
    }
  }
  dependencies(dirname(realpathSync(resolver.resolve('mqtt/package.json'))));
  return fingerprints(paths);
}
const sdkFiles = () => fingerprints(sdk.manifest.packages.flatMap(record => ordinary(join(consumer, 'node_modules', record.name))));
function sourceClosure() {
  const hashes = zigbeeSourceFingerprints();
  hashes[realpathSync(join(root, 'tools/build-pointer-bindings.mjs'))] = fileHash(join(root, 'tools/build-pointer-bindings.mjs'));
  const compilerDirectory = dirname(realpathSync(createRequire(import.meta.url).resolve('typescript/package.json')));
  return { ...hashes, ...fingerprints(ordinary(compilerDirectory)), [realpathSync(process.execPath)]: fileHash(realpathSync(process.execPath)) };
}
const dependencyBefore = installedDependencies(providers), sdkBefore = sdkFiles(), sourceBefore = sourceClosure();
const sources = ['packages/hub-server/src/zigbee2mqtt-bridge.ts', 'packages/hub-server/src/zigbee2mqtt-bridge.test.ts',
  'examples/zigbee2mqtt-bridge/producer.mjs', 'examples/zigbee2mqtt-bridge/consumer.mjs',
  'tools/qa-zigbee2mqtt-bridge.mjs', 'tools/qa-installed-zigbee2mqtt-bridge.mjs'];
const sourceBytes = Object.fromEntries(sources.map(path => [path, readFileSync(join(root, path))]));
const sourceSha256 = Object.fromEntries(sources.map(path => [path, digest(sourceBytes[path])]));
for (const path of sources) assert.equal(sourceSha256[path], sourceBefore[join(root, path)]);
const work = mkdtempSync(join(consumer, 'zigbee2mqtt-bridge-'));
const copiedSourcePaths = Object.fromEntries(sources.map((path, index) => {
  const copy = join(work, `source-${index}.bin`); writeFileSync(copy, sourceBytes[path]); return [path, copy];
}));
const compiled = ts.transpileModule(sourceBytes[sources[0]].toString('utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const providerPath = join(work, 'zigbee2mqtt-bridge.mjs'), callerPath = join(work, 'consumer.mjs'), producerPath = join(work, 'producer.mjs');
writeFileSync(providerPath, compiled.outputText);
const caller = sourceBytes['examples/zigbee2mqtt-bridge/consumer.mjs'].toString('utf8'), old = "'../../packages/hub-server/src/zigbee2mqtt-bridge.ts'";
assert.equal(caller.split(old).length, 2); writeFileSync(callerPath, caller.replace(old, "'./zigbee2mqtt-bridge.mjs'"));
writeFileSync(producerPath, sourceBytes['examples/zigbee2mqtt-bridge/producer.mjs']);
assert.ok(!readFileSync(callerPath, 'utf8').includes('../../packages/'));
const resolverPath = join(work, 'resolve.mjs'), runnerPath = join(work, 'run.mjs'), helperPath = join(work,'helper.mjs');
writeFileSync(helperPath,sourceBytes['tools/qa-zigbee2mqtt-bridge.mjs']);
const brokerBinary=zigbeeBrokerBinary();
writeFileSync(resolverPath, "export const entry=import.meta.resolve('@101/connect');export * from '@101/connect';\n");
// The runner exits naturally: execFile resolves after child close, including stdio,
// native producer/broker exits, socket closes and any owned helper timers.
writeFileSync(runnerPath, `import { startOwnedZigbeeBroker } from './helper.mjs';
import { runZigbee2MqttBridgeConsumer } from './consumer.mjs';
import { entry } from './resolve.mjs';
let broker,result,closing,terminated=false;
const closeBroker=()=>closing??=(broker?broker.close():Promise.resolve());
const terminate=()=>{terminated=true;if(broker)void closeBroker().catch(()=>{});};
process.once('SIGTERM',terminate);
try { broker=await startOwnedZigbeeBroker();if(terminated)throw new Error('owned runner interrupted');result=await runZigbee2MqttBridgeConsumer(broker.endpoint); }
finally { await closeBroker();process.off('SIGTERM',terminate); }
console.log(JSON.stringify({publicEntry:entry,broker:{version:broker.version,ownedPid:broker.pid,binaryPath:broker.binaryPath,binarySha256:broker.binarySha256,actualChildClose:true,naturalExitCode:broker.child.exitCode},result}));
`);
const artifactPaths = { ...copiedSourcePaths, providerPath, callerPath, producerPath, resolverPath, runnerPath, helperPath };
const artifactSha256 = Object.fromEntries(Object.entries(artifactPaths).map(([name,path]) => [name,fileHash(path)]));
for (const path of sources) assert.equal(artifactSha256[path], sourceSha256[path]);
const fence=captureZigbeeAcceptance({artifactPaths,receiptPath,dependencyReceiptPath,readClosure:()=>({sdk:sdkFiles(),dependencies:installedDependencies(providers),source:sourceClosure()})});
const { stdout } = await promisify(execFile)(process.execPath, [...process.execArgv, runnerPath], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, env:{...process.env,MOSQUITTO_BIN:brokerBinary.path} });
fence.verify();
const execution = JSON.parse(stdout.trim()); assert.equal(execution.result.status, 'pass');
const publicResolution = fileURLToPath(execution.publicEntry);
assert.ok(publicResolution.startsWith(join(consumer, 'node_modules/@101/connect') + sep));
const finalArtifactSha256 = Object.fromEntries(Object.entries(artifactPaths).map(([name,path]) => [name,fileHash(path)]));
assert.deepEqual(finalArtifactSha256, artifactSha256, 'copied source/provider/caller/producer/helper artifacts changed');
const finalReceiptBytes = readFileSync(receiptPath), finalDependencyReceiptBytes = readFileSync(dependencyReceiptPath);
assert.equal(digest(finalReceiptBytes), digest(receiptBytes), 'SDK receipt bytes changed');
assert.equal(digest(finalDependencyReceiptBytes), digest(dependencyReceiptBytes), 'selected dependency receipt bytes changed');
const finalReceipt = JSON.parse(finalReceiptBytes.toString('utf8')), finalProviders = JSON.parse(finalDependencyReceiptBytes.toString('utf8'));
assert.equal(finalReceipt.status, 'pass'); assert.equal(finalProviders.status, 'pass');
assert.deepEqual(finalReceipt.manifest, receipt.manifest);
const finalSdk = installedSdk(consumer, finalReceipt.manifest.path);
assert.equal(finalSdk.directory, sdk.directory); assert.equal(finalSdk.manifestSha256, sdk.manifestSha256);
assert.equal(finalSdk.manifestSha256, finalReceipt.manifest.sha256);
assert.deepEqual(sdkFiles(), sdkBefore, 'installed SDK closure changed');
assert.deepEqual(installedDependencies(finalProviders), dependencyBefore, 'installed dependency closure changed');
assert.deepEqual(sourceClosure(), sourceBefore, 'executed source/helper/compiler/runtime dependency closure changed');
const proof = { schemaVersion: 1, status: 'pass', sdkManifest: receipt.manifest, finalSdkManifestSha256: finalSdk.manifestSha256,
  receiptSha256: { sdk: digest(receiptBytes), dependencies: digest(dependencyReceiptBytes) }, sourceSha256, sourceClosureSha256: sourceBefore,
  installedSdkSha256: sdkBefore, installedDependencySha256: dependencyBefore, artifactPaths, artifactSha256, finalArtifactSha256,
  publicResolution, runner: { naturallyExited: true, childSocketsTimersSettled: true }, ...execution,
  scope: 'Verified installed public SDK caller with separately compiled selected gateway; no released gateway SDK export, commissioned Zigbee gateway, native capture clock, Matter/Thread, outbound commands or physical effect proof.' };
writeFileSync(join(work, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n');
return { status: 'pass', receipt: join(work, 'receipt.json'), result: execution.result };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){try{assert.equal(process.argv.length,process.argv[2]==='--controlled-copy'?4:3,'Pass existing ordinary SDK consumer directory, or --controlled-copy with its directory');console.log(JSON.stringify(process.argv[2]==='--controlled-copy'?await runZigbeeControlledCopyChecks(process.argv[3]):await qualifyInstalledZigbee(process.argv[2])));}catch(e){console.error(e);process.exitCode=1;}}
