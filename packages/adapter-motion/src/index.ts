import type { InputAdapter, InputFrame, InputFrameListener } from "@101/input";
import {
  DEFAULT_CALIBRATION,
  MotionGestureRecognizer,
  MotionPipeline,
  quaternionFromDeviceOrientation,
  quaternionToAngles,
  type MotionCalibration,
  type MotionGestures,
  type MotionSample,
} from "@101/motion";

export type MotionPermission = "granted" | "denied" | "unsupported";

export interface MotionDiagnostics {
  raw: MotionSample;
  filtered: MotionSample;
  gestures: MotionGestures;
  pitch: number;
  roll: number;
  yaw: number;
  frame: InputFrame;
}

export interface BrowserMotionAdapterOptions {
  deviceId?: string;
  playerId?: string;
  calibration?: Partial<MotionCalibration>;
  onDiagnostics?: (diagnostics: MotionDiagnostics) => void;
}

interface PermissionedMotionEvent {
  requestPermission?: () => Promise<"granted" | "denied">;
}

export async function requestMotionPermission(): Promise<MotionPermission> {
  if (typeof window === "undefined" || typeof DeviceMotionEvent === "undefined") return "unsupported";
  const permissionApi = DeviceMotionEvent as unknown as PermissionedMotionEvent;
  if (!permissionApi.requestPermission) return "granted";
  try {
    return await permissionApi.requestPermission();
  } catch {
    return "denied";
  }
}

export function isMotionSupported() {
  return typeof window !== "undefined" && typeof DeviceMotionEvent !== "undefined";
}

export class BrowserMotionAdapter implements InputAdapter {
  readonly id: string;
  readonly source = "phone-motion" as const;
  readonly pipeline: MotionPipeline;
  private readonly playerId: string;
  private readonly onDiagnostics?: (diagnostics: MotionDiagnostics) => void;
  private readonly recognizer = new MotionGestureRecognizer();
  private emit?: InputFrameListener;
  private sequence = 0;
  private latestRaw: MotionSample = {
    timestamp: 0,
    orientation: [0, 0, 0, 1],
    acceleration: [0, 0, 0],
    angularVelocity: [0, 0, 0],
  };

  constructor(options: BrowserMotionAdapterOptions = {}) {
    this.id = options.deviceId ?? "motion-browser";
    this.playerId = options.playerId ?? "player-1";
    this.onDiagnostics = options.onDiagnostics;
    this.pipeline = new MotionPipeline({ ...DEFAULT_CALIBRATION, ...options.calibration });
  }

  start(emit: InputFrameListener) {
    this.emit = emit;
    window.addEventListener("deviceorientation", this.onOrientation, true);
    window.addEventListener("devicemotion", this.onMotion, true);
  }

  stop() {
    window.removeEventListener("deviceorientation", this.onOrientation, true);
    window.removeEventListener("devicemotion", this.onMotion, true);
    this.emit = undefined;
    this.recognizer.reset();
    this.pipeline.reset();
  }

  calibrateNeutral() {
    this.pipeline.calibrateNeutral(this.latestRaw);
  }

  setSensitivity(value: number) {
    this.pipeline.setSensitivity(value);
  }

  setDeadZone(value: number) {
    this.pipeline.setDeadZone(value);
  }

  ingest(sample: MotionSample) {
    this.latestRaw = sample;
    this.publish();
  }

  private onOrientation = (event: DeviceOrientationEvent) => {
    const screenAngle = window.screen.orientation?.angle ?? 0;
    this.latestRaw = {
      ...this.latestRaw,
      timestamp: event.timeStamp || performance.now(),
      orientation: quaternionFromDeviceOrientation(event.alpha ?? 0, event.beta ?? 0, event.gamma ?? 0, screenAngle),
    };
    this.publish();
  };

  private onMotion = (event: DeviceMotionEvent) => {
    const acceleration = event.acceleration ?? event.accelerationIncludingGravity;
    const rotation = event.rotationRate;
    this.latestRaw = {
      ...this.latestRaw,
      timestamp: event.timeStamp || performance.now(),
      acceleration: [acceleration?.x ?? 0, acceleration?.y ?? 0, acceleration?.z ?? 0],
      angularVelocity: [rotation?.beta ?? 0, rotation?.gamma ?? 0, rotation?.alpha ?? 0],
    };
    this.publish();
  };

  private publish() {
    const filtered = this.pipeline.process(this.latestRaw);
    const gestures = this.recognizer.update(filtered);
    const { pitch, roll, yaw } = quaternionToAngles(filtered.orientation);
    const sensitivity = this.pipeline.calibration.sensitivity;
    const tiltScale = Math.PI / (3 * sensitivity);
    const steer = clamp(roll / tiltScale);
    const tiltY = clamp(pitch / tiltScale);
    const [qx, qy, qz, qw] = filtered.orientation;
    const [ax, ay, az] = filtered.acceleration;
    const [gx, gy, gz] = filtered.angularVelocity;
    const frame: InputFrame = {
      deviceId: this.id,
      playerId: this.playerId,
      sequence: ++this.sequence,
      timestamp: filtered.timestamp || performance.now(),
      source: this.source,
      actions: { shake: gestures.shake, slash: gestures.swing, swing: gestures.swing, spin: gestures.spin },
      axes: { steer, tiltX: steer, tiltY, pitch: clamp(pitch / Math.PI), roll: clamp(roll / Math.PI), yaw: clamp(yaw / Math.PI), qx, qy, qz, qw, ax: clamp(ax / 12), ay: clamp(ay / 12), az: clamp(az / 12), gx: clamp(gx / 360), gy: clamp(gy / 360), gz: clamp(gz / 360) },
      vectors: { tilt: { x: steer, y: tiltY }, orientation: { x: qx, y: qy, z: qz } },
    };
    this.emit?.(frame);
    this.onDiagnostics?.({ raw: this.latestRaw, filtered, gestures, pitch, roll, yaw, frame });
  }
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}
