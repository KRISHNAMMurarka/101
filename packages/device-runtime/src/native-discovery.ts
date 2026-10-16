import { assessDiscoveryCandidate, parseDiscoveryCandidate } from '@101/device-model';
import type { DiscoveryAssessment, DiscoveryCandidate } from '@101/device-model';

export const NATIVE_DISCOVERY_PROFILE = 'macos-local-only-dns-sd/1';
export const NATIVE_DISCOVERY_SELECTED_INTERFACE_PROFILE = 'macos-selected-interface-dns-sd/1';
export const NATIVE_DISCOVERY_LIMITS = Object.freeze({ candidates: 16, resolvers: 8, txtBytes: 512, stdoutBytes: 16384,
  eventsPerSecond: 64, startupMs: 5000, grantMs: 30000, observationMs: 2000, attempts: 32, transitions: 64, tickMs: 20 });
export interface NativeDiscoveryScope {
  readonly ownerId: string; readonly applicationId: string; readonly sessionId: string; readonly serviceType: string;
  readonly domain: 'local.'; readonly interfaceIndex: number; readonly profile: typeof NATIVE_DISCOVERY_PROFILE | typeof NATIVE_DISCOVERY_SELECTED_INTERFACE_PROFILE; readonly operation: 'observe';
}
export interface NativeDiscoveryGrant { readonly scope: NativeDiscoveryScope; readonly expiresAt: number; readonly isCurrent: () => boolean; readonly signal?: AbortSignal }
export interface NativeDiscoveryService {
  readonly interfaceIndex: number; readonly name: string; readonly serviceType: string; readonly domain: 'local.';
  readonly target: string; readonly port: number; readonly txtHex: string;
}
export type NativeDiscoveryEvent = Readonly<{ version: 1; type: 'ready' | 'quota' }> |
  Readonly<{ version: 1; type: 'resolved'; } & NativeDiscoveryService> |
  Readonly<{ version: 1; type: 'removed'; interfaceIndex: number; name: string; serviceType: string; domain: 'local.' }>;
export interface NativeDiscoveryOperation { stop(): void }
export interface NativeDiscoveryProvider {
  readonly profile: typeof NATIVE_DISCOVERY_PROFILE | typeof NATIVE_DISCOVERY_SELECTED_INTERFACE_PROFILE;
  /** Trusted host port. Throwing means no raw operation was allocated. closed must report actual native process exit. */
  open(scope: Readonly<NativeDiscoveryScope>, callbacks: { event(event: unknown): void; closed(): void }, signal: AbortSignal): NativeDiscoveryOperation;
}
export interface NativeDiscoveryOptions {
  readonly scope: NativeDiscoveryScope; readonly now: () => number; readonly provider?: NativeDiscoveryProvider;
  /** Called on every explicit start. No saved grant or automatic replay. */
  readonly authorize: (scope: Readonly<NativeDiscoveryScope>) => NativeDiscoveryGrant | undefined;
}
export interface NativeDiscoveryHandle { readonly kind: 'native-observation' }
export interface NativeDiscoveryRow { readonly handle: NativeDiscoveryHandle; readonly service: NativeDiscoveryService; readonly candidate: DiscoveryCandidate }
export interface NativeDiscoverySnapshot {
  readonly phase: 'idle' | 'starting' | 'observing' | 'stopped' | 'expired' | 'unavailable' | 'closed' | 'unsupported';
  readonly rows: readonly NativeDiscoveryRow[]; readonly rawReservations: number; readonly attempts: number; readonly timerArmed: boolean;
  readonly transitions: readonly Readonly<{ sequence: number; event: string }>[];
}
export type NativeDiscoveryResult = Readonly<{ ok: true; attempt: number }> | Readonly<{ ok: false; reason: 'closed' | 'busy' | 'capacity' | 'unsupported' | 'denied' | 'unavailable' }>;
export interface NativeDiscoveryController {
  start(): NativeDiscoveryResult; stop(): void; sweep(): void; snapshot(): NativeDiscoverySnapshot;
  /** Issued handle only; the result can be observed, never authenticated/authorized/ready. */
  assess(handle: NativeDiscoveryHandle): DiscoveryAssessment | undefined;
  close(): void;
}
interface Row extends NativeDiscoveryRow { readonly key: string; readonly id: string }
interface Attempt { readonly id: number; readonly grant: NativeDiscoveryGrant; readonly abort: AbortController; readonly wallExpiry: number; readonly wallStartup: number;
  reserved: boolean; ended: boolean; ready: boolean; operation?: NativeDiscoveryOperation; detach?: () => void; eventsAt: number; events: number; nextRow: number;
  readonly rows: Map<string, Row> }
let nextController = 0;
function data(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid native discovery data');
  const result: Record<string, unknown> = {}; for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key) || !property?.enumerable || !('value' in property)) throw new TypeError('Invalid native discovery fields');
    result[key] = property.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) throw new TypeError('Missing native discovery field'); return result;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const serviceType = (value: unknown): value is string => typeof value === 'string' && /^_[A-Za-z0-9-]{1,15}\._tcp$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const selectedInterface = (value: unknown): value is number => integer(value) && value > 0 && value < 0xfffffffb;
function name(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.trim() === value &&
  new TextEncoder().encode(value).byteLength <= 63 && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127); }
function txt(value: unknown): value is string {
  // Closed producer-specific public TXT: one length-prefixed profile=1 string.
  // Unknown keys, identifiers, URLs and credentials are never exported.
  return value === '0970726f66696c653d31';
}
function dnsTarget(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 4 || value.length > 254 || !value.endsWith('.')) return false;
  const labels = value.slice(0, -1).split('.');
  return labels.length >= 2 && labels.every(label => label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
const failed = (reason: Extract<NativeDiscoveryResult, { ok: false }>['reason']): NativeDiscoveryResult => Object.freeze({ ok: false, reason });

/** Native observations of local software only. Native host ports and synchronous
 * callbacks are trusted code, not sandboxed/preemptible. Discovery never fetches
 * endpoints, proves identity, infers capabilities or supplies resource grants. */
export function createNativeDiscoveryController(input: NativeDiscoveryOptions): NativeDiscoveryController {
  const options = data(input, ['scope', 'now', 'authorize'], ['provider']);
  const fields = data(options.scope, ['ownerId', 'applicationId', 'sessionId', 'serviceType', 'domain', 'interfaceIndex', 'profile', 'operation']);
  const localOnly = fields.profile === NATIVE_DISCOVERY_PROFILE && fields.interfaceIndex === 0xffffffff;
  const selected = fields.profile === NATIVE_DISCOVERY_SELECTED_INTERFACE_PROFILE && selectedInterface(fields.interfaceIndex);
  if (![fields.ownerId, fields.applicationId, fields.sessionId].every(identifier) || !serviceType(fields.serviceType) || fields.domain !== 'local.' ||
    !(localOnly || selected) || fields.operation !== 'observe' || typeof options.now !== 'function' || typeof options.authorize !== 'function') throw new TypeError('Invalid native discovery scope');
  const scope = Object.freeze(fields) as unknown as NativeDiscoveryScope, now = options.now as () => number, authorize = options.authorize as NativeDiscoveryOptions['authorize'];
  let provider: NativeDiscoveryProvider | undefined;
  if (options.provider !== undefined) { const value = data(options.provider, ['profile', 'open']);
    if (value.profile !== fields.profile || typeof value.open !== 'function') throw new TypeError('Invalid native provider');
    provider = Object.freeze(value) as unknown as NativeDiscoveryProvider; }
  const instance = ++nextController, issued = new WeakMap<NativeDiscoveryHandle, Row>();
  let closed = false, busy = false, reading = false, last = -1, attempts = 0, raw = 0, sequence = 0, generation = 0, active: Attempt | undefined;
  let phase: NativeDiscoverySnapshot['phase'] = provider ? 'idle' : 'unsupported', timer: ReturnType<typeof setTimeout> | undefined;
  const transitions: { sequence: number; event: string }[] = [];
  function report(event: string) { transitions.push(Object.freeze({ sequence: ++sequence, event })); if (transitions.length > NATIVE_DISCOVERY_LIMITS.transitions) transitions.shift(); }
  function disarm() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function live(record: Attempt) { return !closed && active === record && !record.ended && !record.abort.signal.aborted; }
  function retire(record: Attempt, next: NativeDiscoverySnapshot['phase']) {
    if (active === record) active = undefined; record.rows.clear(); record.abort.abort(); record.detach?.(); record.detach = undefined;
    try { record.operation?.stop(); } catch { /* Actual exit reservation remains until closed callback. */ }
    disarm(); if (!closed) { phase = next; report(next); }
  }
  function close() { if (closed) return; closed = true; disarm(); if (active) retire(active, 'closed'); phase = 'closed'; report('closed'); }
  function time(): number {
    if (closed || reading) { if (reading) close(); throw new Error('Unavailable discovery clock'); }
    reading = true; try { const value = now(); if (closed || !integer(value) || value < last || value > Number.MAX_SAFE_INTEGER - NATIVE_DISCOVERY_LIMITS.grantMs) throw new Error('Unavailable discovery clock');
      last = value; return value;
    } catch { close(); throw new Error('Unavailable discovery clock'); } finally { reading = false; }
  }
  function current(record: Attempt): number | undefined {
    if (!live(record)) return; let at: number;
    try { at = time(); let valid = false; try { valid = record.grant.isCurrent() === true; } catch { /* Fresh owner authority required. */ }
      at = time(); if (!live(record)) return;
      if (!valid || record.grant.signal?.aborted) { retire(record, 'stopped'); return; }
      if (at >= record.grant.expiresAt || performance.now() >= record.wallExpiry) { retire(record, 'expired'); return; }
      return at;
    } catch { return; }
  }
  function arm() {
    if (closed || !active || timer !== undefined) return;
    const owned = setTimeout(() => { if (timer !== owned) return; timer = undefined; sweep(); }, NATIVE_DISCOVERY_LIMITS.tickMs);
    if (closed || !active) clearTimeout(owned); else timer = owned;
  }
  function sweep() {
    const record = active; if (!record) return; const at = current(record); if (at === undefined) return;
    if (!record.ready && performance.now() >= record.wallStartup) { retire(record, 'unavailable'); return; }
    for (const [key, row] of record.rows) if (at >= row.candidate.expiresAt) { record.rows.delete(key); report('expired-row'); }
    arm();
  }
  function ingest(record: Attempt, input: unknown) {
    const at = current(record); if (at === undefined) return;
    if (at - record.eventsAt >= 1000) { record.eventsAt = at; record.events = 0; }
    if (++record.events > NATIVE_DISCOVERY_LIMITS.eventsPerSecond) { retire(record, 'unavailable'); return; }
    try {
      const kind = data(input, ['version', 'type'], ['interfaceIndex', 'name', 'serviceType', 'domain', 'target', 'port', 'txtHex']);
      if (kind.version !== 1 || !live(record) || record.grant.signal?.aborted) return;
      if (kind.type === 'quota') { data(input, ['version', 'type']); report('resolver-capacity'); return; }
      if (kind.type === 'ready') { data(input, ['version', 'type']); if (!live(record) || record.grant.signal?.aborted) return; record.ready = true; phase = 'observing'; report('native-ready'); return; }
      const value = data(input, ['version', 'type', 'interfaceIndex', 'name', 'serviceType', 'domain'], kind.type === 'resolved' ? ['target', 'port', 'txtHex'] : []);
      if (!['resolved', 'removed'].includes(value.type as string) || value.interfaceIndex !== scope.interfaceIndex || value.serviceType !== scope.serviceType || value.domain !== scope.domain || !name(value.name)) return;
      const key = JSON.stringify([value.interfaceIndex, value.name, value.serviceType, value.domain]);
      if (value.type === 'removed') { if (record.rows.delete(key)) report('withdrawn'); return; }
      const target = value.target;
      const validTarget = scope.profile === NATIVE_DISCOVERY_PROFILE ? target === 'localhost.' : dnsTarget(target);
      if (!validTarget || !integer(value.port) || value.port < 1 || value.port > 65535 || !txt(value.txtHex)) return;
      let row = record.rows.get(key);
      if (!row && record.rows.size >= NATIVE_DISCOVERY_LIMITS.candidates) { report('candidate-capacity'); return; }
      const handle = row?.handle ?? Object.freeze({ kind: 'native-observation' as const }), id = row?.id ?? `native-${instance}-${record.id}-${++record.nextRow}`;
      const service = Object.freeze({ interfaceIndex: scope.interfaceIndex, name: value.name, serviceType: scope.serviceType, domain: scope.domain,
        target: target as string, port: value.port, txtHex: value.txtHex });
      const expiresAt = Math.min(record.grant.expiresAt, at + NATIVE_DISCOVERY_LIMITS.observationMs);
      const candidate = parseDiscoveryCandidate({ schemaVersion: 1, id, scope: { kind: 'session', id: scope.sessionId }, expiresAt,
        recovery: { action: 'rescan', hint: 'Review this local software again.' }, evidence: [{ stage: 'observed', kind: 'observation', candidateId: id,
          scope: { kind: 'session', id: scope.sessionId }, receiptId: `native-${instance}-${record.id}-${++sequence}`, at, expiresAt }] });
      if (!live(record) || record.grant.signal?.aborted) return;
      row = Object.freeze({ handle, service, candidate, key, id }); record.rows.set(key, row); issued.set(handle, row); report('observed'); arm();
    } catch { /* Closed malformed producer data cannot become an observation. */ }
  }
  const controller: NativeDiscoveryController = {
    start() {
      if (closed) return failed('closed'); if (busy || active || raw) return failed('busy'); if (!provider) return failed('unsupported');
      if (attempts >= NATIVE_DISCOVERY_LIMITS.attempts) return failed('capacity'); busy = true; attempts++; let openReturned = false;
      const admission = generation;
      try {
        const at = time(); if (closed || generation !== admission) return failed(closed ? 'closed' : 'unavailable');
        const received = authorize(scope); if (closed || generation !== admission) return failed(closed ? 'closed' : 'unavailable');
        const value = data(received, ['scope', 'expiresAt', 'isCurrent'], ['signal']), grantedScope = data(value.scope, Object.keys(scope));
        if (!Object.keys(scope).every(key => grantedScope[key] === scope[key as keyof NativeDiscoveryScope]) || !integer(value.expiresAt) ||
          value.expiresAt <= time() || value.expiresAt > at + NATIVE_DISCOVERY_LIMITS.grantMs || typeof value.isCurrent !== 'function' ||
          value.signal !== undefined && !(value.signal instanceof AbortSignal)) return failed('denied');
        if (closed || generation !== admission) return failed(closed ? 'closed' : 'unavailable');
        const grant = Object.freeze({ scope, expiresAt: value.expiresAt, isCurrent: value.isCurrent as () => boolean,
          ...(value.signal ? { signal: value.signal as AbortSignal } : {}) });
        const record: Attempt = { id: attempts, grant, abort: new AbortController(), wallExpiry: performance.now() + grant.expiresAt - time(),
          wallStartup: performance.now() + NATIVE_DISCOVERY_LIMITS.startupMs, reserved: false, ended: false, ready: false,
          eventsAt: at, events: 0, nextRow: 0, rows: new Map() };
        if (closed || generation !== admission) return failed(closed ? 'closed' : 'unavailable'); active = record; if (current(record) === undefined) return failed('denied');
        if (grant.signal) { const revoked = () => { if (live(record)) retire(record, 'stopped'); };
          grant.signal.addEventListener('abort', revoked, { once: true }); record.detach = () => grant.signal?.removeEventListener('abort', revoked); }
        if (current(record) === undefined) return failed('denied');
        phase = 'starting'; record.reserved = true; raw++; report('native-open');
        const operation = provider.open(scope, { event: event => ingest(record, event), closed() {
          if (record.ended) return; record.ended = true; if (record.reserved) { record.reserved = false; raw--; }
          if (active === record) retire(record, 'unavailable');
        } }, record.abort.signal);
        openReturned = true; const operationFields = data(operation, ['stop']);
        if (typeof operationFields.stop !== 'function') throw new Error('Invalid native operation');
        if (!live(record)) { operation.stop(); return failed(closed ? 'closed' : 'unavailable'); }
        record.operation = operation; if (current(record) === undefined) return failed('denied'); arm(); return Object.freeze({ ok: true, attempt: attempts });
      } catch { if (active) { const record = active; if (record.reserved && !openReturned) { record.reserved = false; raw--; } retire(record, 'unavailable'); }
        return failed(closed ? 'closed' : openReturned ? 'unavailable' : 'denied');
      } finally { busy = false; }
    },
    stop() { generation++; if (active) retire(active, 'stopped'); else if (busy && !closed) { phase = 'stopped'; report('stopped'); } }, sweep,
    snapshot() { return Object.freeze({ phase, rows: Object.freeze([...(active?.rows.values() ?? [])].map(row => Object.freeze({ handle: row.handle, service: row.service, candidate: row.candidate }))),
      rawReservations: raw, attempts, timerArmed: timer !== undefined, transitions: Object.freeze([...transitions]) }); },
    assess(handle) { const record = active, row = issued.get(handle); if (!record || !row || record.rows.get(row.key) !== row) return;
      const at = current(record); if (at === undefined || record.rows.get(row.key) !== row) return;
      if (at >= row.candidate.expiresAt) { record.rows.delete(row.key); return; }
      return assessDiscoveryCandidate(row.candidate, { kind: 'session', id: scope.sessionId }, at, (_candidate, evidence) =>
        live(record) && record.rows.get(row.key) === row && evidence.stage === 'observed' && evidence.receiptId === row.candidate.evidence[0]?.receiptId);
    }, close,
  };
  return Object.freeze(controller);
}
