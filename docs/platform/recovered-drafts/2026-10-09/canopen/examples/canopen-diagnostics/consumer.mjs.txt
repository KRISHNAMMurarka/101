import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createCanDiagnosticConnector } from '../../packages/hub-server/src/canopen-diagnostic-gateway.ts';

const now = () => Number(process.hrtime.bigint()) / 1e6;
async function until(predicate, label, ms = 2000) { const deadline = now() + ms; while (!predicate()) {
  assert.ok(now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 2)); } }
export async function runCanDiagnosticExample({nativeExecutable,sourceSha256,mode='scripted-process-harness',scenario='normal'}) {
  if(mode!=='scripted-process-harness')return{status:'blocked',reason:'blocked-native-environment',physical:false,supportRows:[]};
  assert.ok(['normal','sdo-abort','route-expiry','route-revoke-after-read','gateway-expiry','gateway-revoke-opening'].includes(scenario));
  const scope=Object.freeze({principalId:'owned-operator',applicationId:'can-diagnostic-example',sessionId:'scripted-'+scenario});
  const owner=new AbortController(),caller=new AbortController(),grant=new AbortController(),readings=[],applied=[],appliedContexts=[],unavailable=[],releases=[];
  const value={type:'record',fields:{kind:{type:'enum',values:['heartbeat','device-type','error-register','sdo-abort']},
    nodeId:{type:'scalar',unit:'1',min:1,max:127},value:{type:'scalar',unit:'1',min:0,max:4294967295}}};
  const descriptor=parseDeviceDescriptor({schemaVersion:1,id:'can-software-diagnostics',label:'Owned software diagnostics',revision:1,
    adapter:{id:'example:canopen-diagnostics',version:'1.0.0'},runtime:{platform:'scripted-process-harness'},capabilities:[
      {id:'diagnostics',semantic:'industrial:canopen-diagnostic-record',schemaVersion:1,kind:'sample',value,permissions:['subscribe'],delivery:{mode:'reliable',maxAgeMs:1000}},
      {id:'display',semantic:'industrial:canopen-diagnostic-record',schemaVersion:1,kind:'property',value,permissions:['write'],ownership:{mode:'observe'},delivery:{mode:'reliable',maxAgeMs:1000}}]});
  let routeAllowed=false,route,routeClosed=false,releaseOwner;
  const runtime=createDeviceRuntime({now,clockDomain:'can-gateway-harness-monotonic',authorize:request=>routeAllowed&&
    request.principalId===scope.principalId&&request.applicationId===scope.applicationId&&request.sessionId===scope.sessionId&&
    request.source.registrationId===source.id&&request.sink.registrationId===sink.id&&request.sourceOperation==='subscribe'&&request.sinkOperation==='write'
      ?{expiresAt:now()+(scenario==='route-expiry'?350:3000),maxAgeMs:1000,maxHz:1000}:undefined});
  const source=runtime.registerSource({device:descriptor,capability:'diagnostics'});
  const sink=runtime.registerSink({device:descriptor,capability:'display',apply(observation,context){
    if(context.signal.aborted||!context.isCurrent())return;applied.push(observation);
    appliedContexts.push({operationId:context.operationId,routeId:context.routeId,generation:context.generation});
  },release(reason,context){releases.push({reason,...context});}});
  runtime.setReadiness(source,'available');runtime.setReadiness(sink,'available');
  const denied=runtime.route({from:source,to:sink,...scope});assert.equal(denied.start().ok,false);
  routeAllowed=true;route=runtime.route({from:source,to:sink,...scope,queueCapacity:64});assert.ok(route.start().ok);
  releaseOwner=route.onClose(()=>{routeClosed=true;owner.abort();});
  nativeExecutable=realpathSync(nativeExecutable);
  const nativeExecutableSha256=createHash('sha256').update(readFileSync(nativeExecutable)).digest('hex');
  const environment={kind:'owned-scripted-host',platform:process.platform,arch:process.arch,node:process.versions.node,uv:process.versions.uv,nativeAdmission:false};
  const profile={profileId:'canopen-cc-diagnostics-harness/1',revision:1,interfaceName:'harness',expectedIfindex:0,namespaceInode:'0',nodeId:1,
    nativeExecutablePath:nativeExecutable,nativeExecutableSha256,nativeSourceSha256:sourceSha256,
    environmentReceiptSha256:createHash('sha256').update(JSON.stringify(environment)).digest('hex')};
  let authority;
  const connector=createCanDiagnosticConnector({profile,scope,ownerSignal:owner.signal,authorize:request=>{
    authority=request;return{request,signal:grant.signal,expiresAt:request.deadline};},
    onReading(reading){readings.push(reading);const published=runtime.publish(source,reading.record,{sequence:reading.localSequence,
      timestamp:reading.receivedAt,clockDomain:'can-gateway-harness-monotonic',quality:'valid',provenance:reading.provenance,
      operationId:String(reading.localSequence),deadline:Math.min(originalDeadline,reading.receivedAt+1000)});
      assert.ok(published.ok,JSON.stringify(published));runtime.flush();},
    onUnavailable(reason){unavailable.push(reason);runtime.setReadiness(source,'unavailable');}});
  const originalDeadline=now()+(scenario==='gateway-expiry'?100:2000);
  try {
    const opening=connector.start({purpose:'selected-diagnostic-read-only',signal:caller.signal,deadline:originalDeadline});
    if(scenario==='gateway-revoke-opening')owner.abort();
    const opened=await opening;
    if(scenario==='gateway-revoke-opening')assert.equal(opened.ok,false);else assert.ok(opened.ok);
    if(scenario==='normal'||scenario==='sdo-abort'||scenario==='route-expiry'||scenario==='route-revoke-after-read') {
      await until(()=>{runtime.flush();return applied.some(item=>item.value.kind===(scenario==='sdo-abort'?'sdo-abort':'device-type'))&&applied.some(item=>item.value.kind==='error-register');},'ordinary public typed diagnostic values');
      assert.equal(applied.find(item=>item.value.kind===(scenario==='sdo-abort'?'sdo-abort':'device-type')).value.value,scenario==='sdo-abort'?0x06020000:0xffffffff);
      assert.equal(applied.find(item=>item.value.kind==='error-register').value.value,255);
      if(scenario==='route-revoke-after-read')runtime.revoke(route);
      if(scenario==='route-expiry'||scenario==='route-revoke-after-read')await until(()=>{runtime.flush();return routeClosed;},'public route authority loss');
      else await connector.stop();
    } else if(scenario==='gateway-expiry')await until(()=>connector.status().phase==='retiring'||connector.status().phase==='idle','original caller deadline retirement');
    await connector.close();
    const count=readings.length;await new Promise(resolve=>setTimeout(resolve,60));runtime.flush();assert.equal(readings.length,count);
    assert.equal(connector.status().nativeChildren,0);assert.equal(connector.status().rawWrites,0);
    assert.equal(connector.status().childClosed,true);
    if(scenario!=='gateway-expiry'){assert.equal(connector.status().childExitCode,0);assert.equal(connector.status().childExitSignal,null);}
    assert.equal(authority.deadline,originalDeadline);assert.ok(Object.isFrozen(authority));assert.ok(Object.isFrozen(authority.profile));
    for(let at=0;at<applied.length;at++){const observation=applied[at];assert.equal(observation.clockDomain,'can-gateway-harness-monotonic');
      assert.equal(appliedContexts[at].operationId,String(observation.sequence));assert.equal(appliedContexts[at].routeId,route.id);
      assert.equal(observation.provenance.nativeMonotonicNs,null);assert.equal(observation.provenance.kernelTimestamp,null);
      assert.equal(observation.provenance.receiverOverflow,null);assert.equal(observation.provenance.sourceTimeMapped,false);
      assert.equal(observation.provenance.receivedAt,observation.timestamp);assert.equal(observation.provenance.physical,false);
      assert.ok(readings.some(item=>item.provenance.rawSha256===observation.provenance.rawSha256));}
    return{status:'pass',kind:'scripted-process-harness',scenario,checks:{routeDenied:true,typedDiagnosticValues:scenario==='normal'||scenario==='sdo-abort'||scenario.startsWith('route-'),
      originalCallerDeadlineBound:true,exactScope:true,sourceRetired:true,actualChildCloseJoined:true,noCallbacksAfterClose:true,nativeEvidenceNotFabricated:true},
      profile,environment,originalDeadline,routeClosed,applied:applied.map(item=>({value:item.value,timestamp:item.timestamp,provenance:item.provenance})),
      readings,appliedContexts,unavailable,releases,statusAfterClose:connector.status(),scope:'Owned scripted C peer and ordinary SDK caller only; no CAN socket, native clock admission, stack conformance, physical quantities or full A11.'};
  } catch(error){throw new Error(JSON.stringify({message:error.message,scenario,connector:connector.status(),readings:readings.map(item=>item.record),applied:applied.map(item=>item.value)}),{cause:error});}
  finally{owner.abort();await connector.close();releaseOwner?.();route?.stop();denied.stop();await route?.whenSettled?.();runtime.close();}
}
