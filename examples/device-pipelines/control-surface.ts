import { createDeviceRuntime, mountControlSurface, parseControlSurface, parseDeviceDescriptor } from '@101/connect';
import type { DeviceCapability, SurfaceControlContext, SurfaceControlEvent } from '@101/connect';

export const controlSurfaceDescription = parseControlSurface({ schemaVersion: 1, id: 'example:controls', title: 'Local application controls',
  minColumnWidth: 240, styles: [{ id: 'plain', tone: 'normal', density: 'comfortable', motion: 'feedback' },
    { id: 'quiet', tone: 'muted', density: 'compact', motion: 'none' }], nodes: [
    { kind: 'box', id: 'actions', title: 'Actions', style: 'plain', children: [
      { kind: 'text', id: 'instructions', style: 'quiet', text: 'Approve access before sending input. Keyboard controls are available.' },
      { kind: 'button', id: 'activate', label: 'Activate', style: 'plain' },
      { kind: 'toggle', id: 'enabled', label: 'Enabled', initial: false, style: 'plain' }] },
    { kind: 'box', id: 'settings', title: 'Settings', style: 'plain', children: [
      { kind: 'slider', id: 'level', label: 'Level', min: 0, max: 10, step: 1, initial: 3, style: 'plain' },
      { kind: 'choice', id: 'mode', label: 'Mode', options: [{ value: 'quiet', label: 'Quiet' }, { value: 'normal', label: 'Normal' }], initial: 'quiet', style: 'plain' },
      { kind: 'value', id: 'received', label: 'Application input', text: 'No input received.', style: 'quiet' }] },
  ] });

/** Public SDK caller: actual typed application delivery, with explicit local test-host approval. No physical effect claim. */
export function createControlSurfaceExample(container: HTMLElement, options: {
  beforeInput?: (event: SurfaceControlEvent, context: SurfaceControlContext) => void | Promise<void>;
  callbackTimeoutMs?: number;
} = {}) {
  const now = () => performance.now();
  const definitions: DeviceCapability[] = [
    { id: 'activate', semantic: 'example:activation', schemaVersion: 1, kind: 'event', value: { type: 'boolean' }, delivery: { mode: 'reliable', maxAgeMs: 1000 }, permissions: ['subscribe'] },
    { id: 'enabled', semantic: 'example:enabled', schemaVersion: 1, kind: 'sample', value: { type: 'boolean' }, delivery: { mode: 'latest', maxHz: 1000, maxAgeMs: 1000 }, permissions: ['subscribe'] },
    { id: 'level', semantic: 'example:level', schemaVersion: 1, kind: 'sample', value: { type: 'scalar', unit: '1', min: 0, max: 10 }, delivery: { mode: 'latest', maxHz: 1000, maxAgeMs: 1000 }, permissions: ['subscribe'] },
    { id: 'mode', semantic: 'example:mode', schemaVersion: 1, kind: 'sample', value: { type: 'enum', values: ['quiet', 'normal'] }, delivery: { mode: 'latest', maxHz: 1000, maxAgeMs: 1000 }, permissions: ['subscribe'] },
  ];
  const sourceDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'example-control-source', label: 'Control surface', revision: 1,
    adapter: { id: 'example:surface', version: '1.0.0' }, runtime: { platform: 'web' }, capabilities: definitions });
  const sinkDevice = parseDeviceDescriptor({ ...sourceDevice, id: 'example-control-application', label: 'Local application',
    capabilities: definitions.map(capability => ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
  const scope = { principalId: 'example-owner', applicationId: 'control-surface-example', sessionId: 'local-session' };
  let approved = false, stopped = false;
  const observed: { id: string; value: boolean | number | string }[] = [];
  const sources = new Map<string, ReturnType<ReturnType<typeof createDeviceRuntime>['registerSource']>>();
  const sinks = new Map<string, ReturnType<ReturnType<typeof createDeviceRuntime>['registerSink']>>();
  const runtime = createDeviceRuntime({ now, clockDomain: 'control-surface-clock', authorize(request) {
    if (!approved || stopped || request.principalId !== scope.principalId || request.applicationId !== scope.applicationId ||
      request.sessionId !== scope.sessionId || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' ||
      request.source.registrationId !== sources.get(request.source.capabilityId)?.id ||
      request.sink.registrationId !== sinks.get(request.source.capabilityId)?.id || request.source.capabilityId !== request.sink.capabilityId) return;
    return { expiresAt: now() + 60000, maxHz: 1000, maxAgeMs: 1000 };
  } });
  for (const capability of definitions) {
    sources.set(capability.id, runtime.registerSource({ device: sourceDevice, capability: capability.id }));
    sinks.set(capability.id, runtime.registerSink({ device: sinkDevice, capability: capability.id, apply(observation, context) {
      if (context.signal.aborted || !context.isCurrent()) return;
      if (observed.length >= 64) observed.shift();
      observed.push({ id: capability.id, value: observation.value as boolean | number | string });
      surface.setText('received', `${capability.id}: ${String(observation.value)}`);
    }, release() { /* These application state choices hold no physical input. */ } }));
  }
  for (const handle of [...sources.values(), ...sinks.values()]) runtime.setReadiness(handle, 'available');
  let routes: ReturnType<typeof runtime.route>[] = [];
  const surface = mountControlSurface({ container, description: controlSurfaceDescription, callbackTimeoutMs: options.callbackTimeoutMs,
    async onControl(event, context) {
      await options.beforeInput?.(event, context);
      if (context.signal.aborted || stopped || !approved) throw new Error('Input unavailable');
      const at = now(), result = runtime.publish(sources.get(event.id)!, event.value, { timestamp: at,
        clockDomain: runtime.clockDomain, ...(definitions.find(capability => capability.id === event.id)!.delivery.mode === 'reliable'
          ? { operationId: String(event.sequence), deadline: at + 1000 } : {}) });
      if (!result.ok || result.value.accepted !== 1 || result.value.rejected !== 0) throw new Error('Input unavailable');
      runtime.flush();
    } });
  function revoke() {
    approved = false;
    for (const capability of definitions) surface.setEnabled(capability.id, false);
    for (const route of routes) route.stop('owner-revoked');
    routes = [];
  }
  return {
    surface, runtime,
    approve(allow = true) {
      revoke(); if (stopped) return false; approved = allow;
      routes = definitions.map(capability => runtime.route({ from: sources.get(capability.id)!, to: sinks.get(capability.id)!, ...scope, queueCapacity: 4, leaseMs: 10000 }));
      const started = routes.map(route => route.start());
      if (started.some(result => !result.ok)) { revoke(); return false; }
      for (const [index, route] of routes.entries()) {
        const id = definitions[index]!.id;
        route.onClose(() => surface.setEnabled(id, false)); surface.setEnabled(id, true);
      }
      return true;
    },
    revoke,
    state() { return Object.freeze({ approved, stopped, received: Object.freeze(observed.map(value => Object.freeze({ ...value }))) }); },
    stop() { if (stopped) return; revoke(); stopped = true; surface.close(); runtime.close(); },
  };
}
