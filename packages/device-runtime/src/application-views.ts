import { parseDeviceDescriptor, parseValueSchema, snapshotJson } from '@101/device-model';
import type { JsonValue, ValueSchema } from '@101/device-model';
import { EmbeddedRuntime } from './runtime.ts';
import type { Connection, DeliveryContext, EndpointHandle, Observation, ResourceReference, RouteGrant } from './types.ts';

export interface ApplicationViewRequest {
  readonly applicationId: string; readonly sessionId: string; readonly principalId: string;
  readonly viewId: string; readonly outputId: string;
  readonly source: ResourceReference; readonly sink: ResourceReference;
  readonly sourceOperation: 'subscribe'; readonly sinkOperation: 'write';
}
export interface ApplicationViewDefinition {
  readonly id: string; readonly value: ValueSchema;
  /** Trusted application projection. A display never receives the private simulation snapshot. */
  project(state: JsonValue): unknown;
}
export interface ApplicationViewOutput {
  readonly viewId: string; readonly outputId: string; readonly principalId: string;
  /** Gate each asynchronous render with the supplied context before changing the display. */
  apply(observation: Observation, context: DeliveryContext): void | Promise<void>;
  release(reason: string): void;
}
export interface ApplicationViewHandle {
  status(): ReturnType<Connection['status']>;
  renew(): boolean;
  stop(): void;
}
export type AttachApplicationViewResult = Readonly<{ ok: true; value: ApplicationViewHandle }> |
  Readonly<{ ok: false; reason: 'invalid-output' | 'unavailable' | 'capacity' | 'denied' }>;
export interface ApplicationViewsOptions {
  readonly applicationId: string; readonly sessionId: string; readonly clockDomain: string;
  readonly now: () => number;
  readonly engine: {
    /** Exactly one synchronous turn per tick, independent of display count. */
    step(turn: Readonly<{ frame: number; at: number; elapsedMs: number; signal: AbortSignal }>): unknown;
    stop(): void;
  };
  readonly views: readonly ApplicationViewDefinition[];
  /** Trusted host checks source-owner AND selected output-owner consent. No default grants. */
  readonly authorize: (request: Readonly<ApplicationViewRequest>) => RouteGrant | undefined;
}
export interface ApplicationViews {
  attach(output: ApplicationViewOutput): AttachApplicationViewResult;
  /** Revoke every currently attached output for this principal. Later attachment needs fresh consent. */
  revoke(principalId: string): number;
  /** Caller schedules this; the controller owns no timer or independent engine per display. */
  tick(): boolean;
  status(): Readonly<{ state: 'active' | 'stopped'; outputs: number; frame: number; reason?: string }>;
  stop(): void;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VIEW_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
interface View { id: string; value: ValueSchema; source: EndpointHandle; project: ApplicationViewDefinition['project']; available: boolean }
interface Output { id: string; principalId: string; view: View; sink: EndpointHandle; route: Connection; detach?: () => void }
const no = (reason: Extract<AttachApplicationViewResult, { ok: false }>['reason']): AttachApplicationViewResult => Object.freeze({ ok: false, reason });
const valid = (value: unknown, expression: RegExp): value is string => typeof value === 'string' && expression.test(value);

/** Selected local typed-frame profile. Projection code and render adapters belong to the trusted host. */
export function createApplicationViews(options: ApplicationViewsOptions): ApplicationViews {
  if (!options || !valid(options.applicationId, ID) || !valid(options.sessionId, ID) || !valid(options.clockDomain, ID) ||
      typeof options.now !== 'function' || typeof options.authorize !== 'function' || typeof options.engine?.step !== 'function' ||
      typeof options.engine?.stop !== 'function' || !Array.isArray(options.views) || options.views.length < 1 || options.views.length > 16)
    throw new TypeError('A bounded application, clock, engine, views and host authorizer are required');
  const { applicationId, sessionId, clockDomain, now: readClock, authorize } = options;
  const step = options.engine.step.bind(options.engine), stopEngine = options.engine.stop.bind(options.engine);
  const definitions = options.views.map(view => {
    if (!view || !valid(view.id, VIEW_ID) || typeof view.project !== 'function') throw new TypeError('Invalid application view');
    return { id: view.id, value: parseValueSchema(view.value), project: view.project.bind(view) };
  });
  if (new Set(definitions.map(view => view.id)).size !== definitions.length) throw new TypeError('Duplicate application view');
  const engineSignal = new AbortController(), views = new Map<string, View>(), outputs = new Map<string, Output>();
  let closed = false, reason: string | undefined, busy = false, frame = 0, lastAt: number | undefined, lastStepAt: number | undefined;
  function retire(why: string): void {
    if (closed) return;
    closed = true; reason = why; engineSignal.abort();
    for (const output of [...outputs.values()]) remove(output, why);
    runtime?.close();
    try { stopEngine(); } catch { /* All routes have already lost authority. */ }
  }
  function now(): number {
    let value: number;
    try { value = readClock(); } catch { retire('clock-unavailable'); return NaN; }
    if (!Number.isFinite(value) || value < 0 || lastAt !== undefined && value < lastAt) { retire('clock-unavailable'); return NaN; }
    lastAt = value;
    return value;
  }
  function remove(output: Output, why: string): void {
    if (outputs.get(output.id) !== output) return;
    outputs.delete(output.id); output.detach?.();
    output.route.stop(why); runtime.unregister(output.sink);
  }
  function grant(value: unknown, at: number): RouteGrant | undefined {
    if (!value || typeof value !== 'object') return;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some(key => !['expiresAt', 'maxHz', 'maxAgeMs'].includes(String(key)))) return;
    const fields = ['expiresAt', 'maxHz', 'maxAgeMs'].map(key => Object.getOwnPropertyDescriptor(value, key));
    if (fields.some(field => !field || !Object.hasOwn(field, 'value'))) return;
    const [expiresAt, maxHz, maxAgeMs] = fields.map(field => field!.value as unknown);
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= at || expiresAt > at + 60000 ||
        typeof maxHz !== 'number' || !Number.isFinite(maxHz) || maxHz <= 0 || maxHz > 120 ||
        typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 1000) return;
    return Object.freeze({ expiresAt, maxHz, maxAgeMs });
  }
  const runtime = new EmbeddedRuntime({ now, clockDomain, maxRoutes: 16, maxSubscribers: 16, maxRegistrations: 32, maxPendingDeliveries: 32,
    authorize(request) {
      const output = [...outputs.values()].find(candidate => candidate.sink.id === request.sink.registrationId);
      if (closed || !output || !output.view.available || request.applicationId !== applicationId || request.sessionId !== sessionId ||
          request.principalId !== output.principalId || request.source.registrationId !== output.view.source.id ||
          request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write') return;
      const at = now(); if (closed) return;
      let allowed: RouteGrant | undefined;
      try { allowed = grant(authorize(Object.freeze({ applicationId, sessionId, principalId: output.principalId,
        source: Object.freeze({ ...request.source }), sink: Object.freeze({ ...request.sink }), sourceOperation: 'subscribe', sinkOperation: 'write',
        viewId: output.view.id, outputId: output.id })), at); }
      catch { return; }
      if (closed || outputs.get(output.id) !== output || !output.view.available) return;
      return allowed;
    } });
  function device(id: string, view: { id: string; value: ValueSchema }, sink = false) {
    return parseDeviceDescriptor({ schemaVersion: 1, id, label: sink ? 'Application display' : 'Application view', revision: 1,
      adapter: { id: 'connect:application-views', version: '1.0.0' }, runtime: { platform: 'embedded' }, capabilities: [{
        id: view.id, semantic: 'connect:application-view', schemaVersion: 1, kind: 'sample', value: view.value,
        delivery: { mode: 'latest', maxHz: 120, maxAgeMs: 1000 }, permissions: [sink ? 'write' : 'subscribe'],
        ...(sink ? { ownership: { mode: 'exclusive' } } : {}),
      }] });
  }
  for (const definition of definitions) {
    const source = runtime.registerSource({ device: device(`view-${definition.id}`, definition), capability: definition.id });
    runtime.setReadiness(source, 'available'); views.set(definition.id, { ...definition, source, available: true });
  }
  return Object.freeze({
    attach(output: ApplicationViewOutput): AttachApplicationViewResult {
      if (closed) return no('unavailable');
      if (!output || !valid(output.viewId, VIEW_ID) || !valid(output.outputId, VIEW_ID) || !valid(output.principalId, ID) ||
          typeof output.apply !== 'function' || typeof output.release !== 'function') return no('invalid-output');
      const view = views.get(output.viewId);
      if (!view?.available) return no('unavailable');
      if (outputs.has(output.outputId) || outputs.size >= 16) return no('capacity');
      const apply = output.apply.bind(output), release = output.release.bind(output);
      const sink = runtime.registerSink({ device: device(`display-${output.outputId}`, view, true), capability: view.id, apply, release });
      runtime.setReadiness(sink, 'available');
      const route = runtime.route({ from: view.source, to: sink, principalId: output.principalId, applicationId, sessionId, queueCapacity: 1, leaseMs: 30000 });
      const owned: Output = { id: output.outputId, principalId: output.principalId, view, sink, route };
      outputs.set(owned.id, owned);
      const started = route.start();
      if (!started.ok || closed || outputs.get(owned.id) !== owned || route.status().state !== 'active') { remove(owned, 'access-denied'); return no('denied'); }
      owned.detach = route.onClose(() => remove(owned, 'display-unavailable'));
      return Object.freeze({ ok: true, value: Object.freeze({ status: () => route.status(),
        renew() { if (closed || outputs.get(owned.id) !== owned) return false; const renewed = route.renew(owned.principalId); if (!renewed.ok) remove(owned, 'access-denied'); return renewed.ok; },
        stop: () => remove(owned, 'display-stopped') }) });
    },
    revoke(principalId: string): number {
      if (!valid(principalId, ID) || closed) return 0;
      const owned = [...outputs.values()].filter(output => output.principalId === principalId);
      for (const output of owned) remove(output, 'owner-revoked');
      return owned.length;
    },
    tick(): boolean {
      if (closed || busy) return false;
      busy = true;
      const previousAt = lastStepAt;
      try {
        const at = now(); if (closed) return false;
        if (frame >= Number.MAX_SAFE_INTEGER) { retire('engine-unavailable'); return false; }
        let snapshot: JsonValue;
        try {
          lastStepAt = at;
          const produced = step(Object.freeze({ frame: ++frame, at, elapsedMs: previousAt === undefined ? 0 : at - previousAt, signal: engineSignal.signal }));
          if (produced instanceof Promise) {
            void produced.catch(() => {});
            throw new TypeError('The engine must finish synchronously');
          }
          snapshot = snapshotJson(produced);
        }
        catch { retire('engine-unavailable'); return false; }
        if (closed) return false;
        runtime.flush(); if (closed) return false;
        for (const view of views.values()) {
          if (!view.available || ![...outputs.values()].some(output => output.view === view && output.route.status().state === 'active')) continue;
          let result;
          try { result = runtime.publish(view.source, view.project(snapshot), { timestamp: at, clockDomain }); }
          catch { /* Malformed projection follows the same retirement path. */ }
          if (closed) return false;
          if (!result?.ok) { view.available = false; runtime.unregister(view.source); }
        }
        runtime.flush(); return !closed;
      } finally { busy = false; }
    },
    status: () => Object.freeze({ state: closed ? 'stopped' : 'active', outputs: outputs.size, frame, ...(reason ? { reason } : {}) }),
    stop: () => retire('application-stopped'),
  });
}
