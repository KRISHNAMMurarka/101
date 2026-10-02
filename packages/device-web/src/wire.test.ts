import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePacket, encodePacket } from './wire.ts';
import type { WirePacket, WireValue } from './wire.ts';
import type { DeviceDescriptor } from '../../device-model/src/descriptor.ts';

const epoch = '00112233445566778899aabbccddeeff';
const base = { protocol: 'connect' as const, version: 1 as const, epoch };
const device: DeviceDescriptor = {
  schemaVersion: 1, id: 'pointer', label: 'Pointer', revision: 1,
  adapter: { id: 'example:pointer', version: '1' }, runtime: { platform: 'test' },
  capabilities: [{ id: 'position', semantic: 'app:pointer-position/1', schemaVersion: 1, kind: 'sample',
    value: { type: 'vector', components: ['x', 'y'], unit: '1', frame: 'surface-normalized', min: 0, max: 1 },
    delivery: { mode: 'latest', maxHz: 60, maxAgeMs: 100 }, permissions: ['subscribe'] }],
};
const describe = { ...base, type: 'describe' as const, device, clockId: 'clock-1', codecs: ['json/1', 'normalized-pointer/1'] as const };
const sample: WireValue = { ...base, type: 'sample', slot: 1, sequence: 1, capturedAt: 1234.125, value: { x: 0.25, y: 0.75 } };
const event: WireValue = { ...base, type: 'event', slot: 2, sequence: 2, capturedAt: 1234.125, value: false, operationId: '2', deadline: 1300 };
const controls: WirePacket[] = [
  describe,
  { ...base, type: 'bind', slot: 1, capability: 'position', descriptorRevision: 1, schemaVersion: 1, codec: 'normalized-pointer/1', maxHz: 60, maxAgeMs: 100 },
  { ...base, type: 'ready', slot: 1, maxHz: 60, maxAgeMs: 100 },
  { ...base, type: 'stop', slot: 1, reason: 'unavailable' },
  { ...base, type: 'clock', id: 1, sentAt: 0 },
  { ...base, type: 'clock', id: 1, sentAt: 0, remoteReceivedAt: 1.125, remoteSentAt: 1.25 },
];

function rejected(packet: unknown, lane: 'reliable' | 'disposable' = 'reliable') {
  assert.equal(decodePacket(JSON.stringify(packet), lane), undefined, JSON.stringify(packet));
  assert.throws(() => encodePacket(packet));
}

test('JSON retains general controls, signal types, events and immutable snapshots on their lanes', () => {
  const reliablePackets: WirePacket[] = [...controls, event];
  for (const packet of reliablePackets) {
    const encoded = encodePacket(packet);
    assert.equal(typeof encoded, 'string');
    assert.deepEqual(decodePacket(encoded, 'reliable'), { packet, codec: 'json/1' });
    assert.equal(decodePacket(encoded, 'disposable'), undefined);
  }
  for (const value of [false, 31.25, 'on', { x: -1, y: 2, z: 3 }]) {
    const packet: WireValue = { ...sample, value };
    const decoded = decodePacket(encodePacket(packet), 'disposable');
    assert.deepEqual(decoded, { packet, codec: 'json/1' });
    assert.equal(Object.isFrozen(decoded?.packet), true);
    assert.equal(decodePacket(encodePacket(packet), 'reliable'), undefined);
  }
  const input = { ...sample, value: { x: 0.25, y: 0.75 } };
  const decoded = decodePacket(encodePacket(input), 'disposable');
  input.value.x = 1;
  assert.deepEqual((decoded?.packet as WireValue).value, { x: 0.25, y: 0.75 });
  assert.equal(Object.isFrozen((decoded?.packet as WireValue).value), true);
});

test('malformed JSON, unknown protocol vocabulary and codecs fail closed', () => {
  for (const json of ['', '{', 'null', '[]', 'true', '1', '"connect"']) assert.equal(decodePacket(json, 'reliable'), undefined);
  for (const change of [{ protocol: 'other' }, { version: 2 }, { type: 'invoke' }, { principal: 'host' }, { epoch: epoch.toUpperCase() }, { epoch: 'a'.repeat(31) }, { epoch: 'g'.repeat(32) }]) rejected({ ...describe, ...change });
  for (const codecs of [[], ['normalized-pointer/1'], ['json/1', 'json/1'], ['json/1', 'unknown/1'], ['json/2'], ['json/1', 'normalized-pointer/1', 'json/1']]) rejected({ ...describe, codecs });
  for (const clockId of ['', 'x'.repeat(129), 'clock\n1', 123]) rejected({ ...describe, clockId });
  const { clockId: omitted, ...withoutClock } = describe;
  assert.equal(omitted, 'clock-1');
  rejected(withoutClock);
  rejected({ ...controls[1], codec: 'normalized-pointer/2' });
  assert.throws(() => encodePacket(sample, 'unknown/1' as never));
});

test('slots, sequences, revisions and ready limits reject first invalid bounds', () => {
  for (const slot of [0, 129, 1.5, '1']) rejected({ ...sample, slot }, 'disposable');
  for (const sequence of [0, 4294967296, 1.5, '1']) rejected({ ...sample, sequence }, 'disposable');
  assert.ok(decodePacket(encodePacket({ ...sample, slot: 128, sequence: 4294967295 }), 'disposable'));
  for (const key of ['descriptorRevision', 'schemaVersion']) for (const value of [0, 4294967296, 1.5]) rejected({ ...controls[1], [key]: value });
  for (const type of ['ready', 'bind']) {
    const control = type === 'ready' ? controls[2] : controls[1];
    for (const change of [{ maxHz: 0 }, { maxHz: 1001 }, { maxHz: NaN }, { maxAgeMs: 0 }, { maxAgeMs: 60001 }, { maxAgeMs: Infinity }]) rejected({ ...control, ...change });
    assert.ok(decodePacket(encodePacket({ ...control, maxHz: 1.5, maxAgeMs: 1.5 }), 'reliable'));
  }
  rejected({ ...controls[3], reason: 'raw-error' });
  for (const id of [0, 4294967296, 1.5]) rejected({ ...controls[4], id });
});

test('capture, clock and event shape require finite times and canonical safe operation IDs', () => {
  for (const capturedAt of [-1, NaN, Infinity, '0']) rejected({ ...sample, capturedAt }, 'disposable');
  for (const value of [NaN, Infinity, null, [], { x: 0 }, { x: 0, y: 1, extra: 2 }, { x: 0, y: Infinity }]) rejected({ ...sample, value }, 'disposable');
  for (const operationId of ['0', '01', '+1', '-1', '1.0', '1e2', '9007199254740992', 1, '']) rejected({ ...event, operationId });
  assert.ok(decodePacket(encodePacket({ ...event, operationId: '9007199254740991' }), 'reliable'));
  for (const deadline of [event.capturedAt, event.capturedAt - 1, Infinity, NaN, '1300']) rejected({ ...event, deadline });
  const { operationId, ...noOperation } = event;
  const { deadline, ...noDeadline } = event;
  assert.equal(operationId, '2'); assert.equal(deadline, 1300);
  rejected(noOperation); rejected(noDeadline);
  rejected({ ...sample, operationId: '1' }, 'disposable');
  rejected({ ...sample, deadline: 1300 }, 'disposable');
  rejected({ ...controls[4], remoteReceivedAt: 1 });
  rejected({ ...controls[4], remoteSentAt: 1 });
  for (const key of ['sentAt', 'remoteReceivedAt', 'remoteSentAt']) for (const value of [-1, NaN, Infinity]) rejected({ ...controls[5], [key]: value });
});

test('UTF-8 packet limits and the independent descriptor limit reject oversized non-ASCII payloads', () => {
  const payload = { ...sample, value: '' };
  const overhead = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  const exact = { ...payload, value: 'x'.repeat(4096 - overhead) };
  assert.ok(decodePacket(encodePacket(exact), 'disposable'));
  rejected({ ...exact, value: `${exact.value}x` }, 'disposable');
  rejected({ ...payload, value: 'é'.repeat(2048) }, 'disposable');
  const descriptor = { ...device, metadata: { note: '' } };
  const descriptorBytes = new TextEncoder().encode(JSON.stringify(descriptor)).byteLength;
  const exactDevice = { ...descriptor, metadata: { note: 'x'.repeat(65536 - descriptorBytes) } };
  assert.ok(decodePacket(encodePacket({ ...describe, device: exactDevice }), 'reliable'));
  rejected({ ...describe, device: { ...exactDevice, metadata: { note: `${exactDevice.metadata.note}x` } } });
  rejected({ ...describe, device: { ...descriptor, metadata: { note: 'é'.repeat(32768) } } });
  assert.equal(decodePacket(' '.repeat(66 * 1024 + 1), 'reliable'), undefined);
  assert.equal(decodePacket('é'.repeat(34 * 1024), 'reliable'), undefined);
  rejected({ ...describe, device: { ...device, unexpected: true } });
  rejected({ ...describe, device: JSON.stringify(device) });
  rejected({ ...describe, device: { ...device, capabilities: Array.from({ length: 129 }, (_, i) => ({ ...device.capabilities[0], id: `p-${i}` })) } });
});

test('encoder rejects accessors, prototypes, cycles and non-JSON data without evaluating getters', () => {
  let calls = 0;
  const getter = Object.defineProperty({ ...sample }, 'capturedAt', { enumerable: true, get() { calls += 1; return 0; } });
  const nestedGetter = Object.defineProperty({ y: 1 }, 'x', { enumerable: true, get() { calls += 1; return 0; } });
  const descriptorGetter = Object.defineProperty({ ...device }, 'label', { enumerable: true, get() { calls += 1; return 'Pointer'; } });
  for (const input of [getter, { ...sample, value: nestedGetter }, { ...describe, device: descriptorGetter }, Object.assign(Object.create({ inherited: true }), sample), { ...sample, value: new Date() }, { ...sample, value: 1n }, { ...sample, [Symbol('secret')]: 1 }, Object.defineProperty({ ...sample }, 'hidden', { value: true })]) assert.throws(() => encodePacket(input));
  assert.equal(calls, 0);
  const cycle: Record<string, unknown> = { ...device }; cycle.metadata = cycle;
  assert.throws(() => encodePacket({ ...describe, device: cycle }));
  let inspectedTail = false;
  const tail = new Proxy({}, { ownKeys() { inspectedTail = true; return []; } });
  assert.throws(() => encodePacket({ ...describe, device: { ...device, metadata: { first: 'x'.repeat(32768), second: 'x'.repeat(32768), tail } } }));
  assert.equal(inspectedTail, false);
  assert.throws(() => encodePacket({ ...sample, value: Object.create({ x: 0, y: 1 }) }));
});

test('compact pointer has independently specified network-order bytes and preserves float64 capture time', () => {
  const encoded = encodePacket({ ...sample, slot: 128, sequence: 0x01020304 }, 'normalized-pointer/1');
  assert.ok(encoded instanceof ArrayBuffer);
  const expected = [0x43, 0x4e, 1, 1, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0, 128, 0, 0, 1, 2, 3, 4, 0x40, 0x93, 0x48, 0x80, 0, 0, 0, 0, 0x3e, 0x80, 0, 0, 0x3f, 0x40, 0, 0, 0, 0, 0, 0];
  assert.deepEqual([...new Uint8Array(encoded)], expected);
  assert.deepEqual(decodePacket(encoded, 'disposable'), { packet: { ...sample, slot: 128, sequence: 0x01020304 }, codec: 'normalized-pointer/1' });
  assert.equal(decodePacket(encoded, 'reliable'), undefined);
  const time = 123456789.12345679;
  assert.equal((decodePacket(encodePacket({ ...sample, capturedAt: time }, 'normalized-pointer/1'), 'disposable')?.packet as WireValue).capturedAt, time);
});

test('compact pointer rejects wrong lengths, reserved bits, profile tags and numeric bounds', () => {
  const valid = encodePacket(sample, 'normalized-pointer/1') as ArrayBuffer;
  for (const length of [0, 47, 49, 100]) assert.equal(decodePacket(new ArrayBuffer(length), 'disposable'), undefined);
  for (const index of [0, 1, 2, 3, 22, 23, 44, 45, 46, 47]) {
    const bytes = valid.slice(0); new Uint8Array(bytes)[index] ^= 2;
    assert.equal(decodePacket(bytes, 'disposable'), undefined, `byte ${index}`);
  }
  for (const [offset, value] of [[20, 0], [20, 129]]) { const bytes = valid.slice(0); new DataView(bytes).setUint16(offset, value); assert.equal(decodePacket(bytes, 'disposable'), undefined); }
  const zeroSequence = valid.slice(0); new DataView(zeroSequence).setUint32(24, 0); assert.equal(decodePacket(zeroSequence, 'disposable'), undefined);
  for (const time of [-1, NaN, Infinity]) { const bytes = valid.slice(0); new DataView(bytes).setFloat64(28, time); assert.equal(decodePacket(bytes, 'disposable'), undefined); }
  for (const offset of [36, 40]) for (const value of [-0.1, 1.1, NaN, Infinity]) { const bytes = valid.slice(0); new DataView(bytes).setFloat32(offset, value); assert.equal(decodePacket(bytes, 'disposable'), undefined); }
  for (const packet of [event, controls[2], { ...sample, value: 1 }, { ...sample, value: { x: 0, y: 1, z: 0 } }, { ...sample, value: { x: -0.1, y: 0 } }, { ...sample, value: { x: 1.1, y: 0 } }]) assert.throws(() => encodePacket(packet, 'normalized-pointer/1'));
});

test('compact coordinates preserve both diagonal directions within the absolute error contract', () => {
  for (const coordinate of [0, 0.0000001, 0.123456789, 0.49999999, 0.50000003, 0.99999998, 1]) {
    for (const value of [{ x: coordinate, y: coordinate }, { x: coordinate, y: 1 - coordinate }]) {
      const decoded = decodePacket(encodePacket({ ...sample, value }, 'normalized-pointer/1'), 'disposable');
      const result = (decoded?.packet as WireValue).value as { x: number; y: number };
      assert.ok(Math.abs(result.x - value.x) <= 2 ** -25);
      assert.ok(Math.abs(result.y - value.y) <= 2 ** -25);
    }
  }
});
