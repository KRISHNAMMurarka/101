import { createDeviceRuntime, GestureSourceDriver, gestureSourceDescriptor, mountGestureSource, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, GestureTransition, GestureWheel } from '@101/connect';

/** Three independently granted routes from a selected surface into an application. */
export function createGesturePipeline(options: { now?: () => number; authorize?: Authorize } = {}) {
  const now = options.now ?? (() => performance.now()), device = gestureSourceDescriptor('embedded-browser-events');
  const sinkDevice = parseDeviceDescriptor({ ...device, id: 'gesture-consumer',
    capabilities: device.capabilities.map(capability => ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
  const scope = { principalId: 'gesture-owner', applicationId: 'gesture-example', sessionId: 'gesture-session' };
  const sources = new Map<string, ReturnType<ReturnType<typeof createDeviceRuntime>['registerSource']>>();
  const sinks = new Map<string, ReturnType<ReturnType<typeof createDeviceRuntime>['registerSink']>>();
  const sequences = new Map<string, number>();
  const held = new Map<number, GestureTransition>();
  const transitions: GestureTransition[] = [], wheels: GestureWheel[] = [];
  let position: Readonly<{ x: number; y: number }> | undefined, releases = 0, closing = false;
  const runtime = createDeviceRuntime({ now, clockDomain: 'gesture-clock', authorize(request) {
    const name = request.source.capabilityId;
    if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
      request.source.registrationId !== sources.get(name)?.id || request.sink.registrationId !== sinks.get(name)?.id ||
      request.sink.capabilityId !== name || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
    return options.authorize ? options.authorize(request) : { expiresAt: now() + 60000, maxHz: 1000, maxAgeMs: 1000 };
  } });
  for (const capability of device.capabilities) {
    const name = capability.id;
    sources.set(name, runtime.registerSource({ device, capability: name }));
    sinks.set(name, runtime.registerSink({ device: sinkDevice, capability: name, apply(observation, context) {
      if (!context.isCurrent() || context.signal.aborted) return;
      if (name === 'gesture') {
        const event = observation.value as unknown as GestureTransition;
        if (transitions.length >= 128) transitions.shift(); transitions.push(event);
        if (event.phase === 'start') held.set(event.gestureId, event);
        else held.delete(event.gestureId);
      } else if (name === 'position') position = observation.value as Readonly<{ x: number; y: number }>;
      else {
        if (wheels.length >= 128) wheels.shift();
        wheels.push(observation.value as unknown as GestureWheel);
      }
    }, release() { held.clear(); position = undefined; releases++; } }));
  }
  for (const handle of [...sources.values(), ...sinks.values()]) runtime.setReadiness(handle, 'available');
  const connections = [...sources].map(([name, source]) => runtime.route({ from: source, to: sinks.get(name)!,
    ...scope, queueCapacity: 64, leaseMs: 10000 }));
  const closeRoutes = (reason: string) => {
    if (closing) return;
    closing = true;
    for (const connection of connections) connection.stop(reason);
  };
  const start = connections.map(connection => connection.start());
  const driver = new GestureSourceDriver({ now, publish(name, value, { capturedAt }) {
    const sequence = (sequences.get(name) ?? 0) + 1;
    const result = runtime.publish(sources.get(name)!, value, { timestamp: capturedAt, clockDomain: runtime.clockDomain,
      ...(name === 'position' ? {} : { operationId: String(sequence), deadline: capturedAt + 1000 }) });
    if (result.ok) sequences.set(name, sequence);
    const admitted = result.ok && result.value.accepted > 0 && result.value.rejected === 0;
    if (!admitted) closeRoutes('source-rejected');
    return admitted;
  } });
  for (const connection of connections) connection.onClose(() => { driver.stop(); closeRoutes('source-disconnected'); });
  if (start.some(result => !result.ok)) { driver.stop(); closeRoutes('source-denied'); }
  return { runtime, driver, connections, start,
    /** The host calls tick from its owned animation loop, including while a press is held. */
    tick() {
      if (driver.state().stopped) closeRoutes('source-stopped');
      else {
        driver.tick();
        for (const connection of connections) connection.renew(scope.principalId);
      }
      runtime.flush();
    },
    mount(target: HTMLElement) {
      const dispose = mountGestureSource(target, driver);
      let disposed = false, removeClose = () => {};
      const unmount = () => { if (disposed) return; disposed = true; removeClose(); dispose(); };
      removeClose = connections[0]!.onClose(unmount);
      return unmount;
    },
    state() { return Object.freeze({ heldGestures: held.size, transitions: Object.freeze([...transitions]),
      wheels: Object.freeze([...wheels]), position, releases }); },
    stop() { driver.stop(); runtime.flush(); runtime.close(); },
  };
}

export function runGestureExample() {
  let time = 1000;
  const example = createGesturePipeline({ now: () => time });
  const surface = { width: 200, height: 100 };
  const contact = (id: string, phase: 'down' | 'move' | 'up' | 'cancel', x: number, y = 0.5) => {
    example.driver.contact({ id, phase, position: { x, y }, primary: id === 'one' }, surface);
    example.tick(); time += 20;
  };
  try {
    contact('one', 'down', 0.2); contact('one', 'up', 0.2);
    contact('one', 'down', 0.3); time += 500; example.tick(); time += 20; contact('one', 'up', 0.3);
    example.driver.wheel({ x: 0, y: 3, z: 0, mode: 'line', modifiers: { shift: false, control: false, alt: false, meta: false } });
    example.tick(); time += 20;
    contact('one', 'down', 0.3); contact('two', 'down', 0.7);
    contact('one', 'move', 0.35); example.driver.release(); example.tick(); time += 20;
    const beforeStop = example.state();
    example.connections[0]!.stop('source-disconnected'); const afterStop = example.state();
    return { kind: 'producer-fixtures-only', transitions: beforeStop.transitions, wheels: beforeStop.wheels,
      beforeStop, afterStop, stopped: example.driver.state().stopped };
  } finally { example.stop(); }
}
