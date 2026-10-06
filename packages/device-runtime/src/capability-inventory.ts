import { parseDeviceDescriptor, snapshotJson } from '@101/device-model';
import type { DeviceCapability, DeviceDescriptor, JsonObject } from '@101/device-model';
import type { AuthorizationRequest, Connection, DeliveryContext, DeviceRuntime, EndpointHandle, Observation, ResourceReference } from './types.ts';

export const CAPABILITY_INVENTORY_LIMITS = Object.freeze({ resources: 16, selections: 16, attempts: 64, probeMs: 30000,
  maxAgeMs: 30000, provenanceBytes: 2048, queueCapacity: 1 });
export interface CapabilityInventoryResource {
  readonly id: string; readonly sourceHandle?: EndpointHandle; readonly device: unknown; readonly capability: string;
}
export interface CapabilityInventorySelection { readonly id: string; readonly operation: 'read' | 'subscribe' }
export interface CapabilityInventoryScope { readonly principalId: string; readonly applicationId: string; readonly sessionId: string }
export interface CapabilityInventoryOptions {
  /** Borrowed host runtime and registrations; the host must separately grant routes. */
  readonly runtime: DeviceRuntime; readonly scope: CapabilityInventoryScope;
  readonly resources: readonly CapabilityInventoryResource[]; readonly selected: readonly CapabilityInventorySelection[];
  /** Same monotonic domain as runtime observations. Foreign producer clocks remain provenance. */
  readonly clockDomain: string; readonly now: () => number;
  readonly probeMs?: number; readonly maxAgeMs?: number;
}
export interface CapabilityInventoryProof {
  readonly source: ResourceReference; readonly sequence: number; readonly timestamp: number; readonly receivedAt: number;
  readonly clockDomain: string; readonly quality: 'valid'; readonly provenance?: JsonObject;
  readonly qualifiedAt: number; readonly ageAtQualificationMs: number; readonly expiresAt: number;
}
export type CapabilityInventoryReason = 'not-started' | 'unknown-resource' | 'unsupported-operation' | 'missing-provider' |
  'waiting-for-data' | 'access-denied' | 'route-unavailable' | 'route-lost' | 'probe-expired' | 'stopped' | 'closed' | 'observed';
export interface CapabilityInventoryRow extends CapabilityInventorySelection {
  readonly semantic?: string; readonly state: 'supported' | 'unsupported' | 'unavailable' | 'expired';
  readonly reason: CapabilityInventoryReason; readonly proof?: CapabilityInventoryProof;
}
export interface CapabilityInventorySnapshot {
  readonly closed: boolean; readonly remainingAttempts: number; readonly activeRoutes: number;
  readonly timerArmed: boolean; readonly rows: readonly CapabilityInventoryRow[];
}
export type CapabilityInventoryResult = Readonly<{ ok: true; value: Readonly<{ attempt: number; admitted: number }> }> |
  Readonly<{ ok: false; reason: 'closed' | 'busy' | 'capacity' | 'stale' }>;
export interface CapabilityInventoryController {
  start(): CapabilityInventoryResult;
  /** Pure exact scope matching for the host's authorize callback. This does not grant a route. */
  matches(request: AuthorizationRequest): boolean;
  sweep(): void; stop(): void; snapshot(): CapabilityInventorySnapshot; close(): void;
}
interface Resource { handle?: EndpointHandle; device: Readonly<DeviceDescriptor>; capability: DeviceCapability; reference?: ResourceReference }
interface Attempt { epoch: number; startedAt: number; deadline: number; permitted: boolean; route?: Connection;
  remove?: () => void; completedRead: boolean; limits?: Readonly<{ maxAgeMs: number; expiresAt: number }> }
interface Row { selection: CapabilityInventorySelection; resource?: Resource; sink?: EndpointHandle; sinkReference?: ResourceReference;
  state: CapabilityInventoryRow['state']; reason: CapabilityInventoryReason; proof?: CapabilityInventoryProof; attempt?: Attempt }
function text(input: unknown): string {
  if (typeof input !== 'string' || !input.length || input.length > 128 || input.trim() !== input ||
    [...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new TypeError('Invalid inventory identity');
  return input;
}
function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid inventory resource');
  const property = Object.getOwnPropertyDescriptor(input, key);
  if (property && !('value' in property)) throw new TypeError('Invalid inventory accessor');
  return property?.value;
}
function bound(input: number | undefined, fallback: number, maximum: number): number {
  const value = input ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid inventory limit');
  return value;
}
function same(actual: ResourceReference, expected: ResourceReference): boolean {
  return actual.registrationId === expected.registrationId && actual.deviceId === expected.deviceId && actual.capabilityId === expected.capabilityId &&
    actual.descriptorRevision === expected.descriptorRevision && actual.schemaVersion === expected.schemaVersion;
}

/** Local read/subscribe qualification through actual SDK delivery. Declarations and
 * proof metadata are inert. Synchronous runtime/clock code is trusted host code,
 * not a sandbox. A completed read reports one fresh observation, not a continuing
 * availability promise. Borrowed producers remain caller-owned. */
export function createCapabilityInventory(options: CapabilityInventoryOptions): CapabilityInventoryController {
  const runtime = options.runtime, now = options.now, clockDomain = text(options.clockDomain);
  const scope = snapshotJson(options.scope) as unknown as CapabilityInventoryScope;
  if (Object.keys(scope).some(key => !['principalId', 'applicationId', 'sessionId'].includes(key))) throw new TypeError('Invalid inventory scope');
  for (const value of [scope.principalId, scope.applicationId, scope.sessionId]) text(value);
  if (typeof now !== 'function' || runtime.clockDomain !== clockDomain) throw new TypeError('Invalid inventory clock');
  const probeMs = bound(options.probeMs, 1000, CAPABILITY_INVENTORY_LIMITS.probeMs);
  const maxAgeMs = bound(options.maxAgeMs, 1000, CAPABILITY_INVENTORY_LIMITS.maxAgeMs);
  if (!Array.isArray(options.resources) || options.resources.length > CAPABILITY_INVENTORY_LIMITS.resources ||
    !Array.isArray(options.selected) || !options.selected.length || options.selected.length > CAPABILITY_INVENTORY_LIMITS.selections)
    throw new TypeError('Invalid inventory count');
  const resources = new Map<string, Resource>();
  for (const input of options.resources) {
    const id = text(field(input, 'id')), device = parseDeviceDescriptor(field(input, 'device'));
    const capabilityId = text(field(input, 'capability')), capability = device.capabilities.find(item => item.id === capabilityId);
    const handle = field(input, 'sourceHandle') as EndpointHandle | undefined;
    if (!capability || resources.has(id)) throw new TypeError('Invalid inventory declaration');
    const registrationId = handle === undefined ? undefined : text(field(handle, 'id'));
    resources.set(id, { device, capability, ...(handle ? { handle, reference: Object.freeze({ registrationId: registrationId!,
      deviceId: device.id, capabilityId, descriptorRevision: device.revision, schemaVersion: capability.schemaVersion }) } : {}) });
  }
  const selected = snapshotJson(options.selected) as unknown as readonly CapabilityInventorySelection[];
  const keys = new Set<string>();
  const rows: Row[] = selected.map(selection => {
    const id = text(selection.id);
    if (Object.keys(selection).some(key => !['id', 'operation'].includes(key)) || !['read', 'subscribe'].includes(selection.operation) || keys.has(`${id}:${selection.operation}`))
      throw new TypeError('Invalid inventory selection');
    keys.add(`${id}:${selection.operation}`); const resource = resources.get(id);
    const unsupported = resource && (!resource.capability.permissions.includes(selection.operation) ||
      ['command', 'job'].includes(resource.capability.kind) || selection.operation === 'read' &&
      (resource.capability.kind !== 'property' || resource.capability.delivery.mode !== 'latest'));
    return { selection, resource, state: !resource || unsupported ? 'unsupported' : 'unavailable',
      reason: !resource ? 'unknown-resource' : unsupported ? 'unsupported-operation' : !resource.handle ? 'missing-provider' : 'not-started' };
  });
  let closed = false, busy = false, attempts = 0, epoch = 0, lastTime = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function current(row: Row, record: Attempt): boolean { return !closed && row.attempt === record && record.epoch === epoch; }
  function clearTimer(): void { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function drop(row: Row, state: Row['state'], reason: CapabilityInventoryReason): void {
    const record = row.attempt; row.attempt = undefined; row.proof = undefined;
    if (row.state !== 'unsupported') { row.state = state; row.reason = reason; }
    if (!record) return;
    record.permitted = false; const remove = record.remove; record.remove = undefined;
    const route = record.route; record.route = undefined; remove?.(); route?.stop('inventory-retired');
  }
  function close(): void {
    if (closed) return; closed = true; epoch++; clearTimer();
    for (const row of rows) {
      drop(row, 'unavailable', 'closed'); const sink = row.sink; row.sink = undefined; row.sinkReference = undefined;
      if (sink) runtime.unregister(sink);
    }
  }
  function time(): number | undefined {
    if (closed) return;
    let at: number; try { at = now(); } catch { close(); return; }
    if (closed) return;
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - CAPABILITY_INVENTORY_LIMITS.probeMs || at < lastTime) { close(); return; }
    lastTime = at; return at;
  }
  function arm(at: number): void {
    clearTimer(); if (closed) return;
    let deadline = Infinity;
    for (const row of rows) if (row.attempt) deadline = Math.min(deadline, row.proof?.expiresAt ?? row.attempt.deadline);
    if (Number.isFinite(deadline)) timer = setTimeout(() => { timer = undefined; sweep(); }, Math.max(1, deadline - at));
  }
  function lost(row: Row, record: Attempt, reason: string): void {
    if (!current(row, record)) return;
    if (reason === 'read-complete' && row.selection.operation === 'read' && row.proof) {
      record.completedRead = true; record.permitted = false; const remove = record.remove; record.remove = undefined;
      record.route = undefined; remove?.(); return;
    }
    drop(row, ['expired', 'stale'].includes(reason) ? 'expired' : 'unavailable',
      ['expired', 'stale'].includes(reason) ? 'probe-expired' : 'route-lost');
    const at = time(); if (at !== undefined) arm(at);
  }
  function delivered(row: Row, observation: Observation, context: DeliveryContext): void {
    const record = row.attempt; if (!record || !current(row, record) || !record.route) return;
    const expected = row.resource!.reference!, actual = observation.source;
    if (actual.registrationId !== expected.registrationId || actual.deviceId !== expected.deviceId || actual.capabilityId !== expected.capabilityId ||
      observation.clockDomain !== clockDomain || observation.quality !== 'valid') return;
    const valid = context.isCurrent(); if (!current(row, record) || !valid || context.signal.aborted) return;
    const limits = record.route.limits(); if (!current(row, record) || !limits) return;
    const at = time(); if (!current(row, record) || at === undefined) return;
    if (!Number.isFinite(observation.timestamp) || !Number.isFinite(observation.receivedAt) || observation.timestamp < 0 ||
      observation.timestamp > observation.receivedAt || observation.receivedAt > at ||
      row.selection.operation === 'subscribe' && observation.receivedAt <= record.startedAt) return;
    const expiresAt = Math.min(record.deadline, limits.expiresAt, observation.timestamp + Math.min(limits.maxAgeMs, maxAgeMs));
    if (at >= expiresAt) { drop(row, 'expired', 'probe-expired'); arm(at); return; }
    let provenance: JsonObject | undefined;
    if (observation.provenance !== undefined) {
      const copy = snapshotJson(observation.provenance) as JsonObject;
      if (new TextEncoder().encode(JSON.stringify(copy)).byteLength > CAPABILITY_INVENTORY_LIMITS.provenanceBytes) return;
      provenance = copy;
    }
    // Host clock/route callbacks above may synchronously retire this attempt.
    if (!current(row, record) || context.signal.aborted) return;
    record.limits = limits;
    row.proof = Object.freeze({ source: expected, sequence: observation.sequence, timestamp: observation.timestamp,
      receivedAt: observation.receivedAt, clockDomain, quality: observation.quality, ...(provenance ? { provenance } : {}), qualifiedAt: at,
      ageAtQualificationMs: at - observation.timestamp, expiresAt }); row.state = 'supported'; row.reason = 'observed'; arm(at);
  }
  function makeSink(row: Row, index: number, record: Attempt): boolean {
    if (row.sink) return true;
    const capability = row.resource!.capability, id = `probe-${index}`;
    const descriptor = parseDeviceDescriptor({ schemaVersion: 1, id: 'capability-inventory', label: 'Local selected resource probe', revision: 1,
      adapter: { id: 'oneohone:capability-inventory', version: '1.0.0' }, runtime: { platform: 'embedded' },
      capabilities: [{ id, semantic: capability.semantic, schemaVersion: capability.schemaVersion, kind: capability.kind,
        value: capability.value, delivery: capability.delivery, permissions: ['write'], ownership: { mode: 'observe' } }] });
    const sink = runtime.registerSink({ device: descriptor, capability: id, apply: (observation, context) => delivered(row, observation, context), release() {} });
    if (!current(row, record)) { runtime.unregister(sink); return false; }
    row.sink = sink; row.sinkReference = Object.freeze({ registrationId: sink.id, deviceId: descriptor.id, capabilityId: id,
      descriptorRevision: descriptor.revision, schemaVersion: capability.schemaVersion });
    const readiness = runtime.setReadiness(sink, 'available');
    return current(row, record) && readiness.ok;
  }
  function matches(request: AuthorizationRequest): boolean {
    if (closed || request.principalId !== scope.principalId || request.applicationId !== scope.applicationId || request.sessionId !== scope.sessionId ||
      request.sinkOperation !== 'write' || request.partition !== undefined) return false;
    return rows.some(row => row.attempt?.permitted && row.attempt.epoch === epoch && row.resource?.reference && row.sinkReference &&
      request.sourceOperation === row.selection.operation && same(request.source, row.resource.reference) && same(request.sink, row.sinkReference));
  }
  function start(): CapabilityInventoryResult {
    if (closed) return Object.freeze({ ok: false, reason: 'closed' });
    if (busy) return Object.freeze({ ok: false, reason: 'busy' });
    if (attempts >= CAPABILITY_INVENTORY_LIMITS.attempts) return Object.freeze({ ok: false, reason: 'capacity' });
    busy = true; const attempt = ++attempts, generation = ++epoch; clearTimer();
    try {
      for (const row of rows) drop(row, 'unavailable', row.resource?.handle ? 'not-started' : 'missing-provider');
      const at = time(); if (at === undefined || generation !== epoch) return Object.freeze({ ok: false, reason: 'stale' });
      let admitted = 0;
      for (const [index, row] of rows.entries()) {
        if (closed || generation !== epoch) return Object.freeze({ ok: false, reason: 'stale' });
        if (row.state === 'unsupported' || !row.resource?.handle) continue;
        const record: Attempt = { epoch: generation, startedAt: at, deadline: at + probeMs, permitted: true, completedRead: false };
        row.attempt = record; row.state = 'unavailable'; row.reason = 'waiting-for-data';
        try {
          if (!makeSink(row, index, record)) { if (current(row, record)) drop(row, 'unavailable', 'route-unavailable'); continue; }
          const route = runtime.route({ from: row.resource.handle, to: row.sink!, ...scope, sourceOperation: row.selection.operation,
            leaseMs: probeMs, queueCapacity: CAPABILITY_INVENTORY_LIMITS.queueCapacity,
            constraints: { expiresAt: record.deadline, maxAgeMs } });
          if (!current(row, record)) { route.stop('inventory-retired'); continue; }
          record.route = route;
          const remove = route.onClose(reason => lost(row, record, reason));
          if (!current(row, record)) { remove(); route.stop('inventory-retired'); continue; }
          record.remove = remove; const result = route.start();
          if (!current(row, record)) { route.stop('inventory-retired'); continue; }
          if (!result.ok) { drop(row, result.reason === 'stale' ? 'expired' : 'unavailable',
            result.reason === 'denied' ? 'access-denied' : result.reason === 'stale' ? 'probe-expired' : 'route-unavailable'); continue; }
          const limits = route.limits(); if (!current(row, record) || !limits) continue;
          record.limits = limits; record.deadline = Math.min(record.deadline, limits.expiresAt); admitted++;
        } catch { if (current(row, record)) drop(row, 'unavailable', 'route-unavailable'); }
      }
      const after = time(); if (after === undefined || generation !== epoch) return Object.freeze({ ok: false, reason: 'stale' });
      arm(after); return Object.freeze({ ok: true, value: Object.freeze({ attempt, admitted }) });
    } finally { busy = false; }
  }
  function sweep(): void {
    if (closed || busy) return;
    busy = true;
    try {
      const at = time(); if (at === undefined) return;
      for (const row of rows) {
        const record = row.attempt; if (!record) continue;
        if (at >= (row.proof?.expiresAt ?? record.deadline)) { drop(row, 'expired', 'probe-expired'); continue; }
        if (!record.completedRead) {
          const limits = record.route?.limits(); if (!current(row, record)) continue;
          if (!limits) drop(row, 'unavailable', 'route-lost');
        }
      }
      if (!closed) arm(at);
    } finally { busy = false; }
  }
  function stop(): void { if (closed) return; epoch++; clearTimer(); for (const row of rows) drop(row, 'unavailable', 'stopped'); }
  function snapshot(): CapabilityInventorySnapshot {
    return Object.freeze({ closed, remainingAttempts: CAPABILITY_INVENTORY_LIMITS.attempts - attempts,
      activeRoutes: rows.filter(row => row.attempt?.route).length, timerArmed: timer !== undefined,
      rows: Object.freeze(rows.map(row => Object.freeze({ ...row.selection, ...(row.resource ? { semantic: row.resource.capability.semantic } : {}),
        state: row.state, reason: row.reason, ...(row.proof ? { proof: row.proof } : {}) }))) });
  }
  return Object.freeze({ start, matches, sweep, stop, snapshot, close });
}
