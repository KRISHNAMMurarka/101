import {
  AuthenticatedResourcePeer, PeerDataTransport, PointerResourceProvider, RemoteResourceReceiver,
  authenticatedPeerScope, createDeviceRuntime, createEphemeralWebIdentity, createReceiverInvitation,
  decodeManualPeerCode, decodeReceiverInvitation, encodeManualPeerCode, encodeReceiverInvitation,
  parseDeviceDescriptor, pointerSourceDescriptor, receiverInvitationCurrent, schemasCompatible, webEndpointCrypto,
} from '@101/connect';
import type { DeviceDescriptor, DeviceRuntime, EndpointHandle, EndpointIdentity, PeerConnectionPort, ReceiverInvitation, RouteGrant } from '@101/connect';

export const CONNECTION_TASK_PROFILE = 'authenticated-pointer-task/1';
export const CONNECTION_TASK_LIMITS = Object.freeze({ rawPending: 2, attempts: 32, codeBytes: 65536,
  transitions: 64, setupMs: 30000, grantMs: 60000, maxHz: 60, maxAgeMs: 100 });
const APPLICATION = 'connections-pointer-surface';
const PREFIX = '101-connection-1.';
type Role = 'receiver' | 'source';
type Phase = 'idle' | 'invitation' | 'review' | 'working' | 'offer' | 'answer' | 'connecting' | 'compare' | 'confirmed' | 'permissions' | 'active' | 'stopped' | 'unsupported' | 'invalid' | 'busy' | 'expired' | 'lost';
type Kind = 'invite' | 'offer' | 'answer';
type Packet = { kind: Kind; invitation: ReceiverInvitation; payload: string };
const surfaceDescriptor: DeviceDescriptor = { ...pointerSourceDescriptor(), id: 'connection-surface', label: 'Connection surface',
  adapter: { id: 'app:pointer-surface', version: '1.0.0' }, runtime: { platform: 'browser-application' },
  capabilities: pointerSourceDescriptor().capabilities.map(value => ({ ...value, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } })) };

/** This selected bundle uses actual schema, units, delivery and resource operations. Labels have no authority. */
export function compatiblePointerDescriptor(input: unknown): boolean {
  try {
    const descriptor = parseDeviceDescriptor(input);
    return descriptor.capabilities.length === 2 && surfaceDescriptor.capabilities.every(sink => {
      const source = descriptor.capabilities.find(value => value.id === sink.id);
      return !!source && source.kind === (sink.id === 'position' ? 'sample' : 'event') && source.permissions.includes('subscribe') &&
        source.semantic === sink.semantic && source.delivery.mode === sink.delivery.mode && schemasCompatible(source, sink);
    });
  } catch { return false; }
}
function encode(kind: Kind, invitation: ReceiverInvitation, payload: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ p: CONNECTION_TASK_PROFILE, v: 1, kind,
    invitation: JSON.parse(encodeReceiverInvitation(invitation)), payload }));
  if (bytes.length > 48000) throw new Error('code-limit');
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = PREFIX + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (result.length > CONNECTION_TASK_LIMITS.codeBytes) throw new Error('code-limit');
  return result;
}
function decode(code: string, kind: Kind, wallNow: number): Packet {
  if (typeof code !== 'string' || code.length > CONNECTION_TASK_LIMITS.codeBytes || !code.startsWith(PREFIX)) throw new Error('invalid');
  const body = code.slice(PREFIX.length); if (!body || !/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('invalid');
  const binary = atob(body.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - body.length % 4) % 4));
  const canonical = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (canonical !== body || binary.length > 48000) throw new Error('invalid');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  const packet = value as Record<string, unknown>;
  if (Object.keys(packet).length !== 5 || !['p', 'v', 'kind', 'invitation', 'payload'].every(key => Object.hasOwn(packet, key)) ||
    packet.p !== CONNECTION_TASK_PROFILE || packet.v !== 1 || packet.kind !== kind || typeof packet.payload !== 'string') throw new Error('invalid');
  const invitation = decodeReceiverInvitation(JSON.stringify(packet.invitation), wallNow);
  if (invitation.applicationId !== APPLICATION || !/^connection-[0-9a-f]{32}$/.test(invitation.sessionId)) throw new Error('invalid');
  if (kind === 'invite' ? packet.payload !== '' : !packet.payload) throw new Error('invalid');
  return { kind, invitation, payload: packet.payload };
}
export interface ConnectionTaskOptions {
  role: Role; now: () => number; wallNow: () => number; onChange?: () => void;
  /** Host ports are for bounded lifetime tests; positive qualification uses native browser ports. */
  createPeer?: (configuration: RTCConfiguration) => PeerConnectionPort;
  createIdentity?: () => Promise<EndpointIdentity>;
}
interface Attempt {
  retired: boolean; phase: Phase; invitation?: ReceiverInvitation; code: string; identity?: EndpointIdentity;
  peer?: PeerDataTransport; auth?: AuthenticatedResourcePeer; provider?: PointerResourceProvider;
  receiver?: RemoteResourceReceiver; runtime?: DeviceRuntime; sinks?: Map<string, EndpointHandle>;
  detachData?: () => void; setupAt?: number; sourceUntil?: number; outputGrant?: Readonly<RouteGrant>; confirmed: boolean;
  comparison?: string; active: boolean; held: boolean; position?: Readonly<{ x: number; y: number }>; effects: number;
}
/** Import/construction are inert. All authority is volatile and belongs to the current owner, not a code. */
export function createConnectionTask(configuration: ConnectionTaskOptions) {
  const fields = Object.getOwnPropertyDescriptors(configuration);
  const keys = ['role', 'now', 'wallNow', 'onChange', 'createPeer', 'createIdentity'];
  if (Object.keys(fields).some(key => !keys.includes(key) || !Object.hasOwn(fields[key], 'value')) ||
    fields.role?.value !== 'receiver' && fields.role?.value !== 'source' || typeof fields.now?.value !== 'function' || typeof fields.wallNow?.value !== 'function' ||
    ['onChange', 'createPeer', 'createIdentity'].some(key => fields[key] && fields[key].value !== undefined && typeof fields[key].value !== 'function')) throw new TypeError('Connection task options unavailable');
  const options: Readonly<ConnectionTaskOptions> = Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))) as unknown as ConnectionTaskOptions;
  let generation = 0;
  let closed = false, candidate: Attempt | undefined, incumbent: Attempt | undefined;
  let notice: 'invalid' | undefined;
  let rawPending = 0, attempts = 0, lastTime = -Infinity, readingTime = false, lastPhase: Phase = 'idle';
  const transitions: Phase[] = [];
  const owned = (attempt: Attempt) => !closed && !attempt.retired && (candidate === attempt || incumbent === attempt);
  function changed(): void { try { options.onChange?.(); } catch { /* A view supplies no authority. */ } }
  function phase(attempt: Attempt | undefined, value: Phase): void {
    if (['stopped', 'expired', 'lost', 'unsupported', 'busy'].includes(value)) notice = undefined;
    if (attempt) { if (!owned(attempt)) return; attempt.phase = value; } else lastPhase = value;
    if (transitions.at(-1) !== value) { transitions.push(value); if (transitions.length > CONNECTION_TASK_LIMITS.transitions) transitions.shift(); }
    changed();
  }
  function retire(attempt: Attempt | undefined): void {
    if (!attempt || attempt.retired) return;
    attempt.retired = true; attempt.active = false; attempt.held = false; attempt.position = undefined;
    attempt.sourceUntil = undefined; attempt.outputGrant = undefined;
    if (candidate === attempt) candidate = undefined; if (incumbent === attempt) incumbent = undefined;
    attempt.detachData?.(); attempt.detachData = undefined; attempt.provider?.stop(); attempt.receiver?.stop(); attempt.runtime?.close(); attempt.auth?.stop();
    void attempt.peer?.disconnect().catch(() => {}); attempt.identity = undefined; attempt.code = ''; attempt.comparison = undefined;
  }
  function stop(reason: Phase = 'stopped'): void { generation++; retire(candidate); retire(incumbent); phase(undefined, reason); }
  function time(): number | undefined {
    if (closed || readingTime) return;
    readingTime = true;
    let value: number;
    try { value = options.now(); } catch { stop('lost'); return; } finally { readingTime = false; }
    if (closed) return;
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || value < lastTime) { stop('lost'); return; }
    lastTime = value; return value;
  }
  function wall(): number | undefined {
    try { const value = options.wallNow(); if (closed) return; if (!Number.isSafeInteger(value) || value < 0) { stop('lost'); return; } return value; }
    catch { stop('lost'); return; }
  }
  function current(attempt: Attempt): boolean {
    if (!owned(attempt)) return false;
    const now = time(); if (now === undefined || !owned(attempt)) return false;
    const wallNow = wall(); if (wallNow === undefined || !owned(attempt)) return false;
    if (!attempt.invitation || !receiverInvitationCurrent(attempt.invitation, wallNow) ||
      !attempt.auth?.isOpen('reliable') && attempt.setupAt !== undefined && now - attempt.setupAt >= CONNECTION_TASK_LIMITS.setupMs ||
      attempt.sourceUntil !== undefined && now >= attempt.sourceUntil || attempt.outputGrant && now >= attempt.outputGrant.expiresAt) {
      retire(attempt); phase(undefined, 'expired'); return false;
    }
    return owned(attempt);
  }
  const clock = (attempt: Attempt) => { const value = time(); return owned(attempt) && value !== undefined ? value : NaN; };
  function newAttempt(): Attempt | undefined {
    if (closed) return;
    if (rawPending >= CONNECTION_TASK_LIMITS.rawPending || attempts >= CONNECTION_TASK_LIMITS.attempts) { phase(undefined, 'busy'); return; }
    const expected = generation; retire(candidate); if (closed || generation !== expected) return; generation++; attempts++;
    const attempt: Attempt = { retired: false, phase: 'working', code: '', confirmed: false, active: false, held: false, effects: 0 };
    candidate = attempt; notice = undefined; return attempt;
  }
  function supported(): boolean { return !!options.createPeer || typeof globalThis.RTCPeerConnection === 'function'; }
  async function raw<T>(attempt: Attempt, operation: () => Promise<T>): Promise<T | undefined> {
    if (!owned(attempt) || rawPending >= CONNECTION_TASK_LIMITS.rawPending) return;
    rawPending++; changed();
    try { if (!owned(attempt)) return; return await operation(); }
    finally { rawPending--; changed(); }
  }
  function promote(attempt: Attempt): boolean {
    if (!current(attempt)) return false;
    const previous = incumbent; incumbent = attempt; if (candidate === attempt) candidate = undefined;
    retire(previous); return owned(attempt);
  }
  async function identity(attempt: Attempt): Promise<boolean> {
    const value = await raw(attempt, () => (options.createIdentity ?? createEphemeralWebIdentity)());
    if (!value || !current(attempt)) return false;
    attempt.identity = value; return true;
  }
  function install(attempt: Attempt, initiator: boolean): boolean {
    if (!current(attempt) || !attempt.identity || !attempt.invitation) return false;
    const peer = new PeerDataTransport({ initiator, iceServers: [], createPeer: options.createPeer, maxMessageBytes: 65536 });
    attempt.peer = peer;
    const auth = new AuthenticatedResourcePeer({ transport: peer, identity: attempt.identity, crypto: webEndpointCrypto,
      ...attempt.invitation, role: options.role, now: () => clock(attempt), timeoutMs: CONNECTION_TASK_LIMITS.setupMs });
    if (!current(attempt)) { auth.stop(); return false; }
    attempt.auth = auth;
    // Attach the denied receiver before any native packet can arrive after enrollment.
    if (options.role === 'receiver') prepareReceiver(attempt);
    return owned(attempt);
  }
  function fail(attempt: Attempt, reason: Phase): false { if (owned(attempt)) { retire(attempt); phase(undefined, reason); } return false; }
  async function beginReceive(): Promise<boolean> {
    if (closed || options.role !== 'receiver') return false;
    const attempt = newAttempt(); if (!attempt) return false;
    if (!supported()) return fail(attempt, 'unsupported');
    if (!owned(attempt)) return false;
    try {
      const now = time(), wallNow = wall(); if (now === undefined || wallNow === undefined || !owned(attempt)) return false;
      const random = webEndpointCrypto.randomBytes(16); if (!owned(attempt)) return false;
      const sessionId = `connection-${[...random].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
      attempt.invitation = createReceiverInvitation({ applicationId: APPLICATION, sessionId, now: wallNow, randomBytes: webEndpointCrypto.randomBytes });
      if (!owned(attempt) || !await identity(attempt)) return fail(attempt, 'lost');
      attempt.code = encode('invite', attempt.invitation, ''); phase(attempt, 'invitation'); return owned(attempt);
    } catch { return fail(attempt, 'lost'); }
  }
  function review(code: string): boolean {
    if (closed || options.role !== 'source') return false;
    try {
      const expected = generation, wallNow = wall(); if (wallNow === undefined || closed || generation !== expected) return false;
      const packet = decode(code, 'invite', wallNow), attempt = newAttempt(); if (!attempt) return false;
      attempt.invitation = packet.invitation; phase(attempt, 'review'); return owned(attempt);
    } catch { notice = 'invalid'; phase(undefined, 'invalid'); return false; }
  }
  async function beginSend(): Promise<boolean> {
    const attempt = candidate;
    if (options.role !== 'source' || !attempt || attempt.phase !== 'review' || !current(attempt)) return false;
    if (!supported()) { return fail(attempt, 'unsupported'); }
    try {
      const now = time(); if (now === undefined || !owned(attempt)) return false; attempt.setupAt = now; phase(attempt, 'working');
      if (!owned(attempt) || !await identity(attempt) || !install(attempt, true)) return fail(attempt, 'lost');
      const offer = await raw(attempt, () => attempt.peer!.createOffer()); if (!offer || !current(attempt)) return false;
      attempt.code = encode('offer', attempt.invitation!, encodeManualPeerCode(attempt.invitation!.epoch, offer)); phase(attempt, 'offer'); return owned(attempt);
    } catch { return fail(attempt, 'lost'); }
  }
  async function useCode(code: string): Promise<boolean> {
    const attempt = candidate;
    if (!attempt || !current(attempt) || (options.role === 'receiver' ? attempt.phase !== 'invitation' : attempt.phase !== 'offer')) return false;
    try {
      const wallNow = wall(); if (wallNow === undefined || !owned(attempt)) return false;
      const kind = options.role === 'receiver' ? 'offer' : 'answer', packet = decode(code, kind, wallNow);
      if (encodeReceiverInvitation(packet.invitation) !== encodeReceiverInvitation(attempt.invitation!)) throw new Error('scope');
      const description = decodeManualPeerCode(packet.payload, kind, attempt.invitation!.epoch).description;
      if (!current(attempt)) return false;
      const now = time(); if (now === undefined || !owned(attempt)) return false; notice = undefined;
      attempt.setupAt ??= now; phase(attempt, 'working');
      if (options.role === 'receiver') {
        if (!install(attempt, false)) return fail(attempt, 'lost');
        const answer = await raw(attempt, () => attempt.peer!.acceptOffer(description)); if (!answer || !current(attempt)) return false;
        attempt.code = encode('answer', attempt.invitation!, encodeManualPeerCode(attempt.invitation!.epoch, answer)); phase(attempt, 'answer');
      } else {
        await raw(attempt, async () => { await attempt.peer!.acceptAnswer(description); return true; });
        if (!current(attempt)) return false; phase(attempt, 'connecting');
      }
      return owned(attempt);
    } catch { if (owned(attempt) && attempt.phase !== 'working') { notice = 'invalid'; changed(); return false; } return fail(attempt, 'lost'); }
  }
  function confirm(): boolean {
    const attempt = candidate ?? incumbent;
    if (!attempt || !current(attempt) || !attempt.comparison || attempt.confirmed || !attempt.auth?.confirmEnrollment(attempt.comparison) || !current(attempt)) return false;
    attempt.confirmed = true; phase(attempt, 'confirmed'); return owned(attempt);
  }
  function sourceCurrent(attempt: Attempt): boolean {
    if (!current(attempt) || attempt.sourceUntil === undefined) return false;
    const now = time(), scope = authenticatedPeerScope(attempt.auth);
    return owned(attempt) && incumbent === attempt && now !== undefined && now < attempt.sourceUntil && !!scope && scope.role === 'source' && scope.epoch === attempt.invitation!.epoch && scope.applicationId === APPLICATION && scope.sessionId === attempt.invitation!.sessionId;
  }
  function allowSource(): boolean {
    const attempt = candidate ?? incumbent;
    if (options.role !== 'source' || !attempt || !current(attempt) || attempt.sourceUntil !== undefined || !authenticatedPeerScope(attempt.auth)) return false;
    const now = time(); if (now === undefined || now > Number.MAX_SAFE_INTEGER - CONNECTION_TASK_LIMITS.grantMs || !current(attempt)) return false;
    if (!promote(attempt)) return false; attempt.sourceUntil = now + CONNECTION_TASK_LIMITS.grantMs;
    let provider: PointerResourceProvider;
    try { provider = new PointerResourceProvider({ peer: attempt.auth!, epoch: attempt.invitation!.epoch, clockId: `source-${attempt.invitation!.epoch}`,
      now: () => clock(attempt), platform: 'browser-pointer-events', available: () => sourceCurrent(attempt) }); } catch { return fail(attempt, 'lost'); }
    if (!current(attempt)) { provider.stop(); return false; } attempt.provider = provider; phase(attempt, 'permissions'); return owned(attempt);
  }
  function outputCurrent(attempt: Attempt): boolean {
    if (!current(attempt) || !attempt.outputGrant || incumbent !== attempt) return false;
    const now = time(), scope = authenticatedPeerScope(attempt.auth);
    return owned(attempt) && now !== undefined && now < attempt.outputGrant.expiresAt && !!scope && scope.role === 'receiver' && scope.epoch === attempt.invitation!.epoch && scope.applicationId === APPLICATION && scope.sessionId === attempt.invitation!.sessionId;
  }
  function prepareReceiver(attempt: Attempt): void {
    if (!owned(attempt) || attempt.receiver || !attempt.auth || !attempt.invitation) return;
    const target = attempt.invitation, principalId = `surface-owner-${target.epoch}`, clockId = `receiver-${target.epoch}`;
    const runtime = createDeviceRuntime({ now: () => clock(attempt), clockDomain: clockId, maxRoutes: 2, maxRegistrations: 4, maxSubscribers: 2, maxPendingDeliveries: 2,
      authorize(request) {
        if (!outputCurrent(attempt) || request.principalId !== principalId || request.applicationId !== target.applicationId || request.sessionId !== target.sessionId ||
          request.source.deviceId !== attempt.receiver?.description()?.id || request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' ||
          request.sink.deviceId !== surfaceDescriptor.id || request.source.capabilityId !== request.sink.capabilityId || !['position', 'contact'].includes(request.sink.capabilityId)) return;
        return outputCurrent(attempt) ? attempt.outputGrant : undefined;
      } });
    if (!current(attempt)) { runtime.close(); return; } attempt.runtime = runtime;
    const sinks = new Map<string, EndpointHandle>(); attempt.sinks = sinks;
    for (const capability of surfaceDescriptor.capabilities) {
      const sink = runtime.registerSink({ device: surfaceDescriptor, capability: capability.id,
        apply(observation, context) {
          if (!context.isCurrent() || !outputCurrent(attempt) || !context.isCurrent()) return;
          if (capability.id === 'position' && typeof observation.value === 'object' && observation.value !== null && 'x' in observation.value && 'y' in observation.value &&
            typeof observation.value.x === 'number' && typeof observation.value.y === 'number') attempt.position = Object.freeze({ x: observation.value.x, y: observation.value.y });
          if (capability.id === 'contact' && typeof observation.value === 'boolean') attempt.held = observation.value;
          attempt.effects++; changed();
        }, release() { attempt.position = undefined; attempt.held = false; changed(); } });
      if (!current(attempt)) { runtime.close(); return; } runtime.setReadiness(sink, 'available'); sinks.set(capability.id, sink);
    }
    const receiver = new RemoteResourceReceiver({ peer: attempt.auth, epoch: target.epoch, runtime, clockId, now: () => clock(attempt), principalId, applicationId: target.applicationId, sessionId: target.sessionId });
    if (!current(attempt)) { receiver.stop(); return; } attempt.receiver = receiver;
    attempt.detachData = attempt.auth.onData(() => {
      if (!current(attempt)) return;
      try { receiver.tick(); if (owned(attempt)) changed(); } catch { fail(attempt, 'lost'); }
    });
  }
  function allowOutput(): boolean {
    const attempt = candidate ?? incumbent;
    if (options.role !== 'receiver' || !attempt || !current(attempt) || attempt.outputGrant || !attempt.receiver || !attempt.sinks ||
      !compatiblePointerDescriptor(attempt.receiver.description()) || !authenticatedPeerScope(attempt.auth)) return false;
    const now = time(); if (now === undefined || now > Number.MAX_SAFE_INTEGER - CONNECTION_TASK_LIMITS.grantMs || !current(attempt) || !promote(attempt)) return false;
    attempt.outputGrant = Object.freeze({ expiresAt: now + CONNECTION_TASK_LIMITS.grantMs, maxHz: CONNECTION_TASK_LIMITS.maxHz, maxAgeMs: CONNECTION_TASK_LIMITS.maxAgeMs });
    for (const capability of surfaceDescriptor.capabilities) {
      if (!outputCurrent(attempt)) return false;
      const slot = attempt.receiver.approve({ capability: capability.id, sink: attempt.sinks.get(capability.id)!, sinkDevice: surfaceDescriptor,
        sinkCapability: capability.id, grant: attempt.outputGrant, codec: capability.id === 'position' ? 'normalized-pointer/1' : 'json/1' });
      if (slot === undefined || !outputCurrent(attempt)) return fail(attempt, 'lost');
    }
    phase(attempt, 'permissions'); return owned(attempt);
  }
  function tick(): void {
    for (const attempt of [incumbent, candidate]) {
      if (!attempt || !current(attempt)) continue;
      try {
        attempt.auth?.tick(); if (!current(attempt)) continue;
        const auth = attempt.auth?.status();
        if (auth?.phase === 'stopped') { fail(attempt, 'lost'); continue; }
        if (auth?.comparisonDigest && attempt.comparison !== auth.comparisonDigest) { attempt.comparison = auth.comparisonDigest; phase(attempt, 'compare'); }
        if (!current(attempt)) continue;
        if (auth?.phase === 'active' && options.role === 'receiver') prepareReceiver(attempt);
        if (!current(attempt)) continue;
        if (auth?.phase === 'active' && !attempt.provider && !attempt.outputGrant && attempt.phase !== 'permissions') phase(attempt, 'permissions');
        if (!current(attempt)) continue; attempt.provider?.tick(); if (!current(attempt)) continue; attempt.receiver?.tick();
        if (!current(attempt)) continue;
        const provider = attempt.provider?.status(), receiver = attempt.receiver?.status();
        if (provider?.stopped || receiver?.stopped || receiver && ['expired', 'overload', 'unavailable', 'incompatible'].includes(receiver.reason)) { fail(attempt, 'lost'); continue; }
        const active = provider?.ready === true || receiver?.active === 2;
        if (attempt.provider) attempt.held = attempt.provider.driver()?.state().contact ?? false;
        if (active !== attempt.active) { attempt.active = active; if (active) phase(attempt, 'active'); }
        changed();
      } catch { fail(attempt, 'lost'); }
    }
  }
  function input(operation: (provider: PointerResourceProvider) => boolean): boolean {
    const attempt = incumbent; if (!attempt?.provider || !sourceCurrent(attempt)) return false;
    const result = operation(attempt.provider); if (owned(attempt)) attempt.held = attempt.provider.driver()?.state().contact ?? false; changed(); return owned(attempt) && result;
  }
  return {
    beginReceive, review, beginSend, useCode, confirm, allowSource, allowOutput, tick,
    beginPointer: (id: number, x: number, y: number, width: number, height: number) => input(provider => provider.driver()?.begin(id, x, y, width, height) ?? false),
    movePointer: (id: number, x: number, y: number, width: number, height: number) => input(provider => provider.driver()?.move(id, x, y, width, height) ?? false),
    endPointer: (id: number) => input(provider => provider.driver()?.end(id) ?? false),
    move: (dx: number, dy: number) => input(provider => provider.driver()?.nudge(dx, dy) ?? false),
    press: (pressed: boolean) => input(provider => provider.driver()?.setContact(pressed) ?? false),
    release() { incumbent?.provider?.driver()?.release(); changed(); },
    cancelCandidate() { generation++; notice = undefined; retire(candidate); phase(undefined, incumbent ? incumbent.phase : 'stopped'); },
    stop() { stop(); },
    snapshot() {
      const selected = candidate ?? incumbent;
      return Object.freeze({ role: options.role, notice, phase: selected?.phase ?? lastPhase, code: selected?.code ?? '', comparison: selected?.comparison,
        confirmed: selected?.confirmed ?? false, verified: !!selected?.auth && selected.auth.state === 'connected',
        described: !!selected?.receiver?.description(), compatible: !!selected?.receiver && compatiblePointerDescriptor(selected.receiver.description()), sourceAllowed: selected?.sourceUntil !== undefined,
        outputAllowed: !!selected?.outputGrant, active: incumbent?.active ?? false, held: incumbent?.held ?? false,
        position: incumbent?.position, effects: incumbent?.effects ?? 0, candidate: !!candidate, rawPending, attempts,
        transitions: Object.freeze([...transitions]) });
    },
    close() { if (closed) return; closed = true; stop(); },
  };
}
