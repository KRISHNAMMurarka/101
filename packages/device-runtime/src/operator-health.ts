export const OPERATOR_HEALTH_PROFILE = 'selected-operator-health/1';
export const OPERATOR_HEALTH_LIMITS = Object.freeze({ sources: 8, rows: 32, bytes: 32768, attempts: 64,
  grantMs: 30000, authorizeMs: 1000, sampleMs: 100, resources: 4096, routes: 128, trace: 256 });
export type OperatorHealthKind = 'runtime-inspector' | 'wss-transport';
export interface OperatorHealthSource { readonly id: string; readonly kind: OperatorHealthKind; readonly poll: () => unknown }
export interface OperatorHealthScope {
  readonly ownerId: string; readonly operatorId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly sources: readonly Readonly<{ id: string; kind: OperatorHealthKind }>[];
}
export interface OperatorHealthGrant { readonly scope: OperatorHealthScope; readonly expiresAt: number; readonly isCurrent: () => boolean; readonly signal?: AbortSignal }
export interface OperatorHealthOptions {
  readonly scope: Omit<OperatorHealthScope, 'sources'>; readonly sources: readonly OperatorHealthSource[]; readonly now: () => number;
  readonly authorize: (scope: OperatorHealthScope) => OperatorHealthGrant | undefined | Promise<OperatorHealthGrant | undefined>;
}
export type OperatorHealthReason = 'invalid' | 'capacity' | 'denied' | 'closed' | 'busy' | 'expired' | 'revoked' | 'invalid-clock' | 'unavailable' | 'not-started' | 'rate-limited';
export type OperatorHealthResult<T = undefined> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: OperatorHealthReason }>;
export interface OperatorRuntimeMetrics {
  readonly kind: 'runtime-inspector'; readonly resources: number; readonly availableResources: number; readonly routes: number;
  readonly activeRoutes: number; readonly deniedRoutes: number; readonly revokedRoutes: number; readonly queuedOperations: number;
  readonly knownQueueCapacity: number; readonly unknownQueueRoutes: number; readonly faultsInTrace: number;
  /** Current public route queues do not expose all raw provider reservations. */
  readonly rawProviderWork: null;
}
export interface OperatorWssMetrics {
  readonly kind: 'wss-transport'; readonly sentPackets: number; readonly receivedPackets: number; readonly droppedPackets: number;
  readonly reportedPending: number; readonly bufferedBytes: number;
  readonly connectionState: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'unknown';
}
export interface OperatorSourceHealth { readonly source: string; readonly kind: OperatorHealthKind; readonly state: 'available' | 'unavailable' | 'closed'; readonly metrics: OperatorRuntimeMetrics | OperatorWssMetrics | null }
export interface OperatorHealthSample { readonly sequence: number; readonly sampledAt: number; readonly sources: readonly OperatorSourceHealth[] }
export interface OperatorHealthSnapshot {
  readonly state: 'not-started' | 'authorizing' | 'active' | 'stopped' | 'expired' | 'revoked' | 'closed' | 'unavailable';
  readonly remainingStarts: number; readonly rawAuthorizations: number; readonly timerArmed: boolean;
  readonly retainedBytes: number; readonly samples: readonly OperatorHealthSample[];
}
export interface OperatorHealthMonitor { start(): Promise<OperatorHealthResult>; sample(): OperatorHealthResult<OperatorHealthSample>; snapshot(): OperatorHealthSnapshot; stop(): void; close(): void }
class HealthError extends Error { readonly reason: OperatorHealthReason; constructor(reason: OperatorHealthReason) { super(reason); this.reason = reason; } }
function fail(reason: OperatorHealthReason): never { throw new HealthError(reason); }
const no = (reason: OperatorHealthReason): OperatorHealthResult<never> => Object.freeze({ ok: false, reason });
const yes = <T = undefined>(value: T = undefined as T): OperatorHealthResult<T> => Object.freeze({ ok: true, value });
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid');
  const names = Reflect.ownKeys(value); if (names.length > required.length + optional.length) fail('invalid');
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (typeof name !== 'string' || !required.includes(name) && !optional.includes(name) || !property?.enumerable || !('value' in property)) fail('invalid');
    result[name] = property.value;
  }
  if (required.some(name => !Object.hasOwn(result, name))) fail('invalid'); return result;
}
function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object') fail('unavailable');
  const property = Object.getOwnPropertyDescriptor(value, name);
  if (!property || !('value' in property)) fail('unavailable'); return property.value;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('unavailable');
  const length = count(field(value, 'length'), maximum);
  const result: unknown[] = [];
  for (let i = 0; i < length; i++) result.push(field(value, String(i))); return result;
}
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
function count(v: unknown, max = Number.MAX_SAFE_INTEGER): number { if (!number(v) || !Number.isSafeInteger(v) || v > max) fail('unavailable'); return v; }
function runtimeMetrics(value: unknown): { closed: boolean; metrics: OperatorRuntimeMetrics } {
  const closed = field(value, 'closed'); if (typeof closed !== 'boolean') fail('unavailable');
  const resources = list(field(value, 'resources'), OPERATOR_HEALTH_LIMITS.resources), routes = list(field(value, 'routes'), OPERATOR_HEALTH_LIMITS.routes);
  const errors = list(field(value, 'errors'), OPERATOR_HEALTH_LIMITS.trace);
  let availableResources = 0, activeRoutes = 0, deniedRoutes = 0, revokedRoutes = 0, queuedOperations = 0, knownQueueCapacity = 0, unknownQueueRoutes = 0;
  for (const resource of resources) {
    const readiness = field(resource, 'readiness');
    if (!['available', 'unavailable', 'busy', 'denied', 'stale', 'unknown'].includes(readiness as string)) fail('unavailable');
    if (readiness === 'available') availableResources++;
  }
  for (const route of routes) {
    const state = field(route, 'state'); if (!['idle', 'prepared', 'active', 'closed'].includes(state as string)) fail('unavailable');
    if (state === 'active') activeRoutes++;
    const grant = field(route, 'grant'); if (!['not-requested', 'allowed', 'denied', 'revoked', 'ended'].includes(grant as string)) fail('unavailable'); if (grant === 'denied') deniedRoutes++; if (grant === 'revoked') revokedRoutes++;
    queuedOperations += count(field(route, 'pending'), 4096);
    const capacity = field(route, 'queueCapacity'); if (capacity === 'unknown') unknownQueueRoutes++; else knownQueueCapacity += count(capacity, 256);
  }
  return { closed, metrics: Object.freeze({ kind: 'runtime-inspector', resources: resources.length, availableResources, routes: routes.length,
    activeRoutes, deniedRoutes, revokedRoutes, queuedOperations, knownQueueCapacity, unknownQueueRoutes, faultsInTrace: errors.length, rawProviderWork: null }) };
}
function wssMetrics(value: unknown): OperatorWssMetrics {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'state') : undefined;
  const state = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  const connectionState = ['idle', 'connecting', 'connected', 'disconnected', 'failed'].includes(state as string) ? state as OperatorWssMetrics['connectionState'] : 'unknown';
  return Object.freeze({ kind: 'wss-transport', sentPackets: count(field(value, 'sent')), receivedPackets: count(field(value, 'received')),
    droppedPackets: count(field(value, 'dropped')), reportedPending: count(field(value, 'pending')), bufferedBytes: count(field(value, 'bufferedBytes')), connectionState });
}
function scope(value: unknown, withSources: boolean): OperatorHealthScope {
  const keys = ['ownerId', 'operatorId', 'applicationId', 'sessionId', 'purpose'];
  const copy = fields(value, withSources ? [...keys, 'sources'] : keys);
  if (keys.some(key => !identifier(copy[key]))) fail('invalid');
  const sources = withSources ? list(copy.sources, OPERATOR_HEALTH_LIMITS.sources).map(item => {
    const source = fields(item, ['id', 'kind']); if (!identifier(source.id) || !['runtime-inspector', 'wss-transport'].includes(source.kind as string)) fail('invalid');
    return Object.freeze({ id: source.id, kind: source.kind as OperatorHealthKind });
  }) : [];
  return Object.freeze({ ownerId: copy.ownerId as string, operatorId: copy.operatorId as string, applicationId: copy.applicationId as string,
    sessionId: copy.sessionId as string, purpose: copy.purpose as string, sources: Object.freeze(sources) });
}
interface Attempt { readonly epoch: number; readonly finish: (result: OperatorHealthResult) => void; readonly deadline: number; readonly wallDeadline: number; readonly grantCeiling: number }
interface Lease { readonly epoch: number; readonly grant: OperatorHealthGrant; readonly wallDeadline: number; readonly detach: () => void }
/** Explicit sampled metadata only. Borrowed inspector/transport owners retain lifecycle and resource authority.
 * Trusted synchronous callbacks are cooperative; this helper does not sandbox or preempt them.
 * Reports contain counts and fixed states, never IDs, labels, payloads, operation IDs, reasons or credentials. */
export function createOperatorHealthMonitor(input: OperatorHealthOptions): OperatorHealthMonitor {
  const options = fields(input, ['scope', 'sources', 'now', 'authorize']);
  if (typeof options.now !== 'function' || typeof options.authorize !== 'function') fail('invalid');
  const clock = options.now as () => number, authorize = options.authorize as OperatorHealthOptions['authorize'];
  const ids = new Set<string>(), sources = list(options.sources, OPERATOR_HEALTH_LIMITS.sources).map(item => {
    const value = fields(item, ['id', 'kind', 'poll']);
    if (!identifier(value.id) || ids.has(value.id) || !['runtime-inspector', 'wss-transport'].includes(value.kind as string) || typeof value.poll !== 'function') fail('invalid');
    ids.add(value.id); return Object.freeze({ id: value.id, kind: value.kind as OperatorHealthKind, poll: value.poll as () => unknown });
  });
  if (!sources.length) fail('invalid');
  const expectedScope = Object.freeze({ ...scope(options.scope, false), sources: Object.freeze(sources.map(({ id, kind }) => Object.freeze({ id, kind }))) });
  let state: OperatorHealthSnapshot['state'] = 'not-started', closed = false, epoch = 0, starts = 0, raw = 0, starting = false, reading = false, checking = false, sampling = false;
  let lastNow = -1, lastSample = -Infinity, sequence = 0, attempt: Attempt | undefined, lease: Lease | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const samples: OperatorHealthSample[] = [];
  function disarm() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function retire(next: OperatorHealthSnapshot['state'], reason: OperatorHealthReason) {
    epoch++; disarm(); lease?.detach(); lease = undefined; const old = attempt; attempt = undefined;
    samples.length = 0; lastSample = -Infinity; state = next; old?.finish(no(reason));
  }
  function close() { if (closed) return; closed = true; retire('closed', 'closed'); }
  function now(): number {
    if (closed) fail('closed'); if (reading) { close(); fail('invalid-clock'); } reading = true;
    try { const at = clock(); if (closed) fail('closed');
      if (!number(at) || at < lastNow || at > Number.MAX_SAFE_INTEGER - OPERATOR_HEALTH_LIMITS.grantMs) { close(); fail('invalid-clock'); }
      lastNow = at; return at;
    } catch (error) { if (!(error instanceof HealthError)) { close(); fail('invalid-clock'); } throw error; }
    finally { reading = false; }
  }
  function current(record: Lease): number {
    if (closed || lease !== record || epoch !== record.epoch) fail(closed ? 'closed' : 'revoked');
    if (checking) { retire('revoked', 'revoked'); fail('revoked'); } checking = true;
    try {
      const at = now();
      if (closed || lease !== record || epoch !== record.epoch) fail(closed ? 'closed' : 'revoked');
      if (at >= record.grant.expiresAt || performance.now() >= record.wallDeadline) { retire('expired', 'expired'); fail('expired'); }
      let approved = false; try { approved = !record.grant.signal?.aborted && record.grant.isCurrent() === true; } catch { /* No provider text retained. */ }
      const after = now();
      if (!approved || lease !== record || epoch !== record.epoch || record.grant.signal?.aborted) {
        if (!closed && lease === record && epoch === record.epoch) retire('revoked', 'revoked');
        fail(closed ? 'closed' : 'revoked');
      }
      if (after >= record.grant.expiresAt || performance.now() >= record.wallDeadline) { retire('expired', 'expired'); fail('expired'); }
      return after;
    } finally { checking = false; }
  }
  function bytes() { return new TextEncoder().encode(JSON.stringify(samples)).byteLength; }
  async function approve(record: Attempt) {
    let received: unknown;
    try { if (closed || attempt !== record) return; received = await authorize(expectedScope); }
    catch { if (!closed && attempt === record) retire('unavailable', 'unavailable'); return; }
    finally { raw--; }
    if (closed || attempt !== record || epoch !== record.epoch) return;
    try {
      const at = now(); if (at >= record.deadline || performance.now() >= record.wallDeadline) fail('expired');
      if (received === undefined) fail('denied');
      const value = fields(received, ['scope', 'expiresAt', 'isCurrent'], ['signal']);
      if (JSON.stringify(scope(value.scope, true)) !== JSON.stringify(expectedScope) || !number(value.expiresAt) || value.expiresAt <= at || value.expiresAt > record.grantCeiling ||
        typeof value.isCurrent !== 'function' || value.signal !== undefined && !(value.signal instanceof AbortSignal)) fail('denied');
      const grant: OperatorHealthGrant = Object.freeze({ scope: expectedScope, expiresAt: value.expiresAt, isCurrent: value.isCurrent as () => boolean,
        ...(value.signal ? { signal: value.signal as AbortSignal } : {}) });
      const end = () => { if (lease?.epoch === record.epoch) retire('revoked', 'revoked'); };
      if (closed || attempt !== record || epoch !== record.epoch) return;
      if (now() >= record.deadline || performance.now() >= record.wallDeadline) fail('expired');
      const selected: Lease = { epoch: record.epoch, grant, wallDeadline: performance.now() + grant.expiresAt - at,
        detach: () => grant.signal?.removeEventListener('abort', end) };
      lease = selected; current(selected);
      if (attempt !== record || epoch !== record.epoch) fail('revoked');
      attempt = undefined; disarm(); state = 'active';
      grant.signal?.addEventListener('abort', end, { once: true }); current(selected);
      const finalAt = current(selected), remaining = grant.expiresAt - finalAt;
      if (closed || lease !== selected || epoch !== record.epoch) fail(closed ? 'closed' : 'revoked');
      if (finalAt >= record.deadline || performance.now() >= record.wallDeadline) fail('expired');
      timer = setTimeout(() => { if (lease === selected) retire('expired', 'expired'); }, Math.max(1, remaining));
      record.finish(yes());
    } catch (error) {
      const reason = error instanceof HealthError ? error.reason : 'denied';
      if (!closed && (attempt === record || lease?.epoch === record.epoch)) retire(reason === 'expired' ? 'expired' : 'unavailable', reason);
      record.finish(no(reason));
    }
  }
  const monitor: OperatorHealthMonitor = {
    start() {
      if (closed) return Promise.resolve(no('closed')); if (starting || attempt || raw || lease || sampling) return Promise.resolve(no('busy'));
      if (starts >= OPERATOR_HEALTH_LIMITS.attempts) return Promise.resolve(no('capacity'));
      starting = true; const entryEpoch = epoch;
      try {
        const at = now(); if (closed || epoch !== entryEpoch) return Promise.resolve(no(closed ? 'closed' : 'revoked'));
        starts++; raw++; epoch++; state = 'authorizing';
        let finish!: Attempt['finish']; const result = new Promise<OperatorHealthResult>(resolve => { finish = resolve; });
        const record: Attempt = { epoch, finish, deadline: at + OPERATOR_HEALTH_LIMITS.authorizeMs,
          wallDeadline: performance.now() + OPERATOR_HEALTH_LIMITS.authorizeMs, grantCeiling: at + OPERATOR_HEALTH_LIMITS.grantMs }; attempt = record;
        timer = setTimeout(() => { if (attempt === record) retire('expired', 'expired'); }, OPERATOR_HEALTH_LIMITS.authorizeMs);
        void approve(record); return result;
      } catch (error) { return Promise.resolve(no(error instanceof HealthError ? error.reason : 'unavailable')); }
      finally { starting = false; }
    },
    sample() {
      if (closed) return no('closed'); if (sampling) return no('busy'); if (!lease) return no('not-started');
      sampling = true; const selected = lease;
      try {
        const at = current(selected); if (at - lastSample < OPERATOR_HEALTH_LIMITS.sampleMs) return no('rate-limited');
        const rows: OperatorSourceHealth[] = [];
        for (const [index, source] of sources.entries()) {
          current(selected); let metrics: OperatorSourceHealth['metrics'] = null, health: OperatorSourceHealth['state'] = 'unavailable';
          try { const value = source.poll(); current(selected);
            if (source.kind === 'runtime-inspector') { const projection = runtimeMetrics(value); metrics = projection.metrics; health = projection.closed ? 'closed' : 'available'; }
            else { metrics = wssMetrics(value); health = 'available'; }
          } catch { /* Provider exception/message/value/identity never enters output. */ }
          current(selected); rows.push(Object.freeze({ source: `source-${index + 1}`, kind: source.kind, state: health, metrics }));
        }
        const after = current(selected), sample: OperatorHealthSample = Object.freeze({ sequence: ++sequence, sampledAt: after, sources: Object.freeze(rows) });
        samples.push(sample); lastSample = after;
        while (samples.length > OPERATOR_HEALTH_LIMITS.rows || bytes() > OPERATOR_HEALTH_LIMITS.bytes) samples.shift();
        return yes(sample);
      } catch (error) { return no(error instanceof HealthError ? error.reason : 'unavailable'); }
      finally { sampling = false; }
    },
    snapshot() {
      if (lease) try { current(lease); } catch { /* Retired metadata stays cleared. */ }
      return Object.freeze({ state, remainingStarts: OPERATOR_HEALTH_LIMITS.attempts - starts, rawAuthorizations: raw,
        timerArmed: timer !== undefined, retainedBytes: bytes(), samples: Object.freeze([...samples]) });
    },
    stop() { if (!closed) retire('stopped', 'revoked'); }, close,
  };
  return Object.freeze(monitor);
}
