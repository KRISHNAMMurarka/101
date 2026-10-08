/** Selected Modbus RTU FC03/FC06 gateway. The host supplies a previously
 * enrolled serial capability and byte timestamps in performance.now()'s clock
 * domain. This module never discovers a port or treats unit/address as identity.
 * A port adapter must enforce the serial character timing it reports: a Node
 * chunk timestamp alone cannot establish physical t1.5/t3.5 compliance. */

export const MODBUS_RTU_LIMITS = Object.freeze({ ports: 1, pending: 1, registers: 16, attempts: 8,
  operations: 64, frameBytes: 256, totalBytes: 65536, operationMs: 1000, sessionMs: 60000 });
export type ModbusRtuFailure = 'invalid' | 'denied' | 'expired' | 'closed' | 'busy' | 'lost' | 'timeout' | 'protocol' | 'exception' | 'cancelled' | 'quota';
export type ModbusRtuResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: ModbusRtuFailure; issued?: true; uncertain?: true }>;
export interface ModbusRtuEpoch { readonly modbusRtuEpoch?: never }
export interface ModbusRtuRegister { readonly id: string; readonly address: number; readonly access: 'read' | 'write';
  readonly unit: string; readonly scale: number; readonly offset: number }
export interface ModbusRtuProfile { readonly id: string; readonly revision: number; readonly unitId: number; readonly registers: readonly ModbusRtuRegister[] }
export interface ModbusRtuPortSpec { readonly id: string; readonly baudRate: number; readonly parity: 'even' | 'odd' | 'none';
  readonly dataBits: 8; readonly stopBits: 1 | 2 }
/** One item is one physical character with its receive time. The host adapter
 * must timestamp bytes and preserve ordering. watermark(t) must resolve only
 * after all characters physically received through t have been yielded to and
 * consumed by bytes, and no earlier character can be delivered later. It must
 * reject if that guarantee is unavailable. Process pipes prove only a software
 * receipt-domain analogue, never physical serial timing. */
export interface ModbusRtuSerialPort { readonly identity: string; readonly bytes: AsyncIterable<Readonly<{ byte: number; at: number }>>;
  write(frame: Uint8Array): Promise<void>; watermark(throughAt: number): Promise<number>; close(): Promise<void> }
export interface ModbusRtuApprovalRequest { readonly action: 'connect' | 'read' | 'write'; readonly principalId: string;
  readonly applicationId: string; readonly sessionId: string; readonly portId: string; readonly baudRate: number;
  readonly parity: 'even' | 'odd' | 'none'; readonly dataBits: 8; readonly stopBits: 1 | 2;
  readonly profileId: string; readonly profileRevision: number; readonly generation: number; readonly unitId: number;
  readonly purpose: string; readonly deadline: number; readonly resourceId?: string; readonly address?: number; readonly rawValue?: number }
export interface ModbusRtuApproval { readonly request: ModbusRtuApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface ModbusRtuOptions { readonly ownerSignal: AbortSignal;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly port: ModbusRtuPortSpec; readonly profile: ModbusRtuProfile;
  readonly authorize: (request: ModbusRtuApprovalRequest) => ModbusRtuApproval | undefined;
  readonly openPort: (port: ModbusRtuPortSpec, signal: AbortSignal) => Promise<ModbusRtuSerialPort> }
export interface ModbusRtuReading { readonly value: number; readonly rawValue: number; readonly unit: string;
  readonly sequence: number; readonly receivedAt: number; readonly receiptClockId: string; readonly quality: 'valid' }
export interface ModbusRtuConnector {
  start(request: Readonly<{ purpose: string; deadline: number }>): Promise<ModbusRtuResult<ModbusRtuEpoch>>;
  read(epoch: ModbusRtuEpoch, resourceId: string, request: Readonly<{ purpose: string; signal: AbortSignal; deadline: number }>): Promise<ModbusRtuResult<ModbusRtuReading>>;
  write(epoch: ModbusRtuEpoch, resourceId: string, value: number, request: Readonly<{ purpose: string; signal: AbortSignal; deadline: number }>): Promise<ModbusRtuResult<Readonly<{ evidence: 'target-acknowledged' }>>>;
  stop(): Promise<void>; close(): Promise<void>;
  status(): Readonly<{ phase: 'idle' | 'opening' | 'ready' | 'retiring' | 'closed'; attempts: number; operations: number;
    nativePorts: number; pendingTransactions: number; rawPending: number; receivedBytes: number }>;
}

const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
const aborted = (signal: AbortSignal): boolean => Reflect.apply(abortGetter, signal, []) as boolean;
function signal(value: unknown): value is AbortSignal { try { aborted(value as AbortSignal); return true; } catch { return false; } }
function watch(value: AbortSignal, action: () => void): () => void {
  Reflect.apply(add, value, ['abort', action, { once: true }]);
  return () => Reflect.apply(remove, value, ['abort', action]);
}
function fields(value: unknown, required: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !required.includes(key)) return;
      const item = Object.getOwnPropertyDescriptor(value, key); if (!item?.enumerable || !('value' in item)) return;
      result[key] = item.value;
    }
    return required.every(key => Object.hasOwn(result, key)) ? result : undefined;
  } catch { return; }
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,79}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const validDeadline = (value: unknown, maxMs: number): value is number => typeof value === 'number' && Number.isFinite(value) &&
  value > performance.now() && value <= performance.now() + maxMs;
const failed = <T = never>(reason: ModbusRtuFailure, issued = false): ModbusRtuResult<T> => Object.freeze({ ok: false, reason,
  ...(issued ? { issued: true as const, uncertain: true as const } : {}) });
const success = <T>(value: T): ModbusRtuResult<T> => Object.freeze({ ok: true, value });
/** CRC-16/Modbus: initial FFFF, reflected polynomial A001, low byte first. */
function crc(bytes: Uint8Array): number {
  let value = 0xffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xa001 : value >>> 1; }
  return value;
}
function frame(body: Uint8Array): Uint8Array { const value = crc(body); return Uint8Array.from([...body, value & 255, value >>> 8]); }
function serialTiming(spec: ModbusRtuPortSpec): { characterMs: number; betweenMs: number; silenceMs: number } {
  const characterMs = 11000 / spec.baudRate;
  return { characterMs, betweenMs: spec.baudRate <= 19200 ? 1.5 * characterMs : 0.75,
    silenceMs: spec.baudRate <= 19200 ? 3.5 * characterMs : 1.75 };
}
interface Approved { signal: AbortSignal; expiresAt: number }
interface Transaction { fn: 3 | 6; register: ModbusRtuRegister; raw?: number; approval: Approved; caller: AbortSignal;
  deadline: number; issued: boolean; bytes: number[]; lastByteAt?: number; expected?: number;
  finish(result: ModbusRtuResult<Reply>): void; current(): boolean }
interface Reply { raw: number; sequence: number; receivedAt: number; active: Active; approval: Approved; caller: AbortSignal; deadline: number }
interface Active { generation: number; handle: ModbusRtuEpoch; approval: Approved; openAbort: AbortController;
  openPromise?: Promise<ModbusRtuSerialPort>; port?: ModbusRtuSerialPort; retired: boolean; ready: boolean;
  finishStart(result: ModbusRtuResult<ModbusRtuEpoch>): void; closePromise?: Promise<void>;
  writePromise?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>; detach: (() => void)[]; transaction?: Transaction;
  lastByteAt?: number; rawWritePending: boolean }

/** Issued FC06 plus an error is uncertain: an RTU echo is target protocol
 * acknowledgement, not independent observation or physical effect proof. */
export function createModbusRtuConnector(input: ModbusRtuOptions): ModbusRtuConnector {
  const options = fields(input, ['ownerSignal', 'scope', 'port', 'profile', 'authorize', 'openPort']);
  const scope = fields(options?.scope, ['principalId', 'applicationId', 'sessionId']);
  const selectedPort = fields(options?.port, ['id', 'baudRate', 'parity', 'stopBits', 'dataBits']);
  const profile = fields(options?.profile, ['id', 'revision', 'unitId', 'registers']);
  if (!options || !signal(options.ownerSignal) || !scope || !Object.values(scope).every(id) ||
    !selectedPort || !id(selectedPort.id) || !integer(selectedPort.baudRate, 1200, 115200) ||
    !['even', 'odd', 'none'].includes(String(selectedPort.parity)) || selectedPort.dataBits !== 8 ||
    (selectedPort.parity === 'none' ? selectedPort.stopBits !== 2 : selectedPort.stopBits !== 1) ||
    !profile || !id(profile.id) || !integer(profile.revision, 1, 2147483647) || !integer(profile.unitId, 1, 247) ||
    !Array.isArray(profile.registers) || profile.registers.length < 1 || profile.registers.length > MODBUS_RTU_LIMITS.registers ||
    typeof options.authorize !== 'function' || typeof options.openPort !== 'function') throw new TypeError('Invalid selected Modbus RTU configuration');
  const registers = new Map<string, ModbusRtuRegister>();
  for (let index = 0; index < profile.registers.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(profile.registers, String(index));
    const row = fields(entry && 'value' in entry ? entry.value : undefined, ['id', 'address', 'access', 'unit', 'scale', 'offset']);
    if (!row || !id(row.id) || registers.has(row.id) || !integer(row.address, 0, 65535) ||
      !['read', 'write'].includes(String(row.access)) || typeof row.unit !== 'string' ||
      !/^[A-Za-z0-9%./_-]{1,32}$/.test(row.unit) || typeof row.scale !== 'number' || !Number.isFinite(row.scale) || row.scale === 0 ||
      typeof row.offset !== 'number' || !Number.isFinite(row.offset) || !Number.isFinite(65535 * row.scale + row.offset))
      throw new TypeError('Invalid selected RTU register');
    registers.set(row.id, Object.freeze({ ...row }) as unknown as ModbusRtuRegister);
  }
  const owner = options.ownerSignal, authorize = options.authorize as ModbusRtuOptions['authorize'];
  const openPort = options.openPort as ModbusRtuOptions['openPort'];
  const portSpec = Object.freeze({ ...selectedPort }) as unknown as ModbusRtuPortSpec;
  const selectedProfile = Object.freeze({ id: profile.id as string, revision: profile.revision as number, unitId: profile.unitId as number });
  const ownedScope = Object.freeze({ ...scope });
  const handles = new WeakMap<object, Active>();
  const timing = serialTiming(portSpec);
  const receiptClockId = `modbus-rtu-host:${process.pid}:${globalThis.crypto.randomUUID()}`;
  let terminal = aborted(owner), generation = 0, attempts = 0, operations = 0, receivedBytes = 0, admitting = false;
  let active: Active | undefined;
  function approvalRequest(action: ModbusRtuApprovalRequest['action'], epoch: number, purpose: string, deadline: number,
    register?: ModbusRtuRegister, raw?: number): ModbusRtuApprovalRequest {
    return Object.freeze({ action, ...ownedScope, portId: portSpec.id, baudRate: portSpec.baudRate, parity: portSpec.parity,
      dataBits: portSpec.dataBits, stopBits: portSpec.stopBits, profileId: selectedProfile.id, profileRevision: selectedProfile.revision,
      generation: epoch, unitId: selectedProfile.unitId, purpose, deadline,
      ...(register ? { resourceId: register.id, address: register.address } : {}), ...(raw !== undefined ? { rawValue: raw } : {}) }) as ModbusRtuApprovalRequest;
  }
  function approved(request: ModbusRtuApprovalRequest): Approved | undefined {
    let answer: unknown; try { answer = authorize(request); } catch { return; }
    const grant = fields(answer, ['request', 'signal', 'expiresAt']);
    const now = performance.now();
    if (!grant || grant.request !== request || !signal(grant.signal) || aborted(grant.signal) ||
      typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now ||
      grant.expiresAt > now + MODBUS_RTU_LIMITS.sessionMs) return;
    return { signal: grant.signal, expiresAt: grant.expiresAt };
  }
  function current(a: Active): boolean { return !terminal && active === a && !a.retired && a.generation === generation &&
    !aborted(owner) && !aborted(a.approval.signal) && performance.now() < a.approval.expiresAt; }
  function transactionCurrent(a: Active, t: Transaction): boolean { return current(a) && a.transaction === t &&
    !aborted(t.caller) && !aborted(t.approval.signal) && performance.now() < t.deadline; }
  function settle(a: Active): Promise<void> {
    if (a.closePromise) return a.closePromise;
    // Publish the shared settlement before a port.close callout can reenter Stop.
    const closing = Promise.resolve().then(async () => {
      let port = a.port;
      if (!port && a.openPromise) { try { port = await a.openPromise; } catch { /* no acquired port */ } }
      if (port) {
        // Close and the real write callback are independent settlements. A
        // confirmed close alone cannot release an issued raw write slot.
        const closure = Promise.resolve().then(() => port!.close());
        const [closed] = await Promise.allSettled([closure, a.writePromise ?? Promise.resolve()]);
        if (closed.status === 'rejected') throw closed.reason;
      } else if (a.writePromise) await a.writePromise.catch(() => {});
      a.rawWritePending = false;
      if (active === a) active = undefined;
    });
    a.closePromise = closing;
    void closing.catch(() => { if (a.closePromise === closing) a.closePromise = undefined; });
    return closing;
  }
  function retire(a: Active, reason: ModbusRtuFailure): void {
    if (a.retired) return;
    a.retired = true; a.openAbort.abort(); if (a.timer) clearTimeout(a.timer);
    for (const detach of a.detach.splice(0)) detach();
    a.transaction?.finish(failed(reason, a.transaction.issued && a.transaction.fn === 6));
    a.finishStart(failed(reason)); void settle(a).catch(() => {});
  }
  function receive(a: Active, item: Readonly<{ byte: number; at: number }>): void {
    if (!current(a) || !a.ready || !a.transaction) { retire(a, 'protocol'); return; }
    const t = a.transaction;
    if (!integer(item.byte, 0, 255) || typeof item.at !== 'number' || !Number.isFinite(item.at) ||
      item.at > performance.now() + timing.characterMs ||
      (t.lastByteAt !== undefined && (item.at < t.lastByteAt || item.at - t.lastByteAt > timing.betweenMs))) {
      retire(a, 'protocol'); return;
    }
    receivedBytes++;
    if (receivedBytes > MODBUS_RTU_LIMITS.totalBytes || t.bytes.length >= MODBUS_RTU_LIMITS.frameBytes) { retire(a, 'quota'); return; }
    t.bytes.push(item.byte); t.lastByteAt = item.at; a.lastByteAt = item.at;
    if (t.bytes.length === 2) {
      if (t.bytes[0] !== selectedProfile.unitId) { retire(a, 'protocol'); return; }
      const code = t.bytes[1];
      if (code === (t.fn | 0x80)) t.expected = 5;
      else if (code === t.fn) t.expected = t.fn === 3 ? 7 : 8;
      else { retire(a, 'protocol'); return; }
    }
    if (!t.expected || t.bytes.length < t.expected) return;
    if (t.bytes.length !== t.expected) { retire(a, 'protocol'); return; }
    // A JS timer proves elapsed delivery time, not physical frame completion.
    // The trusted serial adapter must certify ordered delivery of every byte
    // through the physical t3.5 boundary before this prefix can become an ACK.
    const boundary = item.at + timing.silenceMs;
    void Promise.resolve().then(() => {
      if (!transactionCurrent(a, t)) return undefined;
      return a.port!.watermark(boundary);
    }).then(through => {
      if (through === undefined) return;
      if (!Number.isFinite(through) || through < boundary) { retire(a, 'protocol'); return; }
      if (transactionCurrent(a, t)) completeResponse(a, t);
    }, () => retire(a, 'lost')).catch(() => retire(a, 'lost'));
  }
  function completeResponse(a: Active, t: Transaction): void {
    if (!transactionCurrent(a, t)) { retire(a, 'cancelled'); return; }
    const response = Uint8Array.from(t.bytes), actual = crc(response.subarray(0, response.length - 2));
    if (response[response.length - 2] !== (actual & 255) || response[response.length - 1] !== (actual >>> 8)) { retire(a, 'protocol'); return; }
    if (!transactionCurrent(a, t)) { retire(a, 'cancelled'); return; }
    if (response[1] === (t.fn | 0x80)) {
      if (![1, 2, 3, 4, 5, 6, 8, 10, 11].includes(response[2]!)) { retire(a, 'protocol'); return; }
      retire(a, 'exception'); return;
    }
    let raw: number;
    if (t.fn === 3) {
      if (response[2] !== 2) { retire(a, 'protocol'); return; }
      raw = (response[3]! << 8) | response[4]!;
    } else {
      if (((response[2]! << 8) | response[3]!) !== t.register.address ||
        ((response[4]! << 8) | response[5]!) !== t.raw) { retire(a, 'protocol'); return; }
      raw = t.raw!;
    }
    t.finish(success({ raw, sequence: operations, receivedAt: performance.now(), active: a,
      approval: t.approval, caller: t.caller, deadline: t.deadline }));
  }
  async function consume(a: Active, port: ModbusRtuSerialPort): Promise<void> {
    try { for await (const item of port.bytes) receive(a, item); retire(a, 'lost'); }
    catch { retire(a, 'lost'); }
  }
  function start(raw: Readonly<{ purpose: string; deadline: number }>): Promise<ModbusRtuResult<ModbusRtuEpoch>> {
    const request = fields(raw, ['purpose', 'deadline']);
    if (!request || !id(request.purpose) || !validDeadline(request.deadline, MODBUS_RTU_LIMITS.sessionMs)) return Promise.resolve(failed('invalid'));
    if (terminal || aborted(owner)) return Promise.resolve(failed('closed'));
    if (admitting || active) return Promise.resolve(failed('busy'));
    if (attempts >= MODBUS_RTU_LIMITS.attempts) return Promise.resolve(failed('quota'));
    attempts++; admitting = true; const epoch = ++generation;
    const authority = approved(approvalRequest('connect', epoch, request.purpose, request.deadline));
    admitting = false;
    if (!authority) return Promise.resolve(failed('denied'));
    if (terminal || generation !== epoch || aborted(owner) || aborted(authority.signal) ||
      performance.now() >= Math.min(authority.expiresAt, request.deadline)) return Promise.resolve(failed('cancelled'));
    let finishStart!: (result: ModbusRtuResult<ModbusRtuEpoch>) => void;
    const result = new Promise<ModbusRtuResult<ModbusRtuEpoch>>(resolve => { finishStart = resolve; });
    const a: Active = { generation: epoch, handle: Object.freeze({}), approval: authority, openAbort: new AbortController(),
      retired: false, ready: false, detach: [], rawWritePending: false, finishStart };
    active = a; handles.set(a.handle, a);
    const expiresAt = Math.min(authority.expiresAt, request.deadline, performance.now() + MODBUS_RTU_LIMITS.operationMs);
    a.timer = setTimeout(() => retire(a, 'timeout'), Math.max(0, expiresAt - performance.now()));
    a.detach.push(watch(authority.signal, () => retire(a, 'cancelled')));
    a.openPromise = Promise.resolve().then(() => {
      if (!current(a)) throw new Error('opening cancelled');
      return openPort(portSpec, a.openAbort.signal);
    });
    void a.openPromise.then(port => {
      a.port = port;
      if (!port || port.identity !== portSpec.id || !port.bytes || typeof port.bytes[Symbol.asyncIterator] !== 'function' ||
        typeof port.write !== 'function' || typeof port.watermark !== 'function' ||
        typeof port.close !== 'function') { retire(a, 'denied'); return; }
      if (!current(a) || performance.now() >= expiresAt) { retire(a, 'cancelled'); return; }
      a.ready = true; if (a.timer) clearTimeout(a.timer);
      void consume(a, port); a.finishStart(success(a.handle));
    }, () => retire(a, 'lost')).catch(() => retire(a, 'lost'));
    return result;
  }
  async function transact(epoch: ModbusRtuEpoch, resourceId: string, fn: 3 | 6, rawValue: number | undefined,
    rawRequest: Readonly<{ purpose: string; signal: AbortSignal; deadline: number }>): Promise<ModbusRtuResult<Reply>> {
    const request = fields(rawRequest, ['purpose', 'signal', 'deadline']);
    if (!request || !id(request.purpose) || !signal(request.signal) || !id(resourceId) ||
      !validDeadline(request.deadline, MODBUS_RTU_LIMITS.operationMs)) return failed('invalid');
    const register = registers.get(resourceId), a = epoch && typeof epoch === 'object' ? handles.get(epoch) : undefined;
    if (!register || register.access !== (fn === 3 ? 'read' : 'write') || !a || !current(a) || !a.ready) return failed('denied');
    if (aborted(request.signal)) return failed('cancelled');
    if (a.transaction || admitting || a.rawWritePending) return failed('busy');
    if (operations >= MODBUS_RTU_LIMITS.operations) return failed('quota');
    admitting = true;
    let authority: Approved | undefined;
    try { authority = approved(approvalRequest(fn === 3 ? 'read' : 'write', a.generation, request.purpose, request.deadline,
      register, rawValue)); } finally { admitting = false; }
    if (!authority) return failed('denied');
    if (!current(a) || aborted(request.signal) || aborted(authority.signal) ||
      performance.now() >= Math.min(authority.expiresAt, request.deadline)) return failed('cancelled');
    const caller = request.signal, deadline = Math.min(request.deadline, authority.expiresAt, performance.now() + MODBUS_RTU_LIMITS.operationMs);
    operations++;
    return await new Promise<ModbusRtuResult<Reply>>(resolve => {
      const disposers: (() => void)[] = [];
      const timer = setTimeout(() => retire(a, 'timeout'), Math.max(0, deadline - performance.now()));
      const transaction: Transaction = { fn, register, raw: rawValue, approval: authority!, caller, deadline,
        issued: false, bytes: [], current: () => transactionCurrent(a, transaction),
        finish(value) { if (a.transaction !== transaction) return; a.transaction = undefined;
          clearTimeout(timer);
          for (const dispose of disposers) dispose(); resolve(value); } };
      a.transaction = transaction;
      disposers.push(watch(caller, () => retire(a, 'cancelled')), watch(authority!.signal, () => retire(a, 'cancelled')));
      const body = Uint8Array.from([selectedProfile.unitId, fn, register.address >>> 8, register.address & 255,
        (fn === 3 ? 1 : rawValue!) >>> 8, (fn === 3 ? 1 : rawValue!) & 255]);
      const requestFrame = frame(body);
      void (async () => {
        const silence = a.lastByteAt === undefined ? 0 : timing.silenceMs - (performance.now() - a.lastByteAt);
        if (silence > 0) await new Promise(done => setTimeout(done, silence));
        if (!transaction.current()) { retire(a, 'cancelled'); return; }
        // Reserve raw work before the port callout, so Stop can join it even
        // when write() synchronously reenters through the host adapter.
        a.rawWritePending = true;
        const issuedWrite = Promise.resolve().then(() => {
          if (!transaction.current()) return;
          transaction.issued = true;
          return a.port!.write(requestFrame);
        });
        a.writePromise = issuedWrite;
        void issuedWrite.then(() => { a.rawWritePending = false; }, () => {
          a.rawWritePending = false; retire(a, 'lost');
        });
      })();
    });
  }
  function replyCurrent(reply: Reply): boolean { return current(reply.active) && !aborted(reply.caller) &&
    !aborted(reply.approval.signal) && performance.now() < reply.deadline; }
  async function stop(): Promise<void> { generation++; const a = active; if (a) { retire(a, 'cancelled'); await settle(a); } }
  const removeOwner = watch(owner, () => { terminal = true; void stop().catch(() => {}); });
  return Object.freeze({ start,
    async read(epoch: ModbusRtuEpoch, resourceId: string, request: Readonly<{ purpose: string; signal: AbortSignal; deadline: number }>) {
      const result = await transact(epoch, resourceId, 3, undefined, request); if (!result.ok) return result;
      if (!replyCurrent(result.value)) return failed('cancelled');
      const register = registers.get(resourceId)!;
      return success(Object.freeze({ value: result.value.raw * register.scale + register.offset, rawValue: result.value.raw,
        unit: register.unit, sequence: result.value.sequence, receivedAt: result.value.receivedAt,
        receiptClockId, quality: 'valid' as const }));
    },
    async write(epoch: ModbusRtuEpoch, resourceId: string, value: number,
      request: Readonly<{ purpose: string; signal: AbortSignal; deadline: number }>) {
      const register = registers.get(resourceId); if (!register || typeof value !== 'number' || !Number.isFinite(value)) return failed('invalid');
      const raw = (value - register.offset) / register.scale;
      if (!integer(raw, 0, 65535) || raw * register.scale + register.offset !== value) return failed('invalid');
      const result = await transact(epoch, resourceId, 6, raw, request);
      return result.ok ? replyCurrent(result.value) ? success(Object.freeze({ evidence: 'target-acknowledged' as const })) :
        failed('cancelled', true) : result;
    }, stop,
    async close() { terminal = true; removeOwner(); await stop(); },
    status() { return Object.freeze({ phase: terminal ? 'closed' as const : active ? active.retired ? 'retiring' as const :
      active.ready ? 'ready' as const : 'opening' as const : 'idle' as const,
      attempts, operations, nativePorts: active?.port ? 1 : 0, pendingTransactions: active?.transaction ? 1 : 0,
      rawPending: active?.rawWritePending ? 1 : 0, receivedBytes }); },
  });
}
