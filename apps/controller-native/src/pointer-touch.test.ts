import assert from 'node:assert/strict';
import test from 'node:test';
import { PointerSourceDriver } from '../../../packages/device-web/src/pointer-driver.ts';
import { applyPointerTouches } from './pointer-touch.ts';

test('Android target-local coordinate changes do not reverse a continuous relative drag', () => {
  let time = 100;
  const driver = new PointerSourceDriver({ now: () => time, publish: () => true });
  const size = { width: 320, height: 250 };
  // JSTouchDispatcher hit-tests each move for local coordinates, while retaining
  // the original gesture target. Crossing a centred Text therefore changes the
  // location origin; page coordinates remain in the root view's coordinate space.
  const touch = (pageX: number, pageY: number, originX: number, originY: number) =>
    ({ identifier: '0', pageX, pageY, locationX: pageX - originX, locationY: pageY - originY });
  applyPointerTouches(driver, [touch(120, 520, 24, 440)], 'begin', size);
  time += 20;
  applyPointerTouches(driver, [touch(130, 530, 24, 440)], 'move', size);
  time += 20;
  applyPointerTouches(driver, [touch(140, 540, 112, 535)], 'move', size);
  assert.ok(Math.abs(driver.state().position.x - (0.5 + 20 / 320)) < 1e-12);
  assert.ok(Math.abs(driver.state().position.y - (0.5 + 20 / 250)) < 1e-12);
  time += 20;
  applyPointerTouches(driver, [touch(150, 550, 24, 440)], 'move', size);
  assert.ok(Math.abs(driver.state().position.x - (0.5 + 30 / 320)) < 1e-12);
  assert.ok(Math.abs(driver.state().position.y - (0.5 + 30 / 250)) < 1e-12);
});

test('lift, reused native identifier, resize and invalid root coordinates preserve the target', () => {
  let time = 100;
  const driver = new PointerSourceDriver({ now: () => time, publish: () => true });
  const size = { width: 320, height: 250 };
  const touch = (identifier: unknown, pageX: number, pageY: number) =>
    ({ identifier, pageX, pageY, locationX: 0, locationY: 0 });
  applyPointerTouches(driver, [touch('0', 120, 520)], 'begin', size);
  time += 20;
  applyPointerTouches(driver, [touch('0', 140, 540)], 'move', size);
  const position = driver.state().position;
  applyPointerTouches(driver, [touch('1', 700, 200)], 'end', size);
  assert.equal(driver.state().contact, true);
  applyPointerTouches(driver, [touch('0', NaN, NaN)], 'end', size);
  assert.equal(driver.state().contact, false);
  applyPointerTouches(driver, [touch('0', 700, 200)], 'begin', size);
  assert.deepEqual(driver.state().position, position);
  time += 20;
  applyPointerTouches(driver, [touch('0', 700, 200)], 'move', { width: 640, height: 250 });
  assert.deepEqual(driver.state().position, position);
  applyPointerTouches(driver, [touch('0', NaN, 200), touch('-1', 740, 220)], 'move', size);
  assert.deepEqual(driver.state().position, position);
});
