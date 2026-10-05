import { createHandLandmarkProcessor, createPoseLandmarkProcessor, parseAssetReference,
  projectHandLandmarkerResult, projectPoseLandmarkerResult } from '@101/connect';

/** Provenance for the committed inference assets. This landmark-only caller neither loads nor runs them. */
export const visionFixtureModels = Object.freeze({
  pose: parseAssetReference({ id: 'mediapipe:pose-landmarker-lite', kind: 'blob', mediaType: 'application/octet-stream',
    byteLength: 5777746, sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a' }),
  hand: parseAssetReference({ id: 'mediapipe:hand-landmarker', kind: 'blob', mediaType: 'application/octet-stream',
    byteLength: 7819105, sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1' }),
});

/** Synthetic geometric values in the installed MediaPipe result shapes, projected by the actual camera code. */
export function runVisionExample() {
  const imagePose = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: .98 }));
  for (const [i, x, y] of [[11, .4, .34], [12, .6, .34], [15, .35, .56], [16, .65, .56],
    [23, .44, .59], [24, .56, .59]]) imagePose[i!] = { x: x!, y: y!, z: 0, visibility: .98 };
  const rawPose = { landmarks: [imagePose], worldLandmarks: [imagePose.map(p => ({
    x: p.x - .5, y: .59 - p.y, z: 0, visibility: p.visibility }))] };
  const imageHand = Array.from({ length: 21 }, () => ({ x: .5, y: .65, z: 0, visibility: 0 }));
  const set = (i: number, x: number, y: number) => { imageHand[i] = { x, y, z: 0, visibility: 0 }; };
  set(0, .5, .85); set(1, .46, .76); set(2, .42, .69); set(3, .34, .62); set(4, .24, .57);
  for (const [indices, x] of [[[5, 6, 7, 8], .41], [[9, 10, 11, 12], .48],
    [[13, 14, 15, 16], .55], [[17, 18, 19, 20], .62]] as const)
    indices.forEach((i, n) => set(i, x, [.65, .49, .35, .21][n]!));
  const categories = [[{ categoryName: 'Right', score: .98, index: 1, displayName: 'Right' }]];
  const rawHand = { landmarks: [imageHand], worldLandmarks: [imageHand.map(p => ({
    x: p.x - .5, y: .85 - p.y, z: 0, visibility: 0 }))], handedness: categories, handednesses: categories };
  const [projectedPose] = projectPoseLandmarkerResult(rawPose);
  const [projectedHand] = projectHandLandmarkerResult({ landmarks: rawHand.landmarks,
    worldLandmarks: rawHand.worldLandmarks, handedness: rawHand.handedness });
  const stamp = (at: number) => ({ clockId: 'camera:fixture', at });
  const base = (at: number, model: typeof visionFixtureModels.pose) => ({ model,
    subjectId: 'fixture:one', frameId: 'fixture:image', quality: 'valid',
    timing: { capture: stamp(at), receipt: stamp(at + 1), mapping: null, processors: [] } });
  const poseInput = (at: number) => ({ ...base(at, visionFixtureModels.pose), landmarks: projectedPose! });
  const handInput = (at: number) => ({ ...base(at, visionFixtureModels.hand), hand: projectedHand!, frameAspect: 1 });
  const bounds = { version: '1', configurationRevision: 1, maxGapMs: 100, maxWindowMs: 2000, maxFrames: 64 };
  const pose = createPoseLandmarkProcessor({ ...bounds, id: 'example:pose-landmarks',
    classifier: { autoCalibrationFrames: 2, smoothing: .5 } });
  const poseCalibrating = pose.process(poseInput(1000), stamp(1002));
  const poseNeutral = pose.process(poseInput(1016), stamp(1018));
  pose.calibrateNeutral(poseInput(1032));
  const poseMoved = pose.process({ ...poseInput(1048),
    landmarks: projectedPose!.map(point => ({ ...point, x: point.x + .1 })) }, stamp(1050));
  const poseLost = pose.process({ ...poseInput(1064), landmarks: [] }, stamp(1066));
  const poseRestarted = pose.process(poseInput(1080), stamp(1082));
  const hand = createHandLandmarkProcessor({ ...bounds, id: 'example:hand-landmarks',
    classifier: { stableFrames: 2, smoothing: 1, historyMs: 500 } });
  const handSettling = hand.process(handInput(1000), stamp(1002));
  const handStable = hand.process(handInput(1016), stamp(1018));
  const handLost = hand.process({ ...handInput(1032), hand: null }, stamp(1034));
  const handRestarted = hand.process(handInput(1048), stamp(1050));
  pose.reset(); hand.reset();
  return { kind: 'producer-fixtures-only', projectedPose, projectedHand, poseCalibrating, poseNeutral,
    poseMoved, poseLost, poseRestarted, handSettling, handStable, handLost, handRestarted };
}
