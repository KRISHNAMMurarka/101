import assert from 'node:assert/strict';
import { createDeviceRuntime, decodePacket, encodePacket, getInputProfile, pointerSourceDescriptor,
  RemoteResourcePublisher, RemoteResourceReceiver } from '@101/connect';

const epoch = '0123456789abcdef0123456789abcdef';
const hex = data => Buffer.from(data).toString('hex');
const packet = (values = {}) => ({ protocol: 'connect', version: 1, type: 'sample', epoch,
  slot: 1, sequence: 1, capturedAt: 1000, value: { x: 0.25, y: 0.75 }, ...values });

class LocalPeer {
  state = 'connected'; other; listeners = new Set(); states = new Set(); frames = []; holdDisposable = true;
  isOpen() { return this.state === 'connected'; }
  send(lane, data) {
    if (!this.isOpen()) return false;
    const frame = { lane, data }; this.frames.push(frame);
    if (lane !== 'disposable' || !this.holdDisposable) this.other?.deliver(frame);
    return true;
  }
  deliver(frame) { for (const listener of [...this.listeners]) listener(frame.lane, frame.data); }
  onData(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onStateChange(listener) { this.states.add(listener); listener(this.state); return () => this.states.delete(listener); }
  disconnect() { this.state = 'disconnected'; for (const listener of [...this.states]) listener(this.state); }
}
function host() {
  let now = 1000, allowed = false, releases = 0;
  const applied = [], sourceDevice = pointerSourceDescriptor('language-binding-local-fixture');
  const position = getInputProfile('app:pointer/1').capabilities.find(value => value.id === 'position');
  const sinkDevice = { ...sourceDevice, id: 'language-binding-sink', label: 'Local pointer sink',
    capabilities: [{ ...position, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } }] };
  const local = new LocalPeer(), remote = new LocalPeer(); local.other = remote; remote.other = local;
  const grant = { expiresAt: 2000, maxHz: 60, maxAgeMs: 100 };
  let sink;
  const runtime = createDeviceRuntime({ clockDomain: 'host-clock', now: () => now, authorize: request =>
    allowed && request.principalId === 'owner' && request.applicationId === 'binding-fixture' && request.sessionId === 'local-session' &&
    request.source.deviceId === sourceDevice.id && request.source.capabilityId === 'position' &&
    request.sink.registrationId === sink.id && request.sink.deviceId === sinkDevice.id && request.sink.capabilityId === 'position' ? grant : undefined });
  sink = runtime.registerSink({ device: sinkDevice, capability: 'position',
    apply: (observation, context) => { assert.equal(context.isCurrent(), true); applied.push(observation); }, release: () => { releases++; } });
  runtime.setReadiness(sink, 'available');
  const connections = [];
  // Retain the actual host-owned connection; every request/result is delegated unchanged.
  const receiverRuntime = new Proxy(runtime, { get(target, key) {
    if (key === 'route') return request => { const connection = target.route(request); connections.push(connection); return connection; };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const receiver = new RemoteResourceReceiver({ authentication: 'local-diagnostic', peer: local, runtime: receiverRuntime, epoch,
    clockId: 'host-clock', now: () => now, principalId: 'owner', applicationId: 'binding-fixture', sessionId: 'local-session' });
  const publisher = new RemoteResourcePublisher({ authentication: 'local-diagnostic', peer: remote, epoch,
    clockId: 'source-clock', now: () => now, available: () => true, device: sourceDevice });
  assert.equal(publisher.start(), true); receiver.tick();
  return { local, remote, runtime, receiver, publisher, applied, grant, sourceDevice,
    setNow(value) { now = value; }, setAllowed(value) { allowed = value; }, releases: () => releases,
    revoke() { allowed = false; assert.equal(connections.length, 1); runtime.revoke(connections[0]); },
    select() { allowed = true; assert.equal(receiver.approve({ capability: 'position', sink, sinkDevice, sinkCapability: 'position', grant, codec: 'normalized-pointer/1' }), 1); },
    publish(value = { x: 0.25, y: 0.75 }) {
      assert.equal(publisher.publish('position', value), true);
      const frame = remote.frames.at(-1); assert.equal(frame.lane, 'disposable');
      const decoded = decodePacket(frame.data, frame.lane); assert.equal(decoded.codec, 'normalized-pointer/1');
      return decoded.packet;
    },
    close() { receiver.stop(); publisher.stop(); runtime.close(); }
  };
}

/** All bytes originate in the public JS producer; negative cases mutate those bytes. */
export function createPointerBindingFixtures() {
  const h = host(); let producer;
  try { h.select(); producer = h.publish(); } finally { h.close(); }
  const inputs = [producer, packet({ slot: 128, sequence: 0x01020304, capturedAt: 1234.125 }),
    packet({ epoch: 'f'.repeat(32), sequence: 0xffffffff, capturedAt: Number.MAX_VALUE, value: { x: 0, y: 1 } }),
    packet({ capturedAt: 0, value: { x: 1, y: 0 } }), packet({ capturedAt: 123456789.12345679 })];
  for (const coordinate of [0.0000001, 0.123456789, 0.49999999, 0.50000003, 0.99999998, 1])
    for (const value of [{ x: coordinate, y: coordinate }, { x: coordinate, y: 1 - coordinate }]) inputs.push(packet({ value }));
  const positive = inputs.map((input, index) => ({ id: index === 0 ? 'actual-publisher' : `sample-${index}`, input,
    hex: hex(encodePacket(input, 'normalized-pointer/1')) }));
  const valid = Buffer.from(positive[0].hex, 'hex'), negative = [];
  const add = (id, bytes, lane = 'disposable') => {
    const data = Uint8Array.from(bytes).buffer;
    assert.equal(decodePacket(data, lane), undefined, `Public decoder must reject ${id}`);
    negative.push({ id, lane, hex: hex(data) });
  };
  for (const length of [0, 47, 49, 100]) add(`length-${length}`, Buffer.alloc(length));
  for (const index of [0, 1, 2, 3, 22, 23, 44, 45, 46, 47]) {
    const bytes = Buffer.from(valid); bytes[index] ^= 2; add(`tag-reserved-${index}`, bytes);
  }
  for (const slot of [0, 129]) { const bytes = Buffer.from(valid); bytes.writeUInt16BE(slot, 20); add(`slot-${slot}`, bytes); }
  const zero = Buffer.from(valid); zero.writeUInt32BE(0, 24); add('sequence-zero', zero);
  for (const [name, time] of [['negative', -1], ['nan', NaN], ['infinity', Infinity]]) {
    const bytes = Buffer.from(valid); bytes.writeDoubleBE(time, 28); add(`time-${name}`, bytes);
  }
  for (const offset of [36, 40]) for (const [name, value] of [['negative', -0.1], ['over-one', 1.1], ['nan', NaN], ['infinity', Infinity]]) {
    const bytes = Buffer.from(valid); bytes.writeFloatBE(value, offset); add(`coordinate-${offset}-${name}`, bytes);
  }
  add('wrong-lane', valid, 'reliable');
  const invalidEncode = [
    `E ${epoch} 0 1 1000 0.25 0.75`, `E ${epoch} 129 1 1000 0.25 0.75`,
    `E ${epoch} 1 0 1000 0.25 0.75`, `E ${epoch} 1 4294967296 1000 0.25 0.75`,
    `E ${epoch} 1 1 -1 0.25 0.75`, `E ${epoch} 1 1 NaN 0.25 0.75`, `E ${epoch} 1 1 Infinity 0.25 0.75`,
    `E ${epoch} 1 1 1000 -0.1 0.75`, `E ${epoch} 1 1 1000 1.1 0.75`, `E ${epoch} 1 1 1000 0.25 NaN`,
    `E 0123 1 1 1000 0.25 0.75`, `E ${epoch} 1 1 1000 Infinity 0.75` ];
  return { schemaVersion: 1, profile: 'normalized-pointer-bindings/1', codec: 'normalized-pointer/1',
    descriptor: pointerSourceDescriptor('language-binding-local-fixture'), inputProfile: getInputProfile('app:pointer/1'),
    positive, negative, invalidEncode };
}

/** Native output remains untrusted until this existing JS receiver and owner grant admit it. */
export function runPointerBindingHostProof(nativeEncode) {
  const h = host(), checks = [];
  const deliver = (input, lane = 'disposable') => {
    const bytes = nativeEncode(input);
    assert.equal(hex(bytes), hex(encodePacket(input, 'normalized-pointer/1')));
    h.local.deliver({ lane, data: bytes instanceof ArrayBuffer ? bytes.slice(0) : Uint8Array.from(bytes).buffer }); h.receiver.tick();
  };
  try {
    deliver(packet()); assert.equal(h.applied.length, 0); checks.push('no-selection-no-effect');
    h.select(); const first = h.publish(); deliver(first);
    assert.equal(h.applied.length, 1); assert.deepEqual(h.applied[0].value, { x: 0.25, y: 0.75 }); checks.push('selected-current-grant-effect');
    deliver(first); deliver({ ...first, epoch: 'f'.repeat(32), sequence: 2 });
    deliver({ ...first, slot: 128, sequence: 2 }); deliver({ ...first, sequence: 2 }, 'reliable');
    assert.equal(h.applied.length, 1); checks.push('replay-epoch-slot-lane-no-effect');
    h.setNow(1120); deliver({ ...first, sequence: 2 }); assert.equal(h.applied.length, 1); checks.push('stale-capture-no-effect');
    deliver(h.publish({ x: 0.5, y: 0.5 })); assert.equal(h.applied.length, 2);
    h.setNow(1140); const pending = h.publish(); h.revoke(); deliver(pending);
    assert.equal(h.applied.length, 2); assert.equal(h.releases(), 1); checks.push('revoked-owner-grant-releases');
    h.receiver.stop(); assert.equal(h.local.listeners.size, 0); assert.equal(h.local.states.size, 0);
    deliver({ ...first, sequence: 100, capturedAt: 1140 }); assert.equal(h.applied.length, 2); checks.push('stop-detaches-no-effect');
  } finally { h.close(); }
  for (const reason of ['expiry', 'disconnect']) {
    const session = host();
    try {
      session.select();
      if (reason === 'expiry') { session.setNow(2000); session.receiver.tick(); }
      else { session.local.disconnect(); session.remote.disconnect(); }
      assert.equal(session.releases(), 1); assert.equal(session.receiver.status().active, 0);
      session.local.deliver({ lane: 'disposable', data: nativeEncode(packet({ capturedAt: 2000, sequence: 10 })) });
      session.receiver.tick(); assert.equal(session.applied.length, 0); checks.push(`${reason}-releases-no-effect`);
    } finally { session.close(); }
  }
  return { checks, nativeCodecAuthority: 'none', hostAuthority: 'existing-public-receiver-runtime-local-diagnostic',
    nativeRuntimeLifecycle: 'unqualified', transportAuthentication: 'unqualified', physicalEffects: 'unqualified' };
}

if (process.argv[2] === '--fixtures') console.log(JSON.stringify(createPointerBindingFixtures(), null, 2));
