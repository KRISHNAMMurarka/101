import { createDeviceRuntime, createMediaSynchronizationController, MEDIA_SYNCHRONIZATION_PROFILE } from '@101/connect';
import type { AuthorizationRequest, Connection, DeviceDescriptor, JsonObject, MediaSynchronizationEffectContext, ResourceReference } from '@101/connect';

export interface MediaSynchronizationExampleOptions {
  readonly ownerSignal: AbortSignal;
  readonly now?: () => number;
  /** Trusted local fixture observer. It supplies no consent. */
  readonly beforeApproval?: (request: Readonly<AuthorizationRequest>) => void;
  readonly beforeEffect?: () => void;
}
type Role = 'audio' | 'video';
type Owner = 'source' | 'sink';
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
function live(signal: AbortSignal) { try { return nativeAborted.call(signal) === false; } catch { return false; } }
const roles = ['audio', 'video'] as const;

/** Fixed owned PCM generation and raster retrieval events. No speaker, physical capture or scanout synchronization. */
export function createMediaSynchronizationExample(container: HTMLElement, options: MediaSynchronizationExampleOptions) {
  if (!(container instanceof HTMLElement) || !options || typeof options !== 'object') throw new TypeError('An owned output container is required');
  const owner = options.ownerSignal, now = options.now ?? (() => performance.now()), beforeApproval = options.beforeApproval, beforeEffect = options.beforeEffect;
  try { nativeAborted.call(owner); } catch { throw new TypeError('A native owner AbortSignal is required'); }
  if (typeof now !== 'function' || beforeApproval !== undefined && typeof beforeApproval !== 'function' || beforeEffect !== undefined && typeof beforeEffect !== 'function')
    throw new TypeError('Invalid software media caller');
  const nativeNow = () => { const at = now(); if (!Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid software media clock'); return at; };
  const startedAt = nativeNow(), expiresAt = startedAt + 30000;
  const approvals: Record<Role, Record<Owner, AbortController | undefined>> = { audio: { source: undefined, sink: undefined }, video: { source: undefined, sink: undefined } };
  const displayClockId = 'example-media-display-events', offsets = { audio: 1000, video: 2000 };
  let stopped = false, starting = false, started = false, sampleSequence = 0, painted = 0, pendingRenders = 0, pendingExchanges = 0, pendingAudio = 0;
  let init: Promise<boolean> | undefined;
  let raf: number | undefined, stopPromise: Promise<void> | undefined;
  let audioBuffer: AudioBuffer | undefined, audioRms = 0, lifecycle = 1;
  let observer: (() => void) | undefined;
  const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = 32; sourceCanvas.height = 18;
  const output = document.createElement('canvas'); output.width = 32; output.height = 18;
  output.setAttribute('aria-label', 'Paired software event marker and PCM level');
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Software events are unsynchronized. Native capture and scanout clocks are unknown.';
  let lastSoftwareSkew: Readonly<{ earliestMs: number; latestMs: number }> | null = null;
  const pending: Array<{ context: MediaSynchronizationEffectContext; value: number; level: number; skew: Readonly<{ earliestMs: number; latestMs: number }>; resolve: () => void; epoch: number }> = [];
  const channels = { audio: new MessageChannel(), video: new MessageChannel() };
  const exchange: Partial<Record<Role, { sequence: number; epoch: number; sentAt: number; resolve: (ok: boolean) => void }>> = {};
  const remove: Array<() => void> = [];
  function allOwners() { return live(owner) && roles.every(role => live(approvals[role].source?.signal as AbortSignal) && live(approvals[role].sink?.signal as AbortSignal)); }
  function current() { return !stopped && allOwners(); }
  const descriptor = (id: string, sink = false): DeviceDescriptor => ({ schemaVersion: 1, id, label: 'Application software media event', revision: 1,
    adapter: { id: 'example:software-media-events', version: '1.0.0' }, runtime: { platform: 'web' }, capabilities: [{ id: 'event',
      semantic: 'example:software-media-observation', schemaVersion: 1, kind: sink ? 'property' : 'sample', value: { type: 'scalar', unit: '1', min: 0, max: 255 },
      delivery: { mode: 'latest', maxHz: 30, maxAgeMs: 100 }, permissions: [sink ? 'write' : 'subscribe'], ...(sink ? { ownership: { mode: 'exclusive' as const } } : {}) }] });
  const runtime = createDeviceRuntime({ clockDomain: displayClockId, now: nativeNow, maxRoutes: 2, maxRegistrations: 4,
    maxPendingDeliveries: 2, maxPendingDeliveriesPerScope: 2, authorize(request) {
      const role = roles.find(role => request.source.registrationId === sources[role].id && request.sink.registrationId === sinks[role].id);
      if (!role || request.source.deviceId !== 'media-' + role || request.source.capabilityId !== 'event' || request.source.descriptorRevision !== 1 || request.source.schemaVersion !== 1 ||
        request.sink.deviceId !== 'media-' + role + '-output' || request.sink.capabilityId !== 'event' || request.sink.descriptorRevision !== 1 || request.sink.schemaVersion !== 1 ||
        request.sourceOperation !== 'subscribe' || request.sinkOperation !== 'write' || request.partition !== undefined ||
        request.principalId !== 'local-media-owner' || request.applicationId !== 'software-media-sync' || request.sessionId !== 'owned') return undefined;
      beforeApproval?.(request);
      const at = nativeNow();
      return current() && at < expiresAt ? { expiresAt, maxAgeMs: 100, maxHz: 30 } : undefined;
    } });
  const sources = { audio: runtime.registerSource({ device: descriptor('media-audio'), capability: 'event' }),
    video: runtime.registerSource({ device: descriptor('media-video'), capability: 'event' }) };
  const sinks = { audio: runtime.registerSink({ device: descriptor('media-audio-output', true), capability: 'event',
    apply: (observation, context) => controller?.offer('audio', observation, context), release: () => { controller?.reset(); clear(); } }),
    video: runtime.registerSink({ device: descriptor('media-video-output', true), capability: 'event',
      apply: (observation, context) => controller?.offer('video', observation, context), release: () => { controller?.reset(); clear(); } }) };
  for (const handle of [...Object.values(sources), ...Object.values(sinks)]) runtime.setReadiness(handle, 'available');
  const routes: Record<Role, Connection> = { audio: runtime.route({ from: sources.audio, to: sinks.audio, principalId: 'local-media-owner', applicationId: 'software-media-sync', sessionId: 'owned', leaseMs: 500, queueCapacity: 1 }),
    video: runtime.route({ from: sources.video, to: sinks.video, principalId: 'local-media-owner', applicationId: 'software-media-sync', sessionId: 'owned', leaseMs: 500, queueCapacity: 1 }) };
  function clear() { output.getContext('2d')?.clearRect(0, 0, output.width, output.height); }
  const reference = (role: Role): ResourceReference => ({ registrationId: sources[role].id, deviceId: 'media-' + role, capabilityId: 'event', descriptorRevision: 1, schemaVersion: 1 });
  const controller = createMediaSynchronizationController({ ownerSignal: owner, displayClockId, now: nativeNow,
    audio: { source: reference('audio'), routeId: routes.audio.id, clockId: 'example-audio-events' },
    video: { source: reference('video'), routeId: routes.video.id, clockId: 'example-video-events' },
    onPair(pair, context) {
      if (!current() || !context.isCurrent() || !current() || pending.length) return;
      pendingRenders++;
      return new Promise<void>(resolve => { pending.push({ context, value: pair.videoValue, level: pair.audioValue, skew: pair.skew, resolve, epoch: lifecycle }); });
    } });
  function effectCurrent(context: MediaSynchronizationEffectContext, epoch: number) {
    const observed = context.isCurrent(); const at = nativeNow();
    return observed && at < expiresAt && epoch === lifecycle && current() && live(context.signals.owner) && live(context.signals.audio) && live(context.signals.video);
  }
  function render() {
    raf = undefined;
    if (stopped) return;
    try {
      const at = nativeNow(); if (!current() || at >= expiresAt) { void stop(); return; }
      for (const route of Object.values(routes)) { if (route.status().state === 'active' && !route.renew('local-media-owner').ok) { void stop(); return; } }
      runtime.flush(); controller!.tick();
      const task = pending.shift();
      if (task) {
        try {
          beforeEffect?.(); const paint = output.getContext('2d');
          if (paint && effectCurrent(task.context, task.epoch)) {
            paint.fillStyle = `rgb(${task.value},${task.value},${task.value})`;
            if (effectCurrent(task.context, task.epoch)) paint.fillRect(0, 0, 32, 18);
            if (effectCurrent(task.context, task.epoch)) { paint.fillStyle = '#fff'; paint.fillRect(0, 14, Math.round(task.level / 255 * 32), 4); }
            if (effectCurrent(task.context, task.epoch)) { painted++; lastSoftwareSkew = task.skew; } else clear();
          }
        } finally { pendingRenders--; task.resolve(); }
      }
      const state = controller!.snapshot();
      status.textContent = state.state === 'aligned-software-observations' ? 'Software event intervals fit the declared skew budget. Native capture and scanout remain unknown.' :
        state.state === 'recovering' ? 'Recovering with three fresh software event pairs. Native clocks remain unknown.' : 'Software events are unsynchronized. Native capture and scanout clocks are unknown.';
      if (state.state === 'closed') { void stop(); return; }
    } catch { void stop(); return; }
    if (!stopped) raf = requestAnimationFrame(render);
  }
  for (const role of roles) {
    const sourcePort = channels[role].port1, displayPort = channels[role].port2;
    const receivePing = (event: MessageEvent) => {
      const input = event.data;
      if (!current() || !input || input.kind !== 'ping' || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.sequence > 32 || !Number.isSafeInteger(input.epoch)) return;
      const captured = lifecycle, receivedAt = nativeNow() + offsets[role], sentAt = nativeNow() + offsets[role];
      if (current() && captured === lifecycle) sourcePort.postMessage({ kind: 'pong', sequence: input.sequence, epoch: input.epoch, receivedAt, sentAt });
    };
    const receivePong = (event: MessageEvent) => {
      const input = event.data, selected = exchange[role];
      if (!selected || !input || input.kind !== 'pong' || input.sequence !== selected.sequence || input.epoch !== selected.epoch) return;
      delete exchange[role]; pendingExchanges--;
      const receivedAt = nativeNow();
      const accepted = current() && controller!.observeClock(role, selected.epoch, { localSentAt: selected.sentAt,
        remoteReceivedAt: input.receivedAt, remoteSentAt: input.sentAt, localReceivedAt: receivedAt });
      selected.resolve(accepted);
    };
    sourcePort.addEventListener('message', receivePing); displayPort.addEventListener('message', receivePong); sourcePort.start(); displayPort.start();
    remove.push(() => { sourcePort.removeEventListener('message', receivePing); displayPort.removeEventListener('message', receivePong); sourcePort.close(); displayPort.close(); });
  }
  let exchangeSequence = 0;
  async function mapClocks() {
    if (!current() || pendingExchanges || controller!.snapshot().exchanges + 2 > 32) return false;
    const epoch = controller!.snapshot().epoch;
    const results = roles.map(role => {
      pendingExchanges++;
      return new Promise<boolean>(resolve => {
        const selected = { sequence: ++exchangeSequence, epoch, sentAt: 0, resolve };
        exchange[role] = selected;
        selected.sentAt = nativeNow();
        if (current() && exchange[role] === selected) channels[role].port2.postMessage({ kind: 'ping', sequence: selected.sequence, epoch, sentAt: selected.sentAt });
        else if (exchange[role] === selected) { delete exchange[role]; pendingExchanges--; resolve(false); }
      });
    });
    return (await Promise.all(results)).every(Boolean) && current();
  }
  const expiry = setTimeout(() => { void stop(); }, 30000);
  function ownerAbort() { void stop(); }
  EventTarget.prototype.addEventListener.call(owner, 'abort', ownerAbort, { once: true });
  async function stop() {
    if (stopPromise) return stopPromise;
    let settled!: () => void, failed!: (error: unknown) => void;
    stopPromise = new Promise<void>((resolve, reject) => { settled = resolve; failed = reject; });
    stopped = true; lifecycle++; started = false; clearTimeout(expiry);
    if (raf !== undefined) { cancelAnimationFrame(raf); raf = undefined; }
    EventTarget.prototype.removeEventListener.call(owner, 'abort', ownerAbort);
    runtime.close(); for (const detach of remove.splice(0)) detach();
    for (const role of roles) { const selected = exchange[role]; delete exchange[role]; if (selected) { pendingExchanges--; selected.resolve(false); } }
    for (const task of pending.splice(0)) { pendingRenders--; task.resolve(); }
    output.remove(); status.remove(); clear(); sourceCanvas.width = sourceCanvas.height = 1;
    void (async () => { await init; await controller!.close(); if (audioBuffer) { audioBuffer.getChannelData(0).fill(0); audioBuffer = undefined; }
      pendingAudio = 0; starting = false; })().then(settled, failed);
    return stopPromise;
  }
  function start() {
    if (stopped || starting || started || !current()) return Promise.resolve(false);
    starting = true; const captured = lifecycle;
    init = (async () => {
      try {
        if (typeof OfflineAudioContext !== 'function') return false;
        if (!roles.every(role => routes[role].start().ok) || !current() || captured !== lifecycle) return false;
        const offline = new OfflineAudioContext(1, 256, 48000);
        if (!current() || captured !== lifecycle) return false;
        const source = offline.createBufferSource();
        if (!current() || captured !== lifecycle) return false;
        const input = offline.createBuffer(1, 256, 48000);
        if (!current() || captured !== lifecycle) { source.disconnect(); return false; }
        const inputSamples = input.getChannelData(0);
        if (!current() || captured !== lifecycle) { inputSamples.fill(0); source.disconnect(); return false; }
        inputSamples.fill(0.25); source.buffer = input;
        if (!current() || captured !== lifecycle) { inputSamples.fill(0); source.buffer = null; source.disconnect(); return false; }
        source.connect(offline.destination);
        if (!current() || captured !== lifecycle) { inputSamples.fill(0); source.buffer = null; source.disconnect(); return false; }
        source.start();
        if (!current() || captured !== lifecycle) { inputSamples.fill(0); source.buffer = null; source.disconnect(); return false; }
        pendingAudio++;
        try { const rendered = await offline.startRendering(); if (!current() || captured !== lifecycle) { rendered.getChannelData(0).fill(0); return false; }
          const samples = rendered.getChannelData(0); if (!current() || captured !== lifecycle) { samples.fill(0); return false; }
          audioBuffer = rendered; let sum = 0; for (let index = 0; index < samples.length; index++) sum += samples[index]! ** 2;
          audioRms = Math.sqrt(sum / samples.length);
        } finally { pendingAudio--; input.getChannelData(0).fill(0); source.disconnect(); source.buffer = null; }
        if (!current() || captured !== lifecycle || !await mapClocks() || !current() || captured !== lifecycle) return false;
        container.append(output, status);
        if (!current() || captured !== lifecycle) { output.remove(); status.remove(); return false; }
        started = true; raf = requestAnimationFrame(render); return true;
      } finally { starting = false; }
    })();
    return init;
  }
  return Object.freeze({
    setConsent(role: Role, side: Owner, allowed: boolean) {
      if (stopped || !roles.includes(role) || !['source', 'sink'].includes(side) || typeof allowed !== 'boolean') return false;
      const old = approvals[role][side]; if (old && live(old.signal)) { if (allowed) return true; old.abort(); }
      approvals[role][side] = allowed ? new AbortController() : undefined;
      if (!allowed) { runtime.revoke(routes[role]); controller!.reset(); clear(); }
      return true;
    },
    start, mapClocks,
    sample(options: { readonly skewMs?: number; readonly nativeClockUnknown?: boolean; readonly onlyAudio?: boolean } = {}) {
      if (!started || !current() || sampleSequence >= 64) return false;
      const skew = options.skewMs ?? 0;
      if (!Number.isFinite(skew) || skew < 0 || skew > 40) return false;
      observer?.(); const at = nativeNow(), captured = lifecycle;
      if (!current() || captured !== lifecycle || at >= expiresAt) return false;
      const paint = sourceCanvas.getContext('2d'); if (!paint) return false;
      paint.fillStyle = '#e6e6e6'; paint.fillRect(0, 0, 32, 18);
      if (!current() || captured !== lifecycle) return false;
      const value = paint.getImageData(0, 0, 1, 1).data[0]!;
      if (!current() || captured !== lifecycle) return false;
      const seq = ++sampleSequence, epoch = controller!.snapshot().epoch;
      for (const role of roles) {
        if (options.onlyAudio && role === 'video') continue;
        const provenance: JsonObject = options.nativeClockUnknown ? { captureTimeKnown: false, clockMappingEstablished: false } : {
          sync: { profile: MEDIA_SYNCHRONIZATION_PROFILE, epoch, basis: 'software-observation', clockId: 'example-' + role + '-events', at: at + offsets[role] - (role === 'audio' ? skew : 0) } };
        if (!current() || captured !== lifecycle || !runtime.publish(sources[role], role === 'audio' ? Math.round(audioRms * 255) : value,
          { sequence: seq, timestamp: at, clockDomain: displayClockId, provenance }).ok) return false;
      }
      runtime.flush(); return current();
    },
    /** Trusted fixture instrumentation observes a callback; it cannot establish permission or a clock mapping. */
    observeSample(callback: (() => void) | undefined) { if (callback !== undefined && typeof callback !== 'function') throw new TypeError('Invalid observer'); observer = callback; },
    snapshot() { return Object.freeze({ synchronization: controller!.snapshot(), painted, lastSoftwareSkew, pendingRenders, pendingExchanges, pendingAudio, started, stopped,
      nativePcm: audioBuffer ? { frames: audioBuffer.length, sampleRate: audioBuffer.sampleRate, rms: audioRms } : null,
      nativePcmCaptureMapping: 'unknown', callerVideoPtsMapping: 'unknown', physicalScanoutMapping: 'unknown', ports: stopped ? 0 : 4, timers: stopped ? 0 : 1, raf: raf === undefined ? 0 : 1 }); },
    stop,
  });
}
