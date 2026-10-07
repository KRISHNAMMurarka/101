import { AuthenticatedResourcePeer, PeerDataTransport, RemoteResourcePublisher, RemoteResourceReceiver,
  authenticatedPeerScope, createDeviceRuntime, createEphemeralWebIdentity, createReceiverInvitation,
  decodeManualPeerCode, decodeReceiverInvitation, encodeManualPeerCode, encodeReceiverInvitation,
  parseDeviceDescriptor, parseSignalValue, receiverInvitationCurrent, webEndpointCrypto } from '@101/connect';
import type { AuthorizationRequest, DeliveryContext, DeviceCapability, DeviceDescriptor, DeviceRuntime, EndpointHandle,
  EndpointIdentity, PeerConnectionPort, ReceiverInvitation, RouteGrant, SignalValue } from '@101/connect';
import { pageReadingDescriptor, readingChoices, readingTable } from './readings-schema.ts';
import type { ReadingChoice, ReadingTable } from './readings-schema.ts';

const APPLICATION = 'connections-readings', PREFIX = '101-readings-1.';
const ownerAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const ownerListen = EventTarget.prototype.addEventListener, ownerUnlisten = EventTarget.prototype.removeEventListener;
function nativeSignal(value: unknown): value is AbortSignal {
  try { ownerAborted.call(value); return true; } catch { return false; }
}
type Role = 'source' | 'receiver';
type Phase = 'idle' | 'working' | 'invitation' | 'review' | 'exchange' | 'comparison' | 'confirmed' | 'permissions' | 'waiting' | 'active' | 'stopped' | 'closed';
type Reason = 'idle' | 'invalid' | 'incompatible' | 'unavailable' | 'expired' | 'stopped' | 'hidden' | 'closed' | 'busy' | 'quota' | 'permission';
type Kind = 'invite' | 'offer' | 'answer';
export interface ReadingReview { readonly kind: 'reading-review' }
export interface ReadingsSnapshot {
  readonly phase: Phase; readonly reason: Reason; readonly code: string; readonly comparison?: string;
  readonly confirmed: boolean; readonly resources: readonly ReadingChoice[]; readonly clockReady: boolean;
  readonly rows: readonly (readonly string[])[]; readonly table?: ReadingTable; readonly permissionExpiresAt?: number;
  readonly selected?: string; readonly rawPending: number; readonly cleanupUnconfirmed: boolean;
  readonly owned: Readonly<{ registrations: number; routes: number; producerTimers: number; expiryTimers: number }>;
}
export interface ReadingsTaskOptions {
  role: Role; now: () => number; wallNow: () => number; owner?: AbortSignal;
  onChange?: (snapshot: ReadingsSnapshot) => void;
  apply?: (table: ReadingTable, context: DeliveryContext) => void | Promise<void>; release?: () => void;
  createIdentity?: () => Promise<EndpointIdentity>; createPeer?: (configuration: RTCConfiguration) => PeerConnectionPort;
}
interface Selection { readonly handle: ReadingReview; readonly capability: DeviceCapability; readonly generation: number }
interface Attempt {
  readonly generation: number; readonly bornAt: number; readonly expiresAt: number; readonly invitation: ReceiverInvitation;
  retired: boolean; identity?: EndpointIdentity; peer?: PeerDataTransport; auth?: AuthenticatedResourcePeer;
  runtime?: DeviceRuntime; publisher?: RemoteResourcePublisher; receiver?: RemoteResourceReceiver;
  descriptor?: Readonly<DeviceDescriptor>; selection?: Selection; permit?: Readonly<RouteGrant>;
  sinkDevice?: Readonly<DeviceDescriptor>; sink?: EndpointHandle; sourceRegistration?: string;
  publisherStarted: boolean; lastPublished: number; publications: number; value?: SignalValue; permitUsed: boolean;
}
function encode(kind: Kind, invitation: ReceiverInvitation, payload: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ p: 'connections-readings/1', v: 1, kind,
    invitation: JSON.parse(encodeReceiverInvitation(invitation)), payload }));
  if (bytes.length > 48000) throw Error('invalid');
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = PREFIX + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (result.length > 65536) throw Error('invalid'); return result;
}
function decode(input: string, kind: Kind, wall: number): { invitation: ReceiverInvitation; payload: string } {
  if (typeof input !== 'string' || input.length > 65536 || !input.startsWith(PREFIX)) throw Error('invalid');
  const encoded = input.slice(PREFIX.length); if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw Error('invalid');
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - encoded.length % 4) % 4));
  if (binary.length > 48000 || btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== encoded) throw Error('invalid');
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('invalid');
  const fields = Object.getOwnPropertyDescriptors(parsed);
  if (Object.keys(fields).length !== 5 || !['p', 'v', 'kind', 'invitation', 'payload'].every(key => fields[key] && Object.hasOwn(fields[key], 'value')) ||
    fields.p?.value !== 'connections-readings/1' || fields.v?.value !== 1 || fields.kind?.value !== kind || typeof fields.payload?.value !== 'string') throw Error('invalid');
  const invitation = decodeReceiverInvitation(JSON.stringify(fields.invitation?.value), wall), payload: string = fields.payload.value;
  if (invitation.applicationId !== APPLICATION || !/^readings-[0-9a-f]{32}$/.test(invitation.sessionId) ||
    (kind === 'invite' ? payload !== '' : !payload)) throw Error('invalid');
  return { invitation, payload };
}
/** One volatile page task. Descriptions and pasted codes supply no resource authority. */
export function createReadingsTask(configuration: ReadingsTaskOptions) {
  const fields = Object.getOwnPropertyDescriptors(configuration), keys = ['role', 'now', 'wallNow', 'owner', 'onChange', 'apply', 'release', 'createIdentity', 'createPeer'];
  if (Object.keys(fields).some(key => !keys.includes(key) || !Object.hasOwn(fields[key], 'value')) ||
    fields.role?.value !== 'source' && fields.role?.value !== 'receiver' || typeof fields.now?.value !== 'function' || typeof fields.wallNow?.value !== 'function' ||
    ['onChange', 'apply', 'release', 'createIdentity', 'createPeer'].some(key => fields[key] && fields[key].value !== undefined && typeof fields[key].value !== 'function') ||
    fields.owner?.value !== undefined && !nativeSignal(fields.owner.value)) throw new TypeError('Reading task unavailable');
  const options: Readonly<ReadingsTaskOptions> = Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))) as unknown as ReadingsTaskOptions;
  let attempt: Attempt | undefined, generation = 0, attempts = 0, closed = false, busy = false, cleanupUnconfirmed = false;
  let phase: Phase = 'idle', reason: Reason = 'idle', code = '', comparison: string | undefined, confirmed = false, clockReady = false;
  let table: ReadingTable | undefined, previousTime = -Infinity, readingTime = false, notifying = false, retiring = false, releasing = false;
  let timer: ReturnType<typeof setTimeout> | undefined, setupTimer: ReturnType<typeof setTimeout> | undefined, closing: Promise<void> | undefined;
  const raw = new Set<Promise<unknown>>();
  const aborted = () => options.owner !== undefined && ownerAborted.call(options.owner) === true;
  const own = (entry: Attempt) => !closed && !entry.retired && attempt === entry && entry.generation === generation && !aborted();
  function snapshot(): ReadingsSnapshot {
    const entry = attempt, receiverStatus = entry?.receiver?.status();
    return Object.freeze({ phase, reason, code, ...(comparison ? { comparison } : {}), confirmed,
      resources: entry?.descriptor ? readingChoices(entry.descriptor) : options.role === 'source' ? readingChoices(pageReadingDescriptor()) : Object.freeze([]),
      clockReady, rows: table?.rows ?? Object.freeze([]), ...(table ? { table } : {}),
      ...(entry?.permit ? { permissionExpiresAt: entry.permit.expiresAt } : {}), ...(entry?.selection ? { selected: entry.selection.capability.id } : {}),
      rawPending: raw.size, cleanupUnconfirmed, owned: Object.freeze({ registrations: entry?.sink ? 1 + (receiverStatus ? receiverStatus.active + receiverStatus.pending : 0) : 0,
        routes: receiverStatus ? receiverStatus.active + receiverStatus.pending : 0, producerTimers: 0, expiryTimers: Number(timer !== undefined) + Number(setupTimer !== undefined) }) });
  }
  function changed() { if (notifying) return; notifying = true; try { options.onChange?.(snapshot()); } catch { /* A view grants no authority. */ } finally { notifying = false; } }
  function time(): number | undefined {
    if (closed || readingTime) return;
    const turn = generation; readingTime = true; let at: number;
    try { at = options.now(); } catch { stop('unavailable'); return; } finally { readingTime = false; }
    if (closed || turn !== generation) return;
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 60000 || at < previousTime) { stop('unavailable'); return; }
    previousTime = at; return at;
  }
  function wall(): number | undefined {
    const turn = generation;
    try { const at = options.wallNow(); if (closed || turn !== generation) return;
      if (!Number.isSafeInteger(at) || at < 0) { stop('unavailable'); return; } return at;
    } catch { stop('unavailable'); return; }
  }
  function alive(entry: Attempt): boolean {
    if (!own(entry)) return false; const at = time(), wallAt = wall();
    if (at === undefined || wallAt === undefined || !own(entry)) return false;
    if (at >= entry.expiresAt || !receiverInvitationCurrent(entry.invitation, wallAt)) { stop('expired'); return false; }
    return own(entry);
  }
  function scope(entry: Attempt) {
    if (!alive(entry) || !entry.auth || !entry.identity) return;
    const issued = authenticatedPeerScope(entry.auth);
    if (!issued || !own(entry) || issued.role !== options.role || issued.epoch !== entry.invitation.epoch || issued.applicationId !== APPLICATION ||
      issued.sessionId !== entry.invitation.sessionId || issued.localKeyId !== entry.identity.keyId || !alive(entry)) return;
    return issued;
  }
  function permitted(entry: Attempt): boolean {
    if (!entry.permit || !entry.selection || !scope(entry)) return false;
    const at = time(); return at !== undefined && own(entry) && !!entry.permit && at < entry.permit.expiresAt;
  }
  function track<T>(issue: () => T | Promise<T>): Promise<T> {
    // Reserve before any synchronous native factory or host callout can reenter.
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
    const returned = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); raw.add(returned);
    try { resolve(issue()); } catch (error) { reject(error); }
    void returned.then(() => { raw.delete(returned); changed(); }, () => { raw.delete(returned); changed(); }); return returned;
  }
  function disarm() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function arm() { if (!closed && attempt && timer === undefined) timer = setTimeout(() => { timer = undefined; tick(); arm(); }, 50); }
  function releaseDisplay() {
    table = undefined; if (releasing) return; releasing = true;
    try { options.release?.(); } catch { cleanupUnconfirmed = true; } finally { releasing = false; }
  }
  function disconnect(entry: Attempt) {
    const peer = entry.peer; if (!peer) return Promise.resolve();
    return track(() => peer.disconnect()).catch(() => { cleanupUnconfirmed = true; changed(); });
  }
  function stop(next: Reason = 'stopped') {
    if (retiring || closed && !attempt) return; retiring = true;
    try {
      const allowed: readonly Reason[] = ['idle', 'invalid', 'incompatible', 'unavailable', 'expired', 'stopped', 'hidden', 'closed', 'busy', 'quota', 'permission'];
      reason = allowed.includes(next) ? next : 'stopped';
      generation++; const entry = attempt; attempt = undefined; code = ''; comparison = undefined; confirmed = false; clockReady = false;
      phase = closed ? 'closed' : 'stopped';
      disarm(); if (setupTimer !== undefined) clearTimeout(setupTimer); setupTimer = undefined;
      if (entry) {
        entry.retired = true; entry.permit = undefined; entry.selection = undefined; entry.value = undefined;
        // Fence state and clear data before release, transport or observer callbacks.
        releaseDisplay();
        for (const end of [() => entry.publisher?.stop(), () => entry.receiver?.stop(), () => entry.runtime?.close(), () => entry.auth?.stop()])
          try { end(); } catch { cleanupUnconfirmed = true; }
        void disconnect(entry); entry.sink = undefined; entry.sourceRegistration = undefined;
      } else releaseDisplay();
      changed();
    } finally { retiring = false; }
  }
  async function operation(entry: Attempt, action: () => Promise<boolean>): Promise<boolean> {
    if (!own(entry) || busy || raw.size) { reason = 'busy'; changed(); return false; }
    busy = true; phase = 'working';
    const returned = track(async () => {
      try {
        if (!alive(entry)) return false;
        setupTimer = setTimeout(() => { if (own(entry)) stop('unavailable'); }, 5000);
        const result = await action(); return own(entry) && alive(entry) && result;
      } catch { if (own(entry)) stop('unavailable'); return false; }
      finally {
        if (setupTimer !== undefined) clearTimeout(setupTimer); setupTimer = undefined;
        // A factory can return after Stop disconnected the not-yet-created port.
        // Retain the public peer until the actual setup return, then close it again.
        if (!own(entry)) await disconnect(entry);
        busy = false;
      }
    });
    changed(); return returned;
  }
  function create(invitation: ReceiverInvitation, at: number): Attempt {
    const entry: Attempt = { generation: ++generation, bornAt: at, expiresAt: at + 60000, invitation, retired: false,
      publisherStarted: false, lastPublished: -Infinity, publications: 0, permitUsed: false };
    attempt = entry; attempts++; reason = 'idle'; confirmed = false; comparison = undefined; code = ''; clockReady = false;
    if (options.role === 'source') entry.descriptor = pageReadingDescriptor(invitation.epoch); arm(); return entry;
  }
  function canCreate(): boolean {
    if (closed || aborted() || retiring || attempt || raw.size || busy || cleanupUnconfirmed) { reason = 'busy'; changed(); return false; }
    if (attempts >= 16) { reason = 'quota'; changed(); return false; } return true;
  }
  async function invite(): Promise<boolean> {
    if (options.role !== 'receiver' || !canCreate()) return false;
    const turn = generation, at = time(), wallAt = wall(); if (at === undefined || wallAt === undefined || turn !== generation || !canCreate()) return false;
    let invitation: ReceiverInvitation;
    try {
      const bytes = webEndpointCrypto.randomBytes(16), sessionId = `readings-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
      invitation = createReceiverInvitation({ applicationId: APPLICATION, sessionId, now: wallAt, randomBytes: size => webEndpointCrypto.randomBytes(size) });
    } catch { reason = 'unavailable'; changed(); return false; }
    if (turn !== generation || !canCreate()) return false;
    const entry = create(invitation, at);
    return operation(entry, async () => {
      const identity = await (options.createIdentity ?? createEphemeralWebIdentity)(); if (!alive(entry)) return false;
      entry.identity = identity; code = encode('invite', invitation, ''); phase = 'invitation'; changed(); return own(entry);
    });
  }
  function review(input: string): boolean {
    if (options.role !== 'source' || !canCreate()) return false;
    const turn = generation, at = time(), wallAt = wall(); if (at === undefined || wallAt === undefined || turn !== generation) return false;
    try { const packet = decode(input, 'invite', wallAt); if (!canCreate() || turn !== generation) return false;
      create(packet.invitation, at); phase = 'review'; changed(); return true;
    } catch { reason = 'invalid'; changed(); return false; }
  }
  function install(entry: Attempt, identity: EndpointIdentity) {
    if (!alive(entry)) throw Error('unavailable');
    entry.identity = identity;
    const peer = new PeerDataTransport({ initiator: options.role === 'source', iceServers: [], maxMessageBytes: 65536, createPeer: options.createPeer });
    entry.peer = peer; if (!alive(entry)) { void disconnect(entry); throw Error('unavailable'); }
    const auth = new AuthenticatedResourcePeer({ transport: peer, identity, crypto: webEndpointCrypto, ...entry.invitation,
      role: options.role, now: () => time() ?? NaN, timeoutMs: 60000 });
    entry.auth = auth;
    if (!alive(entry)) { auth.stop(); void disconnect(entry); throw Error('unavailable'); }
    if (options.role === 'source') entry.publisher = new RemoteResourcePublisher({ peer: auth, epoch: entry.invitation.epoch,
      clockId: `reading-source:${entry.invitation.epoch}`, now: () => time() ?? NaN, device: entry.descriptor,
      available: id => permitted(entry) && entry.selection?.capability.id === id });
    else {
      const runtime = createDeviceRuntime({ now: () => time() ?? NaN, clockDomain: `reading-display:${entry.invitation.epoch}`,
        maxRegistrations: 2, maxRoutes: 1, maxSubscribers: 1, maxPendingDeliveries: 1, authorize: request => authorize(entry, request) });
      entry.runtime = runtime;
      entry.receiver = new RemoteResourceReceiver({ peer: auth, runtime, epoch: entry.invitation.epoch, clockId: runtime.clockDomain,
        principalId: identity.keyId, applicationId: APPLICATION, sessionId: entry.invitation.sessionId, now: () => time() ?? NaN });
    }
    if (!alive(entry)) throw Error('unavailable');
  }
  async function offer(): Promise<boolean> {
    const entry = attempt; if (options.role !== 'source' || !entry || phase !== 'review') return false;
    return operation(entry, async () => {
      const identity = await (options.createIdentity ?? createEphemeralWebIdentity)(); if (!alive(entry)) return false;
      install(entry, identity); const description = await entry.peer!.createOffer(); if (!alive(entry)) return false;
      code = encode('offer', entry.invitation, encodeManualPeerCode(entry.invitation.epoch, description)); phase = 'exchange'; changed(); return own(entry);
    });
  }
  async function accept(input: string): Promise<boolean> {
    const entry = attempt; if (!entry || !alive(entry)) return false;
    const wallAt = wall(); if (wallAt === undefined || !own(entry)) return false;
    const kind = options.role === 'receiver' ? 'offer' : 'answer';
    let packet: ReturnType<typeof decode>, description: ReturnType<typeof decodeManualPeerCode>;
    try { packet = decode(input, kind, wallAt);
      if (encodeReceiverInvitation(packet.invitation) !== encodeReceiverInvitation(entry.invitation)) throw Error('invalid');
      description = decodeManualPeerCode(packet.payload, kind, entry.invitation.epoch);
    } catch { reason = 'invalid'; changed(); return false; }
    return operation(entry, async () => {
      if (options.role === 'receiver') {
        if (!entry.identity || entry.peer) return false; install(entry, entry.identity);
        const answer = await entry.peer!.acceptOffer(description.description); if (!alive(entry)) return false;
        code = encode('answer', entry.invitation, encodeManualPeerCode(entry.invitation.epoch, answer));
      } else {
        if (!entry.peer) return false; await entry.peer.acceptAnswer(description.description); if (!alive(entry)) return false; code = '';
      }
      phase = 'exchange'; changed(); return own(entry);
    });
  }
  function confirm(digest: string): boolean {
    const entry = attempt;
    if (!entry || !alive(entry) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || digest !== comparison ||
      !entry.auth?.confirmEnrollment(digest) || !own(entry)) return false;
    confirmed = true; phase = 'confirmed'; changed(); return own(entry);
  }
  function select(id: string): ReadingReview | undefined {
    const entry = attempt; if (!entry?.descriptor || !scope(entry) || entry.permitUsed || typeof id !== 'string') return;
    const choice = readingChoices(entry.descriptor).find(value => value.id === id && value.supported);
    const capability = entry.descriptor.capabilities.find(value => value.id === choice?.id); if (!capability || !own(entry)) return;
    const handle: ReadingReview = Object.freeze({ kind: 'reading-review' });
    entry.selection = { handle, capability, generation }; reason = 'permission'; phase = 'permissions';
    if (options.role === 'source') entry.value = capability.value.type === 'array' ? [{ step: 0, ready: false, mode: 'count-up' }] : { step: 0, ready: false, mode: 'count-up' };
    changed(); return own(entry) && entry.selection?.handle === handle ? handle : undefined;
  }
  function authorize(entry: Attempt, request: Readonly<AuthorizationRequest>): RouteGrant | undefined {
    const selected = entry.selection?.capability, described = entry.descriptor, sinkDevice = entry.sinkDevice;
    if (!selected || !described || !sinkDevice || !entry.identity || !permitted(entry) || request.principalId !== entry.identity.keyId ||
      request.applicationId !== APPLICATION || request.sessionId !== entry.invitation.sessionId || request.partition !== undefined ||
      request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || request.source.deviceId !== described.id ||
      request.source.descriptorRevision !== described.revision || request.source.schemaVersion !== selected.schemaVersion || request.source.capabilityId !== selected.id ||
      request.sink.registrationId !== entry.sink?.id || request.sink.deviceId !== sinkDevice.id || request.sink.capabilityId !== selected.id ||
      request.sink.descriptorRevision !== sinkDevice.revision || request.sink.schemaVersion !== selected.schemaVersion ||
      entry.sourceRegistration !== undefined && entry.sourceRegistration !== request.source.registrationId || !permitted(entry)) return;
    entry.sourceRegistration = request.source.registrationId; return entry.permit;
  }
  function allow(handle: ReadingReview): boolean {
    const entry = attempt, selection = entry?.selection;
    if (!entry || !selection || selection.handle !== handle || selection.generation !== generation || entry.permitUsed || !scope(entry)) return false;
    const at = time(); if (at === undefined || !own(entry)) return false;
    const capability = selection.capability;
    entry.permit = Object.freeze({ expiresAt: Math.min(entry.expiresAt, at + 30000), maxHz: capability.delivery.mode === 'latest' ? Math.min(4, capability.delivery.maxHz) : 4,
      maxAgeMs: Math.min(1000, capability.delivery.maxAgeMs) });
    entry.permitUsed = true; entry.publications = 0; reason = 'permission'; phase = 'waiting';
    if (options.role === 'source') { changed(); return permitted(entry); }
    const runtime = entry.runtime, receiver = entry.receiver; if (!runtime || !receiver || !clockReady) { stop('unavailable'); return false; }
    try {
      const sinkDevice = parseDeviceDescriptor({ schemaVersion: 1, id: `reading-display:${entry.invitation.epoch}`, label: 'This page reading display', revision: 1,
        adapter: { id: 'app:reading-display', version: '1' }, runtime: { platform: 'browser-application' },
        capabilities: [{ ...capability, kind: 'property', permissions: ['write'], ownership: { mode: 'observe' } }] });
      entry.sinkDevice = sinkDevice;
      const sink = runtime.registerSink({ device: sinkDevice, capability: capability.id,
        apply(observation, context) {
          if (context.signal.aborted || !context.isCurrent() || !permitted(entry)) return;
          const projected = readingTable(capability, observation.value); if (!projected || !permitted(entry)) return;
          const applied = track(() => options.apply?.(projected, context));
          return applied.then(() => {
            if (context.signal.aborted || !context.isCurrent() || !permitted(entry)) return;
            table = projected; phase = 'active'; reason = 'permission'; changed();
          }, () => { if (own(entry)) stop('unavailable'); });
        }, release() { if (!retiring) releaseDisplay(); else table = undefined; changed(); } });
      entry.sink = sink;
      if (!permitted(entry)) { runtime.unregister(sink); return false; }
      if (!runtime.setReadiness(sink, 'available', entry.permit.expiresAt).ok || !permitted(entry)) throw Error('unavailable');
      const slot = receiver.approve({ capability: capability.id, sink, sinkDevice, sinkCapability: capability.id, grant: entry.permit });
      if (slot === undefined || !permitted(entry)) throw Error('unavailable'); changed(); return true;
    } catch { if (own(entry)) stop('unavailable'); return false; }
  }
  function setValue(input: unknown): boolean {
    const entry = attempt, capability = entry?.selection?.capability;
    if (options.role !== 'source' || !entry || !capability || !scope(entry)) return false;
    try { const value = parseSignalValue(input, capability.value); if (!readingTable(capability, value) || !own(entry)) return false;
      entry.value = value; return true;
    } catch { return false; }
  }
  function tick() {
    const entry = attempt; if (!entry || !alive(entry)) return;
    try {
      entry.auth?.tick(); if (!own(entry)) return;
      const authentication = entry.auth?.status(); if (!own(entry)) return;
      if (authentication?.phase === 'stopped') { stop('unavailable'); return; }
      if (authentication?.comparisonDigest && authentication.phase === 'awaiting-enrollment') {
        comparison = authentication.comparisonDigest; if (!confirmed) phase = 'comparison';
      }
      if (scope(entry)) {
        if (entry.publisher && !entry.publisherStarted) {
          entry.publisherStarted = entry.publisher.start(); if (!entry.publisherStarted && own(entry)) { stop('incompatible'); return; }
        }
        if (entry.receiver) {
          entry.receiver.tick(); if (!own(entry)) return;
          const described = entry.receiver.description(); if (described) { readingChoices(described); entry.descriptor = described; }
          const status = entry.receiver.status(); clockReady = status.clockReady;
          if (status.stopped) { stop('unavailable'); return; }
          if (entry.permit && !status.active && !status.pending && ['incompatible', 'unavailable', 'overload', 'expired', 'clock-unavailable'].includes(status.reason)) {
            stop(status.reason === 'incompatible' ? 'incompatible' : status.reason === 'expired' ? 'expired' : 'unavailable'); return;
          }
        }
        if (!entry.permit && phase !== 'permissions') phase = 'permissions';
      }
      if (entry.permit) {
        const at = time(); if (at === undefined || !own(entry)) return;
        if (at >= entry.permit.expiresAt) { stop('expired'); return; }
        if (!permitted(entry)) { stop('unavailable'); return; }
        if (entry.publisher) {
          entry.publisher.tick(); if (!own(entry)) return;
          if (entry.publisher.status().stopped) { stop('unavailable'); return; }
          if (entry.publisher.status().active && entry.selection && entry.value !== undefined && at - entry.lastPublished >= 250) {
            if (entry.publications >= 120) { stop('expired'); return; }
            entry.lastPublished = at; entry.publications++;
            if (!entry.publisher.publish(entry.selection.capability.id, entry.value, { capturedAt: at }) && own(entry)) { stop('unavailable'); return; }
            if (own(entry)) phase = 'active';
          }
        }
      }
      changed(); arm();
    } catch { if (own(entry)) stop('unavailable'); }
  }
  const abort = () => { void close(); };
  if (options.owner) ownerListen.call(options.owner, 'abort', abort, { once: true });
  function close(): Promise<void> {
    if (closing) return closing;
    let finish!: () => void; closing = new Promise<void>(resolve => { finish = resolve; });
    // Publish the one barrier before any release or observer can reenter close.
    closed = true; phase = 'closed'; reason = 'closed'; stop('closed');
    try { if (options.owner) ownerUnlisten.call(options.owner, 'abort', abort); } catch { cleanupUnconfirmed = true; }
    void (async () => {
      // A close called from a Stop callback must let that synchronous retirement
      // finish registering actual disconnect work before the drain can settle.
      await Promise.resolve(); while (raw.size) await Promise.allSettled([...raw]);
      await Promise.resolve(); changed(); finish();
    })(); return closing;
  }
  return Object.freeze({ invite, review, offer, accept, confirm, select, allow, setValue, stop, tick, snapshot, close });
}
export type ReadingsTask = ReturnType<typeof createReadingsTask>;
