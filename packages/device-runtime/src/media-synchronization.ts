import { RemoteClockMap, parseObservationTiming } from '@101/device-model';
import type { RemoteClockObservation, ObservationTiming } from '@101/device-model';
import type { DeliveryContext, Observation, ResourceReference } from './types.ts';

export const MEDIA_SYNCHRONIZATION_PROFILE = 'software-media-observation-sync/1' as const;
export const MEDIA_SYNCHRONIZATION_LIMITS = Object.freeze({ sources: 2, offers: 128, decisions: 64, exchanges: 32,
  lifetimeMs: 30000, maxAgeMs: 100, mapAgeMs: 500, maxRttMs: 20, uncertaintyMs: 5, skewMs: 20, driftPpm: 100, recoveryPairs: 3 });
export type MediaSynchronizationRole = 'audio' | 'video';
export type MediaSynchronizationState = 'unsynchronized' | 'recovering' | 'aligned-software-observations' | 'degraded' | 'closed';
export type MediaSynchronizationReason = 'awaiting-maps' | 'native-clock-unmapped' | 'invalid-observation' | 'stale-epoch' |
  'map-unavailable' | 'age-budget' | 'skew-budget' | 'context-retired' | 'effect-failed' | 'reset' | 'owner-revoked' |
  'expired' | 'invalid-clock' | 'budget' | 'closed' | 'within-budget';
export interface MediaSynchronizationSource {
  readonly source: ResourceReference; readonly routeId: string; readonly clockId: string;
}
export interface MediaSynchronizationPair {
  readonly profile: typeof MEDIA_SYNCHRONIZATION_PROFILE; readonly epoch: number;
  readonly audioSequence: number; readonly videoSequence: number; readonly audioValue: number; readonly videoValue: number;
  readonly audio: ObservationTiming; readonly video: ObservationTiming;
  readonly skew: Readonly<{ earliestMs: number; latestMs: number }>;
  /** Native PCM capture, caller-assigned video PTS and physical scanout are not mapped by this profile. */
  readonly nativeCaptureMapping: 'unknown'; readonly displayScanoutMapping: 'unknown';
}
export interface MediaSynchronizationEffectContext {
  readonly signals: Readonly<{ owner: AbortSignal; audio: AbortSignal; video: AbortSignal }>;
  /** An observer. Each host effect must also respect the actual signals at its final effect boundary. */
  isCurrent(): boolean;
}
export interface MediaSynchronizationOptions {
  readonly ownerSignal: AbortSignal; readonly displayClockId: string; readonly now: () => number;
  readonly audio: MediaSynchronizationSource; readonly video: MediaSynchronizationSource;
  /** Return the actual effect Promise, including any owned animation-frame callback. No cancellation-as-settlement. */
  readonly onPair: (pair: MediaSynchronizationPair, context: MediaSynchronizationEffectContext) => void | Promise<void>;
}
export interface MediaSynchronizationSnapshot {
  readonly profile: typeof MEDIA_SYNCHRONIZATION_PROFILE; readonly state: MediaSynchronizationState;
  readonly reason: MediaSynchronizationReason; readonly epoch: number; readonly recoveryPairs: number;
  readonly offers: number; readonly decisions: number; readonly exchanges: number; readonly effects: number;
  readonly discarded: number; readonly pendingContexts: number; readonly pendingEffects: number;
  readonly nativeCaptureMapping: 'unknown'; readonly displayScanoutMapping: 'unknown';
}
export interface MediaSynchronizationController {
  observeClock(role: MediaSynchronizationRole, epoch: number, observation: RemoteClockObservation): boolean;
  /** Return this Promise directly from the real SinkProvider.apply to retain its live DeliveryContext. */
  offer(role: MediaSynchronizationRole, observation: Observation, context: DeliveryContext): Promise<void>;
  tick(): void; reset(): void; snapshot(): MediaSynchronizationSnapshot; close(): Promise<void>;
}

const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener;
function live(signal: AbortSignal): boolean { try { return aborted.call(signal) === false; } catch { return false; } }
function field(input: unknown, name: string): unknown {
  if (!input || typeof input !== 'object') throw new TypeError('Invalid synchronization input');
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Synchronization data fields are required');
  return descriptor.value;
}
function closed(input: unknown, names: readonly string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid synchronization input');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key)))
    throw new TypeError('Invalid synchronization fields');
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 128 || value.trim() !== value || Array.from(value).some(character => {
    const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
  }))
    throw new TypeError('Invalid synchronization identity');
  return value;
}
function stamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
    throw new TypeError('Invalid synchronization timestamp');
  return value;
}
function reference(input: unknown): ResourceReference {
  closed(input, ['registrationId', 'deviceId', 'capabilityId', 'descriptorRevision', 'schemaVersion']);
  const revision = field(input, 'descriptorRevision'), schema = field(input, 'schemaVersion');
  if (!Number.isSafeInteger(revision) || (revision as number) < 1 || (revision as number) > 2147483647 || schema !== 1)
    throw new TypeError('Invalid synchronization resource revision');
  return Object.freeze({ registrationId: id(field(input, 'registrationId')), deviceId: id(field(input, 'deviceId')),
    capabilityId: id(field(input, 'capabilityId')), descriptorRevision: revision as number, schemaVersion: 1 });
}
function source(input: unknown): MediaSynchronizationSource {
  closed(input, ['source', 'routeId', 'clockId']);
  return Object.freeze({ source: reference(field(input, 'source')), routeId: id(field(input, 'routeId')), clockId: id(field(input, 'clockId')) });
}
interface Entry {
  readonly epoch: number; readonly sequence: number; readonly value: number; readonly timing: ObservationTiming;
  readonly earliest: number; readonly latest: number; readonly receivedAt: number;
  readonly signal: AbortSignal; readonly context: DeliveryContext; readonly current: () => boolean;
  readonly resolve: () => void; readonly listener: () => void;
  settled: boolean;
}
interface Work { readonly epoch: number; readonly audio: Entry; readonly video: Entry; readonly pair: MediaSynchronizationPair }

/** Cooperative host composition of two real, independently granted software observation routes.
 * It authenticates no clock/source claim and establishes no physical media synchronization. */
export function createMediaSynchronizationController(options: MediaSynchronizationOptions): MediaSynchronizationController {
  closed(options, ['ownerSignal', 'displayClockId', 'now', 'audio', 'video', 'onPair']);
  const owner = field(options, 'ownerSignal') as AbortSignal, now = field(options, 'now'), onPair = field(options, 'onPair');
  // Invoke the intrinsic getter even for an already-aborted genuine signal; structural lookalikes fail closed.
  try { aborted.call(owner); } catch { throw new TypeError('A native owner AbortSignal is required'); }
  if (typeof now !== 'function' || typeof onPair !== 'function') throw new TypeError('A clock and actual paired effect are required');
  const clock = now as () => number, effect = onPair as MediaSynchronizationOptions['onPair'];
  const displayClockId = id(field(options, 'displayClockId')), sources = { audio: source(field(options, 'audio')), video: source(field(options, 'video')) };
  if (sources.audio.clockId === sources.video.clockId || sources.audio.clockId === displayClockId || sources.video.clockId === displayClockId ||
      sources.audio.routeId === sources.video.routeId || sources.audio.source.registrationId === sources.video.source.registrationId)
    throw new TypeError('Two distinct software source clocks and routes are required');
  const maps = { audio: new RemoteClockMap({ localClockId: displayClockId, remoteClockId: sources.audio.clockId, maxRttMs: 20, maxUncertaintyMs: 5, maxDriftPpm: 100, maxAgeMs: 500 }),
    video: new RemoteClockMap({ localClockId: displayClockId, remoteClockId: sources.video.clockId, maxRttMs: 20, maxUncertaintyMs: 5, maxDriftPpm: 100, maxAgeMs: 500 }) };
  const slots: Partial<Record<MediaSynchronizationRole, Entry>> = {}, retained = new Set<Entry>();
  let closePromise: Promise<void> | undefined, closeResolve: (() => void) | undefined;
  let state: MediaSynchronizationState = 'unsynchronized', reason: MediaSynchronizationReason = 'awaiting-maps', epoch = 1;
  let offers = 0, decisions = 0, exchanges = 0, effects = 0, discarded = 0, recovery = 0, work: Work | undefined;
  let lastAt = -1, startAt = -1, lastPairAt = -1, ticking = false, pairing = false;
  const offering = { audio: false, video: false };
  const sequence = { audio: -1, video: -1 };
  function isClosed() { return state === 'closed'; }
  function finishClose() { if (isClosed() && !retained.size && !work) { closeResolve?.(); closeResolve = undefined; } }
  function settle(entry: Entry) {
    if (entry.settled) return;
    entry.settled = true; removeListener.call(entry.signal, 'abort', entry.listener); retained.delete(entry); entry.resolve(); finishClose();
  }
  function discardSlots() {
    for (const role of ['audio', 'video'] as const) { const entry = slots[role]; delete slots[role]; if (entry) { discarded++; settle(entry); } }
  }
  function retire(next: MediaSynchronizationReason, terminal = false) {
    if (state === 'closed') return;
    epoch++; recovery = 0; reason = next; state = terminal ? 'closed' : next === 'native-clock-unmapped' ? 'unsynchronized' : 'degraded';
    maps.audio.reset(); maps.video.reset(); sequence.audio = sequence.video = -1; discardSlots();
    if (terminal) removeListener.call(owner, 'abort', ownerAbort);
    finishClose();
  }
  function ownerAbort() { retire('owner-revoked', true); }
  addListener.call(owner, 'abort', ownerAbort, { once: true });
  function time(): number | undefined {
    if (state === 'closed') return undefined;
    const captured = epoch;
    let at: number;
    try { at = stamp(clock()); } catch { retire('invalid-clock', true); return undefined; }
    if (!live(owner)) { ownerAbort(); return undefined; }
    if (captured !== epoch || isClosed()) return undefined;
    if (at < lastAt) { retire('invalid-clock', true); return undefined; }
    lastAt = at;
    if (startAt < 0) startAt = at;
    if (at - startAt >= MEDIA_SYNCHRONIZATION_LIMITS.lifetimeMs) { retire('expired', true); return undefined; }
    return at;
  }
  function entryCurrent(entry: Entry, at: number): boolean {
    return !entry.settled && entry.epoch === epoch && live(entry.signal) && at >= entry.receivedAt && at - entry.earliest <= 100;
  }
  function current(selected: Work): boolean {
    if (work !== selected || selected.epoch !== epoch || state === 'closed' || !live(owner)) return false;
    let observed: boolean;
    try { observed = selected.audio.current.call(selected.audio.context) && selected.video.current.call(selected.video.context); } catch { observed = false; }
    const at = time();
    // DeliveryContext.isCurrent callbacks are observers; final authority comes from all intrinsic native signals.
    return observed && at !== undefined && work === selected && selected.epoch === epoch && live(owner) &&
      entryCurrent(selected.audio, at) && entryCurrent(selected.video, at);
  }
  function complete(selected: Work, failed: boolean) {
    if (work !== selected) return;
    const accepted = !failed && current(selected);
    if (accepted) { effects++; state = 'aligned-software-observations'; reason = 'within-budget'; }
    else if (state !== 'closed' && selected.epoch === epoch) retire(failed ? 'effect-failed' : 'context-retired');
    work = undefined; settle(selected.audio); settle(selected.video); finishClose();
  }
  function pair() {
    const audio = slots.audio, video = slots.video;
    if (!audio || !video || work || pairing || state === 'closed') return;
    pairing = true;
    try {
    const at = time(); if (at === undefined) return;
    if (!entryCurrent(audio, at) || !entryCurrent(video, at)) { retire('age-budget'); return; }
    const earliestMs = audio.earliest - video.latest, latestMs = audio.latest - video.earliest;
    if (Math.max(Math.abs(earliestMs), Math.abs(latestMs)) > 20) { retire('skew-budget'); return; }
    if (decisions >= 64) { retire('budget', true); return; }
    decisions++; recovery++; lastPairAt = at;
    if (recovery < 3) { state = 'recovering'; delete slots.audio; delete slots.video; settle(audio); settle(video); return; }
    const value: MediaSynchronizationPair = Object.freeze({ profile: MEDIA_SYNCHRONIZATION_PROFILE, epoch,
      audioSequence: audio.sequence, videoSequence: video.sequence, audioValue: audio.value, videoValue: video.value,
      audio: audio.timing, video: video.timing, skew: Object.freeze({ earliestMs, latestMs }), nativeCaptureMapping: 'unknown', displayScanoutMapping: 'unknown' });
    // Reserve the actual effect and both real apply contexts before any host currentness/effect callout.
    const selected: Work = { epoch, audio, video, pair: value }; work = selected;
    delete slots.audio; delete slots.video;
    if (!current(selected)) { complete(selected, true); return; }
    const context: MediaSynchronizationEffectContext = Object.freeze({ signals: Object.freeze({ owner, audio: audio.signal, video: video.signal }), isCurrent: () => current(selected) });
    try { const returned = effect(value, context); Promise.resolve(returned).then(() => complete(selected, false), () => complete(selected, true)); }
    catch { complete(selected, true); }
    } finally { pairing = false; }
  }
  function snapshot(): MediaSynchronizationSnapshot {
    return Object.freeze({ profile: MEDIA_SYNCHRONIZATION_PROFILE, state, reason, epoch, recoveryPairs: Math.min(recovery, 3),
      offers, decisions, exchanges, effects, discarded, pendingContexts: retained.size, pendingEffects: work ? 1 : 0,
      nativeCaptureMapping: 'unknown', displayScanoutMapping: 'unknown' });
  }
  time(); if (!live(owner)) ownerAbort();
  const api: MediaSynchronizationController = {
    observeClock(role, selectedEpoch, observation) {
      if (state === 'closed' || !['audio', 'video'].includes(role) || selectedEpoch !== epoch) return false;
      if (exchanges >= 32) { retire('budget', true); return false; }
      exchanges++; const captured = epoch, at = time(); if (at === undefined || captured !== epoch) return false;
      try {
        closed(observation, ['localSentAt', 'remoteReceivedAt', 'remoteSentAt', 'localReceivedAt']);
        const input: RemoteClockObservation = { localSentAt: stamp(field(observation, 'localSentAt')), remoteReceivedAt: stamp(field(observation, 'remoteReceivedAt')),
          remoteSentAt: stamp(field(observation, 'remoteSentAt')), localReceivedAt: stamp(field(observation, 'localReceivedAt')) };
        if (input.localReceivedAt > at || at - input.localReceivedAt > 500 || captured !== epoch || !live(owner) || !maps[role].observe(input)) {
          retire('map-unavailable'); return false;
        }
        return captured === epoch && live(owner);
      } catch { retire('map-unavailable'); return false; }
    },
    offer(role, observation, context) {
      if (state === 'closed') return Promise.resolve();
      if (offers >= 128) { retire('budget', true); return Promise.resolve(); }
      offers++; const captured = epoch;
      if (!['audio', 'video'].includes(role) || work || pairing || offering[role]) { discarded++; return Promise.resolve(); }
      offering[role] = true;
      const replaced = slots[role]; if (replaced) { delete slots[role]; discarded++; settle(replaced); }
      try {
        const at = time(); if (at === undefined || captured !== epoch) return Promise.resolve();
        const expected = sources[role], signal = field(context, 'signal') as AbortSignal, observer = field(context, 'isCurrent');
        aborted.call(signal);
        if (field(context, 'routeId') !== expected.routeId || typeof observer !== 'function' || !Number.isSafeInteger(field(context, 'generation')) ||
            !observer.call(context) || !live(signal) || !live(owner) || captured !== epoch) throw new TypeError('Retired synchronization context');
        const observedSource = field(observation, 'source');
        if (field(observedSource, 'registrationId') !== expected.source.registrationId || field(observedSource, 'deviceId') !== expected.source.deviceId ||
            field(observedSource, 'capabilityId') !== expected.source.capabilityId || field(observation, 'clockDomain') !== displayClockId || field(observation, 'quality') !== 'valid')
          throw new TypeError('Wrong synchronization source');
        const seq = field(observation, 'sequence'), value = field(observation, 'value'), receipt = stamp(field(observation, 'receivedAt'));
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq <= sequence[role] || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 255)
          throw new TypeError('Invalid synchronization value');
        const provenance = field(observation, 'provenance'), metadata = field(provenance, 'sync');
        closed(metadata, ['profile', 'epoch', 'basis', 'clockId', 'at']);
        if (field(metadata, 'profile') !== MEDIA_SYNCHRONIZATION_PROFILE || field(metadata, 'basis') !== 'software-observation' || field(metadata, 'clockId') !== expected.clockId)
          throw new TypeError('Unmapped native time');
        if (field(metadata, 'epoch') !== captured) { retire('stale-epoch'); return Promise.resolve(); }
        const sourceAt = stamp(field(metadata, 'at')), mapped = maps[role].translate(sourceAt, at);
        if (!mapped) { retire('map-unavailable'); return Promise.resolve(); }
        const timing = parseObservationTiming({ capture: { clockId: expected.clockId, at: sourceAt }, receipt: { clockId: displayClockId, at: receipt },
          mapping: { earliest: mapped.earliest, latest: mapped.latest, uncertaintyMs: mapped.uncertaintyMs, maxDriftPpm: maps[role].driftPpm() }, processors: [] });
        if (at < receipt || at - mapped.earliest > 100 || captured !== epoch || !live(owner) || !live(signal)) { retire('age-budget'); return Promise.resolve(); }
        let resolve!: () => void; const pending = new Promise<void>(done => { resolve = done; });
        const entry: Entry = { epoch: captured, sequence: seq, value, timing, earliest: mapped.earliest, latest: mapped.latest, receivedAt: receipt,
          signal, context, current: observer as () => boolean, resolve, listener: () => { if (!entry.settled) retire('context-retired'); }, settled: false };
        retained.add(entry); slots[role] = entry; sequence[role] = seq;
        addListener.call(signal, 'abort', entry.listener, { once: true });
        if (!live(signal) || !live(owner) || captured !== epoch) retire('context-retired'); else pair();
        return pending;
      } catch {
        let nativeUnknown = false;
        try { const provenance = field(observation, 'provenance'); nativeUnknown = field(provenance, 'captureTimeKnown') === false || field(provenance, 'clockMappingEstablished') === false; } catch { /* No native mapping evidence. */ }
        retire(nativeUnknown ? 'native-clock-unmapped' : 'invalid-observation'); return Promise.resolve();
      } finally { offering[role] = false; }
    },
    tick() {
      if (ticking || state === 'closed') return;
      ticking = true;
      try { const at = time(); if (at === undefined) return;
        if ((state === 'aligned-software-observations' || state === 'recovering') && lastPairAt >= 0 && at - lastPairAt > 100) { retire('age-budget'); return; }
        for (const role of ['audio', 'video'] as const) { const entry = slots[role]; if (entry && !entryCurrent(entry, at)) { retire('age-budget'); break; } }
        if (work && !current(work) && !isClosed() && work.epoch === epoch) retire('context-retired');
      } finally { ticking = false; }
    },
    reset() { retire('reset'); }, snapshot,
    close() { retire('closed', true); if (!retained.size && !work) return Promise.resolve();
      closePromise ??= new Promise<void>(resolve => { closeResolve = resolve; }); return closePromise; },
  };
  return Object.freeze(api);
}
