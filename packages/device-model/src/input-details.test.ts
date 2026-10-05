import assert from 'node:assert/strict';
import test from 'node:test';
import { createPenDetailProcessor, createRotaryDeltaProcessor, createGamepadDetailProcessor } from './input-details.ts';

test('pen calibration preserves pressure, corrected tilt, and wrapped twist without silent saturation', () => {
  const pen = createPenDetailProcessor({ pressureMin: 0.1, pressureMax: 0.9, tiltXOffset: 5, tiltYOffset: -2, twistOffset: 20 });
  const value = pen.process({ id: 'stylus-1', phase: 'move', position: { x: 0.25, y: 0.5 }, primary: true,
    pressure: 0.5, tiltX: 15, tiltY: -12, twist: 10 }) as Record<string, unknown>;
  assert.equal(value.pressure, 0.5); assert.equal(value.tiltX, 10); assert.equal(value.tiltY, -10); assert.equal(value.twist, 350);
  const lifted = pen.process({ id: 'stylus-1', phase: 'up', position: { x: 0.25, y: 0.5 }, primary: true,
    pressure: 0, tiltX: 0, tiltY: 0, twist: 0 }) as Record<string, unknown>;
  assert.equal(lifted.pressure, 0);
  assert.throws(() => pen.process({ id: 'stylus-1', phase: 'move', position: { x: 0, y: 0 }, primary: true,
    pressure: 1, tiltX: 0, tiltY: 0, twist: 0 }), /input-detail-range/);
  assert.throws(() => pen.process({ id: 'stylus-1', phase: 'move', position: { x: 0, y: 0 }, primary: true,
    pressure: 0.5, tiltX: -90, tiltY: 0, twist: 0 }), /input-range/);
});

test('rotary preserves fractional signed detents and rejects out-of-profile changes', () => {
  const rotary = createRotaryDeltaProcessor(4);
  assert.deepEqual(rotary.process('crown', -3), { source: 'crown', delta: -0.75, unit: 'detent' });
  assert.deepEqual(rotary.process('encoder', 1), { source: 'encoder', delta: 0.25, unit: 'detent' });
  assert.throws(() => rotary.process('crown', Infinity), /input-detail-range/);
  assert.throws(() => rotary.process('crown', 4097), /input-detail-range/);
});

test('pen snapshots calibration before the caller mutates its configuration', () => {
  const calibration = { pressureMin: 0, pressureMax: 1, tiltXOffset: 10, tiltYOffset: 0, twistOffset: 20 };
  const pen = createPenDetailProcessor(calibration);
  calibration.tiltXOffset = -10; calibration.twistOffset = 180;
  const value = pen.process({ id: 'pen', phase: 'down', position: { x: 0, y: 0 }, primary: true,
    pressure: 0.5, tiltX: 20, tiltY: 0, twist: 30 }) as Record<string, unknown>;
  assert.equal(value.tiltX, 10); assert.equal(value.twist, 10);
});

test('gamepad calibration emits analog trigger samples and only real button/hat edges', () => {
  const gamepad = createGamepadDetailProcessor({ axes: [
    { min: -1, center: 0, max: 1, deadzone: 0.1 }, { min: -1, center: 0, max: 1, deadzone: 0.1 },
  ], buttonCount: 2, triggers: [1], hats: [{ xAxis: 0, yAxis: 1, threshold: 0.5 }] });
  const first = gamepad.process({ axes: [0, 0], buttons: [{ pressed: false, value: 0 }, { pressed: false, value: 0.4 }] });
  assert.deepEqual(first.buttons, []); assert.deepEqual(first.hats, []);
  assert.deepEqual(first.triggers, [{ id: 'button-1', value: 0.4 }]);
  const second = gamepad.process({ axes: [1, -1], buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0.7 }] });
  assert.deepEqual(second.axes, [1, -1]);
  assert.deepEqual(second.buttons, [{ id: 'button-0', pressed: true, pressure: 1 }]);
  assert.deepEqual(second.hats, [{ id: 'hat-0', direction: 'northeast' }]);
  const held = gamepad.process({ axes: [1, -1], buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0.8 }] });
  assert.deepEqual(held.buttons, []); assert.deepEqual(held.hats, []);
  assert.deepEqual(held.triggers, [{ id: 'button-1', value: 0.8 }]);
  assert.throws(() => gamepad.process({ axes: [2, 0], buttons: [{ pressed: false, value: 0 }, { pressed: false, value: 0 }] }), /input-detail-range/);
  assert.deepEqual(gamepad.release(), { buttons: [{ id: 'button-0', pressed: false, pressure: 0 }], hats: [{ id: 'hat-0', direction: 'center' }] });
  assert.deepEqual(gamepad.release(), { buttons: [], hats: [] });
});

test('gamepad rejects invented inventory and malformed calibration', () => {
  assert.throws(() => createGamepadDetailProcessor({ axes: [], buttonCount: 1, triggers: [1], hats: [] }), /input-detail-range/);
  assert.throws(() => createGamepadDetailProcessor({ axes: [{ min: -1, center: 1, max: 1, deadzone: 0 }], buttonCount: 0, triggers: [], hats: [] }), /input-detail-range/);
});

test('gamepad snapshots calibrated inventory so later caller mutation cannot change controls', () => {
  const axes = [{ min: -1, center: 0, max: 1, deadzone: 0 }];
  const triggers = [0], hats: { xAxis: number; yAxis: number; threshold: number }[] = [];
  const config = { axes, buttonCount: 1, triggers, hats };
  const gamepad = createGamepadDetailProcessor(config);
  axes[0]!.center = 0.5; triggers.push(1); hats.push({ xAxis: 0, yAxis: 0, threshold: 0.5 });
  config.buttonCount = 2;
  const result = gamepad.process({ axes: [0.5], buttons: [{ pressed: false, value: 0.25 }] });
  assert.deepEqual(result.axes, [0.5]);
  assert.deepEqual(result.triggers, [{ id: 'button-0', value: 0.25 }]);
  assert.deepEqual(result.hats, []);
});

test('trigger calibration maps a declared raw range while rejecting readings outside it', () => {
  const gamepad = createGamepadDetailProcessor({ axes: [], buttonCount: 1,
    triggers: [{ button: 0, min: -1, max: 1 }], hats: [] });
  const result = gamepad.process({ axes: [], buttons: [{ pressed: true, value: 0 }] });
  assert.deepEqual(result.triggers, [{ id: 'button-0', value: 0.5 }]);
  assert.deepEqual(result.buttons, [{ id: 'button-0', pressed: true, pressure: 0.5 }]);
  assert.throws(() => gamepad.process({ axes: [], buttons: [{ pressed: true, value: 2 }] }), /input-detail-range/);
});
