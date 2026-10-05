import { parseDeviceDescriptor, schemasCompatible } from '@101/device-model';
import type { DeviceDescriptor } from '@101/device-model';
import { createRouteGroupController } from './route-group-runtime.ts';
import type { RouteGroupController } from './route-group-runtime.ts';
import type { AuthorizationRequest, Connection, DeviceRuntime, EndpointHandle, ResourceReference } from './types.ts';

export const INPUT_OWNERSHIP_PROFILE = 'application-input-ownership/1';
export const INPUT_OWNERSHIP_LIMITS = Object.freeze({ sources: 4, slots: 2, resources: 2, requestMs: 30000, listeners: 8, activationAttempts: 64 });
export interface InputOwnershipResource { readonly handle: EndpointHandle; readonly device: unknown; readonly capability: string }
export interface InputOwnershipSource {
  readonly id: string; readonly label: string; readonly principalId: string; readonly resources: readonly InputOwnershipResource[];
}
export interface InputOwnershipDestination { readonly label: string; readonly resources: readonly InputOwnershipResource[] }
export interface InputOwnershipOptions {
  readonly runtime: DeviceRuntime; readonly applicationId: string; readonly sessionId: string;
  readonly sources: readonly InputOwnershipSource[]; readonly destination: InputOwnershipDestination; readonly now: () => number;
}
export interface InputOwnershipRequest {
  readonly id: string; readonly sourceId: string; readonly slotId: string; readonly expectedOwnerEpoch: number; readonly expiresAt: number;
}
export interface InputOwnershipOwner { readonly sourceId: string; readonly principalId: string; readonly epoch: number }
export interface InputOwnershipSnapshot {
  readonly closed: boolean; readonly remainingActivationAttempts: number; readonly destination: string; readonly sources: readonly Readonly<{ id: string; label: string }>[];
  readonly slots: readonly Readonly<{ id: string; epoch: number; state: 'available' | 'owned' | 'requested' | 'failed' | 'closed';
    owner?: InputOwnershipOwner; request?: InputOwnershipRequest; outcome: 'ready' | 'requested' | 'declined' | 'cancelled' |
      'request-expired' | 'transferred' | 'released' | 'route-lost' | 'activation-failed' | 'closed' }>[];
}
export type InputOwnershipFailure = 'closed' | 'busy' | 'capacity' | 'invalid-source' | 'invalid-slot' | 'already-owner' | 'stale' | 'activation-failed';
export type InputOwnershipResult<T = undefined> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: InputOwnershipFailure }>;
export interface InputOwnershipController {
  request(sourceId: string, slotId: string): InputOwnershipResult<InputOwnershipRequest>;
  decide(requestId: string, expectedOwnerEpoch: number, allow: boolean): InputOwnershipResult;
  cancel(requestId: string): InputOwnershipResult;
  release(slotId: string, expectedOwnerEpoch: number): InputOwnershipResult;
  tick(): void; snapshot(): InputOwnershipSnapshot;
  /** Consent scope only. The existing runtime host callback must still issue a current grant. */
  isApproved(request: AuthorizationRequest): boolean;
  subscribe(listener: () => void): () => void;
  close(): void;
}
interface Resource { handle: EndpointHandle; device: Readonly<DeviceDescriptor>; capability: string; reference: ResourceReference }
interface Source { id: string; label: string; principalId: string; resources: readonly Resource[] }
interface RecordOwner {
  source: Source; owner: InputOwnershipOwner; group?: RouteGroupController; routes: Connection[]; remove: Array<() => void>; permitted: boolean;
}
interface Slot {
  id: string; partition?: string; epoch: number; record?: RecordOwner; pending?: InputOwnershipRequest;
  outcome: InputOwnershipSnapshot['slots'][number]['outcome'];
}
const ok = <T = undefined>(value: T = undefined as T): InputOwnershipResult<T> => Object.freeze({ ok: true, value });
const fail = (reason: InputOwnershipFailure): InputOwnershipResult<never> => Object.freeze({ ok: false, reason });
function text(input: unknown): string {
  if (typeof input !== 'string' || !input.length || input.length > 128 || input.trim() !== input ||
    [...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new TypeError('Invalid ownership identity');
  return input;
}
function resource(input: InputOwnershipResource): Resource {
  const device = parseDeviceDescriptor(input.device), capability = device.capabilities.find(item => item.id === input.capability);
  const property = Object.getOwnPropertyDescriptor(input.handle, 'id');
  if (!capability || !property || !('value' in property)) throw new TypeError('Invalid ownership resource');
  const id = text(property.value);
  return { handle: input.handle, device, capability: capability.id, reference: Object.freeze({ registrationId: id,
    deviceId: device.id, capabilityId: capability.id, descriptorRevision: device.revision, schemaVersion: capability.schemaVersion }) };
}
function resources(input: readonly InputOwnershipResource[]): readonly Resource[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > INPUT_OWNERSHIP_LIMITS.resources) throw new TypeError('Invalid ownership resource count');
  const values = input.map(resource);
  if (new Set(values.map(value => value.handle)).size !== values.length || new Set(values.map(value => `${value.device.id}:${value.capability}`)).size !== values.length)
    throw new TypeError('Duplicate ownership resource');
  return values;
}
function sameReference(actual: ResourceReference, expected: ResourceReference): boolean {
  return actual.registrationId === expected.registrationId && actual.deviceId === expected.deviceId && actual.capabilityId === expected.capabilityId &&
    actual.descriptorRevision === expected.descriptorRevision && actual.schemaVersion === expected.schemaVersion;
}

/** Host-owned local consent UI policy. Requests are inert, grants remain with the existing runtime. */
export function createInputOwnershipController(options: InputOwnershipOptions): InputOwnershipController {
  const runtime = options.runtime, now = options.now, applicationId = text(options.applicationId), sessionId = text(options.sessionId);
  const destination = text(options.destination.label), sinks = resources(options.destination.resources);
  if (typeof now !== 'function' || !Array.isArray(options.sources) || !options.sources.length || options.sources.length > INPUT_OWNERSHIP_LIMITS.sources)
    throw new TypeError('Invalid ownership options');
  const sources = new Map<string, Source>(), handles = new Set(sinks.map(value => value.handle)), devices = new Map<string, Readonly<DeviceDescriptor>>();
  for (const sink of sinks) devices.set(sink.device.id, sink.device);
  for (const input of options.sources) {
    const source: Source = { id: text(input.id), label: text(input.label), principalId: text(input.principalId), resources: resources(input.resources) };
    if (sources.has(source.id) || [...sources.values()].some(value => value.principalId === source.principalId) || source.resources.length !== sinks.length)
      throw new TypeError('Duplicate or incompatible ownership source');
    source.resources.forEach((entry, index) => {
      const sink = sinks[index]!, from = entry.device.capabilities.find(value => value.id === entry.capability)!, to = sink.device.capabilities.find(value => value.id === sink.capability)!;
      if (handles.has(entry.handle) || !from.permissions.includes('subscribe') || !schemasCompatible(from, to) || from.delivery.mode !== to.delivery.mode)
        throw new TypeError('Incompatible ownership source');
      handles.add(entry.handle);
      const previous = devices.get(entry.device.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry.device)) throw new TypeError('Conflicting ownership descriptor');
      devices.set(entry.device.id, entry.device);
    });
    sources.set(source.id, source);
  }
  const declarations = sinks.map(entry => {
    const capability = entry.device.capabilities.find(value => value.id === entry.capability)!;
    if (!capability.permissions.includes(capability.kind === 'command' || capability.kind === 'job' ? 'invoke' : 'write')) throw new TypeError('Invalid ownership sink');
    return capability.ownership ?? { mode: 'exclusive' as const };
  });
  const declaration = declarations[0]!;
  if (declaration.mode === 'observe' || declarations.some(value => JSON.stringify(value) !== JSON.stringify(declaration)))
    throw new TypeError('Ownership resources require matching exclusive or partition declarations');
  const partitions = declaration.mode === 'partitioned' ? declaration.partitions : undefined;
  if (partitions && partitions.length > INPUT_OWNERSHIP_LIMITS.slots) throw new TypeError('Too many ownership partitions');
  const slots: Slot[] = partitions ? partitions.map(id => ({ id, partition: id, epoch: 0, outcome: 'ready' })) : [{ id: 'exclusive', epoch: 0, outcome: 'ready' }];
  const listeners = new Set<() => void>(); let closed = false, busy = false, requestSequence = 0, attempts = 0, lastTime: number | undefined;
  function notify(): void { for (const listener of [...listeners]) try { listener(); } catch { /* UI observers cannot establish authority. */ } }
  function drop(slot: Slot, reason: string, outcome: Slot['outcome']): void {
    const record = slot.record; slot.record = undefined; slot.pending = undefined; slot.epoch++; slot.outcome = outcome;
    if (!record) return;
    record.permitted = false;
    for (const remove of record.remove.splice(0)) remove();
    record.group?.stop(reason);
    for (const route of record.routes) route.stop(reason);
  }
  function close(): void {
    if (closed) return; closed = true;
    for (const slot of slots) drop(slot, 'ownership-closed', 'closed'); notify(); listeners.clear();
  }
  function time(): number | undefined {
    if (closed) return;
    let value: number; try { value = now(); } catch { close(); return; }
    if (closed || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - INPUT_OWNERSHIP_LIMITS.requestMs || lastTime !== undefined && value < lastTime) { close(); return; }
    lastTime = value; return value;
  }
  function expire(at: number): void {
    for (const slot of slots) if (slot.pending && at >= slot.pending.expiresAt) { slot.pending = undefined; slot.outcome = 'request-expired'; }
  }
  function enter(): boolean { if (closed || busy) return false; busy = true; return true; }
  function lost(slot: Slot, record: RecordOwner): void {
    if (closed || slot.record !== record) return;
    const before = busy; busy = true;
    try { drop(slot, 'ownership-route-lost', 'route-lost'); notify(); } finally { busy = before; }
  }
  function isApproved(request: AuthorizationRequest): boolean {
    if (closed || request.applicationId !== applicationId || request.sessionId !== sessionId || request.sourceOperation !== 'subscribe') return false;
    return slots.some(slot => {
      const record = slot.record;
      if (!record?.permitted || request.principalId !== record.source.principalId || request.partition !== slot.partition) return false;
      return record.source.resources.some((source, index) => {
        const sink = sinks[index]!, capability = sink.device.capabilities.find(value => value.id === sink.capability)!;
        return sameReference(request.source, source.reference) && sameReference(request.sink, sink.reference) &&
          request.sinkOperation === (capability.kind === 'command' || capability.kind === 'job' ? 'invoke' : 'write');
      });
    });
  }
  function snapshot(): InputOwnershipSnapshot {
    return Object.freeze({ closed, remainingActivationAttempts: INPUT_OWNERSHIP_LIMITS.activationAttempts - attempts, destination,
      sources: Object.freeze([...sources.values()].map(source => Object.freeze({ id: source.id, label: source.label }))),
      slots: Object.freeze(slots.map(slot => Object.freeze({ id: slot.id, epoch: slot.epoch,
        state: closed ? 'closed' as const : slot.pending ? 'requested' as const : slot.record?.group?.status().state === 'active' ? 'owned' as const :
          slot.outcome === 'activation-failed' || slot.outcome === 'route-lost' ? 'failed' as const : 'available' as const,
        ...(slot.record?.group?.status().state === 'active' ? { owner: slot.record.owner } : {}), ...(slot.pending ? { request: slot.pending } : {}), outcome: slot.outcome }))) });
  }
  return Object.freeze({ isApproved, snapshot, close,
    request(sourceId: string, slotId: string): InputOwnershipResult<InputOwnershipRequest> {
      if (!enter()) return fail(closed ? 'closed' : 'busy');
      try {
        const at = time(); if (at === undefined) return fail('closed'); expire(at);
        const source = sources.get(sourceId), slot = slots.find(value => value.id === slotId);
        if (!source) return fail('invalid-source'); if (!slot) return fail('invalid-slot');
        if (slot.pending) return fail('busy'); if (slot.record?.source.id === sourceId) return fail('already-owner');
        if (attempts >= INPUT_OWNERSHIP_LIMITS.activationAttempts) return fail('capacity');
        const pending = Object.freeze({ id: `request-${++requestSequence}`, sourceId, slotId, expectedOwnerEpoch: slot.epoch, expiresAt: at + INPUT_OWNERSHIP_LIMITS.requestMs });
        slot.pending = pending; slot.outcome = 'requested'; notify();
        return closed || slot.pending !== pending ? fail('closed') : ok(pending);
      } finally { busy = false; }
    },
    decide(requestId: string, expectedOwnerEpoch: number, allow: boolean): InputOwnershipResult {
      if (!enter()) return fail(closed ? 'closed' : 'busy');
      try {
        const at = time(); if (at === undefined) return fail('closed'); expire(at);
        const slot = slots.find(value => value.pending?.id === requestId), pending = slot?.pending;
        if (!slot || !pending || typeof allow !== 'boolean' || slot.epoch !== expectedOwnerEpoch || pending.expectedOwnerEpoch !== expectedOwnerEpoch) return fail('stale');
        slot.pending = undefined;
        if (!allow) { slot.outcome = 'declined'; notify(); return ok(); }
        if (attempts >= INPUT_OWNERSHIP_LIMITS.activationAttempts) { slot.outcome = 'cancelled'; notify(); return fail('capacity'); }
        attempts++;
        drop(slot, 'ownership-transferred', 'transferred'); notify(); if (closed) return fail('closed');
        const source = sources.get(pending.sourceId)!;
        const record: RecordOwner = { source, owner: Object.freeze({ sourceId: source.id, principalId: source.principalId, epoch: slot.epoch }),
          routes: [], remove: [], permitted: true }; slot.record = record;
        try {
          record.group = createRouteGroupController({ schemaVersion: 1, id: 'app:input-ownership', failure: { required: 'stop-all', optional: 'stop-all' },
            members: source.resources.map((entry, index) => {
              const sink = sinks[index]!, capability = sink.device.capabilities.find(value => value.id === sink.capability)!;
              return { id: `input-${index}`, required: true, from: { deviceId: entry.device.id, capability: entry.capability, operation: 'subscribe' },
                to: { deviceId: sink.device.id, capability: sink.capability, operation: capability.kind === 'command' || capability.kind === 'job' ? 'invoke' : 'write' },
                startAfter: [], consent: { purpose: 'Selected local application input', sourceOwner: 'required', sinkOwner: 'required' },
                compensation: { prepared: 'release-grant', active: 'stop-route', physicalEffects: 'not-undone' }, safeState: { mode: 'provider-release' } };
            }) }, [...devices.values()], member => {
            const index = Number(member.id.slice(6)), route = runtime.route({ from: source.resources[index]!.handle, to: sinks[index]!.handle,
              principalId: source.principalId, applicationId, sessionId, ...(slot.partition === undefined ? {} : { partition: slot.partition }), queueCapacity: 4 });
            record.routes.push(route); return route;
          });
          const result = record.group.start();
          if (!result.ok || closed || slot.record !== record) throw new Error('Activation unavailable');
          for (const route of record.routes) record.remove.push(route.onClose(() => lost(slot, record)));
          if (closed || slot.record !== record || record.group.status().state !== 'active') throw new Error('Activation lost');
          notify(); return closed || slot.record !== record ? fail('closed') : ok();
        } catch {
          if (slot.record === record) drop(slot, 'ownership-activation-failed', 'activation-failed');
          else { record.permitted = false; record.group?.stop(); for (const route of record.routes) route.stop(); }
          notify(); return fail(closed ? 'closed' : 'activation-failed');
        }
      } finally { busy = false; }
    },
    cancel(requestId: string): InputOwnershipResult {
      if (!enter()) return fail(closed ? 'closed' : 'busy');
      try {
        const slot = slots.find(value => value.pending?.id === requestId); if (!slot) return fail('stale');
        slot.pending = undefined; slot.outcome = 'cancelled'; notify(); return ok();
      } finally { busy = false; }
    },
    release(slotId: string, expectedOwnerEpoch: number): InputOwnershipResult {
      if (!enter()) return fail(closed ? 'closed' : 'busy');
      try {
        const slot = slots.find(value => value.id === slotId); if (!slot) return fail('invalid-slot');
        if (!slot.record || slot.epoch !== expectedOwnerEpoch) return fail('stale');
        drop(slot, 'ownership-released', 'released'); notify(); return ok();
      } finally { busy = false; }
    },
    tick(): void {
      if (!enter()) return;
      try {
        const at = time(); if (at === undefined) return; expire(at);
        for (const slot of slots) {
          const record = slot.record; if (!record) continue;
          for (const route of record.routes) if (!route.renew(record.source.principalId).ok) { lost(slot, record); break; }
        }
        notify();
      } finally { busy = false; }
    },
    subscribe(listener: () => void): () => void {
      if (closed || typeof listener !== 'function' || listeners.size >= INPUT_OWNERSHIP_LIMITS.listeners) throw new TypeError('Ownership listener unavailable');
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  });
}
