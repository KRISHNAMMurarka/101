import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyboardTextSourceDriver as Driver } from './index.ts';
type Observed = { phase: string; code?: string; key?: string; repeat?: boolean; compositionId?: string; text?: string };

test('keyboard/text source preserves layout labels and repeats, cancels composition and releases held keys', () => {
  assert.equal(typeof Driver, 'function', 'standalone keyboard/text driver is available');
  const events: { capability: string; value: Observed; capturedAt: number }[] = [];
  const driver = new Driver({ now: () => 1000, publish(capability: string, value: Observed, metadata: { capturedAt: number }) {
    events.push({ capability, value, ...metadata }); return true;
  } });
  const key = { code: 'KeyY', key: 'z', phase: 'down', repeat: false, location: 0, composing: false,
    modifiers: { shift: false, control: true, alt: false, meta: false } };
  assert.equal(driver.key(key), true);
  driver.key({ ...key, repeat: true });
  driver.composition('start', ''); driver.composition('update', 'न');
  driver.release();
  assert.deepEqual(events.map(event => event.capability), ['key', 'key', 'composition', 'composition', 'key', 'composition']);
  assert.equal(events[0].value.code, 'KeyY'); assert.equal(events[0].value.key, 'z');
  assert.equal(events[1].value.repeat, true);
  assert.deepEqual(events[4].value, { ...key, phase: 'up', repeat: false, modifiers: { shift: false, control: false, alt: false, meta: false } });
  assert.deepEqual(events[5].value, { compositionId: 'composition:1', phase: 'end', text: '' });
  assert.equal(events.some(event => event.value.phase === 'commit'), false);
  assert.equal(driver.state().heldKeys, 0);
});

test('ending composition is not text; input commits once in either producer ordering', () => {
  for (const endFirst of [true, false]) {
      assert.equal(typeof Driver, 'function');
    const events: Observed[] = [];
    const driver = new Driver({ now: () => 5, publish(_capability: string, value: Observed) { events.push(value); return true; } });
    driver.composition('start', ''); driver.composition('update', '漢');
    assert.equal(driver.input('insertCompositionText', '漢', true), true);
    if (endFirst) driver.composition('end', '漢');
    assert.equal(events.some(event => event.phase === 'commit'), false);
    driver.input('insertFromComposition', '漢', false);
    driver.input('insertFromComposition', '漢', false);
    if (!endFirst) driver.composition('end', '漢');
    assert.equal(events.filter(event => event.phase === 'commit').length, 1);
    assert.equal(events.find(event => event.phase === 'commit')!.compositionId, 'composition:1');
    driver.input('insertText', '🙂', false);
    assert.equal(events.at(-1)!.text, '🙂');
    assert.notEqual(events.at(-1)!.compositionId, 'composition:1');
    driver.input('deleteContentBackward', null, false);
    assert.equal(events.filter(event => event.phase === 'commit').length, 2);
  }
});

test('invalid data, clock failure, overflow and rejection stop input without manufacturing committed text', () => {
  assert.equal(typeof Driver, 'function');
  const key = { code: 'KeyA', key: 'a', phase: 'down', repeat: false, location: 0, composing: false,
    modifiers: { shift: false, control: false, alt: false, meta: false } };
  for (const failure of ['invalid', 'clock', 'overflow', 'reject', 'throw']) {
    let time = 10, rejecting = false;
    const events: Observed[] = [];
    const driver = new Driver({ now: () => time, publish(_capability: string, value: Observed) {
      events.push(value); if (rejecting && failure === 'throw') throw new Error('closed'); return !rejecting;
    } });
    driver.key(key); driver.composition('start', '');
    if (failure === 'invalid') driver.key({ ...key, location: 5 });
    if (failure === 'clock') { time = 9; driver.key({ ...key, repeat: true }); }
    if (failure === 'overflow') driver.composition('update', 'x'.repeat(2049));
    if (failure === 'reject' || failure === 'throw') { rejecting = true; driver.key({ ...key, repeat: true }); }
    assert.equal(driver.state().stopped, true, failure);
    assert.equal(driver.state().heldKeys, 0, failure);
    assert.ok(events.some(event => event.phase === 'up'), failure);
    assert.equal(events.filter(event => event.phase === 'end').length, 1, failure);
    assert.equal(events.some(event => event.phase === 'commit'), false, failure);
    const count = events.length; driver.stop(); driver.key(key);
    assert.equal(events.length, count, failure);
  }
});

test('nested stop releases after publication and callbacks cannot mutate held-key snapshots', () => {
  assert.equal(typeof Driver, 'function');
  const events: Observed[] = []; let depth = 0;
  const driver: Driver = new Driver({ now: () => 0, publish(_capability: string, value: Observed) {
    assert.equal(depth++, 0); events.push(value);
    assert.ok(Object.isFrozen(value));
    if (value.phase === 'down') driver.stop();
    depth--; return true;
  } });
  driver.key({ code: 'ShiftRight', key: 'Shift', phase: 'down', repeat: false, location: 2, composing: false,
    modifiers: { shift: true, control: false, alt: false, meta: false } });
  assert.deepEqual(events.map(event => event.phase), ['down', 'up']);
  assert.equal(driver.state().stopped, true);
});

test('delayed blur release uses the current clock rather than an expired key capture', () => {
  let time = 1; const captures: number[] = [];
  const driver = new Driver({ now: () => time, publish(_capability, _value, metadata) { captures.push(metadata.capturedAt); return true; } });
  driver.key({ code: 'KeyA', key: 'a', phase: 'down', repeat: false, location: 0, composing: false,
    modifiers: { shift: false, control: false, alt: false, meta: false } });
  time = 5000; driver.release();
  assert.deepEqual(captures, [1, 5000]);
  assert.equal(driver.state().stopped, false);
});

test('nested release during cleanup cannot cancel a later independent key press', () => {
  const phases: string[] = [];
  const driver: Driver = new Driver({ now: () => 1, publish(_capability, value) {
    phases.push(value.phase); if (value.phase === 'up') driver.release(); return true;
  } });
  const key = { code: 'KeyA', key: 'a', phase: 'down', repeat: false, location: 0, composing: false,
    modifiers: { shift: false, control: false, alt: false, meta: false } } as const;
  driver.key(key); driver.release(); driver.key({ ...key, code: 'KeyB', key: 'b' });
  assert.deepEqual(phases, ['down', 'up', 'down']); assert.equal(driver.state().heldKeys, 1);
});
