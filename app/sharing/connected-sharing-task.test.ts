import assert from 'node:assert/strict';
import test from 'node:test';
import { createEphemeralWebIdentity, decodeReceiverInvitation, pointerSourceDescriptor } from '@101/connect';
import type { EndpointIdentity, PeerConnectionPort, PeerDataChannelPort } from '@101/connect';

// The native journey lives in qa-connected-sharing. These are actual public
// SDK contracts with explicit host ports; they do not qualify browser DTLS.
const api = await import('./connected-sharing-task.ts').catch(() => undefined);

test('connected Sharing is inert until an explicit enrollment action', () => {
  assert.ok(api, 'The connected owner/participant controller must exist');
  let clocks = 0, identities = 0;
  const task = api.createConnectedSharingTask({ role: 'owner', now: () => { clocks++; return 1000; }, wallNow: () => 1000,
    createIdentity: async () => { identities++; return createEphemeralWebIdentity(); } });
  assert.equal(clocks, 0); assert.equal(identities, 0);
  assert.equal(task.finishRoster(), false); assert.equal(task.approve('left'), false);
  assert.equal(task.snapshot().slots.length, 0); assert.equal(task.snapshot().rawPending, 0); void task.close();
});

test('only the genuine selected page-control declaration is compatible', () => {
  assert.ok(api);
  const descriptor = pointerSourceDescriptor('browser-pointer-events');
  assert.equal(api.connectedPointerCompatible(descriptor), true);
  assert.equal(api.connectedPointerCompatible({ ...descriptor, capabilities: [] }), false);
  assert.equal(api.connectedPointerCompatible({ ...descriptor, capabilities: descriptor.capabilities.map(capability => ({ ...capability, permissions: ['write'] })) }), false);
});

test('copied identity metadata and malformed codes never open a roster or resource grant', () => {
  assert.ok(api); let identities = 0;
  const task = api.createConnectedSharingTask({ role: 'participant', now: () => 1000, wallNow: () => 1000,
    createIdentity: async () => { identities++; return createEphemeralWebIdentity(); } });
  assert.equal(task.review('https://unrelated.invalid/'), false);
  assert.equal(task.request('left', 30, true), false); assert.equal(task.input('press'), false);
  assert.equal(task.snapshot().active, false); assert.equal(identities, 0); void task.close();
});

test('close retains an issued identity reservation and cannot install its late result', async () => {
  assert.ok(api); let finish!: (identity: Awaited<ReturnType<typeof createEphemeralWebIdentity>>) => void;
  let native = 0;
  const task = api.createConnectedSharingTask({ role: 'owner', now: () => 1000, wallNow: () => 1000,
    createPeer: () => { native++; throw Error('not reached'); }, createIdentity: () => new Promise(resolve => { finish = resolve; }) });
  const enrollment = task.invite(); assert.equal(task.snapshot().rawPending, 1);
  const settled = task.close(); assert.equal(task.snapshot().rawPending, 1);
  finish(await createEphemeralWebIdentity()); assert.equal(await enrollment, false); await settled;
  assert.equal(native, 0); assert.equal(task.snapshot().rawPending, 0); assert.equal(task.snapshot().closed, true);
});

test('reentrant close from a caller clock fences identity admission', async () => {
  assert.ok(api); let creates = 0;
  const task: ReturnType<NonNullable<typeof api>['createConnectedSharingTask']> = api.createConnectedSharingTask({ role: 'owner', now: () => { void task.close(); return 1000; }, wallNow: () => 1000,
    createPeer: () => { throw Error('not reached'); }, createIdentity: async () => { creates++; return createEphemeralWebIdentity(); } });
  assert.equal(await task.invite(), false); assert.equal(creates, 0); assert.equal(task.snapshot().closed, true);
});

test('host accessors and unbounded option fields are rejected before any callout', () => {
  assert.ok(api); let reads = 0;
  assert.throws(() => api.createConnectedSharingTask({ role: 'owner', now: () => 1000, wallNow: () => 1000,
    get createPeer() { reads++; return () => { throw Error('not reached'); }; } }), TypeError);
  assert.equal(reads, 0);
});

test('notification reentry close settles its reservation before returning and cannot issue a late identity', async () => {
  assert.ok(api); let identities = 0, native = 0, triggered = false;
  let finish: ((identity: Awaited<ReturnType<typeof createEphemeralWebIdentity>>) => void) | undefined;
  let closed: Promise<void> | undefined;
  const task: ReturnType<NonNullable<typeof api>['createConnectedSharingTask']> = api.createConnectedSharingTask({ role: 'owner', now: () => 1000, wallNow: () => 1000,
    createPeer: () => { native++; throw Error('not reached'); },
    createIdentity: () => { identities++; return new Promise(resolve => { finish = resolve; }); },
    onChange() { if (!triggered) { triggered = true; closed = task.close(); } },
  });
  const invitation = task.invite();
  try {
    assert.ok(closed, 'The real working-state notification must reach the host observer'); await closed;
    assert.equal(identities, 0, 'Close from the observer must fence the following identity issue');
    assert.equal(task.snapshot().rawPending, 0, 'Actual close must retain and await its reserved operation');
    assert.equal(await invitation, false); assert.equal(native, 0);
  } finally {
    if (finish) finish(await createEphemeralWebIdentity());
    await invitation; await task.close(); assert.equal(task.snapshot().rawPending, 0);
  }
});

const sdp = (byte: string) => `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\na=sctp-port:5000\r\n`;
class Channel implements PeerDataChannelPort {
  readyState = 'open'; bufferedAmount = 0; binaryType = 'arraybuffer'; bufferedAmountLowThreshold = 0;
  onmessage: PeerDataChannelPort['onmessage'] = null; onclose: PeerDataChannelPort['onclose'] = null; onerror: PeerDataChannelPort['onerror'] = null;
  readonly ordered: boolean; readonly maxPacketLifeTime = null; readonly maxRetransmits: number | null;
  target?: Channel; sent: (string | ArrayBuffer)[] = [];
  readonly label: string; private readonly queue: (() => void)[];
  constructor(label: string, options: RTCDataChannelInit, queue: (() => void)[]) { this.label = label; this.queue = queue; this.ordered = options.ordered ?? true; this.maxRetransmits = options.maxRetransmits ?? null; }
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
    const copy = typeof data === 'string' ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer : data.slice(0);
    this.sent.push(copy); this.queue.push(() => { if (this.readyState === 'open') this.target?.onmessage?.({ data: copy }); });
  }
  close() { this.readyState = 'closed'; this.onclose?.({}); }
}
class Port implements PeerConnectionPort {
  connectionState = 'new'; iceGatheringState = 'complete'; localDescription: { type: RTCSdpType; sdp: string } | null = null;
  onconnectionstatechange: PeerConnectionPort['onconnectionstatechange'] = null; ondatachannel: PeerConnectionPort['ondatachannel'] = null;
  readonly channels = new Map<string, Channel>(); closes = 0;
  private readonly queue: (() => void)[]; private readonly byte: string;
  constructor(queue: (() => void)[], byte: string) { this.queue = queue; this.byte = byte; }
  createDataChannel(label: string, options: RTCDataChannelInit) { const channel = new Channel(label, options, this.queue); this.channels.set(label, channel); return channel; }
  async createOffer() { return { type: 'offer' as const, sdp: sdp(this.byte) }; }
  async createAnswer() { return { type: 'answer' as const, sdp: sdp(this.byte) }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = { type: value.type, sdp: value.sdp! }; }
  async setRemoteDescription() {}
  addEventListener() {} removeEventListener() {}
  async getStats() { return new Map() as unknown as RTCStatsReport; }
  close() { this.closes++; this.connectionState = 'closed'; }
}
async function connectedFixture(count = 2, spare = 0, createIdentity?: () => Promise<EndpointIdentity>) {
  assert.ok(api); let now = 1000, ownerClockHook: (() => void) | undefined;
  const queue: (() => void)[] = [], ports = Array.from({ length: count + spare }, (_, index) => [new Port(queue, index ? '33' : '11'), new Port(queue, index ? '44' : '22')] as const);
  let ownerPort = 0;
  const owner = api.createConnectedSharingTask({ role: 'owner', now: () => { const callback = ownerClockHook; ownerClockHook = undefined; callback?.(); return now; }, wallNow: () => 1000, ...(createIdentity ? { createIdentity } : {}), createPeer: () => ports[ownerPort++]![1] });
  const sources = ports.map(pair => api.createConnectedSharingTask({ role: 'participant', now: () => now, wallNow: () => 1000, createPeer: () => pair[0] }));
  const pump = async (condition: () => boolean) => {
    for (let turn = 0; turn < 2000 && !condition(); turn++) {
      now += 1; owner.tick(); for (const source of sources) source.tick(); let packets = 0;
      while (queue.length) { assert.ok(++packets < 256); queue.shift()!(); }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(condition(), JSON.stringify([owner, ...sources].map(task => {
      const snapshot = task.snapshot(); return { notice: snapshot.notice, active: snapshot.active,
        phases: snapshot.peers.map(peer => peer.connection.phase), slots: snapshot.slots.map(slot => ({ state: slot.state, pending: !!slot.request, owned: !!slot.owner })) };
    })));
  };
  for (let index = 0; index < count; index++) {
    const source = sources[index]!, pair = ports[index]!;
    assert.equal(await owner.invite(), true); assert.equal(source.review(owner.snapshot().peers[index]!.connection.code), true);
    assert.equal(await source.offer(), true); assert.equal(await owner.accept(`participant-${index + 1}`, source.snapshot().peers[0]!.connection.code), true);
    assert.equal(await source.accept('participant-1', owner.snapshot().peers[index]!.connection.code), true);
    for (const [label, channel] of pair[0].channels) {
      const remote = new Channel(label, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits ?? undefined }, queue);
      remote.target = channel; channel.target = remote; pair[1].channels.set(label, remote); pair[1].ondatachannel?.({ channel: remote });
    }
    for (const port of pair) { port.connectionState = 'connected'; port.onconnectionstatechange?.({}); }
    await pump(() => !!owner.snapshot().peers[index]?.connection.comparison && !!source.snapshot().peers[0]?.connection.comparison);
    assert.equal(owner.snapshot().peers[index]!.connection.comparison, source.snapshot().peers[0]!.connection.comparison);
    assert.equal(owner.confirm(`participant-${index + 1}`), true); assert.equal(source.confirm('participant-1'), true);
    await pump(() => owner.snapshot().peers[index]?.connection.phase === 'connected' && source.snapshot().peers[0]?.connection.phase === 'connected');
  }
  assert.equal(owner.finishRoster(), true); await pump(() => sources.slice(0, count).every(source => source.snapshot().participant.layoutReady));
  return { owner, sources, ports, queue, pump, onOwnerClock(callback: () => void) { ownerClockHook = callback; }, time: () => now, advance(ms: number) { now += ms; },
    async close() { await Promise.all([owner.close(), ...sources.map(source => source.close())]); assert.equal(owner.snapshot().rawPending, 0); for (const source of sources) assert.equal(source.snapshot().rawPending, 0); } };
}

test('actual issued peers require separate source and owner approval before both partition effects', async () => {
  const f = await connectedFixture();
  try {
    assert.equal(f.sources[0]!.request('left', 30, false), false); assert.equal(f.sources[0]!.input('press'), false);
    assert.equal(f.sources[0]!.request('left', 30, true), true); assert.equal(f.sources[1]!.request('right', 30, true), true);
    await f.pump(() => f.owner.snapshot().peers.every(peer => peer.ready) && f.owner.snapshot().slots.every(slot => slot.request));
    assert.equal(f.sources[0]!.input('press'), false); assert.equal(f.owner.snapshot().active, false);
    assert.equal(f.owner.approve('left'), true); assert.equal(f.owner.approve('right'), true);
    await f.pump(() => f.sources.every(source => source.snapshot().participant.active));
    assert.equal(f.sources[0]!.input('right'), true); assert.equal(f.sources[0]!.input('press'), true); assert.equal(f.sources[1]!.input('right'), true);
    await f.pump(() => f.owner.snapshot().slots[0]?.held === true && (f.owner.snapshot().slots[0]?.position?.x ?? 0) > .5 && (f.owner.snapshot().slots[1]?.position?.x ?? 0) > .5);
    const sourceSamples = f.ports[0]![0].channels.get('connect-samples-1')!;
    const captured = sourceSamples.sent.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer).at(-1)!;
    assert.ok(captured, 'Capture actual public publisher bytes, not an invented wire frame');
    const previewed = f.owner.previewRevoke('left'); assert.equal(previewed, true); const preview = f.owner.snapshot().preview!;
    assert.equal(f.owner.confirmPreview(preview), true);
    await f.pump(() => !f.sources[0]!.snapshot().participant.active);
    assert.equal(f.owner.snapshot().slots[0]!.held, false); assert.equal(f.owner.snapshot().slots[1]!.owner?.sourceId, 'participant-2');
    assert.equal(f.owner.confirmPreview(preview), false);
    assert.equal(f.sources[0]!.request('left', 30, true), true);
    await f.pump(() => !!f.owner.snapshot().slots[0]?.request); assert.equal(f.owner.approve('left'), true);
    await f.pump(() => f.sources[0]!.snapshot().participant.active && f.owner.snapshot().slots[0]?.position?.x === .5);
    sourceSamples.target?.onmessage?.({ data: captured.slice(0) }); f.owner.tick();
    assert.equal(f.owner.snapshot().slots[0]!.position?.x, .5, 'An old wire slot cannot feed the replacement grant');
    assert.equal(f.owner.snapshot().slots[0]!.held, false);
  } finally { await f.close(); }
});

test('real ownership preserves a held incumbent on decline, then releases before exclusive transfer', async () => {
  const f = await connectedFixture();
  try {
    assert.equal(f.owner.previewPolicy('exclusive'), true); assert.equal(f.owner.confirmPreview(f.owner.snapshot().preview!), true);
    await f.pump(() => f.sources.every(source => source.snapshot().policy === 'exclusive'));
    const first = f.sources[0]!, second = f.sources[1]!;
    assert.equal(first.request('exclusive', 30, true), true);
    await f.pump(() => !!f.owner.snapshot().slots[0]?.request && f.owner.snapshot().peers[0]!.ready);
    assert.equal(f.owner.approve('exclusive'), true); await f.pump(() => first.snapshot().participant.active);
    first.input('press'); await f.pump(() => f.owner.snapshot().slots[0]!.held);
    second.request('exclusive', 30, true); await f.pump(() => f.owner.snapshot().slots[0]?.request?.sourceId === 'participant-2');
    assert.equal(f.owner.decline('exclusive'), true); await f.pump(() => !second.snapshot().participant.request);
    assert.equal(f.owner.snapshot().slots[0]!.held, true); assert.equal(f.owner.snapshot().slots[0]!.owner?.sourceId, 'participant-1');
    second.request('exclusive', 30, true); await f.pump(() => f.owner.snapshot().slots[0]?.request?.sourceId === 'participant-2');
    assert.equal(f.owner.approve('exclusive'), true); await f.pump(() => second.snapshot().participant.active && !first.snapshot().participant.active);
    assert.equal(f.owner.snapshot().slots[0]!.owner?.sourceId, 'participant-2'); assert.equal(f.owner.snapshot().slots[0]!.held, false);
    const binds = f.ports[1]![1].channels.get('connect-control-1')?.sent.filter(value => typeof value === 'string').map(value => JSON.parse(value as string)).filter(value => value.protocol === 'connect' && value.type === 'bind') ?? [];
    assert.equal(new Set(binds.map(value => value.slot)).size, binds.length, 'one receiver preserves its wire slot watermark');
    f.advance(30001); f.owner.tick(); second.tick(); assert.equal(f.owner.snapshot().active, false); assert.equal(second.snapshot().participant.active, false);
  } finally { await f.close(); }
});

test('owner can retire one invited participant after roster finish while the independent participant keeps sharing', { timeout: 10000 }, async t => {
  const f = await connectedFixture();
  try {
    assert.equal(f.sources[0]!.request('left', 30, true), true);
    assert.equal(f.sources[1]!.request('right', 30, true), true);
    await f.pump(() => f.owner.snapshot().peers.every(peer => peer.ready) && f.owner.snapshot().slots.every(slot => slot.request));
    assert.equal(f.owner.approve('left'), true); assert.equal(f.owner.approve('right'), true);
    await f.pump(() => f.sources.every(source => source.snapshot().participant.active));
    assert.equal(f.sources[0]!.input('press'), true); assert.equal(f.sources[1]!.input('press'), true);
    await f.pump(() => f.owner.snapshot().slots.every(slot => slot.held));
    const before = f.owner.snapshot();
    t.diagnostic(JSON.stringify({ actualPrecondition: { rosterFinished: before.rosterFinished,
      participants: before.peers.map(peer => ({ id: peer.id, phase: peer.connection.phase })),
      slots: before.slots.map(slot => ({ id: slot.id, epoch: slot.epoch, held: slot.held, owner: slot.owner?.sourceId })) },
      scope: 'Real WebCrypto/auth/task/ownership/runtime over faithful queued ports; not browserDTLS/physical/network qualification.' }));
    assert.equal(typeof f.owner.previewRemoveParticipant, 'function', 'Missing owner-reviewed single-participant removal after live roster setup');
    assert.equal(f.owner.previewRemoveParticipant('participant-1'), true);
    const review = f.owner.snapshot().preview!;
    assert.equal(review.kind, 'remove');
    await f.owner.confirmRemoval(review);
    const after = f.owner.snapshot();
    assert.equal(after.slots[0]!.held, false); assert.equal(after.slots[0]!.owner, undefined);
    assert.deepEqual(after.slots[1]!.owner, before.slots[1]!.owner);
    assert.equal(after.slots[1]!.epoch, before.slots[1]!.epoch); assert.equal(after.slots[1]!.held, true);
    assert.equal(f.sources[1]!.input('right'), true);
    await f.pump(() => (f.owner.snapshot().slots[1]!.position?.x ?? 0) > .5);
  } finally { await f.close(); t.diagnostic(JSON.stringify({ cleanup: { joined: true, rawPending: f.owner.snapshot().rawPending } })); }
});


function actualInvitation(code: string) {
  assert.ok(code.startsWith('101-sharing-1.'));
  const packet = JSON.parse(Buffer.from(code.slice('101-sharing-1.'.length), 'base64url').toString('utf8')) as { invitation: unknown };
  return decodeReceiverInvitation(JSON.stringify(packet.invitation), 1000);
}

async function connectReplacement(f: Awaited<ReturnType<typeof connectedFixture>>, index = 2) {
  const source = f.sources[index]!, pair = f.ports[index]!;
  assert.equal(source.review(f.owner.snapshot().peers[0]!.connection.code), true);
  assert.equal(await source.offer(), true); assert.equal(await f.owner.accept('participant-1', source.snapshot().peers[0]!.connection.code), true);
  assert.equal(await source.accept('participant-1', f.owner.snapshot().peers[0]!.connection.code), true);
  for (const [label, channel] of pair[0].channels) {
    const remote = new Channel(label, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits ?? undefined }, f.queue);
    remote.target = channel; channel.target = remote; pair[1].channels.set(label, remote); pair[1].ondatachannel?.({ channel: remote });
  }
  for (const port of pair) { port.connectionState = 'connected'; port.onconnectionstatechange?.({}); }
  await f.pump(() => !!f.owner.snapshot().peers[0]?.connection.comparison && !!source.snapshot().peers[0]?.connection.comparison);
  assert.equal(f.owner.snapshot().peers[0]!.connection.comparison, source.snapshot().peers[0]!.connection.comparison);
  assert.equal(f.owner.confirm('participant-1'), true); assert.equal(source.confirm('participant-1'), true);
  await f.pump(() => f.owner.snapshot().peers[0]?.membership === 'live' && source.snapshot().participant.layoutReady);
}

test('retired participant replacement uses a fresh authenticated invitation and fresh bilateral approvals while the other participant remains held', { timeout: 10000 }, async () => {
  const f = await connectedFixture(2, 1);
  try {
    const first = f.sources[0]!, second = f.sources[1]!, replacement = f.sources[2]!;
    first.request('left', 30, true); second.request('right', 30, true);
    await f.pump(() => f.owner.snapshot().slots.every(slot => slot.request) && f.owner.snapshot().peers.every(peer => peer.ready));
    f.owner.approve('left'); f.owner.approve('right'); await f.pump(() => first.snapshot().participant.active && second.snapshot().participant.active);
    first.input('press'); second.input('press'); await f.pump(() => f.owner.snapshot().slots.every(slot => slot.held));
    const original = f.owner.snapshot(), independent = original.slots[1]!, oldComparison = original.peers[0]!.connection.comparison, oldInvitation = actualInvitation(original.peers[0]!.connection.code);
    const oldSamples = f.ports[0]![0].channels.get('connect-samples-1')!, oldDeliver = oldSamples.target?.onmessage; assert.ok(oldDeliver);
    const captured = oldSamples.sent.filter((value): value is ArrayBuffer => value instanceof ArrayBuffer).at(-1)!; assert.ok(captured);
    assert.equal(f.owner.previewRemoveParticipant('participant-1'), true); const preview = f.owner.snapshot().preview!;
    assert.equal(await f.owner.confirmRemoval({ ...preview }), false, 'A copied review is not a reviewed operation');
    const removing = f.owner.confirmRemoval(preview);
    assert.equal(f.owner.snapshot().peers[0]!.membership, 'retiring'); assert.equal(f.owner.snapshot().slots[0]!.held, false);
    assert.equal(await f.owner.inviteReplacement('participant-1'), false, 'Retirement must join before slot reuse');
    assert.equal(await removing, true); assert.equal(f.ports[0]![1].closes, 1); assert.equal(f.owner.snapshot().rawPending, 0);
    assert.equal(await f.owner.confirmRemoval(preview), false, 'Review cannot replay');
    assert.deepEqual(f.owner.snapshot().slots[1], independent); assert.equal(second.input('right'), true);
    await f.pump(() => (f.owner.snapshot().slots[1]!.position?.x ?? 0) > .5);
    assert.equal(await f.owner.inviteReplacement('participant-1'), true); assert.equal(f.owner.snapshot().peers.length, 2);
    const freshInvitation = actualInvitation(f.owner.snapshot().peers[0]!.connection.code); assert.notEqual(freshInvitation.epoch, oldInvitation.epoch); assert.equal(freshInvitation.sessionId, oldInvitation.sessionId);
    assert.equal(replacement.input('press'), false); await connectReplacement(f);
    assert.notEqual(f.owner.snapshot().peers[0]!.connection.comparison, oldComparison);
    assert.equal(replacement.snapshot().participant.active, false); assert.equal(replacement.input('press'), false);
    assert.equal(replacement.request('left', 30, false), false); assert.equal(replacement.request('left', 30, true), true);
    await f.pump(() => !!f.owner.snapshot().slots[0]?.request && f.owner.snapshot().peers[0]!.ready);
    assert.equal(f.owner.snapshot().slots[0]!.owner, undefined); assert.equal(f.owner.snapshot().slots[0]!.held, false);
    assert.equal(f.owner.approve('left'), true); await f.pump(() => replacement.snapshot().participant.active);
    oldDeliver({ data: captured.slice(0) }); f.owner.tick(); assert.equal(f.owner.snapshot().slots[0]!.held, false);
    assert.equal(replacement.input('press'), true); await f.pump(() => f.owner.snapshot().slots[0]!.held);
    assert.deepEqual(f.owner.snapshot().slots[1]!.owner, independent.owner); assert.equal(f.owner.snapshot().slots[1]!.epoch, independent.epoch);
    assert.equal(f.owner.snapshot().slots[1]!.held, true);
    assert.equal(f.owner.previewRemoveParticipant('participant-1'), true); const stale = f.owner.snapshot().preview!;
    replacement.cancelRequest(); await f.pump(() => !f.owner.snapshot().slots[0]!.owner);
    assert.equal(await f.owner.confirmRemoval(stale), false, 'Changed permit/owner generation invalidates review');
    assert.equal(f.owner.snapshot().peers[0]!.membership, 'live'); assert.equal(f.owner.snapshot().slots[1]!.held, true);
  } finally { await f.close(); }
});


test('failed replacement identity setup settles into an empty bounded recoverable slot without changing the other participant', { timeout: 10000 }, async () => {
  let hold = false, rejectIdentity: ((reason: Error) => void) | undefined;
  const f = await connectedFixture(2, 0, () => hold ? new Promise<EndpointIdentity>((_resolve, reject) => { rejectIdentity = reject; }) : createEphemeralWebIdentity());
  try {
    const second = f.sources[1]!; second.request('right', 30, true);
    await f.pump(() => !!f.owner.snapshot().slots[1]?.request && f.owner.snapshot().peers[1]!.ready);
    f.owner.approve('right'); await f.pump(() => second.snapshot().participant.active);
    second.input('press'); await f.pump(() => f.owner.snapshot().slots[1]!.held);
    const independent = f.owner.snapshot().slots[1]!;
    assert.equal(f.owner.previewRemoveParticipant('participant-1'), true); assert.equal(await f.owner.confirmRemoval(f.owner.snapshot().preview!), true);
    hold = true; const pending = f.owner.inviteReplacement('participant-1'); assert.ok(rejectIdentity);
    assert.equal(f.owner.snapshot().peers[0]!.membership, 'replacement'); assert.equal(f.owner.snapshot().rawPending, 1);
    assert.equal(await f.owner.inviteReplacement('participant-1'), false); assert.equal(second.input('right'), true);
    await f.pump(() => (f.owner.snapshot().slots[1]!.position?.x ?? 0) > .5);
    rejectIdentity(Error('Owned fixture identity setup refused')); assert.equal(await pending, false); hold = false;
    assert.equal(f.owner.snapshot().peers[0]!.membership, 'removed'); assert.equal(f.owner.snapshot().rawPending, 0); assert.equal(f.owner.snapshot().peers.length, 2);
    assert.equal(f.owner.snapshot().slots[0]!.owner, undefined); assert.equal(f.owner.snapshot().slots[0]!.held, false);
    assert.deepEqual(f.owner.snapshot().slots[1]!.owner, independent.owner); assert.equal(f.owner.snapshot().slots[1]!.epoch, independent.epoch); assert.equal(f.owner.snapshot().slots[1]!.held, true);
    assert.equal(await f.owner.inviteReplacement('participant-1'), true); assert.equal(f.owner.snapshot().peers.length, 2);
  } finally { rejectIdentity?.(Error('Owned fixture final cleanup')); await f.close(); }
});


test('cancelled reviewed removal during actual scope clock callout cannot retire a participant', { timeout: 10000 }, async t => {
  const f = await connectedFixture();
  try {
    f.sources[0]!.request('left', 30, true); f.sources[1]!.request('right', 30, true);
    await f.pump(() => f.owner.snapshot().peers.every(peer => peer.ready) && f.owner.snapshot().slots.every(slot => slot.request));
    assert.equal(f.owner.approve('left'), true); assert.equal(f.owner.approve('right'), true);
    await f.pump(() => f.sources.every(source => source.snapshot().participant.active));
    f.sources[0]!.input('press'); f.sources[1]!.input('press'); await f.pump(() => f.owner.snapshot().slots.every(slot => slot.held));
    const before = f.owner.snapshot(); assert.equal(f.owner.previewRemoveParticipant('participant-1'), true);
    const preview = f.owner.snapshot().preview!; let callbacks = 0;
    f.onOwnerClock(() => { callbacks++; f.owner.cancelPreview(); });
    const removed = await f.owner.confirmRemoval(preview), after = f.owner.snapshot();
    t.diagnostic(JSON.stringify({ scope: 'Actual auth peer scope invokes the configured unchanged-time clock. No scope/auth/transport bypass.', callbacks, removed,
      membership: after.peers.map(peer => peer.membership), previewPresent: !!after.preview,
      slots: after.slots.map(slot => ({ id: slot.id, epoch: slot.epoch, held: slot.held, owner: slot.owner?.sourceId })) }));
    assert.equal(callbacks, 1, 'The armed callback must actually execute in scope currentness validation');
    assert.equal(removed, false, 'A review cancelled during a scope clock callout must not authorize retirement');
    assert.equal(after.preview, undefined); assert.equal(after.peers[0]!.membership, 'live');
    assert.deepEqual(after.slots[0], before.slots[0]); assert.deepEqual(after.slots[1], before.slots[1]);
    assert.equal(f.ports[0]![1].closes, 0); assert.equal(f.sources[0]!.input('right'), true); assert.equal(f.sources[1]!.input('right'), true);
    await f.pump(() => f.owner.snapshot().slots.every(slot => (slot.position?.x ?? 0) > .5));
  } finally { await f.close(); assert.equal(f.owner.snapshot().rawPending, 0); }
});
