import { AuthenticatedResourcePeer, PeerDataTransport, RemoteResourceReceiver, authenticatedPeerScope,
  createDeviceRuntime, createEphemeralWebIdentity, createReceiverInvitation, decodeManualPeerCode,
  encodeManualPeerCode, encodeReceiverInvitation, parseDeviceDescriptor, receiverInvitationCurrent,
  webEndpointCrypto } from '@101/connect';
import type { AuthorizationRequest, DeviceCapability, DeviceDescriptor, DeviceRuntime, EndpointHandle,
  EndpointIdentity, Observation, ReceiverInvitation, RouteGrant, SignalValue } from '@101/connect';
import { createRememberedDeviceStore } from './remembered-devices.ts';
import type { RememberedBackupHandle, RememberedDeviceSnapshot, RememberedDeviceStoreOptions } from './remembered-devices.ts';
import { readingChoices, readingTable } from '../connections/readings/readings-schema.ts';
import type { ReadingChoice, ReadingTable } from '../connections/readings/readings-schema.ts';

export const ENROLLED_DEVICE_LIMITS = Object.freeze({ attempts: 16, setupMs: 5000, connectionMs: 60000,
  previewMs: 30000, previewResources: 4, previewHz: 20, previewAttempts: 16, tickMs: 20 });
const applicationId = '101-device-inspection', principalId = 'this-browser-device-owner';
export interface EnrolledDeviceHandle { readonly kind: 'enrolled-device' }
export type EnrolledPrimitivePresentation =
  | Readonly<{ type: 'boolean' }>
  | Readonly<{ type: 'scalar'; unit: string }>
  | Readonly<{ type: 'vector'; unit: string; components: readonly string[] }>;
export interface EnrolledResource {
  readonly id: string; readonly semantic: string; readonly label: string; readonly permissions: readonly string[];
  readonly previewable: boolean; readonly schemaVersion: number; readonly unit?: string;
  readonly primitive?: EnrolledPrimitivePresentation;
  readonly reading?: ReadingChoice;
}
export interface EnrolledDeviceView {
  readonly handle: EnrolledDeviceHandle; readonly label: string; readonly resources: readonly EnrolledResource[];
  readonly metadataReady?: boolean;
  readonly preview: 'unapproved' | 'waiting' | 'receiving' | 'stopped';
  readonly values: Readonly<Record<string, SignalValue>>; readonly previewExpiresAt?: number;
  readonly readings: Readonly<Record<string, ReadingTable>>;
}
export interface EnrolledDeviceSnapshot {
  readonly state: 'idle' | 'preparing' | 'reviewing' | 'connected' | 'interrupted' | 'closed';
  readonly outcome: string; readonly invitation?: string; readonly answer?: string;
  readonly candidate?: Readonly<{ phase: 'waiting' | 'comparison' | 'confirmed' | 'connected'; comparison?: string }>;
  readonly current?: EnrolledDeviceView; readonly rawPending: number; readonly timerArmed: boolean;
  readonly remembered?: RememberedDeviceSnapshot;
}
export interface EnrolledDeviceInspectorOptions {
  readonly sessionId: string; readonly now: () => number; readonly wallNow: () => number;
  readonly onChange?: (snapshot: EnrolledDeviceSnapshot) => void;
  /** Cooperative host seams for lifecycle checks. Authentication still requires the actual public classes. */
  readonly createIdentity?: () => Promise<EndpointIdentity>;
  readonly createPeer?: () => PeerDataTransport;
  /** Trusted native-shaped metadata-only storage ports; not processor storage. */
  readonly rememberedStorage?: Omit<RememberedDeviceStoreOptions, 'onChange'>;
}
export interface EnrolledDeviceInspector {
  prepare(): Promise<boolean>; acceptOffer(input: string): Promise<boolean>;
  confirm(wholeDigest: string): boolean; activate(): boolean; cancel(): void;
  preview(capabilities: readonly string[]): boolean; stopPreview(): void;
  remove(handle: EnrolledDeviceHandle): boolean; stop(): void; tick(): void;
  loadRemembered(): Promise<boolean>; rememberCurrent(handle: EnrolledDeviceHandle): Promise<boolean>;
  forgetRemembered(publicKeyId: string): Promise<boolean>; cancelRemembering(): void;
  reviewRememberedExport(): Promise<boolean>; reviewRememberedImport(text: string): Promise<boolean>;
  confirmRememberedBackup(handle: RememberedBackupHandle): Promise<boolean>;
  snapshot(): EnrolledDeviceSnapshot; close(): Promise<void>;
}
function primitivePreviewable(capability: DeviceCapability): boolean {
  return capability.kind !== 'command' && capability.kind !== 'job' &&
    capability.permissions.includes('subscribe') &&
    (capability.value.type === 'boolean' || capability.value.type === 'scalar' || capability.value.type === 'vector');
}
function readingFor(capability: DeviceCapability): ReadingChoice | undefined {
  if (capability.value.type !== 'record' && capability.value.type !== 'array') return;
  // A single validated declaration reuses the existing display policy without
  // imposing that helper's whole-page choice count on primitive device inputs.
  const choice = readingChoices({ schemaVersion: 1, id: 'enrolled-reading-display', label: 'Reading preview', revision: 1,
    adapter: { id: 'app:enrolled-reading-display', version: '1' }, runtime: { platform: 'browser-application' }, capabilities: [capability] })[0];
  return choice?.supported ? choice : undefined;
}
function previewable(capability: DeviceCapability): boolean { return primitivePreviewable(capability) || readingFor(capability) !== undefined; }
function primitivePresentation(capability: DeviceCapability): EnrolledPrimitivePresentation | undefined {
  const schema = capability.value;
  if (schema.type === 'boolean') return Object.freeze({ type: 'boolean' });
  if (schema.type === 'scalar') return Object.freeze({ type: 'scalar', unit: schema.unit });
  if (schema.type === 'vector') return Object.freeze({ type: 'vector', unit: schema.unit, components: Object.freeze([...schema.components]) });
}
/** Formats a delivered primitive using only its validated descriptor schema. */
export function formatEnrolledPrimitiveValue(resource: EnrolledResource, value: SignalValue): string | undefined {
  const unitText = (unit: string) => unit === '1' ? '' : ` ${unit}`;
  const presentation = resource.primitive;
  if (!presentation) return;
  if (presentation.type === 'boolean') return typeof value === 'boolean' ? value ? 'On' : 'Off' : undefined;
  if (presentation.type === 'scalar') return typeof value === 'number' && Number.isFinite(value) ? `${value}${unitText(presentation.unit)}` : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const componentsByName = value as Readonly<Record<string, SignalValue>>;
  const keys = Object.keys(componentsByName);
  if (keys.length !== presentation.components.length || keys.some(key => !presentation.components.includes(key))) return;
  const parts: string[] = [];
  for (const component of presentation.components) {
    const componentValue = componentsByName[component];
    if (typeof componentValue !== 'number' || !Number.isFinite(componentValue)) return;
    parts.push(`${component}: ${componentValue}${unitText(presentation.unit)}`);
  }
  return parts.join(', ');
}
function resourceLabel(capability: DeviceCapability, reading: ReadingChoice | undefined): string {
  if (reading) return reading.label;
  if (capability.kind === 'command') return 'Action';
  if (capability.kind === 'job') return 'Task';
  if (capability.value.type === 'boolean') return 'On/off input';
  if (capability.value.type === 'scalar') return 'Number input';
  if (capability.value.type === 'vector') return 'Multi-value input';
  return 'Other input';
}
/** Reported types supply display labels, never identity, purpose or permission. */
export function inspectEnrolledResources(input: unknown): readonly EnrolledResource[] {
  const device = parseDeviceDescriptor(input), choices = device.capabilities.map(readingFor);
  const labels = device.capabilities.map((capability, index) => resourceLabel(capability, choices[index]));
  const totals = new Map<string, number>(), counts = new Map<string, number>();
  for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1);
  return Object.freeze(device.capabilities.map((capability, index) => {
    let reading = choices[index];
    const primitive = primitivePresentation(capability), baseLabel = labels[index]!;
    const ordinal = (counts.get(baseLabel) ?? 0) + 1; counts.set(baseLabel, ordinal);
    const label = (totals.get(baseLabel) ?? 0) > 1 ? `${baseLabel} ${ordinal}` : baseLabel;
    if (reading && reading.label !== label) reading = Object.freeze({ ...reading, label });
    return Object.freeze({
      id: capability.id, semantic: capability.semantic, label, permissions: Object.freeze([...capability.permissions]),
      previewable: primitivePreviewable(capability) || reading !== undefined, schemaVersion: capability.schemaVersion,
      ...(primitive ? { primitive } : {}),
      ...(reading ? { reading } : {}),
      ...('unit' in capability.value ? { unit: capability.value.unit } : {}),
    });
  }));
}

interface Preview {
  readonly owner: AbortController; readonly grant: Readonly<RouteGrant>; readonly chosen: ReadonlySet<string>;
  readonly sinks: Map<string, EndpointHandle>; readonly sourceRegistrations: Map<string, string>;
  readonly descriptor: Readonly<DeviceDescriptor>; readonly values: Record<string, SignalValue>;
  readonly readings: Record<string, ReadingTable>;
  receiving: boolean;
}
interface Enrollment {
  readonly handle: EnrolledDeviceHandle; readonly owner: AbortController; readonly revision: number;
  readonly bornAt: number; readonly expiresAt: number;
  identity?: EndpointIdentity; invitation?: ReceiverInvitation; peer?: PeerDataTransport;
  auth?: AuthenticatedResourcePeer; receiver?: RemoteResourceReceiver; runtime?: DeviceRuntime;
  descriptor?: Readonly<DeviceDescriptor>; answer?: string; comparison?: string;
  phase: 'waiting' | 'comparison' | 'confirmed' | 'connected';
  preview?: Preview; previewUsed: boolean; previewAttempts: number; retired: boolean;
}

/** This page owns only its explicit manual resource connection. Legacy room observers are borrowed
 * elsewhere. No grants, identities or enrollment are restored; construction is inert. Native setup
 * is reserved through actual Promise settlement, even after prompt cancellation. Trusted synchronous
 * host callbacks are not sandboxed. Closing native RTC uses its actual close/negotiation contract. */
export function createEnrolledDeviceInspector(options: EnrolledDeviceInspectorOptions): EnrolledDeviceInspector {
  if (!options || typeof options.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.sessionId) ||
    typeof options.now !== 'function' || typeof options.wallNow !== 'function') throw new TypeError('Invalid device inspection scope');
  const sessionId = options.sessionId, clock = options.now, wallClock = options.wallNow;
  const identityFactory = options.createIdentity ?? (() => createEphemeralWebIdentity());
  const peerFactory = options.createPeer ?? (() => new PeerDataTransport({ initiator: false, iceServers: [] }));
  const listener = options.onChange;
  let closed = false, revision = 0, attempts = 0, readingClock = false, previousTime = -Infinity, previousWall = -Infinity;
  let state: EnrolledDeviceSnapshot['state'] = 'idle', outcome = 'idle', pending: Enrollment | undefined, current: Enrollment | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, closing: Promise<void> | undefined, mutating = false, notifying = false;
  const tasks = new Set<Promise<unknown>>();
  // The store is inert until an explicit read/save/remove action. Its records
  // are past public key metadata, never candidates or restored connections.
  const remembered = createRememberedDeviceStore({ ...options.rememberedStorage, onChange: () => emit() });
  const active = (record: Enrollment) => !closed && !record.retired && !record.owner.signal.aborted && (pending === record || current === record);
  function snapshot(): EnrolledDeviceSnapshot {
    const candidate = pending;
    const preview = current?.preview;
    return Object.freeze({ state, outcome, rawPending: tasks.size, timerArmed: timer !== undefined, remembered: remembered.snapshot(),
      ...(candidate?.invitation && !candidate.peer ? { invitation: encodeReceiverInvitation(candidate.invitation) } : {}),
      ...(candidate?.answer ? { answer: candidate.answer } : {}),
      ...(candidate?.peer ? { candidate: Object.freeze({ phase: candidate.phase, ...(candidate.comparison ? { comparison: candidate.comparison } : {}) }) } : {}),
      ...(current ? { current: Object.freeze({ handle: current.handle, label: current.descriptor?.label ?? 'Connected device',
        metadataReady: current.descriptor !== undefined,
        resources: current.descriptor ? inspectEnrolledResources(current.descriptor) : Object.freeze([]),
        preview: preview ? preview.receiving ? 'receiving' as const : 'waiting' as const : current.previewUsed ? 'stopped' as const : 'unapproved' as const,
        values: Object.freeze({ ...(preview?.values ?? {}) }), readings: Object.freeze({ ...(preview?.readings ?? {}) }),
        ...(preview ? { previewExpiresAt: preview.grant.expiresAt } : {}),
      }) } : {}),
    });
  }
  function emit(next?: string): void {
    if (next) outcome = next; if (notifying) return; notifying = true;
    try { listener?.(snapshot()); } catch { /* Views cannot supply authority. */ } finally { notifying = false; }
  }
  function disarm(): void { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function track<T>(operation: () => T | Promise<T>): Promise<T> {
    // Reserve BEFORE invoking any synchronous native factory, disconnect or cooperative seam.
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
    const work = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); tasks.add(work);
    try { resolve(operation()); } catch (error) { reject(error); }
    void work.then(() => { tasks.delete(work); emit(); }, () => { tasks.delete(work); emit(); }); return work;
  }
  function retirePreview(record: Enrollment): void {
    const preview = record.preview; record.preview = undefined;
    if (!preview) return;
    preview.owner.abort(); Object.keys(preview.values).forEach(key => delete preview.values[key]);
    Object.keys(preview.readings).forEach(key => delete preview.readings[key]);
    try { record.receiver?.stop(); } catch { /* Authority was retired first. */ }
    for (const handle of preview.sinks.values()) { try { record.runtime?.unregister(handle); } catch { /* Continue all owned cleanup. */ } }
    preview.sinks.clear();
  }
  function retire(record: Enrollment): void {
    if (record.retired) return;
    record.retired = true; if (pending === record) pending = undefined; if (current === record) current = undefined;
    record.owner.abort();
    // Cleanup itself is provisioned before route-release/native callbacks can reenter close().
    void track(async () => {
      retirePreview(record);
      try { record.receiver?.stop(); } catch { /* Continue closing owned resources. */ }
      try { record.runtime?.close(); } catch { /* Continue closing the peer. */ }
      // Own the actual raw disconnect Promise before auth.stop's fire-and-forget disconnect.
      let disconnect: Promise<void> | undefined;
      try { disconnect = record.peer?.disconnect(); } catch { emit('cleanup-unconfirmed'); }
      try { record.auth?.stop(); } catch { emit('cleanup-unconfirmed'); }
      try { await disconnect; } catch { emit('cleanup-unconfirmed'); }
    });
  }
  function stop(): void {
    revision++; disarm(); const records = [pending, current]; pending = undefined; current = undefined;
    remembered.cancel();
    for (const record of records) if (record) retire(record);
    if (!closed) state = 'interrupted'; emit(closed ? 'closed' : 'stopped');
  }
  function invalidClock(): undefined { stop(); outcome = 'invalid-clock'; return undefined; }
  function time(): { at: number; wall: number } | undefined {
    if (closed) return; if (readingClock) return invalidClock(); readingClock = true;
    try {
      // Read the authority deadline clock last, after the independent invitation clock callback.
      const wall = wallClock(), at = clock();
      if (closed) return;
      if (![at, wall].every(value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - 300000) ||
        at < previousTime || wall < previousWall) return invalidClock();
      previousTime = at; previousWall = wall; return { at, wall };
    } catch { return invalidClock(); } finally { readingClock = false; }
  }
  function life(record: Enrollment): boolean {
    if (!active(record)) return false;
    const value = time();
    return !!value && active(record) && value.at < record.expiresAt &&
      (!record.invitation || receiverInvitationCurrent(record.invitation, value.wall));
  }
  function proof(record: Enrollment): boolean {
    if (!life(record) || !record.auth || !record.identity || !record.invitation) return false;
    const scope = authenticatedPeerScope(record.auth);
    return !!scope && life(record) && scope.role === 'receiver' && scope.epoch === record.invitation.epoch &&
      scope.applicationId === applicationId && scope.sessionId === sessionId && scope.localKeyId === record.identity.keyId;
  }
  function arm(): void {
    if (closed || timer !== undefined || !pending && !current) return;
    const owned = setTimeout(() => { if (timer !== owned) return; timer = undefined; tick(); }, ENROLLED_DEVICE_LIMITS.tickMs);
    if (closed || !pending && !current) clearTimeout(owned); else timer = owned;
  }
  function cancelledOutcome<T>(record: Enrollment, work: Promise<T>): Promise<T | undefined> {
    return new Promise(resolve => {
      let done = false;
      const finish = (value?: T) => { if (done) return; done = true; clearTimeout(deadline); record.owner.signal.removeEventListener('abort', abort); resolve(value); };
      const abort = () => finish();
      const deadline = setTimeout(() => { if (active(record)) { retire(record); state = current ? 'connected' : 'interrupted'; emit('setup-unavailable'); } finish(); }, ENROLLED_DEVICE_LIMITS.setupMs);
      record.owner.signal.addEventListener('abort', abort, { once: true });
      if (record.owner.signal.aborted) finish();
      void work.then(value => finish(value), () => finish());
    });
  }
  function cancel(): void { revision++; if (pending) retire(pending); if (!current) disarm(); state = current ? 'connected' : 'idle'; emit('cancelled'); }
  async function prepare(): Promise<boolean> {
    if (closed || tasks.size || attempts >= ENROLLED_DEVICE_LIMITS.attempts) { emit('busy-or-unavailable'); return false; }
    cancel(); const expected = revision, value = time();
    if (!value || closed || revision !== expected) return false;
    const record: Enrollment = { handle: Object.freeze({ kind: 'enrolled-device' }), owner: new AbortController(), revision: expected,
      bornAt: value.at, expiresAt: value.at + ENROLLED_DEVICE_LIMITS.connectionMs, phase: 'waiting', previewUsed: false, previewAttempts: 0, retired: false };
    pending = record; attempts++; state = 'preparing';
    const work = track(async () => {
      if (!life(record)) return;
      const identity = await identityFactory();
      if (!life(record)) return; return identity;
    });
    emit('preparing');
    const identity = await cancelledOutcome(record, work);
    if (!identity || !life(record)) { if (active(record)) { retire(record); state = current ? 'connected' : 'interrupted'; emit('identity-unavailable'); } return false; }
    try {
      record.identity = identity; const observed = time(); if (!observed || !life(record)) return false;
      const invitation = createReceiverInvitation({ applicationId, sessionId, now: Math.floor(observed.wall), randomBytes: webEndpointCrypto.randomBytes });
      if (!life(record)) return false;
      record.invitation = Object.freeze({ ...invitation, expiresAt: Math.floor(observed.wall) + ENROLLED_DEVICE_LIMITS.connectionMs });
      state = 'reviewing'; arm(); emit('invitation-ready'); return active(record);
    } catch { retire(record); state = current ? 'connected' : 'interrupted'; emit('identity-unavailable'); return false; }
  }
  function previewCurrent(record: Enrollment, preview: Preview): boolean {
    if (current !== record || record.preview !== preview || preview.owner.signal.aborted || !proof(record)) return false;
    const value = time(); return !!value && active(record) && record.preview === preview && !preview.owner.signal.aborted && value.at < preview.grant.expiresAt;
  }
  function authorize(record: Enrollment, request: Readonly<AuthorizationRequest>): RouteGrant | undefined {
    const preview = record.preview, descriptor = record.descriptor;
    if (!preview || !descriptor || !previewCurrent(record, preview) || request.principalId !== principalId ||
      request.applicationId !== applicationId || request.sessionId !== sessionId || request.source.deviceId !== descriptor.id ||
      request.source.descriptorRevision !== descriptor.revision || !preview.chosen.has(request.source.capabilityId) ||
      request.sink.deviceId !== preview.descriptor.id || request.sink.descriptorRevision !== preview.descriptor.revision ||
      request.source.capabilityId !== request.sink.capabilityId || request.sink.registrationId !== preview.sinks.get(request.sink.capabilityId)?.id ||
      request.sinkOperation !== 'write' || request.partition !== undefined) return;
    const capability = descriptor.capabilities.find(value => value.id === request.source.capabilityId);
    if (!capability || request.source.schemaVersion !== capability.schemaVersion || request.sink.schemaVersion !== capability.schemaVersion ||
      request.sourceOperation !== 'subscribe') return;
    const pinned = preview.sourceRegistrations.get(capability.id);
    if (pinned !== undefined && pinned !== request.source.registrationId) return;
    if (!previewCurrent(record, preview)) return;
    preview.sourceRegistrations.set(capability.id, request.source.registrationId); return preview.grant;
  }
  async function acceptOffer(input: string): Promise<boolean> {
    const record = pending;
    if (!record?.identity || !record.invitation || record.peer || tasks.size || !life(record)) return false;
    let code: ReturnType<typeof decodeManualPeerCode>;
    try { code = decodeManualPeerCode(input, 'offer', record.invitation.epoch); }
    catch { retire(record); if (!current) disarm(); state = current ? 'connected' : 'interrupted'; emit('invalid-offer'); return false; }
    const work = track(async () => {
      if (!life(record)) return;
      const peer = peerFactory(); record.peer = peer;
      if (!(peer instanceof PeerDataTransport)) throw Error('Use the actual enrolled peer');
      if (!life(record)) { await peer.disconnect(); return; }
      const now = () => { if (!life(record)) throw Error('Retired resource connection'); return previousTime; };
      record.auth = new AuthenticatedResourcePeer({ transport: peer, identity: record.identity!, crypto: webEndpointCrypto,
        epoch: record.invitation!.epoch, applicationId, sessionId, role: 'receiver', now, timeoutMs: ENROLLED_DEVICE_LIMITS.connectionMs });
      if (!life(record)) return;
      const clockId = `devices-preview:${record.invitation!.epoch}`;
      record.runtime = createDeviceRuntime({ now, clockDomain: clockId, maxRegistrations: 8, maxRoutes: 4, maxSubscribers: 4,
        maxPendingDeliveries: 4, authorize: request => authorize(record, request) });
      record.receiver = new RemoteResourceReceiver({ peer: record.auth, epoch: record.invitation!.epoch, runtime: record.runtime,
        clockId, now, principalId, applicationId, sessionId });
      if (!life(record)) return;
      const answer = await peer.acceptOffer(code.description);
      if (!life(record)) return; return encodeManualPeerCode(code.epoch, answer);
    });
    arm(); emit('preparing-answer');
    const answer = await cancelledOutcome(record, work);
    if (!answer || !life(record)) { if (active(record)) { retire(record); if (!current) disarm(); state = current ? 'connected' : 'interrupted'; emit('connection-unavailable'); } return false; }
    record.answer = answer; emit('answer-ready'); return active(record);
  }
  function confirm(wholeDigest: string): boolean {
    const record = pending;
    if (!record?.auth || !life(record) || typeof wholeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(wholeDigest) ||
      wholeDigest !== record.comparison) return false;
    const ok = record.auth.confirmEnrollment(wholeDigest);
    if (!ok || !life(record)) return false;
    record.phase = 'confirmed'; emit('confirmed-here'); return true;
  }
  function activate(): boolean {
    const record = pending;
    if (!record || !proof(record)) return false;
    const incumbent = current;
    // An explicit accepted replacement releases old resources before admission of the new device.
    current = undefined; if (incumbent) retire(incumbent);
    if (!life(record)) { emit('connection-unavailable'); return false; }
    pending = undefined; current = record; record.phase = 'connected'; state = 'connected'; emit('device-enrolled'); return current === record && active(record);
  }
  function preview(ids: readonly string[]): boolean {
    const record = current;
    if (!record?.receiver || !record.runtime || !record.descriptor || record.previewUsed || !proof(record) ||
      record.previewAttempts >= ENROLLED_DEVICE_LIMITS.previewAttempts || !Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype) return false;
    const count = Object.getOwnPropertyDescriptor(ids, 'length')?.value;
    if (!Number.isSafeInteger(count) || count < 1 || count > 4 || Reflect.ownKeys(ids).length !== count + 1) return false;
    const selected: string[] = [];
    for (let index = 0; index < count; index++) {
      const property = Object.getOwnPropertyDescriptor(ids, String(index)); if (!property || !('value' in property) || typeof property.value !== 'string' || property.value.length > 128) return false;
      selected.push(property.value);
    }
    if (new Set(selected).size !== selected.length) return false;
    const capabilities = selected.map(id => record.descriptor!.capabilities.find(value => value.id === id));
    if (capabilities.some(capability => !capability || !previewable(capability))) { emit('preview-unsupported'); return false; }
    const value = time(); if (!value || !proof(record)) return false;
    const expiry = Math.min(record.expiresAt, value.at + ENROLLED_DEVICE_LIMITS.previewMs);
    const grant = Object.freeze({ expiresAt: expiry, maxHz: Math.min(20, ...capabilities.map(capability => capability!.delivery.mode === 'latest' ? capability!.delivery.maxHz : 1000)),
      maxAgeMs: Math.min(250, ...capabilities.map(capability => capability!.delivery.maxAgeMs)) });
    const descriptor = parseDeviceDescriptor({ schemaVersion: 1, id: `devices-sink:${record.invitation!.epoch}`, label: 'This screen input preview', revision: 1,
      adapter: { id: 'app:device-inspector', version: '1.0.0' }, runtime: { platform: 'browser-value-preview' },
      capabilities: capabilities.map(capability => ({ ...capability!, permissions: ['write'] })) });
    const owner = new AbortController(), capture: Preview = { owner, grant, chosen: new Set(selected), descriptor, sinks: new Map(), sourceRegistrations: new Map(),
      values: Object.create(null) as Record<string, SignalValue>, readings: Object.create(null) as Record<string, ReadingTable>, receiving: false };
    record.preview = capture; record.previewUsed = true; record.previewAttempts++;
    try {
      for (const capability of descriptor.capabilities) {
        if (!previewCurrent(record, capture)) throw Error();
        const sourceCapability = capabilities.find(value => value?.id === capability.id)!;
        const reading = readingFor(sourceCapability);
        const handle = record.runtime.registerSink({ device: descriptor, capability: capability.id,
          apply(observation: Observation, context) {
            if (context.signal.aborted || !context.isCurrent() || !previewCurrent(record, capture) || context.signal.aborted) return;
            if (reading) {
              const projected = readingTable(sourceCapability, observation.value);
              if (!projected || context.signal.aborted || !context.isCurrent() || !previewCurrent(record, capture)) return;
              capture.readings[capability.id] = projected;
            } else capture.values[capability.id] = observation.value;
            capture.receiving = true;
            emit(!pending && ['device-enrolled', 'preview-waiting', 'input-received', 'preview-released'].includes(outcome) ? 'input-received' : undefined);
          }, release() { delete capture.values[capability.id]; delete capture.readings[capability.id]; if (record.preview === capture) emit('preview-released'); },
        });
        if (!previewCurrent(record, capture)) { record.runtime.unregister(handle); throw Error(); }
        capture.sinks.set(capability.id, handle); record.runtime.setReadiness(handle, 'available', grant.expiresAt);
      }
      for (const capability of capabilities) {
        if (!previewCurrent(record, capture)) throw Error();
        const approved = record.receiver.approve({ capability: capability!.id, sink: capture.sinks.get(capability!.id)!,
          sinkDevice: descriptor, sinkCapability: capability!.id, grant });
        if (approved === undefined || !previewCurrent(record, capture)) throw Error();
      }
      emit('preview-waiting'); return previewCurrent(record, capture);
    } catch { retirePreview(record); emit('preview-unavailable'); return false; }
  }
  function stopPreview(): void { const record = current; if (record) { retirePreview(record); emit('preview-stopped'); } }
  function remove(handle: EnrolledDeviceHandle): boolean {
    const record = current;
    if (!record || record.handle !== handle) return false;
    retire(record); if (!pending) disarm(); state = pending ? 'reviewing' : 'idle'; emit('device-removing'); return true;
  }
  function tick(): void {
    if (closed) return;
    for (const record of [pending, current]) {
      if (!record || !active(record)) continue;
      if (!life(record)) { if (active(record)) { retire(record); emit('connection-expired'); } continue; }
      try {
        record.auth?.tick(); if (!active(record)) continue;
        const status = record.auth?.status(); if (!active(record)) continue;
        if (status?.phase === 'stopped') { retire(record); emit('connection-lost'); continue; }
        record.comparison = status?.comparisonDigest;
        if (record.auth?.state === 'connected') record.phase = 'connected';
        else if (status?.phase === 'awaiting-enrollment' && record.phase !== 'confirmed') record.phase = 'comparison';
        if (record.preview && !previewCurrent(record, record.preview)) { retirePreview(record); emit('preview-expired'); }
        if (!active(record)) continue;
        record.receiver?.tick(); if (!active(record)) continue;
        const description = record.receiver?.description(); if (description) record.descriptor = description;
        const receiverStatus = record.receiver?.status();
        if (record.preview && receiverStatus && (receiverStatus.stopped || !receiverStatus.active && !receiverStatus.pending &&
          ['incompatible', 'unavailable', 'overload', 'expired', 'clock-unavailable'].includes(receiverStatus.reason))) {
          retirePreview(record); emit('preview-unavailable');
        }
      } catch { if (active(record)) { retire(record); emit('connection-lost'); } }
    }
    if (!pending && !current) { disarm(); if (state !== 'idle') state = 'interrupted'; }
    arm(); emit();
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true; state = 'closed';
    closing = Promise.resolve().then(async () => { while (tasks.size) await Promise.allSettled([...tasks]); });
    if (remembered.snapshot().pending) void track(() => remembered.close());
    else void remembered.close(); // Inert/synchronously retired storage has no issued work to reserve.
    stop(); return closing;
  }
  async function rememberCurrent(handle: EnrolledDeviceHandle): Promise<boolean> {
    const record = current;
    if (!record || record.handle !== handle || !record.descriptor || !proof(record)) return false;
    const authenticated = authenticatedPeerScope(record.auth);
    if (!authenticated || !proof(record)) return false;
    const publicKeyId = authenticated.remoteKeyId, label = record.descriptor.label;
    return track(() => remembered.save({ publicKeyId, label }, { signal: record.owner.signal, isCurrent() {
      if (current !== record || !proof(record) || record.descriptor?.label !== label) return false;
      const actual = authenticatedPeerScope(record.auth);
      return actual?.remoteKeyId === publicKeyId && active(record);
    } }));
  }
  function guarded(operation: () => boolean): boolean {
    if (closed || mutating) return false; mutating = true;
    try { return operation(); } finally { mutating = false; }
  }
  async function guardedAsync(operation: () => Promise<boolean>): Promise<boolean> {
    if (closed || mutating) return false; mutating = true;
    try { return await operation(); } finally { mutating = false; }
  }
  return { prepare: () => guardedAsync(prepare), acceptOffer: input => guardedAsync(() => acceptOffer(input)),
    confirm: digest => guarded(() => confirm(digest)), activate: () => guarded(activate), cancel,
    preview: ids => guarded(() => preview(ids)), stopPreview, remove: handle => guarded(() => remove(handle)),
    loadRemembered: () => guardedAsync(() => track(() => remembered.load())),
    rememberCurrent: handle => guardedAsync(() => rememberCurrent(handle)),
    forgetRemembered: publicKeyId => guardedAsync(() => track(() => remembered.forget(publicKeyId))),
    reviewRememberedExport: () => guardedAsync(() => track(() => remembered.reviewExport())),
    reviewRememberedImport: text => guardedAsync(() => track(() => remembered.reviewImport(text))),
    confirmRememberedBackup: handle => guardedAsync(() => track(() => remembered.confirmBackup(handle))),
    cancelRemembering: () => remembered.cancel(), stop, tick, snapshot, close };
}
