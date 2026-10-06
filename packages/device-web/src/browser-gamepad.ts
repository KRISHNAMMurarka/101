import { createGamepadDetailProcessor, getInputProfile, parseDeviceDescriptor } from '@101/device-model';
import type { DeviceDescriptor, JsonObject } from '@101/device-model';
import type { DeviceRuntime, EndpointHandle } from '@101/device-runtime';

export const BROWSER_GAMEPAD_LIMITS = Object.freeze({ slots: 8, axes: 16, buttons: 32, attempts: 64,
  maxHz: 60, captureMs: 30000, listeners: 7, queuedSamples: 0, polls: 1800, samplesPerPoll: 33, raf: 1, expiryTimers: 1 });
export type BrowserGamepadFailure = 'invalid' | 'unsupported' | 'unavailable' | 'denied' | 'busy' | 'closed' | 'lost' | 'hidden' | 'unfocused' | 'expired' | 'stopped' | 'cancelled' | 'quota';
export type BrowserGamepadResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: BrowserGamepadFailure }>;
export interface BrowserGamepadInventory { readonly index: number; readonly axes: number; readonly buttons: number }
export interface BrowserGamepadSelection { readonly browserGamepadSelection?: never }
export interface BrowserGamepadCaptureRequest {
  readonly principalId: string; readonly applicationId: string; readonly sessionId: string; readonly purpose: string;
  readonly deviceId: string; readonly selectedIndex: number; readonly connectionGeneration: number;
  readonly axes: number; readonly buttons: number; readonly resources: readonly Readonly<{ capabilityId: 'axes' | 'button'; operation: 'subscribe' }>[];
}
export interface BrowserGamepadCaptureGrant { readonly request: BrowserGamepadCaptureRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface BrowserGamepadActivation { readonly device: DeviceDescriptor; readonly sources: Readonly<Record<string, EndpointHandle>>; readonly connectionGeneration: number }
/** Trusted software seam for deterministic logic fixtures, not native/hardware evidence. */
export interface BrowserGamepadEnvironment {
  readonly getGamepads?: () => readonly (NativePad | null)[];
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number; readonly cancelAnimationFrame: (id: number) => void;
  readonly target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  readonly hidden: () => boolean; readonly focused: () => boolean;
}
type NativePad = Pick<Gamepad, 'id' | 'index' | 'connected' | 'axes' | 'timestamp'> & { readonly buttons: readonly Pick<GamepadButton, 'pressed' | 'value'>[] };
export interface BrowserGamepadOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal;
  readonly scope: Readonly<{ principalId: string; applicationId: string; sessionId: string }>;
  readonly authorizeCapture: (request: BrowserGamepadCaptureRequest) => BrowserGamepadCaptureGrant | undefined;
  /** Same monotonic domain as runtime.clockDomain. Native Gamepad last-update time remains unmapped provenance. */
  readonly now: () => number; readonly environment?: BrowserGamepadEnvironment;
}
export interface BrowserGamepadProvider {
  inspect(): BrowserGamepadResult<readonly BrowserGamepadInventory[]>;
  select(index: number): BrowserGamepadResult<BrowserGamepadSelection>;
  start(selection: BrowserGamepadSelection, request: Readonly<{ purpose: string }>): BrowserGamepadResult<BrowserGamepadActivation>;
  stop(): void; close(): void;
  snapshot(): Readonly<{ phase: 'idle' | 'selected' | 'active' | 'closed'; reason: BrowserGamepadFailure | 'selected' | 'active' | 'idle';
    attempts: number; connectionGeneration: number; activeSources: number; listeners: number; timerArmed: boolean; rafArmed: boolean }>;
}
interface Pad { index: number; id: string; axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[]; timestamp: number }
interface Choice { handle: BrowserGamepadSelection; pad: Pad; generation: number; device: DeviceDescriptor }
interface Activation { choice: Choice; grant: Readonly<{ signal: AbortSignal; expiresAt: number }>; sources: Record<string, EndpointHandle>;
  processor: ReturnType<typeof createGamepadDetailProcessor>; operation: number; polls: number; lastPoll: number; lastNativeTimestamp: number; removeGrant?: () => void }
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
function isAborted(signal: AbortSignal): boolean { return Reflect.apply(aborted, signal, []) as boolean; }
function signal(value: unknown): value is AbortSignal { try { isAborted(value as AbortSignal); return true; } catch { return false; } }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const copied: Record<string, unknown> = Object.create(null), descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key]!)) return; copied[key] = descriptors[key]!.value;
  }
  return copied;
}
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(v);
const no = (reason: BrowserGamepadFailure): BrowserGamepadResult<never> => Object.freeze({ ok: false, reason });
const yes = <T>(value: T): BrowserGamepadResult<T> => Object.freeze({ ok: true, value });
function failure(error: unknown): BrowserGamepadFailure {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && ['SecurityError', 'NotAllowedError'].includes(error.name)) return 'denied';
  const own = fields(error, ['ok', 'reason']);
  return own?.ok === false && ['lost', 'invalid', 'unsupported'].includes(own.reason as string) ? own.reason as BrowserGamepadFailure : 'unavailable';
}
let instance = 0;
function defaults(): BrowserGamepadEnvironment {
  const target = typeof window === 'undefined' ? new EventTarget() : window, doc = typeof document === 'undefined' ? undefined : document;
  return { getGamepads: typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads.bind(navigator) : undefined,
    requestAnimationFrame: callback => globalThis.requestAnimationFrame(callback), cancelAnimationFrame: id => globalThis.cancelAnimationFrame(id),
    target, document: doc ?? new EventTarget(), hidden: () => doc?.hidden !== false, focused: () => doc?.hasFocus() === true };
}
function descriptor(id: string, pad: Pad): DeviceDescriptor {
  const profile = getInputProfile('app:gamepad/1'), capabilities = [];
  if (pad.axes.length) capabilities.push({ ...profile.capabilities[0]!, value: { type: 'array' as const, items: { type: 'scalar' as const, unit: '1', min: -1, max: 1 }, minItems: pad.axes.length, maxItems: pad.axes.length } });
  if (pad.buttons.length) capabilities.push({ ...profile.capabilities[1]!, value: { type: 'record' as const, fields: {
    id: { type: 'enum' as const, values: pad.buttons.map((_, i) => `button-${i}`) }, pressed: { type: 'boolean' as const }, pressure: { type: 'scalar' as const, unit: '1', min: 0, max: 1 } } } });
  return parseDeviceDescriptor({ schemaVersion: 1, id, label: 'Selected browser gamepad', revision: 1,
    adapter: { id: 'app:browser-gamepad', version: '1.0.0' }, runtime: { platform: 'browser-gamepad-api' }, capabilities });
}

/** Browser-observed selection, not physical identity authentication. Browser events,
 * selected slot/id/inventory changes and stop fence its connection generation.
 * Sources carry JavaScript poll observations; Gamepad.timestamp is a last-update
 * report preserved in provenance, not hardware acquisition or clock conversion.
 * Button pressure accompanies real pressed-state edges; continuous analog button
 * samples, touched state, mappings, triggers, hats and haptics are not inferred.
 * Capture consent is independent of every SDK source/consumer resource grant.
 * Native APIs and the injected environment are synchronous trusted host code.
 * Ownership counters do not prove native cleanup when a trusted removal throws. */
export function createBrowserGamepadProvider(input: BrowserGamepadOptions): BrowserGamepadProvider {
  const option = fields(input, ['runtime', 'ownerSignal', 'scope', 'authorizeCapture', 'now', 'environment']);
  const scope = option && fields(option.scope, ['principalId', 'applicationId', 'sessionId']);
  if (!option || !scope || Object.keys(scope).length !== 3 || !Object.values(scope).every(identifier) || !signal(option.ownerSignal) || typeof option.now !== 'function' || typeof option.authorizeCapture !== 'function') throw new TypeError('Invalid browser gamepad owner');
  const runtime = option.runtime as DeviceRuntime, owner = option.ownerSignal, now = option.now as () => number, authorize = option.authorizeCapture as BrowserGamepadOptions['authorizeCapture'];
  if (!runtime || ['registerSource', 'setReadiness', 'unregister', 'publish'].some(key => typeof runtime[key as keyof DeviceRuntime] !== 'function') || !identifier(runtime.clockDomain)) throw new TypeError('Invalid browser gamepad runtime');
  const env = option.environment === undefined ? defaults() : option.environment as BrowserGamepadEnvironment;
  if (!env || ['requestAnimationFrame', 'cancelAnimationFrame', 'hidden', 'focused'].some(key => typeof env[key as keyof BrowserGamepadEnvironment] !== 'function') || !env.target || !env.document) throw new TypeError('Invalid browser gamepad environment');
  const ownedScope = Object.freeze({ ...scope }), controllerId = ++instance;
  if (!Number.isSafeInteger(controllerId)) throw new RangeError('Browser gamepad identity exhausted');
  const handles = new WeakMap<object, Choice>(), removals: (() => void)[] = [];
  let closed = isAborted(owner), busy = false, tearing = false, attempts = 0, generation = 0, revision = 0, lastTime = -1;
  let choice: Choice | undefined, active: Activation | undefined, raf: number | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let reason: BrowserGamepadFailure | 'selected' | 'active' | 'idle' = closed ? 'closed' : 'idle';
  function time(): number { let at: number; try { at = now(); } catch { retire('invalid'); return NaN; } if (!Number.isFinite(at) || at < 0 || at < lastTime) { retire('invalid'); return NaN; } lastTime = at; return at; }
  function usable(): boolean { return !closed && !tearing && !isAborted(owner); }
  function watch(value: AbortSignal, callback: () => void): () => void { Reflect.apply(add, value, ['abort', callback, { once: true }]); return () => { Reflect.apply(remove, value, ['abort', callback]); }; }
  function retire(why: BrowserGamepadFailure): void {
    revision++; const old = active; active = undefined; choice = undefined; reason = why;
    if (tearing) return; tearing = true;
    try {
      if (raf !== undefined) { const id = raf; raf = undefined; try { env.cancelAnimationFrame(id); } catch { /* exact ownership retired */ } }
      if (expiry !== undefined) { clearTimeout(expiry); expiry = undefined; }
      old?.removeGrant?.(); for (const dispose of removals.splice(0)) { try { dispose(); } catch { /* trusted listener teardown failure */ } }
      if (old) for (const handle of Object.values(old.sources)) { try { runtime.unregister(handle); } catch { /* no late provider dispatch */ } }
    } finally { tearing = false; }
  }
  function available(): BrowserGamepadFailure | undefined { if (env.hidden()) return 'hidden'; if (!env.focused()) return 'unfocused'; }
  function read(): readonly (NativePad | null)[] {
    if (typeof env.getGamepads !== 'function') throw no('unsupported');
    const pads = env.getGamepads(); if (!Array.isArray(pads) || pads.length > BROWSER_GAMEPAD_LIMITS.slots) throw no('unsupported'); return pads;
  }
  function snapshotPad(pads: readonly (NativePad | null)[], index: number): Pad | undefined {
    const pad = pads[index]; if (!pad || pad.connected !== true) return;
    const id = pad.id, slot = pad.index, axes = pad.axes, buttons = pad.buttons, timestamp = pad.timestamp;
    if (slot !== index) throw no('lost');
    if (typeof id !== 'string' || !id.length || id.length > 512 || !Array.isArray(axes) || axes.length > 16 || !Array.isArray(buttons) || buttons.length > 32 || !axes.length && !buttons.length || !Number.isFinite(timestamp) || timestamp < 0 || timestamp > Number.MAX_SAFE_INTEGER) throw no('unsupported');
    const axisCopy = axes.map(value => { if (!Number.isFinite(value) || value < -1 || value > 1) throw no('invalid'); return value; });
    const buttonCopy = buttons.map(value => { const pressed = value.pressed, amount = value.value; if (typeof pressed !== 'boolean' || !Number.isFinite(amount) || amount < 0 || amount > 1) throw no('invalid'); return Object.freeze({ pressed, value: amount }); });
    return Object.freeze({ index, id, axes: Object.freeze(axisCopy), buttons: Object.freeze(buttonCopy), timestamp });
  }
  function same(a: Pad, b: Pad): boolean { return a.index === b.index && a.id === b.id && a.axes.length === b.axes.length && a.buttons.length === b.buttons.length; }
  function install(): void {
    const selected = choice, turn = revision;
    const blur = () => retire('unfocused'), hide = () => { if (env.hidden()) retire('hidden'); }, page = () => retire('stopped');
    const connection = (event: Event) => { const pad = (event as GamepadEvent).gamepad; if (choice && pad?.index === choice.pad.index) retire('lost'); };
    for (const [target, name, callback] of [[env.target, 'blur', blur], [env.target, 'pagehide', page], [env.target, 'gamepadconnected', connection], [env.target, 'gamepaddisconnected', connection], [env.document, 'visibilitychange', hide]] as const) {
      // Native removal is idempotent. Provision before the callout and repeat
      // after an obsolete return: a wrapper may install after reentrant Stop.
      const dispose = () => { target.removeEventListener(name, callback); }; removals.push(dispose);
      try { target.addEventListener(name, callback); }
      finally { if (!usable() || choice !== selected || revision !== turn) dispose(); }
      if (!usable() || choice !== selected || revision !== turn) return;
    }
    removals.push(watch(owner, () => { closed = true; retire('closed'); }));
  }
  function current(a: Activation): boolean {
    if (!usable() || active !== a || choice !== a.choice || isAborted(a.grant.signal)) return false;
    const at = time(); return usable() && active === a && choice === a.choice && !isAborted(a.grant.signal) && at < a.grant.expiresAt;
  }
  function schedule(a: Activation): void {
    if (!current(a) || raf !== undefined) return;
    const turn = revision; const id = env.requestAnimationFrame(() => {
      if (revision !== turn || active !== a) return; raf = undefined; poll(a);
    });
    if (revision === turn && active === a && current(a)) raf = id; else env.cancelAnimationFrame(id);
  }
  function armExpiry(a: Activation): void {
    const wait = a.grant.expiresAt - time(); if (!current(a)) return;
    expiry = setTimeout(() => { expiry = undefined; if (active !== a) return; const at = time(); if (active !== a) return; if (at >= a.grant.expiresAt) retire('expired'); else armExpiry(a); }, Math.max(1, wait));
  }
  function poll(a: Activation): void {
    if (busy || !current(a)) { if (active === a) retire('expired'); return; } busy = true;
    try {
      const unavailable = available(); if (!current(a)) return; if (unavailable) { retire(unavailable); return; }
      const at = time(); if (!current(a)) return;
      if (at - a.lastPoll < 1000 / 60) return;
      if (a.polls >= 1800) { retire('quota'); return; } a.polls++;
      const pad = snapshotPad(read(), a.choice.pad.index); if (!current(a)) return;
      if (!pad || !same(pad, a.choice.pad) || pad.timestamp < a.lastNativeTimestamp) { retire('lost'); return; }
      a.lastPoll = at; a.lastNativeTimestamp = pad.timestamp;
      const values = a.processor.process(pad), provenance: JsonObject = Object.freeze({ provider: 'browser-gamepad-api', samplePoint: 'javascript-poll',
        gamepadLastUpdateTimestamp: pad.timestamp, captureTimeKnown: false, clockMappingEstablished: false, selectedIndex: pad.index, connectionGeneration: a.choice.generation });
      const samples: [string, unknown][] = [...(pad.axes.length ? [['axes', values.axes] as [string, unknown]] : []), ...values.buttons.map(value => ['button', value] as [string, unknown])];
      for (const [capability, value] of samples) {
        if (!current(a)) return;
        const result = runtime.publish(a.sources[capability]!, value, { timestamp: at, clockDomain: runtime.clockDomain, quality: 'valid', provenance,
          ...(capability === 'button' ? { operationId: String(++a.operation), deadline: at + 100 } : {}) });
        if (!current(a)) return; if (!result.ok || result.value.accepted === 0 || result.value.rejected > 0) { retire('unavailable'); return; }
      }
    } catch (error) { if (active === a) retire(failure(error)); }
    finally { busy = false; if (active === a) { try { schedule(a); } catch { retire('unavailable'); } } }
  }
  function enter(): BrowserGamepadFailure | undefined { if (!usable()) return closed || isAborted(owner) ? 'closed' : 'busy'; if (busy) return 'busy'; if (attempts >= 64) return 'quota'; attempts++; busy = true; }
  return Object.freeze({
    inspect() { const denied = enter(); if (denied) return no(denied); const turn = revision;
      try { const unavailable = available(); if (unavailable) return no(unavailable); const pads = read(), rows: BrowserGamepadInventory[] = [];
        for (let index = 0; index < pads.length; index++) { const pad = snapshotPad(pads, index); if (pad) rows.push(Object.freeze({ index, axes: pad.axes.length, buttons: pad.buttons.length })); }
        return usable() && turn === revision ? yes(Object.freeze(rows)) : no('cancelled');
      } catch (error) { return no(failure(error)); } finally { busy = false; }
    },
    select(index: number) { const denied = enter(); if (denied) return no(denied); const turn = revision; let created = false;
      try { if (!Number.isInteger(index) || index < 0 || index >= 8) return no('invalid'); if (active) return no('busy'); const unavailable = available(); if (unavailable) return no(unavailable);
        const pad = snapshotPad(read(), index); if (!usable() || turn !== revision) return no('cancelled'); if (!pad) return no('unavailable');
        retire('stopped'); if (!usable()) return no('cancelled'); const connection = ++generation, handle = Object.freeze({}), device = descriptor(`browser-gamepad-${controllerId}:connection-${connection}`, pad);
        choice = { handle, pad, generation: connection, device }; created = true; handles.set(handle, choice); install();
        if (!usable() || !choice || choice.handle !== handle) { retire('cancelled'); return no('cancelled'); } reason = 'selected'; return yes(handle);
      } catch (error) { const why = failure(error); if (created) retire(why); return no(why); } finally { busy = false; }
    },
    start(handle: BrowserGamepadSelection, raw: Readonly<{ purpose: string }>) { const denied = enter(); if (denied) return no(denied); const turn = revision;
      try {
        const selected = handle && typeof handle === 'object' ? handles.get(handle) : undefined, request = fields(raw, ['purpose']);
        if (!selected || selected !== choice || active) return no('denied'); if (!request || Object.keys(request).length !== 1 || !identifier(request.purpose)) return no('invalid');
        const unavailable = available(); if (!usable() || turn !== revision) return no('cancelled'); if (unavailable) { retire(unavailable); return no(unavailable); }
        const pad = snapshotPad(read(), selected.pad.index); if (!usable() || turn !== revision) return no('cancelled'); if (!pad || !same(pad, selected.pad)) { retire('lost'); return no('lost'); }
        const approval: BrowserGamepadCaptureRequest = Object.freeze({ ...ownedScope as BrowserGamepadOptions['scope'], purpose: request.purpose, deviceId: selected.device.id,
          selectedIndex: pad.index, connectionGeneration: selected.generation, axes: pad.axes.length, buttons: pad.buttons.length,
          resources: Object.freeze(selected.device.capabilities.map(c => Object.freeze({ capabilityId: c.id as 'axes' | 'button', operation: 'subscribe' as const }))) });
        const grant = fields(authorize(approval), ['request', 'signal', 'expiresAt']), at = time();
        if (!usable() || turn !== revision || selected !== choice) return no('cancelled');
        if (!grant || Object.keys(grant).length !== 3 || grant.request !== approval || !signal(grant.signal) || isAborted(grant.signal) || typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= at || grant.expiresAt > at + 30000) return no('denied');
        const a: Activation = { choice: selected, grant: Object.freeze({ signal: grant.signal, expiresAt: grant.expiresAt }), sources: Object.create(null), operation: 0, polls: 0, lastPoll: -Infinity, lastNativeTimestamp: pad.timestamp,
          processor: createGamepadDetailProcessor({ axes: pad.axes.map(() => ({ min: -1, center: 0, max: 1, deadzone: 0 })), buttonCount: pad.buttons.length, triggers: [], hats: [] }) };
        active = a; a.removeGrant = watch(a.grant.signal, () => retire('denied'));
        for (const c of selected.device.capabilities) {
          if (!current(a)) { retire('cancelled'); return no('cancelled'); }
          const source = runtime.registerSource({ device: selected.device, capability: c.id });
          if (!current(a)) { runtime.unregister(source); retire('cancelled'); return no('cancelled'); } a.sources[c.id] = source;
          if (!runtime.setReadiness(source, 'available', a.grant.expiresAt).ok || !current(a)) { retire('unavailable'); return no('unavailable'); }
        }
        reason = 'active'; armExpiry(a); schedule(a); if (!current(a)) { retire('cancelled'); return no('cancelled'); }
        return yes(Object.freeze({ device: selected.device, sources: Object.freeze({ ...a.sources }), connectionGeneration: selected.generation }));
      } catch { retire('unavailable'); return no('unavailable'); } finally { busy = false; }
    },
    stop() { retire('stopped'); }, close() { closed = true; retire('closed'); },
    snapshot() { return Object.freeze({ phase: closed || isAborted(owner) ? 'closed' : active ? 'active' : choice ? 'selected' : 'idle', reason, attempts,
      connectionGeneration: generation, activeSources: active ? Object.keys(active.sources).length : 0, listeners: removals.length + Number(active?.removeGrant !== undefined), timerArmed: expiry !== undefined, rafArmed: raf !== undefined }); },
  });
}
