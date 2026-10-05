import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoseLandmarkProcessor, createHandLandmarkProcessor, parsePoseObservation, parseHandObservation,
  projectPoseLandmarkerResult, projectHandLandmarkerResult } from './index.ts';

const identity = { id: 'test:vision', version: '1', configurationRevision: 1 };
const model = { id: 'test:pose-model', kind: 'blob', mediaType: 'application/octet-stream', byteLength: 100, sha256: 'a'.repeat(64) };
const stamp = (at: number) => ({ clockId: 'camera', at });
function body() {
  const points = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: .98,
    world: { x: 0, y: 0, z: 0 } }));
  for (const [i, x, y] of [[11, .4, .34], [12, .6, .34], [15, .35, .56], [16, .65, .56],
    [23, .44, .59], [24, .56, .59]]) points[i!] = { x: x!, y: y!, z: 0, visibility: .98,
      world: { x: x! - .5, y: .59 - y!, z: 0 } };
  return points;
}
function palm() {
  const landmarks = Array.from({ length: 21 }, () => ({ x: .5, y: .65, z: 0, world: { x: 0, y: 0, z: 0 } }));
  const set = (i: number, x: number, y: number) => { landmarks[i] = { x, y, z: 0, world: { x: x - .5, y: .85 - y, z: 0 } }; };
  set(0, .5, .85); set(1, .46, .76); set(2, .42, .69); set(3, .34, .62); set(4, .24, .57);
  for (const [indices, x] of [[[5, 6, 7, 8], .41], [[9, 10, 11, 12], .48],
    [[13, 14, 15, 16], .55], [[17, 18, 19, 20], .62]] as const)
    indices.forEach((i, n) => set(i, x, [.65, .49, .35, .21][n]!));
  return { landmarks, handedness: 'right', confidence: .98 };
}
function base(at: number) { return { subjectId: 'person:one', frameId: 'camera:image', model, quality: 'valid',
  timing: { capture: stamp(at), receipt: stamp(at), mapping: null, processors: [] } }; }
const pose = (at: number) => ({ ...base(at), landmarks: body() });
const hand = (at: number) => ({ ...base(at), hand: palm(), frameAspect: 1 });
const bounded = { ...identity, maxGapMs: 100, maxWindowMs: 1000, maxFrames: 32 };

test('vision observations copy actual adapter fields without inventing metric coordinates or point visibility', () => {
  const input = pose(0), result = parsePoseObservation(input);
  input.landmarks[11]!.world.x = 99;
  assert.equal(result.landmarks[11]!.world!.x, -.09999999999999998);
  assert.ok(Object.isFrozen(result.landmarks[11]!.world));
  const rawHand = hand(0), parsedHand = parseHandObservation(rawHand);
  assert.equal(parsedHand.hand!.landmarks[0]!.visibility, undefined);
  assert.equal(parsedHand.hand!.confidence, .98, 'handedness category score remains distinct');
  assert.equal(parseHandObservation({ ...rawHand, hand: null }).hand, null);
  assert.equal(parsePoseObservation({ ...pose(0), landmarks: [] }).landmarks.length, 0);
});

test('vision parser rejects malformed counts, nonfinite coordinates, confidence, getters and unknown authority', () => {
  for (const bad of [ { ...pose(0), landmarks: body().slice(1) },
    { ...pose(0), landmarks: body().map((p, i) => i ? p : { ...p, x: NaN }) },
    { ...pose(0), landmarks: body().map((p, i) => i ? p : { ...p, visibility: 2 }) },
    { ...pose(0), permission: true } ]) assert.throws(() => parsePoseObservation(bad));
  for (const bad of [ { ...hand(0), frameAspect: 0 },
    { ...hand(0), hand: { ...palm(), landmarks: palm().landmarks.slice(1) } },
    { ...hand(0), hand: { ...palm(), confidence: -1 } } ]) assert.throws(() => parseHandObservation(bad));
  let reads = 0;
  const getter = Object.defineProperty(pose(0), 'subjectId', { enumerable: true, get() { reads++; return 'evil'; } });
  assert.throws(() => parsePoseObservation(getter)); assert.equal(reads, 0);
});

test('pose calibration, low quality and disappearance preserve landmarks and immediately release state', () => {
  const processor = createPoseLandmarkProcessor({ ...bounded, classifier: { autoCalibrationFrames: 2, smoothing: 1 } });
  assert.equal(processor.process(pose(0), stamp(1)).status, 'calibrating');
  const calibrated = processor.process(pose(10), stamp(11));
  assert.equal(calibrated.status, 'valid'); assert.equal(calibrated.signals.calibrated, true);
  assert.equal(calibrated.signals.landmarks[11]!.world!.x, -.09999999999999998);
  const lost = processor.process({ ...pose(20), landmarks: [] }, stamp(21));
  assert.equal(lost.status, 'unavailable'); assert.equal(lost.signals.calibrated, false);
  assert.ok(Object.values(lost.signals.actions).every(v => !v));
  assert.equal(processor.process(pose(30), stamp(31)).status, 'calibrating');
  const poor = processor.process({ ...pose(40), landmarks: body().map(p => ({ ...p, visibility: .1 })) }, stamp(41));
  assert.equal(poor.status, 'unavailable');
  assert.equal(processor.process(pose(50), stamp(51)).status, 'calibrating');
  assert.equal(processor.process({ ...pose(60), quality: 'stale' }, stamp(61)).status, 'unavailable');
});

test('explicit neutral calibration is scoped and malformed input resets before recovery', () => {
  const processor = createPoseLandmarkProcessor({ ...bounded, classifier: { autoCalibrationFrames: 2, smoothing: 1 } });
  assert.equal(processor.calibrateNeutral(pose(0)), true);
  const shifted = { ...pose(10), landmarks: body().map(p => ({ ...p, x: p.x + .1 })) };
  assert.ok(processor.process(shifted, stamp(11)).signals.axes.bodyX > .5);
  assert.throws(() => processor.process({ ...pose(20), landmarks: [] as unknown, extra: true }, stamp(21)));
  assert.equal(processor.process(pose(30), stamp(31)).status, 'calibrating');
  assert.equal(processor.calibrateNeutral({ ...pose(40), quality: 'unavailable' }), false);
});

test('pose intake retains the existing classifier mean core visibility policy', () => {
  const processor = createPoseLandmarkProcessor({ ...bounded, classifier: { autoCalibrationFrames: 1, smoothing: 1 } });
  const input = { ...pose(0), landmarks: body().map((point, index) => index === 23 ? { ...point, visibility: .2 } : point) };
  assert.equal(processor.process(input, stamp(1)).status, 'valid');
});

test('hand stabilization, null loss and unknown label confidence do not preserve held gestures', () => {
  const processor = createHandLandmarkProcessor({ ...bounded, classifier: { stableFrames: 2, smoothing: 1, historyMs: 500 } });
  assert.equal(processor.process(hand(0), stamp(1)).signals.gestures.openPalm, false);
  const next = processor.process(hand(10), stamp(11));
  assert.equal(next.signals.gestures.openPalm, true); assert.equal(next.signals.hand!.landmarks[0]!.world!.y, 0);
  assert.equal(next.timing.capture.at, 0, 'derived gestures retain contributing history age');
  const loss = processor.process({ ...hand(20), hand: null }, stamp(21));
  assert.equal(loss.status, 'unavailable'); assert.ok(Object.values(loss.signals.gestures).every(v => !v));
  assert.equal(processor.process(hand(30), stamp(31)).signals.gestures.openPalm, false);
  const unknown = processor.process({ ...hand(40), hand: { ...palm(), confidence: 0, handedness: 'unknown' } }, stamp(41));
  assert.equal(unknown.status, 'unavailable');
  assert.ok(Object.values(unknown.signals.gestures).every(v => !v));
  assert.ok(Object.isFrozen(next.signals.gestures));
});

test('shared MediaPipe projection preserves metric association and rejects malformed consumed fields', () => {
  const image = body().map(({ x, y, z, visibility }) => ({ x, y, z, visibility }));
  const world = body().map(({ world, visibility }) => ({ ...world, visibility }));
  const projected = projectPoseLandmarkerResult({ landmarks: [image], worldLandmarks: [world] });
  assert.deepEqual(projected[0]![11]!.world, body()[11]!.world);
  assert.equal(projected[0]![11]!.visibility, .98);
  assert.deepEqual(projectPoseLandmarkerResult({ landmarks: [], worldLandmarks: [] }), []);
  const handImage = palm().landmarks.map(({ x, y, z }) => ({ x, y, z }));
  const unknown = projectHandLandmarkerResult({ landmarks: [handImage], worldLandmarks: [], handedness: [] });
  assert.equal(unknown[0]!.confidence, 0); assert.equal(unknown[0]!.landmarks[0]!.world, undefined);
  assert.equal(unknown[0]!.landmarks[0]!.visibility, 0);
  for (const raw of [ { landmarks: [image.slice(1)], worldLandmarks: [] },
    { landmarks: [image], worldLandmarks: [world.slice(1)] },
    { landmarks: [image], worldLandmarks: [], permission: true },
    { landmarks: [image, image], worldLandmarks: [world] } ]) assert.throws(() => projectPoseLandmarkerResult(raw));
  assert.throws(() => projectHandLandmarkerResult({ landmarks: [handImage], worldLandmarks: [],
    handedness: [[{ score: 2, categoryName: 'Right' }]] }));
});

test('subject, frame, model, clock, aspect and bounded history changes reset gesture state', () => {
  for (const patch of [ { subjectId: 'person:two' }, { frameId: 'camera:other' },
    { model: { ...model, sha256: 'b'.repeat(64) } }, { frameAspect: 2 },
    { timing: { capture: { clockId: 'other', at: 20 }, receipt: { clockId: 'other', at: 20 }, mapping: null, processors: [] } } ]) {
    const processor = createHandLandmarkProcessor({ ...bounded, classifier: { stableFrames: 2, smoothing: 1, historyMs: 500 } });
    processor.process(hand(0), stamp(1)); processor.process(hand(10), stamp(11));
    const input = { ...hand(20), ...patch };
    assert.equal(processor.process(input, { ...input.timing.receipt, at: 21 }).signals.gestures.openPalm, false);
  }
  const processor = createHandLandmarkProcessor({ ...bounded, maxFrames: 2, classifier: { stableFrames: 2, historyMs: 500 } });
  processor.process(hand(0), stamp(1)); processor.process(hand(10), stamp(11));
  assert.equal(processor.process(hand(20), stamp(21)).signals.gestures.openPalm, false);
  assert.equal(processor.process(hand(121), stamp(122)).timing.capture.at, 121);
});

test('duplicate, remote and invalid processing timing fail closed and reset', () => {
  const processor = createHandLandmarkProcessor({ ...bounded, classifier: { stableFrames: 2, historyMs: 500 } });
  for (const bad of [ hand(0), { ...hand(10), timing: { capture: { clockId: 'remote', at: 10 }, receipt: stamp(10),
    mapping: { earliest: 9, latest: 10, uncertaintyMs: 1, maxDriftPpm: 0 }, processors: [] } } ]) {
    processor.reset(); processor.process(hand(0), stamp(1));
    assert.throws(() => processor.process(bad, stamp(11)));
    assert.equal(processor.process(hand(20), stamp(21)).signals.gestures.openPalm, false);
  }
  assert.throws(() => processor.process(hand(30), stamp(19)));
  assert.equal(processor.process(hand(40), stamp(41)).signals.gestures.openPalm, false);
  assert.throws(() => createPoseLandmarkProcessor({ ...bounded, classifier: { autoCalibrationFrames: Infinity } }));
  assert.throws(() => createHandLandmarkProcessor({ ...bounded, classifier: { historyMs: 2000 } }));
});
