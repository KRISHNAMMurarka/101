export interface PoseLandmark {
  /** Normalized to the frame: 0-1 across the image, with z relative to the hips. */
  x: number;
  y: number;
  z: number;
  /** 0-1. Below a threshold the point is a guess, and callers must treat it as unknown. */
  visibility: number;
  presence?: number;
  /**
   * The same joint in metres, relative to the midpoint of the hips.
   *
   * The model produces this on every frame and the adapter used to discard it, so everything
   * downstream reasoned in image space: a player turning side-on read as a player getting narrower,
   * and depth could not be told from distance. Anything asking a real geometric question — is an arm
   * extended, is a knee bent, is someone facing away — needs this rather than the normalized point.
   */
  world?: { x: number; y: number; z: number };
}

export type BodyAction = "standing" | "duck" | "jump" | "leanLeft" | "leanRight" | "stepLeft" | "stepRight" | "armsRaised" | "punch";
export type CombatPoseAction = "punchLeft" | "punchRight" | "block" | "special";

export interface PoseCalibration {
  bodyX: number;
  shoulderX: number;
  shoulderY: number;
  hipX: number;
  hipY: number;
  shoulderWidth: number;
  torsoHeight: number;
}

export interface PoseSignals {
  timestamp: number;
  calibrated: boolean;
  confidence: number;
  actions: Record<BodyAction, boolean>;
  combat: Record<CombatPoseAction, boolean>;
  axes: {
    bodyX: number;
    lean: number;
    crouch: number;
    lift: number;
  };
  landmarks: PoseLandmark[];
}

export interface PoseClassifierOptions {
  autoCalibrationFrames?: number;
  smoothing?: number;
  visibilityThreshold?: number;
  gestureCooldownMs?: number;
}

export const POSE_LANDMARK = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const;

export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 11], [0, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [28, 30], [30, 32],
];

const EMPTY_ACTIONS: Record<BodyAction, boolean> = {
  standing: false,
  duck: false,
  jump: false,
  leanLeft: false,
  leanRight: false,
  stepLeft: false,
  stepRight: false,
  armsRaised: false,
  punch: false,
};

const EMPTY_COMBAT_ACTIONS: Record<CombatPoseAction, boolean> = {
  punchLeft: false,
  punchRight: false,
  block: false,
  special: false,
};

export class PoseClassifier {
  private readonly options: Required<PoseClassifierOptions>;
  private calibration?: PoseCalibration;
  private samples: PoseCalibration[] = [];
  private previousPose?: PoseLandmark[];
  private previousTimestamp?: number;
  private lastPunchAt: Record<"left" | "right", number> = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
  private lastSpecialAt = Number.NEGATIVE_INFINITY;
  private previousArmsRaised = false;
  private states = { duck: false, jump: false, leanLeft: false, leanRight: false, stepLeft: false, stepRight: false };

  constructor(options: PoseClassifierOptions = {}) {
    this.options = {
      autoCalibrationFrames: options.autoCalibrationFrames ?? 12,
      smoothing: options.smoothing ?? 0.38,
      visibilityThreshold: options.visibilityThreshold ?? 0.45,
      gestureCooldownMs: options.gestureCooldownMs ?? 340,
    };
  }

  get isCalibrated() {
    return Boolean(this.calibration);
  }

  get neutral() {
    return this.calibration ? { ...this.calibration } : undefined;
  }

  calibrateNeutral(pose: readonly PoseLandmark[]) {
    const calibration = measurePose(pose);
    if (!calibration) return false;
    this.calibration = calibration;
    this.samples = [];
    this.previousPose = pose.map((landmark) => ({ ...landmark }));
    this.previousTimestamp = undefined;
    this.previousArmsRaised = false;
    this.states = { duck: false, jump: false, leanLeft: false, leanRight: false, stepLeft: false, stepRight: false };
    return true;
  }

  process(pose: readonly PoseLandmark[], timestamp: number): PoseSignals {
    const landmarks = smoothPose(pose, this.previousPose, clamp01(this.options.smoothing));
    const metrics = measurePose(landmarks);
    const confidence = poseConfidence(landmarks);
    if (!metrics || confidence < this.options.visibilityThreshold) {
      return this.empty(timestamp, landmarks, confidence);
    }

    if (!this.calibration) {
      this.samples.push(metrics);
      if (this.samples.length >= Math.max(1, this.options.autoCalibrationFrames)) {
        this.calibration = averageCalibration(this.samples);
        this.samples = [];
      }
    }
    const neutral = this.calibration;
    if (!neutral) {
      this.previousPose = landmarks;
      this.previousTimestamp = timestamp;
      return this.empty(timestamp, landmarks, confidence);
    }

    const scale = Math.max(0.08, neutral.shoulderWidth);
    const torso = Math.max(0.12, neutral.torsoHeight);
    const bodyOffset = (metrics.bodyX - neutral.bodyX) / scale;
    const lean = clamp((metrics.shoulderX - metrics.hipX) / scale * 2.2);
    const bodyX = clamp(bodyOffset * 1.35 + lean * 0.55);
    const crouch = clamp01((metrics.shoulderY - neutral.shoulderY) / torso);
    const lift = clamp01((neutral.hipY - metrics.hipY) / torso);

    this.states.duck = hysteresisHigh(this.states.duck, crouch, 0.24, 0.14);
    this.states.jump = hysteresisHigh(this.states.jump, lift, 0.2, 0.1);
    this.states.leanLeft = hysteresisLow(this.states.leanLeft, lean, -0.32, -0.18);
    this.states.leanRight = hysteresisHigh(this.states.leanRight, lean, 0.32, 0.18);
    this.states.stepLeft = hysteresisLow(this.states.stepLeft, bodyX, -0.42, -0.25);
    this.states.stepRight = hysteresisHigh(this.states.stepRight, bodyX, 0.42, 0.25);

    const shoulders = [landmarks[POSE_LANDMARK.leftShoulder]!, landmarks[POSE_LANDMARK.rightShoulder]!];
    const wrists = [landmarks[POSE_LANDMARK.leftWrist]!, landmarks[POSE_LANDMARK.rightWrist]!];
    const armsRaised = wrists.every((wrist, index) => wrist.visibility >= this.options.visibilityThreshold && wrist.y < shoulders[index]!.y - torso * 0.12);
    const punches = this.detectPunch(landmarks, timestamp, scale);
    const block = wrists.every((wrist) => wrist.visibility >= this.options.visibilityThreshold && wrist.y < metrics.shoulderY + torso * .22)
      && Math.abs(wrists[0]!.x - wrists[1]!.x) < scale * 1.35;
    const special = armsRaised && !this.previousArmsRaised && timestamp - this.lastSpecialAt >= this.options.gestureCooldownMs * 1.8;
    if (special) this.lastSpecialAt = timestamp;
    this.previousArmsRaised = armsRaised;
    const punch = punches.left || punches.right;
    const actions: Record<BodyAction, boolean> = {
      standing: !this.states.duck && !this.states.jump,
      duck: this.states.duck,
      jump: this.states.jump,
      leanLeft: this.states.leanLeft,
      leanRight: this.states.leanRight,
      stepLeft: this.states.stepLeft,
      stepRight: this.states.stepRight,
      armsRaised,
      punch,
    };
    this.previousPose = landmarks;
    this.previousTimestamp = timestamp;
    return { timestamp, calibrated: true, confidence, actions, combat: { punchLeft: punches.left, punchRight: punches.right, block, special }, axes: { bodyX, lean, crouch, lift }, landmarks };
  }

  reset() {
    this.calibration = undefined;
    this.samples = [];
    this.previousPose = undefined;
    this.previousTimestamp = undefined;
    this.lastPunchAt = { left: Number.NEGATIVE_INFINITY, right: Number.NEGATIVE_INFINITY };
    this.lastSpecialAt = Number.NEGATIVE_INFINITY;
    this.previousArmsRaised = false;
    this.states = { duck: false, jump: false, leanLeft: false, leanRight: false, stepLeft: false, stepRight: false };
  }

  private detectPunch(pose: readonly PoseLandmark[], timestamp: number, scale: number) {
    const result = { left: false, right: false };
    if (!this.previousPose || this.previousTimestamp === undefined) return result;
    const deltaSeconds = Math.max(1 / 120, (timestamp - this.previousTimestamp) / 1000);
    const candidates = [POSE_LANDMARK.leftWrist, POSE_LANDMARK.rightWrist] as const;
    const shoulders = [POSE_LANDMARK.leftShoulder, POSE_LANDMARK.rightShoulder] as const;
    candidates.forEach((index, side) => {
      const wrist = pose[index]!;
      const previous = this.previousPose?.[index];
      const shoulder = pose[shoulders[side]!]!;
      if (!previous || wrist.visibility < this.options.visibilityThreshold) return;
      const velocity = Math.hypot(wrist.x - previous.x, wrist.y - previous.y) / deltaSeconds;
      const extension = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y) / scale;
      const hand = side === 0 ? "left" : "right";
      if (velocity > 1.15 && extension > 1.05 && timestamp - this.lastPunchAt[hand] >= this.options.gestureCooldownMs) {
        result[hand] = true;
        this.lastPunchAt[hand] = timestamp;
      }
    });
    return result;
  }

  private empty(timestamp: number, landmarks: PoseLandmark[], confidence: number): PoseSignals {
    return {
      timestamp,
      calibrated: Boolean(this.calibration),
      confidence,
      actions: { ...EMPTY_ACTIONS },
      combat: { ...EMPTY_COMBAT_ACTIONS },
      axes: { bodyX: 0, lean: 0, crouch: 0, lift: 0 },
      landmarks,
    };
  }
}

export function flattenPose(pose: readonly PoseLandmark[]) {
  return pose.flatMap((landmark) => [landmark.x, landmark.y, landmark.z, landmark.visibility]);
}

export function unflattenPose(values: ReadonlyArray<number>): PoseLandmark[] {
  const pose: PoseLandmark[] = [];
  for (let index = 0; index + 3 < values.length; index += 4) {
    pose.push({ x: values[index]!, y: values[index + 1]!, z: values[index + 2]!, visibility: values[index + 3]! });
  }
  return pose;
}

export function mirrorPose(pose: readonly PoseLandmark[]): PoseLandmark[] {
  return pose.map((landmark) => ({ ...landmark, x: 1 - landmark.x }));
}

function measurePose(pose: readonly PoseLandmark[]): PoseCalibration | undefined {
  if (pose.length < 29) return undefined;
  const leftShoulder = pose[POSE_LANDMARK.leftShoulder];
  const rightShoulder = pose[POSE_LANDMARK.rightShoulder];
  const leftHip = pose[POSE_LANDMARK.leftHip];
  const rightHip = pose[POSE_LANDMARK.rightHip];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return undefined;
  const shoulderX = midpoint(leftShoulder.x, rightShoulder.x);
  const shoulderY = midpoint(leftShoulder.y, rightShoulder.y);
  const hipX = midpoint(leftHip.x, rightHip.x);
  const hipY = midpoint(leftHip.y, rightHip.y);
  return {
    bodyX: midpoint(shoulderX, hipX),
    shoulderX,
    shoulderY,
    hipX,
    hipY,
    shoulderWidth: Math.max(0.001, Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y)),
    torsoHeight: Math.max(0.001, Math.hypot(shoulderX - hipX, shoulderY - hipY)),
  };
}

function poseConfidence(pose: readonly PoseLandmark[]) {
  const required = [POSE_LANDMARK.nose, POSE_LANDMARK.leftShoulder, POSE_LANDMARK.rightShoulder, POSE_LANDMARK.leftHip, POSE_LANDMARK.rightHip, POSE_LANDMARK.leftKnee, POSE_LANDMARK.rightKnee, POSE_LANDMARK.leftAnkle, POSE_LANDMARK.rightAnkle];
  const values = required.map((index) => pose[index]?.visibility ?? 0);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function smoothPose(current: readonly PoseLandmark[], previous: readonly PoseLandmark[] | undefined, alpha: number): PoseLandmark[] {
  if (!previous || previous.length !== current.length) return current.map((landmark) => ({ ...landmark }));
  return current.map((landmark, index) => {
    const prior = previous[index]!;
    return {
      x: lerp(prior.x, landmark.x, alpha),
      y: lerp(prior.y, landmark.y, alpha),
      z: lerp(prior.z, landmark.z, alpha),
      visibility: landmark.visibility,
      ...(landmark.presence === undefined ? {} : { presence: landmark.presence }),
    };
  });
}

function averageCalibration(samples: readonly PoseCalibration[]): PoseCalibration {
  const keys = Object.keys(samples[0]!) as Array<keyof PoseCalibration>;
  return Object.fromEntries(keys.map((key) => [key, samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length])) as unknown as PoseCalibration;
}

function hysteresisHigh(active: boolean, value: number, enter: number, exit: number) {
  return active ? value > exit : value > enter;
}

function hysteresisLow(active: boolean, value: number, enter: number, exit: number) {
  return active ? value < exit : value < enter;
}

function midpoint(a: number, b: number) {
  return (a + b) / 2;
}

function lerp(a: number, b: number, amount: number) {
  return a + (b - a) * amount;
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export interface HandLandmark {
  x: number;
  y: number;
  z: number;
  /**
   * The same point in metres, relative to the wrist, when the model reports it.
   */
  world?: { x: number; y: number; z: number };
  /**
   * How much of this point is actually seen, 0-1.
   *
   * The pose model has always reported visibility per joint and this package has always thresholded
   * on it. Hands did not: every one of the 21 points came through as an equally confident position,
   * so a finger curled behind the palm arrived at a precise, invented coordinate rather than as
   * unknown. That is what makes occluded fingers read as hallucinated — nothing was lying, nothing
   * was being asked either.
   */
  visibility?: number;
}

export interface TrackedHand {
  landmarks: HandLandmark[];
  handedness: "left" | "right" | "unknown";
  confidence: number;
}

export type HandGesture = "openPalm" | "fist" | "pinch" | "point" | "twoFingers" | "grab" | "swipeLeft" | "swipeRight" | "circle";

export interface HandSignals {
  timestamp: number;
  confidence: number;
  hand?: TrackedHand;
  gestures: Record<HandGesture, boolean>;
  activated: HandGesture[];
  pointer: { x: number; y: number };
  palm: { x: number; y: number };
  velocity: { x: number; y: number };
}

export interface HandGestureClassifierOptions {
  smoothing?: number;
  stableFrames?: number;
  gestureCooldownMs?: number;
  historyMs?: number;
}

export const HAND_LANDMARK = {
  wrist: 0,
  thumbCmc: 1,
  thumbMcp: 2,
  thumbIp: 3,
  thumbTip: 4,
  indexMcp: 5,
  indexPip: 6,
  indexDip: 7,
  indexTip: 8,
  middleMcp: 9,
  middlePip: 10,
  middleDip: 11,
  middleTip: 12,
  ringMcp: 13,
  ringPip: 14,
  ringDip: 15,
  ringTip: 16,
  pinkyMcp: 17,
  pinkyPip: 18,
  pinkyDip: 19,
  pinkyTip: 20,
} as const;

export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [17, 0],
];

const EMPTY_HAND_GESTURES: Record<HandGesture, boolean> = {
  openPalm: false,
  fist: false,
  pinch: false,
  point: false,
  twoFingers: false,
  grab: false,
  swipeLeft: false,
  swipeRight: false,
  circle: false,
};

type StaticHandGesture = "openPalm" | "fist" | "pinch" | "point" | "twoFingers";

export class HandGestureClassifier {
  private readonly options: Required<HandGestureClassifierOptions>;
  private previous?: TrackedHand;
  private previousTimestamp?: number;
  private lastDetectedAt?: number;
  private candidate?: StaticHandGesture;
  private candidateFrames = 0;
  private active?: StaticHandGesture;
  private readonly activatedAt = new Map<HandGesture, number>();
  private pointerHistory: Array<{ x: number; y: number; timestamp: number }> = [];
  private palmHistory: Array<{ x: number; y: number; timestamp: number }> = [];

  constructor(options: HandGestureClassifierOptions = {}) {
    this.options = {
      smoothing: clamp01(options.smoothing ?? .45),
      stableFrames: Math.max(1, Math.round(options.stableFrames ?? 3)),
      gestureCooldownMs: Math.max(80, options.gestureCooldownMs ?? 420),
      historyMs: Math.max(420, options.historyMs ?? 1_250),
    };
  }

  process(hands: readonly TrackedHand[], timestamp: number): HandSignals {
    const detected = [...hands].sort((a, b) => b.confidence - a.confidence)[0];
    if (!detected || detected.landmarks.length < 21) {
      this.releaseHand(timestamp);
      return emptyHandSignals(timestamp);
    }
    const hand: TrackedHand = {
      handedness: detected.handedness,
      confidence: clamp01(detected.confidence),
      landmarks: smoothHand(detected.landmarks, this.previous?.landmarks, this.options.smoothing),
    };
    this.lastDetectedAt = timestamp;
    const wrist = hand.landmarks[HAND_LANDMARK.wrist]!;
    const pointerLandmark = hand.landmarks[HAND_LANDMARK.indexTip]!;
    const middleMcp = hand.landmarks[HAND_LANDMARK.middleMcp]!;
    const pointer = { x: pointerLandmark.x, y: pointerLandmark.y };
    const palm = { x: midpoint(wrist.x, middleMcp.x), y: midpoint(wrist.y, middleMcp.y) };
    const deltaSeconds = this.previousTimestamp === undefined ? 0 : Math.max(1 / 120, (timestamp - this.previousTimestamp) / 1_000);
    const previousPalm = this.previous ? palmCenter(this.previous.landmarks) : palm;
    const velocity = deltaSeconds > 0 ? { x: (palm.x - previousPalm.x) / deltaSeconds, y: (palm.y - previousPalm.y) / deltaSeconds } : { x: 0, y: 0 };
    const palmSize = Math.max(.035, distance(wrist, middleMcp));
    this.pointerHistory.push({ ...pointer, timestamp });
    this.palmHistory.push({ ...palm, timestamp });
    this.trimHistory(timestamp);

    const staticGesture = classifyStaticGesture(hand.landmarks, palmSize);
    if (staticGesture === this.candidate) this.candidateFrames += 1;
    else {
      this.candidate = staticGesture;
      this.candidateFrames = staticGesture ? 1 : 0;
    }
    const activated: HandGesture[] = [];
    if (this.candidateFrames >= this.options.stableFrames && this.active !== staticGesture) {
      this.active = staticGesture;
      if (staticGesture && this.canActivate(staticGesture, timestamp)) activated.push(staticGesture);
    }
    if (!staticGesture && this.candidateFrames === 0) this.active = undefined;

    const circle = this.detectCircle(palmSize, timestamp);
    if (circle && this.canActivate("circle", timestamp)) activated.push("circle");
    const swipe = circle ? undefined : this.detectSwipe(palmSize, timestamp);
    if (swipe && this.canActivate(swipe, timestamp)) activated.push(swipe);

    const gestures = { ...EMPTY_HAND_GESTURES };
    if (this.active) gestures[this.active] = true;
    gestures.grab = this.active === "fist" || this.active === "pinch";
    for (const event of activated) gestures[event] = true;
    this.previous = hand;
    this.previousTimestamp = timestamp;
    return { timestamp, confidence: hand.confidence, hand, gestures, activated, pointer, palm, velocity };
  }

  reset() {
    this.previous = undefined;
    this.previousTimestamp = undefined;
    this.lastDetectedAt = undefined;
    this.candidate = undefined;
    this.candidateFrames = 0;
    this.active = undefined;
    this.activatedAt.clear();
    this.pointerHistory = [];
    this.palmHistory = [];
  }

  private canActivate(gesture: HandGesture, timestamp: number) {
    const previous = this.activatedAt.get(gesture) ?? Number.NEGATIVE_INFINITY;
    if (timestamp - previous < this.options.gestureCooldownMs) return false;
    this.activatedAt.set(gesture, timestamp);
    return true;
  }

  private detectSwipe(palmSize: number, timestamp: number): "swipeLeft" | "swipeRight" | undefined {
    const recent = this.palmHistory.filter((sample) => timestamp - sample.timestamp <= 280);
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last || last.timestamp - first.timestamp < 85) return undefined;
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const seconds = (last.timestamp - first.timestamp) / 1_000;
    if (Math.abs(dx) < palmSize * 1.15 || Math.abs(dx) < Math.abs(dy) * 1.65 || Math.abs(dx) / seconds < .72) return undefined;
    return dx < 0 ? "swipeLeft" : "swipeRight";
  }

  private detectCircle(palmSize: number, timestamp: number) {
    const samples = this.pointerHistory.filter((sample) => timestamp - sample.timestamp <= this.options.historyMs);
    if (samples.length < 10 || samples.at(-1)!.timestamp - samples[0]!.timestamp < 380) return false;
    const center = {
      x: samples.reduce((sum, sample) => sum + sample.x, 0) / samples.length,
      y: samples.reduce((sum, sample) => sum + sample.y, 0) / samples.length,
    };
    const radii = samples.map((sample) => Math.hypot(sample.x - center.x, sample.y - center.y));
    const averageRadius = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
    if (averageRadius < palmSize * .42) return false;
    const deviation = radii.reduce((sum, radius) => sum + Math.abs(radius - averageRadius), 0) / radii.length;
    if (deviation / averageRadius > .42) return false;
    let angle = 0;
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      angle += wrappedAngle(
        Math.atan2(current.y - center.y, current.x - center.x)
        - Math.atan2(previous.y - center.y, previous.x - center.x),
      );
    }
    if (Math.abs(angle) < Math.PI * 1.62 || distance(samples[0]!, samples.at(-1)!) > averageRadius * 1.05) return false;
    this.pointerHistory = [samples.at(-1)!];
    return true;
  }

  private trimHistory(timestamp: number) {
    this.pointerHistory = this.pointerHistory.filter((sample) => timestamp - sample.timestamp <= this.options.historyMs);
    this.palmHistory = this.palmHistory.filter((sample) => timestamp - sample.timestamp <= Math.min(this.options.historyMs, 320));
  }

  private releaseHand(timestamp: number) {
    if (this.lastDetectedAt !== undefined && timestamp - this.lastDetectedAt > 100) {
      this.previous = undefined;
      this.previousTimestamp = undefined;
      this.lastDetectedAt = undefined;
      this.candidate = undefined;
      this.candidateFrames = 0;
      this.active = undefined;
      this.pointerHistory = [];
      this.palmHistory = [];
    }
  }
}

export function flattenHand(hand: readonly HandLandmark[]) {
  return hand.flatMap((landmark) => [landmark.x, landmark.y, landmark.z]);
}

export function unflattenHand(values: ReadonlyArray<number>): HandLandmark[] {
  const hand: HandLandmark[] = [];
  for (let index = 0; index + 2 < values.length; index += 3) hand.push({ x: values[index]!, y: values[index + 1]!, z: values[index + 2]! });
  return hand;
}

export function mirrorHand(hand: readonly HandLandmark[]): HandLandmark[] {
  return hand.map((landmark) => ({ ...landmark, x: 1 - landmark.x }));
}

function classifyStaticGesture(hand: readonly HandLandmark[], palmSize: number): StaticHandGesture | undefined {
  const thumb = fingerExtended(hand, HAND_LANDMARK.thumbTip, HAND_LANDMARK.thumbIp, HAND_LANDMARK.thumbMcp, 1.02);
  const index = fingerExtended(hand, HAND_LANDMARK.indexTip, HAND_LANDMARK.indexPip, HAND_LANDMARK.indexMcp);
  const middle = fingerExtended(hand, HAND_LANDMARK.middleTip, HAND_LANDMARK.middlePip, HAND_LANDMARK.middleMcp);
  const ring = fingerExtended(hand, HAND_LANDMARK.ringTip, HAND_LANDMARK.ringPip, HAND_LANDMARK.ringMcp);
  const pinky = fingerExtended(hand, HAND_LANDMARK.pinkyTip, HAND_LANDMARK.pinkyPip, HAND_LANDMARK.pinkyMcp);
  const extended = [thumb, index, middle, ring, pinky].filter(Boolean).length;
  const pinching = distance(hand[HAND_LANDMARK.thumbTip]!, hand[HAND_LANDMARK.indexTip]!) < palmSize * .38;
  if (pinching) return "pinch";
  if (extended === 0) return "fist";
  if (index && middle && !ring && !pinky) return "twoFingers";
  if (index && !middle && !ring && !pinky) return "point";
  if (extended >= 4 && index && middle && ring && pinky) return "openPalm";
  return undefined;
}

function fingerExtended(hand: readonly HandLandmark[], tipIndex: number, pipIndex: number, mcpIndex: number, ratio = 1.12) {
  const wrist = hand[HAND_LANDMARK.wrist]!;
  const tip = hand[tipIndex]!;
  const pip = hand[pipIndex]!;
  const mcp = hand[mcpIndex]!;
  return distance(tip, wrist) > distance(pip, wrist) * ratio && distance(tip, mcp) > distance(pip, mcp) * .92;
}

function smoothHand(current: readonly HandLandmark[], previous: readonly HandLandmark[] | undefined, alpha: number): HandLandmark[] {
  if (!previous || previous.length !== current.length) return current.map((landmark) => ({ ...landmark }));
  return current.map((landmark, index) => ({
    x: lerp(previous[index]!.x, landmark.x, alpha),
    y: lerp(previous[index]!.y, landmark.y, alpha),
    z: lerp(previous[index]!.z, landmark.z, alpha),
  }));
}

function palmCenter(hand: readonly HandLandmark[]) {
  const wrist = hand[HAND_LANDMARK.wrist]!;
  const middle = hand[HAND_LANDMARK.middleMcp]!;
  return { x: midpoint(wrist.x, middle.x), y: midpoint(wrist.y, middle.y) };
}

function emptyHandSignals(timestamp: number): HandSignals {
  return {
    timestamp,
    confidence: 0,
    gestures: { ...EMPTY_HAND_GESTURES },
    activated: [],
    pointer: { x: .5, y: .5 },
    palm: { x: .5, y: .5 },
    velocity: { x: 0, y: 0 },
  };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function wrappedAngle(value: number) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}
