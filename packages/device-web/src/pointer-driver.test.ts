import assert from 'node:assert/strict';
import test from 'node:test';
import { PointerSourceDriver, type PointerSourceDriverOptions } from './pointer-driver.ts';

type Published = { capability: string; value: Readonly<{ x: number; y: number }> | boolean; capturedAt: number };
function harness(options: Partial<PointerSourceDriverOptions> = {}) {
  let time = 100, admitted = true;
  const output: Published[] = [];
  const driver = new PointerSourceDriver({ now: () => time, publish: (capability, value, metadata) => {
    output.push({ capability, value, capturedAt: metadata.capturedAt }); return admitted;
  }, ...options });
  return { driver, output, time(value: number) { time = value; }, admit(value: boolean) { admitted = value; },
    positions: () => output.filter(item => typeof item.value !== 'boolean'),
    contacts: () => output.filter(item => typeof item.value === 'boolean') };
}

test('relative diagonals, lift and recontact preserve a recoverable absolute target', () => {
  const h = harness();
  assert.equal(h.driver.begin(1, 10, 90, 100, 100), true);
  assert.deepEqual(h.driver.state().position, { x: 0.5, y: 0.5 });
  h.time(120); h.driver.move(1, 30, 70, 100, 100);
  assert.deepEqual(h.driver.state().position, { x: 0.7, y: 0.3 });
  h.time(140); h.driver.move(1, 10, 90, 100, 100);
  assert.ok(Math.abs(h.driver.state().position.x - 0.5) < 1e-12);
  assert.equal(h.driver.state().position.y, 0.5);
  h.driver.end(1); h.driver.begin(2, 90, 10, 100, 100);
  assert.ok(Math.abs(h.driver.state().position.x - 0.5) < 1e-12);
  assert.equal(h.driver.state().position.y, 0.5);
  h.time(160); h.driver.move(2, 90, 10, 200, 200);
  assert.ok(Math.abs(h.driver.state().position.x - 0.5) < 1e-12);
  assert.equal(h.driver.state().position.y, 0.5);
  h.time(180); h.driver.move(2, 110, 30, 200, 200);
  assert.ok(Math.abs(h.driver.state().position.x - 0.6) < 1e-12);
  assert.equal(h.driver.state().position.y, 0.6);
  assert.deepEqual(h.contacts().map(item => item.value), [true, false, true]);
});

test('clamping and keyboard nudges retain independent deltas under rejected sends', () => {
  const h = harness(); h.admit(false);
  assert.equal(h.driver.nudge(0.1, -0.1), false);
  h.time(101); assert.equal(h.driver.nudge(0.1, -0.1), true);
  h.time(102); h.driver.nudge(0.1, -0.1);
  h.admit(true); h.time(120); h.driver.tick();
  const position = h.positions().at(-1)!;
  assert.ok(typeof position.value !== 'boolean' && Math.abs(position.value.x - 0.8) < 1e-12);
  assert.equal(position.capturedAt, 102);
  h.time(140); h.driver.nudge(100, -100);
  assert.deepEqual(h.driver.state().position, { x: 1, y: 0 });
});

test('unadmitted position retains original capture time until admitted, then heartbeat captures current state', () => {
  const h = harness(); h.admit(false); h.driver.nudge(0.2, 0);
  h.time(150); h.driver.tick(); h.admit(true); h.time(200); h.driver.tick();
  assert.deepEqual(h.positions().map(item => item.capturedAt), [100, 100, 100]);
  h.time(250); h.driver.tick();
  assert.equal(h.positions().at(-1)!.capturedAt, 250);
});

test('idle and held contact heartbeat repeat both channels at bounded cadence', () => {
  const h = harness(); h.driver.tick();
  h.time(149); h.driver.tick(); assert.equal(h.output.length, 2);
  h.time(150); h.driver.tick(); assert.equal(h.output.length, 4);
  h.time(151); h.driver.setContact(true);
  h.time(200); h.driver.tick(); assert.equal(h.contacts().at(-1)!.value, true);
  h.time(201); h.driver.tick();
  h.driver.release(); h.time(251); h.driver.tick();
  assert.deepEqual(h.contacts().map(item => item.value), [false, false, true, true, false, false]);
});

test('sampling coalesces changes and bounds heartbeat publication attempts', () => {
  const h = harness({ sampleHz: 25, heartbeatMs: 50 }); h.driver.tick();
  h.time(101); h.driver.nudge(0.1, 0); h.time(102); h.driver.nudge(0.1, 0);
  assert.equal(h.positions().length, 1);
  h.time(139); h.driver.tick(); assert.equal(h.positions().length, 1);
  h.time(140); h.driver.tick(); assert.equal(h.positions().length, 2);
  assert.equal(h.positions().at(-1)!.capturedAt, 102);
});

test('invalid geometry, IDs, input and competing touches neither move nor refresh', () => {
  const h = harness(); h.driver.begin(3, 10, 10, 100, 100);
  const before = h.driver.state(), count = h.output.length;
  for (const id of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(h.driver.begin(id, 10, 10, 100, 100), false);
    assert.equal(h.driver.end(id), false);
  }
  assert.equal(h.driver.begin(4, 10, 10, 100, 100), false);
  assert.equal(h.driver.move(4, 30, 30, 100, 100), false);
  assert.equal(h.driver.end(4), false);
  for (const geometry of [[NaN, 1, 100, 100], [1, Infinity, 100, 100], [1, 1, 0, 100], [1, 1, 100, -1]]) {
    assert.equal(h.driver.move(3, geometry[0], geometry[1], geometry[2], geometry[3]), false);
  }
  assert.equal(h.driver.nudge(NaN, 0), false);
  assert.deepEqual(h.driver.state(), before); assert.equal(h.output.length, count);
});

test('options and snapshots are captured immutably and capability names remain general', () => {
  const output: Published[] = [];
  const initial = { x: 0.2, y: 0.3 };
  const options: PointerSourceDriverOptions = { initial, positionCapability: 'cursor', contactCapability: 'pressed', now: () => 100,
    publish: (capability, value, metadata) => { output.push({ capability, value, capturedAt: metadata.capturedAt }); return true; } };
  const driver = new PointerSourceDriver(options);
  initial.x = 0.9; options.now = () => NaN; options.publish = () => false; options.positionCapability = 'changed';
  driver.tick(); assert.deepEqual(output.map(item => item.capability), ['cursor', 'pressed']);
  assert.deepEqual(driver.state().position, { x: 0.2, y: 0.3 });
  assert.ok(Object.isFrozen(driver.state())); assert.ok(Object.isFrozen(driver.state().position));
  assert.notEqual(driver.state().position, driver.state().position);
  assert.ok(Object.isFrozen(output[0].value));
});

test('constructor validates normalized initial state and cadence bounds', () => {
  for (const options of [{ sampleHz: 0 }, { sampleHz: 1 }, { sampleHz: 25, heartbeatMs: 20 }, { sampleHz: 61 }, { sampleHz: NaN }, { heartbeatMs: 19 }, { heartbeatMs: 51 },
    { initial: { x: -0.1, y: 0 } }, { initial: { x: 0, y: Infinity } }, { positionCapability: '' }, { contactCapability: '' }]) {
    assert.throws(() => harness(options), RangeError);
  }
});

test('release clears the local anchor and stop releases once and is terminal', () => {
  const h = harness(); h.driver.begin(1, 10, 10, 100, 100); h.driver.release();
  assert.equal(h.driver.move(1, 20, 20, 100, 100), false);
  h.driver.setContact(true); h.driver.stop(); const count = h.output.length; h.driver.stop(); h.driver.release(); h.driver.tick();
  assert.equal(h.driver.begin(2, 0, 0, 100, 100), false);
  assert.equal(h.driver.nudge(0.1, 0), false); assert.equal(h.driver.setContact(true), false);
  assert.equal(h.output.length, count); assert.equal(h.contacts().at(-1)!.value, false);
  assert.equal(h.driver.state().stopped, true); assert.equal(h.driver.state().contact, false);
});

test('clock backward, nonfinite and thrown failure stop and release held output', () => {
  for (const failure of [() => 99, () => NaN, () => { throw new Error('clock'); }]) {
    let clock = () => 100;
    const h = harness({ now: () => clock() }); h.driver.setContact(true); clock = failure; h.driver.tick();
    assert.equal(h.driver.state().stopped, true); assert.equal(h.driver.state().contact, false);
    assert.equal(h.contacts().at(-1)!.value, false); assert.equal(h.contacts().at(-1)!.capturedAt, 100);
  }
});

test('callback exception releases and stops without stranding contact', () => {
  const output: boolean[] = [];
  const driver = new PointerSourceDriver({ now: () => 100, publish: (_capability, value) => {
    if (typeof value === 'boolean') { output.push(value); if (value) throw new Error('publisher'); } return true;
  } });
  assert.equal(driver.setContact(true), false);
  assert.deepEqual(output, [true, false]); assert.equal(driver.state().stopped, true);
});

test('reentrant stop releases after the current callback and cannot resurrect output', () => {
  const output: boolean[] = [];
  const driver = new PointerSourceDriver({ now: () => 100, publish: (_capability, value) => {
    if (typeof value === 'boolean') { output.push(value); driver.stop(); assert.equal(driver.setContact(true), false); }
    return true;
  } });
  driver.setContact(true); driver.tick(); driver.stop();
  assert.deepEqual(output, [true, false]); assert.equal(driver.state().stopped, true);
});

test('stop captures the current release time after an idle interval', () => {
  const h = harness(); h.driver.setContact(true); h.time(500); h.driver.stop();
  assert.equal(h.contacts().at(-1)!.capturedAt, 500);
});

test('reentrant clock stop cannot resurrect an operation', () => {
  const driver = new PointerSourceDriver({ now: () => { driver.stop(); return 100; }, publish: () => true });
  assert.equal(driver.begin(1, 0, 0, 100, 100), false);
  assert.equal(driver.state().contact, false);
  assert.equal(driver.state().stopped, true);
});
