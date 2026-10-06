import type { WatchCompanionBridge, WatchCompanionEnrollment, WatchCompanionRelaySnapshot, WatchCompanionReportEvent } from '@101/device-runtime';
import { NativeModule, requireNativeModule, type EventSubscription } from "expo-modules-core";

/**
 * Phone-side receiver for wrist samples relayed by the 101 watch companions.
 *
 * The two platforms use entirely different frameworks — Watch Connectivity on iOS, the Wearable
 * Data Layer on Android — but both deliver the same 53-byte payload, so this exposes one interface
 * and `@101/adapter-watch` decodes it without a per-platform branch.
 *
 * Bytes cross the bridge base64-encoded because that is the only binary representation both Expo
 * platforms pass reliably; it costs about a third more size on a link that is already local, and
 * buys a single code path.
 */
export interface WatchLinkSnapshot {
  /** "watchos" or "wearos". */
  platform: "watchos" | "wearos";
  companionPaired: boolean;
  appInstalled: boolean;
  reachable: boolean;
  /** Wear OS only. Undefined on watchOS, where proximity is not the deciding signal. */
  nearby?: boolean;
}

export interface WatchSampleEvent {
  /** Base64-encoded 53-byte payload. */
  data: string;
}

type One01WatchEvents = {
  onWatchSample: (event: WatchSampleEvent) => void;
  onWatchLinkChange: (snapshot: WatchLinkSnapshot) => void;
  onWatchResourceSample: (event: { epoch:number;data:string }) => void;
  onWatchResourceLoss: (event: { epoch:number }) => void;
};

declare class One01WatchNativeModule extends NativeModule<One01WatchEvents> {
  /** True when the platform can receive watch samples at all. */
  isSupported(): boolean;
  enrollResources(): Promise<WatchCompanionRelaySnapshot & {epoch:number}>;
  startResources(epoch:number): Promise<void>;
  stopResources(epoch:number): Promise<void>;
  /** Begins listening. Safe to call repeatedly. */
  start(): Promise<WatchLinkSnapshot>;
  stop(): Promise<void>;
  /** Current companion state; locality is derived in `@101/adapter-watch`, never asserted here. */
  getLinkState(): Promise<WatchLinkSnapshot>;
  /** Sends a short haptic on the watch, where the platform supports it. */
  playHaptic(): Promise<void>;
}

const native = requireNativeModule<One01WatchNativeModule>("One01Watch");

export function isWatchSupported() {
  return native.isSupported();
}

export function startWatchRelay() {
  return native.start();
}

export function stopWatchRelay() {
  return native.stop();
}

export function getWatchLinkState() {
  return native.getLinkState();
}

export function playWatchHaptic() {
  return native.playHaptic();
}

export function addWatchSampleListener(listener: (event: WatchSampleEvent) => void): EventSubscription {
  return native.addListener("onWatchSample", listener);
}

export function addWatchLinkListener(listener: (event: WatchLinkSnapshot) => void): EventSubscription {
  return native.addListener("onWatchLinkChange", listener);
}

/** Explicit trusted native port. Injection is for software tests; it is not native delivery evidence. */
export interface WatchResourceNativePort {
 enrollResources():Promise<WatchCompanionRelaySnapshot & {epoch:number}>;
 startResources(epoch:number):Promise<void>;stopResources(epoch:number):Promise<void>;
 addListener(name:'onWatchResourceSample',listener:(event:{epoch:number;data:string})=>void):EventSubscription;
 addListener(name:'onWatchResourceLoss',listener:(event:{epoch:number})=>void):EventSubscription;
}
interface ResourceEnrollment {
 token:WatchCompanionEnrollment; controller:AbortController; nativeEpoch:number; active:boolean;
 detach:()=>void; stopping?:Promise<void>;
}
interface ResourcePortState { enrolling?:boolean; operation?:{done:Promise<void>}; attempts:number; selected?:ResourceEnrollment }
const resourcePorts=new WeakMap<object,ResourcePortState>();
const nativeSignalAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
function signalAborted(signal:unknown):boolean {try{return nativeSignalAborted.call(signal)!==false;}catch{return true;}}
function resourceOwn(input:unknown,key:string):unknown {
 if(!input||typeof input!=='object')throw Error('watch-resource-data');const value=Object.getOwnPropertyDescriptor(input,key);
 if(!value||!('value'in value))throw Error('watch-resource-data');return value.value;
}
function resourceFields(input:unknown,keys:readonly string[]):void {
 if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).length!==keys.length)throw Error('watch-resource-shape');
 for(const key of keys)resourceOwn(input,key);
}
/** New channel owns only SDK resource listeners; legacy game listeners/start/stop remain separate. */
export function createWatchResourceBridge(port:WatchResourceNativePort=native):WatchCompanionBridge {
 let state=resourcePorts.get(port);if(!state){state={attempts:0};resourcePorts.set(port,state);}const shared=state;
 const enrollNative=port.enrollResources,startNative=port.startResources,stopNative=port.stopResources,listen=port.addListener as (name:'onWatchResourceSample'|'onWatchResourceLoss',listener:(event:never)=>void)=>EventSubscription;
 if([enrollNative,startNative,stopNative,listen].some(value=>typeof value!=='function'))throw Error('watch-resource-port');
 const owned=new WeakMap<object,ResourceEnrollment>();
 async function operation<T>(work:()=>T|Promise<T>):Promise<T> {
  if(shared.operation)throw Error('watch-resource-busy');
  let finish!:()=>void;const slot={done:new Promise<void>(resolve=>{finish=resolve;})};shared.operation=slot;
  try{return await work();}finally{if(shared.operation===slot)shared.operation=undefined;finish();}
 }
 function selected(input:WatchCompanionEnrollment):ResourceEnrollment {
  const item=owned.get(input);if(!item||shared.selected!==item||signalAborted(item.controller.signal))throw Error('watch-resource-enrollment');return item;
 }
 function retire(item:ResourceEnrollment):Promise<void> {
  if(item.stopping){item.detach();return item.stopping;}
  item.active=false;
  const pending=shared.operation?.done;
  item.stopping=Promise.resolve().then(async()=>{
   if(pending)await pending;
   try{await operation(()=>stopNative.call(port,item.nativeEpoch));}
   finally{if(shared.selected===item)shared.selected=undefined;}
  });
  item.controller.abort();item.detach();return item.stopping;
 }
 const bridge:WatchCompanionBridge={
  async enroll(signal){
   if(shared.enrolling||shared.operation||shared.selected)throw Error('watch-resource-busy');if(shared.attempts>=64||signalAborted(signal))throw Error('watch-resource-denied');
   shared.attempts++;shared.enrolling=true;
   try {
   const result=await operation(()=>enrollNative.call(port));
   // A cancelled enrollment still retires the exact native scope before another may be issued.
   const epoch=resourceOwn(result,'epoch');
   if(typeof epoch!=='number'||!Number.isSafeInteger(epoch)||epoch<1)throw Error('watch-resource-epoch');
   if(signalAborted(signal)){await operation(()=>stopNative.call(port,epoch));throw Error('watch-resource-denied');}
   let item:ResourceEnrollment|undefined;
   try {
    resourceFields(result,['platform','companionPaired','appInstalled','reachable','nearby','epoch']);
    const platform=resourceOwn(result,'platform');
    if(platform!=='watchos'&&platform!=='wearos')throw Error('watch-resource-platform');
    const snapshot=Object.freeze({platform,companionPaired:resourceOwn(result,'companionPaired'),appInstalled:resourceOwn(result,'appInstalled'),
     reachable:resourceOwn(result,'reachable'),nearby:resourceOwn(result,'nearby')});
    if(snapshot.companionPaired!==true||snapshot.appInstalled!==true||snapshot.reachable!==true||typeof snapshot.nearby!=='boolean')throw Error('watch-resource-unavailable');
    const controller=new AbortController(),token=Object.freeze({platform,epoch,signal:controller.signal,snapshot:snapshot as WatchCompanionRelaySnapshot});
    item={token,controller,nativeEpoch:epoch,active:false,detach:()=>{}};shared.selected=item;owned.set(token,item);
    const captured=item,cancel=()=>{void retire(captured).catch(()=>{});};
    EventTarget.prototype.addEventListener.call(signal,'abort',cancel,{once:true});
    item.detach=()=>EventTarget.prototype.removeEventListener.call(signal,'abort',cancel);
    if(signalAborted(signal)||signalAborted(controller.signal))throw Error('watch-resource-denied');return token;
   }catch(error){if(item)await retire(item);else await operation(()=>stopNative.call(port,epoch));throw error;}
   } finally {shared.enrolling=false;}
  },
  async start(enrollment,onReport,onLoss,signal){
   const item=selected(enrollment);if(shared.operation||item.active||signalAborted(signal)||typeof onReport!=='function'||typeof onLoss!=='function')throw Error('watch-resource-busy');
   item.active=true;const subscriptions:EventSubscription[]=[];const priorDetach=item.detach;
   const current=()=>shared.selected===item&&item.active&&!signalAborted(signal)&&!signalAborted(item.controller.signal);
   item.detach=()=>{priorDetach();const captured=subscriptions.splice(0);for(const sub of captured){try{sub.remove();}catch{/* Native teardown remains owned. */}}};
   const lose=()=>{if(!current())return;void retire(item).catch(()=>{});try{onLoss();}catch{/* Fixed closed state. */}};
   try {
    subscriptions.push(listen.call(port,'onWatchResourceSample',((event:{epoch:number;data:string})=>{
     if(!current())return;
     try{resourceFields(event,['epoch','data']);if(resourceOwn(event,'epoch')!==item.nativeEpoch)return;
      const data=resourceOwn(event,'data');if(typeof data!=='string'||data.length!==72)throw Error('watch-resource-size');
      const report:WatchCompanionReportEvent=Object.freeze({enrollment,data});if(current())onReport(report);
     }catch{lose();}
    }) as never));if(!current())throw Error('watch-resource-cancelled');
    subscriptions.push(listen.call(port,'onWatchResourceLoss',((event:{epoch:number})=>{try{resourceFields(event,['epoch']);if(resourceOwn(event,'epoch')===item.nativeEpoch)lose();}catch{lose();}}) as never));
    if(!current())throw Error('watch-resource-cancelled');
    const cancel=()=>{void retire(item).catch(()=>{});};EventTarget.prototype.addEventListener.call(signal,'abort',cancel,{once:true});
    const detached=item.detach;item.detach=()=>{detached();EventTarget.prototype.removeEventListener.call(signal,'abort',cancel);};
    if(!current())throw Error('watch-resource-cancelled');
    await operation(()=>startNative.call(port,item.nativeEpoch));if(!current())throw Error('watch-resource-cancelled');
   }catch(error){await retire(item);throw error;}
  },
  async stop(enrollment){const item=owned.get(enrollment);if(!item)return;await retire(item);},
 };
 return Object.freeze(bridge);
}
