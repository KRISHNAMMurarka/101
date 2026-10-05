import { getInputProfile, parseDeviceDescriptor, parseSignalValue } from '@101/device-model';
import type { DeviceDescriptor } from '@101/device-model';

export interface TouchContact {
  readonly id: string;
  readonly phase: 'down' | 'move' | 'up' | 'cancel';
  readonly position: Readonly<{ x: number; y: number }>;
  readonly primary: boolean;
}
export interface TouchContactSourceOptions {
  now: () => number;
  /** Admission only. The host must release its consumer when its route disconnects. */
  publish: (capability: 'contact', value: TouchContact, metadata: Readonly<{ capturedAt: number }>) => boolean;
}
const schema = getInputProfile('app:touch/1').capabilities[0]!.value;

export function touchContactSourceDescriptor(platform = 'browser-selected-by-host'): DeviceDescriptor {
  return parseDeviceDescriptor({ schemaVersion: 1, id: 'touch-contact-source', label: 'Touch contacts', revision: 1,
    adapter: { id: 'app:touch-contact', version: '1.0.0' }, runtime: { platform },
    capabilities: getInputProfile('app:touch/1').capabilities });
}

/** Pure reliable producer, bounded to 32 contacts. No DOM, timers or gesture inference. */
export class TouchContactSourceDriver {
  private readonly options: TouchContactSourceOptions;
  private readonly held = new Map<string, TouchContact>();
  private lastTime = 0;
  private stopped = false;
  private busy = false;
  private releasing = false;
  private releasePending = false;
  constructor(options: TouchContactSourceOptions) {
    if (typeof options.now !== 'function' || typeof options.publish !== 'function') throw new TypeError('Touch source callbacks required');
    this.options = { ...options };
  }
  state(): Readonly<{ contacts: readonly TouchContact[]; stopped: boolean }> {
    return Object.freeze({ contacts: Object.freeze([...this.held.values()]), stopped: this.stopped });
  }
  /** Unknown moves/releases are ignored; only down establishes ownership. Duplicate down is terminal. */
  contact(input: unknown): boolean {
    if (this.stopped || this.busy || this.releasing) return false;
    this.busy = true;
    let admitted = false;
    try {
      this.readTime();
      if (this.stopped) return false;
      let value = parseSignalValue(input, schema) as unknown as TouchContact;
      const held = this.held.get(value.id);
      if (value.phase === 'down') {
        if (held || this.held.size >= 32) throw new RangeError('Touch contact ownership limit');
        this.held.set(value.id, value);
      } else {
        if (!held) return true;
        // Primary is a property of the original contact, never a reassigned owner.
        value = Object.freeze({ ...value, primary: held.primary });
        this.held.set(value.id, value);
      }
      admitted = this.emit(value);
      if (admitted && (value.phase === 'up' || value.phase === 'cancel')) this.held.delete(value.id);
      if (!admitted) this.stop();
    } catch { this.stop(); }
    finally { this.busy = false; this.flushRelease(); }
    return admitted && !this.stopped;
  }
  /** Blur/hide cancels all held contacts. A later independent gesture can start again. */
  release(): void {
    if (this.releasing) return;
    this.releasePending = true;
    if (!this.busy && this.held.size) {
      this.busy = true;
      try { this.readTime(); } catch { this.stopped = true; }
      finally { this.busy = false; }
    }
    this.flushRelease();
  }
  stop(): void { if (this.stopped) return; this.stopped = true; this.release(); }
  private readTime(): void {
    const time = this.options.now();
    if (!Number.isFinite(time) || time < this.lastTime) throw new RangeError('Invalid touch source clock');
    this.lastTime = time;
  }
  private emit(value: TouchContact): boolean {
    return this.options.publish('contact', value, Object.freeze({ capturedAt: this.lastTime })) === true;
  }
  private flushRelease(): void {
    if (!this.releasePending || this.busy || this.releasing) return;
    this.releasePending = false; this.releasing = true;
    const contacts = [...this.held.values()]; this.held.clear();
    // Cleanup still uses the last validated time when the clock or publisher fails.
    for (const value of contacts) {
      try { if (!this.emit(Object.freeze({ ...value, phase: 'cancel' }))) this.stopped = true; }
      catch { this.stopped = true; }
    }
    this.releasing = false;
  }
}

type MountedContact = { id: string; primary: boolean; position: TouchContact['position'] };
const mountedDrivers = new WeakSet<TouchContactSourceDriver>();

/**
 * An explicitly selected surface. Host owns focus and touch-action (use `none` for a game pad).
 * Actual touch PointerEvents supply identities and positions; mouse and pen use other profiles.
 */
export function mountTouchContactSource(target: HTMLElement, driver: TouchContactSourceDriver): () => void {
  const document = target.ownerDocument, window = document.defaultView;
  if (!window || typeof window.ResizeObserver !== 'function') throw new TypeError('A browser document with ResizeObserver is required');
  if (mountedDrivers.has(driver) || driver.state().contacts.length || driver.state().stopped) throw new TypeError('An idle unmounted touch driver is required');
  const contacts = new Map<number, MountedContact>();
  let sequence = 0, disposed = false;
  let bounds: readonly number[] | undefined;
  const captureRelease = (pointerId: number) => {
    try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId); } catch { /* Contact already released locally. */ }
  };
  const reconcile = () => {
    const ids = new Set(driver.state().contacts.map(value => value.id));
    for (const [pointerId, contact] of contacts) if (!ids.has(contact.id)) {
      contacts.delete(pointerId); captureRelease(pointerId);
    }
  };
  const release = () => { driver.release(); reconcile(); };
  const measure = () => {
    const { left, top, width, height } = target.getBoundingClientRect();
    const next = [left, top, width, height];
    if (bounds && next.some((value, index) => value !== bounds![index])) release();
    bounds = next;
    if (!next.every(Number.isFinite) || width <= 0 || height <= 0) { release(); return; }
    return { left, top, width, height };
  };
  const position = (clientX: number, clientY: number): TouchContact['position'] | undefined => {
    const measured = measure();
    if (!measured || ![clientX, clientY].every(Number.isFinite)) return;
    const { left, top, width, height } = measured;
    return Object.freeze({ x: Math.max(0, Math.min(1, (clientX - left) / width)), y: Math.max(0, Math.min(1, (clientY - top) / height)) });
  };
  const emit = (contact: MountedContact, phase: TouchContact['phase']) => {
    const admitted = driver.contact({ id: contact.id, phase, primary: contact.primary, position: contact.position });
    reconcile(); return admitted;
  };
  const cancel = (pointerId: number) => {
    const contact = contacts.get(pointerId);
    if (contact) emit(contact, 'cancel');
  };
  const down = (event: PointerEvent) => {
    if (disposed || event.pointerType !== 'touch') return;
    reconcile();
    if (contacts.has(event.pointerId)) { cancel(event.pointerId); return; }
    if (!Number.isSafeInteger(event.pointerId) || event.pointerId < 0 || typeof event.isPrimary !== 'boolean') { driver.stop(); reconcile(); return; }
    const point = position(event.clientX, event.clientY);
    if (!point) { release(); return; }
    if (!Number.isSafeInteger(++sequence)) { driver.stop(); reconcile(); return; }
    const contact = { id: `touch:${sequence}`, primary: event.isPrimary, position: point };
    contacts.set(event.pointerId, contact);
    if (!emit(contact, 'down') || disposed || contacts.get(event.pointerId) !== contact) return;
    try { target.setPointerCapture(event.pointerId); }
    catch { cancel(event.pointerId); }
  };
  const update = (phase: 'move' | 'up') => (event: PointerEvent) => {
    if (disposed || event.pointerType !== 'touch') return;
    reconcile();
    const contact = contacts.get(event.pointerId); if (!contact) return;
    const point = position(event.clientX, event.clientY);
    if (!point) { release(); return; }
    contact.position = point;
    emit(contact, phase);
  };
  const move = update('move'), up = update('up');
  const cancelled = (event: PointerEvent) => { if (!disposed) { reconcile(); cancel(event.pointerId); } };
  const measured = () => { if (!disposed) { reconcile(); measure(); } };
  const orientation = () => { if (!disposed) { release(); measure(); } };
  const visibility = () => { if (document.visibilityState !== 'visible') release(); };
  measure();
  const observer = new window.ResizeObserver(measured);
  try { observer.observe(target); } catch (error) { observer.disconnect(); throw error; }
  mountedDrivers.add(driver);
  target.addEventListener('pointerdown', down); target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up); target.addEventListener('pointercancel', cancelled);
  target.addEventListener('lostpointercapture', cancelled);
  window.addEventListener('resize', measured); window.addEventListener('orientationchange', orientation);
  window.addEventListener('blur', release); window.addEventListener('pagehide', release);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    if (disposed) return; disposed = true;
    observer.disconnect(); mountedDrivers.delete(driver);
    target.removeEventListener('pointerdown', down); target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', cancelled);
    target.removeEventListener('lostpointercapture', cancelled);
    window.removeEventListener('resize', measured); window.removeEventListener('orientationchange', orientation);
    window.removeEventListener('blur', release); window.removeEventListener('pagehide', release);
    document.removeEventListener('visibilitychange', visibility);
    const ownedPointers = [...contacts.keys()]; contacts.clear();
    for (const pointerId of ownedPointers) captureRelease(pointerId);
    driver.stop();
  };
}
