import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync, lstatSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Historical OLD and separately released positive branches. Importing this file never imports the SDK or starts a provider.
const SEMANTIC_RED = 'IR-LEARNING-RED-UNREVIEWED-CODEBOOK';
const ADMISSION_SHA = 'dd15c6e392a9723f9daa5f717f31c7bf4c87f95e796ac9643c66d1ceed6b7916';
const SDK_METADATA_SHA = '53df558f05f65e220409ce6fd120338d73781cd0ca6073182929c9fa84da2a52';
const INPUTS = Object.freeze({
  receiveConsumer: ['examples/ir-receive/consumer.mjs', 33553, '5ff60b509a5214fd0dd9b6e9ddf653f41e9726a288f1bae9f792bdac8b821e0f'],
  emitterConsumer: ['examples/ir-emitter/consumer.mjs', 30865, '917ba3089ae3178b6248fae9b26d52e7b6f5f2b26581c67d96289f7ebcd1f94c'],
  observer: ['tools/qa-ir-provider-runtime-observer.mjs', 49179, '465099e178a234c59dd6208599027a9b8905e9cf748af6ef6cf7ba034bce999f'],
  receiveProducer: ['examples/ir-receive/software-receiver.mjs', 2648, '8c6d25d8e224a4ec183ffbe39bf20abad65c91c87763facabbc64c971ccadfc3'],
  emitterProducer: ['examples/ir-emitter/software-emitter.mjs', 3884, '84a2ea491f05cee58fea993695d0d380f13bc9e552c88e4dcba8a2d00755017b'],
  receiveGateway: ['packages/hub-server/src/nec32-ir-receive-gateway.ts', 18825, 'c5116f9aa8fe6cdfb9e236d7caacf737af697978d4102122f6a3f34fd858d6ff'],
  emitterGateway: ['packages/hub-server/src/nec32-ir-emitter-gateway.ts', 23162, '7b85a2b6ca81dd7e551a4fe42b70ae58151feca4975a64e77e78d59f288dd243'],
});
const PACKAGES = ['connect', 'device-model', 'device-runtime', 'device-web', 'vision', 'transport-webrtc', 'transport-websocket'];
const SCOPE = Object.freeze({ principalId: 'owned-operator', applicationId: 'ir-learning-baseline', sessionId: 'one-owner-before' });
const RX_PROFILE = 'app:nec-inverse-byte-demodulated-nominal/1';
const TX_PROFILE = 'app:nec-inverse-byte-command-one-shot/1';
const CAPTURE_ID = 'baseline-capture';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const intrinsicAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const aborted = signal => Reflect.apply(intrinsicAborted, signal, []);
let attempted = false;

function closed(value, keys, label) {
  assert.ok(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), label);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort(), label + ' keys');
  const copy = Object.create(null);
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(property && property.enumerable && Object.hasOwn(property, 'value'), label + ' own data');
    copy[key] = property.value;
  }
  return copy;
}
function exactPin(value, label, extra = []) {
  const pin = closed(value, ['path', 'bytes', 'sha256', ...extra], label);
  assert.ok(typeof pin.path === 'string' && isAbsolute(pin.path));
  assert.equal(realpathSync(pin.path), pin.path, label + ' canonical path');
  assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0);
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  const bytes = readFileSync(pin.path);
  assert.equal(bytes.length, pin.bytes, label + ' byte count');
  assert.equal(hash(bytes), pin.sha256, label + ' exact bytes');
  return pin;
}
function errorFact(error) {
  return { name: error?.name ?? 'Error', message: String(error?.message ?? error), code: error?.code ?? null,
    semanticCode: error?.semanticCode ?? null, stack: error?.stack ?? null };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function resource(handle, deviceId, capabilityId) {
  return { registrationId: handle.id, deviceId, capabilityId, descriptorRevision: 1, schemaVersion: 1 };
}
function projection(candidate) {
  return Object.freeze({ candidateSequence: Number(candidate.candidateId.split('-')[1]), profile: candidate.profile,
    address: candidate.address, command: candidate.command,
    demodulatedSha256Bytes: Object.freeze(Array.from(Buffer.from(candidate.demodulatedSha256, 'hex'))),
    timingCount: candidate.timingCount, totalMicros: candidate.totalMicros, reviewRequired: candidate.reviewRequired,
    captureTimeKnown: candidate.captureTimeKnown, carrierFrequency: candidate.carrierFrequency,
    physicalReceipt: candidate.physicalReceipt, applianceMeaning: candidate.applianceMeaning,
    targetAcknowledgement: candidate.targetAcknowledgement, observedTargetState: candidate.observedTargetState });
}
function deviceDescription() {
  const value = { type: 'record', fields: {
    candidateSequence: { type: 'scalar', unit: 'candidate', min: 1, max: 16, resolution: 1 },
    profile: { type: 'enum', values: [RX_PROFILE] },
    address: { type: 'scalar', unit: 'byte', min: 0, max: 255, resolution: 1 },
    command: { type: 'scalar', unit: 'byte', min: 0, max: 255, resolution: 1 },
    demodulatedSha256Bytes: { type: 'array', minItems: 32, maxItems: 32, items: { type: 'scalar', unit: 'byte', min: 0, max: 255, resolution: 1 } },
    timingCount: { type: 'scalar', unit: 'event', min: 67, max: 67, resolution: 1 },
    totalMicros: { type: 'scalar', unit: 'us', min: 68060, max: 68060, resolution: 1 },
    reviewRequired: { type: 'boolean' }, captureTimeKnown: { type: 'boolean' },
    carrierFrequency: { type: 'enum', values: ['unknown'] }, physicalReceipt: { type: 'enum', values: ['unverified'] },
    applianceMeaning: { type: 'enum', values: ['unknown'] }, targetAcknowledgement: { type: 'boolean' }, observedTargetState: { type: 'boolean' },
  } };
  const capability = (id, permission) => ({ id, semantic: 'example:unreviewed-nec-candidate-sequence-sha256/1',
    schemaVersion: 1, kind: 'property', value, delivery: { mode: 'latest', maxHz: 10, maxAgeMs: 500 },
    permissions: [permission], ...(permission === 'write' ? { ownership: { mode: 'observe' } } : {}) });
  return { schemaVersion: 1, id: 'software-nec-receiver', label: 'Software NEC receiver', revision: 1,
    adapter: { id: 'example:nec-receive-loopback', version: '1.0.0' }, runtime: { platform: 'node-loopback-fixture' },
    capabilities: [capability('candidate', 'read'), capability('viewer', 'write')] };
}

/** Root separately reviews/releases this exact runner. The optional observer can only observe ownership. */
export async function runBaselineBefore(manifestPath, observerOptions) {
  assert.equal(attempted, false, 'One baseline attempt per imported runner');
  attempted = true;
  const observer = observerOptions === undefined ? undefined : closed(observerOptions, ['onOwnedFactory'], 'observer hook');
  if (observer) assert.equal(typeof observer.onOwnedFactory, 'function');
  assert.ok(typeof manifestPath === 'string' && isAbsolute(manifestPath));
  assert.equal(realpathSync(manifestPath), manifestPath);
  const releaseBytes = readFileSync(manifestPath);
  assert.ok(releaseBytes.length <= 65536, 'Closed release input size');
  const release = closed(JSON.parse(releaseBytes), ['schemaVersion', 'status', 'mode', 'root', 'runner', 'node',
    'admission', 'runnerReview', 'inputs', 'sdkClosureReference', 'receiptPath'], 'baseline release');
  assert.equal(release.schemaVersion, 1);
  assert.equal(release.status, 'root-released-ir-learning-baseline-before');
  assert.equal(release.mode, 'source-baseline-before');
  assert.ok(typeof release.root === 'string' && isAbsolute(release.root));
  assert.equal(realpathSync(release.root), release.root);
  const runner = exactPin(release.runner, 'runner');
  assert.equal(runner.path, join(release.root, 'tools/qa-ir-learning.mjs'));
  assert.equal(realpathSync(fileURLToPath(import.meta.url)), runner.path);
  const node = exactPin(release.node, 'node', ['version', 'platform', 'architecture']);
  assert.equal(node.bytes, 119133456);
  assert.equal(node.sha256, '20a18709f0154d668f1bd6f6ea8c2a7ae001447b4b2c339732f22e57a8767a55');
  assert.equal(node.version, 'v24.14.0'); assert.equal(node.platform, 'darwin'); assert.equal(node.architecture, 'arm64');
  assert.equal(realpathSync(process.execPath), node.path);
  assert.equal(process.version, node.version);
  assert.equal(process.platform, node.platform);
  assert.equal(process.arch, node.architecture);
  const admission = exactPin(release.admission, 'admission');
  assert.equal(admission.sha256, ADMISSION_SHA);
  const runnerReview = exactPin(release.runnerReview, 'runner review');
  const inputs = closed(release.inputs, Object.keys(INPUTS), 'seven inputs');
  for (const [kind, [relativePath, bytes, sha256]] of Object.entries(INPUTS)) {
    inputs[kind] = exactPin(inputs[kind], kind);
    assert.equal(inputs[kind].path, join(release.root, relativePath));
    assert.equal(inputs[kind].bytes, bytes); assert.equal(inputs[kind].sha256, sha256);
  }
  const sdkPin = exactPin(release.sdkClosureReference, 'SDK closure reference');
  assert.equal(sdkPin.sha256, SDK_METADATA_SHA);
  const sdkMetadata = JSON.parse(readFileSync(sdkPin.path));
  const sdk = sdkMetadata.sdkWorkspaces.find(value => value.kind === 'actual-source-public-package-exports');
  assert.ok(sdk && sdk.path && sdk.publicEntry && Array.isArray(sdk.pins));
  const sdkPins = sdk.pins.map(pin => exactPin(pin, 'source SDK input'));
  const links = PACKAGES.map(name => {
    const path = join(release.root, 'node_modules/@101', name), target = join(sdk.path, 'packages', name);
    assert.equal(realpathSync(path), realpathSync(target), 'Native source package export link ' + name);
    return { path, target: realpathSync(target) };
  });
  assert.ok(typeof release.receiptPath === 'string' && isAbsolute(release.receiptPath));
  assert.equal(realpathSync(dirname(release.receiptPath)), dirname(release.receiptPath));
  assert.equal(existsSync(release.receiptPath), false, 'Receipt is create-only');
  const pins = [runner, node, admission, runnerReview, sdkPin, ...Object.values(inputs), ...sdkPins];
  const known = new Map(pins.map(pin => [pin.path, pin]));
  const loaded = [], resolved = [], events = [], factories = [], cleanup = [], cleanupErrors = [], privateReturns = [];
  const note = (event, detail = {}) => events.push({ event, at: performance.now(), ...detail });
  const retainCleanup = (stage, error) => { cleanupErrors.push({ stage, error: errorFact(error) }); };
  const observeReturn = (stage, actual, isCleanup = false) => {
    const record = { stage, actual, isCleanup, settled: false, outcome: null };
    privateReturns.push(record);
    record.join = Promise.resolve(actual).then(() => { record.settled = true; record.outcome = 'fulfilled'; }, error => {
      record.settled = true; record.outcome = 'rejected'; record.error = errorFact(error); retainCleanup(stage, error);
    });
    return record;
  };
  const cleanupCall = (stage, callback) => {
    try { return observeReturn(stage, callback(), true).join; }
    catch (error) { retainCleanup(stage, error); cleanup.push({ stage, outcome: 'threw', error: errorFact(error) }); return Promise.resolve(); }
  };
  const owner = new AbortController(), control = new AbortController(), captureGrantSignal = new AbortController(), caller = new AbortController();
  const counts = { receiveOpen: 0, receiveCapture: 0, emitterOpen: 0, emitterTransmit: 0,
    receiverAuthorizations: 0, captureAuthorizations: 0, publicReadAuthorizations: 0,
    ownerReviewCalls: 0, emitterActivationAuthorizations: 0, emitterEmissionAuthorizations: 0 };
  let hook, receiveGateway, emitterGateway, receiver, emitter, runtime, source, sink, connection, connectionSettlement, connectionReturn;
  let originalControlRequest, originalControlGrant, originalCaptureRequest, originalCaptureGrant, originalPublicRequest;
  let captureRequest, candidate, publishedCandidate, delivered, applyRecord, rxCleanup, composedCleanup, observationExpired = false;
  let primaryError, unreviewedConstructorAdmission = 'not-attempted', observationTimer;
  const withdraw = () => { if (runtime && source) runtime.setReadiness(source, 'unavailable'); };
  const beginReceiverCleanup = () => {
    if (rxCleanup) return rxCleanup;
    const reserved = deferred(); rxCleanup = reserved.promise;
    note('independent-receiver-cleanup-reserved');
    const joins = [];
    try { withdraw(); } catch (error) { retainCleanup('withdraw-read', error); }
    if (receiveGateway) joins.push(cleanupCall('receive-gateway-stop', () => receiveGateway.stop()));
    const record = factories.find(value => value.kind === 'receive');
    if (record) {
      const ownedReceiver = record.factory;
      joins.push(cleanupCall('receive-provider-stop', () => ownedReceiver.provider.stop()));
      joins.push(cleanupCall('receive-provider-close', () => { record.closePromise = ownedReceiver.provider.close(); return record.closePromise; }));
      joins.push(cleanupCall('receive-provider-whenSettled', () => { record.settlementPromise = ownedReceiver.provider.whenSettled();
        record.closeAndSettlementIdentical = record.closePromise === record.settlementPromise; return record.settlementPromise; }));
    }
    void Promise.all(joins).then(() => { note('independent-receiver-cleanup-joined'); reserved.resolve(); }, reserved.reject);
    return rxCleanup;
  };
  const reserveFactory = (module, kind) => {
    assert.equal(observationExpired, false, 'No factory admission after observation checkpoint');
    const producer = inputs[kind === 'receive' ? 'receiveProducer' : 'emitterProducer'];
    const factory = module.softwareProvider({ runtimePins: { executablePath: node.path, executableSha256: node.sha256,
      producerSha256: producer.sha256, observerPath: inputs.observer.path, observerSha256: inputs.observer.sha256 } });
    const record = { kind, factory, closePromise: null, settlementPromise: null, closeAndSettlementIdentical: null };
    factories.push(record); note('factory-reserved', { kind });
    // Reserved before any external observer callout; a throw/reentrant stop still leaves it owned.
    if (observer) assert.equal(observer.onOwnedFactory(factory, kind), undefined, 'Ownership observer has no return authority');
    for (const [method, count] of kind === 'receive' ? [['open', 'receiveOpen'], ['capture', 'receiveCapture']]
      : [['open', 'emitterOpen'], ['transmit', 'emitterTransmit']]) {
      const property = Object.getOwnPropertyDescriptor(factory.provider, method);
      assert.ok(property && Object.hasOwn(property, 'value') && typeof property.value === 'function');
      const original = property.value;
      Object.defineProperty(factory.provider, method, { ...property, value: function (...args) {
        counts[count]++; return Reflect.apply(original, this, args);
      } });
    }
    return factory;
  };
  try {
    hook = registerHooks({
      resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (specifier === '@101/connect') { assert.equal(fileURLToPath(result.url), sdk.publicEntry);
          resolved.push({ specifier, parentURL: context.parentURL, url: result.url }); }
        return result;
      },
      load(url, context, next) {
        if (url.startsWith('file:')) { const path = fileURLToPath(url), pin = known.get(path);
          assert.ok(pin, 'Unadmitted baseline module: ' + path); exactPin(pin, 'loaded input'); loaded.push({ path, sha256: pin.sha256 }); }
        else assert.ok(url.startsWith('node:'), 'Only pinned files/native built-ins');
        return next(url, context);
      },
    });
    const { createDeviceRuntime, parseDeviceDescriptor } = await import('@101/connect');
    const receiveModule = await import(pathToFileURL(inputs.receiveConsumer.path).href);
    const emitterModule = await import(pathToFileURL(inputs.emitterConsumer.path).href);
    const { createNec32IrReceiveGateway } = await import(pathToFileURL(inputs.receiveGateway.path).href);
    const { createNec32IrEmitterGateway } = await import(pathToFileURL(inputs.emitterGateway.path).href);
    receiver = reserveFactory(receiveModule, 'receive');
    receiveGateway = createNec32IrReceiveGateway({ ownerSignal: owner.signal, scope: SCOPE,
      selectedReceiver: { id: 'software-rx', profileId: RX_PROFILE }, selectedProvider: receiver.provider,
      authorizeReceiver(request) { counts.receiverAuthorizations++; originalControlRequest = request;
        originalControlGrant = Object.freeze({ request, signal: control.signal, expiresAt: request.deadline }); return originalControlGrant; },
      authorizeCapture(request) { counts.captureAuthorizations++; originalCaptureRequest = request;
        originalCaptureGrant = Object.freeze({ request, signal: captureGrantSignal.signal,
          expiresAt: Math.min(request.deadline, originalControlGrant.expiresAt) }); return originalCaptureGrant; },
      onRetire: withdraw,
    });
    runtime = createDeviceRuntime({ authorize(request) {
      counts.publicReadAuthorizations++;
      assert.deepEqual({ principalId: request.principalId, applicationId: request.applicationId, sessionId: request.sessionId }, SCOPE);
      assert.deepEqual(request.source, resource(source, 'software-nec-receiver', 'candidate'));
      assert.deepEqual(request.sink, resource(sink, 'software-nec-receiver', 'viewer'));
      assert.equal(request.sourceOperation, 'read'); assert.equal(request.sinkOperation, 'write');
      assert.equal(request.partition, undefined); originalPublicRequest = request;
      return { expiresAt: Math.min(originalControlGrant.expiresAt, originalCaptureGrant.expiresAt, captureRequest.deadline), maxAgeMs: 500, maxHz: 10 };
    } });
    const device = parseDeviceDescriptor(deviceDescription());
    source = runtime.registerSource({ device, capability: 'candidate' });
    sink = runtime.registerSink({ device, capability: 'viewer', apply(observation, context) {
      assert.equal(applyRecord, undefined, 'Exactly one genuine read apply');
      const reserved = deferred();
      applyRecord = { returnedPromise: reserved.promise, observation, context, settled: false, outcome: null,
        observedRouteId: context.routeId, observedGeneration: context.generation, returnedToSdk: false, joined: false };
      const thisApply = applyRecord;
      // Reserve the actual returned Promise first. The body runs after the SDK sees that return.
      void Promise.resolve().then(async () => {
        try {
          assert.equal(observationExpired, false);
          for (const signal of [owner.signal, control.signal, captureGrantSignal.signal, caller.signal, context.signal]) assert.equal(aborted(signal), false);
          const deadline = Math.min(originalControlGrant.expiresAt, originalCaptureGrant.expiresAt, captureRequest.deadline);
          assert.ok(performance.now() < deadline);
          assert.equal(originalControlGrant.request, originalControlRequest); assert.equal(originalCaptureGrant.request, originalCaptureRequest);
          assert.equal(originalControlRequest.generation, originalCaptureRequest.generation);
          assert.equal(originalCaptureRequest.operationId, CAPTURE_ID);
          assert.equal(connection.id, context.routeId); assert.ok(Number.isSafeInteger(context.generation) && context.generation > 0);
          assert.equal(context.isCurrent(), true);
          assert.deepEqual(observation.source, { registrationId: source.id, deviceId: 'software-nec-receiver', capabilityId: 'candidate' });
          assert.deepEqual(observation.value, publishedCandidate); assert.equal(observation.quality, 'valid');
          assert.equal(receiveGateway.status().phase, 'ready');
          delivered = observation.value; thisApply.authorityCurrentAtDelivery = true;
          note('genuine-public-read-delivered', { routeId: context.routeId, generation: context.generation });
          // Independent private cleanup only; never composed cleanup or own Connection barrier.
          await beginReceiverCleanup(); thisApply.outcome = 'fulfilled'; thisApply.settled = true; reserved.resolve();
        } catch (error) { thisApply.outcome = 'rejected'; thisApply.settled = true; thisApply.error = errorFact(error); reserved.reject(error); }
      });
      // Attach rejection observation without replacing the Promise returned to the actual runtime.
      void reserved.promise.catch(() => {});
      thisApply.returnedToSdk = true;
      return reserved.promise;
    }, release(reason, context) { note('actual-sink-release', { reason, routeId: context.routeId }); } });
    assert.ok(runtime.setReadiness(source, 'unavailable').ok); assert.ok(runtime.setReadiness(sink, 'available').ok);
    connection = runtime.route({ from: source, to: sink, ...SCOPE, sourceOperation: 'read', queueCapacity: 1, leaseMs: 500 });
    assert.equal(typeof connection.whenSettled, 'function', 'Actual SDK settlement required before receiver start');
    connectionSettlement = connection.whenSettled(); assert.equal(connection.whenSettled(), connectionSettlement);
    connectionReturn = observeReturn('actual-read-connection-return', connectionSettlement);
    observationTimer = setTimeout(() => {
      observationExpired = true; note('observation-checkpoint-authority-withdrawn');
      owner.abort(); caller.abort(); control.abort(); captureGrantSignal.abort();
      void beginReceiverCleanup();
      // No synthetic completion, raw join or external child/origin claim.
    }, 5000);
    const startPromise = receiveGateway.start({ purpose: 'authentic old workflow receiver', deadline: performance.now() + 500 });
    const startRecord = observeReturn('private-receiver-start', startPromise); const started = await startPromise; await startRecord.join;
    assert.ok(started.ok, 'Receiver start precondition: ' + JSON.stringify(started));
    captureRequest = Object.freeze({ operationId: CAPTURE_ID, purpose: 'authentic old workflow capture', signal: caller.signal, deadline: performance.now() + 500 });
    const capturePromise = receiveGateway.capture(started.value, captureRequest);
    const captureRecord = observeReturn('private-capture-return', capturePromise); const captured = await capturePromise; await captureRecord.join;
    assert.ok(captured.ok, 'Private capture precondition: ' + JSON.stringify(captured)); candidate = captured.value;
    publishedCandidate = projection(candidate); assert.ok(runtime.setReadiness(source, 'available').ok);
    assert.ok(runtime.publish(source, publishedCandidate).ok); assert.ok(connection.start().ok); runtime.flush();
    assert.ok(applyRecord && applyRecord.returnedToSdk, 'The actual runtime must invoke its registered read apply');
    await applyRecord.returnedPromise; applyRecord.joined = true;
    await connectionSettlement;
    assert.equal(applyRecord.outcome, 'fulfilled'); assert.ok(delivered);
    emitter = reserveFactory(emitterModule, 'emitter');
    emitterGateway = createNec32IrEmitterGateway({ ownerSignal: owner.signal, scope: SCOPE,
      selectedEmitter: { id: 'software-emitter-a', profileId: TX_PROFILE,
        codebook: [{ codeId: 'learned-capture', address: delivered.address, command: delivered.command }] }, selectedProvider: emitter.provider,
      authorizeEmitter() { counts.emitterActivationAuthorizations++; return undefined; },
      authorizeEmission() { counts.emitterEmissionAuthorizations++; return undefined; },
    });
    unreviewedConstructorAdmission = emitterGateway ? 'accepted' : 'denied';
    note('unchanged-constructor-outcome', { unreviewedConstructorAdmission });
  } catch (error) { primaryError = error; }
  finally {
    const reserved = deferred(); composedCleanup = reserved.promise; note('composed-cleanup-reserved');
    const joins = [beginReceiverCleanup()];
    if (runtime) joins.push(cleanupCall('public-runtime-close', () => runtime.close()));
    if (connection) joins.push(cleanupCall('public-route-stop', () => connection.stop('baseline-finally')));
    if (applyRecord) joins.push(cleanupCall('actual-read-apply-return', () => applyRecord.returnedPromise).then(() => { applyRecord.joined = true; }));
    if (connectionSettlement) joins.push(cleanupCall('actual-read-connection-settlement', () => connectionSettlement));
    if (receiveGateway) joins.push(cleanupCall('receive-gateway-close', () => receiveGateway.close()));
    if (emitterGateway) joins.push(cleanupCall('constructor-only-emitter-gateway-close', () => emitterGateway.close()));
    for (const record of factories.filter(value => value.kind === 'emitter')) {
      joins.push(cleanupCall('emitter-provider-stop', () => record.factory.provider.stop()));
      joins.push(cleanupCall('emitter-provider-close', () => { record.closePromise = record.factory.provider.close(); return record.closePromise; }));
      joins.push(cleanupCall('emitter-provider-whenSettled', () => { record.settlementPromise = record.factory.provider.whenSettled();
        record.closeAndSettlementIdentical = record.closePromise === record.settlementPromise; return record.settlementPromise; }));
    }
    await Promise.all(joins); reserved.resolve(); await composedCleanup;
    if (observationTimer) clearTimeout(observationTimer);
    if (hook) try { hook.deregister(); } catch (error) { retainCleanup('loader-observer-deregister', error); }
    for (const pin of pins) try { exactPin(pin, 'post-run pin', pin === node ? ['version', 'platform', 'architecture'] : []); }
    catch (error) { retainCleanup('post-run-pin:' + pin.path, error); }
    for (const link of links) try { assert.equal(realpathSync(link.path), link.target); }
    catch (error) { retainCleanup('post-run-native-link:' + link.path, error); }
  }
  const factoryOutcomes = factories.map(record => ({ kind: record.kind, lifecycle: record.factory.lifecycleStatus(),
    proof: record.factory.runtimeProof(), commands: [...(record.factory.commands ?? record.factory.sentTypes)],
    messages: record.factory.messages.map(value => value.type), closeAndSettlementIdentical: record.closeAndSettlementIdentical }));
  if (!primaryError && cleanupErrors.length === 0) {
    try {
      assert.equal(observationExpired, false); assert.equal(factoryOutcomes.length, 2);
      assert.deepEqual([counts.receiveOpen, counts.receiveCapture, counts.emitterOpen, counts.emitterTransmit], [1, 1, 0, 0]);
      assert.deepEqual([counts.receiverAuthorizations, counts.captureAuthorizations, counts.publicReadAuthorizations], [1, 1, 1]);
      assert.equal(counts.ownerReviewCalls, 0);
      assert.equal(counts.emitterActivationAuthorizations, 0); assert.equal(counts.emitterEmissionAuthorizations, 0);
      assert.equal(applyRecord.settled && applyRecord.joined && applyRecord.returnedToSdk && applyRecord.authorityCurrentAtDelivery, true);
      assert.equal(connection.status().state, 'closed'); assert.equal(connection.whenSettled(), connectionSettlement);
      for (const record of factoryOutcomes) {
        assert.equal(record.lifecycle.rawPending, 0); assert.equal(record.lifecycle.pendingWrites, 0);
        assert.equal(record.lifecycle.operations, 0); assert.equal(record.lifecycle.waiters, 0); assert.equal(record.lifecycle.timers, 0);
        assert.equal(record.lifecycle.childRunning, false); assert.deepEqual(record.lifecycle.failures, []);
        assert.equal(record.closeAndSettlementIdentical, true);
      }
      const rx = factoryOutcomes.find(value => value.kind === 'receive'), tx = factoryOutcomes.find(value => value.kind === 'emitter');
      assert.equal(rx.lifecycle.spawnCount, 1); assert.equal(tx.lifecycle.spawnCount, 0); assert.deepEqual(tx.commands, []);
      assert.deepEqual(rx.lifecycle.terminal, { code: 0, signal: null }); assert.deepEqual(rx.lifecycle.childClose, { code: 0, signal: null });
      assert.equal(rx.lifecycle.streams.length, 4); assert.ok(rx.lifecycle.streams.every(stream => stream.created && stream.closed));
      assert.equal(rx.proof.before?.phase, 'before'); assert.equal(rx.proof.after?.phase, 'after'); assert.equal(rx.proof.settled, true);
      // The meaningful OLD assertion occurs only after genuine capture/delivery and every known cleanup join.
      try { assert.equal(unreviewedConstructorAdmission, 'denied', SEMANTIC_RED + ': selected workflow requires owner review before learned configuration admission'); }
      catch (error) { error.semanticCode = SEMANTIC_RED; throw error; }
    } catch (error) { primaryError = error; }
  }
  const semanticOld = primaryError?.semanticCode === SEMANTIC_RED && cleanupErrors.length === 0;
  const result = { schemaVersion: 1, status: semanticOld ? 'joined-semantic-old-red' : 'baseline-precondition-or-cleanup-failure',
    manifestPath, manifestSha256: hash(releaseBytes), primaryError: primaryError ? errorFact(primaryError) : null, cleanupErrors,
    semantic: { id: SEMANTIC_RED, class: 'missing-coordinator-review-admission', unchangedEmitterConstructorDefect: false,
      unreviewedConstructorAdmission, meaningfulOldCredit: semanticOld }, counts, candidate: candidate ?? null,
    publicDelivered: delivered ?? null, actualRead: applyRecord ? { originalPublicAuthorizationRequest: originalPublicRequest, routeId: applyRecord.observedRouteId, generation: applyRecord.observedGeneration,
      returnedToSdk: applyRecord.returnedToSdk, returnedPromiseSettled: applyRecord.settled, returnedPromiseJoined: applyRecord.joined,
      outcome: applyRecord.outcome, originalAuthorityCurrentAtDelivery: applyRecord.authorityCurrentAtDelivery ?? false,
      actualConnectionSettled: connectionReturn.settled, actualConnectionOutcome: connectionReturn.outcome,
      sameConnectionSettlementPromise: connection.whenSettled() === connectionSettlement } : null,
    privateReturns: privateReturns.map(({ stage, settled, outcome, error }) => ({ stage, settled, outcome, ...(error ? { error } : {}) })),
    cleanup: [...cleanup, ...privateReturns.filter(record => record.isCleanup).map(({ stage, settled, outcome, error }) =>
      ({ stage, settled, outcome, ...(error ? { error } : {}) }))], factoryOutcomes, loaded, resolved, nativeLinks: links, events, observationExpired,
    limits: { actualReceivers: 1, actualEmitters: 0, actualInstalled: 0, operationMs: 500, observationMs: 5000,
      evidence: 'Factory internal runtime proof and shared raw close only. Root external observer independently supplies child/origin/pipe/write records.',
      physical: false, fullA07A08: false, supportPromotion: false } };
  Object.defineProperty(result, 'live', { value: Object.freeze({ primaryError, actualReadApplyPromise: applyRecord?.returnedPromise,
    actualReadConnection: connection, actualConnectionSettlementPromise: connectionSettlement, actualComposedCleanupPromise: composedCleanup,
    ownedFactories: Object.freeze(factories.map(record => Object.freeze({ kind: record.kind, factory: record.factory,
      actualClosePromise: record.closePromise, actualSettlementPromise: record.settlementPromise }))),
    actualPrivateReturns: Object.freeze(privateReturns.map(record => Object.freeze({ stage: record.stage, actual: record.actual }))) }), enumerable: false });
  try { writeFileSync(release.receiptPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { retainCleanup('create-only-baseline-receipt', error); result.status = 'baseline-precondition-or-cleanup-failure';
    result.semantic.meaningfulOldCredit = false; }
  return result;
}

// The original baseline function above remains historical OLD evidence; positive execution has its own release.
const LEARNING_INPUTS = Object.freeze({
  coordinator: 'packages/hub-server/src/nec32-ir-learning.ts', coordinatorTests: 'packages/hub-server/src/nec32-ir-learning.test.ts',
  learningConsumer: 'examples/ir-learning/consumer.mjs', installedRunner: 'tools/qa-installed-ir-learning.mjs',
});
let positiveAttempted = false;

/** Root supplies a separately reviewed positive release. No copy, build, install or process launch occurs in preflight. */
export function preflightLearningQualification(manifestPath, expectedMode) {
  assert.ok(['source-positive', 'installed-positive'].includes(expectedMode));
  assert.ok(typeof manifestPath === 'string' && isAbsolute(manifestPath)); assert.equal(realpathSync(manifestPath), manifestPath);
  const releaseBytes = readFileSync(manifestPath); assert.ok(releaseBytes.length <= 131072);
  const release = closed(JSON.parse(releaseBytes), ['schemaVersion', 'status', 'mode', 'root', 'runner', 'node', 'admission',
    'runnerReview', 'inputs', 'learningInputs', 'sdkClosureReference', 'installed', 'receiptPath'], 'learning release');
  assert.equal(release.schemaVersion, 1); assert.equal(release.status, 'root-released-ir-learning-positive'); assert.equal(release.mode, expectedMode);
  assert.ok(isAbsolute(release.root)); assert.equal(realpathSync(release.root), release.root);
  const runner = exactPin(release.runner, 'positive runner'); assert.equal(runner.path, join(release.root, 'tools/qa-ir-learning.mjs'));
  assert.equal(realpathSync(fileURLToPath(import.meta.url)), runner.path);
  const node = exactPin(release.node, 'positive node', ['version', 'platform', 'architecture']);
  assert.equal(node.version, 'v24.14.0'); assert.equal(node.platform, 'darwin'); assert.equal(node.architecture, 'arm64');
  assert.equal(node.sha256, '20a18709f0154d668f1bd6f6ea8c2a7ae001447b4b2c339732f22e57a8767a55');
  assert.equal(realpathSync(process.execPath), node.path); assert.equal(process.version, node.version); assert.equal(process.platform, node.platform); assert.equal(process.arch, node.architecture);
  const admission = exactPin(release.admission, 'learning admission'); assert.equal(admission.sha256, '7bfd886bf0b43ea00588e8cef73955f9066d2339e875fd4ad0dafb6899d82fb7');
  const runnerReview = exactPin(release.runnerReview, 'positive independent review');
  const inputs = closed(release.inputs, Object.keys(INPUTS), 'seven unchanged inputs');
  for (const [kind, [relative, bytes, sha256]] of Object.entries(INPUTS)) {
    inputs[kind] = exactPin(inputs[kind], kind); assert.equal(inputs[kind].path, join(release.root, relative));
    assert.equal(inputs[kind].bytes, bytes); assert.equal(inputs[kind].sha256, sha256);
  }
  const learningInputs = closed(release.learningInputs, Object.keys(LEARNING_INPUTS), 'four other learning inputs');
  for (const [kind, relative] of Object.entries(LEARNING_INPUTS)) { learningInputs[kind] = exactPin(learningInputs[kind], kind); assert.equal(learningInputs[kind].path, join(release.root, relative)); }
  const sdkPin = exactPin(release.sdkClosureReference, 'SDK metadata'); assert.equal(sdkPin.sha256, SDK_METADATA_SHA);
  const metadata = JSON.parse(readFileSync(sdkPin.path));
  const sdk = metadata.sdkWorkspaces.find(s => s.kind === (expectedMode === 'source-positive' ? 'actual-source-public-package-exports' : 'ordinary-installed-seven-package-SDK'));
  assert.ok(sdk && Array.isArray(sdk.pins) && sdk.publicEntry); const sdkPins = sdk.pins.map(p => exactPin(p, 'SDK file'));
  const links = [];
  let installed;
  if (expectedMode === 'source-positive') {
    assert.equal(release.installed, null);
    for (const name of PACKAGES) { const path = join(release.root, 'node_modules/@101', name), target = realpathSync(join(sdk.path, 'packages', name));
      assert.equal(realpathSync(path), target); links.push({ path, target }); }
  } else {
    installed = closed(release.installed, ['consumerRoot', 'receipt', 'manifest', 'validator'], 'ordinary installed input');
    assert.equal(realpathSync(installed.consumerRoot), sdk.path); assert.ok(release.root.startsWith(sdk.path + '/'));
    installed.receipt = exactPin(installed.receipt, 'ordinary consumer receipt'); assert.equal(installed.receipt.path, join(sdk.path, 'receipt.json'));
    installed.manifest = exactPin(installed.manifest, 'immutable SDK manifest');
    installed.validator = exactPin(installed.validator, 'read-only installed validator'); assert.equal(installed.validator.path, join(release.root, 'tools/build-pointer-bindings.mjs'));
    const receipt = JSON.parse(readFileSync(installed.receipt.path)); assert.equal(receipt.status, 'pass');
    assert.equal(receipt.manifest.path, installed.manifest.path); assert.equal(receipt.manifest.sha256, installed.manifest.sha256);
    for (const name of PACKAGES) { const path = join(sdk.path, 'node_modules/@101', name);
      assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()); assert.equal(realpathSync(path), path); }
    assert.equal(existsSync(join(release.root, 'node_modules')), false, 'Installed copied caller must resolve ordinary ancestor packages');
    assert.equal(sdk.publicEntry, join(sdk.path, 'node_modules/@101/connect/dist/index.js'));
  }
  assert.ok(typeof release.receiptPath === 'string' && isAbsolute(release.receiptPath)); assert.equal(realpathSync(dirname(release.receiptPath)), dirname(release.receiptPath));
  assert.equal(existsSync(release.receiptPath), false, 'Positive receipt is create-only');
  const pins = [runner, node, admission, runnerReview, sdkPin, ...Object.values(inputs), ...Object.values(learningInputs), ...sdkPins,
    ...(installed ? [installed.receipt, installed.manifest, installed.validator] : [])];
  return { release, releaseBytes, pins, inputs, learningInputs, sdk, links, installed };
}

export async function runLearningQualification(manifestPath, expectedMode = 'source-positive', observerInput) {
  assert.equal(positiveAttempted, false, 'One positive attempt per imported runner'); positiveAttempted = true;
  const observer = observerInput === undefined ? undefined : closed(observerInput,
    ['onOwnedFactory', 'onOwnedRoute', 'onOwnedApply', 'onOwnedPrivate'], 'positive ownership observer');
  if (observer) for (const callback of Object.values(observer)) assert.equal(typeof callback, 'function');
  const prepared = preflightLearningQualification(manifestPath, expectedMode);
  const { release, pins, sdk, links, installed } = prepared, known = new Map(pins.map(p => [p.path, p]));
  const loaded = [], resolved = [], postPinErrors = [];
  let hook, result, postPinsMatched = 0;
  try {
    hook = registerHooks({
      resolve(specifier, context, next) { const found = next(specifier, context);
        if (specifier === '@101/connect') { assert.equal(fileURLToPath(found.url), sdk.publicEntry, 'Native single public SDK entry'); resolved.push({ specifier, parentURL: context.parentURL, url: found.url }); }
        return found;
      },
      load(url, context, next) { if (url.startsWith('file:')) { const path = fileURLToPath(url), pin = known.get(path); assert.ok(pin, 'Unadmitted learning module ' + path); exactPin(pin, 'loaded learning input'); loaded.push({ path, sha256: pin.sha256 }); }
        else assert.ok(url.startsWith('node:'), 'Pinned native files and built-ins only'); return next(url, context); },
    });
    if (installed) {
      const { installedSdk } = await import(pathToFileURL(installed.validator.path).href);
      const validated = installedSdk(installed.consumerRoot, installed.manifest.path); assert.equal(validated.directory, sdk.path); assert.equal(validated.manifestSha256, installed.manifest.sha256);
    }
    const { runSoftwareLearning } = await import(pathToFileURL(prepared.learningInputs.learningConsumer.path).href);
    const node = release.node;
    result = await runSoftwareLearning({ mode: 'software-learning', runtimePins: {
      receive: { executablePath: node.path, executableSha256: node.sha256, producerSha256: prepared.inputs.receiveProducer.sha256, observerPath: prepared.inputs.observer.path, observerSha256: prepared.inputs.observer.sha256 },
      emitter: { executablePath: node.path, executableSha256: node.sha256, producerSha256: prepared.inputs.emitterProducer.sha256, observerPath: prepared.inputs.observer.path, observerSha256: prepared.inputs.observer.sha256 },
    } }, observer);
    assert.equal(result.status, 'joined-software-learning', 'Positive workflow: ' + JSON.stringify(result.primaryError)); assert.deepEqual(result.cleanupErrors, []);
    assert.deepEqual(result.reviewed.codebook, [{ codeId: 'learned-capture', address: result.captured.address, command: result.captured.command }]);
    assert.equal(result.captured.timingCount, 67); assert.equal(result.captured.totalMicros, 68060); assert.equal(result.captured.receivedCarrier, 'unknown');
    assert.equal(result.captured.canonicalRepresentation, 'reconstructed-selected-nominal'); assert.notEqual(result.captured.demodulatedSha256, result.emitted.envelopeSha256);
    assert.equal(result.emitted.envelopeSha256, result.reviewed.envelopeSha256); assert.equal(result.emitted.effect, 'dispatched'); assert.equal(result.emitted.evidence, 'provider-completed');
    assert.equal(result.coordinatorStatus.rawPending, 0); assert.equal(result.coordinatorStatus.captureAttempts, 1); assert.equal(result.coordinatorStatus.reviewAttempts, 1); assert.equal(result.coordinatorStatus.emissionAttempts, 1);
    assert.deepEqual([result.counts.receiverAuthorizations, result.counts.captureAuthorizations, result.counts.reviewAuthorizations, result.counts.emitterAuthorizations, result.counts.emissionAuthorizations, result.counts.publicRead, result.counts.publicInvoke], [1, 1, 1, 1, 1, 1, 2]);
    assert.equal(result.actualPublic.length, 2); assert.ok(result.actualPublic.every(r => r.joined && r.sameSettlement && r.applies.length === 1 && r.applies[0].joined && r.applies[0].outcome === 'fulfilled'));
    assert.equal(result.factoryOutcomes.length, 2);
    for (const factory of result.factoryOutcomes) {
      assert.equal(factory.lifecycle.spawnCount, 1); assert.equal(factory.lifecycle.rawPending, 0); assert.equal(factory.lifecycle.pendingWrites, 0);
      assert.equal(factory.lifecycle.operations, 0); assert.equal(factory.lifecycle.waiters, 0); assert.equal(factory.lifecycle.timers, 0);
      assert.equal(factory.lifecycle.childRunning, false); assert.deepEqual(factory.lifecycle.failures, []); assert.equal(factory.closeAndSettlementIdentical, true);
      assert.deepEqual(factory.lifecycle.terminal, { code: 0, signal: null }); assert.deepEqual(factory.lifecycle.childClose, { code: 0, signal: null });
      assert.equal(factory.lifecycle.streams.length, 4); assert.ok(factory.lifecycle.streams.every(s => s.created && s.closed));
      assert.equal(factory.proof.before.phase, 'before'); assert.equal(factory.proof.after.phase, 'after'); assert.equal(factory.proof.settled, true);
    }
    const parents = ['examples/ir-receive/consumer.mjs', 'examples/ir-emitter/consumer.mjs', 'packages/hub-server/src/nec32-ir-learning.ts'];
    for (const parent of parents) assert.ok(resolved.some(r => fileURLToPath(r.parentURL) === join(release.root, parent)), 'Actual native public resolve from ' + parent);
  } catch (error) {
    if (!result) result = { schemaVersion: 1, status: 'learning-failed', primaryError: errorFact(error), cleanupErrors: [] };
    else { result.status = 'learning-failed'; if (!result.primaryError) result.primaryError = errorFact(error); else result.cleanupErrors.push({ stage: 'qualification', error: errorFact(error) }); }
  } finally {
    if (hook) try { hook.deregister(); } catch (error) { postPinErrors.push({ stage: 'loader-deregister', error: errorFact(error) }); }
    for (const pin of pins) try { exactPin(pin, 'post positive pin', pin.path === release.node.path ? ['version', 'platform', 'architecture'] : []); postPinsMatched++; } catch (error) { postPinErrors.push({ stage: pin.path, error: errorFact(error) }); }
    for (const link of links) try { assert.equal(realpathSync(link.path), link.target); } catch (error) { postPinErrors.push({ stage: link.path, error: errorFact(error) }); }
  }
  result.qualification = { mode: expectedMode, manifestPath, manifestSha256: hash(prepared.releaseBytes), loaded, resolved, postPinsMatched,
    postPinErrors, publicEntry: sdk.publicEntry, topology: installed ? 'ordinary ancestor seven-package public JS; native local private TS' : 'native seven source-package exports; native local private TS',
    proofLimits: 'Internal factory origins/raw-close and actual public Promise identities. Root separately observes external child/origin/pipes/write callbacks. No physical or full A07/A08/support acceptance.' };
  result.cleanupErrors.push(...postPinErrors); if (postPinErrors.length) result.status = 'learning-failed';
  try { writeFileSync(release.receiptPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { result.cleanupErrors.push({ stage: 'create-only-positive-receipt', error: errorFact(error) }); result.status = 'learning-failed'; }
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  assert.equal(process.argv.length, 4);
  if (process.argv[2] === '--baseline-before') {
    const result = await runBaselineBefore(process.argv[3]);
    console.log(JSON.stringify({ status: result.status, meaningfulOldCredit: result.semantic.meaningfulOldCredit, primaryError: result.primaryError, cleanupErrors: result.cleanupErrors }));
    process.exitCode = 1;
  } else {
    assert.equal(process.argv[2], '--source-positive');
    const result = await runLearningQualification(process.argv[3], 'source-positive');
    console.log(JSON.stringify({ status: result.status, primaryError: result.primaryError, cleanupErrors: result.cleanupErrors }));
    process.exitCode = result.status === 'joined-software-learning' ? 0 : 1;
  }
}
