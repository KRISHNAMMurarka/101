import { getInputProfile, parseDeviceDescriptor } from '@101/device-model';
import type { DeviceDescriptor, JsonObject } from '@101/device-model';
import type { DeviceRuntime, EndpointHandle } from '@101/device-runtime';

export const BROWSER_HID_SWITCH_LIMITS = Object.freeze({ activeDevices: 1, sources: 1, resources: 1, reviewedFilters: 1,
  nativeSelectionOrOpen: 1, nativeCleanup: 1, attempts: 64, captureMs: 30000, logicalNativeWaitMs: 5000,
  reportBytes: 1, nativeReportSnapshotBytes: 32768, nativeCollectionItems: 32, maxReportHz: 20, burstReports: 4,
  reportsPerCapture: 600, reliablePending: 8, listeners: 7, expiryTimers: 1, nativeWaitTimers: 1 });
export type BrowserHidSwitchFailure = 'invalid' | 'unsupported' | 'unavailable' | 'activation-required' | 'denied' | 'busy' |
  'closed' | 'lost' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'cancelled' | 'quota' | 'timeout';
export type BrowserHidSwitchResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: BrowserHidSwitchFailure }>;
export interface BrowserHidSwitchProfile {
  readonly id: string; readonly revision: number; readonly vendorId: number; readonly productId: number;
  readonly usagePage: number; readonly usage: number; readonly reportId: number;
}
/** Minimal structural WebHID port. Supplied ports are trusted software seams, not native qualification. */
export interface NativeHidSwitchDevice extends EventTarget {
  readonly vendorId: number; readonly productId: number; readonly opened: boolean; readonly collections: unknown;
  open(): Promise<void>; close(): Promise<void>;
}
export interface NativeHidSwitchManager extends EventTarget {
  requestDevice(options: Readonly<{ filters: readonly Readonly<{ vendorId: number; productId: number; usagePage: number; usage: number }>[] }>): Promise<readonly NativeHidSwitchDevice[]>;
}
export interface BrowserHidSwitchEnvironment {
  readonly hid?: NativeHidSwitchManager;
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly secureContext: () => boolean; readonly userActivation: () => boolean;
  readonly hidden: () => boolean; readonly focused: () => boolean; readonly policy: () => 'allowed' | 'denied' | 'unknown';
}
export interface BrowserHidSwitchSelection { readonly browserHidSwitchSelection?: never }
export interface BrowserHidSwitchCaptureRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly deviceId: string; readonly connectionGeneration: number; readonly profile: BrowserHidSwitchProfile;
  readonly resources: readonly Readonly<{ capabilityId: 'switch'; operation: 'subscribe' }>[];
}
export interface BrowserHidSwitchCaptureGrant {
  readonly request: BrowserHidSwitchCaptureRequest; readonly signal: AbortSignal; readonly expiresAt: number;
}
export interface BrowserHidSwitchActivation { readonly device: DeviceDescriptor; readonly source: EndpointHandle; readonly connectionGeneration: number }
export interface BrowserHidSwitchOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly reviewedProfile: BrowserHidSwitchProfile; readonly now: () => number;
  readonly authorizeCapture: (request: BrowserHidSwitchCaptureRequest) => BrowserHidSwitchCaptureGrant | undefined | Promise<BrowserHidSwitchCaptureGrant | undefined>;
  readonly environment?: BrowserHidSwitchEnvironment;
}
export interface BrowserHidSwitchSnapshot {
  readonly phase: 'idle' | 'pending' | 'selected' | 'active' | 'closed'; readonly reason: BrowserHidSwitchFailure | 'idle' | 'selected' | 'active';
  readonly attempts: number; readonly connectionGeneration: number; readonly activeSources: number; readonly listeners: number;
  readonly nativePending: number; readonly cleanupPending: number; readonly cleanupFailed: boolean;
  readonly timerArmed: boolean; readonly waitTimerArmed: boolean; readonly reports: number;
}
export interface BrowserHidSwitchProvider {
  availability(): BrowserHidSwitchResult<Readonly<{ policy: 'allowed' | 'denied' | 'unknown' }>>;
  choose(): Promise<BrowserHidSwitchResult<BrowserHidSwitchSelection>>;
  start(selection: BrowserHidSwitchSelection, request: Readonly<{ purpose: string }>): Promise<BrowserHidSwitchResult<BrowserHidSwitchActivation>>;
  stop(): void; sweep(): void; snapshot(): BrowserHidSwitchSnapshot; close(): Promise<void>;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
const byteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!, readByte = DataView.prototype.getUint8;
const isAborted = (value: AbortSignal): boolean => Reflect.apply(aborted, value, []) as boolean;
function isSignal(value: unknown): value is AbortSignal { try { isAborted(value as AbortSignal); return true; } catch { return false; } }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const result: Record<string, unknown> = Object.create(null), descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]!)) return; result[key] = descriptors[key]!.value;
  }
  return result;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,79}$/.test(value);
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const no = (reason: BrowserHidSwitchFailure): BrowserHidSwitchResult<never> => Object.freeze({ ok: false, reason });
const yes = <T>(value: T): BrowserHidSwitchResult<T> => Object.freeze({ ok: true, value });
function failure(error: unknown): BrowserHidSwitchFailure {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && ['SecurityError', 'NotAllowedError'].includes(error.name)) return 'denied';
  const own = fields(error, ['ok', 'reason']); return own?.ok === false && ['invalid', 'unsupported', 'lost'].includes(own.reason as string) ? own.reason as BrowserHidSwitchFailure : 'unavailable';
}
function defaults(): BrowserHidSwitchEnvironment {
  const doc = typeof document === 'undefined' ? undefined : document;
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { hid?: NativeHidSwitchManager };
  const target = typeof window === 'undefined' ? new EventTarget() : window;
  return { ...(nav?.hid ? { hid: nav.hid } : {}), target, document: doc ?? new EventTarget(), secureContext: () => globalThis.isSecureContext === true,
    userActivation: () => nav?.userActivation?.isActive === true, hidden: () => doc?.hidden !== false, focused: () => doc?.hasFocus() === true,
    policy() { const policy = (doc as (Document & { permissionsPolicy?: { allowsFeature(name: string): boolean } }) | undefined)?.permissionsPolicy;
      return policy && typeof policy.allowsFeature === 'function' ? policy.allowsFeature('hid') ? 'allowed' : 'denied' : 'unknown'; } };
}
function nativeOpened(device: NativeHidSwitchDevice): boolean { return device.opened; }
function layout(device: NativeHidSwitchDevice, profile: BrowserHidSwitchProfile): string {
  if (device.vendorId !== profile.vendorId || device.productId !== profile.productId) throw no('unsupported');
  const collections = device.collections;
  // This reviewed profile deliberately accepts one declared byte report only;
  // wider HID layouts require another reviewed implementation, not guessing.
  if (!Array.isArray(collections) || collections.length !== 1) throw no('unsupported');
  const collection = collections[0] as Record<string, unknown> | undefined;
  if (!collection || collection.usagePage !== profile.usagePage || collection.usage !== profile.usage) throw no('unsupported');
  const children = collection.children, inputs = collection.inputReports, outputs = collection.outputReports, features = collection.featureReports;
  if (![children, outputs, features].every(value => Array.isArray(value) && value.length === 0) || !Array.isArray(inputs) || inputs.length !== 1) throw no('unsupported');
  const report = inputs[0] as Record<string, unknown> | undefined;
  if (!report || report.reportId !== profile.reportId || !Array.isArray(report.items) || report.items.length !== 1) throw no('unsupported');
  const item = report.items[0] as Record<string, unknown> | undefined;
  const expected = { reportSize: 8, reportCount: 1, logicalMinimum: 0, logicalMaximum: 1, isAbsolute: true, isArray: false,
    isBufferedBytes: false, isConstant: false, isLinear: true, hasNull: false, wrap: false, unitExponent: 0, unitSystem: 'none' };
  if (!item) throw no('unsupported');
  for (const [key, value] of Object.entries(expected)) if (item[key] !== value) throw no('unsupported');
  const usages = item.usages; if (!Array.isArray(usages) || usages.length !== 1 || usages[0] !== profile.usagePage * 65536 + profile.usage) throw no('unsupported');
  // No product name, serial identifier, arbitrary property dump or report data is retained.
  return `${profile.vendorId}:${profile.productId}:${profile.usagePage}:${profile.usage}:${profile.reportId}:8:1:0:1`;
}
let instances = 0;
interface Choice { handle: BrowserHidSwitchSelection; native: NativeHidSwitchDevice; generation: number; layout: string; device: DeviceDescriptor }
interface Active { choice: Choice; source?: EndpointHandle; grant?: Readonly<{ signal: AbortSignal; expiresAt: number }>;
  opening: boolean; openSettled: boolean; closingIssued?: boolean; closing?: Promise<void>; reports: number; tokens: number; tokenTime: number; operation: number }
interface Logical<T> { promise: Promise<BrowserHidSwitchResult<T>>; finish(value: BrowserHidSwitchResult<T>): void }

export function createBrowserHidSwitchProvider(options: BrowserHidSwitchOptions): BrowserHidSwitchProvider {
  const runtime = options.runtime, owner = options.ownerSignal, now = options.now, authorize = options.authorizeCapture;
  const scope = fields(options.scope, ['principalId', 'applicationId', 'sessionId']), reviewed = fields(options.reviewedProfile, ['id', 'revision', 'vendorId', 'productId', 'usagePage', 'usage', 'reportId']);
  if (!isSignal(owner) || !scope || !Object.values(scope).every(identifier) || Object.keys(scope).length !== 3 || !reviewed ||
    Object.keys(reviewed).length !== 7 || !identifier(reviewed.id) || !integer(reviewed.revision, 65535) || reviewed.revision === 0 ||
    !['vendorId', 'productId', 'usagePage', 'usage'].every(key => integer(reviewed[key], 65535)) || !integer(reviewed.reportId, 255) ||
    typeof now !== 'function' || typeof authorize !== 'function' || !runtime) throw new TypeError('Invalid HID switch options');
  const profile = Object.freeze({ ...reviewed }) as unknown as BrowserHidSwitchProfile;
  const ownedScope = Object.freeze({ ...scope }) as unknown as BrowserHidSwitchOptions['scope'];
  const env = options.environment ?? defaults();
  if (!env.target || !env.document || ['secureContext', 'userActivation', 'hidden', 'focused', 'policy'].some(key => typeof env[key as keyof BrowserHidSwitchEnvironment] !== 'function')) throw new TypeError('Invalid HID switch environment');
  const instance = ++instances; if (!Number.isSafeInteger(instance)) throw new RangeError('HID switch identity exhausted');
  const selections = new WeakMap<object, Choice>(), raw = new Set<Promise<void>>(), removals: (() => void)[] = [];
  let closed = isAborted(owner), revision = 0, attempts = 0, generation = 0, lastClock = -1, dispatching = false, cleanupFailed = false, admitting = false;
  let choice: Choice | undefined, active: Active | undefined, cancelPending: (() => void) | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined, waitTimer: ReturnType<typeof setTimeout> | undefined, closePromise: Promise<void> | undefined;
  let reason: BrowserHidSwitchSnapshot['reason'] = closed ? 'closed' : 'idle', cleanupPending = 0;
  function usable(): boolean { return !closed && !cleanupFailed && !isAborted(owner); }
  function track<T>(work: () => T | Promise<T>): Promise<T> {
    let settled!: () => void; const token = new Promise<void>(resolve => { settled = resolve; }); raw.add(token);
    let result: Promise<T>; try { result = Promise.resolve(work()); } catch (error) { result = Promise.reject(error); }
    return result.finally(() => { raw.delete(token); settled(); });
  }
  function time(): number {
    let at: number; try { at = now(); } catch { retire('invalid'); return NaN; }
    if (!Number.isFinite(at) || at < 0 || at < lastClock) { retire('invalid'); return NaN; } lastClock = at; return at;
  }
  function clean(a: Active): void {
    if (!a.opening || !a.openSettled || a.closingIssued) return;
    a.closingIssued = true; cleanupPending++; const work = track(async () => { try { await a.choice.native.close(); } catch { cleanupFailed = true; reason = 'unavailable'; }
      finally { cleanupPending--; } }); a.closing = work;
    // The reservation exists before close(), including a synchronous reentrant call.
    void work.catch(() => { cleanupFailed = true; });
  }
  function retire(why: BrowserHidSwitchFailure): void {
    revision++; const old = active; active = undefined; choice = undefined; reason = why;
    const cancel = cancelPending; cancelPending = undefined; cancel?.();
    if (expiry !== undefined) { clearTimeout(expiry); expiry = undefined; }
    if (waitTimer !== undefined) { clearTimeout(waitTimer); waitTimer = undefined; }
    for (const dispose of removals.splice(0)) { try { dispose(); } catch { cleanupFailed = true; } }
    if (old?.source) { const handle = old.source; old.source = undefined; try { runtime.unregister(handle); } catch { cleanupFailed = true; } }
    if (old) clean(old);
  }
  function logical<T>(): Logical<T> {
    let resolve!: (value: BrowserHidSwitchResult<T>) => void, done = false;
    const promise = new Promise<BrowserHidSwitchResult<T>>(finish => { resolve = finish; });
    const finish = (value: BrowserHidSwitchResult<T>) => { if (done) return; done = true; cancelPending = undefined;
      if (waitTimer !== undefined) { clearTimeout(waitTimer); waitTimer = undefined; } resolve(value); };
    cancelPending = () => finish(no(closed ? 'closed' : reason as BrowserHidSwitchFailure));
    waitTimer = setTimeout(() => { waitTimer = undefined; retire('timeout'); }, BROWSER_HID_SWITCH_LIMITS.logicalNativeWaitMs);
    return { promise, finish };
  }
  function watch(value: AbortSignal, callback: () => void): void {
    const dispose = () => { Reflect.apply(remove, value, ['abort', callback]); }; removals.push(dispose);
    Reflect.apply(add, value, ['abort', callback, { once: true }]);
  }
  function install(turn: number): void {
    const alive = () => usable() && revision === turn;
    const blur = () => retire('unfocused'), page = () => retire('stopped'), hide = () => { if (env.hidden()) retire('hidden'); };
    const disconnect = (event: Event) => { const device = (event as Event & { device?: unknown }).device; if (choice && device === choice.native) retire('lost'); };
    const rows = [[env.target, 'blur', blur], [env.target, 'pagehide', page], [env.document, 'visibilitychange', hide],
      ...(env.hid ? [[env.hid, 'disconnect', disconnect] as const] : [])] as const;
    for (const [target, name, callback] of rows) {
      const dispose = () => { target.removeEventListener(name, callback); }; removals.push(dispose);
      try { target.addEventListener(name, callback); } finally { if (!alive()) dispose(); }
      if (!alive()) return;
    }
    watch(owner, () => { closed = true; retire('closed'); });
  }
  function available(requireActivation: boolean): BrowserHidSwitchFailure | undefined {
    if (!env.hid || typeof env.hid.requestDevice !== 'function') return 'unsupported';
    if (env.secureContext() !== true) return 'unavailable'; if (env.hidden()) return 'hidden'; if (!env.focused()) return 'unfocused';
    if (env.policy() === 'denied') return 'denied'; if (requireActivation && env.userActivation() !== true) return 'activation-required';
  }
  function current(a: Active): boolean {
    if (active !== a || choice !== a.choice || !a.grant) return false;
    if (!usable() || isAborted(a.grant.signal)) { retire(isAborted(a.grant.signal) ? 'cancelled' : 'closed'); return false; }
    const at = time();
    if (active === a && (!usable() || isAborted(a.grant.signal) || at >= a.grant.expiresAt)) retire(isAborted(a.grant.signal) ? 'cancelled' : 'expired');
    return usable() && active === a && choice === a.choice && !isAborted(a.grant.signal) && at < a.grant.expiresAt;
  }
  function arm(a: Active): void {
    if (!current(a)) { if (active === a) retire('expired'); return; }
    const at = time(); if (!current(a)) return;
    const id = setTimeout(() => { expiry = undefined; if (active !== a) return; const at = time();
      if (active !== a) return; if (at >= a.grant!.expiresAt) retire('expired'); else arm(a); }, Math.max(1, a.grant!.expiresAt - at));
    if (active === a && usable()) expiry = id; else clearTimeout(id);
  }
  function report(a: Active, event: Event): void {
    if (dispatching || !current(a)) { if (active === a) retire('expired'); return; } dispatching = true;
    try {
      const native = event as Event & { device?: unknown; reportId?: unknown; data?: unknown };
      const device = native.device, id = native.reportId, data = native.data;
      if (device !== a.choice.native || id !== profile.reportId || Reflect.apply(byteLength, data, []) !== 1) throw no('invalid');
      const byte = Reflect.apply(readByte, data, [0]) as number; if (byte !== 0 && byte !== 1) throw no('invalid');
      if (layout(a.choice.native, profile) !== a.choice.layout || a.choice.native.opened !== true) throw no('lost');
      const unavailable = available(false); if (!current(a)) return; if (unavailable) { retire(unavailable); return; }
      const at = time(); if (!current(a)) return;
      a.tokens = Math.min(4, a.tokens + Math.max(0, at - a.tokenTime) * 20 / 1000); a.tokenTime = at;
      if (a.tokens < 1 || a.reports >= 600) { retire('quota'); return; } a.tokens--; a.reports++;
      const provenance: JsonObject = Object.freeze({ provider: 'browser-hid-switch', samplePoint: 'javascript-report-receipt',
        captureTimeKnown: false, clockMappingEstablished: false, connectionGeneration: a.choice.generation, profileId: profile.id, profileRevision: profile.revision });
      const publish = runtime.publish, clockDomain = runtime.clockDomain; if (!current(a) || !a.source) return;
      const result = Reflect.apply(publish, runtime, [a.source, { channel: 'switch-0', active: byte === 1 }, { timestamp: at, clockDomain,
        quality: 'valid', provenance, operationId: String(++a.operation), deadline: Math.min(at + 100, a.grant!.expiresAt) }]) as ReturnType<DeviceRuntime['publish']>;
      if (!current(a)) return; if (!result.ok || result.value.accepted === 0 || result.value.rejected > 0) retire('unavailable');
    } catch (error) { if (active === a) retire(failure(error)); } finally { dispatching = false; }
  }
  function enter(): BrowserHidSwitchFailure | undefined {
    if (!usable()) return closed || isAborted(owner) ? 'closed' : 'unavailable';
    if (admitting || raw.size || active || dispatching) return 'busy'; if (attempts >= 64) return 'quota'; attempts++; admitting = true;
  }
  async function drain(): Promise<void> { while (raw.size) await Promise.all([...raw]); }
  return Object.freeze({
    availability() { const turn = revision; if (!usable()) return no('closed'); try {
      const unavailable = available(false), policy = env.policy(); return usable() && revision === turn ? unavailable ? no(unavailable) : yes(Object.freeze({ policy })) : no('cancelled');
    } catch { return no('unavailable'); } },
    choose() {
      const denied = enter(); if (denied) return Promise.resolve(no(denied));
      try {
      // Reserve admission before retiring old listeners: their teardown can reenter.
      const admittedRevision = revision; retire('stopped');
      if (!usable() || revision !== admittedRevision + 1) return Promise.resolve(no('cancelled'));
      const turn = revision, operation = logical<BrowserHidSwitchSelection>(); reason = 'idle';
      let success: BrowserHidSwitchSelection | undefined;
      void track(async () => {
        try {
          install(turn); const unavailable = available(true), at = time();
          if (!usable() || turn !== revision) return; if (unavailable) { retire(unavailable); return; } if (!Number.isFinite(at)) return;
          const manager = env.hid!, requestDevice = manager.requestDevice;
          if (!usable() || turn !== revision) return;
          const devices = await Reflect.apply(requestDevice, manager, [Object.freeze({ filters: Object.freeze([Object.freeze({ vendorId: profile.vendorId, productId: profile.productId, usagePage: profile.usagePage, usage: profile.usage })]) })]) as readonly NativeHidSwitchDevice[];
          if (!usable() || turn !== revision) return;
          if (!Array.isArray(devices) || devices.length !== 1) { retire(Array.isArray(devices) && devices.length === 0 ? 'cancelled' : 'unsupported'); return; }
          const native = devices[0]!; if (native.opened !== false) { retire('busy'); return; }
          const pin = layout(native, profile), stamp = time(); if (!usable() || turn !== revision || !Number.isFinite(stamp)) return;
          const connection = ++generation, handle = Object.freeze({}), input = getInputProfile('app:switch/1').capabilities[0]!;
          const device = parseDeviceDescriptor({ schemaVersion: 1, id: `browser-hid-switch-${instance}:connection-${connection}`, label: 'Selected switch input', revision: profile.revision,
            adapter: { id: 'app:browser-hid-switch', version: '1.0.0' }, runtime: { platform: 'browser-hid-api' }, capabilities: [{ ...input,
              value: { type: 'record', fields: { channel: { type: 'enum', values: ['switch-0'] }, active: { type: 'boolean' } } }, delivery: { mode: 'reliable', maxAgeMs: 100 } }] });
          if (!usable() || turn !== revision) return; choice = { handle, native, generation: connection, layout: pin, device }; selections.set(handle, choice);
          reason = 'selected'; success = handle;
        } catch (error) { if (revision === turn) retire(failure(error)); }
      }).then(() => { if (success && usable() && revision === turn) operation.finish(yes(success)); }).catch(() => { if (revision === turn) retire('unavailable'); }); return operation.promise;
      } finally { admitting = false; }
    },
    start(handle: BrowserHidSwitchSelection, request: Readonly<{ purpose: string }>) {
      const denied = enter(); if (denied) return Promise.resolve(no(denied));
      try {
      // Closed-field parsing can execute Proxy traps, so capacity is already reserved.
      const turn = revision;
      const selected = handle && typeof handle === 'object' ? selections.get(handle) : undefined, intent = fields(request, ['purpose']);
      if (!usable() || revision !== turn) return Promise.resolve(no('cancelled'));
      if (!selected || selected !== choice || !intent || !identifier(intent.purpose)) return Promise.resolve(no('invalid'));
      const operation = logical<BrowserHidSwitchActivation>();
      const a: Active = { choice: selected, opening: false, openSettled: false, reports: 0, tokens: 4, tokenTime: 0, operation: 0 }; active = a;
      let success: BrowserHidSwitchActivation | undefined;
      void track(async () => {
        try {
          const at = time(); if (!usable() || revision !== turn || active !== a) return;
          const unavailable = available(false); if (unavailable) { retire(unavailable); return; }
          if (layout(selected.native, profile) !== selected.layout || selected.native.opened !== false) { retire('lost'); return; }
          if (!usable() || revision !== turn || active !== a) return;
          const captureRequest: BrowserHidSwitchCaptureRequest = Object.freeze({ ...ownedScope, purpose: intent.purpose as string, deviceId: selected.device.id,
            connectionGeneration: selected.generation, profile, resources: Object.freeze([Object.freeze({ capabilityId: 'switch', operation: 'subscribe' })]) });
          const approved = fields(await authorize(captureRequest), ['request', 'signal', 'expiresAt']);
          if (!usable() || revision !== turn || active !== a) return;
          const fresh = time(); if (!usable() || revision !== turn || active !== a) return;
          if (!approved || approved.request !== captureRequest || !isSignal(approved.signal) || isAborted(approved.signal) || !Number.isFinite(approved.expiresAt) ||
            (approved.expiresAt as number) <= fresh || (approved.expiresAt as number) > at + 30000) { retire('denied'); return; }
          a.grant = Object.freeze({ signal: approved.signal, expiresAt: approved.expiresAt as number }); a.tokenTime = fresh;
          watch(a.grant.signal, () => retire('cancelled')); if (!current(a)) return; arm(a); if (!current(a)) return;
          // Authority and exact observed layout are rechecked after approval and before opening.
          if (layout(selected.native, profile) !== selected.layout || selected.native.opened !== false) { retire('lost'); return; }
          const open = selected.native.open; if (!current(a)) return; a.opening = true;
          try { await Reflect.apply(open, selected.native, []); } finally { a.openSettled = true; if (active !== a) clean(a); }
          if (!current(a)) { if (active === a) retire('expired'); return; }
          if (nativeOpened(selected.native) !== true || layout(selected.native, profile) !== selected.layout) { retire('lost'); return; }
          if (!current(a)) return;
          const callback = (event: Event) => report(a, event), dispose = () => { selected.native.removeEventListener('inputreport', callback); }; removals.push(dispose);
          try { selected.native.addEventListener('inputreport', callback); } finally { if (active !== a || !usable()) dispose(); }
          if (!current(a)) return;
          const register = runtime.registerSource; if (!current(a)) return;
          const source = Reflect.apply(register, runtime, [{ device: selected.device, capability: 'switch' }]) as EndpointHandle;
          if (!current(a)) { runtime.unregister(source); return; } a.source = source;
          const setReadiness = runtime.setReadiness; if (!current(a)) return;
          const ready = Reflect.apply(setReadiness, runtime, [source, 'available', a.grant.expiresAt]) as ReturnType<DeviceRuntime['setReadiness']>; if (!ready.ok) { retire('unavailable'); return; }
          if (!current(a)) return; reason = 'active';
          success = Object.freeze({ device: selected.device, source, connectionGeneration: selected.generation });
        } catch (error) { if (active === a) retire(failure(error)); }
        finally { if (active !== a) clean(a); }
      }).then(() => { if (success && current(a)) operation.finish(yes(success)); }).catch(() => { if (active === a) retire('unavailable'); }); return operation.promise;
      } catch { return Promise.resolve(no('invalid')); } finally { admitting = false; }
    },
    stop() { retire('stopped'); },
    sweep() { if (active && !current(active)) retire('expired'); else if (!usable() && (choice || active || raw.size)) retire('closed'); },
    snapshot() { return Object.freeze({ phase: closed ? 'closed' : active?.source ? 'active' : admitting || raw.size ? 'pending' : choice ? 'selected' : 'idle', reason,
      attempts, connectionGeneration: generation, activeSources: active?.source ? 1 : 0, listeners: removals.length, nativePending: raw.size,
      cleanupPending, cleanupFailed, timerArmed: expiry !== undefined, waitTimerArmed: waitTimer !== undefined, reports: active?.reports ?? 0 }); },
    close() { if (closePromise) return closePromise;
      let finish!: () => void; closePromise = new Promise<void>(resolve => { finish = resolve; });
      closed = true; retire('closed'); void drain().then(finish); return closePromise; },
  });
}
