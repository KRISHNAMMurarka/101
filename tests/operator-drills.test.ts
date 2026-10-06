import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {Server} from 'node:net';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root=resolve(import.meta.dirname,'..'),names=['hub-server','pairing','protocol','input','connect','device-model','device-runtime','device-web','transport-webrtc','transport-websocket','vision'];
const hooks=registerHooks({resolve(specifier,context,next){const name=specifier.startsWith('@101/')?specifier.slice(5):'';return next(names.includes(name)?pathToFileURL(join(root,'packages',name,'src/index.ts')).href:specifier,context);}});
test.after(()=>hooks.deregister());

test('actual mTLS operator producer needs the selected upgrade rollback and incident runner',async()=>{
  const {runOperatorDrillPrefix}=await import('../tools/operator-drills.mjs');
  const prefix=await runOperatorDrillPrefix(new AbortController().signal);
  assert.equal(prefix.actualNativeTlsStartup,true);assert.equal(prefix.actualSessionAdmission,201);
  console.log(JSON.stringify({genuineNativePrefix:prefix}));
  let runner:{runOperatorDrills?:unknown}|undefined;
  try {const path='../examples/operator-drills/operator-drills.ts';runner=await import(path);}catch{/* The new selected runner is missing after a genuine successful baseline. */}
  assert.equal(typeof runner?.runOperatorDrills,'function','genuine operator native producer works; selected incident drill runner is missing');
});

test('closed drill options reject copied native signals and accessors before native work',async()=>{
  const {runOperatorDrills}=await import('../examples/operator-drills/operator-drills.ts');
  await assert.rejects(runOperatorDrills({signal:{aborted:false} as unknown as AbortSignal}),/options invalid/);
  const aborted=new AbortController();aborted.abort();Object.defineProperty(aborted.signal,'aborted',{value:false});
  await assert.rejects(runOperatorDrills({signal:aborted.signal}),/options invalid/);
  let accessed=0;const candidate={signal:new AbortController().signal,get onStage(){accessed++;return ()=>{};}};
  await assert.rejects(runOperatorDrills(candidate),/options invalid/);assert.equal(accessed,0);
});

test('actual three drills keep deletion revocation retention and native cleanup',async()=>{
  const {runOperatorDrills}=await import('../examples/operator-drills/operator-drills.ts');
  const receipt=await runOperatorDrills({signal:new AbortController().signal});
  assert.equal(receipt.result,'pass');assert.equal(receipt.cleanup.nativeContexts,0);assert.equal(receipt.cleanup.pendingOperations,0);
  assert.ok(receipt.checks.some(value=>value.includes('fsynced candidate')));assert.ok(receipt.checks.some(value=>value.includes('authoritative current audit')));
  assert.ok(receipt.checks.some(value=>value.includes('removed enrollment')));assert.equal(receipt.physicalQualification,false);
  assert.equal(JSON.stringify(receipt).includes('PRIVATE KEY'),false);assert.equal(JSON.stringify(receipt).includes('Bearer '),false);
});

test('observer cancellation retires native work but retains invocation reservation until actual observer settlement',async()=>{
  const {runOperatorDrills}=await import('../examples/operator-drills/operator-drills.ts');
  const owner=new AbortController();let entered!:()=>void,resume!:()=>void,settled=false;
  const observed=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{resume=resolve;});
  const running=runOperatorDrills({signal:owner.signal,onStage(stage){if(stage==='native-started'){entered();return hold;}}}).finally(()=>{settled=true;});void running.catch(()=>{});
  let watchdog:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([observed,new Promise<void>((_resolve,reject)=>{watchdog=setTimeout(()=>reject(Error('Owned native observer deadline.')),10000);})]);
    owner.abort();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(settled,false);
    await assert.rejects(runOperatorDrills({signal:new AbortController().signal}),/already active/);
    resume();const retired=await running;assert.equal(retired.result,'cancelled');assert.equal(retired.cleanup.nativeContexts,0);
  }finally{clearTimeout(watchdog);resume();owner.abort();await running.catch(()=>{});}
});

test('actual first native bind abort prevents replacement and waits for real listener close',async()=>{
  const {runOperatorDrills}=await import('../examples/operator-drills/operator-drills.ts');
  const owner=new AbortController(),originalListen=Server.prototype.listen;
  let binds=0,closed=0;
  Server.prototype.listen=function(...args){
    binds++;this.once('close',()=>closed++);
    this.once('listening',()=>owner.abort());
    return Reflect.apply(originalListen,this,args);
  };
  try {
    const receipt=await runOperatorDrills({signal:owner.signal});
    assert.equal(receipt.result,'cancelled');assert.equal(binds,1);assert.equal(closed,1);
    assert.equal(receipt.cleanup.nativeContexts,0);assert.equal(receipt.cleanup.pendingOperations,0);
  }finally{owner.abort();Server.prototype.listen=originalListen;}
});

test('observer failure is redacted and removes owned state before an explicit fresh invocation',async()=>{
  const {runOperatorDrills}=await import('../examples/operator-drills/operator-drills.ts');
  const stages:string[]=[];
  await assert.rejects(runOperatorDrills({signal:new AbortController().signal,onStage(stage){
    stages.push(stage);if(stage==='owned-state-created')throw Error('private fixture credential details');
  }}),error=>error instanceof Error&&error.message==='Operator drill failed.');
  assert.deepEqual(stages,['owned-state-created','removed']);
  const fresh=new AbortController();fresh.abort();
  await assert.rejects(runOperatorDrills({signal:fresh.signal}),/options invalid/);
});
