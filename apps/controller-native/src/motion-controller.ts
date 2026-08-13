import { DeviceMotion, type DeviceMotionMeasurement } from "expo-sensors";

import {
  MotionGestureRecognizer,
  MotionPipeline,
  quaternionFromDeviceOrientation,
  quaternionToAngles,
  type MotionAngles,
  type MotionGestures,
  type MotionSample,
} from "@101/motion";

export interface MotionReadout {
  raw: MotionSample;
  filtered: MotionSample;
  angles: MotionAngles;
  gestures: MotionGestures;
  sampleRate: number;
}

export class NativeMotionController {
  private readonly pipeline = new MotionPipeline();
  private readonly recognizer = new MotionGestureRecognizer();
  private subscription?: { remove(): void };
  private latestRaw?: MotionSample;
  private lastTimestamp?: number;

  constructor(private readonly emit: (readout: MotionReadout) => void) {}

  get active() {
    return Boolean(this.subscription);
  }

  get calibration() {
    return { ...this.pipeline.calibration, neutral: [...this.pipeline.calibration.neutral] as const };
  }

  async start() {
    if (this.subscription) return true;
    if (!(await DeviceMotion.isAvailableAsync())) throw new Error("Motion sensors are unavailable on this device");
    const permission = await DeviceMotion.requestPermissionsAsync();
    if (!permission.granted) throw new Error("Motion permission was not granted");
    DeviceMotion.setUpdateInterval(16);
    this.subscription = DeviceMotion.addListener((measurement) => this.process(measurement));
    return true;
  }

  stop() {
    this.subscription?.remove();
    this.subscription = undefined;
    this.lastTimestamp = undefined;
    this.recognizer.reset();
    this.pipeline.reset();
  }

  calibrateNeutral() {
    if (!this.latestRaw) throw new Error("Start motion sensing before calibration");
    this.pipeline.calibrateNeutral(this.latestRaw);
  }

  setSensitivity(value: number) {
    this.pipeline.setSensitivity(value);
  }

  setDeadZone(value: number) {
    this.pipeline.setDeadZone(value);
  }

  setSmoothing(value: number) {
    this.pipeline.calibration.smoothing = clamp(value, 0, 1);
    this.pipeline.reset();
  }

  private process(measurement: DeviceMotionMeasurement) {
    const rotation = measurement.rotation ?? { alpha: 0, beta: 0, gamma: 0 };
    const rate = measurement.rotationRate ?? { alpha: 0, beta: 0, gamma: 0 };
    const acceleration = measurement.accelerationIncludingGravity ?? measurement.acceleration ?? { x: 0, y: 0, z: 0 };
    const nativeTimestamp = rotation.timestamp ?? acceleration.timestamp ?? Date.now();
    const timestamp = nativeTimestamp < 1_000_000_000_000 ? nativeTimestamp * 1_000 : nativeTimestamp;
    const raw: MotionSample = {
      timestamp,
      orientation: quaternionFromDeviceOrientation(
        radiansToDegrees(rotation.alpha ?? 0),
        radiansToDegrees(rotation.beta ?? 0),
        radiansToDegrees(rotation.gamma ?? 0),
        measurement.orientation,
      ),
      acceleration: [acceleration.x ?? 0, acceleration.y ?? 0, acceleration.z ?? 0],
      angularVelocity: [rate.beta ?? 0, rate.gamma ?? 0, rate.alpha ?? 0],
    };
    this.latestRaw = raw;
    const filtered = this.pipeline.process(raw);
    const gestures = this.recognizer.update(filtered);
    const delta = this.lastTimestamp === undefined ? 0 : Math.max(0.001, timestamp - this.lastTimestamp);
    this.lastTimestamp = timestamp;
    this.emit({
      raw,
      filtered,
      angles: quaternionToAngles(filtered.orientation),
      gestures,
      sampleRate: delta ? 1_000 / delta : 0,
    });
  }
}

function radiansToDegrees(value: number) {
  return value * 180 / Math.PI;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
