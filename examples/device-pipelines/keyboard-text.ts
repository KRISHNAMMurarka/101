import { createDeviceRuntime, KeyboardTextSourceDriver, keyboardTextSourceDescriptor, mountKeyboardTextSource, parseDeviceDescriptor } from '@101/connect';
import type { Authorize, KeyTransition, TextComposition } from '@101/connect';

/** Two separately granted reliable event routes into an application. No OS input injection. */
export function createKeyboardTextPipeline(options: { now?: () => number; authorize?: Authorize } = {}) {
  const now = options.now ?? (() => performance.now()), device = keyboardTextSourceDescriptor('embedded-browser-events');
  const sinkDevice = parseDeviceDescriptor({ ...device, id: 'keyboard-text-consumer',
    capabilities: device.capabilities.map(capability => ({ ...capability, permissions: ['write'], ownership: { mode: 'observe' } })) });
  const scope = { principalId: 'keyboard-text-owner', applicationId: 'keyboard-text-example', sessionId: 'keyboard-text-session' };
  const sources = new Map<string, ReturnType<ReturnType<typeof createDeviceRuntime>['registerSource']>>();
  const sinks = new Map<string, ReturnType<ReturnType<typeof createDeviceRuntime>['registerSink']>>();
  const held = new Set<string>();
  let text = '', composition = '', releases = 0;
  const events: (KeyTransition | TextComposition)[] = [];
  const sequences = new Map<string, number>();
  const runtime = createDeviceRuntime({ now, clockDomain: 'keyboard-text-clock', authorize(request) {
    const name = request.source.capabilityId;
    if (request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
      request.source.registrationId !== sources.get(name)?.id || request.sink.registrationId !== sinks.get(name)?.id ||
      request.sink.capabilityId !== name || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
    return options.authorize ? options.authorize(request) : { expiresAt: now() + 60000, maxHz: 1000, maxAgeMs: 1000 };
  } });
  for (const capability of device.capabilities) {
    const name = capability.id;
    sources.set(name, runtime.registerSource({ device, capability: name }));
    sinks.set(name, runtime.registerSink({ device: sinkDevice, capability: name,
      apply(observation, context) {
        if (!context.isCurrent() || context.signal.aborted) return;
        const value = observation.value as unknown as KeyTransition | TextComposition;
        if (events.length >= 128) events.shift();
        events.push(value);
        if ('code' in value) {
          const id = `${value.location}:${value.code}`;
          if (value.phase === 'down') held.add(id); else held.delete(id);
        } else if (value.phase === 'commit') {
          if (Array.from(text + value.text).length > 8192) { closeRoutes('consumer-text-limit'); return; }
          text += value.text;
        } else composition = value.phase === 'end' ? '' : value.text;
      },
      release() { held.clear(); composition = ''; releases++; },
    }));
  }
  for (const handle of [...sources.values(), ...sinks.values()]) runtime.setReadiness(handle, 'available');
  const connections = [...sources].map(([name, source]) => runtime.route({ from: source, to: sinks.get(name)!, ...scope, queueCapacity: 64, leaseMs: 10000 }));
  function closeRoutes(reason: string) { for (const connection of connections) connection.stop(reason); }
  const start = connections.map(connection => connection.start());
  const driver = new KeyboardTextSourceDriver({ now, publish(name, value, { capturedAt }) {
    const sequence = (sequences.get(name) ?? 0) + 1;
    const result = runtime.publish(sources.get(name)!, value, { timestamp: capturedAt, clockDomain: runtime.clockDomain,
      operationId: String(sequence), deadline: capturedAt + 1000 });
    if (result.ok) sequences.set(name, sequence);
    const admitted = result.ok && result.value.accepted > 0 && result.value.rejected === 0;
    if (!admitted) closeRoutes('source-rejected');
    return admitted;
  } });
  for (const connection of connections) connection.onClose(() => driver.stop());
  if (start.some(result => !result.ok)) { driver.stop(); closeRoutes('source-denied'); }
  return { runtime, driver, connections, start,
    /** Continuing hosts call tick from an owned loop; grants still expire after 60 seconds. */
    tick() {
      if (driver.state().stopped) closeRoutes('source-stopped');
      else for (const connection of connections) connection.renew(scope.principalId);
      runtime.flush();
    },
    mount(target: HTMLElement) { return mountKeyboardTextSource(target, driver); },
    state() { return Object.freeze({ text, composition, heldKeys: held.size, releases, events: Object.freeze([...events]) }); },
    stop() { driver.stop(); runtime.flush(); runtime.close(); },
  };
}

export function runKeyboardTextExample() {
  let now = 1000;
  const example = createKeyboardTextPipeline({ now: () => now });
  const key: KeyTransition = { code: 'KeyY', key: 'z', phase: 'down', repeat: false, location: 0, composing: false,
    modifiers: { shift: false, control: false, alt: false, meta: false } };
  const flush = () => { example.runtime.flush(); now += 5; };
  try {
    example.driver.key(key); flush(); example.driver.key({ ...key, repeat: true }); flush();
    example.driver.input('insertText', 'z', false); flush();
    example.driver.composition('start', ''); flush(); example.driver.composition('update', 'न'); flush();
    example.driver.input('insertCompositionText', 'न', true); flush();
    example.driver.composition('end', 'न'); flush();
    const beforeCommit = example.state().text;
    example.driver.input('insertFromComposition', 'न', false); flush();
    example.driver.composition('start', ''); flush(); example.driver.composition('update', '未'); flush();
    example.driver.release(); flush();
    const released = example.state();
    example.driver.key(key); flush(); example.connections[0]!.stop('source-disconnected');
    const disconnected = example.state();
    return { kind: 'producer-fixtures-only', beforeCommit, released, disconnected, stopped: example.driver.state().stopped };
  } finally { example.stop(); }
}
