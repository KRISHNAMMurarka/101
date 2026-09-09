import {
  INPUT_SOURCES,
  parseInputManifest,
  type InputManifest,
  type InputSource,
  type InputVector,
} from "@101/input";
import {
  CAPABILITY_NAMES,
  parseControllerLayout,
  type ControllerLayout,
  type DeviceCapabilities,
} from "@101/protocol";

export type RendererKind = "2d" | "3d" | "video";
export type GameRuntime = "local" | "hosted" | "streamed";

/** Remote input is delivered by the remote runtime, never by the local update loop. */
export interface GameInputTarget {
  transport: "webrtc" | "websocket";
  endpoint: string;
  format: "101-json";
}

export interface GameManifest {
  id: string;
  name: string;
  tagline?: string;
  version: string;
  engine: string;
  renderer: RendererKind;
  /** Omitted manifests retain the local runtime. */
  runtime?: GameRuntime;
  /** Entry point supplied by a hosted/streamed title. No endpoint means not launchable here. */
  launchUrl?: string;
  inputTarget?: GameInputTarget;
  /**
   * What this package is. Defaults to "game".
   *
   * The launcher used to filter its one tool out of the catalog with `id !== "input-lab"` — a rule
   * about a single package rather than a property of packages. A second tool needed a second
   * exception, and a third-party tool could not be excluded at all.
   */
  surface?: "game" | "tool";
  players: { min: number; max: number };
  inputs: InputSource[];
  offline: boolean;
  procedural: boolean;
  status?: "playable" | "foundation" | "planned";
  accent?: string;
  order?: number;
  controllers?: {
    basic: InputSource[];
    enhanced?: InputSource[];
    immersive?: InputSource[];
  };
}

export interface GameInput {
  bind(control: string): void;
  action(name: string, playerId?: string): boolean | number;
  axis(name: string, playerId?: string): number;
  vector(name: string, playerId?: string): InputVector;
  pose(name: string, playerId?: string): ReadonlyArray<number> | undefined;
}

export interface GameContext<State = unknown> {
  input: GameInput;
  state: State;
  assets: {
    load(...urls: string[]): Promise<void>;
  };
}

export interface GameDefinition<State = unknown> {
  id: string;
  initialState: () => State;
  preload?(context: GameContext<State>): Promise<void>;
  start?(context: GameContext<State>): void;
  update(context: GameContext<State>, deltaSeconds: number): void;
  stop?(context: GameContext<State>): void;
}

export interface GameControllerRole {
  id: string;
  label: string;
  playerId: string;
  layout: ControllerLayout;
  requiredCapabilities?: readonly (keyof DeviceCapabilities)[];
  preferredCapabilities?: readonly (keyof DeviceCapabilities)[];
}

export interface GamePackage<State = unknown> {
  manifest: Readonly<GameManifest>;
  input: Readonly<InputManifest>;
  controllers: readonly Readonly<GameControllerRole>[];
  game: Readonly<GameDefinition<State>>;
}

export interface GamePackageDefinition<State = unknown> {
  manifest: unknown;
  input: unknown;
  controllers?: readonly GameControllerRole[];
  game: GameDefinition<State>;
}

export function parseGameManifest(input: unknown): GameManifest {
  if (!isRecord(input)) throw new Error("Game manifest must be an object");
  const id = identifier(input.id, "game id");
  const name = text(input.name, "game name", 80);
  const version = semver(input.version, "game version");
  const engine = typeof input.engine === "string" && /^\^?\d+(?:\.\d+){0,2}$/.test(input.engine)
    ? input.engine
    : (() => { throw new Error("Game engine must be a compatible numeric range such as ^1"); })();
  if (input.renderer !== "2d" && input.renderer !== "3d" && input.renderer !== "video") throw new Error("Game renderer must be 2d, 3d or video");
  const runtime = input.runtime ?? "local";
  if (runtime !== "local" && runtime !== "hosted" && runtime !== "streamed") throw new Error("Invalid game runtime");
  if (runtime === "local" && (input.launchUrl !== undefined || input.inputTarget !== undefined || input.renderer === "video")) {
    throw new Error("A local runtime cannot declare a remote launch, input target or video renderer");
  }
  const launchUrl = input.launchUrl === undefined ? undefined : runtimeUrl(input.launchUrl, "launch URL", ["https:", "http:"]);
  let inputTarget: GameInputTarget | undefined;
  if (input.inputTarget !== undefined) {
    const target = input.inputTarget;
    if (!isRecord(target) || (target.transport !== "webrtc" && target.transport !== "websocket") || target.format !== "101-json") {
      throw new Error("Invalid game input target");
    }
    inputTarget = {
      transport: target.transport,
      endpoint: runtimeUrl(target.endpoint, "input URL", target.transport === "websocket" ? ["wss:", "ws:"] : ["https:", "http:"]),
      format: target.format,
    };
  }
  if (input.surface !== undefined && input.surface !== "game" && input.surface !== "tool") {
    throw new Error("Game surface must be game or tool");
  }
  if (!isRecord(input.players) || !positiveInteger(input.players.min) || !positiveInteger(input.players.max) || Number(input.players.min) > Number(input.players.max) || Number(input.players.max) > 32) {
    throw new Error("Game players must contain a valid min/max range up to 32");
  }
  const inputs = sources(input.inputs, "game inputs", false);
  if (typeof input.offline !== "boolean" || typeof input.procedural !== "boolean") {
    throw new Error("Game offline and procedural flags must be boolean");
  }
  const status = input.status;
  if (status !== undefined && status !== "playable" && status !== "foundation" && status !== "planned") throw new Error("Invalid game status");
  const accent = input.accent === undefined ? undefined : color(input.accent, "game accent");
  const order = input.order === undefined ? undefined : finiteInteger(input.order, "game order", 0, 10_000);
  let controllers: GameManifest["controllers"];
  if (input.controllers !== undefined) {
    if (!isRecord(input.controllers)) throw new Error("Game controllers must be an object");
    controllers = {
      basic: sources(input.controllers.basic, "basic controllers", false),
      ...(input.controllers.enhanced === undefined ? {} : { enhanced: sources(input.controllers.enhanced, "enhanced controllers", true) }),
      ...(input.controllers.immersive === undefined ? {} : { immersive: sources(input.controllers.immersive, "immersive controllers", true) }),
    };
    for (const source of [...controllers.basic, ...(controllers.enhanced ?? []), ...(controllers.immersive ?? [])]) {
      if (!inputs.includes(source)) throw new Error(`Controller source ${source} is not listed in game inputs`);
    }
  }
  return {
    id,
    name,
    ...(input.tagline === undefined ? {} : { tagline: text(input.tagline, "game tagline", 160) }),
    version,
    engine,
    renderer: input.renderer,
    runtime,
    ...(launchUrl ? { launchUrl } : {}),
    ...(inputTarget ? { inputTarget } : {}),
    ...(input.surface === "tool" ? { surface: "tool" as const } : {}),
    players: { min: Number(input.players.min), max: Number(input.players.max) },
    inputs,
    offline: input.offline,
    procedural: input.procedural,
    ...(status ? { status } : {}),
    ...(accent ? { accent } : {}),
    ...(order === undefined ? {} : { order }),
    ...(controllers ? { controllers } : {}),
  };
}

export function defineGamePackage<State>(definition: GamePackageDefinition<State>): GamePackage<State> {
  const manifest = parseGameManifest(definition.manifest);
  const input = parseInputManifest(definition.input);
  if (manifest.id !== input.game || manifest.id !== definition.game.id) {
    throw new Error("Game manifest, input manifest, and game definition IDs must match");
  }
  if (!engineSupportsVersion(manifest.engine, 1)) throw new Error(`Unsupported 101 engine range ${manifest.engine}`);
  if (!manifest.controllers?.basic.length) throw new Error("A playable game package requires conventional basic controllers");
  const controls = inputControls(input);
  const controllers = (definition.controllers ?? []).map((role) => validateRole(role, controls));
  if (controllers.length > manifest.players.max) throw new Error("Controller role count exceeds maximum players");
  if (new Set(controllers.map((role) => role.id)).size !== controllers.length) throw new Error("Controller role IDs must be unique");
  if (new Set(controllers.map((role) => role.playerId)).size !== controllers.length) throw new Error("Controller role player IDs must be unique");
  return deepFreeze({
    manifest,
    input,
    controllers,
    game: { ...definition.game },
  });
}

export function engineSupportsVersion(range: string, major: number) {
  const match = range.match(/^\^?(\d+)(?:\.\d+){0,2}$/);
  return Boolean(match && Number(match[1]) === major);
}

export const Game101 = {
  define<State>(definition: GameDefinition<State>) {
    return Object.freeze(definition);
  },
  package: defineGamePackage,
};

function validateRole(role: GameControllerRole, controls: ReturnType<typeof inputControls>): GameControllerRole {
  const id = identifier(role.id, "controller role id");
  const playerId = identifier(role.playerId, "controller player id");
  const label = text(role.label, "controller role label", 80);
  const layout = parseControllerLayout(role.layout);
  for (const element of layout.layout) {
    // A pad may be declared as either a vector or an axis, because the controller publishes both:
    // `ControllerInputModel.setVector` writes `axes[action] = vector.x` alongside `axes[actionX]`
    // and `axes[actionY]`. TiltDrift relies on exactly that — it renders a `steer` wheel and reads
    // `input.axis("steer")` — and requiring a vector declaration rejected a game that works.
    //
    // Getting this wrong is expensive in a way a first-party game only reveals by accident: this
    // validation is the gate every third-party package passes through, so an over-strict rule here
    // refuses correct games rather than catching broken ones.
    const actionElement = element.type === "button"
      || element.type === "shoulder"
      || element.type === "trigger"
      || element.type === "analog-button";
    const valid = actionElement
      ? controls.actions.has(element.action)
      : element.type === "slider"
        ? controls.axes.has(element.action)
        : controls.vectors.has(element.action) || controls.axes.has(element.action);
    if (!valid) throw new Error(`Controller role ${id} uses undeclared ${element.action}`);
    if ((element.type === "button" || element.type === "shoulder") && element.interaction?.type === "chord") {
      for (const action of element.interaction.actions) {
        if (!controls.actions.has(action)) throw new Error(`Controller role ${id} uses undeclared ${action}`);
      }
    }
  }
  if (layout.motion) {
    if (!controls.axes.has(layout.motion.action) && !controls.vectors.has(layout.motion.action)) {
      throw new Error(`Controller role ${id} uses undeclared motion ${layout.motion.action}`);
    }
    for (const action of Object.values(layout.motion.gestures ?? {})) {
      if (action && !controls.actions.has(action)) throw new Error(`Controller role ${id} uses undeclared gesture ${action}`);
    }
  }
  return {
    id,
    playerId,
    label,
    layout,
    ...(role.requiredCapabilities ? { requiredCapabilities: uniqueCapabilities(role.requiredCapabilities, `${id} required capabilities`) } : {}),
    ...(role.preferredCapabilities ? { preferredCapabilities: uniqueCapabilities(role.preferredCapabilities, `${id} preferred capabilities`) } : {}),
  };
}

function inputControls(input: InputManifest) {
  return {
    actions: new Set(Object.keys(input.actions ?? {})),
    axes: new Set(Object.keys(input.axes ?? {})),
    vectors: new Set(Object.keys(input.vectors ?? {})),
    poses: new Set(Object.keys(input.poses ?? {})),
  };
}

const CAPABILITIES = CAPABILITY_NAMES;

function uniqueCapabilities(input: readonly (keyof DeviceCapabilities)[], label: string) {
  if (!Array.isArray(input) || input.some((value) => !CAPABILITIES.includes(value))) throw new Error(`Invalid ${label}`);
  if (new Set(input).size !== input.length) throw new Error(`Duplicate ${label}`);
  return [...input];
}

function sources(value: unknown, label: string, allowEmpty: boolean): InputSource[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > INPUT_SOURCES.length) throw new Error(`Invalid ${label}`);
  const result = value.map((source) => {
    if (typeof source !== "string" || !INPUT_SOURCES.includes(source as InputSource)) throw new Error(`${label} includes unsupported source ${String(source)}`);
    return source as InputSource;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, label: string) {
  if (typeof value !== "string" || value.length > 128 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function text(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) throw new Error(`Invalid ${label}`);
  return value.trim();
}

function semver(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function positiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0;
}

function finiteInteger(value: unknown, label: string, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${label}`);
  return Number(value);
}

function color(value: unknown, label: string) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function runtimeUrl(value: unknown, label: string, protocols: readonly string[]) {
  if (typeof value !== "string" || value.length > 2048) throw new Error(`Invalid ${label}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${label}`); }
  if (!protocols.includes(url.protocol) || url.username || url.password) throw new Error(`Invalid ${label}`);
  return url.toString();
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
