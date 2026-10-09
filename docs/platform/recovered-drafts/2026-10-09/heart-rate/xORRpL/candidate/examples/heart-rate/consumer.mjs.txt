import assert from 'node:assert/strict';
import {createDeviceRuntime} from '@101/connect';
import {createHeartRateSoftwareGateway} from '../../packages/hub-server/src/heart-rate-software.ts';
import {createHeartRateSoftwarePort} from './port.mjs';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
/** Caller owns public Connection settlement. Gateway owns private port/process settlement only. */
export async function runHeartRateSoftwareExample({python,pythonSha256,selectedSource,selectedSourceSha256,pycachePrefix,scenario='normal'}){
 const scope=Object.freeze({principalId:'fixture-owner',applicationId:'heart-rate-fixture',sessionId:'fixture-session'}),purpose='reported-heart-rate-fixture';
 const owner=new AbortController(),caller=new AbortController(),grant=new AbortController();const now=()=>performance.now();
 let source,sink,route,fenced=false,closing,listenerRecord,privateCalls=0,publicCalls=0,heldResolve,heldApply;
 const observed=[];if(scenario==='held-apply')heldApply=new Promise(resolve=>{heldResolve=resolve});
 const runtime=createDeviceRuntime({now,clockDomain:'heart-rate-host-receipt',authorize:request=>{
  publicCalls++;if(scenario==='public-denied'||fenced||purpose!=='reported-heart-rate-fixture'||request.principalId!==scope.principalId||request.applicationId!==scope.applicationId||request.sessionId!==scope.sessionId||request.source.registrationId!==source?.id||request.sink.registrationId!==sink?.id||request.source.capabilityId!=='heart-rate'||request.sink.capabilityId!=='heart-rate')return;
  return{expiresAt:now()+5000,maxHz:20,maxAgeMs:1000};
 }});
 const software=createHeartRateSoftwarePort({python,pythonSha256,selectedSource,selectedSourceSha256,pycachePrefix});
 const gateway=createHeartRateSoftwareGateway({mode:'software-notification',runtime,ownerSignal:owner.signal,scope,selectedPort:software.port,now,authorizeNotifications:request=>{
  privateCalls++;assert.equal(request.purpose,purpose);assert.deepEqual({principalId:request.principalId,applicationId:request.applicationId,sessionId:request.sessionId},scope);assert.equal(request.resource.capabilityId,'heart-rate');assert.equal(request.profile.characteristicUUID,'00002a37-0000-1000-8000-00805f9b34fb');assert.ok(Object.isFrozen(request)&&Object.isFrozen(request.profile)&&Object.isFrozen(request.budgets)&&Object.isFrozen(request.resource));
  if(scenario==='private-denied')return;return{request,signal:grant.signal,expiresAt:request.deadline};
 }});
 function close(){
  if(closing)return closing;let finish,failed;closing=new Promise((resolve,reject)=>{finish=resolve;failed=reject});fenced=true;
  if(listenerRecord){listenerRecord.retired=true;listenerRecord.dispose?.();}route?.stop('fixture-consumer-close');gateway.stop();
  const privateCleanup=gateway.close();const publicCleanup=route?.whenSettled?.();
  Promise.all([privateCleanup,publicCleanup??Promise.resolve()]).then(()=>{if(sink)runtime.unregister(sink);runtime.close();finish();},failed);return closing;
 }
 let privateSettledBeforeHeldApply=false,registrationLossHandled=false;
 try{
  const active=await gateway.start({purpose,signal:caller.signal,deadline:now()+10000});
  if(scenario==='private-denied'){assert.equal(active.ok,false);assert.equal(software.status().childRunning,false);await close();return{status:'pass',scenario,privateCalls,publicCalls,fixture:true,producerNotLaunched:true,producerClosed:true,observedCount:0,resources:['heart-rate'],feedback:'absent',vendorSensors:'absent',nativeAdmission:'denied-all-hosts',physical:false,fullW05Acceptance:false,supportRows:[]};}
  assert.equal(active.ok,true);if(!active.ok)throw Error('private capture not ready');source=active.value.source;
  assert.equal(active.value.device.capabilities.length,1);assert.equal(active.value.device.capabilities[0].value.unit,'bpm');
  const destination={...active.value.device,id:'fixture-heart-rate-destination',label:'Synthetic fixture destination',capabilities:active.value.device.capabilities.map(c=>({...c,kind:'property',permissions:['write']}))};
  sink=runtime.registerSink({device:destination,capability:'heart-rate',apply:observation=>{
   if(fenced)return;assert.equal(observation.clockDomain,runtime.clockDomain);assert.equal(observation.provenance.captureTimeKnown,false);assert.equal(observation.provenance.measurementAgeKnown,false);assert.equal(observation.provenance.fixture,true);observed.push(observation.value);return heldApply;
  },release(){}});assert.equal(runtime.setReadiness(sink,'available').ok,true);
  route=runtime.route({from:source,to:sink,...scope});assert.equal(typeof route.whenSettled,'function','Actual public settlement API required');const started=route.start();
  if(scenario==='public-denied'){assert.equal(started.ok,false);await software.tick();runtime.flush();assert.deepEqual(observed,[]);await close();}
  else{
   assert.equal(started.ok,true);
   listenerRecord={retired:false,dispose:undefined};const reserved=listenerRecord;
   if(scenario==='close-registration-race')route.stop('synchronous-loss-before-registration');
   const dispose=route.onClose(()=>{reserved.retired=true;void close();});reserved.dispose=dispose;
   if(reserved.retired||fenced){dispose();await close();registrationLossHandled=true;assert.deepEqual(observed,[]);}
   else{
    const count=scenario==='normal'?11:1;
    for(let i=0;i<count;i++){if(i)await sleep(60);await software.tick();runtime.flush();await turn();}
    assert.deepEqual(observed,Array.from({length:count},(_,i)=>90+i));
    if(scenario==='caller-revoke')caller.abort();if(scenario==='grant-revoke')grant.abort();if(scenario==='owner-revoke')owner.abort();if(scenario==='route-revoke')runtime.revoke(route);
    if(scenario==='held-apply'){
     const composed=close();let done=false;void composed.then(()=>{done=true});await gateway.close();await turn();assert.equal(software.status().childRunning,false);assert.equal(route.status().state,'closed');assert.equal(done,false,'composed close must await actual sink.apply');privateSettledBeforeHeldApply=true;heldResolve();await composed;
    }else await close();
   }
  }
  await close();assert.equal(close(),closing);assert.equal(gateway.snapshot().rawPending,0);assert.equal(gateway.snapshot().listeners,0);assert.equal(gateway.snapshot().timers,0);assert.deepEqual(software.status(),{childRunning:false,waiters:0,listeners:0,pendingWrites:0,frames:scenario==='normal'?11:registrationLossHandled?0:1,fenced:true});
  const producer=software.evidence();assert.deepEqual(producer.producerExit,{code:0,signal:null});assert.deepEqual(producer.producerClose,producer.producerExit);assert.ok(producer.runtimeBefore&&producer.runtimeAfter);
  return{status:'pass',scenario,fixture:true,physical:false,supportRows:[],fullW05Acceptance:false,feedback:'absent',vendorSensors:'absent',resources:['heart-rate'],nativeAdmission:'denied-all-hosts',captureTimeKnown:false,measurementAgeKnown:false,producerClosed:true,producer,privateCalls,publicCalls,syntheticHeartRateBpm:observed,privateSettledBeforeHeldApply,registrationLossHandled,lifecycle:software.status()};
 }finally{if(heldResolve)heldResolve();await close();}
}
