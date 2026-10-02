import { snapshotJson } from '@101/device-model';
import { PeerDataTransport } from '@101/transport-webrtc';
import type { PeerLane, PeerSessionBinding, PeerState } from '@101/transport-webrtc';
import type { ResourcePeer } from './binding.ts';
import type { EndpointCrypto, EndpointIdentity } from './identity-types.ts';
import { bytesToHex, endpointKeyId, hexToBytes } from './identity-format.ts';

type Role = 'source' | 'receiver';
type Party = 'offerer' | 'answerer';
interface Hello {
  protocol: 'connect-auth'; version: 1; type: 'hello'; epoch: string;
  applicationId: string; sessionId: string; role: Role; party: Party;
  keyId: string; publicKey: string; nonce: string; ttlMs: number;
}
interface Proof { protocol: 'connect-auth'; version: 1; type: 'proof'; epoch: string; signature: string }
interface Finish { protocol: 'connect-auth'; version: 1; type: 'finish'; epoch: string; digest: string }
type Control = Hello | Proof | Finish;
export interface AuthenticatedPeerScope {
  readonly epoch: string; readonly applicationId: string; readonly sessionId: string; readonly role: Role;
  readonly localKeyId: string; readonly remoteKeyId: string; readonly transcriptDigest: string;
}
export interface AuthenticatedPeerOptions {
  transport: PeerDataTransport; identity: EndpointIdentity; crypto: EndpointCrypto;
  epoch: string; applicationId: string; sessionId: string; role: Role; now: () => number;
  timeoutMs?: number; expectedRemoteKeyId?: string;
}
const peers = new WeakMap<object, () => AuthenticatedPeerScope | undefined>();
const expectations = new WeakMap<object, Readonly<Pick<AuthenticatedPeerScope, 'epoch' | 'applicationId' | 'sessionId' | 'role'>>>();
/** Structural objects and copied metadata cannot mint authenticated provenance. */
export function authenticatedPeerScope(peer: unknown): AuthenticatedPeerScope | undefined {
  return peer !== null && typeof peer === 'object' ? peers.get(peer)?.() : undefined;
}
/** Locally chosen scope only; this is never evidence that authentication finished. */
export function authenticatedPeerExpectedScope(peer: unknown): Readonly<Pick<AuthenticatedPeerScope, 'epoch' | 'applicationId' | 'sessionId' | 'role'>> | undefined {
  return peer !== null && typeof peer === 'object' ? expectations.get(peer) : undefined;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value &&
    !Array.from(value).some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; });
}
function hex(value: unknown, length: number): value is string { return typeof value === 'string' && value.length === length * 2 && /^[0-9a-f]+$/.test(value); }
function time(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function control(data: string | ArrayBuffer): Control | undefined {
  if (typeof data !== 'string' || data.length > 4096 || new TextEncoder().encode(data).length > 4096) return;
  try {
    const value = snapshotJson(JSON.parse(data));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== 'connect-auth' || value.version !== 1 || !hex(value.epoch, 16)) return;
    const keys = value.type === 'hello' ? ['protocol', 'version', 'type', 'epoch', 'applicationId', 'sessionId', 'role', 'party', 'keyId', 'publicKey', 'nonce', 'ttlMs']
      : value.type === 'proof' ? ['protocol', 'version', 'type', 'epoch', 'signature'] : value.type === 'finish' ? ['protocol', 'version', 'type', 'epoch', 'digest'] : [];
    if (!keys.length || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return;
    if (value.type === 'hello') {
      if (!id(value.applicationId) || !id(value.sessionId) || value.role !== 'source' && value.role !== 'receiver' ||
        value.party !== 'offerer' && value.party !== 'answerer' || !hex(value.keyId, 32) || !hex(value.publicKey, 65) ||
        !value.publicKey.startsWith('04') || !hex(value.nonce, 32) || !Number.isSafeInteger(value.ttlMs) ||
        (value.ttlMs as number) < 1000 || (value.ttlMs as number) > 60000) return;
    } else if (value.type === 'proof' ? !hex(value.signature, 64) : !hex(value.digest, 32)) return;
    return value as unknown as Control;
  } catch { return; }
}
function fingerprints(sdp: string): readonly string[] {
  const lines = sdp.split(/\r?\n/).filter(line => line.startsWith('a=fingerprint:'));
  if (!lines.length) throw new TypeError('SDP has no DTLS fingerprint');
  const result = lines.map(line => {
    const match = /^a=fingerprint:(sha-256|sha-384|sha-512) ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})+)$/.exec(line);
    const lengths: Record<string, number> = { 'sha-256': 32, 'sha-384': 48, 'sha-512': 64 };
    if (!match || match[2]!.split(':').length !== lengths[match[1]!]) throw new TypeError('Invalid DTLS fingerprint');
    return `${match[1]} ${match[2]!.toLowerCase()}`;
  });
  return Object.freeze([...new Set(result)].sort());
}
function text(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
function participant(hello: Hello): readonly unknown[] { return [hello.role, hello.party, hello.keyId, hello.publicKey, hello.nonce, hello.ttlMs]; }
function proofMessage(transcript: string, hello: Hello): Uint8Array { return text(['101.endpoint-proof/1', hello.role, hello.party, transcript]); }

/** An owned authentication gate. Raw resource packets cannot establish trust. */
export class AuthenticatedResourcePeer implements ResourcePeer {
  readonly #raw: PeerDataTransport;
  readonly #identity: EndpointIdentity;
  readonly #crypto: EndpointCrypto;
  readonly #options: Readonly<AuthenticatedPeerOptions>;
  readonly #detach: (() => void)[] = [];
  readonly #listeners = new Set<(lane: PeerLane, data: string | ArrayBuffer) => void>();
  readonly #states = new Set<(state: PeerState) => void>();
  #state: PeerState = 'connecting';
  #stopped = false; #reason = 'waiting-for-transport';
  #binding?: PeerSessionBinding; #startedAt?: number; #lastNow = -Infinity;
  #local?: Hello; #remote?: Hello; #remoteProof?: string; #remoteFinish?: string;
  #transcript?: string; #digest?: string; #scope?: AuthenticatedPeerScope;
  #proving = false; #verifying = false;
  #proof?: string; #proofSent = false; #verified = false; #enrolled = false; #finishSent = false;
  #lastHelloAt = -Infinity; #controls = 0;
  #currencyPending = false; #lastCurrencyAt = -Infinity; #lastCurrencyAttempt = -Infinity;

  constructor(options: AuthenticatedPeerOptions) {
    if (!(options.transport instanceof PeerDataTransport) || !hex(options.epoch, 16) || !id(options.applicationId) || !id(options.sessionId) ||
      options.role !== 'source' && options.role !== 'receiver' || typeof options.now !== 'function' || !time(options.now()) ||
      !hex(options.identity.keyId, 32) || options.expectedRemoteKeyId !== undefined && !hex(options.expectedRemoteKeyId, 32) ||
      options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60000))
      throw new TypeError('Invalid authenticated endpoint scope');
    this.#options = Object.freeze({ ...options }); this.#raw = options.transport; this.#identity = options.identity; this.#crypto = options.crypto;
    peers.set(this, () => this.currentScope());
    expectations.set(this, Object.freeze({ epoch: options.epoch, applicationId: options.applicationId, sessionId: options.sessionId, role: options.role }));
    this.own(this.#identity.onInvalidated(() => this.fail('identity-unavailable')));
    this.own(this.#raw.onData((lane, data) => this.receive(lane, data)));
    this.own(this.#raw.onStateChange(state => { if (state === 'failed' || state === 'disconnected') this.fail('transport-ended'); }));
  }
  get state(): PeerState { return this.#state; }
  private own(detach: () => void): void { if (this.#stopped) detach(); else this.#detach.push(detach); }
  private now(): number | undefined {
    try {
      const value = this.#options.now(); if (!time(value) || value < this.#lastNow) throw new RangeError(); this.#lastNow = value; return value;
    } catch { this.fail('clock-unavailable'); return; }
  }
  private alive(): boolean {
    if (this.#stopped) return false;
    const now = this.now(); if (now === undefined) return false;
    if (this.#binding && !this.#raw.isCurrentSession(this.#binding)) { this.fail('transport-ended'); return false; }
    if (this.#state !== 'connected' && this.#startedAt !== undefined && now - this.#startedAt >= (this.#options.timeoutMs ?? 60000)) {
      this.fail('authentication-timeout'); return false;
    }
    return true;
  }
  private currentScope(): AuthenticatedPeerScope | undefined {
    if (!this.alive() || this.#state !== 'connected') return;
    const now = this.now(); if (now === undefined) return;
    if (now - this.#lastCurrencyAt > 2000) { this.fail('identity-unavailable'); return; }
    if (!this.#raw.isOpen('reliable') || !this.#raw.isOpen('disposable')) return;
    return this.#scope;
  }
  isOpen(lane: PeerLane): boolean { return !!this.currentScope() && this.#raw.isOpen(lane); }
  send(lane: PeerLane, data: string | ArrayBuffer | Uint8Array): boolean { return !!this.currentScope() && this.#raw.send(lane, data); }
  onData(listener: (lane: PeerLane, data: string | ArrayBuffer) => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  onStateChange(listener: (state: PeerState) => void): () => void {
    this.#states.add(listener); try { listener(this.#state); } catch { /* Views cannot alter peer authority. */ }
    return () => { this.#states.delete(listener); };
  }
  status(): Readonly<{ phase: 'waiting' | 'verifying' | 'awaiting-enrollment' | 'active' | 'stopped'; reason: string; comparisonDigest?: string; remoteKeyId?: string; trust: 'key-pin' | 'owner-comparison' }> {
    this.alive();
    return Object.freeze({ phase: this.#stopped ? 'stopped' : this.#state === 'connected' ? 'active' : this.#verified ? 'awaiting-enrollment' : this.#local ? 'verifying' : 'waiting',
      reason: this.#reason, comparisonDigest: this.#verified ? this.#digest : undefined,
      remoteKeyId: this.#verified ? this.#remote?.keyId : undefined, trust: this.#options.expectedRemoteKeyId ? 'key-pin' : 'owner-comparison' });
  }
  confirmEnrollment(digest: string): boolean {
    if (!this.alive() || !this.#verified || !this.#digest || digest !== this.#digest) return false;
    this.#enrolled = true; this.advance(); return true;
  }
  tick(): void {
    if (!this.alive()) return;
    const now = this.now(); if (now === undefined) return;
    if (!this.#binding) {
      const binding = this.#raw.sessionBinding();
      if (!binding || !this.#raw.isOpen('reliable') || !this.#raw.isOpen('disposable')) return;
      this.#binding = binding; this.#startedAt = now;
      void this.prepare().catch(() => this.fail('identity-or-transcript-unavailable'));
    }
    if (this.#local && !this.#remote && now - this.#lastHelloAt >= 1000 && this.sendControl(this.#local)) this.#lastHelloAt = now;
    this.checkCurrency(now); this.advance();
  }
  private async prepare(): Promise<void> {
    const binding = this.#binding!;
    const point = new Uint8Array(this.#identity.publicKey);
    const [keyId, current] = await Promise.all([endpointKeyId(point, this.#crypto), this.#identity.isCurrent()]);
    if (!this.alive()) return;
    if (!current || keyId !== this.#identity.keyId) throw new TypeError('Identity unavailable');
    const nonce = this.#crypto.randomBytes(32); if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new TypeError('Secure nonce unavailable');
    this.#lastCurrencyAt = this.now()!; this.#lastCurrencyAttempt = this.#lastCurrencyAt;
    this.#local = Object.freeze({ protocol: 'connect-auth', version: 1, type: 'hello', epoch: this.#options.epoch,
      applicationId: this.#options.applicationId, sessionId: this.#options.sessionId, role: this.#options.role,
      party: binding.initiator ? 'offerer' : 'answerer', keyId, publicKey: bytesToHex(point), nonce: bytesToHex(nonce), ttlMs: this.#options.timeoutMs ?? 60000 });
    // Validate all advertised fingerprints before sending any endpoint assertion.
    fingerprints(binding.offer.sdp); fingerprints(binding.answer.sdp);
    if (this.sendControl(this.#local)) this.#lastHelloAt = this.now()!;
    this.advance();
  }
  private sendControl(packet: Control): boolean { return this.alive() && this.#raw.send('reliable', JSON.stringify(packet)); }
  private receive(lane: PeerLane, data: string | ArrayBuffer): void {
    if (!this.alive()) return;
    const packet = lane === 'reliable' ? control(data) : undefined;
    if (!packet) {
      if (!this.currentScope()) return;
      for (const listener of this.#listeners) {
        if (!this.currentScope()) break;
        try { listener(lane, data); } catch { /* A consumer cannot acquire new authority by throwing. */ }
      }
      return;
    }
    if (++this.#controls > 64 || packet.epoch !== this.#options.epoch) { this.fail('invalid-authentication'); return; }
    if (packet.type === 'hello') {
      const binding = this.#binding ?? this.#raw.sessionBinding();
      if (!binding || packet.applicationId !== this.#options.applicationId || packet.sessionId !== this.#options.sessionId ||
        packet.role === this.#options.role || packet.party !== (binding.initiator ? 'answerer' : 'offerer') ||
        packet.keyId === this.#identity.keyId || this.#options.expectedRemoteKeyId !== undefined && packet.keyId !== this.#options.expectedRemoteKeyId ||
        this.#remote && JSON.stringify(this.#remote) !== JSON.stringify(packet)) { this.fail('wrong-endpoint-or-scope'); return; }
      this.#remote = packet;
    } else if (packet.type === 'proof') {
      if (this.#remoteProof !== undefined && this.#remoteProof !== packet.signature) { this.fail('conflicting-proof'); return; }
      this.#remoteProof = packet.signature;
    } else {
      if (this.#remoteFinish !== undefined && this.#remoteFinish !== packet.digest) { this.fail('conflicting-finish'); return; }
      this.#remoteFinish = packet.digest;
    }
    this.advance();
  }
  private advance(): void {
    if (!this.alive() || !this.#local || !this.#remote) return;
    if (!this.#transcript && !this.#proving) {
      this.#proving = true;
      void this.prove().catch(() => this.fail('invalid-endpoint-proof')); return;
    }
    if (this.#proof && !this.#proofSent) this.#proofSent = this.sendControl({ protocol: 'connect-auth', version: 1, type: 'proof', epoch: this.#options.epoch, signature: this.#proof });
    if (this.#transcript && this.#remoteProof && !this.#verified && !this.#verifying) {
      this.#verifying = true;
      void this.verifyRemote().catch(() => this.fail('invalid-endpoint-proof')); return;
    }
    if (!this.#verified || !this.#proofSent || !this.#enrolled || !this.#digest) return;
    if (!this.#finishSent) this.#finishSent = this.sendControl({ protocol: 'connect-auth', version: 1, type: 'finish', epoch: this.#options.epoch, digest: this.#digest });
    if (this.#remoteFinish !== undefined && this.#remoteFinish !== this.#digest) { this.fail('wrong-transcript-finish'); return; }
    if (this.#finishSent && this.#remoteFinish === this.#digest && this.#state !== 'connected') {
      this.#scope = Object.freeze({ epoch: this.#options.epoch, applicationId: this.#options.applicationId, sessionId: this.#options.sessionId,
        role: this.#options.role, localKeyId: this.#local.keyId, remoteKeyId: this.#remote.keyId, transcriptDigest: this.#digest });
      this.#reason = 'authenticated'; this.setState('connected');
    }
  }
  private async prove(): Promise<void> {
    const local = this.#local!, remote = this.#remote!, binding = this.#binding!;
    const remotePoint = hexToBytes(remote.publicKey, 65);
    const [remoteId, offerHash, answerHash] = await Promise.all([endpointKeyId(remotePoint, this.#crypto),
      this.#crypto.sha256(new TextEncoder().encode(binding.offer.sdp)), this.#crypto.sha256(new TextEncoder().encode(binding.answer.sdp))]);
    if (!this.alive()) return;
    if (remoteId !== remote.keyId || offerHash.length !== 32 || answerHash.length !== 32 || local.nonce === remote.nonce) throw new TypeError('Invalid endpoint');
    const offerer = binding.initiator ? local : remote, answerer = binding.initiator ? remote : local;
    const transcript = JSON.stringify(['101.endpoint-transcript/1', this.#options.epoch, this.#options.applicationId, this.#options.sessionId,
      bytesToHex(offerHash), bytesToHex(answerHash), fingerprints(binding.offer.sdp), fingerprints(binding.answer.sdp), participant(offerer), participant(answerer)]);
    const digest = await this.#crypto.sha256(new TextEncoder().encode(transcript)); if (!this.alive()) return;
    if (digest.length !== 32) throw new TypeError('Invalid transcript digest');
    this.#transcript = transcript; this.#digest = bytesToHex(digest);
    const message = proofMessage(transcript, local), signature = new Uint8Array(await this.#identity.sign(message));
    if (!this.alive()) return;
    if (signature.length !== 64 || !await this.#crypto.verify(hexToBytes(local.publicKey, 65), message, signature)) throw new TypeError('Local key mismatch');
    if (!this.alive()) return;
    this.#proof = bytesToHex(signature); this.advance();
  }
  private async verifyRemote(): Promise<void> {
    const valid = await this.#crypto.verify(hexToBytes(this.#remote!.publicKey, 65), proofMessage(this.#transcript!, this.#remote!), hexToBytes(this.#remoteProof!, 64));
    if (!this.alive()) return;
    if (!valid) throw new TypeError('Remote proof rejected');
    this.#verified = true; this.#verifying = false; this.#enrolled = this.#options.expectedRemoteKeyId !== undefined;
    this.#reason = this.#enrolled ? 'waiting-for-peer-confirmation' : 'compare-transcript-and-enroll'; this.advance();
  }
  private checkCurrency(now: number): void {
    if (!this.#local) return;
    if (now - this.#lastCurrencyAt > 2000) { this.fail('identity-unavailable'); return; }
    if (this.#currencyPending || now - this.#lastCurrencyAttempt < 1000) return;
    this.#currencyPending = true; this.#lastCurrencyAttempt = now;
    void this.#identity.isCurrent().then(current => {
      if (!this.alive()) return;
      this.#currencyPending = false;
      if (!current) this.fail('identity-unavailable'); else this.#lastCurrencyAt = this.now()!;
    }).catch(() => this.fail('identity-unavailable'));
  }
  private setState(state: PeerState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#states) { if (this.#state !== state) break; try { listener(state); } catch { /* Observer only. */ } }
  }
  private fail(reason: string): void { this.retire(reason, 'failed'); }
  stop(): void { this.retire('revoked', 'disconnected'); }
  private retire(reason: string, state: PeerState): void {
    if (this.#stopped) return;
    this.#stopped = true; this.#reason = reason; this.#scope = undefined;
    for (const detach of this.#detach.splice(0)) { try { detach(); } catch { /* Continue local retirement. */ } }
    this.#listeners.clear(); this.setState(state); this.#states.clear();
    void this.#raw.disconnect().catch(() => { /* The resource gate is already closed. */ });
  }
}
