import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDeviceRuntime,parseDeviceDescriptor} from '@101/connect';
import {createMcp3008IioConnector,MCP3008_IIO_CODE_SCHEMA} from '../../packages/hub-server/src/mcp3008-iio-ch0.ts';
const now=()=>performance.now();
async function until(predicate,label,ms=2000){const deadline=now()+ms;while(!predicate()){assert.ok(now()<deadline,label);await new Promise(r=>setTimeout(r,2));}}
export function ownedProducer(workRoot){
 const child=fork(fileURLToPath(new URL('./producer.mjs',import.meta.url)),[workRoot],{execArgv:[],env:{NODE_ENV:'production'},stdio:['pipe','pipe','pipe','ipc']});
 // Adopt every terminal event and pipe before awaiting enrollment or caller setup.
 let exited,closedResult,resolveFault;const faulted=new Promise(done=>{resolveFault=done;});
 const waiters=new Set(),writes=[],pending=new Set(),timers=new Set(),messages=[];let fault,bytes=0,ordinal=0,expired=false;
 const wake=()=>{for(const fn of waiters)fn();};
 const fail=e=>{fault??=e;resolveFault(fault);wake();};
 const closed=new Promise(done=>child.once('close',(code,signal)=>{closedResult={code,signal};wake();done(closedResult);}));
 const exit=new Promise(done=>{child.once('exit',(code,signal)=>{exited={code,signal};wake();done(exited);});
  child.once('error',e=>{exited={code:null,signal:null,spawnError:true};fail(e);done(exited);});});
 for(const stream of [child.stdin,child.stdout,child.stderr])stream?.on('error',fail);
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{bytes+=b.length;if(bytes>4096){fail(Error('Producer output bound'));child.kill('SIGKILL');}});
 child.on('message',m=>{messages.push(m);if(messages.length>64){fail(Error('Producer message bound'));child.kill('SIGKILL');}for(const wake of waiters)wake();});
 function issue(call){let release;const reservation=new Promise(done=>{release=done;});pending.add(reservation);let raw;try{raw=call();}catch(e){raw=Promise.reject(e);}writes.push(raw);raw.catch(fail);const settled=()=>{pending.delete(reservation);release();};void raw.then(settled,settled);return raw;}
 function deadline(label,ms){const end=now()+ms,t=setTimeout(()=>{timers.delete(t);expired=true;fail(Error(label+' deadline'));child.kill('SIGKILL');},ms);timers.add(t);return{end,clear:()=>{clearTimeout(t);timers.delete(t);}};}
 async function message(predicate,label,bound){for(;;){if(fault)throw fault;const value=messages.find(predicate);if(value)return value;
  if(exited||closedResult){const error=Error('Producer exited before '+label);error.producerExit=exited;error.producerClose=await closed;throw error;}
  if(now()>=bound)throw Error('Producer '+label+' deadline');
  await new Promise(done=>{const fn=()=>{waiters.delete(fn);done();};waiters.add(fn);});}}
 const startup=deadline('Producer enrollment',2500);
 const enrollment=message(m=>m.kind==='enrolled','enrollment',startup.end).finally(startup.clear);enrollment.catch(()=>{});
 async function send(kind,extra={},ms=2500){const id=++ordinal;assert.ok(id<=32);const limit=deadline('Producer '+kind,ms);
  try{if(fault)throw fault;const raw=issue(()=>new Promise((done,reject)=>{try{child.send({kind,id,...extra},e=>e?reject(e):done());}catch(e){reject(e);}}));
   await Promise.race([raw,faulted.then(e=>{throw e;})]);
   return await message(m=>m.kind==='ack'&&m.id===id,kind+' acknowledgement',limit.end);
  }finally{limit.clear();}}
 function endPipe(){if(child.stdin.destroyed)return Promise.resolve();return issue(()=>new Promise((done,reject)=>{try{child.stdin.end(e=>e?reject(e):done());}catch(e){reject(e);}}));}
 async function join(){while(pending.size)await Promise.allSettled([...pending]);const [natural,closure,settled]=await Promise.all([exit,closed,Promise.allSettled(writes)]);return{natural,closure,settled};}
 async function finish(){const limit=deadline('Producer close',3000);let primary;
  try{if(child.connected)await send('finish',{},3000);}catch(e){primary=e;fail(e);}
  endPipe();const {natural,closure,settled}=await join();limit.clear();
  if(primary||fault||expired){const failure=Error(expired?'Producer close deadline':'Producer finish failed',{cause:primary??fault});
   failure.producerExit=natural;failure.producerClose=closure;throw failure;}
  assert.ok(settled.every(r=>r.status==='fulfilled'));assert.deepEqual(closure,natural);assert.equal(natural.code,0);assert.equal(natural.signal,null);
  return{exit:natural,closed:true,issuedWrites:settled.length};}
 async function abort(){const wasExpired=expired,limit=deadline('Producer cleanup',3000);
  try{if(child.connected&&!fault)await send('finish',{},3000);}catch(e){fail(e);}
  const joined=await join();limit.clear();if(expired&&!wasExpired){const failure=Error('Producer cleanup deadline');failure.producerExit=joined.natural;failure.producerClose=joined.closure;throw failure;}
  return joined;}
 return{child,enrollment,send,finish,abort,status:()=>({pendingOperations:pending.size,timers:timers.size,waiters:waiters.size,childClosed:!!closedResult})};
}
export async function runMcp3008IioExample({workRoot=tmpdir(),scenario='normal'}={}){
 assert.ok(['normal','malformed','missing','replacement','route-expiry','route-revoke','owner-revoke','caller-revoke','grant-revoke','gateway-expiry','callback-stop'].includes(scenario));
 workRoot=await fs.realpath(workRoot);let owned,owner,caller,grant,route,connector,producerResult,runtime,denied,detach,hadPrimary=false,primary,result,cleanupFailures=[];
 try{
 owned=ownedProducer(workRoot);const enrollment=await owned.enrollment;
 owner=new AbortController();caller=new AbortController();grant=new AbortController();const scope=Object.freeze({principalId:'owned-operator',applicationId:'mcp3008-iio-ch0-example',sessionId:scenario});
 const environment={kind:'software-abi-file',platform:process.platform,arch:process.arch,node:process.versions.node,ancestorPolicy:'host-controlled-stable',nativeAdmission:false};
 const profile={profileId:'mcp3008-iio-ch0-abi-file/1',revision:1,parentRealPath:enrollment.parentRealPath,iioRealPath:enrollment.iioRealPath,rawRealPath:enrollment.rawRealPath,spiController:'fixture-spi0',chipSelect:0,channel:0,mode:'single-ended',maxHz:1,reference:null,
 driverBuildSha256:'0'.repeat(64),environmentReceiptSha256:createHash('sha256').update(JSON.stringify(environment)).digest('hex'),ancestorPolicy:'host-controlled-stable',enrolledIdentities:enrollment.enrolledIdentities};
 const applied=[],readings=[],unavailable=[],releases=[];let allowed=false,authority;
 runtime=createDeviceRuntime({now,clockDomain:'mcp3008-gateway-monotonic',authorize:request=>allowed&&request.principalId===scope.principalId&&request.applicationId===scope.applicationId&&request.sessionId===scope.sessionId&&
 request.source.registrationId===source.id&&request.sink.registrationId===sink.id&&request.sourceOperation==='subscribe'&&request.sinkOperation==='write'?
 {expiresAt:now()+(scenario==='route-expiry'?120:8000),maxAgeMs:1000,maxHz:1}:undefined});
 const descriptor=parseDeviceDescriptor({schemaVersion:1,id:'owned-mcp3008-file',label:'Reported ADC code',revision:1,adapter:{id:'example:mcp3008-iio-ch0',version:'1.0.0'},runtime:{platform:'software-abi-file'},capabilities:[
 {id:'code',semantic:'sensor:reported-code',schemaVersion:1,kind:'sample',value:MCP3008_IIO_CODE_SCHEMA,permissions:['subscribe'],delivery:{mode:'latest',maxHz:1,maxAgeMs:1000}},
 {id:'display',semantic:'sensor:reported-code',schemaVersion:1,kind:'property',value:MCP3008_IIO_CODE_SCHEMA,permissions:['write'],ownership:{mode:'observe'},delivery:{mode:'latest',maxHz:1,maxAgeMs:1000}}]});
 const source=runtime.registerSource({device:descriptor,capability:'code'}),sink=runtime.registerSink({device:descriptor,capability:'display',apply(observation,context){if(context.isCurrent()&&!context.signal.aborted)applied.push(observation);},release(reason){releases.push(reason);}});
 runtime.setReadiness(source,'available');runtime.setReadiness(sink,'available');denied=runtime.route({from:source,to:sink,...scope});assert.equal(denied.start().ok,false);assert.equal(applied.length,0);
 allowed=true;route=runtime.route({from:source,to:sink,...scope,leaseMs:8000});assert.ok(route.start().ok);detach=route.onClose(reason=>{if(reason==='expired'||reason==='revoked')owner.abort();});
 const deadline=now()+(scenario==='gateway-expiry'?100:7000);
 connector=createMcp3008IioConnector({profile,scope,ownerSignal:owner.signal,authorize(request){authority=request;return{request,signal:grant.signal,expiresAt:request.deadline};},
 onCode(reading){readings.push(reading);const publication=runtime.publish(source,reading.decoded.code,{timestamp:reading.readReceivedAt,clockDomain:reading.receiptClockId,sequence:reading.localSequence,quality:'valid',provenance:reading.provenance});
 assert.ok(publication.ok);runtime.flush();if(scenario==='callback-stop')void connector.stop();},onUnavailable(reason){unavailable.push(reason);runtime.setReadiness(source,'unavailable');}});
 const start=await connector.start({purpose:'selected-owned-code',signal:caller.signal,deadline});assert.equal(start.ok,scenario!=='callback-stop');
 if(scenario==='normal'){
  for(const bytes of ['512\n','1023\n','1023\n']){await owned.send('contents',{bytes});const before=applied.length;await until(()=>{runtime.flush();return applied.length>before;},'Actual public reported value',1800).catch(e=>{throw new Error(JSON.stringify({cause:e.message,readings:readings.length,applied:applied.length,status:connector.status(),route:route.status(),unavailable}));});}
  assert.deepEqual(applied.slice(0,4).map(v=>v.value),[0,512,1023,1023]);
  await connector.stop();const count=readings.length;runtime.setReadiness(source,'available');route=runtime.route({from:source,to:sink,...scope,leaseMs:8000});assert.ok(route.start().ok);assert.ok((await connector.start({purpose:'fresh-explicit-read',signal:caller.signal,deadline})).ok);assert.equal(readings.at(-1).localSequence,count+1);
 }else if(['malformed','missing','replacement'].includes(scenario)){
  await owned.send(scenario==='malformed'?'contents':scenario==='replacement'?'replace':'missing',scenario==='malformed'?{bytes:'0.0\n'}:{});
  await until(()=>{runtime.flush();return connector.status().phase==='idle';},'Fixture fault retires source',1800);assert.equal(readings.length,1);assert.ok(unavailable.length>0);
  if(scenario==='malformed'){await owned.send('contents',{bytes:'0\n'});runtime.setReadiness(source,'available');route=runtime.route({from:source,to:sink,...scope,leaseMs:8000});assert.ok(route.start().ok);assert.ok((await connector.start({purpose:'explicit-recovery',signal:caller.signal,deadline})).ok);await until(()=>{runtime.flush();return applied.some(o=>o.value===0);},'Explicit public recovery after authentic release',1800);}
  else assert.equal((await connector.start({purpose:'no-reenrollment',signal:caller.signal,deadline})).ok,false);
 }else if(scenario==='route-revoke'){runtime.revoke(route);await connector.stop();}
 else if(scenario==='owner-revoke'||scenario==='caller-revoke'||scenario==='grant-revoke'){({owner,caller,grant})[scenario.split('-')[0]].abort();await connector.stop();}
 else if(scenario==='route-expiry'){await until(()=>{runtime.flush();return route.status().state==='closed';},'Public route expiry');await connector.stop();}
 else if(scenario==='gateway-expiry')await until(()=>connector.status().phase==='idle','Original session expiry');
 await connector.close();const count=readings.length;await new Promise(r=>setTimeout(r,5));runtime.flush();assert.equal(readings.length,count);
 const status=connector.status();for(const key of ['pendingOperations','openHandles','inFlightReads','unconfirmedCloses','timers'])assert.equal(status[key],0);
 assert.equal(authority.deadline,deadline);assert.deepEqual(authority.scope,scope);assert.ok(Object.isFrozen(authority.profile.enrolledIdentities.raw));
 for(const o of applied){assert.equal(o.timestamp,o.provenance.readReceivedAt);assert.ok(o.receivedAt>=o.timestamp);assert.equal(o.provenance.calibrationRevision,null);assert.equal(o.provenance.absoluteErrorBound,null);
 assert.equal(o.provenance.captureUnknown,true);assert.equal(o.provenance.physical,false);assert.equal(o.provenance.sourceTimeMapped,false);assert.equal(o.provenance.channel,0);assert.equal(o.provenance.reference,null);}
 producerResult=await owned.finish();assert.deepEqual(owned.status(),{pendingOperations:0,timers:0,waiters:0,childClosed:true});result={status:'pass',kind:'software-abi-file-public-SDK',scenario,physical:false,supportRows:[],profile,environment,originalDeadline:deadline,applied,readings,unavailable,releases,
 checks:{deniedFirst:true,standingApproval:true,originalReadReceipt:true,unknownCalibrationCapture:true,noCallbacksAfterClose:true,nativeAdmission:false,sourceWithdrawn:true},statusAfterClose:status,
 producerPid:owned.child.pid,producerExit:producerResult.exit,producerClosed:producerResult.closed,producerOwnership:owned.status(),issuedProducerWrites:producerResult.issuedWrites};
 }catch(error){hadPrimary=true;primary=error;}finally{
  owner?.abort();
  const cleanup=await Promise.allSettled([
   Promise.resolve().then(()=>connector?.close()),
   Promise.resolve().then(async()=>{detach?.();route?.stop();denied?.stop();await route?.whenSettled?.();}),
   Promise.resolve().then(()=>runtime?.close()),
   Promise.resolve().then(()=>!producerResult&&owned?owned.abort():undefined),
  ]);
  cleanupFailures=cleanup.filter(r=>r.status==='rejected');
 }
 if(hadPrimary){if(cleanupFailures.length)throw new AggregateError([primary,...cleanupFailures.map(r=>r.reason)],'MCP3008 operation and cleanup failed');throw primary;}
 if(cleanupFailures.length)throw new AggregateError(cleanupFailures.map(r=>r.reason),'MCP3008 cleanup failed');
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await fs.realpath(process.argv[1])).href){try{console.log(JSON.stringify(await runMcp3008IioExample({workRoot:process.argv[2]})));}catch(error){console.error(error);process.exitCode=1;}}
