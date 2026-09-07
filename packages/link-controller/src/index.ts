import type { InputVector } from "@101/input";
import { orderControllerElements, type ControllerElement, type ControllerLayout } from "@101/protocol";

export interface ControllerInputSnapshot {
  actions: Record<string, boolean | number>;
  axes: Record<string, number>;
  vectors: Record<string, InputVector>;
}

export interface ControllerTransition {
  release: ControllerInputSnapshot;
  current: ControllerInputSnapshot;
}

type DigitalControllerElement = Extract<ControllerElement, { type: "button" | "shoulder" }>;

export interface ControllerActionGestureOptions {
  emit(values: Record<string, boolean | number>): void;
  onActiveChange?(active: boolean): void;
  now?(): number;
  schedule?(callback: () => void, delayMs: number): unknown;
  cancelSchedule?(handle: unknown): void;
}

/**
 * Interprets higher-level button gestures on the controller, before a frame crosses the wire.
 * A chord is emitted as one record so every member lands in the same InputFrame.
 */
export class ControllerActionGesture {
  private readonly element: DigitalControllerElement;
  private readonly emit: ControllerActionGestureOptions["emit"];
  private readonly onActiveChange: NonNullable<ControllerActionGestureOptions["onActiveChange"]>;
  private readonly now: NonNullable<ControllerActionGestureOptions["now"]>;
  private readonly schedule: NonNullable<ControllerActionGestureOptions["schedule"]>;
  private readonly cancelSchedule: NonNullable<ControllerActionGestureOptions["cancelSchedule"]>;
  private physicallyPressed = false;
  private logicallyActive = false;
  private lastTapAt?: number;
  private timer: unknown;
  private timerActive = false;

  constructor(element: DigitalControllerElement, options: ControllerActionGestureOptions) {
    this.element = element;
    this.emit = options.emit;
    this.onActiveChange = options.onActiveChange ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get active() {
    return this.logicallyActive;
  }

  press() {
    if (this.physicallyPressed) return;
    this.physicallyPressed = true;
    const interaction = this.element.interaction;
    if (interaction?.type === "hold") {
      this.onActiveChange(true);
      this.timerActive = true;
      this.timer = this.schedule(() => {
        this.timerActive = false;
        if (!this.physicallyPressed) return;
        this.logicallyActive = true;
        this.emit(this.values(true));
      }, interaction.thresholdMs ?? 450);
      return;
    }
    if (interaction?.type === "double-tap") {
      this.onActiveChange(true);
      const now = this.now();
      if (this.lastTapAt !== undefined && now - this.lastTapAt <= (interaction.intervalMs ?? 300)) {
        this.lastTapAt = undefined;
        this.logicallyActive = true;
        this.emit(this.values(true));
      } else {
        this.lastTapAt = now;
      }
      return;
    }
    if (interaction?.type === "toggle") {
      this.logicallyActive = !this.logicallyActive;
      this.onActiveChange(this.logicallyActive);
      this.emit(this.values(this.logicallyActive));
      return;
    }
    this.logicallyActive = true;
    this.onActiveChange(true);
    this.emit(this.values(true));
  }

  release() {
    if (!this.physicallyPressed) return;
    this.physicallyPressed = false;
    const interaction = this.element.interaction;
    if (interaction?.type === "hold") {
      this.clearPendingTimer();
      if (this.logicallyActive) this.emit(this.values(false));
      this.logicallyActive = false;
      this.onActiveChange(false);
      return;
    }
    if (interaction?.type === "double-tap") {
      if (this.logicallyActive) this.emit(this.values(false));
      this.logicallyActive = false;
      this.onActiveChange(false);
      return;
    }
    if (interaction?.type === "toggle") return;
    if (this.logicallyActive) this.emit(this.values(false));
    this.logicallyActive = false;
    this.onActiveChange(false);
  }

  cancel() {
    this.clearPendingTimer();
    this.physicallyPressed = false;
    this.lastTapAt = undefined;
    if (this.logicallyActive) this.emit(this.values(false));
    this.logicallyActive = false;
    this.onActiveChange(false);
  }

  private clearPendingTimer() {
    if (!this.timerActive) return;
    this.cancelSchedule(this.timer);
    this.timerActive = false;
    this.timer = undefined;
  }

  private values(active: boolean) {
    const actions = this.element.interaction?.type === "chord"
      ? [this.element.action, ...this.element.interaction.actions]
      : [this.element.action];
    return Object.fromEntries(actions.map((action) => [action, active]));
  }
}

/** Applies dead zone and response curve by magnitude, then clamps to the unit circle. */
export function normalizeJoystick(x: number, y: number, deadZone = .12, responseCurve = 1): InputVector {
  const nextX = clamp(x);
  const nextY = clamp(y);
  const magnitude = Math.hypot(nextX, nextY);
  const zone = clampRange(deadZone, 0, .95, .12);
  if (magnitude <= zone || magnitude === 0) return { x: 0, y: 0 };
  const curve = clampRange(responseCurve, .25, 4, 1);
  const radialMagnitude = Math.min(1, magnitude);
  const normalizedMagnitude = (radialMagnitude - zone) / (1 - zone);
  const curvedMagnitude = Math.pow(normalizedMagnitude, curve);
  const scale = curvedMagnitude / magnitude;
  return { x: nextX * scale, y: nextY * scale };
}

export function resolveControllerSide(
  side: ControllerElement["side"],
  authoredHandedness: ControllerLayout["handedness"] = "right",
  playerHandedness: ControllerLayout["handedness"] = authoredHandedness,
) {
  const resolved = side ?? "center";
  if (resolved === "center" || authoredHandedness === playerHandedness) return resolved;
  return resolved === "left" ? "right" : "left";
}

/**
 * Owns the normalized state emitted by 101 Link. Keeping this separate from the
 * React view makes role changes atomic and prevents held controls from leaking
 * from one game panel into the next.
 */
export class ControllerInputModel {
  private actions: Record<string, boolean | number> = {};
  private axes: Record<string, number> = {};
  private vectors: Record<string, InputVector> = {};
  private readonly actionKinds = new Map<string, "digital" | "analog" | "number">();
  private readonly actionContributions = new Map<string, Map<string, boolean | number>>();

  constructor(layout?: ControllerLayout) {
    if (layout) this.initialize(layout);
  }

  transition(layout: ControllerLayout): ControllerTransition {
    const release = this.releaseSnapshot();
    this.actions = {};
    this.axes = {};
    this.vectors = {};
    this.actionKinds.clear();
    this.actionContributions.clear();
    this.initialize(layout);
    return { release, current: this.snapshot() };
  }

  releaseAll() {
    const release = this.releaseSnapshot();
    this.actionContributions.clear();
    for (const [action, value] of Object.entries(this.actions)) this.actions[action] = typeof value === "number" ? 0 : false;
    for (const axis of Object.keys(this.axes)) this.axes[axis] = 0;
    for (const vector of Object.keys(this.vectors)) this.vectors[vector] = { x: 0, y: 0 };
    return release;
  }

  setAction(action: string, active: boolean | number, owner = "direct") {
    return this.setActions({ [action]: active }, owner);
  }

  setActions(values: Record<string, boolean | number>, owner = "direct") {
    for (const [action, rawValue] of Object.entries(values)) {
      const kind = this.actionKinds.get(action) ?? (typeof rawValue === "boolean" ? "digital" : "number");
      this.actionKinds.set(action, kind);
      const value = kind === "analog"
        ? clampRange(typeof rawValue === "number" ? rawValue : Number(rawValue), 0, 1, 0)
        : kind === "digital"
          ? Boolean(rawValue)
          : rawValue;
      const contributions = this.actionContributions.get(action) ?? new Map<string, boolean | number>();
      // Reinsert so an untyped numeric action remains last-writer-wins while digital and analog
      // actions can safely combine contributions from multiple physical controls.
      contributions.delete(owner);
      contributions.set(owner, value);
      this.actionContributions.set(action, contributions);
      this.actions[action] = kind === "digital"
        ? [...contributions.values()].some(Boolean)
        : kind === "analog"
          ? Math.max(0, ...[...contributions.values()].map((entry) => typeof entry === "number" ? entry : Number(entry)))
          : [...contributions.values()].at(-1) ?? value;
    }
    return this.snapshot();
  }

  setAxis(action: string, value: number) {
    this.axes[action] = clamp(value);
    return this.snapshot();
  }

  mergeMotion(actions: Record<string, boolean | number>, axes: Record<string, number> = {}) {
    this.setActions(actions, "motion");
    this.axes = { ...this.axes, ...Object.fromEntries(Object.entries(axes).map(([name, value]) => [name, clamp(value)])) };
    return this.snapshot();
  }

  setVector(action: string, x: number, y: number) {
    const vector = { x: clamp(x), y: clamp(y) };
    this.vectors[action] = vector;
    this.axes[action] = vector.x;
    this.axes[`${action}X`] = vector.x;
    this.axes[`${action}Y`] = vector.y;
    if (action === "move") {
      this.axes.moveX = vector.x;
      this.axes.moveY = vector.y;
    }
    if (action === "steer") this.axes.steer = vector.x;
    return this.snapshot();
  }

  snapshot(): ControllerInputSnapshot {
    return {
      actions: { ...this.actions },
      axes: { ...this.axes },
      vectors: Object.fromEntries(Object.entries(this.vectors).map(([name, vector]) => [name, { ...vector }])),
    };
  }

  private initialize(layout: ControllerLayout) {
    for (const element of layout.layout) {
      if (element.type === "button" || element.type === "shoulder") this.actionKinds.set(element.action, "digital");
      else if (element.type === "trigger" || element.type === "analog-button") this.actionKinds.set(element.action, "analog");
    }
    for (const element of layout.layout) {
      if (element.type === "button" || element.type === "shoulder") {
        this.actions[element.action] = false;
        if (element.interaction?.type === "chord") {
          for (const action of element.interaction.actions) {
            if (!this.actionKinds.has(action)) this.actionKinds.set(action, "digital");
            this.actions[action] = this.actionKinds.get(action) === "analog" ? 0 : false;
          }
        }
      }
      else if (element.type === "trigger" || element.type === "analog-button") this.actions[element.action] = 0;
      else if (element.type === "slider") this.axes[element.action] = clamp(((element.min ?? -1) + (element.max ?? 1)) / 2);
      else this.setVector(element.action, 0, 0);
    }
    if (layout.motion) {
      this.setVector(layout.motion.action, 0, 0);
      for (const action of Object.values(layout.motion.gestures ?? {})) {
        if (action) {
          if (!this.actionKinds.has(action)) this.actionKinds.set(action, "digital");
          this.actions[action] = this.actionKinds.get(action) === "analog" ? 0 : false;
        }
      }
    }
  }

  private releaseSnapshot(): ControllerInputSnapshot {
    return {
      actions: Object.fromEntries(Object.entries(this.actions).map(([name, value]) => [name, typeof value === "number" ? 0 : false])),
      axes: Object.fromEntries(Object.keys(this.axes).map((name) => [name, 0])),
      vectors: Object.fromEntries(Object.keys(this.vectors).map((name) => [name, { x: 0, y: 0 }])),
    };
  }
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}

function clampRange(value: number, min: number, max: number, fallback: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
}

/* ---- Deck planning ----------------------------------------------------------------------------
 *
 * Where each control goes, decided once, in a module that can be tested.
 *
 * The browser deck used to place controls by writing an inline `grid-column` per element: left
 * elements started at line 1, right elements ended at line -1. Two controls on the same side
 * therefore always claimed overlapping tracks and could never sit beside each other — a six-button
 * layout stacked them into a deck taller than the phone. And because the deck was a flex child with
 * stretched auto rows, every control's aspect ratio was a function of how much chrome happened to be
 * on screen: adding a status row changed the shape of the d-pad.
 *
 * So the arrangement is computed from the elements alone, never from available height, and the
 * result is three clusters of three groups. A renderer lays out clusters; it does not decide
 * placement. This is also the only shape this repo can test — `node --experimental-strip-types`
 * cannot import a .tsx file, but it already imports every game's roles.ts.
 */

export type DeckSide = "left" | "center" | "right";
export type DeckGroup = "bars" | "pads" | "keys";

export interface PlacedControl {
  readonly element: ControllerElement;
  /** Resolved once here, so ordering and styling can never disagree about an undeclared zone. */
  readonly side: DeckSide;
  readonly zone: NonNullable<ControllerElement["zone"]>;
  readonly size: NonNullable<ControllerElement["size"]>;
  readonly group: DeckGroup;
  /**
   * How many columns of its group this control takes.
   *
   * `span` used to pick absolute grid lines across the whole deck, which is what made two controls
   * on one side overlap. It now means what an author would expect it to mean — this control is
   * twice as wide as its neighbours — within its own group. Kept rather than dropped because games
   * declare it (TiltDrift's wheel is `span: 2`), and a schema field nothing reads is a field that
   * silently stops working.
   */
  readonly span: number;
}

export interface DeckCluster {
  readonly side: DeckSide;
  readonly bars: readonly PlacedControl[];
  readonly pads: readonly PlacedControl[];
  readonly keys: readonly PlacedControl[];
  /** How much of the deck's width this cluster asks for, relative to the other side. */
  readonly weight: number;
  readonly count: number;
}

export interface ControllerDeckPlan {
  readonly left: DeckCluster;
  readonly center: DeckCluster;
  readonly right: DeckCluster;
}

export function defaultControlSide(element: ControllerElement): DeckSide {
  if (element.type === "joystick" || element.type === "dpad" || element.type === "touch-surface") return "left";
  if (element.type === "slider") return "center";
  return "right";
}

export function defaultControlZone(element: ControllerElement): NonNullable<ControllerElement["zone"]> {
  if (element.type === "shoulder") return "shoulder";
  if (element.type === "trigger") return "index";
  if (element.type === "slider") return "edge";
  return "thumb";
}

export function defaultControlSize(element: ControllerElement): NonNullable<ControllerElement["size"]> {
  if (element.type === "joystick" || element.type === "touch-surface" || element.type === "dpad") return "large";
  if (element.type === "shoulder" || element.type === "trigger") return "small";
  return "medium";
}

/**
 * Which row of a cluster a control belongs in.
 *
 * Bars sit at the top, under an index finger; pads in the middle; keys at the bottom, under the
 * thumb — which is the order a hand actually meets them, from the back of the phone forwards.
 */
function groupFor(element: ControllerElement, zone: NonNullable<ControllerElement["zone"]>): DeckGroup {
  if (element.type === "dpad" || element.type === "joystick" || element.type === "touch-surface") return "pads";
  if (element.type === "shoulder" || element.type === "trigger" || element.type === "analog-button") return "bars";
  if (element.type === "slider") return "bars";
  return zone === "shoulder" || zone === "index" ? "bars" : "keys";
}

/**
 * How wide a cluster asks to be, from how much it holds.
 *
 * The same curve the native app already uses, so a layout does not change shape between the two
 * renderers. Bounded at both ends: a single control must not take the whole width, and seven must
 * not squeeze the other side to nothing.
 */
export function clusterWeight(count: number) {
  if (count === 0) return 0;
  return Math.max(0.8, Math.min(1.8, 0.2 + count * 0.22));
}

/**
 * Mirror the deck for a left-handed player.
 *
 * `authoredHandedness` is what the layout was drawn for; `playerHandedness` is what this player set.
 * When they disagree, sides swap — which is the whole point of the preference, and is more than the
 * cosmetic reordering it drove before.
 */
export function planControllerDeck(
  elements: readonly ControllerElement[],
  options: { authoredHandedness?: "left" | "right"; playerHandedness?: "left" | "right" } = {},
): ControllerDeckPlan {
  const mirror = Boolean(options.playerHandedness && options.authoredHandedness
    && options.playerHandedness !== options.authoredHandedness);

  const placed: PlacedControl[] = orderControllerElements(elements, (element) => element).map((element) => {
    const declared = element.side ?? defaultControlSide(element);
    const side: DeckSide = mirror && declared !== "center"
      ? declared === "left" ? "right" : "left"
      : declared;
    const zone = element.zone ?? defaultControlZone(element);
    return {
      element,
      side,
      zone,
      size: element.size ?? defaultControlSize(element),
      group: groupFor(element, zone),
      // Bounded: a span wider than a cluster would push its neighbours out of the deck.
      span: Math.max(1, Math.min(3, Math.round(element.span ?? 1))),
    };
  });

  const cluster = (side: DeckSide): DeckCluster => {
    const mine = placed.filter((control) => control.side === side);
    return {
      side,
      bars: mine.filter((control) => control.group === "bars"),
      pads: mine.filter((control) => control.group === "pads"),
      keys: mine.filter((control) => control.group === "keys"),
      weight: clusterWeight(mine.length),
      count: mine.length,
    };
  };

  return { left: cluster("left"), center: cluster("center"), right: cluster("right") };
}

/** The four directions a cross can report, and the vector each one sends. */
export const DPAD_DIRECTIONS = {
  up: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
} as const;

export type DpadDirection = keyof typeof DPAD_DIRECTIONS;

/**
 * How far from the centre a thumb must be before the pad reports a direction. Without it the exact
 * centre resolves to `right` on a tie, so resting a thumb in the middle walks the player sideways.
 */
export const DPAD_DEAD_ZONE = 0.18;

/**
 * Which direction a thumb at (x, y) is asking for, in normalised pad coordinates where the centre
 * is 0 and each edge is ±1.
 *
 * The pad used to be four independent buttons, each releasing on `pointerleave`. That drops the
 * input the moment a thumb drifts a pixel past a cell edge, and it makes rolling from up to left —
 * which is how a cross is actually used — register as a release rather than a turn. Resolving
 * position to the nearer axis instead means a roll is continuous and a press ends only on lift.
 */
export function readDpadDirection(x: number, y: number): DpadDirection | undefined {
  if (Math.hypot(x, y) < DPAD_DEAD_ZONE) return undefined;
  return Math.abs(x) >= Math.abs(y) ? (x < 0 ? "left" : "right") : (y < 0 ? "up" : "down");
}
