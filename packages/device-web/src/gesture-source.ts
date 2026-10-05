import { getInputProfile, parseDeviceDescriptor } from '@101/device-model';
import type { DeviceDescriptor } from '@101/device-model';
import type { GestureSourceDriver } from './gesture-driver.ts';
import type { TouchContact } from './touch-contact-driver.ts';

/** The selected application surface owns these gestures; this does not inject OS input. */
export function gestureSourceDescriptor(platform = 'browser-selected-by-host'): DeviceDescriptor {
  return parseDeviceDescriptor({ schemaVersion: 1, id: 'gesture-source', label: 'Surface gestures', revision: 1,
    adapter: { id: 'app:gesture-source', version: '1.0.0' }, runtime: { platform },
    capabilities: getInputProfile('app:gesture/1').capabilities });
}

type MountedContact = { id: string; primary: boolean; position: TouchContact['position'] };
type Bounds = Readonly<{ left: number; top: number; width: number; height: number }>;
const mountedDrivers = new WeakSet<GestureSourceDriver>();

/** An explicitly selected surface. The host owns focus and touch-action styling. */
export function mountGestureSource(target: HTMLElement, driver: GestureSourceDriver): () => void {
  const document = target.ownerDocument, window = document.defaultView;
  if (!window || typeof window.ResizeObserver !== 'function') throw new TypeError('A browser document with ResizeObserver is required');
  if (mountedDrivers.has(driver) || driver.state().contacts.length || driver.state().stopped)
    throw new TypeError('An idle unmounted gesture driver is required');

  const contacts = new Map<number, MountedContact>();
  let bounds: Bounds | undefined, sequence = 0, disposed = false;
  const releaseCapture = (id: number) => {
    try { if (target.hasPointerCapture(id)) target.releasePointerCapture(id); }
    catch { /* Ownership is already retired locally. */ }
  };
  const reconcile = () => {
    const held = new Set(driver.state().contacts.map(value => value.id));
    for (const [id, contact] of contacts) if (!held.has(contact.id)) {
      contacts.delete(id); releaseCapture(id);
    }
  };
  const release = () => { driver.release(); reconcile(); };
  const measure = (): Bounds | undefined => {
    const rect = target.getBoundingClientRect();
    const next = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (bounds && (next.left !== bounds.left || next.top !== bounds.top || next.width !== bounds.width || next.height !== bounds.height)) release();
    bounds = next;
    if (![next.left, next.top, next.width, next.height].every(Number.isFinite) || next.width <= 0 || next.height <= 0 || next.width > 100000 || next.height > 100000) {
      release(); return;
    }
    return next;
  };
  const position = (event: PointerEvent): { point: TouchContact['position']; surface: Bounds } | undefined => {
    const surface = measure();
    if (!surface || ![event.clientX, event.clientY].every(Number.isFinite)) return;
    return { point: Object.freeze({ x: Math.max(0, Math.min(1, (event.clientX - surface.left) / surface.width)),
      y: Math.max(0, Math.min(1, (event.clientY - surface.top) / surface.height)) }), surface };
  };
  const emit = (contact: MountedContact, phase: TouchContact['phase'], surface: Bounds): boolean => {
    const admitted = driver.contact({ id: contact.id, phase, primary: contact.primary, position: contact.position }, surface);
    reconcile(); return admitted;
  };
  const cancel = (id: number) => {
    const contact = contacts.get(id); if (!contact) return;
    const surface = bounds;
    if (surface) emit(contact, 'cancel', surface);
    else release();
    contacts.delete(id); releaseCapture(id);
  };
  const pointerTypeAllowed = (event: PointerEvent) => event.pointerType === 'touch' ||
    ((event.pointerType === 'mouse' || event.pointerType === 'pen') && event.button === 0 && event.isPrimary);
  const down = (event: PointerEvent) => {
    if (disposed || !pointerTypeAllowed(event)) return;
    reconcile();
    if (contacts.has(event.pointerId)) { cancel(event.pointerId); return; }
    if (!Number.isSafeInteger(event.pointerId) || event.pointerId < 0 || typeof event.isPrimary !== 'boolean') { driver.stop(); reconcile(); return; }
    const measured = position(event);
    if (!measured) { release(); return; }
    if (!Number.isSafeInteger(++sequence)) { driver.stop(); reconcile(); return; }
    const contact: MountedContact = { id: `gesture:${sequence}`, primary: event.isPrimary, position: measured.point };
    contacts.set(event.pointerId, contact);
    if (!emit(contact, 'down', measured.surface) || disposed || contacts.get(event.pointerId) !== contact) return;
    try { target.setPointerCapture(event.pointerId); }
    catch { cancel(event.pointerId); }
  };
  const update = (phase: 'move' | 'up') => (event: PointerEvent) => {
    if (disposed) return;
    reconcile();
    const contact = contacts.get(event.pointerId); if (!contact) return;
    const measured = position(event);
    if (!measured) { release(); return; }
    if (contacts.get(event.pointerId) !== contact) return;
    contact.position = measured.point;
    emit(contact, phase, measured.surface);
  };
  const move = update('move'), up = update('up');
  const cancelled = (event: PointerEvent) => { if (!disposed) { reconcile(); cancel(event.pointerId); } };
  const wheel = (event: WheelEvent) => {
    if (disposed) return;
    reconcile();
    const mode = event.deltaMode === 0 ? 'pixel' : event.deltaMode === 1 ? 'line' : event.deltaMode === 2 ? 'page' : undefined;
    if (!mode) return;
    const admitted = driver.wheel({ x: event.deltaX, y: event.deltaY, z: event.deltaZ, mode,
      modifiers: { shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey } });
    reconcile();
    if (admitted && event.cancelable) event.preventDefault();
  };
  const measured = () => { if (!disposed) { reconcile(); measure(); } };
  const orientation = () => { if (!disposed) { release(); measure(); } };
  const visibility = () => { if (document.visibilityState !== 'visible') release(); };

  measure();
  const observer = new window.ResizeObserver(measured);
  try { observer.observe(target); } catch (error) { observer.disconnect(); throw error; }
  mountedDrivers.add(driver);
  target.addEventListener('pointerdown', down); target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up); target.addEventListener('pointercancel', cancelled);
  target.addEventListener('lostpointercapture', cancelled); target.addEventListener('wheel', wheel, { passive: false });
  window.addEventListener('resize', measured); window.addEventListener('orientationchange', orientation);
  window.addEventListener('blur', release); window.addEventListener('pagehide', release);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    if (disposed) return; disposed = true;
    observer.disconnect(); mountedDrivers.delete(driver);
    target.removeEventListener('pointerdown', down); target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', cancelled);
    target.removeEventListener('lostpointercapture', cancelled); target.removeEventListener('wheel', wheel);
    window.removeEventListener('resize', measured); window.removeEventListener('orientationchange', orientation);
    window.removeEventListener('blur', release); window.removeEventListener('pagehide', release);
    document.removeEventListener('visibilitychange', visibility);
    const owned = [...contacts.keys()]; contacts.clear();
    for (const id of owned) releaseCapture(id);
    driver.stop();
  };
}
