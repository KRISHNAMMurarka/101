import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createTmp102HwmonConnector, decodeTmp102Temperature, parseTmp102HwmonProfile, TMP102_HWMON_VALUE_SCHEMA } from './tmp102-hwmon.ts';
import type { Tmp102HwmonProfile, Tmp102TemperatureReading, Tmp102HwmonOptions } from './tmp102-hwmon.ts';

function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:unknown)=>void;
  const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
async function until(predicate:()=>boolean, ms=2000) { const deadline=performance.now()+ms;
  while(!predicate()) { assert.ok(performance.now()<deadline,'condition deadline'); await new Promise(r=>setTimeout(r,2)); } }
async function fixture(text='25000\n') {
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-tmp102-test-'))), parent=join(root,'parent'),hwmon=join(parent,'hwmon');
  await fs.mkdir(hwmon,{recursive:true}); await fs.writeFile(join(hwmon,'name'),'tmp102\n'); await fs.writeFile(join(hwmon,'temp1_input'),text);
  const identity=async(path:string)=>{const s=await fs.lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};};
  const profile:Tmp102HwmonProfile={profileId:'tmp102-hwmon-abi-file/1',revision:1,parentRealPath:parent,hwmonRealPath:hwmon,i2cAddress:0x48,
    driverBuildSha256:'0'.repeat(64),environmentReceiptSha256:'1'.repeat(64),ancestorPolicy:'host-controlled-stable',
    enrolledIdentities:{parent:await identity(parent),hwmon:await identity(hwmon),name:await identity(join(hwmon,'name')),temperature:await identity(join(hwmon,'temp1_input'))}};
  const owner=new AbortController(),caller=new AbortController(),grant=new AbortController(),readings:Tmp102TemperatureReading[]=[],unavailable:string[]=[];
  const options:Tmp102HwmonOptions={profile,scope:{principalId:'owner',applicationId:'tests',sessionId:'one'},ownerSignal:owner.signal,
    authorize:request=>({request,signal:grant.signal,expiresAt:request.deadline}),onTemperature:r=>readings.push(r),onUnavailable:r=>unavailable.push(r)};
  return {root,profile,owner,caller,grant,readings,unavailable,options,request:()=>({purpose:'selected-read',signal:caller.signal,deadline:performance.now()+4000}),
    async cleanup(){mock.restoreAll();await fs.rm(root,{recursive:true,force:true});}};
}
for(const [raw,decimal,value] of [['-62\n','-0.062',-.062],['-125\n','-0.125',-.125],['0\n','0',0],['125\n','0.125',.125],['25000\n','25',25],['-55000\n','-55',-55],['150000\n','150',150]] as const)
  test(`decoder preserves integer rational ${JSON.stringify(raw)}`,()=>{
    const bytes=Buffer.from(raw),d=decodeTmp102Temperature(bytes);assert.equal(d.exactDecimalCelsius,decimal);assert.equal(d.reportedCelsius,value);
    assert.deepEqual(d.rationalCelsius,{numerator:Number(raw.trim()),denominator:1000});assert.equal(d.rawBytes,bytes.length);
    assert.match(d.rawSha256,/^[0-9a-f]{64}$/);assert.ok(Object.isFrozen(d));assert.ok(Object.isFrozen(d.rationalCelsius));bytes.fill(0);assert.equal(d.exactDecimalCelsius,decimal);
  });
for(const raw of ['', '0', '0.0\n','+1\n','01\n','-0\n','1e3\n','1\r\n','1\n0','1\0\n','-55001\n','150001\n','1'.repeat(65)+'\n','\u0080\n','--1\n',' 1\n'])
  test(`decoder refuses ${JSON.stringify(raw)}`,()=>assert.throws(()=>decodeTmp102Temperature(Buffer.from(raw))));
test('decoder refuses proxy and lookalike before traps',()=>{
  let calls=0;const p=new Proxy(new Uint8Array([48,10]),{get(){calls++;throw Error('trap');}});
  assert.throws(()=>decodeTmp102Temperature(p));assert.equal(calls,0);assert.throws(()=>decodeTmp102Temperature({length:2} as Uint8Array));
  assert.deepEqual(TMP102_HWMON_VALUE_SCHEMA,{type:'scalar',unit:'Cel',min:-55,max:150});
});
test('profile freezes all four identities and rejects paths/accessors/proxies/policies',async()=>{
  const f=await fixture();try{const p=parseTmp102HwmonProfile(f.profile);assert.ok(Object.isFrozen(p.enrolledIdentities.temperature));
    for(const change of [{parentRealPath:'/a/../b'},{hwmonRealPath:f.profile.parentRealPath+'extra/x'},{ancestorPolicy:'hostile'},
      {i2cAddress:0x47},{revision:2},{profileId:'linux-tmp102-hwmon-read/1'}])assert.throws(()=>parseTmp102HwmonProfile({...f.profile,...change}));
    let calls=0;assert.throws(()=>parseTmp102HwmonProfile({...f.profile,get revision(){calls++;return 1;}}));assert.equal(calls,0);
    assert.throws(()=>parseTmp102HwmonProfile(new Proxy(f.profile,{ownKeys(){calls++;throw Error();}})));assert.equal(calls,0);
  }finally{await f.cleanup();}
});
test('standing denial and native refusal issue zero filesystem effects',async()=>{
 const f=await fixture();try{let effects=0;for(const method of ['realpath','lstat','stat','open'] as const)mock.method(fs,method,()=>{effects++;throw Error('forbidden');});
  const c=createTmp102HwmonConnector({...f.options,authorize:()=>undefined});assert.equal((await c.start(f.request())).ok,false);await c.close();
  let authorizations=0;const n=createTmp102HwmonConnector({...f.options,profile:{...f.profile,profileId:'linux-tmp102-hwmon-temperature-read/1'},authorize:r=>{authorizations++;return {request:r,signal:f.grant.signal,expiresAt:r.deadline};}});
  assert.deepEqual(await n.start(f.request()),{ok:false,reason:'native-admission-not-qualified'});await n.close();assert.equal(authorizations,0);assert.equal(effects,0);
 }finally{await f.cleanup();}
});
test('exact request and genuine owner/caller/grant signals and original bounds fence all effects',async()=>{
 const f=await fixture();try{
  assert.throws(()=>createTmp102HwmonConnector({...f.options,ownerSignal:new Proxy(f.owner.signal,{})}));
  assert.throws(()=>createTmp102HwmonConnector({...f.options,ownerSignal:Object.create(f.owner.signal)}));
  class Derived extends AbortSignal {} assert.throws(()=>createTmp102HwmonConnector({...f.options,ownerSignal:Object.create(Derived.prototype)}));
  const c=createTmp102HwmonConnector(f.options);assert.equal((await c.start({...f.request(),signal:new Proxy(f.caller.signal,{})})).ok,false);
  assert.equal((await c.start({...f.request(),deadline:performance.now()-1})).ok,false);assert.equal((await c.start({...f.request(),deadline:performance.now()+30001})).ok,false);await c.close();
  for(const authorize of [()=>({request:{} as never,signal:f.grant.signal,expiresAt:performance.now()+1000}),
    (request:Parameters<Tmp102HwmonOptions['authorize']>[0])=>({request,signal:new Proxy(f.grant.signal,{}),expiresAt:request.deadline})]){
    const bad=createTmp102HwmonConnector({...f.options,authorize});assert.equal((await bad.start(f.request())).ok,false);await bad.close();
  }
 }finally{await f.cleanup();}
});
test('real file signed reports preserve receipt/unknowns and owner sequence across explicit restart',async()=>{
 const f=await fixture('-62\n');const c=createTmp102HwmonConnector(f.options);try{
  assert.ok((await c.start(f.request())).ok);assert.equal(f.readings[0]?.decoded.reportedCelsius,-.062);
  const first=f.readings[0]!;assert.equal(first.provenance.readReceivedAt,first.receivedAt);assert.equal(first.provenance.calibrationRevision,null);
  assert.equal(first.provenance.absoluteErrorBound,null);assert.equal(first.provenance.captureUnknown,true);assert.equal(first.provenance.physical,false);
  await c.stop();assert.equal(c.status().openHandles,0);assert.ok((await c.start(f.request())).ok);assert.equal(f.readings[1]?.localSequence,first.localSequence+1);
  await c.close();assert.equal(c.status().phase,'closed');assert.equal(c.status().pendingOperations,0);assert.equal(c.status().timers,0);
 }finally{await c.close();await f.cleanup();}
});
test('identical polling reports remain separate observations with advancing receipts',async()=>{
 const f=await fixture();const c=createTmp102HwmonConnector(f.options);try{assert.ok((await c.start(f.request())).ok);await until(()=>f.readings.length===2,1800);
 assert.ok(f.readings[1]!.receivedAt>f.readings[0]!.receivedAt);assert.equal(f.readings[1]!.decoded.reportedCelsius,25);assert.equal(f.readings[1]!.localSequence,2);
 }finally{await c.close();await f.cleanup();}
});
test('slow metadata cannot compress the original interval between actual temperature reads',async t=>{
 const f=await fixture(),originalOpen=fs.open.bind(fs),issuedAt:number[]=[];
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const h=await originalOpen(...args);
  if(args[0]===join(f.profile.hwmonRealPath,'temp1_input')){
   const stat=h.stat.bind(h),read=h.read.bind(h);let stats=0;
   mock.method(h,'stat',async(...a:Parameters<typeof h.stat>)=>{const result=await stat(...a);
    if(++stats===2)await new Promise(r=>setTimeout(r,200));return result;});
   mock.method(h,'read',(...a:Parameters<typeof h.read>)=>{issuedAt.push(performance.now());return read(...a);});
  }
  return h;
 });
 const c=createTmp102HwmonConnector(f.options);
 try{assert.ok((await c.start(f.request())).ok);await until(()=>f.readings.length===2,1800);
  assert.equal(issuedAt.length,2);const interval=issuedAt[1]!-issuedAt[0]!;t.diagnostic(JSON.stringify({nativeReadIntervalMs:interval}));
  assert.ok(interval>=995,'The fixed 1000ms cadence applies to actual data-read issues after metadata');
  assert.deepEqual(f.readings.map(r=>[r.decoded.reportedCelsius,r.localSequence]),[[25,1],[25,2]]);
 }finally{await c.close();await f.cleanup();}
});
test('explicit restart retains the original interval between actual temperature reads',async()=>{
 const f=await fixture(),originalOpen=fs.open.bind(fs),issuedAt:number[]=[];
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await originalOpen(...args);
  if(args[0]===join(f.profile.hwmonRealPath,'temp1_input')){const read=h.read.bind(h);
   mock.method(h,'read',(...a:Parameters<typeof h.read>)=>{issuedAt.push(performance.now());return read(...a);});}return h;});
 const c=createTmp102HwmonConnector(f.options);
 try{assert.ok((await c.start(f.request())).ok);await c.stop();assert.ok((await c.start(f.request())).ok);
  assert.equal(issuedAt.length,2);assert.ok(issuedAt[1]!-issuedAt[0]!>=995,'Restart cannot reset the fixed data-read cadence');
  assert.deepEqual(f.readings.map(r=>r.localSequence),[1,2]);
 }finally{await c.close();await f.cleanup();}
});
test('caller cancellation during a restart cadence wait joins ownership without a late data read',async()=>{
 const f=await fixture(),originalOpen=fs.open.bind(fs),issuedAt:number[]=[];
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await originalOpen(...args);
  if(args[0]===join(f.profile.hwmonRealPath,'temp1_input')){const read=h.read.bind(h);
   mock.method(h,'read',(...a:Parameters<typeof h.read>)=>{issuedAt.push(performance.now());return read(...a);});}return h;});
 const c=createTmp102HwmonConnector(f.options);let restarted:ReturnType<typeof c.start>|undefined;
 try{assert.ok((await c.start(f.request())).ok);await c.stop();restarted=c.start(f.request());
  await until(()=>c.status().phase==='ready'&&c.status().pendingOperations===0&&c.status().openHandles===1);
  assert.equal(issuedAt.length,1,'The restart remains paced before any second data-read intention');
  f.caller.abort();assert.equal((await restarted).ok,false);await c.stop();
  assert.equal(c.status().timers,0);assert.equal(c.status().openHandles,0);assert.equal(c.status().pendingOperations,0);
  await new Promise(r=>setTimeout(r,1100));assert.equal(issuedAt.length,1);assert.equal(f.readings.length,1);
 }finally{f.caller.abort();await c.close();await restarted;await f.cleanup();}
});
test('fixed file replacement invalidates retained enrollment across starts',async()=>{
 const f=await fixture();const c=createTmp102HwmonConnector(f.options);try{assert.ok((await c.start(f.request())).ok);await c.stop();
 await fs.rename(join(f.profile.hwmonRealPath,'temp1_input'),join(f.profile.hwmonRealPath,'old'));await fs.writeFile(join(f.profile.hwmonRealPath,'temp1_input'),'0\n');
 assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,1);await c.stop();assert.equal(c.status().openHandles,0);
 }finally{await c.close();await f.cleanup();}
});
test('persistent ancestor movement and symlink fixed file retire',async()=>{
 const f=await fixture();const c=createTmp102HwmonConnector(f.options);try{await fs.rename(f.profile.parentRealPath,f.profile.parentRealPath+'-old');
 await fs.symlink(f.profile.parentRealPath+'-old',f.profile.parentRealPath);assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,0);
 }finally{await c.close();await f.cleanup();}
});
test('directory instead of fixed regular file is refused before reading',async()=>{
 const f=await fixture();await fs.unlink(join(f.profile.hwmonRealPath,'temp1_input'));await fs.mkdir(join(f.profile.hwmonRealPath,'temp1_input'));
 const c=createTmp102HwmonConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,0);}finally{await c.close();await f.cleanup();}
});
test('high-bit name bytes cannot alias the exact tmp102 ASCII name',async()=>{
 const f=await fixture();await fs.writeFile(join(f.profile.hwmonRealPath,'name'),Buffer.from([0xf4,0xed,0xf0,0xb1,0xb0,0xb2,0x8a]));
 const c=createTmp102HwmonConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,0);}
 finally{await c.close();await f.cleanup();}
});
test('producer enrollment failure joins the actual failed child before returning',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-tmp102-start-fail-'))),original=fs.realpath.bind(fs);
 mock.method(fs,'realpath',async(...args:Parameters<typeof fs.realpath>)=>{const value=await original(...args);if(args[0]===root)await fs.rm(root,{recursive:true,force:true});return value;});
 try{const {runTmp102HwmonExample}=await import(new URL('../../../examples/tmp102-hwmon/consumer.mjs',import.meta.url).href);
  await assert.rejects(runTmp102HwmonExample({workRoot:root}),error=>{
   assert.match((error as Error).message,/Producer exited before enrollment/);
   const result=error as Error&{producerExit?:{code:number|null;signal:string|null};producerClose?:{code:number|null;signal:string|null}};
   assert.deepEqual(result.producerExit,result.producerClose);assert.notEqual(result.producerExit?.code,0);return true;
  });
 }finally{mock.restoreAll();await fs.rm(root,{recursive:true,force:true});}
});
test('a held real producer finish callback expires but remains owned until settlement',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-tmp102-held-finish-')));
 const {ownedProducer}=await import(new URL('../../../examples/tmp102-hwmon/consumer.mjs',import.meta.url).href);
 const owned=await ownedProducer(root);let release:(()=>void)|undefined;
 try{await owned.enrollment;const send=owned.child.send.bind(owned.child);
  mock.method(owned.child,'send',(message:unknown,callback:(error?:Error|null)=>void)=>{
   if((message as {kind?:string}).kind==='finish')return send(message,(error?:Error|null)=>{release=()=>callback(error);});
   return send(message,callback);
  });
  const finished=owned.finish();await until(()=>!!release,1000);await new Promise(r=>setTimeout(r,3150));release?.();
  await assert.rejects(finished,/Producer close deadline|Producer finish deadline/);
  const joined=await owned.abort();assert.deepEqual(joined.closure,joined.natural);
 }finally{release?.();mock.restoreAll();await owned.abort();await fs.rm(root,{recursive:true,force:true});}
});
test('a held cleanup callback retains its original timeout after actual settlement',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-tmp102-held-abort-')));
 const {ownedProducer}=await import(new URL('../../../examples/tmp102-hwmon/consumer.mjs',import.meta.url).href);
 const owned=await ownedProducer(root);let release:(()=>void)|undefined;
 try{await owned.enrollment;const native=owned.child.send.bind(owned.child);
  mock.method(owned.child,'send',(message:unknown,callback:(error?:Error|null)=>void)=>{
   if((message as {kind?:string}).kind==='finish')return native(message,(error?:Error|null)=>{release=()=>callback(error);});
   return native(message,callback);
  });
  const cleanup=owned.abort();await until(()=>!!release,1000);await new Promise(r=>setTimeout(r,3150));release?.();
  await assert.rejects(cleanup,/Producer cleanup deadline/);
 }finally{release?.();mock.restoreAll();await owned.abort();await fs.rm(root,{recursive:true,force:true});}
});
test('quota rejected send issues no IPC and leaves no delayed child kill',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-tmp102-quota-')));
 const {ownedProducer}=await import(new URL('../../../examples/tmp102-hwmon/consumer.mjs',import.meta.url).href);
 const owned=await ownedProducer(root);let issued=0,kills=0;
 try{await owned.enrollment;const nativeSend=owned.child.send.bind(owned.child),nativeKill=owned.child.kill.bind(owned.child);
  mock.method(owned.child,'send',(...args:Parameters<typeof owned.child.send>)=>{issued++;return nativeSend(...args);});
  mock.method(owned.child,'kill',(...args:Parameters<typeof owned.child.kill>)=>{kills++;return nativeKill(...args);});
  for(let i=0;i<31;i++)await owned.send('contents',{bytes:'0\n'});
  const natural=await owned.finish();assert.deepEqual(natural.exit,{code:0,signal:null});assert.equal(issued,32);
  await assert.rejects(owned.send('contents',{bytes:'0\n'}));assert.equal(issued,32);
  assert.deepEqual(await fs.readdir(root),[]);await new Promise(r=>setTimeout(r,2650));assert.equal(kills,0);
 }finally{await owned.abort();mock.restoreAll();await fs.rm(root,{recursive:true,force:true});}
});
test('a rejected native finish send still joins the actual child',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-tmp102-rejected-finish-')));
 const {ownedProducer}=await import(new URL('../../../examples/tmp102-hwmon/consumer.mjs',import.meta.url).href);
 const owned=await ownedProducer(root);
 try{await owned.enrollment;const native=owned.child.send.bind(owned.child);
  mock.method(owned.child,'send',(message:unknown,callback:(error?:Error|null)=>void)=>{
   if((message as {kind?:string}).kind==='finish')return native(message,()=>callback(Error('issued native finish callback rejected')));
   return native(message,callback);
  });
  await assert.rejects(owned.finish(),error=>{
   const failure=error as Error&{producerExit?:{code:number|null;signal:string|null};producerClose?:{code:number|null;signal:string|null}};
   assert.match(failure.message,/Producer finish failed/);assert.deepEqual(failure.producerClose,failure.producerExit);return true;
  });
  const joined=await owned.abort();assert.deepEqual(joined.closure,joined.natural);
  assert.deepEqual(await fs.readdir(root),[]);
 }finally{mock.restoreAll();await owned.abort();await fs.rm(root,{recursive:true,force:true});}
});
test('provider close failure still closes its independent real producer',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-tmp102-provider-close-'))),original=fs.open.bind(fs);
 let actual:Awaited<ReturnType<typeof fs.open>>|undefined;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);
  if(typeof args[0]==='string'&&args[0].endsWith('/temp1_input')){actual=h;mock.method(h,'close',async()=>{throw Error('held-native-close');});}return h;});
 try{const {runTmp102HwmonExample}=await import(new URL('../../../examples/tmp102-hwmon/consumer.mjs',import.meta.url).href);
  await assert.rejects(runTmp102HwmonExample({workRoot:root}));assert.deepEqual(await fs.readdir(root),[]);
 }finally{mock.restoreAll();await actual?.close();
  // A red run against the preserved old consumer can leave its exact child alive.
  const lines=execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n');
  for(const line of lines){const m=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);if(m&&Number(m[2])===process.pid&&m[3]!.includes('/examples/tmp102-hwmon/producer.mjs')&&m[3]!.includes(root))process.kill(Number(m[1]),'SIGTERM');}
  await fs.rm(root,{recursive:true,force:true});}
});
test('producer startup terminal path drains issued files when native IPC is absent',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-tmp102-no-ipc-')));
 const script=new URL('../../../examples/tmp102-hwmon/producer.mjs',import.meta.url).pathname;
 const child=spawn(process.execPath,[script,root],{env:{NODE_ENV:'production'},stdio:['pipe','pipe','pipe']});
 const natural=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(done=>child.once('exit',(code,signal)=>done({code,signal})));
 const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(done=>child.once('close',(code,signal)=>done({code,signal})));
 child.stdout.resume();child.stderr.resume();const ended=new Promise<void>((done,reject)=>child.stdin.end((error?:Error|null)=>error?reject(error):done()));
 const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
 try{const [exit,close,writes]=await Promise.all([natural,closed,Promise.allSettled([ended])]);clearTimeout(timer);
  assert.deepEqual(close,exit);assert.notEqual(exit.code,0);assert.ok(writes.every(r=>r.status==='fulfilled'));
  assert.deepEqual(await fs.readdir(root),[]);
 }finally{clearTimeout(timer);await fs.rm(root,{recursive:true,force:true});}
});
test('late open is owned through authentic held close and blocks overlapping restart',async()=>{
 const f=await fixture();const opened=deferred<Awaited<ReturnType<typeof fs.open>>>(),closed=deferred<void>();let issued=false;
 const actual=await fs.open(join(f.profile.hwmonRealPath,'name'),constants.O_RDONLY);mock.method(actual,'close',()=>closed.promise);
 mock.method(fs,'open',()=>{issued=true;return opened.promise;});const c=createTmp102HwmonConnector(f.options);
 try{const start=c.start(f.request());await until(()=>issued);const stopping=c.stop();assert.equal(c.status().pendingOperations,1);
 assert.equal((await c.start(f.request())).ok,false);opened.resolve(actual);await until(()=>c.status().openHandles===1);assert.equal(c.status().phase,'retiring');
 closed.resolve();await stopping;assert.equal((await start).ok,false);assert.equal(c.status().openHandles,0);assert.equal(c.status().pendingOperations,0);
 }finally{mock.restoreAll();await actual.close();await c.close();await f.cleanup();}
});
test('held native read deadline suppresses result and joins read before actual close',async()=>{
 const f=await fixture();const original=fs.open.bind(fs),held=deferred<void>();let read=false,closeDuringRead=false,handle:Awaited<ReturnType<typeof fs.open>>|undefined;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.hwmonRealPath,'temp1_input')){
 handle=h;const nativeRead=h.read.bind(h),nativeClose=h.close.bind(h);mock.method(h,'read',async(...a:Parameters<typeof h.read>)=>{read=true;await held.promise;read=false;return nativeRead(...a);});
 mock.method(h,'close',()=>{if(read)closeDuringRead=true;return nativeClose();});}return h;});
 const c=createTmp102HwmonConnector(f.options);try{const start=c.start({...f.request(),deadline:performance.now()+80});await until(()=>read);
 await until(()=>c.status().phase==='retiring');assert.equal(c.status().inFlightReads,1);assert.equal(c.status().openHandles,1);assert.equal(closeDuringRead,false);
 held.resolve();assert.equal((await start).ok,false);await c.stop();assert.equal(f.readings.length,0);assert.equal(c.status().openHandles,0);assert.ok(handle);assert.equal(closeDuringRead,false);
 }finally{held.resolve();await c.close();await f.cleanup();}
});
test('short canonical prefix cannot conceal trailing bytes',async()=>{
 const f=await fixture('0\nBAD'),original=fs.open.bind(fs);mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);
 if(args[0]===join(f.profile.hwmonRealPath,'temp1_input'))mock.method(h,'read',async(buffer:Buffer)=>{buffer.write('0\n');return {bytesRead:2,buffer};});return h;});
 const c=createTmp102HwmonConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,0);}finally{await c.close();await f.cleanup();}
});
test('opened handle identity mismatch cannot emit even when path stats match',async()=>{
 const f=await fixture(),original=fs.open.bind(fs);mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
 if(args[0]===join(f.profile.hwmonRealPath,'temp1_input'))return original(join(f.profile.hwmonRealPath,'name'),constants.O_RDONLY);return original(...args);});
 const c=createTmp102HwmonConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,0);}finally{await c.close();await f.cleanup();}
});
test('EAGAIN/missing/malformed never become zero or an automatic retry',async()=>{
 for(const kind of ['EAGAIN','ENOENT','EACCES','EIO','malformed']){const f=await fixture(kind==='malformed'?'0.0\n':'0\n'),original=fs.open.bind(fs);let count=0;
 if(kind!=='malformed')mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.hwmonRealPath,'temp1_input'))mock.method(h,'read',async()=>{count++;throw Object.assign(Error('native'),{code:kind});});return h;});
 const c=createTmp102HwmonConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);await c.stop();assert.equal(f.readings.length,0);assert.ok(count<=1);assert.equal(f.unavailable.length,1);}finally{await c.close();await f.cleanup();}}
});
test('authorizer and reading callback reentry cannot resurrect source or overlap',async()=>{
 const f=await fixture();const c=createTmp102HwmonConnector({...f.options,authorize:request=>{void c.close();return {request,signal:f.grant.signal,expiresAt:request.deadline};}});
 try{assert.equal((await c.start(f.request())).ok,false);await c.close();assert.equal(c.status().phase,'closed');
 const other=createTmp102HwmonConnector({...f.options,onTemperature:()=>{void other.stop();throw Error('callback');}});assert.equal((await other.start(f.request())).ok,false);await other.close();assert.equal(other.status().openHandles,0);
 }finally{await c.close();await f.cleanup();}
});
test('owner caller and standing grant revocation retire before another read',async()=>{
 for(const field of ['owner','caller','grant'] as const){const f=await fixture(),c=createTmp102HwmonConnector(f.options);try{assert.ok((await c.start(f.request())).ok);f[field].abort();await c.stop();assert.equal(f.readings.length,1);assert.equal(c.status().openHandles,0);}finally{await c.close();await f.cleanup();}}
});
test('eight lifetime starts exhaust attempts without reset',async()=>{
 const f=await fixture(),c=createTmp102HwmonConnector(f.options);try{for(let i=0;i<8;i++){assert.ok((await c.start(f.request())).ok);await c.stop();}
 assert.equal((await c.start(f.request())).ok,false);assert.equal(c.status().attempts,8);assert.equal(f.readings[7]?.localSequence,8);}finally{await c.close();await f.cleanup();}
});
test('failed close retains real reservation and refuses restart',async()=>{
 const f=await fixture(),original=fs.open.bind(fs);let actual:Awaited<ReturnType<typeof fs.open>>|undefined;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.hwmonRealPath,'temp1_input')){actual=h;mock.method(h,'close',async()=>{throw Error('unconfirmed');});}return h;});
 const c=createTmp102HwmonConnector(f.options);try{assert.ok((await c.start(f.request())).ok);await assert.rejects(c.stop());assert.equal(c.status().phase,'retiring');assert.equal(c.status().openHandles,1);
 assert.equal(c.status().unconfirmedCloses,1);assert.equal((await c.start(f.request())).ok,false);}finally{mock.restoreAll();await actual?.close();await f.cleanup();}
});
test('canonical text consumes every byte including doubled LF and trailing CR',()=>{
 for(const raw of ['0\n\n','0\n\r','1\n\n'])assert.throws(()=>decodeTmp102Temperature(Buffer.from(raw)));
});
test('ordinary public SDK caller delivers signed exact values and owns natural producer close',async()=>{
 const url=new URL('../../../examples/tmp102-hwmon/consumer.mjs',import.meta.url);
 const {runTmp102HwmonExample}=await import(url.href);const result=await runTmp102HwmonExample();
 assert.equal(result.status,'pass');assert.equal(result.physical,false);assert.deepEqual(result.supportRows,[]);assert.equal(result.producerExit.code,0);assert.equal(result.producerExit.signal,null);
 assert.equal(result.producerClosed,true);assert.deepEqual(result.applied.slice(0,4).map((o:{value:number})=>o.value),[-.062,0,25,25]);
});
test('closure fence detects actual copied artifact and receipt mutations and exact restoration',async()=>{
 const f=await fixture();try{const {createTmp102ClosureFence}=await import(new URL('../../../tools/qa-tmp102-hwmon.mjs',import.meta.url).href);
 const artifact=join(f.root,'artifact'),receipt=join(f.root,'receipt.json'),dep=join(f.root,'dependencies.json');await fs.writeFile(artifact,'actual');await fs.writeFile(receipt,'{"status":"pass"}');await fs.writeFile(dep,'{"status":"pass"}');
 const fence=createTmp102ClosureFence({artifacts:{provider:artifact},sdkReceiptPath:receipt,dependencyReceiptPath:dep,sourcePaths:[],sdkPaths:[],dependencyPaths:[]});
 assert.ok(fence.verify());await fs.writeFile(artifact,'mutation');assert.throws(()=>fence.verify());await fs.writeFile(artifact,'actual');assert.ok(fence.verify());
 await fs.writeFile(receipt,'{"status":"pass","changed":true}');assert.throws(()=>fence.verify());await fs.writeFile(receipt,'{"status":"pass"}');assert.ok(fence.verify());
 }finally{await f.cleanup();}
});
test('read rejection does not conceal an independently held close',async()=>{
 const f=await fixture(),original=fs.open.bind(fs),close=deferred<void>();let actual:Awaited<ReturnType<typeof fs.open>>|undefined;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.hwmonRealPath,'temp1_input')){
 actual=h;mock.method(h,'read',async()=>{throw Object.assign(Error('read failed'),{code:'EIO'});});mock.method(h,'close',()=>close.promise);}return h;});
 const c=createTmp102HwmonConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);await until(()=>c.status().pendingOperations===1);
 assert.equal(c.status().openHandles,1);assert.equal(c.status().phase,'retiring');assert.equal((await c.start(f.request())).ok,false);close.resolve();await c.stop();assert.equal(c.status().openHandles,0);
 }finally{close.resolve();await c.close();mock.restoreAll();await actual?.close();await f.cleanup();}
});
test('persistent replacement during held read cannot publish retained old bytes',async()=>{
 const f=await fixture(),original=fs.open.bind(fs),held=deferred<void>();let reading=false;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.hwmonRealPath,'temp1_input')){
 const native=h.read.bind(h);mock.method(h,'read',async(...a:Parameters<typeof h.read>)=>{reading=true;await held.promise;return native(...a);});}return h;});
 const c=createTmp102HwmonConnector(f.options);try{const start=c.start(f.request());await until(()=>reading);await fs.rename(join(f.profile.hwmonRealPath,'temp1_input'),join(f.profile.hwmonRealPath,'old'));await fs.writeFile(join(f.profile.hwmonRealPath,'temp1_input'),'0\n');
 held.resolve();assert.equal((await start).ok,false);await c.stop();assert.equal(f.readings.length,0);assert.equal(c.status().openHandles,0);}finally{held.resolve();await c.close();await f.cleanup();}
});
test('public receipt equality and greater-than expiry use the unchanged SDK policy',async()=>{
 const {createDeviceRuntime,parseDeviceDescriptor}=await import('@101/connect');let time=1000;const applied:number[]=[];
 const value={type:'scalar',unit:'Cel',min:-55,max:150};const device=parseDeviceDescriptor({schemaVersion:1,id:'equality-test',label:'Temperature',revision:1,adapter:{id:'test:equality',version:'1'},runtime:{platform:'test'},capabilities:[
 {id:'in',semantic:'sensor:temperature',schemaVersion:1,kind:'sample',value,delivery:{mode:'latest',maxHz:1,maxAgeMs:1000},permissions:['subscribe']},
 {id:'out',semantic:'sensor:temperature',schemaVersion:1,kind:'property',value,delivery:{mode:'latest',maxHz:1,maxAgeMs:1000},permissions:['write'],ownership:{mode:'observe'}}]});
 const runtime=createDeviceRuntime({now:()=>time,authorize:()=>({expiresAt:10000,maxAgeMs:1000})}),source=runtime.registerSource({device,capability:'in'}),sink=runtime.registerSink({device,capability:'out',apply(o){applied.push(o.value as number);},release(){}});
 runtime.setReadiness(source,'available');runtime.setReadiness(sink,'available');const route=runtime.route({from:source,to:sink,principalId:'a',applicationId:'b',sessionId:'c',leaseMs:8000});assert.ok(route.start().ok);
 assert.ok(runtime.publish(source,25,{timestamp:0,sequence:1}).ok);runtime.flush();assert.deepEqual(applied,[25]);time=1001;assert.equal(runtime.publish(source,26,{timestamp:0,sequence:2}).ok,false);runtime.flush();assert.deepEqual(applied,[25]);runtime.close();
});
test('standing grant expiry narrows the original deadline with no automatic reacquisition',async()=>{
 const f=await fixture();let calls=0;const c=createTmp102HwmonConnector({...f.options,authorize:request=>{calls++;return{request,signal:f.grant.signal,expiresAt:performance.now()+70};}});
 try{assert.ok((await c.start(f.request())).ok);await until(()=>c.status().phase==='idle');assert.equal(calls,1);assert.equal(f.readings.length,1);assert.equal(c.status().openHandles,0);}finally{await c.close();await f.cleanup();}
});
test('old public value becomes stale while a real file read is reserved and held',async()=>{
 const f=await fixture(),original=fs.open.bind(fs),held=deferred<void>();let reads=0;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.hwmonRealPath,'temp1_input')){
 const read=h.read.bind(h);mock.method(h,'read',async(...a:Parameters<typeof h.read>)=>{if(++reads===2)await held.promise;return read(...a);});}return h;});
 const {createDeviceRuntime,parseDeviceDescriptor}=await import('@101/connect'),applied:number[]=[],value=TMP102_HWMON_VALUE_SCHEMA;
 const device=parseDeviceDescriptor({schemaVersion:1,id:'stale-held-test',label:'Temperature',revision:1,adapter:{id:'test:held',version:'1'},runtime:{platform:'owned-file'},capabilities:[
 {id:'in',semantic:'sensor:temperature',schemaVersion:1,kind:'sample',value,delivery:{mode:'latest',maxHz:1,maxAgeMs:1000},permissions:['subscribe']},
 {id:'out',semantic:'sensor:temperature',schemaVersion:1,kind:'property',value,delivery:{mode:'latest',maxHz:1,maxAgeMs:1000},permissions:['write'],ownership:{mode:'observe'}}]});
 const runtime=createDeviceRuntime({clockDomain:'tmp102-gateway-monotonic',authorize:()=>({expiresAt:performance.now()+4000,maxAgeMs:1000})}),source=runtime.registerSource({device,capability:'in'}),sink=runtime.registerSink({device,capability:'out',apply(o){applied.push(o.value as number);},release(){}});
 runtime.setReadiness(source,'available');runtime.setReadiness(sink,'available');const route=runtime.route({from:source,to:sink,principalId:'a',applicationId:'b',sessionId:'c',leaseMs:4000});assert.ok(route.start().ok);
 const c=createTmp102HwmonConnector({...f.options,onTemperature:r=>{f.readings.push(r);assert.ok(runtime.publish(source,r.decoded.reportedCelsius,{timestamp:r.receivedAt,clockDomain:r.receiptClockId,sequence:r.localSequence}).ok);}});
 try{assert.ok((await c.start(f.request())).ok);await until(()=>reads===2);assert.equal(c.status().inFlightReads,1);await until(()=>performance.now()-f.readings[0]!.receivedAt>1002);runtime.flush();assert.deepEqual(applied,[]);
 assert.equal(runtime.publish(source,25,{timestamp:f.readings[0]!.receivedAt,clockDomain:'tmp102-gateway-monotonic',sequence:2}).ok,false);
 const stopped=c.stop();assert.equal(c.status().openHandles,1);held.resolve();await stopped;assert.equal(f.readings.length,1);assert.equal(c.status().openHandles,0);
 }finally{held.resolve();await c.close();runtime.close();await f.cleanup();}
});
test('raw open intention is reserved before synchronous stop reentry and late adoption',async()=>{
 const f=await fixture(),opened=deferred<Awaited<ReturnType<typeof fs.open>>>(),actual=await fs.open(join(f.profile.hwmonRealPath,'name'),constants.O_RDONLY);
 let pendingAtEffect=-1,stopping:Promise<void>|undefined;const c=createTmp102HwmonConnector(f.options);
 mock.method(fs,'open',()=>{pendingAtEffect=c.status().pendingOperations;stopping=c.stop();return opened.promise;});
 try{const started=c.start(f.request());await until(()=>pendingAtEffect>=0);assert.equal(pendingAtEffect,1);
 assert.equal(c.status().phase,'retiring');assert.equal(c.status().pendingOperations,1);assert.equal((await c.start(f.request())).ok,false);
 opened.resolve(actual);await stopping;assert.equal((await started).ok,false);assert.equal(c.status().openHandles,0);assert.equal(c.status().pendingOperations,0);
 }finally{opened.resolve(actual);await new Promise(r=>setImmediate(r));mock.restoreAll();await actual.close();await c.close();await f.cleanup();}
});
test('callback-thrown null-prototype/proxy/Symbol values retire without diagnostic coercion',async()=>{
 let traps=0;for(const thrown of [Object.create(null),Symbol('failure'),new Proxy({},{get(){traps++;throw Error('trap');},getOwnPropertyDescriptor(){traps++;throw Error('trap');}})]){
 const f=await fixture(),c=createTmp102HwmonConnector({...f.options,onTemperature:()=>{throw thrown;},onUnavailable:()=>{throw Object.create(null);}});
 try{assert.equal((await c.start(f.request())).ok,false);await c.close();assert.equal(c.status().openHandles,0);assert.equal(c.status().pendingOperations,0);assert.equal(c.status().timers,0);}finally{await c.close();await f.cleanup();}}
 assert.equal(traps,0);
});
test('thirty reads exhaust a session budget without a thirty-first native read',async()=>{
 const f=await fixture();let time=1000;mock.method(performance,'now',()=>time);mock.timers.enable({apis:['setTimeout']});const c=createTmp102HwmonConnector(f.options);
 async function settle(predicate:()=>boolean){for(let turn=0;turn<10000;turn++){if(predicate())return;await new Promise(r=>setImmediate(r));}assert.fail('Controlled native completion did not settle');}
 try{assert.ok((await c.start({...f.request(),deadline:time+30000})).ok);for(let i=1;i<30;i++){time+=1000;mock.timers.tick(1000);await settle(()=>f.readings.length===i+1);}
 await settle(()=>c.status().phase==='idle');assert.equal(f.readings.length,30);assert.equal(c.status().reason,'read-budget');time+=1000;mock.timers.tick(1000);assert.equal(f.readings.length,30);assert.equal(c.status().openHandles,0);
 }finally{await c.close();mock.timers.reset();await f.cleanup();}
});
