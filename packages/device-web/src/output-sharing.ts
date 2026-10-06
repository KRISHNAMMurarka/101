import { parseDeviceDescriptor } from '@101/device-model';
import { createOutputSharingController } from '@101/device-runtime';
import type { DeviceDescriptor, JsonValue } from '@101/device-model';
import type { DeliveryContext, DeviceRuntime, EndpointHandle, Observation, OutputSharingController, OutputSharingDestination,
  OutputSharingEffectContext, OutputSharingKind, OutputSharingOptions, OutputSharingPolicy, OutputSharingResult, OutputSharingRoute, OutputSharingSource } from '@101/device-runtime';

export interface BrowserOutputSharingSource extends OutputSharingSource {
  readonly kind: OutputSharingKind; readonly signal: AbortSignal;
  /** Trusted current private native stream accessor. Its independent producer/output approvals remain required. */
  readonly audio?: () => MediaStream | undefined;
  /** Trusted upstream projection context observer. Revocation must also abort signal; strings are not provenance. */
  readonly upstream?: () => boolean;
}
export interface BrowserOutputSharingDestination {
  readonly id: string; readonly ownerId: string; readonly kind: OutputSharingKind;
  /** Borrowed container; only SDK-created children are removed. Camera slots are separate read-only observers. */
  readonly container?: HTMLElement;
}
export interface BrowserOutputSharingEnvironment {
  /** Explicit cooperative software seam. Doubles do not qualify native audio/raster effects. */
  readonly createAudioContext: () => AudioContext; readonly createCanvas: () => HTMLCanvasElement;
}
export interface BrowserOutputSharingOptions {
  readonly runtime: DeviceRuntime; readonly ownerSignal: AbortSignal; readonly applicationId: string; readonly sessionId: string; readonly now: () => number;
  readonly sources: readonly BrowserOutputSharingSource[]; readonly destinations: readonly BrowserOutputSharingDestination[];
  readonly authorizePolicy: OutputSharingOptions['authorizePolicy']; readonly authorizeSource: OutputSharingOptions['authorizeSource']; readonly authorizeSink: OutputSharingOptions['authorizeSink'];
  readonly environment?: BrowserOutputSharingEnvironment;
}
export interface BrowserOutputSharingSnapshot {
  readonly closed: boolean; readonly routes: number; readonly rawPending: number; readonly cleanupFailures: number;
  readonly providerPending: number; readonly ownedCanvases: number; readonly ownedContexts: number; readonly ownedTracks: number; readonly effects: number; readonly failures: number;
}
export interface BrowserOutputSharing {
  readonly controller: OutputSharingController;
  select(destinationId: string, expectedRevision: number, policy: OutputSharingPolicy): OutputSharingResult<number>;
  /** Starts the exact reviewed slots. A failed fresh admission releases this plan; it never restores old authority. */
  start(destinationId: string): boolean;
  output(destinationId: string): MediaStream | undefined;
  sweep(): void; snapshot(): BrowserOutputSharingSnapshot; close(): Promise<void>;
}
interface Source { spec: BrowserOutputSharingSource; descriptor: DeviceDescriptor }
interface Bank { observation: Observation; context: DeliveryContext; route: OutputSharingRoute; source: Source; frame?: JsonValue }
interface Output {
  spec: BrowserOutputSharingDestination; sinks: EndpointHandle[]; routes: Map<'a' | 'b', OutputSharingRoute>; banks: Map<'a' | 'b', Bank>;
  canvases: Map<'a' | 'b', HTMLCanvasElement>; staging: Map<'a' | 'b', HTMLCanvasElement>; composition?: HTMLCanvasElement;
  context?: AudioContext; nodes: Map<'a' | 'b', MediaStreamAudioSourceNode>; gains: Map<'a' | 'b', GainNode>; streams: Map<'a' | 'b', MediaStream>;
  destination?: MediaStreamAudioDestinationNode; tracks: MediaStreamTrack[]; opening?: Promise<void>; closing?: Promise<void>; revision: number;
}
const ownedContainers = new WeakMap<HTMLElement, object>();
const abortRead = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
function live(signal: unknown): signal is AbortSignal { try { return abortRead.call(signal) === false; } catch { return false; } }
function fields(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new TypeError('Plain output policy data required');
  const result: Record<string, unknown> = Object.create(null), keys = Reflect.ownKeys(input);
  if (keys.length > required.length + optional.length) throw new TypeError('Bounded output policy fields required');
  for (const key of keys) { if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) throw new TypeError('Closed output policy fields required');
    const property = Object.getOwnPropertyDescriptor(input, key); if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw new TypeError('Output policy data fields required'); result[key] = property.value; }
  if (required.some(key => !Object.hasOwn(result, key))) throw new TypeError('Missing output policy field'); return result;
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function audioValue(value: unknown): boolean { try { const record = fields(value, ['running', 'generation', 'sampleRateHz', 'channels']);
  return record.running === true && Number.isSafeInteger(record.generation) && (record.generation as number) > 0 && record.sampleRateHz === 48000 && record.channels === 2; } catch { return false; } }
function projected(value: unknown): Readonly<{ shade: number; alpha: number }> | undefined {
  try { const record = fields(value, ['shade', 'alpha']); if (typeof record.shade !== 'number' || !Number.isInteger(record.shade) || record.shade < 0 || record.shade > 255 || typeof record.alpha !== 'number' || !Number.isFinite(record.alpha) || record.alpha < 0 || record.alpha > 1) return;
    return Object.freeze({ shade: record.shade, alpha: record.alpha }); } catch { return; }
}
function rgba(value: unknown): Uint8ClampedArray<ArrayBuffer> | undefined {
  try { const frame = fields(value, ['format', 'width', 'height', 'rows']); if (frame.format !== 'rgba8' || frame.width !== 8 || frame.height !== 8 || !Array.isArray(frame.rows) || frame.rows.length !== 8) return;
    const bytes = new Uint8ClampedArray(256); for (let row = 0; row < 8; row++) { const values: unknown = frame.rows[row];
      if (!Array.isArray(values) || values.length !== 32 || Reflect.ownKeys(values).length !== 33) return;
      for (let index = 0; index < 32; index++) { const property = Object.getOwnPropertyDescriptor(values, String(index)), value: unknown = property?.value;
        if (!property?.enumerable || !Object.hasOwn(property, 'value') || typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) return; bytes[row * 32 + index] = value; } }
    return bytes; } catch { return; }
}

/** Local private graphs and fixed raster output slots. The host, accessors and projection code are trusted.
 * Observer policy never opens, selects, switches or controls a camera. No speaker connection, pixel capture
 * permission, transport/clock mapping or malicious same-origin isolation is established here. */
export function createBrowserOutputSharing(input: BrowserOutputSharingOptions): BrowserOutputSharing {
  const options = fields(input, ['runtime', 'ownerSignal', 'applicationId', 'sessionId', 'now', 'sources', 'destinations', 'authorizePolicy', 'authorizeSource', 'authorizeSink'], ['environment']);
  if (!live(options.ownerSignal) || !id(options.applicationId) || !id(options.sessionId) || !Array.isArray(options.sources) || options.sources.length < 1 || options.sources.length > 8 ||
      !Array.isArray(options.destinations) || options.destinations.length < 1 || options.destinations.length > 4) throw new TypeError('Bounded explicit output owners required');
  const runtime = options.runtime as DeviceRuntime, owner = options.ownerSignal, sources = new Map<string, Source>(), outputs = new Map<string, Output>(), ownerToken = {};
  const supplied = options.environment as BrowserOutputSharingEnvironment | undefined;
  const environment = supplied ? fields(supplied, ['createAudioContext', 'createCanvas']) : { createAudioContext: () => new AudioContext({ sampleRate: 48000 }), createCanvas: () => document.createElement('canvas') };
  if (typeof environment.createAudioContext !== 'function' || typeof environment.createCanvas !== 'function') throw new TypeError('Trusted native factories required');
  const makeAudio = environment.createAudioContext as () => AudioContext, makeCanvas = environment.createCanvas as () => HTMLCanvasElement;
  const detachers: Array<() => void> = [], raw = new Map<object, Promise<void>>(), retiring = new Map<AudioContext, Output>(), ownedContexts = new Set<AudioContext>();
  let closed = false, constructing = true, cleanupFailures = 0, effects = 0, failures = 0, closePromise: Promise<void> | undefined;
  let controller!: OutputSharingController;
  function native(issue: () => Promise<void>): Promise<void> {
    if (raw.size + (controller?.snapshot().rawPending ?? 0) >= 2) return Promise.reject(new Error('Native settlement capacity'));
    const reservation = {}; let done!: () => void; const settled = new Promise<void>(resolve => { done = resolve; }); raw.set(reservation, settled);
    let promise: Promise<void>; try { promise = issue(); } catch (error) { raw.delete(reservation); done(); drainClose(); return Promise.reject(error); }
    return Promise.resolve(promise).finally(() => { raw.delete(reservation); done(); drainClose(); });
  }
  function drainClose() {
    while (raw.size + (controller?.snapshot().rawPending ?? 0) < 2 && retiring.size) { const first = retiring.entries().next().value as [AudioContext, Output] | undefined; if (!first) return;
      const [context, output] = first; retiring.delete(context); const close = native(() => context.close()); output.closing = close;
      void close.catch(() => { cleanupFailures++; }).finally(() => { if (context.state === 'closed') ownedContexts.delete(context); else cleanupFailures++;
        if (output.closing === close) output.closing = undefined; }); }
  }
  function sourceLive(source: Source): boolean { return !closed && live(owner) && live(source.spec.signal); }
  function clearRaster(output: Output) {
    for (const canvas of output.canvases.values()) { try { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); canvas.remove(); canvas.width = canvas.height = 1; } catch { cleanupFailures++; } }
    for (const canvas of output.staging.values()) { canvas.width = canvas.height = 1; } output.canvases.clear(); output.staging.clear();
    if (output.composition) { output.composition.width = output.composition.height = 1; output.composition = undefined; }
  }
  function retireGraph(output: Output) {
    for (const node of output.nodes.values()) { try { node.disconnect(); } catch { cleanupFailures++; } } output.nodes.clear(); output.streams.clear();
    for (const gain of output.gains.values()) { try { gain.gain.value = 0; gain.disconnect(); } catch { cleanupFailures++; } } output.gains.clear();
    for (const track of output.tracks.splice(0)) { try { track.stop(); } catch { cleanupFailures++; } }
    if (output.destination) { try { output.destination.disconnect(); } catch { cleanupFailures++; } output.destination = undefined; }
    const context = output.context; output.context = undefined;
    if (context) { retiring.set(context, output); drainClose(); }
  }
  function releaseSlot(output: Output, key: 'a' | 'b') { output.banks.delete(key); output.routes.delete(key);
    const node = output.nodes.get(key), gain = output.gains.get(key); if (node) { try { node.disconnect(); } catch { cleanupFailures++; } } output.nodes.delete(key); output.streams.delete(key);
    if (gain) { try { gain.gain.value = 0; gain.disconnect(); } catch { cleanupFailures++; } } output.gains.delete(key);
    if (output.spec.kind === 'camera') { const visible = output.canvases.get(key), stage = output.staging.get(key);
      if (visible) { visible.remove(); visible.width = visible.height = 1; output.canvases.delete(key); } if (stage) { stage.width = stage.height = 1; output.staging.delete(key); } }
    else if (output.spec.kind === 'application') clearRaster(output);
    if (!output.routes.size) { retireGraph(output); clearRaster(output); } }
  function upstream(source: Source): boolean { if (!sourceLive(source)) return false; let current = true;
    try { if (source.spec.upstream) current = source.spec.upstream(); } catch { current = false; } return current && sourceLive(source); }
  function selectedBanks(output: Output): Bank[] {
    const plan = controller.plan(output.spec.id); if (!plan || plan.revision !== output.revision) return [];
    const banks: Bank[] = []; for (const input of plan.policy.inputs) { const bank = output.banks.get(input.slotId);
      if (!bank || bank.source.spec.id !== input.sourceId || !sourceLive(bank.source) || !controller.current(bank.route, bank.context)) continue; banks.push(bank); }
    if (output.spec.kind === 'audio' && !output.destination && banks.length !== plan.policy.inputs.length) return [];
    return banks;
  }
  function nativeFacts(output: Output, banks: Bank[]): boolean {
    if (closed || !live(owner) || output.context?.state === 'closed') return false;
    for (const bank of banks) if (!upstream(bank.source)) return false;
    // Final intrinsic source signals after all trusted upstream callbacks.
    return banks.every(bank => sourceLive(bank.source) && live(bank.context.signal));
  }
  function canvas(output: Output, key: 'a' | 'b', staging = false): HTMLCanvasElement {
    const cache = staging ? output.staging : output.canvases; let value = cache.get(key); if (value) return value;
    value = makeCanvas(); value.width = output.spec.kind === 'camera' ? 8 : 32; value.height = output.spec.kind === 'camera' ? 8 : 16;
    if (!value.getContext('2d')) throw new Error('Owned raster unavailable'); cache.set(key, value);
    if (!staging) { value.setAttribute('role', 'img'); value.setAttribute('aria-label', output.spec.kind === 'camera' ? 'Read-only camera observer ' + key : 'Application output');
      value.style.minHeight = '44px'; value.style.imageRendering = 'pixelated'; }
    return value;
  }
  async function audio(output: Output, banks: Bank[], guard: OutputSharingEffectContext) {
    if (output.closing || output.opening || retiring.size || !nativeFacts(output, banks) || !guard.isCurrent()) return;
    const nativeStreams = new Map<'a' | 'b', MediaStream>();
    for (const bank of banks) { if (!audioValue(bank.observation.value) || !bank.source.spec.audio) return;
      const stream = bank.source.spec.audio(); if (!(stream instanceof MediaStream)) return;
      const tracks = stream.getTracks(); if (tracks.length !== 1 || tracks[0]?.kind !== 'audio' || tracks[0]?.readyState !== 'live') return;
      nativeStreams.set(bank.route.slotId, stream); }
    if (!nativeFacts(output, banks) || !guard.isCurrent()) return;
    if (!output.context) {
      if (raw.size >= 2) return; const context = makeAudio(); ownedContexts.add(context); output.context = context;
      const rate = context.sampleRate; if (rate !== 48000 || !nativeFacts(output, banks) || !guard.isCurrent()) { retireGraph(output); return; }
      const opening = native(() => context.resume()); output.opening = opening;
      try { await opening; } finally { if (output.opening === opening) output.opening = undefined; }
      const state = context.state; if (output.context !== context || state !== 'running' || !nativeFacts(output, banks) || !guard.isCurrent()) { retireGraph(output); return; }
      const destination = context.createMediaStreamDestination(); output.destination = destination; output.tracks = destination.stream.getTracks();
      if (!nativeFacts(output, banks) || !guard.isCurrent() || output.tracks.length !== 1 || output.tracks[0]?.kind !== 'audio') { retireGraph(output); return; }
    }
    const context = output.context, destination = output.destination, policy = controller.plan(output.spec.id)?.policy;
    if (!context || !destination || policy?.kind !== 'audio' || !nativeFacts(output, banks) || !guard.isCurrent()) return;
    for (const bank of banks) { const key = bank.route.slotId, stream = nativeStreams.get(key)!;
      if (output.streams.get(key) && output.streams.get(key) !== stream) { retireGraph(output); return; }
      let gain = output.gains.get(key), node = output.nodes.get(key);
      if (!gain || !node) { gain = context.createGain(); output.gains.set(key, gain);
        if (!nativeFacts(output, banks) || !guard.isCurrent()) { retireGraph(output); return; }
        const muted = gain.gain; if (!nativeFacts(output, banks) || !guard.isCurrent()) { retireGraph(output); return; } muted.value = 0;
        if (!nativeFacts(output, banks) || !guard.isCurrent()) { retireGraph(output); return; }
        node = context.createMediaStreamSource(stream); output.nodes.set(key, node); output.streams.set(key, stream);
        if (!nativeFacts(output, banks) || !guard.isCurrent()) { retireGraph(output); return; } node.connect(gain);
        if (!nativeFacts(output, banks) || !guard.isCurrent()) { retireGraph(output); return; } gain.connect(destination); }
      const value = policy.mode === 'exclusive' ? 1 : policy.mode === 'duck' && key !== policy.foreground ? .125 : .5;
      const parameter = gain.gain; if (!nativeFacts(output, banks) || !guard.isCurrent()) { retireGraph(output); return; } parameter.value = value;
    }
    if (!nativeFacts(output, banks) || !guard.isCurrent()) { retireGraph(output); return; } effects++;
  }
  function raster(output: Output, banks: Bank[], guard: OutputSharingEffectContext) {
    if (!output.spec.container || ownedContainers.get(output.spec.container) !== ownerToken || !nativeFacts(output, banks) || !guard.isCurrent()) return;
    const policy = controller.plan(output.spec.id)?.policy; if (!policy) return;
    if (policy.kind === 'camera') {
      for (const bank of banks) { const bytes = rgba(bank.observation.value); if (!bytes) throw new Error('Closed camera frame required');
        const stage = canvas(output, bank.route.slotId, true), paint = stage.getContext('2d')!, image = new ImageData(bytes, 8, 8);
        if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } paint.putImageData(image, 0, 0);
        if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; }
        const visible = canvas(output, bank.route.slotId), screen = visible.getContext('2d')!;
        if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } screen.clearRect(0, 0, 8, 8); screen.drawImage(stage, 0, 0);
        if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } if (!visible.isConnected) output.spec.container.append(visible);
        if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } effects++; }
      return;
    }
    if (policy.kind !== 'application') return;
    let composition = output.composition; if (!composition) { composition = makeCanvas(); composition.width = 32; composition.height = 16; output.composition = composition; }
    const combined = composition.getContext('2d'); if (!combined) throw new Error('Owned staging unavailable'); combined.clearRect(0, 0, 32, 16);
    for (const bank of [...banks].sort((a, b) => a.route.slotId.localeCompare(b.route.slotId))) { const frame = projected(bank.observation.value); if (!frame) throw new Error('Closed projected frame required');
      const stage = canvas(output, bank.route.slotId, true), paint = stage.getContext('2d')!;
      if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } paint.clearRect(0, 0, 32, 16);
      if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } paint.fillStyle = `rgba(${frame.shade},${frame.shade},${frame.shade},${frame.alpha})`;
      if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } paint.fillRect(0, 0, 32, 16);
      if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; }
      if (policy.mode === 'regions') combined.drawImage(stage, 0, 0, 32, 16, bank.route.slotId === 'a' ? 0 : 16, 0, 16, 16);
      else combined.drawImage(stage, 0, 0); }
    if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; }
    const visible = canvas(output, 'a'), screen = visible.getContext('2d')!;
    if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } screen.clearRect(0, 0, 32, 16); screen.drawImage(composition, 0, 0);
    if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } if (!visible.isConnected) output.spec.container.append(visible);
    if (!nativeFacts(output, banks) || !guard.isCurrent()) { clearRaster(output); return; } effects++;
  }
  function receive(output: Output, key: 'a' | 'b', observation: Observation, context: DeliveryContext): void | Promise<void> {
    // One shared ceiling includes issued native operations and actual wrapping provider work. Refusal is synchronous.
    if (raw.size + controller.snapshot().rawPending >= 2) return;
    const route = output.routes.get(key), plan = controller.plan(output.spec.id), input = plan?.policy.inputs.find(input => input.slotId === key), source = input && sources.get(input.sourceId);
    if (!route || !source || !sourceLive(source) || !controller.current(route, context)) return;
    output.banks.set(key, { route, observation, context, source }); const banks = selectedBanks(output); if (!banks.length) return;
    const other = banks.find(bank => bank.route !== route), companion = other ? { route: other.route, context: other.context } : undefined;
    return controller.effect(route, context, async guard => { if (!nativeFacts(output, banks) || !guard.isCurrent()) return;
      if (output.spec.kind === 'audio') await audio(output, banks, guard); else raster(output, banks, guard); }, companion).finally(drainClose);
  }
  function borrowedAbort() { if (!constructing) void close(); }
  function sourceAbort(sourceId: string) { if (constructing) return; for (const output of outputs.values()) {
    const policy = controller.plan(output.spec.id)?.policy;
    for (const input of policy?.inputs ?? []) if (input.sourceId === sourceId) output.routes.get(input.slotId)?.connection.stop('source-owner-revoked'); } }
  try {
    for (const item of options.sources as unknown[]) { const value = fields(item, ['id', 'ownerId', 'handle', 'device', 'capability', 'kind', 'signal'], ['audio', 'upstream']);
      if (!id(value.id) || !live(value.signal) || !['audio', 'camera', 'application'].includes(value.kind as string) || sources.has(value.id) || value.audio !== undefined && typeof value.audio !== 'function' || value.upstream !== undefined && typeof value.upstream !== 'function') throw new TypeError('Explicit source classification required');
      const descriptor = parseDeviceDescriptor(value.device), capability = descriptor.capabilities.find(capability => capability.id === value.capability);
      if (!capability || value.kind === 'audio' && capability.semantic !== 'app:private-audio-gate/1' || value.kind === 'camera' && capability.semantic !== 'media:camera-rgba8/1' || value.kind === 'application' && capability.semantic !== 'connect:application-view') throw new TypeError('Supported native producer schema required');
      const spec = Object.freeze({ ...value }) as unknown as BrowserOutputSharingSource; sources.set(spec.id, { spec, descriptor });
      const abort = () => sourceAbort(spec.id); add.call(spec.signal, 'abort', abort, { once: true }); detachers.push(() => remove.call(spec.signal, 'abort', abort)); }
    const destinationSpecs: OutputSharingDestination[] = [];
    for (const item of options.destinations as unknown[]) { const value = fields(item, ['id', 'ownerId', 'kind'], ['container']);
      if (!id(value.id) || !id(value.ownerId) || !['audio', 'camera', 'application'].includes(value.kind as string) || outputs.has(value.id)) throw new TypeError('Explicit output required');
      const source = [...sources.values()].find(source => source.spec.kind === value.kind); if (!source) throw new TypeError('A matching enrolled source required');
      const spec = Object.freeze({ ...value }) as unknown as BrowserOutputSharingDestination;
      if (spec.kind !== 'audio') { const container = spec.container, native = container?.ownerDocument.defaultView?.HTMLElement;
        if (!container || !native || !(container instanceof native) || ownedContainers.has(container)) throw new TypeError('An unused native output container required'); ownedContainers.set(container, ownerToken); }
      const output: Output = { spec, sinks: [], routes: new Map(), banks: new Map(), canvases: new Map(), staging: new Map(), nodes: new Map(), gains: new Map(), streams: new Map(), tracks: [], revision: 0 };
      outputs.set(spec.id, output); const slots: OutputSharingDestination['slots'][number][] = [];
      for (const key of ['a', 'b'] as const) { const capability = source.descriptor.capabilities.find(capability => capability.id === source.spec.capability)!;
        const device = parseDeviceDescriptor({ ...source.descriptor, id: `sharing:${spec.id}-${key}`, label: 'Approved local output slot', capabilities: [{ ...capability, permissions: ['write'], ownership: { mode: 'observe' } }] });
        const sink = runtime.registerSink({ device, capability: capability.id, apply: (observation, context) => receive(output, key, observation, context), release: () => releaseSlot(output, key) });
        output.sinks.push(sink); runtime.setReadiness(sink, 'available'); slots.push({ id: key, handle: sink, device, capability: capability.id }); }
      destinationSpecs.push({ id: spec.id, ownerId: spec.ownerId, kind: spec.kind, slots }); }
    controller = createOutputSharingController({ runtime, ownerSignal: owner, applicationId: options.applicationId as string, sessionId: options.sessionId as string, now: options.now as () => number,
      sources: [...sources.values()].map(({ spec }) => ({ id: spec.id, ownerId: spec.ownerId, handle: spec.handle, device: spec.device, capability: spec.capability })), destinations: destinationSpecs,
      authorizePolicy: options.authorizePolicy as OutputSharingOptions['authorizePolicy'], authorizeSource: options.authorizeSource as OutputSharingOptions['authorizeSource'], authorizeSink: options.authorizeSink as OutputSharingOptions['authorizeSink'] });
    constructing = false; if (!live(owner) || [...sources.values()].some(source => !sourceLive(source))) void close();
    add.call(owner, 'abort', borrowedAbort, { once: true }); detachers.push(() => remove.call(owner, 'abort', borrowedAbort));
  } catch (error) { closed = true; for (const detach of detachers.splice(0)) detach(); for (const output of outputs.values()) {
    for (const sink of output.sinks) runtime.unregister(sink); if (output.spec.container && ownedContainers.get(output.spec.container) === ownerToken) ownedContainers.delete(output.spec.container); } throw error; }
  function select(destinationId: string, revision: number, policy: OutputSharingPolicy): OutputSharingResult<number> {
    const output = outputs.get(destinationId); if (!output || closed) return Object.freeze({ ok: false, reason: 'closed' });
    const result = controller.select(destinationId, revision, policy); if (result.ok) { output.revision = result.value; retireGraph(output); clearRaster(output); } return result;
  }
  function start(destinationId: string): boolean {
    const output = outputs.get(destinationId), plan = controller.plan(destinationId); if (closed || !output || !plan || plan.revision !== output.revision || output.routes.size) return false;
    const admitted: OutputSharingRoute[] = [];
    for (const input of plan.policy.inputs) { const result = controller.route({ destinationId, slotId: input.slotId }); if (!result.ok) break; admitted.push(result.value); output.routes.set(input.slotId, result.value); }
    if (admitted.length !== plan.policy.inputs.length || admitted.some(route => !route.connection.prepare().ok) || admitted.some(route => !route.connection.activate().ok)) {
      for (const route of admitted) route.connection.stop('sharing-admission-failed'); controller.release(destinationId, plan.revision); failures++; return false; }
    return !closed && admitted.every(route => route.connection.status().state === 'active');
  }
  function sweep() { if (closed) return; for (const output of outputs.values()) {
    const banks = selectedBanks(output); if (!banks.length || !nativeFacts(output, banks) || banks.some(bank => !controller.current(bank.route, bank.context))) { retireGraph(output); clearRaster(output); output.banks.clear(); } } }
  function snapshot(): BrowserOutputSharingSnapshot { return Object.freeze({ closed, routes: controller.snapshot().routes, rawPending: raw.size, providerPending: controller.snapshot().rawPending, cleanupFailures,
    ownedCanvases: [...outputs.values()].reduce((sum, output) => sum + output.canvases.size + output.staging.size + (output.composition ? 1 : 0), 0),
    ownedContexts: ownedContexts.size,
    ownedTracks: [...outputs.values()].reduce((sum, output) => sum + output.tracks.length, 0), effects, failures }); }
  function close(): Promise<void> {
    if (closePromise) return closePromise; closed = true; for (const detach of detachers.splice(0)) detach();
    closePromise = (async () => { await controller.close(); for (const output of outputs.values()) { retireGraph(output); clearRaster(output); for (const sink of output.sinks) runtime.unregister(sink); }
      while (raw.size || retiring.size) { drainClose(); await Promise.allSettled([...raw.values()]); } for (const output of outputs.values()) if (output.spec.container && ownedContainers.get(output.spec.container) === ownerToken) ownedContainers.delete(output.spec.container); })();
    return closePromise;
  }
  return Object.freeze({ controller, select, start, sweep, snapshot, close,
    output(destinationId: string) { const output = outputs.get(destinationId); if (!output?.destination || closed) return; const banks = selectedBanks(output);
      if (!banks.length || !nativeFacts(output, banks) || banks.some(bank => !controller.current(bank.route, bank.context))) return;
      const stream = output.destination.stream; if (!nativeFacts(output, banks)) return;
      const first = banks[0]!, second = banks[1];
      if (!controller.current(first.route, first.context, second && { route: second.route, context: second.context }) ||
          banks.some(bank => !sourceLive(bank.source) || !live(bank.context.signal))) return;
      return stream; } });
}
