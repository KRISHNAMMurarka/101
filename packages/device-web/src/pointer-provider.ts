import { getInputProfile } from '@101/device-model';
import type { DeviceDescriptor } from '@101/device-model';
import { RemoteResourcePublisher } from './binding.ts';
import type { ResourcePeer } from './binding.ts';
import { PointerSourceDriver } from './pointer-driver.ts';

/** Application pointer profile. Declaration describes the source's selected API, not OS injection. */
export function pointerSourceDescriptor(platform = 'provider-selected-by-host'): DeviceDescriptor {
  return { schemaVersion: 1, id: 'touch-surface', label: 'Touch surface', revision: 1,
    adapter: { id: 'app:touch-surface', version: '1.0.0' }, runtime: { platform },
    capabilities: getInputProfile('app:pointer/1').capabilities.map(capability => structuredClone(capability)) };
}
export interface PointerResourceProviderOptions {
  peer: ResourcePeer; epoch: string; clockId: string; now: () => number; platform: string;
  authentication?: 'local-diagnostic';
  available: () => boolean; onStatus?: (status: string) => void;
}
/** Shared provider lifetime. Call tick from an owned loop; input starts after actual selection. */
export class PointerResourceProvider {
  private readonly peer: ResourcePeer;
  private readonly now: () => number;
  private readonly available: () => boolean;
  private readonly publisher: RemoteResourcePublisher;
  private input?: PointerSourceDriver;
  private started = false;
  private stopped = false;
  constructor(options: PointerResourceProviderOptions) {
    this.peer = options.peer; this.now = options.now; this.available = options.available;
    this.publisher = new RemoteResourcePublisher({ ...options, device: pointerSourceDescriptor(options.platform), available: () => this.isAvailable() });
  }
  private isAvailable(): boolean { try { return !this.stopped && this.available() === true; } catch { return false; } }
  private bound(): boolean { return this.publisher.isBound('position') && this.publisher.isBound('contact'); }
  tick(): void {
    if (this.stopped) return;
    if (!this.isAvailable() || this.publisher.status().stopped) { this.stop(); return; }
    if (!this.started && this.peer.isOpen('reliable') && this.peer.isOpen('disposable')) {
      this.started = this.publisher.start();
      if (!this.started) { this.stop(); return; }
    }
    this.publisher.tick();
    if (this.input && !this.bound()) { this.stop(); return; }
    if (!this.input && this.bound()) this.input = new PointerSourceDriver({ now: this.now,
      publish: (capability, value, metadata) => this.publisher.publish(capability, value, metadata) });
    this.input?.tick();
    if (this.input?.state().stopped || this.publisher.status().stopped) this.stop();
  }
  driver(): PointerSourceDriver | undefined { return !this.stopped && this.bound() ? this.input : undefined; }
  status(): Readonly<{ ready: boolean; stopped: boolean; reason: string }> {
    return Object.freeze({ ready: !!this.driver(), stopped: this.stopped, reason: this.publisher.status().reason });
  }
  stop(): void {
    if (this.stopped) return;
    // Release through the still-live reliable route before retiring its authority.
    this.input?.stop(); this.stopped = true; this.publisher.stop();
  }
}
