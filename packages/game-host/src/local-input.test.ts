import assert from 'node:assert/strict';
import test from 'node:test';
import { InputBus } from '@101/input';
import { createBodyDodgeGame } from '../../../games/bodydodge/src/game.ts';
import { connectLocalGameInput } from './local-input.ts';

test('SDK local subscriptions drive real game state and clear readiness and held input on close', () => {
  const saved = new Map(['window', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const surface = new EventTarget(), callbacks = new Map<number, FrameRequestCallback>(); let serial = 0;
  let pads: unknown[] = [];
  const values = { window: surface, navigator: { getGamepads: () => pads }, requestAnimationFrame: (callback: FrameRequestCallback) => { callbacks.set(++serial, callback); return serial; }, cancelAnimationFrame: (id: number) => callbacks.delete(id) };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const bus = new InputBus(), game = createBodyDodgeGame('sdk-local-input');
  const context = { input: bus, state: game.initialState(), assets: { load: async () => {} } };
  let changes = 0;
  const local = connectLocalGameInput({ inputBus: bus, onAvailability: () => { changes++; } });
  try {
    game.start?.(context);
    assert.deepEqual(bus.availableSources(), ['keyboard']);
    surface.dispatchEvent(Object.assign(new Event('keydown'), { code: 'ArrowRight' }));
    game.update(context, .1); assert.ok(context.state.players[0]!.playerX > 0);
    surface.dispatchEvent(new Event('blur')); assert.equal(bus.axis('dodgeX'), 0);
    pads = [{ index: 0, axes: [-1, 0], buttons: [] }];
    const [id, callback] = [...callbacks][0]!; callbacks.delete(id); callback(0);
    assert.ok(bus.availableSources().includes('gamepad')); assert.equal(bus.axis('dodgeX'), -1);
    local.close(); assert.deepEqual(bus.availableSources(), []); assert.equal(bus.axis('dodgeX'), 0);
    assert.equal(bus.connectedDevices().length, 0); assert.equal(callbacks.size, 0); assert.ok(changes >= 3);
    surface.dispatchEvent(Object.assign(new Event('keydown'), { code: 'Space' })); assert.equal(bus.action('jump'), false);
    local.close();
  } finally {
    local.close(); game.stop?.(context);
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
