import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from './index.ts';
import { createWatchCompanionResources } from './watch-companion.ts';
import { watchCompanionReportDevice } from '@101/device-model';
import type { WatchCompanionBridge, WatchCompanionEnrollment, WatchCompanionReportEvent, WatchCompanionResourceRequest } from './watch-companion.ts';
const HEX='3101e11087d61200cdcccc3dcdcc4cbe9a99993edf4f6d3f0000003f0000a0bf0000003e0000f142000035c20000004100002a4201';
function harness(platform:'watchos'|'wearos'='watchos') {
 let now=0, epoch=0, releases=0, starts=0, stops=0, authorize=true;
 const delivered:unknown[]=[];let listener:((event:WatchCompanionReportEvent)=>void)|undefined,loss:(()=>void)|undefined;
 let enrollment:WatchCompanionEnrollment;let issuer=new AbortController(),owner=new AbortController();
 let beforeStart:(()=>void)|undefined,hold:Promise<void>|undefined,clock:(()=>void)|undefined;
 const bridge:WatchCompanionBridge={async enroll(){issuer=new AbortController();enrollment=Object.freeze({platform,epoch:++epoch,signal:issuer.signal,
  snapshot:Object.freeze({platform,companionPaired:true,appInstalled:true,reachable:true,nearby:platform==='wearos'})});return enrollment;},
  async start(selected,onReport,onLoss,signal){assert.equal(selected,enrollment);assert.equal(signal.aborted,false);starts++;listener=onReport;loss=onLoss;beforeStart?.();await hold;},
  async stop(selected){assert.equal(selected,enrollment);stops++;issuer.abort();}};
 const runtime=createDeviceRuntime({now:()=>now,authorize:request=>{assert.equal(request.sourceOperation,'subscribe');assert.equal(request.sinkOperation,'write');return authorize?{expiresAt:10000,maxAgeMs:250,maxHz:30}:undefined;}});
 const base=watchCompanionReportDevice('watch:sink',platform),sink=runtime.registerSink({device:{...base,capabilities:base.capabilities.map(value=>({...value,permissions:['write'],ownership:{mode:'exclusive'}}))},capability:'report',
  apply(observation){delivered.push(observation);},release(){releases++;}});runtime.setReadiness(sink,'available');
 let approval:(request:WatchCompanionResourceRequest)=>unknown=request=>({request,expiresAt:10000,signal:owner.signal});
 const controller=createWatchCompanionResources({runtime,bridge,ownerId:'phone-owner',now:()=>{clock?.();return now;},approve:request=>approval(request) as never});
 function emit(sequence=4321,emission=1234567,selected=enrollment) {const bytes=Uint8Array.from(Buffer.from(HEX,'hex'));const view=new DataView(bytes.buffer);view.setUint16(2,sequence,true);view.setUint32(4,emission,true);listener?.({enrollment:selected,data:Buffer.from(bytes).toString('base64')});}
 return {runtime,bridge,controller,sink,delivered,get enrollment(){return enrollment;},get issuer(){return issuer;},get owner(){return owner;},emit,loss:()=>loss?.(),
  setNow(value:number){now=value;},setClock(value:(()=>void)|undefined){clock=value;},setStart(value:()=>void){beforeStart=value;},setHold(value:Promise<void>){hold=value;},setApproval(value:typeof approval){approval=value;},
  setAuthorize(value:boolean){authorize=value;},freshOwner(){owner=new AbortController();},releases:()=>releases,starts:()=>starts,stops:()=>stops,
  route(source:{id:string}) {return runtime.route({from:source,to:sink,principalId:'sink-owner',applicationId:'report',sessionId:'software',sourceOperation:'subscribe',leaseMs:1000});},
  close(){controller.close();runtime.close();}};
}
test('two genuine producer platforms enter ordinary separately approved runtime routes',async()=>{
 for(const platform of ['watchos','wearos'] as const){const h=harness(platform);try{
  const opened=await h.controller.start();assert.equal(opened.ok,true);if(!opened.ok)return;
  const route=h.route(opened.value);assert.equal(route.start().ok,true);h.emit();h.runtime.flush();assert.equal(h.delivered.length,1);
  const observation=h.delivered[0] as {timestamp:number;provenance:{captureTimeKnown:boolean};value:{physicalValidity:string}};
  assert.equal(observation.timestamp,0);assert.equal(observation.provenance.captureTimeKnown,false);assert.equal(observation.value.physicalValidity,'unspecified');
  h.owner.abort();assert.equal(route.status().state,'closed');assert.equal(h.releases(),1);h.setNow(50);h.emit(4322);h.runtime.flush();assert.equal(h.delivered.length,1);
 }finally{h.close();}}
});
test('source denial does not start capture and sink denial does not become source permission',async()=>{
 const denied=harness();denied.setApproval(()=>undefined);assert.equal((await denied.controller.start()).ok,false);assert.equal(denied.starts(),0);denied.close();
 const h=harness();try{h.setAuthorize(false);const opened=await h.controller.start();assert.equal(opened.ok,true);if(!opened.ok)return;assert.equal(h.route(opened.value).start().ok,false);h.emit();h.runtime.flush();assert.equal(h.delivered.length,0);}finally{h.close();}
});
test('copied enrollment cannot emit and issuer loss releases the actual active route',async()=>{
 const h=harness();try{const opened=await h.controller.start();assert.equal(opened.ok,true);if(!opened.ok)return;const route=h.route(opened.value);route.start();
 h.emit(4321,1234567,{...h.enrollment});h.runtime.flush();assert.equal(h.delivered.length,0);h.emit();h.runtime.flush();assert.equal(h.delivered.length,1);
 h.issuer.abort();assert.equal(route.status().state,'closed');assert.equal(h.releases(),1);}finally{h.close();}
});
test('duplicate/backward sequence and emission rollback retire rather than mint freshness',async()=>{
 for(const [sequence,emission] of [[4321,1234567],[4320,1234568],[4322,1234566]]){const h=harness();try{
 const opened=await h.controller.start();if(!opened.ok)throw Error('open');const route=h.route(opened.value);route.start();h.emit();h.setNow(40);h.emit(sequence,emission);
 assert.equal(h.controller.status().state,'idle');assert.equal(route.status().state,'closed');}finally{h.close();}}
});
test('u16 wrap is accepted inside an enrolled epoch while latest coalescing stays bounded',async()=>{
 const h=harness();try{const opened=await h.controller.start();if(!opened.ok)throw Error('open');const route=h.route(opened.value);route.start();h.emit(65535);h.runtime.flush();
 h.setNow(1);h.emit(0,1234568);h.emit(1,1234569);h.runtime.flush();assert.equal(h.delivered.length,1);h.setNow(40);h.controller.sweep();h.runtime.flush();assert.equal(h.delivered.length,2);
 assert.equal((h.delivered[1] as {value:{sequence:number}}).value.sequence,1);}finally{h.close();}
});
test('loss/inactivity requires fresh enrollment and old callbacks cannot reactivate',async()=>{
 const h=harness();try{const opened=await h.controller.start();if(!opened.ok)throw Error('open');const old=h.enrollment;const route=h.route(opened.value);route.start();h.emit();h.runtime.flush();
 h.setNow(250);h.controller.sweep();assert.equal(route.status().state,'closed');await new Promise<void>(r=>setImmediate(r));h.freshOwner();const second=await h.controller.start();assert.equal(second.ok,true);
 h.emit(4322,1234568,old);h.runtime.flush();assert.equal(h.delivered.length,1);h.loss();assert.equal(h.controller.status().state,'idle');}finally{h.close();}
});
test('unresolved raw start stays reserved after stop and helper replacement until actual return',async()=>{
 const h=harness();let release!:()=>void;h.setHold(new Promise<void>(r=>{release=r;}));const pending=h.controller.start();await new Promise<void>(r=>setImmediate(r));
 h.controller.stop();assert.equal(h.controller.status().pendingNativeOperations,1);
 const other=createWatchCompanionResources({runtime:h.runtime,bridge:h.bridge,ownerId:'other',now:()=>0,approve:request=>({request,expiresAt:10000,signal:new AbortController().signal})});
 assert.deepEqual(await other.start(),{ok:false,reason:'busy'});release();assert.equal((await pending).ok,false);assert.equal(h.controller.status().pendingNativeOperations,0);assert.equal(h.stops(),1);other.close();h.close();
});
test('synchronous native and final clock reentry cannot activate or return a late source',async()=>{
 const h=harness();h.setStart(()=>h.controller.stop());assert.equal((await h.controller.start()).ok,false);assert.equal(h.controller.status().state,'idle');h.close();
 const clock=harness();clock.setClock(()=>clock.owner.abort());assert.equal((await clock.controller.start()).ok,false);assert.equal(clock.starts(),0);clock.close();
});
test('signal-only grants reject accessors/callback-only/spoofed aborted authority',async()=>{
 for(const grant of [(request:WatchCompanionResourceRequest)=>({request,expiresAt:1000,isCurrent:()=>true}),(request:WatchCompanionResourceRequest)=>({request,expiresAt:1000,signal:{aborted:false}}),()=>Object.defineProperty({expiresAt:1000,signal:new AbortController().signal},'request',{get(){throw Error('getter');}})]) {
 const h=harness();h.setApproval(grant);assert.equal((await h.controller.start()).ok,false);assert.equal(h.starts(),0);h.close();}
 const h=harness();const owner=h.owner;Object.defineProperty(owner.signal,'aborted',{value:false});owner.abort();assert.equal((await h.controller.start()).ok,false);assert.equal(h.starts(),0);h.close();
});

test('late raw enrollment is retired after cancellation without exposing a source',async()=>{
 let complete!:(value:WatchCompanionEnrollment)=>void,stops=0;const signal=new AbortController();
 const enrollment:WatchCompanionEnrollment=Object.freeze({platform:'watchos',epoch:1,signal:signal.signal,snapshot:Object.freeze({platform:'watchos',companionPaired:true,appInstalled:true,reachable:true,nearby:false})});
 const bridge:WatchCompanionBridge={enroll:()=>new Promise(resolve=>{complete=resolve;}),async start(){throw Error('must not start');},async stop(value){assert.equal(value,enrollment);stops++;}};
 const runtime=createDeviceRuntime({now:()=>0,authorize:()=>undefined});const controller=createWatchCompanionResources({runtime,bridge,ownerId:'owner',now:()=>0,approve:()=>undefined});
 const opening=controller.start();controller.close();complete(enrollment);assert.equal((await opening).ok,false);assert.equal(stops,1);assert.equal(controller.status().pendingNativeOperations,0);runtime.close();
});
test('owner expiry and invalid clocks retire real route with no late pixel/report effect',async()=>{
 for(const invalid of [false,true]){const h=harness();try{h.setApproval(request=>({request,expiresAt:100,signal:h.owner.signal}));const opened=await h.controller.start();if(!opened.ok)throw Error('open');
 const route=h.route(opened.value);route.start();h.emit();h.runtime.flush();h.setNow(invalid?NaN:100);h.controller.sweep();assert.equal(route.status().state,'closed');assert.equal(h.releases(),1);
 }finally{h.close();}}
});
test('report arrival timestamp is retained through latest coalescing',async()=>{
 const h=harness();try{const opened=await h.controller.start();if(!opened.ok)throw Error('open');h.route(opened.value).start();h.emit();h.runtime.flush();h.setNow(1);h.emit(4322,1234568);
 h.setNow(40);h.controller.sweep();h.runtime.flush();assert.equal((h.delivered[1] as {timestamp:number}).timestamp,1);}finally{h.close();}
});

test('two enrollment slots include unresolved native work across controllers on the same runtime',async()=>{
 const runtime=createDeviceRuntime({now:()=>0,authorize:()=>undefined});let epoch=0;
 function create(hold?:Promise<void>){const signal=new AbortController();const enrollment:WatchCompanionEnrollment=Object.freeze({platform:'watchos',epoch:++epoch,signal:signal.signal,snapshot:Object.freeze({platform:'watchos',companionPaired:true,appInstalled:true,reachable:true,nearby:false})});
 const bridge:WatchCompanionBridge={async enroll(){return enrollment;},async start(){},async stop(){await hold;}};
 return createWatchCompanionResources({runtime,bridge,ownerId:'owner',now:()=>0,approve:request=>({request,expiresAt:10000,signal:new AbortController().signal})});}
 let finish!:()=>void;const held=new Promise<void>(resolve=>{finish=resolve;});
 const first=create(held),second=create(),third=create();try{
 assert.equal((await first.start()).ok,true);assert.equal((await second.start()).ok,true);assert.deepEqual(await third.start(),{ok:false,reason:'capacity'});
 first.stop();assert.deepEqual(await third.start(),{ok:false,reason:'capacity'});finish();await new Promise<void>(r=>setImmediate(r));assert.equal((await third.start()).ok,true);
 }finally{finish();first.close();second.close();third.close();runtime.close();}
});
