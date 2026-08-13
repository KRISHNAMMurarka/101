import type { InputVector } from "@101/input";
import type { ControllerLayout } from "@101/protocol";

export interface ControllerInputSnapshot {
  actions: Record<string, boolean | number>;
  axes: Record<string, number>;
  vectors: Record<string, InputVector>;
}

export interface ControllerTransition {
  release: ControllerInputSnapshot;
  current: ControllerInputSnapshot;
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

  constructor(layout?: ControllerLayout) {
    if (layout) this.initialize(layout);
  }

  transition(layout: ControllerLayout): ControllerTransition {
    const release = this.releaseSnapshot();
    this.actions = {};
    this.axes = {};
    this.vectors = {};
    this.initialize(layout);
    return { release, current: this.snapshot() };
  }

  releaseAll() {
    const release = this.releaseSnapshot();
    for (const action of Object.keys(this.actions)) this.actions[action] = false;
    for (const axis of Object.keys(this.axes)) this.axes[axis] = 0;
    for (const vector of Object.keys(this.vectors)) this.vectors[vector] = { x: 0, y: 0 };
    return release;
  }

  setAction(action: string, active: boolean | number) {
    this.actions[action] = active;
    return this.snapshot();
  }

  setAxis(action: string, value: number) {
    this.axes[action] = clamp(value);
    return this.snapshot();
  }

  mergeMotion(actions: Record<string, boolean | number>, axes: Record<string, number> = {}) {
    this.actions = { ...this.actions, ...actions };
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
      if (element.type === "button") this.actions[element.action] = false;
      else if (element.type === "slider") this.axes[element.action] = clamp(((element.min ?? -1) + (element.max ?? 1)) / 2);
      else this.setVector(element.action, 0, 0);
    }
    if (layout.motion) {
      this.setVector(layout.motion.action, 0, 0);
      for (const action of Object.values(layout.motion.gestures ?? {})) {
        if (action) this.actions[action] = false;
      }
    }
  }

  private releaseSnapshot(): ControllerInputSnapshot {
    return {
      actions: Object.fromEntries(Object.keys(this.actions).map((name) => [name, false])),
      axes: Object.fromEntries(Object.keys(this.axes).map((name) => [name, 0])),
      vectors: Object.fromEntries(Object.keys(this.vectors).map((name) => [name, { x: 0, y: 0 }])),
    };
  }
}

function clamp(value: number) {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
}
