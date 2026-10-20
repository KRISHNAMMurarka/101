import assert from 'node:assert/strict';
import test from 'node:test';
import { createEphemeralWebIdentity, parseDeviceDescriptor } from '@101/connect';
import type { PeerConnectionPort, PeerDataChannelPort } from '@101/connect';
import { createReadingsTask } from './readings-task.ts';
import { readingChoices, readingTable } from './readings-schema.ts';

const record = { type: 'record', fields: { step: { type: 'scalar', unit: '1', min: 0, max: 100 },
  ready: { type: 'boolean' }, mode: { type: 'enum', values: ['count-up', 'count-down'] } }, optional: ['ready'] };
const descriptor = { schemaVersion: 1, id: 'owned-page-readings', label: 'Page readings', revision: 1,
  adapter: { id: 'owned:page-readings', version: '1' }, runtime: { platform: 'application-software' }, capabilities: [
    { id: 'row', semantic: 'owned:reading', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
      value: record, delivery: { mode: 'latest', maxHz: 4, maxAgeMs: 1000 } },
    { id: 'rows', semantic: 'owned:reading-table', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
      value: { type: 'array', items: record, minItems: 1, maxItems: 8 }, delivery: { mode: 'latest', maxHz: 4, maxAgeMs: 1000 } },
  ] };
const capability = (index = 0) => parseDeviceDescriptor(descriptor).capabilities[index]!;

test('record display preserves declared field order, enum values and optional absence', () => {
  const table = readingTable(capability(), { step: 42, mode: 'count-down' });
  assert.ok(table); assert.deepEqual(table.columns.map(column => column.key), ['step', 'ready', 'mode']);
  assert.deepEqual(table.rows, [['42', 'Not supplied', 'count-down']]);
  assert.equal(Object.isFrozen(table.rows[0]), true);
});

test('array display retains distinct actual records rather than flattening the last row', () => {
  const table = readingTable(capability(1), [{ step: 42, ready: true, mode: 'count-up' }, { step: 7, ready: false, mode: 'count-down' }]);
  assert.ok(table); assert.deepEqual(table.rows, [['42', 'On', 'count-up'], ['7', 'Off', 'count-down']]);
  assert.equal(readingTable(capability(1), []), undefined);
  assert.equal(readingTable(capability(1), Array.from({ length: 9 }, () => ({ step: 1, mode: 'count-up' }))), undefined);
});

test('capability eligibility rejects operations and formats the table cannot safely display', () => {
  const base = descriptor.capabilities[0]!;
  for (const change of [
    { kind: 'command', permissions: ['invoke'], delivery: { mode: 'reliable', maxAgeMs: 1000 } },
    { kind: 'property', permissions: ['read'] }, { schemaVersion: 2 },
    { schemaVersion: 2, kind: 'event', delivery: { mode: 'reliable', maxAgeMs: 1000 }, value: { type: 'text', maxLength: 32 } },
    { value: { type: 'record', fields: { nested: record } } },
    { value: { type: 'array', items: record, minItems: 1, maxItems: 9 } },
  ]) assert.equal(readingChoices({ ...descriptor, capabilities: [{ ...base, ...change }] })[0]?.supported, false);
  assert.throws(() => readingChoices({ ...descriptor, capabilities: [{ ...base, value: { type: 'text', maxLength: 32 } }] }),
    { code: 'input-schema-version' }, 'a malformed raw v1 text declaration is refused by the genuine public parser');
  assert.deepEqual(readingChoices(descriptor).map(choice => [choice.id, choice.shape, choice.supported]),
    [['row', 'record', true], ['rows', 'table', true]]);
});

test('scalar units come from the selected schema and invalid values cannot become cells', () => {
  const input = parseDeviceDescriptor({ ...descriptor, capabilities: [{ ...descriptor.capabilities[0], value: {
    type: 'record', fields: { temperature: { type: 'scalar', unit: 'Cel', min: -20, max: 50 } } } }] }).capabilities[0]!;
  const table = readingTable(input, { temperature: 18 }); assert.ok(table);
  assert.equal(table.columns[0]?.unit, 'Cel'); assert.deepEqual(table.rows, [['18']]);
  assert.equal(readingChoices({ ...descriptor, capabilities: [input] })[0]?.columns[0]?.unit, 'Cel', 'unit is available for consent before any value arrives');
  assert.equal(readingChoices(descriptor)[0]?.columns.find(column => column.key === 'ready')?.optional, true);
  for (const value of [{ temperature: 51 }, { temperature: Number.NaN }, { temperature: 18, extra: true }])
    assert.equal(readingTable(input, value), undefined);
});

test('descriptor and value accessors are rejected without invoking their getters', () => {
  let calls = 0;
  assert.throws(() => readingChoices({ ...descriptor, get capabilities() { calls++; return descriptor.capabilities; } }));
  assert.equal(readingTable(capability(), { get step() { calls++; return 42; }, mode: 'count-up' }), undefined);
  assert.equal(calls, 0);
});

test('display snapshots cannot change when the caller mutates its original batch', () => {
  const values = [{ step: 42, ready: true, mode: 'count-up' }];
  const table = readingTable(capability(1), values); assert.ok(table);
  values[0]!.step = 3; values.push({ step: 8, ready: false, mode: 'count-down' });
  assert.deepEqual(table.rows, [['42', 'On', 'count-up']]); assert.equal(Object.isFrozen(table), true);
});

const scope = { now: () => 1000, wallNow: () => 10000 };
test('arrival and an unissued review acquire no identity, route or permission', async () => {
  let identities = 0, peers = 0;
  const task = createReadingsTask({ ...scope, role: 'receiver', createIdentity: async () => { identities++; return createEphemeralWebIdentity(); },
    createPeer: () => { peers++; throw Error('arrival must remain inert'); } });
  try {
    assert.equal(task.allow({ kind: 'reading-review' }), false); assert.equal(task.confirm('a'.repeat(64)), false);
    assert.equal(task.snapshot().rows.length, 0); assert.equal(task.snapshot().rawPending, 0);
    assert.equal(task.snapshot().owned.routes, 0); assert.equal(identities, 0); assert.equal(peers, 0);
  } finally { await task.close(); }
});

test('an invalid invitation never constructs a native peer or creates source permission', async () => {
  let peers = 0;
  const task = createReadingsTask({ ...scope, role: 'source', createPeer: () => { peers++; throw Error('invalid must remain inert'); } });
  try { assert.equal(task.review('not an invitation'), false); assert.equal(await task.offer(), false);
    assert.equal(peers, 0); assert.equal(task.snapshot().permissionExpiresAt, undefined);
  } finally { await task.close(); }
});

test('stopped identity work stays reserved until its actual returned promise settles', async () => {
  const identity = await createEphemeralWebIdentity(); let release!: () => void, enter!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  const task = createReadingsTask({ ...scope, role: 'receiver', createIdentity: async () => { enter(); await held; return identity; } });
  const inviting = task.invite(); await entered; task.stop();
  let closed = false; const closing = task.close().then(() => { closed = true; });
  try { await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    assert.ok(task.snapshot().rawPending > 0); assert.equal(await task.invite(), false);
  } finally { release(); await inviting; await closing; }
  assert.equal(task.snapshot().rawPending, 0); assert.equal(task.snapshot().code, '');
});

test('clock stop reentry before identity dispatch leaves no provisional invitation', async () => {
  let stopping = false, identities = 0;
  const task = createReadingsTask({ ...scope, role: 'receiver', now: () => { if (stopping) task.stop(); return 1000; },
    createIdentity: async () => { identities++; return createEphemeralWebIdentity(); } });
  try { stopping = true; assert.equal(await task.invite(), false); assert.equal(identities, 0);
    assert.equal(task.snapshot().code, ''); assert.equal(task.snapshot().owned.routes, 0);
  } finally { await task.close(); }
});

// Cooperative SDP/channel ports below preserve the real public transport, identity,
// authentication, binder and runtime path. They are not native RTC or physical evidence.
class Channel implements PeerDataChannelPort {
  readyState = 'open'; bufferedAmount = 0; binaryType = 'arraybuffer'; bufferedAmountLowThreshold = 0;
  readonly label: string; private readonly queue: (() => void)[];
  readonly ordered: boolean; readonly maxRetransmits: number | null; readonly maxPacketLifeTime: number | null;
  onmessage: PeerDataChannelPort['onmessage'] = null; onclose: PeerDataChannelPort['onclose'] = null;
  onerror: PeerDataChannelPort['onerror'] = null; target?: Channel;
  constructor(label: string, options: RTCDataChannelInit, queue: (() => void)[]) {
    this.label = label; this.queue = queue;
    this.ordered = options.ordered ?? true; this.maxRetransmits = options.maxRetransmits ?? null;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
  }
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
    if (this.queue.length >= 512) throw Error('owned fixture queue exhausted');
    const copied = typeof data === 'string' ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer : data.slice(0);
    this.queue.push(() => { if (this.target?.readyState === 'open') this.target.onmessage?.({ data: copied }); });
  }
  close() { this.readyState = 'closed'; this.onclose?.({}); }
}
const sdp = (byte: string) => `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\na=sctp-port:5000\r\n`;
class Port implements PeerConnectionPort {
  connectionState = 'new'; iceGatheringState = 'complete'; localDescription: { type: RTCSdpType; sdp: string } | null = null;
  onconnectionstatechange: PeerConnectionPort['onconnectionstatechange'] = null; ondatachannel: PeerConnectionPort['ondatachannel'] = null;
  channels = new Map<string, Channel>(); remoteHold?: Promise<void>; remoteEntered?: () => void; closeCalls = 0;
  private readonly queue: (() => void)[];
  constructor(queue: (() => void)[]) { this.queue = queue; }
  createDataChannel(label: string, options: RTCDataChannelInit) { const channel = new Channel(label, options, this.queue); this.channels.set(label, channel); return channel; }
  async createOffer() { return { type: 'offer' as const, sdp: sdp('11') }; }
  async createAnswer() { return { type: 'answer' as const, sdp: sdp('22') }; }
  async setLocalDescription(input: RTCSessionDescriptionInit) { this.localDescription = { type: input.type, sdp: input.sdp! }; }
  async setRemoteDescription() { this.remoteEntered?.(); await this.remoteHold; }
  addEventListener() {} removeEventListener() {}
  async getStats() { return new Map() as unknown as RTCStatsReport; }
  close() { this.connectionState = 'closed'; this.closeCalls++; }
}
function connect(source: Port, receiver: Port, queue: (() => void)[]) {
  for (const [label, channel] of source.channels) {
    const remote = new Channel(label, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits ?? undefined }, queue);
    remote.target = channel; channel.target = remote; receiver.channels.set(label, remote); receiver.ondatachannel?.({ channel: remote });
  }
  for (const port of [source, receiver]) { port.connectionState = 'connected'; port.onconnectionstatechange?.({}); }
}
type Options = Parameters<typeof createReadingsTask>[0];
async function pair(extra: Partial<Options> = {}) {
  const clock = { at: 1000 }, queue: (() => void)[] = [], sourcePort = new Port(queue), receiverPort = new Port(queue);
  const source = createReadingsTask({ role: 'source', wallNow: scope.wallNow, now: () => clock.at, createPeer: () => sourcePort });
  const receiver = createReadingsTask({ role: 'receiver', wallNow: scope.wallNow, now: () => clock.at, createPeer: () => receiverPort, ...extra });
  async function pump(until: () => boolean) {
    for (let turn = 0; turn < 2000 && !until(); turn++) {
      source.tick(); receiver.tick(); while (queue.length) queue.shift()!(); await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(until(), 'owned public task reached the required phase');
  }
  async function close() {
    source.stop(); receiver.stop(); await Promise.all([source.close(), receiver.close()]);
    while (queue.length) queue.shift()!();
    assert.equal(source.snapshot().rawPending, 0); assert.equal(receiver.snapshot().rawPending, 0);
    assert.equal(source.snapshot().owned.routes, 0); assert.equal(receiver.snapshot().owned.registrations, 0);
  }
  try {
    assert.equal(await receiver.invite(), true); assert.equal(source.review(receiver.snapshot().code), true);
    assert.equal(await source.offer(), true); assert.equal(await receiver.accept(source.snapshot().code), true);
    assert.equal(await source.accept(receiver.snapshot().code), true); connect(sourcePort, receiverPort, queue);
    await pump(() => source.snapshot().phase === 'comparison' && receiver.snapshot().phase === 'comparison' &&
      !!source.snapshot().comparison && !!receiver.snapshot().comparison);
    const digest = source.snapshot().comparison!; assert.match(digest, /^[0-9a-f]{64}$/); assert.equal(receiver.snapshot().comparison, digest);
    assert.equal(source.confirm(digest.slice(0, 16)), false); assert.equal(receiver.confirm('f'.repeat(64)), false);
    assert.equal(source.confirm(digest), true); assert.equal(receiver.confirm(digest), true);
    await pump(() => receiver.snapshot().resources.some(value => value.supported) && receiver.snapshot().clockReady);
    return { source, receiver, sourcePort, receiverPort, clock, pump, close };
  } catch (error) { await close(); throw error; }
}
function selectBoth(paired: Awaited<ReturnType<typeof pair>>, shape: 'record' | 'table') {
  const choice = paired.receiver.snapshot().resources.find(value => value.shape === shape && value.supported); assert.ok(choice);
  const sending = paired.source.select(choice.id), display = paired.receiver.select(choice.id); assert.ok(sending); assert.ok(display);
  return { sending, display };
}

test('actual authenticated record delivery requires separate source and display permissions', async () => {
  const paired = await pair();
  try {
    const { sending, display } = selectBoth(paired, 'record');
    assert.equal(paired.source.setValue({ step: 42, ready: true, mode: 'count-up' }), true);
    assert.equal(paired.receiver.snapshot().rows.length, 0); assert.equal(paired.source.allow(sending), true);
    for (let turn = 0; turn < 8; turn++) { paired.source.tick(); paired.receiver.tick(); }
    assert.equal(paired.receiver.snapshot().rows.length, 0, 'source consent alone cannot write this display');
    assert.equal(paired.receiver.allow(display), true);
    await paired.pump(() => paired.receiver.snapshot().rows.length === 1);
    assert.deepEqual(paired.receiver.snapshot().rows, [['42', 'On', 'count-up']]);
    assert.equal(paired.receiver.snapshot().phase, 'active');
  } finally { await paired.close(); }
});

test('display permission alone never causes an unapproved source to publish', async () => {
  const paired = await pair();
  try { const { display } = selectBoth(paired, 'record');
    assert.equal(paired.source.setValue({ step: 42, ready: true, mode: 'count-up' }), true); assert.equal(paired.receiver.allow(display), true);
    await paired.pump(() => paired.receiver.snapshot().reason === 'incompatible');
    assert.equal(paired.receiver.snapshot().rows.length, 0); assert.equal(paired.source.snapshot().permissionExpiresAt, undefined);
  } finally { await paired.close(); }
});

test('a real structured array reaches the table with optional absence intact', async () => {
  const paired = await pair();
  try { const { sending, display } = selectBoth(paired, 'table');
    assert.equal(paired.source.setValue([{ step: 42, ready: false, mode: 'count-up' }, { step: 7, mode: 'count-down' }]), true);
    assert.equal(paired.source.allow(sending), true); assert.equal(paired.receiver.allow(display), true);
    await paired.pump(() => paired.receiver.snapshot().rows.length === 2);
    assert.deepEqual(paired.receiver.snapshot().rows, [['42', 'Off', 'count-up'], ['7', 'Not supplied', 'count-down']]);
  } finally { await paired.close(); }
});

test('cloned and foreign review handles cannot grant display authority', async () => {
  const paired = await pair();
  try { const { sending, display } = selectBoth(paired, 'record');
    assert.equal(paired.receiver.allow({ ...display }), false); assert.equal(paired.receiver.allow(sending), false);
    assert.equal(paired.source.allow(display), false); assert.equal(paired.receiver.snapshot().permissionExpiresAt, undefined);
  } finally { await paired.close(); }
});

test('Stop clears observed rows and an old resource review cannot restart the route', async () => {
  let released = 0;
  const paired = await pair({ release() { released++; } });
  try { const { sending, display } = selectBoth(paired, 'record');
    paired.source.setValue({ step: 42, mode: 'count-up' }); paired.source.allow(sending); paired.receiver.allow(display);
    await paired.pump(() => paired.receiver.snapshot().rows.length === 1); paired.receiver.stop();
    assert.equal(paired.receiver.snapshot().rows.length, 0); assert.ok(released > 0);
    assert.equal(paired.receiver.allow(display), false); assert.equal(paired.receiver.snapshot().owned.routes, 0);
  } finally { await paired.close(); }
});

test('tick and repeated consent cannot extend the original quiet resource deadline', async () => {
  const paired = await pair();
  try { const { sending, display } = selectBoth(paired, 'record');
    paired.source.setValue({ step: 42, mode: 'count-up' }); paired.source.allow(sending); paired.receiver.allow(display);
    await paired.pump(() => paired.receiver.snapshot().rows.length === 1);
    const deadline = paired.receiver.snapshot().permissionExpiresAt; assert.ok(deadline);
    paired.clock.at += 500; paired.receiver.allow(display); paired.receiver.tick();
    assert.equal(paired.receiver.snapshot().permissionExpiresAt, deadline);
    paired.clock.at = deadline; paired.receiver.tick(); paired.source.tick();
    assert.equal(paired.receiver.snapshot().rows.length, 0); assert.equal(paired.receiver.allow(display), false);
  } finally { await paired.close(); }
});

test('an actually pending sink return retains close ownership after logical Stop', async () => {
  let entered!: () => void, release!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const paired = await pair({ apply() { entered(); return held; } });
  let closed = false;
  try { const { sending, display } = selectBoth(paired, 'record');
    paired.source.setValue({ step: 42, mode: 'count-up' }); paired.source.allow(sending); paired.receiver.allow(display);
    await paired.pump(() => paired.receiver.snapshot().rawPending > 0); await called;
    paired.receiver.stop(); const closing = paired.receiver.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    assert.ok(paired.receiver.snapshot().rawPending > 0); assert.equal(paired.receiver.snapshot().rows.length, 0);
    release(); await closing; assert.equal(paired.receiver.snapshot().rawPending, 0);
  } finally { release(); await paired.close(); }
});

test('peer loss releases rows and later source values cannot revive the display', async () => {
  const paired = await pair();
  try { const { sending, display } = selectBoth(paired, 'record');
    paired.source.setValue({ step: 42, mode: 'count-up' }); paired.source.allow(sending); paired.receiver.allow(display);
    await paired.pump(() => paired.receiver.snapshot().rows.length === 1);
    paired.receiverPort.connectionState = 'disconnected'; paired.receiverPort.onconnectionstatechange?.({}); paired.receiver.tick();
    assert.equal(paired.receiver.snapshot().rows.length, 0);
    paired.source.setValue({ step: 7, mode: 'count-down' }); paired.clock.at += 300; paired.source.tick(); paired.receiver.tick();
    assert.equal(paired.receiver.snapshot().rows.length, 0); assert.equal(paired.receiver.allow(display), false);
  } finally { await paired.close(); }
});

test('invalid form values are refused without replacing the current valid displayed row', async () => {
  const paired = await pair();
  try { const { sending, display } = selectBoth(paired, 'record');
    paired.source.setValue({ step: 42, ready: true, mode: 'count-up' }); paired.source.allow(sending); paired.receiver.allow(display);
    await paired.pump(() => paired.receiver.snapshot().rows.length === 1);
    assert.equal(paired.source.setValue({ step: 1000, mode: 'count-up' }), false);
    assert.equal(paired.source.setValue({ step: 1, mode: 'undeclared-choice' }), false);
    paired.clock.at += 300; paired.source.tick(); paired.receiver.tick();
    assert.deepEqual(paired.receiver.snapshot().rows, [['42', 'On', 'count-up']]);
  } finally { await paired.close(); }
});

test('backward source time fences its permission and current peer delivery', async () => {
  const paired = await pair();
  try { const { sending, display } = selectBoth(paired, 'record');
    paired.source.setValue({ step: 42, mode: 'count-up' }); paired.source.allow(sending); paired.receiver.allow(display);
    await paired.pump(() => paired.receiver.snapshot().rows.length === 1);
    paired.clock.at = 999; paired.source.tick(); paired.receiver.tick();
    assert.equal(paired.source.snapshot().permissionExpiresAt, undefined); assert.equal(paired.receiver.snapshot().rows.length, 0);
    assert.equal(paired.source.allow(sending), false);
  } finally { await paired.close(); }
});

test('Stop during a genuine transport description retains its raw promise until settlement', async () => {
  const queue: (() => void)[] = [], sourcePort = new Port(queue), receiverPort = new Port(queue);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  receiverPort.remoteEntered = enter; receiverPort.remoteHold = new Promise<void>(resolve => { release = resolve; });
  const source = createReadingsTask({ ...scope, role: 'source', createPeer: () => sourcePort });
  const receiver = createReadingsTask({ ...scope, role: 'receiver', createPeer: () => receiverPort });
  let closed = false;
  try {
    assert.equal(await receiver.invite(), true); assert.equal(source.review(receiver.snapshot().code), true);
    assert.equal(await source.offer(), true); const accepting = receiver.accept(source.snapshot().code); await entered;
    receiver.stop(); const closing = receiver.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    assert.ok(receiver.snapshot().rawPending > 0); assert.equal(receiver.snapshot().code, '');
    release(); await accepting; await closing; assert.equal(receiver.snapshot().rawPending, 0);
  } finally { release(); await Promise.all([source.close(), receiver.close()]); }
});

test('Stop inside the actual native peer factory closes its late returned port before settlement', async () => {
  const queue: (() => void)[] = [], sourcePort = new Port(queue), receiverPort = new Port(queue);
  let reserved = false;
  const source = createReadingsTask({ ...scope, role: 'source', createPeer: () => sourcePort });
  const receiver = createReadingsTask({ ...scope, role: 'receiver', createPeer: () => {
    reserved = receiver.snapshot().rawPending > 0; receiver.stop(); return receiverPort;
  } });
  try {
    assert.equal(await receiver.invite(), true); assert.equal(source.review(receiver.snapshot().code), true);
    assert.equal(await source.offer(), true); assert.equal(await receiver.accept(source.snapshot().code), false);
    await receiver.close(); assert.equal(reserved, true);
    assert.equal(receiverPort.connectionState, 'closed'); assert.equal(receiverPort.closeCalls, 1);
    assert.equal(receiver.snapshot().rawPending, 0); assert.equal(receiver.snapshot().rows.length, 0);
    assert.equal(receiver.snapshot().owned.routes, 0); assert.equal(receiver.snapshot().code, '');
  } finally { await Promise.all([source.close(), receiver.close()]); }
});

test('setup quota refuses a seventeenth native identity without reviving stopped grants', async () => {
  let calls = 0;
  const receiver = createReadingsTask({ ...scope, role: 'receiver', createIdentity: async () => { calls++; return createEphemeralWebIdentity(); } });
  try {
    for (let attempt = 0; attempt < 16; attempt++) {
      assert.equal(await receiver.invite(), true); receiver.stop(); await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(await receiver.invite(), false); assert.equal(calls, 16);
    assert.equal(receiver.snapshot().permissionExpiresAt, undefined); assert.equal(receiver.snapshot().owned.routes, 0);
  } finally { await receiver.close(); }
});

test('native already aborted owner cannot start identity through an own aborted shadow', async () => {
  const identity = await createEphemeralWebIdentity(), owner = new AbortController(); owner.abort();
  assert.equal(Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(owner.signal), true);
  Object.defineProperty(owner.signal, 'aborted', { value: false }); let starts = 0;
  const task = createReadingsTask({ ...scope, role: 'receiver', owner: owner.signal, createIdentity: async () => { starts++; return identity; } });
  try { const admitted = await task.invite(); assert.equal(starts, 0, 'Actual expired owner must acquire no new identity'); assert.equal(admitted, false); }
  finally { await task.close(); }
});

test('actual release close reentry observes the same prepublished raw close barrier', async () => {
  const identity = await createEphemeralWebIdentity(); let nested: Promise<void> | undefined, reentered = false, releases = 0;
  const task: ReturnType<typeof createReadingsTask> = createReadingsTask({ ...scope, role: 'receiver', createIdentity: async () => identity,
    release() { releases++; assert.equal(task.snapshot().code, ''); if (!reentered) { reentered = true; nested = task.close(); } } });
  assert.equal(await task.invite(), true); assert.ok(task.snapshot().code);
  const closing = task.close();
  try { assert.equal(nested, closing, 'Release must see the one actual close reservation'); assert.equal(releases, 1); }
  finally { await closing; await nested; }
});

test('native abort ignores shadow listeners and reentrant Stop releases the issued task once', async () => {
  const identity = await createEphemeralWebIdentity(), owner = new AbortController(); let shadows = 0, releases = 0, starts = 0;
  Object.defineProperties(owner.signal, { aborted: { value: false },
    addEventListener: { value: () => { shadows++; } }, removeEventListener: { value: () => { shadows++; } } });
  const task: ReturnType<typeof createReadingsTask> = createReadingsTask({ ...scope, role: 'receiver', owner: owner.signal,
    createIdentity: async () => { starts++; return identity; }, release() { releases++; task.stop(); } });
  try {
    assert.equal(await task.invite(), true); assert.ok(task.snapshot().code); owner.abort(); await task.close();
    assert.equal(shadows, 0); assert.equal(releases, 1); assert.equal(task.snapshot().code, '');
    assert.equal(task.snapshot().phase, 'closed'); assert.equal(task.snapshot().rawPending, 0);
    assert.equal(await task.invite(), false); assert.equal(starts, 1);
  } finally { await task.close(); }
});


// Two real public task pairs; cooperative ports supply no browser DTLS or OS-user claim.
test('an admitted display review cannot authorize a different live readings session', async t => {
  const pairs: Awaited<ReturnType<typeof pair>>[] = [];
  const effectsA: (readonly (readonly string[])[])[] = [], effectsB: (readonly (readonly string[])[])[] = [];
  try {
    const a = await pair({ apply(table, context) { if (context.isCurrent() && !context.signal.aborted) effectsA.push(table.rows); } }); pairs.push(a);
    const b = await pair({ apply(table, context) { if (context.isCurrent() && !context.signal.aborted) effectsB.push(table.rows); } }); pairs.push(b);
    const { decodeReceiverInvitation } = await import('@101/connect');
    const invitations = [a, b].map(value => {
      const code = value.receiver.snapshot().code, prefix = '101-readings-1.';
      assert.ok(code.startsWith(prefix));
      const packet = JSON.parse(Buffer.from(code.slice(prefix.length), 'base64url').toString('utf8'));
      return decodeReceiverInvitation(JSON.stringify(packet.invitation), scope.wallNow());
    });
    assert.notEqual(invitations[0]!.sessionId, invitations[1]!.sessionId);
    assert.notEqual(invitations[0]!.epoch, invitations[1]!.epoch);
    const admittedA = selectBoth(a, 'record'), ownB = selectBoth(b, 'record');
    assert.equal(a.source.setValue({ step: 42, ready: true, mode: 'count-up' }), true);
    assert.equal(a.source.allow(admittedA.sending), true); assert.equal(a.receiver.allow(admittedA.display), true);
    await a.pump(() => a.receiver.snapshot().rows[0]?.[0] === '42');
    assert.deepEqual(a.receiver.snapshot().rows, [['42', 'On', 'count-up']]);
    assert.ok(effectsA.some(rows => rows[0]?.[0] === '42'), 'The exported review genuinely admitted an actual A display');
    const beforeA = a.receiver.snapshot();
    assert.equal(b.source.setValue({ step: 77, ready: false, mode: 'count-down' }), true);
    assert.equal(b.source.allow(ownB.sending), true);
    assert.equal(b.receiver.allow(admittedA.display), false);
    assert.equal(b.receiver.snapshot().permissionExpiresAt, undefined);
    assert.equal(b.receiver.snapshot().owned.registrations, 0); assert.equal(b.receiver.snapshot().owned.routes, 0);
    assert.deepEqual(b.receiver.snapshot().rows, []); assert.deepEqual(effectsB, []);
    assert.deepEqual(a.receiver.snapshot().owned, beforeA.owned);
    assert.equal(a.receiver.snapshot().permissionExpiresAt, beforeA.permissionExpiresAt);
    assert.deepEqual(a.receiver.snapshot().rows, [['42', 'On', 'count-up']]);
    a.clock.at += 300;
    assert.equal(a.source.setValue({ step: 43, ready: true, mode: 'count-up' }), true);
    await a.pump(() => a.receiver.snapshot().rows[0]?.[0] === '43');
    assert.ok(effectsA.some(rows => rows[0]?.[0] === '43'), 'A still consumes new same-session data after B refuses the replay');
    assert.equal(b.receiver.allow(ownB.display), true, 'Only B own explicitly selected current review may approve B display');
    await b.pump(() => b.receiver.snapshot().rows[0]?.[0] === '77');
    assert.deepEqual(b.receiver.snapshot().rows, [['77', 'Off', 'count-down']]);
    assert.ok(effectsB.length > 0); assert.ok(effectsB.every(rows => rows[0]?.[0] === '77'));
    assert.deepEqual(a.receiver.snapshot().rows, [['43', 'On', 'count-up']]);
    t.diagnostic(JSON.stringify({ distinctSessions: true, admittedAReview: true, crossSessionApproval: false,
      deniedBRegistrations: 0, deniedBRoutes: 0, deniedBApplies: 0, unaffectedAFreshReading: '43', ownBReading: '77',
      scope: 'Actual public task/crypto/transport/binder/runtime/software reading effects with cooperative ports; no browser DTLS, sensor, OS-user isolation or whole S10 qualification.' }));
  } finally {
    const cleanup = await Promise.allSettled(pairs.map(value => value.close()));
    assert.deepEqual(cleanup.filter(value => value.status === 'rejected'), []);
    for (const value of pairs) for (const task of [value.source, value.receiver]) {
      const status = task.snapshot();
      assert.equal(status.rawPending, 0); assert.equal(status.cleanupUnconfirmed, false);
      assert.equal(status.owned.registrations, 0); assert.equal(status.owned.routes, 0);
      assert.equal(status.owned.producerTimers, 0); assert.equal(status.owned.expiryTimers, 0);
      assert.deepEqual(status.rows, []);
    }
  }
});
