import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceRuntime } from '@101/device-runtime';
import { RemoteResourceReceiver } from './binding.ts';
import { PointerResourceProvider, pointerSourceDescriptor } from './pointer-provider.ts';
import type { ResourcePeer } from './binding.ts';
const epoch = '0123456789abcdef0123456789abcdef';
type Lane = 'reliable' | 'disposable';
class Peer implements ResourcePeer {
  state: ResourcePeer['state'] = 'connecting'; other?: Peer;
  listeners = new Set<(lane: Lane, data: string | ArrayBuffer) => void>();
  states = new Set<(state: ResourcePeer['state']) => void>();
  sent: { lane: Lane; data: string | ArrayBuffer }[] = [];
  dropped = false;
  isOpen() { return this.state === 'connected'; }
  send(lane: Lane, data: string | ArrayBuffer | Uint8Array) {
    if (!this.isOpen()) return false;
    const packet = { lane, data: typeof data === 'string' ? data : data instanceof ArrayBuffer ? data : data.slice().buffer };
    this.sent.push(packet);
    if (!(this.dropped && lane === 'disposable')) for (const listener of [...this.other!.listeners]) listener(lane, packet.data);
    return true;
  }
  onData(listener: (lane: Lane, data: string | ArrayBuffer) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onStateChange(listener: (state: ResourcePeer['state']) => void) { this.states.add(listener); listener(this.state); return () => { this.states.delete(listener); }; }
  change(state: ResourcePeer['state']) { this.state = state; for (const listener of [...this.states]) listener(state); }
}
function harness() {
  let time = 100, available = true;
  const host = new Peer(), phone = new Peer(); host.other = phone; phone.other = host;
  const device = pointerSourceDescriptor('browser');
  const runtime = createDeviceRuntime({ now: () => time, clockDomain: 'surface', authorize: () => ({ expiresAt: 10000, maxHz: 60, maxAgeMs: 100 }) });
  const received: { capability: string; value: unknown }[] = [];
  let releases = 0;
  const sinkDevice = { ...device, id: 'surface', capabilities: device.capabilities.map(value => ({ ...value, kind: 'property' as const, permissions: ['write' as const], ownership: { mode: 'exclusive' as const } })) };
  const sinks = new Map(sinkDevice.capabilities.map(capability => {
    const sink = runtime.registerSink({ device: sinkDevice, capability: capability.id,
      apply: observation => { received.push({ capability: capability.id, value: observation.value }); }, release: () => { releases++; } });
    runtime.setReadiness(sink, 'available'); return [capability.id, sink];
  }));
  const receiver = new RemoteResourceReceiver({ peer: host, runtime, epoch, clockId: 'surface', now: () => time,
    principalId: 'owner', applicationId: 'surface', sessionId: 'local-test' });
  const provider = new PointerResourceProvider({ peer: phone, epoch, clockId: 'phone', now: () => time + 1000, platform: 'browser', available: () => available });
  const tick = () => { provider.tick(); receiver.tick(); };
  const approve = (capability: string) => receiver.approve({ capability, sink: sinks.get(capability)!, sinkDevice, sinkCapability: capability,
    grant: { expiresAt: 10000, maxHz: 60, maxAgeMs: 100 }, codec: capability === 'position' ? 'normalized-pointer/1' : 'json/1' });
  return { host, phone, provider, receiver, received, approve, tick, releases: () => releases,
    advance(ms = 20) { time += ms; tick(); }, connect() { host.change('connected'); phone.change('connected'); tick(); },
    unavailable() { available = false; tick(); }, close() { provider.stop(); receiver.stop(); runtime.close(); } };
}
test('source waits for both open lanes and both selected capabilities before creating input', () => {
  const h = harness(); h.tick(); assert.equal(h.provider.status().ready, false); assert.equal(h.phone.sent.length, 0);
  h.connect(); assert.ok(h.receiver.description()); assert.equal(h.provider.driver(), undefined);
  h.approve('position'); h.tick(); assert.equal(h.provider.driver(), undefined);
  h.approve('contact'); h.tick(); assert.equal(h.provider.status().ready, true); assert.ok(h.provider.driver());
  assert.ok(h.received.some(value => value.capability === 'position')); h.close();
});
test('actual driver contact/recontact and opposite diagonal state survives disposable loss', () => {
  const h = harness(); h.connect(); h.approve('position'); h.approve('contact'); h.tick();
  const driver = h.provider.driver()!;
  driver.begin(1, 20, 20, 100, 100); h.tick();
  assert.deepEqual(driver.state().position, { x: 0.5, y: 0.5 });
  h.phone.dropped = true; h.advance(); driver.move(1, 50, 50, 100, 100); h.tick();
  h.phone.dropped = false; h.advance(); driver.move(1, 30, 10, 100, 100); h.tick();
  h.advance(); driver.end(1); h.advance(); driver.begin(2, 90, 90, 100, 100); h.advance(); driver.end(2); h.advance();
  const positions = h.received.filter(value => value.capability === 'position');
  const value = positions.at(-1)!.value as { x: number; y: number };
  assert.ok(Math.abs(value.x - 0.6) < 1e-6 && Math.abs(value.y - 0.4) < 1e-6);
  assert.equal(h.received.at(-1)!.value, false); h.close();
});
test('permission/foreground loss and peer loss terminate input and release held sinks', () => {
  for (const loss of ['unavailable', 'peer'] as const) {
    const h = harness(); h.connect(); h.approve('position'); h.approve('contact'); h.tick();
    const driver = h.provider.driver()!; driver.setContact(true); h.advance();
    if (loss === 'unavailable') h.unavailable(); else { h.phone.change('disconnected'); h.host.change('disconnected'); h.tick(); }
    assert.equal(h.provider.status().stopped, true); assert.equal(driver.state().contact, false); assert.equal(driver.state().stopped, true);
    assert.equal(h.provider.driver(), undefined); assert.equal(h.releases(), 2); h.close();
  }
});
