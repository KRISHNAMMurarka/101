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

export type HapticMessage = {
  type: "haptic";
  deviceId: string;
  pattern: "tap" | "impact" | "warning";
};

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
  // Kept parseable on the control channel so a newly updated controller remains compatible with
  // an older host. Current hosts send this disposable feedback over realtime instead.
  | HapticMessage
  | { type: "pause"; paused: boolean }
  | { type: "ping"; sentAt: number; deviceId?: string }
  | { type: "pong"; sentAt: number; receivedAt: number };

export interface ControllerPlacementHints {
  side?: "left" | "right" | "center";
  zone?: "thumb" | "shoulder" | "index" | "edge";
  size?: "small" | "medium" | "large";
  span?: number;
  priority?: number;
}

export type ControllerInteraction =
  | { type: "hold"; thresholdMs?: number }
  | { type: "double-tap"; intervalMs?: number }
  | { type: "toggle" }
  | { type: "chord"; actions: readonly string[] };

export type ControllerElement = ControllerPlacementHints & (
  | { type: "joystick"; action: string; label?: string; deadZone?: number; responseCurve?: number }
  | { type: "dpad"; action: string; label?: string }
  | {
      type: "button";
      action: string;
      label: string;
      emphasis?: "normal" | "primary" | "danger";
      interaction?: ControllerInteraction;
    }
  | { type: "shoulder"; action: string; label: string; interaction?: ControllerInteraction }
  | { type: "trigger"; action: string; label: string }
  | { type: "analog-button"; action: string; label: string }
  | { type: "touch-surface"; action: string; label?: string }
  | {
      type: "slider";
      action: string;
      label: string;
      min?: number;
      max?: number;
      step?: number;
    }
);

export interface ControllerLayout {
  title?: string;
  accent?: string;
  /** Author preference only; a player may override it on their controller. */
  handedness?: "left" | "right";
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
  rejectUnknownProperties(input, ["$schema", "title", "accent", "handedness", "motion", "layout"], "controller layout");
  if (input.$schema !== undefined && typeof input.$schema !== "string") {
    throw new Error("Controller layout $schema must be a string");
  }
  const layout = input.layout.map((value, index): ControllerElement => {
    if (!isRecord(value) || !isActionName(value.action) || typeof value.type !== "string") {
      throw new Error(`Invalid controller element at index ${index}`);
    }
    const label = optionalLabel(value.label, index);
    const placement = parsePlacementHints(value, index);
    if (value.type === "joystick") {
      rejectUnknownElementProperties(value, index, ["deadZone", "responseCurve"]);
      const deadZone = finiteNumber(value.deadZone, .12);
      const responseCurve = finiteNumber(value.responseCurve, 1);
      if (deadZone < 0 || deadZone > .95 || responseCurve < .25 || responseCurve > 4) {
        throw new Error(`Invalid joystick tuning at index ${index}`);
      }
      return { type: "joystick", action: value.action, ...(label ? { label } : {}), deadZone, responseCurve, ...placement };
    }
    if (value.type === "dpad" || value.type === "touch-surface") {
      rejectUnknownElementProperties(value, index);
      return { type: value.type, action: value.action, ...(label ? { label } : {}), ...placement };
    }
    if (value.type === "button") {
      rejectUnknownElementProperties(value, index, ["emphasis", "interaction"]);
      if (!label) throw new Error(`Button at index ${index} requires a label`);
      const emphasis = value.emphasis;
      if (emphasis !== undefined && emphasis !== "normal" && emphasis !== "primary" && emphasis !== "danger") {
        throw new Error(`Invalid button emphasis at index ${index}`);
      }
      const interaction = parseControllerInteraction(value.interaction, value.action, index);
      return { type: "button", action: value.action, label, ...(emphasis ? { emphasis } : {}), ...(interaction ? { interaction } : {}), ...placement };
    }
    if (value.type === "shoulder") {
      rejectUnknownElementProperties(value, index, ["interaction"]);
      if (!label) throw new Error(`Shoulder at index ${index} requires a label`);
      const interaction = parseControllerInteraction(value.interaction, value.action, index);
      return { type: "shoulder", action: value.action, label, ...(interaction ? { interaction } : {}), ...placement };
    }
    if (value.type === "trigger" || value.type === "analog-button") {
      rejectUnknownElementProperties(value, index);
      if (!label) throw new Error(`${value.type === "trigger" ? "Trigger" : "Analog button"} at index ${index} requires a label`);
      return { type: value.type, action: value.action, label, ...placement };
    }
    if (value.type === "slider") {
      rejectUnknownElementProperties(value, index, ["min", "max", "step"]);
      if (!label) throw new Error(`Slider at index ${index} requires a label`);
      const min = finiteNumber(value.min, -1);
      const max = finiteNumber(value.max, 1);
      const step = finiteNumber(value.step, .01);
      if (min < -1 || max > 1 || min >= max || step <= 0 || step > max - min) {
        throw new Error(`Invalid slider range at index ${index}`);
      }
      return { type: "slider", action: value.action, label, min, max, step, ...placement };
    }
    throw new Error(`Unsupported controller element type at index ${index}`);
  });
  const title = optionalText(input.title, "title", 64);
  const accent = input.accent === undefined ? undefined : typeof input.accent === "string" && /^#[0-9a-f]{6}$/i.test(input.accent) ? input.accent : (() => { throw new Error("Controller accent must be a six-digit hex color"); })();
  const handedness = input.handedness;
  if (handedness !== undefined && handedness !== "left" && handedness !== "right") {
    throw new Error("Controller handedness must be left or right");
  }
  let motion: ControllerLayout["motion"];
  if (input.motion !== undefined) {
    if (!isRecord(input.motion) || !isActionName(input.motion.action) || (input.motion.mode !== "tilt" && input.motion.mode !== "wand")) {
      throw new Error("Invalid controller motion mapping");
    }
    rejectUnknownProperties(input.motion, ["action", "mode", "label", "gestures"], "controller motion mapping");
    const motionLabel = optionalText(input.motion.label, "motion label", 64);
    let gestures: Partial<Record<"shake" | "swing" | "spin", string>> | undefined;
    if (input.motion.gestures !== undefined) {
      if (!isRecord(input.motion.gestures)) throw new Error("Invalid controller gesture mappings");
      rejectUnknownProperties(input.motion.gestures, ["shake", "swing", "spin"], "controller gesture mapping");
      gestures = {};
      for (const name of ["shake", "swing", "spin"] as const) {
        const action = input.motion.gestures[name];
        if (action !== undefined && !isActionName(action)) throw new Error(`Invalid ${name} gesture action`);
        if (typeof action === "string") gestures[name] = action;
      }
    }
    motion = { action: input.motion.action, mode: input.motion.mode, ...(motionLabel ? { label: motionLabel } : {}), ...(gestures ? { gestures } : {}) };
  }
  return { ...(title ? { title } : {}), ...(accent ? { accent } : {}), ...(handedness ? { handedness } : {}), ...(motion ? { motion } : {}), layout };
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
  if (input.type === "ping") {
    // `deviceId` is optional so a client predating it still parses; the host then simply cannot
    // refresh that device's liveness from a ping alone.
    const deviceId = optionalText(input.deviceId, "deviceId", 128);
    return { type: "ping", sentAt: requiredFinite(input.sentAt, "sentAt"), ...(deviceId ? { deviceId } : {}) };
  }
  if (input.type === "pong") return { type: "pong", sentAt: requiredFinite(input.sentAt, "sentAt"), receivedAt: requiredFinite(input.receivedAt, "receivedAt") };
  throw new Error("Unsupported 101 control message");
}

export type RealtimeMessage = InputFrame | HapticMessage;

export type LinkMessage =
  | { channel: "control"; payload: ControlMessage }
  | { channel: "realtime"; payload: RealtimeMessage };

export interface LinkTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendReliable(message: ControlMessage): void;
  sendRealtime(message: RealtimeMessage): void;
  onMessage(callback: (message: LinkMessage) => void): () => void;
}

export type LinkState = "idle" | "connecting" | "connected" | "disconnected" | "failed";

export interface StatefulLinkTransport extends LinkTransport {
  readonly state: LinkState;
  onStateChange(callback: (state: LinkState) => void): () => void;
}

export class MultiplexLinkTransport implements LinkTransport {
  private readonly transports = new Map<string, { transport: LinkTransport; removeListener: () => void }>();
  private readonly deviceRoutes = new Map<string, string>();
  private readonly listeners = new Set<(message: LinkMessage) => void>();
  private connected = false;

  async add(id: string, transport: LinkTransport) {
    if (!/^[a-z0-9._-]{1,128}$/i.test(id)) throw new Error("Invalid multiplex transport id");
    if (this.transports.has(id)) await this.remove(id);
    const removeListener = transport.onMessage((message) => {
      if (message.channel === "control" && message.payload.type === "hello") this.deviceRoutes.set(message.payload.deviceId, id);
      this.listeners.forEach((listener) => listener(message));
    });
    this.transports.set(id, { transport, removeListener });
    if (this.connected) {
      try {
        await transport.connect();
      } catch (error) {
        removeListener();
        this.transports.delete(id);
        throw error;
      }
    }
  }

  async remove(id: string) {
    const entry = this.transports.get(id);
    if (!entry) return false;
    this.transports.delete(id);
    for (const [deviceId, routeId] of this.deviceRoutes) if (routeId === id) this.deviceRoutes.delete(deviceId);
    entry.removeListener();
    await entry.transport.disconnect();
    return true;
  }

  has(id: string) {
    return this.transports.has(id);
  }

  ids() {
    return [...this.transports.keys()];
  }

  async connect() {
    if (this.connected) return;
    const connected: LinkTransport[] = [];
    try {
      for (const { transport } of this.transports.values()) {
        await transport.connect();
        connected.push(transport);
      }
      this.connected = true;
    } catch (error) {
      await Promise.allSettled(connected.map((transport) => transport.disconnect()));
      throw error;
    }
  }

  async disconnect() {
    this.connected = false;
    await Promise.allSettled([...this.transports.values()].map(({ transport }) => transport.disconnect()));
  }

  sendReliable(message: ControlMessage) {
    const deviceId = "deviceId" in message ? message.deviceId : undefined;
    const route = deviceId ? this.deviceRoutes.get(deviceId) : undefined;
    if (route) {
      this.transports.get(route)?.transport.sendReliable(message);
      return;
    }
    for (const { transport } of this.transports.values()) transport.sendReliable(message);
  }

  sendRealtime(message: RealtimeMessage) {
    const route = "type" in message && message.type === "haptic"
      ? this.deviceRoutes.get(message.deviceId)
      : undefined;
    if (route) {
      this.transports.get(route)?.transport.sendRealtime(message);
      return;
    }
    for (const { transport } of this.transports.values()) transport.sendRealtime(message);
  }

  onMessage(callback: (message: LinkMessage) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}

export interface PairingTicket {
  version: typeof PROTOCOL_VERSION;
  sessionId: string;
  endpoint: string;
  joinToken: string;
  expiresAt: number;
  hostName?: string;
  transport: "webrtc";
}

interface PairingTicketEnvelope extends PairingTicket {
  checksum: string;
}

export function encodePairingTicket(ticket: PairingTicket) {
  const parsed = parsePairingTicket(ticket);
  const payload = JSON.stringify(parsed);
  const envelope: PairingTicketEnvelope = { ...parsed, checksum: checksum(payload) };
  return `101L2.${toBase64Url(new TextEncoder().encode(JSON.stringify(envelope)))}`;
}

export function decodePairingTicket(code: string, now = Date.now()) {
  const normalized = code.trim();
  if (normalized.length > 4096 || !normalized.startsWith("101L2.")) throw new Error("Invalid 101 LAN pairing ticket");
  const encoded = normalized.slice(6);
  const envelope = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as Partial<PairingTicketEnvelope>;
  const { checksum: receivedChecksum, ...candidate } = envelope;
  const parsed = parsePairingTicket(candidate);
  if (receivedChecksum !== checksum(JSON.stringify(parsed))) throw new Error("Pairing ticket failed integrity validation");
  if (parsed.expiresAt <= now) throw new Error("Pairing ticket has expired");
  return parsed;
}

export function createControllerPairingUrl(controllerBaseUrl: string, ticket: PairingTicket) {
  const url = new URL(controllerBaseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Controller URL must use HTTP or HTTPS");
  url.searchParams.set("pair", encodePairingTicket(ticket));
  return url.toString();
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

  sendRealtime(message: RealtimeMessage) {
    this.channel?.postMessage({ channel: "realtime", payload: message } satisfies LinkMessage);
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
  /**
   * Compressed descriptions are useful for manual QR exchange. Automatic LAN
   * signaling should disable this so native peers do not need browser-only
   * CompressionStream support.
   */
  pairingCompression?: boolean;
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
    return encodePairingDescription(
      requireLocalDescription(peer),
      this.options.pairingCompression ?? true,
    );
  }

  async acceptOfferCode(code: string) {
    await this.connect();
    const peer = this.requirePeer();
    const offer = await decodePairingDescription(code);
    if (offer.type !== "offer") throw new Error("Expected a 101 WebRTC offer");
    await peer.setRemoteDescription(offer);
    await peer.setLocalDescription(await peer.createAnswer());
    await waitForIceGathering(peer);
    return encodePairingDescription(
      requireLocalDescription(peer),
      this.options.pairingCompression ?? true,
    );
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

  sendRealtime(message: RealtimeMessage) {
    if (this.realtime?.readyState !== "open") return;
    if (this.realtime.bufferedAmount > (this.options.realtimeBufferLimit ?? 64 * 1024)) return;
    this.realtime.send(JSON.stringify(message));
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
        this.emit({ channel: "realtime", payload: JSON.parse(event.data) as RealtimeMessage });
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
  if (extra !== undefined || !encoded || (prefix !== "101C2" && prefix !== "101J2")) {
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

function parsePairingTicket(input: unknown): PairingTicket {
  if (!isRecord(input) || input.version !== PROTOCOL_VERSION || input.transport !== "webrtc") throw new Error("Unsupported 101 LAN pairing ticket");
  const sessionId = requiredText(input.sessionId, "sessionId", 128);
  if (!/^[A-Z0-9-]{4,128}$/i.test(sessionId)) throw new Error("Invalid pairing session id");
  const joinToken = requiredText(input.joinToken, "joinToken", 256);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(joinToken)) throw new Error("Invalid pairing join token");
  const endpoint = requiredText(input.endpoint, "endpoint", 2048);
  const url = new URL(endpoint);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) throw new Error("Invalid pairing endpoint");
  const expiresAt = requiredFinite(input.expiresAt, "expiresAt");
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error("Invalid pairing expiration");
  const hostName = input.hostName === undefined ? undefined : requiredText(input.hostName, "hostName", 128);
  return { version: PROTOCOL_VERSION, sessionId, endpoint: url.toString().replace(/\/$/, ""), joinToken, expiresAt, ...(hostName ? { hostName } : {}), transport: "webrtc" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActionName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/.test(value);
}

const ELEMENT_PROPERTY_NAMES = ["type", "action", "label", "side", "zone", "size", "span", "priority"] as const;

function rejectUnknownElementProperties(value: Record<string, unknown>, index: number, extra: readonly string[] = []) {
  rejectUnknownProperties(value, [...ELEMENT_PROPERTY_NAMES, ...extra], `controller element at index ${index}`);
}

function rejectUnknownProperties(value: Record<string, unknown>, allowed: readonly string[], name: string) {
  const allowedNames = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedNames.has(key));
  if (unknown) throw new Error(`Unsupported ${name} property ${unknown}`);
}

function parsePlacementHints(value: Record<string, unknown>, index: number): ControllerPlacementHints {
  const side = value.side;
  if (side !== undefined && side !== "left" && side !== "right" && side !== "center") {
    throw new Error(`Invalid controller side at index ${index}`);
  }
  const zone = value.zone;
  if (zone !== undefined && zone !== "thumb" && zone !== "shoulder" && zone !== "index" && zone !== "edge") {
    throw new Error(`Invalid controller zone at index ${index}`);
  }
  const size = value.size;
  if (size !== undefined && size !== "small" && size !== "medium" && size !== "large") {
    throw new Error(`Invalid controller size at index ${index}`);
  }
  const span = optionalIntegerInRange(value.span, 1, 4, `controller span at index ${index}`);
  const priority = optionalIntegerInRange(value.priority, 0, 100, `controller priority at index ${index}`);
  return {
    ...(side ? { side } : {}),
    ...(zone ? { zone } : {}),
    ...(size ? { size } : {}),
    ...(span === undefined ? {} : { span }),
    ...(priority === undefined ? {} : { priority }),
  };
}

function parseControllerInteraction(input: unknown, primaryAction: string, index: number): ControllerInteraction | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input) || typeof input.type !== "string") {
    throw new Error(`Invalid controller interaction at index ${index}`);
  }
  if (input.type === "hold") {
    rejectUnknownProperties(input, ["type", "thresholdMs"], `hold interaction at index ${index}`);
    const thresholdMs = finiteNumber(input.thresholdMs, 450);
    if (thresholdMs < 150 || thresholdMs > 2_000) throw new Error(`Invalid hold threshold at index ${index}`);
    return { type: "hold", thresholdMs };
  }
  if (input.type === "double-tap") {
    rejectUnknownProperties(input, ["type", "intervalMs"], `double-tap interaction at index ${index}`);
    const intervalMs = finiteNumber(input.intervalMs, 300);
    if (intervalMs < 150 || intervalMs > 750) throw new Error(`Invalid double-tap interval at index ${index}`);
    return { type: "double-tap", intervalMs };
  }
  if (input.type === "toggle") {
    rejectUnknownProperties(input, ["type"], `toggle interaction at index ${index}`);
    return { type: "toggle" };
  }
  if (input.type === "chord") {
    rejectUnknownProperties(input, ["type", "actions"], `chord interaction at index ${index}`);
    if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 4) {
      throw new Error(`Invalid chord actions at index ${index}`);
    }
    const actions = input.actions.map((action) => {
      if (!isActionName(action)) throw new Error(`Invalid chord action at index ${index}`);
      return action;
    });
    if (new Set(actions).size !== actions.length || actions.includes(primaryAction)) {
      throw new Error(`Chord actions must be unique and exclude the primary action at index ${index}`);
    }
    return { type: "chord", actions };
  }
  throw new Error(`Unsupported controller interaction at index ${index}`);
}

function optionalIntegerInRange(value: unknown, min: number, max: number, name: string) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}`);
  return Number(value);
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
