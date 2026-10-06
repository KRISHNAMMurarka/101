import { getInputProfile, parseDeviceDescriptor } from '@101/device-model';
import type { DeviceDescriptor, JsonObject } from '@101/device-model';
import type { DeviceRuntime, EndpointHandle } from '@101/device-runtime';

export const BROWSER_SERIAL_SWITCH_LIMITS = Object.freeze({ activePorts: 1, sources: 1, resources: 1, filters: 1, attempts: 64,
  selectionAuthorizerOpenPending: 1, readerLocks: 1, nativeReadPending: 1, nativeCancelPending: 1, nativeClosePending: 1,
  captureMs: 30000, logicalNativeWaitMs: 5000, readWaitMs: 500, chunkBytes: 32, chunks: 600, frames: 600, payloadBytes: 600,
  maxHz: 20, burstFrames: 4, callerReliablePending: 8, listeners: 6, expiryTimers: 1, nativeWaitTimers: 1, readTimers: 1 });
const openOptions = Object.freeze({ baudRate: 9600, dataBits: 8 as const, stopBits: 1 as const, parity: 'none' as const, bufferSize: 256, flowControl: 'none' as const });
export type BrowserSerialSwitchFailure = 'invalid' | 'unsupported' | 'unavailable' | 'activation-required' | 'denied' | 'busy' |
  'closed' | 'lost' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'cancelled' | 'quota' | 'timeout';
export type BrowserSerialSwitchResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: BrowserSerialSwitchFailure }>;
export interface BrowserSerialSwitchProfile {
  readonly id: string; readonly revision: number; readonly usbVendorId: number; readonly usbProductId: number;
}
/** Minimal native Serial port; supplied ports are trusted software seams, never physical qualification. */
export interface NativeSerialSwitchPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null; readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): Readonly<{ usbVendorId?: number; usbProductId?: number }>;
  open(options: typeof openOptions): Promise<void>; close(): Promise<void>;
}
export interface NativeSerialSwitchManager extends EventTarget {
  requestPort(options: Readonly<{ filters: readonly Readonly<{ usbVendorId: number; usbProductId: number }>[] }>): Promise<NativeSerialSwitchPort>;
}
export interface BrowserSerialSwitchEnvironment {
  readonly serial?: NativeSerialSwitchManager;
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly secureContext: () => boolean; readonly userActivation: () => boolean;
  readonly hidden: () => boolean; readonly focused: () => boolean; readonly policy: () => 'allowed' | 'denied' | 'unknown';
}
export interface BrowserSerialSwitchSelection { readonly browserSerialSwitchSelection?: never }
export interface BrowserSerialSwitchCaptureRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly deviceId: string; readonly connectionGeneration: number; readonly profile: BrowserSerialSwitchProfile;
  readonly resources: readonly Readonly<{ capabilityId: 'switch'; operation: 'subscribe' }>[]; readonly openOptions: typeof openOptions;
}
export interface BrowserSerialSwitchCaptureGrant {
  readonly request: BrowserSerialSwitchCaptureRequest; readonly signal: AbortSignal; readonly expiresAt: number;
}
export interface BrowserSerialSwitchActivation { readonly device: DeviceDescriptor; readonly source: EndpointHandle; readonly connectionGeneration: number }
export interface BrowserSerialSwitchOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly reviewedProfile: BrowserSerialSwitchProfile; readonly now: () => number;
  readonly authorizeCapture: (request: BrowserSerialSwitchCaptureRequest) => BrowserSerialSwitchCaptureGrant | undefined | Promise<BrowserSerialSwitchCaptureGrant | undefined>;
  readonly environment?: BrowserSerialSwitchEnvironment;
}
export interface BrowserSerialSwitchSnapshot {
  readonly phase: 'idle' | 'pending' | 'selected' | 'active' | 'closed'; readonly reason: BrowserSerialSwitchFailure | 'idle' | 'selected' | 'active';
  readonly attempts: number; readonly connectionGeneration: number; readonly activeSources: number; readonly listeners: number;
  readonly nativePending: number; readonly cleanupPending: number; readonly cleanupFailed: boolean; readonly cancelPending: number; readonly closePending: number;
  readonly timerArmed: boolean; readonly waitTimerArmed: boolean; readonly readTimerArmed: boolean;
  readonly frames: number; readonly chunks: number; readonly payloadBytes: number; readonly readPending: number; readonly readerLocks: number;
}
export interface BrowserSerialSwitchProvider {
  availability(): BrowserSerialSwitchResult<Readonly<{ policy: 'allowed' | 'denied' | 'unknown' }>>;
  choose(): Promise<BrowserSerialSwitchResult<BrowserSerialSwitchSelection>>;
  start(selection: BrowserSerialSwitchSelection, request: Readonly<{ purpose: string }>): Promise<BrowserSerialSwitchResult<BrowserSerialSwitchActivation>>;
  stop(): void; sweep(): void; snapshot(): BrowserSerialSwitchSnapshot; close(): Promise<void>;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
const streams = typeof ReadableStream === 'undefined' ? undefined : { getReader: ReadableStream.prototype.getReader,
  locked: Object.getOwnPropertyDescriptor(ReadableStream.prototype, 'locked')!.get!, read: ReadableStreamDefaultReader.prototype.read,
  cancel: ReadableStreamDefaultReader.prototype.cancel, release: ReadableStreamDefaultReader.prototype.releaseLock };
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const length = Object.getOwnPropertyDescriptor(typed, 'length')!.get!, tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const set = Uint8Array.prototype.set;
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
const no = (reason: BrowserSerialSwitchFailure): BrowserSerialSwitchResult<never> => Object.freeze({ ok: false, reason });
const yes = <T>(value: T): BrowserSerialSwitchResult<T> => Object.freeze({ ok: true, value });
function failure(error: unknown): BrowserSerialSwitchFailure {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && ['SecurityError', 'NotAllowedError'].includes(error.name)) return 'denied';
  const own = fields(error, ['ok', 'reason']); return own?.ok === false && ['invalid', 'unsupported', 'lost'].includes(own.reason as string) ? own.reason as BrowserSerialSwitchFailure : 'unavailable';
}
function defaults(): BrowserSerialSwitchEnvironment {
  const doc = typeof document === 'undefined' ? undefined : document;
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { serial?: NativeSerialSwitchManager };
  const target = typeof window === 'undefined' ? new EventTarget() : window;
  return { ...(nav?.serial ? { serial: nav.serial } : {}), target, document: doc ?? new EventTarget(), secureContext: () => globalThis.isSecureContext === true,
    userActivation: () => nav?.userActivation?.isActive === true, hidden: () => doc?.hidden !== false, focused: () => doc?.hasFocus() === true,
    policy() { const policy = (doc as (Document & { permissionsPolicy?: { allowsFeature(name: string): boolean } }) | undefined)?.permissionsPolicy;
      return policy && typeof policy.allowsFeature === 'function' ? policy.allowsFeature('serial') ? 'allowed' : 'denied' : 'unknown'; } };
}
function nativeReadable(port: NativeSerialSwitchPort): ReadableStream<Uint8Array> | null { return port.readable; }
function info(port: NativeSerialSwitchPort, profile: BrowserSerialSwitchProfile): string {
  const method = port.getInfo, observed = fields(Reflect.apply(method, port, []), ['usbVendorId', 'usbProductId']);
  if (!observed || observed.usbVendorId !== profile.usbVendorId || observed.usbProductId !== profile.usbProductId) throw no('unsupported');
  return `${profile.usbVendorId}:${profile.usbProductId}`;
}
function copyChunk(value: unknown, remaining: number): Uint8Array {
  if (Reflect.apply(tag, value, []) !== 'Uint8Array') throw no('invalid');
  const count = Reflect.apply(length, value, []) as number;
  if (count < 1 || count > 32 || count > remaining) throw no('quota');
  const copied = new Uint8Array(count); Reflect.apply(set, copied, [value]);
  for (const byte of copied) if (byte !== 0 && byte !== 1) throw no('invalid'); return copied;
}
let instances = 0;
interface Choice { handle: BrowserSerialSwitchSelection; native: NativeSerialSwitchPort; generation: number; info: string; device: DeviceDescriptor }
interface Active { choice: Choice; source?: EndpointHandle; grant?: Readonly<{ signal: AbortSignal; expiresAt: number }>;
  opening: boolean; openSettled: boolean; acquiringReader: boolean; reader?: ReadableStreamDefaultReader<Uint8Array>; readTask?: Promise<void>;
  closingIssued?: boolean; frames: number; chunks: number; payloadBytes: number; readPending: number; tokens: number; tokenTime: number; operation: number }
interface Logical<T> { promise: Promise<BrowserSerialSwitchResult<T>>; finish(value: BrowserSerialSwitchResult<T>): void }

export function createBrowserSerialSwitchProvider(options: BrowserSerialSwitchOptions): BrowserSerialSwitchProvider {
  const runtime = options.runtime, owner = options.ownerSignal, now = options.now, authorize = options.authorizeCapture;
  const scope = fields(options.scope, ['principalId', 'applicationId', 'sessionId']), reviewed = fields(options.reviewedProfile, ['id', 'revision', 'usbVendorId', 'usbProductId']);
  if (!isSignal(owner) || !scope || !Object.values(scope).every(identifier) || Object.keys(scope).length !== 3 || !reviewed ||
    Object.keys(reviewed).length !== 4 || !identifier(reviewed.id) || !integer(reviewed.revision, 65535) || reviewed.revision === 0 ||
    !['usbVendorId', 'usbProductId'].every(key => integer(reviewed[key], 65535)) ||
    typeof now !== 'function' || typeof authorize !== 'function' || !runtime) throw new TypeError('Invalid Serial switch options');
  const profile = Object.freeze({ ...reviewed }) as unknown as BrowserSerialSwitchProfile;
  const ownedScope = Object.freeze({ ...scope }) as unknown as BrowserSerialSwitchOptions['scope'];
  const env = options.environment ?? defaults();
  if (!env.target || !env.document || ['secureContext', 'userActivation', 'hidden', 'focused', 'policy'].some(key => typeof env[key as keyof BrowserSerialSwitchEnvironment] !== 'function')) throw new TypeError('Invalid Serial switch environment');
  const instance = ++instances; if (!Number.isSafeInteger(instance)) throw new RangeError('Serial switch identity exhausted');
  const selections = new WeakMap<object, Choice>(), raw = new Set<Promise<void>>(), removals: (() => void)[] = [];
  let closed = isAborted(owner), revision = 0, attempts = 0, generation = 0, lastClock = -1, cleanupFailed = false, admitting = false;
  let choice: Choice | undefined, active: Active | undefined, cancelPending: (() => void) | undefined;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined, waitTimer: ReturnType<typeof setTimeout> | undefined, closePromise: Promise<void> | undefined;
  let reason: BrowserSerialSwitchSnapshot['reason'] = closed ? 'closed' : 'idle', cleanupPending = 0;
  let ownedReaders = 0, pendingReads = 0, pendingCancels = 0, pendingCloses = 0;
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
    if (!a.opening || !a.openSettled || a.acquiringReader || a.closingIssued) return;
    a.closingIssued = true; cleanupPending++;
    void track(async () => {
      try {
        if (a.reader) {
          // Native cancel may resolve the pending read before its own underlying
          // cancellation settles. Retain both, then release the exact owned lock.
          pendingCancels++; try { await Reflect.apply(streams!.cancel, a.reader, []); } catch { cleanupFailed = true; } finally { pendingCancels--; }
          if (a.readTask) await a.readTask;
          try { Reflect.apply(streams!.release, a.reader, []); a.reader = undefined; ownedReaders--; } catch { cleanupFailed = true; }
        }
        pendingCloses++; try { await a.choice.native.close(); } finally { pendingCloses--; }
      } catch { cleanupFailed = true; reason = 'unavailable'; } finally { cleanupPending--; }
    }).catch(() => { cleanupFailed = true; });
  }
  function retire(why: BrowserSerialSwitchFailure): void {
    revision++; const old = active; active = undefined; choice = undefined; reason = why;
    const cancel = cancelPending; cancelPending = undefined; cancel?.();
    if (expiry !== undefined) { clearTimeout(expiry); expiry = undefined; }
    if (waitTimer !== undefined) { clearTimeout(waitTimer); waitTimer = undefined; }
    if (readTimer !== undefined) { clearTimeout(readTimer); readTimer = undefined; }
    for (const dispose of removals.splice(0)) { try { dispose(); } catch { cleanupFailed = true; } }
    if (old?.source) { const handle = old.source; old.source = undefined; try { runtime.unregister(handle); } catch { cleanupFailed = true; } }
    if (old) clean(old);
  }
  function logical<T>(): Logical<T> {
    let resolve!: (value: BrowserSerialSwitchResult<T>) => void, done = false;
    const promise = new Promise<BrowserSerialSwitchResult<T>>(finish => { resolve = finish; });
    const finish = (value: BrowserSerialSwitchResult<T>) => { if (done) return; done = true; cancelPending = undefined;
      if (waitTimer !== undefined) { clearTimeout(waitTimer); waitTimer = undefined; } resolve(value); };
    cancelPending = () => finish(no(closed ? 'closed' : reason as BrowserSerialSwitchFailure));
    waitTimer = setTimeout(() => { waitTimer = undefined; retire('timeout'); }, BROWSER_SERIAL_SWITCH_LIMITS.logicalNativeWaitMs);
    return { promise, finish };
  }
  function watch(value: AbortSignal, callback: () => void): void {
    const dispose = () => { Reflect.apply(remove, value, ['abort', callback]); }; removals.push(dispose);
    Reflect.apply(add, value, ['abort', callback, { once: true }]);
  }
  function install(turn: number): void {
    const alive = () => usable() && revision === turn;
    const blur = () => retire('unfocused'), page = () => retire('stopped'), hide = () => { if (env.hidden()) retire('hidden'); };
    const disconnect = (event: Event) => { const port = (event as Event & { port?: unknown }).port; if (choice && (event.target === choice.native || port === choice.native)) retire('lost'); };
    const rows = [[env.target, 'blur', blur], [env.target, 'pagehide', page], [env.document, 'visibilitychange', hide],
      ...(env.serial ? [[env.serial, 'disconnect', disconnect] as const] : [])] as const;
    for (const [target, name, callback] of rows) {
      const dispose = () => { target.removeEventListener(name, callback); }; removals.push(dispose);
      try { target.addEventListener(name, callback); } finally { if (!alive()) dispose(); }
      if (!alive()) return;
    }
    watch(owner, () => { closed = true; retire('closed'); });
  }
  function available(requireActivation: boolean): BrowserSerialSwitchFailure | undefined {
    if (!env.serial || typeof env.serial.requestPort !== 'function' || !streams) return 'unsupported';
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
  async function readLoop(a: Active): Promise<void> {
    try {
      while (current(a) && a.reader) {
        if (a.chunks >= 600 || a.payloadBytes >= 600) { retire('quota'); break; }
        a.readPending = 1; pendingReads++; readTimer = setTimeout(() => { readTimer = undefined; if (active === a) retire('timeout'); }, 500);
        let result: ReadableStreamReadResult<Uint8Array>;
        try { if (!current(a)) break; result = await Reflect.apply(streams!.read, a.reader, []) as ReadableStreamReadResult<Uint8Array>; }
        finally { a.readPending = 0; pendingReads--; if (readTimer !== undefined) { clearTimeout(readTimer); readTimer = undefined; } }
        if (!current(a)) break; if (result.done) { retire('lost'); break; }
        const chunk = copyChunk(result.value, 600 - a.payloadBytes), at = time(); if (!current(a)) break;
        if (info(a.choice.native, profile) !== a.choice.info) { retire('lost'); break; }
        const unavailable = available(false); if (!current(a)) break; if (unavailable) { retire(unavailable); break; }
        a.tokens = Math.min(4, a.tokens + Math.max(0, at - a.tokenTime) * 20 / 1000); a.tokenTime = at;
        if (chunk.length > a.tokens || a.frames + chunk.length > 600 || a.payloadBytes + chunk.length > 600) { retire('quota'); break; }
        a.tokens -= chunk.length; a.chunks++; a.payloadBytes += chunk.length;
        const provenance: JsonObject = Object.freeze({ provider: 'browser-serial-switch', samplePoint: 'javascript-read-receipt', captureTimeKnown: false,
          clockMappingEstablished: false, connectionGeneration: a.choice.generation, profileId: profile.id, profileRevision: profile.revision });
        for (const byte of chunk) {
          const publish = runtime.publish, clockDomain = runtime.clockDomain; if (!current(a) || !a.source) break;
          const result = Reflect.apply(publish, runtime, [a.source, { channel: 'switch-0', active: byte === 1 }, { timestamp: at, clockDomain, quality: 'valid',
            provenance, operationId: String(++a.operation), deadline: Math.min(at + 100, a.grant!.expiresAt) }]) as ReturnType<DeviceRuntime['publish']>;
          a.frames++; if (!current(a)) break; if (!result.ok || result.value.accepted === 0 || result.value.rejected > 0) { retire('unavailable'); break; }
        }
      }
    } catch (error) { if (active === a) retire(failure(error)); }
  }
  function enter(): BrowserSerialSwitchFailure | undefined {
    if (!usable()) return closed || isAborted(owner) ? 'closed' : 'unavailable';
    if (admitting || raw.size || active) return 'busy'; if (attempts >= 64) return 'quota'; attempts++; admitting = true;
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
      const turn = revision, operation = logical<BrowserSerialSwitchSelection>(); reason = 'idle';
      let success: BrowserSerialSwitchSelection | undefined;
      void track(async () => {
        try {
          install(turn); const unavailable = available(true), at = time();
          if (!usable() || turn !== revision) return; if (unavailable) { retire(unavailable); return; } if (!Number.isFinite(at)) return;
          const manager = env.serial!, requestPort = manager.requestPort;
          if (!usable() || turn !== revision) return;
          const native = await Reflect.apply(requestPort, manager, [Object.freeze({ filters: Object.freeze([Object.freeze({ usbVendorId: profile.usbVendorId, usbProductId: profile.usbProductId })]) })]) as NativeSerialSwitchPort;
          if (!usable() || turn !== revision) return;
          if (!native || native.readable !== null || native.writable !== null) { retire('busy'); return; }
          const pin = info(native, profile), stamp = time(); if (!usable() || turn !== revision || !Number.isFinite(stamp)) return;
          const connection = ++generation, handle = Object.freeze({}), input = getInputProfile('app:switch/1').capabilities[0]!;
          const device = parseDeviceDescriptor({ schemaVersion: 1, id: `browser-serial-switch-${instance}:connection-${connection}`, label: 'Selected switch input', revision: profile.revision,
            adapter: { id: 'app:browser-serial-switch', version: '1.0.0' }, runtime: { platform: 'browser-serial-api' }, capabilities: [{ ...input,
              value: { type: 'record', fields: { channel: { type: 'enum', values: ['switch-0'] }, active: { type: 'boolean' } } }, delivery: { mode: 'reliable', maxAgeMs: 100 } }] });
          if (!usable() || turn !== revision) return; choice = { handle, native, generation: connection, info: pin, device }; selections.set(handle, choice);
          reason = 'selected'; success = handle;
        } catch (error) { if (revision === turn) retire(failure(error)); }
      }).then(() => { if (success && usable() && revision === turn) operation.finish(yes(success)); }).catch(() => { if (revision === turn) retire('unavailable'); }); return operation.promise;
      } finally { admitting = false; }
    },
    start(handle: BrowserSerialSwitchSelection, request: Readonly<{ purpose: string }>) {
      const denied = enter(); if (denied) return Promise.resolve(no(denied));
      try {
      // Closed-field parsing can execute Proxy traps, so capacity is already reserved.
      const turn = revision;
      const selected = handle && typeof handle === 'object' ? selections.get(handle) : undefined, intent = fields(request, ['purpose']);
      if (!usable() || revision !== turn) return Promise.resolve(no('cancelled'));
      if (!selected || selected !== choice || !intent || !identifier(intent.purpose)) return Promise.resolve(no('invalid'));
      const operation = logical<BrowserSerialSwitchActivation>();
      const a: Active = { choice: selected, opening: false, openSettled: false, acquiringReader: false, frames: 0, chunks: 0, payloadBytes: 0, readPending: 0, tokens: 4, tokenTime: 0, operation: 0 }; active = a;
      let success: BrowserSerialSwitchActivation | undefined;
      void track(async () => {
        try {
          const at = time(); if (!usable() || revision !== turn || active !== a) return;
          const unavailable = available(false); if (unavailable) { retire(unavailable); return; }
          if (info(selected.native, profile) !== selected.info || selected.native.readable !== null || selected.native.writable !== null) { retire('lost'); return; }
          if (!usable() || revision !== turn || active !== a) return;
          const captureRequest: BrowserSerialSwitchCaptureRequest = Object.freeze({ ...ownedScope, purpose: intent.purpose as string, deviceId: selected.device.id,
            connectionGeneration: selected.generation, profile, openOptions, resources: Object.freeze([Object.freeze({ capabilityId: 'switch', operation: 'subscribe' })]) });
          const approved = fields(await authorize(captureRequest), ['request', 'signal', 'expiresAt']);
          if (!usable() || revision !== turn || active !== a) return;
          const fresh = time(); if (!usable() || revision !== turn || active !== a) return;
          if (!approved || approved.request !== captureRequest || !isSignal(approved.signal) || isAborted(approved.signal) || !Number.isFinite(approved.expiresAt) ||
            (approved.expiresAt as number) <= fresh || (approved.expiresAt as number) > at + 30000) { retire('denied'); return; }
          a.grant = Object.freeze({ signal: approved.signal, expiresAt: approved.expiresAt as number }); a.tokenTime = fresh;
          watch(a.grant.signal, () => retire('cancelled')); if (!current(a)) return; arm(a); if (!current(a)) return;
          // Authority and exact observed port metadata are rechecked after approval and before opening.
          if (info(selected.native, profile) !== selected.info || selected.native.readable !== null || selected.native.writable !== null) { retire('lost'); return; }
          const open = selected.native.open; if (!current(a)) return; a.opening = true;
          try { await Reflect.apply(open, selected.native, [openOptions]); } finally { a.openSettled = true; if (active !== a) clean(a); }
          if (!current(a)) { if (active === a) retire('expired'); return; }
          const readable = nativeReadable(selected.native);
          if (!readable || Reflect.apply(streams!.locked, readable, []) || info(selected.native, profile) !== selected.info) { retire('lost'); return; }
          if (!current(a)) return;
          a.acquiringReader = true;
          try { a.reader = Reflect.apply(streams!.getReader, readable, []) as ReadableStreamDefaultReader<Uint8Array>; ownedReaders++; }
          finally { a.acquiringReader = false; if (active !== a) clean(a); }
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
      }).then(() => { if (success && current(a)) { operation.finish(yes(success));
        // The caller's activation reaction installs its separately approved route
        // before any already-buffered native byte is read. No additional queue.
        void Promise.resolve().then(() => { if (current(a)) a.readTask = track(() => readLoop(a)); });
      } }).catch(() => { if (active === a) retire('unavailable'); }); return operation.promise;
      } catch { return Promise.resolve(no('invalid')); } finally { admitting = false; }
    },
    stop() { retire('stopped'); },
    sweep() { if (active && !current(active)) retire('expired'); else if (!usable() && (choice || active || raw.size)) retire('closed'); },
    snapshot() { return Object.freeze({ phase: closed ? 'closed' : active?.source ? 'active' : admitting || raw.size ? 'pending' : choice ? 'selected' : 'idle', reason,
      attempts, connectionGeneration: generation, activeSources: active?.source ? 1 : 0, listeners: removals.length, nativePending: raw.size,
      cleanupPending, cleanupFailed, cancelPending: pendingCancels, closePending: pendingCloses, timerArmed: expiry !== undefined, waitTimerArmed: waitTimer !== undefined, readTimerArmed: readTimer !== undefined, frames: active?.frames ?? 0,
      chunks: active?.chunks ?? 0, payloadBytes: active?.payloadBytes ?? 0, readPending: pendingReads, readerLocks: ownedReaders }); },
    close() { if (closePromise) return closePromise;
      let finish!: () => void; closePromise = new Promise<void>(resolve => { finish = resolve; });
      closed = true; retire('closed'); void drain().then(finish); return closePromise; },
  });
}
