import assert from 'node:assert/strict';
import test from 'node:test';
import { createPipelineTimingCollector } from './index.ts';

function trace(index = 0) {
  return {
    source: { clockId: 'source', capturedAt: 1000 + index, encodingStartedAt: 1002 + index, encodedAt: 1003 + index },
    target: { clockId: 'target', receivedAt: 110 + index, decodedAt: 111 + index, appliedAt: 113 + index, renderedAt: 117 + index },
    mapping: { earliest: 99 + index, latest: 101 + index, uncertaintyMs: 1, maxDriftPpm: 0 },
  };
}

test('actual capture mapping yields conservative full-pipeline stage distributions', () => {
  const collector = createPipelineTimingCollector({ capacity: 2 });
  const input = trace();
  assert.equal(collector.record(input), true);
  input.mapping.earliest = 0;
  const result = collector.snapshot();
  assert.equal(result.profile, 'capture-output-timing/1');
  assert.equal(result.samples, 1);
  assert.deepEqual(result.stages.processing.p50, { minMs: 2, maxMs: 2 });
  assert.deepEqual(result.stages.encoding.p95, { minMs: 1, maxMs: 1 });
  assert.deepEqual(result.stages.transit.p99, { minMs: 6, maxMs: 8 });
  assert.deepEqual(result.stages.decoding.p50, { minMs: 1, maxMs: 1 });
  assert.deepEqual(result.stages.sink.p50, { minMs: 2, maxMs: 2 });
  assert.deepEqual(result.stages.render.p50, { minMs: 4, maxMs: 4 });
  assert.deepEqual(result.stages.captureToOutput.p50, { minMs: 16, maxMs: 18 });
  assert.equal(result.maxClockUncertaintyMs, 1);
  assert.ok(Object.isFrozen(result.stages.transit.p99));
});

test('bounded latest window uses nearest rank and retains explicit invalid/closed state', () => {
  const collector = createPipelineTimingCollector({ capacity: 2 });
  assert.equal(collector.snapshot().stages.render.p50, null);
  for (const render of [4, 8, 12]) {
    const input = trace(); input.target.renderedAt = input.target.appliedAt + render;
    assert.equal(collector.record(input), true);
  }
  const result = collector.snapshot();
  assert.equal(result.samples, 2); assert.equal(result.accepted, 3); assert.equal(result.evicted, 1);
  assert.deepEqual(result.stages.render.p50, { minMs: 8, maxMs: 8 });
  assert.deepEqual(result.stages.render.p95, { minMs: 12, maxMs: 12 });
  assert.equal(collector.record({ ...trace(), authority: 'invented' }), false);
  assert.equal(collector.record({ ...trace(), mapping: null }), false);
  assert.equal(collector.record({ ...trace(), target: { ...trace().target, decodedAt: 109 } }), false);
  assert.equal(collector.record({ ...trace(), source: { ...trace().source, encodedAt: NaN } }), false);
  assert.equal(collector.record({ get source() { throw new Error('Do not execute input'); } }), false);
  assert.equal(collector.snapshot().rejected, 5);
  collector.clear(); assert.equal(collector.snapshot().samples, 0); assert.equal(collector.snapshot().accepted, 0);
  collector.close(); assert.equal(collector.record(trace()), false); assert.equal(collector.snapshot().closed, true);
  assert.equal(collector.snapshot().samples, 0);
  assert.throws(() => createPipelineTimingCollector({ capacity: 2049 }), /capacity/);
});

test('clock drift widens transit while negative lower bounds clamp without claiming physical acquisition', () => {
  const collector = createPipelineTimingCollector();
  const input = trace(); input.mapping.maxDriftPpm = 10000;
  assert.equal(collector.record(input), true);
  const first = collector.snapshot().stages.transit.p50!;
  assert.ok(Math.abs(first.minMs - (110 - 101 - 3 / 0.99)) < 1e-12 && Math.abs(first.maxMs - (110 - 99 - 3 / 1.01)) < 1e-12);
  input.target.receivedAt = 103; input.target.decodedAt = 104;
  input.target.appliedAt = 105; input.target.renderedAt = 106;
  assert.equal(collector.record(input), true);
  const second = collector.snapshot().stages.transit.p50!;
  assert.equal(second.minMs, 0); assert.ok(Math.abs(second.maxMs - (103 - 99 - 3 / 1.01)) < 1e-12);
  const local = { ...trace(), source: { clockId: 'target', capturedAt: 100, encodingStartedAt: 102, encodedAt: 103 }, mapping: null };
  assert.equal(collector.record(local), true);
  assert.equal(collector.record({ ...local, mapping: trace().mapping }), false);
});

test('a lawful slow source clock remains inside target-relative duration and transit bounds', () => {
  const collector = createPipelineTimingCollector();
  const input = { source: { clockId: 'source', capturedAt: 1000, encodingStartedAt: 1500, encodedAt: 2000 },
    target: { clockId: 'target', receivedAt: 1200, decodedAt: 1201, appliedAt: 1203, renderedAt: 1207 },
    mapping: { earliest: 100, latest: 100, uncertaintyMs: 0, maxDriftPpm: 10000 } };
  assert.equal(collector.record(input), true);
  const result = collector.snapshot(), transit = result.stages.transit.p50!;
  const actualTransit = 1200 - (100 + 1000 / 0.99);
  assert.ok(transit.minMs <= actualTransit && actualTransit <= transit.maxMs);
  const processing = result.stages.processing.p50!;
  assert.ok(processing.minMs <= 500 / 0.99 && 500 / 0.99 <= processing.maxMs);
});
