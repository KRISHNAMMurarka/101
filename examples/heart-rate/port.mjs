import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync,realpathSync,mkdirSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
/** The executable/selected-source closure is enrolled by the local QA owner, never by child messages. */
export function createHeartRateSoftwarePort({python,pythonSha256,selectedSource,selectedSourceSha256,pycachePrefix}){
 python=realpathSync(python);selectedSource=realpathSync(selectedSource);assert.equal(hash(python),pythonSha256);assert.equal(hash(selectedSource),selectedSourceSha256);
 mkdirSync(pycachePrefix,{recursive:true});assert.deepEqual(readdirSync(pycachePrefix),[]);
 let child,context,identity,opened=false,closed=false,fenced=false,buffer='',receivedBytes=0,sequence=0,pendingWrite=0;
 let processTerminal,finishTerminal,terminalResult,created=false,actualClose,exitResult,closeResult,closing,runtimeBefore,runtimeAfter,lastValueSequence=0;const stdioClose=[];
 const waiters=new Set(),listeners=[],writes=new Set(),commands=[];let lastFault;
 function listen(target,name,callback,once=false){target[once?'once':'on'](name,callback);listeners.push(()=>target.removeListener(name,callback));}
 function fail(error){lastFault??=error;fenced=true;try{context?.onLost()}catch{/* A loss callback must not prevent joining raw process work. */}for(const w of [...waiters]){waiters.delete(w);clearTimeout(w.timer);w.reject(error);}child?.kill('SIGKILL');}
 function wait(type,timeout=3000){return new Promise((resolve,reject)=>{const w={type,resolve,reject,timer:undefined};w.timer=setTimeout(()=>{waiters.delete(w);reject(Error('fixed IPC timeout'));fail(Error('fixed IPC timeout'));},timeout);waiters.add(w);});}
 function onLine(raw){
  assert.ok(Buffer.byteLength(raw)<=65536);const value=JSON.parse(raw);assert.equal(typeof value,'object');
  if(value.type==='hello'){assert.deepEqual(Object.keys(value).sort(),['type','fixture','profileId','sourceSha256','methodSha256','astSha256','feedback','vendorSensors','runtime'].sort());assert.equal(value.fixture,true);assert.equal(value.profileId,'app:hrs-1.0-heart-rate-notifications/1');assert.equal(value.sourceSha256,selectedSourceSha256);assert.equal(value.methodSha256,'dd53fdcd2ea14b69dcdf106d501b960c933d5f738b7a46f7067df97d55426849');assert.equal(value.astSha256,'a8568f9ae00d3cad913fce6579b1a3104d31b0015526043294adfb7aaee4eac6');assert.equal(value.feedback,'absent');assert.equal(value.vendorSensors,'absent');runtimeBefore=value.runtime;}
  else if(value.type==='closed'){assert.deepEqual(Object.keys(value).sort(),['runtime','type']);runtimeAfter=value.runtime;}
  else{
   assert.ok(identity&&value.generation===identity.generation&&value.token===identity.token);
   if(value.type==='value'){
    assert.deepEqual(Object.keys(value).sort(),['type','generation','token','sequence','fixture','bytes'].sort());assert.equal(value.fixture,true);assert.equal(value.sequence,lastValueSequence+1);lastValueSequence=value.sequence;
    assert.ok(Array.isArray(value.bytes)&&value.bytes.length>=2&&value.bytes.length<=20&&value.bytes.every(b=>Number.isInteger(b)&&b>=0&&b<=255));
    if(!fenced&&!context.signal.aborted)context.onValue(Uint8Array.from(value.bytes));
   }else assert.ok(['ready','stopped'].includes(value.type)&&Object.keys(value).length===3);
  }
  const matching=[...waiters].filter(w=>w.type===value.type);assert.equal(matching.length,1,'unsolicited/replayed IPC');const w=matching[0];waiters.delete(w);clearTimeout(w.timer);w.resolve(value);
 }
 function send(message){
  assert.ok(child?.stdin.writable);assert.ok(pendingWrite<1);const text=JSON.stringify(message)+'\n';assert.ok(Buffer.byteLength(text)<=1024);commands.push(message.type);pendingWrite++;
  let complete;const token=new Promise((resolve,reject)=>{complete=error=>error?reject(error):resolve();});writes.add(token);token.catch(fail).finally(()=>{writes.delete(token);pendingWrite--;});
  try{child.stdin.write(text,complete);}catch(error){complete(error);}
 }
 async function open(c){
  assert.equal(closed,false);assert.equal(child,undefined);context=c;fenced=false;identity={generation:c.generation,token:randomBytes(16).toString('hex')};
  assert.equal(hash(python),pythonSha256);assert.equal(hash(selectedSource),selectedSourceSha256);
  const hello=wait('hello');child=spawn(python,['-I','-S','-B','-X',`pycache_prefix=${pycachePrefix}`,fileURLToPath(new URL('./producer.py',import.meta.url)),selectedSource],{env:{LANG:'C',TZ:'UTC'},stdio:['pipe','pipe','pipe']});
  processTerminal=new Promise(resolve=>{finishTerminal=resolve});listen(child,'spawn',()=>{created=true},true);listen(child,'exit',(code,signal)=>{exitResult={code,signal};terminalResult={kind:'exit',...exitResult};finishTerminal(terminalResult);},true);
  for(const stream of [child.stdin,child.stdout,child.stderr])stdioClose.push(new Promise(resolve=>listen(stream,'close',resolve,true)));
  actualClose=new Promise(resolve=>listen(child,'close',(code,signal)=>{closeResult={code,signal};child=undefined;for(const w of [...waiters]){waiters.delete(w);clearTimeout(w.timer);w.reject(Error('producer closed'));}resolve(closeResult);},true));
  listen(child,'error',error=>{if(!created&&child.pid===undefined){terminalResult={kind:'no-process',code:error.code??null};finishTerminal(terminalResult);}fail(error);});for(const stream of [child.stdin,child.stdout,child.stderr])listen(stream,'error',fail);
  listen(child.stdout,'data',chunk=>{try{receivedBytes+=chunk.length;assert.ok(receivedBytes<=524288);buffer+=chunk.toString('utf8');assert.ok(Buffer.byteLength(buffer)<=131072);while(buffer.includes('\n')){const at=buffer.indexOf('\n');const line=buffer.slice(0,at);buffer=buffer.slice(at+1);onLine(line);}}catch(error){fail(error);}});
  listen(child.stderr,'data',chunk=>{if(chunk.length)fail(Error('producer stderr; fixed diagnostic only'));});
  await hello;if(fenced||c.signal.aborted)throw Error('retired startup');assert.equal(runtimeBefore.executable,python);assert.equal(runtimeBefore.sha256,pythonSha256);
  const ready=wait('ready');send({type:'open',...identity});await ready;opened=true;return'ready';
 }
 function stop(){fenced=true;}
 function close(){
  if(closing)return closing;closed=true;fenced=true;
  closing=(async()=>{
   if(!actualClose)return;
   try{await Promise.all([...writes]);if(!lastFault&&child){
    // A start canceled before ready is still joined; close may supersede pending readiness.
    if(identity&&opened){const stopped=wait('stopped');send({type:'stop',...identity});await stopped;}
    const ack=wait('closed');send({type:'close'});await ack;child?.stdin.end();
   }}catch(error){fail(error);}
   await Promise.all([actualClose,processTerminal,...stdioClose,...writes]);for(const dispose of listeners.splice(0))dispose();if(lastFault)throw lastFault;assert.deepEqual(terminalResult,{kind:'exit',code:0,signal:null});assert.deepEqual(exitResult,{code:0,signal:null});assert.deepEqual(closeResult,exitResult);assert.equal(buffer,'');
  })();return closing;
 }
 async function tick(){assert.ok(!fenced&&context&&!context.signal.aborted);assert.ok(sequence<11);const value=wait('value');send({type:'tick',...identity,sequence:++sequence});await value;await Promise.all([...writes]);}
 return{port:Object.freeze({kind:'software-notification',providerId:'selected-bluez-5.87-software',open,stop,close,whenSettled:async()=>{if(closing)await closing;await Promise.all([...writes]);}}),tick,
  status:()=>({childRunning:!!child,waiters:waiters.size,listeners:listeners.length,pendingWrites:writes.size,frames:lastValueSequence,fenced}),
  evidence:()=>({fixture:true,commands:[...commands],runtimeBefore,runtimeAfter,producerExit:exitResult,producerClose:closeResult,producerTerminal:terminalResult})};
}
