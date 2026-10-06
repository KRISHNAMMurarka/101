import assert from 'node:assert/strict';
import test from 'node:test';
import { pointerSourceDescriptor } from '@101/connect';
const api = await import('./connection-task.ts').catch(() => undefined);
test('connection task is inert and never approves output from metadata or an invitation', () => {
  assert.ok(api, 'A real owner-scoped SDK connection task is required');
  let clocks = 0;
  const task = api.createConnectionTask({ role: 'receiver', now: () => { clocks++; return 1000; }, wallNow: () => 1000 });
  assert.equal(clocks, 0); assert.equal(task.allowOutput(), false); assert.equal(task.confirm(), false);
  assert.equal(task.snapshot().active, false); assert.equal(task.snapshot().held, false); task.close();
});
test('current typed resource compatibility uses the actual SDK profile, never a friendly device label', () => {
  assert.ok(api); const source = pointerSourceDescriptor('browser-pointer-events');
  assert.ok(api.compatiblePointerDescriptor(source));
  assert.equal(api.compatiblePointerDescriptor({ ...source, capabilities: [] }), false);
  assert.equal(api.compatiblePointerDescriptor({ ...source, capabilities: source.capabilities.map(value => ({ ...value, value: { type: 'boolean' } })) }), false);
});
test('an unsupported native peer reports unavailable without creating an identity or authority', async () => {
  assert.ok(api); let identities = 0;
  const task = api.createConnectionTask({ role: 'receiver', now: () => 1000, wallNow: () => 1000, createIdentity: async () => { identities++; throw Error('no'); } });
  try { assert.equal(await task.beginReceive(), false); assert.equal(identities, 0); assert.equal(task.snapshot().phase, 'unsupported'); assert.equal(task.snapshot().active, false); } finally { task.close(); }
});

test('cancellation during a held identity keeps its actual reservation and cannot install a late connection', async () => {
  assert.ok(api);
  let finish!: (identity: import('@101/connect').EndpointIdentity) => void;
  let creates = 0;
  const task = api.createConnectionTask({ role: 'receiver', now: () => 1000, wallNow: () => 1000,
    createPeer: () => { creates++; throw Error('not reached'); }, createIdentity: () => new Promise(resolve => { finish = resolve; }) });
  const pending = task.beginReceive(); task.cancelCandidate();
  assert.equal(task.snapshot().rawPending, 1); assert.equal(task.snapshot().active, false);
  const { createEphemeralWebIdentity } = await import('@101/connect'); finish(await createEphemeralWebIdentity());
  assert.equal(await pending, false); assert.equal(creates, 0); assert.equal(task.snapshot().rawPending, 0);
  assert.equal(task.allowOutput(), false); task.close();
});
test('a reentrant clock cancellation cannot start identity work or native negotiation', async () => {
  assert.ok(api); let identities = 0;
  const task: ReturnType<NonNullable<typeof api>['createConnectionTask']> = api.createConnectionTask({ role: 'receiver', now: () => { task.cancelCandidate(); return 1000; }, wallNow: () => 1000,
    createPeer: () => { throw Error('not reached'); }, createIdentity: async () => { identities++; throw Error('not reached'); } });
  assert.equal(await task.beginReceive(), false); assert.equal(identities, 0); task.close();
});
test('raw identity capacity stays bounded when cancelled operations never settle', async () => {
  assert.ok(api); let identities = 0;
  const task = api.createConnectionTask({ role: 'receiver', now: () => 1000, wallNow: () => 1000,
    createPeer: () => { throw Error('not reached'); }, createIdentity: () => { identities++; return new Promise(() => {}); } });
  void task.beginReceive(); task.cancelCandidate(); void task.beginReceive(); task.cancelCandidate();
  assert.equal(await task.beginReceive(), false); assert.equal(identities, 2); assert.equal(task.snapshot().rawPending, 2);
  task.close(); assert.equal(task.snapshot().rawPending, 2);
});
test('declined and malformed codes are inert and opaque codes accept only the fixed application scope', () => {
  assert.ok(api); const task = api.createConnectionTask({ role: 'source', now: () => 1000, wallNow: () => 1000 });
  assert.equal(task.review('https://unrelated.invalid/'), false); assert.equal(task.allowSource(), false);
  assert.equal(task.snapshot().rawPending, 0); assert.equal(task.snapshot().active, false); task.close();
});

test('an invalid wall clock retires an invitation instead of restoring it after the clock recovers', async () => {
  assert.ok(api); let wall = 1000;
  const task = api.createConnectionTask({ role: 'receiver', now: () => 1000, wallNow: () => wall, createPeer: () => { throw Error('inert'); } });
  try { assert.equal(await task.beginReceive(), true); wall = NaN; task.tick();
    assert.equal(task.snapshot().candidate, false); wall = 1000; task.tick(); assert.equal(task.snapshot().code, '');
  } finally { task.close(); }
});

test('expiry during held identity creation never restores a candidate or grants', async () => {
  assert.ok(api); let wall = 1000; let finish!: (identity: import('@101/connect').EndpointIdentity) => void;
  const receiver = api.createConnectionTask({ role: 'receiver', now: () => 1000, wallNow: () => wall,
    createPeer: () => { throw Error('not reached'); }, createIdentity: () => new Promise(resolve => { finish = resolve; }) });
  const pending = receiver.beginReceive(); wall = 301001;
  finish(await (await import('@101/connect')).createEphemeralWebIdentity());
  assert.equal(await pending, false); assert.equal(receiver.snapshot().phase, 'expired'); assert.equal(receiver.snapshot().candidate, false);
  assert.equal(receiver.confirm(), false); assert.equal(receiver.allowOutput(), false); receiver.close();
});
test('closed opaque codes reject another app, stale dates, unknown fields and raw descriptions without invoking a port', async () => {
  assert.ok(api); let opens = 0;
  const receiver = api.createConnectionTask({ role: 'receiver', now: () => 1000, wallNow: () => 1000, createPeer: () => { opens++; throw Error('not reached'); } });
  const source = api.createConnectionTask({ role: 'source', now: () => 1000, wallNow: () => 1000, createPeer: () => { opens++; throw Error('not reached'); } });
  try {
    assert.equal(await receiver.beginReceive(), true); const code = receiver.snapshot().code;
    assert.equal(source.review(code), true); source.cancelCandidate();
    const packet = JSON.parse(Buffer.from(code.slice('101-connection-1.'.length), 'base64url').toString());
    for (const mutated of [{...packet, invitation:{...packet.invitation,applicationId:'other-app'}}, {...packet, extra:true},
      {...packet, invitation:{...packet.invitation,expiresAt:999}}, {...packet, payload:'raw-description'}]) {
      assert.equal(source.review('101-connection-1.' + Buffer.from(JSON.stringify(mutated)).toString('base64url')), false);
    }
    assert.equal(source.review(JSON.stringify({type:'offer',sdp:'not an invitation'})), false); assert.equal(opens,0); assert.equal(source.snapshot().active,false);
  } finally { receiver.close(); source.close(); }
});
test('cancelling a real transport with a held native offer closes it and retains the issued reservation until settlement', async () => {
  assert.ok(api); let finish!: (description: RTCSessionDescriptionInit) => void; let closes = 0, offers = 0;
  const port: import('@101/connect').PeerConnectionPort = {
    connectionState:'new', iceGatheringState:'complete', localDescription:null, onconnectionstatechange:null, ondatachannel:null,
    createDataChannel(label, options) { return {label,ordered:options.ordered ?? true,maxPacketLifeTime:null,maxRetransmits:options.maxRetransmits ?? null,
      readyState:'connecting',bufferedAmount:0,binaryType:'arraybuffer',bufferedAmountLowThreshold:0,onmessage:null,onclose:null,onerror:null,send(){},close(){}}; },
    createOffer() { offers++; return new Promise(resolve => { finish = resolve; }); }, createAnswer:async()=>{throw Error('not reached');},
    setLocalDescription:async()=>{},setRemoteDescription:async()=>{},addEventListener(){},removeEventListener(){},getStats:async()=>new Map() as RTCStatsReport,close(){closes++;},
  };
  const receiver = api.createConnectionTask({role:'receiver',now:()=>1000,wallNow:()=>1000,createPeer:()=>port});
  const source = api.createConnectionTask({role:'source',now:()=>1000,wallNow:()=>1000,createPeer:()=>port});
  try {
    assert.equal(await receiver.beginReceive(),true); assert.equal(source.review(receiver.snapshot().code),true);
    const pending = source.beginSend(); while(!offers) await new Promise(resolve=>setImmediate(resolve));
    source.cancelCandidate(); assert.equal(source.snapshot().rawPending,1); assert.equal(source.snapshot().code,''); assert.equal(closes,1);
    finish({type:'offer',sdp:'v=0\r\n'}); assert.equal(await pending,false); assert.equal(source.snapshot().rawPending,0);
    assert.equal(source.allowSource(),false); assert.equal(source.snapshot().active,false);
  } finally { source.close(); receiver.close(); }
});

test('host option accessors cannot alter the immutable role or run during admission', () => {
  assert.ok(api); let reads = 0;
  assert.throws(() => api.createConnectionTask({ role:'receiver',now:()=>1000,wallNow:()=>1000,
    get createPeer() { reads++; return () => { throw Error('not reached'); }; } }), TypeError);
  assert.equal(reads,0);
});

test('stop from the invitation review clock cancels that review before a new attempt exists', async () => {
  assert.ok(api);
  const receiver = api.createConnectionTask({role:'receiver',now:()=>1000,wallNow:()=>1000,createPeer:()=>{throw Error('inert');}});
  const source: ReturnType<NonNullable<typeof api>['createConnectionTask']> = api.createConnectionTask({role:'source',now:()=>1000,wallNow:()=>{source.cancelCandidate();return 1000;}});
  try { await receiver.beginReceive(); assert.equal(source.review(receiver.snapshot().code), false); assert.equal(source.snapshot().candidate,false); }
  finally { source.close(); receiver.close(); }
});
test('close fences a reentrant observer before it can issue another identity operation', async () => {
  assert.ok(api); let identities=0, trigger=false, attempted=false; let pending: Promise<boolean> | undefined;
  const {createEphemeralWebIdentity}=await import('@101/connect');
  const task: ReturnType<NonNullable<typeof api>['createConnectionTask']> = api.createConnectionTask({role:'receiver',now:()=>1000,wallNow:()=>1000,
    createPeer:()=>{throw Error('inert');}, createIdentity:()=>{identities++;return createEphemeralWebIdentity();},
    onChange(){if(trigger&&!attempted){attempted=true;pending=task.beginReceive();}}});
  await task.beginReceive(); trigger=true; task.close(); assert.equal(await pending,false); assert.equal(identities,1); assert.equal(task.snapshot().candidate,false);
});

test('cancellation and stop replace a prior code error with the current recovery status', () => {
  assert.ok(api); const task=api.createConnectionTask({role:'source',now:()=>1000,wallNow:()=>1000});
  assert.equal(task.review('bad'),false); assert.equal(task.snapshot().notice,'invalid');
  task.cancelCandidate(); assert.equal(task.snapshot().notice,undefined); assert.equal(task.snapshot().phase,'stopped');
  task.review('bad'); task.stop(); assert.equal(task.snapshot().notice,undefined); task.close();
});
