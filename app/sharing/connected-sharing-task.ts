import { createDeviceRuntime, createInputOwnershipController, pointerSourceDescriptor, parseDeviceDescriptor,
  schemasCompatible, PointerResourceProvider, RemoteResourceReceiver, webEndpointCrypto } from '@101/connect';
import type { AuthorizationRequest, DeviceDescriptor, EndpointHandle, EndpointIdentity, InputOwnershipController,
  InputOwnershipRequest, InputOwnershipSnapshot, Observation, PeerConnectionPort, ResourceReference } from '@101/connect';
import { SharingPeer, SHARING_APPLICATION } from './sharing-peer.ts';
import type { SharingPeerSnapshot } from './sharing-peer.ts';

export const CONNECTED_SHARING_PROFILE = 'connected-page-sharing/1';
export const CONNECTED_SHARING_LIMITS = Object.freeze({ participants: 2, attempts: 32, requests: 64, policyChanges: 8,
  transitions: 64, rawPending: 4, resources: 2, maxAgeMs: 100, maxHz: 60, requestMs: 30000 });
export type ConnectedSharingPolicy = 'partitioned' | 'exclusive';
type Notice = 'ready' | 'invalid' | 'unavailable' | 'busy' | 'limit' | 'consent-needed' | 'requested' | 'approving' | 'active' | 'declined' | 'cancelled' | 'revoked' | 'expired' | 'review-changed' | 'policy-changed' | 'stopped' | 'closed';
type Resource = { handle: EndpointHandle; device: DeviceDescriptor; capability: string };
type Permit = { request: number; slotId: string; duration: 30 | 60; expiresAt: number; phase: 'preparing' | 'active'; epoch?: number;
  refs: Map<string, ResourceReference>; samples: Map<string, Observation>; wireSlots: number[] };
type Pending = { request: number; duration: 30 | 60; ownership: InputOwnershipRequest };
type Participant = { id: string; label: string; peer: SharingPeer; receiver?: RemoteResourceReceiver; bridge: Resource[]; sinks: Resource[]; operations: Map<string, number>;
  pending?: Pending; permit?: Permit; lastRequest: number; principalId?: string };
export interface ConnectedSharingPreview {
  readonly kind: 'revoke' | 'policy'; readonly revision: number; readonly policy?: ConnectedSharingPolicy;
  readonly recipients: readonly Readonly<{ slotId: string; sourceId: string; epoch: number }>[];
}
export interface ConnectedSharingSnapshot {
  readonly role: 'owner' | 'participant'; readonly closed: boolean; readonly notice: Notice; readonly rosterFinished: boolean;
  readonly policy: ConnectedSharingPolicy; readonly revision: number; readonly active: boolean; readonly rawPending: number;
  readonly remainingAttempts: number; readonly remainingRequests: number; readonly remainingPolicyChanges: number;
  readonly peers: readonly Readonly<{ id: string; label: string; connection: SharingPeerSnapshot; ready: boolean; requestDuration?: 30 | 60; approving: boolean }>[];
  readonly slots: readonly (InputOwnershipSnapshot['slots'][number] & { readonly held: boolean; readonly position?: Readonly<{ x: number; y: number }>; readonly duration?: 30 | 60 })[];
  readonly participant: Readonly<{ layoutReady: boolean; request?: number; slotId?: string; duration?: 30 | 60; active: boolean; held: boolean; ready: boolean }>;
  readonly preview?: ConnectedSharingPreview; readonly transitions: readonly Notice[];
}
export interface ConnectedSharingOptions {
  role: 'owner' | 'participant'; now: () => number; wallNow: () => number; onChange?: () => void;
  /** Explicit software lifetime-test ports, never native positive qualification. */
  createPeer?: (configuration: RTCConfiguration) => PeerConnectionPort; createIdentity?: () => Promise<EndpointIdentity>;
}
export function connectedPointerCompatible(input: unknown): boolean {
  try {
    const device = parseDeviceDescriptor(input), selected = pointerSourceDescriptor();
    return device.id === selected.id && device.revision === selected.revision && device.schemaVersion === selected.schemaVersion &&
      device.capabilities.length === 2 && selected.capabilities.every(expected => {
        const actual = device.capabilities.find(capability => capability.id === expected.id);
        return !!actual && actual.permissions.includes('subscribe') && actual.delivery.mode === expected.delivery.mode &&
          schemasCompatible(actual, expected) && actual.schemaVersion === expected.schemaVersion;
      });
  } catch { return false; }
}
const sameRef = (a: ResourceReference, b: ResourceReference) => a.registrationId === b.registrationId && a.deviceId === b.deviceId &&
  a.capabilityId === b.capabilityId && a.descriptorRevision === b.descriptorRevision && a.schemaVersion === b.schemaVersion;
function matches(resource: Resource, reference: ResourceReference) {
  return reference.registrationId === resource.handle.id && reference.deviceId === resource.device.id && reference.capabilityId === resource.capability &&
    reference.descriptorRevision === resource.device.revision && reference.schemaVersion === resource.device.capabilities.find(capability => capability.id === resource.capability)?.schemaVersion;
}
type Control = { type: 'request' | 'cancel' | 'prepare' | 'active' | 'stop' | 'declined' | 'layout'; request?: number; slot?: string; duration?: 30 | 60; revision: number; ownerEpoch?: number; policy?: ConnectedSharingPolicy };
function control(text: string, epoch: string): Control | undefined {
  if (text.length > 4096 || new TextEncoder().encode(text).length > 4096) return;
  try {
    const packet: unknown = JSON.parse(text); if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;
    const value = packet as Record<string, unknown>;
    const keys = value.type === 'layout' ? ['p', 'v', 'epoch', 'type', 'revision', 'policy'] :
      value.type === 'request' ? ['p', 'v', 'epoch', 'type', 'revision', 'request', 'slot', 'duration'] :
      value.type === 'active' ? ['p', 'v', 'epoch', 'type', 'revision', 'request', 'slot', 'ownerEpoch'] :
      ['p', 'v', 'epoch', 'type', 'revision', 'request'];
    if (value.p !== CONNECTED_SHARING_PROFILE || value.v !== 1 || value.epoch !== epoch || Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key)) || !['request', 'cancel', 'prepare', 'active', 'stop', 'declined', 'layout'].includes(String(value.type)) ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 9) return;
    if (value.type === 'layout') { if (value.policy !== 'partitioned' && value.policy !== 'exclusive') return; }
    else if (!Number.isSafeInteger(value.request) || Number(value.request) < 1 || Number(value.request) > 64) return;
    if (value.type === 'request' && (!['left', 'right', 'exclusive'].includes(String(value.slot)) || value.duration !== 30 && value.duration !== 60)) return;
    if (value.type === 'active' && (!['left', 'right', 'exclusive'].includes(String(value.slot)) || !Number.isSafeInteger(value.ownerEpoch) || Number(value.ownerEpoch) < 1)) return;
    return value as unknown as Control;
  } catch { return; }
}

/** Volatile page ownership. Bridges consume actual accepted receiver observations. */
export function createConnectedSharingTask(configuration: ConnectedSharingOptions) {
  const fields = Object.getOwnPropertyDescriptors(configuration), keys = ['role', 'now', 'wallNow', 'onChange', 'createPeer', 'createIdentity'];
  if (Object.keys(fields).some(key => !keys.includes(key) || !Object.hasOwn(fields[key], 'value')) ||
    fields.role?.value !== 'owner' && fields.role?.value !== 'participant' || typeof fields.now?.value !== 'function' || typeof fields.wallNow?.value !== 'function' ||
    ['onChange', 'createPeer', 'createIdentity'].some(key => fields[key] && fields[key].value !== undefined && typeof fields[key].value !== 'function')) throw new TypeError('Invalid Sharing options');
  const options = Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))) as unknown as ConnectedSharingOptions;
  let closed = false, busy = false, notifying = false, reading = false, generation = 0, lastTime = -Infinity;
  let rawPending = 0, attempts = 0, requests = 0, policyChanges = 0, revision = 1;
  let policy: ConnectedSharingPolicy = 'partitioned', notice: Notice = 'ready', sessionId: string | undefined, rosterFinished = false;
  let runtime: ReturnType<typeof createDeviceRuntime> | undefined, ownership: InputOwnershipController | undefined;
  let removeOwnership: (() => void) | undefined, outputs: Resource[] = [], preview: ConnectedSharingPreview | undefined, activating: Participant | undefined;
  const peers: Participant[] = [], values = new Map<string, { routeId: string; observation: Observation }>(), transitions: Notice[] = [];
  let local: { request: number; slotId: string; duration: 30 | 60; expiresAt: number; phase: 'requested' | 'preparing' | 'active'; ownerEpoch?: number } | undefined;
  let provider: PointerResourceProvider | undefined, layoutReady = false;
  function notify() { if (notifying) return; notifying = true; try { options.onChange?.(); } catch { /* UI is not consent. */ } finally { notifying = false; } }
  function record(value: Notice) { notice = value; if (transitions.at(-1) !== value) { transitions.push(value); if (transitions.length > 64) transitions.shift(); } notify(); }
  function time(): number | undefined {
    if (closed || reading) return; const epoch = generation; reading = true; let at: number;
    try { at = options.now(); } catch { void close(); return; } finally { reading = false; }
    if (closed || epoch !== generation) return;
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 60000 || at < lastTime) { void close(); return; }
    lastTime = at; return at;
  }
  const reserve = () => { if (rawPending >= 4) return; rawPending++; let released = false;
    return () => { if (!released) { released = true; rawPending--; notify(); } }; };
  function owned(entry: Participant) { return !closed && peers.includes(entry) && !!entry.peer.current(); }
  function grantCurrent(entry: Participant, permit = entry.permit): permit is Permit {
    if (!permit || entry.permit !== permit || !owned(entry)) return false;
    const at = time(); return at !== undefined && !closed && entry.permit === permit && at < permit.expiresAt && !!entry.peer.current();
  }
  function withdrawLocal(send = true) {
    const previous = local; local = undefined; const old = provider; provider = undefined;
    old?.stop(); if (send && previous) peers[0]?.peer.send({ type: 'cancel', revision, request: previous.request });
  }
  function revoke(entry: Participant, send = true) {
    const permit = entry.permit, pending = entry.pending; entry.permit = undefined; entry.pending = undefined;
    if (pending) ownership?.cancel(pending.ownership.id);
    if (runtime) for (const resource of entry.bridge) runtime.setReadiness(resource.handle, 'unavailable');
    const slot = ownership?.snapshot().slots.find(slot => slot.owner?.sourceId === entry.id);
    if (slot?.owner) ownership?.release(slot.id, slot.epoch);
    entry.receiver?.tick();
    if (send && (permit || pending)) entry.peer.send({ type: 'stop', revision, request: permit?.request ?? pending!.request });
  }
  function reconcile() {
    if (!ownership || closed) return; const snapshot = ownership.snapshot();
    for (const entry of peers) {
      const permit = entry.permit;
      if (permit?.phase === 'active' && activating !== entry && !snapshot.slots.some(slot => slot.owner?.sourceId === entry.id && slot.epoch === permit.epoch)) revoke(entry);
      if (entry.pending && !snapshot.slots.some(slot => slot.request?.id === entry.pending!.ownership.id)) {
        if (activating !== entry && !permit) { const id = entry.pending.request; entry.pending = undefined; entry.peer.send({ type: 'declined', revision, request: id }); }
      }
    }
    notify();
  }
  function createPeerEntry(): Participant {
    const entry: Participant = { id: `participant-${peers.length + 1}`, label: `Participant ${peers.length + 1}`, bridge: [], sinks: [], operations: new Map(), lastRequest: 0, peer: undefined as unknown as SharingPeer };
    entry.peer = new SharingPeer({ role: options.role === 'owner' ? 'receiver' : 'source', sessionId, now: () => time() ?? NaN, wallNow: options.wallNow,
      reserve, createPeer: options.createPeer, createIdentity: options.createIdentity, onChange: notify,
      onMessage: (peer, text) => receive(entry, peer, text), onLoss() { if (closed) return; revoke(entry, false); if (options.role === 'participant') { withdrawLocal(false); layoutReady = false; } record('unavailable'); } });
    peers.push(entry); return entry;
  }
  function authorize(request: AuthorizationRequest) {
    if (closed || !runtime || !rosterFinished) return;
    const at = time(); if (at === undefined || closed) return;
    for (const entry of peers) {
      const permit = entry.permit, scope = entry.peer.scope();
      if (!permit || !scope || !grantCurrent(entry, permit) || request.principalId !== entry.principalId) continue;
      // Receiver-created source refs are captured from the real private route only.
      const sink = entry.sinks.find(resource => matches(resource, request.sink));
      if (sink && request.applicationId === SHARING_APPLICATION && request.sessionId === scope.sessionId && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write' && request.partition === undefined) {
        const described = entry.receiver?.description(), capability = described?.capabilities.find(value => value.id === sink.capability);
        if (!described || !capability || !connectedPointerCompatible(described) || request.source.deviceId !== described.id || request.source.capabilityId !== capability.id ||
          request.source.descriptorRevision !== described.revision || request.source.schemaVersion !== capability.schemaVersion) return;
        const captured = permit.refs.get(capability.id); if (captured && !sameRef(captured, request.source)) return;
        if (!captured) permit.refs.set(capability.id, Object.freeze({ ...request.source }));
        if (!grantCurrent(entry, permit)) return; return { expiresAt: permit.expiresAt, maxAgeMs: 100, maxHz: 60 };
      }
      if (request.applicationId === SHARING_APPLICATION && request.sessionId === sessionId && request.partition === (permit.slotId === 'exclusive' ? undefined : permit.slotId) &&
        entry.bridge.some(resource => matches(resource, request.source)) && outputs.some(resource => matches(resource, request.sink)) && ownership?.isApproved(request)) {
        if (!grantCurrent(entry, permit) || !ownership.isApproved(request)) return;
        return { expiresAt: permit.expiresAt, maxAgeMs: 100, maxHz: 60 };
      }
    }
  }
  function buildOutputs() {
    if (!runtime || closed) return; const ownGeneration = generation;
    const template = pointerSourceDescriptor('browser-application');
    const device: DeviceDescriptor = { ...template, id: `connected-play-area-${revision}`, label: 'Shared play area', capabilities: template.capabilities.map(capability => ({ ...capability,
      kind: 'property', permissions: ['write'], ownership: policy === 'partitioned' ? { mode: 'partitioned', partitions: ['left', 'right'] } : { mode: 'exclusive' } })) };
    outputs = device.capabilities.map(capability => {
      const handle = runtime!.registerSink({ device, capability: capability.id, apply(observation, context) {
        const entry = peers.find(entry => entry.permit?.slotId === (context.partition ?? 'exclusive') &&
          entry.bridge.some(resource => resource.handle.id === observation.source.registrationId && resource.capability === capability.id));
        if (!entry || !grantCurrent(entry) || closed || ownGeneration !== generation || context.signal.aborted || !context.isCurrent()) return;
        const at = time(); if (at === undefined || closed || ownGeneration !== generation || !entry.permit || at >= entry.permit.expiresAt || context.signal.aborted || !context.isCurrent()) return;
        values.set(`${context.partition ?? 'exclusive'}:${capability.id}`, { routeId: context.routeId, observation });
      }, release(_reason, context) { const key = `${context.partition ?? 'exclusive'}:${capability.id}`; if (values.get(key)?.routeId === context.routeId) values.delete(key); } });
      runtime!.setReadiness(handle, 'available'); return { handle, device, capability: capability.id };
    });
    const created = createInputOwnershipController({ runtime, applicationId: SHARING_APPLICATION, sessionId: sessionId!, now: () => time() ?? NaN,
      sources: peers.map(entry => ({ id: entry.id, label: entry.label, principalId: entry.principalId!, resources: entry.bridge })), destination: { label: 'Shared play area', resources: outputs } });
    if (closed || generation !== ownGeneration) { created.close(); for (const resource of outputs) runtime.unregister(resource.handle); return; }
    ownership = created; removeOwnership = created.subscribe(reconcile);
  }
  function finishRoster(): boolean {
    if (options.role !== 'owner' || closed || busy || rosterFinished || !peers.length || peers.some(entry => !entry.peer.scope())) return false;
    busy = true; const ownGeneration = generation;
    try {
      if (time() === undefined || closed) return false;
      const created = createDeviceRuntime({ clockDomain: 'connected-sharing-owner', now: () => time() ?? NaN, authorize,
        maxRegistrations: 16, maxRoutes: 8, maxPendingDeliveries: 16 });
      if (closed || generation !== ownGeneration) { created.close(); return false; } runtime = created;
      for (const entry of peers) {
        const scope = entry.peer.scope(); if (!scope || closed) throw Error('lost'); entry.principalId = scope.remoteKeyId;
        const template = pointerSourceDescriptor('browser-application-bridge');
        const device = { ...template, id: `connected-bridge-${entry.id}`, label: entry.label };
        entry.bridge = device.capabilities.map(capability => { const handle = created.registerSource({ device, capability: capability.id }); created.setReadiness(handle, 'unavailable'); return { handle, device, capability: capability.id }; });
        const sinkDevice: DeviceDescriptor = { ...template, id: `connected-receive-${entry.id}`, label: 'Selected page controls', capabilities: template.capabilities.map(capability => ({ ...capability, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } })) };
        entry.sinks = sinkDevice.capabilities.map(capability => {
          const handle = created.registerSink({ device: sinkDevice, capability: capability.id, apply(observation, context) {
            const permit = entry.permit, ref = permit?.refs.get(capability.id);
            if (!permit || !ref || !grantCurrent(entry, permit) || closed || ownGeneration !== generation || context.signal.aborted || !context.isCurrent() ||
              observation.source.registrationId !== ref.registrationId || observation.source.deviceId !== ref.deviceId || observation.source.capabilityId !== ref.capabilityId) return;
            const at = time(); if (at === undefined || closed || entry.permit !== permit || at >= permit.expiresAt || at - observation.timestamp > 100 ||
              observation.clockDomain !== created.clockDomain || context.signal.aborted || !context.isCurrent()) return;
            const resource = entry.bridge.find(resource => resource.capability === capability.id)!;
            // The SDK has mapped this timestamp conservatively. Never recapture it.
            permit.samples.set(capability.id, observation); created.setReadiness(resource.handle, 'available');
            if (!grantCurrent(entry, permit) || context.signal.aborted || !context.isCurrent()) return;
            const operation = (entry.operations.get(capability.id) ?? 0) + 1;
            if (operation > 0xffffffff) { revoke(entry); return; }
            if (capability.delivery.mode === 'reliable') entry.operations.set(capability.id, operation);
            created.publish(resource.handle, observation.value, { timestamp: observation.timestamp, clockDomain: observation.clockDomain, provenance: observation.provenance,
              ...(capability.delivery.mode === 'reliable' ? { operationId: String(operation), deadline: Math.min(permit.expiresAt, observation.timestamp + 100) } : {}) });
          }, release() { const resource = entry.bridge.find(resource => resource.capability === capability.id); if (resource) created.setReadiness(resource.handle, 'unavailable'); entry.permit?.samples.delete(capability.id); } });
          created.setReadiness(handle, 'available'); return { handle, device: sinkDevice, capability: capability.id };
        });
        const auth = entry.peer.current(); if (!auth) throw Error('lost');
        entry.receiver = new RemoteResourceReceiver({ peer: auth, runtime: created, epoch: scope.epoch, clockId: created.clockDomain, now: () => time() ?? NaN,
          principalId: scope.remoteKeyId, applicationId: SHARING_APPLICATION, sessionId: scope.sessionId });
      }
      rosterFinished = true; buildOutputs(); if (closed || generation !== ownGeneration || !ownership) throw Error('lost');
      for (const entry of peers) if (!entry.peer.send({ type: 'layout', revision, policy })) throw Error('lost'); record('ready'); return true;
    } catch { void close(); return false; } finally { busy = false; }
  }
  function receive(entry: Participant, peer: SharingPeer, text: string) {
    if (!owned(entry) || entry.peer !== peer) return; const scope = peer.scope(); if (!scope) return;
    const message = control(text, scope.epoch); if (!message || closed) return;
    if (options.role === 'owner') {
      if (!rosterFinished || !ownership || message.revision !== revision) return;
      if (message.type === 'cancel') {
        if (entry.pending?.request === message.request || entry.permit?.request === message.request) { revoke(entry, false); record('cancelled'); } return;
      }
      if (message.type !== 'request' || entry.permit || entry.pending || message.request! <= entry.lastRequest || requests >= 64 ||
        !ownership.snapshot().slots.some(slot => slot.id === message.slot)) return;
      entry.lastRequest = message.request!; requests++;
      const result = ownership.request(entry.id, message.slot!); if (!result.ok || closed || !owned(entry)) { peer.send({ type: 'declined', revision, request: message.request! }); return; }
      entry.pending = { request: message.request!, duration: message.duration!, ownership: result.value }; record('requested');
    } else {
      if (message.type === 'layout') {
        if (message.revision < revision) return; withdrawLocal(false); revision = message.revision; policy = message.policy!; layoutReady = true; record('ready'); return;
      }
      if (message.revision !== revision || !local || message.request !== local.request) return;
      if (message.type === 'prepare' && local.phase === 'requested') { local.phase = 'preparing'; record('approving'); }
      else if (message.type === 'active' && local.phase === 'preparing' && message.slot === local.slotId && provider?.status().ready) {
        const at = time(); if (at === undefined || !local || at >= local.expiresAt || !owned(entry)) return;
        local.phase = 'active'; local.ownerEpoch = message.ownerEpoch; record('active');
      } else if (message.type === 'stop' || message.type === 'declined') { withdrawLocal(false); record(message.type === 'declined' ? 'declined' : 'revoked'); }
    }
  }
  function request(slotId: string, duration: 30 | 60, consent: boolean): boolean {
    const entry = peers[0]; if (options.role !== 'participant' || closed || busy || !entry || !owned(entry) || !layoutReady || local || requests >= 64 ||
      !['left', 'right', 'exclusive'].includes(slotId) || (policy === 'exclusive' ? slotId !== 'exclusive' : slotId === 'exclusive') || duration !== 30 && duration !== 60 || consent !== true) { record(consent ? 'unavailable' : 'consent-needed'); return false; }
    busy = true; const ownGeneration = generation;
    try {
      const at = time(), auth = entry.peer.current(), scope = entry.peer.scope(); if (at === undefined || !auth || !scope || closed) return false;
      const permission = { request: ++requests, slotId, duration, expiresAt: at + duration * 1000, phase: 'requested' as const }; local = permission;
      const created = new PointerResourceProvider({ peer: auth, epoch: scope.epoch, clockId: 'connected-sharing-source', now: () => time() ?? NaN, platform: 'browser-pointer-events',
        available: () => { const current = time(); return !closed && generation === ownGeneration && local === permission && current !== undefined && current < permission.expiresAt && owned(entry); } });
      if (closed || generation !== ownGeneration || local !== permission) { created.stop(); return false; } provider = created; created.tick();
      if (!entry.peer.send({ type: 'request', revision, request: permission.request, slot: slotId, duration })) { withdrawLocal(false); record('unavailable'); return false; }
      record('requested'); return true;
    } finally { busy = false; }
  }
  function approve(slotId: string): boolean {
    if (options.role !== 'owner' || closed || busy || !ownership || !runtime) return false;
    const entry = peers.find(entry => entry.pending?.ownership.slotId === slotId), pending = entry?.pending;
    if (!entry || !pending || !owned(entry) || !connectedPointerCompatible(entry.receiver?.description())) { record('unavailable'); return false; }
    busy = true;
    try {
      const at = time(); if (at === undefined || closed || entry.pending !== pending || at >= pending.ownership.expiresAt) return false;
      const slot = ownership.snapshot().slots.find(slot => slot.id === slotId); if (slot?.request?.id !== pending.ownership.id || slot.epoch !== pending.ownership.expectedOwnerEpoch) { record('review-changed'); return false; }
      const permit: Permit = { request: pending.request, slotId, duration: pending.duration, expiresAt: at + pending.duration * 1000, phase: 'preparing', refs: new Map(), samples: new Map(), wireSlots: [] };
      entry.permit = permit; for (const resource of entry.bridge) runtime.setReadiness(resource.handle, 'unavailable');
      if (!entry.peer.send({ type: 'prepare', revision, request: permit.request }) || !grantCurrent(entry, permit)) throw Error('lost');
      record('approving'); return true;
    } catch { revoke(entry); record('unavailable'); return false; } finally { busy = false; }
  }
  function bindCandidate(entry: Participant) {
    const permit = entry.permit, pending = entry.pending, receiver = entry.receiver;
    if (!permit || permit.phase !== 'preparing' || permit.wireSlots.length || !pending || !receiver || !receiver.status().clockReady || !grantCurrent(entry, permit)) return;
    const at = time(), slot = ownership?.snapshot().slots.find(slot => slot.id === permit.slotId);
    if (at === undefined || at >= pending.ownership.expiresAt || slot?.request?.id !== pending.ownership.id || slot.epoch !== pending.ownership.expectedOwnerEpoch) return;
    try {
      // A stopped source publisher may have missed an earlier clock probe. Keep
      // this receiver/map/slot watermark and wait for its genuine fresh exchange
      // before allowing the new publisher to emit its first neutral samples.
      for (const sink of entry.sinks) {
        if (!grantCurrent(entry, permit) || !receiver.status().clockReady) throw Error('lost');
        const wireSlot = receiver.approve({ capability: sink.capability, sink: sink.handle, sinkDevice: sink.device, sinkCapability: sink.capability,
          grant: { expiresAt: permit.expiresAt, maxAgeMs: 100, maxHz: 60 }, codec: sink.capability === 'position' ? 'normalized-pointer/1' : 'json/1' });
        if (wireSlot === undefined || !grantCurrent(entry, permit)) throw Error('unavailable'); permit.wireSlots.push(wireSlot);
      }
    } catch { revoke(entry); record('unavailable'); }
  }
  function activate(entry: Participant) {
    const permit = entry.permit, pending = entry.pending;
    if (!ownership || !permit || permit.phase !== 'preparing' || !pending || !grantCurrent(entry, permit) || entry.receiver?.status().active !== 2 || !entry.receiver.status().clockReady) return;
    const at = time(); if (at === undefined || pending.ownership.expiresAt <= at || !['position', 'contact'].every(capability => {
      const sample = permit.samples.get(capability); return sample && at - sample.timestamp <= 100 && (capability !== 'contact' || sample.value === false);
    })) return;
    const slot = ownership.snapshot().slots.find(slot => slot.id === permit.slotId);
    if (slot?.request?.id !== pending.ownership.id || slot.epoch !== pending.ownership.expectedOwnerEpoch) { revoke(entry); record('review-changed'); return; }
    activating = entry;
    try {
      if (!grantCurrent(entry, permit)) return;
      const result = ownership.decide(pending.ownership.id, pending.ownership.expectedOwnerEpoch, true);
      const active = ownership.snapshot().slots.find(slot => slot.id === permit.slotId);
      if (!result.ok || !grantCurrent(entry, permit) || active?.owner?.sourceId !== entry.id) { revoke(entry); record('unavailable'); return; }
      permit.phase = 'active'; permit.epoch = active.epoch; entry.pending = undefined; reconcile();
      if (!grantCurrent(entry, permit) || !entry.peer.send({ type: 'active', revision, request: permit.request, slot: permit.slotId, ownerEpoch: active.epoch })) { revoke(entry); return; }
      record('active');
    } finally { activating = undefined; }
  }
  function decline(slotId: string): boolean {
    const entry = peers.find(entry => entry.pending?.ownership.slotId === slotId), pending = entry?.pending;
    if (!ownership || !entry || !pending || closed || busy || entry.permit) return false;
    const result = ownership.decide(pending.ownership.id, pending.ownership.expectedOwnerEpoch, false); if (!result.ok) return false;
    entry.pending = undefined; entry.peer.send({ type: 'declined', revision, request: pending.request }); record('declined'); return true;
  }
  function makePreview(kind: 'revoke' | 'policy', slotId?: string, nextPolicy?: ConnectedSharingPolicy): boolean {
    if (!ownership || closed || busy) return false;
    const recipients = ownership.snapshot().slots.filter(slot => slot.owner && (kind === 'policy' || slot.id === slotId)).map(slot => ({ slotId: slot.id, sourceId: slot.owner!.sourceId, epoch: slot.epoch }));
    if (kind === 'revoke' && !recipients.length || kind === 'policy' && (nextPolicy === policy || policyChanges >= 8)) return false;
    preview = Object.freeze({ kind, revision, ...(nextPolicy ? { policy: nextPolicy } : {}), recipients: Object.freeze(recipients.map(recipient => Object.freeze(recipient))) }); notify(); return true;
  }
  function confirmPreview(value: ConnectedSharingPreview): boolean {
    if (closed || busy || !ownership || !runtime || preview !== value || value.revision !== revision) return false;
    const current = ownership.snapshot().slots.filter(slot => slot.owner && (value.kind === 'policy' || value.recipients.some(recipient => recipient.slotId === slot.id))).map(slot => ({ slotId: slot.id, sourceId: slot.owner!.sourceId, epoch: slot.epoch }));
    if (JSON.stringify(current) !== JSON.stringify(value.recipients)) { record('review-changed'); return false; }
    busy = true;
    try {
      preview = undefined;
      if (value.kind === 'revoke') { for (const recipient of value.recipients) { const entry = peers.find(entry => entry.id === recipient.sourceId); if (entry) revoke(entry); } record('revoked'); }
      else {
        for (const entry of peers) revoke(entry); removeOwnership?.(); ownership.close(); ownership = undefined;
        for (const resource of outputs) runtime.unregister(resource.handle); outputs = []; values.clear();
        policy = value.policy!; revision++; policyChanges++; buildOutputs();
        for (const entry of peers) entry.peer.send({ type: 'layout', revision, policy }); record('policy-changed');
      }
      return !closed;
    } finally { busy = false; }
  }
  function tick() {
    if (closed || busy) return; const at = time(); if (at === undefined || closed) return;
    for (const entry of peers) entry.peer.tick(); if (closed) return;
    if (options.role === 'participant') {
      if (local && at >= local.expiresAt) { withdrawLocal(); record('expired'); }
      provider?.tick(); if (provider?.status().stopped) { withdrawLocal(); record('unavailable'); }
    } else {
      for (const entry of peers) {
        if (entry.pending && at >= entry.pending.ownership.expiresAt) { revoke(entry); record('expired'); }
        if (entry.permit && !grantCurrent(entry)) { revoke(entry); record('expired'); }
        entry.receiver?.tick();
        if (entry.permit && (entry.receiver?.status().stopped || entry.permit.phase === 'active' && entry.receiver?.status().active !== 2)) { revoke(entry); record('unavailable'); }
        bindCandidate(entry);
        activate(entry);
      }
      ownership?.tick(); runtime?.flush(); reconcile();
    }
  }
  function input(action: 'left' | 'right' | 'up' | 'down' | 'press' | 'release'): boolean {
    const entry = peers[0], permission = local, at = time();
    if (options.role !== 'participant' || closed || !entry || !permission || permission.phase !== 'active' || at === undefined || at >= permission.expiresAt || !owned(entry)) return false;
    const driver = provider?.driver(); if (!driver) return false;
    return action === 'press' ? driver.setContact(true) : action === 'release' ? driver.setContact(false) :
      action === 'left' ? driver.nudge(-.08, 0) : action === 'right' ? driver.nudge(.08, 0) : action === 'up' ? driver.nudge(0, -.08) : action === 'down' ? driver.nudge(0, .08) : false;
  }
  function pointer(action: 'begin' | 'move' | 'end', id: number, x = 0, y = 0, width = 1, height = 1): boolean {
    const entry = peers[0], permission = local, at = time();
    if (options.role !== 'participant' || closed || !entry || !permission || permission.phase !== 'active' || at === undefined || at >= permission.expiresAt || !owned(entry)) return false;
    const driver = provider?.driver(); if (!driver) return false;
    return action === 'begin' ? driver.begin(id, x, y, width, height) : action === 'move' ? driver.move(id, x, y, width, height) : driver.end(id);
  }
  function interrupt() {
    if (closed) return; preview = undefined; withdrawLocal(); for (const entry of peers) revoke(entry); values.clear(); record('stopped');
  }
  async function close(): Promise<void> {
    if (!closed) { closed = true; generation++; preview = undefined; withdrawLocal(false);
      for (const entry of peers) { entry.permit = undefined; entry.pending = undefined; }
      removeOwnership?.(); ownership?.close(); for (const entry of peers) entry.receiver?.stop(); runtime?.close(); values.clear(); rosterFinished = false; layoutReady = false; record('closed'); }
    await Promise.all(peers.map(entry => entry.peer.close()));
  }
  function snapshot(): ConnectedSharingSnapshot {
    const current = ownership?.snapshot(), state = provider?.driver()?.state();
    return Object.freeze({ role: options.role, closed, notice, rosterFinished, policy, revision, rawPending,
      active: options.role === 'participant' ? local?.phase === 'active' : !!current?.slots.some(slot => slot.owner),
      remainingAttempts: 32 - attempts, remainingRequests: 64 - requests, remainingPolicyChanges: 8 - policyChanges,
      peers: Object.freeze(peers.map(entry => Object.freeze({ id: entry.id, label: entry.label, connection: entry.peer.snapshot(), ready: !!entry.receiver?.description() && connectedPointerCompatible(entry.receiver.description()),
        requestDuration: entry.pending?.duration, approving: entry.permit?.phase === 'preparing' }))),
      slots: Object.freeze((current?.slots ?? []).map(slot => {
        const position = values.get(`${slot.id}:position`)?.observation.value, permit = peers.find(entry => entry.id === slot.owner?.sourceId)?.permit;
        return Object.freeze({ ...slot, held: values.get(`${slot.id}:contact`)?.observation.value === true, duration: permit?.duration,
          ...(position && typeof position === 'object' && 'x' in position && 'y' in position && typeof position.x === 'number' && typeof position.y === 'number' ? { position: Object.freeze({ x: position.x, y: position.y }) } : {}) });
      })), participant: Object.freeze({ layoutReady, request: local?.request, slotId: local?.slotId, duration: local?.duration, active: local?.phase === 'active', held: state?.contact ?? false, ready: provider?.status().ready ?? false }),
      preview, transitions: Object.freeze([...transitions]) });
  }
  return Object.freeze({ snapshot, tick, close, interrupt, finishRoster, approve, decline, request, input, pointer,
    releaseInput() { provider?.driver()?.release(); }, cancelRequest() { if (options.role === 'participant') { withdrawLocal(); record('cancelled'); } },
    cancelReview(slotId: string) { const entry = peers.find(entry => entry.pending?.ownership.slotId === slotId); if (!entry || entry.permit?.phase === 'active') return false; revoke(entry); record('cancelled'); return true; },
    previewRevoke(slotId: string) { return makePreview('revoke', slotId); }, previewPolicy(next: ConnectedSharingPolicy) { return makePreview('policy', undefined, next); },
    confirmPreview, cancelPreview() { preview = undefined; notify(); },
    async invite() {
      if (options.role !== 'owner' || closed || busy || rosterFinished || peers.length >= 2 || attempts >= 32) return false;
      attempts++; if (!sessionId) { const bytes = webEndpointCrypto.randomBytes(16); sessionId = `sharing-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`; }
      const entry = createPeerEntry(); return entry.peer.invite();
    },
    review(code: string) { if (options.role !== 'participant' || closed || peers.length || attempts >= 32) return false; attempts++; return createPeerEntry().peer.review(code); },
    offer() { return options.role === 'participant' && !closed ? peers[0]?.peer.offer() ?? Promise.resolve(false) : Promise.resolve(false); },
    accept(id: string, code: string) { return !closed ? peers.find(entry => entry.id === id)?.peer.accept(code) ?? Promise.resolve(false) : Promise.resolve(false); },
    confirm(id: string) { return !closed && (peers.find(entry => entry.id === id)?.peer.confirm() ?? false); },
  });
}
export type ConnectedSharingTask = ReturnType<typeof createConnectedSharingTask>;
