import { CONNECTOR_PROFILE_LIMITS, DeviceValidationError, parseConnectorProfileManifest, parseSignalValue, snapshotJson } from '@101/device-model';
import type { ConnectorProfileManifest, ConnectorProfileResource, SignalValue } from '@101/device-model';
import { failure, success } from './scheduler.ts';
import type { Evidence, Result } from './scheduler.ts';
import type { DeliveryContext, Observation } from './types.ts';

export interface ConnectorDecodeContext { readonly clockId: string; readonly generation: number }
export interface ConnectorWriteContext extends ConnectorDecodeContext {
  readonly signal: AbortSignal; readonly commandId: string; readonly cleanup: boolean;
  /** A writer must check this immediately before effects, including after its own awaits. */
  isCurrent(): boolean;
}
export interface ConnectorDecoder {
  decode(frame: Uint8Array, context: ConnectorDecodeContext): unknown;
  encodeCommand(command: Readonly<{ resourceId: string; commandId: string; value: SignalValue }>, context: ConnectorDecodeContext): Uint8Array;
  reset(): void;
}
export interface TrustedConnectorProfileRegistration {
  readonly manifest: unknown;
  /** Reviewed artifact bytes. The host explicitly binds this factory to those exact bytes. */
  readonly source: Uint8Array;
  readonly factory: () => ConnectorDecoder;
}
export interface ConnectorProfileRequest { readonly id: string; readonly version: string; readonly codeSha256: string }
export interface ReviewedConnectorProfileBinding { readonly manifest: Readonly<ConnectorProfileManifest> }
export interface TrustedConnectorProfileRegistry {
  registerTrusted(registration: TrustedConnectorProfileRegistration): Promise<void>;
  resolve(request: ConnectorProfileRequest): ReviewedConnectorProfileBinding;
}
export interface ConnectorCaptureHandle { readonly kind: 'connector-capture' }
export interface ConnectorProfileSample {
  readonly kind: 'sample'; readonly resourceId: string; readonly value: SignalValue | null; readonly sequence: number;
  readonly sourceTime: Readonly<{ clockId: string; at: number }>;
  readonly quality: 'valid' | 'unavailable' | 'stale'; readonly receivedAt: number;
  readonly calibration: Readonly<{ revision: number; unit: string; absoluteErrorBound: number }> | null;
}
export type ConnectorDecodedOutput = Omit<ConnectorProfileSample, 'receivedAt'> | Readonly<{
  kind: 'ack'; resourceId: string; commandId: string; sequence: number; sourceTime: Readonly<{ clockId: string; at: number }>;
}>;
export interface ProfileConnectorOptions {
  readonly binding: ReviewedConnectorProfileBinding;
  /** Provider-observed facts, separate from declarations; matching is never authentication. */
  readonly observedIdentity: Readonly<Record<string, string | number | boolean>>;
  readonly now?: () => number;
  readonly onSample: (sample: ConnectorProfileSample) => void;
  readonly onUnavailable: (resourceId: string) => void;
  readonly write?: (bytes: Uint8Array, context: ConnectorWriteContext) => void | Promise<void>;
}
export interface ProfileConnector {
  readonly manifest: Readonly<ConnectorProfileManifest>;
  start(): Result<ConnectorCaptureHandle>;
  push(handle: ConnectorCaptureHandle, bytes: Uint8Array): Result<{ frames: number; outputs: number }>;
  /** Called by an externally authorized SDK sink; profile metadata supplies no route grant. */
  apply(resourceId: string, observation: Observation, context: DeliveryContext): Promise<void>;
  release(resourceId: string, reason: string, context: Readonly<{ routeId: string }>): void;
  sweep(): void; stop(reason?: string): void; close(): void;
  status(): Readonly<{ active: boolean; closed: boolean; bufferedBytes: number; pendingCommands: number; inFlightWrites: number;
    cleanupPending: boolean; acceptedFrames: number; acceptedSamples: number; rejectedInputs: number; reason: string }>;
}
type Entry = { manifest: Readonly<ConnectorProfileManifest>; factory: () => ConnectorDecoder };
const bindings = new WeakMap<object, Entry>();
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
function fail(code: string): never { throw new DeviceValidationError(code); }
function bytes(input: unknown, max: number): Uint8Array<ArrayBuffer> {
  if (!(input instanceof Uint8Array)) fail('connector-bytes');
  const length = byteLength.call(input) as number;
  if (length > max) fail('connector-byte-limit');
  const copy = new Uint8Array(length); Uint8Array.prototype.set.call(copy, input); return copy;
}
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('connector-fields');
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) fail('connector-fields');
  const copied: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor?.enumerable || !('value' in descriptor)) fail('connector-data'); copied[key] = descriptor.value; }
  return copied;
}
function own(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !('value' in descriptor)) fail('connector-data'); return descriptor.value;
}
function pin(manifest: ConnectorProfileManifest): string { return `${manifest.id}\0${manifest.version}\0${manifest.decoder.codeSha256}`; }

/** Fixed host registration only: no manifest import path, code fetching or automatic activation. */
export function createTrustedConnectorProfileRegistry(): TrustedConnectorProfileRegistry {
  const entries = new Map<string, Entry>(); let reserved = 0;
  return Object.freeze({
    async registerTrusted(registration: TrustedConnectorProfileRegistration): Promise<void> {
      if (reserved >= 4 || entries.size + reserved >= 32) fail('connector-registry-capacity');
      reserved++;
      try {
        const item = fields(registration, ['manifest', 'source', 'factory']);
        const manifest = parseConnectorProfileManifest(item.manifest);
        if (typeof item.factory !== 'function') fail('connector-factory');
        const source = bytes(item.source, CONNECTOR_PROFILE_LIMITS.sourceBytes);
        const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source)), byte => byte.toString(16).padStart(2, '0')).join('');
        if (digest !== manifest.decoder.codeSha256) fail('connector-code-pin');
        const key = pin(manifest); if (entries.has(key)) fail('connector-duplicate');
        entries.set(key, { manifest, factory: item.factory as () => ConnectorDecoder });
      } finally { reserved--; }
    },
    resolve(request: ConnectorProfileRequest): ReviewedConnectorProfileBinding {
      const item = fields(request, ['id', 'version', 'codeSha256']);
      if (typeof item.id !== 'string' || item.id.length > 128 || typeof item.version !== 'string' || item.version.length > 64 ||
        typeof item.codeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.codeSha256)) fail('connector-request');
      const entry = entries.get(`${item.id}\0${item.version}\0${item.codeSha256}`); if (!entry) fail('connector-unreviewed');
      const binding = Object.freeze({ manifest: entry.manifest }); bindings.set(binding, entry); return binding;
    },
  });
}
interface Watermark { sequence: number; at: number; receivedAt: number; available: boolean }
interface Pending {
  id: string; resource: ConnectorProfileResource; value: SignalValue; generation: number; routeId: string;
  controller: AbortController; current: () => boolean; report: (level: Evidence) => void;
  deadline: number; timer?: ReturnType<typeof setTimeout>; detach: () => void; resolve: () => void;
  sent: boolean; acknowledged?: number; stateSequence: number;
}

/** A bounded JSONL adapter for explicitly reviewed synchronous code, not an untrusted-code sandbox. */
export function createProfileConnector(options: ProfileConnectorOptions): ProfileConnector {
  const entry = bindings.get(options.binding); if (!entry) fail('connector-unreviewed');
  const manifest = entry.manifest;
  const identity = snapshotJson(options.observedIdentity);
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
    Object.values(identity).some(value => !['string', 'number', 'boolean'].includes(typeof value))) fail('connector-identity');
  const facts = identity as Record<string, string | number | boolean>;
  for (const filter of manifest.identityFilters) if (facts[filter.field] !== filter.equals) fail('connector-identity');
  const observedClock = facts.clockId;
  if (typeof observedClock !== 'string' || !observedClock.length || observedClock.length > 128 || Array.from(observedClock).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) fail('connector-clock');
  const clockId: string = observedClock;
  const onSample = options.onSample, onUnavailable = options.onUnavailable, write = options.write;
  if (typeof onSample !== 'function' || typeof onUnavailable !== 'function' || write !== undefined && typeof write !== 'function') fail('connector-callback');
  const now = options.now ?? (() => performance.now()); if (typeof now !== 'function') fail('connector-clock');
  const resources = new Map(manifest.resources.map(resource => [resource.capability.id, resource]));
  let active = false, closed = false, generation = 0, handle: ConnectorCaptureHandle | undefined, decoder: ConnectorDecoder | undefined;
  let buffered = new Uint8Array(0), processing = false, lastNow = -1, commandId = 0, reason = 'inactive';
  let acceptedFrames = 0, acceptedSamples = 0, rejectedInputs = 0, inFlightWrites = 0;
  const watermarks = new Map<string, Watermark>(), pending = new Map<string, Pending>();
  const owners = new Map<string, string>();
  let cleanup: { controller: AbortController; generation: number } | undefined;
  const cleanupQueue = new Map<string, { resource: ConnectorProfileResource; retired: ConnectorDecoder; epoch: number }>();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  function live(epoch: number): boolean { return active && !closed && generation === epoch; }
  function time(epoch: number): number {
    const value = now();
    if (!live(epoch) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || value < lastNow) fail('connector-clock');
    lastNow = value; return value;
  }
  function finish(item: Pending): void {
    if (pending.get(item.id) !== item) return;
    pending.delete(item.id); if (item.timer) clearTimeout(item.timer); item.detach(); item.controller.abort(); item.resolve();
  }
  function current(item: Pending): boolean {
    if (!live(item.generation) || pending.get(item.id) !== item || item.controller.signal.aborted) return false;
    try { const valid = item.current(); return valid === true && live(item.generation) && pending.get(item.id) === item && !item.controller.signal.aborted && time(item.generation) < item.deadline; }
    catch { return false; }
  }
  function evidence(item: Pending, level: Evidence): void {
    if (!current(item) || !item.resource.command!.feedback.includes(level)) { finish(item); return; }
    try { item.report(level); } catch { finish(item); }
    if (!current(item)) finish(item);
  }
  function invalidate(id: string, epoch: number): void {
    const watermark = watermarks.get(id); if (watermark) watermark.available = false;
    try { onUnavailable(id); } catch { /* Fixed failure state; never retain callback errors. */ }
    if (generation !== epoch) return;
  }
  function expireSources(receipt: number, epoch: number): void {
    for (const [id, watermark] of watermarks) {
      if (!live(epoch)) break;
      const resource = resources.get(id)!;
      if (resource.direction === 'source' && watermark.available && receipt - watermark.receivedAt > resource.capability.delivery.maxAgeMs) invalidate(id, epoch);
    }
  }
  // At most one cleanup writer and one inert cleanup intent per declared sink.
  // A trusted writer ignoring abort retains its reservation instead of accumulating work.
  function safeState(resource: ConnectorProfileResource, retired: ConnectorDecoder, epoch: number): void {
    if (!write || !resource.command || commandId >= Number.MAX_SAFE_INTEGER) return;
    cleanupQueue.set(resource.capability.id, { resource, retired, epoch }); drainCleanup();
  }
  function drainCleanup(): void {
    if (!write || cleanup || inFlightWrites >= manifest.budgets.maxPendingCommands) return;
    const intent = cleanupQueue.values().next().value; if (!intent) return;
    cleanupQueue.delete(intent.resource.capability.id);
    const { resource, retired, epoch } = intent;
    const policy = resource.command;
    if (generation !== epoch || commandId >= Number.MAX_SAFE_INTEGER || !policy) { drainCleanup(); return; }
    const controller = new AbortController(), slot = { controller, generation: epoch }; cleanup = slot; inFlightWrites++;
    const id = String(++commandId);
    const context: ConnectorWriteContext = Object.freeze({ signal: controller.signal, clockId, generation: epoch, commandId: id, cleanup: true,
      isCurrent: () => cleanup === slot && generation === epoch && !controller.signal.aborted });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const complete = () => { if (timer) clearTimeout(timer); controller.abort(); inFlightWrites--; if (cleanup === slot) cleanup = undefined; if (!closed) drainCleanup(); };
    try {
      const started = performance.now();
      const payload = bytes(retired.encodeCommand(Object.freeze({ resourceId: resource.capability.id, commandId: id, value: policy.safeState }), context), manifest.budgets.maxCommandBytes);
      if (!context.isCurrent() || performance.now() - started > manifest.budgets.callbackTimeoutMs) { complete(); return; }
      timer = setTimeout(() => controller.abort(), Math.min(policy.deadlineMs, manifest.budgets.callbackTimeoutMs));
      Promise.resolve(write(payload, context)).then(complete, complete);
    } catch { complete(); }
  }
  function stop(fixedReason: string): void {
    const retired = decoder, owned = [...owners.keys()].map(id => resources.get(id)!); owners.clear();
    active = false; handle = undefined; decoder = undefined; buffered = new Uint8Array(0); reason = fixedReason;
    if (watchdog) clearInterval(watchdog); watchdog = undefined;
    const epoch = ++generation;
    for (const item of [...pending.values()]) finish(item);
    for (const resource of manifest.resources) {
      if (generation !== epoch) break;
      if (resource.direction === 'source') invalidate(resource.capability.id, epoch);
    }
    if (retired && generation === epoch) {
      // First invalidate current operations, then attempt the declared idempotent safe state.
      for (const resource of owned) { if (generation !== epoch) break; safeState(resource, retired, epoch); }
      try { retired.reset(); } catch { /* Reset cannot restore authority. */ }
    }
  }
  function reject(epoch: number, fixedReason: string): Result<never> { rejectedInputs++; if (generation === epoch) stop(fixedReason); return failure(fixedReason); }
  function sourceTime(input: unknown): Readonly<{ clockId: string; at: number }> {
    const value = fields(input, ['clockId', 'at']);
    if (value.clockId !== clockId || typeof value.at !== 'number' || !Number.isFinite(value.at) || value.at < 0 || value.at > Number.MAX_SAFE_INTEGER) fail('connector-source-clock');
    return Object.freeze({ clockId, at: value.at });
  }
  function output(input: unknown, receipt: number, marks: Map<string, Watermark>): ConnectorProfileSample | Extract<ConnectorDecodedOutput, { kind: 'ack' }> {
    const kind = input && typeof input === 'object' ? own(input, 'kind') : undefined;
    const value = fields(input, kind === 'sample' ? ['kind', 'resourceId', 'value', 'sequence', 'sourceTime', 'quality', 'calibration'] : ['kind', 'resourceId', 'commandId', 'sequence', 'sourceTime']);
    const resource = typeof value.resourceId === 'string' ? resources.get(value.resourceId) : undefined;
    if (!resource || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1) fail('connector-output');
    const stamp = sourceTime(value.sourceTime), previous = marks.get(resource.capability.id);
    if (previous && (value.sequence <= previous.sequence || stamp.at < previous.at)) fail('connector-source-replay');
    if (kind === 'ack') {
      if (resource.direction !== 'sink' || typeof value.commandId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value.commandId)) fail('connector-ack');
      marks.set(resource.capability.id, { sequence: value.sequence, at: stamp.at, receivedAt: receipt, available: false });
      return Object.freeze({ kind, resourceId: resource.capability.id, commandId: value.commandId, sequence: value.sequence, sourceTime: stamp });
    }
    if (kind !== 'sample' || resource.direction !== 'source' || !['valid', 'unavailable', 'stale'].includes(String(value.quality))) fail('connector-output');
    const quality = value.quality as ConnectorProfileSample['quality'];
    let calibration: ConnectorProfileSample['calibration'] = null, signal: SignalValue | null = null;
    if (quality === 'valid') {
      signal = parseSignalValue(value.value, resource.capability.value);
      if (resource.calibration) {
        const observed = fields(value.calibration, ['revision', 'unit', 'absoluteErrorBound']);
        if (observed.revision !== resource.calibration.revision || observed.unit !== resource.calibration.unit || typeof observed.absoluteErrorBound !== 'number' ||
          !Number.isFinite(observed.absoluteErrorBound) || observed.absoluteErrorBound < 0 || observed.absoluteErrorBound > resource.calibration.maxAbsoluteErrorBound) fail('connector-calibration');
        calibration = Object.freeze({ revision: resource.calibration.revision, unit: resource.calibration.unit, absoluteErrorBound: observed.absoluteErrorBound });
      } else if (value.calibration !== null) fail('connector-calibration');
    } else if (value.value !== null || value.calibration !== null) fail('connector-unavailable');
    marks.set(resource.capability.id, { sequence: value.sequence, at: stamp.at, receivedAt: receipt, available: quality === 'valid' });
    return Object.freeze({ kind: 'sample', resourceId: resource.capability.id, value: signal, sequence: value.sequence, sourceTime: stamp, quality, receivedAt: receipt, calibration });
  }
  const connector: ProfileConnector = {
    manifest,
    start() {
      if (closed || active || processing || inFlightWrites >= manifest.budgets.maxPendingCommands) return failure(closed ? 'closed' : 'busy');
      cleanupQueue.clear(); cleanup?.controller.abort();
      const epoch = ++generation; active = true; reason = 'active'; watermarks.clear(); buffered = new Uint8Array(0);
      try {
        time(epoch); const started = performance.now();
        const implementation = fields(entry.factory(), ['decode', 'encodeCommand', 'reset']);
        if (!live(epoch) || performance.now() - started > manifest.budgets.callbackTimeoutMs || Object.values(implementation).some(value => typeof value !== 'function')) fail('connector-decoder');
        decoder = Object.freeze({ decode: implementation.decode as ConnectorDecoder['decode'], encodeCommand: implementation.encodeCommand as ConnectorDecoder['encodeCommand'], reset: implementation.reset as ConnectorDecoder['reset'] });
        handle = Object.freeze({ kind: 'connector-capture' });
        const cadence = Math.max(10, Math.min(1000, ...manifest.resources.filter(resource => resource.direction === 'source').map(resource => resource.capability.delivery.maxAgeMs / 2)));
        watchdog = setInterval(() => { if (live(epoch)) connector.sweep(); }, cadence);
        return success(handle);
      } catch { return reject(epoch, 'start-failed'); }
    },
    push(inputHandle, input) {
      const epoch = generation;
      if (!live(epoch) || inputHandle !== handle || processing) return failure('inactive-capture');
      processing = true;
      try {
        const receipt = time(epoch), chunk = bytes(input, manifest.framing.maxChunkBytes);
        expireSources(receipt, epoch); if (!live(epoch)) fail('connector-cancelled');
        const combined = new Uint8Array(buffered.length + chunk.length); combined.set(buffered); combined.set(chunk, buffered.length);
        const ends: number[] = []; let start = 0;
        for (let index = 0; index < combined.length; index++) {
          if (combined[index] === 10) {
            if (index - start > manifest.framing.maxFrameBytes || ends.length >= manifest.framing.maxFramesPerPush) fail('connector-frame-limit');
            ends.push(index); start = index + 1;
          } else if (index - start + 1 > manifest.framing.maxFrameBytes) fail('connector-frame-limit');
        }
        if (combined.length - start > manifest.budgets.maxBufferedBytes) fail('connector-buffer-limit');
        buffered = combined.slice(start); let from = 0, count = 0;
        for (const end of ends) {
          if (!live(epoch)) fail('connector-cancelled');
          const started = performance.now(), decoded = decoder!.decode(combined.slice(from, end), Object.freeze({ clockId, generation: epoch })); from = end + 1;
          if (!live(epoch) || performance.now() - started > manifest.budgets.callbackTimeoutMs || !Array.isArray(decoded) || decoded.length > manifest.budgets.maxOutputsPerFrame) fail('connector-decode');
          const copied = snapshotJson(decoded) as unknown as readonly unknown[], marks = new Map(watermarks);
          const batch = copied.map(value => output(value, receipt, marks));
          // Commit replay watermarks only after the entire frame is valid.
          for (const [id, mark] of marks) watermarks.set(id, mark);
          acceptedFrames++; count += batch.length;
          for (const result of batch) {
            if (!live(epoch)) fail('connector-cancelled');
            if (result.kind === 'ack') {
              const operation = pending.get(result.commandId);
              if (operation && operation.resource.capability.id === result.resourceId && current(operation)) {
                operation.acknowledged = result.sourceTime.at;
                if (operation.sent) evidence(operation, 'target-acknowledged');
                if (!operation.resource.command!.feedback.includes('observed')) finish(operation);
              }
            } else {
              if (result.quality !== 'valid') invalidate(result.resourceId, epoch);
              if (!live(epoch)) fail('connector-cancelled');
              const began = performance.now(); onSample(result); acceptedSamples++;
              if (!live(epoch) || performance.now() - began > manifest.budgets.callbackTimeoutMs) fail('connector-callback');
              for (const operation of [...pending.values()]) {
                if (!live(epoch)) fail('connector-cancelled');
                if (operation.sent && operation.acknowledged !== undefined && operation.resource.command!.observedState === result.resourceId && result.quality === 'valid' &&
                  result.sequence > operation.stateSequence && result.sourceTime.at > operation.acknowledged && JSON.stringify(result.value) === JSON.stringify(operation.value)) {
                  evidence(operation, 'observed'); finish(operation);
                }
              }
            }
          }
        }
        return success({ frames: ends.length, outputs: count });
      } catch { return reject(epoch, 'invalid-input'); } finally { processing = false; }
    },
    async apply(resourceId, observation, context) {
      const epoch = generation, resource = resources.get(resourceId);
      if (!live(epoch) || !decoder || !write || resource?.direction !== 'sink' || pending.size >= manifest.budgets.maxPendingCommands ||
        inFlightWrites >= manifest.budgets.maxPendingCommands || commandId >= Number.MAX_SAFE_INTEGER) return;
      // Reserve capacity before any caller value conversion, clock or callback.
      const id = String(++commandId), controller = new AbortController(); let reserved: Pending | undefined;
      const done = new Promise<void>(resolve => {
        const placeholder: Pending = { id, resource, generation: epoch, controller, resolve,
          value: resource.command!.safeState, routeId: '', current: () => false, report: () => {}, deadline: 0,
          detach: () => {}, sent: false, stateSequence: 0 };
        pending.set(id, placeholder); reserved = placeholder;
      });
      try {
        const signal = own(context, 'signal'), routeId = own(context, 'routeId'), routeGeneration = own(context, 'generation');
        const isCurrent = own(context, 'isCurrent'), report = own(context, 'reportEvidence');
        if (!(signal instanceof AbortSignal) || typeof routeId !== 'string' || !routeId.length || routeId.length > 128 ||
          typeof routeGeneration !== 'number' || !Number.isSafeInteger(routeGeneration) || routeGeneration < 1 || typeof isCurrent !== 'function' || typeof report !== 'function') fail('connector-route');
        const value = parseSignalValue(own(observation, 'value'), resource.capability.value);
        if (own(observation, 'quality') !== 'valid') fail('connector-command');
        const admittedAt = time(epoch), policy = resource.command!, item = reserved!;
        if (owners.has(resourceId) && owners.get(resourceId) !== routeId) fail('connector-owner');
        Object.assign(item, { value, routeId, current: () => !signal.aborted && isCurrent.call(context) === true, report: (level: Evidence) => report.call(context, level),
          deadline: admittedAt + Math.min(policy.deadlineMs, manifest.budgets.callbackTimeoutMs), sent: false,
          stateSequence: watermarks.get(policy.observedState ?? '')?.sequence ?? 0,
          timer: setTimeout(() => finish(item), Math.min(policy.deadlineMs, manifest.budgets.callbackTimeoutMs)),
          detach: () => signal.removeEventListener('abort', cancel) });
        function cancel() { finish(item); }
        signal.addEventListener('abort', cancel, { once: true });
        if (!current(item)) { finish(item); return; }
        owners.set(resourceId, routeId);
        const started = performance.now();
        const payload = bytes(decoder.encodeCommand(Object.freeze({ resourceId, commandId: id, value }), Object.freeze({ clockId, generation: epoch })), manifest.budgets.maxCommandBytes);
        if (!current(item) || performance.now() - started > manifest.budgets.callbackTimeoutMs) { finish(item); return; }
        const writeContext: ConnectorWriteContext = Object.freeze({ signal: controller.signal, clockId, generation: epoch, commandId: id, cleanup: false, isCurrent: () => current(item) });
        inFlightWrites++;
        let returned: void | Promise<void>;
        try { returned = write(payload, writeContext); }
        catch { inFlightWrites--; finish(item); drainCleanup(); return; }
        if (current(item)) {
          item.sent = true; evidence(item, 'dispatched');
          if (item.acknowledged !== undefined) evidence(item, 'target-acknowledged');
        } else finish(item);
        // Underlying unresolved trusted writes retain their capacity after cancellation.
        Promise.resolve(returned).then(() => { inFlightWrites--; item.resolve(); if (!closed) drainCleanup(); }, () => { inFlightWrites--; finish(item); item.resolve(); if (!closed) drainCleanup(); });
        await done;
      } catch {
        if (reserved) {
          finish(reserved);
        }
      }
    },
    release(resourceId, _reason, context) {
      const epoch = generation, resource = resources.get(resourceId);
      const owned = [...pending.values()].filter(item => item.resource === resource && item.routeId === context.routeId);
      for (const item of owned) finish(item);
      if (owners.get(resourceId) === context.routeId) {
        owners.delete(resourceId);
        if (decoder && resource && live(epoch)) safeState(resource, decoder, epoch);
      }
    },
    sweep() {
      const epoch = generation; if (!live(epoch)) return;
      try {
        const receipt = time(epoch);
        for (const item of [...pending.values()]) if (!current(item)) finish(item);
        expireSources(receipt, epoch);
      } catch { reject(epoch, 'invalid-clock'); }
    },
    stop() { if (active) stop('stopped'); },
    close() { if (closed) return; closed = true; stop('closed'); cleanupQueue.clear(); cleanup?.controller.abort(); },
    status() { return Object.freeze({ active, closed, bufferedBytes: buffered.length, pendingCommands: pending.size, inFlightWrites,
      cleanupPending: cleanup !== undefined || cleanupQueue.size > 0, acceptedFrames, acceptedSamples, rejectedInputs, reason }); },
  };
  return Object.freeze(connector);
}
