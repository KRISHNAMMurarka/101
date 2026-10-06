import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation } from '@101/connect';
import type { BrowserMicrophoneOptions, BrowserMicrophoneActivation, BrowserMicrophoneEnvironment } from './browser-microphone.ts';
const api = await import('./browser-microphone.ts').catch(() => undefined);
test('a selected microphone must expose real typed envelope data rather than chooser metadata', () => {
  assert.equal(typeof api?.createBrowserMicrophoneProvider, 'function', 'Missing typed selected microphone provider');
});

class Track extends EventTarget { kind = 'audio'; readyState = 'live'; muted = false; stopped = 0; deviceId = 'selected-id'; stop() { this.stopped++; this.readyState = 'ended'; } getSettings() { return { deviceId: this.deviceId }; } }
class Stream { track = new Track(); getTracks() { return [this.track]; } }
class Context extends EventTarget {
  state = 'running'; sampleRate = 48000; currentTime = 0.125; level = 0.25; closes = 0; reads = 0; disconnected = 0; onRead?: () => void;
  resumeGate?: Promise<void>; closeGate?: Promise<void>;
  createMediaStreamSource() { return { connect() {}, disconnect: () => { this.disconnected++; } }; }
  createAnalyser() { return { fftSize: 256, getFloatTimeDomainData: (buffer: Float32Array) => { this.reads++; buffer.fill(this.level); this.onRead?.(); }, disconnect: () => { this.disconnected++; } }; }
  resume() { return this.resumeGate ?? Promise.resolve(); }
  close() { this.closes++; this.state = 'closed'; return this.closeGate ?? Promise.resolve(); }
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const wait = (ms = 65) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(change: Partial<BrowserMicrophoneOptions> = {}) {
  let at = 100, opens = 0, inspections = 0, allowed = true, hidden = false, focused = true, releases = 0;
  const owner = new AbortController(), capture = new AbortController(), stream = new Stream(), context = new Context();
  const target = new EventTarget(), document = new EventTarget(), mediaDevicesTarget = new EventTarget();
  const devices = [{ kind: 'audioinput', deviceId: 'default' }, { kind: 'audioinput', deviceId: '' }, { kind: 'audioinput', deviceId: 'selected-id' }];
  const observations: Observation[] = []; let held: unknown, openGate: Promise<MediaStream> | undefined;
  const scope = { principalId: 'microphone-owner', applicationId: 'microphone-app', sessionId: 'microphone-session' };
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'javascript-retrieval', authorize(request) {
    if (allowed && request.principalId === scope.principalId && request.applicationId === scope.applicationId && request.sessionId === scope.sessionId && request.sourceOperation === 'subscribe' && request.sinkOperation === 'write') return { expiresAt: at + 1000, maxAgeMs: 100, maxHz: 20 };
  } });
  const environment: BrowserMicrophoneEnvironment = { fixtureKind: 'software-fixture',
    enumerateDevices() { inspections++; return Promise.resolve(devices as MediaDeviceInfo[]); },
    getUserMedia(constraints) { opens++; assert.deepEqual(constraints, { audio: { deviceId: { exact: 'selected-id' } }, video: false }); return openGate ?? Promise.resolve(stream as unknown as MediaStream); },
    createAudioContext: () => context as unknown as AudioContext, MediaStream: Stream as unknown as typeof MediaStream, AudioContext: Context as unknown as typeof AudioContext,
    target, document, mediaDevicesTarget, hidden: () => hidden, focused: () => focused, secureContext: () => true };
  const provider = api!.createBrowserMicrophoneProvider({ runtime, ownerSignal: owner.signal, scope, now: () => at,
    authorizeCapture(request) { return { request, signal: capture.signal, expiresAt: at + 1000 }; }, environment, ...change });
  async function selection() { const result = await provider.inspect(); assert.ok(result.ok); assert.equal(result.value.length, 1); return result.value[0]!.selection; }
  function bind(active: BrowserMicrophoneActivation) {
    const device = parseDeviceDescriptor({ ...active.device, id: active.device.id + ':consumer', capabilities: active.device.capabilities.map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device, capability: 'envelope', apply(observation, ctx) { if (ctx.isCurrent() && !ctx.signal.aborted) { observations.push(observation); held = observation.value; } }, release() { held = undefined; releases++; } });
    runtime.setReadiness(sink, 'available'); return runtime.route({ from: active.source, to: sink, ...scope, leaseMs: 1000 });
  }
  async function start() { const result = await provider.start(await selection(), { purpose: 'selected-envelope' }); assert.ok(result.ok); const route = bind(result.value); assert.ok(route.start().ok); return result.value; }
  return { provider, stream, context, environment, target, document, mediaDevicesTarget, owner, capture, runtime, devices, observations, scope, selection, bind, start,
    opens: () => opens, inspections: () => inspections, held: () => held, releases: () => releases,
    setAt(value: number) { at = value; }, denyRoutes() { allowed = false; }, holdOpen(promise: Promise<MediaStream>) { openGate = promise; },
    async poll() { at += 50; await wait(); runtime.flush(); }, hide() { hidden = true; document.dispatchEvent(new Event('visibilitychange')); }, blur() { focused = false; target.dispatchEvent(new Event('blur')); },
    async close() { await provider.close(); runtime.close(); } };
}

test('construction is inert and inspection issues only exact non-alias current handles', async () => {
  const f = fixture(); try { assert.equal(f.opens(), 0); assert.equal(f.inspections(), 0); assert.equal(f.provider.snapshot().listeners, 0);
    const handle = await f.selection(); assert.equal(f.opens(), 0); assert.equal(f.provider.snapshot().phase, 'selected');
    assert.equal(JSON.stringify(handle).includes('selected-id'), false); assert.equal((await f.provider.start({}, { purpose: 'forged' })).ok, false);
  } finally { await f.close(); }
});
test('the exact granted resource routes bounded RMS and peak with separate unmapped context provenance', async () => {
  const f = fixture(); try { await f.start(); await f.poll(); const last = f.observations.at(-1)!;
    assert.deepEqual(last.value, { rms: 0.25, peak: 0.25, sampleCount: 256, sampleRateHz: 48000 }); assert.equal(last.timestamp, 150); assert.equal(last.clockDomain, 'javascript-retrieval');
    assert.equal(last.provenance?.audioContextTimeSeconds, 0.125); assert.equal(last.provenance?.captureTimeKnown, false); assert.equal(last.provenance?.clockMappingEstablished, false);
    assert.equal(last.provenance?.factoryKind, 'software-fixture'); assert.equal(JSON.stringify(last).includes('selected-id'), false);
  } finally { await f.close(); }
});
for (const cause of ['stop', 'owner', 'capture', 'hide', 'blur', 'ended', 'mute', 'devicechange'] as const) test(`${cause} retires capture and releases the actual granted sink`, async () => {
  const f = fixture(); try { await f.start(); await f.poll(); assert.ok(f.held());
    if (cause === 'stop') f.provider.stop(); else if (cause === 'owner') f.owner.abort(); else if (cause === 'capture') f.capture.abort(); else if (cause === 'hide') f.hide(); else if (cause === 'blur') f.blur(); else if (cause === 'devicechange') f.mediaDevicesTarget.dispatchEvent(new Event('devicechange')); else f.stream.track.dispatchEvent(new Event(cause));
    assert.equal(f.held(), undefined); assert.ok(f.releases() > 0); assert.equal(f.provider.snapshot().activeSources, 0); await f.provider.close(); assert.ok(f.stream.track.stopped > 0); assert.equal(f.context.closes, 1); assert.equal(f.provider.snapshot().rawPending, 0);
  } finally { await f.close(); }
});
test('denied, substituted, getter and foreign capture approvals never open native input', async () => {
  for (const authorizeCapture of [() => undefined, (request: unknown) => ({ request: { ...request as object }, signal: new AbortController().signal, expiresAt: 1100 }), (request: unknown) => ({ request, signal: {} as AbortSignal, expiresAt: 1100 }), () => ({ get request() { throw new Error('Grant getter must not execute'); }, signal: new AbortController().signal, expiresAt: 1100 })]) {
    const f = fixture({ authorizeCapture: authorizeCapture as BrowserMicrophoneOptions['authorizeCapture'] }); try { assert.equal((await f.provider.start(await f.selection(), { purpose: 'exact' })).ok, false); assert.equal(f.opens(), 0); } finally { await f.close(); }
  }
});
test('late opened input stays reserved after cancellation and is stopped before fresh retry', async () => {
  const f = fixture(), native = gate<MediaStream>(); try {
    const handle = await f.selection(); f.holdOpen(native.promise); const pending = f.provider.start(handle, { purpose: 'pending' }); await Promise.resolve(); f.provider.stop();
    assert.equal((await pending).ok, false); assert.equal(f.provider.snapshot().rawPending, 1); assert.equal((await f.provider.inspect()).ok, false);
    native.resolve(f.stream as unknown as MediaStream); await wait(5); assert.equal(f.provider.snapshot().rawPending, 0); assert.ok(f.stream.track.stopped > 0); assert.equal(f.context.closes, 0);
  } finally { native.resolve(f.stream as unknown as MediaStream); await f.close(); }
});
test('resume and native context close retain the one raw slot until both actual promises settle', async () => {
  const f = fixture(), resume = gate<void>(), close = gate<void>(); try {
    f.context.state = 'suspended'; f.context.resumeGate = resume.promise; f.context.closeGate = close.promise;
    const opening = f.provider.start(await f.selection(), { purpose: 'pending-resume' }); await wait(5); f.provider.stop(); assert.equal((await opening).ok, false); assert.equal(f.provider.snapshot().rawPending, 1);
    close.resolve(); await wait(5); assert.equal(f.provider.snapshot().rawPending, 1); assert.equal((await f.provider.inspect()).ok, false);
    resume.resolve(); await wait(5); assert.equal(f.provider.snapshot().rawPending, 0); assert.equal(f.context.closes, 1);
  } finally { resume.resolve(); close.resolve(); await f.close(); }
});
test('reentrant authorizer, clock and analyser cannot dispatch after current capture revocation', async () => {
  const f = fixture(); try { await f.start(); f.context.onRead = () => f.capture.abort(); await f.poll(); assert.equal(f.observations.length, 0); assert.equal(f.provider.snapshot().activeSources, 0); } finally { await f.close(); }
  let cancel = () => {}; const g = fixture({ authorizeCapture(request) { cancel(); return { request, signal: new AbortController().signal, expiresAt: 1100 }; } }); cancel = () => g.provider.stop();
  try { assert.equal((await g.provider.start(await g.selection(), { purpose: 'cancel' })).ok, false); assert.equal(g.opens(), 0); } finally { await g.close(); }
});
test('quiet grant expiry and backwards clocks retire without a new analyser read', async () => {
  const f = fixture(); try { await f.start(); f.setAt(1101); f.provider.sweep(); assert.equal(f.provider.snapshot().activeSources, 0); assert.equal(f.context.reads, 0); } finally { await f.close(); }
  const g = fixture(); try { await g.start(); g.setAt(99); g.provider.sweep(); assert.equal(g.provider.snapshot().activeSources, 0); assert.equal(g.provider.snapshot().reason, 'invalid'); } finally { await g.close(); }
});

test('a granted native open failure retires exact listeners and selection before retry', async () => {
  const f = fixture(); try {
    f.stream.track.deviceId = 'different-id'; const opened = await f.provider.start(await f.selection(), { purpose: 'exact-id' });
    assert.deepEqual(opened, { ok: false, reason: 'lost' }); assert.equal(f.provider.snapshot().listeners, 0); assert.equal(f.provider.snapshot().phase, 'idle'); assert.equal(f.provider.snapshot().rawPending, 0); assert.ok(f.stream.track.stopped > 0); assert.equal(f.context.closes, 0);
  } finally { await f.close(); }
});

test('stop inside actual source readiness unregisters the newly registered source before activation', async () => {
  const f = fixture(); const original = f.runtime.setReadiness.bind(f.runtime); let issued: Parameters<typeof original>[0] | undefined;
  f.runtime.setReadiness = (source, readiness, expiresAt) => { issued = source; const result = original(source, readiness, expiresAt); f.provider.stop(); return result; };
  try { assert.equal((await f.provider.start(await f.selection(), { purpose: 'retire-readiness' })).ok, false); assert.ok(issued); assert.equal(original(issued, 'available').ok, false, 'A pending registration is real SDK authority and must be removed'); }
  finally { f.runtime.setReadiness = original; await f.close(); }
});

test('actual Node has no native media API and remains unsupported with zero native capture', async () => {
  const runtime = createDeviceRuntime({ authorize: () => undefined, now: () => 100 }); const provider = api!.createBrowserMicrophoneProvider({ runtime, ownerSignal: new AbortController().signal,
    scope: { principalId: 'node', applicationId: 'negative', sessionId: 'local' }, now: () => 100, authorizeCapture: () => undefined });
  try { assert.deepEqual(await provider.inspect(), { ok: false, reason: 'unsupported' }); assert.equal(provider.snapshot().rawPending, 0); assert.equal(provider.snapshot().activeSources, 0); }
  finally { await provider.close(); runtime.close(); }
});

test('unknown permission-policy feature readback never issues default capture', async () => {
  const { checkBrowserMicrophoneWithoutDevice } = await import('../../../examples/browser-resources/microphone.ts');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let opens = 0;
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia() { opens++; return Promise.reject(new DOMException('Fixture denial', 'NotAllowedError')); } } } });
    for (const features of [undefined, () => ['unrecognized-feature'], () => ['microphone']]) {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { featurePolicy: { allowsFeature: () => false, features } }) });
      const result = await checkBrowserMicrophoneWithoutDevice();
      assert.equal(result.native.defaultNativeOpens, features?.().includes('microphone') ? 1 : 0);
      assert.equal(result.final.listeners, 0); assert.equal(result.final.rawPending, 0);
    }
    assert.equal(opens, 1, 'Only the recognized denied feature may issue this explicitly software negative');
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('actual denied-policy constraint rejection remains distinct from qualified native denial', async () => {
  const { checkBrowserMicrophoneWithoutDevice } = await import('../../../examples/browser-resources/microphone.ts');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let opens = 0;
  class OverconstrainedError extends DOMException { constructor() { super('', 'OverconstrainedError'); } }
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { featurePolicy: { features: () => ['microphone'], allowsFeature: () => false } }) });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia(constraints: MediaStreamConstraints) {
      opens++; assert.deepEqual(constraints, { audio: { deviceId: { exact: 'owned-policy-negative-no-device' } }, video: false });
      return Promise.reject(new OverconstrainedError());
    } } } });
    // Faithful Chromium149 native error name/type from the owned /denied page;
    // this software reproduction does not itself qualify native enforcement.
    const result = await checkBrowserMicrophoneWithoutDevice();
    assert.equal(opens, 1); assert.equal(result.native.policyFeatureRecognized, true); assert.equal(result.native.policyDenied, true);
    assert.equal(result.native.nativeRejection, 'constraints'); assert.equal(result.native.nativeDenied, false); assert.equal(result.native.nativePolicyDenialQualified, false);
    assert.equal(result.final.listeners, 0); assert.equal(result.final.rawPending, 0); assert.equal(result.captureApprovals, 0);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
