import test from 'node:test';
import assert from 'node:assert/strict';
import {createHeartRateSoftwareGateway} from './heart-rate-software.ts';

test('native admission denies before reading provider or authority',()=>{
 let calls=0;
 for(const mode of ['browser-native','native-ios','native-android','native-macos','native-windows','native-linux','unknown']){
  const options={mode,get selectedPort(){calls++;throw Error();}};
  assert.throws(()=>createHeartRateSoftwareGateway(options as never),/unsupported/);
 }
 assert.equal(calls,0);
});
import type {HeartRateNotificationContext,HeartRateNotificationRequest,HeartRateNotificationGrant} from './heart-rate-software.ts';
const {createDeviceRuntime}=await import(process.env.HEART_RATE_SDK_ENTRY??new URL('../../device-runtime/src/index.ts',import.meta.url).href);
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return{promise,resolve};}
const turn=()=>new Promise<void>(r=>setImmediate(r));
function fixture(change:Record<string,unknown>={}){
 let at=1000,open=0,stop=0,close=0,ctx:HeartRateNotificationContext|undefined;
 const owner=new AbortController(),caller=new AbortController(),grant=new AbortController();
 const runtime=createDeviceRuntime({now:()=>at,clockDomain:'heart-receipt',authorize:()=>({expiresAt:9000,maxAgeMs:1000,maxHz:20})});
 const port={kind:'software-notification' as const,providerId:'selected-fixture',open(c:HeartRateNotificationContext){open++;ctx=c;return Promise.resolve('ready' as const)},stop(){stop++},close(){close++;return Promise.resolve()},whenSettled(){return Promise.resolve()}};
 const authorize=(request:HeartRateNotificationRequest)=>({request,signal:grant.signal,expiresAt:request.deadline});
 const gateway=createHeartRateSoftwareGateway({mode:'software-notification',runtime,ownerSignal:owner.signal,scope:{principalId:'owner',applicationId:'example',sessionId:'session'},selectedPort:port,now:()=>at,authorizeNotifications:authorize,...change} as never);
 const start=()=>gateway.start({purpose:'reported-heart-rate-fixture',signal:caller.signal,deadline:3000});
 return{runtime,gateway,owner,caller,grant,port,start,get context(){return ctx!},get calls(){return{open,stop,close}},setNow(v:number){at=v}};
}
test('original private grant, independently typed publication and synchronous withdrawal',async()=>{
 const f=fixture();const a=await f.start();assert.equal(a.ok,true);if(!a.ok)throw Error();
 const values:number[]=[];const sink=f.runtime.registerSink({device:{...a.value.device,id:'fixture-destination',capabilities:a.value.device.capabilities.map((c:object)=>({...c,permissions:['write']}))},capability:'heart-rate',apply:(s:{value:number})=>{values.push(s.value)},release(){}});
 f.runtime.setReadiness(sink,'available',9000);const route=f.runtime.route({from:a.value.source,to:sink,principalId:'owner',applicationId:'example',sessionId:'session'});assert.equal(route.start().ok,true);
 f.context.onValue(Uint8Array.of(14,90,0,0));f.runtime.flush();assert.deepEqual(values,[90]);
 f.gateway.stop();assert.equal(route.status().state,'closed');f.context.onValue(Uint8Array.of(6,91));f.runtime.flush();assert.deepEqual(values,[90]);await f.gateway.close();await route.whenSettled();f.runtime.close();assert.deepEqual(f.calls,{open:1,stop:1,close:1});assert.equal(f.gateway.snapshot().rawPending,0);assert.equal(f.gateway.snapshot().listeners,0);
});
for(const fault of ['copied-request','accessor','expired','overlong','revoked'])test(`private ${fault} denies before port effects`,async()=>{
 let reads=0;
 const f=fixture({authorizeNotifications:(request:HeartRateNotificationRequest)=>{
  if(fault==='accessor')return{get request(){reads++;return request},signal:new AbortController().signal,expiresAt:3000};
  const signal=new AbortController();if(fault==='revoked')signal.abort();return{request:fault==='copied-request'?{...request}:request,signal:signal.signal,expiresAt:fault==='expired'?999:fault==='overlong'?3001:3000};
 }});assert.equal((await f.start()).ok,false);await f.gateway.close();f.runtime.close();assert.equal(f.calls.open,0);assert.equal(reads,0);
});
for(const revoke of ['owner','caller','grant'] as const)test(`${revoke} abort fences source and joins port`,async()=>{
 const f=fixture();assert.equal((await f.start()).ok,true);f[revoke].abort();assert.equal(f.gateway.snapshot().activeSources,0);f.context.onValue(Uint8Array.of(6,90));await f.gateway.close();f.runtime.close();assert.equal(f.gateway.snapshot().listeners,0);
});
test('held authorizer reservation survives stop and late grant cannot open',async()=>{
 const held=deferred<HeartRateNotificationGrant|undefined>();let request:HeartRateNotificationRequest|undefined;
 const f=fixture({authorizeNotifications:(r:HeartRateNotificationRequest)=>{request=r;return held.promise}});
 const starting=f.start();await turn();assert.equal(f.gateway.snapshot().rawPending,1);f.gateway.stop();assert.equal((await starting).ok,false);assert.equal((await f.start()).ok,false);
 const closing=f.gateway.close();let done=false;void closing.then(()=>{done=true});await turn();assert.equal(done,false);held.resolve({request:request!,signal:f.grant.signal,expiresAt:3000});await closing;assert.equal(f.calls.open,0);f.runtime.close();
});
test('held open and actual close keep ownership after logical stop',async()=>{
 const opening=deferred<'ready'>(),closing=deferred<void>();const f=fixture();f.port.open=()=>opening.promise;f.port.close=()=>closing.promise;
 // A new fixture captures modified methods at construction.
 const g=fixture({selectedPort:f.port});const pending=g.start();await turn();g.gateway.stop();assert.equal((await pending).ok,false);let done=false;const close=g.gateway.close();void close.then(()=>{done=true});await turn();assert.equal(done,false);closing.resolve();await turn();assert.equal(done,false);opening.resolve('ready');await close;assert.equal(g.gateway.snapshot().rawPending,0);g.runtime.close();await f.gateway.close();f.runtime.close();
});
test('reentrant authorizer observes reserved admission and frozen exact scope',async()=>{
 let reentry:Promise<unknown>|undefined;
 const f=fixture({authorizeNotifications:(request:HeartRateNotificationRequest)=>{assert.ok(Object.isFrozen(request)&&Object.isFrozen(request.profile)&&Object.isFrozen(request.resource)&&Object.isFrozen(request.budgets));reentry=f.start();f.gateway.stop();return{request,signal:f.grant.signal,expiresAt:3000}}});
 assert.equal((await f.start()).ok,false);assert.deepEqual(await reentry,{ok:false,reason:'busy'});await f.gateway.close();assert.equal(f.calls.open,0);f.runtime.close();
});
test('contact support toggle, malformed value, backwards receipt clock, budgets retire',async()=>{
 for(const why of ['contact','malformed','clock','quota']){
  const f=fixture();assert.equal((await f.start()).ok,true);f.context.onValue(Uint8Array.of(6,90));
  if(why==='contact')f.context.onValue(Uint8Array.of(0,90));
  if(why==='malformed')f.context.onValue(Uint8Array.of(16,90));
  if(why==='clock'){f.setNow(999);f.context.onValue(Uint8Array.of(6,90));}
  if(why==='quota')for(let i=0;i<5;i++)f.context.onValue(Uint8Array.of(6,90));
  assert.equal(f.gateway.snapshot().activeSources,0);await f.gateway.close();f.runtime.close();
 }
});
test('expiry and stale port callback cannot revive a generation',async()=>{
 const f=fixture();assert.equal((await f.start()).ok,true);f.setNow(3000);f.gateway.sweep();assert.equal(f.gateway.snapshot().activeSources,0);f.context.onValue(Uint8Array.of(6,90));await f.gateway.close();f.runtime.close();
});
test('timer budgets have one expiry plus opening; ready removes opening timer',async()=>{
 const f=fixture();const result=await f.start();assert.equal(result.ok,true);assert.equal(f.gateway.snapshot().timers,1);await f.gateway.close();f.runtime.close();
});
test('raw stop is reserved before a reentrant cleanup callout',async()=>{
 const f=fixture();let rawAtStop=-1;
 f.port.stop=()=>{rawAtStop=g.gateway.snapshot().rawPending;g.gateway.close();};const g=fixture({selectedPort:f.port});assert.equal((await g.start()).ok,true);g.gateway.stop();assert.ok(rawAtStop>=1,'raw stop issuance must already own a token');await g.gateway.close();g.runtime.close();await f.gateway.close();f.runtime.close();
});
for(const kind of ['pending-promise','fulfilled-promise','primitive'])test(`invalid stop ${kind} retains ownership after settlement`,async()=>{
 const held=deferred<void>(),f=fixture();
 f.port.stop=(()=>kind==='pending-promise'?held.promise:kind==='fulfilled-promise'?Promise.resolve():17) as ()=>void;
 const g=fixture({selectedPort:f.port});const started=await g.start();assert.equal(started.ok,true);if(!started.ok)throw Error();
 const sink=g.runtime.registerSink({device:{...started.value.device,id:'invalid-stop-destination',capabilities:started.value.device.capabilities.map((c:object)=>({...c,permissions:['write']}))},capability:'heart-rate',apply(){},release(){}});
 g.runtime.setReadiness(sink,'available',9000);const route=g.runtime.route({from:started.value.source,to:sink,principalId:'owner',applicationId:'example',sessionId:'session'});assert.equal(route.start().ok,true);
 g.gateway.stop();let composedDone=false;const composed=Promise.all([g.gateway.close(),route.whenSettled()]);void composed.then(()=>{composedDone=true});
 await turn();if(kind==='pending-promise'){assert.ok(g.gateway.snapshot().rawPending>=2,'returned Promise plus permanent uncertain work');held.resolve();await turn();}
 assert.equal(g.gateway.snapshot().rawPending,1,'returned work settles while permanent contract uncertainty remains');assert.equal(composedDone,false);assert.equal(g.gateway.snapshot().cleanupFailed,true);
 const replacement=fixture({selectedPort:f.port});assert.equal((await replacement.start()).ok,false);assert.equal(f.calls.open,1,'same port must remain owned');
 await replacement.gateway.close();replacement.runtime.close();g.runtime.close();await f.gateway.close();f.runtime.close();
});
for(const alias of ['caller-owner','grant-owner','grant-caller'])test(`independent signal admission rejects ${alias} before port effects`,async()=>{
 const owner=new AbortController(),caller=alias==='caller-owner'?owner:new AbortController(),grant=alias==='grant-owner'?owner:alias==='grant-caller'?caller:new AbortController();let authorized=0;
 const f=fixture({ownerSignal:owner.signal,authorizeNotifications:(request:HeartRateNotificationRequest)=>{authorized++;return{request,signal:grant.signal,expiresAt:request.deadline}}});
 const result=await f.gateway.start({purpose:'reported-heart-rate-fixture',signal:caller.signal,deadline:3000});await f.gateway.close();f.runtime.close();
 assert.equal(result.ok,false);assert.equal(authorized,alias==='caller-owner'?0:1);assert.deepEqual(f.calls,{open:0,stop:0,close:0});
});
