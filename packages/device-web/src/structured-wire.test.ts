import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePacket, encodePacket } from './wire.ts';

const envelope = { protocol: 'connect', version: 1, epoch: 'a'.repeat(32), type: 'sample', slot: 1, sequence: 1, capturedAt: 100 };
const batch = [{ timestamp: 90, residentBytes: 65536 }, { timestamp: 100, residentBytes: 69632, quality: 'observed' }];

test('structured JSON values have a distinct negotiated wire version and immutable roundtrip', () => {
  const input = { ...envelope, value: batch };
  const encoded = encodePacket(input, 'json/2');
  assert.equal(typeof encoded, 'string');
  const decoded = decodePacket(encoded, 'disposable')!;
  assert.equal(decoded.codec, 'json/2'); assert.equal(decoded.packet.version, 2);
  assert.deepEqual((decoded.packet as { value: unknown }).value, batch);
  assert.ok(Object.isFrozen((decoded.packet as { value: unknown }).value));
  const values = (decoded.packet as { value: unknown }).value;
  assert.ok(Array.isArray(values)); assert.ok(Object.isFrozen(values[0]));
  assert.throws(() => encodePacket(input, 'json/1'));
  assert.equal(decodePacket(JSON.stringify(input), 'disposable'), undefined);
  assert.equal(decodePacket(encoded, 'reliable'), undefined);
});

test('structured reliable events retain their own codec, operation and deadline', () => {
  const encoded = encodePacket({ ...envelope, type: 'event', value: { active: true, batch }, operationId: '1', deadline: 200 }, 'json/2');
  const decoded = decodePacket(encoded, 'reliable')!;
  assert.equal(decoded.codec, 'json/2'); assert.equal(decoded.packet.type, 'event');
  assert.equal(decoded.packet.version, 2);
  assert.equal(decodePacket(encoded, 'disposable'), undefined);
  assert.equal(decodePacket(JSON.stringify({ ...envelope, version: 2, type: 'clock', id: 1, sentAt: 100 }), 'reliable'), undefined);
});

test('structured wire rejects oversized, sparse, executable, nonfinite and excessive nesting values', () => {
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'temperature', { enumerable: true, get() { getterCalls++; return 30; } });
  let deep: unknown = 1;
  for (let index = 0; index < 10; index++) deep = { nested: deep };
  for (const value of [getter, Array(2), new Date(), { bad: Infinity }, { missing: undefined }, { callback: () => 1 }, { bad: null }, deep,
    Array.from({ length: 128 }, () => ({ payload: 'x'.repeat(80) }))]) {
    assert.throws(() => encodePacket({ ...envelope, value }, 'json/2'));
  }
  assert.equal(getterCalls, 0);
  assert.equal(decodePacket(JSON.stringify({ ...envelope, version: 2, value: Array(129).fill(1) }), 'disposable'), undefined);
});

test('compact pointer cannot drop extra structured fields and old primitive wire bytes stay version one', () => {
  assert.throws(() => encodePacket({ ...envelope, value: { x: 0.2, y: 0.8, extra: { active: true } } }, 'normalized-pointer/1'));
  for (const value of [true, 5, 'enum-state', { x: 0.2, y: 0.8 }]) {
    const encoded = encodePacket({ ...envelope, value });
    assert.deepEqual(JSON.parse(encoded as string), { ...envelope, value });
    assert.equal(decodePacket(encoded, 'disposable')?.codec, 'json/1');
  }
  assert.equal((encodePacket({ ...envelope, value: { x: 0.2, y: 0.8 } }, 'normalized-pointer/1') as ArrayBuffer).byteLength, 48);
});
