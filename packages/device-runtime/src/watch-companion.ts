import { WATCH_COMPANION_REPORT_LIMITS as LIMITS, WATCH_COMPANION_REPORT_PROFILE, decodeWatchCompanionReport, watchCompanionReportDevice } from '@101/device-model';
import type { WatchCompanionReport } from '@101/device-model';
import type { DeviceRuntime, EndpointHandle } from './types.ts';

export interface WatchCompanionRelaySnapshot { readonly platform:'watchos'|'wearos'; readonly companionPaired:boolean;
 readonly appInstalled:boolean; readonly reachable:boolean; readonly nearby:boolean }
/** Opaque enrollment issued by an explicitly trusted phone bridge. Strings and link facts are not authentication. */
export interface WatchCompanionEnrollment { readonly platform:'watchos'|'wearos'; readonly epoch:number;
 readonly signal:AbortSignal; readonly snapshot:Readonly<WatchCompanionRelaySnapshot> }
export interface WatchCompanionReportEvent { readonly enrollment:WatchCompanionEnrollment; readonly data:string }
export interface WatchCompanionBridge {
 enroll(signal:AbortSignal):Promise<WatchCompanionEnrollment>;
 start(enrollment:WatchCompanionEnrollment,onReport:(event:WatchCompanionReportEvent)=>void,onLoss:()=>void,signal:AbortSignal):Promise<void>;
 stop(enrollment:WatchCompanionEnrollment):Promise<void>;
}
export interface WatchCompanionResourceRequest { readonly profile:typeof WATCH_COMPANION_REPORT_PROFILE; readonly ownerId:string;
 readonly operation:'subscribe'; readonly enrollment:WatchCompanionEnrollment }
export interface WatchCompanionResourceOwnerGrant { readonly request:WatchCompanionResourceRequest; readonly expiresAt:number; readonly signal:AbortSignal }
export type WatchCompanionResult<T=undefined> = Readonly<{ok:true;value:T}>|Readonly<{ok:false;reason:'busy'|'closed'|'denied'|'unavailable'|'invalid'|'cancelled'|'capacity'}>;
export interface WatchCompanionResourcesOptions { readonly runtime:DeviceRuntime; readonly bridge:WatchCompanionBridge;
 readonly ownerId:string; readonly now?:()=>number;
 readonly approve:(request:WatchCompanionResourceRequest)=>WatchCompanionResourceOwnerGrant|undefined }
export interface WatchCompanionResources {
 start():Promise<WatchCompanionResult<EndpointHandle>>; stop():void; close():void; sweep():void;
 status():Readonly<{state:'idle'|'opening'|'active'|'closed';reason:string;starts:number;acceptedReports:number;rejectedReports:number;pendingNativeOperations:number}>;
}
const nativeAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
const rawReservations=new WeakSet<object>();
const runtimeEnrollments=new WeakMap<object,Set<object>>();
function aborted(signal:unknown):boolean { try { return nativeAborted.call(signal)!==false; } catch { return true; } }
function own(input:unknown,key:string):unknown { if(!input||typeof input!=='object') throw Error('watch-data');const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!('value'in d)) throw Error('watch-data');return d.value; }
function fields(input:unknown,keys:readonly string[]):void {
 if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).length!==keys.length) throw Error('watch-fields');
 for(const key of keys) own(input,key);
}
function link(input:unknown):WatchCompanionRelaySnapshot {
 fields(input,['platform','companionPaired','appInstalled','reachable','nearby']);
 const platform=own(input,'platform');if(platform!=='watchos'&&platform!=='wearos') throw Error('watch-platform');
 const companionPaired=own(input,'companionPaired'),appInstalled=own(input,'appInstalled'),reachable=own(input,'reachable'),nearby=own(input,'nearby');
 if([companionPaired,appInstalled,reachable,nearby].some(value=>typeof value!=='boolean')||companionPaired!==true||appInstalled!==true||reachable!==true) throw Error('watch-link');
 return Object.freeze({platform,companionPaired,appInstalled,reachable,nearby:nearby as boolean});
}
interface Session { epoch:number; controller:AbortController; enrollment?:WatchCompanionEnrollment; issuer?:AbortSignal; platform?:'watchos'|'wearos'; owner?:AbortSignal;
 expiresAt:number; wallExpiresAt:number; handle?:EndpointHandle; detach:()=>void; timer?:ReturnType<typeof setInterval>;
 lastReceipt:number; lastPublish:number; sequence?:number; emission?:number; latest?:WatchCompanionReport; latestAt?:number; deliverySequence:number }
/** Cooperative host binding: native issuer enrollment is not physical identity or transport authentication. */
export function createWatchCompanionResources(options:WatchCompanionResourcesOptions):WatchCompanionResources {
 const runtime=options.runtime,bridge=options.bridge,approve=options.approve,now=options.now??(()=>performance.now()),ownerId=options.ownerId;
 const enroll=bridge.enroll,startNative=bridge.start,stopNative=bridge.stop;
 if(typeof approve!=='function'||typeof now!=='function'||typeof enroll!=='function'||typeof startNative!=='function'||typeof stopNative!=='function'||
  typeof ownerId!=='string'||!ownerId.length||ownerId.length>128||Array.from(ownerId).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)) throw Error('watch-options');
 let enrollmentSlots=runtimeEnrollments.get(runtime);if(!enrollmentSlots){enrollmentSlots=new Set();runtimeEnrollments.set(runtime,enrollmentSlots);}const slots=enrollmentSlots;
 let session:Session|undefined,closed=false,epoch=0,starts=0,acceptedReports=0,rejectedReports=0,lastNow=-1,reason='idle';
 const yes=<T>(value:T):WatchCompanionResult<T>=>Object.freeze({ok:true,value});
 const no=(value:Extract<WatchCompanionResult,{ok:false}>['reason']):WatchCompanionResult<never>=>Object.freeze({ok:false,reason:value});
 function live(item:Session):boolean { return !closed&&session===item&&epoch===item.epoch&&!aborted(item.controller.signal)&&
  (!item.owner||!aborted(item.owner))&&(!item.issuer||!aborted(item.issuer)); }
 function tick(item:Session):number {
  const value=now();if(!live(item)||typeof value!=='number'||!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER||value<lastNow) throw Error('watch-clock');
  lastNow=value;return value;
 }
 function current(item:Session):boolean {
  if(!live(item)) return false;
  try { const at=tick(item);return live(item)&&at<item.expiresAt&&performance.now()<item.wallExpiresAt; } catch { return false; }
 }
 function retire(item:Session,why:string):void {
  if(session!==item) return;session=undefined;epoch++;reason=why;
  if(item.timer) clearInterval(item.timer);item.detach();item.controller.abort();
  const handle=item.handle;item.handle=undefined;item.latest=undefined;
  if(handle) { try { runtime.unregister(handle); } catch { /* Host cleanup cannot restore enrollment. */ } }
  // No new native operation is issued over an unresolved raw start/enroll. Its finally owns cleanup.
  if(item.enrollment&&!rawReservations.has(bridge)) {
   rawReservations.add(bridge);
   try { Promise.resolve(stopNative.call(bridge,item.enrollment)).then(()=>{rawReservations.delete(bridge);slots.delete(item);},()=>{rawReservations.delete(bridge);slots.delete(item);}); }
   catch { rawReservations.delete(bridge);slots.delete(item); }
  }
 }
 function drain(item:Session):void {
  if(!current(item)) { retire(item,'expired');return; }
  const at=tick(item);if(!live(item)||at>=item.expiresAt||performance.now()>=item.wallExpiresAt) { retire(item,'expired');return; }
  if(at-item.lastReceipt>=LIMITS.inactivityMs) { retire(item,'stale');return; }
  if(!item.handle||!item.latest||at-item.lastPublish<1000/LIMITS.maxHz) return;
  const report=item.latest;item.latest=undefined;item.lastPublish=at;
  const result=runtime.publish(item.handle,report,{sequence:++item.deliverySequence,timestamp:item.latestAt!,clockDomain:runtime.clockDomain,
   provenance:{profile:WATCH_COMPANION_REPORT_PROFILE,observation:'phone-receipt-report',captureTimeKnown:false,physicalValidity:'unspecified',
    relayEmissionMs:report.relayEmissionMs,platform:item.platform!}});
  if(!current(item)) { retire(item,'retired');return; }
  if(!result.ok) retire(item,'publish-failed');
 }
 function report(item:Session,event:WatchCompanionReportEvent):void {
  if(!live(item)) return;
  try {
   fields(event,['enrollment','data']);if(own(event,'enrollment')!==item.enrollment) return;
   if(!current(item)) { retire(item,'expired');return; }
   const data=own(event,'data');if(typeof data!=='string'||data.length!==72||!/^[A-Za-z0-9+/]{71}=$/.test(data)) throw Error('watch-base64');
   const text=atob(data);if(text.length!==53||btoa(text)!==data) throw Error('watch-base64');
   const decoded=decodeWatchCompanionReport(Uint8Array.from(text,char=>char.charCodeAt(0)));
   const at=tick(item);if(!live(item)||at>=item.expiresAt||performance.now()>=item.wallExpiresAt) { retire(item,'expired');return; }
   if(item.sequence!==undefined) { const delta=(decoded.sequence-item.sequence+65536)%65536;
    if(delta===0||delta>32767||decoded.relayEmissionMs<item.emission!) throw Error('watch-replay'); }
   item.sequence=decoded.sequence;item.emission=decoded.relayEmissionMs;item.lastReceipt=at;item.latest=decoded;item.latestAt=at;acceptedReports++;
   drain(item);
  } catch { rejectedReports++;retire(item,'invalid-report'); }
 }
 const controller:WatchCompanionResources={
  async start() {
   if(closed) return no('closed');if(session||rawReservations.has(bridge)) return no('busy');if(starts>=LIMITS.lifetimeStarts||slots.size>=LIMITS.enrollments) return no('capacity');
   starts++;rawReservations.add(bridge);
   const item:Session={epoch:++epoch,controller:new AbortController(),expiresAt:Infinity,wallExpiresAt:performance.now()+LIMITS.ownerMs,
    lastReceipt:0,lastPublish:-Infinity,deliverySequence:0,detach:()=>{}};slots.add(item);session=item;reason='opening';
   
   try {
    const began=tick(item);item.expiresAt=began+LIMITS.ownerMs;item.lastReceipt=began;
    item.timer=setInterval(()=>{if(!current(item))retire(item,'expired');},50);
    const enrollment=await enroll.call(bridge,item.controller.signal);
    fields(enrollment,['platform','epoch','signal','snapshot']);const snapshot=link(own(enrollment,'snapshot'));
    const nativeEpoch=own(enrollment,'epoch'),signal=own(enrollment,'signal');
    if(own(enrollment,'platform')!==snapshot.platform||typeof nativeEpoch!=='number'||!Number.isSafeInteger(nativeEpoch)||nativeEpoch<1) throw Error('watch-enrollment');
    item.enrollment=enrollment;item.issuer=signal as AbortSignal;item.platform=snapshot.platform;if(aborted(signal)||!current(item))return no('cancelled');
    const request=Object.freeze({profile:WATCH_COMPANION_REPORT_PROFILE,ownerId,operation:'subscribe' as const,enrollment});
    const grant=approve(request);if(!current(item)||!grant) return no('denied');
    fields(grant,['request','expiresAt','signal']);const expiresAt=own(grant,'expiresAt'),owner=own(grant,'signal');
    if(own(grant,'request')!==request||typeof expiresAt!=='number'||!Number.isFinite(expiresAt)||expiresAt<0||aborted(owner)) return no('denied');
    item.owner=owner as AbortSignal;const at=tick(item);
    item.expiresAt=Math.min(item.expiresAt,expiresAt);item.wallExpiresAt=Math.min(item.wallExpiresAt,performance.now()+Math.max(0,item.expiresAt-at));
    if(!current(item)) return no('denied');
    const cancel=()=>retire(item,'revoked');
    EventTarget.prototype.addEventListener.call(item.owner,'abort',cancel,{once:true});
    EventTarget.prototype.addEventListener.call(item.issuer,'abort',cancel,{once:true});
    item.detach=()=>{EventTarget.prototype.removeEventListener.call(item.owner!,'abort',cancel);EventTarget.prototype.removeEventListener.call(item.issuer,'abort',cancel);};
    if(!current(item)) return no('denied');
    await startNative.call(bridge,enrollment,event=>report(item,event),()=>retire(item,'link-lost'),item.controller.signal);
    if(!current(item)) return no('cancelled');
    const handle=runtime.registerSource({device:watchCompanionReportDevice(`watch:report-${item.epoch}`,item.platform),capability:'report'});
    if(!current(item)) { runtime.unregister(handle);return no('cancelled'); }item.handle=handle;
    const ready=runtime.setReadiness(handle,'available',item.expiresAt);
    if(!ready.ok||!current(item)) return no('cancelled');
    reason='active';if(item.timer)clearInterval(item.timer);if(!item.latest)item.lastReceipt=tick(item);item.timer=setInterval(()=>{try{drain(item);}catch{retire(item,'invalid-clock');}},50);
    if(!current(item)) return no('cancelled');drain(item);
    if(!current(item)) return no('cancelled');return yes(handle);
   } catch { return no('unavailable'); }
   finally {
    // Reservation stays held until actual native Promise settlement and matching cleanup returns.
    if(!live(item)||!item.handle) {
     retire(item,'retired');
     if(item.enrollment) { try { await stopNative.call(bridge,item.enrollment); } catch { /* No new authority. */ } }
     slots.delete(item);
    }
    rawReservations.delete(bridge);
   }
  },
  stop(){if(session) retire(session,'stopped');},
  close(){if(closed)return;closed=true;if(session)retire(session,'closed');reason='closed';},
  sweep(){const item=session;if(item) {try{drain(item);}catch{retire(item,'invalid-clock');}}},
  status(){return Object.freeze({state:closed?'closed':session?(session.handle?'active':'opening'):'idle',reason,starts,acceptedReports,rejectedReports,pendingNativeOperations:rawReservations.has(bridge)?1:0});},
 };
 return Object.freeze(controller);
}
