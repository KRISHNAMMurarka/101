import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserMicrophoneProvider } from '@101/connect';
import type { BrowserMicrophoneEnvironment, BrowserMicrophoneOptions } from '@101/connect';
import { createBrowserMicrophonePipeline } from '../../../examples/browser-resources/microphone.ts';
import type { MicrophoneTask, MicrophoneTaskOptions } from './microphone-task.ts';

const target = new URL('./microphone-task.ts', import.meta.url);
async function loadTask() {
  try { return await import('./microphone-task.ts'); }
  catch (error) {
    // Only this exact absent leaf is the feature RED. Dependency/syntax failures propagate.
    if (error instanceof Error && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ERR_MODULE_NOT_FOUND' &&
      Object.getOwnPropertyDescriptor(error, 'url')?.value === target.href) return undefined;
    throw error;
  }
}
async function factory() {
  const api = await loadTask();
  assert.equal(typeof api?.createMicrophoneTask, 'function', 'Missing selected microphone player task');
  assert.ok(api);
  return api.createMicrophoneTask;
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const wait = (milliseconds = 65) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
class Track extends EventTarget {
  kind = 'audio'; readyState = 'live'; muted = false; stops = 0;
  stop() { this.stops++; this.readyState = 'ended'; }
  getSettings() { return { deviceId: 'software-input-id' }; }
}
class Stream {
  readonly track = new Track();
  getTracks() { return [this.track]; }
}
class Context extends EventTarget {
  state = 'running'; sampleRate = 48000; currentTime = 0.125; level = 0.25;
  reads = 0; closes = 0; disconnects = 0;
  resumeGate?: Promise<void>; closeGate?: Promise<void>; onClose?: () => void;
  createMediaStreamSource() { return { connect() {}, disconnect: () => { this.disconnects++; } }; }
  createAnalyser() { return { fftSize: 256,
    getFloatTimeDomainData: (samples: Float32Array) => { this.reads++; samples.fill(this.level); },
    disconnect: () => { this.disconnects++; } }; }
  resume() { return this.resumeGate ?? Promise.resolve(); }
  close() { this.closes++; this.state = 'closed'; this.onClose?.(); return this.closeGate ?? Promise.resolve(); }
}
function nativeFixture() {
  const target = new EventTarget(), document = new EventTarget(), mediaDevicesTarget = new EventTarget();
  const streams: Stream[] = [], contexts: Context[] = [];
  let inspections = 0, opens = 0, hidden = false, focused = true;
  let devices: readonly { kind: MediaDeviceKind; deviceId: string }[] = [{ kind: 'audioinput', deviceId: 'software-input-id' }];
  let enumerationGate: Promise<readonly { kind: MediaDeviceKind; deviceId: string }[]> | undefined;
  let openGate: Promise<MediaStream> | undefined, rejection: unknown, contextSetup: ((context: Context) => void) | undefined;
  const environment: BrowserMicrophoneEnvironment = { fixtureKind: 'software-fixture',
    enumerateDevices() { inspections++; return enumerationGate ?? Promise.resolve(devices); },
    getUserMedia(constraints) {
      opens++; assert.deepEqual(constraints, { audio: { deviceId: { exact: 'software-input-id' } }, video: false });
      if (rejection) return Promise.reject(rejection);
      if (openGate) return openGate;
      const stream = new Stream(); streams.push(stream); return Promise.resolve(stream as unknown as MediaStream);
    },
    createAudioContext() { const context = new Context(); contexts.push(context); contextSetup?.(context); return context as unknown as AudioContext; },
    MediaStream: Stream as unknown as typeof MediaStream, AudioContext: Context as unknown as typeof AudioContext,
    target, document, mediaDevicesTarget, hidden: () => hidden, focused: () => focused, secureContext: () => true };
  return { environment, streams, contexts, target, document, mediaDevicesTarget,
    inspections: () => inspections, opens: () => opens,
    setDevices(value: typeof devices) { devices = value; }, holdEnumeration(value: typeof enumerationGate) { enumerationGate = value; },
    holdOpen(value: typeof openGate) { openGate = value; }, rejectOpen(value: unknown) { rejection = value; },
    setupContext(value: typeof contextSetup) { contextSetup = value; },
    hide() { hidden = true; document.dispatchEvent(new Event('visibilitychange')); },
    blur() { focused = false; target.dispatchEvent(new Event('blur')); } };
}

test('missing selected microphone player task after genuine typed envelope', async () => {
  // Existing public producer, frozen exact grants and real runtime route form the OLD prefix.
  // This documented cooperative fixture is software only, not microphone/permission evidence.
  const native = nativeFixture(), owner = new AbortController(), capture = new AbortController();
  let at = 1000, captureApprovals = 0, routeApprovals = 0;
  const pipeline = createBrowserMicrophonePipeline({ ownerSignal: owner.signal, now: () => at, environment: native.environment,
    authorizeCapture(request) {
      captureApprovals++; assert.ok(Object.isFrozen(request)); assert.equal(request.capabilityId, 'envelope');
      assert.equal(request.operation, 'subscribe'); assert.equal(request.nativeDeviceId, 'software-input-id');
      return { request, signal: capture.signal, expiresAt: 2000 };
    },
    authorizeRoutes(request) {
      routeApprovals++; assert.equal(request.principalId, 'microphone-owner');
      assert.equal(request.applicationId, 'microphone-example'); assert.equal(request.sessionId, 'microphone-session');
      assert.equal(request.source.capabilityId, 'envelope'); assert.equal(request.sink.capabilityId, 'envelope');
      assert.equal(request.sourceOperation, 'subscribe'); assert.equal(request.sinkOperation, 'write');
      return { expiresAt: 2000, maxAgeMs: 250, maxHz: 20 };
    } });
  try {
    assert.equal(native.inspections(), 0); assert.equal(native.opens(), 0);
    const inspected = await pipeline.provider.inspect(); assert.ok(inspected.ok); assert.equal(inspected.value.length, 1);
    assert.equal(native.opens(), 0);
    const active = await pipeline.activate(inspected.value[0]!.selection, 'reviewed-local-levels'); assert.ok(active.ok);
    at = 1050; await wait(); pipeline.tick();
    assert.deepEqual(pipeline.state().latest?.value, { rms: 0.25, peak: 0.25, sampleCount: 256, sampleRateHz: 48000 });
    assert.equal(pipeline.state().latest?.quality, 'valid'); assert.equal(pipeline.state().latest?.timestamp, 1050);
    assert.equal(captureApprovals, 1); assert.ok(routeApprovals >= 1); assert.equal(native.opens(), 1);
    capture.abort(); assert.equal(pipeline.state().latest, undefined); assert.ok(pipeline.state().released >= 1);
  } finally { owner.abort(); await pipeline.close(); }
  const final = pipeline.provider.snapshot();
  assert.equal(final.activeSources, 0); assert.equal(final.rawPending, 0); assert.equal(final.cleanupPending, 0);
  assert.equal(final.listeners, 0); assert.equal(final.pollArmed, false); assert.equal(final.expiryArmed, false);
  assert.equal(final.cleanupFailures, 0); assert.ok(native.streams.every(stream => stream.track.readyState === 'ended'));
  assert.ok(native.contexts.every(context => context.state === 'closed' && context.closes === 1));
  // Root selects only this test for OLD; no desired implementation is loaded before the prefix.
  await factory();
});

async function fixture(extra: Partial<MicrophoneTaskOptions> = {}) {
  const create = await factory(), native = nativeFixture(), owner = new AbortController();
  const providers: ReturnType<typeof createBrowserMicrophoneProvider>[] = [];
  const timers = new Map<number, { at: number; run: () => void }>();
  let at = 1000, next = 0, changes = 0, change: (() => void) | undefined;
  const task = create({ owner: owner.signal, now: () => at, environment: native.environment,
    createProvider(options: BrowserMicrophoneOptions) { const value = createBrowserMicrophoneProvider(options); providers.push(value); return value; },
    setTimer(run, delay) { assert.equal(delay, 100); const id = ++next; timers.set(id, { at: at + delay, run }); return id; },
    clearTimer(id) { timers.delete(id as number); }, onChange() { changes++; change?.(); }, ...extra });
  const advance = (value: number) => {
    at = value;
    for (const [id, timer] of [...timers]) if (timer.at <= at && timers.delete(id)) timer.run();
  };
  return { task, native, owner, providers, timers, now: () => at, changes: () => changes,
    setAt(value: number) { at = value; }, advance, onChange(value: typeof change) { change = value; },
    async poll() { at += 100; await wait(); advance(at); },
    async close() { await task.close(); assert.equal(timers.size, 0);
      for (const provider of providers) { const end = provider.snapshot(); assert.equal(end.rawPending, 0); assert.equal(end.cleanupPending, 0);
        assert.equal(end.activeSources, 0); assert.equal(end.listeners, 0); assert.equal(end.pollArmed, false); assert.equal(end.expiryArmed, false); }
    } };
}
async function selected(task: MicrophoneTask) {
  assert.equal(await task.findInputs(), true); assert.equal(task.snapshot().choices.length, 1);
  assert.equal(task.select(1), true);
}
async function approve(task: MicrophoneTask, stage: 'capture' | 'source' | 'display') {
  const review = task.review(stage); assert.ok(review); assert.equal(review.stage, stage);
  assert.equal(await task.approve(review), true); return review;
}
async function active(task: MicrophoneTask) { await selected(task); await approve(task, 'capture'); await approve(task, 'source'); await approve(task, 'display'); }

test('task construction and absent native IDs stay inert without default capture bootstrap', async () => {
  const f = await fixture();
  try {
    assert.equal(f.providers.length, 0); assert.equal(f.native.inspections(), 0); assert.equal(f.native.opens(), 0); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.task.snapshot().approvals, { capture: false, source: false, display: false });
    f.native.setDevices([{ kind: 'audioinput', deviceId: '' }, { kind: 'audioinput', deviceId: 'default' }, { kind: 'audioinput', deviceId: 'communications' }]);
    assert.equal(await f.task.findInputs(), true); assert.equal(f.task.snapshot().choices.length, 0);
    assert.equal(f.task.snapshot().phase, 'no-inputs'); assert.equal(f.native.opens(), 0);
    assert.equal(f.task.review('capture'), undefined); assert.equal(f.task.select(1), false);
  } finally { await f.close(); }
});

test('capture, source subscribe and display write are three distinct fresh decisions', async () => {
  const f = await fixture();
  try {
    await selected(f.task); assert.equal(f.native.opens(), 0);
    assert.equal(f.task.review('source'), undefined); assert.equal(f.task.review('display'), undefined);
    await approve(f.task, 'capture'); assert.equal(f.native.opens(), 1);
    assert.deepEqual(f.task.snapshot().approvals, { capture: true, source: false, display: false });
    await f.poll(); assert.equal(f.task.snapshot().latest, undefined); assert.equal(f.task.snapshot().owned.routes, 0);
    await approve(f.task, 'source'); await f.poll(); assert.equal(f.task.snapshot().latest, undefined);
    assert.equal(f.task.snapshot().owned.routes, 0); await approve(f.task, 'display'); await f.poll();
    assert.equal(f.task.snapshot().phase, 'active'); assert.equal(f.task.snapshot().owned.routes, 1); assert.equal(f.task.snapshot().owned.sinks, 1);
    assert.deepEqual(f.task.snapshot().latest?.rows, [['0.25', '0.25', '256', '48000']]);
    const previous = f.task.snapshot().latest; assert.ok(previous); assert.ok(Object.isFrozen(previous.rows[0]));
    f.native.contexts[0]!.level = 0; await f.poll();
    assert.deepEqual(f.task.snapshot().latest?.rows, [['0', '0', '256', '48000']]);
    assert.deepEqual(previous.rows, [['0.25', '0.25', '256', '48000']]);
    assert.equal(JSON.stringify(f.task.snapshot()).includes('software-input-id'), false);
    assert.equal(JSON.stringify(f.task.snapshot()).includes('media:microphone-envelope'), false);
  } finally { await f.close(); }
});

test('forged, foreign, copied, reused and expired reviews cannot supply consent', async () => {
  const f = await fixture(), other = await fixture();
  try {
    await selected(f.task); await selected(other.task);
    const reviewed = f.task.review('capture'), foreign = other.task.review('capture'); assert.ok(reviewed); assert.ok(foreign);
    assert.equal(await f.task.approve(foreign), false);
    assert.equal(await f.task.approve({ ...reviewed }), false);
    assert.equal(await f.task.approve(Object.freeze({}) as typeof reviewed), false); assert.equal(f.native.opens(), 0);
    f.setAt(reviewed.expiresAt); assert.equal(await f.task.approve(reviewed), false); assert.equal(f.native.opens(), 0);
    await f.task.stop(); await selected(f.task); const fresh = await approve(f.task, 'capture');
    assert.equal(await f.task.approve(fresh), false); assert.equal(f.native.opens(), 1);
  } finally { await f.close(); await other.close(); }
});

test('source and display reviews cannot renew the original 30-second capture deadline', async () => {
  const f = await fixture();
  try {
    await selected(f.task); await approve(f.task, 'capture'); const deadline = f.task.snapshot().deadline;
    assert.equal(deadline, 31000); f.setAt(2000); await approve(f.task, 'source'); f.setAt(3000); await approve(f.task, 'display');
    assert.equal(f.task.snapshot().deadline, deadline); f.advance(31000);
    assert.equal(f.task.snapshot().latest, undefined); assert.equal(f.task.snapshot().approvals.capture, false);
    assert.equal(f.task.snapshot().reason, 'expired'); await f.task.stop();
    assert.equal(f.task.snapshot().owned.routes, 0); assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
});

test('delayed native inspection and capture approval clip to the original inventory request deadline', async () => {
  const f = await fixture(), enumeration = gate<readonly { kind: MediaDeviceKind; deviceId: string }[]>();
  try {
    f.native.holdEnumeration(enumeration.promise); const finding = f.task.findInputs(); await Promise.resolve();
    assert.equal(f.native.inspections(), 1); f.setAt(1100);
    enumeration.resolve([{ kind: 'audioinput', deviceId: 'software-input-id' }]); assert.equal(await finding, true);
    assert.equal(f.task.select(1), true); f.setAt(1200); const review = f.task.review('capture'); assert.ok(review);
    f.setAt(1300); assert.equal(await f.task.approve(review), true, 'A delayed valid approval must fit the actual issued selection lifetime');
    assert.equal(f.native.opens(), 1); assert.equal(f.task.snapshot().deadline, 31000, 'Pin from 1000 before native inspection; do not use 1100 or 1300 plus 30 seconds');
    f.setAt(1400); await approve(f.task, 'source'); f.setAt(1500); await approve(f.task, 'display');
    assert.equal(f.task.snapshot().deadline, 31000); await f.poll(); assert.ok(f.task.snapshot().latest);
  } finally { enumeration.resolve([]); await f.close(); }
});

test('Stop retires display immediately and fresh input selection requires all three approvals again', async () => {
  const f = await fixture();
  try {
    await active(f.task); await f.poll(); assert.ok(f.task.snapshot().latest);
    const stopped = f.task.stop(); assert.equal(f.task.snapshot().latest, undefined);
    assert.deepEqual(f.task.snapshot().approvals, { capture: false, source: false, display: false });
    await stopped; assert.equal(f.task.select(1), false); assert.equal(f.task.review('display'), undefined);
    await selected(f.task); assert.equal(f.native.opens(), 1); await approve(f.task, 'capture'); assert.equal(f.native.opens(), 2);
    assert.equal(f.task.snapshot().latest, undefined); assert.equal(f.task.snapshot().owned.routes, 0);
  } finally { await f.close(); }
});

test('actual held open remains reserved through Stop and late returned tracks are retired before retry', async () => {
  const f = await fixture(), raw = gate<MediaStream>(), late = new Stream();
  try {
    await selected(f.task); f.native.holdOpen(raw.promise); const review = f.task.review('capture'); assert.ok(review);
    const approving = f.task.approve(review); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.native.opens(), 1); const stopping = f.task.stop();
    assert.equal(f.task.stop(), stopping); assert.equal(f.task.snapshot().latest, undefined); assert.equal(f.task.snapshot().rawPending, 1);
    assert.equal(f.task.snapshot().owned.runtimes, 1); assert.equal(f.task.snapshot().owned.providers, 1);
    assert.equal(await f.task.findInputs(), false); assert.equal(await approving, false);
    let settled = false; void stopping.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
    raw.resolve(late as unknown as MediaStream); await stopping; assert.equal(late.track.readyState, 'ended'); assert.ok(late.track.stops >= 1);
    assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.task.snapshot().owned.runtimes, 0);
    f.native.holdOpen(undefined); await selected(f.task); assert.equal(f.task.snapshot().latest, undefined);
  } finally { raw.resolve(late as unknown as MediaStream); await f.close(); }
});

test('native close and onChange reentry observe the same prepublished Stop and close barriers', async () => {
  const f = await fixture(), raw = gate<void>(); let reenteredStop: Promise<void> | undefined, reenteredClose: Promise<void> | undefined;
  try {
    f.native.setupContext(context => { context.closeGate = raw.promise; context.onClose = () => { reenteredStop = f.task.stop(); }; });
    await active(f.task); await f.poll();
    const stopping = f.task.stop(); assert.equal(reenteredStop, stopping); assert.equal(f.task.stop(), stopping);
    assert.equal(f.task.snapshot().owned.runtimes, 1); assert.equal(f.task.snapshot().latest, undefined); assert.equal(await f.task.findInputs(), false);
    f.onChange(() => { if (f.task.snapshot().phase === 'closed') reenteredClose = f.task.close(); });
    const closing = f.task.close(); assert.equal(f.task.close(), closing); assert.equal(reenteredClose, closing);
    raw.resolve(); await closing; assert.equal(f.native.contexts[0]!.closes, 1); assert.equal(f.task.snapshot().owned.runtimes, 0);
  } finally { raw.resolve(); await f.close(); }
});

test('issued inspection settlement is owned after logical cancellation and close cannot free it early', async () => {
  const f = await fixture(), raw = gate<readonly { kind: MediaDeviceKind; deviceId: string }[]>();
  try {
    f.native.holdEnumeration(raw.promise); const finding = f.task.findInputs(); await Promise.resolve();
    assert.equal(f.native.inspections(), 1); const stopping = f.task.stop(); assert.equal(await finding, false);
    assert.equal(f.task.snapshot().rawPending, 1); assert.equal(await f.task.findInputs(), false); const closing = f.task.close();
    let settled = false; void closing.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
    raw.resolve([{ kind: 'audioinput', deviceId: 'software-input-id' }]); await stopping; await closing;
    assert.equal(f.task.snapshot().choices.length, 0); assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.native.opens(), 0);
  } finally { raw.resolve([]); await f.close(); }
});

for (const cause of ['hide', 'blur', 'devicechange', 'ended', 'mute'] as const) test(`${cause} clears approved readings without automatic acquisition`, async () => {
  const f = await fixture();
  try {
    await active(f.task); await f.poll(); assert.ok(f.task.snapshot().latest);
    if (cause === 'hide') f.native.hide(); else if (cause === 'blur') f.native.blur();
    else if (cause === 'devicechange') f.native.mediaDevicesTarget.dispatchEvent(new Event('devicechange'));
    else f.native.streams[0]!.track.dispatchEvent(new Event(cause));
    f.advance(f.now() + 100); assert.equal(f.task.snapshot().latest, undefined);
    await f.task.stop(); assert.equal(f.native.opens(), 1); assert.equal(f.task.snapshot().owned.routes, 0);
  } finally { await f.close(); }
});

test('denied native open returns a fixed recoverable state and retry obtains fresh choices', async () => {
  const f = await fixture();
  try {
    await selected(f.task); f.native.rejectOpen(new DOMException('PRIVATE_NATIVE_DETAIL', 'NotAllowedError'));
    const review = f.task.review('capture'); assert.ok(review); assert.equal(await f.task.approve(review), false);
    assert.equal(f.task.snapshot().reason, 'denied'); assert.equal(f.task.snapshot().latest, undefined); await f.task.stop();
    assert.equal(JSON.stringify(f.task.snapshot()).includes('PRIVATE_NATIVE_DETAIL'), false); assert.equal(f.native.opens(), 1);
    f.native.rejectOpen(undefined); await selected(f.task); await approve(f.task, 'capture'); assert.equal(f.native.opens(), 2);
  } finally { await f.close(); }
});

test('intrinsic owner abort rejects shadowed already-aborted signals before creating any provider', async () => {
  const owner = new AbortController(); owner.abort();
  Object.defineProperty(owner.signal, 'aborted', { value: false });
  Object.defineProperty(owner.signal, 'addEventListener', { value() { throw Error('shadow listener executed'); } });
  const f = await fixture({ owner: owner.signal });
  try { assert.equal(await f.task.findInputs(), false); assert.equal(f.providers.length, 0); assert.equal(f.native.inspections(), 0); assert.equal(f.native.opens(), 0); }
  finally { await f.close(); }
});

test('backwards or throwing clocks retire the selected attempt without native acquisition', async () => {
  const f = await fixture();
  try { await selected(f.task); f.setAt(999); assert.equal(f.task.review('capture'), undefined); await f.task.stop(); assert.equal(f.native.opens(), 0); }
  finally { await f.close(); }
  let throws = false; const g = await fixture({ now() { if (throws) throw Error('PRIVATE_CLOCK_DETAIL'); return 1000; } });
  try { await selected(g.task); throws = true; assert.equal(g.task.review('capture'), undefined); await g.task.stop();
    assert.equal(g.native.opens(), 0); assert.equal(JSON.stringify(g.task.snapshot()).includes('PRIVATE_CLOCK_DETAIL'), false); }
  finally { await g.close(); }
});

test('four attempts, 64 actions and one bounded task timer cannot be reset through retry', async () => {
  const f = await fixture();
  try {
    for (let attempt = 1; attempt <= 4; attempt++) { await selected(f.task); assert.equal(f.task.snapshot().attempts, attempt); await f.task.stop(); }
    assert.equal(await f.task.findInputs(), false); assert.equal(f.providers.length, 4); assert.equal(f.task.snapshot().reason, 'quota');
    assert.equal(f.native.opens(), 0); assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
  const g = await fixture();
  try { for (let action = 0; action < 64; action++) assert.equal(g.task.review('display'), undefined);
    assert.equal(await g.task.findInputs(), false); assert.equal(g.task.snapshot().actions, 64); assert.equal(g.providers.length, 0); }
  finally { await g.close(); }
  const h = await fixture();
  try {
    await selected(h.task); const review = h.task.review('capture'); assert.ok(review);
    for (let tick = 1; tick <= 50; tick++) { h.advance(1000 + tick * 100); assert.ok(h.timers.size <= 1); }
    assert.equal(h.task.snapshot().reason, 'expired'); assert.equal(h.timers.size, 0); assert.ok(h.task.snapshot().callbacks <= 360);
    assert.equal(h.native.opens(), 0); assert.equal(await h.task.approve(review), false);
  } finally { await h.close(); }
});

test('microphone cleanup refusal remains quarantined after the actual provider close settles', async () => {
  const f = await fixture();
  try {
    await active(f.task); await f.poll(); assert.ok(f.task.snapshot().latest);
    assert.equal(f.native.opens(), 1); const context = f.native.contexts[0]!;
    context.close = () => { context.closes++; return Promise.reject(new Error('native cleanup declined')); };
    await f.task.stop();
    assert.equal(f.providers[0]!.snapshot().rawPending, 0); assert.ok(f.providers[0]!.snapshot().cleanupFailures > 0);
    assert.equal(f.task.snapshot().latest, undefined);
    assert.equal(f.task.snapshot().cleanupUnconfirmed, true, 'Actual cleanup failure must quarantine this page');
    assert.equal(await f.task.findInputs(), false); assert.equal(f.native.opens(), 1);
  } finally { await f.close(); }
});

test('a reentrant initial microphone clock cannot replace an already issued actual provider', async () => {
  const holder: { value?: Awaited<ReturnType<typeof fixture>> } = {};
  let entered = false, nested: Promise<boolean> | undefined;
  const f = await fixture({ now() {
    if (holder.value && !entered) { entered = true; nested = holder.value.task.findInputs(); }
    return 1000;
  } }); holder.value = f;
  try {
    await f.task.findInputs(); await nested;
    assert.equal(f.native.opens(), 0); assert.ok(f.providers.every(provider => provider.snapshot().rawPending === 0));
    assert.equal(f.native.inspections(), 1, 'Only the actual current provider may inspect after clock reentry');
    assert.equal(f.providers.length, 1);
    await f.task.close(); assert.ok(f.providers.every(provider => provider.snapshot().listeners === 0));
  } finally {
    await f.task.close(); for (const provider of f.providers) await provider.close();
    f.owner.abort(); assert.equal(f.timers.size, 0);
  }
});
