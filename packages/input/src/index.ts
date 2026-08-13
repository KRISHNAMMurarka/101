export const INPUT_SOURCES = [
  "keyboard",
  "mouse",
  "touch",
  "gamepad",
  "phone-motion",
  "watch-motion",
  "camera-hand",
  "camera-pose",
  "camera-face",
  "hid",
  "bluetooth",
  "serial",
  "custom",
] as const;

export type InputSource = typeof INPUT_SOURCES[number];

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
  poses?: Record<string, ReadonlyArray<number>>;
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
  poses?: Record<string, InputManifestControl>;
}

export interface ResolvedInputManifest {
  mappings: Record<string, InputSource>;
  missing: string[];
}

export function parseInputManifest(input: unknown): InputManifest {
  if (!isRecord(input)) throw new Error("Input manifest must be an object");
  const game = parseIdentifier(input.game, "game");
  let controlCount = 0;
  const parseGroup = (value: unknown, group: string) => {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error(`Input manifest ${group} must be an object`);
    const parsed: Record<string, InputManifestControl> = {};
    for (const [name, requirement] of Object.entries(value)) {
      controlCount += 1;
      if (controlCount > 128) throw new Error("Input manifest cannot declare more than 128 controls");
      parseControlName(name, group);
      if (!isRecord(requirement)) throw new Error(`Invalid ${group} control ${name}`);
      const recommended = parseSources(requirement.recommended, `${group}.${name}.recommended`, false);
      const fallback = requirement.fallback === undefined
        ? undefined
        : parseSources(requirement.fallback, `${group}.${name}.fallback`, true);
      const description = requirement.description === undefined
        ? undefined
        : parseText(requirement.description, `${group}.${name}.description`, 240);
      parsed[name] = {
        recommended,
        ...(fallback ? { fallback } : {}),
        ...(description ? { description } : {}),
      };
    }
    return parsed;
  };
  const manifest: InputManifest = {
    game,
    actions: parseGroup(input.actions, "actions"),
    axes: parseGroup(input.axes, "axes"),
    vectors: parseGroup(input.vectors, "vectors"),
    poses: parseGroup(input.poses, "poses"),
  };
  if (controlCount === 0) throw new Error("Input manifest must declare at least one control");
  return manifest;
}

export function resolveInputManifest(
  manifest: InputManifest,
  available: Iterable<InputSource>,
): ResolvedInputManifest {
  const sources = new Set(available);
  const mappings: Record<string, InputSource> = {};
  const missing: string[] = [];
  const groups = [manifest.actions, manifest.axes, manifest.vectors, manifest.poses];
  for (const group of groups) {
    for (const [control, requirement] of Object.entries(group ?? {})) {
      const source = [...requirement.recommended, ...(requirement.fallback ?? [])]
        .find((candidate) => sources.has(candidate));
      if (source) mappings[control] = source;
      else missing.push(control);
    }
  }
  return { mappings, missing };
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
  const poses = frame.poses
    ? Object.fromEntries(
        Object.entries(frame.poses).map(([name, values]) => [
          name,
          values.map((value) => clamp(value)),
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
    poses,
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
    this.removeDevice(adapter.id);
  }

  removeDevice(deviceId: string, playerId?: string) {
    let removed = false;
    const players = playerId ? [[playerId, this.frames.get(playerId)] as const] : [...this.frames.entries()];
    for (const [id, frames] of players) {
      if (!frames?.delete(deviceId)) continue;
      removed = true;
      if (frames.size === 0) this.frames.delete(id);
    }
    return removed;
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
    const values = this.readValues(playerId, (frame) => frame.actions[name]);
    return values.find((value) => value === true || (typeof value === "number" && value !== 0))
      ?? values[0]
      ?? false;
  }

  axis(name: string, playerId = "player-1"): number {
    return this.readValues(playerId, (frame) => frame.axes?.[name])
      .sort((a, b) => Math.abs(b) - Math.abs(a))[0]
      ?? 0;
  }

  vector(name: string, playerId = "player-1"): InputVector {
    return this.readValues(playerId, (frame) => frame.vectors?.[name])
      .sort((a, b) => vectorMagnitude(b) - vectorMagnitude(a))[0]
      ?? { x: 0, y: 0 };
  }

  pose(name: string, playerId = "player-1"): ReadonlyArray<number> | undefined {
    return this.readNewest(playerId, (frame) => frame.poses?.[name]);
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
    return this.readValues(playerId, read)[0];
  }

  private readValues<T>(
    playerId: string,
    read: (frame: InputFrame) => T | undefined,
  ): T[] {
    const playerFrames = this.frames.get(playerId);
    if (!playerFrames) return [];

    return [...playerFrames.values()]
      .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0)
        || b.timestamp - a.timestamp
        || b.sequence - a.sequence
        || b.deviceId.localeCompare(a.deviceId))
      .map(read)
      .filter((value): value is T => value !== undefined);
  }
}

function vectorMagnitude(vector: InputVector) {
  return vector.x * vector.x + vector.y * vector.y + (vector.z ?? 0) * (vector.z ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentifier(value: unknown, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid input manifest ${label}`);
  }
  return value;
}

function parseControlName(value: string, group: string) {
  if (value.length > 128 || !/^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid ${group} control name ${value}`);
  }
  return value;
}

function parseSources(value: unknown, label: string, allowEmpty: boolean): InputSource[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > INPUT_SOURCES.length) {
    throw new Error(`${label} must be a valid source list`);
  }
  const sources = value.map((source) => {
    if (typeof source !== "string" || !INPUT_SOURCES.includes(source as InputSource)) {
      throw new Error(`${label} contains unsupported source ${String(source)}`);
    }
    return source as InputSource;
  });
  if (new Set(sources).size !== sources.length) throw new Error(`${label} contains duplicate sources`);
  return sources;
}

function parseText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be non-empty text up to ${maxLength} characters`);
  }
  return value.trim();
}
