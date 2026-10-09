import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

function closed(value, keys, name) {
  assert.ok(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), name);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort(), name + ' keys');
  const out = {};
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key); assert.ok(d?.enumerable && Object.hasOwn(d, 'value'), name + ' own data'); out[key] = d.value; }
  return out;
}
const errorFact = error => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack ?? null });
const pinKeys = ['executablePath', 'executableSha256', 'producerSha256', 'observerPath', 'observerSha256'];

/** Guarded software example. Only a separately reviewed exact QA release admits actual effects. */
export async function runSoftwareLearning(input, observerInput) {
  const mode = input && Object.getOwnPropertyDescriptor(input, 'mode');
  assert.ok(mode && Object.hasOwn(mode, 'value') && mode.value === 'software-learning', 'Expected software-learning mode');
  const options = closed(input, ['mode', 'runtimePins'], 'software learning options');
  const pins = closed(options.runtimePins, ['receive', 'emitter'], 'runtime pins');
  pins.receive = closed(pins.receive, pinKeys, 'receiver pins'); pins.emitter = closed(pins.emitter, pinKeys, 'emitter pins');
  for (const p of Object.values(pins)) {
    assert.equal(typeof p.executablePath, 'string'); assert.equal(typeof p.observerPath, 'string');
    for (const key of ['executableSha256', 'producerSha256', 'observerSha256']) assert.match(p[key], /^[0-9a-f]{64}$/);
  }
  const observer = observerInput === undefined ? undefined : closed(observerInput,
    ['onOwnedFactory', 'onOwnedRoute', 'onOwnedApply', 'onOwnedPrivate'], 'ownership observer');
  if (observer) for (const callback of Object.values(observer)) assert.equal(typeof callback, 'function');
  // No module import or provider state before closed mode/options/observer validation.
  const { softwareProvider: makeReceiver } = await import('../ir-receive/consumer.mjs');
  const { softwareProvider: makeEmitter } = await import('../ir-emitter/consumer.mjs');
  const { createNec32IrLearningSession } = await import('../../packages/hub-server/src/nec32-ir-learning.ts');
  const owner = new AbortController(), control = new AbortController(), captureGrant = new AbortController(), reviewGrant = new AbortController();
  const activation = new AbortController(), emissionGrant = new AbortController();
  const captureCaller = new AbortController(), reviewCaller = new AbortController(), emissionCaller = new AbortController();
  const scope = Object.freeze({ principalId: 'owned-operator', applicationId: 'ir-learning-software', sessionId: 'one-transient-session' });
  const factories = [], routes = [], applies = [], privateReturns = [], cleanupErrors = [];
  const counts = { receiverAuthorizations: 0, captureAuthorizations: 0, reviewAuthorizations: 0, emitterAuthorizations: 0, emissionAuthorizations: 0, publicRead: 0, publicInvoke: 0 };
  const reserve = (make, kind) => {
    const factory = make({ runtimePins: pins[kind === 'receive' ? 'receive' : 'emitter'] });
    const record = { kind, factory, close: null, settled: null }; factories.push(record);
    if (observer) assert.equal(observer.onOwnedFactory(factory, kind), undefined);
    return factory;
  };
  const ownership = {
    onOwnedRoute(connection, kind, actualSettlement) {
      const record = { kind, connection, actualSettlement, joined: false }; routes.push(record);
      if (observer) assert.equal(observer.onOwnedRoute(connection, kind, actualSettlement), undefined);
    },
    onOwnedApply(actualReturn, connection, kind) {
      const record = { kind, actualReturn, connection, joined: false, settled: false, outcome: null }; applies.push(record);
      void actualReturn.then(() => { record.settled = true; record.outcome = 'fulfilled'; }, error => { record.settled = true; record.outcome = 'rejected'; record.error = errorFact(error); });
      if (observer) assert.equal(observer.onOwnedApply(actualReturn, connection, kind), undefined);
    },
    onOwnedPrivate(actualReturn, stage) {
      const record = { stage, actualReturn, joined: false, outcome: null }; privateReturns.push(record);
      void actualReturn.then(() => { record.outcome = 'fulfilled'; }, error => { record.outcome = 'rejected'; record.error = errorFact(error); });
      if (observer) assert.equal(observer.onOwnedPrivate(actualReturn, stage), undefined);
    },
  };
  let session, captured, reviewed, emitted, primaryError, composedClose, receiver, emitter;
  try {
    receiver = reserve(makeReceiver, 'receive'); emitter = reserve(makeEmitter, 'emitter');
    session = createNec32IrLearningSession({ mode: 'software-learning', ownerSignal: owner.signal, scope,
      selectedReceiver: { id: 'software-rx', profileId: 'app:nec-inverse-byte-demodulated-nominal/1' }, receiveProvider: receiver.provider,
      selectedEmitter: { id: 'software-tx', profileId: 'app:nec-inverse-byte-command-one-shot/1' }, emitterProvider: emitter.provider,
      authorizeReceiver(request) { counts.receiverAuthorizations++; return Object.freeze({ request, signal: control.signal, expiresAt: request.deadline }); },
      authorizeCapture(request) { counts.captureAuthorizations++; return Object.freeze({ request, signal: captureGrant.signal, expiresAt: request.deadline }); },
      authorizeReview(request) {
        counts.reviewAuthorizations++; assert.ok(captured?.ok); assert.equal(request.action, 'review-capture');
        assert.equal(request.envelopeSha256, captured.value.receipt.envelopeSha256); assert.equal(request.readRouteId, captured.value.receipt.readRouteId);
        assert.deepEqual(request.scope, scope);
        return Object.freeze({ request, signal: reviewGrant.signal, expiresAt: request.deadline });
      },
      authorizeEmitter(request) { counts.emitterAuthorizations++; return Object.freeze({ request, signal: activation.signal, expiresAt: request.deadline }); },
      authorizeEmission(request) { counts.emissionAuthorizations++; assert.ok(reviewed?.ok); assert.equal(request.frameSha256, reviewed.value.receipt.envelopeSha256);
        return Object.freeze({ request, signal: emissionGrant.signal, expiresAt: request.deadline }); },
      authorizePublic(request) {
        assert.deepEqual({ principalId: request.principalId, applicationId: request.applicationId, sessionId: request.sessionId }, scope);
        if (request.sourceOperation === 'read' && request.sinkOperation === 'write') counts.publicRead++;
        else if (request.sourceOperation === 'subscribe' && request.sinkOperation === 'invoke') counts.publicInvoke++;
        else return undefined;
        return { expiresAt: performance.now() + 500, maxAgeMs: 500 };
      },
    }, ownership);
    captured = await session.captureForReview({ operationId: 'learning-capture', purpose: 'capture one nominal software candidate for review',
      signal: captureCaller.signal, deadline: performance.now() + 500, retainMs: 60000 });
    assert.ok(captured.ok, 'Capture: ' + JSON.stringify(captured));
    assert.equal(session.status().emitterConfigurations, 0); assert.equal(emitter.lifecycleStatus().spawnCount, 0);
    reviewed = await session.review(captured.value.draft, { purpose: 'owner approves one captured pair as inert configuration', signal: reviewCaller.signal, deadline: performance.now() + 500 });
    assert.ok(reviewed.ok, 'Review: ' + JSON.stringify(reviewed));
    assert.deepEqual(reviewed.value.receipt.codebook, [{ codeId: 'learned-capture', address: captured.value.receipt.address, command: captured.value.receipt.command }]);
    assert.equal(emitter.lifecycleStatus().spawnCount, 0);
    emitted = await session.emitOnce(reviewed.value.review, { operationId: '1', purpose: 'independently permit one software dispatch', signal: emissionCaller.signal, deadline: performance.now() + 500 });
    assert.ok(emitted.ok, 'Emission: ' + JSON.stringify(emitted));
    assert.equal((await session.emitOnce(reviewed.value.review, { operationId: '2', purpose: 'replay must stay denied', signal: new AbortController().signal, deadline: performance.now() + 500 })).ok, false);
  } catch (error) { primaryError = error; }
  finally {
    // Shared composed close is captured before any remaining provider observer callout.
    if (session) composedClose = session.close();
    owner.abort(); captureCaller.abort(); reviewCaller.abort(); emissionCaller.abort();
    const cleanup = async (stage, call) => { try { await call(); } catch (error) { cleanupErrors.push({ stage, error: errorFact(error) }); } };
    const joins = composedClose ? [cleanup('coordinator-close', () => composedClose)] : [];
    for (const record of factories) {
      joins.push(cleanup(record.kind + '-stop', () => record.factory.provider.stop()));
      joins.push(cleanup(record.kind + '-close', () => { record.close = record.factory.provider.close(); return record.close; }));
      joins.push(cleanup(record.kind + '-settlement', () => { record.settled = record.factory.provider.whenSettled(); return record.settled; }));
    }
    await Promise.all(joins);
    for (const record of applies) await cleanup('actual-' + record.kind + '-apply-return', async () => { await record.actualReturn; record.joined = true; });
    for (const record of routes) await cleanup('actual-' + record.kind + '-Connection', async () => { await record.actualSettlement; record.joined = true; });
    for (const record of privateReturns) await cleanup(record.stage, async () => { await record.actualReturn; record.joined = true; });
  }
  const factoryOutcomes = factories.map(r => ({ kind: r.kind, lifecycle: r.factory.lifecycleStatus(), proof: r.factory.runtimeProof(),
    commands: [...(r.factory.commands ?? r.factory.sentTypes)], messages: r.factory.messages.map(m => m.type), closeAndSettlementIdentical: r.close === r.settled }));
  const status = session?.status() ?? null;
  if (status?.failures.length) cleanupErrors.push(...status.failures.map(error => ({ stage: error.stage, error })));
  const result = { schemaVersion: 1, status: primaryError || cleanupErrors.length ? 'learning-failed' : 'joined-software-learning',
    primaryError: primaryError ? errorFact(primaryError) : null, cleanupErrors, captured: captured?.ok ? captured.value.receipt : captured ?? null,
    reviewed: reviewed?.ok ? reviewed.value.receipt : reviewed ?? null, emitted: emitted?.ok ? emitted.value : emitted ?? null, counts, coordinatorStatus: status, factoryOutcomes,
    actualPublic: routes.map(r => ({ kind: r.kind, routeId: r.connection.id, sameSettlement: r.connection.whenSettled() === r.actualSettlement, joined: r.joined,
      applies: applies.filter(a => a.connection === r.connection).map(a => ({ settled: a.settled, outcome: a.outcome, joined: a.joined })) })),
    privateReturns: privateReturns.map(r => ({ stage: r.stage, outcome: r.outcome, joined: r.joined })),
    limits: { actualReceivers: 1, actualEmitters: 1, operationMs: 500, evidence: 'software-only selected nominal capture and dispatch', physical: false, fullA07A08: false, supportPromotion: false,
      carrier: 'configured 38000; received unknown', timings: 'reconstructed selected nominal canonical representation; no retained raw waveform' } };
  Object.defineProperty(result, 'live', { enumerable: false, value: Object.freeze({ primaryError, owner,
    ownedFactories: Object.freeze(factories), ownedRoutes: Object.freeze(routes), actualApplyReturns: Object.freeze(applies), actualPrivateReturns: Object.freeze(privateReturns), actualComposedClosePromise: composedClose }) });
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { runLearningQualification } = await import('../../tools/qa-ir-learning.mjs');
  assert.equal(process.argv.length, 3, 'Expected a root-frozen positive release manifest');
  const result = await runLearningQualification(process.argv[2], 'source-positive');
  console.log(JSON.stringify({ status: result.status, primaryError: result.primaryError, cleanupErrors: result.cleanupErrors }));
  process.exitCode = result.status === 'joined-software-learning' ? 0 : 1;
}
