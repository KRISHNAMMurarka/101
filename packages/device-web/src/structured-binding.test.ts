import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from '@101/device-runtime';
import type { Observation } from '@101/device-runtime';
import type { ValueSchema } from '@101/device-model';
import { telemetryBatchDescriptor } from '../../../examples/device-pipelines/telemetry-batch.ts';
import { RemoteResourcePublisher, RemoteResourceReceiver } from './binding.ts';
import { decodePacket, encodePacket } from './wire.ts';

type Lane = 'reliable' | 'disposable';
// Explicit diagnostic delivery-port fixture, not a cryptographic/DTLS qualification.
class Peer {
  state = 'connected' as const;
  other?: Peer;
  listeners = new Set<(lane: Lane, data: string | ArrayBuffer) => void>();
  sent: { lane: Lane; data: string | ArrayBuffer }[] = [];
  isOpen() { return true; }
  send(lane: Lane, data: string | ArrayBuffer | Uint8Array) {
    const frame = { lane, data: typeof data === 'string' ? data : data instanceof ArrayBuffer ? data.slice(0) : new Uint8Array(data).buffer };
    this.sent.push(frame); this.other?.deliver(frame); return true;
  }
  deliver(frame: { lane: Lane; data: string | ArrayBuffer }) { for (const listener of [...this.listeners]) listener(frame.lane, frame.data); }
  onData(listener: (lane: Lane, data: string | ArrayBuffer) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onStateChange() { return () => {}; }
}

function harness(reliable = false, schema?: ValueSchema) {
  let now = 1000, released = 0;
  const rich = schema && ['contact', 'pen', 'key', 'text', 'wheel', 'relative-motion'].includes(schema.type);
  const epoch = 'b'.repeat(32), sourceDevice = telemetryBatchDescriptor(2), sinkDevice = telemetryBatchDescriptor(2, true);
  const source = { ...sourceDevice, capabilities: sourceDevice.capabilities.map(capability => ({ ...capability,
    value: schema ?? capability.value, ...(reliable ? { kind: 'event' as const, delivery: { mode: 'reliable' as const, maxAgeMs: 1000 } } : {}) })) };
  const sinkDescription = { ...sinkDevice, capabilities: sinkDevice.capabilities.map(capability => ({ ...capability,
    value: schema ?? capability.value, ...(rich ? { kind: 'event' as const } : {}),
    ...(reliable ? { delivery: { mode: 'reliable' as const, maxAgeMs: 1000 } } : {}) })) };
  const received: Observation[] = [], host = new Peer(), remote = new Peer(); host.other = remote; remote.other = host;
  const runtime = createDeviceRuntime({ now: () => now, clockDomain: 'host-clock', authorize(request) {
    if (request.principalId !== 'fixture-owner' || request.applicationId !== 'fixture-app' || request.sessionId !== 'fixture-session' ||
      request.source.deviceId !== source.id || request.sink.registrationId !== sink.id) return;
    return { expiresAt: 10000, maxAgeMs: 1000, maxHz: 1000 };
  } });
  const sink = runtime.registerSink({ device: sinkDescription, capability: 'readings',
    apply(observation, context) { if (context.isCurrent()) received.push(observation); }, release() { released++; } });
  runtime.setReadiness(sink, 'available');
  const receiver = new RemoteResourceReceiver({ authentication: 'local-diagnostic', peer: host, epoch, clockId: 'host-clock', now: () => now,
    runtime, principalId: 'fixture-owner', applicationId: 'fixture-app', sessionId: 'fixture-session' });
  const publisher = new RemoteResourcePublisher({ authentication: 'local-diagnostic', peer: remote, epoch, clockId: 'source-clock', now: () => now + 100,
    device: source, available: () => true });
  assert.equal(publisher.start(), true); receiver.tick();
  const approve = (codec?: 'json/1' | 'json/2' | 'normalized-pointer/1') => receiver.approve({ capability: 'readings', sink,
    sinkDevice: sinkDescription, sinkCapability: 'readings', codec, grant: { expiresAt: 10000, maxAgeMs: 1000, maxHz: 1000 } });
  return { epoch, host, remote, received, receiver, publisher, approve, released: () => released,
    setTime(value: number) { now = value; }, close() { publisher.stop(); receiver.stop(); runtime.close(); } };
}

test('structured capabilities negotiate json/2, retain nested source-clock values and release on stop', () => {
  for (const reliable of [false, true]) {
    const h = harness(reliable);
    try {
      const description = decodePacket(h.remote.sent[0].data, 'reliable')?.packet;
      assert.ok(description?.type === 'describe'); assert.deepEqual(description.codecs, ['json/1', 'json/2']);
      assert.equal(h.approve('json/1'), undefined); assert.equal(h.approve('normalized-pointer/1'), undefined);
      assert.equal(h.approve(), 1);
      const readings = [{ timestamp: 1090, residentBytes: 65536 }, { timestamp: 1100, residentBytes: 69632, quality: 'observed' }];
      assert.equal(h.publisher.publish('readings', readings), true); h.receiver.tick();
      assert.deepEqual(h.received.map(observation => observation.value), [readings]);
      assert.equal(h.received[0].clockDomain, 'host-clock'); assert.equal(h.received[0].provenance?.remoteClockId, 'source-clock');
      assert.equal(h.received[0].provenance?.remoteCapturedAt, 1100);
      const frame = h.remote.sent.find(frame => decodePacket(frame.data, frame.lane)?.codec === 'json/2')!;
      assert.equal(frame.lane, reliable ? 'reliable' : 'disposable');
      assert.equal(decodePacket(frame.data, frame.lane)?.packet.version, 2);
      h.publisher.stop(); assert.equal(h.released(), 1);
    } finally { h.close(); }
  }
});

test('spatial pose values negotiate json/2 and reject json/1 without relaxing the bounded lane', () => {
  const schema: ValueSchema = { type: 'pose', frame: { id: 'test:watch', origin: 'test:room', unit: 'm',
    axes: ['right', 'up', 'forward'], handedness: 'right' }, extent: 2 };
  const h = harness(false, schema);
  try {
    const description = decodePacket(h.remote.sent[0].data, 'reliable')?.packet;
    assert.ok(description?.type === 'describe');
    assert.deepEqual(description.codecs, ['json/1', 'json/2']);
    assert.equal(h.approve('json/1'), undefined);
    assert.equal(h.approve('json/2'), 1);
    const pose = { position: { x: 1, y: 0.5, z: -1 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
    assert.equal(h.publisher.publish('readings', pose), true);
    h.receiver.tick();
    assert.deepEqual(h.received.map(observation => observation.value), [pose]);
    const frame = h.remote.sent.find(entry => decodePacket(entry.data, entry.lane)?.codec === 'json/2');
    assert.ok(frame);
    assert.equal(decodePacket(frame.data, frame.lane)?.packet.version, 2);
  } finally { h.close(); }
});

test('key edges use the reliable json/2 event lane without latest-sample replacement', () => {
  const h = harness(true, { type: 'key' });
  try {
    const description = decodePacket(h.remote.sent[0].data, 'reliable')?.packet;
    assert.ok(description?.type === 'describe');
    assert.deepEqual(description.codecs, ['json/1', 'json/2']);
    assert.equal(h.approve('json/1'), undefined);
    assert.equal(h.approve('json/2'), 1);
    const modifiers = { shift: false, control: false, alt: false, meta: false };
    const down = { code: 'KeyA', key: 'a', phase: 'down', repeat: false, location: 0, composing: false, modifiers };
    const up = { ...down, phase: 'up' };
    assert.equal(h.publisher.publish('readings', down), true); h.receiver.tick();
    h.setTime(1002);
    assert.equal(h.publisher.publish('readings', up), true); h.receiver.tick();
    assert.deepEqual(h.received.map(observation => observation.value), [down, up]);
    const frames = h.remote.sent.filter(entry => decodePacket(entry.data, entry.lane)?.codec === 'json/2');
    assert.equal(frames.length, 2);
    assert.ok(frames.every(frame => frame.lane === 'reliable'));
  } finally { h.close(); }
});

test('wrong codec/version, scope, unknown fields, malformed members and replay cannot enter a structured slot', () => {
  const h = harness();
  try {
    assert.equal(h.approve(), 1);
    const packet = { protocol: 'connect', version: 2, epoch: h.epoch, type: 'sample', slot: 1, sequence: 1, capturedAt: 1100,
      value: [{ timestamp: 1100, residentBytes: 65536 }] };
    for (const changes of [{ version: 1 }, { epoch: 'c'.repeat(32) }, { slot: 128 }, { principalId: 'admin' },
      { value: [{ timestamp: 1100, residentBytes: 1, extra: true }] }, { value: [{ timestamp: 1100 }] }, { value: Array(17).fill(packet.value[0]) }]) {
      h.host.deliver({ lane: 'disposable', data: JSON.stringify({ ...packet, ...changes }) }); h.receiver.tick();
      assert.equal(h.received.length, 0);
    }
    h.host.deliver({ lane: 'disposable', data: encodePacket(packet, 'json/2') }); h.receiver.tick(); assert.equal(h.received.length, 1);
    h.host.deliver({ lane: 'disposable', data: encodePacket(packet, 'json/2') }); h.receiver.tick(); assert.equal(h.received.length, 1);
  } finally { h.close(); }
});

test('a model-valid oversized batch fails before queueing or consuming a wire sequence', () => {
  const fields = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`field${index}`, { type: 'enum' as const, values: ['x'.repeat(128)] }]));
  const schema: ValueSchema = { type: 'array', minItems: 1, maxItems: 16, items: { type: 'record', fields } };
  const h = harness(false, schema);
  try {
    assert.equal(h.approve(), 1);
    const row = Object.fromEntries(Object.keys(fields).map(name => [name, 'x'.repeat(128)]));
    assert.equal(h.publisher.publish('readings', Array(16).fill(row)), false);
    assert.equal(h.publisher.status().pending, 0); assert.equal(h.received.length, 0);
    assert.equal(h.publisher.publish('readings', [row]), true); h.receiver.tick();
    assert.equal(h.received.length, 1); assert.equal(h.received[0].sequence, 1);
  } finally { h.close(); }
});

test('runtime envelope budget rejects a wire-valid batch without extending freshness and permits smaller recovery', () => {
  const fields = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`field${index}`, { type: 'enum' as const, values: ['x'.repeat(128)] }]));
  const schema: ValueSchema = { type: 'array', minItems: 1, maxItems: 16, items: { type: 'record', fields } };
  for (const reliable of [false, true]) {
    const h = harness(reliable, schema);
    try {
      assert.equal(h.approve(), 1);
      const row = Object.fromEntries(Object.keys(fields).map(name => [name, 'x'.repeat(128)]));
      const rejected = Array(9).fill(row);
      assert.equal(h.publisher.publish('readings', rejected), true, 'Transport handoff is not host runtime admission');
      assert.equal(h.received.length, 0); assert.equal(h.receiver.status().reason, 'payload-limit');
      assert.equal(h.receiver.status().active, 1); assert.equal(h.released(), 0);
      const wire = h.remote.sent.find(frame => decodePacket(frame.data, frame.lane)?.codec === 'json/2')!;
      assert.ok(typeof wire.data === 'string' && new TextEncoder().encode(wire.data).length < 4096);
      h.setTime(1100); assert.equal(h.publisher.publish('readings', [row]), true); h.receiver.tick();
      assert.equal(h.received.length, 1); assert.equal(h.received[0].sequence, 2);
      for (const time of [1200, 1400, 1600, 1800, 2000]) {
        h.setTime(time); assert.equal(h.publisher.publish('readings', rejected), true); h.receiver.tick();
        assert.equal(h.received.length, 1);
      }
      h.setTime(2101); h.receiver.tick();
      assert.equal(h.receiver.status().active, 0); assert.equal(h.released(), 1);
    } finally { h.close(); }
  }
});
