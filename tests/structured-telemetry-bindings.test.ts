import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSignalValue } from '../packages/device-model/src/sample.ts';
import { encodePacket, decodePacket } from '../packages/device-web/src/wire.ts';
import { pageReadingDescriptor } from '../app/connections/readings/readings-schema.ts';

test('selected Swift telemetry fixtures match the actual page schemas and public producers', () => {
  const schema = JSON.parse(readFileSync(new URL('../bindings/structured-telemetry/fixtures/page-readings-v1.json', import.meta.url), 'utf8'));
  const fixtures = JSON.parse(readFileSync(new URL('../bindings/structured-telemetry/fixtures/structured-telemetry-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.descriptor, pageReadingDescriptor('native-codec-fixture'));
  assert.equal(fixtures.positive.length, 5);
  for (const entry of fixtures.positive) {
    const capability = schema.descriptor.capabilities.find((item: { id: string }) => item.id === entry.capability);
    assert.ok(capability);
    assert.deepEqual(parseSignalValue(entry.meaning.value, capability.value), entry.meaning.value);
    assert.equal(encodePacket({ ...entry.meaning, version: 1 }, 'json/2'), entry.wireUtf8);
    assert.equal(Buffer.from(entry.wireUtf8).toString('hex'), entry.hex);
    assert.deepEqual(decodePacket(entry.wireUtf8, 'disposable')?.packet, entry.meaning);
    assert.equal(decodePacket(entry.wireUtf8, 'reliable'), undefined);
  }
  assert.equal(Object.hasOwn(fixtures.positive[0].meaning.value, 'ready'), false);
  assert.equal(fixtures.positive[1].meaning.value.ready, false);
});
