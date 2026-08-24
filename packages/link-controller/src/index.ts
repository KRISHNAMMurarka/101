import type { InputVector } from "@101/input";
import type { ControllerElement, ControllerLayout } from "@101/protocol";

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
