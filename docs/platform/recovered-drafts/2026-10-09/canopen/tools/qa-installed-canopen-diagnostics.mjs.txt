import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { CAN_DIAGNOSTIC_SOURCES, canDiagnosticSourceFingerprints, compileCanDiagnosticPort, fileHash, ordinaryFiles } from './qa-canopen-diagnostics.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprints = paths => Object.fromEntries([...new Set(paths)].sort().map(path => [path,fileHash(path)]));
/** A before/after fence, also exercised by owned-copy negative controls.
 * A fence alone is not an installed SDK caller receipt. */
export function createCanClosureFence({artifacts,sdkReceiptPath,dependencyReceiptPath,sourcePaths,sdkPaths,dependencyPaths}) {
  function artifactHashes() {
    const result={},identities=new Set();
    for(const [name,path] of Object.entries(artifacts)){
      const stat=lstatSync(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'ordinary copied artifact required');
      const identity=stat.dev+':'+stat.ino;assert.ok(!identities.has(identity),'artifact aliases are forbidden');identities.add(identity);
      result[name]=fileHash(path);
    }
    return result;
  }
  const receiptBytes=readFileSync(sdkReceiptPath),dependencyBytes=readFileSync(dependencyReceiptPath);
  assert.equal(JSON.parse(receiptBytes.toString()).status,'pass');assert.equal(JSON.parse(dependencyBytes.toString()).status,'pass');
  const before={artifacts:artifactHashes(),sdkReceipt:digest(receiptBytes),dependencyReceipt:digest(dependencyBytes),
    sources:fingerprints(sourcePaths),sdk:fingerprints(sdkPaths),dependencies:fingerprints(dependencyPaths)};
  return Object.freeze({before,verify(){
    assert.deepEqual(artifactHashes(),before.artifacts,'copied executed artifacts changed');
    const sdkBytes=readFileSync(sdkReceiptPath),depsBytes=readFileSync(dependencyReceiptPath);
    assert.equal(digest(sdkBytes),before.sdkReceipt,'SDK receipt bytes changed');assert.equal(digest(depsBytes),before.dependencyReceipt,'dependency receipt bytes changed');
    assert.equal(JSON.parse(sdkBytes.toString()).status,'pass');assert.equal(JSON.parse(depsBytes.toString()).status,'pass');
    assert.deepEqual(fingerprints(sourcePaths),before.sources,'source/compiler/runtime closure changed');
    assert.deepEqual(fingerprints(sdkPaths),before.sdk,'actual installed SDK closure changed');
    assert.deepEqual(fingerprints(dependencyPaths),before.dependencies,'actual installed dependency closure changed');return before;
  }});
}
function installedDependencies(consumer,providers,sdkNames) {
  assert.ok(Array.isArray(providers.dependencies));const allowed=new Set(),paths=[];
  for(const dependency of providers.dependencies){
    assert.ok(typeof dependency.path==='string'&&!dependency.path.startsWith('/')&&!dependency.path.split('/').some(part=>!part||part==='.'||part==='..'));
    const directory=join(consumer,'node_modules',dependency.path);assert.equal(realpathSync(directory),directory);
    assert.equal(fileHash(join(directory,'package.json')),dependency.packageSha256);allowed.add(directory);paths.push(...ordinaryFiles(directory));
  }
  for(const name of sdkNames)allowed.add(join(consumer,'node_modules',name));
  const visited=new Set();
  function visit(directory){
    assert.ok(allowed.has(directory),`unrecorded executed dependency ${directory}`);if(visited.has(directory))return;visited.add(directory);
    const metadata=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
    for(const dependency of Object.keys(metadata.dependencies??{})){
      let at=directory,target;
      for(;;){const candidate=join(at,'node_modules',dependency,'package.json');if(existsSync(candidate)){target=dirname(realpathSync(candidate));break;}
        const parent=dirname(at);assert.notEqual(parent,at,`missing executed dependency ${dependency}`);at=parent;}
      visit(target);
    }
  }
  visit(join(consumer,'node_modules/@101/connect'));return fingerprints(paths);
}
/** Integration owner invokes only after source review, using an existing offline consumer. No install. */
export async function runInstalledCanDiagnosticQa(consumerInput,{root=resolve(import.meta.dirname,'..'),repoRoot=root}={}) {
  const consumer=realpathSync(consumerInput);assert.ok(!consumer.startsWith(realpathSync(repoRoot)+sep));
  const helperPath=join(repoRoot,'tools/build-pointer-bindings.mjs'),{installedSdk}=await import(pathToFileURL(helperPath));
  const sdkReceiptPath=join(consumer,'receipt.json'),dependencyReceiptPath=join(consumer,'selected-node-connectors/receipt.json');
  const receipt=JSON.parse(readFileSync(sdkReceiptPath,'utf8')),providers=JSON.parse(readFileSync(dependencyReceiptPath,'utf8'));
  assert.equal(receipt.status,'pass');assert.equal(providers.status,'pass');const sdk=installedSdk(consumer,receipt.manifest.path);
  assert.equal(sdk.manifestSha256,receipt.manifest.sha256);
  const sdkPaths=sdk.manifest.packages.flatMap(item=>ordinaryFiles(join(consumer,'node_modules',item.name)));
  const dependencyBefore=installedDependencies(consumer,providers,sdk.manifest.packages.map(item=>item.name));
  const compilerDirectory=dirname(realpathSync(createRequire(import.meta.url).resolve('typescript/package.json')));
  const sourceBefore={...canDiagnosticSourceFingerprints(root,repoRoot),...fingerprints(ordinaryFiles(compilerDirectory)),[helperPath]:fileHash(helperPath)};
  const sources=Object.fromEntries(CAN_DIAGNOSTIC_SOURCES.map(path=>[path,readFileSync(join(root,path))]));
  const sourceSha256=Object.fromEntries(CAN_DIAGNOSTIC_SOURCES.map(path=>[path,digest(sources[path])]));
  for(const path of CAN_DIAGNOSTIC_SOURCES)assert.equal(sourceSha256[path],sourceBefore[join(root,path)]);
  const work=mkdtempSync(join(consumer,'canopen-diagnostics-')),artifacts={};
  for(let at=0;at<CAN_DIAGNOSTIC_SOURCES.length;at++){const name=CAN_DIAGNOSTIC_SOURCES[at],path=join(work,'source-'+at+'.bin');writeFileSync(path,sources[name]);artifacts[name]=path;}
  const cPath=join(work,'native-port.c');writeFileSync(cPath,sources['examples/canopen-diagnostics/native-port.c']);artifacts.nativeSource=cPath;
  const compiled=await compileCanDiagnosticPort(cPath,work);artifacts.nativeExecutable=compiled.binary;
  const providerPath=join(work,'canopen-diagnostic-gateway.mjs');
  writeFileSync(providerPath,ts.transpileModule(sources[CAN_DIAGNOSTIC_SOURCES[0]].toString(),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);artifacts.provider=providerPath;
  const old="'../../packages/hub-server/src/canopen-diagnostic-gateway.ts'",caller=sources['examples/canopen-diagnostics/consumer.mjs'].toString();assert.equal(caller.split(old).length,2);
  const callerPath=join(work,'consumer.mjs');writeFileSync(callerPath,caller.replace(old,"'./canopen-diagnostic-gateway.mjs'"));artifacts.caller=callerPath;
  assert.ok(!readFileSync(callerPath,'utf8').includes('../../packages/'));
  const resolverPath=join(work,'resolve.mjs'),runnerPath=join(work,'run.mjs');
  writeFileSync(resolverPath,"export const entry=import.meta.resolve('@101/connect');export * from '@101/connect';\n");artifacts.resolver=resolverPath;
  writeFileSync(runnerPath,`import {runCanDiagnosticExample} from './consumer.mjs';import {entry} from './resolve.mjs';
const result=await runCanDiagnosticExample({nativeExecutable:${JSON.stringify(compiled.binary)},sourceSha256:${JSON.stringify(compiled.sourceSha256)},mode:'scripted-process-harness'});
console.log(JSON.stringify({entry,result}));\n`);artifacts.runner=runnerPath;
  const sourcePaths=[...Object.keys(sourceBefore),...Object.keys(compiled.closureSha256)];
  const fence=createCanClosureFence({artifacts,sdkReceiptPath,dependencyReceiptPath,sourcePaths,sdkPaths,dependencyPaths:Object.keys(dependencyBefore)});
  const {stdout}=await promisify(execFile)(process.execPath,[...process.execArgv,runnerPath],{timeout:15000,maxBuffer:2*1024*1024});
  const executed=JSON.parse(stdout.trim());assert.equal(executed.result.status,'pass');assert.equal(executed.result.statusAfterClose.childExitCode,0);
  assert.equal(executed.result.statusAfterClose.childExitSignal,null);assert.equal(executed.result.statusAfterClose.childClosed,true);
  assert.ok(fileURLToPath(executed.entry).startsWith(join(consumer,'node_modules/@101/connect')+sep),'actual installed ESM entry required');
  fence.verify();
  const finalReceipt=JSON.parse(readFileSync(sdkReceiptPath,'utf8')),finalProviders=JSON.parse(readFileSync(dependencyReceiptPath,'utf8'));
  assert.equal(installedSdk(consumer,finalReceipt.manifest.path).manifestSha256,sdk.manifestSha256);
  assert.deepEqual(installedDependencies(consumer,finalProviders,sdk.manifest.packages.map(item=>item.name)),dependencyBefore);
  assert.deepEqual({...canDiagnosticSourceFingerprints(root,repoRoot),...fingerprints(ordinaryFiles(compilerDirectory)),[helperPath]:fileHash(helperPath)},sourceBefore);
  const result={schemaVersion:1,status:'pass',kind:'actual-installed-SDK-scripted-process-proof',sdkManifest:receipt.manifest,sourceSha256,
    closure:fence.before,compiled,execution:executed,nativeEnvironment:{status:'blocked',nativeApproved:false},physical:false,supportRows:[],
    scope:'Actual copied provider/C/caller and normal installed SDK ESM graph; scripted software only, no native CAN/vcan/clock/physical/CANopen-stack conformity or full A11.'};
  writeFileSync(join(work,'receipt.json'),JSON.stringify(result,null,2)+'\n');return{...result,receiptPath:join(work,'receipt.json')};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
  try{assert.ok(process.argv[2],'Pass existing offline SDK consumer');console.log(JSON.stringify(await runInstalledCanDiagnosticQa(process.argv[2])));}
  catch(error){console.error(error);process.exitCode=1;}
}
