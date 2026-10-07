import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime, createEphemeralWebIdentity, parseDeviceDescriptor, pointerSourceDescriptor } from '@101/connect';
import type { Observation, PeerConnectionPort, PeerDataChannelPort } from '@101/connect';

// TESTS-FIRST / UNRUN. These cooperative ports carry genuine public SDK
// authentication, descriptor, clock and resource bytes. They are not native RTC
// or hardware evidence. The independent native journey is in the QA tool.
let imported: Promise<typeof import('./watch-sharing-task.ts') | undefined> | undefined;
async function api() {
  imported ??= import('./watch-sharing-task.ts').catch(() => undefined);
  const result = await imported;
  assert.ok(result, 'The read-only observer Sharing task must exist');
  return result;
}
type Task = ReturnType<typeof import('./watch-sharing-task.ts')['createWatchSharingTask']>;

function prefixDescriptor(id: string, sink = false) {
  return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Owned page view', revision: 1,
    adapter: { id: 'example:watch-page', version: '1.0.0' }, runtime: { platform: 'owned-software-page' }, capabilities: [{
      id: 'view', semantic: 'application:read-only-page-view/1', schemaVersion: 1, kind: sink ? 'property' : 'sample',
      value: { type: 'record', fields: { x: { type: 'scalar', unit: '1', min: 0, max: 1 },
        y: { type: 'scalar', unit: '1', min: 0, max: 1 }, pressed: { type: 'boolean' },
        generation: { type: 'scalar', unit: '1', min: 1, max: 32, resolution: 1 },
        emittedAt: { type: 'scalar', unit: 'ms', min: 0, max: Number.MAX_SAFE_INTEGER - 60000 } } },
      delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 250 }, permissions: sink ? ['write'] : ['subscribe'],
      ...(sink ? { ownership: { mode: 'exclusive' } } : {}),
    }] });
}

test('actual public typed view routing and release precede the missing observer feature assertion', async () => {
  let now = 1000, allowed = false, releases = 0;
  const received: Observation[] = [];
  const runtime = createDeviceRuntime({ now: () => now, clockDomain: 'owned-prefix-page-clock', maxRegistrations: 2,
    maxRoutes: 1, maxPendingDeliveries: 1, authorize(request) {
      if (!allowed || request.source.registrationId !== source.id || request.sink.registrationId !== sink.id ||
        request.principalId !== 'owned-prefix' || request.applicationId !== 'watch-prefix' || request.sessionId !== 'owned-session' ||
        request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
      return { expiresAt: 31000, maxAgeMs: 250, maxHz: 20 };
    } });
  const source = runtime.registerSource({ device: prefixDescriptor('owned-prefix-source'), capability: 'view' });
  const sink = runtime.registerSink({ device: prefixDescriptor('owned-prefix-display', true), capability: 'view',
    apply(value, context) { assert.equal(context.isCurrent(), true); received.push(value); }, release() { releases++; } });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const makeRoute = () => runtime.route({ from: source, to: sink, principalId: 'owned-prefix', applicationId: 'watch-prefix',
    sessionId: 'owned-session', leaseMs: 30000 });
  try {
    const denied = makeRoute(); assert.deepEqual(denied.start(), { ok: false, reason: 'denied' });
    assert.equal(runtime.publish(source, { x: .5, y: .5, pressed: true, generation: 1, emittedAt: now }).ok, true);
    runtime.flush(); assert.equal(received.length, 0);
    allowed = true; const current = makeRoute(); assert.equal(current.start().ok, true);
    now += 50; const value = { x: .6, y: .4, pressed: true, generation: 1, emittedAt: now };
    assert.equal(runtime.publish(source, value).ok, true); runtime.flush();
    assert.deepEqual(received.at(-1)?.value, value); assert.equal(received.at(-1)?.timestamp, now);
    current.stop(); assert.equal(releases, 1); assert.equal(current.status().pending, 0);
  } finally { runtime.close(); }
  const sdkApi = await api();
  const task = sdkApi.createWatchSharingTask({ role: 'owner', now: () => 1000, wallNow: () => 1000 });
  try { assert.equal(task.snapshot().rawPending, 0); assert.equal(task.snapshot().source.active, false); }
  finally { await task.close(); }
});

test('construction, copied labels and malformed invitation are inert and default deny', async () => {
  const sdkApi = await api(); let clocks = 0, identities = 0, native = 0;
  const task = sdkApi.createWatchSharingTask({ role: 'owner', now: () => { clocks++; return 1000; }, wallNow: () => 1000,
    createIdentity: async () => { identities++; return createEphemeralWebIdentity(); }, createPeer: () => { native++; throw Error('not issued'); } });
  try {
    assert.equal(clocks, 0); assert.equal(task.snapshot().source.active, false);
    assert.equal(task.review('https://unrelated.invalid/'), false); assert.equal(task.startSource(false), false);
    assert.equal(task.input('press'), false); assert.equal(task.approveDisplay('observer-1', true), false);
    assert.equal(identities, 0); assert.equal(native, 0); assert.equal(task.snapshot().rawPending, 0);
  } finally { await task.close(); }
});

test('the exact closed view profile accepts no pointer/control participant declaration', async () => {
  const sdkApi = await api(), descriptor = sdkApi.watchViewDescriptor();
  assert.equal(sdkApi.watchViewCompatible(descriptor), true);
  assert.equal(sdkApi.watchViewCompatible(pointerSourceDescriptor()), false);
  assert.equal(sdkApi.watchViewCompatible({ ...descriptor, capabilities: descriptor.capabilities.map(capability => ({ ...capability, permissions: ['invoke'] })) }), false);
  assert.equal(sdkApi.watchViewCompatible({ ...descriptor, revision: descriptor.revision + 1 }), false);
  assert.equal(sdkApi.watchViewCompatible({ ...descriptor, capabilities: descriptor.capabilities.map(capability => ({ ...capability,
    value: { type: 'boolean' } })) }), false);
});

test('accessor options are rejected before callbacks and role confusion cannot open a native peer', async () => {
  const sdkApi = await api(); let reads = 0;
  assert.throws(() => sdkApi.createWatchSharingTask({ role: 'owner', now: () => 1000, wallNow: () => 1000,
    get createPeer() { reads++; return () => { throw Error('not issued'); }; } }), TypeError);
  assert.equal(reads, 0);
  const owner = sdkApi.createWatchSharingTask({ role: 'owner', now: () => 1000, wallNow: () => 1000 });
  const observer = sdkApi.createWatchSharingTask({ role: 'observer', now: () => 1000, wallNow: () => 1000, createPeer: () => { throw Error('not issued'); } });
  try { assert.equal(await owner.invite(), false); assert.equal(observer.startSource(true), false); assert.equal(observer.input('right'), false); }
  finally { await Promise.all([owner.close(), observer.close()]); }
});

test('an issued identity remains reserved through Stop and its real returned settlement', async () => {
  const sdkApi = await api(); let finish!: (value: Awaited<ReturnType<typeof createEphemeralWebIdentity>>) => void;
  let native = 0, closeReturned = false;
  const observer = sdkApi.createWatchSharingTask({ role: 'observer', now: () => 1000, wallNow: () => 1000,
    createIdentity: () => new Promise(resolve => { finish = resolve; }), createPeer: () => { native++; throw Error('not issued'); } });
  const invitation = observer.invite(), closed = observer.close().then(() => { closeReturned = true; });
  try {
    await Promise.resolve(); assert.equal(observer.snapshot().rawPending, 1); assert.equal(closeReturned, false);
    finish(await createEphemeralWebIdentity()); assert.equal(await invitation, false); await closed;
    assert.equal(native, 0); assert.equal(observer.snapshot().rawPending, 0);
  } finally { if (!closeReturned) { finish(await createEphemeralWebIdentity()); await closed; } }
});

test('reentrant clock retirement fences a later identity issue', async () => {
  const sdkApi = await api(); let identities = 0;
  const observer: Task = sdkApi.createWatchSharingTask({ role: 'observer', now: () => { void observer.close(); return 1000; }, wallNow: () => 1000,
    createIdentity: async () => { identities++; return createEphemeralWebIdentity(); } });
  try { assert.equal(await observer.invite(), false); assert.equal(identities, 0); assert.equal(observer.snapshot().closed, true); }
  finally { await observer.close(); }
});

test('notification close observes pre-reserved work and prevents a following factory call', async () => {
  const sdkApi = await api(); let identityCalls = 0, closed: Promise<void> | undefined;
  const observer: Task = sdkApi.createWatchSharingTask({ role: 'observer', now: () => 1000, wallNow: () => 1000,
    createIdentity: async () => { identityCalls++; return createEphemeralWebIdentity(); }, onChange() { closed ??= observer.close(); } });
  const result = observer.invite();
  try { assert.ok(closed); await closed; assert.equal(await result, false); assert.equal(identityCalls, 0); assert.equal(observer.snapshot().rawPending, 0); }
  finally { await observer.close(); }
});

const sdp = (byte: string) => `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\na=sctp-port:5000\r\n`;
class Channel implements PeerDataChannelPort {
  readyState = 'open'; bufferedAmount = 0; binaryType = 'arraybuffer'; bufferedAmountLowThreshold = 0;
  onmessage: PeerDataChannelPort['onmessage'] = null; onclose: PeerDataChannelPort['onclose'] = null; onerror: PeerDataChannelPort['onerror'] = null;
  readonly label: string; readonly ordered: boolean; readonly maxPacketLifeTime = null; readonly maxRetransmits: number | null;
  readonly sent: (string | ArrayBuffer)[] = []; target?: Channel; private readonly queue: (() => void)[];
  constructor(label: string, options: RTCDataChannelInit, queue: (() => void)[]) {
    this.label = label; this.queue = queue; this.ordered = options.ordered ?? true; this.maxRetransmits = options.maxRetransmits ?? null;
  }
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
    const copy = typeof data === 'string' ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer : data.slice(0);
    this.sent.push(copy); this.queue.push(() => { if (this.readyState === 'open') this.target?.onmessage?.({ data: copy }); });
  }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.onclose?.({}); }
}
class Port implements PeerConnectionPort {
  connectionState = 'new'; iceGatheringState = 'complete'; localDescription: { type: RTCSdpType; sdp: string } | null = null;
  onconnectionstatechange: PeerConnectionPort['onconnectionstatechange'] = null; ondatachannel: PeerConnectionPort['ondatachannel'] = null;
  readonly channels = new Map<string, Channel>(); closes = 0; private readonly queue: (() => void)[]; private readonly byte: string;
  offerWork?: Promise<{ type: 'offer'; sdp: string }>;
  constructor(queue: (() => void)[], byte: string) { this.queue = queue; this.byte = byte; }
  createDataChannel(label: string, options: RTCDataChannelInit) { const channel = new Channel(label, options, this.queue); this.channels.set(label, channel); return channel; }
  async createOffer() { return this.offerWork ?? { type: 'offer' as const, sdp: sdp(this.byte) }; }
  async createAnswer() { return { type: 'answer' as const, sdp: sdp(this.byte) }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = { type: value.type, sdp: value.sdp! }; }
  async setRemoteDescription() {}
  addEventListener() {} removeEventListener() {}
  async getStats() { return new Map() as unknown as RTCStatsReport; }
  close() { if (this.connectionState === 'closed') return; this.closes++; this.connectionState = 'closed'; for (const channel of this.channels.values()) channel.close(); }
}
async function connectedFixture(count = 2) {
  const sdkApi = await api(); let now = 1000, ownerClockHook: (() => void) | undefined, observerClockHook: (() => void) | undefined, observerChangeHook: (() => void) | undefined;
  const queue: (() => void)[] = [], ports = Array.from({ length: count }, (_, index) => [
    new Port(queue, index ? '33' : '11'), new Port(queue, index ? '44' : '22')] as const);
  let ownerPort = 0;
  const owner = sdkApi.createWatchSharingTask({ role: 'owner', now: () => { ownerClockHook?.(); return now; }, wallNow: () => 1000,
    createPeer: () => ports[ownerPort++]![0] });
  const observers = ports.map(pair => sdkApi.createWatchSharingTask({ role: 'observer', now: () => { observerClockHook?.(); return now; }, wallNow: () => 1000, onChange: () => observerChangeHook?.(), createPeer: () => pair[1] }));
  async function pump(condition: () => boolean) {
    for (let turn = 0; turn < 2000 && !condition(); turn++) {
      now++; owner.tick(); for (const observer of observers) observer.tick(); let packets = 0;
      while (queue.length) { assert.ok(++packets < 256, 'Bounded actual SDK packet work'); queue.shift()!(); }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(condition(), JSON.stringify([owner, ...observers].map(task => ({ notice: task.snapshot().notice,
      peers: task.snapshot().peers.map(peer => ({ phase: peer.connection.phase, ready: peer.ready, active: peer.active })), view: task.snapshot().view }))));
  }
  try {
    for (let index = 0; index < count; index++) {
      const observer = observers[index]!, pair = ports[index]!, id = `observer-${index + 1}`;
      assert.equal(await observer.invite(), true); assert.equal(owner.review(observer.snapshot().peers[0]!.connection.code), true);
      assert.equal(await owner.offer(id), true); assert.equal(await observer.accept('owner', owner.snapshot().peers[index]!.connection.code), true);
      assert.equal(await owner.accept(id, observer.snapshot().peers[0]!.connection.code), true);
      for (const [label, channel] of pair[0].channels) {
        const remote = new Channel(label, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits ?? undefined }, queue);
        remote.target = channel; channel.target = remote; pair[1].channels.set(label, remote); pair[1].ondatachannel?.({ channel: remote });
      }
      for (const port of pair) { port.connectionState = 'connected'; port.onconnectionstatechange?.({}); }
      await pump(() => !!owner.snapshot().peers[index]?.connection.comparison && !!observer.snapshot().peers[0]?.connection.comparison);
      assert.equal(owner.snapshot().peers[index]!.connection.comparison, observer.snapshot().peers[0]!.connection.comparison);
      assert.equal(owner.confirm(id), true); assert.equal(observer.confirm('owner'), true);
      await pump(() => owner.snapshot().peers[index]?.connection.phase === 'connected' && observer.snapshot().peers[0]?.connection.phase === 'connected');
    }
  } catch (error) { await Promise.all([owner.close(), ...observers.map(observer => observer.close())]); throw error; }
  return { owner, observers, ports, pump, time: () => now, advance(ms: number) { now += ms; },
    ownerClock(hook: (() => void) | undefined) { ownerClockHook = hook; },
    observerClock(hook: (() => void) | undefined) { observerClockHook = hook; },
    observerChange(hook: (() => void) | undefined) { observerChangeHook = hook; },
    async elapse(ms: number) {
      const end = now + ms;
      // Keep actual authentication heartbeats alive without granting a display.
      while (now < end) {
        now = Math.min(end, now + 50); owner.tick(); for (const observer of observers) observer.tick();
        let packets = 0; while (queue.length) { assert.ok(++packets < 256); queue.shift()!(); }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    },
    async start() { assert.equal(owner.startSource(true), true); await pump(() => observers.every(observer => observer.snapshot().peers[0]?.ready)); },
    async approve(index: number) {
      const observer = observers[index]!, id = `observer-${index + 1}`;
      assert.equal(observer.requestDisplay(true), true); await pump(() => !!owner.snapshot().peers[index]?.request);
      assert.equal(owner.approveDisplay(id, true), true); await pump(() => observer.snapshot().view.active);
    },
    async close() {
      ownerClockHook = undefined; observerClockHook = undefined; observerChangeHook = undefined; await Promise.all([owner.close(), ...observers.map(observer => observer.close())]);
      for (const task of [owner, ...observers]) assert.equal(task.snapshot().rawPending, 0);
      for (const pair of ports) for (const port of pair) assert.equal(port.closes, 1);
    } };
}

test('bilateral endpoint confirmation and metadata do not authorize any view', async () => {
  const f = await connectedFixture();
  try {
    assert.equal(f.owner.snapshot().source.active, false); assert.equal(f.owner.input('press'), false);
    for (const observer of f.observers) {
      assert.equal(observer.snapshot().view.active, false); assert.equal(observer.snapshot().view.value, undefined);
      assert.equal(observer.requestDisplay(false), false); assert.equal(observer.input('right'), false);
    }
    await f.start(); assert.equal(f.owner.input('press'), true);
    await f.pump(() => f.owner.snapshot().source.value?.pressed === true);
    for (const observer of f.observers) assert.equal(observer.snapshot().view.value, undefined);
  } finally { await f.close(); }
});

test('each real receiver needs independent display and exact owner-recipient approval', async () => {
  const f = await connectedFixture();
  try {
    await f.start(); const first = f.observers[0]!, second = f.observers[1]!;
    assert.equal(first.requestDisplay(true), true); await f.pump(() => !!f.owner.snapshot().peers[0]?.request);
    assert.equal(f.owner.approveDisplay('observer-2', true), false); assert.equal(f.owner.approveDisplay('observer-1', false), false);
    assert.equal(first.snapshot().view.value, undefined); assert.equal(second.snapshot().view.value, undefined);
    assert.equal(f.owner.approveDisplay('observer-1', true), true); await f.pump(() => first.snapshot().view.active);
    assert.equal(f.owner.input('right'), true); assert.equal(f.owner.input('press'), true);
    await f.pump(() => first.snapshot().view.value?.pressed === true && (first.snapshot().view.value?.x ?? 0) > .5);
    assert.equal(second.snapshot().view.value, undefined); assert.equal(first.input('left'), false);
    const original = f.owner.snapshot().source.value!, observed = first.snapshot().view.value!;
    assert.deepEqual(observed, original); assert.equal(observed.emittedAt, original.emittedAt);
    assert.equal(first.snapshot().view.sourceStamp?.generation, observed.generation);
    assert.equal(first.snapshot().view.sourceStamp?.milliseconds, observed.emittedAt);
    assert.equal(first.snapshot().view.sourceStamp?.kind, 'owner-page-performance');
    assert.equal(first.snapshot().view.sourceStamp?.endpointId, first.snapshot().peers[0]?.remoteKeyId);
    assert.equal(first.snapshot().view.sourceStamp?.epoch, first.snapshot().peers[0]?.epoch);
    assert.match(first.snapshot().view.sourceStamp!.endpointId, /^[0-9a-f]{64}$/);
    assert.ok(Number.isFinite(first.snapshot().view.receivedAt));
  } finally { await f.close(); }
});

test('decline and cancel one recipient retain another current coherent held view', async () => {
  const f = await connectedFixture();
  try {
    await f.start(); await f.approve(0); const first = f.observers[0]!, second = f.observers[1]!;
    f.owner.input('press'); await f.pump(() => first.snapshot().view.value?.pressed === true);
    assert.equal(second.requestDisplay(true), true); await f.pump(() => !!f.owner.snapshot().peers[1]?.request);
    assert.equal(f.owner.declineDisplay('observer-2'), true); await f.pump(() => !second.snapshot().view.request);
    assert.equal(first.snapshot().view.value?.pressed, true); assert.equal(f.owner.snapshot().source.active, true);
    assert.equal(second.requestDisplay(true), true); await f.pump(() => !!f.owner.snapshot().peers[1]?.request);
    second.cancelDisplay(); await f.pump(() => !f.owner.snapshot().peers[1]?.request);
    assert.equal(first.snapshot().view.value?.pressed, true); assert.equal(second.snapshot().view.value, undefined);
  } finally { await f.close(); }
});

test('revoke only the selected observer and reject old actual publisher bytes after fresh approval', async () => {
  const f = await connectedFixture();
  try {
    await f.start(); await f.approve(0); await f.approve(1); f.owner.input('press');
    await f.pump(() => f.observers.every(observer => observer.snapshot().view.value?.pressed === true));
    const samples = f.ports[0]![0].channels.get('connect-samples-1')!;
    const old = samples.sent.filter((value): value is string => {
      if (typeof value !== 'string') return false;
      const packet = JSON.parse(value); return packet.protocol === 'connect' && packet.version === 2 && packet.type === 'sample';
    }).at(-1);
    assert.ok(old, 'The negative replay uses genuine public publisher bytes');
    assert.equal(f.owner.revokeDisplay('observer-1'), true); await f.pump(() => !f.observers[0]!.snapshot().view.active);
    assert.equal(f.observers[0]!.snapshot().view.value, undefined); assert.equal(f.observers[1]!.snapshot().view.value?.pressed, true);
    assert.equal(f.owner.snapshot().source.active, true);
    f.owner.releaseInput(); await f.approve(0); await f.pump(() => f.observers[0]!.snapshot().view.value?.pressed === false);
    samples.target?.onmessage?.({ data: old }); f.observers[0]!.tick();
    assert.equal(f.observers[0]!.snapshot().view.value?.pressed, false);
  } finally { await f.close(); }
});

test('foreign peer and legacy input-participant control fields cannot approve a display', async () => {
  const f = await connectedFixture();
  try {
    await f.start(); const first = f.observers[0]!;
    first.requestDisplay(true); await f.pump(() => !!f.owner.snapshot().peers[0]?.request);
    const outgoing = f.ports[0]![1].channels.get('connect-control-1')!;
    const text = outgoing.sent.filter((value): value is string => typeof value === 'string').find(value => {
      const parsed = JSON.parse(value); return parsed.flow === 'observer-view/1' && parsed.type === 'request';
    });
    assert.ok(text, 'Capture actual issued observer request before a protocol negative');
    f.ports[1]![0].channels.get('connect-control-1')?.onmessage?.({ data: text }); f.owner.tick();
    assert.equal(f.owner.snapshot().peers[1]!.request, undefined, 'One issued endpoint epoch cannot address another recipient');
    const envelope = JSON.parse(text);
    // The old connected task's closed request grammar, carrying the genuine
    // captured epoch. This is a negative grammar fixture, not native input.
    outgoing.target?.onmessage?.({ data: JSON.stringify({ p: envelope.p, v: envelope.v, epoch: envelope.epoch,
      type: 'request', revision: 1, request: envelope.request, slot: 'left', duration: 30 }) }); f.owner.tick();
    assert.equal(first.snapshot().view.active, false); assert.equal(first.snapshot().view.value, undefined);
    assert.equal(f.owner.snapshot().peers[1]!.active, false);
  } finally { await f.close(); }
});

test('original absolute source consent caps late display approval without renewal', async () => {
  const f = await connectedFixture(1);
  try {
    await f.start(); const expires = f.owner.snapshot().source.expiresAt!;
    assert.ok(expires <= f.time() + 30000); await f.elapse(29000); await f.approve(0);
    assert.ok(f.observers[0]!.snapshot().view.expiresAt! <= expires);
    f.advance(expires - f.time()); f.owner.tick(); f.observers[0]!.tick();
    assert.equal(f.owner.snapshot().source.active, false); assert.equal(f.owner.input('press'), false);
    assert.equal(f.observers[0]!.snapshot().view.value, undefined); assert.equal(f.observers[0]!.snapshot().view.active, false);
  } finally { await f.close(); }
});

test('an explicit source pause leaves a true zero-data interval and cannot extend consent', async () => {
  const f = await connectedFixture(1);
  try {
    await f.start(); await f.approve(0); f.owner.input('press');
    await f.pump(() => f.observers[0]!.snapshot().view.value?.pressed === true);
    const expires = f.owner.snapshot().source.expiresAt!;
    assert.equal(f.owner.pauseUpdates(), true); const emissions = f.owner.snapshot().source.emissions;
    f.advance(501); f.owner.tick(); f.observers[0]!.tick();
    assert.equal(f.owner.snapshot().source.emissions, emissions);
    assert.equal(f.owner.snapshot().source.expiresAt, expires); assert.equal(f.owner.startSource(true), false);
    f.advance(expires - f.time()); f.owner.tick(); f.observers[0]!.tick();
    assert.equal(f.owner.snapshot().source.active, false); assert.equal(f.observers[0]!.snapshot().view.value, undefined);
    assert.equal(f.owner.snapshot().source.emissions, emissions);
  } finally { await f.close(); }
});

test('the two-recipient bound rejects a third genuine invitation without opening another peer', async () => {
  const sdkApi = await api(), f = await connectedFixture();
  const third = sdkApi.createWatchSharingTask({ role: 'observer', now: () => f.time(), wallNow: () => 1000, createPeer: () => { throw Error('not issued'); } });
  try {
    assert.equal(await third.invite(), true); assert.equal(f.owner.review(third.snapshot().peers[0]!.connection.code), false);
    assert.equal(f.owner.snapshot().peers.length, 2); assert.equal(f.owner.snapshot().rawPending, 0);
    assert.equal(f.owner.snapshot().source.active, false);
  } finally { await third.close(); await f.close(); }
});

test('a final clock call reaching the exact source deadline cannot emit a late view', async () => {
  const f = await connectedFixture(1);
  try {
    await f.start(); await f.approve(0); const expires = f.owner.snapshot().source.expiresAt!;
    f.ownerClock(() => { f.advance(Math.max(0, expires - f.time())); });
    assert.equal(f.owner.input('press'), false); f.ownerClock(undefined);
    f.observers[0]!.tick(); assert.notEqual(f.observers[0]!.snapshot().view.value?.pressed, true);
    assert.equal(f.owner.snapshot().source.active, false);
  } finally { await f.close(); }
});

test('native-shaped offer promise survives logical Stop until its actual result settles', async () => {
  const sdkApi = await api(), queue: (() => void)[] = [], port = new Port(queue, '55');
  const identity = await createEphemeralWebIdentity();
  let finish!: (value: { type: 'offer'; sdp: string }) => void, closed = false;
  port.offerWork = new Promise(resolve => { finish = resolve; });
  const owner = sdkApi.createWatchSharingTask({ role: 'owner', now: () => 1000, wallNow: () => 1000, createPeer: () => port, createIdentity: async () => identity });
  const observer = sdkApi.createWatchSharingTask({ role: 'observer', now: () => 1000, wallNow: () => 1000, createPeer: () => { throw Error('not issued'); } });
  let work: Promise<boolean> | undefined;
  try {
    assert.equal(await observer.invite(), true); assert.equal(owner.review(observer.snapshot().peers[0]!.connection.code), true);
    work = owner.offer('observer-1');
    for (let turn = 0; turn < 64 && port.channels.size === 0; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(port.channels.size > 0, 'Actual public transport issued createOffer through its trusted port');
    const closing = owner.close().then(() => { closed = true; }); await Promise.resolve();
    assert.equal(closed, false); assert.ok(owner.snapshot().rawPending > 0);
    finish({ type: 'offer', sdp: sdp('55') }); assert.equal(await work, false); await closing;
    assert.equal(owner.snapshot().rawPending, 0); assert.equal(port.closes, 1);
  } finally { finish?.({ type: 'offer', sdp: sdp('55') }); await work; await Promise.all([owner.close(), observer.close()]); }
});

test('Stop clears every observer while source retry needs fresh source and display approvals', async () => {
  const f = await connectedFixture();
  try {
    await f.start(); await f.approve(0); await f.approve(1); f.owner.input('press');
    await f.pump(() => f.observers.every(observer => observer.snapshot().view.value?.pressed === true));
    const generation = f.owner.snapshot().source.generation;
    f.owner.interrupt(); await f.pump(() => f.observers.every(observer => !observer.snapshot().view.active));
    assert.equal(f.owner.snapshot().source.active, false);
    for (const observer of f.observers) assert.equal(observer.snapshot().view.value, undefined);
    assert.equal(f.owner.input('right'), false); await f.start();
    assert.ok(f.owner.snapshot().source.generation > generation); f.owner.input('right');
    for (const observer of f.observers) assert.equal(observer.snapshot().view.value, undefined);
    await f.approve(1); f.owner.input('left'); await f.pump(() => !!f.observers[1]!.snapshot().view.value);
    assert.equal(f.observers[0]!.snapshot().view.value, undefined);
  } finally { await f.close(); }
});


test('late actual peer-scope clock cannot commit an aged observer view', async () => {
  const f = await connectedFixture(1); let crossed = false, late = false;
  const originalStackLimit = Error.stackTraceLimit; Error.stackTraceLimit = 50;
  try {
    await f.start(); await f.approve(0);
    f.observerChange(() => {
      const value = f.observers[0]!.snapshot().view.value;
      if (value?.pressed && f.time() - value.emittedAt > 250) late = true;
    });
    f.observerClock(() => {
      const stack = new Error().stack ?? '';
      // Advance only the actual public peer scope's clock inside the view sink.
      if (!crossed && stack.includes('SharingPeer.scope') && stack.includes('at display ')) {
        crossed = true; f.advance(251);
      }
    });
    f.owner.input('press'); await f.pump(() => crossed);
    assert.equal(crossed, true, 'Actual public peer-scope clock was issued');
    assert.equal(late, false, 'Aged value must not commit after the final peer scope callout');
  } finally { Error.stackTraceLimit = originalStackLimit; await f.close(); }
});
