import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserApplicationAudio, createDeviceRuntime } from '@101/connect';
import type { BrowserApplicationAudioEnvironment } from '@101/connect';
import type { AudioOutputPort, AudioTone } from './audio-task.ts';

const api = await import('./audio-task.ts').catch((error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
  throw error;
});
class Track extends EventTarget {
  kind = 'audio'; readyState = 'live'; muted = false; stopped = 0; clones: Track[] = [];
  getSettings() { return {}; } // Actual browser producers may omit emitted PCM settings.
  clone() { const track = new Track(); this.clones.push(track); return track; }
  stop() { this.stopped++; this.readyState = 'ended'; }
}
class Stream { readonly tracks: Track[]; constructor(tracks: Track[] = [new Track()]) { this.tracks = tracks; } getTracks() { return this.tracks; } getAudioTracks() { return this.tracks; } }
class Node {
  connections = new Set<Node>(); disconnects = 0;
  connect(node: Node) { this.connections.add(node); return node; }
  disconnect(node?: Node) { this.disconnects++; if (node) this.connections.delete(node); else this.connections.clear(); }
}
class Destination extends Node { channelCount = 2; readonly stream = new Stream(); readonly context: Context; constructor(context: Context) { super(); this.context = context; } }
class Context extends EventTarget {
  state = 'running'; sampleRate = 48000; currentTime = 0.125; resumes = 0; closes = 0;
  destination = new Node(); source = new Node(); gains: (Node & { gain: { value: number } })[] = []; outputs: Destination[] = [];
  resumeGate?: Promise<void>; closeGate?: Promise<void>; beforeGain?: () => void;
  createMediaStreamSource() { return this.source; }
  createAnalyser() { return Object.assign(new Node(), { fftSize: 256, getFloatTimeDomainData(samples: Float32Array) { samples.fill(0.05); } }); }
  createGain() { const gain = Object.assign(new Node(), { gain: { value: 1 } }); this.gains.push(gain); this.beforeGain?.(); return gain; }
  createMediaStreamDestination() { const node = new Destination(this); this.outputs.push(node); return node; }
  resume() { this.resumes++; return this.resumeGate ?? Promise.resolve(); }
  close() { this.closes++; this.state = 'closed'; return this.closeGate ?? Promise.resolve(); }
}
function gate<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function realm(context: Context, target = new EventTarget(), document = new EventTarget()): BrowserApplicationAudioEnvironment {
  return { fixtureKind: 'software-fixture', createAudioContext: () => context as unknown as AudioContext,
    createMediaStream: tracks => new Stream(tracks as unknown as Track[]) as unknown as MediaStream,
    AudioContext: Context as unknown as typeof AudioContext, MediaStream: Stream as unknown as typeof MediaStream,
    MediaStreamTrack: Track as unknown as typeof MediaStreamTrack, MediaStreamAudioDestinationNode: Destination as unknown as typeof MediaStreamAudioDestinationNode,
    target, document, hidden: () => false, focused: () => true };
}

test('existing public application-audio provider executes before asserting the missing local audio player task', async () => {
  const routing = new Context(), producer = new Context(), node = new Destination(producer), owner = new AbortController(), grant = new AbortController();
  let routes = 0, sourceDecisions = 0, outputDecisions = 0;
  const runtime = createDeviceRuntime({ now: () => 100, authorize(request) { routes++; assert.equal(request.sourceOperation, 'subscribe'); assert.equal(request.sinkOperation, 'write'); return { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 }; } });
  const bus = createBrowserApplicationAudio({ runtime, ownerSignal: owner.signal, applicationId: 'audio-old-proof', sessionId: 'old-session', now: () => 100, environment: realm(routing),
    authorizeSource(request) { sourceDecisions++; return { request, signal: grant.signal, grant: { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 } }; },
    authorizeOutput(request) { outputDecisions++; return { request, signal: grant.signal, grant: { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 } }; } });
  try { const source = bus.registerSource({ sourceId: 'app:old-tone', ownerPrincipalId: 'producer', producerNode: node as unknown as MediaStreamAudioDestinationNode, stream: node.stream as unknown as MediaStream }); assert.ok(source);
    const binding = bus.bind({ source, outputId: 'app:old-output', ownerPrincipalId: 'recipient', purpose: 'private-tone', signal: grant.signal });
    assert.equal(await binding.ready, true); assert.ok(binding.output()); assert.equal(routes, 1); assert.equal(sourceDecisions, 1); assert.equal(outputDecisions, 1);
    assert.equal(routing.source.connections.has(routing.destination), false);
    assert.equal(typeof api?.createLocalAudioTask, 'function', 'Missing independently reviewed local page-tone audio task after the existing SDK path succeeded');
  } finally { await bus.close(); runtime.close(); }
});

function fixture(change: { toneReady?: Promise<void>; toneClose?: Promise<void>; routingResume?: Promise<void>; routingClose?: Promise<void>;
  play?: Promise<void>; clock?: () => number; notify?: () => void; toneHook?: () => void; playHook?: () => void;
  closeThrows?: boolean; clearThrows?: boolean; factoryThrows?: boolean; defaultTone?: boolean; clearTimerHook?: () => void; timerHook?: (run: () => void) => void; routingHook?: () => void } = {}) {
  let at = 100, next = 0, hidden = false, focused = true, factories = 0, plays = 0, clears = 0, attached: MediaStream | undefined;
  const owner = new AbortController(), target = new EventTarget(), document = new EventTarget(), routing: Context[] = [], producers: Context[] = [], tones: AudioTone[] = [];
  const timers = new Map<number, { run: () => void; due: number }>(); const listeners = new Set<EventListenerOrEventListenerObject | null>();
  const environment: BrowserApplicationAudioEnvironment = { ...realm(new Context(), target, document),
  createAudioContext() { const context = new Context(); if (change.routingResume) { context.state = 'suspended'; context.resumeGate = change.routingResume; }
    context.closeGate = change.routingClose; routing.push(context); change.routingHook?.(); return context as unknown as AudioContext; },
  hidden: () => hidden, focused: () => focused,
  target: { addEventListener(name, fn, flags) { listeners.add(fn); target.addEventListener(name, fn, flags); }, removeEventListener(name, fn, flags) { listeners.delete(fn); target.removeEventListener(name, fn, flags); } } };
  const output: AudioOutputPort = { play(stream) { plays++; change.playHook?.(); attached = stream; return change.play ?? Promise.resolve(); }, clear() { clears++; attached = undefined; if (change.clearThrows) throw new Error('Private clear failure'); } };
  const task = api!.createLocalAudioTask({ owner: owner.signal, now: change.clock ?? (() => at), environment, output, onChange: change.notify,
    setTimer(run, delay) { change.timerHook?.(run); const id = ++next; timers.set(id, { run, due: at + delay }); return id; }, clearTimer(token) { change.clearTimerHook?.(); timers.delete(token as number); },
    ...(change.defaultTone ? {} : { createTone() {
      factories++; if (change.factoryThrows) throw new Error('Private factory failure');
      const context = new Context(), node = new Destination(context); producers.push(context); let closed = false;
      const tone: AudioTone = { node: node as unknown as MediaStreamAudioDestinationNode, stream: node.stream as unknown as MediaStream,
        ready: change.toneReady ?? Promise.resolve(), close() { if (!closed) { closed = true; node.disconnect(); for (const track of node.stream.getTracks()) track.stop(); context.close(); }
          if (change.closeThrows) return Promise.reject(new Error('Private producer close failure')); return change.toneClose ?? Promise.resolve(); } };
      tones.push(tone); change.toneHook?.(); return tone;
    } }) });
  function review() { const handle = task.review(); assert.ok(handle); return handle; }
  function approve() { const handle = review(); for (const p of ['source', 'route', 'output'] as const) assert.equal(task.approve(handle, p), true); return handle; }
  function timer(delta?: number) { const item = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0]; if (!item) { if (delta !== undefined) at += delta; return; }
    timers.delete(item[0]); at = delta === undefined ? item[1].due : at + delta; item[1].run(); }
  return { task, owner, target, document, routing, producers, tones, timers, listeners, review, approve, timer,
    factories: () => factories, plays: () => plays, clears: () => clears, attached: () => attached, now: () => at, at(value: number) { at = value; },
    hide() { hidden = true; document.dispatchEvent(new Event('visibilitychange')); }, blur() { focused = false; target.dispatchEvent(new Event('blur')); },
    close: () => task.close() };
}

test('arrival and review are inert; one live handle never renews its deadline or resets approvals', async () => {
  const f = fixture(); try { assert.equal(f.factories(), 0); assert.equal(f.routing.length, 0); assert.equal(f.plays(), 0); assert.equal(f.timers.size, 0);
    const handle = f.review(); assert.equal(f.task.approve(handle, 'source'), true); f.at(4100); assert.equal(f.task.review(), handle);
    assert.equal(f.task.snapshot().review?.source, true); assert.equal(handle.expiresAt, 5100); assert.equal(f.factories(), 0); assert.equal(f.plays(), 0);
    f.at(5100); f.timer(0); assert.equal(f.task.snapshot().reason, 'expired'); assert.equal(f.timers.size, 0); }
  finally { await f.close(); }
});

test('forged, missing, stale and replayed approvals never generate a tone or attach output', async () => {
  const f = fixture(); try { const handle = f.review(); assert.equal(await f.task.start(handle), false); assert.equal(f.task.approve({ ...handle }, 'source'), false);
    f.task.approve(handle, 'source'); f.task.approve(handle, 'route'); assert.equal(await f.task.start(handle), false); assert.equal(f.factories(), 0);
    f.at(handle.expiresAt); assert.equal(f.task.approve(handle, 'output'), false); const fresh = f.approve(); assert.equal(f.task.approve(handle, 'output'), false);
    assert.equal(await f.task.start(fresh), true); assert.equal(await f.task.start(fresh), false); assert.equal(f.factories(), 1); assert.equal(f.plays(), 1); }
  finally { await f.close(); }
});

test('separate actual SDK owner and private route decisions produce one current local output with bounded controls', async () => {
  const f = fixture(); try { assert.equal(await f.task.start(f.approve()), true); const snapshot = f.task.snapshot(); assert.equal(snapshot.phase, 'active');
    assert.equal(snapshot.volume, 0.25); assert.equal(snapshot.muted, false); assert.equal(snapshot.owned.sources, 1); assert.equal(snapshot.owned.outputs, 1); assert.equal(snapshot.owned.routes, 1);
    assert.notEqual(f.attached(), f.tones[0]!.stream); assert.equal(f.routing[0]!.source.connections.has(f.routing[0]!.destination), false);
    assert.equal(f.task.setVolume(0.5), true); assert.equal(f.task.setVolume(0.51), false); assert.equal(f.task.setVolume(NaN), false); assert.equal(f.task.setMuted(true), true);
    assert.equal(f.routing[0]!.gains[0]!.gain.value, 0); assert.equal(f.task.setMuted(false), true); assert.equal(f.routing[0]!.gains[0]!.gain.value, 0.5);
    const text = JSON.stringify(f.task.snapshot()); assert.equal(text.includes('registrationId'), false); assert.equal(text.includes('sampleRate'), false); }
  finally { await f.close(); }
});

for (const cause of ['stop', 'close', 'owner', 'hide', 'blur', 'source-ended', 'routing-loss'] as const) test(`${cause} clears output synchronously and retires owned producer plus SDK clones`, async () => {
  const f = fixture(); try { assert.equal(await f.task.start(f.approve()), true); assert.ok(f.attached());
    let stopped: Promise<void> | undefined;
    if (cause === 'stop') stopped = f.task.stop(); else if (cause === 'close') stopped = f.close(); else if (cause === 'owner') f.owner.abort(); else if (cause === 'hide') f.hide(); else if (cause === 'blur') f.blur();
    else if (cause === 'source-ended') (f.tones[0]!.stream as unknown as Stream).tracks[0]!.dispatchEvent(new Event('ended'));
    else { f.routing[0]!.state = 'suspended'; f.routing[0]!.dispatchEvent(new Event('statechange')); }
    if (cause === 'source-ended' || cause === 'routing-loss') f.timer();
    assert.equal(f.attached(), undefined); assert.equal(f.timers.size, 0); if (stopped) await stopped; await turn();
    assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.task.snapshot().owned.producers, 0); assert.equal(f.task.snapshot().owned.providers, 0);
    assert.equal(f.listeners.size, 0); assert.equal((f.tones[0]!.stream as unknown as Stream).tracks[0]!.stopped, 1);
    assert.equal((f.tones[0]!.stream as unknown as Stream).tracks[0]!.clones[0]!.stopped, 1); }
  finally { await f.close(); }
});

test('first approved-start clock read fixes all permissions before slow factory and later clock calls', async () => {
  let clockAt = 100, advance = false, first: number | undefined;
  const f = fixture({ clock() { const value = clockAt; if (advance) { first ??= value; clockAt++; } return value; }, toneHook() { clockAt += 2000; } });
  try { const handle = f.approve(); advance = true; assert.equal(await f.task.start(handle), true); advance = false; assert.ok(first !== undefined);
    clockAt = first + 10000; f.timer(0); assert.equal(f.attached(), undefined); await turn(); assert.equal(f.task.snapshot().reason, 'expired'); }
  finally { await f.close(); }
});

for (const pending of ['producer-ready', 'routing-resume', 'play', 'producer-close', 'routing-close'] as const) test(`${pending} holds the exact run reservation until actual native-shaped settlement`, async () => {
  const delayed = gate<void>(); const change = pending === 'producer-ready' ? { toneReady: delayed.promise } : pending === 'routing-resume' ? { routingResume: delayed.promise } : pending === 'play' ? { play: delayed.promise } : pending === 'producer-close' ? { toneClose: delayed.promise } : { routingClose: delayed.promise };
  const f = fixture(change); let starting: Promise<boolean> | undefined;
  try { starting = f.task.start(f.approve()); await turn(); if (pending.endsWith('close')) assert.equal(await starting, true);
    const stopped = f.task.stop(); assert.equal(f.attached(), undefined); assert.equal(f.task.review(), undefined); assert.equal(f.task.snapshot().rawPending, 1);
    let settled = false; void stopped.then(() => { settled = true; }); await turn(); assert.equal(settled, false); assert.equal(f.factories(), 1);
    if (pending === 'routing-resume') f.routing[0]!.state = 'running'; delayed.resolve(); await starting; await stopped;
    assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.task.snapshot().owned.providers, 0); assert.equal(f.task.snapshot().owned.producers, 0);
    assert.ok(f.task.review()); }
  finally { delayed.resolve(); if (starting) await starting; await f.close(); }
});

for (const callout of ['factory', 'routing', 'play', 'observer', 'clock'] as const) test(`${callout} reentry cannot reacquire or attach after retirement`, async () => {
  let armed = false, attempted: boolean | undefined;
  const reenter = () => { if (!armed) return; armed = false; void f.task.stop(); attempted = f.task.review() !== undefined; };
  const f = fixture(callout === 'factory' ? { toneHook: reenter } : callout === 'routing' ? { routingHook: reenter } : callout === 'play' ? { playHook: reenter } : callout === 'observer' ? { notify: reenter } : { clock() { reenter(); return 100; } });
  try { const handle = f.approve(); armed = true; assert.equal(await f.task.start(handle), false); await turn(); assert.equal(attempted, false);
    assert.equal(f.attached(), undefined); assert.equal(f.task.snapshot().owned.providers, 0); assert.equal(f.task.snapshot().owned.producers, 0); assert.equal(f.timers.size, 0); }
  finally { await f.close(); }
});

for (const failure of ['producer', 'bus', 'element', 'factory'] as const) test(`${failure} cleanup uncertainty quarantines new review`, async () => {
  const f = fixture(failure === 'producer' ? { closeThrows: true } : failure === 'bus' ? { routingClose: Promise.reject(new Error('Private bus cleanup')) } : failure === 'element' ? { clearThrows: true } : { factoryThrows: true });
  try { const started = await f.task.start(f.approve()); if (failure !== 'factory') assert.equal(started, true); else assert.equal(started, false);
    await f.task.stop(); assert.equal(f.task.snapshot().cleanupUnconfirmed, true); assert.equal(f.task.review(), undefined); assert.equal(f.task.snapshot().reason, 'cleanup-unconfirmed'); assert.equal(f.attached(), undefined); }
  finally { await f.close(); }
});

test('play rejection clears the element and supports recovery only after settlement', async () => {
  const delayed = gate<void>(), f = fixture({ play: delayed.promise }); let starting: Promise<boolean> | undefined;
  try { starting = f.task.start(f.approve()); await turn(); assert.ok(f.attached()); delayed.reject(new Error('Private autoplay rejection'));
    assert.equal(await starting, false); await turn(); assert.equal(f.attached(), undefined); assert.equal(f.task.snapshot().cleanupUnconfirmed, false); assert.ok(f.task.review()); }
  finally { delayed.resolve(); if (starting) await starting; await f.close(); }
});

test('finite starts and actions stop without renewal while review and active work own at most one timer', async () => {
  const f = fixture(); try { for (let i = 0; i < 4; i++) { assert.equal(await f.task.start(f.approve()), true); assert.equal(f.timers.size, 1); await f.task.stop(); }
    const handle = f.approve(); assert.equal(await f.task.start(handle), false); assert.equal(f.task.snapshot().runs, 4); assert.equal(f.task.snapshot().reason, 'quota'); }
  finally { await f.close(); }
  const g = fixture(); try { for (let i = 0; i < 65; i++) g.task.review(); assert.equal(g.task.snapshot().actions, 64); assert.equal(g.task.snapshot().reason, 'quota'); assert.equal(g.factories(), 0); }
  finally { await g.close(); }
});

class Oscillator extends Node { frequency = { value: 0 }; starts = 0; stops = 0; start() { this.starts++; } stop() { this.stops++; } }

test('default browser tone allocates only after approval and keeps its 440 Hz low-gain graph disconnected from speakers', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext'), contexts: NativeContext[] = [];
  class NativeContext extends Context {
    oscillator = new Oscillator(); constructor(options?: AudioContextOptions) { super(); this.state = 'suspended'; assert.equal(options?.sampleRate, 48000); contexts.push(this); }
    createOscillator() { return this.oscillator; }
    override resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: NativeContext });
  const f = fixture({ defaultTone: true });
  try { assert.equal(contexts.length, 0); const handle = f.approve(); assert.equal(contexts.length, 0); assert.equal(await f.task.start(handle), true);
    assert.equal(contexts.length, 1); const context = contexts[0]!; assert.equal(context.resumes, 1); assert.equal(context.oscillator.frequency.value, 440);
    assert.equal(context.gains[0]!.gain.value, 0.05); assert.equal(context.outputs[0]!.channelCount, 2);
    assert.equal(context.oscillator.connections.has(context.destination), false); assert.equal(context.gains[0]!.connections.has(context.destination), false);
    await f.task.stop(); assert.equal(context.oscillator.stops, 1); assert.equal(context.outputs[0]!.stream.tracks[0]!.stopped, 1); assert.equal(context.closes, 1); }
  finally { await f.close(); if (previous) Object.defineProperty(globalThis, 'AudioContext', previous); else Reflect.deleteProperty(globalThis, 'AudioContext'); }
});

test('default partial graph failure retains the exact producer close return and never exposes incomplete nodes', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext'), closing = gate<void>(), contexts: NativeContext[] = [];
  class NativeContext extends Context {
    oscillator = new Oscillator(); constructor() { super(); this.closeGate = closing.promise; contexts.push(this); }
    createOscillator() { return this.oscillator; }
    override createGain(): Node & { gain: { value: number } } { throw new Error('Private failed gain factory after acquisition'); }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: NativeContext });
  const f = fixture({ defaultTone: true });
  try { assert.equal(await f.task.start(f.approve()), false); assert.equal(contexts.length, 1); assert.equal(contexts[0]!.closes, 1);
    assert.equal(f.routing.length, 0); assert.equal(f.plays(), 0); assert.equal(f.task.snapshot().rawPending, 1); assert.equal(f.task.snapshot().owned.producers, 1); assert.equal(f.task.review(), undefined);
    const stopped = f.task.stop(); let settled = false; void stopped.then(() => { settled = true; }); await turn(); assert.equal(settled, false);
    closing.resolve(); await stopped; assert.equal(f.task.snapshot().rawPending, 0); assert.equal(f.task.snapshot().cleanupUnconfirmed, false); assert.ok(f.task.review()); }
  finally { closing.resolve(); await f.close(); if (previous) Object.defineProperty(globalThis, 'AudioContext', previous); else Reflect.deleteProperty(globalThis, 'AudioContext'); }
});

test('default context constructor reentry closes its exact late return before allowing recovery', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext'), closing = gate<void>(), contexts: NativeContext[] = [];
  class NativeContext extends Context {
    constructor() { super(); this.closeGate = closing.promise; contexts.push(this); void f.task.stop(); }
    createOscillator() { throw new Error('Cancelled construction must not reach oscillator'); }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: NativeContext }); const f = fixture({ defaultTone: true });
  try { assert.equal(await f.task.start(f.approve()), false); assert.equal(contexts.length, 1); assert.equal(contexts[0]!.closes, 1); assert.equal(f.task.snapshot().rawPending, 1);
    assert.equal(f.task.review(), undefined); assert.equal(f.plays(), 0); closing.resolve(); await f.task.stop(); assert.equal(f.task.snapshot().owned.producers, 0); }
  finally { closing.resolve(); await f.close(); if (previous) Object.defineProperty(globalThis, 'AudioContext', previous); else Reflect.deleteProperty(globalThis, 'AudioContext'); }
});

test('a late returned producer readiness remains observed and reserved after factory Stop', async () => {
  const ready = gate<void>(); const f = fixture({ toneReady: ready.promise, toneHook() { void f.task.stop(); } });
  let starting: Promise<boolean> | undefined;
  try { starting = f.task.start(f.approve()); await turn(); assert.equal(f.task.snapshot().rawPending, 1);
    const stopped = f.task.stop(); let settled = false; void stopped.then(() => { settled = true; }); await turn(); assert.equal(settled, false);
    assert.equal(f.task.review(), undefined); ready.resolve(); assert.equal(await starting, false); await stopped; assert.equal(f.task.snapshot().rawPending, 0); }
  finally { ready.resolve(); if (starting) await starting; await f.close(); }
});

test('Stop reentry while cancelling the review timer cannot issue a later producer or play call', async () => {
  let armed = false; const f = fixture({ clearTimerHook() { if (armed) { armed = false; void f.task.stop(); } } });
  try { const handle = f.approve(); armed = true; assert.equal(await f.task.start(handle), false); assert.equal(f.factories(), 0);
    assert.equal(f.plays(), 0); assert.equal(f.task.snapshot().owned.producers, 0); assert.equal(f.timers.size, 0); }
  finally { await f.close(); }
});

test('clock Stop during new review cancels provisional admission before creating any timer', async () => {
  let armed = true; const f = fixture({ clock() { if (armed) { armed = false; void f.task.stop(); } return 100; } });
  try { assert.equal(f.task.review(), undefined); assert.equal(f.timers.size, 0); assert.equal(f.factories(), 0); assert.equal(f.task.snapshot().reason, 'stopped'); }
  finally { await f.close(); }
});

test('rejected producer cleanup is quarantined before the completion observer can request another review', async () => {
  const ready = Promise.reject(new Error('Private producer startup failure')), closing = gate<void>(); let armed = false, accepted = false;
  const f = fixture({ toneReady: ready, toneClose: closing.promise, notify() { if (armed && f.task.snapshot().phase === 'stopped') { armed = false; accepted = f.task.review() !== undefined; } } });
  try { assert.equal(await f.task.start(f.approve()), false); armed = true; const stopped = f.task.stop(); closing.reject(new Error('Private delayed cleanup rejection')); await stopped; await turn();
    assert.equal(accepted, false); assert.equal(f.task.snapshot().cleanupUnconfirmed, true); assert.equal(f.task.review(), undefined); }
  finally { closing.resolve(); await f.close(); }
});

for (const callout of ['clearTimer', 'observer'] as const) test(`external review Stop blocks ${callout} reacquisition until retirement returns`, async () => {
  let armed = false, admitted: boolean | undefined;
  const reenter = () => { if (armed) { armed = false; admitted = f.task.review() !== undefined; } };
  const f = fixture(callout === 'clearTimer' ? { clearTimerHook: reenter } : { notify: reenter });
  try {
    assert.ok(f.task.review()); armed = true;
    await f.task.stop();
    assert.equal(admitted, false);
    assert.equal(f.task.snapshot().review, undefined);
    assert.equal(f.task.snapshot().phase, 'stopped');
    assert.equal(f.timers.size, 0);
    assert.equal(f.factories(), 0);
  } finally { armed = false; await f.close(); }
});

test('owner close during the stopped review notification preserves the terminal closed state', async () => {
  let armed = false;
  const f = fixture({ notify() { if (armed && f.task.snapshot().phase === 'stopped') { armed = false; f.owner.abort(); } } });
  try {
    assert.ok(f.task.review()); armed = true;
    await f.task.stop(); await f.task.close();
    assert.equal(f.task.snapshot().phase, 'closed');
    assert.equal(f.task.snapshot().reason, 'closed');
    assert.equal(f.task.snapshot().review, undefined);
    assert.equal(f.task.review(), undefined);
    assert.equal(f.timers.size, 0);
    assert.equal(f.factories(), 0);
  } finally { armed = false; await f.close(); }
});
