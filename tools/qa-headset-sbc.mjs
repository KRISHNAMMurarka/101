import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const CORE_FILES=Object.freeze(['packages/hub-server/src/headset-sbc.ts','examples/headset-sbc/consumer.mjs','examples/headset-sbc/codec.mjs']);
// Filled only after exact core source acceptance; qualifier itself is pinned by
// the separate root execution release, avoiding a self-hashing approval cycle.
export const APPROVAL_SHA256='98e891eee676f6d2dc1913e987d9308af5371f047663a11e8ce4c5ecc08acf4b';

export async function publicExportEntry(sdkWorkspace){
 const packagePath=await fs.realpath(sdkWorkspace+'/node_modules/@101/connect/package.json');
 const pkg=JSON.parse(await fs.readFile(packagePath));assert.equal(pkg.name,'@101/connect');assert.equal(pkg.version,'0.1.0');
 const entry=typeof pkg.exports==='string'?pkg.exports:pkg.exports?.['.']?.import;
 assert.ok(typeof entry==='string'&&entry.startsWith('./'),'Exact ordinary ESM public package export');
 return fs.realpath(fileURLToPath(new URL(entry,pathToFileURL(packagePath))));
}
export async function loadPublicConsumer(sourceRoot,sdkWorkspace){
 const publicEntry=await publicExportEntry(sdkWorkspace);
 const consumerPath=sourceRoot+'/examples/headset-sbc/consumer.mjs';
 if(publicEntry.includes('/node_modules/@101/')){
  const actualRoot=await fs.realpath(sourceRoot),workspace=await fs.realpath(sdkWorkspace);
  assert.ok(actualRoot.startsWith(workspace+'/'),'Installed copied caller must belong to ordinary SDK consumer');
  return{consumer:await import(pathToFileURL(consumerPath).href),publicEntry,consumerSha256:sha(await fs.readFile(consumerPath)),callerExecution:'ordinary-native-ESM-import'};
 }
 const sdk=await import(pathToFileURL(publicEntry).href);
 const bytes=await fs.readFile(consumerPath),url=pathToFileURL(consumerPath).href;
 const consumerModule=new vm.SourceTextModule(bytes.toString('utf8'),{identifier:url,
  initializeImportMeta(meta){meta.url=url;},
  async importModuleDynamically(specifier){
   assert.equal(specifier,pathToFileURL(sourceRoot+'/packages/hub-server/src/headset-sbc.ts').href,'Only the selected byte-pinned profile dynamic import');
   return import(specifier);
  }});
 await consumerModule.link(async specifier=>{
  let values;if(specifier==='@101/connect')values=sdk;
  else if(specifier.startsWith('node:'))values=await import(specifier);
  else if(specifier==='./codec.mjs')values=await import(pathToFileURL(sourceRoot+'/examples/headset-sbc/codec.mjs').href);
  else throw Error('unapproved-consumer-import');
  const names=Object.keys(values);return new vm.SyntheticModule(names,function(){for(const name of names)this.setExport(name,values[name]);});
 });await consumerModule.evaluate();
 return{consumer:consumerModule.namespace,publicEntry,consumerSha256:sha(bytes),callerExecution:'explicit-source-current-context-VM-public-export-forwarding'};
}

export async function guardApproval({sourceRoot,sdkWorkspace,approvalPath}){
 const approvalBytes=await fs.readFile(approvalPath);assert.equal(sha(approvalBytes),APPROVAL_SHA256,'External approval is not replaceable by local recomputation');
 const approval=JSON.parse(approvalBytes);assert.equal(approval.status,'root-approved-exact-headset-sbc-core');
 assert.deepEqual(approval.corePins.map(row=>row.relative),CORE_FILES);
 for(const row of approval.corePins){const path=sourceRoot+'/'+row.relative,bytes=await fs.readFile(path);assert.ok(bytes.length===row.bytes&&sha(bytes)===row.sha256,'Core source changed before any codec issue: '+row.relative);}
 const actualWorkspace=await fs.realpath(sdkWorkspace),sdk=approval.sdkWorkspaces.find(row=>row.path===actualWorkspace);assert.ok(sdk,'Unapproved SDK workspace');
 for(const row of sdk.pins){const bytes=await fs.readFile(row.path);assert.ok(bytes.length===row.bytes&&sha(bytes)===row.sha256,'Approved SDK bytes changed');}
 const publicEntry=await publicExportEntry(actualWorkspace);
 assert.equal(publicEntry,sdk.publicEntry,'Ordinary public @101/connect package export');
 assert.equal(sha(await fs.readFile(await fs.realpath(process.execPath))),approval.node.sha256);assert.equal(process.version,approval.node.version);
 return{approval,sdk,publicEntry};
}

/** Fixtures have no native processes. They exercise the full real SDK apply return. */
async function observeLoads(approval,sdk,sourceRoot){
 const canonicalRoot=await fs.realpath(sourceRoot);
 const known=new Map([...sdk.pins.map(row=>[row.path,row]),...approval.corePins.map(row=>[canonicalRoot+'/'+row.relative,row])]);
 const loaded=new Map(),resolved=[];let stopped;
 const hook=registerHooks({
  resolve(specifier,context,next){const result=next(specifier,context);if(specifier==='@101/connect'){assert.equal(fileURLToPath(result.url),sdk.publicEntry,'Actual public SDK import resolution');resolved.push({specifier,parentURL:context.parentURL,url:result.url});}return result;},
  load(url,context,next){if(url.startsWith('file:')){const path=fileURLToPath(url),pin=known.get(path);assert.ok(pin,'Unrecorded application/SDK module '+path);const bytes=readFileSync(path);assert.equal(bytes.length,pin.bytes);assert.equal(sha(bytes),pin.sha256,'Exact module input before native load');loaded.set(path,{path,bytes:bytes.length,sha256:sha(bytes)});}else assert.ok(url.startsWith('node:'),'Only native Node builtins and approved files');return next(url,context);}
 });
 return{stop(){if(stopped)return stopped;hook.deregister();stopped={loaded:[...loaded.values()],resolved,loader:'read-only-native-resolver/load-observer; no remapping or transform'};return stopped;}};
}

export async function runConsumerFixtures({sourceRoot,sdkWorkspace,enrollmentPath,receiptDirectory}){
 await fs.mkdir(receiptDirectory,{recursive:false});
 const {consumer,publicEntry,consumerSha256,callerExecution}=await loadPublicConsumer(sourceRoot,sdkWorkspace);
 const {readEnrollment}=await import(pathToFileURL(sourceRoot+'/examples/headset-sbc/codec.mjs').href);
 const enrollment=await readEnrollment(enrollmentPath),receipts=[];
 for(const mode of consumer.QUALIFICATION_MODES.filter(mode=>mode!=='normal')){
  const receiptPath=receiptDirectory+'/'+mode+'.json';
  try{const result=await consumer.runHeadsetSbcConsumer({profileModuleUrl:pathToFileURL(sourceRoot+'/packages/hub-server/src/headset-sbc.ts').href,enrollment,mode,receiptPath});assert.equal(result.status,'pass');assert.equal(result.codecEffect,'explicit-test-owned-port');assert.equal(result.lifecycle.raw.pending,0);assert.equal(result.lifecycle.portPending,0);receipts.push({mode,path:receiptPath,sha256:sha(await fs.readFile(receiptPath)),checks:result.checks});}
  catch(error){await fs.writeFile(receiptDirectory+'/failure.json',JSON.stringify({mode,status:'failed',message:String(error?.message??error),stack:String(error?.stack??error),priorPassed:receipts},null,2)+'\n',{flag:'wx'});throw error;}
 }
 const result={status:'pass-full-consumer-fixtures-only',consumerSha256,publicEntry,callerExecution,receipts,realCodecProcesses:0,physical:false,installedSdk:publicEntry.includes('/node_modules/@101/')};
 await fs.writeFile(receiptDirectory+'/result.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}

export async function qualifyHeadsetSbc({sourceRoot,sdkWorkspace,approvalPath,enrollmentPath,receiptDirectory,group}){
 assert.ok(['fixtures','normal'].includes(group));
 const approved=await guardApproval({sourceRoot,sdkWorkspace,approvalPath});
 const observer=await observeLoads(approved.approval,approved.sdk,sourceRoot);
 try{
 if(group==='fixtures'){const result=await runConsumerFixtures({sourceRoot,sdkWorkspace,enrollmentPath,receiptDirectory});await guardApproval({sourceRoot,sdkWorkspace,approvalPath});const loads=observer.stop();await fs.writeFile(receiptDirectory+'/module-loads.json',JSON.stringify(loads,null,2)+'\n',{flag:'wx'});return{...result,moduleLoads:loads};}
 await fs.mkdir(receiptDirectory,{recursive:false});
 const {consumer,publicEntry,consumerSha256,callerExecution}=await loadPublicConsumer(sourceRoot,sdkWorkspace);
 const {readEnrollment}=await import(pathToFileURL(sourceRoot+'/examples/headset-sbc/codec.mjs').href);
 const enrollment=await readEnrollment(enrollmentPath),receiptPath=receiptDirectory+'/consumer.json';
 const result=await consumer.runHeadsetSbcConsumer({profileModuleUrl:pathToFileURL(sourceRoot+'/packages/hub-server/src/headset-sbc.ts').href,enrollment,mode:'normal',receiptPath});
 assert.equal(result.codecEffect,'actual-pinned-ffmpeg');assert.equal(result.codecReceipts.length,2);
 assert.deepEqual(result.codecReceipts.map(r=>r.action),['encode-selected-sbc','decode-verified-sbc']);
 for(const receipt of result.codecReceipts){assert.equal(receipt.status,'success');assert.equal(receipt.spawned,true);assert.equal(receipt.rawSettled,true);assert.equal(receipt.stdioClosed,true);assert.deepEqual(receipt.exit,{code:0,signal:null});assert.deepEqual(receipt.close,{code:0,signal:null});assert.equal(receipt.loadedOrigins.filter(row=>row.trust==='root-enrolled-ambient-nonOS').length,20);}
 assert.equal(result.producerSha256,result.deliveredSha256);assert.equal(result.decoded.synthetic,false);assert.ok(result.decoded.nonzeroSamples>0);
 await guardApproval({sourceRoot,sdkWorkspace,approvalPath});
 const output={status:'pass-actual-selected-sbc-public-consumer',publicEntry,consumerSha256,sdkKind:approved.sdk.kind,callerExecution,receiptPath,receiptSha256:sha(await fs.readFile(receiptPath)),physical:false,fullW06:false};
 const loads=observer.stop();output.moduleLoads=loads;output.node={version:process.version,execArgv:process.execArgv,platform:process.platform,arch:process.arch,sharedObjects:process.report.getReport().sharedObjects};
 await fs.writeFile(receiptDirectory+'/result.json',JSON.stringify(output,null,2)+'\n',{flag:'wx'});return output;
 }finally{observer.stop();}
}

export async function qualifyCopyNegatives({sourceRoot,sdkWorkspace,approvalPath,enrollmentPath,workRoot}){
 await guardApproval({sourceRoot,sdkWorkspace,approvalPath});await fs.mkdir(workRoot,{mode:0o700,recursive:false});
 const originals=new Map();for(const relative of CORE_FILES)originals.set(relative,await fs.readFile(sourceRoot+'/'+relative));
 const cases=[
  {name:'fabricated-encoder',relative:CORE_FILES[1],from:"mode==='normal'?createFixedSbcPort(enrollment):fixturePort(mode,decoderHold)",to:'fixturePort(mode,decoderHold)'},
  {name:'selected-header-crc-bypass',relative:CORE_FILES[0],from:'if(copy[offset+3]!==crc)',to:'if(false)'},
  {name:'public-resource-read-bypass',relative:CORE_FILES[1],from:'verified=await readVerifiedResource(',to:'verified=produced.encoded.slice();if(false)verified=await readVerifiedResource('},
  {name:'original-private-grant-request-bypass',relative:CORE_FILES[0],from:'grant.request!==req',to:'false'},
  {name:'standing-private-purpose-bypass',relative:CORE_FILES[1],from:'request.purpose!==PURPOSE',to:'false'},
  {name:'runtime-whenSettled-bypass',relative:CORE_FILES[1],from:'const routeClose=connection?.whenSettled()??Promise.resolve()',to:'const routeClose=Promise.resolve()'},
  {name:'consumer-raw-join-bypass',relative:CORE_FILES[1],from:'raw.join()',to:'Promise.resolve()',all:true},
  {name:'arbitrary-protocol-argv',relative:CORE_FILES[2],from:"'-protocol_whitelist','pipe'",to:"'-protocol_whitelist','pipe,file'",all:true},
  ...CORE_FILES.map(relative=>({name:'changed-'+relative.split('/').at(-1),relative,append:'\n// Independently owned changed source\n'}))
 ];
 const results=[];
 for(let index=0;index<cases.length;index++){
  const item=cases[index],root=workRoot+'/case-'+index;await fs.mkdir(root,{mode:0o700});
  for(const [relative,bytes]of originals){const target=root+'/'+relative;await fs.mkdir(new URL('./',pathToFileURL(target)),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});}
  const text=originals.get(item.relative).toString('utf8');if(item.from)assert.ok(text.includes(item.from),'Frozen semantic mutation selector '+item.name);
  const changed=item.append?text+item.append:item.all?text.replaceAll(item.from,item.to):text.replace(item.from,item.to);assert.notEqual(changed,text);
  await fs.writeFile(root+'/'+item.relative,changed);
  const local={status:'root-approved-exact-headset-sbc-core',corePins:await Promise.all(CORE_FILES.map(async relative=>{const bytes=await fs.readFile(root+'/'+relative);return{relative,bytes:bytes.length,sha256:sha(bytes)};}))};
  await fs.writeFile(root+'/locally-recomputed-approval.json',JSON.stringify(local,null,2)+'\n',{flag:'wx'});
  await assert.rejects(guardApproval({sourceRoot:root,sdkWorkspace,approvalPath}),/Core source changed before any codec issue/);
  await assert.rejects(guardApproval({sourceRoot:root,sdkWorkspace,approvalPath:root+'/locally-recomputed-approval.json'}),/External approval is not replaceable/);
  results.push({name:item.name,changedPath:root+'/'+item.relative,originalSha256:sha(originals.get(item.relative)),changedSha256:sha(Buffer.from(changed)),rejectedBeforeCodecIssue:true,locallyRecomputedApprovalDenied:true,evidenceKind:'source-copy-negative; semantic cleanup covered separately by held actual return fixtures'});
 }
 const {readEnrollment}=await import(pathToFileURL(sourceRoot+'/examples/headset-sbc/codec.mjs').href);
 const enrollmentOriginal=await fs.readFile(enrollmentPath),copy=JSON.parse(enrollmentOriginal);copy.enrolledNonOSFiles[0].sha256='a'.repeat(64);
 const changedEnrollment=workRoot+'/changed-ambient-enrollment.json';await fs.writeFile(changedEnrollment,JSON.stringify(copy,null,2)+'\n',{flag:'wx'});
 await assert.rejects(readEnrollment(changedEnrollment),/external-admission-mismatch/);results.push({name:'copied-ambient-enrollment-hash',changedPath:changedEnrollment,originalSha256:sha(enrollmentOriginal),changedSha256:sha(await fs.readFile(changedEnrollment)),rejectedBeforeCodecIssue:true,evidenceKind:'ambient-enrollment-negative'});
 await guardApproval({sourceRoot,sdkWorkspace,approvalPath});
 const output={status:'pass-individual-owned-copy-hash-negatives',cases:results,realCodecProcesses:0,hashChecksAreNotSemanticLifecycleProof:true,physical:false};
 await fs.writeFile(workRoot+'/result.json',JSON.stringify(output,null,2)+'\n',{flag:'wx'});return output;
}

if(process.argv[1]===import.meta.filename){
 const [command,sourceRoot,sdkWorkspace,approvalPath,enrollmentPath,receiptDirectory,group]=process.argv.slice(2);
 assert.equal(command,'--qualify');assert.equal(process.argv.length,9);console.log(JSON.stringify(await qualifyHeadsetSbc({sourceRoot,sdkWorkspace,approvalPath,enrollmentPath,receiptDirectory,group})));
}
