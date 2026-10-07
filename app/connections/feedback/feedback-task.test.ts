import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserHapticBackend, createDeviceRuntime, createHapticOutputController, getHapticOutputProfile, parseDeviceDescriptor } from '@101/connect';
import type { HapticBackend, HapticBackendOutcome, HapticPreset } from '@101/connect';
import type { FeedbackTask, FeedbackTaskOptions } from './feedback-task.ts';

const target = new URL('./feedback-task.ts', import.meta.url);
async function loadTask() {
  try { return await import('./feedback-task.ts'); }
  catch (error) {
    // Only the exact missing player leaf is feature absence. Dependency and syntax errors propagate.
    if (error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ERR_MODULE_NOT_FOUND' &&
      Object.getOwnPropertyDescriptor(error, 'url')?.value === target.href) return undefined;
    throw error;
  }
}
async function factory() {
  const api = await loadTask();
  assert.equal(typeof api?.createFeedbackTask, 'function', 'Missing local feedback player task');
  assert.ok(api);
  return api.createFeedbackTask;
}
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('missing local feedback task after genuine granted preset request', async () => {
  // A cooperative software port exercises the existing public browser profile and real runtime.
  // No navigator, device, physical effect, or native permission is exercised by this prefix.
  const patterns: (number | number[])[] = [];
  const backend = createBrowserHapticBackend({ vibrate(pattern) {
    patterns.push(Array.isArray(pattern) ? [...pattern] : pattern); return true;
  } });
  const profile = getHapticOutputProfile('app:browser-haptic-presets/1');
  const authority = { approved: false, checked: 0 };
  const sourceDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'feedback-prefix-source', label: 'Reviewed software request', revision: 1,
    adapter: { id: 'local:feedback-prefix', version: '1' }, runtime: { platform: 'software-fixture' },
    capabilities: [{ ...profile.capability, kind: 'event', permissions: ['subscribe'] }] });
  const runtime = createDeviceRuntime({ now: () => 1000, clockDomain: 'feedback-prefix', authorize(request) {
    authority.checked++;
    assert.equal(Object.isFrozen(request), true);
    assert.deepEqual({ principalId: request.principalId, applicationId: request.applicationId, sessionId: request.sessionId,
      sourceOperation: request.sourceOperation, sinkOperation: request.sinkOperation, partition: request.partition },
    { principalId: 'feedback-owner', applicationId: 'feedback-prefix', sessionId: 'local-reviewed', sourceOperation: 'subscribe', sinkOperation: 'invoke', partition: undefined });
    assert.deepEqual(request.source, { registrationId: source.id, deviceId: 'feedback-prefix-source', capabilityId: 'preset', descriptorRevision: 1, schemaVersion: 1 });
    assert.deepEqual(request.sink, { registrationId: output.endpoint.id, deviceId: 'feedback-prefix-output', capabilityId: 'preset', descriptorRevision: 1, schemaVersion: 1 });
    return authority.approved ? { expiresAt: 2000, maxAgeMs: 100, maxHz: 2 } : undefined;
  } });
  const output = createHapticOutputController({ runtime, deviceId: 'feedback-prefix-output', backend, now: () => 1000 });
  const source = runtime.registerSource({ device: sourceDevice, capability: 'preset' });
  const route = runtime.route({ from: source, to: output.endpoint, principalId: 'feedback-owner', applicationId: 'feedback-prefix',
    sessionId: 'local-reviewed', sourceOperation: 'subscribe', leaseMs: 1000, queueCapacity: 1 });
  try {
    assert.equal(runtime.setReadiness(source, 'available').ok, true); output.setAvailable(true);
    assert.equal(route.start().ok, false);
    runtime.publish(source, 'tap', { operationId: '1', deadline: 1100 }); runtime.flush();
    assert.deepEqual(patterns, []);
    authority.approved = true; assert.equal(route.start().ok, true);
    assert.equal(runtime.publish(source, 'tap', { operationId: '1', deadline: 1100 }).ok, true);
    runtime.flush(); await drain();
    assert.deepEqual(patterns, [[15]]);
    assert.equal(output.records()[0]?.outcome, 'api-returned');
    assert.equal(output.records()[0]?.effect, 'dispatched');
    assert.equal(output.records()[0]?.physical, 'unverified');
    assert.equal(route.operations()[0]?.handlerResult, 'returned');
    assert.equal(route.operations()[0]?.effectEvidence, 'dispatched');
    assert.equal(route.operations()[0]?.state, 'unverified');
    assert.ok(authority.checked >= 2, 'Denied and fresh approved authority must both be checked by the real runtime');
  } finally {
    route.stop('fixture-complete'); output.close(); runtime.unregister(source); runtime.close();
    assert.equal(typeof route.whenSettled, 'function'); await route.whenSettled?.();
  }
  assert.equal(route.status().state, 'closed'); assert.equal(route.status().pending, 0);
  assert.equal(runtime.setReadiness(source, 'available').ok, false);
  assert.equal(runtime.setReadiness(output.endpoint, 'available').ok, false);
  assert.deepEqual(patterns, [[15], 0], 'Only the request and one unverified software cancellation are issued');
  // Root selects this case for OLD. The desired module is first loaded after actual cleanup.
  await factory();
});

async function fixture(extra: Partial<FeedbackTaskOptions> = {}) {
  const create = await factory(), owner = new AbortController();
  const target = new EventTarget(), document = new EventTarget();
  const timers = new Map<number, { at: number; run: () => void }>();
  const calls: HapticPreset[] = [];
  const state: { at: number; next: number; factories: number; cancellations: number; hidden: boolean; focused: boolean;
    returned: HapticBackendOutcome | Promise<HapticBackendOutcome>; invoke?: () => void; cancel?: () => void; change?: () => void } =
    { at: 1000, next: 0, factories: 0, cancellations: 0, hidden: false, focused: true, returned: 'api-returned' };
  const task = create({ owner: owner.signal, now: () => state.at,
    createBackend() {
      state.factories++;
      return { profileId: 'app:browser-haptic-presets/1', supported: true,
        invoke(preset) { calls.push(preset); state.invoke?.(); return state.returned; },
        cancel() { state.cancellations++; state.cancel?.(); } } satisfies HapticBackend;
    },
    lifecycle: { target, document, hidden: () => state.hidden, focused: () => state.focused },
    setTimer(run, delay) { assert.equal(delay, 100); const id = ++state.next; timers.set(id, { at: state.at + delay, run }); return id; },
    clearTimer(id) { timers.delete(id as number); }, onChange() { state.change?.(); }, ...extra });
  function advance(at: number) {
    state.at = at;
    for (const [id, timer] of [...timers]) if (timer.at <= at && timers.delete(id)) timer.run();
  }
  return { task, owner, target, document, timers, calls, state, advance,
    hide() { state.hidden = true; document.dispatchEvent(new Event('visibilitychange')); },
    blur() { state.focused = false; target.dispatchEvent(new Event('blur')); },
    async close() { state.change = undefined; state.invoke = undefined; state.cancel = undefined;
      await task.close(); assert.equal(timers.size, 0); assert.equal(task.snapshot().rawPending, 0);
      assert.deepEqual(task.snapshot().owned, { runtimes: 0, sources: 0, sinks: 0, routes: 0, taskTimers: 0 }); }
  };
}
function approve(task: FeedbackTask, stage: 'source' | 'output') {
  const review = task.review(stage); assert.ok(review); assert.equal(review.stage, stage);
  assert.equal(task.approve(review), true); return review;
}
function ready(task: FeedbackTask) { approve(task, 'source'); approve(task, 'output'); }

test('arrival is inert and source subscribe and output invoke need separate fresh approvals', async () => {
  const f = await fixture();
  try {
    assert.equal(f.state.factories, 0); assert.equal(f.timers.size, 0); assert.deepEqual(f.calls, []);
    assert.deepEqual(f.task.snapshot().approvals, { source: false, output: false });
    assert.deepEqual(f.task.snapshot().presets, ['tap', 'impact', 'warning']);
    assert.equal(f.task.send('tap'), false);
    approve(f.task, 'source'); assert.equal(f.state.factories, 0); assert.equal(f.task.send('tap'), false);
    approve(f.task, 'output'); assert.equal(f.state.factories, 1); assert.deepEqual(f.calls, []);
    assert.equal(f.task.send('tap'), true); await drain();
    assert.deepEqual(f.calls, ['tap']);
    assert.deepEqual(f.task.snapshot().last, { preset: 'tap', outcome: 'api-returned', effect: 'dispatched', physical: 'unverified' });
    await f.task.stop(); assert.equal(f.task.snapshot().last, undefined);
    assert.deepEqual(f.task.snapshot().approvals, { source: false, output: false });
    assert.equal(f.task.send('tap'), false);
  } finally { await f.close(); }
});

test('copied foreign reused and expired review objects cannot approve a feedback route', async () => {
  const f = await fixture(), other = await fixture();
  try {
    const review = f.task.review('source'); assert.ok(review); assert.equal(Object.isFrozen(review), true);
    assert.equal(f.task.approve({ ...review }), false); assert.equal(other.task.approve(review), false);
    assert.equal(f.task.approve(review), true); assert.equal(f.task.approve(review), false);
    const output = f.task.review('output'); assert.ok(output);
    f.advance(6000); assert.equal(f.task.approve(output), false); assert.equal(f.state.factories, 0);
  } finally { await f.close(); await other.close(); }
});

test('a delayed second approval narrows the original thirty second run deadline', async () => {
  const f = await fixture();
  try {
    approve(f.task, 'source'); assert.equal(f.task.snapshot().deadline, 31000);
    f.advance(1100); approve(f.task, 'output');
    assert.equal(f.task.snapshot().deadline, 31000, 'Approval must not extend the original scope');
    assert.equal(f.task.send('warning'), true); await drain();
    f.advance(31000); assert.equal(f.task.send('tap'), false);
    assert.equal(f.task.snapshot().last, undefined); assert.deepEqual(f.task.snapshot().approvals, { source: false, output: false });
    await f.task.stop(); assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
});

test('only the closed profile presets are dispatched and rejected caller objects are not retained', async () => {
  const f = await fixture();
  try {
    ready(f.task);
    assert.equal(f.task.send({ privateValue: 'DO_NOT_RETAIN' } as unknown as HapticPreset), false);
    assert.equal(f.task.send('future-preset' as HapticPreset), false);
    assert.equal(JSON.stringify(f.task.snapshot()).includes('DO_NOT_RETAIN'), false);
    assert.equal(f.task.send('impact'), true); await drain(); assert.deepEqual(f.calls, ['impact']);
    assert.equal(f.task.snapshot().last?.physical, 'unverified');
  } finally { await f.close(); }
});

test('missing false and throwing browser ports cannot report a confirmed or successful physical effect', async () => {
  for (const kind of ['missing', 'false', 'throw'] as const) {
    const requests: (number | number[])[] = [];
    const f = await fixture({ createBackend: () => createBrowserHapticBackend(kind === 'missing' ? undefined : {
      vibrate(pattern) { requests.push(pattern); if (kind === 'throw') throw new Error('PRIVATE_PORT_ERROR'); return false; }
    }) });
    try {
      approve(f.task, 'source'); const output = f.task.review('output'); assert.ok(output);
      f.task.approve(output); f.task.send('tap'); await drain();
      assert.notEqual(f.task.snapshot().last?.outcome, 'api-returned');
      assert.ok(f.task.snapshot().last === undefined || f.task.snapshot().last?.physical === 'unverified');
      assert.equal(JSON.stringify(f.task.snapshot()).includes('PRIVATE_PORT_ERROR'), false);
      if (kind === 'missing') assert.deepEqual(requests, []);
      else assert.deepEqual(requests[0], [15]);
      await f.task.stop(); assert.equal(f.task.send('tap'), false);
    } finally { await f.close(); }
  }
});

test('logical timeout and Stop keep the actual returned backend Promise reserved until settlement', async () => {
  const f = await fixture(), held = gate<HapticBackendOutcome>();
  try {
    ready(f.task); f.state.returned = held.promise;
    assert.equal(f.task.send('tap'), true); assert.equal(f.task.snapshot().rawPending, 1);
    await wait(120); await drain();
    assert.equal(f.task.snapshot().rawPending, 1, 'The helper logical timeout is not raw backend settlement');
    assert.equal(f.task.send('impact'), false); assert.deepEqual(f.calls, ['tap']);
    const retired = { settled: false }; const stopped = f.task.stop(); stopped.then(() => { retired.settled = true; });
    assert.equal(f.task.stop(), stopped); assert.equal(f.task.snapshot().last, undefined);
    await drain(); assert.equal(retired.settled, false); assert.equal(f.task.snapshot().rawPending, 1);
    assert.equal(f.task.snapshot().owned.runtimes, 1); assert.equal(f.task.review('source'), undefined);
    held.resolve('api-returned'); await stopped;
    assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.task.snapshot().owned.runtimes, 0);
    assert.equal(f.task.snapshot().last, undefined); assert.equal(f.state.cancellations, 1);
    f.state.returned = 'api-returned'; ready(f.task); assert.equal(f.state.factories, 2);
  } finally { held.resolve('api-returned'); await held.promise; await f.close(); }
});

test('Stop reentry inside invoke reserves the not yet returned Promise and requests cancellation once', async () => {
  const f = await fixture(), held = gate<HapticBackendOutcome>();
  const observed: { first?: Promise<void>; second?: Promise<void>; settled: boolean } = { settled: false };
  try {
    ready(f.task); f.state.returned = held.promise;
    f.state.invoke = () => { observed.first = f.task.stop(); observed.second = f.task.stop(); };
    f.task.send('tap'); assert.ok(observed.first); assert.equal(observed.first, observed.second);
    observed.first.then(() => { observed.settled = true; });
    await drain(); assert.equal(observed.settled, false); assert.equal(f.task.snapshot().rawPending, 1);
    assert.equal(f.task.snapshot().owned.runtimes, 1); assert.equal(f.state.cancellations, 1);
    assert.equal(f.task.review('output'), undefined); assert.equal(f.task.send('warning'), false);
    held.resolve('api-returned'); await observed.first;
    assert.equal(f.task.snapshot().last, undefined); assert.equal(f.state.cancellations, 1);
  } finally { held.resolve('api-returned'); await held.promise; await f.close(); }
});

test('close publishes its stable barrier before observer and cancel reentry', async () => {
  const f = await fixture(), held = gate<HapticBackendOutcome>();
  const observed: { observer?: Promise<void>; cancellation?: Promise<void>; observing: boolean } = { observing: false };
  try {
    ready(f.task); f.state.returned = held.promise; assert.equal(f.task.send('tap'), true);
    f.state.change = () => { if (observed.observing) return; observed.observing = true; observed.observer = f.task.close(); };
    f.state.cancel = () => { observed.cancellation = f.task.close(); };
    const closed = f.task.close();
    assert.equal(f.task.close(), closed); assert.equal(observed.observer, closed); assert.equal(observed.cancellation, closed);
    assert.equal(f.task.snapshot().last, undefined); assert.equal(f.task.snapshot().rawPending, 1);
    assert.equal(f.task.review('source'), undefined);
    held.resolve('api-returned'); await closed; assert.equal(f.state.cancellations, 1);
  } finally { held.resolve('api-returned'); await held.promise; await f.close(); }
});

test('a failing output observer retires the active route and waits for raw work', async () => {
  const f = await fixture(), held = gate<HapticBackendOutcome>();
  try {
    ready(f.task); f.state.returned = held.promise;
    f.state.invoke = () => { f.state.change = () => { throw new Error('PRIVATE_OBSERVER_FAILURE'); }; };
    f.task.send('tap'); await drain();
    assert.deepEqual(f.task.snapshot().approvals, { source: false, output: false }); assert.equal(f.task.snapshot().last, undefined);
    assert.equal(f.task.snapshot().rawPending, 1); assert.equal(f.state.cancellations, 1);
    assert.equal(JSON.stringify(f.task.snapshot()).includes('PRIVATE_OBSERVER_FAILURE'), false);
    assert.equal(f.task.review('source'), undefined);
    held.resolve('api-returned'); await f.task.stop();
    assert.equal(f.task.snapshot().owned.runtimes, 0); assert.deepEqual(f.calls, ['tap']);
  } finally { held.resolve('api-returned'); await held.promise; await f.close(); }
});

test('cancellation failure quarantines fresh admission even after the raw return settles', async () => {
  const f = await fixture(), held = gate<HapticBackendOutcome>();
  try {
    ready(f.task); f.state.returned = held.promise;
    f.state.cancel = () => { throw new Error('PRIVATE_CANCELLATION_FAILURE'); };
    assert.equal(f.task.send('tap'), true); const stopped = f.task.stop();
    assert.equal(f.task.snapshot().cleanupUnconfirmed, true); assert.equal(f.task.snapshot().rawPending, 1);
    held.resolve('api-returned'); await stopped;
    assert.equal(f.task.review('source'), undefined); assert.equal(f.task.send('tap'), false);
    assert.equal(f.state.factories, 1); assert.equal(f.state.cancellations, 1);
    assert.equal(JSON.stringify(f.task.snapshot()).includes('PRIVATE_CANCELLATION_FAILURE'), false);
  } finally { held.resolve('api-returned'); await held.promise; await f.close(); }
});

test('an already aborted native owner cannot be revived by a shadowed aborted property', async () => {
  const owner = new AbortController(); owner.abort(); Object.defineProperty(owner.signal, 'aborted', { value: false });
  const f = await fixture({ owner: owner.signal });
  try { assert.equal(f.task.review('source'), undefined); assert.equal(f.task.send('tap'), false); assert.equal(f.state.factories, 0); }
  finally { await f.close(); }
});

test('native owner abort retires the task despite shadowed listener methods', async () => {
  const owner = new AbortController();
  Object.defineProperty(owner.signal, 'addEventListener', { value() { throw new Error('SHADOW_LISTENER'); } });
  Object.defineProperty(owner.signal, 'removeEventListener', { value() { throw new Error('SHADOW_UNLISTENER'); } });
  const f = await fixture({ owner: owner.signal }), held = gate<HapticBackendOutcome>();
  try {
    ready(f.task); f.state.returned = held.promise; assert.equal(f.task.send('tap'), true); owner.abort();
    assert.equal(f.task.snapshot().last, undefined); assert.equal(f.task.send('impact'), false);
    assert.equal(f.task.review('source'), undefined); assert.equal(f.state.cancellations, 1);
    held.resolve('api-returned'); await f.task.close(); assert.equal(f.task.snapshot().rawPending, 0);
  } finally { held.resolve('api-returned'); await held.promise; await f.close(); }
});

test('blur and hidden page retire active authority without automatically reacquiring it', async () => {
  for (const loss of ['blur', 'hide'] as const) {
    const f = await fixture();
    try {
      ready(f.task); assert.equal(f.task.send('tap'), true); await drain();
      f[loss](); await f.task.stop();
      assert.equal(f.task.snapshot().last, undefined); assert.equal(f.task.send('warning'), false);
      assert.deepEqual(f.task.snapshot().approvals, { source: false, output: false });
      f.state.focused = true; f.state.hidden = false; f.target.dispatchEvent(new Event('focus'));
      assert.equal(f.task.send('tap'), false); assert.equal(f.state.factories, 1);
    } finally { await f.close(); }
  }
});

test('backwards or throwing trusted clocks retire authority with fixed diagnostics', async () => {
  for (const kind of ['backwards', 'throw'] as const) {
    const clock = { at: 1000, broken: false };
    const f = await fixture({ now() { if (clock.broken && kind === 'throw') throw new Error('PRIVATE_CLOCK_FAILURE'); return clock.at; } });
    try {
      ready(f.task); clock.at = 999; clock.broken = true; assert.equal(f.task.send('tap'), false);
      await f.task.stop(); assert.deepEqual(f.calls, []); assert.equal(f.task.snapshot().owned.runtimes, 0);
      assert.equal(f.task.review('source'), undefined); assert.equal(JSON.stringify(f.task.snapshot()).includes('PRIVATE_CLOCK_FAILURE'), false);
    } finally { await f.close(); }
  }
});

test('command admission enforces two per second eight per run and one task timer', async () => {
  const f = await fixture();
  try {
    ready(f.task);
    for (let index = 0; index < 8; index++) {
      f.advance(1000 + index * 500); assert.equal(f.timers.size, 1);
      assert.equal(f.task.send('tap'), true); await drain();
      f.advance(1001 + index * 500); assert.equal(f.task.send('impact'), false);
      assert.ok(f.task.snapshot().owned.routes <= 1); assert.ok(f.task.snapshot().owned.sinks <= 1);
    }
    f.advance(5000); assert.equal(f.task.send('warning'), false); assert.equal(f.calls.length, 8);
    assert.equal(f.task.snapshot().commands, 8); assert.equal(f.timers.size, 1);
  } finally { await f.close(); }
});

test('four runs and sixty four actions are lifetime bounds and mandatory Stop remains available', async () => {
  const runs = await fixture();
  try {
    for (let index = 0; index < 4; index++) { ready(runs.task); await runs.task.stop(); }
    assert.equal(runs.task.review('source'), undefined); assert.equal(runs.state.factories, 4);
    assert.equal(runs.task.snapshot().runs, 4);
  } finally { await runs.close(); }
  const actions = await fixture();
  try {
    for (let index = 0; index < 64; index++) assert.equal(actions.task.send('tap'), false);
    assert.equal(actions.task.review('source'), undefined); assert.equal(actions.state.factories, 0);
    assert.equal(actions.task.snapshot().actions, 64); await actions.task.stop();
  } finally { await actions.close(); }
});


test('clock callback cannot overwrite an actually approved feedback run', async () => {
  const entry: { task?: FeedbackTask; reentered: boolean; factories: number } = { reentered: false, factories: 0 };
  const patterns: (number | number[])[] = [], issued: HapticBackend[] = [];
  const f = await fixture({ now() {
    if (entry.task && !entry.reentered) {
      entry.reentered = true; ready(entry.task); assert.equal(entry.task.send('tap'), true);
    }
    return 1000;
  }, createBackend() {
    entry.factories++;
    const backend = createBrowserHapticBackend({ vibrate(pattern) { patterns.push(Array.isArray(pattern) ? [...pattern] : pattern); return true; } });
    issued.push(backend); return backend;
  } });
  entry.task = f.task;
  try {
    f.task.review('source'); await drain();
    assert.equal(entry.factories, 1); assert.deepEqual(patterns, [[15]], 'Actual granted public preset prefix must dispatch');
    await f.task.stop();
    assert.deepEqual([...patterns], [[15], 0], 'Stop must retain and retire the actual inner issued output');
    assert.equal(f.timers.size, 0); assert.equal(f.task.snapshot().owned.runtimes, 0);
  } finally {
    await f.task.close();
    // OLD can orphan the cooperative port/timer. The fixture still owns these
    // software resources and explicitly retires them after the desired assertion.
    for (const backend of issued) backend.cancel?.();
    f.timers.clear();
  }
});

test('returned cancellation Promise rejection quarantines a real issued feedback route', async () => {
  const invocation = gate<HapticBackendOutcome>(), port = { factories: 0, calls: 0, cancellations: 0 };
  const rejected = Promise.reject<void>(new Error('PRIVATE_ASYNC_CANCELLATION'));
  void rejected.catch(() => {}); // Fixture owns the exact rejected return in OLD as well.
  const f = await fixture({ createBackend() {
    port.factories++;
    return { profileId: 'app:browser-haptic-presets/1', supported: true,
      invoke() { port.calls++; return invocation.promise; },
      cancel() { port.cancellations++; return rejected; } } satisfies HapticBackend;
  } });
  try {
    ready(f.task); assert.equal(f.task.send('tap'), true); assert.equal(port.calls, 1);
    const stopped = f.task.stop(); await drain(); assert.equal(port.cancellations, 1);
    assert.equal(f.task.snapshot().cleanupUnconfirmed, true, 'A deferred cancel is outside the synchronous port contract');
    invocation.resolve('api-returned'); await stopped;
    assert.equal(f.task.review('source'), undefined); assert.equal(port.factories, 1);
    assert.equal(JSON.stringify(f.task.snapshot()).includes('PRIVATE_ASYNC_CANCELLATION'), false);
  } finally { invocation.resolve('api-returned'); await invocation.promise; await rejected.catch(() => {}); await f.close(); }
});

test('held cancellation Promise remains owned until its actual return settles', async () => {
  const cancellation = gate<void>(), port = { calls: 0, cancellations: 0 }, status = { settled: false };
  const f = await fixture({ createBackend: () => ({ profileId: 'app:browser-haptic-presets/1', supported: true,
    invoke() { port.calls++; return 'api-returned'; }, cancel() { port.cancellations++; return cancellation.promise; } } satisfies HapticBackend) });
  try {
    ready(f.task); assert.equal(f.task.send('tap'), true); await drain(); assert.equal(port.calls, 1);
    const stopped = f.task.stop(); stopped.then(() => { status.settled = true; }); await drain(); assert.equal(port.cancellations, 1);
    assert.equal(status.settled, false, 'Logical route stop is not actual cancellation settlement');
    assert.equal(f.task.snapshot().cleanupUnconfirmed, true); assert.equal(f.task.snapshot().rawPending, 1);
    assert.equal(f.task.review('source'), undefined);
    cancellation.resolve(); await stopped; assert.equal(f.task.snapshot().rawPending, 0);
    assert.equal(f.task.review('source'), undefined);
  } finally { cancellation.resolve(); await cancellation.promise; await f.close(); }
});

test('Stop inside the initial clock callback retires the pending review admission', async () => {
  const entry: { task?: FeedbackTask; reentered: boolean } = { reentered: false };
  const f = await fixture({ now() { if (entry.task && !entry.reentered) { entry.reentered = true; void entry.task.stop(); } return 1000; } });
  entry.task = f.task;
  try {
    assert.equal(f.task.review('source'), undefined); await f.task.stop();
    assert.equal(f.state.factories, 0); assert.equal(f.timers.size, 0); assert.equal(f.task.snapshot().owned.runtimes, 0);
  } finally { await f.close(); }
});


test('pending backend request never projects the helper placeholder as a cancellation result', async () => {
  const held = gate<HapticBackendOutcome>(), f = await fixture();
  try {
    ready(f.task); f.state.returned = held.promise;
    assert.equal(f.task.send('tap'), true); assert.deepEqual(f.calls, ['tap']);
    f.advance(1100);
    assert.equal(f.task.snapshot().phase, 'pending'); assert.equal(f.task.snapshot().rawPending, 1);
    assert.equal(f.task.snapshot().last, undefined, 'A retained helper placeholder is not a finished operation');
  } finally { held.resolve('api-returned'); await held.promise; await f.close(); }
});

test('a newly admitted request clears the preceding preset result immediately', async () => {
  const held = gate<HapticBackendOutcome>(), f = await fixture();
  try {
    ready(f.task); assert.equal(f.task.send('tap'), true); await drain();
    assert.equal(f.task.snapshot().last?.outcome, 'api-returned');
    f.advance(1500); f.state.returned = held.promise;
    assert.equal(f.task.send('warning'), true); assert.deepEqual(f.calls, ['tap', 'warning']);
    assert.equal(f.task.snapshot().rawPending, 1);
    assert.equal(f.task.snapshot().last, undefined, 'The previous request result cannot label the new pending request');
  } finally { held.resolve('api-returned'); await held.promise; await f.close(); }
});
