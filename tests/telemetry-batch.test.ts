import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelemetryBatchPipeline, telemetryBatchDescriptor, upgradeTelemetryBatchV1 } from '../examples/device-pipelines/telemetry-batch.ts';
import { schemasCompatible } from '@101/device-model';

test('actual authorized batch consumer retains optional quality and releases its state', () => {
  const pipeline = createTelemetryBatchPipeline({ now: () => 1000 });
  try {
    assert.equal(pipeline.start.ok, true);
    const batch = [{ timestamp: 980, residentBytes: 65536 }, { timestamp: 1000, residentBytes: 69632, quality: 'observed' }];
    assert.equal(pipeline.publish(batch).ok, true); pipeline.runtime.flush();
    batch[1].residentBytes = 0;
    assert.equal(pipeline.state().count, 2); assert.equal(pipeline.state().residentBytes, 69632);
    assert.equal(pipeline.state().quality, 'observed');
    pipeline.connection.stop(); assert.equal(pipeline.state().count, 0); assert.equal(pipeline.state().released, 1);
    assert.equal(pipeline.state().residentBytes, undefined);
  } finally { pipeline.runtime.close(); }
});

test('version migration is explicit; incompatible capabilities cannot route or reinterpret data', () => {
  const old = [{ timestamp: 990, residentBytes: 65536 }];
  const upgraded = upgradeTelemetryBatchV1(old);
  assert.deepEqual(upgraded, [{ ...old[0], quality: 'unverified' }]);
  assert.ok(Object.isFrozen(upgraded) && Object.isFrozen(upgraded[0]));
  const source = telemetryBatchDescriptor(1).capabilities[0], sink = telemetryBatchDescriptor(2, true).capabilities[0];
  assert.equal(schemasCompatible(source, sink), false);
  const mismatch = createTelemetryBatchPipeline({ version: 1, sinkVersion: 2, now: () => 1000 });
  try { assert.equal(mismatch.start.ok, false); assert.equal(mismatch.state().count, 0); } finally { mismatch.runtime.close(); }
  const pipeline = createTelemetryBatchPipeline({ now: () => 1000 });
  try {
    assert.equal(pipeline.publish(upgraded).ok, true); pipeline.runtime.flush();
    assert.equal(pipeline.state().quality, 'unverified');
    assert.throws(() => upgradeTelemetryBatchV1([{ ...old[0], quality: 'observed' }]));
  } finally { pipeline.runtime.close(); }
});

test('bad members, array bounds and local-clock timestamp errors fail before consumer effect', () => {
  const pipeline = createTelemetryBatchPipeline({ now: () => 1000 });
  try {
    for (const batch of [[], Array(17).fill({ timestamp: 1000, residentBytes: 1 }),
      [{ timestamp: 1001, residentBytes: 1 }], [{ timestamp: -1, residentBytes: 1 }],
      [{ timestamp: 1000, residentBytes: 1 }, { timestamp: 999, residentBytes: 2 }],
      [{ timestamp: 1000, residentBytes: NaN }], [{ timestamp: 1000, residentBytes: 1, extra: true }]]) {
      assert.throws(() => pipeline.publish(batch)); pipeline.runtime.flush(); assert.equal(pipeline.state().count, 0);
    }
  } finally { pipeline.runtime.close(); }
});

test('owner denial and runtime expiry do not deliver or retain a batch', () => {
  const denied = createTelemetryBatchPipeline({ now: () => 1000, authorize: () => undefined });
  try { assert.equal(denied.start.ok, false); denied.publish([{ timestamp: 1000, residentBytes: 1 }]); denied.runtime.flush(); assert.equal(denied.state().count, 0); }
  finally { denied.runtime.close(); }
  let now = 1000;
  const expired = createTelemetryBatchPipeline({ now: () => now, authorize: () => ({ expiresAt: 1100, maxAgeMs: 1000, maxHz: 10 }) });
  try {
    expired.publish([{ timestamp: 1000, residentBytes: 1 }]); expired.runtime.flush(); assert.equal(expired.state().count, 1);
    now = 1100; expired.runtime.flush(); assert.equal(expired.state().count, 0);
  } finally { expired.runtime.close(); }
});

test('explicit KiBy publication converts before the authorized By route and keeps provenance', () => {
  const pipeline = createTelemetryBatchPipeline({ now: () => 1000 });
  try {
    assert.equal(pipeline.start.ok, true);
    const publish = pipeline as typeof pipeline & { publishResidentKiBy(input: unknown): { ok: boolean } };
    assert.equal(publish.publishResidentKiBy([{ timestamp: 1000, residentKiBy: 64.5, quality: 'observed' }]).ok, true);
    pipeline.runtime.flush();
    assert.equal(pipeline.state().residentBytes, 66048);
    assert.equal(pipeline.state().quality, 'observed');
    const state = pipeline.state() as typeof pipeline.state extends () => infer R ? R & { provenance?: { conversion?: { sourceUnit: string; targetUnit: string; scale: number } } } : never;
    assert.deepEqual(state.provenance?.conversion && {
      sourceUnit: state.provenance.conversion.sourceUnit,
      targetUnit: state.provenance.conversion.targetUnit,
      scale: state.provenance.conversion.scale,
    }, { sourceUnit: 'KiBy', targetUnit: 'By', scale: 1024 });
    for (const value of [
      [{ timestamp: 1000, residentKiBy: 1000000001 }],
      [{ timestamp: 1000, residentKiBy: 1, residentBytes: 1024 }],
      [{ timestamp: 1000, residentKiBy: NaN }],
    ]) {
      assert.throws(() => publish.publishResidentKiBy(value));
      pipeline.runtime.flush();
      assert.equal(pipeline.state().residentBytes, 66048);
    }
    pipeline.connection.stop();
    assert.equal((pipeline.state() as typeof state).provenance, undefined);
  } finally { pipeline.runtime.close(); }
});
