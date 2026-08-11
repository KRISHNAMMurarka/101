export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
  presence?: number;
}

export type BodyAction = "standing" | "duck" | "jump" | "leanLeft" | "leanRight" | "stepLeft" | "stepRight" | "armsRaised" | "punch";

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

export class PoseClassifier {
  private readonly options: Required<PoseClassifierOptions>;
  private calibration?: PoseCalibration;
  private samples: PoseCalibration[] = [];
  private previousPose?: PoseLandmark[];
  private previousTimestamp?: number;
  private lastPunchAt = Number.NEGATIVE_INFINITY;
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
    const punch = this.detectPunch(landmarks, timestamp, scale);
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
    return { timestamp, calibrated: true, confidence, actions, axes: { bodyX, lean, crouch, lift }, landmarks };
  }

  reset() {
    this.calibration = undefined;
    this.samples = [];
    this.previousPose = undefined;
    this.previousTimestamp = undefined;
    this.lastPunchAt = Number.NEGATIVE_INFINITY;
    this.states = { duck: false, jump: false, leanLeft: false, leanRight: false, stepLeft: false, stepRight: false };
  }

  private detectPunch(pose: readonly PoseLandmark[], timestamp: number, scale: number) {
    if (!this.previousPose || this.previousTimestamp === undefined) return false;
    const deltaSeconds = Math.max(1 / 120, (timestamp - this.previousTimestamp) / 1000);
    const candidates = [POSE_LANDMARK.leftWrist, POSE_LANDMARK.rightWrist] as const;
    const shoulders = [POSE_LANDMARK.leftShoulder, POSE_LANDMARK.rightShoulder] as const;
    const isPunch = candidates.some((index, side) => {
      const wrist = pose[index]!;
      const previous = this.previousPose?.[index];
      const shoulder = pose[shoulders[side]!]!;
      if (!previous || wrist.visibility < this.options.visibilityThreshold) return false;
      const velocity = Math.hypot(wrist.x - previous.x, wrist.y - previous.y) / deltaSeconds;
      const extension = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y) / scale;
      return velocity > 1.15 && extension > 1.05;
    });
    if (!isPunch || timestamp - this.lastPunchAt < this.options.gestureCooldownMs) return false;
    this.lastPunchAt = timestamp;
    return true;
  }

  private empty(timestamp: number, landmarks: PoseLandmark[], confidence: number): PoseSignals {
    return {
      timestamp,
      calibrated: Boolean(this.calibration),
      confidence,
      actions: { ...EMPTY_ACTIONS },
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
