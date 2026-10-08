/** A selected IPP/1.1 Print-Job gateway for an explicitly approved loopback
 * software printer. It never discovers printers, follows job-uri, or claims a
 * sheet was printed. The host owns document references and every authority. */
import { createHash } from 'node:crypto';
import { request as httpRequest, type ClientRequest } from 'node:http';

export const IPP_JOB_LIMITS = Object.freeze({ attempts: 8, submissions: 4, operations: 8,
  documentBytes: 65536, responseBytes: 65536, attributesBytes: 4096, operationMs: 5000, sessionMs: 60000 });
export type IppFailure = 'invalid' | 'denied' | 'expired' | 'closed' | 'busy' | 'quota' | 'cancelled' | 'transport' | 'protocol' | 'server';
export type IppResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: IppFailure; issued?: true; uncertain?: true }>;
export interface IppEpoch { readonly ippEpoch?: never }
export interface IppPrinter { readonly id: string; readonly uri: string; readonly format: 'application/pdf' }
export interface IppScope { readonly principalId: string; readonly applicationId: string; readonly sessionId: string }
export interface IppApprovalRequest { readonly action: 'printer-connect' | 'submit' | 'status' | 'cancel';
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string;
  readonly printerId: string; readonly printerUri: string; readonly format: 'application/pdf';
  readonly generation: number; readonly purpose: string; readonly deadline: number;
  readonly localJobId?: string; readonly documentReference?: string; readonly sha256?: string;
  readonly byteLength?: number; readonly remoteJobId?: number }
export interface IppGrant { readonly request: IppApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface IppOptions { readonly ownerSignal: AbortSignal; readonly scope: IppScope; readonly selectedPrinter: IppPrinter;
  readonly authorizePrinter: (request: IppApprovalRequest) => IppGrant | undefined;
  readonly authorizeJob: (request: IppApprovalRequest) => IppGrant | undefined;
  readonly readDocument: (reference: string, signal: AbortSignal) => Promise<Uint8Array> }
export interface IppOperation { readonly purpose: string; readonly signal: AbortSignal; readonly deadline: number }
export interface IppSubmission extends IppOperation { readonly localJobId: string; readonly documentReference: string;
  readonly sha256: string; readonly byteLength: number }
export interface IppGateway {
  start(request: Readonly<{ purpose: string; deadline: number }>): Promise<IppResult<IppEpoch>>;
  submit(epoch: IppEpoch, request: IppSubmission): Promise<IppResult<Readonly<{ remoteJobId: number; serverState: number; evidence: 'target-acknowledged' }>>>;
  status(epoch: IppEpoch, localJobId: string, request: IppOperation): Promise<IppResult<Readonly<{ serverState: number; serverReasons: readonly string[] }>>>;
  cancel(epoch: IppEpoch, localJobId: string, request: IppOperation): Promise<IppResult<Readonly<{ cancelRequestAccepted: true }>>>;
  stop(): Promise<void>; close(): Promise<void>;
  statusLocal(): Readonly<{ phase: 'idle' | 'opening' | 'ready' | 'retiring' | 'closed'; attempts: number;
    operations: number; submissions: number; jobs: number; uncertainJobs: number; rawPending: number }>;
}

const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const aborted = (s: AbortSignal) => Reflect.apply(abortGetter, s, []) as boolean;
function genuineSignal(v: unknown): v is AbortSignal { try { aborted(v as AbortSignal); return true; } catch { return false; } }
function own(v: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return;
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== 'string' || !keys.includes(key)) return;
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return;
      out[key] = descriptor.value;
    }
    return keys.every(key => Object.hasOwn(out, key)) ? out : undefined;
  } catch { return; }
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(v);
const deadlineValid = (v: unknown, limit: number): v is number => typeof v === 'number' && Number.isFinite(v) &&
  v > performance.now() && v <= performance.now() + limit;
const fail = <T = never>(reason: IppFailure, issued = false): IppResult<T> => Object.freeze({ ok: false, reason,
  ...(issued ? { issued: true as const, uncertain: true as const } : {}) });
const pass = <T>(value: T): IppResult<T> => Object.freeze({ ok: true, value });
const text = (value: string) => Buffer.from(value, 'utf8');
const u16 = (value: number) => Buffer.from([value >>> 8, value & 255]);
const u32 = (value: number) => Buffer.from([value >>> 24, value >>> 16, value >>> 8, value]);
type Attribute = Readonly<{ tag: number; name: string; value: Buffer }>;
function attr(tag: number, name: string, value: string | number | boolean): Attribute {
  return { tag, name, value: typeof value === 'string' ? text(value) : typeof value === 'boolean' ? Buffer.from([value ? 1 : 0]) : u32(value) };
}
function packet(code: number, requestId: number, groups: readonly Readonly<{ tag: number; attrs: readonly Attribute[] }>[], document?: Uint8Array): Buffer {
  const parts: Buffer[] = [Buffer.from([1, 1]), u16(code), u32(requestId)];
  for (const group of groups) {
    parts.push(Buffer.from([group.tag]));
    for (const item of group.attrs) {
      const name = text(item.name);
      if (name.length > 255 || item.value.length > 65535) throw new Error('attribute too long');
      parts.push(Buffer.from([item.tag]), u16(name.length), name, u16(item.value.length), item.value);
    }
  }
  parts.push(Buffer.from([3]));
  const prefix = Buffer.concat(parts);
  if (prefix.length > IPP_JOB_LIMITS.attributesBytes) throw new Error('attributes too long');
  return document ? Buffer.concat([prefix, Buffer.from(document)]) : prefix;
}
const operationAttrs = (uri: string): Attribute[] => [attr(0x47, 'attributes-charset', 'utf-8'),
  attr(0x48, 'attributes-natural-language', 'en'), attr(0x45, 'printer-uri', uri)];
interface Parsed { status: number; groups: Map<number, Map<string, Attribute[]>> }
function parseResponse(bytes: Buffer, requestId: number): Parsed {
  if (bytes.length < 9 || bytes.length > IPP_JOB_LIMITS.attributesBytes ||
    bytes[0] !== 1 || bytes[1] !== 1 || bytes.readUInt32BE(4) !== requestId) throw new Error('IPP header');
  const status = bytes.readUInt16BE(2), groups = new Map<number, Map<string, Attribute[]>>();
  const groupRank = new Map([[1, 0], [5, 1], [2, 2], [4, 3]]);
  let cursor = 8, group = 0, rank = -1, previous = '';
  while (cursor < bytes.length) {
    const tag = bytes[cursor++]!;
    if (tag === 3) {
      if (cursor !== bytes.length) throw new Error('IPP trailing bytes');
      if (!groups.has(1)) throw new Error('IPP operation group');
      return { status, groups };
    }
    if (tag >= 1 && tag <= 5) {
      const nextRank = groupRank.get(tag);
      if (nextRank === undefined || nextRank <= rank || groups.has(tag) || (rank < 0 && tag !== 1))
        throw new Error('IPP group order');
      group = tag; rank = nextRank; groups.set(tag, new Map()); previous = ''; continue;
    }
    if (!group || tag < 0x10 || cursor + 2 > bytes.length) throw new Error('IPP tag');
    const nameLength = bytes.readUInt16BE(cursor); cursor += 2;
    if (cursor + nameLength + 2 > bytes.length) throw new Error('IPP name length');
    const name = nameLength ? bytes.subarray(cursor, cursor + nameLength).toString('utf8') : previous;
    cursor += nameLength;
    const valueLength = bytes.readUInt16BE(cursor); cursor += 2;
    if (!name || !/^[a-z][a-z0-9-]{0,79}$/.test(name) || cursor + valueLength > bytes.length) throw new Error('IPP value length');
    const value = bytes.subarray(cursor, cursor + valueLength); cursor += valueLength;
    const attributes = groups.get(group)!;
    if (nameLength && attributes.has(name)) throw new Error('duplicate IPP attribute');
    const values = attributes.get(name) ?? []; values.push({ tag, name, value }); attributes.set(name, values); previous = name;
  }
  throw new Error('IPP missing end tag');
}
function one(parsed: Parsed, group: number, name: string, tag: number, length?: number): Buffer {
  const values = parsed.groups.get(group)?.get(name);
  if (!values || values.length !== 1 || values[0]!.tag !== tag || (length !== undefined && values[0]!.value.length !== length))
    throw new Error(`IPP ${name}`);
  return values[0]!.value;
}
function positive(value: Buffer): number { const n = value.readInt32BE(0); if (n <= 0) throw new Error('IPP job-id'); return n; }
const states = new Set([3, 4, 5, 6, 7, 8, 9]);
function state(value: Buffer): number { const n = value.readInt32BE(0); if (!states.has(n)) throw new Error('IPP job-state'); return n; }
function language(parsed: Parsed): void {
  if (one(parsed, 1, 'attributes-charset', 0x47).toString() !== 'utf-8' ||
    one(parsed, 1, 'attributes-natural-language', 0x48).toString() !== 'en') throw new Error('IPP language');
}
interface Raw { promise: Promise<Buffer>; abort(): void; issued: boolean; cancelled: boolean }
interface Job { remoteId: number; documentReference: string; sha256: string; byteLength: number }
interface Active { generation: number; handle: IppEpoch; grant: Readonly<{ signal: AbortSignal; expiresAt: number }>;
  ready: boolean; retired: boolean; admitting: boolean; stopAbort: AbortController;
  raw?: Raw; readPromise?: Promise<Uint8Array>; closePromise?: Promise<void>;
  detachGrant?: () => void; jobs: Map<string, Job>;
  operations: number; submissions: number; requestId: number }

export function createIppJobGateway(input: IppOptions): IppGateway {
  const options = own(input, ['ownerSignal', 'scope', 'selectedPrinter', 'authorizePrinter', 'authorizeJob', 'readDocument']);
  const scope = own(options?.scope, ['principalId', 'applicationId', 'sessionId']);
  const printer = own(options?.selectedPrinter, ['id', 'uri', 'format']);
  const match = typeof printer?.uri === 'string' ? /^ipp:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(\/ipp\/print)$/.exec(printer.uri) : null;
  if (!options || !genuineSignal(options.ownerSignal) || !scope || !Object.values(scope).every(id) ||
    !printer || !id(printer.id) || printer.format !== 'application/pdf' || !match || Number(match[1]) > 65535 ||
    typeof options.authorizePrinter !== 'function' || typeof options.authorizeJob !== 'function' ||
    typeof options.readDocument !== 'function') throw new TypeError('Invalid selected IPP printer');
  const owner = options.ownerSignal, authorizePrinter = options.authorizePrinter as IppOptions['authorizePrinter'];
  const authorizeJob = options.authorizeJob as IppOptions['authorizeJob'];
  const readDocument = options.readDocument as IppOptions['readDocument'];
  const selected = Object.freeze({ ...printer }) as unknown as IppPrinter;
  const ownedScope = Object.freeze({ ...scope }) as unknown as IppScope;
  const port = Number(match[1]), path = match[2]!;
  const handles = new WeakMap<object, Active>();
  // Gateway-lifetime replay fence for this exact selected printer and scope.
  // It is intentionally not a cross-process ledger. An unknown remote job ID
  // cannot be polled or cancelled automatically; an operator must reconcile it.
  const attemptedJobIds = new Map<string, 'unknown' | 'accepted'>();
  let terminal = aborted(owner), generation = 0, attempts = 0, opening = false;
  let active: Active | undefined;
  function authority(action: IppApprovalRequest['action'], purpose: string, deadline: number, aGeneration: number,
    job?: Readonly<{ localJobId: string; documentReference: string; sha256: string; byteLength: number; remoteJobId?: number }>) {
    const request = Object.freeze({ action, ...ownedScope, printerId: selected.id, printerUri: selected.uri,
      format: selected.format, generation: aGeneration, purpose, deadline, ...(job ?? {}) }) as IppApprovalRequest;
    let response: unknown;
    try { response = (action === 'printer-connect' ? authorizePrinter : authorizeJob)(request); } catch { return; }
    const grant = own(response, ['request', 'signal', 'expiresAt']);
    const now = performance.now();
    if (!grant || grant.request !== request || !genuineSignal(grant.signal) || aborted(grant.signal) ||
      typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now ||
      grant.expiresAt > now + IPP_JOB_LIMITS.sessionMs) return;
    return Object.freeze({ signal: grant.signal, expiresAt: grant.expiresAt });
  }
  function current(a: Active): boolean { return !terminal && active === a && !a.retired && a.generation === generation &&
    !aborted(owner) && !aborted(a.grant.signal) && performance.now() < a.grant.expiresAt; }
  function joint(a: Active, jobSignal: AbortSignal, caller: AbortSignal, deadline: number) {
    const controller = new AbortController(), sources = [owner, a.grant.signal, jobSignal, caller, a.stopAbort.signal];
    const expiresAt = Math.min(deadline, a.grant.expiresAt);
    const revoke = () => controller.abort();
    for (const source of sources) {
      if (aborted(source)) revoke();
      else Reflect.apply(EventTarget.prototype.addEventListener, source, ['abort', revoke, { once: true }]);
    }
    const timer = setTimeout(revoke, Math.max(0, expiresAt - performance.now()));
    if (performance.now() >= expiresAt) revoke();
    return { signal: controller.signal, dispose() { clearTimeout(timer);
      for (const source of sources) Reflect.apply(EventTarget.prototype.removeEventListener, source, ['abort', revoke]); } };
  }
  function stopActive(a: Active): Promise<void> {
    if (a.closePromise) return a.closePromise;
    a.retired = true; generation++;
    a.detachGrant?.();
    const closing = Promise.resolve().then(async () => {
      await Promise.allSettled([a.raw?.promise, a.readPromise].filter(Boolean) as Promise<unknown>[]);
      if (active === a) active = undefined;
    });
    a.closePromise = closing;
    a.stopAbort.abort();
    a.raw?.abort();
    return closing;
  }
  function perform(body: Buffer, raw: Raw, deadline: number, canIssue: () => boolean): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined, socketClosed = false, ended = false, result: Buffer | undefined, fault: Error | undefined;
      const chunks: Buffer[] = []; let size = 0;
      const finish = () => { if (!socketClosed) return; if (fault) reject(fault); else if (ended && result) resolve(result);
        else reject(new Error('IPP response incomplete')); };
      const abort = raw.abort;
      raw.abort = () => { abort(); request?.destroy(new Error('IPP request cancelled')); };
      const timer = setTimeout(() => raw.abort(), Math.max(0, deadline - performance.now()));
      try {
        request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', agent: false, maxHeaderSize: 4096,
          headers: { 'content-type': 'application/ipp', 'content-length': body.length, connection: 'close' } }, response => {
          if (response.statusCode !== 200 || String(response.headers['content-type']).toLowerCase().split(';')[0]!.trim() !== 'application/ipp')
            fault = new Error('IPP HTTP response');
          response.on('data', (chunk: Buffer) => { size += chunk.length;
            if (size > IPP_JOB_LIMITS.responseBytes) { fault = new Error('IPP response too large'); raw.abort(); }
            else chunks.push(chunk); });
          response.once('end', () => { ended = true; result = Buffer.concat(chunks); finish(); });
          response.once('error', error => { fault = error; raw.abort(); });
        });
        request.once('socket', socket => { socket.once('close', () => { socketClosed = true; clearTimeout(timer); finish(); }); });
        request.once('close', () => { if (!socketClosed && !request?.socket) {
          socketClosed = true; clearTimeout(timer); finish(); } });
        request.once('error', error => { fault = error;
          if (!socketClosed) request?.destroy();
          finish(); });
        if (raw.cancelled || !canIssue() || performance.now() >= deadline) { raw.abort(); return; }
        raw.issued = true;
        request.end(body);
      } catch (reason) {
        fault = reason instanceof Error ? reason : new Error('IPP native request failed', { cause: reason });
        if (!request) { clearTimeout(timer); reject(fault); return; }
        try { request.destroy(fault); }
        catch { request.socket?.destroy(); }
        // An acquired socket settles only through its close event, including
        // when request.end throws synchronously after the native callout.
      }
    });
  }
  async function exchange(a: Active, body: Buffer, deadline: number, caller?: AbortSignal): Promise<Readonly<{ parsed: Parsed; issued: boolean }>> {
    if (a.raw) throw new Error('raw busy');
    const raw: Raw = { issued: false, cancelled: false, abort() { raw.cancelled = true; },
      promise: undefined as unknown as Promise<Buffer> };
    const onAbort = () => raw.abort();
    if (caller) Reflect.apply(EventTarget.prototype.addEventListener, caller, ['abort', onAbort, { once: true }]);
    Reflect.apply(EventTarget.prototype.addEventListener, a.grant.signal, ['abort', onAbort, { once: true }]);
    raw.promise = Promise.resolve().then(() => {
      if (raw.cancelled || !current(a) || (caller && aborted(caller)) || performance.now() >= deadline) throw new Error('IPP request expired');
      return perform(body, raw, deadline, () => current(a) && !raw.cancelled && (!caller || !aborted(caller)));
    });
    a.raw = raw;
    try {
      const response = await raw.promise;
      let parsed: Parsed;
      try { parsed = parseResponse(response, a.requestId); }
      catch (reason) { const error = new Error('IPP response malformed', { cause: reason }) as Error & { kind: string };
        error.kind = 'protocol'; throw error; }
      return { parsed, issued: raw.issued };
    } catch (reason) {
      const error = new Error('IPP exchange failed', { cause: reason }) as Error & { issued: boolean; kind: string };
      error.issued = raw.issued;
      error.kind = (reason as { kind?: string })?.kind === 'protocol' ? 'protocol' : 'transport';
      throw error;
    } finally {
      if (a.raw === raw) a.raw = undefined;
      if (caller) Reflect.apply(EventTarget.prototype.removeEventListener, caller, ['abort', onAbort]);
      Reflect.apply(EventTarget.prototype.removeEventListener, a.grant.signal, ['abort', onAbort]);
    }
  }
  async function start(requestInput: Readonly<{ purpose: string; deadline: number }>): Promise<IppResult<IppEpoch>> {
    const request = own(requestInput, ['purpose', 'deadline']);
    if (!request || !id(request.purpose) || !deadlineValid(request.deadline, IPP_JOB_LIMITS.sessionMs)) return fail('invalid');
    if (terminal || aborted(owner)) return fail('closed');
    if (opening || active) return fail('busy');
    if (attempts >= IPP_JOB_LIMITS.attempts) return fail('quota');
    opening = true; attempts++; const epoch = ++generation;
    const grant = authority('printer-connect', request.purpose, request.deadline as number, epoch);
    opening = false;
    if (!grant) return fail('denied');
    if (terminal || generation !== epoch || aborted(owner) || aborted(grant.signal) ||
      performance.now() >= Math.min(grant.expiresAt, request.deadline as number)) return fail('cancelled');
    const a: Active = { generation: epoch, handle: Object.freeze({}), grant, ready: false, retired: false, admitting: false,
      stopAbort: new AbortController(), jobs: new Map(), operations: 1, submissions: 0, requestId: 0 };
    active = a; handles.set(a.handle, a);
    const onGrantAbort = () => { void stopActive(a).catch(() => {}); };
    Reflect.apply(EventTarget.prototype.addEventListener, grant.signal, ['abort', onGrantAbort, { once: true }]);
    a.detachGrant = () => Reflect.apply(EventTarget.prototype.removeEventListener, grant.signal, ['abort', onGrantAbort]);
    try {
      const requestId = ++a.requestId;
      const body = packet(0x000b, requestId, [{ tag: 1, attrs: operationAttrs(selected.uri) }]);
      const { parsed } = await exchange(a, body, Math.min(grant.expiresAt, request.deadline as number,
        performance.now() + IPP_JOB_LIMITS.operationMs), a.stopAbort.signal);
      if (!current(a) || performance.now() >= (request.deadline as number)) return fail('cancelled');
      language(parsed);
      if (parsed.status !== 0 || one(parsed, 4, 'printer-is-accepting-jobs', 0x22, 1)[0] !== 1 ||
        !parsed.groups.get(4)?.get('document-format-supported')?.some(value => value.tag === 0x49 && value.value.toString() === selected.format))
        throw new Error('printer capability');
      a.ready = true; return pass(a.handle);
    } catch (reason) { await stopActive(a);
      return fail((reason as { kind?: string })?.kind === 'transport' ? 'transport' : 'protocol'); }
  }
  function operation(a: Active, action: 'submit' | 'status' | 'cancel', request: IppOperation,
    job: Readonly<{ localJobId: string; documentReference: string; sha256: string; byteLength: number; remoteJobId?: number }>) {
    if (!current(a) || !a.ready) return { failure: fail('denied') };
    if (a.raw || a.readPromise || a.admitting) return { failure: fail('busy') };
    if (a.operations >= IPP_JOB_LIMITS.operations || (action === 'submit' && a.submissions >= IPP_JOB_LIMITS.submissions))
      return { failure: fail('quota') };
    a.admitting = true;
    let grant: ReturnType<typeof authority>;
    try { grant = authority(action, request.purpose, request.deadline, a.generation, job); }
    finally { a.admitting = false; }
    if (!grant) return { failure: fail('denied') };
    if (!current(a) || aborted(request.signal) || aborted(grant.signal) ||
      performance.now() >= Math.min(request.deadline, grant.expiresAt)) return { failure: fail('cancelled') };
    a.operations++; if (action === 'submit') a.submissions++;
    return { grant };
  }
  async function submit(epoch: IppEpoch, input: IppSubmission): Promise<IppResult<Readonly<{ remoteJobId: number; serverState: number; evidence: 'target-acknowledged' }>>> {
    const request = own(input, ['purpose', 'signal', 'deadline', 'localJobId', 'documentReference', 'sha256', 'byteLength']);
    if (!request || !id(request.purpose) || !genuineSignal(request.signal) || aborted(request.signal) ||
      !deadlineValid(request.deadline, IPP_JOB_LIMITS.operationMs) || !id(request.localJobId) || !id(request.documentReference) ||
      typeof request.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.sha256) ||
      !Number.isSafeInteger(request.byteLength) || (request.byteLength as number) < 8 ||
      (request.byteLength as number) > IPP_JOB_LIMITS.documentBytes) return fail('invalid');
    const a = epoch && typeof epoch === 'object' ? handles.get(epoch) : undefined;
    if (!a || attemptedJobIds.has(request.localJobId as string)) return fail('denied');
    const job = { localJobId: request.localJobId as string, documentReference: request.documentReference as string,
      sha256: request.sha256 as string, byteLength: request.byteLength as number };
    const approval = operation(a, 'submit', request as unknown as IppOperation, job);
    if ('failure' in approval) return approval.failure!;
    const grant = approval.grant!;
    const deadline = Math.min(request.deadline as number, grant.expiresAt);
    const lease = joint(a, grant.signal, request.signal as AbortSignal, deadline);
    let issued = false;
    try {
      const reading = Promise.resolve().then(() => {
        if (!current(a) || aborted(lease.signal) || performance.now() >= deadline)
          throw new Error('document read cancelled');
        return readDocument(job.documentReference, lease.signal);
      });
      a.readPromise = reading;
      const value = await reading;
      if (a.readPromise === reading) a.readPromise = undefined;
      if (!current(a) || aborted(lease.signal) || performance.now() >= deadline)
        return fail('cancelled');
      if (!(value instanceof Uint8Array) || value.byteLength !== job.byteLength) return fail('invalid');
      const document = Uint8Array.from(value);
      if (!Buffer.from(document.subarray(0, 5)).equals(Buffer.from('%PDF-')) ||
        createHash('sha256').update(document).digest('hex') !== job.sha256) return fail('invalid');
      // A failed or lost response cannot license another Print-Job with this
      // local identity. Keep the reservation even when the remote ID is unknown.
      attemptedJobIds.set(job.localJobId, 'unknown');
      const requestId = ++a.requestId;
      const body = packet(0x0002, requestId, [
        { tag: 1, attrs: [...operationAttrs(selected.uri), attr(0x49, 'document-format', selected.format)] },
        { tag: 2, attrs: [attr(0x21, 'copies', 1)] },
      ], document);
      const response = await exchange(a, body, deadline, lease.signal);
      issued = response.issued;
      if (!current(a) || aborted(lease.signal) || performance.now() >= deadline)
        return fail('cancelled', issued);
      language(response.parsed);
      if (response.parsed.status !== 0) return fail('server', issued);
      const remoteId = positive(one(response.parsed, 2, 'job-id', 0x21, 4));
      const serverState = state(one(response.parsed, 2, 'job-state', 0x23, 4));
      const returnedUri = one(response.parsed, 2, 'job-uri', 0x45);
      if (!returnedUri.length || returnedUri.length > 256) return fail('protocol', issued);
      const reasons = response.parsed.groups.get(2)?.get('job-state-reasons') ?? [];
      if (!reasons.length || reasons.length > 8 || reasons.some(value => value.tag !== 0x44 || value.value.length > 64))
        return fail('protocol', issued);
      if (a.jobs.size >= IPP_JOB_LIMITS.submissions || a.jobs.has(job.localJobId)) return fail('protocol', issued);
      a.jobs.set(job.localJobId, { remoteId, documentReference: job.documentReference, sha256: job.sha256, byteLength: job.byteLength });
      attemptedJobIds.set(job.localJobId, 'accepted');
      return pass(Object.freeze({ remoteJobId: remoteId, serverState, evidence: 'target-acknowledged' as const }));
    } catch (reason) { issued ||= Boolean((reason as { issued?: boolean })?.issued);
      if (!issued && attemptedJobIds.get(job.localJobId) === 'unknown') attemptedJobIds.delete(job.localJobId);
      if (!current(a) || aborted(lease.signal)) return fail('cancelled', issued);
      if (performance.now() >= deadline) return fail('expired', issued);
      return fail((reason as { kind?: string })?.kind === 'transport' ? 'transport' : 'protocol', issued); }
    finally { lease.dispose(); if (a.readPromise) a.readPromise = undefined; }
  }
  function jobOperation(action: 'status', epoch: IppEpoch, localJobId: string, input: IppOperation): Promise<IppResult<Readonly<{ serverState: number; serverReasons: readonly string[] }>>>;
  function jobOperation(action: 'cancel', epoch: IppEpoch, localJobId: string, input: IppOperation): Promise<IppResult<Readonly<{ cancelRequestAccepted: true }>>>;
  async function jobOperation(action: 'status' | 'cancel', epoch: IppEpoch, localJobId: string, input: IppOperation): Promise<IppResult<Readonly<{ serverState: number; serverReasons: readonly string[] }> | Readonly<{ cancelRequestAccepted: true }>>> {
    const request = own(input, ['purpose', 'signal', 'deadline']);
    if (!request || !id(request.purpose) || !genuineSignal(request.signal) || aborted(request.signal) ||
      !deadlineValid(request.deadline, IPP_JOB_LIMITS.operationMs) || !id(localJobId)) return fail('invalid');
    const a = epoch && typeof epoch === 'object' ? handles.get(epoch) : undefined;
    const stored = a?.jobs.get(localJobId);
    if (!a || !stored) return fail('denied');
    const job = { localJobId, documentReference: stored.documentReference, sha256: stored.sha256,
      byteLength: stored.byteLength, remoteJobId: stored.remoteId };
    const approval = operation(a, action, request as unknown as IppOperation, job);
    if ('failure' in approval) return approval.failure!;
    const grant = approval.grant!, deadline = Math.min(request.deadline as number, grant.expiresAt);
    const lease = joint(a, grant.signal, request.signal as AbortSignal, deadline);
    let issued = false;
    try {
      const requestId = ++a.requestId;
      const body = packet(action === 'status' ? 0x0009 : 0x0008, requestId,
        [{ tag: 1, attrs: [...operationAttrs(selected.uri), attr(0x21, 'job-id', stored.remoteId)] }]);
      const response = await exchange(a, body, deadline, lease.signal);
      issued = response.issued;
      if (!current(a) || aborted(lease.signal) || performance.now() >= deadline)
        return fail('cancelled', issued);
      language(response.parsed);
      if (response.parsed.status !== 0) return fail('server', issued);
      // RFC 8011 §4.3.3.2 defines a successful Cancel-Job response with
      // Operation attributes and optional Unsupported attributes only. The
      // target was already bound by the approved printer-uri + stored job-id
      // request, echoed request-id, current grant, and original deadline.
      if (action === 'cancel') return pass(Object.freeze({ cancelRequestAccepted: true as const }));
      if (positive(one(response.parsed, 2, 'job-id', 0x21, 4)) !== stored.remoteId) return fail('protocol', issued);
      const serverState = state(one(response.parsed, 2, 'job-state', 0x23, 4));
      const reasons = response.parsed.groups.get(2)?.get('job-state-reasons') ?? [];
      if (reasons.length > 8 || reasons.some(value => value.tag !== 0x44 || value.value.length > 64)) return fail('protocol', issued);
      return pass(Object.freeze({ serverState, serverReasons: Object.freeze(reasons.map(value => value.value.toString('utf8'))) }));
    } catch (reason) { issued ||= Boolean((reason as { issued?: boolean })?.issued);
      if (!current(a) || aborted(lease.signal)) return fail('cancelled', issued);
      if (performance.now() >= deadline) return fail('expired', issued);
      return fail((reason as { kind?: string })?.kind === 'transport' ? 'transport' : 'protocol', issued); }
    finally { lease.dispose(); }
  }
  async function stop(): Promise<void> { generation++; const a = active; if (a) await stopActive(a); }
  const onOwnerAbort = () => { terminal = true; void stop().catch(() => {}); };
  Reflect.apply(EventTarget.prototype.addEventListener, owner, ['abort', onOwnerAbort, { once: true }]);
  return Object.freeze({ start, submit,
    status: (epoch: IppEpoch, localJobId: string, request: IppOperation) => jobOperation('status', epoch, localJobId, request),
    cancel: (epoch: IppEpoch, localJobId: string, request: IppOperation) => jobOperation('cancel', epoch, localJobId, request),
    stop, async close() { terminal = true;
      Reflect.apply(EventTarget.prototype.removeEventListener, owner, ['abort', onOwnerAbort]);
      await stop(); },
    statusLocal() { const a = active; return Object.freeze({ phase: terminal ? 'closed' as const : a ? a.retired ? 'retiring' as const :
      a.ready ? 'ready' as const : 'opening' as const : 'idle' as const,
    attempts, operations: a?.operations ?? 0, submissions: a?.submissions ?? 0, jobs: a?.jobs.size ?? 0,
    uncertainJobs: [...attemptedJobIds.values()].filter(value => value === 'unknown').length,
    rawPending: a?.raw ? 1 : 0 }); },
  });
}
