import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import { createMotorAxisGateway } from '../../packages/hub-server/src/motor-axis-gateway.ts';

const PROFILE_ID = 'app:bounded-linear-axis-mm-software/1';
const CHILD_LINE_BYTES = 1024;
const CHILD_OUTPUT_BYTES = 16384;
const PUBLIC_MAX_AGE_MS = 250;

export function childProvider(role, mode = role === 'feedback' ? 'mismatch-script' : 'normal') {
  let child;
  let exitPromise = Promise.resolve();
  let settlement = Promise.resolve();
  let session;
  let buffer = '';
  let lineBytes = 0;
  let decoder;
  let closingSession;
  let receivedBytes = 0;
  let sentBytes = 0;
  let timerCount = 0;
  let spawnCount = 0;
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

  function waitFor(match, timeout = 1000, running = child) {
    let item;
    const promise = new Promise((resolve, reject) => {
      item = { match, resolve, reject, running, timer: undefined };
      item.timer = schedule(() => {
        waiters.delete(item);
        reject(new Error(`${role} fixture deadline`));
      }, timeout);
      waiters.add(item);
    });
    void promise.catch(() => {});
    return { promise, cancel(error) {
      if (!waiters.delete(item)) return;
      item.timer.cancel(); item.reject(error);
    } };
  }

  function settleWaiters(error) {
    for (const item of waiters) {
      item.timer.cancel();
      item.reject(error);
    }
    waiters.clear();
  }

  function acceptLine(raw, running) {
    if (running !== child) throw new Error('wrong child');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('fixture object required');
    const keys = new Set();
    for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      if (!/^\s*:/.test(raw.slice(match.index + match[0].length))) continue;
      const key = JSON.parse(match[0]);
      if (keys.has(key)) throw new Error('fixture duplicate key');
      keys.add(key);
    }
    const identity = ['type', 'generation', 'token'];
    const shapes = {
      hello: ['type', 'role', 'profileId', 'softwareOnly', 'physical', 'lineBytes', 'outputBytes',
        ...(role === 'actuator' ? ['deadmanMs', 'stepMm', 'nominalStepMs'] : [])],
      ready: [...identity, ...(role === 'actuator' ? ['positionMm', 'interlockOpen'] : [])],
      unavailable: identity, stopped: identity, closed: [...identity, 'role'],
      released: [...identity, 'positionMm'], invalidated: [...identity, 'reason'],
      'position-step': [...identity, 'positionMm', ...(value.policyReturn === true ? ['policyReturn'] : ['operationId'])],
      completed: [...identity, 'operationId', 'positionMm'], cancelled: [...identity, 'operationId', 'positionMm'],
      'interlock-open': [...identity, 'operationId', 'positionMm'],
      rejected: [...identity, ...(Object.hasOwn(value, 'operationId') ? ['operationId'] : [])],
      sample: [...identity, 'operationId', 'positionMm', 'lowerLimitSafe', 'upperLimitSafe', 'sequence', 'sourceClockId', 'sourceMonotonicNs'],
    };
    const shape = shapes[value.type];
    if (!shape || Object.keys(value).length !== shape.length || !shape.every(key => Object.hasOwn(value, key))) throw new Error('fixture closed shape');
    if (value.type !== 'hello') {
      const held = session ?? closingSession;
      if (!held || held.running !== running || value.generation !== held.generation || value.token !== held.providerToken) throw new Error('fixture stale session');
    }
    if (value.type === 'ready' && role === 'actuator' && (value.positionMm !== 0 || typeof value.interlockOpen !== 'boolean')) throw new Error('fixture ready state');
    if (Object.hasOwn(value, 'positionMm') && (!Number.isInteger(value.positionMm) || value.positionMm < 0 || value.positionMm > 10)) throw new Error('fixture position');
    if (value.type === 'sample' && (typeof value.lowerLimitSafe !== 'boolean' || typeof value.upperLimitSafe !== 'boolean' ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || typeof value.sourceClockId !== 'string' ||
      typeof value.sourceMonotonicNs !== 'string' || !/^[0-9]{1,32}$/.test(value.sourceMonotonicNs))) throw new Error('fixture sample');
    messages.push(value);
    events.push(Object.freeze({ value, receivedAt: performance.now() }));
    if (value.type === 'invalidated' && session && (value.reason === 'deadman' || value.reason === 'interlock-trip')) {
      session.invalidate({ generation: session.generation, sessionToken: session.gatewayToken, reason: value.reason });
    }
    for (const item of waiters) {
      if (item.running !== running || !item.match(value)) continue;
      item.timer.cancel(); waiters.delete(item); item.resolve(value); break;
    }
  }

  async function launch() {
    if (child?.exitCode === null) return;
    const running = spawn(process.execPath,
      [new URL('./software-axis-fixtures.mjs', import.meta.url).pathname, role, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = running;
    spawnCount++;
    buffer = ''; lineBytes = 0; decoder = new TextDecoder('utf-8', { fatal: true }); closingSession = undefined;
    receivedBytes = 0;
    sentBytes = 0;
    exitPromise = new Promise((resolve, reject) => {
      running.once('error', reject);
      running.once('exit', (code, signal) => {
        const error = code === 0 ? undefined : new Error(`${role} fixture exited ${code ?? signal}`);
        if (child === running) settleWaiters(error ?? new Error(`${role} fixture exited`));
        if (child === running) child = undefined;
        if (session?.running === running) session = undefined;
        if (error) reject(error); else resolve();
      });
    });
    void exitPromise.catch(() => {});
    running.stdout.on('data', chunk => {
      if (child !== running) return;
      try {
        receivedBytes += chunk.length;
        if (receivedBytes > CHILD_OUTPUT_BYTES) throw new Error('fixture output too large');
        let start = 0;
        for (let i = 0; i <= chunk.length; i++) {
          if (i < chunk.length && chunk[i] !== 10) continue;
          const part = chunk.subarray(start, i);
          lineBytes += part.length;
          if (lineBytes >= CHILD_LINE_BYTES) throw new Error('fixture line too large');
          buffer += decoder.decode(part, {stream: true});
          if (i < chunk.length) {
            buffer += decoder.decode(); acceptLine(buffer, running); buffer = ''; lineBytes = 0;
          }
          start = i + 1;
        }
      } catch (error) {
        settleWaiters(error);
        running.kill('SIGKILL');
      }
    });
    running.stdout.on('end', () => {
      if (child !== running) return;
      try { decoder.decode(); if (buffer || lineBytes) throw new Error('fixture trailing output'); }
      catch (error) { settleWaiters(error); running.kill('SIGKILL'); }
    });
    running.stderr.on('data', () => {});
    try {
      const hello = await waitFor(value => value?.type === 'hello', 1500, running).promise;
      assert.equal(hello.role, role);
      assert.equal(hello.profileId, PROFILE_ID);
      assert.equal(hello.softwareOnly, true);
      assert.equal(hello.physical, false);
      assert.equal(hello.lineBytes, CHILD_LINE_BYTES);
      assert.equal(hello.outputBytes, CHILD_OUTPUT_BYTES);
      if (role === 'actuator') {
        assert.equal(hello.deadmanMs, 250);
        assert.equal(hello.stepMm, 1);
        assert.equal(hello.nominalStepMs, 20);
      }
    } catch (error) {
      running.kill('SIGKILL');
      await Promise.race([exitPromise.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
      throw error;
    }
  }

  function sendAndWait(message, match, timeout = 1000) {
    const running = child;
    if (!running?.stdin.writable) throw new Error(`${role} fixture unavailable`);
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > CHILD_LINE_BYTES || sentBytes + bytes > CHILD_OUTPUT_BYTES) throw new Error(`${role} command bounds exceeded`);
    const waiting = waitFor(match, timeout, running);
    try {
      running.stdin.write(line);
      sentBytes += bytes; commands.push(message.type);
    } catch (error) { waiting.cancel(error); throw error; }
    return waiting.promise;
  }

  function remaining(deadline) {
    const value = Math.ceil(deadline - performance.now());
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('expired host deadline');
    return Math.min(500, value);
  }

  const common = {
    supported: true,
    softwareOnly: true,
    profileId: PROFILE_ID,
    async open(context) {
      await launch();
      const remainingMs = remaining(context.deadline);
      const providerToken = randomBytes(16).toString('hex');
      const running = child;
      session = Object.freeze({ generation: context.generation, providerToken, gatewayToken: context.sessionToken,
        invalidate: context.invalidate ?? (() => {}), running });
      closingSession = session;
      const waiting = sendAndWait({ type: 'open', generation: context.generation, token: providerToken, remainingMs },
        value => (value.type === 'ready' || value.type === 'unavailable') &&
          value.generation === context.generation && value.token === providerToken);
      const result = await waiting;
      if (result.type !== 'ready') return 'unavailable';
      return 'ready';
    },
    stop() {
      if (!child?.stdin.writable || !session) return;
      const stopping = session;
      const waiting = sendAndWait({ type: 'stop', generation: stopping.generation, token: stopping.providerToken },
        value => value.type === 'stopped' && value.generation === stopping.generation && value.token === stopping.providerToken);
      settlement = waiting.then(() => { if (session === stopping) session = undefined; }, () => {});
    },
    async close() {
      if (!child) return;
      const running = child;
      try {
        if (!closingSession || closingSession.running !== running) throw new Error('fixture unopened');
        const waiting = sendAndWait({ type: 'close', generation: closingSession.generation, token: closingSession.providerToken },
          value => value.type === 'closed' && value.role === role);
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
    deadmanMs: 250,
    async setPosition(targetMm, context) {
      if (!session || session.running !== child || session.generation !== context.generation) return 'unavailable';
      const remainingMs = remaining(context.deadline);
      const held = session;
      const waiting = sendAndWait({ type: 'set-position', generation: held.generation, token: held.providerToken,
        operationId: context.operationId, targetMm, remainingMs }, value =>
        ['completed', 'interlock-open', 'cancelled', 'rejected'].includes(value.type) &&
          value.operationId === context.operationId && value.generation === held.generation &&
          value.token === held.providerToken, remainingMs + 100);
      settlement = waiting.then(() => {}, () => {});
      const result = await waiting;
      return result.type === 'completed' ? 'completed' : result.type === 'interlock-open' ? 'interlock-open' : 'unavailable';
    },
    async release(context) {
      if (!session || session.generation !== context.generation || !child?.stdin.writable) return;
      const releasing = session;
      const waiting = sendAndWait({ type: 'release', generation: releasing.generation, token: releasing.providerToken },
        value => value.type === 'released' && value.generation === releasing.generation && value.token === releasing.providerToken);
      settlement = waiting.then(() => {}, () => {});
      await waiting;
    },
  } : {
    ...common,
    async read(context) {
      if (!session || session.running !== child || session.generation !== context.generation) throw new Error('feedback unavailable');
      const remainingMs = remaining(context.deadline);
      const held = session;
      const waiting = sendAndWait({ type: 'observe', generation: held.generation, token: held.providerToken,
        operationId: context.operationId, remainingMs }, value =>
        ['sample', 'cancelled', 'rejected'].includes(value.type) && value.operationId === context.operationId &&
          value.generation === held.generation && value.token === held.providerToken, remainingMs + 100);
      settlement = waiting.then(() => {}, () => {});
      const result = await waiting;
      if (result.type !== 'sample') throw new Error('feedback unavailable');
      return { positionMm: result.positionMm, lowerLimitSafe: result.lowerLimitSafe,
        upperLimitSafe: result.upperLimitSafe, sequence: result.sequence,
        sourceClockId: result.sourceClockId, sourceMonotonicNs: BigInt(result.sourceMonotonicNs) };
    },
  };

  return { provider, messages, events, commands, spawnCount: () => spawnCount,
    status: () => ({ waiters: waiters.size, timers: timerCount, childRunning: Boolean(child) }),
    bounds: () => ({ receivedBytes, sentBytes, lineBytes: CHILD_LINE_BYTES, outputBytes: CHILD_OUTPUT_BYTES }) };
}

export async function applyPublicAxisCommand(gateway, epoch, observation, context, originalDeadline) {
  if (!epoch || !context.isCurrent() || context.signal.aborted || !Number.isFinite(originalDeadline) ||
    performance.now() >= originalDeadline) return { ok: false, reason: 'expired' };
  const fence = setInterval(() => { if (!context.isCurrent()) void gateway.stop(); }, 5);
  try {
    const result = await gateway.setPosition(epoch, { operationId: context.operationId,
      targetMm: observation.value, purpose: 'selected software axis command', signal: context.signal,
      deadline: originalDeadline });
    if (!context.isCurrent() && result.ok) return { ok: false, reason: 'retired', issued: true, effect: 'uncertain' };
    return result;
  } finally { clearInterval(fence); }
}

export function publicAxisCommandSink(gateway, getEpoch, deadlines, results) {
  let ownedRoute;
  return {
    async apply(observation, context) {
      const epoch = getEpoch();
      if (!epoch || !context.isCurrent()) return;
      ownedRoute = { routeId: context.routeId, epoch };
      const deadline = deadlines.get(context.operationId);
      deadlines.delete(context.operationId);
      results.push(await applyPublicAxisCommand(gateway, epoch, observation, context, deadline));
    },
    release(_reason, context) {
      const held = ownedRoute;
      if (!held || held.routeId !== context.routeId || getEpoch() !== held.epoch) return;
      ownedRoute = undefined;
      void gateway.stop();
    },
  };
}

async function waitForPhase(gateway, expected, timeoutMs = 1000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (gateway.status().phase === expected) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`gateway phase did not become ${expected}`);
}

async function waitForRetirement(gateway, timeoutMs = 1000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (gateway.status().phase !== 'ready') return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('gateway did not retire');
}

async function runInterlockOpenScenario() {
  const actuator = childProvider('actuator', 'interlock-open');
  const feedback = childProvider('feedback', 'mismatch-script');
  const owner = new AbortController();
  const authorize = request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1000 });
  const gateway = createMotorAxisGateway({ ownerSignal: owner.signal,
    scope: { principalId: 'axis-owner', applicationId: 'axis-policy-example', sessionId: 'interlock-open-session' },
    selectedAxis: { id: 'software-axis-interlock-open', profileId: PROFILE_ID },
    actuatorProvider: actuator.provider, feedbackProvider: feedback.provider,
    authorizeActivation: authorize, authorizeSet: authorize, authorizeObserve: authorize, onRetire() {} });
  try {
    const started = await gateway.start({ purpose: 'actual child open interlock', deadline: performance.now() + 450 });
    assert.ok(started.ok); if (!started.ok) throw new Error('interlock-open start failed');
    const result = await gateway.setPosition(started.value, { operationId: 'interlock-open-1', targetMm: 3,
      purpose: 'actual child interlock denial', signal: owner.signal, deadline: performance.now() + 400 });
    assert.deepEqual(result, { ok: false, reason: 'interlock-open', issued: true, effect: 'uncertain' });
    assert.equal(actuator.messages.some(value => value.type === 'position-step'), false);
    assert.equal(actuator.messages.find(value => value.type === 'interlock-open')?.positionMm, 0);
  } finally {
    await gateway.close();
  }
  return { actuatorLifecycle: actuator.status(), feedbackLifecycle: feedback.status() };
}

async function runInterlockScenario() {
  const actuator = childProvider('actuator', 'interlock-trip');
  const feedback = childProvider('feedback', 'mismatch-script');
  const owner = new AbortController();
  let withdrawals = 0;
  const gateway = createMotorAxisGateway({
    ownerSignal: owner.signal,
    scope: { principalId: 'axis-owner', applicationId: 'axis-policy-example', sessionId: 'interlock-session' },
    selectedAxis: { id: 'software-axis-interlock', profileId: PROFILE_ID },
    actuatorProvider: actuator.provider,
    feedbackProvider: feedback.provider,
    authorizeActivation: request => ({ request, signal: owner.signal, expiresAt: performance.now() + 2000 }),
    authorizeSet: request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1000 }),
    authorizeObserve: request => ({ request, signal: owner.signal, expiresAt: performance.now() + 1000 }),
    onRetire() { withdrawals++; },
  });
  try {
    const started = await gateway.start({ purpose: 'actual child interlock policy', deadline: performance.now() + 450 });
    assert.ok(started.ok); if (!started.ok) throw new Error('interlock start failed');
    const result = await gateway.setPosition(started.value, { operationId: 'interlock-1', targetMm: 3,
      purpose: 'actual child interlock trip', signal: owner.signal, deadline: performance.now() + 450 });
    assert.equal(result.ok, false);
    await waitForRetirement(gateway);
    await gateway.stop();
    assert.equal(withdrawals, 1);
    assert.ok(actuator.messages.some(value => value.type === 'invalidated' && value.reason === 'interlock-trip'));
    assert.ok(actuator.messages.findIndex(value => value.type === 'invalidated' && value.reason === 'interlock-trip') <
      actuator.messages.findIndex(value => value.type === 'position-step' && value.policyReturn === true));
  } finally {
    await gateway.close();
  }
  return { withdrawals, actuatorLifecycle: actuator.status(), feedbackLifecycle: feedback.status() };
}

async function runPublicAuthorityScenario(mode) {
  const owner = new AbortController();
  const actuator = childProvider('actuator');
  const feedback = childProvider('feedback');
  const approve = request => ({ request, signal: owner.signal, expiresAt: performance.now() + 2000 });
  const scope = { principalId: 'axis-owner', applicationId: 'axis-public-authority', sessionId: mode };
  const gateway = createMotorAxisGateway({ ownerSignal: owner.signal, scope,
    selectedAxis: { id: 'axis-public-pair', profileId: PROFILE_ID }, actuatorProvider: actuator.provider,
    feedbackProvider: feedback.provider, authorizeActivation: approve, authorizeSet: approve,
    authorizeObserve: approve, onRetire() {} });
  const runtime = createDeviceRuntime({ now: () => performance.now(), authorize: () => ({
    expiresAt: performance.now() + 1000, maxAgeMs: 500, maxHz: 20 }) });
  const results = [];
  let route;
  let epoch;
  try {
    const start = await gateway.start({ purpose: 'public authority child test', deadline: performance.now() + 450 });
    assert.ok(start.ok); epoch = start.value;
    const schema = { type: 'scalar', unit: 'mm', min: 0, max: 10, resolution: 1 };
    const device = parseDeviceDescriptor({ schemaVersion: 1, id: 'public-axis-authority', label: 'Public axis authority',
      revision: 1, adapter: { id: 'example:axis', version: '1.0.0' }, runtime: { platform: 'node' }, capabilities: [
        { id: 'target', semantic: 'example:axis/1', schemaVersion: 1, kind: 'event', value: schema,
          delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['subscribe'] },
        { id: 'set', semantic: 'example:axis/1', schemaVersion: 1, kind: 'command', value: schema,
          delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['invoke'], ownership: { mode: 'exclusive' } },
      ] });
    const deadline = performance.now() + (mode === 'expiry' ? 65 : 400);
    const sink = runtime.registerSink({ device, capability: 'set',
      ...publicAxisCommandSink(gateway, () => epoch, new Map([['1', deadline]]), results) });
    const source = runtime.registerSource({ device, capability: 'target' });
    runtime.setReadiness(source, 'available'); runtime.setReadiness(sink, 'available');
    route = runtime.route({ from: source, to: sink, ...scope, sourceOperation: 'subscribe', sinkOperation: 'invoke',
      leaseMs: 1000, queueCapacity: 1 });
    assert.ok(route.start().ok);
    assert.ok(runtime.publish(source, mode === 'revoke-completed' ? 4 : 8, { operationId: '1', deadline }).ok);
    runtime.flush();
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.ok(actuator.messages.some(value => value.type === 'position-step'));
    if (mode === 'revoke') runtime.revoke(route);
    for (let turn = 0; turn < 120 && !results.length; turn++) {
      runtime.flush(); await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(results.length, 1);
    if (mode === 'revoke-completed') {
      assert.equal(results[0].ok, true); runtime.revoke(route);
      assert.notEqual(gateway.status().phase, 'ready'); await gateway.stop();
      assert.ok(actuator.messages.some(value => value.policyReturn === true));
    } else {
      assert.equal(results[0].ok, false);
      assert.equal(actuator.messages.some(value => value.type === 'completed'), false);
    }
    assert.equal(runtime.publish(source, 8, { operationId: '1', deadline: performance.now() + 400 }).ok, false);
  } finally { route?.stop(); await gateway.close(); runtime.close(); }
  assert.deepEqual(actuator.status(), { waiters: 0, timers: 0, childRunning: false });
  assert.deepEqual(feedback.status(), { waiters: 0, timers: 0, childRunning: false });
  return { mode, results, actuatorLifecycle: actuator.status(), feedbackLifecycle: feedback.status() };
}

export async function runMotorAxisConsumer() {
  const actuator = childProvider('actuator', 'normal');
  const feedback = childProvider('feedback', 'mismatch-script');
  const owner = new AbortController();
  const control = new AbortController();
  const setGrant = new AbortController();
  const observeGrant = new AbortController();
  const scope = { principalId: 'axis-owner', applicationId: 'motor-axis-example', sessionId: 'loopback-session' };
  let allowControl = false;
  let allowSet = false;
  let allowObserve = false;
  let epoch;
  let publishedFeedback;
  let withdrawPublic = () => {};
  let withdrawals = 0;
  let feedbackGrantKey;

  const gateway = createMotorAxisGateway({
    ownerSignal: owner.signal,
    scope,
    selectedAxis: { id: 'software-axis-pair', profileId: PROFILE_ID },
    actuatorProvider: actuator.provider,
    feedbackProvider: feedback.provider,
    authorizeActivation: request => allowControl ? { request, signal: control.signal,
      expiresAt: performance.now() + 5000 } : undefined,
    authorizeSet: request => allowSet ? { request, signal: setGrant.signal,
      expiresAt: performance.now() + 1000 } : undefined,
    authorizeObserve: request => allowObserve ? { request, signal: observeGrant.signal,
      expiresAt: performance.now() + 1000 } : undefined,
    onRetire() { withdrawals++; withdrawPublic(); },
  });

  const routeGrants = new Set();
  const routeKey = request => JSON.stringify([request.principalId, request.applicationId, request.sessionId,
    request.source.registrationId, request.sink.registrationId, request.sourceOperation, request.sinkOperation]);
  const runtime = createDeviceRuntime({ now: () => performance.now(), clockDomain: 'motor-axis-gateway-monotonic',
    authorize: request => {
      const key = routeKey(request);
      return routeGrants.has(key) ? { expiresAt: performance.now() + 1000,
        maxAgeMs: key === feedbackGrantKey ? PUBLIC_MAX_AGE_MS : 500, maxHz: 20 } : undefined;
    } });
  const positionSchema = { type: 'scalar', unit: 'mm', min: 0, max: 10, resolution: 1 };
  const commandDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'software-axis-command',
    label: 'Software axis command', revision: 1, adapter: { id: 'example:software-axis', version: '1.0.0' },
    runtime: { platform: 'node-loopback-fixture' }, capabilities: [
      { id: 'target', semantic: 'example:software-axis-position/1', schemaVersion: 1, kind: 'event',
        value: positionSchema, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['subscribe'] },
      { id: 'set', semantic: 'example:software-axis-position/1', schemaVersion: 1, kind: 'command',
        value: positionSchema, delivery: { mode: 'reliable', maxAgeMs: 500 }, permissions: ['invoke'],
        ownership: { mode: 'exclusive' } },
    ] });
  const feedbackSchema = { type: 'record', fields: {
    positionMm: positionSchema,
    lowerLimitSafe: { type: 'boolean' }, upperLimitSafe: { type: 'boolean' },
    sensorSequence: { type: 'scalar', unit: 'sample', min: 1, max: 32, resolution: 1 },
    relation: { type: 'enum', values: ['matches-target', 'contradicts-target', 'no-target'] },
    feedbackSource: { type: 'enum', values: ['software-state'] }, physical: { type: 'boolean' },
    physicalState: { type: 'enum', values: ['unverified'] }, captureTimeKnown: { type: 'boolean' },
    freshnessBasis: { type: 'enum', values: ['gateway-receipt'] },
  } };
  const feedbackDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'software-axis-feedback',
    label: 'Software axis feedback', revision: 1, adapter: { id: 'example:software-axis-feedback', version: '1.0.0' },
    runtime: { platform: 'node-loopback-fixture' }, capabilities: [
      { id: 'sample', semantic: 'example:software-axis-feedback/1', schemaVersion: 1, kind: 'property', value: feedbackSchema,
        delivery: { mode: 'latest', maxHz: 20, maxAgeMs: PUBLIC_MAX_AGE_MS }, permissions: ['read'] },
      { id: 'viewer', semantic: 'example:software-axis-feedback/1', schemaVersion: 1, kind: 'property', value: feedbackSchema,
        delivery: { mode: 'latest', maxHz: 20, maxAgeMs: PUBLIC_MAX_AGE_MS }, permissions: ['write'],
        ownership: { mode: 'observe' } },
    ] });

  const commandResults = [];
  const commandDeadlines = new Map();
  const commandSource = runtime.registerSource({ device: commandDevice, capability: 'target' });
  const commandSink = runtime.registerSink({ device: commandDevice, capability: 'set',
    ...publicAxisCommandSink(gateway, () => epoch, commandDeadlines, commandResults) });
  const feedbackSource = runtime.registerSource({ device: feedbackDevice, capability: 'sample' });
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

  function publishObservation(value) {
    publishedFeedback = { positionMm: value.positionMm,
      lowerLimitSafe: value.lowerLimitSafe, upperLimitSafe: value.upperLimitSafe,
      sensorSequence: value.sensorSequence, relation: value.relation,
      feedbackSource: value.feedbackSource, physical: value.physical,
      physicalState: value.physicalState, captureTimeKnown: value.captureTimeKnown,
      freshnessBasis: value.freshnessBasis };
    const feedbackProvenance = { sourceClockId: value.sourceClockId,
      sourceMonotonicNs: value.sourceMonotonicNs.toString(), sourceClockMapping: null,
      feedbackGeneration: value.feedbackGeneration, providerKind: value.providerKind,
      independentlyScripted: true };
    runtime.setReadiness(feedbackSource, 'available');
    assert.ok(runtime.publish(feedbackSource, publishedFeedback, { timestamp: value.gatewayReceivedAt,
      clockDomain: value.receiptClockDomain, quality: 'valid', provenance: feedbackProvenance }).ok);
  }

  async function settle(connection) {
    for (let turn = 0; turn < 120 && connection.status().pending; turn++) {
      runtime.flush();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(connection.status().pending, 0);
  }

  let commandConnection;
  let readConnection;
  let observation;
  let interlockScenario;
  let interlockOpenScenario;
  try {
    assert.deepEqual(await gateway.start({ purpose: 'denied activation', deadline: performance.now() + 400 }),
      { ok: false, reason: 'denied' });
    assert.equal(actuator.spawnCount(), 0);
    assert.equal(feedback.spawnCount(), 0);
    allowControl = true;
    const started = await gateway.start({ purpose: 'selected software axis', deadline: performance.now() + 450 });
    assert.ok(started.ok); if (!started.ok) throw new Error('axis start failed');
    epoch = started.value;

    allowObserve = true;
    const publicObservation = await gateway.observePosition(epoch, { operationId: 'observe-public',
      purpose: 'independent public feedback', signal: owner.signal, deadline: performance.now() + 400 });
    assert.ok(publicObservation.ok); if (!publicObservation.ok) throw new Error('public observation failed');
    assert.equal(publicObservation.value.relation, 'no-target');
    publishObservation(publicObservation.value);
    routeGrants.add(feedbackGrantKey);
    readConnection = feedbackRoute();
    assert.ok(readConnection.start().ok);
    runtime.flush(); await settle(readConnection);
    assert.deepEqual(feedbackValues, [publishedFeedback]);
    assert.equal(feedbackDeliveries[0].timestamp, publicObservation.value.gatewayReceivedAt);
    assert.equal(feedbackDeliveries[0].provenance.sourceClockMapping, null);
    runtime.revoke(readConnection);
    readConnection = undefined;
    const staleWait = publicObservation.value.gatewayReceivedAt + PUBLIC_MAX_AGE_MS + 5 - performance.now();
    if (staleWait > 0) await new Promise(resolve => setTimeout(resolve, staleWait));
    assert.deepEqual(feedbackRoute().start(), { ok: false, reason: 'stale' });

    routeGrants.add(commandGrantKey);
    commandConnection = commandRoute();
    assert.ok(commandConnection.start().ok);
    commandDeadlines.set('1', performance.now() + 400);
    const deniedPublication = runtime.publish(commandSource, 4, { operationId: '1', deadline: commandDeadlines.get('1') });
    assert.ok(deniedPublication.ok, JSON.stringify(deniedPublication));
    runtime.flush(); await settle(commandConnection);
    assert.deepEqual(commandResults, [{ ok: false, reason: 'denied' }]);
    assert.equal(actuator.commands.includes('set-position'), false);

    allowSet = true;
    commandDeadlines.set('2', performance.now() + 400);
    assert.ok(runtime.publish(commandSource, 4, { operationId: '2', deadline: commandDeadlines.get('2') }).ok);
    runtime.flush(); await settle(commandConnection);
    assert.ok(commandResults.at(-1)?.ok);
    assert.equal(commandResults.at(-1)?.value.observedPositionMm, 'unknown');
    assert.deepEqual(actuator.messages.filter(value => value.type === 'position-step' && value.operationId === '2')
      .map(value => value.positionMm), [1, 2, 3, 4]);
    const stepEvents = actuator.events.filter(event => event.value.type === 'position-step' && event.value.operationId === '2');
    assert.equal(stepEvents.length, 4);
    assert.ok(stepEvents.at(-1).receivedAt - stepEvents[0].receivedAt >= 40);

    observation = await gateway.observePosition(epoch, { operationId: 'observe-1', purpose: 'independent feedback',
      signal: owner.signal, deadline: performance.now() + 400 });
    assert.ok(observation.ok); if (!observation.ok) throw new Error('observation failed');
    assert.equal(observation.value.relation, 'contradicts-target');
    assert.equal(observation.value.captureTimeKnown, false);
    assert.equal(observation.value.sourceClockMapping, null);
    publishObservation(observation.value);
    readConnection = feedbackRoute(); assert.ok(readConnection.start().ok);
    assert.equal(readConnection.limits().maxAgeMs, PUBLIC_MAX_AGE_MS);
    runtime.flush(); await settle(readConnection);
    const delivered = feedbackDeliveries.at(-1);
    assert.equal(delivered.value.positionMm, 3);
    assert.equal(delivered.value.relation, 'contradicts-target');
    assert.equal(delivered.timestamp, observation.value.gatewayReceivedAt);
    assert.equal(delivered.clockDomain, observation.value.receiptClockDomain);
    assert.equal(delivered.quality, 'valid');
    assert.ok(delivered.receivedAt >= delivered.timestamp);
    assert.equal(delivered.provenance.sourceMonotonicNs, observation.value.sourceMonotonicNs.toString());
    assert.equal(delivered.provenance.sourceClockMapping, null);
    assert.equal(delivered.value.physical, false);
    assert.equal(delivered.value.physicalState, 'unverified');
    assert.equal(delivered.value.captureTimeKnown, false);
    assert.equal(delivered.value.freshnessBasis, 'gateway-receipt');
    readConnection = undefined;


    await waitForPhase(gateway, 'retiring', 1000);
    await gateway.stop();
    assert.equal(withdrawals, 1);
    assert.ok(actuator.messages.some(value => value.type === 'invalidated' && value.reason === 'deadman'));
    assert.ok(actuator.messages.findIndex(value => value.type === 'invalidated' && value.reason === 'deadman') <
      actuator.messages.findIndex(value => value.type === 'position-step' && value.policyReturn === true));
    assert.equal(runtime.publish(commandSource, 2, { operationId: '3', deadline: performance.now() + 400 }).ok, false);
  } finally {
    commandConnection?.stop('example-complete');
    readConnection?.stop('example-complete');
    await gateway.close();
    runtime.close();
  }
  interlockOpenScenario = await runInterlockOpenScenario();
  interlockScenario = await runInterlockScenario();
  const publicAuthorityScenarios = [];
  for (const mode of ['expiry', 'revoke', 'revoke-completed']) publicAuthorityScenarios.push(await runPublicAuthorityScenario(mode));
  const result = {
    status: 'pass',
    kind: 'separate-process-loopback-motor-axis-pair',
    checks: {
      deniedControlStartsNoChild: true,
      approvedPublicRoutePrivateSetDenied: true,
      privateSetUsesActuatorChild: true,
      nominalVirtualSteps: true,
      schedulerQualifiedVirtualTiming: true,
      commandCompletionDoesNotClaimObservation: true,
      independentFeedbackAuthority: true,
      exactPublicCommandAndFeedbackRoutes: true,
      contradictoryFeedbackDeliveredThroughPublicReadWrite: true,
      publicCommandSignalAndOriginalDeadlineRetained: true,
      feedbackSourceSoftwareState: true,
      physicalFalseAndUnverified: true,
      captureTimeUnknown: true,
      freshnessGatewayReceipt: true,
      noCrossProcessClockComparison: true,
      actualChildDeadmanRetiresSession: true,
      actualChildInterlockOpenDeniesNoChange: true,
      actualChildInterlockTripRetiresSession: true,
      synchronousWithdrawalOnPolicyInvalidation: true,
      bothChildrenSettled: true,
    },
    limitations: {
      hardware: 'unverified', physicalPosition: 'unverified', physicalSlew: 'unverified',
      physicalDeadman: 'unverified', physicalInterlock: 'unverified', sourceClockMapping: null,
      softwareTiming: 'scheduler-qualified-not-hard-real-time',
      matchingFeedbackMeaning: 'independently-scripted-software-state-only',
    },
    commandResults,
    observedRelation: observation?.ok ? observation.value.relation : undefined,
    actuatorCommands: actuator.commands,
    feedbackCommands: feedback.commands,
    actuatorLifecycle: actuator.status(),
    feedbackLifecycle: feedback.status(),
    childBounds: { actuator: actuator.bounds(), feedback: feedback.bounds() },
    interlockOpenScenario,
    interlockScenario,
    publicAuthorityScenarios,
  };
  assert.deepEqual(result.actuatorLifecycle, { waiters: 0, timers: 0, childRunning: false });
  assert.deepEqual(result.feedbackLifecycle, { waiters: 0, timers: 0, childRunning: false });
  assert.deepEqual(interlockScenario.actuatorLifecycle, { waiters: 0, timers: 0, childRunning: false });
  assert.deepEqual(interlockScenario.feedbackLifecycle, { waiters: 0, timers: 0, childRunning: false });
  assert.deepEqual(interlockOpenScenario.actuatorLifecycle, { waiters: 0, timers: 0, childRunning: false });
  assert.deepEqual(interlockOpenScenario.feedbackLifecycle, { waiters: 0, timers: 0, childRunning: false });
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await runMotorAxisConsumer();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
