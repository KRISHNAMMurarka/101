import { createHash } from 'node:crypto';

/** One reviewed, non-repeating NEC inverse-byte frame. Appliance meanings stay outside this gateway. */
export const NEC32_IR_PROFILE = Object.freeze({
  id: 'app:nec-inverse-byte-command-one-shot/1' as const,
  carrierHz: 38_000,
  leaderMicros: Object.freeze([9_000, 4_500] as const),
  zeroMicros: Object.freeze([560, 565] as const),
  oneMicros: Object.freeze([560, 1_690] as const),
  stopMicros: 560,
});
export const NEC32_IR_LIMITS = Object.freeze({ starts: 8, emissions: 16, rawOperations: 1, codebookEntries: 16,
  operationMs: 500, sessionMs: 60_000, minimumIntervalMs: 108 });

export type Nec32IrFailure = 'invalid' | 'denied' | 'expired' | 'closed' | 'busy' | 'quota' | 'cancelled' |
  'replay' | 'provider' | 'unsupported';
export type Nec32IrResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: Nec32IrFailure;
  issued?: true; emission?: 'uncertain' }>;
export interface Nec32IrEpoch { readonly nec32IrEpoch?: never }
export interface Nec32IrScope { readonly principalId: string; readonly applicationId: string; readonly sessionId: string }
export interface Nec32IrCode { readonly codeId: string; readonly address: number; readonly command: number }
export interface SelectedNec32IrEmitter { readonly id: string; readonly profileId: typeof NEC32_IR_PROFILE.id;
  readonly codebook: readonly Nec32IrCode[] }
export interface Nec32IrCompiledFrame { readonly frame: Uint8Array; readonly timings: readonly number[];
  readonly totalMicros: number; readonly envelope: Uint8Array; readonly envelopeSha256: string }
export interface Nec32IrProviderContext { readonly generation: number; readonly purpose: string; readonly deadline: number;
  readonly signal: AbortSignal }
export interface Nec32IrEmitterProvider {
  readonly supported: boolean;
  readonly carrierRanges: readonly Readonly<{ minHz: number; maxHz: number }>[];
  open(context: Nec32IrProviderContext): 'ready' | 'unavailable' | Promise<'ready' | 'unavailable'>;
  transmit(envelope: Uint8Array, context: Nec32IrProviderContext & Readonly<{ operationId: string }>):
    'completed' | 'unavailable' | 'rejected' | Promise<'completed' | 'unavailable' | 'rejected'>;
  stop(): void;
  close(): void | Promise<void>;
  whenSettled(): Promise<void>;
}
export interface Nec32IrApprovalRequest {
  readonly action: 'activate-emitter' | 'emit-code'; readonly principalId: string; readonly applicationId: string;
  readonly sessionId: string; readonly emitterId: string; readonly profileId: typeof NEC32_IR_PROFILE.id;
  readonly generation: number; readonly purpose: string; readonly deadline: number; readonly operationId?: string;
  readonly codeId?: string; readonly address?: number; readonly command?: number; readonly frameSha256?: string;
  readonly carrierHz: 38000; readonly timingCount?: 67; readonly totalMicros?: 68060;
}
export interface Nec32IrGrant { readonly request: Nec32IrApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface Nec32IrOptions { readonly ownerSignal: AbortSignal; readonly scope: Nec32IrScope;
  readonly selectedEmitter: SelectedNec32IrEmitter; readonly selectedProvider: Nec32IrEmitterProvider;
  readonly authorizeEmitter: (request: Nec32IrApprovalRequest) => Nec32IrGrant | undefined;
  readonly authorizeEmission: (request: Nec32IrApprovalRequest) => Nec32IrGrant | undefined }
export interface Nec32IrEmission { readonly operationId: string; readonly codeId: string; readonly frameSha256: string;
  readonly evidence: 'provider-completed'; readonly effect: 'dispatched'; readonly physicalCarrier: 'unverified';
  readonly targetAcknowledgement: false; readonly observedState: false }
export interface Nec32IrGateway {
  start(request: Readonly<{ purpose: string; deadline: number }>): Promise<Nec32IrResult<Nec32IrEpoch>>;
  emit(epoch: Nec32IrEpoch, request: Readonly<{ operationId: string; codeId: string; purpose: string;
    signal: AbortSignal; deadline: number }>): Promise<Nec32IrResult<Nec32IrEmission>>;
  stop(): Promise<void>; close(): Promise<void>;
  status(): Readonly<{ phase: 'idle' | 'opening' | 'ready' | 'retiring' | 'closed'; starts: number; emissions: number;
    emissionAttempts: number; retainedRecords: number; rawPending: number }>;
}

const providerOwners = new WeakMap<object, symbol>();
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const isAborted = (signal: AbortSignal) => Reflect.apply(abortGetter, signal, []) as boolean;
function genuineSignal(value: unknown): value is AbortSignal { try { isAborted(value as AbortSignal); return true; } catch { return false; } }
function own(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !keys.includes(key)) return;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return;
      result[key] = descriptor.value;
    }
    return keys.every(key => Object.hasOwn(result, key)) ? result : undefined;
  } catch { return; }
}
const validId = (value: unknown, length = 64): value is string => typeof value === 'string' && value.length <= length &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const validCodeId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
const byte = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 255;
const deadlineValid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) &&
  value > performance.now() && value <= performance.now() + NEC32_IR_LIMITS.operationMs;
const pass = <T>(value: T): Nec32IrResult<T> => Object.freeze({ ok: true, value });
const fail = <T = never>(reason: Nec32IrFailure, issued = false, uncertain = false): Nec32IrResult<T> => Object.freeze({ ok: false, reason,
  ...(issued ? { issued: true as const, ...(uncertain ? { emission: 'uncertain' as const } : {}) } : {}) });

export function compileNec32IrFrame(address: number, command: number): Nec32IrCompiledFrame {
  if (!byte(address) || !byte(command)) throw new TypeError('Invalid NEC32 code bytes');
  const frame = Uint8Array.of(address, address ^ 0xff, command, command ^ 0xff);
  const timings: number[] = [9_000, 4_500];
  for (const value of frame) for (let bit = 0; bit < 8; bit++) timings.push(...((value >>> bit) & 1 ? [560, 1_690] : [560, 565]));
  timings.push(560);
  const envelope = new Uint8Array(4 + 4 + 4 + 2 + timings.length * 4); const view = new DataView(envelope.buffer);
  envelope.set([0x49, 0x52, 0x4e, 0x31], 0); view.setUint32(4, NEC32_IR_PROFILE.carrierHz, false); envelope.set(frame, 8);
  view.setUint16(12, timings.length, false); timings.forEach((value, index) => view.setUint32(14 + index * 4, value, false));
  const envelopeSha256 = createHash('sha256').update(envelope).digest('hex');
  return Object.freeze({ frame, timings: Object.freeze(timings), totalMicros: timings.reduce((sum, value) => sum + value, 0),
    envelope, envelopeSha256 });
}

interface Active { generation: number; handle: Nec32IrEpoch; grant: Readonly<{ signal: AbortSignal; expiresAt: number }>;
  ready: boolean; retired: boolean; stopController: AbortController; operation?: Promise<unknown>; stopPromise?: Promise<void>;
  stopCalled: boolean; detach?: () => void; expiry?: ReturnType<typeof setTimeout> }

export function createNec32IrEmitterGateway(input: Nec32IrOptions): Nec32IrGateway {
  const options = own(input, ['ownerSignal', 'scope', 'selectedEmitter', 'selectedProvider', 'authorizeEmitter', 'authorizeEmission']);
  const scope = own(options?.scope, ['principalId', 'applicationId', 'sessionId']);
  const emitter = own(options?.selectedEmitter, ['id', 'profileId', 'codebook']);
  const provider = options?.selectedProvider;
  if (!options || !genuineSignal(options.ownerSignal) || !scope || !Object.values(scope).every(item => validId(item)) ||
    !emitter || !validId(emitter.id) || emitter.profileId !== NEC32_IR_PROFILE.id || !Array.isArray(emitter.codebook) ||
    emitter.codebook.length < 1 || emitter.codebook.length > NEC32_IR_LIMITS.codebookEntries || !provider || typeof provider !== 'object' ||
    typeof options.authorizeEmitter !== 'function' || typeof options.authorizeEmission !== 'function') throw new TypeError('Invalid selected NEC32 emitter');
  const codebook = new Map<string, Readonly<Nec32IrCode>>();
  const codePairs = new Set<string>();
  for (const item of emitter.codebook as unknown[]) {
    const code = own(item, ['codeId', 'address', 'command']);
    const pair = code && byte(code.address) && byte(code.command) ? `${code.address}:${code.command}` : '';
    if (!code || !validCodeId(code.codeId) || !byte(code.address) || !byte(code.command) || codebook.has(code.codeId) || codePairs.has(pair))
      throw new TypeError('Invalid NEC32 codebook');
    codebook.set(code.codeId, Object.freeze({ codeId: code.codeId, address: code.address, command: code.command }));
    codePairs.add(pair);
  }
  // Snapshot every trusted lifecycle hook before any effectful provider callout. Accessors are rejected.
  const method = (name: keyof Nec32IrEmitterProvider) => {
    const descriptor = Object.getOwnPropertyDescriptor(provider, name);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new TypeError(`Invalid provider ${String(name)}`);
    return descriptor.value.bind(provider) as (...args: never[]) => unknown;
  };
  const open = method('open') as Nec32IrEmitterProvider['open'];
  const transmit = method('transmit') as Nec32IrEmitterProvider['transmit'];
  const providerStop = method('stop') as Nec32IrEmitterProvider['stop'];
  const providerClose = method('close') as Nec32IrEmitterProvider['close'];
  const whenSettled = method('whenSettled') as Nec32IrEmitterProvider['whenSettled'];
  const supported = Object.getOwnPropertyDescriptor(provider, 'supported');
  const ranges = Object.getOwnPropertyDescriptor(provider, 'carrierRanges');
  if (!supported || !('value' in supported) || typeof supported.value !== 'boolean' || !ranges || !('value' in ranges) ||
    !Array.isArray(ranges.value)) throw new TypeError('Invalid provider capabilities');
  const carrierSupported = supported.value && ranges.value.some((entry: unknown) => { const range = own(entry, ['minHz', 'maxHz']);
    return range && Number.isSafeInteger(range.minHz) && Number.isSafeInteger(range.maxHz) &&
      (range.minHz as number) <= NEC32_IR_PROFILE.carrierHz && (range.maxHz as number) >= NEC32_IR_PROFILE.carrierHz; });
  const owner = options.ownerSignal, authorizeEmitter = options.authorizeEmitter as Nec32IrOptions['authorizeEmitter'];
  const authorizeEmission = options.authorizeEmission as Nec32IrOptions['authorizeEmission'];
  const selected = Object.freeze({ id: emitter.id, profileId: emitter.profileId });
  const ownedScope = Object.freeze({ ...scope }) as unknown as Nec32IrScope;
  const ownershipToken = Symbol('nec32-provider-owner'); const usedOperations = new Set<string>();
  let terminal = isAborted(owner), generation = 0, starts = 0, emissions = 0, emissionAttempts = 0, opening = false, rawPending = 0;
  let active: Active | undefined, lastIssuedAt = Number.NEGATIVE_INFINITY, closePromise: Promise<void> | undefined;
  let detachOwner = () => {};

  const current = (value: Active) => !terminal && active === value && !value.retired && value.generation === generation &&
    providerOwners.get(provider as object) === ownershipToken && !isAborted(owner) && !isAborted(value.grant.signal) &&
    performance.now() < value.grant.expiresAt;
  function authority(action: Nec32IrApprovalRequest['action'], purpose: string, deadline: number, atGeneration: number,
    extra: Partial<Nec32IrApprovalRequest> = {}) {
    const request = Object.freeze({ action, ...ownedScope, emitterId: selected.id, profileId: selected.profileId,
      generation: atGeneration, purpose, deadline, carrierHz: 38_000 as const, ...extra }) as Nec32IrApprovalRequest;
    let response: unknown;
    try { response = (action === 'activate-emitter' ? authorizeEmitter : authorizeEmission)(request); } catch { return; }
    if (generation !== atGeneration || terminal || isAborted(owner)) return;
    const grant = own(response, ['request', 'signal', 'expiresAt']); const now = performance.now();
    if (!grant || grant.request !== request || !genuineSignal(grant.signal) || isAborted(grant.signal) ||
      typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now ||
      grant.expiresAt > now + NEC32_IR_LIMITS.sessionMs || grant.expiresAt > deadline + NEC32_IR_LIMITS.sessionMs) return;
    return Object.freeze({ signal: grant.signal, expiresAt: grant.expiresAt });
  }
  function stopActive(value: Active): Promise<void> {
    if (value.stopPromise) return value.stopPromise;
    let resolveStop!: () => void;
    const promise = new Promise<void>(resolve => { resolveStop = resolve; });
    // Reserve shared settlement before abort or provider callbacks can reenter retirement.
    value.stopPromise = promise;
    value.retired = true; value.detach?.(); if (value.expiry) clearTimeout(value.expiry); value.stopController.abort();
    const ownsProvider = providerOwners.get(provider as object) === ownershipToken;
    if (ownsProvider && !value.stopCalled) { value.stopCalled = true; try { providerStop(); } catch { /* Continue joined cleanup after a stop fault. */ } }
    let settled: Promise<void> = Promise.resolve();
    if (ownsProvider) try { settled = Promise.resolve(whenSettled()); } catch { /* A captured settlement fault cannot skip release. */ }
    void Promise.allSettled([...(value.operation ? [value.operation] : []), settled]).then(async () => {
      if (providerOwners.get(provider as object) === ownershipToken) {
        try { await providerClose(); } catch { /* Final settlement still runs after a close fault. */ }
        try { await whenSettled(); } catch { /* Release only the exact token after final settlement. */ }
      }
      if (active === value) active = undefined;
      if (providerOwners.get(provider as object) === ownershipToken) providerOwners.delete(provider as object);
    }).then(resolveStop, resolveStop);
    return promise;
  }
  async function start(request: Readonly<{ purpose: string; deadline: number }>): Promise<Nec32IrResult<Nec32IrEpoch>> {
    const value = own(request, ['purpose', 'deadline']);
    if (!value || typeof value.purpose !== 'string' || !value.purpose.length || value.purpose.length > 160 || !deadlineValid(value.deadline)) return fail('invalid');
    if (terminal) return fail('closed'); if (opening || active) return fail('busy'); if (starts >= NEC32_IR_LIMITS.starts) return fail('quota');
    starts++; opening = true; const atGeneration = ++generation;
    try {
      const grant = authority('activate-emitter', value.purpose, value.deadline, atGeneration);
      if (!grant || generation !== atGeneration || !opening || terminal) return fail('denied');
      if (!carrierSupported) return fail('unsupported');
      if (providerOwners.has(provider as object)) return fail('busy'); providerOwners.set(provider as object, ownershipToken);
      if (generation !== atGeneration || !opening || terminal) { providerOwners.delete(provider as object); return fail('cancelled'); }
      const state: Active = { generation: atGeneration, handle: Object.freeze({}), grant, ready: false, retired: false,
        stopController: new AbortController(), stopCalled: false };
      active = state; const stop = () => { void stopActive(state); }; grant.signal.addEventListener('abort', stop, { once: true });
      owner.addEventListener('abort', stop, { once: true }); state.detach = () => { grant.signal.removeEventListener('abort', stop); owner.removeEventListener('abort', stop); };
      state.expiry = setTimeout(stop, Math.max(0, Math.ceil(grant.expiresAt - performance.now())));
      const deadline = Math.min(value.deadline as number, grant.expiresAt); let issued = false;
      const openingTimer = setTimeout(() => { void stopActive(state); }, Math.max(0, Math.ceil(deadline - performance.now())));
      const providerTask = Promise.resolve().then(() => {
        if (!current(state) || performance.now() >= deadline) throw new Error('cancelled');
        issued = true; return open({ generation: atGeneration, purpose: value.purpose as string, deadline, signal: state.stopController.signal });
      }).then(result => Promise.resolve(result));
      state.operation = providerTask;
      try {
        const result = await providerTask;
        clearTimeout(openingTimer);
        if (!current(state) || performance.now() >= deadline || result !== 'ready') {
          await stopActive(state); return result === 'unavailable' ? fail('unsupported', issued) : fail(performance.now() >= deadline ? 'expired' : 'cancelled', issued);
        }
        state.ready = true; state.operation = undefined; return pass(state.handle);
      } catch { clearTimeout(openingTimer); await stopActive(state); return fail(performance.now() >= deadline ? 'expired' : 'provider', issued); }
    } finally { if (generation === atGeneration) opening = false; else opening = false; }
  }
  async function emit(epoch: Nec32IrEpoch, request: Readonly<{ operationId: string; codeId: string; purpose: string;
    signal: AbortSignal; deadline: number }>): Promise<Nec32IrResult<Nec32IrEmission>> {
    const value = own(request, ['operationId', 'codeId', 'purpose', 'signal', 'deadline']);
    if (!value || !validId(value.operationId, 128) || !validCodeId(value.codeId) || typeof value.purpose !== 'string' ||
      !value.purpose.length || value.purpose.length > 160 || !genuineSignal(value.signal) || !deadlineValid(value.deadline)) return fail('invalid');
    if (isAborted(value.signal)) return fail('cancelled'); if (terminal) return fail('closed');
    const state = active; if (!state || !state.ready || state.handle !== epoch || !current(state)) return fail('denied');
    if (rawPending >= NEC32_IR_LIMITS.rawOperations) return fail('busy');
    const code = codebook.get(value.codeId); if (!code) return fail('invalid'); if (usedOperations.has(value.operationId)) return fail('replay');
    if (performance.now() - lastIssuedAt < NEC32_IR_LIMITS.minimumIntervalMs) return fail('busy');
    if (emissionAttempts >= NEC32_IR_LIMITS.emissions) return fail('quota');
    emissionAttempts++; usedOperations.add(value.operationId); rawPending++; const atGeneration = state.generation; let issued = false;
    try {
      if (!current(state) || isAborted(value.signal)) return fail('cancelled');
      const compiled = compileNec32IrFrame(code.address, code.command);
      if (!current(state) || isAborted(value.signal)) return fail('cancelled');
      const grant = authority('emit-code', value.purpose, value.deadline, atGeneration, { operationId: value.operationId,
        codeId: code.codeId, address: code.address, command: code.command, frameSha256: compiled.envelopeSha256,
        timingCount: 67, totalMicros: 68060 });
      if (!grant || !current(state) || isAborted(value.signal)) return fail('denied');
      const deadline = Math.min(value.deadline as number, grant.expiresAt, state.grant.expiresAt);
      if (performance.now() >= deadline) return fail('expired');
      const controller = new AbortController(); let deadlineExpired = false;
      const abort = () => { controller.abort(); void stopActive(state); };
      for (const signal of [owner, state.grant.signal, state.stopController.signal, value.signal as AbortSignal, grant.signal])
        signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { deadlineExpired = true; abort(); }, Math.max(0, Math.ceil(deadline - performance.now())));
      const task = Promise.resolve().then(() => {
        if (!current(state) || controller.signal.aborted || performance.now() >= deadline) throw new Error('cancelled');
        issued = true; lastIssuedAt = performance.now(); return transmit(compiled.envelope, { generation: atGeneration,
          operationId: value.operationId as string, purpose: value.purpose as string, deadline, signal: controller.signal });
      }).then(result => Promise.resolve(result));
      state.operation = task;
      try {
        const result = await task;
        if (!current(state) || controller.signal.aborted || isAborted(grant.signal) || performance.now() >= deadline) {
          await stopActive(state);
          return fail(deadlineExpired || performance.now() >= deadline ? 'expired' : 'cancelled', issued, true);
        }
        if (result !== 'completed') { await stopActive(state); return fail(result === 'unavailable' ? 'unsupported' : 'provider', issued, true); }
        emissions++;
        return pass(Object.freeze({ operationId: value.operationId as string, codeId: code.codeId,
          frameSha256: compiled.envelopeSha256, evidence: 'provider-completed' as const, effect: 'dispatched' as const,
          physicalCarrier: 'unverified' as const, targetAcknowledgement: false as const, observedState: false as const }));
      } catch {
        // A provider may acquire or begin emitting before throwing synchronously. The lifecycle
        // hooks were captured at construction, so retire and join them before releasing raw ownership.
        if (issued) await stopActive(state);
        return fail(deadlineExpired || performance.now() >= deadline ? 'expired' : 'provider', issued, true);
      }
      finally {
        clearTimeout(timer); for (const signal of [owner, state.grant.signal, state.stopController.signal, value.signal as AbortSignal, grant.signal])
          signal.removeEventListener('abort', abort); if (state.operation === task) state.operation = undefined;
      }
    } finally { rawPending--; }
  }
  async function stop(): Promise<void> { generation++; opening = false; const state = active; if (state) await stopActive(state); }
  async function close(): Promise<void> {
    if (closePromise) return closePromise; terminal = true; generation++; opening = false; detachOwner();
    closePromise = Promise.resolve().then(async () => { const state = active; if (state) await stopActive(state); }); return closePromise;
  }
  if (!terminal) {
    const ownerAborted = () => { terminal = true; void stop(); };
    owner.addEventListener('abort', ownerAborted, { once: true });
    detachOwner = () => { owner.removeEventListener('abort', ownerAborted); detachOwner = () => {}; };
  }
  return Object.freeze({ start, emit, stop, close, status: () => Object.freeze({ phase: terminal ? 'closed' : opening ? 'opening' :
    active?.retired ? 'retiring' : active?.ready ? 'ready' : 'idle', starts, emissions, emissionAttempts,
    retainedRecords: usedOperations.size, rawPending }) });
}
