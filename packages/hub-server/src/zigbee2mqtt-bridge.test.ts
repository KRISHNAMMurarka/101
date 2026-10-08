import assert from 'node:assert/strict';
import test from 'node:test';
import {appendFileSync} from 'node:fs';
const profile = { id: 'example:zigbee2mqtt-switch', revision: 1, ieeeAddress: '0x0000000000000007', model: 'WXKG01LM', baseTopic: 'zigbee2mqtt' };
function checkedSettlement(results:PromiseSettledResult<unknown>[]) {const errors=results.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason);assert.equal(errors.length,0,errors.map(String).join('\n'));}
const api = await import('./zigbee2mqtt-bridge.ts').catch(() => undefined);
const bytes = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
function metadata() { return [{ ieee_address: profile.ieeeAddress, friendly_name: profile.ieeeAddress, supported: true, disabled: false, interview_state: 'SUCCESSFUL', definition: { model: 'WXKG01LM', exposes: [
  { type: 'numeric', name: 'battery', property: 'battery', access: 1, unit: '%' },
  { type: 'enum', name: 'action', property: 'action', access: 1, values: ['single','double','triple','quadruple','hold','release','many'] },
] } }]; }
test('native parser exists and preserves reported fields without inventing capture', () => {
  assert.equal(typeof api?.decodeZigbee2MqttMessage, 'function'); assert.ok(api);
  const p = api.parseZigbee2MqttProfile(profile);
  assert.deepEqual(api.decodeZigbee2MqttMessage('zigbee2mqtt/'+p.ieeeAddress, bytes({battery:75,action:'single'}),false,p), {kind:'state',retained:false,battery:75,action:'single'});
  assert.deepEqual(api.decodeZigbee2MqttMessage('zigbee2mqtt/bridge/devices',bytes(metadata()),true,p), {kind:'metadata',compatible:true});
  assert.deepEqual(api.decodeZigbee2MqttMessage('zigbee2mqtt/bridge/state',bytes({state:'online'}),true,p), {kind:'bridge-status',online:true});
});
test('native parser rejects ambiguous malformed byte and metadata boundaries', () => {
  assert.ok(api); const p=api.parseZigbee2MqttProfile(profile), topic='zigbee2mqtt/'+p.ieeeAddress;
  for(const value of ['{"battery":-1}','{"battery":101}','{"battery":null}','{"battery":"75"}','{"battery":1e999}','{"action":"click"}','{"click":"single"}','{"battery":1,"batt\\u0065ry":2}','{"__proto__":{}}','[1]','{"battery":1}x'])
    {assert.throws(()=>api.decodeZigbee2MqttMessage(topic,bytes(value),false,p),value);if(process.env.ZIGBEE_REJECTED_BYTES)appendFileSync(process.env.ZIGBEE_REJECTED_BYTES,JSON.stringify({name:value,hex:bytes(value).toString('hex')})+'\n');}
  assert.throws(()=>api.decodeZigbee2MqttMessage(topic,new Uint8Array([0xc0,0xaf]),false,p));
  assert.throws(()=>api.decodeZigbee2MqttMessage(topic,bytes(' '.repeat(8193)),false,p));
  assert.throws(()=>api.parseZigbee2MqttProfile(new Proxy(profile,{})));
  assert.throws(()=>api.parseZigbee2MqttProfile({...profile,revision:0}));
  for(const change of ['duplicate','model','name','unit','access','action','endpoint','missing']) {
    const m=metadata(); const d=m[0]!;
    if(change==='duplicate')m.push(d);if(change==='model')d.definition.model='OTHER';if(change==='name')d.friendly_name='other';
    if(change==='unit')d.definition.exposes[0]!.unit='V';if(change==='access')d.definition.exposes[0]!.access=3;
    if(change==='action')d.definition.exposes[1]!.values=['single'];if(change==='endpoint')Object.assign(d.definition.exposes[0]!,{endpoint:'2'});
    if(change==='missing')m.splice(0);
    const decoded=api.decodeZigbee2MqttMessage('zigbee2mqtt/bridge/devices',bytes(m),true,p);assert.equal(decoded.kind,'metadata');if(decoded.kind!=='metadata')assert.fail('metadata required');assert.equal(decoded.compatible,false,change);
  }
});

test('native authority rejects expired original deadlines and nonstandard signals before callout', async()=>{
  assert.equal(typeof api?.createZigbee2MqttBridge,'function'); assert.ok(api);
  const owner=new AbortController(),grant=new AbortController();let calls=0;
  const make=()=>api.createZigbee2MqttBridge({endpoint:'mqtt://127.0.0.1:44444',profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>{calls++;return{request,signal:grant.signal,expiresAt:performance.now()+30000};},onReading(){},onUnavailable(){}});
  for(const deadline of [performance.now()-1,performance.now()+31000]){const c=make();assert.equal((await c.start({purpose:'read',signal:owner.signal,deadline})).ok,false);assert.equal(c.status().nativeClients,0);await c.close();}
  assert.equal(calls,0);
  assert.throws(()=>api.createZigbee2MqttBridge({endpoint:'mqtt://127.0.0.1:44444',profile,ownerSignal:new Proxy(owner.signal,{}),scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize(){return undefined;},onReading(){},onUnavailable(){}}));
  const c=make();await assert.rejects(c.start({purpose:'read',signal:Object.create(owner.signal),deadline:performance.now()+1000}));await c.close();assert.equal(calls,0);
});

test('native retained prerequisites allow only new state and offline withdraws synchronously',async()=>{
  assert.ok(api);assert.equal(typeof api.createZigbee2MqttBridge,'function');
  const {startOwnedZigbeeBroker:startOwnedMqttBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');
  const {connectAsync}=await import('mqtt');const broker=await startOwnedMqttBroker(),publisher=await connectAsync(broker.endpoint,{protocolVersion:5,clean:true,reconnectPeriod:0});
  const owner=new AbortController(),grant=new AbortController(),readings:unknown[]=[],withdraw:string[]=[];
  const c=api.createZigbee2MqttBridge({endpoint:broker.endpoint,profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>{assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request.scope));return{request,signal:grant.signal,expiresAt:performance.now()+20000};},onReading:r=>readings.push(r),onUnavailable:r=>withdraw.push(r)});
  const until=async(p:()=>boolean)=>{const d=performance.now()+1500;while(!p()){assert.ok(performance.now()<d,JSON.stringify(c.status()));await new Promise(r=>setTimeout(r,5));}};
  try{
    await publisher.publishAsync('zigbee2mqtt/bridge/devices',bytes(metadata()),{qos:0,retain:true});await publisher.publishAsync('zigbee2mqtt/bridge/state',bytes({state:'online'}),{qos:0,retain:true});await publisher.publishAsync('zigbee2mqtt/'+profile.ieeeAddress+'/availability',bytes({state:'online'}),{qos:1,retain:true});
    await publisher.publishAsync('zigbee2mqtt/'+profile.ieeeAddress,bytes({battery:75,action:'single'}),{qos:0,retain:true});
    const deadline=performance.now()+10000;assert.equal((await c.start({purpose:'read',signal:owner.signal,deadline})).ok,true);assert.equal(readings.length,0);
    for(let n=1;n<=2;n++){await publisher.publishAsync('zigbee2mqtt/'+profile.ieeeAddress,bytes({action:'single'}),{qos:0,retain:false});await until(()=>readings.length===n);}
    assert.equal(c.status().delivered,2);await publisher.publishAsync('zigbee2mqtt/'+profile.ieeeAddress+'/availability',bytes({state:'offline'}),{qos:1,retain:false});await until(()=>withdraw.length===1);assert.notEqual(c.status().phase,'ready');
    await c.close();assert.equal(c.status().nativeClients,0);assert.equal(c.status().phase,'closed');
  }finally{await Promise.allSettled([c.close(),publisher.endAsync(true)]);await broker.close();}
});

test('native held SUBACK charges quotas and close joins held issued leg',async()=>{
  assert.ok(api);const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {connectAsync,MqttClient}=await import('mqtt');
  const broker=await startOwnedZigbeeBroker(),p=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});
  const original=MqttClient.prototype.subscribeAsync;let release!:()=>void,held=false;
  MqttClient.prototype.subscribeAsync=function(...args){const issued=Reflect.apply(original,this,args) as ReturnType<typeof original>;return issued.then(v=>new Promise<Awaited<ReturnType<typeof original>>>(resolve=>{held=true;release=()=>resolve(v);}));};
  const owner=new AbortController(),grant=new AbortController(),received:unknown[]=[];
  const c=api.createZigbee2MqttBridge({endpoint:broker.endpoint,profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>({request,signal:grant.signal,expiresAt:performance.now()+10000}),onReading:r=>received.push(r),onUnavailable(){}});
  const until=async(pred:()=>boolean)=>{const d=performance.now()+1500;while(!pred()){assert.ok(performance.now()<d,JSON.stringify(c.status()));await new Promise(r=>setTimeout(r,5));}};
  try{const starting=c.start({purpose:'read',signal:owner.signal,deadline:performance.now()+10000});await until(()=>held);
    await p.publishAsync('zigbee2mqtt/bridge/devices',bytes(metadata()),{qos:0,retain:true});await p.publishAsync('zigbee2mqtt/bridge/state',bytes({state:'online'}),{qos:0,retain:true});await p.publishAsync('zigbee2mqtt/'+profile.ieeeAddress+'/availability',bytes({state:'online'}),{qos:1,retain:true});await until(()=>c.status().messages===3);
    for(let i=0;i<254;i++)await p.publishAsync('zigbee2mqtt/'+profile.ieeeAddress,bytes({action:'single'}),{qos:0});
    await until(()=>c.status().messages===257);assert.equal((await starting).ok,false);assert.equal(c.status().reason,'quota');assert.equal(received.length,0);
    let closed=false;const closing=c.close().then(()=>{closed=true;});await new Promise(r=>setTimeout(r,30));assert.equal(closed,false);assert.equal(c.status().nativeClients,1);
    release();await closing;assert.equal(c.status().nativeClients,0);
  }finally{if(release)release();MqttClient.prototype.subscribeAsync=original;const r=await Promise.allSettled([c.close(),p.endAsync(true),broker.close()]);checkedSettlement(r);}
});

test('native original deadline clamps grant and callback revocation fences delivery',async()=>{
  assert.ok(api);const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {connectAsync}=await import('mqtt');const broker=await startOwnedZigbeeBroker(),p=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});
  const owner=new AbortController(),grant=new AbortController();let calls=0;const deadline=performance.now()+1000;
  const c=api.createZigbee2MqttBridge({endpoint:broker.endpoint,profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>{assert.equal(request.originalDeadline,deadline);return{request,signal:grant.signal,expiresAt:performance.now()+30000};},onReading(){calls++;grant.abort();},onUnavailable(){throw new Error('diagnostic-held-truth');}});
  try{await p.publishAsync('zigbee2mqtt/bridge/devices',bytes(metadata()),{qos:0,retain:true});await p.publishAsync('zigbee2mqtt/bridge/state',bytes({state:'online'}),{qos:0,retain:true});await p.publishAsync('zigbee2mqtt/'+profile.ieeeAddress+'/availability',bytes({state:'online'}),{qos:1,retain:true});assert.equal((await c.start({purpose:'read',signal:owner.signal,deadline})).ok,true);
    await p.publishAsync('zigbee2mqtt/'+profile.ieeeAddress,bytes({action:'hold'}),{qos:0});const d=performance.now()+500;while(calls===0){assert.ok(performance.now()<d);await new Promise(r=>setTimeout(r,5));}
    assert.equal(c.status().delivered,0);await c.close();assert.equal(c.status().reason,'revoked');assert.ok(c.status().failures.some(v=>v.includes('diagnostic-held-truth')));
  }finally{const r=await Promise.allSettled([c.close(),p.endAsync(true),broker.close()]);checkedSettlement(r);}
});

test('ordinary public property and event caller exists',async()=>{
  const caller=await import('../../../examples/zigbee2mqtt-bridge/consumer.mjs').catch(()=>undefined);
  assert.equal(typeof caller?.runZigbee2MqttBridgeConsumer,'function');assert.ok(caller);const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const broker=await startOwnedZigbeeBroker();try{const result=await caller.runZigbee2MqttBridgeConsumer(broker.endpoint);assert.ok(result);assert.equal(result.status,'pass');}finally{await broker.close();}
});

test('ordinary caller permits MQTT delivery before producer IPC acknowledgement',async()=>{
  const {ChildProcess}=await import('node:child_process');const original=ChildProcess.prototype.emit;
  ChildProcess.prototype.emit=function(this:InstanceType<typeof ChildProcess>,event:string|symbol,...args:unknown[]){if(event==='message'&&(args[0] as {kind?:string})?.kind==='published'){setTimeout(()=>Reflect.apply(original,this,[event,...args]) as boolean,20);return true;}return Reflect.apply(original,this,[event,...args]) as boolean;};
  const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {runZigbee2MqttBridgeConsumer}=await import('../../../examples/zigbee2mqtt-bridge/consumer.mjs');const broker=await startOwnedZigbeeBroker();
  try{const result=await runZigbee2MqttBridgeConsumer(broker.endpoint);assert.ok(result);assert.equal(result.status,'pass');}finally{ChildProcess.prototype.emit=original;await broker.close();}
});

test('native byte quota bounds pending subscription independently of message quota',async()=>{
  assert.ok(api);const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {connectAsync,MqttClient}=await import('mqtt');const broker=await startOwnedZigbeeBroker(),p=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});
  const original=MqttClient.prototype.subscribeAsync;let release!:()=>void,held=false;
  MqttClient.prototype.subscribeAsync=function(...args){const issued=Reflect.apply(original,this,args) as ReturnType<typeof original>;return issued.then(v=>new Promise<Awaited<ReturnType<typeof original>>>(resolve=>{held=true;release=()=>resolve(v);}));};
  const owner=new AbortController(),grant=new AbortController();const c=api.createZigbee2MqttBridge({endpoint:broker.endpoint,profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>({request,signal:grant.signal,expiresAt:performance.now()+10000}),onReading(){assert.fail('preSUBACK must discard');},onUnavailable(){}});
  const until=async(pred:()=>boolean)=>{const d=performance.now()+1500;while(!pred()){assert.ok(performance.now()<d);await new Promise(r=>setTimeout(r,5));}};
  try{const starting=c.start({purpose:'read',signal:owner.signal,deadline:performance.now()+10000});await until(()=>held);
    for(let i=0;i<132;i++){await p.publishAsync('zigbee2mqtt/'+profile.ieeeAddress,Buffer.from('{"action":"single"}'.padEnd(8000)),{qos:0});await until(()=>c.status().messages===i+1);}
    await until(()=>c.status().reason==='quota');assert.equal((await starting).ok,false);assert.ok(c.status().messages<256);assert.ok(c.status().receivedBytes>1048576);release();await c.close();
  }catch(e){throw new Error(JSON.stringify({message:String(e),status:c.status(),broker:broker.logs()}),{cause:e});}finally{if(release)release();MqttClient.prototype.subscribeAsync=original;const outcomes=await Promise.allSettled([c.close(),p.endAsync(true),broker.close()]);checkedSettlement(outcomes);}
});

test('native retirement joins failed end and held subscribe independently',async()=>{
  assert.ok(api);const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {MqttClient}=await import('mqtt');const broker=await startOwnedZigbeeBroker();
  const subscribe=MqttClient.prototype.subscribeAsync,end=MqttClient.prototype.endAsync;let release!:()=>void,held=false,nativeClosed=false;
  MqttClient.prototype.subscribeAsync=function(...args){return (Reflect.apply(subscribe,this,args) as ReturnType<typeof subscribe>).then(v=>new Promise<Awaited<ReturnType<typeof subscribe>>>(resolve=>{held=true;release=()=>resolve(v);}));};
  MqttClient.prototype.endAsync=async function(...args){const stream=this.stream;const closed=new Promise<void>(r=>{if(stream.closed)r();else stream.once('close',()=>{nativeClosed=true;r();});});await Promise.allSettled([Reflect.apply(end,this,args),closed]);throw new Error('controlled-real-end-rejection');};
  const owner=new AbortController(),grant=new AbortController();const c=api.createZigbee2MqttBridge({endpoint:broker.endpoint,profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>({request,signal:grant.signal,expiresAt:performance.now()+5000}),onReading(){},onUnavailable(){}});
  try{const starting=c.start({purpose:'read',signal:owner.signal,deadline:performance.now()+5000});const d=performance.now()+1000;while(!held){assert.ok(performance.now()<d);await new Promise(r=>setTimeout(r,5));}
    let settled=false;const closing=c.stop();void closing.finally(()=>{settled=true;}).catch(()=>{});await new Promise(r=>setTimeout(r,30));assert.equal(nativeClosed,true);assert.equal(settled,false);assert.equal(c.status().nativeClients,1);assert.equal((await starting).ok,false);
    release();await assert.rejects(closing,/native retirement failed/);assert.equal(c.status().phase,'retiring');assert.equal(c.status().nativeClients,1);
  }finally{if(release)release();MqttClient.prototype.subscribeAsync=subscribe;MqttClient.prototype.endAsync=end;await c.close().catch(()=>{});await broker.close();}
});

test('native absolute original deadline expires quiet standing grant without device offline inference',async()=>{
  assert.ok(api);const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {connectAsync}=await import('mqtt');const broker=await startOwnedZigbeeBroker(),p=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});const owner=new AbortController(),grant=new AbortController(),unavailable:string[]=[];
  const c=api.createZigbee2MqttBridge({endpoint:broker.endpoint,profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>({request,signal:grant.signal,expiresAt:performance.now()+30000}),onReading(){},onUnavailable:r=>unavailable.push(r)});
  try{for(const [topic,value,qos] of [['zigbee2mqtt/bridge/devices',metadata(),0],['zigbee2mqtt/bridge/state',{state:'online'},0],['zigbee2mqtt/'+profile.ieeeAddress+'/availability',{state:'online'},1]] as const)await p.publishAsync(topic,bytes(value),{qos,retain:true});
    assert.equal((await c.start({purpose:'read',signal:owner.signal,deadline:performance.now()+150})).ok,true);await new Promise(r=>setTimeout(r,50));assert.equal(c.status().phase,'ready');assert.equal(unavailable.length,0);await new Promise(r=>setTimeout(r,130));await c.close();assert.equal(c.status().reason,'expired');assert.deepEqual(unavailable,['expired']);
  }finally{const results=await Promise.allSettled([c.close(),p.endAsync(true),broker.close()]);checkedSettlement(results);}
});

test('native prerequisites held before SUBACK never replay pending input after activation',async()=>{
  assert.ok(api);const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {connectAsync,MqttClient}=await import('mqtt');const broker=await startOwnedZigbeeBroker(),p=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});const original=MqttClient.prototype.subscribeAsync;let held=false,release!:()=>void;
  MqttClient.prototype.subscribeAsync=function(...args){return (Reflect.apply(original,this,args) as ReturnType<typeof original>).then(v=>new Promise<Awaited<ReturnType<typeof original>>>(resolve=>{held=true;release=()=>resolve(v);}));};
  const owner=new AbortController(),grant=new AbortController(),readings:unknown[]=[];const c=api.createZigbee2MqttBridge({endpoint:broker.endpoint,profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>({request,signal:grant.signal,expiresAt:performance.now()+10000}),onReading:r=>readings.push(r),onUnavailable(){}});
  const until=async(pred:()=>boolean)=>{const d=performance.now()+1500;while(!pred()){assert.ok(performance.now()<d,JSON.stringify(c.status()));await new Promise(r=>setTimeout(r,5));}};
  try{const starting=c.start({purpose:'read',signal:owner.signal,deadline:performance.now()+10000});await until(()=>held);for(const [topic,value,qos] of [['zigbee2mqtt/bridge/devices',metadata(),0],['zigbee2mqtt/bridge/state',{state:'online'},0],['zigbee2mqtt/'+profile.ieeeAddress+'/availability',{state:'online'},1],['zigbee2mqtt/'+profile.ieeeAddress,{action:'single'},0]] as const)await p.publishAsync(topic,bytes(value),{qos,retain:topic!=='zigbee2mqtt/'+profile.ieeeAddress});
    await until(()=>c.status().messages===4);assert.equal(readings.length,0);release();assert.equal((await starting).ok,true);assert.equal(readings.length,0);await p.publishAsync('zigbee2mqtt/'+profile.ieeeAddress,bytes({action:'single'}),{qos:0});await until(()=>readings.length===1);
    const changed=metadata();changed[0]!.friendly_name='renamed';await p.publishAsync('zigbee2mqtt/bridge/devices',bytes(changed),{qos:0,retain:true});await until(()=>c.status().reason==='metadata-incompatible');await c.close();assert.equal(c.status().nativeClients,0);
  }finally{if(release)release();MqttClient.prototype.subscribeAsync=original;const rs=await Promise.allSettled([c.close(),p.endAsync(true),broker.close()]);checkedSettlement(rs);}
});


test('native stale callback cannot charge another owner instance and held close remains pending',async()=>{
  assert.ok(api);const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {connectAsync,MqttClient}=await import('mqtt');const broker=await startOwnedZigbeeBroker(),publisher=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});
  const subscribe=MqttClient.prototype.subscribeAsync,end=MqttClient.prototype.endAsync;const observedClients:InstanceType<typeof MqttClient>[]=[];let active:InstanceType<typeof MqttClient>|undefined,release!:()=>void,holdEnd=true;
  MqttClient.prototype.subscribeAsync=function(...args){observedClients.push(this);active=observedClients.at(-1);return Reflect.apply(subscribe,this,args) as ReturnType<typeof subscribe>;};
  MqttClient.prototype.endAsync=async function(...args){if(holdEnd&&this===active)await new Promise<void>(resolve=>{release=resolve;});return Reflect.apply(end,this,args) as ReturnType<typeof end>;};
  const owner=new AbortController(),grant=new AbortController();let nativeArgs:unknown[]|undefined;
  const make=()=>api!.createZigbee2MqttBridge({endpoint:broker.endpoint,profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>({request,signal:grant.signal,expiresAt:performance.now()+10000}),onReading(){},onUnavailable(){}});
  const first=make();let second:ReturnType<typeof make>|undefined;
  const until=async(pred:()=>boolean)=>{const d=performance.now()+1500;while(!pred()){assert.ok(performance.now()<d);await new Promise(r=>setTimeout(r,5));}};
  try{for(const [topic,value,qos] of [['zigbee2mqtt/bridge/devices',metadata(),0],['zigbee2mqtt/bridge/state',{state:'online'},0],['zigbee2mqtt/'+profile.ieeeAddress+'/availability',{state:'online'},1]] as const)await publisher.publishAsync(topic,bytes(value),{qos,retain:true});assert.equal((await first.start({purpose:'read',signal:owner.signal,deadline:performance.now()+10000})).ok,true);assert.ok(active);
    const stale=active.listeners('message')[0]!;active.on('message',(...args)=>{nativeArgs=args;});await publisher.publishAsync('zigbee2mqtt/'+profile.ieeeAddress,bytes({action:'single'}),{qos:0});await until(()=>!!nativeArgs);const oldMessages=first.status().messages;
    let settled=false;const stopping=first.stop(),closing=first.close();assert.equal(stopping,closing);void stopping.then(()=>{settled=true;});await new Promise(r=>setTimeout(r,20));assert.equal(settled,false);assert.equal(first.status().nativeClients,1);assert.ok(release);holdEnd=false;release();await closing;assert.equal(first.status().nativeClients,0);
    second=make();assert.equal((await second.start({purpose:'read',signal:owner.signal,deadline:performance.now()+10000})).ok,true);const before=second.status().messages;Reflect.apply(stale,active,nativeArgs!);assert.equal(first.status().messages,oldMessages);assert.equal(second.status().messages,before);assert.equal(second.status().delivered,0);
  }finally{holdEnd=false;if(release)release();MqttClient.prototype.subscribeAsync=subscribe;MqttClient.prototype.endAsync=end;checkedSettlement(await Promise.allSettled([first.close(),second?.close()??Promise.resolve(),publisher.endAsync(true),broker.close()]));}
});

test('native descriptor snapshots reject callout substitution and hostile grants before any socket',async()=>{
  assert.ok(api);let getters=0;assert.throws(()=>api.parseZigbee2MqttProfile({...profile,get model(){getters++;return 'WXKG01LM';}}));assert.equal(getters,0);
  for(const kind of ['forged','proxy','inherited','reentrant','throw'] as const){const owner=new AbortController(),grant=new AbortController();let calls=0,withdrawals=0;
    const mutable={endpoint:'mqtt://127.0.0.1:44444',profile:{...profile},ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize(request:Parameters<NonNullable<typeof api>['createZigbee2MqttBridge']>[0]['authorize'] extends (r:infer T)=>unknown?T:never){
      calls++;assert.equal(request.profile.model,'WXKG01LM');assert.ok(Object.isFrozen(request.profile));assert.ok(Object.isFrozen(request.topics));assert.ok(Object.isFrozen(request.budgets));mutable.profile.model='OTHER';
      if(kind==='throw')throw new Error('actual-authorizer-rejection');if(kind==='reentrant')owner.abort();return{request:kind==='forged'?{...request}:request,signal:kind==='proxy'?new Proxy(grant.signal,{}):kind==='inherited'?Object.create(grant.signal) as AbortSignal:grant.signal,expiresAt:performance.now()+5000};
    },onReading(){assert.fail('denied must not deliver');},onUnavailable(){withdrawals++;}};
    const c=api.createZigbee2MqttBridge(mutable);assert.equal((await c.start({purpose:'read',signal:owner.signal,deadline:performance.now()+5000})).ok,false);assert.equal(calls,1);assert.equal(withdrawals,1);assert.equal(c.status().nativeClients,0);await c.close();
  }
});

test('native missing availability settles deadline and callback failure retires actual socket',async()=>{
  assert.ok(api);const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {connectAsync}=await import('mqtt');const broker=await startOwnedZigbeeBroker(),p=await connectAsync(broker.endpoint,{protocolVersion:5,reconnectPeriod:0});const owner=new AbortController(),grant=new AbortController();let callbacks=0;
  const make=()=>api!.createZigbee2MqttBridge({endpoint:broker.endpoint,profile,ownerSignal:owner.signal,scope:{principalId:'p',applicationId:'a',sessionId:'s'},authorize:request=>({request,signal:grant.signal,expiresAt:performance.now()+10000}),onReading(){callbacks++;throw new Error('actual-reading-callback-failure');},onUnavailable(){}});
  const missing=make(),live=make();
  try{await p.publishAsync('zigbee2mqtt/bridge/devices',bytes(metadata()),{qos:0,retain:true});await p.publishAsync('zigbee2mqtt/bridge/state',bytes({state:'online'}),{qos:0,retain:true});assert.equal((await missing.start({purpose:'read',signal:owner.signal,deadline:performance.now()+150})).ok,false);await missing.close();assert.equal(missing.status().nativeClients,0);assert.equal(callbacks,0);
    await p.publishAsync('zigbee2mqtt/'+profile.ieeeAddress+'/availability',bytes({state:'online'}),{qos:1,retain:true});assert.equal((await live.start({purpose:'read',signal:owner.signal,deadline:performance.now()+5000})).ok,true);await p.publishAsync('zigbee2mqtt/'+profile.ieeeAddress,bytes({action:'single'}),{qos:0});const d=performance.now()+1000;while(callbacks===0){assert.ok(performance.now()<d);await new Promise(r=>setTimeout(r,5));}await live.close();assert.equal(live.status().nativeClients,0);assert.equal(live.status().delivered,0);assert.equal(live.status().reason,'protocol-or-callback');assert.ok(live.status().failures.some(v=>v.includes('actual-reading-callback-failure')));
  }finally{checkedSettlement(await Promise.allSettled([missing.close(),live.close(),p.endAsync(true),broker.close()]));}
});

// Hold authentic native close delivery after actual exit; no synthetic lifecycle success.
const nativePause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function nativeUntil(predicate:()=>boolean,label:string){const end=performance.now()+5000;while(!predicate()){assert.ok(performance.now()<end,label);await nativePause(5);}}
function hasNativeTimeout(error:unknown,message:string):boolean{return error instanceof Error&&(error.message.includes(message)||hasNativeTimeout(error.cause,message)||(error instanceof AggregateError&&error.errors.some(e=>hasNativeTimeout(e,message))));}
test('owned broker timeout keeps authentic close ownership and directory until rejected settlement',async()=>{
  const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {existsSync}=await import('node:fs');const {dirname}=await import('node:path');
  const broker=await startOwnedZigbeeBroker(),original=broker.child.emit,directory=dirname(broker.child.spawnargs[2]!);let held:unknown[]|undefined,settled=false,closing:Promise<void>|undefined;
  broker.child.emit=function(event:string|symbol,...args:unknown[]){if(event==='close'){held=[event,...args];return true;}return Reflect.apply(original,this,[event,...args]) as boolean;};
  try{closing=broker.close();assert.ok(closing);void closing.then(()=>{settled=true;},()=>{settled=true;});await nativeUntil(()=>!!held,'real broker close absent');assert.equal(broker.child.exitCode,0);await nativePause(2100);assert.equal(settled,false);assert.equal(existsSync(directory),true);
    broker.child.emit=original;Reflect.apply(original,broker.child,held!);held=undefined;await assert.rejects(closing,(e:unknown)=>hasNativeTimeout(e,'Owned broker native close unconfirmed'));assert.equal(existsSync(directory),false);
  }finally{broker.child.emit=original;if(held)Reflect.apply(original,broker.child,held);await closing?.catch(()=>{});}
});
for(const failedStartup of [false,true])test('owned producer timeout joins authentic close '+(failedStartup?'after failed startup':'after successful public caller'),async()=>{
  const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {runZigbee2MqttBridgeConsumer}=await import('../../../examples/zigbee2mqtt-bridge/consumer.mjs');const {ChildProcess}=await import('node:child_process');
  const broker=await startOwnedZigbeeBroker();if(failedStartup)await broker.close();const original=ChildProcess.prototype.emit,nativeChildren:InstanceType<typeof ChildProcess>[]=[];let held:unknown[]|undefined,producer:InstanceType<typeof ChildProcess>|undefined,settled=false,running:ReturnType<typeof runZigbee2MqttBridgeConsumer>|undefined;
  ChildProcess.prototype.emit=function(event:string|symbol,...args:unknown[]){if(event==='close'&&this.spawnargs?.some(x=>x.endsWith('/zigbee2mqtt-bridge/producer.mjs'))){nativeChildren.push(this);producer=nativeChildren.at(-1);held=[event,...args];return true;}return Reflect.apply(original,this,[event,...args]) as boolean;};
  try{running=runZigbee2MqttBridgeConsumer(broker.endpoint);void running.then(()=>{settled=true;},()=>{settled=true;});await nativeUntil(()=>!!held,'real producer close absent');assert.ok(producer);assert.equal(producer.signalCode,null);assert.equal(producer.exitCode,failedStartup?1:0);await nativePause(3100);assert.equal(settled,false);
    ChildProcess.prototype.emit=original;Reflect.apply(original,producer,held!);held=undefined;await assert.rejects(running,e=>hasNativeTimeout(e,'Producer native close unconfirmed'));
  }finally{ChildProcess.prototype.emit=original;if(held&&producer)Reflect.apply(original,producer,held);await running?.catch(()=>{});await broker.close();}
});

test('owned broker failed startup retains authentic child close and directory past timeout',async()=>{
  const {startOwnedZigbeeBroker}=await import('../../../tools/qa-zigbee2mqtt-bridge.mjs');const {ChildProcess}=await import('node:child_process');const {writeFileSync,existsSync}=await import('node:fs');const {dirname}=await import('node:path');
  const originalSpawn=Reflect.get(ChildProcess.prototype,'spawn') as (options:{args:string[]})=>unknown,originalEmit=ChildProcess.prototype.emit,nativeChildren:InstanceType<typeof ChildProcess>[]=[];
  let held:unknown[]|undefined,directory:string|undefined,settled=false,running:ReturnType<typeof startOwnedZigbeeBroker>|undefined;
  Reflect.set(ChildProcess.prototype,'spawn',function(this:InstanceType<typeof ChildProcess>,options:{args:string[]}){const config=options.args[options.args.indexOf('-c')+1];if(config?.endsWith('/mosquitto.conf')){directory=dirname(config);writeFileSync(config,'invalid-owned-startup-directive yes\n');nativeChildren.push(this);}return Reflect.apply(originalSpawn,this,[options]);});
  ChildProcess.prototype.emit=function(event:string|symbol,...args:unknown[]){if(event==='close'&&nativeChildren.includes(this)){held=[event,...args];return true;}return Reflect.apply(originalEmit,this,[event,...args]) as boolean;};
  try{running=startOwnedZigbeeBroker();void running.then(()=>{settled=true;},()=>{settled=true;});await nativeUntil(()=>!!held,'real failed broker close absent');const child=nativeChildren[0]!;assert.notEqual(child.exitCode,0);assert.equal(child.signalCode,null);assert.ok(directory);await nativePause(2200);assert.equal(settled,false);assert.equal(existsSync(directory),true);
    ChildProcess.prototype.emit=originalEmit;Reflect.apply(originalEmit,child,held!);held=undefined;await assert.rejects(running,(e:unknown)=>hasNativeTimeout(e,'Owned broker native close unconfirmed'));assert.equal(existsSync(directory),false);
  }finally{Reflect.set(ChildProcess.prototype,'spawn',originalSpawn);ChildProcess.prototype.emit=originalEmit;if(held)Reflect.apply(originalEmit,nativeChildren[0]!,held);await running?.catch(()=>{});}
});

test('invalid copied-control SDK admission removes its owned empty directory',async()=>{
  const {runZigbeeControlledCopyChecks}=await import('../../../tools/qa-installed-zigbee2mqtt-bridge.mjs');const {readdirSync,mkdtempSync,rmSync,rmdirSync}=await import('node:fs');
  const before=new Set(readdirSync('/tmp').filter(name=>name.startsWith('101-zigbee-controls-'))),invalid=mkdtempSync('/tmp/101-zigbee-invalid-input-');let leaked:string[]=[];
  try{await assert.rejects(runZigbeeControlledCopyChecks(invalid),/ENOENT/);leaked=readdirSync('/tmp').filter(name=>name.startsWith('101-zigbee-controls-')&&!before.has(name));assert.deepEqual(leaked,[],'Admission failure leaked an owned work directory');}
  finally{rmSync(invalid,{recursive:true,force:true});for(const name of leaked){assert.deepEqual(readdirSync('/tmp/'+name),[]);rmdirSync('/tmp/'+name);}}
});
