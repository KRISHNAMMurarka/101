import { createDeviceRuntime, parseDeviceDescriptor, parseSignalValue, parseObservationTiming,
  schemasCompatible, RemoteResourcePublisher, RemoteResourceReceiver, webEndpointCrypto } from '@101/connect';
import type { AuthorizationRequest, DeviceDescriptor, DeviceRuntime, EndpointHandle, EndpointIdentity,
  Observation, DeliveryContext, PeerConnectionPort, ResourceReference } from '@101/connect';
import { SharingPeer, SHARING_APPLICATION } from '../sharing-peer.ts';
import type { SharingPeerSnapshot } from '../sharing-peer.ts';

export const WATCH_SHARING_LIMITS = Object.freeze({ observers: 2, attempts: 32, requests: 64, rawPending: 4,
  transitions: 64, maxHz: 20, maxAgeMs: 250, approvalMs: 30000, emissionsPerApproval: 600, envelopeBytes: 4096 });
type Role = 'owner' | 'observer';
type Notice = 'ready' | 'invalid' | 'unavailable' | 'busy' | 'limit' | 'consent-needed' | 'requested' |
  'approving' | 'active' | 'declined' | 'cancelled' | 'revoked' | 'expired' | 'paused' | 'stopped' | 'closed';
export interface WatchViewValue {
  readonly x: number; readonly y: number; readonly pressed: boolean; readonly generation: number; readonly emittedAt: number;
}
export interface WatchSharingOptions {
  role: Role; now: () => number; wallNow: () => number; onChange?: () => void;
  /** Explicit cooperative software ports; they are never native RTC or hardware evidence. */
  createPeer?: (configuration: RTCConfiguration) => PeerConnectionPort;
  createIdentity?: () => Promise<EndpointIdentity>;
}
export interface WatchSharingSnapshot {
  readonly role: Role; readonly closed: boolean; readonly notice: Notice; readonly rawPending: number;
  readonly remainingAttempts: number; readonly remainingRequests: number; readonly cleanupFailed: boolean;
  readonly peers: readonly Readonly<{ id: string; label: string; connection: SharingPeerSnapshot; ready: boolean;
    request?: number; active: boolean; epoch?: string; remoteKeyId?: string }>[];
  readonly source: Readonly<{ active: boolean; paused: boolean; generation: number; expiresAt?: number;
    value?: WatchViewValue; emissions: number; held: boolean }>;
  readonly view: Readonly<{ active: boolean; request?: number; expiresAt?: number; value?: WatchViewValue;
    sourceStamp?: Readonly<{ kind: 'owner-page-performance'; endpointId: string; epoch: string;
      generation: number; milliseconds: number }>; receivedAt?: number }>;
  readonly transitions: readonly Notice[];
}
export function watchViewDescriptor(): DeviceDescriptor {
  return parseDeviceDescriptor({ schemaVersion: 1, id: 'owned-watch-page', label: 'Owned page view', revision: 1,
    adapter: { id: 'example:watch-page', version: '1.0.0' }, runtime: { platform: 'owned-software-page' }, capabilities: [{
      id: 'view', semantic: 'application:read-only-page-view/1', schemaVersion: 1, kind: 'sample',
      value: { type: 'record', fields: { x: { type: 'scalar', unit: '1', min: 0, max: 1 },
        y: { type: 'scalar', unit: '1', min: 0, max: 1 }, pressed: { type: 'boolean' },
        generation: { type: 'scalar', unit: '1', min: 1, max: 32, resolution: 1 },
        emittedAt: { type: 'scalar', unit: 'ms', min: 0, max: Number.MAX_SAFE_INTEGER - 60000 } } },
      delivery: { mode: 'latest', maxHz: 20, maxAgeMs: 250 }, permissions: ['subscribe'],
    }] });
}
export function watchViewCompatible(input: unknown): boolean {
  try {
    const device = parseDeviceDescriptor(input), expected = watchViewDescriptor(), capability = device.capabilities[0], selected = expected.capabilities[0]!;
    return device.id === expected.id && device.revision === 1 && device.schemaVersion === 1 && device.capabilities.length === 1 && !!capability &&
      capability.id === 'view' && capability.semantic === selected.semantic && capability.kind === 'sample' && capability.schemaVersion === 1 &&
      capability.permissions.length === 1 && capability.permissions[0] === 'subscribe' && capability.delivery.mode === 'latest' &&
      capability.delivery.maxHz === 20 && capability.delivery.maxAgeMs === 250 && schemasCompatible(capability, selected);
  } catch { return false; }
}
function displayDescriptor(id: string): DeviceDescriptor {
  const source = watchViewDescriptor();
  return parseDeviceDescriptor({ ...source, id, label: 'Approved read-only display', capabilities: source.capabilities.map(capability =>
    ({ ...capability, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } })) });
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const isAborted = (signal: AbortSignal) => Reflect.apply(aborted, signal, []) as boolean;
const sameRef = (a: ResourceReference, b: ResourceReference) => a.registrationId === b.registrationId && a.deviceId === b.deviceId &&
  a.capabilityId === b.capabilityId && a.descriptorRevision === b.descriptorRevision && a.schemaVersion === b.schemaVersion;
type Approval = { request: number; generation: number; expiresAt: number; controller: AbortController;
  phase: 'requested' | 'preparing' | 'active'; sourceExpiresAt?: number; sink?: EndpointHandle; sinkDevice?: DeviceDescriptor;
  sourceRef?: ResourceReference; routeId?: string; value?: WatchViewValue; receivedAt?: number };
type SourceApproval = { controller: AbortController; generation: number; expiresAt: number; paused: boolean; emissions: number };
type Entry = { id: string; label: string; peer: SharingPeer; attaching: boolean; failed: boolean; epoch?: string; remoteKeyId?: string;
  publisher?: RemoteResourcePublisher; receiver?: RemoteResourceReceiver; runtime?: DeviceRuntime;
  request?: Approval; permit?: Approval; lastRequest: number; sourceGeneration: number; sourceExpiresAt?: number };
type Packet = { type: 'source' | 'source-stop' | 'request' | 'prepare' | 'active' | 'cancel' | 'stop' | 'declined';
  generation: number; request?: number; sourceExpiresAt?: number };
function packet(text: string, epoch: string): Packet | undefined {
  if (text.length > 4096 || new TextEncoder().encode(text).byteLength > 4096) return;
  try {
    const input: unknown = JSON.parse(text); if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const value = input as Record<string, unknown>, type = value.type;
    const types = ['source', 'source-stop', 'request', 'prepare', 'active', 'cancel', 'stop', 'declined'];
    if (typeof type !== 'string' || !types.includes(type)) return;
    const keys = ['p', 'v', 'epoch', 'flow', 'type', 'generation',
      ...(type === 'source' || type === 'source-stop' ? [] : ['request']), ...(type === 'prepare' ? ['sourceExpiresAt'] : [])];
    if (value.p !== 'connected-page-sharing/1' || value.v !== 1 || value.epoch !== epoch || value.flow !== 'observer-view/1' ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || Number(value.generation) > 32) return;
    if (type !== 'source' && type !== 'source-stop' && (!Number.isSafeInteger(value.request) || Number(value.request) < 1 || Number(value.request) > 64)) return;
    if (type === 'prepare' && (typeof value.sourceExpiresAt !== 'number' || !Number.isFinite(value.sourceExpiresAt) ||
      value.sourceExpiresAt < 0 || value.sourceExpiresAt > Number.MAX_SAFE_INTEGER - 30000)) return;
    return value as unknown as Packet;
  } catch { return; }
}

/** Volatile software-page view. Endpoint verification, source consent and each
 * recipient's display consent are separate. The ordinary receiver owns wire
 * slots and its real clock mapping; local metadata never creates a grant. */
export function createWatchSharingTask(configuration: WatchSharingOptions) {
  const fields = Object.getOwnPropertyDescriptors(configuration), allowed = ['role', 'now', 'wallNow', 'onChange', 'createPeer', 'createIdentity'];
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(fields[key], 'value')) ||
    fields.role?.value !== 'owner' && fields.role?.value !== 'observer' || typeof fields.now?.value !== 'function' || typeof fields.wallNow?.value !== 'function' ||
    ['onChange', 'createPeer', 'createIdentity'].some(key => fields[key] && fields[key].value !== undefined && typeof fields[key].value !== 'function')) throw new TypeError('Invalid watch options');
  const options = Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))) as unknown as WatchSharingOptions;
  const peers: Entry[] = [], issued = new Set<Promise<unknown>>(), transitions: Notice[] = [];
  let closed = false, busy = false, notifying = false, reading = false, ticking = false, cleanupFailed = false;
  let revision = 0, lastTime = -Infinity, rawPending = 0, attempts = 0, requests = 0, sourceGeneration = 0;
  let notice: Notice = 'ready', source: SourceApproval | undefined, sourceValue: WatchViewValue | undefined;
  let x = .5, y = .5, held = false, lastEmission = -Infinity, emissions = 0;
  let closePromise: Promise<void> | undefined;
  let expiry: { deadline: number; handle?: ReturnType<typeof setTimeout> } | undefined;

  function notify() { if (notifying) return; notifying = true; try { options.onChange?.(); } catch { /* Rendering is not consent. */ } finally { notifying = false; } }
  function record(value: Notice) { if (closed && value !== 'closed') return; notice = value;
    if (transitions.at(-1) !== value) { transitions.push(value); if (transitions.length > 64) transitions.shift(); } notify(); }
  function time(): number | undefined {
    if (closed || reading) return; const epoch = revision; reading = true; let at: number;
    try { at = options.now(); } catch { void close(); return; } finally { reading = false; }
    if (closed || epoch !== revision) return;
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 60000 || at < lastTime) { void close(); return; }
    lastTime = at; return at;
  }
  function reserve() {
    if (rawPending >= 4) { cleanupFailed = true; return; }
    rawPending++; let released = false;
    return () => { if (!released) { released = true; rawPending--; notify(); } };
  }
  function track<T>(action: () => Promise<T>, fallback: T): Promise<T> {
    // Publish the returned operation before an author clock, notification or
    // native factory can synchronously call close().
    let settle!: (value: T) => void;
    const work = new Promise<T>(resolve => { settle = resolve; }); issued.add(work);
    void (async () => { try { settle(await action()); } catch { settle(fallback); } })();
    void work.then(() => { issued.delete(work); }); return work;
  }
  function member(entry: Entry) { return !closed && peers.includes(entry); }
  function owned(entry: Entry) { return member(entry) && !!entry.peer.current() && member(entry); }
  function sourceCurrent(current = source): current is SourceApproval {
    if (!current || source !== current || closed || isAborted(current.controller.signal)) return false;
    const at = time();
    if (at === undefined || closed || source !== current || isAborted(current.controller.signal)) return false;
    if (at >= current.expiresAt) { retireSource('expired'); return false; } return true;
  }
  function approvalCurrent(entry: Entry, approval: Approval) {
    if (!owned(entry) || entry.permit !== approval || isAborted(approval.controller.signal)) return false;
    const at = time();
    return at !== undefined && !closed && peers.includes(entry) && entry.permit === approval && !isAborted(approval.controller.signal) && at < approval.expiresAt;
  }
  function send(entry: Entry, message: Packet): boolean {
    if (!owned(entry)) return false;
    return entry.peer.send({ flow: 'observer-view/1', type: message.type, generation: message.generation,
      ...(message.request === undefined ? {} : { request: message.request }),
      ...(message.sourceExpiresAt === undefined ? {} : { sourceExpiresAt: message.sourceExpiresAt }) });
  }
  function cleanupSink(entry: Entry, approval: Approval) {
    const handle = approval.sink; approval.sink = undefined; approval.value = undefined; approval.receivedAt = undefined;
    if (!handle || !entry.runtime) return;
    try { if (!entry.runtime.unregister(handle).ok) cleanupFailed = true; } catch { cleanupFailed = true; }
  }
  function withdraw(entry: Entry, type?: 'cancel' | 'stop' | 'declined') {
    const previous = entry.permit ?? entry.request;
    const pending = entry.request, current = entry.permit; entry.request = undefined; entry.permit = undefined;
    pending?.controller.abort(); if (current !== pending) current?.controller.abort();
    if (current) cleanupSink(entry, current);
    // Terminally unregister this display, not the receiver. Its next-slot
    // watermark survives a fresh independent approval on the same peer epoch.
    try { entry.receiver?.tick(); entry.publisher?.tick(); } catch { cleanupFailed = true; }
    if (previous && type) send(entry, { type, generation: previous.generation, request: previous.request });
  }
  function retireSource(reason: 'expired' | 'stopped') {
    const previous = source; source = undefined; held = false; sourceValue = undefined;
    previous?.controller.abort();
    for (const entry of peers) { withdraw(entry, 'stop'); if (previous) send(entry, { type: 'source-stop', generation: previous.generation }); }
    if (previous) record(reason);
  }
  function clearTimer() { const old = expiry; expiry = undefined; if (old?.handle !== undefined) clearTimeout(old.handle); }
  function arm() {
    if (closed) { clearTimer(); return; }
    const deadlines = [source?.expiresAt, ...peers.flatMap(entry => [entry.request?.expiresAt, entry.permit?.expiresAt])].filter((value): value is number => value !== undefined);
    const deadline = deadlines.length ? Math.min(...deadlines) : undefined;
    if (deadline === undefined) { clearTimer(); return; }
    if (expiry?.deadline === deadline) return;
    clearTimer(); const at = time(); if (at === undefined || closed) return;
    const next = { deadline, handle: undefined as ReturnType<typeof setTimeout> | undefined }; expiry = next;
    const handle = setTimeout(() => { if (expiry !== next || closed) return; expiry = undefined; tick(); arm(); }, Math.max(1, Math.ceil(deadline - at)));
    if (expiry !== next || closed) clearTimeout(handle); else next.handle = handle;
  }
  function sweep(at: number) {
    if (source && at >= source.expiresAt) retireSource('expired');
    for (const entry of peers) if (entry.request && at >= entry.request.expiresAt || entry.permit && at >= entry.permit.expiresAt) {
      withdraw(entry, options.role === 'owner' ? 'stop' : 'cancel'); record('expired');
    }
  }
  function lost(entry: Entry) {
    entry.failed = true;
    withdraw(entry); entry.sourceGeneration = 0; entry.sourceExpiresAt = undefined;
    const publisher = entry.publisher, receiver = entry.receiver, runtime = entry.runtime;
    entry.publisher = undefined; entry.receiver = undefined; entry.runtime = undefined;
    for (const cleanup of [() => publisher?.stop(), () => receiver?.stop(), () => runtime?.close()]) {
      try { cleanup(); } catch { cleanupFailed = true; }
    }
    if (!closed) record('unavailable');
  }
  function makeEntry(id: string, sessionId?: string): Entry {
    const entry = { id, label: id === 'owner' ? 'Owner' : id === 'observer-1' ? 'Observer 1' : 'Observer 2',
      attaching: false, failed: false, lastRequest: 0, sourceGeneration: 0 } as Entry;
    entry.peer = new SharingPeer({ role: options.role === 'owner' ? 'source' : 'receiver', sessionId,
      now: () => time() ?? NaN, wallNow: options.wallNow, reserve,
      onChange: () => { if (member(entry)) { attach(entry); notify(); } },
      onMessage: (peer, text) => receive(entry, peer, text), onLoss: () => lost(entry),
      createPeer: options.createPeer, createIdentity: options.createIdentity });
    return entry;
  }
  function removeEntry(entry: Entry) {
    const index = peers.indexOf(entry); if (index >= 0) peers.splice(index, 1);
    lost(entry); void track(() => entry.peer.close(), undefined);
  }
  async function operation(action: () => Promise<boolean>): Promise<boolean> {
    if (closed || busy || cleanupFailed || attempts >= 32) return false;
    busy = true; attempts++; const epoch = revision;
    return track(async () => {
      try {
        record('busy'); const at = time(); if (at === undefined || closed || epoch !== revision) return false;
        const result = await action();
        if (closed || epoch !== revision) return false;
        record(result ? 'ready' : 'unavailable'); return !closed && result;
      } finally { busy = false; notify(); }
    }, false);
  }
  function runtimeAuthorize(entry: Entry, request: AuthorizationRequest) {
    const approval = entry.permit, scope = entry.peer.scope();
    if (!approval || !scope || !approval.sink || !approval.sinkDevice || !approvalCurrent(entry, approval) ||
      request.principalId !== scope.remoteKeyId || request.applicationId !== SHARING_APPLICATION || request.sessionId !== scope.sessionId ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' ||
      request.source.deviceId !== watchViewDescriptor().id || request.source.capabilityId !== 'view' || request.source.descriptorRevision !== 1 || request.source.schemaVersion !== 1 ||
      request.sink.registrationId !== approval.sink.id || request.sink.deviceId !== approval.sinkDevice.id || request.sink.capabilityId !== 'view' ||
      request.sink.descriptorRevision !== 1 || request.sink.schemaVersion !== 1 || approval.sourceRef && !sameRef(approval.sourceRef, request.source)) return;
    const at = time(); if (at === undefined || entry.permit !== approval || closed || isAborted(approval.controller.signal) || at >= approval.expiresAt) return;
    approval.sourceRef ??= Object.freeze({ ...request.source });
    return { expiresAt: approval.expiresAt, maxAgeMs: 250, maxHz: 20 };
  }
  function attach(entry: Entry) {
    if (!member(entry) || entry.failed || entry.attaching || entry.publisher || entry.receiver) return;
    const auth = entry.peer.current(), scope = entry.peer.scope(); if (!auth || !scope) return;
    entry.attaching = true; const epoch = revision;
    try {
      entry.epoch = scope.epoch; entry.remoteKeyId = scope.remoteKeyId;
      if (options.role === 'owner') {
        const publisher = new RemoteResourcePublisher({ peer: auth, epoch: scope.epoch, clockId: `watch-owner-${scope.epoch}`,
          now: () => time() ?? NaN, device: watchViewDescriptor(), available: capability => {
            const approval = entry.permit;
            return capability === 'view' && !!approval && sourceCurrent() && !source!.paused && approval.generation === source!.generation && approvalCurrent(entry, approval);
          } });
        if (!member(entry) || epoch !== revision || entry.peer.current() !== auth) { publisher.stop(); return; }
        entry.publisher = publisher;
        if (!publisher.start()) { lost(entry); return; }
        if (sourceCurrent() && member(entry)) send(entry, { type: 'source', generation: source!.generation });
      } else {
        const runtime = createDeviceRuntime({ clockDomain: `watch-receipt-${scope.epoch}`, now: () => time() ?? NaN,
          maxRegistrations: 2, maxRoutes: 1, maxPendingDeliveries: 1, authorize: request => runtimeAuthorize(entry, request) });
        if (!member(entry) || epoch !== revision) { runtime.close(); return; }
        entry.runtime = runtime;
        const receiver = new RemoteResourceReceiver({ peer: auth, runtime, epoch: scope.epoch, clockId: runtime.clockDomain, now: () => time() ?? NaN,
          principalId: scope.remoteKeyId, applicationId: SHARING_APPLICATION, sessionId: scope.sessionId });
        if (!member(entry) || epoch !== revision || entry.runtime !== runtime || entry.peer.current() !== auth) { receiver.stop(); runtime.close(); return; }
        entry.receiver = receiver;
      }
    } catch { lost(entry); } finally { entry.attaching = false; }
  }
  function display(entry: Entry, approval: Approval, observation: Observation, context: DeliveryContext) {
    if (!approvalCurrent(entry, approval) || !approval.sourceRef || approval.sourceRef.registrationId !== observation.source.registrationId ||
      approval.sourceRef.deviceId !== observation.source.deviceId || approval.sourceRef.capabilityId !== observation.source.capabilityId ||
      !entry.runtime || observation.clockDomain !== entry.runtime.clockDomain || isAborted(context.signal) || !context.isCurrent()) return;
    let value: WatchViewValue;
    let end: number;
    try {
      value = parseSignalValue(observation.value, watchViewDescriptor().capabilities[0]!.value) as unknown as WatchViewValue;
      const timing = parseObservationTiming(observation.provenance?.timing);
      const remaining = approval.sourceExpiresAt! - value.emittedAt;
      if (value.generation !== approval.generation || value.emittedAt !== timing.capture.at || remaining <= 0 || remaining > 30000 ||
        timing.capture.clockId !== `watch-owner-${entry.epoch}` || timing.receipt.clockId !== entry.runtime.clockDomain || !timing.mapping) return;
      // Only the SDK's actual conservative clock mapping translates the owner's
      // remaining consent. This narrows an existing local grant, never creates
      // one or equates two page Performance.now origins.
      end = Math.min(approval.expiresAt, timing.mapping.earliest + remaining / (1 + timing.mapping.maxDriftPpm / 1e6));
      if (!Number.isFinite(end)) return;
    } catch { return; }
    if (entry.permit !== approval || !approval.sink || !entry.runtime.setReadiness(approval.sink, 'available', end).ok ||
      isAborted(context.signal) || !context.isCurrent()) return;
    // Public scope and delivery checks can call the local clock. Complete them
    // before the final clock and intrinsic lifetime/age fence.
    const peerEpoch = entry.peer.scope()?.epoch, deliveryCurrent = context.isCurrent();
    const at = time();
    if (at === undefined || at >= end || at < observation.timestamp || at - observation.timestamp > 250 ||
      !deliveryCurrent || !member(entry) || entry.permit !== approval || entry.epoch !== peerEpoch ||
      isAborted(context.signal) || isAborted(approval.controller.signal) || value.generation !== entry.sourceGeneration) return;
    // No observer or clock callout after this final intrinsic lifetime fence.
    const first = approval.phase !== 'active'; approval.expiresAt = end; approval.routeId = context.routeId;
    approval.value = Object.freeze({ ...value }); approval.receivedAt = observation.receivedAt; approval.phase = 'active';
    if (first) send(entry, { type: 'active', generation: approval.generation, request: approval.request });
    record('active'); arm();
  }
  function prepare(entry: Entry, message: Packet) {
    const approval = entry.request;
    if (!approval || approval.phase !== 'requested' || message.request !== approval.request || message.generation !== approval.generation ||
      entry.sourceGeneration !== approval.generation || !entry.receiver || !entry.runtime || !watchViewCompatible(entry.receiver.description())) return;
    const at = time(); if (at === undefined || closed || !member(entry) || entry.request !== approval || at >= approval.expiresAt) return;
    entry.request = undefined; entry.permit = approval; approval.phase = 'preparing'; approval.sourceExpiresAt = message.sourceExpiresAt;
    const runtime = entry.runtime, ownEpoch = revision;
    try {
      const device = displayDescriptor(`watch-display-${entry.epoch}-${approval.request}`); approval.sinkDevice = device;
      const sink = runtime.registerSink({ device, capability: 'view', apply: (value, context) => display(entry, approval, value, context),
        release: (_, context) => {
          if (entry.permit !== approval || approval.routeId && approval.routeId !== context.routeId) return;
          // Route loss is terminal for this approval, never an automatic retry.
          entry.permit = undefined; approval.controller.abort(); cleanupSink(entry, approval); record('stopped'); arm();
        } });
      if (closed || ownEpoch !== revision || entry.permit !== approval || entry.runtime !== runtime || isAborted(approval.controller.signal)) {
        try { if (!runtime.unregister(sink).ok) cleanupFailed = true; } catch { cleanupFailed = true; } return;
      }
      approval.sink = sink;
      if (!runtime.setReadiness(sink, 'available', approval.expiresAt).ok || !approvalCurrent(entry, approval)) { withdraw(entry, 'cancel'); return; }
      const lease = Math.floor(approval.expiresAt - (time() ?? approval.expiresAt));
      const slot = lease >= 1 && entry.receiver.approve({ capability: 'view', sink, sinkDevice: device, sinkCapability: 'view', codec: 'json/2',
        grant: { expiresAt: approval.expiresAt, maxAgeMs: 250, maxHz: 20 }, leaseMs: lease });
      if (slot === false || slot === undefined || !approvalCurrent(entry, approval)) { withdraw(entry, 'cancel'); return; }
      record('approving'); arm();
    } catch { withdraw(entry, 'cancel'); record('unavailable'); }
  }
  function receive(entry: Entry, peer: SharingPeer, text: string) {
    if (entry.peer !== peer || !owned(entry)) return; const scope = peer.scope(); if (!scope) return;
    const message = packet(text, scope.epoch); if (!message || closed) return;
    const at = time(); if (at === undefined || !member(entry)) return; sweep(at); if (closed) return;
    if (options.role === 'owner') {
      if (!sourceCurrent() || source!.paused || message.generation !== source!.generation) return;
      if (message.type === 'cancel') {
        if (entry.request?.request === message.request || entry.permit?.request === message.request) { withdraw(entry); record('cancelled'); arm(); } return;
      }
      const permit = entry.permit;
      if (message.type === 'active' && permit && permit.request === message.request && permit.generation === message.generation) {
        if (approvalCurrent(entry, permit)) { permit.phase = 'active'; record('active'); } return;
      }
      if (message.type !== 'request' || entry.request || entry.permit || message.request! <= entry.lastRequest || requests >= 64) return;
      entry.lastRequest = message.request!; requests++;
      entry.request = { request: message.request!, generation: message.generation, expiresAt: Math.min(at + 30000, source!.expiresAt),
        controller: new AbortController(), phase: 'requested' }; record('requested'); arm();
    } else {
      if (message.type === 'source') {
        if (message.generation < entry.sourceGeneration) return;
        if (message.generation !== entry.sourceGeneration) withdraw(entry);
        entry.sourceGeneration = message.generation; record('ready'); arm(); return;
      }
      if (message.type === 'source-stop' && message.generation === entry.sourceGeneration) {
        withdraw(entry); entry.sourceGeneration = 0; record('stopped'); arm(); return;
      }
      const approval = entry.permit ?? entry.request;
      if (!approval || message.request !== approval.request || message.generation !== approval.generation) return;
      if (message.type === 'prepare') prepare(entry, message);
      else if (message.type === 'declined' || message.type === 'stop') { withdraw(entry); record(message.type === 'declined' ? 'declined' : 'revoked'); arm(); }
    }
  }
  function emit(at: number) {
    const current = source;
    if (!current || current.paused || current.emissions >= 600 || at - lastEmission < 50 || !sourceCurrent(current)) return;
    const stamp = time(); if (stamp === undefined || source !== current || closed || current.paused || isAborted(current.controller.signal) || stamp >= current.expiresAt) return;
    const value = Object.freeze({ x, y, pressed: held, generation: current.generation, emittedAt: stamp });
    sourceValue = value; lastEmission = stamp; current.emissions++; emissions++;
    for (const entry of peers) {
      if (closed || source !== current) break;
      if (entry.permit && approvalCurrent(entry, entry.permit) && sourceCurrent(current) && !current.paused)
        entry.publisher?.publish('view', value, { capturedAt: stamp });
    }
    notify();
  }
  function tick() {
    if (closed || ticking) return; ticking = true;
    try {
      const at = time(); if (at === undefined) return; sweep(at);
      for (const entry of [...peers]) {
        if (!member(entry)) continue; entry.peer.tick(); if (!member(entry)) continue; attach(entry);
        entry.receiver?.tick(); entry.publisher?.tick();
      }
      if (!closed && options.role === 'owner') emit(time() ?? at);
      arm(); notify();
    } finally { ticking = false; }
  }
  function invite(): Promise<boolean> {
    if (options.role !== 'observer' || closed || peers.length) return Promise.resolve(false);
    return operation(async () => {
      const random = webEndpointCrypto.randomBytes(16); if (closed) return false;
      const sessionId = 'sharing-' + Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
      const entry = makeEntry('owner', sessionId); if (closed) return false; peers.push(entry);
      return entry.peer.invite();
    });
  }
  function review(code: string) {
    if (options.role !== 'owner' || closed || busy || cleanupFailed || peers.length >= 2 || attempts >= 32 || typeof code !== 'string') return false;
    attempts++; const id = peers.some(entry => entry.id === 'observer-1') ? 'observer-2' : 'observer-1';
    const entry = makeEntry(id); peers.push(entry); const accepted = entry.peer.review(code);
    if (!accepted || closed || !peers.includes(entry)) { removeEntry(entry); if (!closed) record('invalid'); return false; }
    record('ready'); return !closed && peers.includes(entry);
  }
  function offer(id: string): Promise<boolean> {
    const entry = peers.find(value => value.id === id); if (options.role !== 'owner' || !entry) return Promise.resolve(false);
    return operation(() => entry.peer.offer());
  }
  function accept(id: string, code: string): Promise<boolean> {
    const entry = peers.find(value => value.id === id); if (!entry || typeof code !== 'string') return Promise.resolve(false);
    return operation(() => entry.peer.accept(code));
  }
  function confirm(id: string) {
    if (closed || busy) return false; const entry = peers.find(value => value.id === id); if (!entry) return false;
    const result = entry.peer.confirm(); if (result && member(entry)) { attach(entry); record('ready'); } return !closed && result;
  }
  function startSource(consent: boolean) {
    if (options.role !== 'owner' || consent !== true || closed || busy || cleanupFailed || source || sourceGeneration >= 32 || attempts >= 32) return false;
    const at = time(); if (at === undefined || closed || source) return false;
    attempts++; sourceGeneration++; x = .5; y = .5; held = false; sourceValue = undefined; lastEmission = -Infinity;
    source = { controller: new AbortController(), generation: sourceGeneration, expiresAt: at + 30000, paused: false, emissions: 0 };
    for (const entry of peers) { withdraw(entry, 'stop'); if (sourceCurrent()) send(entry, { type: 'source', generation: sourceGeneration }); }
    if (!sourceCurrent()) return false; record('active'); arm(); return !closed && !!source;
  }
  function input(action: 'left' | 'right' | 'up' | 'down' | 'press' | 'release') {
    if (options.role !== 'owner' || !['left', 'right', 'up', 'down', 'press', 'release'].includes(action) || !sourceCurrent() || source!.paused) return false;
    if (action === 'left') x = Math.max(0, x - .1); if (action === 'right') x = Math.min(1, x + .1);
    if (action === 'up') y = Math.max(0, y - .1); if (action === 'down') y = Math.min(1, y + .1);
    if (action === 'press') held = true; if (action === 'release') held = false;
    notify(); return true;
  }
  function releaseInput() { if (options.role === 'owner') { held = false; notify(); } }
  function pauseUpdates() { if (options.role !== 'owner' || !sourceCurrent() || source!.paused) return false;
    source!.paused = true; held = false; record('paused'); return !closed; }
  function requestDisplay(consent: boolean) {
    const entry = peers[0];
    if (options.role !== 'observer' || consent !== true || closed || busy || cleanupFailed || !entry || !owned(entry) || entry.permit || entry.request ||
      !entry.sourceGeneration || requests >= 64 || !watchViewCompatible(entry.receiver?.description())) return false;
    const at = time(); if (at === undefined || closed || entry.permit || entry.request) return false;
    const approval: Approval = { request: ++requests, generation: entry.sourceGeneration, expiresAt: at + 30000,
      controller: new AbortController(), phase: 'requested' }; entry.request = approval;
    if (!send(entry, { type: 'request', generation: approval.generation, request: approval.request })) { withdraw(entry); record('unavailable'); return false; }
    if (closed || entry.request !== approval || isAborted(approval.controller.signal)) return false;
    record('requested'); arm(); return !closed && entry.request === approval;
  }
  function approveDisplay(id: string, consent: boolean) {
    const entry = peers.find(value => value.id === id), pending = entry?.request;
    if (options.role !== 'owner' || consent !== true || busy || cleanupFailed || !entry || !pending || entry.permit || !sourceCurrent() || source!.paused ||
      pending.generation !== source!.generation || !owned(entry)) return false;
    const at = time(); if (at === undefined || closed || entry.request !== pending || at >= pending.expiresAt || !source) return false;
    entry.request = undefined; entry.permit = pending; pending.phase = 'preparing'; pending.expiresAt = Math.min(pending.expiresAt, source.expiresAt);
    if (!send(entry, { type: 'prepare', generation: pending.generation, request: pending.request, sourceExpiresAt: source.expiresAt })) {
      withdraw(entry, 'stop'); record('unavailable'); return false;
    }
    if (closed || entry.permit !== pending) return false; record('approving'); arm(); return !closed && entry.permit === pending;
  }
  function declineDisplay(id: string) { const entry = peers.find(value => value.id === id);
    if (options.role !== 'owner' || closed || !entry?.request) return false; withdraw(entry, 'declined'); record('declined'); arm(); return true; }
  function revokeDisplay(id: string) { const entry = peers.find(value => value.id === id);
    if (options.role !== 'owner' || closed || !entry?.permit) return false; withdraw(entry, 'stop'); record('revoked'); arm(); return true; }
  function cancelDisplay() { if (options.role !== 'observer' || closed || !peers[0]) return;
    withdraw(peers[0], 'cancel'); record('cancelled'); arm(); }
  function interrupt() {
    if (closed) return;
    if (options.role === 'owner') retireSource('stopped'); else for (const entry of peers) withdraw(entry, 'cancel');
    clearTimer(); record('stopped');
  }
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    let settle!: () => void; closePromise = new Promise<void>(resolve => { settle = resolve; });
    closed = true; revision++; clearTimer(); const previous = source; source = undefined; previous?.controller.abort(); held = false; sourceValue = undefined;
    for (const entry of peers) { lost(entry); void track(() => entry.peer.close(), undefined); }
    record('closed');
    void (async () => { while (issued.size) await Promise.allSettled([...issued]); settle(); })();
    return closePromise;
  }
  function snapshot(): WatchSharingSnapshot {
    const current = options.role === 'observer' ? peers[0]?.permit : undefined, pending = options.role === 'observer' ? peers[0]?.request : undefined;
    const entry = peers[0];
    return Object.freeze({ role: options.role, closed, notice, rawPending, cleanupFailed,
      remainingAttempts: Math.max(0, 32 - attempts), remainingRequests: Math.max(0, 64 - requests),
      peers: Object.freeze(peers.map(peer => Object.freeze({ id: peer.id, label: peer.label, connection: peer.peer.snapshot(),
        ready: options.role === 'owner' ? !!peer.publisher && source !== undefined : !!peer.receiver && !!peer.sourceGeneration && watchViewCompatible(peer.receiver.description()),
        request: peer.request?.request, active: peer.permit?.phase === 'active', epoch: peer.epoch, remoteKeyId: peer.remoteKeyId }))),
      source: Object.freeze({ active: !!source, paused: source?.paused ?? false, generation: sourceGeneration, expiresAt: source?.expiresAt,
        value: sourceValue, emissions, held }),
      view: Object.freeze({ active: current?.phase === 'active', request: current?.request ?? pending?.request,
        expiresAt: current?.expiresAt ?? pending?.expiresAt, value: current?.value, receivedAt: current?.receivedAt,
        sourceStamp: current?.value && entry?.remoteKeyId && entry.epoch ? Object.freeze({ kind: 'owner-page-performance' as const,
          endpointId: entry.remoteKeyId, epoch: entry.epoch, generation: current.value.generation, milliseconds: current.value.emittedAt }) : undefined }),
      transitions: Object.freeze([...transitions]) });
  }
  return Object.freeze({ invite, review, offer, accept, confirm, startSource, input, releaseInput, pauseUpdates,
    requestDisplay, approveDisplay, declineDisplay, cancelDisplay, revokeDisplay, interrupt, tick, snapshot, close });
}
export type WatchSharingTask = ReturnType<typeof createWatchSharingTask>;
