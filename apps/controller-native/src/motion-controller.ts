import { Platform } from "react-native";
import { DeviceMotion, type DeviceMotionMeasurement } from "expo-sensors";
import { expoAngularVelocity } from "./motion-axes";

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

// One native sensor listener has one cleanup owner, including after its UI is
// unmounted. A failed removal must be retried before a replacement can listen.
const listenerOwnership: { owner?: NativeMotionController } = {};

export class NativeMotionController {
  private readonly pipeline = new MotionPipeline();
  private readonly recognizer = new MotionGestureRecognizer();
  private subscription?: { remove(): void };
  private startPromise?: Promise<boolean>;
  private revision = 0;
  private listenerRevision?: number;
  private removing = false;
  private acquiring = false;
  private latestRaw?: MotionSample;
  private lastTimestamp?: number;
  private smoothedIntervalMs?: number;
  private sampleRate = 0;

  constructor(private readonly emit: (readout: MotionReadout) => void) {}

  get active() {
    return Boolean(listenerOwnership.owner === this && this.subscription && this.listenerRevision === this.revision);
  }

  get calibration() {
    return { ...this.pipeline.calibration, neutral: [...this.pipeline.calibration.neutral] as const };
  }

  start(): Promise<boolean> {
    if (this.active) return Promise.resolve(true);
    if (this.startPromise) return this.startPromise;
    const revision = this.revision;
    // Publish the pending start before calling the sensor module: its callbacks
    // can synchronously reenter start or Stop.
    const opening = Promise.resolve().then(async () => {
      if (revision !== this.revision) return false;
      const previous = listenerOwnership.owner;
      if (previous && previous !== this) {
        if (previous.active || previous.startPromise || previous.acquiring || previous.removing) throw new Error("Motion sensing is already in use");
        previous.stop();
        if (previous.subscription) throw new Error("Motion listener could not be removed");
      }
      if (revision !== this.revision) return false;
      if (this.subscription) {
        this.removeSubscription(this.subscription);
        if (revision !== this.revision) return false;
        if (this.subscription) throw new Error("Motion listener could not be removed");
      }
      if (listenerOwnership.owner && listenerOwnership.owner !== this) throw new Error("Motion sensing is already in use");
      listenerOwnership.owner = this;
      const available = await DeviceMotion.isAvailableAsync();
      if (revision !== this.revision) return false;
      if (!available) throw new Error("Motion sensors are unavailable on this device");
      if (motionPermissionRequired()) {
        const permission = await DeviceMotion.requestPermissionsAsync();
        if (revision !== this.revision) return false;
        if (!permission.granted) throw new Error("Motion permission was not granted");
      }
      DeviceMotion.setUpdateInterval(16);
      if (revision !== this.revision) return false;
      const created: { current?: { remove(): void } } = {};
      this.acquiring = true;
      let listener: { remove(): void };
      try {
        listener = DeviceMotion.addListener((measurement) => {
          if (created.current && this.subscription === created.current && this.listenerRevision === revision && this.revision === revision)
            this.process(measurement, revision);
        });
      } finally { this.acquiring = false; }
      created.current = listener;
      this.subscription = listener;
      this.listenerRevision = revision;
      if (revision !== this.revision) { this.removeSubscription(listener); return false; }
      return true;
    }).catch((reason: unknown) => {
      if (revision !== this.revision) return false;
      throw reason;
    }).finally(() => {
      if (this.startPromise === opening) this.startPromise = undefined;
      this.releaseIdleOwner();
    });
    this.startPromise = opening;
    return opening;
  }

  stop() {
    this.revision++;
    this.startPromise = undefined;
    if (this.subscription) this.removeSubscription(this.subscription);
    this.latestRaw = undefined;
    this.lastTimestamp = undefined;
    this.smoothedIntervalMs = undefined;
    this.sampleRate = 0;
    this.recognizer.reset();
    this.pipeline.reset();
    this.releaseIdleOwner();
  }

  private removeSubscription(listener: { remove(): void }) {
    if (this.removing) return;
    this.removing = true;
    try {
      listener.remove();
      if (this.subscription === listener) {
        this.subscription = undefined;
        this.listenerRevision = undefined;
      }
    } catch {
      // Retain the exact handle and its module-level owner for retry.
    } finally { this.removing = false; }
  }

  private releaseIdleOwner() {
    if (listenerOwnership.owner === this && !this.subscription && !this.acquiring && !this.removing && !this.startPromise)
      listenerOwnership.owner = undefined;
  }

  calibrateNeutral() {
    if (!this.active || !this.latestRaw) throw new Error("Start motion sensing before calibration");
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

  private process(measurement: DeviceMotionMeasurement, revision: number) {
    if (!this.active || revision !== this.revision) return;
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
      angularVelocity: expoAngularVelocity(rate, Platform.OS),
    };
    if (!this.active || revision !== this.revision) return;
    const filtered = this.pipeline.process(raw);
    const gestures = this.recognizer.update(filtered);
    this.trackSampleRate(timestamp);
    if (!this.active || revision !== this.revision) return;
    this.latestRaw = raw;
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
