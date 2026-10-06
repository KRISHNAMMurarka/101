import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDeviceRuntime, createWatchCompanionResources, decodeWatchCompanionReport, watchCompanionReportDevice,
 WATCH_COMPANION_REPORT_PROFILE, WATCH_COMPANION_REPORT_LIMITS } from '@101/connect';
const producer=JSON.parse(readFileSync(process.argv[2],'utf8')), checks=[];
function check(name,work){work();checks.push(name);}
assert.equal(producer.swiftHex,producer.kotlinHex);const bytes=Uint8Array.from(Buffer.from(producer.swiftHex,'hex'));
check('actual Swift and Kotlin wire bytes decoded',()=>assert.equal(decodeWatchCompanionReport(bytes).sequence,4321));
check('capture time and physical validity remain unspecified',()=>assert.equal(decodeWatchCompanionReport(bytes).physicalValidity,'unspecified'));
for(const platform of ['watchos','wearos']) {
 let at=0,epoch=0,issued,listener,loss,owner=new AbortController(),issuer=new AbortController(),starts=0,stops=0,releases=0,allowSink=true;
 const received=[];
 const bridge={async enroll(){issuer=new AbortController();issued=Object.freeze({platform,epoch:++epoch,signal:issuer.signal,snapshot:Object.freeze({platform,companionPaired:true,appInstalled:true,reachable:true,nearby:platform==='wearos'})});return issued;},
  async start(selected,report,onLoss,signal){assert.equal(selected,issued);assert.equal(signal.aborted,false);listener=report;loss=onLoss;starts++;},async stop(selected){assert.equal(selected,issued);stops++;issuer.abort();}};
 const requests=[],runtime=createDeviceRuntime({now:()=>at,authorize(request){requests.push(request);return allowSink?{expiresAt:10000,maxAgeMs:250,maxHz:30}:undefined;}});
 const descriptor=watchCompanionReportDevice('watch:caller-output',platform);
 const sink=runtime.registerSink({device:{...descriptor,capabilities:descriptor.capabilities.map(capability=>({...capability,permissions:['write'],ownership:{mode:'exclusive'}}))},capability:'report',
  apply(observation,context){assert.equal(context.isCurrent(),true);assert.equal(context.signal.aborted,false);received.push(observation);},release(){releases++;}});runtime.setReadiness(sink,'available');
 let approve=request=>({request,expiresAt:10000,signal:owner.signal});
 const resources=createWatchCompanionResources({runtime,bridge,ownerId:'phone-owner',now:()=>at,approve:request=>approve(request)});
 function emit(sequence=4321,emission=1234567,enrollment=issued,data){const input=bytes.slice();const view=new DataView(input.buffer);view.setUint16(2,sequence,true);view.setUint32(4,emission,true);listener({enrollment,data:data??Buffer.from(input).toString('base64')});}
 const route=source=>runtime.route({from:source,to:sink,principalId:'sink-owner',applicationId:'watch-report',sessionId:'software-'+platform,sourceOperation:'subscribe',leaseMs:1000});
 try {
  approve=()=>undefined;check(platform+' source approval denied before capture',()=>{});assert.equal((await resources.start()).ok,false);assert.equal(starts,0);
  approve=request=>({request,expiresAt:10000,signal:owner.signal});let opened=await resources.start();assert.equal(opened.ok,true);
  check(platform+' current exact source consent',()=>assert.equal(resources.status().state,'active'));
  allowSink=false;const denied=route(opened.value);check(platform+' independent sink denial',()=>assert.equal(denied.start().ok,false));allowSink=true;
  const active=route(opened.value);check(platform+' real subscribe to write route',()=>assert.equal(active.start().ok,true));
  emit(4321,1234567,{...issued});runtime.flush();check(platform+' copied enrollment inert',()=>assert.equal(received.length,0));
  emit();runtime.flush();check(platform+' actual typed latest report delivered',()=>assert.equal(received.length,1));
  check(platform+' emission is not observation time',()=>{assert.equal(received[0].timestamp,0);assert.equal(received[0].provenance.captureTimeKnown,false);assert.equal(received[0].value.relayEmissionMs,1234567);});
  at=1;emit(4322,1234568);emit(4323,1234569);runtime.flush();check(platform+' bounded latest coalescing',()=>assert.equal(received.length,1));
  at=40;resources.sweep();runtime.flush();check(platform+' original arrival time retained',()=>{assert.equal(received.length,2);assert.equal(received[1].timestamp,1);assert.equal(received[1].value.sequence,4323);});
  runtime.revoke(active);check(platform+' actual sink grant revoke releases',()=>{assert.equal(active.status().state,'closed');assert.equal(releases,1);});
  const renewed=route(opened.value);assert.equal(renewed.start().ok,true);owner.abort();check(platform+' source abort unregisters and releases',()=>{assert.equal(renewed.status().state,'closed');assert.equal(releases,2);});
  await new Promise(resolve=>setImmediate(resolve));owner=new AbortController();at=50;opened=await resources.start();assert.equal(opened.ok,true);const replacement=route(opened.value);replacement.start();
  loss();check(platform+' issuer loss closes actual route',()=>assert.equal(replacement.status().state,'closed'));
  await new Promise(resolve=>setImmediate(resolve));owner=new AbortController();opened=await resources.start();assert.equal(opened.ok,true);
  emit(4321,1234567,issued,'A'.repeat(8192));check(platform+' oversize frame retires closed',()=>assert.equal(resources.status().state,'idle'));
  await new Promise(resolve=>setImmediate(resolve));check(platform+' native stop cleanup actually requested',()=>assert.ok(stops>=4));
  check(platform+' route operations exact',()=>assert.ok(requests.every(request=>request.sourceOperation==='subscribe'&&request.sinkOperation==='write')));
 } finally {resources.close();runtime.close();}
}
console.log(JSON.stringify({status:'pass',profile:WATCH_COMPANION_REPORT_PROFILE,checks,limits:WATCH_COMPANION_REPORT_LIMITS,
 nativeDelivery:'unqualified: explicit software native-bridge ports only',physicalValidity:'unspecified',transport:'none',gameImports:false}));
