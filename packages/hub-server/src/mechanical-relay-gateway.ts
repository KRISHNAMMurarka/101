export const MECHANICAL_RELAY_PROFILE = Object.freeze({
  id: 'app:single-relay-software-interlocked/1' as const,
  states: Object.freeze(['off', 'on'] as const),
  watchdogMs: 250,
  physical: false,
});

export const MECHANICAL_RELAY_LIMITS = Object.freeze({
  starts: 8,
  setAttempts: 16,
  observationAttempts: 32,
  rawSetPending: 1,
  rawObservationPending: 1,
  operationMs: 500,
  sessionMs: 60_000,
  watchdogMs: 250,
});

export type RelayState = 'off' | 'on';
export type RelayFailure = 'invalid' | 'denied' | 'expired' | 'closed' | 'busy' | 'quota' |
  'cancelled' | 'replay' | 'provider' | 'unsupported' | 'interlock-open' | 'out-of-order';
export type RelayResult<T> = Readonly<{ ok: true; value: T }> |
  Readonly<{ ok: false; reason: RelayFailure; issued?: true; effect?: 'uncertain' }>;
export interface MechanicalRelayEpoch { readonly mechanicalRelayEpoch?: never }
export interface RelayScope { readonly principalId: string; readonly applicationId: string; readonly sessionId: string }
export interface RelayProviderContext {
  readonly generation: number;
  readonly purpose: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}
export interface MechanicalRelayActuatorProvider {
  readonly supported: boolean;
  readonly softwareOnly: true;
  readonly watchdogMs: 250;
  open(context: RelayProviderContext): 'ready' | 'unavailable' | Promise<'ready' | 'unavailable'>;
  setState(state: RelayState, context: RelayProviderContext & Readonly<{ operationId: string }>):
    'completed' | 'interlock-open' | 'unavailable' | Promise<'completed' | 'interlock-open' | 'unavailable'>;
  release(context: Readonly<{ generation: number }>): void | Promise<void>;
  stop(): void;
  close(): void | Promise<void>;
  whenSettled(): Promise<void>;
}
export interface MechanicalRelayFeedbackSample {
  readonly state: RelayState;
  readonly limitSafe: boolean;
  readonly sequence: number;
  readonly sourceClockId: string;
  readonly sourceMonotonicNs: bigint;
}
export interface MechanicalRelayFeedbackProvider {
  readonly supported: boolean;
  readonly softwareOnly: true;
  open(context: RelayProviderContext): 'ready' | 'unavailable' | Promise<'ready' | 'unavailable'>;
  read(context: RelayProviderContext & Readonly<{ operationId: string }>):
    MechanicalRelayFeedbackSample | Promise<MechanicalRelayFeedbackSample>;
  stop(): void;
  close(): void | Promise<void>;
  whenSettled(): Promise<void>;
}
export interface RelayApprovalRequest {
  readonly action: 'activate-relay' | 'set-relay-state' | 'observe-relay-feedback';
  readonly principalId: string;
  readonly applicationId: string;
  readonly sessionId: string;
  readonly relayId: string;
  readonly profileId: typeof MECHANICAL_RELAY_PROFILE.id;
  readonly generation: number;
  readonly purpose: string;
  readonly deadline: number;
  readonly watchdogMs: 250;
  readonly operationId?: string;
  readonly state?: RelayState;
  readonly maxSamples?: 1;
}
export interface RelayGrant { readonly request: RelayApprovalRequest; readonly signal: AbortSignal; readonly expiresAt: number }
export interface MechanicalRelayOptions {
  readonly ownerSignal: AbortSignal;
  readonly scope: RelayScope;
  readonly selectedRelay: Readonly<{ id: string; profileId: typeof MECHANICAL_RELAY_PROFILE.id }>;
  readonly actuatorProvider: MechanicalRelayActuatorProvider;
  readonly feedbackProvider: MechanicalRelayFeedbackProvider;
  readonly authorizeActivation: (request: RelayApprovalRequest) => RelayGrant | undefined;
  readonly authorizeSet: (request: RelayApprovalRequest) => RelayGrant | undefined;
  readonly authorizeFeedback: (request: RelayApprovalRequest) => RelayGrant | undefined;
  readonly onRetire: () => void;
}
export interface RelaySetCompletion {
  readonly operationId: string;
  readonly target: RelayState;
  readonly providerCompletion: true;
  readonly effect: 'issued-uncertain';
  readonly observedState: 'unknown';
  readonly physical: false;
  readonly physicalState: 'unverified';
}
export interface RelayFeedbackObservation {
  readonly operationId: string;
  readonly state: RelayState;
  readonly limitSafe: boolean;
  readonly sensorSequence: number;
  readonly relation: 'matches-target' | 'contradicts-target' | 'no-target';
  readonly feedbackSource: 'software-state';
  readonly physical: false;
  readonly physicalState: 'unverified';
  readonly captureTimeKnown: false;
  readonly freshnessBasis: 'gateway-receipt';
  readonly sourceClockId: string;
  readonly sourceMonotonicNs: bigint;
  readonly sourceClockMapping: null;
  readonly receivedAt: number;
  readonly feedbackGeneration: number;
  readonly gatewayReceiptSequence: number;
  readonly receiptClockDomain: 'mechanical-relay-gateway-monotonic';
  readonly providerKind: 'software-fixture';
}
export interface MechanicalRelayGateway {
  start(request: Readonly<{ purpose: string; deadline: number }>): Promise<RelayResult<MechanicalRelayEpoch>>;
  setState(epoch: MechanicalRelayEpoch, request: Readonly<{ operationId: string; state: RelayState; purpose: string;
    signal: AbortSignal; deadline: number }>): Promise<RelayResult<RelaySetCompletion>>;
  observe(epoch: MechanicalRelayEpoch, request: Readonly<{ operationId: string; purpose: string;
    signal: AbortSignal; deadline: number }>): Promise<RelayResult<RelayFeedbackObservation>>;
  stop(): Promise<void>;
  close(): Promise<void>;
  status(): Readonly<{ phase: 'idle' | 'opening' | 'ready' | 'retiring' | 'closed'; starts: number;
    setAttempts: number; completedSets: number; observationAttempts: number; freshObservations: number;
    retainedSetRecords: number; retainedObservationRecords: number; rawSetPending: number;
    rawObservationPending: number; logicalTarget: RelayState | 'unknown'; latestObservationRelation: RelayFeedbackObservation['relation'] | 'unknown' }>;
}

const providerOwners = new WeakMap<object, symbol>();
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const isAborted = (signal: AbortSignal) => Reflect.apply(abortGetter, signal, []) as boolean;

function genuineSignal(value: unknown): value is AbortSignal {
  try { isAborted(value as AbortSignal); return true; } catch { return false; }
}

function plain(value: unknown, required: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !required.includes(key)) return;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return;
      result[key] = descriptor.value;
    }
    return required.every(key => Object.hasOwn(result, key)) ? result : undefined;
  } catch { return; }
}

const validId = (value: unknown, max = 128): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const validPurpose = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
const validDeadline = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) &&
  value > performance.now() && value <= performance.now() + MECHANICAL_RELAY_LIMITS.operationMs;
const success = <T>(value: T): RelayResult<T> => Object.freeze({ ok: true, value });
const failure = <T = never>(reason: RelayFailure, issued = false, uncertain = false): RelayResult<T> => Object.freeze({
  ok: false,
  reason,
  ...(issued ? { issued: true as const } : {}),
  ...(uncertain ? { effect: 'uncertain' as const } : {}),
});

interface ActiveSession {
  generation: number;
  epoch: MechanicalRelayEpoch;
  grant: Readonly<{ signal: AbortSignal; expiresAt: number }>;
  controller: AbortController;
  ready: boolean;
  retired: boolean;
  withdrawn: boolean;
  released: boolean;
  actuatorStopped: boolean;
  feedbackStopped: boolean;
  openOperation?: Promise<unknown>;
  setOperation?: Promise<unknown>;
  feedbackOperation?: Promise<unknown>;
  stopping?: Promise<void>;
  detach?: () => void;
  expiry?: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setTimeout>;
  effectDetach?: () => void;
  effectExpiry?: ReturnType<typeof setTimeout>;
  feedbackDetach?: () => void;
  feedbackExpiry?: ReturnType<typeof setTimeout>;
}

export function createMechanicalRelayGateway(input: MechanicalRelayOptions): MechanicalRelayGateway {
  const options = plain(input, ['ownerSignal', 'scope', 'selectedRelay', 'actuatorProvider', 'feedbackProvider',
    'authorizeActivation', 'authorizeSet', 'authorizeFeedback', 'onRetire']);
  const scope = plain(options?.scope, ['principalId', 'applicationId', 'sessionId']);
  const selected = plain(options?.selectedRelay, ['id', 'profileId']);
  const actuator = options?.actuatorProvider as MechanicalRelayActuatorProvider;
  const feedback = options?.feedbackProvider as MechanicalRelayFeedbackProvider;
  if (!options || !genuineSignal(options.ownerSignal) || !scope || !Object.values(scope).every(value => validId(value)) ||
    !selected || !validId(selected.id) || selected.profileId !== MECHANICAL_RELAY_PROFILE.id || !actuator || !feedback ||
    (actuator as object) === (feedback as object) || typeof options.authorizeActivation !== 'function' || typeof options.authorizeSet !== 'function' ||
    typeof options.authorizeFeedback !== 'function' || typeof options.onRetire !== 'function') {
    throw new TypeError('Invalid selected mechanical relay');
  }

  function method<T extends object>(provider: T, name: keyof T): (...args: never[]) => unknown {
    const descriptor = Object.getOwnPropertyDescriptor(provider, name);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
      throw new TypeError(`Invalid provider ${String(name)}`);
    }
    return descriptor.value.bind(provider) as (...args: never[]) => unknown;
  }
  const actuatorOpen = method(actuator, 'open') as MechanicalRelayActuatorProvider['open'];
  const actuatorSet = method(actuator, 'setState') as MechanicalRelayActuatorProvider['setState'];
  const actuatorRelease = method(actuator, 'release') as MechanicalRelayActuatorProvider['release'];
  const actuatorStop = method(actuator, 'stop') as MechanicalRelayActuatorProvider['stop'];
  const actuatorClose = method(actuator, 'close') as MechanicalRelayActuatorProvider['close'];
  const actuatorSettled = method(actuator, 'whenSettled') as MechanicalRelayActuatorProvider['whenSettled'];
  const feedbackOpen = method(feedback, 'open') as MechanicalRelayFeedbackProvider['open'];
  const feedbackRead = method(feedback, 'read') as MechanicalRelayFeedbackProvider['read'];
  const feedbackStop = method(feedback, 'stop') as MechanicalRelayFeedbackProvider['stop'];
  const feedbackClose = method(feedback, 'close') as MechanicalRelayFeedbackProvider['close'];
  const feedbackSettled = method(feedback, 'whenSettled') as MechanicalRelayFeedbackProvider['whenSettled'];
  if (actuator.supported !== true || actuator.softwareOnly !== true || actuator.watchdogMs !== 250 ||
    feedback.supported !== true || feedback.softwareOnly !== true) throw new TypeError('Unsupported providers');

  const owner = options.ownerSignal;
  const authorizeActivation = options.authorizeActivation as MechanicalRelayOptions['authorizeActivation'];
  const authorizeSet = options.authorizeSet as MechanicalRelayOptions['authorizeSet'];
  const authorizeFeedback = options.authorizeFeedback as MechanicalRelayOptions['authorizeFeedback'];
  const onRetire = options.onRetire as MechanicalRelayOptions['onRetire'];
  const ownedScope = Object.freeze({ ...scope }) as unknown as RelayScope;
  const relay = Object.freeze({ id: selected.id as string, profileId: selected.profileId as typeof MECHANICAL_RELAY_PROFILE.id });
  const ownershipToken = Symbol('mechanical-relay-owner');
  const setRecords = new Set<string>();
  const observationRecords = new Set<string>();
  let terminal = isAborted(owner);
  let generation = 0;
  let starts = 0;
  let setAttempts = 0;
  let completedSets = 0;
  let observationAttempts = 0;
  let freshObservations = 0;
  let rawSetPending = 0;
  let rawObservationPending = 0;
  let opening = false;
  let active: ActiveSession | undefined;
  let logicalTarget: RelayState | 'unknown' = 'unknown';
  let latestObservationRelation: RelayFeedbackObservation['relation'] | 'unknown' = 'unknown';
  let lastFeedbackSequence = 0;
  let closePromise: Promise<void> | undefined;
  let detachOwner = () => {};

  const current = (session: ActiveSession) => !terminal && active === session && !session.retired &&
    session.generation === generation && providerOwners.get(actuator) === ownershipToken &&
    providerOwners.get(feedback) === ownershipToken && !isAborted(owner) && !isAborted(session.grant.signal) &&
    performance.now() < session.grant.expiresAt;

  function approval(action: RelayApprovalRequest['action'], purpose: string, deadline: number, atGeneration: number,
    extra: Partial<RelayApprovalRequest> = {}) {
    const request = Object.freeze({ action, ...ownedScope, relayId: relay.id, profileId: relay.profileId,
      generation: atGeneration, purpose, deadline, watchdogMs: 250 as const, ...extra }) as RelayApprovalRequest;
    let response: unknown;
    try {
      response = action === 'activate-relay' ? authorizeActivation(request) :
        action === 'set-relay-state' ? authorizeSet(request) : authorizeFeedback(request);
    } catch { return; }
    if (generation !== atGeneration || terminal || isAborted(owner)) return;
    const grant = plain(response, ['request', 'signal', 'expiresAt']);
    const now = performance.now();
    if (!grant || grant.request !== request || !genuineSignal(grant.signal) || isAborted(grant.signal) ||
      typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now ||
      grant.expiresAt > now + MECHANICAL_RELAY_LIMITS.sessionMs) return;
    return Object.freeze({ signal: grant.signal, expiresAt: grant.expiresAt });
  }

  function retire(session: ActiveSession): Promise<void> {
    if (session.stopping) return session.stopping;
    let complete!: () => void;
    const shared = new Promise<void>(resolve => { complete = resolve; });
    session.stopping = shared;
    session.retired = true;
    session.detach?.();
    session.effectDetach?.();
    session.feedbackDetach?.();
    if (session.expiry) clearTimeout(session.expiry);
    if (session.watchdog) clearTimeout(session.watchdog);
    if (session.effectExpiry) clearTimeout(session.effectExpiry);
    if (session.feedbackExpiry) clearTimeout(session.feedbackExpiry);
    if (!session.withdrawn) {
      session.withdrawn = true;
      try { onRetire(); } catch { /* Withdrawal failure cannot skip local release. */ }
    }
    session.controller.abort();
    const ownsActuator = providerOwners.get(actuator) === ownershipToken;
    const ownsFeedback = providerOwners.get(feedback) === ownershipToken;
    let releaseSettlement = Promise.resolve();
    if (ownsActuator && !session.released) {
      session.released = true;
      try { releaseSettlement = Promise.resolve(actuatorRelease({ generation: session.generation })); }
      catch { /* Continue settlement. */ }
    }
    if (ownsActuator && !session.actuatorStopped) {
      session.actuatorStopped = true;
      try { actuatorStop(); } catch { /* Continue settlement. */ }
    }
    if (ownsFeedback && !session.feedbackStopped) {
      session.feedbackStopped = true;
      try { feedbackStop(); } catch { /* Continue settlement. */ }
    }
    let actuatorSettlement = Promise.resolve();
    let feedbackSettlement = Promise.resolve();
    if (ownsActuator) try { actuatorSettlement = Promise.resolve(actuatorSettled()); } catch { /* Continue close. */ }
    if (ownsFeedback) try { feedbackSettlement = Promise.resolve(feedbackSettled()); } catch { /* Continue close. */ }
    void Promise.allSettled([
      ...(session.openOperation ? [session.openOperation] : []),
      ...(session.setOperation ? [session.setOperation] : []),
      ...(session.feedbackOperation ? [session.feedbackOperation] : []),
      releaseSettlement,
      actuatorSettlement, feedbackSettlement]).then(async () => {
      if (providerOwners.get(actuator) === ownershipToken) {
        try { await actuatorClose(); } catch { /* Final settlement still runs. */ }
        try { await actuatorSettled(); } catch { /* Exact ownership releases after hook attempt. */ }
      }
      if (providerOwners.get(feedback) === ownershipToken) {
        try { await feedbackClose(); } catch { /* Final settlement still runs. */ }
        try { await feedbackSettled(); } catch { /* Exact ownership releases after hook attempt. */ }
      }
      if (active === session) active = undefined;
      if (providerOwners.get(actuator) === ownershipToken) providerOwners.delete(actuator);
      if (providerOwners.get(feedback) === ownershipToken) providerOwners.delete(feedback);
      logicalTarget = 'unknown';
      latestObservationRelation = 'unknown';
      lastFeedbackSequence = 0;
    }).finally(complete);
    return shared;
  }

  async function start(request: Readonly<{ purpose: string; deadline: number }>): Promise<RelayResult<MechanicalRelayEpoch>> {
    const value = plain(request, ['purpose', 'deadline']);
    if (!value || !validPurpose(value.purpose) || !validDeadline(value.deadline)) return failure('invalid');
    if (terminal) return failure('closed');
    if (opening || active) return failure('busy');
    if (starts >= MECHANICAL_RELAY_LIMITS.starts) return failure('quota');
    starts++;
    opening = true;
    const atGeneration = ++generation;
    try {
      const grant = approval('activate-relay', value.purpose, value.deadline, atGeneration);
      if (!grant || generation !== atGeneration || !opening || terminal) return failure('denied');
      if (providerOwners.has(actuator)) return failure('busy');
      providerOwners.set(actuator, ownershipToken);
      if (providerOwners.has(feedback)) {
        providerOwners.delete(actuator);
        return failure('busy');
      }
      providerOwners.set(feedback, ownershipToken);
      const session: ActiveSession = {
        generation: atGeneration,
        epoch: Object.freeze({}),
        grant,
        controller: new AbortController(),
        ready: false,
        retired: false,
        withdrawn: false,
        released: false,
        actuatorStopped: false,
        feedbackStopped: false,
      };
      active = session;
      const stop = () => { void retire(session); };
      owner.addEventListener('abort', stop, { once: true });
      grant.signal.addEventListener('abort', stop, { once: true });
      session.detach = () => {
        owner.removeEventListener('abort', stop);
        grant.signal.removeEventListener('abort', stop);
      };
      session.expiry = setTimeout(stop, Math.max(0, Math.ceil(grant.expiresAt - performance.now())));
      const deadline = Math.min(value.deadline, grant.expiresAt);
      let issued = false;
      const timer = setTimeout(stop, Math.max(0, Math.ceil(deadline - performance.now())));
      const openingTask = Promise.resolve().then(async () => {
        if (!current(session) || performance.now() >= deadline) throw new Error('cancelled');
        issued = true;
        const actuatorResult = await actuatorOpen({ generation: atGeneration, purpose: value.purpose as string,
          deadline, signal: session.controller.signal });
        if (actuatorResult !== 'ready' || !current(session)) return actuatorResult;
        return feedbackOpen({ generation: atGeneration, purpose: value.purpose as string,
          deadline, signal: session.controller.signal });
      });
      session.openOperation = openingTask;
      try {
        const result = await openingTask;
        clearTimeout(timer);
        if (!current(session) || performance.now() >= deadline || result !== 'ready') {
          await retire(session);
          return failure(result === 'unavailable' ? 'unsupported' : performance.now() >= deadline ? 'expired' : 'cancelled', issued);
        }
        session.ready = true;
        session.openOperation = undefined;
        return success(session.epoch);
      } catch {
        clearTimeout(timer);
        await retire(session);
        return failure(performance.now() >= deadline ? 'expired' : 'provider', issued);
      }
    } finally {
      opening = false;
    }
  }

  async function setState(epoch: MechanicalRelayEpoch, request: Readonly<{ operationId: string; state: RelayState;
    purpose: string; signal: AbortSignal; deadline: number }>): Promise<RelayResult<RelaySetCompletion>> {
    const value = plain(request, ['operationId', 'state', 'purpose', 'signal', 'deadline']);
    if (!value || !validId(value.operationId) || !MECHANICAL_RELAY_PROFILE.states.includes(value.state as RelayState) ||
      !validPurpose(value.purpose) || !genuineSignal(value.signal) || !validDeadline(value.deadline)) return failure('invalid');
    if (isAborted(value.signal as AbortSignal)) return failure('cancelled');
    if (terminal) return failure('closed');
    const session = active;
    if (!session?.ready || session.epoch !== epoch || !current(session)) return failure('denied');
    if (rawSetPending >= MECHANICAL_RELAY_LIMITS.rawSetPending) return failure('busy');
    if (setRecords.has(value.operationId)) return failure('replay');
    if (setAttempts >= MECHANICAL_RELAY_LIMITS.setAttempts) return failure('quota');
    setAttempts++;
    setRecords.add(value.operationId);
    rawSetPending++;
    let issued = false;
    try {
      const grant = approval('set-relay-state', value.purpose, value.deadline, session.generation,
        { operationId: value.operationId, state: value.state as RelayState });
      if (!grant || !current(session) || isAborted(value.signal as AbortSignal)) return failure('denied');
      const deadline = Math.min(value.deadline, grant.expiresAt, session.grant.expiresAt);
      if (performance.now() >= deadline) return failure('expired');
      const timer = setTimeout(() => { void retire(session); }, Math.max(0, Math.ceil(deadline - performance.now())));
      const task = Promise.resolve().then(() => {
        if (!current(session) || isAborted(value.signal as AbortSignal) || isAborted(grant.signal) || performance.now() >= deadline) throw new Error('cancelled');
        issued = true;
        return actuatorSet(value.state as RelayState, { generation: session.generation, operationId: value.operationId as string,
          purpose: value.purpose as string, deadline, signal: session.controller.signal });
      });
      session.setOperation = task;
      try {
        const result = await task;
        if (!current(session) || isAborted(value.signal as AbortSignal) || isAborted(grant.signal) || performance.now() >= deadline) {
          await retire(session);
          return failure(performance.now() >= deadline ? 'expired' : 'cancelled', issued, issued);
        }
        if (result !== 'completed') {
          if (result !== 'interlock-open') await retire(session);
          return failure(result === 'interlock-open' ? 'interlock-open' : result === 'unavailable' ? 'unsupported' : 'provider', issued, issued);
        }
        completedSets++;
        logicalTarget = value.state as RelayState;
        session.effectDetach?.();
        if (session.effectExpiry) clearTimeout(session.effectExpiry);
        const effectCancelled = () => { void retire(session); };
        (value.signal as AbortSignal).addEventListener('abort', effectCancelled, { once: true });
        grant.signal.addEventListener('abort', effectCancelled, { once: true });
        session.effectDetach = () => {
          (value.signal as AbortSignal).removeEventListener('abort', effectCancelled);
          grant.signal.removeEventListener('abort', effectCancelled);
        };
        session.effectExpiry = setTimeout(effectCancelled, Math.max(0, Math.ceil(deadline - performance.now())));
        if (session.watchdog) clearTimeout(session.watchdog);
        if (logicalTarget === 'on') session.watchdog = setTimeout(() => { void retire(session); }, MECHANICAL_RELAY_LIMITS.watchdogMs);
        return success(Object.freeze({ operationId: value.operationId as string, target: logicalTarget,
          providerCompletion: true as const, effect: 'issued-uncertain' as const, observedState: 'unknown' as const,
          physical: false as const, physicalState: 'unverified' as const }));
      } catch {
        if (issued) await retire(session);
        return failure(performance.now() >= deadline ? 'expired' : 'provider', issued, issued);
      } finally {
        clearTimeout(timer);
        if (session.setOperation === task) session.setOperation = undefined;
      }
    } finally {
      rawSetPending--;
    }
  }

  async function observe(epoch: MechanicalRelayEpoch, request: Readonly<{ operationId: string; purpose: string;
    signal: AbortSignal; deadline: number }>): Promise<RelayResult<RelayFeedbackObservation>> {
    const value = plain(request, ['operationId', 'purpose', 'signal', 'deadline']);
    if (!value || !validId(value.operationId) || !validPurpose(value.purpose) || !genuineSignal(value.signal) ||
      !validDeadline(value.deadline)) return failure('invalid');
    if (isAborted(value.signal as AbortSignal)) return failure('cancelled');
    if (terminal) return failure('closed');
    const session = active;
    if (!session?.ready || session.epoch !== epoch || !current(session)) return failure('denied');
    if (rawObservationPending >= MECHANICAL_RELAY_LIMITS.rawObservationPending) return failure('busy');
    if (observationRecords.has(value.operationId)) return failure('replay');
    if (observationAttempts >= MECHANICAL_RELAY_LIMITS.observationAttempts) return failure('quota');
    observationAttempts++;
    observationRecords.add(value.operationId);
    rawObservationPending++;
    let issued = false;
    try {
      const grant = approval('observe-relay-feedback', value.purpose, value.deadline, session.generation,
        { operationId: value.operationId, maxSamples: 1 });
      if (!grant || !current(session) || isAborted(value.signal as AbortSignal)) return failure('denied');
      const deadline = Math.min(value.deadline, grant.expiresAt, session.grant.expiresAt);
      if (performance.now() >= deadline) return failure('expired');
      const timer = setTimeout(() => { void retire(session); }, Math.max(0, Math.ceil(deadline - performance.now())));
      const task = Promise.resolve().then(() => {
        if (!current(session) || isAborted(value.signal as AbortSignal) || isAborted(grant.signal) || performance.now() >= deadline) throw new Error('cancelled');
        issued = true;
        return feedbackRead({ generation: session.generation, operationId: value.operationId as string,
          purpose: value.purpose as string, deadline, signal: session.controller.signal });
      });
      session.feedbackOperation = task;
      try {
        const sample = await task;
        const receivedAt = performance.now();
        if (!current(session) || isAborted(value.signal as AbortSignal) || isAborted(grant.signal) || receivedAt >= deadline) {
          await retire(session);
          return failure(receivedAt >= deadline ? 'expired' : 'cancelled', issued);
        }
        if (!sample || !MECHANICAL_RELAY_PROFILE.states.includes(sample.state) || typeof sample.limitSafe !== 'boolean' ||
          !Number.isSafeInteger(sample.sequence) || sample.sequence < 1 || !validId(sample.sourceClockId) ||
          typeof sample.sourceMonotonicNs !== 'bigint' || sample.sourceMonotonicNs < 0n || sample.sequence !== lastFeedbackSequence + 1) {
          return failure('out-of-order', issued);
        }
        lastFeedbackSequence = sample.sequence;
        const relation = logicalTarget === 'unknown' ? 'no-target' : sample.state === logicalTarget ? 'matches-target' : 'contradicts-target';
        latestObservationRelation = relation;
        freshObservations++;
        session.feedbackDetach?.();
        if (session.feedbackExpiry) clearTimeout(session.feedbackExpiry);
        const feedbackCancelled = () => { void retire(session); };
        (value.signal as AbortSignal).addEventListener('abort', feedbackCancelled, { once: true });
        grant.signal.addEventListener('abort', feedbackCancelled, { once: true });
        session.feedbackDetach = () => {
          (value.signal as AbortSignal).removeEventListener('abort', feedbackCancelled);
          grant.signal.removeEventListener('abort', feedbackCancelled);
        };
        session.feedbackExpiry = setTimeout(feedbackCancelled, Math.max(0, Math.ceil(deadline - performance.now())));
        return success(Object.freeze({ operationId: value.operationId as string, state: sample.state,
          limitSafe: sample.limitSafe, sensorSequence: sample.sequence, relation,
          feedbackSource: 'software-state' as const, physical: false as const, physicalState: 'unverified' as const,
          captureTimeKnown: false as const, freshnessBasis: 'gateway-receipt' as const,
          sourceClockId: sample.sourceClockId, sourceMonotonicNs: sample.sourceMonotonicNs,
          sourceClockMapping: null, receivedAt, feedbackGeneration: session.generation,
          gatewayReceiptSequence: freshObservations,
          receiptClockDomain: 'mechanical-relay-gateway-monotonic' as const,
          providerKind: 'software-fixture' as const }));
      } catch {
        if (issued) await retire(session);
        return failure(performance.now() >= deadline ? 'expired' : 'provider', issued);
      } finally {
        clearTimeout(timer);
        if (session.feedbackOperation === task) session.feedbackOperation = undefined;
      }
    } finally {
      rawObservationPending--;
    }
  }

  async function stop(): Promise<void> {
    generation++;
    opening = false;
    const session = active;
    if (session) await retire(session);
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    terminal = true;
    generation++;
    opening = false;
    detachOwner();
    closePromise = Promise.resolve().then(async () => {
      const session = active;
      if (session) await retire(session);
    });
    return closePromise;
  }

  if (!terminal) {
    const ownerAborted = () => { terminal = true; void stop(); };
    owner.addEventListener('abort', ownerAborted, { once: true });
    detachOwner = () => {
      owner.removeEventListener('abort', ownerAborted);
      detachOwner = () => {};
    };
  }

  return Object.freeze({
    start,
    setState,
    observe,
    stop,
    close,
    status: () => Object.freeze({
      phase: terminal ? 'closed' : opening ? 'opening' : active?.retired ? 'retiring' : active?.ready ? 'ready' : 'idle',
      starts,
      setAttempts,
      completedSets,
      observationAttempts,
      freshObservations,
      retainedSetRecords: setRecords.size,
      retainedObservationRecords: observationRecords.size,
      rawSetPending,
      rawObservationPending,
      logicalTarget,
      latestObservationRelation,
    }),
  });
}
