import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {types} from 'node:util';
import {createAssetReference,chunkResource,createDeviceRuntime,parseDeviceDescriptor,readVerifiedResource} from '@101/connect';
import {createFixedSbcPort} from './codec.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};}

/** Reserves before callout and separately joins the actual return after logical abort. */
function rawOwner(){
  const pending=new Set(),completed=[];
  function reserve(kind){
    const done=deferred(),record={kind,done:done.promise};pending.add(record);
    let finished=false;
    return{complete(outcome){if(finished)return;finished=true;completed.push({kind,...outcome});pending.delete(record);done.resolve();}};
  }
  function issue(kind,call){
    const ticket=reserve(kind);let returned;
    try{returned=call();}catch(error){ticket.complete({status:'failed',reason:String(error?.message??error)});return Promise.reject(error);}
    const raw=Promise.resolve(returned);
    raw.then(()=>ticket.complete({status:'joined'}),error=>ticket.complete({status:'failed',reason:String(error?.message??error)}));
    return raw;
  }
  async function join(){while(pending.size)await Promise.all([...pending].map(record=>record.done));}
  return{reserve,issue,join,status:()=>({pending:pending.size,completed:completed.slice()})};
}

/** The terminal ticket exists before SDK reads: a queued SDK return remains owned. */
function ownedChunks(bytes,raw,controls){
  const chunks=chunkResource(bytes,64);let acquired=false;
  return{[Symbol.asyncIterator](){
    assert.equal(acquired,false,'one resource iterator per original read');acquired=true;
    const terminal=raw.reserve('resource-terminal'),iterator=chunks[Symbol.asyncIterator]();let returned;
    return{
      next(){return raw.issue('resource-next',async()=>{
        const next=iterator.next();controls.onNext?.();const result=await next;
        if(controls.nextHold){const hold=controls.nextHold;controls.nextHold=undefined;hold.entered.resolve();await hold.release.promise;}
        if(result.done)terminal.complete({status:'joined',outcome:'natural-done'});
        return result;
      });},
      return(){
        if(returned)return returned;
        // Reserve before any underlying iterator or holder can reenter close.
        const reserved=deferred();returned=raw.issue('resource-return-wrapper',()=>reserved.promise);
        const operation=raw.issue('resource-return',async()=>{
          controls.returnCalls++;const actual=iterator.return();controls.onReturn?.();
          if(controls.returnHold){const hold=controls.returnHold;controls.returnHold=undefined;hold.entered.resolve();await hold.release.promise;}
          return actual;
        });
        operation.then(value=>{terminal.complete({status:'joined',outcome:'returned'});reserved.resolve(value);},error=>{
          terminal.complete({status:'failed',reason:String(error?.message??error)});
          // Preserve the original rejection for SDK's actual scheduled return observer.
          reserved.resolve(Promise.reject(error));
        });
        return returned;
      },
    };
  }};
}


export const QUALIFICATION_MODES=Object.freeze([
 'normal','fixture-normal','encode-denied','decode-denied','route-denied','resource-denied',
 'scope-principal','scope-application','scope-session','reference-source-registration','reference-sink-registration',
 'reference-source-device','reference-sink-device','reference-source-capability','reference-sink-capability',
 'reference-source-revision','reference-sink-revision','reference-source-schema','reference-sink-schema',
 'source-operation','sink-operation','wrong-purpose','owner-abort','caller-abort','encode-grant-abort',
 'decode-grant-abort','resource-grant-abort','expired','digest-tamper','generation-payload-tamper',
 'held-authorizer','held-next','held-return','held-decoder','held-apply','release-reentry',
 'expiry-authorizer','expiry-next','expiry-return','expiry-decoder','expiry-apply'
]);
// Authentic, previously captured independent FFmpeg output. Fixture modes never
// claim a producer/decoder process effect; their decoded PCM is synthetic.
const TONE_BASE64='nLEf/7ZTMyN/vdtrAHu21gsIbaxKUGMaNTMQ3BNNLn9xdtr8nO211r3baz57ttV+922pQe7bUGPdtqBHu21HT3baqB7ttZyxH9ewAAAAj3qaq5VFwVfNpIqv/ekVXsoVqrfXmlVgW0bKod5tVRTm2qoA4SVULYpqqZiS1Vbayiq1mdRVeDlIqv6RkVWcsR/XsAAAAPqFUquzhbVWi3tqqxtI1VKvzSqg7xJVQGqUqo18MVVNKKKrF7G1Vx6LiK+OJtVf/nYqvc/jVXB6NKrCh2lVnLEf17AAAABG/tKiLeClVAMKaqhPctVTAqoqrUJUBWpWtqrvPI1V/FMaq/cGtVdxRGqtMviZVm+xqqW3W2VCMRSqgJJNVZyxH9ewAAAAGMiaqpOpNVYg84quJLdVXwDSKr/+JFV8Ekaq4n+NVYi3GqqUgaVUZEJqqAnE1VCJiSqlq5RVWaA2qtL0bVWcsR/XsAAAANv7Iqv20jVX8bxqrvZo1VqdMaqtUdpVTCSmqoUQTVUAvKKqLVSlVRpCaqwkpNVcF44qvchkVX/2xqr5ALFZnLEf17AAAADIC1qrGK4lVTZjSqjaJJVQG+UqoOqTVUqnlqqxeW1VomjYq7LVxVfpnGqv6dsVXhN1qrWoY5VbibSqmbqNVZyxH9ewAAAAC5ZaqgDRRVRSimqqGnUVWA8qKrfKZFV7Friq/9uNVfOZYquWCjVWP8xKqofW1VHY6bKgTJNVQYomqpP4MVWcsR/XsAAAAF9moqs9yUWXWxNqr8o41V/ekaqccSNVbCm3KrjmiVU2aNKqGk0lVADSSqiVpNVUAmoqr6jUVW7Htqr1MU1VnLEf17AAAAD/cxqr6j41Vze8SoycuJVVRe2qo/7SVUDIpKqCjE1VJVJaKrfAtVZtU4quoEjFX4ESKr/QLFV5csiq2f9tVZyxH9ewAAAAdWjcqnLVFVQ7OkqoAKTVUQ1qKqegW1Veabiq2+1wVehPIqv+JrUX2iRKroaI2VlyjSqq+hpVSJekqoH+TVWcsR/XsAAAAAQgmqpFmUVVYaKKrL4G1V0Ubaq+2CRVf8DIqvP6rVW3TRqq8h2lVPH7aqiEZJRQAQkqoeKLVU57Nqq7AVFVnLEf17AAAAC0kuKrzE41V/psiq++2NVdOZWqs1faVVbTRqqSdUlVBO7cqgaQtVSBWWqqp6bVWULuKrnNm1V9WEiq/6+NVZyxH9ewAAAA6gtaq3UqJVXyu0qp/MaVUSZJqqAFi1VDWpSKm3RNVXJioqtibkVXj8SKr/A7FV+Rcaq6yuNVZ5NEqq9naVWcsR/XsAAAACeC0qwL7TVUCglqqO+01VUYaYqyEhNVcuC4qvnuTVX/qxqr2A61Vvc0arQChpVULM2qooqaVUAXNKqF7U1VnLEf17AAAAAz7qKq3Yk1VrdKiq8M2NVf1dWqv0ckVXY8xqrQ6Y1VYlsSqlRZJlQce0qoDtSVUbppqqnFFFVjO6aq5ESxVQ==';
const TONE_SHA256='b849c8d6654d470a42d4f887ae97df52047cc17aa65ac05519767bbd0df5032c';
const PURPOSE='selected SBC resource software qualification';
function hold(){return{entered:deferred(),release:deferred()};}
function fixturePort(mode,decoderHold){
 const pending=new Set(),receipts=[],buffers=[];let closed=false;
 return Object.freeze({
  issue(request,input){
   assert.equal(closed,false);assert.equal(pending.size,0);
   const decode=request.action==='decode-verified-sbc',ticket={action:request.action};pending.add(ticket);
   if(decode)assert.equal(input.byteLength,1120);else assert.equal(input,undefined);
   const output=(async()=>{if(decode&&(mode==='held-decoder'||mode==='expiry-decoder')){decoderHold.entered.resolve();await decoderHold.release.promise;}
    const bytes=decode?new Uint8Array(4096):Uint8Array.from(Buffer.from(TONE_BASE64,'base64'));
    if(decode){bytes[0]=1;bytes[2]=2;}else assert.equal(sha(bytes),TONE_SHA256);
    buffers.push(bytes);return bytes;})();
   const settled=output.then(()=>{pending.delete(ticket);receipts.push({action:request.action,status:'fixture-returned',rawSettled:true,spawned:false,syntheticPcm:decode});});
   return Object.freeze({output,settled,terminate(reason){ticket.termination=String(reason);}});
  },
  async close(){closed=true;assert.equal(pending.size,0);for(const bytes of buffers)bytes.fill(0);},
  pending:()=>pending.size,receipts:()=>receipts.slice(),
 });
}
function optionFields(options){
 if(!options||types.isProxy(options)||Object.getPrototypeOf(options)!==Object.prototype)throw Error('consumer-options');
 const properties=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(properties);
 if(keys.length!==4||keys.some(key=>typeof key!=='string'||!['profileModuleUrl','enrollment','mode','receiptPath'].includes(key)||!('value'in properties[key])))throw Error('consumer-options');
 const {profileModuleUrl,enrollment,mode,receiptPath}=options;
 if(typeof profileModuleUrl!=='string'||!profileModuleUrl.startsWith('file:')||!fileURLToPath(profileModuleUrl).endsWith('/headset-sbc.ts')||!QUALIFICATION_MODES.includes(mode)||receiptPath!==undefined&&typeof receiptPath!=='string')throw Error('consumer-options');
 return{profileModuleUrl,enrollment,mode,receiptPath};
}
const sameScope=(a,b)=>['principalId','applicationId','sessionId'].every(key=>a[key]===b[key]);
const sameReference=(a,b)=>['id','kind','mediaType','byteLength','sha256'].every(key=>a[key]===b[key]);
const routeIdentity=r=>JSON.stringify([r.principalId,r.applicationId,r.sessionId,
 ...['registrationId','deviceId','capabilityId','descriptorRevision','schemaVersion'].map(key=>r.source[key]),
 ...['registrationId','deviceId','capabilityId','descriptorRevision','schemaVersion'].map(key=>r.sink[key]),r.sourceOperation,r.sinkOperation,r.partition??null]);

/** One closed qualification scenario, using the ordinary public SDK delivery path. */
export async function runHeadsetSbcConsumer(options){
 const {profileModuleUrl,enrollment,mode,receiptPath}=optionFields(options);
 const profile=await import(profileModuleUrl);
 for(const host of ['darwin','linux','win32','unknown'])assert.deepEqual(profile.admitHeadsetNativeProfile(host),{ok:false,reason:'unqualified-native-profile'});
 const raw=rawOwner(),owner=new AbortController(),caller=new AbortController(),encodeGrant=new AbortController(),decodeGrant=new AbortController(),resourceGrant=new AbortController(),readAbort=new AbortController();
 const scope=Object.freeze({principalId:'sbc-owner',applicationId:'headset-sbc-example',sessionId:'owned-audio-resource'});
 const deadline=performance.now()+(mode.startsWith('expiry-')?100:5000),originalRequests=new Map(),resourceRequests=[],routeRequests=[],bridges=[],buffers=new Set(),checks=[];
 const controls={returnCalls:0},authorizerHold=hold(),nextHold=hold(),returnHold=hold(),decoderHold=hold(),applyHold=hold();
 const allHolds=[authorizerHold,nextHold,returnHold,decoderHold,applyHold];
 if(['held-next','held-return','expiry-next','expiry-return'].includes(mode))controls.nextHold=nextHold;
 if(mode==='held-return'||mode==='expiry-return')controls.returnHold=returnHold;
 const port=mode==='normal'?createFixedSbcPort(enrollment):fixturePort(mode,decoderHold);
 let session,runtime,source,sink,connection,closing,retired=false,produced,reference,expectedRoute,delivered,decodeFacts,applyPromise;
 let producedBytes,deliveryBytes,applies=0,releaseCalls=0,expectedError,applyError,deadlineTimer,expiryObservation;
 const expiryEntered=deferred();
 const applyEntered=deferred(),applyDone=deferred();
 function setupEntry(entered,label){
  return Promise.race([entered.promise,
   expiryEntered.promise.then(()=>{throw Error('qualification-'+label+'-entry-preempted-by-retirement');}),
   applyDone.promise.then(()=>{throw Error('qualification-'+label+'-entry-preempted-by-apply-return');})]);
 }
 function current(){return!retired&&!owner.signal.aborted&&!caller.signal.aborted&&!encodeGrant.signal.aborted&&!decodeGrant.signal.aborted&&!resourceGrant.signal.aborted&&performance.now()<deadline;}
 function bridge(signal){const abort=()=>readAbort.abort('consumer-authority-retired');EventTarget.prototype.addEventListener.call(signal,'abort',abort,{once:true});bridges.push([signal,abort]);if(signal.aborted)abort();}
 for(const signal of [owner.signal,caller.signal,encodeGrant.signal,decodeGrant.signal,resourceGrant.signal])bridge(signal);
 function close(reason='consumer-closed'){
  if(closing)return closing;
  const completion=deferred();closing=completion.promise;retired=true;
  const observedAtMonoMs=performance.now();
  expiryObservation=Object.freeze({reason,observedAtMonoMs,originalDeadlineMonoMs:deadline,deadlineExpired:observedAtMonoMs>=deadline});
  expiryEntered.resolve(expiryObservation);
  if(deadlineTimer!==undefined){clearTimeout(deadlineTimer);deadlineTimer=undefined;}
  // Reserve the composed Promise before runtime stop invokes onClose/release.
  try{
   if(runtime&&source)runtime.setReadiness(source,'unavailable');
   connection?.stop(reason);readAbort.abort(reason);owner.abort(reason);
   const privateClose=session?.close(reason)??Promise.resolve();
   if(connection&&typeof connection.whenSettled!=='function')throw Error('consumer-runtime-settlement-required');
   const routeClose=connection?.whenSettled()??Promise.resolve();
   void(async()=>{
    await Promise.all([privateClose,routeClose,raw.join()]);await raw.join();
    await port.close(reason);assert.equal(port.pending(),0);
    if(runtime){if(source)await raw.issue('unregister-source',()=>runtime.unregister(source));if(sink)await raw.issue('unregister-sink',()=>runtime.unregister(sink));await raw.issue('runtime-close',()=>runtime.close());}
    await raw.join();for(const bytes of buffers)bytes.fill(0);buffers.clear();
    for(const [signal,listener]of bridges)EventTarget.prototype.removeEventListener.call(signal,'abort',listener);bridges.length=0;
    completion.resolve();
   })().catch(error=>completion.resolve(Promise.reject(error)));
  }catch(error){completion.resolve(Promise.reject(error));}
  return closing;
 }
 function scheduleDeadline(){
  if(retired)return;
  const remaining=deadline-performance.now();
  if(remaining<=0){void close('consumer-deadline').catch(()=>{});return;}
  deadlineTimer=setTimeout(()=>{deadlineTimer=undefined;scheduleDeadline();},Math.max(1,Math.ceil(remaining)));
 }
 session=profile.createHeadsetSbcSession({scope,executablePath:enrollment.executablePath,executableSha256:enrollment.executableSha256,ownerSignal:owner.signal,now:()=>performance.now(),port,
  authorize(request){
   assert.equal(Object.isFrozen(request),true);assert.equal(Object.isFrozen(request.scope),true);
   assert.equal(originalRequests.has(request.action),false);originalRequests.set(request.action,request);
   if(!current()||request.purpose!==PURPOSE||request.profile!==profile.HEADSET_SBC_PROFILE||!sameScope(request,scope)||!sameScope(request.scope,scope)||request.generation!==1||request.deadlineMonoMs>deadline)return undefined;
   if(mode==='encode-denied'&&request.action==='encode-selected-sbc'||mode==='decode-denied'&&request.action==='decode-verified-sbc')return undefined;
   if(mode==='decode-grant-abort'&&request.action==='decode-verified-sbc')decodeGrant.abort('qualification-revoke');
   return{request,signal:request.action==='encode-selected-sbc'?encodeGrant.signal:decodeGrant.signal,expiresMonoMs:request.deadlineMonoMs};
  }});
 function liveGeneration(context){
  if(!current()||!produced||!originalRequests.has('encode-selected-sbc')||originalRequests.get('encode-selected-sbc').purpose!==PURPOSE||session.status().generation!==produced.generation||context&&!context.isCurrent())throw Error('consumer-retired');
 }
 async function apply(observation,context){
  applies++;applyEntered.resolve();
  let verified,decoded;
  try{
   liveGeneration(context);assert.equal(observation.value,produced.generation);assert.equal(observation.source.registrationId,source.id);assert.equal(observation.source.deviceId,'software-sbc-codec');assert.equal(observation.source.capabilityId,'encoded-generation');
   bridge(context.signal);
   if(mode==='held-apply'||mode==='expiry-apply'){applyHold.entered.resolve();await applyHold.release.promise;liveGeneration(context);}
   if(mode==='resource-grant-abort')resourceGrant.abort('qualification-revoke');
   let readBytes=produced.encoded;
   if(mode==='digest-tamper'||mode==='generation-payload-tamper'){readBytes=produced.encoded.slice();buffers.add(readBytes);readBytes[8]^=1;}
   const readReference=mode==='generation-payload-tamper'?await createAssetReference(reference.id,'blob',readBytes):reference;
   if(mode==='generation-payload-tamper'){profile.inspectSelectedSbc(readBytes);checks.push('payload-mutation-has-valid-header-crc');}
   liveGeneration(context);
   verified=await readVerifiedResource({...scope,reference:readReference,chunks:ownedChunks(readBytes,raw,controls),signal:readAbort.signal,now:()=>performance.now(),
    authorize(request){return raw.issue('resource-authorizer',async()=>{
     resourceRequests.push(request);assert.equal(Object.isFrozen(request),true);assert.notEqual(request.reference,readReference);assert.ok(sameReference(request.reference,readReference));assert.ok(sameScope(request,scope));
     if(mode==='held-authorizer'||mode==='expiry-authorizer'){authorizerHold.entered.resolve();await authorizerHold.release.promise;}
     liveGeneration(context);if(mode==='resource-denied')return undefined;
     if(mode!=='generation-payload-tamper')assert.ok(sameReference(request.reference,reference));
     return{expiresAt:Math.min(deadline,originalRequests.get('encode-selected-sbc').deadlineMonoMs),maxBytes:1120};
    });}});
   buffers.add(verified);liveGeneration(context);deliveryBytes=verified.byteLength;delivered=sha(verified);profile.inspectSelectedSbc(verified);
   decoded=await session.decodeVerified({generation:produced.generation,encoded:verified});buffers.add(decoded.pcm);liveGeneration(context);
   assert.equal(decoded.samples,2048);assert.equal(decoded.pcm.byteLength,4096);
   const view=new DataView(decoded.pcm.buffer,decoded.pcm.byteOffset,decoded.pcm.byteLength);let nonzero=0;
   for(let i=0;i<2048;i++)if(view.getInt16(i*2,true)!==0)nonzero++;
   assert.ok(nonzero>0);assert.equal(delivered,sha(produced.encoded));
   decodeFacts={format:'mono-S16LE',sampleRateHz:44100,samples:2048,pcmBytes:4096,nonzeroSamples:nonzero,pcmSha256:sha(decoded.pcm),synthetic:mode!=='normal'};
   checks.push('exact-public-resource-delivery','private-original-generation-decoder','nonzero-decoded-pcm');
  }catch(error){applyError=String(error?.message??error);await session.close('apply-failed');throw error;}
  finally{verified?.fill(0);decoded?.pcm.fill(0);applyDone.resolve();}
 }
 try{
  if(mode==='owner-abort')owner.abort('qualification-revoke');
  if(mode==='caller-abort')caller.abort('qualification-revoke');
  if(mode==='encode-grant-abort')encodeGrant.abort('qualification-revoke');
  const producing=session.produce({purpose:mode==='wrong-purpose'?'wrong purpose':PURPOSE,signal:caller.signal,deadlineMonoMs:mode==='expired'?performance.now()-1:deadline});
  scheduleDeadline();
  if(['encode-denied','wrong-purpose','owner-abort','caller-abort','encode-grant-abort','expired'].includes(mode)){
   await assert.rejects(producing);assert.equal(port.receipts().length,0);checks.push('private-encode-denial-no-codec-issue');
  }else{
   produced=await producing;buffers.add(produced.encoded);producedBytes=produced.encoded.byteLength;profile.inspectSelectedSbc(produced.encoded);
   reference=await createAssetReference(`headset-sbc:gen-${produced.generation}`,'blob',produced.encoded);liveGeneration();
   const value={type:'scalar',unit:'1',min:1,max:1,resolution:1};
   const device=parseDeviceDescriptor({schemaVersion:1,id:'software-sbc-codec',label:'Selected software audio resource',revision:1,adapter:{id:'example:headset-sbc',version:'1.0.0'},runtime:{platform:'node-software'},capabilities:[
    {id:'encoded-generation',semantic:'audio:resource-generation',schemaVersion:1,kind:'sample',value,delivery:{mode:'latest',maxHz:10,maxAgeMs:5000},permissions:['subscribe']},
    {id:'decoded-generation',semantic:'audio:resource-generation',schemaVersion:1,kind:'property',value,delivery:{mode:'latest',maxHz:10,maxAgeMs:5000},permissions:['write'],ownership:{mode:'observe'}}]});
   runtime=createDeviceRuntime({authorize(request){
    routeRequests.push(request);if(mode==='route-denied'||!current()||routeIdentity(request)!==routeIdentity(expectedRoute))return undefined;
    const original=originalRequests.get('encode-selected-sbc');if(!original||original.purpose!==PURPOSE||original.generation!==produced.generation)return undefined;
    return{expiresAt:Math.min(deadline,original.deadlineMonoMs),maxAgeMs:5000,maxHz:10};
   }});
   source=runtime.registerSource({device,capability:'encoded-generation'});
   sink=runtime.registerSink({device,capability:'decoded-generation',apply(observation,context){applyPromise=raw.issue('sink-apply',()=>apply(observation,context));applyPromise.catch(()=>{});return applyPromise;},release(){
    void raw.issue('sink-release',()=>{releaseCalls++;if(mode==='release-reentry'){assert.equal(close('release-reentry'),closing);checks.push('idempotent-close-during-release');}}).catch(()=>{});
   }});
   expectedRoute={...scope,source:{registrationId:source.id,deviceId:device.id,capabilityId:'encoded-generation',descriptorRevision:1,schemaVersion:1},sink:{registrationId:sink.id,deviceId:device.id,capabilityId:'decoded-generation',descriptorRevision:1,schemaVersion:1},sourceOperation:'subscribe',sinkOperation:'write'};
   const mismatch=/^reference-(source|sink)-(registration|device|capability|revision|schema)$/.exec(mode);
   if(mismatch){const keys={registration:'registrationId',device:'deviceId',capability:'capabilityId',revision:'descriptorRevision',schema:'schemaVersion'};expectedRoute[mismatch[1]][keys[mismatch[2]]]=['revision','schema'].includes(mismatch[2])?2:'different';}
   if(mode==='source-operation')expectedRoute.sourceOperation='read';if(mode==='sink-operation')expectedRoute.sinkOperation='invoke';
   runtime.setReadiness(source,'available');runtime.setReadiness(sink,'available');
   const routeScope={...scope};if(mode==='scope-principal')routeScope.principalId='other';if(mode==='scope-application')routeScope.applicationId='other';if(mode==='scope-session')routeScope.sessionId='other';
   connection=runtime.route({from:source,to:sink,...routeScope,sourceOperation:'subscribe',leaseMs:5000,queueCapacity:1});
   assert.equal(typeof connection.whenSettled,'function');connection.onClose(reason=>{void raw.issue('route-close-listener',()=>{void close(reason).catch(()=>{});}).catch(()=>{});});
   const started=connection.start();
   if(mode==='route-denied'||mode.startsWith('scope-')||mismatch||mode==='source-operation'||mode==='sink-operation'){
    assert.deepEqual(started,{ok:false,reason:'denied'});assert.equal(applies,0);assert.equal(port.receipts().length,1);checks.push('exact-public-authority-denial-no-resource-or-decoder');
   }else{
    assert.ok(started.ok,JSON.stringify(started));assert.ok(runtime.publish(source,produced.generation).ok);runtime.flush();await setupEntry(applyEntered,'apply');
    if(mode.startsWith('held-')||mode.startsWith('expiry-')){
     const kind=mode.slice(mode.indexOf('-')+1),held={authorizer:authorizerHold,next:nextHold,return:nextHold,decoder:decoderHold,apply:applyHold}[kind];await setupEntry(held.entered,kind);
     if(mode.startsWith('expiry-')){const observed=await expiryEntered.promise;assert.equal(observed.originalDeadlineMonoMs,deadline);assert.equal(observed.deadlineExpired,observed.observedAtMonoMs>=deadline);assert.equal(readAbort.signal.aborted,true);checks.push(observed.deadlineExpired?'original-deadline-observed-expired':'authority-retired-before-original-deadline');}
     let closed=false,routeJoined=false;const closingNow=close(mode.startsWith('expiry-')?'expired-raw-retirement':'held-raw-retirement').then(()=>{closed=true;});const actualBarrier=connection.whenSettled().then(()=>{routeJoined=true;});
     await turn();assert.equal(closed,false,'composed close must join actual held raw return');
     if(kind==='apply'||kind==='decoder')assert.equal(routeJoined,false,'actual apply return remains reserved by runtime');
     if(kind==='return'){await returnHold.entered.promise;nextHold.release.resolve();await turn();assert.equal(closed,false,'terminal-return wrapper remains held after next joins');returnHold.release.resolve();}
     else held.release.resolve();
     await closingNow;await actualBarrier;await applyPromise.catch(()=>{});assert.equal(decodeFacts,undefined);checks.push('close-pending-until-actual-'+kind+'-return','no-post-retirement-pcm-publication');if(mode.startsWith('expiry-'))checks.push('original-authority-retirement-aborts-public-read-without-releasing-held-raw');
    }else{
     const denied=['decode-denied','decode-grant-abort','resource-denied','resource-grant-abort','digest-tamper','generation-payload-tamper'].includes(mode);
     if(denied){await assert.rejects(applyPromise);assert.equal(decodeFacts,undefined);expectedError=applyError;checks.push('independent-'+mode+'-denial');assert.equal(port.receipts().filter(r=>r.action==='decode-verified-sbc').length,0);if(mode==='decode-denied'||mode==='decode-grant-abort'){assert.equal(deliveryBytes,1120);assert.equal(delivered,reference.sha256);assert.equal(resourceRequests.length,1);assert.equal(originalRequests.get('decode-verified-sbc')?.action,'decode-verified-sbc');assert.equal(applyError,mode==='decode-denied'?'sbc-data':'sbc-grant');checks.push('private-decode-denial-after-complete-public-read-zero-decoder-issues');}}
     else{await applyPromise;assert.equal(applies,1);assert.equal(producedBytes,1120);assert.equal(deliveryBytes,1120);assert.ok(decodeFacts);}
    }
   }
  }
 }finally{
  for(const held of allHolds)held.release.resolve();await close('consumer-finally');await applyPromise?.catch(()=>{});await raw.join();
 }
 assert.equal(raw.status().pending,0);assert.equal(port.pending(),0);assert.deepEqual(session.status(),{phase:'closed',generation:1,pendingAuthorizers:0,pendingIssues:0,pendingRaw:0,uncertainProcesses:0,timers:0,listeners:0});
 assert.equal(bridges.length,0);assert.equal(buffers.size,0);assert.equal(deadlineTimer,undefined);
 const result={status:'pass',kind:'selected-sbc-software-resource',mode,profile:profile.HEADSET_SBC_PROFILE,codecEffect:mode==='normal'?'actual-pinned-ffmpeg':'explicit-test-owned-port',physical:false,fullW06:false,nativeProfileDeniedAllHosts:true,
  checks,producedBytes:producedBytes??0,producerSha256:reference?.sha256,deliveredBytes:deliveryBytes??0,deliveredSha256:delivered,decoded:decodeFacts,expectedError,
  originalPrivateRequests:originalRequests.size,actualPublicRouteRequests:routeRequests.length,actualResourceReadRequests:resourceRequests.length,resourceParsedReferenceDistinct:resourceRequests.length?true:undefined,resourceTerminalReturnCalls:controls.returnCalls,
  applies,releaseCalls,expiryObservation:mode.startsWith('expiry-')?expiryObservation:undefined,lifecycle:{profile:session.status(),raw:raw.status(),portPending:port.pending(),route:connection?.status(),listeners:bridges.length,ownedByteBuffers:buffers.size,ownedTimers:deadlineTimer===undefined?0:1},codecReceipts:port.receipts(),
  limitations:['No Bluetooth or headset connection','No acoustic playback','Controls and vendor sensors absent','Trusted ambient host closure, no atomic execution sandbox']};
 if(receiptPath!==undefined)await fs.writeFile(receiptPath,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 return result;
}
