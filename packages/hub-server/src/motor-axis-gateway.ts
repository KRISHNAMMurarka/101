export const MOTOR_AXIS_PROFILE = Object.freeze({
  id: 'app:bounded-linear-axis-mm-software/1' as const,
  minMm: 0,
  maxMm: 10,
  resolutionMm: 1,
  parkMm: 0,
  softwareSlewMmPerSecond: 50,
  softwareStepMm: 1,
  nominalSoftwareStepMs: 20,
  deadmanMs: 250,
});

export const MOTOR_AXIS_LIMITS = Object.freeze({
  starts: 8,
  setAttempts: 16,
  observeAttempts: 32,
  operationMs: 500,
  sessionMs: 60_000,
});

type AxisFailure = 'invalid' | 'closed' | 'busy' | 'denied' | 'unavailable' | 'cancelled' |
  'expired' | 'retired' | 'quota' | 'replay' | 'interlock-open' | 'out-of-order';
export type MotorAxisResult<T> = Readonly<{ ok: true; value: T }> |
  Readonly<{ ok: false; reason: AxisFailure; issued?: true; effect?: 'uncertain' }>;
export type MotorAxisEpoch = Readonly<Record<never, never>>;
export type MotorAxisSessionToken = Readonly<Record<never, never>>;

export interface MotorAxisInvalidation {
  readonly generation: number;
  readonly sessionToken: MotorAxisSessionToken;
  readonly reason: 'deadman' | 'interlock-trip';
}

export interface MotorAxisOpenContext {
  readonly generation: number;
  readonly sessionToken: MotorAxisSessionToken;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly invalidate: (event: MotorAxisInvalidation) => void;
}

export interface MotorAxisOperationContext {
  readonly generation: number;
  readonly operationId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

export interface MotorAxisActuatorProvider {
  readonly supported: true;
  readonly softwareOnly: true;
  readonly profileId: typeof MOTOR_AXIS_PROFILE.id;
  readonly deadmanMs: 250;
  open(context: MotorAxisOpenContext): 'ready' | 'unavailable' | Promise<'ready' | 'unavailable'>;
  setPosition(targetMm: number, context: MotorAxisOperationContext):
    'completed' | 'interlock-open' | 'unavailable' | Promise<'completed' | 'interlock-open' | 'unavailable'>;
  release(context: Readonly<{ generation: number }>): void | Promise<void>;
  stop(): void;
  close(): void | Promise<void>;
  whenSettled(): void | Promise<void>;
}

export interface MotorAxisFeedbackSample {
  readonly positionMm: number;
  readonly lowerLimitSafe: boolean;
  readonly upperLimitSafe: boolean;
  readonly sequence: number;
  readonly sourceClockId: string;
  readonly sourceMonotonicNs: bigint;
}

export interface MotorAxisFeedbackProvider {
  readonly supported: true;
  readonly softwareOnly: true;
  readonly profileId: typeof MOTOR_AXIS_PROFILE.id;
  open(context: Omit<MotorAxisOpenContext, 'invalidate'>): 'ready' | 'unavailable' | Promise<'ready' | 'unavailable'>;
  read(context: MotorAxisOperationContext): MotorAxisFeedbackSample | Promise<MotorAxisFeedbackSample>;
  stop(): void;
  close(): void | Promise<void>;
  whenSettled(): void | Promise<void>;
}

export interface MotorAxisScope {
  readonly principalId: string;
  readonly applicationId: string;
  readonly sessionId: string;
}

export interface MotorAxisApprovalRequest extends MotorAxisScope {
  readonly action: 'activate-axis' | 'set-axis-position' | 'observe-axis-position';
  readonly axisId: string;
  readonly profileId: typeof MOTOR_AXIS_PROFILE.id;
  readonly generation: number;
  readonly purpose: string;
  readonly deadline: number;
  readonly deadmanMs: 250;
  readonly targetMm?: number;
  readonly operationId?: string;
}

export interface MotorAxisGrant {
  readonly request: MotorAxisApprovalRequest;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
}

export interface MotorAxisOptions {
  readonly ownerSignal: AbortSignal;
  readonly scope: MotorAxisScope;
  readonly selectedAxis: Readonly<{ id: string; profileId: typeof MOTOR_AXIS_PROFILE.id }>;
  readonly actuatorProvider: MotorAxisActuatorProvider;
  readonly feedbackProvider: MotorAxisFeedbackProvider;
  readonly authorizeActivation: (request: MotorAxisApprovalRequest) => MotorAxisGrant | undefined;
  readonly authorizeSet: (request: MotorAxisApprovalRequest) => MotorAxisGrant | undefined;
  readonly authorizeObserve: (request: MotorAxisApprovalRequest) => MotorAxisGrant | undefined;
  readonly onRetire: () => void;
}

export interface MotorAxisSetReceipt {
  readonly operationId: string;
  readonly targetMm: number;
  readonly providerCompletion: true;
  readonly effect: 'issued-uncertain';
  readonly observedPositionMm: 'unknown';
  readonly physical: false;
  readonly physicalState: 'unverified';
}

export interface MotorAxisObservation {
  readonly positionMm: number;
  readonly lowerLimitSafe: boolean;
  readonly upperLimitSafe: boolean;
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
  readonly feedbackGeneration: number;
  readonly gatewayReceiptSequence: number;
  readonly gatewayReceivedAt: number;
  readonly receiptClockDomain: 'motor-axis-gateway-monotonic';
  readonly providerKind: 'software-fixture';
}

export interface MotorAxisGateway {
  start(request: Readonly<{ purpose: string; deadline: number }>): Promise<MotorAxisResult<MotorAxisEpoch>>;
  setPosition(epoch: MotorAxisEpoch, request: Readonly<{ operationId: string; targetMm: number; purpose: string;
    signal: AbortSignal; deadline: number }>): Promise<MotorAxisResult<MotorAxisSetReceipt>>;
  observePosition(epoch: MotorAxisEpoch, request: Readonly<{ operationId: string; purpose: string;
    signal: AbortSignal; deadline: number }>): Promise<MotorAxisResult<MotorAxisObservation>>;
  stop(): Promise<void>;
  close(): Promise<void>;
  status(): Readonly<{ phase: 'idle' | 'opening' | 'ready' | 'retiring' | 'closed'; generation: number;
    setAttempts: number; observeAttempts: number; rawSetPending: number; rawObservePending: number;
    logicalTargetMm: number | 'unknown' }>;
}

const providerOwners = new WeakMap<object, symbol>();

const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function aborted(signal: AbortSignal): boolean {
  try { return signalAborted.call(signal) as boolean; } catch { return true; }
}

function genuineSignal(value: unknown): value is AbortSignal {
  try { signalAborted.call(value); return true; } catch { return false; }
}

function plain(value: unknown, required: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !required.includes(key)) return;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return;
      result[key] = descriptor.value;
    }
    return required.every(key => Object.hasOwn(result, key)) ? result : undefined;
  } catch { return; }
}

const validId = (value: unknown, max = 128): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const validPurpose = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 160;
const validDeadline = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) &&
  value > performance.now() && value <= performance.now() + MOTOR_AXIS_LIMITS.operationMs;
const validTarget = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) &&
  value >= MOTOR_AXIS_PROFILE.minMm && value <= MOTOR_AXIS_PROFILE.maxMm;
const success = <T>(value: T): MotorAxisResult<T> => Object.freeze({ ok: true, value });
const failure = <T = never>(reason: AxisFailure, issued = false, uncertain = false): MotorAxisResult<T> => Object.freeze({
  ok: false,
  reason,
  ...(issued ? { issued: true as const } : {}),
  ...(uncertain ? { effect: 'uncertain' as const } : {}),
});

interface ActiveSession {
  generation: number;
  epoch: MotorAxisEpoch;
  sessionToken: MotorAxisSessionToken;
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
  releaseOperation?: Promise<unknown>;
  stopping?: Promise<void>;
  detach?: () => void;
  expiry?: ReturnType<typeof setTimeout>;
  effectDetach?: () => void;
  effectExpiry?: ReturnType<typeof setTimeout>;
  setReserved?: boolean;
  observeReserved?: boolean;
}

export function createMotorAxisGateway(input: MotorAxisOptions): MotorAxisGateway {
  const options = plain(input, ['ownerSignal', 'scope', 'selectedAxis', 'actuatorProvider', 'feedbackProvider',
    'authorizeActivation', 'authorizeSet', 'authorizeObserve', 'onRetire']);
  const scope = plain(options?.scope, ['principalId', 'applicationId', 'sessionId']);
  const selected = plain(options?.selectedAxis, ['id', 'profileId']);
  const actuator = options?.actuatorProvider as MotorAxisActuatorProvider;
  const feedback = options?.feedbackProvider as MotorAxisFeedbackProvider;
  if (!options || !genuineSignal(options.ownerSignal) || !scope || !Object.values(scope).every(value => validId(value)) ||
    !selected || !validId(selected.id) || selected.profileId !== MOTOR_AXIS_PROFILE.id || !actuator || !feedback ||
    actuator === feedback as unknown || typeof options.authorizeActivation !== 'function' ||
    typeof options.authorizeSet !== 'function' || typeof options.authorizeObserve !== 'function' ||
    typeof options.onRetire !== 'function') throw new TypeError('Invalid selected motor axis');

  function method<T extends object>(provider: T, name: keyof T): (...args: never[]) => unknown {
    const descriptor = Object.getOwnPropertyDescriptor(provider, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function')
      throw new TypeError(`Invalid provider ${String(name)}`);
    return descriptor.value.bind(provider) as (...args: never[]) => unknown;
  }
  const actuatorOpen = method(actuator, 'open') as MotorAxisActuatorProvider['open'];
  const actuatorSet = method(actuator, 'setPosition') as MotorAxisActuatorProvider['setPosition'];
  const actuatorRelease = method(actuator, 'release') as MotorAxisActuatorProvider['release'];
  const actuatorStop = method(actuator, 'stop') as MotorAxisActuatorProvider['stop'];
  const actuatorClose = method(actuator, 'close') as MotorAxisActuatorProvider['close'];
  const actuatorSettled = method(actuator, 'whenSettled') as MotorAxisActuatorProvider['whenSettled'];
  const feedbackOpen = method(feedback, 'open') as MotorAxisFeedbackProvider['open'];
  const feedbackRead = method(feedback, 'read') as MotorAxisFeedbackProvider['read'];
  const feedbackStop = method(feedback, 'stop') as MotorAxisFeedbackProvider['stop'];
  const feedbackClose = method(feedback, 'close') as MotorAxisFeedbackProvider['close'];
  const feedbackSettled = method(feedback, 'whenSettled') as MotorAxisFeedbackProvider['whenSettled'];
  if (actuator.supported !== true || actuator.softwareOnly !== true || actuator.profileId !== MOTOR_AXIS_PROFILE.id ||
    actuator.deadmanMs !== MOTOR_AXIS_PROFILE.deadmanMs || feedback.supported !== true ||
    feedback.softwareOnly !== true || feedback.profileId !== MOTOR_AXIS_PROFILE.id) throw new TypeError('Unsupported providers');

  const owner = options.ownerSignal;
  const authorizeActivation = options.authorizeActivation as MotorAxisOptions['authorizeActivation'];
  const authorizeSet = options.authorizeSet as MotorAxisOptions['authorizeSet'];
  const authorizeObserve = options.authorizeObserve as MotorAxisOptions['authorizeObserve'];
  const onRetire = options.onRetire as MotorAxisOptions['onRetire'];
  const ownedScope = Object.freeze({ ...scope }) as unknown as MotorAxisScope;
  const axis = Object.freeze({ id: selected.id as string, profileId: MOTOR_AXIS_PROFILE.id });
  const ownershipToken = Symbol('motor-axis-owner');
  const setIds = new Set<string>();
  const observeIds = new Set<string>();
  let terminal = aborted(owner);
  let opening = false;
  let generation = 0;
  let starts = 0;
  let setAttempts = 0;
  let observeAttempts = 0;
  let rawSetPending = 0;
  let rawObservePending = 0;
  let logicalTargetMm: number | 'unknown' = 'unknown';
  let lastFeedbackSequence = 0;
  let gatewayReceiptSequence = 0;
  let active: ActiveSession | undefined;
  let closePromise: Promise<void> | undefined;
  let detachOwner = () => {};

  const owns = (session: ActiveSession) => providerOwners.get(actuator) === ownershipToken &&
    providerOwners.get(feedback) === ownershipToken && active === session;
  const current = (session: ActiveSession) => !terminal && owns(session) && !session.retired &&
    session.generation === generation && !aborted(owner) && !aborted(session.grant.signal) &&
    performance.now() < session.grant.expiresAt;

  function approval(action: MotorAxisApprovalRequest['action'], purpose: string, deadline: number,
    atGeneration: number, targetMm?: number, operationId?: string) {
    const request = Object.freeze({ action, ...ownedScope, axisId: axis.id, profileId: axis.profileId,
      generation: atGeneration, purpose, deadline, deadmanMs: MOTOR_AXIS_PROFILE.deadmanMs,
      ...(targetMm === undefined ? {} : { targetMm }),
      ...(operationId === undefined ? {} : { operationId }) }) as MotorAxisApprovalRequest;
    let response: unknown;
    try {
      response = action === 'activate-axis' ? authorizeActivation(request) :
        action === 'set-axis-position' ? authorizeSet(request) : authorizeObserve(request);
    } catch { return; }
    if (generation !== atGeneration || terminal || aborted(owner)) return;
    const grant = plain(response, ['request', 'signal', 'expiresAt']);
    const now = performance.now();
    if (!grant || grant.request !== request || !genuineSignal(grant.signal) || aborted(grant.signal) ||
      typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now ||
      grant.expiresAt > now + MOTOR_AXIS_LIMITS.sessionMs) return;
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
    if (session.effectExpiry) clearTimeout(session.effectExpiry);
    if (session.expiry) clearTimeout(session.expiry);
    if (!session.withdrawn) {
      session.withdrawn = true;
      try { onRetire(); } catch { /* Local cleanup remains mandatory. */ }
    }
    session.controller.abort();
    const ownsActuator = providerOwners.get(actuator) === ownershipToken;
    const ownsFeedback = providerOwners.get(feedback) === ownershipToken;
    if (ownsActuator && !session.released) {
      session.released = true;
      let finishRelease!: () => void;
      session.releaseOperation = new Promise<void>(resolve => { finishRelease = resolve; });
      try { void Promise.resolve(actuatorRelease({ generation: session.generation })).then(finishRelease, finishRelease); }
      catch { finishRelease(); }
    }
    if (ownsActuator && !session.actuatorStopped) {
      session.actuatorStopped = true;
      try { actuatorStop(); } catch { /* Join captured settlement below. */ }
    }
    if (ownsFeedback && !session.feedbackStopped) {
      session.feedbackStopped = true;
      try { feedbackStop(); } catch { /* Join captured settlement below. */ }
    }
    let actuatorSettlement = Promise.resolve();
    let feedbackSettlement = Promise.resolve();
    if (ownsActuator) try { actuatorSettlement = Promise.resolve(actuatorSettled()); } catch { /* Close still runs. */ }
    if (ownsFeedback) try { feedbackSettlement = Promise.resolve(feedbackSettled()); } catch { /* Close still runs. */ }
    const operations = [session.openOperation, session.setOperation, session.feedbackOperation,
      session.releaseOperation, actuatorSettlement, feedbackSettlement].filter((item): item is Promise<unknown> => Boolean(item));
    void Promise.allSettled(operations).then(async () => {
      if (providerOwners.get(actuator) === ownershipToken) {
        try { await actuatorClose(); } catch { /* Final settlement still runs. */ }
        try { await actuatorSettled(); } catch { /* Ownership release still runs. */ }
      }
      if (providerOwners.get(feedback) === ownershipToken) {
        try { await feedbackClose(); } catch { /* Final settlement still runs. */ }
        try { await feedbackSettled(); } catch { /* Ownership release still runs. */ }
      }
      if (active === session) active = undefined;
      if (providerOwners.get(actuator) === ownershipToken) providerOwners.delete(actuator);
      if (providerOwners.get(feedback) === ownershipToken) providerOwners.delete(feedback);
      if (session.setReserved) { rawSetPending--; session.setReserved = false; }
      if (session.observeReserved) { rawObservePending--; session.observeReserved = false; }
      logicalTargetMm = 'unknown';
      lastFeedbackSequence = 0;
    }).finally(complete);
    return shared;
  }

  async function start(request: Readonly<{ purpose: string; deadline: number }>): Promise<MotorAxisResult<MotorAxisEpoch>> {
    const value = plain(request, ['purpose', 'deadline']);
    if (!value || !validPurpose(value.purpose) || !validDeadline(value.deadline)) return failure('invalid');
    if (terminal) return failure('closed');
    if (opening || active) return failure('busy');
    if (starts >= MOTOR_AXIS_LIMITS.starts) return failure('quota');
    starts++;
    opening = true;
    const atGeneration = ++generation;
    try {
      const grant = approval('activate-axis', value.purpose, value.deadline, atGeneration);
      if (!grant || terminal || !opening || generation !== atGeneration) return failure('denied');
      if (providerOwners.has(actuator)) return failure('busy');
      providerOwners.set(actuator, ownershipToken);
      if (providerOwners.has(feedback)) {
        if (providerOwners.get(actuator) === ownershipToken) providerOwners.delete(actuator);
        return failure('busy');
      }
      providerOwners.set(feedback, ownershipToken);
      const session: ActiveSession = {
        generation: atGeneration,
        epoch: Object.freeze({}),
        sessionToken: Object.freeze({}),
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
      const invalidate = (event: MotorAxisInvalidation) => {
        const parsed = plain(event, ['generation', 'sessionToken', 'reason']);
        if (!parsed || parsed.generation !== session.generation || parsed.sessionToken !== session.sessionToken ||
          (parsed.reason !== 'deadman' && parsed.reason !== 'interlock-trip') || !current(session)) return;
        void retire(session);
      };
      const effectiveDeadline = Math.min(value.deadline as number, grant.expiresAt);
      const retireOnGrant = () => { void retire(session); };
      grant.signal.addEventListener('abort', retireOnGrant, { once: true });
      session.detach = () => grant.signal.removeEventListener('abort', retireOnGrant);
      session.expiry = setTimeout(retireOnGrant, Math.max(0, Math.ceil(grant.expiresAt - performance.now())));
      const openingExpiry = setTimeout(retireOnGrant, Math.max(0, Math.ceil(effectiveDeadline - performance.now())));
      const canOpen = () => current(session) && !session.controller.signal.aborted && performance.now() < effectiveDeadline;
      // Each scheduled leg is captured before either provider can reenter or throw.
      const actuatorTask = Promise.resolve().then(() => {
        if (!canOpen()) throw new Error('retired opening');
        return actuatorOpen({ generation: atGeneration, sessionToken: session.sessionToken,
          deadline: effectiveDeadline, signal: session.controller.signal, invalidate });
      }).then(result => {
        if (result !== 'ready') void retire(session);
        return result;
      }, error => { void retire(session); throw error; });
      const feedbackTask = Promise.resolve().then(() => {
        if (!canOpen()) throw new Error('retired opening');
        return feedbackOpen({ generation: atGeneration, sessionToken: session.sessionToken,
          deadline: effectiveDeadline, signal: session.controller.signal });
      }).then(result => {
        if (result !== 'ready') void retire(session);
        return result;
      }, error => { void retire(session); throw error; });
      const openTask = Promise.allSettled([actuatorTask, feedbackTask]).then(results =>
        results.every(result => result.status === 'fulfilled' && result.value === 'ready'));
      session.openOperation = openTask;
      const ready = await openTask;
      clearTimeout(openingExpiry);
      if (!ready || !current(session) || performance.now() >= effectiveDeadline) {
        await retire(session);
        return failure(performance.now() >= effectiveDeadline ? 'expired' : 'unavailable');
      }
      session.openOperation = undefined;
      session.ready = true;
      return success(session.epoch);
    } finally {
      if (generation === atGeneration) opening = false;
    }
  }

  function bindAbort(signal: AbortSignal, session: ActiveSession, controller: AbortController): () => void {
    const cancel = () => { controller.abort(); void retire(session); };
    signal.addEventListener('abort', cancel, { once: true });
    return () => signal.removeEventListener('abort', cancel);
  }

  async function setPosition(epoch: MotorAxisEpoch, requestValue: Readonly<{ operationId: string; targetMm: number;
    purpose: string; signal: AbortSignal; deadline: number }>): Promise<MotorAxisResult<MotorAxisSetReceipt>> {
    const value = plain(requestValue, ['operationId', 'targetMm', 'purpose', 'signal', 'deadline']);
    if (!value || !validId(value.operationId) || !validTarget(value.targetMm) || !validPurpose(value.purpose) ||
      !genuineSignal(value.signal) || !validDeadline(value.deadline)) return failure('invalid');
    if (aborted(value.signal)) return failure('cancelled');
    const session = active;
    if (!session || session.epoch !== epoch || !session.ready || !current(session)) return failure(terminal ? 'closed' : 'retired');
    if (setAttempts >= MOTOR_AXIS_LIMITS.setAttempts) return failure('quota');
    if (setIds.has(value.operationId)) return failure('replay');
    if (rawSetPending >= 1 || session.setOperation) return failure('busy');
    setAttempts++;
    setIds.add(value.operationId);
    rawSetPending++;
    const atGeneration = generation;
    const grant = approval('set-axis-position', value.purpose, value.deadline, atGeneration, value.targetMm, value.operationId);
    const cancelledBeforeDispatch = aborted(value.signal) || Boolean(grant && aborted(grant.signal));
    if (!grant || !current(session) || generation !== atGeneration || cancelledBeforeDispatch) {
      rawSetPending--;
      if (cancelledBeforeDispatch) {
        await retire(session);
        return failure('cancelled');
      }
      return failure('denied');
    }
    const effectiveDeadline = Math.min(value.deadline as number, grant.expiresAt, session.grant.expiresAt);
    const controller = new AbortController();
    const detachSession = bindAbort(session.controller.signal, session, controller);
    const detachCaller = bindAbort(value.signal, session, controller);
    const detachGrant = bindAbort(grant.signal, session, controller);
    if (aborted(value.signal) || aborted(grant.signal)) {
      controller.abort();
      detachSession();
      detachCaller();
      detachGrant();
      rawSetPending--;
      await retire(session);
      return failure('cancelled');
    }
    let issued = false;
    let retainsEffect = false;
    session.setReserved = true;
    const expiry = setTimeout(() => { controller.abort(); void retire(session); },
      Math.max(0, Math.ceil(effectiveDeadline - performance.now())));
    const providerTask = Promise.resolve().then(() => {
      if (!current(session) || controller.signal.aborted || aborted(value.signal as AbortSignal) || aborted(grant.signal) ||
        performance.now() >= effectiveDeadline) throw new Error('retired set');
      issued = true;
      return actuatorSet(value.targetMm as number, { generation: session.generation,
        operationId: value.operationId as string, deadline: effectiveDeadline, signal: controller.signal });
    });
    const tracked = providerTask.finally(() => {
      if (session.setOperation === tracked) session.setOperation = undefined;
    });
    session.setOperation = tracked;
    try {
      const outcome = await tracked;
      if (!current(session) || controller.signal.aborted) {
        await retire(session);
        return failure(aborted(value.signal) || aborted(grant.signal) ? 'cancelled' : 'retired', issued, issued);
      }
      if (performance.now() >= effectiveDeadline) {
        await retire(session);
        return failure('expired', issued, issued);
      }
      if (outcome === 'interlock-open') return failure('interlock-open', true, true);
      if (outcome !== 'completed') { await retire(session); return failure('unavailable', issued, issued); }
      session.effectDetach?.();
      if (session.effectExpiry) clearTimeout(session.effectExpiry);
      session.effectDetach = () => { detachSession(); detachCaller(); detachGrant(); };
      session.effectExpiry = expiry;
      retainsEffect = true;
      logicalTargetMm = value.targetMm as number;
      return success(Object.freeze({ operationId: value.operationId as string, targetMm: value.targetMm as number,
        providerCompletion: true, effect: 'issued-uncertain', observedPositionMm: 'unknown',
        physical: false, physicalState: 'unverified' }));
    } catch {
      await retire(session);
      return failure(performance.now() >= effectiveDeadline ? 'expired' :
        aborted(value.signal) || aborted(grant.signal) ? 'cancelled' : session.retired && !issued ? 'retired' : 'unavailable', issued, issued);
    } finally {
      if (!session.retired && session.setReserved) { rawSetPending--; session.setReserved = false; }
      if (!retainsEffect) { clearTimeout(expiry); detachSession(); detachCaller(); detachGrant(); }
    }
  }

  async function observePosition(epoch: MotorAxisEpoch, requestValue: Readonly<{ operationId: string; purpose: string;
    signal: AbortSignal; deadline: number }>): Promise<MotorAxisResult<MotorAxisObservation>> {
    const value = plain(requestValue, ['operationId', 'purpose', 'signal', 'deadline']);
    if (!value || !validId(value.operationId) || !validPurpose(value.purpose) || !genuineSignal(value.signal) ||
      !validDeadline(value.deadline)) return failure('invalid');
    if (aborted(value.signal)) return failure('cancelled');
    const session = active;
    if (!session || session.epoch !== epoch || !session.ready || !current(session)) return failure(terminal ? 'closed' : 'retired');
    if (observeAttempts >= MOTOR_AXIS_LIMITS.observeAttempts) return failure('quota');
    if (observeIds.has(value.operationId)) return failure('replay');
    if (rawObservePending >= 1 || session.feedbackOperation) return failure('busy');
    observeAttempts++;
    observeIds.add(value.operationId);
    rawObservePending++;
    const atGeneration = generation;
    const grant = approval('observe-axis-position', value.purpose, value.deadline, atGeneration, undefined, value.operationId);
    const cancelledBeforeDispatch = aborted(value.signal) || Boolean(grant && aborted(grant.signal));
    if (!grant || !current(session) || generation !== atGeneration || cancelledBeforeDispatch) {
      rawObservePending--;
      if (cancelledBeforeDispatch) {
        await retire(session);
        return failure('cancelled');
      }
      return failure('denied');
    }
    const effectiveDeadline = Math.min(value.deadline as number, grant.expiresAt, session.grant.expiresAt);
    const controller = new AbortController();
    const detachSession = bindAbort(session.controller.signal, session, controller);
    const detachCaller = bindAbort(value.signal, session, controller);
    const detachGrant = bindAbort(grant.signal, session, controller);
    if (aborted(value.signal) || aborted(grant.signal)) {
      controller.abort();
      detachSession();
      detachCaller();
      detachGrant();
      rawObservePending--;
      await retire(session);
      return failure('cancelled');
    }
    let issued = false;
    session.observeReserved = true;
    const expiry = setTimeout(() => { controller.abort(); void retire(session); },
      Math.max(0, Math.ceil(effectiveDeadline - performance.now())));
    const providerTask = Promise.resolve().then(() => {
      if (!current(session) || controller.signal.aborted || aborted(value.signal as AbortSignal) || aborted(grant.signal) ||
        performance.now() >= effectiveDeadline) throw new Error('retired observation');
      issued = true;
      return feedbackRead({ generation: session.generation, operationId: value.operationId as string,
        deadline: effectiveDeadline, signal: controller.signal });
    });
    const tracked = providerTask.finally(() => {
      if (session.feedbackOperation === tracked) session.feedbackOperation = undefined;
    });
    session.feedbackOperation = tracked;
    try {
      const rawSample = await tracked;
      const sample = plain(rawSample, ['positionMm', 'lowerLimitSafe', 'upperLimitSafe', 'sequence',
        'sourceClockId', 'sourceMonotonicNs']);
      if (!current(session) || controller.signal.aborted) {
        await retire(session);
        return failure(aborted(value.signal) || aborted(grant.signal) ? 'cancelled' : 'retired', issued);
      }
      if (performance.now() >= effectiveDeadline) {
        await retire(session);
        return failure('expired', issued);
      }
      if (!sample || !validTarget(sample.positionMm) || typeof sample.lowerLimitSafe !== 'boolean' ||
        typeof sample.upperLimitSafe !== 'boolean' || typeof sample.sequence !== 'number' || !Number.isSafeInteger(sample.sequence) || sample.sequence < 1 ||
        sample.sequence > MOTOR_AXIS_LIMITS.observeAttempts || !validId(sample.sourceClockId) ||
        typeof sample.sourceMonotonicNs !== 'bigint' || sample.sourceMonotonicNs < 0n) return failure('invalid', true);
      if (sample.sequence <= lastFeedbackSequence) return failure('out-of-order', true);
      lastFeedbackSequence = sample.sequence;
      const receivedAt = performance.now();
      const relation = logicalTargetMm === 'unknown' ? 'no-target' :
        sample.positionMm === logicalTargetMm ? 'matches-target' : 'contradicts-target';
      return success(Object.freeze({ positionMm: sample.positionMm, lowerLimitSafe: sample.lowerLimitSafe,
        upperLimitSafe: sample.upperLimitSafe, sensorSequence: sample.sequence, relation,
        feedbackSource: 'software-state', physical: false, physicalState: 'unverified', captureTimeKnown: false,
        freshnessBasis: 'gateway-receipt', sourceClockId: sample.sourceClockId,
        sourceMonotonicNs: sample.sourceMonotonicNs, sourceClockMapping: null,
        feedbackGeneration: session.generation, gatewayReceiptSequence: ++gatewayReceiptSequence,
        gatewayReceivedAt: receivedAt, receiptClockDomain: 'motor-axis-gateway-monotonic',
        providerKind: 'software-fixture' }));
    } catch {
      await retire(session);
      return failure(performance.now() >= effectiveDeadline ? 'expired' :
        aborted(value.signal) || aborted(grant.signal) ? 'cancelled' : session.retired && !issued ? 'retired' : 'unavailable', issued);
    } finally {
      if (!session.retired && session.observeReserved) { rawObservePending--; session.observeReserved = false; }
      clearTimeout(expiry);
      detachSession();
      detachCaller();
      detachGrant();
    }
  }

  function stop(): Promise<void> {
    generation++;
    opening = false;
    const session = active;
    return session ? retire(session) : Promise.resolve();
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    terminal = true;
    generation++;
    opening = false;
    detachOwner();
    const session = active;
    closePromise = session ? retire(session) : Promise.resolve();
    return closePromise;
  }

  const ownerClosed = () => { void close(); };
  owner.addEventListener('abort', ownerClosed, { once: true });
  detachOwner = () => owner.removeEventListener('abort', ownerClosed);

  return Object.freeze({
    start,
    setPosition,
    observePosition,
    stop,
    close,
    status: () => Object.freeze({ phase: terminal ? 'closed' : active?.retired ? 'retiring' : active?.ready ? 'ready' :
      opening ? 'opening' : 'idle', generation, setAttempts, observeAttempts, rawSetPending, rawObservePending,
      logicalTargetMm }),
  });
}
