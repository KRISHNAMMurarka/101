import { parseDeviceDescriptor, snapshotJson } from '@101/device-model';
import type { DeviceCapability, DeviceDescriptor } from '@101/device-model';

export const BROWSER_CHOOSER_LIMITS = Object.freeze({ declarations: 8, capabilities: 8, filters: 4, services: 8,
  attempts: 64, nativePending: 2, capturePending: 1, requestMs: 5000, selectionMs: 30000 });
export type BrowserChooserKind = 'hid' | 'bluetooth' | 'serial' | 'camera' | 'audio';
export interface BrowserHidFilter { readonly vendorId?: number; readonly productId?: number; readonly usagePage?: number; readonly usage?: number }
export interface BrowserBluetoothFilter { readonly name?: string; readonly namePrefix?: string; readonly services?: readonly (number | string)[] }
export interface BrowserSerialFilter { readonly usbVendorId?: number; readonly usbProductId?: number }
interface Declaration { readonly id: string; readonly device: unknown; readonly capabilities: readonly string[] }
export type BrowserChooserDeclaration = Declaration & (
  { readonly kind: 'hid'; readonly selection: Readonly<{ filters: readonly BrowserHidFilter[] }> } |
  { readonly kind: 'bluetooth'; readonly selection: Readonly<{ filters: readonly BrowserBluetoothFilter[]; optionalServices?: readonly (number | string)[] }> } |
  { readonly kind: 'serial'; readonly selection: Readonly<{ filters: readonly BrowserSerialFilter[] }> } |
  { readonly kind: 'camera' | 'audio'; readonly selection: Readonly<{ deviceId?: string }> });
export interface BrowserChooserScope { readonly principalId: string; readonly applicationId: string; readonly sessionId: string }
export interface BrowserChooserResource { readonly deviceId: string; readonly descriptorRevision: number; readonly capabilityId: string;
  readonly schemaVersion: number; readonly semantic: string; readonly operation: 'read' | 'subscribe' }
export interface BrowserChooserRequest {
  readonly declarationId: string; readonly kind: BrowserChooserKind; readonly scope: BrowserChooserScope;
  readonly resources: readonly BrowserChooserResource[]; readonly selection: BrowserChooserDeclaration['selection']; readonly expiresAt: number;
}
export interface BrowserChooserCaptureRequest extends BrowserChooserRequest { readonly selectionId: string; readonly action: 'capture' }
export interface BrowserChooserCaptureGrant { readonly request: Readonly<BrowserChooserCaptureRequest>; readonly expiresAt: number }
export interface BrowserChooserContext { readonly signal: AbortSignal; isCurrent(): boolean }
export interface BrowserChooserNativeSelection {
  /** Trusted adapter-private object, never returned by the controller or persisted. */
  readonly value: unknown; readonly release: () => void | Promise<void>;
  readonly onLoss?: (listener: () => void) => () => void;
}
export interface BrowserChooserCaptureLease { readonly stop: () => void | Promise<void>; readonly onLoss?: (listener: () => void) => () => void }
export interface BrowserChooserCaptureContext extends BrowserChooserContext { readonly request: Readonly<BrowserChooserCaptureRequest>; readonly expiresAt: number }
export interface BrowserChooserAdapterBinding {
  readonly id: string;
  /** Reuse an existing chooser/lifecycle owner for camera/audio; this must not capture input. */
  readonly choose?: (request: Readonly<BrowserChooserRequest>, context: BrowserChooserContext) => BrowserChooserNativeSelection | Promise<BrowserChooserNativeSelection>;
  /** Trusted existing adapter must check context immediately before effects and after its awaits,
   * and return a lease bound to that exact owned activation. This is not a hardware proof callback. */
  readonly capture: (selected: unknown, context: BrowserChooserCaptureContext) => BrowserChooserCaptureLease | Promise<BrowserChooserCaptureLease>;
}
interface Events { addEventListener?(type: string, listener: EventListener): void; removeEventListener?(type: string, listener: EventListener): void }
export interface BrowserChooserEnvironment {
  secureContext(): boolean; userActivation(): boolean;
  hid?: Events & { requestDevice(options: { filters: BrowserHidFilter[] }): Promise<unknown[]> };
  bluetooth?: { requestDevice(options: { filters: BrowserBluetoothFilter[]; optionalServices?: (number | string)[] }): Promise<unknown> };
  serial?: Events & { requestPort(options: { filters: BrowserSerialFilter[] }): Promise<unknown> };
  document?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
}
export interface BrowserChooserOptions {
  readonly declarations: readonly BrowserChooserDeclaration[]; readonly adapters?: readonly BrowserChooserAdapterBinding[];
  readonly scope: BrowserChooserScope; readonly now: () => number;
  /** Capture consent does not mint SDK resource read/subscribe/write/invoke grants. */
  readonly authorizeCapture: (request: Readonly<BrowserChooserCaptureRequest>) => BrowserChooserCaptureGrant | undefined;
  readonly environment?: BrowserChooserEnvironment; readonly requestMs?: number; readonly selectionMs?: number;
}
export interface BrowserChooserSelection { readonly kind: 'browser-selection' }
export type BrowserChooserReason = 'invalid' | 'closed' | 'busy' | 'capacity' | 'unsupported' | 'adapter-unbound' | 'activation-required' |
  'denied' | 'cancelled' | 'expired' | 'lost' | 'failed' | 'hidden' | 'stopped' | 'selected' | 'capturing' | 'idle';
export type BrowserChooserResult<T = undefined> = Readonly<{ ok: true; value: T; reason?: never }> | Readonly<{ ok: false; reason: BrowserChooserReason; value?: never }>;
export interface BrowserChooserOption {
  readonly id: string; readonly kind: BrowserChooserKind; readonly label: string; readonly selection: BrowserChooserDeclaration['selection'];
  readonly capabilities: readonly DeviceCapability[]; readonly chooserSupported: boolean; readonly captureBound: boolean;
}
export interface BrowserChooserSnapshot {
  readonly state: 'idle' | 'choosing' | 'selected' | 'opening' | 'capturing' | 'failed' | 'closed'; readonly outcome: BrowserChooserReason;
  readonly nativePending: number; readonly cleanupPending: number; readonly remainingAttempts: number; readonly timerArmed: boolean;
  readonly choicePending: boolean; readonly capturePending: boolean; readonly options: readonly BrowserChooserOption[];
  readonly current?: Readonly<{ declarationId: string; kind: BrowserChooserKind; expiresAt: number; resources: readonly BrowserChooserResource[] }>;
}
export interface BrowserChooserController {
  choose(id: string): Promise<BrowserChooserResult<BrowserChooserSelection>>;
  start(selection: BrowserChooserSelection): Promise<BrowserChooserResult>;
  isCurrent(selection: BrowserChooserSelection): boolean;
  cancel(): void; stop(): void; sweep(): void; snapshot(): BrowserChooserSnapshot; close(): void;
}
interface Compiled { id: string; kind: BrowserChooserKind; device: Readonly<DeviceDescriptor>; capabilities: readonly DeviceCapability[];
  selection: BrowserChooserDeclaration['selection']; resources: readonly BrowserChooserResource[]; adapter?: BrowserChooserAdapterBinding }
interface Pending<T> { abort: AbortController; deadline: number; settled: boolean; resolve: (result: BrowserChooserResult<T>) => void }
interface Current { handle: BrowserChooserSelection; id: string; declaration: Compiled; lease: BrowserChooserNativeSelection; expiresAt: number;
  lossRemove?: () => void; capture?: BrowserChooserCaptureLease; captureRemove?: () => void; captureAbort?: AbortController }
const ok = <T = undefined>(value: T = undefined as T): BrowserChooserResult<T> => Object.freeze({ ok: true, value });
const no = (reason: BrowserChooserReason): BrowserChooserResult<never> => Object.freeze({ ok: false, reason });
function fields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid chooser data');
  const keys = Reflect.ownKeys(input), out: Record<string, unknown> = Object.create(null);
  if (required.some(key => !keys.includes(key))) throw new TypeError('Invalid chooser fields');
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== 'string' || ![...required, ...optional].includes(key) || !property?.enumerable || !('value' in property)) throw new TypeError('Invalid chooser fields');
    out[key] = property.value;
  }
  return out;
}
function text(input: unknown, max = 128): string {
  if (typeof input !== 'string' || !input.length || input.length > max || input.trim() !== input ||
    [...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new TypeError('Invalid chooser identity');
  return input;
}
function number(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) throw new TypeError('Invalid chooser range'); return input;
}
function uuid(input: unknown): number | string {
  if (typeof input === 'number') return number(input, 0, 0xffffffff);
  if (typeof input !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input)) throw new TypeError('Invalid chooser service'); return input;
}
function services(input: unknown): readonly (number | string)[] {
  if (!Array.isArray(input) || !input.length || input.length > BROWSER_CHOOSER_LIMITS.services) throw new TypeError('Invalid chooser services');
  const result = input.map(uuid); if (new Set(result).size !== result.length) throw new TypeError('Duplicate chooser service'); return Object.freeze(result);
}
function selection(kind: BrowserChooserKind, input: unknown): BrowserChooserDeclaration['selection'] {
  const copied = snapshotJson(input);
  if (kind === 'camera' || kind === 'audio') {
    const item = fields(copied, [], ['deviceId']); if (item.deviceId !== undefined) text(item.deviceId, 256);
    return copied as BrowserChooserDeclaration['selection'];
  }
  const item = fields(copied, ['filters'], kind === 'bluetooth' ? ['optionalServices'] : []);
  if (!Array.isArray(item.filters) || !item.filters.length || item.filters.length > BROWSER_CHOOSER_LIMITS.filters) throw new TypeError('Explicit chooser filters required');
  for (const filter of item.filters) {
    if (kind === 'bluetooth') {
      const parts = fields(filter, [], ['services', 'name', 'namePrefix']);
      if (Object.keys(parts).length === 0) throw new TypeError('Explicit chooser filter required');
      if (parts.services !== undefined) services(parts.services);
      for (const key of ['name', 'namePrefix']) if (parts[key] !== undefined) text(parts[key], 248);
      if (parts.name !== undefined && parts.namePrefix !== undefined) throw new TypeError('Conflicting chooser names');
    } else {
      const keys = kind === 'hid' ? ['vendorId', 'productId', 'usagePage', 'usage'] : ['usbVendorId', 'usbProductId'];
      const parts = fields(filter, [], keys);
      if (!Object.keys(parts).length) throw new TypeError('Explicit chooser filter required');
      for (const value of Object.values(parts)) number(value, 0, 65535);
      if (kind === 'hid' ? parts.productId !== undefined && parts.vendorId === undefined || parts.usage !== undefined && parts.usagePage === undefined :
        parts.usbProductId !== undefined && parts.usbVendorId === undefined) throw new TypeError('Incomplete chooser filter');
    }
  }
  if (item.optionalServices !== undefined) services(item.optionalServices);
  return copied as BrowserChooserDeclaration['selection'];
}
function environment(): BrowserChooserEnvironment {
  const nav = typeof navigator === 'undefined' ? undefined : navigator as unknown as Partial<BrowserChooserEnvironment> & { userActivation?: { isActive: boolean } };
  return { secureContext: () => globalThis.isSecureContext === true, userActivation: () => nav?.userActivation?.isActive === true,
    hid: nav?.hid, bluetooth: nav?.bluetooth, serial: nav?.serial, document: typeof document === 'undefined' ? undefined : document };
}
function errorReason(error: unknown, kind: BrowserChooserKind): BrowserChooserReason {
  let name: unknown; try { name = error instanceof DOMException ? error.name : Object.getOwnPropertyDescriptor(error ?? {}, 'name')?.value; } catch { /* Fixed outcome only. */ }
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'AbortError' || name === 'NotFoundError' && !['camera', 'audio'].includes(kind) ? 'cancelled' : 'failed';
}

/** Permissioned local selection. Native defaults never open devices, read input, or
 * grant resource operations. Camera/audio capture stays with a separately bound
 * existing adapter. Synchronous adapter/clock/environment code is trusted host
 * code; leases confirm adapter activation, not physical sensor compatibility.
 * Native chooser/open reservations remain held until actual completion and late
 * cleanup, even when a logical request expires. */
export function createBrowserChooserController(options: BrowserChooserOptions): BrowserChooserController {
  const scope = snapshotJson(options.scope) as unknown as BrowserChooserScope;
  fields(scope, ['principalId', 'applicationId', 'sessionId']); Object.values(scope).forEach(value => text(value));
  const now = options.now, authorize = options.authorizeCapture, env = options.environment ?? environment();
  if (typeof now !== 'function' || typeof authorize !== 'function' || typeof env.secureContext !== 'function' || typeof env.userActivation !== 'function') throw new TypeError('Explicit chooser host required');
  const secure = env.secureContext.bind(env), activated = env.userActivation.bind(env);
  const requestMs = number(options.requestMs ?? 2500, 1, BROWSER_CHOOSER_LIMITS.requestMs);
  const selectionMs = number(options.selectionMs ?? 30000, 1, BROWSER_CHOOSER_LIMITS.selectionMs);
  if (!Array.isArray(options.declarations) || !options.declarations.length || options.declarations.length > BROWSER_CHOOSER_LIMITS.declarations ||
    options.adapters !== undefined && (!Array.isArray(options.adapters) || options.adapters.length > BROWSER_CHOOSER_LIMITS.declarations)) throw new TypeError('Invalid chooser count');
  const adapters = new Map<string, BrowserChooserAdapterBinding>();
  for (const binding of options.adapters ?? []) {
    const parts = fields(binding, ['id', 'capture'], ['choose']); const id = text(parts.id);
    if (adapters.has(id) || typeof parts.capture !== 'function' || parts.choose !== undefined && typeof parts.choose !== 'function') throw new TypeError('Invalid chooser adapter');
    adapters.set(id, Object.freeze({ id, capture: binding.capture.bind(binding), ...(binding.choose ? { choose: binding.choose.bind(binding) } : {}) }));
  }
  const entries = new Map<string, Compiled>();
  for (const declaration of options.declarations) {
    const parts = fields(declaration, ['id', 'kind', 'device', 'capabilities', 'selection']), id = text(parts.id), kind = parts.kind as BrowserChooserKind;
    if (!['hid', 'bluetooth', 'serial', 'camera', 'audio'].includes(kind) || entries.has(id)) throw new TypeError('Invalid chooser declaration');
    const device = parseDeviceDescriptor(parts.device), ids = snapshotJson(parts.capabilities) as unknown as string[];
    if (!Array.isArray(ids) || !ids.length || ids.length > BROWSER_CHOOSER_LIMITS.capabilities || new Set(ids).size !== ids.length) throw new TypeError('Invalid selected capabilities');
    const capabilities = Object.freeze(ids.map(id => {
      text(id); const capability = device.capabilities.find(value => value.id === id);
      if (!capability || !['sample', 'event', 'property'].includes(capability.kind) || !capability.permissions.some(value => value === 'read' || value === 'subscribe')) throw new TypeError('Unsupported capture resource');
      return capability;
    }));
    const resources = Object.freeze(capabilities.map(capability => Object.freeze({ deviceId: device.id, descriptorRevision: device.revision,
      capabilityId: capability.id, schemaVersion: capability.schemaVersion, semantic: capability.semantic,
      operation: capability.permissions.includes('subscribe') ? 'subscribe' as const : 'read' as const })));
    entries.set(id, { id, kind, device, capabilities, resources, selection: selection(kind, parts.selection), adapter: adapters.get(id) });
  }
  for (const id of adapters.keys()) if (!entries.has(id)) throw new TypeError('Unknown chooser adapter');
  const handles = new WeakMap<BrowserChooserSelection, Current>(); let selected: Current | undefined;
  let choicePending: Pending<BrowserChooserSelection> | undefined, capturePending: (Pending<undefined> & { owner: Current }) | undefined;
  let closed = false, dispatching = false, retiring = 0, previousAt = -Infinity, attempts = 0, sequence = 0, nativePending = 0, captureInFlight = 0, cleanupPending = 0;
  let outcome: BrowserChooserReason = 'idle', timer: ReturnType<typeof setTimeout> | undefined, visibilityRemove: (() => void) | undefined;
  const finish = <T>(pending: Pending<T>, result: BrowserChooserResult<T>): void => { if (!pending.settled) { pending.settled = true; pending.resolve(result); } };
  function clearTimer(): void { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function cleanup(callback: () => void | Promise<void>): void {
    // Reserve before trusted cleanup callbacks, so reentry cannot open a replacement.
    cleanupPending++;
    let returned: void | Promise<void>; try { returned = callback(); } catch { cleanupPending--; return; }
    if (returned !== undefined) void Promise.resolve(returned).catch(() => {}).finally(() => { cleanupPending--; });
    else cleanupPending--;
  }
  function cancelChoice(reason: BrowserChooserReason): void {
    const pending = choicePending; choicePending = undefined;
    if (pending) { pending.abort.abort(); finish(pending, no(reason)); }
  }
  function cancelCapture(reason: BrowserChooserReason): void {
    const pending = capturePending; capturePending = undefined;
    if (pending) { pending.abort.abort(); finish(pending, no(reason)); }
  }
  function retire(reason: BrowserChooserReason): void {
    retiring++;
    try {
      const current = selected; selected = undefined; outcome = reason; cancelCapture(reason);
      if (!current) return;
      handles.delete(current.handle);
      current.captureAbort?.abort(); const remove = current.lossRemove, captureRemove = current.captureRemove;
      current.lossRemove = undefined; current.captureRemove = undefined;
      if (remove) cleanup(remove); if (captureRemove) cleanup(captureRemove);
      if (current.capture) { const lease = current.capture; current.capture = undefined; cleanup(() => lease.stop()); }
      cleanup(() => current.lease.release());
    } finally { retiring--; }
  }
  function close(): void {
    if (closed) return; closed = true; clearTimer(); cancelChoice('closed'); retire('closed'); visibilityRemove?.(); visibilityRemove = undefined;
  }
  function time(): number | undefined {
    if (closed) return;
    let at: number; try { at = now(); } catch { close(); return; }
    if (closed) return;
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - BROWSER_CHOOSER_LIMITS.selectionMs || at < previousAt) { close(); return; }
    previousAt = at; return at;
  }
  function arm(at: number): void {
    clearTimer(); if (closed) return;
    const deadline = Math.min(choicePending?.deadline ?? Infinity, capturePending?.deadline ?? Infinity, selected?.expiresAt ?? Infinity);
    if (Number.isFinite(deadline)) timer = setTimeout(() => { timer = undefined; sweep(); }, Math.max(1, deadline - at));
  }
  function sweep(): void {
    const at = time(); if (at === undefined) return;
    if (choicePending && at >= choicePending.deadline) { cancelChoice('expired'); outcome = 'expired'; }
    if (capturePending && at >= capturePending.deadline) { cancelCapture('expired'); outcome = 'expired'; }
    if (selected && at >= selected.expiresAt) retire('expired'); arm(at);
  }
  function refresh(): number | undefined { const at = time(); if (at !== undefined) arm(at); return at; }
  function observeVisibility(pending: Pending<BrowserChooserSelection>): void {
    if (visibilityRemove || !env.document) return;
    const doc = env.document, listener = () => {
      if (doc.hidden) { retiring++; try { cancelChoice('hidden'); retire('hidden'); clearTimer(); } finally { retiring--; } }
    };
    doc.addEventListener('visibilitychange', listener);
    if (closed || choicePending !== pending) { doc.removeEventListener('visibilitychange', listener); return; }
    visibilityRemove = () => doc.removeEventListener('visibilitychange', listener);
  }
  function chooseSupported(entry: Compiled): boolean {
    return !!entry.adapter?.choose || (entry.kind === 'hid' ? typeof env.hid?.requestDevice === 'function' :
      entry.kind === 'bluetooth' ? typeof env.bluetooth?.requestDevice === 'function' : entry.kind === 'serial' ? typeof env.serial?.requestPort === 'function' : false);
  }
  function request(entry: Compiled, expiresAt: number): Readonly<BrowserChooserRequest> {
    return Object.freeze({ declarationId: entry.id, kind: entry.kind, scope, resources: entry.resources, selection: entry.selection, expiresAt });
  }
  function choiceCurrent(pending: Pending<BrowserChooserSelection>): boolean {
    const at = time(); return !closed && choicePending === pending && !pending.abort.signal.aborted && at !== undefined && at < pending.deadline;
  }
  function captureCurrent(pending: Pending<undefined> & { owner: Current }): boolean {
    const at = time(); return !closed && capturePending === pending && selected === pending.owner && !pending.abort.signal.aborted &&
      at !== undefined && at < pending.deadline && at < pending.owner.expiresAt;
  }
  function normalizedChoice(input: unknown): BrowserChooserNativeSelection {
    const parts = fields(input, ['value', 'release'], ['onLoss']);
    if (typeof parts.release !== 'function' || parts.onLoss !== undefined && typeof parts.onLoss !== 'function') throw new TypeError('Invalid chooser lease');
    const value = input as BrowserChooserNativeSelection;
    return Object.freeze({ value: parts.value, release: value.release.bind(value), ...(value.onLoss ? { onLoss: value.onLoss.bind(value) } : {}) });
  }
  function normalizedCapture(input: unknown): BrowserChooserCaptureLease {
    const parts = fields(input, ['stop'], ['onLoss']);
    if (typeof parts.stop !== 'function' || parts.onLoss !== undefined && typeof parts.onLoss !== 'function') throw new TypeError('Invalid capture lease');
    const value = input as BrowserChooserCaptureLease;
    return Object.freeze({ stop: value.stop.bind(value), ...(value.onLoss ? { onLoss: value.onLoss.bind(value) } : {}) });
  }
  function nativeChoice(entry: Compiled): Promise<BrowserChooserNativeSelection> {
    const connect = (value: unknown, manager?: Events, eventType = 'disconnect'): BrowserChooserNativeSelection => ({ value, release() {},
      ...(manager?.addEventListener && manager.removeEventListener ? { onLoss(listener: () => void) {
        const event: EventListener = raw => {
          const detail = raw as Event & { device?: unknown; port?: unknown };
          if (eventType === 'gattserverdisconnected' || detail.device === value || detail.port === value || detail.target === value) listener();
        };
        manager.addEventListener!(eventType, event); return () => manager.removeEventListener!(eventType, event);
      } } : {}) });
    if (entry.kind === 'hid') return env.hid!.requestDevice(entry.selection as { filters: BrowserHidFilter[] }).then(values => {
      if (!Array.isArray(values) || values.length > 1) throw Error('chooser-result');
      if (!values.length) throw new DOMException('Selection cancelled', 'AbortError'); return connect(values[0], env.hid);
    });
    if (entry.kind === 'bluetooth') return env.bluetooth!.requestDevice(entry.selection as { filters: BrowserBluetoothFilter[]; optionalServices?: (number | string)[] }).then(value =>
      connect(value, value as Events, 'gattserverdisconnected'));
    if (entry.kind === 'serial') return env.serial!.requestPort(entry.selection as { filters: BrowserSerialFilter[] }).then(value => connect(value, env.serial));
    return Promise.reject(Error('adapter-unbound'));
  }
  function choose(id: string): Promise<BrowserChooserResult<BrowserChooserSelection>> {
    const entry = typeof id === 'string' ? entries.get(id) : undefined;
    if (closed) return Promise.resolve(no('closed')); if (!entry) return Promise.resolve(no('invalid'));
    if (dispatching || retiring || choicePending || nativePending >= BROWSER_CHOOSER_LIMITS.nativePending || cleanupPending) return Promise.resolve(no('busy'));
    if (attempts >= BROWSER_CHOOSER_LIMITS.attempts) return Promise.resolve(no('capacity'));
    if (!chooseSupported(entry)) { outcome = ['camera', 'audio'].includes(entry.kind) ? 'adapter-unbound' : 'unsupported'; return Promise.resolve(no(outcome)); }
    attempts++; nativePending++; dispatching = true;
    let reserved = true; const releaseReservation = () => { if (reserved) { reserved = false; nativePending--; } };
    let resolve!: Pending<BrowserChooserSelection>['resolve']; const result = new Promise<BrowserChooserResult<BrowserChooserSelection>>(yes => { resolve = yes; });
    const pending: Pending<BrowserChooserSelection> = { abort: new AbortController(), deadline: Infinity, settled: false, resolve }; choicePending = pending;
    try {
      const at = time(); if (at === undefined || choicePending !== pending) { releaseReservation(); finish(pending, no(closed ? 'closed' : 'cancelled')); return result; }
      pending.deadline = at + requestMs;
      const safe = secure(); if (choicePending !== pending || closed) { releaseReservation(); finish(pending, no('cancelled')); return result; }
      const active = activated(); if (choicePending !== pending || closed) { releaseReservation(); finish(pending, no('cancelled')); return result; }
      if (!safe || !active || env.document?.hidden) {
        choicePending = undefined; releaseReservation(); outcome = !safe ? 'denied' : !active ? 'activation-required' : 'hidden'; pending.abort.abort(); finish(pending, no(outcome)); refresh(); return result;
      }
      observeVisibility(pending); if (choicePending !== pending || closed) { releaseReservation(); finish(pending, no('cancelled')); return result; }
      if (!choiceCurrent(pending)) { cancelChoice('expired'); releaseReservation(); outcome = 'expired'; refresh(); return result; }
      const invoke = entry.adapter?.choose, scopeRequest = request(entry, at + selectionMs);
      const context: BrowserChooserContext = Object.freeze({ signal: pending.abort.signal, isCurrent: () => choiceCurrent(pending) });
      let attached: Current | undefined;
      const native = invoke ? invoke(scopeRequest, context) : nativeChoice(entry);
      void Promise.resolve(native).then(async value => {
        const lease = normalizedChoice(value); const after = time();
        if (closed || choicePending !== pending || after === undefined || after >= pending.deadline || after >= scopeRequest.expiresAt) {
          await lease.release(); if (choicePending === pending) { choicePending = undefined; pending.abort.abort(); outcome = 'expired'; finish(pending, no('expired')); } return;
        }
        retire('stopped'); if (closed || choicePending !== pending) { await lease.release(); return; }
        const handle: BrowserChooserSelection = Object.freeze({ kind: 'browser-selection' });
        const current: Current = { handle, id: 'selection-' + ++sequence, declaration: entry, lease, expiresAt: scopeRequest.expiresAt };
        selected = current; attached = current; handles.set(handle, current);
        if (lease.onLoss) {
          const remove = lease.onLoss(() => { if (selected === current) { retire('lost'); refresh(); } });
          if (typeof remove !== 'function') throw new TypeError('Invalid chooser subscription');
          if (closed || selected !== current || choicePending !== pending) { cleanup(remove); if (selected === current) retire('cancelled'); finish(pending, no('lost')); return; } current.lossRemove = remove;
        }
        outcome = 'selected'; const finalAt = refresh();
        if (closed || selected !== current || choicePending !== pending || finalAt === undefined || finalAt >= pending.deadline || finalAt >= current.expiresAt) {
          const reason = closed ? 'closed' : finalAt !== undefined && (finalAt >= pending.deadline || finalAt >= current.expiresAt) ? 'expired' : 'cancelled';
          if (selected === current) retire(reason);
          if (choicePending === pending) { choicePending = undefined; pending.abort.abort(); }
          releaseReservation(); finish(pending, no(reason)); if (finalAt !== undefined) arm(finalAt); return;
        }
        choicePending = undefined; pending.abort.abort(); releaseReservation(); arm(finalAt);
        finish(pending, !closed && selected === current ? ok(handle) : no(closed ? 'closed' : 'lost'));
      }).catch(error => {
        releaseReservation(); if (attached && selected === attached) { retire('failed'); refresh(); }
        if (choicePending === pending) { choicePending = undefined; pending.abort.abort(); outcome = errorReason(error, entry.kind); finish(pending, no(outcome)); refresh(); }
      }).finally(() => { releaseReservation(); });
      arm(at);
    } catch (error) {
      releaseReservation(); if (choicePending === pending) { choicePending = undefined; pending.abort.abort(); outcome = errorReason(error, entry.kind); finish(pending, no(outcome)); refresh(); }
    } finally { dispatching = false; }
    return result;
  }
  function start(handle: BrowserChooserSelection): Promise<BrowserChooserResult> {
    const current = handles.get(handle);
    if (closed) return Promise.resolve(no('closed')); if (!current || selected !== current) return Promise.resolve(no('invalid'));
    if (dispatching || retiring || capturePending || captureInFlight || current.capture || nativePending >= BROWSER_CHOOSER_LIMITS.nativePending || cleanupPending) return Promise.resolve(no('busy'));
    if (attempts >= BROWSER_CHOOSER_LIMITS.attempts) return Promise.resolve(no('capacity'));
    const adapter = current.declaration.adapter; if (!adapter) { outcome = 'adapter-unbound'; return Promise.resolve(no(outcome)); }
    attempts++; nativePending++; captureInFlight++; dispatching = true;
    let reserved = true; const releaseReservation = () => { if (reserved) { reserved = false; nativePending--; captureInFlight--; } };
    let resolve!: Pending<undefined>['resolve']; const result = new Promise<BrowserChooserResult>(yes => { resolve = yes; });
    const pending: Pending<undefined> & { owner: Current } = { owner: current, abort: new AbortController(), deadline: Infinity, settled: false, resolve }; capturePending = pending;
    try {
      const at = time(); if (at === undefined || selected !== current || capturePending !== pending || at >= current.expiresAt) {
        if (selected === current) retire('expired'); else finish(pending, no('cancelled')); releaseReservation(); return result;
      }
      pending.deadline = Math.min(at + requestMs, current.expiresAt);
      const captureRequest: Readonly<BrowserChooserCaptureRequest> = Object.freeze({ ...request(current.declaration, current.expiresAt), selectionId: current.id, action: 'capture' });
      const decision = authorize(captureRequest), grant = decision === undefined ? undefined : fields(decision, ['request', 'expiresAt']);
      const after = time(); if (closed || selected !== current || capturePending !== pending || after === undefined) { releaseReservation(); finish(pending, no('cancelled')); return result; }
      if (!grant || grant.request !== captureRequest || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= after || grant.expiresAt > current.expiresAt) {
        capturePending = undefined; releaseReservation(); pending.abort.abort(); outcome = 'denied'; finish(pending, no('denied')); refresh(); return result;
      }
      const grantExpiresAt = grant.expiresAt;
      pending.deadline = Math.min(pending.deadline, grantExpiresAt);
      if (!captureCurrent(pending)) { cancelCapture('expired'); releaseReservation(); outcome = 'expired'; refresh(); return result; }
      const context: BrowserChooserCaptureContext = Object.freeze({ request: captureRequest, expiresAt: grant.expiresAt, signal: pending.abort.signal,
        isCurrent: () => {
          const at = time(); return !closed && selected === current && !pending.abort.signal.aborted && at !== undefined && at < grantExpiresAt &&
            (capturePending === pending ? at < pending.deadline : !!current.capture && current.captureAbort === pending.abort);
        } });
      const native = adapter.capture(current.lease.value, context);
      void Promise.resolve(native).then(async value => {
        const lease = normalizedCapture(value);
        if (!captureCurrent(pending)) { await lease.stop(); if (capturePending === pending) { capturePending = undefined; pending.abort.abort(); outcome = 'expired'; finish(pending, no('expired')); refresh(); } return; }
        current.capture = lease; current.captureAbort = pending.abort; current.expiresAt = Math.min(current.expiresAt, grant.expiresAt as number);
        if (lease.onLoss) {
          const remove = lease.onLoss(() => { if (selected === current) { retire('lost'); refresh(); } });
          if (typeof remove !== 'function') throw new TypeError('Invalid capture subscription');
          if (closed || selected !== current || current.capture !== lease || capturePending !== pending) { cleanup(remove); if (selected === current) retire('cancelled'); finish(pending, no('lost')); return; } current.captureRemove = remove;
        }
        outcome = 'capturing'; const finalAt = refresh();
        if (closed || selected !== current || capturePending !== pending || finalAt === undefined || finalAt >= pending.deadline || finalAt >= current.expiresAt) {
          const reason = closed ? 'closed' : finalAt !== undefined && (finalAt >= pending.deadline || finalAt >= current.expiresAt) ? 'expired' : 'cancelled';
          if (selected === current) retire(reason);
          releaseReservation(); finish(pending, no(reason)); if (finalAt !== undefined) arm(finalAt); return;
        }
        capturePending = undefined; releaseReservation(); arm(finalAt); finish(pending, ok());
      }).catch(error => {
        releaseReservation(); if (current.capture && selected === current && current.captureAbort === pending.abort) { retire('failed'); refresh(); }
        if (capturePending === pending) { capturePending = undefined; pending.abort.abort(); outcome = errorReason(error, current.declaration.kind); finish(pending, no(outcome)); refresh(); }
      }).finally(() => { releaseReservation(); });
      arm(after);
    } catch (error) {
      releaseReservation(); if (capturePending === pending) { capturePending = undefined; pending.abort.abort(); outcome = errorReason(error, current.declaration.kind); finish(pending, no(outcome)); refresh(); }
    } finally { dispatching = false; }
    return result;
  }
  function isCurrent(handle: BrowserChooserSelection): boolean { sweep(); return !closed && selected !== undefined && handles.get(handle) === selected; }
  function cancel(): void { cancelChoice('cancelled'); cancelCapture('cancelled'); outcome = 'cancelled'; refresh(); }
  function stop(): void {
    if (closed) return; retiring++;
    try { cancelChoice('stopped'); retire('stopped'); clearTimer(); visibilityRemove?.(); visibilityRemove = undefined; }
    finally { retiring--; }
  }
  function snapshot(): BrowserChooserSnapshot {
    return Object.freeze({ state: closed ? 'closed' : selected?.capture ? 'capturing' : capturePending ? 'opening' : choicePending ? 'choosing' : selected ? 'selected' :
      ['idle', 'cancelled', 'stopped'].includes(outcome) ? 'idle' : 'failed', outcome, nativePending, cleanupPending, remainingAttempts: BROWSER_CHOOSER_LIMITS.attempts - attempts,
      timerArmed: timer !== undefined, choicePending: !!choicePending, capturePending: !!capturePending,
      options: Object.freeze([...entries.values()].map(entry => Object.freeze({ id: entry.id, kind: entry.kind, label: entry.device.label,
        selection: entry.selection, capabilities: entry.capabilities, chooserSupported: chooseSupported(entry), captureBound: !!entry.adapter }))),
      ...(selected ? { current: Object.freeze({ declarationId: selected.declaration.id, kind: selected.declaration.kind, expiresAt: selected.expiresAt, resources: selected.declaration.resources }) } : {}) });
  }
  return Object.freeze({ choose, start, isCurrent, cancel, stop, sweep, snapshot, close });
}
