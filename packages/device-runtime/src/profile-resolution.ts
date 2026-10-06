import { parseConnectorProfileManifest, parseDiscoveryCandidate, snapshotJson } from '@101/device-model';
import type { ConnectorProfileResource, DiscoveryCandidate, DiscoveryEvidence, DiscoveryScope } from '@101/device-model';
import { createProfileConnector } from './profile-connector.ts';
import type { ConnectorProfileRequest, ProfileConnector, ProfileConnectorOptions, ReviewedConnectorProfileBinding, TrustedConnectorProfileRegistry } from './profile-connector.ts';

export const PROFILE_RESOLUTION_LIMITS = Object.freeze({ profiles: 8, facts: 16, factsBytes: 4096, candidateBytes: 16384,
  observationMs: 30000, reviewMs: 30000, connectorCreations: 64 });
export interface ProfileObservationHandle { readonly kind: 'profile-observation' }
export interface ProfileReviewHandle { readonly kind: 'profile-review' }
export interface ProfileChoiceHandle { readonly kind: 'profile-choice' }
export interface ProfileResolutionOptions {
  readonly registry: TrustedConnectorProfileRegistry;
  readonly profiles: readonly ConnectorProfileRequest[];
  readonly scope: DiscoveryScope;
  readonly now: () => number;
  /** Trusted provider receipt verification must bind these exact facts to this observation.
   * It establishes an observation only, never peer authentication or resource authority. */
  readonly verifyObservation: (candidate: DiscoveryCandidate, evidence: DiscoveryEvidence,
    observedIdentity: Readonly<Record<string, string | number | boolean>>) => boolean;
}
export type ProfileResolutionFailure = 'closed' | 'busy' | 'invalid' | 'unverified' | 'stale' | 'unsupported' | 'capacity' | 'creation-failed';
export type ProfileResolutionResult<T = undefined> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: ProfileResolutionFailure }>;
export interface ProfileResolutionSelection {
  readonly candidateId: string; readonly profile: Readonly<ConnectorProfileRequest>; readonly expiresAt: number;
  /** Reviewed declarations, not live inventory or resource grants. */
  readonly resources: readonly ConnectorProfileResource[];
}
export interface ProfileResolutionSnapshot {
  readonly state: 'unknown' | 'unsupported' | 'reviewing' | 'selected' | 'expired' | 'closed';
  readonly outcome: 'unknown' | 'observed' | 'unsupported' | 'requested' | 'selected' | 'declined' | 'cancelled' | 'removed' | 'expired' | 'closed';
  readonly candidateId?: string; readonly current?: ProfileResolutionSelection; readonly pending?: ProfileResolutionSelection;
  readonly ownedConnector: boolean; readonly timerArmed: boolean; readonly remainingConnectorCreations: number;
}
export interface ProfileResolutionController {
  observe(input: Readonly<{ candidate: unknown; observedIdentity: unknown }>): ProfileResolutionResult<ProfileObservationHandle>;
  request(observation: ProfileObservationHandle, profile: ConnectorProfileRequest): ProfileResolutionResult<ProfileReviewHandle>;
  decide(review: ProfileReviewHandle, allow: boolean): ProfileResolutionResult<ProfileChoiceHandle | undefined>;
  cancel(review: ProfileReviewHandle): ProfileResolutionResult;
  /** Creates an inactive A01 connector. Explicit start and external route grants remain necessary.
   * Each choice can own one connector; explicit replacement retires the previous instance. */
  createConnector(choice: ProfileChoiceHandle,
    callbacks: Omit<ProfileConnectorOptions, 'binding' | 'observedIdentity' | 'now'>): ProfileResolutionResult<ProfileConnector>;
  isCurrent(choice: ProfileChoiceHandle): boolean;
  remove(observation: ProfileObservationHandle): ProfileResolutionResult;
  clear(): void; sweep(): void; snapshot(): ProfileResolutionSnapshot; close(): void;
}
interface Observed {
  handle: ProfileObservationHandle; epoch: number; candidate: DiscoveryCandidate;
  facts: Readonly<Record<string, string | number | boolean>>; expiresAt: number;
}
interface Review { handle: ProfileReviewHandle; observed: Observed; binding: ReviewedConnectorProfileBinding; selection: ProfileResolutionSelection }
interface Choice { handle: ProfileChoiceHandle; observed: Observed; binding: ReviewedConnectorProfileBinding; selection: ProfileResolutionSelection;
  creating: boolean; connector?: ProfileConnector }
const ok = <T = undefined>(value: T = undefined as T): ProfileResolutionResult<T> => Object.freeze({ ok: true, value });
const fail = (reason: ProfileResolutionFailure): ProfileResolutionResult<never> => Object.freeze({ ok: false, reason });
function invalid(): never { throw new TypeError('Invalid profile resolution input'); }
function data(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length > required.length + optional.length || required.some(key => !Object.hasOwn(input, key)) ||
    keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key))) invalid();
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    output[key] = descriptor.value;
  }
  return output;
}
function text(input: unknown, max: number): string {
  if (typeof input !== 'string' || !input.length || input.length > max || input.trim() !== input ||
    [...input].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid();
  return input;
}
function requestPin(input: unknown): Readonly<ConnectorProfileRequest> {
  const value = data(input, ['id', 'version', 'codeSha256']);
  const id = text(value.id, 128), version = text(value.version, 64), codeSha256 = text(value.codeSha256, 64);
  if (!/^[A-Za-z][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version) || !/^[0-9a-f]{64}$/.test(codeSha256)) invalid();
  return Object.freeze({ id, version, codeSha256 });
}
function key(pin: ConnectorProfileRequest): string { return `${pin.id}\0${pin.version}\0${pin.codeSha256}`; }
function facts(input: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length < 1 || keys.length > PROFILE_RESOLUTION_LIMITS.facts) invalid();
  const output: Record<string, string | number | boolean> = {};
  for (const field of keys) {
    if (typeof field !== 'string' || field.length > 64 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || ['constructor', 'prototype', '__proto__'].includes(field)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    const value: unknown = descriptor.value;
    if (typeof value === 'string') text(value, 128);
    else if (typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) invalid();
    output[field] = value as string | number | boolean;
  }
  text(output.clockId, 128);
  if (new TextEncoder().encode(JSON.stringify(output)).length > PROFILE_RESOLUTION_LIMITS.factsBytes) invalid();
  return Object.freeze(output);
}

/** Explicit local semantic resolution. It neither discovers nor authenticates hardware,
 * probes inventory, loads code, registers resources, or issues operation grants.
 * The host supplies the existing trusted registry and receipt verifier. Synchronous
 * host callbacks/factories are trusted code, not preempted or sandboxed here. */
export function createProfileResolutionController(options: ProfileResolutionOptions): ProfileResolutionController {
  const scopeInput = data(options.scope, ['kind', 'id']);
  if (!['local', 'application', 'session', 'directory'].includes(scopeInput.kind as string)) invalid();
  const scope = Object.freeze({ kind: scopeInput.kind as DiscoveryScope['kind'], id: text(scopeInput.id, 128) });
  const now = options.now, verify = options.verifyObservation, registry = options.registry;
  const resolver = Object.getOwnPropertyDescriptor(registry, 'resolve');
  if (typeof now !== 'function' || typeof verify !== 'function' || !resolver || !('value' in resolver) || typeof resolver.value !== 'function') invalid();
  const resolve: TrustedConnectorProfileRegistry['resolve'] = resolver.value;
  const profiles = options.profiles;
  if (!Array.isArray(profiles) || Object.getPrototypeOf(profiles) !== Array.prototype || profiles.length < 1 ||
    profiles.length > PROFILE_RESOLUTION_LIMITS.profiles || Reflect.ownKeys(profiles).length !== profiles.length + 1) invalid();
  const catalog = new Map<string, Readonly<ConnectorProfileRequest>>();
  for (let index = 0; index < profiles.length; index++) {
    const field = Object.getOwnPropertyDescriptor(profiles, String(index));
    if (!field?.enumerable || !('value' in field)) invalid();
    const pin = requestPin(field.value); if (catalog.has(key(pin))) invalid(); catalog.set(key(pin), pin);
  }
  let closed = false, busy = false, readingClock = false, verifying = false, epoch = 0, attempts = 0, lastTime = -1;
  let observed: Observed | undefined, pending: Review | undefined, chosen: Choice | undefined;
  let outcome: ProfileResolutionSnapshot['outcome'] = 'unknown', timer: ReturnType<typeof setTimeout> | undefined;
  function disarm(): void { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function retireChoice(): void { const old = chosen; chosen = undefined; old?.connector?.close(); }
  function drop(reason: ProfileResolutionSnapshot['outcome']): void {
    disarm(); observed = undefined; pending = undefined; epoch++; outcome = reason; retireChoice();
  }
  function close(): void { if (closed) return; closed = true; drop('closed'); }
  function time(): number | undefined {
    if (closed) return;
    if (readingClock) { close(); return; }
    readingClock = true;
    try {
      const at = now();
      if (closed || !Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - PROFILE_RESOLUTION_LIMITS.observationMs || at < lastTime) { close(); return; }
      lastTime = at; return at;
    } catch { close(); return; } finally { readingClock = false; }
  }
  function alive(record: Observed): boolean { return !closed && observed === record && record.epoch === epoch; }
  function expiry(at: number): void {
    if (observed && at >= observed.expiresAt) { drop('expired'); return; }
    if (pending && at >= pending.selection.expiresAt) { pending = undefined; outcome = 'expired'; }
  }
  function verified(record: Observed, at: number): boolean {
    const evidence = record.candidate.evidence[0]!;
    if (verifying || at < evidence.at || at >= evidence.expiresAt || at >= record.expiresAt) return false;
    verifying = true;
    try { return verify(record.candidate, evidence, record.facts) === true; }
    catch { return false; } finally { verifying = false; }
  }
  function currentObservation(record: Observed): boolean {
    if (!alive(record) || verifying) return false;
    const at = time(); if (at === undefined) return false; expiry(at);
    if (!alive(record)) return false;
    const valid = verified(record, at);
    const after = time(); if (after === undefined) return false; expiry(after);
    if (!alive(record)) return false;
    if (!valid) { drop('removed'); return false; }
    return true;
  }
  function currentChoice(record: Choice): boolean {
    return chosen === record && currentObservation(record.observed) && chosen === record;
  }
  function arm(at: number): void {
    disarm(); const record = observed; if (!record || !alive(record)) return;
    const deadline = Math.min(record.expiresAt, pending?.selection.expiresAt ?? record.expiresAt);
    if (deadline <= at) { expiry(at); return; }
    const owned = setTimeout(() => {
      if (timer !== owned) return; timer = undefined;
      if (!alive(record)) return;
      sweep(); const after = time(); if (after !== undefined && alive(record)) arm(after);
    }, Math.max(1, Math.min(PROFILE_RESOLUTION_LIMITS.observationMs, deadline - at)));
    if (!alive(record)) { clearTimeout(owned); return; } timer = owned;
  }
  function sweep(): void {
    if (closed || verifying) return;
    const record = observed, at = time(); if (at === undefined) return; expiry(at);
    if (record && alive(record)) currentObservation(record);
  }
  function enter(): boolean { if (closed || busy || verifying) return false; busy = true; return true; }
  function selection(record: Observed, pin: Readonly<ConnectorProfileRequest>, resources: readonly ConnectorProfileResource[], expiresAt: number): ProfileResolutionSelection {
    return Object.freeze({ candidateId: record.candidate.id, profile: pin, resources, expiresAt });
  }
  function snapshot(): ProfileResolutionSnapshot {
    return Object.freeze({ state: closed ? 'closed' : pending ? 'reviewing' : chosen ? 'selected' : outcome === 'unsupported' ? 'unsupported' : outcome === 'expired' ? 'expired' : 'unknown',
      outcome, ...(observed ? { candidateId: observed.candidate.id } : {}), ...(chosen ? { current: chosen.selection } : {}),
      ...(pending ? { pending: pending.selection } : {}), ownedConnector: !!chosen?.connector && !chosen.connector.status().closed,
      timerArmed: timer !== undefined, remainingConnectorCreations: PROFILE_RESOLUTION_LIMITS.connectorCreations - attempts });
  }
  return Object.freeze({ snapshot, clear() { if (!closed) drop('unknown'); }, close, sweep,
    isCurrent(handle: ProfileChoiceHandle): boolean { const record = chosen; return !!record && record.handle === handle && currentChoice(record); },
    observe(input: Readonly<{ candidate: unknown; observedIdentity: unknown }>): ProfileResolutionResult<ProfileObservationHandle> {
      if (!enter()) return fail(closed ? 'closed' : 'busy');
      try {
        const at = time(); if (at === undefined) return fail('closed'); expiry(at);
        const before = epoch;
        const value = data(input, ['candidate', 'observedIdentity']);
        const candidate = parseDiscoveryCandidate(snapshotJson(value.candidate));
        if (new TextEncoder().encode(JSON.stringify(candidate)).length > PROFILE_RESOLUTION_LIMITS.candidateBytes) return fail('invalid');
        const identity = facts(value.observedIdentity), evidence = candidate.evidence[0]!;
        if (candidate.scope.kind !== scope.kind || candidate.scope.id !== scope.id || at < evidence.at || at >= evidence.expiresAt || at >= candidate.expiresAt) return fail('invalid');
        const record: Observed = { handle: Object.freeze({ kind: 'profile-observation' }), epoch: epoch + 1, candidate, facts: identity,
          expiresAt: Math.min(candidate.expiresAt, evidence.expiresAt, at + PROFILE_RESOLUTION_LIMITS.observationMs) };
        const valid = verified(record, at), after = time();
        if (closed || after === undefined) return fail('closed');
        if (epoch !== before || after >= record.expiresAt) return fail('stale');
        if (!valid) return fail('unverified');
        drop('observed'); if (closed || epoch !== record.epoch) return fail('stale');
        observed = record; arm(after);
        return alive(record) ? ok(record.handle) : fail(closed ? 'closed' : 'stale');
      } catch { return fail(closed ? 'closed' : 'invalid'); } finally { busy = false; }
    },
    request(handle: ProfileObservationHandle, input: ConnectorProfileRequest): ProfileResolutionResult<ProfileReviewHandle> {
      if (!enter()) return fail(closed ? 'closed' : 'busy');
      try {
        const record = observed;
        if (!record || record.handle !== handle || !currentObservation(record)) return fail(closed ? 'closed' : 'stale');
        const requested = requestPin(input), pin = catalog.get(key(requested));
        if (!pin) { outcome = 'unsupported'; return fail('unsupported'); }
        let binding: ReviewedConnectorProfileBinding;
        try { binding = resolve.call(registry, pin); } catch { if (alive(record)) outcome = 'unsupported'; return fail('unsupported'); }
        if (!alive(record) || !currentObservation(record)) return fail(closed ? 'closed' : 'stale');
        const field = Object.getOwnPropertyDescriptor(binding, 'manifest'); if (!field || !('value' in field)) invalid();
        const manifest = parseConnectorProfileManifest(field.value);
        if (manifest.id !== pin.id || manifest.version !== pin.version || manifest.decoder.codeSha256 !== pin.codeSha256 ||
          manifest.identityFilters.some(filter => record.facts[filter.field] !== filter.equals)) { outcome = 'unsupported'; return fail('unsupported'); }
        const at = time(); if (at === undefined || !alive(record)) return fail(closed ? 'closed' : 'stale'); expiry(at);
        if (!alive(record)) return fail('stale');
        const review: Review = { handle: Object.freeze({ kind: 'profile-review' }), observed: record, binding,
          selection: selection(record, pin, manifest.resources, Math.min(record.expiresAt, at + PROFILE_RESOLUTION_LIMITS.reviewMs)) };
        pending = review; outcome = 'requested'; arm(at);
        return alive(record) && pending === review ? ok(review.handle) : fail(closed ? 'closed' : 'stale');
      } catch { return fail(closed ? 'closed' : 'invalid'); } finally { busy = false; }
    },
    decide(handle: ProfileReviewHandle, allow: boolean): ProfileResolutionResult<ProfileChoiceHandle | undefined> {
      if (!enter()) return fail(closed ? 'closed' : 'busy');
      try {
        const review = pending;
        if (typeof allow !== 'boolean' || !review || review.handle !== handle || !currentObservation(review.observed) || pending !== review) return fail(closed ? 'closed' : 'stale');
        pending = undefined;
        if (!allow) { outcome = 'declined'; return ok(); }
        retireChoice(); if (!alive(review.observed)) return fail(closed ? 'closed' : 'stale');
        const record: Choice = { handle: Object.freeze({ kind: 'profile-choice' }), observed: review.observed, binding: review.binding,
          selection: selection(review.observed, review.selection.profile, review.selection.resources, review.observed.expiresAt), creating: false };
        chosen = record; outcome = 'selected';
        return currentChoice(record) ? ok(record.handle) : fail(closed ? 'closed' : 'stale');
      } finally { busy = false; }
    },
    cancel(handle: ProfileReviewHandle): ProfileResolutionResult {
      if (!enter()) return fail(closed ? 'closed' : 'busy');
      try {
        const review = pending;
        if (!review || review.handle !== handle || !currentObservation(review.observed) || pending !== review) return fail(closed ? 'closed' : 'stale');
        pending = undefined; outcome = 'cancelled'; return ok();
      } finally { busy = false; }
    },
    remove(handle: ProfileObservationHandle): ProfileResolutionResult {
      if (closed) return fail('closed');
      if (!observed || observed.handle !== handle) return fail('stale'); drop('removed'); return ok();
    },
    createConnector(handle: ProfileChoiceHandle, callbacks: Omit<ProfileConnectorOptions, 'binding' | 'observedIdentity' | 'now'>): ProfileResolutionResult<ProfileConnector> {
      if (!enter()) return fail(closed ? 'closed' : 'busy');
      let created: ProfileConnector | undefined;
      try {
        const record = chosen;
        if (!record || record.handle !== handle || !currentChoice(record)) return fail(closed ? 'closed' : 'stale');
        if (record.creating || record.connector) return fail('busy');
        if (attempts >= PROFILE_RESOLUTION_LIMITS.connectorCreations) return fail('capacity');
        attempts++; record.creating = true;
        const value = data(callbacks, ['onSample', 'onUnavailable'], ['write']);
        if (typeof value.onSample !== 'function' || typeof value.onUnavailable !== 'function' || value.write !== undefined && typeof value.write !== 'function') invalid();
        const onSample = value.onSample as ProfileConnectorOptions['onSample'], onUnavailable = value.onUnavailable as ProfileConnectorOptions['onUnavailable'];
        const write = value.write as ProfileConnectorOptions['write'];
        created = createProfileConnector({ binding: record.binding, observedIdentity: record.observed.facts,
          now() { if (!currentChoice(record)) throw new Error('Profile resolution retired'); return lastTime; },
          onSample(sample) { if (currentChoice(record)) onSample(sample); },
          onUnavailable(resourceId) { onUnavailable(resourceId); },
          ...(write ? { write(bytes, context) {
            if (!context.cleanup && !currentChoice(record)) return;
            // Cleanup is the existing A01 retired-owner safe-state contract only.
            const guarded = Object.freeze({ ...context, isCurrent() {
              if (context.cleanup) return context.isCurrent();
              return currentChoice(record) && context.isCurrent() && currentChoice(record);
            } });
            if (guarded.isCurrent()) return write(bytes, guarded);
          } } : {}) });
        if (!currentChoice(record)) { created.close(); return fail(closed ? 'closed' : 'stale'); }
        const native = created;
        const managed: ProfileConnector = Object.freeze({ ...native, start() {
          if (!currentChoice(record)) return Object.freeze({ ok: false as const, reason: 'profile-resolution-retired' });
          const result = native.start();
          if (!currentChoice(record)) { native.close(); return Object.freeze({ ok: false as const, reason: 'profile-resolution-retired' }); }
          return result;
        } });
        record.connector = managed;
        return ok(managed);
      } catch { created?.close(); return fail(closed ? 'closed' : 'creation-failed'); } finally { busy = false; }
    },
  });
}
