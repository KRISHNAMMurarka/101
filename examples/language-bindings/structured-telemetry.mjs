import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeviceDescriptor, parseSignalValue, encodePacket, decodePacket } from '@101/connect';

// Ordinary installed public SDK caller. A selected codec creates no authority.
export function createStructuredTelemetryFixtures(schema) {
  const device = parseDeviceDescriptor(schema.descriptor);
  const epoch = '0123456789abcdef0123456789abcdef';
  const specimens = [
    ['record-absent', 'reading', { step: 0, mode: 'count-up' }, 1, 1, 0],
    ['record-false', 'reading', { step: 50.25, ready: false, mode: 'count-down' }, 128, 4294967295, 125.5],
    ['record-true', 'reading', { step: 100, ready: true, mode: 'count-up' }, 2, 4, 9007199254740991],
    ['one-row', 'table', [{ step: 1, ready: false, mode: 'count-up' }], 1, 6, 1400.25],
    ['eight-rows', 'table', Array.from({ length: 8 }, (_, i) => ({ step: i * 12.5,
      mode: i % 2 ? 'count-down' : 'count-up', ...(i % 3 ? { ready: i % 2 === 0 } : {}) })), 128, 32, 1500.125],
  ];
  const positive = specimens.map(([id, capability, value, slot, sequence, capturedAt]) => {
    const selected = device.capabilities.find(item => item.id === capability); assert.ok(selected);
    const parsed = parseSignalValue(value, selected.value);
    const wireUtf8 = encodePacket({ protocol: 'connect', version: 1, type: 'sample', epoch,
      slot, sequence, capturedAt, value: parsed }, 'json/2');
    assert.equal(typeof wireUtf8, 'string');
    const decoded = decodePacket(wireUtf8, 'disposable'); assert.equal(decoded?.codec, 'json/2');
    assert.equal(decoded.packet.version, 2); assert.deepEqual(decoded.packet.value, parsed);
    const bytes = Buffer.from(wireUtf8); assert.ok(bytes.length <= 4096);
    return { id, capability, inputVersion: 1, wireUtf8, hex: bytes.toString('hex'), bytes: bytes.length, meaning: decoded.packet };
  });
  const pointer = encodePacket({ protocol: 'connect', version: 1, type: 'sample', epoch,
    slot: 12, sequence: 5, capturedAt: 20.5, value: { x: .25, y: .75 } }, 'normalized-pointer/1');
  assert.ok(pointer instanceof ArrayBuffer);
  return { schemaVersion: 1, status: 'pass', profile: 'structured-telemetry-json2/1', positive,
    pointerPrefix: { hex: Buffer.from(pointer).toString('hex'), meaning: decodePacket(pointer, 'disposable').packet } };
}

export function verifyNativeStructuredOutput(schema, fixtures, output) {
  assert.ok(Buffer.byteLength(output) <= 1048576);
  const lines = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, fixtures.positive.length * 2);
  const device = parseDeviceDescriptor(schema.descriptor);
  for (const [index, entry] of fixtures.positive.entries()) {
    for (const result of lines.slice(index * 2, index * 2 + 2)) {
      assert.ok(result && /^[a-f0-9]+$/.test(result.hex) && result.hex.length % 2 === 0 && result.hex.length <= 8192);
      const decoded = decodePacket(Buffer.from(result.hex, 'hex').toString('utf8'), 'disposable');
      assert.equal(decoded?.codec, 'json/2'); assert.deepEqual(decoded.packet, entry.meaning);
      assert.deepEqual(result.packet, entry.meaning);
      const selected = device.capabilities.find(item => item.id === entry.capability); assert.ok(selected);
      assert.deepEqual(parseSignalValue(decoded.packet.value, selected.value), entry.meaning.value);
    }
  }
  return { result: 'pass', reciprocalValues: fixtures.positive.length, commands: lines.length,
    authority: 'inert-codec-only', sourceTimePreserved: true, nativeByteIdentityClaimed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 || args.length === 4);
  assert.equal(args[0], '--schema');
  const bytes = readFileSync(args[1]); assert.ok(bytes.length <= 131072);
  const schema = JSON.parse(bytes), fixtures = createStructuredTelemetryFixtures(schema);
  if (args.length === 4) {
    assert.equal(args[2], '--verify-native');
    const output = readFileSync(args[3], 'utf8');
    console.log(JSON.stringify(verifyNativeStructuredOutput(schema, fixtures, output)));
  } else console.log(JSON.stringify(fixtures));
}
