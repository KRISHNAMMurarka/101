import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

test('actual owned worker ACK is available but subscribed graph qualification requires a runner',async()=>{
 const worker=new Worker(new URL('../examples/runtime-load/application-target.mjs',import.meta.url),{workerData:{schemaVersion:1,scopeIndex:0},execArgv:[]});
 try {const [ready]=await once(worker,'message');assert.equal(ready.kind,'ready');
 const ack=once(worker,'message');worker.postMessage({kind:'apply',id:1,edge:0,sequence:1,state:7});const [applied]=await ack;
 assert.equal(applied.kind,'applied');assert.equal(applied.state,7);assert.equal(applied.sequence,1);assert.equal(applied.clockId,'owned-node-worker-0');assert.ok(Number.isFinite(applied.emittedAt));
 let runner;try{runner=await import('../examples/runtime-load/runtime-load.ts');}catch{/* Missing runner is the intended feature regression. */};
 assert.equal(typeof runner?.runRuntimeLoadQualification,'function','Genuine target effects exist but graph/session load runner is missing');
 }finally{await worker.terminate();}
});

for(const tier of [16,64,128] as const)test('selected '+tier+' subscribed edges receive actual current worker effects and recover',async()=>{
 const {runRuntimeLoadQualification}=await import('../examples/runtime-load/runtime-load.ts');const signal=new AbortController();
 const receipt=await runRuntimeLoadQualification({tier,signal:signal.signal,authorize:()=>({expiresAt:performance.now()+20000,maxAgeMs:250,maxHz:50})});
 assert.equal(receipt.status,'pass',JSON.stringify(receipt));assert.equal(receipt.turns,60);assert.ok(receipt.sustainedElapsedMs>=1000);assert.equal(receipt.allEdgesServed,true);
 assert.equal(receipt.heldOtherScopeProgress,true);assert.equal(receipt.denialDispatchDelta,0);assert.equal(receipt.overloadDispatchDelta,0);assert.equal(receipt.overloadPreserved,true);
 assert.ok(receipt.scopes.every(scope=>scope.admittedEdges===tier/4&&scope.peakRaw<=2&&scope.recoveryApplied>0));
 assert.equal(receipt.ownedCleanup.workersStarted,4);assert.equal(receipt.ownedCleanup.workersExited,4);assert.equal(receipt.ownedCleanup.pendingRaw,0);
 assert.equal(receipt.ownedCleanup.contexts,0);
});
test('actual host denial dispatches no native effect and closes all owned targets',async()=>{
 const {runRuntimeLoadQualification}=await import('../examples/runtime-load/runtime-load.ts');const receipt=await runRuntimeLoadQualification({tier:16,signal:new AbortController().signal,authorize:()=>undefined});
 assert.equal(receipt.status,'denied');assert.equal(receipt.scopes.reduce((sum,row)=>sum+row.dispatched,0),0);assert.equal(receipt.ownedCleanup.workersExited,4);
});
test('reentrant owner cancellation retains runner reservation through actual target exits',async()=>{
 const {runRuntimeLoadQualification}=await import('../examples/runtime-load/runtime-load.ts');const owner=new AbortController();let nested:ReturnType<typeof runRuntimeLoadQualification>|undefined;
 const receipt=await runRuntimeLoadQualification({tier:16,signal:owner.signal,authorize:()=>{
 owner.abort();nested=runRuntimeLoadQualification({tier:16,signal:new AbortController().signal,authorize:()=>undefined});return{expiresAt:performance.now()+20000,maxAgeMs:250,maxHz:50};}});
 assert.equal(receipt.status,'cancelled');assert.equal((await nested)?.status,'busy');assert.equal(receipt.scopes.reduce((sum,row)=>sum+row.dispatched,0),0);
 assert.equal(receipt.ownedCleanup.workersStarted,receipt.ownedCleanup.workersExited);assert.equal(receipt.ownedCleanup.contexts,0);
});

test('sustained owner cancellation fences late ACKs and settles native work',async()=>{
 const {runRuntimeLoadQualification}=await import('../examples/runtime-load/runtime-load.ts');const owner=new AbortController();let admissions=0,timer:ReturnType<typeof setTimeout>|undefined;
 try{const receipt=await runRuntimeLoadQualification({tier:16,signal:owner.signal,authorize:()=>{if(++admissions===16)timer=setTimeout(()=>owner.abort(),250);return{expiresAt:performance.now()+20000,maxAgeMs:250,maxHz:50};}});
 assert.equal(receipt.status,'cancelled');assert.ok(receipt.scopes.reduce((sum,row)=>sum+row.dispatched,0)>0);
 assert.deepEqual(receipt.ownedCleanup,{workersStarted:4,workersExited:4,pendingRaw:0,timers:0,listeners:0,contexts:0});assert.equal(Object.isFrozen(receipt),true);
 }finally{if(timer)clearTimeout(timer);owner.abort();}
});
test('actual fixed target rejects replay and malformed state before effect ACK',async()=>{
 const worker=new Worker(new URL('../examples/runtime-load/application-target.mjs',import.meta.url),{workerData:{schemaVersion:1,scopeIndex:0},execArgv:[]});
 const send=async(value:unknown)=>{const response=once(worker,'message');worker.postMessage(value);return (await response)[0];};
 try{await once(worker,'message');assert.equal((await send({kind:'apply',id:1,edge:0,sequence:1,state:7})).kind,'applied');
 assert.equal((await send({kind:'apply',id:2,edge:0,sequence:1,state:8})).kind,'rejected');
 assert.equal((await send({kind:'apply',id:3,edge:0,sequence:2,state:257})).kind,'invalid');
 assert.equal((await send({kind:'apply',id:4,edge:0,sequence:2,state:8})).kind,'applied');
 }finally{await worker.terminate();}
});
