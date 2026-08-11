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

export class MotionPipeline {
  private previous?: MotionSample;

  constructor(readonly calibration: MotionCalibration = DEFAULT_CALIBRATION) {}

  process(sample: MotionSample): MotionSample {
    if (!this.previous) {
      this.previous = sample;
      return sample;
    }
    const alpha = Math.max(0, Math.min(1, this.calibration.smoothing));
    const smooth = (current: readonly number[], prior: readonly number[]) =>
      current.map((value, index) => prior[index]! + (value - prior[index]!) * alpha);

    const next = {
      timestamp: sample.timestamp,
      orientation: normalizeQuaternion(
        smooth(sample.orientation, this.previous.orientation) as unknown as Quaternion,
      ),
      acceleration: smooth(sample.acceleration, this.previous.acceleration).map(
        (value) => (Math.abs(value) < this.calibration.deadZone ? 0 : value),
      ) as unknown as Vector3,
      angularVelocity: smooth(sample.angularVelocity, this.previous.angularVelocity) as unknown as Vector3,
    };
    this.previous = next;
    return next;
  }

  reset() {
    this.previous = undefined;
  }
}

function normalizeQuaternion(value: Quaternion): Quaternion {
  const length = Math.hypot(...value) || 1;
  return value.map((component) => component / length) as unknown as Quaternion;
}
