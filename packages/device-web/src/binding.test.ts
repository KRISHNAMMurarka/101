import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from '../../device-runtime/src/index.ts';
import type { DeliveryContext, Observation, RouteGrant } from '../../device-runtime/src/types.ts';
import type { DeviceDescriptor } from '../../device-model/src/index.ts';
import { observationAgeBounds, parseObservationTiming } from '../../device-model/src/index.ts';
import { RemoteResourcePublisher, RemoteResourceReceiver } from './binding.ts';
import type { RemoteValueTiming } from './binding.ts';
import { decodePacket, encodePacket } from './wire.ts';

const epoch = '0123456789abcdef0123456789abcdef';
type Lane = 'reliable' | 'disposable';
class Peer {
  state: 'connected' | 'disconnected' = 'connected';
  other?: Peer;
  listeners = new Set<(lane: Lane, data: string | ArrayBuffer) => void>();
  states = new Set<(state: 'connected' | 'disconnected') => void>();
  sent: { lane: Lane; data: string | ArrayBuffer }[] = [];
  blocked = new Set<Lane>();
  hold = false;
  queue: { lane: Lane; data: string | ArrayBuffer }[] = [];
  isOpen(lane: Lane) { return this.state === 'connected' && !this.blocked.has(lane); }
  send(lane: Lane, data: string | ArrayBuffer | Uint8Array) {
    if (!this.isOpen(lane)) return false;
    const frame = { lane, data: typeof data === 'string' ? data : data instanceof ArrayBuffer ? data : data.slice().buffer };
    this.sent.push(frame);
    if (this.hold) this.queue.push(frame); else this.other?.deliver(frame);
    return true;
  }
  deliver(frame: { lane: Lane; data: string | ArrayBuffer }) { for (const listener of [...this.listeners]) listener(frame.lane, frame.data); }
  onData(listener: (lane: Lane, data: string | ArrayBuffer) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onStateChange(listener: (state: 'connected' | 'disconnected') => void) { this.states.add(listener); listener(this.state); return () => { this.states.delete(listener); }; }
  disconnect() { this.state = 'disconnected'; for (const listener of [...this.states]) listener(this.state); }
}
function device(sink = false): DeviceDescriptor {
  return { schemaVersion: 1, id: sink ? 'application' : 'phone', label: sink ? 'Surface' : 'Touch source', revision: 1,
    adapter: { id: 'test:typed', version: '1.0.0' }, runtime: { platform: 'contract-harness' }, capabilities: [
      { id: 'position', semantic: 'app:pointer-position/1', schemaVersion: 1, kind: sink ? 'property' : 'sample',
        value: { type: 'vector', components: ['x', 'y'], unit: '1', frame: 'surface-normalized', min: 0, max: 1 },
        delivery: { mode: 'latest', maxHz: 60, maxAgeMs: 100 }, permissions: sink ? ['write'] : ['subscribe'],
        ...(sink ? { ownership: { mode: 'exclusive' as const } } : {}) },
      { id: 'contact', semantic: 'app:pointer-contact/1', schemaVersion: 1, kind: sink ? 'property' : 'event',
        value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 100 }, permissions: sink ? ['write'] : ['subscribe'] },
      { id: 'temperature', semantic: 'sensor:temperature/1', schemaVersion: 1, kind: sink ? 'property' : 'sample',
        value: { type: 'scalar', unit: 'Cel', min: -40, max: 125 }, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 1000 },
        permissions: sink ? ['write'] : ['subscribe'] },
    ] };
}

test('raw or copied peers cannot be registered as authenticated resource endpoints', () => {
  const peer = new Peer();
  const runtime = createDeviceRuntime({ clockDomain: 'clock', now: () => 100, authorize: () => undefined });
  assert.throws(() => new RemoteResourceReceiver({ peer, runtime, epoch, clockId: 'clock', now: () => 100,
    principalId: 'owner', applicationId: 'app', sessionId: 'session' }), /authenticated|diagnostic/i);
  assert.throws(() => new RemoteResourcePublisher({ peer, device: device(), epoch, clockId: 'source', now: () => 100,
    available: () => true }), /authenticated|diagnostic/i);
  assert.equal(peer.listeners.size, 0); assert.equal(peer.states.size, 0); runtime.close();
});
function harness(options: { grant?: RouteGrant; available?: boolean; apply?: (observation: Observation, context: DeliveryContext) => void | Promise<void>; remoteOffset?: number; synchronize?: boolean;
  publisherTiming?: (value: RemoteValueTiming) => void; receiverTiming?: (value: RemoteValueTiming) => void } = {}) {
  let now = 100, released = 0;
  const received: Observation[] = [], status: string[] = [];
  const host = new Peer(), phone = new Peer(); host.other = phone; phone.other = host;
  const grant = options.grant ?? { expiresAt: 10000, maxAgeMs: 1000, maxHz: 1000 };
  const runtime = createDeviceRuntime({ now: () => now, clockDomain: 'host-clock', authorize: request =>
    request.principalId === 'owner' && request.applicationId === 'app' && request.sessionId === 'session' ? grant : undefined });
  const sinks = new Map(device(true).capabilities.map(capability => {
    const sink = runtime.registerSink({ device: device(true), capability: capability.id,
      apply: options.apply ?? (observation => { received.push(observation); }), release: () => { released++; } });
    runtime.setReadiness(sink, 'available'); return [capability.id, sink];
  }));
  const receiver = new RemoteResourceReceiver({ authentication: 'local-diagnostic', peer: host, runtime, epoch, principalId: 'owner', applicationId: 'app', sessionId: 'session',
    clockId: 'host-clock', now: () => now, onStatus: value => { status.push(value); }, onTiming: options.receiverTiming });
  let available = options.available ?? true;
  const publisher = new RemoteResourcePublisher({ authentication: 'local-diagnostic', peer: phone, device: device(), epoch, clockId: 'phone-clock',
    now: () => now + (options.remoteOffset ?? 1000), available: () => available, onStatus: value => { status.push(value); }, onTiming: options.publisherTiming });
  publisher.start(); if (options.synchronize !== false) receiver.tick();
  const approve = (capability = 'position', codec: 'json/1' | 'normalized-pointer/1' = 'json/1', ownerGrant = grant) => receiver.approve({ capability,
    sink: sinks.get(capability)!, sinkDevice: device(true), sinkCapability: capability, grant: ownerGrant, codec });
  return { host, phone, receiver, publisher, runtime, received, status, approve, sinks, released: () => released,
    setNow(value: number) { now = value; }, setAvailable(value: boolean) { available = value; } };
}

test('negotiated typed position and temperature retain meaning with a foreign clock', () => {
  const h = harness(); assert.equal(h.receiver.description()?.id, 'phone');
  assert.equal(h.approve(), 1); assert.equal(h.approve('temperature'), 2);
  assert.equal(h.publisher.publish('position', { x: 0.2, y: 0.8 }), true);
  assert.equal(h.publisher.publish('temperature', 23.75), true); h.receiver.tick();
  assert.deepEqual(h.received.map(value => value.value), [{ x: 0.2, y: 0.8 }, 23.75]);
  assert.equal(h.received[0].timestamp <= 100, true); assert.equal(h.received[0].clockDomain, 'host-clock');
  assert.equal(h.received[0].provenance?.remoteClockId, 'phone-clock');
  assert.equal(h.received[0].provenance?.remoteCapturedAt, 1100);
  const timing = parseObservationTiming(h.received[0].provenance?.timing);
  assert.deepEqual(timing.capture, { clockId: 'phone-clock', at: 1100 });
  assert.deepEqual(timing.receipt, { clockId: 'host-clock', at: 100 });
  assert.equal(timing.mapping?.maxDriftPpm, 100);
  assert.deepEqual(timing.processors, []);
  const age = observationAgeBounds(timing);
  assert.ok(age.earliestMs >= 0 && age.latestMs >= age.earliestMs);
  assert.equal(h.publisher.publish('temperature', 200), false);
});
test('opted-in value timing measures actual codec boundaries without granting or leaking payloads', () => {
  const published: RemoteValueTiming[] = [], received: RemoteValueTiming[] = [];
  const h = harness({ publisherTiming: value => { published.push(value); throw new Error('Diagnostic observer'); },
    receiverTiming: value => { received.push(value); throw new Error('Diagnostic observer'); } });
  try {
    assert.equal(h.publisher.publish('position', { x: 0.2, y: 0.8 }), false);
    assert.equal(published.length, 0); assert.equal(received.length, 0);
    assert.equal(h.approve('position', 'normalized-pointer/1'), 1);
    assert.equal(h.publisher.publish('position', { x: 0.2, y: 0.8 }), true); h.receiver.tick();
    assert.equal(published.length, 1); assert.equal(received.length, 1); assert.equal(h.received.length, 1);
    const encoding = published[0], decoding = received[0];
    assert.equal(encoding.phase, 'encoding'); assert.equal(decoding.phase, 'decoding');
    assert.equal(encoding.epoch, epoch); assert.equal(encoding.slot, 1); assert.equal(encoding.sequence, 1);
    assert.equal(encoding.clockId, 'phone-clock'); assert.equal(decoding.clockId, 'host-clock');
    assert.equal(encoding.startedAt <= encoding.finishedAt, true);
    assert.equal(decoding.startedAt <= decoding.finishedAt, true);
    assert.equal(Object.hasOwn(encoding, 'value'), false); assert.equal(Object.hasOwn(decoding, 'value'), false);
    assert.ok(Object.isFrozen(encoding) && Object.isFrozen(decoding));
    const sample = h.phone.sent.findLast(frame => frame.lane === 'disposable')!;
    assert.equal((sample.data as ArrayBuffer).byteLength, 48);
    h.host.deliver(sample); assert.equal(received.length, 1, 'replay has no accepted timing');
    h.receiver.stop(); h.setNow(130); h.publisher.publish('position', { x: 0.4, y: 0.6 });
    assert.equal(received.length, 1, 'stopped route has no accepted timing');
  } finally { h.publisher.stop(); h.receiver.stop(); h.runtime.close(); }
});
for (const capability of ['position', 'contact']) test(`timing observer reentrancy cannot resend accepted ${capability} work`, () => {
  let reports = 0;
  const h = harness({ publisherTiming: () => {
    reports++;
    if (reports === 1) { h.setNow(120); h.publisher.tick(); }
  } });
  try {
    h.approve(capability);
    assert.equal(h.publisher.publish(capability, capability === 'position' ? { x: 0.2, y: 0.8 } : true), true);
    const sent = h.phone.sent.map(frame => decodePacket(frame.data, frame.lane)?.packet).filter(packet => packet?.type === 'sample' || packet?.type === 'event');
    assert.equal(sent.length, 1); assert.equal(reports, 1);
    assert.equal(h.publisher.status().pending, 0);
  } finally { h.publisher.stop(); h.receiver.stop(); h.runtime.close(); }
});
test('compact normalized pointer is negotiated independently of sensor JSON', () => {
  const h = harness(); h.approve('position', 'normalized-pointer/1');
  assert.equal(h.approve('temperature', 'normalized-pointer/1'), undefined);
  h.publisher.publish('position', { x: 0.9, y: 0.1 }); h.receiver.tick();
  const value = h.received[0].value;
  assert.ok(typeof value === 'object' && 'x' in value && 'y' in value && typeof value.x === 'number' && typeof value.y === 'number');
  assert.ok(Math.abs(value.x - 0.9) <= 2 ** -25); assert.ok(Math.abs(value.y - 0.1) <= 2 ** -25);
  assert.equal(h.phone.sent.some(frame => frame.lane === 'disposable' && frame.data instanceof ArrayBuffer), true);
});
test('reliable contact operations deliver both edges and release locally on loss', () => {
  const h = harness(); h.approve('contact');
  assert.equal(h.publisher.publish('contact', true), true); h.receiver.tick();
  h.setNow(102); assert.equal(h.publisher.publish('contact', false), true); h.receiver.tick();
  assert.deepEqual(h.received.map(value => value.value), [true, false]);
  h.host.disconnect(); h.phone.disconnect(); assert.equal(h.released(), 1);
  assert.equal(h.host.listeners.size, 0); assert.equal(h.publisher.publish('contact', true), false);
});
test('unknown slots, stale epochs, replay, wrong lanes and packet-selected authority cannot mutate', () => {
  const h = harness(); h.approve(); h.phone.hold = true;
  h.publisher.publish('position', { x: 0.1, y: 0.9 }); const frame = h.phone.queue.pop()!;
  const decoded = decodePacket(frame.data, frame.lane)!; assert.equal(decoded.packet.type, 'sample');
  const mutate = (changes: object, lane: Lane = 'disposable') => h.host.deliver({ lane, data: JSON.stringify({ ...decoded.packet, ...changes }) });
  mutate({ slot: 128 }); mutate({ epoch: 'f'.repeat(32) }); mutate({ sessionId: 'another', principalId: 'admin' });
  h.host.deliver({ ...frame, lane: 'reliable' }); h.receiver.tick(); assert.equal(h.received.length, 0);
  h.host.deliver(frame); h.receiver.tick(); assert.equal(h.received.length, 1);
  h.setNow(120); h.host.deliver(frame); h.receiver.tick(); assert.equal(h.received.length, 1);
});
test('a different concrete peer cannot address the enrolled receiver and wrong host scope denies', () => {
  const h = harness(); h.approve(); const attacker = new Peer(); attacker.send('disposable', 'anything');
  assert.equal(h.received.length, 0);
  for (const scope of [{ principalId: 'attacker', applicationId: 'app', sessionId: 'session' },
    { principalId: 'owner', applicationId: 'app', sessionId: 'other' }]) {
    const otherPeer = new Peer(), otherPhone = new Peer(); otherPeer.other = otherPhone; otherPhone.other = otherPeer;
    const other = new RemoteResourceReceiver({ authentication: 'local-diagnostic', peer: otherPeer, runtime: h.runtime, epoch, clockId: 'host-clock', now: () => 100, ...scope });
    const publisher = new RemoteResourcePublisher({ authentication: 'local-diagnostic', peer: otherPhone, device: device(), epoch, clockId: 'other-phone-clock', now: () => 1100, available: () => true });
    publisher.start(); other.tick();
    assert.equal(other.approve({ capability: 'position', sink: h.sinks.get('position')!, sinkDevice: device(true), sinkCapability: 'position',
      grant: { expiresAt: 10000, maxAgeMs: 100, maxHz: 60 } }), undefined);
    assert.equal(publisher.publish('position', { x: 0.8, y: 0.8 }), false); other.tick();
    assert.equal(other.status().active, 0); assert.equal(h.received.length, 0); other.stop(); publisher.stop();
  }
  h.receiver.stop(); assert.equal(h.host.listeners.size, 0); assert.equal(h.receiver.description(), undefined);
});
test('a changed description stops previous routes before exposing replacements', () => {
  const h = harness(); h.approve(); h.publisher.publish('position', { x: 0.3, y: 0.7 }); h.receiver.tick();
  const description = device(); description.revision = 2;
  h.host.deliver({ lane: 'reliable', data: encodePacket({ protocol: 'connect', version: 1, type: 'describe', epoch,
    clockId: 'phone-clock', device: description, codecs: ['json/1'] }) as string });
  assert.equal(h.released(), 1); assert.equal(h.receiver.status().active, 0);
  h.setNow(120); h.publisher.publish('position', { x: 0.8, y: 0.2 }); h.receiver.tick(); assert.equal(h.received.length, 1);
});
test('runtime authority can narrow a grant but cannot be silently misadvertised', () => {
  const h = harness({ grant: { expiresAt: 10000, maxAgeMs: 50, maxHz: 20 } });
  assert.equal(h.approve('position', 'json/1', { expiresAt: 10000, maxAgeMs: 100, maxHz: 60 }), undefined);
  assert.equal(h.receiver.status().active, 0); assert.equal(h.released(), 1);
  assert.equal(h.approve('position'), 2); assert.equal(h.publisher.publish('position', { x: 0.1, y: 0.1 }), true);
  h.receiver.tick(); assert.equal(h.received.length, 1);
});
test('actual provider readiness gates negotiation and revocation releases active routes', () => {
  const h = harness({ available: false }); assert.equal(h.approve(), undefined);
  assert.equal(h.publisher.publish('position', { x: 0.2, y: 0.2 }), false);
  h.setAvailable(true); assert.equal(h.approve(), 2); h.publisher.publish('position', { x: 0.2, y: 0.2 }); h.receiver.tick();
  h.setAvailable(false); h.publisher.tick(); assert.equal(h.released(), 1);
});
test('latest replacement is bounded and recovers state after disposable admission loss', () => {
  const h = harness(); h.approve(); h.phone.blocked.add('disposable');
  for (let i = 0; i < 5000; i++) h.publisher.publish('position', { x: i / 5000, y: 1 - i / 5000 });
  assert.equal(h.publisher.status().pending, 1); assert.equal(h.received.length, 0);
  h.phone.blocked.clear(); h.publisher.tick(); h.receiver.tick();
  assert.deepEqual(h.received[0].value, { x: 4999 / 5000, y: 1 - 4999 / 5000 }); assert.equal(h.publisher.status().pending, 0);
});
test('reliable saturation stops held state instead of queuing unbounded edges', () => {
  const h = harness(); h.approve('contact'); h.publisher.publish('contact', true); h.receiver.tick();
  h.setNow(102); h.phone.blocked.add('reliable'); assert.equal(h.publisher.publish('contact', false), false);
  assert.equal(h.publisher.status().pending, 0); assert.equal(h.publisher.status().active, 0);
  h.setNow(601); h.receiver.tick(); assert.equal(h.released(), 1); assert.equal(h.receiver.status().active, 0);
});
test('reordered latest and duplicate reliable events do not refresh liveness', () => {
  const h = harness(); h.approve(); h.approve('contact'); h.phone.hold = true;
  h.publisher.publish('position', { x: 0.1, y: 0.1 }); h.setNow(120); h.publisher.publish('position', { x: 0.9, y: 0.9 });
  h.publisher.publish('contact', true); const frames = h.phone.queue.splice(0);
  for (const frame of [...frames].reverse()) h.host.deliver(frame); h.receiver.tick();
  assert.deepEqual(h.received.map(value => value.value), [{ x: 0.9, y: 0.9 }, true]);
  h.setNow(210); for (const frame of frames) h.host.deliver(frame); h.receiver.tick();
  h.setNow(621); h.receiver.tick(); assert.equal(h.released(), 2);
});
test('unsynchronized, future and expired remote captures cannot reach an application', () => {
  const h = harness(); h.approve(); h.phone.hold = true; h.publisher.publish('position', { x: 0.1, y: 0.1 });
  const frame = h.phone.queue.pop()!; const packet = decodePacket(frame.data, frame.lane)!.packet;
  h.host.deliver({ lane: 'disposable', data: JSON.stringify({ ...packet, capturedAt: 1300 }) }); h.receiver.tick(); assert.equal(h.received.length, 0);
  h.setNow(201); h.host.deliver(frame); h.receiver.tick(); assert.equal(h.received.length, 0);
  const fresh = harness({ synchronize: false }); assert.equal(fresh.approve(), 1);
  fresh.publisher.publish('position', { x: 0.9, y: 0.1 }); fresh.runtime.flush();
  assert.equal(fresh.received.length, 0); fresh.receiver.stop();
});
test('stop during pending ready is terminal and old callbacks cannot resurrect ownership', () => {
  const h = harness(); h.phone.hold = true; assert.equal(h.approve(), 1); h.receiver.stop();
  for (const frame of h.phone.queue) h.host.deliver(frame); assert.equal(h.receiver.status().active, 0);
  assert.equal(h.receiver.approve({ capability: 'position', sink: h.sinks.get('position')!, sinkDevice: device(true), sinkCapability: 'position',
    grant: { expiresAt: 10000, maxAgeMs: 100, maxHz: 60 } }), undefined);
  assert.equal(h.host.listeners.size, 0); assert.equal(h.host.states.size, 0);
});
test('a brief packet gap does not expire an active route before a fresh sample arrives', () => {
  const h = harness({ grant: { expiresAt: 10000, maxAgeMs: 100, maxHz: 60 } });
  assert.equal(h.approve('position', 'normalized-pointer/1'), 1);
  h.setNow(250); h.receiver.tick();
  assert.equal(h.receiver.status().active, 1);
  assert.equal(h.publisher.publish('position', { x: 0.4, y: 0.6 }), true);
  h.receiver.tick(); h.runtime.flush();
  const value = h.received.at(-1)?.value as { x: number; y: number } | undefined;
  assert.ok(value && Math.abs(value.x - 0.4) < 1e-6 && Math.abs(value.y - 0.6) < 1e-6);
  h.setNow(751); h.receiver.tick();
  assert.equal(h.receiver.status().active, 0);
  assert.equal(h.released(), 1);
  h.receiver.stop(); h.publisher.stop(); h.runtime.close();
});
test('slow receiver cancellation invalidates late effects and bounded route queues recover', async () => {
  let finish: (() => void) | undefined, applied = 0, context: DeliveryContext | undefined;
  const h = harness({ apply: async (_observation, value) => { context = value; await new Promise<void>(resolve => { finish = resolve; });
    if (value.isCurrent()) applied++; } });
  h.approve('contact'); h.publisher.publish('contact', true); h.receiver.tick(); assert.equal(context?.signal.aborted, false);
  h.receiver.stop(); assert.equal(context?.signal.aborted, true); assert.equal(h.released(), 1);
  finish?.(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(applied, 0);
});
test('invalid constructor authority/clock options attach no listener', () => {
  const h = harness(); const peer = new Peer();
  assert.throws(() => new RemoteResourceReceiver({ authentication: 'local-diagnostic', peer, runtime: h.runtime, epoch: 'bad', clockId: 'host-clock', now: () => 100,
    principalId: 'owner', applicationId: 'app', sessionId: 'session' }));
  assert.throws(() => new RemoteResourceReceiver({ authentication: 'local-diagnostic', peer, runtime: h.runtime, epoch, clockId: 'foreign-clock', now: () => 100,
    principalId: 'owner', applicationId: 'app', sessionId: 'session' }));
  assert.equal(peer.listeners.size, 0); assert.equal(peer.states.size, 0);
});

test('owner grant expiry is enforced on receive before a host flush can apply new data', () => {
  const h = harness(); h.approve('position', 'json/1', { expiresAt: 1600, maxAgeMs: 100, maxHz: 60 });
  for (let now = 100; now < 1600; now += 20) { h.setNow(now); h.publisher.publish('position', { x: 0.1, y: 0.1 }); h.receiver.tick(); }
  const before = h.received.length;
  h.setNow(1600); h.publisher.publish('position', { x: 0.9, y: 0.9 }); h.runtime.flush();
  assert.equal(h.received.length, before); assert.equal(h.receiver.status().active, 0);
});
test('same-turn reliable edges are queued within cadence and preserve both transitions', () => {
  const h = harness(); h.approve('contact');
  assert.equal(h.publisher.publish('contact', true), true);
  assert.equal(h.publisher.publish('contact', false), true);
  assert.equal(h.publisher.status().pending, 1); h.receiver.tick();
  h.setNow(101); h.publisher.tick(); h.receiver.tick();
  assert.deepEqual(h.received.map(value => value.value), [true, false]);
  assert.equal(h.publisher.status().active, 1); assert.equal(h.publisher.status().pending, 0);
});
test('reliable cadence queue is bounded and expires without replaying stale edges', () => {
  const h = harness(); h.approve('contact'); h.publisher.publish('contact', true); h.receiver.tick();
  for (let index = 0; index < 64; index++) assert.equal(h.publisher.publish('contact', index % 2 === 0), true);
  assert.equal(h.publisher.status().pending, 64);
  assert.equal(h.publisher.publish('contact', false), false); assert.equal(h.publisher.status().pending, 0); assert.equal(h.released(), 1);
  const second = harness(); second.approve('contact'); second.publisher.publish('contact', true); second.receiver.tick();
  second.publisher.publish('contact', false); second.setNow(201); second.publisher.tick(); second.receiver.tick();
  assert.deepEqual(second.received.map(value => value.value), [true]); assert.equal(second.released(), 1); assert.equal(second.publisher.status().pending, 0);
});
test('deadman expiry after sustained silence is checked on receive before a host flush', () => {
  const h = harness(); h.approve(); h.publisher.publish('position', { x: 0.2, y: 0.2 }); h.receiver.tick();
  h.setNow(601); h.publisher.publish('position', { x: 0.9, y: 0.9 }); h.runtime.flush();
  assert.deepEqual(h.received.map(value => value.value), [{ x: 0.2, y: 0.2 }]); assert.equal(h.released(), 1);
});
test('a matched invalid clock exchange releases held output immediately', () => {
  const h = harness(); h.approve('contact');
  for (let now = 100; now < 1100; now += 50) { h.setNow(now); h.publisher.publish('contact', true); h.receiver.tick(); }
  h.setNow(1100); h.publisher.publish('contact', true); h.phone.hold = true; h.receiver.tick();
  const response = h.phone.queue.find(frame => decodePacket(frame.data, frame.lane)?.packet.type === 'clock')!;
  const packet = decodePacket(response.data, response.lane)!.packet;
  h.host.deliver({ lane: 'reliable', data: JSON.stringify({ ...packet, remoteReceivedAt: 2100, remoteSentAt: 2099 }) });
  assert.equal(h.released(), 1); assert.equal(h.receiver.status().active, 0);
});
test('queued delivery and async authority cannot survive owner approval expiry', async () => {
  let finish: (() => void) | undefined, context: DeliveryContext | undefined, applied = 0;
  const h = harness({ apply: async (_observation, value) => { context = value; await new Promise<void>(resolve => { finish = resolve; });
    if (value.isCurrent()) applied++; } });
  h.approve('position', 'json/1', { expiresAt: 1600, maxAgeMs: 100, maxHz: 60 });
  // Renew with valid fresh samples, while retaining one unresolved asynchronous effect.
  for (let now = 100; now < 1600; now += 20) { h.setNow(now); h.publisher.publish('position', { x: 0.1, y: 0.1 }); h.receiver.tick(); }
  h.setNow(1599); h.publisher.publish('position', { x: 0.9, y: 0.9 });
  h.setNow(1600); h.runtime.flush(); assert.equal(context?.signal.aborted, true); assert.equal(h.released(), 1);
  finish?.(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(applied, 0);
  const synchronous = harness(); synchronous.approve('position', 'json/1', { expiresAt: 1600, maxAgeMs: 100, maxHz: 60 });
  for (let now = 100; now < 1600; now += 20) { synchronous.setNow(now); synchronous.publisher.publish('position', { x: 0.1, y: 0.1 }); synchronous.receiver.tick(); }
  const before = synchronous.received.length; synchronous.setNow(1599); synchronous.publisher.publish('position', { x: 0.9, y: 0.9 });
  synchronous.setNow(1600); synchronous.runtime.flush(); assert.equal(synchronous.received.length, before); assert.equal(synchronous.released(), 1);
});
test('initial disconnected state notification detaches both subscriptions during construction', () => {
  const h = harness();
  const host = new Peer(); host.state = 'disconnected';
  const receiver = new RemoteResourceReceiver({ authentication: 'local-diagnostic', peer: host, runtime: h.runtime, epoch, clockId: 'host-clock', now: () => 100,
    principalId: 'owner', applicationId: 'app', sessionId: 'session' });
  receiver.stop(); assert.equal(host.listeners.size, 0); assert.equal(host.states.size, 0);
  const phone = new Peer(); phone.state = 'disconnected';
  const publisher = new RemoteResourcePublisher({ authentication: 'local-diagnostic', peer: phone, device: device(), epoch, clockId: 'phone-clock', now: () => 1100, available: () => true });
  publisher.stop(); assert.equal(phone.listeners.size, 0); assert.equal(phone.states.size, 0);
});
test('a replacement generation requires fresh approval and rejects old epoch samples', () => {
  const h = harness(); h.approve(); h.phone.hold = true; h.publisher.publish('position', { x: 0.8, y: 0.2 });
  const oldFrame = h.phone.queue.pop()!; h.receiver.stop(); h.publisher.stop(); h.phone.hold = false;
  const nextEpoch = 'fedcba9876543210fedcba9876543210';
  const receiver = new RemoteResourceReceiver({ authentication: 'local-diagnostic', peer: h.host, runtime: h.runtime, epoch: nextEpoch, clockId: 'host-clock', now: () => 100,
    principalId: 'owner', applicationId: 'app', sessionId: 'session' });
  const publisher = new RemoteResourcePublisher({ authentication: 'local-diagnostic', peer: h.phone, device: device(), epoch: nextEpoch, clockId: 'new-source-clock', now: () => 1100, available: () => true });
  publisher.start(); receiver.tick(); assert.equal(publisher.publish('position', { x: 0.1, y: 0.9 }), false);
  assert.equal(receiver.approve({ capability: 'position', sink: h.sinks.get('position')!, sinkDevice: device(true), sinkCapability: 'position',
    grant: { expiresAt: 10000, maxAgeMs: 100, maxHz: 60 } }), 1);
  h.host.deliver(oldFrame); receiver.tick(); assert.equal(h.received.length, 0);
  assert.equal(publisher.publish('position', { x: 0.1, y: 0.9 }), true); receiver.tick(); assert.deepEqual(h.received[0].value, { x: 0.1, y: 0.9 });
  publisher.stop(); receiver.stop(); assert.equal(h.host.listeners.size, 0); assert.equal(h.phone.listeners.size, 0);
});
test('jitter retains fresh replacement state while delayed stale packets cannot refresh a route', () => {
  const h = harness(); h.approve(); h.phone.hold = true;
  h.publisher.publish('position', { x: 0.2, y: 0.8 }); h.setNow(120); h.publisher.publish('position', { x: 0.8, y: 0.2 });
  const first = h.phone.queue.shift()!, second = h.phone.queue.shift()!;
  h.setNow(145); h.host.deliver(second); h.host.deliver(first); h.receiver.tick();
  assert.deepEqual(h.received[0].value, { x: 0.8, y: 0.2 });
  h.setNow(646); h.host.deliver(second); h.runtime.flush(); h.receiver.tick(); assert.equal(h.released(), 1); assert.equal(h.received.length, 1);
});
test('publisher readiness queries are capability-specific and disappear on slot loss', () => {
  const h = harness();
  assert.equal(h.publisher.isBound('position'), false);
  h.approve('contact'); h.approve('temperature');
  assert.equal(h.publisher.status().active, 2);
  assert.equal(h.publisher.isBound('position'), false);
  assert.equal(h.publisher.isBound('contact'), true);
  h.phone.disconnect();
  assert.equal(h.publisher.isBound('contact'), false);
});
