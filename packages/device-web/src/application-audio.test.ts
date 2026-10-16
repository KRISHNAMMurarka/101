import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRuntime, parseDeviceDescriptor } from '@101/connect';
import type { Observation } from '@101/connect';
import type { BrowserApplicationAudioOptions, BrowserApplicationAudioEnvironment, BrowserApplicationAudioSource } from './application-audio.ts';

const api = await import('./application-audio.ts').catch(() => undefined);
test('private application audio needs an audio-specific runtime route, beyond envelope diagnostics', () => {
  assert.equal(typeof api?.createBrowserApplicationAudio, 'function', 'Missing independently approved private application audio routing');
});

// Cooperative software seam: it models native graph/lifecycle effects, not audio evidence.
class Track extends EventTarget {
  kind = 'audio'; readyState = 'live'; muted = false; stopped = 0; sampleRate: number | undefined = 48000; channelCount: number | undefined = 2; cloneValue?: Track;
  getSettings() { return { sampleRate: this.sampleRate, channelCount: this.channelCount }; }
  clone() { return this.cloneValue ?? new Track(); }
  stop() { this.stopped++; this.readyState = 'ended'; }
}
class Stream { readonly tracks: Track[]; constructor(tracks: Track[] = [new Track()]) { this.tracks = tracks; } getTracks() { return this.tracks; } getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); } }
class Node {
  connections = new Set<Node>(); disconnects = 0; rejectAbsentTarget = false; beforeConnect?: () => void; afterConnect?: () => void;
  connect(target: Node) { this.beforeConnect?.(); this.connections.add(target); this.afterConnect?.(); return target; }
  disconnect(target?: Node) { this.disconnects++; if (target && this.rejectAbsentTarget && !this.connections.has(target)) throw new DOMException('', 'InvalidAccessError'); if (target) this.connections.delete(target); else this.connections.clear(); }
}
class Destination extends Node {
  readonly context: Context; stream: Stream; channelCount = 2; channelCountMode = 'explicit';
  constructor(context: Context, stream = new Stream()) { super(); this.context = context; this.stream = stream; }
}
class Context extends EventTarget {
  state = 'running'; sampleRate = 48000; currentTime = 0.125; closes = 0; resumes = 0; analyserReads = 0; level = 0.25;
  readonly destination = new Node(); readonly source = new Node(); readonly outputs: { stream: Stream; node: Node }[] = []; readonly gains: Node[] = [];
  resumeGate?: Promise<void>; closeGate?: Promise<void>; onCreateGain?: () => void; onRead?: () => void;
  createMediaStreamSource(stream: Stream) { assert.equal(stream.tracks.length, 1); return this.source; }
  createAnalyser() { const node = new Node(); return Object.assign(node, { fftSize: 256, getFloatTimeDomainData: (samples: Float32Array) => { this.analyserReads++; samples.fill(this.level); this.onRead?.(); } }); }
  createGain() { const node = Object.assign(new Node(), { gain: { value: 1 } }); this.gains.push(node); this.onCreateGain?.(); return node; }
  createMediaStreamDestination() { const node = new Destination(this); this.outputs.push({ stream: node.stream, node }); return node; }
  resume() { this.resumes++; return this.resumeGate ?? Promise.resolve(); }
  close() { this.closes++; this.state = 'closed'; return this.closeGate ?? Promise.resolve(); }
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

function fixture(change: Partial<BrowserApplicationAudioOptions> = {}, beforeContextReturn?: () => void) {
  let at = 100, routeExpiry = 1100, audioAllowed = true, diagnosticsAllowed = true, hidden = false, focused = true, contexts = 0, releaseCount = 0;
  const owner = new AbortController(), sourceGrant = new AbortController(), outputGrant = new AbortController(), target = new EventTarget(), document = new EventTarget();
  const original = new Track(), cloned = new Track(); original.cloneValue = cloned;
  const stream = new Stream([original]), context = new Context(), producingContext = new Context(), producerNode = new Destination(producingContext, stream), observations: Observation[] = [];
  const runtime = createDeviceRuntime({ now: () => at, clockDomain: 'host-retrieval', maxRegistrations: 8, maxRoutes: 4, authorize(request) {
    const allowed = request.source.capabilityId === 'levels' ? diagnosticsAllowed : audioAllowed;
    if (allowed && request.principalId === 'recipient' && request.applicationId === 'audio-app' && request.sessionId === 'local-session')
      return { expiresAt: routeExpiry, maxAgeMs: 250, maxHz: 20 };
  } });
  const environment: BrowserApplicationAudioEnvironment = { fixtureKind: 'software-fixture',
    createAudioContext() { contexts++; beforeContextReturn?.(); return context as unknown as AudioContext; },
    createMediaStream(tracks) { return new Stream(tracks as unknown as Track[]) as unknown as MediaStream; },
    AudioContext: Context as unknown as typeof AudioContext, MediaStream: Stream as unknown as typeof MediaStream, MediaStreamTrack: Track as unknown as typeof MediaStreamTrack, MediaStreamAudioDestinationNode: Destination as unknown as typeof MediaStreamAudioDestinationNode,
    target, document, hidden: () => hidden, focused: () => focused };
  const bus = api!.createBrowserApplicationAudio({ runtime, ownerSignal: owner.signal, applicationId: 'audio-app', sessionId: 'local-session', now: () => at,
    authorizeSource(request) { return { request, signal: sourceGrant.signal, grant: { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 } }; },
    authorizeOutput(request) { return { request, signal: outputGrant.signal, grant: { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 } }; }, environment, ...change });
  let handle: BrowserApplicationAudioSource | undefined;
  function source() { handle ??= bus.registerSource({ sourceId: 'app:tone', ownerPrincipalId: 'producer', producerNode: producerNode as unknown as MediaStreamAudioDestinationNode, stream: stream as unknown as MediaStream }); assert.ok(handle); return handle; }
  function bind(handle: BrowserApplicationAudioSource, outputId = 'app:private-audio') { return bus.bind({ source: handle, outputId, ownerPrincipalId: 'recipient', purpose: 'private-tone', signal: new AbortController().signal }); }
  function diagnostic(handle: BrowserApplicationAudioSource) {
    const resources = bus.resources(handle); assert.ok(resources);
    const device = parseDeviceDescriptor({ ...resources.device, id: 'app:levels', capabilities: resources.device.capabilities.filter(c => c.id === 'levels').map(c => ({ ...c, permissions: ['write'], ownership: { mode: 'observe' } })) });
    const sink = runtime.registerSink({ device, capability: 'levels', apply(value, ctx) { if (ctx.isCurrent()) observations.push(value); }, release() { releaseCount++; } });
    runtime.setReadiness(sink, 'available'); const route = runtime.route({ from: resources.levels, to: sink, principalId: 'recipient', applicationId: 'audio-app', sessionId: 'local-session' }); return { route, started: route.start().ok };
  }
  return { bus, runtime, owner, sourceGrant, outputGrant, original, cloned, stream, context, producingContext, producerNode, environment, target, document, observations, source, bind, diagnostic,
    contexts: () => contexts, releases: () => releaseCount,
    denyAudio() { audioAllowed = false; }, denyDiagnostics() { diagnosticsAllowed = false; }, setAt(value: number) { at = value; }, setRouteExpiry(value: number) { routeExpiry = value; },
    poll() { at += 50; bus.sweep(); }, hide() { hidden = true; document.dispatchEvent(new Event('visibilitychange')); }, blur() { focused = false; target.dispatchEvent(new Event('blur')); },
    async close() { await bus.close(); runtime.close(); } };
}

test('inert diagnostic availability and a diagnostics-only authorizer cannot activate private audio', async () => {
  const f = fixture(); try { const source = f.source(); assert.equal(f.diagnostic(source).started, false, 'An inactive analyser is truthfully unavailable'); f.denyAudio(); const binding = f.bind(source);
    assert.equal(await binding.ready, false); assert.equal(f.contexts(), 0); assert.equal(f.original.stopped, 0); assert.equal(f.bus.snapshot().activeOutputs, 0);
  } finally { await f.close(); }
});
test('actual SDK audio approval connects only a private destination and diagnostics require their own grant', async () => {
  const f = fixture(); try { const source = f.source(); const binding = f.bind(source); assert.equal(await binding.ready, true); assert.ok(binding.output());
    assert.equal(f.context.source.connections.has(f.context.destination), false); assert.equal(f.context.source.connections.has(f.context.gains[0]!), true);
    f.denyDiagnostics(); f.poll(); assert.equal(f.observations.length, 0); assert.equal(binding.status().state, 'active');
    assert.equal(binding.setVolume(0.5), true); assert.equal((f.context.gains[0] as Node & { gain: { value: number } }).gain.value, 0.5); assert.equal(binding.setVolume(2), false);
    binding.stop(); assert.equal(binding.output(), undefined); assert.equal(f.context.source.connections.has(f.context.gains[0]!), false); await f.close();
    assert.equal(f.original.stopped, 0); assert.equal(f.cloned.stopped, 1); assert.equal(f.context.closes, 1); assert.equal(f.context.outputs[0]!.stream.tracks[0]!.stopped, 1);
  } finally { await f.close(); }
});
test('a separately granted diagnostic sink observes bounded actual analyser values with unmapped clocks', async () => {
  const f = fixture(); try { const source = f.source(); assert.equal(await f.bind(source).ready, true); assert.ok(f.diagnostic(source).started); f.poll();
    assert.deepEqual(f.observations.at(-1)?.value, { rms: 0.25, peak: 0.25, sampleCount: 256, sampleRateHz: 48000 });
    assert.equal(f.observations.at(-1)?.clockDomain, 'host-retrieval'); assert.equal(f.observations.at(-1)?.timestamp, 150);
    assert.equal(f.observations.at(-1)?.provenance?.routingContextTimeSeconds, 0.125); assert.equal(f.observations.at(-1)?.provenance?.captureTimeKnown, false);
  } finally { await f.close(); }
});
test('source/output owner approvals bind the exact immutable audio resource and recipient operation', async () => {
  let issued: unknown; const f = fixture({ authorizeOutput(request) { issued = request; assert.ok(Object.isFrozen(request)); assert.equal(request.operation, 'route-private-audio'); assert.equal(request.format.sampleRateHz, 48000); assert.equal(request.format.channels, 2); assert.equal(request.recipientPrincipalId, 'recipient');
    return { request: { ...request }, signal: new AbortController().signal, grant: { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 } }; } });
  try { const b = f.bind(f.source()); assert.equal(await b.ready, false); assert.ok(issued); assert.equal(f.contexts(), 0); } finally { await f.close(); }
});
for (const value of ['getter', 'forged-signal', 'expired', 'denied'] as const) test(`${value} owner decision creates no native audio graph`, async () => {
  const f = fixture({ authorizeOutput(request) {
    if (value === 'getter') return { get request(): Parameters<BrowserApplicationAudioOptions['authorizeOutput']>[0] { throw new Error('Accessor must not execute'); }, signal: new AbortController().signal, grant: { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 } };
    if (value === 'denied') return undefined;
    return { request, signal: value === 'forged-signal' ? {} as AbortSignal : new AbortController().signal, grant: { expiresAt: value === 'expired' ? 100 : 1100, maxAgeMs: 250, maxHz: 20 } };
  } }); try { assert.equal(await f.bind(f.source()).ready, false); assert.equal(f.contexts(), 0); } finally { await f.close(); }
});
test('contradictory native source/output format facts reject rather than use requested settings', async () => {
  const f = fixture(); try { f.original.channelCount = 1; assert.equal(f.bus.registerSource({ sourceId: 'app:unknown', ownerPrincipalId: 'producer', producerNode: f.producerNode as unknown as MediaStreamAudioDestinationNode, stream: f.stream as unknown as MediaStream }), undefined); assert.equal(f.contexts(), 0); } finally { await f.close(); }
  const g = fixture(); const create = g.context.createMediaStreamDestination.bind(g.context); g.context.createMediaStreamDestination = () => { const node = create(); node.stream.tracks[0]!.sampleRate = 0; return node; };
  try { assert.equal(await g.bind(g.source()).ready, false); assert.equal(g.original.stopped, 0); assert.equal(g.bus.snapshot().activeOutputs, 0); } finally { await g.close(); }
});
for (const cause of ['owner', 'source', 'output', 'hide', 'blur', 'ended', 'mute', 'context'] as const) test(`${cause} immediately retires private held audio while leaving the borrowed producer intact`, async () => {
  const f = fixture(); try { const b = f.bind(f.source()); assert.equal(await b.ready, true);
    if (cause === 'owner') f.owner.abort(); else if (cause === 'source') f.sourceGrant.abort(); else if (cause === 'output') f.outputGrant.abort(); else if (cause === 'hide') f.hide(); else if (cause === 'blur') f.blur();
    else if (cause === 'context') { f.context.state = 'suspended'; f.context.dispatchEvent(new Event('statechange')); }
    else f.cloned.dispatchEvent(new Event(cause));
    assert.equal(b.output(), undefined); assert.equal(f.context.source.connections.has(f.context.gains[0]!), false); assert.equal(f.original.stopped, 0); await f.close(); assert.equal(f.bus.snapshot().rawPending, 0);
  } finally { await f.close(); }
});
test('cancelled native resume and close keep the raw slot until both actual promises settle', async () => {
  const f = fixture(), resumed = gate<void>(), closed = gate<void>(); try {
    f.context.state = 'suspended'; f.context.resumeGate = resumed.promise; f.context.closeGate = closed.promise; const b = f.bind(f.source()); await tick(); b.stop();
    assert.equal(await b.ready, false); assert.equal(f.bus.snapshot().rawPending, 1); const next = f.bind(f.source(), 'app:retry'); assert.equal(await next.ready, false); assert.equal(next.status().reason, 'busy');
    closed.resolve(); await tick(); assert.equal(f.bus.snapshot().rawPending, 1); resumed.resolve(); await tick(); assert.equal(f.bus.snapshot().rawPending, 0); assert.equal(f.context.closes, 1);
  } finally { resumed.resolve(); closed.resolve(); await f.close(); }
});
test('reentrant output consent and clock cancellation cannot dispatch a late graph or leak an output', async () => {
  let cancel = () => {}; const f = fixture({ authorizeOutput(request) { cancel(); return { request, signal: new AbortController().signal, grant: { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 } }; } }); cancel = () => { void f.bus.close(); };
  try { assert.equal(await f.bind(f.source()).ready, false); assert.equal(f.contexts(), 0); assert.equal(f.bus.snapshot().activeOutputs, 0); } finally { await f.close(); }
  const g = fixture(); g.context.source.afterConnect = () => { void g.bus.close(); };
  try { assert.equal(await g.bind(g.source()).ready, false); await g.close(); assert.equal(g.context.source.connections.size, 0); assert.equal(g.original.stopped, 0); } finally { await g.close(); }
});
test('quiet expiry and backwards owner clock retire before another diagnostic read', async () => {
  const f = fixture(); try { const b = f.bind(f.source()); assert.equal(await b.ready, true); const reads = f.context.analyserReads; f.setAt(1101); f.bus.sweep(); assert.equal(b.output(), undefined); assert.equal(f.context.analyserReads, reads); } finally { await f.close(); }
  const g = fixture(); try { const b = g.bind(g.source()); assert.equal(await b.ready, true); g.setAt(99); g.bus.sweep(); assert.equal(b.status().state, 'stopped'); assert.equal(b.status().reason, 'invalid'); } finally { await g.close(); }
});
test('a denied second output retains the first output and two recipients are the hard capacity', async () => {
  let allow = true; const f = fixture({ authorizeOutput(request) { return allow ? { request, signal: new AbortController().signal, grant: { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 } } : undefined; } });
  try { const source = f.source(), first = f.bind(source); assert.equal(await first.ready, true); allow = false; assert.equal(await f.bind(source, 'app:declined').ready, false); assert.ok(first.output());
    allow = true; assert.equal(await f.bind(source, 'app:second').ready, true); assert.equal(await f.bind(source, 'app:third').ready, false); assert.equal(f.contexts(), 1); assert.equal(f.bus.snapshot().activeOutputs, 2);
  } finally { await f.close(); }
});
test('a native connect wrapper that retires before connecting leaves no late owned graph edge', async () => {
  const f = fixture(); f.context.source.beforeConnect = () => { void f.bus.close(); };
  try { const b = f.bind(f.source()); assert.equal(await b.ready, false); await f.close(); assert.equal(f.context.source.connections.size, 0, 'Retirement before a native side effect still requires exact post-call disconnect'); }
  finally { await f.close(); }
});
test('the opening deadline does not silently replace a longer approved active lifetime', async () => {
  const authorize = (request: Parameters<BrowserApplicationAudioOptions['authorizeSource']>[0]) => ({ request, signal: new AbortController().signal, grant: { expiresAt: 20100, maxAgeMs: 250, maxHz: 20 } });
  const f = fixture({ authorizeSource: authorize, authorizeOutput: authorize }); f.setRouteExpiry(20100);
  try { const b = f.bind(f.source()); assert.equal(await b.ready, true); assert.equal(b.status().expiresAt, 20100, 'Open bound must remain distinct from immutable active grant expiry'); } finally { await f.close(); }
});
test('retiring one native output once does not repeat an absent-edge removal through route release', async () => {
  const f = fixture(); f.context.source.rejectAbsentTarget = true;
  try { const source = f.source(), first = f.bind(source); assert.equal(await first.ready, true); assert.equal(await f.bind(source, 'app:second').ready, true); first.stop();
    assert.equal(f.bus.snapshot().cleanupFailures, 0, 'Native AudioNode.disconnect(target) throws when an edge was already removed'); assert.equal(f.bus.snapshot().activeOutputs, 1);
  } finally { await f.close(); }
});


test('an exact borrowed native destination establishes graph facts while track metadata remains explicitly unknown', async () => {
  const f = fixture(); f.original.sampleRate = undefined; f.original.channelCount = undefined;
  try { const source = f.source(); const b = f.bind(source); assert.equal(await b.ready, true); assert.equal(f.producerNode.channelCount, 2); assert.equal(f.producingContext.closes, 0); } finally { await f.close(); }
});
for (const cause of ['rate', 'channels', 'stream', 'context'] as const) test(`borrowed producer ${cause} loss retires without modifying that producer`, async () => {
  const f = fixture(); try { const b = f.bind(f.source()); assert.equal(await b.ready, true);
    if (cause === 'rate') f.producingContext.sampleRate = 44100; else if (cause === 'channels') f.producerNode.channelCount = 1;
    else if (cause === 'stream') f.producerNode.stream = new Stream(); else { f.producingContext.state = 'closed'; f.producingContext.dispatchEvent(new Event('statechange')); }
    f.poll(); assert.equal(b.output(), undefined); assert.equal(f.original.stopped, 0); assert.equal(f.producingContext.closes, 0);
  } finally { await f.close(); }
});
test('a second output native setup failure retains the already admitted private output', async () => {
  const f = fixture(); try { const source = f.source(), first = f.bind(source); assert.equal(await first.ready, true);
    f.context.onCreateGain = () => { throw new Error('Native gain unavailable'); };
    assert.equal(await f.bind(source, 'app:failed-second').ready, false); assert.ok(first.output(), 'A failed independent output must not close the shared incumbent context'); assert.equal(f.context.closes, 0);
  } finally { await f.close(); }
});
test('caller reflection cannot start a nested native setup before the outer raw slot is reserved', async () => {
  const f = fixture(), resumed = gate<void>(); const source = f.source(); f.context.state = 'suspended'; f.context.resumeGate = resumed.promise;
  let nested: ReturnType<typeof f.bind> | undefined, invoked = false;
  const input = new Proxy({ source, outputId: 'app:outer', ownerPrincipalId: 'recipient', purpose: 'exact', signal: new AbortController().signal }, {
    getPrototypeOf(target) { if (!invoked) { invoked = true; nested = f.bind(source, 'app:inner'); } return Reflect.getPrototypeOf(target); }
  });
  try { const outer = f.bus.bind(input); assert.equal(nested?.status().reason, 'busy'); assert.equal(f.contexts(), 1); assert.equal(f.bus.snapshot().rawPending, 1); outer.stop(); }
  finally { resumed.resolve(); await f.close(); }
});
test('source reflection cannot register two borrowed producers beyond the one-source ceiling', async () => {
  const f = fixture(); let nested: BrowserApplicationAudioSource | undefined, invoked = false;
  const values = { sourceId: 'app:outer-source', ownerPrincipalId: 'producer', producerNode: f.producerNode as unknown as MediaStreamAudioDestinationNode, stream: f.stream as unknown as MediaStream };
  const input = new Proxy(values, { getPrototypeOf(target) { if (!invoked) { invoked = true; nested = f.bus.registerSource({ ...values, sourceId: 'app:inner-source' }); } return Reflect.getPrototypeOf(target); } });
  try { assert.ok(f.bus.registerSource(input)); assert.equal(nested, undefined); assert.equal(f.bus.snapshot().sources, 1); } finally { await f.close(); }
});
test('a close retained inside native context creation awaits the late returned context cleanup', async () => {
  const nativeClosed = gate<void>(); let callback = () => {}, retained: Promise<void> | undefined, settled = false;
  const f = fixture({}, () => callback()); f.context.closeGate = nativeClosed.promise;
  callback = () => { retained = f.bus.close(); void retained.then(() => { settled = true; }); };
  try {
    assert.equal(await f.bind(f.source()).ready, false); await tick();
    assert.equal(f.context.closes, 1); assert.equal(f.bus.snapshot().rawPending, 1); assert.equal(f.bus.snapshot().cleanupPending, 1);
    assert.ok(retained); assert.equal(settled, false, 'close must retain setup and late native cleanup before the factory returns');
    nativeClosed.resolve(); await retained;
    assert.equal(f.bus.snapshot().rawPending, 0); assert.equal(f.bus.snapshot().cleanupPending, 0); assert.equal(f.bus.snapshot().listeners, 0);
    assert.equal(f.original.stopped, 0); assert.equal(f.cloned.stopped, 1);
  } finally { nativeClosed.resolve(); await f.close(); }
});
for (const cause of ['now', 'source-facts'] as const) test(`owner revocation during ${cause} source admission leaves no issued handle or registrations`, async () => {
  let revoke = () => {};
  const f = fixture(cause === 'now' ? { now() { revoke(); return 100; } } : {}); revoke = () => f.owner.abort();
  if (cause === 'source-facts') { const settings = f.original.getSettings.bind(f.original); f.original.getSettings = () => { revoke(); return settings(); }; }
  const registrations = new Set<Parameters<typeof f.runtime.unregister>[0]>(), register = f.runtime.registerSource.bind(f.runtime), unregister = f.runtime.unregister.bind(f.runtime);
  f.runtime.registerSource = input => { const handle = register(input); registrations.add(handle); return handle; };
  f.runtime.unregister = handle => { const result = unregister(handle); if (result.ok) registrations.delete(handle); return result; };
  try {
    const handle = f.bus.registerSource({ sourceId: 'app:revoked-source', ownerPrincipalId: 'producer', producerNode: f.producerNode as unknown as MediaStreamAudioDestinationNode, stream: f.stream as unknown as MediaStream });
    assert.equal(handle, undefined, 'An aborted owner cannot receive a late source handle');
    assert.equal(f.bus.snapshot().sources, 0); assert.equal(f.bus.snapshot().listeners, 0); assert.equal(registrations.size, 0);
    assert.equal(f.contexts(), 0); assert.equal(f.original.stopped, 0);
  } finally { await f.close(); }
});


for (const role of ['source', 'output'] as const) test(`private audio rejects a previously accepted ${role} owner decision for a replacement output`, async t => {
  type Request = Parameters<BrowserApplicationAudioOptions['authorizeSource']>[0];
  type Decision = NonNullable<ReturnType<BrowserApplicationAudioOptions['authorizeSource']>>;
  let mode: 'fresh' | 'replay' = 'fresh', cached: Decision | undefined;
  const requests: Request[] = [];
  const approve = (request: Request): Decision => {
    const decision = { request, signal: new AbortController().signal, grant: { expiresAt: 1100, maxAgeMs: 250, maxHz: 20 } };
    if (request.role !== role || request.outputId !== 'app:replayed') return decision;
    requests.push(request);
    if (mode === 'replay') { assert.ok(cached); return cached; }
    cached = decision;
    return decision;
  };
  const f = fixture({ authorizeSource: approve, authorizeOutput: approve });
  try {
    const source = f.source(), incumbent = f.bind(source, 'app:incumbent');
    assert.equal(await incumbent.ready, true);
    const first = f.bind(source, 'app:replayed');
    assert.equal(await first.ready, true, 'The cached decision must first authorize an actual output');
    assert.ok(first.output()); assert.ok(cached); assert.equal(cached.request, requests[0]);
    const accepted = cached;
    first.stop();
    assert.equal(first.output(), undefined); assert.ok(incumbent.output());
    assert.equal(f.bus.snapshot().activeOutputs, 1);
    const gains = f.context.gains.length, outputs = f.context.outputs.length, edges = f.context.source.connections.size;
    mode = 'replay';
    const denied = f.bind(source, 'app:replayed');
    assert.equal(await denied.ready, false);
    assert.equal(denied.status().reason, 'denied'); assert.equal(denied.output(), undefined);
    assert.equal(requests.length, 2); assert.equal(cached, accepted);
    assert.notEqual(requests[1], accepted.request);
    assert.notEqual(requests[1]!.sink.registrationId, accepted.request.sink.registrationId);
    assert.deepEqual({ ...requests[1], sink: { ...requests[1]!.sink, registrationId: accepted.request.sink.registrationId } }, accepted.request,
      'The same textual application/session/owner/resource/profile tuple still requires the newly issued request and registration');
    assert.equal(f.context.gains.length, gains); assert.equal(f.context.outputs.length, outputs);
    assert.equal(f.context.source.connections.size, edges, 'A replay cannot create a new private native graph edge');
    assert.equal(f.contexts(), 1); assert.equal(f.bus.snapshot().activeOutputs, 1); assert.ok(incumbent.output());
    mode = 'fresh';
    const recovered = f.bind(source, 'app:replayed');
    assert.equal(await recovered.ready, true); assert.ok(recovered.output()); assert.notEqual(cached, accepted);
    assert.equal(requests.length, 3); assert.equal(cached!.request, requests[2]);
    assert.equal(f.context.gains.length, gains + 1); assert.equal(f.context.outputs.length, outputs + 1);
    assert.equal(f.context.source.connections.size, edges + 1); assert.equal(f.bus.snapshot().activeOutputs, 2);
    assert.equal(recovered.setVolume(0.5), true);
    assert.equal((f.context.gains.at(-1) as Node & { gain: { value: number } }).gain.value, 0.5);
    assert.equal(f.context.source.connections.has(f.context.destination), false);
    t.diagnostic(JSON.stringify({ role, cachedDecisionPreviouslyAccepted: true, replacementRequestDistinct: true,
      replacementSinkRegistrationDistinct: true, replayReady: false, replayNewGains: 0, replayNewOutputs: 0,
      replayNewEdges: 0, incumbentRetained: true, freshRecoveryReady: true, freshRecoveryGain: 0.5,
      scope: 'actual public client and SDK runtime; cooperative software graph, no native audio qualification' }));
  } finally {
    await f.close();
    const status = f.bus.snapshot();
    assert.equal(status.closed, true); assert.equal(status.activeOutputs, 0); assert.equal(status.rawPending, 0);
    assert.equal(status.cleanupPending, 0); assert.equal(status.listeners, 0); assert.equal(status.cleanupFailures, 0);
    assert.equal(status.pollArmed, false); assert.equal(status.expiryArmed, false);
    assert.equal(f.context.source.connections.size, 0); assert.equal(f.context.closes, 1);
    assert.equal(f.original.stopped, 0); assert.equal(f.cloned.stopped, 1);
    assert.ok(f.context.outputs.every(output => output.stream.tracks.every(track => track.stopped === 1)));
    t.diagnostic(JSON.stringify({ role, closed: true, pending: 0, listeners: 0, timersArmed: false,
      ownedEdges: 0, borrowedProducerTrackStopped: 0, ownedTracksStopped: true }));
  }
});
