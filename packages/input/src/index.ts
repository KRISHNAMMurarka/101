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
  /**
   * Whether the game is still playable when nothing can serve this control.
   *
   * Defaults to required, because that is the safe reading of a control an author bothered to
   * declare. Marking a control optional is how a game says "this is an enhancement" — a pose
   * shortcut, a motion flourish — so the host can start it on a keyboard instead of refusing.
   */
  optional?: boolean;
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
  /** Control name to the source that will actually serve it, in author preference order. */
  mappings: Record<string, InputSource>;
  /** Every declared control nothing available can serve, required or not. */
  missing: string[];
  /** The subset of `missing` the game declared it needs. Non-empty means "do not start yet". */
  blocking: string[];
  /** Controls that fell through to a fallback, so the host can say the game is degraded. */
  degraded: string[];
  /** True when every required control has a source. Optional gaps do not block. */
  playable: boolean;
  /**
   * Sources this game asked for that are not present, in author preference order.
   *
   * This is what turns a generic nudge into a useful one. A camera game and a steering game are
   * both degraded on a bare laptop, but telling a camera game's player to pair a phone is simply
   * wrong advice.
   */
  wanted: InputSource[];
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
      if (requirement.optional !== undefined && typeof requirement.optional !== "boolean") {
        throw new Error(`Invalid ${group}.${name}.optional`);
      }
      parsed[name] = {
        recommended,
        ...(fallback ? { fallback } : {}),
        ...(requirement.optional ? { optional: true } : {}),
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
  const blocking: string[] = [];
  const degraded: string[] = [];
  const groups = [manifest.actions, manifest.axes, manifest.vectors, manifest.poses];
  for (const group of groups) {
    for (const [control, requirement] of Object.entries(group ?? {})) {
      // Author order is the preference order. `recommended` is what the game was designed around;
      // `fallback` is what it will accept. Nothing here scores devices behind the author's back —
      // a game that lists `camera-hand` first means it, and a surprise reordering would be a worse
      // outcome than a predictable one.
      const source = requirement.recommended.find((candidate) => sources.has(candidate));
      const substitute = source
        ? undefined
        : requirement.fallback?.find((candidate) => sources.has(candidate));
      if (source) {
        mappings[control] = source;
      } else if (substitute) {
        mappings[control] = substitute;
        degraded.push(control);
      } else {
        missing.push(control);
        if (!requirement.optional) blocking.push(control);
      }
    }
  }
  const unresolved = new Set([...degraded, ...missing]);
  const wanted: InputSource[] = [];
  for (const group of groups) {
    for (const [control, requirement] of Object.entries(group ?? {})) {
      if (!unresolved.has(control)) continue;
      for (const candidate of requirement.recommended) {
        if (!sources.has(candidate) && !wanted.includes(candidate)) wanted.push(candidate);
      }
    }
  }

  return { mappings, missing, blocking, degraded, wanted, playable: blocking.length === 0 };
}

export type InputFrameListener = (frame: Readonly<InputFrame>) => void;

export interface InputAdapter {
  readonly id: string;
  readonly source: InputSource;
  /**
   * Whether this adapter can serve input *right now*.
   *
   * Registration is not availability. A gamepad adapter is registered the moment a game starts and
   * polls happily with no controller plugged in, so counting it as an available source would tell a
   * game its `gamepad` requirement is satisfied when nothing is connected. Adapters that are always
   * there — keyboard, pointer — leave this undefined, which reads as available.
   */
  readonly available?: boolean;
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
        Object.entries(frame.poses).slice(0, 16).filter(([, values]) =>
          Array.isArray(values) && values.length <= 4096
          && values.every((value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000),
        ).map(([name, values]) => [
          name,
          // Poses carry schema tags and metric coordinates, not normalized stick axes.
          [...values],
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

  /**
   * Every input source currently able to produce frames.
   *
   * Locally registered adapters are the sources this machine owns. `extra` carries sources that
   * arrive over the link — a paired phone's touch and motion — which the bus cannot discover by
   * itself because a remote controller registers no adapter here.
   *
   * Without this, `resolveInputManifest` had no honest way to be told what was available, which is
   * why nothing outside the tests ever called it.
   */
  availableSources(extra: Iterable<InputSource> = []): InputSource[] {
    const sources = new Set<InputSource>();
    for (const adapter of this.adapters) {
      if (adapter.available === false) continue;
      sources.add(adapter.source);
    }
    for (const source of extra) sources.add(source);
    return [...sources];
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
