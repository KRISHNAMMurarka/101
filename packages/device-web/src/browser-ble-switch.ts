import { getInputProfile, parseDeviceDescriptor } from '@101/device-model';
import type { DeviceDescriptor, JsonObject } from '@101/device-model';
import type { DeliveryContext, DeviceRuntime, EndpointHandle, Observation } from '@101/device-runtime';

export const BROWSER_BLE_SWITCH_LIMITS = Object.freeze({ devices: 1, sources: 1, characteristics: 1, attempts: 64,
  captureMs: 30000, logicalNativeWaitMs: 5000, frameBytes: 1, maxHz: 20, burstFrames: 4, framesPerCapture: 600,
  reliablePending: 8, rawOperationTokens: 3, nativeDataAndCleanupPending: 2, listeners: 7, expiryTimers: 1, nativeWaitTimers: 1,
  outputSinks: 1, outputPending: 1, outputAttempts: 32, outputMaxHz: 2, outputMaxAgeMs: 100, outputRecords: 16, outputListeners: 2 });
export type BrowserBleSwitchFailure = 'invalid' | 'unsupported' | 'unavailable' | 'activation-required' | 'denied' | 'busy' |
  'closed' | 'lost' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'cancelled' | 'quota' | 'timeout';
export type BrowserBleSwitchResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: BrowserBleSwitchFailure }>;
export interface BrowserBleSwitchProfile { readonly id: string; readonly revision: number; readonly serviceUUID: string; readonly characteristicUUID: string;
  /** Reviewed absolute-setting grammar; absence preserves notification-only behavior. Never a grant. */
  readonly writeFormat?: 'boolean-byte/1' }
/** Native-shaped trusted ports; software implementations do not qualify a BLE peripheral. */
export interface NativeBleSwitchProperties {
  readonly authenticatedSignedWrites: boolean; readonly broadcast: boolean; readonly indicate: boolean; readonly notify: boolean; readonly read: boolean;
  readonly reliableWrite: boolean; readonly writableAuxiliaries: boolean; readonly write: boolean; readonly writeWithoutResponse: boolean;
}
export interface NativeBleSwitchCharacteristic extends EventTarget {
  readonly service: NativeBleSwitchService; readonly uuid: string; readonly properties: NativeBleSwitchProperties; readonly value?: DataView;
  startNotifications(): Promise<NativeBleSwitchCharacteristic>; stopNotifications(): Promise<NativeBleSwitchCharacteristic>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
}
export interface NativeBleSwitchService {
  readonly device: NativeBleSwitchDevice; readonly uuid: string; readonly isPrimary: boolean;
  getCharacteristic(uuid: string): Promise<NativeBleSwitchCharacteristic>;
}
export interface NativeBleSwitchServer {
  readonly device: NativeBleSwitchDevice; readonly connected: boolean;
  connect(): Promise<NativeBleSwitchServer>; getPrimaryService(uuid: string): Promise<NativeBleSwitchService>;
  /** Native GATT disconnect is synchronous; trusted ports may expose held cleanup. */
  disconnect(): void | Promise<void>;
}
export interface NativeBleSwitchDevice extends EventTarget { readonly gatt?: NativeBleSwitchServer }
export interface NativeBleSwitchManager {
  requestDevice(options: Readonly<{ filters: readonly Readonly<{ services: readonly string[] }>[] }>): Promise<NativeBleSwitchDevice>;
}
export interface BrowserBleSwitchEnvironment {
  readonly bluetooth?: NativeBleSwitchManager;
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly secureContext: () => boolean; readonly userActivation: () => boolean; readonly hidden: () => boolean;
  readonly focused: () => boolean; readonly policy: () => 'allowed' | 'denied' | 'unknown';
}
export interface BrowserBleSwitchSelection { readonly browserBleSwitchSelection?: never }
export interface BrowserBleSwitchCaptureRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly deviceId: string; readonly connectionGeneration: number; readonly profile: BrowserBleSwitchProfile;
  readonly resources: readonly Readonly<{ capabilityId: 'switch'; operation: 'subscribe' }>[];
}
export interface BrowserBleSwitchCaptureGrant { readonly request: BrowserBleSwitchCaptureRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface BrowserBleSwitchActivation { readonly source: EndpointHandle; readonly device: DeviceDescriptor; readonly connectionGeneration: number }
export interface BrowserBleSwitchOutputReport { readonly support: 'available' | 'unsupported'; readonly format: 'boolean-byte/1'; readonly physical: 'unverified' }
export interface BrowserBleSwitchOutputRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly activation: BrowserBleSwitchActivation; readonly deviceId: string; readonly connectionGeneration: number; readonly profile: BrowserBleSwitchProfile;
  readonly format: 'boolean-byte/1'; readonly resources: readonly Readonly<{ capabilityId: 'switch-setting'; operation: 'invoke' }>[];
}
export interface BrowserBleSwitchOutputGrant { readonly request: BrowserBleSwitchOutputRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface BrowserBleSwitchOutputActivation { readonly sink: EndpointHandle; readonly device: DeviceDescriptor; readonly expiresAt: number; readonly connectionGeneration: number }
/** Trusted host snapshot from the SAME real Connection and its exact running OperationRecord.
 * Numeric limits only narrow authority; missing snapshots deny native issuance. */
export interface BrowserBleSwitchOutputDeliveryLimits { readonly context: DeliveryContext; readonly expiresAt: number; readonly maxAgeMs: number; readonly maxHz: number }
export interface BrowserBleSwitchOutputRecord {
  readonly operationId: string; readonly routeId: string;
  readonly outcome: 'cancelled' | 'expired' | 'rate-limited' | 'dispatched' | 'api-returned' | 'api-rejected' | 'uncertain';
  readonly effect: 'none' | 'dispatched'; readonly apiReturned: boolean; readonly physical: 'unverified';
}
export interface BrowserBleSwitchOutputStatus {
  readonly state: 'idle' | 'bound' | 'retired' | BrowserBleSwitchOutputRecord['outcome']; readonly attempts: number;
  readonly activeSinks: number; readonly rawPending: number; readonly bindingPending: boolean; readonly listeners: number;
  readonly unconfirmedCleanup: boolean; readonly records: readonly BrowserBleSwitchOutputRecord[];
}
export interface BrowserBleSwitchOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal; readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly reviewedProfile: BrowserBleSwitchProfile; readonly now: () => number;
  readonly authorizeCapture: (request: BrowserBleSwitchCaptureRequest) => BrowserBleSwitchCaptureGrant | undefined | Promise<BrowserBleSwitchCaptureGrant | undefined>;
  readonly authorizeOutput?: (request: BrowserBleSwitchOutputRequest) => BrowserBleSwitchOutputGrant | undefined;
  readonly outputDeliveryLimits?: (context: DeliveryContext) => BrowserBleSwitchOutputDeliveryLimits | undefined;
  readonly environment?: BrowserBleSwitchEnvironment;
}
export interface BrowserBleSwitchSnapshot {
  readonly phase: 'idle' | 'pending' | 'selected' | 'active' | 'closed'; readonly reason: BrowserBleSwitchFailure | 'idle' | 'selected' | 'active';
  readonly attempts: number; readonly connectionGeneration: number; readonly activeSources: number; readonly listeners: number;
  readonly rawPending: number; readonly nativePending: number; readonly cleanupPending: number; readonly cleanupFailed: boolean;
  readonly timerArmed: boolean; readonly waitTimerArmed: boolean; readonly frames: number;
}
export interface BrowserBleSwitchProvider {
  availability(): BrowserBleSwitchResult<Readonly<{ policy: 'allowed' | 'denied' | 'unknown' }>>;
  choose(): Promise<BrowserBleSwitchResult<BrowserBleSwitchSelection>>;
  start(selection: BrowserBleSwitchSelection, request: Readonly<{ purpose: string }>): Promise<BrowserBleSwitchResult<BrowserBleSwitchActivation>>;
  inspectOutput(activation: BrowserBleSwitchActivation): BrowserBleSwitchResult<BrowserBleSwitchOutputReport>;
  bindOutput(activation: BrowserBleSwitchActivation, request: Readonly<{ purpose: string }>): BrowserBleSwitchResult<BrowserBleSwitchOutputActivation>;
  outputStatus(): BrowserBleSwitchOutputStatus;
  stop(): void; sweep(): void; snapshot(): BrowserBleSwitchSnapshot; close(): Promise<void>;
}
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
const eventTarget = Object.getOwnPropertyDescriptor(Event.prototype, 'target')!.get!;
const viewLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!, viewByte = DataView.prototype.getUint8;
const promiseThen = Promise.prototype.then;
const isAborted = (signal: AbortSignal): boolean => Reflect.apply(aborted, signal, []) as boolean;
function signal(value: unknown): value is AbortSignal { try { isAborted(value as AbortSignal); return true; } catch { return false; } }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const result: Record<string, unknown> = Object.create(null), descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]!)) return; result[key] = descriptors[key]!.value;
  }
  return result;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,79}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const no = (reason: BrowserBleSwitchFailure): BrowserBleSwitchResult<never> => Object.freeze({ ok: false, reason });
const yes = <T>(value: T): BrowserBleSwitchResult<T> => Object.freeze({ ok: true, value });
function failure(error: unknown): BrowserBleSwitchFailure {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && ['SecurityError', 'NotAllowedError'].includes(error.name)) return 'denied';
  const own = fields(error, ['ok', 'reason']);
  return own?.ok === false && ['invalid', 'unsupported', 'lost', 'busy', 'cancelled'].includes(own.reason as string) ? own.reason as BrowserBleSwitchFailure : 'unavailable';
}
function defaults(): BrowserBleSwitchEnvironment {
  const doc = typeof document === 'undefined' ? undefined : document;
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { bluetooth?: NativeBleSwitchManager };
  return { ...(nav?.bluetooth ? { bluetooth: nav.bluetooth } : {}), target: typeof window === 'undefined' ? new EventTarget() : window, document: doc ?? new EventTarget(),
    secureContext: () => globalThis.isSecureContext === true, userActivation: () => nav?.userActivation?.isActive === true,
    hidden: () => doc?.hidden !== false, focused: () => doc?.hasFocus() === true,
    policy() { const policy = (doc as (Document & { permissionsPolicy?: { allowsFeature(name: string): boolean } }) | undefined)?.permissionsPolicy;
      return policy && typeof policy.allowsFeature === 'function' ? policy.allowsFeature('bluetooth') ? 'allowed' : 'denied' : 'unknown'; } };
}
interface Choice { handle: BrowserBleSwitchSelection; native: NativeBleSwitchDevice; server: NativeBleSwitchServer; generation: number; device: DeviceDescriptor }
interface Active {
  choice: Choice; turn: number; grant?: Readonly<{ expiresAt: number; signal: AbortSignal }>; source?: EndpointHandle;
  service?: NativeBleSwitchService; characteristic?: NativeBleSwitchCharacteristic;
  connectIssued: boolean; connectSettled: boolean; notifyIssued: boolean; notifySettled: boolean; cleanupIssued: boolean;
  writeSettled: boolean;
  frames: number; tokens: number; tokenTime: number; operation: number;
}
interface OutputBinding { active: Active; activation: BrowserBleSwitchActivation; signal: AbortSignal; expiresAt: number; retired: boolean;
  sink?: EndpointHandle; dispose?: () => void; routeId?: string }
type OutputRow = { -readonly [Key in keyof BrowserBleSwitchOutputRecord]: BrowserBleSwitchOutputRecord[Key] };
interface OutputOperation { binding: OutputBinding; row: OutputRow; issued: boolean; cancelled: boolean; unknown: boolean; dispose?: () => void }
let instances = 0;
export function createBrowserBleSwitchProvider(configuration: BrowserBleSwitchOptions): BrowserBleSwitchProvider {
  const options = fields(configuration, ['runtime', 'ownerSignal', 'scope', 'reviewedProfile', 'now', 'authorizeCapture', 'authorizeOutput', 'outputDeliveryLimits', 'environment']);
  const scope = fields(options?.scope, ['principalId', 'applicationId', 'sessionId']), reviewed = fields(options?.reviewedProfile, ['id', 'revision', 'serviceUUID', 'characteristicUUID', 'writeFormat']);
  if (!options || !signal(options.ownerSignal) || !options.runtime || typeof options.now !== 'function' || typeof options.authorizeCapture !== 'function' ||
    !scope || Object.keys(scope).length !== 3 || !Object.values(scope).every(identifier) || !reviewed || ![4, 5].includes(Object.keys(reviewed).length) || !identifier(reviewed.id) ||
    !Number.isSafeInteger(reviewed.revision) || (reviewed.revision as number) < 1 || (reviewed.revision as number) > 65535 || !uuid(reviewed.serviceUUID) || !uuid(reviewed.characteristicUUID)) throw new TypeError('Invalid BLE switch options');
  if (reviewed.writeFormat !== undefined && reviewed.writeFormat !== 'boolean-byte/1' || options.authorizeOutput !== undefined && typeof options.authorizeOutput !== 'function' ||
    options.outputDeliveryLimits !== undefined && typeof options.outputDeliveryLimits !== 'function') throw new TypeError('Invalid BLE output options');
  const runtime = options.runtime as DeviceRuntime, owner = options.ownerSignal, now = options.now as () => number;
  const authorize = options.authorizeCapture as BrowserBleSwitchOptions['authorizeCapture'];
  const authorizeOutput = options.authorizeOutput as BrowserBleSwitchOptions['authorizeOutput'];
  const outputDeliveryLimits = options.outputDeliveryLimits as BrowserBleSwitchOptions['outputDeliveryLimits'];
  const profile = Object.freeze({ ...reviewed }) as unknown as BrowserBleSwitchProfile, ownedScope = Object.freeze({ ...scope }) as unknown as BrowserBleSwitchOptions['scope'];
  const environment = fields(options.environment ?? defaults(), ['bluetooth', 'target', 'document', 'secureContext', 'userActivation', 'hidden', 'focused', 'policy']);
  if (!environment?.target || !environment.document || ['secureContext', 'userActivation', 'hidden', 'focused', 'policy'].some(key => typeof environment[key] !== 'function')) throw new TypeError('Invalid BLE switch environment');
  const env = Object.freeze({ ...environment }) as unknown as BrowserBleSwitchEnvironment;
  const instance = ++instances; if (!Number.isSafeInteger(instance)) throw new RangeError('BLE switch identity exhausted');
  const selections = new WeakMap<object, Choice>(), activations = new WeakMap<object, Active>(), raw = new Set<Promise<void>>(), removals: (() => void)[] = [];
  let closed = isAborted(owner), revision = 0, attempts = 0, generation = 0, lastClock = -1, readingClock = false;
  let admitting = false, dispatching = false, checking = false, cleanupFailed = false, cleanupPending = 0, nativePending = 0;
  let choice: Choice | undefined, active: Active | undefined, cancelPending: (() => void) | undefined;
  let retirement: Promise<void> | undefined, finishRetirement: (() => void) | undefined, retirementDepth = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined, waitTimer: ReturnType<typeof setTimeout> | undefined, closePromise: Promise<void> | undefined;
  let reason: BrowserBleSwitchSnapshot['reason'] = closed ? 'closed' : 'idle';
  let outputBinding: OutputBinding | undefined, outputOperation: OutputOperation | undefined, bindingPending = false, outputAttempts = 0, lastWrite = -Infinity, outputUnknown = false;
  let outputState: BrowserBleSwitchOutputStatus['state'] = 'idle'; const outputRows: OutputRow[] = [];
  const usable = () => !closed && !cleanupFailed && !isAborted(owner);
  function track<T>(work: () => T | Promise<T>, native = false): Promise<T> {
    let finish!: () => void; const token = new Promise<void>(resolve => { finish = resolve; }); raw.add(token); if (native) nativePending++;
    let result: Promise<T>; try { result = Promise.resolve(work()); } catch (error) { result = Promise.reject(error); }
    return result.finally(() => { if (native) nativePending--; raw.delete(token); finish(); });
  }
  function time(): number {
    if (readingClock) { retire('invalid'); return NaN; } readingClock = true; let at: number;
    try { at = now(); } catch { retire('invalid'); return NaN; } finally { readingClock = false; }
    if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - 60000 || at < lastClock) { retire('invalid'); return NaN; }
    lastClock = at; return at;
  }
  // The tracked cleanup chain owns these actual native returns, without a second raw token.
  async function cleanupNative<T>(work: () => T | Promise<T>): Promise<T> {
    nativePending++; try { return await work(); } finally { nativePending--; }
  }
  function clean(a: Active): void {
    if (!a.connectIssued || !a.connectSettled || a.notifyIssued && !a.notifySettled || !a.writeSettled || a.cleanupIssued) return;
    a.cleanupIssued = true; cleanupPending++;
    void track(async () => {
      try {
        if (a.notifyIssued && a.characteristic) {
          await cleanupNative(() => { const stop = a.characteristic!.stopNotifications;
            return Reflect.apply(stop, a.characteristic!, []) as Promise<NativeBleSwitchCharacteristic>; });
        }
      } catch { cleanupFailed = true; reason = 'unavailable'; }
      finally {
        try { await cleanupNative(() => { const disconnect = a.choice.server.disconnect;
          return Reflect.apply(disconnect, a.choice.server, []) as void | Promise<void>; }); }
        catch { cleanupFailed = true; reason = 'unavailable'; }
        finally { cleanupPending--; }
      }
    }).catch(() => { cleanupFailed = true; reason = 'unavailable'; });
  }
  function retire(why: BrowserBleSwitchFailure): void {
    // Release/dispose callbacks may close the provider before cleanup has been issued.
    // Publish this finite synchronous phase so reentrant close also waits for its tail.
    if (!retirement) retirement = new Promise<void>(resolve => { finishRetirement = resolve; });
    retirementDepth++;
    try {
      revision++; const old = active; active = undefined; choice = undefined; reason = why;
      retireOutput(why === 'expired' ? 'expired' : 'cancelled');
      const cancel = cancelPending; cancelPending = undefined; cancel?.();
      if (expiry !== undefined) { clearTimeout(expiry); expiry = undefined; }
      if (waitTimer !== undefined) { clearTimeout(waitTimer); waitTimer = undefined; }
      for (const dispose of removals.splice(0)) { try { dispose(); } catch { cleanupFailed = true; } }
      if (old?.source) { const source = old.source; old.source = undefined; try { runtime.unregister(source); } catch { cleanupFailed = true; } }
      if (old) clean(old);
    } finally {
      if (--retirementDepth === 0) { const finish = finishRetirement; retirement = undefined; finishRetirement = undefined; finish?.(); }
    }
  }
  function logical<T>() {
    let resolve!: (value: BrowserBleSwitchResult<T>) => void, done = false;
    const promise = new Promise<BrowserBleSwitchResult<T>>(finish => { resolve = finish; });
    const finish = (value: BrowserBleSwitchResult<T>) => { if (done) return; done = true; cancelPending = undefined;
      if (waitTimer !== undefined) { clearTimeout(waitTimer); waitTimer = undefined; } resolve(value); };
    cancelPending = () => finish(no(closed ? 'closed' : reason as BrowserBleSwitchFailure));
    waitTimer = setTimeout(() => { waitTimer = undefined; retire('timeout'); }, BROWSER_BLE_SWITCH_LIMITS.logicalNativeWaitMs);
    return { promise, finish };
  }
  const owned = (a: Active) => usable() && active === a && choice === a.choice && revision === a.turn && !!a.grant && !isAborted(a.grant.signal);
  function current(a: Active): boolean {
    if (!owned(a)) { if (active === a) retire(!usable() ? 'closed' : 'cancelled'); return false; }
    const at = time(); if (!owned(a)) return false;
    if (!(at < a.grant!.expiresAt)) { retire('expired'); return false; } return owned(a);
  }
  function read<T>(a: Active, value: () => T): T { const result = value(); if (!current(a)) throw no('cancelled'); return result; }
  function facts(a: Active, connected = true): void {
    if (read(a, () => a.choice.native.gatt) !== a.choice.server || read(a, () => a.choice.server.device) !== a.choice.native || read(a, () => a.choice.server.connected) !== connected) throw no('lost');
    if (a.service && (read(a, () => a.service!.device) !== a.choice.native || read(a, () => a.service!.uuid) !== profile.serviceUUID || read(a, () => a.service!.isPrimary) !== true)) throw no('unsupported');
    if (a.characteristic) {
      if (read(a, () => a.characteristic!.service) !== a.service || read(a, () => a.characteristic!.uuid) !== profile.characteristicUUID) throw no('unsupported');
      const properties = read(a, () => a.characteristic!.properties);
      if (!properties || typeof properties !== 'object') throw no('unsupported');
      for (const key of ['authenticatedSignedWrites', 'broadcast', 'indicate', 'notify', 'read', 'reliableWrite', 'writableAuxiliaries', 'write', 'writeWithoutResponse'] as const) {
        const value = read(a, () => properties[key]); if (typeof value !== 'boolean' || key === 'notify' && !value) throw no('unsupported');
      }
    }
  }
  function available(turn: number, activation: boolean): BrowserBleSwitchFailure | undefined {
    if (!env.bluetooth || typeof env.bluetooth.requestDevice !== 'function') return 'unsupported';
    if (!usable() || revision !== turn) return 'cancelled';
    const checks = [['secureContext', 'unavailable', true], ['hidden', 'hidden', false], ['focused', 'unfocused', true]] as const;
    for (const [key, why, expected] of checks) { const value = env[key](); if (!usable() || revision !== turn) return 'cancelled'; if (value !== expected) return why; }
    const policy = env.policy(); if (!usable() || revision !== turn) return 'cancelled';
    if (!['allowed', 'denied', 'unknown'].includes(policy)) return 'invalid'; if (policy === 'denied') return 'denied';
    if (activation) { const value = env.userActivation(); if (!usable() || revision !== turn) return 'cancelled'; if (value !== true) return 'activation-required'; }
  }
  function listen(target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, name: string, callback: EventListener, turn: number): void {
    const dispose = () => { target.removeEventListener(name, callback); }; removals.push(dispose);
    try { const register = target.addEventListener; if (usable() && revision === turn) Reflect.apply(register, target, [name, callback]); }
    finally { if (!usable() || revision !== turn) dispose(); }
  }
  function watch(value: AbortSignal, callback: () => void): void {
    const dispose = () => { Reflect.apply(remove, value, ['abort', callback]); }; removals.push(dispose);
    Reflect.apply(add, value, ['abort', callback, { once: true }]);
  }
  function install(turn: number): void {
    for (const [target, name, callback] of [[env.target, 'blur', () => retire('unfocused')], [env.target, 'pagehide', () => retire('stopped')],
      [env.document, 'visibilitychange', () => { if (env.hidden()) retire('hidden'); }]] as const) {
      listen(target, name, callback, turn); if (!usable() || revision !== turn) return;
    }
    watch(owner, () => { closed = true; retire('closed'); });
  }
  function arm(a: Active): void {
    if (!current(a)) return; const at = time(); if (!current(a)) return;
    if (expiry !== undefined) { clearTimeout(expiry); expiry = undefined; }
    const until = outputBinding?.active === a ? Math.min(a.grant!.expiresAt, outputBinding.expiresAt) : a.grant!.expiresAt;
    const timer = setTimeout(() => { expiry = undefined; if (active !== a) return; const fresh = time(); if (!owned(a)) return;
      if (fresh >= a.grant!.expiresAt) retire('expired');
      else { if (outputBinding?.active === a && fresh >= outputBinding.expiresAt) retireOutput('expired'); if (owned(a)) arm(a); }
    }, Math.max(1, until - at));
    if (owned(a)) expiry = timer; else clearTimeout(timer);
  }
  function reserveOutput(): () => void {
    let finish!: () => void, done = false; const token = new Promise<void>(resolve => { finish = resolve; }); raw.add(token);
    return () => { if (done) return; done = true; raw.delete(token); finish(); };
  }
  function direct(a: Active, at: number, binding?: OutputBinding, contextSignal?: AbortSignal): boolean {
    return owned(a) && Number.isFinite(at) && at < a.grant!.expiresAt && (!binding || outputBinding === binding && !binding.retired && !isAborted(binding.signal) && at < binding.expiresAt) &&
      (!contextSignal || !isAborted(contextSignal));
  }
  function issuedActivation(handle: BrowserBleSwitchActivation): Active | undefined {
    const a = handle && typeof handle === 'object' ? activations.get(handle) : undefined;
    return a && a === active && a.source && current(a) ? a : undefined;
  }
  function outputMethod(a: Active): ((value: BufferSource) => Promise<void>) | undefined {
    if (profile.writeFormat !== 'boolean-byte/1') return;
    facts(a); const properties = read(a, () => a.characteristic!.properties);
    if (read(a, () => properties.write) !== true) return;
    const method = read(a, () => a.characteristic!.writeValueWithResponse);
    return typeof method === 'function' ? method : undefined;
  }
  function retireOutput(outcome: 'cancelled' | 'expired'): void {
    const binding = outputBinding; outputBinding = undefined;
    if (binding) {
      binding.retired = true; const sink = binding.sink; binding.sink = undefined;
      try { binding.dispose?.(); } catch { cleanupFailed = true; } binding.dispose = undefined;
      if (sink) { try { if (!runtime.unregister(sink).ok) cleanupFailed = true; } catch { cleanupFailed = true; } }
    }
    const operation = outputOperation;
    if (operation && (!binding || operation.binding === binding)) {
      operation.cancelled = true; operation.row.outcome = operation.issued ? 'uncertain' : outcome; outputState = operation.row.outcome;
      try { operation.dispose?.(); } catch { cleanupFailed = true; } operation.dispose = undefined;
      if (waitTimer !== undefined) { clearTimeout(waitTimer); waitTimer = undefined; }
      // Revoked authority cannot dispatch a reset. Issued effect remains uncertain.
      if (operation.issued && active === operation.binding.active) retire(outcome === 'expired' ? 'expired' : 'cancelled');
    } else if (binding) outputState = 'retired';
  }
  function outputEntry(): BrowserBleSwitchFailure | undefined {
    if (!usable()) return closed || isAborted(owner) ? 'closed' : 'unavailable';
    if (bindingPending || outputOperation || admitting || dispatching || checking || retirement || raw.size) return 'busy';
  }
  function inspectOutput(handle: BrowserBleSwitchActivation): BrowserBleSwitchResult<BrowserBleSwitchOutputReport> {
    const denied = outputEntry(); if (denied) return no(denied); bindingPending = true; const settled = reserveOutput();
    try { const a = issuedActivation(handle); if (!a) return no('invalid'); const method = outputMethod(a), at = time();
      if (!direct(a, at)) return no('cancelled'); return yes(Object.freeze({ support: method ? 'available' : 'unsupported', format: 'boolean-byte/1', physical: 'unverified' }));
    } catch (error) { return no(failure(error)); } finally { bindingPending = false; settled(); }
  }
  function outputDescriptor(a: Active): DeviceDescriptor {
    return parseDeviceDescriptor({ schemaVersion: 1, id: a.choice.device.id + ':output', label: 'Selected switch setting', revision: profile.revision,
      adapter: { id: 'app:browser-ble-switch', version: '1.0.0' }, runtime: { platform: 'browser-bluetooth-api' }, capabilities: [{
        id: 'switch-setting', semantic: 'app:ble-switch-setting/1', schemaVersion: 1, kind: 'command', value: { type: 'boolean' },
        permissions: ['invoke'], ownership: { mode: 'exclusive' }, delivery: { mode: 'reliable', maxAgeMs: 100 } }] });
  }
  function bindOutput(handle: BrowserBleSwitchActivation, intent: Readonly<{ purpose: string }>): BrowserBleSwitchResult<BrowserBleSwitchOutputActivation> {
    const denied = outputEntry(); if (denied) return no(denied); if (outputBinding) return no('busy'); if (outputAttempts >= 32) return no('quota');
    bindingPending = true; outputAttempts++; const settled = reserveOutput(); let binding: OutputBinding | undefined;
    try {
      const a = issuedActivation(handle), selected = fields(intent, ['purpose']); if (!a || !selected || Object.keys(selected).length !== 1 || !identifier(selected.purpose)) return no('invalid');
      if (!outputMethod(a)) return no('unsupported'); if (typeof authorizeOutput !== 'function') return no('denied');
      const request: BrowserBleSwitchOutputRequest = Object.freeze({ ...ownedScope, purpose: selected.purpose, activation: handle, deviceId: a.choice.device.id,
        connectionGeneration: a.choice.generation, profile, format: 'boolean-byte/1', resources: Object.freeze([Object.freeze({ capabilityId: 'switch-setting', operation: 'invoke' })]) });
      const grant = fields(authorizeOutput(request), ['request', 'signal', 'expiresAt']), at = time();
      if (!direct(a, at)) return no('cancelled');
      if (!grant || grant.request !== request || !signal(grant.signal) || isAborted(grant.signal) || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) ||
        grant.expiresAt <= at || grant.expiresAt > a.grant!.expiresAt) return no('denied');
      binding = { active: a, activation: handle, signal: grant.signal, expiresAt: grant.expiresAt, retired: false }; outputBinding = binding;
      const exact = binding, callback = () => { if (outputBinding === exact) retireOutput('cancelled'); };
      binding.dispose = () => { Reflect.apply(remove, exact.signal, ['abort', callback]); };
      Reflect.apply(add, binding.signal, ['abort', callback, { once: true }]);
      const device = outputDescriptor(a), register = read(a, () => runtime.registerSink);
      if (!direct(a, time(), binding)) throw no('cancelled');
      const sink = Reflect.apply(register, runtime, [{ device, capability: 'switch-setting', apply: (observation: Observation, context: DeliveryContext) => applyOutput(exact, observation, context),
        release: (_reason: string, context: Readonly<{ routeId: string }>) => { if (outputBinding === exact && (!exact.routeId || exact.routeId === context.routeId)) retireOutput('cancelled'); } }]) as EndpointHandle;
      if (outputBinding !== binding || binding.retired) { try { if (!runtime.unregister(sink).ok) cleanupFailed = true; } catch { cleanupFailed = true; } throw no('cancelled'); }
      binding.sink = sink;
      if (!direct(a, time(), binding) || !runtime.setReadiness(sink, 'available', binding.expiresAt).ok || !direct(a, time(), binding)) throw no('cancelled');
      outputState = 'bound'; arm(a); if (!direct(a, time(), binding)) throw no('cancelled');
      return yes(Object.freeze({ sink, device, expiresAt: binding.expiresAt, connectionGeneration: a.choice.generation }));
    } catch (error) { if (binding && outputBinding === binding) retireOutput('cancelled'); return no(failure(error)); }
    finally { bindingPending = false; settled(); }
  }
  function applyOutput(binding: OutputBinding, observation: Observation, context: DeliveryContext): void | Promise<void> {
    if (!usable() || outputBinding !== binding || binding.retired || bindingPending || outputOperation || outputAttempts >= 32 || raw.size) return;
    outputAttempts++; const settled = reserveOutput();
    const row: OutputRow = { operationId: '', routeId: '', outcome: 'cancelled', effect: 'none', apiReturned: false, physical: 'unverified' };
    const operation: OutputOperation = { binding, row, issued: false, cancelled: false, unknown: false }; outputOperation = operation;
    return (async () => {
      let retained = false;
      try {
        const deliveryContext = fields(context, ['signal', 'routeId', 'generation', 'operationId', 'partition', 'isCurrent', 'reportEvidence']);
        const sample = fields(observation, ['value', 'sequence', 'timestamp', 'receivedAt', 'clockDomain', 'quality', 'provenance', 'source']);
        if (!deliveryContext || !signal(deliveryContext.signal) || typeof deliveryContext.routeId !== 'string' || !identifier(deliveryContext.routeId) ||
          typeof deliveryContext.operationId !== 'string' || !Number.isSafeInteger(Number(deliveryContext.operationId)) || Number(deliveryContext.operationId) <= 0 || String(Number(deliveryContext.operationId)) !== deliveryContext.operationId ||
          typeof deliveryContext.isCurrent !== 'function' || typeof deliveryContext.reportEvidence !== 'function' || !sample || typeof sample.value !== 'boolean' || sample.quality !== 'valid' ||
          typeof sample.timestamp !== 'number' || !Number.isFinite(sample.timestamp) || sample.timestamp < 0 || sample.clockDomain !== runtime.clockDomain) return;
        row.operationId = deliveryContext.operationId; row.routeId = deliveryContext.routeId;
        if (binding.routeId && binding.routeId !== row.routeId) return;
        const contextSignal = deliveryContext.signal, isCurrent = deliveryContext.isCurrent, reportEvidence = deliveryContext.reportEvidence;
        const cancel = () => { if (outputOperation === operation) retireOutput('cancelled'); };
        operation.dispose = () => { Reflect.apply(remove, contextSignal, ['abort', cancel]); };
        Reflect.apply(add, contextSignal, ['abort', cancel, { once: true }]);
        if (!direct(binding.active, time(), binding, contextSignal) || operation.cancelled || !Reflect.apply(isCurrent, context, []) || typeof outputDeliveryLimits !== 'function') return;
        const delivery = fields(outputDeliveryLimits(context), ['context', 'expiresAt', 'maxAgeMs', 'maxHz']);
        if (!delivery || Object.keys(delivery).length !== 4 || delivery.context !== context || typeof delivery.expiresAt !== 'number' || !Number.isFinite(delivery.expiresAt) || delivery.expiresAt < 0 ||
          typeof delivery.maxAgeMs !== 'number' || !Number.isFinite(delivery.maxAgeMs) || delivery.maxAgeMs <= 0 || delivery.maxAgeMs > 100 ||
          typeof delivery.maxHz !== 'number' || !Number.isFinite(delivery.maxHz) || delivery.maxHz <= 0 || delivery.maxHz > 2) return;
        const payload = new Uint8Array(1); payload[0] = sample.value ? 1 : 0;
        const method = outputMethod(binding.active); if (!method) { retireOutput('cancelled'); return; }
        const unavailable = available(binding.active.turn, false); if (unavailable) { retire(unavailable); return; }
        if (!Reflect.apply(isCurrent, context, [])) return;
        // All observer/getter callouts precede this clock. Only intrinsic/private
        // authority and captured numeric caps remain between it and native issuance.
        const at = time(); if (!direct(binding.active, at, binding, contextSignal) || operation.cancelled || outputOperation !== operation) return;
        if (at >= delivery.expiresAt || at < sample.timestamp || at - sample.timestamp > delivery.maxAgeMs) { row.outcome = 'expired'; return; }
        if (at - lastWrite < 1000 / delivery.maxHz) { row.outcome = 'rate-limited'; return; }
        binding.routeId = row.routeId; outputRows.push(row); retained = true; if (outputRows.length > 16) outputRows.shift();
        const deadline = Math.min(at + 5000, binding.expiresAt, binding.active.grant!.expiresAt, delivery.expiresAt, sample.timestamp + delivery.maxAgeMs);
        const expire = () => { waitTimer = undefined; if (outputOperation !== operation || operation.cancelled) return; const fresh = time();
          if (!direct(binding.active, fresh, binding, contextSignal) || fresh >= deadline) retireOutput('expired');
          else waitTimer = setTimeout(expire, Math.max(1, deadline - fresh)); };
        // Bookkeeping is already published even if a native wrapper closes here.
        operation.issued = true; binding.active.writeSettled = false; row.effect = 'dispatched'; row.outcome = 'dispatched'; outputState = 'dispatched'; lastWrite = at;
        try {
          await track(() => {
            let returned: unknown;
            try { returned = Reflect.apply(method, binding.active.characteristic!, [payload]); }
            catch { operation.unknown = true; outputUnknown = true; cleanupFailed = true; row.outcome = 'uncertain'; outputState = 'uncertain'; retire('unavailable'); return new Promise<void>(() => {}); }
            try {
              let resolve!: () => void, reject!: (error: unknown) => void;
              const result = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
              // Native Promise brand check is synchronous. A thenable/undefined
              // return cannot be mistaken for confirmed issued-work settlement.
              Reflect.apply(promiseThen, returned, [resolve, reject]);
              try { Reflect.apply(reportEvidence, context, ['dispatched']); } catch { /* Historical dispatch does not confer authority. */ }
              if (!operation.cancelled && outputOperation === operation) {
                const timer = setTimeout(expire, Math.max(1, deadline - at));
                if (!operation.cancelled && outputOperation === operation) waitTimer = timer; else clearTimeout(timer);
              }
              return result;
            } catch { operation.unknown = true; outputUnknown = true; cleanupFailed = true; row.outcome = 'uncertain'; outputState = 'uncertain'; retire('unavailable'); return new Promise<void>(() => {}); }
          }, true);
          row.apiReturned = true;
          if (!operation.cancelled && outputOperation === operation && Reflect.apply(isCurrent, context, [])) {
            const fresh = time(); if (direct(binding.active, fresh, binding, contextSignal) && fresh < deadline) row.outcome = 'api-returned'; else retireOutput('expired');
          } else if (!operation.cancelled) retireOutput('cancelled');
        } catch { if (!operation.cancelled) row.outcome = 'api-rejected'; }
        finally { if (!operation.unknown) { binding.active.writeSettled = true; if (active !== binding.active) clean(binding.active); } }
      } catch { if (!operation.cancelled) row.outcome = operation.issued ? 'uncertain' : 'cancelled'; }
      finally {
        try { operation.dispose?.(); } catch { cleanupFailed = true; } operation.dispose = undefined;
        if (waitTimer !== undefined) { clearTimeout(waitTimer); waitTimer = undefined; }
        if (outputOperation === operation && !operation.unknown) outputOperation = undefined;
        if (retained || outputBinding === binding) outputState = row.outcome;
        try { if (outputBinding === binding && !binding.retired && active === binding.active) arm(binding.active); }
        finally { settled(); }
      }
    })();
  }
  function notification(a: Active, event: Event): void {
    if (dispatching) return; dispatching = true;
    try {
      if (!current(a) || !a.characteristic || !a.source) return;
      if (Reflect.apply(eventTarget, event, []) !== a.characteristic) throw no('invalid');
      const value = read(a, () => a.characteristic!.value);
      if (Reflect.apply(viewLength, value, []) !== 1) throw no('invalid');
      const byte = Reflect.apply(viewByte, value, [0]) as number; if (byte !== 0 && byte !== 1) throw no('invalid');
      facts(a); const unavailable = available(a.turn, false); if (!current(a)) return; if (unavailable) { retire(unavailable); return; }
      const at = time(); if (!current(a)) return;
      a.tokens = Math.min(4, a.tokens + Math.max(0, at - a.tokenTime) * 20 / 1000); a.tokenTime = at;
      if (a.tokens < 1 || a.frames >= 600) { retire('quota'); return; } a.tokens--; a.frames++;
      const provenance: JsonObject = Object.freeze({ provider: 'browser-ble-switch', samplePoint: 'javascript-notification-receipt', captureTimeKnown: false,
        clockMappingEstablished: false, connectionGeneration: a.choice.generation, profileId: profile.id, profileRevision: profile.revision });
      const publish = read(a, () => runtime.publish), clockDomain = read(a, () => runtime.clockDomain); if (!current(a) || !a.source) return;
      const result = Reflect.apply(publish, runtime, [a.source, { channel: 'switch-0', active: byte === 1 }, { timestamp: at, clockDomain, quality: 'valid', provenance,
        operationId: String(++a.operation), deadline: Math.min(at + 100, a.grant!.expiresAt) }]) as ReturnType<DeviceRuntime['publish']>;
      if (!current(a)) return; if (!result.ok || result.value.accepted === 0 || result.value.rejected > 0) retire('unavailable');
    } catch (error) { if (active === a) retire(failure(error)); } finally { dispatching = false; }
  }
  function enter(): BrowserBleSwitchFailure | undefined {
    if (!usable()) return closed || isAborted(owner) ? 'closed' : 'unavailable';
    if (admitting || checking || retirement || raw.size || active || dispatching) return 'busy'; if (attempts >= 64) return 'quota'; attempts++; admitting = true;
  }
  async function drain() { while (raw.size || retirement) await Promise.all([...raw, ...(retirement ? [retirement] : [])]); }
  return Object.freeze({
    inspectOutput, bindOutput,
    outputStatus() { return Object.freeze({ state: outputState, attempts: outputAttempts, activeSinks: outputBinding?.sink ? 1 : 0, rawPending: outputOperation ? 1 : 0, bindingPending,
      listeners: Number(!!outputBinding?.dispose) + Number(!!outputOperation?.dispose), unconfirmedCleanup: outputUnknown,
      records: Object.freeze(outputRows.map(row => Object.freeze({ ...row }))) }); },
    availability() { if (checking || admitting || retirement) return no('busy'); checking = true; const turn = revision;
      try { if (!usable()) return no('closed'); const denied = available(turn, false);
        if (!usable() || revision !== turn) return no('cancelled'); if (denied) return no(denied);
        const policy = env.policy(); if (!usable() || revision !== turn) return no('cancelled');
        return ['allowed', 'denied', 'unknown'].includes(policy) ? policy === 'denied' ? no('denied') : yes(Object.freeze({ policy })) : no('invalid'); }
      catch { return no('unavailable'); } finally { checking = false; } },
    choose() {
      const denied = enter(); if (denied) return Promise.resolve(no(denied));
      try {
        const before = revision; retire('stopped'); if (!usable() || revision !== before + 1) return Promise.resolve(no('cancelled'));
        const turn = revision, result = logical<BrowserBleSwitchSelection>(); reason = 'idle'; let success: BrowserBleSwitchSelection | undefined;
        void track(async () => {
          try {
            install(turn); if (!usable() || revision !== turn) return;
            const denied = available(turn, true); if (!usable() || revision !== turn) return; if (denied) { retire(denied); return; }
            const at = time(); if (!usable() || revision !== turn || !Number.isFinite(at)) return;
            const manager = env.bluetooth!, requestDevice = manager.requestDevice; if (!usable() || revision !== turn) return;
            const native = await track(() => Reflect.apply(requestDevice, manager, [Object.freeze({ filters: Object.freeze([Object.freeze({ services: Object.freeze([profile.serviceUUID]) })]) })]) as Promise<NativeBleSwitchDevice>, true);
            if (!usable() || revision !== turn) return;
            const server = native?.gatt; if (!usable() || revision !== turn) return;
            if (!server) { retire('unsupported'); return; }
            const serverDevice = server.device; if (!usable() || revision !== turn) return;
            if (serverDevice !== native) { retire('unsupported'); return; }
            const connected = server.connected; if (!usable() || revision !== turn) return;
            if (connected !== false) { retire(connected === true ? 'busy' : 'unsupported'); return; }
            const stamp = time(); if (!usable() || revision !== turn || !Number.isFinite(stamp)) return;
            const connection = ++generation, handle = Object.freeze({}), input = getInputProfile('app:switch/1').capabilities[0]!;
            const device = parseDeviceDescriptor({ schemaVersion: 1, id: `browser-ble-switch-${instance}:connection-${connection}`, label: 'Selected switch input', revision: profile.revision,
              adapter: { id: 'app:browser-ble-switch', version: '1.0.0' }, runtime: { platform: 'browser-bluetooth-api' }, capabilities: [{ ...input,
                value: { type: 'record', fields: { channel: { type: 'enum', values: ['switch-0'] }, active: { type: 'boolean' } } }, delivery: { mode: 'reliable', maxAgeMs: 100 } }] });
            if (!usable() || revision !== turn) return; choice = { handle, native, server, generation: connection, device }; selections.set(handle, choice);
            listen(native, 'gattserverdisconnected', () => retire('lost'), turn); if (!usable() || revision !== turn) return;
            reason = 'selected'; success = handle;
          } catch (error) { if (revision === turn) retire(failure(error)); }
        }).then(() => { if (success && usable() && revision === turn) result.finish(yes(success)); }).catch(() => { if (revision === turn) retire('unavailable'); });
        return result.promise;
      } finally { admitting = false; }
    },
    start(handle: BrowserBleSwitchSelection, intent: Readonly<{ purpose: string }>) {
      const denied = enter(); if (denied) return Promise.resolve(no(denied));
      try {
        const turn = revision, selected = handle && typeof handle === 'object' ? selections.get(handle) : undefined, requestFields = fields(intent, ['purpose']);
        if (!usable() || revision !== turn) return Promise.resolve(no('cancelled'));
        if (!selected || selected !== choice || !requestFields || Object.keys(requestFields).length !== 1 || !identifier(requestFields.purpose)) return Promise.resolve(no('invalid'));
        const result = logical<BrowserBleSwitchActivation>();
        const a: Active = { choice: selected, turn, connectIssued: false, connectSettled: false, notifyIssued: false, notifySettled: false, cleanupIssued: false, writeSettled: true, frames: 0, tokens: 4, tokenTime: 0, operation: 0 }; active = a;
        let success: BrowserBleSwitchActivation | undefined;
        void track(async () => {
          try {
            const began = time(); if (!usable() || revision !== turn || active !== a) return;
            const unavailable = available(turn, false); if (!usable() || revision !== turn || active !== a) return;
            if (unavailable) { retire(unavailable); return; }
            const captureRequest: BrowserBleSwitchCaptureRequest = Object.freeze({ ...ownedScope, purpose: requestFields.purpose as string, deviceId: selected.device.id,
              connectionGeneration: selected.generation, profile, resources: Object.freeze([Object.freeze({ capabilityId: 'switch', operation: 'subscribe' })]) });
            const approved = fields(await authorize(captureRequest), ['request', 'signal', 'expiresAt']);
            if (!usable() || revision !== turn || active !== a) return;
            const fresh = time(); if (!usable() || revision !== turn || active !== a) return;
            if (!approved || approved.request !== captureRequest || !signal(approved.signal) || isAborted(approved.signal) || !Number.isFinite(approved.expiresAt) ||
              (approved.expiresAt as number) <= fresh || (approved.expiresAt as number) > began + 30000) { retire('denied'); return; }
            a.grant = Object.freeze({ signal: approved.signal, expiresAt: approved.expiresAt as number }); a.tokenTime = fresh;
            watch(a.grant.signal, () => retire('cancelled')); if (!current(a)) return; arm(a); if (!current(a)) return; facts(a, false);
            const connect = read(a, () => selected.server.connect); if (!current(a)) return; a.connectIssued = true;
            let server: NativeBleSwitchServer;
            try { server = await track(() => Reflect.apply(connect, selected.server, []) as Promise<NativeBleSwitchServer>, true); }
            finally { a.connectSettled = true; if (active !== a) clean(a); }
            if (!current(a)) return; if (server !== selected.server) throw no('unsupported'); facts(a);
            const getService = read(a, () => server.getPrimaryService);
            const service = await track(() => Reflect.apply(getService, server, [profile.serviceUUID]) as Promise<NativeBleSwitchService>, true);
            if (!current(a)) return; a.service = service; facts(a);
            const getCharacteristic = read(a, () => service.getCharacteristic);
            const characteristic = await track(() => Reflect.apply(getCharacteristic, service, [profile.characteristicUUID]) as Promise<NativeBleSwitchCharacteristic>, true);
            if (!current(a)) return; a.characteristic = characteristic; facts(a);
            const start = read(a, () => characteristic.startNotifications); a.notifyIssued = true;
            let notifying: NativeBleSwitchCharacteristic;
            try { notifying = await track(() => Reflect.apply(start, characteristic, []) as Promise<NativeBleSwitchCharacteristic>, true); }
            finally { a.notifySettled = true; if (active !== a) clean(a); }
            if (!current(a)) return; if (notifying !== characteristic) throw no('unsupported'); facts(a);
            listen(characteristic, 'characteristicvaluechanged', event => notification(a, event), turn); if (!current(a)) return;
            const register = read(a, () => runtime.registerSource), source = Reflect.apply(register, runtime, [{ device: selected.device, capability: 'switch' }]) as EndpointHandle;
            if (!current(a)) { runtime.unregister(source); return; } a.source = source;
            const ready = read(a, () => runtime.setReadiness);
            const readiness = Reflect.apply(ready, runtime, [source, 'available', a.grant.expiresAt]) as ReturnType<DeviceRuntime['setReadiness']>;
            if (!current(a)) return; if (!readiness.ok) { retire('unavailable'); return; } reason = 'active';
            success = Object.freeze({ source, device: selected.device, connectionGeneration: selected.generation });
            activations.set(success, a);
          } catch (error) { if (active === a) retire(failure(error)); }
          finally { if (active !== a) clean(a); }
        }).then(() => { if (success && current(a)) result.finish(yes(success)); }).catch(() => { if (active === a) retire('unavailable'); });
        return result.promise;
      } catch { return Promise.resolve(no('invalid')); } finally { admitting = false; }
    },
    stop() { retire('stopped'); },
    sweep() { if (active) { const a = active; if (current(a) && outputBinding?.active === a && time() >= outputBinding.expiresAt) retireOutput('expired'); } else if (!usable() && (choice || raw.size)) retire('closed'); },
    snapshot() { return Object.freeze({ phase: closed ? 'closed' : active?.source ? 'active' : admitting || raw.size ? 'pending' : choice ? 'selected' : 'idle', reason,
      attempts, connectionGeneration: generation, activeSources: active?.source ? 1 : 0, listeners: removals.length, rawPending: raw.size, nativePending,
      cleanupPending, cleanupFailed, timerArmed: expiry !== undefined, waitTimerArmed: waitTimer !== undefined, frames: active?.frames ?? 0 }); },
    close() { if (closePromise) return closePromise; let finish!: () => void; closePromise = new Promise<void>(resolve => { finish = resolve; });
      closed = true; retire('closed'); void drain().then(finish); return closePromise; },
  });
}
