import { DeviceValidationError, snapshotJson } from '@101/device-model';
import type { JsonValue, SignalValue } from '@101/device-model';
import { EmbeddedRuntime } from './runtime.ts';
import type { Connection, EndpointHandle } from './types.ts';
import type { Result } from './scheduler.ts';

export type SimulatorEvent = Readonly<{ at: number; kind: 'delivery'; sinkId: string; value: SignalValue }> |
  Readonly<{ at: number; kind: 'release'; sinkId: string; reason: string }>;
export interface DeviceSimulator {
  replay(steps: unknown): readonly Result<unknown>[];
  events(): readonly SimulatorEvent[];
  close(): void;
}
interface RouteSpec {
  id: string; from: string; to: string;
  principalId: string; applicationId: string; sessionId: string;
}
type Step = Readonly<{ at: number; kind: 'grant' | 'revoke' | 'connect'; routeId: string }> |
  Readonly<{ at: number; kind: 'disconnect' | 'reconnect'; endpointId: string }> |
  Readonly<{ at: number; kind: 'loss'; sourceId: string }> |
  Readonly<{ at: number; kind: 'sample'; sourceId: string; value: JsonValue }> |
  Readonly<{ at: number; kind: 'flush' }>;

function fail(path: string): never { throw new DeviceValidationError('simulator-invalid', path); }
function object(input: unknown, path: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(path);
  return input as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, fields: readonly string[], path: string): void {
  if (Object.keys(input).sort().join('\0') !== [...fields].sort().join('\0')) fail(path);
}
function id(input: unknown, path: string): string {
  if (typeof input !== 'string' || !input.length || input.length > 128 || input.trim() !== input ||
      Array.from(input).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail(path);
  return input as string;
}
function list(input: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(input) || input.length < min || input.length > max) fail(path);
  return input;
}
function parseSteps(input: unknown, currentTime: number): Step[] {
  const steps = list(snapshotJson(input), '$.steps', 0, 256);
  let previous = currentTime;
  return steps.map((input, index) => {
    const path = `$.steps[${index}]`, value = object(input, path);
    const at = value.at;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < previous || at > 1_000_000_000) fail(`${path}.at`);
    previous = at;
    switch (value.kind) {
      case 'grant': case 'revoke': case 'connect':
        exact(value, ['at', 'kind', 'routeId'], path);
        return { at, kind: value.kind, routeId: id(value.routeId, `${path}.routeId`) };
      case 'disconnect': case 'reconnect':
        exact(value, ['at', 'kind', 'endpointId'], path);
        return { at, kind: value.kind, endpointId: id(value.endpointId, `${path}.endpointId`) };
      case 'sample':
        exact(value, ['at', 'kind', 'sourceId', 'value'], path);
        return { at, kind: 'sample', sourceId: id(value.sourceId, `${path}.sourceId`), value: value.value as JsonValue };
      case 'loss':
        exact(value, ['at', 'kind', 'sourceId'], path);
        return { at, kind: 'loss', sourceId: id(value.sourceId, `${path}.sourceId`) };
      case 'flush':
        exact(value, ['at', 'kind'], path);
        return { at, kind: 'flush' };
      default: fail(`${path}.kind`);
    }
  });
}

/** Deterministic in-process replay over the actual typed/authorized embedded runtime. */
export function createDeviceSimulator(input: unknown): DeviceSimulator {
  const options = object(snapshotJson(input), '$');
  exact(options, ['sources', 'sinks', 'routes'], '$');
  const sourceInputs = list(options.sources, '$.sources', 1, 32);
  const sinkInputs = list(options.sinks, '$.sinks', 1, 32);
  const routeInputs = list(options.routes, '$.routes', 1, 32);
  let now = 0, closed = false;
  const sources = new Map<string, EndpointHandle>(), sinks = new Map<string, EndpointHandle>();
  const events: SimulatorEvent[] = [];
  const addEvent = (event: SimulatorEvent) => { if (events.length === 256) events.shift(); events.push(Object.freeze(event)); };
  const specs = new Map<string, RouteSpec>();
  const grants = new Set<string>();
  const active = new Map<string, Connection>();
  const runtime = new EmbeddedRuntime({ now: () => now, clockDomain: 'simulator', authorize(request) {
    for (const spec of specs.values()) {
      if (!grants.has(spec.id) || request.principalId !== spec.principalId ||
          request.applicationId !== spec.applicationId || request.sessionId !== spec.sessionId ||
          request.source.registrationId !== sources.get(spec.from)?.id ||
          request.sink.registrationId !== sinks.get(spec.to)?.id) continue;
      return { expiresAt: now + 1000, maxAgeMs: 1000, maxHz: 1000 };
    }
    return undefined;
  } });
  for (const [index, item] of sourceInputs.entries()) {
    const path = `$.sources[${index}]`, value = object(item, path);
    exact(value, ['id', 'device', 'capability'], path);
    const name = id(value.id, `${path}.id`);
    if (sources.has(name) || sinks.has(name)) fail(`${path}.id`);
    const capability = id(value.capability, `${path}.capability`);
    const handle = runtime.registerSource({ device: value.device, capability });
    sources.set(name, handle); runtime.setReadiness(handle, 'available');
  }
  for (const [index, item] of sinkInputs.entries()) {
    const path = `$.sinks[${index}]`, value = object(item, path);
    exact(value, ['id', 'device', 'capability'], path);
    const name = id(value.id, `${path}.id`);
    if (sources.has(name) || sinks.has(name)) fail(`${path}.id`);
    const capability = id(value.capability, `${path}.capability`);
    const handle = runtime.registerSink({ device: value.device, capability,
      apply(observation) { addEvent({ at: now, kind: 'delivery', sinkId: name, value: observation.value }); },
      release(reason) { addEvent({ at: now, kind: 'release', sinkId: name, reason }); } });
    sinks.set(name, handle); runtime.setReadiness(handle, 'available');
  }
  const scopes = new Set<string>();
  for (const [index, item] of routeInputs.entries()) {
    const path = `$.routes[${index}]`, value = object(item, path);
    exact(value, ['id', 'from', 'to', 'principalId', 'applicationId', 'sessionId'], path);
    const spec: RouteSpec = { id: id(value.id, `${path}.id`), from: id(value.from, `${path}.from`),
      to: id(value.to, `${path}.to`), principalId: id(value.principalId, `${path}.principalId`),
      applicationId: id(value.applicationId, `${path}.applicationId`), sessionId: id(value.sessionId, `${path}.sessionId`) };
    const scope = [spec.from, spec.to, spec.principalId, spec.applicationId, spec.sessionId].join('\0');
    if (specs.has(spec.id) || scopes.has(scope) || !sources.has(spec.from) || !sinks.has(spec.to)) fail(path);
    scopes.add(scope); specs.set(spec.id, spec);
  }
  return Object.freeze({
    replay(input: unknown): readonly Result<unknown>[] {
      if (closed) return Object.freeze([{ ok: false, reason: 'closed' }]);
      const steps = parseSteps(input, now);
      const results: Result<unknown>[] = [];
      for (const step of steps) {
        now = step.at;
        if (step.kind === 'flush') { runtime.flush(); results.push({ ok: true, value: undefined }); continue; }
        if (step.kind === 'sample') {
          const handle = sources.get(step.sourceId);
          results.push(handle ? runtime.publish(handle, step.value) : { ok: false, reason: 'unknown-source' });
          continue;
        }
        if (step.kind === 'loss') {
          const handle = sources.get(step.sourceId);
          if (!handle) { results.push({ ok: false, reason: 'unknown-source' }); continue; }
          for (const spec of specs.values()) if (spec.from === step.sourceId) grants.delete(spec.id);
          results.push(runtime.setReadiness(handle, 'stale'));
          continue;
        }
        if (step.kind === 'disconnect' || step.kind === 'reconnect') {
          const handle = sources.get(step.endpointId) ?? sinks.get(step.endpointId);
          if (!handle) { results.push({ ok: false, reason: 'unknown-endpoint' }); continue; }
          if (step.kind === 'disconnect') for (const spec of specs.values()) if (spec.from === step.endpointId || spec.to === step.endpointId)
            grants.delete(spec.id);
          results.push(runtime.setReadiness(handle, step.kind === 'disconnect' ? 'unavailable' : 'available'));
          continue;
        }
        const spec = specs.get('routeId' in step ? step.routeId : '');
        if (!spec) { results.push({ ok: false, reason: 'unknown-route' }); continue; }
        if (step.kind === 'grant') { grants.add(spec.id); results.push({ ok: true, value: undefined }); continue; }
        if (step.kind === 'revoke') {
          grants.delete(spec.id);
          const connection = active.get(spec.id);
          if (connection) { runtime.revoke(connection); active.delete(spec.id); }
          results.push({ ok: true, value: undefined }); continue;
        }
        const previous = active.get(spec.id);
        if (previous?.status().state === 'active') { results.push({ ok: false, reason: 'already-active' }); continue; }
        const connection = runtime.route({ from: sources.get(spec.from)!, to: sinks.get(spec.to)!,
          principalId: spec.principalId, applicationId: spec.applicationId, sessionId: spec.sessionId });
        const result = connection.start();
        if (result.ok) active.set(spec.id, connection);
        else connection.stop('start-failed');
        results.push(result);
      }
      return Object.freeze(results);
    },
    events(): readonly SimulatorEvent[] { return Object.freeze([...events]); },
    close(): void { if (closed) return; closed = true; runtime.close(); grants.clear(); active.clear(); },
  });
}
