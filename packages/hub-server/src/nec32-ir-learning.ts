import { createHash } from 'node:crypto';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { AuthorizationRequest, Connection, DeliveryContext, DeviceRuntime, EndpointHandle, Observation, ResourceReference, RouteGrant } from '@101/connect';
import { createNec32IrReceiveGateway, NEC32_IR_RECEIVE_PROFILE } from './nec32-ir-receive-gateway.ts';
import type { Nec32IrReceiveProvider, ReceiveApprovalRequest, ReceiveCandidate, ReceiveGateway, ReceiveGrant, ReceiveScope } from './nec32-ir-receive-gateway.ts';
import { compileNec32IrFrame, createNec32IrEmitterGateway, NEC32_IR_PROFILE } from './nec32-ir-emitter-gateway.ts';
import type { Nec32IrApprovalRequest, Nec32IrEmitterProvider, Nec32IrGateway, Nec32IrGrant } from './nec32-ir-emitter-gateway.ts';

export interface DraftHandle { readonly draft?: never }
export interface ReviewHandle { readonly review?: never }
export type LearningResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: string; issued?: true; emission?: 'uncertain' }>;
export interface CaptureRequest { operationId: string; purpose: string; signal: AbortSignal; deadline: number; retainMs: number }
export interface ReviewCall { purpose: string; signal: AbortSignal; deadline: number }
export interface EmissionRequest { operationId: string; purpose: string; signal: AbortSignal; deadline: number }
export interface CaptureReceipt {
  readonly schemaVersion: 1; readonly scope: ReceiveScope; readonly receiverId: string; readonly receiveProfileId: string;
  readonly receiveGeneration: number; readonly captureOperationId: string; readonly candidateId: string;
  readonly publicSource: ResourceReference; readonly publicSink: ResourceReference; readonly readRouteId: string; readonly readGeneration: number;
  readonly clockDomain: string; readonly sealedAt: number; readonly draftExpiresAt: number; readonly address: number; readonly command: number;
  readonly demodulatedSha256: string; readonly timingCount: 67; readonly totalMicros: 68060;
  readonly canonicalRepresentation: 'reconstructed-selected-nominal'; readonly emitterId: string; readonly emitProfileId: string;
  readonly configuredCarrierHz: 38000; readonly envelopeSha256: string; readonly captureTimeKnown: false;
  readonly receivedCarrier: 'unknown'; readonly measurementAge: 'unknown'; readonly physicalReceipt: 'unverified';
  readonly applianceMeaning: 'unknown'; readonly targetAcknowledgement: false; readonly observedTargetState: false;
}
export interface ReviewApprovalRequest {
  readonly action: 'review-capture'; readonly scope: ReceiveScope; readonly purpose: string; readonly deadline: number;
  readonly receiverId: string; readonly receiveProfileId: string; readonly receiveGeneration: number; readonly captureOperationId: string;
  readonly candidateId: string; readonly publicSource: ResourceReference; readonly publicSink: ResourceReference;
  readonly readRouteId: string; readonly readGeneration: number; readonly captureReceiptSha256: string;
  readonly emitterId: string; readonly emitProfileId: string; readonly codeId: 'learned-capture';
  readonly configuredCarrierHz: 38000; readonly envelopeSha256: string;
}
export interface ReviewGrant { request: ReviewApprovalRequest; signal: AbortSignal; expiresAt: number }
export interface ReviewReceipt {
  readonly schemaVersion: 1; readonly request: ReviewApprovalRequest; readonly approvedAt: number; readonly expiresAt: number;
  readonly captureReceiptSha256: string; readonly codebook: readonly Readonly<{ codeId: 'learned-capture'; address: number; command: number }>[];
  readonly demodulatedSha256: string; readonly envelopeSha256: string;
}
export interface EmissionReceipt {
  readonly schemaVersion: 1; readonly scope: ReceiveScope; readonly captureReceiptSha256: string; readonly reviewReceiptSha256: string;
  readonly codeId: 'learned-capture'; readonly address: number; readonly command: number; readonly operationId: string;
  readonly publicSource: ResourceReference; readonly publicSink: ResourceReference; readonly invokeRouteId: string; readonly invokeGeneration: number;
  readonly demodulatedSha256: string; readonly envelopeSha256: string; readonly effect: 'dispatched'; readonly evidence: 'provider-completed';
  readonly physicalCarrier: 'unverified'; readonly targetAcknowledgement: false; readonly observedState: false;
}
export interface LearningObserver {
  onOwnedRoute(connection: Connection, kind: 'read' | 'invoke', actualSettlement: Promise<void>): void;
  onOwnedApply(actualReturn: Promise<void>, connection: Connection, kind: 'read' | 'invoke'): void;
  onOwnedPrivate(actualReturn: Promise<unknown>, stage: string): void;
}
export interface LearningOptions {
  mode: 'software-learning'; ownerSignal: AbortSignal; scope: ReceiveScope;
  selectedReceiver: { id: string; profileId: typeof NEC32_IR_RECEIVE_PROFILE.id }; receiveProvider: Nec32IrReceiveProvider;
  selectedEmitter: { id: string; profileId: typeof NEC32_IR_PROFILE.id }; emitterProvider: Nec32IrEmitterProvider;
  authorizeReceiver: (request: ReceiveApprovalRequest) => ReceiveGrant | undefined;
  authorizeCapture: (request: ReceiveApprovalRequest) => ReceiveGrant | undefined;
  authorizeReview: (request: ReviewApprovalRequest) => ReviewGrant | undefined;
  authorizeEmitter: (request: Nec32IrApprovalRequest) => Nec32IrGrant | undefined;
  authorizeEmission: (request: Nec32IrApprovalRequest) => Nec32IrGrant | undefined;
  authorizePublic: (request: Readonly<AuthorizationRequest>) => RouteGrant | undefined;
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const aborted = (s: AbortSignal): boolean => Reflect.apply(abortedGetter, s, []);
function signal(s: unknown): s is AbortSignal { try { aborted(s as AbortSignal); return true; } catch { return false; } }
function own(input: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return;
    const out: Record<string, unknown> = Object.create(null);
    if (Reflect.ownKeys(input).length !== keys.length) return;
    for (const key of keys) { const d = Object.getOwnPropertyDescriptor(input, key); if (!d?.enumerable || !('value' in d)) return; out[key] = d.value; }
    return out;
  } catch { return; }
}
const id = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s);
const purpose = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 160;
const deadline = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > performance.now() && n <= performance.now() + 500;
const pass = <T>(value: T): LearningResult<T> => Object.freeze({ ok: true, value });
const fail = (reason: string, issued = false): LearningResult<never> => Object.freeze({ ok: false, reason, ...(issued ? { issued: true as const, emission: 'uncertain' as const } : {}) });
const digest = (domain: string, value: unknown) => createHash('sha256').update(domain + JSON.stringify(value)).digest('hex');
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function reference(handle: EndpointHandle, deviceId: string, capabilityId: string): ResourceReference {
  return Object.freeze({ registrationId: handle.id, deviceId, capabilityId, descriptorRevision: 1, schemaVersion: 1 });
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function projection(c: ReceiveCandidate) {
  return Object.freeze({ candidateSequence: Number(c.candidateId.split('-')[1]), profile: c.profile, address: c.address, command: c.command,
    demodulatedSha256Bytes: Object.freeze(Array.from(Buffer.from(c.demodulatedSha256, 'hex'))), timingCount: c.timingCount, totalMicros: c.totalMicros,
    reviewRequired: c.reviewRequired, captureTimeKnown: c.captureTimeKnown, carrierFrequency: c.carrierFrequency, physicalReceipt: c.physicalReceipt,
    applianceMeaning: c.applianceMeaning, targetAcknowledgement: c.targetAcknowledgement, observedTargetState: c.observedTargetState });
}
function receiverDescription() {
  const value = { type: 'record', fields: {
    candidateSequence: { type: 'scalar', unit: 'candidate', min: 1, max: 16, resolution: 1 },
    profile: { type: 'enum', values: [NEC32_IR_RECEIVE_PROFILE.id] }, address: { type: 'scalar', unit: 'byte', min: 0, max: 255, resolution: 1 },
    command: { type: 'scalar', unit: 'byte', min: 0, max: 255, resolution: 1 },
    demodulatedSha256Bytes: { type: 'array', minItems: 32, maxItems: 32, items: { type: 'scalar', unit: 'byte', min: 0, max: 255, resolution: 1 } },
    timingCount: { type: 'scalar', unit: 'event', min: 67, max: 67, resolution: 1 }, totalMicros: { type: 'scalar', unit: 'us', min: 68060, max: 68060, resolution: 1 },
    reviewRequired: { type: 'boolean' }, captureTimeKnown: { type: 'boolean' }, carrierFrequency: { type: 'enum', values: ['unknown'] },
    physicalReceipt: { type: 'enum', values: ['unverified'] }, applianceMeaning: { type: 'enum', values: ['unknown'] },
    targetAcknowledgement: { type: 'boolean' }, observedTargetState: { type: 'boolean' },
  } };
  return parseDeviceDescriptor({ schemaVersion: 1, id: 'learning-receiver', label: 'Software learning capture', revision: 1,
    adapter: { id: 'example:nec-learning', version: '1.0.0' }, runtime: { platform: 'node-loopback-fixture' },
    capabilities: ['candidate', 'viewer'].map((name, i) => ({ id: name, semantic: 'example:unreviewed-nec-candidate-sequence-sha256/1', schemaVersion: 1,
      kind: 'property', value, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 500 }, permissions: [i ? 'write' : 'read'], ...(i ? { ownership: { mode: 'observe' } } : {}) })) });
}
function emitterDescription() {
  return parseDeviceDescriptor({ schemaVersion: 1, id: 'learning-emitter', label: 'Software reviewed command', revision: 1,
    adapter: { id: 'example:nec-learning', version: '1.0.0' }, runtime: { platform: 'node-loopback-fixture' },
    capabilities: ['reviewed-code', 'emit'].map((name, i) => ({ id: name, semantic: 'example:reviewed-nec-code/1', schemaVersion: 1,
      kind: i ? 'command' : 'event', value: { type: 'enum', values: ['learned-capture'] },
      delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: [i ? 'invoke' : 'subscribe'], ...(i ? { ownership: { mode: 'exclusive' } } : {}) })) });
}
interface Authority { request: { deadline: number }; signal: AbortSignal; expiresAt: number }
interface Draft { handle: DraftHandle; receipt: CaptureReceipt; hash: string; timer: ReturnType<typeof setTimeout> }
interface Reviewed { handle: ReviewHandle; draft: Draft; receipt: ReviewReceipt; hash: string; caller: AbortSignal; grant: Authority; expiry: ReturnType<typeof setTimeout>; detach: () => void; live: boolean }
interface RouteRecord { connection: Connection; settled: Promise<void>; connectionSettled: boolean; apply?: Promise<void>; applySettled: boolean; applyJoined: boolean; generation?: number; detach?: () => void; source: EndpointHandle; sink: EndpointHandle }

/** One transient software session. No physical timing, carrier, appliance or acknowledgement claims. */
export function createNec32IrLearningSession(input: LearningOptions, observerInput?: LearningObserver) {
  const observerData = observerInput === undefined ? undefined : own(observerInput, ['onOwnedRoute', 'onOwnedApply', 'onOwnedPrivate']);
  if (observerInput !== undefined && (!observerData || Object.values(observerData).some(v => typeof v !== 'function'))) throw new TypeError('Invalid ownership observer');
  const observer = observerData as unknown as LearningObserver | undefined;
  const mode = input && Object.getOwnPropertyDescriptor(input, 'mode');
  if (!mode || !('value' in mode) || mode.value !== 'software-learning') throw new TypeError('Expected software-learning mode');
  const data = own(input, ['mode', 'ownerSignal', 'scope', 'selectedReceiver', 'receiveProvider', 'selectedEmitter', 'emitterProvider',
    'authorizeReceiver', 'authorizeCapture', 'authorizeReview', 'authorizeEmitter', 'authorizeEmission', 'authorizePublic']);
  const scopeData = own(data?.scope, ['principalId', 'applicationId', 'sessionId']);
  const receiver = own(data?.selectedReceiver, ['id', 'profileId']), emitter = own(data?.selectedEmitter, ['id', 'profileId']);
  if (!data || !signal(data.ownerSignal) || !scopeData || !Object.values(scopeData).every(id) || !receiver || !id(receiver.id) || receiver.profileId !== NEC32_IR_RECEIVE_PROFILE.id ||
    !emitter || !id(emitter.id) || emitter.profileId !== NEC32_IR_PROFILE.id || ['authorizeReceiver', 'authorizeCapture', 'authorizeReview', 'authorizeEmitter', 'authorizeEmission', 'authorizePublic'].some(k => typeof data[k] !== 'function')) throw new TypeError('Invalid learning options');
  const options = data as unknown as LearningOptions, owner = options.ownerSignal;
  const receiverId = receiver.id as string, emitterId = emitter.id as string;
  const scope = Object.freeze({ ...scopeData }) as unknown as ReceiveScope;
  const rx = options.receiveProvider, tx = options.emitterProvider;
  const providerMethods = (p: object) => Object.fromEntries(['stop', 'close', 'whenSettled'].map(k => { const d = Object.getOwnPropertyDescriptor(p, k); if (!d || !('value' in d) || typeof d.value !== 'function') throw new TypeError('Invalid provider cleanup'); return [k, d.value.bind(p) as () => unknown]; }));
  const rxMethods = providerMethods(rx), txMethods = providerMethods(tx);
  const drafts = new WeakMap<object, Draft>(), reviews = new WeakMap<object, Reviewed>(), signals = new Set<AbortSignal>([owner]);
  const pending = new Set<Promise<unknown>>(), faults: { stage: string; error: unknown }[] = [], routes: RouteRecord[] = [];
  let fenced = aborted(owner), captureAttempts = 0, draftAttempts = 0, reviewAttempts = 0, emissionAttempts = 0, emitterConfigurations = 0;
  let draft: Draft | undefined, reviewed: Reviewed | undefined, closing: Promise<void> | undefined, rxBarrier: Promise<void> | undefined, txBarrier: Promise<void> | undefined;
  let receiverGateway: ReceiveGateway | undefined, emitterGateway: Nec32IrGateway | undefined, runtime: DeviceRuntime | undefined;
  let controlGrant: Authority | undefined, captureGrant: Authority | undefined, activationGrant: Authority | undefined, emissionGrant: Authority | undefined;
  let captureCall: CaptureRequest | undefined, emitCall: EmissionRequest | undefined, emissionController: AbortController | undefined;
  let detachOwner = () => {};
  const live = () => !fenced && !aborted(owner);
  const authorityCurrent = (a: Authority | undefined) => !!a && !aborted(a.signal) && performance.now() < Math.min(a.expiresAt, a.request.deadline);
  const fresh = (s: unknown) => signal(s) && !aborted(s) && !signals.has(s);
  function watch(list: AbortSignal[], action: () => void) {
    for (const s of list) Reflect.apply(EventTarget.prototype.addEventListener, s, ['abort', action, { once: true }]);
    return () => { for (const s of list) Reflect.apply(EventTarget.prototype.removeEventListener, s, ['abort', action]); };
  }
  // Reserve before calling unknown code, including synchronous throws and reentrant close.
  function issue<T>(stage: string, call: () => T | PromiseLike<T>): Promise<T> {
    const reserved = deferred<T>(); pending.add(reserved.promise);
    void reserved.promise.then(() => pending.delete(reserved.promise), error => { pending.delete(reserved.promise); faults.push({ stage, error }); });
    try { const actual = call(); Promise.resolve(actual).then(reserved.resolve, reserved.reject);
      if (actual instanceof Promise && !stage.startsWith('actual-')) try { if (observer && observer.onOwnedPrivate(actual, stage) !== undefined) throw new TypeError('Synchronous passive observer required'); } catch (error) { faults.push({ stage: 'private-observer', error }); void close(); }
    } catch (error) { reserved.reject(error); }
    return reserved.promise;
  }
  function privateBarrier(kind: 'receive' | 'emitter'): Promise<void> {
    const old = kind === 'receive' ? rxBarrier : txBarrier; if (old) return old;
    const reserved = deferred<void>(); if (kind === 'receive') rxBarrier = reserved.promise; else txBarrier = reserved.promise;
    const gateway = kind === 'receive' ? receiverGateway : emitterGateway, methods = kind === 'receive' ? rxMethods : txMethods;
    const start = [issue(kind + ':provider-stop', () => methods.stop()), issue(kind + ':provider-pre-settlement', () => methods.whenSettled())];
    if (gateway) start.push(issue(kind + ':gateway-close', () => gateway.close()));
    void Promise.allSettled(start).then(async () => {
      await Promise.allSettled([issue(kind + ':provider-close', () => methods.close()), issue(kind + ':provider-final-settlement', () => methods.whenSettled())]); reserved.resolve();
    });
    return reserved.promise;
  }
  function invalidateDraft() { if (draft) { drafts.delete(draft.handle); clearTimeout(draft.timer); draft = undefined; } }
  function invalidateReview() { if (reviewed) { reviewed.live = false; reviews.delete(reviewed.handle); clearTimeout(reviewed.expiry); reviewed.detach(); reviewed = undefined; } emissionController?.abort(); }
  function close(): Promise<void> {
    if (closing) return closing;
    const reserved = deferred<void>(); closing = reserved.promise; fenced = true;
    // Automatic retirement observes rejection without replacing the original shared Promise.
    void closing.catch(() => {});
    invalidateDraft(); invalidateReview(); detachOwner(); emissionController?.abort();
    if (runtime) issue('public-runtime-close', () => runtime!.close());
    for (const route of routes) { issue('route-stop', () => route.connection.stop('learning-close')); if (route.detach) issue('route-detach', () => route.detach!()); }
    const barriers = [privateBarrier('receive'), privateBarrier('emitter')];
    void Promise.allSettled(barriers).then(async () => {
      // Includes late apply returns reserved by genuine SDK dispatch and acquisition callouts.
      while (pending.size) await Promise.allSettled([...pending]);
      await Promise.allSettled(routes.map(r => r.settled));
      while (pending.size) await Promise.allSettled([...pending]);
      if (faults.length) {
        const error = new AggregateError(faults.map(f => f.error), 'IR learning close failed after actual settlement joined');
        Object.defineProperty(error, 'failures', { value: Object.freeze(faults.map(f => Object.freeze({ stage: f.stage, error: f.error }))), enumerable: true });
        reserved.reject(error);
      } else reserved.resolve();
    });
    return closing;
  }
  function grant<T extends Authority>(request: T['request'], callback: (request: never) => unknown): T | undefined {
    let returned: unknown; try { returned = callback(request as never); } catch (error) { faults.push({ stage: 'authorization', error }); return; }
    const g = own(returned, ['request', 'signal', 'expiresAt']);
    if (!g || g.request !== request || !fresh(g.signal) || !live() || typeof g.expiresAt !== 'number' || !Number.isFinite(g.expiresAt) || g.expiresAt <= performance.now() || g.expiresAt > request.deadline) return;
    signals.add(g.signal as AbortSignal); return Object.freeze({ request, signal: g.signal, expiresAt: g.expiresAt }) as T;
  }
  function receiveAuthority(request: ReceiveApprovalRequest): ReceiveGrant | undefined {
    if (!captureCall || !live() || aborted(captureCall.signal) || performance.now() >= captureCall.deadline) return;
    const g = grant<ReceiveGrant>(request, (request.action === 'activate-receiver' ? options.authorizeReceiver : options.authorizeCapture) as (request: never) => unknown);
    if (request.action === 'activate-receiver') controlGrant = g; else captureGrant = g;
    return g;
  }
  function emitterAuthority(request: Nec32IrApprovalRequest): Nec32IrGrant | undefined {
    if (!emitCall || !reviewed?.live || !live() || aborted(emitCall.signal) || !authorityCurrent(reviewed.grant) || performance.now() >= emitCall.deadline) return;
    const g = grant<Nec32IrGrant>(request, (request.action === 'activate-emitter' ? options.authorizeEmitter : options.authorizeEmission) as (request: never) => unknown);
    if (request.action === 'activate-emitter') activationGrant = g; else emissionGrant = g;
    return g;
  }
  function publicRuntime() {
    if (!runtime) runtime = createDeviceRuntime({ authorize(request) {
      const route = routes.find(r => r.source.id === request.source.registrationId && r.sink.id === request.sink.registrationId);
      const read = request.sourceOperation === 'read' && request.sinkOperation === 'write';
      const subscribed = request.sourceOperation === 'subscribe' && request.sinkOperation === 'invoke';
      const source = route && reference(route.source, read ? 'learning-receiver' : 'learning-emitter', read ? 'candidate' : 'reviewed-code');
      const sink = route && reference(route.sink, read ? 'learning-receiver' : 'learning-emitter', read ? 'viewer' : 'emit');
      if (!live() || !route || !same(source, request.source) || !same(sink, request.sink) || !same(scope, { principalId: request.principalId, applicationId: request.applicationId, sessionId: request.sessionId }) || request.partition !== undefined || (!read && !subscribed)) return;
      let cap: number;
      if (read) { if (!captureCall || aborted(captureCall.signal) || !authorityCurrent(controlGrant) || !authorityCurrent(captureGrant)) return; cap = Math.min(captureCall.deadline, controlGrant!.expiresAt, captureGrant!.expiresAt); }
      else { if (!emitCall || !reviewed?.live || aborted(emitCall.signal) || !authorityCurrent(reviewed.grant)) return; cap = Math.min(emitCall.deadline, reviewed.grant.expiresAt); }
      let result: unknown; try { result = options.authorizePublic(request); } catch (error) { faults.push({ stage: 'public-authorization', error }); return; }
      const keys = result && typeof result === 'object' && Object.hasOwn(result, 'maxHz') ? ['expiresAt', 'maxAgeMs', 'maxHz'] : ['expiresAt', 'maxAgeMs'];
      const g = own(result, keys); if (!g || !live() || typeof g.expiresAt !== 'number' || g.expiresAt <= performance.now() || !Number.isFinite(g.expiresAt) || typeof g.maxAgeMs !== 'number' || g.maxAgeMs <= 0 || g.maxAgeMs > 500 || !Number.isFinite(g.maxAgeMs) || (g.maxHz !== undefined && (typeof g.maxHz !== 'number' || !Number.isFinite(g.maxHz) || g.maxHz <= 0))) return;
      return { expiresAt: Math.min(g.expiresAt, cap), maxAgeMs: g.maxAgeMs, ...(g.maxHz !== undefined ? { maxHz: Math.min(g.maxHz as number, 10) } : {}) };
    } });
    return runtime;
  }
  function route(source: EndpointHandle, sink: EndpointHandle, read: boolean): RouteRecord {
    const connection = publicRuntime().route({ from: source, to: sink, ...scope, sourceOperation: read ? 'read' : 'subscribe', queueCapacity: 1, leaseMs: 500 });
    if (typeof connection.whenSettled !== 'function') throw new TypeError('Actual SDK settlement required');
    const record: RouteRecord = { connection, settled: connection.whenSettled(), source, sink, connectionSettled: false, applySettled: false, applyJoined: false }; routes.push(record);
    void record.settled.then(() => { record.connectionSettled = true; });
    void issue('route-onClose-acquisition', async () => {
      const detach = connection.onClose(() => { if (!read) emissionController?.abort(); void privateBarrier(read ? 'receive' : 'emitter'); });
      if (typeof detach !== 'function') throw new TypeError('Actual SDK detach required'); record.detach = detach; if (fenced) detach();
    }).catch(() => {});
    try { if (observer && observer.onOwnedRoute(connection, read ? 'read' : 'invoke', record.settled) !== undefined) throw new TypeError('Synchronous passive observer required'); }
    catch (error) { connection.stop('observer-failure'); throw error; }
    if (connection.whenSettled() !== record.settled) throw new TypeError('Actual shared SDK settlement required');
    return record;
  }
  async function captureForReview(input: CaptureRequest): Promise<LearningResult<{ draft: DraftHandle; receipt: CaptureReceipt }>> {
    if (captureAttempts) return fail('quota'); captureAttempts++; draftAttempts++;
    const v = own(input, ['operationId', 'purpose', 'signal', 'deadline', 'retainMs']);
    if (!v || !id(v.operationId) || !purpose(v.purpose) || !fresh(v.signal) || !deadline(v.deadline) || typeof v.retainMs !== 'number' || !Number.isSafeInteger(v.retainMs) || v.retainMs <= 0 || v.retainMs > 60000) return fail('invalid');
    if (!live()) return fail('closed');
    captureCall = Object.freeze({ ...v }) as unknown as CaptureRequest; signals.add(captureCall.signal);
    let record: RouteRecord | undefined, minted: Draft | undefined, publicReadExpiresAt: number | undefined;
    try {
      receiverGateway = createNec32IrReceiveGateway({ ownerSignal: owner, scope, selectedReceiver: { id: receiverId, profileId: NEC32_IR_RECEIVE_PROFILE.id }, selectedProvider: rx,
        authorizeReceiver: receiveAuthority, authorizeCapture: receiveAuthority, onRetire() { if (record && runtime) runtime.setReadiness(record.source, 'unavailable'); } });
      const rt = publicRuntime(), device = receiverDescription();
      const source = rt.registerSource({ device, capability: 'candidate' });
      const sink = rt.registerSink({ device, capability: 'viewer', apply(observation, context) {
        if (!record || record.apply) return Promise.reject(new Error('Duplicate/unbound read delivery'));
        const reserved = deferred<void>(); record.apply = reserved.promise; record.generation = context.generation;
        void reserved.promise.then(() => { record!.applySettled = true; }, () => { record!.applySettled = true; });
        void issue('actual-read-apply', () => reserved.promise).catch(() => {});
        try { if (observer && observer.onOwnedApply(reserved.promise, record.connection, 'read') !== undefined) throw new TypeError('Synchronous passive observer required'); if (!live()) throw new Error('Observer retired session'); } catch (error) { reserved.reject(error); return reserved.promise; }
        void Promise.resolve().then(async () => {
          try {
            if (!c || !value || !captureCall || !live() || aborted(captureCall.signal) || !authorityCurrent(controlGrant) || !authorityCurrent(captureGrant) || performance.now() >= captureCall.deadline || !context.isCurrent() || aborted(context.signal) || context.routeId !== record!.connection.id || !Number.isSafeInteger(context.generation) || context.generation < 1 ||
              (controlGrant!.request as ReceiveApprovalRequest).generation !== (captureGrant!.request as ReceiveApprovalRequest).generation || (captureGrant!.request as ReceiveApprovalRequest).operationId !== captureCall.operationId || receiverGateway!.status().phase !== 'ready' ||
              !same(observation.source, { registrationId: source.id, deviceId: 'learning-receiver', capabilityId: 'candidate' }) || observation.quality !== 'valid' || !same(observation.value, value)) throw new Error('Stale read authority');
            const compiled = compileNec32IrFrame(c.address, c.command), nominal = new Uint8Array(274), view = new DataView(nominal.buffer);
            nominal.set([73, 82, 82, 49]); view.setUint16(4, 67, false); compiled.timings.forEach((n, i) => view.setUint32(6 + i * 4, n, false));
            if (createHash('sha256').update(nominal).digest('hex') !== c.demodulatedSha256 || c.timingCount !== 67 || c.totalMicros !== 68060 || c.profile !== NEC32_IR_RECEIVE_PROFILE.id) throw new Error('Canonical capture mismatch');
            const now = performance.now();
            // Seal only under the original capture/public bounds; inert retention starts here.
            if (!live() || aborted(captureCall.signal) || aborted(controlGrant!.signal) || aborted(captureGrant!.signal) || aborted(context.signal) ||
              now >= Math.min(captureCall.deadline, controlGrant!.request.deadline, controlGrant!.expiresAt, captureGrant!.request.deadline, captureGrant!.expiresAt, publicReadExpiresAt ?? -Infinity) ||
              !context.isCurrent() || context.routeId !== record!.connection.id || context.generation !== record!.generation ||
              (controlGrant!.request as ReceiveApprovalRequest).generation !== (captureGrant!.request as ReceiveApprovalRequest).generation ||
              (captureGrant!.request as ReceiveApprovalRequest).operationId !== captureCall.operationId || receiverGateway!.status().phase !== 'ready' ||
              !same(observation.source, { registrationId: source.id, deviceId: 'learning-receiver', capabilityId: 'candidate' }) || !same(observation.value, value)) throw new Error('Expired or stale read authority at seal');
            const receipt: CaptureReceipt = Object.freeze({ schemaVersion: 1, scope, receiverId: receiverId, receiveProfileId: NEC32_IR_RECEIVE_PROFILE.id,
              receiveGeneration: (captureGrant!.request as ReceiveApprovalRequest).generation, captureOperationId: captureCall.operationId, candidateId: c.candidateId,
              publicSource: reference(source, 'learning-receiver', 'candidate'), publicSink: reference(sink, 'learning-receiver', 'viewer'), readRouteId: context.routeId, readGeneration: context.generation,
              clockDomain: rt.clockDomain, sealedAt: now, draftExpiresAt: now + captureCall.retainMs, address: c.address, command: c.command, demodulatedSha256: c.demodulatedSha256,
              timingCount: 67, totalMicros: 68060, canonicalRepresentation: 'reconstructed-selected-nominal', emitterId: emitterId, emitProfileId: NEC32_IR_PROFILE.id,
              configuredCarrierHz: 38000, envelopeSha256: compiled.envelopeSha256, captureTimeKnown: false, receivedCarrier: 'unknown', measurementAge: 'unknown', physicalReceipt: 'unverified', applianceMeaning: 'unknown', targetAcknowledgement: false, observedTargetState: false });
            const handle = Object.freeze({}); const timer = setTimeout(invalidateDraft, captureCall.retainMs); timer.unref();
            minted = { handle, receipt, hash: digest('IRL1\n', receipt), timer }; draft = minted; drafts.set(handle, minted);
            rt.setReadiness(source, 'unavailable'); await privateBarrier('receive'); reserved.resolve();
          } catch (error) { reserved.reject(error); }
        });
        return reserved.promise;
      }, release() {} });
      rt.setReadiness(source, 'unavailable'); rt.setReadiness(sink, 'available'); record = route(source, sink, true);
      // Acquire the actual shared Connection capability before any private provider start.
      if (!live()) return fail('closed');
      const start = await issue('receiver-start', () => receiverGateway!.start({ purpose: captureCall!.purpose, deadline: captureCall!.deadline }));
      if (!start.ok) return fail(start.reason);
      const captured = await issue('receiver-capture', () => receiverGateway!.capture(start.value, { operationId: captureCall!.operationId, purpose: captureCall!.purpose, signal: captureCall!.signal, deadline: captureCall!.deadline }));
      if (!captured.ok) return fail(captured.reason);
      const c = captured.value, value = projection(c); rt.setReadiness(source, 'available');
      if (!rt.publish(source, value).ok || !record.connection.start().ok) return fail('denied');
      publicReadExpiresAt = record.connection.limits()?.expiresAt;
      if (typeof publicReadExpiresAt !== 'number' || !Number.isFinite(publicReadExpiresAt)) throw new Error('Original public read bound unavailable'); rt.flush();
      if (!record.apply) return fail('provider'); await record.apply; record.applyJoined = true; await record.settled;
      if (!minted || !live() || !drafts.has(minted.handle)) return fail('cancelled');
      return pass(Object.freeze({ draft: minted.handle, receipt: minted.receipt }));
    } catch (error) { faults.push({ stage: 'capture', error }); return fail('provider'); }
    finally { if (record) record.connection.stop('capture-joined'); await privateBarrier('receive'); if (record?.apply) { await Promise.allSettled([record.apply]); record.applyJoined = true; } if (record) await record.settled; }
  }
  async function review(handle: DraftHandle, input: ReviewCall): Promise<LearningResult<{ review: ReviewHandle; receipt: ReviewReceipt }>> {
    if (reviewAttempts) return fail('quota'); reviewAttempts++;
    const d = handle && drafts.get(handle), v = own(input, ['purpose', 'signal', 'deadline']);
    if (!live() || !d || performance.now() >= d.receipt.draftExpiresAt) { if (d) invalidateDraft(); return fail('denied'); }
    if (!v || !purpose(v.purpose) || !fresh(v.signal) || !deadline(v.deadline)) return fail('invalid');
    const caller = v.signal as AbortSignal; signals.add(caller);
    const c = d.receipt, request: ReviewApprovalRequest = Object.freeze({ action: 'review-capture', scope, purpose: v.purpose, deadline: Math.min(v.deadline, c.draftExpiresAt),
      receiverId: c.receiverId, receiveProfileId: c.receiveProfileId, receiveGeneration: c.receiveGeneration, captureOperationId: c.captureOperationId, candidateId: c.candidateId,
      publicSource: c.publicSource, publicSink: c.publicSink, readRouteId: c.readRouteId, readGeneration: c.readGeneration, captureReceiptSha256: d.hash,
      emitterId: c.emitterId, emitProfileId: c.emitProfileId, codeId: 'learned-capture', configuredCarrierHz: 38000, envelopeSha256: c.envelopeSha256 });
    const approval = grant<ReviewGrant>(request, options.authorizeReview as (request: never) => unknown);
    if (!approval || !live() || aborted(caller) || !drafts.has(handle) || performance.now() >= request.deadline) return fail('denied');
    try {
      const codebook = Object.freeze([Object.freeze({ codeId: 'learned-capture' as const, address: c.address, command: c.command })]);
      emitterGateway = createNec32IrEmitterGateway({ ownerSignal: owner, scope, selectedEmitter: { id: emitterId, profileId: NEC32_IR_PROFILE.id, codebook }, selectedProvider: tx,
        authorizeEmitter: emitterAuthority, authorizeEmission: emitterAuthority }); emitterConfigurations++;
      if (!live() || aborted(caller) || !authorityCurrent(approval) || !drafts.has(handle) || performance.now() >= request.deadline) return fail('cancelled');
      const receipt: ReviewReceipt = Object.freeze({ schemaVersion: 1, request, approvedAt: performance.now(), expiresAt: approval.expiresAt, captureReceiptSha256: d.hash, codebook, demodulatedSha256: c.demodulatedSha256, envelopeSha256: c.envelopeSha256 });
      const token = Object.freeze({}), expiry = setTimeout(invalidateReview, Math.max(0, Math.ceil(approval.expiresAt - performance.now()))); expiry.unref();
      reviewed = { handle: token, draft: d, receipt, hash: digest('IRL-REVIEW1\n', receipt), caller, grant: approval, expiry, detach: watch([caller, approval.signal], invalidateReview), live: true };
      reviews.set(token, reviewed); invalidateDraft(); return pass(Object.freeze({ review: token, receipt }));
    } catch (error) { faults.push({ stage: 'review', error }); return fail('provider'); }
  }
  async function emitOnce(handle: ReviewHandle, input: EmissionRequest): Promise<LearningResult<EmissionReceipt>> {
    if (emissionAttempts) return fail('quota'); emissionAttempts++;
    const r = handle && reviews.get(handle), v = own(input, ['operationId', 'purpose', 'signal', 'deadline']);
    if (!live() || !r?.live || !authorityCurrent(r.grant) || aborted(r.caller)) return fail('denied');
    if (!v || typeof v.operationId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(v.operationId) || !purpose(v.purpose) || !fresh(v.signal) || !deadline(v.deadline)) return fail('invalid');
    emitCall = Object.freeze({ ...v, deadline: Math.min(v.deadline, r.grant.expiresAt) }) as unknown as EmissionRequest; signals.add(emitCall.signal);
    emissionController = new AbortController(); signals.add(emissionController.signal); const detach = watch([emitCall.signal, r.caller, r.grant.signal, owner], () => emissionController!.abort());
    let record: RouteRecord | undefined, delivered: LearningResult<EmissionReceipt> | undefined, issued = false;
    try {
      const rt = publicRuntime(), device = emitterDescription(), source = rt.registerSource({ device, capability: 'reviewed-code' });
      const sink = rt.registerSink({ device, capability: 'emit', apply(observation: Observation, context: DeliveryContext) {
        if (!record || record.apply) return Promise.reject(new Error('Duplicate/unbound invoke'));
        const reserved = deferred<void>(); record.apply = reserved.promise; record.generation = context.generation;
        void reserved.promise.then(() => { record!.applySettled = true; }, () => { record!.applySettled = true; }); void issue('actual-invoke-apply', () => reserved.promise).catch(() => {});
        try { if (observer && observer.onOwnedApply(reserved.promise, record.connection, 'invoke') !== undefined) throw new TypeError('Synchronous passive observer required'); if (!live()) throw new Error('Observer retired session'); } catch (error) { reserved.reject(error); return reserved.promise; }
        void Promise.resolve().then(async () => {
          try {
            if (!live() || !r.live || !context.isCurrent() || aborted(context.signal) || emissionController!.signal.aborted || !authorityCurrent(r.grant) || !authorityCurrent(activationGrant) || performance.now() >= emitCall!.deadline || context.routeId !== record!.connection.id || !Number.isSafeInteger(context.generation) || context.generation < 1 || context.operationId !== emitCall!.operationId || observation.value !== 'learned-capture' || !same(observation.source, { registrationId: source.id, deviceId: 'learning-emitter', capabilityId: 'reviewed-code' })) throw new Error('Stale invoke authority');
            const cancel = watch([context.signal], () => emissionController!.abort());
            let outcome;
            try { issued = true; outcome = await issue('private-emission', () => emitterGateway!.emit(epoch, { ...emitCall!, codeId: 'learned-capture', signal: emissionController!.signal })); } finally { cancel(); }
            if (!outcome.ok) delivered = fail(outcome.reason, !!outcome.issued);
            else if (!live() || !r.live || !context.isCurrent() || emissionController!.signal.aborted || !authorityCurrent(emissionGrant) || performance.now() >= emitCall!.deadline || outcome.value.frameSha256 !== r.receipt.envelopeSha256) delivered = fail('cancelled', true);
            else { const c = r.draft.receipt; delivered = pass(Object.freeze({ schemaVersion: 1, scope, captureReceiptSha256: r.receipt.captureReceiptSha256, reviewReceiptSha256: r.hash,
              codeId: 'learned-capture', address: c.address, command: c.command, operationId: emitCall!.operationId, publicSource: reference(source, 'learning-emitter', 'reviewed-code'), publicSink: reference(sink, 'learning-emitter', 'emit'), invokeRouteId: context.routeId, invokeGeneration: context.generation,
              demodulatedSha256: c.demodulatedSha256, envelopeSha256: r.receipt.envelopeSha256, effect: 'dispatched', evidence: 'provider-completed', physicalCarrier: 'unverified', targetAcknowledgement: false, observedState: false })); }
            rt.setReadiness(source, 'unavailable'); await privateBarrier('emitter'); reserved.resolve();
          } catch (error) { reserved.reject(error); }
        });
        return reserved.promise;
      }, release() { emissionController?.abort(); } });
      rt.setReadiness(source, 'available'); rt.setReadiness(sink, 'available'); record = route(source, sink, false);
      if (!record.connection.prepare().ok) return fail('denied');
      const activated = await issue('emitter-start', () => emitterGateway!.start({ purpose: emitCall!.purpose, deadline: emitCall!.deadline }));
      if (!activated.ok) return fail(activated.reason); const epoch = activated.value;
      if (!live() || !r.live || !record.connection.activate().ok) return fail('denied');
      if (!rt.publish(source, 'learned-capture', { operationId: emitCall.operationId, deadline: emitCall.deadline }).ok) return fail('provider'); rt.flush();
      if (!record.apply) return fail('provider'); await record.apply; record.applyJoined = true; await record.settled; return delivered ?? fail('provider', issued);
    } catch (error) { faults.push({ stage: 'emit', error }); return fail('provider', issued); }
    finally { detach(); if (record) record.connection.stop('emission-joined'); await privateBarrier('emitter'); if (record?.apply) { await Promise.allSettled([record.apply]); record.applyJoined = true; } if (record) await record.settled; invalidateReview(); }
  }
  detachOwner = watch([owner], () => { void close(); });
  return Object.freeze({ captureForReview, review, emitOnce, close, status: () => Object.freeze({ phase: fenced ? 'closed' : 'active', fenced, captureAttempts, draftAttempts, reviewAttempts, emissionAttempts,
    drafts: draft ? 1 : 0, reviews: reviewed ? 1 : 0, emitterConfigurations, rawPending: pending.size, publicRoutes: Object.freeze(routes.map(r => Object.freeze({ routeId: r.connection.id, generation: r.generation ?? null, state: r.connection.status().state, actualApplyReturned: !!r.apply, actualApplySettled: r.applySettled, actualApplyJoined: r.applyJoined, actualConnectionSettled: r.connectionSettled, sameConnectionSettlement: typeof r.connection.whenSettled === 'function' && r.connection.whenSettled() === r.settled }))), failures: Object.freeze(faults.map(f => Object.freeze({ stage: f.stage, message: String(f.error instanceof Error ? f.error.message : f.error) }))) }) });
}
