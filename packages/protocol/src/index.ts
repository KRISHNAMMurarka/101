import type { InputFrame } from "@101/input";

export const PROTOCOL_VERSION = 2 as const;

export interface DeviceCapabilities {
  touch?: boolean;
  accelerometer?: boolean;
  gyroscope?: boolean;
  magnetometer?: boolean;
  camera?: boolean;
  microphone?: boolean;
  haptics?: boolean;
  gamepad?: boolean;
}

export type ControlMessage =
  | {
      type: "hello";
      version: typeof PROTOCOL_VERSION;
      deviceId: string;
      device: string;
      capabilities: DeviceCapabilities;
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
    }
  | {
      type: "controller.state";
      deviceId: string;
      values: Record<string, string | number | boolean>;
      message?: string;
      tone?: "normal" | "warning" | "critical";
    }
  | { type: "calibration.request"; mode: string }
  | { type: "haptic"; deviceId: string; pattern: "tap" | "impact" | "warning" }
  | { type: "pause"; paused: boolean }
  | { type: "ping"; sentAt: number }
  | { type: "pong"; sentAt: number; receivedAt: number };

export type ControllerElement =
  | { type: "joystick"; action: string; label?: string }
  | { type: "dpad"; action: string; label?: string }
  | {
      type: "button";
      action: string;
      label: string;
      emphasis?: "normal" | "primary" | "danger";
    }
  | { type: "touch-surface"; action: string; label?: string }
  | {
      type: "slider";
      action: string;
      label: string;
      min?: number;
      max?: number;
      step?: number;
    };

export interface ControllerLayout {
  title?: string;
  accent?: string;
  motion?: {
    action: string;
    mode: "tilt" | "wand";
    label?: string;
    gestures?: Partial<Record<"shake" | "swing" | "spin", string>>;
  };
  layout: readonly ControllerElement[];
}

export function parseControllerLayout(input: unknown): ControllerLayout {
  if (!isRecord(input) || !Array.isArray(input.layout) || input.layout.length === 0 || input.layout.length > 16) {
    throw new Error("Controller layout requires between 1 and 16 elements");
  }
  const layout = input.layout.map((value, index): ControllerElement => {
    if (!isRecord(value) || !isActionName(value.action) || typeof value.type !== "string") {
      throw new Error(`Invalid controller element at index ${index}`);
    }
    const label = optionalLabel(value.label, index);
    if (value.type === "joystick" || value.type === "dpad" || value.type === "touch-surface") {
      return { type: value.type, action: value.action, ...(label ? { label } : {}) };
    }
    if (value.type === "button") {
      if (!label) throw new Error(`Button at index ${index} requires a label`);
      const emphasis = value.emphasis;
      if (emphasis !== undefined && emphasis !== "normal" && emphasis !== "primary" && emphasis !== "danger") {
        throw new Error(`Invalid button emphasis at index ${index}`);
      }
      return { type: "button", action: value.action, label, ...(emphasis ? { emphasis } : {}) };
    }
    if (value.type === "slider") {
      if (!label) throw new Error(`Slider at index ${index} requires a label`);
      const min = finiteNumber(value.min, -1);
      const max = finiteNumber(value.max, 1);
      const step = finiteNumber(value.step, .01);
      if (min < -1 || max > 1 || min >= max || step <= 0 || step > max - min) {
        throw new Error(`Invalid slider range at index ${index}`);
      }
      return { type: "slider", action: value.action, label, min, max, step };
    }
    throw new Error(`Unsupported controller element type at index ${index}`);
  });
  const title = optionalText(input.title, "title", 64);
  const accent = input.accent === undefined ? undefined : typeof input.accent === "string" && /^#[0-9a-f]{6}$/i.test(input.accent) ? input.accent : (() => { throw new Error("Controller accent must be a six-digit hex color"); })();
  let motion: ControllerLayout["motion"];
  if (input.motion !== undefined) {
    if (!isRecord(input.motion) || !isActionName(input.motion.action) || (input.motion.mode !== "tilt" && input.motion.mode !== "wand")) {
      throw new Error("Invalid controller motion mapping");
    }
    const motionLabel = optionalText(input.motion.label, "motion label", 64);
    let gestures: Partial<Record<"shake" | "swing" | "spin", string>> | undefined;
    if (input.motion.gestures !== undefined) {
      if (!isRecord(input.motion.gestures)) throw new Error("Invalid controller gesture mappings");
      gestures = {};
      for (const name of ["shake", "swing", "spin"] as const) {
        const action = input.motion.gestures[name];
        if (action !== undefined && !isActionName(action)) throw new Error(`Invalid ${name} gesture action`);
        if (typeof action === "string") gestures[name] = action;
      }
    }
    motion = { action: input.motion.action, mode: input.motion.mode, ...(motionLabel ? { label: motionLabel } : {}), ...(gestures ? { gestures } : {}) };
  }
  return { ...(title ? { title } : {}), ...(accent ? { accent } : {}), ...(motion ? { motion } : {}), layout };
}

export function parseControlMessage(input: unknown): ControlMessage {
  if (!isRecord(input) || typeof input.type !== "string") throw new Error("Malformed 101 control message");
  if (input.type === "hello") {
    if (input.version !== PROTOCOL_VERSION || !isRecord(input.capabilities)) throw new Error("Unsupported 101 hello");
    return {
      type: "hello",
      version: PROTOCOL_VERSION,
      deviceId: requiredText(input.deviceId, "deviceId", 128),
      device: requiredText(input.device, "device", 128),
      capabilities: parseCapabilities(input.capabilities),
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
  if (input.type === "ping") return { type: "ping", sentAt: requiredFinite(input.sentAt, "sentAt") };
  if (input.type === "pong") return { type: "pong", sentAt: requiredFinite(input.sentAt, "sentAt"), receivedAt: requiredFinite(input.receivedAt, "receivedAt") };
  throw new Error("Unsupported 101 control message");
}

export type LinkMessage =
  | { channel: "control"; payload: ControlMessage }
  | { channel: "realtime"; payload: InputFrame };

export interface LinkTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendReliable(message: ControlMessage): void;
  sendRealtime(frame: InputFrame): void;
  onMessage(callback: (message: LinkMessage) => void): () => void;
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
  if (packet.version !== PROTOCOL_VERSION) {
    throw new Error("Unsupported or malformed 101 control packet");
  }
  return parseControlMessage(packet.message);
}

export interface MotionPacket {
  sequence: number;
  timestamp: number;
  quaternion: readonly [number, number, number, number];
  acceleration: readonly [number, number, number];
  buttons: number;
}

const MOTION_PACKET_BYTES = 48;

export function encodeMotionPacket(packet: MotionPacket): Uint8Array {
  const buffer = new ArrayBuffer(MOTION_PACKET_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, 1);
  view.setUint32(4, packet.sequence, true);
  view.setFloat64(8, packet.timestamp, true);
  packet.quaternion.forEach((value, index) =>
    view.setFloat32(16 + index * 4, value, true),
  );
  packet.acceleration.forEach((value, index) =>
    view.setFloat32(32 + index * 4, value, true),
  );
  view.setUint32(44, packet.buttons, true);
  return new Uint8Array(buffer);
}

export function decodeMotionPacket(bytes: Uint8Array): MotionPacket {
  if (bytes.byteLength !== MOTION_PACKET_BYTES) {
    throw new Error(`Expected ${MOTION_PACKET_BYTES} motion bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== 1) {
    throw new Error("Unsupported 101 realtime packet");
  }
  return {
    sequence: view.getUint32(4, true),
    timestamp: view.getFloat64(8, true),
    quaternion: [0, 1, 2, 3].map((index) =>
      view.getFloat32(16 + index * 4, true),
    ) as [number, number, number, number],
    acceleration: [0, 1, 2].map((index) =>
      view.getFloat32(32 + index * 4, true),
    ) as [number, number, number],
    buttons: view.getUint32(44, true),
  };
}

export class BroadcastChannelTransport implements LinkTransport {
  private channel?: BroadcastChannel;
  private readonly listeners = new Set<(message: LinkMessage) => void>();
  private readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async connect() {
    if (typeof BroadcastChannel === "undefined") {
      throw new Error("BroadcastChannel is unavailable in this browser");
    }
    this.channel = new BroadcastChannel(`101-link-v${PROTOCOL_VERSION}-${this.sessionId}`);
    this.channel.onmessage = (event: MessageEvent<LinkMessage>) => {
      this.listeners.forEach((listener) => listener(event.data));
    };
  }

  async disconnect() {
    this.channel?.close();
    this.channel = undefined;
  }

  sendReliable(message: ControlMessage) {
    this.channel?.postMessage({ channel: "control", payload: message } satisfies LinkMessage);
  }

  sendRealtime(frame: InputFrame) {
    this.channel?.postMessage({ channel: "realtime", payload: frame } satisfies LinkMessage);
  }

  onMessage(callback: (message: LinkMessage) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}

export interface WebRTCTransportOptions {
  initiator: boolean;
  iceServers?: RTCIceServer[];
  realtimeBufferLimit?: number;
}

export class WebRTCTransport implements StatefulLinkTransport {
  private peer?: RTCPeerConnection;
  private control?: RTCDataChannel;
  private realtime?: RTCDataChannel;
  private readonly listeners = new Set<(message: LinkMessage) => void>();
  private readonly stateListeners = new Set<(state: LinkState) => void>();
  private readonly options: WebRTCTransportOptions;
  private currentState: LinkState = "idle";

  constructor(options: WebRTCTransportOptions) {
    this.options = options;
  }

  get state() {
    return this.currentState;
  }

  async connect() {
    if (this.peer) return;
    if (typeof RTCPeerConnection === "undefined") {
      throw new Error("WebRTC DataChannel is unavailable in this browser");
    }

    this.setState("connecting");
    this.peer = new RTCPeerConnection({
      iceServers: this.options.iceServers ?? [],
    });
    this.peer.onconnectionstatechange = () => {
      const state = this.peer?.connectionState;
      if (state === "connected") this.setState("connected");
      else if (state === "failed") this.setState("failed");
      else if (state === "disconnected" || state === "closed") this.setState("disconnected");
    };
    this.peer.ondatachannel = (event) => {
      if (event.channel.label === "101-control") this.attachControl(event.channel);
      if (event.channel.label === "101-realtime") this.attachRealtime(event.channel);
    };

    if (this.options.initiator) {
      this.attachControl(this.peer.createDataChannel("101-control", { ordered: true }));
      this.attachRealtime(this.peer.createDataChannel("101-realtime", {
        ordered: false,
        maxRetransmits: 0,
      }));
    }
  }

  async disconnect() {
    this.control?.close();
    this.realtime?.close();
    this.peer?.close();
    this.control = undefined;
    this.realtime = undefined;
    this.peer = undefined;
    this.setState("disconnected");
  }

  async createOfferCode() {
    await this.connect();
    const peer = this.requirePeer();
    await peer.setLocalDescription(await peer.createOffer());
    await waitForIceGathering(peer);
    return encodePairingDescription(requireLocalDescription(peer));
  }

  async acceptOfferCode(code: string) {
    await this.connect();
    const peer = this.requirePeer();
    const offer = await decodePairingDescription(code);
    if (offer.type !== "offer") throw new Error("Expected a 101 WebRTC offer");
    await peer.setRemoteDescription(offer);
    await peer.setLocalDescription(await peer.createAnswer());
    await waitForIceGathering(peer);
    return encodePairingDescription(requireLocalDescription(peer));
  }

  async acceptAnswerCode(code: string) {
    const peer = this.requirePeer();
    const answer = await decodePairingDescription(code);
    if (answer.type !== "answer") throw new Error("Expected a 101 WebRTC answer");
    await peer.setRemoteDescription(answer);
  }

  sendReliable(message: ControlMessage) {
    if (this.control?.readyState !== "open") return;
    this.control.send(serializeControlMessage(message));
  }

  sendRealtime(frame: InputFrame) {
    if (this.realtime?.readyState !== "open") return;
    if (this.realtime.bufferedAmount > (this.options.realtimeBufferLimit ?? 64 * 1024)) return;
    this.realtime.send(JSON.stringify(frame));
  }

  onMessage(callback: (message: LinkMessage) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onStateChange(callback: (state: LinkState) => void) {
    this.stateListeners.add(callback);
    callback(this.currentState);
    return () => this.stateListeners.delete(callback);
  }

  async stats(): Promise<RTCStatsReport | undefined> {
    return this.peer?.getStats();
  }

  private attachControl(channel: RTCDataChannel) {
    this.control = channel;
    channel.onmessage = (event: MessageEvent<string>) => {
      try {
        this.emit({ channel: "control", payload: deserializeControlMessage(event.data) });
      } catch {
        // Invalid remote packets are ignored rather than reaching a game.
      }
    };
  }

  private attachRealtime(channel: RTCDataChannel) {
    this.realtime = channel;
    channel.bufferedAmountLowThreshold = 16 * 1024;
    channel.onmessage = (event: MessageEvent<string>) => {
      try {
        this.emit({ channel: "realtime", payload: JSON.parse(event.data) as InputFrame });
      } catch {
        // Invalid or partial disposable frames are safe to drop.
      }
    };
  }

  private emit(message: LinkMessage) {
    this.listeners.forEach((listener) => listener(message));
  }

  private setState(state: LinkState) {
    if (state === this.currentState) return;
    this.currentState = state;
    this.stateListeners.forEach((listener) => listener(state));
  }

  private requirePeer() {
    if (!this.peer) throw new Error("Call connect() before exchanging pairing data");
    return this.peer;
  }
}

interface PairingEnvelope {
  v: typeof PROTOCOL_VERSION;
  type: RTCSdpType;
  sdp: string;
  checksum: string;
}

export async function encodePairingDescription(
  description: RTCSessionDescriptionInit,
  compress = true,
): Promise<string> {
  if (!description.type || !description.sdp) throw new Error("Incomplete WebRTC description");
  if (description.sdp.length > 256_000) throw new Error("Pairing description is too large");
  const payload = `${description.type}\n${description.sdp}`;
  const envelope: PairingEnvelope = {
    v: PROTOCOL_VERSION,
    type: description.type,
    sdp: description.sdp,
    checksum: checksum(payload),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  if (compress && typeof CompressionStream !== "undefined") {
    const compressed = await transformBytes(bytes, new CompressionStream("deflate"));
    return `101C2.${toBase64Url(compressed)}`;
  }
  return `101J2.${toBase64Url(bytes)}`;
}

export async function decodePairingDescription(code: string): Promise<RTCSessionDescriptionInit> {
  const normalized = code.trim();
  if (normalized.length > 400_000) throw new Error("Pairing code is too large");
  const [prefix, encoded, extra] = normalized.split(".");
  if (extra !== undefined || !encoded || !["101C2", "101J2"].includes(prefix)) {
    throw new Error("Invalid 101 pairing code");
  }
  let bytes = fromBase64Url(encoded);
  if (prefix === "101C2") {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Compressed pairing codes are unavailable in this browser");
    }
    bytes = await transformBytes(bytes, new DecompressionStream("deflate"), 300_000);
  }
  if (bytes.byteLength > 300_000) throw new Error("Pairing code is too large");
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PairingEnvelope>;
  if (envelope.v !== PROTOCOL_VERSION || !envelope.type || !envelope.sdp) {
    throw new Error("Unsupported or malformed 101 pairing code");
  }
  if (!(["offer", "answer"] as string[]).includes(envelope.type)) {
    throw new Error("Unsupported pairing description type");
  }
  if (envelope.checksum !== checksum(`${envelope.type}\n${envelope.sdp}`)) {
    throw new Error("Pairing code failed integrity validation");
  }
  return { type: envelope.type, sdp: envelope.sdp };
}

async function waitForIceGathering(peer: RTCPeerConnection, timeoutMs = 5000) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
    function onChange() {
      if (peer.iceGatheringState === "complete") finish();
    }
    function finish() {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
  });
}

function requireLocalDescription(peer: RTCPeerConnection): RTCSessionDescriptionInit {
  if (!peer.localDescription) throw new Error("WebRTC did not produce pairing data");
  return { type: peer.localDescription.type, sdp: peer.localDescription.sdp };
}

async function transformBytes(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  maxOutput = Number.POSITIVE_INFINITY,
) {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  const reader = new Blob([copied.buffer]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxOutput) {
      await reader.cancel();
      throw new Error("Pairing code expands beyond the allowed size");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid pairing encoding");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function checksum(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9._-]{1,64}$/i.test(value);
}

function optionalLabel(value: unknown, index: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 40) {
    throw new Error(`Invalid controller label at index ${index}`);
  }
  return value;
}

function optionalText(value: unknown, name: string, maxLength: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid controller ${name}`);
  }
  return value;
}

function finiteNumber(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Controller values must be finite numbers");
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

function parseCapabilities(input: Record<string, unknown>): DeviceCapabilities {
  const capabilities: DeviceCapabilities = {};
  const names = ["touch", "accelerometer", "gyroscope", "magnetometer", "camera", "microphone", "haptics", "gamepad"] as const;
  for (const name of names) {
    const value = input[name];
    if (value !== undefined && typeof value !== "boolean") throw new Error(`Invalid capability: ${name}`);
    if (value !== undefined) capabilities[name] = value;
  }
  return capabilities;
}
