/** A selected ONVIF Media GetSnapshotUri gateway for one explicitly approved
 * loopback software camera. It performs no discovery, redirects, PTZ, replay,
 * authentication, or firmware operations. */
import { request as httpRequest, type ClientRequest } from 'node:http';
import { createAssetReference, type AssetReference } from '@101/device-model';
import { DOMParser, type Node, type Element, type ProcessingInstruction } from '@xmldom/xmldom';

export const ONVIF_SNAPSHOT_LIMITS = Object.freeze({ attempts: 8, captures: 16, rawOperations: 1,
  soapBytes: 16384, snapshotBytes: 1048576, headerBytes: 8192, operationMs: 5000, sessionMs: 60000 });
export type OnvifSnapshotFailure = 'invalid' | 'denied' | 'expired' | 'closed' | 'busy' | 'quota' |
  'cancelled' | 'transport' | 'protocol' | 'server';
export type OnvifSnapshotResult<T> = Readonly<{ ok: true; value: T }> |
  Readonly<{ ok: false; reason: OnvifSnapshotFailure; issued?: true }>;
export interface OnvifSnapshotEpoch { readonly onvifSnapshotEpoch?: never }
export interface OnvifSnapshotScope { readonly principalId: string; readonly applicationId: string; readonly sessionId: string }
export interface SelectedOnvifCamera { readonly id: string; readonly port: number; readonly profileToken: string; readonly snapshotPath: string }
export interface OnvifSnapshotApprovalRequest {
  readonly action: 'resolve-snapshot-uri' | 'read-snapshot';
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string;
  readonly cameraId: string; readonly profileToken: string; readonly serviceUri: string; readonly snapshotUri: string;
  readonly generation: number; readonly purpose: string; readonly deadline: number; readonly maxBytes: number;
}
export interface OnvifSnapshotGrant { readonly request: OnvifSnapshotApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface OnvifSnapshotOptions {
  readonly ownerSignal: AbortSignal; readonly scope: OnvifSnapshotScope; readonly selectedCamera: SelectedOnvifCamera;
  readonly authorizeCamera: (request: OnvifSnapshotApprovalRequest) => OnvifSnapshotGrant | undefined;
  readonly authorizeMedia: (request: OnvifSnapshotApprovalRequest) => OnvifSnapshotGrant | undefined;
}
export interface OnvifSnapshotOperation { readonly purpose: string; readonly signal: AbortSignal; readonly deadline: number }
export interface OnvifSnapshot {
  readonly reference: AssetReference; readonly mediaType: 'image/jpeg'; readonly bytes: Uint8Array;
  readonly sequence: number; readonly receivedAt: number; readonly evidence: 'target-bytes-observed';
  readonly provenance: Readonly<{ provider: 'onvif-get-snapshot-uri'; profileToken: string;
    physicalSource: 'unverified'; captureTimeKnown: false }>;
}
export interface OnvifSnapshotGateway {
  start(request: Readonly<{ purpose: string; deadline: number }>): Promise<OnvifSnapshotResult<OnvifSnapshotEpoch>>;
  capture(epoch: OnvifSnapshotEpoch, request: OnvifSnapshotOperation): Promise<OnvifSnapshotResult<OnvifSnapshot>>;
  stop(): Promise<void>; close(): Promise<void>;
  status(): Readonly<{ phase: 'idle' | 'opening' | 'ready' | 'retiring' | 'closed'; attempts: number;
    captures: number; sequence: number; rawPending: number }>;
}

const SOAP = 'http://www.w3.org/2003/05/soap-envelope';
const MEDIA = 'http://www.onvif.org/ver10/media/wsdl';
const SCHEMA = 'http://www.onvif.org/ver10/schema';
const ACTION = `${MEDIA}/GetSnapshotUri`;
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const aborted = (signal: AbortSignal) => Reflect.apply(abortGetter, signal, []) as boolean;
function genuineSignal(value: unknown): value is AbortSignal { try { aborted(value as AbortSignal); return true; } catch { return false; } }
function own(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !keys.includes(key)) return;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return;
      output[key] = descriptor.value;
    }
    return keys.every(key => Object.hasOwn(output, key)) ? output : undefined;
  } catch { return; }
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const profile = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const pathValid = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 &&
  /^\/[\x21-\x7e]*$/.test(value) && !/[?#]/.test(value) && !value.includes('//') &&
  !/[\\%]/.test(value) && !value.split('/').some(segment => segment === '.' || segment === '..');
const deadlineValid = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isFinite(value) &&
  value > performance.now() && value <= performance.now() + limit;
const pass = <T>(value: T): OnvifSnapshotResult<T> => Object.freeze({ ok: true, value });
const fail = <T = never>(reason: OnvifSnapshotFailure, issued = false): OnvifSnapshotResult<T> =>
  Object.freeze({ ok: false, reason, ...(issued ? { issued: true as const } : {}) });
function escapeXml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function requestBody(token: string): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${SOAP}" xmlns:trt="${MEDIA}"><s:Body><trt:GetSnapshotUri><trt:ProfileToken>${escapeXml(token)}</trt:ProfileToken></trt:GetSnapshotUri></s:Body></s:Envelope>`, 'utf8');
}
function elementChildren(node: Node): Element[] {
  const output: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) output.push(child as Element);
    else if (child.nodeType === 3 && !/^[ \t\r\n]*$/.test(child.nodeValue ?? '')) throw new Error('unexpected text');
    else if (![3, 8].includes(child.nodeType)) throw new Error('unexpected XML node');
  }
  return output;
}
function exactly(node: Node, namespace: string, localName: string): Element {
  const matches = elementChildren(node).filter(child => child.namespaceURI === namespace && child.localName === localName);
  if (matches.length !== 1 || elementChildren(node).length !== 1 || matches[0]!.attributes.length !== 0) throw new Error(`expected ${localName}`);
  return matches[0]!;
}
function leaf(parent: Node, namespace: string, localName: string): string {
  const matches = elementChildren(parent).filter(child => child.namespaceURI === namespace && child.localName === localName);
  if (matches.length !== 1) throw new Error(`expected ${localName}`);
  const node = matches[0]!;
  if (node.attributes.length !== 0) throw new Error(`attributes on ${localName}`);
  let value = '';
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3) value += child.nodeValue ?? '';
    else if (child.nodeType !== 8) throw new Error(`nested ${localName}`);
  }
  return value;
}
const invalidXmlCharacter = /[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;
function validateXmlCharacters(source: string): void {
  if (invalidXmlCharacter.test(source)) throw new Error('invalid XML character');
  // The selected parser treats U+0080 as start-tag spacing. Preserve that legal
  // character in comments, CDATA and quoted values, but never let it disappear
  // from an unquoted tag. This linear scan does not parse or rewrite the XML.
  let index = 0;
  while ((index = source.indexOf('<', index)) !== -1) {
    const end = source.startsWith('<!--', index) ? '-->' : source.startsWith('<![CDATA[', index) ? ']]>' : undefined;
    if (end) {
      const closing = source.indexOf(end, index + 4);
      if (closing === -1) throw new Error('malformed XML');
      index = closing + end.length; continue;
    }
    let quote = '';
    for (index++; index < source.length; index++) {
      const char = source[index];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '\u0080') throw new Error('invalid XML spacing');
      else if (char === '>') { index++; break; }
    }
  }
}
function parseSnapshotUri(bytes: Buffer, expected: string): string {
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('invalid UTF-8'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('DTD forbidden');
  validateXmlCharacters(source);
  const document = new DOMParser({
    normalizeLineEndings: value => value.replace(/\r\n?/g, '\n'),
    onError(level, message) {
      // A literal U+FFFD is legal XML. Fatal UTF-8 decoding above establishes
      // that this exact parser warning cannot denote a decoder replacement.
      if (level === 'warning' && message === 'Unicode replacement character detected, source encoding issues?') return;
      throw new Error('malformed XML');
    },
  }).parseFromString(source, 'application/xml');
  if (document.doctype || !document.documentElement) throw new Error('malformed XML');
  for (let child = document.firstChild; child; child = child.nextSibling)
    if (![1, 7, 8].includes(child.nodeType) || child.nodeType === 7 && (child as ProcessingInstruction).target !== 'xml')
      throw new Error('unexpected document node');
  const envelope = document.documentElement;
  if (envelope.namespaceURI !== SOAP || envelope.localName !== 'Envelope' || envelope.attributes.length > 8) throw new Error('SOAP Envelope');
  for (let index = 0; index < envelope.attributes.length; index++) {
    const attribute = envelope.attributes.item(index);
    if (attribute?.namespaceURI !== 'http://www.w3.org/2000/xmlns/' || invalidXmlCharacter.test(attribute.value))
      throw new Error('SOAP Envelope attribute');
  }
  const body = exactly(envelope, SOAP, 'Body');
  const response = exactly(body, MEDIA, 'GetSnapshotUriResponse');
  const mediaUri = exactly(response, MEDIA, 'MediaUri');
  const values = elementChildren(mediaUri);
  if (values.length !== 4) throw new Error('MediaUri fields');
  const uri = leaf(mediaUri, SCHEMA, 'Uri');
  const invalidConnect = leaf(mediaUri, SCHEMA, 'InvalidAfterConnect');
  const invalidReboot = leaf(mediaUri, SCHEMA, 'InvalidAfterReboot');
  const timeout = leaf(mediaUri, SCHEMA, 'Timeout');
  if (uri !== expected || !['false', '0'].includes(invalidConnect) || !['false', '0'].includes(invalidReboot) || timeout !== 'PT0S')
    throw new Error('MediaUri contract');
  return uri;
}
function validateJpeg(bytes: Buffer): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9)
    throw new Error('JPEG framing');
}
interface Raw { promise: Promise<Buffer>; abort(): void; issued: boolean; cancelled: boolean; expired?: boolean }
interface Active { generation: number; handle: OnvifSnapshotEpoch; grant: Readonly<{ signal: AbortSignal; expiresAt: number }>;
  ready: boolean; retired: boolean; stopAbort: AbortController; snapshotUri: string; raw?: Raw; operation?: Promise<void>;
  closePromise?: Promise<void>; detach?: () => void }

export function createOnvifSnapshotGateway(input: OnvifSnapshotOptions): OnvifSnapshotGateway {
  const options = own(input, ['ownerSignal', 'scope', 'selectedCamera', 'authorizeCamera', 'authorizeMedia']);
  const scope = own(options?.scope, ['principalId', 'applicationId', 'sessionId']);
  const camera = own(options?.selectedCamera, ['id', 'port', 'profileToken', 'snapshotPath']);
  if (!options || !genuineSignal(options.ownerSignal) || !scope || !Object.values(scope).every(id) || !camera || !id(camera.id) ||
    !Number.isSafeInteger(camera.port) || (camera.port as number) < 1 || (camera.port as number) > 65535 ||
    !profile(camera.profileToken) || !pathValid(camera.snapshotPath) || typeof options.authorizeCamera !== 'function' ||
    typeof options.authorizeMedia !== 'function') throw new TypeError('Invalid selected ONVIF camera');
  const owner = options.ownerSignal, authorizeCamera = options.authorizeCamera as OnvifSnapshotOptions['authorizeCamera'];
  const authorizeMedia = options.authorizeMedia as OnvifSnapshotOptions['authorizeMedia'];
  const selected = Object.freeze({ ...camera }) as unknown as SelectedOnvifCamera;
  const ownedScope = Object.freeze({ ...scope }) as unknown as OnvifSnapshotScope;
  const serviceUri = `http://127.0.0.1:${selected.port}/onvif/media_service`;
  const selectedSnapshotUri = `http://127.0.0.1:${selected.port}${selected.snapshotPath}`;
  const handles = new WeakMap<object, Active>();
  let terminal = aborted(owner), generation = 0, attempts = 0, captures = 0, sequence = 0, opening = false;
  let active: Active | undefined;
  const phase = (): ReturnType<OnvifSnapshotGateway['status']>['phase'] => terminal ? 'closed' : opening ? 'opening' :
    active?.retired ? 'retiring' : active?.ready ? 'ready' : 'idle';
  function authority(action: OnvifSnapshotApprovalRequest['action'], purpose: string, deadline: number, atGeneration: number) {
    const request = Object.freeze({ action, ...ownedScope, cameraId: selected.id, profileToken: selected.profileToken,
      serviceUri, snapshotUri: selectedSnapshotUri, generation: atGeneration, purpose, deadline,
      maxBytes: action === 'read-snapshot' ? ONVIF_SNAPSHOT_LIMITS.snapshotBytes : ONVIF_SNAPSHOT_LIMITS.soapBytes }) as OnvifSnapshotApprovalRequest;
    let response: unknown;
    try { response = (action === 'resolve-snapshot-uri' ? authorizeCamera : authorizeMedia)(request); } catch { return; }
    const grant = own(response, ['request', 'signal', 'expiresAt']);
    const now = performance.now();
    if (!grant || grant.request !== request || !genuineSignal(grant.signal) || aborted(grant.signal) ||
      typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now ||
      grant.expiresAt > now + ONVIF_SNAPSHOT_LIMITS.sessionMs) return;
    return Object.freeze({ signal: grant.signal, expiresAt: grant.expiresAt });
  }
  function current(value: Active): boolean { return !terminal && active === value && !value.retired && value.generation === generation &&
    !aborted(owner) && !aborted(value.grant.signal) && performance.now() < value.grant.expiresAt; }
  function stopActive(value: Active): Promise<void> {
    if (value.closePromise) return value.closePromise;
    value.retired = true; generation++; value.detach?.(); value.stopAbort.abort(); value.raw?.abort();
    const promise = Promise.resolve().then(async () => {
      await Promise.allSettled([...(value.raw ? [value.raw.promise] : []), ...(value.operation ? [value.operation] : [])]);
      if (active === value) active = undefined;
    });
    value.closePromise = promise;
    return promise;
  }
  function perform(method: 'POST' | 'GET', path: string, body: Buffer | undefined, raw: Raw, deadline: number,
    canIssue: () => boolean, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined, socketClosed = false, ended = false, result: Buffer | undefined, fault: Error | undefined;
      const chunks: Buffer[] = []; let size = 0;
      const finish = () => { if (!socketClosed) return; if (fault) reject(fault); else if (ended && result) resolve(result);
        else reject(new Error('ONVIF response incomplete')); };
      const baseAbort = raw.abort;
      raw.abort = () => { baseAbort(); request?.destroy(new Error('ONVIF request cancelled')); };
      const timer = setTimeout(() => { raw.expired = true; raw.abort(); }, Math.max(0, Math.ceil(deadline - performance.now())));
      try {
        const headers: Record<string, string | number> = { connection: 'close' };
        if (method === 'POST') {
          headers['content-type'] = `application/soap+xml; charset=utf-8; action="${ACTION}"`;
          headers['content-length'] = body!.length;
        }
        request = httpRequest({ host: '127.0.0.1', port: selected.port, path, method, agent: false,
          maxHeaderSize: ONVIF_SNAPSHOT_LIMITS.headerBytes, headers }, response => {
          const mediaType = String(response.headers['content-type'] ?? '').toLowerCase().split(';')[0]!.trim();
          if (response.statusCode !== 200) fault = Object.assign(new Error('ONVIF server response'), { kind: 'server' });
          else if (response.headers.location || response.headers['content-encoding'] ||
            mediaType !== (method === 'POST' ? 'application/soap+xml' : 'image/jpeg'))
            fault = Object.assign(new Error('ONVIF HTTP contract'), { kind: 'protocol' });
          const declared = response.headers['content-length'];
          if (declared !== undefined && (!/^(0|[1-9][0-9]*)$/.test(String(declared)) || Number(declared) > limit))
            fault = Object.assign(new Error('ONVIF content length'), { kind: 'protocol' });
          response.on('data', (chunk: Buffer) => { size += chunk.length;
            if (size > limit) { fault = Object.assign(new Error('ONVIF response too large'), { kind: 'protocol' }); raw.abort(); }
            else chunks.push(Buffer.from(chunk)); });
          response.once('end', () => { ended = true; result = Buffer.concat(chunks);
            if (declared !== undefined && Number(declared) !== result.length)
              fault = Object.assign(new Error('ONVIF truncated response'), { kind: 'protocol' });
            finish(); });
          response.once('error', error => { fault = error; raw.abort(); });
        });
        request.once('socket', socket => socket.once('close', () => { socketClosed = true; clearTimeout(timer); finish(); }));
        request.once('close', () => { if (!socketClosed && !request?.socket) { socketClosed = true; clearTimeout(timer); finish(); } });
        request.once('error', error => { fault = error; if (!socketClosed) request?.destroy(); finish(); });
        if (raw.cancelled || !canIssue() || performance.now() >= deadline) { raw.abort(); return; }
        raw.issued = true; request.end(body);
      } catch (reason) {
        fault = reason instanceof Error ? reason : new Error('ONVIF native request failed', { cause: reason });
        if (!request) { clearTimeout(timer); reject(fault); return; }
        try { request.destroy(fault); } catch { request.socket?.destroy(); }
      }
    });
  }
  async function exchange(value: Active, method: 'POST' | 'GET', path: string, body: Buffer | undefined,
    deadline: number, signal: AbortSignal | undefined, limit: number): Promise<Readonly<{ bytes: Buffer; issued: boolean }>> {
    if (value.raw) throw Object.assign(new Error('busy'), { kind: 'busy' });
    const raw: Raw = { issued: false, cancelled: false, abort() { raw.cancelled = true; }, promise: undefined as unknown as Promise<Buffer> };
    const cancel = () => raw.abort();
    for (const source of [owner, value.grant.signal, value.stopAbort.signal, ...(signal ? [signal] : [])])
      Reflect.apply(EventTarget.prototype.addEventListener, source, ['abort', cancel, { once: true }]);
    raw.promise = Promise.resolve().then(() => {
      if (raw.cancelled || !current(value) || signal && aborted(signal) || performance.now() >= deadline) throw new Error('cancelled');
      return perform(method, path, body, raw, deadline, () => current(value) && !raw.cancelled && (!signal || !aborted(signal)), limit);
    });
    value.raw = raw;
    try { return { bytes: await raw.promise, issued: raw.issued }; }
    catch (reason) {
      const error = reason instanceof Error ? reason : new Error('ONVIF request failed', { cause: reason });
      Object.assign(error, { issued: raw.issued, ...(raw.expired ? { kind: 'expired' } : {}) });
      throw error;
    }
    finally {
      for (const source of [owner, value.grant.signal, value.stopAbort.signal, ...(signal ? [signal] : [])])
        Reflect.apply(EventTarget.prototype.removeEventListener, source, ['abort', cancel]);
      if (value.raw === raw) value.raw = undefined;
    }
  }
  function operationFailure(reason: unknown, issued: boolean, deadline: number, signal?: AbortSignal): OnvifSnapshotFailure {
    if (terminal) return 'closed';
    if (performance.now() >= deadline) return 'expired';
    if (aborted(owner) || signal && aborted(signal)) return 'cancelled';
    const kind = (reason as { kind?: unknown })?.kind;
    if (kind === 'busy' || kind === 'server' || kind === 'protocol' || kind === 'expired') return kind;
    return issued ? 'transport' : 'cancelled';
  }
  async function start(request: Readonly<{ purpose: string; deadline: number }>): Promise<OnvifSnapshotResult<OnvifSnapshotEpoch>> {
    const value = own(request, ['purpose', 'deadline']);
    if (!value || typeof value.purpose !== 'string' || !value.purpose.length || value.purpose.length > 160 ||
      !deadlineValid(value.deadline, ONVIF_SNAPSHOT_LIMITS.operationMs)) return fail('invalid');
    if (terminal) return fail('closed');
    if (opening || active) return fail('busy');
    if (attempts >= ONVIF_SNAPSHOT_LIMITS.attempts) return fail('quota');
    attempts++; opening = true; const atGeneration = ++generation;
    const grant = authority('resolve-snapshot-uri', value.purpose as string, value.deadline as number, atGeneration);
    if (!grant || terminal || generation !== atGeneration) { opening = false; return fail('denied'); }
    const handle = Object.freeze({}) as OnvifSnapshotEpoch;
    const state: Active = { generation: atGeneration, handle, grant, ready: false, retired: false,
      stopAbort: new AbortController(), snapshotUri: selectedSnapshotUri };
    active = state; handles.set(handle as object, state); opening = false;
    const revoke = () => { void stopActive(state); };
    state.detach = () => Reflect.apply(EventTarget.prototype.removeEventListener, grant.signal, ['abort', revoke]);
    Reflect.apply(EventTarget.prototype.addEventListener, grant.signal, ['abort', revoke, { once: true }]);
    if (!current(state)) { await stopActive(state); return fail('cancelled'); }
    const effectiveDeadline = Math.min(value.deadline as number, grant.expiresAt);
    if (performance.now() >= effectiveDeadline) { await stopActive(state); return fail('expired'); }
    let issued = false;
    try {
      const response = await exchange(state, 'POST', '/onvif/media_service', requestBody(selected.profileToken),
        effectiveDeadline, undefined, ONVIF_SNAPSHOT_LIMITS.soapBytes);
      issued = response.issued;
      try { parseSnapshotUri(response.bytes, selectedSnapshotUri); }
      catch (reason) { throw Object.assign(new Error('ONVIF SOAP response malformed', { cause: reason }), { kind: 'protocol' }); }
      if (performance.now() >= effectiveDeadline) throw Object.assign(new Error('ONVIF control grant expired'), { kind: 'expired' });
      if (!current(state)) throw new Error('cancelled');
      state.ready = true; return pass(handle);
    } catch (reason) {
      issued ||= (reason as { issued?: unknown })?.issued === true;
      const failure = operationFailure(reason, issued, effectiveDeadline);
      await stopActive(state); return fail(failure, issued);
    }
  }
  async function captureSnapshot(epoch: OnvifSnapshotEpoch, request: OnvifSnapshotOperation): Promise<OnvifSnapshotResult<OnvifSnapshot>> {
    const value = own(request, ['purpose', 'signal', 'deadline']);
    if (!value || typeof value.purpose !== 'string' || !value.purpose.length || value.purpose.length > 160 ||
      !genuineSignal(value.signal) || !deadlineValid(value.deadline, ONVIF_SNAPSHOT_LIMITS.operationMs)) return fail('invalid');
    if (terminal) return fail('closed');
    const state = epoch && typeof epoch === 'object' ? handles.get(epoch as object) : undefined;
    if (!state || !current(state) || !state.ready) return fail('cancelled');
    if (state.raw || state.operation) return fail('busy');
    if (captures >= ONVIF_SNAPSHOT_LIMITS.captures) return fail('quota');
    let settleOperation!: () => void;
    const operation = new Promise<void>(resolve => { settleOperation = resolve; });
    state.operation = operation;
    let mediaGrant: Readonly<{ signal: AbortSignal; expiresAt: number }> | undefined;
    const mediaController = new AbortController(), mediaAbort = () => mediaController.abort();
    let issued = false, effectiveDeadline = value.deadline as number;
    try {
      if (aborted(value.signal as AbortSignal)) return fail('cancelled');
      mediaGrant = authority('read-snapshot', value.purpose as string, value.deadline as number, state.generation);
      if (!mediaGrant || !current(state)) return fail('denied');
      Reflect.apply(EventTarget.prototype.addEventListener, mediaGrant.signal, ['abort', mediaAbort, { once: true }]);
      Reflect.apply(EventTarget.prototype.addEventListener, value.signal, ['abort', mediaAbort, { once: true }]);
      effectiveDeadline = Math.min(value.deadline as number, mediaGrant.expiresAt, state.grant.expiresAt);
      if (aborted(mediaGrant.signal) || aborted(value.signal as AbortSignal) || performance.now() >= effectiveDeadline) return fail('cancelled');
      captures++;
      const response = await exchange(state, 'GET', selected.snapshotPath, undefined,
        effectiveDeadline, mediaController.signal, ONVIF_SNAPSHOT_LIMITS.snapshotBytes);
      issued = response.issued;
      try { validateJpeg(response.bytes); }
      catch (reason) { throw Object.assign(new Error('ONVIF JPEG response malformed', { cause: reason }), { kind: 'protocol' }); }
      if (!current(state) || aborted(mediaGrant.signal) || aborted(value.signal as AbortSignal) || performance.now() >= effectiveDeadline)
        return fail('cancelled', issued);
      const bytes = Uint8Array.from(response.bytes), next = sequence + 1;
      const reference = await createAssetReference(`onvif-${selected.id}:snapshot-${next}`, 'blob', bytes);
      if (!current(state) || aborted(mediaGrant.signal) || aborted(value.signal as AbortSignal) || performance.now() >= effectiveDeadline)
        return fail('cancelled', issued);
      sequence = next;
      return pass(Object.freeze({ reference, mediaType: 'image/jpeg' as const, bytes, sequence: next,
        receivedAt: performance.now(), evidence: 'target-bytes-observed' as const,
        provenance: Object.freeze({ provider: 'onvif-get-snapshot-uri' as const, profileToken: selected.profileToken,
          physicalSource: 'unverified' as const, captureTimeKnown: false as const }) }));
    } catch (reason) { issued ||= (reason as { issued?: unknown })?.issued === true;
      return fail(operationFailure(reason, issued, effectiveDeadline, mediaController.signal), issued); }
    finally { if (mediaGrant) Reflect.apply(EventTarget.prototype.removeEventListener, mediaGrant.signal, ['abort', mediaAbort]);
      Reflect.apply(EventTarget.prototype.removeEventListener, value.signal, ['abort', mediaAbort]);
      if (state.operation === operation) state.operation = undefined; settleOperation(); }
  }
  async function stop(): Promise<void> { const value = active; if (value) await stopActive(value);
    else { generation++; opening = false; } }
  async function close(): Promise<void> { if (!terminal) { terminal = true; generation++; } const value = active;
    Reflect.apply(EventTarget.prototype.removeEventListener, owner, ['abort', ownerAbort]);
    if (value) await stopActive(value); }
  const ownerAbort = () => { terminal = true; generation++;
    if (active) void stopActive(active); };
  if (!terminal) Reflect.apply(EventTarget.prototype.addEventListener, owner, ['abort', ownerAbort, { once: true }]);
  return Object.freeze({ start, capture: captureSnapshot, stop, close,
    status: () => Object.freeze({ phase: phase(), attempts, captures, sequence, rawPending: active?.raw || active?.operation ? 1 : 0 }) });
}
