import { createDeviceRuntime, RemoteResourceReceiver, pointerSourceDescriptor } from '@101/connect';
export { pointerSourceDescriptor } from '@101/connect';
import type { DeviceDescriptor, ResourcePeer, WireCodec, RouteGrant, Observation } from '@101/connect';

const surfaceDescriptor: DeviceDescriptor = {
  ...pointerSourceDescriptor(), id: 'application-surface', label: 'Application surface',
  adapter: { id: 'app:pointer-surface', version: '1.0.0' }, runtime: { platform: 'browser-application' },
  capabilities: pointerSourceDescriptor().capabilities.map(capability => ({ ...capability, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } })),
};
interface SurfaceOptions {
  peer: ResourcePeer; epoch: string; principalId: string; applicationId: string; sessionId: string;
  clockId: string; now: () => number; width: number; height: number;
  onChange?: () => void; onObservation?: (observation: Observation) => void; onStatus?: (status: string) => void;
}
/** An app-owned surface. The caller enrolls its peer and invokes select after owner consent. */
export function createRemotePointerSurface(options: SurfaceOptions) {
  if (!Number.isFinite(options.width) || !Number.isFinite(options.height) || options.width <= 0 || options.height <= 0) throw new RangeError('Surface size must be positive');
  let width = options.width, height = options.height, normalized: { x: number; y: number } | undefined;
  let contact = false, releases = 0;
  const allowed = new Set<string>();
  const now = options.now;
  const identity = Object.freeze({ principalId: options.principalId, applicationId: options.applicationId, sessionId: options.sessionId });
  let ownerGrant: Readonly<RouteGrant> | undefined;
  const runtime = createDeviceRuntime({ now, clockDomain: options.clockId, authorize(request) {
    if (request.principalId !== identity.principalId || request.applicationId !== identity.applicationId || request.sessionId !== identity.sessionId ||
      request.source.deviceId !== receiver.description()?.id || !allowed.has(request.source.capabilityId) ||
      request.sink.deviceId !== surfaceDescriptor.id || !['position', 'contact'].includes(request.sink.capabilityId)) return;
    return ownerGrant;
  } });
  const sinks = new Map(surfaceDescriptor.capabilities.map(capability => {
    const handle = runtime.registerSink({ device: surfaceDescriptor, capability: capability.id,
      apply(observation, context) {
        if (!context.isCurrent()) return;
        if (capability.id === 'position' && typeof observation.value === 'object') normalized = { x: observation.value.x, y: observation.value.y };
        if (capability.id === 'contact' && typeof observation.value === 'boolean') contact = observation.value;
        options.onChange?.();
        try { options.onObservation?.(observation); } catch { /* An evidence observer cannot own a route. */ }
      },
      release() { if (capability.id === 'position') normalized = undefined; else contact = false; releases++; options.onChange?.(); },
    });
    runtime.setReadiness(handle, 'available'); return [capability.id, handle];
  }));
  const receiver = new RemoteResourceReceiver({ ...identity, peer: options.peer, epoch: options.epoch, runtime, now,
    clockId: options.clockId, onStatus: options.onStatus });
  function resize(nextWidth: number, nextHeight: number): void {
    if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth <= 0 || nextHeight <= 0) throw new RangeError('Surface size must be positive');
    width = nextWidth; height = nextHeight;
  }
  resize(width, height);
  return {
    receiver,
    select(codec: WireCodec = 'normalized-pointer/1'): boolean {
      const description = receiver.description(); if (!description) return false;
      ownerGrant = Object.freeze({ expiresAt: now() + 60000, maxHz: 60, maxAgeMs: 100 });
      const approved: number[] = [];
      for (const sink of surfaceDescriptor.capabilities) {
        const source = description.capabilities.find(capability => capability.semantic === sink.semantic);
        if (!source) { receiver.stop('incompatible'); return false; }
        allowed.add(source.id);
        const slot = receiver.approve({ capability: source.id, sink: sinks.get(sink.id)!, sinkDevice: surfaceDescriptor,
          sinkCapability: sink.id, grant: ownerGrant, codec: sink.id === 'position' ? codec : 'json/1' });
        if (slot === undefined) { receiver.stop('incompatible'); return false; } approved.push(slot);
      }
      return approved.length === 2;
    },
    resize,
    tick() { receiver.tick(); },
    state() { return { contact, releases, position: normalized ? { x: normalized.x * width, y: normalized.y * height } : undefined }; },
    stop() { receiver.stop(); runtime.close(); allowed.clear(); },
  };
}
