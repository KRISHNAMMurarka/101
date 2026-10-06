import { AuthenticatedResourcePeer, PeerDataTransport, authenticatedPeerScope, createEphemeralWebIdentity,
  createReceiverInvitation, decodeManualPeerCode, decodeReceiverInvitation, encodeManualPeerCode,
  encodeReceiverInvitation, receiverInvitationCurrent, webEndpointCrypto } from '@101/connect';
import type { EndpointIdentity, PeerConnectionPort, ReceiverInvitation } from '@101/connect';

export const SHARING_APPLICATION = 'connected-page-sharing';
const PREFIX = '101-sharing-1.';
type Role = 'receiver' | 'source';
type Kind = 'invite' | 'offer' | 'answer';
type Envelope = { kind: Kind; invitation: ReceiverInvitation; payload: string };
export interface SharingPeerOptions {
  role: Role; sessionId?: string; now: () => number; wallNow: () => number;
  reserve: () => (() => void) | undefined;
  onChange: () => void; onMessage: (peer: SharingPeer, data: string) => void; onLoss: () => void;
  createPeer?: (configuration: RTCConfiguration) => PeerConnectionPort;
  createIdentity?: () => Promise<EndpointIdentity>;
}
export interface SharingPeerSnapshot {
  readonly phase: 'idle' | 'review' | 'working' | 'exchange' | 'comparison' | 'connected' | 'stopped' | 'invalid' | 'unsupported';
  readonly code: string; readonly comparison?: string; readonly confirmed: boolean; readonly rawPending: number;
}
function encode(value: Envelope): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ p: 'connected-page-sharing/1', v: 1, ...value }));
  if (bytes.length > 48000) throw Error('invalid');
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return PREFIX + btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(code: string, kind: Kind, wall: number): Envelope {
  if (typeof code !== 'string' || code.length > 65536 || !code.startsWith(PREFIX)) throw Error('invalid');
  const body = code.slice(PREFIX.length); if (!/^[A-Za-z0-9_-]+$/.test(body)) throw Error('invalid');
  const binary = atob(body.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - body.length % 4) % 4));
  if (binary.length > 48000 || btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== body) throw Error('invalid');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid');
  const packet = value as Record<string, unknown>;
  if (Object.keys(packet).length !== 5 || !['p', 'v', 'kind', 'invitation', 'payload'].every(key => Object.hasOwn(packet, key)) ||
    packet.p !== 'connected-page-sharing/1' || packet.v !== 1 || packet.kind !== kind || typeof packet.payload !== 'string') throw Error('invalid');
  const invitation = decodeReceiverInvitation(JSON.stringify(packet.invitation), wall);
  if (invitation.applicationId !== SHARING_APPLICATION || !/^sharing-[0-9a-f]{32}$/.test(invitation.sessionId) ||
    (kind === 'invite' ? packet.payload !== '' : !packet.payload)) throw Error('invalid');
  return { kind, invitation, payload: packet.payload };
}

/** A manual code is an inert candidate; only the SDK's issued scope is authority. */
export class SharingPeer {
  private readonly options: Readonly<SharingPeerOptions>;
  private phase: SharingPeerSnapshot['phase'] = 'idle';
  private invitation?: ReceiverInvitation;
  private identity?: EndpointIdentity;
  private transport?: PeerDataTransport;
  private auth?: AuthenticatedResourcePeer;
  private code = '';
  private confirmed = false;
  private stopped = false;
  private busy = false;
  private startedAt?: number;
  private lastTime = -Infinity;
  private reading = false;
  private pending = 0;
  private generation = 0;
  private readonly issued = new Set<Promise<unknown>>();
  private readonly detach: (() => void)[] = [];
  constructor(options: SharingPeerOptions) { this.options = Object.freeze({ ...options }); }
  private changed() { try { this.options.onChange(); } catch { /* A view supplies no authority. */ } }
  private time(): number | undefined {
    if (this.stopped || this.reading) return;
    const generation = this.generation; this.reading = true; let at: number;
    try { at = this.options.now(); } catch { this.stop(); return; } finally { this.reading = false; }
    if (this.stopped || generation !== this.generation) return;
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 60000 || at < this.lastTime) { this.stop(); return; }
    this.lastTime = at; return at;
  }
  private wall(): number | undefined {
    const generation = this.generation;
    try { const at = this.options.wallNow(); if (this.stopped || generation !== this.generation) return;
      if (!Number.isSafeInteger(at) || at < 0) { this.stop(); return; } return at;
    } catch { this.stop(); return; }
  }
  private alive(): boolean {
    const at = this.time(), wall = this.wall();
    if (at === undefined || wall === undefined || this.stopped) return false;
    if (this.invitation && !receiverInvitationCurrent(this.invitation, wall) ||
      this.startedAt !== undefined && !this.current() && at - this.startedAt >= 30000) { this.stop(); return false; }
    return !this.stopped;
  }
  private async operation(action: () => Promise<boolean>): Promise<boolean> {
    if (this.stopped || this.busy || this.pending >= 2) return false;
    // Reserve before clock/identity/native callbacks. Close retains this reservation.
    const release = this.options.reserve(); if (!release || this.stopped) { release?.(); return false; }
    this.pending++; this.busy = true; const generation = this.generation;
    let settle!: (result: boolean) => void;
    const promise = new Promise<boolean>(resolve => { settle = resolve; });
    this.issued.add(promise);
    void (async () => {
      try { if (!this.alive() || generation !== this.generation) return false;
        const result = await action(); return !this.stopped && generation === this.generation && this.alive() && result;
      } catch { if (!this.stopped) { this.phase = 'invalid'; this.stop(); } return false; }
      finally { this.pending--; this.busy = false; release(); this.changed(); }
    })().then(settle, () => settle(false));
    try { const result = await promise; return !this.stopped && generation === this.generation && result; }
    finally { this.issued.delete(promise); }
  }
  async invite(): Promise<boolean> {
    if (this.options.role !== 'receiver' || this.invitation) return false;
    return this.operation(async () => {
      if (!this.options.createPeer && typeof RTCPeerConnection === 'undefined') { this.phase = 'unsupported'; return false; }
      const at = this.time(), wall = this.wall(); if (at === undefined || wall === undefined || this.stopped) return false;
      this.startedAt = at;
      const invitation = createReceiverInvitation({ applicationId: SHARING_APPLICATION, sessionId: this.options.sessionId!, now: wall,
        randomBytes: size => webEndpointCrypto.randomBytes(size) });
      this.invitation = invitation; this.phase = 'working'; this.changed();
      if (!this.alive() || this.invitation !== invitation) return false;
      const identity = await (this.options.createIdentity ?? createEphemeralWebIdentity)();
      if (!this.alive() || this.invitation !== invitation) return false;
      this.identity = identity; this.code = encode({ kind: 'invite', invitation, payload: '' }); this.phase = 'exchange'; return true;
    });
  }
  review(code: string): boolean {
    if (this.options.role !== 'source' || this.stopped || this.busy || this.invitation) return false;
    const generation = this.generation, wall = this.wall(), at = this.time(); if (wall === undefined || at === undefined || generation !== this.generation) return false;
    try { this.invitation = decode(code, 'invite', wall).invitation; this.startedAt = at; this.phase = 'review'; this.changed(); return !this.stopped; }
    catch { this.phase = 'invalid'; this.changed(); return false; }
  }
  private install(identity: EndpointIdentity) {
    if (!this.alive() || !this.invitation) throw Error('stopped');
    const transport = new PeerDataTransport({ initiator: this.options.role === 'source', iceServers: [], maxMessageBytes: 65536, createPeer: this.options.createPeer });
    if (this.stopped) { void transport.disconnect(); throw Error('stopped'); }
    this.identity = identity; this.transport = transport;
    const auth = new AuthenticatedResourcePeer({ transport, identity, crypto: webEndpointCrypto, ...this.invitation,
      role: this.options.role, now: () => this.time() ?? NaN, timeoutMs: 30000 });
    this.auth = auth;
    this.detach.push(auth.onData((lane, data) => {
      if (lane === 'reliable' && typeof data === 'string' && data.length <= 4096 && new TextEncoder().encode(data).length <= 4096 && this.current()) this.options.onMessage(this, data);
    }));
    this.detach.push(auth.onStateChange(state => { if (state === 'failed' || state === 'disconnected') this.stop(); this.changed(); }));
    if (this.stopped) { auth.stop(); void transport.disconnect(); throw Error('stopped'); }
  }
  async offer(): Promise<boolean> {
    if (this.options.role !== 'source' || this.phase !== 'review') return false;
    return this.operation(async () => {
      if (!this.options.createPeer && typeof RTCPeerConnection === 'undefined') { this.phase = 'unsupported'; return false; }
      this.phase = 'working'; this.changed(); if (!this.alive()) return false;
      const identity = await (this.options.createIdentity ?? createEphemeralWebIdentity)();
      if (!this.alive()) return false; this.install(identity);
      const description = await this.transport!.createOffer(); if (!this.alive()) return false;
      this.code = encode({ kind: 'offer', invitation: this.invitation!, payload: encodeManualPeerCode(this.invitation!.epoch, description) });
      this.phase = 'exchange'; return true;
    });
  }
  async accept(code: string): Promise<boolean> {
    if (!this.invitation || this.stopped) return false;
    return this.operation(async () => {
      const wall = this.wall(); if (wall === undefined || !this.alive()) return false;
      const kind = this.options.role === 'receiver' ? 'offer' : 'answer', packet = decode(code, kind, wall);
      if (encodeReceiverInvitation(packet.invitation) !== encodeReceiverInvitation(this.invitation!)) return false;
      const manual = decodeManualPeerCode(packet.payload, kind, this.invitation!.epoch);
      this.phase = 'working'; this.changed();
      if (!this.alive()) return false;
      if (kind === 'offer') {
        if (this.transport || !this.identity) return false; this.install(this.identity);
        const answer = await this.transport!.acceptOffer(manual.description); if (!this.alive()) return false;
        this.code = encode({ kind: 'answer', invitation: this.invitation!, payload: encodeManualPeerCode(this.invitation!.epoch, answer) });
      } else { if (!this.transport) return false; await this.transport.acceptAnswer(manual.description); if (!this.alive()) return false; this.code = ''; }
      this.phase = 'exchange'; return true;
    });
  }
  current(): AuthenticatedResourcePeer | undefined {
    if (this.stopped || !this.auth || !this.invitation) return;
    const scope = authenticatedPeerScope(this.auth);
    if (this.stopped || !scope || scope.role !== this.options.role || scope.epoch !== this.invitation.epoch || scope.applicationId !== SHARING_APPLICATION || scope.sessionId !== this.invitation.sessionId) return;
    return this.auth;
  }
  scope() { const auth = this.current(); return auth ? authenticatedPeerScope(auth) : undefined; }
  confirm(): boolean {
    if (!this.alive()) return false; const digest = this.auth?.status().comparisonDigest;
    if (!digest || this.stopped || !this.auth?.confirmEnrollment(digest) || this.stopped) return false;
    this.confirmed = true; this.changed(); return true;
  }
  send(packet: Readonly<Record<string, string | number>>): boolean {
    const auth = this.current(), scope = this.scope(); if (!auth || !scope || !this.alive()) return false;
    const text = JSON.stringify({ p: 'connected-page-sharing/1', v: 1, epoch: scope.epoch, ...packet });
    if (text.length > 4096 || new TextEncoder().encode(text).length > 4096 || !this.current()) return false;
    return auth.send('reliable', text);
  }
  tick() {
    if (!this.alive()) return; this.auth?.tick(); if (this.stopped) return;
    const status = this.auth?.status();
    if (status?.phase === 'stopped') { this.stop(); return; }
    const phase = this.current() ? 'connected' : status?.comparisonDigest ? 'comparison' : this.phase;
    if (phase !== this.phase) { this.phase = phase; this.changed(); }
  }
  snapshot(): SharingPeerSnapshot { return Object.freeze({ phase: this.phase, code: this.code, confirmed: this.confirmed,
    comparison: this.auth?.status().comparisonDigest, rawPending: this.pending }); }
  stop(): void {
    if (this.stopped) return; this.stopped = true; this.generation++; this.code = ''; this.confirmed = false;
    this.phase = 'stopped'; for (const detach of this.detach.splice(0)) detach(); this.auth?.stop(); this.identity = undefined;
    const transport = this.transport; this.transport = undefined;
    if (transport) {
      // A close is not a canceled negotiation's raw settlement. Keep both promises.
      const release = this.options.reserve(); this.pending++;
      const work = transport.disconnect().catch(() => {}).finally(() => { this.pending--; release?.(); this.issued.delete(work); this.changed(); });
      this.issued.add(work);
    }
    try { this.options.onLoss(); } finally { this.changed(); }
  }
  async close(): Promise<void> { this.stop(); while (this.issued.size) await Promise.allSettled([...this.issued]); }
}
