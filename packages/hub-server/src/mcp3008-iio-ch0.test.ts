import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createMcp3008IioConnector, decodeMcp3008Code, parseMcp3008IioProfile, MCP3008_IIO_CODE_SCHEMA } from './mcp3008-iio-ch0.ts';
import type { Mcp3008IioProfile, Mcp3008CodeReading, Mcp3008IioOptions } from './mcp3008-iio-ch0.ts';

function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:unknown)=>void;
  const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
async function until(predicate:()=>boolean, ms=2000) { const deadline=performance.now()+ms;
  while(!predicate()) { assert.ok(performance.now()<deadline,'condition deadline'); await new Promise(r=>setTimeout(r,2)); } }
async function fixture(text='512\n') {
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-mcp3008-test-'))), parent=join(root,'parent'),hwmon=join(parent,'iio:device0');
  await fs.mkdir(hwmon,{recursive:true}); await fs.writeFile(join(hwmon,'in_voltage0_raw'),text);
  const identity=async(path:string)=>{const s=await fs.lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};};
  const profile:Mcp3008IioProfile={profileId:'mcp3008-iio-ch0-abi-file/1',revision:1,parentRealPath:parent,iioRealPath:hwmon,rawRealPath:join(hwmon,'in_voltage0_raw'),spiController:'spi0',chipSelect:0,channel:0,mode:'single-ended',maxHz:1,reference:null,
    driverBuildSha256:'0'.repeat(64),environmentReceiptSha256:'1'.repeat(64),ancestorPolicy:'host-controlled-stable',
    enrolledIdentities:{parent:await identity(parent),iio:await identity(hwmon),raw:await identity(join(hwmon,'in_voltage0_raw'))}};
  const owner=new AbortController(),caller=new AbortController(),grant=new AbortController(),readings:Mcp3008CodeReading[]=[],unavailable:string[]=[];
  const options:Mcp3008IioOptions={profile,scope:{principalId:'owner',applicationId:'tests',sessionId:'one'},ownerSignal:owner.signal,
    authorize:request=>({request,signal:grant.signal,expiresAt:request.deadline}),onCode:r=>readings.push(r),onUnavailable:r=>unavailable.push(r)};
  return {root,profile,owner,caller,grant,readings,unavailable,options,request:()=>({purpose:'selected-read',signal:caller.signal,deadline:performance.now()+4000}),
    async cleanup(){mock.restoreAll();await fs.rm(root,{recursive:true,force:true});}};
}
for(const [raw,code] of [['0\n',0],['1\n',1],['512\n',512],['1023\n',1023]] as const)
 test(`decoder preserves complete raw code ${JSON.stringify(raw)}`,()=>{const bytes=Buffer.from(raw),d=decodeMcp3008Code(bytes);assert.deepEqual({code:d.code,rawBytes:d.rawBytes},{code,rawBytes:bytes.length});assert.match(d.rawSha256,/^[a-f0-9]{64}$/);assert.ok(Object.isFrozen(d));bytes.fill(0);assert.equal(d.code,code);});
for(const raw of ['', '0','1024\n','-1\n','0.0\n','+1\n','01\n','-0\n','1e3\n','1\r\n','1\n0','1\0\n','1'.repeat(65)+'\n','\u0080\n',' 1\n','1\n\n','1\n\r'])
 test(`decoder refuses ${JSON.stringify(raw)}`,()=>assert.throws(()=>decodeMcp3008Code(Buffer.from(raw))));
test('decoder refuses proxy and lookalike before traps',()=>{let calls=0;assert.throws(()=>decodeMcp3008Code(new Proxy(new Uint8Array([48,10]),{get(){calls++;throw Error('trap');}})));assert.equal(calls,0);assert.throws(()=>decodeMcp3008Code({length:2} as Uint8Array));assert.deepEqual(MCP3008_IIO_CODE_SCHEMA,{type:'scalar',unit:'1',min:0,max:1023});});
test('profile freezes selected identities and nominal reference without measured voltage',async()=>{const f=await fixture();try{const nominal={configurationId:'provisioned-vref',millivolts:{numerator:3300,denominator:1},measured:false as const};const p=parseMcp3008IioProfile({...f.profile,reference:nominal});assert.ok(Object.isFrozen(p.enrolledIdentities.raw));assert.ok(Object.isFrozen(p.reference?.millivolts));nominal.millivolts.numerator=5000;assert.equal(p.reference?.millivolts?.numerator,3300);assert.equal(p.reference?.measured,false);
 for(const change of [{channel:1},{mode:'differential'},{maxHz:2},{chipSelect:-1},{chipSelect:Number.MAX_SAFE_INTEGER+1},{parentRealPath:'/a/../b'},{iioRealPath:f.profile.parentRealPath+'extra/iio:device0'},{rawRealPath:f.profile.iioRealPath+'/in_voltage1_raw'},{reference:{...nominal,measured:true}},{reference:{...nominal,millivolts:{numerator:1,denominator:0}}},{ancestorPolicy:'hostile'},{revision:2},{profileId:'mcp3008-ch0-low-rate-code-capture/1'}])assert.throws(()=>parseMcp3008IioProfile({...f.profile,...change}));let calls=0;assert.throws(()=>parseMcp3008IioProfile({...f.profile,get revision(){calls++;return 1;}}));assert.throws(()=>parseMcp3008IioProfile(new Proxy(f.profile,{ownKeys(){calls++;throw Error();}})));assert.equal(calls,0);
 }finally{await f.cleanup();}});
test('standing denial and native refusal issue zero filesystem effects',async()=>{
 const f=await fixture();try{let effects=0;for(const method of ['realpath','lstat','stat','open'] as const)mock.method(fs,method,()=>{effects++;throw Error('forbidden');});
  const c=createMcp3008IioConnector({...f.options,authorize:()=>undefined});assert.equal((await c.start(f.request())).ok,false);await c.close();
  let authorizations=0;const n=createMcp3008IioConnector({...f.options,profile:{...f.profile,profileId:'linux-mcp3008-iio-ch0-raw-read/1'},authorize:r=>{authorizations++;return {request:r,signal:f.grant.signal,expiresAt:r.deadline};}});
  assert.deepEqual(await n.start(f.request()),{ok:false,reason:'native-admission-not-qualified'});await n.close();assert.equal(authorizations,0);assert.equal(effects,0);
 }finally{await f.cleanup();}
});
test('exact request and genuine owner/caller/grant signals and original bounds fence all effects',async()=>{
 const f=await fixture();try{
  assert.throws(()=>createMcp3008IioConnector({...f.options,ownerSignal:new Proxy(f.owner.signal,{})}));
  assert.throws(()=>createMcp3008IioConnector({...f.options,ownerSignal:Object.create(f.owner.signal)}));
  class Derived extends AbortSignal {} assert.throws(()=>createMcp3008IioConnector({...f.options,ownerSignal:Object.create(Derived.prototype)}));
  const c=createMcp3008IioConnector(f.options);assert.equal((await c.start({...f.request(),signal:new Proxy(f.caller.signal,{})})).ok,false);
  assert.equal((await c.start({...f.request(),deadline:performance.now()-1})).ok,false);assert.equal((await c.start({...f.request(),deadline:performance.now()+30001})).ok,false);await c.close();
  for(const authorize of [()=>({request:{} as never,signal:f.grant.signal,expiresAt:performance.now()+1000}),
    (request:Parameters<Mcp3008IioOptions['authorize']>[0])=>({request,signal:new Proxy(f.grant.signal,{}),expiresAt:request.deadline})]){
    const bad=createMcp3008IioConnector({...f.options,authorize});assert.equal((await bad.start(f.request())).ok,false);await bad.close();
  }
 }finally{await f.cleanup();}
});
test('fixed file replacement invalidates retained enrollment across starts',async()=>{
 const f=await fixture();const c=createMcp3008IioConnector(f.options);try{assert.ok((await c.start(f.request())).ok);await c.stop();
 await fs.rename(join(f.profile.iioRealPath,'in_voltage0_raw'),join(f.profile.iioRealPath,'old'));await fs.writeFile(join(f.profile.iioRealPath,'in_voltage0_raw'),'0\n');
 assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,1);await c.stop();assert.equal(c.status().openHandles,0);
 }finally{await c.close();await f.cleanup();}
});
test('persistent ancestor movement and symlink fixed file retire',async()=>{
 const f=await fixture();const c=createMcp3008IioConnector(f.options);try{await fs.rename(f.profile.parentRealPath,f.profile.parentRealPath+'-old');
 await fs.symlink(f.profile.parentRealPath+'-old',f.profile.parentRealPath);assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,0);
 }finally{await c.close();await f.cleanup();}
});
test('directory instead of fixed regular file is refused before reading',async()=>{
 const f=await fixture();await fs.unlink(join(f.profile.iioRealPath,'in_voltage0_raw'));await fs.mkdir(join(f.profile.iioRealPath,'in_voltage0_raw'));
 const c=createMcp3008IioConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,0);}finally{await c.close();await f.cleanup();}
});
test('producer enrollment failure joins the actual failed child before returning',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-mcp3008-start-fail-'))),original=fs.realpath.bind(fs);
 mock.method(fs,'realpath',async(...args:Parameters<typeof fs.realpath>)=>{const value=await original(...args);if(args[0]===root)await fs.rm(root,{recursive:true,force:true});return value;});
 try{const {runMcp3008IioExample}=await import(new URL('../../../examples/mcp3008-iio-ch0/consumer.mjs',import.meta.url).href);
  await assert.rejects(runMcp3008IioExample({workRoot:root}),error=>{
   assert.match((error as Error).message,/Producer exited before enrollment/);
   const result=error as Error&{producerExit?:{code:number|null;signal:string|null};producerClose?:{code:number|null;signal:string|null}};
   assert.deepEqual(result.producerExit,result.producerClose);assert.notEqual(result.producerExit?.code,0);return true;
  });
 }finally{mock.restoreAll();await fs.rm(root,{recursive:true,force:true});}
});
test('a held real producer finish callback expires but remains owned until settlement',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-mcp3008-held-finish-')));
 const {ownedProducer}=await import(new URL('../../../examples/mcp3008-iio-ch0/consumer.mjs',import.meta.url).href);
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
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-mcp3008-held-abort-')));
 const {ownedProducer}=await import(new URL('../../../examples/mcp3008-iio-ch0/consumer.mjs',import.meta.url).href);
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
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-mcp3008-quota-')));
 const {ownedProducer}=await import(new URL('../../../examples/mcp3008-iio-ch0/consumer.mjs',import.meta.url).href);
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
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-mcp3008-rejected-finish-')));
 const {ownedProducer}=await import(new URL('../../../examples/mcp3008-iio-ch0/consumer.mjs',import.meta.url).href);
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
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-mcp3008-provider-close-'))),original=fs.open.bind(fs);
 let actual:Awaited<ReturnType<typeof fs.open>>|undefined;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);
  if(typeof args[0]==='string'&&args[0].endsWith('/in_voltage0_raw')){actual=h;mock.method(h,'close',async()=>{throw Error('held-native-close');});}return h;});
 try{const {runMcp3008IioExample}=await import(new URL('../../../examples/mcp3008-iio-ch0/consumer.mjs',import.meta.url).href);
  await assert.rejects(runMcp3008IioExample({workRoot:root}));assert.deepEqual(await fs.readdir(root),[]);
 }finally{mock.restoreAll();await actual?.close();
  await fs.rm(root,{recursive:true,force:true});}
});
test('producer startup terminal path drains issued files when native IPC is absent',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-mcp3008-no-ipc-')));
 const script=new URL('../../../examples/mcp3008-iio-ch0/producer.mjs',import.meta.url).pathname;
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
 const actual=await fs.open(join(f.profile.iioRealPath,'in_voltage0_raw'),constants.O_RDONLY);mock.method(actual,'close',()=>closed.promise);
 mock.method(fs,'open',()=>{issued=true;return opened.promise;});const c=createMcp3008IioConnector(f.options);
 try{const start=c.start(f.request());await until(()=>issued);const stopping=c.stop();assert.equal(c.status().pendingOperations,1);
 assert.equal((await c.start(f.request())).ok,false);opened.resolve(actual);await until(()=>c.status().openHandles===1);assert.equal(c.status().phase,'retiring');
 closed.resolve();await stopping;assert.equal((await start).ok,false);assert.equal(c.status().openHandles,0);assert.equal(c.status().pendingOperations,0);
 }finally{mock.restoreAll();await actual.close();await c.close();await f.cleanup();}
});
test('held native read deadline suppresses result and joins read before actual close',async()=>{
 const f=await fixture();const original=fs.open.bind(fs),held=deferred<void>();let read=false,closeDuringRead=false,handle:Awaited<ReturnType<typeof fs.open>>|undefined;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.iioRealPath,'in_voltage0_raw')){
 handle=h;const nativeRead=h.read.bind(h),nativeClose=h.close.bind(h);mock.method(h,'read',async(...a:Parameters<typeof h.read>)=>{read=true;await held.promise;read=false;return nativeRead(...a);});
 mock.method(h,'close',()=>{if(read)closeDuringRead=true;return nativeClose();});}return h;});
 const c=createMcp3008IioConnector(f.options);try{const start=c.start({...f.request(),deadline:performance.now()+80});await until(()=>read);
 await until(()=>c.status().phase==='retiring');assert.equal(c.status().inFlightReads,1);assert.equal(c.status().openHandles,1);assert.equal(closeDuringRead,false);
 held.resolve();assert.equal((await start).ok,false);await c.stop();assert.equal(f.readings.length,0);assert.equal(c.status().openHandles,0);assert.ok(handle);assert.equal(closeDuringRead,false);
 }finally{held.resolve();await c.close();await f.cleanup();}
});
test('short canonical prefix cannot conceal trailing bytes',async()=>{
 const f=await fixture('0\nBAD'),original=fs.open.bind(fs);mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);
 if(args[0]===join(f.profile.iioRealPath,'in_voltage0_raw'))mock.method(h,'read',async(buffer:Buffer)=>{buffer.write('0\n');return {bytesRead:2,buffer};});return h;});
 const c=createMcp3008IioConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,0);}finally{await c.close();await f.cleanup();}
});
test('opened handle identity mismatch cannot emit even when path stats match',async()=>{
 const f=await fixture(),original=fs.open.bind(fs);mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
 if(args[0]===join(f.profile.iioRealPath,'in_voltage0_raw'))return original(f.profile.parentRealPath,constants.O_RDONLY);return original(...args);});
 const c=createMcp3008IioConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);assert.equal(f.readings.length,0);}finally{await c.close();await f.cleanup();}
});
test('EAGAIN/missing/malformed never become zero or an automatic retry',async()=>{
 for(const kind of ['EAGAIN','ENOENT','EACCES','EIO','malformed']){const f=await fixture(kind==='malformed'?'0.0\n':'0\n'),original=fs.open.bind(fs);let count=0;
 if(kind!=='malformed')mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.iioRealPath,'in_voltage0_raw'))mock.method(h,'read',async()=>{count++;throw Object.assign(Error('native'),{code:kind});});return h;});
 const c=createMcp3008IioConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);await c.stop();assert.equal(f.readings.length,0);assert.ok(count<=1);assert.equal(f.unavailable.length,1);}finally{await c.close();await f.cleanup();}}
});
test('authorizer and reading callback reentry cannot resurrect source or overlap',async()=>{
 const f=await fixture();const c=createMcp3008IioConnector({...f.options,authorize:request=>{void c.close();return {request,signal:f.grant.signal,expiresAt:request.deadline};}});
 try{assert.equal((await c.start(f.request())).ok,false);await c.close();assert.equal(c.status().phase,'closed');
 const other=createMcp3008IioConnector({...f.options,onCode:()=>{void other.stop();throw Error('callback');}});assert.equal((await other.start(f.request())).ok,false);await other.close();assert.equal(other.status().openHandles,0);
 }finally{await c.close();await f.cleanup();}
});
test('owner caller and standing grant revocation retire before another read',async()=>{
 for(const field of ['owner','caller','grant'] as const){const f=await fixture(),c=createMcp3008IioConnector(f.options);try{assert.ok((await c.start(f.request())).ok);f[field].abort();await c.stop();assert.equal(f.readings.length,1);assert.equal(c.status().openHandles,0);}finally{await c.close();await f.cleanup();}}
});
test('eight lifetime starts exhaust attempts without reset',async()=>{
 const f=await fixture(),c=createMcp3008IioConnector(f.options);try{for(let i=0;i<8;i++){assert.ok((await c.start(f.request())).ok);await c.stop();}
 assert.equal((await c.start(f.request())).ok,false);assert.equal(c.status().attempts,8);assert.equal(f.readings[7]?.localSequence,8);}finally{await c.close();await f.cleanup();}
});
test('failed close retains real reservation and refuses restart',async()=>{
 const f=await fixture(),original=fs.open.bind(fs);let actual:Awaited<ReturnType<typeof fs.open>>|undefined;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.iioRealPath,'in_voltage0_raw')){actual=h;mock.method(h,'close',async()=>{throw Error('unconfirmed');});}return h;});
 const c=createMcp3008IioConnector(f.options);try{assert.ok((await c.start(f.request())).ok);await assert.rejects(c.stop());assert.equal(c.status().phase,'retiring');assert.equal(c.status().openHandles,1);
 assert.equal(c.status().unconfirmedCloses,1);assert.equal((await c.start(f.request())).ok,false);}finally{mock.restoreAll();await actual?.close();await f.cleanup();}
});
test('read rejection does not conceal an independently held close',async()=>{
 const f=await fixture(),original=fs.open.bind(fs),close=deferred<void>();let actual:Awaited<ReturnType<typeof fs.open>>|undefined;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.iioRealPath,'in_voltage0_raw')){
 actual=h;mock.method(h,'read',async()=>{throw Object.assign(Error('read failed'),{code:'EIO'});});mock.method(h,'close',()=>close.promise);}return h;});
 const c=createMcp3008IioConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);await until(()=>c.status().pendingOperations===1);
 assert.equal(c.status().openHandles,1);assert.equal(c.status().phase,'retiring');assert.equal((await c.start(f.request())).ok,false);close.resolve();await c.stop();assert.equal(c.status().openHandles,0);
 }finally{close.resolve();await c.close();mock.restoreAll();await actual?.close();await f.cleanup();}
});
test('persistent replacement during held read cannot publish retained old bytes',async()=>{
 const f=await fixture(),original=fs.open.bind(fs),held=deferred<void>();let reading=false;
 mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{const h=await original(...args);if(args[0]===join(f.profile.iioRealPath,'in_voltage0_raw')){
 const native=h.read.bind(h);mock.method(h,'read',async(...a:Parameters<typeof h.read>)=>{reading=true;await held.promise;return native(...a);});}return h;});
 const c=createMcp3008IioConnector(f.options);try{const start=c.start(f.request());await until(()=>reading);await fs.rename(join(f.profile.iioRealPath,'in_voltage0_raw'),join(f.profile.iioRealPath,'old'));await fs.writeFile(join(f.profile.iioRealPath,'in_voltage0_raw'),'0\n');
 held.resolve();assert.equal((await start).ok,false);await c.stop();assert.equal(f.readings.length,0);assert.equal(c.status().openHandles,0);}finally{held.resolve();await c.close();await f.cleanup();}
});
test('standing grant expiry narrows the original deadline with no automatic reacquisition',async()=>{
 const f=await fixture();let calls=0;const c=createMcp3008IioConnector({...f.options,authorize:request=>{calls++;return{request,signal:f.grant.signal,expiresAt:performance.now()+70};}});
 try{assert.ok((await c.start(f.request())).ok);await until(()=>c.status().phase==='idle');assert.equal(calls,1);assert.equal(f.readings.length,1);assert.equal(c.status().openHandles,0);}finally{await c.close();await f.cleanup();}
});
test('raw open intention is reserved before synchronous stop reentry and late adoption',async()=>{
 const f=await fixture(),opened=deferred<Awaited<ReturnType<typeof fs.open>>>(),actual=await fs.open(join(f.profile.iioRealPath,'in_voltage0_raw'),constants.O_RDONLY);
 let pendingAtEffect=-1,stopping:Promise<void>|undefined;const c=createMcp3008IioConnector(f.options);
 mock.method(fs,'open',()=>{pendingAtEffect=c.status().pendingOperations;stopping=c.stop();return opened.promise;});
 try{const started=c.start(f.request());await until(()=>pendingAtEffect>=0);assert.equal(pendingAtEffect,1);
 assert.equal(c.status().phase,'retiring');assert.equal(c.status().pendingOperations,1);assert.equal((await c.start(f.request())).ok,false);
 opened.resolve(actual);await stopping;assert.equal((await started).ok,false);assert.equal(c.status().openHandles,0);assert.equal(c.status().pendingOperations,0);
 }finally{opened.resolve(actual);await new Promise(r=>setImmediate(r));mock.restoreAll();await actual.close();await c.close();await f.cleanup();}
});
test('callback-thrown null-prototype/proxy/Symbol values retire without diagnostic coercion',async()=>{
 let traps=0;for(const thrown of [Object.create(null),Symbol('failure'),new Proxy({},{get(){traps++;throw Error('trap');},getOwnPropertyDescriptor(){traps++;throw Error('trap');}})]){
 const f=await fixture(),c=createMcp3008IioConnector({...f.options,onCode:()=>{throw thrown;},onUnavailable:()=>{throw Object.create(null);}});
 try{assert.equal((await c.start(f.request())).ok,false);await c.close();assert.equal(c.status().openHandles,0);assert.equal(c.status().pendingOperations,0);assert.equal(c.status().timers,0);}finally{await c.close();await f.cleanup();}}
 assert.equal(traps,0);
});
test('thirty reads exhaust a session budget without a thirty-first native read',async()=>{
 const f=await fixture();let time=1000;mock.method(performance,'now',()=>time);mock.timers.enable({apis:['setTimeout']});const c=createMcp3008IioConnector(f.options);
 async function settle(predicate:()=>boolean){for(let turn=0;turn<10000;turn++){if(predicate())return;await new Promise(r=>setImmediate(r));}assert.fail('Controlled native completion did not settle');}
 try{assert.ok((await c.start({...f.request(),deadline:time+30000})).ok);for(let i=1;i<30;i++){time+=1000;mock.timers.tick(1000);await settle(()=>f.readings.length===i+1);}
 await settle(()=>c.status().phase==='idle');assert.equal(f.readings.length,30);assert.equal(c.status().reason,'read-budget');time+=1000;mock.timers.tick(1000);assert.equal(f.readings.length,30);assert.equal(c.status().openHandles,0);
 }finally{await c.close();mock.timers.reset();await f.cleanup();}
});

test('read cadence is retained across explicit stops and fresh grants',async()=>{const f=await fixture();const issued:number[]=[];const native=fs.open.bind(fs);mock.method(fs,'open',async(...a:Parameters<typeof fs.open>)=>{const h=await native(...a);const read=h.read.bind(h);mock.method(h,'read',(...args:Parameters<typeof h.read>)=>{issued.push(performance.now());return read(...args);});return h;});let grants=0;const c=createMcp3008IioConnector({...f.options,authorize:r=>{grants++;return{request:r,signal:f.grant.signal,expiresAt:r.deadline};}});try{assert.ok((await c.start(f.request())).ok);await c.stop();assert.ok((await c.start(f.request())).ok);assert.equal(grants,2);assert.equal(issued.length,2);assert.ok(issued[1]!-issued[0]!>=999);assert.equal(f.readings[1]?.decoded.code,512);}finally{await c.close();await f.cleanup();}});
test('read completion time precedes post-read metadata and publication',async()=>{const f=await fixture();const native=fs.open.bind(fs);let completion=0,post=0;mock.method(fs,'open',async(...a:Parameters<typeof fs.open>)=>{const h=await native(...a),read=h.read.bind(h),stat=h.stat.bind(h);mock.method(h,'read',async(...args:Parameters<typeof h.read>)=>{const r=await read(...args);completion=performance.now();return r;});mock.method(h,'stat',async(...args:Parameters<typeof h.stat>)=>{if(completion){await new Promise(r=>setTimeout(r,20));post=performance.now();}return stat(...args);});return h;});const c=createMcp3008IioConnector(f.options);try{assert.ok((await c.start(f.request())).ok);assert.ok(f.readings[0]!.readReceivedAt>=completion);assert.ok(f.readings[0]!.readReceivedAt<post);assert.equal(f.readings[0]!.provenance.readReceivedAt,f.readings[0]!.readReceivedAt);}finally{await c.close();await f.cleanup();}});
test('public software caller delivers boundary and repeated codes with unknown calibration',async()=>{const {runMcp3008IioExample}=await import(new URL('../../../examples/mcp3008-iio-ch0/consumer.mjs',import.meta.url).href);const r=await runMcp3008IioExample();assert.equal(r.status,'pass');assert.deepEqual(r.applied.slice(0,4).map((o:{value:number})=>o.value),[0,512,1023,1023]);assert.equal(r.producerClosed,true);});
test('closure fence rejects changed executed copies and independently pinned receipts',async()=>{const {createMcp3008ClosureFence}=await import(new URL('../../../tools/qa-mcp3008-iio-ch0.mjs',import.meta.url).href);const f=await fixture();try{const artifact=join(f.root,'artifact'),receipt=join(f.root,'receipt.json');await fs.writeFile(artifact,'actual');await fs.writeFile(receipt,'{"status":"pass"}');const fence=createMcp3008ClosureFence({artifacts:{artifact},sdkReceiptPath:receipt});fence.verify();await fs.writeFile(artifact,'mutation');assert.throws(()=>fence.verify());await fs.writeFile(artifact,'actual');fence.verify();await fs.writeFile(receipt,'{"status":"pass","changed":true}');assert.throws(()=>fence.verify());}finally{await f.cleanup();}});
for(const contents of ['', '9'.repeat(65)])test(`ordinary size rejects ${contents.length} bytes before reading`,async()=>{const f=await fixture(contents);let reads=0;const native=fs.open.bind(fs);mock.method(fs,'open',async(...a:Parameters<typeof fs.open>)=>{const h=await native(...a);mock.method(h,'read',async()=>{reads++;throw Error('unexpected read');});return h;});const c=createMcp3008IioConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);await c.stop();assert.equal(reads,0);assert.equal(f.readings.length,0);}finally{await c.close();await f.cleanup();}});
test('native profile denies even invalid input before approval files and timers',async()=>{const f=await fixture();let effects=0;const c=createMcp3008IioConnector({...f.options,profile:{...f.profile,profileId:'linux-mcp3008-iio-ch0-raw-read/1'},authorize:()=>{effects++;throw Error('forbidden');}});mock.method(globalThis,'setTimeout',()=>{effects++;throw Error('forbidden');});for(const method of ['open','lstat','realpath'] as const)mock.method(fs,method,()=>{effects++;throw Error('forbidden');});try{assert.deepEqual(await c.start(null as never),{ok:false,reason:'native-admission-not-qualified'});await c.close();assert.equal(effects,0);assert.equal(c.status().attempts,0);assert.equal(c.status().timers,0);}finally{mock.restoreAll();await f.cleanup();}});
test('stop cancels restart cadence waiting without issuing another read',async()=>{const f=await fixture(),c=createMcp3008IioConnector(f.options);try{assert.ok((await c.start(f.request())).ok);await c.stop();const restart=c.start(f.request());await until(()=>c.status().openHandles===1);assert.equal(c.status().phase,'opening');await c.stop();assert.equal((await restart).ok,false);assert.equal(f.readings.length,1);assert.equal(c.status().timers,0);assert.equal(c.status().openHandles,0);}finally{await c.close();await f.cleanup();}});
test('a complete read followed by changed size cannot publish canonical old bytes',async()=>{const f=await fixture('0\n'),native=fs.open.bind(fs);mock.method(fs,'open',async(...a:Parameters<typeof fs.open>)=>{const h=await native(...a),read=h.read.bind(h);mock.method(h,'read',async(...args:Parameters<typeof h.read>)=>{const r=await read(...args);await fs.appendFile(f.profile.rawRealPath,'1\n');return r;});return h;});const c=createMcp3008IioConnector(f.options);try{assert.equal((await c.start(f.request())).ok,false);await c.stop();assert.equal(f.readings.length,0);}finally{await c.close();await f.cleanup();}});
test('public value is stale during a held next read and cannot regain valid quality',async()=>{const f=await fixture(),native=fs.open.bind(fs),held=deferred<void>();let count=0;mock.method(fs,'open',async(...a:Parameters<typeof fs.open>)=>{const h=await native(...a),read=h.read.bind(h);mock.method(h,'read',async(...args:Parameters<typeof h.read>)=>{if(++count===2)await held.promise;return read(...args);});return h;});const {createDeviceRuntime,parseDeviceDescriptor}=await import('@101/connect');const applied:number[]=[];const device=parseDeviceDescriptor({schemaVersion:1,id:'mcp-stale-test',label:'Raw code',revision:1,adapter:{id:'test:mcp',version:'1'},runtime:{platform:'owned-file'},capabilities:[{id:'in',semantic:'sensor:adc-code',schemaVersion:1,kind:'sample',value:MCP3008_IIO_CODE_SCHEMA,delivery:{mode:'latest',maxHz:1,maxAgeMs:1000},permissions:['subscribe']},{id:'out',semantic:'sensor:adc-code',schemaVersion:1,kind:'property',value:MCP3008_IIO_CODE_SCHEMA,delivery:{mode:'latest',maxHz:1,maxAgeMs:1000},permissions:['write'],ownership:{mode:'observe'}}]});const runtime=createDeviceRuntime({clockDomain:'mcp3008-gateway-monotonic',authorize:()=>({expiresAt:performance.now()+4000,maxAgeMs:1000})}),source=runtime.registerSource({device,capability:'in'}),sink=runtime.registerSink({device,capability:'out',apply(o){applied.push(o.value as number);},release(){}});runtime.setReadiness(source,'available');runtime.setReadiness(sink,'available');const route=runtime.route({from:source,to:sink,principalId:'original',applicationId:'test',sessionId:'one',leaseMs:4000});assert.ok(route.start().ok);const c=createMcp3008IioConnector({...f.options,onCode:r=>{f.readings.push(r);assert.ok(runtime.publish(source,r.decoded.code,{timestamp:r.readReceivedAt,clockDomain:r.receiptClockId,sequence:r.localSequence,quality:'valid',provenance:r.provenance}).ok);}});try{assert.ok((await c.start(f.request())).ok);await until(()=>count===2);await until(()=>performance.now()-f.readings[0]!.readReceivedAt>1002);runtime.flush();assert.deepEqual(applied,[]);assert.equal(runtime.publish(source,512,{timestamp:f.readings[0]!.readReceivedAt,clockDomain:'mcp3008-gateway-monotonic',sequence:2}).ok,false);const stop=c.stop();held.resolve();await stop;assert.equal(f.readings.length,1);}finally{held.resolve();await c.close();runtime.close();await f.cleanup();}});
test('producer finish returns zero pending ownership timers and waiters after natural close',async()=>{const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'101-mcp3008-status-')));const {ownedProducer}=await import(new URL('../../../examples/mcp3008-iio-ch0/consumer.mjs',import.meta.url).href);const p=ownedProducer(root);try{await p.enrollment;await p.finish();assert.deepEqual(p.status(),{pendingOperations:0,timers:0,waiters:0,childClosed:true});}finally{await p.abort();await fs.rm(root,{recursive:true,force:true});}});
