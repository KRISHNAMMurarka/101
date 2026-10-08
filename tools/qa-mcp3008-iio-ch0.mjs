import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const MCP3008_IIO_SOURCES=Object.freeze(['packages/hub-server/src/mcp3008-iio-ch0.ts','packages/hub-server/src/mcp3008-iio-ch0.test.ts',
 'examples/mcp3008-iio-ch0/producer.mjs','examples/mcp3008-iio-ch0/consumer.mjs','tools/qa-mcp3008-iio-ch0.mjs','tools/qa-installed-mcp3008-iio-ch0.mjs']);
export const fileHash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function ordinaryFiles(root){assert.ok(lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink());return readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{
 const path=join(root,e.name);assert.ok(e.isFile()||e.isDirectory(),`Nonordinary closure file ${path}`);return e.isDirectory()?ordinaryFiles(path):[path];});}
export const fingerprints=paths=>Object.fromEntries([...new Set(paths)].sort().map(p=>[p,fileHash(p)]));
export function sourceClosure(root,repoRoot){root=realpathSync(root);repoRoot=realpathSync(repoRoot);const paths=MCP3008_IIO_SOURCES.map(p=>join(root,p));
 const sdkNames=['connect','device-model','device-runtime','device-web','transport-webrtc','transport-websocket','vision'],visited=new Set();
 function visit(directory){directory=realpathSync(directory);if(visited.has(directory))return;visited.add(directory);
 const metadata=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));paths.push(join(directory,'package.json'));
 if(directory.startsWith(join(repoRoot,'packages')+sep))paths.push(...ordinaryFiles(join(directory,'src')));else paths.push(...ordinaryFiles(directory));
 for(const dependency of Object.keys(metadata.dependencies??{})){
 let at=directory,target;for(;;){const p=join(at,'node_modules',dependency,'package.json');if(existsSync(p)){target=dirname(realpathSync(p));break;}const next=dirname(at);assert.notEqual(at,next);at=next;}visit(target); }}
 for(const name of sdkNames)visit(join(repoRoot,'packages',name));
 const require=createRequire(join(repoRoot,'package.json')),compiler=dirname(realpathSync(require.resolve('typescript/package.json')));
 paths.push(...ordinaryFiles(compiler),realpathSync(process.execPath));return fingerprints(paths);
}
/** This fence records bytes, not hardware trust or a successful caller. */
export function createMcp3008ClosureFence({artifacts,sdkReceiptPath,dependencyReceiptPath,sourcePaths=[],sdkPaths=[],dependencyPaths=[]}){
 function artifactHashes(){const ids=new Set(),result={};for(const [name,path]of Object.entries(artifacts)){
 const s=lstatSync(path,{bigint:true});assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(realpathSync(path),path);
 const id=s.dev+':'+s.ino;assert.ok(!ids.has(id),'Artifact aliases refused');ids.add(id);result[name]=fileHash(path);}return result;}
 function receiptHash(path){if(!path)return null;const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink());const bytes=readFileSync(path);assert.ok(bytes.length<2*1024*1024);assert.equal(JSON.parse(bytes.toString()).status,'pass');return createHash('sha256').update(bytes).digest('hex');}
 const before={artifacts:artifactHashes(),sdkReceipt:receiptHash(sdkReceiptPath),dependencyReceipt:receiptHash(dependencyReceiptPath),sources:fingerprints(sourcePaths),sdk:fingerprints(sdkPaths),dependencies:fingerprints(dependencyPaths)};
 return Object.freeze({before,verify(){assert.deepEqual(artifactHashes(),before.artifacts,'Executed artifact changed');assert.equal(receiptHash(sdkReceiptPath),before.sdkReceipt,'SDK receipt changed');
 assert.equal(receiptHash(dependencyReceiptPath),before.dependencyReceipt,'Dependency receipt changed');assert.deepEqual(fingerprints(sourcePaths),before.sources,'Source/compiler/runtime changed');
 assert.deepEqual(fingerprints(sdkPaths),before.sdk,'SDK changed');assert.deepEqual(fingerprints(dependencyPaths),before.dependencies,'Dependency changed');return before;}});
}
export function prepareMcp3008Artifacts({root,repoRoot,work}){
 root=realpathSync(root);work=realpathSync(work);const artifacts={};
 for(let i=0;i<MCP3008_IIO_SOURCES.length;i++){const target=join(work,'source-'+i+'.bin');copyFileSync(join(root,MCP3008_IIO_SOURCES[i]),target);artifacts[MCP3008_IIO_SOURCES[i]]=target;}
 const ts=createRequire(join(realpathSync(repoRoot),'package.json'))('typescript');assert.equal(ts.version,'5.9.3');
 const provider=join(work,'mcp3008-iio-ch0.mjs');writeFileSync(provider,ts.transpileModule(readFileSync(join(root,MCP3008_IIO_SOURCES[0]),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);artifacts.provider=provider;
 const caller=readFileSync(join(root,MCP3008_IIO_SOURCES[3]),'utf8'),needle="'../../packages/hub-server/src/mcp3008-iio-ch0.ts'";assert.equal(caller.split(needle).length,2);
 const callerPath=join(work,'consumer.mjs');writeFileSync(callerPath,caller.replace(needle,"'./mcp3008-iio-ch0.mjs'"));artifacts.caller=callerPath;
 for(const [kind,source,name]of [['producer',MCP3008_IIO_SOURCES[2],'producer.mjs'],['helper',MCP3008_IIO_SOURCES[4],'helper.mjs']]){const target=join(work,name);copyFileSync(join(root,source),target);artifacts[kind]=target;}
 const resolver=join(work,'resolve.mjs');writeFileSync(resolver,"export const entry=import.meta.resolve('@101/connect');export * from '@101/connect';\n");artifacts.resolver=resolver;
 const runner=join(work,'run.mjs');writeFileSync(runner,`import {runMcp3008IioExample} from './consumer.mjs';import {entry} from './resolve.mjs';import {createMcp3008ClosureFence} from './helper.mjs';
const artifacts=${JSON.stringify(artifacts)};const local=createMcp3008ClosureFence({artifacts});const result=await runMcp3008IioExample({workRoot:${JSON.stringify(work)},scenario:process.argv[2]??'normal'});local.verify();console.log(JSON.stringify({entry,result}));\n`);artifacts.runner=runner;
 return artifacts;
}
export async function runMcp3008OwnedCaller(runner,scenario='normal'){
 assert.ok(lstatSync(runner).isFile()&&!lstatSync(runner).isSymbolicLink());const child=spawn(process.execPath,[runner,scenario],{env:{NODE_ENV:'production'},stdio:['pipe','pipe','pipe']});
 const close=new Promise(done=>child.once('close',(code,signal)=>done({code,signal})));let exitResolve;const exit=new Promise(done=>{exitResolve=done;});child.once('exit',(code,signal)=>exitResolve({code,signal}));
 let fault,expired=false,stdout=Buffer.alloc(0),stderr=Buffer.alloc(0);const fail=e=>{fault??=e;child.kill('SIGKILL');};child.on('error',e=>{exitResolve({spawnError:true});fail(e);});
 for(const stream of [child.stdin,child.stdout,child.stderr])stream.on('error',fail);
 child.stdout.on('data',b=>{if(stdout.length+b.length>1024*1024)fail(Error('Caller stdout limit'));else stdout=Buffer.concat([stdout,b]);});
 child.stderr.on('data',b=>{if(stderr.length+b.length>4096)fail(Error('Caller stderr limit'));else stderr=Buffer.concat([stderr,b]);});
 const rawEnd=new Promise((done,reject)=>{try{child.stdin.end(e=>e?reject(e):done());}catch(e){reject(e);}});rawEnd.catch(fail);
 const deadline=performance.now()+12000,timer=setTimeout(()=>{expired=true;fail(Error('Original caller observation deadline'));},12000);
 const [closed,natural,legs]=await Promise.all([close,exit,Promise.allSettled([rawEnd])]);clearTimeout(timer);
 if(fault)throw fault;assert.equal(expired,false);assert.ok(performance.now()<deadline);assert.deepEqual(closed,natural);assert.equal(natural.code,0,stderr.toString());assert.equal(natural.signal,null);
 assert.ok(legs.every(r=>r.status==='fulfilled'));const execution=JSON.parse(stdout.toString().trim());assert.equal(execution.result.status,'pass');assert.equal(execution.result.producerClosed,true);
 assert.equal(execution.result.producerExit.code,0);assert.equal(execution.result.producerExit.signal,null);return{...execution,callerClose:closed,callerNaturalExit:natural,issuedPipeWrites:legs.length};
}
export async function runMcp3008IioQa({root=resolve(import.meta.dirname,'..'),repoRoot=root,workRoot=join(root,'evidence'),scenarios=['normal','malformed','missing','replacement','route-expiry','route-revoke','owner-revoke','caller-revoke','grant-revoke','gateway-expiry','callback-stop']}={}){
 mkdirSync(workRoot,{recursive:true});workRoot=realpathSync(workRoot);const before=sourceClosure(root,repoRoot),work=realpathSync(mkdtempSync(join(workRoot,'mcp3008-source-'))),artifacts=prepareMcp3008Artifacts({root,repoRoot,work});
 const fence=createMcp3008ClosureFence({artifacts,sourcePaths:Object.keys(before)}),results=[];for(const scenario of scenarios)results.push(await runMcp3008OwnedCaller(artifacts.runner,scenario));
 fence.verify();assert.deepEqual(sourceClosure(root,repoRoot),before);assert.ok(fileURLToPath(results[0].entry).startsWith(join(realpathSync(repoRoot),'packages','connect')+sep),'Actual source SDK entry required');
 const receipt={schemaVersion:1,status:'pass',kind:'actual-copied-source-public-SDK-software-ABI',physical:false,supportRows:[],sourceSha256:before,closure:fence.before,artifacts,results,
 nativeEnvironment:{status:'blocked',reason:'native-admission-not-qualified',nativeApproved:false},scope:'Reported ordinary-file ABI and actual public SDK only; no native sysfs/I2C, calibration, conversion capture, physical support or full A16 proof.'};
 const receiptPath=join(work,'receipt.json');writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');return{...receipt,receiptPath};
}
/** Called only after the actual copied caller closed. Mutations touch individually owned copies and are retained. */
export function runMcp3008CopyMutationChecks(receipt,{workRoot,authoritativePaths=[],sdkReceiptPath,dependencyReceiptPath,sdkPaths=[],dependencyPaths=[]}={}){
 assert.equal(receipt.status,'pass');assert.ok(receipt.results.every(r=>r.callerClose.code===0&&r.result.producerClosed));workRoot=realpathSync(workRoot);
 const authoritativeBefore=fingerprints(authoritativePaths),work=realpathSync(mkdtempSync(join(workRoot,'mcp3008-mutations-'))),artifacts={};
 const marker=join(work,'owned.json');writeFileSync(marker,JSON.stringify({schemaVersion:1,owner:'mcp3008-owned-copies',sourceReceipt:receipt.receiptPath}));
 function copy(path,name){const target=join(work,name);copyFileSync(path,target);assert.equal(realpathSync(target),target);assert.ok(target.startsWith(work+sep));return target;}
 for(const [name,path]of Object.entries(receipt.artifacts))artifacts[name]=copy(path,'artifact-'+Object.keys(artifacts).length+'.bin');
 const ownedSdk=sdkPaths.map((p,i)=>copy(p,'sdk-'+i+'.bin')),ownedDeps=dependencyPaths.map((p,i)=>copy(p,'dep-'+i+'.bin'));
 const sdkReceipt=sdkReceiptPath?copy(sdkReceiptPath,'sdk-receipt.json'):undefined,dependencyReceipt=dependencyReceiptPath?copy(dependencyReceiptPath,'dependency-receipt.json'):undefined;
 const fence=createMcp3008ClosureFence({artifacts,sdkReceiptPath:sdkReceipt,dependencyReceiptPath:dependencyReceipt,sdkPaths:ownedSdk,dependencyPaths:ownedDeps}),controls=[];
 for(const [name,path]of [...Object.entries(artifacts),...ownedSdk.slice(0,1).map(p=>['SDK',p]),...ownedDeps.slice(0,1).map(p=>['dependency',p]),...(sdkReceipt?[['sdkReceipt',sdkReceipt]]:[]),...(dependencyReceipt?[['dependencyReceipt',dependencyReceipt]]:[])]){
 const original=readFileSync(path),changed=Buffer.concat([original,Buffer.from('\nMCP3008-OWNED-MUTATION\n')]);writeFileSync(path,changed);copy(path,'changed-'+controls.length+'.bin');
 let rejected=false;try{fence.verify();}catch{rejected=true;}finally{writeFileSync(path,original);}assert.equal(rejected,true,`Mutation ${name} was not rejected`);fence.verify();
 controls.push({name,path,originalSha256:createHash('sha256').update(original).digest('hex'),changedSha256:createHash('sha256').update(changed).digest('hex'),rejected,restored:true,kind:'expected-negative'});}
 assert.deepEqual(fingerprints(authoritativePaths),authoritativeBefore);const result={schemaVersion:1,status:'pass',kind:'owned-copy-mutation-controls-after-actual-source-caller',work,marker,controls,authoritativeBefore,authoritativeUnchanged:true};
 const receiptPath=join(work,'receipt.json');writeFileSync(receiptPath,JSON.stringify(result,null,2)+'\n');return{...result,receiptPath};
}
if(process.argv[1]&&existsSync(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){try{const repoRoot=process.argv[2]?realpathSync(process.argv[2]):resolve(import.meta.dirname,'..');console.log(JSON.stringify(await runMcp3008IioQa({repoRoot})));}catch(error){console.error(error);process.exitCode=1;}}
