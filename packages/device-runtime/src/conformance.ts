import { parseDeviceDescriptor, parseProcessorManifest, parseSignalValue, schemasCompatible, snapshotJson } from '@101/device-model';
import type { ProcessorManifest, ProcessorPort, SignalValue } from '@101/device-model';
import { EmbeddedRuntime } from './runtime.ts';
import { createProcessorRegistry } from './processor-registry.ts';
import type { ResolvedProcessor, TrustedProcessorRegistration } from './processor-registry.ts';
import type { Connection, DeliveryContext, Observation, PublishOptions, Readiness, SinkProvider } from './types.ts';
import type { Evidence, Result } from './scheduler.ts';

export interface ConformanceCheck {
  readonly id: string;
  readonly status: 'passed' | 'failed' | 'not-applicable';
}
export interface ConformanceReport {
  readonly schemaVersion: 1;
  readonly suite: 'connector' | 'processor';
  readonly scope: 'trusted-in-process';
  readonly outcome: 'passed' | 'failed';
  readonly checks: readonly ConformanceCheck[];
  readonly limits: Readonly<{ maxFixtureCases: number; maxCallbacks: number; maxResources: number; asyncTimeoutMs: number }>;
  readonly limitations: readonly string[];
}
export interface ConformanceEndpoint { readonly device: unknown; readonly capability: string }
export interface ConnectorConformanceHost {
  now(): number;
  publish(value: unknown, options?: PublishOptions): Result<{ accepted: number; rejected: number }>;
  setReadiness(endpoint: 'source' | 'sink', readiness: Readiness): Result;
  /** Instrument the adapter's local observable effect; values are never retained in reports. */
  recordEffect(value: unknown): void;
  /** Instrument each owned listener, stream or timer. Dispose its token when the real resource is released. */
  trackResource(): () => void;
}
export interface ConnectorConformanceAdapter extends Pick<SinkProvider, 'apply' | 'release'> {
  start(): void | Promise<void>;
  send(value: unknown, options?: PublishOptions): Result<{ accepted: number; rejected: number }>;
  stop(): void | Promise<void>;
  /** Inject fixture evidence from a simulated target into the previously delivered command context. */
  feedback?(evidence: Evidence): void;
}
export interface TrustedConnectorCandidate {
  readonly source: ConformanceEndpoint;
  readonly sink: ConformanceEndpoint;
  /** Explicit reviewed code. Descriptor fields and fixture data never select or load a factory. */
  readonly factory: (host: ConnectorConformanceHost) => ConnectorConformanceAdapter;
}
export interface ConnectorConformanceFixture {
  /** At least two distinct schema-valid values, already decoded into the declared source schema. */
  readonly values: readonly unknown[];
  readonly invalidValue: unknown;
}
export interface ProcessorConformanceFixture {
  readonly configuration: unknown;
  readonly invalidConfiguration: unknown;
  readonly invalidInputs: unknown;
  /** Omit outputs when the processor must emit no frame. Expectations are authored by the caller. */
  readonly cases: readonly Readonly<{ inputs: unknown; outputs?: unknown }>[];
}

const LIMITS = Object.freeze({ maxFixtureCases: 32, maxCallbacks: 256, maxResources: 128, asyncTimeoutMs: 1000 });
const LIMITATIONS = Object.freeze([
  'Local deterministic fixtures; no physical-device or plugin-isolation certification.',
  'Trusted synchronous code cannot be preempted; memory and uninstrumented resources are not measured.',
]);
function report(suite: ConformanceReport['suite'], checks: ConformanceCheck[]): ConformanceReport {
  return Object.freeze({ schemaVersion: 1, suite, scope: 'trusted-in-process',
    outcome: checks.some(check => check.status === 'failed') ? 'failed' : 'passed',
    checks: Object.freeze(checks.map(check => Object.freeze({ ...check }))), limits: LIMITS, limitations: LIMITATIONS });
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('conformance-object');
  return value as Record<string, unknown>;
}
/** Read an inert field without invoking a getter. */
function field(input: unknown, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object(input), name);
  if (!descriptor || !('value' in descriptor)) throw new TypeError('conformance-field');
  return descriptor.value;
}
function method(input: unknown, name: string): boolean {
  let current: object | null = object(input);
  for (let depth = 0; current && depth < 8; depth++, current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function';
  }
  return false;
}
function equal(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string => {
    const copied = snapshotJson(value);
    const sorted = (part: unknown): unknown => Array.isArray(part) ? part.map(sorted)
      : part && typeof part === 'object' ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : part;
    return JSON.stringify(sorted(copied));
  };
  return left === undefined || right === undefined ? left === right : canonical(left) === canonical(right);
}
function rejects(run: () => unknown): boolean { try { run(); return false; } catch { return true; } }
async function bounded<T>(value: T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve(value), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('conformance-timeout')), LIMITS.asyncTimeoutMs);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function check(checks: ConformanceCheck[], id: string, run: () => boolean | Promise<boolean>): Promise<boolean> {
  let passed = false;
  try { passed = await bounded(run()); } catch { /* Retain a fixed check code, never exception text or values. */ }
  checks.push({ id, status: passed ? 'passed' : 'failed' });
  return passed;
}
function endpoint(input: unknown) {
  const value = object(snapshotJson(input));
  if (Object.keys(value).sort().join('\0') !== 'capability\0device' || typeof value.capability !== 'string') throw new TypeError('conformance-endpoint');
  const device = parseDeviceDescriptor(value.device);
  const capability = device.capabilities.find(item => item.id === value.capability);
  if (!capability) throw new TypeError('conformance-capability');
  return { device, capability };
}

/** Run an explicitly supplied trusted connector against the public runtime, without a 101 application. */
export async function runConnectorConformance(candidate: TrustedConnectorCandidate, fixture: ConnectorConformanceFixture): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  let source: ReturnType<typeof endpoint>, sink: ReturnType<typeof endpoint>;
  let factory: TrustedConnectorCandidate['factory'];
  if (!await check(checks, 'manifest', () => {
    source = endpoint(field(candidate, 'source')); sink = endpoint(field(candidate, 'sink'));
    factory = field(candidate, 'factory') as TrustedConnectorCandidate['factory'];
    return typeof factory === 'function' && source.capability.permissions.includes('subscribe') &&
      source.capability.kind !== 'command' && source.capability.kind !== 'job' &&
      sink.capability.permissions.includes(sink.capability.kind === 'command' || sink.capability.kind === 'job' ? 'invoke' : 'write') &&
      (!(sink.capability.kind === 'command' || sink.capability.kind === 'job') || sink.capability.delivery.mode === 'reliable') &&
      source.capability.ownership?.mode !== 'partitioned' && sink.capability.ownership?.mode !== 'partitioned' &&
      source.capability.delivery.mode === sink.capability.delivery.mode && schemasCompatible(source.capability, sink.capability);
  })) return report('connector', checks);
  let values: SignalValue[] = [], invalidValue: unknown;
  if (!await check(checks, 'fixtures', () => {
    const copied = object(snapshotJson(fixture));
    if (Object.keys(copied).sort().join('\0') !== 'invalidValue\0values' || !Array.isArray(copied.values) ||
      copied.values.length < 2 || copied.values.length > LIMITS.maxFixtureCases) return false;
    values = copied.values.map(value => parseSignalValue(value, source!.capability.value));
    invalidValue = copied.invalidValue;
    return !equal(values[0], values[1]) && rejects(() => parseSignalValue(invalidValue, source!.capability.value));
  })) return report('connector', checks);
  let now = 0, granted = false, retired = false, resources = 0, callbacks = 0, releases = 0, releaseFailures = 0;
  let adapter: ConnectorConformanceAdapter | undefined, lastAdmission: unknown, context: DeliveryContext | undefined;
  const effects: SignalValue[] = [], pending = new Set<Promise<void>>();
  const touch = () => { if (retired || ++callbacks > LIMITS.maxCallbacks) throw new Error('conformance-callback-limit'); };
  const runtime = new EmbeddedRuntime({ now: () => now, clockDomain: 'conformance', maxRegistrations: 2,
    maxRoutes: 8, maxSubscribers: 1, maxPendingDeliveries: 2,
    authorize: () => granted ? { expiresAt: now + 30000, maxAgeMs: 500, maxHz: 20 } : undefined });
  const sourceHandle = runtime.registerSource({ device: source!.device, capability: source!.capability.id });
  let sinkHandle: ReturnType<typeof runtime.registerSink> | undefined;
  const host: ConnectorConformanceHost = Object.freeze({ now: () => now,
    publish(value: unknown, options?: PublishOptions) { touch(); lastAdmission = runtime.publish(sourceHandle, value, options); return lastAdmission as Result<{ accepted: number; rejected: number }>; },
    setReadiness(endpoint: 'source' | 'sink', readiness: Readiness) {
      touch(); const handle = endpoint === 'source' ? sourceHandle : endpoint === 'sink' ? sinkHandle : undefined;
      return handle ? runtime.setReadiness(handle, readiness) : { ok: false, reason: 'unknown-endpoint' } as const;
    },
    recordEffect(value: unknown) { touch(); if (effects.length >= LIMITS.maxCallbacks) throw new Error('conformance-effect-limit');
      effects.push(parseSignalValue(value, sink!.capability.value)); },
    trackResource() { touch(); if (++resources > LIMITS.maxResources) throw new Error('conformance-resource-limit');
      let live = true; return () => { if (live) { live = false; resources--; } }; },
  });
  let route: Connection | undefined, operation = 0;
  const reliable = source!.capability.delivery.mode === 'reliable';
  const send = (value: unknown) => {
    lastAdmission = undefined;
    const options = reliable ? { operationId: String(++operation), deadline: now + Math.min(500, source!.capability.delivery.maxAgeMs, sink!.capability.delivery.maxAgeMs) } : undefined;
    const result = adapter!.send(value, options);
    if (!equal(result, lastAdmission)) throw new Error('conformance-admission-result');
    return result;
  };
  const flush = async () => { runtime.flush(); await bounded(Promise.all([...pending])); };
  const connection = () => runtime.route({ from: sourceHandle, to: sinkHandle!, principalId: 'fixture-owner',
    applicationId: 'conformance', sessionId: 'fixture', queueCapacity: 2, leaseMs: 30000 });
  try {
    if (!await check(checks, 'start', async () => {
      adapter = factory!(host);
      if (!adapter || ['start', 'send', 'apply', 'release', 'stop'].some(name => !method(adapter, name))) return false;
      sinkHandle = runtime.registerSink({ device: sink!.device, capability: sink!.capability.id,
        apply(observation: Observation, delivery: DeliveryContext) {
          touch(); context = delivery;
          const result = adapter!.apply(observation, delivery);
          if (result && typeof result.then === 'function') {
            const task = Promise.resolve(result); pending.add(task);
            void task.then(() => pending.delete(task), () => pending.delete(task));
            return task;
          }
        },
        release(reason, delivery) {
          try {
            touch(); const returned: unknown = adapter!.release(reason, delivery);
            if (returned !== null && (typeof returned === 'object' || typeof returned === 'function') &&
              typeof (returned as { then?: unknown }).then === 'function') {
              releaseFailures++;
              // The runtime requires immediate release. Consume deferred failure without certifying its cleanup.
              void Promise.resolve(returned).catch(() => {});
            } else releases++;
          }
          catch { releaseFailures++; /* Runtime closure may swallow this failure; retain only its fixed verdict. */ }
        } });
      await bounded(adapter.start());
      return true;
    })) throw new Error('conformance-start');
    await check(checks, 'denied-grant', async () => {
      const denied = connection(); const result = denied.start(); send(values[0]); await flush(); denied.stop();
      return !result.ok && result.reason === 'denied' && effects.length === 0 && releases === 0;
    });
    granted = true; route = connection();
    await check(checks, 'delivery', async () => {
      if (!route!.start().ok) return false;
      const result = send(values[0]); await flush();
      return result.ok && result.value.accepted === 1 && result.value.rejected === 0 && effects.length === 1 && equal(effects[0], values[0]);
    });
    if (reliable) await check(checks, 'feedback', () => {
      if (typeof adapter!.feedback !== 'function') return false;
      const before = route!.operations()[0];
      if (before?.state !== 'unverified' || before.handlerResult !== 'returned' || before.effectEvidence !== 'dispatched') return false;
      adapter!.feedback('target-acknowledged');
      if (route!.operations()[0]?.effectEvidence !== 'target-acknowledged') return false;
      adapter!.feedback('observed'); adapter!.feedback('unverified');
      return route!.operations()[0]?.state === 'observed' && route!.operations()[0]?.effectEvidence === 'observed';
    });
    else checks.push({ id: 'feedback', status: 'not-applicable' });
    await check(checks, 'schema-rejection', async () => {
      const before = effects.length, result = send(invalidValue); await flush(); return !result.ok && effects.length === before;
    });
    await check(checks, 'fixture-vectors', async () => {
      const limits = route!.limits(); if (!limits) return false;
      const step = Math.ceil(1000 / limits.maxHz);
      for (const value of values.slice(1)) {
        now += step; const before = effects.length, result = send(value); await flush();
        if (!result.ok || result.value.accepted !== 1 || effects.length !== before + 1 || !equal(effects.at(-1), value)) return false;
      }
      return true;
    });
    await check(checks, 'delivery-limits', async () => {
      const limits = route!.limits(); if (!limits || limits.maxHz > 20 || limits.maxAgeMs > 500) return false;
      const step = Math.ceil(1000 / limits.maxHz), before = effects.length;
      if (reliable) {
        if (!send(values[1]).ok || !send(values[0]).ok || send(values[1]).ok || route!.status().pending !== 2) return false;
        await flush(); if (effects.length !== before) return false;
        now += step; await flush(); now += step; await flush();
        return effects.length === before + 2 && equal(effects[before], values[1]) && equal(effects[before + 1], values[0]);
      }
      for (const value of values) if (!send(value).ok) return false;
      await flush(); if (effects.length !== before || route!.status().pending !== 1) return false;
      now += step; await flush();
      return effects.length === before + 1 && equal(effects.at(-1), values.at(-1));
    });
    await check(checks, 'revoked-grant', async () => {
      const before = effects.length, released = releases, previous = context;
      send(values[0]); granted = false; runtime.revoke(route!); now += 50; await flush(); send(values[1]); await flush();
      return effects.length === before && releases === released + 1 && route!.status().pending === 0 &&
        route!.status().state === 'closed' && !!previous && !previous.isCurrent();
    });
    await check(checks, 'disconnect', async () => {
      granted = true; route = connection(); if (!route.start().ok) return false;
      const before = effects.length, released = releases;
      send(values[0]); runtime.setReadiness(sourceHandle, 'unavailable'); await flush(); const result = send(values[1]); await flush();
      return !result.ok && effects.length === before && releases === released + 1 && route.status().state === 'closed';
    });
    await check(checks, 'stop', async () => {
      // Recreate active work so the prior disconnect cannot supply stop's evidence.
      if (!runtime.setReadiness(sourceHandle, 'available').ok || !runtime.setReadiness(sinkHandle!, 'available').ok) return false;
      route = connection(); if (!route.start().ok) return false;
      const baseline = effects.length, delivered = send(values[0]); await flush();
      const previous = context, limits = route.limits();
      if (!delivered.ok || delivered.value.accepted !== 1 || effects.length !== baseline + 1 ||
        !equal(effects.at(-1), values[0]) || !previous?.isCurrent() || previous.routeId !== route.id || !limits) return false;
      const queued = send(values[1]);
      if (!queued.ok || queued.value.accepted !== 1 || route.status().pending !== 1) return false;
      const before = effects.length, released = releases;
      await bounded(adapter!.stop()); await bounded(adapter!.stop());
      const closed = route.status().state === 'closed' && route.status().pending === 0 && !previous.isCurrent() &&
        (!reliable || route.operations().at(-1)?.state === 'cancelled');
      const result = send(values[0]); await flush(); now += Math.ceil(1000 / limits.maxHz); await flush();
      return closed && !result.ok && effects.length === before && resources === 0 && releases === released + 1;
    });
  } catch { checks.push({ id: 'execution', status: 'failed' }); }
  finally {
    runtime.close();
    if (adapter) await check(checks, 'cleanup', async () => { await bounded(adapter!.stop()); return resources === 0; });
    checks.push({ id: 'release', status: releaseFailures ? 'failed' : releases ? 'passed' : 'not-applicable' });
    retired = true; effects.length = 0; pending.clear();
  }
  return report('connector', checks);
}

function frame(input: unknown, ports: readonly ProcessorPort[]): Readonly<Record<string, SignalValue>> {
  const value = object(snapshotJson(input));
  if (Object.keys(value).sort().join('\0') !== ports.map(port => port.id).sort().join('\0')) throw new TypeError('conformance-ports');
  return Object.freeze(Object.fromEntries(ports.map(port => [port.id, parseSignalValue(value[port.id], port.value)])));
}

/** Validate and execute only an explicit host-reviewed processor registration; never load code from a manifest. */
export async function runProcessorConformance(registration: TrustedProcessorRegistration, fixture: ProcessorConformanceFixture): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  let manifest: Readonly<ProcessorManifest>;
  if (!await check(checks, 'manifest', () => { manifest = parseProcessorManifest(field(registration, 'manifest')); return true; })) return report('processor', checks);
  let configuration: SignalValue, invalidConfiguration: unknown, invalidInputs: unknown;
  let cases: Array<{ inputs: Readonly<Record<string, SignalValue>>; outputs?: Readonly<Record<string, SignalValue>> }> = [];
  if (!await check(checks, 'fixtures', () => {
    const copied = object(snapshotJson(fixture));
    if (Object.keys(copied).sort().join('\0') !== 'cases\0configuration\0invalidConfiguration\0invalidInputs' ||
      !Array.isArray(copied.cases) || copied.cases.length < 1 || copied.cases.length > LIMITS.maxFixtureCases) return false;
    configuration = parseSignalValue(copied.configuration, manifest!.configuration);
    invalidConfiguration = copied.invalidConfiguration; invalidInputs = copied.invalidInputs;
    cases = copied.cases.map(input => {
      const value = object(input);
      if (!Object.hasOwn(value, 'inputs') || Object.keys(value).some(key => key !== 'inputs' && key !== 'outputs')) throw new TypeError('conformance-case');
      return { inputs: frame(value.inputs, manifest!.inputs), ...(Object.hasOwn(value, 'outputs') ? { outputs: frame(value.outputs, manifest!.outputs) } : {}) };
    });
    return rejects(() => parseSignalValue(invalidConfiguration, manifest!.configuration)) && rejects(() => frame(invalidInputs, manifest!.inputs));
  })) return report('processor', checks);
  const registry = createProcessorRegistry();
  if (!await check(checks, 'code-pin', async () => {
    const source = field(registration, 'source'), factory = field(registration, 'factory');
    if (!(source instanceof Uint8Array) || source.byteLength < 1 || source.byteLength > 1024 * 1024 || typeof factory !== 'function') return false;
    await registry.registerTrusted({ manifest: manifest!, source, factory: factory as TrustedProcessorRegistration['factory'] }); return true;
  })) return report('processor', checks);
  const request = () => ({ id: manifest!.id, version: manifest!.version, codeSha256: manifest!.codeSha256, configuration: configuration! });
  await check(checks, 'configuration-rejection', () => rejects(() => registry.resolve({ ...request(), configuration: invalidConfiguration })));
  await check(checks, 'untrusted-lookup', () => rejects(() => registry.resolve({ ...request(), codeSha256: manifest!.codeSha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) })));
  let processor: ResolvedProcessor | undefined, callbacks = 0;
  const replay = (target: ResolvedProcessor) => {
    let passed = true;
    for (const item of cases) {
      if (++callbacks > LIMITS.maxCallbacks) throw new Error('conformance-callback-limit');
      const started = performance.now(), result = target.process(item.inputs);
      if (performance.now() - started > manifest!.budgets.maxComputeMs || !equal(result, item.outputs)) passed = false;
    }
    return passed;
  };
  try {
    if (!await check(checks, 'resolve', () => { processor = registry.resolve(request()); return true; })) return report('processor', checks);
    await check(checks, 'input-rejection', () => rejects(() => processor!.process(invalidInputs)));
    await check(checks, 'output-vectors', () => replay(processor!));
    await check(checks, 'deterministic-replay', () => {
      const independent = registry.resolve(request());
      try { return replay(independent); } finally { independent.reset(); }
    });
    if (manifest!.state.mode === 'resettable') {
      for (const cause of manifest!.state.resetOn) await check(checks, `reset-${cause}`, () => { processor!.reset(); return replay(processor!); });
    } else await check(checks, 'stateless-replay', () => replay(processor!));
  } finally {
    if (processor) await check(checks, 'cleanup', () => { processor!.reset(); return true; });
    cases.length = 0;
  }
  return report('processor', checks);
}
