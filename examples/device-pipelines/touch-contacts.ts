import { createDeviceRuntime, parseDeviceDescriptor, TouchContactSourceDriver, mountTouchContactSource, touchContactSourceDescriptor } from '@101/connect';
import type { Authorize, TouchContact } from '@101/connect';

/** A separately granted reliable contact route. Application ownership is keyed by contact ID. */
export function createTouchContactsPipeline(options: { now?: () => number; authorize?: Authorize } = {}) {
  const now = options.now ?? (() => performance.now()), device = touchContactSourceDescriptor('embedded-browser-events');
  const sinkDevice = parseDeviceDescriptor({ ...device, id: 'touch-contact-consumer',
    capabilities: device.capabilities.map(capability => ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
  const scope = { principalId: 'touch-contact-owner', applicationId: 'touch-contact-example', sessionId: 'touch-contact-session' };
  const contacts = new Map<string, TouchContact>(), events: TouchContact[] = [];
  let releases = 0, sequence = 0;
  const runtime = createDeviceRuntime({ now, clockDomain: 'touch-contact-clock', authorize(request) {
    if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
      request.source.registrationId !== source.id || request.sink.registrationId !== sink.id ||
      request.source.capabilityId !== 'contact' || request.sink.capabilityId !== 'contact' ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
    return options.authorize ? options.authorize(request) : { expiresAt: now() + 60000, maxHz: 1000, maxAgeMs: 1000 };
  } });
  const source = runtime.registerSource({ device, capability: 'contact' });
  const sink = runtime.registerSink({ device: sinkDevice, capability: 'contact', apply(observation, context) {
    if (!context.isCurrent() || context.signal.aborted) return;
    const value = observation.value as unknown as TouchContact;
    if (events.length >= 128) events.shift(); events.push(value);
    if (value.phase === 'down' || value.phase === 'move') contacts.set(value.id, value);
    else contacts.delete(value.id);
  }, release() { contacts.clear(); releases++; } });
  runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
  const connection = runtime.route({ from: source, to: sink, ...scope, queueCapacity: 64, leaseMs: 10000 });
  const start = connection.start();
  const driver = new TouchContactSourceDriver({ now, publish(_name, value, { capturedAt }) {
    const next = sequence + 1;
    const result = runtime.publish(source, value, { timestamp: capturedAt, clockDomain: runtime.clockDomain,
      operationId: String(next), deadline: capturedAt + 1000 });
    if (result.ok) sequence = next;
    const admitted = result.ok && result.value.accepted > 0 && result.value.rejected === 0;
    if (!admitted) connection.stop('source-rejected');
    return admitted;
  } });
  connection.onClose(() => driver.stop());
  if (!start.ok) { driver.stop(); connection.stop('source-denied'); }
  return { runtime, driver, connection, start,
    /** Continuing hosts call tick from an owned loop; authorization still expires after 60 seconds. */
    tick() {
      if (driver.state().stopped) connection.stop('source-stopped'); else connection.renew(scope.principalId);
      runtime.flush();
    },
    mount(target: HTMLElement) {
      const dispose = mountTouchContactSource(target, driver);
      let disposed = false, removeClose = () => {};
      const unmount = () => { if (disposed) return; disposed = true; removeClose(); dispose(); };
      removeClose = connection.onClose(unmount);
      return unmount;
    },
    state() { return Object.freeze({ contacts: Object.freeze([...contacts.values()]), events: Object.freeze([...events]), releases }); },
    stop() { driver.stop(); runtime.flush(); runtime.close(); },
  };
}

export function runTouchContactsExample() {
  let now = 1000;
  const example = createTouchContactsPipeline({ now: () => now });
  const contact = (id: string, phase: TouchContact['phase'], x: number, primary: boolean) => {
    example.driver.contact({ id, phase, position: { x, y: 0.5 }, primary }); example.tick(); now += 5;
  };
  try {
    contact('left', 'down', 0.25, true); contact('right', 'down', 0.75, false);
    const simultaneous = example.state();
    contact('left', 'up', 0.3, true); const oneReleased = example.state();
    example.driver.release(); example.tick(); now += 5; const cancelled = example.state();
    contact('left', 'down', 0.25, true); contact('right', 'down', 0.75, false);
    example.connection.stop('source-disconnected'); const disconnected = example.state();
    return { kind: 'producer-fixtures-only', simultaneous, oneReleased, cancelled, disconnected, stopped: example.driver.state().stopped };
  } finally { example.stop(); }
}
