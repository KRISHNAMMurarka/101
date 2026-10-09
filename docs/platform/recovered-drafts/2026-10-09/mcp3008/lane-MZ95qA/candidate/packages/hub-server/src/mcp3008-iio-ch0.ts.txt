import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { types } from 'node:util';
import type { JsonObject } from '@101/device-model';

export const MCP3008_IIO_LIMITS = Object.freeze({ sessionMs:30000, readMs:1000, receiptAgeMs:1000, pollMs:1000,
  attempts:8, readings:30, valueBytes:64, pathBytes:4096, metadataBytes:4096, openDataHandles:1 } as const);
export const MCP3008_IIO_CODE_SCHEMA = Object.freeze({type:'scalar',unit:'1',min:0,max:1023} as const);
export interface Mcp3008FileIdentity { readonly dev:string; readonly ino:string }
export interface Mcp3008NominalReference { readonly configurationId:string; readonly measured:false;
 readonly millivolts:Readonly<{numerator:number;denominator:number}>|null }
export interface Mcp3008IioProfile {
 readonly profileId:'mcp3008-iio-ch0-abi-file/1'|'linux-mcp3008-iio-ch0-raw-read/1'; readonly revision:1;
 readonly parentRealPath:string; readonly iioRealPath:string; readonly rawRealPath:string;
 readonly spiController:string; readonly chipSelect:number; readonly channel:0; readonly mode:'single-ended'; readonly maxHz:1;
 readonly reference:Readonly<Mcp3008NominalReference>|null;
 readonly driverBuildSha256:string; readonly environmentReceiptSha256:string; readonly ancestorPolicy:'host-controlled-stable';
 readonly enrolledIdentities:Readonly<{parent:Mcp3008FileIdentity;iio:Mcp3008FileIdentity;raw:Mcp3008FileIdentity}>;
}
export interface DecodedMcp3008Code { readonly code:number; readonly rawSha256:string; readonly rawBytes:number }
export interface Mcp3008CodeReading { readonly decoded:Readonly<DecodedMcp3008Code>; readonly localSequence:number;
 readonly readReceivedAt:number; readonly receiptClockId:'mcp3008-gateway-monotonic'; readonly provenance:Readonly<JsonObject> }
export interface Mcp3008IioApprovalRequest { readonly action:'read-selected-code'; readonly profile:Readonly<Mcp3008IioProfile>;
  readonly scope:Readonly<{principalId:string;applicationId:string;sessionId:string}>; readonly purpose:string; readonly deadline:number;
  readonly generation:number; readonly fixedPaths:Readonly<{raw:string}>; readonly budgets:typeof MCP3008_IIO_LIMITS }
export interface Mcp3008IioApproval { readonly request:Mcp3008IioApprovalRequest; readonly signal:AbortSignal; readonly expiresAt:number }
export interface Mcp3008IioOptions { readonly profile:Mcp3008IioProfile; readonly scope:Readonly<{principalId:string;applicationId:string;sessionId:string}>;
  readonly ownerSignal:AbortSignal; readonly authorize:(request:Mcp3008IioApprovalRequest)=>Mcp3008IioApproval|undefined;
  readonly onCode:(reading:Mcp3008CodeReading)=>void; readonly onUnavailable:(reason:string)=>void }
export interface Mcp3008IioConnector {
  start(input:Readonly<{purpose:string;signal:AbortSignal;deadline:number}>):Promise<Readonly<{ok:true}|{ok:false;reason:string}>>;
  stop():Promise<void>;close():Promise<void>;
  status():Readonly<{phase:'idle'|'opening'|'ready'|'retiring'|'closed';reason:string;generation:number;readings:number;attempts:number;
    pendingOperations:number;openHandles:number;inFlightReads:number;unconfirmedCloses:number;timers:number;nativeErrno:string|null}>;
}
const now=()=>performance.now();
const signalGetter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
const byteLengthGetter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!;
function bad():never {throw new TypeError('Invalid selected MCP3008 input');}
function object(input:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!input||typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))bad();
  const names=Reflect.ownKeys(input);if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))bad();
  const out:Record<string,unknown>=Object.create(null);for(const key of keys){const d=Object.getOwnPropertyDescriptor(input,key);
    if(!d?.enumerable||!('value' in d))bad();out[key]=d.value;}return out;
}
function text(input:unknown,max=128):string {
  if(typeof input!=='string'||!input.length||Buffer.byteLength(input)>max||Array.from(input).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))bad();return input;
}
function hash(input:unknown):string{const s=text(input,64);if(!/^[a-f0-9]{64}$/.test(s))bad();return s;}
function identity(input:unknown):Readonly<Mcp3008FileIdentity>{const o=object(input,['dev','ino']);const parse=(v:unknown)=>{
 const s=text(v,128);if(!/^(0|[1-9][0-9]*)$/.test(s))bad();return s;};return Object.freeze({dev:parse(o.dev),ino:parse(o.ino)});}
function path(input:unknown):string{const s=text(input,4096);if(!s.startsWith('/')||posix.normalize(s)!==s||s==='/'||s.split('/').some(x=>x==='.'||x==='..')||s.endsWith('/'))bad();return s;}
function signal(input:unknown):AbortSignal{if(!input||typeof input!=='object'||types.isProxy(input)||Object.getPrototypeOf(input)!==AbortSignal.prototype)bad();
  try{Reflect.apply(signalGetter,input,[]);}catch{bad();}return input as AbortSignal;}
function aborted(s:AbortSignal):boolean{return Reflect.apply(signalGetter,s,[]) as boolean;}
function finite(input:unknown):number{if(typeof input!=='number'||!Number.isFinite(input)||input<0||input>Number.MAX_SAFE_INTEGER)bad();return input;}
function unsigned(input:unknown):number {const n=finite(input);if(!Number.isSafeInteger(n))bad();return n;}
function reference(input:unknown):Readonly<Mcp3008NominalReference>|null {
 if(input===null)return null;const o=object(input,['configurationId','millivolts','measured']);if(o.measured!==false)bad();
 let millivolts:Readonly<{numerator:number;denominator:number}>|null=null;
 if(o.millivolts!==null){const m=object(o.millivolts,['numerator','denominator']),numerator=unsigned(m.numerator),denominator=unsigned(m.denominator);
  if(numerator===0||denominator===0)bad();millivolts=Object.freeze({numerator,denominator});}
 return Object.freeze({configurationId:text(o.configurationId),millivolts,measured:false});
}
export function parseMcp3008IioProfile(input:unknown):Readonly<Mcp3008IioProfile>{
 const o=object(input,['profileId','revision','parentRealPath','iioRealPath','rawRealPath','spiController','chipSelect','channel','mode','maxHz','reference','driverBuildSha256','environmentReceiptSha256','ancestorPolicy','enrolledIdentities']);
 if(!['mcp3008-iio-ch0-abi-file/1','linux-mcp3008-iio-ch0-raw-read/1'].includes(o.profileId as string)||o.revision!==1||o.ancestorPolicy!=='host-controlled-stable'||o.channel!==0||o.mode!=='single-ended'||o.maxHz!==1)bad();
 const parentRealPath=path(o.parentRealPath),iioRealPath=path(o.iioRealPath),rawRealPath=path(o.rawRealPath);
 if(posix.dirname(iioRealPath)!==parentRealPath||!/^iio:device(?:0|[1-9][0-9]*)$/.test(posix.basename(iioRealPath))||rawRealPath!==iioRealPath+'/in_voltage0_raw')bad();
 const e=object(o.enrolledIdentities,['parent','iio','raw']);
 return Object.freeze({profileId:o.profileId as Mcp3008IioProfile['profileId'],revision:1,parentRealPath,iioRealPath,rawRealPath,
 spiController:text(o.spiController),chipSelect:unsigned(o.chipSelect),channel:0,mode:'single-ended',maxHz:1,reference:reference(o.reference),
 driverBuildSha256:hash(o.driverBuildSha256),environmentReceiptSha256:hash(o.environmentReceiptSha256),ancestorPolicy:'host-controlled-stable',
 enrolledIdentities:Object.freeze({parent:identity(e.parent),iio:identity(e.iio),raw:identity(e.raw)})});
}
export function decodeMcp3008Code(input:Uint8Array):Readonly<DecodedMcp3008Code>{
 if(!input||typeof input!=='object'||types.isProxy(input)||!types.isUint8Array(input))bad();
 const length=Reflect.apply(byteLengthGetter,input,[]) as number;if(length<1||length>64)bad();
 const bytes=Buffer.alloc(length);Uint8Array.prototype.set.call(bytes,input);for(const b of bytes)if(b>127)bad();
 const raw=bytes.toString('ascii');if(!/^(?:0|[1-9][0-9]*)\n$/.test(raw))bad();
 const code=Number(raw.slice(0,-1));if(!Number.isSafeInteger(code)||code<0||code>1023)bad();
 return Object.freeze({code,rawSha256:createHash('sha256').update(bytes).digest('hex'),rawBytes:length});
}
interface OwnedHandle { readonly handle:FileHandle;closed:boolean;unconfirmed:boolean }
interface Session { readonly generation:number;readonly caller:AbortSignal;readonly originalDeadline:number;deadline:number;grant?:Mcp3008IioApproval;
 retired:boolean;readings:number;inFlightReads:number;operations:Set<Promise<unknown>>;handles:Set<OwnedHandle>;timers:Set<ReturnType<typeof setTimeout>>;
 listeners:Array<readonly[AbortSignal,()=>void]>;retirement?:Promise<void>;failure:Promise<void>;fail:()=>void;readDeadline?:number }
const failed=(reason:string)=>Object.freeze({ok:false as const,reason});
function nativeReason(error:unknown):{reason:string;errno:string|null}{
 let code:unknown;if(error&&typeof error==='object'&&!types.isProxy(error)){const d=Object.getOwnPropertyDescriptor(error,'code');if(d&&'value'in d)code=d.value;}
 const errno=typeof code==='string'&&/^[A-Z0-9_]{1,32}$/.test(code)?code:null;
 return {reason:errno==='EAGAIN'?'not-ready':errno==='ENOENT'?'missing':errno==='EACCES'||errno==='EPERM'?'denied':'read-failed',errno};
}
/** Selected owned ordinary files only. The host-controlled stable ancestor prerequisite is essential; this is not openat confinement. */
export function createMcp3008IioConnector(input:Mcp3008IioOptions):Mcp3008IioConnector {
 const o=object(input,['profile','scope','ownerSignal','authorize','onCode','onUnavailable']),profile=parseMcp3008IioProfile(o.profile);
 const scopeInput=object(o.scope,['principalId','applicationId','sessionId']),scope=Object.freeze({principalId:text(scopeInput.principalId),applicationId:text(scopeInput.applicationId),sessionId:text(scopeInput.sessionId)});
 const owner=signal(o.ownerSignal);if(typeof o.authorize!=='function'||typeof o.onCode!=='function'||typeof o.onUnavailable!=='function')bad();
 const authorize=o.authorize as Mcp3008IioOptions['authorize'],onCode=o.onCode as Mcp3008IioOptions['onCode'],onUnavailable=o.onUnavailable as Mcp3008IioOptions['onUnavailable'];
 const fixed=Object.freeze({raw:profile.rawRealPath});
 let session:Session|undefined,phase:'idle'|'opening'|'ready'|'retiring'|'closed'='idle',reason='idle',generation=0,attempts=0,sequence=0,terminal=false,nativeErrno:string|null=null,lastIssuedRead=-Infinity;
 function current(s:Session):boolean{return session===s&&!s.retired&&!terminal&&!aborted(owner)&&!aborted(s.caller)&&(!s.grant||!aborted(s.grant.signal))&&now()<s.deadline;}
 function fence(s:Session):void{if(!current(s))throw Error('retired-or-expired');}
 function own<T>(s:Session,issue:()=>Promise<T>,cleanup=false):Promise<T>{
  if(!cleanup)fence(s);
  // Reserve before issuing the native intention: synchronous call reentry may retire.
  let release!:()=>void;const reservation=new Promise<void>(done=>{release=done;});s.operations.add(reservation);
  let raw:Promise<T>;try{raw=issue();}catch(error){raw=Promise.reject(error);}
  raw.catch(()=>{});const settled=()=>{s.operations.delete(reservation);release();};void raw.then(settled,settled);return raw;
 }
 async function checked<T>(s:Session,issue:()=>Promise<T>):Promise<T>{const result=await own(s,issue);fence(s);return result;}
 function timer(s:Session,fn:()=>void,ms:number){const t=setTimeout(()=>{s.timers.delete(t);fn();},Math.max(0,ms));s.timers.add(t);return t;}
 function clear(s:Session,t:ReturnType<typeof setTimeout>){clearTimeout(t);s.timers.delete(t);}
 function retire(s:Session,why:string):Promise<void>{
  if(s.retirement)return s.retirement;
  s.retired=true;phase='retiring';reason=why;s.fail();for(const t of s.timers)clearTimeout(t);s.timers.clear();
  for(const [sig,listener]of s.listeners)Reflect.apply(remove,sig,['abort',listener]);s.listeners=[];
  let resolve!:()=>void,reject!:(error:unknown)=>void;s.retirement=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});s.retirement.catch(()=>{});
  // State and the retirement promise exist before any external callout can reenter.
  try{onUnavailable(why);}catch{/* Readiness is already withdrawn; callback cannot revive the session. */}
  void(async()=>{try{
   while(s.operations.size)await Promise.allSettled([...s.operations]);
   const closes:Promise<unknown>[]=[];for(const h of s.handles)if(!h.closed&&!h.unconfirmed)closes.push(closeHandle(s,h));
   const results=await Promise.allSettled(closes);if(results.some(r=>r.status==='rejected')||[...s.handles].some(h=>!h.closed))throw Error('Unconfirmed MCP3008 file close');
   if(session===s){session=undefined;phase=terminal?'closed':'idle';}resolve();
  }catch(error){reject(error);}})();return s.retirement;
 }
 async function closeHandle(s:Session,h:OwnedHandle):Promise<void>{
  if(h.closed)return;try{await own(s,()=>h.handle.close(),true);h.closed=true;s.handles.delete(h);}catch(error){h.unconfirmed=true;throw error;}
 }
 function same(stat:BigIntStats,id:Mcp3008FileIdentity):boolean{return String(stat.dev)===id.dev&&String(stat.ino)===id.ino;}
 async function identities(s:Session):Promise<BigIntStats>{
  for(const [path,id,kind]of [[profile.parentRealPath,profile.enrolledIdentities.parent,'directory'],[profile.iioRealPath,profile.enrolledIdentities.iio,'directory'],
   [fixed.raw,profile.enrolledIdentities.raw,'file']]as const){
   const stat=await checked(s,()=>fs.lstat(path,{bigint:true}));if(!same(stat,id)||stat.isSymbolicLink()||(kind==='directory'?!stat.isDirectory():!stat.isFile()))throw Error('enrollment-changed');
   const real=await checked(s,()=>fs.realpath(path));if(real!==path||Buffer.byteLength(real)>4096)throw Error('enrollment-changed');
  }
  return checked(s,()=>fs.lstat(fixed.raw,{bigint:true}));
 }
 async function open(s:Session):Promise<OwnedHandle>{
  const raw=own(s,()=>fs.open(fixed.raw,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK));
  const h=await raw;const owned:OwnedHandle={handle:h,closed:false,unconfirmed:false};s.handles.add(owned);
  fence(s);await handleStat(s,owned);return owned;
 }
 async function handleStat(s:Session,h:OwnedHandle):Promise<BigIntStats>{
  const stat=await checked(s,()=>h.handle.stat({bigint:true}));if(!stat.isFile()||!same(stat,profile.enrolledIdentities.raw))throw Error('opened-identity-changed');return stat;
 }
 async function read(s:Session,h:OwnedHandle):Promise<{bytes:Buffer;receivedAt:number}>{
  while(now()<lastIssuedRead+1000){let wake!:()=>void;const wait=new Promise<void>(done=>{wake=done;});timer(s,wake,lastIssuedRead+1000-now());await Promise.race([wait,s.failure]);fence(s);}
  const readStart=now(),bound=Math.min(s.deadline,readStart+1000);s.readDeadline=bound;
  const timeout=timer(s,()=>{void retire(s,'expired');},bound-now());
  try{await identities(s);const before=await handleStat(s,h);if(before.size<1n||before.size>64n)throw Error('invalid-size');
   fence(s);if(now()>=bound)throw Error('expired');const buffer=Buffer.alloc(65);s.inFlightReads++;
   let result:Awaited<ReturnType<FileHandle['read']>>,receivedAt:number;
   try{lastIssuedRead=now();result=await own(s,()=>h.handle.read(buffer,0,65,0));receivedAt=now();}finally{s.inFlightReads--;}
   fence(s);if(receivedAt>=bound)throw Error('expired');
   const after=await handleStat(s,h);await identities(s);fence(s);
   if(now()>=bound||result.bytesRead!==Number(before.size)||after.size!==before.size)throw Error('incomplete-file');
   return {bytes:buffer.subarray(0,result.bytesRead),receivedAt};
  }finally{clear(s,timeout);s.readDeadline=undefined;}
 }
 async function observe(s:Session,h:OwnedHandle):Promise<boolean>{
  try{if(s.readings>=30)throw Error('read-budget');const r=await read(s,h),decoded=decodeMcp3008Code(r.bytes);fence(s);
   if(sequence>=Number.MAX_SAFE_INTEGER)throw Error('sequence-budget');sequence++;s.readings++;
   const provenance:Readonly<JsonObject>=Object.freeze({profileId:profile.profileId,revision:profile.revision,readReceivedAt:r.receivedAt,
    code:decoded.code,channel:0,mode:profile.mode,spiController:profile.spiController,chipSelect:profile.chipSelect,reference:profile.reference,rawSha256:decoded.rawSha256,rawBytes:decoded.rawBytes,
    calibrationRevision:null,absoluteErrorBound:null,sourceClock:null,sourceTimeMapped:false,conversionAgeMs:null,captureUnknown:true,physical:false});
   onCode(Object.freeze({decoded,localSequence:sequence,readReceivedAt:r.receivedAt,receiptClockId:'mcp3008-gateway-monotonic',provenance}));fence(s);
   if(s.readings>=30){void retire(s,'read-budget');return true;}
   timer(s,()=>{if(current(s))void observe(s,h);else void retire(s,'expired');},Math.max(0,lastIssuedRead+1000-now()));return true;
  }catch(error){const n=nativeReason(error);nativeErrno=n.errno;if(!s.retired)void retire(s,now()>=s.deadline?'expired':n.reason);return false;}
 }
 async function begin(s:Session,request:Mcp3008IioApprovalRequest):Promise<boolean>{
  try{fence(s);const value=authorize(request);fence(s);if(value===undefined){void retire(s,'denied');return false;}
   const v=object(value,['request','signal','expiresAt']);if(v.request!==request)bad();const grantSignal=signal(v.signal),expiresAt=finite(v.expiresAt);
   if(aborted(grantSignal)||expiresAt<=now())bad();s.grant=Object.freeze({request,signal:grantSignal,expiresAt});s.deadline=Math.min(s.originalDeadline,expiresAt);fence(s);
   listen(s,grantSignal);timer(s,()=>{void retire(s,'expired');},s.deadline-now());
   await identities(s);const data=await open(s);
   // The connector-wide read ceiling survives explicit stop/start and fresh approval.
   if(now()<lastIssuedRead+1000){let wake!:()=>void;const wait=new Promise<void>(done=>{wake=done;});timer(s,wake,lastIssuedRead+1000-now());await Promise.race([wait,s.failure]);fence(s);}
   phase='ready';reason='ready';return await observe(s,data);
  }catch(error){const n=nativeReason(error);nativeErrno=n.errno;if(!s.retired)void retire(s,now()>=s.deadline?'expired':n.reason);return false;}
 }
 function listen(s:Session,sig:AbortSignal){const fn=()=>{void retire(s,'revoked');};Reflect.apply(add,sig,['abort',fn,{once:true}]);s.listeners.push([sig,fn]);if(aborted(sig))fn();}
 return Object.freeze({
  async start(value:Readonly<{purpose:string;signal:AbortSignal;deadline:number}>){
   if(profile.profileId!=='mcp3008-iio-ch0-abi-file/1')return failed('native-admission-not-qualified');
   if(terminal)return failed('closed');if(session)return failed('busy');if(attempts>=8||generation>=Number.MAX_SAFE_INTEGER)return failed('attempt-budget');
   let v:Record<string,unknown>,caller:AbortSignal,purpose:string,deadline:number;
   try{v=object(value,['purpose','signal','deadline']);caller=signal(v.signal);purpose=text(v.purpose);deadline=finite(v.deadline);
    if(aborted(owner)||aborted(caller)||deadline<=now()||deadline-now()>30000)bad();}catch{return failed('invalid-start');}
   attempts++;generation++;let fail!:()=>void;const failure=new Promise<void>(resolve=>{fail=resolve;});
   const s:Session={generation,caller,originalDeadline:deadline,deadline,retired:false,readings:0,inFlightReads:0,operations:new Set(),handles:new Set(),timers:new Set(),listeners:[],failure,fail};
   session=s;phase='opening';reason='opening';nativeErrno=null;listen(s,owner);listen(s,caller);timer(s,()=>{void retire(s,'expired');},deadline-now());
   const request=Object.freeze({action:'read-selected-code' as const,profile,scope,purpose,deadline,generation,fixedPaths:fixed,budgets:MCP3008_IIO_LIMITS});
   const work=begin(s,request);work.catch(()=>{});const success=await Promise.race([work,failure.then(()=>false)]);
   return success&&current(s)?Object.freeze({ok:true as const}):failed(reason);
  },
  async stop(){if(session)await retire(session,'stopped');},
  async close(){terminal=true;if(session)await retire(session,'closed');else phase='closed';},
  status(){return Object.freeze({phase,reason,generation,readings:session?.readings??0,attempts,pendingOperations:session?.operations.size??0,
    openHandles:session?.handles.size??0,inFlightReads:session?.inFlightReads??0,unconfirmedCloses:session?[...session.handles].filter(h=>h.unconfirmed).length:0,timers:session?.timers.size??0,nativeErrno});}
 });
}
