import { Platform } from "react-native";
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
  private smoothedIntervalMs?: number;
  private sampleRate = 0;

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
    if (motionPermissionRequired()) {
      const permission = await DeviceMotion.requestPermissionsAsync();
      if (!permission.granted) throw new Error("Motion permission was not granted");
    }
    DeviceMotion.setUpdateInterval(16);
    this.subscription = DeviceMotion.addListener((measurement) => this.process(measurement));
    return true;
  }

  stop() {
    this.subscription?.remove();
    this.subscription = undefined;
    this.lastTimestamp = undefined;
    this.smoothedIntervalMs = undefined;
    this.sampleRate = 0;
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
    this.trackSampleRate(timestamp);
    this.emit({
      raw,
      filtered,
      angles: quaternionToAngles(filtered.orientation),
      gestures,
      sampleRate: this.sampleRate,
    });
  }

  /**
   * Sample rate for the Sensor Lab readout.
   *
   * This is a diagnostic people calibrate against, so it must never state a number it cannot
   * support. Two readings sharing a timestamp previously produced a 1 ms floor and a reported
   * 1,000,000 Hz; a rate nobody can achieve is worse than admitting the interval is unknown.
   *
   * Repeated timestamps are therefore skipped rather than clamped, and the interval is smoothed,
   * because the instantaneous gap between two sensor callbacks is far too jittery to read.
   */
  private trackSampleRate(timestamp: number) {
    const previous = this.lastTimestamp;
    this.lastTimestamp = timestamp;
    if (previous === undefined) return;

    const delta = timestamp - previous;
    // A non-advancing or absurd clock says nothing about the real rate; keep the last good value.
    if (!(delta > 0) || delta > MAX_SAMPLE_INTERVAL_MS) return;

    this.smoothedIntervalMs = this.smoothedIntervalMs === undefined
      ? delta
      : this.smoothedIntervalMs + (delta - this.smoothedIntervalMs) * SAMPLE_RATE_SMOOTHING;
    this.sampleRate = Math.min(MAX_REPORTED_HZ, 1_000 / this.smoothedIntervalMs);
  }
}

/** Beyond this the device stopped delivering rather than sampling slowly. */
const MAX_SAMPLE_INTERVAL_MS = 1_000;
/** No consumer sensor exceeds this; a higher figure means the clock, not the sensor. */
const MAX_REPORTED_HZ = 1_000;
const SAMPLE_RATE_SMOOTHING = 0.2;

/**
 * Whether this platform actually gates device motion behind a runtime permission.
 *
 * iOS does: reading `CMDeviceMotion` requires the motion usage description the app declares.
 *
 * Android does not. Accelerometer, gyroscope and magnetometer need no runtime permission there;
 * `expo-sensors` asks for `ACTIVITY_RECOGNITION` on API 29+ only because its DeviceMotion module
 * also fronts pedometer-style data. 101 reads orientation, acceleration and rotation rate and
 * nothing else, and deliberately blocks `ACTIVITY_RECOGNITION` so it cannot collect activity or
 * health signals — see docs/privacy-security.md.
 *
 * Requesting a permission the app has blocked can only ever be denied, which previously left
 * Android motion controls permanently dead. Skipping the request is both the working and the
 * privacy-preserving answer; it grants nothing extra, because the sensors were never gated.
 */
function motionPermissionRequired() {
  return Platform.OS === "ios";
}

function radiansToDegrees(value: number) {
  return value * 180 / Math.PI;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
