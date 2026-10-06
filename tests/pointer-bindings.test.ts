import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodePacket, encodePacket } from '../packages/device-web/src/wire.ts';

const path = new URL('../bindings/normalized-pointer/fixtures/normalized-pointer-v1.json', import.meta.url);
test('native binding fixtures retain public pointer bytes and independently rejected malformed packets', () => {
  const fixtures = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(fixtures.positive.length >= 5 && fixtures.positive.length <= 32);
  assert.ok(fixtures.negative.length >= 20 && fixtures.negative.length <= 64);
  for (const entry of fixtures.positive) {
    const encoded = encodePacket(entry.input, 'normalized-pointer/1');
    assert.ok(encoded instanceof ArrayBuffer);
    assert.equal(Buffer.from(encoded).toString('hex'), entry.hex);
    const decoded = decodePacket(Uint8Array.from(Buffer.from(entry.hex, 'hex')).buffer, 'disposable');
    assert.equal(decoded?.codec, 'normalized-pointer/1');
  }
  const publisher = fixtures.positive[0];
  assert.equal(publisher.id, 'actual-publisher');
  assert.equal(publisher.hex, '434e01010123456789abcdef0123456789abcdef0001000000000001408f4000000000003e8000003f40000000000000');
  for (const entry of fixtures.negative) assert.equal(decodePacket(Uint8Array.from(Buffer.from(entry.hex, 'hex')).buffer, entry.lane), undefined, entry.id);
  for (const line of fixtures.invalidEncode) {
    const [, epoch, slot, sequence, capturedAt, x, y] = line.split(' ');
    assert.equal(typeof epoch, 'string');
    assert.throws(() => encodePacket({ protocol: 'connect', version: 1, type: 'sample', epoch,
      slot: Number(slot), sequence: Number(sequence), capturedAt: Number(capturedAt), value: { x: Number(x), y: Number(y) } }, 'normalized-pointer/1'));
  }
});
