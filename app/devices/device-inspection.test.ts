import assert from 'node:assert/strict';
import test from 'node:test';
import type { LinkMessage, LinkTransport } from '@101/protocol';
const api = await import('./device-inspection.ts').catch(() => undefined);
const hello = (capabilities = { touch: true, camera: true }) => ({ channel: 'control', payload: { type: 'hello', version: 2, deviceId: 'actual-controller',
  device: '101 Link browser controller', capabilities, features: { inputFormats: ['input-q1'], speakerAudio: 'locked' } } }) as LinkMessage;
function fixture() {
  assert.ok(api, 'Devices requires an inspectable current-room discovery boundary');
  let at = 1000, connects = 0, disconnects = 0, sent = 0; const listeners = new Set<(value: LinkMessage) => void>();
  let finish: (() => void) | undefined;
  const transport: LinkTransport = { connect() { connects++; return new Promise<void>(resolve => { finish = resolve; }); }, async disconnect() { disconnects++; },
    sendReliable() { sent++; }, sendRealtime() { sent++; }, onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const observer = api.createLinkedDeviceObserver({ sessionId: 'INSPECT-ROOM', transport, now: () => at, onChange() {} });
  return { observer, at(value: number) { at = value; }, deliver(value: LinkMessage) { for (const listener of listeners) listener(value); },
    finish() { finish?.(); }, connects: () => connects, disconnects: () => disconnects, sent: () => sent, listeners: () => listeners.size };
}

test('passive discovery is inert until Find, preserves only real reported input semantics, and never assigns a role', async () => {
  const f = fixture(); try {
    assert.equal(f.connects(), 0); const starting = f.observer.start(); f.finish(); assert.equal(await starting, true); f.deliver(hello());
    const row = f.observer.snapshot().devices[0]; assert.ok(row); assert.equal(row.state, 'partial');
    assert.equal(row.resources.find(resource => resource.id === 'touch')?.state, 'unchecked');
    assert.equal(row.resources.some(resource => resource.id === 'camera-hand'), false);
    assert.equal(row.resources.find(resource => resource.id === 'camera')?.state, 'unsupported'); assert.equal(f.sent(), 0);
    f.at(1001); f.deliver(hello()); assert.equal(f.observer.snapshot().devices.length, 1);
  } finally { await f.observer.close(); }
});

test('quiet loss remains visible as offline and cancel cannot release an unresolved real transport lease early', async () => {
  const f = fixture(); const starting = f.observer.start(); f.deliver(hello()); const stopping = f.observer.stop();
  assert.equal(f.listeners(), 0); assert.equal(f.observer.snapshot().reserved, true); assert.equal(await f.observer.start(), false);
  f.finish(); assert.equal(await starting, false); await stopping; assert.equal(f.disconnects(), 1); assert.equal(f.observer.snapshot().reserved, false);
  const restarted = f.observer.start(); f.finish(); assert.ok(await restarted); f.deliver(hello()); f.at(7001); f.observer.sweep();
  assert.equal(f.observer.snapshot().devices[0]?.state, 'offline'); assert.equal(f.observer.snapshot().devices[0]?.resources.every(resource => resource.state !== 'observed'), true);
  await f.observer.close(); assert.equal(f.listeners(), 0); assert.equal(f.observer.snapshot().timerArmed, false);
});

test('local API presence and camera permission are inspection/setup state, not observed activity', () => {
  assert.ok(api); const rows = api.inspectLocalDevice({ capabilities: { camera: true, gyroscope: true }, sources: ['camera-hand', 'camera-pose', 'phone-motion'], shape: 'computer' },
    { cameraApi: true, cameraPermission: 'denied' });
  assert.equal(rows.resources.find(row => row.id === 'camera')?.state, 'denied');
  assert.equal(rows.resources.find(row => row.id === 'phone-motion')?.state, 'needs-permission');
  assert.equal(rows.resources.some(row => row.state === 'observed'), false);
});

test('reentrant cancellation during actual connect keeps its unresolved issued lease reserved until settlement', async () => {
  assert.ok(api); let finish!: () => void, stopped: Promise<void> | undefined, disconnects = 0;
  const observer = api.createLinkedDeviceObserver({ sessionId: 'CURRENT-ROOM', now: () => 1000, onChange() {}, transport: {
    connect() { stopped = observer.stop(); return new Promise<void>(resolve => { finish = resolve; }); },
    async disconnect() { disconnects++; }, sendReliable() {}, sendRealtime() {}, onMessage() { return () => {}; } } });
  const started = observer.start();
  try { await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(observer.snapshot().reserved, true); assert.equal(disconnects, 0); finish(); assert.equal(await started, false); await stopped;
    assert.equal(disconnects, 1); assert.equal(observer.snapshot().reserved, false);
  } finally { finish(); await started; await observer.close(); }
});

test('clock loss retires observation immediately and cannot resume reports after clock restoration', async () => {
  assert.ok(api); let broken = false, callback!: (value: LinkMessage) => void;
  const observer = api.createLinkedDeviceObserver({ sessionId: 'CURRENT-ROOM', now() { if (broken) throw Error('clock'); return 1000; }, onChange() {},
    transport: { async connect() {}, async disconnect() {}, sendReliable() {}, sendRealtime() {}, onMessage(cb) { callback = cb; return () => {}; } } });
  try { assert.ok(await observer.start()); callback(hello()); broken = true; callback(hello()); broken = false; callback(hello());
    assert.equal(observer.snapshot().phase, 'failed'); assert.equal(observer.snapshot().devices[0]?.state, 'offline');
  } finally { broken = false; await observer.close(); }
});

const frame = (sequence: number, changes: Record<string, unknown> = {}) => ({ channel: 'realtime', payload: {
  deviceId: 'actual-controller', playerId: 'player-1', sequence, timestamp: 1000, source: 'custom',
  actions: { trigger: false, buttonB: false }, vectors: { move: { x: 0, y: 0 } }, axes: {}, ...changes,
} }) as LinkMessage;

test('only current bounded input reports qualify activity, and received values are never retained', async () => {
  const f = fixture(); try { const started = f.observer.start(); f.finish(); assert.ok(await started); f.deliver(hello());
    f.deliver(frame(0, { deviceId: 'unseen-controller' })); f.deliver(frame(0, { axes: { movement: Infinity } }));
    f.deliver(frame(0, { actions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`a${i}`, true])) }));
    assert.equal(f.observer.snapshot().devices[0]?.state, 'partial');
    f.deliver(frame(0)); assert.equal(f.observer.snapshot().devices[0]?.state, 'active');
    const exported = JSON.stringify(f.observer.snapshot()); assert.ok(!exported.includes('trigger') && !exported.includes('sequence'));
    f.at(3001); f.deliver(frame(0)); f.observer.sweep(); assert.equal(f.observer.snapshot().devices[0]?.state, 'partial');
    f.deliver(frame(1)); assert.equal(f.observer.snapshot().devices[0]?.state, 'active');
    f.at(9002); f.observer.sweep(); f.deliver(frame(2)); assert.equal(f.observer.snapshot().devices[0]?.state, 'offline');
  } finally { await f.observer.close(); }
});

test('unknown input and reported labels do not invent resources, while devices and work stay bounded', async () => {
  const f = fixture(); try { const started = f.observer.start(); f.finish(); assert.ok(await started);
    for (let i = 0; i < 9; i++) f.deliver({ channel: 'control', payload: { type: 'hello', version: 2, deviceId: `device-${i}`, device: 'Camera keyboard controller', capabilities: {} } });
    assert.equal(f.observer.snapshot().devices.length, 8);
    const device = f.observer.snapshot().devices[0]; assert.equal(device?.state, 'unknown');
    assert.deepEqual(device?.resources.map(row => row.id), ['unknown-input']);
    for (let i = 0; i < 56; i++) f.deliver(hello());
    assert.equal(f.observer.snapshot().phase, 'failed'); assert.equal(f.observer.snapshot().timerArmed, false);
    await f.observer.stop(); assert.equal(f.observer.snapshot().reserved, false); assert.equal(f.sent(), 0);
  } finally { await f.observer.close(); }
});

test('late callbacks from a replaced observation cannot repopulate the new room observation', async () => {
  assert.ok(api); let callbacks: ((value: LinkMessage) => void)[] = [];
  const observer = api.createLinkedDeviceObserver({ sessionId: 'CURRENT-ROOM', now: () => 1000, onChange() {}, transport: {
    async connect() {}, async disconnect() {}, sendReliable() {}, sendRealtime() {}, onMessage(callback) { callbacks.push(callback); return () => {}; },
  } });
  try { assert.ok(await observer.start()); const old = callbacks[0]!; await observer.stop(); assert.ok(await observer.start());
    old(hello()); assert.equal(observer.snapshot().devices.length, 0); callbacks[1]!(hello()); assert.equal(observer.snapshot().devices.length, 1);
    await observer.close(); callbacks[1]!(frame(0)); assert.equal(observer.snapshot().devices[0]?.state, 'offline');
  } finally { callbacks = []; await observer.close(); }
});

test('stop during a clock callback and during the view callback cannot install a listener or timer', async () => {
  assert.ok(api); let stopInClock = false, stopInView = false, listeners = 0, connects = 0;
  const observer = api.createLinkedDeviceObserver({ sessionId: 'CURRENT-ROOM', now() { if (stopInClock) void observer.stop(); return 1000; }, onChange(value) { if (stopInView && value.phase === 'listening') void observer.stop(); }, transport: {
    async connect() { connects++; }, async disconnect() {}, sendReliable() {}, sendRealtime() {}, onMessage() { listeners++; return () => { listeners--; }; },
  } });
  try { stopInClock = true; assert.equal(await observer.start(), false); assert.equal(connects, 0); assert.equal(listeners, 0);
    stopInClock = false; stopInView = true; assert.equal(await observer.start(), false); await observer.stop();
    assert.equal(listeners, 0); assert.equal(observer.snapshot().timerArmed, false); assert.equal(observer.snapshot().reserved, false);
  } finally { stopInClock = false; stopInView = false; await observer.close(); }
});
