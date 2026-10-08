import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMechanicalRelayGateway,
  MECHANICAL_RELAY_LIMITS,
} from './mechanical-relay-gateway.ts';
import type {
  MechanicalRelayActuatorProvider,
  MechanicalRelayFeedbackProvider,
  MechanicalRelayGateway,
} from './mechanical-relay-gateway.ts';

const scope = { principalId: 'owner', applicationId: 'relay-test', sessionId: 'session' };
const request = (operationId: string, signal = new AbortController().signal) => ({
  operationId,
  purpose: 'test selected software relay',
  signal,
  deadline: performance.now() + 400,
});

function fixture(options: {
  actuator?: Partial<MechanicalRelayActuatorProvider>;
  actuatorExact?: MechanicalRelayActuatorProvider;
  feedback?: Partial<MechanicalRelayFeedbackProvider>;
  feedbackExact?: MechanicalRelayFeedbackProvider;
  authorizeActivation?: boolean;
  authorizeSet?: boolean;
  authorizeFeedback?: boolean;
  onAuthorizeSet?: () => void;
  onRetire?: () => void;
} = {}) {
  const owner = new AbortController();
  const control = new AbortController();
  const setGrant = new AbortController();
  const feedbackGrant = new AbortController();
  const calls: string[] = [];
  let setAuthorizations = 0;
  let feedbackAuthorizations = 0;
  const actuator: MechanicalRelayActuatorProvider = options.actuatorExact ?? {
    supported: true,
    softwareOnly: true,
    watchdogMs: 250,
    open() { calls.push('actuator-open'); return 'ready'; },
    setState(state) { calls.push(`set-${state}`); return 'completed'; },
    release() { calls.push('release'); },
    stop() { calls.push('actuator-stop'); },
    close() { calls.push('actuator-close'); },
    whenSettled() { return Promise.resolve(); },
    ...options.actuator,
  };
  const feedback: MechanicalRelayFeedbackProvider = options.feedbackExact ?? {
    supported: true,
    softwareOnly: true,
    open() { calls.push('feedback-open'); return 'ready'; },
    read() { calls.push('feedback-read'); return { state: 'on', limitSafe: true, sequence: 1, sourceClockId: 'fixture-clock', sourceMonotonicNs: 10n }; },
    stop() { calls.push('feedback-stop'); },
    close() { calls.push('feedback-close'); },
    whenSettled() { return Promise.resolve(); },
    ...options.feedback,
  };
  const gateway = createMechanicalRelayGateway({
    ownerSignal: owner.signal,
    scope,
    selectedRelay: { id: 'software-relay', profileId: 'app:single-relay-software-interlocked/1' },
    actuatorProvider: actuator,
    feedbackProvider: feedback,
    authorizeActivation: value => options.authorizeActivation === false ? undefined : {
      request: value, signal: control.signal, expiresAt: performance.now() + 1_000,
    },
    authorizeSet: value => {
      setAuthorizations++;
      options.onAuthorizeSet?.();
      return options.authorizeSet === false ? undefined : {
        request: value, signal: setGrant.signal, expiresAt: performance.now() + 1_000,
      };
    },
    authorizeFeedback: value => {
      feedbackAuthorizations++;
      return options.authorizeFeedback === false ? undefined : {
        request: value, signal: feedbackGrant.signal, expiresAt: performance.now() + 1_000,
      };
    },
    onRetire: options.onRetire ?? (() => {}),
  });
  return { gateway, owner, control, setGrant, feedbackGrant, actuator, feedback, calls,
    counts: () => ({ setAuthorizations, feedbackAuthorizations }) };
}

test('constructor is inert and activation denial opens neither provider', async () => {
  const value = fixture({ authorizeActivation: false });
  assert.deepEqual(value.calls, []);
  assert.deepEqual(await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 }), { ok: false, reason: 'denied' });
  assert.deepEqual(value.calls, []);
  await value.gateway.close();
});

test('partial provider-pair acquisition rolls back the exact actuator owner', async () => {
  const seed = fixture();
  const sharedFeedback = seed.feedback;
  await seed.gateway.close();
  const holder = fixture({ feedbackExact: sharedFeedback });
  const held = await holder.gateway.start({ purpose: 'holder', deadline: performance.now() + 400 });
  assert.ok(held.ok);
  const contender = fixture({ feedbackExact: sharedFeedback });
  assert.deepEqual(await contender.gateway.start({ purpose: 'contender', deadline: performance.now() + 400 }), { ok: false, reason: 'busy' });
  assert.equal(contender.calls.includes('actuator-open'), false);
  await contender.gateway.close();
  await holder.gateway.close();
});

test('set completion is explicitly uncertain and observation is separate software feedback', async () => {
  const value = fixture();
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  const set = await value.gateway.setState(started.value, { ...request('set-1'), state: 'on' });
  assert.deepEqual(set, { ok: true, value: { operationId: 'set-1', target: 'on', providerCompletion: true,
    effect: 'issued-uncertain', observedState: 'unknown', physical: false, physicalState: 'unverified' } });
  const observed = await value.gateway.observe(started.value, request('observe-1'));
  assert.ok(observed.ok); if (!observed.ok) return;
  assert.deepEqual({ state: observed.value.state, relation: observed.value.relation, feedbackSource: observed.value.feedbackSource,
    physical: observed.value.physical, captureTimeKnown: observed.value.captureTimeKnown,
    freshnessBasis: observed.value.freshnessBasis, sourceClockMapping: observed.value.sourceClockMapping,
    feedbackGeneration: observed.value.feedbackGeneration, gatewayReceiptSequence: observed.value.gatewayReceiptSequence,
    receiptClockDomain: observed.value.receiptClockDomain, providerKind: observed.value.providerKind },
  { state: 'on', relation: 'matches-target', feedbackSource: 'software-state', physical: false,
    captureTimeKnown: false, freshnessBasis: 'gateway-receipt', sourceClockMapping: null,
    feedbackGeneration: 1, gatewayReceiptSequence: 1,
    receiptClockDomain: 'mechanical-relay-gateway-monotonic', providerKind: 'software-fixture' });
  await value.gateway.close();
});

test('set and feedback authority are independent and reserve before authorizers', async () => {
  const value = fixture({ authorizeSet: false, authorizeFeedback: false });
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  assert.deepEqual(await value.gateway.setState(started.value, { ...request('set-denied'), state: 'on' }), { ok: false, reason: 'denied' });
  assert.deepEqual(await value.gateway.observe(started.value, request('feedback-denied')), { ok: false, reason: 'denied' });
  assert.equal(value.calls.includes('set-on'), false);
  assert.equal(value.calls.includes('feedback-read'), false);
  await value.gateway.close();
});

test('replay, stale feedback and lifetime quotas fail closed', async () => {
  let sequence = 0;
  const value = fixture({
    feedback: { read() { return { state: 'off', limitSafe: true, sequence, sourceClockId: 'fixture-clock', sourceMonotonicNs: 1n }; } },
    authorizeSet: false,
  });
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  assert.deepEqual(await value.gateway.observe(started.value, request('observe-zero')), { ok: false, reason: 'out-of-order', issued: true });
  sequence = 1;
  assert.ok((await value.gateway.observe(started.value, request('observe-one'))).ok);
  assert.deepEqual(await value.gateway.observe(started.value, request('observe-one')), { ok: false, reason: 'replay' });
  for (let index = 0; index < MECHANICAL_RELAY_LIMITS.setAttempts; index++) {
    assert.deepEqual(await value.gateway.setState(started.value, { ...request(`set-denied-${index}`), state: 'off' }), { ok: false, reason: 'denied' });
  }
  assert.deepEqual(await value.gateway.setState(started.value, { ...request('set-seventeen'), state: 'off' }), { ok: false, reason: 'quota' });
  assert.equal(value.counts().setAuthorizations, MECHANICAL_RELAY_LIMITS.setAttempts);
  await value.gateway.close();
});

test('already-aborted calls do not reach authority or providers', async () => {
  const value = fixture();
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await value.gateway.setState(started.value, { ...request('cancelled-set', aborted.signal), state: 'on' }), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await value.gateway.observe(started.value, request('cancelled-observe', aborted.signal)), { ok: false, reason: 'cancelled' });
  assert.deepEqual(value.counts(), { setAuthorizations: 0, feedbackAuthorizations: 0 });
  await value.gateway.close();
});

test('interlock denial reports an uncertain issued command without changing the target', async () => {
  const value = fixture({ actuator: { setState() { return 'interlock-open'; } } });
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  assert.deepEqual(await value.gateway.setState(started.value, { ...request('blocked-on'), state: 'on' }),
    { ok: false, reason: 'interlock-open', issued: true, effect: 'uncertain' });
  assert.equal(value.gateway.status().logicalTarget, 'unknown');
  await value.gateway.close();
});

test('software watchdog retires an on session and joins local release', async () => {
  const value = fixture();
  const started = await value.gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  assert.ok((await value.gateway.setState(started.value, { ...request('watchdog-on'), state: 'on' })).ok);
  await new Promise(resolve => setTimeout(resolve, MECHANICAL_RELAY_LIMITS.watchdogMs + 25));
  await value.gateway.stop();
  assert.equal(value.calls.filter(call => call === 'release').length, 1);
  assert.equal(value.gateway.status().logicalTarget, 'unknown');
  await value.gateway.close();
});

test('authorizer reentry fences provider callouts', async () => {
  const holder: { gateway?: MechanicalRelayGateway } = {};
  const value = fixture({ onAuthorizeSet() { void holder.gateway?.stop(); } });
  const gateway = value.gateway;
  holder.gateway = gateway;
  const started = await gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  assert.deepEqual(await gateway.setState(started.value, { ...request('reentrant-set'), state: 'on' }),
    { ok: false, reason: 'denied' });
  assert.equal(value.calls.includes('set-on'), false);
  await gateway.close();
});

test('retirement publishes one promise before withdrawal and provider lifecycle reentry', async () => {
  const holder: { gateway?: MechanicalRelayGateway } = {};
  let releaseSettlement!: () => void;
  let settled = false;
  let withdrawals = 0;
  let releases = 0;
  let actuatorCloses = 0;
  let feedbackCloses = 0;
  let reentrantStop!: Promise<void>;
  let reentrantClose!: Promise<void>;
  const pendingSettlement = new Promise<void>(resolve => {
    releaseSettlement = () => { settled = true; resolve(); };
  });
  const actuator: Partial<MechanicalRelayActuatorProvider> = {
    release() { releases++; reentrantStop = holder.gateway!.stop(); },
    close() { actuatorCloses++; void holder.gateway!.stop(); },
    whenSettled() { return settled ? Promise.resolve() : pendingSettlement; },
  };
  const feedback: Partial<MechanicalRelayFeedbackProvider> = {
    close() { feedbackCloses++; void holder.gateway!.close(); },
    whenSettled() { return settled ? Promise.resolve() : pendingSettlement; },
  };
  const value = fixture({ actuator, feedback, onRetire() {
    withdrawals++;
    reentrantStop = holder.gateway!.stop();
    reentrantClose = holder.gateway!.close();
  } });
  const gateway = value.gateway;
  holder.gateway = gateway;
  const started = await gateway.start({ purpose: 'activate', deadline: performance.now() + 400 });
  assert.ok(started.ok);
  let finished = false;
  const stopping = gateway.stop().then(() => { finished = true; });
  assert.equal(withdrawals, 1);
  assert.equal(finished, false);
  assert.equal(releases, 1);
  releaseSettlement();
  await Promise.all([stopping, reentrantStop, reentrantClose]);
  assert.deepEqual({ withdrawals, releases, actuatorCloses, feedbackCloses },
    { withdrawals: 1, releases: 1, actuatorCloses: 1, feedbackCloses: 1 });
});

test('stop retains paired ownership until a held set and completed observation both settle', async () => {
  let releaseSet!: () => void;
  let setEntered!: () => void;
  const entered = new Promise<void>(resolve => { setEntered = resolve; });
  const held = new Promise<'completed'>(resolve => { releaseSet = () => resolve('completed'); });
  const first = fixture({ actuator: { setState() { setEntered(); return held; } } });
  const started = await first.gateway.start({ purpose: 'first', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  const setting = first.gateway.setState(started.value, { ...request('held-set'), state: 'on' });
  await entered;
  assert.ok((await first.gateway.observe(started.value, request('parallel-observe'))).ok);
  const stopping = first.gateway.stop();
  assert.equal(await Promise.race([stopping.then(() => 'settled'),
    new Promise<'held'>(resolve => setTimeout(() => resolve('held'), 20))]), 'held');
  const second = fixture({ actuatorExact: first.actuator, feedbackExact: first.feedback });
  assert.deepEqual(await second.gateway.start({ purpose: 'second', deadline: performance.now() + 400 }),
    { ok: false, reason: 'busy' });
  assert.equal(first.gateway.status().rawSetPending, 1);
  releaseSet();
  await stopping;
  assert.equal(first.gateway.status().rawSetPending, 0);
  await setting;
  assert.ok((await second.gateway.start({ purpose: 'second-after-settlement', deadline: performance.now() + 400 })).ok);
  await first.gateway.close();
  await second.gateway.close();
});

test('close retains paired ownership until a held observation and completed set both settle', async () => {
  let releaseObservation!: () => void;
  let observationEntered!: () => void;
  const entered = new Promise<void>(resolve => { observationEntered = resolve; });
  const held = new Promise<Readonly<{ state: 'off'; limitSafe: true; sequence: 1; sourceClockId: string;
    sourceMonotonicNs: bigint }>>(resolve => {
      releaseObservation = () => resolve({ state: 'off', limitSafe: true, sequence: 1,
        sourceClockId: 'held-clock', sourceMonotonicNs: 1n });
    });
  const first = fixture({ feedback: { read() { observationEntered(); return held; } } });
  const started = await first.gateway.start({ purpose: 'first', deadline: performance.now() + 400 });
  assert.ok(started.ok); if (!started.ok) return;
  const observing = first.gateway.observe(started.value, request('held-observation'));
  await entered;
  assert.ok((await first.gateway.setState(started.value, { ...request('parallel-set'), state: 'off' })).ok);
  const closing = first.gateway.close();
  assert.equal(await Promise.race([closing.then(() => 'settled'),
    new Promise<'held'>(resolve => setTimeout(() => resolve('held'), 20))]), 'held');
  const second = fixture({ actuatorExact: first.actuator, feedbackExact: first.feedback });
  assert.deepEqual(await second.gateway.start({ purpose: 'second', deadline: performance.now() + 400 }),
    { ok: false, reason: 'busy' });
  assert.equal(first.gateway.status().rawObservationPending, 1);
  releaseObservation();
  await closing;
  assert.equal(first.gateway.status().rawObservationPending, 0);
  await observing;
  assert.ok((await second.gateway.start({ purpose: 'second-after-settlement', deadline: performance.now() + 400 })).ok);
  await second.gateway.close();
});
