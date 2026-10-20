import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthenticatedResourcePeer, PeerDataTransport, RemoteResourcePublisher, createEphemeralWebIdentity,
  decodeManualPeerCode, decodeReceiverInvitation, encodeManualPeerCode, parseDeviceDescriptor, webEndpointCrypto } from '@101/connect';
import type { PeerConnectionPort, PeerDataChannelPort } from '@101/connect';
import { createEnrolledDeviceInspector, formatEnrolledPrimitiveValue, inspectEnrolledResources } from './enrolled-device.ts';
import { pageReadingDescriptor } from '../connections/readings/readings-schema.ts';

const scope = { sessionId: 'owned-test-room', now: () => 1000, wallNow: () => 10000 };
const descriptor = { schemaVersion: 1, id: 'owned-software-meter', label: 'Software meter', revision: 1,
  adapter: { id: 'owned:software', version: '1.0.0' }, runtime: { platform: 'browser-timer' }, capabilities: [
    { id: 'level', semantic: 'software:counter', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
      value: { type: 'scalar', unit: '1', min: 0, max: 100 }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 } },
    { id: 'switch', semantic: 'software:switch', schemaVersion: 1, kind: 'command', permissions: ['invoke'],
      value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 250 } },
  ] };

test('arrival and resource declarations issue no enrollment, preview or native work', async () => {
  let factories = 0;
  const controller = createEnrolledDeviceInspector({ ...scope, createIdentity: async () => { factories++; return createEphemeralWebIdentity(); } });
  assert.equal(factories, 0); assert.equal(controller.snapshot().current, undefined);
  assert.equal(controller.snapshot().rawPending, 0); assert.equal(controller.snapshot().timerArmed, false);
  const resources = inspectEnrolledResources(descriptor);
  assert.deepEqual(resources.map(value => [value.id, value.previewable]), [['level', true], ['switch', false]]);
  assert.equal(controller.preview(['level']), false); assert.equal(factories, 0);
  await controller.close();
});

test('command declarations and unknown schemas cannot become preview operations', () => {
  assert.equal(inspectEnrolledResources(descriptor)[1]?.previewable, false);
  const text = { ...descriptor, capabilities: [{ ...descriptor.capabilities[0], value: { type: 'enum', values: ['idle', 'ready'] } }] };
  assert.equal(inspectEnrolledResources(text)[0]?.previewable, false);
  const readOnly = { ...descriptor, capabilities: [{ ...descriptor.capabilities[0], kind: 'property', permissions: ['read'] }] };
  assert.equal(inspectEnrolledResources(readOnly)[0]?.previewable, false);
  assert.deepEqual(inspectEnrolledResources({ ...descriptor, capabilities: [] }), []);
});

test('inspection snapshots declared fields without invoking descriptor getters', () => {
  let calls = 0;
  assert.throws(() => inspectEnrolledResources({ ...descriptor, get capabilities() { calls++; return descriptor.capabilities; } }));
  assert.equal(calls, 0);
  const rows = inspectEnrolledResources(descriptor);
  assert.equal(Object.isFrozen(rows), true); assert.equal(Object.isFrozen(rows[0]), true);
});

test('primitive preview wording follows validated type, unit and vector component metadata', () => {
  const resources = inspectEnrolledResources({ ...descriptor, capabilities: [
    { id: 'switch', semantic: 'vendor:opaque-switch', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
      value: { type: 'boolean' }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 } },
    { id: 'temperature', semantic: 'vendor:opaque-measurement', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
      value: { type: 'scalar', unit: 'Cel', min: -100, max: 100 }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 } },
    { id: 'position', semantic: 'vendor:opaque-vector', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
      value: { type: 'vector', unit: 'm', frame: 'screen', components: ['x', 'y'], min: -10, max: 10 },
      delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 } },
    { id: 'ratio', semantic: 'vendor:opaque-ratio', schemaVersion: 1, kind: 'sample', permissions: ['subscribe'],
      value: { type: 'scalar', unit: '1', min: 0, max: 1 }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 250 } },
  ] });
  assert.deepEqual(resources.map(resource => resource.primitive?.type), ['boolean', 'scalar', 'vector', 'scalar']);
  assert.equal(formatEnrolledPrimitiveValue(resources[0]!, false), 'Off');
  assert.equal(formatEnrolledPrimitiveValue(resources[0]!, true), 'On');
  assert.equal(formatEnrolledPrimitiveValue(resources[1]!, 21.5), '21.5 Cel');
  assert.equal(formatEnrolledPrimitiveValue(resources[2]!, { x: 0.5, y: 0.25 }), 'x: 0.5 m, y: 0.25 m');
  assert.equal(formatEnrolledPrimitiveValue(resources[3]!, 0.25), '0.25');
  assert.equal(formatEnrolledPrimitiveValue(resources[0]!, 1), undefined);
  assert.equal(formatEnrolledPrimitiveValue(resources[1]!, Infinity), undefined);
  assert.equal(formatEnrolledPrimitiveValue(resources[2]!, { x: 0.5, z: 0.25 }), undefined);
});

test('resource labels use declared types and stable ordinals while preserving connector identity', () => {
  const capabilities = [
    { ...descriptor.capabilities[0], id: 'switch-a', semantic: 'vendor:opaque-switch', value: { type: 'boolean' } },
    { ...descriptor.capabilities[0], id: 'number-a', semantic: 'vendor:opaque-value-a', value: { type: 'scalar', unit: 'Cel', min: -100, max: 100 } },
    { ...descriptor.capabilities[0], id: 'vector-a', semantic: 'vendor:opaque-vector',
      value: { type: 'vector', unit: 'm', frame: 'screen', components: ['x', 'y'], min: -10, max: 10 } },
    { ...descriptor.capabilities[0], id: 'number-b', semantic: 'vendor:opaque-value-b', value: { type: 'scalar', unit: '1', min: 0, max: 1 } },
    descriptor.capabilities[1],
  ];
  const rows = inspectEnrolledResources({ ...descriptor, capabilities });
  assert.deepEqual(rows.map(row => row.label), ['On/off input', 'Number input 1', 'Multi-value input', 'Number input 2', 'Action']);
  assert.deepEqual(rows.map(row => [row.id, row.semantic]), capabilities.map(row => [row.id, row.semantic]));
  assert.deepEqual(rows.map(row => row.previewable), [true, true, true, true, false]);
});

test('cancelled identity setup remains reserved and close waits for its actual settlement', async () => {
  let resolve!: (identity: Awaited<ReturnType<typeof createEphemeralWebIdentity>>) => void;
  const identity = await createEphemeralWebIdentity();
  const held = new Promise<typeof identity>(done => { resolve = done; });
  const controller = createEnrolledDeviceInspector({ ...scope, createIdentity: () => held });
  const first = controller.prepare(); await Promise.resolve();
  controller.cancel(); assert.equal(await first, false);
  assert.ok(controller.snapshot().rawPending >= 1, 'logical cancellation retains issued identity work and any cleanup still settling');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(controller.snapshot().rawPending, 1); assert.equal(await controller.prepare(), false);
  let closed = false; const closing = controller.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  resolve(identity); await closing;
  assert.equal(controller.snapshot().rawPending, 0); assert.equal(controller.snapshot().invitation, undefined);
});

test('identity factory close reentry cannot resolve close before late factory work settles', async () => {
  const identity = await createEphemeralWebIdentity();
  let release!: () => void, retained: Promise<void> | undefined, closed = false;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const controller = createEnrolledDeviceInspector({ ...scope, createIdentity: async () => {
    retained = controller.close().then(() => { closed = true; }); await hold; return identity;
  } });
  const preparing = controller.prepare(); await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, false); assert.equal(await preparing, false);
  assert.equal(controller.snapshot().rawPending, 1);
  release(); await retained;
  assert.equal(closed, true); assert.equal(controller.snapshot().rawPending, 0);
});

test('incomplete or mismatched offer is rejected before a native peer is constructed', async () => {
  let peers = 0;
  const controller = createEnrolledDeviceInspector({ ...scope, createPeer: () => { peers++; throw Error('must not dispatch'); } });
  assert.equal(await controller.prepare(), true);
  assert.equal(await controller.acceptOffer('not an offer'), false);
  assert.equal(peers, 0); assert.equal(controller.snapshot().current, undefined);
  assert.equal(controller.snapshot().timerArmed, false);
  await controller.close();
});

test('backward or invalid clock retires an outstanding invitation and forbids dispatch', async () => {
  let at = 1000, peers = 0;
  const controller = createEnrolledDeviceInspector({ ...scope, now: () => at, createPeer: () => { peers++; throw Error(); } });
  assert.equal(await controller.prepare(), true); at = 999; controller.tick();
  assert.equal(controller.snapshot().invitation, undefined); assert.equal(controller.snapshot().state, 'interrupted');
  assert.equal(await controller.acceptOffer('{}'), false); assert.equal(peers, 0);
  await controller.close();
});

test('forged removal and comparison handles cannot acquire or retire a connection', async () => {
  const controller = createEnrolledDeviceInspector(scope);
  assert.equal(controller.confirm('a'.repeat(64)), false); assert.equal(controller.activate(), false);
  assert.equal(controller.remove({ kind: 'enrolled-device' }), false);
  assert.equal(controller.snapshot().current, undefined); assert.equal(controller.snapshot().rawPending, 0);
  await controller.close();
});

test('clock callback cancellation before identity dispatch leaves no provisional authority', async () => {
  let factories = 0, cancelOnRead = false;
  const controller = createEnrolledDeviceInspector({ ...scope, now: () => {
    if (cancelOnRead) controller.cancel(); return 1000;
  }, createIdentity: async () => { factories++; return createEphemeralWebIdentity(); } });
  cancelOnRead = true;
  assert.equal(await controller.prepare(), false); assert.equal(factories, 0);
  assert.equal(controller.snapshot().invitation, undefined); assert.equal(controller.snapshot().timerArmed, false);
  await controller.close();
});

test('a view callback cannot reenter setup and exceed the single outstanding native reservation', async () => {
  const identity = await createEphemeralWebIdentity(); let factories = 0, nested: Promise<boolean> | undefined;
  const controller = createEnrolledDeviceInspector({ ...scope, createIdentity: async () => { factories++; return identity; }, onChange(value) {
    if (value.outcome === 'cancelled') nested = controller.prepare();
  } });
  assert.equal(await controller.prepare(), true); assert.equal(await nested, false); assert.equal(factories, 1);
  await controller.close();
});

test('a prepared invitation expires without dispatch and is never renewed by inspection', async () => {
  let at = 1000, wall = 10000, peers = 0;
  const controller = createEnrolledDeviceInspector({ ...scope, now: () => at, wallNow: () => wall,
    createPeer: () => { peers++; throw Error('expired invitation must stay inert'); } });
  assert.equal(await controller.prepare(), true); const original = controller.snapshot().invitation;
  assert.ok(original); at = 61000; wall = 70000; controller.tick();
  assert.equal(controller.snapshot().invitation, undefined); assert.equal(controller.snapshot().timerArmed, false);
  assert.equal(await controller.acceptOffer(original), false); assert.equal(peers, 0);
  await controller.close();
});

test('setup attempt quota prevents another identity creation after cancelled tasks', async () => {
  const identity = await createEphemeralWebIdentity(); let factories = 0;
  const controller = createEnrolledDeviceInspector({ ...scope, createIdentity: async () => { factories++; return identity; } });
  for (let attempt = 0; attempt < 16; attempt++) {
    assert.equal(await controller.prepare(), true); controller.cancel();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(await controller.prepare(), false); assert.equal(factories, 16);
  assert.equal(controller.snapshot().invitation, undefined); await controller.close();
});

test('retiring actual public RTC transport does not free a still-issued description Promise', async () => {
  // Cooperative raw-port lifecycle fixture only: no endpoint proof, native RTC or positive resource claim.
  let release!: () => void, enter!: () => void, closes = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
  const native: PeerConnectionPort = { connectionState: 'new', iceGatheringState: 'complete', localDescription: null,
    onconnectionstatechange: null, ondatachannel: null,
    createDataChannel() { throw Error('receiver creates no channel'); }, createOffer: async () => { throw Error('receiver creates no offer'); },
    createAnswer: async () => ({ type: 'answer', sdp: 'owned lifecycle fixture only' }), setLocalDescription: async () => {},
    setRemoteDescription: async () => { enter(); await held; }, addEventListener() {}, removeEventListener() {},
    getStats: async () => new Map() as RTCStatsReport, close() { closes++; },
  };
  const controller = createEnrolledDeviceInspector({ ...scope, createPeer: () => new PeerDataTransport({ initiator: false, createPeer: () => native }) });
  assert.equal(await controller.prepare(), true);
  const invitation = JSON.parse(controller.snapshot().invitation!);
  const accepting = controller.acceptOffer(encodeManualPeerCode(invitation.epoch, { type: 'offer', sdp: 'owned lifecycle fixture only' }));
  await entered; controller.cancel(); assert.equal(await accepting, false); assert.equal(closes, 1);
  let closed = false; const closing = controller.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.ok(controller.snapshot().rawPending > 0);
  release(); await closing; assert.equal(controller.snapshot().rawPending, 0); assert.equal(closes, 1);
  assert.equal(controller.snapshot().current, undefined); assert.equal(controller.snapshot().answer, undefined);
});

// Cooperative delivery ports, real P-256 proof and actual public publisher/receiver/runtime.
// These SDP/channel ports prove the selected software route, never native RTC or hardware.
class PreviewChannel implements PeerDataChannelPort {
  readyState = 'open'; bufferedAmount = 0; binaryType = 'arraybuffer'; bufferedAmountLowThreshold = 0;
  readonly ordered: boolean; readonly maxRetransmits: number | null; readonly maxPacketLifeTime: number | null;
  onmessage: PeerDataChannelPort['onmessage'] = null;
  onclose: PeerDataChannelPort['onclose'] = null; onerror: PeerDataChannelPort['onerror'] = null;
  target?: PreviewChannel;
  readonly label: string;
  private queue: (() => void)[];
  constructor(label: string, options: RTCDataChannelInit, queue: (() => void)[]) {
    this.label = label; this.queue = queue;
    this.ordered = options.ordered ?? true; this.maxRetransmits = options.maxRetransmits ?? null;
    this.maxPacketLifeTime = options.maxPacketLifeTime ?? null;
  }
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) {
    const copied = typeof data === 'string' ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer : data.slice(0);
    this.queue.push(() => { this.target?.onmessage?.({ data: copied }); });
  }
  close() { this.readyState = 'closed'; this.onclose?.({}); }
}
const previewSdp = (byte: string) => `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\na=sctp-port:5000\r\n`;
class PreviewPeer implements PeerConnectionPort {
  connectionState = 'new'; iceGatheringState = 'complete'; localDescription: { type: RTCSdpType; sdp: string } | null = null;
  onconnectionstatechange: PeerConnectionPort['onconnectionstatechange'] = null;
  ondatachannel: PeerConnectionPort['ondatachannel'] = null;
  channels = new Map<string, PreviewChannel>();
  private queue: (() => void)[];
  constructor(queue: (() => void)[]) { this.queue = queue; }
  createDataChannel(label: string, options: RTCDataChannelInit) {
    const channel = new PreviewChannel(label, options, this.queue); this.channels.set(label, channel); return channel;
  }
  async createOffer() { return { type: 'offer' as const, sdp: previewSdp('11') }; }
  async createAnswer() { return { type: 'answer' as const, sdp: previewSdp('22') }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = { type: description.type, sdp: description.sdp! }; }
  async setRemoteDescription() {}
  addEventListener() {} removeEventListener() {}
  async getStats() { return new Map() as unknown as RTCStatsReport; }
  close() { this.connectionState = 'closed'; }
}

test('an enrolled preview retains a valid __proto__ capability as an own scalar value', async () => {
  const queue: (() => void)[] = [], sourcePort = new PreviewPeer(queue), receiverPort = new PreviewPeer(queue);
  const sourcePeer = new PeerDataTransport({ initiator: true, createPeer: () => sourcePort });
  const controller = createEnrolledDeviceInspector({ ...scope,
    createPeer: () => new PeerDataTransport({ initiator: false, createPeer: () => receiverPort }) });
  let auth: AuthenticatedResourcePeer | undefined, publisher: RemoteResourcePublisher | undefined;
  try {
    assert.equal(await controller.prepare(), true);
    const invitation = decodeReceiverInvitation(controller.snapshot().invitation!, scope.wallNow());
    auth = new AuthenticatedResourcePeer({ transport: sourcePeer, identity: await createEphemeralWebIdentity(), crypto: webEndpointCrypto,
      ...invitation, role: 'source', now: scope.now, timeoutMs: 60000 });
    const reported = parseDeviceDescriptor({ ...descriptor,
      capabilities: [{ ...descriptor.capabilities[0], id: '__proto__' }] });
    assert.equal(reported.capabilities[0]?.id, '__proto__', 'the actual public descriptor accepts this bounded ID');
    publisher = new RemoteResourcePublisher({ peer: auth, epoch: invitation.epoch, clockId: 'owned-software-route-clock',
      now: scope.now, device: reported, available: () => true });
    const offer = await sourcePeer.createOffer();
    assert.equal(await controller.acceptOffer(encodeManualPeerCode(invitation.epoch, offer)), true);
    await sourcePeer.acceptAnswer(decodeManualPeerCode(controller.snapshot().answer!, 'answer', invitation.epoch).description);
    for (const [label, channel] of sourcePort.channels) {
      const remote = new PreviewChannel(label, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits ?? undefined }, queue);
      remote.target = channel; channel.target = remote; receiverPort.channels.set(label, remote); receiverPort.ondatachannel?.({ channel: remote });
    }
    for (const port of [sourcePort, receiverPort]) { port.connectionState = 'connected'; port.onconnectionstatechange?.({}); }
    const pump = async (condition: () => boolean) => {
      for (let turn = 0; turn < 2000 && !condition(); turn++) {
        auth!.tick(); publisher!.tick(); controller.tick();
        while (queue.length) queue.shift()!();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.ok(condition(), JSON.stringify({ inspector: controller.snapshot(), auth: auth!.status(), publisher: publisher!.status() }));
    };
    await pump(() => !!controller.snapshot().candidate?.comparison && auth!.status().phase === 'awaiting-enrollment');
    const digest = controller.snapshot().candidate!.comparison!;
    assert.equal(digest, auth.status().comparisonDigest); assert.equal(digest.length, 64);
    assert.equal(controller.confirm(digest), true); assert.equal(auth.confirmEnrollment(digest), true);
    await pump(() => auth!.state === 'connected' && controller.snapshot().candidate?.phase === 'connected');
    assert.equal(controller.activate(), true); assert.equal(publisher.start(), true);
    await pump(() => controller.snapshot().current?.resources.length === 1);
    assert.equal(controller.snapshot().current?.preview, 'unapproved');
    assert.equal(publisher.status().active, 0, 'enrollment itself approves no resource');
    assert.equal(controller.preview(['__proto__']), true);
    await pump(() => publisher!.status().active === 1);
    assert.equal(publisher.publish('__proto__', 42, { capturedAt: scope.now() }), true);
    await pump(() => controller.snapshot().current?.preview === 'receiving');
    const values = controller.snapshot().current!.values;
    assert.equal(Object.hasOwn(values, '__proto__'), true, 'a delivered scalar must remain an own display value');
    assert.equal(values.__proto__, 42);
    assert.equal(Object.getPrototypeOf(values), Object.prototype, 'the immutable view remains a safe ordinary snapshot');
  } finally {
    publisher?.stop(); auth?.stop(); await sourcePeer.disconnect(); await controller.close();
    assert.equal(controller.snapshot().rawPending, 0); assert.equal(controller.snapshot().timerArmed, false);
    if (sourcePort.localDescription) assert.equal(sourcePort.connectionState, 'closed');
    if (receiverPort.localDescription) assert.equal(receiverPort.connectionState, 'closed');
  }
});


test('remembered public backup is absent only after genuine enrolled saved metadata prefix', async () => {
  const queue: (() => void)[] = [], sourcePort = new PreviewPeer(queue), receiverPort = new PreviewPeer(queue);
  const sourcePeer = new PeerDataTransport({ initiator: true, createPeer: () => sourcePort });
  const sourceIdentity = await createEphemeralWebIdentity();
  let raw: string | null = null, writes = 0;
  const storage = { getItem() { return raw; }, setItem(_key: string, value: string) { raw = value; writes++; } };
  const locks: Pick<LockManager, 'request'> = { request<T>(name: string, optionsOrCallback: LockOptions | LockGrantedCallback<T>, supplied?: LockGrantedCallback<T>) {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : supplied;
    assert.ok(callback); return Promise.resolve(callback({ name, mode: 'exclusive' }));
  } };
  let restored: ReturnType<typeof createEnrolledDeviceInspector> | undefined, backupRestored: ReturnType<typeof createEnrolledDeviceInspector> | undefined;
  const controller = createEnrolledDeviceInspector({ ...scope, rememberedStorage: { storage, locks },
    createPeer: () => new PeerDataTransport({ initiator: false, createPeer: () => receiverPort }) });
  let auth: AuthenticatedResourcePeer | undefined, publisher: RemoteResourcePublisher | undefined;
  try {
    assert.equal(await controller.prepare(), true);
    const invitation = decodeReceiverInvitation(controller.snapshot().invitation!, scope.wallNow());
    auth = new AuthenticatedResourcePeer({ transport: sourcePeer, identity: sourceIdentity, crypto: webEndpointCrypto,
      ...invitation, role: 'source', now: scope.now, timeoutMs: 60000 });
    const reported = parseDeviceDescriptor({ ...descriptor,
      capabilities: [{ ...descriptor.capabilities[0], id: '__proto__' }] });
    assert.equal(reported.capabilities[0]?.id, '__proto__', 'the actual public descriptor accepts this bounded ID');
    publisher = new RemoteResourcePublisher({ peer: auth, epoch: invitation.epoch, clockId: 'owned-software-route-clock',
      now: scope.now, device: reported, available: () => true });
    const offer = await sourcePeer.createOffer();
    assert.equal(await controller.acceptOffer(encodeManualPeerCode(invitation.epoch, offer)), true);
    await sourcePeer.acceptAnswer(decodeManualPeerCode(controller.snapshot().answer!, 'answer', invitation.epoch).description);
    for (const [label, channel] of sourcePort.channels) {
      const remote = new PreviewChannel(label, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits ?? undefined }, queue);
      remote.target = channel; channel.target = remote; receiverPort.channels.set(label, remote); receiverPort.ondatachannel?.({ channel: remote });
    }
    for (const port of [sourcePort, receiverPort]) { port.connectionState = 'connected'; port.onconnectionstatechange?.({}); }
    const pump = async (condition: () => boolean) => {
      for (let turn = 0; turn < 2000 && !condition(); turn++) {
        auth!.tick(); publisher!.tick(); controller.tick();
        while (queue.length) queue.shift()!();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.ok(condition(), JSON.stringify({ inspector: controller.snapshot(), auth: auth!.status(), publisher: publisher!.status() }));
    };
    await pump(() => !!controller.snapshot().candidate?.comparison && auth!.status().phase === 'awaiting-enrollment');
    const digest = controller.snapshot().candidate!.comparison!;
    assert.equal(digest, auth.status().comparisonDigest); assert.equal(digest.length, 64);
    assert.equal(controller.confirm(digest), true); assert.equal(auth.confirmEnrollment(digest), true);
    await pump(() => auth!.state === 'connected' && controller.snapshot().candidate?.phase === 'connected');
    assert.equal(controller.activate(), true); assert.equal(publisher.start(), true);
    await pump(() => controller.snapshot().current?.resources.length === 1);
    assert.equal(controller.snapshot().current?.preview, 'unapproved');
    assert.equal(publisher.status().active, 0, 'enrollment itself approves no resource');
    const handle = controller.snapshot().current!.handle;
    assert.equal(typeof controller.rememberCurrent, 'function', 'missing remember past device flow after genuine enrolled inactive prefix');
    assert.equal(await controller.rememberCurrent(handle), true);
    assert.equal(writes, 1); const saved = JSON.parse(raw!);
    assert.deepEqual(saved, { schemaVersion: 1, devices: [{ publicKeyId: sourceIdentity.keyId, label: 'Software meter' }] });
    assert.equal(typeof controller.reviewRememberedExport, 'function', 'missing reviewed metadata backup after genuine enrolled and saved prefix');
    assert.equal(await controller.reviewRememberedExport(), true);
    const exportReview = controller.snapshot().remembered!.backupReview!;
    assert.deepEqual(exportReview.records, [{ publicKeyId: sourceIdentity.keyId, label: 'Software meter', state: 'offline' }]);
    assert.equal(controller.snapshot().remembered!.backupText, undefined);
    assert.equal(await controller.confirmRememberedBackup(exportReview.handle), true);
    const backupText = controller.snapshot().remembered!.backupText!;
    assert.deepEqual(JSON.parse(backupText), saved); assert.equal(writes, 1);
    let restoredRaw: string | null = null, restoredWrites = 0, restoredIdentities = 0;
    backupRestored = createEnrolledDeviceInspector({ ...scope, rememberedStorage: { locks,
      storage: { getItem() { return restoredRaw; }, setItem(_key: string, value: string) { restoredRaw = value; restoredWrites++; } } },
      createIdentity: async () => { restoredIdentities++; return createEphemeralWebIdentity(); } });
    assert.equal(restoredIdentities, 0); assert.equal(restoredWrites, 0);
    assert.equal(await backupRestored.reviewRememberedImport(backupText), true); assert.equal(restoredWrites, 0);
    assert.equal(await backupRestored.confirmRememberedBackup(backupRestored.snapshot().remembered!.backupReview!.handle), true);
    assert.deepEqual(JSON.parse(restoredRaw!), saved); assert.equal(restoredWrites, 1);
    assert.equal(backupRestored.snapshot().current, undefined); assert.equal(backupRestored.snapshot().timerArmed, false);
    assert.equal(restoredIdentities, 0); assert.equal(backupRestored.preview(['__proto__']), false);
    assert.equal(await controller.rememberCurrent({ kind: 'enrolled-device' }), false); assert.equal(writes, 1);
    let identityCalls = 0;
    restored = createEnrolledDeviceInspector({ ...scope, rememberedStorage: { storage, locks }, createIdentity: async () => { identityCalls++; return createEphemeralWebIdentity(); } });
    assert.equal(identityCalls, 0); assert.equal(restored.snapshot().current, undefined);
    assert.equal(await restored.loadRemembered(), true);
    assert.deepEqual(restored.snapshot().remembered?.records, [{ publicKeyId: sourceIdentity.keyId, label: 'Software meter', state: 'offline' }]);
    assert.equal(restored.snapshot().timerArmed, false); assert.equal(identityCalls, 0); assert.equal(restored.preview(['__proto__']), false);
    controller.stop(); assert.equal(await controller.rememberCurrent(handle), false); assert.equal(writes, 1);
    assert.equal(publisher.status().active, 0, 'Remembered metadata never grants a preview');
  } finally { publisher?.stop(); auth?.stop(); await sourcePeer.disconnect(); await controller.close(); await restored?.close(); await backupRestored?.close(); }
});

test('structured preview eligibility reuses bounded declared fields without widening other formats', () => {
  const readings = pageReadingDescriptor('owned-enrolled-eligibility');
  const resources = inspectEnrolledResources(readings);
  assert.deepEqual(resources.map(resource => [resource.id, resource.previewable]), [['reading', true], ['table', true]]);
  assert.deepEqual(resources[0]?.reading?.columns.map(column => [column.key, column.label, column.unit, column.optional]),
    [['step', 'Step', '1', undefined], ['ready', 'Ready', undefined, true], ['mode', 'Mode', undefined, undefined]]);
  const base = readings.capabilities[0]!;
  for (const change of [
    { kind: 'command', permissions: ['invoke'], delivery: { mode: 'reliable', maxAgeMs: 1000 } },
    { kind: 'job', permissions: ['invoke'], delivery: { mode: 'reliable', maxAgeMs: 1000 } },
    { kind: 'property', permissions: ['read'] }, { schemaVersion: 2 },
    { value: { type: 'record', fields: { nested: base.value } } },
    { value: { type: 'record', fields: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`field${index}`, { type: 'boolean' }])) } },
    { value: { type: 'array', minItems: 1, maxItems: 9, items: base.value } },
    { value: { type: 'record', fields: { mode: { type: 'enum', values: ['x'.repeat(25)] } } } },
  ]) {
    const resource = inspectEnrolledResources({ ...readings, capabilities: [{ ...base, ...change }] })[0]!;
    assert.equal(resource.previewable, false); assert.equal(resource.reading, undefined);
  }
  const mixed = inspectEnrolledResources({ ...readings, capabilities: [...descriptor.capabilities,
    { ...descriptor.capabilities[0], id: 'vector', value: { type: 'vector', components: ['x', 'y'], frame: 'screen', unit: '1', min: 0, max: 1 } }, ...readings.capabilities] });
  assert.deepEqual(mixed.map(resource => [resource.id, resource.previewable]),
    [['level', true], ['switch', false], ['vector', true], ['reading', true], ['table', true]]);
  const repeated = inspectEnrolledResources({ ...readings, capabilities: [base, { ...base, id: 'another-reading' }] });
  assert.deepEqual(repeated.map(resource => resource.reading?.label), ['One reading 1', 'One reading 2']);
});

async function pairedStructuredPreview() {
  const queue: (() => void)[] = [], sourcePort = new PreviewPeer(queue), receiverPort = new PreviewPeer(queue);
  const sourcePeer = new PeerDataTransport({ initiator: true, createPeer: () => sourcePort });
  let at = 1000, storageReads = 0, storageWrites = 0;
  const controller = createEnrolledDeviceInspector({ sessionId: scope.sessionId, now: () => at, wallNow: scope.wallNow,
    rememberedStorage: { storage: { getItem() { storageReads++; return null; }, setItem() { storageWrites++; } } },
    createPeer: () => new PeerDataTransport({ initiator: false, createPeer: () => receiverPort }) });
  let auth: AuthenticatedResourcePeer | undefined, publisher: RemoteResourcePublisher | undefined;
  const close = async () => {
    publisher?.stop(); auth?.stop(); await sourcePeer.disconnect(); await controller.close();
    assert.equal(controller.snapshot().rawPending, 0); assert.equal(controller.snapshot().timerArmed, false);
    assert.equal(storageReads, 0); assert.equal(storageWrites, 0);
    if (sourcePort.localDescription) assert.equal(sourcePort.connectionState, 'closed');
    if (receiverPort.localDescription) assert.equal(receiverPort.connectionState, 'closed');
  };
  try {
    assert.equal(controller.snapshot().current, undefined); assert.equal(storageReads, 0);
    assert.equal(await controller.prepare(), true);
    const invitationCode = controller.snapshot().invitation!;
    const invitation = decodeReceiverInvitation(invitationCode, scope.wallNow());
    const identity = await createEphemeralWebIdentity();
    auth = new AuthenticatedResourcePeer({ transport: sourcePeer, identity, crypto: webEndpointCrypto,
      ...invitation, role: 'source', now: () => at, timeoutMs: 60000 });
    const reported = pageReadingDescriptor(invitation.epoch);
    assert.deepEqual(reported.capabilities.map(capability => capability.value.type), ['record', 'array']);
    publisher = new RemoteResourcePublisher({ peer: auth, epoch: invitation.epoch, clockId: 'owned-structured-preview-clock',
      now: () => at, device: reported, available: () => true });
    const offer = await sourcePeer.createOffer();
    assert.equal(await controller.acceptOffer(encodeManualPeerCode(invitation.epoch, offer)), true);
    await sourcePeer.acceptAnswer(decodeManualPeerCode(controller.snapshot().answer!, 'answer', invitation.epoch).description);
    for (const [label, channel] of sourcePort.channels) {
      const remote = new PreviewChannel(label, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits ?? undefined }, queue);
      remote.target = channel; channel.target = remote; receiverPort.channels.set(label, remote); receiverPort.ondatachannel?.({ channel: remote });
    }
    for (const port of [sourcePort, receiverPort]) { port.connectionState = 'connected'; port.onconnectionstatechange?.({}); }
    const pump = async (condition: () => boolean) => {
      for (let turn = 0; turn < 2000 && !condition(); turn++) {
        auth!.tick(); publisher!.tick(); controller.tick();
        while (queue.length) queue.shift()!();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.ok(condition(), 'bounded structured public producer route did not reach its declared state');
    };
    await pump(() => !!controller.snapshot().candidate?.comparison && auth!.status().phase === 'awaiting-enrollment');
    const digest = controller.snapshot().candidate!.comparison!;
    assert.equal(digest.length, 64); assert.equal(digest, auth.status().comparisonDigest);
    assert.equal(controller.confirm(digest), true); assert.equal(auth.confirmEnrollment(digest), true);
    await pump(() => auth!.state === 'connected' && controller.snapshot().candidate?.phase === 'connected');
    assert.equal(controller.activate(), true); assert.equal(publisher.start(), true);
    await pump(() => controller.snapshot().current?.resources.length === 2);
    assert.equal(controller.snapshot().current?.preview, 'unapproved'); assert.deepEqual(controller.snapshot().current?.values, {});
    assert.equal(publisher.status().active, 0, 'genuine structured producer is inactive before separate approval');
    return { controller, publisher, sourcePort, receiverPort, queue, invitationCode, pump, close,
      time: () => at, advance: (next: number) => { at = next; } };
  } catch (cause) { await close(); throw cause; }
}

test('structured enrolled preview is absent only after genuine authenticated inactive descriptor prefix', async () => {
  const paired = await pairedStructuredPreview();
  try {
    assert.deepEqual(paired.controller.snapshot().current!.resources.map(resource => [resource.id, resource.previewable]),
      [['reading', true], ['table', true]], 'missing bounded structured eligibility after actual authenticated inactive producer prefix');
    assert.equal(paired.controller.preview(['reading', 'table']), true);
    await paired.pump(() => paired.publisher.status().active === 2);
    assert.equal(paired.publisher.publish('reading', { step: 42, mode: 'count-down' }, { capturedAt: paired.time() }), true);
    const rows = [{ step: 7, ready: false, mode: 'count-up' }, { step: 9, ready: true, mode: 'count-down' }];
    assert.equal(paired.publisher.publish('table', rows, { capturedAt: paired.time() }), true); rows[0]!.step = 99;
    await paired.pump(() => !!paired.controller.snapshot().current?.readings?.reading && !!paired.controller.snapshot().current?.readings?.table);
    const current = paired.controller.snapshot().current!;
    assert.equal(current.preview, 'receiving'); assert.deepEqual(current.readings!.reading!.rows, [['42', 'Not supplied', 'count-down']]);
    assert.deepEqual(current.readings!.table!.rows, [['7', 'Off', 'count-up'], ['9', 'On', 'count-down']]);
    assert.equal(Object.isFrozen(current.readings!.table!.rows[0]), true); assert.deepEqual(current.values, {}, 'only projected structured cells are retained by the page');
    assert.deepEqual(paired.controller.snapshot().remembered?.records, []);
    assert.equal(paired.publisher.publish('reading', { step: 101, mode: 'count-up' }, { capturedAt: paired.time() }), false);
    paired.advance(1250);
    assert.equal(paired.publisher.publish('reading', { step: 8, ready: false, mode: 'count-up' }, { capturedAt: paired.time() }), true);
    paired.controller.stopPreview();
    await paired.pump(() => paired.publisher.status().active === 0);
    assert.deepEqual(paired.controller.snapshot().current?.readings, {}); assert.deepEqual(paired.controller.snapshot().current?.values, {});
    assert.equal(paired.controller.snapshot().current?.preview, 'stopped'); assert.equal(paired.controller.preview(['reading']), false);
    assert.equal(paired.publisher.publish('reading', { step: 10, mode: 'count-up' }, { capturedAt: paired.time() }), false);
  } finally { await paired.close(); }
});

test('structured preview expiry releases projected cells and requires a fresh pairing', async () => {
  const paired = await pairedStructuredPreview();
  try {
    assert.equal(paired.controller.preview(['table']), true); await paired.pump(() => paired.publisher.status().active === 1);
    const rows = Array.from({ length: 8 }, (_, index) => ({ step: index, ready: index % 2 === 0, mode: 'count-up' }));
    assert.equal(paired.publisher.publish('table', rows, { capturedAt: paired.time() }), true);
    await paired.pump(() => paired.controller.snapshot().current?.readings?.table?.rows.length === 8);
    // Keep the actual peer currency and route current while approaching grant
    // expiry; a 30s jump instead tests the separate 2s identity-currency guard.
    for (let at = 1250; at < 31000; at += 250) {
      paired.advance(at); rows[0]!.step = ((at - 1000) / 250) % 100;
      assert.equal(paired.publisher.publish('table', rows, { capturedAt: paired.time() }), true);
      await paired.pump(() => paired.controller.snapshot().current?.readings?.table?.rows[0]?.[0] === String(rows[0]!.step));
    }
    paired.advance(31000); paired.controller.tick();
    assert.equal(paired.controller.snapshot().outcome, 'preview-expired'); assert.deepEqual(paired.controller.snapshot().current?.readings, {});
    await paired.pump(() => paired.publisher.status().active === 0);
    assert.equal(paired.controller.preview(['table']), false);
  } finally { await paired.close(); }
});

test('structured preview disconnect retires cells and a queued retired frame cannot enter a new task', async () => {
  const paired = await pairedStructuredPreview();
  try {
    assert.equal(paired.controller.preview(['reading']), true); await paired.pump(() => paired.publisher.status().active === 1);
    assert.equal(paired.publisher.publish('reading', { step: 17, ready: false, mode: 'count-up' }, { capturedAt: paired.time() }), true);
    await paired.pump(() => !!paired.controller.snapshot().current?.readings?.reading);
    paired.advance(1250);
    assert.equal(paired.publisher.publish('reading', { step: 99, ready: true, mode: 'count-down' }, { capturedAt: paired.time() }), true);
    assert.ok(paired.queue.length > 0, 'an actual accepted producer frame is pending before retirement');
    paired.receiverPort.connectionState = 'failed'; paired.receiverPort.onconnectionstatechange?.({}); paired.controller.tick();
    assert.equal(paired.controller.snapshot().current, undefined);
    for (let turn = 0; turn < 32 && paired.controller.snapshot().rawPending; turn++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(paired.controller.snapshot().rawPending, 0); assert.ok(paired.queue.length > 0);
    assert.equal(await paired.controller.prepare(), true); assert.notEqual(paired.controller.snapshot().invitation, paired.invitationCode);
    assert.ok(paired.queue.length > 0, 'old producer traffic stays held through fresh task creation');
    while (paired.queue.length) paired.queue.shift()!(); paired.controller.tick();
    assert.equal(paired.controller.snapshot().current, undefined); assert.equal(paired.controller.preview(['reading']), false);
  } finally { await paired.close(); }
});
