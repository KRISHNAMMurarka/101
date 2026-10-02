import { createDeviceRuntime, DeviceValidationError, parseDeviceDescriptor, parseSignalValue } from '@101/connect';
import type { Authorize, DeviceDescriptor, SignalValue, ValueSchema } from '@101/connect';

const SCHEMAS = {
  contacts: { type: 'contact', frame: 'surface-normalized' },
  pen: { type: 'pen', frame: 'surface-normalized' },
  keys: { type: 'key' },
  text: { type: 'text', maxLength: 2048 },
  wheel: { type: 'wheel', maxDelta: 10000 },
  relativeMotion: { type: 'relative-motion', frame: 'viewport-css-pixel', maxDelta: 10000 },
} as const satisfies Record<string, ValueSchema>;
export type RichInputCapability = keyof typeof SCHEMAS;
const NAMES = Object.freeze(Object.keys(SCHEMAS) as RichInputCapability[]);

function descriptor(sink: boolean): Readonly<DeviceDescriptor> {
  return parseDeviceDescriptor({ schemaVersion: 1, id: sink ? 'rich-input-consumer' : 'rich-input-source',
    label: sink ? 'Simulated input event consumer' : 'Simulated DOM-shaped input events', revision: 1,
    adapter: { id: 'example:rich-input', version: '1' }, runtime: { platform: 'embedded-application' },
    capabilities: NAMES.map((name) => ({ id: name, semantic: `example:rich-input-${name}`, schemaVersion: 2,
      kind: 'event', value: SCHEMAS[name], delivery: { mode: 'reliable', maxAgeMs: 1000 },
      permissions: sink ? ['write'] : ['subscribe'], ...(sink ? { ownership: { mode: 'observe' } } : {}) })) });
}

export interface RichInputLogEntry {
  readonly capability: RichInputCapability;
  readonly value: SignalValue;
  readonly sequence: number;
}

/** Six separately authorized reliable event routes; all fixtures are simulated. */
export function createRichInputPipeline(options: { now?: () => number; authorize?: Authorize } = {}) {
  const now = options.now ?? (() => 0), sourceDevice = descriptor(false), sinkDevice = descriptor(true);
  const scope = { principalId: 'rich-input-owner', applicationId: 'rich-input-example', sessionId: 'embedded-rich-input' };
  let log: readonly RichInputLogEntry[] = Object.freeze([]), releases = 0, overflow = 0, stopped = false;
  const operationSequence = new Map<RichInputCapability, number>(NAMES.map((name) => [name, 0]));
  const sourceHandles = new Map<RichInputCapability, ReturnType<ReturnType<typeof createDeviceRuntime>['registerSource']>>();
  const sinkHandles = new Map<RichInputCapability, ReturnType<ReturnType<typeof createDeviceRuntime>['registerSink']>>();
  const runtime = createDeviceRuntime({ now, clockDomain: 'embedded-rich-input-clock', authorize(request) {
    const name = request.source.capabilityId as RichInputCapability;
    if (!NAMES.includes(name) || request.principalId !== scope.principalId || request.applicationId !== scope.applicationId ||
      request.sessionId !== scope.sessionId || request.source.registrationId !== sourceHandles.get(name)?.id ||
      request.sink.registrationId !== sinkHandles.get(name)?.id || request.sink.capabilityId !== name ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
    return options.authorize ? options.authorize(request) : { expiresAt: now() + 60000, maxAgeMs: 1000, maxHz: 1000 };
  } });
  for (const name of NAMES) {
    sourceHandles.set(name, runtime.registerSource({ device: sourceDevice, capability: name }));
    sinkHandles.set(name, runtime.registerSink({ device: sinkDevice, capability: name,
      apply(observation, context) {
        if (!context.isCurrent() || context.signal.aborted) return;
        if (log.length >= 128) { overflow++; return; }
        log = Object.freeze([...log, Object.freeze({ capability: name, value: observation.value, sequence: observation.sequence })]);
      },
      release() { log = Object.freeze([]); releases++; },
    }));
  }
  for (const handle of [...sourceHandles.values(), ...sinkHandles.values()]) runtime.setReadiness(handle, 'available');
  const connections = Object.fromEntries(NAMES.map((name) => [name, runtime.route({ from: sourceHandles.get(name)!, to: sinkHandles.get(name)!,
    ...scope, leaseMs: 10000 })])) as
    Record<RichInputCapability, ReturnType<typeof runtime.route>>;
  const start = NAMES.map((name) => connections[name].start());
  return { runtime, sourceDevice, sinkDevice, connections, start,
    renew() { return Object.freeze(Object.fromEntries(NAMES.map((name) => [name, connections[name].renew(scope.principalId)]))); },
    publish(name: RichInputCapability, input: unknown) {
      if (stopped || !NAMES.includes(name)) throw new DeviceValidationError('input-route-stopped');
      const value = parseSignalValue(input, SCHEMAS[name]);
      const timestamp = now(), operationId = String((operationSequence.get(name) ?? 0) + 1);
      const result = runtime.publish(sourceHandles.get(name)!, value, { timestamp, clockDomain: runtime.clockDomain,
        operationId, deadline: timestamp + 1000 });
      if (result.ok) operationSequence.set(name, Number(operationId));
      return result;
    },
    stop() { if (stopped) return; stopped = true; for (const name of NAMES) connections[name].stop(); },
    state() { return Object.freeze({ log, releases, overflow }); },
  };
}

/** Deterministic event sequence shaped like DOM data; no physical input is claimed. */
export function runRichInputExample() {
  let now = 1000;
  const pipeline = createRichInputPipeline({ now: () => now });
  const modifiers = { shift: false, control: false, alt: false, meta: false };
  const key = { code: 'KeyA', key: 'a', phase: 'down', repeat: false, location: 0, composing: false, modifiers };
  const contact = { id: 'pointer:1', phase: 'down', position: { x: 0.2, y: 0.8 }, primary: true };
  const pen = { id: 'pointer:2', phase: 'down', position: { x: 0.4, y: 0.6 }, primary: true,
    pressure: 0.5, tiltX: -20, tiltY: 30, twist: 120 };
  const events: readonly [RichInputCapability, unknown][] = [
    ['contacts', contact], ['contacts', { ...contact, phase: 'up' }],
    ['pen', pen], ['pen', { ...pen, phase: 'up', pressure: 0 }],
    ['keys', key], ['keys', { ...key, phase: 'up' }],
    ['text', { compositionId: 'ime:1', phase: 'end', text: 'न' }],
    ['text', { compositionId: 'ime:1', phase: 'commit', text: 'न' }],
    ['wheel', { x: 0, y: -120, z: 0, mode: 'pixel', modifiers }],
    ['wheel', { x: 0, y: -80, z: 0, mode: 'pixel', modifiers }],
    ['relativeMotion', { x: 4, y: -2, unit: 'css-px', locked: true }],
    ['relativeMotion', { x: 3, y: 1, unit: 'css-px', locked: true }],
  ];
  try {
    for (const [name, value] of events) { now += 2; pipeline.publish(name, value); pipeline.runtime.flush(); }
    const state = pipeline.state();
    return { kind: 'embedded-simulated-input', events: state.log.length, overflow: state.overflow,
      phases: state.log.map((entry) => (entry.value as { phase?: string }).phase),
      wheelDeltas: state.log.filter((entry) => entry.capability === 'wheel').map((entry) => (entry.value as { y: number }).y),
    };
  } finally { pipeline.runtime.close(); }
}
