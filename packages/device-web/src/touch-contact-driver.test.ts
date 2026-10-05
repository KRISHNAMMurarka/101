import assert from 'node:assert/strict';
import test from 'node:test';
import { TouchContactSourceDriver as Driver, mountTouchContactSource, touchContactSourceDescriptor } from './touch-contact-driver.ts';
import type { TouchContact } from './touch-contact-driver.ts';
import { createTouchContactsPipeline } from '../../../examples/device-pipelines/touch-contacts.ts';

const contact = (id: string, phase: TouchContact['phase'] = 'down', x = 0.25, primary = true): TouchContact =>
  ({ id, phase, position: { x, y: 0.5 }, primary });

// Removing the per-ID ownership map would release the other simultaneous action.
test('simultaneous contacts retain individual ownership and immutable snapshots', () => {
  const events: TouchContact[] = [];
  const driver = new Driver({ now: () => 100, publish(_name, value) { events.push(value); return true; } });
  const first = { ...contact('finger-a'), position: { x: 0.25, y: 0.5 } };
  assert.equal(driver.contact(first), true);
  driver.contact(contact('finger-b', 'down', 0.75, false));
  first.position.x = 0.99;
  driver.contact(contact('finger-a', 'up', 0.3));
  assert.deepEqual(driver.state().contacts.map(value => value.id), ['finger-b']);
  assert.equal(events[0].position.x, 0.25);
  assert.ok(Object.isFrozen(events[0].position));
  driver.contact(contact('finger-a', 'move'));
  assert.equal(events.length, 3);
  driver.release();
  assert.deepEqual(events.map(value => [value.id, value.phase]), [
    ['finger-a', 'down'], ['finger-b', 'down'], ['finger-a', 'up'], ['finger-b', 'cancel'],
  ]);
  assert.equal(driver.state().contacts.length, 0);
  assert.equal(driver.state().stopped, false);
  assert.equal(touchContactSourceDescriptor().capabilities[0].delivery.mode, 'reliable');
});

// Missing terminal cleanup would strand the first held contact after publisher failure.
test('invalid input, bounded overflow, bad clocks and publication failures cancel every owned contact', () => {
  for (const failure of ['invalid', 'overflow', 'clock', 'clock-throw', 'reject', 'throw']) {
    const events: { value: TouchContact; time: number }[] = [];
    let time = 10, rejecting = false;
    const driver = new Driver({ now: () => { if (failure === 'clock-throw' && time === 9) throw new Error('clock'); return time; }, publish(_name, value, metadata) {
      events.push({ value, time: metadata.capturedAt });
      if (rejecting && failure === 'throw') throw new Error('closed');
      return !rejecting;
    } });
    driver.contact(contact('first')); driver.contact(contact('second', 'down', 0.75, false));
    if (failure === 'invalid') driver.contact({ ...contact('first', 'move'), position: { x: NaN, y: 0 } });
    if (failure === 'overflow') for (let i = 0; i < 32; i++) driver.contact(contact(`extra-${i}`));
    if (failure === 'clock' || failure === 'clock-throw') { time = 9; driver.contact(contact('first', 'move')); }
    if (failure === 'reject' || failure === 'throw') { rejecting = true; driver.contact(contact('first', 'move')); }
    assert.equal(driver.state().stopped, true, failure);
    assert.equal(driver.state().contacts.length, 0, failure);
    assert.equal(events.filter(event => event.value.id === 'first' && event.value.phase === 'cancel').length, 1, failure);
    assert.equal(events.filter(event => event.value.id === 'second' && event.value.phase === 'cancel').length, 1, failure);
    assert.ok(events.every(event => event.time === 10), failure);
    const count = events.length; driver.stop(); driver.contact(contact('later'));
    assert.equal(events.length, count, failure);
  }
});

// Reentrant cleanup must run outside publication and cannot leak into a later gesture.
test('nested stop and release are non-reentrant and primary ownership remains stable', () => {
  let time = 1, depth = 0, stopping = false;
  const events: TouchContact[] = [];
  const driver: Driver = new Driver({ now: () => time, publish(_name, value) {
    assert.equal(depth++, 0); events.push(value);
    assert.equal(driver.contact(contact('nested')), false);
    if (value.phase === 'cancel') driver.release();
    if (stopping && value.phase === 'down') driver.stop();
    depth--; return true;
  } });
  driver.contact(contact('first')); driver.contact(contact('first', 'move', 0.5, false));
  assert.equal(events[1].primary, true);
  time = 5000; driver.release();
  driver.contact(contact('later')); assert.equal(driver.state().contacts.length, 1);
  stopping = true; driver.contact(contact('last'));
  assert.deepEqual(events.slice(-3).map(value => value.phase), ['down', 'cancel', 'cancel']);
  assert.equal(driver.state().stopped, true);
});

/** EventTarget doubles provide only DOM boundaries; the driver and event conversion run unchanged. */
function surfaceFixture() {
  class Surface extends EventTarget {
    ownerDocument!: Document;
    bounds = { left: 10, top: 20, width: 200, height: 100 };
    captured = new Set<number>(); captureFails = false;
    getBoundingClientRect() { return this.bounds; }
    setPointerCapture(id: number) { if (this.captureFails) throw new Error('capture unavailable'); this.captured.add(id); }
    hasPointerCapture(id: number) { return this.captured.has(id); }
    releasePointerCapture(id: number) { this.captured.delete(id); }
  }
  const surface = new Surface(), window = new EventTarget(), document = new EventTarget();
  let observerCallback: (() => void) | undefined, disconnected = false;
  Object.assign(window, { ResizeObserver: class {
    constructor(callback: () => void) { observerCallback = callback; }
    observe() {} disconnect() { disconnected = true; }
  } });
  Object.assign(document, { defaultView: window, visibilityState: 'visible' }); surface.ownerDocument = document as unknown as Document;
  function dispatch(type: string, id: number, x = 110, y = 70, primary = true, pointerType = 'touch') {
    const event = new Event(type); Object.assign(event, { pointerId: id, clientX: x, clientY: y, isPrimary: primary, pointerType }); surface.dispatchEvent(event);
  }
  return { surface, window, document, dispatch, resize() { observerCallback?.(); }, disconnected: () => disconnected };
}

// Reusing one ID or clearing all capture ownership on one loss would break independent contacts.
test('selected surface cancels geometry and orientation changes, preserving independent capture ownership', () => {
  const fixture = surfaceFixture(), events: TouchContact[] = [];
  const driver = new Driver({ now: () => 100, publish(_name, value) { events.push(value); return true; } });
  const unmount = mountTouchContactSource(fixture.surface as unknown as HTMLElement, driver);
  fixture.dispatch('pointerdown', 7); fixture.dispatch('pointerdown', 8, 160, 95, false);
  fixture.dispatch('pointerdown', 9, 100, 50, true, 'mouse');
  assert.equal(driver.state().contacts.length, 2);
  assert.deepEqual(events[0].position, { x: 0.5, y: 0.5 });
  const ids = events.map(value => value.id);
  fixture.dispatch('lostpointercapture', 7);
  assert.deepEqual(driver.state().contacts.map(value => value.id), [ids[1]]);
  fixture.surface.bounds.width = 100; fixture.surface.bounds.height = 200; fixture.resize();
  assert.equal(driver.state().contacts.length, 0);
  assert.equal(fixture.surface.captured.size, 0);
  fixture.dispatch('pointermove', 8); assert.equal(driver.state().contacts.length, 0);
  fixture.dispatch('pointerdown', 7);
  assert.notEqual(events.at(-1)!.id, ids[0]);
  assert.deepEqual(events.at(-1)!.position, { x: 1, y: 0.25 });
  fixture.window.dispatchEvent(new Event('orientationchange'));
  assert.equal(driver.state().contacts.length, 0);
  assert.equal(fixture.surface.captured.size, 0);
  fixture.dispatch('pointerdown', 7); fixture.dispatch('pointerup', 7);
  assert.equal(driver.state().contacts.length, 0); assert.equal(events.at(-1)!.phase, 'up');
  unmount(); unmount();
  assert.equal(driver.state().stopped, true); assert.equal(fixture.disconnected(), true);
  const count = events.length; fixture.dispatch('pointerdown', 10);
  assert.equal(events.length, count);
});

test('capture failure, hidden document, blur, pagehide and invalid geometry never strand contacts', () => {
  for (const cause of ['capture', 'hidden', 'blur', 'pagehide', 'geometry', 'cancel']) {
    const fixture = surfaceFixture(), events: TouchContact[] = [];
    const driver = new Driver({ now: () => 1, publish(_name, value) { events.push(value); return true; } });
    const unmount = mountTouchContactSource(fixture.surface as unknown as HTMLElement, driver);
    if (cause === 'capture') fixture.surface.captureFails = true;
    fixture.dispatch('pointerdown', 1);
    if (cause === 'hidden') { Object.assign(fixture.document, { visibilityState: 'hidden' }); fixture.document.dispatchEvent(new Event('visibilitychange')); }
    if (cause === 'blur' || cause === 'pagehide') fixture.window.dispatchEvent(new Event(cause));
    if (cause === 'geometry') { fixture.surface.bounds.width = 0; fixture.resize(); }
    if (cause === 'cancel') fixture.dispatch('pointercancel', 1);
    assert.equal(driver.state().contacts.length, 0, cause);
    assert.equal(fixture.surface.captured.size, 0, cause);
    assert.equal(events.at(-1)!.phase, 'cancel', cause);
    unmount();
  }
});

// A rejected final edge still needs best-effort cancellation for that contact.
test('rejected up attempts cancellation for both the ending contact and its held peer', () => {
  const events: TouchContact[] = [];
  const driver = new Driver({ now: () => 1, publish(_name, value) { events.push(value); return value.phase !== 'up'; } });
  driver.contact(contact('first')); driver.contact(contact('second', 'down', 0.75, false));
  assert.equal(driver.contact(contact('first', 'up')), false);
  assert.deepEqual(events.slice(-2).map(value => [value.id, value.phase]), [['first', 'cancel'], ['second', 'cancel']]);
  assert.equal(driver.state().contacts.length, 0);
});


// Deferred source cleanup cannot be responsible for the disposed mount's native captures.
test('unmount inside down publication releases captures from earlier simultaneous contacts immediately', () => {
  const fixture = surfaceFixture(); let unmount = () => {}; let dispose = false; let capturedDuringDispose = -1;
  const driver = new Driver({ now: () => 1, publish(_name, value) {
    if (dispose && value.phase === 'down') {
      unmount(); capturedDuringDispose = fixture.surface.captured.size;
    }
    return true;
  } });
  unmount = mountTouchContactSource(fixture.surface as unknown as HTMLElement, driver);
  fixture.dispatch('pointerdown', 1);
  assert.equal(fixture.surface.captured.size, 1);
  dispose = true; fixture.dispatch('pointerdown', 2, 160, 95, false);
  assert.equal(capturedDuringDispose, 0);
  assert.equal(driver.state().stopped, true); assert.equal(driver.state().contacts.length, 0);
  assert.equal(fixture.surface.captured.size, 0);
});

// A closed route must dispose the DOM mount before any future input/observer event.
test('example route closure disposes its selected surface and releases native captures immediately', () => {
  const fixture = surfaceFixture(); let time = 1000;
  const example = createTouchContactsPipeline({ now: () => time });
  const unmount = example.mount(fixture.surface as unknown as HTMLElement);
  try {
    fixture.dispatch('pointerdown', 1); example.tick(); time += 5;
    fixture.dispatch('pointerdown', 2, 160, 95, false); example.tick();
    assert.equal(example.state().contacts.length, 2); assert.equal(fixture.surface.captured.size, 2);
    example.connection.stop('disconnected');
    assert.equal(fixture.surface.captured.size, 0); assert.equal(fixture.disconnected(), true);
    assert.equal(example.state().contacts.length, 0); assert.equal(example.driver.state().stopped, true);
    const count = example.state().events.length; fixture.dispatch('pointerdown', 3); example.tick();
    assert.equal(example.state().events.length, count);
  } finally { unmount(); example.stop(); }
});

// Admission can succeed while a publisher-triggered release cancels that same down.
test('release during admitted down never acquires capture for a contact already cancelled', () => {
  const fixture = surfaceFixture(), phases: string[] = [];
  const driver: Driver = new Driver({ now: () => 1, publish(_name, value) {
    phases.push(value.phase); if (value.phase === 'down') driver.release(); return true;
  } });
  const unmount = mountTouchContactSource(fixture.surface as unknown as HTMLElement, driver);
  try {
    fixture.dispatch('pointerdown', 1);
    assert.deepEqual(phases, ['down', 'cancel']);
    assert.equal(driver.state().stopped, false); assert.equal(driver.state().contacts.length, 0);
    assert.equal(fixture.surface.captured.size, 0);
  } finally { unmount(); }
});
