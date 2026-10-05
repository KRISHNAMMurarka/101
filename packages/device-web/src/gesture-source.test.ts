import assert from 'node:assert/strict';
import test from 'node:test';
import { GestureSourceDriver } from './gesture-driver.ts';
import type { GestureTransition, GestureWheel } from './gesture-driver.ts';
import { gestureSourceDescriptor, mountGestureSource } from './gesture-source.ts';

/** DOM-boundary doubles; gesture interpretation and schema conversion remain production code. */
function fixture() {
  class Surface extends EventTarget {
    ownerDocument!: Document;
    bounds = { left: 10, top: 20, width: 200, height: 100 };
    captures = new Set<number>(); captureFails = false;
    getBoundingClientRect() { return this.bounds; }
    setPointerCapture(id: number) { if (this.captureFails) throw new Error('not capturable'); this.captures.add(id); }
    hasPointerCapture(id: number) { return this.captures.has(id); }
    releasePointerCapture(id: number) { this.captures.delete(id); }
  }
  const target = new Surface(), window = new EventTarget(), document = new EventTarget();
  let resized: (() => void) | undefined, disconnected = false;
  Object.assign(window, { ResizeObserver: class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect() { disconnected = true; } } });
  Object.assign(document, { defaultView: window, visibilityState: 'visible' }); target.ownerDocument = document as unknown as Document;
  function pointer(type: string, pointerId = 1, pointerType = 'touch', clientX = 60, clientY = 70, button = 0) {
    const event = new Event(type, { cancelable: true }); Object.assign(event, { pointerId, pointerType, clientX, clientY, isPrimary: pointerId === 1, button }); target.dispatchEvent(event); return event;
  }
  function wheel(deltaY: number, deltaMode = 0) {
    const event = new Event('wheel', { cancelable: true }); Object.assign(event, { deltaX: 2, deltaY, deltaZ: 0, deltaMode, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }); target.dispatchEvent(event); return event;
  }
  return { target, window, document, pointer, wheel, resize() { resized?.(); }, disconnected: () => disconnected };
}

test('selected surface handles primary mouse tap, measured coordinates and native wheel units/modifiers', () => {
  const f = fixture(), gestures: GestureTransition[] = [], wheels: GestureWheel[] = [];
  let time = 1000;
  const driver = new GestureSourceDriver({ now: () => time, publish(name, value) {
    if (name === 'gesture') gestures.push(value as GestureTransition); if (name === 'wheel') wheels.push(value as GestureWheel); return true;
  } });
  const unmount = mountGestureSource(f.target as unknown as HTMLElement, driver);
  try {
    f.pointer('pointerdown', 1, 'mouse', 110, 70, 2); assert.equal(driver.state().contacts.length, 0);
    f.pointer('pointerdown', 1, 'mouse', 110, 70); assert.equal(f.target.captures.size, 1);
    time += 50; f.pointer('pointerup', 1, 'mouse', 112, 71);
    assert.deepEqual(gestures.map(value => [value.kind, value.phase, value.position]), [['tap', 'end', { x: 0.51, y: 0.51 }]]);
    assert.equal(f.target.captures.size, 0);
    assert.equal(f.wheel(3, 1).defaultPrevented, true);
    assert.deepEqual(wheels[0], { x: 2, y: 3, z: 0, mode: 'line', modifiers: { shift: true, control: false, alt: false, meta: false } });
    assert.deepEqual(gestureSourceDescriptor().capabilities.map(capability => capability.delivery.mode), ['reliable', 'latest', 'reliable']);
  } finally { unmount(); }
});

// Cancelling one held pointer must retain the other capture and suppress accidental tap after scroll.
test('multi-contact scrolling keeps separate capture ownership and capture loss cancels the scroll', () => {
  const f = fixture(), transitions: GestureTransition[] = [];
  const driver = new GestureSourceDriver({ now: () => 1000, publish(name, value) { if (name === 'gesture') transitions.push(value as GestureTransition); return true; } });
  const unmount = mountGestureSource(f.target as unknown as HTMLElement, driver);
  try {
    f.pointer('pointerdown'); f.pointer('pointerdown', 2, 'touch', 160, 70);
    assert.equal(driver.state().contacts.length, 2); assert.equal(f.target.captures.size, 2);
    f.pointer('lostpointercapture', 1);
    assert.equal(driver.state().contacts.length, 1); assert.deepEqual([...f.target.captures], [2]);
    f.pointer('pointerup', 2, 'touch', 160, 70);
    assert.deepEqual(transitions.map(value => [value.kind, value.phase]), [['scroll', 'start'], ['scroll', 'cancel']]);
    assert.equal(f.target.captures.size, 0);
  } finally { unmount(); }
});

test('geometry/orientation, blur/hide, capture failure and unmount release gestures and native captures', () => {
  for (const cause of ['geometry', 'orientation', 'blur', 'hide', 'pagehide', 'capture', 'unmount']) {
    const f = fixture(), gestures: GestureTransition[] = []; let time = 1000;
    const driver = new GestureSourceDriver({ now: () => time, publish(name, value) { if (name === 'gesture') gestures.push(value as GestureTransition); return true; } });
    const unmount = mountGestureSource(f.target as unknown as HTMLElement, driver);
    if (cause === 'capture') f.target.captureFails = true;
    f.pointer('pointerdown'); time += 500; driver.tick();
    if (cause === 'geometry') { f.target.bounds.width = 100; f.resize(); }
    if (cause === 'orientation') f.window.dispatchEvent(new Event('orientationchange'));
    if (cause === 'blur' || cause === 'pagehide') f.window.dispatchEvent(new Event(cause));
    if (cause === 'hide') { Object.assign(f.document, { visibilityState: 'hidden' }); f.document.dispatchEvent(new Event('visibilitychange')); }
    if (cause === 'unmount') unmount();
    assert.equal(driver.state().contacts.length, 0, cause); assert.equal(driver.state().active, undefined, cause);
    assert.equal(f.target.captures.size, 0, cause);
    assert.equal(gestures.some(value => value.kind === 'tap'), false, cause);
    if (cause !== 'capture') assert.equal(gestures.at(-1)?.phase, 'cancel', cause);
    unmount(); assert.equal(f.disconnected(), true); assert.equal(driver.state().stopped, true);
  }
});

test('publication-triggered release and reentrant unmount cannot capture cancelled or disposed contacts', () => {
  for (const cause of ['release', 'unmount']) {
    const f = fixture(); let unmount = () => {}, disposing = false, capturesDuringDispose = -1;
    const driver: GestureSourceDriver = new GestureSourceDriver({ now: () => 1000, publish(name) {
      if (cause === 'release' && name === 'position') driver.release();
      if (cause === 'unmount' && disposing && name === 'gesture') { unmount(); capturesDuringDispose = f.target.captures.size; }
      return true;
    } });
    unmount = mountGestureSource(f.target as unknown as HTMLElement, driver);
    f.pointer('pointerdown');
    if (cause === 'unmount') { assert.equal(f.target.captures.size, 1); disposing = true; f.pointer('pointerdown', 2); assert.equal(capturesDuringDispose, 0); }
    assert.equal(f.target.captures.size, 0); assert.equal(driver.state().contacts.length, 0);
    unmount();
  }
});
