import { authenticatedPeerScope, createDeviceRuntime, RemoteResourcePublisher, RemoteResourceReceiver,
  pointerSourceDescriptor, parseDeviceDescriptor, decodePacket } from '@101/connect';
import type { ResourcePeer, Connection, EndpointHandle, SignalValue } from '@101/connect';

export const RUNTIME_RECOVERY_PROFILE = 'software-resource-recovery/1';
export const RUNTIME_RECOVERY_LIMITS = Object.freeze({ paths: 3, generationsPerPath: 4, concurrentRuns: 1, routes: 2, registrations: 4,
  rawDeliveries: 2, latestOffers: 64, reliableOffers: 8, capturedPackets: 2, capturedBytes: 1024, checks: 32,
  receiptBytes: 16384, trialMs: 4000, waitTurns: 800 });
export type RecoveryMode = 'owner-revoke' | 'lease-expiry' | 'native-loss' | 'recovery';
export type RecoveryPath = 'direct-wss' | 'authenticated-loopback-relay' | 'native-webrtc';
export interface RecoveryImpairment {
  readonly path: RecoveryPath;
  /** Trusted reviewed fixture only. It owns actual native openings and close. */
  disconnect(): Promise<void>; close(): Promise<void>; revokeOwner(): void;
  /** Retain/re-send exact bounded arguments from a genuine public producer.
   * This is resource receiver replay/epoch testing, NOT outer-wire replay proof. */
  remember(data: string | Uint8Array<ArrayBuffer>): void;
  replayPrevious(peer: ResourcePeer): boolean;
  onStage?(stage: string): void | Promise<void>;
}
export interface RuntimeRecoveryOptions {
  sourcePeer: ResourcePeer; receiverPeer: ResourcePeer; epoch: string;
  sourceOwnerSignal: AbortSignal; sinkOwnerSignal: AbortSignal; signal: AbortSignal;
  now: () => number; mode: RecoveryMode; impairment: RecoveryImpairment;
}
export interface RuntimeRecoveryReceipt {
  profile: typeof RUNTIME_RECOVERY_PROFILE; path: RecoveryPath; mode: RecoveryMode; result: 'pass';
  checks: readonly string[]; latestOffers: number; reliableOffers: number; softwareAdmissionDrops: number;
  reliableEffects: readonly boolean[]; latestEffects: number; releases: number; lateEffects: number;
  peakRaw: number; rawSettled: number; receiverReplayRejected: boolean; oldEpochRejected: boolean;
  cleanup: { routes: 0; pendingRaw: 0; heldOutput: false; ownedTimer: false };
  outerWireReplayQualification: false; actualIpLossOrPhysicalQualification: false;
}
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
const arrayLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const setBytes = Uint8Array.prototype.set, encoder = new TextEncoder();
let reserved = false;
function active(signal: unknown): signal is AbortSignal { try { return nativeAborted.call(signal) === false; } catch { return false; } }
function snapshot(data: string | ArrayBuffer | Uint8Array): string | Uint8Array<ArrayBuffer> {
  if (typeof data === 'string') { if (data.length > 1024 || encoder.encode(data).byteLength > 1024) throw Error('Recovery capture quota.'); return data; }
  const source = data instanceof ArrayBuffer ? new Uint8Array(data, 0, arrayLength.call(data)) : data;
  const length = typedLength.call(source); if (!Number.isSafeInteger(length) || length > 1024) throw Error('Recovery capture quota.');
  const value = new Uint8Array(length); setBytes.call(value, source); return value;
}

/** One trusted-host realm, actual issued peer provenance and independent owners.
 * This fixed software workload grants only its own two resource registrations.
 * Impairments model host admission/callback delay, not physical/network loss.
 * Already issued native effects cannot be rolled back by logical cancellation. */
export async function runRuntimeRecoveryQualification(options: RuntimeRecoveryOptions): Promise<RuntimeRecoveryReceipt> {
  if (reserved) throw Error('Recovery runner already active.'); reserved = true;
  let nativeClosed = false, timer: ReturnType<typeof setInterval> | undefined, lifetime: ReturnType<typeof setTimeout> | undefined;
  let ownsPair = false, rawReserved = 0;
  const owned = new AbortController(), raw = new Set<Promise<void>>(), routes: Connection[] = [], handles = new Map<string, EndpointHandle>();
  let runtime: ReturnType<typeof createDeviceRuntime> | undefined, receiver: RemoteResourceReceiver | undefined, publisher: RemoteResourcePublisher | undefined;
  let restore = () => {}, detach = () => {}, releaseHeld: (() => void) | undefined;
  let contact = false, position: SignalValue | undefined, sourceSelected = false, sinkSelected = false, drop = false, holding = false, heldEntered = false;
  let latestOffers = 0, reliableOffers = 0, dropped = 0, latestEffects = 0, releases = 0, lateEffects = 0, peakRaw = 0, rawSettled = 0, turns = 0, previousAt = -1;
  let ownerDeadline = Infinity, startedAt = 0, lastPacket: string | Uint8Array<ArrayBuffer> | undefined, replayRejected = false, oldRejected = false;
  const effects: boolean[] = [], checks: string[] = [], sourceRegistrations = new Map<string, string>();
  const validOwners = () => active(owned.signal) && active(options.signal) && active(options.sourceOwnerSignal) && active(options.sinkOwnerSignal);
  function time() { const value = options.now(); if (!Number.isFinite(value) || value < 0 || value < previousAt || value > Number.MAX_SAFE_INTEGER) throw Error('Recovery clock invalid.'); previousAt = value; return value; }
  function scope() {
    const source = authenticatedPeerScope(options.sourcePeer), sink = authenticatedPeerScope(options.receiverPeer);
    return !!source && !!sink && source.epoch === options.epoch && sink.epoch === options.epoch && source.role === 'source' && sink.role === 'receiver' &&
      source.applicationId === 'runtime-recovery' && source.applicationId === sink.applicationId && source.sessionId === sink.sessionId &&
      source.localKeyId !== sink.localKeyId && source.localKeyId !== source.remoteKeyId && sink.localKeyId !== sink.remoteKeyId &&
      (options.impairment.path === 'authenticated-loopback-relay' ? source.remoteKeyId === sink.remoteKeyId :
        source.localKeyId === sink.remoteKeyId && source.remoteKeyId === sink.localKeyId);
  }
  function current() { const at = time(); const enrolled = scope(); if (!validOwners() || !enrolled || at - startedAt >= 4000) throw Error('Recovery trial retired.'); }
  function stopResources() { owned.abort(); publisher?.stop(); receiver?.stop(); runtime?.close(); }
  async function stage(name: string) { current(); await options.impairment.onStage?.(name); current(); }
  async function wait(ms = 5, permitRetired = false) { await new Promise<void>(resolve => setTimeout(resolve, ms)); if (!permitRetired) current(); }
  async function until(condition: () => boolean, permitRetired = false) {
    const deadline = time() + 1500;
    while (!condition()) { if (++turns > 800 || time() >= deadline) throw Error('Recovery effect deadline.'); await wait(5, permitRetired); }
    if (!permitRetired) current();
  }
  function check(value: boolean, label: string) { if (!value || checks.length >= 32) throw Error('Recovery assertion failed: ' + label); checks.push(label); }
  function offer(capability: 'position' | 'contact', value: SignalValue) {
    current(); if (capability === 'position' ? ++latestOffers > 64 : ++reliableOffers > 8) throw Error('Recovery workload quota.');
    const at = time(); if (!validOwners()) throw Error('Recovery owner retired.'); return publisher!.publish(capability, value, { capturedAt: at });
  }
  try {
    const fields = ['sourcePeer','receiverPeer','epoch','sourceOwnerSignal','sinkOwnerSignal','signal','now','mode','impairment'];
    const captured: Record<string, unknown> = Object.create(null);
    if (!options || Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).length !== fields.length || fields.some(key => {
      const property = Object.getOwnPropertyDescriptor(options, key); if (!property?.enumerable || !('value' in property)) return true; captured[key] = property.value; return false;
    }) || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !fields.includes(key))) throw Error('Recovery options invalid.');
    const fixture = captured.impairment, fixtureFields = ['path','disconnect','close','revokeOwner','remember','replayPrevious','onStage'];
    const fixtureCopy: Record<string, unknown> = Object.create(null);
    if (!fixture || typeof fixture !== 'object' || Object.getPrototypeOf(fixture) !== Object.prototype || Reflect.ownKeys(fixture).length > 7 ||
      Reflect.ownKeys(fixture).some(key => typeof key !== 'string' || !fixtureFields.includes(key))) throw Error('Recovery fixture invalid.');
    for (const key of fixtureFields) { const property = Object.getOwnPropertyDescriptor(fixture, key); if (!property && key === 'onStage') continue;
      if (!property?.enumerable || !('value' in property)) throw Error('Recovery fixture invalid.'); fixtureCopy[key] = property.value; }
    for (const key of fixtureFields.slice(1)) if (!(key === 'onStage' && fixtureCopy[key] === undefined) && typeof fixtureCopy[key] !== 'function') throw Error('Recovery fixture invalid.');
    captured.impairment = Object.freeze(fixtureCopy); options = Object.freeze(captured) as unknown as RuntimeRecoveryOptions;
    if (typeof options.now !== 'function' ||
      !['owner-revoke','lease-expiry','native-loss','recovery'].includes(options.mode) || !['direct-wss','authenticated-loopback-relay','native-webrtc'].includes(options.impairment.path) ||
      !validOwners() || !scope()) throw Error('Recovery needs actual current enrolled peers and native owner signals.');
    ownsPair = true;
    startedAt = time(); current(); ownerDeadline = startedAt + 3000;
    const cancelled = () => { stopResources(); void options.impairment.close().catch(() => {}); };
    addEvent.call(options.signal, 'abort', cancelled, { once: true });
    const sourceRevoked = () => publisher?.stop(), sinkRevoked = () => { receiver?.stop(); runtime?.close(); };
    addEvent.call(options.sourceOwnerSignal, 'abort', sourceRevoked, { once: true }); addEvent.call(options.sinkOwnerSignal, 'abort', sinkRevoked, { once: true });
    detach = () => { removeEvent.call(options.signal, 'abort', cancelled); removeEvent.call(options.sourceOwnerSignal, 'abort', sourceRevoked); removeEvent.call(options.sinkOwnerSignal, 'abort', sinkRevoked); };
    lifetime = setTimeout(cancelled, 4000);
    const sourceDevice = pointerSourceDescriptor('owned-generated-software-pointer');
    const sinkDevice = parseDeviceDescriptor({ ...sourceDevice, id: 'owned-recovery-target', capabilities: sourceDevice.capabilities.map(value =>
      ({ ...value, kind: value.id === 'contact' ? 'command' : 'property', permissions: [value.id === 'contact' ? 'invoke' : 'write'], ownership: { mode: 'exclusive' } })) });
    const scopeAtEntry = authenticatedPeerScope(options.receiverPeer)!;
    runtime = createDeviceRuntime({ now: time, clockDomain: 'recovery-target-monotonic', maxRoutes: 2, maxSubscribers: 2, maxRegistrations: 4, maxPendingDeliveries: 2,
      authorize(request) {
        const at = time(); if (!sinkSelected || !validOwners() || request.principalId !== 'owned-recovery-target' || request.applicationId !== scopeAtEntry.applicationId || request.sessionId !== scopeAtEntry.sessionId ||
          request.source.deviceId !== sourceDevice.id || request.source.capabilityId !== request.sink.capabilityId || request.source.descriptorRevision !== 1 || request.source.schemaVersion !== 1 ||
          request.sink.registrationId !== handles.get(request.sink.capabilityId)?.id || request.sink.deviceId !== sinkDevice.id || request.sink.descriptorRevision !== 1 || request.sink.schemaVersion !== 1 ||
          request.sourceOperation !== 'subscribe' || request.sinkOperation !== (request.sink.capabilityId === 'contact' ? 'invoke' : 'write') ||
          sourceRegistrations.has(request.source.capabilityId) && sourceRegistrations.get(request.source.capabilityId) !== request.source.registrationId || ownerDeadline <= at) return;
        return { expiresAt: ownerDeadline, maxHz: 60, maxAgeMs: 100 };
      } });
    const nativeRoute = runtime.route.bind(runtime); runtime.route = request => {
      for (const [capability, handle] of handles) if (request.to === handle) sourceRegistrations.set(capability, request.from.id);
      const handle = nativeRoute(request); routes.push(handle); return handle;
    };
    for (const capability of sinkDevice.capabilities) {
      const handle = runtime.registerSink({ device: sinkDevice, capability: capability.id, apply(observation, context) {
        if (rawReserved >= 2) throw Error('Recovery raw quota.'); rawReserved++;
        const applied = (async () => {
          if (holding && capability.id === 'contact') { heldEntered = true; await new Promise<void>(resolve => { releaseHeld = resolve; }); }
          const at = time(), observed = context.isCurrent();
          if (!observed || !validOwners() || !active(context.signal) || at >= ownerDeadline) return;
          if (observation.quality !== 'valid' || observation.source.registrationId !== sourceRegistrations.get(capability.id)) throw Error('Recovery observation invalid.');
          if (capability.id === 'contact') { if (typeof observation.value !== 'boolean' || effects.length >= 8 || !context.operationId) throw Error('Recovery command invalid.'); contact = observation.value; effects.push(contact); }
          else { position = observation.value; latestEffects++; }
          if (active(context.signal) === false) lateEffects++;
        })(); raw.add(applied); peakRaw = Math.max(peakRaw, rawReserved); void applied.finally(() => { rawReserved--; raw.delete(applied); rawSettled++; }).catch(() => {}); return applied;
      }, release() { if (capability.id === 'contact') contact = false; else position = undefined; releases++; } }); handles.set(capability.id, handle); runtime.setReadiness(handle, 'available');
    }
    receiver = new RemoteResourceReceiver({ peer: options.receiverPeer, epoch: options.epoch, runtime, clockId: 'recovery-target-monotonic', now: time,
      principalId: 'owned-recovery-target', applicationId: scopeAtEntry.applicationId, sessionId: scopeAtEntry.sessionId });
    publisher = new RemoteResourcePublisher({ peer: options.sourcePeer, epoch: options.epoch, clockId: 'recovery-source-monotonic', now: time, device: sourceDevice,
      available: () => sourceSelected && active(owned.signal) && active(options.signal) && active(options.sourceOwnerSignal) });
    const original = options.sourcePeer.send, originalOwn = Object.getOwnPropertyDescriptor(options.sourcePeer, 'send');
    options.sourcePeer.send = function (lane, data) {
      const input = typeof data === 'string' || data instanceof ArrayBuffer ? data : snapshot(data);
      const decoded = decodePacket(typeof input === 'string' || input instanceof ArrayBuffer ? input : input.buffer, lane);
      if (decoded?.packet.type === 'sample') { lastPacket = snapshot(data); options.impairment.remember(lastPacket); if (drop) { dropped++; return false; } }
      if (!active(owned.signal) || !active(options.signal) || !active(options.sourceOwnerSignal)) return false;
      return original.call(this, lane, data);
    };
    restore = () => { if (originalOwn) Object.defineProperty(options.sourcePeer, 'send', originalOwn); else delete (options.sourcePeer as Partial<ResourcePeer>).send; };
    check(publisher.start(), 'actual public producer advertises without minting resource permission');
    timer = setInterval(() => { try { publisher?.tick(); receiver?.tick(); } catch { stopResources(); } }, 5);
    await until(() => !!receiver!.description() && receiver!.status().clockReady);
    const approve = () => sinkDevice.capabilities.map(capability => receiver!.approve({ capability: capability.id, sink: handles.get(capability.id)!, sinkDevice, sinkCapability: capability.id,
      codec: capability.id === 'position' ? 'normalized-pointer/1' : 'json/1', leaseMs: 1000, grant: { expiresAt: ownerDeadline, maxAgeMs: 100, maxHz: 60 } }));
    if (options.mode === 'owner-revoke') {
      sinkSelected = true; const denied = approve(); check(denied.every(value => value !== undefined), 'source denial reaches actual subscribe admission');
      await until(() => receiver!.status().pending === 0); check(receiver.status().active === 0 && effects.length === 0 && latestEffects === 0, 'source owner denial has zero new target effects');
      sourceSelected = true; sinkSelected = false; approve(); await until(() => receiver!.status().pending === 0);
      check(receiver.status().active === 0 && effects.length === 0 && latestEffects === 0, 'actual asynchronous sink invoke/write denial has zero new target effects');
    }
    sourceSelected = sinkSelected = true; ownerDeadline = time() + 3000; check(approve().every(value => value !== undefined), 'separate exact owner approvals activate two resource routes');
    await until(() => publisher!.isBound('position') && publisher!.isBound('contact') && receiver!.status().active === 2);
    await stage('selected'); check(offer('position', { x: 0.2, y: 0.8 }), 'latest initial admission'); await until(() => !!position);
    check(offer('contact', true), 'reliable true admitted'); await until(() => contact); check(offer('contact', false), 'reliable false admitted'); await until(() => !contact && effects.length === 2);
    check(effects[0] === true && effects[1] === false, 'both actual reliable invoke effects observed; no coalesced edge success');
    if (options.mode === 'owner-revoke') {
      drop = true; for (let turn = 0; turn < 32; turn++) offer('position', { x: turn / 31, y: 1 - turn / 31 });
      check(publisher.status().pending === 1 && dropped > 0, 'software disposable admission refusal retains one latest value'); drop = false; await wait(25);
      await until(() => !!position && typeof position === 'object' && !Array.isArray(position) && 'x' in position && 'y' in position && position.x === 1 && position.y === 0);
      check(true, 'newest software state recovers after bounded sender refusal');
    }
    if (lastPacket) { const before = latestEffects; original.call(options.sourcePeer, 'disposable', lastPacket); await wait(20); replayRejected = latestEffects === before;
      check(replayRejected, 're-send of genuine current resource arguments rejects duplicate sequence at receiver'); }
    if (options.mode === 'recovery') { const before = latestEffects; check(options.impairment.replayPrevious(options.sourcePeer), 'fresh authenticated sender admits old genuine resource bytes');
      await wait(20); oldRejected = latestEffects === before; check(oldRejected, 'old resource epoch bytes cannot mutate fresh route'); }
    check(offer('contact', true), 'held output command admitted'); await until(() => contact); holding = true; offer('contact', false); await until(() => heldEntered);
    await stage('held'); const beforeLate = effects.length;
    if (options.mode === 'lease-expiry') { ownerDeadline = time() + 80; for (const route of routes.filter(value => value.status().state === 'active')) check(route.renew('owned-recovery-target').ok, 'actual current grant narrows expiry');
      await until(() => receiver!.status().active === 0 && !contact, true); }
    else if (options.mode === 'native-loss') { await options.impairment.disconnect(); await until(() => receiver!.status().active === 0 && !contact, true); }
    else { options.impairment.revokeOwner(); await until(() => receiver!.status().active === 0 && !contact, true); }
    check(raw.size > 0 && releases >= 2, 'logical retirement releases held output while actual target Promise remains reserved');
    releaseHeld?.(); releaseHeld = undefined; await Promise.all([...raw]);
    check(effects.length === beforeLate && !contact && lateEffects === 0, 'late actual target settlement cannot restore retired output');
    check(routes.every(value => value.status().state === 'closed'), 'real returned route handles are closed');
  } finally {
    clearInterval(timer); timer = undefined; clearTimeout(lifetime); lifetime = undefined; detach(); stopResources(); restore(); releaseHeld?.(); releaseHeld = undefined;
    try { await Promise.allSettled([...raw]); if (ownsPair) await options.impairment.close(); nativeClosed = true; }
    finally { if (nativeClosed) reserved = false; }
  }
  const receipt: RuntimeRecoveryReceipt = { profile: RUNTIME_RECOVERY_PROFILE, path: options.impairment.path, mode: options.mode, result: 'pass', checks: Object.freeze(checks), latestOffers, reliableOffers,
    softwareAdmissionDrops: dropped, reliableEffects: Object.freeze(effects), latestEffects, releases, lateEffects, peakRaw, rawSettled, receiverReplayRejected: replayRejected, oldEpochRejected: oldRejected,
    cleanup: { routes: 0, pendingRaw: 0, heldOutput: false, ownedTimer: false }, outerWireReplayQualification: false, actualIpLossOrPhysicalQualification: false };
  if (raw.size || contact || routes.some(value => value.status().state !== 'closed') || encoder.encode(JSON.stringify(receipt)).byteLength > 16384) throw Error('Recovery cleanup/receipt invalid.'); return Object.freeze(receipt);
}
