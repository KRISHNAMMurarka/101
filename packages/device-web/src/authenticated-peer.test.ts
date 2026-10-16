import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { PeerDataTransport } from '@101/transport-webrtc';
import type { PeerConnectionPort, PeerDataChannelPort } from '@101/transport-webrtc';
import { AuthenticatedResourcePeer, authenticatedPeerScope } from './authenticated-peer.ts';
import type { EndpointCrypto, EndpointIdentity } from './identity-types.ts';
import { endpointKeyId } from './identity-format.ts';
import { PointerResourceProvider, pointerSourceDescriptor } from './pointer-provider.ts';
import { createRemotePointerSurface } from '../../../examples/device-pipelines/remote-pointer.ts';
import { createDeviceRuntime } from '../../device-runtime/src/index.ts';
import { parseDeviceDescriptor, getHapticOutputProfile } from '../../device-model/src/index.ts';
import { RemoteResourcePublisher, RemoteResourceReceiver } from './binding.ts';
import { decodePacket } from './wire.ts';

const crypto: EndpointCrypto = {
  randomBytes(length) { return webcrypto.getRandomValues(new Uint8Array(length)); },
  async sha256(message) { return new Uint8Array(await webcrypto.subtle.digest('SHA-256', new Uint8Array(message))); },
  async verify(publicKey, message, signature) {
    try {
      const key = await webcrypto.subtle.importKey('raw', new Uint8Array(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(signature), new Uint8Array(message));
    } catch { return false; }
  },
};
async function identityFixture() {
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const point = new Uint8Array(await webcrypto.subtle.exportKey('raw', key.publicKey));
  const keyId = await endpointKeyId(point, crypto);
  let current = true;
  const listeners = new Set<() => void>();
  const identity: EndpointIdentity = {
    get publicKey() { return new Uint8Array(point); }, keyId, protection: 'webcrypto-nonextractable',
    async sign(message) { return new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new Uint8Array(message))); },
    async isCurrent() { return current; },
    onInvalidated(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { identity, lose() { current = false; for (const listener of listeners) listener(); }, disappear() { current = false; } };
}

// Faithful delivery-port fixture. Crypto is real; these SDP/data-channel fixtures
// provide contract evidence, never browser DTLS or physical-device qualification.
class Channel implements PeerDataChannelPort {
  readyState = 'open'; bufferedAmount = 0; binaryType = 'arraybuffer'; bufferedAmountLowThreshold = 0;
  readonly ordered: boolean; readonly maxRetransmits: number | null; readonly maxPacketLifeTime: number | null;
  onmessage: PeerDataChannelPort['onmessage'] = null;
  onclose: PeerDataChannelPort['onclose'] = null; onerror: PeerDataChannelPort['onerror'] = null;
  target?: Channel;
  sent: (string | ArrayBuffer)[] = [];
  readonly label: string;
  private queue: (() => void)[];
  constructor(label: string, options: RTCDataChannelInit, queue: (() => void)[]) {
    this.label = label; this.queue = queue;
    this.ordered = options.ordered ?? true; this.maxRetransmits = options.maxRetransmits ?? null;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
  }
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
    const copied = typeof data === 'string' ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer : data.slice(0);
    this.sent.push(copied); this.queue.push(() => { this.target?.onmessage?.({ data: copied }); });
  }
  inject(data: string) { this.onmessage?.({ data }); }
  close() { this.readyState = 'closed'; this.onclose?.({}); }
}
const sdp = (byte: string) => `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\na=sctp-port:5000\r\n`;
class Peer implements PeerConnectionPort {
  connectionState = 'new'; iceGatheringState = 'complete'; localDescription: { type: RTCSdpType; sdp: string } | null = null;
  onconnectionstatechange: PeerConnectionPort['onconnectionstatechange'] = null;
  ondatachannel: PeerConnectionPort['ondatachannel'] = null;
  channels = new Map<string, Channel>();
  remoteDescription?: RTCSessionDescriptionInit;
  private queue: (() => void)[];
  private offerSdp: string;
  private answerSdp: string;
  constructor(queue: (() => void)[], offerSdp: string, answerSdp: string) { this.queue = queue; this.offerSdp = offerSdp; this.answerSdp = answerSdp; }
  createDataChannel(label: string, options: RTCDataChannelInit) { const value = new Channel(label, options, this.queue); this.channels.set(label, value); return value; }
  async createOffer() { return { type: 'offer' as const, sdp: this.offerSdp }; }
  async createAnswer() { return { type: 'answer' as const, sdp: this.answerSdp }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = { type: description.type, sdp: description.sdp! }; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = { ...description }; }
  addEventListener() {} removeEventListener() {}
  async getStats() { return new Map() as unknown as RTCStatsReport; }
  close() { this.connectionState = 'closed'; }
}
async function fixture(options: { app?: string; session?: string; epoch?: string; role?: 'source' | 'receiver'; tamperSdp?: boolean; pinned?: boolean; identities?: Awaited<ReturnType<typeof identityFixture>>[] } = {}) {
  const queue: (() => void)[] = [];
  const aPort = new Peer(queue, sdp('11'), sdp('22')), bPort = new Peer(queue, sdp('11'), sdp('22'));
  const aRaw = new PeerDataTransport({ initiator: true, createPeer: () => aPort });
  const bRaw = new PeerDataTransport({ initiator: false, createPeer: () => bPort });
  await bRaw.connect();
  const offer = await aRaw.createOffer();
  const answer = await bRaw.acceptOffer(options.tamperSdp ? { ...offer, sdp: sdp('33') } : offer);
  await aRaw.acceptAnswer(answer);
  for (const [name, channel] of aPort.channels) {
    const remote = new Channel(name, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits ?? undefined }, queue);
    remote.target = channel; channel.target = remote; bPort.channels.set(name, remote); bPort.ondatachannel?.({ channel: remote });
  }
  for (const port of [aPort, bPort]) { port.connectionState = 'connected'; port.onconnectionstatechange?.({}); }
  const identities = options.identities ?? await Promise.all([identityFixture(), identityFixture()]);
  let now = 100;
  const epoch = 'a'.repeat(32), applicationId = 'pointer-reference', sessionId = 'session-1';
  const a = new AuthenticatedResourcePeer({ transport: aRaw, identity: identities[0].identity, crypto, epoch, applicationId, sessionId,
    role: 'source', now: () => now, expectedRemoteKeyId: options.pinned ? identities[1].identity.keyId : undefined });
  const b = new AuthenticatedResourcePeer({ transport: bRaw, identity: identities[1].identity, crypto,
    epoch: options.epoch ?? epoch, applicationId: options.app ?? applicationId, sessionId: options.session ?? sessionId,
    role: options.role ?? 'receiver', now: () => now, expectedRemoteKeyId: options.pinned ? identities[0].identity.keyId : undefined });
  const pump = async (condition: () => boolean) => {
    for (let turn = 0; turn < 2000 && !condition(); turn++) {
      a.tick(); b.tick(); while (queue.length) queue.shift()!();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(condition(), JSON.stringify([a.status(), b.status()]));
  };
  return { a, b, aRaw, bRaw, aPort, bPort, identities, pump, queue, time: () => now,
    setTime(value: number) { now = value; }, stop() { a.stop(); b.stop(); } };
}

test('resource traffic stays closed until both owners enroll the same verified transcript', async () => {
  const f = await fixture();
  const received: unknown[] = []; f.b.onData((_lane, data) => received.push(data));
  assert.equal(f.a.send('reliable', 'describe'), false); assert.equal(f.a.isOpen('disposable'), false);
  f.aRaw.send('reliable', 'premature descriptor'); f.aRaw.send('disposable', 'premature sample');
  await f.pump(() => f.a.status().phase === 'awaiting-enrollment' && f.b.status().phase === 'awaiting-enrollment');
  assert.deepEqual(received, []); assert.equal(authenticatedPeerScope(f.a), undefined);
  assert.equal(f.a.status().comparisonDigest, f.b.status().comparisonDigest);
  assert.equal(f.a.confirmEnrollment('0'.repeat(64)), false);
  assert.equal(f.a.confirmEnrollment(f.a.status().comparisonDigest!), true);
  await f.pump(() => f.b.status().phase === 'awaiting-enrollment');
  assert.equal(f.a.send('reliable', 'still blocked'), false);
  assert.equal(f.b.confirmEnrollment(f.b.status().comparisonDigest!), true);
  await f.pump(() => f.a.state === 'connected' && f.b.state === 'connected');
  const scope = authenticatedPeerScope(f.b)!;
  assert.equal(scope.applicationId, 'pointer-reference'); assert.equal(scope.sessionId, 'session-1');
  assert.equal(scope.remoteKeyId, f.identities[0].identity.keyId); assert.equal(scope.role, 'receiver');
  assert.equal(authenticatedPeerScope({ ...f.b }), undefined);
  assert.equal(f.a.send('disposable', 'approved sample'), true);
  while (f.queue.length) f.queue.shift()!();
  assert.deepEqual(received, ['approved sample']);
  f.stop(); assert.equal(f.a.send('reliable', 'stale'), false); assert.equal(authenticatedPeerScope(f.b), undefined);
});

test('an enrolled scope delivers typed pointer resources and revocation releases its routes', async () => {
  const f = await fixture();
  const provider = new PointerResourceProvider({ peer: f.a, epoch: 'a'.repeat(32), clockId: 'source-clock', now: f.time,
    platform: 'contract-fixture', available: () => true });
  const surfaceOptions = { peer: f.b, epoch: 'a'.repeat(32), principalId: 'owner', applicationId: 'pointer-reference',
    sessionId: 'session-1', clockId: 'receiver-clock', now: f.time, width: 1000, height: 500 };
  for (const overrides of [{ applicationId: 'another-app' }, { sessionId: 'another-session' }, { epoch: 'b'.repeat(32) }, { peer: f.a }]) {
    assert.throws(() => createRemotePointerSurface({ ...surfaceOptions, ...overrides }), TypeError);
  }
  const surface = createRemotePointerSurface(surfaceOptions);
  provider.tick(); surface.tick();
  assert.equal(provider.driver(), undefined); assert.equal(surface.select(), false);
  await f.pump(() => f.a.status().phase === 'awaiting-enrollment' && f.b.status().phase === 'awaiting-enrollment');
  f.a.confirmEnrollment(f.a.status().comparisonDigest!); f.b.confirmEnrollment(f.b.status().comparisonDigest!);
  await f.pump(() => f.a.state === 'connected' && f.b.state === 'connected');
  await f.pump(() => { provider.tick(); surface.tick(); return !!surface.receiver.description(); });
  assert.equal(surface.select('json/1'), true);
  await f.pump(() => { provider.tick(); surface.tick(); return !!provider.driver() && !!surface.state().position; });
  f.setTime(120);
  provider.driver()!.nudge(0.2, -0.3); provider.driver()!.setContact(true);
  await f.pump(() => { provider.tick(); surface.tick(); return surface.state().contact && !!surface.state().position; })
    .catch(() => assert.fail(JSON.stringify({ provider: provider.status(), receiver: surface.receiver.status(), surface: surface.state() })));
  assert.ok(Math.abs(surface.state().position!.x - 700) < 0.001 && Math.abs(surface.state().position!.y - 100) < 0.001);
  f.setTime(140);
  const sample = { protocol: 'connect', version: 1, type: 'sample', epoch: 'a'.repeat(32),
    slot: 1, sequence: 100, capturedAt: 140, value: { x: 0.4, y: 0.6 } };
  assert.equal(f.a.send('disposable', JSON.stringify(sample)), true);
  while (f.queue.length) f.queue.shift()!(); surface.tick();
  assert.deepEqual(surface.state().position, { x: 400, y: 300 });
  for (const [field, value] of Object.entries({ sourceId: 'other-device', sinkRegistrationId: 'other-sink',
    sessionId: 'other-session', permissions: ['write'] })) {
    assert.equal(f.a.send('disposable', JSON.stringify({ ...sample, sequence: 101, [field]: value })), true);
    while (f.queue.length) f.queue.shift()!(); surface.tick();
    assert.deepEqual(surface.state().position, { x: 400, y: 300 }, `${field} changed the authorized sink`);
  }
  surface.resize(500, 1000);
  assert.ok(Math.abs(surface.state().position!.x - 200) < 0.001 && Math.abs(surface.state().position!.y - 600) < 0.001);
  f.identities[1].lose();
  assert.equal(surface.state().position, undefined); assert.equal(surface.state().contact, false);
  assert.equal(surface.state().releases, 2); assert.equal(authenticatedPeerScope(f.b), undefined);
  provider.stop(); surface.stop(); f.stop();
});

test('owner-pinned endpoint keys authenticate without first-use comparison', async () => {
  const f = await fixture({ pinned: true });
  await f.pump(() => f.a.state === 'connected' && f.b.state === 'connected');
  assert.equal(f.a.status().trust, 'key-pin'); f.stop();
});

test('a changed actual SDP fingerprint cannot reuse valid endpoint metadata and signatures', async () => {
  const f = await fixture({ tamperSdp: true, pinned: true });
  await f.pump(() => f.a.status().phase === 'stopped' || f.b.status().phase === 'stopped');
  assert.equal(authenticatedPeerScope(f.a), undefined); assert.equal(authenticatedPeerScope(f.b), undefined);
  f.stop();
});

test('cross-application, session, epoch and reflected roles never acquire a resource scope', async () => {
  for (const options of [{ app: 'another-app' }, { session: 'another-session' }, { epoch: 'b'.repeat(32) }, { role: 'source' as const }]) {
    const f = await fixture({ ...options, pinned: true });
    await f.pump(() => f.a.status().phase === 'stopped' || f.b.status().phase === 'stopped');
    assert.equal(authenticatedPeerScope(f.a), undefined); assert.equal(authenticatedPeerScope(f.b), undefined); f.stop();
  }
});

test('copied public metadata signed by another key is rejected', async () => {
  const identities = await Promise.all([identityFixture(), identityFixture()]);
  const stolen = await identityFixture();
  const signer = identities[0].identity.sign;
  identities[0].identity = { ...stolen.identity, sign: signer };
  const f = await fixture({ identities, pinned: true });
  await f.pump(() => f.a.status().phase === 'stopped' || f.b.status().phase === 'stopped');
  assert.equal(authenticatedPeerScope(f.a), undefined); assert.equal(authenticatedPeerScope(f.b), undefined); f.stop();
});

test('old hello and proof cannot authenticate a fresh challenge even if epoch and keys are reused', async () => {
  const identities = await Promise.all([identityFixture(), identityFixture()]);
  const first = await fixture({ identities, pinned: true });
  await first.pump(() => first.a.state === 'connected' && first.b.state === 'connected');
  const packets = first.aPort.channels.get('connect-control-1')!.sent.filter((data): data is string => typeof data === 'string');
  first.stop();
  const fresh = await fixture({ identities, pinned: true });
  for (const packet of packets) fresh.bPort.channels.get('connect-control-1')!.inject(packet);
  await fresh.pump(() => fresh.b.status().phase === 'stopped');
  assert.equal(authenticatedPeerScope(fresh.b), undefined); fresh.stop();
});

test('challenge timeout, synchronous revocation and external key loss retire current resources', async () => {
  const pending = await fixture();
  await pending.pump(() => pending.a.status().phase === 'awaiting-enrollment');
  pending.setTime(60001); pending.a.tick(); assert.equal(pending.a.status().phase, 'stopped'); pending.stop();
  const revoked = await fixture({ pinned: true });
  await revoked.pump(() => revoked.a.state === 'connected' && revoked.b.state === 'connected');
  revoked.identities[0].lose();
  assert.equal(authenticatedPeerScope(revoked.a), undefined); assert.equal(revoked.a.send('reliable', 'stale'), false); revoked.stop();
  const lost = await fixture({ pinned: true });
  await lost.pump(() => lost.a.state === 'connected' && lost.b.state === 'connected');
  lost.identities[0].disappear(); lost.setTime(1101);
  await lost.pump(() => lost.a.status().phase === 'stopped');
  assert.equal(authenticatedPeerScope(lost.a), undefined); lost.stop();
});

test('disconnect during an outstanding cryptographic await cannot activate a replacement generation', async () => {
  const f = await fixture({ pinned: true });
  f.a.tick(); f.b.tick(); await f.aRaw.disconnect();
  await f.pump(() => f.a.status().phase === 'stopped');
  assert.equal(authenticatedPeerScope(f.a), undefined); assert.equal(f.a.isOpen('reliable'), false); f.stop();
});

test('a stalled identity currency check retires idle resources within its freshness bound', async () => {
  const f = await fixture({ pinned: true });
  await f.pump(() => f.a.state === 'connected' && f.b.state === 'connected');
  f.identities[0].identity.isCurrent = () => new Promise(() => {});
  f.setTime(1101); f.a.tick();
  f.setTime(2101); f.a.tick();
  assert.equal(f.a.status().phase, 'stopped');
  f.stop();
});

// Real endpoint cryptography over the documented native WebSocket port surface.
// This fixture qualifies protocol rules; the TLS/browser tool supplies transport evidence.
class WssSocket {
  readyState = 1; protocol = '101-resource-wss-1'; binaryType = 'arraybuffer'; bufferedAmount = 0;
  onopen: ((event: unknown) => void) | null = null; onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null;
  target?: WssSocket; queue: (() => void)[];
  constructor(queue: (() => void)[]) { this.queue = queue; }
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
    if (this.readyState !== 1) throw new Error('socket closed');
    const copy = typeof data === 'string' ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer : data.slice(0);
    this.queue.push(() => this.target?.onmessage?.({ data: copy }));
  }
  close() { this.readyState = 3; this.onclose?.({}); }
}
async function wssFixture(options: { pinned?: boolean; applicationId?: string; sessionId?: string; epoch?: string; keyId?: string;
  identities?: Awaited<ReturnType<typeof identityFixture>>[]; cryptos?: EndpointCrypto[] } = {}) {
  const { SecureWebSocketTransport } = await import('@101/transport-websocket');
  const queue: (() => void)[] = [], left = new WssSocket(queue), right = new WssSocket(queue); left.target = right; right.target = left;
  let now = 100;
  const aRaw = new SecureWebSocketTransport({ endpoint: 'wss://localhost/connect', side: 'client', createSocket: () => left, now: () => now });
  const bRaw = new SecureWebSocketTransport({ endpoint: 'wss://localhost/connect', side: 'server', socket: right, now: () => now });
  await aRaw.connect(); await bRaw.connect();
  const identities = options.identities ?? await Promise.all([identityFixture(), identityFixture()]);
  const scope = { epoch: 'c'.repeat(32), applicationId: 'wss-pointer', sessionId: 'wss-session', now: () => now };
  const a = new AuthenticatedResourcePeer({ transport: aRaw, identity: identities[0].identity, crypto: options.cryptos?.[0] ?? crypto, ...scope, role: 'source',
    expectedRemoteKeyId: options.keyId ?? (options.pinned ? identities[1].identity.keyId : undefined) });
  const b = new AuthenticatedResourcePeer({ transport: bRaw, identity: identities[1].identity, crypto: options.cryptos?.[1] ?? crypto, ...scope,
    applicationId: options.applicationId ?? scope.applicationId, sessionId: options.sessionId ?? scope.sessionId,
    epoch: options.epoch ?? scope.epoch, role: 'receiver', expectedRemoteKeyId: options.pinned ? identities[0].identity.keyId : undefined });
  const pump = async (condition: () => boolean) => {
    for (let turn = 0; turn < 2000 && !condition(); turn++) {
      aRaw.tick(); bRaw.tick(); a.tick(); b.tick(); while (queue.length) queue.shift()!();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(condition(), JSON.stringify([a.status(), b.status()]));
  };
  return { a, b, aRaw, bRaw, identities, pump, queue, time: () => now, setTime(value: number) { now = value; }, stop() { a.stop(); b.stop(); } };
}

test('WSS endpoint enrollment protects the same typed resource path without diagnostic authority', async () => {
  const f = await wssFixture(); const values: unknown[] = []; f.b.onData((_lane, value) => values.push(value));
  assert.equal(f.a.send('disposable', 'premature'), false);
  await f.pump(() => f.a.status().phase === 'awaiting-enrollment' && f.b.status().phase === 'awaiting-enrollment');
  assert.equal(f.a.status().comparisonDigest, f.b.status().comparisonDigest);
  f.a.confirmEnrollment(f.a.status().comparisonDigest!);
  assert.equal(f.a.send('reliable', 'unilateral'), false); assert.equal(authenticatedPeerScope(f.a), undefined);
  f.b.confirmEnrollment(f.b.status().comparisonDigest!); await f.pump(() => f.a.state === 'connected' && f.b.state === 'connected');
  assert.equal(authenticatedPeerScope({ ...f.a }), undefined);
  const provider = new PointerResourceProvider({ peer: f.a, epoch: 'c'.repeat(32), clockId: 'source-clock', now: f.time, platform: 'wss-fixture', available: () => true });
  const surface = createRemotePointerSurface({ peer: f.b, epoch: 'c'.repeat(32), principalId: 'owner', applicationId: 'wss-pointer',
    sessionId: 'wss-session', clockId: 'receiver-clock', now: f.time, width: 400, height: 200 });
  await f.pump(() => { provider.tick(); surface.tick(); return !!surface.receiver.description(); }); assert.equal(surface.select(), true);
  await f.pump(() => { provider.tick(); surface.tick(); return !!provider.driver() && !!surface.state().position; });
  f.setTime(120); provider.driver()!.nudge(0.2, -0.3); provider.driver()!.setContact(true);
  await f.pump(() => { provider.tick(); surface.tick(); return surface.state().contact && !!surface.state().position; });
  assert.ok(Math.abs(surface.state().position!.x - 280) < 0.001 && Math.abs(surface.state().position!.y - 40) < 0.001);
  f.setTime(150);
  f.a.send('disposable', JSON.stringify({ protocol: 'connect', version: 1, type: 'sample', epoch: 'c'.repeat(32), slot: 1, sequence: 99, capturedAt: 1, value: { x: 0.1, y: 0.1 } }));
  while (f.queue.length) f.queue.shift()!(); surface.tick(); assert.ok(Math.abs(surface.state().position!.x - 280) < 0.001 && Math.abs(surface.state().position!.y - 40) < 0.001);
  f.identities[0].lose(); assert.equal(surface.state().contact, true); // Local source loss cannot recall the socket's remote state.
  f.setTime(700); surface.tick(); assert.equal(surface.state().contact, false); assert.equal(surface.state().position, undefined);
  provider.stop(); surface.stop(); f.stop();
});

test('WSS actual key pins and exact application/session/epoch scopes fail closed', async () => {
  const pinned = await wssFixture({ pinned: true }); await pinned.pump(() => pinned.a.state === 'connected' && pinned.b.state === 'connected');
  assert.equal(authenticatedPeerScope(pinned.a)?.remoteKeyId, pinned.identities[1].identity.keyId); pinned.stop();
  for (const options of [{ applicationId: 'another-app' }, { sessionId: 'another-session' }, { epoch: 'd'.repeat(32) }, { keyId: '0'.repeat(64) }]) {
    const f = await wssFixture(options); await f.pump(() => f.a.state === 'failed' || f.b.state === 'failed');
    assert.equal(authenticatedPeerScope(f.a), undefined); assert.equal(authenticatedPeerScope(f.b), undefined); f.stop();
  }
});

test('WSS reconnect and clock rollback retire old authenticated authority', async () => {
  const f = await wssFixture({ pinned: true }); await f.pump(() => f.a.state === 'connected' && f.b.state === 'connected');
  const binding = f.aRaw.sessionBinding(); await f.aRaw.disconnect(); assert.equal(authenticatedPeerScope(f.a), undefined);
  assert.equal(f.aRaw.isCurrentSession(binding), false); assert.equal(f.a.send('reliable', 'stale grant'), false);
  f.setTime(99); f.b.tick(); assert.equal(authenticatedPeerScope(f.b), undefined); f.stop();
});


test('fresh WSS negotiation defeats proof replay even when auth challenges and scope are reused', async () => {
  const identities = await Promise.all([identityFixture(), identityFixture()]);
  const original = identities[0].identity.sign;
  let captured: Uint8Array | undefined;
  identities[0].identity.sign = async message => { captured = await original(message); return captured; };
  const cryptos = [11, 22].map(byte => ({ ...crypto, randomBytes(length: number) { return new Uint8Array(length).fill(byte); } }));
  const first = await wssFixture({ identities, cryptos, pinned: true });
  await first.pump(() => first.a.state === 'connected' && first.b.state === 'connected'); first.stop();
  assert.ok(captured);
  identities[0].identity.sign = async () => new Uint8Array(captured!);
  const replacement = await wssFixture({ identities, cryptos, pinned: true });
  await replacement.pump(() => replacement.a.state === 'failed');
  assert.equal(authenticatedPeerScope(replacement.a), undefined); assert.equal(authenticatedPeerScope(replacement.b), undefined); replacement.stop();
});

test('WSS cancellation during a cryptographic await cannot issue a late scope', async () => {
  const identities = await Promise.all([identityFixture(), identityFixture()]); const original = identities[0].identity.sign;
  let entered = false, release: () => void = () => {};
  const deferred = new Promise<void>(resolve => { release = resolve; });
  identities[0].identity.sign = async message => { entered = true; await deferred; return original(message); };
  const f = await wssFixture({ identities, pinned: true }); await f.pump(() => entered); f.a.stop(); release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(authenticatedPeerScope(f.a), undefined); assert.equal(f.a.send('reliable', 'late proof'), false); f.stop();
});

test('authenticated receiver refuses an invoke-only advertised resource before issuing a bind', { timeout: 10000 }, async t => {
  const f = await fixture();
  const epoch = 'a'.repeat(32);
  const grant = Object.freeze({ expiresAt: 10000, maxAgeMs: 100, maxHz: 10 });
  const pointer = pointerSourceDescriptor('contract-fixture');
  const haptic = getHapticOutputProfile('app:browser-haptic-presets/1').capability;
  const device = parseDeviceDescriptor({ ...pointer, id: 'mixed-pointer-haptic', capabilities: [...pointer.capabilities, haptic] });
  const position = device.capabilities.find(capability => capability.id === 'position')!;
  const positionDevice = parseDeviceDescriptor({ ...device, id: 'owned-position-sink', capabilities: [
    { ...position, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } },
  ] });
  const hapticDevice = parseDeviceDescriptor({ ...device, id: 'owned-haptic-sink', capabilities: [haptic] });
  const received: unknown[] = [];
  let hapticApplies = 0, authorizationCalls = 0, sourceRegistrations = 0, sourceRegistrationId = '', positionSinkId = '';
  const runtime = createDeviceRuntime({ now: f.time, clockDomain: 'receiver-clock', authorize(request) {
    authorizationCalls++;
    if (request.principalId !== 'owner' || request.applicationId !== 'pointer-reference' || request.sessionId !== 'session-1' ||
      request.source.registrationId !== sourceRegistrationId || request.source.deviceId !== device.id || request.source.capabilityId !== 'position' ||
      request.source.descriptorRevision !== device.revision || request.source.schemaVersion !== position.schemaVersion ||
      request.sink.registrationId !== positionSinkId || request.sink.deviceId !== positionDevice.id || request.sink.capabilityId !== 'position' ||
      request.sink.descriptorRevision !== positionDevice.revision || request.sink.schemaVersion !== position.schemaVersion ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || request.partition !== undefined) return;
    return grant;
  } });
  // Observe the public boundary without replacing registration or authorization.
  const registerSource = runtime.registerSource.bind(runtime);
  runtime.registerSource = provider => {
    sourceRegistrations++;
    const handle = registerSource(provider); sourceRegistrationId = handle.id; return handle;
  };
  const hapticSink = runtime.registerSink({ device: hapticDevice, capability: 'preset',
    apply() { hapticApplies++; }, release() {} });
  const positionSink = runtime.registerSink({ device: positionDevice, capability: 'position',
    apply(observation, context) { if (context.isCurrent()) received.push(observation.value); }, release() {} });
  positionSinkId = positionSink.id;
  runtime.setReadiness(hapticSink, 'available'); runtime.setReadiness(positionSink, 'available');
  const receiver = new RemoteResourceReceiver({ peer: f.b, epoch, clockId: 'receiver-clock', now: f.time, runtime,
    principalId: 'owner', applicationId: 'pointer-reference', sessionId: 'session-1' });
  const publisher = new RemoteResourcePublisher({ peer: f.a, epoch, clockId: 'source-clock', now: f.time,
    device, available: () => true });
  const binds = () => [...f.bPort.channels.values()].flatMap(channel => channel.sent)
    .filter(data => decodePacket(data, 'reliable')?.packet.type === 'bind').length;
  try {
    await f.pump(() => f.a.status().phase === 'awaiting-enrollment' && f.b.status().phase === 'awaiting-enrollment');
    assert.equal(f.a.confirmEnrollment(f.a.status().comparisonDigest!), true);
    assert.equal(f.b.confirmEnrollment(f.b.status().comparisonDigest!), true);
    await f.pump(() => f.a.state === 'connected' && f.b.state === 'connected');
    assert.ok(authenticatedPeerScope(f.a)); assert.ok(authenticatedPeerScope(f.b));
    assert.equal(publisher.start(), true);
    await f.pump(() => { publisher.tick(); receiver.tick(); return !!receiver.description() && receiver.status().clockReady; });
    const advertised = receiver.description()!.capabilities.find(capability => capability.id === 'preset');
    assert.ok(advertised); assert.equal(advertised.kind, 'command'); assert.deepEqual(advertised.permissions, ['invoke']);
    const beforeBinds = binds();
    assert.equal(receiver.approve({ capability: 'preset', sink: hapticSink, sinkDevice: hapticDevice,
      sinkCapability: 'preset', codec: 'json/1', grant }), undefined);
    assert.equal(binds(), beforeBinds);
    assert.equal(sourceRegistrations, 0); assert.equal(authorizationCalls, 0);
    assert.equal(receiver.status().pending, 0); assert.equal(receiver.status().active, 0);
    assert.equal(publisher.isBound('preset'), false); assert.equal(hapticApplies, 0);

    // A supported capability from the same enrolled producer must still work.
    assert.equal(receiver.approve({ capability: 'position', sink: positionSink, sinkDevice: positionDevice,
      sinkCapability: 'position', codec: 'json/1', grant }), 1);
    await f.pump(() => { publisher.tick(); receiver.tick(); return publisher.isBound('position') && receiver.status().active === 1; });
    assert.equal(sourceRegistrations, 1); assert.equal(authorizationCalls, 1); assert.equal(binds(), beforeBinds + 1);
    f.setTime(120);
    assert.equal(publisher.publish('position', { x: 0.25, y: 0.75 }), true);
    await f.pump(() => { publisher.tick(); receiver.tick(); return received.length === 1; });
    assert.deepEqual(received, [{ x: 0.25, y: 0.75 }]); assert.equal(hapticApplies, 0);
    assert.equal(publisher.isBound('preset'), false);
    t.diagnostic(JSON.stringify({ negative: { advertisedKind: advertised.kind, permissions: advertised.permissions,
      bindDelta: 0, sourceRegistrations: 0, authorizationCalls: 0, hapticApplies },
    positive: { bindDelta: binds() - beforeBinds, sourceRegistrations, authorizationCalls, positionApplies: received.length },
    scope: 'Real crypto and faithful queued ports; no browser DTLS, native API, physical haptics or complete S03 qualification.' }));
  } finally {
    publisher.stop(); receiver.stop(); runtime.close(); f.stop();
    await Promise.all([f.aRaw.disconnect(), f.bRaw.disconnect()]);
    for (let turn = 0; f.queue.length && turn < 2000; turn++) f.queue.shift()!();
    const cleaned = f.queue.length === 0 && f.a.status().phase === 'stopped' && f.b.status().phase === 'stopped' &&
      f.aPort.connectionState === 'closed' && f.bPort.connectionState === 'closed';
    t.diagnostic(JSON.stringify({ cleanup: { cleaned, queuedCallbacks: f.queue.length,
      sourceTransport: f.aPort.connectionState, receiverTransport: f.bPort.connectionState } }));
    assert.equal(cleaned, true);
  }
});
