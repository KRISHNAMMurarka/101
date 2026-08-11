export type InputSource =
  | "keyboard"
  | "mouse"
  | "touch"
  | "gamepad"
  | "phone-motion"
  | "watch-motion"
  | "camera-hand"
  | "camera-pose"
  | "camera-face"
  | "hid"
  | "bluetooth"
  | "serial"
  | "custom";

export interface InputVector {
  x: number;
  y: number;
  z?: number;
}

export interface InputFrame {
  deviceId: string;
  playerId: string;
  sequence: number;
  timestamp: number;
  receivedAt?: number;
  source: InputSource;
  actions: Record<string, boolean | number>;
  axes?: Record<string, number>;
  vectors?: Record<string, InputVector>;
}

export interface InputManifestControl {
  recommended: InputSource[];
  fallback?: InputSource[];
  description?: string;
}

export interface InputManifest {
  game: string;
  actions?: Record<string, InputManifestControl>;
  axes?: Record<string, InputManifestControl>;
  vectors?: Record<string, InputManifestControl>;
}

export type InputFrameListener = (frame: Readonly<InputFrame>) => void;

export interface InputAdapter {
  readonly id: string;
  readonly source: InputSource;
  start(emit: InputFrameListener): void | Promise<void>;
  stop(): void | Promise<void>;
}

const clamp = (value: number, min = -1, max = 1) =>
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));

export function normalizeInputFrame(
  frame: InputFrame,
  receivedAt = performance.now(),
): InputFrame {
  const axes = frame.axes
    ? Object.fromEntries(
        Object.entries(frame.axes).map(([name, value]) => [name, clamp(value)]),
      )
    : undefined;

  const vectors = frame.vectors
    ? Object.fromEntries(
        Object.entries(frame.vectors).map(([name, vector]) => [
          name,
          {
            x: clamp(vector.x),
            y: clamp(vector.y),
            ...(vector.z === undefined ? {} : { z: clamp(vector.z) }),
          },
        ]),
      )
    : undefined;

  return {
    ...frame,
    sequence: Math.max(0, Math.trunc(frame.sequence)),
    timestamp: Number.isFinite(frame.timestamp) ? frame.timestamp : receivedAt,
    receivedAt,
    actions: { ...frame.actions },
    axes,
    vectors,
  };
}

export class InputBus {
  private readonly frames = new Map<string, Map<string, InputFrame>>();
  private readonly listeners = new Set<InputFrameListener>();
  private readonly adapters = new Set<InputAdapter>();
  private readonly bindings = new Set<string>();

  bind(control: string) {
    this.bindings.add(control);
  }

  isBound(control: string) {
    return this.bindings.has(control);
  }

  async register(adapter: InputAdapter) {
    if (this.adapters.has(adapter)) return;
    this.adapters.add(adapter);
    await adapter.start((frame) => this.accept(frame));
  }

  async unregister(adapter: InputAdapter) {
    if (!this.adapters.delete(adapter)) return;
    await adapter.stop();
  }

  async destroy() {
    await Promise.all([...this.adapters].map((adapter) => adapter.stop()));
    this.adapters.clear();
    this.frames.clear();
    this.listeners.clear();
  }

  accept(incoming: InputFrame): boolean {
    const frame = normalizeInputFrame(incoming);
    const playerFrames = this.frames.get(frame.playerId) ?? new Map();
    const previous = playerFrames.get(frame.deviceId);

    if (previous && frame.sequence <= previous.sequence) return false;

    playerFrames.set(frame.deviceId, frame);
    this.frames.set(frame.playerId, playerFrames);
    this.listeners.forEach((listener) => listener(frame));
    return true;
  }

  subscribe(listener: InputFrameListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  action(name: string, playerId = "player-1"): boolean | number {
    return this.readNewest(playerId, (frame) => frame.actions[name]) ?? false;
  }

  axis(name: string, playerId = "player-1"): number {
    return this.readNewest(playerId, (frame) => frame.axes?.[name]) ?? 0;
  }

  vector(name: string, playerId = "player-1"): InputVector {
    return (
      this.readNewest(playerId, (frame) => frame.vectors?.[name]) ?? {
        x: 0,
        y: 0,
      }
    );
  }

  connectedDevices(playerId?: string): ReadonlyArray<InputFrame> {
    const groups = playerId
      ? [this.frames.get(playerId) ?? new Map()]
      : [...this.frames.values()];
    return groups.flatMap((group) => [...group.values()]);
  }

  private readNewest<T>(
    playerId: string,
    read: (frame: InputFrame) => T | undefined,
  ): T | undefined {
    const playerFrames = this.frames.get(playerId);
    if (!playerFrames) return undefined;

    return [...playerFrames.values()]
      .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0))
      .map(read)
      .find((value) => value !== undefined);
  }
}
