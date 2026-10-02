import assert from 'node:assert/strict';
import test from 'node:test';
import { PointerResourceProvider } from '@101/connect';
import type { ResourcePeer } from '@101/connect';
import { createRemotePointerSurface } from '../examples/device-pipelines/remote-pointer.ts';
class Peer implements ResourcePeer {
  state: ResourcePeer['state'] = 'connected'; other?: Peer;
  listeners = new Set<(lane: 'reliable' | 'disposable', data: string | ArrayBuffer) => void>();
  isOpen() { return true; }
  send(lane: 'reliable' | 'disposable', data: string | ArrayBuffer | Uint8Array) {
    const value = data instanceof Uint8Array ? data.slice().buffer : data;
    for (const listener of [...this.other!.listeners]) listener(lane, value); return true;
  }
  onData(listener: (lane: 'reliable' | 'disposable', data: string | ArrayBuffer) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onStateChange() { return () => {}; }
}
test('owner approval begins at explicit selection after an idle pairing exchange', () => {
  let now = 100;
  const host = new Peer(), phone = new Peer(); host.other = phone; phone.other = host;
  const epoch = '0123456789abcdef0123456789abcdef';
  const surface = createRemotePointerSurface({ authentication: 'local-diagnostic', peer: host, epoch, clockId: 'surface', now: () => now,
    principalId: 'owner', applicationId: 'test', sessionId: 'pairing', width: 200, height: 100 });
  const provider = new PointerResourceProvider({ authentication: 'local-diagnostic', peer: phone, epoch, clockId: 'phone', now: () => now + 1000, platform: 'browser', available: () => true });
  provider.tick(); surface.tick();
  now += 70000;
  provider.tick(); surface.tick();
  assert.equal(surface.select(), true);
  provider.tick(); surface.tick();
  assert.ok(surface.state().position);
  now += 60000; surface.tick(); provider.tick();
  assert.equal(surface.state().contact, false); assert.equal(surface.state().position, undefined);
  surface.stop(); provider.stop();
});
