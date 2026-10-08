import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const CAN_DIAGNOSTIC_SOURCES = Object.freeze(['packages/hub-server/src/canopen-diagnostic-gateway.ts',
  'packages/hub-server/src/canopen-diagnostic-gateway.test.ts', 'examples/canopen-diagnostics/native-port.c',
  'examples/canopen-diagnostics/consumer.mjs', 'tools/qa-canopen-diagnostics.mjs', 'tools/qa-installed-canopen-diagnostics.mjs']);
export const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function ordinaryFiles(directory) { return readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))
  .flatMap(entry => { assert.ok(entry.isFile() || entry.isDirectory(), `nonordinary closure input ${join(directory, entry.name)}`);
    return entry.isDirectory() ? ordinaryFiles(join(directory, entry.name)) : [join(directory, entry.name)]; }); }
const fingerprints = paths => Object.fromEntries([...new Set(paths)].sort().map(path => [path, fileHash(path)]));
export function canDiagnosticSourceFingerprints(root = resolve(import.meta.dirname, '..'), repoRoot = root) {
  const paths = CAN_DIAGNOSTIC_SOURCES.map(path => join(root, path));
  for (const name of ['connect', 'device-model', 'device-runtime', 'device-web', 'transport-webrtc', 'transport-websocket', 'vision'])
    paths.push(...ordinaryFiles(join(repoRoot, 'packages', name, 'src')), join(repoRoot, 'packages', name, 'package.json'));
  paths.push(realpathSync(process.execPath)); return fingerprints(paths);
}
export async function compileCanDiagnosticPort(source, directory, extraFlags = []) {
  assert.ok(process.platform === 'darwin', 'Host scripted compile only; Linux build admission belongs to integration owner');
  const { stdout: compilerPath } = await promisify(execFile)('/usr/bin/xcrun', ['--find', 'clang']);
  const { stdout: sysroot } = await promisify(execFile)('/usr/bin/xcrun', ['--show-sdk-path']);
  const compiler = realpathSync(compilerPath.trim()), binary = join(directory, 'native-port'), dependencies = join(directory, 'native-port.d');
  const args = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-isysroot', sysroot.trim(), ...extraFlags, '-MD', '-MF', dependencies, '-o', binary, source];
  await promisify(execFile)(compiler, args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  const headerPaths = readFileSync(dependencies, 'utf8').replace(/\\\n/g, '').split(':').slice(1).join(':').trim().split(/\s+/).filter(Boolean);
  const { stdout: version } = await promisify(execFile)(compiler, ['--version']);
  return { binary, compiler, args, version: version.trim(), sourceSha256: fileHash(source), binarySha256: fileHash(binary),
    closureSha256: fingerprints([compiler, source, dependencies, binary, ...headerPaths]) };
}
function nativeRecord(kind, nonce, ordinal, payload = Buffer.alloc(96)) {
  const bytes = Buffer.alloc(128); bytes.write('C101'); bytes[4] = 1; bytes[5] = kind; nonce.copy(bytes, 8);
  bytes.writeUInt32LE(1, 24); bytes.writeUInt32LE(ordinal, 28); payload.copy(bytes, 32); return bytes;
}
export async function runCanPortProtocolChecks(binary,{abortFirst=false}={}) {
  const nonce = Buffer.alloc(16, 7), config = Buffer.alloc(96); config[0] = 1; config[1] = 2; config[2] = 7; config.write('harness', 4);
  config.writeBigUInt64LE(1000000000n, 20); config.writeUInt32LE(256, 28); config.writeUInt32LE(4096, 32); config.writeUInt32LE(1000, 36); config.writeBigUInt64LE(1000000000n, 40);
  const child = spawn(binary, ['--scripted-harness'], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  const messages = [], sent = [], errors = [], writes = []; let buffered = Buffer.alloc(0), next = 2, fault;
  const fail = error => { fault ??= error; child.kill('SIGKILL'); };
  const closed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({code, signal})));
  const write = (bytes, end = false) => { const pending = new Promise((resolveWrite, rejectWrite) => {
    const callback = error => error ? rejectWrite(error) : resolveWrite();
    try { if(end)child.stdin.end(callback);else child.stdin.write(bytes,callback); } catch(error){rejectWrite(error);}
  }); pending.catch(fail); writes.push(pending); };
  child.stderr.on('data', bytes => { errors.push(Buffer.from(bytes)); if(Buffer.concat(errors).length>4096)fail(new Error('stderr bound')); });
  child.on('error', fail); child.stdin.on('error',fail);child.stdout.on('error',fail);
  child.stdout.on('data', bytes => { try { buffered = Buffer.concat([buffered, bytes]); assert.ok(buffered.length<=65536);
    while (buffered.length >= 128) {
      const message = Buffer.from(buffered.subarray(0, 128)); buffered = buffered.subarray(128); messages.push(message);assert.ok(messages.length<=512);
      if (message[5] === 5 && message.readUInt32LE(72) === 0x701 && message[80] === 127 && next === 2) {
        const payload = Buffer.alloc(96); payload.writeUInt32LE(1); payload.writeUInt16LE(0x1000, 4); payload[7] = 4; payload.writeBigUInt64LE(1000000000n, 8);
        const read = nativeRecord(2, nonce, next++, payload); sent.push(read); write(read);
      } else if (message[5] === 5 && message.readUInt32LE(72) === 0x581 && next === 3) {
        assert.equal(message.subarray(80, 88).toString('hex'), abortFirst?'8000100000000206':'43001000ffffffff');
        const payload = Buffer.alloc(96); payload.writeUInt32LE(2); payload.writeUInt16LE(0x1001, 4); payload[7] = 1; payload.writeBigUInt64LE(1000000000n, 8);
        const read = nativeRecord(2, nonce, next++, payload); sent.push(read); write(read);
      } else if (message[5] === 5 && message.readUInt32LE(72) === 0x581 && next === 4) {
        assert.equal(message.subarray(80, 88).toString('hex'), '4f011000ff000000'); write(undefined,true);
      }
    }
  }catch(error){fail(error);} });
  const timeout = setTimeout(() => fail(new Error('scripted protocol deadline')), 3000);
  const first = nativeRecord(1, nonce, 1, config); sent.push(first); write(first.subarray(0, 37)); write(first.subarray(37));
  const exit = await closed; clearTimeout(timeout);const settled=await Promise.allSettled(writes);if(fault)throw fault;
  assert.ok(settled.every(item=>item.status==='fulfilled'));assert.equal(exit.code, 0, Buffer.concat(errors).toString()); assert.equal(exit.signal, null); assert.equal(buffered.length, 0);
  assert.equal(sent.length, 3); assert.equal(messages.filter(bytes => bytes[5] === 6).length, 2);
  for (let at = 0; at < messages.length; at++) { const item = messages[at]; assert.equal(item.toString('ascii',0,4),'C101');
    assert.ok(item.subarray(8,24).equals(nonce)); assert.equal(item.readUInt32LE(28),at+1); }
  return {kind:'scripted-process-harness', status:'pass', naturalExit:exit, rawWritesSettled: settled.length, socketOpened:false,
    sent:sent.map(bytes => bytes.toString('hex')), received:messages.map(bytes => bytes.toString('hex'))};
}
export async function runCanPortRefusalChecks(binary) {
  const cases=[{name:'partial-eof',input:Buffer.alloc(17),code:65,args:['--scripted-harness']},
    {name:'bad-header',input:Buffer.alloc(128),code:65,args:['--scripted-harness']},
    {name:'wrong-role',input:nativeRecord(1,Buffer.alloc(16,7),1,Buffer.alloc(96)),code:65,args:['--scripted-harness']},
    {name:'native-entry-blocked',input:Buffer.alloc(0),code:78,args:['--native']}];
  const results=[];
  for(const item of cases){
    const child=spawn(binary,item.args,{stdio:['pipe','pipe','pipe'],env:{}});let bytes=0,fault;
    const closed=new Promise(done=>child.once('close',(code,signal)=>done({code,signal})));
    const fail=error=>{fault??=error;child.kill('SIGKILL');};child.on('error',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);
    child.stdout.on('data',data=>{bytes+=data.length;if(bytes>65536)fail(new Error('refusal output bound'));});child.stderr.on('data',()=>{});
    const raw=new Promise((done,reject)=>{try{child.stdin.end(item.input,error=>error?reject(error):done());}catch(error){reject(error);}});raw.catch(fail);
    const timeout=setTimeout(()=>fail(new Error('refusal close deadline')),2000),exit=await closed;clearTimeout(timeout);
    const settled=await Promise.allSettled([raw]);if(fault)throw fault;assert.equal(settled[0].status,'fulfilled');
    assert.equal(exit.code,item.code,item.name);assert.equal(exit.signal,null);assert.equal(bytes,0);
    results.push({name:item.name,status:'pass',exit,rawWriteSettled:true,readyEmitted:false});
  }return results;
}
export async function runCanDiagnosticQa({ root = resolve(import.meta.dirname, '..'), repoRoot = root, mode = 'scripted-process-harness' } = {}) {
  if (mode !== 'scripted-process-harness') return { status:'blocked', reason:'blocked-native-environment', nativeApproved:false, supportRows:[] };
  const before = canDiagnosticSourceFingerprints(root, repoRoot), directory = mkdtempSync(join(tmpdir(), '101-can-source-'));
  const compiled = await compileCanDiagnosticPort(join(root, 'examples/canopen-diagnostics/native-port.c'), directory);
  const protocol = await runCanPortProtocolChecks(compiled.binary);
  const abortCompiled = await compileCanDiagnosticPort(join(root,'examples/canopen-diagnostics/native-port.c'),mkdtempSync(join(directory,'abort-')),['-DCAN_HARNESS_ABORT_FIRST']);
  const abortProtocol = await runCanPortProtocolChecks(abortCompiled.binary,{abortFirst:true});
  const refusals = await runCanPortRefusalChecks(compiled.binary);
  const {runCanDiagnosticExample} = await import(pathToFileURL(join(root, 'examples/canopen-diagnostics/consumer.mjs')));
  const results=[];for(const scenario of ['normal','route-expiry','route-revoke-after-read','gateway-expiry','gateway-revoke-opening'])
    results.push(await runCanDiagnosticExample({nativeExecutable:compiled.binary,sourceSha256:compiled.sourceSha256,mode,scenario}));
  results.push(await runCanDiagnosticExample({nativeExecutable:abortCompiled.binary,sourceSha256:abortCompiled.sourceSha256,mode,scenario:'sdo-abort'}));
  assert.deepEqual(canDiagnosticSourceFingerprints(root,repoRoot), before, 'source SDK/runtime closure changed');
  assert.equal(fileHash(compiled.binary),compiled.binarySha256);
  for (const [path, sha] of Object.entries({...compiled.closureSha256,...abortCompiled.closureSha256})) assert.equal(fileHash(path),sha,`compiler/header/native closure changed ${path}`);
  const receipt = {schemaVersion:1,status:'pass',kind:'scripted-process-public-source-SDK-proof',sourceSha256:before,
    compiled,protocol,abortCompiled,abortProtocol,refusals,results,nativeEnvironment:{status:'blocked',reason:'no-approved-CAN-socket-clock-namespace',nativeApproved:false},
    physical:false,supportRows:[],scope:'Owned C scripted process and ordinary public source SDK route; no CAN socket, vcan, stack conformance, sensor units, hardware clock or full A11 proof.'};
  writeFileSync(join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n'); return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode')+1] : 'scripted-process-harness';
    const repoRoot = process.argv.includes('--repo-root') ? realpathSync(process.argv[process.argv.indexOf('--repo-root')+1]) : resolve(import.meta.dirname,'..');
    const result = await runCanDiagnosticQa({mode,repoRoot}); console.log(JSON.stringify(result)); if(result.status!=='pass')process.exitCode=2;
  } catch(error) { console.error(error);process.exitCode=1; }
}
