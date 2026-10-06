import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createDeviceRuntime } from '@101/connect';
import type { Authorize, Connection, DeliveryContext, DeviceRuntime, EndpointHandle, Observation } from '@101/connect';

const PROFILE='subscribed-runtime-load/1';
export const RUNTIME_LOAD_TIERS=Object.freeze([16,64,128].map(edges=>Object.freeze({edges,scopes:4,fanout:16,
 sustainedTurns:60,intervalMs:20,heldTurns:8,recoveryTurns:20,maxPending:8,maxPendingPerScope:2,
 maxPayloadBytes:256,maxAttempts:4096,maxLifetimeMs:12000,workerOldHeapMiB:16,workerYoungHeapMiB:4,workerStackMiB:1})));
export interface RuntimeLoadOptions {readonly tier:16|64|128;readonly signal:AbortSignal;readonly authorize:Authorize}
interface ScopeMetrics {scopeIndex:number;admittedEdges:number;accepted:number;coalesced:number;dispatched:number;currentApplied:number;
 lateApplied:number;cancelledBeforeEffect:number;retiredQueued:number;uncertainOnExit:number;peakRaw:number;heldDispatches:number;recoveryApplied:number;
 perEdge:number[];ackTiming:{count:number;minimumMs:number;maximumMs:number;totalMs:number};workerEmission:{clockId:string;count:number;firstMs:number;lastMs:number}}
export interface RuntimeLoadReceipt {readonly profile:string;readonly status:'pass'|'denied'|'cancelled'|'failed'|'busy'|'invalid'|'capacity';
 readonly tier:number;readonly scopes:readonly ScopeMetrics[];readonly turns:number;readonly sustainedElapsedMs:number;readonly actualTurnHz:number;
 readonly denialDispatchDelta:number;readonly overloadDispatchDelta:number;readonly overloadPreserved:boolean;readonly heldOtherScopeProgress:boolean;
 readonly allEdgesServed:boolean;readonly acceptedNotDispatched:number;readonly ownedCleanup:Readonly<{workersStarted:number;workersExited:number;pendingRaw:number;timers:number;listeners:number;contexts:number}>;
 readonly scope:string;readonly reason:string}
const nativeAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
let running=false,attempts=0;
function aborted(signal:unknown):boolean{try{return nativeAborted.call(signal)!==false;}catch{return true;}}
function own(input:unknown,key:string):unknown {if(!input||typeof input!=='object')throw Error('invalid');const property=Object.getOwnPropertyDescriptor(input,key);if(!property||!('value'in property))throw Error('invalid');return property.value;}
function shape(input:unknown,keys:readonly string[]):void{if(!input||typeof input!=='object'||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).length!==keys.length)throw Error('invalid');for(const key of keys)own(input,key);}
function integer(value:unknown,min:number,max:number):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;}
interface NativePending {edge:number;sequence:number;state:number;context:DeliveryContext;at:number;issued:boolean;held:boolean;detach:()=>void;resolve:()=>void}
class ApplicationTarget {
 readonly metric:ScopeMetrics;private current:()=>boolean;private fail:()=>void;
 readonly worker:Worker;readonly ready:Promise<void>;readonly exited:Promise<void>;private readyYes!:()=>void;private readyNo!:(error:Error)=>void;private exitYes!:()=>void;
 private pending=new Map<number,NativePending>();private control?:{resolve:()=>void;reject:(error:Error)=>void};private id=0;private closing=false;private didExit=false;
 private startupTimer?:ReturnType<typeof setTimeout>;private closeTimer?:ReturnType<typeof setTimeout>;private messages=0;private outputBytes=0;
 constructor(metric:ScopeMetrics,current:()=>boolean,fail:()=>void) {
  this.metric=metric;this.current=current;this.fail=fail;
  this.ready=new Promise((resolve,reject)=>{this.readyYes=resolve;this.readyNo=reject;});this.exited=new Promise(resolve=>{this.exitYes=resolve;});void this.ready.catch(()=>{});
  this.worker=new Worker(new URL('./application-target.mjs',import.meta.url),{workerData:{schemaVersion:1,scopeIndex:metric.scopeIndex},
   execArgv:[],argv:[],env:{NODE_ENV:'production'},stdin:false,stdout:true,stderr:true,
   resourceLimits:{maxOldGenerationSizeMb:16,maxYoungGenerationSizeMb:4,stackSizeMb:1,codeRangeSizeMb:4}});
  this.worker.on('message',this.message);this.worker.on('error',this.error);this.worker.on('exit',this.exit);
  this.worker.stdout?.on('data',this.output);this.worker.stderr?.on('data',this.output);
  this.startupTimer=setTimeout(()=>{this.readyNo(Error('worker-unavailable'));this.fail();},2500);
 }
 private output=(bytes:Uint8Array)=>{this.outputBytes+=bytes.byteLength;if(this.outputBytes>4096)this.fail();};
 private error=()=>{this.readyNo(Error('worker-failed'));this.fail();};
 private exit=()=>{
  this.didExit=true;if(this.startupTimer)clearTimeout(this.startupTimer);if(this.closeTimer)clearTimeout(this.closeTimer);
  this.readyNo(Error('worker-ended'));this.control?.reject(Error('worker-ended'));this.control=undefined;
  for(const [id,item]of this.pending){if(item.issued)this.metric.uncertainOnExit++;this.finish(id);}if(!this.closing)this.fail();this.exitYes();
 };
 private finish(id:number):void {const item=this.pending.get(id);if(!item)return;this.pending.delete(id);item.detach();item.resolve();}
 private message=(input:unknown)=>{
  try {
   if(++this.messages>2048)throw Error('traffic');const kind=own(input,'kind'),clock=own(input,'clockId'),emitted=own(input,'emittedAt');
   if(clock!=='owned-node-worker-'+this.metric.scopeIndex||typeof emitted!=='number'||!Number.isFinite(emitted)||emitted<0||emitted<this.metric.workerEmission.lastMs)throw Error('clock');
   const emission=this.metric.workerEmission;if(emission.count===0)emission.firstMs=emitted;emission.lastMs=emitted;emission.count++;
   if(kind==='ready'){shape(input,['kind','profile','scopeIndex','clockId','emittedAt']);if(own(input,'profile')!=='subscribed-runtime-load-target/1'||own(input,'scopeIndex')!==this.metric.scopeIndex)throw Error('producer');if(this.startupTimer)clearTimeout(this.startupTimer);this.startupTimer=undefined;this.readyYes();return;}
   if(kind==='holding'){shape(input,['kind','hold','pending','clockId','emittedAt']);if(typeof own(input,'hold')!=='boolean'||!integer(own(input,'pending'),0,2))throw Error('control');this.control?.resolve();this.control=undefined;return;}
   if(kind==='closed'){shape(input,['kind','entries','clockId','emittedAt']);if(!integer(own(input,'entries'),0,32))throw Error('close');return;}
   if(kind!=='applied'&&kind!=='held'&&kind!=='cancelled'&&kind!=='rejected')throw Error('producer');
   const id=own(input,'id');if(!integer(id,1,4096))throw Error('id');const item=this.pending.get(id);if(!item)return;
   if(kind==='held'){shape(input,['kind','id','clockId','emittedAt']);item.held=true;this.metric.heldDispatches++;return;}
   if(kind==='applied'){
    shape(input,['kind','id','edge','sequence','state','clockId','emittedAt']);
    if(own(input,'edge')!==item.edge||own(input,'sequence')!==item.sequence||own(input,'state')!==item.state)throw Error('effect');
    const isCurrent=item.context.isCurrent();const at=performance.now();
    if(isCurrent&&this.current()&&!aborted(item.context.signal)){
     const confirmed=this.metric.perEdge[item.edge];if(confirmed===undefined)throw Error('edge');
     this.metric.currentApplied++;this.metric.perEdge[item.edge]=confirmed+1;const timing=this.metric.ackTiming;const duration=at-item.at;
     timing.count++;timing.minimumMs=Math.min(timing.minimumMs,duration);timing.maximumMs=Math.max(timing.maximumMs,duration);timing.totalMs+=duration;
    }else this.metric.lateApplied++;
   }else {shape(input,['kind','id','clockId','emittedAt']);if(kind==='cancelled')this.metric.cancelledBeforeEffect++;else this.fail();}
   this.finish(id);
  }catch{this.fail();}
 };
 apply(edge:number,observation:Observation,context:DeliveryContext):Promise<void> {
  if(this.closing||this.didExit||this.pending.size>=2||this.id>=4096)return Promise.reject(Error('target-capacity'));
  const id=++this.id;let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});
  const item:NativePending={edge,sequence:0,state:0,context,at:performance.now(),issued:false,held:false,detach:()=>{},resolve:finish};this.pending.set(id,item);this.metric.peakRaw=Math.max(this.metric.peakRaw,this.pending.size);
  try {
   const value=observation.value;shape(value,['sequence','state']);const sequence=own(value,'sequence'),state=own(value,'state');
   if(!integer(sequence,1,256)||!integer(state,0,256))throw Error('value');item.sequence=sequence;item.state=state;
   const valid=context.isCurrent();if(!valid||!this.current()||aborted(context.signal)){this.finish(id);return done;}
   const cancel=()=>{if(item.issued&&!this.didExit)this.worker.postMessage({kind:'cancel',id});};
   EventTarget.prototype.addEventListener.call(context.signal,'abort',cancel,{once:true});item.detach=()=>EventTarget.prototype.removeEventListener.call(context.signal,'abort',cancel);
   if(!this.current()||aborted(context.signal)){this.finish(id);return done;}
   item.issued=true;this.worker.postMessage({kind:'apply',id,edge,sequence,state});this.metric.dispatched++;
  }catch{this.finish(id);this.fail();}
  return done;
 }
 async hold(value:boolean):Promise<void>{if(this.control||this.closing)throw Error('target-busy');const done=new Promise<void>((resolve,reject)=>{this.control={resolve,reject};});this.worker.postMessage({kind:'hold',hold:value});await done;}
 async close():Promise<void>{
  if(!this.closing){this.closing=true;if(!this.didExit){this.worker.postMessage({kind:'close'});this.closeTimer=setTimeout(()=>{void this.worker.terminate();},1000);}}
  await this.exited;if(this.startupTimer)clearTimeout(this.startupTimer);if(this.closeTimer)clearTimeout(this.closeTimer);this.startupTimer=undefined;this.closeTimer=undefined;
  this.worker.removeListener('message',this.message);this.worker.removeListener('error',this.error);this.worker.removeListener('exit',this.exit);
  this.worker.stdout?.removeListener('data',this.output);this.worker.stderr?.removeListener('data',this.output);
 }
 get heldEdges():readonly number[]{return [...this.pending.values()].filter(item=>item.held).map(item=>item.edge);}
 get ownedTimers():number{return Number(this.startupTimer!==undefined)+Number(this.closeTimer!==undefined);}
 get ownedListeners():number{return this.worker.listenerCount('message')+this.worker.listenerCount('error')+this.worker.listenerCount('exit')+Number(this.control!==undefined)+
  (this.worker.stdout?.listeners('data').filter(listener=>listener===this.output).length??0)+(this.worker.stderr?.listeners('data').filter(listener=>listener===this.output).length??0);}
 get pendingRaw():number{return this.pending.size;}
 get hasExited():boolean{return this.didExit;}
}
function descriptor(id:string,sink=false){return{schemaVersion:1,id,label:'Owned load integer state',revision:1,adapter:{id:'example:runtime-load',version:'1.0.0'},runtime:{platform:'node-worker'},
 capabilities:[{id:'state',semantic:'example:load-state',schemaVersion:1,kind:sink?'property':'sample',value:{type:'record',fields:{sequence:{type:'scalar',unit:'1',min:1,max:256},state:{type:'scalar',unit:'1',min:0,max:256}}},
 delivery:{mode:'latest',maxHz:50,maxAgeMs:250},permissions:sink?['write']:['subscribe'],...(sink?{ownership:{mode:'exclusive'}}:{})}]};}
/** Fixed owned software workload, not an arbitrary target/command runner or a hardware/SLO certification. */
export async function runRuntimeLoadQualification(options:RuntimeLoadOptions):Promise<RuntimeLoadReceipt>{
 const base={profile:PROFILE,tier:0,scopes:[] as ScopeMetrics[],turns:0,sustainedElapsedMs:0,actualTurnHz:0,denialDispatchDelta:0,overloadDispatchDelta:0,
 overloadPreserved:false,heldOtherScopeProgress:false,allEdgesServed:false,acceptedNotDispatched:0,
 ownedCleanup:{workersStarted:0,workersExited:0,pendingRaw:0,timers:0,listeners:0,contexts:0},
 scope:'Owned Node workers and sparse subscribed latest edges only. Coalescing may discard intermediate states. ACK timing is parent admission-to-ACK; worker emission is a separate source clock. Worker heap ceilings are not RSS/thermal/platform guarantees. Issued effects can remain uncertain after retirement.',reason:'',status:'invalid' as RuntimeLoadReceipt['status']};
 if(running)return Object.freeze({...base,status:'busy',reason:'busy'});if(attempts>=32)return Object.freeze({...base,status:'capacity',reason:'attempt-capacity'});
 running=true;attempts++;
 const owned=new AbortController(),targets:ApplicationTarget[]=[],routes:Connection[]=[];
 let runtime:DeviceRuntime|undefined,signal:AbortSignal|undefined,lifetime:ReturnType<typeof setTimeout>|undefined,detach=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
 let failed=false,phase='setup',sequence=0;let abortReject!:(error:Error)=>void;
 const cancellation=new Promise<never>((_resolve,reject)=>{abortReject=reject;});void cancellation.catch(()=>{});
 const current=()=>!failed&&!aborted(owned.signal)&&!!signal&&!aborted(signal);
 function noteQueued(){for(const row of rows)if(row.route.status().state==='active')base.scopes[row.scope]!.retiredQueued+=row.route.status().pending;}
 function cancel(){owned.abort();noteQueued();runtime?.close();abortReject(Error('cancelled'));}
 const fail=()=>{failed=true;cancel();};
 async function wait(ms:number){await Promise.race([new Promise<void>(resolve=>{timer=setTimeout(()=>{timer=undefined;resolve();},ms);}),cancellation]);}
 const groups:{source:EndpointHandle;scope:number;edges:number[]}[]=[];
 const rows:({route:Connection;source:EndpointHandle;sink:EndpointHandle;scope:number;edge:number})[]=[];
 try {
  shape(options,['tier','signal','authorize']);const tier=own(options,'tier'),inputSignal=own(options,'signal'),authorize=own(options,'authorize');
  if((tier!==16&&tier!==64&&tier!==128)||typeof authorize!=='function'||aborted(inputSignal)){base.status=aborted(inputSignal)?'cancelled':'invalid';base.reason=base.status;return base;}
  signal=inputSignal as AbortSignal;base.tier=tier;
  const abort=()=>cancel();EventTarget.prototype.addEventListener.call(signal,'abort',abort,{once:true});detach=()=>EventTarget.prototype.removeEventListener.call(signal!,'abort',abort);
  if(aborted(signal)){cancel();throw Error('cancelled');}
  lifetime=setTimeout(fail,12000);
  for(let scope=0;scope<4;scope++){
   const metric:ScopeMetrics={scopeIndex:scope,admittedEdges:0,accepted:0,coalesced:0,dispatched:0,currentApplied:0,lateApplied:0,cancelledBeforeEffect:0,retiredQueued:0,uncertainOnExit:0,peakRaw:0,heldDispatches:0,recoveryApplied:0,
    perEdge:Array<number>(tier).fill(0),ackTiming:{count:0,minimumMs:Infinity,maximumMs:0,totalMs:0},workerEmission:{clockId:'owned-node-worker-'+scope,count:0,firstMs:0,lastMs:0}};
   base.scopes.push(metric);targets.push(new ApplicationTarget(metric,current,fail));base.ownedCleanup.workersStarted++;
  }
  await Promise.race([Promise.all(targets.map(target=>target.ready)),cancellation]);if(!current())throw Error('cancelled');
  const allowed=new Map<string,{scope:number;source:string}>();
  runtime=createDeviceRuntime({now:()=>performance.now(),maxRoutes:tier,maxSubscribers:16,maxRegistrations:tier+12,maxPendingDeliveries:8,maxPendingDeliveriesPerScope:2,
   authorize(request){
    const entry=allowed.get(request.sink.registrationId);
    if(!current()||!entry||request.source.registrationId!==entry.source||request.sourceOperation!=='subscribe'||request.sinkOperation!=='write'||
     request.principalId!=='load-owner-'+entry.scope||request.applicationId!=='load-app-'+entry.scope||request.sessionId!=='load-session-'+entry.scope)return;
    const grant=(authorize as Authorize)(request);if(!grant||!current())return;
    const keys=Reflect.ownKeys(grant);if(keys.length<2||keys.length>3||keys.some(key=>!['expiresAt','maxAgeMs','maxHz'].includes(String(key))))return;
    const expiresAt=own(grant,'expiresAt'),maxAgeMs=own(grant,'maxAgeMs'),maxHz=Object.hasOwn(grant,'maxHz')?own(grant,'maxHz'):50;
    if(typeof expiresAt!=='number'||typeof maxAgeMs!=='number'||typeof maxHz!=='number')return;
    const selected={expiresAt:expiresAt,maxAgeMs:Math.min(maxAgeMs,250),maxHz:Math.min(maxHz,50)};
    return current()?selected:undefined;
   }});
  for(let scope=0;scope<4;scope++)for(let group=0;group<Math.ceil((tier/4)/16);group++){
   const source=runtime.registerSource({device:descriptor('load:source-'+scope+'-'+group),capability:'state'});runtime.setReadiness(source,'available');groups.push({source,scope,edges:[]});
  }
  for(let edge=0;edge<tier;edge++){
   if(!current())throw Error('cancelled');const scope=edge%4,group=groups.find(entry=>entry.scope===scope&&entry.edges.length<16)!;group.edges.push(edge);
   const sink=runtime.registerSink({device:descriptor('load:sink-'+edge,true),capability:'state',apply:(observation,context)=>targets[scope]!.apply(edge,observation,context),release(){}});
   runtime.setReadiness(sink,'available');allowed.set(sink.id,{scope,source:group.source.id});
   if(edge===0){
    const denied=runtime.route({from:group.source,to:sink,principalId:'foreign-tenant',applicationId:'foreign-app',sessionId:'foreign-session',sourceOperation:'subscribe'});routes.push(denied);
    const rejected=denied.start();if(rejected.ok||rejected.reason!=='denied')throw Error('tenant');runtime.flush();
    base.denialDispatchDelta=base.scopes.reduce((sum,row)=>sum+row.dispatched,0);if(base.denialDispatchDelta!==0)throw Error('tenant');
   }
   const route=runtime.route({from:group.source,to:sink,principalId:'load-owner-'+scope,applicationId:'load-app-'+scope,sessionId:'load-session-'+scope,sourceOperation:'subscribe',queueCapacity:1,leaseMs:10000});routes.push(route);
   if(!route.start().ok){base.status=current()?'denied':'cancelled';base.reason='route-denied';return base;}
   if(!current()){route.stop('cancelled');throw Error('cancelled');}rows.push({route,source:group.source,sink,scope,edge});base.scopes[scope]!.admittedEdges++;
  }
  const first=rows[0]!;
  const extra=runtime.registerSink({device:descriptor('load:overload',true),capability:'state',apply(){base.overloadDispatchDelta++;},release(){}});runtime.setReadiness(extra,'available');allowed.set(extra.id,{scope:0,source:first.source.id});
  const overload=runtime.route({from:first.source,to:extra,principalId:'load-owner-0',applicationId:'load-app-0',sessionId:'load-session-0',sourceOperation:'subscribe'});routes.push(overload);
  const overloadResult=overload.start();if(overloadResult.ok||overloadResult.reason!=='capacity')throw Error('overload');
  async function turn(){
   if(!current())throw Error('cancelled');sequence++;if(sequence>256)throw Error('attempts');
   for(const group of groups){const pending=group.edges.filter(edge=>rows[edge]!.route.status().state==='active'&&rows[edge]!.route.status().pending===1).length;
    const result=runtime!.publish(group.source,{sequence,state:sequence});if(result.ok){base.scopes[group.scope]!.accepted+=result.value.accepted;base.scopes[group.scope]!.coalesced+=pending;}}
   runtime!.flush();if(rows.some(row=>row.route.status().pending>1))throw Error('queue');await wait(20);
  }
  phase='sustained';const began=performance.now();for(let index=0;index<60;index++){await turn();base.turns++;}
  base.sustainedElapsedMs=performance.now()-began;base.actualTurnHz=base.turns*1000/base.sustainedElapsedMs;
  base.allEdgesServed=rows.every(row=>base.scopes[row.scope]!.perEdge[row.edge]!>0);if(!base.allEdgesServed)throw Error('unserved-edges');
  base.overloadPreserved=rows.every(row=>row.route.status().state==='active')&&base.overloadDispatchDelta===0;if(!base.overloadPreserved)throw Error('overload');
  phase='held';await Promise.race([targets[0]!.hold(true),cancellation]);const heldBefore=base.scopes.map(row=>row.currentApplied);
  for(let index=0;index<8;index++)await turn();
  base.heldOtherScopeProgress=base.scopes.slice(1).every((row,index)=>row.currentApplied>heldBefore[index+1]!);
  if(!base.heldOtherScopeProgress||base.scopes[0]!.heldDispatches<1)throw Error('starvation');
  phase='recovery';const recoveryBefore=base.scopes.map(row=>row.currentApplied);await Promise.race([targets[0]!.hold(false),cancellation]);
  for(let index=0;index<20;index++)await turn();for(const row of base.scopes)row.recoveryApplied=row.currentApplied-recoveryBefore[row.scopeIndex]!;
  if(base.scopes.some(row=>row.recoveryApplied<1))throw Error('recovery');
  phase='revocation';await Promise.race([targets[0]!.hold(true),cancellation]);await turn();await turn();
  const revokedEdge=targets[0]!.heldEdges[0];if(revokedEdge===undefined)throw Error('held-revoke');const retired=rows[revokedEdge]!;
  const beforeRevokeApplied=base.scopes[0]!.perEdge[revokedEdge]!,beforeCancelled=base.scopes[0]!.cancelledBeforeEffect;
  base.scopes[0]!.retiredQueued+=retired.route.status().pending;runtime.revoke(retired.route);if(retired.route.status().state!=='closed')throw Error('revoke');
  await wait(20);await Promise.race([targets[0]!.hold(false),cancellation]);await wait(20);runtime.flush();
  if(base.scopes[0]!.perEdge[revokedEdge]!==beforeRevokeApplied||base.scopes[0]!.cancelledBeforeEffect<=beforeCancelled)throw Error('late-revoke');
  phase='expiry';
  for(const row of rows.filter(row=>row.scope===0)){base.scopes[0]!.retiredQueued+=row.route.status().pending;row.route.stop('expiry-fixture');}
  await wait(20);await Promise.race([targets[0]!.hold(true),cancellation]);
  const deadline=performance.now()+120;
  const expiring=runtime.route({from:retired.source,to:retired.sink,principalId:'load-owner-0',applicationId:'load-app-0',sessionId:'load-session-0',sourceOperation:'subscribe',queueCapacity:1,
   constraints:{expiresAt:deadline,maxAgeMs:250,maxHz:50}});routes.push(expiring);
  if(!expiring.start().ok)throw Error('expiry-prepare');
  const beforeExpiryApplied=base.scopes[0]!.perEdge[revokedEdge]!,cancelledAtExpiry=base.scopes[0]!.cancelledBeforeEffect;
  sequence++;const expiryPublished=runtime.publish(retired.source,{sequence,state:sequence});if(!expiryPublished.ok||expiryPublished.value.accepted!==1)throw Error('expiry-publish');
  base.scopes[0]!.accepted++;runtime.flush();await wait(20);if(!targets[0]!.heldEdges.includes(revokedEdge))throw Error('held-expiry');
  await wait(140);runtime.flush();if(expiring.status().state!=='closed'||expiring.status().reason!=='expired')throw Error('expiry');
  await wait(20);await Promise.race([targets[0]!.hold(false),cancellation]);await wait(20);
  if(base.scopes[0]!.perEdge[revokedEdge]!==beforeExpiryApplied||base.scopes[0]!.cancelledBeforeEffect<=cancelledAtExpiry)throw Error('late-expiry');
  base.status='pass';base.reason='qualified-selected-local-tier';
 }catch {base.status=signal&&aborted(signal)?'cancelled':'failed';base.reason=base.status==='cancelled'?'cancelled':'qualification-'+phase;}
 finally {
  owned.abort();noteQueued();runtime?.close();for(const route of routes)route.stop('qualification-ended');if(timer)clearTimeout(timer);timer=undefined;if(lifetime)clearTimeout(lifetime);lifetime=undefined;
  await Promise.all(targets.map(target=>target.close()));
  base.ownedCleanup.workersExited=targets.filter(target=>target.hasExited).length;base.ownedCleanup.pendingRaw=targets.reduce((sum,target)=>sum+target.pendingRaw,0);
  base.ownedCleanup.timers=targets.reduce((sum,target)=>sum+target.ownedTimers,0);base.ownedCleanup.listeners=targets.reduce((sum,target)=>sum+target.ownedListeners,0);
  base.ownedCleanup.contexts=base.ownedCleanup.pendingRaw+routes.filter(route=>route.status().state!=='closed').length;
  detach();if(signal&&aborted(signal)){base.status='cancelled';base.reason='cancelled';}
  if(base.ownedCleanup.contexts||base.ownedCleanup.listeners||base.ownedCleanup.timers||base.ownedCleanup.workersExited!==base.ownedCleanup.workersStarted){base.status='failed';base.reason='cleanup';}
  base.acceptedNotDispatched=base.scopes.reduce((sum,row)=>sum+row.accepted-row.dispatched,0);
  for(const row of base.scopes)if(row.ackTiming.minimumMs===Infinity)row.ackTiming.minimumMs=0;
  for(const row of base.scopes){Object.freeze(row.perEdge);Object.freeze(row.ackTiming);Object.freeze(row.workerEmission);Object.freeze(row);}
  Object.freeze(base.scopes);Object.freeze(base.ownedCleanup);Object.freeze(base);running=false;
 }
 const serialized=JSON.stringify(base);if(serialized.length>32768)throw Error('receipt-capacity');return Object.freeze(base);
}
