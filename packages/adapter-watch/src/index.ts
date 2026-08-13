import type { InputAdapter, InputFrame, InputFrameListener } from "@101/input";
import {
  DEFAULT_CALIBRATION,
  MotionPipeline,
  quaternionToAngles,
  type MotionCalibration,
  type Quaternion,
  type Vector3,
} from "@101/motion";

/**
 * A watch is treated as an extension of 101 Link rather than a separate game system. The native
 * watch app relays samples to its paired handheld, the handheld's Link session forwards them, and
 * this adapter turns them into ordinary `watch-motion` frames. Games never learn a watch was
 * involved; they bind semantic controls exactly as they do for a phone or a gamepad.
 */
export type WatchPlatform = "watchos" | "wearos";

/** How the sample physically reached the handheld. `unknown` is a real answer, not a placeholder. */
export type WatchTransport = "bluetooth" | "wifi" | "cloud" | "unknown";

/**
 * Whether strict locality is actually established.
 *
 * Apple's Watch Connectivity moves data between a watch and its own paired iPhone, so interactive
 * messaging to a reachable counterpart is device-to-device. Google's Wearable Data Layer is
 * explicitly documented as choosing its own route and may travel over the network rather than
 * Bluetooth, so a Wear OS path is only local when the node reports itself nearby. 101 never
 * upgrades an unproven route to "verified-local" — it reports what it can actually confirm.
 */
export type WatchLocality = "verified-local" | "assumed-local" | "cloud-possible" | "unknown";

export interface WatchLinkStatus {
  platform: WatchPlatform;
  transport: WatchTransport;
  locality: WatchLocality;
  /** The watch app is running and can exchange interactive messages right now. */
  reachable: boolean;
  /** A watch is paired to this handheld at the OS level. */
  companionPaired: boolean;
  /** The 101 watch app is installed on that watch. */
  appInstalled: boolean;
  /** Wear OS only: the OS reports this node as nearby, which is what rules out a cloud route. */
  nearby?: boolean;
  /** Plain-language statement suitable for display next to a connection indicator. */
  note: string;
}

export interface WatchSample {
  timestamp: number;
  /** Wrist attitude. */
  orientation: Quaternion;
  /** User acceleration in g, gravity already removed by the native layer. */
  acceleration: Vector3;
  /** Rotation rate in degrees per second. */
  angularVelocity: Vector3;
  /** Digital Crown / rotary bezel absolute travel in detents. Monotonic; deltas are derived here. */
  crown?: number;
  /** Screen tap on the watch face. */
  tap?: boolean;
}

/**
 * Units are named explicitly. `@101/motion` reports angles in radians while sensors report rates
 * in degrees per second, and mixing the two silently produces thresholds that never trigger.
 */
export interface WatchGestureThresholds {
  /** Rotation rate about the forearm axis that counts as a deliberate twist, in degrees/second. */
  twistAngularVelocityDegPerSec: number;
  /** Acceleration impulse that counts as a punch or strike, in g. */
  strikeAccelerationG: number;
  /** Rotation rate that counts as a fast flick of the wrist, in degrees/second. */
  flickAngularVelocityDegPerSec: number;
  /** Pitch above which the wrist counts as raised, in radians. */
  raisePitchRadians: number;
  /** Pitch below which a raised wrist is considered lowered again, in radians (hysteresis). */
  lowerPitchRadians: number;
  cooldownMs: number;
}

const DEGREES = Math.PI / 180;

const DEFAULT_THRESHOLDS: WatchGestureThresholds = {
  twistAngularVelocityDegPerSec: 210,
  strikeAccelerationG: 2.2,
  flickAngularVelocityDegPerSec: 320,
  raisePitchRadians: 35 * DEGREES,
  lowerPitchRadians: 20 * DEGREES,
  cooldownMs: 260,
};

export interface WatchGestures {
  /** Deliberate rotation of the forearm, the watch equivalent of turning a dial. */
  twist: boolean;
  /** Fast wrist snap, useful as a slash or cast trigger. */
  flick: boolean;
  /** Forward acceleration impulse. */
  strike: boolean;
  /** Edge-triggered when the wrist crosses into the raised zone. */
  raise: boolean;
  /** Edge-triggered when it crosses back out. */
  lower: boolean;
}

/**
 * Wrist gestures are not phone gestures. A phone is gripped and swung from the shoulder; a watch
 * pivots on the forearm, so twist about a single axis carries most of the intent and raw magnitude
 * alone produces constant false positives from ordinary arm movement. Every gesture here is
 * edge-triggered with a cooldown, and the raise/lower pair uses separate thresholds so a wrist
 * resting near the boundary cannot chatter.
 */
export class WatchGestureRecognizer {
  private readonly thresholds: WatchGestureThresholds;
  private raised = false;
  private lastTwistAt = Number.NEGATIVE_INFINITY;
  private lastFlickAt = Number.NEGATIVE_INFINITY;
  private lastStrikeAt = Number.NEGATIVE_INFINITY;

  constructor(thresholds: Partial<WatchGestureThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    if (this.thresholds.lowerPitchRadians >= this.thresholds.raisePitchRadians) {
      throw new Error("Watch raise threshold must exceed the lower threshold so the wrist cannot chatter");
    }
  }

  update(sample: WatchSample): WatchGestures {
    const now = sample.timestamp;
    const ready = (last: number) => now - last >= this.thresholds.cooldownMs;

    // Roll rate is rotation about the forearm; that axis is what a wearer controls precisely.
    const twistRate = Math.abs(sample.angularVelocity[0]);
    const totalRate = Math.hypot(...sample.angularVelocity);
    const strikeForce = Math.hypot(...sample.acceleration);

    const flick = totalRate >= this.thresholds.flickAngularVelocityDegPerSec && ready(this.lastFlickAt);
    if (flick) this.lastFlickAt = now;

    // A flick already dominates the same motion, so twist only reports when it is the intent.
    const twist = !flick && twistRate >= this.thresholds.twistAngularVelocityDegPerSec && ready(this.lastTwistAt);
    if (twist) this.lastTwistAt = now;

    const strike = strikeForce >= this.thresholds.strikeAccelerationG && ready(this.lastStrikeAt);
    if (strike) this.lastStrikeAt = now;

    const { pitch } = quaternionToAngles(sample.orientation);
    let raise = false;
    let lower = false;
    if (!this.raised && pitch >= this.thresholds.raisePitchRadians) {
      this.raised = true;
      raise = true;
    } else if (this.raised && pitch <= this.thresholds.lowerPitchRadians) {
      this.raised = false;
      lower = true;
    }

    return { twist, flick, strike, raise, lower };
  }

  get wristRaised() {
    return this.raised;
  }

  reset() {
    this.raised = false;
    this.lastTwistAt = Number.NEGATIVE_INFINITY;
    this.lastFlickAt = Number.NEGATIVE_INFINITY;
    this.lastStrikeAt = Number.NEGATIVE_INFINITY;
  }
}

/**
 * The Digital Crown and a Wear OS rotary bezel both report continuous travel that grows without
 * bound. Games want either a bounded dial position or a per-frame delta, so both are derived here
 * instead of leaving every game to reinvent it. The first sample establishes the origin rather than
 * producing a large spurious delta.
 */
export class WatchCrownTracker {
  private previous?: number;
  private position = 0;
  private readonly detentsPerTurn: number;

  constructor(detentsPerTurn = 24) {
    if (!Number.isFinite(detentsPerTurn) || detentsPerTurn <= 0) throw new Error("Crown detents per turn must be positive");
    this.detentsPerTurn = detentsPerTurn;
  }

  update(travel: number | undefined) {
    if (travel === undefined || !Number.isFinite(travel)) return { crown: this.position, crownDelta: 0 };
    if (this.previous === undefined) {
      this.previous = travel;
      return { crown: this.position, crownDelta: 0 };
    }
    const delta = (travel - this.previous) / this.detentsPerTurn;
    this.previous = travel;
    this.position = clamp(this.position + delta, -1, 1);
    return { crown: this.position, crownDelta: clamp(delta, -1, 1) };
  }

  center() {
    this.position = 0;
  }

  reset() {
    this.previous = undefined;
    this.position = 0;
  }
}

/**
 * Turns the OS-reported companion state into an honest locality claim.
 *
 * This deliberately refuses to flatten the two platforms into one optimistic answer. Watch
 * Connectivity talks to the paired iPhone, so a reachable counterpart is device-to-device. The
 * Wearable Data Layer picks its own route, so only a node the OS reports as nearby can be called
 * local; a connected-but-not-nearby node is reported as `cloud-possible`, because that is exactly
 * what it is.
 */
export function describeWatchTransport(input: {
  platform: WatchPlatform;
  companionPaired: boolean;
  appInstalled: boolean;
  reachable: boolean;
  nearby?: boolean;
}): WatchLinkStatus {
  const base = { platform: input.platform, companionPaired: input.companionPaired, appInstalled: input.appInstalled, reachable: input.reachable };

  if (!input.companionPaired) {
    return { ...base, transport: "unknown", locality: "unknown", note: "No watch is paired to this device." };
  }
  if (!input.appInstalled) {
    return { ...base, transport: "unknown", locality: "unknown", note: "101 Link is not installed on the paired watch." };
  }

  if (input.platform === "watchos") {
    if (!input.reachable) {
      return { ...base, transport: "unknown", locality: "unknown", note: "The watch app is not running, so no route is established yet." };
    }
    return {
      ...base,
      transport: "bluetooth",
      locality: "verified-local",
      note: "Watch Connectivity is exchanging interactive messages with this paired iPhone directly.",
    };
  }

  // Wear OS.
  if (!input.reachable) {
    return { ...base, transport: "unknown", locality: "unknown", nearby: input.nearby ?? false, note: "No connected Wear OS node is available yet." };
  }
  if (input.nearby === true) {
    return {
      ...base,
      transport: "bluetooth",
      locality: "verified-local",
      nearby: true,
      note: "The Wear OS node reports itself nearby, so this path is a direct device-to-device link.",
    };
  }
  return {
    ...base,
    transport: "unknown",
    locality: "cloud-possible",
    nearby: input.nearby ?? false,
    note: "The Wear OS node is connected but not reported nearby. The Data Layer may route this through Google's network, so 101 does not claim it is strictly local.",
  };
}

/** Locality strict enough for a mode that promises no data leaves the room. */
export function isStrictlyLocal(status: WatchLinkStatus) {
  return status.locality === "verified-local";
}

/**
 * Compact binary wire format for wrist samples, shared by all three implementations:
 * `apps/watch-ios/Sources/One01WatchCore/WatchPayload.swift`,
 * `apps/watch-wear/app/src/main/java/com/oneohone/wear/WatchPayload.kt`, and this decoder.
 *
 * A watch relays roughly 50 samples per second over a small-MTU Bluetooth link, so the realtime
 * path spends its bytes on values rather than repeated JSON key names. One layout across both
 * platforms means the phone decodes either watch with no per-platform branch.
 *
 * Layout (53 bytes, little-endian): magic `0x31`, version, u16 sequence, u32 milliseconds,
 * f32 quaternion x/y/z/w, f32 acceleration x/y/z (g), f32 rotation rate x/y/z (deg/s),
 * f32 crown travel, u8 buttons (bit 0 = tap).
 */
export const WATCH_PAYLOAD_BYTES = 53;
export const WATCH_PAYLOAD_MAGIC = 0x31;
export const WATCH_PAYLOAD_VERSION = 1;

/** Returns undefined for a short, misaligned, foreign or non-finite packet rather than throwing. */
export function decodeWatchPayload(bytes: Uint8Array): WatchSample | undefined {
  if (bytes.byteLength !== WATCH_PAYLOAD_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== WATCH_PAYLOAD_MAGIC || view.getUint8(1) !== WATCH_PAYLOAD_VERSION) return undefined;

  const readFloat = (offset: number) => view.getFloat32(offset, true);
  const orientation = [readFloat(8), readFloat(12), readFloat(16), readFloat(20)] as const;
  const acceleration = [readFloat(24), readFloat(28), readFloat(32)] as const;
  const angularVelocity = [readFloat(36), readFloat(40), readFloat(44)] as const;
  const crown = readFloat(48);

  // A non-finite value would poison the motion pipeline downstream.
  for (const value of [...orientation, ...acceleration, ...angularVelocity, crown]) {
    if (!Number.isFinite(value)) return undefined;
  }

  return {
    timestamp: view.getUint32(4, true),
    orientation: orientation as unknown as Quaternion,
    acceleration: acceleration as unknown as Vector3,
    angularVelocity: angularVelocity as unknown as Vector3,
    crown,
    tap: (view.getUint8(52) & 0x01) === 0x01,
  };
}

export interface WatchInputAdapterOptions {
  playerId?: string;
  deviceId?: string;
  platform: WatchPlatform;
  calibration?: MotionCalibration;
  thresholds?: Partial<WatchGestureThresholds>;
  detentsPerTurn?: number;
  /** Called whenever the reported companion route changes. */
  onStatus?(status: WatchLinkStatus): void;
}

/**
 * Publishes wrist input as ordinary 101 frames.
 *
 * Actions: `watch.twist`, `watch.flick`, `watch.strike`, `watch.raise`, `watch.lower`,
 * `watch.tap`, and the level-valued `watch.raised`.
 * Axes: `wristRoll`, `wristPitch`, `wristYaw`, `crown`, `crownDelta`.
 * Vector: `wrist` carries roll/pitch/yaw together for aiming-style bindings.
 */
export class WatchInputAdapter implements InputAdapter {
  readonly id: string;
  readonly source = "watch-motion" as const;
  private readonly playerId: string;
  private readonly pipeline: MotionPipeline;
  private readonly gestures: WatchGestureRecognizer;
  private readonly crown: WatchCrownTracker;
  private readonly onStatus?: (status: WatchLinkStatus) => void;
  private status: WatchLinkStatus;
  private emit?: InputFrameListener;
  private sequence = 0;
  private active = false;

  constructor(options: WatchInputAdapterOptions) {
    this.id = options.deviceId ?? `watch-${options.platform}`;
    this.playerId = options.playerId ?? "player-1";
    this.pipeline = new MotionPipeline(options.calibration ?? DEFAULT_CALIBRATION);
    this.gestures = new WatchGestureRecognizer(options.thresholds);
    this.crown = new WatchCrownTracker(options.detentsPerTurn);
    this.onStatus = options.onStatus;
    this.status = describeWatchTransport({ platform: options.platform, companionPaired: false, appInstalled: false, reachable: false });
  }

  start(emit: InputFrameListener) {
    this.emit = emit;
    this.active = true;
  }

  stop() {
    this.active = false;
    // A watch that stops relaying must not leave a held control applied, exactly as a dropped
    // HID, Bluetooth or Serial device must not.
    this.emit?.(this.releaseFrame());
    this.emit = undefined;
    this.pipeline.reset();
    this.gestures.reset();
    this.crown.reset();
  }

  get linkStatus() {
    return this.status;
  }

  /** Report the OS-level companion state; locality is derived, never asserted by the caller. */
  updateLink(input: { companionPaired: boolean; appInstalled: boolean; reachable: boolean; nearby?: boolean }) {
    const next = describeWatchTransport({ platform: this.status.platform, ...input });
    const changed = next.locality !== this.status.locality || next.reachable !== this.status.reachable || next.transport !== this.status.transport;
    this.status = next;
    if (changed) {
      this.onStatus?.(next);
      // Losing the route is a disconnect; release rather than freeze the last wrist pose.
      if (!next.reachable && this.active) this.emit?.(this.releaseFrame());
    }
    return next;
  }

  /** Feed one relayed sample. Returns the emitted frame so callers can test without a transport. */
  push(sample: WatchSample): InputFrame | undefined {
    if (!this.active) return undefined;
    const processed = this.pipeline.process({
      timestamp: sample.timestamp,
      orientation: sample.orientation,
      acceleration: sample.acceleration,
      angularVelocity: sample.angularVelocity,
    });
    const gestures = this.gestures.update({ ...sample, orientation: processed.orientation, acceleration: processed.acceleration, angularVelocity: processed.angularVelocity });
    const { crown, crownDelta } = this.crown.update(sample.crown);
    // Angles arrive in radians. Each is divided by its own natural range so every axis genuinely
    // spans [-1, 1]: asin-derived pitch covers +/-PI/2, while atan2-derived roll and yaw cover +/-PI.
    const angles = quaternionToAngles(processed.orientation);
    const roll = clamp(angles.roll / Math.PI, -1, 1);
    const pitch = clamp(angles.pitch / (Math.PI / 2), -1, 1);
    const yaw = clamp(angles.yaw / Math.PI, -1, 1);

    const frame: InputFrame = {
      deviceId: this.id,
      playerId: this.playerId,
      source: this.source,
      sequence: ++this.sequence,
      timestamp: sample.timestamp,
      actions: {
        "watch.twist": gestures.twist,
        "watch.flick": gestures.flick,
        "watch.strike": gestures.strike,
        "watch.raise": gestures.raise,
        "watch.lower": gestures.lower,
        "watch.raised": this.gestures.wristRaised,
        "watch.tap": Boolean(sample.tap),
      },
      axes: { wristRoll: roll, wristPitch: pitch, wristYaw: yaw, crown, crownDelta },
      vectors: { wrist: { x: roll, y: pitch, z: yaw } },
    };
    this.emit?.(frame);
    return frame;
  }

  calibrateNeutral(orientation: Quaternion) {
    this.pipeline.calibrateNeutral(orientation);
    this.gestures.reset();
    this.crown.center();
  }

  private releaseFrame(): InputFrame {
    return {
      deviceId: this.id,
      playerId: this.playerId,
      source: this.source,
      sequence: ++this.sequence,
      timestamp: 0,
      actions: {},
      axes: {},
      vectors: {},
    };
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
