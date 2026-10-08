import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeNominalNecInverseByteCapture, createNec32IrReceiveGateway, NEC32_IR_RECEIVE_LIMITS } from './nec32-ir-receive-gateway.ts';
import type { Nec32IrReceiveProvider } from './nec32-ir-receive-gateway.ts';

const P=(n:number)=>0x01000000|n, S=(n:number)=>n, T=(n=20_000)=>0x03000000|n;
function packets(address=0x34, command=0xa2) {
  const bytes=[address,address^255,command,command^255], out=[P(9000),S(4500)];
  for(const value of bytes) for(let bit=0;bit<8;bit++) out.push(P(560),S((value>>>bit)&1?1690:565));
  return [...out,P(560),T()];
}
test('decodes only a complete timeout-delimited nominal inverse-byte frame',()=>{
  const decoded=decodeNominalNecInverseByteCapture(packets());
  assert.equal(decoded.kind,'candidate'); if(decoded.kind!=='candidate') return;
  assert.deepEqual({address:decoded.address,command:decoded.command,timingCount:decoded.timingCount,totalMicros:decoded.totalMicros},
    {address:0x34,command:0xa2,timingCount:67,totalMicros:68060});
  assert.match(decoded.demodulatedSha256,/^[a-f0-9]{64}$/);
  assert.equal(decodeNominalNecInverseByteCapture(packets().slice(0,-1)).kind,'noise-or-incomplete');
  assert.equal(decodeNominalNecInverseByteCapture([P(9000),S(2250),P(560),T()]).kind,'repeat-ignored');
});
test('classifies unsupported and corrupt captures without candidates',()=>{
  const extended=packets(0x34,0xa2); const nec32=packets(0x34,0xa2); const mismatch=packets(0x34,0xa2);
  // flip the decoded complement byte timings to encode an exact alternate byte
  const setByte=(a:number[],offset:number,value:number)=>{for(let b=0;b<8;b++)a[2+(offset*8+b)*2+1]=S((value>>>b)&1?1690:565);};
  setByte(extended,1,0x12); assert.equal(decodeNominalNecInverseByteCapture(extended).kind,'extended-unsupported');
  setByte(mismatch,3,0x12); assert.equal(decodeNominalNecInverseByteCapture(mismatch).kind,'inverse-mismatch');
  setByte(nec32,1,0x12); setByte(nec32,3,0x12); assert.equal(decodeNominalNecInverseByteCapture(nec32).kind,'nec32-unsupported');
  assert.equal(decodeNominalNecInverseByteCapture([0x04ffffff,T()]).kind,'overflow');
  assert.equal(decodeNominalNecInverseByteCapture([0x02009470,T()]).kind,'unsupported-packet');
  assert.equal(decodeNominalNecInverseByteCapture([...packets(),T()]).kind,'noise-or-incomplete');
});

const scope={principalId:'owner',applicationId:'receive-test',sessionId:'s1'};
function setup(overrides:Partial<Nec32IrReceiveProvider>={}) {
  const owner=new AbortController(), control=new AbortController(), receive=new AbortController(); let opens=0,captures=0,stops=0,closes=0;
  const provider:Nec32IrReceiveProvider={supported:true,mode:'LIRC_MODE_MODE2',resolutionMicros:1,
    open(){opens++;return 'ready'},capture(){captures++;return packets()},stop(){stops++},close(){closes++},whenSettled(){return Promise.resolve()},...overrides};
  let allowControl=true,allowCapture=true,auths=0;
  const gateway=createNec32IrReceiveGateway({ownerSignal:owner.signal,scope,selectedReceiver:{id:'software-rx',profileId:'app:nec-inverse-byte-demodulated-nominal/1'},selectedProvider:provider,
    authorizeReceiver:request=>allowControl?{request,signal:control.signal,expiresAt:performance.now()+1000}:undefined,
    authorizeCapture:request=>{auths++;return allowCapture?{request,signal:receive.signal,expiresAt:performance.now()+1000}:undefined},onRetire(){}});
  return {gateway,provider,owner,setControl:(v:boolean)=>allowControl=v,setCapture:(v:boolean)=>allowCapture=v,counts:()=>({opens,captures,stops,closes,auths})};
}
const operation=(id='op')=>({operationId:id,purpose:'capture candidate',signal:new AbortController().signal,deadline:performance.now()+400});
test('constructor is inert and private grants fence open and capture',async()=>{
  const x=setup(); assert.deepEqual(x.counts(),{opens:0,captures:0,stops:0,closes:0,auths:0}); x.setControl(false);
  assert.deepEqual(await x.gateway.start({purpose:'activate',deadline:performance.now()+400}),{ok:false,reason:'denied'}); assert.equal(x.counts().opens,0);
  x.setControl(true); const started=await x.gateway.start({purpose:'activate',deadline:performance.now()+400}); assert.ok(started.ok); if(!started.ok)return;
  x.setCapture(false); assert.deepEqual(await x.gateway.capture(started.value,operation()),{ok:false,reason:'denied'}); assert.equal(x.counts().captures,0);
  x.setCapture(true); const result=await x.gateway.capture(started.value,operation('ok')); assert.ok(result.ok); if(result.ok){assert.equal(result.value.reviewRequired,true);assert.equal(result.value.carrierFrequency,'unknown');assert.equal(result.value.physicalReceipt,'unverified');}
  await x.gateway.close(); assert.deepEqual(x.counts(),{opens:1,captures:1,stops:1,closes:1,auths:2});
});
test('already-aborted capture is rejected before authorization or provider work',async()=>{
  const x=setup(), started=await x.gateway.start({purpose:'activate',deadline:performance.now()+400}); assert.ok(started.ok); if(!started.ok)return;
  const c=new AbortController();c.abort(); assert.deepEqual(await x.gateway.capture(started.value,{...operation(),signal:c.signal}),{ok:false,reason:'cancelled'});
  assert.deepEqual(x.counts(),{opens:1,captures:0,stops:0,closes:0,auths:0}); await x.gateway.close();
});
test('Stop joins capture and provider settlement before releasing exact ownership',async()=>{
  let finish!:(value:number[])=>void,settled=false; const x=setup({capture(){return new Promise<number[]>(r=>finish=r)},stop(){finish(packets());},whenSettled(){return new Promise<void>(r=>setTimeout(()=>{settled=true;r()},5))}});
  const started=await x.gateway.start({purpose:'activate',deadline:performance.now()+400}); assert.ok(started.ok); if(!started.ok)return;
  const pending=x.gateway.capture(started.value,operation()); await new Promise(r=>setTimeout(r,5)); await x.gateway.stop(); assert.equal(settled,true);
  assert.equal((await pending).ok,false); assert.equal(x.gateway.status().rawPending,0); await x.gateway.close();
});
test('lifetime attempts remain bounded across restart and seventeenth does not authorize',async()=>{
  const x=setup(); let started=await x.gateway.start({purpose:'one',deadline:performance.now()+400}); assert.ok(started.ok); if(!started.ok)return; x.setCapture(false);
  for(let i=0;i<8;i++) assert.deepEqual(await x.gateway.capture(started.value,operation(`a${i}`)),{ok:false,reason:'denied'}); await x.gateway.stop();
  started=await x.gateway.start({purpose:'two',deadline:performance.now()+400}); assert.ok(started.ok); if(!started.ok)return;
  for(let i=0;i<8;i++) assert.deepEqual(await x.gateway.capture(started.value,operation(`b${i}`)),{ok:false,reason:'denied'});
  assert.deepEqual(await x.gateway.capture(started.value,operation('17')),{ok:false,reason:'quota'}); assert.equal(x.counts().auths,16);
  assert.equal(x.gateway.status().retainedRecords,16); assert.equal(NEC32_IR_RECEIVE_LIMITS.captureAttempts,16); await x.gateway.close();
});
test('exact provider identity excludes concurrent gateways and non-owner close is inert',async()=>{
  let closes=0; const provider={supported:true as const,mode:'LIRC_MODE_MODE2' as const,resolutionMicros:1 as const,
    open(){return 'ready' as const},capture(){return packets()},stop(){},close(){closes++},whenSettled(){return Promise.resolve()}};
  const make=()=>{const owner=new AbortController(),grant=new AbortController();return createNec32IrReceiveGateway({ownerSignal:owner.signal,scope,
    selectedReceiver:{id:'same-provider',profileId:'app:nec-inverse-byte-demodulated-nominal/1'},selectedProvider:provider,
    authorizeReceiver:request=>({request,signal:grant.signal,expiresAt:performance.now()+1000}),
    authorizeCapture:request=>({request,signal:grant.signal,expiresAt:performance.now()+1000}),onRetire(){}})};
  const first=make(),nonOwner=make();const epoch=await first.start({purpose:'first',deadline:performance.now()+400});assert.ok(epoch.ok);
  assert.deepEqual(await nonOwner.start({purpose:'second',deadline:performance.now()+400}),{ok:false,reason:'busy'});await nonOwner.close();assert.equal(closes,0);
  await first.close();assert.equal(closes,1);
});
test('retirement withdraws synchronously before provider settlement',async()=>{
  let release!:()=>void,settled=false,withdrawn=false;const owner=new AbortController(),control=new AbortController(),captureGrant=new AbortController();
  const provider:Nec32IrReceiveProvider={supported:true,mode:'LIRC_MODE_MODE2',resolutionMicros:1,open(){return'ready'},capture(){return packets()},stop(){},close(){},whenSettled(){return settled?Promise.resolve():new Promise<void>(resolve=>{release=()=>{settled=true;resolve()}})}};
  const gateway=createNec32IrReceiveGateway({ownerSignal:owner.signal,scope,selectedReceiver:{id:'withdraw-rx',profileId:'app:nec-inverse-byte-demodulated-nominal/1'},selectedProvider:provider,
    authorizeReceiver:request=>({request,signal:control.signal,expiresAt:performance.now()+1000}),authorizeCapture:request=>({request,signal:captureGrant.signal,expiresAt:performance.now()+1000}),onRetire(){withdrawn=true;assert.equal(settled,false)}});
  const started=await gateway.start({purpose:'activate',deadline:performance.now()+400});assert.ok(started.ok);if(!started.ok)return;
  assert.ok((await gateway.capture(started.value,operation('withdraw'))).ok);captureGrant.abort();assert.equal(withdrawn,true);assert.equal(settled,false);release();await gateway.stop();await gateway.close();
});
test('withdrawal Stop and close reentry join one pending retirement chain',async()=>{
  let release!:()=>void,reentrantStop!:Promise<void>,reentrantClose!:Promise<void>,settled=false,stops=0,closes=0,withdrawals=0;
  const owner=new AbortController(),grant=new AbortController();const provider:Nec32IrReceiveProvider={supported:true,mode:'LIRC_MODE_MODE2',resolutionMicros:1,open(){return'ready'},capture(){return packets()},stop(){stops++},close(){closes++},whenSettled(){return settled?Promise.resolve():new Promise<void>(resolve=>{release=()=>{settled=true;resolve()}})}};
  const gateway=createNec32IrReceiveGateway({ownerSignal:owner.signal,scope,selectedReceiver:{id:'callback-reentry',profileId:'app:nec-inverse-byte-demodulated-nominal/1'},selectedProvider:provider,authorizeReceiver:request=>({request,signal:grant.signal,expiresAt:performance.now()+1000}),authorizeCapture:request=>({request,signal:grant.signal,expiresAt:performance.now()+1000}),onRetire(){withdrawals++;reentrantStop=gateway.stop();reentrantClose=gateway.close()}});
  const started=await gateway.start({purpose:'activate',deadline:performance.now()+400});assert.ok(started.ok);if(!started.ok)return;assert.ok((await gateway.capture(started.value,operation('callback-reentry'))).ok);
  let finished=false;const outer=gateway.stop().then(()=>{finished=true});assert.equal(withdrawals,1);assert.equal(finished,false);assert.deepEqual({stops,closes},{stops:1,closes:0});release();await Promise.all([outer,reentrantStop,reentrantClose]);assert.deepEqual({stops,closes,withdrawals},{stops:1,closes:1,withdrawals:1});
});
test('provider stop and close reentry cannot double-close or release ownership early',async()=>{
  let release!:()=>void,nestedStop!:Promise<void>,nestedClose!:Promise<void>,settled=false,stops=0,closes=0;
  const owner=new AbortController(),grant=new AbortController();const provider:Nec32IrReceiveProvider={supported:true,mode:'LIRC_MODE_MODE2',resolutionMicros:1,open(){return'ready'},capture(){return packets()},stop(){stops++;nestedStop=gateway.stop();nestedClose=gateway.close()},close(){closes++;void gateway.stop()},whenSettled(){return settled?Promise.resolve():new Promise<void>(resolve=>{release=()=>{settled=true;resolve()}})}};
  const gateway=createNec32IrReceiveGateway({ownerSignal:owner.signal,scope,selectedReceiver:{id:'provider-reentry',profileId:'app:nec-inverse-byte-demodulated-nominal/1'},selectedProvider:provider,authorizeReceiver:request=>({request,signal:grant.signal,expiresAt:performance.now()+1000}),authorizeCapture:request=>({request,signal:grant.signal,expiresAt:performance.now()+1000}),onRetire(){}});
  const started=await gateway.start({purpose:'activate',deadline:performance.now()+400});assert.ok(started.ok);if(!started.ok)return;assert.ok((await gateway.capture(started.value,operation('provider-reentry'))).ok);
  const outer=gateway.stop();assert.deepEqual({stops,closes},{stops:1,closes:0});const competitor=createNec32IrReceiveGateway({ownerSignal:new AbortController().signal,scope,selectedReceiver:{id:'competitor',profileId:'app:nec-inverse-byte-demodulated-nominal/1'},selectedProvider:provider,authorizeReceiver:request=>({request,signal:grant.signal,expiresAt:performance.now()+1000}),authorizeCapture:request=>({request,signal:grant.signal,expiresAt:performance.now()+1000}),onRetire(){}});assert.deepEqual(await competitor.start({purpose:'must wait',deadline:performance.now()+400}),{ok:false,reason:'busy'});release();await Promise.all([outer,nestedStop,nestedClose]);await competitor.close();assert.deepEqual({stops,closes},{stops:1,closes:1});
});
