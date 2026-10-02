import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceValidationError } from './descriptor.ts';
import { compareClockStamps, observationAgeBounds, parseObservationTiming } from './observation-timing.ts';

const local = { capture: { clockId: 'host-clock', at: 100 }, receipt: { clockId: 'host-clock', at: 115 },
  mapping: null, processors: [] } as const;
const remote = { capture: { clockId: 'phone-clock', at: 1100 }, receipt: { clockId: 'host-clock', at: 120 },
  mapping: { earliest: 110, latest: 125, uncertaintyMs: 7.5, maxDriftPpm: 100 }, processors: [] } as const;

test('same-clock capture and receipt produce exact age; different stamps cannot be subtracted', () => {
  assert.deepEqual(parseObservationTiming(local), local);
  assert.deepEqual(observationAgeBounds(local), { earliestMs: 15, latestMs: 15 });
  assert.equal(compareClockStamps(local.capture, local.receipt), -1);
  assert.equal(compareClockStamps(local.receipt, local.receipt), 0);
  assert.throws(() => compareClockStamps(remote.capture, remote.receipt),
    (error: unknown) => error instanceof DeviceValidationError && error.code === 'unsupported-clock-comparison');
  assert.throws(() => parseObservationTiming({ ...local, mapping: remote.mapping }));
  assert.throws(() => parseObservationTiming({ ...local, capture: { ...local.capture, at: 116 } }));
});

test('remote age uses mapped capture interval and causal clipping', () => {
  const parsed = parseObservationTiming(remote);
  assert.equal(Object.isFrozen(parsed.mapping), true);
  assert.deepEqual(observationAgeBounds(parsed), { earliestMs: 0, latestMs: 10 });
  assert.throws(() => parseObservationTiming({ ...remote, mapping: null }));
  assert.throws(() => parseObservationTiming({ ...remote, mapping: { ...remote.mapping, earliest: 121 } }));
  assert.throws(() => parseObservationTiming({ ...remote, mapping: { ...remote.mapping, uncertaintyMs: 1 } }));
  assert.throws(() => parseObservationTiming({ ...remote, mapping: { ...remote.mapping, maxDriftPpm: 10001 } }));
  assert.throws(() => parseObservationTiming({ ...remote, mapping: { ...remote.mapping, latest: 109 } }));
  assert.throws(() => parseObservationTiming({ ...remote,
    mapping: { earliest: 0, latest: 120002, uncertaintyMs: 60001, maxDriftPpm: 100 } }));
});

test('processor lineage is bounded, ordered and stays in the receipt clock', () => {
  const first = { id: 'example:threshold', version: '1.0.0', configurationRevision: 1,
    processed: { clockId: 'host-clock', at: 120 } } as const;
  const second = { id: 'example:relay', version: '2.0.0', configurationRevision: 3,
    processed: { clockId: 'host-clock', at: 125 } } as const;
  const parsed = parseObservationTiming({ ...local, processors: [first, second] });
  assert.equal(Object.isFrozen(parsed.processors[0]), true);
  assert.deepEqual(parsed.processors, [first, second]);
  assert.throws(() => parseObservationTiming({ ...local, processors: [second, first] }));
  assert.throws(() => parseObservationTiming({ ...local, processors: [{ ...first, processed: { clockId: 'phone-clock', at: 120 } }] }));
  assert.throws(() => parseObservationTiming({ ...local, processors: [{ ...first, configurationRevision: 0 }] }));
  assert.throws(() => parseObservationTiming({ ...local, processors: Array.from({ length: 9 }, () => first) }));
});

test('timing records reject extra fields and ordinary accessors without executing them', () => {
  let reads = 0;
  const input = { ...local, get mapping() { reads += 1; return null; } };
  assert.throws(() => parseObservationTiming(input), DeviceValidationError);
  assert.equal(reads, 0);
  assert.throws(() => parseObservationTiming({ ...local, trusted: true }));
  assert.throws(() => parseObservationTiming({ ...local, capture: { clockId: ' host-clock', at: 100 } }));
});
