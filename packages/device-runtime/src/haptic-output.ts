import { getHapticOutputProfile, HAPTIC_OUTPUT_LIMITS, parseDeviceDescriptor } from '@101/device-model';
import type { HapticPreset, HapticProfileId } from '@101/device-model';
import type { DeliveryContext, DeviceRuntime, EndpointHandle } from './types.ts';

export type HapticBackendOutcome = 'api-returned' | 'unavailable' | 'busy' | 'cancelled';
export type HapticOutcome = HapticBackendOutcome | 'api-rejected' | 'rate-limited' | 'expired';
/** Trusted port. Synchronous busy/unavailable/cancelled declines dispatch; a Promise denotes an issued API attempt. */
export interface HapticBackend {
  readonly profileId: HapticProfileId;
  readonly supported: boolean;
  invoke(preset: HapticPreset): HapticBackendOutcome | Promise<HapticBackendOutcome>;
  cancel?(): void;
}
export interface HapticOutputEvidence {
  readonly operationId: string; readonly routeId: string; readonly preset: HapticPreset;
  readonly outcome: HapticOutcome; readonly effect: 'none' | 'dispatched'; readonly physical: 'unverified';
}
export interface HapticOutputOptions {
  readonly runtime: DeviceRuntime; readonly deviceId: string; readonly label?: string;
  readonly backend: HapticBackend; readonly now: () => number;
}
export interface HapticOutputController {
  readonly endpoint: EndpointHandle;
  setAvailable(available: boolean): void;
  records(): readonly HapticOutputEvidence[];
  close(): void;
}
type Row = { -readonly [K in keyof HapticOutputEvidence]: HapticOutputEvidence[K] };
interface Pending { readonly routeId: string; readonly context: DeliveryContext; readonly row: Row;
  finished: boolean; timer?: ReturnType<typeof setTimeout>; finish(outcome: HapticOutcome): void }

/** Register an initially unavailable command sink. Only the existing runtime can grant a route. */
export function createHapticOutputController(options: HapticOutputOptions): HapticOutputController {
  const { runtime, deviceId, now } = options;
  if (typeof now !== 'function') throw new TypeError('A current monotonic clock is required');
  const fields = Object.getOwnPropertyDescriptors(options.backend);
  for (const key of ['profileId', 'supported', 'invoke']) if (!fields[key] || !Object.hasOwn(fields[key]!, 'value')) throw new TypeError('Invalid haptic backend');
  if (fields.cancel && !Object.hasOwn(fields.cancel, 'value')) throw new TypeError('Invalid haptic backend');
  const profile = getHapticOutputProfile(fields.profileId!.value as string), supported = fields.supported!.value;
  const invoke = fields.invoke!.value as HapticBackend['invoke'], cancel = fields.cancel?.value as HapticBackend['cancel'];
  if (typeof supported !== 'boolean' || typeof invoke !== 'function' || cancel !== undefined && typeof cancel !== 'function') throw new TypeError('Invalid haptic backend');
  const backend = options.backend;
  // The initial trusted clock can retire this controller before its endpoint is registered.
  let endpoint: EndpointHandle | undefined; // eslint-disable-line prefer-const
  let closed = false, available = false, busy = false, epoch = 0;
  let previous = -1, lastDispatch = -Infinity, ownedRoute: string | undefined, pending: Pending | undefined;
  const rows: Row[] = [];
  function retire(outcome: 'cancelled' | 'expired') { epoch++; pending?.finish(outcome); }
  function stopApi() { if (ownedRoute === undefined) return; ownedRoute = undefined; try { cancel?.call(backend); } catch { /* A stop request cannot prove physical cancellation. */ } }
  function close() {
    if (closed) return;
    closed = true; available = false; retire('cancelled'); stopApi();
    if (endpoint) runtime.unregister(endpoint);
  }
  function time(): number | undefined {
    let value: number;
    try { value = now(); } catch { close(); return undefined; }
    if (closed) return undefined;
    if (!Number.isFinite(value) || value < 0 || value < previous || value > Number.MAX_SAFE_INTEGER) { close(); return undefined; }
    previous = value; return value;
  }
  function current(context: DeliveryContext): boolean {
    if (closed || !available || context.signal.aborted) return false;
    let valid = false; try { valid = context.isCurrent(); } catch { /* Current authority is required. */ }
    return valid && !closed && available && !context.signal.aborted;
  }
  function retain(row: Row) { rows.push(row); if (rows.length > HAPTIC_OUTPUT_LIMITS.maxRecords) rows.shift(); }
  if (time() === undefined) throw new TypeError('Invalid haptic clock');
  const device = parseDeviceDescriptor({ schemaVersion: 1, id: deviceId, label: options.label ?? 'Haptic presets', revision: 1,
    adapter: { id: profile.id, version: '1' }, runtime: { platform: 'host-platform-port' }, capabilities: [profile.capability] });
  endpoint = runtime.registerSink({ device, capability: 'preset',
    async apply(observation, context) {
      const preset = observation.value;
      if (!context.operationId || preset !== 'tap' && preset !== 'impact' && preset !== 'warning') throw new TypeError('Invalid haptic command');
      if (!current(context)) return;
      const row: Row = { operationId: context.operationId, routeId: context.routeId, preset, outcome: 'cancelled', effect: 'none', physical: 'unverified' };
      retain(row);
      if (busy) { row.outcome = 'busy'; return; }
      busy = true; // Reserve before any clock/currentness/platform callback can reenter.
      const started = time();
      if (started === undefined || !current(context)) { busy = false; return; }
      if (started < observation.timestamp || started - observation.timestamp >= HAPTIC_OUTPUT_LIMITS.maxAgeMs) { busy = false; row.outcome = 'expired'; return; }
      if (started - lastDispatch < 1000 / HAPTIC_OUTPUT_LIMITS.maxHz) { busy = false; row.outcome = 'rate-limited'; return; }
      const dispatchAt = started;
      const generation = epoch;
      let resolve!: (outcome: HapticOutcome) => void;
      const result = new Promise<HapticOutcome>(done => { resolve = done; });
      const entry: Pending = { context, row, routeId: context.routeId, finished: false,
        finish(outcome) {
          if (entry.finished) return;
          entry.finished = true; row.outcome = outcome;
          if (entry.timer !== undefined) clearTimeout(entry.timer);
          context.signal.removeEventListener('abort', aborted);
          if (pending === entry) pending = undefined;
          resolve(outcome);
        } };
      const aborted = () => entry.finish('cancelled');
      pending = entry; context.signal.addEventListener('abort', aborted, { once: true });
      const timer = setTimeout(() => entry.finish('expired'), HAPTIC_OUTPUT_LIMITS.maxAgeMs - (started - observation.timestamp));
      if (entry.finished || closed || generation !== epoch) clearTimeout(timer); else entry.timer = timer;
      if (!current(context) || entry.finished || generation !== epoch) { entry.finish('cancelled'); busy = false; return; }
      function complete(outcome: HapticOutcome) {
        busy = false;
        if (entry.finished) return;
        const finishedAt = time();
        if (entry.finished) return;
        if (finishedAt === undefined || generation !== epoch || !current(context)) { entry.finish('cancelled'); return; }
        if (entry.finished) return;
        if (finishedAt - observation.timestamp >= HAPTIC_OUTPUT_LIMITS.maxAgeMs) { entry.finish('expired'); return; }
        entry.finish(outcome);
        if (outcome === 'unavailable') { available = false; runtime.setReadiness(endpoint!, 'unavailable'); }
      }
      let dispatched = false;
      function recordDispatch() {
        if (dispatched) return;
        dispatched = true; lastDispatch = dispatchAt; ownedRoute = context.routeId;
        row.effect = 'dispatched'; context.reportEvidence('dispatched');
        // Invoke is a trusted synchronous callout. Retirement may precede its
        // returned Promise; classify the issued attempt first, then request stop.
        // Clear ownedRoute before cancel so reentrant release/close cannot repeat it.
        if (entry.finished || closed || generation !== epoch || !current(context)) stopApi();
      }
      try {
        const returned = invoke.call(backend, preset);
        if (returned === 'busy' || returned === 'unavailable' || returned === 'cancelled') complete(returned);
        else {
          recordDispatch();
          Promise.resolve(returned).then(value => complete(['api-returned', 'unavailable', 'busy', 'cancelled'].includes(value) ? value : 'api-rejected'), () => complete('api-rejected'));
        }
      } catch {
        recordDispatch();
        complete('api-rejected');
      }
      const outcome = await result;
      if (outcome === 'api-rejected') throw new Error('Haptic API rejected the request');
    },
    release(_reason, context) { if (pending?.routeId === context.routeId) retire('cancelled'); if (ownedRoute === context.routeId) stopApi(); },
  });
  return Object.freeze({ endpoint,
    setAvailable(value: boolean) {
      if (typeof value !== 'boolean') throw new TypeError('Invalid availability');
      if (closed) return;
      available = value && supported;
      if (!available) { retire('cancelled'); stopApi(); }
      runtime.setReadiness(endpoint!, available ? 'available' : 'unavailable');
    },
    records: () => Object.freeze(rows.map(row => Object.freeze({ ...row }))), close,
  });
}

/** Uses the actual browser boolean result. Missing APIs have no hidden switch or timer fallback. */
export function createBrowserHapticBackend(port: { vibrate(pattern: number | number[]): boolean } | undefined): HapticBackend {
  const vibrate = port?.vibrate;
  const supported = typeof vibrate === 'function';
  const profile = getHapticOutputProfile('app:browser-haptic-presets/1');
  return Object.freeze({ profileId: profile.id, supported,
    invoke(preset: HapticPreset): HapticBackendOutcome {
      const pattern = profile.requestedPatterns?.[preset];
      if (!supported || !pattern) return 'unavailable';
      return vibrate.call(port, [...pattern]) === true ? 'api-returned' : 'unavailable';
    },
    cancel() { if (supported) vibrate.call(port, 0); },
  });
}
