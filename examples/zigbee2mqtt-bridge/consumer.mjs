import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createZigbee2MqttBridge } from '../../packages/hub-server/src/zigbee2mqtt-bridge.ts';
const profile=Object.freeze({id:'example:zigbee2mqtt-switch',revision:1,ieeeAddress:'0x0000000000000007',model:'WXKG01LM',baseTopic:'zigbee2mqtt'});
const scope=Object.freeze({principalId:'owned-operator',applicationId:'zigbee-reported-switch-example',sessionId:'software-session'});
function producer(endpoint){
  const child=fork(new URL('./producer.mjs',import.meta.url),[endpoint],{stdio:['ignore','ignore','pipe','ipc']});let stderr='',next=0,closing;
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4096);});
  const exit=new Promise((res,rej)=>{child.once('error',rej);child.once('exit',(code,signal)=>res({code,signal}));});
  const closed=new Promise(res=>child.once('close',res));void exit.catch(()=>{});
  function response(id,message){return new Promise((res,rej)=>{let done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);child.off('error',onError);if(error)rej(error);else res(value);};
    const onMessage=m=>{if(id===0&&m?.kind==='ready'||m?.id===id)finish(m.kind==='error'?new Error(m.reason):undefined,m);};
    const onExit=()=>finish(new Error('Producer premature exit '+stderr)),onError=e=>finish(e);
    const timer=setTimeout(()=>finish(new Error('Producer response timeout '+stderr)),3000);child.on('message',onMessage);child.once('exit',onExit);child.once('error',onError);if(message)child.send(message,e=>{if(e)finish(e);});});}
  const ready=response(0);
  return {child,ready,request(kind){return response(++next,{kind,id:next});},close(){return closing??=(async()=>{if(child.connected)child.send({kind:'close',id:++next});let timer,escalation;
    try{const result=await Promise.race([Promise.allSettled([exit,closed]),new Promise((_,rej)=>{timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');escalation=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1000);}rej(new Error('Producer native close unconfirmed '+stderr));},3000);})]);
      const errors=result.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Producer close failed');const outcome=result[0].value;
      assert.equal(outcome.code,0,stderr);assert.equal(outcome.signal,null,stderr);
    }finally{if(timer)clearTimeout(timer);await Promise.allSettled([exit,closed]);if(escalation)clearTimeout(escalation);}
  })();}};
}
export async function runZigbee2MqttBridgeConsumer(endpoint){
  const owner=new AbortController(),grant=new AbortController(),battery=[],actions=[],wire=[],readings=[],publishResults=[],unavailable=[];
  let batteryAllowed=false,eventAllowed=false,batteryRoute,eventRoute,p;
  const batteryValue={type:'scalar',unit:'%',min:0,max:100},actionValue={type:'enum',values:['single','double','triple','quadruple','hold','release','many']};
  const capability=(id,kind,value,semantic,sink,reliable)=>({id,kind,value,semantic,schemaVersion:1,permissions:[sink?'write':'subscribe'],delivery:reliable?{mode:'reliable',maxAgeMs:1000}:{mode:'latest',maxAgeMs:5000,maxHz:120},...(sink?{ownership:{mode:'observe'}}:{})});
  const device=parseDeviceDescriptor({schemaVersion:1,id:'reported-software-switch',label:'Software bridge reported switch',revision:1,adapter:{id:'example:zigbee2mqtt-read-only',version:'1.0.0'},runtime:{platform:'node-loopback-software'},capabilities:[
    capability('battery','property',batteryValue,'example:zigbee2mqtt/reported-battery',false,false),capability('battery-view','property',batteryValue,'example:zigbee2mqtt/reported-battery',true,false),
    capability('action','event',actionValue,'example:zigbee2mqtt/reported-action',false,true),capability('action-input','event',actionValue,'example:zigbee2mqtt/reported-action',true,true)]});
  const runtime=createDeviceRuntime({clockDomain:'zigbee-gateway-monotonic',now:()=>performance.now(),authorize:r=>{
    if(r.principalId!==scope.principalId||r.applicationId!==scope.applicationId||r.sessionId!==scope.sessionId||r.sourceOperation!=='subscribe'||r.sinkOperation!=='write')return;
    const b=r.source.registrationId===batterySource.id&&r.sink.registrationId===batterySink.id&&batteryAllowed;
    const a=r.source.registrationId===actionSource.id&&r.sink.registrationId===actionSink.id&&eventAllowed;
    if(b||a)return{expiresAt:performance.now()+10000,maxAgeMs:a?1000:5000,maxHz:120};
  }});
  const batterySource=runtime.registerSource({device,capability:'battery'}),actionSource=runtime.registerSource({device,capability:'action'});
  const batterySink=runtime.registerSink({device,capability:'battery-view',apply:(observation,context)=>{if(context.isCurrent()&&!context.signal.aborted)battery.push(observation);},release(){}});
  const actionSink=runtime.registerSink({device,capability:'action-input',apply:(observation,context)=>{if(context.isCurrent()&&!context.signal.aborted)actions.push(observation);},release(){}});
  for(const sink of [batterySink,actionSink])runtime.setReadiness(sink,'available');
  const c=createZigbee2MqttBridge({endpoint,profile,ownerSignal:owner.signal,scope,authorize:r=>({request:r,signal:grant.signal,expiresAt:performance.now()+30000}),onReading:r=>{
    readings.push(r);const provenance={profileId:profile.id,profileRevision:profile.revision,ieeeAddress:profile.ieeeAddress,captureTimeKnown:false,originClockMapped:false,sourceEventSequenceKnown:false,cachedFieldsPossible:true,
      topic:'zigbee2mqtt/'+profile.ieeeAddress,retained:r.decoded.retained,receivedQos:r.receivedQos,mqttDup:r.mqttDup,payloadSha256:r.payloadSha256,receivedAt:r.receivedAt,receiptClockId:r.receiptClockId,
      ...(r.decoded.lastSeen===undefined?{}:{last_seen:r.decoded.lastSeen}),...(r.decoded.linkquality===undefined?{}:{linkquality:r.decoded.linkquality})};
    const options={sequence:r.localSequence,timestamp:r.receivedAt,clockDomain:r.receiptClockId,quality:'valid',provenance};
    if(r.decoded.battery!==undefined){const result=runtime.publish(batterySource,r.decoded.battery,options);publishResults.push(result);assert.equal(result.ok,true,JSON.stringify(result));}
    if(r.decoded.action!==undefined){const result=runtime.publish(actionSource,r.decoded.action,{...options,operationId:String(r.localSequence),deadline:r.receivedAt+1000});publishResults.push(result);if(eventAllowed)assert.equal(result.ok,true,JSON.stringify(result));}
    runtime.flush();
  },onUnavailable:r=>{unavailable.push(r);runtime.setReadiness(batterySource,'unavailable');runtime.setReadiness(actionSource,'unavailable');}});
  const route=(source,sink)=>runtime.route({from:source,to:sink,...scope});
  const until=async(predicate,label)=>{const deadline=performance.now()+1500;while(!predicate()){runtime.flush();assert.ok(performance.now()<deadline,JSON.stringify({label,bridge:c.status(),publishResults,battery:battery.length,actions:actions.length}));await new Promise(res=>setTimeout(res,5));}};
  let result,error;
  try{
    const starting=c.start({purpose:'read-selected-reported-switch',signal:owner.signal,deadline:performance.now()+20000});p=producer(endpoint);assert.equal((await p.ready).pid,p.child.pid);
    for(const kind of ['metadata','bridge-online','device-online'])wire.push(await p.request(kind));assert.equal((await starting).ok,true);
    for(const source of [batterySource,actionSource])runtime.setReadiness(source,'available');
    batteryRoute=route(batterySource,batterySink);eventRoute=route(actionSource,actionSink);assert.equal(batteryRoute.start().ok,false);assert.equal(eventRoute.start().ok,false);
    wire.push(await p.request('battery'));await until(()=>readings.length===1,'denied property');assert.equal(battery.length,0);
    batteryAllowed=true;batteryRoute=route(batterySource,batterySink);assert.equal(batteryRoute.start().ok,true);
    eventRoute=route(actionSource,actionSink);assert.equal(eventRoute.start().ok,false);
    for(const key of ['principalId','applicationId','sessionId'])assert.equal(runtime.route({from:batterySource,to:batterySink,...scope,[key]:'other'}).start().ok,false);
    wire.push(await p.request('battery'));await until(()=>battery.length===1,'granted battery');assert.equal(battery[0].value,75);const batteryTimestamp=battery[0].timestamp;
    wire.push(await p.request('single'));await until(()=>readings.length===3,'separate event denial');assert.equal(actions.length,0);assert.equal(battery.length,1);assert.equal(battery[0].timestamp,batteryTimestamp);
    eventAllowed=true;eventRoute=route(actionSource,actionSink);assert.equal(eventRoute.start().ok,true);
    for(const kind of ['single','single','hold','release']){const count=actions.length;wire.push(await p.request(kind));await until(()=>actions.length===count+1,'native '+kind);}
    assert.deepEqual(actions.map(v=>v.value),['single','single','hold','release']);assert.equal(battery.length,1);
    const before=c.status().messages;wire.push(await p.request('retained-state'));await until(()=>c.status().messages>before,'retained discard');assert.equal(actions.length,4);assert.equal(battery.length,1);
    wire.push(await p.request('mixed'));await until(()=>actions.length===5&&battery.length===2,'mixed cached battery');assert.equal(actions[4].value,'double');
    eventAllowed=false;eventRoute.stop();assert.equal(route(actionSource,actionSink).start().ok,false);const count=readings.length;wire.push(await p.request('single'));await until(()=>readings.length>count,'revoked event transport');assert.equal(actions.length,5);
    wire.push(await p.request('battery'));await until(()=>battery.length===3,'independent property survives');
    for(const o of [...battery,...actions]){assert.equal(o.clockDomain,'zigbee-gateway-monotonic');assert.equal(o.timestamp,o.provenance.receivedAt);assert.equal(o.provenance.captureTimeKnown,false);assert.equal(o.provenance.originClockMapped,false);assert.equal(o.provenance.sourceEventSequenceKnown,false);assert.equal(o.provenance.receivedQos,0);assert.equal(o.provenance.retained,false);assert.ok(wire.some(w=>w.payloadSha256===o.provenance.payloadSha256));}
    assert.equal(battery[0].provenance.last_seen,'2026-10-08T00:00:00.000Z');assert.equal(battery[0].provenance.linkquality,99);
    wire.push(await p.request('offline'));await until(()=>unavailable.length===1,'native offline withdrawal');assert.equal(batteryRoute.status().state,'closed');await c.close();assert.equal(c.status().nativeClients,0);
    const n=readings.length;wire.push(await p.request('single'));await new Promise(res=>setTimeout(res,20));assert.equal(readings.length,n);
    await p.close();p=undefined;
    result={status:'pass',checks:{separatePropertyAndEventGrants:true,identicalEventsPreserved:true,retainedDiscarded:true,captureUnknown:true,offlineWithdrawn:true,actualProducerClose:true,retired:true},battery:battery.map(o=>({value:o.value,timestamp:o.timestamp,provenance:o.provenance})),actions:actions.map(o=>({value:o.value,timestamp:o.timestamp,provenance:o.provenance})),wire,unavailable,statusAfterStop:c.status(),scope:'Software native-wire stand-in only; battery may be cached, bridge actions may be inferred, no commissioning, source capture timing, upstream exactly-once or physical effects.'};
  }catch(e){error=new Error(JSON.stringify({message:e.message,bridge:c.status(),publishResults,wire}),{cause:e});}
  const cleanup=await Promise.allSettled([c.close(),p?.close()??Promise.resolve(),Promise.resolve().then(()=>{batteryRoute?.stop();eventRoute?.stop();runtime.close();})]);
  const errors=[...(error?[error]:[]),...cleanup.filter(r=>r.status==='rejected').map(r=>r.reason)];if(errors.length)throw new AggregateError(errors,'Zigbee caller failed');return Object.freeze(result);
}
