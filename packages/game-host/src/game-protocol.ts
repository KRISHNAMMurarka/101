// Game wire compatibility extracted from packages/protocol at 301b0d3f.
import { PROTOCOL_VERSION, ProtocolVersionError, acceptProtocolVersion, CAPABILITY_NAMES, parseControllerLayout, type DeviceCapabilities, type ControllerLayout } from "@uynis-connect/connect";
export { PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION, ProtocolVersionError, acceptProtocolVersion, negotiateProtocolVersion, CAPABILITY_NAMES, parseControllerLayout } from "@uynis-connect/connect";
export type { DeviceCapabilities, ControllerLayout, ControllerElement, ControllerPlacementHints, ControllerInteraction } from "@uynis-connect/connect";
import { INPUT_SOURCES, type InputFrame } from "@101/input";
export const INPUT_Q1_FORMAT = "input-q1" as const;
export const INPUT_Q1_BYTES = 24 as const;
export type InputFormat = typeof INPUT_Q1_FORMAT;

export interface LinkFeatures {
  inputFormats?: readonly InputFormat[];
  /** Browser audio begins locked until a player gesture resumes it. */
  speakerAudio?: "locked" | "ready";
}

export type HapticMessage = {
  type: "haptic";
  deviceId: string;
  pattern: "tap" | "impact" | "warning";
};

export type SpeakerCueMessage = {
  type: "speaker.cue";
  deviceId: string;
  sequence: number;
  cue: "pulse-v1";
  /** Playback-rate multiplier. The cue is intentionally tiny and synthesized locally. */
  pitch: number;
  volume: number;
};

export type ControlMessage =
  | {
      type: "hello";
      /** The version both peers agreed on, which is not necessarily this build's own. */
      version: number;
      deviceId: string;
      device: string;
      capabilities: DeviceCapabilities;
      features?: LinkFeatures;
    }
  | {
      type: "player.assign";
      deviceId: string;
      playerId: string;
      role: string;
      gameId: string;
    }
  | {
      type: "player.wait";
      deviceId: string;
      gameId: string;
      reason: "no-open-role";
    }
  | {
      type: "controller.configure";
      deviceId: string;
      gameId: string;
      role: string;
      revision: number;
      layout: ControllerLayout;
      inputFormat?: InputFormat;
    }
  | {
      type: "controller.state";
      deviceId: string;
      values: Record<string, string | number | boolean>;
      message?: string;
      tone?: "normal" | "warning" | "critical";
    }
  | { type: "calibration.request"; mode: string }
  // Kept parseable on the control channel so a newly updated controller remains compatible with
  // an older host. Current hosts send this disposable feedback over realtime instead.
  | HapticMessage
  | { type: "pause"; paused: boolean }
  | { type: "ping"; sentAt: number; deviceId?: string }
  | { type: "pong"; sentAt: number; receivedAt: number };

export function parseControlMessage(input: unknown): ControlMessage {
  if (!isRecord(input) || typeof input.type !== "string") throw new Error("Malformed 101 control message");
  if (input.type === "hello") {
    if (!isRecord(input.capabilities)) throw new Error("Malformed 101 hello");
    if (typeof input.version !== "number") throw new Error("Malformed 101 hello");
    if (!acceptProtocolVersion(input.version)) throw new ProtocolVersionError(input.version, "controller");
    const version = input.version;
    return {
      type: "hello",
      version,
      deviceId: requiredText(input.deviceId, "deviceId", 128),
      device: requiredText(input.device, "device", 128),
      capabilities: parseCapabilities(input.capabilities),
      ...(input.features === undefined ? {} : { features: parseLinkFeatures(input.features) }),
    };
  }
  if (input.type === "player.assign") return {
    type: "player.assign",
    deviceId: requiredText(input.deviceId, "deviceId", 128),
    playerId: requiredText(input.playerId, "playerId", 128),
    role: requiredText(input.role, "role", 64),
    gameId: requiredText(input.gameId, "gameId", 128),
  };
  if (input.type === "player.wait") {
    if (input.reason !== "no-open-role") throw new Error("Invalid controller wait reason");
    return {
      type: "player.wait",
      deviceId: requiredText(input.deviceId, "deviceId", 128),
      gameId: requiredText(input.gameId, "gameId", 128),
      reason: input.reason,
    };
  }
  if (input.type === "controller.configure") {
    if (!Number.isInteger(input.revision) || Number(input.revision) < 0) throw new Error("Invalid controller revision");
    return {
      type: "controller.configure",
      deviceId: requiredText(input.deviceId, "deviceId", 128),
      gameId: requiredText(input.gameId, "gameId", 128),
      role: requiredText(input.role, "role", 64),
      revision: Number(input.revision),
      layout: parseControllerLayout(input.layout),
      ...(input.inputFormat === undefined ? {} : { inputFormat: parseInputFormat(input.inputFormat) }),
    };
  }
  if (input.type === "controller.state") {
    if (!isRecord(input.values) || Object.keys(input.values).length > 32) throw new Error("Invalid controller state");
    const values: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(input.values)) {
      if (!isActionName(name) || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") || (typeof value === "number" && !Number.isFinite(value))) {
        throw new Error("Invalid controller state value");
      }
      values[name] = value;
    }
    const tone = input.tone;
    if (tone !== undefined && tone !== "normal" && tone !== "warning" && tone !== "critical") throw new Error("Invalid controller state tone");
    return {
      type: "controller.state",
      deviceId: requiredText(input.deviceId, "deviceId", 128),
      values,
      ...(input.message === undefined ? {} : { message: requiredText(input.message, "message", 160) }),
      ...(tone ? { tone } : {}),
    };
  }
  if (input.type === "calibration.request") return { type: "calibration.request", mode: requiredText(input.mode, "mode", 64) };
  if (input.type === "haptic") {
    if (input.pattern !== "tap" && input.pattern !== "impact" && input.pattern !== "warning") throw new Error("Invalid haptic pattern");
    return { type: "haptic", deviceId: requiredText(input.deviceId, "deviceId", 128), pattern: input.pattern };
  }
  if (input.type === "pause") {
    if (typeof input.paused !== "boolean") throw new Error("Invalid pause message");
    return { type: "pause", paused: input.paused };
  }
  if (input.type === "ping") {
    // `deviceId` is optional so a client predating it still parses; the host then simply cannot
    // refresh that device's liveness from a ping alone.
    const deviceId = optionalText(input.deviceId, "deviceId", 128);
    return { type: "ping", sentAt: requiredFinite(input.sentAt, "sentAt"), ...(deviceId ? { deviceId } : {}) };
  }
  if (input.type === "pong") return { type: "pong", sentAt: requiredFinite(input.sentAt, "sentAt"), receivedAt: requiredFinite(input.receivedAt, "receivedAt") };
  throw new Error("Unsupported 101 control message");
}

export type RealtimeMessage = InputFrame | HapticMessage | SpeakerCueMessage;

export type LinkMessage =
  | { channel: "control"; payload: ControlMessage }
  | { channel: "realtime"; payload: RealtimeMessage };

export interface LinkTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendReliable(message: ControlMessage): void;
  sendRealtime(message: RealtimeMessage): void;
  onMessage(callback: (message: LinkMessage) => void): () => void;
  onDeviceLost?(callback: (deviceId: string) => void): () => void;
}

export type LinkState = "idle" | "connecting" | "connected" | "disconnected" | "failed";

export interface StatefulLinkTransport extends LinkTransport {
  readonly state: LinkState;
  onStateChange(callback: (state: LinkState) => void): () => void;
}

export function serializeControlMessage(message: ControlMessage): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, message });
}

export function deserializeControlMessage(data: string): ControlMessage {
  const packet = JSON.parse(data) as {
    version?: number;
    message?: unknown;
  };
  if (typeof packet.version !== "number") throw new Error("Malformed 101 control packet");
  // The envelope negotiates for the same reason the handshake does: this build has to be able to
  // read a packet written by a peer one version behind it, or every update is a flag day.
  if (!acceptProtocolVersion(packet.version)) throw new ProtocolVersionError(packet.version, "device");
  return parseControlMessage(packet.message);
}

export type InputPacketLane =
  | { kind: "digital-action"; name: string }
  | { kind: "analog-action"; name: string }
  | { kind: "axis"; name: string }
  | { kind: "vector"; name: string; component: "x" | "y" };

export interface InputPacketProfile {
  readonly format: typeof INPUT_Q1_FORMAT;
  readonly revision: number;
  readonly deviceId: string;
  readonly playerId: string;
  readonly lanes: readonly InputPacketLane[];
}

export interface InputPacketProfileIdentity {
  revision: number;
  deviceId: string;
  playerId: string;
}

/**
 * Builds the deterministic twelve-lane map shared by a configured controller and its host.
 *
 * A layout that needs more lanes, or reuses one name with incompatible value shapes, returns
 * `undefined`. That is an intentional JSON fallback: losing a control to make a packet fit would be
 * a worse compatibility failure than sending the larger representation.
 */
export function createInputPacketProfile(
  layout: ControllerLayout,
  identity: InputPacketProfileIdentity,
): InputPacketProfile | undefined {
  if (!Number.isInteger(identity.revision) || identity.revision < 0 || identity.revision > 0xffff) return undefined;
  if (!identity.deviceId || !identity.playerId) return undefined;

  const lanes: InputPacketLane[] = [];
  const shapes = new Map<string, "digital" | "analog" | "axis" | "vector">();
  const axisOwners = new Map<string, string>();
  const claimAxis = (name: string, owner: string) => {
    const existing = axisOwners.get(name);
    if (existing && existing !== owner) return false;
    axisOwners.set(name, owner);
    return true;
  };
  const add = (name: string, shape: "digital" | "analog" | "axis" | "vector") => {
    const existing = shapes.get(name);
    if (existing) return existing === shape;
    const owner = `${shape}:${name}`;
    if (shape === "axis" && !claimAxis(name, owner)) return false;
    if (shape === "vector") {
      for (const alias of new Set([name, `${name}X`, `${name}Y`])) {
        if (!claimAxis(alias, owner)) return false;
      }
    }
    shapes.set(name, shape);
    if (shape === "digital") lanes.push({ kind: "digital-action", name });
    else if (shape === "analog") lanes.push({ kind: "analog-action", name });
    else if (shape === "axis") lanes.push({ kind: "axis", name });
    else lanes.push(
      { kind: "vector", name, component: "x" },
      { kind: "vector", name, component: "y" },
    );
    return lanes.length <= 12;
  };

  for (const element of layout.layout) {
    if (element.type === "button" || element.type === "shoulder") {
      if (!add(element.action, "digital")) return undefined;
      if (element.interaction?.type === "chord") {
        for (const action of element.interaction.actions) if (!add(action, "digital")) return undefined;
      }
    } else if (element.type === "trigger" || element.type === "analog-button") {
      if (!add(element.action, "analog")) return undefined;
    } else if (element.type === "slider") {
      if (!add(element.action, "axis")) return undefined;
    } else {
      if (!add(element.action, "vector")) return undefined;
      if (element.type === "touch-surface" && element.pressAction && !add(element.pressAction, "digital")) return undefined;
    }
  }
  if (layout.motion) {
    if (!add(layout.motion.action, "vector")) return undefined;
    for (const action of Object.values(layout.motion.gestures ?? {})) {
      if (action && !add(action, "digital")) return undefined;
    }
  }
  if (lanes.length === 0 || lanes.length > 12) return undefined;
  return {
    format: INPUT_Q1_FORMAT,
    revision: identity.revision,
    deviceId: identity.deviceId,
    playerId: identity.playerId,
    lanes,
  };
}

/** Encodes bandwidth-oriented, layout-derived input. It does not claim to reduce input latency. */
export function encodeInputPacket(frame: InputFrame, profile: InputPacketProfile): Uint8Array {
  if (!canEncodeInputPacket(frame, profile)) throw new Error("Input frame requires JSON fallback");
  return encodeRepresentableInputPacket(frame, profile);
}

function encodeRepresentableInputPacket(frame: InputFrame, profile: InputPacketProfile) {
  const sourceIndex = INPUT_SOURCES.indexOf(frame.source);
  if (sourceIndex < 0 || sourceIndex > 0x0f) throw new Error("Unsupported input packet source");
  const bytes = new Uint8Array(INPUT_Q1_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, (sourceIndex << 4) | 2);
  view.setUint16(2, profile.revision, true);
  view.setUint32(4, Math.max(0, Math.trunc(frame.sequence)) >>> 0, true);
  view.setUint32(8, Math.trunc(Number.isFinite(frame.timestamp) ? frame.timestamp : 0) >>> 0, true);
  profile.lanes.forEach((lane, index) => {
    const offset = 12 + index;
    if (lane.kind === "digital-action") {
      view.setUint8(offset, frame.actions[lane.name] ? 1 : 0);
    } else if (lane.kind === "analog-action") {
      view.setUint8(offset, Math.round(clampPacketNumber(Number(frame.actions[lane.name] ?? 0), 0, 1) * 255));
    } else if (lane.kind === "axis") {
      view.setInt8(offset, Math.round(clampPacketNumber(frame.axes?.[lane.name] ?? 0, -1, 1) * 127));
    } else {
      view.setInt8(offset, Math.round(clampPacketNumber(frame.vectors?.[lane.name]?.[lane.component] ?? 0, -1, 1) * 127));
    }
  });
  return bytes;
}

export function decodeInputPacket(bytes: Uint8Array, profile: InputPacketProfile): InputFrame {
  if (bytes.byteLength !== INPUT_Q1_BYTES) throw new Error(`Expected ${INPUT_Q1_BYTES} input bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION) throw new ProtocolVersionError(view.getUint8(0), "input controller");
  if ((view.getUint8(1) & 0x0f) !== 2) {
    throw new Error("Unsupported 101 input packet");
  }
  if (view.getUint16(2, true) !== profile.revision) throw new Error("Stale input packet revision");
  const source = INPUT_SOURCES[view.getUint8(1) >> 4];
  if (!source) throw new Error("Invalid input packet source");
  const actions: InputFrame["actions"] = {};
  const axes: NonNullable<InputFrame["axes"]> = {};
  const vectors: NonNullable<InputFrame["vectors"]> = {};
  profile.lanes.forEach((lane, index) => {
    const offset = 12 + index;
    if (lane.kind === "digital-action") {
      const value = view.getUint8(offset);
      if (value > 1) throw new Error("Invalid digital input lane");
      actions[lane.name] = value === 1;
    } else if (lane.kind === "analog-action") {
      actions[lane.name] = view.getUint8(offset) / 255;
    } else {
      const value = view.getInt8(offset);
      if (value === -128) throw new Error("Invalid signed input lane");
      const normalized = value / 127;
      if (lane.kind === "axis") axes[lane.name] = normalized;
      else {
        const vector = vectors[lane.name] ?? { x: 0, y: 0 };
        vector[lane.component] = normalized;
        vectors[lane.name] = vector;
      }
    }
  });
  for (const [name, vector] of Object.entries(vectors)) addVectorAxes(axes, name, vector);
  return {
    deviceId: profile.deviceId,
    playerId: profile.playerId,
    sequence: view.getUint32(4, true),
    timestamp: view.getUint32(8, true),
    source,
    actions,
    ...(Object.keys(axes).length ? { axes } : {}),
    ...(Object.keys(vectors).length ? { vectors } : {}),
  };
}

export function serializeRealtimeMessage(
  message: RealtimeMessage,
  profile?: InputPacketProfile,
): string | Uint8Array {
  if (profile && !("type" in message) && canEncodeInputPacket(message, profile)) {
    return encodeRepresentableInputPacket(message, profile);
  }
  return JSON.stringify(message);
}

export function deserializeRealtimeMessage(
  data: string | ArrayBuffer | ArrayBufferView,
  profile?: InputPacketProfile,
): RealtimeMessage {
  if (typeof data === "string") {
    const candidate = JSON.parse(data) as unknown;
    if (isRecord(candidate) && candidate.type === "speaker.cue") return parseSpeakerCue(candidate);
    if (isRecord(candidate) && candidate.type === "haptic") {
      const parsed = parseControlMessage(candidate);
      if (parsed.type === "haptic") return parsed;
    }
    return candidate as InputFrame;
  }
  if (!profile) throw new Error("Binary input arrived before format negotiation");
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return decodeInputPacket(bytes, profile);
}

function addVectorAxes(axes: Record<string, number>, name: string, vector: { x: number; y: number }) {
  axes[name] = vector.x;
  axes[`${name}X`] = vector.x;
  axes[`${name}Y`] = vector.y;
  if (name === "move") {
    axes.moveX = vector.x;
    axes.moveY = vector.y;
  }
  if (name === "steer") axes.steer = vector.x;
}

function canEncodeInputPacket(frame: InputFrame, profile: InputPacketProfile) {
  // Identity is deliberately supplied by the authenticated assignment/profile rather than trusted
  // from every frame. Only the layout-derived values need to be representable here.
  if (frame.poses && Object.keys(frame.poses).length > 0) return false;
  // A source this build has never heard of has no 4-bit index, so the packet cannot carry it. That
  // is a reason to fall back to JSON, not to throw: `sendRealtime` does not catch, so a controller
  // built against a longer INPUT_SOURCES would take the whole link down instead of degrading.
  const sourceIndex = INPUT_SOURCES.indexOf(frame.source);
  if (sourceIndex < 0 || sourceIndex > 0x0f) return false;

  const actionNames = new Set<string>();
  const axisNames = new Set<string>();
  const vectorNames = new Set<string>();
  const derivedAxes = new Map<string, { vector: string; component: "x" | "y" }>();
  for (const lane of profile.lanes) {
    if (lane.kind === "digital-action" || lane.kind === "analog-action") actionNames.add(lane.name);
    else if (lane.kind === "axis") axisNames.add(lane.name);
    else {
      vectorNames.add(lane.name);
      derivedAxes.set(lane.name, { vector: lane.name, component: "x" });
      derivedAxes.set(`${lane.name}X`, { vector: lane.name, component: "x" });
      derivedAxes.set(`${lane.name}Y`, { vector: lane.name, component: "y" });
    }
  }
  if (Object.keys(frame.actions).some((name) => !actionNames.has(name))) return false;
  if (Object.entries(frame.vectors ?? {}).some(([name, vector]) => (
    !vectorNames.has(name) || vector.z !== undefined
  ))) return false;
  for (const [name, value] of Object.entries(frame.axes ?? {})) {
    if (axisNames.has(name)) continue;
    const derived = derivedAxes.get(name);
    const vector = derived ? frame.vectors?.[derived.vector] : undefined;
    if (!derived || !vector || value !== vector[derived.component]) return false;
  }
  return true;
}

function clampPacketNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/.test(value);
}


function optionalText(value: unknown, name: string, maxLength: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid controller ${name}`);
  }
  return value;
}

function requiredText(value: unknown, name: string, maxLength: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new Error(`Invalid ${name}`);
  return value;
}

function requiredFinite(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${name}`);
  return value;
}

function parseInputFormat(value: unknown): InputFormat {
  if (value !== INPUT_Q1_FORMAT) throw new Error("Unsupported controller input format");
  return value;
}

function parseLinkFeatures(input: unknown): LinkFeatures {
  if (!isRecord(input)) throw new Error("Invalid 101 Link features");
  let inputFormats: InputFormat[] | undefined;
  if (input.inputFormats !== undefined) {
    if (!Array.isArray(input.inputFormats) || input.inputFormats.length > 8) {
      throw new Error("Invalid controller input formats");
    }
    inputFormats = [];
    for (const format of input.inputFormats) {
      if (typeof format !== "string" || format.length === 0 || format.length > 64) {
        throw new Error("Invalid controller input format");
      }
      if (format === INPUT_Q1_FORMAT) {
        if (inputFormats.includes(format)) throw new Error("Duplicate controller input format");
        inputFormats.push(format);
      }
    }
  }
  if (input.speakerAudio !== undefined && typeof input.speakerAudio !== "string") {
    throw new Error("Invalid controller speaker audio state");
  }
  const speakerAudio = input.speakerAudio === "locked" || input.speakerAudio === "ready"
    ? input.speakerAudio
    : undefined;
  return {
    ...(inputFormats ? { inputFormats } : {}),
    ...(speakerAudio ? { speakerAudio } : {}),
  };
}

function parseSpeakerCue(input: Record<string, unknown>): SpeakerCueMessage {
  rejectUnknownProperties(input, ["type", "deviceId", "sequence", "cue", "pitch", "volume"], "speaker cue");
  if (input.cue !== "pulse-v1") throw new Error("Unsupported controller speaker cue");
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 0) throw new Error("Invalid speaker cue sequence");
  const pitch = requiredFinite(input.pitch, "speaker cue pitch");
  const volume = requiredFinite(input.volume, "speaker cue volume");
  if (pitch < .5 || pitch > 2) throw new Error("Invalid speaker cue pitch");
  if (volume < 0 || volume > 1) throw new Error("Invalid speaker cue volume");
  return {
    type: "speaker.cue",
    deviceId: requiredText(input.deviceId, "deviceId", 128),
    sequence: Number(input.sequence),
    cue: "pulse-v1",
    pitch,
    volume,
  };
}

function parseCapabilities(input: Record<string, unknown>): DeviceCapabilities {
  const capabilities: DeviceCapabilities = {};
  for (const name of CAPABILITY_NAMES) {
    const value = input[name];
    if (value !== undefined && typeof value !== "boolean") throw new Error(`Invalid capability: ${name}`);
    if (value !== undefined) capabilities[name] = value;
  }
  return capabilities;
}

/**
 * Where a control belongs on the hand, as a sort key.
 *
 * A zone outranks priority: a shoulder sits above the thumbs whatever its priority, and an unzoned
 * control ranks with an edge control so that adding a zone to one element never reshuffles the ones
 * around it.
 */

export { createControllerPairingUrl, decodePairingTicket, encodePairingTicket, decodeMotionPacket, encodeMotionPacket } from '@uynis-connect/connect';

function rejectUnknownProperties(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const allowedNames = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedNames.has(key));
  if (unknown) throw new Error(`Unsupported ${name} property ${unknown}`);
}

