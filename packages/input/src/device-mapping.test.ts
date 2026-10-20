import assert from 'node:assert/strict';
import test from 'node:test';
import { InputBus } from './index.ts';
import { createDeviceMapping } from './device-mapping.ts';

test('keyboard and gamepad preserve bindings, and separate subscriptions cannot erase each other', () => {
  const bus = new InputBus();
  const options = { playerId: 'player-1', emit: frame => bus.accept(frame), removeDevice: (id: string, player: string) => { bus.removeDevice(id, player); } } satisfies Omit<Parameters<typeof createDeviceMapping>[0], "scopeId">;
  const first = createDeviceMapping({ ...options, scopeId: 'first' }), second = createDeviceMapping({ ...options, scopeId: 'second' });
  first.accept({ source: 'keyboard', deviceId: 'keyboard-primary', sequence: 1, timestamp: 0, keys: ['KeyQ', 'ArrowLeft', 'KeyD'] });
  assert.equal(bus.action('spell.cast.shield'), true); assert.equal(bus.axis('shield'), -1); assert.equal(bus.axis('placeX'), 1);
  assert.deepEqual(bus.vector('gravity'), { x: -1, y: 0 }); assert.deepEqual(bus.vector('move'), { x: 0, y: 0 });
  second.accept({ source: 'gamepad', deviceId: 'gamepad-0', sequence: 1, timestamp: 0, connected: true, axes: [.11, .56, -.6], buttons: Array.from({ length: 10 }, (_, i) => ({ pressed: i === 0 || i === 7, value: i === 7 ? .4 : 0 })) });
  assert.equal(bus.action('boost'), true); assert.equal(bus.action('beat.swing'), true); assert.equal(bus.axis('power'), .4); assert.equal(bus.action('combat.duck'), true);
  assert.deepEqual(bus.vector('spell.aim'), { x: -.6, y: .56 });
  second.release('gamepad-0'); assert.equal(bus.action('boost'), false); assert.equal(bus.action('spell.cast.shield'), true);
  first.close(); assert.equal(bus.connectedDevices().length, 0);
  assert.equal(first.accept({ source: 'keyboard', deviceId: 'keyboard-primary', sequence: 2, timestamp: 1, keys: ['Space'] }), false);
});

test('mapping rejects stale source sequences and safely starts a fresh scoped subscription', () => {
  const bus = new InputBus();
  const create = (scopeId: string) => createDeviceMapping({ scopeId, playerId: 'player-2', emit: frame => bus.accept(frame), removeDevice: (id, player) => { bus.removeDevice(id, player); } });
  const mapping = create('old');
  const frame = { source: 'pointer' as const, deviceId: 'pointer-primary-touch', sequence: 4, timestamp: 0, pointerType: 'touch', contact: true, x: .25, y: -.5 };
  assert.equal(mapping.accept(frame), true); assert.equal(mapping.accept(frame), false);
  assert.equal(bus.action('swarm.select', 'player-2'), true);
  mapping.close(); assert.equal(bus.action('swarm.select', 'player-2'), false);
  const fresh = create('fresh'); assert.equal(fresh.accept({ ...frame, sequence: 1 }), true);
  assert.deepEqual(bus.vector('swarm.command', 'player-2'), { x: .25, y: -.5 }); fresh.close();
});

test('subscription availability is scoped and clears without disturbing another owner', () => {
  const bus = new InputBus();
  bus.setSourceAvailability('first', 'gamepad', true);
  bus.setSourceAvailability('second', 'gamepad', true);
  bus.setSourceAvailability('first', 'gamepad', false);
  assert.deepEqual(bus.availableSources(), ['gamepad']);
  bus.setSourceAvailability('second', 'gamepad', false);
  assert.deepEqual(bus.availableSources(), []);
});
