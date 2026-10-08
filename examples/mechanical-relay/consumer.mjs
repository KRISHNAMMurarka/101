import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createMechanicalRelayGateway } from '../../packages/hub-server/src/mechanical-relay-gateway.ts';

const PUBLIC_FEEDBACK_MAX_AGE_MS = 250;
const CHILD_LINE_BYTES = 1024;
const CHILD_OUTPUT_BYTES = 16384;

function childProvider(role, mode = 'normal-match') {
  let child;
  let exitPromise = Promise.resolve();
  let settlement = Promise.resolve();
  let session;
  let buffer = '';
  let timerCount = 0;
  let spawnCount = 0;
  let receivedBytes = 0;
  let sentBytes = 0;
  const messages = [];
  const events = [];
  const commands = [];
  const waiters = new Set();

  function schedule(callback, delay) {
    let live = true;
    timerCount++;
    const id = setTimeout(() => {
      if (!live) return;
      live = false;
      timerCount--;
      callback();
    }, delay);
    return { cancel() {
      if (!live) return;
      live = false;
      timerCount--;
      clearTimeout(id);
    } };
  }

  function waitFor(match, timeout = 500, from = 0) {
    const prior = messages.slice(from).find(match);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const item = { match, resolve, reject, timer: undefined };
      item.timer = schedule(() => {
        waiters.delete(item);
        reject(new Error(`${role} fixture deadline`));
      }, timeout);
      waiters.add(item);
    });
  }

  function settleWaiters(error) {
    for (const item of waiters) {
      item.timer.cancel();
      item.reject(error);
    }
    waiters.clear();
  }

  function acceptLine(raw) {
    if (Buffer.byteLength(raw) > CHILD_LINE_BYTES) throw new Error('fixture line too large');
    const value = JSON.parse(raw);
    messages.push(value);
    events.push(Object.freeze({ value, receivedAt: performance.now() }));
    for (const item of waiters) {
      if (!item.match(value)) continue;
      item.timer.cancel();
      waiters.delete(item);
      item.resolve(value);
      break;
    }
  }

  async function launch() {
    if (child?.exitCode === null) return;
    const messageStart = messages.length;
    child = spawn(process.execPath, [new URL('./software-relay-fixtures.mjs', import.meta.url).pathname, role, mode],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    spawnCount++;
    buffer = '';
    receivedBytes = 0;
    sentBytes = 0;
    const running = child;
    exitPromise = new Promise((resolve, reject) => {
      running.once('error', reject);
      running.once('exit', (code, signal) => {
        const error = code === 0 ? undefined : new Error(`${role} fixture exited ${code ?? signal}`);
        settleWaiters(error ?? new Error(`${role} fixture exited`));
        if (child === running) child = undefined;
        session = undefined;
        if (error) reject(error); else resolve();
      });
    });
    void exitPromise.catch(() => {});
    running.stdout.on('data', chunk => {
      try {
        receivedBytes += chunk.length;
        if (receivedBytes > CHILD_OUTPUT_BYTES) throw new Error('fixture output too large');
        buffer += chunk.toString('utf8');
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          acceptLine(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
      } catch (error) {
        settleWaiters(error);
        running.kill('SIGKILL');
      }
    });
    running.stderr.on('data', () => {});
    try {
      const hello = await waitFor(value => value?.type === 'hello', 1500, messageStart);
      assert.equal(hello.role, role);
      assert.equal(hello.profileId, 'app:single-relay-software-interlocked/1');
      assert.equal(hello.softwareOnly, true);
      assert.equal(hello.physical, false);
      assert.equal(hello.lineBytes, CHILD_LINE_BYTES);
      assert.equal(hello.outputBytes, CHILD_OUTPUT_BYTES);
    } catch (error) {
      running.kill('SIGKILL');
      await Promise.race([exitPromise.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
      throw error;
    }
  }

  function send(message) {
    if (!child?.stdin.writable) throw new Error(`${role} fixture unavailable`);
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line);
    sentBytes += bytes;
    if (bytes > CHILD_LINE_BYTES || sentBytes > CHILD_OUTPUT_BYTES) throw new Error(`${role} command bounds exceeded`);
    commands.push(message.type);
    child.stdin.write(line);
  }

  const common = {
    supported: true,
    softwareOnly: true,
    async open(context) {
      await launch();
      const token = randomBytes(16).toString('hex');
      const waiting = waitFor(value => (value.type === 'ready' || value.type === 'unavailable') &&
        value.generation === context.generation && value.token === token);
      send({ type: 'open', generation: context.generation, token, deadline: context.deadline });
      const result = await waiting;
      if (result.type !== 'ready') return 'unavailable';
      session = Object.freeze({ generation: context.generation, token });
      return 'ready';
    },
    stop() {
      if (!child?.stdin.writable || !session) return;
      const stopping = session;
      const waiting = waitFor(value => value.type === 'stopped' && value.generation === stopping.generation &&
        value.token === stopping.token);
      send({ type: 'stop', ...stopping });
      settlement = waiting.then(() => {
        if (session === stopping) session = undefined;
      });
    },
    async close() {
      if (!child) return;
      const running = child;
      const waiting = waitFor(value => value.type === 'closed' && value.role === role);
      try {
        send({ type: 'close' });
        await waiting;
        await exitPromise;
      } catch {
        running.kill('SIGKILL');
        await exitPromise.catch(() => {});
      }
    },
    whenSettled() { return settlement; },
  };

  const provider = role === 'actuator' ? {
    ...common,
    watchdogMs: 250,
    async setState(state, context) {
      if (!session || session.generation !== context.generation) return 'unavailable';
      const waiting = waitFor(value => ['completed', 'interlock-open', 'cancelled', 'rejected'].includes(value.type) &&
        value.operationId === context.operationId, Math.max(1, Math.ceil(context.deadline - performance.now())));
      send({ type: 'set', generation: session.generation, token: session.token, operationId: context.operationId,
        state, deadline: context.deadline });
      const result = await waiting;
      return result.type === 'completed' ? 'completed' : result.type === 'interlock-open' ? 'interlock-open' : 'unavailable';
    },
    async release(context) {
      if (!session || session.generation !== context.generation) return;
      const releasing = session;
      const waiting = waitFor(value => value.type === 'released' && value.generation === releasing.generation &&
        value.token === releasing.token);
      send({ type: 'release', ...releasing });
      await waiting;
    },
  } : {
    ...common,
    async read(context) {
      if (!session || session.generation !== context.generation) throw new Error('feedback unavailable');
      const waiting = waitFor(value => ['sample', 'cancelled', 'rejected'].includes(value.type) &&
        value.operationId === context.operationId, Math.max(1, Math.ceil(context.deadline - performance.now())));
      send({ type: 'read', generation: session.generation, token: session.token, operationId: context.operationId,
        deadline: context.deadline });
      const result = await waiting;
      if (result.type !== 'sample') throw new Error('feedback unavailable');
      return { state: result.state, limitSafe: result.limitSafe, sequence: result.sequence,
        sourceClockId: result.sourceClockId, sourceMonotonicNs: BigInt(result.sourceMonotonicNs) };
    },
  };

  return { provider, messages, events, commands, spawnCount: () => spawnCount,
    status: () => ({ waiters: waiters.size, timers: timerCount, childRunning: Boolean(child) }),
    bounds: () => ({ receivedBytes, sentBytes, lineBytes: CHILD_LINE_BYTES, outputBytes: CHILD_OUTPUT_BYTES }) };
}

export async function runMechanicalRelayConsumer() {
  const actuator = childProvider('actuator');
  const feedback = childProvider('feedback');
  const owner = new AbortController();
  const controlGrant = new AbortController();
  const setGrant = new AbortController();
  const feedbackGrant = new AbortController();
  const scope = { principalId: 'relay-owner', applicationId: 'mechanical-relay-example', sessionId: 'loopback-session' };
  let allowControl = false;
  let allowSet = false;
  let allowFeedback = false;
  let epoch;
  let publishedFeedback;
  let feedbackProvenance;
  let receiptProvenance;
  let withdrawPublic = () => {};

  const gateway = createMechanicalRelayGateway({
    ownerSignal: owner.signal,
    scope,
    selectedRelay: { id: 'software-relay-pair', profileId: 'app:single-relay-software-interlocked/1' },
    actuatorProvider: actuator.provider,
    feedbackProvider: feedback.provider,
    authorizeActivation: request => allowControl ? { request, signal: controlGrant.signal,
      expiresAt: performance.now() + 5000 } : undefined,
    authorizeSet: request => allowSet ? { request, signal: setGrant.signal,
      expiresAt: performance.now() + 5000 } : undefined,
    authorizeFeedback: request => allowFeedback ? { request, signal: feedbackGrant.signal,
      expiresAt: performance.now() + 5000 } : undefined,
    onRetire() { withdrawPublic(); },
  });

  const routeGrants = new Set();
  let feedbackGrantKey;
  const routeKey = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId,
    request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
  const runtime = createDeviceRuntime({ now: () => performance.now(),
    clockDomain: 'mechanical-relay-gateway-monotonic', authorize: request => {
    const key = routeKey(request);
    if (!routeGrants.has(key)) return;
    return { expiresAt: performance.now() + 1000,
      maxAgeMs: key === feedbackGrantKey ? PUBLIC_FEEDBACK_MAX_AGE_MS : 500, maxHz: 20 };
  } });

  const commandDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'software-relay-command',
    label: 'Software relay command', revision: 1, adapter: { id: 'example:software-relay', version: '1.0.0' },
    runtime: { platform: 'node-loopback-fixture' }, capabilities: [
      { id: 'target', semantic: 'example:software-relay-target/1', schemaVersion: 1, kind: 'event',
        value: { type: 'enum', values: ['off', 'on'] }, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['subscribe'] },
      { id: 'set', semantic: 'example:software-relay-target/1', schemaVersion: 1, kind: 'command',
        value: { type: 'enum', values: ['off', 'on'] }, delivery: { mode: 'reliable', maxAgeMs: 500 },
        permissions: ['invoke'], ownership: { mode: 'exclusive' } },
    ] });
  const feedbackSchema = { type: 'record', fields: {
    state: { type: 'enum', values: ['off', 'on'] }, limitSafe: { type: 'boolean' },
    sensorSequence: { type: 'scalar', unit: 'sample', min: 1, max: 32, resolution: 1 },
    relation: { type: 'enum', values: ['matches-target', 'contradicts-target', 'no-target'] },
    feedbackSource: { type: 'enum', values: ['software-state'] }, physical: { type: 'boolean' },
    physicalState: { type: 'enum', values: ['unverified'] }, captureTimeKnown: { type: 'boolean' },
    freshnessBasis: { type: 'enum', values: ['gateway-receipt'] },
  } };
  const feedbackDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'software-relay-feedback',
    label: 'Software relay feedback', revision: 1, adapter: { id: 'example:software-relay-feedback', version: '1.0.0' },
    runtime: { platform: 'node-loopback-fixture' }, capabilities: [
      { id: 'sample', semantic: 'example:software-relay-feedback/1', schemaVersion: 1, kind: 'property', value: feedbackSchema,
        delivery: { mode: 'latest', maxHz: 20, maxAgeMs: PUBLIC_FEEDBACK_MAX_AGE_MS }, permissions: ['read'] },
      { id: 'viewer', semantic: 'example:software-relay-feedback/1', schemaVersion: 1, kind: 'property', value: feedbackSchema,
        delivery: { mode: 'latest', maxHz: 20, maxAgeMs: PUBLIC_FEEDBACK_MAX_AGE_MS },
        permissions: ['write'], ownership: { mode: 'observe' } },
    ] });

  const commandResults = [];
  const commandCaller = new AbortController();
  const commandSource = runtime.registerSource({ device: commandDevice, capability: 'target' });
  const commandSink = runtime.registerSink({ device: commandDevice, capability: 'set', async apply(observation, context) {
    if (!epoch || !context.isCurrent() || context.signal.aborted) return;
    commandResults.push(await gateway.setState(epoch, { operationId: context.operationId,
      state: observation.value, purpose: 'selected software relay command', signal: commandCaller.signal,
      deadline: performance.now() + 400 }));
  }, release() {} });
  const feedbackSource = runtime.registerSource({ device: feedbackDevice, capability: 'sample', snapshot: () => publishedFeedback });
  const feedbackValues = [];
  const feedbackDeliveries = [];
  const feedbackSink = runtime.registerSink({ device: feedbackDevice, capability: 'viewer',
    apply(observation) { feedbackValues.push(observation.value); feedbackDeliveries.push(observation); }, release() {} });
  runtime.setReadiness(commandSource, 'available');
  runtime.setReadiness(commandSink, 'available');
  runtime.setReadiness(feedbackSource, 'unavailable');
  runtime.setReadiness(feedbackSink, 'available');
  withdrawPublic = () => {
    publishedFeedback = undefined;
    feedbackProvenance = undefined;
    runtime.setReadiness(commandSink, 'unavailable');
    runtime.setReadiness(feedbackSource, 'unavailable');
  };

  const commandRoute = () => runtime.route({ from: commandSource, to: commandSink, ...scope,
    sourceOperation: 'subscribe', sinkOperation: 'invoke', queueCapacity: 1, leaseMs: 1000 });
  const feedbackRoute = () => runtime.route({ from: feedbackSource, to: feedbackSink, ...scope,
    sourceOperation: 'read', sinkOperation: 'write', queueCapacity: 1, leaseMs: 1000 });
  const commandGrantKey = JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId,
    commandSource.id, commandSink.id, 'subscribe', 'invoke']);
  feedbackGrantKey = JSON.stringify([scope.principalId, scope.applicationId, scope.sessionId,
    feedbackSource.id, feedbackSink.id, 'read', 'write']);

  async function settle(connection) {
    await new Promise(resolve => setTimeout(resolve, 5));
    for (let turn = 0; turn < 100 && connection.status().pending; turn++) {
      runtime.flush();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(connection.status().pending, 0);
  }

  let commandConnection;
  let readConnection;
  try {
    assert.deepEqual(await gateway.start({ purpose: 'denied control', deadline: performance.now() + 400 }),
      { ok: false, reason: 'denied' });
    assert.equal(actuator.spawnCount(), 0);
    assert.equal(feedback.spawnCount(), 0);
    allowControl = true;
    const started = await gateway.start({ purpose: 'selected software relay', deadline: performance.now() + 400 });
    assert.ok(started.ok, JSON.stringify(started));
    epoch = started.value;

    routeGrants.add(commandGrantKey);
    commandConnection = commandRoute();
    assert.ok(commandConnection.start().ok);
    assert.ok(runtime.publish(commandSource, 'on', { operationId: '1', deadline: performance.now() + 400 }).ok);
    runtime.flush();
    await settle(commandConnection);
    assert.deepEqual(commandResults, [{ ok: false, reason: 'denied' }]);
    assert.equal(actuator.commands.includes('set'), false);

    allowSet = true;
    assert.ok(runtime.publish(commandSource, 'off', { operationId: '2', deadline: performance.now() + 400 }).ok);
    runtime.flush();
    await settle(commandConnection);
    assert.ok(commandResults.at(-1)?.ok);
    assert.equal(commandResults.at(-1).value.observedState, 'unknown');

    allowFeedback = true;
    const observed = await gateway.observe(epoch, { operationId: 'independent-feedback', purpose: 'read software feedback',
      signal: new AbortController().signal, deadline: performance.now() + 400 });
    assert.ok(observed.ok);
    publishedFeedback = Object.freeze({ state: observed.value.state, limitSafe: observed.value.limitSafe,
      sensorSequence: observed.value.sensorSequence, relation: observed.value.relation,
      feedbackSource: observed.value.feedbackSource, physical: observed.value.physical,
      physicalState: observed.value.physicalState, captureTimeKnown: observed.value.captureTimeKnown,
      freshnessBasis: observed.value.freshnessBasis });
    feedbackProvenance = Object.freeze({
      feedbackGeneration: observed.value.feedbackGeneration,
      gatewayReceiptSequence: observed.value.gatewayReceiptSequence,
      receiptClockDomain: observed.value.receiptClockDomain,
      receiptAt: observed.value.receivedAt,
      providerKind: observed.value.providerKind,
      sourceClockId: observed.value.sourceClockId,
      sourceMonotonicNs: observed.value.sourceMonotonicNs.toString(),
      sourceClockMapping: null,
      independentlyScripted: true,
      physical: false,
      physicalState: 'unverified',
      captureTimeKnown: false,
      freshnessBasis: 'gateway-receipt',
    });
    receiptProvenance = feedbackProvenance;
    runtime.setReadiness(feedbackSource, 'available');
    assert.ok(runtime.publish(feedbackSource, publishedFeedback, {
      timestamp: observed.value.receivedAt,
      clockDomain: observed.value.receiptClockDomain,
      quality: 'valid',
      provenance: feedbackProvenance,
    }).ok);
    assert.equal(feedbackRoute().start().ok, false);
    routeGrants.add(feedbackGrantKey);
    readConnection = feedbackRoute();
    const readStarted = readConnection.start();
    assert.ok(readStarted.ok, JSON.stringify({ readStarted, gateway: gateway.status(), publishedFeedback }));
    runtime.flush();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(feedbackValues, [publishedFeedback]);
    assert.equal(feedbackDeliveries[0].timestamp, observed.value.receivedAt);
    assert.equal(feedbackDeliveries[0].clockDomain, observed.value.receiptClockDomain);
    assert.equal(feedbackDeliveries[0].quality, 'valid');
    assert.deepEqual(feedbackDeliveries[0].provenance, feedbackProvenance);
    assert.equal(publishedFeedback.feedbackSource, 'software-state');
    assert.equal(publishedFeedback.physical, false);
    assert.equal(publishedFeedback.captureTimeKnown, false);
    assert.equal(publishedFeedback.freshnessBasis, 'gateway-receipt');
    assert.equal(feedbackProvenance.sourceClockMapping, null);

    runtime.revoke(readConnection);
    readConnection = undefined;
    const staleWait = observed.value.receivedAt + PUBLIC_FEEDBACK_MAX_AGE_MS + 10 - performance.now();
    if (staleWait > 0) await new Promise(resolve => setTimeout(resolve, staleWait));
    assert.deepEqual(feedbackRoute().start(), { ok: false, reason: 'stale' });

    await gateway.stop();
    assert.equal(feedbackRoute().start().ok, false);
  } finally {
    if (commandConnection) runtime.revoke(commandConnection);
    if (readConnection) runtime.revoke(readConnection);
    runtime.close();
    await gateway.close();
  }

  const actuatorLifecycle = actuator.status();
  const feedbackLifecycle = feedback.status();
  assert.deepEqual(actuatorLifecycle, { waiters: 0, timers: 0, childRunning: false });
  assert.deepEqual(feedbackLifecycle, { waiters: 0, timers: 0, childRunning: false });
  assert.equal(actuator.messages.at(-1)?.type, 'closed');
  assert.equal(feedback.messages.at(-1)?.type, 'closed');

  function scenarioGateway(actuatorFixture, feedbackFixture, sessionId) {
    const scenarioOwner = new AbortController();
    const grantSignal = new AbortController();
    const authorize = request => ({ request, signal: grantSignal.signal, expiresAt: performance.now() + 5000 });
    return createMechanicalRelayGateway({ ownerSignal: scenarioOwner.signal,
      scope: { principalId: 'relay-owner', applicationId: 'mechanical-relay-example', sessionId },
      selectedRelay: { id: `software-${sessionId}`, profileId: 'app:single-relay-software-interlocked/1' },
      actuatorProvider: actuatorFixture.provider, feedbackProvider: feedbackFixture.provider,
      authorizeActivation: authorize, authorizeSet: authorize, authorizeFeedback: authorize, onRetire() {} });
  }

  const interlockActuator = childProvider('actuator', 'interlock-open');
  const interlockFeedback = childProvider('feedback');
  const interlockGateway = scenarioGateway(interlockActuator, interlockFeedback, 'interlock-session');
  const interlockStart = await interlockGateway.start({ purpose: 'software interlock', deadline: performance.now() + 400 });
  assert.ok(interlockStart.ok);
  const interlockSet = await interlockGateway.setState(interlockStart.value, { operationId: 'interlock-1', state: 'on',
    purpose: 'software interlock denial', signal: new AbortController().signal, deadline: performance.now() + 400 });
  assert.deepEqual(interlockSet, { ok: false, reason: 'interlock-open', issued: true, effect: 'uncertain' });
  assert.ok(interlockActuator.messages.some(value => value.type === 'interlock-open' && value.logicalRegister === 'off'));
  await interlockGateway.close();
  assert.deepEqual(interlockActuator.status(), { waiters: 0, timers: 0, childRunning: false });
  assert.deepEqual(interlockFeedback.status(), { waiters: 0, timers: 0, childRunning: false });

  const tripActuator = childProvider('actuator', 'interlock-trip');
  const tripFeedback = childProvider('feedback');
  const tripGateway = scenarioGateway(tripActuator, tripFeedback, 'interlock-trip-session');
  const tripStart = await tripGateway.start({ purpose: 'software interlock trip', deadline: performance.now() + 400 });
  assert.ok(tripStart.ok);
  const tripSet = await tripGateway.setState(tripStart.value, { operationId: 'interlock-trip-1', state: 'on',
    purpose: 'software interlock trip', signal: new AbortController().signal, deadline: performance.now() + 400 });
  assert.ok(tripSet.ok);
  assert.equal(tripSet.value.observedState, 'unknown');
  for (let turn = 0; turn < 40 && !tripActuator.messages.some(value =>
    value.type === 'released' && value.reason === 'interlock-trip'); turn++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(tripActuator.messages.some(value => value.type === 'released' && value.reason === 'interlock-trip'));
  await tripGateway.stop();
  await tripGateway.close();
  assert.deepEqual(tripActuator.status(), { waiters: 0, timers: 0, childRunning: false });
  assert.deepEqual(tripFeedback.status(), { waiters: 0, timers: 0, childRunning: false });

  const watchdogActuator = childProvider('actuator');
  const watchdogCaller = new AbortController();
  const watchdogGeneration = 1;
  const watchdogDeadline = performance.now() + 400;
  assert.equal(await watchdogActuator.provider.open({ generation: watchdogGeneration,
    purpose: 'software watchdog source timing', signal: watchdogCaller.signal, deadline: watchdogDeadline }), 'ready');
  assert.equal(await watchdogActuator.provider.setState('on', { generation: watchdogGeneration,
    operationId: 'watchdog-1', purpose: 'software watchdog source timing',
    signal: watchdogCaller.signal, deadline: watchdogDeadline }), 'completed');
  const watchdogCompletedAt = performance.now();
  for (let turn = 0; turn < 140 && !watchdogActuator.events.some(event =>
    event.value.type === 'released' && event.value.reason === 'watchdog'); turn++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const watchdogEvent = watchdogActuator.events.find(event =>
    event.value.type === 'released' && event.value.reason === 'watchdog');
  assert.ok(watchdogEvent);
  const watchdogElapsedMs = watchdogEvent.receivedAt - watchdogCompletedAt;
  assert.ok(watchdogElapsedMs >= 230 && watchdogElapsedMs <= 750,
    `software scheduler watchdog outside 250ms -20/+500 tolerance: ${watchdogElapsedMs}`);
  await watchdogActuator.provider.release({ generation: watchdogGeneration });
  watchdogActuator.provider.stop();
  await watchdogActuator.provider.whenSettled();
  await watchdogActuator.provider.close();
  await watchdogActuator.provider.whenSettled();
  assert.ok(watchdogActuator.messages.some(value => value.type === 'released' && value.reason === 'watchdog'));
  assert.deepEqual(watchdogActuator.status(), { waiters: 0, timers: 0, childRunning: false });

  return {
    status: 'pass',
    kind: 'separate-process-loopback-mechanical-relay-pair',
    checks: {
      deniedControlStartsNoChild: true,
      approvedPublicRoutePrivateSetDenied: true,
      privateSetUsesActuatorChild: true,
      commandCompletionDoesNotClaimObservation: true,
      independentFeedbackAuthority: true,
      exactPublicCommandAndFeedbackRoutes: true,
      feedbackSourceSoftwareState: true,
      physicalFalseAndUnverified: true,
      captureTimeUnknown: true,
      freshnessGatewayReceipt: true,
      publicFeedbackExpiresFromImmutable250msReceipt: true,
      publicFeedbackCarriesClockQualityAndProvenance: true,
      synchronousWithdrawalOnStop: true,
      bothChildrenSettled: true,
      childLocalInterlockDeniesOnWithoutRegisterChange: true,
      childLocalInterlockTripReleasesWithoutFeedbackClaim: true,
      childLocalWatchdogUses250msWithSchedulerTolerance: true,
      childLineAndOutputBoundsEnforced: true,
    },
    limitations: {
      hardware: 'unverified',
      physicalWatchdog: 'unverified',
      physicalSensor: 'unverified',
      matchingFeedbackMeaning: 'independently-scripted-software-state-only',
      sourceClockMapping: null,
      schedulerQualification: 'software watchdog observed with 250ms -20/+500 scheduler tolerance; no hard real-time guarantee',
    },
    feedbackProvenance: receiptProvenance,
    actuatorCommands: actuator.commands,
    feedbackCommands: feedback.commands,
    actuatorLifecycle,
    feedbackLifecycle,
    childBounds: { actuator: actuator.bounds(), feedback: feedback.bounds() },
    watchdogElapsedMs,
  };
}

if (process.argv[1] === import.meta.filename) {
  console.log(JSON.stringify(await runMechanicalRelayConsumer()));
}
