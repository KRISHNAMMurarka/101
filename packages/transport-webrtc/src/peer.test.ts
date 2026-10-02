import assert from 'node:assert/strict';
import test from 'node:test';
import { PeerDataTransport } from './index.ts';

class Channel {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  sent: unknown[] = [];
  ordered: boolean;
  maxRetransmits: number | null;
  maxPacketLifeTime: number | null;
  readonly label: string;
  constructor(label: string, options: RTCDataChannelInit = {}) {
    this.label = label; this.ordered = options.ordered ?? true;
    this.maxRetransmits = options.maxRetransmits ?? null;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
  }
  send(data: unknown) { this.sent.push(data); }
  receive(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
  close() { this.closed = true; this.readyState = 'closed'; this.onclose?.(); }
}

class Peer {
  connectionState: RTCPeerConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'complete';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channels = new Map<string, Channel>();
  options = new Map<string, RTCDataChannelInit>();
  iceListeners = new Set<() => void>();
  createDataChannel(label: string, options: RTCDataChannelInit) {
    const channel = new Channel(label, options); this.channels.set(label, channel); this.options.set(label, options);
    return channel as unknown as RTCDataChannel;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description; }
  addEventListener(_name: string, listener: () => void) { this.iceListeners.add(listener); }
  removeEventListener(_name: string, listener: () => void) { this.iceListeners.delete(listener); }
  close() { this.connectionState = 'closed'; }
  async getStats() { return new Map() as unknown as RTCStatsReport; }
  offerChannel(channel: Channel) { this.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent); }
}

function fixture(initiator = true) {
  const peers: Peer[] = [];
  const configurations: RTCConfiguration[] = [];
  const transport = new PeerDataTransport({ initiator, createPeer(configuration) {
    configurations.push(configuration);
    const peer = new Peer(); peers.push(peer); return peer as unknown as RTCPeerConnection;
  }});
  return { transport, peers, configurations };
}

test('raw peer uses independent reliable/disposable lanes and carries string and binary payloads', async () => {
  const { transport, peers, configurations } = fixture();
  const received: unknown[] = [];
  transport.onData((lane, data) => received.push([lane, data]));
  await transport.connect();
  const peer = peers[0];
  assert.deepEqual(configurations, [{ iceServers: [] }]);
  assert.deepEqual(peer.options.get('connect-control-1'), { ordered: true });
  assert.deepEqual(peer.options.get('connect-samples-1'), { ordered: false, maxRetransmits: 0 });
  const control = peer.channels.get('connect-control-1')!;
  const samples = peer.channels.get('connect-samples-1')!;
  control.receive('descriptor'); samples.receive(new Uint8Array([1, 2]).buffer);
  assert.equal(samples.binaryType, 'arraybuffer');
  assert.deepEqual(received, [['reliable', 'descriptor'], ['disposable', new Uint8Array([1, 2]).buffer]]);
  assert.equal(transport.send('reliable', 'grant'), true);
  assert.deepEqual(control.sent, ['grant']);
  await transport.disconnect();
});

test('send admission includes new UTF-8/binary bytes and fails before overbuffering', async () => {
  const { transport, peers } = fixture();
  await transport.connect();
  const sample = peers[0].channels.get('connect-samples-1')!;
  sample.bufferedAmount = 65530;
  assert.equal(transport.send('disposable', new Uint8Array(24)), false);
  assert.equal(transport.send('disposable', 'ééé'), true);
  assert.equal(transport.send('disposable', 'éééé'), false);
  const reliable = peers[0].channels.get('connect-control-1')!;
  reliable.bufferedAmount = 262143;
  assert.equal(transport.send('reliable', 'ok'), false);
  assert.equal(transport.send('reliable', 'x'), true);
  assert.equal(transport.send('reliable', new Uint8Array(262145)), false);
  assert.equal(sample.sent.length, 1);
  await transport.disconnect();
});

test('disconnect invalidates captured old handlers before creating a replacement peer', async () => {
  const { transport, peers } = fixture();
  const received: unknown[] = [];
  transport.onData((_lane, data) => received.push(data));
  await transport.connect();
  const old = peers[0];
  const oldMessage = old.channels.get('connect-control-1')!.onmessage!;
  const oldState = old.onconnectionstatechange!;
  await transport.disconnect(); await transport.connect();
  oldMessage({ data: 'stale' } as MessageEvent);
  old.connectionState = 'connected'; oldState();
  assert.deepEqual(received, []);
  assert.equal(transport.state, 'connecting');
  assert.equal(old.ondatachannel, null);
  assert.equal(old.channels.get('connect-control-1')!.onmessage, null);
  await transport.disconnect();
});

test('unknown or duplicate incoming channels cannot replace the established lane', async () => {
  const { transport, peers } = fixture(false);
  await transport.connect();
  const accepted = new Channel('connect-control-1');
  const duplicate = new Channel('connect-control-1');
  const unknown = new Channel('other-product');
  peers[0].offerChannel(accepted); peers[0].offerChannel(duplicate); peers[0].offerChannel(unknown);
  assert.equal(duplicate.closed, true); assert.equal(unknown.closed, true);
  assert.equal(transport.send('reliable', 'allowed'), true);
  assert.deepEqual(accepted.sent, ['allowed']);
  await transport.disconnect();
});

test('disconnect during asynchronous SDP generation cannot resume a disposed peer', async () => {
  const { transport, peers } = fixture();
  await transport.connect();
  let resolve!: (value: RTCSessionDescriptionInit) => void;
  let started!: () => void;
  const entered = new Promise<void>(done => { started = done; });
  peers[0].createOffer = () => new Promise(done => { resolve = done; started(); });
  const offer = transport.createOffer();
  const rejected = assert.rejects(offer, /disconnected|generation/i);
  await entered;
  await transport.disconnect();
  resolve({ type: 'offer', sdp: 'old-generation' });
  await rejected;
  assert.equal(peers[0].localDescription, null);
});

test('a negotiation requested before disconnect cannot silently switch to the replacement peer', async () => {
  const { transport, peers } = fixture();
  await transport.connect();
  const offer = transport.createOffer();
  const rejected = assert.rejects(offer, /disconnected|generation/i);
  const disconnected = transport.disconnect();
  const reconnected = transport.connect();
  await Promise.all([disconnected, reconnected]);
  await rejected;
  assert.equal(peers[1].localDescription, null);
  await transport.disconnect();
});

test('disconnect cancels ICE gathering and removes the wait listener immediately', async () => {
  const { transport, peers } = fixture();
  await transport.connect();
  peers[0].iceGatheringState = 'gathering';
  const offer = transport.createOffer();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(peers[0].iceListeners.size, 1);
  await transport.disconnect();
  await assert.rejects(offer, /disconnected|generation/i);
  assert.equal(peers[0].iceListeners.size, 0);
});

test('SDP exchange accepts only its expected offer/answer and returns complete local data', async () => {
  const { transport, peers } = fixture();
  assert.deepEqual(await transport.createOffer(), { type: 'offer', sdp: 'offer-sdp' });
  await assert.rejects(() => transport.acceptAnswer({ type: 'offer', sdp: 'bad' }), /answer/i);
  await transport.acceptAnswer({ type: 'answer', sdp: 'answer-sdp' });
  assert.deepEqual(peers[0].remoteDescription, { type: 'answer', sdp: 'answer-sdp' });
  await transport.disconnect();
  const responder = fixture(false);
  assert.deepEqual(await responder.transport.acceptOffer({ type: 'offer', sdp: 'offer-sdp' }), { type: 'answer', sdp: 'answer-sdp' });
  await responder.transport.disconnect();
});

test('incomplete ICE gathering rejects rather than returning incomplete pairing data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { transport, peers } = fixture();
  await transport.connect();
  peers[0].iceGatheringState = 'gathering';
  const offer = transport.createOffer();
  const rejected = assert.rejects(offer, /gathering.*complete|gathering.*timeout/i);
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(peers[0].iceListeners.size, 0);
  assert.equal(transport.state, 'failed');
  assert.equal(peers[0].connectionState, 'closed');
});

test('only a completed current negotiation owns an immutable offer and answer binding', async () => {
  const { transport } = fixture();
  assert.equal(transport.sessionBinding(), undefined);
  const offer = await transport.createOffer();
  assert.equal(transport.sessionBinding(), undefined);
  assert.equal(transport.isCurrentSession(undefined), false);
  const answer = { type: 'answer' as const, sdp: 'answer-sdp' };
  await transport.acceptAnswer(answer);
  const binding = transport.sessionBinding()!;
  assert.equal(transport.isCurrentSession(binding), true);
  assert.equal(transport.isCurrentSession({ ...binding }), false);
  assert.deepEqual(binding.offer, { type: 'offer', sdp: 'offer-sdp' });
  assert.deepEqual(binding.answer, { type: 'answer', sdp: 'answer-sdp' });
  assert.equal(binding.initiator, true);
  offer.sdp = 'changed returned offer'; answer.sdp = 'changed caller answer';
  assert.equal(binding.offer.sdp, 'offer-sdp'); assert.equal(binding.answer.sdp, 'answer-sdp');
  assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.offer) && Object.isFrozen(binding.answer));
  await transport.disconnect();
  assert.equal(transport.sessionBinding(), undefined);
  assert.equal(transport.isCurrentSession(binding), false);
  await transport.createOffer(); await transport.acceptAnswer({ type: 'answer', sdp: 'new-answer' });
  assert.notEqual(transport.sessionBinding(), binding);
  assert.equal(transport.isCurrentSession(binding), false);
  await transport.disconnect();
});

test('overlapping and repeated negotiation cannot replace the transcript of a generation', async () => {
  const { transport, peers } = fixture();
  await transport.connect();
  let complete!: (value: RTCSessionDescriptionInit) => void;
  peers[0].createOffer = () => new Promise(resolve => { complete = resolve; });
  const pending = transport.createOffer();
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(() => transport.createOffer(), /negotiation|already/i);
  await assert.rejects(() => transport.acceptAnswer({ type: 'answer', sdp: 'early' }), /negotiation|offer/i);
  complete({ type: 'offer', sdp: 'owned-offer' });
  await pending;
  await transport.acceptAnswer({ type: 'answer', sdp: 'owned-answer' });
  const binding = transport.sessionBinding();
  await assert.rejects(() => transport.createOffer(), /negotiation|already/i);
  await assert.rejects(() => transport.acceptAnswer({ type: 'answer', sdp: 'replacement-answer' }), /negotiation|already/i);
  assert.equal(transport.sessionBinding(), binding);
  assert.equal(peers[0].remoteDescription?.sdp, 'owned-answer');
  await transport.disconnect();
});

test('responder binds the accepted offer and final answer and retires proof on lane failure', async () => {
  const { transport, peers } = fixture(false);
  const offer = { type: 'offer' as const, sdp: 'accepted-offer' };
  const returned = await transport.acceptOffer(offer);
  const binding = transport.sessionBinding()!;
  assert.equal(binding.initiator, false);
  assert.equal(binding.offer.sdp, 'accepted-offer'); assert.equal(binding.answer.sdp, 'answer-sdp');
  returned.sdp = 'changed-answer'; offer.sdp = 'changed-offer';
  assert.equal(binding.offer.sdp, 'accepted-offer'); assert.equal(binding.answer.sdp, 'answer-sdp');
  const channel = new Channel('connect-control-1'); peers[0].offerChannel(channel);
  channel.onerror?.();
  assert.equal(transport.sessionBinding(), undefined);
  assert.equal(transport.isCurrentSession(binding), false);
  await transport.disconnect();
});

test('a failing subscriber cannot prevent other subscribers receiving state or payloads', async () => {
  const { transport, peers } = fixture();
  const states: string[] = [];
  const received: string[] = [];
  transport.onStateChange(state => { if (state !== 'idle') throw new Error('failed view'); });
  transport.onStateChange(state => states.push(state));
  transport.onData(() => { throw new Error('failed decoder'); });
  transport.onData((_lane, data) => { if (typeof data === 'string') received.push(data); });
  await transport.connect();
  peers[0].channels.get('connect-control-1')!.receive('still delivered');
  await transport.disconnect();
  assert.deepEqual(states, ['idle', 'connecting', 'disconnected']);
  assert.deepEqual(received, ['still delivered']);
});

test('reentrant cancellation during connection and delivery leaves no late channels or callbacks', async () => {
  const cancelled = fixture();
  cancelled.transport.onStateChange(state => { if (state === 'connecting') void cancelled.transport.disconnect(); });
  await cancelled.transport.connect();
  assert.equal(cancelled.peers[0].channels.size, 0);
  assert.equal(cancelled.peers[0].ondatachannel, null);
  assert.equal(cancelled.transport.state, 'disconnected');
  const current = fixture();
  const received: unknown[] = [];
  current.transport.onData(() => { void current.transport.disconnect(); });
  current.transport.onData((_lane, value) => received.push(value));
  await current.transport.connect();
  current.peers[0].channels.get('connect-control-1')!.receive('revoked');
  assert.deepEqual(received, []);
});

test('partial native channel setup failure closes the owned connection and leaves a retryable state', async () => {
  const peer = new Peer();
  const original = peer.createDataChannel.bind(peer);
  peer.createDataChannel = (label, options) => {
    if (label === 'connect-samples-1') throw new Error('channel capacity exhausted');
    return original(label, options);
  };
  const transport = new PeerDataTransport({ initiator: true, createPeer: () => peer as unknown as RTCPeerConnection });
  await assert.rejects(() => transport.connect(), /capacity/);
  assert.equal(peer.connectionState, 'closed');
  assert.equal(peer.channels.get('connect-control-1')!.closed, true);
  assert.equal(peer.ondatachannel, null);
  assert.equal(transport.state, 'failed');
});

test('incoming channel labels cannot downgrade negotiated reliability or change disposable semantics', async () => {
  const { transport, peers } = fixture(false);
  await transport.connect();
  for (const channel of [new Channel('connect-control-1', { ordered: false, maxRetransmits: 0 }),
    new Channel('connect-control-1', { ordered: true, maxPacketLifeTime: 50 }),
    new Channel('connect-samples-1', { ordered: true }),
    new Channel('connect-samples-1', { ordered: false, maxRetransmits: 3 })]) {
    peers[0].offerChannel(channel);
    assert.equal(channel.closed, true);
  }
  assert.equal(transport.isOpen('reliable'), false);
  assert.equal(transport.isOpen('disposable'), false);
  peers[0].offerChannel(new Channel('connect-control-1'));
  peers[0].offerChannel(new Channel('connect-samples-1', { ordered: false, maxRetransmits: 0 }));
  assert.equal(transport.isOpen('reliable'), true);
  assert.equal(transport.isOpen('disposable'), true);
  await transport.disconnect();
});
