import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteClockMap } from './remote-clock.ts';

const clockIds = { localClockId: 'hub:monotonic', remoteClockId: 'phone:monotonic' };

test('four timestamps translate both offset signs without assuming symmetric delay', () => {
  const positive = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0 });
  assert.equal(positive.observe({ localSentAt: 2000, remoteReceivedAt: 1002, remoteSentAt: 1004, localReceivedAt: 2012 }), true);
  assert.deepEqual(positive.translate(1010, 2012), { earliest: 2008, latest: 2018, uncertaintyMs: 5, ...clockIds });
  const negative = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0 });
  assert.equal(negative.observe({ localSentAt: 1000, remoteReceivedAt: 2008, remoteSentAt: 2010, localReceivedAt: 1012 }), true);
  assert.deepEqual(negative.translate(2010, 1012), { earliest: 1002, latest: 1012, uncertaintyMs: 5, ...clockIds });
});

test('compatible exchanges intersect bounds instead of averaging their midpoints', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0 });
  assert.equal(map.observe({ localSentAt: 2000, remoteReceivedAt: 1002, remoteSentAt: 1004, localReceivedAt: 2012 }), true);
  assert.equal(map.observe({ localSentAt: 2020, remoteReceivedAt: 1028, remoteSentAt: 1030, localReceivedAt: 2032 }), true);
  assert.deepEqual(map.translate(1030, 2032), { earliest: 2028, latest: 2032, uncertaintyMs: 2, ...clockIds });
});

test('incompatible exchanges clear synchronization until a later valid exchange', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0 });
  assert.equal(map.observe({ localSentAt: 2000, remoteReceivedAt: 1000, remoteSentAt: 1000, localReceivedAt: 2000 }), true);
  assert.equal(map.observe({ localSentAt: 2020, remoteReceivedAt: 2020, remoteSentAt: 2020, localReceivedAt: 2020 }), false);
  assert.equal(map.translate(1030, 2030), undefined);
  assert.equal(map.observe({ localSentAt: 2040, remoteReceivedAt: 1040, remoteSentAt: 1040, localReceivedAt: 2040 }), true);
  assert.equal(map.translate(1040, 2040)?.earliest, 2040);
});

test('default drift expands the observation and ages the translated interval', () => {
  const map = new RemoteClockMap(clockIds);
  assert.equal(map.observe({ localSentAt: 2000, remoteReceivedAt: 1002, remoteSentAt: 1004, localReceivedAt: 2012 }), true);
  const fresh = map.translate(1004, 2012)!;
  assert.ok(Math.abs(fresh.earliest - 2001.997799779978) < 1e-9);
  assert.ok(Math.abs(fresh.latest - 2012.002200220022) < 1e-9);
  const aged = map.translate(1004, 3012)!;
  assert.ok(Math.abs(aged.earliest - 2001.8988) < 1e-9);
  assert.ok(Math.abs(aged.latest - 2012.1012) < 1e-9);
  assert.ok(aged.uncertaintyMs > fresh.uncertaintyMs);
});

test('historical and future remote timestamps accrue drift from the observation anchor', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 1000, maxUncertaintyMs: 20 });
  assert.equal(map.observe({ localSentAt: 10000, remoteReceivedAt: 9000, remoteSentAt: 9000, localReceivedAt: 10000 }), true);
  const past = map.translate(8001, 10000)!;
  assert.deepEqual(past, { earliest: 9000, latest: 9002, uncertaintyMs: 1, ...clockIds });
  assert.deepEqual(map.translate(9999, 10000), { earliest: 10998, latest: 11000, uncertaintyMs: 1, ...clockIds });
  assert.equal(map.translate(40000, 10000), undefined);
});

test('drift widens old bounds before accepting a later compatible exchange', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 1000 });
  assert.equal(map.observe({ localSentAt: 2000, remoteReceivedAt: 1000, remoteSentAt: 1000, localReceivedAt: 2000 }), true);
  assert.equal(map.observe({ localSentAt: 3000, remoteReceivedAt: 1999, remoteSentAt: 1999, localReceivedAt: 3000 }), true);
  assert.deepEqual(map.translate(1999, 3000), { earliest: 3000, latest: 3000, uncertaintyMs: 0, ...clockIds });
});

test('uncertainty admission is bounded and later observations can narrow a broad map', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0, maxUncertaintyMs: 5 });
  assert.equal(map.observe({ localSentAt: 2000, remoteReceivedAt: 1000, remoteSentAt: 1000, localReceivedAt: 2012 }), true);
  assert.equal(map.translate(1010, 2012), undefined);
  assert.equal(map.observe({ localSentAt: 2020, remoteReceivedAt: 1020, remoteSentAt: 1020, localReceivedAt: 2030 }), true);
  assert.equal(map.translate(1020, 2030)?.uncertaintyMs, 5);
});

test('expiry includes its exact boundary and expired observations do not constrain reacquisition', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0 });
  assert.equal(map.translate(1000, 2000), undefined);
  assert.equal(map.observe({ localSentAt: 2000, remoteReceivedAt: 1000, remoteSentAt: 1000, localReceivedAt: 2000 }), true);
  assert.ok(map.translate(1000, 7000));
  assert.equal(map.translate(1000, 7000.001), undefined);
  assert.equal(map.observe({ localSentAt: 8000, remoteReceivedAt: 8000, remoteSentAt: 8000, localReceivedAt: 8000 }), true);
  assert.equal(map.translate(8000, 8000)?.earliest, 8000);
});

test('default total RTT admission includes 200ms but rejects its first excess', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0, maxUncertaintyMs: 100 });
  assert.equal(map.observe({ localSentAt: 1000, remoteReceivedAt: 0, remoteSentAt: 0, localReceivedAt: 1200 }), true);
  assert.equal(map.translate(0, 1200)?.uncertaintyMs, 100);
  assert.equal(map.observe({ localSentAt: 2000, remoteReceivedAt: 1000, remoteSentAt: 1000, localReceivedAt: 2200.001 }), false);
  assert.equal(map.translate(1000, 2201), undefined);
});

test('impossible, negative, nonfinite and unsafe exchange timestamps fail closed', () => {
  const invalid = [
    { localSentAt: 20, remoteReceivedAt: 10, remoteSentAt: 10, localReceivedAt: 19 },
    { localSentAt: 20, remoteReceivedAt: 10, remoteSentAt: 9, localReceivedAt: 20 },
    { localSentAt: 20, remoteReceivedAt: 10, remoteSentAt: 12, localReceivedAt: 21 },
    ...[-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap((value) => ['localSentAt', 'remoteReceivedAt', 'remoteSentAt', 'localReceivedAt'].map((key) => ({ localSentAt: 20, remoteReceivedAt: 10, remoteSentAt: 10, localReceivedAt: 20, [key]: value }))),
  ];
  for (const exchange of invalid) {
    const map = new RemoteClockMap(clockIds);
    assert.equal(map.observe({ localSentAt: 2, remoteReceivedAt: 1, remoteSentAt: 1, localReceivedAt: 2 }), true);
    assert.equal(map.observe(exchange), false);
    assert.equal(map.translate(10, 20), undefined);
  }
});

test('nonmonotonic exchanges and backwards translation times invalidate synchronization', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0 });
  const exchange = { localSentAt: 2000, remoteReceivedAt: 1000, remoteSentAt: 1000, localReceivedAt: 2000 };
  assert.equal(map.observe(exchange), true);
  assert.ok(map.translate(1010, 2010));
  assert.equal(map.observe({ ...exchange, localSentAt: 2001, localReceivedAt: 2001, remoteReceivedAt: 1001, remoteSentAt: 1001 }), false);
  map.reset();
  assert.equal(map.observe(exchange), true);
  assert.equal(map.observe({ localSentAt: 2001, localReceivedAt: 2001, remoteReceivedAt: 999, remoteSentAt: 999 }), false);
  map.reset();
  assert.equal(map.observe(exchange), true);
  assert.ok(map.translate(1010, 2010));
  assert.equal(map.translate(1010, 2009), undefined);
  assert.equal(map.translate(1010, 2011), undefined);
  assert.equal(map.observe(exchange), false);
});

test('explicit reset permits reacquisition in a new clock era', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0 });
  assert.equal(map.observe({ localSentAt: 2000, remoteReceivedAt: 1000, remoteSentAt: 1000, localReceivedAt: 2000 }), true);
  map.reset();
  assert.equal(map.translate(1000, 2000), undefined);
  assert.equal(map.observe({ localSentAt: 20, remoteReceivedAt: 10, remoteSentAt: 10, localReceivedAt: 20 }), true);
  assert.equal(map.translate(10, 20)?.earliest, 20);
});

test('invalid translation inputs never yield an interval or poison a valid remote mapping', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0 });
  assert.equal(map.observe({ localSentAt: 1000, remoteReceivedAt: 2000, remoteSentAt: 2000, localReceivedAt: 1000 }), true);
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(map.translate(value, 1000), undefined);
  assert.equal(map.translate(999, 1000), undefined);
  assert.equal(map.translate(2000, 1000)?.earliest, 1000);
  for (const value of [-1, NaN, Infinity]) assert.equal(map.translate(2000, value), undefined);
});

test('clock identities remain distinguishable and translation results are immutable', () => {
  const map = new RemoteClockMap({ ...clockIds, maxDriftPpm: 0 });
  assert.equal(map.observe({ localSentAt: 20, remoteReceivedAt: 10, remoteSentAt: 10, localReceivedAt: 20 }), true);
  const result = map.translate(10, 20)!;
  assert.equal(result.localClockId, clockIds.localClockId);
  assert.equal(result.remoteClockId, clockIds.remoteClockId);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => { (result as { earliest: number }).earliest = 0; }, TypeError);
});

test('constructor rejects unbounded identities and invalid options', () => {
  for (const id of ['', ' x', 'x ', 'x\u0000', 'x'.repeat(129)]) {
    assert.throws(() => new RemoteClockMap({ ...clockIds, localClockId: id }), RangeError);
    assert.throws(() => new RemoteClockMap({ ...clockIds, remoteClockId: id }), RangeError);
  }
  assert.throws(() => new RemoteClockMap({ localClockId: 'same', remoteClockId: 'same' }), RangeError);
  for (const option of ['maxRttMs', 'maxUncertaintyMs', 'maxDriftPpm', 'maxAgeMs']) {
    for (const value of [-1, Infinity, NaN, 60001, null, '1']) assert.throws(() => new RemoteClockMap({ ...clockIds, [option]: value }), RangeError);
  }
  assert.throws(() => new RemoteClockMap({ ...clockIds, maxAgeMs: 0 }), RangeError);
  assert.throws(() => new RemoteClockMap({ ...clockIds, maxDriftPpm: 10001 }), RangeError);
  assert.doesNotThrow(() => new RemoteClockMap({ localClockId: 'l'.repeat(128), remoteClockId: 'r'.repeat(128), maxRttMs: 0, maxUncertaintyMs: 0, maxDriftPpm: 0, maxAgeMs: 60000 }));
});
