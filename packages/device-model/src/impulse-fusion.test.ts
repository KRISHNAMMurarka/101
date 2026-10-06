import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

async function api() {
  const path = new URL('./impulse-fusion.ts', import.meta.url);
  assert.ok(existsSync(path), 'The bounded microphone/motion fusion processor is implemented');
  return import(path.href);
}
// PCM capture is window-end time; begin fixtures after the first10ms window exists.
const stamp = (at: number, clockId = 'local') => ({ clockId, at: 100 + at });
const timing = (at: number) => ({ capture: stamp(at), receipt: stamp(at), mapping: null, processors: [] });
const options = () => ({ id: 'processor:impulse', version: '1.0.0', configurationRevision: 1,
  audioSourceId: 'audio:owned', motionSourceId: 'motion:owned', audioEpoch: 'audio-one', motionEpoch: 'motion-one',
  audioCalibrationRevision: 1, motionCalibrationRevision: 1, clockId: 'local',
  audioHigh: 0.5, audioLow: 0.1, motionHigh: 3, motionLow: 0.5,
  coincidenceWindowMs: 30, refractoryMs: 100, maxAgeMs: 100, maxUncertaintyMs: 2, maxGapMs: 200 });
const audio = (at: number, peak: number, extra = {}) => ({ kind: 'audio', sourceId: 'audio:owned', epoch: 'audio-one',
  calibrationRevision: 1, quality: 'valid', peak, rms: peak, sampleRate: 48000, sampleCount: 480,
  timing: timing(at), ...extra });
const motion = (at: number, magnitude: number, extra = {}) => ({ kind: 'motion', sourceId: 'motion:owned', epoch: 'motion-one',
  quality: 'valid', measurement: { orientation: [0, 0, 0, 1], acceleration: [magnitude, 0, 0],
    angularVelocity: [0, 0, 0], units: { acceleration: 'm/s2', angularVelocity: 'rad/s' },
    deviceFrame: 'phone:body', referenceFrame: 'phone:start', accelerationKind: 'linear',
    calibrationRevision: 1, timing: timing(at) }, ...extra });
function arm(p: { process: (input: unknown, at: unknown) => { state: string } }, at = 0) {
  assert.equal(p.process(audio(at, 0), stamp(at)).state, 'none');
  assert.equal(p.process(motion(at, 0), stamp(at)).state, 'none');
}

test('fusion emits only after two fresh rearmed source impulses and preserves both capture clocks', async () => {
  const { createImpulseFusionProcessor } = await api(); const p = createImpulseFusionProcessor(options());
  assert.equal(p.process(audio(0, 1), stamp(0)).state, 'none', 'initial high cannot arm');
  assert.equal(p.process(motion(0, 4), stamp(0)).state, 'none');
  arm(p, 1);
  assert.equal(p.process(audio(10, 0.8), stamp(10)).state, 'none');
  const result = p.process(motion(25, 4), stamp(25));
  assert.equal(result.state, 'candidate'); assert.equal(result.candidate.semantic, 'sensor:coincident-impulse/1');
  assert.equal(result.candidate.sequence, 1);
  assert.equal(result.candidate.audioTiming.capture.at, 110); assert.equal(result.candidate.motionTiming.capture.at, 125);
  assert.equal(result.candidate.processed.at, 125); assert.equal(result.candidate.audioTiming.processors.at(-1).id, 'processor:impulse');
  assert.ok(Object.isFrozen(result.candidate) && Object.isFrozen(result.candidate.audioTiming));
  assert.equal(p.process(audio(30, 0.9), stamp(30)).state, 'none', 'sustained high cannot create another edge');
  assert.equal(p.process(motion(40, 4), stamp(40)).state, 'none');
});

test('audio-only, motion-only and temporally separated impulses do not emit candidates', async () => {
  const { createImpulseFusionProcessor } = await api();
  for (const order of ['audio-first', 'motion-first']) {
    const p = createImpulseFusionProcessor(options()); arm(p);
    const first = order === 'audio-first' ? audio(10, 0.8) : motion(10, 4);
    const second = order === 'audio-first' ? motion(60, 4) : audio(60, 0.8);
    assert.equal(p.process(first, stamp(10)).state, 'none'); assert.equal(p.process(second, stamp(60)).state, 'none');
  }
});

test('refractory impulses are consumed and fresh low baselines are needed after reset or loss', async () => {
  const { createImpulseFusionProcessor } = await api(); const p = createImpulseFusionProcessor(options()); arm(p);
  p.process(audio(10, 0.8), stamp(10)); assert.equal(p.process(motion(20, 4), stamp(20)).state, 'candidate');
  arm(p, 25); p.process(audio(30, 0.8), stamp(30)); assert.equal(p.process(motion(40, 4), stamp(40)).state, 'none');
  assert.equal(p.process(motion(125, 4), stamp(125)).state, 'none', 'old high cannot replay after refractory');
  arm(p, 130); p.process(motion(140, 4), stamp(140)); assert.equal(p.process(audio(150, 0.8), stamp(150)).state, 'candidate');
  p.reset(); p.process(audio(151, 0.8), stamp(151)); assert.equal(p.process(motion(152, 4), stamp(152)).state, 'none');
  arm(p, 160); p.process(audio(170, 0.8), stamp(170));
  assert.equal(p.process(motion(175, 4, { quality: 'unavailable' }), stamp(175)).state, 'unavailable');
  assert.equal(p.process(motion(180, 4), stamp(180)).state, 'none');
});

test('old epochs, wrong sources and changed calibration cannot join a retained impulse', async () => {
  const { createImpulseFusionProcessor } = await api();
  for (const replacement of [{ epoch: 'motion-two' }, { sourceId: 'motion:foreign' },
    { measurement: { ...motion(20, 4).measurement, calibrationRevision: 2 } }]) {
    const p = createImpulseFusionProcessor(options()); arm(p); p.process(audio(10, 0.8), stamp(10));
    assert.equal(p.process(motion(20, 4, replacement), stamp(20)).state, 'unavailable');
    assert.equal(p.process(motion(21, 4), stamp(21)).state, 'none');
  }
});

test('gravity-bearing, wrong-unit and stale physical values cannot produce tap candidates', async () => {
  const { createImpulseFusionProcessor } = await api();
  for (const change of [{ accelerationKind: 'including-gravity' }, { units: { acceleration: 'g', angularVelocity: 'rad/s' } }]) {
    const p = createImpulseFusionProcessor(options()); arm(p); p.process(audio(10, 0.8), stamp(10));
    assert.equal(p.process(motion(20, 4, { measurement: { ...motion(20, 4).measurement, ...change } }), stamp(20)).state, 'unavailable');
  }
  const p = createImpulseFusionProcessor(options()); arm(p);
  assert.equal(p.process(audio(10, 0.8), stamp(111)).state, 'unavailable');
  assert.equal(p.process(motion(112, 4), stamp(112)).state, 'none');
});

test('mapped capture uncertainty uses conservative window edges and never equates unrelated clocks', async () => {
  const { createImpulseFusionProcessor } = await api();
  const p = createImpulseFusionProcessor(options());
  p.process(audio(0, 0), stamp(0));
  const baseline = { capture: stamp(0, 'watch'), receipt: stamp(0),
    mapping: { earliest: 100, latest: 100, uncertaintyMs: 0, maxDriftPpm: 10 }, processors: [] };
  p.process(motion(0, 0, { measurement: { ...motion(0, 0).measurement, timing: baseline } }), stamp(0));
  p.process(audio(10, 0.8), stamp(10));
  const mapped = { capture: stamp(300, 'watch'), receipt: stamp(30),
    mapping: { earliest: 127, latest: 131, uncertaintyMs: 2, maxDriftPpm: 10 }, processors: [] };
  assert.equal(p.process(motion(30, 4, { measurement: { ...motion(30, 4).measurement, timing: mapped } }), stamp(31)).state, 'none', 'worst case span31 exceeds30');
  const q = createImpulseFusionProcessor(options()); arm(q); q.process(audio(10, 0.8), stamp(10));
  assert.equal(q.process(motion(20, 4), stamp(20, 'unrelated')).state, 'unavailable');
  const r = createImpulseFusionProcessor(options());
  r.process(audio(0, 0), stamp(0));
  r.process(motion(0, 0, { measurement: { ...motion(0, 0).measurement, timing: baseline } }), stamp(0));
  r.process(audio(10, 0.8), stamp(10));
  const uncertain = { ...mapped, mapping: { earliest: 124, latest: 132, uncertaintyMs: 4, maxDriftPpm: 10 } };
  assert.equal(r.process(motion(30, 4, { measurement: { ...motion(30, 4).measurement, timing: uncertain } }), stamp(32)).state, 'unavailable');
});

test('malformed and out-of-order inputs reset pending evidence before throwing', async () => {
  const { createImpulseFusionProcessor } = await api();
  for (const invalid of [audio(15, NaN), audio(15, 0.8, { secret: 'extra' }), audio(10, 0.8),
    audio(15, 0.8, { rms: 0.9 }), audio(15, 0.8, { sampleCount: 2000 })]) {
    const p = createImpulseFusionProcessor(options()); arm(p); p.process(audio(10, 0.8), stamp(10));
    assert.throws(() => p.process(invalid, stamp(15)));
    assert.equal(p.process(motion(20, 4), stamp(20)).state, 'none');
  }
});

test('conservatively mapped candidates preserve the remote clock and gaps erase rearming state', async () => {
  const { createImpulseFusionProcessor } = await api(); const p = createImpulseFusionProcessor(options());
  const baseline = { capture: stamp(0, 'native-motion'), receipt: stamp(0),
    mapping: { earliest: 100, latest: 100, uncertaintyMs: 0, maxDriftPpm: 10 }, processors: [] };
  p.process(audio(0, 0), stamp(0));
  p.process(motion(0, 0, { measurement: { ...motion(0, 0).measurement, timing: baseline } }), stamp(0));
  p.process(audio(10, 0.8), stamp(10));
  const mapped = { capture: stamp(500, 'native-motion'), receipt: stamp(22),
    mapping: { earliest: 120, latest: 124, uncertaintyMs: 2, maxDriftPpm: 10 }, processors: [] };
  const result = p.process(motion(22, 4, { measurement: { ...motion(22, 4).measurement, timing: mapped } }), stamp(24));
  assert.equal(result.state, 'candidate'); assert.equal(result.candidate.motionTiming.capture.clockId, 'native-motion');
  assert.equal(result.candidate.motionTiming.capture.at, 600); assert.equal(result.candidate.motionTiming.receipt.clockId, 'local');
  assert.deepEqual(result.candidate.motionTiming.mapping, mapped.mapping);
  const q = createImpulseFusionProcessor(options()); arm(q);
  assert.equal(q.process(audio(250, 0.8), stamp(250)).state, 'none');
  assert.equal(q.process(motion(260, 4), stamp(260)).state, 'none', 'gap disarmed both sources');
});

test('malformed input and reset retain same-generation replay floors and refractory admission', async () => {
  const { createImpulseFusionProcessor } = await api(); const p = createImpulseFusionProcessor(options()); arm(p);
  p.process(audio(10, 0.8), stamp(10)); assert.equal(p.process(motion(20, 4), stamp(20)).state, 'candidate');
  assert.throws(() => p.process(audio(30, 0.8, { extra: 'invalid' }), stamp(30)));
  assert.throws(() => p.process(audio(0, 0), stamp(31)), 'previously consumed low capture cannot replay after malformed data');
  assert.throws(() => p.process(motion(0, 0), stamp(32)), 'motion capture floor also remains');
  assert.throws(() => p.process(audio(33, 0), stamp(25)), 'processing clock floor remains');
  p.reset(); arm(p, 35); p.process(audio(40, 0.8), stamp(40));
  assert.equal(p.process(motion(50, 4), stamp(50)).state, 'none', 'fresh edges still respect prior refractory after reset');
  arm(p, 120); p.process(audio(130, 0.8), stamp(130));
  assert.equal(p.process(motion(140, 4), stamp(140)).state, 'candidate', 'fresh evidence recovers after refractory');
});

test('PCM energy extraction is bounded, immutable, local and never retains or exports samples', async () => {
  const { measurePcmImpulse } = await api(); const samples = [0.5, -0.5, 0.5, -0.5];
  const result = measurePcmImpulse({ samples, sampleRate: 8000, sourceId: 'audio:owned', epoch: 'audio-one', calibrationRevision: 1, timing: timing(10) });
  assert.equal(result.peak, 0.5); assert.equal(result.rms, 0.5); assert.equal(result.sampleCount, 4); assert.equal(result.kind, 'audio');
  samples[0] = 1; assert.equal(result.peak, 0.5); assert.equal(Object.hasOwn(result, 'samples'), false); assert.ok(Object.isFrozen(result));
  const native = new Float32Array([0.5, -0.5]);
  assert.equal(measurePcmImpulse({ samples: native, sampleRate: 48000, sourceId: 'audio:owned', epoch: 'audio-one', calibrationRevision: 1, timing: timing(10) }).rms, 0.5);
  assert.throws(() => measurePcmImpulse({ samples: new Float32Array(new SharedArrayBuffer(8)), sampleRate: 48000,
    sourceId: 'audio:owned', epoch: 'audio-one', calibrationRevision: 1, timing: timing(10) }));
  for (const samples of [[], [NaN], [1.01], Array(1025).fill(0), Array(401).fill(0)]) {
    assert.throws(() => measurePcmImpulse({ samples, sampleRate: 8000, sourceId: 'audio:owned', epoch: 'audio-one', calibrationRevision: 1, timing: timing(10) }));
  }
});

test('constructor validates thresholds and snapshots fixed source policy without creating timers or devices', async () => {
  const { createImpulseFusionProcessor } = await api();
  for (const change of [{ audioLow: 0.5 }, { motionLow: 3 }, { audioHigh: NaN }, { maxUncertaintyMs: 100 },
    { coincidenceWindowMs: 101 }, { maxGapMs: 10 }, { audioSourceId: 'motion:owned' }, { audioCalibrationRevision: 0 }])
    assert.throws(() => createImpulseFusionProcessor({ ...options(), ...change }));
  const config = options(), p = createImpulseFusionProcessor(config); config.audioHigh = 1;
  arm(p); p.process(audio(10, 0.8), stamp(10)); assert.equal(p.process(motion(20, 4), stamp(20)).state, 'candidate');
});
