import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMotorAxisGateway,
  MOTOR_AXIS_LIMITS,
} from './motor-axis-gateway.ts';
import type {
  MotorAxisActuatorProvider,
  MotorAxisFeedbackProvider,
  MotorAxisGateway,
  MotorAxisInvalidation,
  MotorAxisApprovalRequest,
} from './motor-axis-gateway.ts';

const scope = { principalId: 'owner', applicationId: 'axis-test', sessionId: 'session' };
const request = (operationId: string, signal = new AbortController().signal) => ({
  operationId,
  purpose: 'test selected software axis',
  signal,
  deadline: performance.now() + 450,
});

function fixture(options: {
  actuator?: Partial<MotorAxisActuatorProvider>;
  actuatorExact?: MotorAxisActuatorProvider;
  feedback?: Partial<MotorAxisFeedbackProvider>;
  feedbackExact?: MotorAxisFeedbackProvider;
  authorizeActivation?: boolean;
  authorizeSet?: boolean;
  authorizeObserve?: boolean;
  onAuthorizeSet?: (request: MotorAxisApprovalRequest) => void;
  onAuthorizeObserve?: (request: MotorAxisApprovalRequest) => void;
  onRetire?: () => void;
} = {}) {
  const owner = new AbortController();
  const control = new AbortController();
  const setGrant = new AbortController();
  const observeGrant = new AbortController();
  const calls: string[] = [];
  let setAuthorizations = 0;
  let observeAuthorizations = 0;
  const invalidations: Array<Readonly<{ callback: (event: MotorAxisInvalidation) => void;
    event: MotorAxisInvalidation }>> = [];
  const actuator: MotorAxisActuatorProvider = options.actuatorExact ?? {
    supported: true,
    softwareOnly: true,
    profileId: 'app:bounded-linear-axis-mm-software/1',
    deadmanMs: 250,
    open(context) {
      calls.push('actuator-open');
      invalidations.push(Object.freeze({ callback: context.invalidate,
        event: { generation: context.generation, sessionToken: context.sessionToken, reason: 'deadman' } }));
      return 'ready';
    },
    setPosition(targetMm) { calls.push(`set-${targetMm}`); return 'completed'; },
    release() { calls.push('release'); },
    stop() { calls.push('actuator-stop'); },
    close() { calls.push('actuator-close'); },
    whenSettled() { return Promise.resolve(); },
    ...options.actuator,
  };
  const feedback: MotorAxisFeedbackProvider = options.feedbackExact ?? {
    supported: true,
    softwareOnly: true,
    profileId: 'app:bounded-linear-axis-mm-software/1',
    open() { calls.push('feedback-open'); return 'ready'; },
    read() {
      calls.push('feedback-read');
      return { positionMm: 4, lowerLimitSafe: true, upperLimitSafe: true, sequence: 1,
        sourceClockId: 'fixture-clock', sourceMonotonicNs: 10n };
    },
    stop() { calls.push('feedback-stop'); },
    close() { calls.push('feedback-close'); },
    whenSettled() { return Promise.resolve(); },
    ...options.feedback,
  };
  const gateway = createMotorAxisGateway({
    ownerSignal: owner.signal,
    scope,
    selectedAxis: { id: 'software-axis', profileId: 'app:bounded-linear-axis-mm-software/1' },
    actuatorProvider: actuator,
    feedbackProvider: feedback,
    authorizeActivation: value => options.authorizeActivation === false ? undefined : {
      request: value, signal: control.signal, expiresAt: performance.now() + 1000,
    },
    authorizeSet: value => {
      setAuthorizations++;
      options.onAuthorizeSet?.(value);
      return options.authorizeSet === false ? undefined : {
        request: value, signal: setGrant.signal, expiresAt: performance.now() + 1000,
      };
    },
    authorizeObserve: value => {
      observeAuthorizations++;
      options.onAuthorizeObserve?.(value);
      return options.authorizeObserve === false ? undefined : {
        request: value, signal: observeGrant.signal, expiresAt: performance.now() + 1000,
      };
    },
    onRetire: options.onRetire ?? (() => {}),
  });
  return { gateway, owner, control, setGrant, observeGrant, actuator, feedback, calls,
    invalidateAt: (index: number) => {
      const item = invalidations[index];
      if (!item) throw new Error('missing invalidation');
      item.callback(item.event);
    },
    invalidationAt: (index: number) => invalidations[index]?.event,
    counts: () => ({ setAuthorizations, observeAuthorizations }) };
}

test('constructor is inert and activation denial opens neither provider', async () => {
  const value = fixture({ authorizeActivation: false });
  assert.deepEqual(value.calls, []);
  assert.deepEqual(await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 }),
    { ok: false, reason: 'denied' });
  assert.deepEqual(value.calls, []);
  await value.gateway.close();
});

test('partial provider-pair acquisition rolls back only the exact new owner', async () => {
  const seed = fixture();
  const sharedFeedback = seed.feedback;
  await seed.gateway.close();
  const holder = fixture({ feedbackExact: sharedFeedback });
  assert.ok((await holder.gateway.start({ purpose: 'holder', deadline: performance.now() + 400 })).ok);
  const contender = fixture({ feedbackExact: sharedFeedback });
  assert.deepEqual(await contender.gateway.start({ purpose: 'contender', deadline: performance.now() + 400 }),
    { ok: false, reason: 'busy' });
  assert.equal(contender.calls.includes('actuator-open'), false);
  await contender.gateway.close();
  await holder.gateway.close();
});

test('effectful open failure releases and settles both exact providers', async () => {
  const value = fixture({ actuator: { open() { return 'unavailable'; } } });
  assert.deepEqual(await value.gateway.start({ purpose: 'open failure', deadline: performance.now() + 400 }),
    { ok: false, reason: 'unavailable' });
  assert.deepEqual(value.calls.filter(call => ['release', 'actuator-stop', 'feedback-stop',
    'actuator-close', 'feedback-close'].includes(call)).sort(),
  ['actuator-close', 'actuator-stop', 'feedback-close', 'feedback-stop', 'release']);
  await value.gateway.close();
});

test('malformed targets do not consume attempts or reach authority', async () => {
  const value = fixture();
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  for (const targetMm of [-1, 11, 1.5, Number.NaN]) {
    assert.deepEqual(await value.gateway.setPosition(started.value, { ...request(`bad-${String(targetMm)}`), targetMm }),
      { ok: false, reason: 'invalid' });
  }
  assert.deepEqual(value.counts(), { setAuthorizations: 0, observeAuthorizations: 0 });
  assert.equal(value.gateway.status().setAttempts, 0);
  await value.gateway.close();
});

test('eligible attempts and ids are reserved before authority and bounded', async () => {
  const value = fixture({ authorizeSet: false });
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  for (let index = 0; index < MOTOR_AXIS_LIMITS.setAttempts; index++) {
    assert.deepEqual(await value.gateway.setPosition(started.value, { ...request(`denied-${index}`), targetMm: index % 11 }),
      { ok: false, reason: 'denied' });
  }
  assert.deepEqual(await value.gateway.setPosition(started.value, { ...request('seventeen'), targetMm: 0 }),
    { ok: false, reason: 'quota' });
  assert.equal(value.counts().setAuthorizations, MOTOR_AXIS_LIMITS.setAttempts);
  await value.gateway.close();
});

test('set completion is issued-uncertain and independent feedback carries gateway provenance', async () => {
  const value = fixture();
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  assert.deepEqual(await value.gateway.setPosition(started.value, { ...request('set-4'), targetMm: 4 }), {
    ok: true,
    value: { operationId: 'set-4', targetMm: 4, providerCompletion: true, effect: 'issued-uncertain',
      observedPositionMm: 'unknown', physical: false, physicalState: 'unverified' },
  });
  const observed = await value.gateway.observePosition(started.value, request('observe-1'));
  assert.ok(observed.ok); if (!observed.ok) return;
  assert.deepEqual({ positionMm: observed.value.positionMm, relation: observed.value.relation,
    feedbackSource: observed.value.feedbackSource, physical: observed.value.physical,
    captureTimeKnown: observed.value.captureTimeKnown, freshnessBasis: observed.value.freshnessBasis,
    sourceClockMapping: observed.value.sourceClockMapping, feedbackGeneration: observed.value.feedbackGeneration,
    gatewayReceiptSequence: observed.value.gatewayReceiptSequence, receiptClockDomain: observed.value.receiptClockDomain },
  { positionMm: 4, relation: 'matches-target', feedbackSource: 'software-state', physical: false,
    captureTimeKnown: false, freshnessBasis: 'gateway-receipt', sourceClockMapping: null,
    feedbackGeneration: 1, gatewayReceiptSequence: 1, receiptClockDomain: 'motor-axis-gateway-monotonic' });
  await value.gateway.close();
});

test('private set and observe authority are independent', async () => {
  const value = fixture({ authorizeSet: false, authorizeObserve: false });
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  assert.deepEqual(await value.gateway.setPosition(started.value, { ...request('set-denied'), targetMm: 2 }),
    { ok: false, reason: 'denied' });
  assert.deepEqual(await value.gateway.observePosition(started.value, request('observe-denied')),
    { ok: false, reason: 'denied' });
  assert.equal(value.calls.includes('set-2'), false);
  assert.equal(value.calls.includes('feedback-read'), false);
  await value.gateway.close();
});

test('already-aborted calls do not reach authority or providers', async () => {
  const value = fixture();
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await value.gateway.setPosition(started.value, { ...request('cancelled-set', aborted.signal), targetMm: 2 }),
    { ok: false, reason: 'cancelled' });
  assert.deepEqual(await value.gateway.observePosition(started.value, request('cancelled-observe', aborted.signal)),
    { ok: false, reason: 'cancelled' });
  assert.deepEqual(value.counts(), { setAuthorizations: 0, observeAuthorizations: 0 });
  await value.gateway.close();
});

test('validated current local-policy invalidation retires while stale identity is inert', async () => {
  const value = fixture();
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  const stale = value.invalidationAt(0);
  await value.gateway.stop();
  const restarted = await value.gateway.start({ purpose: 'restart', deadline: performance.now() + 400 });
  assert.ok(restarted.ok); if (!restarted.ok || !stale) return;
  const current = value.invalidationAt(1);
  assert.notEqual(stale.sessionToken, current?.sessionToken);
  value.invalidateAt(0);
  assert.equal(value.gateway.status().phase, 'ready');
  value.invalidateAt(1);
  await value.gateway.stop();
  assert.equal(value.calls.filter(call => call === 'release').length, 2);
  await value.gateway.close();
});

test('authorizer reentry fences provider dispatch', async () => {
  const holder: { gateway?: MotorAxisGateway } = {};
  const value = fixture({ onAuthorizeSet() { void holder.gateway?.stop(); } });
  holder.gateway = value.gateway;
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  assert.deepEqual(await value.gateway.setPosition(started.value, { ...request('reentrant'), targetMm: 3 }),
    { ok: false, reason: 'denied' });
  assert.equal(value.calls.includes('set-3'), false);
  await value.gateway.close();
});

test('caller abort inside authorizer retires before provider dispatch', async () => {
  const caller = new AbortController();
  const value = fixture({ onAuthorizeSet() { caller.abort(); } });
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  assert.deepEqual(await value.gateway.setPosition(started.value, { ...request('abort-in-authority', caller.signal), targetMm: 3 }),
    { ok: false, reason: 'cancelled' });
  assert.equal(value.calls.includes('set-3'), false);
  await value.gateway.stop();
  assert.equal(value.calls.filter(call => call === 'release').length, 1);
  await value.gateway.close();
});

test('stop retains exact pair ownership until held set and observation settle', async () => {
  let releaseSet!: () => void;
  let setEntered!: () => void;
  let releaseRead!: () => void;
  let readEntered!: () => void;
  const setStarted = new Promise<void>(resolve => { setEntered = resolve; });
  const readStarted = new Promise<void>(resolve => { readEntered = resolve; });
  const heldSet = new Promise<'completed'>(resolve => { releaseSet = () => resolve('completed'); });
  const heldRead = new Promise<Readonly<{ positionMm: 3; lowerLimitSafe: true; upperLimitSafe: true; sequence: 1;
    sourceClockId: string; sourceMonotonicNs: bigint }>>(resolve => {
      releaseRead = () => resolve({ positionMm: 3, lowerLimitSafe: true, upperLimitSafe: true, sequence: 1,
        sourceClockId: 'held-clock', sourceMonotonicNs: 1n });
    });
  const first = fixture({
    actuator: { setPosition() { setEntered(); return heldSet; } },
    feedback: { read() { readEntered(); return heldRead; } },
  });
  const started = await first.gateway.start({ purpose: 'first', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  const setting = first.gateway.setPosition(started.value, { ...request('held-set'), targetMm: 3 });
  const observing = first.gateway.observePosition(started.value, request('held-read'));
  await Promise.all([setStarted, readStarted]);
  const stopping = first.gateway.stop();
  assert.equal(await Promise.race([stopping.then(() => 'settled'),
    new Promise<'held'>(resolve => setTimeout(() => resolve('held'), 20))]), 'held');
  const second = fixture({ actuatorExact: first.actuator, feedbackExact: first.feedback });
  assert.deepEqual(await second.gateway.start({ purpose: 'contender', deadline: performance.now() + 400 }),
    { ok: false, reason: 'busy' });
  assert.deepEqual({ set: first.gateway.status().rawSetPending, observe: first.gateway.status().rawObservePending },
    { set: 1, observe: 1 });
  releaseSet(); releaseRead();
  await Promise.all([stopping, setting, observing]);
  assert.deepEqual({ set: first.gateway.status().rawSetPending, observe: first.gateway.status().rawObservePending },
    { set: 0, observe: 0 });
  assert.ok((await second.gateway.start({ purpose: 'after-settlement', deadline: performance.now() + 400 })).ok);
  await first.gateway.close(); await second.gateway.close();
});

test('retirement promise is installed before reentrant withdrawal and provider lifecycle hooks', async () => {
  const holder: { gateway?: MotorAxisGateway } = {};
  let settle!: () => void;
  let settled = false;
  const pending = new Promise<void>(resolve => { settle = () => { settled = true; resolve(); }; });
  let withdrawals = 0;
  let releases = 0;
  let actuatorCloses = 0;
  let feedbackCloses = 0;
  let reentrant!: Promise<void>;
  const value = fixture({
    actuator: {
      release() { releases++; reentrant = holder.gateway!.stop(); },
      close() { actuatorCloses++; void holder.gateway!.close(); },
      whenSettled() { return settled ? Promise.resolve() : pending; },
    },
    feedback: {
      close() { feedbackCloses++; void holder.gateway!.stop(); },
      whenSettled() { return settled ? Promise.resolve() : pending; },
    },
    onRetire() { withdrawals++; reentrant = holder.gateway!.close(); },
  });
  holder.gateway = value.gateway;
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok);
  const stopping = value.gateway.stop();
  assert.deepEqual({ withdrawals, releases }, { withdrawals: 1, releases: 1 });
  settle();
  await Promise.all([stopping, reentrant]);
  assert.deepEqual({ withdrawals, releases, actuatorCloses, feedbackCloses },
    { withdrawals: 1, releases: 1, actuatorCloses: 1, feedbackCloses: 1 });
});

test('immediate Stop fences deferred opening and both deferred operation legs', async () => {
  const opening = fixture();
  const starting = opening.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  const openingStop = opening.gateway.stop();
  await Promise.all([starting, openingStop]);
  assert.equal(opening.calls.includes('actuator-open'), false);
  assert.equal(opening.calls.includes('feedback-open'), false);
  await opening.gateway.close();
  for (const leg of ['set', 'observe'] as const) {
    const value = fixture();
    const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
    assert.ok(started.ok); if (!started.ok) return;
    const operation = leg === 'set' ? value.gateway.setPosition(started.value,
      { ...request('queued-set'), targetMm: 3 }) : value.gateway.observePosition(started.value, request('queued-read'));
    const stopping = value.gateway.stop();
    const [result] = await Promise.all([operation, stopping]);
    assert.equal(result.ok, false);
    assert.equal('issued' in result, false);
    assert.equal(value.calls.includes('set-3'), false);
    assert.equal(value.calls.includes('feedback-read'), false);
    await value.gateway.close();
  }
});

test('feedback rejects accessors without invoking them or publishing unvalidated values', async () => {
  let reads = 0;
  const value = fixture({ feedback: { read() {
    return { get positionMm() { return ++reads === 1 ? 3 : 99; }, lowerLimitSafe: true,
      upperLimitSafe: true, sequence: 1, sourceClockId: 'fixture-clock', sourceMonotonicNs: 1n };
  } } });
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  try {
    assert.deepEqual(await value.gateway.observePosition(started.value, request('accessor-read')),
      { ok: false, reason: 'invalid', issued: true });
    assert.equal(reads, 0);
  } finally { await value.gateway.close(); }
});

test('activation revocation withdraws held opening and retains pair until settlement', async () => {
  let enter!: () => void;
  let finish!: () => void;
  let contextSignal: AbortSignal | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<'ready'>(resolve => { finish = () => resolve('ready'); });
  let withdrawals = 0;
  const value = fixture({ actuator: { open(context) { contextSignal = context.signal; enter(); return held; } },
    onRetire() { withdrawals++; } });
  const starting = value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  await entered;
  value.control.abort();
  const phase = value.gateway.status().phase;
  const aborted = contextSignal?.aborted;
  const withdrawn = withdrawals;
  finish();
  await starting;
  await value.gateway.close();
  assert.equal(phase, 'retiring');
  assert.equal(aborted, true);
  assert.equal(withdrawn, 1);
});

test('operation deadline withdraws and aborts held provider before its eventual result', async () => {
  for (const leg of ['open', 'set', 'observe'] as const) {
    let enter!: () => void;
    let finish!: () => void;
    let contextSignal: AbortSignal | undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<'ready'>(resolve => { finish = () => resolve('ready'); });
    const value = fixture(leg === 'open' ? { actuator: { open(context) { contextSignal = context.signal; enter(); return held; } } } :
      leg === 'set' ? { actuator: { async setPosition(_target, context) { contextSignal = context.signal; enter(); await held; return 'completed' as const; } } } :
        { feedback: { async read(context) { contextSignal = context.signal; enter(); await held;
          return { positionMm: 3, lowerLimitSafe: true, upperLimitSafe: true, sequence: 1,
            sourceClockId: 'held-clock', sourceMonotonicNs: 1n }; } } });
    let operation;
    if (leg === 'open') operation = value.gateway.start({ purpose: 'held open', deadline: performance.now() + 30 });
    else {
      const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
      assert.ok(started.ok); if (!started.ok) return;
      operation = leg === 'set' ? value.gateway.setPosition(started.value,
        { ...request('deadline-set'), targetMm: 3, deadline: performance.now() + 30 }) :
        value.gateway.observePosition(started.value, { ...request('deadline-read'), deadline: performance.now() + 30 });
    }
    await entered;
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    const phase = value.gateway.status().phase;
    const aborted = contextSignal?.aborted;
    finish();
    const result = await operation;
    await value.gateway.close();
    assert.equal(phase, 'retiring', leg);
    assert.equal(aborted, true, leg);
    assert.equal(result.ok, false);
  }
});

test('paired opening retains a held actual leg when the other provider throws', async () => {
  let enter!: () => void;
  let finish!: () => void;
  let settled = false;
  let prematureClose = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<'ready'>(resolve => { finish = () => { settled = true; resolve('ready'); }; });
  const value = fixture({ actuator: { open() { enter(); return held; }, close() { prematureClose ||= !settled; } },
    feedback: { open() { throw new Error('feedback opening failed'); }, close() { prematureClose ||= !settled; } } });
  const starting = value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  await entered;
  let returned = false;
  void starting.then(() => { returned = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  const returnedWhileHeld = returned;
  finish();
  await starting;
  await value.gateway.close();
  assert.equal(returnedWhileHeld, false);
  assert.equal(prematureClose, false);
});

test('completed set retains live caller and private grant cancellation until retirement', async () => {
  for (const revoked of ['caller', 'grant'] as const) {
    const value = fixture();
    const caller = new AbortController();
    const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
    assert.ok(started.ok); if (!started.ok) return;
    assert.ok((await value.gateway.setPosition(started.value, { ...request('live-effect', caller.signal), targetMm: 3 })).ok);
    (revoked === 'caller' ? caller : value.setGrant).abort();
    const phase = value.gateway.status().phase;
    const released = value.calls.includes('release');
    await value.gateway.close();
    assert.equal(phase, 'retiring', revoked);
    assert.equal(released, true, revoked);
  }
});

test('opening reentry fences feedback provider dispatch after actuator withdraws', async () => {
  const holder: { gateway?: MotorAxisGateway } = {};
  let reads = 0;
  const value = fixture({ actuator: { open() { void holder.gateway?.stop(); return 'ready'; } },
    feedback: { open() { reads++; return 'ready'; } } });
  holder.gateway = value.gateway;
  await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  await value.gateway.close();
  assert.equal(reads, 0);
});

test('constructor rejects an AbortSignal-shaped object without calling providers', async () => {
  const value = fixture();
  await value.gateway.close();
  assert.throws(() => createMotorAxisGateway({ ownerSignal: {
    aborted: false, addEventListener() {}, removeEventListener() {},
  } as unknown as AbortSignal, scope,
  selectedAxis: { id: 'software-axis', profileId: 'app:bounded-linear-axis-mm-software/1' },
  actuatorProvider: value.actuator, feedbackProvider: value.feedback,
  authorizeActivation: () => undefined, authorizeSet: () => undefined, authorizeObserve: () => undefined,
  onRetire() {} }), TypeError);
});

test('effectful faults retain raw reservations until held retirement settlement finishes', async () => {
  for (const leg of ['set', 'observe'] as const) {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const value = fixture({ actuator: { whenSettled() { return held; },
      ...(leg === 'set' ? { setPosition() { throw new Error('effectful SET fault'); } } : {}) },
    feedback: { ...(leg === 'observe' ? { read() { throw new Error('effectful read fault'); } } : {}) } });
    const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
    assert.ok(started.ok); if (!started.ok) return;
    const operation = leg === 'set' ? value.gateway.setPosition(started.value,
      { ...request('fault-set'), targetMm: 3 }) : value.gateway.observePosition(started.value, request('fault-read'));
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    const pending = leg === 'set' ? value.gateway.status().rawSetPending : value.gateway.status().rawObservePending;
    const phase = value.gateway.status().phase;
    finish();
    await operation;
    await value.gateway.close();
    assert.equal(phase, 'retiring');
    assert.equal(pending, 1, leg);
    assert.equal(value.gateway.status().rawSetPending + value.gateway.status().rawObservePending, 0);
  }
});

test('known paired opening failure promptly cancels a held other leg while joining it', async () => {
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const held = new Promise<'ready'>(resolve => { finish = () => resolve('ready'); });
  const value = fixture({ actuator: { open(context) { signal = context.signal; return held; } },
    feedback: { open() { throw new Error('failed other opening leg'); } } });
  const starting = value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  const phase = value.gateway.status().phase;
  const aborted = signal?.aborted;
  finish();
  await starting;
  await value.gateway.close();
  assert.equal(phase, 'retiring');
  assert.equal(aborted, true);
});

test('private set and observe grants bind the exact reserved operation id', async () => {
  const approved: MotorAxisApprovalRequest[] = [];
  const value = fixture({ onAuthorizeSet(value) { approved.push(value); }, onAuthorizeObserve(value) { approved.push(value); } });
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  await value.gateway.setPosition(started.value, { ...request('exact-set'), targetMm: 3 });
  await value.gateway.observePosition(started.value, request('exact-read'));
  await value.gateway.close();
  assert.deepEqual(approved.map(value => Object.getOwnPropertyDescriptor(value, 'operationId')?.value), ['exact-set', 'exact-read']);
  assert.ok(approved.every(Object.isFrozen));
});
