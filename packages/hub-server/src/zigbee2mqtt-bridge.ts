/** Read-only, owner-selected Zigbee2MQTT reported switch. Native bridge metadata
 * is consistency evidence; IEEE names do not grant identity or commissioning. */
import { types } from 'node:util';
import { createHash } from 'node:crypto';
import { connect as mqttConnect, type MqttClient } from 'mqtt';
export interface Zigbee2MqttProfile { readonly id: string; readonly revision: number; readonly ieeeAddress: string; readonly model: 'WXKG01LM'; readonly baseTopic: 'zigbee2mqtt' }
export type ZigbeeAction = 'single' | 'double' | 'triple' | 'quadruple' | 'hold' | 'release' | 'many';
export type ZigbeeDecoded = Readonly<{kind:'metadata';compatible:boolean}|{kind:'bridge-status'|'device-status';online:boolean}|{kind:'state';retained:boolean;battery?:number;action?:ZigbeeAction;lastSeen?:string|number;linkquality?:number}>;
export const ZIGBEE_LIMITS = Object.freeze({ messages:256,totalBytes:1048576,payloadBytes:8192,metadataBytes:16384,sessionMs:30000,startupMs:5000,closeMs:2000 } as const);
const actions = Object.freeze(['single','double','triple','quadruple','hold','release','many'] as const);
function invalid(): never {throw new TypeError('Invalid selected Zigbee2MQTT bridge');}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value); if (keys.length > required.length + optional.length || required.some(key => !keys.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) invalid();
    const field = Object.getOwnPropertyDescriptor(value, key); if (!field?.enumerable || !('value' in field)) invalid();
    result[key] = field.value;
  }
  return result;
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid();
  return value;
}
function uint(value: unknown, max = 0xffffffff, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(); return value;
}
function json(bytes: Uint8Array, max: number): unknown {
  if (!(bytes instanceof Uint8Array) || types.isProxy(bytes)) invalid();
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
  const size = Reflect.apply(getter, bytes, []) as number; if (size < 1 || size > max) invalid();
  const copied = new Uint8Array(size); Uint8Array.prototype.set.call(copied, bytes);
  let source: string; try { source = new TextDecoder('utf-8', { fatal: true }).decode(copied); } catch { invalid(); }
  let at = 0, nodes = 0;
  function whitespace() { while (/[\t\r\n ]/.test(source[at] ?? 'x')) at++; }
  function string(): string {
    const start = at++; if (source[start] !== '"') invalid();
    while (at < source.length) { const character = source[at++]; if (character === '\\') at++; else if (character === '"') {
      try { return JSON.parse(source.slice(start, at)) as string; } catch { invalid(); }
    } }
    invalid();
  }
  function value(depth: number): void {
    if (++nodes > 512 || depth > 8) invalid(); whitespace(); const character = source[at];
    if (character === '"') { string(); return; }
    if (character === '{') {
      at++; whitespace(); const keys = new Set<string>(); if (source[at] === '}') { at++; return; }
      for (;;) { whitespace(); const key = string(); if (keys.has(key) || ['__proto__','constructor','prototype'].includes(key)) invalid(); keys.add(key);
        whitespace(); if (source[at++] !== ':') invalid(); value(depth + 1); whitespace();
        const end = source[at++]; if (end === '}') return; if (end !== ',') invalid(); }
    }
    if (character === '[') { at++; whitespace(); if (source[at] === ']') { at++; return; }
      for (;;) { value(depth + 1); whitespace(); const end = source[at++]; if (end === ']') return; if (end !== ',') invalid(); } }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (!token) invalid(); at += token[0].length;
  }
  value(0); whitespace(); if (at !== source.length) invalid();
  try { return JSON.parse(source); } catch { invalid(); }
}
function nativeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value as Record<string,unknown>;
}
export function parseZigbee2MqttProfile(input: unknown): Readonly<Zigbee2MqttProfile> {
  const p=object(input,['id','revision','ieeeAddress','model','baseTopic']);
  const ieeeAddress=text(p.ieeeAddress,18);
  if (!/^0x[0-9a-f]{16}$/.test(ieeeAddress) || p.model!=='WXKG01LM' || p.baseTopic!=='zigbee2mqtt') invalid();
  return Object.freeze({id:text(p.id),revision:uint(p.revision,0x7fffffff,1),ieeeAddress,model:'WXKG01LM',baseTopic:'zigbee2mqtt'});
}
export function zigbee2MqttTopics(profile: Zigbee2MqttProfile): readonly string[] {
  const p=parseZigbee2MqttProfile(profile),base=p.baseTopic+'/'+p.ieeeAddress;
  return Object.freeze([p.baseTopic+'/bridge/devices',p.baseTopic+'/bridge/state',base,base+'/availability']);
}
export function decodeZigbee2MqttMessage(topic: string, bytes: Uint8Array, retained: boolean, profile: Zigbee2MqttProfile): ZigbeeDecoded {
  const p=parseZigbee2MqttProfile(profile),topics=zigbee2MqttTopics(p);
  if (typeof retained!=='boolean' || !topics.includes(topic)) invalid();
  const input=json(bytes,topic===topics[0]?ZIGBEE_LIMITS.metadataBytes:ZIGBEE_LIMITS.payloadBytes);
  if (topic===topics[0]) {
    if (!Array.isArray(input) || input.length>16) invalid();
    const selected=input.map(nativeObject).filter(d=>d.ieee_address===p.ieeeAddress);
    let compatible=selected.length===1;
    if (compatible) {
      const d=selected[0]!;
      if(d.friendly_name!==p.ieeeAddress || d.supported!==true || d.disabled!==false || d.interview_state!=='SUCCESSFUL')compatible=false;
      const definition=d.definition && typeof d.definition==='object' && !Array.isArray(d.definition)?nativeObject(d.definition):undefined;
      if (!definition || definition.model!==p.model || !Array.isArray(definition.exposes) || definition.exposes.length>32)compatible=false;
      else {
        const exposes=definition.exposes.map(nativeObject),battery=exposes.filter(e=>e.property==='battery'),action=exposes.filter(e=>e.property==='action');
        const b=battery[0],a=action[0],values=a?.values;
        if(battery.length!==1 || action.length!==1 || !b || !a || b.type!=='numeric' || b.name!=='battery' || b.access!==1 || b.unit!=='%' || Object.hasOwn(b,'endpoint') ||
          a.type!=='enum' || a.name!=='action' || a.access!==1 || Object.hasOwn(a,'endpoint') || !Array.isArray(values) || values.length!==actions.length || actions.some((v,i)=>values[i]!==v)) compatible=false;
      }
    }
    return Object.freeze({kind:'metadata',compatible});
  }
  if(topic===topics[1] || topic===topics[3]) {
    const d=object(input,['state']);if(d.state!=='online' && d.state!=='offline')invalid();
    return Object.freeze({kind:topic===topics[1]?'bridge-status':'device-status',online:d.state==='online'});
  }
  const d=object(input,[],['battery','action','last_seen','linkquality','voltage','power_outage_count']);
  const result:{kind:'state';retained:boolean;battery?:number;action?:ZigbeeAction;lastSeen?:string|number;linkquality?:number}={kind:'state',retained};
  if(Object.hasOwn(d,'battery')){if(typeof d.battery!=='number' || !Number.isFinite(d.battery) || d.battery<0 || d.battery>100)invalid();result.battery=d.battery;}
  if(Object.hasOwn(d,'action')){if(!actions.includes(d.action as ZigbeeAction))invalid();result.action=d.action as ZigbeeAction;}
  if(Object.hasOwn(d,'last_seen')){if(typeof d.last_seen==='number'){if(!Number.isFinite(d.last_seen)||d.last_seen<0)invalid();result.lastSeen=d.last_seen;}else result.lastSeen=text(d.last_seen,64);}
  if(Object.hasOwn(d,'linkquality'))result.linkquality=uint(d.linkquality,255);
  if(Object.hasOwn(d,'voltage'))uint(d.voltage,65535);if(Object.hasOwn(d,'power_outage_count'))uint(d.power_outage_count);
  if(!Object.keys(d).length)invalid();return Object.freeze(result);
}

export interface ZigbeeApprovalRequest {
  readonly action:'read';readonly endpoint:string;readonly profile:Readonly<Zigbee2MqttProfile>;readonly topics:readonly string[];
  readonly scope:Readonly<{principalId:string;applicationId:string;sessionId:string}>;readonly purpose:string;readonly originalDeadline:number;readonly generation:number;
  readonly captureTimeKnown:false;readonly sessionMs:30000;readonly messageLimit:256;readonly totalByteLimit:1048576;readonly budgets:typeof ZIGBEE_LIMITS;
}
export interface ZigbeeReading {
  readonly decoded:Extract<ZigbeeDecoded,{kind:'state'}>;readonly localSequence:number;readonly receivedAt:number;
  readonly receiptClockId:'zigbee-gateway-monotonic';readonly payloadSha256:string;readonly receivedQos:0;readonly mqttDup:boolean;
}
export interface Zigbee2MqttBridge {
  start(input:Readonly<{purpose:string;signal:AbortSignal;deadline:number}>):Promise<Readonly<{ok:true}|{ok:false;reason:string}>>;
  stop():Promise<void>;close():Promise<void>;
  status():Readonly<{phase:'idle'|'connecting'|'ready'|'retiring'|'closed';reason:string;messages:number;receivedBytes:number;delivered:number;nativeClients:number;failures:readonly string[]}>;
}
const abortedGetter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
function genuineSignal(v:unknown):v is AbortSignal {
  if(!v || typeof v!=='object' || types.isProxy(v) || Object.getPrototypeOf(v)!==AbortSignal.prototype)return false;
  try {Reflect.apply(abortedGetter,v,[]);return true;}catch{return false;}
}
const aborted=(v:AbortSignal):boolean=>Reflect.apply(abortedGetter,v,[]) as boolean;
export function createZigbee2MqttBridge(options:Readonly<{endpoint:string;profile:unknown;ownerSignal:AbortSignal;scope:ZigbeeApprovalRequest['scope'];
 authorize:(request:ZigbeeApprovalRequest)=>Readonly<{request:ZigbeeApprovalRequest;signal:AbortSignal;expiresAt:number}>|undefined;
 onReading:(reading:ZigbeeReading)=>void;onUnavailable:(reason:string)=>void}>):Zigbee2MqttBridge {
  const o=object(options,['endpoint','profile','ownerSignal','scope','authorize','onReading','onUnavailable']),s=object(o.scope,['principalId','applicationId','sessionId']);
  const endpoint=text(o.endpoint),match=/^mqtt:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(endpoint);
  if(!match || Number(match[1])>65535 || !genuineSignal(o.ownerSignal) || typeof o.authorize!=='function' || typeof o.onReading!=='function' || typeof o.onUnavailable!=='function')invalid();
  const profile=parseZigbee2MqttProfile(o.profile),topics=zigbee2MqttTopics(profile),owner=o.ownerSignal;
  const scope=Object.freeze({principalId:text(s.principalId),applicationId:text(s.applicationId),sessionId:text(s.sessionId)});
  const authorize=o.authorize as typeof options.authorize,onReading=o.onReading as typeof options.onReading,onUnavailable=o.onUnavailable as typeof options.onUnavailable;
  let phase:'idle'|'connecting'|'ready'|'retiring'|'closed'='idle',epoch=0,reason='idle',messages=0,receivedBytes=0,delivered=0,nativeClients=0;
  let caller:AbortSignal|undefined,grant:AbortSignal|undefined,expiresAt=0,client:MqttClient|undefined,retirement:Promise<void>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined,subscribed=false,metadata=false,bridgeOnline=false,deviceOnline=false;
  const detach:(()=>void)[]=[],cancel=new Set<()=>void>(),legs:Promise<unknown>[]=[],failures:string[]=[];
  const failure=(r:string)=>Object.freeze({ok:false as const,reason:r});
  function current(run:number,ready=false):boolean {
    return run===epoch && (ready?phase==='ready':phase==='connecting'||phase==='ready') && !!caller && !!grant && !aborted(owner)&&!aborted(caller)&&!aborted(grant)&&performance.now()<expiresAt;
  }
  function track<T>(promise:Promise<T>):Promise<T> {legs.push(promise);void promise.catch(e=>failures.push(String(e)));return promise;}
  function wait<T>(native:Promise<T>,deadline:number):Promise<T> {
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error?:unknown,value?:T)=>{if(settled)return;settled=true;clearTimeout(timeout);cancel.delete(cancelled);if(error)reject(error);else resolve(value as T);};
      const cancelled=()=>finish(new Error('startup-retired'));
      const timeout=setTimeout(()=>finish(new Error('startup-timeout')),Math.max(1,deadline-performance.now()));cancel.add(cancelled);
      native.then(value=>finish(undefined,value),error=>finish(error));
    });
  }
  function retire(code:string,cause?:unknown):Promise<void> {
    if(cause)failures.push(String(cause));if(retirement)return retirement;
    phase='retiring';reason=code;epoch++;if(timer)clearTimeout(timer);for(const d of detach.splice(0))d();for(const c of [...cancel])c();
    const active=client;
    // Fence and create the shared retirement promise before any external callout.
    retirement=Promise.resolve().then(async()=>{
      const pending:Promise<unknown>[]=[...legs];let ending:Promise<unknown>|undefined,closed:Promise<unknown>|undefined;
      if(active){const stream=active.stream;if(!stream)throw new Error('Zigbee native stream retirement unconfirmed');
        closed=new Promise<void>(resolve=>{if((stream as {closed?:boolean}).closed===true)resolve();else stream.once('close',resolve);});
        try{ending=Promise.resolve(active.endAsync(true));}catch(e){ending=Promise.reject(e);}
        pending.push(ending,closed);
      }
      let timeout:ReturnType<typeof setTimeout>|undefined;
      try{
        const outcomes=await Promise.race([Promise.allSettled(pending),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Zigbee native retirement unconfirmed')),ZIGBEE_LIMITS.closeMs);})]);
        if(active){const last=outcomes.slice(-2);const errors=last.filter(v=>v.status==='rejected').map(v=>(v as PromiseRejectedResult).reason);
          if(errors.length)throw new AggregateError(errors,'Zigbee native retirement failed');nativeClients=0;client=undefined;
        }
        phase='closed';
      }finally{if(timeout)clearTimeout(timeout);}
    });
    try{onUnavailable(code);}catch(e){failures.push(String(e));}return retirement;
  }
  function watch(signal:AbortSignal,code:string){const fn=()=>{void retire(code).catch(e=>failures.push(String(e)));};Reflect.apply(add,signal,['abort',fn,{once:true}]);detach.push(()=>Reflect.apply(remove,signal,['abort',fn]));if(aborted(signal))fn();}
  async function start(input:Readonly<{purpose:string;signal:AbortSignal;deadline:number}>):Promise<Readonly<{ok:true}|{ok:false;reason:string}>> {
    if(phase!=='idle')return failure(phase==='ready'||phase==='connecting'?'busy':'closed');
    const r=object(input,['purpose','signal','deadline']),purpose=text(r.purpose);if(!genuineSignal(r.signal))invalid();caller=r.signal;
    const startedAt=performance.now();if(typeof r.deadline!=='number'||!Number.isFinite(r.deadline)||r.deadline<=startedAt||r.deadline>startedAt+ZIGBEE_LIMITS.sessionMs)return failure('deadline');
    phase='connecting';reason='connecting';const run=++epoch;
    if(aborted(owner)||aborted(caller)){await retire('cancelled');return failure(reason);}
    const request:ZigbeeApprovalRequest=Object.freeze({action:'read',endpoint,profile,topics,scope,purpose,originalDeadline:r.deadline,generation:run,captureTimeKnown:false,
      sessionMs:30000,messageLimit:256,totalByteLimit:1048576,budgets:ZIGBEE_LIMITS});
    let approved:Record<string,unknown>|undefined;try{approved=object(authorize(request),['request','signal','expiresAt']);}catch(e){failures.push(String(e));}
    if(!approved||approved.request!==request||!genuineSignal(approved.signal)||aborted(approved.signal)||typeof approved.expiresAt!=='number'||!Number.isFinite(approved.expiresAt)||approved.expiresAt<=performance.now()||aborted(owner)||aborted(caller)||epoch!==run||phase!=='connecting'){
      await retire('denied');return failure(reason);
    }
    grant=approved.signal;expiresAt=Math.min(r.deadline,approved.expiresAt);const startupDeadline=Math.min(expiresAt,startedAt+ZIGBEE_LIMITS.startupMs);
    watch(owner,'owner-aborted');watch(caller,'cancelled');watch(grant,'revoked');
    if(!current(run)){await retire('cancelled');return failure(reason);}
    timer=setTimeout(()=>{void retire('expired').catch(e=>failures.push(String(e)));},Math.max(1,expiresAt-performance.now()));
    let prerequisitesResolve!:()=>void;
    const prerequisites=new Promise<void>(resolve=>{prerequisitesResolve=resolve;});
    const ready=()=>{if(current(run)&&subscribed&&metadata&&bridgeOnline&&deviceOnline)prerequisitesResolve();};
    try{
      const active=mqttConnect(endpoint,{protocolVersion:5,clean:true,reconnectPeriod:0,resubscribe:false,queueQoSZero:false,reconnectOnConnackError:false,
        connectTimeout:Math.max(1,startupDeadline-performance.now()),keepalive:5,properties:{sessionExpiryInterval:0,receiveMaximum:1,maximumPacketSize:ZIGBEE_LIMITS.metadataBytes+1024}});
      client=active;nativeClients=1;
      active.on('error',e=>{void retire('transport-error',e).catch(e=>failures.push(String(e)));});
      active.on('close',()=>{if(phase==='ready'||phase==='connecting')void retire('transport-closed').catch(e=>failures.push(String(e)));});
      active.on('message',(topic,bytes,packet)=>{
        if(epoch!==run||client!==active||phase!=='ready'&&phase!=='connecting')return;
        messages++;receivedBytes+=bytes.byteLength;if(messages>ZIGBEE_LIMITS.messages||receivedBytes>ZIGBEE_LIMITS.totalBytes){void retire('quota').catch(e=>failures.push(String(e)));return;}
        if(!current(run)){void retire('expired-or-revoked').catch(e=>failures.push(String(e)));return;}
        try{
          if((topic===topics[2]&&packet.qos!==0)||(topic===topics[3]&&packet.qos!==1)||((topic===topics[0]||topic===topics[1])&&packet.qos!==0))invalid();
          const d=decodeZigbee2MqttMessage(topic,bytes,packet.retain,profile);
          if(d.kind==='metadata'){if(!d.compatible){void retire('metadata-incompatible').catch(e=>failures.push(String(e)));return;}metadata=true;ready();return;}
          if(d.kind==='bridge-status'||d.kind==='device-status'){if(!d.online){void retire('offline').catch(e=>failures.push(String(e)));return;}if(d.kind==='bridge-status')bridgeOnline=true;else deviceOnline=true;ready();return;}
          if(d.kind!=='state'||!current(run,true)||d.retained||d.battery===undefined&&d.action===undefined)return;
          const reading:ZigbeeReading=Object.freeze({decoded:d,localSequence:delivered+1,receivedAt:performance.now(),receiptClockId:'zigbee-gateway-monotonic',payloadSha256:createHash('sha256').update(bytes).digest('hex'),receivedQos:0,mqttDup:packet.dup});
          if(!current(run,true))return;onReading(reading);if(!current(run,true))return;delivered++;
        }catch(e){void retire('protocol-or-callback',e).catch(e=>failures.push(String(e)));}
      });
      const connected=track(new Promise<void>((resolve,reject)=>{
        const cleanup=()=>{active.off('connect',ok);active.off('error',bad);active.off('close',closed);};
        const ok=()=>{cleanup();resolve();},bad=(e:Error)=>{cleanup();reject(e);},closed=()=>{cleanup();reject(new Error('connect-closed'));};
        active.once('connect',ok);active.once('error',bad);active.once('close',closed);
      }));
      await wait(connected,startupDeadline);if(!current(run))throw new Error('stale-connect');
      const subscription=track(active.subscribeAsync([...topics],{qos:1,rh:0,rap:true}));
      const grants=await wait(subscription,startupDeadline);if(!current(run)||grants.length!==topics.length||grants.some((g,i)=>g.topic!==topics[i]||g.qos!==1))throw new Error('subscription-denied');
      subscribed=true;ready();await wait(prerequisites,startupDeadline);if(!current(run)||!metadata||!bridgeOnline||!deviceOnline)throw new Error('stale-bootstrap');
      phase='ready';reason='ready';return Object.freeze({ok:true});
    }catch(e){void retire(reason==='connecting'?'startup-failed':reason,e).catch(e=>failures.push(String(e)));return failure(reason);}
  }
  return Object.freeze({start,stop:()=>retire('stopped'),close:()=>retire('closed'),status:()=>Object.freeze({phase,reason,messages,receivedBytes,delivered,nativeClients,failures:Object.freeze([...failures])})});
}
