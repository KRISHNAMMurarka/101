import { getInputProfile, parseSignalValue } from '@101/device-model';
import type { TouchContact } from './touch-contact-driver.ts';

export interface GestureTransition {
  readonly gestureId: number; readonly kind: 'tap' | 'press' | 'drag' | 'scroll';
  readonly phase: 'start' | 'end' | 'cancel'; readonly position: Readonly<{ x: number; y: number }>;
}
export interface GestureWheel {
  readonly x: number; readonly y: number; readonly z: number; readonly mode: 'pixel' | 'line' | 'page';
  readonly modifiers: Readonly<{ shift: boolean; control: boolean; alt: boolean; meta: boolean }>;
}
export interface GestureSurface { readonly width: number; readonly height: number }
export interface GestureSourceOptions {
  now: () => number;
  /** Admission only. A host must release its consumer when any required route disconnects. */
  publish: (capability: 'gesture' | 'position' | 'wheel', value: GestureTransition | GestureWheel | GestureTransition['position'], metadata: Readonly<{ capturedAt: number }>) => boolean;
  sampleHz?: number; pressMs?: number; dragPixels?: number;
}
const gestureCapabilities = getInputProfile('app:gesture/1').capabilities;
export const GESTURE_TRANSITION_SCHEMA = gestureCapabilities[0]!.value;
export const GESTURE_WHEEL_SCHEMA = gestureCapabilities[2]!.value;
const contactSchema = getInputProfile('app:touch/1').capabilities[0]!.value;
const noModifiers = Object.freeze({ shift: false, control: false, alt: false, meta: false });
type Held = { value: TouchContact; origin: TouchContact['position']; since: number; suppressed: boolean };
type WheelBatch = { value: GestureWheel; capturedAt: number };

/**
 * Pure interpreter for selected normalized contacts. Caller owns tick scheduling.
 * Only gesture transitions are reliable; positions coalesce at 10–60Hz. Wheel deltas
 * batch at that rate without crossing unit/modifier boundaries. End/cancel drains
 * at most 64 reliable batches immediately before the transition, including on cleanup.
 */
export class GestureSourceDriver {
  private readonly options: GestureSourceOptions;
  private readonly interval: number;
  private readonly pressMs: number;
  private readonly dragPixels: number;
  private readonly held = new Map<string, Held>();
  private readonly wheels: WheelBatch[] = [];
  private active?: GestureTransition;
  private surface?: GestureSurface;
  private pendingPosition?: { value: GestureTransition['position']; capturedAt: number };
  private lastPosition = -Infinity;
  private lastWheel = -Infinity;
  private lastTime = 0;
  private sequence = 0;
  private stopped = false;
  private busy = false;
  private releasing = false;
  private releasePending = false;
  constructor(options: GestureSourceOptions) {
    const sampleHz = options.sampleHz ?? 60, pressMs = options.pressMs ?? 500, dragPixels = options.dragPixels ?? 8;
    if (typeof options.now !== 'function' || typeof options.publish !== 'function') throw new TypeError('Gesture callbacks required');
    if (!Number.isFinite(sampleHz) || sampleHz < 10 || sampleHz > 60 || !Number.isFinite(pressMs) || pressMs < 100 || pressMs > 2000 ||
      !Number.isFinite(dragPixels) || dragPixels < 1 || dragPixels > 64) throw new RangeError('Invalid gesture options');
    this.options = { ...options }; this.interval = 1000 / sampleHz; this.pressMs = pressMs; this.dragPixels = dragPixels;
  }
  state(): Readonly<{ contacts: readonly TouchContact[]; active?: GestureTransition; stopped: boolean; pendingWheelBatches: number }> {
    return Object.freeze({ contacts: Object.freeze([...this.held.values()].map(contact => contact.value)), active: this.active,
      stopped: this.stopped, pendingWheelBatches: this.wheels.length });
  }
  contact(input: unknown, surface: GestureSurface): boolean {
    return this.operation(() => {
      if (![surface.width, surface.height].every(value => Number.isFinite(value) && value > 0 && value <= 100000)) throw new RangeError('Invalid gesture surface');
      const changed = this.surface && (surface.width !== this.surface.width || surface.height !== this.surface.height);
      this.surface = Object.freeze({ width: surface.width, height: surface.height });
      if (changed && this.held.size) { this.release(); return false; }
      const value = parseSignalValue(input, contactSchema) as unknown as TouchContact;
      const owned = this.held.get(value.id);
      if (value.phase === 'down') {
        if (owned || this.held.size >= 32) throw new RangeError('Gesture contact ownership limit');
        this.held.set(value.id, { value, origin: value.position, since: this.lastTime, suppressed: false });
        if (this.held.size >= 2) {
          for (const contact of this.held.values()) contact.suppressed = true;
          if (this.active?.kind !== 'scroll') {
            if (!this.finish('cancel', this.active?.position)) return false;
            if (!this.start('scroll', this.centroid())) return false;
          } else this.active = Object.freeze({ ...this.active, position: this.centroid() });
          this.position(this.centroid());
        } else this.position(value.position);
        return this.flushPosition();
      }
      if (!owned) return true;
      owned.value = Object.freeze({ ...value, primary: owned.value.primary });
      if (value.phase === 'move') {
        if (this.active?.kind === 'scroll') {
          const point = this.centroid(), previous = this.active.position;
          this.active = Object.freeze({ ...this.active, position: point });
          this.appendWheel(this.parseWheel({ x: -(point.x - previous.x) * surface.width,
            y: -(point.y - previous.y) * surface.height, z: 0, mode: 'pixel', modifiers: noModifiers }));
          this.position(point);
          return this.flushWheel() && this.flushPosition();
        }
        if (owned.suppressed) return true;
        this.position(value.position);
        if (this.distance(owned) >= this.dragPixels && this.active?.kind !== 'drag') {
          if (!this.finish('cancel', value.position) || !this.start('drag', value.position)) return false;
        } else if (!this.press(owned)) return false;
        if (this.active) this.active = Object.freeze({ ...this.active, position: value.position });
        return this.flushPosition();
      }
      if (this.active?.kind === 'scroll') {
        this.held.delete(value.id);
        if (value.phase === 'cancel' || this.held.size < 2) return this.finish(value.phase === 'cancel' ? 'cancel' : 'end', this.active.position);
        this.active = Object.freeze({ ...this.active, position: this.centroid() }); return true;
      }
      if (owned.suppressed) { this.held.delete(value.id); return true; }
      if (value.phase === 'cancel') {
        this.held.delete(value.id); return this.finish('cancel', value.position);
      }
      if (this.distance(owned) >= this.dragPixels && this.active?.kind !== 'drag') {
        if (!this.finish('cancel', value.position) || !this.start('drag', value.position)) return false;
      }
      if (!this.press(owned)) return false;
      if (this.active) {
        if (!this.finish('end', value.position)) return false;
      } else {
        const tap = this.transition(this.id(), 'tap', 'end', value.position);
        if (!this.emit('gesture', tap, this.lastTime)) return false;
      }
      this.held.delete(value.id); return true;
    });
  }
  wheel(input: unknown): boolean {
    return this.operation(() => { this.appendWheel(this.parseWheel(input)); return this.flushWheel(); });
  }
  tick(): void {
    this.operation(() => {
      if (this.held.size === 1) { const owned = this.held.values().next().value!; if (!this.press(owned)) return false; }
      return this.flushWheel() && this.flushPosition();
    });
  }
  release(): void {
    if (this.releasing) return;
    this.releasePending = true;
    if (!this.busy && (this.held.size || this.active || this.wheels.length)) {
      this.busy = true;
      try { this.readTime(); } catch { this.stopped = true; }
      finally { this.busy = false; }
    }
    this.flushRelease();
  }
  stop(): void { if (this.stopped) return; this.stopped = true; this.release(); }
  private operation(action: () => boolean): boolean {
    if (this.stopped || this.busy || this.releasing) return false;
    this.busy = true; let admitted = false;
    try { this.readTime(); if (!this.stopped && !this.releasePending) admitted = action(); }
    catch { this.stop(); }
    finally { this.busy = false; this.flushRelease(); }
    return admitted && !this.stopped;
  }
  private readTime(): void {
    const time = this.options.now();
    if (!Number.isFinite(time) || time < this.lastTime) throw new RangeError('Invalid gesture clock');
    this.lastTime = time;
  }
  private emit(capability: 'gesture' | 'position' | 'wheel', value: GestureTransition | GestureWheel | GestureTransition['position'], capturedAt: number): boolean {
    if (this.options.publish(capability, value, Object.freeze({ capturedAt })) !== true) { this.stop(); return false; }
    return !this.stopped && !this.releasePending;
  }
  private id(): number { if (!Number.isSafeInteger(++this.sequence)) throw new RangeError('Gesture identity exhausted'); return this.sequence; }
  private transition(gestureId: number, kind: GestureTransition['kind'], phase: GestureTransition['phase'], position: GestureTransition['position']): GestureTransition {
    return parseSignalValue({ gestureId, kind, phase, position }, GESTURE_TRANSITION_SCHEMA) as unknown as GestureTransition;
  }
  private start(kind: Exclude<GestureTransition['kind'], 'tap'>, position: GestureTransition['position']): boolean {
    this.active = this.transition(this.id(), kind, 'start', position);
    return this.emit('gesture', this.active, this.lastTime);
  }
  private finish(phase: 'end' | 'cancel', position?: GestureTransition['position']): boolean {
    if (!this.active) return true;
    this.active = Object.freeze({ ...this.active, position: position ?? this.active.position });
    if (this.active.kind === 'scroll' && !this.flushWheel(true)) return false;
    const value = this.transition(this.active.gestureId, this.active.kind, phase, this.active.position);
    if (!this.emit('gesture', value, this.lastTime)) return false;
    this.active = undefined; return true;
  }
  private press(owned: Held): boolean {
    if (!this.active && !owned.suppressed && this.lastTime - owned.since >= this.pressMs) return this.start('press', owned.value.position);
    return true;
  }
  private distance(owned: Held): number {
    return Math.hypot((owned.value.position.x - owned.origin.x) * this.surface!.width, (owned.value.position.y - owned.origin.y) * this.surface!.height);
  }
  private centroid(): GestureTransition['position'] {
    const values = [...this.held.values()];
    return Object.freeze({ x: values.reduce((sum, value) => sum + value.value.position.x, 0) / values.length,
      y: values.reduce((sum, value) => sum + value.value.position.y, 0) / values.length });
  }
  private position(value: GestureTransition['position']): void { this.pendingPosition = { value, capturedAt: this.lastTime }; }
  private flushPosition(): boolean {
    if (!this.pendingPosition || this.lastTime - this.lastPosition < this.interval) return true;
    this.lastPosition = this.lastTime;
    if (!this.emit('position', this.pendingPosition.value, this.pendingPosition.capturedAt)) return false;
    this.pendingPosition = undefined; return true;
  }
  private parseWheel(input: unknown): GestureWheel { return parseSignalValue(input, GESTURE_WHEEL_SCHEMA) as unknown as GestureWheel; }
  private appendWheel(value: GestureWheel): void {
    if (value.x === 0 && value.y === 0 && value.z === 0) return;
    const previous = this.wheels.at(-1);
    if (previous && previous.value.mode === value.mode && (['shift', 'control', 'alt', 'meta'] as const).every(name => previous.value.modifiers[name] === value.modifiers[name])) {
      const sum = { ...value, x: previous.value.x + value.x, y: previous.value.y + value.y, z: previous.value.z + value.z };
      if ([sum.x, sum.y, sum.z].every(delta => Math.abs(delta) <= 100000)) { previous.value = this.parseWheel(sum); return; }
    }
    if (this.wheels.length >= 64) throw new RangeError('Gesture wheel queue limit');
    this.wheels.push({ value, capturedAt: this.lastTime });
  }
  private flushWheel(force = false): boolean {
    if (!this.wheels.length || (!force && this.lastTime - this.lastWheel < this.interval)) return true;
    do {
      const batch = this.wheels.shift()!; this.lastWheel = this.lastTime;
      if (!this.emit('wheel', batch.value, batch.capturedAt)) return false;
    } while (force && this.wheels.length);
    return true;
  }
  private flushRelease(): void {
    if (!this.releasePending || this.busy || this.releasing) return;
    this.releasePending = false; this.releasing = true;
    const batches = this.wheels.splice(0), active = this.active;
    this.held.clear(); this.active = undefined; this.pendingPosition = undefined;
    for (const batch of batches) {
      try { if (this.options.publish('wheel', batch.value, Object.freeze({ capturedAt: batch.capturedAt })) !== true) this.stopped = true; }
      catch { this.stopped = true; }
    }
    if (active) {
      try { if (this.options.publish('gesture', this.transition(active.gestureId, active.kind, 'cancel', active.position), Object.freeze({ capturedAt: this.lastTime })) !== true) this.stopped = true; }
      catch { this.stopped = true; }
    }
    this.releasing = false;
  }
}
