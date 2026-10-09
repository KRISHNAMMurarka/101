import type {DeviceDescriptor,DeviceRuntime,EndpointHandle} from '@101/connect';
import {decodeHeartRateMeasurement} from './heart-rate-measurement.ts';

export const HEART_RATE_SOFTWARE_PROFILE=Object.freeze({id:'app:hrs-1.0-heart-rate-notifications/1' as const,revision:1 as const,serviceUUID:'0000180d-0000-1000-8000-00805f9b34fb',characteristicUUID:'00002a37-0000-1000-8000-00805f9b34fb'});
/** Selected software budgets; not Bluetooth specification measurement/rate guarantees. */
export const HEART_RATE_SOFTWARE_LIMITS=Object.freeze({ports:1,sources:1,attempts:16,captureMs:30000,openingMs:5000,frameBytes:20,maxHz:20,burstFrames:4,framesPerCapture:600,retainedSamples:0,latestRuntimeValues:1,expiryTimers:1,openingTimers:1});
export interface HeartRateScope{readonly principalId:string;readonly applicationId:string;readonly sessionId:string}
export interface HeartRateNotificationRequest extends HeartRateScope{readonly action:'subscribe-reported-heart-rate';readonly purpose:string;readonly providerId:string;readonly profile:typeof HEART_RATE_SOFTWARE_PROFILE;readonly generation:number;readonly resource:Readonly<{capabilityId:'heart-rate';operation:'subscribe'}>;readonly deadline:number;readonly budgets:typeof HEART_RATE_SOFTWARE_LIMITS}
export interface HeartRateNotificationGrant{readonly request:HeartRateNotificationRequest;readonly signal:AbortSignal;readonly expiresAt:number}
export interface HeartRateNotificationContext{readonly generation:number;readonly signal:AbortSignal;readonly deadline:number;readonly onValue:(bytes:Uint8Array)=>void;readonly onLost:()=>void}
export interface HeartRateSoftwarePort{readonly kind:'software-notification';readonly providerId:string;open(context:HeartRateNotificationContext):Promise<'ready'>;stop():void;close():Promise<void>;whenSettled():Promise<void>}
export interface HeartRateSoftwareOptions{readonly mode:'software-notification';readonly runtime:DeviceRuntime;readonly ownerSignal:AbortSignal;readonly scope:HeartRateScope;readonly selectedPort:HeartRateSoftwarePort;readonly now:()=>number;readonly authorizeNotifications:(request:HeartRateNotificationRequest)=>HeartRateNotificationGrant|undefined|Promise<HeartRateNotificationGrant|undefined>}
export type HeartRateFailure='unsupported'|'invalid'|'closed'|'busy'|'quota'|'denied'|'expired'|'cancelled'|'stopped'|'lost'|'provider'|'clock'|'malformed'|'contact-changed';
export type HeartRateResult<T>=Readonly<{ok:true;value:T}>|Readonly<{ok:false;reason:HeartRateFailure}>;
export interface HeartRateActivation{readonly source:EndpointHandle;readonly device:DeviceDescriptor;readonly connectionGeneration:number;readonly expiresAt:number}
export interface HeartRateSnapshot{readonly phase:'idle'|'opening'|'active'|'retiring'|'closed';readonly reason:HeartRateFailure|'idle'|'active';readonly attempts:number;readonly generation:number;readonly activeSources:number;readonly rawPending:number;readonly cleanupFailed:boolean;readonly listeners:number;readonly timers:number;readonly frames:number}
export interface HeartRateSoftwareGateway{start(intent:Readonly<{purpose:string;signal:AbortSignal;deadline:number}>):Promise<HeartRateResult<HeartRateActivation>>;stop():void;close():Promise<void>;sweep():void;snapshot():HeartRateSnapshot}
const abortedGet=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!,then=Promise.prototype.then,add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
const owners=new WeakMap<object,symbol>();let instances=0;
const aborted=(v:AbortSignal)=>Reflect.apply(abortedGet,v,[]) as boolean;
function isSignal(v:unknown):v is AbortSignal{try{aborted(v as AbortSignal);return true}catch{return false}}
function own(v:unknown,required:readonly string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error('data');const result:Record<string,unknown>=Object.create(null),keys=Reflect.ownKeys(v);
 if(keys.length!==required.length)throw Error('data');for(const k of keys){if(typeof k!=='string'||!required.includes(k))throw Error('data');const d=Object.getOwnPropertyDescriptor(v,k);if(!d?.enumerable||!('value'in d))throw Error('data');result[k]=d.value;}return result;
}
// eslint-disable-next-line no-control-regex -- Scope and purpose intentionally reject C0, DEL and C1 controls.
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=160&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/.test(v);
const fail=<T=never>(reason:HeartRateFailure):HeartRateResult<T>=>Object.freeze({ok:false,reason});
interface Session{generation:number;retired:boolean;controller:AbortController;caller?:AbortSignal;grant?:Readonly<{signal:AbortSignal;expiresAt:number}>;deadline:number;source?:EndpointHandle;portOwned:boolean;openIssued:boolean;contactSupported?:boolean;frames:number;tokens:number;tokenAt:number;operations:Set<Promise<void>>;removers:(()=>void)[];timers:Set<ReturnType<typeof setTimeout>>;cancel:(result:HeartRateResult<HeartRateActivation>)=>void;retirement?:Promise<void>;expiryTimer?:ReturnType<typeof setTimeout>;openingTimer?:ReturnType<typeof setTimeout>}
/** Explicit trusted software port only. No native adapter, automatic discovery or persistent sample history. */
export function createHeartRateSoftwareGateway(input:HeartRateSoftwareOptions):HeartRateSoftwareGateway{
 const admission=Object.getOwnPropertyDescriptor(input,'mode');if(!admission||!('value'in admission)||admission.value!=='software-notification')throw new TypeError('unsupported-heart-rate-native-admission');
 let v:Record<string,unknown>,scope:Readonly<HeartRateScope>,p:Record<string,unknown>;
 try{v=own(input,['mode','runtime','ownerSignal','scope','selectedPort','now','authorizeNotifications']);const s=own(v.scope,['principalId','applicationId','sessionId']);if(!Object.values(s).every(text)||!isSignal(v.ownerSignal)||typeof v.now!=='function'||typeof v.authorizeNotifications!=='function')throw Error();scope=Object.freeze({...s}) as unknown as HeartRateScope;p=own(v.selectedPort,['kind','providerId','open','stop','close','whenSettled']);if(p.kind!=='software-notification'||!text(p.providerId)||['open','stop','close','whenSettled'].some(k=>typeof p[k]!=='function'))throw Error();}catch{throw new TypeError('Invalid software heart-rate options');}
 const runtime=v.runtime as DeviceRuntime,port=v.selectedPort as HeartRateSoftwarePort,owner=v.ownerSignal as AbortSignal,now=v.now as()=>number,authorize=v.authorizeNotifications as HeartRateSoftwareOptions['authorizeNotifications'];
 const open=p.open as HeartRateSoftwarePort['open'],portStop=p.stop as HeartRateSoftwarePort['stop'],portClose=p.close as HeartRateSoftwarePort['close'],settled=p.whenSettled as HeartRateSoftwarePort['whenSettled'];
 const portId=p.providerId as string,ownerToken=Symbol(),instance=++instances;if(!Number.isSafeInteger(instance))throw new RangeError('Heart-rate instance budget');
 let session:Session|undefined,closed=aborted(owner),attempts=0,generation=0,lastClock=-1,readingClock=false,dispatching=false,reason:HeartRateSnapshot['reason']=closed?'closed':'idle',closePromise:Promise<void>|undefined;
 function live(s:Session):boolean{return session===s&&!s.retired&&!closed&&s.generation===generation&&!aborted(owner)&&(!s.caller||!aborted(s.caller))&&(!s.grant||!aborted(s.grant.signal));}
 function time(s:Session):number{if(readingClock){retire(s,'clock');throw Error();}readingClock=true;try{const at=now();if(!live(s)||!Number.isFinite(at)||at<0||at>Number.MAX_SAFE_INTEGER-30000||at<lastClock){retire(s,'clock');throw Error();}lastClock=at;return at;}catch{retire(s,'clock');throw Error();}finally{readingClock=false;}}
 function current(s:Session):boolean{if(!live(s)){if(!s.retired)retire(s,'cancelled');return false;}let at:number;try{at=time(s)}catch{return false;}if(!live(s))return false;if(at>=s.deadline){retire(s,'expired');return false;}return live(s);}
 function uncertain(s:Session):void{s.operations.add(new Promise<void>(()=>{}));}
 /** Token is in the raw set before a callout, including reentrant stop/close. */
 function issue<T>(s:Session,call:()=>unknown,synchronous:boolean,uncertainOnThrow=false):Promise<T>{
  let release!:()=>void;const token=new Promise<void>(r=>{release=r});s.operations.add(token);
  const finish=()=>{s.operations.delete(token);release();};let value:unknown;
  try{value=call();}catch(e){if(uncertainOnThrow)uncertain(s);finish();return Promise.reject(e);}
  return new Promise<T>((resolve,reject)=>{
   try{Reflect.apply(then,value,[ (result:T)=>{finish();resolve(result)},(error:unknown)=>{finish();reject(error)} ]);}
   catch{if(synchronous){finish();resolve(value as T);}else{uncertain(s);finish();reject(Error('Port Promise contract'));}}
  });
 }
 function listener(s:Session,signal:AbortSignal):void{const callback=()=>retire(s,'cancelled');const dispose=()=>Reflect.apply(remove,signal,['abort',callback]);s.removers.push(dispose);Reflect.apply(add,signal,['abort',callback,{once:true}]);if(!live(s)){dispose();retire(s,'cancelled');}}
 function timer(s:Session,ms:number,callback:()=>void):ReturnType<typeof setTimeout>{const id=setTimeout(()=>{s.timers.delete(id);callback();},Math.max(1,ms));s.timers.add(id);if(s.retired){clearTimeout(id);s.timers.delete(id);}return id;}
 function retire(s:Session,why:HeartRateFailure):void{
  if(s.retired)return;s.retired=true;reason=why;s.cancel(fail(why));
  let finished!:()=>void;const retiring=new Promise<void>(r=>{finished=r});s.retirement=retiring;
  for(const id of s.timers)clearTimeout(id);s.timers.clear();for(const dispose of s.removers.splice(0))try{dispose()}catch{cleanupFailed=true;}
  s.controller.abort();const source=s.source;s.source=undefined;if(source)try{runtime.setReadiness(source,'unavailable');runtime.unregister(source);}catch{cleanupFailed=true;uncertain(s);}
  if(s.portOwned&&owners.get(port)===ownerToken){
   void issue(s,()=>{const value=Reflect.apply(portStop,port,[]);if(value!==undefined){cleanupFailed=true;uncertain(s);}return value;},true,true).catch(()=>{cleanupFailed=true;uncertain(s);});
   void issue(s,()=>Reflect.apply(portClose,port,[]),false,true).catch(()=>{cleanupFailed=true;uncertain(s);});
   void issue(s,()=>Reflect.apply(settled,port,[]),false,true).catch(()=>{cleanupFailed=true;uncertain(s);});
  }
  void(async()=>{await Promise.resolve();while(s.operations.size)await Promise.all([...s.operations]);if(session===s)session=undefined;if(s.portOwned&&owners.get(port)===ownerToken)owners.delete(port);finished();})().catch(()=>{cleanupFailed=true;});
 }
 let cleanupFailed=false;
 function notification(s:Session,bytes:Uint8Array):void{
  if(!live(s)||!s.source)return;if(dispatching){retire(s,'provider');return;}dispatching=true;
  try{
   if(!current(s))return;const result=decodeHeartRateMeasurement(bytes);if(!current(s))return;if(result.kind!=='measurement'){retire(s,'malformed');return;}
   if(s.contactSupported!==undefined&&result.contactSupported!==s.contactSupported){retire(s,'contact-changed');return;}s.contactSupported=result.contactSupported;
   const at=time(s);if(!current(s))return;s.tokens=Math.min(4,s.tokens+Math.max(0,at-s.tokenAt)*20/1000);s.tokenAt=at;
   if(s.tokens<1||s.frames>=600){retire(s,'quota');return;}s.tokens--;s.frames++;
   const provenance=Object.freeze({provider:'software-heart-rate-notifications',profileId:HEART_RATE_SOFTWARE_PROFILE.id,profileRevision:1,connectionGeneration:s.generation,samplePoint:'software-notification-receipt',captureTimeKnown:false,measurementAgeKnown:false,clockMappingEstablished:false,physical:'unverified',fixture:true});
   const publish=runtime.publish,clockDomain=runtime.clockDomain;if(!current(s)||!s.source)return;
   const response=Reflect.apply(publish,runtime,[s.source,result.heartRateBpm,{timestamp:at,clockDomain,quality:'valid',provenance}]) as ReturnType<DeviceRuntime['publish']>;
   if(!current(s))return;if(!response.ok||response.value.rejected>0)retire(s,'provider');
  }catch{if(!s.retired)retire(s,'provider');}finally{dispatching=false;}
 }
 async function begin(s:Session,intent:unknown):Promise<void>{
  try{
   const requestInput=own(intent,['purpose','signal','deadline']);if(!text(requestInput.purpose)||!isSignal(requestInput.signal)||requestInput.signal===owner||typeof requestInput.deadline!=='number'||!Number.isFinite(requestInput.deadline))throw Error('invalid');
   s.caller=requestInput.signal;const at=time(s);if(!live(s)||aborted(s.caller)||requestInput.deadline<=at||requestInput.deadline>at+30000)throw Error('invalid');s.deadline=requestInput.deadline;
   listener(s,owner);listener(s,s.caller);if(!current(s))return;s.expiryTimer=timer(s,s.deadline-at,()=>retire(s,'expired'));s.openingTimer=timer(s,Math.min(5000,s.deadline-at),()=>{if(!s.source)retire(s,'expired');});
   const request:HeartRateNotificationRequest=Object.freeze({...scope,action:'subscribe-reported-heart-rate',purpose:requestInput.purpose,providerId:portId,profile:HEART_RATE_SOFTWARE_PROFILE,generation:s.generation,resource:Object.freeze({capabilityId:'heart-rate',operation:'subscribe'}),deadline:s.deadline,budgets:HEART_RATE_SOFTWARE_LIMITS});
   const approved=await issue<HeartRateNotificationGrant|undefined>(s,()=>authorize(request),true);if(!current(s))return;
   let grant:Record<string,unknown>;try{grant=own(approved,['request','signal','expiresAt']);}catch{retire(s,'denied');return;}
   const fresh=time(s);if(!current(s))return;if(grant.request!==request||!isSignal(grant.signal)||grant.signal===owner||grant.signal===s.caller||aborted(grant.signal)||typeof grant.expiresAt!=='number'||!Number.isFinite(grant.expiresAt)||grant.expiresAt<=fresh||grant.expiresAt>s.deadline){retire(s,'denied');return;}
   s.grant=Object.freeze({signal:grant.signal,expiresAt:grant.expiresAt});s.deadline=grant.expiresAt;listener(s,s.grant.signal);if(!current(s))return;if(s.expiryTimer){clearTimeout(s.expiryTimer);s.timers.delete(s.expiryTimer);}s.expiryTimer=timer(s,s.deadline-fresh,()=>retire(s,'expired'));
   if(owners.has(port)){retire(s,'busy');return;}owners.set(port,ownerToken);s.portOwned=true;if(!current(s))return;
   const context:HeartRateNotificationContext=Object.freeze({generation:s.generation,signal:s.controller.signal,deadline:s.deadline,onValue:(bytes:Uint8Array)=>notification(s,bytes),onLost:()=>retire(s,'lost')});
   s.openIssued=true;const ready=await issue<'ready'>(s,()=>Reflect.apply(open,port,[context]),false,true);if(!current(s))return;if(ready!=='ready'){retire(s,'provider');return;}
   const device:DeviceDescriptor=Object.freeze({schemaVersion:1,id:`software-heart-rate-${instance}:generation-${s.generation}`,label:'Reported heart rate',revision:1,adapter:Object.freeze({id:'app:software-heart-rate-notifications',version:'1.0.0'}),runtime:Object.freeze({platform:'software-notification-fixture'}),capabilities:Object.freeze([Object.freeze({id:'heart-rate',semantic:'sensor:reported-heart-rate/1',schemaVersion:1,kind:'sample',value:Object.freeze({type:'scalar',unit:'bpm',min:0,max:65535}),delivery:Object.freeze({mode:'latest',maxHz:20,maxAgeMs:1000}),permissions:Object.freeze(['subscribe'])})])}) as DeviceDescriptor;
   const register=runtime.registerSource;if(!current(s))return;const source=Reflect.apply(register,runtime,[{device,capability:'heart-rate'}]) as EndpointHandle;
   if(!current(s)){try{runtime.unregister(source)}catch{cleanupFailed=true;uncertain(s);}return;}s.source=source;
   const setReady=runtime.setReadiness;if(!current(s))return;const readiness=Reflect.apply(setReady,runtime,[source,'available',s.deadline]) as ReturnType<DeviceRuntime['setReadiness']>;if(!current(s))return;if(!readiness.ok){retire(s,'provider');return;}
   if(s.openingTimer){clearTimeout(s.openingTimer);s.timers.delete(s.openingTimer);}reason='active';s.cancel(Object.freeze({ok:true,value:Object.freeze({source,device,connectionGeneration:s.generation,expiresAt:s.deadline})}));
  }catch{if(!s.retired)retire(s,'provider');}
 }
 return Object.freeze({
  start(intent:Readonly<{purpose:string;signal:AbortSignal;deadline:number}>){if(closed||aborted(owner))return Promise.resolve(fail('closed'));if(session||dispatching)return Promise.resolve(fail('busy'));if(attempts>=16)return Promise.resolve(fail('quota'));
   attempts++;generation++;let cancel!:(result:HeartRateResult<HeartRateActivation>)=>void;const result=new Promise<HeartRateResult<HeartRateActivation>>(r=>{cancel=r});
   const s:Session={generation,retired:false,controller:new AbortController(),deadline:Infinity,portOwned:false,openIssued:false,frames:0,tokens:4,tokenAt:lastClock,operations:new Set(),removers:[],timers:new Set(),cancel};session=s;reason='idle';void begin(s,intent);return result;},
  stop(){if(session)retire(session,'stopped');},
  close(){if(closePromise)return closePromise;let finish!:()=>void;closePromise=new Promise<void>(r=>{finish=r});closed=true;const s=session;if(s)retire(s,'closed');void(s?.retirement??Promise.resolve()).then(finish);return closePromise;},
  sweep(){if(session)current(session);},
  snapshot(){return Object.freeze({phase:closed?'closed':session?.retired?'retiring':session?.source?'active':session?'opening':'idle',reason,attempts,generation,activeSources:session?.source?1:0,rawPending:session?.operations.size??0,cleanupFailed,listeners:session?.removers.length??0,timers:session?.timers.size??0,frames:session?.frames??0});},
 });
}
