#!/usr/bin/env node
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCoordinatorFixtures } from './qa-https-coordinator.mjs';

const root = resolve(import.meta.dirname, '..');
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const publicNames = ['hub-server','pairing','protocol','input','connect','device-model','device-runtime','device-web','transport-webrtc','transport-websocket','vision'];
let cliReserved = false, prefixReserved = false;
function current(signal) { try { return nativeAborted.call(signal) === false; } catch { return false; } }
function publicSource() {
  const pins=new Map();let sourceBytes=0;
  const hooks=registerHooks({ resolve(specifier,context,next) {
  const name = specifier.startsWith('@101/') ? specifier.slice(5) : '';
  const result=next(publicNames.includes(name) ? pathToFileURL(join(root,'packages',name,'src/index.ts')).href : specifier,context);
  if(result.url.startsWith('file:')) {
    const file=fileURLToPath(result.url),path=relative(root,file);
    if(/^(packages|examples|tools)\/.+\.(ts|mjs)$/.test(path)&&!pins.has(path)) {
      if(pins.size>=256||path.length>200||realpathSync(file)!==file)throw Error('Operator drill source closure invalid.');
      const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2097152||(sourceBytes+=stat.size)>8388608)throw Error('Operator drill source closure invalid.');
      pins.set(path,createHash('sha256').update(readFileSync(file)).digest('hex'));
    }
  }
  return result;
} });
  return {deregister:()=>hooks.deregister(),snapshot(){
    const value=Object.freeze(Object.fromEntries([...pins].sort(([a],[b])=>a.localeCompare(b))));
    if(Buffer.byteLength(JSON.stringify(value))>49152)throw Error('Operator drill source closure quota.');return value;
  }};
}
function configuration(fixture) {
  return { schemaVersion:1,profile:'operator-loopback-startup/1',identity:{ serverCertificatePem:fixture.server.certificatePem,
    serverPrivateKeyPem:fixture.server.privateKeyPem,clientCaCertificatePem:fixture.ca,
    enrollments:fixture.clients.slice(0,3).map(({principalId,deviceId,certificatePem})=>({principalId,deviceId,certificatePem})) },
    origins:['https://operator-drills.example'],listener:{host:'127.0.0.1',port:0},directory:{resources:[]},
    storage:{mode:'ephemeral',acknowledgeLossOnStop:true},relay:{mode:'disabled'},quotas:{profile:'fixed-coordinator-directory/1'} };
}

/** Baseline is genuine existing native/public behavior, distinct from the new
 * missing drill assertion. No keys, bearer or endpoint is returned. */
export async function runOperatorDrillPrefix(signal) {
  if (prefixReserved) throw Error('Operator drill prefix already active.'); prefixReserved = true;
  const scope = new AsyncLocalStorage(), token = Object.freeze({}), nativeClients = channel('net.client.socket'), sockets = new Map();
  let fixture, controller, caller, hooks, stopping, attached=false;
  const native = work => scope.run(token,work);
  const observe = ({socket}) => { if (scope.getStore() !== token) return;
    const closed = new Promise(resolve => socket.once('close',()=>{sockets.delete(socket);resolve();})); sockets.set(socket,closed);
    if (!current(signal) || sockets.size > 4) socket.destroy(); };
  const stop = () => { if (stopping) return stopping; caller?.close(); stopping = controller?.stop() ?? Promise.resolve(); return stopping; };
  const cancel = () => { void stop(); };
  try {
    if (!current(signal)) throw Error('Operator drill prefix signal invalid.');
    hooks = publicSource(); nativeClients.subscribe(observe); addEvent.call(signal,'abort',cancel,{once:true});attached=true;
    fixture = createCoordinatorFixtures();
    for (const name of ['ca','server','wrong-host','expired-server','host-a','host-b','peer-a','peer-b','other','unknown','expired-client']) {
      const file=join(fixture.directory,name+'.key');chmodSync(file,0o600);const stat=lstatSync(file);
      assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o777)===0o600);
    }
    if (!current(signal)) throw Error('Operator drill prefix cancelled.');
    const { prepareOperatorIdentityLifecycle,createCoordinatorFetcher } = await import('@101/hub-server');
    if (!current(signal)) throw Error('Operator drill prefix cancelled.');
    const prepared = prepareOperatorIdentityLifecycle(configuration(fixture)); assert.ok(prepared.ok); controller=prepared.controller;
    const started = await native(()=>controller.start()); assert.ok(started.ok); if (!current(signal)) throw Error('Operator drill prefix cancelled.');
    caller = createCoordinatorFetcher({ endpoint:started.endpoint,origin:'https://operator-drills.example',caCertificatePem:fixture.ca,
      certificatePem:fixture.clients[0].certificatePem,privateKeyPem:fixture.clients[0].privateKeyPem });
    const response = await native(()=>caller.fetch(started.endpoint+'/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'OWNED-DRILL'})}));
    assert.equal(response.status,201); await response.json(); if (!current(signal)) throw Error('Operator drill prefix cancelled.');
    await stop(); assert.equal(controller.snapshot().phase,'stopped');
    return Object.freeze({ result:'pass',actualNativeTlsStartup:true,actualSessionAdmission:201,authorityCopied:false,privateStateReturned:false });
  } finally {
    if(attached)removeEvent.call(signal,'abort',cancel); await stop();
    for (const socket of sockets.keys()) socket.destroy(); await Promise.all([...sockets.values()]); assert.equal(sockets.size,0);
    nativeClients.unsubscribe(observe); scope.disable(); const directory=fixture?.directory;fixture?.close();assert.ok(!directory||!existsSync(directory));
    hooks?.deregister();prefixReserved=false;
  }
}

/** Explicit source Hub/SDK resolution. No endpoint/path/configuration input. */
export async function runOperatorDrillsCli(signal, report=value=>console.log(JSON.stringify(value))) {
  if (cliReserved) throw Error('Operator drills CLI already active.');cliReserved=true;let hooks;
  try {
    if (!current(signal) || typeof report!=='function') throw Error('Operator drills CLI options invalid.');
    hooks=publicSource();const {runOperatorDrills}=await import('../examples/operator-drills/operator-drills.ts');
    const receipt=await runOperatorDrills({signal,onStage:stage=>report({event:'stage',stage})});
    if (current(signal)) await report({...receipt,publicResolution:'explicit-owned-source-barrels',sourceDependencySha256:hooks.snapshot()});return receipt;
  } finally {hooks?.deregister();cliReserved=false;}
}
async function main() {
  const args=process.argv.slice(2);
  if (args.length!==1||!['--exercise','--help'].includes(args[0])) {console.error('Use node tools/operator-drills.mjs --exercise or --help.');process.exitCode=2;return;}
  if (args[0]==='--help') {console.log(JSON.stringify({profile:'local-operator-recovery-drills/1',steps:['reject incompatible update and cancel staged commit','review compatible rollback with current revocation and owner guards','revoke compromised local credentials and explicitly recover'],scope:'new disposable loopback software state only'}));return;}
  const owner=new AbortController(),cancel=()=>owner.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try {await runOperatorDrillsCli(owner.signal);} catch {console.error('Operator drill failed. Retire owned work and retry with a fresh disposable owner.');process.exitCode=1;}
  finally {process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await main();
