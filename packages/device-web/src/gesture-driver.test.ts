import assert from 'node:assert/strict';
import test from 'node:test';
import { GestureSourceDriver as Driver } from './gesture-driver.ts';
import type { GestureTransition, GestureWheel } from './gesture-driver.ts';
import type { TouchContact } from './touch-contact-driver.ts';
const surface = { width: 200, height: 100 };
const contact = (id: string, phase: TouchContact['phase'], x = 0.25, y = 0.5): TouchContact => ({ id, phase, position: { x, y }, primary: id === 'first' });
const modifiers = { shift: false, control: false, alt: false, meta: false };
const wheel = (y: number, mode: GestureWheel['mode'] = 'pixel'): GestureWheel => ({ x: 0, y, z: 0, mode, modifiers });
function fixture() {
  let time = 1000;
  const events: { capability: string; value: GestureTransition | GestureWheel | Readonly<{ x: number; y: number }>; capturedAt: number }[] = [];
  const driver = new Driver({ now: () => time, publish(capability, value, metadata) { events.push({ capability, value, ...metadata }); return true; } });
  return { driver, events, advance(ms: number) { time += ms; }, gestures() { return events.filter(value => value.capability === 'gesture').map(value => value.value as GestureTransition); }, wheels() { return events.filter(value => value.capability === 'wheel').map(value => value.value as GestureWheel); } };
}

// A cancel or a previous pointer ID must never manufacture a click.
test('tap requires a short released contact, with immutable final coordinates and no click on cancellation', () => {
  const f = fixture();
  assert.equal(f.driver.contact(contact('first', 'down'), surface), true);
  f.advance(100); f.driver.contact(contact('first', 'up', 0.26), surface);
  assert.deepEqual(f.gestures().map(value => [value.kind, value.phase, value.position]), [['tap', 'end', { x: 0.26, y: 0.5 }]]);
  assert.ok(Object.isFrozen(f.gestures()[0].position));
  f.driver.contact(contact('first', 'up'), surface);
  f.driver.contact(contact('second', 'down'), surface); f.driver.contact(contact('second', 'cancel'), surface);
  assert.equal(f.gestures().length, 1); assert.equal(f.driver.state().contacts.length, 0);
});

// Missing time recognition would miss press; a release must cancel rather than click.
test('caller tick starts press at its deadline, then release or up terminates it exactly once', () => {
  const f = fixture(); f.driver.contact(contact('first', 'down'), surface);
  f.advance(499); f.driver.tick(); assert.equal(f.gestures().length, 0);
  f.advance(1); f.driver.tick(); assert.equal(f.driver.state().active?.kind, 'press');
  f.advance(100); f.driver.release();
  assert.deepEqual(f.gestures().map(value => [value.kind, value.phase]), [['press', 'start'], ['press', 'cancel']]);
  assert.equal(f.gestures()[0].gestureId, f.gestures()[1].gestureId);
  f.driver.contact(contact('next', 'down'), surface); f.advance(600); f.driver.contact(contact('next', 'up'), surface);
  assert.deepEqual(f.gestures().slice(-2).map(value => [value.kind, value.phase]), [['press', 'start'], ['press', 'end']]);
  assert.equal(f.driver.state().active, undefined);
});

// Losing final positions or emitting continuous reliable transitions would break drag consumers.
test('drag uses measured pixel threshold and bounded latest positions while preserving reliable start/end', () => {
  const f = fixture(); f.driver.contact(contact('first', 'down'), surface);
  f.advance(5); f.driver.contact(contact('first', 'move', 0.28), surface); assert.equal(f.gestures().length, 0);
  f.driver.contact(contact('first', 'move', 0.3), surface);
  assert.equal(f.gestures()[0].kind, 'drag'); assert.equal(f.gestures()[0].phase, 'start');
  for (let i = 0; i < 10; i++) f.driver.contact(contact('first', 'move', 0.4 + i / 100), surface);
  assert.equal(f.events.filter(value => value.capability === 'position').length, 1);
  f.advance(20); f.driver.tick();
  assert.deepEqual(f.events.filter(value => value.capability === 'position').at(-1)!.value, { x: 0.49, y: 0.5 });
  f.driver.contact(contact('first', 'up', 0.6), surface);
  assert.deepEqual(f.gestures().map(value => [value.kind, value.phase]), [['drag', 'start'], ['drag', 'end']]);
  assert.deepEqual(f.gestures().at(-1)!.position, { x: 0.6, y: 0.5 });
});

test('release beyond drag threshold cancels an existing press before ending a drag', () => {
  const f = fixture();
  f.driver.contact(contact('first', 'down'), surface);
  f.advance(500); f.driver.tick();
  f.driver.contact(contact('first', 'up', 0.4), surface);
  assert.deepEqual(f.gestures().map(value => [value.kind, value.phase]), [
    ['press', 'start'], ['press', 'cancel'], ['drag', 'start'], ['drag', 'end'],
  ]);
  assert.equal(f.gestures()[0].gestureId, f.gestures()[1].gestureId);
  assert.equal(f.gestures()[2].gestureId, f.gestures()[3].gestureId);
  assert.equal(f.driver.state().contacts.length, 0);
});

// Second-touch ownership changes must not leave a press active or shift centroid on membership changes.
test('second contact cancels press and scrolls by centroid, without jumps or taps from the remaining finger', () => {
  const f = fixture(); f.driver.contact(contact('first', 'down', 0.25), surface); f.advance(500); f.driver.tick();
  f.driver.contact(contact('second', 'down', 0.75), surface);
  assert.deepEqual(f.gestures().map(value => [value.kind, value.phase]), [['press', 'start'], ['press', 'cancel'], ['scroll', 'start']]);
  f.advance(20); f.driver.contact(contact('first', 'move', 0.25, 0.6), surface);
  f.driver.contact(contact('second', 'move', 0.75, 0.6), surface);
  f.driver.contact(contact('third', 'down', 0.5, 0.6), surface);
  f.driver.contact(contact('third', 'up', 0.5, 0.6), surface);
  f.driver.contact(contact('first', 'up', 0.25, 0.6), surface);
  f.driver.contact(contact('second', 'up', 0.75, 0.6), surface);
  assert.equal(f.driver.state().contacts.length, 0);
  assert.deepEqual(f.gestures().slice(-1).map(value => [value.kind, value.phase]), [['scroll', 'end']]);
  assert.equal(f.gestures().some(value => value.kind === 'tap'), false);
  assert.ok(Math.abs(f.wheels().reduce((sum, value) => sum + value.y, 0) + 10) < 1e-8);
  assert.ok(f.wheels().every(value => value.mode === 'pixel'));
});

// Summing across units/modifiers or dropping pending wheel deltas would change actual scrolling.
test('wheel preserves unit and modifier boundaries, sums consecutive deltas and bounds normal output rate', () => {
  const f = fixture(); f.driver.wheel(wheel(2));
  for (let i = 0; i < 10; i++) f.driver.wheel(wheel(3));
  f.driver.wheel(wheel(4, 'line')); f.driver.wheel({ ...wheel(5, 'page'), modifiers: { ...modifiers, control: true } });
  assert.equal(f.wheels().length, 1);
  f.advance(20); f.driver.tick(); assert.equal(f.wheels().length, 2);
  f.driver.release();
  assert.deepEqual(f.wheels().map(value => [value.mode, value.y, value.modifiers.control]), [['pixel', 2, false], ['pixel', 30, false], ['line', 4, false], ['page', 5, true]]);
  assert.equal(f.driver.state().pendingWheelBatches, 0); assert.equal(f.driver.state().stopped, false);
});

// Terminal failures must cancel an admitted gesture, never leave a held action behind.
test('invalid geometry, clock failure, wheel overflow and rejected/throwing publishers stop with cleanup', () => {
  for (const failure of ['geometry', 'clock', 'wheel', 'overflow', 'reject', 'throw']) {
    let time = 1000, failing = false; const gestures: GestureTransition[] = [];
    const driver = new Driver({ now: () => time, publish(name, value) {
      if (name === 'gesture') gestures.push(value as GestureTransition);
      if (failing && failure === 'throw') throw new Error('sink unavailable'); return !failing;
    } });
    driver.contact(contact('first', 'down'), surface); time += 500; driver.tick();
    if (failure === 'geometry') driver.contact(contact('first', 'move'), { width: 0, height: 100 });
    if (failure === 'clock') { time--; driver.tick(); }
    if (failure === 'wheel') driver.wheel(wheel(NaN));
    if (failure === 'overflow') for (let i = 0; i < 66; i++) driver.wheel(wheel(1, i % 2 ? 'line' : 'pixel'));
    if (failure === 'reject' || failure === 'throw') { failing = true; driver.contact(contact('first', 'up'), surface); }
    assert.equal(driver.state().stopped, true, failure); assert.equal(driver.state().contacts.length, 0, failure);
    assert.equal(driver.state().active, undefined, failure);
    assert.ok(gestures.some(value => value.kind === 'press' && value.phase === 'cancel'), failure);
  }
});

test('publisher reentrancy cancels a started gesture outside the callback and blocks nested input', () => {
  let time = 1000, depth = 0, maxDepth = 0; const transitions: GestureTransition[] = [], nested: boolean[] = [];
  const driver: Driver = new Driver({ now: () => time, publish(name, value) {
    depth++; maxDepth = Math.max(maxDepth, depth);
    nested.push(driver.contact(contact('nested', 'down'), surface));
    if (name === 'gesture') { transitions.push(value as GestureTransition); if ((value as GestureTransition).phase === 'start') driver.release(); }
    depth--; return true;
  } });
  driver.contact(contact('first', 'down'), surface); time += 500; driver.tick();
  assert.equal(maxDepth, 1); assert.ok(nested.every(value => !value));
  assert.deepEqual(transitions.map(value => [value.kind, value.phase]), [['press', 'start'], ['press', 'cancel']]);
  assert.equal(driver.state().contacts.length, 0); assert.equal(driver.state().stopped, false);
});
