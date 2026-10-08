import childProcess from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { types } from 'node:util';
import type { JsonObject } from '@101/device-model';

export const CAN_DIAGNOSTIC_LIMITS = Object.freeze({ rawFrames: 256, rawBytes: 4096, sessionMs: 30000,
  heartbeatMs: 1000, readMs: 1000, pipeBytes: 65536, records: 512, stderrBytes: 4096, rawWrites: 4 } as const);
export interface CanDiagnosticProfile {
  readonly profileId: 'canopen-cc-diagnostics-vcan/1' | 'canopen-cc-diagnostics-harness/1'; readonly revision: 1;
  readonly interfaceName: string; readonly expectedIfindex: number; readonly namespaceInode: string; readonly nodeId: number;
  readonly nativeExecutablePath: string; readonly nativeExecutableSha256: string; readonly nativeSourceSha256: string;
  readonly environmentReceiptSha256: string;
}
export interface CanDiagnosticRecord { readonly kind: 'heartbeat' | 'device-type' | 'error-register' | 'sdo-abort'; readonly nodeId: number; readonly value: number }
export interface CanDiagnosticReading { readonly record: Readonly<CanDiagnosticRecord>; readonly localSequence: number;
  readonly receivedAt: number; readonly provenance: Readonly<JsonObject> }
export interface CanDiagnosticApprovalRequest {
  readonly action: 'observe-read-diagnostics'; readonly principalId: string; readonly applicationId: string; readonly sessionId: string;
  readonly purpose: string; readonly generation: number; readonly deadline: number; readonly role: 'scripted-process-harness';
  readonly profile: Readonly<CanDiagnosticProfile>; readonly targets: readonly Readonly<ReadTarget>[]; readonly budgets: typeof CAN_DIAGNOSTIC_LIMITS;
}
export interface CanDiagnosticApproval { readonly request: CanDiagnosticApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface CanDiagnosticOptions { readonly profile: CanDiagnosticProfile; readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly ownerSignal: AbortSignal; readonly authorize: (request: CanDiagnosticApprovalRequest) => CanDiagnosticApproval | undefined;
  readonly onReading: (reading: CanDiagnosticReading) => void; readonly onUnavailable: (reason: string) => void }
export interface CanDiagnosticConnector {
  start(request: Readonly<{ purpose: string; signal: AbortSignal; deadline: number }>): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>>;
  stop(): Promise<void>; close(): Promise<void>;
  status(): Readonly<{ phase: 'idle' | 'opening' | 'ready' | 'retiring' | 'closed'; nativeChildren: number; rawWrites: number;
    rawFrames: number; rawBytes: number; pipeBytes: number; delivered: number; rejected: number; reason: string;
    childClosed: boolean; childExitCode: number | null; childExitSignal: string | null }>;
}
interface ReadTarget { readonly index: 0x1000 | 0x1001; readonly subindex: 0; readonly width: 1 | 4 }
const TARGETS: readonly Readonly<ReadTarget>[] = Object.freeze([Object.freeze({ index: 0x1000, subindex: 0, width: 4 }), Object.freeze({ index: 0x1001, subindex: 0, width: 1 })]);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
function bad(): never { throw new TypeError('Invalid selected CAN diagnostic input'); }
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) bad();
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) bad();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) { const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property?.enumerable || !('value' in property)) bad(); result[key] = property.value; }
  return result;
}
function text(input: unknown, max = 128): string {
  if (typeof input !== 'string' || !input.length || input.length > max || Array.from(input).some(value => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127)) bad(); return input;
}
function uint(input: unknown, max: number, min = 0): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) bad(); return input;
}
function hash(input: unknown): string { const result = text(input, 64); if (!/^[a-f0-9]{64}$/.test(result)) bad(); return result; }
function bytes(input: unknown, length: number): Buffer {
  if (!input || types.isProxy(input) || !(input instanceof Uint8Array) || byteLength.call(input) !== length) bad();
  const result = Buffer.alloc(length); Uint8Array.prototype.set.call(result, input); return result;
}
function signal(input: unknown): AbortSignal {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== AbortSignal.prototype) bad();
  try { Reflect.apply(signalAborted, input, []); } catch { bad(); } return input as AbortSignal;
}
function aborted(input: AbortSignal): boolean { return Reflect.apply(signalAborted, input, []) as boolean; }
function finite(input: unknown): number { if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > Number.MAX_SAFE_INTEGER) bad(); return input; }
function nsFloor(ms: number): bigint {
  finite(ms); const representation = Buffer.alloc(8); representation.writeDoubleLE(ms); const bits = representation.readBigUInt64LE();
  const exponentBits = Number((bits >> 52n) & 0x7ffn), mantissa = (bits & 0xfffffffffffffn) | (exponentBits ? 0x10000000000000n : 0n);
  const exponent = exponentBits ? exponentBits - 1023 - 52 : -1074;
  const scaled = mantissa * 1000000n, value = exponent >= 0 ? scaled << BigInt(exponent) : scaled >> BigInt(-exponent);
  if (value > 0xffffffffffffffffn) bad(); return value;
}
function allZero(payload: Buffer, start: number): void { for (let at = start; at < payload.length; at++) if (payload[at] !== 0) bad(); }

export function parseCanDiagnosticProfile(input: unknown): Readonly<CanDiagnosticProfile> {
  const p = object(input, ['profileId', 'revision', 'interfaceName', 'expectedIfindex', 'namespaceInode', 'nodeId', 'nativeExecutablePath',
    'nativeExecutableSha256', 'nativeSourceSha256', 'environmentReceiptSha256']);
  if (typeof p.profileId !== 'string' || !['canopen-cc-diagnostics-vcan/1', 'canopen-cc-diagnostics-harness/1'].includes(p.profileId) || p.revision !== 1) bad();
  const profileId = p.profileId as CanDiagnosticProfile['profileId'], interfaceName = text(p.interfaceName, 15), namespaceInode = text(p.namespaceInode, 20);
  if (!/^[A-Za-z0-9_-]+$/.test(interfaceName) || !/^(0|[1-9][0-9]*)$/.test(namespaceInode) || BigInt(namespaceInode) > 0xffffffffffffffffn) bad();
  const expectedIfindex = uint(p.expectedIfindex, 0x7fffffff), nativeExecutablePath = text(p.nativeExecutablePath, 4096);
  if (!nativeExecutablePath.startsWith('/')) bad();
  if (profileId === 'canopen-cc-diagnostics-harness/1') { if (interfaceName !== 'harness' || expectedIfindex !== 0 || namespaceInode !== '0') bad(); }
  else if (expectedIfindex === 0 || namespaceInode === '0') bad();
  return Object.freeze({ profileId, revision: 1, interfaceName, expectedIfindex, namespaceInode, nodeId: uint(p.nodeId, 127, 1), nativeExecutablePath,
    nativeExecutableSha256: hash(p.nativeExecutableSha256), nativeSourceSha256: hash(p.nativeSourceSha256), environmentReceiptSha256: hash(p.environmentReceiptSha256) });
}

export function decodeCanDiagnosticFrame(input: Uint8Array, nodeId: number, pending: Readonly<ReadTarget> | null): Readonly<CanDiagnosticRecord> {
  const raw = bytes(input, 16); uint(nodeId, 127, 1); const id = raw.readUInt32LE(0), length = raw[4]!;
  if (id > 0x7ff || length > 8 || (raw[7] !== 0 && (length !== 8 || raw[7]! < 9 || raw[7]! > 15))) bad();
  const data = raw.subarray(8, 8 + length);
  if (id === 0x700 + nodeId) { if (length !== 1 || ![0, 4, 5, 127].includes(data[0]!)) bad();
    return Object.freeze({ kind: 'heartbeat', nodeId, value: data[0]! }); }
  if (id !== 0x580 + nodeId || length !== 8 || !pending || data.readUInt16LE(1) !== pending.index || data[3] !== pending.subindex) bad();
  if (data[0] === 0x80) return Object.freeze({ kind: 'sdo-abort', nodeId, value: data.readUInt32LE(4) });
  if (pending.index === 0x1000 && pending.width === 4 && data[0] === 0x43) return Object.freeze({ kind: 'device-type', nodeId, value: data.readUInt32LE(4) });
  if (pending.index === 0x1001 && pending.width === 1 && data[0] === 0x4f) return Object.freeze({ kind: 'error-register', nodeId, value: data[4]! });
  return bad();
}

/** Fixed private process ABI. These inert codecs never launch or write a device. */
export function encodeCanPortRecord(kind: number, nonce: Uint8Array, generation: number, ordinal: number, payload: Uint8Array): Buffer {
  uint(kind, 8, 1); uint(generation, 0xffffffff, 1); uint(ordinal, CAN_DIAGNOSTIC_LIMITS.records, 1);
  const record = Buffer.alloc(128); record.write('C101', 0, 'ascii'); record[4] = 1; record[5] = kind;
  bytes(nonce, 16).copy(record, 8); record.writeUInt32LE(generation, 24); record.writeUInt32LE(ordinal, 28); bytes(payload, 96).copy(record, 32); return record;
}
export function parseCanPortRecord(input: Uint8Array, nonce: Uint8Array, generation: number, ordinal: number): Readonly<{ kind: number; payload: Buffer }> {
  const record = bytes(input, 128), payload = Buffer.from(record.subarray(32));
  if (record.toString('ascii', 0, 4) !== 'C101' || record[4] !== 1 || record[6] !== 0 || record[7] !== 0 ||
    !record.subarray(8, 24).equals(bytes(nonce, 16)) || record.readUInt32LE(24) !== generation || record.readUInt32LE(28) !== ordinal) bad();
  const kind = record[5]!;
  if (kind === 4) { allZero(payload, 16); }
  else if (kind === 5) {
    if (payload.readUInt32LE(0) === 0 || (payload.readUInt32LE(4) & 40) !== 0 || payload.readUInt32LE(12) > 3 ||
      payload.readUInt32LE(24) >= 1000000000 || payload.readUInt32LE(28) !== 16 || payload.readUInt32LE(56) > 2) bad();
    if (!(payload.readUInt32LE(12) & 1) && (payload.readBigInt64LE(16) !== 0n || payload.readUInt32LE(24) !== 0)) bad();
    if (!(payload.readUInt32LE(12) & 2) && payload.readUInt32LE(8) !== 0) bad(); allZero(payload, 60);
  } else if (kind === 6) { if (![1, 2].includes(payload.readUInt32LE(0)) || payload.readUInt32LE(4) !== 16) bad(); allZero(payload, 8); }
  else if (kind === 7) { uint(payload.readUInt32LE(0), 12, 1); allZero(payload, 4); }
  else if (kind === 8) allZero(payload, 0);
  else bad();
  return Object.freeze({ kind, payload });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
interface Pending { readonly target: Readonly<ReadTarget>; readonly ordinal: number; readonly deadline: number;
  readonly result: ReturnType<typeof deferred<boolean>>; dispatched: boolean; responded: boolean; timer: ReturnType<typeof setTimeout> }
interface Session {
  readonly generation: number; readonly nonce: Buffer; readonly caller: AbortSignal; readonly deadline: number;
  readonly terminal: ReturnType<typeof deferred<false>>; readonly ready: ReturnType<typeof deferred<boolean>>;
  readonly childClosed: ReturnType<typeof deferred<void>>; readonly writes: Set<Promise<void>>; readonly detaches: (() => void)[];
  child?: ChildProcessWithoutNullStreams; childReserved: boolean; retired: boolean; retiring?: Promise<void>; closingStdin: boolean;
  closeObserved: boolean; exitCode: number | null; exitSignal: string | null;
  approval?: AbortSignal; expiry: number; buffer: Buffer; incoming: number; outgoing: number; rxOrdinal: number;
  rawFrames: number; rawBytes: number; pipeBytes: number; stderrBytes: number; pending?: Pending;
  lastHeartbeat: number; nmt: number; readsStarted: boolean; timer?: ReturnType<typeof setTimeout>; freshness?: ReturnType<typeof setTimeout>;
  term?: ReturnType<typeof setTimeout>; kill?: ReturnType<typeof setTimeout>;
}

/** Host-admitted scripted process only. Native clock/socket admission is a separate unapproved gate. */
export function createCanDiagnosticConnector(input: CanDiagnosticOptions): CanDiagnosticConnector {
  const o = object(input, ['profile', 'scope', 'ownerSignal', 'authorize', 'onReading', 'onUnavailable']);
  const profile = parseCanDiagnosticProfile(o.profile), scopeInput = object(o.scope, ['principalId', 'applicationId', 'sessionId']);
  const scope = Object.freeze({ principalId: text(scopeInput.principalId), applicationId: text(scopeInput.applicationId), sessionId: text(scopeInput.sessionId) });
  const owner = signal(o.ownerSignal);
  if (typeof o.authorize !== 'function' || typeof o.onReading !== 'function' || typeof o.onUnavailable !== 'function') bad();
  const authorize = o.authorize as CanDiagnosticOptions['authorize'], onReading = o.onReading as CanDiagnosticOptions['onReading'];
  const onUnavailable = o.onUnavailable as CanDiagnosticOptions['onUnavailable'];
  // The fixed local executable is a host-owned reviewed artifact, never a bus field.
  if (realpathSync(profile.nativeExecutablePath) !== profile.nativeExecutablePath || !lstatSync(profile.nativeExecutablePath).isFile() ||
    createHash('sha256').update(readFileSync(profile.nativeExecutablePath)).digest('hex') !== profile.nativeExecutableSha256) bad();
  let session: Session | undefined, phase: 'idle' | 'opening' | 'ready' | 'retiring' | 'closed' = 'idle', closed = false;
  let generation = 0, sequence = 0, delivered = 0, rejected = 0, reason = 'idle';
  const failure = (code: string) => Object.freeze({ ok: false as const, reason: code });
  function current(s: Session): boolean { return session === s && !closed && !s.retired && !aborted(owner) && !aborted(s.caller) &&
    (!s.approval || !aborted(s.approval)) && now() < s.expiry; }
  function watch(s: Session, value: AbortSignal): void {
    const listener = () => { void retire(s, 'revoked'); }; Reflect.apply(addListener, value, ['abort', listener, { once: true }]);
    s.detaches.push(() => Reflect.apply(removeListener, value, ['abort', listener]));
    if (aborted(value)) void retire(s, 'revoked');
  }
  function reject(s: Session, code: string): void { rejected++; void retire(s, code); }
  function trackWrite(s: Session, dispatch: (done: (error?: Error | null) => void) => void): Promise<void> {
    if (s.writes.size >= CAN_DIAGNOSTIC_LIMITS.rawWrites) { reject(s, 'write-budget'); return Promise.reject(new Error('write-budget')); }
    let finish!: (error?: Error | null) => void;
    const pending = new Promise<void>((resolve, rejectWrite) => { let finished = false;
      finish = error => { if (finished) return; finished = true; if (error) rejectWrite(error); else resolve(); }; });
    s.writes.add(pending);
    // Every raw write has immediate rejection ownership, including synchronous callbacks.
    void pending.then(() => { s.writes.delete(pending); }, () => { s.writes.delete(pending); reject(s, 'pipe-write'); });
    try { dispatch(finish); } catch (error) { finish(error instanceof Error ? error : new Error('pipe-write')); }
    return pending;
  }
  function closeStdin(s: Session): void {
    if (!s.child || s.closingStdin) return; s.closingStdin = true;
    void trackWrite(s, done => s.child!.stdin.end(done)).catch(() => {});
    s.term = setTimeout(() => { try { s.child?.kill('SIGTERM'); } catch { reason = 'kill-failed'; } }, 250);
    s.kill = setTimeout(() => { try { s.child?.kill('SIGKILL'); } catch { reason = 'kill-failed'; } }, 1000);
  }
  function retire(s: Session, code: string): Promise<void> {
    if (s.retiring) return s.retiring;
    s.retired = true; phase = 'retiring'; reason = code;
    if (s.timer) clearTimeout(s.timer); if (s.freshness) clearTimeout(s.freshness);
    if (s.pending) { clearTimeout(s.pending.timer); s.pending.result.resolve(false); s.pending = undefined; }
    for (const detach of s.detaches.splice(0)) detach(); s.terminal.resolve(false); s.ready.resolve(false);
    const joined = deferred<void>(); s.retiring = joined.promise;
    closeStdin(s);
    if (!s.childReserved) s.childClosed.resolve();
    void (async () => {
      await s.childClosed.promise;
      while (s.writes.size) await Promise.allSettled([...s.writes]);
      if (s.term) clearTimeout(s.term); if (s.kill) clearTimeout(s.kill);
      s.childReserved = false;
      if (session === s) phase = closed ? 'closed' : 'idle'; joined.resolve();
    })().catch(() => { /* A raw cleanup failure cannot erase a reservation. */ });
    try { onUnavailable(code); } catch { /* Source was already retired; no callback error may restore authority. */ }
    return joined.promise;
  }
  function send(s: Session, kind: number, payload: Buffer): Promise<void> {
    if (!current(s) || !s.child || ++s.outgoing > CAN_DIAGNOSTIC_LIMITS.records) return Promise.reject(new Error('expired'));
    const record = encodeCanPortRecord(kind, s.nonce, s.generation, s.outgoing, payload);
    if (!current(s)) return Promise.reject(new Error('expired'));
    return trackWrite(s, done => { if (!current(s)) { done(new Error('expired')); return; } s.child!.stdin.write(record, done); });
  }
  function freshness(s: Session): void {
    if (s.freshness) clearTimeout(s.freshness); if (!current(s)) return;
    const expires = Math.min(s.expiry, s.lastHeartbeat + CAN_DIAGNOSTIC_LIMITS.heartbeatMs);
    s.freshness = setTimeout(() => { void retire(s, 'heartbeat-stale'); }, Math.max(0, expires - now()));
  }
  function readAll(s: Session): void {
    if (s.readsStarted || phase !== 'ready' || !current(s) || ![5, 127].includes(s.nmt) || now() - s.lastHeartbeat >= 1000) return;
    s.readsStarted = true;
    const run = (async () => {
      for (let at = 0; at < TARGETS.length; at++) {
        if (!current(s) || ![5, 127].includes(s.nmt) || now() - s.lastHeartbeat >= 1000) return;
        const target = TARGETS[at]!, deadline = Math.min(s.expiry, now() + CAN_DIAGNOSTIC_LIMITS.readMs), result = deferred<boolean>();
        const pending: Pending = { target, ordinal: at + 1, deadline, result, dispatched: false, responded: false,
          timer: setTimeout(() => { void retire(s, 'sdo-timeout'); }, Math.max(0, deadline - now())) };
        s.pending = pending;
        const payload = Buffer.alloc(96); payload.writeUInt32LE(pending.ordinal, 0); payload.writeUInt16LE(target.index, 4); payload[6] = 0; payload[7] = target.width;
        // Scripted child's relative execution budget is distinct from the original parent authority.
        payload.writeBigUInt64LE(nsFloor(Math.max(0, deadline - now())), 8);
        const written = send(s, 2, payload); void written.catch(() => {});
        const accepted = await Promise.race([written.then(() => result.promise), s.terminal.promise]);
        if (!accepted || !current(s)) return;
        clearTimeout(pending.timer); if (s.pending === pending) s.pending = undefined;
      }
    })();
    void run.catch(() => reject(s, 'read-failed'));
  }
  function message(s: Session, input: Buffer): void {
    if (++s.incoming > CAN_DIAGNOSTIC_LIMITS.records) { reject(s, 'pipe-budget'); return; }
    if (input[5] === 5) {
      s.rawFrames++; s.rawBytes += 16;
      if (s.rawFrames > CAN_DIAGNOSTIC_LIMITS.rawFrames || s.rawBytes > CAN_DIAGNOSTIC_LIMITS.rawBytes) { reject(s, 'receive-budget'); return; }
    }
    const { kind, payload } = parseCanPortRecord(input, s.nonce, s.generation, s.incoming);
    if (kind === 4) {
      if (phase !== 'opening' || payload.readUInt32LE(0) !== 0 || payload.readUInt32LE(4) !== 0 || payload.readBigUInt64LE(8) !== 0n) bad();
      s.ready.resolve(true); return;
    }
    if (kind === 7 || kind === 8) { void retire(s, kind === 7 ? 'child-fault-' + payload.readUInt32LE(0) : 'child-closed'); return; }
    if (kind === 6) {
      const pending = s.pending; if (!pending || pending.dispatched || payload.readUInt32LE(0) !== pending.ordinal || now() >= pending.deadline) bad();
      pending.dispatched = true; return;
    }
    if (payload.readUInt32LE(0) !== ++s.rxOrdinal) bad();
    // Harness must not fabricate native ancillary or capture-clock evidence.
    if (payload.readUInt32LE(4) !== 0 || payload.readUInt32LE(12) !== 0 || payload.readBigUInt64LE(32) !== 0n) bad();
    if (phase !== 'ready') return; // Opening bytes are charged, never replayed on activation.
    if (!current(s)) { void retire(s, 'expired'); return; }
    const raw = payload.subarray(40, 56), id = raw.readUInt32LE(0), pending = s.pending;
    const request = payload.readUInt32LE(56);
    if (id === 0x700 + profile.nodeId) { if (request !== 0) bad(); }
    else if (!pending || !pending.dispatched || pending.responded || request !== pending.ordinal || now() >= pending.deadline) bad();
    const record = decodeCanDiagnosticFrame(raw, profile.nodeId, pending?.target ?? null), receivedAt = now();
    if (record.kind !== 'heartbeat') pending!.responded = true;
    if (record.kind === 'heartbeat') {
      s.lastHeartbeat = receivedAt; s.nmt = record.value; freshness(s);
      if (s.pending && ![5, 127].includes(record.value)) { void retire(s, 'node-state-change'); return; }
    }
    if (!Number.isSafeInteger(++sequence)) { void retire(s, 'sequence-exhausted'); return; }
    const provenance: JsonObject = Object.freeze({ protocol: 'CANopen-CC-selected-diagnostics', profileId: profile.profileId, revision: 1,
      interfaceName: profile.interfaceName, ifindex: 0, namespaceInode: '0', nodeId: profile.nodeId,
      raw16hex: raw.toString('hex'), rawSha256: createHash('sha256').update(raw).digest('hex'), length: raw[4]!, len8Dlc: raw[7]!,
      flags: 0, recvmsgFlags: null, nativeMonotonicNs: null, kernelTimestamp: null, receiverOverflow: null,
      localReceiveOrdinal: s.rxOrdinal, sessionNonce: s.nonce.toString('hex'), generation: s.generation, requestOrdinal: request,
      objectIndex: request ? pending!.target.index : null, subindex: request ? 0 : null, producerKind: 'scripted-process-harness',
      receiptClockId: 'can-gateway-harness-monotonic', receivedAt, nativeExecutableSha256: profile.nativeExecutableSha256,
      environmentReceiptSha256: profile.environmentReceiptSha256, physical: false, sourceTimeMapped: false,
      lossKnowledge: 'unknown-CAN-loss', qualityKnowledge: 'native-quality-not-provided' });
    if (!current(s)) return; delivered++;
    try { onReading(Object.freeze({ record, localSequence: sequence, receivedAt, provenance })); } catch { reject(s, 'reading-callback'); return; }
    if (!current(s)) { void retire(s, 'revoked'); return; }
    if (record.kind === 'heartbeat') readAll(s); else pending!.result.resolve(true);
  }
  async function start(inputRequest: Readonly<{ purpose: string; signal: AbortSignal; deadline: number }>) {
    if (closed) return failure('closed'); if (session && phase !== 'idle') return failure('busy');
    let request: Record<string, unknown>, caller: AbortSignal, originalDeadline: number, purpose: string;
    try { request = object(inputRequest, ['purpose', 'signal', 'deadline']); caller = signal(request.signal); originalDeadline = finite(request.deadline); purpose = text(request.purpose); }
    catch { return failure('invalid-start'); }
    const startedAt = now();
    if (originalDeadline <= startedAt || originalDeadline - startedAt > CAN_DIAGNOSTIC_LIMITS.sessionMs || aborted(owner) || aborted(caller)) return failure('invalid-start');
    if (profile.profileId !== 'canopen-cc-diagnostics-harness/1') return failure('blocked-native-environment');
    if (generation >= 0xffffffff) { closed = true; phase = 'closed'; return failure('generation-exhausted'); }
    const s: Session = { generation: ++generation, nonce: randomBytes(16), caller, deadline: originalDeadline, expiry: originalDeadline,
      terminal: deferred<false>(), ready: deferred<boolean>(), childClosed: deferred<void>(), writes: new Set(), detaches: [],
      childReserved: false, retired: false, closingStdin: false, closeObserved: false, exitCode: null, exitSignal: null,
      buffer: Buffer.alloc(0), incoming: 0, outgoing: 0, rxOrdinal: 0,
      rawFrames: 0, rawBytes: 0, pipeBytes: 0, stderrBytes: 0, lastHeartbeat: startedAt, nmt: 0, readsStarted: false };
    session = s; phase = 'opening'; reason = 'opening'; watch(s, owner); watch(s, caller);
    const authority: CanDiagnosticApprovalRequest = Object.freeze({ action: 'observe-read-diagnostics', ...scope, purpose,
      generation: s.generation, deadline: originalDeadline, role: 'scripted-process-harness', profile, targets: TARGETS, budgets: CAN_DIAGNOSTIC_LIMITS });
    try {
      if (!current(s)) { void retire(s, 'revoked'); return failure(reason); }
      const approved = authorize(authority);
      if (!current(s) || !approved) { void retire(s, 'denied'); return failure(reason); }
      const a = object(approved, ['request', 'signal', 'expiresAt']); if (a.request !== authority) bad();
      s.approval = signal(a.signal); s.expiry = Math.min(originalDeadline, finite(a.expiresAt)); watch(s, s.approval);
      if (!current(s)) { void retire(s, 'expired'); return failure(reason); }
      s.timer = setTimeout(() => { void retire(s, 'expired'); }, Math.max(0, s.expiry - now()));
      if (createHash('sha256').update(readFileSync(profile.nativeExecutablePath)).digest('hex') !== profile.nativeExecutableSha256 || !current(s)) bad();
      s.childReserved = true;
      let child: ChildProcessWithoutNullStreams;
      try { child = childProcess.spawn(profile.nativeExecutablePath, ['--scripted-harness'], { stdio: ['pipe', 'pipe', 'pipe'], env: { NODE_ENV: 'production' }, windowsHide: true }); }
      catch { s.childReserved = false; s.childClosed.resolve(); throw new Error('spawn-failed'); }
      s.child = child;
      child.once('close', (code, exitSignal) => { s.closeObserved = true; s.exitCode = code; s.exitSignal = exitSignal;
        if (s.term) clearTimeout(s.term); if (s.kill) clearTimeout(s.kill);
        s.childClosed.resolve(); if (!s.retired) void retire(s, 'child-close'); });
      child.on('error', () => { reject(s, 'child-error'); }); child.stdin.on('error', () => { reject(s, 'stdin-error'); });
      child.stdout.on('error', () => { reject(s, 'stdout-error'); }); child.stderr.on('error', () => { reject(s, 'stderr-error'); });
      child.stdout.on('data', (chunk: Buffer) => {
        if (s.retired) return;
        s.pipeBytes += chunk.length;
        if (s.pipeBytes > CAN_DIAGNOSTIC_LIMITS.pipeBytes || chunk.length + s.buffer.length > CAN_DIAGNOSTIC_LIMITS.pipeBytes) { reject(s, 'pipe-budget'); return; }
        s.buffer = Buffer.concat([s.buffer, chunk]);
        try { while (s.buffer.length >= 128 && !s.retired) { const next = s.buffer.subarray(0, 128); s.buffer = s.buffer.subarray(128); message(s, next); } }
        catch { reject(s, 'pipe-format'); }
      });
      child.stdout.on('end', () => { if (s.buffer.length) reject(s, 'partial-eof'); else if (!s.retired) void retire(s, 'stdout-eof'); });
      child.stderr.on('data', (chunk: Buffer) => { s.stderrBytes += chunk.length; if (s.stderrBytes > CAN_DIAGNOSTIC_LIMITS.stderrBytes) reject(s, 'stderr-budget'); });
      if (!current(s)) { closeStdin(s); void retire(s, 'revoked'); return failure(reason); }
      const config = Buffer.alloc(96); config[0] = profile.nodeId; config[1] = 2; config[2] = profile.interfaceName.length;
      config.write(profile.interfaceName, 4, 'ascii'); config.writeBigUInt64LE(nsFloor(Math.max(0, s.expiry - now())), 20);
      config.writeUInt32LE(CAN_DIAGNOSTIC_LIMITS.rawFrames, 28); config.writeUInt32LE(CAN_DIAGNOSTIC_LIMITS.rawBytes, 32);
      config.writeUInt32LE(CAN_DIAGNOSTIC_LIMITS.heartbeatMs, 36); config.writeBigUInt64LE(1000000000n, 40);
      const written = send(s, 1, config); void written.catch(() => {});
      const ready = await Promise.race([written.then(() => s.ready.promise), s.terminal.promise]);
      if (!ready || !current(s)) { void retire(s, reason); return failure(reason); }
      phase = 'ready'; reason = 'ready'; freshness(s); return Object.freeze({ ok: true as const });
    } catch { void retire(s, 'invalid-approval-or-port'); return failure(reason); }
  }
  return Object.freeze({ start, stop: () => session && phase !== 'idle' ? retire(session, 'stopped') : Promise.resolve(),
    close: () => { closed = true; if (session && phase !== 'idle') return retire(session, 'closed'); phase = 'closed'; reason = 'closed'; return Promise.resolve(); },
    status: () => Object.freeze({ phase, nativeChildren: session?.childReserved ? 1 : 0, rawWrites: session?.writes.size ?? 0,
      rawFrames: session?.rawFrames ?? 0, rawBytes: session?.rawBytes ?? 0, pipeBytes: session?.pipeBytes ?? 0, delivered, rejected, reason,
      childClosed: session?.closeObserved ?? false, childExitCode: session?.exitCode ?? null, childExitSignal: session?.exitSignal ?? null }) });
}
