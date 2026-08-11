import type { InputFrame } from "@101/input";

export const PROTOCOL_VERSION = 1 as const;

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
  | { type: "player.assign"; deviceId: string; playerId: string }
  | { type: "controller.configure"; role: string; layout: ControllerLayout }
  | { type: "calibration.request"; mode: string }
  | { type: "haptic"; pattern: "tap" | "impact" | "warning" }
  | { type: "pause"; paused: boolean }
  | { type: "ping"; sentAt: number }
  | { type: "pong"; sentAt: number; receivedAt: number };

export interface ControllerLayout {
  layout: Array<
    | { type: "joystick"; action: string; label?: string }
    | { type: "button"; action: string; label: string }
    | { type: "touch-surface"; action: string; label?: string }
  >;
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

export function serializeControlMessage(message: ControlMessage): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, message });
}

export function deserializeControlMessage(data: string): ControlMessage {
  const packet = JSON.parse(data) as {
    version?: number;
    message?: ControlMessage;
  };
  if (packet.version !== PROTOCOL_VERSION || !packet.message?.type) {
    throw new Error("Unsupported or malformed 101 control packet");
  }
  return packet.message;
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
