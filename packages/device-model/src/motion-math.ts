export type Quaternion = readonly [number, number, number, number];
export type Vector3 = readonly [number, number, number];

export interface MotionAngles {
  pitch: number;
  roll: number;
  yaw: number;
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

function degrees(value: number) {
  return value * Math.PI / 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}
