import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as api from './canopen-diagnostic-gateway.ts';

const now = () => Number(process.hrtime.bigint()) / 1e6;
const executableSha = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
function profile() { return { profileId: 'canopen-cc-diagnostics-harness/1' as const, revision: 1 as const, interfaceName: 'harness',
  expectedIfindex: 0, namespaceInode: '0', nodeId: 1, nativeExecutablePath: process.execPath, nativeExecutableSha256: executableSha,
  nativeSourceSha256: '1'.repeat(64), environmentReceiptSha256: '2'.repeat(64) }; }
function raw(id: number, data: string) { const bytes = Buffer.from(data, 'hex'), result = Buffer.alloc(16);
  result.writeUInt32LE(id, 0); result[4] = bytes.length; bytes.copy(result, 8); return result; }
function framePayload(id: number, data: string, ordinal: number, request = 0) {
  const payload = Buffer.alloc(96); payload.writeUInt32LE(ordinal, 0); payload.writeUInt32LE(16, 28);
  raw(id, data).copy(payload, 40); payload.writeUInt32LE(request, 56); return payload;
}
function fixture() {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
  let configuration: Buffer | undefined, outgoing = 0, receiveOrdinal = 0;
  const sent: Buffer[] = [], held: ((error?: Error) => void)[] = [];
  let holdWrites = false;
  child.stdin.write = ((bytes: Buffer, callback: (error?: Error | null) => void) => {
    const copy = Buffer.from(bytes); sent.push(copy); if (copy[5] === 1) configuration = copy;
    if (holdWrites) held.push(error => callback(error)); else callback(); return true;
  }) as typeof child.stdin.write;
  child.stdin.end = ((callback?: () => void) => { callback?.(); return child.stdin; }) as typeof child.stdin.end;
  function emit(kind: number, payload = Buffer.alloc(96)) {
    assert.ok(configuration); const message = api.encodeCanPortRecord(kind, configuration.subarray(8, 24), configuration.readUInt32LE(24), ++outgoing, payload);
    child.stdout.emit('data', message);
  }
  const owner = new AbortController(), caller = new AbortController(), grant = new AbortController();
  const readings: api.CanDiagnosticReading[] = [], unavailable: string[] = [];
  let authorizations = 0;
  const input: api.CanDiagnosticOptions = { profile: profile(), ownerSignal: owner.signal,
    scope: { principalId: 'owner', applicationId: 'test', sessionId: 'one' },
    authorize(request) { authorizations++; return { request, signal: grant.signal, expiresAt: request.deadline }; },
    onReading(reading) { readings.push(reading); }, onUnavailable(reason) { unavailable.push(reason); } };
  return { child, owner, caller, grant, input, readings, unavailable, sent, held,
    calls: () => authorizations, holdWrites() { holdWrites = true; }, settleWrites() { for (const fn of held.splice(0)) fn(); },
    ready() { emit(4); }, heartbeat(value = 127) { emit(5, framePayload(0x701, value.toString(16).padStart(2, '0'), ++receiveOrdinal)); },
    response(data: string, request: number) { emit(5, framePayload(0x581, data, ++receiveOrdinal, request)); },
    dispatched(request: number) { const payload = Buffer.alloc(96); payload.writeUInt32LE(request, 0); payload.writeUInt32LE(16, 4); emit(6, payload); },
    close() { child.emit('exit', 0, null); child.emit('close', 0, null); },
    options: () => ({ purpose: 'diagnostics', signal: caller.signal, deadline: now() + 1000 }) };
}
async function until(predicate: () => boolean) { const deadline = now() + 1000; while (!predicate()) {
  assert.ok(now() < deadline, 'fixture boundary reached'); await new Promise(resolve => setTimeout(resolve, 1)); } }
function fakeSpawn(f: ReturnType<typeof fixture>) {
  mock.method(childProcess, 'spawn', () => f.child); return () => mock.restoreAll();
}
test('exact standard diagnostic widths, raw flags and heartbeat states', () => {
  for (const state of [0, 4, 5, 127]) assert.deepEqual(api.decodeCanDiagnosticFrame(raw(0x701, state.toString(16).padStart(2, '0')), 1, null),
    { kind: 'heartbeat', nodeId: 1, value: state });
  assert.deepEqual(api.decodeCanDiagnosticFrame(raw(0x581, '43001000ffffffff'), 1, { index: 0x1000, subindex: 0, width: 4 }),
    { kind: 'device-type', nodeId: 1, value: 0xffffffff });
  assert.deepEqual(api.decodeCanDiagnosticFrame(raw(0x581, '4f011000ffabcdef'), 1, { index: 0x1001, subindex: 0, width: 1 }),
    { kind: 'error-register', nodeId: 1, value: 255 });
  assert.deepEqual(api.decodeCanDiagnosticFrame(raw(0x581, '8000100000000206'), 1, { index: 0x1000, subindex: 0, width: 4 }),
    { kind: 'sdo-abort', nodeId: 1, value: 0x06020000 });
  for (const id of [0x80000701, 0x40000701, 0x20000701, 0x702]) assert.throws(() => api.decodeCanDiagnosticFrame(raw(id, '7f'), 1, null));
  for (const data of ['01', '7f00']) assert.throws(() => api.decodeCanDiagnosticFrame(raw(0x701, data), 1, null));
  for (const data of ['4100100004000000', '4301100000000000', '4300100100000000'])
    assert.throws(() => api.decodeCanDiagnosticFrame(raw(0x581, data), 1, { index: 0x1000, subindex: 0, width: 4 }));
});
test('profile admits own immutable data and no unapproved native environment', async () => {
  const p = profile(), frozen = api.parseCanDiagnosticProfile(p); p.nodeId = 2; assert.equal(frozen.nodeId, 1); assert.ok(Object.isFrozen(frozen));
  assert.throws(() => api.parseCanDiagnosticProfile({ ...profile(), get revision() { throw new Error('accessor must not run'); } }));
  assert.throws(() => api.parseCanDiagnosticProfile(new Proxy(profile(), {})));
  const f = fixture(); let effects = 0; mock.method(childProcess, 'spawn', () => { effects++; return f.child; });
  try { const connector = api.createCanDiagnosticConnector({ ...f.input, profile: { ...profile(), profileId: 'canopen-cc-diagnostics-vcan/1',
    interfaceName: 'vcan101', expectedIfindex: 1, namespaceInode: '1' } });
    assert.equal((await connector.start(f.options())).ok, false); assert.equal(f.calls(), 0); assert.equal(effects, 0); await connector.close();
  } finally { mock.restoreAll(); }
});
test('expired and excessive original caller deadline rejected before authority', async () => {
  const f = fixture(), connector = api.createCanDiagnosticConnector(f.input);
  for (const deadline of [now() - 1, now() + 31000, NaN, Infinity]) assert.equal((await connector.start({ ...f.options(), deadline })).ok, false);
  assert.equal(f.calls(), 0); await connector.close();
});
test('standard Node genuine signals only, before authorizer/native effects', () => {
  const f = fixture();
  for (const signal of [new Proxy(f.owner.signal, {}), Object.create(f.owner.signal), { aborted: false }])
    assert.throws(() => api.createCanDiagnosticConnector({ ...f.input, ownerSignal: signal as AbortSignal }));
  class Derived extends AbortSignal {};
  const fake = Object.create(Derived.prototype) as AbortSignal;
  assert.throws(() => api.createCanDiagnosticConnector({ ...f.input, ownerSignal: fake }));
});
test('approval must bind exact original deadline/request identity', async () => {
  const f = fixture();
  const connector = api.createCanDiagnosticConnector({ ...f.input, authorize: request => ({ request: { ...request }, signal: f.grant.signal, expiresAt: now() + 1000 }) });
  assert.equal((await connector.start(f.options())).ok, false); assert.equal(connector.status().nativeChildren, 0); await connector.close();
});
test('authorizer reentrant close and revoke cannot spawn', async () => {
  for (const action of ['close', 'revoke']) {
    const f = fixture(); let effects = 0; mock.method(childProcess, 'spawn', () => { effects++; return f.child; });
    const connector: api.CanDiagnosticConnector = api.createCanDiagnosticConnector({ ...f.input, authorize: request => {
      if (action === 'close') void connector.close(); else f.owner.abort(); return { request, signal: f.grant.signal, expiresAt: request.deadline };
    } });
    try { assert.equal((await connector.start(f.options())).ok, false); assert.equal(effects, 0); await connector.close(); }
    finally { mock.restoreAll(); }
  }
});
test('opening expiry retains true child-close reservation and does not renew', async () => {
  const f = fixture(), restore = fakeSpawn(f), connector = api.createCanDiagnosticConnector(f.input);
  try { const opening = connector.start({ ...f.options(), deadline: now() + 200 });
    assert.equal((await opening).ok, false); assert.equal(connector.status().nativeChildren, 1);
    f.ready(); f.heartbeat(); assert.equal(f.sent.filter(bytes => bytes[5] === 2).length, 0);
    assert.equal((await connector.start(f.options())).ok, false);
    f.close(); await connector.close(); assert.equal(connector.status().nativeChildren, 0);
  } finally { f.settleWrites(); f.close(); await connector.close(); restore(); }
});
test('held raw write remains independently owned even after child close', async () => {
  const f = fixture(), restore = fakeSpawn(f), connector = api.createCanDiagnosticConnector(f.input); f.holdWrites();
  try { const opening = connector.start(f.options()); f.owner.abort(); assert.equal((await opening).ok, false);
    f.close(); let settled = false; const closing = connector.close().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(settled, false); assert.equal(connector.status().rawWrites, 1);
    f.settleWrites(); await closing; assert.equal(connector.status().nativeChildren, 0);
  } finally { f.settleWrites(); f.close(); await connector.close(); restore(); }
});
test('once-only serial reads preserve max native values and matched abort', async () => {
  const f = fixture(), restore = fakeSpawn(f), connector = api.createCanDiagnosticConnector(f.input);
  try { const opening = connector.start(f.options()); f.ready(); assert.equal((await opening).ok, true); f.heartbeat();
    await until(() => f.sent.filter(bytes => bytes[5] === 2).length === 1); f.dispatched(1); f.response('43001000ffffffff', 1);
    await until(() => f.sent.filter(bytes => bytes[5] === 2).length === 2); f.dispatched(2); f.response('8001100000000206', 2);
    await until(() => f.readings.length === 3); f.heartbeat(); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.sent.filter(bytes => bytes[5] === 2).length, 2);
    assert.deepEqual(f.readings.map(item => item.record.kind), ['heartbeat', 'device-type', 'sdo-abort', 'heartbeat']);
    assert.equal(f.readings[1]!.record.value, 0xffffffff); assert.equal(f.readings[1]!.provenance.nativeMonotonicNs, null);
    f.owner.abort(); assert.equal(connector.status().phase, 'retiring'); f.close(); await connector.close();
  } finally { f.close(); await connector.close(); restore(); }
});
test('opening raw receive budget charged before READY, no decoded promotion', async () => {
  const f = fixture(), restore = fakeSpawn(f), connector = api.createCanDiagnosticConnector(f.input);
  try { const opening = connector.start(f.options()); for (let i = 0; i < 257; i++) f.heartbeat();
    assert.equal((await opening).ok, false); assert.equal(connector.status().rawFrames, 257); assert.equal(f.readings.length, 0);
    f.close(); await connector.close();
  } finally { f.close(); await connector.close(); restore(); }
});
test('private pipe nonce/sequence/reserved bytes and partial EOF are rejected', () => {
  const nonce = Buffer.alloc(16, 3), record = api.encodeCanPortRecord(4, nonce, 1, 1, Buffer.alloc(96));
  assert.equal(api.parseCanPortRecord(record, nonce, 1, 1).kind, 4);
  for (const offset of [0, 4, 6, 8, 24, 28, 80]) { const changed = Buffer.from(record); changed[offset] = (changed[offset]! + 1) & 255;
    assert.throws(() => api.parseCanPortRecord(changed, nonce, 1, 1)); }
  assert.throws(() => api.parseCanPortRecord(record.subarray(0, 127), nonce, 1, 1));
});
test('malformed FRAME is charged before payload interpretation', async () => {
  const f = fixture(), restore = fakeSpawn(f), connector = api.createCanDiagnosticConnector(f.input);
  try { const opening = connector.start(f.options()); f.ready(); await opening;
    const configuration = f.sent[0]!, payload = framePayload(0x701, '7f', 1); payload.writeUInt32LE(15, 28);
    f.child.stdout.emit('data', api.encodeCanPortRecord(5, configuration.subarray(8, 24), configuration.readUInt32LE(24), 2, payload));
    assert.equal(connector.status().rawFrames, 1); assert.equal(connector.status().rawBytes, 16); assert.equal(f.readings.length, 0);
    f.close(); await connector.close();
  } finally { f.close(); await connector.close(); restore(); }
});
test('a completed SDO reply cannot replay while its raw write is still held', async () => {
  const f = fixture(), restore = fakeSpawn(f), connector = api.createCanDiagnosticConnector(f.input);
  try { const opening=connector.start(f.options());f.ready();await opening;f.holdWrites();f.heartbeat();
    await until(()=>f.sent.filter(bytes=>bytes[5]===2).length===1);f.dispatched(1);f.response('43001000ffffffff',1);
    f.response('43001000ffffffff',1);
    assert.equal(f.readings.filter(item=>item.record.kind==='device-type').length,1);assert.equal(connector.status().phase,'retiring');
    f.close();f.settleWrites();await connector.close();
  } finally {f.settleWrites();f.close();await connector.close();restore();}
});
test('grant cannot extend original caller bound through a held read', async () => {
  const f=fixture(),restore=fakeSpawn(f);let requested=0;
  const connector=api.createCanDiagnosticConnector({...f.input,authorize:request=>{requested=request.deadline;return{request,signal:f.grant.signal,expiresAt:request.deadline+10000};}});
  try {const deadline=now()+200,opening=connector.start({...f.options(),deadline});f.ready();assert.ok((await opening).ok);f.heartbeat();
    await until(()=>f.sent.some(bytes=>bytes[5]===2));const read=f.sent.find(bytes=>bytes[5]===2)!;assert.equal(requested,deadline);
    assert.ok(read.readBigUInt64LE(40)<=200000000n);
    await until(()=>connector.status().phase==='retiring');f.dispatched(1);f.response('43001000ffffffff',1);
    assert.equal(f.sent.filter(bytes=>bytes[5]===2).length,1);assert.equal(f.readings.filter(item=>item.record.kind==='device-type').length,0);
    f.close();await connector.close();
  }finally{f.close();await connector.close();restore();}
});
test('revoke during reading callback prevents fresh dispatch from that history', async () => {
  const f=fixture(),restore=fakeSpawn(f),connector=api.createCanDiagnosticConnector({...f.input,onReading:reading=>{f.readings.push(reading);f.grant.abort();}});
  try {const opening=connector.start(f.options());f.ready();await opening;f.heartbeat();
    assert.equal(f.sent.filter(bytes=>bytes[5]===2).length,0);assert.equal(connector.status().phase,'retiring');f.close();await connector.close();
  }finally{f.close();await connector.close();restore();}
});
test('spawn reentrant stop still owns returned child and sends no configuration', async () => {
  const f=fixture(),connector=api.createCanDiagnosticConnector(f.input);
  mock.method(childProcess,'spawn',()=>{void connector.stop();return f.child;});
  try{assert.equal((await connector.start(f.options())).ok,false);assert.equal(f.sent.length,0);assert.equal(connector.status().nativeChildren,1);
    f.close();await connector.close();assert.equal(connector.status().nativeChildren,0);
  }finally{f.close();await connector.close();mock.restoreAll();}
});
test('one failed raw write does not abandon the independent held end leg', async () => {
  const f=fixture(),restore=fakeSpawn(f),connector=api.createCanDiagnosticConnector(f.input);f.holdWrites();
  f.child.stdin.end=((callback:()=>void)=>{f.held.push(callback);return f.child.stdin;}) as typeof f.child.stdin.end;
  try{const opening=connector.start(f.options());f.held.shift()!(new Error('owned write failure'));assert.equal((await opening).ok,false);
    f.close();let settled=false;const closed=connector.close().then(()=>{settled=true;});await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(settled,false);assert.equal(connector.status().rawWrites,1);f.settleWrites();await closed;
  }finally{f.settleWrites();f.close();await connector.close();restore();}
});
test('stopped heartbeat does not admit reads, stale history retires original session', async () => {
  const f=fixture(),restore=fakeSpawn(f),connector=api.createCanDiagnosticConnector(f.input);
  try{const opening=connector.start({...f.options(),deadline:now()+2500});f.ready();assert.ok((await opening).ok);f.heartbeat(4);
    assert.equal(f.sent.filter(bytes=>bytes[5]===2).length,0);
    await new Promise(resolve=>setTimeout(resolve,1050));assert.equal(connector.status().reason,'heartbeat-stale');
    f.heartbeat(127);assert.equal(f.sent.filter(bytes=>bytes[5]===2).length,0);assert.equal(f.readings.length,1);
    f.close();await connector.close();
  }finally{f.close();await connector.close();restore();}
});
