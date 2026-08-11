export type Quaternion = readonly [number, number, number, number];
export type Vector3 = readonly [number, number, number];

export interface MotionSample {
  timestamp: number;
  orientation: Quaternion;
  acceleration: Vector3;
  angularVelocity: Vector3;
}

export interface MotionCalibration {
  neutral: Quaternion;
  sensitivity: number;
  deadZone: number;
  smoothing: number;
}

export const DEFAULT_CALIBRATION: MotionCalibration = {
  neutral: [0, 0, 0, 1],
  sensitivity: 1,
  deadZone: 0.04,
  smoothing: 0.22,
};

export interface MotionAngles {
  pitch: number;
  roll: number;
  yaw: number;
}

export interface MotionGestures {
  shake: boolean;
  swing: boolean;
  spin: boolean;
}

export interface GestureThresholds {
  shakeAcceleration: number;
  swingAngularVelocity: number;
  spinAngularVelocity: number;
  impulseWindowMs: number;
  cooldownMs: number;
}

const DEFAULT_THRESHOLDS: GestureThresholds = {
  shakeAcceleration: 7.5,
  swingAngularVelocity: 145,
  spinAngularVelocity: 285,
  impulseWindowMs: 320,
  cooldownMs: 360,
};

export class MotionPipeline {
  private previous?: MotionSample;
  readonly calibration: MotionCalibration;

  constructor(calibration: MotionCalibration = DEFAULT_CALIBRATION) {
    this.calibration = {
      ...calibration,
      neutral: normalizeQuaternion(calibration.neutral),
    };
  }

  process(sample: MotionSample): MotionSample {
    const sensitivity = clamp(this.calibration.sensitivity, 0.1, 3);
    const corrected: MotionSample = {
      timestamp: sample.timestamp,
      orientation: relativeQuaternion(sample.orientation, this.calibration.neutral),
      acceleration: applyDeadZone(scaleVector(sample.acceleration, sensitivity), this.calibration.deadZone),
      angularVelocity: applyDeadZone(scaleVector(sample.angularVelocity, sensitivity), this.calibration.deadZone),
    };
    if (!this.previous) {
      this.previous = corrected;
      return corrected;
    }

    const alpha = clamp(this.calibration.smoothing, 0, 1);
    const next: MotionSample = {
      timestamp: corrected.timestamp,
      orientation: normalizeQuaternion(lerpVector(corrected.orientation, this.previous.orientation, alpha) as unknown as Quaternion),
      acceleration: lerpVector(corrected.acceleration, this.previous.acceleration, alpha) as unknown as Vector3,
      angularVelocity: lerpVector(corrected.angularVelocity, this.previous.angularVelocity, alpha) as unknown as Vector3,
    };
    this.previous = next;
    return next;
  }

  calibrateNeutral(sample: MotionSample | Quaternion) {
    this.calibration.neutral = normalizeQuaternion("orientation" in sample ? sample.orientation : sample);
    this.reset();
  }

  setSensitivity(value: number) {
    this.calibration.sensitivity = clamp(value, 0.1, 3);
  }

  setDeadZone(value: number) {
    this.calibration.deadZone = clamp(value, 0, 1);
  }

  reset() {
    this.previous = undefined;
  }
}

export class MotionGestureRecognizer {
  private readonly thresholds: GestureThresholds;
  private lastImpulseSign = 0;
  private lastImpulseAt = Number.NEGATIVE_INFINITY;
  private lastShakeAt = Number.NEGATIVE_INFINITY;
  private lastSwingAt = Number.NEGATIVE_INFINITY;
  private lastSpinAt = Number.NEGATIVE_INFINITY;
  private swingArmed = false;

  constructor(thresholds: Partial<GestureThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  update(sample: MotionSample): MotionGestures {
    const now = sample.timestamp;
    const dominantAcceleration = dominantSigned(sample.acceleration);
    const impulseSign = Math.sign(dominantAcceleration);
    let shake = false;

    if (Math.abs(dominantAcceleration) >= this.thresholds.shakeAcceleration) {
      const reversed = this.lastImpulseSign !== 0 && impulseSign !== this.lastImpulseSign;
      const withinWindow = now - this.lastImpulseAt <= this.thresholds.impulseWindowMs;
      if (reversed && withinWindow && now - this.lastShakeAt >= this.thresholds.cooldownMs) {
        shake = true;
        this.lastShakeAt = now;
      }
      this.lastImpulseSign = impulseSign;
      this.lastImpulseAt = now;
    }

    const angularSpeed = Math.hypot(...sample.angularVelocity);
    const aboveSwing = angularSpeed >= this.thresholds.swingAngularVelocity;
    let swing = false;
    if (aboveSwing && this.swingArmed && now - this.lastSwingAt >= this.thresholds.cooldownMs) {
      swing = true;
      this.lastSwingAt = now;
      this.swingArmed = false;
    } else if (aboveSwing) {
      this.swingArmed = true;
    } else {
      this.swingArmed = false;
    }

    const spin = angularSpeed >= this.thresholds.spinAngularVelocity
      && now - this.lastSpinAt >= this.thresholds.cooldownMs;
    if (spin) this.lastSpinAt = now;

    return { shake, swing, spin };
  }

  reset() {
    this.lastImpulseSign = 0;
    this.lastImpulseAt = Number.NEGATIVE_INFINITY;
    this.lastShakeAt = Number.NEGATIVE_INFINITY;
    this.lastSwingAt = Number.NEGATIVE_INFINITY;
    this.lastSpinAt = Number.NEGATIVE_INFINITY;
    this.swingArmed = false;
  }
}

export function quaternionFromDeviceOrientation(
  alphaDegrees: number,
  betaDegrees: number,
  gammaDegrees: number,
  screenAngleDegrees = 0,
): Quaternion {
  const z = axisAngle([0, 0, 1], degrees(alphaDegrees));
  const x = axisAngle([1, 0, 0], degrees(betaDegrees));
  const y = axisAngle([0, 1, 0], degrees(gammaDegrees));
  const screen = axisAngle([0, 0, 1], degrees(-screenAngleDegrees));
  return normalizeQuaternion(multiplyQuaternions(multiplyQuaternions(multiplyQuaternions(z, x), y), screen));
}

export function quaternionToAngles(quaternion: Quaternion): MotionAngles {
  const [x, y, z, w] = normalizeQuaternion(quaternion);
  const sinPitch = 2 * (w * x - y * z);
  const pitch = Math.asin(clamp(sinPitch, -1, 1));
  const roll = Math.atan2(2 * (w * y + z * x), 1 - 2 * (x * x + y * y));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
  return { pitch, roll, yaw };
}

export function relativeQuaternion(value: Quaternion, neutral: Quaternion): Quaternion {
  return normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(neutral), value));
}

export function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function conjugateQuaternion(value: Quaternion): Quaternion {
  return [-value[0], -value[1], -value[2], value[3]];
}

export function normalizeQuaternion(value: Quaternion): Quaternion {
  const length = Math.hypot(...value) || 1;
  return value.map((component) => component / length) as unknown as Quaternion;
}

function axisAngle(axis: Vector3, angle: number): Quaternion {
  const half = angle / 2;
  const sine = Math.sin(half);
  return [axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(half)];
}

function applyDeadZone(value: Vector3, deadZone: number): Vector3 {
  return value.map((component) => Math.abs(component) < deadZone ? 0 : component) as unknown as Vector3;
}

function scaleVector(value: Vector3, amount: number): Vector3 {
  return value.map((component) => component * amount) as unknown as Vector3;
}

function lerpVector(current: readonly number[], prior: readonly number[], alpha: number) {
  return current.map((value, index) => prior[index]! + (value - prior[index]!) * alpha);
}

function dominantSigned(value: Vector3) {
  return value.reduce((dominant, component) => Math.abs(component) > Math.abs(dominant) ? component : dominant, 0);
}

function degrees(value: number) {
  return value * Math.PI / 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}
