import { parseDeviceDescriptor, schemasCompatible } from '@101/device-model';
import type { DeviceCapability } from '@101/device-model';
import type { AuthorizationRequest, Connection, DeliveryContext, DeviceRuntime, EndpointHandle, ResourceReference, RouteGrant } from './types.ts';

export const OUTPUT_SHARING_PROFILE = 'output-sharing-policy/1' as const;
export const OUTPUT_SHARING_LIMITS = Object.freeze({ sources: 8, destinations: 4, slots: 2, routes: 8, attempts: 64,
  changes: 32, authorizations: 64, effects: 128, rawPending: 2, lifetimeMs: 30000, leaseMs: 1000, maxHz: 30, maxAgeMs: 250, planBytes: 32768 });
export type OutputSharingKind = 'audio' | 'camera' | 'application';
export interface OutputSharingInput { readonly slotId: 'a' | 'b'; readonly sourceId: string; readonly principalId: string }
export type OutputSharingPolicy =
  | Readonly<{ kind: 'audio'; mode: 'mix' | 'exclusive'; inputs: readonly OutputSharingInput[] }>
  | Readonly<{ kind: 'audio'; mode: 'duck'; foreground: 'a' | 'b'; inputs: readonly OutputSharingInput[] }>
  | Readonly<{ kind: 'camera'; mode: 'observers'; inputs: readonly OutputSharingInput[] }>
  | Readonly<{ kind: 'application'; mode: 'layers' | 'regions'; inputs: readonly OutputSharingInput[] }>;
export interface OutputSharingSource { readonly id: string; readonly ownerId: string; readonly handle: EndpointHandle; readonly device: unknown; readonly capability: string }
export interface OutputSharingSlot { readonly id: 'a' | 'b'; readonly handle: EndpointHandle; readonly device: unknown; readonly capability: string }
export interface OutputSharingDestination { readonly id: string; readonly ownerId: string; readonly kind: OutputSharingKind; readonly slots: readonly OutputSharingSlot[] }
export interface OutputSharingPolicyRequest {
  readonly profile: typeof OUTPUT_SHARING_PROFILE; readonly applicationId: string; readonly sessionId: string;
  readonly destinationId: string; readonly ownerId: string; readonly expectedRevision: number; readonly policy: OutputSharingPolicy;
}
/** Host-authenticated destination-owner review. This is not source, capture, or resource permission. */
export interface OutputSharingPolicyGrant { readonly request: OutputSharingPolicyRequest; readonly expiresAt: number; readonly signal: AbortSignal }
export interface OutputSharingResourceRequest {
  readonly profile: typeof OUTPUT_SHARING_PROFILE; readonly side: 'source' | 'sink'; readonly ownerId: string;
  readonly destinationId: string; readonly slotId: 'a' | 'b'; readonly revision: number; readonly route: Readonly<AuthorizationRequest>;
}
/** Mutable revocation uses a genuine signal. No isCurrent callback or metadata can mint owner consent. */
export interface OutputSharingResourceGrant {
  readonly request: OutputSharingResourceRequest; readonly expiresAt: number; readonly signal: AbortSignal; readonly maxHz: number; readonly maxAgeMs: number;
}
export type OutputSharingFailure = 'invalid' | 'denied' | 'stale' | 'busy' | 'capacity' | 'expired' | 'closed';
export type OutputSharingResult<T = undefined> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: OutputSharingFailure }>;
export interface OutputSharingPlan { readonly destinationId: string; readonly revision: number; readonly policy: OutputSharingPolicy }
export interface OutputSharingRoute {
  readonly connection: Connection; readonly destinationId: string; readonly slotId: 'a' | 'b'; readonly revision: number;
}
export interface OutputSharingEffectContext {
  /** Checks every participating route after all clock/context callouts, then the intrinsic owner signals together. */
  isCurrent(): boolean;
}
export interface OutputSharingOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal; readonly applicationId: string; readonly sessionId: string;
  readonly now: () => number; readonly sources: readonly OutputSharingSource[]; readonly destinations: readonly OutputSharingDestination[];
  readonly authorizePolicy: (request: OutputSharingPolicyRequest) => OutputSharingPolicyGrant | undefined;
  readonly authorizeSource: (request: OutputSharingResourceRequest) => OutputSharingResourceGrant | undefined;
  readonly authorizeSink: (request: OutputSharingResourceRequest) => OutputSharingResourceGrant | undefined;
}
export interface OutputSharingController {
  /** A failed review preserves the existing plan and its routes. A successful transfer retires old routes before fresh admission. */
  select(destinationId: string, expectedRevision: number, policy: OutputSharingPolicy): OutputSharingResult<number>;
  plan(destinationId: string): OutputSharingPlan | undefined;
  route(request: Readonly<{ destinationId: string; slotId: 'a' | 'b' }>): OutputSharingResult<OutputSharingRoute>;
  /** Trusted runtime composition only: actual routes must be created through this controller. */
  authorizeRoute(request: Readonly<AuthorizationRequest>): RouteGrant | undefined;
  current(route: OutputSharingRoute, context: DeliveryContext,
    companion?: Readonly<{ route: OutputSharingRoute; context: DeliveryContext }>): boolean;
  /** Return directly from SinkProvider.apply. The actual issued Promise retains its reservation after logical retirement. */
  effect(route: OutputSharingRoute, context: DeliveryContext, apply: (guard: OutputSharingEffectContext) => void | Promise<void>,
    companion?: Readonly<{ route: OutputSharingRoute; context: DeliveryContext }>): Promise<void>;
  release(destinationId: string, expectedRevision: number): boolean;
  snapshot(): Readonly<{ closed: boolean; routes: number; plans: number; attempts: number; changes: number; effects: number; rawPending: number }>;
  close(): Promise<void>;
}
interface Resource { id: string; ownerId: string; handle: EndpointHandle; reference: ResourceReference; capability: DeviceCapability }
interface Destination { id: string; ownerId: string; kind: OutputSharingKind; slots: Map<'a' | 'b', Resource>; revision: number; plan?: Plan }
interface Plan { public: OutputSharingPlan; grant: OutputSharingPolicyGrant; wallExpires: number }
interface Entry {
  destination: Destination; slot: Resource; source: Resource; plan: Plan; authorization: Readonly<AuthorizationRequest>;
  token?: OutputSharingRoute; connection?: Connection; retired: boolean; connectionRetired?: boolean; sourceGrant?: OutputSharingResourceGrant; sinkGrant?: OutputSharingResourceGrant;
  expiresAt?: number; wallExpires?: number; removers: Array<() => void>;
}
class Failure extends Error {
  readonly reason: OutputSharingFailure;
  constructor(reason: OutputSharingFailure) { super(reason); this.reason = reason; }
}
function fail(reason: OutputSharingFailure): never { throw new Failure(reason); }
const yes = <T>(value: T): OutputSharingResult<T> => Object.freeze({ ok: true, value });
const no = (reason: OutputSharingFailure): OutputSharingResult<never> => Object.freeze({ ok: false, reason });
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
const wallNow = performance.now.bind(performance), arm = setTimeout, disarm = clearTimeout;
function live(signal: unknown): signal is AbortSignal { try { return abortGetter.call(signal) === false; } catch { return false; } }
function fields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) fail('invalid');
  const keys = Reflect.ownKeys(input), value: Record<string, unknown> = Object.create(null);
  if (keys.length > required.length + optional.length) fail('invalid');
  for (const key of keys) { if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) fail('invalid');
    const property = Object.getOwnPropertyDescriptor(input, key); if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('invalid'); value[key] = property.value; }
  if (required.some(key => !Object.hasOwn(value, key))) fail('invalid'); return value;
}
function id(input: unknown): string { if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) fail('invalid'); return input; }
function number(input: unknown, min: number, max: number): number { if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) fail('invalid'); return input; }
function integer(input: unknown, min: number, max: number): number { const value = number(input, min, max); if (!Number.isSafeInteger(value)) fail('invalid'); return value; }
function list(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail('invalid');
  const length = Object.getOwnPropertyDescriptor(input, 'length')?.value as unknown; integer(length, 1, max);
  if (Reflect.ownKeys(input).length !== (length as number) + 1) fail('invalid');
  const result: unknown[] = []; for (let index = 0; index < (length as number); index++) {
    const property = Object.getOwnPropertyDescriptor(input, String(index)); if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('invalid'); result.push(property.value); }
  return result;
}
function slotId(input: unknown): 'a' | 'b' { if (input !== 'a' && input !== 'b') fail('invalid'); return input; }
function resource(input: Record<string, unknown>, ownerId: string): Resource {
  const handle = input.handle as EndpointHandle; if (!handle || typeof handle !== 'object') fail('invalid');
  const registrationId = id(Object.getOwnPropertyDescriptor(handle, 'id')?.value), device = parseDeviceDescriptor(input.device), capabilityId = id(input.capability);
  const capability = device.capabilities.find(value => value.id === capabilityId); if (!capability) fail('invalid');
  return { id: id(input.id), ownerId, handle, capability, reference: Object.freeze({ registrationId, deviceId: device.id, capabilityId, descriptorRevision: device.revision, schemaVersion: capability.schemaVersion }) };
}
function sameReference(a: ResourceReference, b: ResourceReference): boolean { return a.registrationId === b.registrationId && a.deviceId === b.deviceId && a.capabilityId === b.capabilityId && a.descriptorRevision === b.descriptorRevision && a.schemaVersion === b.schemaVersion; }
function sameAuthorization(a: AuthorizationRequest, b: AuthorizationRequest): boolean { return a.principalId === b.principalId && a.applicationId === b.applicationId && a.sessionId === b.sessionId && a.sourceOperation === b.sourceOperation && a.sinkOperation === b.sinkOperation && a.partition === b.partition && sameReference(a.source, b.source) && sameReference(a.sink, b.sink); }
function parsePolicy(input: unknown, destination: Destination, sources: Map<string, Resource>): OutputSharingPolicy {
  const value = fields(input, ['kind', 'mode', 'inputs'], ['foreground']); if (value.kind !== destination.kind) fail('invalid');
  const inputs = list(value.inputs, 2).map(item => { const entry = fields(item, ['slotId', 'sourceId', 'principalId']);
    const slot = slotId(entry.slotId), sourceId = id(entry.sourceId), principalId = id(entry.principalId), source = sources.get(sourceId), sink = destination.slots.get(slot);
    if (!source || !sink || !schemasCompatible(source.capability, sink.capability)) fail('invalid');
    return Object.freeze({ slotId: slot, sourceId, principalId }); });
  if (new Set(inputs.map(entry => entry.slotId)).size !== inputs.length) fail('invalid');
  if (value.kind === 'audio') {
    if (value.mode === 'duck') { const foreground = slotId(value.foreground); if (inputs.length !== 2 || !inputs.some(entry => entry.slotId === foreground)) fail('invalid'); return Object.freeze({ kind: 'audio', mode: 'duck', foreground, inputs: Object.freeze(inputs) }); }
    if (Object.hasOwn(value, 'foreground') || value.mode !== 'mix' && value.mode !== 'exclusive' || value.mode === 'exclusive' && inputs.length !== 1) fail('invalid');
    return Object.freeze({ kind: 'audio', mode: value.mode, inputs: Object.freeze(inputs) });
  }
  if (Object.hasOwn(value, 'foreground')) fail('invalid');
  if (value.kind === 'camera' && value.mode === 'observers') return Object.freeze({ kind: 'camera', mode: 'observers', inputs: Object.freeze(inputs) });
  if (value.kind === 'application' && (value.mode === 'layers' || value.mode === 'regions')) return Object.freeze({ kind: 'application', mode: value.mode, inputs: Object.freeze(inputs) });
  fail('invalid');
}

/** Cooperative local policies over real SDK routes. Trusted callbacks authenticate owners; this is no sandbox,
 * capture permission, transport identity or administrative override. Plans never select executable code. */
export function createOutputSharingController(input: OutputSharingOptions): OutputSharingController {
  const options = fields(input, ['runtime', 'ownerSignal', 'applicationId', 'sessionId', 'now', 'sources', 'destinations', 'authorizePolicy', 'authorizeSource', 'authorizeSink']);
  if (!live(options.ownerSignal) || !options.runtime || typeof options.runtime !== 'object' || typeof options.now !== 'function' ||
      !['authorizePolicy', 'authorizeSource', 'authorizeSink'].every(name => typeof options[name] === 'function')) fail('invalid');
  const runtime = options.runtime as DeviceRuntime, owner = options.ownerSignal, applicationId = id(options.applicationId), sessionId = id(options.sessionId);
  const now = options.now as () => number, policyApprove = options.authorizePolicy as OutputSharingOptions['authorizePolicy'];
  const sourceApprove = options.authorizeSource as OutputSharingOptions['authorizeSource'], sinkApprove = options.authorizeSink as OutputSharingOptions['authorizeSink'];
  const sources = new Map<string, Resource>(), destinations = new Map<string, Destination>(), allHandles = new Set<EndpointHandle>();
  for (const item of list(options.sources, 8)) { const value = fields(item, ['id', 'ownerId', 'handle', 'device', 'capability']), source = resource(value, id(value.ownerId));
    if (sources.has(source.id) || allHandles.has(source.handle) || !source.capability.permissions.includes('subscribe') || source.capability.delivery.mode !== 'latest') fail('invalid');
    sources.set(source.id, source); allHandles.add(source.handle); }
  for (const item of list(options.destinations, 4)) { const value = fields(item, ['id', 'ownerId', 'kind', 'slots']);
    if (value.kind !== 'audio' && value.kind !== 'camera' && value.kind !== 'application') fail('invalid');
    const destination: Destination = { id: id(value.id), ownerId: id(value.ownerId), kind: value.kind, slots: new Map(), revision: 0 };
    if (destinations.has(destination.id)) fail('invalid');
    for (const item of list(value.slots, 2)) { const slot = fields(item, ['id', 'handle', 'device', 'capability']), key = slotId(slot.id), sink = resource(slot, destination.ownerId);
      if (destination.slots.has(key) || allHandles.has(sink.handle) || !sink.capability.permissions.includes('write') || sink.capability.delivery.mode !== 'latest' || sink.capability.ownership?.mode !== 'observe') fail('invalid');
      destination.slots.set(key, sink); allHandles.add(sink.handle); }
    destinations.set(destination.id, destination); }
  const enrollment = { sources: [...sources.values()].map(value => ({ id: value.id, ownerId: value.ownerId, reference: value.reference, capability: value.capability })),
    destinations: [...destinations.values()].map(value => ({ id: value.id, ownerId: value.ownerId, kind: value.kind,
      slots: [...value.slots.values()].map(slot => ({ reference: slot.reference, capability: slot.capability })) })) };
  if (new TextEncoder().encode(JSON.stringify(enrollment)).byteLength > 32768) fail('invalid');
  const managed = new Set<Entry>(), tokens = new WeakMap<OutputSharingRoute, Entry>(), raw = new Set<object>();
  let closed = false, busy = false, clockBusy = false, authorizing = false, lastAt = -1, startedAt = -1, attempts = 0, changes = 0, effects = 0, authorizations = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, closePromise: Promise<void> | undefined, closeResolve: (() => void) | undefined;
  const wallStart = wallNow();
  function finishClose() { if (closed && raw.size === 0) { closeResolve?.(); closeResolve = undefined; } }
  function retire(entry: Entry) {
    if (!entry.retired) { entry.retired = true; managed.delete(entry); for (const remove of entry.removers.splice(0)) remove(); }
    // Reentrant retirement may precede the real handle's return. Adopt its cleanup exactly once.
    if (entry.connection && !entry.connectionRetired) { entry.connectionRetired = true;
      try { runtime.revoke(entry.connection); } catch { try { entry.connection.stop('sharing-retired'); } catch { /* Trusted host cleanup failure cannot restore authority. */ } } }
  }
  function shutdown() { if (closed) return; closed = true; if (timer !== undefined) disarm(timer); timer = undefined;
    remove.call(owner, 'abort', shutdown); for (const entry of [...managed]) retire(entry); for (const destination of destinations.values()) destination.plan = undefined; finishClose(); }
  function time(): number {
    if (closed || clockBusy || !live(owner)) { shutdown(); fail('closed'); } clockBusy = true;
    let at: number; try { at = now(); } catch { shutdown(); fail('invalid'); } finally { clockBusy = false; }
    if (closed || !live(owner)) { shutdown(); fail('closed'); }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER || at < lastAt) { shutdown(); fail('invalid'); }
    if (startedAt < 0) startedAt = at; lastAt = at;
    if (at - startedAt >= 30000 || wallNow() - wallStart >= 30000) { shutdown(); fail('expired'); } return at;
  }
  function planLive(destination: Destination, selected: Plan, at: number): boolean {
    return !closed && live(owner) && destination.plan === selected && destination.revision === selected.public.revision && live(selected.grant.signal) && at < selected.grant.expiresAt && wallNow() < selected.wallExpires;
  }
  function entryLive(entry: Entry, at: number): boolean {
    return !entry.retired && managed.has(entry) && planLive(entry.destination, entry.plan, at) &&
      (!entry.sourceGrant || live(entry.sourceGrant.signal)) && (!entry.sinkGrant || live(entry.sinkGrant.signal)) &&
      (entry.expiresAt === undefined || at < entry.expiresAt) && (entry.wallExpires === undefined || wallNow() < entry.wallExpires);
  }
  function sweep(at: number) {
    for (const entry of [...managed]) if (!entryLive(entry, at)) retire(entry);
    for (const destination of destinations.values()) if (destination.plan && !planLive(destination, destination.plan, at)) destination.plan = undefined;
  }
  function schedule() {
    if (timer !== undefined) disarm(timer); timer = undefined; if (closed) return;
    let deadline = wallStart + 30000; for (const destination of destinations.values()) if (destination.plan) deadline = Math.min(deadline, destination.plan.wallExpires);
    for (const entry of managed) if (entry.wallExpires !== undefined) deadline = Math.min(deadline, entry.wallExpires);
    timer = arm(() => { timer = undefined; try { sweep(time()); schedule(); } catch { shutdown(); } }, Math.max(1, deadline - wallNow()));
  }
  function bindSignal(entry: Entry, signal: AbortSignal) { const listener = () => retire(entry); add.call(signal, 'abort', listener, { once: true }); entry.removers.push(() => remove.call(signal, 'abort', listener)); }
  function select(destinationInput: string, expectedInput: number, policyInput: OutputSharingPolicy): OutputSharingResult<number> {
    if (closed) return no('closed'); if (busy || clockBusy) return no('busy'); if (changes >= 32) return no('capacity'); busy = true; changes++;
    try {
      const destination = destinations.get(id(destinationInput)), expectedRevision = integer(expectedInput, 0, 32); if (!destination) fail('invalid');
      if (destination.revision !== expectedRevision) fail('stale'); const policy = parsePolicy(policyInput, destination, sources), at = time();
      const request = Object.freeze({ profile: OUTPUT_SHARING_PROFILE, applicationId, sessionId, destinationId: destination.id, ownerId: destination.ownerId, expectedRevision, policy });
      let result: unknown; try { result = policyApprove(request); } catch { fail('denied'); }
      let grant: Record<string, unknown>; try { grant = fields(result, ['request', 'expiresAt', 'signal']); } catch { fail('denied'); }
      if (grant.request !== request || !live(grant.signal)) fail('denied'); const expiresAt = number(grant.expiresAt, at + 0.001, Math.min(at + 30000, startedAt + 30000));
      const finalAt = time(); if (destination.revision !== expectedRevision || !live(grant.signal) || expiresAt <= finalAt) fail('denied');
      const captured: OutputSharingPolicyGrant = Object.freeze({ request, expiresAt, signal: grant.signal });
      const next: Plan = { public: Object.freeze({ destinationId: destination.id, revision: expectedRevision + 1, policy }), grant: captured, wallExpires: wallNow() + expiresAt - finalAt };
      // No callouts between the signal fence and policy commit. Old native effects retire; new admission is explicit.
      destination.revision++; destination.plan = next; for (const entry of [...managed]) if (entry.destination === destination) retire(entry);
      if (!planLive(destination, next, lastAt)) fail('denied'); schedule(); return yes(destination.revision);
    } catch (error) { return no(error instanceof Failure ? error.reason : 'denied'); } finally { busy = false; }
  }
  function route(input: Readonly<{ destinationId: string; slotId: 'a' | 'b' }>): OutputSharingResult<OutputSharingRoute> {
    if (closed) return no('closed'); if (clockBusy || busy) return no('busy'); if (attempts >= 64 || managed.size >= 8) return no('capacity'); attempts++;
    let entry: Entry | undefined;
    try {
      const value = fields(input, ['destinationId', 'slotId']), destination = destinations.get(id(value.destinationId)), key = slotId(value.slotId);
      const selected = destination?.plan, slot = destination?.slots.get(key), chosen = selected?.public.policy.inputs.find(item => item.slotId === key);
      if (!destination || !selected || !slot || !chosen) fail('denied'); const source = sources.get(chosen.sourceId); if (!source) fail('invalid');
      const authorization: Readonly<AuthorizationRequest> = Object.freeze({ principalId: chosen.principalId, applicationId, sessionId, source: source.reference, sink: slot.reference, sourceOperation: 'subscribe', sinkOperation: 'write' });
      if ([...managed].some(value => !value.retired && sameAuthorization(value.authorization, authorization))) fail('busy');
      entry = { destination, plan: selected, slot, source, authorization, retired: false, removers: [] }; managed.add(entry);
      const at = time(); sweep(at); if (!entryLive(entry, at)) fail('expired'); const method = runtime.route;
      if (typeof method !== 'function' || !entryLive(entry, lastAt)) fail('invalid');
      entry.connection = method.call(runtime, { from: source.handle, to: slot.handle, principalId: chosen.principalId, applicationId, sessionId, sourceOperation: 'subscribe', queueCapacity: 1, leaseMs: 1000 });
      const after = time(); if (!entryLive(entry, after)) fail('stale');
      const captured = entry; const token = Object.freeze({ connection: entry.connection, destinationId: destination.id, slotId: key, revision: selected.public.revision });
      entry.token = token; tokens.set(token, entry); const detach = entry.connection.onClose(() => retire(captured)); entry.removers.push(detach);
      bindSignal(entry, selected.grant.signal); if (!entryLive(entry, lastAt)) fail('denied'); schedule(); return yes(token);
    } catch (error) { if (entry) retire(entry); return no(error instanceof Failure ? error.reason : 'invalid'); }
  }
  function approval(request: OutputSharingResourceRequest, approve: OutputSharingOptions['authorizeSource'], at: number): OutputSharingResourceGrant {
    let result: unknown; try { result = approve(request); } catch { fail('denied'); }
    const grant = fields(result, ['request', 'expiresAt', 'maxHz', 'maxAgeMs', 'signal']); if (grant.request !== request || !live(grant.signal)) fail('denied');
    return Object.freeze({ request, signal: grant.signal, expiresAt: number(grant.expiresAt, at + 0.001, Math.min(at + 30000, startedAt + 30000)), maxHz: number(grant.maxHz, 1, 30), maxAgeMs: number(grant.maxAgeMs, 1, 250) });
  }
  function authorizeRoute(request: Readonly<AuthorizationRequest>): RouteGrant | undefined {
    if (closed || clockBusy || authorizing || authorizations >= 64) return; authorizing = true; authorizations++;
    try {
      const entry = [...managed].find(value => value.connection && !value.retired && sameAuthorization(value.authorization, request)); if (!entry) return;
      const at = time(); if (!entryLive(entry, at)) { retire(entry); return; }
      const common = { profile: OUTPUT_SHARING_PROFILE, destinationId: entry.destination.id, slotId: entry.token!.slotId, revision: entry.plan.public.revision, route: entry.authorization };
      const source = approval(Object.freeze({ ...common, side: 'source', ownerId: entry.source.ownerId }), sourceApprove, at);
      if (!entryLive(entry, lastAt) || !live(source.signal)) return;
      const sink = approval(Object.freeze({ ...common, side: 'sink', ownerId: entry.destination.ownerId }), sinkApprove, at), finalAt = time();
      const expiresAt = Math.min(source.expiresAt, sink.expiresAt, entry.plan.grant.expiresAt);
      if (!entryLive(entry, finalAt) || !live(source.signal) || !live(sink.signal) || expiresAt <= finalAt) return;
      // Renew cannot resurrect an older owner decision or extend the captured policy's deadline.
      if (entry.sourceGrant) { if (source.signal !== entry.sourceGrant.signal || sink.signal !== entry.sinkGrant?.signal) return; }
      else { entry.sourceGrant = source; entry.sinkGrant = sink; bindSignal(entry, source.signal); bindSignal(entry, sink.signal); }
      entry.expiresAt = Math.min(entry.expiresAt ?? expiresAt, expiresAt); entry.wallExpires = Math.min(entry.wallExpires ?? Infinity, wallNow() + entry.expiresAt - finalAt);
      if (!entryLive(entry, finalAt) || !live(source.signal) || !live(sink.signal)) { retire(entry); return; } schedule();
      return Object.freeze({ expiresAt: entry.expiresAt, maxHz: Math.min(source.maxHz, sink.maxHz), maxAgeMs: Math.min(source.maxAgeMs, sink.maxAgeMs) });
    } catch { return; } finally { authorizing = false; }
  }
  function current(token: OutputSharingRoute, context: DeliveryContext,
    companion?: Readonly<{ route: OutputSharingRoute; context: DeliveryContext }>): boolean {
    const selected = [{ route: token, context }, ...(companion ? [companion] : [])];
    try {
      for (const value of selected) { const entry = tokens.get(value.route);
        if (!entry || entry.retired || !entry.sourceGrant || !entry.sinkGrant || value.context.routeId !== entry.connection?.id || !live(value.context.signal)) return false;
        const at = time(), observer = value.context.isCurrent;
        if (!entryLive(entry, at) || typeof observer !== 'function' || !observer.call(value.context)) return false; }
      const finalAt = time();
      // No observers remain after this clock and joint intrinsic authority/deadline fence.
      return selected.every(value => { const entry = tokens.get(value.route); return !!entry && !!entry.sourceGrant && !!entry.sinkGrant && entryLive(entry, finalAt) && live(value.context.signal); });
    } catch { return false; }
  }
  function effect(token: OutputSharingRoute, context: DeliveryContext, apply: (guard: OutputSharingEffectContext) => void | Promise<void>,
      companion?: Readonly<{ route: OutputSharingRoute; context: DeliveryContext }>): Promise<void> {
    if (closed || effects >= 128 || raw.size >= 2 || typeof apply !== 'function') return Promise.resolve();
    const reservation = {}; raw.add(reservation); effects++;
    const guard = Object.freeze({ isCurrent() {
      return current(token, context, companion);
    } });
    return (async () => { try { if (!guard.isCurrent()) return; await apply(guard); if (!guard.isCurrent()) { const entry = tokens.get(token); if (entry) retire(entry); } }
      catch { const entry = tokens.get(token); if (entry) retire(entry); }
      finally { raw.delete(reservation); finishClose(); } })();
  }
  function release(destinationInput: string, expectedRevision: number): boolean {
    if (closed || busy || clockBusy) return false;
    const destination = destinations.get(destinationInput); if (!destination || destination.revision !== expectedRevision || !destination.plan) return false;
    destination.plan = undefined; destination.revision++; for (const entry of [...managed]) if (entry.destination === destination) retire(entry); schedule(); return true;
  }
  add.call(owner, 'abort', shutdown, { once: true }); time(); schedule();
  return Object.freeze({ select, route, authorizeRoute, current, effect, release,
    plan(destinationId: string) { try { sweep(time()); return destinations.get(destinationId)?.plan?.public; } catch { return; } },
    snapshot: () => Object.freeze({ closed, routes: managed.size, plans: [...destinations.values()].filter(value => value.plan).length, attempts, changes, effects, rawPending: raw.size }),
    close() { if (!closePromise) { closePromise = new Promise<void>(resolve => { closeResolve = resolve; }); shutdown(); finishClose(); } return closePromise; } });
}
