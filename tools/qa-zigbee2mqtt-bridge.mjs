import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const zigbeeOwnedFiles=Object.freeze(['packages/hub-server/src/zigbee2mqtt-bridge.ts','packages/hub-server/src/zigbee2mqtt-bridge.test.ts','examples/zigbee2mqtt-bridge/producer.mjs','examples/zigbee2mqtt-bridge/consumer.mjs','tools/qa-zigbee2mqtt-bridge.mjs','tools/qa-installed-zigbee2mqtt-bridge.mjs']);
export const zigbeeHash=bytes=>createHash('sha256').update(bytes).digest('hex');
function ordinary(directory){return readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>e.isDirectory()?ordinary(join(directory,e.name)):e.isFile()?[join(directory,e.name)]:[]);}
export function zigbeeSourceFingerprints(){
  const root=resolve(import.meta.dirname,'..'),resolver=createRequire(import.meta.url),paths=zigbeeOwnedFiles.map(p=>join(root,p));
  const publicRoot=dirname(dirname(dirname(realpathSync(resolver.resolve('@101/connect')))));
  for(const name of ['connect','device-model','device-runtime','device-web','transport-webrtc','transport-websocket','vision'])paths.push(...ordinary(join(publicRoot,name,'src')),join(publicRoot,name,'package.json'));
  const seen=new Set();function graph(directory){if(seen.has(directory))return;seen.add(directory);paths.push(...ordinary(directory).filter(p=>!p.slice(directory.length+1).startsWith('node_modules/')));
    for(const dependency of Object.keys(JSON.parse(readFileSync(join(directory,'package.json'),'utf8')).dependencies??{})){let at=directory;for(;;){const p=join(at,'node_modules',dependency,'package.json');let found=false;try{found=statSync(p).isFile();}catch{/* Search ordinary package ancestors. */}if(found){graph(dirname(realpathSync(p)));break;}const parent=dirname(at);assert.notEqual(parent,at,dependency);at=parent;}}}
  graph(dirname(realpathSync(resolver.resolve('mqtt/package.json'))));graph(dirname(realpathSync(resolver.resolve('typescript/package.json'))));
  paths.push(realpathSync(process.execPath),zigbeeBrokerBinary().path);
  return Object.fromEntries([...new Set(paths)].sort().map(p=>[p,zigbeeHash(readFileSync(p))]));
}
export function zigbeeBrokerBinary(){
  let binary;for(const p of [process.env.MOSQUITTO_BIN,'/opt/homebrew/opt/mosquitto/sbin/mosquitto','/usr/sbin/mosquitto','/usr/bin/mosquitto','mosquitto'].filter(Boolean)){
    const r=spawnSync(p,['-h'],{encoding:'utf8',timeout:2000});if(r.status===0&&r.stdout?.includes('mosquitto version')){binary={path:p,version:r.stdout.trim().split('\n')[0]};break;}}
  assert.ok(binary,'Existing local Mosquitto required');return Object.freeze({...binary,path:realpathSync(binary.path)});
}
export async function startOwnedZigbeeBroker(){
  const binary=zigbeeBrokerBinary();
  const server=createServer();await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});const address=server.address();assert.ok(address&&typeof address==='object');await new Promise((res,rej)=>server.close(e=>e?rej(e):res()));
  const directory=await mkdtemp(join(tmpdir(),'101-zigbee-broker-')),config=join(directory,'mosquitto.conf');
  await writeFile(config,`listener ${address.port} 127.0.0.1\nallow_anonymous true\npersistence false\nmax_packet_size 17408\nmax_queued_messages 32\nmax_inflight_messages 4\nlog_dest stdout\n`,{mode:0o600});
  const child=spawn(binary.path,['-c',config,'-v'],{stdio:['ignore','pipe','pipe']});let logs='',outcome,closing;
  child.stdout.on('data',b=>{logs=(logs+b).slice(-8192);});child.stderr.on('data',b=>{logs=(logs+b).slice(-8192);});
  const exited=new Promise((res,rej)=>{child.once('error',rej);child.once('exit',(code,signal)=>{outcome={code,signal};res(outcome);});});
  const closed=new Promise(res=>child.once('close',res));void exited.catch(()=>{});
  const close=()=>closing??=(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');let timer;
    try{await Promise.race([Promise.allSettled([exited,closed]).then(results=>{for(const r of results)if(r.status==='rejected')throw r.reason;}),new Promise((_,rej)=>{timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rej(new Error('Owned broker native close unconfirmed'));},2000);})]);
      assert.equal(outcome?.code,0,logs);assert.equal(outcome?.signal,null,logs);
    }finally{if(timer)clearTimeout(timer);await Promise.allSettled([exited,closed]);await rm(directory,{recursive:true,force:true});}
  })();
  try{const deadline=performance.now()+4000;for(;;){assert.ok(performance.now()<deadline,'Owned broker readiness timeout');if(outcome)throw new Error(logs);
      const ready=await new Promise(res=>{const socket=tcpConnect(address.port,'127.0.0.1');let connected=false;const timer=setTimeout(()=>socket.destroy(),150);
        socket.once('connect',()=>{connected=true;socket.destroy();});socket.once('error',()=>socket.destroy());socket.once('close',()=>{clearTimeout(timer);res(connected);});});
      if(ready)break;await new Promise(res=>setTimeout(res,20));}
  }catch(e){const cleanup=await Promise.allSettled([close()]);throw new AggregateError([e,...cleanup.filter(r=>r.status==='rejected').map(r=>r.reason)],'Owned broker startup failed');}
  return Object.freeze({endpoint:`mqtt://127.0.0.1:${address.port}`,version:binary.version,pid:child.pid,binaryPath:realpathSync(binary.path),binarySha256:zigbeeHash(readFileSync(realpathSync(binary.path))),child,close,logs:()=>logs});
}
export async function runZigbee2MqttBridgeQa(){
  const before=zigbeeSourceFingerprints(),broker=await startOwnedZigbeeBroker();let result,error;
  try{const {runZigbee2MqttBridgeConsumer}=await import('../examples/zigbee2mqtt-bridge/consumer.mjs');result=await runZigbee2MqttBridgeConsumer(broker.endpoint);}catch(e){error=e;}
  const settled=await Promise.allSettled([broker.close()]);const errors=[...(error?[error]:[]),...settled.filter(r=>r.status==='rejected').map(r=>r.reason)];if(errors.length)throw new AggregateError(errors,'Zigbee source QA failed');
  assert.deepEqual(zigbeeSourceFingerprints(),before,'Executed source/compiler/dependency closure changed');assert.equal(zigbeeHash(readFileSync(broker.binaryPath)),broker.binarySha256,'Broker executable changed');
  return {schemaVersion:1,status:'pass',sourceSha256:before,broker:{version:broker.version,ownedPid:broker.pid,binaryPath:broker.binaryPath,binarySha256:broker.binarySha256,actualChildClose:true,naturalExitCode:broker.child.exitCode},result,
    scope:'Native-format software fixture, owned loopback broker and source SDK only; no commissioned Zigbee, Matter/Thread, capture-clock, upstream delivery or physical command evidence.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){try{console.log(JSON.stringify(await runZigbee2MqttBridgeQa()));}catch(e){console.error(e);process.exitCode=1;}}
