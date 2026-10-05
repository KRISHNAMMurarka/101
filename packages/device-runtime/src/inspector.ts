import { DeviceValidationError, parseDeviceDescriptor, snapshotJson } from '@101/device-model';
import type { DeviceCapability } from '@101/device-model';
import { createDeviceRuntime } from './index.ts';
import type { Result, OperationRecord } from './scheduler.ts';
import type { Connection, DeviceRuntime, EndpointHandle, Readiness, RouteRequest, RuntimeOptions, SinkProvider } from './types.ts';

export type InspectorAction = 'register-source' | 'register-sink' | 'readiness' | 'unregister' | 'route'
  | 'prepare' | 'activate' | 'start' | 'renew' | 'stop' | 'route-closed' | 'publish' | 'flush' | 'revoke' | 'close';
export type InspectorGrant = 'not-requested' | 'allowed' | 'denied' | 'revoked' | 'ended';
export interface InspectorTrace {
  readonly sequence: number;
  readonly action: InspectorAction;
  readonly target: string;
  readonly result: 'ok' | 'failed';
  readonly code?: string;
}
export interface InspectorResource {
  readonly id: string;
  readonly role: 'source' | 'sink';
  /** Unknown is explicit when the public API cannot distinguish quality loss from stale admission. */
  readonly readiness: Readiness | 'unknown';
  readonly descriptorRevision: number;
  readonly schemaVersion: number;
  readonly kind: DeviceCapability['kind'];
  readonly valueType: DeviceCapability['value']['type'];
  readonly delivery: DeviceCapability['delivery']['mode'];
  readonly permissions: DeviceCapability['permissions'];
}
export interface InspectorRoute {
  readonly id: string;
  readonly source: string;
  readonly sink: string;
  readonly sourceOperation: 'read' | 'subscribe' | 'unknown';
  readonly sinkOperation: 'write' | 'invoke';
  readonly grant: InspectorGrant;
  readonly state: ReturnType<Connection['status']>['state'];
  readonly reason?: string;
  readonly pending: number;
  readonly queueCapacity: number | 'unknown';
  readonly limits?: ReturnType<Connection['limits']>;
  readonly operations: readonly Readonly<OperationRecord>[];
}
export interface InspectorSnapshot {
  readonly closed: boolean;
  readonly resources: readonly InspectorResource[];
  readonly routes: readonly InspectorRoute[];
  readonly trace: readonly InspectorTrace[];
  readonly errors: readonly InspectorTrace[];
  readonly traceCapacity: number;
  readonly maxTrackedRoutes: number;
}
export interface RuntimeInspector {
  /** All authority and validation remain in the owned DeviceRuntime. */
  readonly runtime: DeviceRuntime;
  snapshot(): InspectorSnapshot;
  close(): void;
}
export interface RuntimeInspectorOptions extends RuntimeOptions {
  traceCapacity?: number;
  maxTrackedRoutes?: number;
}

const CODES = new Set(['unknown-endpoint', 'invalid-readiness', 'invalid-expiry', 'closed', 'authorization-reentry',
  'invalid-identity', 'unsupported-operation', 'incompatible', 'invalid-partition', 'invalid-clock', 'unavailable',
  'capacity', 'denied', 'invalid-constraints', 'stale', 'busy', 'not-owner', 'expired', 'ownership-lost',
  'already-prepared', 'not-prepared', 'already-active', 'foreign-clock', 'out-of-order', 'invalid-quality',
  'invalid-provenance', 'payload-limit', 'invalid-operation-id', 'stale-operation', 'invalid-deadline',
  'invalid-options', 'no-route', 'invalid-observation', 'read-snapshot', 'duplicate-operation', 'revoked',
  'stopped', 'unregistered', 'runtime-closed', 'provider-failed', 'read-complete', 'schema-invalid',
  'schema-version', 'schema-mismatch', 'schema-version-mismatch', 'redacted-error']);
const safeCode = (code: string): string => CODES.has(code) ? code : 'redacted-error';
function capacity(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new InspectorDiagnosticError('capacity');
  return result;
}
export class InspectorDiagnosticError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safe = safeCode(code);
    super(`Inspector operation failed: ${safe}`);
    this.name = 'InspectorDiagnosticError'; this.code = safe;
  }
}
interface ResourceEntry { summary: InspectorResource; expiresAt?: number }
interface RouteEntry {
  connection: Connection; id: string; source: string; sink: string; sourceOperation: InspectorRoute['sourceOperation'];
  sinkOperation: 'write' | 'invoke'; grant: InspectorGrant; queueCapacity: InspectorRoute['queueCapacity'];
  versionMismatch: boolean; unsubscribe: () => void;
}

/** A bounded diagnostic owner using public runtime methods, never the runtime registry. */
export function createRuntimeInspector(options: RuntimeInspectorOptions): RuntimeInspector {
  const traceCapacity = capacity(options.traceCapacity, 32, 256);
  const maxTrackedRoutes = capacity(options.maxTrackedRoutes, 32, 128);
  const readClock = options.now ?? (() => performance.now());
  let previousTime = -Infinity;
  function now(): number {
    let value: number;
    try { value = readClock(); }
    catch (error) { close(); throw error; }
    if (!Number.isFinite(value) || value < 0 || value < previousTime) close();
    else previousTime = value;
    return value;
  }
  const owned = createDeviceRuntime({ ...options, now });
  const resources = new Map<EndpointHandle, ResourceEntry>();
  const routes = new Map<Connection, RouteEntry>();
  const trace: InspectorTrace[] = [];
  let resourceSequence = 0, routeSequence = 0, traceSequence = 0, closed = false;
  let publishingLoss: { handle: EndpointHandle; quality: 'unavailable' | 'stale' } | undefined;
  function record(action: InspectorAction, target: string, result: 'ok' | 'failed', code?: string): void {
    trace.push(Object.freeze({ sequence: ++traceSequence, action, target, result,
      ...(code === undefined ? {} : { code: safeCode(code) }) }));
    if (trace.length > traceCapacity) trace.splice(0, trace.length - traceCapacity);
  }
  function result<T>(action: InspectorAction, target: string, value: Result<T>, mismatch = false): Result<T> {
    const code = !value.ok && value.reason === 'incompatible' ? mismatch ? 'schema-version-mismatch' : 'schema-mismatch'
      : !value.ok ? value.reason : undefined;
    record(action, target, value.ok ? 'ok' : 'failed', code);
    return value;
  }
  function register(provider: { device: unknown; capability: string }, role: 'source' | 'sink', sink?: SinkProvider): EndpointHandle {
    const action = role === 'source' ? 'register-source' : 'register-sink';
    if (closed) { record(action, 'runtime', 'failed', 'closed'); throw new InspectorDiagnosticError('closed'); }
    try {
      const descriptor = parseDeviceDescriptor(provider.device);
      const capability = descriptor.capabilities.find(item => item.id === provider.capability);
      if (!capability) throw new InspectorDiagnosticError('unknown-endpoint');
      const handle = role === 'source' ? owned.registerSource({ device: descriptor, capability: provider.capability })
        : owned.registerSink({ device: descriptor, capability: provider.capability,
          apply: sink!.apply.bind(sink), release: sink!.release.bind(sink) });
      const summary: InspectorResource = Object.freeze({ id: `resource-${++resourceSequence}`, role,
        readiness: 'unavailable', descriptorRevision: descriptor.revision, schemaVersion: capability.schemaVersion,
        kind: capability.kind, valueType: capability.value.type, delivery: capability.delivery.mode,
        permissions: Object.freeze([...capability.permissions]) });
      resources.set(handle, { summary }); record(action, summary.id, 'ok'); return handle;
    } catch (error) {
      const code = error instanceof InspectorDiagnosticError ? error.code : error instanceof DeviceValidationError
        ? error.code.endsWith('schema-version') ? 'schema-version' : 'schema-invalid' : 'redacted-error';
      record(action, 'runtime', 'failed', code); throw new InspectorDiagnosticError(code);
    }
  }
  function close(): void {
    if (closed) return;
    closed = true;
    const tracked = [...routes.values()];
    routes.clear(); resources.clear();
    owned.close();
    for (const entry of tracked) entry.unsubscribe();
    record('close', 'runtime', 'ok');
  }
  const runtime = Object.freeze<DeviceRuntime>({
    clockDomain: owned.clockDomain,
    registerSource: (provider: { device: unknown; capability: string }) => register(provider, 'source'),
    registerSink: (provider: SinkProvider) => register(provider, 'sink', provider),
    setReadiness(handle, readiness, expiresAt) {
      const entry = resources.get(handle);
      const value = owned.setReadiness(handle, readiness, expiresAt);
      if (value.ok && entry) { entry.summary = Object.freeze({ ...entry.summary, readiness }); entry.expiresAt = expiresAt; }
      return result('readiness', entry?.summary.id ?? 'unknown-resource', value);
    },
    unregister(handle) {
      const entry = resources.get(handle), value = owned.unregister(handle);
      if (value.ok) resources.delete(handle);
      return result('unregister', entry?.summary.id ?? 'unknown-resource', value);
    },
    route(request: RouteRequest) {
      if (closed) { record('route', 'runtime', 'failed', 'closed'); throw new InspectorDiagnosticError('closed'); }
      if (routes.size >= maxTrackedRoutes) {
        const retired = [...routes].find(([, entry]) => entry.connection.status().state === 'closed');
        if (retired) { retired[1].unsubscribe(); routes.delete(retired[0]); }
        else { record('route', 'runtime', 'failed', 'capacity'); throw new InspectorDiagnosticError('capacity'); }
      }
      let connection: Connection;
      let captured: RouteRequest;
      try { captured = { ...request }; connection = owned.route(captured); }
      catch { record('route', 'runtime', 'failed', 'redacted-error'); throw new InspectorDiagnosticError('redacted-error'); }
      const source = resources.get(captured.from)?.summary, sink = resources.get(captured.to)?.summary;
      const requestedOperation: unknown = captured.sourceOperation ?? (source?.permissions.includes('subscribe') ? 'subscribe' : 'read');
      const requestedCapacity: unknown = captured.queueCapacity ?? 64;
      const entry: RouteEntry = { connection, id: `route-${++routeSequence}`, source: source?.id ?? 'unknown-resource',
        sink: sink?.id ?? 'unknown-resource', sourceOperation: requestedOperation === 'read' || requestedOperation === 'subscribe' ? requestedOperation : 'unknown',
        sinkOperation: sink?.kind === 'command' || sink?.kind === 'job' ? 'invoke' : 'write',
        grant: 'not-requested', queueCapacity: source?.delivery === 'latest' ? 1
          : typeof requestedCapacity === 'number' && Number.isInteger(requestedCapacity) && requestedCapacity >= 1 && requestedCapacity <= 256
            ? requestedCapacity : 'unknown',
        versionMismatch: source !== undefined && sink !== undefined && source.schemaVersion !== sink.schemaVersion, unsubscribe: () => {} };
      function invoke(action: 'prepare' | 'activate' | 'start' | 'renew', run: () => Result): Result {
        const value = run();
        if (value.ok && action !== 'renew') entry.grant = 'allowed';
        else if (!value.ok && value.reason === 'denied') entry.grant = 'denied';
        return result(action, entry.id, value, entry.versionMismatch);
      }
      let callerStopping = false;
      const wrapped: Connection = Object.freeze({ id: connection.id,
        prepare: () => invoke('prepare', () => connection.prepare()),
        activate: () => invoke('activate', () => connection.activate()),
        start: () => invoke('start', () => connection.start()),
        renew: (principalId: string) => invoke('renew', () => connection.renew(principalId)),
        stop(reason?: string) {
          callerStopping = true;
          try { connection.stop(reason); }
          finally { callerStopping = false; }
          record('stop', entry.id, 'ok', reason);
        },
        onClose: (listener: (reason: string) => void) => connection.onClose(listener),
        status: () => connection.status(), limits: () => connection.limits(), operations: () => connection.operations() });
      entry.unsubscribe = connection.onClose(reason => {
        if (publishingLoss && reason === publishingLoss.quality) {
          const resource = resources.get(publishingLoss.handle);
          if (resource) resource.summary = Object.freeze({ ...resource.summary, readiness: publishingLoss.quality });
        }
        if (reason === 'revoked') entry.grant = 'revoked';
        else if (entry.grant !== 'denied') entry.grant = 'ended';
        record('route-closed', entry.id, 'ok', reason);
        if (reason === 'runtime-closed' && !callerStopping) close();
      });
      routes.set(wrapped, entry); record('route', entry.id, 'ok'); return wrapped;
    },
    publish(handle, value, publishOptions) {
      let quality: 'unavailable' | 'stale' | undefined;
      try {
        const copied = snapshotJson(publishOptions ?? {});
        if (copied && typeof copied === 'object' && !Array.isArray(copied) &&
          (copied.quality === 'unavailable' || copied.quality === 'stale')) quality = copied.quality;
      } catch { /* Invalid options are rejected by the runtime without entering diagnostics. */ }
      const previousLoss = publishingLoss;
      publishingLoss = quality === undefined ? undefined : { handle, quality };
      let published: ReturnType<DeviceRuntime['publish']>;
      try { published = owned.publish(handle, value, publishOptions); }
      finally { publishingLoss = previousLoss; }
      // Unlike stale timestamps, unavailable quality has a distinct admission result.
      if (!published.ok && published.reason === 'unavailable' && quality === 'unavailable') {
        const resource = resources.get(handle);
        if (resource) resource.summary = Object.freeze({ ...resource.summary, readiness: quality });
      }
      if (!published.ok && published.reason === 'stale' && quality === 'stale') {
        const resource = resources.get(handle);
        if (resource && resource.summary.readiness !== 'stale')
          resource.summary = Object.freeze({ ...resource.summary, readiness: 'unknown' });
      }
      return result('publish', resources.get(handle)?.summary.id ?? 'unknown-resource', published);
    },
    flush() { owned.flush(); record('flush', 'runtime', 'ok'); },
    revoke(connection) {
      const entry = routes.get(connection);
      if (entry) owned.revoke(entry.connection);
      record('revoke', entry?.id ?? 'unknown-route', entry ? 'ok' : 'failed', entry ? undefined : 'unknown-endpoint');
    },
    close,
  });
  function snapshot(): InspectorSnapshot {
    let time = Infinity;
    if (!closed) try { time = now(); } catch { /* No clock exception enters the report. */ }
    const resourceReports = [...resources.values()].map(({ summary, expiresAt }) =>
      Object.freeze({ ...summary, readiness: summary.readiness === 'available' && expiresAt !== undefined && time > expiresAt ? 'stale' as const : summary.readiness }));
    const routeReports = [...routes.values()].map(entry => {
      const limits = entry.connection.limits(), status = entry.connection.status();
      return Object.freeze({ id: entry.id, source: entry.source, sink: entry.sink, sourceOperation: entry.sourceOperation,
        sinkOperation: entry.sinkOperation, grant: entry.grant, state: status.state, pending: status.pending,
        ...(status.reason === undefined ? {} : { reason: safeCode(status.reason) }), queueCapacity: entry.queueCapacity,
        ...(limits === undefined ? {} : { limits }), operations: Object.freeze(entry.connection.operations().map((operation, index) =>
          Object.freeze({ ...operation, id: `operation-${index + 1}` }))) });
    });
    return Object.freeze({ closed, resources: Object.freeze(closed ? [] : resourceReports), routes: Object.freeze(closed ? [] : routeReports),
      trace: Object.freeze([...trace]), errors: Object.freeze(trace.filter(entry => entry.result === 'failed')),
      traceCapacity, maxTrackedRoutes });
  }
  return Object.freeze({ runtime, snapshot, close });
}
