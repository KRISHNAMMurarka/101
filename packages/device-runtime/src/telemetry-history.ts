import { parseSignalValue, parseValueSchema, snapshotJson } from '@101/device-model';
import type { ValueSchema } from '@101/device-model';
import type { TelemetryStorage } from './telemetry-storage.ts';

export type TelemetryQuality = 'observed' | 'unverified' | 'valid' | 'stale' | 'unavailable';
export type TelemetryProvenanceField = 'calibrationRevision' | 'processorPin' | 'unitConversion';
export interface TelemetryProvenance {
  readonly calibrationRevision?: number;
  readonly processorPin?: string;
  readonly unitConversion?: Readonly<{ sourceUnit: string; targetUnit: string; decimalPlaces: number; maxAbsoluteError: number }>;
}
export interface TelemetryScope {
  readonly action: 'capture' | 'upload'; readonly ownerId: string; readonly resourceId: string;
  readonly schemaVersion: number; readonly fields: readonly string[];
  readonly provenanceFields: readonly TelemetryProvenanceField[];
  readonly destinationId: string; readonly purpose: string; readonly expiresAt: number;
}
export interface TelemetryGrant { readonly scope: TelemetryScope; readonly expiresAt: number }
export type TelemetryAuthorization = (scope: Readonly<TelemetryScope>) => TelemetryGrant | undefined;
export interface TelemetryUploadRequest {
  readonly resourceId: string; readonly schemaVersion: number; readonly fields: readonly string[];
  readonly provenanceFields: readonly TelemetryProvenanceField[]; readonly destinationId: string;
  readonly purpose: string; readonly expiresAt: number;
}
export interface TelemetryCaptureRequest extends TelemetryUploadRequest { readonly schema: ValueSchema; readonly destinationId: 'local-history' }
export interface TelemetryEntry {
  readonly sourceTime: Readonly<{ clockId: string; at: number }>; readonly quality: TelemetryQuality;
  readonly values: Readonly<Record<string, number | boolean | string>>; readonly provenance?: TelemetryProvenance;
}
export interface TelemetryRecord extends TelemetryEntry {
  readonly id: number; readonly resourceId: string; readonly schemaVersion: number;
  readonly ingestedAt: number; readonly expiresAt: number;
}
export interface TelemetryUploadBatch { readonly batchId: string; readonly records: readonly TelemetryRecord[] }
export interface TelemetryUploadAck { readonly batchId: string; readonly recordIds: readonly number[] }
export type TelemetryUploader = (batch: Readonly<TelemetryUploadBatch>, context: Readonly<{ signal: AbortSignal }>) => Promise<TelemetryUploadAck>;
declare const captureBrand: unique symbol, uploadBrand: unique symbol;
export interface TelemetryCaptureHandle { readonly [captureBrand]: true }
export interface TelemetryUploadHandle { readonly [uploadBrand]: true }
export type TelemetryFailureReason = 'closed' | 'invalid-clock' | 'invalid-request' | 'denied' | 'invalid-handle' |
  'expired' | 'invalid-entry' | 'backpressure' | 'storage-unavailable' | 'storage-invalid' | 'epoch-changed' |
  'upload-busy' | 'upload-failed' | 'upload-timeout' | 'upload-exhausted' | 'invalid-ack' | 'cancelled';
type Failure = Readonly<{ ok: false; reason: TelemetryFailureReason }>;
type Success<T extends object = object> = Readonly<{ ok: true } & T>;
export interface TelemetryLimits {
  retentionMs?: number; maxBytes?: number; maxRows?: number;
  uploadTimeoutMs?: number; maxRetries?: number; retryBaseMs?: number;
}
export interface TelemetryHistoryOptions {
  ownerId: string; storage: TelemetryStorage; trustedNow: () => number; authorize: TelemetryAuthorization; limits?: TelemetryLimits;
}
export interface TelemetryHistory {
  requestCapture(request: TelemetryCaptureRequest): Promise<Success<{ handle: TelemetryCaptureHandle }> | Failure>;
  requestUpload(request: TelemetryUploadRequest, uploader: TelemetryUploader): Promise<Success<{ handle: TelemetryUploadHandle }> | Failure>;
  enqueue(handle: unknown, entry: TelemetryEntry): Success | Failure;
  flush(): Promise<Success<{ committed: number }> | Failure>;
  revoke(handle: unknown): void;
  pumpUpload(handle: unknown): Promise<Success<{ status: 'idle' | 'sent' | 'backoff'; sent: number }> | Failure>;
  exportPage(options?: { resourceId?: string; limit?: number; afterId?: number }): Promise<Success<{ records: readonly TelemetryRecord[]; nextAfterId?: number }> | Failure>;
  delete(resourceId?: string): Promise<Success<{ removed: number }> | Failure>;
  sweep(): Promise<Success<{ removed: number }> | Failure>;
  status(): Readonly<{ closed: boolean; clockFault: boolean; captureHandles: number; uploadHandles: number;
    pending: number; pendingBytes: number; uploadInFlight: boolean; admitted: number; dropped: number;
    committed: number; evicted: number; expired: number; uploaded: number; retries: number; storageFailures: number }>;
  close(): void;
}

type RecordSchema = Extract<ValueSchema, { type: 'record' }>;
type StoredRecord = TelemetryRecord & Readonly<{ schema: RecordSchema }>;
interface OwnerState { version: 1; ownerId: string; epoch: string; nextId: number; lastNow: number; bytes: number; rows: StoredRecord[] }
interface Capture { scope: TelemetryScope; schema: RecordSchema; epoch: string; active: boolean }
interface Upload { scope: TelemetryScope; epoch: string; active: boolean; uploader: TelemetryUploader;
  acknowledged: Set<number>; batch?: TelemetryUploadBatch; attempts: number; retryAt: number; controller?: AbortController }
interface Pending { capture: Capture; record: Omit<StoredRecord, 'id'>; bytes: number }
const DAY = 86400000, MAX_ROWS = 256, MAX_BYTES = 1048576, MAX_RECORD = 4096;
const PROVENANCE: readonly TelemetryProvenanceField[] = ['calibrationRevision', 'processorPin', 'unitConversion'];
const QUALITY: readonly TelemetryQuality[] = ['observed', 'unverified', 'valid', 'stale', 'unavailable'];
const encoder = new TextEncoder();
const fail = (reason: TelemetryFailureReason): Failure => Object.freeze({ ok: false, reason });
function invalid(): never { throw new Error('storage-invalid'); }
function plain(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== Object.keys(descriptors).length || Object.values(descriptors).some(value => !Object.hasOwn(value, 'value'))) invalid();
  return input as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function token(input: unknown, max = 128): string {
  if (typeof input !== 'string' || input.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)) invalid();
  return input;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function names(value: unknown, provenance = false): readonly string[] {
  if (!Array.isArray(value) || value.length > 16 || (!provenance && value.length === 0)) invalid();
  const list = value.map(item => token(item, 64));
  if (new Set(list).size !== list.length || list.some(item => ['__proto__', 'constructor', 'prototype'].includes(item)) ||
      provenance && list.some(item => !PROVENANCE.includes(item as TelemetryProvenanceField))) invalid();
  return Object.freeze(list);
}
function bytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).byteLength; }
function selectedSchema(input: unknown, fields: readonly string[]): RecordSchema {
  const parsed = parseValueSchema(input);
  if (parsed.type !== 'record' || parsed.optional?.length || Object.keys(parsed.fields).length !== fields.length ||
      fields.some(key => !Object.hasOwn(parsed.fields, key)) ||
      Object.values(parsed.fields).some(value => !['scalar', 'boolean', 'enum'].includes(value.type))) invalid();
  for (const value of Object.values(parsed.fields)) {
    if (value.type === 'enum' && (value.values.length > 16 || value.values.some(item => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(item)))) invalid();
  }
  if (bytes(parsed) > 2048) invalid();
  return parsed;
}
function provenance(input: unknown, fields: readonly string[]): TelemetryProvenance {
  const value = plain(snapshotJson(input)); closed(value, [], fields);
  if (value.calibrationRevision !== undefined) integer(value.calibrationRevision, 1, 2147483647);
  if (value.processorPin !== undefined && (typeof value.processorPin !== 'string' || !/^[0-9a-f]{64}$/.test(value.processorPin))) invalid();
  if (value.unitConversion !== undefined) {
    const conversion = plain(value.unitConversion); closed(conversion, ['sourceUnit', 'targetUnit', 'decimalPlaces', 'maxAbsoluteError']);
    for (const unit of [conversion.sourceUnit, conversion.targetUnit])
      if (typeof unit !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9./%{}_-]{0,31}$/.test(unit)) invalid();
    integer(conversion.decimalPlaces, 0, 12);
    if (typeof conversion.maxAbsoluteError !== 'number' || !Number.isFinite(conversion.maxAbsoluteError) || conversion.maxAbsoluteError < 0) invalid();
  }
  return value as TelemetryProvenance;
}
function parseEntry(input: unknown, schema: RecordSchema, provenanceFields: readonly string[]): TelemetryEntry {
  const value = plain(snapshotJson(input)); closed(value, ['sourceTime', 'quality', 'values'], ['provenance']);
  const source = plain(value.sourceTime); closed(source, ['clockId', 'at']); token(source.clockId);
  if (typeof source.at !== 'number' || !Number.isFinite(source.at) || source.at < 0 || source.at > Number.MAX_SAFE_INTEGER ||
      !QUALITY.includes(value.quality as TelemetryQuality)) invalid();
  const values = parseSignalValue(value.values, schema) as TelemetryEntry['values'];
  return Object.freeze({ sourceTime: Object.freeze({ clockId: source.clockId as string, at: source.at }),
    quality: value.quality as TelemetryQuality, values,
    ...(value.provenance === undefined ? {} : { provenance: provenance(value.provenance, provenanceFields) }) });
}
function parseState(input: unknown, ownerId: string, now: number): OwnerState {
  if (input === undefined) return { version: 1, ownerId, epoch: crypto.randomUUID(), nextId: 1, lastNow: now, bytes: 0, rows: [] };
  const value = plain(input); closed(value, ['version', 'ownerId', 'epoch', 'nextId', 'lastNow', 'bytes', 'rows']);
  if (value.version !== 1 || value.ownerId !== ownerId || typeof value.epoch !== 'string' || !/^[0-9a-f-]{36}$/.test(value.epoch)) invalid();
  const nextId = integer(value.nextId, 1, Number.MAX_SAFE_INTEGER), lastNow = integer(value.lastNow, 0, Number.MAX_SAFE_INTEGER);
  if (lastNow > now) throw new Error('invalid-clock');
  if (!Array.isArray(value.rows) || value.rows.length > MAX_ROWS) invalid();
  let previousId = 0;
  const rows = value.rows.map(input => {
    const row = plain(snapshotJson(input));
    closed(row, ['id', 'resourceId', 'schemaVersion', 'ingestedAt', 'expiresAt', 'schema', 'sourceTime', 'quality', 'values'], ['provenance']);
    const id = integer(row.id, previousId + 1, nextId - 1); previousId = id; token(row.resourceId);
    integer(row.schemaVersion, 1, 2147483647);
    const ingestedAt = integer(row.ingestedAt, 0, lastNow), expiresAt = integer(row.expiresAt, ingestedAt + 1, Math.min(Number.MAX_SAFE_INTEGER, ingestedAt + 7 * DAY));
    const schema = selectedSchema(row.schema, Object.keys(plain(row.values)));
    const entry = parseEntry({ sourceTime: row.sourceTime, quality: row.quality, values: row.values,
      ...(row.provenance === undefined ? {} : { provenance: row.provenance }) }, schema, PROVENANCE);
    const record = Object.freeze({ id, resourceId: row.resourceId as string, schemaVersion: row.schemaVersion as number,
      ingestedAt, expiresAt, schema, ...entry });
    if (bytes(record) > MAX_RECORD) invalid(); return record;
  });
  const size = rows.reduce((sum, row) => sum + bytes(row), 0);
  if (integer(value.bytes, 0, MAX_BYTES) !== size) invalid();
  return { version: 1, ownerId, epoch: value.epoch, nextId, lastNow, bytes: size, rows };
}
function exposed(row: StoredRecord, fields: readonly string[] = Object.keys(row.values), provenanceFields: readonly string[] = PROVENANCE): TelemetryRecord {
  const selected = Object.fromEntries(fields.map(field => {
    const value = row.values[field]; if (value === undefined) invalid();
    return [field, value];
  }));
  const details = row.provenance ? Object.fromEntries(provenanceFields.filter(field => Object.hasOwn(row.provenance!, field))
    .map(field => [field, row.provenance![field as TelemetryProvenanceField]])) : {};
  return Object.freeze({ id: row.id, resourceId: row.resourceId, schemaVersion: row.schemaVersion,
    ingestedAt: row.ingestedAt, expiresAt: row.expiresAt, sourceTime: row.sourceTime, quality: row.quality,
    values: Object.freeze(selected), ...(Object.keys(details).length ? { provenance: Object.freeze(details) } : {}) });
}

/**
 * Opt-in bounded local history. Calls never start recording or uploading implicitly.
 * Trusted ingest time controls retention; producer clock values are kept unchanged.
 * Expired rows are purged on the next execution, including after a dormant restart.
 */
export function createTelemetryHistory(options: TelemetryHistoryOptions): TelemetryHistory {
  const ownerId = token(options.ownerId);
  if (typeof options.storage?.transact !== 'function' || typeof options.trustedNow !== 'function' || typeof options.authorize !== 'function') invalid();
  const configured = plain(snapshotJson(options.limits ?? {}));
  closed(configured, [], ['retentionMs', 'maxBytes', 'maxRows', 'uploadTimeoutMs', 'maxRetries', 'retryBaseMs']);
  const retentionMs = integer(configured.retentionMs ?? DAY, 1, 7 * DAY), maxBytes = integer(configured.maxBytes ?? MAX_BYTES, MAX_RECORD, MAX_BYTES);
  const maxRows = integer(configured.maxRows ?? MAX_ROWS, 1, MAX_ROWS), uploadTimeoutMs = integer(configured.uploadTimeoutMs ?? 5000, 10, 30000);
  const maxRetries = integer(configured.maxRetries ?? 3, 0, 5), retryBaseMs = integer(configured.retryBaseMs ?? 1000, 10, 30000);
  const captures = new WeakMap<object, Capture>(), uploads = new WeakMap<object, Upload>();
  const captureSet = new Set<Capture>(), uploadSet = new Set<Upload>();
  let pending: Pending[] = [], closedHistory = false, clockFault = false, lastNow = -1, uploadInFlight = false;
  let captureReservations = 0, uploadReservations = 0;
  let authorityGeneration = 0;
  let flushing: Promise<Success<{ committed: number }> | Failure> | undefined;
  const counters = { admitted: 0, dropped: 0, committed: 0, evicted: 0, expired: 0, uploaded: 0, retries: 0, storageFailures: 0 };
  function dropAuthority() {
    authorityGeneration++;
    for (const capture of captureSet) capture.active = false;
    for (const upload of uploadSet) { upload.active = false; upload.controller?.abort(); upload.batch = undefined; }
    captureSet.clear(); uploadSet.clear(); pending = [];
  }
  function now(): number {
    if (closedHistory) throw new Error('closed');
    if (clockFault) throw new Error('invalid-clock');
    let value: unknown;
    try { value = options.trustedNow(); } catch { value = undefined; }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value < lastNow || value > Number.MAX_SAFE_INTEGER - 7 * DAY) {
      clockFault = true; dropAuthority(); throw new Error('invalid-clock');
    }
    lastNow = value;
    for (const capture of captureSet) active(capture, value);
    for (const upload of uploadSet) active(upload, value);
    return value;
  }
  function reason(error: unknown): Failure {
    const code = error instanceof Error ? error.message : '';
    if (code === 'invalid-clock') { clockFault = true; dropAuthority(); return fail('invalid-clock'); }
    if (code === 'closed') return fail('closed');
    if (code === 'storage-invalid') dropAuthority();
    counters.storageFailures++; return fail(code === 'storage-invalid' ? 'storage-invalid' : 'storage-unavailable');
  }
  function maintain(state: OwnerState, time: number) {
    const before = state.rows.length; state.rows = state.rows.filter(row => row.expiresAt > time);
    counters.expired += before - state.rows.length;
    state.bytes = state.rows.reduce((sum, row) => sum + bytes(row), 0);
    while (state.rows.length > maxRows || state.bytes > maxBytes) {
      state.bytes -= bytes(state.rows.shift()!); counters.evicted++;
    }
    state.lastNow = time;
  }
  async function transaction<T>(time: number, operation: (state: OwnerState) => T): Promise<T> {
    return options.storage.transact(ownerId, raw => {
      if (closedHistory) throw new Error('closed');
      const current = now();
      const state = parseState(raw, ownerId, current); maintain(state, Math.max(time, current));
      const result = operation(state); return { state, result };
    });
  }
  function scope(request: unknown, action: 'capture' | 'upload', time: number): { scope: TelemetryScope; schema?: RecordSchema } {
    const value = plain(snapshotJson(request));
    closed(value, ['resourceId', 'schemaVersion', 'fields', 'provenanceFields', 'destinationId', 'purpose', 'expiresAt'], action === 'capture' ? ['schema'] : []);
    const fields = names(value.fields), provenanceFields = names(value.provenanceFields, true) as readonly TelemetryProvenanceField[];
    const expiresAt = integer(value.expiresAt, time + 1, Math.min(time + 7 * DAY, Number.MAX_SAFE_INTEGER));
    if (action === 'capture' && value.destinationId !== 'local-history' || action === 'upload' && value.destinationId === 'local-history') invalid();
    const result: TelemetryScope = Object.freeze({ action, ownerId, resourceId: token(value.resourceId),
      schemaVersion: integer(value.schemaVersion, 1, 2147483647), fields, provenanceFields,
      destinationId: token(value.destinationId), purpose: token(value.purpose, 64), expiresAt });
    return { scope: result, ...(action === 'capture' ? { schema: selectedSchema(value.schema, fields) } : {}) };
  }
  function authorize(request: TelemetryScope, time: number): TelemetryScope | undefined {
    try {
      const grant = plain(snapshotJson(options.authorize(request))); closed(grant, ['scope', 'expiresAt']);
      const granted = plain(grant.scope); closed(granted, Object.keys(request));
      if (Object.keys(request).some(key => JSON.stringify(granted[key]) !== JSON.stringify(request[key as keyof TelemetryScope]))) return;
      const expiresAt = integer(grant.expiresAt, time + 1, request.expiresAt);
      return Object.freeze({ ...request, expiresAt });
    } catch { return; }
  }
  function active(authority: Capture | Upload, time: number): boolean {
    if (!authority.active || authority.scope.expiresAt <= time) {
      authority.active = false;
      if ('schema' in authority) { captureSet.delete(authority); pending = pending.filter(item => item.capture !== authority); }
      else { uploadSet.delete(authority); authority.controller?.abort(); authority.batch = undefined; }
      return false;
    }
    return true;
  }
  function captureFor(handle: unknown): Capture | undefined { return handle && typeof handle === 'object' ? captures.get(handle) : undefined; }
  function uploadFor(handle: unknown): Upload | undefined { return handle && typeof handle === 'object' ? uploads.get(handle) : undefined; }
  const history: TelemetryHistory = {
    async requestCapture(request) {
      let time: number; try { time = now(); } catch (error) { return reason(error); }
      let parsed: ReturnType<typeof scope>;
      try { parsed = scope(request, 'capture', time); } catch { return fail('invalid-request'); }
      if (captureSet.size + captureReservations >= 16) return fail('backpressure');
      captureReservations++;
      const generation = authorityGeneration;
      try {
        const allowed = authorize(parsed.scope, time); if (!allowed) return fail('denied');
        const epoch = await transaction(time, state => state.epoch);
        if (generation !== authorityGeneration) return fail('cancelled');
        if (closedHistory || !parsed.schema || allowed.expiresAt <= now()) return fail('expired');
        const capture: Capture = { scope: allowed, schema: parsed.schema, epoch, active: true };
        const handle = Object.freeze(Object.create(null)) as TelemetryCaptureHandle;
        captures.set(handle, capture); captureSet.add(capture); return Object.freeze({ ok: true, handle });
      } catch (error) { return reason(error); }
      finally { captureReservations--; }
    },
    async requestUpload(request, uploader) {
      let time: number; try { time = now(); } catch (error) { return reason(error); }
      let parsed: ReturnType<typeof scope>;
      try { parsed = scope(request, 'upload', time); if (typeof uploader !== 'function') invalid(); } catch { return fail('invalid-request'); }
      if (uploadSet.size + uploadReservations >= 16) return fail('backpressure');
      uploadReservations++;
      const generation = authorityGeneration;
      try {
        const allowed = authorize(parsed.scope, time); if (!allowed) return fail('denied');
        const epoch = await transaction(time, state => state.epoch);
        if (generation !== authorityGeneration) return fail('cancelled');
        if (closedHistory || allowed.expiresAt <= now()) return fail('expired');
        const upload: Upload = { scope: allowed, epoch, active: true, uploader, acknowledged: new Set(), attempts: 0, retryAt: 0 };
        const handle = Object.freeze(Object.create(null)) as TelemetryUploadHandle;
        uploads.set(handle, upload); uploadSet.add(upload); return Object.freeze({ ok: true, handle });
      } catch (error) { return reason(error); }
      finally { uploadReservations--; }
    },
    enqueue(handle, input) {
      let time: number; try { time = now(); } catch (error) { counters.dropped++; return reason(error); }
      const capture = captureFor(handle);
      if (!capture || !active(capture, time)) { counters.dropped++; return fail(capture ? 'expired' : 'invalid-handle'); }
      try {
        const entry = parseEntry(input, capture.schema, capture.scope.provenanceFields);
        const record = Object.freeze({ resourceId: capture.scope.resourceId, schemaVersion: capture.scope.schemaVersion,
          schema: capture.schema, ingestedAt: time, expiresAt: Math.min(time + retentionMs, capture.scope.expiresAt), ...entry });
        const size = bytes({ id: Number.MAX_SAFE_INTEGER, ...record });
        if (size > MAX_RECORD) { counters.dropped++; return fail('invalid-entry'); }
        if (pending.length >= 16 || pending.reduce((sum, item) => sum + item.bytes, 0) + size > 65536) {
          counters.dropped++; return fail('backpressure');
        }
        pending.push({ capture, record, bytes: size }); counters.admitted++; return Object.freeze({ ok: true });
      } catch { counters.dropped++; return fail('invalid-entry'); }
    },
    flush() {
      if (flushing) return flushing;
      const run = async (): Promise<Success<{ committed: number }> | Failure> => {
        let time: number; try { time = now(); } catch (error) { return reason(error); }
        if (!pending.length) return Object.freeze({ ok: true, committed: 0 });
        const batch: Pending[] = []; let size = 0;
        for (const item of pending) { if (batch.length === 16 || size + item.bytes > 32768) break; batch.push(item); size += item.bytes; }
        try {
          const result = await transaction(time, state => {
            const current = now();
            const live = batch.filter(item => active(item.capture, current) && item.record.expiresAt > current);
            if (live.some(item => item.capture.epoch !== state.epoch)) return fail('epoch-changed');
            for (const item of live) {
              if (state.nextId === Number.MAX_SAFE_INTEGER) invalid();
              const row = Object.freeze({ id: state.nextId++, ...item.record });
              state.rows.push(row); state.bytes += bytes(row);
            }
            maintain(state, current); return Object.freeze({ ok: true as const, committed: live.length });
          });
          pending = pending.filter(item => !batch.includes(item));
          if (result.ok) counters.committed += result.committed;
          else { counters.dropped += batch.length; dropAuthority(); }
          return result;
        } catch (error) { return reason(error); }
      };
      flushing = run().finally(() => { flushing = undefined; }); return flushing;
    },
    revoke(handle) {
      const capture = captureFor(handle), upload = uploadFor(handle);
      if (capture) { capture.active = false; captureSet.delete(capture); pending = pending.filter(item => item.capture !== capture); }
      if (upload) { upload.active = false; uploadSet.delete(upload); upload.controller?.abort(); upload.batch = undefined; }
    },
    async pumpUpload(handle) {
      let time: number; try { time = now(); } catch (error) { return reason(error); }
      const upload = uploadFor(handle);
      if (!upload || !active(upload, time)) return fail(upload ? 'expired' : 'invalid-handle');
      if (uploadInFlight) return fail('upload-busy');
      if (upload.retryAt > time) return Object.freeze({ ok: true, status: 'backoff', sent: 0 });
      if (upload.attempts > maxRetries) { history.revoke(handle); return fail('upload-exhausted'); }
      uploadInFlight = true; const controller = new AbortController(); upload.controller = controller;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const batch = await transaction(time, state => {
          if (state.epoch !== upload.epoch) return undefined;
          upload.acknowledged = new Set([...upload.acknowledged].filter(id => state.rows.some(row => row.id === id)));
          if (upload.batch) {
            if (upload.batch.records.some(row => !state.rows.some(current => current.id === row.id))) return undefined;
            return upload.batch;
          }
          const records: TelemetryRecord[] = []; let size = 0;
          for (const row of state.rows) {
            if (row.resourceId !== upload.scope.resourceId || row.schemaVersion !== upload.scope.schemaVersion ||
                upload.acknowledged.has(row.id) || upload.scope.fields.some(field => !Object.hasOwn(row.values, field))) continue;
            const record = exposed(row, upload.scope.fields, upload.scope.provenanceFields), length = bytes(record);
            if (records.length === 16 || size + length > 32768) break; records.push(record); size += length;
          }
          return Object.freeze({ batchId: crypto.randomUUID(), records: Object.freeze(records) });
        });
        if (!active(upload, now()) || controller.signal.aborted) return fail('cancelled');
        if (!batch) { history.revoke(handle); return fail('epoch-changed'); }
        if (!batch.records.length) return Object.freeze({ ok: true, status: 'idle', sent: 0 });
        upload.batch = batch;
        const outcome = await new Promise<{ ack?: unknown; failure?: TelemetryFailureReason }>(resolve => {
          let settled = false;
          function finish(value: { ack?: unknown; failure?: TelemetryFailureReason }) {
            if (settled) return; settled = true; controller.signal.removeEventListener('abort', cancelled); clearTimeout(timer); resolve(value);
          }
          function cancelled() { finish({ failure: 'cancelled' }); }
          controller.signal.addEventListener('abort', cancelled, { once: true });
          timer = setTimeout(() => { finish({ failure: 'upload-timeout' }); controller.abort(); }, Math.min(uploadTimeoutMs, Math.max(1, upload.scope.expiresAt - now())));
          Promise.resolve().then(() => {
            if (controller.signal.aborted || !active(upload, now())) throw new Error('cancelled');
            return upload.uploader(batch, Object.freeze({ signal: controller.signal }));
          })
            .then(ack => finish({ ack }), () => finish({ failure: 'upload-failed' }));
        });
        if (!active(upload, now())) return fail('cancelled');
        let failure = outcome.failure;
        if (!failure) {
          try {
            const ack = plain(snapshotJson(outcome.ack)); closed(ack, ['batchId', 'recordIds']);
            if (ack.batchId !== batch.batchId || !Array.isArray(ack.recordIds) || ack.recordIds.length !== batch.records.length ||
                ack.recordIds.some((id, index) => id !== batch.records[index]?.id)) invalid();
          } catch { failure = 'invalid-ack'; }
        }
        if (failure) {
          upload.attempts++; counters.retries++;
          upload.retryAt = now() + Math.min(30000, retryBaseMs * 2 ** (upload.attempts - 1));
          return fail(failure);
        }
        const committed = await transaction(now(), state => {
          if (state.epoch !== upload.epoch || !active(upload, now()) || controller.signal.aborted ||
              batch.records.some(row => !state.rows.some(current => current.id === row.id))) return false;
          for (const row of batch.records) upload.acknowledged.add(row.id); return true;
        });
        if (!committed) { history.revoke(handle); return fail('epoch-changed'); }
        upload.batch = undefined; upload.attempts = 0; upload.retryAt = 0; counters.uploaded += batch.records.length;
        return Object.freeze({ ok: true, status: 'sent', sent: batch.records.length });
      } catch (error) { return reason(error); }
      finally { clearTimeout(timer); upload.controller = undefined; uploadInFlight = false; }
    },
    async exportPage(input = {}) {
      let time: number; try { time = now(); } catch (error) { return reason(error); }
      let limit: number, afterId: number, resourceId: string | undefined;
      try {
        const value = plain(snapshotJson(input)); closed(value, [], ['limit', 'afterId', 'resourceId']);
        limit = integer(value.limit ?? 64, 1, 64); afterId = integer(value.afterId ?? 0, 0, Number.MAX_SAFE_INTEGER);
        resourceId = value.resourceId === undefined ? undefined : token(value.resourceId);
      } catch { return fail('invalid-request'); }
      try { return await transaction(time, state => {
        const matches = state.rows.filter(row => row.id > afterId && (!resourceId || row.resourceId === resourceId));
        const records = matches.slice(0, limit).map(row => exposed(row));
        return Object.freeze({ ok: true as const, records: Object.freeze(records),
          ...(matches.length > limit ? { nextAfterId: records.at(-1)!.id } : {}) });
      }); } catch (error) { return reason(error); }
    },
    async delete(resourceId) {
      try { now(); } catch (error) { return reason(error); }
      try { if (resourceId !== undefined) token(resourceId); } catch { return fail('invalid-request'); }
      dropAuthority();
      try { return await options.storage.transact(ownerId, raw => {
        if (closedHistory) throw new Error('closed');
        const current = now(); let state: OwnerState;
        // Only explicit whole-owner deletion may recover an unreadable envelope.
        if (resourceId === undefined) {
          let removed = 0;
          try { removed = parseState(raw, ownerId, current).rows.length; } catch { /* Nothing unreadable is exported. */ }
          state = { version: 1, ownerId, epoch: crypto.randomUUID(), nextId: 1, lastNow: current, bytes: 0, rows: [] };
          return { state, result: Object.freeze({ ok: true as const, removed }) };
        }
        state = parseState(raw, ownerId, current); maintain(state, current);
        const before = state.rows.length; state.rows = state.rows.filter(row => row.resourceId !== resourceId);
        state.bytes = state.rows.reduce((sum, row) => sum + bytes(row), 0); state.epoch = crypto.randomUUID();
        return { state, result: Object.freeze({ ok: true as const, removed: before - state.rows.length }) };
      }); } catch (error) { return reason(error); }
    },
    async sweep() {
      let time: number; try { time = now(); } catch (error) { return reason(error); }
      const before = counters.expired;
      try { return await transaction(time, () => Object.freeze({ ok: true as const, removed: counters.expired - before })); }
      catch (error) { return reason(error); }
    },
    status() { return Object.freeze({ closed: closedHistory, clockFault, captureHandles: captureSet.size, uploadHandles: uploadSet.size,
      pending: pending.length, pendingBytes: pending.reduce((sum, item) => sum + item.bytes, 0), uploadInFlight, ...counters }); },
    close() { closedHistory = true; dropAuthority(); },
  };
  return Object.freeze(history);
}
