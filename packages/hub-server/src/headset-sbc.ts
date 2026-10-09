import {types} from 'node:util';
import {isAbsolute,normalize} from 'node:path';

export const HEADSET_SBC_PROFILE = 'headset-sbc-codec-resource/1';
export interface HeadsetSbcScope {readonly principalId:string;readonly applicationId:string;readonly sessionId:string;}
export interface HeadsetSbcRequest {
 readonly scope:Readonly<HeadsetSbcScope>;readonly purpose:string;readonly profile:typeof HEADSET_SBC_PROFILE;
 readonly action:'encode-selected-sbc'|'decode-verified-sbc';readonly principalId:string;readonly applicationId:string;readonly sessionId:string;
 readonly generation:number;readonly codec:Readonly<{sampleRateHz:44100;channels:1;blocks:16;subbands:8;allocation:'loudness';bitpool:31;frames:16}>;
 readonly executablePath:string;readonly executableSha256:string;readonly encodedBytesMax:16384;readonly decodedBytesMax:65536;readonly frameCountMax:16;readonly deadlineMonoMs:number;
}
export interface HeadsetSbcGrant {readonly request:HeadsetSbcRequest;readonly signal:AbortSignal;readonly expiresMonoMs:number;}
export interface CodecIssue {readonly output:Promise<Uint8Array>;readonly settled:Promise<void>;terminate(reason:string):void;}
export interface HeadsetSbcPort {issue(request:HeadsetSbcRequest,input:Uint8Array|undefined):CodecIssue;}
export interface HeadsetSbcOptions {readonly scope:HeadsetSbcScope;readonly executablePath:string;readonly executableSha256:string;readonly ownerSignal:AbortSignal;readonly now:()=>number;readonly port:HeadsetSbcPort;readonly authorize:(request:HeadsetSbcRequest)=>HeadsetSbcGrant|undefined|Promise<HeadsetSbcGrant|undefined>;}
export interface HeadsetSbcSession {
 produce(input:Readonly<{purpose:string;signal:AbortSignal;deadlineMonoMs:number}>):Promise<Readonly<{generation:number;encoded:Uint8Array}>>;
 decodeVerified(input:Readonly<{generation:number;encoded:Uint8Array}>):Promise<Readonly<{samples:2048;pcm:Uint8Array}>>;
 close(reason?:string):Promise<void>;
 status():Readonly<{phase:'idle'|'authorizing'|'encoding'|'encoded'|'decoding'|'retiring'|'closed';generation:number;pendingAuthorizers:number;pendingIssues:number;pendingRaw:number;uncertainProcesses:number;timers:number;listeners:number}>;
}
const fail=(reason:string)=>new Error(reason);
function data(value:unknown,keys:readonly string[],exact=true):Record<string,unknown>{
 if(!value||typeof value!=='object'||types.isProxy(value))throw fail('sbc-data');
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw fail('sbc-data');
 const descriptors=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(descriptors);
 if(own.some(k=>typeof k!=='string')||exact&&(own.length!==keys.length||own.some(k=>!keys.includes(k as string))))throw fail('sbc-data');
 for(const key of own)if(!('value'in descriptors[key as string]))throw fail('sbc-data');
 const result=Object.create(null)as Record<string,unknown>;
 for(const key of keys){if(!descriptors[key]||!('value'in descriptors[key]))throw fail('sbc-data');result[key]=descriptors[key].value;}
 return result;
}
function callable(value:unknown):value is (...args:unknown[])=>unknown{return typeof value==='function'&&!types.isProxy(value);}
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
function signal(value:unknown):AbortSignal {if(!value||typeof value!=='object'||types.isProxy(value))throw fail('sbc-signal');try{aborted.call(value);}catch{throw fail('sbc-signal');}return value as AbortSignal;}
function printable(value:unknown):value is string {return typeof value==='string'&&[...value].length>=1&&[...value].length<=128&&/^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]+$/u.test(value);}
const typed=Object.getPrototypeOf(Uint8Array.prototype);
const byteBuffer=Object.getOwnPropertyDescriptor(typed,'buffer')!.get!,byteOffset=Object.getOwnPropertyDescriptor(typed,'byteOffset')!.get!,byteLength=Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!;
const bufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')!.get!;
const setBytes=Uint8Array.prototype.set;
function copyBytes(value:unknown,limit:number):Uint8Array{
 if(types.isProxy(value)||!types.isUint8Array(value))throw fail('sbc-bytes');
 try{const buffer=byteBuffer.call(value);bufferLength.call(buffer);const length=byteLength.call(value),offset=byteOffset.call(value);if(length>limit)throw fail('sbc-byte-budget');const view=new Uint8Array(buffer,offset,length),copy=new Uint8Array(length);setBytes.call(copy,view);return copy;}catch(e){if(e instanceof Error&&e.message==='sbc-byte-budget')throw e;throw fail('sbc-bytes');}
}
export function inspectSelectedSbc(bytes:Uint8Array):Readonly<{frames:16;encodedBytes:1120;samples:2048}>{
 const copy=copyBytes(bytes,16384);
 try{if(copy.length!==1120)throw fail('sbc-count');for(let offset=0;offset<1120;offset+=70){if(copy[offset]!==0x9c||copy[offset+1]!==0xb1||copy[offset+2]!==31)throw fail('sbc-format');let crc=15;for(const at of [1,2,4,5,6,7])for(let bit=7;bit>=0;bit--){const high=((crc>>>7)^((copy[offset+at]>>>bit)&1))&1;crc=((crc<<1)&255)^(high?29:0);}if(copy[offset+3]!==crc)throw fail('sbc-crc');}return Object.freeze({frames:16,encodedBytes:1120,samples:2048});}finally{copy.fill(0);}
}
export function admitHeadsetNativeProfile(_host:string):Readonly<{ok:false;reason:'unqualified-native-profile'}>{void _host;return Object.freeze({ok:false,reason:'unqualified-native-profile'});}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const then=Promise.prototype.then;
function promise(value:unknown):Promise<unknown>{if(types.isProxy(value)||!types.isPromise(value)||Object.getPrototypeOf(value)!==Promise.prototype||Object.hasOwn(value,'constructor'))throw fail('sbc-promise');return value as Promise<unknown>;}
function observe<T>(value:Promise<T>):Promise<T>{return new Promise<T>((resolve,reject)=>{then.call(value,resolve,reject);});}

export function createHeadsetSbcSession(options:HeadsetSbcOptions):HeadsetSbcSession{
 const config=data(options,['scope','executablePath','executableSha256','ownerSignal','now','port','authorize']);
 const scopeData=data(config.scope,['principalId','applicationId','sessionId']);
 if(!Object.values(scopeData).every(printable))throw fail('sbc-scope');
 const scope=Object.freeze({...scopeData})as unknown as HeadsetSbcScope;
 const executablePath=config.executablePath,executableSha256=config.executableSha256;
 // eslint-disable-next-line no-control-regex -- executable paths explicitly reject control characters.
 if(typeof executablePath!=='string'||!isAbsolute(executablePath)||normalize(executablePath)!==executablePath||/[\x00-\x1f\x7f]/.test(executablePath)||typeof executableSha256!=='string'||!/^[a-f0-9]{64}$/.test(executableSha256))throw fail('sbc-executable');
 const owner=signal(config.ownerSignal),rawNow=config.now,rawAuthorize=config.authorize,port=config.port,rawIssueMethod=data(port,['issue'],false).issue;
 if(!callable(rawNow)||!callable(rawAuthorize)||!callable(rawIssueMethod))throw fail('sbc-callout');
 const now=rawNow,authorize=rawAuthorize,issueMethod=rawIssueMethod;
 let phase:ReturnType<HeadsetSbcSession['status']>['phase']='idle',generation=0,retired=false,reason='',lastNow:number|undefined,deadline=Infinity,purpose='',caller:AbortSignal|undefined,original:Uint8Array|undefined,decodeUsed=false;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const listeners=new Map<AbortSignal,()=>void>(),grantSignals=new Set<AbortSignal>(),owned=new Set<Uint8Array>();
 const raw=new Set<object>(),authorizers=new Set<object>(),jobs=new Set<object>(),logical=new Set<{reject:(e:Error)=>void}>();
 const issues=new Set<{remaining:number;terminate?:()=>void;terminationRequested:boolean}>();
 const closing=deferred<void>();
 function finishClose(){if(retired&&!raw.size&&!jobs.size&&!issues.size){phase='closed';closing.resolve();}}
 function leg(){const token={};raw.add(token);let released=false,uncertain=false;return {token,markUncertain(){uncertain=true;},isUncertain(){return uncertain;},release(){if(released||uncertain)return;released=true;raw.delete(token);finishClose();}};}
 function terminate(record:{terminate?:()=>void;terminationRequested:boolean}){if(record.terminate&&!record.terminationRequested){record.terminationRequested=true;try{record.terminate();}catch{/* A thrown termination does not return owned raw work. */}}}
 function retire(why:string){
  const first=!retired;
  if(first){retired=true;reason=why;phase='retiring';if(timer!==undefined){clearTimeout(timer);timer=undefined;}}
  // Remove actual native registrations on every retirement, including late records.
  for(const [s,handler]of listeners)remove.call(s,'abort',handler);listeners.clear();
  if(first){for(const b of owned)b.fill(0);owned.clear();original=undefined;for(const p of logical)p.reject(fail(reason));logical.clear();}
  for(const record of issues)terminate(record);finishClose();
 }
 function live(){if(retired)throw fail(reason);if(aborted.call(owner)||caller&&aborted.call(caller)||[...grantSignals].some(s=>aborted.call(s))){retire('sbc-aborted');throw fail(reason);}}
 function clock(){
  live();const reservation=leg();let returnedPromise=false;
  try{
   const value=now() as number;
   if(types.isPromise(value)){
    returnedPromise=true;
    try{observe(promise(value)).then(()=>reservation.release(),()=>reservation.release());}catch{/* An unobservable actual return remains owned. */}
    retire('sbc-clock');throw fail(reason);
   }
   live();if(!Number.isFinite(value)||value<0||lastNow!==undefined&&value<lastNow){retire('sbc-clock');throw fail(reason);}lastNow=value;if(value>=deadline){retire('sbc-deadline');throw fail(reason);}return value;
  }finally{if(!returnedPromise)reservation.release();}
 }
 function listen(s:AbortSignal){live();if(listeners.has(s))return;const handler=()=>retire('sbc-aborted');listeners.set(s,handler);add.call(s,'abort',handler);live();}
 function arm(value:number){if(timer!==undefined)clearTimeout(timer);timer=setTimeout(()=>retire('sbc-deadline'),deadline-value);}
 function request(action:HeadsetSbcRequest['action']):HeadsetSbcRequest{return Object.freeze({scope,purpose,profile:HEADSET_SBC_PROFILE,action,...scope,generation,codec:Object.freeze({sampleRateHz:44100,channels:1,blocks:16,subbands:8,allocation:'loudness',bitpool:31,frames:16}),executablePath:executablePath as string,executableSha256:executableSha256 as string,encodedBytesMax:16384,decodedBytesMax:65536,frameCountMax:16,deadlineMonoMs:deadline});}
 async function approval(req:HeadsetSbcRequest,reservation:ReturnType<typeof leg>){
  let value:unknown;try{clock();value=authorize(req);if(types.isProxy(value))throw fail('sbc-grant');if(types.isPromise(value)){let actual:Promise<unknown>;try{actual=promise(value);}catch(e){reservation.markUncertain();throw e;}value=await observe(actual);}else if(value&&typeof value==='object'&&Object.getOwnPropertyDescriptor(value,'then'))throw fail('sbc-grant');}finally{if(!reservation.isUncertain()){authorizers.delete(reservation.token);reservation.release();}}
  const time=clock(),grant=data(value,['request','signal','expiresMonoMs']);
  if(grant.request!==req)throw fail('sbc-grant-request');const granted=signal(grant.signal),expires=grant.expiresMonoMs;
  if(granted===owner||granted===caller||grantSignals.has(granted)||aborted.call(granted)||typeof expires!=='number'||!Number.isFinite(expires)||expires<=time||expires>req.deadlineMonoMs)throw fail('sbc-grant');
  grantSignals.add(granted);listen(granted);deadline=expires;arm(time);clock();
 }
 async function codec(req:HeadsetSbcRequest,input:Uint8Array|undefined){
  const outputLeg=leg(),settledLeg=leg(),record={remaining:2,terminate:undefined as (()=>void)|undefined,terminationRequested:false};issues.add(record);
  let issued=false;
  try{clock();issued=true;const originalIssue=Reflect.apply(issueMethod,port,[req,input]);const fields=data(originalIssue,['output','settled','terminate']);if(!callable(fields.terminate))throw fail('sbc-issue');const output=promise(fields.output),settled=promise(fields.settled);const terminateMethod=fields.terminate;record.terminate=()=>Reflect.apply(terminateMethod,originalIssue,[reason]);
   const release=(entry:ReturnType<typeof leg>)=>{entry.release();record.remaining--;if(!record.remaining){issues.delete(record);finishClose();}};
   const outputReturn=observe(output).then(v=>{release(outputLeg);clock();const copy=copyBytes(v,req.action==='encode-selected-sbc'?16384:65536);owned.add(copy);if(req.action==='encode-selected-sbc')inspectSelectedSbc(copy);else{if(copy.length!==4096)throw fail('sbc-pcm-count');if(!copy.some(byte=>byte!==0))throw fail('sbc-pcm-effect');}clock();return copy;},e=>{release(outputLeg);throw e;});
   const rawReturn=observe(settled).then(()=>{release(settledLeg);},e=>{retire('sbc-raw-uncertain');throw e;});
   const joined=Promise.all([outputReturn,rawReturn]);joined.catch(()=>{});if(retired)terminate(record);clock();const [bytes]=await joined;clock();return bytes;
  }catch(e){if(!issued){outputLeg.release();settledLeg.release();issues.delete(record);}retire(e instanceof Error?e.message:'sbc-codec');throw e;}
 }
 function start<T>(work:(reservation:ReturnType<typeof leg>)=>Promise<T>):Promise<T>{
  const reservation=leg(),job={},result=deferred<T>();authorizers.add(reservation.token);jobs.add(job);logical.add(result);phase='authorizing';
  void Promise.resolve().then(async()=>{try{live();const value=await work(reservation);clock();for(const b of Object.values(value as object))if(types.isUint8Array(b))owned.delete(b);logical.delete(result);result.resolve(value);}catch(e){retire(e instanceof Error?e.message:'sbc-failed');result.reject(fail(reason));}finally{if(!reservation.isUncertain()){authorizers.delete(reservation.token);reservation.release();}jobs.delete(job);finishClose();}});
  return result.promise;
 }
 return Object.freeze({
  produce(input:Readonly<{purpose:string;signal:AbortSignal;deadlineMonoMs:number}>){if(phase!=='idle'||retired)return Promise.reject(fail('sbc-busy'));generation++;return start(async reservation=>{
   const fields=data(input,['purpose','signal','deadlineMonoMs']);if(!printable(fields.purpose))throw fail('sbc-purpose');purpose=fields.purpose;caller=signal(fields.signal);if(caller===owner)throw fail('sbc-signal');listen(owner);listen(caller);const time=clock();if(typeof fields.deadlineMonoMs!=='number'||!Number.isFinite(fields.deadlineMonoMs)||fields.deadlineMonoMs<=time||fields.deadlineMonoMs-time>5000)throw fail('sbc-deadline');deadline=fields.deadlineMonoMs;arm(time);
   const req=request('encode-selected-sbc');await approval(req,reservation);clock();phase='encoding';const output=await codec(req,undefined);clock();original=output;const encoded=copyBytes(original,16384);owned.add(encoded);clock();phase='encoded';return Object.freeze({generation,encoded});
  });},
  decodeVerified(input:Readonly<{generation:number;encoded:Uint8Array}>){if(phase!=='encoded'||decodeUsed||retired)return Promise.reject(fail('sbc-decode-unavailable'));decodeUsed=true;return start(async reservation=>{
   const fields=data(input,['generation','encoded']);clock();if(fields.generation!==generation||!original)throw fail('sbc-generation');const bytes=copyBytes(fields.encoded,16384);owned.add(bytes);inspectSelectedSbc(bytes);if(bytes.length!==original.length||bytes.some((v,i)=>v!==original![i]))throw fail('sbc-generation-bytes');
   const req=request('decode-verified-sbc');await approval(req,reservation);clock();phase='decoding';const output=await codec(req,bytes);clock();const decoded=output;const pcm=copyBytes(decoded,65536);owned.add(pcm);clock();bytes.fill(0);owned.delete(bytes);decoded.fill(0);owned.delete(decoded);return Object.freeze({samples:2048 as const,pcm});
  });},
  close(why='sbc-closed'){retire(typeof why==='string'?why:'sbc-closed');return closing.promise;},
  status(){return Object.freeze({phase,generation,pendingAuthorizers:authorizers.size,pendingIssues:issues.size,pendingRaw:raw.size,uncertainProcesses:issues.size,timers:timer===undefined?0:1,listeners:listeners.size});},
 });
}
