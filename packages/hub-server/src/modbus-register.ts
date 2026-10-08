import { createConnection, isIP, type Socket } from 'node:net';
import { checkServerIdentity, connect as connectTls, type TLSSocket } from 'node:tls';

export const MODBUS_REGISTER_LIMITS = Object.freeze({ sockets: 1, pendingTransactions: 1, registers: 16,
  attempts: 8, operations: 64, frameBytes: 260, totalBytes: 65536, operationMs: 1000, sessionMs: 60000 });
export type ModbusFailure = 'invalid' | 'denied' | 'expired' | 'closed' | 'busy' | 'lost' | 'timeout' | 'protocol' | 'exception' | 'cancelled' | 'quota';
export type ModbusResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: ModbusFailure; issued?: true; uncertain?: true }>;
export interface ModbusEpoch { readonly modbusEpoch?: never }
export interface ModbusRegister {
  readonly id: string; readonly address: number; readonly access: 'read' | 'write';
  /** Explicit unsigned 16-bit register conversion; no inferred device meaning. */
  readonly unit: string; readonly scale: number; readonly offset: number;
}
export interface ModbusProfile { readonly id: string; readonly revision: number; readonly unitId: number; readonly registers: readonly ModbusRegister[] }
export type ModbusEndpoint = Readonly<{ host: string; port: number; transport: 'loopback' }> |
  Readonly<{ host: string; port: number; transport: 'tls'; serverName: string; ca: string; certificateSha256: string }>;
export interface ModbusApprovalRequest {
  readonly action: 'connect' | 'read' | 'write'; readonly principalId: string; readonly applicationId: string; readonly sessionId: string;
  readonly endpoint: string; readonly profileId: string; readonly profileRevision: number; readonly generation: number; readonly unitId: number;
  readonly purpose: string; readonly resourceId?: string; readonly address?: number; readonly rawValue?: number;
}
export interface ModbusApproval { readonly request: ModbusApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface ModbusRegisterOptions {
  readonly ownerSignal: AbortSignal; readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly endpoint: ModbusEndpoint; readonly profile: ModbusProfile;
  /** Host authority; declarations and register values cannot supply approval. */
  readonly authorize: (request: ModbusApprovalRequest) => ModbusApproval | undefined;
}
export interface ModbusReading {
  readonly value: number; readonly rawValue: number; readonly unit: string; readonly sequence: number;
  readonly receivedAt: number; readonly receiptClockId: string; readonly quality: 'valid';
}
export interface ModbusRegisterConnector {
  start(request: Readonly<{ purpose: string }>): Promise<ModbusResult<ModbusEpoch>>;
  read(epoch: ModbusEpoch, resourceId: string, request: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<ModbusResult<ModbusReading>>;
  write(epoch: ModbusEpoch, resourceId: string, value: number, request: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<ModbusResult<Readonly<{ evidence: 'target-acknowledged' }>>>;
  stop(): Promise<void>; close(): Promise<void>;
  status(): Readonly<{ phase: 'idle' | 'connecting' | 'ready' | 'retiring' | 'closed'; attempts: number; operations: number;
    nativeSockets: number; pendingTransactions: number; receivedBytes: number }>;
}
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
const aborted = (signal: AbortSignal): boolean => Reflect.apply(abortGetter, signal, []) as boolean;
function signal(value: unknown): value is AbortSignal { try { aborted(value as AbortSignal); return true; } catch { return false; } }
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || ![...required, ...optional].includes(key)) return;
      const item = Object.getOwnPropertyDescriptor(value, key); if (!item?.enumerable || !('value' in item)) return;
      result[key] = item.value;
    }
    return required.every(key => Object.hasOwn(result, key)) ? result : undefined;
  } catch { return; }
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,79}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const failed = <T = never>(reason: ModbusFailure, issued = false): ModbusResult<T> => Object.freeze({ ok: false, reason, ...(issued ? { issued: true as const, uncertain: true as const } : {}) });
const success = <T>(value: T): ModbusResult<T> => Object.freeze({ ok: true, value });
function watch(value: AbortSignal, action: () => void): () => void {
  Reflect.apply(add, value, ['abort', action, { once: true }]);
  return () => Reflect.apply(remove, value, ['abort', action]);
}
interface Approved { signal: AbortSignal; expiresAt: number }
interface Transaction {
  id: number; fn: 3 | 6; address: number; raw?: number; approval: Approved; caller: AbortSignal; issued: boolean;
  finish(result: ModbusResult<Reply>): void; current(): boolean;
}
interface Reply { raw: number; sequence: number; receivedAt: number; deadline: number; approval: Approved; caller: AbortSignal; active: Active }
interface Active {
  generation: number; handle: ModbusEpoch; approval: Approved; socket: Socket; connected: boolean; retired: boolean;
  closed: Promise<void>; detach: (() => void)[]; buffer: Buffer; transaction?: Transaction;
  finishStart(result: ModbusResult<ModbusEpoch>): void;
}

/** Selected FC03/FC06 TCP profile. No probing, arbitrary functions, retries,
 * offline writes or automatic reconnect. Remote use requires TLS and an enrolled
 * peer certificate; plain loopback fixtures establish no cryptographic identity.
 * A cancelled issued write may already have changed the target. Socket close
 * establishes local settlement, never actuator safety or remote rollback. */
export function createModbusRegisterConnector(input: ModbusRegisterOptions): ModbusRegisterConnector {
  const options = fields(input, ['ownerSignal', 'scope', 'endpoint', 'profile', 'authorize']);
  const scope = fields(options?.scope, ['principalId', 'applicationId', 'sessionId']);
  const endpoint = fields(options?.endpoint, ['host', 'port', 'transport'], ['serverName', 'ca', 'certificateSha256']);
  const profile = fields(options?.profile, ['id', 'revision', 'unitId', 'registers']);
  if (!options || !signal(options.ownerSignal) || !scope || !Object.values(scope).every(id) || !endpoint ||
    typeof endpoint.host !== 'string' || !isIP(endpoint.host) || !integer(endpoint.port, 1, 65535) ||
    !profile || !id(profile.id) || !integer(profile.revision, 1, 2147483647) || !integer(profile.unitId, 1, 247) ||
    !Array.isArray(profile.registers) || profile.registers.length < 1 || profile.registers.length > MODBUS_REGISTER_LIMITS.registers ||
    typeof options.authorize !== 'function') throw new TypeError('Invalid Modbus register configuration');
  if (endpoint.transport === 'loopback') {
    if (!['127.0.0.1', '::1'].includes(endpoint.host) || Object.keys(endpoint).length !== 3) throw new TypeError('Plain Modbus is limited to loopback fixtures');
  } else if (endpoint.transport !== 'tls' || Object.keys(endpoint).length !== 6 || typeof endpoint.serverName !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(endpoint.serverName) || typeof endpoint.ca !== 'string' || endpoint.ca.length > 65536 ||
    !endpoint.ca.includes('-----BEGIN CERTIFICATE-----') || typeof endpoint.certificateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(endpoint.certificateSha256)) {
    throw new TypeError('Remote Modbus requires enrolled TLS');
  }
  const registers = new Map<string, ModbusRegister>();
  for (let index = 0; index < profile.registers.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(profile.registers, String(index));
    const row = fields(entry && 'value' in entry ? entry.value : undefined, ['id', 'address', 'access', 'unit', 'scale', 'offset']);
    if (!row || !id(row.id) || registers.has(row.id) || !integer(row.address, 0, 65535) || !['read', 'write'].includes(String(row.access)) ||
      typeof row.unit !== 'string' || !/^[A-Za-z0-9%./_-]{1,32}$/.test(row.unit) || typeof row.scale !== 'number' || !Number.isFinite(row.scale) || row.scale === 0 ||
      typeof row.offset !== 'number' || !Number.isFinite(row.offset) || !Number.isFinite(65535 * row.scale + row.offset)) throw new TypeError('Invalid reviewed Modbus register');
    registers.set(row.id, Object.freeze({ ...row }) as unknown as ModbusRegister);
  }
  const owner = options.ownerSignal, authorize = options.authorize as ModbusRegisterOptions['authorize'];
  const target = Object.freeze({ ...endpoint }), selectedProfile = Object.freeze({ id: profile.id, revision: profile.revision, unitId: profile.unitId });
  const ownedScope = Object.freeze({ ...scope }), handles = new WeakMap<object, Active>();
  let terminal = aborted(owner), generation = 0, attempts = 0, operations = 0, receivedBytes = 0, nativeSockets = 0, admitting = false;
  let active: Active | undefined;
  const receiptClockId = `modbus-host:${process.pid}:${globalThis.crypto.randomUUID()}`;
  function approved(request: ModbusApprovalRequest): Approved | undefined {
    let answer: unknown; try { answer = authorize(request); } catch { return; }
    const grant = fields(answer, ['request', 'signal', 'expiresAt']);
    const now = performance.now();
    if (!grant || grant.request !== request || !signal(grant.signal) || aborted(grant.signal) || typeof grant.expiresAt !== 'number' ||
      !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now || grant.expiresAt > now + MODBUS_REGISTER_LIMITS.sessionMs) return;
    return { signal: grant.signal, expiresAt: grant.expiresAt };
  }
  function current(a: Active): boolean {
    return !terminal && active === a && !a.retired && a.generation === generation && !aborted(owner) && !aborted(a.approval.signal) && performance.now() < a.approval.expiresAt;
  }
  function retire(a: Active, reason: ModbusFailure): void {
    if (a.retired) return;
    a.retired = true; a.buffer = Buffer.alloc(0);
    for (const detach of a.detach.splice(0)) detach();
    a.transaction?.finish(failed(reason, a.transaction.issued && a.transaction.fn === 6));
    a.finishStart(failed(reason)); a.socket.destroy();
  }
  function approvalRequest(action: ModbusApprovalRequest['action'], epoch: number, purpose: string, register?: ModbusRegister, raw?: number): ModbusApprovalRequest {
    return Object.freeze({ action, ...ownedScope, endpoint: `${target.transport}://${target.host}:${target.port}`,
      profileId: selectedProfile.id, profileRevision: selectedProfile.revision, generation: epoch, unitId: selectedProfile.unitId,
      purpose, ...(register ? { resourceId: register.id, address: register.address } : {}), ...(raw !== undefined ? { rawValue: raw } : {}) }) as ModbusApprovalRequest;
  }
  function receive(a: Active, chunk: Buffer): void {
    if (!current(a) || !a.connected || !a.transaction) { retire(a, 'protocol'); return; }
    receivedBytes += chunk.byteLength;
    if (receivedBytes > MODBUS_REGISTER_LIMITS.totalBytes || chunk.byteLength + a.buffer.byteLength > MODBUS_REGISTER_LIMITS.frameBytes) { retire(a, 'quota'); return; }
    a.buffer = Buffer.concat([a.buffer, chunk]);
    if (a.buffer.length < 7) return;
    const length = a.buffer.readUInt16BE(4), transaction = a.transaction;
    if (length < 3 || length > 254 || a.buffer.readUInt16BE(0) !== transaction.id || a.buffer.readUInt16BE(2) !== 0 ||
      a.buffer[6] !== selectedProfile.unitId || a.buffer.length > 6 + length) { retire(a, 'protocol'); return; }
    if (a.buffer.length < 6 + length) return;
    const response = a.buffer; a.buffer = Buffer.alloc(0);
    if (!transaction.current()) { retire(a, 'cancelled'); return; }
    if (response[7] === (transaction.fn | 0x80) && length === 3 && [1, 2, 3, 4, 5, 6, 8, 10, 11].includes(response[8]!)) { retire(a, 'exception'); return; }
    if (response[7] !== transaction.fn || (transaction.fn === 3 ? length !== 5 || response[8] !== 2 :
      length !== 6 || response.readUInt16BE(8) !== transaction.address || response.readUInt16BE(10) !== transaction.raw)) { retire(a, 'protocol'); return; }
    transaction.finish(success({ raw: transaction.fn === 3 ? response.readUInt16BE(9) : transaction.raw!, sequence: transaction.id,
      receivedAt: performance.now(), deadline: transaction.approval.expiresAt, approval: transaction.approval, caller: transaction.caller, active: a }));
  }
  async function start(raw: Readonly<{ purpose: string }>): Promise<ModbusResult<ModbusEpoch>> {
    const request = fields(raw, ['purpose']); if (!request || !id(request.purpose)) return failed('invalid');
    if (terminal || aborted(owner)) return failed('closed');
    if (admitting || active || nativeSockets) return failed('busy');
    if (attempts >= MODBUS_REGISTER_LIMITS.attempts) return failed('quota');
    attempts++; admitting = true; const epoch = ++generation;
    try {
      const approval = approved(approvalRequest('connect', epoch, request.purpose));
      if (!approval) return failed('denied');
      if (terminal || generation !== epoch || aborted(owner) || aborted(approval.signal) || performance.now() >= approval.expiresAt) return failed('cancelled');
      let resolveStart!: (result: ModbusResult<ModbusEpoch>) => void, finishClose!: () => void;
      const result = new Promise<ModbusResult<ModbusEpoch>>(resolve => { resolveStart = resolve; });
      const closed = new Promise<void>(resolve => { finishClose = resolve; });
      const socket = target.transport === 'loopback' ? createConnection({ host: target.host as string, port: target.port as number }) :
        connectTls({ host: target.host as string, port: target.port as number,
          servername: isIP(target.serverName as string) ? undefined : target.serverName as string, ca: target.ca as string,
          checkServerIdentity: (_name, certificate) => checkServerIdentity(target.serverName as string, certificate),
          rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      nativeSockets++;
      const a: Active = { generation: epoch, handle: Object.freeze({}), approval, socket, connected: false, retired: false,
        closed, detach: [], buffer: Buffer.alloc(0), finishStart: resolveStart };
      active = a; handles.set(a.handle, a);
      socket.on('error', () => retire(a, 'lost'));
      socket.on('end', () => retire(a, 'lost'));
      socket.on('data', chunk => receive(a, chunk));
      socket.once('close', () => {
        retire(a, 'lost'); nativeSockets--; if (active === a) active = undefined; finishClose();
      });
      const deadline = setTimeout(() => retire(a, 'expired'), Math.max(0, approval.expiresAt - performance.now()));
      const connectDeadline = setTimeout(() => retire(a, 'timeout'), MODBUS_REGISTER_LIMITS.operationMs);
      a.detach.push(() => clearTimeout(deadline), () => clearTimeout(connectDeadline), watch(approval.signal, () => retire(a, 'cancelled')));
      socket.once(target.transport === 'tls' ? 'secureConnect' : 'connect', () => {
        clearTimeout(connectDeadline);
        if (!current(a)) { retire(a, 'cancelled'); return; }
        if (target.transport === 'tls') {
          const certificate = (socket as TLSSocket).getPeerCertificate();
          if (!(socket as TLSSocket).authorized || certificate.fingerprint256?.replaceAll(':', '').toLowerCase() !== target.certificateSha256) { retire(a, 'denied'); return; }
        }
        socket.setNoDelay(true); a.connected = true; a.finishStart(success(a.handle));
      });
      return await result;
    } catch { if (active?.generation === epoch) retire(active, 'lost'); return failed('lost'); }
    finally { admitting = false; }
  }
  async function transact(epoch: ModbusEpoch, resourceId: string, fn: 3 | 6, rawValue: number | undefined,
    rawRequest: Readonly<{ purpose: string; signal: AbortSignal }>): Promise<ModbusResult<Reply>> {
    const request = fields(rawRequest, ['purpose', 'signal']);
    if (!request || !id(request.purpose) || !signal(request.signal) || !id(resourceId)) return failed('invalid');
    const register = registers.get(resourceId), a = epoch && typeof epoch === 'object' ? handles.get(epoch) : undefined;
    if (!register || register.access !== (fn === 3 ? 'read' : 'write') || !a || !current(a) || !a.connected) return failed('denied');
    if (aborted(request.signal)) return failed('cancelled');
    if (a.transaction || admitting) return failed('busy');
    if (operations >= MODBUS_REGISTER_LIMITS.operations) return failed('quota');
    admitting = true;
    let approval: Approved | undefined;
    try { approval = approved(approvalRequest(fn === 3 ? 'read' : 'write', a.generation, request.purpose, register, rawValue)); }
    finally { admitting = false; }
    if (!approval) return failed('denied');
    if (!current(a) || aborted(request.signal) || aborted(approval.signal) || performance.now() >= approval.expiresAt) return failed('cancelled');
    const caller = request.signal; const transactionId = ++operations;
    approval = { ...approval, expiresAt: Math.min(approval.expiresAt, performance.now() + MODBUS_REGISTER_LIMITS.operationMs) };
    return await new Promise<ModbusResult<Reply>>(resolve => {
      const disposers: (() => void)[] = [];
      const timer = setTimeout(() => retire(a, 'timeout'), Math.max(0, Math.min(MODBUS_REGISTER_LIMITS.operationMs, approval!.expiresAt - performance.now())));
      const transaction: Transaction = { id: transactionId, fn, address: register.address, raw: rawValue, approval, caller, issued: false,
        current: () => current(a) && a.transaction === transaction && !aborted(caller) && !aborted(approval!.signal) && performance.now() < approval!.expiresAt,
        finish(result) { if (a.transaction !== transaction) return; a.transaction = undefined;
          if (timer) clearTimeout(timer); for (const dispose of disposers) dispose(); resolve(result); } };
      a.transaction = transaction;
      disposers.push(watch(caller, () => retire(a, 'cancelled')), watch(approval!.signal, () => retire(a, 'cancelled')));
      const frame = Buffer.alloc(12); frame.writeUInt16BE(transactionId, 0); frame.writeUInt16BE(6, 4); frame[6] = selectedProfile.unitId as number;
      frame[7] = fn; frame.writeUInt16BE(register.address, 8); frame.writeUInt16BE(fn === 3 ? 1 : rawValue!, 10);
      if (!transaction.current()) { retire(a, 'cancelled'); return; }
      transaction.issued = true;
      try { a.socket.write(frame, error => { if (error) retire(a, 'lost'); }); } catch { retire(a, 'lost'); }
    });
  }
  async function stop(): Promise<void> { generation++; const a = active; if (a) { retire(a, 'cancelled'); await a.closed; } }
  function replyCurrent(reply: Reply): boolean {
    return current(reply.active) && !aborted(reply.caller) && !aborted(reply.approval.signal) && performance.now() < reply.deadline;
  }
  const removeOwner = watch(owner, () => { terminal = true; void stop(); });
  return Object.freeze({ start,
    async read(epoch: ModbusEpoch, resourceId: string, request: Readonly<{ purpose: string; signal: AbortSignal }>) {
      const result = await transact(epoch, resourceId, 3, undefined, request); if (!result.ok) return result;
      if (!replyCurrent(result.value)) return failed('cancelled');
      const register = registers.get(resourceId)!;
      return success(Object.freeze({ value: result.value.raw * register.scale + register.offset, rawValue: result.value.raw, unit: register.unit,
        sequence: result.value.sequence, receivedAt: result.value.receivedAt, receiptClockId, quality: 'valid' as const }));
    },
    async write(epoch: ModbusEpoch, resourceId: string, value: number, request: Readonly<{ purpose: string; signal: AbortSignal }>) {
      const register = registers.get(resourceId); if (!register || typeof value !== 'number' || !Number.isFinite(value)) return failed('invalid');
      const raw = (value - register.offset) / register.scale;
      if (!integer(raw, 0, 65535) || raw * register.scale + register.offset !== value) return failed('invalid');
      const result = await transact(epoch, resourceId, 6, raw, request);
      return result.ok ? replyCurrent(result.value) ? success(Object.freeze({ evidence: 'target-acknowledged' as const })) : failed('cancelled', true) : result;
    }, stop,
    async close() { terminal = true; removeOwner(); await stop(); },
    status() { return Object.freeze({ phase: terminal ? 'closed' as const : active ? active.retired ? 'retiring' as const : active.connected ? 'ready' as const : 'connecting' as const : 'idle' as const,
      attempts, operations, nativeSockets, pendingTransactions: active?.transaction ? 1 : 0, receivedBytes }); },
  });
}
