import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeWatchCompanionReport, watchCompanionReportDevice } from '../packages/device-model/src/watch-companion-report.ts';

const fixtureUrl = new URL('../bindings/watch-report/fixtures/watch-report-v1.json', import.meta.url);
function fixture() {
  const bytes = readFileSync(fixtureUrl);
  assert.ok(bytes.byteLength <= 32768);
  return JSON.parse(bytes.toString('utf8'));
}
function materialize(source: ReturnType<typeof fixture>, entry: ReturnType<typeof fixture>['decode'][number]) {
  const bytes = Uint8Array.from(Buffer.from(source.baseHex, 'hex'));
  for (const patch of entry.patches ?? []) bytes.set(Buffer.from(patch.hex, 'hex'), patch.offset);
  if (entry.length !== undefined) {
    const resized = new Uint8Array(entry.length); resized.set(bytes.subarray(0, entry.length)); return resized;
  }
  return bytes;
}
function meaning(source: ReturnType<typeof fixture>, entry: ReturnType<typeof fixture>['golden'][number]) {
  const value = { ...source.baseMeaning, ...entry.changes };
  for (const key of ['orientationReported', 'accelerationG', 'rotationDegPerSecond']) value[key] = value[key].map(Math.fround);
  value.crownReported = Math.fround(value.crownReported);
  return value;
}

test('shared watch fixtures cover every existing applicable codec profile with explicit incompatibility', () => {
  const source = fixture();
  assert.equal(source.schemaVersion, 1); assert.equal(source.contract, 'watch-report-contracts/1');
  assert.deepEqual(source.applicability, { javascript: 'watch-companion-report/1', swift: 'legacy-watch-payload/1', kotlin: 'legacy-watch-payload/1', c: 'watch-report-c-strict/1' });
  assert.ok(source.golden.length >= 6 && source.golden.length <= 16);
  assert.ok(source.decode.length >= 20 && source.decode.length <= 64);
  for (const entry of source.golden) {
    assert.equal(entry.accept.c, true, entry.id);
    const report = decodeWatchCompanionReport(materialize(source, entry));
    assert.deepEqual(report, { ...meaning(source, entry), physicalValidity: 'unspecified' }, entry.id);
  }
  let differences = 0;
  for (const entry of source.decode) {
    const bytes = materialize(source, entry);
    assert.equal(entry.accept.c, entry.accept.javascript, entry.id);
    if (!entry.accept.javascript) assert.throws(() => decodeWatchCompanionReport(bytes), entry.id);
    else assert.deepEqual(decodeWatchCompanionReport(bytes), { ...meaning(source, entry), physicalValidity: 'unspecified' }, entry.id);
    assert.equal(entry.accept.swift, entry.accept.kotlin, entry.id);
    if (entry.accept.javascript !== entry.accept.swift) {
      differences++;
      assert.equal(entry.difference, 'legacy-masks-reserved-buttons-strict-profile-rejects');
      assert.equal(entry.accept.javascript, false); assert.equal(entry.accept.swift, true);
    }
  }
  assert.equal(differences, 3);
});

test('fixture meaning never promotes relay emission into capture time or raw bytes into enrollment', () => {
  const source = fixture();
  assert.equal(source.timing.relayEmissionMs, 'uint32 milliseconds since relay start; emission, not capture');
  assert.equal(source.timing.captureTimeKnown, false);
  assert.deepEqual(source.absentFromWire, ['epoch', 'deviceIdentity', 'enrollment', 'quality', 'grants', 'captureClockMapping']);
  for (const platform of ['watchos', 'wearos'] as const) {
    const descriptor = watchCompanionReportDevice('watch:fixture', platform);
    assert.equal(descriptor.metadata?.captureTimeKnown, false);
    assert.deepEqual(descriptor.capabilities[0]?.permissions, ['subscribe']);
  }
  const zero = source.golden.find((entry: { id: string }) => entry.id === 'sequence-wrap-zero');
  assert.equal(meaning(source, zero).sequence, 0);
  assert.equal(decodeWatchCompanionReport(materialize(source, zero)).sequence, 0);
});
