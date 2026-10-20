import assert from 'node:assert/strict';
import test from 'node:test';
import { InputBus } from '../packages/input/src/index.ts';
import { pointerSourceDescriptor } from '@uynis-connect/connect';
import type { Observation } from '@uynis-connect/connect';
import { createGamePointerBridge, INPUT_LAB_POINTER_MANIFEST, type GamePointerBridgeOptions } from '../examples/device-pipelines/game-pointer-bridge.ts';

function observation(capability: 'position' | 'contact', value: Observation['value'], sequence = 1): Observation {
  return { value, sequence, timestamp: 90, receivedAt: 100, clockDomain: 'host', quality: 'valid',
    source: { registrationId: 'source-registration', deviceId: 'touch-surface', capabilityId: capability } };
}
function harness(overrides: Partial<GamePointerBridgeOptions> = {}) {
  const bus = new InputBus(), frames: Parameters<InputBus['accept']>[0][] = [];
  bus.subscribe(frame => frames.push(frame));
  const bridge = createGamePointerBridge({ manifest: INPUT_LAB_POINTER_MANIFEST,
    scope: { applicationId: 'input-lab', sessionId: 'session-1', playerId: 'player-1', roleId: 'classic', deviceId: 'remote-1', clockDomain: 'host' },
    mapping: { vector: 'aim', action: 'trigger', coordinates: 'normalized-to-signed', source: 'custom' },
    emit: frame => bus.accept(frame), removeDevice: (id, player) => { bus.removeDevice(id, player); }, now: () => 100, ...overrides });
  return { bridge, bus, frames };
}

test('owner approval intentionally maps normalized pointer into actual aim and trigger controls', () => {
  const h = harness();
  assert.equal(h.bridge.apply('position', observation('position', { x: 0.25, y: 0.75 }), () => true), false);
  assert.equal(h.bridge.approve(pointerSourceDescriptor()), true);
  assert.equal(h.bridge.apply('position', observation('position', { x: 0.25, y: 0.75 }, 5), () => true), true);
  assert.equal(h.bridge.apply('contact', observation('contact', true, 2), () => true), true);
  assert.deepEqual(h.bus.vector('aim'), { x: -0.5, y: 0.5 }); assert.equal(h.bus.action('trigger'), true);
  assert.deepEqual(h.frames.map(frame => frame.sequence), [5, 2]);
  assert.deepEqual(h.frames.map(frame => frame.timestamp), [90, 90]);
  assert.equal(h.frames.every(frame => frame.playerId === 'player-1' && frame.source === 'custom'), true);
  assert.equal(h.bus.action('trigger', 'player-2'), false);
});

test('invalid manifest, undeclared controls, source support, coordinate mapping and scope fail closed', () => {
  assert.throws(() => harness({ manifest: { game: 'input-lab' } }));
  assert.throws(() => harness({ mapping: { vector: 'move', action: 'trigger', coordinates: 'normalized-to-signed', source: 'custom' } }));
  assert.throws(() => harness({ mapping: { vector: 'aim', action: 'arbitrary', coordinates: 'normalized-to-signed', source: 'custom' } }));
  assert.throws(() => harness({ manifest: { game: 'input-lab', vectors: { aim: { recommended: ['keyboard'] } }, actions: { trigger: { recommended: ['keyboard'] } } } }));
  assert.throws(() => harness({ scope: { applicationId: 'different-app', sessionId: 'session', playerId: 'player-1', roleId: 'classic', deviceId: 'remote', clockDomain: 'host' } }));
});

test('semantic lookalikes cannot be approved as typed pointer resources', () => {
  const h = harness(); const descriptor = pointerSourceDescriptor();
  descriptor.capabilities[0].semantic = 'sensor:orientation/1';
  assert.equal(h.bridge.approve(descriptor), false);
  assert.equal(h.bridge.apply('position', observation('position', { x: 0, y: 1 }), () => true), false);
});

test('wrong source, stale context, clock mismatch, replay and malformed values cannot refresh a game frame', () => {
  const h = harness(); h.bridge.approve(pointerSourceDescriptor());
  const good = observation('position', { x: 0.1, y: 0.9 }, 4);
  assert.equal(h.bridge.apply('position', good, () => false), false);
  assert.equal(h.bridge.apply('position', { ...good, clockDomain: 'foreign' }, () => true), false);
  assert.equal(h.bridge.apply('position', { ...good, source: { ...good.source, deviceId: 'other-phone' } }, () => true), false);
  for (const value of [{ x: 2, y: 0 }, { x: NaN, y: 0 }, true]) {
    assert.equal(h.bridge.apply('position', { ...good, value }, () => true), false);
  }
  assert.equal(h.frames.length, 0);
  assert.equal(h.bridge.apply('position', good, () => true), true);
  assert.equal(h.bridge.apply('position', good, () => true), false);
  assert.equal(h.frames.length, 1);
});

test('packets cannot select player, role, control or permission', () => {
  const h = harness(); h.bridge.approve(pointerSourceDescriptor());
  const incoming = { ...observation('contact', true), playerId: 'player-2', roleId: 'admin', actions: { arbitrary: true }, authorized: true };
  assert.equal(h.bridge.apply('contact', incoming, () => true), true);
  assert.deepEqual(h.frames[0].actions, { trigger: true }); assert.equal(h.frames[0].playerId, 'player-1');
  assert.equal(h.bus.action('arbitrary'), false);
});

test('stop/loss publishes visible safe neutral and removes both scoped device contributions', () => {
  const h = harness(); h.bridge.approve(pointerSourceDescriptor());
  h.bridge.apply('position', observation('position', { x: 1, y: 0 }, 4), () => true);
  h.bridge.apply('contact', observation('contact', true, 8), () => true);
  h.bridge.stop('connection-lost');
  assert.equal(h.bus.action('trigger'), false); assert.deepEqual(h.bus.vector('aim'), { x: 0, y: 0 });
  assert.deepEqual(h.frames.slice(-2).map(frame => frame.sequence), [5, 9]);
  assert.equal(h.frames.at(-1)!.actions.trigger, false);
  assert.deepEqual(h.frames.at(-2)!.vectors!.aim, { x: 0, y: 0 });
  assert.equal(h.bus.connectedDevices().length, 0);
  assert.equal(h.bridge.state().reason, 'connection-lost');
  assert.equal(h.bridge.apply('contact', observation('contact', true, 10), () => true), false);
  const count = h.frames.length; h.bridge.stop(); assert.equal(h.frames.length, count);
});

test('mapping and scope are captured immutably and approval is not reusable after stop', () => {
  const mapping = { vector: 'aim', action: 'trigger', coordinates: 'normalized-to-signed' as const, source: 'custom' as const };
  const h = harness({ mapping }); h.bridge.approve(pointerSourceDescriptor()); mapping.action = 'arbitrary';
  h.bridge.apply('contact', observation('contact', true), () => true);
  assert.equal(h.bus.action('trigger'), true); h.bridge.stop();
  assert.equal(h.bridge.approve(pointerSourceDescriptor()), false);
  assert.ok(Object.isFrozen(h.bridge.state()));
});

test('position values with undeclared components cannot enter the application mapping', () => {
  const h = harness(); h.bridge.approve(pointerSourceDescriptor());
  assert.equal(h.bridge.apply('position', observation('position', { x: 0, y: 1, z: 0.5 }), () => true), false);
  assert.equal(h.frames.length, 0);
});


test('retiring a remote scope retains existing local controller frames', () => {
  const h = harness(); h.bridge.approve(pointerSourceDescriptor());
  h.bus.accept({ deviceId: 'keyboard-primary', playerId: 'player-1', sequence: 1, timestamp: 100, source: 'keyboard', actions: { trigger: true }, vectors: { move: { x: 1, y: 0 } } });
  h.bridge.apply('contact', observation('contact', true), () => true); h.bridge.stop();
  assert.equal(h.bus.action('trigger'), true); assert.deepEqual(h.bus.vector('move'), { x: 1, y: 0 });
  assert.deepEqual(h.bus.connectedDevices().map(frame => frame.deviceId), ['keyboard-primary']);
});


test('owner-selected source must be declared by both mapped controls', () => {
  assert.throws(() => harness({ mapping: { vector: 'aim', action: 'trigger', coordinates: 'normalized-to-signed', source: 'phone-motion' } }));
  assert.throws(() => harness({ manifest: { game: 'input-lab',
    vectors: { aim: { recommended: ['custom'] } }, actions: { trigger: { recommended: ['mouse'] } } } }));
  const h = harness({ mapping: { vector: 'aim', action: 'trigger', coordinates: 'normalized-to-signed', source: 'touch' } });
  h.bridge.approve(pointerSourceDescriptor()); h.bridge.apply('contact', observation('contact', true), () => true);
  assert.equal(h.frames[0].source, 'touch');
});
