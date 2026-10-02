export type PointerPosition = Readonly<{ x: number; y: number }>;
export interface PointerSourceDriverOptions {
  publish: (capability: string, value: PointerPosition | boolean, metadata: Readonly<{ capturedAt: number }>) => boolean;
  now: () => number;
  positionCapability?: string;
  contactCapability?: string;
  initial?: PointerPosition;
  sampleHz?: number;
  heartbeatMs?: number;
}
export type PointerSourceState = Readonly<{
  position: PointerPosition;
  contact: boolean;
  stopped: boolean;
  /** Last individual publisher admission; this is not a receipt or an application effect. */
  lastAdmission: boolean;
}>;
type Anchor = { id: number; x: number; y: number; width: number; height: number };
const validId = (id: number) => Number.isSafeInteger(id) && id >= 0;
const geometry = (x: number, y: number, width: number, height: number) =>
  [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Pure relative input producer. The caller owns tick scheduling and transport lifecycle.
 * Boolean methods return false for invalid/terminal/reentrant input or any rejected
 * publication attempted by that operation. A valid coalesced local update returns
 * true when no publication is due. lastAdmission describes only the last callback.
 */
export class PointerSourceDriver {
  private readonly publishCallback: PointerSourceDriverOptions['publish'];
  private readonly clock: PointerSourceDriverOptions['now'];
  private readonly positionCapability: string;
  private readonly contactCapability: string;
  private readonly sampleInterval: number;
  private readonly heartbeatMs: number;
  private position: { x: number; y: number };
  private contact = false;
  private stopped = false;
  private lastAdmission = false;
  private anchor?: Anchor;
  private lastTime?: number;
  private positionAttempt?: number;
  private contactAttempt?: number;
  private pendingPosition?: number;
  private pendingContact?: number;
  private publishing = false;
  private readingClock = false;
  private releasing = false;
  private releasePending = false;

  constructor(options: PointerSourceDriverOptions) {
    const initial = options.initial ?? { x: 0.5, y: 0.5 };
    const sampleHz = options.sampleHz ?? 60;
    const heartbeatMs = options.heartbeatMs ?? 50;
    const positionCapability = options.positionCapability ?? 'position';
    const contactCapability = options.contactCapability ?? 'contact';
    if (!Number.isFinite(sampleHz) || sampleHz < 1 || sampleHz > 60 ||
      !Number.isFinite(heartbeatMs) || heartbeatMs < 20 || heartbeatMs > 50 || 1000 / sampleHz > heartbeatMs ||
      ![initial.x, initial.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      typeof positionCapability !== 'string' || !positionCapability.trim() ||
      typeof contactCapability !== 'string' || !contactCapability.trim()) throw new RangeError('Invalid pointer driver options');
    if (typeof options.publish !== 'function' || typeof options.now !== 'function') throw new TypeError('Pointer callbacks required');
    this.publishCallback = options.publish;
    this.clock = options.now;
    this.positionCapability = positionCapability;
    this.contactCapability = contactCapability;
    this.sampleInterval = 1000 / sampleHz;
    this.heartbeatMs = heartbeatMs;
    this.position = { x: initial.x, y: initial.y };
  }

  begin(pointerId: number, x: number, y: number, width: number, height: number): boolean {
    if (!this.usable() || !validId(pointerId) || !geometry(x, y, width, height) || this.anchor) return false;
    const time = this.readTime(); if (time === undefined) return false;
    this.anchor = { id: pointerId, x, y, width, height };
    this.changeContact(true, time);
    return this.flush(time, true);
  }

  move(pointerId: number, x: number, y: number, width: number, height: number): boolean {
    if (!this.usable() || !validId(pointerId) || !geometry(x, y, width, height) || this.anchor?.id !== pointerId) return false;
    const time = this.readTime(); if (time === undefined) return false;
    const anchor = this.anchor;
    // Pad resize establishes a fresh local anchor, never a target movement.
    if (anchor.width === width && anchor.height === height) this.changePosition((x - anchor.x) / width, (y - anchor.y) / height, time);
    this.anchor = { id: pointerId, x, y, width, height };
    return this.flush(time);
  }

  end(pointerId: number): boolean {
    if (!this.usable() || !validId(pointerId) || this.anchor?.id !== pointerId) return false;
    const time = this.readTime(); if (time === undefined) return false;
    this.anchor = undefined;
    this.changeContact(false, time);
    return this.flush(time, true);
  }

  nudge(dx: number, dy: number): boolean {
    if (!this.usable() || !Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const time = this.readTime(); if (time === undefined) return false;
    this.changePosition(dx, dy, time);
    return this.flush(time);
  }

  setContact(active: boolean): boolean {
    if (!this.usable() || typeof active !== 'boolean') return false;
    const time = this.readTime(); if (time === undefined) return false;
    const changed = this.contact !== active;
    this.changeContact(active, time);
    return this.flush(time, changed);
  }

  release(): void {
    if (this.stopped || this.releasing) return;
    const time = this.publishing || this.readingClock ? this.lastTime ?? 0 : this.readTime();
    if (time === undefined) return;
    this.anchor = undefined;
    this.changeContact(false, time);
    this.releasePending = true;
    this.flushRelease(time);
  }

  tick(): void {
    if (!this.usable()) return;
    const time = this.readTime(); if (time !== undefined) this.flush(time);
  }

  stop(): void {
    if (this.stopped) return;
    // A nested callback uses the already validated time rather than reading again.
    const time = this.publishing || this.readingClock ? this.lastTime ?? 0 : this.readTime();
    if (time !== undefined) this.terminate(time);
  }

  state(): PointerSourceState {
    return Object.freeze({ position: Object.freeze({ ...this.position }), contact: this.contact,
      stopped: this.stopped, lastAdmission: this.lastAdmission });
  }

  private usable(): boolean { return !this.stopped && !this.publishing && !this.readingClock; }

  private readTime(): number | undefined {
    let time: number;
    this.readingClock = true;
    try { time = this.clock(); } catch { this.terminate(this.lastTime ?? 0); return undefined; }
    finally { this.readingClock = false; }
    if (this.stopped) return undefined;
    if (!Number.isFinite(time) || time < 0 || (this.lastTime !== undefined && time < this.lastTime)) {
      this.terminate(this.lastTime ?? 0); return undefined;
    }
    this.lastTime = time;
    return time;
  }

  private changePosition(dx: number, dy: number, time: number): void {
    const x = clamp(this.position.x + dx), y = clamp(this.position.y + dy);
    if (x !== this.position.x || y !== this.position.y) {
      this.position = { x, y };
      this.pendingPosition = time;
    }
  }

  private changeContact(active: boolean, time: number): void {
    if (active !== this.contact) { this.contact = active; this.pendingContact = time; }
  }

  private flush(time: number, forceContact = false): boolean {
    let admitted = true;
    const elapsed = this.positionAttempt === undefined ? Infinity : time - this.positionAttempt;
    if (elapsed >= this.sampleInterval && (this.positionAttempt === undefined || this.pendingPosition !== undefined || elapsed >= this.heartbeatMs)) {
      this.positionAttempt = time;
      const capturedAt = this.pendingPosition ?? time;
      // Initial or idle state rejected by transport must also keep its capture time.
      this.pendingPosition = capturedAt;
      const accepted = this.emit(this.positionCapability, Object.freeze({ ...this.position }), capturedAt);
      if (accepted) this.pendingPosition = undefined;
      admitted = accepted;
    }
    if (this.stopped) return false;
    if (forceContact || this.contactAttempt === undefined || time - this.contactAttempt >= this.heartbeatMs) {
      this.contactAttempt = time;
      const capturedAt = this.pendingContact ?? time;
      this.pendingContact = capturedAt;
      const accepted = this.emit(this.contactCapability, this.contact, capturedAt);
      if (accepted) this.pendingContact = undefined;
      admitted = admitted && accepted;
    }
    return admitted && !this.stopped;
  }

  private emit(capability: string, value: PointerPosition | boolean, capturedAt: number): boolean {
    this.publishing = true;
    let admitted = false;
    try { admitted = this.publishCallback(capability, value, Object.freeze({ capturedAt })) === true; }
    catch { this.terminate(this.lastTime ?? capturedAt); }
    finally { this.publishing = false; }
    this.lastAdmission = admitted;
    this.flushRelease(this.lastTime ?? capturedAt);
    return admitted;
  }

  private terminate(time: number): void {
    if (this.stopped) return;
    this.stopped = true;
    this.anchor = undefined;
    this.contact = false;
    this.pendingContact = time;
    if (!this.releasing) this.releasePending = true;
    this.flushRelease(time);
  }

  private flushRelease(time: number): void {
    if (!this.releasePending || this.publishing || this.releasing) return;
    this.releasePending = false;
    this.releasing = true;
    this.contactAttempt = time;
    const accepted = this.emit(this.contactCapability, false, this.pendingContact ?? time);
    if (accepted) this.pendingContact = undefined;
    this.releasing = false;
  }
}
