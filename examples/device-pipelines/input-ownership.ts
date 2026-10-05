import { createDeviceRuntime, createInputOwnershipController, pointerSourceDescriptor, PointerSourceDriver } from '@101/connect';
import type { InputOwnershipController, Observation } from '@101/connect';

/** Two actual browser input producers and typed application sinks; no OS injection or remote identity claim. */
export function createInputOwnershipExample(options: { partitioned?: boolean; now?: () => number; onChange?: () => void } = {}) {
  const now = options.now ?? (() => performance.now());
  let stopped = false, grantsEnabled = true;
  let grants = 0, accepted = 0, rejected = 0, frames = 0, releases = 0;
  const values = new Map<string, { routeId: string; value: Observation['value'] }>();
  const notify = () => { try { options.onChange?.(); } catch { /* UI reporting cannot own input. */ } };
  const runtime = createDeviceRuntime({ now, clockDomain: 'local-input-ownership', authorize(request) {
    if (stopped || !grantsEnabled || !controller?.isApproved(request)) return;
    grants++; return { expiresAt: now() + 60000, maxAgeMs: 100, maxHz: 60 };
  } });
  const descriptions = ['first', 'second'].map((id, index) => ({ ...pointerSourceDescriptor('browser-application'), id: `local-${id}-pointer`, label: `Local input ${index + 1}` }));
  const sources = descriptions.map((device, index) => {
    const resources = device.capabilities.map(capability => {
      const handle = runtime.registerSource({ device, capability: capability.id }); runtime.setReadiness(handle, 'available'); return { handle, device, capability: capability.id };
    });
    let operation = 0;
    const driver = new PointerSourceDriver({ now, publish(capabilityId, value, metadata) {
      if (stopped) return false;
      const at = metadata.capturedAt, capability = device.capabilities.find(value => value.id === capabilityId)!, resource = resources.find(value => value.capability === capabilityId)!;
      const result = runtime.publish(resource.handle, value, { timestamp: at, clockDomain: runtime.clockDomain,
        ...(capability.delivery.mode === 'reliable' ? { operationId: String(++operation), deadline: at + capability.delivery.maxAgeMs } : {}) });
      if (!result.ok) { rejected++; return false; }
      accepted += result.value.accepted; rejected += result.value.rejected; return result.value.accepted > 0 && result.value.rejected === 0;
    } });
    return { id: index === 0 ? 'first' : 'second', label: device.label, principalId: `local-input-owner-${index + 1}`, resources, driver };
  });
  const device = { ...pointerSourceDescriptor('browser-application'), id: 'local-owned-pointer-surface', label: 'Application input surfaces',
    capabilities: pointerSourceDescriptor().capabilities.map(capability => ({ ...capability, kind: 'property', permissions: ['write'],
      ownership: options.partitioned === false ? { mode: 'exclusive' } : { mode: 'partitioned', partitions: ['left', 'right'] } })) };
  const resources = device.capabilities.map(capability => {
    const handle = runtime.registerSink({ device, capability: capability.id, apply(observation, context) {
      if (stopped || context.signal.aborted || !context.isCurrent()) return;
      values.set(`${context.partition ?? 'exclusive'}:${capability.id}`, { routeId: context.routeId, value: observation.value }); frames++; notify();
    }, release(_reason, context) {
      const key = `${context.partition ?? 'exclusive'}:${capability.id}`;
      if (values.get(key)?.routeId === context.routeId) values.delete(key);
      releases++; notify();
    } }); runtime.setReadiness(handle, 'available'); return { handle, device, capability: capability.id };
  });
  const controller: InputOwnershipController = createInputOwnershipController({ runtime, applicationId: 'local-input-ownership', sessionId: 'local-session', now,
    sources, destination: { label: device.label, resources } });
  const owned = controller;
  let previous = new Set<string>();
  const remove = owned.subscribe(() => {
    const current = new Set(owned.snapshot().slots.flatMap(slot => slot.owner ? [slot.owner.sourceId] : []));
    for (const source of sources) if (previous.has(source.id) !== current.has(source.id)) source.driver.release();
    previous = current; notify();
  });
  return {
    controller: owned, runtime, sources: sources.map(({ id, label, driver }) => ({ id, label, driver })),
    tick() { if (stopped) return; owned.tick(); for (const source of sources) source.driver.tick(); runtime.flush(); },
    setGrantsEnabled(value: boolean) { if (typeof value !== 'boolean' || stopped) return; grantsEnabled = value; notify(); },
    interrupt() {
      for (const source of sources) source.driver.release();
      for (const slot of owned.snapshot().slots) {
        if (slot.request) owned.cancel(slot.request.id);
        if (slot.owner) owned.release(slot.id, slot.owner.epoch);
      }
      notify();
    },
    state() {
      return Object.freeze({ stopped, grantsEnabled, grants, accepted, rejected, frames, releases,
        surfaces: Object.freeze(owned.snapshot().slots.map(slot => {
          const position = values.get(`${slot.id}:position`)?.value;
          return Object.freeze({ id: slot.id, contact: values.get(`${slot.id}:contact`)?.value === true,
            ...(position && typeof position === 'object' && 'x' in position && 'y' in position && typeof position.x === 'number' && typeof position.y === 'number'
              ? { position: Object.freeze({ x: position.x, y: position.y }) } : {}) });
        })) });
    },
    stop() { if (stopped) return; stopped = true; remove(); owned.close(); for (const source of sources) source.driver.stop(); runtime.close(); values.clear(); notify(); },
  };
}
